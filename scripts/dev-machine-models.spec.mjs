import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isUsablePatch,
  prepareDevModelConfig,
  resolveMachineHome,
} from './dev-machine-models.mjs'

const scratch = []

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

afterEach(() => {
  while (scratch.length > 0) {
    rmSync(scratch.pop(), { recursive: true, force: true })
  }
})

function writeMachineHome(root, {
  patch,
  settings,
  credentials,
  envFile,
  thinking,
} = {}) {
  if (patch !== undefined) {
    mkdirSync(join(root, 'profiles', 'code'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'code', 'cordis.patch.yml'), patch)
  }
  if (settings !== undefined) writeFileSync(join(root, 'settings.yaml'), settings)
  if (credentials !== undefined) writeFileSync(join(root, '.credentials.yaml'), credentials)
  if (envFile !== undefined) writeFileSync(join(root, '.env'), envFile)
  if (thinking !== undefined) writeFileSync(join(root, 'code-cli-thinking.json'), thinking)
}

const PROVIDER_PATCH = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      my-provider:',
  '        displayName: My Provider',
  '        api: openai-completions',
  '        baseURL: https://gateway.example/v1',
  '        apiKeyEnv: MY_CAP_API_KEY',
  '        models:',
  '          - id: grok-4.6',
  '            name: My CPA - Grok 4.6',
  '',
].join('\n')

const EMPTY_PATCH = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
].join('\n')

const MACHINE_SETTINGS = [
  'agent-default-model:',
  '  provider: my-provider',
  '  model: grok-4.6',
  '  reasoningEffort: xhigh',
  '',
].join('\n')

describe('resolveMachineHome', () => {
  it('prefers CODSH_DEV_USER_HOME, then DSH_HOME, then ~/.dsh', () => {
    expect(resolveMachineHome({ CODSH_DEV_USER_HOME: '/tmp/user-home' }, '/Users/me')).toBe('/tmp/user-home')
    expect(resolveMachineHome({ DSH_HOME: '/tmp/dsh-home' }, '/Users/me')).toBe('/tmp/dsh-home')
    expect(resolveMachineHome({}, '/Users/me')).toBe(join('/Users/me', '.dsh'))
  })

  it('ignores blank overrides', () => {
    expect(resolveMachineHome({ CODSH_DEV_USER_HOME: '  ', DSH_HOME: '' }, '/Users/me')).toBe(join('/Users/me', '.dsh'))
  })

  it('skips a DSH_HOME that is the isolated .dev-home', () => {
    const isolated = '/repo/.dev-home'
    expect(resolveMachineHome({ DSH_HOME: isolated }, '/Users/me', isolated)).toBe(join('/Users/me', '.dsh'))
    expect(resolveMachineHome(
      { CODSH_DEV_USER_HOME: '/tmp/user-home', DSH_HOME: isolated },
      '/Users/me',
      isolated,
    )).toBe('/tmp/user-home')
  })
})

describe('isUsablePatch', () => {
  it('rejects the empty profile template', () => {
    expect(isUsablePatch(EMPTY_PATCH)).toBe(false)
    expect(isUsablePatch('[]\n')).toBe(false)
  })

  it('accepts a profile patch that names a row', () => {
    expect(isUsablePatch(PROVIDER_PATCH)).toBe(true)
    expect(isUsablePatch('- insert:\n    - id: extra\n')).toBe(true)
  })
})

