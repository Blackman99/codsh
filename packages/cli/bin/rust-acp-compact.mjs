/**
 * Drive dsh compaction from the isolated Rust ACP client.
 * `/compact` is intercepted before it becomes a model turn so dsh remains
 * the only history owner. Optional instructions are appended only to the
 * auxiliary summarizer request (purpose=compaction).
 */
export const name = 'rust-acp-compact'
export const inject = ['compaction', 'commands', 'llm']

const pendingInstruction = new Map()

function messageText(input) {
  const content = input?.content ?? input?.message?.content ?? []
  if (!Array.isArray(content)) return String(input?.text ?? '')
  return content
    .filter(block => block && block.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('')
}

export function parseCompactLine(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '/compact') return { instruction: '' }
  if (trimmed.startsWith('/compact ') || trimmed.startsWith('/compact\t')) {
    return { instruction: trimmed.slice('/compact'.length).trim() }
  }
  return null
}

export function compactFailureText(error) {
  const code = error?.code
  if (code === 'busy') {
    return 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.'
  }
  if (code === 'cancelled' || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return 'Compaction cancelled.'
  }
  if (code === 'changed') {
    return 'The history selected for compaction changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.'
  }
  if (code === 'summary') {
    return 'Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.'
  }
  if (code === 'commit') {
    return 'Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.'
  }
  if (code === 'persistence') {
    return 'Compaction finished, but the session could not be saved.'
  }
  const message = error?.message ?? String(error ?? 'compaction failed')
  return message
}

function parseWallClockSecs(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { secs: null, warning: null }
  }
  const trimmed = String(raw).trim()
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { secs: null, warning: null }
  }
  const secs = Number(trimmed)
  if (!Number.isFinite(secs) || secs < 0) {
    return { secs: null, warning: null }
  }
  if (secs === 0) return { secs: 0, warning: null }
  if (secs > 0 && secs < 5) {
    return {
      secs,
      warning: `GROK_COMPACTION_WALL_CLOCK_SECS=${secs} is a low positive budget and is used as-is rather than clamped`,
    }
  }
  return { secs, warning: null }
}

function compactSignal(wallClock) {
  if (typeof wallClock === 'number' && wallClock > 0 && typeof AbortSignal?.timeout === 'function') {
    return AbortSignal.timeout(wallClock * 1000)
  }
  return new AbortController().signal
}

function withInstruction(options, instruction) {
  if (!instruction || options?.purpose !== 'compaction') return options
  const extra = {
    role: 'user',
    content: [{
      type: 'text',
      text: `Additional compaction instruction from the user (not conversation history):\n${instruction}`,
    }],
  }
  return {
    ...options,
    messages: [...(options.messages ?? []), extra],
  }
}

export function apply(ctx) {
  const originalStream = ctx.llm.stream.bind(ctx.llm)
  ctx.llm.stream = options => {
    const instruction = pendingInstruction.get(options?.sessionId) ?? pendingInstruction.get('latest')
    return originalStream(withInstruction(options, instruction))
  }

  ctx.on('agent/created', ({ agent }) => {
    const originalFollowup = agent.followup.bind(agent)
    agent.followup = input => {
      const parsed = parseCompactLine(messageText(input))
      if (parsed === null) return originalFollowup(input)
      const sessionId = agent.session?.id ?? agent.id
      if (parsed.instruction) pendingInstruction.set(sessionId, parsed.instruction)
      pendingInstruction.set('latest', parsed.instruction)
      const wall = parseWallClockSecs(process.env.GROK_COMPACTION_WALL_CLOCK_SECS)
      if (wall.warning) ctx.logger.warn(wall.warning)
      const timeoutSecs = wall.secs && wall.secs > 0 ? wall.secs : null
      const clear = () => {
        pendingInstruction.delete(sessionId)
        pendingInstruction.delete('latest')
      }
      // Never return the compactNow promise: dsh-acp calls followup without
      // awaiting, and an unhandled rejection tears the ACP child down.
      try {
        const operation = ctx.compaction.compactNow(agent, compactSignal(timeoutSecs))
        Promise.resolve(operation).catch(error => {
          ctx.logger.warn(`rust-acp-compact: ${compactFailureText(error)}`)
        }).finally(clear)
      } catch (error) {
        clear()
        ctx.logger.warn(`rust-acp-compact: ${compactFailureText(error)}`)
      }
    }
  })
}
