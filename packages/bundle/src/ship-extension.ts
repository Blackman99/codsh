/**
 * The optional Ship extension for `codsh --rust` (ticket 195): the first
 * `/ship` phase (pre-flight + wayfinder) run through dsh, reusing this
 * package's contract, answer record, and snapshot code.
 *
 * The extension is an ordinary plugin (`packages/cli/extensions/ship`) that
 * the user installs and enables explicitly. It contributes the `/ship`
 * command, whose body is {@link shipExtensionCommand} (the legacy first-turn
 * contract from `shipPromptFor`), and command hooks that call
 * {@link handleShipHook}:
 *
 * - `UserPromptSubmit`: a `/ship` prompt starts a run for this workspace and
 *   session. It binds the one unfinished spec, if any, with the legacy
 *   checks (several unfinished specs, a typed idea that conflicts with the
 *   saved original, a corrupt snapshot or answer record) and blocks a spec
 *   whose Status is past wayfinding: later phases are not migrated to the
 *   Rust client yet, and legacy `codsh` still runs them from the same files.
 *   Any other prompt ends the run, as the legacy runner stops recording
 *   when `/ship` is not in flight.
 * - `PostToolUse`: while a run is active, a human `ask_user_question` answer
 *   is written to `<spec>.ship.answers.json` (held in the plugin data
 *   directory until the ledger exists); after a write, the first unfinished
 *   spec is bound and `<spec>.ship.json` is sealed, and a bound spec is
 *   checked against its snapshot. Child sessions and plan mode are ignored.
 *
 * Nothing here touches a goal, Rhai, the graph cache, or the browser view.
 * @module codsh-bundle/src/ship-extension
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { expandTemplate } from './custom-commands.ts'
import { parseShipStatus, type ShipStatus } from './plan.ts'
import {
  encodeAskUserAnswers,
  isShipAnswersError,
  mergeShipAnswers,
  phaseFromShipStatus,
  readShipAnswers,
  writeShipAnswers,
  type ShipAskAnswer,
  type ShipAskQuestion,
} from './ship-answers.ts'
import type { ShipUserAnswer } from './ship-graph.ts'
import {
  freezeEqual,
  freezeText,
  initialShipSnapshot,
  isShipSnapshotError,
  readShipSnapshot,
  sealOriginalIfNeeded,
  sealTrackIfNeeded,
  validateSnapshotAgainstSpec,
  writeShipSnapshot,
  type ShipSnapshot,
} from './ship-snapshot.ts'
import { shipPromptFor } from './ship.ts'

/**
 * The host appends `Arguments: <typed text>` to the first line of a custom
 * command instead of substituting `$ARGUMENTS`, so the idea slot points there.
 */
export const SHIP_EXTENSION_IDEA = '(the Arguments on the first line of this message, verbatim; empty when nothing follows "Arguments:")'

/** First words of the contract; identifies an expanded `/ship` prompt. */
export const SHIP_CONTRACT_OPENING = 'Throughout /ship, preserve the original requirement'

/** Status values this extension may run: none yet, or wayfinding. */
const MIGRATED: ReadonlySet<ShipStatus | undefined> = new Set([undefined, 'wayfinding'])

/** Legacy runner messages, kept verbatim where they apply. */
export const SHIP_AMBIGUOUS_SPECS = 'Multiple unfinished specs found. Choose one on a TTY; a pipe cannot pick arbitrarily. Stopped.'
export const SHIP_NO_OBJECTIVE = 'No original requirement could be recovered. Stopped; type the one-sentence requirement or restore the spec.'
export const SHIP_IDEA_CONFLICT = 'Typed idea conflicts with the saved original requirement. Stopped; resume with an empty /ship or start a separately approved spec.'

/** The markdown for the extension's `commands/ship.md`. */
export function shipExtensionCommand(): string {
  const contract = expandTemplate(shipPromptFor(undefined), SHIP_EXTENSION_IDEA)
  return [
    '---',
    'description: Run the /ship workflow (optional Ship extension; pre-flight and wayfinder)',
    'argument-hint: <one-sentence requirement>',
    '---',
    contract,
    '',
  ].join('\n')
}

