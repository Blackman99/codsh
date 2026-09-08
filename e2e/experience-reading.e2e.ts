/**
 * The experience checklist: what a person notices in the first five minutes,
 * asserted at the screen level before a person has to.
 *
 * Every entry started life as a real complaint — a menu that hid its tail, a
 * wheel that scrolled backwards, a clock that reset per step, a flickering
 * hint row, a bare welcome, a wall of output. The checklist is split by topic
 * because Vitest parallelises by file: the run takes as long as its largest
 * file. This file: Markdown rendering, `/copy`, `/view`,
 * and `/diff`.
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { PTY_COLUMNS, drivePty, drivePtySteps, screenOf, screenAt } from './pty-driver.ts'
import { ENTER } from './pty-helpers.ts'
import { Terminal } from './vt.ts'

describe.skipIf(process.platform === 'win32')('the first five minutes: rendering, copy, view, diff', () => {
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
    // Inline HTML painted, not printed: the gain reached the terminal in the
    // theme's green, the entity is its character, and no tag is on screen.
    expect(output).toContain('\u001B[32mCODE_CLI_GAIN\u001B[0m')
    expect(rows.some(row => row.includes('Gain: CODE_CLI_GAIN & held'))).toBe(true)
    expect(text).not.toContain('<font')
    expect(text).not.toContain('&amp;')
  }, E2E_TEST_TIMEOUT_MS)

  it('copies raw answers and fence-free code by stable content address', async () => {
    const markdown = [
      '# CODE_CLI_HEADING',
      '',
      'Prose with **bold**, *em*, `inline_code`, and a [link](https://x.dev).',
      'An identifier like some_helper_name must survive intact.',
      // `/copy` hands back the raw answer: the tag and the entity as written.
      'Gain: <font color="green">CODE_CLI_GAIN</font> &amp; <b>held</b>',
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

  it('copies the diff the reader is showing, which /copy cannot address', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'codsh-copy-'))
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
    }
    try {
      await writeFile(join(repo, 'tracked.ts'), 'const before = 1\n')
      git('init', '-q')
      git('add', '-A')
      git('-c', 'user.email=e2e@codsh', '-c', 'user.name=e2e', 'commit', '-qm', 'base')
      await writeFile(join(repo, 'tracked.ts'), 'const after = 2\n')

      const output = await drivePty('markdown', [
        ['Welcome to codsh', `/diff${ENTER}`, 500],
        // `c` inside the reader; the clipboard write is the OSC 52 the
        // terminal receives, which is the only proof available here.
        ['c copies', 'c', 400],
        ['copied', '\u001B', 300],
        ['Ask anything', `/exit${ENTER}`, 400],
      ], { cwd: repo, rows: 14 })

      // OSC 52 carries the payload base64-encoded.
      const written = /\u001B\]52;c;([A-Za-z0-9+/=]+)\u0007/u.exec(output)?.[1] ?? ''
      expect(written).not.toBe('')
      const text = Buffer.from(written, 'base64').toString()
      expect(text).toContain('-const before = 1')
      expect(text).toContain('+const after = 2')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)

  it('reads /diff in the pager instead of scrolling it past', async () => {
    // A real repository with a real uncommitted change: `/diff` shells out to
    // git, so a fixture that only looks like one would prove nothing.
    const repo = await mkdtemp(join(tmpdir(), 'codsh-diff-'))
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
    }
    try {
      await writeFile(join(repo, 'tracked.ts'), Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1}`).join('\n'))
      git('init', '-q')
      git('-c', 'user.email=e2e@codsh', '-c', 'user.name=e2e', 'commit', '-qam', 'base', '--allow-empty')
      git('add', '-A')
      git('-c', 'user.email=e2e@codsh', '-c', 'user.name=e2e', 'commit', '-qm', 'tracked')
      await writeFile(join(repo, 'tracked.ts'), Array.from({ length: 40 }, (_, index) => `const CHANGED${index + 1} = ${index + 1}`).join('\n'))

      const run = await drivePtySteps('markdown', [
        ['Welcome to codsh', `/diff${ENTER}`, 500],
        ['Esc closes', '\u001B[6~', 300],
        ['Esc closes', '\u001B[F', 300],
        ['Esc closes', '\u001B', 300],
        ['Ask anything', `/exit${ENTER}`, 400],
      ], { rows: 12, cwd: repo })
      const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
      const at = (index: number): string[] => screenOf(captured(run.offsets[index]), -1, 12).alternate
      const before = at(0)
      const opened = at(1)
      const paged = at(2)
      const ended = at(3)
      const restored = at(4)

      expect(opened[0]).toContain('Uncommitted changes')
      expect(opened.at(-1)).toContain('Esc closes')
      expect(opened.join('\n')).toContain('tracked.ts')
      // The first screen is the removals; 87 diff lines do not fit 12 rows.
      expect(opened.join('\n')).toContain('-const line1 = 1')
      expect(opened.join('\n')).not.toContain('CHANGED')
      // The box is gone while the reader holds the screen.
      expect(opened.join('\n')).not.toContain('Ask anything')
      // Paging moves, and the far end carries the additions — which is the
      // whole point of not writing all 87 lines into the transcript.
      expect(paged).not.toEqual(opened)
      expect(ended.join('\n')).toContain('CHANGED')
      // Esc gives the conversation back — and the diff it just read stayed in
      // the reader: the transcript carries the command's own echo and nothing
      // else, which is the difference from writing 87 lines into it.
      expect(restored.join('\n')).toContain('Ask anything')
      expect(restored.join('\n')).not.toContain('CHANGED')
      expect(restored.join('\n')).not.toContain('@@ -1,40')
      expect(restored.join('\n')).not.toContain('Esc closes')
      expect(before.join('\n')).not.toContain('CHANGED')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
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
})
