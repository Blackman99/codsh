/**
 * One `/ship` run: the spec file is memory, Chrome follows it, and each
 * turn injects only the phase Status names.
 *
 * The runner calls {@link ShipRun.run} for the canned command, {@link
 * ShipRun.noteWritten} when a tool writes markdown, and {@link ShipRun.abort}
 * on Esc. Chip, plan, poll, occupancy, the goals port, and phase injection
 * stay behind this seam.
 * @module codsh-bundle/src/ship-run
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { activeTicketBrief, parseMainTrack, parseOriginalRequirement, parsePlan, parseShipBlocker, parseShipStatus, parseSpecMetadata, pickLiveShip, planInFlight, plansEqual } from './plan.ts'
import { landingPlan, sameLandingPlan } from './ship-landing.ts'
import type { Plan, ShipSpecFile } from './plan.ts'
import { expandTemplate } from './custom-commands.ts'
import type { SelectAsk } from './questions.ts'
import {
  classifyPath,
  compileMissionContract,
  mainTrackDrifted,
  missionContractPath,
  missionContractSummary,
  protectedSectionsChanged,
  readMissionContract,
  slugFromSpec,
  writeAllowed,
  writeMissionContract,
} from './mission.ts'
import type { MissionContract } from './mission.ts'
import { alignAction, descriptorFromToolCall, isMutatingTool, proposeSpecMarkdown } from './align.ts'
import type { ActionDescriptor, AlignVerdict } from './align.ts'
import { detectDrift, DRIFT_FLASH_AT } from './drift.ts'
import type { DriftReport } from './drift.ts'
import { parseEvidenceFromSpec, reconcilePlanTicks, verifyAcceptance } from './verify.ts'
import type { VerifyVerdict } from './verify.ts'
import { shipPhaseKind, shipPromptFor } from './ship.ts'
import type { ShipPhaseKind } from './ship.ts'
import { sameShipChip, shipChipFromSpec } from './status.ts'
import type { ShipChip } from './status.ts'
import {
  freezeEqual,
  freezeText,
  headedMainTrack,
  initialShipSnapshot,
  isShipSnapshotError,
  readShipSnapshot,
  sealOriginalIfNeeded,
  sealTrackIfNeeded,
  validateSnapshotAgainstSpec,
  writeShipSnapshot,
} from './ship-snapshot.ts'
import type { ShipSnapshot } from './ship-snapshot.ts'

/** How long a land-ok flash or the done chip stays before the next paint. */
const SHIP_CHIP_FLASH_MS = 400
/** How often Chrome re-reads the spec while a run is in flight. */
const SHIP_POLL_MS = 1000

/** Chrome the run paints into. Plan and chip are the only facts it owns. */
export interface ShipChrome {
  setPlan(plan: Plan | undefined): void
  setChip(chip: ShipChip | undefined): void
  setTodos?(): void
}

/** Durable phase the session compass reports. */
export type ShipGoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** Whether the harness round driver may continue this compass. */
export type ShipGoalActivation = 'armed' | 'disarmed'

/**
 * One session compass, as the runner sees it. Ids and phases are strings so
 * the host goal service type never enters this module.
 */
export interface ShipGoal {
  id: string
  objective: string
  phase: ShipGoalPhase
  activation: ShipGoalActivation
}

/**
 * Narrow goals port the runner owns. Missing or throwing degrades to
 * spec+prepend; the composition root wraps `ctx.goals` when present.
 */
export interface ShipGoals {
  get(): Promise<ShipGoal | undefined>
  create(objective: string): Promise<ShipGoal>
  edit(id: string, objective: string): Promise<ShipGoal>
  pause(id: string): Promise<ShipGoal>
  resume(id: string): Promise<ShipGoal>
  complete(id: string): Promise<ShipGoal>
  clear(id: string): Promise<void>
}

/** Compare-and-set identity the host mutations require. */
export interface HostGoalRef {
  id: string
  revision: number
}

/**
 * Host goal service as the composition root sees it. Duck-typed so the
 * bundle never depends on `@deepseek-ai/dsh-goal`.
 */
export interface HostGoalsService {
  get(agent: unknown): HostGoalView | undefined
  create(agent: unknown, request: { objective: string }): HostGoalView
  edit(agent: unknown, ref: HostGoalRef, request: { objective?: string }): HostGoalView
  pause(agent: unknown, ref: HostGoalRef): HostGoalView
  resume(agent: unknown, ref: HostGoalRef): HostGoalView
  complete(agent: unknown, ref: HostGoalRef): HostGoalView
  clear(agent: unknown, ref: HostGoalRef): unknown
}

/** One host view; extra fields (rounds) are ignored. */
export interface HostGoalView {
  id: string
  objective: string
  phase: ShipGoalPhase
  activation: ShipGoalActivation
  revision: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional host goals service; duck-typed, never imported from dsh-goal. */
    goals?: HostGoalsService
  }
}

/** Project a host view onto the runner's narrow compass. */
const asShipGoal = (view: HostGoalView): ShipGoal => ({
  id: view.id,
  objective: view.objective,
  phase: view.phase,
  activation: view.activation,
})

/**
 * Wrap a present host goals service. The runner never sees the host type.
 * @param host - `ctx.goals` duck-typed, without a package import.
 * @param agent - the live agent the host mutations apply to.
 */
export function wrapHostGoals(host: HostGoalsService, agent: () => unknown): ShipGoals {
  const refFor = (id: string): HostGoalRef => ({
    id,
    revision: host.get(agent())?.revision ?? 0,
  })
  return {
    async get() {
      const view = host.get(agent())
      return view === undefined ? undefined : asShipGoal(view)
    },
    async create(objective) {
      return asShipGoal(host.create(agent(), { objective }))
    },
    async edit(id, objective) {
      return asShipGoal(host.edit(agent(), refFor(id), { objective }))
    },
    async pause(id) {
      return asShipGoal(host.pause(agent(), refFor(id)))
    },
    async resume(id) {
      return asShipGoal(host.resume(agent(), refFor(id)))
    },
    async complete(id) {
      return asShipGoal(host.complete(agent(), refFor(id)))
    },
    async clear(id) {
      host.clear(agent(), refFor(id))
    },
  }
}

/** Selector the occupancy ask uses; absent on a pipe, which auto-Replaces. */
export type OccupancyAsk = SelectAsk

/** Flash that `/goal` was not updated when the harness half degrades. */
export type ShipFlash = (text: string) => void

