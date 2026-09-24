/**
 * Apply one plain-automation tool mask before the first model request, and
 * one step bound inside the released dsh agent loop.
 * CODSH_PLAIN_TOOLS is "allow:read,grep", "deny:edit", or both joined by ";".
 * When both are set, deny wins. Public ids (read_file, Bash, Agent) map to
 * the dsh tool name. Agent denies every subagent. Agent(type) is refused:
 * the released tool has no type argument, and ticket 172 owns that filter.
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

function scopedAgentFilter(name) {
  return name.startsWith('Agent(') && name.endsWith(')') && name.length > 'Agent()'.length
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
    for (const name of names) {
      if (scopedAgentFilter(name)) {
        // Ticket 172 owns per-type filters. The released subagent tool has
        // no type argument, so storing the name would leave the call allowed.
        throw new Error(
          `plain tool filter cannot apply ${name}; subagent types are not available until a later ticket. Use Agent to deny every subagent`,
        )
      }
      if (name === 'Agent' || name.toLowerCase() === 'agent') {
        if (mode !== 'deny') throw new Error('plain tool filter cannot allow Agent')
        denySubagent = true
        continue
      }
      target.push(canonicalTool(name))
    }
  }
  if (denySubagent && !deny.includes('subagent')) deny.push('subagent')
  if (allow.length === 0 && deny.length === 0) return null
  return { allow, deny }
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
  if (filter.deny.includes(canonical) || filter.deny.includes(name)) {
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

export function apply(ctx) {
  const filter = parseTools(process.env.CODSH_PLAIN_TOOLS)
  const maxTurns = parseMaxTurns(process.env.CODSH_PLAIN_MAX_TURNS)
  if (!filter && maxTurns === null) return
  if (filter) {
    // One deny, prepended so it runs before the permission listener. restrict()
    // hides the tool from the schema; this stops a call that still arrives.
    ctx.on('tools/pre-execute', async (exec, next) => {
      const reason = removedReason(filter, exec.name)
      if (reason) return { kind: 'deny', reason }
      return next()
    }, true)
  }
  ctx.on('agent/created', ({ agent }) => {
    let refused = ''
    if (filter) {
      try {
        // Registered names exist once the agent is announced. assemble() reads
        // this view, so the first request must not wait for agent/pre-step.
        if (filter.allow.length > 0) agent.ctx.tools.restrict({ allow: filter.allow })
        if (filter.deny.length > 0) agent.ctx.tools.restrict({ deny: filter.deny })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        refused = `plain tool filter refused: ${message}`
        failClosed(agent, ctx, refused)
      }
    }
    if (maxTurns === null && !filter) return
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
