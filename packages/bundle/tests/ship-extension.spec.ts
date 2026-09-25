/** Tickets 195 and 208: the optional Ship extension for codsh --rust. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expandTemplate } from '../src/custom-commands.ts'
import {
  SHIP_AMBIGUOUS_SPECS,
  SHIP_EXTENSION_IDEA,
  SHIP_IDEA_CONFLICT,
  handleShipHook,
  parseShipInvocation,
  readRunState,
  shipExtensionCommand,
} from '../src/ship-extension.ts'
import { shipPromptFor } from '../src/ship.ts'

const SESSION = 'parent-session'
let cwd = ''
let data = ''

function invocation(args: string): string {
  const body = shipExtensionCommand().replace(/^---[\s\S]*?---\n/u, '')
  return `Run the custom command \`ship:ship\` from /x/ship/commands/ship.md. Arguments: ${args}\n\n${body}`
}

function prompt(text: string, sessionId = SESSION) {
  return handleShipHook({ event: 'user_prompt_submit', payload: { sessionId, prompt: text, cwd }, dataDir: data, cwd })
}

function tool(name: string, input: unknown, result: string, extra: Record<string, unknown> = {}) {
  return handleShipHook({
    event: 'post_tool_use',
    payload: { sessionId: SESSION, tool_name: name, tool_input: input, tool_response: result, permissionMode: 'default', cwd, ...extra },
    dataDir: data,
    cwd,
  })
}

function ask(id: string, header: string, question: string, answer: string, extra: Record<string, unknown> = {}) {
  return tool('ask_user_question', { questions: [{ id, header, question, options: [{ label: 'Continue' }, { label: 'Stop' }] }] }, JSON.stringify({ answers: [{ id, selected: [answer] }] }), extra)
}

function ledger(original: string, status = 'wayfinding'): string {
  return `# Wayfinder fixture\n\nStatus: ${status}\n\n## Original Requirement\n\n${original}\n\n## Wayfinder\n\nPending research remains.\n`
}

const spec = () => join(cwd, 'docs', 'specs', 'wayfinder-e2e.md')
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'codsh-ship-ext-'))
  data = join(cwd, '.plugin-data')
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('ship extension command', () => {
  it('is the legacy first-turn contract with the idea read from the host Arguments line', () => {
    const command = shipExtensionCommand()
    expect(command.startsWith('---\ndescription: Run the /ship workflow (optional Ship extension)\nargument-hint: <one-sentence requirement>\n---\n')).toBe(true)
    const body = command.replace(/^---[\s\S]*?---\n/u, '').trimEnd()
    expect(body).toBe(expandTemplate(shipPromptFor(undefined), SHIP_EXTENSION_IDEA).trimEnd())
    expect(body).toContain('This turn is wayfinder only.')
    expect(body).toContain('`ship · preflight`')
    expect(body).toContain('`ship · wayfinder`')
    expect(body).not.toContain('$ARGUMENTS')
    expect(body).not.toContain('$GOAL_ID')
    expect(body).not.toContain('This turn is grill only')
  })

  it('recognizes only its own expanded command', () => {
    expect(parseShipInvocation(invocation('build a widget'))).toEqual({ idea: 'build a widget' })
    expect(parseShipInvocation(invocation(''))).toEqual({ idea: '' })
    expect(parseShipInvocation(invocation('line one\nline two'))).toEqual({ idea: 'line one\nline two' })
    expect(parseShipInvocation('Throughout /ship, preserve the original requirement')).toBeUndefined()
    expect(parseShipInvocation('Run the custom command `deploy` from x. Arguments: now\n\nbody')).toBeUndefined()
  })
})

describe('ship extension hooks', () => {
  it('holds answers until the ledger exists, then seals the snapshot and writes the answer record', () => {
    expect(prompt(invocation('PENDING_WAYFINDER'))).toEqual({ stdout: '', exitCode: 0 })
    expect(readRunState(data, cwd)).toMatchObject({ active: true, idea: 'PENDING_WAYFINDER', sessionId: SESSION, pending: [] })
    expect(ask('route', 'ship · wayfinder', 'Is the route clear?', 'Continue')).toEqual({ stdout: '', exitCode: 0 })
    expect(existsSync(join(cwd, 'docs'))).toBe(false)
    expect(readRunState(data, cwd)?.pending).toEqual([{ id: 'route', phase: 'wayfinder', question: 'Is the route clear?', answer: 'Continue', source: 'Is the route clear?' }])

    mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true })
    writeFileSync(spec(), ledger('PENDING_WAYFINDER'))
    expect(tool('write', { file_path: spec() }, 'ok')).toEqual({ stdout: '', exitCode: 0 })
    expect(json(join(cwd, 'docs', 'specs', 'wayfinder-e2e.ship.json'))).toEqual({
      version: 1,
      specPath: 'wayfinder-e2e.md',
      originalRequirement: 'PENDING_WAYFINDER',
      originalSealed: true,
      trackSealed: false,
    })
    expect(json(join(cwd, 'docs', 'specs', 'wayfinder-e2e.ship.answers.json'))).toEqual({
      version: 1,
      specPath: 'wayfinder-e2e.md',
      answers: [{ id: 'route', phase: 'wayfinder', question: 'Is the route clear?', answer: 'Continue', source: 'Is the route clear?' }],
    })
    expect(readRunState(data, cwd)).toMatchObject({ specPath: spec(), pending: [] })
  })

  it('resumes a wayfinding spec on a bare /ship and appends later answers', () => {
    mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true })
    writeFileSync(spec(), ledger('PENDING_WAYFINDER'))
    expect(prompt(invocation(''))).toEqual({ stdout: '', exitCode: 0 })
    expect(json(join(cwd, 'docs', 'specs', 'wayfinder-e2e.ship.json')).originalRequirement).toBe('PENDING_WAYFINDER')
    ask('research', 'ship · wayfinder', 'Resume the pending research?', 'Continue')
    ask('route', 'ship · wayfinder', 'Is the route clear?', 'Stop')
    expect(json(join(cwd, 'docs', 'specs', 'wayfinder-e2e.ship.answers.json')).answers.map((row: { id: string; answer: string }) => `${row.id}=${row.answer}`))
      .toEqual(['research=Continue', 'route=Stop'])
  })

  it('stops recording once another prompt runs, and ignores child sessions and plan mode', () => {
    mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true })
    writeFileSync(spec(), ledger('PENDING_WAYFINDER'))
    prompt(invocation(''))
    ask('child', 'ship · wayfinder', 'Child?', 'Continue', { sessionId: 'child-session' })
    ask('plan', 'ship · wayfinder', 'Plan?', 'Continue', { permissionMode: 'plan' })
    expect(existsSync(join(cwd, 'docs', 'specs', 'wayfinder-e2e.ship.answers.json'))).toBe(false)
    expect(prompt('an ordinary prompt')).toEqual({ stdout: '', exitCode: 0 })
    expect(readRunState(data, cwd)?.active).toBe(false)
    ask('later', 'ship · wayfinder', 'After?', 'Continue')
    expect(existsSync(join(cwd, 'docs', 'specs', 'wayfinder-e2e.ship.answers.json'))).toBe(false)
  })

  it('records nothing for a result that is not a human answer', () => {
    mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true })
    writeFileSync(spec(), ledger('PENDING_WAYFINDER'))
    prompt(invocation(''))
    tool('ask_user_question', { questions: [{ id: 'q', question: 'Q?' }] }, 'No user is available to answer questions in this non-interactive session.')
    expect(existsSync(join(cwd, 'docs', 'specs', 'wayfinder-e2e.ship.answers.json'))).toBe(false)
  })

  it('resumes a later phase, and refuses several unfinished specs and a conflicting idea with the legacy wording', () => {
    mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true })
    writeFileSync(spec(), ledger('SMALL_WAYFINDER', 'grilling'))
    expect(prompt(invocation(''))).toEqual({ stdout: '', exitCode: 0 })
    expect(readRunState(data, cwd)).toMatchObject({ active: true, specPath: spec(), runner: { phase: 'grill', injected: false } })

    writeFileSync(spec(), ledger('SMALL_WAYFINDER'))
    const conflict = JSON.parse(prompt(invocation('SOMETHING ELSE')).stdout)
    expect(conflict.reason).toBe(`Ship: ${SHIP_IDEA_CONFLICT}`)

    writeFileSync(join(cwd, 'docs', 'specs', 'other.md'), ledger('OTHER'))
    const ambiguous = JSON.parse(prompt(invocation('')).stdout)
    expect(ambiguous.reason).toBe(`Ship: ${SHIP_AMBIGUOUS_SPECS} (docs/specs/other.md, docs/specs/wayfinder-e2e.md)`)
  })

  it('never overwrites a corrupt answer record or accepts a changed frozen original', () => {
    mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true })
    writeFileSync(spec(), ledger('PENDING_WAYFINDER'))
    const answers = join(cwd, 'docs', 'specs', 'wayfinder-e2e.ship.answers.json')
    writeFileSync(answers, '{not json')
    const corrupt = JSON.parse(prompt(invocation('')).stdout)
    expect(corrupt.reason).toContain('Refusing to overwrite it')
    expect(readFileSync(answers, 'utf8')).toBe('{not json')

    rmSync(answers)
    expect(prompt(invocation(''))).toEqual({ stdout: '', exitCode: 0 })
    writeFileSync(spec(), ledger('A DIFFERENT REQUIREMENT'))
    const drift = JSON.parse(tool('edit', { file_path: spec() }, 'ok').stdout)
    // The legacy snapshot check's own wording.
    expect(drift.reason).toBe(`Ship: Frozen ## Original Requirement no longer matches ${spec()}. Stopped; restore the approved content.`)
    expect(readRunState(data, cwd)?.active).toBe(false)
    expect(json(join(cwd, 'docs', 'specs', 'wayfinder-e2e.ship.json')).originalRequirement).toBe('PENDING_WAYFINDER')
  })

  it('writes no state for a workspace that never ran /ship', () => {
    expect(prompt('hello')).toEqual({ stdout: '', exitCode: 0 })
    expect(tool('write', { file_path: 'x' }, 'ok')).toEqual({ stdout: '', exitCode: 0 })
    expect(existsSync(data)).toBe(false)
  })
})
