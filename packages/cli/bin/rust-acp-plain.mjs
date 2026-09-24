/**
 * Apply one plain-automation tool mask and step bound inside the released
 * dsh agent loop. CODSH_PLAIN_TOOLS is "allow:read,grep" or "deny:bash".
 * CODSH_PLAIN_MAX_TURNS is a positive step bound. dsh calls one model step
 * `step`; the listener cancels before that step's model request. This is not
 * a second agent loop and does not count printed lines.
 */
export const name = 'rust-acp-plain'
export const inject = ['tools']

function parseTools(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const split = text.indexOf(':')
  if (split <= 0) throw new Error('CODSH_PLAIN_TOOLS must be allow:<names> or deny:<names>')
  const mode = text.slice(0, split)
  const names = text.slice(split + 1).split(',').map(name => name.trim()).filter(Boolean)
  if ((mode !== 'allow' && mode !== 'deny') || names.length === 0) {
    throw new Error('CODSH_PLAIN_TOOLS must be allow:<names> or deny:<names>')
  }
  return { mode, names }
}

function parseMaxTurns(raw) {
  if (raw === undefined || String(raw).trim() === '') return null
  if (!/^[1-9]\d*$/.test(String(raw).trim())) {
    throw new Error('CODSH_PLAIN_MAX_TURNS must be a positive integer')
  }
  return Number(String(raw).trim())
}

export function apply(ctx) {
  const filter = parseTools(process.env.CODSH_PLAIN_TOOLS)
  const maxTurns = parseMaxTurns(process.env.CODSH_PLAIN_MAX_TURNS)
  if (!filter && maxTurns === null) return
  if (filter) {
    const hidden = new Set(filter.names)
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (filter.mode === 'deny' && hidden.has(exec.name)) {
        return { kind: 'deny', reason: `plain tool filter removed ${exec.name}` }
      }
      if (filter.mode === 'allow' && !hidden.has(exec.name)) {
        return { kind: 'deny', reason: `plain tool filter did not allow ${exec.name}` }
      }
      return next()
    })
  }
  ctx.on('agent/created', ({ agent }) => {
    let applied = false
    agent.ctx.on('agent/pre-step', (payload, next) => {
      if (!applied && filter) {
        applied = true
        const mask = filter.mode === 'allow' ? { allow: filter.names } : { deny: filter.names }
        try {
          // Tools register while the agent starts. The first proposed step is
          // the public point where the global names are known.
          agent.ctx.tools.restrict(mask)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const reason = `plain tool filter refused: ${message}`
          agent.cancel({ kind: 'hook', reason })
          ctx.logger.error(reason)
          process.stderr.write(`${reason}\n`)
          return { kind: 'reject' }
        }
        const hidden = new Set(filter.names)
        agent.ctx.tools.guard(exec => {
          if (filter.mode === 'deny' && hidden.has(exec.name)) {
            return `plain tool filter removed ${exec.name}`
          }
          if (filter.mode === 'allow' && !hidden.has(exec.name)) {
            return `plain tool filter did not allow ${exec.name}`
          }
          return undefined
        })
      }
      if (maxTurns !== null && payload.step > maxTurns) {
        agent.cancel({
          kind: 'hook',
          reason: `stopped: agent step ${payload.step} exceeds --max-turns ${maxTurns}`,
        })
        return { kind: 'reject' }
      }
      return next()
    })
  })
}
