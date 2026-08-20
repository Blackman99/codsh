/**
 * The showcase frames, captured from the real binary.
 *
 * The site shows what codsh looks like, and a hand-drawn mockup of a terminal
 * is a promise nobody checked. These drive the packed build in a PTY exactly
 * as the suites do, replay the frames through the emulator, and write the
 * screens out with their styling intact — so every terminal on the site is a
 * transcript of a session that really ran.
 *
 * Skipped unless `CAPTURE_SCREENS=1`, because it writes into the repository
 * rather than asserting anything. Regenerate with:
 *
 *   CAPTURE_SCREENS=1 pnpm run site:screens
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS, repoRoot } from './harness.ts'
import { SYNC_END, drivePty, heldOutput } from './pty-driver.ts'
import { Terminal } from './vt.ts'
import type { Run } from './vt.ts'

/**
 * The window the showcase is captured at.
 *
 * Narrower than the suites' 120 columns on purpose: a 120-column screen in a
 * web card is either unreadably small or cut off at the edge, and 80-odd
 * columns is a shape every terminal has been since the beginning.
 */
const CAPTURE_ROWS = 34

/** Columns the showcase window reports. */
const CAPTURE_COLUMNS = 84

/** Submit what the box holds. */
const ENTER = '\r'

/** Legacy Shift-Tab, which toggles plan mode. */
const SHIFT_TAB = '[Z'

/** Ctrl+T, which opens the todo list. */
const CTRL_T = ''

/** Where the site reads its frames from. */
const OUT = join(repoRoot, 'site', 'data', 'screens.json')

/**
 * The workspace every scene runs in.
 *
 * Under `$HOME`, because the surface abbreviates it to `~` — a screenshot
 * whose status row reads `/private/var/folders/s6/7t1…` is a screenshot of a
 * test fixture. Under `.cache`, because a directory this creates and removes
 * must never be one a person could already own.
 */
const WORKSPACE = join(homedir(), '.cache', 'codsh', 'showcase')

/**
 * A pointer resting on the line `text` was painted on.
 *
 * Button 35 is the motion bit over the no-button code — what any-motion
 * tracking sends — and `{row:…}` is resolved by the driver, since a block's
 * row depends on everything printed above it.
 * @param text - a line the pointer should rest on.
 * @returns the mouse report to write.
 */
const moveOnto = (text: string): string => `[<35;6;{row:${text}}M`

/** One captured screen, as the site consumes it. */
interface Scene {
  id: string
  /** What the scene is showing, for the caption. */
  title: string
  /** Why it matters, one sentence. */
  note: string
  /**
   * Row ranges the site shows, `[first, last]` inclusive.
   *
   * Two of them, because a session's screen has content at the top and chrome
   * pinned at the bottom with empty rows between. Showing both and shortening
   * the empty run hides nothing and keeps the card a readable height; a crop
   * is all this ever is — no row is redrawn or reordered.
   */
  keep: [number, number][]
  /** Every row of the real screen, as runs of same-pen text. */
  rows: Run[][]
}

/** The text of one row, styling dropped. */
const plain = (row: Run[]): string => row.map(run => run.text).join('')

/**
 * Which rows of a captured screen the site should show.
 *
 * The first-boot preset notice goes (it names a temporary home, and a reader
 * would take it for part of the surface), then the leading blanks, then — when
 * the screen has the empty middle a short transcript leaves — the run before
 * the chrome.
 * @param rows - the whole screen.
 * @param from - text to open on, for a scene about one block rather than the
 * session as a whole.
 * @returns the ranges to keep.
 */
function keepRanges(rows: Run[][], from?: string): [number, number][] {
  const blank = (index: number): boolean => plain(rows[index] ?? []).trim() === ''
  let start = 0
  // The first-boot notice names a temporary home and wraps at this width, so
  // it is dropped as a whole — up to the blank row that ends it — rather than
  // row by row, which would leave the tail of a path behind.
  if (plain(rows[0] ?? []).includes('installed preset into')) {
    while (start < rows.length && !blank(start)) start += 1
  }
  while (start < rows.length && blank(start)) start += 1
  if (from !== undefined) {
    const at = rows.findIndex(row => plain(row).includes(from))
    if (at > start) start = at - 1
  }
  // The input box's top edge is where the chrome begins. Scanning up for the
  // first blank row instead would stop inside the chrome, whose hint row is
  // empty until something has a hint to give.
  const box = rows.findIndex(row => plain(row).startsWith('╭─'))
  const chrome = box > start ? box : -1
  if (chrome < 0) return [[start, rows.length - 1]]
  let content = chrome - 1
  while (content > start && blank(content)) content -= 1
  // A transcript reaching the chrome leaves no empty run to shorten.
  if (content >= chrome - 1) return [[start, rows.length - 1]]
  return [[start, content], [chrome, rows.length - 1]]
}

