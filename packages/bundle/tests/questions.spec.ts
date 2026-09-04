/**
 * The terminal question provider encodes a numbered selection as option
 * labels and anything else as the free-text answer.
 */

import type { AskUserQuestionItem, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it } from 'vitest'
import { detectShipGate, detectShipGrill, encodeAnswer, encodeFrontierAnswer, encodeGateAnswer, questionLines, shipGateKind, TerminalQuestions } from '../src/questions.ts'
import { createTheme } from '../src/theme.ts'

const theme = createTheme(false, {})

const choice: AskUserQuestionItem = {
  id: 'q1',
  question: 'Which approach?',
  options: [{ label: 'Rewrite' }, { label: 'Patch', description: 'smaller diff' }],
}

describe('encodeAnswer', () => {
  it('selects one option by its number', () => {
    expect(encodeAnswer('2', choice)).toEqual({ id: 'q1', selected: ['Patch'] })
  })

  it('ignores a second number on a single-select question', () => {
    expect(encodeAnswer('1,2', choice)).toEqual({ id: 'q1', selected: ['Rewrite'] })
  })

  it('selects several options when the question is multi-select', () => {
    const multi = { ...choice, multiSelect: true }
    expect(encodeAnswer('1, 2', multi)).toEqual({ id: 'q1', selected: ['Rewrite', 'Patch'] })
  })

  it('treats a non-index line as the free-text answer', () => {
    expect(encodeAnswer('neither, split it', choice)).toEqual({ id: 'q1', selected: [], custom: 'neither, split it' })
  })

  it('treats an out-of-range number as free text rather than a wrong option', () => {
    expect(encodeAnswer('9', choice)).toEqual({ id: 'q1', selected: [], custom: '9' })
  })

  it('answers a question with no options as free text', () => {
    const open: AskUserQuestionItem = { id: 'q2', question: 'Name it' }
    expect(encodeAnswer('slugify', open)).toEqual({ id: 'q2', selected: [], custom: 'slugify' })
  })

  it('answers an empty line as no selection', () => {
    expect(encodeAnswer('   ', choice)).toEqual({ id: 'q1', selected: [] })
  })
})

describe('questionLines', () => {
  it('numbers the options and shows their descriptions', () => {
    const text = questionLines(choice, theme).join('\n')
    expect(text).toContain('Which approach?')
    expect(text).toContain('1. Rewrite')
    expect(text).toContain('2. Patch — smaller diff')
    expect(text).toContain('a number, or type your own answer')
  })

  it('shows the header and detail when the caller supplies them', () => {
    const text = questionLines({ ...choice, header: 'Approach', detail: 'both are reversible' }, theme).join('\n')
    expect(text).toContain('[Approach]')
    expect(text).toContain('both are reversible')
  })

  it('explains multi-select differently', () => {
    const text = questionLines({ ...choice, multiSelect: true }, theme).join('\n')
    expect(text).toContain('numbers separated by commas')
  })

  it('offers no menu instructions for an open question', () => {
    const text = questionLines({ id: 'q2', question: 'Name it' }, theme).join('\n')
    expect(text).not.toContain('type your own answer')
  })
})

describe('TerminalQuestions', () => {
  it('answers every question in one request, in order', async () => {
    const typed = ['1', 'because it is smaller']
    let read = 0
    const questions = new TerminalQuestions(
      { read: () => Promise.resolve(typed[read++]) },
      theme,
      () => {},
    )
    const request = {
      questions: [choice, { id: 'q2', question: 'Why?' }],
    } as AskUserQuestionRequest
    expect(await questions.ask(request)).toEqual({
      answers: [
        { id: 'q1', selected: ['Rewrite'] },
        { id: 'q2', selected: [], custom: 'because it is smaller' },
      ],
    })
  })

  it('answers empty when input ends, so the tool call resolves instead of hanging', async () => {
    const questions = new TerminalQuestions({ read: () => Promise.resolve(undefined) }, theme, () => {})
    const request = { questions: [choice] } as AskUserQuestionRequest
    expect(await questions.ask(request)).toEqual({ answers: [{ id: 'q1', selected: [] }] })
  })
})

