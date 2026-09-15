/**
 * One appended session event renders to finished terminal lines. Cards come
 * from the registered presenters, and a missing or throwing presenter degrades
 * to the generic line rather than breaking the transcript.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { createTheme, displayWidth } from '../src/theme.ts'
import { gutter } from '../src/gutter.ts'
import { Transcript, blockRules, childSessionId, formatAskUserQuestionResult, formatToolCardLine, presentAskUserQuestionResult, thinkingFold, thinkingFoldRules, thinkingLineRule, thinkingOpenRows, type ToolPresenters } from '../src/transcript.ts'
import type { Density } from '../src/density.ts'

const theme = createTheme(false, {})
const CWD = '/repo'

/**
 * Build a transcript over fixed presenter answers.
 * @param presenters - partial presenter answers; absent methods return undefined.
 * @returns the transcript under test.
 */
function build(presenters: Partial<ToolPresenters> = {}): Transcript {
  return new Transcript({ theme, columns: 80, cwd: CWD }, {
    call: presenters.call ?? (() => undefined),
    result: presenters.result ?? (() => undefined),
  })
}

/** A `tool/call` event for `name` with `args` already serialized. */
function callEvent(callId: string, name: string, args: unknown): SessionEvent {
  return { type: 'tool/call', seq: 1, time: 0, data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } } as SessionEvent
}

/** A `tool/result` event pairing with `callId`. */
function resultEvent(callId: string, text: string, isError = false, meta?: unknown): SessionEvent {
  return {
    type: 'tool/result',
    seq: 2,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }],
        source: { kind: 'tool', callId },
      },
      ...meta === undefined ? {} : { meta },
    },
  } as unknown as SessionEvent
}

describe('assistant and user messages', () => {
  it('renders assistant text', () => {
    const event = {
      type: 'assistant/message',
      seq: 1,
      time: 0,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model' } } },
    } as unknown as SessionEvent
    expect(build().render(event)).toEqual(['done', ''])
  })

  it('does not stack the answer\'s leading or trailing blanks onto the separator', () => {
    // Models often wrap a sentence in extra newlines. Each one used to survive
    // Markdown and then sit under the separator the card already prints, so a
    // tool run and the next sentence were two or three empty rows apart.
    const event = (text: string): SessionEvent => ({
      type: 'assistant/message',
      seq: 1,
      time: 0,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } },
    } as unknown as SessionEvent)
    expect(build().render(event('\n\ndone\n\n'))).toEqual(['done', ''])
    expect(build().render(event('one\n\ntwo'))).toEqual(['one', '', 'two', ''])
  })

  it('lays out a wide table within the transcript columns, so replayed tables do not overflow', () => {
    const transcript = build()
    const wideTable = [
      '| 阶段 | 对应技能 | 核心行为与约束 |',
      '|---|---|---|',
      '| Phase 0: Pre-flight | 环境自检与隔离 | 执行 git status 检查工作区清洁度；脏状态触发交互提示（Stash / Carry / Abort）；根据一句话需求生成 slug，切出 ship/<slug> 独立特性分支，保证主分支安全。 |',
    ].join('\n')
    const event = {
      type: 'assistant/message',
      seq: 1,
      time: 0,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: wideTable }], source: { kind: 'model' } } },
    } as unknown as SessionEvent
    const lines = transcript.render(event)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(80)
    }
  })

  it('separates assistant text from a preceding tool call with a blank line', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'bash', { command: 'git status' }))
    transcript.render(resultEvent('c1', 'working tree clean'))
    const assistant = {
      type: 'assistant/message',
      seq: 3,
      time: 0,
      data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'All done!' }], source: { kind: 'model' } } },
    } as unknown as SessionEvent
    expect(transcript.render(assistant)).toEqual(['All done!', ''])
  })

  it('drops an assistant message carrying no visible text', () => {
    const event = {
      type: 'assistant/message',
      seq: 1,
      time: 0,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }], source: { kind: 'model' } } },
    } as unknown as SessionEvent
    expect(build().render(event)).toEqual([])
  })

  it('renders the human prompt — the box clears on submit, so this is its only copy', () => {
    const event = {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }], source: { kind: 'user' } },
    } as unknown as SessionEvent
    const transcript = build()
    expect(transcript.render(event)).toEqual(['fix the bug', ''])
    expect(transcript.takePrompt()).toBe(1)
    expect(transcript.takePrompt()).toBeUndefined()
  })

  it('aligns a multi-line prompt under its marker, matching the input box', () => {
    const event = {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: { role: 'user', content: [{ type: 'text', text: 'first line\nsecond line' }], source: { kind: 'user' } },
    } as unknown as SessionEvent
    const transcript = build()
    expect(transcript.render(event)).toEqual(['first line', '  second line', ''])
    expect(transcript.takePrompt()).toBe(2)
  })

  it('does not count generated image metadata as an explicit prompt line', () => {
    const event = {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'text', text: '<pasted-image id="1" dimensions="20x10" media="image/png"><description>context</description></pasted-image>' },
        ],
        source: { kind: 'user' },
      },
    } as unknown as SessionEvent
    const transcript = build()
    expect(transcript.render(event)).toEqual([
      'describe this',
      '  [image #1 · 20×10 png · described]',
      '',
    ])
    expect(transcript.takePrompt()).toBe(1)
  })

  it('shows nothing for injected plugin context', () => {
    const event = {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: { role: 'user', content: [{ type: 'text', text: 'AGENTS.md' }], source: { kind: 'plugin', plugin: 'agent-instructions' } },
    } as unknown as SessionEvent
    const transcript = build()
    expect(transcript.render(event)).toEqual([])
    expect(transcript.takePrompt()).toBeUndefined()
  })

  it('reports a failed turn', () => {
    const event = {
      type: 'turn/end',
      seq: 1,
      time: 0,
      data: { turn: 1, reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no API key' } } },
    } as unknown as SessionEvent
    expect(build().render(event)).toEqual(['✗ MISSING_CREDENTIAL: no API key', ''])
  })

  it('shows nothing for a completed turn', () => {
    const event = { type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason: { kind: 'completed' } } } as unknown as SessionEvent
    expect(build().render(event)).toEqual([])
  })

  it('shows nothing for an event type this surface does not render', () => {
    const event = { type: 'step/start', seq: 1, time: 0, data: { turn: 1, step: 1 } } as SessionEvent
    expect(build().render(event)).toEqual([])
  })
})

describe('session state', () => {
  /** A `todo/write` snapshot event. */
  const todoEvent = (todos: { content: string; status: string }[]): SessionEvent =>
    ({ type: 'todo/write', seq: 1, time: 0, data: { todos } }) as unknown as SessionEvent

  it('renders the todo list with its progress', () => {
    const lines = build().render(todoEvent([
      { content: 'read the code', status: 'completed' },
      { content: 'write the fix', status: 'in_progress' },
      { content: 'run the tests', status: 'pending' },
    ]))
    expect(lines).toEqual([
      'todos 1/3 · 1 in progress · 1 open',
      '  ✔ read the code',
      '  ▶ write the fix',
      '  ○ run the tests',
      '',
    ])
  })

  it('shows nothing for an emptied todo list', () => {
    expect(build().render(todoEvent([]))).toEqual([])
  })

  it('says what plan mode means when it engages', () => {
    const event = { type: 'plan/mode', seq: 1, time: 0, data: { active: true } } as unknown as SessionEvent
    const [line] = build().render(event)
    expect(line).toContain('plan mode')
    expect(line).toContain('no files will change')
  })

  it('reports plan mode leaving', () => {
    const event = { type: 'plan/mode', seq: 1, time: 0, data: { active: false } } as unknown as SessionEvent
    expect(build().render(event)[0]).toContain('plan mode off')
  })
})

