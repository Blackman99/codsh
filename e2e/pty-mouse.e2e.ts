/**
 * The pointer on a real terminal: a drag selecting in the box or the
 * transcript and copying on release, and a click placing the cursor across a
 * wrap.
 */

import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { LEAVE_ALT, PTY_ROWS, drivePty, drivePtySteps, finalScreen, screenOf } from './pty-driver.ts'
import { ENTER, ESCAPE, screenAt } from './pty-helpers.ts'

describe.skipIf(process.platform === 'win32')('mouse selection and copy (real PTY)', () => {
  it('selects text in the box with a drag and copies on release', async () => {
    const typed = 'hello world'
    const press = '\u001B[<0;8;{row:hello world}M'
    const drag = '\u001B[<32;16;{row:hello world}M'
    const release = '\u001B[<0;16;{row:hello world}m'
    const run = await drivePtySteps('write', [
      ['Welcome to codsh', typed, 500],
      ['hello world', `${press}${drag}${release}`, 400],
      // Home drops the span and Ctrl-K clears the line so /exit is a command,
      // not a replacement of the selected text.
      ['copied', `\u0001\u000B/exit${ENTER}`, 500],
    ], { rows: 16 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const after = captured(run.offsets[2])
    expect(after).toContain('\u001B[7m')
    const osc = /\u001B\]52;c;([A-Za-z0-9+/=]+)\u0007/.exec(after)
    expect(osc).not.toBeNull()
    const copied = Buffer.from(osc?.[1] ?? '', 'base64').toString('utf8')
    expect(copied.length).toBeGreaterThan(0)
    expect(typed).toContain(copied)
    expect(copied).not.toContain('\u001B')
    expect(copied).not.toContain('›')
  }, E2E_TEST_TIMEOUT_MS)

  it('puts the cursor where the box was clicked, across a wrap', async () => {
    // Narrow enough that one typed line takes two rows in the box. Clicking
    // the first row and typing proves the cursor went where the pointer did.
    const typed = 'alpha beta gamma delta epsilon zeta'
    const clickFirstRow = '\u001B[<0;10;{row:alpha}M\u001B[<0;10;{row:alpha}m'
    const run = await drivePtySteps('write', [
      ['Welcome to codsh', typed, 500],
      // The tail of the line is on the second row; `alpha` is on the first.
      ['zeta', clickFirstRow, 400],
      ['', 'X', 400],
      // Submitting empties the box, so the command after it is a command.
      ['', ENTER, 700],
      ['Edited 1 file', `/exit${ENTER}`, 500],
    ], { columns: 30, rows: 16 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const after = screenOf(captured(run.offsets[3]), -1, 16).alternate.join('\n')
    // The character landed inside the first row, not at the end of the line.
    expect(after).toContain('X')
    expect(after).not.toContain('zetaX')
  }, E2E_TEST_TIMEOUT_MS)

  it('selects with the mouse and copies on release', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      // Press at the top of the prompt-anchored turn, drag through its answer,
      // release: the gesture IS the copy — no keystroke follows it.
      ['CODE_CLI_CALL_OK', `${ESCAPE}[<0;1;1M${ESCAPE}[<32;60;6M${ESCAPE}[<32;120;12M${ESCAPE}[<0;120;12m`, 400],
      ['copied', `/exit${ENTER}`, 500],
    ])

    // The drag painted a reverse-video span.
    expect(output).toContain('\u001B[7m')
    // Release wrote the visible turn through OSC 52.
    const osc = /\u001B\]52;c;([A-Za-z0-9+/=]+)\u0007/.exec(output)
    expect(osc).not.toBeNull()
    const copied = Buffer.from(osc?.[1] ?? '', 'base64').toString('utf8')
    // Gutter `›` is paint, not copy: the turn is the prompt body + ToolCard line.
    expect(copied).toContain('create the note')
    expect(copied).toContain('● Edited 1 file')
    expect(copied).toContain('CODE_CLI_CALL_OK')
    // Plain text: the styling on screen stayed out of the clipboard.
    expect(copied).not.toContain('\u001B')
    // And the toast said so.
    const frame = screenAt(output, 'copied', 'last')
    expect(frame.alternate.some(row => /✓ copied \d+ lines/u.test(row))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

it('paints a command that is a script as rows, never outside one', async () => {
    const output = await drivePty('heredoc', [
      ['Welcome to codsh', `run it${ENTER}`, 300],
      ['Running 1 command', 'n', 400],
      ['CODE_CLI_CALL_DENIED', `/exit${ENTER}`, 400],
    ], { columns: 76, rows: 24 })

    // Inside the alternate screen every row is written at a position of its
    // own, so a raw newline is the surface painting outside one: the rest of
    // the row lands at column 1 of the row below, and that row — a box border,
    // say — is one the frame diff considers unchanged, so nothing paints over
    // it again for the rest of the session. A real session lost the top of its
    // input box exactly that way, to a bash command that was a heredoc.
    const held = output.slice(output.indexOf('\u001B[?1049h'), output.indexOf(LEAVE_ALT))
    expect(held).not.toContain('\n')

    // The landing screen carries the call as a single row naming the command,
    // and the script body is never painted as its own rows.
    const done = finalScreen(output).alternate
    expect(done.some(row => row.includes('python3'))).toBe(true)
    expect(done.some(row => /│ import re$/u.test(row.trimEnd()))).toBe(false)
    expect(done.some(row => row.includes("print('patched')"))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('copies a drag that leaves the transcript and is released over the input box', async () => {
    const bottom = String(PTY_ROWS)
    const output = await drivePty('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      // Press on the first row and sweep down past the last line, letting go on
      // the bottom row — the way a person selects everything on screen. The
      // rows below the transcript belong to the chrome, but the gesture belongs
      // to the viewport that anchored it.
      [
        'CODE_CLI_CALL_OK',
        `${ESCAPE}[<0;1;1M${ESCAPE}[<32;60;20M${ESCAPE}[<32;120;${bottom}M${ESCAPE}[<0;120;${bottom}m`,
        400,
      ],
      ['copied', `/exit${ENTER}`, 500],
    ])

    const osc = /\u001B\]52;c;([A-Za-z0-9+/=]+)\u0007/.exec(output)
    expect(osc).not.toBeNull()
    const copied = Buffer.from(osc?.[1] ?? '', 'base64').toString('utf8')
    expect(copied).toContain('create the note')
    expect(copied).toContain('● Edited 1 file')
    expect(copied).toContain('CODE_CLI_CALL_OK')
  }, E2E_TEST_TIMEOUT_MS)
})
