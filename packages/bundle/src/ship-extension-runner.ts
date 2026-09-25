/**
 * The Ship extension's runner for the whole `/ship` flow in `codsh --rust`
 * (ticket 208): the phases after wayfinder, the two gates, the landing wave
 * in isolated worktrees, conflict resolution, final verification, and
 * Merge-back, driven from command hooks while dsh executes every agent.
 *
 * The legacy runner (`ship-run.ts`) owns a loop that spends turns and
 * creates children itself. A plugin cannot, so the same decisions are made at
 * hook boundaries and dsh does the work:
 *
 * - `Stop` is the phase loop. When the parent turn ends after a legal
 *   forward Status change, or after a human answer in wayfinder or grill, it
 *   continues the turn with the next phase contract
 *   ({@link shipContinuationFor}). It stops on a guard failure, an
 *   unresolved `## Blocker`, an invalid transition, an Abort answer, or idle.
 * - `PreToolUse` on `ask_user_question` auto-Confirms `ship · gate 1/2` and
 *   `ship · gate 2/2` while a run is in flight: the runner writes Status
 *   (`confirmed` / `planned`), seals the snapshot and the Mission Contract,
 *   and refuses the card with a short notice. After the seal an Edit-shaped
 *   gate writes `## Blocker`, as legacy does.
 * - Landing: at `Stop`, unblocked unclaimed tickets are claimed
 *   (`Claim: claimed`, commit `ship: claim landing:N`) and the parent is
 *   told to call `subagent` once per ticket with `isolation: "worktree"`
 *   (ticket 174), all in one step so siblings run in parallel. Each ticket's
 *   `PostToolUse` records the child's worktree and serial-merges the
 *   Ready-set (lowest `landing:N` first): Worktree commit as the host,
 *   `merge --no-ff`, worktree and branch removed, `Proof: green`, tick commit.
 *   A conflict keeps the merge in progress and asks for one conflict-
 *   resolution subagent in the merge-target tree; each attempt is validated
 *   with the legacy rules, up to three, then the merge is snapshotted,
 *   aborted, and recorded as a `## Blocker`.
 * - A failed or cancelled child is never merged or ticked: its side effects
 *   are unknown. The ticket keeps its Claim and is dispatched again only
 *   after the user resumes with `/ship`.
 * - When every ticket is ticked, `Stop` injects the separate final
 *   verification turn; after `Status: shipped` it checks the plan, the
 *   Blocker, and the sealed acceptance evidence, then merges back into
 *   `Original-Branch` (fast-forward, else squash with the same resolver).
 *
 * The run state (plugin data) only remembers what the files cannot: the
 * phase last injected, human answers in this turn, and each dispatched
 * child's worktree. Everything the browser graph and a resumed run read is
 * on disk (spec, sidecars, `.scratch/<slug>/issues`, git history).
 * @module codsh-bundle/src/ship-extension-runner
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { compileMissionContract, mainTrackDrifted, missionContractPath, missionContractSummary, slugFromSpec, type MissionContract } from './mission.ts'
import { parseMainTrack, parseOriginalRequirement, parseShipBlocker, parseShipStatus, parseSpecMetadata, type ShipStatus } from './plan.ts'
import {
  classifyConflictFiles,
  conflictResolutionPrompt,
  extraStatusPaths,
  hasConflictMarkers,
  inspectConflictResolution,
  mergeSnapshotRepoPath,
  mergeSnapshotUtc,
  unmergedPathsFromLs,
  writeMergeSnapshot,
  type ConflictFile,
  type ConflictSkipReason,
} from './ship-conflict.ts'
import {
  landingPlan,
  landingTicketTitle,
  landingWavePrepend,
  landMergeMessage,
  proofSweepCommitMessage,
  readySet,
  worktreeCommitMessage,
  type LandingTicket,
} from './ship-landing.ts'
import { isShipSnapshotError, readShipSnapshot } from './ship-snapshot.ts'
import { shipContinuationFor, shipPhaseKind, type ShipPhaseKind } from './ship.ts'
import { parseEvidenceFromSpec, verifyAcceptance } from './verify.ts'
import type { ShipHookInput, ShipHookOutput, ShipRunState } from './ship-extension.ts'
import { adoptSpec, block, display, recheckSpec, SHIP_AMBIGUOUS_SPECS, statusOf, unfinishedSpecs, writeRunState } from './ship-extension.ts'

/** Legacy phase order; only a +1 step may continue. */
const PHASE_RANK: Record<ShipPhaseKind, number> = { wayfinder: 0, grill: 1, spec: 2, tickets: 3, land: 4, done: 5 }

/** Conflict-resolution attempts per merge, as legacy. */
const CONFLICT_ATTEMPTS = 3

/** How often one claimed ticket is dispatched without a result before the run stops. */
const REDISPATCH_LIMIT = 2

/** The host clips a hook systemMessage to 500 characters. */
const NOTE_CHARS = 480

/** The host clips a Stop continuation to 10,000 characters. */
const CONTINUATION_CHARS = 9_800

/** What one landing ticket's child did, as far as this run saw it. */
export interface ShipLandingRecord {
  /** dispatched: told to the parent; finished: child succeeded; failed: child errored or was cancelled; landed: merged and ticked. */
  state: 'dispatched' | 'finished' | 'failed' | 'landed'
  worktree?: string
  branch?: string
  worktreeId?: string
  /** Why a child failed (its error text, clipped). */
  note?: string
  /** Times the ticket was dispatched without a result. */
  dispatches?: number
}

/** A merge left in progress for a conflict-resolution child. */
export interface ShipConflictState {
  /** Ticket id, or `delivery` for Merge-back. */
  ticket: string
  paths: string[]
  unmerged: string[]
  before: { path: string; content?: string }[]
  fingerprints: Record<string, string | null>
  baseline: Record<string, string | null>
  baselineIndex: Record<string, string>
  mergeOutput: string
  attempt: number
  feedback?: string
  utc: string
  /** Workspace-relative path of the resolver brief. */
  brief: string
  /** Merge-back squash: commit with this message instead of --no-edit. */
  squashMessage?: string
}

/** Runner memory in the run state. */
export interface ShipRunnerState {
  /** Phase whose contract the parent is working on. */
  phase?: ShipPhaseKind
  /** False until this run injected a phase contract (a bare `/ship` resume). */
  injected?: boolean
  /** A human answered an ask since the last Stop. */
  hitl?: boolean
  /** That answer was Abort or Stop. */
  stopAnswer?: boolean
  /** The final verification turn was injected. */
  verifying?: boolean
  /** Approved plan lines when landing started; they may not change. */
  plan?: string[]
  landing?: Record<string, ShipLandingRecord>
  conflict?: ShipConflictState
  /** Stop reason recorded by a tool hook, reported at the next Stop. */
  halt?: string
  /** SHA-256 of the Mission Contract this run sealed or loaded. */
  contractHash?: string
  /** Merge-back finished inside a tool hook; the next Stop reports it. */
  delivered?: string
  /** The run shipped and merged back. */
  complete?: boolean
}

const OK: ShipHookOutput = { stdout: '', exitCode: 0 }

function runner(state: ShipRunState): ShipRunnerState {
  state.runner ??= {}
  return state.runner
}

function out(value: Record<string, unknown>): ShipHookOutput {
  return { stdout: `${JSON.stringify(value)}\n`, exitCode: 0 }
}

/** A hook note (systemMessage): shown in the transcript and passed to the model. */
function note(line: string): ShipHookOutput {
  return out({ systemMessage: line.length > NOTE_CHARS ? `${line.slice(0, NOTE_CHARS - 1)}…` : line })
}

/** Continue the parent turn with `context` (Stop). */
function continueWith(context: string, line: string): ShipHookOutput {
  const body = context.length > CONTINUATION_CHARS ? `${context.slice(0, CONTINUATION_CHARS - 1)}…` : context
  return out({ systemMessage: line, hookSpecificOutput: { hookEventName: 'Stop', additionalContext: body } })
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function writeText(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body.endsWith('\n') ? body : `${body}\n`)
}

function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

// ---------------------------------------------------------------- git

interface GitResult { code: number; stdout: string; output: string }

function git(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' },
  })
  const stdout = result.stdout ?? ''
  return { code: result.status ?? 1, stdout, output: `${stdout}${result.stderr ?? ''}`.trim() }
}

