/**
 * Conflict-resolution: classify git-named unmerged files, snapshot a mid-merge
 * abort, and run one fill child in the merge-target tree. The runner still
 * owns add, `merge --continue`, and `merge --abort`.
 *
 * Landing serial merge and delivery Merge-back share this helper; pass the
 * landing directory name or `delivery`.
 * @module codsh-bundle/src/ship-conflict
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { classifySpecHeading, writeAllowed } from './mission.ts'
import type { ShipChildCreate, ShipChildHandle, ShipGit } from './ship-run.ts'

/** Opening / split / closing conflict-marker lines git writes. */
const START = /^<<<<<<<($|[ ].*)/u
const MID = /^=======\s*$/u
const END = /^>>>>>>>/u

/** Lockfiles and generated artifacts the child must not concatenate. */
const GENERATED = /(?:^|[/\\])(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum|mission\.contract\.json|[^/\\]+\.ship\.json)$/iu
const GENERATED_DIR = /(?:^|[/\\])(?:dist|build|\.next|coverage|out)[/\\]/iu

/** Why a merge skipped the child or rejected its fill. */
export type ConflictSkipReason =
  | 'protected-heading'
  | 'no-marker'
  | 'lockfile'
  | 'leftover-markers'
  | 'out-of-span'
  | 'malformed-markers'

export type ConflictClassify =
  | { kind: 'fillable'; paths: string[] }
  | { kind: 'skip'; reason: ConflictSkipReason }

export interface ConflictFile {
  path: string
  content: string | undefined
}

export interface MergeConflictGit {
  git: ShipGit
  gitAsHost: (args: readonly string[], cwd: string) => Promise<{ code: number; output: string }>
}

export interface MergeConflictRun {
  /** Merge-target working tree (parent `ship/<slug>`, or Original-Branch). */
  targetCwd: string
  /** `.scratch/<slug>` parent. */
  scratchSlugDir: string
  /** Landing directory (`landing-N`) or `delivery`. */
  directory: string
  graphKey: string
  label: string
  mergeOutput: string
  git: MergeConflictGit
  childCreate?: ShipChildCreate
  signal?: AbortSignal
  halted?: () => boolean
  bindFold?: (id: string, label: string) => void
  isTty?: boolean
  onChild?: (handle: ShipChildHandle) => void
  releaseChild?: (id: string) => Promise<void>
  /** Git-named fillable paths; Alignment Gate skips these while the child is live. */
  onFillable?: (paths: readonly string[]) => void
  now?: Date
}

export type MergeConflictOutcome =
  | { kind: 'resolved' }
  | { kind: 'blocker'; snapshotDir: string; reason: ConflictSkipReason }
  | { kind: 'interrupt'; snapshotDir: string }
  | { kind: 'failed' }

/** Filesystem-safe UTC stamp for a Merge snapshot directory. */
export function mergeSnapshotUtc(now = new Date()): string {
  return now.toISOString().replace(/:/gu, '-')
}

/** `.scratch/<slug>/merge-snapshots/<directory>/<utc>/`. */
export function mergeSnapshotDir(scratchSlugDir: string, directory: string, utc: string): string {
  return join(scratchSlugDir, 'merge-snapshots', directory, utc)
}

