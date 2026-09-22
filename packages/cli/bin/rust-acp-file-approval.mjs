/**
 * Enforce Grok-compatible allow/ask/deny rules before dsh tools execute.
 * Deny and hook blocks have no side effects. Ask is forwarded as
 * session/request_permission; remembered grants persist per project.
 * Optional DSH_CODE_CLI_TOOL_DELAY_MS parks around-dispatch so cancel can
 * land while a tool is running; the wait observes exec.signal.
 */
export const name = 'rust-acp-file-approval'

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
    const defaults = defaultPolicy()
    return {
      ...defaults,
      ...parsed,
      grants: { ...defaults.grants, ...(parsed.grants ?? {}) },
      loadError: '',
    }
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
      allowedEditPaths: [],
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
const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh'])

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
    || /(?<![\\])[(){}]/.test(command)
    || hasBackgroundAmp(command)
    || isControlFlow(command)
    || isUnpeelable(command)
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
  if (isUnpeelable(command)) return []
  if (isUnsplittable(command)) return [stripWrappers(command.trim())].filter(Boolean)
  return splitSimple(command)
}

function ruleSubjects(command) {
  const trimmed = command.trimStart()
  const parsed = parsedCommand(trimmed)
  const peeled = bashSegments(trimmed)
  const heads = [trimmed, parsed, ...peeled]
  return [...new Set(heads.flatMap(subject => {
    const named = basenameCommand(subject)
    return named && named !== subject ? [subject, named] : [subject]
  }).filter(Boolean))]
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

function decodeAnsiC(body) {
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') {
      out += body[i]
      continue
    }
    const next = body[i + 1]
    if (next === undefined) {
      out += '\\'
      break
    }
    if (next === '\n') {
      i += 1
      continue
    }
    const simple = { n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"' }
    if (simple[next] !== undefined) {
      out += simple[next]
      i += 1
      continue
    }
    if (next === 'x' && /^[0-9a-fA-F]{1,2}/u.test(body.slice(i + 2, i + 4))) {
      const hex = body.slice(i + 2, i + 4).match(/^[0-9a-fA-F]{1,2}/u)[0]
      out += String.fromCharCode(Number.parseInt(hex, 16))
      i += 1 + hex.length
      continue
    }
    if (/[0-7]/u.test(next)) {
      const oct = body.slice(i + 1, i + 4).match(/^[0-7]{1,3}/u)[0]
      out += String.fromCharCode(Number.parseInt(oct, 8))
      i += oct.length
      continue
    }
    out += next
    i += 1
  }
  return out
}

function shellWords(command) {
  const words = []
  let i = 0
  let current = ''
  let open = false
  const push = () => {
    if (open) words.push(current)
    current = ''
    open = false
  }
  while (i < command.length) {
    const ch = command[i]
    if (!open && (ch === ' ' || ch === '\t' || ch === '\n')) {
      i += 1
      continue
    }
    if (open && (ch === ' ' || ch === '\t' || ch === '\n')) {
      push()
      continue
    }
    open = true
    if (command.startsWith("$'", i)) {
      const end = command.indexOf("'", i + 2)
      if (end < 0) {
        current += decodeAnsiC(command.slice(i + 2))
        i = command.length
        continue
      }
      current += decodeAnsiC(command.slice(i + 2, end))
      i = end + 1
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      i += 1
      const start = i
      while (i < command.length && command[i] !== quote) i += 1
      current += command.slice(start, i)
      if (command[i] === quote) i += 1
      continue
    }
    if (ch === '\\') {
      const next = command[i + 1]
      if (next === undefined) {
        current += '\\'
        i += 1
        continue
      }
      if (next === '\n') {
        i += 2
        continue
      }
      current += next
      i += 2
      continue
    }
    current += ch
    i += 1
  }
  push()
  return words
}