function hostIdentity(cwd: string): string[] {
  const name = git(cwd, ['config', 'user.name']).stdout.trim() || 'unknown'
  const email = git(cwd, ['config', 'user.email']).stdout.trim() || 'unknown@unknown'
  return ['-c', `user.name=${name}`, '-c', `user.email=${email}`, '-c', 'commit.gpgsign=false']
}

function gitAsHost(cwd: string, args: readonly string[]): GitResult {
  return git(cwd, [...hostIdentity(cwd), ...args])
}

function mergeInProgress(cwd: string): boolean {
  const head = git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  return head.code === 0 && head.stdout.trim() !== ''
}

// ---------------------------------------------------------------- spec files

interface Spec {
  cwd: string
  path: string
  markdown: string
  slug: string
  status: ShipStatus | undefined
  /** The run this spec is bound to, for the graph cache hook. */
  run: ShipRunState
}

function loadSpec(state: ShipRunState): Spec | undefined {
  const path = state.specPath
  if (path === undefined) return undefined
  const markdown = read(path)
  if (markdown === undefined) return undefined
  return { cwd: state.cwd, path, markdown, slug: slugFromSpec(markdown, path), status: parseShipStatus(markdown), run: state }
}

function scratchDir(spec: Spec): string {
  return join(spec.cwd, '.scratch', spec.slug)
}

function issueFile(spec: Spec, n: string): string | undefined {
  const dir = join(scratchDir(spec), 'issues')
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  const match = names.find(name => new RegExp(`^0*${n}-.+\\.md$`, 'u').test(name))
  return match === undefined ? undefined : join(dir, match)
}

function writeLandingClaim(spec: Spec, ticket: LandingTicket): void {
  const dir = join(scratchDir(spec), 'issues')
  const path = issueFile(spec, ticket.id) ?? join(dir, `${ticket.id.padStart(2, '0')}-ticket.md`)
  const body = read(path) ?? `Ticket ${ticket.id}: ${landingTicketTitle(ticket.contract)}\n`
  if (/^Claim:\s*claimed\b/imu.test(body)) return
  writeText(path, /^Claim:\s*/imu.test(body) ? body.replace(/^Claim:\s*.*$/imu, 'Claim: claimed') : `Claim: claimed\n${body}`)
}

function writeLandingProof(spec: Spec, n: string, color: 'green' | 'red'): void {
  const path = issueFile(spec, n)
  const body = path === undefined ? undefined : read(path)
  if (path === undefined || body === undefined) return
  const line = `Proof: ${color}`
  writeText(path, /^Proof:\s*/imu.test(body)
    ? body.replace(/^Proof:\s*.*$/imu, line)
    : /^Claim:\s*.*$/imu.test(body) ? body.replace(/^(Claim:\s*.*)$/imu, `$1\n${line}`) : `${line}\n${body}`)
}

function claimed(spec: Spec, n: string): boolean {
  const path = issueFile(spec, n)
  return path !== undefined && /^Claim:\s*claimed\b/imu.test(read(path) ?? '')
}

function tickCheckbox(markdown: string, id: string, done: boolean): string {
  return markdown.replace(
    new RegExp(`^([ \\t]*[-*][ \\t]+)\\[[ xX]\\]([ \\t]+Ticket\\s+${id}:)`, 'imu'),
    `$1[${done ? 'x' : ' '}]$2`,
  )
}

/** The spec, its runner sidecars, and the spec's scratch directory, workspace-relative. */
function recordPaths(spec: Spec): string[] {
  const stem = spec.path.replace(/\.md$/iu, '')
  return [spec.path, `${stem}.ship.json`, `${stem}.ship.answers.json`, `${stem}.ship.graph.json`, scratchDir(spec)]
    .filter(path => existsSync(path))
    .map(path => relative(spec.cwd, path).split(sep).join('/'))
}

let graphCacheHook: ((state: ShipRunState) => void) | undefined

/** The web layer registers its graph cache rebuild so each runner commit carries a current cache. */
export function setShipGraphCacheHook(hook: (state: ShipRunState) => void): void {
  graphCacheHook = hook
}

/**
 * Commit the Ship records. A worktree must start from a clean tree: subagent
 * isolation carries uncommitted changes, which would then collide with the
 * same uncommitted files when the ticket merges back.
 */
function commitRecords(spec: Spec, message: string): void {
  try {
    graphCacheHook?.(spec.run)
  } catch {
    // The cache is disposable; the next hook rewrites it.
  }
  const paths = recordPaths(spec)
  if (paths.length === 0) return
  git(spec.cwd, ['add', '-A', '--', ...paths])
  if (git(spec.cwd, ['diff', '--cached', '--quiet']).code === 0) return
  gitAsHost(spec.cwd, ['commit', '-q', '-m', message])
}

/** Changed paths outside what {@link commitRecords} commits. */
function strayChanges(spec: Spec): string[] {
  const status = git(spec.cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])
  const records = recordPaths(spec)
  return status.stdout.split('\0').filter(line => line.length > 3).map(line => line.slice(3))
    .filter(path => !records.some(record => path === record || path.startsWith(`${record}/`)))
}

// ---------------------------------------------------------------- guards

/**
 * The legacy guardContract checks, from files: a readable spec with a
 * Status, the snapshot freeze, and after Confirm the sealed Mission Contract.
 * @returns a stop message, or undefined.
 */
function guard(state: ShipRunState): string | undefined {
  const path = state.specPath
  if (path === undefined) return undefined
  const markdown = read(path)
  if (markdown === undefined) return `Bound spec is unreadable at ${display(state.cwd, path)}. Stopped; restore the spec.`
  if (parseShipStatus(markdown) === undefined) return `Bound spec has no valid Status at ${display(state.cwd, path)}. Stopped; restore the last approved phase.`
  return recheckSpec(state.cwd, state) ?? guardContract(state, markdown)
}

function guardContract(state: ShipRunState, markdown: string): string | undefined {
  const path = state.specPath
  if (path === undefined) return undefined
  if (!['confirmed', 'planned', 'landing', 'shipped'].includes(parseShipStatus(markdown) ?? '')) return undefined
  const r = runner(state)
  const slug = slugFromSpec(markdown, path)
  const contractPath = missionContractPath(state.cwd, slug)
  const raw = read(contractPath)
  if (raw === undefined) {
    if (r.contractHash !== undefined) return 'Sealed Mission Contract is missing or corrupt. Stopped; restore the approved contract.'
    // Gate 1 Confirm of this run, or a resume of a spec confirmed before any
    // seal existed: compile it once. Never recompiled over an existing file.
    try {
      const contract = compileMissionContract(markdown, { id: slug })
      const body = `${JSON.stringify(contract, null, 2)}\n`
      writeText(contractPath, body)
      r.contractHash = sha(body)
      return undefined
    } catch {
      return 'Mission Contract could not be sealed. Stopped; check the spec and writable scratch directory.'
    }
  }
  let contract: MissionContract
  try {
    contract = JSON.parse(raw) as MissionContract
    if (contract?.version !== 1 || typeof contract.mainTrackMarkdown !== 'string') throw new Error('corrupt')
  } catch {
    return r.contractHash === undefined
      ? 'Sealed Mission Contract is unreadable or corrupt. Stopped; restore it rather than recompiling.'
      : 'Sealed Mission Contract is missing or corrupt. Stopped; restore the approved contract.'
  }
  if (r.contractHash !== undefined && r.contractHash !== sha(raw)) return 'Sealed Mission Contract changed. Stopped; restore the approved contract.'
  r.contractHash = sha(raw)
  if (mainTrackDrifted(contract.mainTrackMarkdown, markdown)) {
    return 'Frozen ## Main Track no longer matches the sealed Mission Contract. Stopped; restore the approved content.'
  }
  return undefined
}

function readContract(spec: Spec): MissionContract | undefined {
  const raw = read(missionContractPath(spec.cwd, spec.slug))
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw) as MissionContract
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- gates

const SEALED_EDIT = 'Sealed Main Track cannot be edited. A needed design change is a ## Blocker to archive, not an Edit modal.'

/**
 * `PreToolUse` on `ask_user_question`: auto-Confirm a Ship gate while this
 * session's run is in flight, as the legacy composition root does. Other
 * questions are left alone; the auto-Confirm is never recorded as an answer.
 */
