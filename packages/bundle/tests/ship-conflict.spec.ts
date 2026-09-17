import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyConflictFiles, inspectConflictResolution, runMergeConflictResolution } from '../src/ship-conflict.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function repo(path = 'shared.txt', squash = false, binary = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'ship-conflict-'))
  roots.push(cwd)
  const git = (args: readonly string[]) => {
    try { return { code: 0, output: execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } }
    catch (error) {
      const failed = error as { status: number; stdout: string; stderr: string }
      return { code: failed.status, output: `${failed.stdout}${failed.stderr}` }
    }
  }
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Test User'])
  git(['config', 'user.email', 'test@example.com'])
  writeFileSync(join(cwd, path), binary ? Buffer.from([0, 1, 255]) : 'base\n')
  git(['add', '.'])
  git(['commit', '-m', 'base'])
  git(['checkout', '-b', 'ticket'])
  writeFileSync(join(cwd, path), binary ? Buffer.from([0, 2, 255]) : 'ticket\n')
  writeFileSync(join(cwd, 'automatically-merged.txt'), 'preserve this ticket addition\n')
  git(['add', '.'])
  git(['commit', '-m', 'ticket'])
  git(['checkout', 'main'])
  writeFileSync(join(cwd, path), binary ? Buffer.from([0, 3, 255]) : 'parent\n')
  git(['add', '.'])
  git(['commit', '-m', 'parent'])
  const merged = git(['merge', squash ? '--squash' : '--no-ff', 'ticket'])
  expect(merged.code).toBe(1)
  return { cwd, git, merged, path, squash }
}

function resolve(fixture: ReturnType<typeof repo>, fill: (prompt: string, attempt: number) => void, signal?: AbortSignal) {
  let attempts = 0
  return runMergeConflictResolution({
    targetCwd: fixture.cwd,
    scratchSlugDir: join(fixture.cwd, '.scratch', 'test'),
    directory: 'landing-1',
    graphKey: 'landing:1',
    label: 'Ticket 1',
    ...(signal === undefined ? {} : { signal }),
    mergeOutput: fixture.merged.output,
    ...(fixture.squash ? { squashMessage: 'Deliver the ticket' } : {}),
    git: { git: async args => fixture.git(args), gitAsHost: async args => fixture.git(args) },
    childCreate: {
      async create(request) {
        fill(request.prompt, ++attempts)
        return { id: `conflict-${attempts}`, graphKey: request.graphKey, label: request.label, done: Promise.resolve(), async dispose() {} }
      },
    },
  })
}

