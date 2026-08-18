/**
 * The terminal question provider encodes a numbered selection as option
 * labels and anything else as the free-text answer.
 */

import type { AskUserQuestionItem, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it } from 'vitest'
import { encodeAnswer, questionLines, TerminalQuestions } from '../src/questions.ts'
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