/** Why a later phase is refused, naming where it still runs. */
export function laterPhaseMessage(specPath: string, status: ShipStatus): string {
  return `Ship in codsh --rust runs pre-flight and wayfinder only; ${specPath} is at Status: ${status}. Continue it with legacy codsh (/ship): the spec, ${basename(specPath).replace(/\.md$/iu, '')}.ship.json and .ship.answers.json are the same files. Stopped.`
}

/** One `/ship` run for a workspace, kept in the plugin data directory. */
export interface ShipRunState {
  version: 1
  cwd: string
  sessionId: string
  /** The typed idea of the `/ship` that started the run (frozen text). */
  idea: string
  /** False once another prompt ran; hooks then record nothing. */
  active: boolean
  /** Bound spec, absolute. */
  specPath?: string
  /** Answers given before the ledger existed. */
  pending: ShipUserAnswer[]
  startedAt: string
}

/** What a hook invocation receives. */
export interface ShipHookInput {
  event: string
  payload: Record<string, unknown>
  /** `GROK_PLUGIN_DATA`; runs live under `<data>/runs/`. */
  dataDir: string
  cwd: string
  now?: () => Date
}

/** What the hook process prints and exits with. */
export interface ShipHookOutput {
  stdout: string
  exitCode: number
}

const OK: ShipHookOutput = { stdout: '', exitCode: 0 }

function block(reason: string): ShipHookOutput {
  return { stdout: `${JSON.stringify({ decision: 'block', reason: `Ship: ${reason}` })}\n`, exitCode: 0 }
}

/** `/ship` typed text, or undefined when the prompt is not the extension's command. */
export function parseShipInvocation(prompt: string): { idea: string } | undefined {
  const at = prompt.indexOf(SHIP_CONTRACT_OPENING)
  if (at < 0 || !prompt.startsWith('Run the custom command `')) return undefined
  const head = prompt.slice(0, at)
  const marker = head.indexOf('Arguments:')
  if (marker < 0) return undefined
  return { idea: freezeText(head.slice(marker + 'Arguments:'.length)) }
}

/** Where a workspace's run state lives. */
export function runStatePath(dataDir: string, cwd: string): string {
  const key = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16)
  return join(dataDir, 'runs', `${key}.json`)
}

/** The run for a workspace; a corrupt file is treated as no run. */
export function readRunState(dataDir: string, cwd: string): ShipRunState | undefined {
  try {
    const value = JSON.parse(readFileSync(runStatePath(dataDir, cwd), 'utf8')) as ShipRunState
    if (value?.version !== 1 || resolve(value.cwd) !== resolve(cwd) || !Array.isArray(value.pending)) return undefined
    return value
  } catch {
    return undefined
  }
}

function writeRunState(dataDir: string, state: ShipRunState): void {
  const path = runStatePath(dataDir, state.cwd)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/**
 * Unfinished specs, as the legacy runner finds them: `docs/specs/*.md` with
 * a Status line other than shipped.
 */
export function unfinishedSpecs(cwd: string): string[] {
  const dir = resolve(cwd, 'docs', 'specs')
  let names: string[] = []
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.md')).sort()
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      const status = parseShipStatus(readFileSync(path, 'utf8'))
      if (status !== undefined && status !== 'shipped') out.push(path)
    } catch {
      // Unreadable files are not candidates.
    }
  }
  return out
}

function display(cwd: string, path: string): string {
  const root = resolve(cwd)
  return path.startsWith(`${root}${sep}`) ? path.slice(root.length + 1).split(sep).join('/') : path
}

/**
 * Bind a spec with the legacy adoption checks and write its snapshot.
 * @returns an error message, or undefined when the spec is bound.
 */
function adopt(cwd: string, path: string, idea: string, state: ShipRunState): string | undefined {
  let markdown: string
  try {
    markdown = readFileSync(path, 'utf8')
  } catch {
    return `Bound spec is unreadable at ${display(cwd, path)}. Stopped; restore the spec.`
  }
  const loaded = readShipSnapshot(path)
  if (isShipSnapshotError(loaded)) return loaded.error
  const snapshot = loaded ?? initialShipSnapshot(path, markdown, idea)
  if (snapshot === undefined) return SHIP_NO_OBJECTIVE
  const typed = freezeText(idea)
  const saved = freezeText(snapshot.originalRequirement)
  if (typed !== '' && saved !== '' && !freezeEqual(typed, saved)) return SHIP_IDEA_CONFLICT
  const drift = validateSnapshotAgainstSpec(snapshot, path, markdown)
  if (drift !== undefined) return drift
  const answers = readShipAnswers(path)
  if (isShipAnswersError(answers)) return answers.error
  const written = persistSnapshot(cwd, path, markdown, snapshot, loaded)
  if (written !== undefined) return written
  state.specPath = path
  return flushPending(cwd, state)
}