/** Optional ports the composition root wires: goals, occupancy, flash. */
export interface ShipPorts {
  goals?: ShipGoals
  occupancy?: OccupancyAsk
  /** Choose among unfinished specs; falls back to occupancy with a distinct title. */
  selectSpec?: OccupancyAsk
  flash?: ShipFlash
  /** True while plan mode is holding; the runner stays read-only. */
  isPlanMode?: () => boolean
}

/** Occupancy Selector title/header — a Selector, not a ship gate modal. */
export const SHIP_OCCUPANCY_TITLE = 'ship · occupancy'

/** Spec-choice Selector title — distinct from occupancy. */
export const SHIP_SELECT_SPEC_TITLE = 'ship · spec'

/** Prefix that marks a session compass as ours. */
const SHIP_OBJECTIVE_PREFIX = '[ship] '

/** Flash when the harness compass cannot be updated. */
const GOAL_DEGRADED = '/goal was not updated'

/** Flash when a legacy spec is inferred rather than historically sealed. */
const LIMITED_HISTORY = 'No saved ship snapshot: using the current spec as the comparison baseline. Earlier history cannot be verified.'

/** Flash when several unfinished specs exist and nothing can choose. */
const AMBIGUOUS_SPECS = 'Multiple unfinished specs found. Choose one on a TTY; a pipe cannot pick arbitrarily. Stopped.'

/** Flash when a bare resume has nothing to bind as the objective. */
const NO_OBJECTIVE = 'No original requirement could be recovered. Stopped; type the one-sentence requirement or restore the spec.'

/** Phase order the runner may advance; anything else is a skip or a back-step. */
const PHASE_RANK: Record<ShipPhaseKind, number> = {
  wayfinder: 0,
  grill: 1,
  spec: 2,
  tickets: 3,
  land: 4,
  done: 5,
}

/** Mission Contract checks complement the original-requirement snapshot. */
const ALIGN_DENIED = 'Alignment Gate denied write — sealed Mission Contract holds'
const DRIFT_FLASH = 'Mission drift detected — review plan against sealed contract'
const VERIFY_INCOMPLETE = 'Verifier: acceptance evidence incomplete — plan ticks reconciled'

/** Optional report from one canned-command turn. Absent or void is idle-stop. */
export interface ShipTurnResult {
  /** True when grill, wayfinder, or preflight HITL settled this turn. */
  hitl?: boolean
}

/** What the runner must do to spend a canned-command turn. */
export interface ShipTurn {
  (prompt: string): Promise<void | ShipTurnResult>
}

/**
 * One `/ship` run against a workspace.
 *
 * Construction is cheap; {@link ShipRun.run} is the canned command. Disk
 * reads stay inside the module (in-process filesystem, no port).
 */
export class ShipRun {
  private readonly writtenDocs: string[] = []
  private readonly knownSnapshots = new Map<string, ShipSnapshot>()
  private plan: Plan | undefined
  private chip: ShipChip | undefined
  private lastDone: number | undefined
  private chipCleared = false
  private flashTimer: ReturnType<typeof setTimeout> | undefined
  private watch: ReturnType<typeof setInterval> | undefined
  private advance: AbortController | undefined
  private goalId: string | undefined
  /** Process snapshot of `## Main Track` captured at Confirm; later injects prepend this, not a live reread. */
  private sealedTrack: string | undefined
  /** Sealed Mission Contract compiled at Confirm; control-plane memory for later phases. */
  private sealedContract: MissionContract | undefined
  /** Absolute path of the sealed mission.contract.json, when written. */
  private sealedContractPath: string | undefined
  /** Recent aligned actions for drift scans (capped). */
  private recentActions: ActionDescriptor[] = []
  /** Last drift report, for tests and chrome. */
  private lastDrift: DriftReport | undefined
  /** Last verifier verdict, for tests. */
  private lastVerify: VerifyVerdict | undefined
  /** Spec this run is following; complete only if this file becomes shipped. */
  private followedSpec: string | undefined
  /** Adjacent freeze for the bound spec; status, track, and original come from it. */
  private snapshot: ShipSnapshot | undefined
  /** Recovered original wording this run injects; never emptied on a resume. */
  private originalRequirement: string | undefined
  /** Typed idea this run started with; a conflicting resume must not overwrite the freeze. */
  private typedIdea = ''
  /** True once freeze validation failed; later phases and goal completion stay off. */
  private contractInvalid = false
  /** True when the current turn threw or aborted before a legal complete. */
  private halted = false
  /** Unfinished specs this run must not jump to. */
  private ignoredSpecs = new Set<string>()

  constructor(
    private readonly cwd: string,
    private readonly chrome: ShipChrome,
    private readonly ports: ShipPorts = {},
  ) {}

  /** The MetaBar chip Chrome should paint, absent when `/ship` is idle. */
  get shipChip(): ShipChip | undefined {
    return this.chip
  }

  /** The pinned plan, absent before tickets exist or after shipped. */
  get shipPlan(): Plan | undefined {
    return this.plan
  }

  /** Sealed Mission Contract for this run, absent before Confirm. */
  get missionContract(): MissionContract | undefined {
    return this.sealedContract
  }

  /** Absolute path of mission.contract.json when the runner wrote one. */
  get missionContractFile(): string | undefined {
    return this.sealedContractPath
  }

  /** Latest drift report from a sealed run, if any. */
  get driftReport(): DriftReport | undefined {
    return this.lastDrift
  }

  /** Latest verifier verdict, if any. */
  get verifyVerdict(): VerifyVerdict | undefined {
    return this.lastVerify
  }

  /**
   * Note markdown the agent wrote, so the live spec can be found later.
   * @param paths - paths the event reported writing.
   */
  noteWritten(paths: readonly string[]): void {
    for (const path of paths) {
      if (!path.endsWith('.md')) continue
      const already = this.writtenDocs.indexOf(path)
      if (already >= 0) this.writtenDocs.splice(already, 1)
      this.writtenDocs.unshift(path)
    }
    this.guardWrites(paths)
    if (paths.some(path => path.endsWith('.md'))) this.refresh()
    this.scanDrift()
    this.verifyAndReconcile(false)
  }

  /**
   * Alignment Gate for one action descriptor. Public so the surface can refuse
   * a tool before it runs; also used for write-path guards.
   */
  align(descriptor: ActionDescriptor): AlignVerdict {
    const ticket = this.currentTicket()
    const verdict = alignAction(descriptor, {
      ...(this.sealedContract === undefined ? {} : { contract: this.sealedContract }),
      sealed: this.sealedContract !== undefined,
      ...(ticket === undefined ? {} : { activeTicket: ticket }),
    })
    this.rememberAction(descriptor)
    return verdict
  }

