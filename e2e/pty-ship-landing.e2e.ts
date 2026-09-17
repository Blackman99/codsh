/** Ticket turns and the final verification turn through the real terminal runner. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { drivePtySteps } from './pty-driver.ts'
import { ENTER } from './pty-helpers.ts'

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'e2e',
  GIT_AUTHOR_EMAIL: 'e2e@codsh',
  GIT_COMMITTER_NAME: 'e2e',
  GIT_COMMITTER_EMAIL: 'e2e@codsh',
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'ship-landing-pty-'))
  git(cwd, 'init', '-b', 'main')
  git(cwd, 'config', 'user.name', 'e2e')
  git(cwd, 'config', 'user.email', 'e2e@codsh')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(cwd, 'README.md'), 'landing fixture\n')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'base')
  git(cwd, 'checkout', '-b', 'ship/landing-e2e')
  return cwd
}

const ledger = () => [
  'Status: landing', '', '## Original Requirement', '', 'Keep offline exports.',
  '', '## Main Track', '', 'Track-1: Keep offline exports.',
  '', '## Acceptance Criteria', '', 'pnpm test exits 0.',
  '', '## Plan', '', ...[1, 2, 3, 4].map(i => `- [ ] Ticket ${i}: Export ${i} (Blocked by: ${i === 1 ? 'none' : i - 1}) (Track: 1)`),
  '', '## Notes', '', 'Fixture: no real implementation is claimed.', '',
].join('\n')

describe.skipIf(process.platform === 'win32')('ship per-ticket landing (real PTY)', () => {
  it.each([60, 120])('coordinates four turns then verifies at %i columns', async columns => {
    const cwd = await workspace()
    try {
      const dir = join(cwd, 'docs', 'specs')
      await mkdir(dir, { recursive: true })
      const path = join(dir, 'landing-e2e.md')
      await writeFile(path, ledger())
      const run = await drivePtySteps('ship-landing', [
        ['Welcome to codsh', `/ship${ENTER}`, 200],
        ['SHIP_VERIFICATION_DONE', `/exit${ENTER}`, 400],
      ], { cwd, columns })
      expect(run.output).toContain('SHIP_VERIFICATION_DONE')
      expect(run.output).not.toContain('SHIP_LANDING_ERROR')
      const markdown = await readFile(path, 'utf8')
      expect(markdown).toContain('Status: shipped')
      expect(markdown).toMatch(/- \[x\] Ticket 1:/u)
      expect(markdown).toMatch(/- \[x\] Ticket 4:/u)
      expect(run.output).not.toContain('Ralph round')
    } finally { await rm(cwd, { recursive: true, force: true }) }
  }, E2E_TEST_TIMEOUT_MS)

})
