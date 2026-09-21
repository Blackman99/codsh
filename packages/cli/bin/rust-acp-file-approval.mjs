/**
 * Enforce Grok-compatible allow/ask/deny rules before dsh tools execute.
 * Deny and hook blocks have no side effects. Ask is forwarded as
 * session/request_permission; remembered grants persist per project.
 * Optional DSH_CODE_CLI_TOOL_DELAY_MS parks around-dispatch so cancel can
 * land while a tool is running; the wait observes exec.signal.
 */
export const name = 'rust-acp-file-approval'

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

function wait(ms, signal) {
  return new Promise(resolve => {
    if (!Number.isFinite(ms) || ms <= 0 || signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function loadPolicy() {
  const path = process.env.CODSH_PERMISSION_POLICY
  if (!path) return defaultPolicy()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('policy is not an object')
    }
    return { ...defaultPolicy(), ...parsed, loadError: '' }
  } catch (error) {
    return {
      ...defaultPolicy(),
      loadError: `Permission policy unreadable or invalid (${error.message}); refusing mutating tools.`,
    }
  }
}

function defaultPolicy() {
  return {
    mode: 'ask',
    alwaysApproveLocked: false,
    rememberToolApprovals: true,
    interactive: true,
    cwd: process.cwd(),
    grantsPath: '',
    loadError: '',
    rules: [],
    grants: {
      allowedBash: [],
      deniedBash: [],
      allowedMcp: [],
      deniedMcp: [],
      allowedDomains: [],
      deniedDomains: [],
      allowedEdits: false,
    },
  }
}

function stringField(args, keys) {
  for (const key of keys) {
    if (typeof args?.[key] === 'string') return args[key]
  }
  return ''
}

function accessFromTool(name, args = {}) {
  const path = stringField(args, ['file_path', 'filePath', 'path', 'target_directory'])
  if (name === 'read' || name === 'read_file' || name === 'list_dir' || name === 'read_image') {
    return { kind: 'read', path }
  }
  if (name === 'grep' || name === 'glob') return { kind: 'grep', path }
  if (name === 'write' || name === 'edit' || name === 'search_replace') return { kind: 'edit', path }
  if (name === 'bash' || name === 'run_terminal_cmd' || name === 'run_terminal_command') {
    return { kind: 'bash', command: stringField(args, ['command']) }
  }
  if (name === 'web_fetch') return { kind: 'webfetch', url: stringField(args, ['url']) }
  if (name === 'web_search') {
    const query = stringField(args, ['query']) || (Array.isArray(args.queries) ? String(args.queries[0] ?? '') : '')
    return { kind: 'websearch', query }
  }
  if (name === 'todo_write' || name === 'skill') return { kind: 'read', path: '' }
  if (name.includes('__')) return { kind: 'mcp', name }
  if (path && (args.old_string || args.new_string || args.content)) return { kind: 'edit', path }
  if (args.command) return { kind: 'bash', command: String(args.command) }
  return { kind: 'tool', name }
}

function unescape(text) {
  return String(text).replaceAll('\\(', '(').replaceAll('\\)', ')').replaceAll('\\\\', '\\')
}

function parseRule(spec, action, source) {
  const rule = String(spec ?? '').trim()
  if (!rule) return null
  const open = rule.indexOf('(')
  if (open >= 0 && rule.endsWith(')')) {
    const prefix = rule.slice(0, open).trim()
    let content = unescape(rule.slice(open + 1, -1)).trim()
    const tool = toolFilter(prefix)
    if (!tool) return null
    if (tool === 'bash' && content.endsWith(':*')) content = content.slice(0, -2)
    let patternMode = 'glob'
    if (content.startsWith('domain:')) {
      content = content.slice('domain:'.length)
      patternMode = 'domain'
    }
    return {
      action,
      tool,
      pattern: content === '' || content === '*' ? null : content,
      patternMode,
      source,
    }
  }
  if (rule.startsWith('mcp__') && rule.length > 5) {
    const rest = rule.slice(5)
    return {
      action,
      tool: 'mcp',
      pattern: rest === '*' ? null : rest.includes('__') ? rest : `${rest}__*`,
      patternMode: 'glob',
      source,
    }
  }
  const tool = toolFilter(rule)
  if (tool) return { action, tool, pattern: null, patternMode: 'glob', source }
  return { action, tool: 'any', pattern: rule, patternMode: 'glob', source }
}

function toolFilter(name) {
  switch (name) {
    case 'Bash': case 'bash': return 'bash'
    case 'Read': case 'read': return 'read'
    case 'Edit': case 'edit': case 'Write': case 'write': return 'edit'
    case 'Grep': case 'grep': case 'Glob': case 'glob': return 'grep'
    case 'MCPTool': case 'mcp': return 'mcp'
    case 'WebFetch': case 'web_fetch': return 'web_fetch'
    case 'WebSearch': case 'web_search': return 'web_search'
    case '*': case 'any': return 'any'
    default: return null
  }
}

const CONTROL_FLOW = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
])

