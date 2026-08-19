/**
 * The bundle carries its own preset and installs it into the writable user
 * root, because the launcher owns the roster's search roots and a bundle has no
 * way to add one. The copy never overwrites: that directory belongs to the
 * person, not to this package.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { afterEach, describe, expect, it } from 'vitest'
import { installPackagedPreset, PACKAGED_PRESET, packagedPresetPath } from '../src/preset-install.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A fresh, empty user preset root. */
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-root-'))
  roots.push(dir)
  return dir
}

describe('installPackagedPreset', () => {
  it('installs where the roster actually looks', async () => {
    // The published `dsh-agent-presets` keeps its user-root name internal, so
    // this pins the on-disk contract the installed roster reads. If an upstream
    // release renames the directory, this fails here rather than installing
    // somewhere nothing reads.
    expect(packagedPresetPath()).toBe(dshHomePath('.agent-presets', PACKAGED_PRESET))
  })

  it('installs the packaged preset the first time', async () => {
    const home = await root()
    const result = await installPackagedPreset(home)

    expect(result.installed).toBe(true)
    expect(result.path).toBe(join(home, PACKAGED_PRESET))
    // Both composition files the roster reads must arrive, not just one.
    expect((await readdir(result.path)).sort()).toEqual(['agent.cordis.yml', 'preset.yml'])
  })

  it('reports the second call as already present', async () => {
    const home = await root()
    await installPackagedPreset(home)
    expect((await installPackagedPreset(home)).installed).toBe(false)
  })

  it('leaves an edited preset alone', async () => {
    const home = await root()
    const { path } = await installPackagedPreset(home)
    const composition = join(path, 'agent.cordis.yml')
    await writeFile(composition, '- id: persona\n')

    await installPackagedPreset(home)

    // The user root is the person's; a package that rewrote it would discard
    // their composition on the next boot.
    expect(await readFile(composition, 'utf8')).toBe('- id: persona\n')
  })

  it('installs a composition the loader can read', async () => {
    const home = await root()
    const { path } = await installPackagedPreset(home)
    const text = await readFile(join(path, 'agent.cordis.yml'), 'utf8')

    // The row the patch names as the roster default has to be the one that
    // shipped, so a standalone install composes what this bundle expects.
    expect(text).toContain('- id: persona')
    expect(text).toContain('@deepseek-ai/dsh-tool-terminal')
  })
})
