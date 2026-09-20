/**
 * Ask once before dsh write/edit tools execute. ACP forwards the ask as
 * session/request_permission; the Rust UI answers it. Reads are not gated.
 */
export const name = 'rust-acp-file-approval'

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'write' && exec.name !== 'edit') return next()
    const path = typeof exec.arguments?.file_path === 'string' ? exec.arguments.file_path : ''
    return {
      kind: 'ask',
      reason: path === '' ? exec.name : `${exec.name} ${path}`,
    }
  })
}