  /**
   * Build + align a tool call before it runs (`tools/pre-execute`).
   * Land turns auto-fill Active Ticket Track→REQ supports when the model
   * omitted them, so legitimate ticket writes are not fail-closed as unmapped.
   */
  alignTool(toolName: string, args: unknown): AlignVerdict {
    const ticket = this.currentTicket()
    const supports = this.activeTicketSupports(ticket)
    let descriptor = descriptorFromToolCall(toolName, args, {
      ...(supports === undefined ? {} : { supports }),
      ...(ticket === undefined ? {} : { task: ticket.title }),
    })
    const section = this.protectedSectionFromTool(toolName, args, descriptor.path)
    if (section !== undefined) {
      descriptor = { ...descriptor, section }
    }
    return this.align(descriptor)
  }

  /**
   * Compare a mutating write/edit of the live ship spec against protected
   * headings. Auto-filled supports must not let Out of Scope / Grill / etc.
   * rewrites through as a mutable path.
   */
  private protectedSectionFromTool(
    toolName: string,
    args: unknown,
    path: string | undefined,
  ): string | undefined {
    if (!isMutatingTool(toolName) || path === undefined || !/\.md$/iu.test(path)) return undefined
    const specPath = this.followedSpec
    if (specPath === undefined) return undefined
    const norm = (value: string): string => value.replace(/\\/gu, '/')
    const np = norm(path)
    const ns = norm(specPath)
    const base = ns.split('/').pop() ?? ''
    const same = np === ns || ns.endsWith(np) || np.endsWith(ns) || (base !== '' && np.endsWith(`/${base}`))
    if (!same) return undefined
    let current: string | undefined
    try {
      current = readFileSync(specPath, 'utf8')
    } catch {
      current = undefined
    }
    const proposed = proposeSpecMarkdown(args, current)
    if (proposed === undefined) return undefined
    if (parseShipStatus(proposed) === 'shipped' && this.sealedContract !== undefined) {
      if (this.currentTicket() !== undefined || landingPlan(proposed).active !== undefined) return 'Acceptance Criteria'
      if (this.sealedContract.acceptance.length > 0 && !verifyAcceptance(this.sealedContract, parseEvidenceFromSpec(proposed)).satisfied) return 'Acceptance Criteria'
    }
    const sealedFallback = this.sealedContract === undefined
      ? ''
      : `## Main Track\n\n${this.sealedContract.mainTrackMarkdown}\n`
    const before = current ?? sealedFallback
    const changed = protectedSectionsChanged(before, proposed)
    return changed[0]
  }

  /** Re-read the live spec so the plan row and chip match the file on disk. */
  refresh(): void {
    const files: ShipSpecFile[] = []
    if (this.followedSpec !== undefined) {
      try {
        const markdown = readFileSync(this.followedSpec, 'utf8')
        files.push({
          path: this.followedSpec,
          markdown,
          sessionWrite: true,
        })
      } catch {
        return
      }
    } else {
      for (const path of this.specPaths()) {
        if (this.ignoredSpecs.has(resolve(path))) continue
        try {
          files.push({
            path,
            markdown: readFileSync(path, 'utf8'),
            sessionWrite: this.writtenDocs.includes(path),
          })
        } catch {
          // A spec that moved or will not read is simply not the progress.
        }
      }
    }
    const picked = pickLiveShip(files)
    if (picked === undefined) return
    const live = planInFlight(picked.markdown, picked.plan)
    const next = live ? picked.plan : undefined
    if (!plansEqual(this.plan, next)) {
      this.plan = next
      this.chrome.setPlan(next)
    }
    this.adoptChip(picked.markdown, picked.plan)
  }

  /** Stop the phase loop and the spec poll. */
  abort(): void {
    this.halted = true
    this.advance?.abort()
    this.stopWatch()
  }

  /**
   * Run the canned `/ship` command: inject the current phase, then the next
   * when Status advances or grill/wayfinder/preflight HITL settled, until
   * unchanged idle status, done, or Esc.
   * @param idea - the typed one-sentence requirement.
   * @param turn - spends one canned-command turn.
   */
  async run(idea: string, turn: ShipTurn): Promise<void> {
    this.advance?.abort()
    this.chipCleared = false
    this.lastDone = undefined
    this.goalId = undefined
    this.sealedTrack = undefined
    this.sealedContract = undefined
    this.sealedContractPath = undefined
    this.recentActions = []
    this.lastDrift = undefined
    this.lastVerify = undefined
    this.followedSpec = undefined
    this.snapshot = undefined
    this.originalRequirement = undefined
    this.typedIdea = idea
    this.contractInvalid = false
    this.halted = false
    this.ignoredSpecs = new Set()
    this.startWatch()
    this.refresh()
    if (this.chip === undefined) this.setChip({ kind: 'wayfinder' })
    const advance = new AbortController()
    this.advance = advance
    try {
      if (this.inPlanMode()) {
        await this.runPlanMode(idea, turn)
        return
      }
      if (!await this.bindSpec(idea)) return
      if (!await this.occupy(idea)) return
      this.persistSnapshot()
      if (!this.guardContract()) return
      let previous = shipPhaseKind(this.status())
      await this.syncCompass()
      if (previous === 'land') { await this.runLanding(turn); return }
      let hitl = await this.spendTurn(turn)
      while (!advance.signal.aborted && !this.contractInvalid && !this.halted) {
        if (this.inPlanMode()) { this.halted = true; break }
        this.refresh()
        this.discoverBoundSpec()
        this.persistSnapshot()
        if (!this.guardContract()) break
        await this.syncCompass()
        const next = shipPhaseKind(this.status())
        if (next !== previous) {
          if (!this.mayAdvance(previous, next)) break
        } else if (!this.mayContinueHitl(hitl, next)) {
          break
        }
        previous = next
        if (next === 'land') { await this.runLanding(turn); break }
        hitl = await this.spendTurn(turn)
      }
    } catch (error) {
      this.halted = true
      throw error
    } finally {
      if (this.advance === advance) {
        this.advance = undefined
        this.stopWatch()
        this.refresh()
        if (
          !advance.signal.aborted
          && !this.halted
          && !this.contractInvalid
          && !this.inPlanMode()
          && this.followedIsShipped()
        ) {
          await this.completeShipGoal()
        }
      }
    }
  }

