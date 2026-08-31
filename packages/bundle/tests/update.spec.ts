/**
 * The update check: one cached registry read that never blocks a boot, never
 * installs anything, and says nothing at all when it cannot get an answer.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CACHE_MS, bundleVersion, checkForUpdate, newerVersion, updateCommand } from '../src/update.ts'

/** A fetch that answers one dist-tags body and counts its calls. */
function registry(latest: unknown, status = 200): typeof fetch & { calls: string[] } {
  const calls: string[] = []
  const impl = ((input: string | URL | Request) => {
    calls.push(String(input))
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(latest),
    } as Response)
  }) as typeof fetch & { calls: string[] }
  impl.calls = calls
  return impl
}

/** A cache path inside a fresh temporary directory. */
async function cachePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'codsh-update-')), 'update.json')
}

describe('comparing published versions', () => {
  it('orders the plain x.y.z this pair publishes', () => {
    expect(newerVersion('0.9.1', '0.9.0')).toBe(true)
    expect(newerVersion('0.10.0', '0.9.9')).toBe(true)
    expect(newerVersion('1.0.0', '0.99.99')).toBe(true)
    expect(newerVersion('0.9.0', '0.9.0')).toBe(false)
    expect(newerVersion('0.8.9', '0.9.0')).toBe(false)
  })

  it('keeps a prerelease from being offered over the release it precedes', () => {
    expect(newerVersion('1.0.0-rc.1', '1.0.0')).toBe(false)
    expect(newerVersion('1.0.0', '1.0.0-rc.1')).toBe(true)
    expect(newerVersion('1.0.1-rc.1', '1.0.0')).toBe(true)
  })

  it('names the command a person would type', () => {
    expect(updateCommand('0.9.1')).toEqual(['npm', 'install', '-g', 'codsh-cli@0.9.1'])
  })
})

describe('checking the registry', () => {
  it('reports a newer version and remembers the answer', async () => {
    const path = await cachePath()
    const fetchImpl = registry({ latest: '0.9.1' })
    const status = await checkForUpdate({ current: '0.9.0', cachePath: path, fetchImpl, env: {}, now: 1_000 })

    expect(status).toEqual({ current: '0.9.0', latest: '0.9.1', available: true })
    expect(fetchImpl.calls[0]).toBe('https://registry.npmjs.org/-/package/codsh-cli/dist-tags')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ checkedAt: 1_000, latest: '0.9.1' })
  })

  it('answers from the remembered version until it goes stale', async () => {
    const path = await cachePath()
    await writeFile(path, `${JSON.stringify({ checkedAt: 1_000, latest: '0.9.1' })}\n`)
    const fresh = registry({ latest: '2.0.0' })
    const cached = await checkForUpdate({ current: '0.9.0', cachePath: path, fetchImpl: fresh, env: {}, now: 1_000 + CACHE_MS - 1 })
    expect(cached?.latest).toBe('0.9.1')
    expect(fresh.calls).toHaveLength(0)

    const stale = await checkForUpdate({ current: '0.9.0', cachePath: path, fetchImpl: fresh, env: {}, now: 1_000 + CACHE_MS })
    expect(stale?.latest).toBe('2.0.0')
    expect(fresh.calls).toHaveLength(1)
  })

  it('says nothing when the registry is unreachable, hostile, or lying', async () => {
    const env = {}
    const failing = (() => Promise.reject(new Error('ENOTFOUND'))) as unknown as typeof fetch
    expect(await checkForUpdate({ current: '0.9.0', fetchImpl: failing, env })).toBeUndefined()
    // A captive portal answering HTML, and a 500, both parse to nothing useful.
    expect(await checkForUpdate({ current: '0.9.0', fetchImpl: registry('<html>'), env })).toBeUndefined()
    expect(await checkForUpdate({ current: '0.9.0', fetchImpl: registry({ latest: '9.9.9' }, 500), env })).toBeUndefined()
    expect(await checkForUpdate({ current: '0.9.0', fetchImpl: registry({ latest: '' }), env })).toBeUndefined()
  })

  it('reads the registry the environment names', async () => {
    const fetchImpl = registry({ latest: '0.9.0' })
    await checkForUpdate({ current: '0.9.0', fetchImpl, env: { CODSH_UPDATE_REGISTRY: 'http://127.0.0.1:4873/' } })

    expect(fetchImpl.calls[0]).toBe('http://127.0.0.1:4873/-/package/codsh-cli/dist-tags')
  })

  it('silences the automatic check, but never the person who asked', async () => {
    const env = { CODSH_UPDATE_CHECK: 'off' }
    const fetchImpl = registry({ latest: '0.9.1' })
    expect(await checkForUpdate({ current: '0.9.0', fetchImpl, env })).toBeUndefined()
    expect(fetchImpl.calls).toHaveLength(0)

    const asked = await checkForUpdate({ current: '0.9.0', fetchImpl, env, force: true })
    expect(asked?.available).toBe(true)
  })

  it('asks again when told to, cache or no cache', async () => {
    const path = await cachePath()
    await writeFile(path, `${JSON.stringify({ checkedAt: 1_000, latest: '0.9.0' })}\n`)
    const fetchImpl = registry({ latest: '0.9.2' })
    const status = await checkForUpdate({ current: '0.9.0', cachePath: path, fetchImpl, env: {}, now: 1_001, force: true })

    expect(status?.latest).toBe('0.9.2')
    expect(fetchImpl.calls).toHaveLength(1)
  })

  it('treats an unreadable cache as no cache', async () => {
    const path = await cachePath()
    await writeFile(path, 'not json at all')
    const fetchImpl = registry({ latest: '0.9.1' })

    expect((await checkForUpdate({ current: '0.9.0', cachePath: path, fetchImpl, env: {}, now: 5 }))?.latest).toBe('0.9.1')
  })
})

describe('the running version', () => {
  it('comes from the manifest beside the build', async () => {
    const version = await bundleVersion()
    expect(version).toMatch(/^\d+\.\d+\.\d+/u)
  })

  it('is undefined rather than a guess when the manifest is unreadable', async () => {
    expect(await bundleVersion(new URL('file:///nonexistent/package.json'))).toBeUndefined()
  })
})
