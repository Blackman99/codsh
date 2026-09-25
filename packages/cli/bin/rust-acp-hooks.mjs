/**
 * Run Grok-compatible command hooks on the released dsh lifecycle.
 * dsh 0.1.5-rc.2 does not execute these events. Its Claude and Codex bridges
 * read one config at process start and ignore a top-level decision of deny,
 * so this plugin owns discovery, payloads, exit codes, and blocking.
 * A hook runs only as a child of dsh. An allow does not skip permission
 * checks. A hook cannot widen a sandbox or permission deny. Untrusted project
 * hooks are omitted. HTTP, prompt, and agent handlers do not run.
 * Hooks from enabled, trusted plugins arrive in CODSH_PLUGIN_HOOKS (written by
 * codsh-rust from the same gate as plugin skills and rules) and run under this
 * same contract, with GROK_PLUGIN_ROOT / GROK_PLUGIN_DATA set.
 */
export const name = 'rust-acp-hooks'
export const inject = ['tools', 'sessionProjections']

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const MARK = '\u241ehook\u241e'
const DEFAULT_TIMEOUT_SEC = 5
const GATE_TIMEOUT_SEC = 600
const PROMPT_TIMEOUT_SEC = 30
const MAX_STOP_CONTINUATIONS = 8
const FEEDBACK_CHARS = 10_000
const REASON_CHARS = 256
const STDERR_LINE = 500
const GATE_EVENTS = new Set(['Stop', 'SubagentStop', 'PostToolUse'])
const RESERVED_ENV = new Set([
  'GROK_HOOK_EVENT',
  'GROK_HOOK_NAME',
  'GROK_SESSION_ID',
  'GROK_WORKSPACE_ROOT',
  'CLAUDE_PROJECT_DIR',
  'CODSH_HOOK_HOST_PID',
])

const EVENTS = {
  SessionStart: { gate: 'observe', matcher: 'tested' },
  UserPromptSubmit: { gate: 'prompt', matcher: 'ignored' },
  PreToolUse: { gate: 'tool', matcher: 'tested' },
  PostToolUse: { gate: 'post', matcher: 'tested' },
  PostToolUseFailure: { gate: 'observe', matcher: 'tested' },
  PermissionDenied: { gate: 'observe', matcher: 'tested' },
  Stop: { gate: 'stop', matcher: 'ignored' },
  StopFailure: { gate: 'observe', matcher: 'tested' },
  StopCancelled: { gate: 'observe', matcher: 'tested' },
  Notification: { gate: 'observe', matcher: 'tested' },
  SubagentStart: { gate: 'observe', matcher: 'tested' },
  SubagentStop: { gate: 'stop', matcher: 'tested' },
  PreCompact: { gate: 'observe', matcher: 'tested' },
  PostCompact: { gate: 'observe', matcher: 'tested' },
  SessionEnd: { gate: 'observe', matcher: 'tested' },
}

const ALIASES = new Map([
  ['sessionstart', 'SessionStart'],
  ['session_start', 'SessionStart'],
  ['userpromptsubmit', 'UserPromptSubmit'],
  ['user_prompt_submit', 'UserPromptSubmit'],
  ['beforesubmitprompt', 'UserPromptSubmit'],
  ['pretooluse', 'PreToolUse'],
  ['pre_tool_use', 'PreToolUse'],
  ['beforeshellexecution', 'PreToolUse'],
  ['beforemcpexecution', 'PreToolUse'],
  ['beforereadfile', 'PreToolUse'],
  ['posttooluse', 'PostToolUse'],
  ['post_tool_use', 'PostToolUse'],
  ['aftershellexecution', 'PostToolUse'],
  ['aftermcpexecution', 'PostToolUse'],
  ['afterfileedit', 'PostToolUse'],
  ['afteragentresponse', 'PostToolUse'],
  ['afteragentthought', 'PostToolUse'],
  ['posttoolusefailure', 'PostToolUseFailure'],
  ['post_tool_use_failure', 'PostToolUseFailure'],
  ['permissiondenied', 'PermissionDenied'],
  ['permission_denied', 'PermissionDenied'],
  ['stop', 'Stop'],
  ['stopfailure', 'StopFailure'],
  ['stop_failure', 'StopFailure'],
  ['stopcancelled', 'StopCancelled'],
  ['stop_cancelled', 'StopCancelled'],
  ['notification', 'Notification'],
  ['subagentstart', 'SubagentStart'],
  ['subagent_start', 'SubagentStart'],
  ['subagentstop', 'SubagentStop'],
  ['subagent_stop', 'SubagentStop'],
  ['subagentend', 'SubagentStop'],
  ['subagent_end', 'SubagentStop'],
  ['precompact', 'PreCompact'],
  ['pre_compact', 'PreCompact'],
  ['postcompact', 'PostCompact'],
  ['post_compact', 'PostCompact'],
  ['sessionend', 'SessionEnd'],
  ['session_end', 'SessionEnd'],
])

