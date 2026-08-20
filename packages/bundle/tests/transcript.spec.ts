/**
 * One appended session event renders to finished terminal lines. Cards come
 * from the registered presenters, and a missing or throwing presenter degrades
 * to the generic line rather than breaking the transcript.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { createTheme } from '../src/theme.ts'
import { Transcript, type ToolPresenters } from '../src/transcript.ts'

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
    expect(build().render(event)).toEqual(['› fix the bug', ''])
  })

  it('aligns a multi-line prompt under its marker, matching the input box', () => {
    const event = {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: { role: 'user', content: [{ type: 'text', text: 'first line\nsecond line' }], source: { kind: 'user' } },
    } as unknown as SessionEvent
    expect(build().render(event)).toEqual(['› first line', '  second line', ''])
  })

  it('shows nothing for injected plugin context', () => {
    const event = {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: { role: 'user', content: [{ type: 'text', text: 'AGENTS.md' }], source: { kind: 'plugin', plugin: 'agent-instructions' } },
    } as unknown as SessionEvent
    expect(build().render(event)).toEqual([])
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

  it('renders a terminal call as a command line with its workspace-relative cwd', () => {
    const call = (): ToolCallView => ({ card: 'terminal', title: 'pnpm test', cwd: '/repo/apps', description: 'run the suite' })
    expect(build({ call }).render(callEvent('c1', 'bash', {}))).toEqual([
      '● bash (apps)',
      '  $ pnpm test',
      '  run the suite',
    ])
  })

  it('renders a diff call with its paths relativized', () => {
    const call = (): ToolCallView => ({ card: 'diff', title: 'Write', diffs: [{ path: '/repo/src/a.ts', oldText: null, newText: 'x' }] })
    expect(build({ call }).render(callEvent('c1', 'write', {}))).toEqual(['● Write src/a.ts'])
  })

  it('renders a generic call with its follow-along locations', () => {
    const call = (): ToolCallView => ({ card: 'generic', title: 'Read a.ts', locations: [{ path: '/repo/src/a.ts' }] })
    expect(build({ call }).render(callEvent('c1', 'read', {}))).toEqual(['● Read a.ts src/a.ts'])
  })

  it('still records the call when its arguments do not parse', () => {
    const event = { type: 'tool/call', seq: 1, time: 0, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{oops' } } as SessionEvent
    const transcript = build()
    expect(transcript.render(event)).toEqual(['● bash'])
    expect(transcript.render(resultEvent('c1', 'out'))).toEqual(['  out', ''])
  })

  it('degrades to the generic line when a call presenter throws', () => {
    const call = () => { throw new Error('presenter is broken') }
    expect(build({ call }).render(callEvent('c1', 'grep', {}))).toEqual(['● grep'])
  })
})

describe('tool results', () => {
  it('pairs a result with its call and prints the body', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'grep', {}))
    // The pending card already printed the header; an append-only transcript
    // cannot replace it, so an unchanged successful result adds only its body.
    expect(transcript.render(resultEvent('c1', 'two matches'))).toEqual(['  two matches', ''])
  })

  it('marks a failed call', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', 'exit 1', true))[0]).toBe('✗ bash')
  })

  it('renders a diff result as marked lines', () => {
    const result = (): ToolResultView => ({
      card: 'diff',
      title: 'Edit',
      diffs: [{ path: '/repo/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }],
    })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'edit', {}))
    // The result title differs from the pending one, so the header reprints.
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual([
      '● Edit',
      '- const a = 1',
      '+ const a = 2',
      '',
    ])
  })

  it('renders a created file as all additions', () => {
    const result = (): ToolResultView => ({ card: 'diff', diffs: [{ path: '/repo/a.ts', oldText: null, newText: 'a\nb' }] })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'write', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['+ a', '+ b', ''])
  })

  it('shows a non-zero exit status on a terminal result', () => {
    const result = (): ToolResultView => ({ card: 'terminal', title: 'pnpm test', output: 'failed', exitCode: 1 })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    // No call presenter here, so the pending title was the tool name: the
    // result's own title differs, which is what brings the header back.
    expect(transcript.render(resultEvent('c1', 'failed'))).toEqual(['● pnpm test (exit 1)', '  failed', ''])
  })

  it('reports a signal kill instead of an exit code', () => {
    const result = (): ToolResultView => ({ card: 'terminal', title: 'sleep', signal: 'SIGTERM' })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    expect(transcript.render(resultEvent('c1', ''))[0]).toBe('● sleep (killed by SIGTERM)')
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
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['  1 results', '  a.ts', '    3: const a = 1', ''])
  })

  it('marks a capped search as capped', () => {
    const result = (): ToolResultView => ({ card: 'search', shape: 'paths', paths: ['/repo/a.ts'], truncated: true, total: 900 })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'glob', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))[0]).toBe('  900+ (capped) results')
  })

  it('adds a status under an unchanged header rather than repeating it', () => {
    const call = (): ToolCallView => ({ card: 'terminal', title: 'pnpm test' })
    const result = (): ToolResultView => ({ card: 'terminal', title: 'pnpm test', output: 'out', exitCode: 1 })
    const transcript = build({ call, result })
    transcript.render(callEvent('c1', 'bash', {}))
    // The pending card already said `pnpm test`; only the exit status is new.
    expect(transcript.render(resultEvent('c1', 'failed'))).toEqual(['  (exit 1)', '  out', ''])
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
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['  1 of 12 lines', ''])
  })

  it('prints an unpaired result rather than dropping it', () => {
    expect(build().render(resultEvent('missing', 'orphan'))).toEqual(['● (result)', 'orphan', ''])
  })

  it('degrades to the generic card when a result presenter throws', () => {
    const result = () => { throw new Error('presenter is broken') }
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'grep', {}))
    expect(transcript.render(resultEvent('c1', 'two matches'))).toEqual(['  two matches', ''])
  })

  it('confirms a completion that carries no body', () => {
    const transcript = build()
    transcript.render(callEvent('c1', 'todo_write', {}))
    // Nothing to show and nothing changed, but the call must not look pending.
    expect(transcript.render(resultEvent('c1', ''))).toEqual(['  ✓', ''])
  })

  it('does not repeat a path the presenter already put in its title', () => {
    const call = (): ToolCallView => ({
      card: 'diff',
      title: 'Write /repo/src/a.ts',
      diffs: [{ path: '/repo/src/a.ts', oldText: null, newText: 'x' }],
    })
    // The title names the file, so the card appends no second copy of it.
    expect(build({ call }).render(callEvent('c1', 'write', {}))).toEqual(['● Write src/a.ts'])
  })

  it('appends a path the presenter left out of its title', () => {
    const call = (): ToolCallView => ({
      card: 'diff',
      title: 'Write',
      diffs: [{ path: '/repo/src/a.ts', oldText: null, newText: 'x' }],
    })
    expect(build({ call }).render(callEvent('c1', 'write', {}))).toEqual(['● Write src/a.ts'])
  })

  it('shortens a workspace path a terminal presenter embedded in its command', () => {
    const call = (): ToolCallView => ({ card: 'terminal', title: 'cat /repo/src/a.ts' })
    expect(build({ call }).render(callEvent('c1', 'bash', {}))).toEqual(['● bash', '  $ cat src/a.ts'])
  })

  it('does not claim a line for a created file\'s trailing newline', () => {
    const result = (): ToolResultView => ({ card: 'diff', diffs: [{ path: '/repo/a.ts', oldText: null, newText: 'only\n' }] })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'write', {}))
    expect(transcript.render(resultEvent('c1', 'ok'))).toEqual(['+ only', ''])
  })

  it('collapses a long body behind a count that names the expand key', () => {
    const result = (): ToolResultView => ({ card: 'terminal', title: 'pnpm test', output: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    const lines = transcript.render(resultEvent('c1', 'ok'))
    // Five skimmable lines; the rest collapse behind an affordance, not a bare count.
    expect(lines.join('\n')).toContain('line 4')
    expect(lines.join('\n')).not.toContain('line 5')
    expect(lines.at(-2)).toBe('  … +25 lines (Ctrl+O expands)')
  })
})

describe('folding collapsed output', () => {
  it('offers the full event lines when the body was collapsed', () => {
    const long = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')
    const result = (): ToolResultView => ({ card: 'terminal', title: 'run', output: long })
    const transcript = build({ result })
    transcript.render(callEvent('c1', 'bash', {}))
    const shown = transcript.render(resultEvent('c1', long))
    expect(shown.join('\n')).toContain('… +15 lines (Ctrl+O expands)')
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
