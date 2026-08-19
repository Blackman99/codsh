/**
 * The terminal app's ordinary command-line provider over a real Loader tree:
 * the invocation becomes injected runner config, while help and usage errors
 * leave the consumer pending.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, CODING_CLI_STARTUP_SERVICE, type CodingCliStartupValues } from '../src/startup.ts'

/** What one boot of the fixture tree observed. */
interface Observed {
  exits: number[]
  out: string
  runnerConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Mount the real provider over a runner stand-in.
 * @param args - the invocation's inner arguments.
 * @returns the resolved service value and observed runner/process effects.
 */
async function bootStartup(args: string[]): Promise<{ startup: CodingCliStartupValues | undefined; observed: Observed }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-coding-cli-startup-'))
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply(_ctx, config) { globalThis.__codingCliObserved.runnerConfig = config }\n')
  // Loader imports through Node's resolver, so this fixture delegates to the
  // source-plane plugin already imported by the test.
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'coding-cli-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__codingCliApply(ctx)
`)
  const rowUrl = pathToFileURL(join(dir, 'row.mjs')).href
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: coding-cli-runner',
    `  name: ${rowUrl}`,
    `  inject: [${CODING_CLI_STARTUP_SERVICE}]`,
    '  config:',
    '    task: !!js ctx.codingCliStartup.task',
    '    resume: !!js ctx.codingCliStartup.resume',
    '    preset: !!js ctx.codingCliStartup.preset',
    '    print: !!js ctx.codingCliStartup.print',
    '- id: coding-cli-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __codingCliApply: typeof apply
    __codingCliObserved: Observed
  }
  globals.__codingCliApply = apply
  globals.__codingCliObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    startup: ctx.get(CODING_CLI_STARTUP_SERVICE) as CodingCliStartupValues | undefined,
    observed,
  }
}

describe('terminal command-line provider', () => {
  it('starts at the prompt with no task', async () => {
    const { startup, observed } = await bootStartup([])
    expect(startup).toEqual({ task: '', resume: '', preset: '', print: false })
    expect(observed.runnerConfig).toEqual({ task: '', resume: '', preset: '', print: false })
    expect(observed.exits).toEqual([])
  })

  it('joins the task positional into the runner config', async () => {
    const { startup } = await bootStartup(['add', 'a', 'slugify', 'helper'])
    expect(startup?.task).toBe('add a slugify helper')
  })

  it('resolves --continue to the latest session', async () => {
    const { startup } = await bootStartup(['--continue'])
    expect(startup?.resume).toBe('latest')
  })

  it('resolves --resume to the named session', async () => {
    const { startup } = await bootStartup(['--resume', 'session-42'])
    expect(startup?.resume).toBe('session-42')
  })

  it('carries --preset through to the runner', async () => {
    const { startup } = await bootStartup(['--preset', 'standard'])
    expect(startup?.preset).toBe('standard')
  })

  it('rejects --continue together with --resume', async () => {
    const { startup, observed } = await bootStartup(['--continue', '--resume', 'session-42'])
    expect(observed.out).toContain('mutually exclusive')
    expect(startup).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects --print with no task', async () => {
    const { startup, observed } = await bootStartup(['--print'])
    expect(observed.out).toContain('--print needs a task')
    expect(startup).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects an empty --resume id', async () => {
    const { startup, observed } = await bootStartup(['--resume', '  '])
    expect(observed.out).toContain('--resume needs a session id')
    expect(startup).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects an empty --preset id', async () => {
    const { startup, observed } = await bootStartup(['--preset', '  '])
    expect(observed.out).toContain('--preset needs a preset id')
    expect(startup).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('prints its own help and leaves the runner pending', async () => {
    const { startup, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('dsh code')
    expect(startup).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })
})
