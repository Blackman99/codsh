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
const preset = readFileSync(
  join(root, 'packages/bundle/agent-presets/code-cli', 'agent.cordis.yml'),
  'utf8',
)

describe('bundle cordis.patch.yml', () => {
  it('does not reference tool-str-replace-editor, which dsh-base 0.1.5-rc.1 removed', () => {
    expect(patch).not.toMatch(/^- id: tool-str-replace-editor$/m)
  })

  it('splits the deployment persona into prefix and suffix, matching dsh-system-prompt 0.1.5', () => {
    expect(patch).toMatch(/^\s+personaPrefix:/m)
    expect(patch).toMatch(/^\s+personaSuffix:/m)
    expect(patch).not.toMatch(/^\s+persona:/m)
  })
})

describe('code-cli preset persona', () => {
  it('shadows the deployment persona with prefix and suffix, matching dsh-persona 0.1.5', () => {
    expect(preset).toMatch(/^\s+prefix:/m)
    expect(preset).toMatch(/^\s+suffix:/m)
    expect(preset).not.toMatch(/^\s+text:/m)
  })
})
