/**
 * Which `/` lines run at Enter and which wait in the Queue: a setting typed
 * while the agent works should take at once, and a command that spends a turn
 * or swaps the session must not land in the middle of one.
 */

import { describe, expect, it } from 'vitest'
import { HARNESS_IMMEDIATE, ImmediateCommands, commandName, normalizeCommandLine, splitSurfaceCommand } from '../src/immediate.ts'

describe('ImmediateCommands', () => {
  it('runs a marked command at Enter, with or without arguments', () => {
    const table = new ImmediateCommands()
    table.mark('theme', true)
    expect(table.test('/theme')).toBe(true)
    expect(table.test('/theme deepseek-light')).toBe(true)
    expect(table.test('  /theme  ')).toBe(true)
    expect(table.test('/THEME terminal')).toBe(true)
  })

  it('queues a command marked queued, an unknown one, and anything not a command', () => {
    const table = new ImmediateCommands()
    table.mark('clear', false)
    expect(table.test('/clear')).toBe(false)
    expect(table.test('/compact')).toBe(false)
    expect(table.test('theme')).toBe(false)
    expect(table.test('!ls')).toBe(false)
    expect(table.test('/theme')).toBe(false)
  })

  it('lets an argument decide', () => {
    const table = new ImmediateCommands(HARNESS_IMMEDIATE)
    // Toggling the mode is a setting; a message rides into the conversation.
    expect(table.test('/plan')).toBe(true)
    expect(table.test('/plan off')).toBe(true)
    expect(table.test('/plan sketch the migration first')).toBe(false)
    expect(table.test('/permission')).toBe(true)
    expect(table.test('/permission read-only')).toBe(true)
  })

  it('reads a bare slash as /help', () => {
    expect(new ImmediateCommands().test('/')).toBe(false)
    expect(new ImmediateCommands({ help: true }).test('/')).toBe(true)
  })

  it('keeps the harness commands that drive the model queued', () => {
    const table = new ImmediateCommands(HARNESS_IMMEDIATE)
    for (const line of ['/compact', '/goal ship it', '/feedback nice']) expect(table.test(line)).toBe(false)
  })
})

describe('splitSurfaceCommand', () => {
  const handler = () => ({ kind: 'success' as const })

  it('hands the registry a definition without the surface flag', () => {
    const { definition, immediate } = splitSurfaceCommand({ name: 'ui', description: 'density', immediate: true, handler })
    expect(definition).toEqual({ name: 'ui', description: 'density', handler })
    expect('immediate' in definition).toBe(false)
    expect(immediate).toBe(true)
  })

  it('defaults to queued', () => {
    expect(splitSurfaceCommand({ name: 'clear', description: 'fresh session', handler }).immediate).toBe(false)
  })
})

describe('/plan off in any case', () => {
  it('runs at once however it is cased', () => {
    const table = new ImmediateCommands(HARNESS_IMMEDIATE)
    expect(table.test('/plan OFF')).toBe(true)
    expect(table.test('/plan Off')).toBe(true)
  })

  it('is spelled the way the harness reads it', () => {
    expect(normalizeCommandLine('/plan OFF')).toBe('/plan off')
    expect(normalizeCommandLine('  /Plan  off ')).toBe('/plan off')
    // A message that only starts with "off" is still a message.
    expect(normalizeCommandLine('/plan OFF the record')).toBe('/plan OFF the record')
    expect(normalizeCommandLine('/theme OFF')).toBe('/theme OFF')
  })
})

describe('commandName', () => {
  it('names the command a / line runs, lowered', () => {
    expect(commandName('/PLAN off')).toBe('plan')
    expect(commandName('  /theme')).toBe('theme')
    expect(commandName('plan')).toBeUndefined()
    expect(commandName('!ls')).toBeUndefined()
  })
})