describe('tool cards', () => {
  it('falls back to the tool name when no presenter is registered', () => {
    expect(build().render(callEvent('c1', 'grep', { pattern: 'x' }))).toEqual(['● grep'])
  })

  it('renders a terminal call as one row naming the command and its workspace-relative cwd', () => {
    const call = (): ToolCallView => ({ card: 'terminal', title: 'pnpm test', cwd: '/repo/apps', description: 'run the suite' })
    const result = (): ToolResultView => ({ card: 'terminal', title: 'pnpm test', output: 'ok' })
    const transcript = build({ call, result })
    // The row names what the finished row will name, so the result takes its
    // place without the card growing and shrinking.
    expect(transcript.render(callEvent('c1', 'bash', {}))).toEqual(['● pnpm test (apps)'])
    // The description rides into the finished card's fold, over the output,
    // and the count names both: it is what the row withholds.
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● pnpm test · 2 lines ✔', ''])
    expect(transcript.takeFold()).toEqual(['● pnpm test · 2 lines ✔', '  run the suite', '  ok', ''])
  })

  it('records a diff call without painting — the result owns the one-liner', () => {
    const call = (): ToolCallView => ({ card: 'diff', title: 'Write', diffs: [{ path: '/repo/src/a.ts', oldText: null, newText: 'x' }] })
    const transcript = build({ call })
    expect(transcript.render(callEvent('c1', 'write', {}))).toEqual([])
    expect(transcript.callSummary('c1')).toBe('src/a.ts')
  })

  it('renders a generic call with its follow-along locations', () => {
    const call = (): ToolCallView => ({ card: 'generic', title: 'Read a.ts', locations: [{ path: '/repo/src/a.ts' }] })
    expect(build({ call }).render(callEvent('c1', 'read', {}))).toEqual(['● Read a.ts src/a.ts'])
  })

  it('still records the call when its arguments do not parse', () => {
    const event = { type: 'tool/call', seq: 1, time: 0, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{oops' } } as SessionEvent
    const transcript = build()
    expect(transcript.render(event)).toEqual(['● bash'])
    expect(transcript.render(resultEvent('c1', 'out'))).toEqual(['● bash · 1 line ✔', ''])
    expect(transcript.takeFold()).toEqual(['● bash · 1 line ✔', '  out', ''])
  })

  it('degrades to the generic line when a call presenter throws', () => {
    const call = () => { throw new Error('presenter is broken') }
    expect(build({ call }).render(callEvent('c1', 'grep', {}))).toEqual(['● grep'])
  })
})

describe('tool results', () => {
  it('pairs a result with its call and keeps the body behind the row', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'grep', {}))
    // Completed tools always reprint one stable head line (marker · title ·
    // count · ✔); the body is the fold's, one click or Ctrl+O away.
    expect(transcript.render(resultEvent('c1', 'two matches'))).toEqual(['● grep · 1 line ✔', ''])
    expect(transcript.takeFold()).toEqual(['● grep · 1 line ✔', '  two matches', ''])
  })

  it('marks a failed call, and names its reason on the row', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'bash', {}))
    // One row still, but a failure says why: the first line of what came
    // back rides in the stats, and a one-line reason needs no count.
    expect(transcript.render(resultEvent('c1', 'exit 1', true))[0]).toBe('● bash exit 1 ✗')
    expect(transcript.takeFold()).toEqual(['● bash exit 1 ✗', '  exit 1', ''])
  })

  it('cuts a long failure reason and counts the lines behind it', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'read', {}))
    const text = `ENOENT: no such file or directory, open ${'/very/long/path/'.repeat(6)}a.ts\n    at readFile\n    at run`
    const [row] = transcript.render(resultEvent('c1', text, true))
    expect(row).toMatch(/^● read ENOENT: no such file or directory.*… · 3 lines ✗$/u)
    // Half the width is the reason's room, so the title keeps its own.
    expect(displayWidth(row ?? '')).toBeLessThan(80)
    expect((transcript.takeFold() ?? []).join('\n')).toContain('at readFile')
  })

  it('takes the first line with text as the reason, and leaves no gap when the text opens blank', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'read', {}))
    const [row] = transcript.render(resultEvent('c1', '\nENOENT: no such file or directory, open x.ts', true))
    expect(row).toMatch(/^● read ENOENT: no such file or directory.* ✗$/u)
    expect(row).not.toContain('  ')
  })

  it('counts the lines that carry text, the way the readout does', () => {
    const result = (): ToolResultView => ({ card: 'terminal', title: 'pnpm test', output: 'a\n\nb\n\nc' })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    // Two blank rows are in the fold, but not a reason to open the card.
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● pnpm test · 3 lines ✔', ''])
    expect(transcript.takeFold()).toHaveLength(7)
  })

  it('budgets a pending command for the rule beside it, so the row never wraps', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const command = `pnpm exec vitest run ${'packages/bundle/tests/very-long-name.spec.ts '.repeat(3)}--reporter=dot`
    const transcript = new Transcript({ theme: colorTheme, columns: 80, cwd: CWD }, {
      call: (): ToolCallView => ({ card: 'terminal', title: command, cwd: '/repo/apps' }),
      result: () => undefined,
    })
    const [, row = ''] = transcript.render(callEvent('c1', 'bash', {}))
    // The screen paints `│ ` beside the row: the row itself fits what is left.
    expect(displayWidth(row)).toBeLessThanOrEqual(80 - 2)
    expect(row).toContain('(apps)')
  })

  it('names the executor reason when a terminal call failed before it printed', () => {
    const result = (): ToolResultView => ({ card: 'terminal', title: 'pnpm test' })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    // No exit code and no output: the row would say nothing about why, so
    // it names what the result block says instead.
    expect(transcript.render(resultEvent('c1', 'sandbox refused the command', true))[0]).toBe('● pnpm test sandbox refused the command ✗')
  })

  it('renders ask_user_question result directly as the user reply instead of raw json', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'ask_user_question', { questions: [{ id: 'q1', question: 'Which mode?' }] }))
    const resultJson = JSON.stringify({ answers: [{ id: 'q1', selected: ['Fast mode (Recommended)'] }] })
    expect(transcript.render(resultEvent('c1', resultJson))).toEqual(['● ask_user_question · 1 line ✔', ''])
    expect(transcript.takeFold()).toEqual(['● ask_user_question · 1 line ✔', '  Fast mode (Recommended)', ''])
  })

  it('renders custom reply for ask_user_question directly as plain text', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'ask_user_question', { questions: [{ id: 'q1', question: 'Any comments?' }] }))
    const resultJson = JSON.stringify({ answers: [{ id: 'q1', selected: [], custom: 'Please keep existing tests.' }] })
    expect(transcript.render(resultEvent('c1', resultJson))).toEqual(['● ask_user_question · 1 line ✔', ''])
    expect(transcript.takeFold()).toEqual(['● ask_user_question · 1 line ✔', '  Please keep existing tests.', ''])
  })

  it('renders multiple answers for ask_user_question on separate lines', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'ask_user_question', {
      questions: [
        { id: 'q1', question: 'Target?' },
        { id: 'q2', question: 'Confirm?' },
      ],
    }))
    const resultJson = JSON.stringify({
      answers: [
        { id: 'q1', selected: ['Production'] },
        { id: 'q2', custom: 'yes proceed' },
      ],
    })
    expect(transcript.render(resultEvent('c1', resultJson))).toEqual(['● ask_user_question · 2 lines ✔', ''])
    expect(transcript.takeFold()).toEqual(['● ask_user_question · 2 lines ✔', '  Production', '  yes proceed', ''])
  })

  it('renders no body when ask_user_question answers are empty (aborted/dismissed)', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'ask_user_question', { questions: [{ id: 'q1', question: 'Confirm?' }] }))
    const resultJson = JSON.stringify({ answers: [{ id: 'q1', selected: [] }] })
    expect(transcript.render(resultEvent('c1', resultJson))).toEqual([
      '● ask_user_question ✔',
      '',
    ])
  })

  it('shows a workflow run as it goes, instead of only when it returns', () => {
    // `/ship`'s ralph loop spends minutes per round and showed nothing at all
    // until the whole run came back. These four events are its only progress.
    const transcript = build()
    const run = (type: string, data: Record<string, unknown>): SessionEvent =>
      ({ type, seq: 1, time: 0, data } as unknown as SessionEvent)

    expect(transcript.render(run('tool-workflow/run-start', { runId: 'r1', name: 'ralph' })))
      .toEqual(['● ralph'])
    expect(transcript.render(run('tool-workflow/agent-start', {
      runId: 'r1', seq: 1, label: 'Ralph round 1', phase: 'Fresh-agent rounds', childId: 'c1',
    }))).toEqual([])
    // The round that settled names itself; the one still running is the
    // working line's job, because an append-only transcript cannot unprint it.
    expect(transcript.render(run('tool-workflow/agent-end', { runId: 'r1', seq: 1, outcome: 'completed' })))
      .toEqual(['  ✓ Ralph round 1'])
    // No door: a workflow's children run in a worker thread, so their
    // sessions are not in this process to enter.
    expect(transcript.takeEnter()).toBeUndefined()
    // A round the surface watched says what it did on its end line — the
    // proof that a round which showed nothing while it ran was working.
    transcript.render(run('tool-workflow/agent-start', { runId: 'r1', seq: 2, label: 'Ralph round 2', childId: 'c2' }))
    transcript.noteRoundWork('r1', 2, '48 calls · 2m40s')
    expect(transcript.render(run('tool-workflow/agent-end', { runId: 'r1', seq: 2, outcome: 'completed' })))
      .toEqual(['  ✓ Ralph round 2 · 48 calls · 2m40s'])
    transcript.render(run('tool-workflow/agent-start', { runId: 'r1', seq: 3, label: 'Ralph round 3', childId: 'c3' }))
    transcript.noteRoundWork('r1', 3, '1.2s')
    expect(transcript.render(run('tool-workflow/agent-end', { runId: 'r1', seq: 3, outcome: 'failed' })))
      .toEqual(['  ✗ Ralph round 3 (failed) · 1.2s'])
    expect(transcript.render(run('tool-workflow/run-end', { runId: 'r1', stopReason: 'completed' })))
      .toEqual(['  completed', ''])
  })

  it('marks a round that did not complete, and still names it', () => {
    const transcript = build()
    transcript.render({ type: 'tool-workflow/agent-start', seq: 1, time: 0, data: {
      runId: 'r1', seq: 7, label: 'Ralph round 7', childId: 'c7',
    } } as unknown as SessionEvent)
    expect(transcript.render({ type: 'tool-workflow/agent-end', seq: 2, time: 0, data: {
      runId: 'r1', seq: 7, outcome: 'failed',
    } } as unknown as SessionEvent)).toEqual(['  ✗ Ralph round 7 (failed)'])
    expect(transcript.takeEnter()).toBeUndefined()
  })

  it('falls back to the sequence when an end arrives without its start', () => {
    // A resumed log can begin mid-run; the line still has to say something.
    const transcript = build()
    expect(transcript.render({ type: 'tool-workflow/agent-end', seq: 1, time: 0, data: {
      runId: 'r1', seq: 3, outcome: 'completed',
    } } as unknown as SessionEvent)).toEqual(['  ✓ round 3'])
    expect(transcript.takeEnter()).toBeUndefined()
  })

  it('renders a diff result as a folded ToolCard with +n -m', () => {
    const result = (): ToolResultView => ({
      card: 'diff',
      title: 'Edit',
      diffs: [{ path: '/repo/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }],
    })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'edit', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Edit +1 -1 ✔', ''])
    const fold = transcript.takeFold() ?? []
    expect(fold[0]).toBe('● Edit +1 -1 ✔')
    expect(fold).toContain('- const a = 1')
    expect(fold).toContain('+ const a = 2')
  })

  it('hands a long diff to the reader instead of expanding it in place', () => {
    // Every line moves, so the single hunk outgrows the card's 24-line body.
    const oldText = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n')
    const newText = Array.from({ length: 30 }, (_, index) => `LINE ${index + 1}`).join('\n')
    const result = (): ToolResultView => ({ card: 'diff', title: 'Edit', diffs: [{ path: '/repo/a.ts', oldText, newText }] })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'edit', {}))
    const lines = transcript.render(resultEvent('c1', 'ok'))

    expect(lines).toEqual(['● Edit +30 -30 ✔', ''])
    const fold = transcript.takeFold() ?? []
    expect(fold[0]).toBe('● Edit +30 -30 ✔')
    expect(fold.join('\n')).toContain('- line 30')
    expect(fold.join('\n')).toContain('+ LINE 30')
    expect(lines.join('\n')).not.toContain('- line 1')
    const page = transcript.takePage()
    expect(page).toContain('--- a/a.ts')
    expect(page).toContain('-line 30')
    expect(page).toContain('+LINE 30')
    // Taken once, like every other side channel on the transcript.
    expect(transcript.takePage()).toBeUndefined()
  })

  it('folds a short diff behind the ToolCard head, with nothing for the reader', () => {
    const result = (): ToolResultView => ({
      card: 'diff',
      title: 'Edit',
      diffs: [{ path: '/repo/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }],
    })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'edit', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Edit +1 -1 ✔', ''])
    const fold = transcript.takeFold() ?? []
    expect(fold).toContain('- const a = 1')
    expect(fold).toContain('+ const a = 2')
    expect(transcript.takePage()).toBeUndefined()
  })

  it('reports the paths a diff card wrote, once', () => {
    // A `/ship` run keeps its plan in a spec file; the surface finds that file
    // by watching it written rather than guessing where the repo keeps specs.
    const result = (): ToolResultView => ({
      card: 'diff',
      diffs: [
        { path: '/repo/docs/specs/pager.md', oldText: 'a', newText: 'b' },
        { path: '/repo/src/pager.ts', oldText: 'a', newText: 'b' },
      ],
    })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'edit', {}))
    transcript.render(resultEvent('c1', 'ok'))
    expect(transcript.takeWritten()).toEqual(['/repo/docs/specs/pager.md', '/repo/src/pager.ts'])
    expect(transcript.takeWritten()).toEqual([])
  })

  it('reports nothing written for a card that changed no file', () => {
    const result = (): ToolResultView => ({ card: 'terminal', title: 'ls', output: 'a' })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    transcript.render(resultEvent('c1', 'ok'))
    expect(transcript.takeWritten()).toEqual([])
  })

  it('renders a created file as all additions', () => {
    const result = (): ToolResultView => ({ card: 'diff', diffs: [{ path: '/repo/a.ts', oldText: null, newText: 'a\nb' }] })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'write', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● write +2 -0 ✔', ''])
    expect(transcript.takeFold() ?? []).toEqual(['● write +2 -0 ✔', '+ a', '+ b', ''])
  })

  it('shows a non-zero exit status on a terminal result', () => {
    const result = (): ToolResultView => ({ card: 'terminal', title: 'pnpm test', output: 'failed', exitCode: 1 })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    // No call presenter here, so the pending title was the tool name: the
    // result's own title differs, which is what brings the header back.
    expect(transcript.render(resultEvent('c1', 'failed'))).toEqual(['● pnpm test (exit 1) · 1 line ✔', ''])
    expect(transcript.takeFold()).toEqual(['● pnpm test (exit 1) · 1 line ✔', '  failed', ''])
  })

  it('reports a signal kill instead of an exit code', () => {
    const result = (): ToolResultView => ({ card: 'terminal', title: 'sleep', signal: 'SIGTERM' })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', ''))[0]).toBe('● sleep (killed by SIGTERM) ✔')
  })

  it('groups search matches by file', () => {
    const result = (): ToolResultView => ({
      card: 'search',
      shape: 'matches',
      files: [{ path: '/repo/a.ts', matches: [{ lineNumber: 3, line: 'const a = 1' }] }],
      truncated: false,
      total: 1,
    })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'grep', {}))
    // The count of results already says the row withholds something.
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● grep 1 results ✔', ''])
    expect(transcript.takeFold()).toEqual(['● grep 1 results ✔', '  a.ts', '    3: const a = 1', ''])
  })

  it('marks a capped search as capped', () => {
    const result = (): ToolResultView => ({ card: 'search', shape: 'paths', paths: ['/repo/a.ts'], truncated: true, total: 900 })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'glob', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))[0]).toBe('● glob 900+ (capped) results ✔')
  })

  it('folds consecutive similar terminal cards into one instead of stacking them', () => {
    const command = 'export PATH="/tmp/openbot-chat-node:$PATH" && pnpm --filter @openbot/web exec playwright test --config playwright.local.config.ts'
    let current = { name: 'Baseline three-bot start Playwright grep', output: 'Error: No tests found\n\nundefined\n/Users/zhaodongsheng/my-projects/openbot/apps/web:' }
    const transcript = build({
      call: () => ({ card: 'terminal', title: command, description: current.name }),
      result: () => ({ card: 'terminal', title: command, output: current.output }),
    })
    transcript.render(callEvent('c1', 'bash', {}))
    const first = transcript.render(resultEvent('c1', 'ok'))
    expect(first[0]).toContain('export PATH=')
    expect(first).toHaveLength(2)
    const firstFull = transcript.takeFold() ?? []
    expect(firstFull.join('\n')).toContain('Baseline three-bot start Playwright grep')
    expect(firstFull.join('\n')).toContain('Error: No tests found')

    current = { name: 'Baseline three-bot refusal Playwright grep', output: 'Error: No tests found\n\nundefined\n/Users/zhaodongsheng/my-projects/openbot/apps/web:' }
    transcript.render(callEvent('c2', 'bash', {}))
    const second = transcript.render(resultEvent('c2', 'ok'))
    // One row for the run: the count says it holds more than one.
    expect(second[0]).toContain('· 2 similar')
    expect(second).toHaveLength(2)
    expect(second.join('\n')).not.toContain('Baseline three-bot refusal')
    const replaced = transcript.takePendingCard()
    expect(replaced[0]).toBe(first[0])
    // The first card and the second call's pending row are what it replaces.
    expect(replaced).toHaveLength(3)
    expect(replaced[2]).toContain('● export PATH=')
    const full = transcript.takeFold() ?? []
    expect(full.join('\n')).toContain('Baseline three-bot start Playwright grep')
    expect(full.join('\n')).toContain('Baseline three-bot refusal Playwright grep')

    current = { name: 'Baseline pairing Playwright grep', output: 'Error: No tests found\n\nundefined\n/Users/zhaodongsheng/my-projects/openbot/apps/web:' }
    transcript.render(callEvent('c3', 'bash', {}))
    const third = transcript.render(resultEvent('c3', 'ok'))
    expect(third[0]).toContain('· 3 similar')
    expect(third).toHaveLength(2)
  })

  it('does not fold a later card whose command or output shape is different', () => {
    const titles = ['pnpm test', 'pnpm test', 'git status']
    const outputs = ['Error: No tests found', 'Error: No tests found', 'On branch main']
    let index = 0
    const transcript = build({
      call: () => ({ card: 'terminal', title: titles[index] ?? '' }),
      result: () => ({ card: 'terminal', title: titles[index] ?? '', output: outputs[index] ?? '' }),
    })
    transcript.render(callEvent('c1', 'bash', {}))
    transcript.render(resultEvent('c1', 'ok'))
    index = 1
    transcript.render(callEvent('c2', 'bash', {}))
    const second = transcript.render(resultEvent('c2', 'ok'))
    expect(second[0]).toContain('· 2 similar')
    index = 2
    transcript.render(callEvent('c3', 'bash', {}))
    const third = transcript.render(resultEvent('c3', 'ok'))
    expect(third[0]).toContain('git status')
    expect(third[0]).not.toContain('similar')
    expect((transcript.takeFold() ?? []).join('\n')).toContain('On branch main')
  })

  it('reprints one stable head with exit status rather than a continuation-only line', () => {
    const call = (): ToolCallView => ({ card: 'terminal', title: 'pnpm test' })
    const result = (): ToolResultView => ({ card: 'terminal', title: 'pnpm test', output: 'out', exitCode: 1 })
    const transcript = build({ call, result })
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', 'failed'))).toEqual(['● pnpm test (exit 1) · 1 line ✔', ''])
  })

  it('summarizes a read as a window of the file', () => {
    const result = (): ToolResultView => ({
      card: 'read',
      path: '/repo/a.ts',
      offset: 1,
      lines: [{ number: 1, text: 'x' }],
      totalLines: 12,
    })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'read', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● read 1 of 12 lines ✔', ''])
  })

  it('prints an unpaired result rather than dropping it', () => {
    const transcript = build()
    expect(transcript.render(resultEvent('missing', 'orphan'))).toEqual(['● (result) · 1 line', ''])
    expect(transcript.takeFold()).toEqual(['● (result) · 1 line', '  orphan', ''])
  })

  it('folds consecutive unpaired results into one card instead of stacking them', () => {
    // A resumed page-boundary dumps a run of raw results. Each one used to
    // open its own panel with a preview and a fold hint, so a burst of reads
    // filled the viewport with the same `(result)` head over and over.
    const transcript = build()
    const first = transcript.render(resultEvent('c1', 'alpha\nbeta'))
    expect(first).toEqual(['● (result) · 2 lines', ''])
    expect(transcript.takeFold()).toEqual(['● (result) · 2 lines', '  alpha', '  beta', ''])

    const second = transcript.render(resultEvent('c2', 'gamma\ndelta'))
    expect(second).toEqual(['● (result) · 2 results', ''])
    expect(transcript.takePendingCard()).toEqual(first)
    const full = transcript.takeFold() ?? []
    expect(full.join('\n')).toContain('alpha')
    expect(full.join('\n')).toContain('gamma')
    expect(full[0]).toBe('● (result) · 2 results')

    const third = transcript.render(resultEvent('c3', 'epsilon'))
    expect(third[0]).toBe('● (result) · 3 results')
    expect(transcript.takePendingCard()).toEqual(second)
    expect((transcript.takeFold() ?? []).join('\n')).toContain('epsilon')
  })

  it('paints a coalesced orphan fold as one panel, not stacked cards', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const transcript = new Transcript(
      { theme: colorTheme, columns: 80, cwd: CWD },
      { call: () => undefined, result: () => undefined },
    )
    transcript.render(resultEvent('c1', 'alpha'))
    const second = transcript.render(resultEvent('c2', 'beta'))
    // The pad the run opened with stays its inset when the head is rebuilt.
    expect(second).toEqual([
      colorTheme.bgTool('  '),
      colorTheme.bgTool(`  ${colorTheme.ok('●')} ${colorTheme.dim('(result)')} ${colorTheme.dim('· 2 results')}`),
      colorTheme.bgTool('  '),
    ])
  })

  it('does not fold an unpaired result into a paired card of a different kind', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'bash', {}))
    const paired = transcript.render(resultEvent('c1', 'ok'))
    expect(paired).toEqual(['● bash · 1 line ✔', ''])
    const orphan = transcript.render(resultEvent('missing', 'later'))
    expect(orphan).toEqual(['● (result) · 1 line', ''])
    expect(transcript.takePendingCard()).toEqual([])
  })

  it('degrades to the generic card when a result presenter throws', () => {
    const result = () => { throw new Error('presenter is broken') }
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'grep', {}))
    expect(transcript.render(resultEvent('c1', 'two matches'))).toEqual(['● grep · 1 line ✔', ''])
  })

  it('confirms a completion that carries no body', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'todo_write', {}))
    // Nothing to show and nothing changed, but the call must not look pending.
    expect(transcript.render(resultEvent('c1', ''))).toEqual(['● todo_write ✔', ''])
  })

  it('does not repeat a path the presenter already put in its title', () => {
    const call = (): ToolCallView => ({
      card: 'diff',
      title: 'Write /repo/src/a.ts',
      diffs: [{ path: '/repo/src/a.ts', oldText: null, newText: 'x' }],
    })
    const result = (): ToolResultView => ({
      card: 'diff',
      title: 'Write src/a.ts',
      diffs: [{ path: '/repo/src/a.ts', oldText: null, newText: 'x' }],
    })
    const transcript = build({ call, result })
    expect(transcript.render(callEvent('c1', 'write', {}))).toEqual([])
    expect(transcript.render(resultEvent('c1', 'ok'))[0]).toBe('● Write src/a.ts +1 -0 ✔')
  })

  it('appends a path the presenter left out of its title', () => {
    const call = (): ToolCallView => ({
      card: 'diff',
      title: 'Write',
      diffs: [{ path: '/repo/src/a.ts', oldText: null, newText: 'x' }],
    })
    const result = (): ToolResultView => ({
      card: 'diff',
      title: 'Write src/a.ts',
      diffs: [{ path: '/repo/src/a.ts', oldText: null, newText: 'x' }],
    })
    const transcript = build({ call, result })
    expect(transcript.render(callEvent('c1', 'write', {}))).toEqual([])
    expect(transcript.render(resultEvent('c1', 'ok'))[0]).toBe('● Write src/a.ts +1 -0 ✔')
  })

  it('shortens a workspace path a terminal presenter embedded in its command', () => {
    const call = (): ToolCallView => ({ card: 'terminal', title: 'cat /repo/src/a.ts' })
    expect(build({ call }).render(callEvent('c1', 'bash', {}))).toEqual(['● cat src/a.ts'])
  })

  it('does not claim a line for a created file\'s trailing newline', () => {
    const result = (): ToolResultView => ({ card: 'diff', diffs: [{ path: '/repo/a.ts', oldText: null, newText: 'only\n' }] })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'write', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● write +1 -0 ✔', ''])
    expect((transcript.takeFold() ?? []).join('\n')).toContain('+ only')
  })

  it('collapses a long body behind a count on the row', () => {
    const result = (): ToolResultView => ({ card: 'terminal', title: 'pnpm test', output: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    const lines = transcript.render(resultEvent('c1', 'ok'))
    // The row is the whole card: the count is the affordance, and the fold
    // is where the lines are.
    expect(lines).toEqual(['● pnpm test · 30 lines ✔', ''])
    expect((transcript.takeFold() ?? []).join('\n')).toContain('line 29')
  })

  it('counts the description the call came with as a line behind the row', () => {
    const call = (): ToolCallView => ({ card: 'terminal', title: 'pnpm test', description: 'run the suite' })
    const result = (): ToolResultView => ({ card: 'terminal', title: 'pnpm test' })
    const transcript = build({ call, result })
    transcript.render(callEvent('c1', 'bash', {}))
    // Nothing was printed, but the description rides in the fold as the
    // context the call came with, and the row says one line is behind it.
    expect(transcript.render(resultEvent('c1', ''))).toEqual(['● pnpm test · 1 line ✔', ''])
    expect(transcript.takeFold()).toEqual(['● pnpm test · 1 line ✔', '  run the suite', ''])
  })
})

