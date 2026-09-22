import { describe, expect, it } from 'vitest'
import { selectDshTarget } from './dsh-release-policy.mjs'

const metadata = (versions, latest, dependencies = {}) => ({
  versions: Object.fromEntries(versions.map(version => [version, {
    dependencies: dependencies[version] ?? {},
  }])),
  'dist-tags': { latest },
})

const registryOf = (entries) => async (name) => {
  const found = entries[name]
  if (found === undefined) throw new Error(`unexpected registry lookup: ${name}`)
  return found
}

describe('selectDshTarget', () => {
  it('ignores an unpromoted prerelease from the next release line', async () => {
    const registry = metadata(['0.1.1-rc.2', '0.1.2-alpha.2'], '0.1.1-rc.2')

    await expect(selectDshTarget(registry, '^0.1.1-rc.2')).resolves.toBe('0.1.1-rc.2')
  })

  it('keeps tracking an untagged prerelease on the current core version', async () => {
    const registry = metadata(['0.1.0-rc.7', '0.1.0-rc.8'], '0.1.0-rc.7')

    await expect(selectDshTarget(registry, '^0.1.0-rc.7')).resolves.toBe('0.1.0-rc.8')
  })

  it('follows latest when it explicitly promotes a new release line', async () => {
    const registry = metadata(
      ['0.1.1-rc.2', '0.1.2-alpha.2', '0.2.0', '0.3.0-alpha.1'],
      '0.2.0',
    )

    await expect(selectDshTarget(registry, '^0.1.1-rc.2')).resolves.toBe('0.2.0')
  })

  it('orders numeric prerelease identifiers with SemVer rules', async () => {
    const registry = metadata(['0.1.1-alpha.2', '0.1.1-alpha.10'], '0.1.1-alpha.2')

    await expect(selectDshTarget(registry, '^0.1.1-alpha.2')).resolves.toBe('0.1.1-alpha.10')
  })

  it('rejects an invalid current range', async () => {
    const registry = metadata(['0.1.1-rc.2'], '0.1.1-rc.2')

    await expect(selectDshTarget(registry, 'not-a-range')).rejects.toThrow(/range/i)
  })

  it('rejects an invalid latest tag', async () => {
    const registry = metadata(['0.1.1-rc.2'], 'not-a-version')

    await expect(selectDshTarget(registry, '^0.1.1-rc.2')).rejects.toThrow(/latest/i)
  })

  it('keeps the current pin when a newer candidate names an unpublished package', async () => {
    const dsh = metadata(
      ['0.1.5-rc.2', '0.1.5-rc.3'],
      '0.1.5-rc.2',
      {
        '0.1.5-rc.2': { '@deepseek-ai/dsh-web-app': '^0.1.5-rc.2' },
        '0.1.5-rc.3': { '@deepseek-ai/dsh-web-app': '^0.1.5-rc.3' },
      },
    )
    const webApp = metadata(
      ['0.1.5-rc.2', '0.1.5-rc.3'],
      '0.1.5-rc.2',
      {
        '0.1.5-rc.2': { '@deepseek-ai/dsh-client-ui-sidebar-documentpreview': '^0.1.5-rc.2' },
        '0.1.5-rc.3': { '@deepseek-ai/dsh-client-ui-sidebar-documentpreview': '^0.1.5-rc.3' },
      },
    )
    const preview = metadata(['0.1.5-rc.2'], '0.1.5-rc.2')
    const loadMetadata = registryOf({
      '@deepseek-ai/dsh-web-app': webApp,
      '@deepseek-ai/dsh-client-ui-sidebar-documentpreview': preview,
    })

    await expect(selectDshTarget(dsh, '^0.1.5-rc.2', loadMetadata)).resolves.toBe('0.1.5-rc.2')
  })

  it('accepts a candidate once every required dependency version is published', async () => {
    const dsh = metadata(
      ['0.1.5-rc.2', '0.1.5-rc.3'],
      '0.1.5-rc.2',
      { '0.1.5-rc.3': { '@deepseek-ai/dsh-web-app': '^0.1.5-rc.3' } },
    )
    const webApp = metadata(
      ['0.1.5-rc.3'],
      '0.1.5-rc.3',
      { '0.1.5-rc.3': { 'js-yaml': '^4.2.0' } },
    )

    await expect(selectDshTarget(dsh, '^0.1.5-rc.2', registryOf({
      '@deepseek-ai/dsh-web-app': webApp,
    }))).resolves.toBe('0.1.5-rc.3')
  })

  it('fails when the only published release has an unresolvable dependency closure', async () => {
    const dsh = metadata(
      ['0.1.5-rc.3'],
      '0.1.5-rc.3',
      { '0.1.5-rc.3': { '@deepseek-ai/dsh-web-app': '^0.1.5-rc.3' } },
    )
    const webApp = metadata(['0.1.5-rc.2'], '0.1.5-rc.2')

    await expect(selectDshTarget(dsh, '^0.1.5-rc.3', registryOf({
      '@deepseek-ai/dsh-web-app': webApp,
    }))).rejects.toThrow(/no installable/)
  })
})
