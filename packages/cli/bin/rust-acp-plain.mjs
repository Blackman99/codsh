/**
 * Apply one plain-automation tool mask before the first model request, and
 * one step bound inside the released dsh agent loop.
 * CODSH_PLAIN_TOOLS is "allow:read,grep", "deny:edit", or both joined by ";".
 * When both are set, deny wins. Public ids (read_file, Bash, Agent) map to
 * the dsh tool name. Agent denies every subagent spawn tool dsh registered
 * (subagent and subagent_fork) and the workflow tool, whose only effect is
 * starting subagents (ticket 181). Agent(type), in any letter case, is refused
 * here: the Rust client turns `--disallowed-tools Agent(type)` into the
 * subagent policy (rust-acp-subagents.mjs) and never puts a typed entry in
 * CODSH_PLAIN_TOOLS, so one arriving here (say, inherited) cannot be honored.
 * A refused or malformed value, including one inherited from a parent
 * process, cancels the agent before its first model request.
 * CODSH_DISABLE_WEB_TOOLS=1 (--disable-web-search) drops the registered
 * web_search and web_fetch tools from every agent.
 * CODSH_PLAIN_MAX_TURNS is a positive step bound. dsh
 * calls one model step `step`; the listener cancels before step N+1. This
 * is not a second agent loop and does not count printed lines.
 */
export const name = 'rust-acp-plain'
export const inject = ['tools']

/** Public headless ids and permission prefixes, mapped onto registered dsh tools. */
const TOOL_ALIASES = new Map([
  ['read', 'read'],
  ['read_file', 'read'],
  ['write', 'write'],
  ['edit', 'edit'],
  ['search_replace', 'edit'],
  ['strreplace', 'edit'],
  ['str_replace_editor', 'str_replace_editor'],
  ['bash', 'bash'],
  ['run_terminal_cmd', 'bash'],
  ['grep', 'grep'],
  ['glob', 'glob'],
  ['list_dir', 'glob'],
  ['web_search', 'web_search'],
  ['websearch', 'web_search'],
  ['web_fetch', 'web_fetch'],
  ['webfetch', 'web_fetch'],
  ['agent', 'subagent'],
  ['task', 'subagent'],
])

function canonicalTool(name) {
  const text = String(name ?? '').trim()
  if (!text) return text
  const mapped = TOOL_ALIASES.get(text.toLowerCase())
  return mapped ?? text
}

/**
 * Spawn tools behind the public Agent id. Only registered ones are masked.
 * `workflow` starts subagents from a script, so denying Agent removes it too.
 */
const SUBAGENT_TOOLS = ['subagent', 'subagent_fork', 'workflow']
const WEB_TOOLS = ['web_search', 'web_fetch']

/** Any `agent(` prefix, any case: `Agent()`, `agent(explore)`, and the pieces of `Agent(explore, plan)`. */
function scopedAgentFilter(name) {
  return name.trim().toLowerCase().startsWith('agent(')
}

/** The typed entry as written, rejoining `Agent(explore, plan)` after the comma split. */
function typedEntry(names, first) {
  if (names[first].includes(')')) return names[first]
  const close = names.findIndex((name, index) => index > first && name.includes(')'))
  return close < 0 ? names[first] : names.slice(first, close + 1).join(', ')
}

function parseTools(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const allow = []
  const deny = []
  let denySubagent = false
  for (const clause of text.split(';').map(part => part.trim()).filter(Boolean)) {
    const split = clause.indexOf(':')
    if (split <= 0) throw new Error('CODSH_PLAIN_TOOLS must be allow:<names> and/or deny:<names>')
    const mode = clause.slice(0, split)
    const names = clause.slice(split + 1).split(',').map(name => name.trim()).filter(Boolean)
    if ((mode !== 'allow' && mode !== 'deny') || names.length === 0) {
      throw new Error('CODSH_PLAIN_TOOLS must be allow:<names> and/or deny:<names>')
    }
    const target = mode === 'allow' ? allow : deny
    const typed = names.findIndex(scopedAgentFilter)
    if (typed >= 0) {
      // Per-type filters live in the subagent policy (ticket 172). This
      // mask has no type argument, so storing the name would leave the
      // call allowed.
      throw new Error(
        `plain tool filter cannot apply ${typedEntry(names, typed)}; subagent types belong to the subagent policy. Pass --disallowed-tools ${typedEntry(names, typed)} to codsh --rust, or use Agent to deny every subagent`,
      )
    }
    for (const name of names) {
      if (name.toLowerCase() === 'agent') {
        if (mode !== 'deny') throw new Error('plain tool filter cannot allow Agent')
        denySubagent = true
        continue
      }
      target.push(canonicalTool(name))
    }
  }
  if (allow.length === 0 && deny.length === 0 && !denySubagent) return null
  return { allow, deny, denySubagent }
}