describe('prepareDevModelConfig', () => {
  it('imports the machine default model, credentials, and custom-provider patch', () => {
    const machineHome = tempDir('codsh-machine-')
    const devHome = tempDir('codsh-dev-')
    writeMachineHome(machineHome, {
      patch: PROVIDER_PATCH,
      settings: MACHINE_SETTINGS,
      credentials: 'deepseek:\n  apiKey: from-machine\n',
      envFile: 'MY_CAP_API_KEY=from-file\n',
      thinking: '{"my-provider/grok-4.6":"xhigh"}\n',
    })

    const result = prepareDevModelConfig({ machineHome, devHome, mock: false })

    expect(result.extraPatches).toEqual([join(machineHome, 'profiles', 'code', 'cordis.patch.yml')])
    expect(result.imported).toEqual([
      'settings.yaml',
      '.credentials.yaml',
      '.env',
      'code-cli-thinking.json',
    ])
    expect(readFileSync(join(devHome, 'settings.yaml'), 'utf8')).toBe(MACHINE_SETTINGS)
    expect(readFileSync(join(devHome, '.credentials.yaml'), 'utf8')).toContain('from-machine')
    expect(readFileSync(join(devHome, '.env'), 'utf8')).toContain('MY_CAP_API_KEY=from-file')
    expect(readFileSync(join(devHome, 'code-cli-thinking.json'), 'utf8')).toContain('xhigh')
  })

  it('imports a saved default model even without a custom-provider patch', () => {
    const machineHome = tempDir('codsh-machine-')
    const devHome = tempDir('codsh-dev-')
    writeMachineHome(machineHome, { patch: EMPTY_PATCH, settings: MACHINE_SETTINGS })

    const result = prepareDevModelConfig({ machineHome, devHome, mock: false })

    expect(result.extraPatches).toEqual([])
    expect(result.imported).toEqual(['settings.yaml'])
    expect(readFileSync(join(devHome, 'settings.yaml'), 'utf8')).toBe(MACHINE_SETTINGS)
  })

  it('skips an empty machine patch and missing files without throwing', () => {
    const machineHome = tempDir('codsh-machine-')
    const devHome = tempDir('codsh-dev-')
    writeMachineHome(machineHome, { patch: EMPTY_PATCH })

    const result = prepareDevModelConfig({ machineHome, devHome, mock: false })

    expect(result.extraPatches).toEqual([])
    expect(result.imported).toEqual([])
    expect(existsSync(join(devHome, 'settings.yaml'))).toBe(false)
  })

  it('does not import from the isolated home into itself', () => {
    const home = tempDir('codsh-same-')
    writeMachineHome(home, { patch: PROVIDER_PATCH, settings: MACHINE_SETTINGS })
    const before = readFileSync(join(home, 'settings.yaml'), 'utf8')

    const result = prepareDevModelConfig({ machineHome: home, devHome: home, mock: false })

    expect(result.extraPatches).toEqual([])
    expect(result.imported).toEqual([])
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe(before)
  })

  it('keeps MOCK on the keyless model even when the machine default is a custom provider', () => {
    const machineHome = tempDir('codsh-machine-')
    const devHome = tempDir('codsh-dev-')
    writeMachineHome(machineHome, { patch: PROVIDER_PATCH, settings: MACHINE_SETTINGS })
    writeFileSync(join(devHome, 'settings.yaml'), MACHINE_SETTINGS)

    const result = prepareDevModelConfig({ machineHome, devHome, mock: true })

    expect(result.extraPatches).toEqual([])
    expect(result.imported).toEqual([])
    expect(readFileSync(join(devHome, 'settings.yaml'), 'utf8')).toMatch(/provider:\s*cli-mock/)
    expect(readFileSync(join(devHome, 'settings.yaml'), 'utf8')).not.toContain('my-provider')
  })

  it('overwrites a leftover scratch default so the machine model is current', () => {
    const machineHome = tempDir('codsh-machine-')
    const devHome = tempDir('codsh-dev-')
    writeMachineHome(machineHome, { patch: PROVIDER_PATCH, settings: MACHINE_SETTINGS })
    writeFileSync(join(devHome, 'settings.yaml'), 'agent-default-model:\n  provider: deepseek\n  model: deepseek-chat\n')

    prepareDevModelConfig({ machineHome, devHome, mock: false })

    expect(readFileSync(join(devHome, 'settings.yaml'), 'utf8')).toBe(MACHINE_SETTINGS)
  })

  it('drops a leftover mock default when the machine has no settings.yaml', () => {
    const machineHome = tempDir('codsh-machine-')
    const devHome = tempDir('codsh-dev-')
    writeMachineHome(machineHome, { patch: EMPTY_PATCH })
    writeFileSync(join(devHome, 'settings.yaml'), 'agent-default-model:\n  provider: cli-mock\n  model: cli-mock\n')

    const result = prepareDevModelConfig({ machineHome, devHome, mock: false })

    expect(result.imported).toEqual([])
    expect(existsSync(join(devHome, 'settings.yaml'))).toBe(false)
  })
})
