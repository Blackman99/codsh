import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { guideContexts, mapAcceptance, mapOwners } from './reference-mapping.mjs'
import { checkConfigAudit, checkConfigAuditSources, checkConfigConsistency, configAudit, configIdentity } from './reference-config-audit.mjs'
import { extractSurfaces, loadEvidence } from './reference-inventory.mjs'

const read = name => JSON.parse(readFileSync(new URL(`../docs/rewrite/reference/${name}`, import.meta.url), 'utf8'))
const fixture = (category, name) => ({ key: `${category}:${name}`, category, name, observations: [] })
const cases = [
  ['npm_config_user_agent', [198], 'PARITY-198-installer'],
  ['container', [155], 'PARITY-155-container-clipboard'],
  ['GROK_SESSION_PICKER_GROUPED', [159], 'PARITY-159-grouping', 'cli.session_picker_grouped'],
  ['GROK_SESSION_REGISTRY', [138], 'PARITY-138-registry', 'cli.session_registry'],
  ['GROK_RELAY_SYNC_ENABLED', [148], 'PARITY-148-relay', 'relay.enabled'],
  ['GROK_LEADER_SOCKET', [148], 'PARITY-148-socket'],
  ['GROK_STORAGE_MODE', [138, 192], 'PARITY-138-storage'],
  ['GROK_INSTALLER', [198], 'PARITY-198-installer', 'cli.installer'],
  ['GROK_NPM_REGISTRY', [198], 'PARITY-198-installer', 'cli.npm_registry'],
  ['GROK_GOAL_VERIFIER_N', [180], 'PARITY-180-verification', 'goal.verifier_count'],
  ['GROK_GOAL_CLASSIFIER_MAX', [180], 'PARITY-180-verification', 'goal.classifier_max_runs'],
  ['GROK_GOAL_STRATEGIST_EVERY', [180], 'PARITY-180-verification', 'goal.strategist_every'],
  ['GROK_GOAL_REVERIFY_AFTER', [180], 'PARITY-180-verification', 'goal.reverify_after'],
  ['GROK_GOAL_USE_CURRENT_MODEL_ONLY', [180, 140], 'PARITY-140-goal-routing', 'goal.use_current_model_only'],
  ['GROK_MANAGED_CONFIG_FAIL_CLOSED', [141], 'PARITY-141-fail-closed', 'fail_closed'],
  ['GROK_ENVRC_TIMEOUT_SECS', [144], 'PARITY-144-envrc'],
  ['GROK_CLIPBOARD_NO_NATIVE_READ', [155, 157], 'PARITY-157-native-read'],
  ['GROK_OSC52_SINK', [155], 'PARITY-155-osc52-sink'],
  ['LC_GROK_OSC52_SINK', [155], 'PARITY-155-osc52-sink'],
  ['GROK_IDLE_NOTIFICATION_DELAY_MS', [164], 'PARITY-164-idle'],
  ['GROK_TERMINAL_NOTIFICATION_INTERVAL_MS', [170, 147], 'PARITY-170-notifications'],
  ['GROK_SESSION_EXIT_DRAIN_SECS', [192, 155], 'PARITY-192-exit-drain'],
  ['GROK_ANNOUNCEMENTS_OVERRIDE', [154], 'PARITY-154-announcement-controls'],
  ['GROK_ANNOUNCEMENTS_REFRESH_INTERVAL_SECS', [154], 'PARITY-154-announcement-controls'],
]