const TOOL_ALIASES = new Map([
  ['bash', ['bash', 'run_terminal_command']],
  ['read', ['read', 'read_file']],
  ['edit', ['edit', 'search_replace']],
  ['write', ['write', 'search_replace']],
  ['multiedit', ['search_replace']],
  ['grep', ['grep']],
  ['glob', ['glob', 'list_dir']],
  ['listdir', ['list_dir', 'glob']],
  ['websearch', ['web_search']],
  ['task', ['spawn_subagent', 'subagent']],
])

export function canonicalEvent(name) {
  if (typeof name !== 'string') return ''
  if (EVENTS[name]) return name
  return ALIASES.get(name.replace(/[^A-Za-z_]/g, '').toLowerCase()) ?? ''
}

export function clip(text, max) {
  const value = String(text ?? '')
  const chars = [...value]
  if (chars.length <= max) return value
  return `${chars.slice(0, max).join('')}… [+${chars.length - max} chars]`
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function truthyOff(value) {
  return value === false || value === 0 || value === '0' || value === 'false'
}

export function compatEnabled(name, env = process.env) {
  const key = `GROK_COMPAT_${name.toUpperCase()}_HOOKS`
  if (env[key] !== undefined) return !truthyOff(env[key])
  return true
}

function jsonFiles(dir) {
  if (!dir || !existsSync(dir)) return []
  let stats
  try {
    stats = statSync(dir)
  } catch {
    return []
  }
  if (!stats.isDirectory()) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => join(dir, name))
}

function walkParents(start) {
  const found = []
  let current = resolve(start)
  const seen = new Set()
  while (!seen.has(current)) {
    seen.add(current)
    found.push(current)
    if (existsSync(join(current, '.git'))) break
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  return found
}

function parseTomlHooks(text) {
  const groups = []
  let current = null
  let inside = false
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    const header = line.match(/^\[\[hooks\.([A-Za-z_]+)(?:\.hooks)?\]\]$/)
    if (header) {
      const event = canonicalEvent(header[1])
      if (!event) {
        current = null
        inside = false
        continue
      }
      if (line.includes('.hooks')) {
        inside = Boolean(current)
      } else {
        current = { event, matcher: '', hooks: [] }
        groups.push(current)
        inside = false
      }
      continue
    }
    if (!current) continue
    const field = line.match(/^([A-Za-z_]+)\s*=\s*(.*)$/)
    if (!field) continue
    const [, key, rawValue] = field
    let value = rawValue.trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!inside && key === 'matcher') current.matcher = value
    if (inside && key === 'type') current.hooks.push({ type: value })
    if (inside && current.hooks.length > 0) {
      const hook = current.hooks.at(-1)
      if (key === 'command' || key === 'url') hook[key] = value
      if (key === 'timeout' && /^[0-9]+$/.test(value)) hook.timeout = Number(value)
    }
    if (!inside && key === 'hooks' && value.startsWith('[')) {
      try {
        const parsed = JSON.parse(value.replaceAll("'", '"'))
        if (Array.isArray(parsed)) current.hooks.push(...parsed)
      } catch {
        // A malformed inline array is a load warning, not a running hook.
      }
    }
  }
  return groups
}

