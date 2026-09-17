/**
 * Runner-owned `/ship` answer record: human ask_user_question replies and
 * local decision Question / User answer sections. Adjacent
 * `<spec>.ship.answers.json` is canonical; the graph cache is not the store.
 * @module codsh-bundle/src/ship-answers
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { parseLegacyRequirement, parseMainTrack, parseOriginalRequirement } from './plan.ts'
import { detectShipGate } from './questions.ts'
import type { DecisionChild, ShipUserAnswer, ShipUserAnswerPhase } from './ship-graph.ts'

/** Versioned answer-record schema; unknown versions are errors, never migrated. */
export const SHIP_ANSWERS_VERSION = 1

/** Canonical runner-owned answers written beside a spec. */
export interface ShipAnswersRecord {
  version: typeof SHIP_ANSWERS_VERSION
  /** Filename of the adjacent spec, stable across checkout locations. */
  specPath: string
  answers: ShipUserAnswer[]
}

/** Why an answers sidecar refused to parse or overwrite. */
export interface ShipAnswersError {
  error: string
}

const VERSION = SHIP_ANSWERS_VERSION
const PHASES: ReadonlySet<string> = new Set(['wayfinder', 'grill', 'spec', 'tickets', 'landing', 'done'])
const SECTION_HEADING = /^(#{1,6})\s+(.*?)\s*$/u
const IDEA_LINE = /^[ \t]*(?:\*\*)?Idea(?:\*\*)?[ \t]*[:.][ \t]*(?:\*\*)?[ \t]*(.*)$/iu
const DESTINATION_LINE = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?Destination(?:\*\*)?[ \t]*[:.][ \t]*(?:\*\*)?([^\r\n]*)$/imu
const QUESTION_HEADING = /^question$/iu
const USER_ANSWER_HEADING = /^user\s+answers?$/iu
const QUESTION_FIELD = fieldPattern('Question')
const USER_ANSWER_FIELD = fieldPattern('User answer|User Answer')

/** Adjacent sidecar for a spec: `widget.md` → `widget.ship.answers.json`. */
export function answersPathFor(specPath: string): string {
  const absolute = resolve(specPath)
  const base = absolute.split(sep).pop() ?? absolute
  const stem = base.replace(/\.md$/iu, '')
  return join(dirname(absolute), `${stem}.ship.answers.json`)
}

/** True when a read or parse refused the answers sidecar. */
export function isShipAnswersError(value: unknown): value is ShipAnswersError {
  return value !== undefined && value !== null && typeof value === 'object' && 'error' in value
}

/**
 * Parse the canonical answers sidecar. Corrupt or unknown-version payloads
 * are errors, never an empty successful store.
 */
export function parseShipAnswers(raw: string): ShipAnswersRecord | ShipAnswersError {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return { error: 'Ship answers record is not valid JSON. Refusing to overwrite it; restore the sidecar.' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Ship answers record is corrupt. Refusing to overwrite it; restore the sidecar.' }
  }
  const record = value as Record<string, unknown>
  if (record.version !== VERSION) {
    return { error: `Ship answers record version ${String(record.version)} is unsupported. Refusing to overwrite it.` }
  }
  if (typeof record.specPath !== 'string' || record.specPath.trim() === '') {
    return { error: 'Ship answers record is missing specPath. Refusing to overwrite it; restore the sidecar.' }
  }
  if (record.answers === undefined) return { version: VERSION, specPath: record.specPath, answers: [] }
  if (!Array.isArray(record.answers)) {
    return { error: 'Ship answers record answers are corrupt. Refusing to overwrite it; restore the sidecar.' }
  }
  const answers: ShipUserAnswer[] = []
  for (const item of record.answers) {
    const parsed = parseAnswerItem(item)
    if (parsed === undefined) {
      return { error: 'Ship answers record answers are corrupt. Refusing to overwrite it; restore the sidecar.' }
    }
    answers.push(parsed)
  }
  return { version: VERSION, specPath: record.specPath, answers }
}

/**
 * Read the answers sidecar beside a spec. Absent is undefined; unreadable or
 * corrupt is an error that must not be treated as an empty success.
 */
export function readShipAnswers(specPath: string): ShipAnswersRecord | undefined | ShipAnswersError {
  const path = answersPathFor(specPath)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    return { error: `Ship answers record is unreadable at ${path}. Refusing to overwrite it; restore the sidecar.` }
  }
  const record = parseShipAnswers(raw)
  if (!isShipAnswersError(record) && record.specPath !== basename(specPath)) {
    return { error: 'Ship answers record belongs to another specification. Refusing to overwrite it; restore the matching sidecar.' }
  }
  return record
}

