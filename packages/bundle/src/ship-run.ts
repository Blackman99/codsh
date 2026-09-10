/**
 * One `/ship` run: the spec file is memory, Chrome follows it, and each
 * turn injects only the phase Status names.
 *
 * The runner calls {@link ShipRun.run} for the canned command, {@link
 * ShipRun.noteWritten} when a tool writes markdown, and {@link ShipRun.abort}
 * on Esc. Chip, plan, poll, and phase injection stay behind this seam.
 * @module codsh-bundle/src/ship-run
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseShipStatus, pickLiveShip, planInFlight, plansEqual } from './plan.ts'
import type { Plan, ShipSpecFile } from './plan.ts'
import { expandTemplate } from './custom-commands.ts'
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

  constructor(
    private readonly cwd: string,
    private readonly chrome: ShipChrome,
  ) {}

  /** The MetaBar chip Chrome should paint, absent when `/ship` is idle. */
  get shipChip(): ShipChip | undefined {
    return this.chip
  }

  /** The pinned plan, absent before tickets exist or after shipped. */
  get shipPlan(): Plan | undefined {
    return this.plan
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
    this.startWatch()
    this.refresh()
    if (this.chip === undefined) this.setChip({ kind: 'grill' })
    this.advance?.abort()
    const advance = new AbortController()
    this.advance = advance
    try {
      let previous = shipPhaseKind(this.status())
      await turn(expandTemplate(shipPromptFor(this.status()), idea))
      while (!advance.signal.aborted) {
        this.refresh()
        const next = shipPhaseKind(this.status())
        if (next === previous || next === 'done' || next === 'grill') break
        previous = next
        await turn(expandTemplate(shipPromptFor(this.status()), idea))
      }
    } finally {
      if (this.advance === advance) {
        this.advance = undefined
        this.stopWatch()
        this.refresh()
      }
    }
  }

  private status() {
    for (const path of this.specPaths()) {
      try {
        const status = parseShipStatus(readFileSync(path, 'utf8'))
        if (status !== undefined && status !== 'shipped') return status
      } catch {
        // A spec that moved is not the phase ledger.
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