function innerShellScripts(command) {
  const scripts = []
  const words = shellWords(command)
  for (let i = 0; i < words.length; i += 1) {
    const base = commandBasename(words[i])
    if (base === 'eval') {
      if (words[i + 1]) scripts.push(words.slice(i + 1).join(' '))
      continue
    }
    if (!SHELLS.has(base)) continue
    let wantScript = false
    i += 1
    while (i < words.length) {
      const word = words[i]
      if (word === '--') {
        i += 1
        if (wantScript && words[i]) {
          scripts.push(words[i])
          break
        }
        continue
      }
      if (word === '-c' || word === '--command' || word.startsWith('--command=')) {
        if (word.startsWith('--command=')) {
          scripts.push(word.slice('--command='.length))
          break
        }
        wantScript = true
        i += 1
        continue
      }
      if (word.startsWith('--')) {
        i += 1
        continue
      }
      if (word.startsWith('-') && word.length > 1) {
        if (word.slice(1).includes('c')) wantScript = true
        i += 1
        continue
      }
      if (wantScript) {
        scripts.push(word)
        break
      }
      break
    }
  }
  return scripts.map(part => part.trim()).filter(Boolean)
}

function extractDashCScripts(command) {
  return innerShellScripts(command)
}

function controlFlowBodies(command) {
  if (!isControlFlow(command)) return []
  const stripped = command.replaceAll(/\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac)\b/gu, ';')
  return splitSimple(stripped)
}

function braceBodies(command) {
  const out = []
  let i = 0
  let quote = ''
  while (i < command.length) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) quote = ''
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      i += 1
      continue
    }
    if (ch === '{') {
      const [inner, next] = takeBalanced(command, i + 1, '{', '}')
      if (inner.trim()) out.push(inner.trim())
      i = next
      continue
    }
    i += 1
  }
  return out
}

function parsedCommand(command) {
  return shellWords(command).join(' ')
}

function commandBasename(word) {
  const name = word.split(/[\\/]/u).at(-1) ?? word
  return name.replace(/\.exe$/iu, '').toLowerCase()
}

function basenameCommand(command) {
  const words = shellWords(command)
  if (words.length === 0) return ''
  words[0] = commandBasename(words[0])
  return words.join(' ')
}