/**
 * Atomically write the answers sidecar beside the spec. The path is always
 * derived from the spec, never from markdown contents.
 */
export function writeShipAnswers(record: ShipAnswersRecord, specPath: string): void {
  const path = answersPathFor(specPath)
  const body = `${JSON.stringify(record, null, 2)}\n`
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, body, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* leftover tmp is not the sidecar */ }
    throw error
  }
}

/** Dedicated original wording, or a legacy explicit Requirement — never Main Track. */
export function parseGraphOriginalRequirement(markdown: string): string | undefined {
  return presentText(parseOriginalRequirement(markdown) ?? parseLegacyRequirement(markdown))
}

/**
 * Main Track Idea, else an explicit Wayfinder Destination, else the original
 * requirement when the goal is not yet refined. Never a plan-ticket guess.
 */
export function parseGraphObjective(markdown: string, extraTexts: readonly string[] = []): string | undefined {
  return presentText(parseMainTrackIdea(markdown) ?? firstDestination([markdown, ...extraTexts]) ?? parseGraphOriginalRequirement(markdown))
}

/** Idea line inside Main Track — existing mission parsing semantics. */
export function parseMainTrackIdea(markdown: string): string | undefined {
  const track = parseMainTrack(markdown)
  if (track === undefined) return undefined
  const section = parseNamedSection(track, /^idea$/iu)
  if (section !== undefined) return section
  const lines = outsideFences(track).split('\n')
  const start = lines.findIndex(line => IDEA_LINE.test(line))
  if (start < 0) return undefined
  const body = [IDEA_LINE.exec(lines[start]!)?.[1] ?? '']
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#{1,6}\s|(?:\*\*)?(?:Track-\d+|Out of Scope)\b)/iu.test(line)) break
    body.push(line)
  }
  return presentText(body.join('\n'))
}

/** Explicit Destination heading or metadata; multiline heading bodies kept. */
export function parseWayfinderDestination(text: string): string | undefined {
  const section = parseNamedSection(text, /^destination$/iu)
  if (section !== undefined) return section
  const line = DESTINATION_LINE.exec(text)?.[1]?.trim()
  return line === undefined || line === '' ? undefined : line
}

export function shipGraphEnrichment(input: {
  markdown: string
  mapTexts?: readonly string[]
  mapChildren?: readonly DecisionChild[]
  answers?: readonly ShipUserAnswer[]
  originalRequirement?: string
  objective?: string
}): { originalRequirement?: string; objective?: string; answers?: ShipUserAnswer[] } {
  const original = presentText(input.originalRequirement) ?? parseGraphOriginalRequirement(input.markdown)
  const objective = presentText(input.objective)
    ?? parseMainTrackIdea(input.markdown)
    ?? firstDestination([input.markdown, ...input.mapTexts ?? []])
    ?? original
  const answers = mergeShipAnswers(answersFromDecisions(input.mapChildren), input.answers)
  return {
    ...(original === undefined ? {} : { originalRequirement: original }),
    ...(objective === undefined ? {} : { objective }),
    ...(answers.length === 0 ? {} : { answers }),
  }
}

/** Append incoming answers; repeated question ids keep history, identical rows do not duplicate. */
export function mergeShipAnswers(...groups: readonly (readonly ShipUserAnswer[] | undefined)[]): ShipUserAnswer[] {
  const out: ShipUserAnswer[] = []
  for (const group of groups) {
    if (group === undefined) continue
    for (const item of group) {
      if (out.some(existing => shipAnswersEqual(existing, item))) continue
      out.push(item)
    }
  }
  return out
}