function expand(text, env) {
  return String(text ?? '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, braced, fallback, bare) => {
    const name = braced || bare
    if (env[name] !== undefined && env[name] !== '') return env[name]
    if (braced && fallback !== undefined) return fallback
    return all
  })
}

/**
 * Plugin hook sources from CODSH_PLUGIN_HOOKS. A malformed value loads no
 * plugin hooks and becomes one warning; one bad entry skips only itself.
 */
export function pluginHookSources(raw, warnings = []) {
  if (raw === undefined || raw === '') return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    warnings.push(`plugin hooks unreadable (${error.message})`)
    return []
  }
  if (!Array.isArray(parsed)) {
    warnings.push('plugin hooks must be a list')
    return []
  }
  const out = []
  for (const entry of parsed) {
    const item = asObject(entry)
    if (!item || typeof item.plugin !== 'string' || typeof item.root !== 'string') {
      warnings.push('skipped a plugin hook entry without plugin and root')
      continue
    }
    const file = typeof item.file === 'string' && item.file ? item.file : ''
    const body = typeof item.body === 'string' && item.body ? item.body : undefined
    if (!file && body === undefined) continue
    const data = typeof item.data === 'string' ? item.data : ''
    out.push({
      plugin: item.plugin,
      scope: item.scope === 'project' ? 'project' : 'user',
      file: file || join(item.root, 'plugin.json'),
      body,
      env: {
        GROK_PLUGIN_ROOT: item.root,
        CLAUDE_PLUGIN_ROOT: item.root,
        GROK_PLUGIN_DATA: data,
        CLAUDE_PLUGIN_DATA: data,
      },
    })
  }
  return out
}

function handlerFrom(raw, source, file, env, ownedEnv) {
  const type = typeof raw?.type === 'string' ? raw.type : 'command'
  if (type !== 'command') return { skipped: type }
  if (typeof raw.command !== 'string' || raw.command.trim() === '') return null
  const command = expand(raw.command, env)
  const timeout = Number(raw.timeout)
  const hookEnv = {}
  if (asObject(raw.env)) {
    for (const [key, value] of Object.entries(raw.env)) {
      if (RESERVED_ENV.has(key)) continue
      if (typeof value === 'string') hookEnv[key] = value
    }
  }
  // Plugin-owned keys win over a hook's own env, so a plugin cannot repoint
  // its root.
  if (ownedEnv) Object.assign(hookEnv, ownedEnv)
  return {
    type: 'command',
    command,
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    env: hookEnv,
    source,
    file,
    name: `${source}:${command}`,
  }
}

function groupsFromJson(parsed, source, file, env, ownedEnv) {
  const root = asObject(parsed)
  const map = root ? asObject(root.hooks) ?? root : null
  if (!map) return { groups: [], skipped: [], unknown: [] }
  const groups = []
  const skipped = []
  const unknown = []
  for (const [key, value] of Object.entries(map)) {
    const event = canonicalEvent(key)
    if (!event) {
      unknown.push(key)
      continue
    }
    if (!Array.isArray(value)) continue
    for (const rawGroup of value) {
      const group = asObject(rawGroup)
      if (!group || !Array.isArray(group.hooks)) continue
      const hooks = []
      for (const raw of group.hooks) {
        const handler = handlerFrom(asObject(raw), source, file, ownedEnv ? { ...env, ...ownedEnv } : env, ownedEnv)
        if (!handler) continue
        if (handler.skipped) {
          skipped.push({ event, type: handler.skipped })
          continue
        }
        hooks.push(handler)
      }
      if (hooks.length === 0) continue
      const matcher = EVENTS[event].matcher === 'ignored' ? '' : String(group.matcher ?? '')
      groups.push({ event, matcher, hooks, source, file })
    }
  }
  return { groups, skipped, unknown }
}