function persistSnapshot(
  cwd: string,
  path: string,
  markdown: string,
  base: ShipSnapshot,
  previous: ShipSnapshot | undefined,
): string | undefined {
  let next: ShipSnapshot = { ...base, specPath: basename(path) }
  next = sealOriginalIfNeeded(next, markdown)
  next = sealTrackIfNeeded(next, markdown)
  if (previous?.originalSealed === true && next.originalRequirement !== previous.originalRequirement) {
    return `Frozen ## Original Requirement no longer matches ${display(cwd, path)}. Stopped; restore the approved content.`
  }
  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)) return undefined
  try {
    writeShipSnapshot(next, path)
  } catch {
    return `Ship snapshot could not be written beside ${display(cwd, path)}. Stopped.`
  }
  return undefined
}

function persistAnswers(cwd: string, path: string, incoming: readonly ShipUserAnswer[]): string | undefined {
  if (incoming.length === 0) return undefined
  const loaded = readShipAnswers(path)
  if (isShipAnswersError(loaded)) return loaded.error
  const next = mergeShipAnswers(loaded?.answers, incoming)
  try {
    writeShipAnswers({ version: 1, specPath: basename(path), answers: next }, path)
  } catch {
    return `Ship answers record could not be written beside ${display(cwd, path)}. Stopped.`
  }
  return undefined
}

function flushPending(cwd: string, state: ShipRunState): string | undefined {
  if (state.specPath === undefined || state.pending.length === 0) return undefined
  const error = persistAnswers(cwd, state.specPath, state.pending)
  if (error === undefined) state.pending = []
  return error
}

/** Re-check a bound spec after a write: freeze, then seal what appeared. */
function recheck(cwd: string, state: ShipRunState): string | undefined {
  const path = state.specPath
  if (path === undefined) return undefined
  let markdown: string
  try {
    markdown = readFileSync(path, 'utf8')
  } catch {
    return `Bound spec is unreadable at ${display(cwd, path)}. Stopped; restore the spec.`
  }
  const loaded = readShipSnapshot(path)
  if (isShipSnapshotError(loaded)) return loaded.error
  // Binding wrote the snapshot, so a missing one was removed during the run.
  if (loaded === undefined) return `Ship snapshot is missing or changed beside ${display(cwd, path)}. Stopped; restore the saved snapshot.`
  const drift = validateSnapshotAgainstSpec(loaded, path, markdown)
  if (drift !== undefined) return drift
  return persistSnapshot(cwd, path, markdown, loaded, loaded)
}

