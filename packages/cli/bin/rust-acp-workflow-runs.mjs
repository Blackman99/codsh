/**
 * Workflow run bookkeeping for the Rust client (ticket 183): the reference
 * tracker statuses, session-unique display names, the `/workflow` runs
 * overview and management replies, the completion reminder, and the run
 * store under the session directory. Nothing here starts a process; the
 * workflow tool module owns the engine and the children.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const MAX_ACTIVE_RUNS = 4
export const MAX_AGENT_ROWS = 256
export const MAX_AGENT_BUDGET = 1024
const OBJECTIVE_CAP = 256
const RESULT_CAP = 4 * 1024

/** Reference `WorkflowRunStatus` values (snake_case). */
export const STATUSES = [
  'active', 'user_paused', 'back_off_paused', 'no_progress_paused', 'infra_paused',
  'blocked', 'budget_limited', 'interrupted', 'complete', 'failed', 'cancelled',
]
export const isTerminal = status => status === 'interrupted' || status === 'complete' || status === 'failed' || status === 'cancelled'
export const isPaused = status => status === 'user_paused' || status === 'back_off_paused' || status === 'no_progress_paused' || status === 'infra_paused' || status === 'blocked' || status === 'budget_limited'
/** A completion notice is due: the run ended or hit its agent budget. */
export const isReportable = status => isTerminal(status) || status === 'budget_limited'
export const isResumable = status => isPaused(status) || status === 'failed' || status === 'cancelled'
/** Reference `accepts`: pause only an active run; stop any run not yet reportable. */
export function accepts(status, op) {
  if (op === 'pause') return status === 'active'
  if (op === 'stop') return !isReportable(status)
  return false
}

/** Engine pause kinds to tracker statuses (reference mapping). */
export function pauseStatus(kind) {
  switch (kind) {
    case 'user': return 'user_paused'
    case 'back_off': return 'back_off_paused'
    case 'no_progress': return 'no_progress_paused'
    case 'verification': return 'blocked'
    case 'infra': return 'infra_paused'
    default: return 'user_paused'
  }
}

/** `wf_` + a UUID v7 in simple (hex, no dashes) form, like the reference. */
export function newRunId(now = Date.now()) {
  const bytes = randomBytes(16)
  let ms = BigInt(now)
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(ms & 0xffn)
    ms >>= 8n
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return `wf_${bytes.toString('hex')}`
}

/** Reference display names: name, then name-2, name-3, ... among tracked runs. */
export function uniqueName(base, taken) {
  const names = new Set(taken)
  if (!names.has(base)) return base
  for (let n = 2; ; n += 1) {
    if (!names.has(`${base}-${n}`)) return `${base}-${n}`
  }
}