export function onShipGate(input: ShipHookInput, state: ShipRunState | undefined, sessionId: string): ShipHookOutput {
  if (state === undefined || !state.active || state.sessionId !== sessionId) return OK
  if (text(input.payload.permissionMode) === 'plan') return OK
  const asked = (input.payload.tool_input ?? input.payload.toolInput) as { questions?: { header?: unknown }[] } | undefined
  const headers = Array.isArray(asked?.questions) ? asked.questions.map(question => text(question?.header).trim()) : []
  const gate = headers.includes('ship · gate 1/2') ? 1 : headers.includes('ship · gate 2/2') ? 2 : undefined
  if (gate === undefined) return OK
  const r = runner(state)
  const error = guard(state)
  if (error !== undefined) return stopAtTool(input, state, error)
  const spec = loadSpec(state)
  if (spec === undefined) return OK
  const snapshot = readShipSnapshot(spec.path)
  const sealed = (!isShipSnapshotError(snapshot) && snapshot?.trackSealed === true)
    || ['confirmed', 'planned', 'landing', 'shipped'].includes(spec.status ?? '')
  const edit = gate === 1 ? sealed : ['planned', 'landing', 'shipped'].includes(spec.status ?? '')
  if (edit) {
    // After the seal an Edit-shaped gate is a Blocker, never an Edit modal.
    if (parseShipBlocker(spec.markdown) === undefined) writeText(spec.path, `${spec.markdown.replace(/\n*$/u, '\n')}\n## Blocker\n\n${SEALED_EDIT}\n`)
    r.halt = `Ship has an unresolved ## Blocker. Stopped; resolve it before resuming.\n${SEALED_EDIT}`
    writeRunState(input.dataDir, state)
    return block(`${SEALED_EDIT} Stopped.`)
  }
  if (shipPhaseKind(spec.status) !== (gate === 1 ? 'spec' : 'tickets')) return OK
  const next = gate === 1 ? 'confirmed' : 'planned'
  const updated = spec.markdown.replace(/^Status:\s*(?:wayfinding|grilling|interviewing|confirmed|planned|landing|shipped)\b/imu, `Status: ${next}`)
  if (updated === spec.markdown) return OK
  writeFileSync(spec.path, updated)
  // Persisting the snapshot seals the Main Track; gate 1 also seals the Mission Contract.
  const sealError = recheckSpec(state.cwd, state) ?? guardContract(state, updated)
  if (sealError !== undefined) return stopAtTool(input, state, sealError)
  writeRunState(input.dataDir, state)
  return block(`Confirmed ship · gate ${String(gate)}/2 automatically; Status is now ${next}${gate === 1 ? ' and the Mission Contract is sealed' : ''}. Do not set Status yourself; end this turn and the runner injects the next phase.`)
}

function stopAtTool(input: ShipHookInput, state: ShipRunState, message: string): ShipHookOutput {
  runner(state).halt = message
  writeRunState(input.dataDir, state)
  return block(message)
}

/** A person answered in this turn (and maybe chose Abort or Stop). */
export function noteShipAnswers(state: ShipRunState, answers: readonly { selected?: readonly string[] | undefined }[]): void {
  if (answers.length === 0) return
  const r = runner(state)
  r.hitl = true
  if (answers.some(answer => (answer.selected ?? []).some(label => /^(?:abort|stop)\b/iu.test(label.trim())))) r.stopAnswer = true
}

// ---------------------------------------------------------------- /ship

/**
 * `/ship` started or resumed a run. The landing records of the same spec
 * carry over; a conflict resolution a cancel or crash left behind is rolled
 * back (Merge snapshot, then `merge --abort`), as the legacy interrupt does,
 * and retried later from the kept worktree.
 * @returns a notice for the transcript, if something was rolled back.
 */
export function onShipPrompt(state: ShipRunState, prior: ShipRunState | undefined): string | undefined {
  const r = runner(state)
  const kind = shipPhaseKind(statusOf(state.specPath))
  r.phase = kind
  r.injected = state.specPath === undefined || kind === 'wayfinder'
  const same = prior?.runner !== undefined && prior.specPath !== undefined && prior.specPath === state.specPath
  if (same && prior.runner !== undefined) {
    // A failed child's record is dropped: the ticket keeps its Claim and is
    // dispatched again with a notice (a cancelled turn never reached Stop).
    if (prior.runner.landing !== undefined) {
      r.landing = Object.fromEntries(Object.entries(prior.runner.landing).filter(([, record]) => record.state !== 'failed'))
    }
    if (prior.runner.contractHash !== undefined) r.contractHash = prior.runner.contractHash
    if (prior.runner.conflict !== undefined) r.conflict = prior.runner.conflict
  }
  const spec = loadSpec(state)
  if (spec === undefined || r.conflict === undefined) return undefined
  return interruptConflict(spec, r, 'The conflict-resolution child did not finish (the turn was cancelled or the session ended).')
}

// ---------------------------------------------------------------- landing: dispatch

function briefPath(spec: Spec, id: string): string {
  return join(scratchDir(spec), 'landing', `landing-${id}.md`)
}

/** The landing child's full brief: the legacy landingPrompt, kept in a committed file. */
function landingBrief(spec: Spec, ticket: LandingTicket, wave: string): string {
  const original = parseOriginalRequirement(spec.markdown)
  return [
    `Ticket ${ticket.id}: ${landingTicketTitle(ticket.contract)}`,
    `Bound spec: ${display(spec.cwd, spec.path)}`,
    `Approved plan line: ${ticket.contract}`,
    'Implement only this ticket in this worktree. Do not tick the plan checkbox; Claim is already written.',
    'Children never commit. Return at most 20 lines naming the result plus evidence paths.',
    shipContinuationFor('landing', {
      specPath: display(spec.cwd, spec.path),
      ...(original === undefined ? {} : { originalRequirement: original }),
      landingWave: wave,
    }),
  ].join('\n\n')
}

/**
 * Worktrees an earlier child of this ticket left behind (dsh names them
 * after the call's description, `Ship Ticket N`). They are reported, never
 * merged or removed: their changes were never returned as a result.
 */
function keptWorktrees(cwd: string, id: string): string[] {
  const listed = git(cwd, ['worktree', 'list', '--porcelain'])
  if (listed.code !== 0) return []
  const kept: string[] = []
  for (const block of listed.stdout.split(/\n\s*\n/u)) {
    const path = /^worktree (.+)$/mu.exec(block)?.[1]
    const branch = /^branch refs\/heads\/(.+)$/mu.exec(block)?.[1]
    if (path !== undefined && branch !== undefined && new RegExp(`^codsh/ship-ticket-${id}-[^/]+$`, 'u').test(branch)) kept.push(path)
  }
  return kept
}

function keptNote(spec: Spec, id: string): string {
  const kept = keptWorktrees(spec.cwd, id)
  return kept.length === 0
    ? 'any worktree it left is not merged (see /worktree list)'
    : `its earlier worktree${kept.length > 1 ? 's' : ''} ${kept.join(', ')} ${kept.length > 1 ? 'are' : 'is'} kept and not merged (review or remove with /worktree)`
}

/** The subagent call the parent makes for one ticket. */
function landingCall(spec: Spec, ticket: LandingTicket): Record<string, unknown> {
  return {
    description: `Ship Ticket ${ticket.id}`,
    prompt: [
      `Ticket ${ticket.id}: ${landingTicketTitle(ticket.contract)}`,
      `Bound spec: ${display(spec.cwd, spec.path)}`,
      'Implement only this ticket in this worktree. Children never commit. Return at most 20 lines naming the result plus evidence paths.',
      `Read and follow the landing brief first: ${display(spec.cwd, briefPath(spec, ticket.id))}`,
    ].join('\n'),
    isolation: 'worktree',
  }
}

function dispatchLine(call: Record<string, unknown>): string {
  return `SHIP_DISPATCH ${JSON.stringify(call)}`
}

function waveView(spec: Spec, r: ShipRunnerState): Parameters<typeof readySet>[0] {
  const tickets = landingPlan(spec.markdown).tickets
  const records = r.landing ?? {}
  const pick = (test: (ticket: LandingTicket) => boolean): Set<string> => new Set(tickets.filter(test).map(ticket => ticket.id))
  const finished = pick(ticket => records[ticket.id]?.state === 'finished')
  return {
    tickets,
    claimed: pick(ticket => ticket.done || claimed(spec, ticket.id)),
    inFlight: pick(ticket => records[ticket.id]?.state === 'dispatched'),
    finished,
    worktrees: finished,
  }
}

/**
 * Claim every unblocked ticket that has no live child, commit each Claim,
 * write each brief, and return the subagent calls. A ticket dispatched
 * earlier whose result never came back is offered again (bounded) unless
 * `onlyNew`; its old worktree, if any, is never merged.
 */