describe('a result body, whole behind its row', () => {
  it('keeps a line wider than a few rows whole behind the fold', () => {
    // One bash result carried a 49,616-character HTML line. The row never
    // shows it; the fold holds it whole, so Ctrl+O reads what the row withheld.
    const wide = `<html>${'<div class="x"></div>'.repeat(200)}</html>`
    const result = (): ToolResultView => ({ card: 'terminal', title: 'curl', output: `${wide}\nshort tail` })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● curl · 2 lines ✔', ''])
    const full = transcript.takeFold() ?? []
    expect(full.some(line => line.includes(wide))).toBe(true)
    expect(full.join('\n')).toContain('short tail')
  })

  it('keeps even a short body behind the row', () => {
    // Same title as the pending card, so the row simply settles in place.
    const result = (): ToolResultView => ({ card: 'terminal', title: 'bash', output: 'a\tb\nc' })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● bash · 2 lines ✔', ''])
    // A tab is flattened at paint, not here: the line is kept as it came.
    expect(transcript.takeFold()).toEqual(['● bash · 2 lines ✔', '  a\tb', '  c', ''])
  })

  it('counts lines, not the rows a wide line would wrap to', () => {
    const output = [`${'w'.repeat(500)}`, ...Array.from({ length: 10 }, (_, i) => `line ${i}`)].join('\n')
    const result = (): ToolResultView => ({ card: 'terminal', title: 'run', output })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● run · 11 lines ✔', ''])
    expect((transcript.takeFold() ?? []).join('\n')).toContain('w'.repeat(500))
  })

  it('keeps an unpaired raw result whole behind its row the same way', () => {
    const transcript = build()
    expect(transcript.render(resultEvent('c9', 'y'.repeat(1000)))).toEqual(['● (result) · 1 line', ''])
    expect((transcript.takeFold() ?? []).join('\n')).toContain('y'.repeat(1000))
  })

  it('paints an unpaired row with the panel fill, and its fold the same way', () => {
    // A resumed page-boundary result has no pending card to pair with. The
    // row and the pad under it carry the tool fill, and so does every body
    // line the fold keeps — no flush strip, no hole in the panel.
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const transcript = new Transcript(
      { theme: colorTheme, columns: 80, cwd: CWD },
      { call: () => undefined, result: () => undefined },
    )
    const lines = transcript.render(resultEvent('c9', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')))
    expect(lines).toEqual([
      colorTheme.bgTool('  '),
      colorTheme.bgTool(`  ${colorTheme.ok('●')} ${colorTheme.dim('(result)')} ${colorTheme.dim('· 20 lines')}`),
      colorTheme.bgTool('  '),
    ])
    const full = transcript.takeFold() ?? []
    expect(full.some(line => line === colorTheme.bgTool(colorTheme.dim('  line 0')))).toBe(true)
  })
})

describe('folding collapsed output', () => {
  it('offers the full event lines when the body was collapsed', () => {
    const long = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')
    const result = (): ToolResultView => ({ card: 'terminal', title: 'run', output: long })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    const shown = transcript.render(resultEvent('c1', long))
    expect(shown).toEqual(['● run · 20 lines ✔', ''])
    const full = transcript.takeFold() ?? []
    // The full form replaces the whole block: same head, uncapped body.
    expect(full[0]).toContain('run')
    expect(full.join('\n')).toContain('line 19')
    // Taken once: the fold belongs to the event that produced it.
    expect(transcript.takeFold()).toBeUndefined()
  })

  it('folds a read card with the content the card withheld', () => {
    const result = (): ToolResultView => ({
      card: 'read',
      path: '/repo/a.ts',
      offset: 1,
      lines: [{ number: 1, text: 'alpha' }, { number: 2, text: 'beta' }],
      totalLines: 2,
    })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'read', {}))
    transcript.render(resultEvent('c1', 'alpha\nbeta'))
    expect((transcript.takeFold() ?? []).join('\n')).toContain('beta')
  })

  it('has no fold before any body collapsed', () => {
    expect(build().takeFold()).toBeUndefined()
  })
})

