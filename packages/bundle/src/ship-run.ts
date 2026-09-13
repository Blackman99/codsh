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

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMainTrack, parseShipStatus, parseSpecMetadata, pickLiveShip, planInFlight, plansEqual } from './plan.ts'
import type { Plan, ShipSpecFile } from './plan.ts'
import { expandTemplate } from './custom-commands.ts'
import type { SelectAsk } from './questions.ts'
import {
  compileMissionContract,
  mainTrackDrifted,
  missionContractSummary,
  slugFromSpec,
  writeMissionContract,
} from './mission.ts'
import type { MissionContract } from './mission.ts'
import { shipPhaseKind, shipPromptFor } from './ship.ts'
import { sameShipChip, shipChipFromSpec } from './status.ts'
import type { ShipChip } from './status.ts'

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
  flash?: ShipFlash
}

/** Occupancy Selector title/header — a Selector, not a ship gate modal. */
export const SHIP_OCCUPANCY_TITLE = 'ship · occupancy'

/** Prefix that marks a session compass as ours. */
const SHIP_OBJECTIVE_PREFIX = '[ship] '

/** Flash when the harness compass cannot be updated. */
const GOAL_DEGRADED = '/goal was not updated'

/** Flash when a sealed Main Track rewrite is ignored for this run. */
const TRACK_REWRITE_IGNORED = 'Main Track rewrite ignored — sealed Mission Contract holds'

/** What the runner must do to spend a canned-command turn. */
export interface ShipTurn {
  (prompt: string): Promise<void>
}

/**
 * One `/ship` run against a workspace.
 *
 * Construction is cheap; {@link ShipRun.run} is the canned command. Disk
 * reads stay inside the module (in-process filesystem, no port).
 */