/** Unique unmerged paths from `git ls-files -u`. */
export function unmergedPathsFromLs(output: string): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const line of output.split(/\r\n|[\r\n]/u)) {
    const tab = line.indexOf('\t')
    const path = tab >= 0 ? line.slice(tab + 1).trim() : ''
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

/** Lockfile, generated artifact, or sealed contract JSON. */
export function isGeneratedConflictPath(path: string): boolean {
  const normalized = path.replace(/\\/gu, '/')
  return GENERATED.test(normalized) || GENERATED_DIR.test(normalized)
}

/** True when the line is a git conflict-marker delimiter. */
export function isConflictMarkerLine(line: string): boolean {
  return START.test(line) || MID.test(line) || END.test(line)
}

/** True when the text still contains git conflict-marker hunks. */
export function hasConflictMarkers(text: string): boolean {
  return text.split(/\r\n|[\r\n]/u).some(line => isConflictMarkerLine(line))
}

type Piece = { kind: 'plain'; text: string } | { kind: 'hunk'; text: string }

function linePieces(text: string): Piece[] {
  const lines = text.split(/(?<=\n)/u)
  const out: Piece[] = []
  let buf: string[] = []
  let inHunk = false
  const flush = (kind: Piece['kind']): void => {
    if (buf.length === 0) return
    out.push({ kind, text: buf.join('') })
    buf = []
  }
  for (const line of lines) {
    const body = line.replace(/\n$/u, '')
    if (!inHunk && START.test(body)) {
      flush('plain')
      buf = [line]
      inHunk = true
    } else if (inHunk && END.test(body)) {
      buf.push(line)
      flush('hunk')
      inHunk = false
    } else {
      buf.push(line)
    }
  }
  if (buf.length > 0) flush(inHunk ? 'hunk' : 'plain')
  return out
}

function headingName(line: string): string | undefined {
  const match = /^#{1,6}\s+(.+?)\s*$/u.exec(line.replace(/\n$/u, ''))
  return match?.[1]?.trim()
}

function headingProtected(name: string | undefined): boolean {
  return name !== undefined && !writeAllowed(classifySpecHeading(name))
}

/** True when any hunk span sits in or contains a protected heading. */
export function hunkTouchesProtectedHeading(content: string): boolean {
  let section: string | undefined
  const pieces = linePieces(content)
  for (const piece of pieces) {
    if (piece.kind === 'plain') {
      for (const line of piece.text.split(/(?<=\n)/u)) {
        const heading = headingName(line)
        if (heading !== undefined) section = heading
      }
      continue
    }
    if (headingProtected(section)) return true
    for (const line of piece.text.split(/(?<=\n)/u)) {
      const body = line.replace(/\n$/u, '')
      if (isConflictMarkerLine(body)) continue
      const heading = headingName(body)
      if (heading === undefined) continue
      if (headingProtected(heading)) return true
      section = heading
    }
  }
  return false
}

function malformedMarkers(content: string): boolean {
  let state: 'out' | 'ours' | 'theirs' = 'out'
  for (const line of content.split(/\r\n|[\r\n]/u)) {
    if (START.test(line)) {
      if (state !== 'out') return true
      state = 'ours'
    } else if (MID.test(line)) {
      if (state !== 'ours') return true
      state = 'theirs'
    } else if (END.test(line)) {
      if (state !== 'theirs') return true
      state = 'out'
    }
  }
  return state !== 'out'
}

/**
 * Skip vs dispatch. Unit of protection is the hunk span. Any skip reason
 * refuses the whole merge — the child is not asked to invent implementation.
 */
export function classifyConflictFiles(files: readonly ConflictFile[]): ConflictClassify {
  if (files.length === 0) return { kind: 'skip', reason: 'no-marker' }
  const paths: string[] = []
  for (const file of files) {
    if (isGeneratedConflictPath(file.path)) return { kind: 'skip', reason: 'lockfile' }
    const content = file.content
    if (content === undefined || content.includes('\0')) return { kind: 'skip', reason: 'no-marker' }
    if (malformedMarkers(content)) return { kind: 'skip', reason: 'malformed-markers' }
    if (!hasConflictMarkers(content)) return { kind: 'skip', reason: 'no-marker' }
    if (hunkTouchesProtectedHeading(content)) return { kind: 'skip', reason: 'protected-heading' }
    paths.push(file.path)
  }
  return { kind: 'fillable', paths }
}

/**
 * After the child returns: leftover markers, writes outside hunk spans, or
 * writes to files git did not name as conflicted.
 */
export function inspectConflictResolution(
  before: readonly ConflictFile[],
  after: readonly ConflictFile[],
  extraPaths: readonly string[] = [],
): ConflictSkipReason | undefined {
  if (extraPaths.some(path => !isScratchNoise(path))) return 'out-of-span'
  const previous = new Map(before.map(file => [file.path, file.content]))
  for (const file of after) {
    const was = previous.get(file.path)
    const now = file.content ?? ''
    if (hasConflictMarkers(now)) return 'leftover-markers'
    if (was === undefined) return 'out-of-span'
    const check = spansPreserved(was, now)
    if (check !== undefined) return check
  }
  return undefined
}

function isScratchNoise(path: string): boolean {
  return /(?:^|[/\\])\.scratch[/\\]/u.test(path.replace(/\\/gu, '/'))
}

function spansPreserved(before: string, after: string): ConflictSkipReason | undefined {
  if (hasConflictMarkers(after)) return 'leftover-markers'
  const parts = linePieces(before)
  if (!parts.some(part => part.kind === 'hunk')) return before === after ? undefined : 'out-of-span'
  let rest = after
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (part === undefined) continue
    if (part.kind === 'plain') {
      if (!rest.startsWith(part.text)) return 'out-of-span'
      rest = rest.slice(part.text.length)
      continue
    }
    const nextPlain = parts.slice(index + 1).find(item => item.kind === 'plain')
    if (nextPlain === undefined || nextPlain.text === '') {
      rest = ''
      continue
    }
    const at = rest.indexOf(nextPlain.text)
    if (at < 0) return 'out-of-span'
    rest = rest.slice(at)
  }
  return rest === '' ? undefined : 'out-of-span'
}

