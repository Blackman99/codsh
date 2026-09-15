/**
 * Per-test e2e homes must copy `cordis.yml`. dsh rewrites that file on every
 * boot with a non-atomic `writeFileSync`, and a shared profile lets one
 * worker's boot tear another's include root.
 */

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cloneTemplateProfiles } from './harness.ts'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

describe('cloneTemplateProfiles', () => {
  it('copies the profile root so one boot cannot tear another, and shares node_modules', async () => {
    const templateProfiles = join(temp('codsh-e2e-template-'), 'profiles')
    mkdirSync(join(templateProfiles, 'node_modules', 'shared-pkg'), { recursive: true })
    writeFileSync(join(templateProfiles, 'node_modules', 'shared-pkg', 'index.js'), 'export {}\n')
    mkdirSync(join(templateProfiles, 'code', 'node_modules'), { recursive: true })
    mkdirSync(join(templateProfiles, 'code', '.dsh-module-fallback', 'node_modules'), { recursive: true })
    writeFileSync(join(templateProfiles, 'code', 'cordis.yml'), '# template\n[]\n')
    writeFileSync(join(templateProfiles, 'code', 'package.json'), '{}\n')

    const a = join(temp('codsh-e2e-home-a-'), 'profiles')
    const b = join(temp('codsh-e2e-home-b-'), 'profiles')
    await cloneTemplateProfiles(templateProfiles, a)
    await cloneTemplateProfiles(templateProfiles, b)

    expect(readFileSync(join(a, 'code', 'cordis.yml'), 'utf8')).toBe('# template\n[]\n')
    // A truncated rewrite is what a racing boot leaves for a sibling.
    writeFileSync(join(a, 'code', 'cordis.yml'), '')
    expect(readFileSync(join(b, 'code', 'cordis.yml'), 'utf8')).toBe('# template\n[]\n')
    expect(readFileSync(join(templateProfiles, 'code', 'cordis.yml'), 'utf8')).toBe('# template\n[]\n')

    expect(lstatSync(join(a, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(a, 'code', 'node_modules')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(a, 'code', '.dsh-module-fallback')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(a, 'code', 'cordis.yml')).isSymbolicLink()).toBe(false)
    expect(realpathSync(join(a, 'node_modules'))).toBe(realpathSync(join(templateProfiles, 'node_modules')))
    expect(realpathSync(join(a, 'code', 'node_modules'))).toBe(realpathSync(join(templateProfiles, 'code', 'node_modules')))
    expect(realpathSync(join(a, 'code', '.dsh-module-fallback'))).toBe(realpathSync(join(templateProfiles, 'code', '.dsh-module-fallback')))
  })
})