describe('independent fallback ownership contracts', () => {
  it('extracts case-sensitive literal environment names across supported source forms', () => {
    const source = { path: 'crates/consumer.rs', text: [
      'std::env::var_os("npm_config_user_agent");', 'std::env::var_os("container");',
      'env::var("Mixed_Case");', 'var_os("_private");', 'var("x");',
      'const ENV_PATH: &str = "lower_constant";', 'child.env("lower_child", "value");',
      'env.get("lower_map");', 'env_nonempty(env, "lower_helper");',
      'for key in ["lower_loop", "Upper_Loop"] { env.get(key); }',
      'std::env::var("CONTAINER");',
      'const LABEL: &str = "unrelated_text";', 'other("lower_noise");',
      'std::env::var("not=a_name");', 'std::env::var("");',
    ].join('\n') }
    const items = extractSurfaces({ commands: [], guides: [] }, [source])
    expect(items.map(item => item.key).sort()).toEqual([
      'CONTAINER', 'Mixed_Case', 'Upper_Loop', '_private', 'container', 'lower_child',
      'lower_constant', 'lower_helper', 'lower_loop', 'lower_map', 'npm_config_user_agent', 'x',
    ].map(name => `environment:${name}`).sort())
    for (const item of items) expect(item.observations[0].scope).toBe('source-environment-provisional')
  })

  it('extracts non-shell literal names without stripping punctuation or whitespace', () => {
    const source = { path: 'crates/literal_env.rs', text: [
      'std::env::var("PROGRAMFILES(X86)");', 'std::env::var_os("CARGO_BIN_EXE_xai-grok-pager");',
      'std::env::var("PROGRAMFILES");', 'const ENV_FLAG: &str = "constant.with-dot";',
      'child.env("child-name", "value");', 'env.get("map(key)");',
      'env_nonempty(env, "helper.name");', 'for key in ["loop:name", "two words"] { env.get(key); }',
      'var("9prefix");', 'var(" spaced ");', 'other("not-a-control");',
      'var("");', 'var("invalid=name");', 'var("invalid\\0name");',
    ].join('\n') }
    expect(extractSurfaces({ commands: [], guides: [] }, [source]).map(item => item.name).sort()).toEqual([
      'PROGRAMFILES(X86)', 'CARGO_BIN_EXE_xai-grok-pager', 'PROGRAMFILES', 'constant.with-dot',
      'child-name', 'map(key)', 'helper.name', 'loop:name', 'two words', '9prefix', ' spaced ',
    ].sort())
  })

  it.each(['PROGRAMFILES(X86)', 'CARGO_BIN_EXE_xai-grok-pager', 'two words', ' spaced ', 'loop:name'])('preserves the entire environment identity %s', name => {
    for (const representation of [name, `\`${name}\``, `05-configuration.md:Environment:\`${name}\``, `05-configuration.md:Environment:\`${name}=value\``]) {
      expect(configIdentity(fixture('environment', representation))).toBe(`environment:${name}`)
    }
  })

  it.each([
    ['PROGRAMFILES(X86)', 170, 'PARITY-170-shell-controls'],
    ['CARGO_BIN_EXE_xai-grok-pager', 133, 'DISCOVERY-133-test-benchmark'],
  ])('retains punctuation-bearing source control %s in its actual scope', (name, owner, scenario) => {
    for (const representation of [name, `05-configuration.md:Environment:\`${name}=value\``]) {
      const item = fixture('environment', representation)
      expect(mapOwners(item)).toEqual([owner])
      expect(mapAcceptance(item, [owner])).toEqual([scenario])
    }
    const discovery = read('discovery.json').items.find(item => item.key === `environment:${name}`)
    expect(discovery).toBeDefined()
    expect(discovery.observations.every(o => o.scope === 'source-environment-provisional')).toBe(true)
    const row = read('inventory.json').items.find(row => row.key === discovery.key)
    expect(row.tickets).toEqual([owner])
    expect(row.blocker).toContain('not a proven 1.0.34 match')
    if (owner === 133) expect(row.blocker).toContain('Discovery-only')
  })

  it('records separate planned goal-role routes under conflicting pins', () => {
    const scenario = read('inventory.json').acceptance.find(item => item.id === 'PARITY-140-goal-routing')
    const routes = scenario.routingCases.map(row => [row.role, row.currentModelOnly, row.rolePair, row.subagentPin, row.definitionModel, row.expected])
    expect(routes).toEqual([
      ['planner', false, 'configured', true, true, 'parent'],
      ['planner', true, 'configured', true, true, 'parent'],
      ['strategist', false, 'configured', true, true, 'configured-role'],
      ['strategist', false, 'remote', true, true, 'remote-role'],
      ['strategist', true, 'configured', true, true, 'subagent-pin'],
      ['skeptic', false, 'configured', true, true, 'configured-role'],
      ['skeptic', true, 'configured', true, true, 'subagent-pin'],
      ['skeptic', true, 'configured', false, true, 'agent-definition'],
      ['strategist', true, 'configured', false, false, 'parent'],
      ['summary', false, null, true, true, 'subagent-pin'],
      ['summary', true, null, false, true, 'agent-definition'],
      ['summary', true, null, false, false, 'parent'],
    ])
    expect(scenario.status).toBe('planned')
    expect(scenario.then).not.toContain('Every role request uses current model')
    expect(scenario.failure).toMatch(/one retry without the role override.*cancellation must not retry/)
  })

  it.each([
    ['_RJEM_MALLOC_CONF', 'DISCOVERY-133-injected-git-render'],
    ['_GROK_CLAUDE_MARKER_OVERRIDE', 'DISCOVERY-133-test-benchmark'],
    ['__GROK_INSIDE_BWRAP', 'DISCOVERY-133-sandbox-handoff'],
    ['__GROK_BWRAP_RUNTIME_SOCKET_DENY', 'DISCOVERY-133-sandbox-handoff'],
  ])('retains newly extracted internal %s without claiming config parity', (name, scenario) => {
    const item = fixture('environment', name)
    expect(mapOwners(item)).toEqual([133])
    expect(mapAcceptance(item, [133])).toEqual([scenario])
    expect(mapOwners(fixture('environment', `05-configuration.md:Environment:\`${name}=1\``))).toEqual([133])
    const row = read('inventory.json').items.find(row => row.key === item.key)
    expect(row.acceptance).toEqual([scenario])
    expect(row.blocker).toContain('Discovery-only')
  })

  it('does not uppercase lowercase environment controls into unrelated identities', () => {
    expect(mapOwners(fixture('environment', 'CONTAINER'))).toEqual([139])
    expect(mapOwners(fixture('environment', 'NPM_CONFIG_USER_AGENT'))).toEqual([139])
  })

  it('retains actual lowercase controls with functional ownership and source-only blockers', () => {
    const discovery = read('discovery.json'), inventory = read('inventory.json')
    for (const [name, owner] of [['npm_config_user_agent', 198], ['container', 155]]) {
      const item = discovery.items.find(item => item.key === `environment:${name}`)
      expect(item, name).toBeDefined()
      expect(item.observations.every(observation => observation.scope === 'source-environment-provisional')).toBe(true)
      const row = inventory.items.find(row => row.key === item.key)
      expect(row.tickets).toEqual([owner])
      expect(row.blocker).toContain('not a proven 1.0.34 match')
    }
  })

  it.each(cases)('%s retains functional effects across representations', (name, owners, scenario, field) => {
    const items = [fixture('environment', name), fixture('environment', `05-configuration.md:Environment variables:\`${name}=1\``)]
    if (field) items.push(fixture('setting', field), fixture('documented-setting', `05-configuration.md:${field}`))
    for (const item of items) {
      expect(mapOwners(item), item.key).toEqual(owners)
      expect(mapAcceptance(item, owners), item.key).toContain(scenario)
      expect(mapAcceptance(item, owners), item.key).not.toContain('PARITY-139')
    }
  })

  it.each([
    ['hints.fork_worktree_mode', [174, 160], 'PARITY-174-session-preference'],
    ['hints.new_session_worktree_mode', [174, 138], 'PARITY-174-session-preference'],
    ['paths.extra_rule_dirs', [163], 'PARITY-163-extra-rules'],
    ['paths.extra_skill_dirs', [163, 193], 'PARITY-163-extra-skills'],
    ['features.remote_fetch', [140, 141], 'PARITY-140-remote-fetch'],
    ['doom_loop_recovery.enabled', [135], 'PARITY-135-recovery'],
    ['cli.show_tips', [154], 'PARITY-154-tips'],
    ['path_not_found_hints', [169], 'PARITY-169-path-errors'],
    ['hints.memory_modal_fullscreen', [185, 154], 'PARITY-185-modal'],
    ['features.non_git_warning', [139], 'PARITY-139-non-git-warning'],
  ])('%s cannot disappear behind a guide default', (name, owners, scenario) => {
    for (const category of ['setting', 'documented-setting']) {
      const item = fixture(category, category === 'setting' ? name : `05-configuration.md:${name}`)
      expect(mapOwners(item)).toEqual(owners)
      expect(mapAcceptance(item, owners)).toContain(scenario)
    }
  })

  it('preserves functional canonical owners in unrelated enterprise examples', () => {
    const evidence = { capture: { guides: [{ file: '11-custom-models.md', text: '## Enterprise Deployment\n```toml\n[cli]\nauto_update = false\n[features]\ntelemetry = false\n```' }] }, source: { guides: [] } }
    const contexts = guideContexts(evidence)
    for (const [field, owner] of [['cli.auto_update', 198], ['features.telemetry', 192]]) {
      const item = { ...fixture('documented-setting', `11-custom-models.md:${field}`), observations: [{ locator: 'binary-guide:11-custom-models.md#L4', excerpt: 'auto_update = false' }] }
      expect(mapOwners(item, contexts)).toEqual(expect.arrayContaining([owner, 140, 141, 189]))
    }
  })

  it('does not mistake unknown goal names for reviewed controls', () => {
    expect(mapOwners(fixture('environment', 'GROK_GOAL_UNREVIEWED_INTERNAL'))).toEqual([139])
  })

  it.each([
    ['GROK_HOME', [139], 'PARITY-139-home-location'],
    ['GROK_SETTINGS_CACHE', [139], 'PARITY-139-settings-cache'],
    ['GROK_DOOM_LOOP_RECOVERY', [135], 'PARITY-135-recovery'],
    ['GROK_TURN_TRANSIENT_RETRY', [135], 'PARITY-135-recovery'],
    ['GROK_MANAGED_BY_NPM', [198], 'PARITY-198-installer'],
    ['GROK_CONTEXTUAL_HINTS', [154], 'PARITY-154-tips'],
    ['GROK_TOOLS_BFS_PATH', [169], 'PARITY-169-backend-selection'],
    ['GROK_EXTRA_CA_BUNDLE', [189], 'PARITY-189-extra-ca'],
    ['GROK_AGENT_METADATA', [147], 'PARITY-147-agent-metadata'],
    ['GROK_UPLOAD_QUEUE_MAX_BYTES', [192], 'PARITY-192-upload-queue'],
    ['GROK_PREFIRE_LEAD_PERCENT', [161], 'PARITY-161-prefire'],
    ['GROK_MAX_RETRIES', [140], 'PARITY-140-transport-controls'],
    ['GROK_CLAUDE_SESSIONS_ENABLED', [159, 194], 'PARITY-194-foreign-sessions'],
    ['GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER', [165], 'PARITY-165-auto-register'],
    ['PAGER', [153, 155], 'PARITY-155-pager-restore'],
    ['HISTFILE', [150], 'PARITY-150-history-file'],
    ['TMPDIR', [143], 'PARITY-143-temp-path'],
    ['CARGO_CFG_TARGET_OS', [133], 'DISCOVERY-133-build-inputs'],
    ['GROK_TOOLS_RG_SHA256', [133], 'DISCOVERY-133-build-inputs'],
    ['GROK_TEST_PROMPT_BLACKHOLE', [133], 'DISCOVERY-133-test-benchmark'],
    ['GROK_ESC_DOUBLE_PRESS_MS', [133], 'DISCOVERY-133-test-benchmark'],
    ['GROK_GIX_STATUS_THREADS', [133], 'DISCOVERY-133-internal-resources'],
    ['GIT_AUTHOR_EMAIL', [133], 'DISCOVERY-133-injected-git-render'],
    ['XAI_TOOL_SERVER_GLOBAL_MAX_INFLIGHT', [133], 'DISCOVERY-133-gateway-private-service'],
    ['GROK_WRAP_IMG', [133], 'DISCOVERY-133-false-positive-identities'],
    ['GROK_CHAT_MODE', [133], 'DISCOVERY-133-false-positive-identities'],
    ['CODEX_CONFIG', [133], 'DISCOVERY-133-false-positive-identities'],
    ['ALACRITTY_SOCKET', [154], 'PARITY-154-terminal-hints'],
    ['BYOBU_CONFIG_DIR', [155], 'PARITY-155-byobu'],
    ['GROK_MEMTRACE', [192], 'PARITY-192-audited-diagnostics'],
    ['GROK_DEPLOYMENT_CONFIG_BACKOFF_MS', [141], 'PARITY-141-refresh-controls'],
    ['GROK_FOREGROUND_BLOCK_BUDGET_MS', [170, 175], 'PARITY-175-foreground-budget'],
    ['GROK_SHELL', [170], 'PARITY-170-shell-controls'],
    ['HOME', [139, 144], 'PARITY-144-core-environment'],
    ['PATH', [139, 144], 'PARITY-144-core-environment'],
    ['GROK_OAUTH_ENABLED', [189], 'PARITY-189-auth-controls'],
    ['GROK_OPEN_DASHBOARD_AT_STARTUP', [159], 'PARITY-159-startup'],
    ['TERM', [170, 192], 'PARITY-170-terminal-type'],
    ['TEMP', [190], 'PARITY-190-system-directory'],
    ['GROK_CODE_BACKEND_URL', [190, 192], 'PARITY-190-service-routing'],
    ['GROK_CONNECT_UI_TIMEOUT_SECS', [147, 155], 'PARITY-147-client-deadlines'],
    ['GROK_SYSTEM_PROMPT_LABEL', [140], 'PARITY-140-system-label'],
    ['XAI_DESCRIBE_TYPE_TIMEOUT_MS', [172], 'PARITY-172-type-deadlines'],
    ['XAI_ROOT', [133], 'DISCOVERY-133-internal-workspace'],
  ])('classifies remaining context family representative %s independently', (name, owners, scenario) => {
    const item = fixture('environment', name)
    expect(mapOwners(item)).toEqual(owners)
    expect(mapAcceptance(item, owners)).toContain(scenario)
  })

  it('audits the complete frozen fallback set once, with resolved evidence and scoped discovery', () => {
    const discovery = read('discovery.json'), source = read('source-evidence.json')
    expect(configAudit.baselineFallbackKeys).toHaveLength(254)
    expect(checkConfigAudit(discovery, source)).toEqual([])
    const missing = structuredClone(configAudit)
    missing.groups[0].controls.shift()
    expect(checkConfigAudit(discovery, source, missing)).toEqual(expect.arrayContaining(['incomplete generic fallback audit']))
    const duplicated = structuredClone(configAudit)
    duplicated.groups[0].controls.push(duplicated.groups[0].controls[0])
    expect(checkConfigAudit(discovery, source, duplicated).join('\n')).toContain('duplicate audit identity')
    const fakeParity = structuredClone(configAudit)
    fakeParity.groups.find(group => group.classification === 'build-test').tickets = [139]
    expect(checkConfigAudit(discovery, source, fakeParity).join('\n')).toContain('internal config masquerades as parity')
    const unresolved = structuredClone(configAudit)
    unresolved.groups[0].controls[0].evidence = ['source:missing.rs#L1']
    expect(checkConfigAudit(discovery, source, unresolved).join('\n')).toContain('unresolved audit evidence')
  })

  it('rejects fabricated contextual source quotations even at valid line locations', () => {
    const sources = [{ path: 'consumer.rs', text: 'first\nactual consumer\nlast' }]
    const audit = { groups: [{ id: 'sample', controls: [{ context: [{ path: 'consumer.rs', startLine: 2, text: 'actual consumer' }] }] }] }
    expect(checkConfigAuditSources(sources, audit)).toEqual([])
    audit.groups[0].controls[0].context[0].text = 'fabricated consumer'
    expect(checkConfigAuditSources(sources, audit)).toEqual(['audit source quotation mismatch sample: consumer.rs#L2'])
  })

  it('checks canonical/documented/env equivalence independently of mapper output', () => {
    const items = [fixture('setting', 'sample.control'), fixture('documented-setting', '11-custom-models.md:sample.control'), fixture('environment', 'CONTROL_ALIAS'), fixture('environment', '05-configuration.md:Environment:`CONTROL_ALIAS=1`')]
    const contexts = new Map([['environment:CONTROL_ALIAS', ['sample.control']]])
    const rows = items.map(item => ({ key: item.key, tickets: [163], acceptance: ['PARITY-163-extra-rules'] }))
    rows[1].tickets.push(141)
    rows[1].acceptance.push('PARITY-141')
    const register = { items: rows }, discovery = { items }
    expect(checkConfigConsistency(register, discovery, contexts)).toEqual([])
    for (const index of [1, 2, 3]) {
      const changed = structuredClone(register)
      changed.items[index].tickets = [139]
      changed.items[index].acceptance = ['PARITY-139']
      expect(checkConfigConsistency(changed, discovery, contexts).join('\n')).toMatch(/(?:representation|alias) mismatch/)
    }
    const missingScenario = structuredClone(register)
    missingScenario.items[1].acceptance = ['PARITY-141']
    expect(checkConfigConsistency(missingScenario, discovery, contexts).join('\n')).toContain('config representation mismatch acceptance')
  })

  it('rejects any newly discovered unreviewed generic control instead of silently accepting fallback', () => {
    const item = fixture('environment', 'GROK_NEW_CONTROL')
    const register = { items: [{ key: item.key, tickets: [139], acceptance: ['PARITY-139'] }] }
    expect(checkConfigConsistency(register, { items: [item] }, new Map())).toEqual(['unreviewed generic config environment:GROK_NEW_CONTROL'])
  })

  it('keeps only individually reviewed generic config/onboarding identities', () => {
    const discovery = read('discovery.json'), register = read('inventory.json')
    expect(checkConfigConsistency(register, discovery, guideContexts(loadEvidence()))).toEqual([])
    const categories = new Map(discovery.items.map(item => [item.key, item.category]))
    const generic = register.items.filter(row => row.tickets.length === 1 && row.tickets[0] === 139 && ['setting', 'documented-setting', 'environment'].includes(categories.get(row.key)))
    expect(generic.map(row => row.key).sort()).toEqual([
      'environment:05-configuration.md:Environment variables > Paths:`GROK_HOME`',
      'environment:14-headless-mode.md:Environment Variables for Headless:`GROK_HOME`',
      'environment:GROK_HOME', 'environment:GROK_SETTINGS_CACHE', 'setting:features.non_git_warning',
    ])
    for (const row of generic) expect(row.acceptance).not.toContain('PARITY-139')
    for (const row of register.items.filter(row => row.acceptance.some(id => id.startsWith('DISCOVERY-')))) {
      expect(row.tickets).toEqual([133])
      expect(row.blocker).toContain('Discovery-only')
      expect(row.status).toBe('pending-parity')
    }
  })

  it('plans observable bounds, routing and failure contracts rather than config display', () => {
    const scenarios = new Map(read('inventory.json').acceptance.map(scenario => [scenario.id, scenario]))
    for (const [id, checks] of [
      ['PARITY-180-verification', [/skeptic calls clamp 1–5/, /classifier cap floors at 1/, /reverify threshold floors at 1/, /no remote layer/]],
      ['PARITY-140-goal-routing', [/planner fork uses the parent model/, /ignoring configured planner pairs/, /per-subagent pin.*agent-definition model.*parent/s, /current-model-only removes explicit role overrides/, /summary.*general-purpose/s, /frozen 1\.0\.34.*unverified/s]],
      ['PARITY-141-fail-closed', [/env can tighten, never weaken/, /refusal/, /provider\/tool/]],
      ['PARITY-144-envrc', [/default is 10s/, /maximum 3600s/, /zero disables/, /partial values never leak/]],
      ['PARITY-192-exit-drain', [/defaults 5s/, /min 1 max 7/, /min\(config timeout, cap\)/, /500ms/, /Disabled consent sends nothing/]],
      ['PARITY-154-announcement-controls', [/\[\] suppresses all/, /malformed falls back/, /defaults 300s/, /minimum 1s/, /dev\/test\/source-only/]],
      ['PARITY-155-osc52-sink', [/Either presence/, /host sink/, /no duplicate delivery/]],
      ['PARITY-157-native-read', [/provider bytes/, /0 still disables/, /canceled paste/]],
      ['PARITY-198-installer', [/actual installer process/, /npm registry env beats config/, /even an empty user-agent is present/, /present invalid GROK_INSTALLER bypasses the remaining env hints/, /preserve the working installation/]],
      ['PARITY-155-container-clipboard', [/uppercase CONTAINER is distinct/, /native remains attempted/, /OSC52 disable override still wins/, /Restart between cached-env variants/, /Frozen 1\.0\.34 behavior remains unverified/]],
      ['PARITY-174-session-preference', [/Ask offers the popup/, /always creates/, /never skips/, /actual git directories/]],
      ['PARITY-163-extra-rules', [/after home rules/, /provider context/, /Invalid\/unreadable paths/]],
    ]) {
      const scenario = scenarios.get(id)
      expect(scenario.status, id).toBe('planned')
      const contract = `${scenario.given} ${scenario.when} ${scenario.then} ${scenario.failure}`
      for (const check of checks) expect(contract, id).toMatch(check)
    }
  })

  it('retains frozen extra-skill no-op evidence instead of promising discovery', () => {
    const row = read('discovery.json').items.find(item => item.key === 'setting:paths.extra_skill_dirs')
    expect(row.observations.find(o => o.scope === 'binary-guide').excerpt).toContain('not yet consulted by skill discovery')
  })
})