describe('the forms a long block keeps', () => {
  it('times a thinking block when the surface timed it', () => {
    const { summary, full } = thinkingFold(['  first', '  second'], theme, 3.24)
    expect(summary).toEqual(['thought for 3.2s'])
    expect(full).toContain('thought for 3.2s')
    expect(full).toContain('  second')
  })

  it('keeps inner pads on the collapsed clock so the glyph sits in a panel, not a hole', () => {
    // The pads are the panel's inset, not a gap between neighbouring cards.
    // Hover and the glyph both belong to that inset.
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const pad = colorTheme.bgThinking('  ')
    const clock = colorTheme.bgThinking(colorTheme.dim('  thought for 1.5s'))
    const { summary, full } = thinkingFold(['reasoning line'], colorTheme, 1.5)
    expect(summary).toEqual([pad, clock, pad])
    expect(full[0]).toBe(pad)
    expect(full[1]).toBe(clock)
    expect(full.at(-1)).toBe(pad)
    expect(full).toContain(colorTheme.bgThinking('reasoning line'))
    const rules = thinkingFoldRules(colorTheme, 1)
    expect(rules.summary).toEqual(['  ', blockRules(colorTheme).agent, '  '])
    expect(rules.full).toEqual(['  ', blockRules(colorTheme).agent, '  ', '  ', '  '])
  })

  it('grows a unit for a long think, rather than counting seconds', () => {
    const long = thinkingFold(['a'], theme, 312.4)
    expect(long.summary[0]).toBe('thought for 5m 12s')
    expect(long.summary[0]).not.toContain('312')
  })

  it('says only that it thought when there is no clock to read', () => {
    // A replayed log carries the reasoning but not its duration; claiming a
    // time here would be inventing one.
    const { summary, full } = thinkingFold(['  first'], theme)
    expect(summary[0]).toBe('thought')
    expect(full).toContain('thought')
  })
})

