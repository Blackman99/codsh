/** Regressions at the question-provider boundary, including real widget keys. */
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it, vi } from 'vitest'
import { FrontierCard, type FrontierOutcome } from '../src/frontier-card.ts'
import { TerminalQuestions } from '../src/questions.ts'
import { createTheme } from '../src/theme.ts'

const theme = createTheme(false, {})
const request = {
  questions: [
    { id: 'storage', question: 'Storage?', header: 'ship · grill', options: [{ label: 'SQLite' }, { label: 'Postgres' }], multiSelect: true },
    { id: 'cache', question: 'Cache?', header: 'ship · grill', options: [{ label: 'Memory' }, { label: 'Redis' }] },
    { id: 'path', question: 'Path?', header: 'ship · grill', options: [{ label: 'docs/' }] },
  ],
} as AskUserQuestionRequest

describe('consecutive question answers', () => {
  it('does not mistake words in a choice explanation for a write-in label', async () => {
    const provider = new TerminalQuestions({ read: async () => undefined }, theme, () => {}, undefined, undefined, async spec => {
      expect(spec.options[0]?.writeIn).not.toBe(true)
      expect(spec.options[1]?.writeIn).toBe(true)
      return { kind: 'accept', value: 'Compatible' }
    })
    await provider.ask({ ...request, questions: [{ id: 'compat', question: 'Mode?', header: 'ship · grill', options: [
      { label: 'Compatible', description: 'Works with other editors and custom providers.' },
      { label: '其他（请说明）' },
    ] }] })
  })

  it('honors recommendations in labels without marking a not-recommended choice', async () => {
    const provider = new TerminalQuestions({ read: async () => undefined }, theme, () => {}, undefined, undefined, async spec => {
      expect(spec.options[0]?.recommended).not.toBe(true)
      expect(spec.options[1]?.recommended).toBe(true)
      return { kind: 'dismiss' }
    })
    await provider.ask({ ...request, questions: [{ id: 'compat', question: 'Mode?', header: 'ship · grill', options: [
      { label: 'Legacy', description: 'Not recommended for new projects.' },
      { label: 'Modern (Recommended)' },
    ] }] })
  })

  it('prints each final answer once, after repeated revisions across the batch', async () => {
    const output: string[] = []
    const steps: FrontierOutcome[] = [
      { kind: 'accept', value: 'SQLite' }, { kind: 'accept', value: 'Redis' },
      { kind: 'back' }, { kind: 'back' }, { kind: 'accept', value: 'Postgres' },
      { kind: 'accept', value: 'Memory' }, { kind: 'accept', value: 'docs/' },
    ]
    const provider = new TerminalQuestions({ read: async () => undefined }, theme, line => output.push(line), undefined, undefined, async () => {
      expect(output).toEqual([])
      const step = steps.shift()
      if (step === undefined) throw new Error('Unexpected extra question')
      return step
    })
    expect(await provider.ask(request)).toEqual({ answers: [
      { id: 'storage', selected: ['Postgres'] },
      { id: 'cache', selected: ['Memory'] },
      { id: 'path', selected: ['docs/'] },
    ] })
    expect(output).toEqual(['  ✓ Postgres', '  ✓ Memory', '  ✓ docs/'])
  })

  it.each(['back', 'next', 'edit'])('keeps the literal custom answer %s as data', async (custom) => {
    const frontier = vi.fn(async (): Promise<FrontierOutcome> => {
      if (frontier.mock.calls.length > 1) return { kind: 'dismiss' }
      return { kind: 'accept', value: custom, custom: true }
    })
    const provider = new TerminalQuestions({ read: async () => undefined }, theme, () => {}, undefined, undefined, frontier)
    expect(await provider.ask({ ...request, questions: request.questions.slice(0, 1) })).toEqual({
      answers: [{ id: 'storage', selected: [], custom }],
    })
    expect(frontier).toHaveBeenCalledTimes(1)
  })

  it('stops the batch on dismiss without opening the next card', async () => {
    const frontier = vi.fn(async (): Promise<FrontierOutcome> => ({ kind: 'dismiss' }))
    const provider = new TerminalQuestions({ read: async () => undefined }, theme, () => {}, undefined, undefined, frontier)
    expect((await provider.ask(request)).answers).toEqual(request.questions.map(q => ({ id: q.id, selected: [] })))
    expect(frontier).toHaveBeenCalledTimes(1)
  })

  it('does not open or print any questions for an aborted request', async () => {
    const frontier = vi.fn(async (): Promise<FrontierOutcome> => ({ kind: 'dismiss' }))
    const write = vi.fn()
    const provider = new TerminalQuestions({ read: async () => undefined }, theme, write, undefined, undefined, frontier)
    await provider.ask({ ...request, signal: AbortSignal.abort() })
    expect(frontier).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('stops reading and printing subsequent questions at EOF', async () => {
    const read = vi.fn(async () => undefined)
    const output: string[] = []
    await new TerminalQuestions({ read }, theme, line => output.push(line)).ask(request)
    expect(read).toHaveBeenCalledTimes(1)
    expect(output.join('\n')).not.toContain('Cache?')
  })

  it('submits multiple choices from the real frontier widget and restores all on revisit', async () => {
    let visit = 0
    const provider = new TerminalQuestions({ read: async () => undefined }, theme, () => {}, undefined, undefined, async spec => {
      const card = new FrontierCard(spec)
      visit += 1
      if (visit === 1) {
        card.handleKey({ kind: 'text', text: ' ' })
        card.handleKey({ kind: 'down' })
        card.handleKey({ kind: 'text', text: ' ' })
      } else if (visit === 2) return { kind: 'back' }
      else if (visit === 3) {
        const painted = card.frame(theme, 80).rows.join('\n')
        expect(painted.match(/\[x\]/g)).toHaveLength(2)
      }
      const outcome = card.handleKey({ kind: 'enter' })
      if (outcome === undefined || outcome.kind === 'move') throw new Error('Enter must submit')
      return outcome
    })
    expect((await provider.ask({ ...request, questions: request.questions.slice(0, 2) })).answers).toEqual([
      { id: 'storage', selected: ['SQLite', 'Postgres'] },
      { id: 'cache', selected: ['Memory'] },
    ])
  })
})