  /**
   * Take the session compass before the first phase turn. Missing or throwing
   * goals degrade; a stranger is paused then asked; ours is reused.
   * A conflicting typed idea never silently rewrites a saved original.
   * @param idea - the typed one-sentence requirement.
   * @returns false when occupancy Abort stops the run without injecting.
   */
  private async occupy(idea: string): Promise<boolean> {
    if (this.followedSpec === undefined && this.placeholderObjective(idea) === undefined) return true
    if (this.ports.goals === undefined) {
      this.degrade()
      return true
    }
    try {
      const current = await this.ports.goals.get()
      const objective = this.placeholderObjective(idea)
      if (current === undefined || current.phase === 'complete') {
        if (objective === undefined) {
          this.degrade()
          return true
        }
        await this.createPlaceholder(objective)
        return true
      }
      if (this.ours(current)) {
        if (objective !== undefined) await this.ports.goals.edit(current.id, objective)
        await this.ports.goals.pause(current.id)
        this.goalId = current.id
        return true
      }
      await this.ports.goals.pause(current.id)
      const choice = await this.askOccupancy()
      if (choice === 'abort') {
        try {
          await this.ports.goals.resume(current.id)
        } catch {
          this.degrade()
        }
        return false
      }
      await this.ports.goals.clear(current.id)
      if (objective === undefined) {
        this.degrade()
        return true
      }
      await this.createPlaceholder(objective)
      return true
    } catch {
      this.degrade()
      return true
    }
  }

  /** `[ship]` plus recovered original; never `[ship]` empty on a bare resume. */
  private placeholderObjective(idea: string): string | undefined {
    const recovered = freezeText(this.originalRequirement ?? idea)
    return recovered === '' ? undefined : `${SHIP_OBJECTIVE_PREFIX}${recovered}`
  }

  /** Pause-then-ask: TTY Selector, cancel/Esc = Abort, absent ask = Replace. */
  private async askOccupancy(): Promise<'replace' | 'abort'> {
    const ask = this.ports.occupancy
    if (ask === undefined) return 'replace'
    try {
      const outcome = await ask({
        title: SHIP_OCCUPANCY_TITLE,
        options: [{ label: 'Replace' }, { label: 'Abort' }],
      }, this.advance?.signal)
      if (outcome.kind === 'chosen' && outcome.indices[0] === 0) return 'replace'
      return 'abort'
    } catch {
      return 'abort'
    }
  }

  /** Create `[ship] <objective>` then pause before the first turn is awaited. */
  private async createPlaceholder(objective: string): Promise<void> {
    const goals = this.ports.goals
    if (goals === undefined) return
    try {
      const created = await goals.create(objective)
      await goals.pause(created.id)
      this.goalId = created.id
    } catch {
      this.degrade()
    }
  }

  /** Flash that `/goal` was not updated; the spec+prepend path still binds. */
  private degrade(): void {
    this.ports.flash?.(GOAL_DEGRADED)
  }

  /** Ours: spec Goal-Id match, or an objective that already starts with `[ship]`. */
  private ours(goal: ShipGoal): boolean {
    if (goal.objective.startsWith(SHIP_OBJECTIVE_PREFIX.trimEnd())) return true
    const specId = this.specGoalId()
    return specId !== undefined && specId === goal.id
  }

  private specGoalId(): string | undefined {
    const markdown = this.followedMarkdown()
    return markdown === undefined ? undefined : parseSpecMetadata(markdown).goalId
  }

  /**
   * Keep the session compass on the current track and disarmed. Missing or
   * throwing goals degrade; the spec+prepend path still binds.
   */
  private async syncCompass(): Promise<void> {
    const goals = this.ports.goals
    if (goals === undefined || this.goalId === undefined) return
    try {
      const current = await goals.get()
      if (current === undefined || current.id !== this.goalId) return
      const objective = this.compassObjective()
      let mutated = false
      if (objective !== undefined && current.objective !== objective) {
        await goals.edit(current.id, objective)
        mutated = true
      }
      if (mutated || current.activation === 'armed' || current.phase !== 'paused') {
        await goals.pause(current.id)
      }
    } catch {
      this.degrade()
    }
  }

  /**
   * `[ship]` plus the compact track. Absent a track, leave the placeholder
   * `[ship] <idea>` alone so the first grill inject does not clobber it.
   */
  private compassObjective(): string | undefined {
    const track = this.trackForPrompt()
    return track === undefined ? undefined : `${SHIP_OBJECTIVE_PREFIX}${track}`
  }

  /**
   * Phase prompt plus original, bound path, and Main Track. Workflow templates
   * expand before user/spec data, so a literal `$ARGUMENTS` in the requirement
   * is not substituted. After Confirm the track is the snapshot, not a live
   * reread the agent can rewrite.
   */
  private promptFor(): string {
    const status = this.status()
    const track = this.trackForPrompt()
    const original = this.originalRequirement
    const specPath = this.followedSpec
    const landing = shipPhaseKind(status) === 'land' ? landingPlan(this.followedMarkdown() ?? '') : undefined
    const mission = this.missionForPrompt()
    const ticket = this.activeTicketForPrompt()
    const prepend = [track, mission, ticket].filter((part): part is string => part !== undefined).join('\n\n')
    const prompt = shipPromptFor(status, {
      ...(landing === undefined ? {} : { verificationOnly: landing.tickets.length > 0 && landing.active === undefined }),
      ...(landing?.active === undefined ? {} : { activeTicket: landing.active.contract }),
      ...(this.goalId === undefined ? {} : { goalId: this.goalId }),
      ...(prepend === '' ? {} : { track: prepend }),
      ...(original === undefined ? {} : { originalRequirement: original }),
      ...(specPath === undefined ? {} : { specPath }),
    })
    // Parent expands `$ARGUMENTS` from originalRequirement before attaching
    // user/spec data. A first ledger still needs the typed idea filled in.
    return original === undefined ? expandTemplate(prompt, this.typedIdea) : prompt
  }

  /**
   * Land/done only: inject the first unticked ticket as a local task pack so
   * the executor cannot replan the whole plan each turn.
   */
  private activeTicketForPrompt(): string | undefined {
    const kind = shipPhaseKind(this.status())
    if (kind !== 'land' && kind !== 'done') return undefined
    const specPath = this.followedSpec
    if (specPath === undefined) return undefined
    try {
      const markdown = readFileSync(specPath, 'utf8')
      const requirements = this.sealedContract?.requirements
      const plan = parsePlan(markdown)
      return activeTicketBrief({ ...plan, current: this.currentTicket() }, {
        ...(requirements === undefined ? {} : { requirements }),
      })
    } catch {
      return undefined
    }
  }

