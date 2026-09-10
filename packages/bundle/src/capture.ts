/**
 * Run one subprocess and capture everything it printed.
 *
 * Used by `!` lines, `/update`, and `/diff` — process-facing I/O that the
 * surface must not reimplement per call site.
 * @module codsh-bundle/src/capture
 */

import { spawn } from 'node:child_process'

/** A subprocess's captured outcome: merged output and how it ended. */
export interface Captured {
  /** stdout and stderr merged in arrival order. */
  output: string
  /** Exit code, or null when a signal ended it. */
  code: number | null
  /** The killing signal, or null when it exited. */
  signal: NodeJS.Signals | null
}

/**
 * Run one subprocess and capture everything it printed.
 * @param file - the executable, or a shell when `shell` is given.
 * @param args - its arguments.
 * @param options - working directory, abort wiring, and an optional kill timer.
 * @returns the merged output and exit status; spawn failures come back as a
 *   nonzero code with the error message as output.
 */
export function capture(
  file: string,
  args: readonly string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number; onLine?: (line: string) => void },
): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let pending = ''
    const take = (chunk: Buffer | string): void => {
      const text = chunk.toString().replaceAll('\r\n', '\n').replaceAll('\r', '\n')
      output += text
      if (options.onLine === undefined) return
      pending += text
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const line of parts) options.onLine(line)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => { child.kill('SIGTERM') }, options.timeoutMs)
    const onAbort = (): void => { child.kill('SIGTERM') }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      resolve({ output: error.message, code: 127, signal: null })
    })
    child.on('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (pending !== '' && options.onLine !== undefined) options.onLine(pending)
      resolve({ output, code, signal })
    })
  })
}
