/**
 * One appended session event renders to finished terminal lines. Cards come
 * from the registered presenters, and a missing or throwing presenter degrades
 * to the generic line rather than breaking the transcript.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { destructiveCategory } from '../src/destructive.ts'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { createTheme, displayWidth } from '../src/theme.ts'
import { Transcript, blockRules, childSessionId, formatAskUserQuestionResult, presentAskUserQuestionResult, thinkingFold, thinkingFoldRules, type ToolPresenters } from '../src/transcript.ts'
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

describe('tool rows', () => {
  it('renders a call with no presenter as one muted row', () => {
    expect(build().render(callEvent('c1', 'grep', { pattern: 'x' }))).toEqual(['● Using 1 tool'])
  })

  it('renders a terminal call under the command category and keeps its command in the fold', () => {
    const call = (): ToolCallView => ({ card: 'terminal', title: 'pnpm test', cwd: '/repo/apps', description: 'run the suite' })
    const transcript = build({ call })
    expect(transcript.render(callEvent('c1', 'bash', {}))).toEqual(['● Running 1 command'])
    expect(transcript.callSummary('c1')).toBe('pnpm test')
    expect(transcript.takeFold()).toEqual(['● Running 1 command', '● pnpm test'])
  })

  it('renders a diff call under the edit category without a panel', () => {
    const call = (): ToolCallView => ({ card: 'diff', title: 'Write', diffs: [{ path: '/repo/src/a.ts', oldText: null, newText: 'x' }] })
    const transcript = build({ call })
    expect(transcript.render(callEvent('c1', 'write', {}))).toEqual(['● Editing 1 file'])
    expect(transcript.callSummary('c1')).toBe('src/a.ts')
  })

  it('renders a generic call with its follow-along locations in the fold', () => {
    const call = (): ToolCallView => ({ card: 'generic', title: 'Read a.ts', locations: [{ path: '/repo/src/a.ts' }] })
    const transcript = build({ call })
    expect(transcript.render(callEvent('c1', 'read', {}))).toEqual(['● Using 1 tool'])
    expect(transcript.callSummary('c1')).toBe('src/a.ts')
    expect(transcript.takeFold()?.[1]).toBe('● Read a.ts src/a.ts')
  })

  it('still records the call when its arguments do not parse', () => {
    const event = { type: 'tool/call', seq: 1, time: 0, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{oops' } } as SessionEvent
    const transcript = build()
    expect(transcript.render(event)).toEqual(['● Using 1 tool'])
    expect(transcript.render(resultEvent('c1', 'out'))).toEqual(['● Used 1 tool'])
    expect(transcript.takeFold()).toEqual(['● Used 1 tool', '● bash ✔', '  out'])
  })

  it('degrades to the other category when a call presenter throws', () => {
    const call = () => { throw new Error('presenter is broken') }
    expect(build({ call }).render(callEvent('c1', 'grep', {}))).toEqual(['● Using 1 tool'])
  })
})

describe('tool results', () => {
  it('pairs a result with its call and folds the body under one row', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'grep', {}))
    expect(transcript.render(resultEvent('c1', 'two matches'))).toEqual(['● Used 1 tool'])
    expect(transcript.takeFold()).toEqual(['● Used 1 tool', '● grep ✔', '  two matches'])
  })

  it('marks a failed call in the failure segment and in the fold', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', 'exit 1', true))).toEqual(['● Used 1 tool · 1 failed'])
    expect((transcript.takeFold() ?? []).join('\n')).toContain('● bash ✗')
  })

  it('renders ask_user_question result directly as the user reply instead of raw json', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'ask_user_question', { questions: [{ id: 'q1', question: 'Which mode?' }] }))
    const resultJson = JSON.stringify({ answers: [{ id: 'q1', selected: ['Fast mode (Recommended)'] }] })
    expect(transcript.render(resultEvent('c1', resultJson))).toEqual(['● Used 1 tool'])
    expect(transcript.takeFold()).toEqual(['● Used 1 tool', '● ask_user_question ✔', '  Fast mode (Recommended)'])
  })

  it('renders custom reply for ask_user_question directly as plain text', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'ask_user_question', { questions: [{ id: 'q1', question: 'Any comments?' }] }))
    const resultJson = JSON.stringify({ answers: [{ id: 'q1', selected: [], custom: 'Please keep existing tests.' }] })
    expect(transcript.render(resultEvent('c1', resultJson))).toEqual(['● Used 1 tool'])
    expect(transcript.takeFold()).toEqual(['● Used 1 tool', '● ask_user_question ✔', '  Please keep existing tests.'])
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
    expect(transcript.render(resultEvent('c1', resultJson))).toEqual(['● Used 1 tool'])
    expect(transcript.takeFold()).toEqual([
      '● Used 1 tool',
      '● ask_user_question ✔',
      '  Production',
      '  yes proceed',
    ])
  })

  it('renders no body when ask_user_question answers are empty (aborted/dismissed)', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'ask_user_question', { questions: [{ id: 'q1', question: 'Confirm?' }] }))
    const resultJson = JSON.stringify({ answers: [{ id: 'q1', selected: [] }] })
    expect(transcript.render(resultEvent('c1', resultJson))).toEqual(['● Used 1 tool'])
    expect(transcript.takeFold()).toEqual(['● Used 1 tool', '● ask_user_question ✔'])
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

  it('renders a diff result as a group row with the diff in the fold', () => {
    const result = (): ToolResultView => ({
      card: 'diff',
      title: 'Edit',
      diffs: [{ path: '/repo/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }],
    })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'edit', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Edited 1 file'])
    const fold = transcript.takeFold() ?? []
    expect(fold[0]).toBe('● Edited 1 file')
    expect(fold).toContain('● Edit +1 -1 ✔')
    expect(fold).toContain('- const a = 1')
    expect(fold).toContain('+ const a = 2')
  })

  it('hands a long diff to the reader instead of expanding it in place', () => {
    // Every line moves, so the single hunk outgrows the 24-line soft cap.
    const oldText = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n')
    const newText = Array.from({ length: 30 }, (_, index) => `LINE ${index + 1}`).join('\n')
    const result = (): ToolResultView => ({ card: 'diff', title: 'Edit', diffs: [{ path: '/repo/a.ts', oldText, newText }] })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'edit', {}))
    const lines = transcript.render(resultEvent('c1', 'ok'))

    expect(lines).toEqual(['● Edited 1 file'])
    const fold = transcript.takeFold() ?? []
    expect(fold[0]).toBe('● Edited 1 file')
    expect(fold.join('\n')).toContain('- line 30')
    expect(fold.join('\n')).toContain('+ LINE 30')
    expect(lines.join('\n')).not.toContain('- line 1')
    const page = transcript.takePage()
    expect(page).toContain('--- a/a.ts')
    expect(page).toContain('-line 30')
    expect(page).toContain('+LINE 30')
    expect(transcript.takePage()).toBeUndefined()
  })

  it('folds a short diff behind the group row, with nothing for the reader', () => {
    const result = (): ToolResultView => ({
      card: 'diff',
      title: 'Edit',
      diffs: [{ path: '/repo/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }],
    })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'edit', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Edited 1 file'])
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
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Edited 1 file'])
    expect(transcript.takeFold()).toEqual(['● Edited 1 file', '● write +2 -0 ✔', '+ a', '+ b'])
  })

  it('shows a non-zero exit status in the fold of a terminal result', () => {
    const result = (): ToolResultView => ({ card: 'terminal', title: 'pnpm test', output: 'failed', exitCode: 1 })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', 'failed'))).toEqual(['● Ran 1 command'])
    const fold = transcript.takeFold() ?? []
    expect(fold).toContain('● pnpm test (exit 1) ✔')
    expect(fold).toContain('  failed')
  })

  it('reports a signal kill in the fold instead of an exit code', () => {
    const result = (): ToolResultView => ({ card: 'terminal', title: 'sleep', signal: 'SIGTERM' })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', ''))).toEqual(['● Ran 1 command'])
    expect(transcript.takeFold()?.[1]).toBe('● sleep (killed by SIGTERM) ✔')
  })

  it('groups search matches by file inside the fold', () => {
    const result = (): ToolResultView => ({
      card: 'search',
      shape: 'matches',
      files: [{ path: '/repo/a.ts', matches: [{ lineNumber: 3, line: 'const a = 1' }] }],
      truncated: false,
      total: 1,
    })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'grep', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Searched 1 pattern'])
    expect(transcript.takeFold()).toEqual([
      '● Searched 1 pattern',
      '● grep 1 results ✔',
      '  a.ts',
      '    3: const a = 1',
    ])
  })

  it('marks a capped search as capped in the fold', () => {
    const result = (): ToolResultView => ({ card: 'search', shape: 'paths', paths: ['/repo/a.ts'], truncated: true, total: 900 })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'glob', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Searched 1 pattern'])
    expect(transcript.takeFold()?.[1]).toBe('● glob 900+ (capped) results ✔')
  })

  it('aggregates consecutive terminal calls into one row and keeps both in the fold', () => {
    const command = 'export PATH="/tmp/openbot-chat-node:$PATH" && pnpm --filter @openbot/web exec playwright test'
    const transcript = build({
      call: () => ({ card: 'terminal', title: command }),
      result: () => ({ card: 'terminal', title: command, output: 'Error: No tests found' }),
    })
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Ran 1 command'])

    transcript.render(callEvent('c2', 'bash', {}))
    const second = transcript.render(resultEvent('c2', 'ok'))
    expect(second).toEqual(['● Ran 2 commands'])
    expect(transcript.takePendingCard()).toEqual(['● Running 2 commands'])
    const full = transcript.takeFold() ?? []
    expect(full.join('\n')).toContain('Error: No tests found')

    transcript.render(callEvent('c3', 'bash', {}))
    expect(transcript.render(resultEvent('c3', 'ok'))).toEqual(['● Ran 3 commands'])
  })

  it('aggregates a mixed run and lists every member in the fold', () => {
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
    transcript.render(resultEvent('c2', 'ok'))
    index = 2
    transcript.render(callEvent('c3', 'bash', {}))
    const third = transcript.render(resultEvent('c3', 'ok'))
    expect(third).toEqual(['● Ran 3 commands'])
    const full = transcript.takeFold() ?? []
    expect(full.join('\n')).toContain('git status')
    expect(full.join('\n')).toContain('On branch main')
  })

  it('keeps one group row while the exit status lives in the fold', () => {
    const call = (): ToolCallView => ({ card: 'terminal', title: 'pnpm test' })
    const result = (): ToolResultView => ({ card: 'terminal', title: 'pnpm test', output: 'out', exitCode: 1 })
    const transcript = build({ call, result })
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', 'failed'))).toEqual(['● Ran 1 command'])
    const fold = transcript.takeFold() ?? []
    expect(fold).toContain('● pnpm test (exit 1) ✔')
    expect(fold).toContain('  out')
  })

  it('summarizes a read as a window of the file in the fold', () => {
    const result = (): ToolResultView => ({
      card: 'read',
      path: '/repo/a.ts',
      offset: 1,
      lines: [{ number: 1, text: 'x' }],
      totalLines: 12,
    })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'read', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Read 1 file'])
    expect(transcript.takeFold()?.[1]).toBe('● read 1 of 12 lines ✔')
  })

  it('prints an unpaired result rather than dropping it', () => {
    expect(build().render(resultEvent('missing', 'orphan'))).toEqual(['● Used 1 tool'])
    const transcript = build()
    transcript.render(resultEvent('missing', 'orphan'))
    expect(transcript.takeFold()).toEqual(['● Used 1 tool', '● (result) ✔', '  orphan'])
  })

  it('folds consecutive unpaired results into one group instead of stacking them', () => {
    const transcript = build()
    const first = transcript.render(resultEvent('c1', 'alpha\nbeta'))
    expect(first).toEqual(['● Used 1 tool'])

    const second = transcript.render(resultEvent('c2', 'gamma\ndelta'))
    expect(second).toEqual(['● Used 2 tools'])
    expect(transcript.takePendingCard()).toEqual(first)
    const full = transcript.takeFold() ?? []
    expect(full.join('\n')).toContain('alpha')
    expect(full.join('\n')).toContain('gamma')
    expect(full[0]).toBe('● Used 2 tools')

    const third = transcript.render(resultEvent('c3', 'epsilon'))
    expect(third).toEqual(['● Used 3 tools'])
    expect(transcript.takePendingCard()).toEqual(second)
    expect((transcript.takeFold() ?? []).join('\n')).toContain('epsilon')
  })

  it('paints a coalesced orphan run as one muted row, not a panel', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const transcript = new Transcript(
      { theme: colorTheme, columns: 80, cwd: CWD },
      { call: () => undefined, result: () => undefined },
    )
    transcript.render(resultEvent('c1', 'alpha'))
    const second = transcript.render(resultEvent('c2', 'beta'))
    expect(second).toEqual([`  ${colorTheme.muted('●')} ${colorTheme.dim('Used 2 tools')}`])
    expect(second.join('\n')).not.toContain('\u001B[48;2;14;18;24m')
    expect((transcript.takeFold() ?? []).join('\n')).toContain('beta')
  })

  it('joins an unpaired result to the run at the tail', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Used 1 tool'])
    expect(transcript.render(resultEvent('missing', 'later'))).toEqual(['● Used 2 tools'])
    expect(transcript.takePendingCard()).toEqual(['● Used 1 tool'])
    expect((transcript.takeFold() ?? []).join('\n')).toContain('later')
  })

  it('degrades to the other category when a result presenter throws', () => {
    const result = () => { throw new Error('presenter is broken') }
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'grep', {}))
    expect(transcript.render(resultEvent('c1', 'two matches'))).toEqual(['● Used 1 tool'])
    expect(transcript.takeFold()).toEqual(['● Used 1 tool', '● grep ✔', '  two matches'])
  })

  it('confirms a completion that carries no body', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'todo_write', {}))
    // Nothing to show and nothing changed, but the call must not look pending.
    expect(transcript.render(resultEvent('c1', ''))).toEqual(['● Used 1 tool'])
    expect(transcript.takeFold()).toEqual(['● Used 1 tool', '● todo_write ✔'])
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
    expect(transcript.render(callEvent('c1', 'write', {}))).toEqual(['● Editing 1 file'])
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Edited 1 file'])
    expect(transcript.takeFold()?.[1]).toBe('● Write src/a.ts +1 -0 ✔')
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
    expect(transcript.render(callEvent('c1', 'write', {}))).toEqual(['● Editing 1 file'])
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Edited 1 file'])
    expect(transcript.takeFold()?.[1]).toBe('● Write src/a.ts +1 -0 ✔')
  })

  it('shortens a workspace path a terminal presenter embedded in its command', () => {
    const call = (): ToolCallView => ({ card: 'terminal', title: 'cat /repo/src/a.ts' })
    const transcript = build({ call })
    expect(transcript.render(callEvent('c1', 'bash', {}))).toEqual(['● Running 1 command'])
    expect(transcript.takeFold()?.[1]).toBe('● cat src/a.ts')
  })

  it('does not claim a line for a created file\'s trailing newline', () => {
    const result = (): ToolResultView => ({ card: 'diff', diffs: [{ path: '/repo/a.ts', oldText: null, newText: 'only\n' }] })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'write', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Edited 1 file'])
    expect((transcript.takeFold() ?? []).join('\n')).toContain('+ only')
  })

  it('keeps a long body in the fold and hands it to the pager on click', () => {
    const result = (): ToolResultView => ({ card: 'terminal', title: 'pnpm test', output: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Ran 1 command'])
    const fold = transcript.takeFold() ?? []
    expect(fold.join('\n')).toContain('line 29')
    expect(transcript.takePage()).toContain('line 29')
  })
})

describe('the body a group expansion carries', () => {
  it('keeps a very wide result line whole behind the fold', () => {
    const wide = `<html>${'<div class="x"></div>'.repeat(200)}</html>`
    const result = (): ToolResultView => ({ card: 'terminal', title: 'curl', output: `${wide}\nshort tail` })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Ran 1 command'])
    const fold = transcript.takeFold() ?? []
    expect(fold.some(line => line.includes(wide))).toBe(true)
    expect(fold.join('\n')).toContain('short tail')
  })

  it('shows short result lines in the fold with no reader page', () => {
    const result = (): ToolResultView => ({ card: 'terminal', title: 'bash', output: 'a\tb\nc' })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Ran 1 command'])
    expect(transcript.takeFold()).toEqual(['● Ran 1 command', '● bash ✔', '  a\tb', '  c'])
    expect(transcript.takePage()).toBeUndefined()
  })

  it('keeps an unpaired raw result in the fold rather than dropping it', () => {
    const transcript = build()
    expect(transcript.render(resultEvent('c9', 'y'.repeat(1000)))).toEqual(['● Used 1 tool'])
    expect((transcript.takeFold() ?? []).join('\n')).toContain('y'.repeat(1000))
  })
})

describe('the fold a group keeps', () => {
  it('carries the full uncapped body', () => {
    const long = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')
    const result = (): ToolResultView => ({ card: 'terminal', title: 'run', output: long })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', long))).toEqual(['● Ran 1 command'])
    const full = transcript.takeFold() ?? []
    expect(full[0]).toBe('● Ran 1 command')
    expect(full.join('\n')).toContain('line 19')
    expect(transcript.takeFold()).toBeUndefined()
  })

  it('folds a read with the content the row withheld', () => {
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

describe('a subagent row that is a view', () => {
  it('keeps the child session door on the group row', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'subagent', {}))
    const lines = transcript.render(resultEvent('c1', 'started subagent child-9'))
    expect(lines).toEqual(['● Ran 1 subagent'])
    expect(transcript.takeEnter()).toBe('child-9')
    expect(transcript.takeLabel()).toBe('Ran 1 subagent')
    expect(transcript.takeEnter()).toBeUndefined()
  })

  it('does not offer a view for a failed call', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'subagent', {}))
    transcript.render(resultEvent('c1', 'started subagent child-9', true))
    expect(transcript.takeEnter()).toBeUndefined()
  })
})

describe('a pending subagent row that is a view', () => {
  it('promotes a pending subagent call into a click-to-enter view', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'subagent', {}))
    expect(transcript.takeEnter()).toBeUndefined()
    expect(transcript.promotePendingView('child-9')).toEqual(['● Running 1 subagent'])
    expect(transcript.takeEnter()).toBe('child-9')
    expect(transcript.takeEnter()).toBeUndefined()
  })

  it('promotes a pending subagent_fork call the same way', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'subagent_fork', {}))
    expect(transcript.promotePendingView('fork-1')).toEqual(['● Running 1 subagent'])
    expect(transcript.takeEnter()).toBe('fork-1')
  })

  it('binds two unmatched pendings FIFO', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'subagent', {}))
    transcript.render(callEvent('c2', 'subagent_fork', {}))
    transcript.promotePendingView('first-child')
    expect(transcript.takeEnter()).toBe('first-child')
    transcript.promotePendingView('second-child')
    expect(transcript.takeEnter()).toBe('second-child')
  })

  it('still names the child on a later continuable start-result', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'subagent', {}))
    transcript.promotePendingView('child-9')
    expect(transcript.takeEnter()).toBe('child-9')
    expect(transcript.render(resultEvent('c1', 'started subagent child-9'))).toEqual(['● Ran 1 subagent'])
    expect(transcript.takeEnter()).toBe('child-9')
  })

  it('does not offer a view for a background job string', () => {
    expect(childSessionId('started background subagent job job-9')).toBeUndefined()
  })

  it('does not offer a view for a finished foreground result body', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'subagent', {}))
    transcript.render(resultEvent('c1', 'the child finished the work'))
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

  it('does not unfold a folded group when density switches', () => {
    const result = (): ToolResultView => ({
      card: 'diff',
      title: 'Edit',
      diffs: [{ path: '/repo/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }],
    })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'edit', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Edited 1 file'])
    transcript.setDensity('comfortable')
    const fold = transcript.takeFold() ?? []
    expect(fold[0]).toBe('● Edited 1 file')
    expect(transcript.takePage()).toBeUndefined()
  })

  it('pages a mid-size expanded diff in compact but not comfortable', () => {
    // 15 lines all changed → 30 hunk lines: over compact 24, under comfortable 48.
    const { oldText, newText } = allChanged(15)
    const result = (): ToolResultView => ({ card: 'diff', title: 'Edit', diffs: [{ path: '/repo/a.ts', oldText, newText }] })
    const compact = at('compact', { result })
    compact.render(callEvent('c1', 'edit', {}))
    expect(compact.render(resultEvent('c1', 'ok'))).toEqual(['● Edited 1 file'])
    expect(compact.takePage()).toBeDefined()

    const comfortable = at('comfortable', { result })
    comfortable.render(callEvent('c1', 'edit', {}))
    expect(comfortable.render(resultEvent('c1', 'ok'))).toEqual(['● Edited 1 file'])
    expect(comfortable.takePage()).toBeUndefined()
    expect(comfortable.takeFold()?.[0]).toBe('● Edited 1 file')
  })

  it('pages a large expanded diff in both densities', () => {
    const { oldText, newText } = allChanged(30)
    const result = (): ToolResultView => ({ card: 'diff', title: 'Edit', diffs: [{ path: '/repo/a.ts', oldText, newText }] })
    for (const density of ['compact', 'comfortable'] as const) {
      const transcript = at(density, { result })
      transcript.render(callEvent('c1', 'edit', {}))
      expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Edited 1 file'])
      expect(transcript.takePage()).toBeDefined()
    }
  })
})

describe('tool rows are muted, not panelled', () => {
  it('paints no background panel and no amber name on a settled tool row', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const transcript = new Transcript(
      { theme: colorTheme, columns: 80, cwd: CWD },
      {
        call: (): ToolCallView => ({ card: 'terminal', title: 'echo hi' }),
        result: (): ToolResultView => ({ card: 'terminal', title: 'echo hi', output: 'hi' }),
      },
    )
    transcript.render(callEvent('c1', 'bash', {}))
      const lines = transcript.render(resultEvent('c1', 'hi'))
    expect(lines).toEqual([`  ${colorTheme.muted('●')} ${colorTheme.dim('Ran 1 command')}`])
    expect(lines.join('\n')).not.toContain('\u001B[48;2;14;18;24m')
    expect(lines.join('\n')).not.toContain(colorTheme.tool('echo hi'))
    const fold = transcript.takeFold() ?? []
    expect(fold.join('\n')).not.toContain('\u001B[48;2;14;18;24m')
    expect(fold.join('\n')).toContain('hi')
  })

  it('still styles the thinking block with its own background panel', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const think = thinkingFold(['reasoning line'], colorTheme, 1.5)
    expect(think.summary).toEqual([
      colorTheme.bgThinking('  '),
      colorTheme.bgThinking(colorTheme.dim('  thought for 1.5s')),
      colorTheme.bgThinking('  '),
    ])
    expect(think.full[3]).toBe(colorTheme.bgThinking('reasoning line'))
  })

  it('opens a fresh group row after a run ends, with no divider pad', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const colored = new Transcript(
      { columns: 80, theme: colorTheme, cwd: CWD },
      { call: () => undefined, result: () => undefined },
    )
    colored.render(callEvent('c1', 'read', {}))
    colored.render(resultEvent('c1', ''))
    expect(colored.endRun()).toEqual([])
    const next = colored.render(callEvent('c2', 'grep', {}))
    expect(next.join('\n')).not.toContain('\u001B[48;2;14;18;24m')
    expect(next[0]).toContain('Using 1 tool')
  })

  it('uses assistant prose as the break between two groups', () => {
    const transcript = build({ call: () => undefined })
    transcript.render(callEvent('c1', 'read', {}))
    transcript.render(resultEvent('c1', ''))
    transcript.render({ type: 'assistant/message', seq: 3, time: 0, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'note' }], source: { kind: 'model' } } } } as SessionEvent)
    transcript.render(callEvent('c2', 'read', {}))
    expect(transcript.takePendingCard()).toEqual([])
    expect(transcript.render(resultEvent('c2', ''))).toEqual(['● Used 1 tool'])
  })

  it('carries a failure segment on the group row', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const transcript = new Transcript(
      { theme: colorTheme, columns: 80, cwd: CWD },
      { call: () => undefined, result: () => undefined },
    )
    transcript.render(callEvent('c1', 'bash', {}))
    const lines = transcript.render(resultEvent('c1', 'boom', true))
    expect(lines.join('\n')).toContain(colorTheme.error(' · 1 failed'))
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

describe('tool group aggregation', () => {
  const readResult = (): ToolResultView => ({
    card: 'read',
    path: '/repo/a.ts',
    offset: 1,
    lines: [{ number: 1, text: 'x' }],
    totalLines: 9,
  })

  it('renders five consecutive reads as one row that names reads and the count', () => {
    const transcript = build({ result: readResult })
    let last: string[] = []
    for (let index = 0; index < 5; index += 1) {
      transcript.render(callEvent(`c${index}`, 'read', {}))
      last = transcript.render(resultEvent(`c${index}`, 'ok'))
    }
    expect(last).toEqual(['● Read 5 files'])
    expect((transcript.takeFold() ?? []).filter(line => line.includes('read 1 of 9 lines ✔'))).toHaveLength(5)
  })

  it('renders a lone call with the same shape as a run', () => {
    const transcript = build({ result: readResult })
    transcript.render(callEvent('c1', 'read', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['● Read 1 file'])
  })

  it('counts each category separately in a mixed run, in first-appearance order', () => {
    const transcript = build({
      result: (name) => name === 'bash'
        ? { card: 'terminal', title: 'ls', output: 'a' }
        : name === 'edit'
          ? { card: 'diff', title: 'Edit', diffs: [{ path: '/repo/a.ts', oldText: 'a', newText: 'b' }] }
          : readResult(),
    })
    transcript.render(callEvent('c1', 'read', {}))
    transcript.render(resultEvent('c1', 'ok'))
    transcript.render(callEvent('c2', 'bash', {}))
    transcript.render(resultEvent('c2', 'ok'))
    transcript.render(callEvent('c3', 'edit', {}))
    expect(transcript.render(resultEvent('c3', 'ok'))).toEqual(['● Read 1 file, Ran 1 command, Edited 1 file'])
  })

  it('reads the run in the present tense while a member is pending', () => {
    const transcript = build({ result: readResult })
    transcript.render(callEvent('c1', 'read', {}))
    transcript.render(resultEvent('c1', 'ok'))
    expect(transcript.render(callEvent('c2', 'read', {}))).toEqual(['● Reading 1 file, Using 1 tool'])
  })

  it('breaks a run at assistant prose', () => {
    const transcript = build({ result: readResult })
    transcript.render(callEvent('c1', 'read', {}))
    transcript.render(resultEvent('c1', 'ok'))
    transcript.render({
      type: 'assistant/message',
      seq: 3,
      time: 0,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'now the next one' }], source: { kind: 'model' } } },
    } as SessionEvent)
    transcript.render(callEvent('c2', 'read', {}))
    expect(transcript.render(resultEvent('c2', 'ok'))).toEqual(['● Read 1 file'])
  })

  it('truncates the row on a narrow terminal rather than wrapping', () => {
    const narrow = new Transcript(
      { theme, columns: 10, cwd: CWD },
      { call: () => undefined, result: () => undefined },
    )
    narrow.render(callEvent('c1', 'read', {}))
    const rows = narrow.render(resultEvent('c1', 'ok'))
    expect(displayWidth(rows[0] ?? '')).toBeLessThanOrEqual(8)
    expect(rows[0]).toContain('…')
  })
})

describe('destructive classifier', () => {
  it('flags each delete category', () => {
    expect(destructiveCategory('rm -rf build')).toBe('delete')
    expect(destructiveCategory('rm -r node_modules')).toBe('delete')
    expect(destructiveCategory('sudo rm -Rf /tmp/x')).toBe('delete')
  })

  it('flags each history-rewrite category', () => {
    expect(destructiveCategory('git push --force origin main')).toBe('history')
    expect(destructiveCategory('git push -f origin main')).toBe('history')
    expect(destructiveCategory('git reset --hard HEAD~1')).toBe('history')
    expect(destructiveCategory('git clean -fd')).toBe('history')
    expect(destructiveCategory('git branch -D feature')).toBe('history')
  })

  it('flags each disk and permission category', () => {
    expect(destructiveCategory('mkfs.ext4 /dev/sda1')).toBe('disk')
    expect(destructiveCategory('dd if=/dev/zero of=/dev/sda')).toBe('disk')
    expect(destructiveCategory('chmod -R 777 .')).toBe('disk')
    expect(destructiveCategory('shutdown -h now')).toBe('disk')
  })

  it('flags each database and remote-kill category', () => {
    expect(destructiveCategory('psql -c "DROP TABLE users"')).toBe('database')
    expect(destructiveCategory('mysql -e "TRUNCATE logs"')).toBe('database')
    expect(destructiveCategory('DROP TABLE users')).toBe('database')
    expect(destructiveCategory('kill -9 1234')).toBe('database')
  })

  it('does not flag a benign command that merely mentions a dangerous token', () => {
    expect(destructiveCategory('grep -rn "rm -rf" .')).toBeUndefined()
    expect(destructiveCategory('echo "DROP TABLE users"')).toBeUndefined()
    expect(destructiveCategory('git log --grep="rm -rf"')).toBeUndefined()
    expect(destructiveCategory('git push origin main')).toBeUndefined()
    expect(destructiveCategory('git branch -d merged')).toBeUndefined()
    expect(destructiveCategory('rm file.txt')).toBeUndefined()
    expect(destructiveCategory('chmod 644 file')).toBeUndefined()
    expect(destructiveCategory('kill -15 123')).toBeUndefined()
    expect(destructiveCategory('npm run clean')).toBeUndefined()
  })

  it('anchors to each segment head, never to a later argument', () => {
    expect(destructiveCategory('echo done && rm -rf /')).toBe('delete')
    expect(destructiveCategory('printf "%s" "git reset --hard"')).toBeUndefined()
  })
})

describe('destructive breakout', () => {
  const commandPresenters = (): Partial<ToolPresenters> => ({
    call: (name, args) => ({ card: 'terminal', title: (args as { command?: string } | undefined)?.command ?? name }),
    result: (name, args) => ({ card: 'terminal', title: (args as { command?: string } | undefined)?.command ?? name, output: 'done' }),
  })

  it('renders a destructive command on its own row instead of joining the group', () => {
    const transcript = build(commandPresenters())
    transcript.render(callEvent('c1', 'bash', { command: 'ls' }))
    transcript.render(resultEvent('c1', 'ok'))
    const solo = transcript.render(callEvent('c2', 'bash', { command: 'rm -rf build' }))
    expect(solo).toEqual(['⚠ rm -rf build'])
    // The earlier group is untouched by the breakout.
    expect(transcript.takePendingCard()).toEqual([])
  })

  it('leaves the surrounding calls able to group on either side', () => {
    const transcript = build(commandPresenters())
    transcript.render(callEvent('c1', 'bash', { command: 'ls' }))
    transcript.render(resultEvent('c1', 'ok'))
    transcript.render(callEvent('c2', 'bash', { command: 'rm -rf build' }))
    transcript.render(resultEvent('c2', 'ok'))
    transcript.render(callEvent('c3', 'bash', { command: 'echo one' }))
    transcript.render(resultEvent('c3', 'ok'))
    transcript.render(callEvent('c4', 'bash', { command: 'echo two' }))
    expect(transcript.render(resultEvent('c4', 'ok'))).toEqual(['● Ran 2 commands'])
  })

  it('pulls a call waiting on the person out of the group', () => {
    const transcript = build(commandPresenters())
    transcript.render(callEvent('c1', 'bash', { command: 'ls' }))
    transcript.render(callEvent('c2', 'bash', { command: 'echo two' }))
    const lines = transcript.markApproval('c2')
    // The run keeps its own row; the question stands alone.
    expect(lines).toEqual(['● Running 1 command', '⚠ echo two'])
    expect(transcript.takePendingCard()).toEqual(['● Running 2 commands'])
  })

  it('never folds an approval-gated call away once it settles', () => {
    const transcript = build(commandPresenters())
    transcript.render(callEvent('c1', 'bash', { command: 'ls' }))
    transcript.render(callEvent('c2', 'bash', { command: 'echo two' }))
    transcript.markApproval('c2')
    expect(transcript.render(resultEvent('c2', 'ok'))).toEqual(['⚠ echo two ✔'])
  })

  it('carries the warning role on the destructive row', () => {
    const colorTheme = createTheme(true, { COLORTERM: 'truecolor' })
    const transcript = new Transcript(
      { theme: colorTheme, columns: 80, cwd: CWD },
      {
        call: (name, args) => ({ card: 'terminal', title: (args as { command?: string } | undefined)?.command ?? name }),
        result: () => undefined,
      },
    )
    transcript.render(callEvent('c1', 'bash', { command: 'rm -rf build' }))
    expect(transcript.takeRule()).toBe(blockRules(colorTheme).error)
  })
})

describe('destructive edge cases', () => {
  it('flags a dangerous command chained after a benign one', () => {
    expect(destructiveCategory('cd /tmp && rm -rf build')).toBe('delete')
    expect(destructiveCategory('ls; git reset --hard HEAD~1')).toBe('history')
    expect(destructiveCategory('cat log | mkfs.ext4 /dev/sda1')).toBe('disk')
  })

  it('flags reordered and combined flags', () => {
    expect(destructiveCategory('rm -fr build')).toBe('delete')
    expect(destructiveCategory('rm --recursive build')).toBe('delete')
    expect(destructiveCategory('git clean -df')).toBe('history')
    expect(destructiveCategory('git push origin main --force')).toBe('history')
    expect(destructiveCategory('chmod 777 -R .')).toBe('disk')
  })

  it('does not flag a dangerous string inside a quoted argument', () => {
    expect(destructiveCategory('printf "%s" "rm -rf /"')).toBeUndefined()
    expect(destructiveCategory("echo 'git reset --hard'")).toBeUndefined()
    expect(destructiveCategory('git commit -m "fix rm -rf handling"')).toBeUndefined()
  })

  it('sees through a shell wrapper and a shell -c script', () => {
    expect(destructiveCategory('sudo rm -rf /var/log')).toBe('delete')
    expect(destructiveCategory('bash -c "rm -rf /tmp/x"')).toBe('delete')
    expect(destructiveCategory('sh -c "git push --force"')).toBe('history')
  })

  it('records an accepted miss: a sibling separator inside a quoted script is not a chain', () => {
    // `bash -c` recursion splits the script itself, so this is flagged.
    expect(destructiveCategory('bash -c "echo hi; rm -rf /"')).toBe('delete')
  })
})

describe('live and replay parity', () => {
  const presenters: Partial<ToolPresenters> = {
    call: (name, args) => name === 'bash'
      ? { card: 'terminal', title: (args as { command?: string } | undefined)?.command ?? name }
      : undefined,
    result: (name, args) => name === 'bash'
      ? { card: 'terminal', title: (args as { command?: string } | undefined)?.command ?? name, output: 'out' }
      : { card: 'read', path: '/repo/a.ts', offset: 1, lines: [{ number: 1, text: 'x' }], totalLines: 9 },
  }

  const sequence = (): SessionEvent[] => [
    callEvent('c1', 'read', {}),
    resultEvent('c1', 'ok'),
    callEvent('c2', 'bash', { command: 'ls' }),
    resultEvent('c2', 'ok'),
    callEvent('c3', 'bash', { command: 'rm -rf build' }),
    resultEvent('c3', 'ok', true),
    callEvent('c4', 'read', {}),
    resultEvent('c4', 'ok'),
  ]

  it('produces identical group rows through the live and replay entry points', () => {
    const render = (events: readonly SessionEvent[]): string[] => {
      const transcript = build(presenters)
      return events.flatMap(event => transcript.render(event))
    }
    const live = render(sequence())
    const replay = render(sequence())
    expect(replay).toEqual(live)
    expect(live).toContain('● Read 1 file, Ran 1 command')
    expect(live.join('\n')).toContain('⚠ rm -rf build')
  })

  it('settles an interrupted run so its row does not read as still running', () => {
    const transcript = build(presenters)
    transcript.render(callEvent('c1', 'bash', { command: 'sleep 30' }))
    expect(transcript.endRun()).toEqual(['● Ran 1 command'])
    expect(transcript.takePendingCard()).toEqual(['● Running 1 command'])
  })

  it('re-renders a replayed grouped run as the same openable group', () => {
    const transcript = build(presenters)
    const rows = sequence().flatMap(event => transcript.render(event))
    const fold = transcript.takeFold() ?? []
    expect(rows.at(-1)).toBe('● Read 1 file')
    expect(fold.join('\n')).toContain('read 1 of 9 lines ✔')
  })
})