export class ShipRun {
  private readonly writtenDocs: string[] = []
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
  /** Spec this run is following; complete only if this file becomes shipped. */
  private followedSpec: string | undefined

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
    if (paths.some(path => path.endsWith('.md'))) this.refresh()
  }

  /** Re-read the live spec so the plan row and chip match the file on disk. */
  refresh(): void {
    if (this.sealedTrack !== undefined) this.detectTrackRewrite()
    const files: ShipSpecFile[] = []
    for (const path of this.specPaths()) {
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
    this.advance?.abort()
    this.stopWatch()
  }

  /**
   * Run the canned `/ship` command: inject the current phase, then the next
   * when Status advances, until grill/done or Esc.
   * @param idea - the typed one-sentence requirement.
   * @param turn - spends one canned-command turn.
   */
  async run(idea: string, turn: ShipTurn): Promise<void> {
    this.chipCleared = false
    this.lastDone = undefined
    this.goalId = undefined
    this.sealedTrack = undefined
    this.sealedContract = undefined
    this.sealedContractPath = undefined
    this.followedSpec = undefined
    this.startWatch()
    this.refresh()
    if (this.chip === undefined) this.setChip({ kind: 'grill' })
    this.advance?.abort()
    const advance = new AbortController()
    this.advance = advance
    try {
      if (!await this.occupy(idea)) return
      let previous = shipPhaseKind(this.status())
      await this.syncCompass()
      await turn(expandTemplate(this.promptFor(), idea))
      while (!advance.signal.aborted) {
        this.refresh()
        await this.syncCompass()
        const next = shipPhaseKind(this.status())
        if (next === previous || next === 'done' || next === 'grill') break
        previous = next
        await turn(expandTemplate(this.promptFor(), idea))
      }
    } finally {
      if (this.advance === advance) {
        this.advance = undefined
        this.stopWatch()
        this.refresh()
        if (!advance.signal.aborted && this.followedIsShipped()) await this.completeShipGoal()
      }
    }
  }

  /**
   * Take the session compass before the first phase turn. Missing or throwing
   * goals degrade; a stranger is paused then asked; ours is reused.
   * @param idea - the typed one-sentence requirement.
   * @returns false when occupancy Abort stops the run without injecting.
   */
  private async occupy(idea: string): Promise<boolean> {
    if (this.ports.goals === undefined) {
      this.degrade()
      return true
    }
    try {
      const current = await this.ports.goals.get()
      if (current === undefined || current.phase === 'complete') {
        await this.createPlaceholder(idea)
        return true
      }
      if (this.ours(current)) {
        await this.ports.goals.edit(current.id, `${SHIP_OBJECTIVE_PREFIX}${idea}`)
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
      await this.createPlaceholder(idea)
      return true
    } catch {
      this.degrade()
      return true
    }
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

  /** Create `[ship] <idea>` then pause before the first turn is awaited. */
  private async createPlaceholder(idea: string): Promise<void> {
    const goals = this.ports.goals
    if (goals === undefined) return
    try {
      const created = await goals.create(`${SHIP_OBJECTIVE_PREFIX}${idea}`)
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
    for (const path of this.specPaths()) {
      try {
        const id = parseSpecMetadata(readFileSync(path, 'utf8')).goalId
        if (id !== undefined) return id
      } catch {
        // A spec that moved is not occupancy's ours-marker.
      }
    }
    return undefined
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
   * Phase prompt plus Goal-Id and the Main Track compass. After Confirm the
   * track is the process snapshot, not a live reread the agent can rewrite.
   * Land (and later) also carry the spec path so Ralph's objective can cite it.
   */
  private promptFor(): string {
    const status = this.status()
    const track = this.trackForPrompt()
    const mission = this.missionForPrompt()
    const prepend = [track, mission].filter((part): part is string => part !== undefined).join('\n\n')
    const prompt = shipPromptFor(status, {
      ...(this.goalId === undefined ? {} : { goalId: this.goalId }),
      ...(prepend === '' ? {} : { track: prepend }),
    })
    const kind = shipPhaseKind(status)
    if (kind !== 'land' && kind !== 'done') return prompt
    const specPath = this.liveSpecPath()
    return specPath === undefined ? prompt : `${prompt}\n\n${specPath}`
  }

  /** Complete the ship compass when this run's spec is shipped. */
  private async completeShipGoal(): Promise<void> {
    const goals = this.ports.goals
    if (goals === undefined || this.goalId === undefined) return
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
   * Draft track from disk until Confirm; then freeze a snapshot for this run.
   * Interviewing still prepends the live draft; later phases keep the seal.
   * Confirm also compiles and writes the Mission Contract JSON the runner owns.
   */
  private trackForPrompt(): string | undefined {
    if (this.sealedTrack !== undefined) {
      this.detectTrackRewrite()
      return this.sealedTrack
    }
    const live = this.liveTrack()
    if (live === undefined) return undefined
    const status = this.status()
    if (status === 'confirmed' || status === 'planned' || status === 'landing') {
      this.sealedTrack = live
      this.sealMissionContract()
    }
    return live
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
    if (this.sealedContract !== undefined) return
    const specPath = this.liveSpecPath()
    if (specPath === undefined) return
    try {
      const markdown = readFileSync(specPath, 'utf8')
      const slug = slugFromSpec(markdown, specPath)
      const contract = compileMissionContract(markdown, { id: slug })
      this.sealedContract = contract
      this.sealedContractPath = writeMissionContract(this.cwd, slug, contract)
    } catch {
      // Spec unreadable or disk full: track snapshot still binds later phases.
    }
  }

  /**
   * If the live Main Track diverges from the seal, keep the seal and flash —
   * mechanical immutability, not prompt-only.
   */
  private detectTrackRewrite(): void {
    if (this.sealedContract === undefined) return
    const specPath = this.followedSpec ?? this.liveSpecPath()
    if (specPath === undefined) return
    try {
      const live = readFileSync(specPath, 'utf8')
      if (mainTrackDrifted(this.sealedContract.mainTrackMarkdown, live)) {
        this.ports.flash?.(TRACK_REWRITE_IGNORED)
      }
    } catch {
      // A missing spec is not a rewrite.
    }
  }

  /** Compact Main Track on disk, headed so later phases prepend a real section. */
  private liveTrack(): string | undefined {
    for (const path of this.specPaths()) {
      try {
        const body = parseMainTrack(readFileSync(path, 'utf8'))
        if (body !== undefined) return `## Main Track\n\n${body}`
      } catch {
        // A spec that moved is not the compass.
      }
    }
    return undefined
  }

  private status() {
    for (const path of this.specPaths()) {
      try {
        const status = parseShipStatus(readFileSync(path, 'utf8'))
        if (status !== undefined && status !== 'shipped') {
          this.followedSpec = path
          return status
        }
      } catch {
        // A spec that moved is not the phase ledger.
      }
    }
    return undefined
  }

  /** Path of the live spec, including a session-written shipped file. */
  private liveSpecPath(): string | undefined {
    for (const path of this.specPaths()) {
      try {
        if (parseShipStatus(readFileSync(path, 'utf8')) !== undefined) return path
      } catch {
        // A spec that moved is not the compass path.
      }
    }
    return undefined
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
