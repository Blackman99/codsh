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
import { gateTitle } from './gate-modal.ts'
import { renderMarkdown } from './markdown.ts'
import type { GateAction, GateKind, GateModalSpec } from './gate-modal.ts'
import type { SelectOutcome, SelectSpec } from './selector.ts'
import type { Theme } from './theme.ts'

/** Puts one selection to the keyboard; absent on a pipe, which types instead. */
export type SelectAsk = (spec: SelectSpec, signal?: AbortSignal) => Promise<SelectOutcome>

/** Puts one /ship gate on the full-screen card; absent off a TTY. */
export type GateAsk = (spec: GateModalSpec, signal?: AbortSignal) => Promise<GateAction>

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


/**
 * Detect a /ship approval gate number from an ask_user_question header.
 * Matches `ship · gate 1/2` / `ship · gate 2/2` only (middle dot optional).
 * @param header - the question header, if any.
 * @returns 1 or 2, or undefined when this is not a ship gate header.
 */
export function detectShipGate(header: string | undefined): 1 | 2 | undefined {
  if (header === undefined) return undefined
  // Require the full `gate N/2` token — not bare "gate 1" — so only the two /ship doors match.
  const match = /ship\s*[·•]?\s*gate\s*([12])\/2\b/i.exec(header)
  if (match?.[1] === '1') return 1
  if (match?.[1] === '2') return 2
  return undefined
}

/**
 * Detect a /ship approval gate from the question header only.
 *
 * Only `/ship` doors with `header` matching `ship · gate 1/2` (or 2/2) open
 * GateModal; every other ask_user_question stays on Selector / line-reader.
 * @param question - the ask_user_question item.
 * @returns which gate, or undefined when this is an ordinary question.
 */
export function shipGateKind(question: AskUserQuestionItem): GateKind | undefined {
  // Header-only: only the two /ship doors open GateModal; ordinary wording stays on Selector.
  const fromHeader = detectShipGate(question.header)
  if (fromHeader === 1) return 'spec'
  if (fromHeader === 2) return 'tickets'
  return undefined
}

/**
 * Map a gate decision onto the ask_user_question answer encoding.
 * @param question - the question being answered.
 * @param action - what the GateModal returned.
 * @returns the encoded answer item.
 */
export function encodeGateAnswer(question: AskUserQuestionItem, action: GateAction): AskUserQuestionAnswerItem {
  const options = question.options ?? []
  if (action === 'abort') return { id: question.id, selected: [] }
  if (action === 'edit') return { id: question.id, selected: [], custom: 'edit' }
  const yes = options.find(option => /^(confirm|yes)\b/i.test(option.label))
  return { id: question.id, selected: [yes?.label ?? options[0]?.label ?? 'Confirm'] }
}

/** Answers `ask_user_question` from the terminal. */
export class TerminalQuestions {
  constructor(
    private readonly reader: LineReader,
    private readonly theme: Theme,
    private readonly write: (line: string) => void,
    /** The arrow-key selection, offered only where keys can arrive. */
    private readonly select?: SelectAsk,
    /** The /ship full-screen gate, offered only on a TTY. */
    private readonly gate?: GateAsk,
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
    const gateKind = this.gate === undefined ? undefined : shipGateKind(question)
    if (gateKind !== undefined && this.gate !== undefined) {
      const bodyLines = question.detail !== undefined && question.detail.trim() !== ''
        ? question.detail.split(/\r\n|[\r\n]/u)
        : [
            question.question,
            ...options.map((option, index) => {
              const description = option.description === undefined ? '' : ` — ${option.description}`
              return `${index + 1}. ${option.label}${description}`
            }),
          ]
      const action = await this.gate({
        kind: gateKind,
        title: gateTitle(gateKind),
        bodyLines,
        recommended: 'confirm',
      }, signal)
      const answer = encodeGateAnswer(question, action)
      if (action === 'confirm') {
        this.write(this.theme.dim(`  ✓ ${answer.selected.join(', ')}`))
      } else if (action === 'edit') {
        this.write(this.theme.dim('  ✎ edit'))
      } else {
        this.write(this.theme.dim('  aborted'))
      }
      return answer
    }
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
