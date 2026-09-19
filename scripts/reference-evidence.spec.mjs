import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Terminal } from '../e2e/vt.ts'
import { percentile, summarize } from './reference-baseline.mjs'

const load = file => JSON.parse(readFileSync(new URL(`../docs/rewrite/reference/${file}`, import.meta.url), 'utf8'))
function validateOutput(command) {
  if (command.exit !== 0 || command.timedOut) throw new Error('Command failed')
  const format = command.args.at(-1), marker = 'REFERENCE_LOCAL_OK'
  const require = condition => { if (!condition) throw new Error(`Invalid ${format} output`) }
  if (format === 'plain') return require(command.stdout.trim() === marker)
  if (format === 'json') {
    const value = JSON.parse(command.stdout)
    return require(value.text === marker && value.stopReason === 'end_turn' && value.sessionId && value.requestId)
  }
  const events = command.stdout.trim().split('\n').map(line => JSON.parse(line))
  require(events.every(event => event && typeof event === 'object'))
  const terminal = events.at(-1)
  if (format === 'streaming-json') {
    require(events.filter(event => event.type === 'end').length === 1 && terminal.type === 'end')
    require(terminal.stopReason === 'end_turn' && terminal.sessionId && terminal.requestId)
    require(events.filter(event => event.type === 'text').map(event => event.data).join('') === marker)
  } else {
    const init = events[0], answers = events.filter(event => event.type === 'assistant')
    require(init.type === 'system' && init.subtype === 'init' && init.model === 'reference-fixture' && init.session_id)
    require(events.filter(event => event.type === 'result').length === 1 && terminal.type === 'result')
    require(terminal.subtype === 'success' && terminal.is_error === false && terminal.result === marker && terminal.stop_reason === 'end_turn')
    require(terminal.session_id === init.session_id && answers.length === 1 && answers[0].session_id === init.session_id)
    const message = answers[0].message
    require(message.role === 'assistant' && message.model === 'reference-fixture' && message.stop_reason === 'end_turn')
    require(message.content.filter(block => block.type === 'text').map(block => block.text).join('') === marker)
  }
}

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

  it('rejects malformed structured output, missing/duplicate terminals and content-free success', () => {
    for (const command of model.commands.filter(command => command.args.at(-1) !== 'plain')) {
      expect(() => validateOutput({ ...command, stdout: 'REFERENCE_LOCAL_OK\nNOT JSON' })).toThrow()
      expect(() => validateOutput({ ...command, stdout: command.stdout.replaceAll('REFERENCE_LOCAL_OK', 'wrong') })).toThrow()
      if (command.args.at(-1).startsWith('streaming')) {
        const lines = command.stdout.trim().split('\n')
        expect(() => validateOutput({ ...command, stdout: lines.slice(0, -1).join('\n') })).toThrow()
        expect(() => validateOutput({ ...command, stdout: [...lines, lines.at(-1)].join('\n') })).toThrow()
      }
    }
  })

  it('records compatibility option recognition and the actual FPS overlay toggle', () => {
    for (const flag of ['--allowedTools', '--disallowedTools', '--system-prompt', '--append-system-prompt', '--compaction-mode', '--compaction-detail']) {
      const command = capture.commands.find(command => command.args.length === 1 && command.args[0] === flag)
      expect(command.exit).toBe(2)
      expect(command.stderr).toContain('a value is required')
      expect(command.stderr).not.toContain('unexpected argument')
    }
    const [disabled, enabled] = capture.environmentProbes
    expect(screenAt(disabled, 'draft')).not.toMatch(/FPS/i)
    expect(screenAt(enabled, 'draft')).toMatch(/FPS/i)
    for (const terminal of [disabled, enabled]) {
      expect(terminal.exit).toBe(0)
      expect(terminal.restoredAlternateScreen).toBe(true)
    }
  })

  it('replays the tutorial as an interactive overlay with aliases and mode refusal', () => {
    const [full, minimal] = capture.tutorialProbes
    expect(screenAt(full, 'tutorial-open')).toContain('Welcome to Grok Build')
    expect(screenAt(full, 'tutorial-topic')).toContain('Fear not')
    expect(screenAt(full, 'tutorial-next')).toContain('Keep typing while Grok works')
    expect(screenAt(full, 'tutorial-previous')).toContain('Fear not')
    expect(screenAt(full, 'tutorial-list')).toContain('2/9 explored')
    for (const alias of ['tutorial', 'tour', 'onboarding']) {
      expect(screenAt(full, `${alias}-open`)).toContain('Welcome to Grok Build')
      expect(screenAt(full, `${alias}-dismiss`)).not.toContain('Pick a topic')
      expect(screenAt(minimal, `${alias}-open`)).toContain("isn't available in minimal mode")
      expect(screenAt(minimal, `${alias}-open`)).toContain('/fullscreen')
    }
    for (const terminal of [full, minimal]) {
      expect(screenAt(terminal, 'after-tutorial-draft')).toContain('AFTER_TUTORIAL')
      expect(terminal.exit).toBe(0)
      expect(terminal.forcedCleanup).toBe(false)
    }
  })

  it('captures help for hidden command trees without executing their actions', () => {
    for (const path of [['share'], ['workspace'], ...['start', 'pause', 'resume', 'stop', 'restart', 'status', 'list'].map(name => ['workspace', name])]) {
      const command = capture.commands.find(item => JSON.stringify(item.args) === JSON.stringify([...path, '--help']))
      expect(command.exit).toBe(0)
      expect(command.stdout).toContain('Usage: grok')
    }
  })

  it('observes four real headless formats through only the fixture provider', () => {
    expect(model.commands).toHaveLength(4)
    for (const command of model.commands) {
      expect(command.exit).toBe(0)
      expect(command.timedOut).toBe(false)
      expect(() => validateOutput(command)).not.toThrow()
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
