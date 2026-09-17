/**
 * The subagents roster: the readout that counts the children a turn started,
 * the panel a person opens on it, entering one from the panel and the title
 * its view carries, and a finished child still on the roster afterwards.
 *
 * The `subagents` mock starts two background children in one step; child ONE
 * holds a `sleep 4` then answers, child TWO holds a `sleep 3` then ends its
 * turn with an error, so the roster settles to one done and one failed. Each
 * settled child wakes the parent with a notice, which the mock answers with
 * `CODE_CLI_SUBAGENTS_SETTLED n=<notices>`: `n=2` is the proof that both are
 * gone and the parent is idle, so every case exits there.
 */

import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { drivePty, drivePtySteps, screenOf } from './pty-driver.ts'
import { ENTER, ESCAPE, screenAt } from './pty-helpers.ts'

/** Ctrl+H, as a terminal in raw mode sends it. */
const CTRL_H = ''

/** Press and release without moving on the row that last painted `line`. */
const clickOn = (line: string): string => `[<0;6;{row:${line}}M[<0;6;{row:${line}}m`

/** The readout while both children run: one dim span, so the raw stream holds it whole. */
const BOTH_RUNNING = 'subagents 2 · 2 running · Ctrl+H'

/** The readout once both have ended: ONE completed, TWO failed on purpose. */
const BOTH_SETTLED = 'subagents 2 · 1 done · 1 failed · Ctrl+H'

/** The parent's answer to the second settlement notice: both gone, parent idle. */
const ALL_SETTLED = 'CODE_CLI_SUBAGENTS_SETTLED n=2'

/** The rows of the screen after step `k` settled. */
const frame = (run: { output: string; offsets: number[] }, k: number): string[] =>
  screenOf(Buffer.from(run.output).subarray(0, run.offsets[k]).toString(), -1).alternate

/** The one row that carries `text`, for an assertion that names the row. */
const rowOf = (rows: readonly string[], text: string): string => rows.find(row => row.includes(text)) ?? ''

/**
 * Which child the panel's marked first row names. The roster keeps start
 * order, and two children started in one step come up in either order, so a
 * case that enters the marked row reads which one it got.
 */
const firstOnRoster = (opened: readonly string[]): { label: string; sleep: string; done: string } =>
  rowOf(opened, '❯ 1.').includes('CODE_CLI_SUBAGENT_ONE')
    ? { label: 'CODE_CLI_SUBAGENT_ONE brief', sleep: 'sleep 4', done: 'CHILD_ONE_DONE' }
    : { label: 'CODE_CLI_SUBAGENT_TWO brief', sleep: 'sleep 3', done: '● sleep 3' }