describe('plan review', () => {
  const plan: AskUserQuestionItem = {
    id: 'plan',
    question: 'Approve this plan?',
    detail: '# Title\n\n- step one\n- step two',
    options: [{ label: 'Yes, implement it' }, { label: 'No, keep planning' }],
    intent: { kind: 'plan-review', approve: 'Yes, implement it' },
  }

  it('renders the plan as content, not as an aside', () => {
    const text = questionLines(plan, theme).join('\n')
    // The plan IS the decision; folded into a dim hint it cannot be reviewed.
    expect(text).toContain('plan for review')
    expect(text).toContain('# Title')
    expect(text).toContain('- step two')
    expect(text).toContain('Approve this plan?')
  })

  it('numbers the options so the approving one can be chosen', () => {
    const text = questionLines(plan, theme).join('\n')
    expect(text).toContain('1. Yes, implement it')
    expect(text).toContain('2. No, keep planning')
  })

  it('encodes the approval like any other selection', () => {
    expect(encodeAnswer('1', plan)).toEqual({ id: 'plan', selected: ['Yes, implement it'] })
  })
})

describe('ship gate detection', () => {
  it('detects gate numbers from the ship header', () => {
    expect(detectShipGate('ship · gate 1/2')).toBe(1)
    expect(detectShipGate('ship · gate 2/2')).toBe(2)
    expect(detectShipGate('ship • gate 1/2')).toBe(1)
    expect(detectShipGate('ship gate 2/2')).toBe(2)
    // Incomplete / non-gate headers must not open GateModal.
    expect(detectShipGate('ship · gate 1')).toBeUndefined()
    expect(detectShipGate('ship · gate 2')).toBeUndefined()
    expect(detectShipGate('gate 1/2')).toBeUndefined()
    expect(detectShipGate('Approach')).toBeUndefined()
    expect(detectShipGate(undefined)).toBeUndefined()
  })

  it('recognises gate headers only — not confirm/approve phrasing alone', () => {
    expect(shipGateKind({ id: 'g1', question: 'Ready?', header: 'ship · gate 1/2' })).toBe('spec')
    expect(shipGateKind({ id: 'g2', question: 'Ready?', header: 'ship · gate 2/2' })).toBe('tickets')
    // Wording without the header must stay on Selector — ONLY /ship two doors.
    expect(shipGateKind({ id: 'g3', question: 'Please confirm spec' })).toBeUndefined()
    expect(shipGateKind({ id: 'g4', question: 'Approve tickets now' })).toBeUndefined()
    expect(shipGateKind({ id: 'g5', question: 'Which approach?' })).toBeUndefined()
  })

  it('maps confirm/edit/abort onto ask_user_question answers', () => {
    const q = {
      id: 'gate',
      question: 'Confirm?',
      options: [{ label: 'Confirm' }, { label: 'Edit' }, { label: 'Abort' }],
    }
    expect(encodeGateAnswer(q, 'confirm')).toEqual({ id: 'gate', selected: ['Confirm'] })
    expect(encodeGateAnswer(q, 'edit')).toEqual({ id: 'gate', selected: [], custom: 'edit' })
    expect(encodeGateAnswer(q, 'abort')).toEqual({ id: 'gate', selected: [] })
  })

  it('routes a ship gate header to the gate ask when provided', async () => {
    const calls: string[] = []
    const questions = new TerminalQuestions(
      { read: () => Promise.resolve(undefined) },
      theme,
      () => {},
      undefined,
      async (spec) => {
        calls.push(spec.title)
        expect(spec.kind).toBe('spec')
        expect(spec.bodyLines.join('\n')).toContain('Acceptance')
        return 'confirm'
      },
    )
    const request = {
      questions: [{
        id: 'g1',
        question: 'Confirm this spec?',
        header: 'ship · gate 1/2',
        detail: 'Acceptance\n✔ criterion',
        options: [{ label: 'Confirm' }, { label: 'Edit' }, { label: 'Abort' }],
      }],
    } as AskUserQuestionRequest
    expect(await questions.ask(request)).toEqual({
      answers: [{ id: 'g1', selected: ['Confirm'] }],
    })
    expect(calls).toEqual(['ship · gate 1/2 — confirm spec'])
  })

  it('maps edit and abort from the gate modal', async () => {
    const questions = new TerminalQuestions(
      { read: () => Promise.resolve(undefined) },
      theme,
      () => {},
      undefined,
      async () => 'edit',
    )
    const request = {
      questions: [{
        id: 'g2',
        question: 'Approve tickets?',
        header: 'ship · gate 2/2',
        options: [{ label: 'Confirm' }, { label: 'Edit' }, { label: 'Abort' }],
      }],
    } as AskUserQuestionRequest
    expect(await questions.ask(request)).toEqual({
      answers: [{ id: 'g2', selected: [], custom: 'edit' }],
    })

    const aborting = new TerminalQuestions(
      { read: () => Promise.resolve(undefined) },
      theme,
      () => {},
      undefined,
      async () => 'abort',
    )
    expect(await aborting.ask(request)).toEqual({
      answers: [{ id: 'g2', selected: [] }],
    })
  })

  it('keeps the pipe/line-reader path when no gate fn is provided', async () => {
    const questions = new TerminalQuestions(
      { read: () => Promise.resolve('1') },
      theme,
      () => {},
    )
    const request = {
      questions: [{
        id: 'g1',
        question: 'Confirm this spec?',
        header: 'ship · gate 1/2',
        options: [{ label: 'Confirm' }, { label: 'Edit' }, { label: 'Abort' }],
      }],
    } as AskUserQuestionRequest
    expect(await questions.ask(request)).toEqual({
      answers: [{ id: 'g1', selected: ['Confirm'] }],
    })
  })

  it('routes ordinary questions to Selector even when a gate fn is present', async () => {
    const selects: string[] = []
    const gates: string[] = []
    const questions = new TerminalQuestions(
      { read: () => Promise.resolve(undefined) },
      theme,
      () => {},
      async (spec) => {
        selects.push(spec.title)
        return { kind: 'chosen', indices: [0] }
      },
      async (spec) => {
        gates.push(spec.title)
        return 'confirm'
      },
    )
    const request = {
      questions: [{
        id: 'q1',
        question: 'Which approach?',
        options: [{ label: 'Rewrite' }, { label: 'Patch' }],
      }],
    } as AskUserQuestionRequest
    expect(await questions.ask(request)).toEqual({
      answers: [{ id: 'q1', selected: ['Rewrite'] }],
    })
    expect(selects).toEqual(['Which approach?'])
    expect(gates).toEqual([])
  })

  it('detects grill headers and ignores gate / ordinary headers', () => {
    expect(detectShipGrill('ship · grill')).toBe(true)
    expect(detectShipGrill('ship • grill')).toBe(true)
    expect(detectShipGrill('ship grill')).toBe(true)
    expect(detectShipGrill('SHIP · GRILL')).toBe(true)
    expect(detectShipGrill('ship · gate 1/2')).toBeUndefined()
    expect(detectShipGrill('ship · gate 2/2')).toBeUndefined()
    expect(detectShipGrill('Approach')).toBeUndefined()
    expect(detectShipGrill(undefined)).toBeUndefined()
  })

  it('maps frontier accept / edit / dismiss onto ask_user_question answers', () => {
    const q = {
      id: 'grill',
      question: 'Storage?',
      options: [{ label: 'SQLite', description: 'recommended' }, { label: 'Postgres' }],
    }
    expect(encodeFrontierAnswer(q, { kind: 'accept', value: 'SQLite' })).toEqual({ id: 'grill', selected: ['SQLite'] })
    expect(encodeFrontierAnswer(q, { kind: 'edit' })).toEqual({ id: 'grill', selected: [], custom: 'edit' })
    expect(encodeFrontierAnswer(q, { kind: 'dismiss' })).toEqual({ id: 'grill', selected: [] })
  })

  it('routes a grill header to the frontier ask when provided', async () => {
    const calls: string[] = []
    const questions = new TerminalQuestions(
      { read: () => Promise.resolve(undefined) },
      theme,
      () => {},
      async () => ({ kind: 'chosen', indices: [1] }),
      async () => 'confirm',
      async (spec) => {
        calls.push(spec.question)
        expect(spec.options[0]?.recommended).toBe(true)
        return { kind: 'accept', value: spec.options[0]?.label ?? '' }
      },
    )
    const request = {
      questions: [{
        id: 'f1',
        question: 'Which storage?',
        header: 'ship · grill',
        options: [{ label: 'SQLite', description: 'recommended' }, { label: 'Postgres' }],
      }],
    } as AskUserQuestionRequest
    expect(await questions.ask(request)).toEqual({
      answers: [{ id: 'f1', selected: ['SQLite'] }],
    })
    expect(calls).toEqual(['Which storage?'])
  })

  it('maps frontier edit and dismiss without writing abort', async () => {
    const written: string[] = []
    const editing = new TerminalQuestions(
      { read: () => Promise.resolve(undefined) },
      theme,
      line => { written.push(line) },
      undefined,
      undefined,
      async () => ({ kind: 'edit' }),
    )
    const request = {
      questions: [{
        id: 'f2',
        question: 'Which storage?',
        header: 'ship · grill',
        options: [{ label: 'SQLite' }, { label: 'Postgres' }],
      }],
    } as AskUserQuestionRequest
    expect(await editing.ask(request)).toEqual({
      answers: [{ id: 'f2', selected: [], custom: 'edit' }],
    })
    expect(written.join('\n')).toContain('edit')
    expect(written.join('\n')).not.toContain('aborted')

    written.length = 0
    const dismissing = new TerminalQuestions(
      { read: () => Promise.resolve(undefined) },
      theme,
      line => { written.push(line) },
      undefined,
      undefined,
      async () => ({ kind: 'dismiss' }),
    )
    expect(await dismissing.ask(request)).toEqual({
      answers: [{ id: 'f2', selected: [] }],
    })
    expect(written.join('\n')).not.toContain('aborted')
  })

  it('keeps a gate header on GateModal even when a frontier fn is present', async () => {
    const selects: string[] = []
    const gates: string[] = []
    const fronts: string[] = []
    const questions = new TerminalQuestions(
      { read: () => Promise.resolve(undefined) },
      theme,
      () => {},
      async (spec) => {
        selects.push(spec.title)
        return { kind: 'chosen', indices: [0] }
      },
      async (spec) => {
        gates.push(spec.title)
        return 'confirm'
      },
      async (spec) => {
        fronts.push(spec.question)
        return { kind: 'accept', value: 'x' }
      },
    )
    const request = {
      questions: [{
        id: 'g1',
        question: 'Confirm this spec?',
        header: 'ship · gate 1/2',
        options: [{ label: 'Confirm' }, { label: 'Edit' }, { label: 'Abort' }],
      }],
    } as AskUserQuestionRequest
    expect(await questions.ask(request)).toEqual({
      answers: [{ id: 'g1', selected: ['Confirm'] }],
    })
    expect(gates).toEqual(['ship · gate 1/2 — confirm spec'])
    expect(fronts).toEqual([])
    expect(selects).toEqual([])
  })

  it('routes ordinary questions to Selector even when a frontier fn is present', async () => {
    const selects: string[] = []
    const fronts: string[] = []
    const questions = new TerminalQuestions(
      { read: () => Promise.resolve(undefined) },
      theme,
      () => {},
      async (spec) => {
        selects.push(spec.title)
        return { kind: 'chosen', indices: [0] }
      },
      async () => 'confirm',
      async (spec) => {
        fronts.push(spec.question)
        return { kind: 'accept', value: 'x' }
      },
    )
    const request = {
      questions: [{
        id: 'q1',
        question: 'Which approach?',
        options: [{ label: 'Rewrite' }, { label: 'Patch' }],
      }],
    } as AskUserQuestionRequest
    expect(await questions.ask(request)).toEqual({
      answers: [{ id: 'q1', selected: ['Rewrite'] }],
    })
    expect(selects).toEqual(['Which approach?'])
    expect(fronts).toEqual([])
  })

  it('keeps the pipe/line-reader path when no frontier fn is provided', async () => {
    const questions = new TerminalQuestions(
      { read: () => Promise.resolve('1') },
      theme,
      () => {},
    )
    const request = {
      questions: [{
        id: 'f1',
        question: 'Which storage?',
        header: 'ship · grill',
        options: [{ label: 'SQLite' }, { label: 'Postgres' }],
      }],
    } as AskUserQuestionRequest
    expect(await questions.ask(request)).toEqual({
      answers: [{ id: 'f1', selected: ['SQLite'] }],
    })
  })

  it('NO_COLOR / plain theme still answers a ship gate through the gate fn', async () => {
    const questions = new TerminalQuestions(
      { read: () => Promise.resolve(undefined) },
      theme,
      () => {},
      undefined,
      async () => 'confirm',
    )
    const request = {
      questions: [{
        id: 'g1',
        question: 'Confirm?',
        header: 'ship · gate 1/2',
        options: [{ label: 'Confirm' }, { label: 'Edit' }, { label: 'Abort' }],
      }],
    } as AskUserQuestionRequest
    expect(await questions.ask(request)).toEqual({
      answers: [{ id: 'g1', selected: ['Confirm'] }],
    })
  })
})
