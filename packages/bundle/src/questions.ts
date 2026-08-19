/**
 * The terminal's user-questions provider: it renders each question as a
 * numbered menu, reads one line per question, and encodes the answer.
 *
 * A question may offer options, free text, or both. Selecting by number
 * answers with that option's label; typing anything else answers as `custom`,
 * which is the encoding `ask_user_question` documents for an "Other" reply.
 * @module codsh-bundle/src/questions
 */

import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import { renderMarkdown } from './markdown.ts'
import type { SelectOutcome, SelectSpec } from './selector.ts'
import type { Theme } from './theme.ts'

/** Puts one selection to the keyboard; absent on a pipe, which types instead. */
export type SelectAsk = (spec: SelectSpec, signal?: AbortSignal) => Promise<SelectOutcome>

/** Reads one answer from the person. */
export interface LineReader {
  /**
   * Read one submission.
   * @param signal - aborts the read when the owning tool call is cancelled.
   * @returns the answer, or undefined when input ended or the read aborted.
   */
  read(signal?: AbortSignal): Promise<string | undefined>
}

/**
 * Parse a selection line against one question's options.
 *
 * A comma-separated list of numbers selects those options; a multi-select
 * question accepts several, a single-select takes the first. Anything that is
 * not a valid index becomes the free-text answer.
 * @param line - the line the person typed.
 * @param question - the question being answered.
 * @returns the encoded answer for this question.
 */
export function encodeAnswer(line: string, question: AskUserQuestionItem): AskUserQuestionAnswerItem {
  const options = question.options ?? []
  const trimmed = line.trim()
  if (trimmed === '') return { id: question.id, selected: [] }
  const indices = trimmed.split(',').map(part => Number(part.trim()))
  const valid = indices.every(index => Number.isInteger(index) && index >= 1 && index <= options.length)
  if (!valid || options.length === 0) return { id: question.id, selected: [], custom: trimmed }
  const chosen = question.multiSelect === true ? indices : indices.slice(0, 1)
  return { id: question.id, selected: chosen.map(index => options[index - 1]?.label ?? '') }
}

/**
 * Render one question as the lines shown above its prompt.
 * @param question - the question to render.
 * @param theme - styling for the heading and option list.
 * @returns the lines to print.
 */
export function questionLines(question: AskUserQuestionItem, theme: Theme): string[] {
  const lines: string[] = ['']
  const plan = question.intent?.kind === 'plan-review' ? question.intent : undefined
  if (plan !== undefined) {
    // The plan IS the thing being decided, so it is rendered as content rather
    // than as a question's aside: `detail` carries the markdown `ask()`
    // requires, and a person cannot approve what was folded into a hint.
    lines.push(theme.pending('▲ plan for review'), '')
    if (question.detail !== undefined) lines.push(...question.detail.split('\n'))
    lines.push('', theme.bold(question.question))
    const options = question.options ?? []
    options.forEach((option, index) => {
      const approves = option.label === plan.approve
      const mark = approves ? theme.success(String(index + 1)) : theme.error(String(index + 1))
      const description = option.description === undefined ? '' : theme.dim(` — ${option.description}`)
      lines.push(`  ${mark}. ${option.label}${description}`)
    })
    lines.push(theme.dim('  (a number, or type your own answer)'))
    return lines
  }
  if (question.header !== undefined) lines.push(theme.dim(`[${question.header}]`))
  lines.push(theme.bold(question.question))
  if (question.detail !== undefined) lines.push(...question.detail.split('\n').map(line => theme.dim(line)))
  const options = question.options ?? []
  options.forEach((option, index) => {
    const description = option.description === undefined ? '' : theme.dim(` — ${option.description}`)
    lines.push(`  ${theme.pending(String(index + 1))}. ${option.label}${description}`)
  })
  if (options.length > 0) {
    const how = question.multiSelect === true
      ? 'numbers separated by commas, or type your own answer'
      : 'a number, or type your own answer'
    lines.push(theme.dim(`  (${how})`))
  }
  return lines
}

/** Answers `ask_user_question` from the terminal. */
export class TerminalQuestions {
  constructor(
    private readonly reader: LineReader,
    private readonly theme: Theme,
    private readonly write: (line: string) => void,
    /** The arrow-key selection, offered only where keys can arrive. */
    private readonly select?: SelectAsk,
  ) {}

  /**
   * Put every question in one request to the person, in order.
   * @param request - the questions, owner agent, and abort signal.
   * @returns one answer per question, in request order.
   */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const answers: AskUserQuestionAnswerItem[] = []
    for (const question of request.questions) {
      answers.push(await this.one(question, request.signal))
    }
    return { answers }
  }

  /**
   * Put one question to the person.
   * @param question - the question.
   * @param signal - aborts with the owning tool call.
   * @returns the encoded answer.
   */
  private async one(question: AskUserQuestionItem, signal: AbortSignal | undefined): Promise<AskUserQuestionAnswerItem> {
    const options = question.options ?? []
    if (this.select === undefined || options.length === 0) {
      for (const line of questionLines(question, this.theme)) this.write(line)
      const line = await this.reader.read(signal)
      // Input that ended mid-request answers empty rather than hanging the tool
      // call: the model receives an unanswered question and can proceed.
      return encodeAnswer(line ?? '', question)
    }
    this.write('')
    if (question.header !== undefined) this.write(this.theme.dim(`[${question.header}]`))
    if (question.intent?.kind === 'plan-review') {
      // The plan IS the thing being decided: rendered as content, because a
      // person cannot approve what was folded into a dim aside.
      this.write(this.theme.pending('▲ plan for review'))
      this.write('')
      if (question.detail !== undefined) {
        for (const line of renderMarkdown(question.detail, this.theme)) this.write(line)
      }
      this.write('')
    } else if (question.detail !== undefined) {
      for (const line of question.detail.split('\n')) this.write(this.theme.dim(line))
    }
    const outcome = await this.select({
      title: question.question,
      options: options.map(option => ({ label: option.label, ...option.description === undefined ? {} : { detail: option.description } })),
      ...question.multiSelect === true ? { multi: true } : {},
      custom: '✎ Type your own answer',
    }, signal)
    if (outcome.kind === 'chosen') {
      const selected = outcome.indices
        .map(index => options[index]?.label)
        .filter((label): label is string => label !== undefined)
      this.write(this.theme.dim(`  ✓ ${selected.join(', ')}`))
      return { id: question.id, selected }
    }
    if (outcome.kind === 'custom') {
      const line = await this.reader.read(signal)
      const custom = (line ?? '').trim()
      return custom === '' ? { id: question.id, selected: [] } : { id: question.id, selected: [], custom }
    }
    // Cancelled answers empty rather than hanging the tool call.
    return { id: question.id, selected: [] }
  }
}
