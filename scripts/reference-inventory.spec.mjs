import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkInventory, extractSurfaces, loadEvidence, sourceCommands } from './reference-inventory.mjs'
import { buildRegister, guideContexts, guideLines, mapOwners } from './reference-mapping.mjs'

const read = name => JSON.parse(readFileSync(new URL(`../docs/rewrite/reference/${name}`, import.meta.url), 'utf8'))

describe('frozen reference coverage register', () => {
  it('covers every discovered item with a story, ticket, acceptance and evidence or blocker', () => {
    const discovery = read('discovery.json')
    expect(checkInventory(read('inventory.json'), discovery)).toEqual([])
    const counts = Object.fromEntries([...new Set(discovery.items.map(item => item.category))].map(category => [category, discovery.items.filter(item => item.category === category).length]))
    expect(read('provenance.json').counts).toEqual(counts)
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

  it('reproduces the register from committed guide/namespace rules and rejects keyword collisions', () => {
    const register = read('inventory.json')
    expect(buildRegister(read('discovery.json'), register.tickets, loadEvidence())).toEqual(register)
    const rows = [
      ['07-mcp-servers.md', 'Session updates and stdio headers', [167]],
      ['10-hooks.md', 'Prompt feedback and shell result updates', [164]],
      ['11-custom-models.md', 'Default headers and auth refresh', [140]],
      ['15-agent-mode.md', 'Streaming update notifications', [147]],
      ['18-sandbox.md', 'Global paths and parent rename', [143, 144]],
      ['19-plan-mode.md', 'Feedback updates and prompt history', [179]],
      ['12-project-rules.md', 'Commit requirements and instructions', [163]],
      ['27-grok-clone.md', 'History and authentication', [191]],
    ]
    for (const [file, title, owners] of rows) {
      const capture = { commands: [], guides: [{ file, text: `## ${title}\nAn observable contract.\n\n| Field | Behavior |\n| --- | --- |\n| headers | updates |` }] }
      const contexts = guideContexts({ capture, source: { guides: [] } })
      for (const item of extractSurfaces(capture, [])) expect(mapOwners(item, contexts), item.key).toEqual(owners)
    }
    for (const item of read('discovery.json').items.filter(item => item.category === 'acp-extension')) {
      expect(mapOwners(item), item.key).toContain(147)
      expect(mapOwners(item), item.key).not.toContain(198)
    }
  })

  it('rejects internally consistent but semantically wrong owners and weakened scenarios', () => {
    const register = read('inventory.json'), discovery = read('discovery.json')
    const row = register.items.find(item => item.key === 'acp-extension:x.ai/session/update')
    row.tickets = [198]
    row.stories = register.tickets.find(ticket => ticket.number === 198).stories
    row.acceptance = ['PARITY-198']
    expect(checkInventory(register, discovery).join('\n')).toMatch(/contextual mapping drift/)
    const weakened = read('inventory.json')
    weakened.acceptance.find(scenario => scenario.id === 'PARITY-164-prompt').then = 'The UI looks correct.'
    expect(checkInventory(weakened, discovery).join('\n')).toMatch(/contextual acceptance drift/)
  })

  it('uses ancestor context for nested guide paragraphs and command options', () => {
    const capture = { commands: [], guides: [
      { file: '10-hooks.md', text: '## UserPromptSubmit Decision Control\n### Failure handling\nA delayed hook result.' },
      { file: '07-mcp-servers.md', text: '## HTTP/SSE Transport (Remote Server)\n### Headers\nA session header.' },
      { file: '04-slash-commands.md', text: '## `/docs`\n### Options\nA title or web target.' },
    ] }
    const contexts = guideContexts({ capture, source: { guides: [] } })
    for (const item of extractSurfaces(capture, []).filter(item => item.category === 'guide-behavior')) {
      const expected = item.name.startsWith('10-') ? [164, 151, 138] : item.name.startsWith('07-') ? [167, 168] : [154]
      expect(mapOwners(item, contexts), item.key).toEqual(expected)
    }
  })

  it('keeps guide security contracts with their enforcing owners across guide boundaries', () => {
    const register = read('inventory.json')
    for (const [key, owners, scenario] of [
      ['10-hooks.md:UserPromptSubmit Decision Control', [164, 151, 138], 'PARITY-164-prompt'],
      ['18-sandbox.md:Direct global write protection', [143, 144], 'PARITY-143-confinement'],
      ['18-sandbox.md:Direct global hook write protection', [143, 144], 'PARITY-143-confinement'],
      ['09-plugins.md:Trust and security', [165, 141], 'PARITY-141'],
      ['14-headless-mode.md:Permission Rules (`--allow` / `--deny`)', [142], 'PARITY-142-security-effects'],
      ['01-getting-started.md:Permissions', [142], 'PARITY-142-security-effects'],
      ['11-custom-models.md:Fleet allowlist (`requirements.toml`)', [140, 141], 'PARITY-141'],
    ]) {
      const rows = register.items.filter(row => row.key === `guide-section:${key}` || row.key.startsWith(`guide-behavior:${key}:`))
      expect(rows.length, key).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.tickets, row.key).toEqual(expect.arrayContaining(owners))
        expect(row.acceptance, row.key).toContain(scenario)
        expect(row.tickets, row.key).not.toContain(150)
        expect(row.tickets, row.key).not.toContain(169)
      }
    }
    for (const key of ['setting:ui.permission_mode', 'setting:ui.remember_tool_approvals', 'setting:ui.disable_bypass_permissions_mode', 'environment:GROK_REMEMBER_TOOL_APPROVALS', 'guide-item:14-headless-mode.md:Command-Line Options:`--deny <RULE>`']) {
      const row = register.items.find(row => row.key === key)
      expect(row.tickets, key).toContain(142)
      expect(row.acceptance, key).toContain('PARITY-142-security-effects')
    }
    const prompt = register.acceptance.find(row => row.id === 'PARITY-164-prompt')
    expect(prompt.then).toMatch(/provider context.*durable history/)
    expect(prompt.then).toMatch(/queue.*suspend/)
    expect(prompt.failure).toMatch(/observe-only/)
    expect(prompt.failure).toMatch(/timeout/)
    const confinement = register.acceptance.find(row => row.id === 'PARITY-143-confinement')
    expect(confinement.then).toMatch(/kernel.*denial/)
    expect(confinement.when).toMatch(/parent.*rename/)
    expect(confinement.failure).toMatch(/symlink.*refus/)
  })

  it('assigns MCP transports and model headers by namespace, not shared words', () => {
    const register = read('inventory.json')
    for (const section of ['HTTP/SSE Transport (Remote Server)', 'stdio Transport (Local Process)', 'Streamable HTTP with Session ID', 'Local stdio', 'Native HTTP (hosted services)']) {
      const row = register.items.find(row => row.key === `guide-section:07-mcp-servers.md:${section}`)
      expect(row.tickets).toContain(167)
      expect(row.acceptance).toContain('PARITY-167-transport')
      expect(row.tickets).not.toContain(147)
      expect(row.tickets).not.toContain(148)
      expect(row.tickets).not.toContain(145)
      if (/HTTP/.test(section)) expect(row.tickets).toContain(168)
    }
    for (const key of ['setting:models.extra_headers', 'setting:model.<id>.env_http_headers', 'documented-setting:05-configuration.md:models.extra_headers', 'documented-setting:11-custom-models.md:model.gateway.env_http_headers', 'guide-section:11-custom-models.md:Global Default Headers', 'guide-section:11-custom-models.md:Environment-Variable Headers']) {
      const row = register.items.find(row => row.key === key)
      expect(row.tickets).toEqual([140])
      expect(row.acceptance).toContain('PARITY-140-headers')
    }
    const transport = register.acceptance.find(row => row.id === 'PARITY-167-transport')
    expect(transport.when).toMatch(/handshake.*stdio.*HTTP.*SSE/)
    expect(transport.then).toMatch(/session.*header/)
    expect(transport.failure).toMatch(/reconnect/)
    const headers = register.acceptance.find(row => row.id === 'PARITY-140-headers')
    expect(headers.then).toMatch(/case-insensitive/)
    expect(headers.failure).toMatch(/unset.*blank/)
  })

  it('keeps ACP updates in protocol/session ownership and plan feedback in plan review', () => {
    const register = read('inventory.json')
    for (const name of ['x.ai/session/update', 'x.ai/session/updates', 'x.ai/session/updates/chunk']) {
      const row = register.items.find(row => row.key === `acp-extension:${name}`)
      expect(row.tickets).toEqual([147, 148, 138])
      expect(row.acceptance).toContain('PARITY-147-updates')
    }
    for (const key of ['acp-extension:x.ai/models/update', 'acp-extension:x.ai/settings/update', 'acp-extension:x.ai/announcements/update', 'guide-section:15-agent-mode.md:Streaming updates']) {
      const row = register.items.find(row => row.key === key)
      expect(row.tickets).toContain(147)
      expect(row.tickets).not.toContain(198)
    }
    const row = register.items.find(row => row.key === 'guide-section:19-plan-mode.md:Providing Feedback')
    expect(row.tickets).toEqual([179])
    expect(row.acceptance).toContain('PARITY-179-review')
    const updates = register.acceptance.find(row => row.id === 'PARITY-147-updates')
    expect(updates.when).toMatch(/replay.*pagination.*chunk/)
    expect(updates.then).toMatch(/order.*completion.*routing/)
    const plan = register.acceptance.find(row => row.id === 'PARITY-179-review')
    expect(plan.then).toMatch(/plan mode.*active/)
    expect(plan.failure).toMatch(/command.*approval/)
  })

  it('assigns small interactive commands to stateful scenarios without claiming source availability', () => {
    const register = read('inventory.json')
    for (const [name, ticket, scenario] of [['announcements', 154, 'PARITY-154-announcements'], ['cd', 159, 'PARITY-159-location'], ['gboom', 154, 'PARITY-154-gboom']]) {
      const row = register.items.find(row => row.key === `slash:${name}`)
      expect(row.tickets).toContain(ticket)
      expect(row.acceptance).toContain(scenario)
      expect(row.acceptance).not.toContain('PARITY-145')
      expect(row.blocker).toMatch(/1\.0\.34.*unverified/)
    }
    expect(register.acceptance.find(row => row.id === 'PARITY-154-announcements').then).toMatch(/conditional visibility/)
    expect(register.acceptance.find(row => row.id === 'PARITY-159-location').then).toMatch(/subsequent.*cwd/)
    expect(register.acceptance.find(row => row.id === 'PARITY-154-gboom').when).toMatch(/argument passthrough/)
  })

  it('discovers compatibility environment controls without a vendor-prefix allowlist', () => {
    const sources = [{ path: 'crates/config.rs', text: 'const ENV_START: &str = "MCP_TIMEOUT";\npub const ENV_LIMIT: &str = "MAX_MCP_OUTPUT_BYTES";\nstd::env::var_os("COMPAT_CUSTOM_LIMIT");\nconst EVENT_NAME: &str = "NOT_AN_ENVIRONMENT_CONTROL";' }]
    const guides = [{ file: '07-mcp-servers.md', text: '## Configuration\nUse the `MCP_TIMEOUT` environment variable.\nEnvironment override: `MAX_MCP_OUTPUT_BYTES`.\nUse `COMPAT_DOC_LIMIT`\nenvironment variable for the cap.' }]
    const items = extractSurfaces({ commands: [], guides }, sources)
    for (const name of ['MCP_TIMEOUT', 'MAX_MCP_OUTPUT_BYTES', 'COMPAT_CUSTOM_LIMIT', 'COMPAT_DOC_LIMIT']) expect(items.some(row => row.key === `environment:${name}`), name).toBe(true)
    expect(items.some(row => row.key === 'environment:NOT_AN_ENVIRONMENT_CONTROL')).toBe(false)
    for (const name of ['MCP_TIMEOUT', 'MAX_MCP_OUTPUT_BYTES']) {
      const item = read('discovery.json').items.find(row => row.key === `environment:${name}`)
      expect(item, name).toBeDefined()
      expect(item.observations.some(o => o.scope === 'binary-guide')).toBe(true)
      expect(item.observations.some(o => o.locator.startsWith('source:'))).toBe(true)
      const row = read('inventory.json').items.find(row => row.key === item.key)
      expect(row.tickets).toContain(167)
      expect(row.acceptance).toContain('PARITY-167-limits')
    }
    const limits = read('inventory.json').acceptance.find(row => row.id === 'PARITY-167-limits')
    expect(limits.then).toMatch(/MCP_TIMEOUT.*round.*GROK_MCP_STARTUP_TIMEOUT_SECS/)
    expect(limits.then).toMatch(/GROK_MAX_MCP_OUTPUT_BYTES.*MAX_MCP_OUTPUT_BYTES/)
    expect(limits.then).toMatch(/truncation.*spill/)
    expect(limits.failure).toMatch(/malformed.*zero.*overflow/)
  })

  it.each([
    ['ui.yolo', [142]], ['ui.approval_mode', [142]], ['ui.follow_up_behavior', [151]],
    ['ui.cancel_subagents_on_turn_cancel', [137, 173]], ['ui.simple_mode', [150]],
    ['toolset.bash.auto_background_on_timeout', [170, 175]], ['toolset.bash.login_shell_capture', [170]],
    ['toolset.bash.max_timeout_secs', [170]], ['toolset.bash.output_byte_limit', [170]], ['toolset.bash.timeout_secs', [170]],
    ['toolset.ask_user_question.timeout_secs', [179]], ['toolset.web_fetch.allowed_domains', [171]],
    ['toolset.web_fetch.proxy_endpoint', [171]], ['toolset.web_search.allowed_domains', [171]], ['toolset.web_search.excluded_domains', [171]],
    ['compat.claude.hooks', [164]], ['compat.codex.hooks', [164]], ['compat.cursor.hooks', [164]],
    ['compat.claude.mcps', [167]], ['compat.cursor.mcps', [167]],
  ])('assigns functional configuration %s to effect-based owners', (name, owners) => {
    const register = read('inventory.json'), row = register.items.find(item => item.key === `setting:${name}`)
    expect(row.tickets).toEqual(owners)
    expect(row.acceptance).not.toContain('PARITY-154')
    expect(row.acceptance).not.toContain('PARITY-169')
    for (const owner of owners) expect(row.acceptance.some(id => register.acceptance.find(test => test.id === id)?.ticket === owner)).toBe(true)
    if (name === 'ui.cancel_subagents_on_turn_cancel') {
      expect(row.acceptance).toContain('PARITY-137-children')
      const scenario = register.acceptance.find(test => test.id === 'PARITY-137-children')
      expect(scenario.when).toMatch(/ask.*always_stop.*always_continue/)
      expect(scenario.then).toMatch(/actual child.*lifecycle/)
    }
  })

  it.each([
    ['GROK_MANAGED_MCPS_ENABLED', 167], ['GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED', 167],
    ['GROK_XAI_API_BASE_URL', 140], ['GROK_FOLDER_TRUST', 141],
    ['GROK_DEFAULT_SELECTED_PERMISSION', 142], ['GROK_DEFAULT_PERMISSION_MODE', 142], ['GROK_AUTO_PERMISSION_MODE', 142],
  ])('maps functional environment alias %s independently of the guide mentioning it', (name, owner) => {
    const register = read('inventory.json'), row = register.items.find(item => item.key === `environment:${name}`)
    expect(row.tickets).toEqual([owner])
    expect(row.acceptance.some(id => register.acceptance.find(test => test.id === id)?.ticket === owner)).toBe(true)
  })

  it('keeps namespace ownership when documented settings merge general and enterprise observations', () => {
    const text = '## General settings\n```toml\n[models]\ndefault = "general"\n[features]\ntelemetry = false\n[cli]\nauto_update = true\n```\n## Enterprise deployment\n```toml\n[models]\ndefault = "company"\n[features]\ntelemetry = false\n[cli]\nauto_update = false\n```'
    const capture = { commands: [], guides: [{ file: '05-configuration.md', text }] }
    const contexts = guideContexts({ capture, source: { guides: [] } })
    const items = extractSurfaces(capture, []).filter(item => item.category === 'documented-setting')
    const register = read('inventory.json')
    for (const [field, owner] of [['models.default', 140], ['features.telemetry', 192], ['cli.auto_update', 198]]) {
      const name = `05-configuration.md:${field}`, item = items.find(item => item.name === name)
      expect(item.observations).toHaveLength(2)
      expect(mapOwners(item, contexts)).toEqual([owner, 141, 189])
      expect(mapOwners({ ...item, observations: [...item.observations].reverse() }, contexts)).toEqual([owner, 141, 189])
      const row = register.items.find(item => item.key === `documented-setting:${name}`)
      expect(row.tickets).toEqual([owner, 141, 189])
      expect(row.acceptance).toContain(`PARITY-${owner}`)
    }
    const terminal = register.items.find(item => item.key === 'documented-setting:06-theming.md:terminal.alt_screen')
    expect(terminal.tickets).toContain(149)
    expect(terminal.acceptance).toContain('PARITY-149')
  })

  it('keeps code-review uploads separate from local plan-review feedback', () => {
    const register = read('inventory.json')
    for (const name of ['x.ai/review/comment', 'x.ai/review/comment/delete']) {
      const row = register.items.find(item => item.key === `acp-extension:${name}`)
      expect(row.tickets).toEqual([147, 192])
      expect(row.acceptance).toContain('PARITY-192-review-upload')
      expect(row.tickets).not.toContain(179)
    }
    const upload = register.acceptance.find(test => test.id === 'PARITY-192-review-upload')
    expect(upload.when).toMatch(/citation.*tombstone/)
    expect(upload.then).toMatch(/consent.*destination/)
    expect(upload.failure).toMatch(/acknowledg.*upload/)
    expect(register.items.find(item => item.key === 'guide-section:19-plan-mode.md:Providing Feedback').tickets).toEqual([179])
  })

  it('extracts unprefixed and assignment-form environment hints from docs and source', () => {
    const capture = { commands: [], guides: [{ file: '06-theming.md', text: '## Detection\nEnvironment fallback: `COLORFGBG`.\n\nSet `LC_GROK_THEME` to force a theme.\n\n| Level | Detection |\n| --- | --- |\n| Truecolor | `COLORTERM=truecolor` |\n\nSet `ALTCONSOLE` to select a console.\nThe `RGB` acronym describes colors.\n\nThe --env flag accepts `KEY=value`.' }] }
    const sources = [{ path: 'crates/theme.rs', text: 'env.get("COLORTERM");\nparse_colorfgbg(env_nonempty(env, "COLORFGBG"));\nfor key in ["GROK_THEME", "LC_GROK_THEME"] {\n    env.get(key);\n}\nconst LABEL: &str = "NOT_AN_ENV";' }]
    const items = extractSurfaces(capture, sources)
    for (const name of ['COLORFGBG', 'LC_GROK_THEME', 'COLORTERM']) {
      const item = items.find(item => item.key === `environment:${name}`)
      expect(item, name).toBeDefined()
      expect(item.observations.some(o => o.scope === 'binary-guide')).toBe(true)
      expect(item.observations.some(o => o.locator.startsWith('source:'))).toBe(true)
      const actual = read('discovery.json').items.find(item => item.key === `environment:${name}`)
      expect(actual, name).toBeDefined()
      for (const scope of ['binary-guide', 'source-guide', 'source-environment-provisional']) expect(actual.observations.some(o => o.scope === scope), `${name}:${scope}`).toBe(true)
      expect(read('inventory.json').items.find(item => item.key === actual.key).tickets).toEqual([154])
    }
    expect(items.some(item => item.key === 'environment:ALTCONSOLE')).toBe(true)
    expect(items.some(item => item.key === 'environment:RGB')).toBe(false)
    expect(items.some(item => item.key === 'environment:KEY')).toBe(false)
    expect(items.some(item => item.key === 'environment:NOT_AN_ENV')).toBe(false)
  })

  it.each([
    ['ui.combine_queued_prompts', [151]], ['ui.confirm_before_rewind', [160]],
    ['ui.fork_secondary_model', [140, 160]], ['ui.screen_mode', [149]],
    ['ui.voice_capture_mode', [158]], ['ui.voice_keybind_enabled', [158]], ['ui.voice_stt_language', [158]],
    ['ui.vim_mode', [152]],
  ])('keeps operational UI control %s out of renderer-only acceptance', (name, owners) => {
    const register = read('inventory.json'), row = register.items.find(item => item.key === `setting:${name}`)
    expect(row.tickets).toEqual(owners)
    expect(row.acceptance).not.toContain('PARITY-154')
    for (const owner of owners) expect(row.acceptance.some(id => register.acceptance.find(test => test.id === id)?.ticket === owner)).toBe(true)
  })

  it.each([
    ['GROK_CLAUDE_HOOKS_ENABLED', 164], ['GROK_CURSOR_HOOKS_ENABLED', 164], ['GROK_CODEX_MCPS_ENABLED', 167],
    ['GROK_DISABLE_API_KEY_AUTH', 189], ['GROK_MANAGED_CONFIG_URL', 141], ['GROK_WEB_FETCH_PROXY', 171],
    ['GROK_ASK_USER_QUESTION_TIMEOUT_SECS', 179], ['GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED', 179],
    ['GROK_THEME', 154], ['GROK_APPEARANCE', 154], ['LC_GROK_APPEARANCE', 154], ['NO_COLOR', 154],
    ['GROK_WORKSPACE_ROOT', 164],
  ])('routes documented alias %s to its functional domain', (name, owner) => {
    const row = read('inventory.json').items.find(item => item.key === `environment:${name}`)
    expect(row.tickets).toEqual([owner])
  })

  it('specifies actual queue, fork, mode and voice configuration effects', () => {
    const tests = read('inventory.json').acceptance
    expect(tests.find(test => test.id === 'PARITY-151').then).toMatch(/provider requests.*turn counts.*merging/)
    expect(tests.find(test => test.id === 'PARITY-160').then).toMatch(/secondary provider.*fork model/)
    expect(tests.find(test => test.id === 'PARITY-160').failure).toMatch(/dismissal leaves history unchanged/)
    expect(tests.find(test => test.id === 'PARITY-149').then).toMatch(/persisted default.*restart/)
    expect(tests.find(test => test.id === 'PARITY-158').then).toMatch(/voice_stt_language.*voice.language.*provider requests/)
  })

  it('uses explicit config-reference alias relationships rather than lexical prefixes', () => {
    const item = { category: 'environment', name: 'GROK_WORKSPACE_SAMPLE', key: 'environment:GROK_WORKSPACE_SAMPLE', observations: [
      { locator: 'binary-guide:26-config-reference.md#L1', excerpt: '| `compat.cursor.hooks` | `boolean` | Scan hooks. Also GROK_WORKSPACE_SAMPLE. |' },
    ] }
    expect(mapOwners(item)).toEqual([164])
    expect(mapOwners({ ...item, observations: [{ ...item.observations[0], excerpt: '| `endpoints.managed_config_url` | `string` | Also GROK_WORKSPACE_SAMPLE. |' }] })).toEqual([141])
    expect(mapOwners({ ...item, name: 'GROK_HOME', key: 'environment:GROK_HOME', observations: [{ ...item.observations[0], excerpt: '| `diagnostics.crash_handler` | Writes under GROK_HOME. Also GROK_CRASH_HANDLER. |' }] })).toEqual([139])
    expect(read('inventory.json').items.find(item => item.key === 'environment:GROK_WORKSPACE_COMMAND').tickets).toContain(190)
  })

  it('requires fail-closed overlay acceptance without confusing config injection with grants', () => {
    const register = read('inventory.json')
    const rows = register.items.filter(item => item.key.includes('05-configuration.md:Injecting config with `GROK_CONFIG`') || ['environment:GROK_CONFIG', 'environment:GROK_CONFIG_PATH'].includes(item.key))
    expect(rows.length).toBeGreaterThan(3)
    for (const row of rows) {
      expect(row.tickets, row.key).toEqual(expect.arrayContaining([139, 141, 142, 144]))
      expect(row.acceptance, row.key).toContain('PARITY-141-overlay')
    }
    const test = register.acceptance.find(test => test.id === 'PARITY-141-overlay')
    expect(test.then).toMatch(/requirements.*MDM.*allowlist/)
    expect(test.then).toMatch(/no.*process.*network.*trust/)
    expect(test.failure).toMatch(/malformed.*file.*fallback/)
  })

  it('separates scrollback Vim navigation and configuration import from prompt editing and session import', () => {
    const register = read('inventory.json')
    for (const name of ['slash:vim-mode', 'setting:ui.vim_mode', 'guide-section:04-slash-commands.md:`/vim-mode`', 'guide-section:05-configuration.md:Vim mode']) {
      const row = register.items.find(item => item.key === name)
      expect(row.tickets).toEqual([152])
      expect(row.acceptance).toContain('PARITY-152-vim-scrollback')
    }
    expect(register.items.find(item => item.key === 'setting:ui.simple_mode').tickets).toEqual([150])
    for (const name of ['slash:import-claude', 'guide-section:04-slash-commands.md:`/import-claude`']) {
      const row = register.items.find(item => item.key === name)
      expect(row.tickets).toEqual([193])
      expect(row.acceptance).toContain('PARITY-193-claude-config')
    }
    const navigation = register.acceptance.find(test => test.id === 'PARITY-152-vim-scrollback')
    expect(navigation.then).toMatch(/scrollback.*focus.*prompt/)
    const imported = register.acceptance.find(test => test.id === 'PARITY-193-claude-config')
    expect(imported.when).toMatch(/permissions.*MCP.*hooks/)
    expect(imported.failure).toMatch(/trust.*credentials.*unchanged/)
  })

  it('discovers injected variables from enclosing environment tables and process env setters', () => {
    const text = '## Environment Variables\nRunner contract.\n\n### Always injected\nThese are reserved.\n\n| Variable | Description |\n| --- | --- |\n| `CLAUDE_PROJECT_DIR` | Current workspace root. |\n\n## Output\n| Field | Description |\n| --- | --- |\n| `NOT_ENV` | An output label. |'
    const sources = [{ path: 'crates/hooks/runner.rs', text: 'cmd.env("CLAUDE_PROJECT_DIR", root).env("CHILD_CONTEXT", context);\nconst LABEL: &str = "NOT_ENV";' }]
    const items = extractSurfaces({ commands: [], guides: [{ file: '10-hooks.md', text }] }, sources)
    const item = items.find(item => item.key === 'environment:CLAUDE_PROJECT_DIR')
    expect(item).toBeDefined()
    expect(item.observations.some(o => o.scope === 'binary-guide')).toBe(true)
    expect(item.observations.some(o => o.locator.startsWith('source:'))).toBe(true)
    expect(items.some(item => item.key === 'environment:CHILD_CONTEXT')).toBe(true)
    expect(items.some(item => item.key === 'environment:NOT_ENV')).toBe(false)
    const alias = read('discovery.json').items.find(item => item.key === 'environment:CLAUDE_PROJECT_DIR')
    expect(alias).toBeDefined()
    for (const scope of ['binary-guide', 'source-guide', 'source-environment-provisional']) expect(alias.observations.some(o => o.scope === scope), scope).toBe(true)
    for (const name of ['CLAUDE_PROJECT_DIR', 'GROK_WORKSPACE_ROOT']) {
      const row = read('inventory.json').items.find(item => item.key === `environment:${name}`)
      expect(row.tickets).toEqual([164])
      expect(row.acceptance).toContain('PARITY-164-environment')
    }
    const scenario = read('inventory.json').acceptance.find(test => test.id === 'PARITY-164-environment')
    expect(scenario.then).toMatch(/real workspace.*reserved.*spoof/)
  })

  it.each(['```', '~~~~', '````'])('keeps security prose after %s fenced comments and ignores fake headings', fence => {
    const text = `## Tool configuration\n\n${fence}toml\n[toolset.web_search]\n# A code comment, not a heading\n\nallowed_domains = ["example.test"]\n\n### Not a section\n${fence}\n\nThe configured web_search policy is authoritative; the model cannot override it.\n\n## Next section\nUnrelated prose.`
    const capture = { commands: [], guides: [{ file: '05-configuration.md', text }] }
    const items = extractSurfaces(capture, []), contexts = guideContexts({ capture, source: { guides: [] } })
    const section = items.find(item => item.key === 'guide-section:05-configuration.md:Tool configuration')
    expect(section.observations[0].excerpt).toContain('the model cannot override it')
    expect(section.observations[0].excerpt).not.toContain('Unrelated prose')
    expect(items.some(item => item.category === 'guide-section' && item.name.endsWith('Not a section'))).toBe(false)
    const prose = items.find(item => item.category === 'guide-behavior' && item.observations[0].excerpt.includes('authoritative'))
    expect(prose).toBeDefined()
    expect(mapOwners(prose, contexts)).toContain(171)
    expect(items.filter(item => item.category === 'guide-behavior').some(item => item.observations[0].excerpt.includes('Not a section'))).toBe(false)
    expect(items.some(item => item.name === '05-configuration.md:toolset.web_search.allowed_domains')).toBe(true)
    expect(contexts.get('binary-guide:05-configuration.md#L13')).toEqual(['Tool configuration'])
  })

  it('recognizes fence length and marker before emitting immediately adjacent security prose', () => {
    const text = '## Tool configuration\nBefore the example.\n````toml\n# Not a heading\n```\n~~~\n## Still code\n````\nweb_search remains authoritative.\n## Next\nOther prose.'
    const items = extractSurfaces({ commands: [], guides: [{ file: '05-configuration.md', text }] }, [])
    const prose = items.filter(item => item.category === 'guide-behavior').flatMap(item => item.observations.map(o => o.excerpt))
    expect(prose).toContain('Before the example.')
    expect(prose).toContain('web_search remains authoritative.')
    expect(prose.some(text => text.includes('Still code'))).toBe(false)
    expect(items.some(item => item.category === 'guide-section' && item.name.endsWith('Still code'))).toBe(false)
  })

  it('discovers documented process controls without requiring a prefix or underscore', () => {
    const text = '## Clone\nThe process reads\n`CLONESWITCH` / `OTHERCLONE` before its configuration.\n\n| Credential | Input |\n| --- | --- |\n| Git | a credential helper, a carrier token file, or `CARRIERTOKEN` |\n\nResolve the launcher on `PATH` (honoring `EXECEXT`) before spawning.\n\n## Output\n`STATUS_CODE`, `JSON` and `RGB` are output labels, not controls.\nThe --env flag takes `KEY=value`.'
    const items = extractSurfaces({ commands: [], guides: [{ file: '27-grok-clone.md', text }] }, [])
    for (const name of ['CLONESWITCH', 'OTHERCLONE', 'CARRIERTOKEN', 'EXECEXT']) expect(items.some(item => item.key === `environment:${name}`), name).toBe(true)
    for (const name of ['STATUS_CODE', 'JSON', 'RGB', 'KEY']) expect(items.some(item => item.key === `environment:${name}`), name).toBe(false)
  })

  it.each([
    ['GROVE_CLONE', [191]], ['GROVE_AUTH_TOKEN', [189, 191]], ['PATHEXT', [167, 200, 201]],
    ['GROK_WEB_FETCH_ALLOW_LOCAL', [171]], ['GROK_DISABLE_WEB_FETCH', [171]],
    ['GROK_EVENT', [164, 155]], ['GROK_MESSAGE', [164, 155]],
    ['GROK_SCREEN_MODE_SWITCH', [149]], ['GROK_SCREEN_MODE', [149]], ['GROK_EXIT_TIMEOUT_SECS', [155]],
    ['GROK_WORKFLOWS', [181, 180]], ['GROK_WORKFLOW_MAX_CONCURRENT_AGENTS', [182]],
    ['GROK_LOG_FILE', [192]], ['RUST_LOG', [192]], ['GROK_DOCK', [152, 151, 173, 175, 176]],
  ])('retains the functional contract of %s across canonical and guide-qualified identities', (name, owners) => {
    const discovery = read('discovery.json'), register = read('inventory.json')
    const item = discovery.items.find(item => item.key === `environment:${name}`)
    expect(item, name).toBeDefined()
    expect(register.items.find(row => row.key === item.key).tickets).toEqual(owners)
    expect(mapOwners({ ...item, name: `05-configuration.md:Environment variables:\`${name}\`` })).toEqual(owners)
    if (['GROVE_CLONE', 'GROVE_AUTH_TOKEN', 'PATHEXT'].includes(name)) {
      expect(item.observations.some(o => o.scope === 'binary-guide')).toBe(true)
      expect(item.observations.some(o => /binary-(?:pty|model)/u.test(o.scope))).toBe(false)
      expect(register.items.find(row => row.key === item.key).blocker).toMatch(/require downstream/)
    }
  })

  it('normalizes all guide-qualified environment owners and acceptance to their canonical controls', () => {
    const register = read('inventory.json'), rows = new Map(register.items.map(item => [item.key, item]))
    for (const item of read('discovery.json').items.filter(item => item.category === 'environment' && item.name.includes('.md:'))) {
      const name = item.name.match(/`([A-Z][A-Z0-9_]+)(?:=[^`]+)?`$/u)?.[1]
      expect(name, item.key).toBeDefined()
      const canonical = rows.get(`environment:${name}`), row = rows.get(item.key)
      expect(row.tickets, item.key).toEqual(canonical.tickets)
      expect(row.acceptance, item.key).toEqual(canonical.acceptance)
    }
  })

  it('retains authoritative web policy and questionnaire prose after the frozen TOML fence', () => {
    const discovery = read('discovery.json'), register = read('inventory.json')
    for (const [text, owners] of [['SSRF fail-closed', [171]], ['The model\'s per-call allowlist', [171, 139, 141]], ['`timeout_secs` must be a positive integer', [179, 139, 141]]]) {
      const item = discovery.items.find(item => item.key.startsWith('guide-behavior:05-configuration.md:Tool configuration:') && item.observations.some(o => o.excerpt.includes(text)))
      expect(item, text).toBeDefined()
      expect(register.items.find(row => row.key === item.key).tickets).toEqual(expect.arrayContaining(owners))
      expect(item.observations.some(o => o.scope === 'binary-guide')).toBe(true)
      expect(item.observations.some(o => o.scope === 'source-guide')).toBe(true)
    }
  })

  it('preserves quoted workflow subcontracts without assigning every workflow owner to every paragraph', () => {
    const capture = { commands: [], guides: [{ file: '04-slash-commands.md', text: '## `/deep-research <query>`\nOnly verified claims appear in the report.\n\nThe `agent_budget` caps calls; `parallel()` panels queue at the concurrency limit.\n\n## `/workflow`\nA same-process pause/resume uses committed results; process restart does not resume.\n\n## `/workflows`\nBrowse the saved workflow catalog.' }] }
    const contexts = guideContexts({ capture, source: { guides: [] } })
    for (const item of extractSurfaces(capture, []).filter(item => item.category === 'guide-behavior')) {
      const text = item.observations[0].excerpt
      const owners = text.includes('verified claims') ? [206] : text.includes('agent_budget') ? [206, 182] : text.includes('pause/resume') ? [181, 183] : [184]
      expect(mapOwners(item, contexts), item.key).toEqual(owners)
    }
    const discovery = read('discovery.json'), register = read('inventory.json')
    for (const key of ['slash:workflow', 'tool:workflow']) expect(register.items.find(row => row.key === key).tickets).toEqual([181, 182, 183, 184])
    expect(register.items.find(row => row.key === 'guide-section:05-configuration.md:Goal mode and background workflows').tickets).toEqual([180, 181, 183, 184])
    for (const [fragment, owners] of [['absolute cumulative `agent_budget`', [206, 182]], ['A same-process pause/resume', [181, 183, 184]], ['A budget-limited run is different', [181, 182, 183]], ['browse-only catalog', [184, 183]]]) {
      const rows = discovery.items.filter(item => item.key.startsWith('guide-behavior:04-slash-commands.md:') && item.observations.some(o => o.excerpt.includes(fragment)))
      expect(rows.length, fragment).toBeGreaterThan(0)
      for (const item of rows) expect(register.items.find(row => row.key === item.key).tickets, item.key).toEqual(expect.arrayContaining(owners))
    }
  })

  it('does not confuse env assignments with paths or configuration file table identities', () => {
    const capture = { commands: [], guides: [{ file: '10-hooks.md', text: '## Hooks in Config Files\n| File | Tier |\n| --- | --- |\n| `managed_config.toml` (`$GROK_HOME`, `/etc/grok`) | Managed |\n\n## Environment Variables\n| Variable | Description |\n| --- | --- |\n| `UNPREFIXED` | Runner input |\n| `GROK_MEMORY=0` | Disable memory |' }] }
    const items = extractSurfaces(capture, [])
    expect(items.some(item => item.category === 'environment' && item.name.includes('managed_config.toml'))).toBe(false)
    expect(items.some(item => item.category === 'guide-item' && item.name.includes('managed_config.toml'))).toBe(true)
    expect(items.some(item => item.key === 'environment:UNPREFIXED')).toBe(true)
    const assigned = items.find(item => item.category === 'environment' && item.name.endsWith('`GROK_MEMORY=0`'))
    expect(mapOwners(assigned)).toEqual([185])
  })

  it('keeps source-only neighbors provisional and distinguishes campaign override and screen exec semantics', () => {
    const discovery = read('discovery.json'), register = read('inventory.json')
    for (const name of ['GROK_DISABLE_WEB_FETCH', 'GROK_SCREEN_MODE', 'GROK_WORKFLOW_MAX_CONCURRENT_AGENTS', 'GROK_CAMPAIGNS_OVERRIDE']) {
      const item = discovery.items.find(row => row.key === `environment:${name}`)
      expect(item.observations.every(o => !o.scope.startsWith('binary'))).toBe(true)
      const row = register.items.find(row => row.key === item.key)
      expect(row.blocker).toMatch(/Source export is 1.0.35/)
      expect(row.status).toBe('pending-parity')
    }
    expect(register.items.find(row => row.key === 'environment:GROK_CAMPAIGNS_OVERRIDE').acceptance).toContain('PARITY-141-campaign-override')
    expect(register.items.find(row => row.key === 'environment:GROK_SCREEN_MODE_SWITCH').acceptance).toContain('PARITY-149-exec')
    expect(register.acceptance.find(row => row.id === 'PARITY-141-campaign-override').then).toMatch(/over the kill switch.*requirements precedence/)
    expect(register.acceptance.find(row => row.id === 'PARITY-149-exec').then).toMatch(/same session.*without resubmitting/)
  })

  it('maps actual memory-v2 capture, Dream and retention fields without reclassifying manual memory', () => {
    const rows = read('inventory.json').items
    for (const field of ['capture_enabled', 'capture_status_enabled', 'automatic_dream_enabled', 'manual_dream_enabled', 'archived_retention_days', 'job_retention_days']) {
      expect(rows.find(row => row.key === `setting:memory_v2.${field}`).tickets).toEqual([186])
    }
    for (const field of ['enabled', 'rollout', 'file_writes_enabled']) expect(rows.find(row => row.key === `setting:memory_v2.${field}`).tickets).toEqual([185, 186])
    for (const row of rows.filter(row => /^(?:setting|documented-setting):(?:[^:]+:)?memory\.dream\./u.test(row.key))) expect(row.tickets, row.key).toContain(186)
    for (const key of ['guide-section:13-memory.md:Memory Notifications', 'guide-section:26-config-reference.md:`memory`']) expect(rows.find(row => row.key === key).tickets).toEqual([185, 186])
    expect(rows.find(row => row.key === 'guide-behavior:13-memory.md:Memory Notifications:1').tickets).toEqual([185])
    expect(rows.find(row => row.key === 'setting:memory.enabled').tickets).toEqual([185])
    expect(rows.find(row => row.key === 'slash:memory').tickets).toEqual([185])
  })

  it('maps campaign patches to effective precedence and locked requirements rather than rendering', () => {
    const rows = read('inventory.json').items
    for (const key of ['setting:campaigns', 'setting:features.campaigns', 'environment:GROK_CAMPAIGNS', 'environment:GROK_CAMPAIGNS_OVERRIDE', 'guide-section:26-config-reference.md:`campaigns`']) {
      expect(rows.find(row => row.key === key).tickets, key).toEqual([139, 141])
    }
    expect(mapOwners({ category: 'feature', name: 'campaigns', key: 'feature:campaigns', observations: [] })).toEqual([139, 141])
    expect(rows.find(row => row.key === 'setting:announcements').tickets).toEqual([154])
    const scenarios = read('inventory.json').acceptance
    expect(scenarios.find(row => row.id === 'PARITY-141-campaigns').then).toMatch(/requirements.*GROK_CAMPAIGNS=0/)
    expect(scenarios.find(row => row.id === 'PARITY-171-policy').then).toMatch(/authoritative.*model.*session start/)
    expect(scenarios.find(row => row.id === 'PARITY-186').then).toMatch(/capture_enabled.*capture_status_enabled/)
  })

  it.each(['> ', '> > '])('extracts TOML inside %s quote containers without turning code into prose', quote => {
    const text = `## Limits\n${quote}A quoted introduction.\n${quote}\n${quote}\`\`\`toml\n${quote}[mcp]\n${quote}# Not a heading\n${quote}max_output_bytes = 40000\n${quote}\`\`\`\n${quote}Security prose after the fence.\n\n## Next\nOrdinary prose.`
    const capture = { commands: [], guides: [{ file: '07-mcp-servers.md', text }] }
    const items = extractSurfaces(capture, [])
    const setting = items.find(item => item.key === 'documented-setting:07-mcp-servers.md:mcp.max_output_bytes')
    expect(setting?.observations[0].excerpt).toBe(`${quote}max_output_bytes = 40000`)
    expect(items.filter(item => item.category === 'guide-behavior').some(item => item.observations.some(o => o.excerpt.includes('max_output_bytes')))).toBe(false)
    expect(items.filter(item => item.category === 'guide-behavior').some(item => item.observations.some(o => o.excerpt.includes('Security prose')))).toBe(true)
    expect(guideContexts({ capture, source: { guides: [] } }).get('binary-guide:07-mcp-servers.md#L9')).toEqual(['Limits'])
    expect(guideLines('> ```toml\n> [mcp]\n## Outside')[2].heading?.[2]).toBe('Outside')
    expect(guideLines('```text\n> ```\n# Still code\n```')[2].code).toBe(true)
  })

  it('extracts the actual frozen and pinned blockquoted MCP example with exact locators', () => {
    const evidence = loadEvidence(), capture = { commands: [], guides: evidence.capture.guides.filter(g => g.file === '07-mcp-servers.md') }
    const sources = evidence.source.guides.filter(g => g.path.endsWith('/07-mcp-servers.md'))
    for (const items of [extractSurfaces(capture, sources), read('discovery.json').items]) {
      const item = items.find(item => item.key === 'documented-setting:07-mcp-servers.md:mcp.max_output_bytes')
      expect(item).toBeDefined()
      for (const scope of ['binary-guide', 'source-guide']) expect(item.observations).toContainEqual({ locator: `${scope}:07-mcp-servers.md#L57`, scope, excerpt: '> max_output_bytes = 40000' })
      expect(items.filter(item => item.category === 'guide-behavior' && item.name.startsWith('07-mcp-servers.md:')).some(item => item.observations.some(o => o.excerpt.includes('> ```toml')))).toBe(false)
    }
    const row = read('inventory.json').items.find(item => item.key === 'documented-setting:07-mcp-servers.md:mcp.max_output_bytes')
    expect(row.tickets).toEqual([167])
    expect(row.acceptance).toContain('PARITY-167-limits')
  })

  it.each(['scroll_speed', 'scroll_mode', 'scroll_lines', 'invert_scroll', 'mouse_reporting_toggle'])('maps %s settings and aliases to input effects consistently', field => {
    const register = read('inventory.json')
    for (const key of [`setting:ui.${field}`, `environment:GROK_${field.toUpperCase()}`]) {
      const row = register.items.find(item => item.key === key)
      expect(row.tickets, key).toEqual([152])
      expect(row.acceptance).toEqual([field === 'mouse_reporting_toggle' ? 'PARITY-152-mouse-capture' : 'PARITY-152-scroll-input'])
    }
    for (const row of register.items.filter(item => item.key === `documented-setting:05-configuration.md:ui.${field}`)) {
      expect(row.tickets).toEqual([152])
      expect(row.acceptance).toContain('PARITY-152-scroll-input')
    }
    expect(register.items.find(item => item.key === 'setting:ui.cursor_blink').tickets).toEqual([154])
  })

  it('assigns ghost-text editing and suggestion model parameters to their distinct functional contracts', () => {
    const register = read('inventory.json')
    for (const key of ['setting:ui.prompt_suggestions', 'environment:GROK_PROMPT_SUGGESTIONS']) {
      const row = register.items.find(item => item.key === key)
      expect(row.tickets).toEqual([150])
      expect(row.acceptance).toContain('PARITY-150-suggestions')
    }
    for (const key of ['environment:GROK_PROMPT_SUGGESTIONS_MODEL', 'setting:models.prompt_suggestion', 'setting:prompt_suggestions.max_output_tokens', 'setting:prompt_suggestions.temperature', 'setting:prompt_suggestions.reasoning_effort']) {
      const row = register.items.find(item => item.key === key)
      expect(row.tickets).toEqual([140])
      expect(row.acceptance).toContain('PARITY-140-suggestions')
    }
    expect(register.items.find(item => item.key === 'environment:GROK_PROMPT_SUGGESTIONS_MODEL').blocker).toMatch(/Source export is 1.0.35/)
  })

  it('distinguishes metadata-only session saves and memory diagnostics from manual and model-backed memory', () => {
    const register = read('inventory.json')
    for (const key of ['documented-setting:05-configuration.md:memory.session.save_on_end', 'guide-item:13-memory.md:Configuration Reference > Core Settings (`[memory]`):`session.save_on_end`', 'guide-section:13-memory.md:Automatic Saves']) {
      const row = register.items.find(item => item.key === key)
      expect(row.tickets).toContain(186)
      expect(row.acceptance).toContain('PARITY-186-session-metadata')
    }
    const log = register.items.find(item => item.key === 'environment:GROK_MEMORY_LOG')
    expect(log.tickets).toEqual([186, 192])
    expect(log.acceptance).toContain('PARITY-186-memory-log')
    expect(log.blocker).toMatch(/Source export is 1.0.35/)
    expect(register.items.find(item => item.key === 'slash:remember').tickets).toEqual([185])
    expect(register.items.find(item => item.key === 'setting:memory_v2.capture_enabled').acceptance).not.toContain('PARITY-186-session-metadata')
  })

  it('assigns every memory-guide compaction pruning row to retained-context effects', () => {
    const rows = read('inventory.json').items.filter(item => item.key.includes('13-memory.md:') && item.key.includes('Pruning Settings (`[compaction.pruning]`)'))
    expect(rows.filter(row => row.key.startsWith('guide-item:'))).toHaveLength(6)
    expect(rows.some(row => row.key.startsWith('guide-section:'))).toBe(true)
    expect(rows.some(row => row.key.startsWith('guide-behavior:'))).toBe(true)
    for (const row of rows) {
      expect(row.tickets, row.key).toEqual([161])
      expect(row.acceptance, row.key).toEqual(['PARITY-161-pruning'])
    }
  })

  it.each(['GROK_DEBUG_LOG', 'GROK_LOG_SAMPLING', 'GROK_INSTRUMENTATION', 'GROK_INSTRUMENTATION_LOG', 'GROK_LEADER_LOG', 'GROK_SCROLL_LOG'])('retains provisional diagnostic effects for %s', name => {
    const row = read('inventory.json').items.find(item => item.key === `environment:${name}`)
    expect(row.tickets).toEqual([192])
    expect(row.acceptance).toEqual(['PARITY-192-diagnostic-controls'])
    expect(row.blocker).toMatch(/Source export is 1.0.35/)
  })

  it('keeps inherited shell startup variables under child-environment and status-line acceptance', () => {
    const register = read('inventory.json')
    for (const name of ['BASH_ENV', 'ENV']) {
      const row = register.items.find(item => item.key === `environment:${name}`)
      expect(row.tickets).toEqual([144, 154])
      expect(row.acceptance).toContain('PARITY-144-status-line-env')
    }
    const rows = read('discovery.json').items.filter(item => item.name.startsWith('25-status-line.md:') && item.observations.some(o => o.excerpt.includes('BASH_ENV')))
    for (const item of rows) expect(register.items.find(row => row.key === item.key).acceptance).toContain('PARITY-144-status-line-env')
  })

  it('routes web-fetch enablement, proxy and domain controls to fetch effects instead of search-only policy', () => {
    const register = read('inventory.json')
    for (const key of ['environment:GROK_WEB_FETCH', 'environment:GROK_DISABLE_WEB_FETCH', 'environment:GROK_WEB_FETCH_PROXY', 'setting:toolset.web_fetch.proxy_endpoint', 'setting:toolset.web_fetch.allowed_domains', 'documented-setting:05-configuration.md:toolset.web_fetch.proxy_endpoint', 'documented-setting:05-configuration.md:toolset.web_fetch.allowed_domains', 'feature:web_fetch', 'setting:features.web_fetch', 'tool:web_fetch']) {
      const row = register.items.find(item => item.key === key)
      expect(row, key).toBeDefined()
      expect(row.acceptance, key).toContain('PARITY-171-fetch-controls')
      expect(row.acceptance, key).not.toContain('PARITY-171-policy')
    }
    for (const key of ['environment:GROK_WEB_FETCH_ALLOW_LOCAL', 'setting:toolset.web_search.allowed_domains', 'setting:toolset.web_search.excluded_domains']) expect(register.items.find(item => item.key === key).acceptance).toContain('PARITY-171-policy')
    expect(register.items.find(item => item.key === 'guide-section:05-configuration.md:Tool configuration').acceptance).toEqual(expect.arrayContaining(['PARITY-171-fetch-controls', 'PARITY-171-policy']))
    expect(register.acceptance.find(item => item.id === 'PARITY-171-fetch-controls').then).toMatch(/empty fetch allowlist blocks all.*unlike an empty search list/)
  })

  it('specifies concrete effects for the independently reviewed neighboring controls', () => {
    const scenarios = new Map(read('inventory.json').acceptance.map(item => [item.id, item]))
    expect(scenarios.get('PARITY-152-scroll-input').then).toMatch(/classification.*direction.*distance.*reading position/)
    expect(scenarios.get('PARITY-152-mouse-capture').then).toMatch(/mouse capture.*native.*selection/)
    expect(scenarios.get('PARITY-150-suggestions').then).toMatch(/Tab.*Right.*prefix.*Esc.*stale/)
    expect(scenarios.get('PARITY-140-suggestions').then).toMatch(/provider.*model.*tokens.*temperature.*effort/)
    expect(scenarios.get('PARITY-186-session-metadata').then).toMatch(/metadata.*no.*model call/)
    expect(scenarios.get('PARITY-186-memory-log').then).toMatch(/disabled.*default.*redirect/)
    expect(scenarios.get('PARITY-161-pruning').then).toMatch(/provider context.*protected.*head.*tail.*placeholder/)
    expect(scenarios.get('PARITY-144-status-line-env').then).toMatch(/canary.*unchanged/)
    expect(scenarios.get('PARITY-192-diagnostic-controls').then).toMatch(/debug.*sampling.*instrumentation.*leader.*scroll/)
    expect(scenarios.get('PARITY-171-fetch-controls').then).toMatch(/disabled.*proxy.*allowlist.*redirect/)
  })

  it.each([
    ['DISPLAY', [155, 199, 201], 'PARITY-155-clipboard-routing'],
    ['WAYLAND_DISPLAY', [155, 199, 201], 'PARITY-155-clipboard-routing'],
    ['SSH_CONNECTION', [155, 201], 'PARITY-155-clipboard-routing'],
    ['SSH_TTY', [155, 201], 'PARITY-155-clipboard-routing'],
    ['SSH_CLIENT', [155, 201], 'PARITY-155-clipboard-routing'],
    ['EDITOR', [150], 'PARITY-150-external-editor'], ['VISUAL', [150], 'PARITY-150-external-editor'],
    ['GROK_VERSION', [200], 'PARITY-200-version-selection'],
    ['GROK_SCROLL_DEBUG', [154], 'PARITY-154-scroll-hud'],
    ['GROK_MIN_DRAW_MS', [154], 'PARITY-154-cadence'], ['GROK_SCROLL_CADENCE_MS', [154], 'PARITY-154-cadence'],
    ['GROK_DISPLAY_REFRESH_PROBE_ENABLED', [154], 'PARITY-154-cadence'],
    ['GROK_SUGGESTIONS', [150], 'PARITY-150-shell-suggestions'], ['GROK_SUGGESTIONS_AI', [150], 'PARITY-150-shell-suggestions'],
    ['GROK_SUGGESTIONS_AI_MODEL', [140], 'PARITY-140-shell-suggestions'],
    ['GROK_SESSION_SUMMARY_MODEL', [140], 'PARITY-140-background-models'], ['GROK_IMAGE_DESCRIPTION_MODEL', [140], 'PARITY-140-background-models'],
    ['GROK_MAX_CONCURRENT_SUBAGENTS', [172], 'PARITY-172-admission'],
    ['GROK_LOGIN_ENV', [170], 'PARITY-170-login-environment'], ['GROK_LOGIN_DEVICE_FLOW', [189], 'PARITY-189-device-flow'],
    ['GROK_GOAL', [180], 'PARITY-180-controls'], ['GROK_GOAL_CLASSIFIER', [180], 'PARITY-180-controls'],
    ['GROK_GOAL_PLANNER', [180], 'PARITY-180-controls'], ['GROK_GOAL_SUMMARY', [180], 'PARITY-180-controls'],
    ['GROK_AUTO_COMPACT_THRESHOLD_PERCENT', [161], 'PARITY-161-trigger-budget'], ['GROK_COMPACTION_WALL_CLOCK_SECS', [161], 'PARITY-161-trigger-budget'],
    ['GROK_HOOKS_LOG', [192], 'PARITY-192-hooks-log'],
  ])('preserves the explicit functional contract and availability of %s', (name, owners, scenario) => {
    const register = read('inventory.json'), item = read('discovery.json').items.find(item => item.key === `environment:${name}`)
    const row = register.items.find(row => row.key === item.key)
    expect(row.tickets, item.key).toEqual(owners)
    expect(row.acceptance).toContain(scenario)
    expect(row.acceptance).not.toContain('PARITY-139')
    const contexts = guideContexts(loadEvidence())
    expect(mapOwners({ ...item, name: `05-configuration.md:Environment variables:\`${name}\`` }, contexts)).toEqual(owners)
    if (!['DISPLAY', 'GROK_VERSION'].includes(name)) {
      expect(item.observations.every(o => !o.scope.startsWith('binary'))).toBe(true)
      expect(row.blocker).toMatch(/Source export is 1.0.35/)
    }
  })

  it('uses matching effect scenarios for documented counterparts without conflating neighboring controls', () => {
    const rows = new Map(read('inventory.json').items.map(row => [row.key, row]))
    for (const [key, scenario] of [
      ['models.session_summary', 'PARITY-140-background-models'], ['models.image_description', 'PARITY-140-background-models'],
      ['subagents.max_concurrent', 'PARITY-172-admission'], ['ui.display_refresh.auto_cadence_enabled', 'PARITY-154-cadence'],
      ['goal.enabled', 'PARITY-180-controls'], ['toolset.bash.login_shell_capture', 'PARITY-170-login-environment'],
      ['session.auto_compact_threshold_percent', 'PARITY-161-trigger-budget'],
    ]) expect(rows.get(`setting:${key}`).acceptance, key).toContain(scenario)
    expect(rows.get('environment:GROK_SUGGESTIONS').acceptance).not.toContain('PARITY-150-suggestions')
    expect(rows.get('environment:GROK_PROMPT_SUGGESTIONS').acceptance).toContain('PARITY-150-suggestions')
    expect(rows.get('environment:GROK_HOOKS_LOG').tickets).not.toContain(164)
    expect(rows.get('environment:GROK_HOOK_EVENT').tickets).toEqual([164])
    expect(rows.get('environment:GROK_GOAL').tickets).not.toContain(181)
    expect(rows.get('environment:GROK_WORKFLOWS').tickets).toEqual([181, 180])
  })

  it('maps memory capture and privacy by quoted paragraph, retaining source/binary conflicts', () => {
    const register = read('inventory.json'), discovery = read('discovery.json'), contexts = guideContexts(loadEvidence())
    for (const [suffix, owners] of [
      ['How memory is organized:1', [185]], ['How memory is organized:2', [185, 186]],
      ['How memory is organized:3', [185]], ['How memory is organized:4', [185, 186, 192]],
      ['How memory is organized:5', [185, 192]], ['How memory is organized:6', [185]],
      ['Direct Editing:1', [185, 186]], ['Direct Editing:2', [185]],
    ]) {
      const key = `guide-behavior:13-memory.md:${suffix}`
      expect(register.items.find(row => row.key === key).tickets, key).toEqual(owners)
    }
    const section = register.items.find(row => row.key === 'guide-section:13-memory.md:How memory is organized')
    expect(section.tickets).toEqual([185, 186, 192])
    expect(section.acceptance).toEqual(expect.arrayContaining(['PARITY-186', 'PARITY-186-diagnostics', 'PARITY-192-memory-privacy']))
    const mixed = discovery.items.find(item => item.key === 'guide-behavior:13-memory.md:How memory is organized:4')
    expect(mapOwners({ ...mixed, observations: mixed.observations.filter(o => o.scope === 'binary-guide') }, contexts)).toEqual([185, 186])
    expect(mapOwners({ ...mixed, observations: mixed.observations.filter(o => o.scope === 'source-guide') }, contexts)).toEqual([185, 192])
    const capture = { commands: [], guides: [{ file: '13-memory.md', text: '## How memory is organized\nEdit or search a manual note.\n\nA completed turn produces observations for `/dream`.\n\nMemory product telemetry contains only counts and durations.' }] }
    const ctx = guideContexts({ capture, source: { guides: [] } })
    for (const item of extractSurfaces(capture, []).filter(item => item.category === 'guide-behavior')) {
      const text = item.observations[0].excerpt
      expect(mapOwners(item, ctx)).toEqual(text.includes('completed turn') ? [185, 186] : text.includes('telemetry') ? [185, 192] : [185])
    }
  })

  it('retains sandbox confinement while adding the distinct Bash approval decision contract', () => {
    const register = read('inventory.json')
    for (const key of ['setting:sandbox.auto_allow_bash', 'environment:GROK_SANDBOX_AUTO_ALLOW_BASH']) {
      const row = register.items.find(item => item.key === key)
      expect(row.tickets).toEqual([143, 142])
      expect(row.acceptance).toEqual(['PARITY-143-confinement', 'PARITY-142-sandbox-auto-approval'])
    }
    expect(register.items.find(item => item.key === 'setting:sandbox.profile').tickets).toEqual([143])
    const item = read('discovery.json').items.find(item => item.key === 'environment:GROK_SANDBOX_AUTO_ALLOW_BASH')
    expect(mapOwners({ ...item, name: '05-configuration.md:Environment variables:`GROK_SANDBOX_AUTO_ALLOW_BASH`' }, guideContexts(loadEvidence()))).toEqual([143, 142])
  })

  it('requires actual effects for the newly reviewed aliases, diagnostics and approval gates', () => {
    const tests = new Map(read('inventory.json').acceptance.map(test => [test.id, test]))
    for (const [id, pattern] of [
      ['PARITY-155-clipboard-routing', /PRIMARY.*CLIPBOARD.*SSH/], ['PARITY-150-external-editor', /VISUAL.*EDITOR.*vi.*draft/],
      ['PARITY-200-version-selection', /requested version.*native Windows.*PATH/], ['PARITY-154-scroll-hud', /HUD.*persist/],
      ['PARITY-154-cadence', /paint.*scroll.*1.*100/], ['PARITY-150-shell-suggestions', /Tab.*completion.*AI/],
      ['PARITY-140-shell-suggestions', /x.ai\/suggest.*model.*provider/], ['PARITY-140-background-models', /summary.*image.*provider/],
      ['PARITY-172-admission', /actual.*child.*bound/], ['PARITY-170-login-environment', /login.*environment.*child/],
      ['PARITY-189-device-flow', /CLI.*env.*config.*loopback/], ['PARITY-180-controls', /classifier.*planner.*summary/],
      ['PARITY-161-trigger-budget', /threshold.*wall-clock.*zero/], ['PARITY-192-hooks-log', /append.*target.*authorization/],
      ['PARITY-186-diagnostics', /cursor.*queue.*lease.*copy/], ['PARITY-192-memory-privacy', /enums.*booleans.*counts.*durations/],
      ['PARITY-142-sandbox-auto-approval', /prompt.*deny.*ask.*hook/],
    ]) expect(tests.get(id)?.then, id).toMatch(pattern)
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
