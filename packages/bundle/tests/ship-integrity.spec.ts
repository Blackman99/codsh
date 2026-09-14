/** Goal preservation through the public run seam and real filesystem copies. */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseAcceptanceCriteria, parseMainTrack } from '../src/plan.ts'
import { ShipRun } from '../src/ship-run.ts'

const roots: string[] = []
const workspace = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'ship-integrity-'))
  roots.push(path)
  mkdirSync(join(path, 'docs', 'specs'), { recursive: true })
  return path
}
const chrome = { setPlan: () => {}, setChip: () => {} }
const spec = (status: string, original = 'Keep exports available offline.'): string => [
  `Status: ${status}`,
  '',
  '## Original Requirement',
  '',
  original,
  '',
  '## Main Track',
  '',
  'Track-1: Exports require no network.',
  'Out of Scope: cloud synchronization.',
  '',
  '## Acceptance Criteria',
  '',
  '1. Run `pnpm test`; offline export passes with exit 0.',
  '',
].join('\n')

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('ship goal integrity', () => {
  it('retains the same frozen contract after copying a checkout to a new absolute path', async () => {
    const source = workspace()
    const destination = workspace()
    writeFileSync(join(source, 'docs', 'specs', 'offline.md'), spec('confirmed'))
    await new ShipRun(source, chrome).run('', async () => {})
    cpSync(join(source, 'docs'), join(destination, 'docs'), { recursive: true })
    const prompts: string[] = []
    const messages: string[] = []
    await new ShipRun(destination, chrome, { flash: text => { messages.push(text) } })
      .run('', async prompt => { prompts.push(prompt) })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Keep exports available offline.')
    expect(prompts[0]).toContain(join(destination, 'docs', 'specs', 'offline.md'))
    expect(messages.join('\n')).not.toContain('Stopped')
  })

  it('recovers an explicit legacy Requirement before falling back to its design summary', async () => {
    const cwd = workspace()
    writeFileSync(join(cwd, 'docs', 'specs', 'legacy.md'), [
      'Status: interviewing',
      '',
      '## Requirement',
      '',
      '用户原话：离线时仍能导出，不增加联网依赖。',
      '',
      '## Main Track',
      '',
      'Track-1: add an export command.',
      '',
    ].join('\n'))
    const prompts: string[] = []
    await new ShipRun(cwd, chrome).run('', async prompt => { prompts.push(prompt) })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('## Original Requirement\n\n用户原话：离线时仍能导出，不增加联网依赖。')
  })

  it('rejects a new ledger that replaces the typed goal before the first phase ends', async () => {
    const cwd = workspace()
    const messages: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { messages.push(text) } })
    await ship.run('Keep exports available offline.', async () => {
      writeFileSync(join(cwd, 'docs', 'specs', 'offline.md'), spec('grilling', 'Upload exports to a cloud service.'))
    })
    expect(messages.join('\n')).toMatch(/original|requirement|goal/i)
    expect(messages.join('\n')).toMatch(/block|stop|match|differ/i)
  })

  it('lets a bare ship with no saved work ask for the requirement without creating an empty goal', async () => {
    const cwd = workspace()
    const prompts: string[] = []
    const objectives: string[] = []
    const ship = new ShipRun(cwd, chrome, {
      goals: {
        get: async () => undefined,
        create: async objective => {
          objectives.push(objective)
          return { id: 'goal', objective, phase: 'active', activation: 'armed' }
        },
        edit: async () => { throw new Error('unexpected edit') },
        pause: async () => { throw new Error('unexpected pause') },
        resume: async () => { throw new Error('unexpected resume') },
        complete: async () => { throw new Error('unexpected completion') },
        clear: async () => {},
      },
    })
    await ship.run('', async prompt => { prompts.push(prompt) })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('ask_user_question')
    expect(objectives).toEqual([])
  })

  it('does not silently regenerate a snapshot removed between calls on the same runner', async () => {
    const cwd = workspace()
    const path = join(cwd, 'docs', 'specs', 'offline.md')
    writeFileSync(path, spec('confirmed'))
    const messages: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: message => { messages.push(message) } })
    await ship.run('', async () => {})
    const snapshot = readdirSync(join(cwd, 'docs', 'specs')).find(name => name.endsWith('.ship.json'))
    expect(snapshot).toBeDefined()
    rmSync(join(cwd, 'docs', 'specs', snapshot!))
    const prompts: string[] = []
    await ship.run('', async prompt => { prompts.push(prompt) })
    expect(prompts).toEqual([])
    expect(messages.join('\n')).toMatch(/snapshot.*(?:missing|removed)/i)
  })

  it('rejects a confirmed modern spec without the Main Track instead of continuing unsealed', async () => {
    const cwd = workspace()
    const path = join(cwd, 'docs', 'specs', 'offline.md')
    writeFileSync(path, 'Status: confirmed\n\n## Original Requirement\n\nKeep exports offline.\n')
    const prompts: string[] = []
    const messages: string[] = []
    await new ShipRun(cwd, chrome, { flash: message => { messages.push(message) } })
      .run('', async prompt => { prompts.push(prompt) })
    expect(prompts).toEqual([])
    expect(messages.join('\n')).toMatch(/Main Track.*missing/i)
  })

  it('does not complete a goal by jumping directly from spec synthesis to shipped', async () => {
    const cwd = workspace()
    const path = join(cwd, 'docs', 'specs', 'offline.md')
    writeFileSync(path, spec('interviewing'))
    const messages: string[] = []
    await new ShipRun(cwd, chrome, { flash: message => { messages.push(message) } })
      .run('', async () => { writeFileSync(path, spec('shipped')) })
    expect(messages.join('\n')).toContain('Invalid ship phase transition')
  })

  it('blocks an attempted re-interview of a sealed spec after restart', async () => {
    const cwd = workspace()
    const path = join(cwd, 'docs', 'specs', 'offline.md')
    writeFileSync(path, spec('confirmed'))
    await new ShipRun(cwd, chrome).run('', async () => {})
    writeFileSync(path, spec('interviewing'))
    const prompts: string[] = []
    await new ShipRun(cwd, chrome).run('', async prompt => { prompts.push(prompt) })
    expect(prompts).toEqual([])
  })

  it('keeps headings inside proof command fences in the frozen section', () => {
    const body = [
      '1. Run this command and require exit 0:',
      '```sh',
      '# Verify the original requirement',
      'pnpm test',
      '```',
      '2. Export must work with networking disabled.',
    ].join('\n')
    const markdown = `## Acceptance Criteria\n\n${body}\n\n## Plan\n\n- [ ] Ticket 1\n`
    expect(parseAcceptanceCriteria(markdown)).toBe(body)
    expect(parseMainTrack(markdown.replace('## Acceptance Criteria', '## Main Track'))).toBe(body)
  })
})