export function discoverHooks(options) {
  const env = options.env ?? process.env
  const cwd = options.cwd
  const grokHome = options.grokHome
  const trusted = options.trusted === true
  const sources = []
  const pushFile = (file, source, body, ownedEnv) => sources.push({ file, source, body, ownedEnv })
  for (const file of jsonFiles(grokHome ? join(grokHome, 'hooks') : '')) pushFile(file, 'global')
  if (compatEnabled('claude', env)) {
    for (const name of ['settings.json', 'settings.local.json']) {
      const file = grokHome ? join(grokHome, '..', '.claude', name) : ''
      const homeFile = env.HOME ? join(env.HOME, '.claude', name) : ''
      for (const candidate of [homeFile, file]) {
        if (candidate && existsSync(candidate)) pushFile(candidate, 'claude')
      }
    }
  }
  if (compatEnabled('cursor', env)) {
    const file = env.HOME ? join(env.HOME, '.cursor', 'hooks.json') : ''
    if (file && existsSync(file)) pushFile(file, 'cursor')
  }
  for (const layer of options.managed ?? []) pushFile(layer, 'managed')
  for (const layer of options.requirements ?? []) pushFile(layer, 'requirements')
  if (options.userConfig && existsSync(options.userConfig)) pushFile(options.userConfig, 'user')
  for (const plugin of options.plugins ?? []) {
    // codsh-rust already drops project plugins in an untrusted workspace;
    // this keeps the same rule if an entry arrives anyway.
    if (plugin.scope === 'project' && !trusted) continue
    pushFile(plugin.file, `plugin:${plugin.plugin}`, plugin.body, plugin.env)
  }
  if (trusted) {
    for (const dir of [...walkParents(cwd)].reverse()) {
      for (const file of jsonFiles(join(dir, '.grok', 'hooks'))) pushFile(file, 'project')
      if (compatEnabled('claude', env)) {
        for (const name of ['settings.json', 'settings.local.json']) {
          const file = join(dir, '.claude', name)
          if (existsSync(file)) pushFile(file, 'claude-project')
        }
      }
      if (compatEnabled('cursor', env)) {
        const file = join(dir, '.cursor', 'hooks.json')
        if (existsSync(file)) pushFile(file, 'cursor-project')
      }
    }
    if (options.workspaceConfig && existsSync(options.workspaceConfig)) pushFile(options.workspaceConfig, 'workspace')
  }
  const groups = []
  const warnings = []
  const seen = new Map()
  for (const source of sources) {
    let parsed
    try {
      const text = source.body ?? readFileSync(source.file, 'utf8')
      parsed = source.file?.endsWith('.toml') || source.source === 'user' || source.source === 'workspace'
        ? { hooks: Object.fromEntries(parseTomlHooks(text).map(group => [group.event, [{ matcher: group.matcher, hooks: group.hooks }]])) }
        : JSON.parse(text)
    } catch (error) {
      warnings.push(`hook config unreadable: ${source.file ?? source.source} (${error.message})`)
      continue
    }
    if (source.file?.endsWith('.toml') || source.source === 'user' || source.source === 'workspace') {
      const table = parseTomlHooks(source.body ?? readFileSync(source.file, 'utf8'))
      parsed = { hooks: {} }
      for (const group of table) {
        parsed.hooks[group.event] ??= []
        parsed.hooks[group.event].push({ matcher: group.matcher, hooks: group.hooks })
      }
    }
    const loaded = groupsFromJson(parsed, source.source, source.file ?? source.source, env, source.ownedEnv)
    for (const key of loaded.unknown) warnings.push(`skipped unknown hook event ${key}`)
    for (const item of loaded.skipped) warnings.push(`skipped ${item.type} hook on ${item.event}; only command hooks run`)
    for (const group of loaded.groups) {
      const kept = []
      for (const hook of group.hooks) {
        const key = `${group.event}\0${hook.command}\0${group.matcher}`
        if (seen.has(key)) {
          warnings.push(`duplicate hook kept once: ${hook.command}`)
          continue
        }
        seen.set(key, hook)
        kept.push(hook)
      }
      if (kept.length > 0) groups.push({ ...group, hooks: kept })
    }
  }
  return { groups, warnings, trusted }
}