describe.skipIf(process.env.CAPTURE_SCREENS === undefined)('showcase frames', () => {
  it('captures the screens the site shows', async () => {
    const scenes: Scene[] = []

    /**
     * Run one scenario and keep the screen at a marker.
     * @param scene - identity and captions.
     * @param mode - the mocked tool mode.
     * @param script - the steps to drive.
     * @param marker - text whose frame is the one to keep.
     * @param occurrence - which paint of the marker to stop at.
     */
    const capture = async (
      scene: Omit<Scene, 'rows' | 'keep'> & { from?: string },
      mode: string,
      script: readonly (readonly [string, string, number])[],
      marker: string,
      occurrence: 'first' | 'last' = 'last',
    ): Promise<void> => {
      const output = await drivePty(mode, script, {
        cwd: WORKSPACE,
        rows: CAPTURE_ROWS,
        columns: CAPTURE_COLUMNS,
      })
      // The suites' screen helpers are fixed to their own window, so the frame
      // is cut here instead: at the end of the synchronized update the marker
      // appeared in, never inside one.
      const held = heldOutput(output)
      const at = occurrence === 'first' ? held.indexOf(marker) : held.lastIndexOf(marker)
      const frameEnd = at < 0 ? -1 : held.indexOf(SYNC_END, at)
      const terminal = new Terminal(CAPTURE_ROWS, CAPTURE_COLUMNS)
      terminal.feed(held.slice(0, frameEnd < 0 ? held.length : frameEnd + SYNC_END.length))
      const rows = terminal.styledAlternate
      const { from, ...rest } = scene
      scenes.push({ ...rest, keep: keepRanges(rows, from), rows })
    }

    // The first thing anyone sees: the lettermark, the box, the status row.
    await capture(
      { id: 'welcome', title: 'A session that is its own space', note: 'The alternate screen, the input box pinned to the bottom, and the status row that is always current.' },
      'write',
      [['Welcome to codsh', '', 700], ['', `/exit${ENTER}`, 400]],
      // The box lands a frame after the banner, so the banner is the wrong
      // marker to stop at: it names a screen the person never sees alone.
      'Ask anything',
      'first',
    )

    // A tool call rendered as its card, with the diff the presenter produced.
    await capture(
      { id: 'tool-call', title: 'Tool calls as cards, with their diffs', note: 'Every call renders through its presenter — a title, a status, and a diff — under a rule down the block’s left edge.', from: '› create the note' },
      'write',
      [['Welcome to codsh', `create the note${ENTER}`, 300], ['CODE_CLI_CALL_OK', '', 700], ['', `/exit${ENTER}`, 400]],
      'CODE_CLI_CALL_OK',
    )

    // Thinking collapsed to one line, and the readout naming it on hover.
    await capture(
      { id: 'fold-hover', title: 'A block says what it is under the pointer', note: 'Resting on a fold underlines its head row and names it below the box — what a click will do, before it lands.', from: '› think it over' },
      'reasoning',
      [['Welcome to codsh', `think it over${ENTER}`, 300], ['thought for', moveOnto('thought for'), 900], ['', `/exit${ENTER}`, 400]],
      'click to expand',
    )

    // The same block opened by a click, which is the other half of the story.
    await capture(
      { id: 'fold-open', title: 'One click opens the one block', note: 'A click opens the block it lands on and a click anywhere inside folds it back; Ctrl+O still swaps every one at once.', from: '› think it over' },
      'reasoning',
      [
        ['Welcome to codsh', `think it over${ENTER}`, 300],
        ['thought for', `[<0;6;{row:thought for}M[<0;6;{row:thought for}m`, 900],
        ['', `/exit${ENTER}`, 400],
      ],
      'weighing the options carefully',
    )

    // The todo list pinned in the chrome, then opened whole.
    await capture(
      { id: 'todos', title: 'Todos that stay in view', note: 'A pinned row holds the agent’s list over the status row instead of scrolling away with the write; Ctrl+T opens it whole.', from: '› plan the work' },
      'todo',
      [['Welcome to codsh', `plan the work${ENTER}`, 400], ['todos', CTRL_T, 900], ['', `/exit${ENTER}`, 400]],
      // A marker only the chrome paints: a transcript marker would cut the
      // frame before the rows under the box were repainted.
      'Ctrl+T closes',
    )

    // Markdown: tables laid out, code highlighted, emphasis eaten.
    await capture(
      { id: 'markdown', title: 'Markdown, rendered rather than echoed', note: 'Tables get real columns, code gets highlighted, and emphasis markers are consumed instead of printed.', from: '› explain it' },
      'markdown',
      [['Welcome to codsh', `explain it${ENTER}`, 400], ['│', '', 900], ['', `/exit${ENTER}`, 400]],
      '│',
    )

    // Plan mode, which tints the box frame while it holds.
    await capture(
      { id: 'plan-mode', title: 'Plan mode tints the box', note: 'Shift-Tab toggles plan mode, and the frame carries it so the next submission’s effect is visible mid-thought.' },
      'write',
      [['Welcome to codsh', SHIFT_TAB, 400], ['plan mode', '', 800], ['', `/exit${ENTER}`, 400]],
      'plan mode',
    )

    // The showcase workspace was only ever scaffolding for the capture.
    await rm(WORKSPACE, { recursive: true, force: true })
    await mkdir(dirname(OUT), { recursive: true })
    await writeFile(OUT, `${JSON.stringify({ rows: CAPTURE_ROWS, columns: CAPTURE_COLUMNS, scenes }, undefined, 2)}\n`)
    // eslint-disable-next-line no-console
    console.log(`captured ${scenes.length} screens → ${OUT}`)
  }, E2E_TEST_TIMEOUT_MS * 3)
})
