import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkInventory, extractSurfaces } from './reference-inventory.mjs'

const read = name => JSON.parse(readFileSync(new URL(`../docs/rewrite/reference/${name}`, import.meta.url), 'utf8'))

describe('frozen reference coverage register', () => {
  it('covers every discovered item with a story, ticket, acceptance and evidence or blocker', () => {
    expect(checkInventory(read('inventory.json'), read('discovery.json'))).toEqual([])
  })

  it('detects deletion, duplicate identity, unmapped behavior, and fabricated verification', () => {
    const register = read('inventory.json')
    const discovery = read('discovery.json')
    const missing = structuredClone(register)
    missing.items.pop()
    expect(checkInventory(missing, discovery).join('\n')).toMatch(/missing/)
    const duplicate = structuredClone(register)
    duplicate.items.push(duplicate.items[0])
    expect(checkInventory(duplicate, discovery).join('\n')).toMatch(/duplicate/)
    const unmapped = structuredClone(register)
    unmapped.items[0].tickets = []
    expect(checkInventory(unmapped, discovery).join('\n')).toMatch(/ticket/)
    const invented = structuredClone(register)
    invented.items[0].status = 'verified'
    expect(checkInventory(invented, discovery).join('\n')).toMatch(/status/)
  })

  it('maps every mode, platform, terminal and service dependency to inventoried evidence', () => {
    const keys = new Set(read('discovery.json').items.map(item => item.key))
    const tickets = new Set(read('inventory.json').tickets.map(item => item.number))
    const dimensions = read('dimensions.json').rows
    expect(new Set(dimensions.map(item => `${item.kind}:${item.name}`)).size).toBe(dimensions.length)
    for (const item of dimensions) {
      expect(item.dependency.length).toBeGreaterThan(10)
      expect(item.inventoryKeys.length).toBeGreaterThan(0)
      expect(item.inventoryKeys.every(key => keys.has(key))).toBe(true)
      expect(item.tickets.every(ticket => tickets.has(ticket))).toBe(true)
    }
  })

  it('reconciles every binary-derived surface independently of the checked-in inventory', () => {
    const capture = read('observations.json')
    capture.modelRequests = read('model-observations.json').requests
    const discovery = new Map(read('discovery.json').items.map(item => [item.key, item]))
    for (const item of extractSurfaces(capture, [])) {
      expect(discovery.has(item.key), item.key).toBe(true)
      for (const observation of item.observations) expect(discovery.get(item.key).observations).toContainEqual(observation)
    }
  })

  it('keeps new discoveries as explicit local tasks with real owners', () => {
    const keys = new Set(read('discovery.json').items.map(item => item.key))
    const tickets = new Set(read('inventory.json').tickets.map(item => item.number))
    for (const task of read('follow-ups.json').tasks) {
      expect(task.owners.length).toBeGreaterThan(0)
      expect(task.owners.every(ticket => tickets.has(ticket))).toBe(true)
      expect((task.inventoryKeys ?? []).every(key => keys.has(key))).toBe(true)
      expect(task.acceptance.length).toBeGreaterThan(1)
      expect(task.status).toMatch(/^open/)
    }
  })

  it('rejects fabricated evidence and acceptance assigned to the wrong ticket', () => {
    const register = read('inventory.json')
    register.items[0].evidence = ['capture:commands/999999']
    register.items[0].acceptance = ['PARITY-133']
    expect(checkInventory(register, read('discovery.json')).join('\n')).toMatch(/invalid evidence/)
    expect(checkInventory(register, read('discovery.json')).join('\n')).toMatch(/test mapping/)
  })

  it('extracts commands and flags, including nested help and aliases', () => {
    const capture = { guides: [], commands: [{ args: ['memory', '--help'], exit: 0,
      stdout: 'Usage: grok memory [COMMAND]\n\nCommands:\n  list  List notes\n  help  Help\n\nOptions:\n  -h, --help  Help\n      --json  JSON [aliases: --machine]\n' }] }
    const items = extractSurfaces(capture, [])
    expect(items.some(item => item.key === 'cli:memory list')).toBe(true)
    expect(items.some(item => item.key === 'flag:memory:--json')).toBe(true)
    expect(items.some(item => item.key === 'flag:memory:-h')).toBe(true)
    expect(items.some(item => item.key === 'flag:memory:--machine')).toBe(true)
  })
})
