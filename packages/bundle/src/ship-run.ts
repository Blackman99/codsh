/**
 * One `/ship` run: the spec file is memory, Chrome follows it, and each
 * turn injects only the phase Status names.
 *
 * The runner calls {@link ShipRun.run} for the canned command, {@link
 * ShipRun.noteWritten} when a tool writes markdown, and {@link ShipRun.abort}
 * on Esc. Chip, plan, poll, occupancy, the goals port, Claim writes,
 * AFK child-create, Fold bind, and phase injection stay behind this seam.
 * @module codsh-bundle/src/ship-run
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { parseMainTrack, parseOriginalRequirement, parsePlan, parseShipBlocker, parseShipStatus, parseSpecMetadata, pickLiveShip, planInFlight, plansEqual } from './plan.ts'
import {
  cascadeClosedDependents,
  dispatchedDependents,
  landingPlan,
  landingTicketTitle,
  landingWavePrepend,
  landMergeMessage,
  proofSweepCommitMessage,
  readySet,
  sameLandingPlan,
  sweepBlockerBody,
  sweepProofTargets,
  writeBlockerSection,
  worktreeCommitMessage,
  type LandingPlan,
  type LandingTicket,
  type LandingWaveView,
} from './ship-landing.ts'
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
import { capture } from './capture.ts'
import {
  collectJoinSources,
  graphPathFor,
  isShipGraphDiscard,
  isShipGraphJoinError,
  joinShipGraph,
  readShipGraph,
  teaserCounts,
  worktreeDirectory,
  worktreeDirectoryParts,
  writeShipGraph,
} from './ship-graph.ts'
import type { ShipGraph, ShipGraphNode, TeaserCounts } from './ship-graph.ts'
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
  /** Panorama teaser counts, absent when no graph is bound. */
  setTeaser?(counts: TeaserCounts | undefined): void
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

/** One AFK child the host creates with `agents.create({ meta: { cwd } })`. */
export interface ShipChildCreateRequest {
  graphKey: string
  label: string
  prompt: string
  cwd?: string
  role?: 'conflict' | 'repair'
}

/** Live handle the runner keeps until it releases the child. */
export interface ShipChildHandle {
  id: string
  graphKey: string
  label: string
  role?: 'conflict' | 'repair'
  /** Settles when the child is idle; the runner then releases the Fold. */
  done?: Promise<void>
  dispose(): Promise<void>
}

/** Host-plane child factory. High-level spawn copies parent cwd and is wrong. */
export interface ShipChildCreate {
  create(request: ShipChildCreateRequest): Promise<ShipChildHandle>
}

/** Transcript port that paints a runner Fold without a parent `subagent` card. */
export interface ShipFoldBind {
  bind(sessionId: string, label: string): void
  release(sessionId: string): void
}

/** Optional git so tests can fake worktree add and claim commits. */
export type ShipGit = (args: readonly string[], cwd: string) => Promise<{ code: number; output: string }>

/** Optional ports the composition root wires: goals, occupancy, flash. */
export interface ShipPorts {
  goals?: ShipGoals
  occupancy?: OccupancyAsk
  /** Choose among unfinished specs; falls back to occupancy with a distinct title. */
  selectSpec?: OccupancyAsk
  flash?: ShipFlash
  /** True while plan mode is holding; the runner stays read-only. */
  isPlanMode?: () => boolean
  /** AFK child factory; absent means no runner dispatch. */
  childCreate?: ShipChildCreate
  /** Runner Fold bind; a pipe (`isTty: false`) never calls it. */
  folds?: ShipFoldBind
  git?: ShipGit
  /**
   * Named proof after a land merge (`kind: 'land'`) or during a proof sweep
   * (`kind: 'sweep'`). Unit tests fake this; absent is green. Do not run the
   * real suite inside unit tests.
   */
  prove?: (ticket: { id: string; contract: string; kind: 'sweep' | 'land' }) => Promise<'green' | 'red'>
  /** False on a pipe: sidecar still rebuilds, no Fold. Default true. */
  isTty?: boolean
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
  /** Rebuilt panorama cache for the bound spec; never identity. */
  private graph: ShipGraph | undefined
  /** Live spec chrome is following; used to rebuild before bindSpec pins one. */
  private graphSpec: string | undefined
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
  /** In-flight runner children, keyed by Session id. Claim never stores these. */
  private readonly children = new Map<string, ShipChildHandle>()
  /** Landing ticket ids whose child `done` settled this run; Ready-set input. */
  private readonly finishedLanding = new Set<string>()
  /** Landing children whose `done` rejected (crash / timeout). */
  private readonly crashedLanding = new Set<string>()
  /**
   * Blocker freeze: no new worktrees and no further serial merges. In-flight
   * independents still settle as leftover 已认领.
   */
  private landingFrozen = false
  /** Pre-child HEAD for an in-flight In-place repair; interrupt restores it. */
  private inPlacePreHead: string | undefined
  /** Landing ticket id currently in In-place repair, when any. */
  private inPlaceTicketId: string | undefined
  /** Cached host `user.name` / `user.email` for runner-authored commits. */
  private gitIdentity: { name: string; email: string } | undefined

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

  /** Rebuilt Ship graph, absent until a join succeeds for the bound spec. */
  get shipGraph(): ShipGraph | undefined {
    return this.graph
  }