/** Porcelain paths that are not the unmerged set. */
export function extraStatusPaths(porcelain: string, unmerged: ReadonlySet<string>): string[] {
  const extra: string[] = []
  for (const line of porcelain.split(/\r\n|[\r\n]/u)) {
    if (line.length < 4) continue
    const raw = line.slice(3)
    const path = (raw.includes(' -> ') ? raw.slice(raw.lastIndexOf(' -> ') + 4) : raw).trim()
    if (path === '' || unmerged.has(path) || isScratchNoise(path)) continue
    extra.push(path)
  }
  return extra
}

/** Dump unmerged paths, git output, and partial fills. Does not abort. */
export function writeMergeSnapshot(opts: {
  scratchSlugDir: string
  directory: string
  utc?: string
  gitOutput: string
  unmerged: readonly string[]
  files: readonly ConflictFile[]
  reason?: string
}): string {
  const utc = opts.utc ?? mergeSnapshotUtc()
  const root = join(opts.scratchSlugDir, 'merge-snapshots')
  mkdirSync(root, { recursive: true })
  const ignore = join(root, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  const dir = mergeSnapshotDir(opts.scratchSlugDir, opts.directory, utc)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'git.txt'), opts.gitOutput.endsWith('\n') ? opts.gitOutput : `${opts.gitOutput}\n`)
  writeFileSync(join(dir, 'unmerged.txt'), `${opts.unmerged.join('\n')}${opts.unmerged.length > 0 ? '\n' : ''}`)
  if (opts.reason !== undefined) writeFileSync(join(dir, 'reason.txt'), `${opts.reason}\n`)
  for (const file of opts.files) {
    if (file.content === undefined) continue
    const dest = join(dir, 'files', file.path.split(/[/\\]/u).join(sep))
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, file.content)
  }
  return dir
}

/** Fresh-context brief: fill hunks only; not TDD; no git mutations. */
export function conflictResolutionPrompt(paths: readonly string[]): string {
  const list = paths.length === 0 ? '- (none)' : paths.map(path => `- ${path}`).join('\n')
  return [
    'Conflict-resolution is not TDD.',
    'Fill `<<<<<<<` / `=======` / `>>>>>>>` hunks only in these git-named conflicted files in this merge-target tree:',
    list,
    'Keep both sides\' non-overlapping intent. Do not add tests, glue, symbol renames, or chase-green edits.',
    'Do not run git add, commit, merge, or abort. The runner owns those.',
  ].join('\n')
}

function readConflictFile(targetCwd: string, path: string): ConflictFile {
  try {
    return { path, content: readFileSync(join(targetCwd, path), 'utf8') }
  } catch {
    return { path, content: undefined }
  }
}

async function listedUnmerged(git: ShipGit, cwd: string): Promise<string[]> {
  const listed = await git(['ls-files', '-u'], cwd)
  const fromLs = unmergedPathsFromLs(listed.output)
  if (fromLs.length > 0) return fromLs
  const diff = await git(['diff', '--name-only', '--diff-filter=U'], cwd)
  return diff.output.split(/\r\n|[\r\n]/u).map(line => line.trim()).filter(Boolean)
}

function aborted(signal: AbortSignal | undefined, halted: (() => boolean) | undefined): boolean {
  return signal?.aborted === true || halted?.() === true
}

function waitAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal === undefined) return
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

/**
 * One Conflict-resolution child per merge, in the merge-target tree.
 * Snapshots then `merge --abort` on skip, leftover fills, interrupt, or crash.
 * Success: runner `git add` and `merge --continue`. Never a second dispatch.
 */