  /** Complete the ship compass when this run's spec is shipped. */
  private async completeShipGoal(): Promise<void> {
    const goals = this.ports.goals
    if (goals === undefined || this.goalId === undefined) return
    if (this.sealedContract !== undefined && this.sealedContract.acceptance.length > 0) {
      this.verifyAndReconcile(false)
      if (this.lastVerify === undefined || !this.lastVerify.satisfied) {
        this.ports.flash?.(VERIFY_INCOMPLETE)
        return
      }
    }
    try {
      await goals.complete(this.goalId)
    } catch {
      this.degrade()
    }
  }

  /** True when the spec this run followed now says shipped. */
  private followedIsShipped(): boolean {
    if (this.followedSpec === undefined) return false
    try {
      return parseShipStatus(readFileSync(this.followedSpec, 'utf8')) === 'shipped'
    } catch {
      return false
    }
  }

  /**
   * Draft track from the bound spec until Confirm; then freeze a snapshot.
   * Interviewing still prepends the live draft; later phases keep the seal.
   * Confirm also compiles and writes the Mission Contract JSON the runner owns.
   */
  private trackForPrompt(): string | undefined {
    if (this.snapshot?.trackSealed === true && this.snapshot.mainTrack !== undefined) return this.snapshot.mainTrack
    if (this.sealedContract !== undefined) return `## Main Track\n\n${this.sealedContract.mainTrackMarkdown}`
    return this.sealedTrack ?? this.liveTrack()
  }

  /**
   * Compact Mission Contract summary for later phase injects. Absent until
   * Confirm seals one; later phases keep the sealed summary even if the
   * Markdown Main Track is rewritten on disk.
   */
  private missionForPrompt(): string | undefined {
    if (this.sealedContract === undefined) return undefined
    return missionContractSummary(this.sealedContract, this.sealedContractPath)
  }

  /**
   * Compile + persist the Mission Contract beside `.scratch/<slug>/`.
   * Failures degrade: the sealed Main Track string still binds.
   */
  private sealMissionContract(): void {
    if (this.sealedContract !== undefined || this.inPlanMode() || this.contractInvalid) return
    const status = this.status()
    if (!['confirmed', 'planned', 'landing', 'shipped'].includes(status ?? '')) return
    const specPath = this.followedSpec
    if (specPath === undefined) return
    try {
      const markdown = readFileSync(specPath, 'utf8')
      const slug = slugFromSpec(markdown, specPath)
      // Resume must load the on-disk seal — never recompile over a prior Confirm.
      const existing = readMissionContract(this.cwd, slug)
      if (existing !== undefined) {
        this.sealedContract = existing
        this.sealedContractPath = missionContractPath(this.cwd, slug)
        // Always prefer the sealed snapshot — never keep a live rewrite.
        this.sealedTrack = `## Main Track\n\n${existing.mainTrackMarkdown}`
        return
      }
      if (existsSync(missionContractPath(this.cwd, slug))) {
        this.block('Sealed Mission Contract is unreadable or corrupt. Stopped; restore it rather than recompiling.')
        return
      }
      const contract = compileMissionContract(markdown, { id: slug })
      this.sealedContract = contract
      this.sealedContractPath = writeMissionContract(this.cwd, slug, contract)
    } catch {
      this.block('Mission Contract could not be sealed. Stopped; check the spec and writable scratch directory.')
    }
  }


  /**
   * Post-write safety net for immutable contract JSON only.
   * Do not re-align without supports — that false-denies legitimate ticket
   * writes already allowed by `alignTool` and poisons drift via recentActions.
   */
  private guardWrites(paths: readonly string[]): void {
    if (this.sealedContract === undefined || this.inPlanMode()) return
    for (const path of paths) {
      if (writeAllowed(classifyPath(path))) continue
      this.ports.flash?.(ALIGN_DENIED)
      if (this.sealedContractPath === undefined) continue
      try {
        writeMissionContract(
          this.cwd,
          slugFromSpec(readFileSync(this.followedSpec ?? '', 'utf8'), this.followedSpec),
          this.sealedContract,
        )
      } catch {
        // Best-effort restore of the contract JSON.
      }
    }
  }

  /** Run a drift scan when a sealed contract and plan exist. */
  private scanDrift(): void {
    if (this.sealedContract === undefined) return
    const specPath = this.followedSpec
    if (specPath === undefined) return
    try {
      const plan = parsePlan(readFileSync(specPath, 'utf8'))
      if (plan.tickets.length === 0) return
      const report = detectDrift({
        contract: this.sealedContract,
        plan,
        recentActions: this.recentActions,
      })
      this.lastDrift = report
      if (report.driftScore >= DRIFT_FLASH_AT) this.ports.flash?.(DRIFT_FLASH)
    } catch {
      // Unreadable spec: skip.
    }
  }

  /**
   * Verifier: acceptance needs evidence. Premature plan ticks are cleared.
   * Completion of the ship goal still requires Status shipped + evidence.
   */
  private verifyAndReconcile(reconcile = true): void {
    if (this.inPlanMode()) return
    if (this.sealedContract === undefined) return
    if (this.sealedContract.acceptance.length === 0) return
    const specPath = this.followedSpec
    if (specPath === undefined) return
    try {
      let markdown = readFileSync(specPath, 'utf8')
      const evidence = parseEvidenceFromSpec(markdown)
      const verdict = verifyAcceptance(this.sealedContract, evidence)
      this.lastVerify = verdict
      if (verdict.satisfied || !reconcile) return
      const reconciled = reconcilePlanTicks(markdown, verdict)
      if (reconciled !== undefined && reconciled !== markdown) {
        writeFileSync(specPath, reconciled)
        this.ports.flash?.(VERIFY_INCOMPLETE)
      }
    } catch {
      // Unreadable spec: skip.
    }
  }

  private currentTicket() {
    const specPath = this.followedSpec
    if (specPath === undefined) return undefined
    try {
      const markdown = readFileSync(specPath, 'utf8')
      const active = landingPlan(markdown).active
      return active === undefined ? undefined : parsePlan(markdown).tickets.find(ticket => ticket.raw === active.contract)
    } catch {
      return undefined
    }
  }

