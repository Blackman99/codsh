/**
 * The experience checklist: what a person notices in the first five minutes,
 * asserted at the screen level before a person has to.
 *
 * Every entry started life as a real complaint — a menu that hid its tail, a
 * wheel that scrolled backwards, a clock that reset per step, a flickering
 * hint row, a bare welcome, a wall of output. The checklist is split by topic
 * because Vitest parallelises by file: the run takes as long as its largest
 * file. This file: the welcome, scrolling back,
 * sticky turn headers, prompt-top anchoring, and the update notice.
 */

import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS, fakeRegistry } from './harness.ts'
import { drivePty, drivePtySteps, screenOf, screenAt, screenAtLast } from './pty-driver.ts'
import { ENTER } from './pty-helpers.ts'

describe.skipIf(process.platform === 'win32')('the first five minutes: welcome, scrolling, anchoring', () => {
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
    // The chrome is the borderless region plus the status row, so the region's
    // divider is a few rows up from the foot.
    expect(rows.slice(-5).some(row => /^─+$/u.test(row.trim()))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('shows the welcome again after /clear', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', `/clear${ENTER}`, 400],
      ['new session', `/exit${ENTER}`, 500],
    ])
    const rows = screenAt(output, 'new session').alternate
    // /clear resets the screen with the full ASCII logo banner and tips.
    const logoRow = rows.findIndex(row => row.includes('█') || row.includes('▀') || row.includes('▄'))
    expect(logoRow).toBeGreaterThanOrEqual(0)
    expect(rows.some(row => row.includes('Welcome to codsh'))).toBe(true)
    expect(rows.some(row => row.includes('⇧Tab plan'))).toBe(true)
    expect(rows.some(row => row.includes('Write note.txt'))).toBe(false)
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

    expect(tail[1]).toContain('second sticky prompt')
    expect(tail[0]?.at(-1)).toBe('↑')
    expect(tail[1]?.at(-1)).toBe('·')
    expect(tail[2]?.at(-1)).toBe('●')
    expect(browsing[1]).toContain('second sticky prompt')
    expect(crossed[1]).toContain('first sticky prompt')
    expect(crossed[0]?.at(-1)).toBe('↑')
    expect(crossed[1]?.at(-1)).toBe('●')
    expect(crossed[2]?.at(-1)).toBe('·')
    expect(crossed.join('\n')).toContain('↑ 48 rows above')
    expect(returned[1]).toContain('second sticky prompt')
    expect(crossed.slice(-2)).toEqual(tail.slice(-2))
  }, E2E_TEST_TIMEOUT_MS)

  it('keeps both explicit user lines in the sticky header', async () => {
    const shiftEnter = '\u001B[13;2u'
    const run = await drivePtySteps('sticky', [
      ['Welcome to codsh', `你好${shiftEnter}介绍下你自己${ENTER}`, 300],
      ['STICKY_FIRST_44', `/exit${ENTER}`, 500],
    ], { rows: 12 })

    const settled = screenOf(Buffer.from(run.output).subarray(0, run.offsets[1]).toString(), -1, 12).alternate
    // The pinned panel opens with a padding row of its own fill.
    expect(settled[0]?.trim()).toBe('')
    expect(settled[1]).toContain('你好')
    expect(settled[2]).toContain('介绍下你自己')
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
    expect(first[1]).toContain('anchor this prompt')
    expect(first.join('\n')).toContain('ANCHOR_REPLY_1')
    expect(filling[1]).toContain('anchor this prompt')
    expect(filling.join('\n')).toContain('ANCHOR_REPLY_3')
    expect(sticky[1]).toContain('anchor this prompt')
    expect(sticky.filter(row => row.includes('anchor this prompt'))).toHaveLength(1)
    expect(first.findIndex(row => row.includes('Ask anything'))).toBe(filling.findIndex(row => row.includes('Ask anything')))
    expect(first.at(-1)).toBe(filling.at(-1))
  }, E2E_TEST_TIMEOUT_MS)

  it('gives a canned command the top of the viewport, like a typed prompt', async () => {
    const run = await drivePtySteps('anchor', [
      ['Welcome to codsh', `/ship let long diffs open in a pager${ENTER}`, 200],
      ['ANCHOR_REPLY_1', '', 0],
      ['ANCHOR_REPLY_8', '', 0],
      ['ANCHOR_REPLY_12', `/exit${ENTER}`, 300],
    ], { rows: 12 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const first = screenOf(captured(run.offsets[1]), -1, 12).alternate
    const filling = screenOf(captured(run.offsets[2]), -1, 12).alternate

    // The echo takes the place a submitted message takes, and the reply fills
    // the space under it rather than pushing it up the screen.
    // Anchored or pinned, the panel's opening row takes the top and the echo
    // sits under it.
    expect(first[1]).toContain('/ship let long diffs open in a pager')
    expect(first.join('\n')).toContain('ANCHOR_REPLY_1')
    expect(filling[1]).toContain('/ship let long diffs open in a pager')
    expect(filling.join('\n')).toContain('ANCHOR_REPLY_8')
    expect(first.findIndex(row => row.includes('Ask anything'))).toBe(filling.findIndex(row => row.includes('Ask anything')))
    // One copy: the anchored prompt and its sticky header are the same row.
    expect(filling.filter(row => row.includes('/ship let long diffs'))).toHaveLength(1)
    // The template the command expands into is still not the transcript's
    // business — the echo is its whole presence, however it is placed.
    expect(run.output).not.toContain('tracer-bullet')
    expect(run.output).not.toContain('Phase 1')
  }, E2E_TEST_TIMEOUT_MS)

  it('leaves a command that only works the chrome where it was written', async () => {
    // The other half of the rule: `/status` answers nothing, so taking the top
    // would clear the screen to make room for a reply that never comes.
    const run = await drivePtySteps('anchor', [
      ['Welcome to codsh', `/status${ENTER}`, 500],
      ['', `/exit${ENTER}`, 300],
    ], { rows: 24 })
    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const shown = screenOf(captured(run.offsets[1]), -1, 24).alternate

    const echo = shown.findIndex(row => row.includes('› /status'))
    expect(echo).toBeGreaterThan(0)
    // What was on screen before it is still above it. On a 24-row terminal the
    // taller chrome scrolls the lettermark off, so the welcome's help line —
    // still on screen — is the witness that the command took no viewport.
    expect(shown.slice(0, echo).join('\n')).toContain('/help · /status · Tab')
  }, E2E_TEST_TIMEOUT_MS)

  it('gives the anchored prompt back when the reader wheels home again', async () => {
    const wheelUp = '\u001B[<64;10;5M'
    const wheelDown = '\u001B[<65;10;5M'
    const run = await drivePtySteps('anchor', [
      ['Welcome to codsh', `anchor this prompt${ENTER}`, 100],
      ['ANCHOR_REPLY_12', wheelUp.repeat(3), 400],
      ['\u2191 3 rows above', wheelDown.repeat(3), 400],
      ['', `/exit${ENTER}`, 300],
    ])

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const anchored = screenOf(captured(run.offsets[1]), -1).alternate
    const browsing = screenOf(captured(run.offsets[2]), -1).alternate
    const returned = screenOf(captured(run.offsets[3]), -1).alternate
    expect(anchored[1]).toContain('anchor this prompt')
    // Reading back steps the prompt down by the rows asked for, and the way
    // back to the tail is the same frame it left — not one that lost the gap.
    expect(browsing[0]).not.toContain('anchor this prompt')
    expect(browsing[4]).toContain('anchor this prompt')
    expect(browsing.join('\n')).toContain('3 rows above')
    expect(returned[1]).toContain('anchor this prompt')
    expect(returned.slice(0, 14)).toEqual(anchored.slice(0, 14))
  }, E2E_TEST_TIMEOUT_MS)

  it('says how far back it is, at the foot of the screen, and clicks home', async () => {
    const rows = 12
    const wheelUp = '\u001B[<64;10;5M'
    // Press and release on the notice itself, wherever the frame painted it.
    const clickNotice = '\u001B[<0;6;{row:rows above}M\u001B[<0;6;{row:rows above}m'
    const run = await drivePtySteps('sticky', [
      ['Welcome to codsh', `first sticky prompt${ENTER}`, 300],
      ['STICKY_FIRST_44', `second sticky prompt${ENTER}`, 500],
      ['51 tokens', wheelUp.repeat(6), 400],
      ['rows above', clickNotice, 400],
      ['', `/exit${ENTER}`, 300],
    ], { rows })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const browsing = screenOf(captured(run.offsets[3]), -1, rows).alternate
    const returned = screenOf(captured(run.offsets[4]), -1, rows).alternate
    const noticeAt = browsing.findIndex(row => row.includes('rows above'))
    // The input divider is the last full-width rule: the sticky panel may carry
    // its own divider above the transcript.
    const boxAt = browsing.findLastIndex(row => {
      const trimmed = row.trim()
      return /^─+$/u.test(trimmed) && trimmed.length > 20
    })
    // Under what is being read, not over it: the last transcript row, right
    // above the box — and it names the click that ends the scroll.
    expect(noticeAt).toBe(boxAt - 1)
    expect(browsing[noticeAt]).toContain('click or PgDn')
    expect(returned.join('\n')).not.toContain('rows above')
    expect(returned.join('\n')).toContain('STICKY_SECOND_DONE')
  }, E2E_TEST_TIMEOUT_MS)

  it('says a newer codsh is out, once, under the welcome', async () => {
    const registry = await fakeRegistry('99.0.0')
    try {
      const output = await drivePty('write', [
        ['Welcome to codsh', '', 900],
        ['', `/exit${ENTER}`, 400],
      ], { env: { CODSH_UPDATE_CHECK: 'on', CODSH_UPDATE_REGISTRY: registry.base } })
      const rows = screenAt(output, 'is available').alternate

      // One dim line under the greeting, naming the command that acts on it —
      // it never grows the chrome and never installs anything by itself.
      expect(rows.filter(row => row.includes('codsh 99.0.0 is available'))).toHaveLength(1)
      expect(rows.join('\n')).toContain('/update installs it')
      expect(output).not.toContain('npm install -g')
    } finally {
      await registry.close()
    }
  }, E2E_TEST_TIMEOUT_MS)
})
