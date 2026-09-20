/**
 * Ask once before dsh write/edit tools execute. ACP forwards the ask as
 * session/request_permission; the Rust UI answers it. Reads are not gated.
 * Optional DSH_CODE_CLI_TOOL_DELAY_MS parks around-dispatch so cancel can
 * land while a tool is running; the wait observes exec.signal.
 */
export const name = 'rust-acp-file-approval'

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

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'write' && exec.name !== 'edit') return next()
    const path = typeof exec.arguments?.file_path === 'string' ? exec.arguments.file_path : ''
    return {
      kind: 'ask',
      reason: path === '' ? exec.name : `${exec.name} ${path}`,
    }
  })
  ctx.on('tools/execute', async (exec, next) => {
    const delay = Number(process.env.DSH_CODE_CLI_TOOL_DELAY_MS ?? '0')
    if (delay > 0) await wait(delay, exec.signal)
    return next()
  })
}