  /** REQ ids the Active Ticket's Track lines map to on the sealed contract. */
  private activeTicketSupports(
    ticket = this.currentTicket(),
  ): string[] | undefined {
    if (ticket === undefined || this.sealedContract === undefined) return undefined
    const track = ticket.trackIds ?? []
    if (track.length === 0) return undefined
    const ids = this.sealedContract.requirements
      .filter(req => req.track?.some(n => track.includes(n)))
      .map(req => req.id)
    return ids.length === 0 ? undefined : ids
  }

  private rememberAction(descriptor: ActionDescriptor): void {
    this.recentActions.push(descriptor)
    if (this.recentActions.length > 40) this.recentActions.shift()
  }

  /** Compact Main Track on the bound spec, headed so later phases prepend a real section. */
  private liveTrack(): string | undefined {
    const markdown = this.followedMarkdown()
    if (markdown === undefined) return undefined
    const body = parseMainTrack(markdown)
    return body === undefined ? undefined : headedMainTrack(body)
  }

  private status() {
    const markdown = this.followedMarkdown()
    if (markdown === undefined) return undefined
    return parseShipStatus(markdown)
  }

  private followedMarkdown(): string | undefined {
    if (this.followedSpec === undefined) return undefined
    try {
      return readFileSync(this.followedSpec, 'utf8')
    } catch {
      return undefined
    }
  }

  /**
   * Pin one canonical spec for this run. Other markdown writes cannot switch
   * the binding. Several unfinished specs require an explicit choice.
   */
  private async bindSpec(idea: string): Promise<boolean> {
    const unfinished = this.unfinishedSpecs()
    let path: string | undefined
    if (unfinished.length === 1) {
      path = unfinished[0] ?? undefined
    } else if (unfinished.length > 1) {
      path = await this.chooseSpec(unfinished)
      if (path === undefined) return false
    }
    if (path === undefined) {
      this.originalRequirement = freezeText(idea) || undefined
      return true
    }
    return this.adoptBoundSpec(path, idea)
  }

  private unfinishedSpecs(): string[] {
    const seen = new Set<string>()
    const paths: string[] = []
    for (const path of this.specPaths()) {
      const absolute = resolve(path)
      if (seen.has(absolute) || this.ignoredSpecs.has(absolute)) continue
      seen.add(absolute)
      try {
        const status = parseShipStatus(readFileSync(path, 'utf8'))
        if (status !== undefined && status !== 'shipped') paths.push(absolute)
      } catch {
        // Unreadable files are not candidates.
      }
    }
    const specsDir = resolve(join(this.cwd, 'docs', 'specs'))
    const inDir = paths.filter(path => dirname(path) === specsDir || path.startsWith(`${specsDir}${sep}`))
    return inDir.length > 0 ? inDir : paths
  }

  /** Choose among unfinished specs; a pipe without a selector is a blocker. */
  private async chooseSpec(paths: readonly string[]): Promise<string | undefined> {
    const ask = this.ports.selectSpec ?? this.ports.occupancy
    if (ask === undefined) {
      this.block(AMBIGUOUS_SPECS)
      return undefined
    }
    try {
      const outcome = await ask({
        title: SHIP_SELECT_SPEC_TITLE,
        options: paths.map(path => ({ label: basename(path), detail: path })),
      }, this.advance?.signal)
      if (outcome.kind !== 'chosen' || outcome.indices[0] === undefined) {
        this.block(AMBIGUOUS_SPECS)
        return undefined
      }
      const chosen = paths[outcome.indices[0]]
      if (chosen === undefined) {
        this.block(AMBIGUOUS_SPECS)
        return undefined
      }
      for (const path of paths) {
        if (path !== chosen) this.ignoredSpecs.add(path)
      }
      return chosen
    } catch {
      this.block(AMBIGUOUS_SPECS)
      return undefined
    }
  }

  private adoptBoundSpec(path: string, idea: string): boolean {
    let markdown: string
    try {
      markdown = readFileSync(path, 'utf8')
    } catch {
      this.block(`Bound spec is unreadable at ${path}. Stopped; restore the spec.`)
      return false
    }
    const loaded = readShipSnapshot(path)
    if (isShipSnapshotError(loaded)) {
      this.block(loaded.error)
      return false
    }
    const missionSlug = slugFromSpec(markdown, path)
    const missionPath = missionContractPath(this.cwd, missionSlug)
    const priorMission = readMissionContract(this.cwd, missionSlug)
    if (existsSync(missionPath) && priorMission === undefined) {
      this.block('Sealed Mission Contract is unreadable or corrupt. Stopped; restore it rather than recompiling.')
      return false
    }
    if (priorMission !== undefined) {
      this.sealedContract = priorMission
      this.sealedContractPath = missionPath
      if (mainTrackDrifted(priorMission.mainTrackMarkdown, markdown)) {
        this.block('Frozen ## Main Track no longer matches the sealed Mission Contract. Stopped; restore the approved content.')
        return false
      }
    }
    const known = this.knownSnapshots.get(path)
    if (known !== undefined && JSON.stringify(known) !== JSON.stringify(loaded)) {
      this.block(`Ship snapshot is missing or changed beside ${path}. Stopped; restore the saved snapshot.`)
      return false
    }
    let snapshot = loaded
    if (snapshot === undefined) {
      snapshot = initialShipSnapshot(path, markdown, idea)
      if (snapshot === undefined) {
        this.block(NO_OBJECTIVE)
        return false
      }
      if (snapshot.limitedHistory === true || (snapshot.trackSealed && this.originalRequirement === undefined)) {
        this.ports.flash?.(LIMITED_HISTORY)
      }
    }
    const mismatch = this.conflictingIdea(snapshot, idea)
    if (mismatch !== undefined) {
      this.block(mismatch)
      return false
    }
    const drift = validateSnapshotAgainstSpec(snapshot, path, markdown)
    if (drift !== undefined) {
      this.block(drift)
      return false
    }
    this.followedSpec = path
    this.snapshot = snapshot
    this.originalRequirement = snapshot.originalRequirement === '' ? undefined : snapshot.originalRequirement
    if (loaded === undefined && this.originalRequirement === undefined && freezeText(idea) !== '') {
      this.originalRequirement = freezeText(idea)
    }
    if (snapshot.trackSealed && snapshot.mainTrack !== undefined) this.sealedTrack = snapshot.mainTrack
    this.refresh()
    return true
  }

  /**
   * A typed idea that disagrees with a saved original is a blocker, never a
   * silent reinterpretation. Empty resume keeps the freeze.
   */
  private conflictingIdea(snapshot: ShipSnapshot, idea: string): string | undefined {
    const typed = freezeText(idea)
    if (typed === '') return undefined
    const saved = freezeText(snapshot.originalRequirement)
    if (saved === '' || freezeEqual(typed, saved)) return undefined
    return 'Typed idea conflicts with the saved original requirement. Stopped; resume with an empty /ship or start a separately approved spec.'
  }