function bashInspectSubjects(command, seen = new Set()) {
  const trimmed = command.trimStart()
  if (!trimmed || seen.has(trimmed)) return []
  const subjects = ruleSubjects(trimmed)
  for (const inner of [
    ...extractSubstitutions(command),
    ...innerShellScripts(command),
    ...controlFlowBodies(command),
    ...braceBodies(command),
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

function isUnpeelable(command) {
  const words = command.split(/\s+/u).filter(Boolean)
  return words.some((word, index) => {
    const base = commandBasename(word)
    return base === 'env' && words[index + 1] === '-S'
  })
}

function stripAssignments(words) {
  while (words[0]?.includes('=') && !words[0].startsWith('-')) words.shift()
}

function takesPositional(wrapper, flag) {
  if (wrapper === 'timeout' && (flag === '-s' || flag === '--signal' || flag === '-k' || flag === '--kill-after')) return true
  if (wrapper === 'nice' && (flag === '-n' || flag === '--adjustment')) return true
  if (wrapper === 'ionice' && (flag === '-c' || flag === '-n' || flag === '-p' || flag === '--class' || flag === '--classdata' || flag === '--pid')) return true
  if (wrapper === 'chrt' && (flag === '-p' || flag === '--pid' || flag === '-o' || flag === '--other' || flag === '-f' || flag === '--fifo' || flag === '-r' || flag === '--rr')) return true
  if (wrapper === 'stdbuf' && (flag === '-i' || flag === '-o' || flag === '-e' || flag === '--input' || flag === '--output' || flag === '--error')) return true
  if (wrapper === 'env' && (flag === '-u' || flag === '--unset' || flag === '-C' || flag === '--chdir')) return true
  return false
}

function isDurationToken(word) {
  return /^(?:\d+(?:\.\d+)?|\.\d+)(?:s|m|h|d)?$/u.test(word)
}

function isPriorityToken(word) {
  return /^-?\d+$/u.test(word)
}

function consumeBarePositional(wrapper, word) {
  if (wrapper === 'timeout') return isDurationToken(word)
  if (wrapper === 'nice' || wrapper === 'ionice' || wrapper === 'chrt') return isPriorityToken(word)
  return false
}

function stripWrappers(command) {
  const words = command.split(/\s+/u).filter(Boolean)
  stripAssignments(words)
  const wrappers = new Set(['timeout', 'nice', 'ionice', 'chrt', 'stdbuf', 'env', 'command'])
  while (words[0] && wrappers.has(commandBasename(words[0]))) {
    const wrapper = commandBasename(words.shift())
    if (wrapper === 'env' && words[0] === '-S') return ''
    let consumedBare = false
    while (words[0]) {
      const flag = words[0]
      if (flag === '--') {
        words.shift()
        break
      }
      if (wrapper === 'env' && flag.includes('=') && !flag.startsWith('-')) {
        words.shift()
        continue
      }
      if (!flag.startsWith('-')) {
        if (!consumedBare && consumeBarePositional(wrapper, flag)) {
          words.shift()
          consumedBare = true
          continue
        }
        break
      }
      words.shift()
      if (flag.includes('=')) continue
      if (takesPositional(wrapper, flag) && words[0] && !words[0].startsWith('-')) words.shift()
    }
    stripAssignments(words)
  }
  stripAssignments(words)
  return words.join(' ')
}

function globMatch(pattern, text, pathMode) {
  const matchClass = (glob, start, candidate) => {
    let i = start + 1
    const negate = glob[i] === '!' || glob[i] === '^'
    if (negate) i += 1
    let matched = false
    while (i < glob.length && glob[i] !== ']') {
      if (i + 2 < glob.length && glob[i + 1] === '-' && glob[i + 2] !== ']') {
        if (candidate >= glob.charCodeAt(i) && candidate <= glob.charCodeAt(i + 2)) matched = true
        i += 3
        continue
      }
      if (glob.charCodeAt(i) === candidate) matched = true
      i += 1
    }
    if (i >= glob.length || glob[i] !== ']') return null
    return { next: i + 1, ok: negate ? !matched : matched }
  }
  const walk = (pi, ti) => {
    while (pi < pattern.length) {
      const ch = pattern[pi]
      if (ch === '*' && pattern[pi + 1] === '*') {
        const rest = pattern[pi + 2] === '/' ? pi + 3 : pi + 2
        if (walk(rest, ti)) return true
        if (ti < text.length) {
          ti += 1
          continue
        }
        return false
      }
      if (ch === '*') {
        if (walk(pi + 1, ti)) return true
        if (ti < text.length && !(pathMode && text[ti] === '/')) {
          ti += 1
          continue
        }
        return false
      }
      if (ch === '?') {
        if (ti >= text.length || (pathMode && text[ti] === '/')) return false
        pi += 1
        ti += 1
        continue
      }
      if (ch === '[') {
        const cls = matchClass(pattern, pi, text.charCodeAt(ti))
        if (!cls || !cls.ok || ti >= text.length) return false
        pi = cls.next
        ti += 1
        continue
      }
      if (ti >= text.length || text[ti] !== ch) return false
      pi += 1
      ti += 1
    }
    return ti === text.length
  }
  return walk(0, 0)
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

function cwdRoots(cwd) {
  const roots = [normalizePath('.', cwd)]
  try {
    const real = realpathSync(cwd).replaceAll('\\', '/')
    if (!roots.includes(real)) roots.push(real)
  } catch { /* cwd may not exist in unit tests */ }
  return roots
}

function pathForms(path, cwd) {
  if (!path) return []
  if (path.startsWith('~')) return [path.replaceAll('\\', '/')]
  const abs = normalizePath(path, cwd)
  const forms = [abs]
  for (const root of cwdRoots(cwd)) {
    if (abs === root || abs.startsWith(`${root}/`)) {
      const rel = abs === root ? '.' : abs.slice(root.length + 1)
      forms.push(rel === '.' ? '.' : `./${rel}`, rel)
    }
  }
  return [...new Set(forms)]
}

function inspectPath(path, cwd) {
  if (!path || path.startsWith('~')) {
    return { forms: pathForms(path, cwd), unresolved: false }
  }
  const abs = normalizePath(path, cwd)
  try {
    const stat = lstatSync(abs)
    if (stat.isSymbolicLink()) {
      try {
        const resolved = realpathSync(abs).replaceAll('\\', '/')
        return {
          forms: [...new Set([...pathForms(path, cwd), resolved, ...pathForms(resolved, cwd)])],
          unresolved: false,
        }
      } catch {
        return { forms: pathForms(path, cwd), unresolved: true }
      }
    }
  } catch {
    return { forms: pathForms(path, cwd), unresolved: false }
  }
  return { forms: pathForms(path, cwd), unresolved: false }
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
  if (rule.tool === 'edit') return access.kind === 'edit'
  if (rule.tool === 'read') return access.kind === 'read' || access.kind === 'grep'
  if (rule.tool === 'grep') return access.kind === 'grep'
  if (rule.tool === 'mcp') return access.kind === 'mcp'
  if (rule.tool === 'web_fetch') return access.kind === 'webfetch'
  if (rule.tool === 'web_search') return access.kind === 'websearch'
  return false
}

function fileRuleApplies(policy, tool) {
  return (policy.rules ?? []).some(rule =>
    (rule.action === 'deny' || rule.action === 'ask')
    && (rule.tool === tool || rule.tool === 'any'))
}

function patternMatches(access, rule, cwd) {
  if (!rule.pattern || rule.pattern === '*') return true
  if (access.kind === 'bash') {
    const command = access.command.trimStart()
    const parsed = parsedCommand(command)
    return command.startsWith(rule.pattern)
      || globMatch(rule.pattern, command, false)
      || parsed.startsWith(rule.pattern)
      || globMatch(rule.pattern, parsed, false)
  }
  if (access.kind === 'edit' || access.kind === 'read' || access.kind === 'grep') {
    const inspected = inspectPath(access.path ?? '', cwd)
    const forms = (rule.action === 'deny' || rule.action === 'ask')
      ? inspected.forms
      : pathForms(access.path ?? '', cwd)
    return forms.some(form => globMatch(rule.pattern, form, true))
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
  const words = shellWords(command)
  const head = commandBasename(words[0] ?? '')
  return ['rm', 'chmod', 'chown', 'chgrp', 'chattr', 'pkill', 'kill', 'killall'].includes(head)
    || (head === 'git' && words[1] === 'push')
}

function uniqueLongOption(word, canonical) {
  if (!word.startsWith('--') || word.startsWith('---')) return false
  const name = word.slice(2).split('=', 1)[0]
  return name.length > 0 && name.length <= canonical.length && canonical.startsWith(name)
}

function optionName(word) {
  if (word.startsWith('--')) return word.slice(2).split('=')[0]
  return ''
}

function resolveUnique(name, candidates) {
  if (!name) return null
  const exact = candidates.find(candidate => candidate === name)
  if (exact) return exact
  const hits = candidates.filter(candidate => candidate.startsWith(name))
  return hits.length === 1 ? hits[0] : null
}

const GIT_LONG_OPTIONS = {
  branch: [
    'abbrev', 'all', 'color', 'column', 'contains', 'copy', 'create-reflog', 'delete',
    'edit-description', 'force', 'format', 'ignore-case', 'list', 'merged', 'move',
    'no-abbrev', 'no-color', 'no-column', 'no-contains', 'no-merged', 'no-track',
    'points-at', 'quiet', 'recurse-submodules', 'remotes', 'set-upstream', 'set-upstream-to',
    'show-current', 'sort', 'track', 'unset-upstream', 'verbose',
  ],
  diff: ['output', 'output-indicator-context', 'output-indicator-new', 'output-indicator-old'],
  log: ['output', 'output-indicator-context', 'output-indicator-new', 'output-indicator-old'],
  show: ['output', 'output-indicator-context', 'output-indicator-new', 'output-indicator-old'],
  blame: ['output'],
  'rev-list': ['output'],
  'cat-file': ['filters', 'follow-symlinks', 'textconv'],
}

const GIT_WRITE_NAMES = {
  branch: new Set([
    'delete', 'move', 'copy', 'force', 'edit-description', 'create-reflog',
    'set-upstream', 'set-upstream-to', 'unset-upstream', 'recurse-submodules',
  ]),
  diff: new Set(['output']),
  log: new Set(['output']),
  show: new Set(['output']),
  blame: new Set(['output']),
  'rev-list': new Set(['output']),
  'cat-file': new Set(['filters', 'textconv']),
}

function gitWriteName(subcommand, name) {
  const options = GIT_LONG_OPTIONS[subcommand]
  const writes = GIT_WRITE_NAMES[subcommand]
  if (!options || !writes) return false
  const canonical = resolveUnique(name, options)
  return canonical !== null && writes.has(canonical)
}

const GIT_BRANCH_VALUE_SHORT = new Set(['u', 't'])
const GIT_BRANCH_SWITCH_SHORT = new Set(['f'])

function gitBranchClusterWrites(word) {
  if (!word.startsWith('-') || word.startsWith('--') || word.length < 2) return false
  const match = /^([A-Za-z]+)(.*)$/u.exec(word.slice(1))
  if (!match) return false
  const letters = match[1]
  const rest = match[2]
  if ([...letters].some(letter => GIT_BRANCH_SWITCH_SHORT.has(letter))) return true
  const valued = [...letters].filter(letter => GIT_BRANCH_VALUE_SHORT.has(letter))
  if (valued.length === 0) return false
  if (rest.length > 0) return true
  return valued.at(-1) !== letters.at(-1)
}

function gitBranchWrites(words) {
  return words.slice(2).some(word => gitWriteOption('branch', word) || gitBranchClusterWrites(word) || !word.startsWith('-'))
}

function gitWriteOption(subcommand, word) {
  if (subcommand === 'branch' && (['-d', '-D', '-m', '-M', '-c', '-C'].includes(word) || gitBranchClusterWrites(word))) return true
  const name = optionName(word)
  if (!name || word.startsWith('---')) return false
  return gitWriteName(subcommand, name)
}

function sortWrites(words) {
  return words.some((word, index) => {
    if (uniqueLongOption(word, 'compress-program')) return true
    const name = optionName(word)
    if (name && resolveUnique(name, ['output', 'compress-program']) === 'output') return true
    if (name && name.length > 'output'.length && name.startsWith('output')) return true
    if (word === '-o' || (index > 0 && words[index - 1] === '-o')) return true
    return word.length > 1 && word.startsWith('-') && !word.startsWith('--') && word.includes('o')
  })
}

function raisesReadonlyFloor(words) {
  const head = words[0]
  if (head === 'rg' && words.some(word => word === '--pre' || word.startsWith('--pre='))) return true
  if (head === 'sort' && sortWrites(words)) return true
  if (head === 'git' && words.some(word => word === '-c' || word.startsWith('--config-env'))) return true
  if (head === 'git' && words[1] === 'branch' && gitBranchWrites(words)) return true
  if (head === 'git' && words.slice(2).some(word => gitWriteOption(words[1], word))) return true
  if (head === 'eval') return true
  return false
}

const GIT_READONLY = new Set([
  'status', 'branch', 'log', 'diff', 'ls-files', 'show', 'rev-parse', 'blame', 'describe',
  'merge-base', 'shortlog', 'check-ignore', 'check-attr', 'cat-file', 'ls-tree', 'show-ref',
  'for-each-ref', 'rev-list', 'name-rev', 'count-objects',
])

function readonlyCommand(command) {
  const words = shellWords(command)
  const head = words[0]
  if (raisesReadonlyFloor(words)) return false
  if (['ls', 'cat', 'pwd', 'date', 'whoami', 'hostname', 'uptime', 'ps', 'head', 'tail', 'wc', 'sort', 'uniq', 'tr', 'cut', 'grep', 'rg'].includes(head)) {
    return true
  }
  if (head === 'git') return GIT_READONLY.has(words[1])
  return head === 'kubectl' && ['get', 'logs', 'describe'].includes(words[1])
}

function readonlyAccess(access) {
  return access.kind === 'read' || access.kind === 'grep' || access.kind === 'websearch'
}

function pathRuleDecision(policy, path, cwd) {
  const inspected = inspectPath(path, cwd)
  const read = evaluateRulesFor(policy, { kind: 'read', path }, cwd)
  if (read?.kind === 'deny') return read
  const edit = evaluateRulesFor(policy, { kind: 'edit', path }, cwd)
  if (edit?.kind === 'deny') return edit
  if (read?.kind === 'ask') return read
  if (edit?.kind === 'ask') return edit
  if (inspected.unresolved && (fileRuleApplies(policy, 'read') || fileRuleApplies(policy, 'edit'))) {
    return { kind: 'ask', reason: 'unresolved symlink' }
  }
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
  if ((access.kind === 'read' || access.kind === 'edit' || access.kind === 'grep')
    && inspectPath(access.path ?? '', cwd).unresolved
    && fileRuleApplies(policy, access.kind === 'edit' ? 'edit' : 'read')) {
    return { kind: 'ask', reason: 'unresolved symlink' }
  }
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
    if (isUnpeelable(access.command)) return null
    const segments = bashSegments(access.command)
    if (segments.length === 0) return null
    const subjects = [access.command.trimStart(), ...segments]
    const denied = (grants.deniedBash ?? []).find(prefix => subjects.some(subject => commandPrefix(subject, prefix)))
    if (denied) return { kind: 'deny', reason: `User previously rejected \`${denied}\` in this project` }
    if (!policy.rememberToolApprovals) return null
    if (subjects.some(subject => dangerous(subject) && !(grants.allowedBash ?? []).includes(subject))) return null
    if (segments.every(segment => (grants.allowedBash ?? []).some(grant => commandPrefix(segment, grant) || segment === grant))) {
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
  if (access.kind === 'edit') {
    if (grants.allowedEdits) return { kind: 'allow', reason: 'allow all edits this session' }
    if (policy.rememberToolApprovals && pathForms(access.path ?? '', policy.cwd || process.cwd()).some(form => (grants.allowedEditPaths ?? []).includes(form))) {
      return { kind: 'allow', reason: 'remembered project grant' }
    }
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
  if (access.kind === 'bash') {
    const segments = bashSegments(access.command)
    if (!isUnsplittable(access.command)
      && segments.length > 0
      && segments.every(segment => readonlyCommand(segment) && !dangerous(segment))) {
      return { kind: 'allow', reason: 'read-only shell command' }
    }
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
  const words = shellWords(command)
  if (words.length === 0) return command.trim()
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
    allowedEditPaths: [...policy.grants?.allowedEditPaths ?? []],
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
  } else if (access.kind === 'edit' && allow && access.path) {
    for (const form of pathForms(access.path, policy.cwd || process.cwd())) {
      if (!grants.allowedEditPaths.includes(form)) grants.allowedEditPaths.push(form)
    }
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
      `allow_edits_for_session = false`,
      `allowed_edit_paths = ${JSON.stringify(grants.allowedEditPaths)}`,
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