function statusOf(path: string | undefined): ShipStatus | undefined {
  if (path === undefined) return undefined
  try {
    return parseShipStatus(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The questions a model sent, as the answer encoder needs them. */
export function askQuestions(input: unknown): ShipAskQuestion[] {
  const list = (input as { questions?: unknown } | undefined)?.questions
  if (!Array.isArray(list)) return []
  const out: ShipAskQuestion[] = []
  for (const raw of list) {
    const item = raw as Record<string, unknown> | null
    if (item === null || typeof item !== 'object' || text(item.id) === '') continue
    const question: ShipAskQuestion = { id: text(item.id), question: text(item.question) }
    if (text(item.header) !== '') question.header = text(item.header)
    if (text(item.detail) !== '') question.detail = text(item.detail)
    out.push(question)
  }
  return out
}

/**
 * The human answers in an `ask_user_question` result
 * (`{"answers":[{"id","selected","custom"}]}`); undefined when the result is
 * not an answer, so nothing is recorded.
 */
export function askAnswers(result: unknown): ShipAskAnswer[] | undefined {
  let value: unknown = result
  if (typeof result === 'string') {
    try {
      value = JSON.parse(result)
    } catch {
      return undefined
    }
  }
  const list = (value as { answers?: unknown } | null)?.answers
  if (!Array.isArray(list)) return undefined
  const out: ShipAskAnswer[] = []
  for (const raw of list) {
    const item = raw as Record<string, unknown> | null
    if (item === null || typeof item !== 'object' || text(item.id) === '') continue
    const answer: ShipAskAnswer = { id: text(item.id) }
    if (Array.isArray(item.selected)) answer.selected = item.selected.filter((label): label is string => typeof label === 'string')
    if (typeof item.custom === 'string') answer.custom = item.custom
    out.push(answer)
  }
  return out
}

function onPrompt(input: ShipHookInput, sessionId: string): ShipHookOutput {
  const prompt = text(input.payload.prompt)
  const invocation = parseShipInvocation(prompt)
  const prior = readRunState(input.dataDir, input.cwd)
  if (invocation === undefined) {
    if (prior?.active === true && prior.sessionId === sessionId) writeRunState(input.dataDir, { ...prior, active: false })
    return OK
  }
  const state: ShipRunState = {
    version: 1,
    cwd: resolve(input.cwd),
    sessionId,
    idea: invocation.idea,
    active: true,
    pending: [],
    startedAt: (input.now?.() ?? new Date()).toISOString(),
  }
  const unfinished = unfinishedSpecs(input.cwd)
  if (unfinished.length > 1) {
    writeRunState(input.dataDir, { ...state, active: false })
    return block(`${SHIP_AMBIGUOUS_SPECS} (${unfinished.map(path => display(input.cwd, path)).join(', ')})`)
  }
  const only = unfinished[0]
  if (only !== undefined) {
    const status = statusOf(only)
    if (!MIGRATED.has(status)) {
      writeRunState(input.dataDir, { ...state, active: false })
      return block(laterPhaseMessage(display(input.cwd, only), status as ShipStatus))
    }
    const error = adopt(input.cwd, only, invocation.idea, state)
    if (error !== undefined) {
      writeRunState(input.dataDir, { ...state, active: false })
      return block(error)
    }
  }
  writeRunState(input.dataDir, state)
  return OK
}

function onTool(input: ShipHookInput, sessionId: string): ShipHookOutput {
  const state = readRunState(input.dataDir, input.cwd)
  if (state === undefined || !state.active || state.sessionId !== sessionId) return OK
  if (text(input.payload.permissionMode) === 'plan') return OK
  const tool = text(input.payload.tool_name) || text(input.payload.toolName)
  let error: string | undefined
  if (tool === 'ask_user_question') {
    const answers = askAnswers(input.payload.tool_response ?? input.payload.toolResult)
    if (answers !== undefined) {
      const records = encodeAskUserAnswers(askQuestions(input.payload.tool_input ?? input.payload.toolInput), answers, phaseFromShipStatus(statusOf(state.specPath)))
      if (state.specPath === undefined) state.pending = mergeShipAnswers(state.pending, records)
      else error = persistAnswers(input.cwd, state.specPath, records)
    }
  }
  if (error === undefined && state.specPath === undefined) {
    const unfinished = unfinishedSpecs(input.cwd)
    if (unfinished.length > 1) error = `${SHIP_AMBIGUOUS_SPECS} (${unfinished.map(path => display(input.cwd, path)).join(', ')})`
    else if (unfinished[0] !== undefined) error = adopt(input.cwd, unfinished[0], state.idea, state)
  } else if (error === undefined && tool !== 'ask_user_question') {
    error = recheck(input.cwd, state)
  }
  if (error !== undefined) state.active = false
  writeRunState(input.dataDir, state)
  return error === undefined ? OK : block(error)
}

/** One hook call. Unknown events and non-Ship prompts do nothing. */
export function handleShipHook(input: ShipHookInput): ShipHookOutput {
  const sessionId = text(input.payload.sessionId) || text(input.payload.session_id)
  const event = input.event || text(input.payload.hook_event_name)
  if (event === 'UserPromptSubmit' || event === 'user_prompt_submit') return onPrompt(input, sessionId)
  if (event === 'PostToolUse' || event === 'post_tool_use') return onTool(input, sessionId)
  return OK
}
