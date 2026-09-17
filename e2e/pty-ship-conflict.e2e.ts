/**
 * Real `/ship` landing: worktrees, a git merge conflict, then the next ticket.
 *
 * Manual loop: seed the same git fixture as `workspace()`, then
 * `MOCK=ship-conflict pnpm run dev` and type `/ship`.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { drivePtySteps, screenOf, type Driven } from './pty-driver.ts'
import { ENTER, ESCAPE } from './pty-helpers.ts'

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'e2e',
  GIT_AUTHOR_EMAIL: 'e2e@codsh',
  GIT_COMMITTER_NAME: 'e2e',
  GIT_COMMITTER_EMAIL: 'e2e@codsh',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const LEDGER = [
  'Status: landing',
  'Branch: ship/conflict-e2e',
  '',
  '## Original Requirement',
  '',
  'Keep greetings offline.',
  '',
  '## Main Track',
  '',
  '**Idea.** Keep greetings offline.',
  '**Track-1.** Hybrid compass.',
  '',
  '## Acceptance Criteria',
  '',
  '1. `true` exits 0.',
  '',
  '## Plan',
  '',
  '- [ ] Ticket 1: Greet hello (Blocked by: none) (Track: 1)',
  '- [ ] Ticket 2: Greet hi (Blocked by: none) (Track: 1)',
  '- [ ] Ticket 3: Extra (Blocked by: 2) (Track: 1)',
  '',
  '## Notes',
  '',
  'CLEANUP_HISTORY',
  '',
].join('\n')

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'ship-conflict-pty-'))
  git(cwd, 'init', '-b', 'main')
  git(cwd, 'config', 'user.name', 'e2e')
  git(cwd, 'config', 'user.email', 'e2e@codsh')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'src', 'greet.ts'), [
    'export function greet(name: string): string {',
    '  return `hey ${name}`',
    '}',
    '',
  ].join('\n'))
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'base')
  git(cwd, 'checkout', '-b', 'ship/conflict-e2e')
  const specs = join(cwd, 'docs', 'specs')
  const issues = join(cwd, '.scratch', 'conflict-e2e', 'issues')
  await mkdir(specs, { recursive: true })
  await mkdir(issues, { recursive: true })
  await writeFile(join(specs, 'conflict-e2e.md'), LEDGER)
  await writeFile(join(issues, '01-greet-hello.md'), 'Ticket 1: Greet hello\n')
  await writeFile(join(issues, '02-greet-hi.md'), 'Ticket 2: Greet hi\n')
  await writeFile(join(issues, '03-extra.md'), 'Ticket 3: Extra\n')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'spec')
  return cwd
}

function beforeStep(run: Driven, index: number, columns: number): string[] {
  const offset = run.offsets[index]
  if (offset === undefined) throw new Error(`Missing PTY step ${index + 1}`)
  return screenOf(Buffer.from(run.output).subarray(0, offset).toString(), -1, 40, columns).alternate
}

function chrome(rows: string[]): string {
  const input = rows.findLastIndex(row => row.includes('Ask anything'))
  expect(input).toBeGreaterThanOrEqual(0)
  return rows.slice(input + 1).join('\n')
}

describe.skipIf(process.platform === 'win32')('ship conflict-resolution (real PTY)', () => {
  it.each([60, 120])('fills a real merge conflict and cleans delivered chrome at %i columns', async columns => {
    const cwd = await workspace()
    try {
      const run = await drivePtySteps('ship-conflict', [
        ['Welcome to codsh', `/ship${ENTER}`, 200],
        ['Esc teaser', ESCAPE, 200],
        ['SHIP_VERIFICATION_DONE', '\u0008', 1_000],
        ['Ctrl+H closes', ESCAPE, 300],
        ['', '\u0014', 300],
        ['', ESCAPE, 300],
        ['', '\u0007', 300],
        ['', `/exit${ENTER}`, 300],
      ], { cwd, columns, timeoutMs: 90_000 })
      for (const index of [2, 4, 6, 7]) {
        expect(chrome(beforeStep(run, index, columns))).not.toMatch(/待认领|已认领|已关闭|plan \d|todos \d|subagents \d|ship ·/u)
      }
      expect(beforeStep(run, 3, columns).join('\n')).toContain('Ctrl+H closes')
      expect(beforeStep(run, 3, columns).join('\n')).toContain('done')
      expect(run.output).not.toContain('SHIP_CONFLICT_ERROR')
      expect(run.output).not.toContain('SHIP_CONFLICT_IDLE')
      expect(run.output).not.toContain('## Blocker')
      expect(run.output).toContain('SHIP_VERIFICATION_DONE')
      expect(await readFile(join(cwd, 'src', 'first.ts'), 'utf8')).toContain('export const first = true')
      const greet = await readFile(join(cwd, 'src', 'greet.ts'), 'utf8')
      expect(greet).toContain('hello and hi')
      expect(greet).not.toMatch(/^<<<<<<< /mu)
      expect(await readFile(join(cwd, 'automatically-merged.txt'), 'utf8')).toBe('preserve this ticket addition\n')
      expect(await readFile(join(cwd, 'src', 'third.ts'), 'utf8')).toContain('export const third = true')
      const ledger = await readFile(join(cwd, 'docs', 'specs', 'conflict-e2e.md'), 'utf8')
      expect(ledger).toContain('Status: shipped')
      expect(ledger).toContain('ACC-001')
      expect(ledger).not.toContain('## Blocker')
      expect(git(cwd, 'ls-files', '-u')).toBe('')
      const subjects = git(cwd, 'log', '--format=%s')
      expect(subjects).toContain('ship: land Ticket 2')
      expect(subjects).toContain('ship: tick Ticket 2')
      expect(subjects).toContain('Ticket 3: Extra')
      expect(subjects).not.toMatch(/SHIP_CONFLICT/u)
      expect(git(cwd, 'show', 'HEAD:automatically-merged.txt')).toBe('preserve this ticket addition\n')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 180_000)
})