describe.skipIf(process.platform === 'win32')('the subagents roster (real PTY)', () => {
  it('counts the children a turn started, and settles them as they finish', async () => {
    const output = await drivePty('subagents', [
      ['Welcome to codsh', `delegate it${ENTER}`, 300],
      // Both children hold a `sleep`, so the readout says two run...
      [BOTH_RUNNING, '', 0],
      ['CODE_CLI_SUBAGENTS_STARTED', '', 0],
      // ...and settles as each turn ends: one completed, one failed.
      [BOTH_SETTLED, '', 0],
      [ALL_SETTLED, `/exit${ENTER}`, 400],
    ], { timeoutMs: 60_000 })
    // The parent's turn is over — its answer is on screen — and the
    // children run on: the readout is the one thing that says so.
    const answered = screenAt(output, 'CODE_CLI_SUBAGENTS_STARTED').alternate
    expect(answered.some(row => /subagents 2 · 2 running · Ctrl\+H/u.test(row))).toBe(true)
    const settled = screenAt(output, 'subagents 2 · 1 done · 1 failed').alternate
    expect(settled.some(row => /subagents 2 · 1 done · 1 failed · Ctrl\+H/u.test(row))).toBe(true)
    // The settlements woke the parent, and the parent delegated nothing more.
    expect(output).not.toContain('subagents 3 ·')
  }, E2E_TEST_TIMEOUT_MS)

  it('opens the panel on Ctrl+H, names each child with its state, and closes on Esc', async () => {
    const run = await drivePtySteps('subagents', [
      ['Welcome to codsh', `delegate it${ENTER}`, 300],
      [BOTH_RUNNING, CTRL_H, 500],
      ['Ctrl+H closes', ESCAPE, 400],
      [BOTH_SETTLED, '', 0],
      [ALL_SETTLED, `/exit${ENTER}`, 400],
    ], { timeoutMs: 60_000 })
    const opened = frame(run, 2)
    const closed = frame(run, 3)
    // The header keeps the readout's counts, and adds the way out.
    expect(opened.some(row => row.includes('subagents 2 · 2 running · Ctrl+H closes'))).toBe(true)
    // Each child by number, mark, label, and clock, in the order they came
    // up; the first row is marked.
    expect(opened.some(row => /❯ 1\. ▶ CODE_CLI_SUBAGENT_(?:ONE|TWO) brief · [\d.]+s/u.test(row))).toBe(true)
    expect(opened.some(row => /  2\. ▶ CODE_CLI_SUBAGENT_(?:ONE|TWO) brief · [\d.]+s/u.test(row))).toBe(true)
    expect(rowOf(opened, 'CODE_CLI_SUBAGENT_ONE brief')).toMatch(/▶ CODE_CLI_SUBAGENT_ONE brief · [\d.]+s/u)
    expect(rowOf(opened, 'CODE_CLI_SUBAGENT_TWO brief')).toMatch(/▶ CODE_CLI_SUBAGENT_TWO brief · [\d.]+s/u)
    expect(opened.some(row => row.includes('[enter] view · [esc] back'))).toBe(true)
    // Esc folds the panel back to the readout; nothing else happened.
    expect(closed.some(row => row.includes('Ctrl+H closes'))).toBe(false)
    expect(closed.some(row => /subagents 2 · .*Ctrl\+H/u.test(row))).toBe(true)
    expect(closed.some(row => row.includes('interrupted'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('enters a child from the panel with Enter, titles its view, and returns on Esc', async () => {
    const run = await drivePtySteps('subagents', [
      ['Welcome to codsh', `delegate it${ENTER}`, 300],
      [BOTH_RUNNING, CTRL_H, 500],
      ['Ctrl+H closes', ENTER, 600],
      // Inside: the child's own card, and a status row naming the child.
      ['Esc returns to the parent', ESCAPE, 400],
      // Uncovering the parent paints its answer again: back for sure,
      // once the repaint has settled.
      ['CODE_CLI_SUBAGENTS_STARTED', '', 400],
      [BOTH_SETTLED, '', 0],
      [ALL_SETTLED, `/exit${ENTER}`, 400],
    ], { timeoutMs: 60_000 })
    const entered = firstOnRoster(frame(run, 2))
    const inside = frame(run, 3)
    const back = frame(run, 4)
    // The child's transcript covers the parent's: its `sleep` card is
    // there and the parent's answer is not.
    expect(inside.some(row => row.includes(`● ${entered.sleep}`))).toBe(true)
    expect(inside.some(row => row.includes('CODE_CLI_SUBAGENTS_STARTED'))).toBe(false)
    // The title bar: which child, its mark, its clock, its work, and the way
    // back. The call is optional only because the view can open before the
    // child's `tool/call` lands.
    expect(rowOf(inside, 'Esc returns to the parent')).toMatch(new RegExp(`subagent ▶ ${entered.label} · [\\d.]+s( · 1 call · bash: ${entered.sleep})? · Esc returns to the parent`, 'u'))
    expect(inside.some(row => row.includes('Ctrl+H closes'))).toBe(false)
    // Esc: the parent again, its answer back, the readout still counting.
    expect(back.some(row => row.includes('CODE_CLI_SUBAGENTS_STARTED'))).toBe(true)
    expect(back.some(row => /subagents 2 · .*Ctrl\+H/u.test(row))).toBe(true)
    expect(back.some(row => row.includes('Esc returns to the parent'))).toBe(false)
    expect(back.some(row => row.includes(`● ${entered.sleep}`))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('opens the panel on a click on the readout, and enters a child on a click on its row', async () => {
    const run = await drivePtySteps('subagents', [
      ['Welcome to codsh', `delegate it${ENTER}`, 300],
      [BOTH_RUNNING, clickOn('subagents 2 · 2 running'), 600],
      // The row's figures name the call only the panel paints.
      ['bash: sleep 3', clickOn('bash: sleep 3'), 600],
      ['Esc returns to the parent', ESCAPE, 400],
      ['CODE_CLI_SUBAGENTS_STARTED', '', 0],
      [BOTH_SETTLED, '', 0],
      [ALL_SETTLED, `/exit${ENTER}`, 400],
    ], { timeoutMs: 60_000 })
    const opened = frame(run, 2)
    const inside = frame(run, 3)
    expect(opened.some(row => row.includes('subagents 2 · 2 running · Ctrl+H closes'))).toBe(true)
    // Each label sits with its own call: the roster binds a child to the
    // card its log names, whichever came up first.
    expect(rowOf(opened, 'CODE_CLI_SUBAGENT_ONE brief')).toMatch(/bash: sleep 4/u)
    expect(rowOf(opened, 'CODE_CLI_SUBAGENT_TWO brief')).toMatch(/bash: sleep 3/u)
    // The second row, not the marked first: a click chooses where it lands.
    expect(rowOf(inside, 'Esc returns to the parent')).toMatch(/subagent ▶ CODE_CLI_SUBAGENT_TWO brief · [\d.]+s · 1 call · bash: sleep 3 · Esc returns to the parent/u)
    expect(inside.some(row => row.includes('● sleep 3'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('keeps a finished child on the roster with its outcome, and still opens it', async () => {
    const run = await drivePtySteps('subagents', [
      ['Welcome to codsh', `delegate it${ENTER}`, 300],
      // Both gone from the store, and the parent idle.
      [ALL_SETTLED, CTRL_H, 500],
      ['Ctrl+H closes', ENTER, 800],
      // The door either opens or says why not; the assertion tells them
      // apart, so the step after Esc waits on nothing the door decides.
      ['re:Esc returns to the parent|no longer running', ESCAPE, 400],
      ['', `/exit${ENTER}`, 400],
    ], { timeoutMs: 60_000 })
    const opened = frame(run, 2)
    const inside = frame(run, 3)
    // The roster says how each ended, with the work it did.
    expect(opened.some(row => row.includes('subagents 2 · 1 done · 1 failed · Ctrl+H closes'))).toBe(true)
    expect(rowOf(opened, 'CODE_CLI_SUBAGENT_ONE brief')).toMatch(/\d\. ✔ CODE_CLI_SUBAGENT_ONE brief · [\d.]+s · 1 call · bash: sleep 4/u)
    expect(rowOf(opened, 'CODE_CLI_SUBAGENT_TWO brief')).toMatch(/\d\. ✗ CODE_CLI_SUBAGENT_TWO brief · [\d.]+s · 1 call · bash: sleep 3/u)
    // A finished child still opens: its transcript, read back whole from its
    // persisted log — ONE's answer, or TWO's card — and a title whose clock
    // has stopped on its outcome.
    const entered = firstOnRoster(opened)
    expect(inside.some(row => row.includes('no longer running'))).toBe(false)
    expect(inside.some(row => row.includes(entered.done))).toBe(true)
    expect(rowOf(inside, 'Esc returns to the parent')).toMatch(new RegExp(`subagent [✔✗] ${entered.label} · [\\d.]+s · 1 call · bash: ${entered.sleep} · Esc returns to the parent`, 'u'))
  }, E2E_TEST_TIMEOUT_MS)
})