function claimWave(spec: Spec, r: ShipRunnerState, onlyNew: boolean): { calls: Record<string, unknown>[]; stray?: string[]; notices: string[] } {
  const plan = landingPlan(spec.markdown)
  const closed = new Set(plan.tickets.filter(ticket => ticket.done).map(ticket => ticket.id))
  const records = (r.landing ??= {})
  const wave: LandingTicket[] = []
  const notices: string[] = []
  for (const ticket of plan.tickets) {
    if (ticket.done || !ticket.blockers.every(id => closed.has(id))) continue
    const record = records[ticket.id]
    if (record !== undefined && record.state !== 'dispatched') continue
    if (record?.state === 'dispatched') {
      if (onlyNew || (record.dispatches ?? 1) >= REDISPATCH_LIMIT) continue
      notices.push(`Ticket ${ticket.id} was dispatched but no subagent result came back; ${keptNote(spec, ticket.id)}. Dispatching it again.`)
    } else if (claimed(spec, ticket.id)) {
      notices.push(`Ticket ${ticket.id} is claimed but this run has no record of its child; ${keptNote(spec, ticket.id)}. Dispatching it again.`)
    }
    wave.push(ticket)
  }
  if (wave.length === 0) return { calls: [], notices }
  const stray = strayChanges(spec)
  if (stray.length > 0) return { calls: [], stray, notices }
  commitRecords(spec, 'ship: records before landing')
  const view = waveView(spec, r)
  const wavePrepend = landingWavePrepend({ ...view, inFlight: new Set([...view.inFlight, ...wave.map(ticket => ticket.id)]) })
  const ignore = join(scratchDir(spec), 'landing', '.gitignore')
  if (!existsSync(ignore)) writeText(ignore, 'conflict-*.md')
  for (const ticket of wave) {
    writeLandingClaim(spec, ticket)
    writeText(briefPath(spec, ticket.id), landingBrief(spec, ticket, wavePrepend))
    commitRecords(spec, `ship: claim landing:${ticket.id}`)
    const prior = records[ticket.id]
    records[ticket.id] = { state: 'dispatched', dispatches: (prior?.state === 'dispatched' ? prior.dispatches ?? 1 : 0) + 1 }
  }
  return { calls: wave.map(ticket => landingCall(spec, ticket)), notices }
}

function dispatchText(spec: Spec, r: ShipRunnerState, calls: readonly Record<string, unknown>[], notices: readonly string[]): string {
  const original = parseOriginalRequirement(spec.markdown)
  return [
    'Ship runner: landing wave (Phase 4 — automatic landing).',
    ...(original === undefined ? [] : [`## Original Requirement\n\n${original}`]),
    `Bound spec: ${JSON.stringify(display(spec.cwd, spec.path))}`,
    landingWavePrepend(waveView(spec, r)),
    ...notices,
    'In this client the runner dispatches every unblocked, unclaimed landing ticket as its own subagent in its own git worktree. Call the subagent tool now, once per SHIP_DISPATCH line below, all in the same step so siblings run in parallel, with exactly these arguments. Do not implement, merge, tick, or commit tickets yourself: the runner commits each finished worktree as the host, serial-merges the Ready-set (lowest landing:N first, --no-ff), records Proof, ticks the checkbox, and says what to dispatch next. A failed or cancelled child is not merged.',
    ...calls.map(dispatchLine),
  ].join('\n\n')
}

// ---------------------------------------------------------------- landing: merge

interface Worktree { path: string; branch: string; id?: string }

/** The worktree note the subagent tool appends to a result (ticket 174). */
export function parseWorktreeNote(result: string): Worktree | undefined {
  const match = /Worktree isolation: the subagent's changes stay in (.+?) \(branch (\S+?), \d+ changed file/u.exec(result)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  const id = /\/worktree rm (\S+?)\.(?:\s|$)/u.exec(result)?.[1]
  return { path: match[1], branch: match[2], ...(id === undefined ? {} : { id }) }
}

function recordWorktree(worktree: Worktree | undefined): Partial<ShipLandingRecord> {
  if (worktree === undefined) return {}
  return { worktree: worktree.path, branch: worktree.branch, ...(worktree.id === undefined ? {} : { worktreeId: worktree.id }) }
}

/** Remove a merged ticket's worktree, its branch, and its registry record. */
function removeWorktree(spec: Spec, record: ShipLandingRecord | undefined): void {
  const path = record?.worktree
  if (record === undefined || path === undefined) return
  git(spec.cwd, ['worktree', 'remove', '--force', '--force', path])
  if (existsSync(path)) {
    try { rmSync(path, { recursive: true, force: true }) } catch { /* a leftover checkout must not block the drain */ }
  }
  git(spec.cwd, ['worktree', 'prune'])
  if (record.branch !== undefined) git(spec.cwd, ['branch', '-D', record.branch])
  const entry = join(dirname(dirname(path)), '.registry', `${record.worktreeId ?? basename(path)}.json`)
  try {
    const value = JSON.parse(readFileSync(entry, 'utf8')) as { path?: unknown }
    if (typeof value.path === 'string' && resolve(value.path) === resolve(path)) unlinkSync(entry)
  } catch {
    // No registry record for that path: nothing to drop.
  }
}

/** After a land merge: worktree gone, `Proof: green`, checkbox ticked, one ledger commit. */
function finishLanding(spec: Spec, r: ShipRunnerState, ticket: LandingTicket): void {
  removeWorktree(spec, r.landing?.[ticket.id])
  // No prover port in this client, as in the legacy composition root: green.
  writeLandingProof(spec, ticket.id, 'green')
  const markdown = read(spec.path) ?? spec.markdown
  writeText(spec.path, tickCheckbox(markdown, ticket.id, true))
  spec.markdown = read(spec.path) ?? markdown
  commitRecords(spec, proofSweepCommitMessage(ticket, []))
  ;(r.landing ??= {})[ticket.id] = { state: 'landed' }
}

type DrainResult =
  | { kind: 'idle'; landed: string[] }
  | { kind: 'conflict'; landed: string[]; call: Record<string, unknown>; files: string[] }
  | { kind: 'halt'; landed: string[]; message: string }

/** Serial-merge the Ready-set, lowest landing:N first, until empty or a conflict. */
function drain(spec: Spec, r: ShipRunnerState): DrainResult {
  const landed: string[] = []
  for (;;) {
    if (r.conflict !== undefined) return { kind: 'idle', landed }
    spec.markdown = read(spec.path) ?? spec.markdown
    if (parseShipBlocker(spec.markdown) !== undefined) return { kind: 'idle', landed }
    const next = readySet(waveView(spec, r))[0]
    if (next === undefined) return { kind: 'idle', landed }
    const record = r.landing?.[next.id]
    if (record?.worktree === undefined) {
      // The child succeeded and changed nothing, so nothing is merged.
      finishLanding(spec, r, next)
      landed.push(next.id)
      continue
    }
    if (!existsSync(record.worktree)) {
      return { kind: 'halt', landed, message: `Ticket ${next.id}'s worktree ${record.worktree} is gone, so its work cannot be merged. Stopped; nothing was ticked.` }
    }
    if (mergeInProgress(spec.cwd)) return { kind: 'halt', landed, message: `A merge is already in progress in ${spec.cwd}. Stopped; finish or abort it before resuming.` }
    git(record.worktree, ['add', '-A'])
    gitAsHost(record.worktree, ['commit', '-q', '-m', worktreeCommitMessage(next)])
    const ref = record.branch ?? git(record.worktree, ['rev-parse', 'HEAD']).stdout.trim()
    const merged = gitAsHost(spec.cwd, ['merge', '--no-ff', '-m', landMergeMessage(next), ref])
    if (merged.code === 0) {
      finishLanding(spec, r, next)
      landed.push(next.id)
      continue
    }
    const started = startConflict(spec, r, next, merged.output)
    if ('message' in started) return { kind: 'halt', landed, message: started.message }
    return { kind: 'conflict', landed, call: started.call, files: started.files }
  }
}

// ---------------------------------------------------------------- conflicts

function isScratchNoise(path: string): boolean {
  return /(?:^|[/\\])\.scratch[/\\]/u.test(path.replace(/\\/gu, '/'))
}

function fingerprint(cwd: string, path: string): string | null {
  try {
    const full = join(cwd, path)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) return `link:${readlinkSync(full)}`
    if (!stat.isFile()) return `mode:${String(stat.mode)}`
    return `${String(stat.mode)}:${sha(readFileSync(full))}`
  } catch {
    return null
  }
}

