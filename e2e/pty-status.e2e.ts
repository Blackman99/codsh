/** Context occupancy in the real terminal status row, including session switches. */
import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { PTY_ROWS, drivePtySteps, screenOf } from './pty-driver.ts'
import { ENTER } from './pty-helpers.ts'

describe.skipIf(process.platform === 'win32')('context in the status row (real PTY)', () => {
  it.each([60, 120])('keeps context visible across /status, /clear, /resume, and /model at %i columns', async columns => {
    const run = await drivePtySteps('context', [
      ['Welcome to codsh', `measure context${ENTER}`, 300],
      ['CONTEXT_REPLY_OK', `/status${ENTER}`, 400],
      ['next request', `/clear${ENTER}`, 400],
      ['new session session-', `/resume${ENTER}`, 400],
      ['Resume session', ENTER, 400],
      ['resumed session-', `/model cli-mock/cli-mock-pro${ENTER}`, 400],
      ['model cli-mock/cli-mock-pro', `measure new model${ENTER}`, 400],
      ['CONTEXT_REPLY_OK', `/exit${ENTER}`, 400],
    ], { columns, timeoutMs: 60_000 })
    const rowsAt = (step: number): string[] => screenOf(
      Buffer.from(run.output).subarray(0, run.offsets[step]).toString(), -1, PTY_ROWS, columns,
    ).alternate
    const footerAt = (step: number): string => rowsAt(step).slice(-3).join('\n')

    expect(footerAt(0)).not.toContain('context ')
    expect(footerAt(1)).toContain('context 32k/128k (75% left)')
    expect(footerAt(2)).toContain('context 32k/128k (75% left)')
    expect(rowsAt(2).join('\n')).toContain('32k of 128k (75% left)')
    expect(footerAt(3)).not.toContain('context ')
    expect(footerAt(5)).toContain('context 32k/128k (75% left)')
    expect(footerAt(7)).toContain('context 32k/64k (50% left)')
    expect(footerAt(7)).toContain('cli-mock-pro')
    for (let step = 0; step < run.offsets.length; step += 1) {
      for (const row of rowsAt(step)) expect(row.length).toBeLessThanOrEqual(columns)
    }
  }, E2E_TEST_TIMEOUT_MS)
})