function matcherNames(pattern) {
  const names = new Set([pattern])
  for (const alternative of pattern.split('|')) {
    const key = alternative.trim().toLowerCase()
    for (const alias of TOOL_ALIASES.get(key) ?? []) names.add(alias)
  }
  return [...names]
}

export function matcherHits(pattern, subject) {
  if (!pattern) return true
  const target = String(subject ?? '')
  try {
    if (new RegExp(pattern).test(target)) return true
  } catch {
    return false
  }
  // `Bash` also matches `bash` and `run_terminal_command`. The original
  // pattern still matches on its own.
  return matcherNames(pattern).some(name => name === target || name.toLowerCase() === target.toLowerCase())
}

function defaultTimeout(event) {
  if (event === 'UserPromptSubmit') return PROMPT_TIMEOUT_SEC
  if (GATE_EVENTS.has(event)) return GATE_TIMEOUT_SEC
  return DEFAULT_TIMEOUT_SEC
}

function runCommand(hook, payload, event, signal, cwd) {
  const timeoutSec = hook.timeout ?? defaultTimeout(event)
  const childEnv = { ...process.env, ...hook.env }
  for (const key of RESERVED_ENV) delete childEnv[key]
  childEnv.GROK_HOOK_EVENT = payload.hookEventName
  childEnv.GROK_HOOK_NAME = hook.name
  childEnv.GROK_SESSION_ID = payload.sessionId
  childEnv.GROK_WORKSPACE_ROOT = payload.workspaceRoot
  childEnv.CLAUDE_PROJECT_DIR = payload.workspaceRoot
  // The dsh process running this hook: a helper a hook leaves behind (the
  // Ship extension's browser graph server) exits when it does.
  childEnv.CODSH_HOOK_HOST_PID = String(process.pid)
  return new Promise(resolvePromise => {
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(outcome)
    }
    let child
    try {
      child = spawn('/bin/sh', ['-c', hook.command], {
        cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ exitCode: undefined, stdout: '', stderr: error.message, timedOut: false, spawned: false })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ exitCode: undefined, stdout, stderr, timedOut: true, spawned: true })
    }, timeoutSec * 1000)
    const onAbort = () => {
      child.kill('SIGKILL')
      finish({ exitCode: undefined, stdout, stderr: stderr || 'cancelled', timedOut: false, cancelled: true, spawned: true })
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', error => finish({ exitCode: undefined, stdout, stderr: error.message, timedOut: false, spawned: false }))
    child.on('close', code => finish({ exitCode: code, stdout, stderr, timedOut: false, spawned: true }))
    try {
      child.stdin?.end(`${JSON.stringify(payload)}\n`)
    } catch {
      // A closed stdin still yields the process outcome.
    }
  })
}

function decisionOf(value) {
  if (value === 'approve' || value === 'allow') return 'allow'
  if (value === 'block' || value === 'deny') return 'deny'
  if (value === 'ask') return 'ask'
  if (value === 'defer') return 'defer'
  return ''
}

