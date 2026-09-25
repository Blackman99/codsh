/**
 * Ticket 208: the Ship extension runner drives the whole /ship flow from
 * hooks. Each scenario uses a real temporary git repository and plays the
 * parent (writes, gates, subagent results) the way dsh reports it.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleShipHook, readRunState, shipExtensionCommand } from '../src/ship-extension.ts'
import { parseWorktreeNote } from '../src/ship-extension-runner.ts'

const SESSION = 'parent'
let root = ''
let cwd = ''
let data = ''
let trees = ''

function sh(dir: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=Host', '-c', 'user.email=host@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function invocation(args: string): string {
  const body = shipExtensionCommand().replace(/^---[\s\S]*?---\n/u, '')
  return `Run the custom command \`ship:ship\` from /x/ship/commands/ship.md. Arguments: ${args}\n\n${body}`
}

type Out = { stdout: string; exitCode: number }
const parsed = (out: Out): Record<string, any> => (out.stdout === '' ? {} : JSON.parse(out.stdout))

function hook(event: string, payload: Record<string, unknown>): Record<string, any> {
  return parsed(handleShipHook({ event, payload: { sessionId: SESSION, permissionMode: 'default', cwd, ...payload }, dataDir: data, cwd }))
}

const prompt = (text: string) => hook('UserPromptSubmit', { prompt: text })
const stop = () => hook('Stop', {})
const wrote = (path: string) => hook('PostToolUse', { tool_name: 'write', tool_input: { file_path: path }, tool_response: 'ok' })
const gate = (n: 1 | 2) => hook('PreToolUse', {
  tool_name: 'ask_user_question',
  tool_input: { questions: [{ id: `g${String(n)}`, header: `ship · gate ${String(n)}/2`, question: 'Confirm?', options: [{ label: 'Confirm' }, { label: 'Edit' }, { label: 'Abort' }] }] },
})
const subagent = (call: Record<string, unknown>, result: string, failed = false) =>
  hook(failed ? 'PostToolUseFailure' : 'PostToolUse', { tool_name: 'subagent', tool_input: call, tool_response: result })

const spec = () => join(cwd, 'docs', 'specs', 'greeting.md')
const scratch = (...parts: string[]) => join(cwd, '.scratch', 'greeting', ...parts)

const HEAD = '# Greeting\n\nStatus: STATUS\nBranch: ship/greeting\nOriginal-Branch: main\n\n## Original Requirement\n\nGreet people in two ways.\n'
const TRACK = '\n## Main Track\n\nGreet people in two ways.\n\n1. Track-1: src/greet.ts says hello and hi\n2. Track-2: a notes file per greeting\n\n## Out of Scope\n\n- Anything else.\n'
const ACCEPTANCE = '\n## Acceptance Criteria\n\n1. ACC greeting works: `node -e "process.exit(0)"` exits 0\n'
const PLAN = '\n## Plan\n\n- [ ] Ticket 1: Hello — Delivers hello (Blocked by: none) (Track: 1)\n- [ ] Ticket 2: Hi — Delivers hi (Blocked by: none) (Track: 1)\n- [ ] Ticket 3: Notes — Delivers notes (Blocked by: 2) (Track: 2)\n'

function writeSpec(status: string, ...sections: string[]): void {
  mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true })
  writeFileSync(spec(), `${HEAD.replace('STATUS', status)}${sections.join('')}`)
  wrote(spec())
}

function writeIssues(): void {
  mkdirSync(scratch('issues'), { recursive: true })
  for (const [n, title] of [['01', 'hello'], ['02', 'hi'], ['03', 'notes']] as const) {
    writeFileSync(scratch('issues', `${n}-${title}.md`), `# Ticket ${String(Number(n))}: ${title}\n\n- [ ] done\n`)
  }
}

/** What dsh does for a subagent with isolation: "worktree": a worktree on HEAD. */
function child(label: string, edit: (dir: string) => void): { result: string; path: string } {
  const path = join(trees, label)
  sh(cwd, 'worktree', 'add', '-q', '-b', `codsh/${label}`, path, 'HEAD')
  edit(path)
  return {
    path,
    result: `Done.\n\nWorktree isolation: the subagent's changes stay in ${path} (branch codsh/${label}, 1 changed file(s) since its base). Nothing was applied to ${cwd}.\n  src/greet.ts\nThe user applies them with /worktree apply ${label} (or codsh --rust worktree apply ${label}) and removes the worktree with /worktree rm ${label}.`,
  }
}

function dispatches(text: string): Record<string, any>[] {
  return [...text.matchAll(/SHIP_DISPATCH (\{.*?\})(?=\s|$)/gu)].map(match => JSON.parse(match[1]!))
}