/** Tool names this agent's registry can restrict: registered globally. */
function registered(agent, names) {
  return names.filter(name => {
    try {
      return Boolean(agent.ctx.tools.get(name))
    } catch {
      return false
    }
  })
}

function parseMaxTurns(raw) {
  if (raw === undefined || String(raw).trim() === '') return null
  if (!/^[1-9]\d*$/.test(String(raw).trim())) {
    throw new Error('CODSH_PLAIN_MAX_TURNS must be a positive integer')
  }
  return Number(String(raw).trim())
}

function removedReason(filter, name) {
  const canonical = canonicalTool(name)
  if (filter.deny.includes(canonical) || filter.deny.includes(name)
    || (filter.denySubagent && SUBAGENT_TOOLS.includes(name))) {
    return `plain tool filter removed ${name}`
  }
  if (filter.allow.length > 0 && !filter.allow.includes(canonical) && !filter.allow.includes(name)) {
    return `plain tool filter removed ${name}`
  }
  return ''
}

function failClosed(agent, ctx, reason) {
  agent.cancel({ kind: 'hook', reason })
  ctx.logger.error(reason)
  process.stderr.write(`${reason}\n`)
}

function readEnv() {
  try {
    return {
      filter: parseTools(process.env.CODSH_PLAIN_TOOLS),
      maxTurns: parseMaxTurns(process.env.CODSH_PLAIN_MAX_TURNS),
      error: '',
    }
  } catch (error) {
    // A throw here would abort plugin load and leave dsh with no mask at
    // all. Keep the refusal and cancel every agent before its first step.
    const message = error instanceof Error ? error.message : String(error)
    return { filter: null, maxTurns: null, error: message }
  }
}

export function apply(ctx) {
  const { filter, maxTurns, error } = readEnv()
  const dropWeb = process.env.CODSH_DISABLE_WEB_TOOLS === '1'
  if (!filter && maxTurns === null && !error && !dropWeb) return
  if (filter || dropWeb) {
    // One deny, prepended so it runs before the permission listener. restrict()
    // hides the tool from the schema; this stops a call that still arrives.
    ctx.on('tools/pre-execute', async (exec, next) => {
      const reason = filter ? removedReason(filter, exec.name) : ''
      if (reason) return { kind: 'deny', reason }
      if (dropWeb && WEB_TOOLS.includes(exec.name)) {
        return { kind: 'deny', reason: `--disable-web-search removed ${exec.name}` }
      }
      return next()
    }, true)
  }
  ctx.on('agent/created', ({ agent }) => {
    let refused = error ? (error.startsWith('plain tool filter') ? error : `plain tool filter refused: ${error}`) : ''
    if (refused) {
      failClosed(agent, ctx, refused)
    } else if (filter || dropWeb) {
      try {
        // Registered names exist once the agent is announced. assemble() reads
        // this view, so the first request must not wait for agent/pre-step.
        // restrict() rejects an unregistered name, so the Agent and web
        // groups mask only what dsh registered; a user-named tool still must exist.
        const deny = [...(filter?.deny ?? [])]
        if (filter?.denySubagent) deny.push(...registered(agent, SUBAGENT_TOOLS))
        if (dropWeb) deny.push(...registered(agent, WEB_TOOLS))
        const unique = [...new Set(deny)]
        if (filter && filter.allow.length > 0) agent.ctx.tools.restrict({ allow: filter.allow })
        if (unique.length > 0) agent.ctx.tools.restrict({ deny: unique })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        refused = `plain tool filter refused: ${message}`
        failClosed(agent, ctx, refused)
      }
    }
    if (maxTurns === null && !refused) return
    agent.ctx.on('agent/pre-step', (payload, next) => {
      if (refused) {
        failClosed(agent, ctx, refused)
        return { kind: 'reject' }
      }
      // dsh step is the model step. N allows steps 1..N and stops before N+1.
      if (maxTurns !== null && payload.step > maxTurns) {
        const reason = `stopped: agent step ${payload.step} exceeds --max-turns ${maxTurns}`
        failClosed(agent, ctx, reason)
        return { kind: 'reject' }
      }
      return next()
    })
  })
}