function indexEntries(output: string, allowed: ReadonlySet<string>): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const row of output.split('\0')) {
    const tab = row.indexOf('\t')
    if (tab < 0) continue
    const path = row.slice(tab + 1)
    if (!allowed.has(path) && !isScratchNoise(path)) entries[path] = row.slice(0, tab)
  }
  return entries
}

function unmergedPaths(cwd: string): string[] {
  const listed = unmergedPathsFromLs(git(cwd, ['ls-files', '-u', '-z']).stdout)
  if (listed.length > 0) return listed
  return git(cwd, ['diff', '--name-only', '--diff-filter=U']).stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
}

function conflictFile(cwd: string, path: string): ConflictFile {
  try {
    const bytes = readFileSync(join(cwd, path))
    return { path, content: bytes.toString('utf8'), bytes }
  } catch {
    return { path, content: undefined }
  }
}

function abortMerge(cwd: string, squash: boolean): boolean {
  return git(cwd, squash ? ['reset', '--merge', 'HEAD'] : ['merge', '--abort']).code === 0
}

function conflictKey(ticket: string): string {
  return ticket === 'delivery' ? 'delivery' : `landing:${ticket}`
}

function conflictLabel(spec: Spec, ticket: string): string {
  if (ticket === 'delivery') return 'Merge-back'
  const row = landingPlan(spec.markdown).tickets.find(item => item.id === ticket)
  return row === undefined ? `Ticket ${ticket}` : `Ticket ${ticket}: ${landingTicketTitle(row.contract)}`
}

function resolverCall(conflict: ShipConflictState, label: string): Record<string, unknown> {
  return {
    description: `Ship conflict ${conflict.ticket === 'delivery' ? 'Merge-back' : `Ticket ${conflict.ticket}`}`,
    prompt: `Conflict-resolution for ${label} (${conflictKey(conflict.ticket)}), attempt ${String(conflict.attempt + 1)} of ${String(CONFLICT_ATTEMPTS)}. Read and follow ${conflict.brief} in this merge-target tree.`,
  }
}

/** The legacy resolver prompt with validation feedback, kept in an ignored scratch file. */
function writeResolverBrief(spec: Spec, conflict: ShipConflictState, label: string): void {
  writeText(join(spec.cwd, conflict.brief), `${conflictResolutionPrompt(conflict.paths, conflict.feedback)}\n\nMerge context: ${label} (${conflictKey(conflict.ticket)})\nGit reported:\n${conflict.mergeOutput}\n`)
}

/**
 * The first half of the legacy runMergeConflictResolution: the unmerged set,
 * the baselines, the classification, and the resolver brief. The merge stays
 * in progress for the child.
 */
