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

const target = async (...args) => (await selectDshTarget(...args)).version

describe('selectDshTarget', () => {
  it('ignores an unpromoted prerelease from the next release line', async () => {
    const registry = metadata(['0.1.1-rc.2', '0.1.2-alpha.2'], '0.1.1-rc.2')

    await expect(target(registry, '^0.1.1-rc.2')).resolves.toBe('0.1.1-rc.2')
  })

  it('keeps tracking an untagged prerelease on the current core version', async () => {
    const registry = metadata(['0.1.0-rc.7', '0.1.0-rc.8'], '0.1.0-rc.7')

    await expect(target(registry, '^0.1.0-rc.7')).resolves.toBe('0.1.0-rc.8')
  })

  it('follows latest when it explicitly promotes a new release line', async () => {
    const registry = metadata(
      ['0.1.1-rc.2', '0.1.2-alpha.2', '0.2.0', '0.3.0-alpha.1'],
      '0.2.0',
    )

    await expect(target(registry, '^0.1.1-rc.2')).resolves.toBe('0.2.0')
  })

  it('orders numeric prerelease identifiers with SemVer rules', async () => {
    const registry = metadata(['0.1.1-alpha.2', '0.1.1-alpha.10'], '0.1.1-alpha.2')

    await expect(target(registry, '^0.1.1-alpha.2')).resolves.toBe('0.1.1-alpha.10')
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

    await expect(target(dsh, '^0.1.5-rc.2', loadMetadata)).resolves.toBe('0.1.5-rc.2')
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

    await expect(target(dsh, '^0.1.5-rc.2', registryOf({
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

  it('passes over a promoted line that drops a package codsh depends on, onto the newest in-range release', async () => {
    const dsh = metadata(['0.1.5-rc.2', '0.1.5-rc.3', '0.2.0-rc.2'], '0.2.0-rc.2')
    const presets = metadata(['0.1.5-rc.2', '0.1.5-rc.3'], '0.1.5-rc.3')
    const tools = metadata(['0.1.5-rc.2', '0.1.5-rc.3', '0.2.0-rc.2'], '0.2.0-rc.2')
    const loadMetadata = registryOf({
      '@deepseek-ai/dsh-agent-presets': presets,
      '@deepseek-ai/dsh-tools': tools,
    })

    await expect(selectDshTarget(
      dsh,
      '^0.1.5-rc.2',
      loadMetadata,
      ['@deepseek-ai/dsh', '@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-tools'],
    )).resolves.toEqual({
      version: '0.1.5-rc.3',
      skipped: [{ version: '0.2.0-rc.2', unresolved: ['@deepseek-ai/dsh-agent-presets@^0.2.0-rc.2'] }],
    })
  })

  it('walks the closure of a package codsh depends on, not just its own version', async () => {
    const dsh = metadata(['0.1.5-rc.2', '0.1.5-rc.3'], '0.1.5-rc.3')
    const lsp = metadata(
      ['0.1.5-rc.2', '0.1.5-rc.3'],
      '0.1.5-rc.3',
      { '0.1.5-rc.3': { '@deepseek-ai/dsh-lsp-protocol': '0.1.5-rc.3' } },
    )
    const protocol = metadata(['0.1.5-rc.2'], '0.1.5-rc.2')

    await expect(selectDshTarget(dsh, '^0.1.5-rc.2', registryOf({
      '@deepseek-ai/dsh-lsp': lsp,
      '@deepseek-ai/dsh-lsp-protocol': protocol,
    }), ['@deepseek-ai/dsh-lsp'])).resolves.toEqual({
      version: '0.1.5-rc.2',
      skipped: [{ version: '0.1.5-rc.3', unresolved: ['@deepseek-ai/dsh-lsp-protocol@0.1.5-rc.3'] }],
    })
  })

  it('stays on the pin, naming every release it passed over, when nothing newer installs', async () => {
    const dsh = metadata(['0.1.5-rc.2', '0.1.5-rc.3', '0.2.0-rc.2'], '0.2.0-rc.2')
    const presets = metadata(['0.1.5-rc.2'], '0.1.5-rc.2')
    const runtime = metadata(['0.1.5-rc.2'], '0.1.5-rc.2')

    const { version, skipped } = await selectDshTarget(dsh, '^0.1.5-rc.2', registryOf({
      '@deepseek-ai/dsh-agent-presets': presets,
      '@deepseek-ai/dsh-code-runtime': runtime,
    }), ['@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-code-runtime'])

    expect(version).toBe('0.1.5-rc.2')
    expect(skipped).toEqual([
      {
        version: '0.2.0-rc.2',
        unresolved: ['@deepseek-ai/dsh-agent-presets@^0.2.0-rc.2', '@deepseek-ai/dsh-code-runtime@^0.2.0-rc.2'],
      },
      {
        version: '0.1.5-rc.3',
        unresolved: ['@deepseek-ai/dsh-agent-presets@^0.1.5-rc.3', '@deepseek-ai/dsh-code-runtime@^0.1.5-rc.3'],
      },
    ])
  })
})