describe('a thought while it streams', () => {
  it('opens with a head the clock will replace, inside the panel', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const pad = colorTheme.bgThinking('  ')
    const { rows, rules } = thinkingOpenRows(colorTheme)
    expect(rows).toEqual([pad, colorTheme.bgThinking(colorTheme.dim('  thinking…')), pad])
    // The glyph sits on the head alone; the pads are the panel's inset.
    expect(rules).toEqual(['  ', blockRules(colorTheme).agent, '  '])
    // A streamed line carries the same inset, so it lines up under the head.
    expect(thinkingLineRule(colorTheme)).toBe('  ')
  })

  it('needs no panel without colour, and no rule down the body', () => {
    // No fill says which block a row belongs to, so the glyph sits on the
    // head — then the clock — alone, and the body's own indent lines up
    // under it: a rule row by row would put ✻ down every deliberation line.
    const { rows, rules } = thinkingOpenRows(theme)
    expect(rows).toEqual(['thinking…'])
    expect(rules).toBe('✻ ')
    expect(thinkingLineRule(theme)).toBe('')
    expect(thinkingFoldRules(theme, 2)).toEqual({ summary: '✻ ', full: ['✻ ', '', ''] })
  })
})

describe('which block a line belongs to', () => {
  const rules = blockRules(theme)

  it('exposes the gutter glyphs without the old heavy bar', () => {
    expect(rules.user).toBe('› ')
    expect(rules.tool).toBe('│ ')
    expect(rules.error).toBe('│ ')
    expect(rules.agent).toBe('✻ ')
    expect(rules.meta).toBe('· ')
    expect(rules.user).not.toContain('┃')
  })

  /** A user message event. */
  const userEvent = (text: string): SessionEvent => ({
    type: 'user/message',
    seq: 1,
    time: 0,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }) as unknown as SessionEvent

  it('marks the person\'s own words with the accent gutter', () => {
    const transcript = build()
    transcript.render(userEvent('do it'))
    expect(transcript.takeRule()).toBe(rules.user)
  })

  it('marks a tool block with the light rule', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'read', { file_path: '/repo/a.ts' }))
    expect(transcript.takeRule()).toBe(rules.tool)
  })

  it('re-marks a failed call in the error colour', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'bash', {}))
    transcript.takeRule()
    transcript.render(resultEvent('c1', 'boom', true))
    expect(transcript.takeRule()).toBe(rules.error)
  })

  it('leaves what a person reads flush', () => {
    // An answer carries the conversation; ruling it too would mark everything
    // equally and mark nothing.
    const transcript = build()
    transcript.render({
      type: 'assistant/message',
      seq: 1,
      time: 0,
      data: { message: { content: [{ type: 'text', text: 'here you go' }] } },
    } as unknown as SessionEvent)
    expect(transcript.takeRule()).toBe('')
  })

  it('takes the rule once, like the fold it travels with', () => {
    const transcript = build()
    transcript.render(userEvent('do it'))
    expect(transcript.takeRule()).toBe(rules.user)
    expect(transcript.takeRule()).toBe('')
  })
})

describe('childSessionId', () => {
  it('reads the continuable start line', () => {
    expect(childSessionId('started subagent abc-123')).toBe('abc-123')
  })

  it('reads the JSON continuable form', () => {
    expect(childSessionId('{"kind":"continuable","subagentId":"child-1"}')).toBe('child-1')
  })

  it('ignores a background job and ordinary output', () => {
    expect(childSessionId('started background subagent job job-9')).toBeUndefined()
    expect(childSessionId('ok')).toBeUndefined()
  })
})

describe('a subagent card that is a view', () => {
  it('names the child session and tells a click to enter', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'subagent', {}))
    const lines = transcript.render(resultEvent('c1', 'started subagent child-9'))
    // The door is a row of its own; what the result said is in the fold.
    expect(lines).toEqual(['● subagent · 1 line ✔', '  click to enter', ''])
    expect((transcript.takeFold() ?? []).join('\n')).toContain('started subagent child-9')
    expect(transcript.takeEnter()).toBe('child-9')
    expect(transcript.takeLabel()).toBe('subagent')
    expect(transcript.takeEnter()).toBeUndefined()
  })

  it('does not offer a view for a failed call', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'subagent', {}))
    transcript.render(resultEvent('c1', 'started subagent child-9', true))
    expect(transcript.takeEnter()).toBeUndefined()
  })
})

describe('a pending subagent card that is a view', () => {
  it('promotes a pending subagent call with a child id into a click-to-enter view', () => {
    const transcript = build()
    const pending = transcript.render(callEvent('c1', 'subagent', {}))
    expect(transcript.takeEnter()).toBeUndefined()

    const lines = transcript.promotePendingView('child-9')
    expect(lines.join('\n')).toContain('click to enter')
    expect(transcript.takeEnter()).toBe('child-9')
    expect(transcript.takePendingCard()).toEqual(pending)
    expect(transcript.takeEnter()).toBeUndefined()
  })

  it('names the next child by the oldest unbound call: description, else prompt, else the tool', () => {
    const transcript = build()
    expect(transcript.peekSubagentLabel()).toBeUndefined()
    transcript.render(callEvent('c1', 'subagent', { description: 'Read-only ship brief', prompt: 'SHIP_DELEGATE_CHILD\n\nRead CONTEXT.md' }))
    transcript.render(callEvent('c2', 'subagent', { prompt: '\nInvestigate the retry path\nand report' }))
    transcript.render(callEvent('c3', 'subagent_fork', {}))
    expect(transcript.peekSubagentLabel()).toBe('Read-only ship brief')
    // FIFO skips the calls already bound to a child.
    transcript.promotePendingView('child-1')
    expect(transcript.peekSubagentLabel()).toBe('Investigate the retry path')
    transcript.promotePendingView('child-2')
    expect(transcript.peekSubagentLabel()).toBe('subagent_fork')
    transcript.promotePendingView('child-3')
    expect(transcript.peekSubagentLabel()).toBeUndefined()
  })

  it('binds the call whose label the child carries, whatever order the children came up in', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'subagent', { description: 'CODE_CLI_SUBAGENT_ONE brief' }))
    transcript.render(callEvent('c2', 'subagent', { description: 'CODE_CLI_SUBAGENT_TWO brief' }))
    // TWO came up first: its label picks the second card, not the oldest,
    // which stays the next one to bind.
    expect(transcript.promotePendingView('child-two', 'CODE_CLI_SUBAGENT_TWO brief').join('\n')).toContain('click to enter')
    expect(transcript.takeEnter()).toBe('child-two')
    expect(transcript.peekSubagentLabel()).toBe('CODE_CLI_SUBAGENT_ONE brief')
    // A label no pending call carries falls back to the oldest unbound one.
    expect(transcript.promotePendingView('child-one', 'something else').join('\n')).toContain('click to enter')
    expect(transcript.takeEnter()).toBe('child-one')
    expect(transcript.peekSubagentLabel()).toBeUndefined()
    expect(transcript.promotePendingView('child-three', 'CODE_CLI_SUBAGENT_ONE brief')).toEqual([])
  })

  it('promotes a pending subagent_fork call the same way', () => {
    const transcript = build()
    const pending = transcript.render(callEvent('c1', 'subagent_fork', {}))
    const lines = transcript.promotePendingView('fork-1')
    expect(lines.join('\n')).toContain('click to enter')
    expect(transcript.takeEnter()).toBe('fork-1')
    expect(transcript.takePendingCard()).toEqual(pending)
  })

  it('binds two unmatched pendings FIFO', () => {
    const transcript = build()
    const firstPending = transcript.render(callEvent('c1', 'subagent', {}))
    const secondPending = transcript.render(callEvent('c2', 'subagent_fork', {}))

    const first = transcript.promotePendingView('first-child')
    expect(first.join('\n')).toContain('click to enter')
    expect(transcript.takeEnter()).toBe('first-child')
    expect(transcript.takePendingCard()).toEqual(firstPending)

    const second = transcript.promotePendingView('second-child')
    expect(second.join('\n')).toContain('click to enter')
    expect(transcript.takeEnter()).toBe('second-child')
    expect(transcript.takePendingCard()).toEqual(secondPending)
  })

  it('still names the child on a later continuable start-result', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'subagent', {}))
    transcript.promotePendingView('child-9')
    expect(transcript.takeEnter()).toBe('child-9')
    transcript.takePendingCard()

    const lines = transcript.render(resultEvent('c1', 'started subagent child-9'))
    // The door is a row of its own; what the result said is in the fold.
    expect(lines).toEqual(['● subagent · 1 line ✔', '  click to enter', ''])
    expect((transcript.takeFold() ?? []).join('\n')).toContain('started subagent child-9')
    expect(transcript.takeEnter()).toBe('child-9')
  })

  it('does not offer a view for a background job string or a failed result', () => {
    expect(childSessionId('started background subagent job job-9')).toBeUndefined()
    const transcript = build()
    transcript.render(callEvent('c1', 'subagent', {}))
    transcript.render(resultEvent('c1', 'started subagent child-9', true))
    expect(transcript.takeEnter()).toBeUndefined()
  })

  it('does not offer a view for a finished foreground result body', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'subagent', {}))
    const lines = transcript.render(resultEvent('c1', 'the child finished the work'))
    expect(lines.join('\n')).not.toContain('click to enter')
    expect(transcript.takeEnter()).toBeUndefined()
  })
})