function isControlFlow(command) {
  return command.split(/\s+/u).some(word => CONTROL_FLOW.has(word))
}

function hasBackgroundAmp(command) {
  let quote = ''
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '&' && command[i + 1] !== '&' && command[i - 1] !== '&') return true
  }
  return false
}

function isUnsplittable(command) {
  return /\$\(/.test(command)
    || command.includes('`')
    || /(?<![\\])[()]/.test(command)
    || hasBackgroundAmp(command)
    || isControlFlow(command)
}

function splitSimple(command) {
  const segments = []
  let current = ''
  let quote = ''
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (quote) {
      current += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '&' && command[i + 1] === '&') {
      segments.push(stripWrappers(current.trim()))
      current = ''
      i += 1
      continue
    }
    if (ch === '|' && command[i + 1] === '|') {
      segments.push(stripWrappers(current.trim()))
      current = ''
      i += 1
      continue
    }
    if (ch === '|' || ch === ';' || ch === '\n') {
      segments.push(stripWrappers(current.trim()))
      current = ''
      continue
    }
    current += ch
  }
  segments.push(stripWrappers(current.trim()))
  return segments.filter(Boolean)
}

function bashSegments(command) {
  if (isUnsplittable(command)) return [stripWrappers(command.trim())].filter(Boolean)
  return splitSimple(command)
}

function unquote(text) {
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  return text
}

function takeBalanced(text, start, open, close) {
  let depth = 1
  let quote = ''
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return [text.slice(start, i), i + 1]
    }
  }
  return [text.slice(start), text.length]
}

function extractSubstitutions(command) {
  const out = []
  let i = 0
  while (i < command.length) {
    if (command.startsWith('$(', i)) {
      const [inner, next] = takeBalanced(command, i + 2, '(', ')')
      out.push(inner)
      i = next
      continue
    }
    if (command[i] === '`') {
      const end = command.indexOf('`', i + 1)
      if (end < 0) break
      out.push(command.slice(i + 1, end))
      i = end + 1
      continue
    }
    i += 1
  }
  return out.map(part => part.trim()).filter(Boolean)
}

function extractDashCScripts(command) {
  const scripts = []
  const re = /\b(?:bash|sh|dash|zsh|ksh)\b(?:\s+-[a-zA-Z0-9]*)*\s+-c\s+(?:"([^"]*)"|'([^']*)'|(\S+))/gu
  let match
  while ((match = re.exec(command))) {
    scripts.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return scripts.map(part => part.trim()).filter(Boolean)
}

function controlFlowBodies(command) {
  if (!isControlFlow(command)) return []
  const stripped = command.replaceAll(/\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac)\b/gu, ';')
  return splitSimple(stripped)
}

function bashInspectSubjects(command, seen = new Set()) {
  const trimmed = command.trimStart()
  if (!trimmed || seen.has(trimmed)) return []
  seen.add(trimmed)
  const subjects = [trimmed, ...bashSegments(command)]
  for (const inner of [
    ...extractSubstitutions(command),
    ...extractDashCScripts(command),
    ...controlFlowBodies(command),
  ]) {
    subjects.push(...bashInspectSubjects(inner, seen))
  }
  return [...new Set(subjects.filter(Boolean))]
}

function bashRestrictionsConfigured(policy) {
  return (policy.rules ?? []).some(rule => rule.tool === 'bash' || rule.tool === 'any')
}

function bashChainAllowed(policy, command) {
  const scripts = extractDashCScripts(command)
  if (scripts.length > 0) return scripts.every(script => bashChainAllowed(policy, script))
  if (isUnsplittable(command)) return false
  const allowRules = (policy.rules ?? []).filter(rule => rule.action === 'allow' && (rule.tool === 'bash' || rule.tool === 'any'))
  const segments = bashSegments(command)
  return allowRules.length > 0 && segments.length > 0
    && segments.every(segment => allowRules.some(rule => bashAllowMatches(segment, rule)))
}