/** True when two answer lists are the same records in the same order. */
export function shipAnswerListsEqual(
  left: readonly ShipUserAnswer[] | undefined,
  right: readonly ShipUserAnswer[] | undefined,
): boolean {
  const a = left ?? []
  const b = right ?? []
  if (a.length !== b.length) return false
  return a.every((item, index) => {
    const other = b[index]
    return other !== undefined && shipAnswersEqual(item, other)
  })
}

export function answersFromDecisions(children: readonly DecisionChild[] | undefined): ShipUserAnswer[] {
  if (children === undefined) return []
  const answers: ShipUserAnswer[] = []
  for (const child of children) {
    if (child.question === undefined && child.userAnswer === undefined && child.questionSource === undefined) continue
    answers.push({
      id: child.id,
      phase: 'wayfinder',
      question: child.question ?? child.title,
      answer: child.userAnswer ?? '',
      ...(child.questionSource === undefined || child.questionSource === '' ? {} : { source: child.questionSource }),
      ticketId: child.id,
    })
  }
  return answers
}

/**
 * Encode one human ask_user_question batch. Association is the actual question
 * id; skipped questions stay as empty unanswered records.
 */
export function encodeAskUserAnswers(
  questions: readonly ShipAskQuestion[],
  answers: readonly ShipAskAnswer[] | undefined,
  fallbackPhase: ShipUserAnswerPhase,
): ShipUserAnswer[] {
  const items = answers ?? []
  const used = new Set<number>()
  const records: ShipUserAnswer[] = []
  for (const question of questions) {
    if (isOccupancyHeader(question.header)) continue
    let found = -1
    for (let at = 0; at < items.length; at += 1) {
      if (used.has(at) || items[at]?.id !== question.id) continue
      found = at
      break
    }
    if (found >= 0) used.add(found)
    const item = found >= 0 ? items[found] : undefined
    const record: ShipUserAnswer = {
      id: question.id,
      phase: phaseFromQuestionHeader(question.header, fallbackPhase),
      question: question.question,
      answer: encodeAnswerText(item),
    }
    if (question.detail !== undefined && question.detail !== '') record.detail = question.detail
    if (question.question !== '') record.source = question.question
    records.push(record)
  }
  return records
}

/** Map an ask_user_question header onto a graph answer phase. */
export function phaseFromQuestionHeader(header: string | undefined, fallback: ShipUserAnswerPhase): ShipUserAnswerPhase {
  const gate = detectShipGate(header)
  if (gate === 1) return 'spec'
  if (gate === 2) return 'tickets'
  if (header === undefined || header.trim() === '') return fallback
  if (/ship\s*[·•]?\s*grill\b/iu.test(header)) return 'grill'
  if (/ship\s*[·•]?\s*(wayfinder|preflight)\b/iu.test(header)) return 'wayfinder'
  if (/ship\s*[·•]?\s*(land|deliver)\b/iu.test(header)) return 'landing'
  return fallback
}

export function phaseFromShipStatus(status: string | undefined): ShipUserAnswerPhase {
  switch (status) {
    case 'grilling':
      return 'grill'
    case 'interviewing':
      return 'spec'
    case 'confirmed':
      return 'tickets'
    case 'planned':
    case 'landing':
      return 'landing'
    case 'shipped':
      return 'done'
    default:
      return 'wayfinder'
  }
}

/** Question / User answer from a local decision ticket; research Resolution is never the answer. */
export function extractLocalDecisionAnswer(text: string): {
  question?: string
  userAnswer?: string
  source?: string
} {
  const questionSection = parseNamedSection(text, QUESTION_HEADING)
  const answerSection = parseNamedSection(text, USER_ANSWER_HEADING)
  const fields = outsideFences(text)
  const questionField = QUESTION_FIELD.exec(fields)?.[1]
  const answerField = USER_ANSWER_FIELD.exec(fields)?.[1]
  const question = questionSection ?? presentText(questionField)
  const userAnswer = answerSection ?? (answerField === undefined ? undefined : answerField.trim())
  if (question === undefined && userAnswer === undefined) return {}
  const source = questionSection ?? presentText(questionField)
  return {
    ...(question === undefined ? {} : { question }),
    ...(userAnswer === undefined ? {} : { userAnswer }),
    ...(source === undefined ? {} : { source }),
  }
}