export function decodeHook(event, outcome) {
  const stdout = String(outcome.stdout ?? '')
  const stderr = String(outcome.stderr ?? '')
  const firstErr = stderr.split('\n').find(line => line.trim())?.trim() ?? ''
  const base = {
    exitCode: outcome.exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    decision: '',
    reason: '',
    additionalContext: '',
    updatedInput: null,
    continue: true,
    stopReason: '',
    updatedToolOutput: null,
    systemMessage: '',
    failure: '',
  }
  if (outcome.cancelled) {
    return { ...base, failure: 'cancelled' }
  }
  if (outcome.timedOut) {
    return { ...base, failure: 'timed out' }
  }
  if (!outcome.spawned || outcome.exitCode === undefined || outcome.exitCode === null) {
    return { ...base, failure: firstErr || 'failed to start' }
  }
  let parsed = null
  if (stdout.trim().startsWith('{')) {
    try {
      parsed = asObject(JSON.parse(stdout))
    } catch {
      parsed = null
      if (outcome.exitCode === 0) base.failure = 'malformed output'
    }
  }
  if (parsed) {
    const specific = asObject(parsed.hookSpecificOutput)
    const claimed = specific ? String(specific.hookEventName ?? '') : ''
    const sameEvent = !specific || !claimed || canonicalEvent(claimed) === event
    const top = decisionOf(parsed.decision)
    const permission = sameEvent && specific ? decisionOf(specific.permissionDecision) : ''
    base.decision = permission || top
    base.reason = String((sameEvent && specific?.permissionDecisionReason) || parsed.reason || '')
    if (sameEvent && typeof specific?.additionalContext === 'string') base.additionalContext = specific.additionalContext
    if (sameEvent && asObject(specific?.updatedInput)) base.updatedInput = specific.updatedInput
    if (sameEvent && specific && Object.hasOwn(specific, 'updatedToolOutput')) base.updatedToolOutput = specific.updatedToolOutput
    if (parsed.continue === false) base.continue = false
    if (typeof parsed.stopReason === 'string') base.stopReason = parsed.stopReason
    if (typeof parsed.systemMessage === 'string') base.systemMessage = parsed.systemMessage.trim()
    if (base.decision && !['allow', 'deny', 'ask', 'defer'].includes(base.decision)) {
      base.failure = `invalid decision ${base.decision}`
      base.decision = ''
    }
  }
  if (outcome.exitCode === 2) {
    if (event === 'PreToolUse' && base.decision !== 'deny') base.decision = 'deny'
    if ((event === 'Stop' || event === 'SubagentStop') && !parsed) base.decision = 'deny'
    if (event === 'UserPromptSubmit') base.decision = 'deny'
    if (event === 'PostToolUse' && !base.reason) base.decision = 'deny'
    if (!base.reason) base.reason = firstErr
  } else if (outcome.exitCode !== 0) {
    const explicitDeny = event === 'PreToolUse' && base.decision === 'deny'
    if (!explicitDeny) {
      base.failure = `exit code ${outcome.exitCode}${firstErr ? `: ${firstErr}` : ''}`
      if (event !== 'PostToolUse' && event !== 'Stop' && event !== 'SubagentStop') base.decision = ''
    }
  }
  if (outcome.exitCode !== 0) {
    base.updatedInput = null
    if (event === 'PreToolUse' || event === 'PostToolUse') base.additionalContext = ''
    if (event === 'PostToolUse') base.updatedToolOutput = null
  }
  if (base.decision === 'defer') {
    base.updatedInput = null
    base.additionalContext = ''
  }
  if (base.decision === 'deny' && event === 'PreToolUse') base.updatedInput = null
  base.reason = clip(base.reason, event === 'PreToolUse' ? REASON_CHARS : FEEDBACK_CHARS)
  base.additionalContext = clip(base.additionalContext, FEEDBACK_CHARS)
  base.systemMessage = clip(base.systemMessage, STDERR_LINE)
  return base
}

function blocks(decoded, event) {
  if (decoded.failure && event !== 'PreToolUse') return false
  if (event === 'PreToolUse') return decoded.decision === 'deny'
  if (event === 'UserPromptSubmit') return decoded.decision === 'deny'
  if (event === 'Stop' || event === 'SubagentStop') return decoded.decision === 'deny' || Boolean(decoded.additionalContext)
  return false
}

function note(hook, event, text) {
  return `${MARK}${event} hook (${hook.name}) ${text}`
}

async function runMatched(registry, event, subject, payload, signal, cwd) {
  const notes = []
  const decoded = []
  for (const group of registry.groups) {
    if (group.event !== event) continue
    if (group.matcher && EVENTS[event].matcher === 'tested' && !matcherHits(group.matcher, subject)) continue
    if (group.matcher && EVENTS[event].matcher === 'ignored') {
      notes.push(`${MARK}${event} hook matcher ignored`)
    }
    for (const hook of group.hooks) {
      const outcome = await runCommand(hook, payload, event, signal, cwd)
      const result = decodeHook(event, outcome)
      decoded.push({ hook, result })
      if (result.failure) notes.push(note(hook, event, `failed, ignored: ${clip(result.failure, STDERR_LINE)}`))
      else if (blocks(result, event) || (event === 'PostToolUse' && result.decision === 'deny')) {
        notes.push(note(hook, event, result.reason || result.decision))
      } else if (result.systemMessage) {
        // Claude Code's `systemMessage`: shown as-is, for every event, instead
        // of the raw JSON output line, labeled with the hook's source (for
        // example `plugin:ship`) rather than its whole command line.
        notes.push(`${MARK}${event} hook (${hook.source}) ${result.systemMessage}`)
      } else if (result.stdout && event !== 'PreToolUse' && event !== 'UserPromptSubmit') {
        notes.push(note(hook, event, `output: ${clip(result.stdout, STDERR_LINE)}`))
      }
      if (event === 'PreToolUse' && result.decision === 'deny') return { decoded, notes, stopped: true }
    }
  }
  return { decoded, notes, stopped: false }
}