function shellOperands(command) {
  const operands = []
  for (const subject of bashInspectSubjects(command)) {
    const words = subject.split(/\s+/u).filter(Boolean)
    for (let i = 1; i < words.length; i += 1) {
      const word = unquote(words[i])
      if (!word || word.startsWith('-')) continue
      operands.push(word)
    }
  }
  return operands
}

function stripWrappers(command) {
  const words = command.split(/\s+/u).filter(Boolean)
  while (words[0]?.includes('=') && !words[0].startsWith('-')) words.shift()
  const wrappers = new Set(['timeout', 'nice', 'ionice', 'chrt', 'stdbuf', 'env', 'command'])
  while (words[0] && wrappers.has(words[0].split(/[\\/]/u).at(-1))) {
    words.shift()
    while (words[0]?.startsWith('-')) {
      const flag = words.shift()
      if (flag && !flag.includes('=') && words[0] && !words[0].startsWith('-')) words.shift()
    }
  }
  return words.join(' ')
}

function globMatch(pattern, text, pathMode) {
  const toRegExp = (glob) => {
    let out = '^'
    for (let i = 0; i < glob.length; i += 1) {
      const ch = glob[i]
      if (ch === '*' && glob[i + 1] === '*') {
        out += '.*'
        i += glob[i + 2] === '/' ? 2 : 1
        continue
      }
      if (ch === '*') {
        out += pathMode ? '[^/]*' : '.*'
        continue
      }
      if (ch === '?') {
        out += pathMode ? '[^/]' : '.'
        continue
      }
      if ('\\^$+()[]{}|.'.includes(ch)) out += `\\${ch}`
      else out += ch
    }
    return new RegExp(`${out}$`)
  }
  try {
    return toRegExp(pattern).test(text)
  } catch {
    return false
  }
}

function normalizePath(path, cwd) {
  if (path.startsWith('~')) return path.replaceAll('\\', '/')
  const joined = path.startsWith('/') ? path : `${cwd.replaceAll('\\', '/')}/${path}`
  const parts = []
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function pathForms(path, cwd) {
  if (!path) return []
  if (path.startsWith('~')) return [path.replaceAll('\\', '/')]
  const abs = normalizePath(path, cwd)
  const forms = [abs]
  const root = normalizePath('.', cwd)
  if (abs === root || abs.startsWith(`${root}/`)) {
    const rel = abs === root ? '.' : abs.slice(root.length + 1)
    forms.push(rel === '.' ? '.' : `./${rel}`, rel)
  }
  return forms
}

function commandPrefix(command, pattern) {
  return command === pattern || (command.startsWith(pattern) && command[pattern.length] === ' ')
}

function urlHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./u, '').replace(/\.$/u, '').toLowerCase()
  } catch {
    return ''
  }
}

function domainCovers(pattern, host) {
  const needle = pattern.replace(/^www\./u, '').replace(/\.$/u, '').toLowerCase()
  return host === needle || host.endsWith(`.${needle}`)
}

function ruleReaches(access, rule) {
  if (rule.tool === 'any') return true
  if (rule.tool === 'bash') return access.kind === 'bash'
  if (rule.tool === 'edit') return access.kind === 'edit' || access.kind === 'tool'
  if (rule.tool === 'read') return access.kind === 'read' || access.kind === 'grep'
  if (rule.tool === 'grep') return access.kind === 'grep'
  if (rule.tool === 'mcp') return access.kind === 'mcp'
  if (rule.tool === 'web_fetch') return access.kind === 'webfetch'
  if (rule.tool === 'web_search') return access.kind === 'websearch'
  return false
}

function patternMatches(access, rule, cwd) {
  if (!rule.pattern || rule.pattern === '*') return true
  if (access.kind === 'bash') {
    const command = access.command.trimStart()
    return command.startsWith(rule.pattern) || globMatch(rule.pattern, command, false)
  }
  if (access.kind === 'edit' || access.kind === 'read' || access.kind === 'grep') {
    return pathForms(access.path ?? '', cwd).some(form => globMatch(rule.pattern, form, true))
  }
  if (access.kind === 'mcp') return globMatch(rule.pattern, access.name, false)
  if (access.kind === 'webfetch') {
    return rule.patternMode === 'domain'
      ? domainCovers(rule.pattern, urlHost(access.url))
      : globMatch(rule.pattern, access.url, false)
  }
  if (access.kind === 'websearch') {
    return globMatch(rule.pattern, access.query, false) || access.query.startsWith(rule.pattern)
  }
  return globMatch(rule.pattern, access.name ?? '', false)
}

