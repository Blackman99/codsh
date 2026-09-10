/**
 * Subprocess capture: merged output, exit, abort, and line streaming.
 */

import { describe, expect, it } from 'vitest'
import { capture } from '../src/capture.ts'

describe('capture', () => {
  it('merges stdout and reports a zero exit', async () => {
    const result = await capture(process.execPath, ['-e', 'process.stdout.write("hi\\n")'], { cwd: process.cwd() })
    expect(result.output).toBe('hi\n')
    expect(result.code).toBe(0)
    expect(result.signal).toBeNull()
  })

  it('streams complete lines as they arrive and keeps a trailing fragment for close', async () => {
    const lines: string[] = []
    const result = await capture(process.execPath, ['-e', 'process.stdout.write("a\\nb")'], {
      cwd: process.cwd(),
      onLine: line => { lines.push(line) },
    })
    expect(lines).toEqual(['a', 'b'])
    expect(result.output).toBe('a\nb')
  })

  it('returns 127 when the executable cannot be spawned', async () => {
    const result = await capture('/no/such/codsh-capture-bin', [], { cwd: process.cwd() })
    expect(result.code).toBe(127)
    expect(result.output.length).toBeGreaterThan(0)
  })

  it('kills the child when the signal aborts', async () => {
    const running = new AbortController()
    const pending = capture(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
      cwd: process.cwd(),
      signal: running.signal,
    })
    running.abort()
    const result = await pending
    expect(result.code === null || result.signal !== null || result.code !== 0).toBe(true)
  })
})