describe('naming a pending call', () => {
  it('names a terminal call by its first command line', () => {
    const call = (): ToolCallView => ({ card: 'terminal', title: 'git push origin main\necho done' })
    const transcript = build({ call })
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.callSummary('c1')).toBe('git push origin main …')
  })

  it('names a diff call by its workspace-relative paths', () => {
    const call = (): ToolCallView => ({ card: 'diff', title: 'Write', diffs: [{ path: '/repo/src/a.ts', oldText: null, newText: 'x' }, { path: '/repo/src/b.ts', oldText: null, newText: 'y' }] })
    const transcript = build({ call })
    transcript.render(callEvent('c1', 'write', {}))
    expect(transcript.callSummary('c1')).toBe('src/a.ts, src/b.ts')
  })

  it('names a generic call by its locations, or its title when it has none', () => {
    const located = build({ call: () => ({ card: 'generic', title: 'Read a.ts', locations: [{ path: '/repo/src/a.ts' }] }) })
    located.render(callEvent('c1', 'read', {}))
    expect(located.callSummary('c1')).toBe('src/a.ts')
    const bare = build({ call: () => ({ card: 'generic', title: 'Search the web' }) })
    bare.render(callEvent('c2', 'web_search', {}))
    expect(bare.callSummary('c2')).toBe('Search the web')
  })

  it('has no name for a call without a presenter, and forgets it once the result lands', () => {
    const transcript = build({ call: () => ({ card: 'terminal', title: 'pnpm test' }) })
    const plain = build()
    plain.render(callEvent('c1', 'mystery', {}))
    expect(plain.callSummary('c1')).toBeUndefined()
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.callSummary('c1')).toBe('pnpm test')
    transcript.render(resultEvent('c1', 'ok'))
    expect(transcript.callSummary('c1')).toBeUndefined()
    expect(transcript.callSummary('never')).toBeUndefined()
  })
})

describe('compaction', () => {
  const summaryEvent = (summary: string, items: number, tokens: number): SessionEvent => ({
    type: 'compaction/summary',
    seq: 9,
    time: 0,
    data: {
      compactionId: 'cp1',
      summary: [{ type: 'text', text: summary }],
      shadowedRange: { start: 1, end: items },
      shadowedSeqs: Array.from({ length: items }, (_, index) => index + 1),
      shadowedTokenCount: tokens,
      provider: 'cli-mock',
      model: 'cli-mock',
      rawOutput: [{ type: 'text', text: summary }],
      llmStreamCall: true,
    },
  } as unknown as SessionEvent)

  it('leaves a fold saying what became a summary, with the summary inside', () => {
    const transcript = build()
    const lines = transcript.render(summaryEvent('# Recap\n\nWe fixed the **bug**.', 6, 545))
    expect(lines[0]).toContain('✂ compacted 6 history items (~545 tokens) into a summary · cli-mock')
    expect(lines[1]).toContain('lines of summary (click or Ctrl+O expands)')
    const full = transcript.takeFold() ?? []
    expect(full[0]).toBe(lines[0])
    expect(full.join('\n')).toContain('Recap')
    expect(full.join('\n')).toContain('bug')
    expect(transcript.takeLabel()).toBe('compaction summary')
  })

  it('counts one item in the singular and says when the summary is empty', () => {
    const transcript = build()
    const lines = transcript.render(summaryEvent('', 1, 12))
    expect(lines[0]).toContain('compacted 1 history item (~12 tokens)')
    expect((transcript.takeFold() ?? []).join('\n')).toContain('(empty summary)')
  })

  it('reports a failed compaction, and says nothing for its start or a clean end', () => {
    const transcript = build()
    const start = { type: 'compaction/start', seq: 8, time: 0, data: { compactionId: 'cp1', turn: null } } as unknown as SessionEvent
    const clean = { type: 'compaction/end', seq: 10, time: 0, data: { compactionId: 'cp1', turn: null } } as unknown as SessionEvent
    const failed = { type: 'compaction/end', seq: 10, time: 0, data: { compactionId: 'cp1', turn: null, error: 'summary did not shrink' } } as unknown as SessionEvent
    expect(transcript.render(start)).toEqual([])
    expect(transcript.render(clean)).toEqual([])
    expect(transcript.render(failed)).toEqual([theme.error('✗ compaction failed: summary did not shrink'), ''])
  })
})

describe('formatToolCardLine', () => {
  it('truncates the title before +n -m and the status on a narrow terminal', () => {
    const line = formatToolCardLine(theme, 40, '●', 'Write very/long/path/to/src/pager.ts', '+12 -3', '✔')
    expect(line.endsWith('+12 -3 ✔')).toBe(true)
    expect(line.startsWith('● ')).toBe(true)
    expect(displayWidth(line)).toBeLessThanOrEqual(40)
    expect(line).toContain('…')
  })

  it('omits the stats segment when both counts are zero', () => {
    expect(formatToolCardLine(theme, 80, '●', 'Write x.ts', '', '✔')).toBe('● Write x.ts ✔')
  })

  it('does not prematurely truncate short filenames on a 30-col terminal', () => {
    expect(formatToolCardLine(theme, 25, '●', 'Write note.txt', '+1 -0', '✔')).toContain('Write note.txt')
  })

  it('fits +n -m on one row when an 80-col TTY also paints the tool rule', () => {
    // Viewport content is 80 minus the 2-col `│ ` rule; a headline that
    // budgets the full 80 wraps and splits `+12 -3`.
    const rule = gutter('tool', theme)
    const inner = 80 - displayWidth(rule)
    const title = 'Write src/very/long/path/that/would/wrap/the/stats/pager.ts'
    const line = formatToolCardLine(theme, inner, '●', title, '+12 -3', '✔')
    expect(displayWidth(rule) + displayWidth(line)).toBeLessThanOrEqual(80)
    expect(line.endsWith('+12 -3 ✔')).toBe(true)
    expect(line).not.toMatch(/\+\s*$/u)
  })

  it('keeps gutter glyphs under NO_COLOR', () => {
    const plain = createTheme(false, { NO_COLOR: '1' })
    expect(gutter('user', plain)).toBe('› ')
    expect(gutter('thinking', plain)).toBe('✻ ')
    expect(gutter('tool', plain)).toBe('│ ')
    expect(gutter('system', plain)).toBe('· ')
    expect(formatToolCardLine(plain, 80, '●', 'Write x.ts', '+12 -3', '✔')).toBe('● Write x.ts +12 -3 ✔')
  })

  it('supports a dynamic columns getter that reflects live viewport width', () => {
    let cols = 60
    const dynamic = new Transcript(
      { theme, columns: () => cols, cwd: CWD },
      { call: (): ToolCallView => ({ card: 'terminal', title: 'node -e "very long script here..."' }), result: () => undefined },
    )
    expect(dynamic.columns).toBe(60)
    cols = 100
    expect(dynamic.columns).toBe(100)
  })

  it('keeps long terminal command headlines within contentColumns so trailing status never wraps', () => {
    let width = 60
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const transcript = new Transcript(
      { theme: colorTheme, columns: () => width, cwd: CWD },
      {
        call: (name, args: any) => ({ card: 'terminal', title: args?.command ?? name }),
        result: () => undefined,
      },
    )

    const longCmd = 'node -e \' const KEYWORDS = new Set([ "as", "async", "await", "break", "case", "catch", "class", "const" ])\''
    transcript.render(callEvent('c1', 'bash', { command: longCmd }))
    const resultLines = transcript.render(resultEvent('c1', 'ok'))
    const resultHead = resultLines.find(line => line.includes('✔'))

    // The line must end with the checkmark, not wrap it onto a second line
    expect(resultHead).toBeDefined()
    // Length within rule budget
    const ruleWidth = 2
    expect(displayWidth(resultHead ?? '')).toBeLessThanOrEqual(width - ruleWidth)
  })
})