function bashAllowMatches(command, rule) {
  if (!rule.pattern || rule.pattern === '*') return true
  return commandPrefix(command, rule.pattern) || globMatch(rule.pattern, command, false)
}

function dangerous(command) {
  const words = command.split(/\s+/u)
  const head = (words[0] ?? '').split(/[\\/]/u).at(-1).replace(/\.exe$/iu, '').toLowerCase()
  return ['rm', 'chmod', 'chown', 'chgrp', 'chattr', 'pkill', 'kill', 'killall'].includes(head)
    || (head === 'git' && words[1] === 'push')
}

function readonlyCommand(command) {
  const words = command.split(/\s+/u)
  const head = words[0]
  if (['ls', 'cat', 'pwd', 'date', 'whoami', 'hostname', 'uptime', 'ps', 'head', 'tail', 'wc', 'sort', 'uniq', 'tr', 'cut', 'grep', 'rg'].includes(head)) {
    return true
  }
  if (head === 'git') {
    return ['status', 'branch', 'log', 'diff', 'ls-files', 'show', 'rev-parse', 'blame', 'describe', 'merge-base', 'shortlog'].includes(words[1])
  }
  return head === 'kubectl' && ['get', 'logs', 'describe'].includes(words[1])
}

function readonlyAccess(access) {
  return access.kind === 'read' || access.kind === 'grep' || access.kind === 'websearch'
}

function pathRuleDecision(policy, path, cwd) {
  const read = evaluateRulesFor(policy, { kind: 'read', path }, cwd)
  if (read?.kind === 'deny') return read
  const edit = evaluateRulesFor(policy, { kind: 'edit', path }, cwd)
  if (edit?.kind === 'deny') return edit
  if (read?.kind === 'ask') return read
  if (edit?.kind === 'ask') return edit
  return null
}

function evaluateShellPathRules(policy, command, cwd) {
  let ask = null
  for (const path of shellOperands(command)) {
    const decision = pathRuleDecision(policy, path, cwd)
    if (decision?.kind === 'deny') return decision
    if (decision?.kind === 'ask') ask = decision
  }
  return ask
}

function evaluateRules(policy, access) {
  const cwd = policy.cwd || process.cwd()
  if (access.kind === 'bash') {
    const subjects = bashInspectSubjects(access.command)
    let ask = null
    for (const subject of subjects) {
      const decision = evaluateRulesFor(policy, { kind: 'bash', command: subject }, cwd)
      if (decision?.kind === 'deny') return decision
      if (decision?.kind === 'ask') ask = decision
    }
    const pathDecision = evaluateShellPathRules(policy, access.command, cwd)
    if (pathDecision?.kind === 'deny') return pathDecision
    if (pathDecision?.kind === 'ask') ask = pathDecision
    if (ask) return ask
    if (isUnsplittable(access.command) && bashRestrictionsConfigured(policy)) {
      return { kind: 'ask', reason: 'unsplittable command' }
    }
    if (bashChainAllowed(policy, access.command)) {
      return { kind: 'allow', reason: 'allow rule' }
    }
    return null
  }
  return evaluateRulesFor(policy, access, cwd)
}

function evaluateRulesFor(policy, access, cwd) {
  let matchedAsk = false
  let matchedAllow = false
  for (const rule of policy.rules ?? []) {
    if (!ruleReaches(access, rule) || !patternMatches(access, rule, cwd)) continue
    if (rule.action === 'deny') {
      return {
        kind: 'deny',
        reason: `Denied by permission policy: deny rule on ${rule.tool} matching "${rule.pattern ?? '*'}"`,
      }
    }
    if (rule.action === 'ask') matchedAsk = true
    if (rule.action === 'allow') matchedAllow = true
  }
  if (matchedAsk) return { kind: 'ask', reason: 'ask rule' }
  if (matchedAllow && access.kind !== 'bash') return { kind: 'allow', reason: 'allow rule' }
  return null
}

