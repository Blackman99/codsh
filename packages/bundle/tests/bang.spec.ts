/**
 * `!` shell helpers: which binary to run, and how an interactive session ends.
 */

import { describe, expect, it } from 'vitest'
import { userShell } from '../src/bang.ts'

describe('userShell', () => {
  it('prefers SHELL, then a platform fallback', () => {
    const shell = userShell()
    expect(shell.length).toBeGreaterThan(0)
    if (process.env['SHELL'] !== undefined) expect(shell).toBe(process.env['SHELL'])
  })
})