function permissionMode(policy) {
  if (policy?.mode === 'always-approve') return 'bypassPermissions'
  if (policy?.mode === 'auto') return 'auto'
  if (policy?.mode === 'plan') return 'plan'
  return 'default'
}

function basePayload(agent, event, policy) {
  const cwd = agent?.session?.header?.cwd ?? process.cwd()
  return {
    hookEventName: event.replace(/[A-Z]/g, (char, index) => (index ? '_' : '') + char.toLowerCase()).replace(/^_/, ''),
    hook_event_name: event,
    sessionId: agent?.session?.header?.id ?? '',
    cwd,
    workspaceRoot: cwd,
    permissionMode: permissionMode(policy),
    timestamp: new Date().toISOString(),
  }
}

function textOf(content) {
  return (content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('')
}

function userPrompt(messages) {
  const texts = (messages ?? []).flatMap(message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text))
  return texts.find(text => text && !text.startsWith(MARK) && !text.startsWith('<')) ?? texts.at(-1) ?? ''
}

function loadPolicy() {
  const path = process.env.CODSH_PERMISSION_POLICY
  if (!path || !existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

function publish(agent, notes) {
  for (const text of notes) console.error(text)
  if (!agent || notes.length === 0) return
  agent.inject(createUserMessage({
    content: notes.map(text => ({ type: 'text', text })),
    source: { kind: 'plugin', plugin: 'rust-acp-hooks' },
  }))
}

/**
 * The tool name hooks see. MCP tools use Grok's `server__tool` rather than
 * dsh's `mcp__server__tool`; the `use_tool` dispatcher is skipped because
 * its nested call fires the hooks as the underlying tool.
 */
export function hookToolName(name) {
  if (name === 'use_tool') return null
  return name.startsWith('mcp__') && name.length > 5 ? name.slice(5) : name
}

export function apply(ctx) {
  const grokHome = process.env.GROK_HOME ?? ''
  const trusted = process.env.CODSH_WORKSPACE_TRUSTED === '1'
  const cwd = process.cwd()
  const pluginWarnings = []
  const plugins = pluginHookSources(process.env.CODSH_PLUGIN_HOOKS, pluginWarnings)
  const registry = discoverHooks({
    cwd,
    grokHome,
    trusted,
    plugins,
    env: process.env,
    userConfig: grokHome ? join(grokHome, 'config.toml') : '',
    workspaceConfig: trusted ? join(cwd, '.grok', 'config.toml') : '',
  })
  for (const warning of [...pluginWarnings, ...registry.warnings]) ctx.logger?.warn?.(`rust-acp-hooks: ${warning}`)
  const continuations = new Map()
  ctx.on('agent/session-start', ({ agent }) => {
    const payload = basePayload(agent, 'SessionStart', loadPolicy())
    payload.source = 'startup'
    runMatched(registry, 'SessionStart', 'startup', payload, undefined, cwd)
      .then(({ notes }) => publish(agent, notes))
      .catch(error => ctx.logger?.warn?.(`rust-acp-hooks: SessionStart failed: ${error.message}`))
  })
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    if (!messages?.length) return next()
    const prompt = userPrompt(messages)
    if (!prompt || prompt.startsWith(MARK)) return next()
    const payload = basePayload(agent, 'UserPromptSubmit', loadPolicy())
    payload.prompt = prompt
    payload.promptId = String(turn ?? '')
    const ran = await runMatched(registry, 'UserPromptSubmit', '', payload, signal, cwd)
    publish(agent, ran.notes)
    if (ran.decoded.some(item => item.result.decision === 'deny' && !item.result.failure)) {
      // dsh has already claimed this prompt. Reject the step so the provider
      // is not called. The prompt is not requeued: putting a claimed message
      // back throws and would hang the session.
      return { kind: 'reject' }
    }
    return next()
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = hookToolName(exec.name)
    if (toolName === null) return next()
    const payload = basePayload(exec.agent, 'PreToolUse', loadPolicy())
    payload.toolName = toolName
    payload.tool_name = toolName
    payload.toolInput = exec.arguments ?? {}
    payload.tool_input = exec.arguments ?? {}
    payload.toolUseId = exec.callId
    payload.tool_use_id = exec.callId
    const ran = await runMatched(registry, 'PreToolUse', toolName, payload, exec.signal, cwd)
    publish(exec.agent, ran.notes)
    const deny = ran.decoded.find(item => item.result.decision === 'deny')
    if (deny) {
      return { kind: 'deny', reason: `Denied by hook: ${deny.result.reason || deny.hook.name}` }
    }
    const ask = ran.decoded.find(item => item.result.decision === 'ask')
    if (ask) {
      return { kind: 'ask', reason: `hook ${ask.hook.name}: ${ask.result.reason || 'confirm'}` }
    }
    const rewrite = [...ran.decoded].reverse().find(item => item.result.updatedInput)
    if (rewrite) {
      // dsh freezes the call before this listener. A rewrite is reported and
      // the original call is not run: applying it here would throw and look
      // like a successful tool.
      publish(exec.agent, [note(rewrite.hook, 'PreToolUse', 'updatedInput is not applied; the call was not run')])
      return { kind: 'deny', reason: `Denied by hook: ${rewrite.hook.name} updatedInput is not applied by this client` }
    }
    return next()
  }, true)
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const toolName = hookToolName(exec.name)
    if (toolName === null) return next()
    const event = result?.isError ? 'PostToolUseFailure' : 'PostToolUse'
    const payload = basePayload(exec.agent, event, loadPolicy())
    payload.toolName = toolName
    payload.tool_name = toolName
    payload.toolInput = exec.arguments ?? {}
    payload.toolResult = textOf(result?.content)
    payload.tool_response = payload.toolResult
    const ran = await runMatched(registry, event, toolName, payload, exec.signal, cwd)
    publish(exec.agent, ran.notes)
    if (event === 'PostToolUse') {
      const blocked = ran.decoded.filter(item => item.result.decision === 'deny' && item.result.reason)
      if (blocked.length > 0) {
        return {
          kind: 'block',
          feedback: blocked.map(item => ({ type: 'text', text: item.result.reason })),
        }
      }
    }
    return next()
  })
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const count = continuations.get(turn) ?? 0
    if (count >= MAX_STOP_CONTINUATIONS) return
    const payload = basePayload(agent, 'Stop', loadPolicy())
    payload.stopHookActive = count > 0
    payload.reason = 'end_turn'
    payload.promptId = String(turn ?? '')
    const ran = await runMatched(registry, 'Stop', '', payload, signal, cwd)
    publish(agent, ran.notes)
    const blocking = ran.decoded.find(item => item.result.continue === false)
    if (blocking) return
    const again = ran.decoded.find(item => (item.result.decision === 'deny' || item.result.additionalContext) && !item.result.failure)
    if (!again) return
    continuations.set(turn, count + 1)
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: `${MARK}stop hook: ${again.result.reason || again.result.additionalContext}` }],
      source: { kind: 'plugin', plugin: 'rust-acp-hooks' },
    }))
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const payload = basePayload(agent, 'SessionEnd', loadPolicy())
    payload.reason = 'shutdown'
    runMatched(registry, 'SessionEnd', 'shutdown', payload, AbortSignal.timeout(1500), cwd)
      .catch(() => {})
  })
}
