import { describe, expect, it } from 'vitest'
import { selectDshTarget } from './dsh-release-policy.mjs'

const metadata = (versions, latest) => ({
  versions: Object.fromEntries(versions.map(version => [version, {}])),
  'dist-tags': { latest },
})

describe('selectDshTarget', () => {
  it('ignores an unpromoted prerelease from the next release line', () => {
    const registry = metadata(['0.1.1-rc.2', '0.1.2-alpha.2'], '0.1.1-rc.2')

    expect(selectDshTarget(registry, '^0.1.1-rc.2')).toBe('0.1.1-rc.2')
  })

  it('keeps tracking an untagged prerelease on the current core version', () => {
    const registry = metadata(['0.1.0-rc.7', '0.1.0-rc.8'], '0.1.0-rc.7')

    expect(selectDshTarget(registry, '^0.1.0-rc.7')).toBe('0.1.0-rc.8')
  })

  it('follows latest when it explicitly promotes a new release line', () => {
    const registry = metadata(
      ['0.1.1-rc.2', '0.1.2-alpha.2', '0.2.0', '0.3.0-alpha.1'],
      '0.2.0',
    )

    expect(selectDshTarget(registry, '^0.1.1-rc.2')).toBe('0.2.0')
  })

  it('orders numeric prerelease identifiers with SemVer rules', () => {
    const registry = metadata(['0.1.1-alpha.2', '0.1.1-alpha.10'], '0.1.1-alpha.2')

    expect(selectDshTarget(registry, '^0.1.1-alpha.2')).toBe('0.1.1-alpha.10')
  })

  it('rejects an invalid current range', () => {
    const registry = metadata(['0.1.1-rc.2'], '0.1.1-rc.2')

    expect(() => selectDshTarget(registry, 'not-a-range')).toThrow(/range/i)
  })

  it('rejects an invalid latest tag', () => {
    const registry = metadata(['0.1.1-rc.2'], 'not-a-version')

    expect(() => selectDshTarget(registry, '^0.1.1-rc.2')).toThrow(/latest/i)
  })
})
