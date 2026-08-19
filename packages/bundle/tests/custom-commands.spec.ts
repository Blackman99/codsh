/**
 * Custom slash commands: Markdown files become canned prompts. A broken file
 * costs that command with a warning, never the startup.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expandTemplate, loadCustomCommands, parseCommandFile } from '../src/custom-commands.ts'

const cleanups: string[] = []

/** A scratch directory removed after each test. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-custom-commands-'))
  cleanups.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('parseCommandFile', () => {
  it('splits frontmatter description from the prompt body', () => {
    expect(parseCommandFile('---\ndescription: review the diff\n---\nReview $ARGUMENTS carefully.')).toEqual({
      description: 'review the diff',
      body: 'Review $ARGUMENTS carefully.',
    })
  })

  it('treats a file without frontmatter as all body', () => {
    expect(parseCommandFile('Just a prompt.')).toEqual({ description: '', body: 'Just a prompt.' })
  })

  it('keeps an unterminated frontmatter as body rather than losing it', () => {
    const source = '---\ndescription: never closed'
    expect(parseCommandFile(source).body).toBe(source)
  })
})

describe('expandTemplate', () => {
  it('replaces every $ARGUMENTS placeholder', () => {
    expect(expandTemplate('fix $ARGUMENTS, then test $ARGUMENTS', 'the bug')).toBe('fix the bug, then test the bug')
  })

  it('appends arguments a template never asked for', () => {
    expect(expandTemplate('run the checks', 'quickly')).toBe('run the checks\n\nquickly')
  })

  it('leaves a template alone when nothing was typed', () => {
    expect(expandTemplate('run the checks', '')).toBe('run the checks')
  })
})

describe('loadCustomCommands', () => {
  it('loads commands and lets a later root shadow an earlier one', async () => {
    const home = await scratch()
    const workspace = await scratch()
    await writeFile(join(home, 'review.md'), '---\ndescription: home review\n---\nhome body')
    await writeFile(join(workspace, 'review.md'), '---\ndescription: workspace review\n---\nworkspace body')
    await writeFile(join(home, 'ship.md'), 'ship it')
    const { commands, warnings } = await loadCustomCommands([home, workspace], new Set())
    expect(warnings).toEqual([])
    expect(commands.find(command => command.name === 'review')?.template).toBe('workspace body')
    expect(commands.find(command => command.name === 'ship')?.description).toContain('ship.md')
  })

  it('skips a name a built-in already owns, and says so', async () => {
    const root = await scratch()
    await writeFile(join(root, 'plan.md'), 'not the real plan')
    const { commands, warnings } = await loadCustomCommands([root], new Set(['plan']))
    expect(commands).toEqual([])
    expect(warnings[0]).toContain('already a built-in')
  })

  it('skips a file whose name cannot register, and an empty body', async () => {
    const root = await scratch()
    await writeFile(join(root, 'Bad Name.md'), 'body')
    await writeFile(join(root, 'empty.md'), '   \n')
    const { commands, warnings } = await loadCustomCommands([root], new Set())
    expect(commands).toEqual([])
    expect(warnings).toHaveLength(2)
  })

  it('treats a missing root as defining no commands', async () => {
    const root = await scratch()
    await mkdir(join(root, 'real'))
    await writeFile(join(root, 'real', 'go.md'), 'go')
    const { commands, warnings } = await loadCustomCommands([join(root, 'absent'), join(root, 'real')], new Set())
    expect(commands.map(command => command.name)).toEqual(['go'])
    expect(warnings).toEqual([])
  })
})
