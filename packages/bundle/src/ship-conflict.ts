/**
 * Autonomous conflict resolution in the merge-target tree, shared by landing
 * and delivery. The runner validates each attempt and owns Git finalization.
 * @module codsh-bundle/src/ship-conflict
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { classifyPath, classifySpecHeading, writeAllowed } from './mission.ts'
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
  | 'leftover-markers'
  | 'out-of-span'
  | 'git-failed'
  | 'unconfirmed-resolution'

export type ConflictClassify =
  | { kind: 'fillable'; paths: string[] }
  | { kind: 'skip'; reason: ConflictSkipReason }

export interface ConflictFile {
  path: string
  content: string | undefined
  bytes?: Buffer
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
  /** Squash merges have no MERGE_HEAD and need an explicit commit message. */
  squashMessage?: string
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
  | { kind: 'blocker'; snapshotDir: string; reason: ConflictSkipReason; rollbackFailed?: boolean }
  | { kind: 'interrupt'; snapshotDir: string; rollbackFailed?: boolean }
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
  for (const line of output.includes('\0') ? output.split('\0') : output.split(/\r\n|[\r\n]/u)) {
    const tab = line.indexOf('\t')
    const path = tab >= 0 ? line.slice(tab + 1) : ''
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

/** Only immutable contract conflicts require a decision instead of a child. */
export function classifyConflictFiles(files: readonly ConflictFile[]): ConflictClassify {
  if (files.length === 0) return { kind: 'skip', reason: 'no-marker' }
  const paths: string[] = []
  for (const file of files) {
    if (!writeAllowed(classifyPath(file.path))) return { kind: 'skip', reason: 'protected-heading' }
    const content = file.content
    if (/\.md$/iu.test(file.path) && content !== undefined) {
      const protectedContent = hasConflictMarkers(content)
        ? hunkTouchesProtectedHeading(content)
        : content.split(/\r?\n/u).some(line => headingProtected(headingName(line)))
      if (protectedContent) return { kind: 'skip', reason: 'protected-heading' }
    }
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
    if (!previous.has(file.path)) return 'out-of-span'
    if (isGeneratedConflictPath(file.path) || was === undefined || was.includes('\0')
      || !hasConflictMarkers(was) || malformedMarkers(was)) continue
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
  let cursor = 0
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (part?.kind !== 'plain') continue
    const at = index === 0 ? 0
      : index === parts.length - 1 ? after.length - part.text.length
        : after.indexOf(part.text, cursor)
    if (at < cursor || !after.startsWith(part.text, at)) return 'out-of-span'
    cursor = at + part.text.length
  }
  return undefined
}

/** Porcelain paths that are not the unmerged set. */
export function extraStatusPaths(porcelain: string, unmerged: ReadonlySet<string>): string[] {
  const extra: string[] = []
  const nul = porcelain.includes('\0')
  const records = nul ? porcelain.split('\0') : porcelain.split(/\r\n|[\r\n]/u)
  const add = (path: string): void => {
    if (path !== '' && !unmerged.has(path) && !isScratchNoise(path)) extra.push(path)
  }
  for (let i = 0; i < records.length; i++) {
    const line = records[i] ?? ''
    if (line.length < 4) continue
    const raw = line.slice(3)
    add(nul ? raw : (raw.includes(' -> ') ? raw.slice(raw.lastIndexOf(' -> ') + 4) : raw).trim())
    if (nul && /[RC]/u.test(line.slice(0, 2))) add(records[++i] ?? '')
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
    writeFileSync(dest, file.bytes ?? file.content)
  }
  return dir
}

/** Fresh-context brief with validation feedback from the previous attempt. */
export function conflictResolutionPrompt(paths: readonly string[], feedback?: string): string {
  return [
    'Conflict-resolution is not TDD. Resolve this merge autonomously and keep the workflow moving; do not stop or ask the user merely because Git reported a conflict.',
    'Resolve these git-named conflicted files in this merge-target tree:',
    ...paths.map(path => `- ${path}`),
    'Inspect git status, git diff, and index stages (:1:path, :2:path, :3:path) to understand both sides. Keep both sides\' non-overlapping intent and preserve unrelated content.',
    'For text conflicts, fill the marker hunks. For lockfiles or generated artifacts, regenerate them with the repository tooling from the merged source; never concatenate lockfiles. For modify/delete, rename, or binary conflicts, reconcile the versions or deletion using their history and ticket intent.',
    'Only change the listed paths. Do not add unrelated implementation, tests, symbol renames, or change sealed requirements. Run relevant checks and report the actual results.',
    'Do not run git commit, merge, reset, checkout, or abort. Use file tools (or git show to read versions); the runner owns staging, commit, and rollback. Only when retry feedback requests explicit confirmation may you git add -- <path> for those listed unchanged conflicts after comparing both sides.',
    'Do not invent requirement ids, Track-N, or `supports` for these writes. Alignment Gate does not apply to conflict resolution.',
    ...(feedback === undefined ? [] : [`The previous attempt did not pass validation:\n${feedback}\nContinue from the current files, fix the reported problem, and finish resolving all listed conflicts.`]),
  ].join('\n')
}

function readConflictFile(targetCwd: string, path: string): ConflictFile {
  try {
    const bytes = readFileSync(join(targetCwd, path))
    return { path, content: bytes.toString('utf8'), bytes }
  } catch {
    return { path, content: undefined }
  }
}

async function listedUnmerged(git: ShipGit, cwd: string): Promise<string[]> {
  const listed = await git(['ls-files', '-u', '-z'], cwd)
  const fromLs = unmergedPathsFromLs(listed.output)
  if (fromLs.length > 0) return fromLs
  const diff = await git(['diff', '--name-only', '--diff-filter=U'], cwd)
  return diff.output.split(/\r\n|[\r\n]/u).map(line => line.trim()).filter(Boolean)
}

function aborted(signal: AbortSignal | undefined, halted: (() => boolean) | undefined): boolean {
  return signal?.aborted === true || halted?.() === true
}

async function waitChild(finished: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return finished
  let stop: () => void = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    stop = () => { reject(new Error('aborted')) }
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  try { await Promise.race([finished, interrupted]) }
  finally { signal.removeEventListener('abort', stop) }
}

function indexEntries(output: string, allowed: ReadonlySet<string>): Map<string, string> {
  const entries = new Map<string, string>()
  for (const row of output.split('\0')) {
    const tab = row.indexOf('\t')
    if (tab < 0) continue
    const path = row.slice(tab + 1)
    if (!allowed.has(path) && !isScratchNoise(path)) entries.set(path, row.slice(0, tab))
  }
  return entries
}

function fileFingerprint(cwd: string, path: string): string | undefined {
  try {
    const full = join(cwd, path)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) return `link:${readlinkSync(full)}`
    if (!stat.isFile()) return `mode:${stat.mode}`
    return `${stat.mode}:${readFileSync(full).toString('base64')}`
  } catch { return undefined }
}

