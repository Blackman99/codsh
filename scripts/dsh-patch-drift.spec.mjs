/**
 * The nightly sync fails when the bundle patch still names a host row the new
 * harness no longer inserts. These cases pin that contract to the shipped
 * composition, not to whatever happens to be installed locally.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const patch = readFileSync(join(root, 'packages/bundle', 'cordis.patch.yml'), 'utf8')
const preset = readFileSync(join(root, 'packages/bundle/presets', 'code-cli.patch.yml'), 'utf8')
const bundle = JSON.parse(readFileSync(join(root, 'packages/bundle', 'package.json'), 'utf8'))

describe('bundle cordis.patch.yml', () => {
  it('does not reference tool-str-replace-editor, which dsh-base 0.1.5-rc.1 removed', () => {
    expect(patch).not.toMatch(/^- id: tool-str-replace-editor$/m)
  })

  it('names the 0.1.7 workflow and preset rows, not the retired worker-thread and directory roster', () => {
    expect(patch).toMatch(/^- id: workflow-ptc$/m)
    expect(patch).not.toMatch(/workflow-worker-thread|code-runtime|dsh-agent-presets/)
    expect(patch).toMatch(/name: '@deepseek-ai\/dsh-agent-preset-registry'\n\s+config:\n\s+default: code-cli$/m)
  })

  it('composes the preset patch after its own, so the registry default names a declared preset', () => {
    expect(bundle.dsh.bundle.patch).toEqual(['./cordis.patch.yml', './presets/code-cli.patch.yml'])
    expect(bundle.files).toContain('presets')
  })

  it('splits the deployment persona into prefix and suffix, matching dsh-system-prompt 0.1.5', () => {
    expect(patch).toMatch(/^\s+personaPrefix:/m)
    expect(patch).toMatch(/^\s+personaSuffix:/m)
    expect(patch).not.toMatch(/^\s+persona:/m)
  })
})

describe('code-cli preset declaration', () => {
  it('inserts one dsh-agent-preset row whose id is the registry default', () => {
    expect(preset).toMatch(/^- insert:\n {4}- id: preset-code-cli\n {6}name: '@deepseek-ai\/dsh-agent-preset'\n {6}config:\n {8}id: code-cli$/m)
  })

  it('runs workflows on the PTC engine dsh 0.1.7 ships', () => {
    expect(preset).toMatch(/- id: workflow-ptc\n\s+name: '@deepseek-ai\/dsh-workflow-ptc'/)
    expect(preset).not.toMatch(/worker-thread/)
  })
})

describe('code-cli preset persona', () => {
  it('shadows the deployment persona with prefix and suffix, matching dsh-persona 0.1.5', () => {
    expect(preset).toMatch(/^\s+prefix:/m)
    expect(preset).toMatch(/^\s+suffix:/m)
    expect(preset).not.toMatch(/^\s+text:/m)
  })
})