  /**
   * After a first ledger write, pin the new spec. Other unfinished files
   * written later cannot steal a binding already made.
   */
  private discoverBoundSpec(): void {
    if (this.followedSpec !== undefined) return
    const unfinished = this.unfinishedSpecs()
    const only = unfinished.length === 1 ? unfinished[0] : undefined
    if (only !== undefined) {
      this.adoptBoundSpec(only, this.originalRequirement ?? this.typedIdea)
      return
    }
    if (unfinished.length > 1) this.block(AMBIGUOUS_SPECS)
  }

  /**
   * Write or update the adjacent sidecar. Never invent a path from markdown,
   * never overwrite a corrupt file, never claim a historical seal for legacy.
   */
  private persistSnapshot(): void {
    if (this.inPlanMode() || this.contractInvalid || this.followedSpec === undefined) return
    if (!this.guardContract()) return
    const markdown = this.followedMarkdown()
    if (markdown === undefined) {
      this.block(`Bound spec is unreadable at ${this.followedSpec}. Stopped; restore the spec.`)
      return
    }
    const loaded = readShipSnapshot(this.followedSpec)
    if (isShipSnapshotError(loaded)) {
      this.block(loaded.error)
      return
    }
    let next = loaded ?? this.snapshot ?? initialShipSnapshot(this.followedSpec, markdown, this.originalRequirement ?? this.typedIdea)
    if (next === undefined) return
    next = { ...next, specPath: basename(this.followedSpec) }
    next = sealOriginalIfNeeded(next, markdown)
    next = sealTrackIfNeeded(next, markdown)
    if (this.snapshot !== undefined) {
      if (this.snapshot.originalSealed && next.originalRequirement !== this.snapshot.originalRequirement) {
        this.block(`Frozen ## Original Requirement no longer matches ${this.followedSpec}. Stopped; restore the approved content.`)
        return
      }
      if (this.snapshot.trackSealed && this.snapshot.mainTrack !== undefined
        && next.mainTrack !== undefined && !freezeEqual(next.mainTrack, this.snapshot.mainTrack)) {
        this.block(`Frozen ## Main Track no longer matches ${this.followedSpec}. Stopped; restore the approved content.`)
        return
      }
    }
    try {
      writeShipSnapshot(next, this.followedSpec)
      this.knownSnapshots.set(this.followedSpec, next)
    } catch {
      this.block(`Ship snapshot could not be written beside ${this.followedSpec}. Stopped.`)
      return
    }
    this.snapshot = next
    if (next.originalRequirement !== '') this.originalRequirement = next.originalRequirement
    if (next.trackSealed && next.mainTrack !== undefined) this.sealedTrack = next.mainTrack
    this.sealMissionContract()
    this.scanDrift()
  }

  /**
   * Validate freeze against disk before and after every phase. Failures halt
   * the next phase and goal completion; they do not invent evidence.
   */
  private guardContract(): boolean {
    if (this.contractInvalid) return false
    if (this.followedSpec === undefined) return true
    const markdown = this.followedMarkdown()
    if (markdown === undefined) {
      this.block(`Bound spec is unreadable at ${this.followedSpec}. Stopped; restore the spec.`)
      return false
    }
    if (parseShipStatus(markdown) === undefined) {
      this.block(`Bound spec has no valid Status at ${this.followedSpec}. Stopped; restore the last approved phase.`)
      return false
    }
    const known = this.knownSnapshots.get(this.followedSpec)
    if (known !== undefined) {
      const loaded = readShipSnapshot(this.followedSpec)
      if (JSON.stringify(loaded) !== JSON.stringify(known)) {
        this.block(`Ship snapshot is missing or changed beside ${this.followedSpec}. Stopped; restore the saved snapshot.`)
        return false
      }
    }
    if (this.snapshot !== undefined) {
      const snapshotDrift = validateSnapshotAgainstSpec(this.snapshot, this.followedSpec, markdown)
      if (snapshotDrift !== undefined) { this.block(snapshotDrift); return false }
    }
    if (this.sealedContract !== undefined) {
      if (mainTrackDrifted(this.sealedContract.mainTrackMarkdown, markdown)) {
        this.block('Frozen ## Main Track no longer matches the sealed Mission Contract. Stopped; restore the approved content.')
        return false
      }
      if (this.sealedContractPath !== undefined) {
        try {
          if (JSON.stringify(JSON.parse(readFileSync(this.sealedContractPath, 'utf8'))) !== JSON.stringify(this.sealedContract)) {
            this.block('Sealed Mission Contract changed. Stopped; restore the approved contract.')
            return false
          }
        } catch {
          this.block('Sealed Mission Contract is missing or corrupt. Stopped; restore the approved contract.')
          return false
        }
      }
    }
    return true
  }

  /** Only a legal forward phase change may spend another turn. */
  private mayAdvance(previous: ShipPhaseKind, next: ShipPhaseKind): boolean {
    if (next === previous) return false
    if (PHASE_RANK[next] !== PHASE_RANK[previous] + 1) {
      this.block(`Invalid ship phase transition: ${previous} → ${next}. Stopped; restore the last approved phase.`)
      return false
    }
    return next !== 'done'
  }

  /**
   * Grill, wayfinder, and preflight HITL may inject again without a phase
   * change. Gate Abort and true idle (unchanged Status, no HITL) still stop.
   */
  private mayContinueHitl(hitl: boolean, kind: ShipPhaseKind): boolean {
    return hitl && (kind === 'wayfinder' || kind === 'grill')
  }