  /** Panorama teaser counts from ticket nodes, absent until a graph exists. */
  get shipTeaser(): TeaserCounts | undefined {
    return this.graph === undefined ? undefined : teaserCounts(this.graph)
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
    else this.rebuildGraph()
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
    this.graphSpec = files.find(file => file.markdown === picked.markdown)?.path
    const live = planInFlight(picked.markdown, picked.plan)
    const next = live ? picked.plan : undefined
    if (!plansEqual(this.plan, next)) {
      this.plan = next
      this.chrome.setPlan(next)
    }
    this.adoptChip(picked.markdown, picked.plan)
    this.rebuildGraph()
  }

  /** Stop the phase loop and the spec poll. Claim stays; Occupancy end does not unclaim. */
  abort(): void {
    this.halted = true
    this.advance?.abort()
    this.stopWatch()
  }

  /**
   * Drop a runner child after the work is released. The Fold goes with it.
   * A leftover worktree with no Session stays panorama 已认领, not a dead door.
   */
  async releaseChild(id: string): Promise<void> {
    const handle = this.children.get(id)
    if (handle === undefined) return
    this.children.delete(id)
    try {
      await handle.dispose()
    } catch {
      // Dispose is best-effort; the Fold still has to leave.
    }
    this.ports.folds?.release(id)
  }

  /**
   * In-flight runner children. Reconstruct Folds from this plus live Sessions;
   * a leftover worktree with no Session is not listed.
   */
  get liveChildren(): readonly ShipChildHandle[] {
    return [...this.children.values()]
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
    this.graph = undefined
    this.graphSpec = undefined
    this.chrome.setTeaser?.(undefined)
    this.originalRequirement = undefined
    this.typedIdea = idea
    this.contractInvalid = false
    this.halted = false
    this.ignoredSpecs = new Set()
    this.finishedLanding.clear()
    this.crashedLanding.clear()
    this.landingFrozen = false
    this.inPlacePreHead = undefined
    this.inPlaceTicketId = undefined
    this.gitIdentity = undefined
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
      this.rebuildGraph()
      this.reclaimLeftoverWorktrees()
      this.rebuildGraph()
      if (!this.guardContract()) return
      let previous = shipPhaseKind(this.status())
      await this.syncCompass()
      await this.reclaimAndDispatch()
      if (previous === 'land') { await this.runLanding(turn); return }
      let hitl = await this.spendTurn(turn)
      while (!advance.signal.aborted && !this.contractInvalid && !this.halted) {
        if (this.inPlanMode()) { this.halted = true; break }
        this.refresh()
        this.discoverBoundSpec()
        this.persistSnapshot()
        this.rebuildGraph()
        if (!this.guardContract()) break
        await this.syncCompass()
        await this.reclaimAndDispatch()
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
        await this.interruptInPlaceRepair()
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
    const allDone = landing !== undefined && landing.tickets.length > 0 && landing.tickets.every(ticket => ticket.done)
    const prepend = [track, mission].filter((part): part is string => part !== undefined).join('\n\n')
    const prompt = shipPromptFor(status, {
      ...(landing === undefined ? {} : { verificationOnly: allDone }),
      ...(landing === undefined ? {} : { landingWave: landingWavePrepend(this.waveView()) }),
      ...(this.goalId === undefined ? {} : { goalId: this.goalId }),
      ...(prepend === '' ? {} : { track: prepend }),
      ...(original === undefined ? {} : { originalRequirement: original }),
      ...(specPath === undefined ? {} : { specPath }),
    })
    // Parent expands `$ARGUMENTS` from originalRequirement before attaching
    // user/spec data. A first ledger still needs the typed idea filled in.
    return original === undefined ? expandTemplate(prompt, this.typedIdea) : prompt
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
    this.rebuildGraph()
    this.scanDrift()
  }

  /**
   * Rebuild the panorama cache from canonical sources. Missing or corrupt
   * sidecar is discarded; a join failure stops `/ship` with no guessed cache.
   * Disk write failure keeps the in-memory graph for the next rebuild.
   */
  private rebuildGraph(): void {
    if (this.inPlanMode() || this.contractInvalid) return
    const specPath = this.followedSpec ?? this.graphSpec
    if (specPath === undefined) return
    let markdown: string | undefined
    try {
      markdown = this.followedSpec === specPath ? this.followedMarkdown() : readFileSync(specPath, 'utf8')
    } catch {
      return
    }
    if (markdown === undefined) return
    const loaded = readShipGraph(specPath)
    if (isShipGraphDiscard(loaded)) {
      try { unlinkSync(graphPathFor(specPath)) } catch { /* leftover cache is not identity */ }
    }
    const collected = collectJoinSources(this.cwd, specPath, markdown)
    if (isShipGraphJoinError(collected)) {
      this.block(collected.error)
      return
    }
    const next = joinShipGraph(collected)
    if (isShipGraphJoinError(next)) {
      this.block(next.error)
      return
    }
    this.graph = next
    this.chrome.setTeaser?.(teaserCounts(next))
    try {
      writeShipGraph(next, specPath)
    } catch {
      // Keep the in-memory graph; retry the atomic write on the next rebuild.
    }
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

  /**
   * Claim leftover worktrees, then AFK-dispatch unblocked research and
   * unclaimed landing tickets. No parent model turn is spent here.
   * In-place repair runs on `ship/<slug>`; new 待认领 worktrees wait until
   * that queue and Ready-set drain are idle.
   */
  private async reclaimAndDispatch(): Promise<void> {
    this.reclaimLeftoverWorktrees()
    this.rebuildGraph()
    if (this.halted || this.contractInvalid || this.inPlanMode()) return
    await this.dispatchResearch()
    await this.dispatchInPlaceRepairs()
    await this.dispatchLandingChildren()
  }

  private slug(): string | undefined {
    const specPath = this.followedSpec
    const markdown = this.followedMarkdown()
    if (specPath === undefined || markdown === undefined) return undefined
    return slugFromSpec(markdown, specPath)
  }

  private worktreePath(graphKey: string): string | undefined {
    const slug = this.slug()
    const directory = worktreeDirectory(graphKey)
    if (slug === undefined || directory === undefined) return undefined
    return join(this.cwd, '.scratch', slug, 'worktrees', directory)
  }

  private leftoverWorktree(graphKey: string): boolean {
    const path = this.worktreePath(graphKey)
    return path !== undefined && existsSync(path)
  }

  /** Missing `Claim: claimed` plus leftover worktree writes the flag. Never a Session id. */
  private reclaimLeftoverWorktrees(): void {
    const slug = this.slug()
    if (slug === undefined) return
    const root = join(this.cwd, '.scratch', slug, 'worktrees')
    let names: string[] = []
    try {
      names = readdirSync(root)
    } catch {
      return
    }
    for (const name of names) {
      const parts = worktreeDirectoryParts(name)
      if (parts === undefined) continue
      if (parts.kind === 'landing') this.writeLandingClaim(slug, parts.n)
      else this.writeDecisionClaim(slug, parts.n)
    }
  }

  private writeLandingClaim(slug: string, n: number): boolean {
    const dir = join(this.cwd, '.scratch', slug, 'issues')
    mkdirSync(dir, { recursive: true })
    const path = this.scratchFile(dir, n) ?? join(dir, `${String(n).padStart(2, '0')}-ticket.md`)
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      const title = this.graph?.nodes.find(node => node.id === `landing:${String(n)}`)?.title ?? `Ticket ${String(n)}`
      text = `Ticket ${String(n)}: ${title}\n`
    }
    if (/^Claim:\s*claimed\b/imu.test(text)) return false
    const next = /^Claim:\s*/imu.test(text)
      ? text.replace(/^Claim:\s*.*$/imu, 'Claim: claimed')
      : `Claim: claimed\n${text}`
    writeFileSync(path, next.endsWith('\n') ? next : `${next}\n`)
    return true
  }

  private writeDecisionClaim(slug: string, n: number): boolean {
    const dir = join(this.cwd, '.scratch', slug, 'wayfinder')
    const path = this.scratchFile(dir, n)
    if (path === undefined) return false
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return false
    }
    if (/^Status:\s*claimed\b/imu.test(text)) return false
    const next = /^Status:\s*/imu.test(text)
      ? text.replace(/^Status:\s*.*$/imu, 'Status: claimed')
      : `Status: claimed\n${text}`
    writeFileSync(path, next.endsWith('\n') ? next : `${next}\n`)
    return true
  }

