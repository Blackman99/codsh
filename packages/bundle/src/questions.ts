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
import { FRONTIER_CUSTOM_LABEL, type FrontierOutcome, type FrontierSpec } from './frontier-card.ts'
import { gateTitle } from './gate-modal.ts'
import { renderMarkdown } from './markdown.ts'
import type { GateAction, GateKind, GateModalSpec } from './gate-modal.ts'
import { blockRules } from './gutter.ts'
import type { SelectOutcome, SelectSpec } from './selector.ts'
import type { Theme } from './theme.ts'

/** Puts one selection to the keyboard; absent on a pipe, which types instead. */
export type SelectAsk = (spec: SelectSpec, signal?: AbortSignal) => Promise<SelectOutcome>

/** Puts one /ship gate on the full-screen card; absent off a TTY. */
export type GateAsk = (spec: GateModalSpec, signal?: AbortSignal) => Promise<GateAction>

/** Puts one /ship grill question on the compact card; absent off a TTY. */
export type FrontierAsk = (spec: FrontierSpec, signal?: AbortSignal) => Promise<FrontierOutcome>

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
 * Detect a /ship grill frontier interview from an ask_user_question header.
 * Matches `ship · grill` only (middle dot optional). Gate headers stay gates.
 * @param header - the question header, if any.
 * @returns true when this is a grill frontier question.
 */
export function detectShipGrill(header: string | undefined): true | undefined {
  if (header === undefined) return undefined
  if (/ship\s*[·•]?\s*grill\b/i.test(header)) return true
  return undefined
}

/**
 * Detect grill, wayfinder, or preflight HITL from an ask_user_question header.
 * Gates, occupancy, and delivery stay out of the auto-continue loop.
 * @param header - the question header, if any.
 * @returns true when this ask should let the same `/ship` run inject again.
 */
export function detectShipHitl(header: string | undefined): boolean {
  if (header === undefined) return false
  if (detectShipGate(header) !== undefined) return false
  return /ship\s*[·•]?\s*(grill|wayfinder|preflight)\b/i.test(header)
}

/**
 * True when a settled ask_user_question is grill/wayfinder/preflight HITL
 * the runner should continue after. Empty selected (dismiss/abort encoding)
 * and Abort/Stop labels do not continue.
 * @param questions - the request questions, in order.
 * @param answers - the encoded answers, in request order.
 */
export function shipAskSettledHitl(
  questions: readonly { header?: string | undefined }[],
  answers: readonly { selected?: readonly string[]; custom?: string }[] | undefined,
): boolean {
  if (answers === undefined) return false
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]
    if (question === undefined || !detectShipHitl(question.header)) continue
    const answer = answers[index]
    if (answer === undefined) continue
    if (answer.custom !== undefined && answer.custom.trim() !== '') return true
    const selected = answer.selected ?? []
    if (selected.length === 0) continue
    if (selected.some(label => /^(abort|stop)\b/i.test(label.trim()))) continue
    return true
  }
  return false
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
 * Auto-Confirm `ship · gate 1/2` / `2/2` without opening GateModal.
 *
 * Occupancy, preflight, grill, and any mixed request stay on the TTY path.
 * Esc / abort encodes empty selected and does not call `confirm`.
 * @param questions - the request questions, in order.
 * @param confirm - write Status + notice; false means do not Confirm.
 * @param signal - the owning tool-call abort, when present.
 */
export function autoConfirmShipGates(
  questions: readonly AskUserQuestionItem[],
  confirm: (gate: 1 | 2) => boolean,
  signal?: AbortSignal,
): AskUserQuestionAnswer | undefined {
  if (questions.length === 0) return undefined
  if (!questions.every(question => detectShipGate(question.header) !== undefined)) return undefined
  if (signal?.aborted === true) {
    return { answers: questions.map(question => ({ id: question.id, selected: [] })) }
  }
  return {
    answers: questions.map((question) => {
      const gate = detectShipGate(question.header)
      if (gate === undefined) return { id: question.id, selected: [] }
      return confirm(gate) ? encodeGateAnswer(question, 'confirm') : { id: question.id, selected: [] }
    }),
  }
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
  if (typeof action === 'object' && action.kind === 'edit') {
    const note = action.note.trim()
    return { id: question.id, selected: [], custom: note === '' ? 'edit' : note }
  }
  const yes = options.find(option => /^(confirm|yes)\b/i.test(option.label))
  return { id: question.id, selected: [yes?.label ?? options[0]?.label ?? 'Confirm'] }
}