/** Reference `format_workflow_elapsed`. */
export function formatElapsed(ms) {
  const secs = Math.floor(Math.max(0, ms) / 1000)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

const squash = text => String(text ?? '').split(/\s+/).filter(Boolean).join(' ')

function truncate(text, cap) {
  const bytes = Buffer.from(text)
  if (bytes.length <= cap) return text
  return bytes.subarray(0, cap).toString('utf8').replace(/\uFFFD$/, '')
}

/** Active time so far: the persisted floor plus the live stretch. */
export function elapsedMs(run, now = Date.now()) {
  return (run.elapsedFloor ?? 0) + (run.status === 'active' && run.activeSince ? Math.max(0, now - run.activeSince) : 0)
}

export function phaseLine(run) {
  const current = run.currentPhase
  if (!current) return undefined
  const index = (run.phases ?? []).findIndex(phase => phase.title === current)
  return index >= 0 ? `Phase: ${current} (${index + 1}/${run.phases.length})` : `Phase: ${current}`
}

export function agentsLine(agents) {
  if (!agents || agents.length === 0) return undefined
  const count = state => agents.filter(agent => agent.state === state).length
  const parts = [`${count('done')} done`]
  if (count('running') > 0) parts.push(`${count('running')} running`)
  if (count('failed') > 0) parts.push(`${count('failed')} failed`)
  return `Agents: ${parts.join(', ')}`
}

/** Reference `format_workflow_runs_overview`: display names only, no run ids. */
export function formatOverview(runs, now = Date.now()) {
  if (runs.length === 0) return 'No workflow runs in this session yet. Ask the agent to run a workflow script (inline or a script_path); saved workflows cannot be launched by name in this build.'
  const ordered = [...runs].reverse().map((run, index) => ({ run, index }))
  const rank = run => (isTerminal(run.status) ? 2 : run.status === 'active' ? 0 : 1)
  ordered.sort((a, b) => rank(a.run) - rank(b.run) || a.index - b.index)
  let out = ''
  for (const { run } of ordered) {
    out += `- '${run.name}' — ${run.status.replaceAll('_', ' ')}`
    const phase = phaseLine(run)
    if (phase) out += `\n  ${phase}`
    const agents = agentsLine(run.agents)
    if (agents) out += `\n  ${agents}`
    out += `\n  Elapsed: ${formatElapsed(elapsedMs(run, now))}`
    const objective = squash(run.objective)
    if (objective) out += `\n  Objective: ${truncate(objective, OBJECTIVE_CAP)}`
    out += '\n'
  }
  return `${out}Manage with /workflow pause|resume|stop <name>.`
}

/**
 * One run of the completion reminder (reference layout). A plain `-p`
 * prompt returns the same block as the tool result of a run it waited for.
 */
export function formatRunBlock(run, { now = Date.now(), reportPath = () => undefined } = {}) {
  let buf = ''
  buf += `\n- Workflow '${run.name}' (run id ${run.id}) — status: ${run.status}`
  const objective = squash(run.objective)
  if (objective) buf += `\n  Objective: ${truncate(objective, OBJECTIVE_CAP)}`
  buf += `\n  Elapsed: ${formatElapsed(elapsedMs(run, now))}`
  if (typeof run.resultSummary === 'string') {
    const capped = truncate(run.resultSummary, RESULT_CAP)
    buf += '\n  Result:\n'
    for (const line of capped.split('\n')) buf += `    ${line}\n`
    if (Buffer.byteLength(capped) < Buffer.byteLength(run.resultSummary)) buf += `    [... result truncated (${Buffer.byteLength(run.resultSummary)} bytes total)]\n`
  } else if (run.pauseMessage) {
    const detail = squash(run.pauseMessage)
    buf += `\n  Detail: ${truncate(detail, RESULT_CAP)}${Buffer.byteLength(detail) > RESULT_CAP ? '…' : ''}\n`
  } else {
    buf += '\n'
  }
  if (run.status === 'budget_limited') {
    if ((run.agentsUsed ?? 0) >= MAX_AGENT_BUDGET) buf += '  Not resumable: this run reached the maximum agent budget; start a new workflow run.\n'
    else buf += `  Resumable: call the workflow tool with source: { type: "resume", resume_from_run_id: "${run.id}" } and a raised agent_budget (the resume is rejected while usage is at or over the cap).\n`
  }
  if (run.status === 'failed') {
    buf += `  Resumable: call the workflow tool with source: { type: "resume", resume_from_run_id: "${run.id}" } — completed agents replay from the journal and the failed step re-executes.\n`
  }
  const report = reportPath(run)
  if (report) buf += `  Full report: ${report} (use read on that path to view it)\n`
  return buf
}

/**
 * Reference `format_workflow_completion_reminder`. `reportPath(run)` names
 * scratch/report.md when the run wrote one.
 */
export function formatReminder(runs, { now = Date.now(), reportPath = () => undefined } = {}) {
  const n = runs.length
  const noun = n === 1 ? 'background workflow run' : 'background workflow runs'
  const verb = runs.some(run => !isTerminal(run.status)) ? 'stopped (finished or paused)' : 'finished'
  let buf = `While you were idle, ${n} ${noun} ${verb}:\n`
  for (const run of runs) buf += formatRunBlock(run, { now, reportPath })
  return buf
}

export const WAKE_PROMPT = 'A background workflow stopped. Review the workflow completion reminder, report the result to the user, and take any appropriate next action.'

const OPS = ['pause', 'resume', 'stop', 'save']

/**
 * Split `/workflow ...` arguments like the reference resolver: nothing or
 * `runs` is the overview, `<op> [name]` or `<name> <op>` manages a run, and
 * anything else launches a saved workflow by name.
 */
export function parseCommand(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || (words.length === 1 && words[0].toLowerCase() === 'runs')) return { kind: 'overview' }
  const first = words[0].toLowerCase()
  if (OPS.includes(first)) return { kind: 'manage', op: first, name: words.slice(1).join(' ') }
  if (words.length === 2 && OPS.includes(words[1].toLowerCase())) return { kind: 'manage', op: words[1].toLowerCase(), name: words[0] }
  return { kind: 'launch', name: words[0], args: words.slice(1).join(' ') }
}