export async function runMergeConflictResolution(opts: MergeConflictRun): Promise<MergeConflictOutcome> {
  const { targetCwd, scratchSlugDir, directory, mergeOutput } = opts
  const utc = mergeSnapshotUtc(opts.now)
  const unmerged = await listedUnmerged(opts.git.git, targetCwd)
  if (unmerged.length === 0) {
    await opts.git.git(['merge', '--abort'], targetCwd)
    return { kind: 'failed' }
  }
  const files = unmerged.map(path => readConflictFile(targetCwd, path))
  const classified = classifyConflictFiles(files)

  const snapshot = (reason?: ConflictSkipReason): string => writeMergeSnapshot({
    scratchSlugDir,
    directory,
    utc,
    gitOutput: mergeOutput,
    unmerged,
    files: unmerged.map(path => readConflictFile(targetCwd, path)),
    ...(reason === undefined ? {} : { reason }),
  })

  const abortMerge = async (): Promise<void> => {
    await opts.git.git(['merge', '--abort'], targetCwd)
  }

  if (aborted(opts.signal, opts.halted)) {
    const snapshotDir = snapshot()
    await abortMerge()
    return { kind: 'interrupt', snapshotDir }
  }

  if (classified.kind === 'skip' || opts.childCreate === undefined) {
    const reason = classified.kind === 'skip' ? classified.reason : 'no-marker'
    const snapshotDir = snapshot(reason)
    await abortMerge()
    return { kind: 'blocker', snapshotDir, reason }
  }

  opts.onFillable?.(classified.paths)
  const create = opts.childCreate
  let handle: ShipChildHandle
  try {
    handle = await create.create({
      graphKey: opts.graphKey,
      label: opts.label,
      prompt: conflictResolutionPrompt(classified.paths),
      cwd: targetCwd,
      role: 'conflict',
    })
  } catch {
    const snapshotDir = snapshot()
    await abortMerge()
    return { kind: 'interrupt', snapshotDir }
  }
  const tracked: ShipChildHandle = {
    ...handle,
    role: handle.role ?? 'conflict',
    graphKey: opts.graphKey,
    label: opts.label,
  }
  const release = async (): Promise<void> => {
    if (opts.releaseChild !== undefined) {
      await opts.releaseChild(tracked.id)
      return
    }
    try {
      await tracked.dispose()
    } catch {
      // Dispose is best-effort after kill or crash.
    }
  }
  const interrupt = async (): Promise<MergeConflictOutcome> => {
    await release()
    const snapshotDir = snapshot()
    await abortMerge()
    return { kind: 'interrupt', snapshotDir }
  }
  opts.onChild?.(tracked)
  if (aborted(opts.signal, opts.halted)) return interrupt()
  if (opts.isTty !== false) opts.bindFold?.(tracked.id, opts.label)

  const finished = tracked.done ?? Promise.resolve()
  try {
    if (opts.signal === undefined) await finished
    else await Promise.race([finished, waitAbort(opts.signal)])
  } catch {
    return interrupt()
  }
  if (aborted(opts.signal, opts.halted)) return interrupt()

  const after = classified.paths.map(path => readConflictFile(targetCwd, path))
  const status = await opts.git.git(['status', '--porcelain'], targetCwd)
  const extra = extraStatusPaths(status.output, new Set(classified.paths))
  const rejected = inspectConflictResolution(files, after, extra)
  if (rejected !== undefined) {
    await release()
    const snapshotDir = snapshot(rejected)
    await abortMerge()
    return { kind: 'blocker', snapshotDir, reason: rejected }
  }

  await opts.git.git(['add', '--', ...classified.paths], targetCwd)
  const continued = await opts.git.gitAsHost(['merge', '--continue', '--no-edit'], targetCwd)
  await release()
  if (continued.code !== 0) {
    const snapshotDir = snapshot('leftover-markers')
    await abortMerge()
    return { kind: 'blocker', snapshotDir, reason: 'leftover-markers' }
  }
  return { kind: 'resolved' }
}

/** Path of a Merge snapshot relative to the merge-target / repo root. */
export function mergeSnapshotRepoPath(targetCwd: string, snapshotDir: string): string {
  const rel = relative(targetCwd, snapshotDir)
  return rel === '' ? snapshotDir : rel.split(sep).join('/')
}