describe('transcript density', () => {
  /** A user turn the person typed. */
  const user = (text: string, seq = 1): SessionEvent => ({
    type: 'user/message',
    seq,
    time: 0,
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }) as unknown as SessionEvent

  /** Transcript at a named density. */
  const at = (density: Density, presenters: Partial<ToolPresenters> = {}): Transcript =>
    new Transcript({ theme, columns: 80, cwd: CWD, density }, {
      call: presenters.call ?? (() => undefined),
      result: presenters.result ?? (() => undefined),
    })

  /** All-changed file of `count` lines — each change is one - and one +. */
  const allChanged = (count: number): { oldText: string; newText: string } => ({
    oldText: Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n'),
    newText: Array.from({ length: count }, (_, index) => `LINE ${index + 1}`).join('\n'),
  })

  it('leaves no extra blank row between turns in compact (the default)', () => {
    const transcript = build()
    expect(transcript.render(user('one'))).toEqual(['one', ''])
    expect(transcript.render(user('two', 2))).toEqual(['two', ''])
  })

  it('inserts one extra blank row before later user turns in comfortable', () => {
    const transcript = at('comfortable')
    expect(transcript.render(user('one'))).toEqual(['one', ''])
    expect(transcript.render(user('two', 2))).toEqual(['', 'two', ''])
  })

  it('does not unfold a folded ToolCard when density switches', () => {
    const result = (): ToolResultView => ({
      card: 'diff',
      title: 'Edit',
      diffs: [{ path: '/repo/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }],
    })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'edit', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Edit +1 -1 ✔', ''])
    transcript.setDensity('comfortable')
    const fold = transcript.takeFold() ?? []
    expect(fold[0]).toBe('● Edit +1 -1 ✔')
    expect(transcript.takePage()).toBeUndefined()
  })

  it('pages a mid-size expanded diff in compact but not comfortable', () => {
    // 15 lines all changed → 30 hunk lines: over compact 24, under comfortable 48.
    const { oldText, newText } = allChanged(15)
    const result = (): ToolResultView => ({ card: 'diff', title: 'Edit', diffs: [{ path: '/repo/a.ts', oldText, newText }] })
    const compact = at('compact', { result })
    compact.render(callEvent('c1', 'edit', {}))
    expect(compact.render(resultEvent('c1', 'ok'))).toEqual(['● Edit +15 -15 ✔', ''])
    expect(compact.takePage()).toBeDefined()

    const comfortable = at('comfortable', { result })
    comfortable.render(callEvent('c1', 'edit', {}))
    expect(comfortable.render(resultEvent('c1', 'ok'))).toEqual(['● Edit +15 -15 ✔', ''])
    expect(comfortable.takePage()).toBeUndefined()
    expect(comfortable.takeFold()?.[0]).toBe('● Edit +15 -15 ✔')
  })

  it('pages a large expanded diff in both densities', () => {
    const { oldText, newText } = allChanged(30)
    const result = (): ToolResultView => ({ card: 'diff', title: 'Edit', diffs: [{ path: '/repo/a.ts', oldText, newText }] })
    for (const density of ['compact', 'comfortable'] as const) {
      const transcript = at(density, { result })
      transcript.render(callEvent('c1', 'edit', {}))
      expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Edit +30 -30 ✔', ''])
      expect(transcript.takePage()).toBeDefined()
    }
  })
})

describe('grok background differentiation across functional blocks', () => {
  it('styles user, tool, thinking, and error blocks with distinct background colors', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const coloredTranscript = new Transcript({ theme: colorTheme, columns: 80, cwd: CWD }, {
      call: (name) => name === 'bash' ? { card: 'terminal', title: 'echo hi' } : undefined,
      result: (name) => name === 'bash' ? { card: 'terminal', title: 'echo hi', output: 'hi' } : undefined,
    })

    const userEvent: SessionEvent = {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: { role: 'user', content: [{ type: 'text', text: 'my prompt' }], source: { kind: 'user' } },
    } as unknown as SessionEvent
    const userLines = coloredTranscript.render(userEvent)
    // Inset like every other block, and padded by the screen rather than by
    // the block, so the prompt's descriptor stays the text that was typed.
    expect(userLines[0]).toBe(colorTheme.bgUser('  my prompt'))
    expect(coloredTranscript.takePromptPad()).toBe(colorTheme.bgUser('  '))

    const callLines = coloredTranscript.render(callEvent('c1', 'bash', {}))
    expect(callLines[0]).toBe(colorTheme.bgTool('  '))
    expect(callLines[1]).toContain(colorTheme.bgTool(`  ${colorTheme.pending('●')} ${colorTheme.tool('echo hi')}`))

    const resultLines = coloredTranscript.render(resultEvent('c1', 'hi'))
    expect(resultLines[0]?.startsWith('\u001B[48;2;14;18;24m')).toBe(true)
    expect(resultLines[0]).toBe(colorTheme.bgTool('  '))
    expect(resultLines[1]).toContain('echo hi')
    expect(resultLines[1]).toContain('1 line')
    expect(resultLines[2]).toBe(colorTheme.bgTool('  '))
    expect(coloredTranscript.takeFold()).toContain(colorTheme.bgTool(colorTheme.dim('  hi')))

    const errResultLines = coloredTranscript.render(resultEvent('c2', 'failed', true))
    expect(errResultLines[0]?.startsWith('\u001B[48;2;45;15;25m')).toBe(true)
    expect(errResultLines[0]).toBe(colorTheme.bgError('  '))
    expect(errResultLines[1]).toContain('✗')

    const think = thinkingFold(['reasoning line'], colorTheme, 1.5)
    // Collapsed and expanded both inset the clock with the thinking panel fill.
    expect(think.summary).toEqual([
      colorTheme.bgThinking('  '),
      colorTheme.bgThinking(colorTheme.dim('  thought for 1.5s')),
      colorTheme.bgThinking('  '),
    ])
    expect(think.full[0]).toBe(colorTheme.bgThinking('  '))
    expect(think.full[1]).toBe(colorTheme.bgThinking(colorTheme.dim('  thought for 1.5s')))
    expect(think.full[2]).toBe(colorTheme.bgThinking('  '))
    expect(think.full[3]).toBe(colorTheme.bgThinking('reasoning line'))
    expect(think.full[4]).toBe(colorTheme.bgThinking('  '))
  })

  it('pads every pending card, whatever its presenter answered', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const pad = colorTheme.bgTool('  ')

    // No presenter at all: the generic name-only card.
    const generic = new Transcript(
      { columns: 80, theme: colorTheme, cwd: CWD },
      { call: () => undefined, result: () => undefined },
    ).render(callEvent('c1', 'bash', {}))
    expect(generic[0]).toBe(pad)
    expect(generic[1]).toContain(colorTheme.tool('bash'))
    expect(generic[2]).toBe(pad)

    // A presenter answering with locations: the file card.
    const located = new Transcript(
      { columns: 80, theme: colorTheme, cwd: CWD },
      { call: (): ToolCallView => ({ card: 'generic', title: 'Read README.md', locations: [{ path: '/repo/README.md' }] }), result: () => undefined },
    ).render(callEvent('c1', 'read', {}))
    expect(located[0]).toBe(pad)
    expect(located[1]).toContain('Read README.md')
    expect(located[2]).toBe(pad)
  })

  it('leaves uncoloured output unpadded, since it paints no panel to inset', () => {
    // A pending card closes with its padding, which uncoloured output has
    // none of; the separator piped output needs comes with the result.
    const plain = build({ call: () => undefined }).render(callEvent('c1', 'bash', {}))
    expect(plain).toEqual(['● bash'])
  })

  it('opens a tool panel with its own top pad after thinking ended the run', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const pad = colorTheme.bgTool('  ')
    const colored = new Transcript(
      { columns: 80, theme: colorTheme, cwd: CWD },
      { call: () => undefined, result: () => undefined },
    )
    colored.render(callEvent('c1', 'read', {}))
    colored.render(resultEvent('c1', ''))
    // Closing the run must not insert an unstyled blank: neighbouring panels
    // meet at their inner pads, and a gap here is the hole between an Edit
    // card and the thought clock.
    expect(colored.endRun()).toEqual([])
    const next = colored.render(callEvent('c2', 'grep', {}))
    expect(next[0]).toBe(pad)
    expect(next[1]).toContain(colorTheme.tool('grep'))
  })

  it('gives a run of one-line cards a single shared panel', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const pad = colorTheme.bgTool('  ')
    let file = 'a.ts'
    const colored = new Transcript(
      { columns: 80, theme: colorTheme, cwd: CWD },
      {
        call: (): ToolCallView => ({ card: 'generic', title: `Read ${file}` }),
        result: (): ToolResultView => ({ card: 'generic', title: `Read ${file}` }),
      },
    )

    // The first card opens the panel and closes it.
    colored.render(callEvent('c1', 'read', {}))
    const first = colored.render(resultEvent('c1', ''))
    expect(first[0]).toBe(pad)
    expect(first[1]).toContain('Read a.ts')
    expect(first[2]).toBe(pad)

    // The second takes that closing pad over rather than opening a panel of
    // its own, so the two cards end up as adjacent rows of one panel.
    file = 'b.ts'
    const pending = colored.render(callEvent('c2', 'read', {}))
    expect(colored.takePendingCard()).toEqual([pad])
    expect(pending[0]).toContain('Read b.ts')
    expect(pending[1]).toBe(pad)

    const second = colored.render(resultEvent('c2', ''))
    expect(colored.takePendingCard()).toEqual(pending)
    expect(second[0]).toContain('Read b.ts')
    expect(second[1]).toBe(pad)
  })

  it('gives a run of diff cards a single shared panel', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const pad = colorTheme.bgTool('  ')
    const colored = new Transcript(
      { columns: 80, theme: colorTheme, cwd: CWD },
      {
        call: (name): ToolCallView => ({ card: 'diff', title: `Edit ${name}`, diffs: [] }),
        result: (name): ToolResultView => ({ card: 'diff', title: `Edit ${name}`, diffs: [] }),
      },
    )

    // First diff call produces no pending lines, and result opens the panel
    expect(colored.render(callEvent('c1', 'a.ts', {}))).toEqual([])
    const first = colored.render(resultEvent('c1', ''))
    expect(first[0]).toBe(pad)
    expect(first[1]).toContain('Edit a.ts')
    expect(first[2]).toBe(pad)

    // Second diff call also produces no pending lines, and its result takes over the closing pad
    expect(colored.render(callEvent('c2', 'b.ts', {}))).toEqual([])
    const second = colored.render(resultEvent('c2', ''))
    expect(colored.takePendingCard()).toEqual([pad])
    expect(second[0]).toContain('Edit b.ts')
    expect(second[1]).toBe(pad)
  })

  it('keeps consecutive read cards in one panel with no gap between them', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const pad = colorTheme.bgTool('  ')
    let file = 'questions.spec.ts'
    const colored = new Transcript(
      { columns: 80, theme: colorTheme, cwd: CWD },
      {
        call: (): ToolCallView => ({ card: 'generic', title: `Read ${file}` }),
        result: (): ToolResultView => ({
          card: 'read',
          path: `/repo/${file}`,
          offset: 1,
          lines: [{ number: 1, text: 'x' }],
          totalLines: 10,
        }),
      },
    )
    colored.render(callEvent('c1', 'read', {}))
    const first = colored.render(resultEvent('c1', 'ok'))
    expect(first[0]).toBe(pad)
    expect(first[1]).toContain('Read questions.spec.ts')
    expect(first[2]).toBe(pad)

    file = 'prompt.spec.ts'
    colored.render(callEvent('c2', 'read', {}))
    const second = colored.render(resultEvent('c2', 'ok'))
    expect(second.filter(line => line === pad)).toHaveLength(1)
    expect(second[0]).toContain('Read prompt.spec.ts')
    expect(second[1]).toBe(pad)
  })

  it('keeps consecutive edit cards in one panel with no gap between them', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const pad = colorTheme.bgTool('  ')
    let file = 'questions.spec.ts'
    const colored = new Transcript(
      { columns: 80, theme: colorTheme, cwd: CWD },
      {
        call: (): ToolCallView => ({ card: 'diff', title: `Edit ${file}`, diffs: [] }),
        result: (): ToolResultView => ({
          card: 'diff',
          title: `Edit ${file}`,
          diffs: [{ path: `/repo/${file}`, oldText: 'a', newText: 'b' }],
        }),
      },
    )
    expect(colored.render(callEvent('c1', 'edit', {}))).toEqual([])
    const first = colored.render(resultEvent('c1', 'ok'))
    expect(first[0]).toBe(pad)
    expect(first[1]).toContain('Edit questions.spec.ts')
    expect(first[2]).toBe(pad)

    file = 'ship.spec.ts'
    expect(colored.render(callEvent('c2', 'edit', {}))).toEqual([])
    const second = colored.render(resultEvent('c2', 'ok'))
    expect(second.filter(line => line === pad)).toHaveLength(1)
    expect(second[0]).toContain('Edit ship.spec.ts')
    expect(second[1]).toBe(pad)
  })

  it('keeps the tool run open across intervening empty assistant messages and step boundaries', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const pad = colorTheme.bgTool('  ')
    let file = 'a.ts'
    const colored = new Transcript(
      { columns: 80, theme: colorTheme, cwd: CWD },
      {
        call: (): ToolCallView => ({ card: 'generic', title: `Read ${file}` }),
        result: (): ToolResultView => ({ card: 'generic', title: `Read ${file}` }),
      },
    )

    colored.render(callEvent('c1', 'read', {}))
    colored.render(resultEvent('c1', ''))

    // In a real agent turn, step transitions and text-free assistant messages arrive between tool calls
    const stepEnd = { type: 'step/end', seq: 3, time: 0, data: { turn: 1, step: 1 } } as SessionEvent
    const stepStart = { type: 'step/start', seq: 4, time: 0, data: { turn: 1, step: 2 } } as SessionEvent
    const emptyAssistant = {
      type: 'assistant/message',
      seq: 5,
      time: 0,
      data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' }], source: { kind: 'model' } } },
    } as unknown as SessionEvent

    expect(colored.render(stepEnd)).toEqual([])
    expect(colored.render(stepStart)).toEqual([])
    expect(colored.render(emptyAssistant)).toEqual([])

    // The second call must still join the same panel rather than opening a new one with leading pad
    file = 'b.ts'
    const pending = colored.render(callEvent('c2', 'read', {}))
    expect(colored.takePendingCard()).toEqual([pad])
    expect(pending[0]).toContain('Read b.ts')
    expect(pending[1]).toBe(pad)

    const second = colored.render(resultEvent('c2', ''))
    expect(colored.takePendingCard()).toEqual(pending)
    expect(second[0]).toContain('Read b.ts')
    expect(second[1]).toBe(pad)
  })

  it('does not open a new panel after a short assistant note between tool cards', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const pad = colorTheme.bgTool('  ')
    let file = 'questions.spec.ts'
    const colored = new Transcript(
      { columns: 80, theme: colorTheme, cwd: CWD },
      {
        call: (): ToolCallView => ({ card: 'generic', title: `Read ${file}` }),
        result: (): ToolResultView => ({
          card: 'read',
          path: `/repo/${file}`,
          offset: 1,
          lines: [{ number: 1, text: 'x' }],
          totalLines: 10,
        }),
      },
    )
    colored.render(callEvent('c1', 'read', {}))
    colored.render(resultEvent('c1', 'ok'))
    const note = {
      type: 'assistant/message',
      seq: 3,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'questions.spec.ts 改动冲突了，重新读一遍再补测试。' }],
          source: { kind: 'model' },
        },
      },
    } as unknown as SessionEvent
    expect(colored.render(note).join('\n')).toContain('改动冲突')
    file = 'prompt.spec.ts'
    colored.render(callEvent('c2', 'read', {}))
    const second = colored.render(resultEvent('c2', 'ok'))
    expect(second.filter(line => line === pad)).toHaveLength(1)
    expect(second[0]).toContain('Read prompt.spec.ts')
    expect(second[0]).not.toBe(pad)
  })

  it('keeps the pad a run opened with when a later card rebuilds its head', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const pad = colorTheme.bgTool('  ')
    const colored = new Transcript(
      { columns: 80, theme: colorTheme, cwd: CWD },
      { call: (): ToolCallView => ({ card: 'terminal', title: 'git status' }), result: () => undefined },
    )

    colored.render(callEvent('c1', 'bash', {}))
    const first = colored.render(resultEvent('c1', 'M one.ts'))
    // A one-row card lets the next pending row take over the pad it closed
    // with, so the screen holds: pad, first head, pending row, pad.
    const pendingRow = colored.render(callEvent('c2', 'bash', {}))
    expect(colored.takePendingCard()).toEqual([pad])
    const second = colored.render(resultEvent('c2', 'M two.ts'))

    // Same command, same shape: the second joins the first as a run. What it
    // replaces is exactly what is on screen, pad included, and the rebuilt
    // head keeps that pad as the panel's inset.
    expect(colored.takePendingCard()).toEqual([first[0], first[1], pendingRow[0], pendingRow[1]])
    expect(second[0]).toBe(pad)
    expect(second[1]).toContain('git status')
    expect(second[1]).toContain('· 2 similar')
    expect(second[second.length - 1]).toBe(pad)
    expect(second).toHaveLength(3)
  })
})