export function parseAnswerItems(value: unknown): ShipUserAnswer[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const answers: ShipUserAnswer[] = []
  for (const item of value) {
    const parsed = parseAnswerItem(item)
    if (parsed === undefined) continue
    answers.push(parsed)
  }
  return answers
}

export interface ShipAskQuestion {
  id: string
  question: string
  header?: string
  detail?: string
}

export interface ShipAskAnswer {
  id: string
  selected?: readonly string[]
  custom?: string
}

function parseAnswerItem(value: unknown): ShipUserAnswer | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.trim() === '') return undefined
  if (typeof record.question !== 'string') return undefined
  if (typeof record.phase !== 'string' || !PHASES.has(record.phase)) return undefined
  const answer: ShipUserAnswer = {
    id: record.id,
    phase: record.phase as ShipUserAnswerPhase,
    question: record.question,
  }
  if (typeof record.answer === 'string') answer.answer = record.answer
  if (typeof record.detail === 'string') answer.detail = record.detail
  if (typeof record.source === 'string') answer.source = record.source
  if (typeof record.ticketId === 'string') answer.ticketId = record.ticketId
  return answer
}

function encodeAnswerText(item: ShipAskAnswer | undefined): string {
  if (item === undefined) return ''
  const selected = item.selected ?? []
  const parts = selected.filter(label => label !== '')
  if (item.custom !== undefined && item.custom !== '') parts.push(item.custom)
  return parts.join(', ')
}

function shipAnswersEqual(a: ShipUserAnswer, b: ShipUserAnswer): boolean {
  return a.id === b.id
    && a.phase === b.phase
    && a.question === b.question
    && (a.answer ?? '') === (b.answer ?? '')
    && (a.detail ?? '') === (b.detail ?? '')
    && (a.source ?? '') === (b.source ?? '')
    && (a.ticketId ?? '') === (b.ticketId ?? '')
}

function firstDestination(texts: readonly string[]): string | undefined {
  for (const text of texts) {
    const destination = parseWayfinderDestination(text)
    if (destination !== undefined) return destination
  }
  return undefined
}

function presentText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').trim()
  return text === '' ? undefined : text
}

function outsideFences(markdown: string): string {
  let fence: string | undefined
  return markdown.split(/\r\n|[\r\n]/u).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fence !== undefined) {
      if (marker?.[1] !== undefined && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2]?.trim() === '') fence = undefined
      return ''
    }
    if (marker?.[1] !== undefined) {
      fence = marker[1]
      return ''
    }
    return line
  }).join('\n')
}

function fieldPattern(field: string): RegExp {
  return new RegExp(
    `^[ \\t]*(?:[-*][ \\t]+)?(?:\\*\\*)?(?:${field})(?:\\*\\*)?[ \\t]*:[ \\t]*(?:\\*\\*)?([^\\r\\n]*)$`,
    'imu',
  )
}

function isOccupancyHeader(header: string | undefined): boolean {
  return header !== undefined && /ship\s*[·•]?\s*occupancy\b/iu.test(header)
}

function parseNamedSection(markdown: string, title: RegExp): string | undefined {
  const body: string[] = []
  let rank: number | undefined
  let fence: string | undefined
  for (const line of markdown.split(/\r\n|[\r\n]/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fence !== undefined) {
      if (rank !== undefined) body.push(line)
      if (marker?.[1] !== undefined && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2]?.trim() === '') {
        fence = undefined
      }
      continue
    }
    if (marker?.[1] !== undefined) {
      fence = marker[1]
      if (rank !== undefined) body.push(line)
      continue
    }
    const heading = SECTION_HEADING.exec(line)
    if (heading !== null) {
      const depth = heading[1]?.length ?? 0
      const name = heading[2] ?? ''
      if (rank === undefined) {
        if (title.test(name)) {
          rank = depth
          continue
        }
      } else if (depth <= rank) {
        break
      }
    }
    if (rank !== undefined) body.push(line)
  }
  if (rank === undefined) return undefined
  const text = body.join('\n').trim()
  return text === '' ? undefined : text
}