function evaluateGrants(policy, access) {
  const grants = policy.grants ?? defaultPolicy().grants
  if (access.kind === 'bash') {
    const subjects = [access.command.trimStart(), ...bashSegments(access.command)]
    const denied = (grants.deniedBash ?? []).find(prefix => subjects.some(subject => commandPrefix(subject, prefix)))
    if (denied) return { kind: 'deny', reason: `User previously rejected \`${denied}\` in this project` }
    if (!policy.rememberToolApprovals) return null
    if (subjects.some(subject => dangerous(subject) && !(grants.allowedBash ?? []).includes(subject))) return null
    if (bashSegments(access.command).every(segment => (grants.allowedBash ?? []).some(grant => commandPrefix(segment, grant) || segment === grant))) {
      return { kind: 'allow', reason: 'remembered project grant' }
    }
    return null
  }
  if (access.kind === 'mcp') {
    if ((grants.deniedMcp ?? []).includes(access.name)) {
      return { kind: 'deny', reason: `User previously rejected \`${access.name}\` in this project` }
    }
    if (policy.rememberToolApprovals && (grants.allowedMcp ?? []).includes(access.name)) {
      return { kind: 'allow', reason: 'remembered project grant' }
    }
  }
  if (access.kind === 'webfetch') {
    const host = urlHost(access.url)
    const denied = (grants.deniedDomains ?? []).find(domain => domainCovers(domain, host))
    if (denied) return { kind: 'deny', reason: `User previously rejected \`${denied}\` in this project` }
    if (policy.rememberToolApprovals && (grants.allowedDomains ?? []).some(domain => domainCovers(domain, host))) {
      return { kind: 'allow', reason: 'remembered project grant' }
    }
  }
  if (access.kind === 'edit' && grants.allowedEdits) {
    return { kind: 'allow', reason: 'allow all edits this session' }
  }
  return null
}

function mutatingAccess(access) {
  return access.kind === 'edit' || access.kind === 'bash' || access.kind === 'mcp' || access.kind === 'webfetch'
}

export function evaluatePermission(policy, access, hookDeny) {
  if (hookDeny) return { kind: 'deny', reason: `Denied by hook: ${hookDeny}` }
  if (policy.loadError && mutatingAccess(access)) {
    return { kind: 'deny', reason: policy.loadError }
  }
  const alwaysApprove = policy.mode === 'always-approve'
  const rules = evaluateRules(policy, access)
  if (rules?.kind === 'deny') return rules
  if (rules?.kind === 'ask') {
    if (alwaysApprove && access.kind !== 'bash') {
      return { kind: 'allow', reason: 'always-approve' }
    }
    if (alwaysApprove) return rules
    return evaluateGrants(policy, access) ?? rules
  }
  if (rules?.kind === 'allow') {
    return rules
  }
  if (!alwaysApprove) {
    const grant = evaluateGrants(policy, access)
    if (grant) return grant
  }
  if (readonlyAccess(access)) return { kind: 'allow', reason: 'read-only tool' }
  if (access.kind === 'bash'
    && !isUnsplittable(access.command)
    && bashSegments(access.command).every(segment => readonlyCommand(segment) && !dangerous(segment))) {
    return { kind: 'allow', reason: 'read-only shell command' }
  }
  if (alwaysApprove) return { kind: 'allow', reason: 'always-approve' }
  if (policy.mode === 'acceptEdits' && access.kind === 'edit') return { kind: 'allow', reason: 'acceptEdits' }
  if (policy.mode === 'dontAsk') {
    return { kind: 'deny', reason: 'dontAsk blocked this action; it is not on the allow list' }
  }
  if (policy.mode === 'auto' && policy.interactive === false) {
    return { kind: 'deny', reason: 'Auto mode blocked this action (no classifier available; refusing rather than unconfined auto-allow).' }
  }
  return { kind: 'ask', reason: `permission mode ${policy.mode}` }
}

function rememberPrefix(command) {
  const words = command.trim().split(/\s+/u)
  if (words.length === 0) return command
  if (dangerous(command) || ['sh', 'bash', 'python', 'python3', 'node', 'sudo', 'ssh', 'docker', 'npx'].includes(words[0])) {
    return words.join(' ')
  }
  if (readonlyCommand(command)) return words[0] === 'git' || words[0] === 'kubectl' ? words.slice(0, 2).join(' ') : words[0]
  return words.slice(0, 2).join(' ')
}

