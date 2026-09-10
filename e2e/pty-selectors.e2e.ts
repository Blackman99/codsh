/**
 * Decisions on a real terminal: approvals answered by arrow, shortcut, and
 * never by a click; the model, folder, and completion selectors; plan mode;
 * and the approvals a project remembers.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS, makeHome } from './harness.ts'
import { drivePty, drivePtySteps, screenOf } from './pty-driver.ts'
import { ENTER, ESCAPE, screenAt } from './pty-helpers.ts'

describe.skipIf(process.platform === 'win32')('approvals and selectors (real PTY)', () => {
  it('puts an approval to the arrow keys and accepts on Enter', async () => {
    const output = await drivePty('bash', [
      ['Welcome to codsh', `run it${ENTER}`, 300],
      // The selector replaced the input box; Enter takes the marked default.
      ['Allow bash', ENTER, 400],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 400],
    ])

    // Styling survives rendering now, so the codes are stripped before matching.
    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    // The question names the command, not only the tool: the card that shows
    // it can be scrolled away or folded by the time the decision is asked.
    expect(plain).toContain('Allow bash: printf')
    expect(plain).toContain('❯ 1. Yes, this time (y)')
    expect(plain).toContain('2. Yes, every bash call this session (a)')
    expect(plain).toContain('[enter] take · [y] take · [esc] back')
    expect(plain).not.toContain('[n] abort')
    expect(plain).toContain('CODE_CLI_ROUND_TRIP')
  }, E2E_TEST_TIMEOUT_MS)

  it('denies an approval through its shortcut key', async () => {
    const output = await drivePty('bash', [
      ['Welcome to codsh', `run it${ENTER}`, 300],
      ['Allow bash', 'n', 400],
      ['CODE_CLI_CALL_DENIED', `/exit${ENTER}`, 400],
    ])

    expect(output).toContain('CODE_CLI_CALL_DENIED')
    expect(output).not.toContain('CODE_CLI_CALL_OK')
  }, E2E_TEST_TIMEOUT_MS)

  it('toggles plan mode with Shift-Tab, both ways', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `${ESCAPE}[Z`, 400],
      // The registry's bare /plan only ever enters; the second press must still
      // leave, or the key reads as broken.
      ['▲ plan mode', `${ESCAPE}[Z`, 500],
      ['▼ plan mode off', `/exit${ENTER}`, 400],
    ])

    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('▲ plan mode')
    expect(plain).toContain('▼ plan mode off')
    // Plan mode paints the frame with warn (amber on 256-color, bright yellow otherwise); idle focus uses accent cyan.
    expect(output).toMatch(/\u001B\[(?:38;5;172|93)m╭/)
    expect(output).toContain('\u001B[36m╭')
  }, E2E_TEST_TIMEOUT_MS)

  it('switches the model through the /model selector, all the way to the request', async () => {
    const output = await drivePty('write', [
      // Bare /model IS the request to pick one: the selector opens.
      ['Welcome to codsh', `/model${ENTER}`, 400],
      ['Switch model', `${ESCAPE}[B${ENTER}`, 500],
      // The pick is confirmed, and the next turn must be SERVED by it: the
      // mock names the model that answered, which is the only proof a switch
      // reached the request rather than only the display.
      ['model cli-mock/cli-mock-pro', `run it${ENTER}`, 400],
      ['via cli-mock-pro', `/exit${ENTER}`, 400],
    ])

    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('❯ 1. cli-mock/cli-mock')
    expect(plain).toContain('· current')
    expect(plain).toContain('model cli-mock/cli-mock-pro')
    expect(plain).toContain('via cli-mock-pro')
    // The status row reads the live selection.
    expect(plain).toContain('cli-mock-pro')
  }, E2E_TEST_TIMEOUT_MS)

  it('offers this folder first, and folds the other folders behind one row', async () => {
    // Two workspaces sharing one home, which is the only way sessions from
    // another checkout exist to be folded away.
    const home = await makeHome()
    // Short paths on purpose: a row is truncated to the window, and the
    // per-user temp root is long enough on macOS to cut the name off the end.
    const here = await mkdtemp('/tmp/codsh-here-')
    const away = await mkdtemp('/tmp/codsh-away-')
    try {
      await drivePty('write', [
        ['Welcome to codsh', `note the away work${ENTER}`, 500],
        ['Edited 1 file', `/exit${ENTER}`, 400],
      ], { cwd: away, env: { DSH_HOME: home } })

      // The surface prints the realpath, and macOS hands out /var for
      // /private/var; the directory's own name is what both forms carry.
      const awayName = basename(away)
      const run = await drivePtySteps('write', [
        ['Welcome to codsh', `note the local work${ENTER}`, 500],
        // /clear retires this session, so the folder has one to offer back.
        ['Edited 1 file', `/clear${ENTER}`, 500],
        ['new session session-', `/resume${ENTER}`, 700],
        // Filtering to the fold row is how it gets chosen without counting
        // arrow presses through a list whose length the test does not fix.
        ['Resume session', 'other folders', 500],
        ['in other folders', ENTER, 700],
        // Waiting for the other folder's own name IS the assertion: the row
        // was a door, and reaching this step at all means it opened.
        [awayName, '\u001B', 400],
        // Escape and the command go in separate writes: `ESC /` in one chunk
        // is an Alt chord, and the surface swallows it.
        ['Ask anything', `/exit${ENTER}`, 500],
      ], { cwd: here, env: { DSH_HOME: home } })

      const at = (index: number): string => screenOf(
        Buffer.from(run.output).subarray(0, run.offsets[index]).toString(), -1,
      ).alternate.join('\n')
      // Folded: this folder's session is offered, and the other folder is one
      // row rather than a row per session.
      const folded = at(4)
      expect(folded).toContain('in other folders')
      expect(folded).not.toContain(awayName)

      // Opened: the list that replaced it holds the other folder's session.
      expect(screenAt(run.output, awayName).alternate.join('\n')).toContain(awayName)
    } finally {
      await rm(here, { recursive: true, force: true })
      await rm(away, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)

  it('takes a selector row on a click, and marks the row under the pointer', async () => {
    // `/view` is the observable one: choosing a row opens the reader, so the
    // click either committed or it did not. The pointer rests on the SECOND
    // row, which the mark is not on — proving the click took the row under the
    // pointer rather than the row Enter would have taken.
    const overRow = '\u001B[<35;6;{row:const answer}M'
    const clickRow = '\u001B[<0;6;{row:const answer}M\u001B[<0;6;{row:const answer}m'
    const run = await drivePtySteps('markdown', [
      ['Welcome to codsh', `explain${ENTER}`, 400],
      ['CODE_CLI_CALL_STREAM_DONE', `/view${ENTER}`, 500],
      ['View content', overRow, 400],
      // No wait: the title is already on screen, and only the rows the hover
      // changed are repainted, so waiting for it again would wait forever.
      ['', clickRow, 600],
      ['Esc closes', '\u001B', 400],
      ['Ask anything', `/exit${ENTER}`, 400],
    ], { rows: 20 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const hovered = screenOf(captured(run.offsets[3]), -1, 20).alternate
    const marked = hovered.findIndex(row => row.includes('\u276F'))
    const under = hovered.findIndex(row => row.includes('const answer') && !row.includes('\u276F'))
    // Resting somewhere never moves the mark.
    expect(marked).toBeGreaterThanOrEqual(0)
    expect(under).toBeGreaterThanOrEqual(0)
    expect(marked).not.toBe(under)

    // And the reader that opened is the row the pointer was on, not the marked one.
    const opened = screenOf(captured(run.offsets[4]), -1, 20).alternate
    expect(opened[0]).toContain('Code 1:1')
  }, E2E_TEST_TIMEOUT_MS)

  it('takes a completion the pointer clicked, not the one the mark is on', async () => {
    // `/` opens the menu with the mark on its first row; the pointer takes a
    // different one, so the box proves which row the click meant.
    // The typed `/` is underlined on its own, so the raw stream never holds
    // `/compact` contiguously; the rest of the label does.
    const overRow = '\u001B[<35;6;{row:compact}M'
    const clickRow = '\u001B[<0;6;{row:compact}M\u001B[<0;6;{row:compact}m'
    const run = await drivePtySteps('write', [
      ['Welcome to codsh', '/', 500],
      ['compact', overRow, 400],
      // No wait: only the rows the hover changed are repainted.
      ['', clickRow, 500],
      ['', `\u0015/exit${ENTER}`, 500],
    ], { rows: 20 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const hovered = screenOf(captured(run.offsets[2]), -1, 20).alternate
    // The mark is on one row and the pointer's dot on another.
    expect(hovered.some(row => row.includes('\u276F'))).toBe(true)
    expect(hovered.some(row => row.includes('\u00B7 ') && row.includes('/compact'))).toBe(true)

    const taken = screenOf(captured(run.offsets[3]), -1, 20).alternate.join('\n')
    expect(taken).toContain('/compact')
  }, E2E_TEST_TIMEOUT_MS)

  it('turns the wheel on an open menu, without moving what Enter would take', async () => {
    // `/` offers more commands than the menu shows at once, so it has
    // somewhere to scroll to.
    const wheelDown = '\u001B[<65;10;{row:compact}M'.repeat(3)
    const run = await drivePtySteps('write', [
      ['Welcome to codsh', '/', 500],
      ['compact', wheelDown, 500],
      // Enter with a menu open finishes the word rather than submitting, so
      // the command it left has to be submitted before the box is free.
      ['', ENTER, 700],
      ['', ENTER, 700],
      ['new session session-', `/exit${ENTER}`, 500],
    ], { rows: 20 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const scrolled = screenOf(captured(run.offsets[2]), -1, 20).alternate.join('\n')
    // The window moved: the first command is no longer among the rows.
    expect(scrolled).not.toContain('/clear')
    // The mark did not, so Enter still finished the first command.
    const taken = screenOf(captured(run.offsets[3]), -1, 20).alternate.join('\n')
    expect(taken).toContain('/clear')
  }, E2E_TEST_TIMEOUT_MS)

  it('does not let a click answer an approval', async () => {
    // `bash` asks for a wider sandbox, which is the approval prompt. Granting
    // a tool for the session cannot be taken back, so the pointer is refused
    // there — and the run has to end with the keyboard answering.
    const clickAlways = '\u001B[<0;6;{row:every bash}M\u001B[<0;6;{row:every bash}m'
    const run = await drivePtySteps('bash', [
      ['Welcome to codsh', `run it${ENTER}`, 600],
      ['Allow bash', clickAlways, 600],
      // Still asking: the click decided nothing.
      ['', 'n', 600],
      ['', `/exit${ENTER}`, 500],
    ], { rows: 20 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const afterClick = screenOf(captured(run.offsets[2]), -1, 20).alternate
    // The question is still on screen, and no row wears the pointer's mark.
    expect(afterClick.join('\n')).toContain('Allow bash')
    expect(afterClick.some(row => row.trimStart().startsWith('\u00B7'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)
})

describe.skipIf(process.platform === 'win32')('remembered approvals (real PTY)', () => {
  it('remembers a command prefix for the project, and honours it in a later process', async () => {
    // A fixed workspace: the rule file written by the first process is what
    // the second one has to read.
    const cwd = await mkdtemp(join(tmpdir(), 'codsh-rules-'))
    try {
      const first = await drivePty('bash', [
        ['Welcome to codsh', `run it${ENTER}`, 300],
        // The third answer writes `bash(printf *)` to the project's personal rule file.
        ['Allow bash', 'd', 400],
        // The same command again: the rule answers, nobody is asked.
        ['CODE_CLI_CALL_OK', `run it${ENTER}`, 400],
        ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 400],
      ], { cwd })
      const plain = first.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
      expect(plain).toContain("3. Yes, and don't ask again for bash(printf *) in this project (d)")
      expect(plain).toContain('allowing bash(printf *) from now on · .dsh/permissions.local.json')
      // Nothing asked after the first answer: the second call reports its rule instead.
      const afterFirstAnswer = plain.slice(plain.indexOf('from now on'))
      expect(afterFirstAnswer).not.toContain('Allow bash')
      expect(afterFirstAnswer).toContain('allowed by bash(printf *)')
      const written = JSON.parse(await readFile(join(cwd, '.dsh', 'permissions.local.json'), 'utf8')) as { allow: string[] }
      expect(written.allow).toEqual(['bash(printf *)'])

      const second = await drivePty('bash', [
        ['Welcome to codsh', `run it${ENTER}`, 300],
        ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 400],
      ], { cwd })
      expect(second).not.toContain('Allow bash')
      expect(second).toContain('allowed by bash(printf *)')
      expect(second).toContain('CODE_CLI_ROUND_TRIP')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)
})