  private scratchFile(dir: string, n: number): string | undefined {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return undefined
    }
    const match = names.find(name => new RegExp(`^0*${String(n)}-.+\\.md$`, 'u').test(name))
    return match === undefined ? undefined : join(dir, match)
  }

  private unblocked(id: string): boolean {
    if (this.graph === undefined) return false
    return this.graph.edges
      .filter(edge => edge.from === id && edge.kind === 'blocked-by')
      .every(edge => this.graph?.nodes.find(node => node.id === edge.to)?.claim === 'closed')
  }

  private hasChildFor(graphKey: string): boolean {
    for (const child of this.children.values()) {
      if (child.graphKey === graphKey) return true
    }
    return false
  }

  private hasRepairChild(): boolean {
    for (const child of this.children.values()) {
      if (child.role === 'repair') return true
    }
    return false
  }

  private repairPrompt(node: ShipGraphNode): string {
    const n = /^landing:(\d+)$/u.exec(node.id)?.[1] ?? ''
    return [
      `Ticket ${n}: ${node.title}`,
      `Bound spec: ${this.followedSpec ?? ''}`,
      'In-place repair on the parent ship/<slug> tree. The kept land merge is the base. Do not tick the plan checkbox. Children never commit. No second land merge.',
      'Return at most 20 lines naming the result plus evidence paths.',
    ].join('\n')
  }

  /**
   * Resume of an unticked keep-commit: one In-place repair child on the
   * parent `ship/<slug>` tree. New 待认领 worktrees wait until this is idle.
   */
  private async dispatchInPlaceRepairs(): Promise<void> {
    if (this.ports.childCreate === undefined) return
    if (shipPhaseKind(this.status()) !== 'land') return
    if (this.landingFrozen || parseShipBlocker(this.followedMarkdown() ?? '') !== undefined) return
    if (this.inPlaceTicketId !== undefined || this.hasRepairChild()) return
    this.rebuildGraph()
    const view = this.waveView()
    const closed = new Set(view.tickets.filter(ticket => ticket.done).map(ticket => ticket.id))
    const next = view.tickets
      .filter(ticket => !ticket.done)
      .filter(ticket => view.claimed.has(ticket.id))
      .filter(ticket => !view.worktrees.has(ticket.id))
      .filter(ticket => !view.inFlight.has(ticket.id))
      .filter(ticket => ticket.blockers.every(id => closed.has(id)))
      .slice()
      .sort((a, b) => Number(a.id) - Number(b.id))[0]
    if (next === undefined) return
    const graphKey = `landing:${next.id}`
    const node = this.graph?.nodes.find(candidate => candidate.id === graphKey) ?? {
      id: graphKey,
      kind: 'landing' as const,
      title: landingTicketTitle(next.contract),
      claim: 'claimed' as const,
    }
    const head = (await this.git(['rev-parse', 'HEAD'])).output.trim()
    this.inPlacePreHead = head === '' ? 'HEAD' : head
    this.inPlaceTicketId = next.id
    await this.dispatchChild(node, this.repairPrompt(node), { cwd: this.cwd, role: 'repair' })
  }

  private async dispatchResearch(): Promise<void> {
    if (this.ports.childCreate === undefined || this.graph === undefined) return
    const jobs: Promise<void>[] = []
    for (const node of this.graph.nodes) {
      if (node.kind !== 'decision' || node.ticketType !== 'research') continue
      if (node.claim !== 'claimed') continue
      if (!this.unblocked(node.id)) continue
      if (this.hasChildFor(node.id) || this.leftoverWorktree(node.id)) continue
      jobs.push(this.dispatchChild(node, this.researchPrompt(node)))
    }
    await Promise.all(jobs)
  }

  private async dispatchLandingChildren(): Promise<void> {
    if (this.ports.childCreate === undefined || this.graph === undefined) return
    if (shipPhaseKind(this.status()) !== 'land') return
    if (this.landingFrozen) return
    if (parseShipBlocker(this.followedMarkdown() ?? '') !== undefined) return
    if (this.inPlaceTicketId !== undefined || this.hasRepairChild()) return
    if (readySet(this.waveView()).length > 0) return
    const slug = this.slug()
    if (slug === undefined) return
    const pending: ShipGraphNode[] = []
    for (const node of this.graph.nodes) {
      if (node.kind !== 'landing' || node.claim !== 'unclaimed') continue
      if (!this.unblocked(node.id)) continue
      const n = Number(/^landing:(\d+)$/u.exec(node.id)?.[1])
      if (!Number.isInteger(n) || n <= 0) continue
      this.writeLandingClaim(slug, n)
      if (this.leftoverWorktree(node.id) || this.hasChildFor(node.id)) continue
      pending.push(node)
    }
    this.rebuildGraph()
    for (const node of pending) {
      await this.commitClaim(node.id)
    }
    await Promise.all(pending.map(node => this.dispatchChild(node, this.landingPrompt(node))))
    await Promise.resolve()
  }

  private researchPrompt(node: ShipGraphNode): string {
    const specPath = this.followedSpec ?? ''
    return [
      `Research decision: ${node.title}`,
      `Bound spec: ${specPath}`,
      'Read-only with respect to project files. Write evidence only under the spec scratch directory.',
      'Return at most 20 lines naming the result plus evidence paths. Do not edit the spec, Status, or plan checkboxes.',
    ].join('\n')
  }

  private landingPrompt(node: ShipGraphNode): string {
    const n = /^landing:(\d+)$/u.exec(node.id)?.[1] ?? ''
    return [
      `Ticket ${n}: ${node.title}`,
      `Bound spec: ${this.followedSpec ?? ''}`,
      'Implement only this ticket in this worktree. Do not tick the plan checkbox; Claim is already written.',
      'Return at most 20 lines naming the result plus evidence paths. Children never commit.',
    ].join('\n')
  }

  private async commitClaim(graphKey: string): Promise<void> {
    const slug = this.slug()
    if (slug === undefined) return
    const n = Number(graphKey.split(':')[1])
    const path = this.scratchFile(join(this.cwd, '.scratch', slug, 'issues'), n)
    if (path === undefined) return
    await this.git(['add', '--', path])
    await this.git(['commit', '-m', `ship: claim ${graphKey}`])
  }

  private async dispatchChild(
    node: ShipGraphNode,
    prompt: string,
    opts: { cwd?: string; role?: 'conflict' | 'repair' } = {},
  ): Promise<void> {
    const create = this.ports.childCreate
    if (create === undefined) return
    const cwd = opts.role === 'repair' ? (opts.cwd ?? this.cwd) : opts.cwd ?? await this.ensureWorktree(node.id)
    const n = /^landing:(\d+)$/u.exec(node.id)?.[1]
    const label = n === undefined ? node.title : `Ticket ${n}: ${node.title}`
    try {
      const handle = await create.create({
        graphKey: node.id,
        label,
        prompt,
        ...(cwd === undefined ? {} : { cwd }),
        ...(opts.role === undefined ? {} : { role: opts.role }),
      })
      const landingId = this.landingTicketId(node.id)
      const tracked: ShipChildHandle = {
        ...handle,
        ...(opts.role === undefined ? {} : { role: opts.role }),
        ...(landingId === undefined || handle.done === undefined
          ? {}
          : {
              done: Promise.resolve(handle.done).then(
                () => { this.finishedLanding.add(landingId) },
                () => { this.crashedLanding.add(landingId) },
              ),
            }),
      }
      this.children.set(tracked.id, tracked)
      if (this.ports.isTty !== false) this.ports.folds?.bind(tracked.id, label)
      if (landingId === undefined && tracked.done !== undefined) {
        void tracked.done.then(() => this.releaseChild(tracked.id), () => this.releaseChild(tracked.id))
      }
    } catch {
      this.ports.flash?.(`Could not dispatch ${label}`)
      if (opts.role === 'repair') {
        this.inPlaceTicketId = undefined
        this.inPlacePreHead = undefined
      }
    }
  }

  private async ensureWorktree(graphKey: string): Promise<string | undefined> {
    const abs = this.worktreePath(graphKey)
    const slug = this.slug()
    const directory = worktreeDirectory(graphKey)
    if (abs === undefined || slug === undefined || directory === undefined) return undefined
    const root = join(this.cwd, '.scratch', slug, 'worktrees')
    mkdirSync(root, { recursive: true })
    const ignore = join(root, '.gitignore')
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
    if (!existsSync(abs)) {
      await this.git(['worktree', 'add', '-B', `wt/${slug}/${directory}`, abs])
      if (!existsSync(abs)) mkdirSync(abs, { recursive: true })
    }
    return abs
  }

  private async git(args: readonly string[], cwd = this.cwd): Promise<{ code: number; output: string }> {
    if (this.ports.git !== undefined) return this.ports.git(args, cwd)
    try {
      const result = await capture('git', args, { cwd })
      return { code: result.code ?? 1, output: result.output }
    } catch {
      return { code: 1, output: '' }
    }
  }

  private async gitAsHost(args: readonly string[], cwd = this.cwd): Promise<{ code: number; output: string }> {
    const identity = await this.hostGitIdentity()
    return this.git(['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, ...args], cwd)
  }

  private async hostGitIdentity(): Promise<{ name: string; email: string }> {
    if (this.gitIdentity !== undefined) return this.gitIdentity
    const name = (await this.git(['config', 'user.name'])).output.trim() || 'unknown'
    const email = (await this.git(['config', 'user.email'])).output.trim() || 'unknown@unknown'
    this.gitIdentity = { name, email }
    return this.gitIdentity
  }

  private landingTicketId(graphKey: string): string | undefined {
    return /^landing:(\d+)$/u.exec(graphKey)?.[1]
  }

  private landingStopped(): boolean {
    return this.halted || this.advance?.signal.aborted === true || this.inPlanMode() || !this.guardContract()
  }

  /** Drain freeze: no further serial merges. In-flight children still settle. */
  private landingDrainFrozen(): boolean {
    return this.landingFrozen || parseShipBlocker(this.followedMarkdown() ?? '') !== undefined
  }

  /** True when dispatch, in-place, or Ready-set can still move without a freeze. */
  private canProgressLanding(): boolean {
    if (this.landingDrainFrozen()) return false
    if (this.inPlaceTicketId !== undefined || this.hasRepairChild()) return true
    const view = this.waveView()
    if (readySet(view).length > 0) return true
    const closed = new Set(view.tickets.filter(ticket => ticket.done).map(ticket => ticket.id))
    return view.tickets.some(ticket => {
      if (ticket.done) return false
      if (!ticket.blockers.every(id => closed.has(id))) return false
      if (view.claimed.has(ticket.id)) {
        return !view.worktrees.has(ticket.id) && !view.inFlight.has(ticket.id)
      }
      return !this.hasChildFor(`landing:${ticket.id}`)
    })
  }

  private waveView(): LandingWaveView {
    const tickets = landingPlan(this.followedMarkdown() ?? '').tickets
    const claimed = new Set<string>()
    for (const node of this.graph?.nodes ?? []) {
      if (node.kind !== 'landing' || (node.claim !== 'claimed' && node.claim !== 'closed')) continue
      const id = this.landingTicketId(node.id)
      if (id !== undefined) claimed.add(id)
    }
    const inFlight = new Set<string>()
    for (const child of this.children.values()) {
      const id = this.landingTicketId(child.graphKey)
      if (id === undefined || this.finishedLanding.has(id) || this.crashedLanding.has(id)) continue
      inFlight.add(id)
    }
    const worktrees = new Set<string>()
    for (const ticket of tickets) {
      if (this.leftoverWorktree(`landing:${ticket.id}`)) worktrees.add(ticket.id)
    }
    return {
      tickets,
      claimed,
      inFlight,
      finished: new Set(this.finishedLanding),
      worktrees,
    }
  }

  /**
   * Landing wave: dispatch is host-plane; this loop serial-merges Ready-set
   * and proves. No parent turn per ticket and no n*3+1 breaker.
   */
  private async runLanding(turn: ShipTurn): Promise<void> {
    const initial = landingPlan(this.followedMarkdown() ?? '')
    if (initial.tickets.length === 0) {
      this.block('Ship landing requires a non-empty approved ## Plan. Stopped; restore the approved tickets.')
      return
    }
    if (initial.error !== undefined) { this.block(initial.error); return }
    while (!this.landingStopped()) {
      const markdown = this.followedMarkdown() ?? ''
      const blocker = parseShipBlocker(markdown)
      if (blocker !== undefined && this.waveView().inFlight.size === 0 && !this.hasRepairChild()) {
        this.landingFrozen = true
        this.block(`Ship has an unresolved ## Blocker. Stopped; resolve it before resuming.\n${blocker}`)
        return
      }
      const plan = landingPlan(markdown)
      if (plan.error !== undefined) { this.block(plan.error); return }
      if (!sameLandingPlan(initial, plan)) {
        this.block('Approved ship plan changed during a ticket turn. Stopped; restore the plan before resuming.')
        return
      }
      if (plan.tickets.every(ticket => ticket.done) && parseShipBlocker(this.followedMarkdown() ?? '') === undefined) {
        await this.runLandingVerification(turn, plan)
        return
      }
      await this.syncCompass()
      await this.reclaimAndDispatch()
      await Promise.resolve()
      if (this.landingStopped()) return
      await this.settleCrashedRepairs()
      await this.settleFinishedRepairs()
      if (this.landingStopped()) return
      if (!this.landingDrainFrozen()) await this.drainReadySet()
      if (this.landingStopped()) return
      if (landingPlan(this.followedMarkdown() ?? '').tickets.every(ticket => ticket.done)
        && parseShipBlocker(this.followedMarkdown() ?? '') === undefined) continue
      if (this.waveView().inFlight.size > 0) {
        if (!await this.waitForLandingChild()) return
        continue
      }
      if (this.landingDrainFrozen()) {
        this.landingFrozen = true
        const recorded = parseShipBlocker(this.followedMarkdown() ?? '')
        if (recorded !== undefined) {
          this.block(`Ship has an unresolved ## Blocker. Stopped; resolve it before resuming.\n${recorded}`)
        }
        return
      }
      if (this.ports.childCreate === undefined) {
        const before = landingPlan(this.followedMarkdown() ?? '')
        await this.spendTurn(turn)
        const after = landingPlan(this.followedMarkdown() ?? '')
        if (after.tickets.every(ticket => ticket.done) && !this.landingStopped()) {
          await this.runLandingVerification(turn, after)
        } else if (after.tickets.some((ticket, index) => ticket.done && !before.tickets[index]?.done)) {
          continue
        }
        return
      }
      if (this.canProgressLanding()) continue
      return
    }
  }

  private async drainReadySet(): Promise<boolean> {
    let any = false
    for (;;) {
      if (this.landingStopped() || this.landingDrainFrozen()) return any
      this.rebuildGraph()
      const next = readySet(this.waveView())[0]
      if (next === undefined) return any
      await this.landTicket(next)
      any = true
    }
  }

  private async waitForLandingChild(): Promise<boolean> {
    const pending = [...this.children.values()].filter(child => {
      const id = this.landingTicketId(child.graphKey)
      return id !== undefined
        && !this.finishedLanding.has(id)
        && !this.crashedLanding.has(id)
        && child.done !== undefined
    })
    if (pending.length === 0) return this.crashedLanding.size > 0
    const abort = this.advance?.signal
    await new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        abort?.removeEventListener('abort', finish)
        resolve()
      }
      abort?.addEventListener('abort', finish, { once: true })
      void Promise.race(pending.map(child => child.done ?? Promise.resolve())).then(finish, finish)
    })
    return this.advance?.signal.aborted !== true && !this.inPlanMode() && this.guardContract()
  }

  private async landTicket(ticket: LandingTicket): Promise<void> {
    const slug = this.slug()
    const graphKey = `landing:${ticket.id}`
    const directory = worktreeDirectory(graphKey)
    const worktree = this.worktreePath(graphKey)
    if (slug === undefined || directory === undefined || worktree === undefined) return
    const ref = `wt/${slug}/${directory}`
    await this.git(['add', '-A'], worktree)
    await this.gitAsHost(['commit', '-m', worktreeCommitMessage(ticket)], worktree)
    if (this.landingStopped() || this.landingDrainFrozen()) return
    const merged = await this.gitAsHost(['merge', '--no-ff', '-m', landMergeMessage(ticket), ref])
    if (merged.code !== 0) {
      await this.git(['merge', '--abort'])
      this.block(`Landing merge conflict on Ticket ${ticket.id}. Stopped; keep the worktree and ref.`)
      return
    }
    await this.git(['worktree', 'remove', '--force', worktree])
    await this.git(['branch', '-D', ref])
    try { rmSync(worktree, { recursive: true, force: true }) } catch { /* leftover checkout must not block drain */ }
    this.finishedLanding.delete(ticket.id)
    for (const child of [...this.children.values()]) {
      if (child.graphKey === graphKey) await this.releaseChild(child.id)
    }
    if (this.landingStopped()) return
    const color = await this.proveTicket(ticket, 'land')
    this.writeLandingProof(Number(ticket.id), color)
    await this.commitProofSweep(
      color === 'green' ? ticket : undefined,
      color === 'red' ? [ticket] : [],
    )
    this.refresh()
    this.persistSnapshot()
    this.rebuildGraph()
  }

  private async proveTicket(ticket: LandingTicket, kind: 'sweep' | 'land'): Promise<'green' | 'red'> {
    if (this.ports.prove === undefined) return 'green'
    return this.ports.prove({ id: ticket.id, contract: ticket.contract, kind })
  }

  private tickCheckbox(markdown: string, id: string, done: boolean): string {
    const mark = done ? 'x' : ' '
    return markdown.replace(
      new RegExp(`^([ \\t]*[-*][ \\t]+)\\[[ xX]\\]([ \\t]+Ticket\\s+${id}:)`, 'imu'),
      `$1[${mark}]$2`,
    )
  }

  /**
   * After a land merge and after a Tick: named proofs of currently-已关闭
   * plus already-landed 已认领 whose blockers are 已关闭. One ledger commit.
   */
  private async commitProofSweep(
    ticked: LandingTicket | undefined,
    seedFailed: readonly LandingTicket[] = [],
  ): Promise<void> {
    const specPath = this.followedSpec
    if (specPath === undefined) return
    if (ticked !== undefined) {
      const tickedMarkdown = this.tickCheckbox(this.followedMarkdown() ?? '', ticked.id, true)
      writeFileSync(specPath, tickedMarkdown.endsWith('\n') ? tickedMarkdown : `${tickedMarkdown}\n`)
    }
    this.refresh()
    this.rebuildGraph()
    const view = this.waveView()
    const failed: LandingTicket[] = [...seedFailed]
    const skip = new Set([
      ...seedFailed.map(ticket => ticket.id),
      ...(ticked === undefined ? [] : [ticked.id]),
    ])
    for (const ticket of sweepProofTargets(view)) {
      if (skip.has(ticket.id)) continue
      const color = await this.proveTicket(ticket, 'sweep')
      if (color === 'red') {
        failed.push(ticket)
        this.writeLandingProof(Number(ticket.id), 'red')
      }
    }
    const closedDependents = cascadeClosedDependents(
      landingPlan(this.followedMarkdown() ?? '').tickets,
      new Set(failed.map(ticket => ticket.id)),
    )
    let markdown = this.followedMarkdown() ?? ''
    for (const ticket of failed) markdown = this.tickCheckbox(markdown, ticket.id, false)
    for (const id of closedDependents) markdown = this.tickCheckbox(markdown, id, false)
    if (failed.length > 0) markdown = writeBlockerSection(markdown, sweepBlockerBody(failed))
    writeFileSync(specPath, markdown.endsWith('\n') ? markdown : `${markdown}\n`)
    const slug = this.slug()
    const scratchPaths: string[] = []
    if (slug !== undefined) {
      const ids = new Set([
        ...(ticked === undefined ? [] : [ticked.id]),
        ...failed.map(ticket => ticket.id),
      ])
      for (const id of ids) {
        const path = this.scratchFile(join(this.cwd, '.scratch', slug, 'issues'), Number(id))
        if (path !== undefined) scratchPaths.push(path)
      }
    }
    await this.git(['add', '--', specPath, ...scratchPaths])
    await this.gitAsHost(['commit', '-m', proofSweepCommitMessage(ticked, failed)])
    if (failed.length > 0) {
      this.landingFrozen = true
      await this.dropDispatchedDependents(new Set(failed.map(ticket => ticket.id)))
    }
  }

  private async dropDispatchedDependents(failed: ReadonlySet<string>): Promise<void> {
    const tickets = landingPlan(this.followedMarkdown() ?? '').tickets
    const dispatched = new Set<string>()
    for (const ticket of tickets) {
      const graphKey = `landing:${ticket.id}`
      if (this.leftoverWorktree(graphKey) || this.hasChildFor(graphKey)) dispatched.add(ticket.id)
    }
    const drop = dispatchedDependents(tickets, failed, dispatched)
    const slug = this.slug()
    for (const id of drop) {
      const graphKey = `landing:${id}`
      const worktree = this.worktreePath(graphKey)
      const directory = worktreeDirectory(graphKey)
      if (worktree === undefined || directory === undefined || slug === undefined) continue
      const ref = `wt/${slug}/${directory}`
      await this.git(['worktree', 'remove', '--force', worktree])
      await this.git(['branch', '-D', ref])
      try { rmSync(worktree, { recursive: true, force: true }) } catch { /* Claim stays; same landing-N names */ }
      this.finishedLanding.delete(id)
      for (const child of [...this.children.values()]) {
        if (child.graphKey === graphKey) await this.releaseChild(child.id)
      }
    }
  }

  private async settleFinishedRepairs(): Promise<void> {
    const id = this.inPlaceTicketId
    if (id === undefined || !this.finishedLanding.has(id)) return
    const ticket = landingPlan(this.followedMarkdown() ?? '').tickets.find(row => row.id === id)
    for (const child of [...this.children.values()]) {
      if (child.role === 'repair' && this.landingTicketId(child.graphKey) === id) await this.releaseChild(child.id)
    }
    this.inPlaceTicketId = undefined
    this.inPlacePreHead = undefined
    this.finishedLanding.delete(id)
    if (ticket === undefined) return
    const color = await this.proveTicket(ticket, 'land')
    this.writeLandingProof(Number(ticket.id), color)
    await this.commitProofSweep(
      color === 'green' ? ticket : undefined,
      color === 'red' ? [ticket] : [],
    )
    this.refresh()
    this.persistSnapshot()
    this.rebuildGraph()
  }

  private async settleCrashedRepairs(): Promise<void> {
    const crashed = [...this.crashedLanding]
    if (crashed.length === 0) return
    this.crashedLanding.clear()
    for (const id of crashed) {
      if (this.inPlaceTicketId === id) {
        await this.failInPlaceRepair(id)
        continue
      }
      this.finishedLanding.add(id)
    }
  }

  private async interruptInPlaceRepair(): Promise<void> {
    const id = this.inPlaceTicketId
    const head = this.inPlacePreHead
    if (id === undefined) return
    this.inPlaceTicketId = undefined
    this.inPlacePreHead = undefined
    for (const child of [...this.children.values()]) {
      if (child.role === 'repair' && this.landingTicketId(child.graphKey) === id) await this.releaseChild(child.id)
    }
    if (head !== undefined && head !== '') await this.git(['reset', '--hard', head])
  }

  private async failInPlaceRepair(id: string): Promise<void> {
    const head = this.inPlacePreHead
    const ticket = landingPlan(this.followedMarkdown() ?? '').tickets.find(row => row.id === id)
    await this.writeMergeSnapshot(id)
    if (head !== undefined && head !== '') await this.git(['reset', '--hard', head])
    for (const child of [...this.children.values()]) {
      if (child.role === 'repair' && this.landingTicketId(child.graphKey) === id) await this.releaseChild(child.id)
    }
    this.inPlaceTicketId = undefined
    this.inPlacePreHead = undefined
    this.landingFrozen = true
    const specPath = this.followedSpec
    if (specPath === undefined) return
    const body = ticket === undefined
      ? `- Ticket ${id} (In-place repair crashed)`
      : sweepBlockerBody([ticket])
    const markdown = writeBlockerSection(this.followedMarkdown() ?? '', body)
    writeFileSync(specPath, markdown.endsWith('\n') ? markdown : `${markdown}\n`)
    const slug = this.slug()
    const snapshotIgnore = slug === undefined
      ? undefined
      : join(this.cwd, '.scratch', slug, 'merge-snapshots', '.gitignore')
    await this.git(['add', '--', specPath, ...(snapshotIgnore === undefined ? [] : [snapshotIgnore])])
    await this.git(['add', '-f', '--', ...(await this.mergeSnapshotPaths(id))])
    await this.gitAsHost(['commit', '-m', `ship: Blocker Ticket ${id} — In-place repair crashed`])
    this.block(`Ship has an unresolved ## Blocker. Stopped; resolve it before resuming.\n${body}`)
  }

  private async writeMergeSnapshot(id: string): Promise<void> {
    const slug = this.slug()
    if (slug === undefined) return
    const directory = worktreeDirectory(`landing:${id}`) ?? `landing-${id}`
    const utc = new Date().toISOString().replace(/[:.]/gu, '-')
    const root = join(this.cwd, '.scratch', slug, 'merge-snapshots')
    mkdirSync(root, { recursive: true })
    const ignore = join(root, '.gitignore')
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
    const dest = join(root, directory, utc)
    mkdirSync(dest, { recursive: true })
    const status = await this.git(['status', '--porcelain'])
    writeFileSync(join(dest, 'status.txt'), status.output)
    writeFileSync(join(dest, 'note.txt'), `In-place repair of Ticket ${id} crashed or timed out.\n`)
  }

  private async mergeSnapshotPaths(id: string): Promise<string[]> {
    const slug = this.slug()
    const directory = worktreeDirectory(`landing:${id}`) ?? `landing-${id}`
    if (slug === undefined) return []
    const root = join(this.cwd, '.scratch', slug, 'merge-snapshots', directory)
    try {
      return readdirSync(root).map(name => join(root, name))
    } catch {
      return []
    }
  }

  private writeLandingProof(n: number, color: 'green' | 'red'): void {
    const slug = this.slug()
    if (slug === undefined) return
    const path = this.scratchFile(join(this.cwd, '.scratch', slug, 'issues'), n)
    if (path === undefined) return
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return
    }
    const line = `Proof: ${color}`
    const next = /^Proof:\s*/imu.test(text)
      ? text.replace(/^Proof:\s*.*$/imu, line)
      : /^Claim:\s*.*$/imu.test(text)
        ? text.replace(/^(Claim:\s*.*)$/imu, `$1\n${line}`)
        : `${line}\n${text}`
    writeFileSync(path, next.endsWith('\n') ? next : `${next}\n`)
  }

  private async runLandingVerification(turn: ShipTurn, before: LandingPlan): Promise<void> {
    if (this.landingStopped()) return
    await this.syncCompass()
    await this.spendTurn(turn)
    if (this.landingStopped()) return
    const afterMarkdown = this.followedMarkdown() ?? ''
    const after = landingPlan(afterMarkdown)
    if (!sameLandingPlan(before, after)) {
      this.block('Approved ship plan changed during a ticket turn. Stopped; restore the plan before resuming.')
      return
    }
    const next = shipPhaseKind(this.status())
    if (next === 'done') {
      if (after.tickets.some(ticket => !ticket.done) || parseShipBlocker(afterMarkdown) !== undefined) {
        this.block('Ship may finish only in a separate final verification turn after every ticket is checked.')
        return
      }
      this.verifyAndReconcile(false)
      if (this.sealedContract?.acceptance.length && !this.lastVerify?.satisfied) {
        const current = this.followedMarkdown()
        if (current !== undefined && this.followedSpec !== undefined) {
          writeFileSync(this.followedSpec, current.replace(/^Status:\s*shipped\b/imu, 'Status: landing'))
        }
        this.block('Verifier: acceptance evidence incomplete. Delivery blocked; restore proof evidence before resuming.')
      }
      return
    }
    if (next !== 'land') this.block(`Invalid ship phase transition during landing: ${next}. Stopped.`)
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