function startConflict(spec: Spec, r: ShipRunnerState, ticket: LandingTicket | undefined, mergeOutput: string, squashMessage?: string): { call: Record<string, unknown>; files: string[] } | { message: string } {
  const id = ticket?.id ?? 'delivery'
  const directory = ticket === undefined ? 'delivery' : `landing-${ticket.id}`
  const cwd = spec.cwd
  const unmerged = unmergedPaths(cwd)
  const stagedPaths = unmergedPathsFromLs(git(cwd, ['ls-files', '--stage', '-z']).stdout)
  if (/^CONFLICT \(modify\/delete\)/mu.test(mergeOutput)) {
    for (const path of git(cwd, ['diff', '--cached', '--name-only', '--diff-filter=A', '-z']).stdout.split('\0').filter(Boolean)) {
      if (!unmerged.includes(path)) unmerged.push(path)
    }
  }
  for (const line of mergeOutput.split('\n').filter(item => /^CONFLICT \((?:rename|file\/directory)/u.test(item))) {
    for (const path of stagedPaths) if (!unmerged.includes(path) && line.includes(path)) unmerged.push(path)
  }
  if (unmerged.length === 0) {
    abortMerge(cwd, squashMessage !== undefined)
    return {
      message: ticket === undefined
        ? `Merge-back conflict could not be classified. Stopped; keep ship/<slug>.\n${mergeOutput}`
        : `Landing merge conflict on Ticket ${ticket.id}. Stopped; keep the worktree and ref.\n${mergeOutput}`,
    }
  }
  const files = unmerged.map(path => conflictFile(cwd, path))
  const protection = [...files]
  for (const file of files.filter(item => /\.md$/iu.test(item.path) && item.content === undefined)) {
    for (const stage of [1, 2, 3]) {
      const version = git(cwd, ['show', `:${String(stage)}:${file.path}`])
      if (version.code === 0) protection.push({ path: file.path, content: version.stdout })
    }
  }
  const classified = classifyConflictFiles(protection)
  const allowed = new Set(unmerged)
  const baseline: Record<string, string | null> = {}
  for (const path of extraStatusPaths(git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']).stdout, allowed)) baseline[path] = fingerprint(cwd, path)
  const conflict: ShipConflictState = {
    ticket: id,
    paths: classified.kind === 'fillable' ? [...new Set(classified.paths)] : [],
    unmerged,
    before: files.map(file => ({ path: file.path, ...(file.content === undefined ? {} : { content: file.content }) })),
    fingerprints: Object.fromEntries(unmerged.map(path => [path, fingerprint(cwd, path)])),
    baseline,
    baselineIndex: indexEntries(git(cwd, ['ls-files', '--stage', '-z']).stdout, allowed),
    mergeOutput,
    attempt: 0,
    utc: mergeSnapshotUtc(),
    brief: display(cwd, join(scratchDir(spec), 'landing', `conflict-${directory}.md`)),
    ...(squashMessage === undefined ? {} : { squashMessage }),
  }
  if (classified.kind === 'skip') return { message: conflictBlocker(spec, r, conflict, classified.reason) }
  r.conflict = conflict
  const label = conflictLabel(spec, id)
  writeResolverBrief(spec, conflict, label)
  return { call: resolverCall(conflict, label), files: conflict.paths }
}

function snapshotConflict(spec: Spec, conflict: ShipConflictState, reason?: string): string {
  return writeMergeSnapshot({
    scratchSlugDir: scratchDir(spec),
    directory: conflict.ticket === 'delivery' ? 'delivery' : `landing-${conflict.ticket}`,
    utc: conflict.utc,
    gitOutput: [conflict.mergeOutput, conflict.feedback].filter(Boolean).join('\n'),
    unmerged: conflict.unmerged,
    files: conflict.unmerged.map(path => conflictFile(spec.cwd, path)),
    ...(reason === undefined ? {} : { reason }),
  })
}

/** Out of attempts, or not fillable: snapshot, abort, `## Blocker`, blocker commit. */
function conflictBlocker(spec: Spec, r: ShipRunnerState, conflict: ShipConflictState, reason: ConflictSkipReason): string {
  const snapshotDir = snapshotConflict(spec, conflict, reason)
  const rolledBack = abortMerge(spec.cwd, conflict.squashMessage !== undefined)
  delete r.conflict
  const delivery = conflict.ticket === 'delivery'
  if (!rolledBack) {
    return delivery
      ? `Merge-back conflict resolution could not roll back safely. Merge left intact; no blocker commit was created. Snapshot: ${snapshotDir}`
      : `Landing conflict resolution on Ticket ${conflict.ticket} could not roll back safely. Merge left intact; no blocker commit was created. Snapshot: ${snapshotDir}`
  }
  if (delivery) {
    // The squash is gone; the records live on the feature branch.
    const feature = parseSpecMetadata(spec.markdown).branch ?? `ship/${spec.slug}`
    git(spec.cwd, ['checkout', '-q', feature])
  }
  const markdown = read(spec.path) ?? spec.markdown
  if (parseShipBlocker(markdown) === undefined) {
    const body = [
      `Conflict-resolution could not complete for ${delivery ? 'Merge-back' : `Ticket ${conflict.ticket}`} (${reason}).`,
      `Merge snapshot: ${mergeSnapshotRepoPath(spec.cwd, snapshotDir)}`,
      delivery
        ? 'Automatic resolution preserved ship/<slug> for recovery. Review the validation failure and snapshot before resuming.'
        : 'Automatic resolution preserved the worktree and ref as 已认领. Review the validation failure and snapshot before resuming.',
    ]
    writeText(spec.path, `${markdown.replace(/\n*$/u, '\n')}\n## Blocker\n\n${body.join('\n')}\n`)
  }
  spec.markdown = read(spec.path) ?? markdown
  git(spec.cwd, ['add', '--', spec.path])
  git(spec.cwd, ['add', '-f', '--', snapshotDir])
  const row = landingPlan(spec.markdown).tickets.find(item => item.id === conflict.ticket)
  gitAsHost(spec.cwd, ['commit', '-q', '-m', delivery ? 'ship: blocker Merge-back' : `ship: blocker Ticket ${conflict.ticket} — ${row === undefined ? '' : landingTicketTitle(row.contract)}`])
  return delivery
    ? `Merge-back conflict resolution needs attention (${reason}). Keep ship/<slug>. Snapshot: ${snapshotDir}`
    : `Landing conflict resolution on Ticket ${conflict.ticket} needs attention (${reason}). Keep the worktree and ref. Snapshot: ${snapshotDir}`
}

/**
 * A resolver that did not finish: snapshot and roll the merge back. The
 * ticket's own worktree stays finished, so the merge is retried later.
 */
function interruptConflict(spec: Spec, r: ShipRunnerState, why: string): string | undefined {
  const conflict = r.conflict
  if (conflict === undefined) return undefined
  delete r.conflict
  const squash = conflict.squashMessage !== undefined
  if (!squash && !mergeInProgress(spec.cwd)) return undefined
  const snapshotDir = snapshotConflict(spec, conflict)
  if (!abortMerge(spec.cwd, squash)) return `Conflict resolution interrupted, but Git rollback failed. Merge left intact. Snapshot: ${snapshotDir}`
  if (squash) git(spec.cwd, ['checkout', '-q', parseSpecMetadata(spec.markdown).branch ?? `ship/${spec.slug}`])
  return `${why} The merge of ${conflictLabel(spec, conflict.ticket)} was rolled back (Merge snapshot ${mergeSnapshotRepoPath(spec.cwd, snapshotDir)}); /ship retries it${squash ? '' : ' from the kept worktree'}.`
}

type Settled =
  | { kind: 'resolved' }
  | { kind: 'retry'; call: Record<string, unknown>; feedback: string }
  | { kind: 'halt'; message: string }

/**
 * The second half of runMergeConflictResolution, after the resolver child
 * returned: validate with the legacy rules, then stage and commit, or write
 * the feedback for a fresh attempt, or record the Blocker after three.
 */
function settleConflict(spec: Spec, r: ShipRunnerState): Settled {
  const conflict = r.conflict
  if (conflict === undefined) return { kind: 'resolved' }
  const cwd = spec.cwd
  const allowed = new Set(conflict.unmerged)
  const status = git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])
  const currentIndex = git(cwd, ['ls-files', '--stage', '-z'])
  let invalid: ConflictSkipReason | undefined
  let feedback: string
  if (status.code !== 0 || currentIndex.code !== 0) {
    invalid = 'git-failed'
    feedback = `git-failed: ${status.output}\n${currentIndex.output}`
  } else {
    const candidates = new Set([...Object.keys(conflict.baseline), ...extraStatusPaths(status.stdout, allowed)])
    const index = indexEntries(currentIndex.stdout, allowed)
    const indexChanges = [...new Set([...Object.keys(conflict.baselineIndex), ...Object.keys(index)])]
      .filter(path => conflict.baselineIndex[path] !== index[path])
    const extras = [...new Set([
      ...[...candidates].filter(path => !(path in conflict.baseline) || fingerprint(cwd, path) !== conflict.baseline[path]),
      ...indexChanges,
    ])]
    const before: ConflictFile[] = conflict.before.map(file => ({ path: file.path, content: file.content }))
    const after = conflict.paths.map(path => conflictFile(cwd, path))
    const pending = unmergedPaths(cwd)
    const unchanged = before.filter(file => pending.includes(file.path)
      && (file.content === undefined || !hasConflictMarkers(file.content))
      && fingerprint(cwd, file.path) === conflict.fingerprints[file.path]).map(file => file.path)
    invalid = inspectConflictResolution(before, after, extras) ?? (unchanged.length > 0 ? 'unconfirmed-resolution' : undefined)
    feedback = invalid === undefined ? '' : `${invalid}${extras.length === 0 ? '' : `: restore unrelated files: ${extras.join(', ')}`}${unchanged.length === 0 ? '' : `: ${unchanged.join(', ')} are unchanged and still unmerged. Resolve their content, or explicitly stage only these paths with git add -- <path> to confirm keeping the current version after comparing both sides.`}`
    if (invalid === undefined) {
      const indexed = new Set(unmergedPathsFromLs(currentIndex.stdout))
      const stage = conflict.paths.filter(path => indexed.has(path) || fingerprint(cwd, path) !== null)
      const added = stage.length === 0 ? { code: 0, stdout: '', output: '' } : git(cwd, ['add', '--', ...stage])
      const committed = added.code !== 0 ? added : gitAsHost(cwd, conflict.squashMessage === undefined ? ['commit', '-q', '--no-edit'] : ['commit', '-q', '-m', conflict.squashMessage])
      if (committed.code === 0) {
        delete r.conflict
        try { unlinkSync(join(cwd, conflict.brief)) } catch { /* the brief is scratch */ }
        return { kind: 'resolved' }
      }
      invalid = 'git-failed'
      feedback = `git-failed: ${committed.output}`
    }
  }
  conflict.attempt += 1
  conflict.feedback = feedback
  if (conflict.attempt >= CONFLICT_ATTEMPTS) return { kind: 'halt', message: conflictBlocker(spec, r, conflict, invalid ?? 'leftover-markers') }
  const label = conflictLabel(spec, conflict.ticket)
  writeResolverBrief(spec, conflict, label)
  return { kind: 'retry', call: resolverCall(conflict, label), feedback }
}

// ---------------------------------------------------------------- subagent results

/** Which landing ticket or conflict a parent `subagent` call was for. */
function subagentRole(input: ShipHookInput): { ticket: string } | { conflict: string } | undefined {
  const args = (input.payload.tool_input ?? input.payload.toolInput) as { prompt?: unknown } | undefined
  const prompt = text(args?.prompt)
  const conflict = /^Conflict-resolution for .*?\((?:landing:(\d+)|(delivery))\)/u.exec(prompt)
  if (conflict !== null) return { conflict: conflict[1] ?? 'delivery' }
  const ticket = /^Ticket\s+(\d+)\s*:/u.exec(prompt)?.[1]
  return ticket === undefined ? undefined : { ticket }
}

function landPhase(state: ShipRunState): boolean {
  const kind = shipPhaseKind(statusOf(state.specPath))
  return kind === 'land' || kind === 'done'
}

function firstLine(message: string): string {
  return message.split('\n')[0] ?? message
}

/**
 * `PostToolUse` on a parent `subagent` call: record the child's worktree,
 * settle a conflict attempt, and drain the Ready-set. The reply is a short
 * note (shown in the transcript and passed to the model) naming what to
 * dispatch next, if anything; longer dispatches wait for the Stop hook.
 */
export function onShipSubagent(input: ShipHookInput, state: ShipRunState): ShipHookOutput {
  if (!landPhase(state)) return OK
  const role = subagentRole(input)
  const spec = loadSpec(state)
  if (role === undefined || spec === undefined) return OK
  const r = runner(state)
  const lines: string[] = []
  const save = (output: ShipHookOutput): ShipHookOutput => {
    writeRunState(input.dataDir, state)
    return output
  }
  if ('conflict' in role) {
    if (r.conflict?.ticket !== role.conflict) return OK
    const settled = settleConflict(spec, r)
    if (settled.kind === 'halt') {
      r.halt = settled.message
      return save(note(`Ship · stopped: ${firstLine(settled.message)}`))
    }
    if (settled.kind === 'retry') {
      return save(note(`Ship · conflict-resolution attempt ${String(r.conflict?.attempt ?? 0)}/${String(CONFLICT_ATTEMPTS)} did not pass validation (${firstLine(settled.feedback).split(':')[0] ?? ''}); the merge stays in progress. Dispatch a fresh subagent now: ${dispatchLine(settled.call)}`))
    }
    if (role.conflict === 'delivery') {
      r.delivered = `Merge back ran: the squash onto ${parseSpecMetadata(spec.markdown).originalBranch ?? 'the original branch'} needed conflict resolution, which passed validation and was committed.`
      return save(note('Ship · Merge-back conflict resolved and committed.'))
    }
    const ticket = landingPlan(spec.markdown).tickets.find(item => item.id === role.conflict)
    if (ticket !== undefined) finishLanding(spec, r, ticket)
    lines.push(`Ship · Ticket ${role.conflict} conflict resolved; landed and ticked.`)
  } else {
    const result = text(input.payload.tool_response ?? input.payload.toolResult)
    ;(r.landing ??= {})[role.ticket] = { state: 'finished', ...recordWorktree(parseWorktreeNote(result)) }
  }
  const drained = drain(spec, r)
  if (drained.landed.length > 0) lines.push(`Ship · landed ${drained.landed.map(id => `Ticket ${id}`).join(', ')} (merged --no-ff, Proof: green, ticked).`)
  if (drained.kind === 'halt') {
    r.halt = drained.message
    return save(note([...lines, `Ship · stopped: ${firstLine(drained.message)}`].join(' ')))
  }
  if (drained.kind === 'conflict') {
    return save(note(`Ship · merge conflict landing Ticket ${r.conflict?.ticket ?? ''} (${drained.files.join(', ')}); the merge stays in progress. Dispatch one subagent now: ${dispatchLine(drained.call)}`))
  }
  // Nothing new while a sibling is out or failed (the Stop hook stops on a failure).
  const live = Object.values(r.landing ?? {}).some(record => record.state === 'dispatched' || record.state === 'failed')
  if (!live && parseShipBlocker(spec.markdown) === undefined) {
    const next = claimWave(spec, r, true)
    if (next.calls.length > 0) {
      const message = [...lines, `Dispatch now, in one step: ${next.calls.map(dispatchLine).join(' ')}`].join(' ')
      if (message.length <= NOTE_CHARS) return save(note(message))
      lines.push(`Ship · ${next.calls.map(call => text(call.description).replace(/^Ship /u, '')).join(', ')} claimed; the runner lists the subagent calls when this step ends.`)
    }
  }
  return save(lines.length === 0 ? OK : note(lines.join(' ')))
}

/**
 * A parent `subagent` call failed or was cancelled (`PostToolUseFailure`).
 * Its side effects are unknown: nothing is merged or ticked, the Claim stays,
 * and a conflict merge it was resolving is rolled back.
 */
export function onShipSubagentFailure(input: ShipHookInput, state: ShipRunState): ShipHookOutput {
  if (!landPhase(state)) return OK
  const role = subagentRole(input)
  const spec = loadSpec(state)
  if (role === undefined || spec === undefined) return OK
  const r = runner(state)
  const result = text(input.payload.tool_response ?? input.payload.toolResult)
  if ('conflict' in role) {
    if (r.conflict?.ticket !== role.conflict) return OK
    r.halt = interruptConflict(spec, r, 'The conflict-resolution child failed or was cancelled.') ?? 'The conflict-resolution child failed or was cancelled.'
  } else {
    ;(r.landing ??= {})[role.ticket] = {
      state: 'failed',
      note: result.replace(/\s+/gu, ' ').slice(0, 300),
      ...recordWorktree(parseWorktreeNote(result)),
    }
  }
  writeRunState(input.dataDir, state)
  return OK
}

// ---------------------------------------------------------------- Stop

/** Stop /ship: the turn continues once so the model reports, then ends. */
function halt(input: ShipHookInput, state: ShipRunState, message: string): ShipHookOutput {
  state.active = false
  delete runner(state).halt
  writeRunState(input.dataDir, state)
  return continueWith(
    `Ship runner stopped /ship:\n${message}\n\nTell the user this in one or two sentences, then end your turn. Do not edit files or call tools; the user resumes with /ship after fixing it.`,
    `Ship · stopped: ${firstLine(message)}`,
  )
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** The runner-owned context of the legacy injection: track, Mission Contract, requirement, spec. */
function phaseContext(spec: Spec): { track?: string; mission?: string; originalRequirement?: string; specPath: string } {
  const snapshot = readShipSnapshot(spec.path)
  const sealed = !isShipSnapshotError(snapshot) && snapshot?.trackSealed === true ? snapshot.mainTrack : undefined
  const track = sealed ?? parseMainTrack(spec.markdown)
  const contract = readContract(spec)
  const original = parseOriginalRequirement(spec.markdown)
  return {
    ...(track === undefined || track.trim() === '' ? {} : { track: clip(track.trim(), 1500) }),
    ...(contract === undefined ? {} : { mission: clip(missionContractSummary(contract, display(spec.cwd, missionContractPath(spec.cwd, spec.slug))), 1500) }),
    ...(original === undefined ? {} : { originalRequirement: original }),
    specPath: display(spec.cwd, spec.path),
  }
}

/** Continue the turn with the next phase contract. */
function injectPhase(input: ShipHookInput, state: ShipRunState, spec: Spec, kind: ShipPhaseKind, verificationOnly = false): ShipHookOutput {
  const r = runner(state)
  r.phase = kind
  r.injected = true
  r.hitl = false
  if (verificationOnly) r.verifying = true
  writeRunState(input.dataDir, state)
  const label = verificationOnly ? 'final verification' : kind
  return continueWith(
    shipContinuationFor(spec.status, { ...phaseContext(spec), ...(verificationOnly ? { verificationOnly: true } : {}) }),
    `Ship · continuing: ${label} (Status: ${spec.status ?? 'none'})`,
  )
}

function resolverContinuation(input: ShipHookInput, state: ShipRunState, call: Record<string, unknown>, files: readonly string[]): ShipHookOutput {
  writeRunState(input.dataDir, state)
  return continueWith(
    `Ship runner: a landing merge conflicted (${files.join(', ')}). The merge stays in progress in this tree. Call the subagent tool once now with exactly these arguments (no worktree isolation: the child resolves the conflict in place). Do not resolve it yourself.\n\n${dispatchLine(call)}`,
    `Ship · merge conflict: dispatching conflict resolution (${files.join(', ')})`,
  )
}

/** Land phase at Stop: drain, then dispatch the next wave, verify, or stop. */
function landingStop(input: ShipHookInput, state: ShipRunState, spec: Spec): ShipHookOutput {
  const r = runner(state)
  const plan = landingPlan(spec.markdown)
  if (plan.tickets.length === 0) return halt(input, state, 'Approved ship plan has no tickets. Stopped; restore ## Plan.')
  const lines = plan.tickets.map(ticket => ticket.contract)
  if (r.plan === undefined) r.plan = lines
  else if (r.plan.length !== lines.length || r.plan.some((line, index) => line !== lines[index])) {
    return halt(input, state, 'Approved ship plan changed during a ticket turn. Stopped; restore the approved plan.')
  }
  if (r.conflict !== undefined) {
    const rolled = interruptConflict(spec, r, 'The conflict-resolution subagent was never called.')
    return halt(input, state, rolled ?? 'A conflict resolution was left unfinished. Stopped.')
  }
  const failed = Object.entries(r.landing ?? {}).filter(([, record]) => record.state === 'failed')
  if (failed.length > 0) {
    for (const [id] of failed) delete r.landing?.[id]
    return halt(input, state, `Landing child failed or was cancelled: ${failed.map(([id, record]) => `Ticket ${id}${record.worktree === undefined ? '' : ` (worktree ${record.worktree} kept, not merged)`}${record.note === undefined ? '' : ` — ${clip(record.note, 160)}`}`).join('; ')}. Its side effects are unknown, so nothing was merged or ticked. Stopped; inspect it, then resume with /ship to dispatch it again.`)
  }
  const drained = drain(spec, r)
  if (drained.kind === 'halt') return halt(input, state, drained.message)
  if (drained.kind === 'conflict') return resolverContinuation(input, state, drained.call, drained.files)
  spec.markdown = read(spec.path) ?? spec.markdown
  spec.status = parseShipStatus(spec.markdown)
  const blocker = parseShipBlocker(spec.markdown)
  if (blocker !== undefined) return halt(input, state, `Ship has an unresolved ## Blocker. Stopped; resolve it before resuming.\n${clip(blocker.trim(), 600)}`)
  const current = landingPlan(spec.markdown)
  if (current.tickets.every(ticket => ticket.done)) {
    if (r.verifying === true) {
      writeRunState(input.dataDir, state)
      return OK
    }
    return injectPhase(input, state, spec, 'land', true)
  }
  if (Object.values(r.landing ?? {}).some(record => record.state === 'finished')) {
    // Finished but not yet mergeable (an earlier sibling is still out): wait.
    writeRunState(input.dataDir, state)
    return OK
  }
  const next = claimWave(spec, r, false)
  if (next.stray !== undefined) {
    return halt(input, state, `Landing needs a clean working tree before tickets branch off, but these files changed outside the Ship records: ${clip(next.stray.join(', '), 400)}. Stopped; commit or stash them, then resume with /ship.`)
  }
  if (next.calls.length === 0) {
    const stuck = Object.entries(r.landing ?? {}).filter(([, record]) => record.state === 'dispatched').map(([id]) => `Ticket ${id}`)
    return halt(input, state, stuck.length > 0
      ? `${stuck.join(', ')} ${stuck.length === 1 ? 'was' : 'were'} dispatched ${String(REDISPATCH_LIMIT)} times without a subagent result. Stopped; check /worktree list, then resume with /ship.`
      : current.error ?? 'No unblocked ticket remains; resolve the dependency cycle.')
  }
  writeRunState(input.dataDir, state)
  return continueWith(dispatchText(spec, r, next.calls, next.notices), `Ship · landing: dispatching ${next.calls.map(call => text(call.description).replace(/^Ship /u, '')).join(', ')}`)
}

type Delivered = { kind: 'done'; message: string } | { kind: 'conflict'; call: Record<string, unknown>; files: string[] } | { kind: 'halt'; message: string }

/** Merge back: fast-forward when possible, else squash under the host author. */
function deliver(spec: Spec, r: ShipRunnerState): Delivered {
  const meta = parseSpecMetadata(spec.markdown)
  const original = meta.originalBranch
  const feature = meta.branch ?? `ship/${spec.slug}`
  if (original === undefined || original === '') return { kind: 'done', message: 'No Original-Branch is recorded, so nothing was merged back.' }
  commitRecords(spec, 'ship: records before merge-back')
  const stray = strayChanges(spec)
  if (stray.length > 0) return { kind: 'halt', message: `Merge-back needs a clean working tree; these files changed: ${clip(stray.join(', '), 300)}. Stopped; keep ${feature}.` }
  if (git(spec.cwd, ['checkout', '-q', original]).code !== 0) return { kind: 'halt', message: `Merge-back could not check out Original-Branch ${original}. Stopped; keep ${feature}.` }
  const pre = git(spec.cwd, ['rev-parse', 'HEAD']).stdout.trim()
  if (git(spec.cwd, ['merge', '--ff-only', '-q', feature]).code === 0) return { kind: 'done', message: `Merge back fast-forwarded ${original} to ${feature}.` }
  const line = (parseOriginalRequirement(spec.markdown) ?? '').split(/\r\n|[\r\n]/u).map(part => part.trim()).find(part => part !== '')
  const squashMessage = line ?? basename(spec.path, '.md')
  const squash = git(spec.cwd, ['merge', '--squash', feature])
  if (squash.code !== 0) {
    const started = startConflict(spec, r, undefined, squash.output, squashMessage)
    if ('message' in started) return { kind: 'halt', message: started.message }
    return { kind: 'conflict', call: started.call, files: started.files }
  }
  if (gitAsHost(spec.cwd, ['commit', '-q', '-m', squashMessage]).code !== 0) {
    if (pre !== '') git(spec.cwd, ['reset', '--hard', pre])
    git(spec.cwd, ['checkout', '-q', feature])
    return { kind: 'halt', message: `Merge-back squash commit failed. Original-Branch reset; ${feature} kept.` }
  }
  return { kind: 'done', message: `Merge back squashed ${feature} onto ${original} as "${squashMessage}".` }
}

function shipped(input: ShipHookInput, state: ShipRunState, message: string): ShipHookOutput {
  state.active = false
  const r = runner(state)
  r.complete = true
  delete r.delivered
  delete r.halt
  writeRunState(input.dataDir, state)
  return continueWith(
    `Ship runner: /ship is complete. ${message}\n\nTell the user in two or three sentences what shipped, then end your turn. Do not edit files or call tools.`,
    `Ship · shipped: ${firstLine(message)}`,
  )
}

/** Status reached shipped: check the plan, the Blocker, the evidence, then merge back. */
function finishShip(input: ShipHookInput, state: ShipRunState, spec: Spec, resumed: boolean): ShipHookOutput {
  const r = runner(state)
  const plan = landingPlan(spec.markdown)
  const allDone = plan.tickets.length > 0 && plan.tickets.every(ticket => ticket.done)
  if ((!resumed && r.verifying !== true) || !allDone || parseShipBlocker(spec.markdown) !== undefined) {
    return halt(input, state, 'Ship may finish only in a separate final verification turn after every ticket is checked. Stopped; restore Status: landing.')
  }
  const contract = readContract(spec)
  const verdict = contract === undefined ? undefined : verifyAcceptance(contract, parseEvidenceFromSpec(spec.markdown))
  if (verdict?.satisfied !== true) {
    writeFileSync(spec.path, spec.markdown.replace(/^Status:\s*shipped\b/imu, 'Status: landing'))
    r.verifying = false
    const missing = verdict === undefined ? 'no sealed Mission Contract' : verdict.notes.filter(item => !item.endsWith('satisfied')).join('; ')
    return halt(input, state, `Verifier: acceptance evidence incomplete (${clip(missing, 300)}). Delivery blocked; restore proof evidence before resuming.`)
  }
  const delivered = deliver(spec, r)
  if (delivered.kind === 'halt') return halt(input, state, delivered.message)
  if (delivered.kind === 'conflict') {
    writeRunState(input.dataDir, state)
    return continueWith(
      `Ship runner: Merge-back conflicted (${delivered.files.join(', ')}). The squash stays in progress on Original-Branch. Call the subagent tool once now with exactly these arguments (no worktree isolation). Do not resolve it yourself.\n\n${dispatchLine(delivered.call)}`,
      `Ship · Merge-back conflict: dispatching conflict resolution (${delivered.files.join(', ')})`,
    )
  }
  return shipped(input, state, delivered.message)
}

/**
 * `Stop`: the phase loop. Prints nothing unless it continues the turn: a
 * Stop note without a continuation would make the host take another step.
 */
export function onShipStop(input: ShipHookInput, state: ShipRunState | undefined, sessionId: string): ShipHookOutput {
  if (state === undefined || !state.active || state.sessionId !== sessionId) return OK
  if (text(input.payload.permissionMode) === 'plan') return OK
  const r = runner(state)
  if (r.halt !== undefined) return halt(input, state, r.halt)
  if (r.delivered !== undefined) return shipped(input, state, r.delivered)
  if (state.specPath === undefined) {
    const specs = unfinishedSpecs(state.cwd)
    if (specs.length > 1) return halt(input, state, SHIP_AMBIGUOUS_SPECS)
    if (specs.length === 1 && specs[0] !== undefined) {
      const error = adoptSpec(state.cwd, specs[0], state.idea ?? '', state)
      if (error !== undefined) return halt(input, state, error)
    }
  }
  const error = guard(state)
  if (error !== undefined) return halt(input, state, error)
  const spec = loadSpec(state)
  if (spec === undefined) {
    writeRunState(input.dataDir, state)
    return OK
  }
  const kind = shipPhaseKind(spec.status)
  const previous = r.phase ?? kind
  const hitl = r.hitl === true
  const stopAnswer = r.stopAnswer === true
  r.hitl = false
  r.stopAnswer = false
  const blocker = parseShipBlocker(spec.markdown)
  if (blocker !== undefined) return halt(input, state, `Ship has an unresolved ## Blocker. Stopped; resolve it before resuming.\n${clip(blocker.trim(), 600)}`)
  if (stopAnswer) {
    state.active = false
    writeRunState(input.dataDir, state)
    return OK
  }
  if (r.injected !== true) {
    // A bare /ship resumed a later phase: inject it (or land / deliver).
    if (kind === 'done') return finishShip(input, state, spec, true)
    if (kind === 'land') {
      r.injected = true
      r.phase = 'land'
      return landingStop(input, state, spec)
    }
    return injectPhase(input, state, spec, kind)
  }
  if (kind !== previous) {
    if (previous === 'land' && kind === 'done') return finishShip(input, state, spec, false)
    if (PHASE_RANK[kind] !== PHASE_RANK[previous] + 1) {
      return halt(input, state, `Invalid ship phase transition: ${previous} → ${kind}. Stopped; restore the last approved phase.`)
    }
    if (kind === 'land') {
      r.phase = 'land'
      return landingStop(input, state, spec)
    }
    return injectPhase(input, state, spec, kind)
  }
  if (kind === 'land') return landingStop(input, state, spec)
  if (hitl && (kind === 'wayfinder' || kind === 'grill')) return injectPhase(input, state, spec, kind)
  writeRunState(input.dataDir, state)
  return OK
}
