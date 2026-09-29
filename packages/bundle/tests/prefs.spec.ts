/**
 * The surface's preferences file: every write merges, so one preference never
 * erases another, and a junk or missing file reads as empty.
 */

import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadDensity, saveDensity } from '../src/density.ts'
import { mergePrefs, readPrefs } from '../src/prefs.ts'
import { loadThemeSetting, saveThemeSetting } from '../src/theme-setting.ts'

const prefsFile = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), 'codsh-prefs-')), 'code-cli-ui.json')

describe('the prefs file', () => {
  it('keeps the density when the theme is saved, and the theme when the density is', async () => {
    const path = await prefsFile()
    await saveDensity(path, 'comfortable')
    await saveThemeSetting(path, 'deepseek-light')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ density: 'comfortable', theme: 'deepseek-light' })
    await saveDensity(path, 'compact')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ density: 'compact', theme: 'deepseek-light' })
    expect(await loadDensity(path)).toBe('compact')
    expect(await loadThemeSetting(path)).toBe('deepseek-light')
  })

  it('keeps keys it does not know, which a newer version may have written', async () => {
    const path = await prefsFile()
    await writeFile(path, '{"density":"comfortable","future":{"x":1}}\n')
    await saveThemeSetting(path, 'terminal')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ density: 'comfortable', future: { x: 1 }, theme: 'terminal' })
  })

  it('reads a legacy density-only file', async () => {
    const path = await prefsFile()
    await writeFile(path, '{"density":"comfortable"}\n')
    expect(await loadDensity(path)).toBe('comfortable')
    expect(await loadThemeSetting(path)).toBeUndefined()
  })

  it('reads a missing, junk, or non-object file as empty, and replaces it on the next write', async () => {
    const path = await prefsFile()
    expect(await readPrefs(path)).toEqual({})
    for (const junk of ['not json', '[1,2]', 'null', '"x"']) {
      await writeFile(path, junk)
      expect(await readPrefs(path)).toEqual({})
    }
    await mergePrefs(path, { theme: 'auto' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ theme: 'auto' })
  })

  it('leaves no staging file behind', async () => {
    const path = await prefsFile()
    await mergePrefs(path, { theme: 'auto' })
    await mergePrefs(path, { density: 'compact' })
    expect(await readdir(join(path, '..'))).toEqual(['code-cli-ui.json'])
  })
})