/** Retry validation failures without aborting an otherwise recoverable merge. */
export async function runMergeConflictResolution(opts: MergeConflictRun): Promise<MergeConflictOutcome> {
  const { targetCwd, scratchSlugDir, directory, mergeOutput } = opts
  const utc = mergeSnapshotUtc(opts.now)
  const unmerged = await listedUnmerged(opts.git.git, targetCwd)
  // Rename/delete reports may leave the incoming name staged at stage zero.
  const stageList = await opts.git.git(['ls-files', '--stage', '-z'], targetCwd)
  const stagedPaths = unmergedPathsFromLs(stageList.output)
  if (/^CONFLICT \(modify\/delete\)/mu.test(mergeOutput)) {
    // Git can represent a heavily edited rename as an add plus modify/delete.
    const additions = await opts.git.git(['diff', '--cached', '--name-only', '--diff-filter=A', '-z'], targetCwd)
    if (additions.code === 0) {
      for (const path of additions.output.split('\0').filter(Boolean)) {
        if (!unmerged.includes(path)) unmerged.push(path)
      }
    }
  }
  for (const line of mergeOutput.split('\n').filter(line => /^CONFLICT \((?:rename|file\/directory)/u.test(line))) {
    for (const path of stagedPaths) {
      if (!unmerged.includes(path) && line.includes(path)) unmerged.push(path)
    }
  }
  const abortMerge = async (): Promise<boolean> => {
    // A squash has no MERGE_HEAD. reset --merge preserves unrelated local edits.
    const result = await opts.git.git(opts.squashMessage === undefined ? ['merge', '--abort'] : ['reset', '--merge', 'HEAD'], targetCwd)
    return result.code === 0
  }
  if (unmerged.length === 0) {
    await abortMerge()
    return { kind: 'failed' }
  }
  const files = unmerged.map(path => readConflictFile(targetCwd, path))
  const protectionFiles = [...files]
  for (const file of files.filter(file => /\.md$/iu.test(file.path) && file.content === undefined)) {
    for (const stage of [1, 2, 3]) {
      const version = await opts.git.git(['show', `:${stage}:${file.path}`], targetCwd)
      if (version.code === 0) protectionFiles.push({ path: file.path, content: version.output })
    }
  }
  const classified = classifyConflictFiles(protectionFiles)
  if (classified.kind === 'fillable') classified.paths = [...new Set(classified.paths)]
  const initialContent = new Map(unmerged.map(path => [path, fileFingerprint(targetCwd, path)]))
  const allowed = new Set(unmerged)
  const baselineStatus = await opts.git.git(['status', '--porcelain', '-z', '--untracked-files=all'], targetCwd)
  const baselinePaths = new Set(extraStatusPaths(baselineStatus.output, allowed))
  const baseline = new Map([...baselinePaths].map(path => [path, fileFingerprint(targetCwd, path)]))
  const indexBefore = await opts.git.git(['ls-files', '--stage', '-z'], targetCwd)
  const baselineIndex = indexEntries(indexBefore.output, allowed)
  let feedback: string | undefined
  let extras: string[] = []
  const snapshot = (reason?: ConflictSkipReason): string => writeMergeSnapshot({
    scratchSlugDir, directory, utc,
    gitOutput: [mergeOutput, feedback].filter(Boolean).join('\n'),
    unmerged,
    files: [...new Set([...unmerged, ...extras])].map(path => readConflictFile(targetCwd, path)),
    ...(reason === undefined ? {} : { reason }),
  })
  const interrupt = async (): Promise<MergeConflictOutcome> => {
    const snapshotDir = snapshot()
    const rolledBack = await abortMerge()
    return { kind: 'interrupt', snapshotDir, ...(!rolledBack ? { rollbackFailed: true } : {}) }
  }
  const blocker = async (reason: ConflictSkipReason): Promise<MergeConflictOutcome> => {
    const snapshotDir = snapshot(reason)
    const rolledBack = await abortMerge()
    return { kind: 'blocker', snapshotDir, reason, ...(!rolledBack ? { rollbackFailed: true } : {}) }
  }
  if (aborted(opts.signal, opts.halted)) return interrupt()
  if (stageList.code !== 0 || baselineStatus.code !== 0 || indexBefore.code !== 0) {
    feedback = [baselineStatus.output, indexBefore.output].join('\n')
    return blocker('git-failed')
  }
  if (classified.kind === 'skip' || opts.childCreate === undefined) {
    return blocker(classified.kind === 'skip' ? classified.reason : 'no-marker')
  }

  opts.onFillable?.(classified.paths)
  let rejected: ConflictSkipReason = 'leftover-markers'
  for (let attempt = 0; attempt < 3; attempt++) {
    if (aborted(opts.signal, opts.halted)) return interrupt()
    let tracked: ShipChildHandle | undefined
    try {
      const handle = await opts.childCreate.create({
        graphKey: opts.graphKey,
        label: opts.label,
        prompt: `${conflictResolutionPrompt(classified.paths, feedback)}\n\nMerge context: ${opts.label} (${opts.graphKey})\nGit reported:\n${mergeOutput}`,
        cwd: targetCwd,
        role: 'conflict',
      })
      tracked = { ...handle, role: 'conflict', graphKey: opts.graphKey, label: opts.label }
      opts.onChild?.(tracked)
      if (aborted(opts.signal, opts.halted)) throw new Error('aborted')
      if (opts.isTty !== false) opts.bindFold?.(tracked.id, opts.label)
      await waitChild(tracked.done ?? Promise.resolve(), opts.signal)
    } catch {
      if (tracked !== undefined) {
        if (opts.releaseChild !== undefined) await opts.releaseChild(tracked.id)
        else await tracked.dispose().catch(() => {})
      }
      return interrupt()
    }
    if (opts.releaseChild !== undefined) await opts.releaseChild(tracked.id)
    else await tracked.dispose().catch(() => {})
    if (aborted(opts.signal, opts.halted)) return interrupt()

    const status = await opts.git.git(['status', '--porcelain', '-z', '--untracked-files=all'], targetCwd)
    const candidates = new Set([...baseline.keys(), ...extraStatusPaths(status.output, allowed)])
    const currentIndex = await opts.git.git(['ls-files', '--stage', '-z'], targetCwd)
    if (status.code !== 0 || currentIndex.code !== 0) {
      rejected = 'git-failed'
      feedback = `git-failed: ${status.output}\n${currentIndex.output}`
      continue
    }
    const index = indexEntries(currentIndex.output, allowed)
    const indexChanges = [...new Set([...baselineIndex.keys(), ...index.keys()])]
      .filter(path => baselineIndex.get(path) !== index.get(path))
    extras = [...new Set([
      ...[...candidates].filter(path => !baseline.has(path) || fileFingerprint(targetCwd, path) !== baseline.get(path)),
      ...indexChanges,
    ])]
    const after = classified.paths.map(path => readConflictFile(targetCwd, path))
    const pending = await listedUnmerged(opts.git.git, targetCwd)
    const unchanged = files.filter(file => pending.includes(file.path)
      && (file.content === undefined || !hasConflictMarkers(file.content))
      && fileFingerprint(targetCwd, file.path) === initialContent.get(file.path)).map(file => file.path)
    const invalid = inspectConflictResolution(files, after, extras)
      ?? (unchanged.length > 0 ? 'unconfirmed-resolution' : undefined)
    if (invalid !== undefined) {
      rejected = invalid
      feedback = `${invalid}${extras.length === 0 ? '' : `: restore unrelated files: ${extras.join(', ')}`}${unchanged.length === 0 ? '' : `: ${unchanged.join(', ')} are unchanged and still unmerged. Resolve their content, or explicitly stage only these paths with git add -- <path> to confirm keeping the current version after comparing both sides.`}`
      continue
    }

    const indexed = new Set(unmergedPathsFromLs(currentIndex.output))
    const stagePaths = classified.paths.filter(path => indexed.has(path) || fileFingerprint(targetCwd, path) !== undefined)
    const added = stagePaths.length === 0 ? { code: 0, output: '' }
      : await opts.git.git(['add', '--', ...stagePaths], targetCwd)
    if (aborted(opts.signal, opts.halted)) return interrupt()
    const committed = added.code !== 0 ? added : await opts.git.gitAsHost(
      opts.squashMessage === undefined ? ['commit', '--no-edit'] : ['commit', '-m', opts.squashMessage],
      targetCwd,
    )
    if (committed.code === 0) return { kind: 'resolved' }
    rejected = 'git-failed'
    feedback = `git-failed: ${committed.output}`
  }
  return blocker(rejected)
}

/** Path of a Merge snapshot relative to the merge-target / repo root. */
export function mergeSnapshotRepoPath(targetCwd: string, snapshotDir: string): string {
  const rel = relative(targetCwd, snapshotDir)
  return rel === '' ? snapshotDir : rel.split(sep).join('/')
}
