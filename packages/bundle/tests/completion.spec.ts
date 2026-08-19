/**
 * Tab completes slash commands and nothing else: prose headed for the model
 * must not be rewritten by a completer guessing at it.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCompleter, fuzzyScore, resetFileIndex } from '../src/completion.ts'

const commands = [
  { name: 'compact', description: 'compact history' },
  { name: 'plan', description: 'enter or leave plan mode' },
  { name: 'permission', description: 'switch the permission preset' },
  { name: 'exit', description: 'leave the session' },
]

const complete = createCompleter(() => commands, '/nonexistent')

describe('createCompleter', () => {
  it('completes a unique prefix', () => {
    expect(complete('/comp')).toEqual([['/compact'], '/comp'])
  })

  it('offers every candidate sharing a prefix, before any fuzzy match', () => {
    const [matches] = complete('/p')
    expect(matches.slice(0, 2)).toEqual(['/plan', '/permission'])
  })

  it('falls back to a fuzzy match when no prefix does', () => {
    // `cpt` is a fragment of compact, not a prefix of anything.
    expect(complete('/cpt')[0]).toEqual(['/compact'])
  })

  it('offers every command for a bare slash', () => {
    const [matches] = complete('/')
    expect(matches).toEqual(['/compact', '/plan', '/permission', '/exit'])
  })

  it('offers nothing for prose, which is headed for the model', () => {
    // The reported substring is the word under the cursor, which is what
    // `readline` would replace; with no candidates it replaces nothing.
    expect(complete('fix the bug')).toEqual([[], 'bug'])
  })

  it('stops completing once an argument is being typed', () => {
    // The command is already chosen; its input is the command's own business.
    expect(complete('/plan off')).toEqual([[], 'off'])
  })

  it('offers nothing rather than replacing an unmatched name', () => {
    expect(complete('/nope')).toEqual([[], '/nope'])
  })

  it('reads the registry on each call, because scope changes it', () => {
    let live = [{ name: 'plan', description: 'x' }]
    const completer = createCompleter(() => live, '/nonexistent')
    expect(completer('/')).toEqual([['/plan'], '/'])
    live = [{ name: 'compact', description: 'x' }]
    expect(completer('/')).toEqual([['/compact'], '/'])
  })
})

describe('fuzzyScore', () => {
  it('matches a subsequence and rejects anything else', () => {
    expect(fuzzyScore('idx', 'src/index.ts')).toBeDefined()
    expect(fuzzyScore('xyz', 'src/index.ts')).toBeUndefined()
  })

  it('ranks a boundary hit above a buried one', () => {
    const boundary = fuzzyScore('inv', 'src/invariant.ts') ?? 0
    const buried = fuzzyScore('inv', 'searching-vault.ts') ?? 0
    expect(boundary).toBeGreaterThan(buried)
  })

  it('ranks the shorter candidate on a tie', () => {
    const short = fuzzyScore('a', 'a.ts') ?? 0
    const long = fuzzyScore('a', 'a-much-longer-name.ts') ?? 0
    expect(short).toBeGreaterThan(long)
  })
})

describe('@ mention path completion', () => {
  let workspace: string
  let complete: (line: string) => [string[], string]

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'dsh-complete-'))
    await mkdir(join(workspace, 'src', 'deep'), { recursive: true })
    await mkdir(join(workspace, 'node_modules'), { recursive: true })
    await mkdir(join(workspace, '.hidden'), { recursive: true })
    await writeFile(join(workspace, 'README.md'), '')
    await writeFile(join(workspace, 'src', 'index.ts'), '')
    await writeFile(join(workspace, 'src', 'invariant.ts'), '')
    await writeFile(join(workspace, 'src', 'deep', 'nested-helper.ts'), '')
    resetFileIndex()
    complete = createCompleter(() => commands, workspace)
  })

  afterAll(async () => {
    resetFileIndex()
    await rm(workspace, { recursive: true, force: true })
  })

  it('browses the top level for a bare @, marking directories', () => {
    const [matches, substring] = complete('@')
    expect(matches).toEqual(['@README.md', '@src/'])
    expect(substring).toBe('@')
  })

  it('completes a typed prefix', () => {
    expect(complete('@src/inv')[0][0]).toBe('@src/invariant.ts')
  })

  it('finds a file anywhere in the tree from a fragment', () => {
    // The person knows the name, not the directory: fuzzy is the point.
    expect(complete('@nested')[0]).toContain('@src/deep/nested-helper.ts')
    expect(complete('@nstdhlp')[0]).toContain('@src/deep/nested-helper.ts')
  })

  it('ranks the exact prefix above a fuzzy match', () => {
    const [matches] = complete('@src/i')
    expect(matches[0]).toBe('@src/index.ts')
  })

  it('hides build output, version-control internals, and dot entries', () => {
    const [matches] = complete('@')
    expect(matches).not.toContain('@node_modules/')
    expect(matches).not.toContain('@.hidden/')
  })

  it('completes a mention that follows other words', () => {
    // The word under the cursor is what gets replaced, not the whole line.
    const [, substring] = complete('explain @src/i')
    expect(substring).toBe('@src/i')
  })

  it('offers nothing for a fragment matching nothing, rather than failing', () => {
    expect(complete('@zzzz-no-such-file')[0]).toEqual([])
  })
})