describe('autonomous conflict resolution with real git', () => {
  it('keeps automatically merged files and commits the resolved merge', async () => {
    const fixture = repo()
    const outcome = await resolve(fixture, () => { writeFileSync(join(fixture.cwd, fixture.path), 'parent and ticket\n') })
    expect(outcome).toEqual({ kind: 'resolved' })
    expect(fixture.git(['ls-files', '-u']).output).toBe('')
    expect(fixture.git(['show', 'HEAD:automatically-merged.txt']).output).toBe('preserve this ticket addition\n')
    expect(fixture.git(['rev-list', '--parents', '-n', '1', 'HEAD']).output.trim().split(' ')).toHaveLength(3)
  })

  it('resolves binary conflicts without corrupting the chosen bytes', async () => {
    const fixture = repo('asset.bin', false, true)
    const bytes = Buffer.from([0, 2, 3, 255])
    const outcome = await resolve(fixture, () => { writeFileSync(join(fixture.cwd, fixture.path), bytes) })
    expect(outcome).toEqual({ kind: 'resolved' })
    expect(readFileSync(join(fixture.cwd, fixture.path))).toEqual(bytes)
    expect(fixture.git(['ls-files', '-u']).output).toBe('')
  })

  it('requires explicit resolution instead of silently choosing ours for binary conflicts', async () => {
    const fixture = repo('asset.bin', false, true)
    const outcome = await resolve(fixture, () => {})
    expect(outcome).toMatchObject({ kind: 'blocker', reason: 'unconfirmed-resolution' })
    expect(fixture.git(['log', '-1', '--format=%s']).output.trim()).toBe('parent')
  })

  it('can confirm keeping the current binary only after explicit retry feedback', async () => {
    const fixture = repo('asset.bin', false, true)
    const outcome = await resolve(fixture, (prompt, attempt) => {
      if (attempt === 1) return
      expect(prompt).toContain('unconfirmed-resolution')
      fixture.git(['add', '--', fixture.path])
    })
    expect(outcome).toEqual({ kind: 'resolved' })
  })

  it('preserves non-ASCII conflicted filenames with spaces', async () => {
    const fixture = repo('冲突 file.txt')
    const outcome = await resolve(fixture, () => { writeFileSync(join(fixture.cwd, fixture.path), 'parent and ticket\n') })
    expect(outcome).toEqual({ kind: 'resolved' })
    expect(fixture.git(['show', `HEAD:${fixture.path}`]).output).toBe('parent and ticket\n')
  })

  it('dispatches lockfile conflicts for regeneration rather than stopping', async () => {
    const fixture = repo('pnpm-lock.yaml')
    const outcome = await resolve(fixture, prompt => {
      expect(prompt).toContain('regenerate')
      writeFileSync(join(fixture.cwd, fixture.path), 'lockfileVersion: 9\n')
    })
    expect(outcome).toEqual({ kind: 'resolved' })
  })

  it('feeds leftover markers back to a new child and continues after repair', async () => {
    const fixture = repo()
    const attempts: number[] = []
    const outcome = await resolve(fixture, (prompt, attempt) => {
      attempts.push(attempt)
      if (attempt === 1) return
      expect(prompt).toContain('leftover-markers')
      writeFileSync(join(fixture.cwd, fixture.path), 'parent and ticket\n')
    })
    expect(outcome).toEqual({ kind: 'resolved' })
    expect(attempts).toEqual([1, 2])
  })

  it('finalizes delivery squash conflicts with a commit, not merge --continue', async () => {
    const fixture = repo('shared.txt', true)
    const outcome = await resolve(fixture, () => { writeFileSync(join(fixture.cwd, fixture.path), 'parent and ticket\n') })
    expect(outcome).toEqual({ kind: 'resolved' })
    expect(fixture.git(['log', '-1', '--format=%s']).output.trim()).toBe('Deliver the ticket')
    expect(fixture.git(['rev-list', '--parents', '-n', '1', 'HEAD']).output.trim().split(' ')).toHaveLength(2)
  })

  it('reconciles a rename/delete conflict by retaining the renamed file explicitly', async () => {
    const fixture = repo()
    fixture.git(['merge', '--abort'])
    fixture.git(['checkout', 'ticket'])
    fixture.git(['mv', fixture.path, 'renamed.txt'])
    writeFileSync(join(fixture.cwd, 'renamed.txt'), 'base\n')
    fixture.git(['add', 'renamed.txt'])
    fixture.git(['commit', '-m', 'rename'])
    fixture.git(['checkout', 'main'])
    fixture.git(['rm', fixture.path])
    fixture.git(['commit', '-m', 'delete'])
    fixture.merged = fixture.git(['merge', '--no-ff', 'ticket'])
    expect(fixture.merged.code).toBe(1)
    const outcome = await resolve(fixture, () => { writeFileSync(join(fixture.cwd, 'renamed.txt'), 'reconciled renamed content\n') })
    expect(outcome).toEqual({ kind: 'resolved' })
    expect(fixture.git(['show', 'HEAD:renamed.txt']).output).toBe('reconciled renamed content\n')
  })

  it('combines parent edits into an incoming rename represented by Git as add/delete', async () => {
    const fixture = repo()
    fixture.git(['merge', '--abort'])
    fixture.git(['checkout', 'ticket'])
    fixture.git(['mv', fixture.path, 'renamed.txt'])
    writeFileSync(join(fixture.cwd, 'renamed.txt'), 'wholly rewritten ticket\n')
    fixture.git(['commit', '-am', 'rename rewrite'])
    fixture.git(['checkout', 'main'])
    fixture.merged = fixture.git(['merge', '--no-ff', 'ticket'])
    expect(fixture.merged.code).toBe(1)
    const outcome = await resolve(fixture, prompt => {
      expect(prompt).toContain('- renamed.txt')
      rmSync(join(fixture.cwd, fixture.path), { force: true })
      writeFileSync(join(fixture.cwd, 'renamed.txt'), 'parent and rewritten ticket\n')
    })
    expect(outcome).toEqual({ kind: 'resolved' })
    expect(fixture.git(['show', 'HEAD:renamed.txt']).output).toBe('parent and rewritten ticket\n')
    expect(fixture.git(['ls-files', fixture.path]).output).toBe('')
  })

  it('resolves modify/delete conflicts without text markers', async () => {
    const fixture = repo()
    fixture.git(['merge', '--abort'])
    fixture.git(['checkout', 'ticket'])
    fixture.git(['rm', fixture.path])
    fixture.git(['commit', '-m', 'remove shared file'])
    fixture.git(['checkout', 'main'])
    fixture.merged = fixture.git(['merge', '--no-ff', 'ticket'])
    expect(fixture.merged.code).toBe(1)
    const outcome = await resolve(fixture, () => { rmSync(join(fixture.cwd, fixture.path)) })
    expect(outcome).toEqual({ kind: 'resolved' })
    expect(fixture.git(['ls-files', fixture.path]).output).toBe('')
  })

  it('retries commit-hook failure after resolving a deletion already staged by the runner', async () => {
    const fixture = repo()
    fixture.git(['merge', '--abort'])
    fixture.git(['checkout', 'ticket'])
    fixture.git(['rm', fixture.path])
    fixture.git(['commit', '-m', 'delete'])
    fixture.git(['checkout', 'main'])
    fixture.merged = fixture.git(['merge', '--no-ff', 'ticket'])
    const hook = join(fixture.cwd, '.git/hooks/pre-commit')
    writeFileSync(hook, '#!/bin/sh\nif test ! -f .git/hook-ran; then touch .git/hook-ran; exit 1; fi\n')
    chmodSync(hook, 0o755)
    const attempts: number[] = []
    const outcome = await resolve(fixture, (prompt, attempt) => {
      attempts.push(attempt)
      if (attempt === 1) rmSync(join(fixture.cwd, fixture.path))
      else expect(prompt).toContain('git-failed')
    })
    expect(outcome).toEqual({ kind: 'resolved' })
    expect(attempts).toEqual([1, 2])
    expect(existsSync(join(fixture.cwd, fixture.path))).toBe(false)
  })

  it.each([false, true])('keeps an interruption snapshot and leaves no unmerged index (squash=%s)', async squash => {
    const fixture = repo('shared.txt', squash)
    const controller = new AbortController()
    const outcome = await resolve(fixture, () => {
      writeFileSync(join(fixture.cwd, fixture.path), 'partial resolution\n')
      controller.abort()
    }, controller.signal)
    expect(outcome.kind).toBe('interrupt')
    if (outcome.kind !== 'interrupt') throw new Error('Expected interruption')
    expect(readFileSync(join(outcome.snapshotDir, 'files', fixture.path), 'utf8')).toBe('partial resolution\n')
    expect(fixture.git(['ls-files', '-u']).output).toBe('')
    expect(fixture.git(['log', '-1', '--format=%s']).output.trim()).toBe('parent')
  })

  it('protects sealed spec sections in markerless deletion conflicts', () => {
    expect(classifyConflictFiles([{ path: 'spec.md', content: '## Main Track\n\nKeep the sealed goal.\n' }])).toEqual({ kind: 'skip', reason: 'protected-heading' })
  })

  it('accepts repeated plain suffixes inside the resolved hunk', () => {
    const before = 'start\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> ticket\n}\n'
    const after = 'start\nif (ready) {\n}\n}\n'
    expect(inspectConflictResolution([{ path: 'file.ts', content: before }], [{ path: 'file.ts', content: after }])).toBeUndefined()
  })

  it('rejects staged unrelated changes even if the working copy was restored', async () => {
    const fixture = repo()
    const path = join(fixture.cwd, 'automatically-merged.txt')
    const outcome = await resolve(fixture, () => {
      writeFileSync(join(fixture.cwd, fixture.path), 'parent and ticket\n')
      writeFileSync(path, 'staged unrelated change\n')
      fixture.git(['add', 'automatically-merged.txt'])
      writeFileSync(path, 'preserve this ticket addition\n')
    })
    expect(outcome).toMatchObject({ kind: 'blocker', reason: 'out-of-span' })
    expect(fixture.git(['log', '-1', '--format=%s']).output.trim()).toBe('parent')
  })

  it('still detects edits to automatically merged files as unrelated changes', async () => {
    const fixture = repo()
    const outcome = await resolve(fixture, () => {
      writeFileSync(join(fixture.cwd, fixture.path), 'parent and ticket\n')
      writeFileSync(join(fixture.cwd, 'automatically-merged.txt'), 'unexpected change\n')
    })
    expect(outcome).toMatchObject({ kind: 'blocker', reason: 'out-of-span', rollbackFailed: true })
    if (outcome.kind !== 'blocker') throw new Error('Expected a recovery snapshot')
    expect(readFileSync(join(outcome.snapshotDir, 'files', 'automatically-merged.txt'), 'utf8')).toBe('unexpected change\n')
  })
})