const context = (out: Record<string, any>): string => out.hookSpecificOutput?.additionalContext ?? ''
const status = () => /^Status:\s*(\S+)/mu.exec(readFileSync(spec(), 'utf8'))?.[1]

/** Drive wayfinder → grill → spec → tickets and return the first landing continuation. */
function throughGates(): Record<string, any> {
  expect(prompt(invocation('Greet people in two ways.'))).toEqual({})
  sh(cwd, 'checkout', '-q', '-b', 'ship/greeting')
  writeSpec('grilling', '\n## Wayfinder\n\nRoute: small.\n')
  const grill = stop()
  expect(grill.systemMessage).toBe('Ship · continuing: grill (Status: grilling)')
  expect(context(grill)).toContain('This turn is grill only.')
  expect(context(grill)).not.toContain('Throughout /ship, preserve the original requirement')
  writeSpec('interviewing', TRACK)
  const toSpec = stop()
  expect(context(toSpec)).toContain('This turn is to-spec (gate 1) only.')
  writeSpec('interviewing', TRACK, ACCEPTANCE)
  const first = gate(1)
  expect(first.decision).toBe('block')
  expect(first.reason).toContain('Confirmed ship · gate 1/2 automatically; Status is now confirmed')
  expect(status()).toBe('confirmed')
  expect(existsSync(scratch('mission.contract.json'))).toBe(true)
  const tickets = stop()
  expect(context(tickets)).toContain('This turn is tickets and baseline (gate 2) only.')
  expect(context(tickets)).toContain('## Mission Contract')
  writeSpec('confirmed', TRACK, ACCEPTANCE, PLAN)
  writeIssues()
  expect(gate(2).reason).toContain('Status is now planned')
  expect(status()).toBe('planned')
  return stop()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codsh-208-runner-'))
  cwd = join(root, 'repo')
  data = join(root, 'data')
  trees = join(root, 'worktrees', 'repo')
  mkdirSync(join(cwd, 'src'), { recursive: true })
  mkdirSync(trees, { recursive: true })
  writeFileSync(join(cwd, 'src', 'greet.ts'), 'export const greeting = "none"\n')
  sh(cwd, 'init', '-q', '-b', 'main')
  sh(cwd, 'add', '-A')
  sh(cwd, 'commit', '-q', '-m', 'init')
  sh(cwd, 'config', 'user.name', 'Host')
  sh(cwd, 'config', 'user.email', 'host@example.com')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ship extension runner', () => {
  it('parses the dsh worktree note', () => {
    expect(parseWorktreeNote(child('note', () => {}).result)).toEqual({ path: join(trees, 'note'), branch: 'codsh/note', id: 'note' })
    expect(parseWorktreeNote('The subagent changed no file; its worktree /x was removed.')).toBeUndefined()
  })

  it('runs the whole flow: phases, gates, a parallel wave, a conflict with a retry, verification, and Merge-back', () => {
    const wave = throughGates()
    expect(wave.systemMessage).toBe('Ship · landing: dispatching Ticket 1, Ticket 2')
    const calls = dispatches(context(wave))
    expect(calls.map(call => call.description)).toEqual(['Ship Ticket 1', 'Ship Ticket 2'])
    expect(calls.every(call => call.isolation === 'worktree')).toBe(true)
    expect(calls[0]!.prompt).toContain('Read and follow the landing brief first: .scratch/greeting/landing/landing-1.md')
    expect(readFileSync(scratch('landing', 'landing-1.md'), 'utf8')).toContain('Ship runner: the next /ship phase.')
    expect(readFileSync(scratch('issues', '01-hello.md'), 'utf8')).toMatch(/^Claim: claimed$/mu)
    expect(sh(cwd, 'log', '--format=%s')).toContain('ship: claim landing:2')
    expect(sh(cwd, 'status', '--porcelain')).toBe('')

    // Both children branch from the committed claims and edit the same line.
    const one = child('t1', dir => {
      writeFileSync(join(dir, 'src', 'greet.ts'), 'export const greeting = "hello"\n')
      writeFileSync(join(dir, 'src', 'hello.md'), 'hello\n')
    })
    const two = child('t2', dir => {
      writeFileSync(join(dir, 'src', 'greet.ts'), 'export const greeting = "hi"\n')
      writeFileSync(join(dir, 'src', 'hi.md'), 'hi\n')
    })
    const landed = subagent(calls[0]!, one.result)
    expect(landed.systemMessage).toContain('Ship · landed Ticket 1')
    expect(existsSync(one.path)).toBe(false)
    expect(readFileSync(spec(), 'utf8')).toContain('- [x] Ticket 1: Hello')
    expect(readFileSync(scratch('issues', '01-hello.md'), 'utf8')).toMatch(/^Proof: green$/mu)

    const conflicted = subagent(calls[1]!, two.result)
    expect(conflicted.systemMessage).toContain('merge conflict landing Ticket 2 (src/greet.ts)')
    const [resolver] = dispatches(conflicted.systemMessage)
    expect(resolver!.prompt).toMatch(/^Conflict-resolution for Ticket 2: Hi \(landing:2\), attempt 1 of 3\./u)
    expect(resolver!.isolation).toBeUndefined()
    expect(readFileSync(join(cwd, 'src', 'greet.ts'), 'utf8')).toContain('<<<<<<<')

    // First attempt leaves the markers: validated, rejected, retried.
    const retry = subagent(resolver!, 'I looked at it.')
    expect(retry.systemMessage).toContain('conflict-resolution attempt 1/3 did not pass validation (leftover-markers)')
    const [again] = dispatches(retry.systemMessage)
    expect(again!.prompt).toContain('attempt 2 of 3')
    expect(readFileSync(scratch('landing', 'conflict-landing-2.md'), 'utf8')).toContain('leftover-markers')

    writeFileSync(join(cwd, 'src', 'greet.ts'), 'export const greeting = "hello and hi"\n')
    const resolved = subagent(again!, 'Resolved.')
    expect(resolved.systemMessage).toContain('Ticket 2 conflict resolved; landed and ticked.')
    // Ticket 3 was blocked by 2: claimed and dispatched through the note.
    const [third] = dispatches(resolved.systemMessage)
    expect(third!.description).toBe('Ship Ticket 3')
    expect(existsSync(two.path)).toBe(false)

    const three = child('t3', dir => writeFileSync(join(dir, 'NOTES.md'), 'notes\n'))
    expect(subagent(third!, three.result).systemMessage).toContain('Ship · landed Ticket 3')
    const log = sh(cwd, 'log', '--format=%s')
    expect(log).toContain('ship: land Ticket 1 — Hello')
    expect(log).toContain('ship: tick Ticket 2 — Hi')

    const verify = stop()
    expect(verify.systemMessage).toBe('Ship · continuing: final verification (Status: planned)')
    expect(context(verify)).toContain('This turn is final verification only')

    writeFileSync(spec(), readFileSync(spec(), 'utf8').replace('Status: planned', 'Status: shipped') + '\n## Verification\n\n- ACC-001: `node -e "process.exit(0)"` exit 0\n')
    wrote(spec())
    const done = stop()
    expect(done.systemMessage).toBe('Ship · shipped: Merge back fast-forwarded main to ship/greeting.')
    expect(sh(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(readFileSync(join(cwd, 'src', 'greet.ts'), 'utf8')).toBe('export const greeting = "hello and hi"\n')
    expect(existsSync(join(cwd, 'NOTES.md'))).toBe(true)
    expect(readRunState(data, cwd)?.active).toBe(false)
    expect(stop()).toEqual({})
    expect(sh(cwd, 'status', '--porcelain')).toBe('')
  })

  it('blocks delivery without evidence, and resolves a squash Merge-back conflict', () => {
    const calls = dispatches(context(throughGates()))
    subagent(calls[0]!, child('t1', dir => writeFileSync(join(dir, 'src', 'greet.ts'), 'export const greeting = "hello"\n')).result)
    const third = dispatches(subagent(calls[1]!, child('t2', dir => writeFileSync(join(dir, 'hi.md'), 'hi\n')).result).systemMessage)[0]!
    subagent(third, child('t3', dir => writeFileSync(join(dir, 'NOTES.md'), 'notes\n')).result)
    expect(stop().systemMessage).toBe('Ship · continuing: final verification (Status: planned)')

    writeFileSync(spec(), readFileSync(spec(), 'utf8').replace('Status: planned', 'Status: shipped'))
    wrote(spec())
    const refused = stop()
    expect(refused.systemMessage).toMatch(/^Ship · stopped: Verifier: acceptance evidence incomplete \(ACC-001: no evidence\)/u)
    expect(status()).toBe('landing')
    expect(sh(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ship/greeting')

    // main moved on meanwhile: no fast-forward, and the squash conflicts.
    sh(cwd, 'commit', '-q', '-am', 'wip: records')
    sh(cwd, 'checkout', '-q', 'main')
    writeFileSync(join(cwd, 'src', 'greet.ts'), 'export const greeting = "hey"\n')
    sh(cwd, 'commit', '-q', '-am', 'main moved')
    sh(cwd, 'checkout', '-q', 'ship/greeting')
    writeFileSync(spec(), readFileSync(spec(), 'utf8').replace('Status: landing', 'Status: shipped') + '\n## Verification\n\n- ACC-001: `node -e "process.exit(0)"` exit 0\n')
    expect(prompt(invocation(''))).toEqual({})
    const conflict = stop()
    expect(conflict.systemMessage).toBe('Ship · Merge-back conflict: dispatching conflict resolution (src/greet.ts)')
    const [resolver] = dispatches(context(conflict))
    expect(resolver!.prompt).toMatch(/^Conflict-resolution for Merge-back \(delivery\), attempt 1 of 3\./u)
    writeFileSync(join(cwd, 'src', 'greet.ts'), 'export const greeting = "hey and hello"\n')
    expect(subagent(resolver!, 'Resolved.').systemMessage).toBe('Ship · Merge-back conflict resolved and committed.')
    const done = stop()
    expect(done.systemMessage).toMatch(/^Ship · shipped: Merge back ran: the squash onto main needed conflict resolution/u)
    expect(sh(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(sh(cwd, 'log', '-1', '--format=%s')).toBe('Greet people in two ways.')
    expect(readFileSync(join(cwd, 'src', 'greet.ts'), 'utf8')).toBe('export const greeting = "hey and hello"\n')
    expect(readRunState(data, cwd)?.active).toBe(false)
  })

  it('never merges a failed or cancelled child, stops, and redispatches it on /ship', () => {
    const calls = dispatches(context(throughGates()))
    const one = child('t1', dir => writeFileSync(join(dir, 'src', 'greet.ts'), 'export const greeting = "partial"\n'))
    expect(subagent(calls[0]!, `Subagent cancelled.\n\n${one.result}`, true)).toEqual({})
    const two = child('t2', dir => writeFileSync(join(dir, 'src', 'hi.md'), 'hi\n'))
    // A sibling that succeeded still lands; nothing new is dispatched after a failure.
    expect(subagent(calls[1]!, two.result).systemMessage).toBe('Ship · landed Ticket 2 (merged --no-ff, Proof: green, ticked).')
    const halted = stop()
    expect(halted.systemMessage).toMatch(/^Ship · stopped: Landing child failed or was cancelled: Ticket 1 \(worktree .* kept, not merged\)/u)
    expect(context(halted)).toContain('nothing was merged or ticked')
    expect(readFileSync(spec(), 'utf8')).toContain('- [ ] Ticket 1: Hello')
    expect(readFileSync(spec(), 'utf8')).toContain('- [x] Ticket 2: Hi')
    expect(readFileSync(join(cwd, 'src', 'greet.ts'), 'utf8')).toBe('export const greeting = "none"\n')
    expect(existsSync(one.path)).toBe(true)
    expect(readRunState(data, cwd)?.active).toBe(false)

    // A resume dispatches only Ticket 1 again (Ticket 3 is claimable too: its blocker landed).
    expect(prompt(invocation(''))).toEqual({})
    const resumed = stop()
    expect(dispatches(context(resumed)).map(call => call.description)).toEqual(['Ship Ticket 1', 'Ship Ticket 3'])
    expect(context(resumed)).toContain('Ticket 1 is claimed but this run has no record of its child')
  })

  it('stops a turn Ctrl+C cut short without a result, and offers the ticket again on /ship', () => {
    throughGates()
    // No PostToolUse and no Stop arrive for an aborted turn; a child that
    // finished before the cancel left its worktree unreported. The next /ship resumes.
    const left = child('ship-ticket-2-k3pt', dir => writeFileSync(join(dir, 'src', 'hi.md'), 'hi\n'))
    expect(prompt(invocation(''))).toEqual({})
    const resumed = stop()
    expect(context(resumed)).toContain('Ticket 1 was dispatched but no subagent result came back; any worktree it left is not merged')
    expect(context(resumed)).toContain(`Ticket 2 was dispatched but no subagent result came back; its earlier worktree ${realpathSync(left.path)} is kept and not merged`)
    expect(existsSync(join(cwd, 'src', 'hi.md'))).toBe(false)
    expect(dispatches(context(resumed)).map(call => call.description)).toEqual(['Ship Ticket 1', 'Ship Ticket 2'])
    expect(prompt(invocation(''))).toEqual({})
    const stuck = stop()
    expect(stuck.systemMessage).toContain('were dispatched 2 times without a subagent result')
  })

  it('rolls back a conflict resolution a cancel left behind and retries the merge', () => {
    const calls = dispatches(context(throughGates()))
    const one = child('t1', dir => writeFileSync(join(dir, 'src', 'greet.ts'), 'export const greeting = "hello"\n'))
    const two = child('t2', dir => writeFileSync(join(dir, 'src', 'greet.ts'), 'export const greeting = "hi"\n'))
    subagent(calls[0]!, one.result)
    const [resolver] = dispatches(subagent(calls[1]!, two.result).systemMessage)
    expect(subagent(resolver!, 'Cancelled.', true)).toEqual({})
    expect(sh(cwd, 'status', '--porcelain')).toBe('')
    const halted = stop()
    expect(context(halted)).toContain('The conflict-resolution child failed or was cancelled.')
    expect(context(halted)).toContain('was rolled back (Merge snapshot')
    expect(existsSync(two.path)).toBe(true)
    // The kept worktree is merged again on resume, which conflicts again.
    expect(prompt(invocation(''))).toEqual({})
    const retried = stop()
    expect(retried.systemMessage).toBe('Ship · merge conflict: dispatching conflict resolution (src/greet.ts)')
  })

  it('records a Blocker after three failed conflict resolutions', () => {
    const calls = dispatches(context(throughGates()))
    const one = child('t1', dir => writeFileSync(join(dir, 'src', 'greet.ts'), 'export const greeting = "hello"\n'))
    const two = child('t2', dir => writeFileSync(join(dir, 'src', 'greet.ts'), 'export const greeting = "hi"\n'))
    subagent(calls[0]!, one.result)
    let note = subagent(calls[1]!, two.result).systemMessage as string
    for (let attempt = 1; attempt < 3; attempt += 1) note = subagent(dispatches(note)[0]!, 'no').systemMessage
    const last = subagent(dispatches(note)[0]!, 'no')
    expect(last.systemMessage).toContain('Ship · stopped: Landing conflict resolution on Ticket 2 needs attention (leftover-markers)')
    expect(readFileSync(spec(), 'utf8')).toContain('## Blocker')
    expect(sh(cwd, 'log', '-1', '--format=%s')).toBe('ship: blocker Ticket 2 — Hi')
    expect(sh(cwd, 'status', '--porcelain')).toBe('')
    expect(context(stop())).toContain('Landing conflict resolution on Ticket 2 needs attention')
  })

  it('stops on a snapshot removed during the run; a resume re-infers it and the sealed contract still guards the track', () => {
    throughGates()
    rmSync(join(cwd, 'docs', 'specs', 'greeting.ship.json'))
    expect(stop().systemMessage).toBe('Ship · stopped: Ship snapshot is missing or changed beside docs/specs/greeting.md. Stopped; restore the saved snapshot.')
    writeFileSync(spec(), readFileSync(spec(), 'utf8').replace('Track-2: a notes file per greeting', 'Track-2: something else'))
    expect(prompt(invocation(''))).toEqual({})
    expect(stop().systemMessage).toBe('Ship · stopped: Frozen ## Main Track no longer matches the sealed Mission Contract. Stopped; restore the approved content.')
  })

  it('refuses to recompile a corrupt Mission Contract and to finish without the verification turn', () => {
    throughGates()
    writeFileSync(scratch('mission.contract.json'), '{broken')
    expect(stop().systemMessage).toBe('Ship · stopped: Sealed Mission Contract is missing or corrupt. Stopped; restore the approved contract.')
    expect(readFileSync(scratch('mission.contract.json'), 'utf8')).toBe('{broken')
  })

  it('stops a skipped phase and a Status: shipped written before every ticket landed', () => {
    expect(prompt(invocation('Greet people in two ways.'))).toEqual({})
    writeSpec('grilling', '\n## Wayfinder\n\nRoute: small.\n')
    stop()
    writeSpec('confirmed', TRACK, ACCEPTANCE)
    expect(stop().systemMessage).toBe('Ship · stopped: Invalid ship phase transition: grill → tickets. Stopped; restore the last approved phase.')
  })

  it('treats a bound spec that disappeared as missing state', () => {
    throughGates()
    rmSync(spec())
    expect(stop().systemMessage).toBe('Ship · stopped: Bound spec is unreadable at docs/specs/greeting.md. Stopped; restore the spec.')
  })

  it('ignores other sessions and plan mode, and prints nothing when idle', () => {
    expect(prompt(invocation('Greet people in two ways.'))).toEqual({})
    expect(hook('Stop', { sessionId: 'someone-else' })).toEqual({})
    expect(hook('Stop', { permissionMode: 'plan' })).toEqual({})
    expect(stop()).toEqual({})
  })
})
