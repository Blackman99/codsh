/**
 * The experience checklist: what a person notices in the first five minutes,
 * asserted at the screen level before a person has to.
 *
 * Every entry here started life as a real complaint — a menu that hid its
 * tail, a wheel that scrolled backwards, a clock that reset per step, a
 * flickering hint row, a bare welcome, a wall of output. The suite exists so
 * the NEXT change to rendering or input fails here first.
 */

import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import {
  PTY_COLUMNS,
  PTY_ROWS,
  SYNC_END,
  drivePty,
  drivePtySteps,
  finalScreen,
  screenOf,
  screenAt,
  screenAtLast,
} from './pty-driver.ts'
import { Terminal } from './vt.ts'

/** Submit what the box holds. */
const ENTER = '\r'

describe.skipIf(process.platform === 'win32')('the first five minutes', () => {
  it('welcomes with the lettermark at the TOP of the screen', async () => {
    const output = await drivePty('write', [
      // The box appearing is the settled first frame; the welcome precedes it.
      ['Ask anything', `/exit${ENTER}`, 400],
    ])
    const rows = screenAt(output, 'Ask anything').alternate
    const logoRow = rows.findIndex(row => row.includes('█') || row.includes('▀') || row.includes('▄'))
    expect(logoRow).toBeGreaterThanOrEqual(0)
    expect(logoRow).toBeLessThan(8)
    // The gap sits between the welcome and the chrome, not above the welcome.
    expect(rows.slice(-4).some(row => row.trimStart().startsWith('╭'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('shows the welcome again after /clear', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', `/clear${ENTER}`, 400],
      ['new session', `/exit${ENTER}`, 500],
    ])
    const rows = screenAt(output, 'new session').alternate
    // The fresh session greets like the first one did, and the old turn is gone.
    expect(rows.some(row => row.includes('✻ Welcome to codsh'))).toBe(true)
    expect(rows.some(row => row.includes('Write note.txt'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('keeps the selected completion visible however far the arrows go', async () => {
    // Tab far past the first page of commands; the marked row must follow.
    const output = await drivePty('write', [
      ['Welcome to codsh', '/', 300],
      ['/exit', '\t\t\t\t\t\t\t\t\t\t', 400],
      ['', `/exit${ENTER}`, 600],
    ])
    const frames = output.split(SYNC_END)
    // In every frame that shows a menu, the marked row is on screen.
    const probe = new Terminal(PTY_ROWS, PTY_COLUMNS)
    let markedSeen = 0
    for (const frame of frames) {
      probe.feed(frame + SYNC_END)
      const screen = probe.alternate.join('\n')
      if (screen.includes('❯ /')) markedSeen += 1
    }
    expect(markedSeen).toBeGreaterThan(5)
  }, E2E_TEST_TIMEOUT_MS)

  it('scrolls back with wheel-up, gently, and says how far', async () => {
    const wheelUp = '\u001B[<64;10;10M'.repeat(4)
    // A tall result, so the transcript genuinely overflows the viewport.
    const output = await drivePty('tall', [
      ['Welcome to codsh', `make it tall${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', wheelUp, 600],
      ['rows above', `/exit${ENTER}`, 500],
    ])
    const scrolled = screenAt(output, 'rows above')
    const text = scrolled.alternate.join('\n')
    // Four wheel events, one row each: gentle, and away from the tail it says so.
    expect(text).toMatch(/↑ \d+ rows above/u)
    const distance = Number(/↑ (\d+) rows above/u.exec(text)?.[1] ?? '0')
    expect(distance).toBeGreaterThan(0)
    expect(distance).toBeLessThanOrEqual(4)
  }, E2E_TEST_TIMEOUT_MS)

  it('keeps the owning prompt above each turn while scrolling across the boundary', async () => {
    const rows = 12
    const wheelUp = '\u001B[<64;10;5M'
    const wheelDown = '\u001B[<65;10;5M'
    const output = await drivePty('sticky', [
      ['Welcome to codsh', `first sticky prompt${ENTER}`, 300],
      ['STICKY_FIRST_44', `second sticky prompt${ENTER}`, 500],
      ['51 tokens', wheelUp.repeat(36), 500],
      ['↑ 36 rows above', wheelUp.repeat(12), 300],
      ['↑ 48 rows above', wheelDown.repeat(48), 300],
      ['STICKY_SECOND_DONE', `/exit${ENTER}`, 300],
    ], { rows })
    const tail = screenAt(output, '51 tokens', rows).alternate
    const browsing = screenAt(output, '↑ 36 rows above', rows).alternate
    const crossed = screenAt(output, '↑ 48 rows above', rows).alternate
    const returned = screenAtLast(output, 'STICKY_SECOND_DONE', rows).alternate

    expect(tail[0]).toContain('second sticky prompt')
    expect(tail[0]?.at(-1)).toBe('·')
    expect(tail[1]?.at(-1)).toBe('●')
    expect(browsing[0]).toContain('second sticky prompt')
    expect(crossed[0]).toContain('first sticky prompt')
    expect(crossed[0]?.at(-1)).toBe('●')
    expect(crossed[1]?.at(-1)).toBe('·')
    expect(crossed.join('\n')).toContain('↑ 48 rows above')
    expect(returned[0]).toContain('second sticky prompt')
    expect(crossed.slice(-2)).toEqual(tail.slice(-2))
  }, E2E_TEST_TIMEOUT_MS)

  it('keeps both explicit user lines in the sticky header', async () => {
    const shiftEnter = '\u001B[13;2u'
    const run = await drivePtySteps('sticky', [
      ['Welcome to codsh', `你好${shiftEnter}介绍下你自己${ENTER}`, 300],
      ['STICKY_FIRST_44', `/exit${ENTER}`, 500],
    ], { rows: 12 })

    const settled = screenOf(Buffer.from(run.output).subarray(0, run.offsets[1]).toString(), -1, 12).alternate
    expect(settled[0]).toContain('你好')
    expect(settled[1]).toContain('介绍下你自己')
  }, E2E_TEST_TIMEOUT_MS)

  it('anchors a submitted prompt while streamed reply rows fill beneath it', async () => {
    const run = await drivePtySteps('anchor', [
      ['Welcome to codsh', `anchor this prompt${ENTER}`, 100],
      ['ANCHOR_REPLY_1', '', 0],
      ['ANCHOR_REPLY_3', '', 0],
      ['ANCHOR_REPLY_8', '', 0],
      ['ANCHOR_REPLY_12', `/exit${ENTER}`, 300],
    ], { rows: 12 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const first = screenOf(captured(run.offsets[1]), -1, 12).alternate
    const filling = screenOf(captured(run.offsets[2]), -1, 12).alternate
    const sticky = screenOf(captured(run.offsets[3]), -1, 12).alternate
    expect(first[0]).toContain('anchor this prompt')
    expect(first.join('\n')).toContain('ANCHOR_REPLY_1')
    expect(filling[0]).toContain('anchor this prompt')
    expect(filling.join('\n')).toContain('ANCHOR_REPLY_3')
    expect(sticky[0]).toContain('anchor this prompt')
    expect(sticky.filter(row => row.includes('anchor this prompt'))).toHaveLength(1)
    expect(first.findIndex(row => row.includes('Ask anything'))).toBe(filling.findIndex(row => row.includes('Ask anything')))
    expect(first.at(-1)).toBe(filling.at(-1))
  }, E2E_TEST_TIMEOUT_MS)

  it('previews and clicks the timeline rail, then clears the preview on mouse-out', async () => {
    const moveRail = '\u001B[<35;120;1M'
    const clickRail = '\u001B[<0;120;1M\u001B[<0;120;1m'
    const moveAway = '\u001B[<35;10;6M'
    const run = await drivePtySteps('sticky', [
      ['Welcome to codsh', `first sticky prompt${ENTER}`, 300],
      ['STICKY_FIRST_44', `second sticky prompt${ENTER}`, 500],
      ['51 tokens', moveRail, 300],
      ['first sticky prompt', clickRail, 300],
      ['first sticky prompt', moveAway, 300],
      ['', `/exit${ENTER}`, 400],
    ], { rows: 12 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const preview = screenOf(captured(run.offsets[3]), -1, 12).alternate.join('\n')
    const clicked = screenOf(captured(run.offsets[4]), -1, 12).alternate
    const cleared = screenOf(captured(run.offsets[5]), -1, 12).alternate.join('\n')
    const occurrences = (text: string): number => text.split('first sticky prompt').length - 1
    expect(occurrences(preview)).toBe(1)
    expect(occurrences(clicked.join('\n'))).toBe(2)
    expect(clicked[0]?.at(-1)).toBe('●')
    expect(occurrences(cleared)).toBe(1)
  }, E2E_TEST_TIMEOUT_MS)

  it('jumps between real user turns with shifted horizontal arrows', async () => {
    const shiftLeft = '\u001B[1;2D'
    const shiftRight = '\u001B[1;2C'
    const run = await drivePtySteps('sticky', [
      ['Welcome to codsh', `first sticky prompt${ENTER}`, 300],
      ['STICKY_FIRST_44', `second sticky prompt${ENTER}`, 500],
      ['51 tokens', shiftLeft, 500],
      ['', shiftRight, 400],
      ['', `/exit${ENTER}`, 400],
    ], { rows: 12 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const previous = screenOf(captured(run.offsets[3]), -1, 12).alternate
    const next = screenOf(captured(run.offsets[4]), -1, 12).alternate
    expect(previous.join('\n')).toContain('first sticky prompt')
    expect(next.join('\n')).toContain('second sticky prompt')
  }, E2E_TEST_TIMEOUT_MS)

  it('previews /jump choices, restores after resize, and keeps the committed turn', async () => {
    const wheelUp = '\u001B[<64;10;5M'.repeat(8)
    const run = await drivePtySteps('sticky', [
      ['Welcome to codsh', `first sticky prompt${ENTER}`, 300],
      ['STICKY_FIRST_44', `second sticky prompt${ENTER}`, 500],
      ['51 tokens', wheelUp, 300],
      ['rows above', `/jump${ENTER}`, 300],
      ['Jump to turn', '\u001B[B', 300],
      ['', '@WINSZ:12x20', 400],
      ['Jump to turn', '\u001B', 500],
      ['', `/jump${ENTER}`, 300],
      ['Jump to turn', '\u001B[B', 300],
      ['', ENTER, 500],
      ['', `/exit${ENTER}`, 400],
    ], { rows: 12 })

    const bytes = Buffer.from(run.output)
    const captured = (offset: number | undefined): string => bytes.subarray(0, offset).toString()
    const preview = screenOf(captured(run.offsets[5]), -1, 12).alternate
    const resizeAt = run.offsets[5] ?? 0
    const restoredTerminal = new Terminal(12, PTY_COLUMNS)
    restoredTerminal.feed(bytes.subarray(0, resizeAt).toString())
    restoredTerminal.resize(12, 20)
    restoredTerminal.feed(bytes.subarray(resizeAt, run.offsets[7] ?? bytes.length).toString())
    const restored = restoredTerminal.alternate
    const committedTerminal = new Terminal(12, PTY_COLUMNS)
    committedTerminal.feed(bytes.subarray(0, resizeAt).toString())
    committedTerminal.resize(12, 20)
    committedTerminal.feed(bytes.subarray(resizeAt, run.offsets[10] ?? bytes.length).toString())
    const committed = committedTerminal.alternate
    expect(preview.join('\n')).toContain('first sticky prompt')
    expect(restored.join('\n')).toContain('second sticky')
    expect(committed.join('\n')).toContain('first sticky')
  }, E2E_TEST_TIMEOUT_MS)

  it('collapses a long result and names the expand key', async () => {
    const output = await drivePty('tall', [
      ['Welcome to codsh', `make it tall${ENTER}`, 300],
      ['lines (click or Ctrl+O expands)', `/exit${ENTER}`, 500],
    ])
    const rows = screenAt(output, 'Ctrl+O expands').alternate
    const body = rows.filter(row => row.includes('CODE_CLI_TALL_'))
    // A skimmable sliver, not a wall; the affordance names the key.
    expect(body.length).toBeLessThanOrEqual(24)
    expect(rows.some(row => row.includes('(click or Ctrl+O expands)'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('names the block the pointer rests on, and gives the row back', async () => {
    // A move with nothing held: button 35 is the motion bit over the no-button
    // code, which is what any-motion tracking sends.
    const moveTo = (line: string): string => `\u001B[<35;6;{row:${line}}M`
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      // Resting on the collapsed thought: the chrome says what it is and what
      // a click would do, before anything is clicked.
      ['thought for', moveTo('thought for'), 600],
      // Away from every block — the welcome banner — and the row is given back.
      ['click to expand', moveTo('Welcome to codsh'), 600],
      ['thought for', `/exit${ENTER}`, 400],
    ])
    const named = screenAtLast(output, 'click to expand').alternate
    expect(named.some(row => /thinking · \d+ lines · click to expand/u.test(row))).toBe(true)
    const released = finalScreen(output).alternate
    expect(released.some(row => row.includes('click to expand'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('opens the block a click lands on, and folds it back from inside it', async () => {
    // Where a block sits depends on everything printed above it, so the click
    // aims at the line itself and the driver resolves the row it was painted
    // on. Press and release without moving: a drag would copy instead.
    const clickOn = (line: string): string => `\u001B[<0;6;{row:${line}}M\u001B[<0;6;{row:${line}}m`
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      // Thinking lands collapsed; a click on its summary opens that block.
      ['thought for', clickOn('thought for'), 600],
      // A click anywhere in the open block — not just its head line — folds it
      // back again.
      ['weighing the options carefully', clickOn('weighing the options carefully'), 600],
      ['lines (click or Ctrl+O expands)', `/exit${ENTER}`, 400],
    ])
    const opened = screenAtLast(output, 'weighing the options carefully').alternate
    expect(opened.some(row => row.includes('CODE_CLI_THINKING about the request'))).toBe(true)
    // Folded back by the second click — before any submission could do it.
    const shut = screenAtLast(output, 'lines (click or Ctrl+O expands)').alternate
    expect(shut.some(row => /✻ thought for [\d.]+s · \+\d+ lines/u.test(row))).toBe(true)
    expect(shut.some(row => row.includes('weighing the options carefully'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('reports one continuous clock for the whole turn', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 500],
    ])
    const screen = finalScreen(output)
    // Exactly one cost line per turn — per-step reports would print several.
    const costs = screen.alternate.filter(row => /^\s+\d+(?:\.\d+)?s( · .*tokens)?$/u.test(row))
    expect(costs).toHaveLength(1)
  }, E2E_TEST_TIMEOUT_MS)

  it('renders model output faithfully: tables stay tables, emphasis eats its markers', async () => {
    const output = await drivePty('markdown', [
      ['Welcome to codsh', `explain${ENTER}`, 300],
      ['CODE_CLI_CALL_STREAM_DONE', `/exit${ENTER}`, 600],
    ])
    const rows = screenAt(output, 'CODE_CLI_CALL_STREAM_DONE').alternate
    const text = rows.join('\n')
    // The wide Chinese table wrapped inside its cells — never raw pipe rows.
    expect(text).not.toContain('|---')
    expect(text).not.toContain('| 维度')
    expect(rows.some(row => row.includes('维度') && row.includes('内容'))).toBe(true)
    // The grid is framed and ruled: edges, a head rule, and every table row —
    // wrapped continuations included — carries the same rule count, so the
    // sheared-apart layout of the field report cannot re-form silently.
    expect(rows.some(row => row.includes('╭') && row.includes('┬'))).toBe(true)
    expect(rows.some(row => row.includes('┼'))).toBe(true)
    // Table rows carry three rules (two columns framed); the input box's
    // middle row has two and a blockquote one, so ≥3 isolates the table.
    const ruleCounts = new Set(rows.filter(row => row.split('│').length - 1 >= 3)
      .map(row => row.split('│').length - 1))
    expect(ruleCounts.size).toBeLessThanOrEqual(1)
    // Bold-wrapped code lost its backticks and its stars.
    expect(text).not.toContain('`screen.ts`')
    expect(text).not.toContain('**')
    expect(text).toContain('screen.ts')
  }, E2E_TEST_TIMEOUT_MS)

  it('copies raw answers and fence-free code by stable content address', async () => {
    const markdown = [
      '# CODE_CLI_HEADING',
      '',
      'Prose with **bold**, *em*, `inline_code`, and a [link](https://x.dev).',
      'An identifier like some_helper_name must survive intact.',
      '',
      '- **`screen.ts`**: the viewport module',
      '- second bullet',
      '- third bullet keeps the answer long',
      '- fourth bullet keeps the answer long',
      '- fifth bullet keeps the answer long',
      '- sixth bullet keeps the answer long',
      '- seventh bullet keeps the answer long',
      '- eighth bullet: past the fold threshold at any test width',
      '',
      '| 维度 | 内容 |',
      '|---|---|',
      `| 一句话 | ${'一个很长的中文单元格内容,用来强制表格在任何终端宽度下都必须在单元格内部换行。'.repeat(3)} |`,
      '| 命令 | `codsh` | | |',
      '',
      '> a quoted line',
      '',
      '```ts',
      'const answer = "text" // a comment',
      '```',
      '',
      'CODE_CLI_CALL_STREAM_DONE',
    ].join('\n')
    const output = await drivePty('markdown', [
      ['Welcome to codsh', `explain${ENTER}`, 300],
      ['CODE_CLI_CALL_STREAM_DONE', `/copy 1:1${ENTER}`, 300],
      ['copied code 1:1', `/copy${ENTER}`, 300],
      ['Copy content', ENTER, 300],
      ['copied answer 1', `/copy${ENTER}`, 300],
      ['Copy content', '\u001B', 300],
      ['nothing copied', `/exit${ENTER}`, 400],
    ])
    const copied = [...output.matchAll(/\u001B\]52;c;([^\u0007]*)\u0007/gu)]
      .map(match => Buffer.from(match[1] ?? '', 'base64').toString('utf8'))
    expect(copied).toEqual(['const answer = "text" // a comment', markdown])
  }, E2E_TEST_TIMEOUT_MS)

  it('does not write the clipboard when copying is disabled', async () => {
    const output = await drivePty('markdown', [
      ['Welcome to codsh', `explain${ENTER}`, 300],
      ['CODE_CLI_CALL_STREAM_DONE', `/copy 1${ENTER}`, 300],
      ['clipboard is disabled or unavailable', `/exit${ENTER}`, 400],
    ], { env: { CODSH_CLIPBOARD: 'off' } })
    expect(output).not.toContain('\u001B]52;c;')
  }, E2E_TEST_TIMEOUT_MS)

  it('views answers and code full-screen, then restores the exact prior viewport', async () => {
    const run = await drivePtySteps('markdown', [
      ['Welcome to codsh', `explain${ENTER}`, 300],
      ['CODE_CLI_CALL_STREAM_DONE', `/view${ENTER}`, 300],
      ['View content', ENTER, 300],
      ['Esc closes', '\u001B[6~', 300],
      ['Esc closes', '\u001B', 300],
      ['Ask anything', `/view 1:1${ENTER}`, 300],
      ['Esc closes', '\u001B', 300],
      ['Ask anything', `/view 9:9${ENTER}`, 300],
      ['was not found', '', 1_700],
      ['', `/exit${ENTER}`, 400],
    ], { rows: 12 })
    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const at = (index: number): string[] => screenOf(captured(run.offsets[index]), -1, 12).alternate
    const before = at(1)
    const answer = at(3)
    const paged = at(4)
    const afterAnswer = at(5)
    const code = at(6)
    const afterCode = at(7)
    const afterFailure = at(9)

    expect(answer[0]).toContain('Answer 1')
    expect(answer.at(-1)).toContain('Esc closes')
    expect(answer.join('\n')).not.toContain('Ask anything')
    expect(paged).not.toEqual(answer)
    expect(afterAnswer).toEqual(before)
    expect(code[0]).toContain('Code 1:1')
    expect(code.join('\n')).toContain('const answer = "text" // a comment')
    expect(code.join('\n')).not.toContain('```')
    expect(afterCode).toEqual(before)
    expect(afterFailure).toEqual(before)
  }, E2E_TEST_TIMEOUT_MS)

  it('reports a failed /view in chrome without adding it to the transcript', async () => {
    const run = await drivePtySteps('write', [
      ['Welcome to codsh', `/view 1${ENTER}`, 300],
      ['no viewable assistant answers', '', 1_700],
      ['', `/exit${ENTER}`, 400],
    ])
    const settled = screenOf(Buffer.from(run.output).subarray(0, run.offsets[2]).toString(), -1).alternate
    expect(settled.join('\n')).not.toContain('/view 1')
    expect(run.output).not.toContain('Esc closes')
  }, E2E_TEST_TIMEOUT_MS)

  it('reflows a full-screen viewer across terminal resize before restoring', async () => {
    const run = await drivePtySteps('markdown', [
      ['Welcome to codsh', `explain${ENTER}`, 300],
      ['CODE_CLI_CALL_STREAM_DONE', `/view 1${ENTER}`, 300],
      ['Esc closes', '@WINSZ:9x50', 400],
      ['Esc closes', '\u001B', 300],
      ['Ask anything', `/exit${ENTER}`, 400],
    ], { rows: 12 })
    const resizeAt = run.offsets[2] ?? 0
    const bytes = Buffer.from(run.output)
    const afterResize = run.offsets[3] ?? bytes.length
    const terminal = new Terminal(12, PTY_COLUMNS)
    terminal.feed(bytes.subarray(0, resizeAt).toString())
    terminal.resize(9, 50)
    terminal.feed(bytes.subarray(resizeAt, afterResize).toString())
    expect(terminal.alternate).toHaveLength(9)
    expect(terminal.alternate[0]).toContain('Answer 1')
    expect(terminal.alternate.at(-1)).toContain('Esc closes')
    expect(terminal.alternate.join('\n')).not.toContain('Ask anything')
    for (const row of terminal.alternate) expect(row.length).toBeLessThanOrEqual(50)

    const restored = new Terminal(12, PTY_COLUMNS)
    restored.feed(bytes.subarray(0, resizeAt).toString())
    restored.resize(9, 50)
    restored.feed(bytes.subarray(resizeAt, run.offsets[4] ?? bytes.length).toString())
    expect(restored.alternate.join('\n')).toContain('Ask anything')
    expect(restored.alternate.join('\n')).not.toContain('Answer 1')
  }, E2E_TEST_TIMEOUT_MS)

  it('folds a finished long answer on moving on, and reopens it on Ctrl+O', async () => {
    const output = await drivePty('markdown', [
      ['Welcome to codsh', `explain${ENTER}`, 300],
      // The whole answer stands while fresh; the next submission collapses it.
      ['CODE_CLI_CALL_STREAM_DONE', `/status${ENTER}`, 500],
      // Collapsed to its head lines: Ctrl+O brings the tail back.
      ['permissions', '\u000F', 400],
      ['CODE_CLI_CALL_STREAM_DONE', `/exit${ENTER}`, 400],
    ])
    // After /status the wall is gone: a head, a count, and no tail marker.
    const folded = screenAt(output, 'permissions').alternate
    expect(folded.some(row => row.includes('lines (click or Ctrl+O expands)'))).toBe(true)
    expect(folded.some(row => row.includes('CODE_CLI_CALL_STREAM_DONE'))).toBe(false)
    // Re-expanded: read the frame that painted the tail marker last.
    const probe = screenAtLast(output, 'CODE_CLI_CALL_STREAM_DONE')
    expect(probe.alternate.some(row => row.includes('CODE_CLI_CALL_STREAM_DONE'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('keeps a manually expanded block open across the next real turn', async () => {
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `first question${ENTER}`, 300],
      ['CODE_CLI_ANSWER', '\u000F', 300],
      ['weighing the options carefully', `second question${ENTER}`, 300],
      ['CODE_CLI_ANSWER', `/exit${ENTER}`, 500],
    ])
    const rows = screenAtLast(output, 'CODE_CLI_ANSWER').alternate
    expect(rows.filter(row => row.includes('weighing the options carefully'))).toHaveLength(1)
    expect(rows.some(row => row.includes('second question'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('searches prompt history on Ctrl+R', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', '\u0012', 400],
      ['bck-i-search', '\u001B', 300],
      ['Ask anything', `/exit${ENTER}`, 400],
    ])
    const rows = screenAt(output, 'bck-i-search').alternate
    expect(rows.some(row => row.includes('bck-i-search'))).toBe(true)
    expect(rows.some(row => row.includes('create the note'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('searches the transcript on Ctrl+F', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', '\u0006', 400],
      ['find:', 'CALL', 400],
      ['find: CALL', '\u001B', 300],
      ['', `/exit${ENTER}`, 400],
    ])
    const rows = screenAt(output, 'find: CALL').alternate
    expect(rows.some(row => row.includes('find: CALL'))).toBe(true)
    expect(rows.some(row => row.includes('│ › CALL'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('opens the shortcuts overlay on ? from an empty box', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', '?', 400],
      ['Ctrl+R history', '\u001B', 300],
      ['Ask anything', `/exit${ENTER}`, 400],
    ])
    const rows = screenAt(output, 'Ctrl+R history').alternate
    expect(rows.some(row => row.includes('Ctrl+R history'))).toBe(true)
    expect(rows.some(row => row.includes('Ctrl+F find'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('gives a queued line back on Escape', async () => {
    const output = await drivePty('slow', [
      ['Welcome to codsh', `take your time${ENTER}`, 300],
      ['$ sleep', `later work${ENTER}`, 400],
      ['queued: later work', '\u001B', 500],
      ['', '\u0015\u001B', 400],
      ['interrupted', `/exit${ENTER}`, 400],
    ])
    expect(screenAt(output, 'queued: later work').alternate.some(row => row.includes('queued: later work'))).toBe(true)
    const back = screenAtLast(output, 'later work').alternate
    expect(back.some(row => row.includes('later work'))).toBe(true)
    expect(back.some(row => row.includes('queued: later work'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('collapses thinking by default and expands it on Ctrl+O', async () => {
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      ['thought for', '\u000F', 500],
      ['weighing the options carefully', `/exit${ENTER}`, 400],
    ])
    // The toggle swaps the summary for the full thought in place: read the
    // frame that painted its final line last (the live preview carried the
    // same text earlier).
    const rows = screenAtLast(output, 'weighing the options carefully').alternate
    expect(rows.some(row => /✻ thought for [\d.]+s/u.test(row))).toBe(true)
    expect(rows.some(row => row.includes('weighing the options carefully'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)
})
