/**
 * Completion sources for the prompt: slash commands, and workspace files behind
 * an `@` mention.
 *
 * Bare prose never completes. A sentence headed for the model would be rewritten
 * by a completer guessing at it, so a path has to be asked for — `@` is that
 * request, and it is also what makes the mention legible to the model, which
 * reads the file with its own tools.
 *
 * Matching is fuzzy, not prefix: the person knows a fragment of the name, not
 * where in the path it starts. A prefix match still ranks first, so the fuzzy
 * fallback never steals an exact intention.
 * @module codsh/src/completion
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** One completable command: its name without the slash, and what it does. */
export interface CompletableCommand {
  name: string
  description: string
}

/** `readline`'s completer result: the candidates, and the substring they replace. */
export type CompletionResult = [completions: string[], substring: string]

/** Directories never worth offering: build output and version-control internals. */
const HIDDEN_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'build', 'out', 'coverage'])

/** Deepest directory level the file index walks. */
const INDEX_DEPTH = 8

/** Most entries the file index keeps; a bigger workspace is sampled, not hung on. */
const INDEX_CAP = 5000

/** How long one file index answers Tabs before the workspace is re-walked. */
const INDEX_TTL_MS = 5000

/** Candidates offered per completion. */
const LIMIT = 8

/**
 * Score `needle` against `hay` as a fuzzy subsequence.
 *
 * Consecutive hits and hits on a boundary (start, or after a separator) score
 * higher, which is what ranks `src/idx` matches the way a person expects. A
 * needle that is not a subsequence scores nothing at all.
 * @param needle - what was typed, matched case-insensitively.
 * @param hay - the candidate.
 * @returns the score, or undefined when it does not match.
 */
export function fuzzyScore(needle: string, hay: string): number | undefined {
  const want = needle.toLowerCase()
  const have = hay.toLowerCase()
  let score = 0
  let at = -1
  let previous = -2
  for (const cell of want) {
    at = have.indexOf(cell, at + 1)
    if (at < 0) return undefined
    const boundary = at === 0 || '/._- '.includes(have[at - 1] ?? '')
    score += at === previous + 1 ? 3 : boundary ? 2 : 1
    previous = at
  }
  // Shorter candidates win ties: the fragment explains more of them.
  return score * 100 - have.length
}

/** One cached walk of the workspace. */
interface FileIndex {
  cwd: string
  at: number
  /** Relative paths, directories carrying a trailing slash. */
  entries: string[]
}

let cached: FileIndex | undefined

/**
 * Walk the workspace into a flat list of relative paths.
 *
 * Synchronous and bounded: Tab is a keystroke-latency path, so the walk is
 * capped in depth and count and its result reused for a few seconds. An
 * unreadable directory contributes nothing rather than failing the keystroke.
 * @param cwd - the workspace root.
 * @returns relative paths, directories marked with a trailing slash.
 */
function fileIndex(cwd: string): string[] {
  const now = Date.now()
  if (cached !== undefined && cached.cwd === cwd && now - cached.at < INDEX_TTL_MS) return cached.entries
  const entries: string[] = []
  const queue: string[] = ['']
  while (queue.length > 0 && entries.length < INDEX_CAP) {
    const dir = queue.shift() ?? ''
    if (dir.split('/').length > INDEX_DEPTH) continue
    let found: import('node:fs').Dirent[]
    try {
      found = readdirSync(join(cwd, dir), { withFileTypes: true })
    } catch {
      // An unreadable directory simply has nothing to offer.
      continue
    }
    for (const entry of found) {
      if (entries.length >= INDEX_CAP) break
      if (entry.name.startsWith('.') || HIDDEN_DIRS.has(entry.name)) continue
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        entries.push(`${path}/`)
        queue.push(path)
      } else {
        entries.push(path)
      }
    }
  }
  cached = { cwd, at: now, entries }
  return entries
}

/** Drop the cached workspace walk, so a test controls what the next Tab sees. */
export function resetFileIndex(): void {
  cached = undefined
}

/**
 * Complete a workspace path from an `@` mention, fuzzily across the whole tree.
 * @param token - the mention as typed, including its leading `@`.
 * @param cwd - the workspace the mention resolves against.
 * @returns candidate mentions, best match first.
 */
function completePath(token: string, cwd: string): string[] {
  const typed = token.slice(1)
  const entries = fileIndex(cwd)
  if (typed === '') {
    // Nothing typed yet: offer the top level, which is browsing, not searching.
    return entries.filter(entry => !entry.slice(0, -1).includes('/')).sort().slice(0, LIMIT)
      .map(entry => `@${entry}`)
  }
  const prefixed = entries.filter(entry => entry.startsWith(typed)).sort()
  const scored = entries
    .map(entry => ({ entry, score: fuzzyScore(typed, entry) }))
    .filter((hit): hit is { entry: string; score: number } => hit.score !== undefined)
    .sort((a, b) => b.score - a.score)
    .map(hit => hit.entry)
  // Exact prefixes first, then the fuzzy rest — a typed intention outranks a guess.
  const ranked: string[] = []
  for (const entry of [...prefixed, ...scored]) {
    if (!ranked.includes(entry)) ranked.push(entry)
    if (ranked.length >= LIMIT) break
  }
  return ranked.map(entry => `@${entry}`)
}

/**
 * Build the completer for one session.
 *
 * The command list is read on each use rather than captured, because a command
 * registry is scoped and changes with the session's mode — plan mode alone adds
 * and removes one.
 * @param commands - reads the currently registered commands.
 * @param cwd - the workspace `@` mentions resolve against.
 * @returns a completer over the word under the cursor.
 */
export function createCompleter(
  commands: () => readonly CompletableCommand[],
  cwd: string,
): (line: string) => CompletionResult {
  return (line: string): CompletionResult => {
    // The word under the cursor is what gets replaced, so everything before the
    // last space is context rather than a candidate.
    const token = line.slice(line.lastIndexOf(' ') + 1)
    if (token.startsWith('@')) return [completePath(token, cwd), token]
    // Only the command word completes; once an argument is being typed the
    // command is already chosen and its input is the command's own business.
    if (!line.startsWith('/') || line.includes(' ')) return [[], token]
    const typed = line.slice(1)
    const names = commands().map(command => `/${command.name}`)
    const prefixed = names.filter(name => name.startsWith(`/${typed}`))
    const fuzzy = names
      .map(name => ({ name, score: fuzzyScore(typed, name.slice(1)) }))
      .filter((hit): hit is { name: string; score: number } => hit.score !== undefined)
      .sort((a, b) => b.score - a.score)
      .map(hit => hit.name)
    const ranked: string[] = []
    for (const name of [...prefixed, ...fuzzy]) {
      if (!ranked.includes(name)) ranked.push(name)
      if (ranked.length >= LIMIT) break
    }
    return [ranked, line]
  }
}