function applies(op, run) {
  if (op === 'pause') return accepts(run.status, 'pause')
  if (op === 'stop') return accepts(run.status, 'stop')
  if (op === 'resume') return isResumable(run.status) && !run.restored
  return true
}

/** Reference `narrow_run_matches` over runs whose id or name starts with `selector`. */
export function matchRuns(runs, selector, op) {
  let all = runs.filter(run => run.id.startsWith(selector) || run.name.startsWith(selector))
  if (selector === '') return all
  const exact = all.filter(run => run.id === selector || run.name === selector)
  if (exact.length > 0) all = exact
  if (all.length > 1) {
    const applicable = all.filter(run => applies(op, run))
    if (applicable.length === 1) return applicable
  }
  return all
}

/** Reference `format_manage_needs_name`: a bare op never picks a run. */
export function needsName(op, runs) {
  if (runs.length === 0) return 'No workflow runs in this session yet.'
  const applicable = op === 'save' ? [] : runs.filter(run => applies(op, run))
  if (applicable.length === 0) return `No runs to ${op}.`
  return `Say which run to ${op}:\n${applicable.map(run => `  ${run.name} (${run.status.replaceAll('_', ' ')})`).join('\n')}\n(/workflow ${op} <name>)`
}

export const RESTART_REFUSAL = 'it was started by an earlier codsh process, and workflow runs resume only in the process that started them (process restarts are terminal)'

/**
 * One run directory: `run.json` (tracker state), `script.rhai` and
 * `launch.json` (the immutable source and args), and the engine's
 * `journal.jsonl` and `scratch/`.
 */
export class RunStore {
  constructor(sessionDir) {
    this.root = join(sessionDir, 'workflows')
  }

  dir(runId) {
    return join(this.root, runId)
  }

  journal(runId) {
    return join(this.dir(runId), 'journal.jsonl')
  }

  writeLaunch(runId, launch) {
    mkdirSync(this.dir(runId), { recursive: true })
    atomicWrite(join(this.dir(runId), 'script.rhai'), launch.script)
    atomicWrite(join(this.dir(runId), 'launch.json'), `${JSON.stringify({ args: launch.args ?? null, definition: launch.definition, scriptPath: launch.scriptPath ?? null }, null, 2)}\n`)
  }

  readLaunch(runId) {
    const script = readFileSync(join(this.dir(runId), 'script.rhai'), 'utf8')
    const launch = JSON.parse(readFileSync(join(this.dir(runId), 'launch.json'), 'utf8'))
    return { script, args: launch.args ?? null, definition: launch.definition, scriptPath: launch.scriptPath ?? null }
  }

  save(run) {
    mkdirSync(this.dir(run.id), { recursive: true })
    const { live, restored, ...state } = run
    atomicWrite(join(this.dir(run.id), 'run.json'), `${JSON.stringify(state)}\n`)
  }

  /** Every readable run.json, oldest first. */
  list() {
    let names
    try {
      names = readdirSync(this.root)
    } catch {
      return []
    }
    const runs = []
    for (const name of names) {
      if (!/^wf_[0-9a-f]+$/.test(name)) continue
      try {
        const run = JSON.parse(readFileSync(join(this.root, name, 'run.json'), 'utf8'))
        if (run && run.id === name && STATUSES.includes(run.status)) runs.push(run)
      } catch {}
    }
    return runs.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }
}

function atomicWrite(path, text) {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, text)
  renameSync(temp, path)
}
