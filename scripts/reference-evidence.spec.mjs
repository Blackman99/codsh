import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Terminal } from '../e2e/vt.ts'
import { percentile, summarize } from './reference-baseline.mjs'

const load = file => JSON.parse(readFileSync(new URL(`../docs/rewrite/reference/${file}`, import.meta.url), 'utf8'))
const capture = load('observations.json')
const model = load('model-observations.json')

function screenAt(terminal, action) {
  const terminalState = new Terminal(...terminal.initialSize)
  const target = terminal.events.find(event => event.action === action)
  for (const event of terminal.events) {
    if (event.ms > target.observedMs) break
    if (event.size) terminalState.resize(...event.size)
    if (event.output) terminalState.feed(event.output)
  }
  return terminalState.text
}

describe('recorded installed reference evidence', () => {
  it('derives every baseline statistic from raw samples without candidate-selected thresholds', () => {
    const baseline = load('baseline.json')
    const { captureSha256, ...recorded } = baseline
    expect(recorded).toEqual(summarize(capture))
    expect(captureSha256).toBe(createHash('sha256').update(readFileSync(new URL('../docs/rewrite/reference/observations.json', import.meta.url))).digest('hex'))
    expect(percentile([30, 10, 20], 0.95)).toBe(30)
    expect(() => percentile([], 0.95)).toThrow()
    expect(() => percentile([NaN], 0.95)).toThrow()
  })

  it('pins the behavioral version independently from the public source version', () => {
    const version = capture.commands.find(item => item.args.join(' ') === 'version --json')
    expect(JSON.parse(version.stdout).currentVersion).toBe('1.0.34 (3736acbc8658)')
    expect(capture.binarySha256).toBe(model.binarySha256)
  })

  it('records successful normal/error CLI outcomes, not only help text', () => {
    expect(capture.commands.find(item => item.args[0] === 'inspect').exit).toBe(0)
    expect(capture.commands.find(item => item.args[0] === '--not-a-real-option').exit).toBe(2)
    const invalid = capture.commands.find(item => item.args[1] === 'not-a-format')
    expect(invalid.exit).toBe(2)
    expect(invalid.stderr).toContain('invalid value')
  })

  it('retains byte-exact PTY events and verifies visible draft/settings plus clean quit', () => {
    expect(capture.terminals).toHaveLength(10)
    for (const terminal of capture.terminals) {
      const bytes = Buffer.concat(terminal.events.filter(event => event.bytesBase64).map(event => Buffer.from(event.bytesBase64, 'base64')))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(terminal.outputSha256)
      expect(bytes.length).toBe(terminal.outputBytes)
      expect(screenAt(terminal, 'draft')).toContain('REFERENCE133')
      expect(screenAt(terminal, 'clear-draft')).not.toContain('REFERENCE133')
      expect(screenAt(terminal, 'settings-open')).toContain('Compact mode')
      expect(screenAt(terminal, 'settings-close')).not.toContain('Compact mode')
      expect(terminal.exit).toBe(0)
      expect(terminal.forcedCleanup).toBe(false)
      expect(terminal.restoredAlternateScreen).toBe(terminal.mode === 'fullscreen')
    }
  })

  it('observes four real headless formats through only the fixture provider', () => {
    expect(model.commands).toHaveLength(4)
    for (const command of model.commands) {
      expect(command.exit).toBe(0)
      expect(command.timedOut).toBe(false)
      expect(command.stdout).toContain('REFERENCE_LOCAL_OK')
    }
    const requests = model.requests.filter(request => request.method === 'POST')
    expect(requests.length).toBeGreaterThanOrEqual(4)
    expect(requests.every(request => request.model === 'reference-fixture')).toBe(true)
    expect(requests.every(request => request.path === '/v1/chat/completions')).toBe(true)
    const stream = model.commands.find(command => command.args.at(-1) === 'streaming-json')
    const events = stream.stdout.trim().split('\n').map(line => JSON.parse(line))
    expect(events.at(-1).type).toBe('end')
  })
})