  /** Land one ticket per turn, with host-owned checks between every dispatch. */
  private async runLanding(turn: ShipTurn): Promise<void> {
    const initial = landingPlan(this.followedMarkdown() ?? '')
    if (initial.tickets.length === 0) {
      this.block('Ship landing requires a non-empty approved ## Plan. Stopped; restore the approved tickets.')
      return
    }
    const budget = initial.tickets.length * 3 + 1
    let stalled = 0
    for (let attempt = 0; attempt < budget; attempt += 1) {
      if (this.halted || this.advance?.signal.aborted || this.inPlanMode() || !this.guardContract()) return
      const markdown = this.followedMarkdown() ?? ''
      const blocker = parseShipBlocker(markdown)
      if (blocker !== undefined) { this.block(`Ship has an unresolved ## Blocker. Stopped; resolve it before resuming.\n${blocker}`); return }
      const before = landingPlan(markdown)
      if (before.error !== undefined) { this.block(before.error); return }
      await this.syncCompass()
      await this.spendTurn(turn)
      if (this.halted || this.advance?.signal.aborted || this.inPlanMode() || !this.guardContract()) return
      const afterMarkdown = this.followedMarkdown() ?? ''
      const after = landingPlan(afterMarkdown)
      if (!sameLandingPlan(before, after)) { this.block('Approved ship plan changed during a ticket turn. Stopped; restore the plan before resuming.'); return }
      if (after.error !== undefined) { this.block(after.error); return }
      const newlyDone = after.tickets.filter((ticket, index) => ticket.done && !before.tickets[index]?.done)
      if (newlyDone.length > 1 || newlyDone.some(ticket => ticket.id !== before.active?.id)) {
        this.block('Ship turn completed tickets other than its Active Ticket. Stopped before another dispatch.')
        return
      }
      const next = shipPhaseKind(this.status())
      if (next === 'done') {
        if (before.active !== undefined || after.active !== undefined || parseShipBlocker(afterMarkdown) !== undefined) {
          this.block('Ship may finish only in a separate final verification turn after every ticket is checked.')
          return
        }
        this.verifyAndReconcile()
        if (this.sealedContract?.acceptance.length && !this.lastVerify?.satisfied) {
          const current = this.followedMarkdown()
          if (current !== undefined && this.followedSpec !== undefined) {
            writeFileSync(this.followedSpec, current.replace(/^Status:\s*shipped\b/imu, 'Status: landing'))
          }
          this.block('Verifier: acceptance evidence incomplete. Delivery blocked; restore proof evidence before resuming.')
        }
        return
      }
      if (next !== 'land') { this.block(`Invalid ship phase transition during landing: ${next}. Stopped.`); return }
      const degraded = after.tickets.some((ticket, index) => !ticket.done && before.tickets[index]?.done)
      if (newlyDone.length === 0 && !degraded) stalled += 1
      else stalled = 0
      if (stalled >= 2) { this.block('Ship stopped after two consecutive turns without ticket progress. Inspect the evidence before resuming.'); return }
    }
    this.block(`Ship stopped at its landing turn budget (${budget}). Progress remains on disk; inspect blockers before resuming.`)
  }

  private async spendTurn(turn: ShipTurn): Promise<boolean> {
    if (this.contractInvalid || this.halted) return false
    if (this.inPlanMode()) { this.halted = true; return false }
    if (!this.guardContract()) return false
    const result = await turn(this.promptFor())
    if (this.halted || this.advance?.signal.aborted === true || this.inPlanMode()) { this.halted = true; return false }
    this.discoverBoundSpec()
    if (!this.guardContract()) return false
    this.persistSnapshot()
    if (this.contractInvalid || this.halted) return false
    return result !== undefined && result.hitl === true
  }

  private inPlanMode(): boolean {
    try {
      return this.ports.isPlanMode?.() === true
    } catch {
      return false
    }
  }

  /**
   * Plan mode is interview-only: inject a read-only prompt and stop. No
   * snapshot writes, occupancy, or goal mutations.
   */
  private async runPlanMode(idea: string, turn: ShipTurn): Promise<void> {
    const unfinished = this.unfinishedSpecs()
    if (unfinished.length === 1 && unfinished[0] !== undefined) {
      this.followedSpec = unfinished[0]
      const markdown = this.followedMarkdown()
      if (markdown !== undefined) {
        this.originalRequirement = parseOriginalRequirement(markdown)
          ?? (freezeText(idea) === '' ? parseMainTrack(markdown) : freezeText(idea))
      }
    } else if (unfinished.length > 1) {
      this.block(AMBIGUOUS_SPECS)
      return
    } else if (freezeText(idea) !== '') {
      this.originalRequirement = freezeText(idea)
    }
    await turn(this.promptFor())
  }

  /** User-visible halt; optional goals stay unused so a throw cannot skip disk. */
  private block(message: string): void {
    this.contractInvalid = true
    this.halted = true
    this.ports.flash?.(message)
  }

  private specPaths(): string[] {
    const seen = new Set<string>()
    const paths: string[] = []
    let dir: string[] = []
    try {
      dir = readdirSync(join(this.cwd, 'docs', 'specs'))
        .filter(name => name.endsWith('.md'))
        .map(name => join(this.cwd, 'docs', 'specs', name))
    } catch {
      dir = []
    }
    for (const path of [...this.writtenDocs, ...dir]) {
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }
    return paths
  }

  private adoptChip(markdown: string, plan: Plan): void {
    if (this.chipCleared) return
    const status = parseShipStatus(markdown)
    const usable = plan.tickets.length > 0 ? plan : undefined
    const flash = usable !== undefined && this.lastDone !== undefined && usable.done > this.lastDone
    if (usable !== undefined) this.lastDone = usable.done
    const derived = shipChipFromSpec(status, usable, flash)
    if (derived === undefined) return
    if (derived.kind === 'done') {
      if (this.chip?.kind === 'done') return
      this.setChip(derived, 'clear')
      return
    }
    this.setChip(derived, derived.kind === 'land' && derived.flashOk === true ? 'flash' : undefined)
  }

  private setChip(next: ShipChip | undefined, settle?: 'flash' | 'clear'): void {
    if (sameShipChip(this.chip, next) && settle === undefined) return
    this.clearFlash()
    this.chip = next
    this.chrome.setChip(next)
    if (settle === undefined || next === undefined) return
    this.flashTimer = setTimeout(() => {
      this.flashTimer = undefined
      if (settle === 'clear') {
        this.chip = undefined
        this.chipCleared = true
        this.stopWatch()
      } else if (next.kind === 'land') {
        this.chip = { kind: 'land', k: next.k, n: next.n }
      }
      this.chrome.setChip(this.chip)
    }, SHIP_CHIP_FLASH_MS)
    this.flashTimer.unref()
  }

  private clearFlash(): void {
    if (this.flashTimer === undefined) return
    clearTimeout(this.flashTimer)
    this.flashTimer = undefined
  }

  private stopWatch(): void {
    if (this.watch === undefined) return
    clearInterval(this.watch)
    this.watch = undefined
  }

  private startWatch(): void {
    this.stopWatch()
    this.watch = setInterval(() => {
      this.refresh()
      this.chrome.setTodos?.()
    }, SHIP_POLL_MS)
    this.watch.unref()
  }
}
