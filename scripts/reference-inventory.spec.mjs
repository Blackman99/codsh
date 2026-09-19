import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkInventory, extractSurfaces, loadEvidence, sourceCommands } from './reference-inventory.mjs'
import { buildRegister, guideContexts, mapOwners } from './reference-mapping.mjs'

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