function persistGrant(policy, access, allow) {
  if (!policy.grantsPath) return { ok: false, reason: 'no grant path' }
  const grants = {
    allowedBash: [...policy.grants?.allowedBash ?? []],
    deniedBash: [...policy.grants?.deniedBash ?? []],
    allowedMcp: [...policy.grants?.allowedMcp ?? []],
    deniedMcp: [...policy.grants?.deniedMcp ?? []],
    allowedDomains: [...policy.grants?.allowedDomains ?? []],
    deniedDomains: [...policy.grants?.deniedDomains ?? []],
    allowedEdits: Boolean(policy.grants?.allowedEdits),
  }
  if (access.kind === 'bash') {
    const prefix = rememberPrefix(access.command)
    const list = allow ? grants.allowedBash : grants.deniedBash
    if (!list.includes(prefix)) list.push(prefix)
  } else if (access.kind === 'mcp') {
    const list = allow ? grants.allowedMcp : grants.deniedMcp
    if (!list.includes(access.name)) list.push(access.name)
  } else if (access.kind === 'webfetch') {
    const host = urlHost(access.url)
    const list = allow ? grants.allowedDomains : grants.deniedDomains
    if (host && !list.includes(host)) list.push(host)
  } else if (access.kind === 'edit' && allow) {
    grants.allowedEdits = true
  }
  try {
    mkdirSync(dirname(policy.grantsPath), { recursive: true })
    const body = [
      '# remembered permission grants (this project only)',
      `allowed_bash_commands = ${JSON.stringify(grants.allowedBash)}`,
      `disallowed_bash_commands = ${JSON.stringify(grants.deniedBash)}`,
      `allowed_mcp_tools = ${JSON.stringify(grants.allowedMcp)}`,
      `disallowed_mcp_tools = ${JSON.stringify(grants.deniedMcp)}`,
      `allowed_web_fetch_domains = ${JSON.stringify(grants.allowedDomains)}`,
      `disallowed_web_fetch_domains = ${JSON.stringify(grants.deniedDomains)}`,
      `allow_edits_for_session = ${grants.allowedEdits}`,
      '',
    ].join('\n')
    writeFileSync(policy.grantsPath, body)
    policy.grants = grants
    if (process.env.CODSH_PERMISSION_POLICY && existsSync(process.env.CODSH_PERMISSION_POLICY)) {
      const disk = JSON.parse(readFileSync(process.env.CODSH_PERMISSION_POLICY, 'utf8'))
      disk.grants = grants
      writeFileSync(process.env.CODSH_PERMISSION_POLICY, `${JSON.stringify(disk, null, 2)}\n`)
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

function askReason(access, policy, persistFailed) {
  const subject = access.kind === 'bash'
    ? `bash \`${access.command}\``
    : access.kind === 'edit'
      ? `edit \`${access.path}\``
      : access.kind === 'mcp'
        ? `MCP \`${access.name}\``
        : access.kind
  const remember = policy.rememberToolApprovals !== false
  const lines = [`Allow ${subject}? y=allow once${remember ? '  a=always this project' : ''}  n=reject`]
  if (remember) lines.push('Always allow is this project only; y is once, not a permanent rule.')
  if (persistFailed) lines.push("Couldn't save a permanent rule; this allow is once.")
  return lines.join('\n')
}

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!process.env.CODSH_PERMISSION_POLICY) {
      if (exec.name !== 'write' && exec.name !== 'edit') return next()
      const path = typeof exec.arguments?.file_path === 'string' ? exec.arguments.file_path : ''
      return {
        kind: 'ask',
        reason: path === '' ? exec.name : `${exec.name} ${path}`,
      }
    }
    const policy = loadPolicy()
    const access = accessFromTool(exec.name, exec.arguments ?? {})
    const hookDeny = process.env.CODSH_HOOK_DENY
    if (policy.loadError && mutatingAccess(access)) {
      return { kind: 'deny', reason: policy.loadError }
    }
    const decision = evaluatePermission(policy, access, hookDeny)
    if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
    if (decision.kind === 'allow') return next()
    const persistable = policy.rememberToolApprovals !== false && Boolean(policy.grantsPath)
    const asked = await ctx.waterfall('approval/request', {
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      reason: askReason(access, policy, false),
    }, () => 'unavailable')
    if (asked === 'allowed-always' || asked === 'allowed-session') {
      const saved = persistGrant(policy, access, true)
      if (!saved.ok) {
        return next()
      }
      return next()
    }
    if (asked === 'allowed-once') {
      return next()
    }
    if (asked === 'rejected') {
      return { kind: 'deny', reason: `the user rejected tool "${exec.name}"` }
    }
    if (asked === 'cancelled') return { kind: 'deny', reason: `approval for tool "${exec.name}" was cancelled` }
    return { kind: 'deny', reason: persistable ? decision.reason : `Couldn't save a permanent rule; this allow is once. ${decision.reason}` }
  })
  ctx.on('tools/execute', async (exec, next) => {
    const delay = Number(process.env.DSH_CODE_CLI_TOOL_DELAY_MS ?? '0')
    if (delay > 0) await wait(delay, exec.signal)
    return next()
  })
}