describe('formatAskUserQuestionResult', () => {
  it('extracts selected option labels', () => {
    expect(formatAskUserQuestionResult(JSON.stringify({ answers: [{ id: 'q1', selected: ['Option A'] }] })))
      .toBe('Option A')
  })

  it('extracts comma-separated multi-select choices', () => {
    expect(formatAskUserQuestionResult(JSON.stringify({ answers: [{ id: 'q1', selected: ['Opt 1', 'Opt 2'] }] })))
      .toBe('Opt 1, Opt 2')
  })

  it('extracts custom typed replies', () => {
    expect(formatAskUserQuestionResult(JSON.stringify({ answers: [{ id: 'q1', selected: [], custom: 'custom text' }] })))
      .toBe('custom text')
  })

  it('combines multiple questions on separate lines', () => {
    expect(formatAskUserQuestionResult(JSON.stringify({
      answers: [
        { id: 'q1', selected: ['Opt 1'] },
        { id: 'q2', custom: 'note' },
      ],
    }))).toBe('Opt 1\nnote')
  })

  it('returns empty string for empty answers', () => {
    expect(formatAskUserQuestionResult(JSON.stringify({ answers: [{ id: 'q1', selected: [] }] })))
      .toBe('')
    expect(formatAskUserQuestionResult(JSON.stringify({ answers: [] }))).toBe('')
    expect(formatAskUserQuestionResult('')).toBe('')
  })

  it('passes non-JSON text through unharmed', () => {
    expect(formatAskUserQuestionResult('plain text answer')).toBe('plain text answer')
  })
})

describe('presentAskUserQuestionResult', () => {
  it('returns generic card with formatted reply', () => {
    const result = {
      content: [{ type: 'text' as const, text: JSON.stringify({ answers: [{ id: 'q1', selected: ['Yes'] }] }) }],
      isError: false,
    }
    expect(presentAskUserQuestionResult(result)).toEqual({
      card: 'generic',
      content: [{ type: 'text', text: 'Yes' }],
    })
  })

  it('returns empty content when answers are empty', () => {
    const result = {
      content: [{ type: 'text' as const, text: JSON.stringify({ answers: [{ id: 'q1', selected: [] }] }) }],
      isError: false,
    }
    expect(presentAskUserQuestionResult(result)).toEqual({
      card: 'generic',
      content: [],
    })
  })

  it('returns undefined when tool execution failed', () => {
    const result = {
      content: [{ type: 'text' as const, text: 'ask_user_question failed' }],
      isError: true,
    }
    expect(presentAskUserQuestionResult(result)).toBeUndefined()
  })
})