/**
 * Map a frontier card decision onto the ask_user_question answer encoding.
 *
 * Accept writes the focused label as a selection (same as Selector choose).
 * A custom write-in is `custom: <typed text>`. Dismiss is empty selected —
 * not an abort write.
 * @param question - the question being answered.
 * @param outcome - what the FrontierCard settled as.
 */
export function encodeFrontierAnswer(question: AskUserQuestionItem, outcome: FrontierOutcome): AskUserQuestionAnswerItem {
  if (outcome.kind === 'chosen') return { id: question.id, selected: outcome.values }
  if (outcome.kind === 'accept') {
    return outcome.custom === true
      ? { id: question.id, selected: [], custom: outcome.value }
      : { id: question.id, selected: [outcome.value] }
  }
  return { id: question.id, selected: [] }
}

/**
 * Detect a write-in option: the person types their own answer on this row.
 * Recognize explicit write-in labels. Descriptions can mention "other" or
 * "custom" while still explaining a concrete, selectable choice.
 */
function isWriteInOption(option: { label: string; description?: string }): boolean {
  const label = option.label.trim().replace(/^✎\s*/u, '')
  return /^(type (a|your|one)|write[- ]?in|specify|your own)\b/i.test(label)
    || /^(other|custom)(\s+(answer|response))?(\s*[(（:：—-]|$)/iu.test(label)
    || /^(其他|其它|自定义)([（(:：、，]|$)|^(自行|手动)输入/u.test(label)
}

/** A stored answer worth restoring when the person revisits this question. */
function priorAnswer(answer: AskUserQuestionAnswerItem | undefined): SelectSpec['prior'] {
  if (answer === undefined) return undefined
  if (answer.custom !== undefined) {
    return { custom: answer.custom }
  }
  return { selected: answer.selected }
}

/** Navigation is control flow, never a magic free-text answer. */
type QuestionStep =
  | { kind: 'answer'; answer: AskUserQuestionAnswerItem; summary?: string }
  | { kind: 'back' }
  | { kind: 'next' }
  | { kind: 'cancelled' }

/**
 * Honor explicit labels/descriptions; default to the first eligible choice.
 * @param options - the question's options.
 */
function recommendedFlags(options: readonly { label: string; description?: string }[]): boolean[] {
  const texts = options.map(option => `${option.label} ${option.description ?? ''}`)
  const eligible = texts.map(text => !/\bnot\s+recommended\b|不推荐/iu.test(text))
  const marked = texts.map((text, index) => eligible[index] === true && /\brecommend(?:ed)?\b|推荐/iu.test(text))
  if (marked.some(flag => flag)) return marked
  const first = eligible.findIndex(flag => flag)
  return options.map((_, index) => index === first)
}

/** Answers `ask_user_question` from the terminal. */
export class TerminalQuestions {
  constructor(
    private readonly reader: LineReader,
    private readonly theme: Theme,
    private readonly write: (line: string, rule?: string) => void,
    /** The arrow-key selection, offered only where keys can arrive. */
    private readonly select?: SelectAsk,
    /** The /ship full-screen gate, offered only on a TTY. */
    private readonly gate?: GateAsk,
    /** The /ship grill compact card, offered only on a TTY. */
    private readonly frontier?: FrontierAsk,
  ) {}

  /**
   * Put every question in one request to the person, in order.
   * Left on a later consecutive question revisits the previous one; right
   * returns to an already-visited later one.
   * @param request - the questions, owner agent, and abort signal.
   * @returns one answer per question, in request order.
   */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const answers: AskUserQuestionAnswerItem[] = []
    const summaries: Array<string | undefined> = []
    let index = 0
    let reached = 0
    while (index < request.questions.length) {
      if (request.signal?.aborted) break
      const question = request.questions[index]
      if (question === undefined) break
      reached = Math.max(reached, index)
      const prior = priorAnswer(answers[index])
      const step = await this.one(question, request.signal, {
        canBack: index > 0,
        canForward: index < reached,
        ...prior === undefined ? {} : { prior },
      })
      if (request.signal?.aborted || step.kind === 'cancelled') break
      if (step.kind === 'back') {
        if (index > 0) index -= 1
        continue
      }
      if (step.kind === 'next') {
        if (index < reached) index += 1
        continue
      }
      answers[index] = step.answer
      summaries[index] = step.summary
      index += 1
    }
    // A question stays editable until the batch settles. The transcript is
    // append-only, so publish only its final value, in request order.
    const rule = blockRules(this.theme).tool
    for (const summary of summaries) {
      if (summary !== undefined) this.write(this.theme.dim(summary), rule)
    }
    return { answers: request.questions.map((question, at) => answers[at] ?? { id: question.id, selected: [] }) }
  }

  /**
   * Put one question to the person.
   * @param question - the question.
   * @param signal - aborts with the owning tool call.
   * @returns the encoded answer.
   */
  private async one(
    question: AskUserQuestionItem,
    signal: AbortSignal | undefined,
    nav: { canBack: boolean; canForward: boolean; prior?: SelectSpec['prior'] } = { canBack: false, canForward: false },
  ): Promise<QuestionStep> {
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
        return { kind: 'answer', answer, summary: `  ✓ ${answer.selected.join(', ')}` }
      } else if (typeof action === 'object' && action.kind === 'edit') {
        const shown = action.note.trim() === '' ? 'edit' : action.note.trim()
        return { kind: 'answer', answer, summary: `  ✎ ${shown}` }
      } else {
        if (!signal?.aborted) this.write(this.theme.dim('  aborted'), blockRules(this.theme).tool)
        return { kind: 'cancelled' }
      }
    }
    if (this.frontier !== undefined && detectShipGrill(question.header) === true && options.length > 0) {
      const recommended = recommendedFlags(options)
      const outcome = await this.frontier({
        question: question.question,
        ...question.detail === undefined ? {} : { detail: question.detail },
        ...question.multiSelect === true ? { multi: true } : {},
        options: [
          ...options.map((option, index) => ({
            label: option.label,
            ...option.description === undefined ? {} : { detail: option.description },
            ...recommended[index] === true ? { recommended: true } : {},
            ...isWriteInOption(option) ? { writeIn: true as const } : {},
          })),
          ...options.some(isWriteInOption) ? [] : [{ label: FRONTIER_CUSTOM_LABEL, writeIn: true as const }],
        ],
        ...nav.canBack ? { canBack: true } : {},
        ...nav.canForward ? { canForward: true } : {},
        ...nav.prior === undefined ? {} : { prior: nav.prior },
      }, signal)
      if (outcome.kind === 'back' || outcome.kind === 'next') return outcome
      if (outcome.kind === 'dismiss') return { kind: 'cancelled' }
      const answer = encodeFrontierAnswer(question, outcome)
      const shown = answer.custom ?? answer.selected.join(', ')
      return { kind: 'answer', answer, summary: `  ✓ ${shown}` }
    }
    if (this.select === undefined || options.length === 0) {
      for (const line of questionLines(question, this.theme)) this.write(line)
      const line = await this.reader.read(signal)
      // Input that ended mid-request answers empty rather than hanging the tool
      // call: the model receives an unanswered question and can proceed.
      return line === undefined ? { kind: 'cancelled' } : { kind: 'answer', answer: encodeAnswer(line, question) }
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
      ...nav.canBack ? { back: true } : {},
      ...nav.canForward ? { forward: true } : {},
      ...nav.prior === undefined ? {} : { prior: nav.prior },
    }, signal)
    if (outcome.kind === 'chosen') {
      const selected = outcome.indices
        .map(index => options[index]?.label)
        .filter((label): label is string => label !== undefined)
      return { kind: 'answer', answer: { id: question.id, selected }, summary: `  ✓ ${selected.join(', ')}` }
    }
    if (outcome.kind === 'custom') {
      if (outcome.value !== undefined && outcome.value.trim() !== '') {
        const custom = outcome.value.trim()
        return { kind: 'answer', answer: { id: question.id, selected: [], custom }, summary: `  ✓ ${custom}` }
      }
      const line = await this.reader.read(signal)
      if (line === undefined) return { kind: 'cancelled' }
      const custom = (line ?? '').trim()
      return { kind: 'answer', answer: custom === '' ? { id: question.id, selected: [] } : { id: question.id, selected: [], custom } }
    }
    if (outcome.kind === 'back' || outcome.kind === 'next') return outcome
    // Cancelled answers empty rather than hanging the tool call.
    return { kind: 'cancelled' }
  }
}
