import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkInventory, extractSurfaces, loadEvidence, sourceCommands } from './reference-inventory.mjs'

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

  it('rejects nonexistent evidence and mismatched binary pins even after digest recomputation', () => {
    for (const mutation of ['capture', 'source', 'binary']) {
      const register = read('inventory.json'), discovery = read('discovery.json')
      if (mutation === 'binary') discovery.binarySha256 = '0'.repeat(64)
      else {
        const item = discovery.items.find(item => item.observations.some(o => o.locator.startsWith(`${mutation}:`)))
        const observation = item.observations.find(o => o.locator.startsWith(`${mutation}:`))
        const invalid = mutation === 'capture' ? 'capture:commands/999999' : observation.locator.replace(/#L\d+$/, '#L999999')
        register.items.find(row => row.key === item.key).evidence = [invalid]
        observation.locator = invalid
      }
      register.discoverySha256 = createHash('sha256').update(JSON.stringify(discovery)).digest('hex')
      expect(checkInventory(register, discovery).join('\n')).toMatch(mutation === 'binary' ? /binary.*provenance/ : /unresolved evidence/)
    }
  })

  it('checks actual guide and source evidence content, not only reference labels', () => {
    const evidence = loadEvidence()
    evidence.capture.guides[0].text += '\ninvented line'
    const locator = Object.keys(evidence.source.fragments)[0]
    evidence.source.fragments[locator].text = 'invented source'
    expect(checkInventory(read('inventory.json'), read('discovery.json'), evidence).join('\n')).toMatch(/guide hash mismatch/)
    expect(checkInventory(read('inventory.json'), read('discovery.json'), evidence).join('\n')).toMatch(/source evidence digest mismatch/)
    expect(checkInventory(read('inventory.json'), read('discovery.json'), evidence).join('\n')).toMatch(/unresolved evidence/)
  })

  it('rejects paired deletion of source-only rows even with a recomputed register digest', () => {
    for (const removed of ['all-source-only', 'environment:GROK_WORKSPACE_COMMAND', 'source-cli:crates/codegen/xai-grok-pager/src/app/cli.rs:--allowedTools']) {
      const register = read('inventory.json'), discovery = read('discovery.json')
      const keys = new Set(discovery.items.filter(item => removed === 'all-source-only'
        ? item.observations.every(o => o.locator.startsWith('source:')) : item.key === removed).map(item => item.key))
      expect(keys.size).toBeGreaterThan(0)
      discovery.items = discovery.items.filter(item => !keys.has(item.key))
      register.items = register.items.filter(item => !keys.has(item.key))
      register.discoverySha256 = createHash('sha256').update(JSON.stringify(discovery)).digest('hex')
      expect(checkInventory(register, discovery).join('\n')).toMatch(/missing source/)
    }
  })

  it('requires source observation coverage even when the shared identity survives', () => {
    const register = read('inventory.json'), discovery = read('discovery.json')
    const item = discovery.items.find(row => row.key === 'environment:GROK_FPS')
    item.observations = item.observations.filter(observation => !observation.locator.startsWith('source:'))
    register.items.find(row => row.key === item.key).evidence = item.observations.map(observation => observation.locator)
    register.discoverySha256 = createHash('sha256').update(JSON.stringify(discovery)).digest('hex')
    expect(checkInventory(register, discovery).join('\n')).toMatch(/missing source evidence/)
  })

  it('requires hidden-command help observations rather than a source-only inventory label', () => {
    const evidence = loadEvidence()
    evidence.capture.commands = evidence.capture.commands.filter(command => command.args[0] !== 'workspace')
    expect(checkInventory(read('inventory.json'), read('discovery.json'), evidence).join('\n')).toMatch(/missing source command probe workspace/)
  })

  it('discovers hidden command enum variants and aliases independently of visible help', () => {
    const text = '#[derive(Debug, Subcommand)]\npub enum Command {\n    #[command(hide = true)]\n    Share(ShareArgs),\n    #[command(name = "workspace", visible_alias = "ws", hide = true)]\n    Workspace {\n        #[arg(long)]\n        json: bool,\n    },\n}\n'
    const items = extractSurfaces({ commands: [], guides: [] }, [{ path: 'crates/codegen/xai-grok-pager/src/app/cli.rs', text }])
    expect(items.some(item => item.key === 'source-command:Command:share')).toBe(true)
    expect(items.some(item => item.key === 'source-command:Command:workspace')).toBe(true)
    expect(items.some(item => item.key === 'source-command:Command:ws')).toBe(true)
    expect(items.some(item => item.key === 'source-command:Command:json')).toBe(false)
  })

  it('follows nested command enums through argument structs and tuple/inline variants', () => {
    const path = 'crates/codegen/xai-grok-pager/src/app/cli.rs'
    const text = '#[derive(Subcommand)]\npub enum Command {\n    Workspace(WorkspaceArgs),\n}\npub struct WorkspaceArgs {\n    #[command(subcommand)]\n    pub command: WorkspaceCommand,\n}\n#[derive(Subcommand)]\npub enum WorkspaceCommand {\n    #[command(visible_alias = "list")]\n    Status,\n    Db {\n        #[command(subcommand)]\n        command: DbCommand,\n    },\n}\n#[derive(Subcommand)]\npub enum DbCommand {\n    Rebuild,\n}\n'
    const result = sourceCommands([{ path, text }]).flatMap(item => item.commands.map(path => path.join(' ')))
    expect(result).toContain('workspace status')
    expect(result).toContain('workspace list')
    expect(result).toContain('workspace db rebuild')
  })

  it('maps hidden remote commands and interactive tutorial behavior to actual acceptance', () => {
    const rows = read('inventory.json').items
    for (const command of ['workspace', 'workspace start', 'workspace pause', 'workspace resume', 'workspace stop', 'workspace restart', 'workspace status', 'workspace list']) {
      expect(rows.find(row => row.key === `cli:${command}`).tickets).toContain(190)
    }
    expect(rows.find(row => row.key === 'cli:share').tickets).toContain(162)
    for (const name of ['tutorial', 'tour', 'onboarding']) {
      const row = rows.find(row => row.key === `slash:${name}`)
      expect(row.tickets).toContain(154)
      expect(row.acceptance).toContain('PARITY-154-tutorial')
    }
  })

  it('extracts clap attributes, camelCase aliases, macro aliases and source environment controls', () => {
    const capture = { commands: [], guides: [] }
    const sources = [
      { path: 'crates/codegen/xai-grok-pager/src/app/cli.rs', text: '#[clap(long = "allow", alias = "allowedTools")]\npub allow_rules: String,\n#[clap(long, hide = true)]\npub compaction_mode: String,' },
      { path: 'crates/codegen/xai-grok-pager/src/slash/commands/recap.rs', text: 'slash_meta! {\n name: "recap",\n aliases: ["summarize"],\n    }' },
      { path: 'crates/codegen/xai-grok-pager/src/views/fps_hud.rs', text: 'std::env::var("GROK_FPS").ok()' },
    ]
    const keys = new Set(extractSurfaces(capture, sources).map(item => item.key))
    expect(keys.has('source-cli:crates/codegen/xai-grok-pager/src/app/cli.rs:--allowedTools')).toBe(true)
    expect(keys.has('source-cli:crates/codegen/xai-grok-pager/src/app/cli.rs:--allow-rules')).toBe(false)
    expect(keys.has('source-cli:crates/codegen/xai-grok-pager/src/app/cli.rs:--compaction-mode')).toBe(true)
    expect(keys.has('slash:summarize')).toBe(true)
    expect(keys.has('environment:GROK_FPS')).toBe(true)
  })

  it('assigns automation input, global shortcuts and rendering controls to applicable acceptance', () => {
    const register = read('inventory.json')
    for (const flag of ['--prompt-file', '--prompt-json', '--system-prompt-override']) {
      const row = register.items.find(item => item.key === `flag:grok:${flag}`)
      expect(row.tickets).toContain(145)
      expect(row.acceptance).toContain('PARITY-145-input')
    }
    for (const row of register.items.filter(item => item.key.startsWith('keybinding:03-keyboard-shortcuts.md:Global'))) {
      expect(row.tickets).not.toContain(169)
    }
    expect(register.items.find(item => item.key === 'pager-setting:animation.fps').tickets).toContain(154)
    const fps = read('discovery.json').items.find(item => item.key === 'environment:GROK_FPS')
    expect(fps.observations.some(observation => observation.scope === 'binary-pty-observation')).toBe(true)
    for (const alias of ['log', 'summarize']) expect(register.items.some(item => item.key === `slash:${alias}`)).toBe(true)
    for (const [key, owners] of [
      ['Ctrl+G', [150, 175]], ['Ctrl+M', [140, 150]],
    ]) {
      const row = register.items.find(item => item.key === `keybinding:03-keyboard-shortcuts.md:Agent-Level:\`${key}\``)
      for (const owner of owners) expect(row.tickets).toContain(owner)
    }
  })

  it('assigns the entire permission guide to security effects rather than keyword lookalikes', () => {
    const register = read('inventory.json')
    const rows = register.items.filter(item => item.key.includes(':22-permissions-and-safety.md:'))
    expect(rows.length).toBeGreaterThan(100)
    for (const row of rows) {
      expect(row.tickets, row.key).toContain(142)
      expect(row.tickets, row.key).not.toContain(163)
      expect(row.tickets, row.key).not.toContain(189)
      expect(row.tickets, row.key).not.toContain(150)
      expect(row.acceptance, row.key).toContain('PARITY-142-security-effects')
      if (/How a tool call is authorized|with a Hook|Allow Only `git`/.test(row.key)) expect(row.tickets).toContain(164)
    }
  })

  it('requires real-PTY acceptance for help, docs, diagnostics and dock controls', () => {
    const register = read('inventory.json')
    for (const [name, scenario] of [['help', 'PARITY-154-help'], ['docs', 'PARITY-154-docs'], ['howto', 'PARITY-154-docs'], ['guides', 'PARITY-154-docs'], ['debug', 'PARITY-154-debug'], ['scroll-debug', 'PARITY-154-debug']]) {
      const row = register.items.find(item => item.key === `slash:${name}`)
      expect(row.tickets).toContain(154)
      expect(row.acceptance).toContain(scenario)
      expect(row.acceptance).not.toContain('PARITY-145')
    }
    for (const row of register.items.filter(item => /^(?:guide-section|guide-behavior):04-slash-commands\.md:`\/(?:docs|help|debug)`/.test(item.key))) {
      expect(row.tickets, row.key).toContain(154)
      expect(row.acceptance, row.key).not.toContain('PARITY-145')
    }
    expect(register.items.find(item => item.key === 'flag:grok:--help').tickets).toEqual([145])
    for (const key of ['feature:dock', 'setting:features.dock', 'environment:GROK_DOCK']) {
      const row = register.items.find(item => item.key === key)
      expect(row.tickets).toContain(152)
      expect(row.acceptance).toContain('PARITY-152-dock')
      expect(row.blocker).toMatch(/availability.*unverified/i)
    }
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
