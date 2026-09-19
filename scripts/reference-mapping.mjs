import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptance } from './reference-scenarios.mjs'

const groups = entries => Object.fromEntries(Object.entries(entries).flatMap(([ticket, names]) => names.split(' ').map(name => [name, Number(ticket)])))
const unique = values => [...new Set(values)]
const namespace = (name, table, separator = '.') => Object.keys(table)
  .filter(key => name === key || name.startsWith(key + separator))
  .sort((a, b) => b.length - a.length).map(key => table[key])[0]

const slashOwners = groups({
  137: 'cancel', 138: 'clear new home welcome', 140: 'effort m model', 142: 'always-approve auto yolo',
  149: 'full fullscreen minimal', 150: 'edit-prompt history ml multiline vim-mode', 151: 'btw queue',
  152: 'find jump timeline toggle-mouse-reporting', 153: 'expand log transcript',
  154: 'announcements compact-mode config debug docs gboom guides help howto onboarding preferences prefs scroll-debug settings t theme timestamps tour tutorial',
  155: 'copy doctor exit quit terminal-check terminal-info terminal-setup', 158: 'voice',
  159: 'agents-dashboard cd dashboard info recap rename resume session-info sessions status summarize title',
  160: 'fork rewind undo', 161: 'compact context', 162: 'delete export share',
  163: 'agents config-agents personas skills', 164: 'hooks hooks-add hooks-list hooks-remove hooks-trust hooks-untrust',
  165: 'marketplace', 166: 'plugin plugins reload-plugins', 167: 'mcps', 175: 'tasks', 177: 'loop',
  179: 'plan plan-view show-plan view-plan', 180: 'goal', 181: 'workflow', 184: 'workflows',
  185: 'mem memory remember', 186: 'dream flush', 187: 'imagine', 188: 'imagine-video',
  189: 'login logout', 192: 'feedback privacy', 194: 'import-claude', 197: 'cost usage',
  198: 'changelog release-notes', 206: 'deep-research',
})
const toolOwners = groups({
  136: 'apply_patch edit hashline_edit search_replace write', 161: 'compact_conversation',
  163: 'skill', 167: 'search_tool use_tool', 169: 'glob grep grep_files hashline_grep hashline_read list_dir lsp read read_file',
  170: 'bash get_terminal_command_output kill_terminal_command run_terminal_cmd run_terminal_command',
  171: 'web_fetch web_search', 172: 'spawn_subagent task', 173: 'send_subagent_message',
  175: 'get_command_or_subagent_output get_task_output kill_command_or_subagent kill_task wait_tasks',
  176: 'monitor', 177: 'scheduler_create scheduler_delete scheduler_list',
  179: 'ask_user_question enter_plan_mode exit_plan_mode todo_write todowrite', 180: 'update_goal',
  181: 'workflow', 185: 'memory_get memory_search', 187: 'image_edit image_gen',
  188: 'image_to_video reference_to_video', 190: 'deploy_app init_or_update_app', 192: 'send_feedback',
})
const featureOwners = groups({
  136: 'write_file', 137: 'cancel_rewind', 140: 'image_gen_model_override image_edit_model_override',
  141: 'managed_config', 142: 'remember_mode support_permission', 152: 'dock',
  154: 'terminal_theme campaigns', 158: 'voice_mode', 159: 'session_recap session_search title_refresh turn_summary',
  161: 'compaction_detail compaction_mode compaction_tool_choice compaction_verbatim_input two_pass_compaction',
  163: 'repo_status_in_system_prompt', 167: 'mcp_auto_restart mcp_liveness_watchers mcp_push_server_status mcp_recursive_config_watch',
  169: 'codebase_indexing lsp_tools', 171: 'backend_tools web_fetch', 173: 'active_agent_messages',
  174: 'subagent_worktree_snapshot', 175: 'auto_wake', 179: 'ask_user_question',
  187: 'image_edit image_gen', 188: 'video_gen', 192: 'feedback feedback_trace_card telemetry zdr_access_enabled',
})
const cliOwners = {
  ...groups({139: 'inspect', 140: 'models', 145: 'completions help', 147: 'agent', 148: 'leader',
    155: 'doctor wrap', 159: 'dashboard sessions', 162: 'disk-usage du export share', 166: 'plugin',
    167: 'mcp', 174: 'worktree', 185: 'memory', 189: 'login logout setup', 190: 'cursor-worker workspace',
    191: 'clone', 192: 'trace', 197: 'usage', 198: 'update v version'}),
  'agent headless': 148, 'agent leader': 148, 'agent serve': 148,
  'sessions delete': 162, 'plugin marketplace': 165, 'plugin install': 165,
  'plugin update': 165, 'plugin uninstall': 165, 'plugin remove': 165, 'plugin rm': 165,
}
const flagOwners = groups({
  138: 'continue c session-id s load storage-mode', 140: 'model m effort reasoning-effort xai-api-base-url',
  141: 'trust trust-folder', 142: 'allow allowedTools deny disallowedTools disallowed-tools always-approve auto dangerously-skip-permissions permission-mode yolo',
  143: 'sandbox fs-read fs-write', 146: 'output-format json-schema include-partial-messages',
  148: 'leader leader-socket no-leader bind no-exit-on-disconnect relay-on-demand',
  149: 'fullscreen minimal no-alt-screen', 155: 'terminal', 159: 'resume r', 160: 'fork-session restore-code',
  161: 'compaction-detail compaction-mode', 163: 'agent agent-profile agents', 166: 'plugin-dir',
  171: 'disable-web-search', 172: 'no-subagents', 174: 'ref w worktree worktree-ref',
  175: 'background-wait-timeout no-wait-for-background', 179: 'no-plan no-ask-user todo-gate',
  185: 'experimental-memory no-memory', 186: 'memory-flush',
  189: 'device-auth device-code enterprise force-login oauth oidc reauth reauthenticate',
  190: 'hub-url cli-chat-proxy-base-url remote grok-ws-origin grok-ws-url local-workspace local-workspace-attach local-workspace-cwd',
  192: 'debug debug-file log-sampling', 198: 'alpha stable installer force-reinstall no-auto-update version v V',
})

const configOwners = {
  ...groups({139: 'harness hints paths path_not_found_hints doom_loop_recovery', 140: 'model models model_providers',
    141: 'fail_closed', 142: 'permission auto_mode default_auto_mode', 143: 'sandbox', 144: 'shell_environment_policy',
    148: 'relay', 150: 'prompt_suggestions', 154: 'announcements campaigns ui animation scrollback prompt terminal',
    158: 'voice', 159: 'dashboard', 163: 'agent skills compat', 164: 'hooks', 165: 'marketplace', 166: 'plugins',
    167: 'mcp mcp_servers managed_mcps disabled_mcp_servers disabled_mcp_tools',
    171: 'disable_web_search', 172: 'subagents', 174: 'worktree', 180: 'goal', 181: 'workflows',
    185: 'memory memory_v2', 189: 'auth auth_provider grok_com_config', 190: 'cursor_worker',
    192: 'diagnostics feedback privacy telemetry', 198: 'version_overrides'}),
  'terminal.alt_screen': 149, 'ui.disable_plugins': 166,
  'ui.default_selected_permission': 142, 'ui.permission_mode': 142, 'ui.remember_tool_approvals': 142,
  'ui.disable_bypass_permissions_mode': 142, 'ui.yolo': 142, 'ui.approval_mode': 142,
  'ui.follow_up_behavior': 151, 'ui.cancel_subagents_on_turn_cancel': 137, 'ui.simple_mode': 150,
  'session': 138, 'session.auto_compact_threshold_percent': 161, 'session.load_envrc': 144,
  'storage': 138, 'storage.cleanup': 162, 'cli': 139,
  'cli.auto_update': 198, 'cli.channel': 198, 'cli.installer': 198, 'cli.npm_registry': 198,
  'cli.maximum_version': 198, 'cli.minimum_version': 198, 'cli.required_maximum_version': 141, 'cli.required_minimum_version': 141,
  'cli.grove': 191, 'cli.grove_worktree': 191, 'cli.nfs_worktree': 191, 'cli.worktree_type': 174,
  'cli.session_picker_grouped': 159, 'cli.session_registry': 138, 'cli.use_leader': 148,
  'endpoints.models_base_url': 140, 'endpoints.models_list_url': 140, 'endpoints.xai_api_base_url': 140,
  'endpoints.cli_chat_proxy_base_url': 190, 'endpoints.deployment_key': 189, 'endpoints.managed_config_url': 141,
  'endpoints.feedback_base_url': 192, 'endpoints.trace_upload_bucket': 192, 'endpoints.trace_upload_credentials': 192,
  'endpoints.trace_upload_credentials_file': 192, 'endpoints.trace_upload_endpoint_url': 192,
  'endpoints.trace_upload_region': 192, 'endpoints.trace_upload_url': 192,
  'harness.disable_workspace_teleport': 190, 'harness.wait_for_uploads': 192,
  'tools': 139, 'tools.respect_gitignore': 169, 'tools.disable_zdr_incompatible_tools': 192,
  'tools.media_gen.max_parallel_image_gen_calls': 187, 'tools.media_gen.max_parallel_video_gen_calls': 188,
  'tools.zdr_video_output_s3': 192, 'toolset': 169,
  'toolset.bash': 170, 'toolset.ask_user_question': 179,
  'toolset.web_fetch': 171, 'toolset.web_search': 171,
  'memory.dream': 186, 'memory.flush': 186, 'memory.embedding': 186, 'memory_v2.capture': 186,
  'compaction': 161, 'compaction.memory_flush': 186,
  'workflows.catalog': 184, 'workflows.budget': 182,
}
function configOwner(name) {
  const compatible = name.match(/^compat\.[^.]+\.(hooks|mcps)(?:\.|$)/u)
  if (compatible) return compatible[1] === 'hooks' ? 164 : 167
  if (name.startsWith('features.')) return featureOwners[name.slice(9)] ?? 139
  return namespace(name, configOwners) ?? 139
}

const acpOwners = {
  'session': 138, 'session/update': [148, 138], 'session/updates': [148, 138], 'session/prompt_complete': [148, 138],
  'session/update_mcp_servers': 167, 'session/list': 159, 'session/search': 159, 'session/info': 159,
  'session/rename': 159, 'session/delete': 162, 'session/fork': 160, 'session/import': 194,
  'session/usage': 197, 'session/interjection': 151, 'sessions': 159, 'session_summaries': 159,
  'session_notification': 138, 'sessionConfig': 139, 'sessionDetail': 159,
  'announcements': 154, 'settings': 139, 'config_changed': 139, 'models': 140,
  'auth': 189, 'getApiKey': 189, 'setApiKey': 189, 'auto-topup-rule': 189, 'billing': 189,
  'folder_trust': 141, 'folderTrust': 141, 'permissions': 142, 'yolo_mode_changed': 142,
  'hooks': 164, 'marketplace': 165, 'plugins': 166, 'pluginDirs': 166,
  'mcp': 167, 'mcp_initialized': 167, 'mcp/auth_status': [167, 168], 'mcp/auth_trigger': [167, 168],
  'mcp/elicit': [167, 168], 'mcp/read_resource': [167, 168],
  'memory': 185, 'memory/flush': 186, 'memory/dream': 186, 'memoryMode': 185,
  'queue': 151, 'interject': 151, 'btw': 151, 'prompt_history': 150, 'suggest': 150, 'suggestPrompt': 150,
  'recap': 159, 'titleIsManual': 159, 'compact_conversation': 161, 'rewind': 160, 'restore_code': 160,
  'review': 192, 'ask_user_question': 179, 'exit_plan_mode': 179, 'toggle_plan_mode': 179,
  'feedback': 192, 'privacy': 192, 'consent': 192, 'telemetry': 192,
  'debug/trigger_feedback': 192, 'debug/arm_auto_compact': 161,
  'code': 169, 'codeNavigation': 169, 'fs': 169, 'fs/delete_file': 136, 'fs/write_file': 136,
  'search': 169, 'git/worktree': 174, 'git/diffs': 153,
  'cloud': 190, 'cloud_server_id': 190, 'workspaces': 190, 'local_workspace': 190,
  'leader': 148, 'leaderClientId': 148, 'display_cwd': 159, 'skip_envrc': 144,
  'subagent': 173, 'subagent/cancel': 137, 'task': 175, 'task_backgrounded': 175, 'task_completed': 175,
  'terminal': 170, 'terminal/background': 175, 'bashOutputNoColor': 170, 'incrementalBashOutput': 170,
  'monitor_event': 176, 'scheduler': [177, 178], 'schedulerGeneration': [177, 178], 'schedulerRevision': [177, 178],
  'scheduled_task_created': [177, 178], 'scheduled_task_deleted': [177, 178], 'scheduled_task_fired': [177, 178],
  'workflows': 181, 'workflows/list': 184,
  'internal/auth_cleared': 189, 'internal/evict_sessions': 138,
  'internal/reload_all_mcp_servers': 167, 'internal/reload_project_mcp_servers': 167,
  'internal/reload_models': 140, 'internal/reload_models_cache': 140,
  'internal/reload_skills': 163, 'internal/reload_workflows': 184,
}
function protocolOwners(name) {
  return unique([147, ...[namespace(name.replace(/^x\.ai\//u, ''), acpOwners, '/') ?? []].flat()])
}

const guideDefaults = { '01': 139, '02': 189, '03': 152, '04': 154, '05': 139, '06': 154,
  '07': 167, '08': 163, '09': 165, '10': 164, '11': 140, '12': 163, '13': 185, '14': 146,
  '15': 147, '16': 172, '17': 159, '18': 143, '19': 179, '20': 175, '21': 155,
  '22': 142, '23': 159, '24': 192, '25': 154, '26': 139, '27': 191, RE: 154 }
// Overrides are scoped to a guide and an exact ancestor heading, never arbitrary paragraph words.
const guideSections = {
  '01': { 'Permissions': [142], 'File References': [156], 'Headless Mode': [145, 146], 'Sessions': [138, 159], 'Project Rules (AGENTS.md)': [163], 'Installation': [198] },
  '02': { 'Grove Git credentials (not this page\'s `grok login`)': [189, 191] },
  '03': { 'Agent Dashboard': [159], 'Welcome Screen': [159], 'Input Modes': [150], 'When prompt is focused': [150],
    'Permission prompt': [142], 'Question card (`ask_user_question`)': [179], 'MCP elicitation card (`x.ai/mcp/elicit`)': [168],
    'Cancel-turn panel': [137], 'Escape': [137], 'During an active turn (agent running)': [151], '`/feedback` form': [192],
    'Image Paste & Drag-and-Drop': [157], 'Linux PRIMARY and CLIPBOARD': [155, 199, 201],
    'Block Content': [153], 'Blocking cards': [179, 142, 137], 'Destructive Action Confirmation': [162],
    'Agent-Level': [150, 152], 'View (Scrollback)': [153] },
  '04': { 'Memory': [185], 'Hooks and Plugins': [164, 166], 'Skills as Slash Commands': [163] },
  '05': { 'Authentication': [189], 'Custom models': [140], 'Default selected permission': [142], 'Enterprise deployment': [141, 189],
    'MCP servers': [167], 'LSP servers': [169], 'Memory': [185], 'Plugins': [166], 'Skills': [163], 'Subagents': [172],
    'Notification hooks': [164, 155], 'Notifications': [155], 'Telemetry': [192], 'Logging': [192], 'Version pinning': [141, 198],
    'Goal mode and background workflows': [180, 181], 'Input mode': [150], 'Vim mode': [150], 'Screen mode': [149],
    'pager.toml (appearance configuration)': [154], 'Animation': [154], 'Block configuration': [154], 'Prompt': [154], 'Scrollback': [154],
    'Terminal': [154], 'Status line': [154], 'Scrolling': [152], 'Snap prompt to top on send': [154], 'Terminal support matrix': [155] },
  '06': { 'Minimal Mode Has No Theming': [154, 149], 'Plugins UI': [154, 166] },
  '08': { 'Bundled and Plugin Skills': [163, 166] },
  '07': { 'HTTP/SSE Transport (Remote Server)': [167, 168], 'Native HTTP (hosted services)': [167, 168],
    'Streamable HTTP with Session ID': [167, 168], 'MCP OAuth': [167, 168], 'Blocked by organization policy': [167, 141], 'Subagents and MCP': [167, 172] },
  '09': { 'Trust and security': [165, 141], 'Distribute across an organization': [165, 141],
    'Restrict which marketplaces can be added': [165, 141], 'Require pinned versions': [165, 141],
    'Restrict which MCP servers can run': [165, 141, 167, 204], 'Environment variables in plugin hooks': [165, 164],
    'Turn plugins on or off in config': [166], 'Turn off the plugins UI': [166], 'In the terminal UI': [166] },
  '10': { 'UserPromptSubmit Decision Control': [164, 151, 138], 'Security Notes': [164, 141, 142],
    'Example: Safe Shell Guard': [164, 142], 'Output (Blocking Hooks)': [164, 142], 'How a Hook Resolves': [164, 142] },
  '11': { 'Fleet allowlist (`requirements.toml`)': [140, 141], 'Enterprise Deployment': [140, 141, 189] },
  '13': { 'Auto-Dream': [186], 'Automatic Saves': [186], 'Dream Consolidation with /dream': [186], 'Dream Settings (`[memory.dream]`)': [186],
    'Saving Rich Knowledge with /flush': [186], 'Flush Settings (`[compaction.memory_flush]`)': [186], 'Embedding Settings (`[memory.embedding]`)': [186] },
  '14': { 'Always-approve for automation': [142], 'Permission Rules (`--allow` / `--deny`)': [142], 'Tool Filtering': [142],
    'Authentication for Headless Environments': [189], 'Interrupted Headless Runs': [137, 138], 'Session Management in Headless Mode': [138],
    'Named Sessions (`-s`)': [138], 'Continue (`-c`)': [138], 'Resume (`-r`)': [159], 'Standard Input': [145], 'Command-Line Options': [145],
    'Additional Headless Flags': [145], 'Update Check Suppression': [198] },
  '15': { 'Server mode': [147, 148], 'WebSocket relay': [147, 148], 'Streaming updates': [147, 148, 138] },
  '16': { 'Agents vs Personas': [172, 163], 'Custom Roles and Personas': [172, 163], 'Personas': [172, 163],
    'Per-Type Toggles and Model Overrides': [172, 140], 'Scrollback (parent conversation history)': [173, 153],
    'Capability Modes': [172, 142], 'MCP inheritance': [172, 167], 'Isolation: Worktree Mode': [172, 174],
    'resume_from': [173], 'Sending messages to subagents': [173], 'Fullscreen framed view (the child transcript)': [173, 153],
    'Dock (when enabled)': [152, 173, 175], 'Tasks pane (Ctrl+G)': [173, 175], 'The Tasks Pane (TUI)': [173, 175] },
  '17': { 'Session titles': [159], 'New Session': [138], 'Persistence Format': [138], 'Storage Layout': [138], 'Exit': [155, 138],
    'Fork': [160], 'The /rewind Command': [160], 'The /compact Command': [161], 'Auto-Compact': [161],
    'Disk Usage': [162], 'Checking Disk Usage': [162], 'Delete the current session': [162],
    'The grok usage Subcommand': [197], 'Agent stdio Session Management': [147, 138], 'Worktree Sessions': [159, 174] },
  '19': { 'Edits During Plan Mode': [179, 142], 'Plan Mode and Compaction': [179, 161] },
  '20': { 'The monitor Tool': [176], 'Persistent Monitors': [176], 'Continuous Test Monitoring': [176], 'Log Monitoring': [176],
    'The Scheduler': [177, 178], 'scheduler_create': [177, 178], 'scheduler_delete': [177, 178], 'scheduler_list': [177, 178], 'The /loop Command': [177, 178] },
  '21': { 'Fullscreen or alternate screen does not activate': [155, 149], 'Mouse scrolling stops working': [155, 152], 'Voice dictation records nothing': [155, 158] },
  '22': { 'How a tool call is authorized': [142, 164], 'Restricting Bash to Specific Commands with a Hook': [142, 164],
    'Example: Allow Only `git` and `gh`': [142, 164], 'Headless git and gh Only (CI and Automation)': [142, 164],
    'Disable always-approve (administrators)': [142, 141], '2. Native Configuration (`~/.grok/config.toml` and `.grok/config.toml`)': [142, 141],
    'Where Permission Rules Live (Scopes)': [142, 141], 'Best Practices': [142, 141], 'Combining with the Sandbox': [142, 143, 144] },
  '26': { 'managed_config.toml': [141], 'requirements.toml': [141], 'What happens when a setting is refused': [141, 139] },
}

export function guideContexts(evidence) {
  const contexts = new Map()
  for (const [origin, guides] of [['binary-guide', evidence.capture.guides], ['source-guide', evidence.source.guides]]) {
    for (const guide of guides) {
      const file = guide.file ?? guide.path.split('/').at(-1), headings = []
      let fenced = false
      guide.text.split('\n').forEach((line, index) => {
        if (line.startsWith('```')) fenced = !fenced
        const heading = !fenced && line.match(/^(#{1,6}) (.+)/u)
        if (heading) { headings.length = heading[1].length; headings[heading[1].length - 1] = heading[2] }
        contexts.set(`${origin}:${file}#L${index + 1}`, headings.filter(Boolean))
      })
    }
  }
  return contexts
}

function guideMapping(item, contexts) {
  const [file] = item.name.split(':'), guide = file.slice(0, 2)
  const paths = item.observations.map(o => contexts.get(o.locator)).filter(Boolean)
  const headings = unique(paths.flat())
  const command = commandName(item, contexts)
  if (command && slashOwners[command]) return [slashOwners[command]]
  const cell = item.category === 'guide-item' ? item.name.split(':').at(-1) : ''
  if (['01', '14'].includes(guide)) {
    const flag = cell.match(/`(--?[A-Za-z][A-Za-z-]*)/u)?.[1]
    if (flag) return [flagOwners[flag.replace(/^-+/u, '')] ?? 145]
  }
  if (guide === '10' && cell === '`UserPromptSubmit`') return [164, 151, 138]
  if (['05', '26'].includes(guide) && cell === '`requirements.toml`') return [141]
  if (guide === '05' && cell === '`.grok/sandbox.toml`') return [139, 143, 144]
  if (guide === '18') return [143, 144]
  const override = paths.map(path => [...path].reverse().map(heading => guideSections[guide]?.[heading]).find(Boolean)).filter(Boolean)
  if (item.category === 'documented-setting' && ['05', '06', '26'].includes(guide)) {
    const field = item.name.slice(file.length + 1), owner = configOwner(field)
    const contextual = override.flat()
    // Generic config/appearance defaults must not replace a functional section owner.
    if (contextual.length && (owner === 139 || (owner === 154 && field.startsWith('ui.') && !Object.hasOwn(configOwners, field)))) return unique(contextual)
    return unique([owner, ...contextual])
  }
  if (override.length) return unique(override.flat())
  if (guide === '26') {
    const name = headings.at(-1)?.match(/^`([^`]+)`$/u)?.[1]
    if (name) return [configOwner(name)]
  }
  if (guide === '15') {
    const method = item.name.match(/x\.ai\/[\w/-]+/u)?.[0]
    if (method) return protocolOwners(method)
  }
  return [guideDefaults[guide] ?? 139]
}

function keyOwners(item) {
  const context = item.name.split(':')[1], action = item.observations.map(o => o.excerpt.split('\n').at(-1)).join('\n')
  if (context.includes('feedback')) return [192]
  if (context.includes('MCP elicitation')) return [168]
  if (context.includes('Question card')) return [179]
  if (context.includes('Permission prompt')) return [142]
  if (context.includes('Cancel-turn') || context === 'Escape') return [137]
  if (context === 'Agent Dashboard') return unique([159, ...(/approve/i.test(action) ? [142] : []), ...(/cancel/i.test(action) ? [137] : []), ...(/delete/i.test(action) ? [162] : [])])
  if (context === 'Global' || context.includes('Always available')) {
    if (/dashboard/i.test(action)) return [159]
    if (/new session/i.test(action)) return [138]
    if (/quit|exit/i.test(action)) return [155]
    if (/clear.*prompt/i.test(action)) return [150]
    if (/cancel/i.test(action)) return [137]
    return [152]
  }
  if (context.includes('Welcome Screen')) return [/import/i.test(action) ? 193 : /worktree/i.test(action) ? 174 : 159]
  if (context.includes('Image Paste')) return [157]
  if (context.includes('View (Scrollback')) return [/copy/i.test(action) ? 155 : 153]
  if (context === 'Focus' && /blocking card|question/i.test(action)) return [152, 179, 142, 137]
  if (context.includes('Navigation') || context === 'Focus') return [152]
  if (context.includes('active turn')) return [151]
  if (context === 'Agent-Level') {
    const owners = []
    for (const [pattern, ticket] of [[/external editor|stash|history|multiline/i, 150], [/permission|approve|cycle mode/i, 142], [/model picker/i, 140], [/cancel.*turn/i, 137], [/queue|queued|interject/i, 151], [/background|tasks pane/i, 175], [/todos/i, 179], [/session picker/i, 159], [/shell mode/i, 170], [/settings/i, 154], [/extensions/i, 166]]) if (pattern.test(action)) owners.push(ticket)
    return owners.length ? owners : [152]
  }
  return [context.includes('prompt is focused') ? 150 : 152]
}

const envNamespaces = {
  GROK_MCP: 167, MCP: 167, GROK_MAX_MCP_OUTPUT_BYTES: 167, MAX_MCP_OUTPUT_BYTES: 167,
  GROK_MANAGED_MCPS: 167, GROK_MANAGED_MCP: 167, GROK_XAI_API_BASE_URL: 140,
  GROK_FOLDER_TRUST: 141, GROK_DEFAULT_SELECTED_PERMISSION: 142, GROK_DEFAULT_PERMISSION_MODE: 142, GROK_AUTO_PERMISSION_MODE: 142,
  COLORFGBG: 154, COLORTERM: 154, LC_GROK_THEME: 154,
  BROWSER: 155, COLUMNS: 154, LINES: 154, ENV: 144, GIT_OPTIONAL_LOCKS: 154, HOME: 139, PATH: 139,
  GROK_MODEL: 140, GROK_MODELS: 140, GROK_DEFAULT_MODEL: 140, GROK_CUSTOM_MODELS: 140,
  GROK_PERMISSION: 142, GROK_AUTO_MODE: 142, GROK_REMEMBER_TOOL_APPROVALS: 142, GROK_REMEMBER_MODE: 142,
  GROK_DISABLE_BYPASS_PERMISSIONS_MODE: 142, GROK_YOLO: 142, GROK_ALWAYS_APPROVE: 142,
  GROK_SANDBOX: 143, GROK_SHELL_ENVIRONMENT: 144,
  GROK_HOOKS: 164, GROK_PLUGIN: 166, GROK_PLUGINS: 166, GROK_MARKETPLACE: 165,
  GROK_MEMORY: 185, GROK_WORKTREE: 174, GROK_SUBAGENT: 172, GROK_SUBAGENTS: 172,
  GROK_WORKSPACE: 190, GROK_CURSOR_WORKER: 190, GROK_GROVE: 191,
  GROK_AUTH: 189, GROK_OIDC: 189, GROK_API_KEY: 189, XAI_API_KEY: 189,
  GROK_TELEMETRY: 192, GROK_FEEDBACK: 192, GROK_TRACE: 192, OTEL: 192, DO_NOT_TRACK: 192,
  GROK_DISABLE_AUTOUPDATER: 198, GROK_FPS: 154, GROK_DOCK: 152,
  GROK_VOICE: 158, GROK_VIDEO: 188, GROK_IMAGE_GEN: 187, GROK_IMAGE_EDIT: 187,
}
function environmentOwner(item) {
  const explicit = namespace(item.name, envNamespaces, '_')
  if (explicit) return explicit
  const config = item.name.replace(/^GROK_/u, '').toLowerCase()
  if (featureOwners[config]) return featureOwners[config]
  const quotedGuides = item.observations.map(o => o.locator.match(/^(?:binary|source)-guide:(\d\d)-/u)?.[1]).filter(Boolean)
  const owners = unique(quotedGuides.map(guide => guideDefaults[guide]).filter(owner => ![139, 145, 146, 154].includes(owner)))
  return owners.length === 1 ? owners[0] : 139
}
function cliOwner(name) { return namespace(name, cliOwners, ' ') ?? 145 }
function flagOwner(item) {
  const split = item.name.lastIndexOf(':'), path = item.name.slice(0, split), flag = item.name.slice(split + 1)
  if (item.category === 'source-cli' && !path.endsWith('/app/cli.rs')) {
    const command = path.match(/\/([a-z_]+)_cmd(?:\/|\.rs)/u)?.[1]?.replaceAll('_', '-')
    if (command) return cliOwner(command)
  }
  if (item.category === 'flag' && path !== 'grok' && path !== 'agent') return cliOwner(path)
  return flagOwners[flag.replace(/^-+/u, '')] ?? 145
}
const commandEnums = { AgentCmd: 'agent', LeaderMgmtCommand: 'leader', WorkspaceMgmtCommand: 'workspace', DoctorCommand: 'doctor', McpCommand: 'mcp', MemoryCommand: 'memory', PluginCommand: 'plugin', MarketplaceCommand: 'plugin marketplace', SessionsCommand: 'sessions', WorktreeCommand: 'worktree', WorktreeDbCommand: 'worktree db' }

export function mapOwners(item, contexts = new Map()) {
  let owners
  if (/^\d\d-[^:]+\.md:|^README\.md:/u.test(item.name) && !['keybinding', 'environment'].includes(item.category)) owners = guideMapping(item, contexts)
  else switch (item.category) {
    case 'keybinding': owners = keyOwners(item); break
    case 'acp-extension': owners = protocolOwners(item.name); break
    case 'slash': owners = [slashOwners[item.name]]; break
    case 'tool': owners = [toolOwners[item.name]]; break
    case 'feature': owners = [featureOwners[item.name]]; break
    case 'cli': owners = [cliOwner(item.name)]; break
    case 'source-command': {
      const [context, name] = item.name.split(':')
      owners = [cliOwner([commandEnums[context], name].filter(Boolean).join(' '))]; break
    }
    case 'flag': case 'source-cli': owners = [flagOwner(item)]; break
    case 'setting': owners = [configOwner(item.name)]; break
    case 'pager-setting': owners = [item.name === 'terminal.alt_screen' ? 149 : item.name.includes('disable_plugins') ? 166 : 154]; break
    case 'environment': owners = [environmentOwner(item)]; break
    default: throw new Error(`Unclassified category: ${item.key}`)
  }
  if (owners.some(owner => !owner)) throw new Error(`Unclassified identity: ${item.key}`)
  if (['feature:dock', 'setting:features.dock', 'environment:GROK_DOCK'].includes(item.key)) owners = [152, 151, 173, 175, 176]
  const field = item.category === 'documented-setting' ? item.name.slice(item.name.indexOf(':') + 1) : item.name
  if (['setting', 'documented-setting'].includes(item.category) && /^mcp_servers\.[^.]+\.(?:headers|url|type|oauth(?:_.*)?|bearer_token_env_var|expose_image_base64)$/u.test(field)) owners.push(168)
  if (['flag', 'source-cli'].includes(item.category) && owners.includes(167) && /:(?:--(?:header|transport|type|url)|-H|-t)$/u.test(item.name)) owners.push(168)
  if (['setting', 'documented-setting'].includes(item.category)) {
    if (field === 'ui.disable_bypass_permissions_mode') owners.push(141)
    if (field === 'ui.cancel_subagents_on_turn_cancel') owners.push(173)
    if (field === 'toolset.bash.auto_background_on_timeout') owners.push(175)
  }
  if (owners.includes(177)) owners.push(178)
  return unique(owners)
}

function commandName(item, contexts = new Map()) {
  if (item.category === 'slash') return item.name
  if (!item.name.startsWith('04-slash-commands.md:')) return undefined
  return item.name.match(/`\/([a-z][a-z0-9-]*)/u)?.[1]
    ?? item.observations.flatMap(o => contexts.get(o.locator) ?? []).reverse().map(heading => heading.match(/^`\/([a-z][a-z0-9-]*)/u)?.[1]).find(Boolean)
}
export function mapAcceptance(item, owners, contexts = new Map()) {
  const command = commandName(item, contexts), guide = item.name.slice(0, 2)
  const field = item.category === 'documented-setting' ? item.name.slice(item.name.indexOf(':') + 1) : item.name
  const headings = item.observations.flatMap(o => contexts.get(o.locator) ?? [])
  return owners.map(ticket => {
    if (ticket === 137 && field === 'ui.cancel_subagents_on_turn_cancel') return 'PARITY-137-children'
    if (ticket === 192 && /^x\.ai\/review(?:\/|$)/u.test(item.name)) return 'PARITY-192-review-upload'
    if (ticket === 142) return 'PARITY-142-security-effects'
    if (ticket === 143) return 'PARITY-143-confinement'
    if (ticket === 164 && guide === '10' && (item.name.includes('UserPromptSubmit') || headings.includes('UserPromptSubmit Decision Control'))) return 'PARITY-164-prompt'
    if (ticket === 147 && (/x\.ai\/session\/(?:updates?(?:\/|`|$)|prompt_complete(?:`|$))/u.test(item.name) || item.name.includes('15-agent-mode.md:Streaming updates'))) return 'PARITY-147-updates'
    if (ticket === 179 && guide === '19') return 'PARITY-179-review'
    if (ticket === 140 && (/^(?:models\.|model\.|model_providers\.)/u.test(field) && /headers/u.test(field) || guide === '11' && /Headers/u.test(item.name))) return 'PARITY-140-headers'
    if (ticket === 167) return /^(?:GROK_)?(?:MCP_TIMEOUT|MCP_STARTUP_TIMEOUT_SECS|MAX_MCP_OUTPUT_BYTES)$|^mcp\.max_output_bytes$|startup_timeout_sec|tool_timeout/u.test(item.name) ? 'PARITY-167-limits' : 'PARITY-167-transport'
    if (ticket === 168) return 'PARITY-168-remote'
    if (ticket === 154) {
      const scenario = { help: 'help', docs: 'docs', howto: 'docs', guides: 'docs', debug: 'debug', 'scroll-debug': 'debug', tutorial: 'tutorial', tour: 'tutorial', onboarding: 'tutorial', announcements: 'announcements', gboom: 'gboom' }[command]
      if (scenario) return `PARITY-154-${scenario}`
      if (item.name === 'GROK_FPS' || item.name === 'animation.fps') return 'PARITY-154-fps'
    }
    if (ticket === 159 && command === 'cd') return 'PARITY-159-location'
    if (ticket === 152 && ['feature:dock', 'setting:features.dock', 'environment:GROK_DOCK'].includes(item.key)) return 'PARITY-152-dock'
    if (ticket === 190 && (/^(?:cli|flag):workspace(?:[: ]|$)/u.test(item.key) || item.name === 'GROK_WORKSPACE_COMMAND' || /--hub-url$/u.test(item.name) || /^(?:WorkspaceMgmtCommand:|Command:workspace$)/u.test(item.name))) return 'PARITY-190-workspace'
    if (ticket === 145 && (['flag', 'source-cli'].includes(item.category) && /:-{1,2}(?:prompt-file|prompt-json|system-prompt(?:-override)?|append-system-prompt|rules|single|verbatim|p)$/u.test(item.name)
      || guide === '14' && item.category === 'guide-item' && /`-{1,2}(?:prompt-file|prompt-json|system-prompt(?:-override)?|append-system-prompt|rules|single|verbatim|p)(?:[ `])/u.test(item.name))) return 'PARITY-145-input'
    return `PARITY-${ticket}`
  })
}

export function buildRegister(discovery, tickets, evidence) {
  const contexts = guideContexts(evidence)
  const items = discovery.items.map(item => {
    const owners = mapOwners(item, contexts), tests = mapAcceptance(item, owners, contexts)
    for (const id of tests) if (!acceptance.some(test => test.id === id)) throw new Error(`Missing scenario ${id}`)
    const sourceOnly = !item.observations.some(o => o.scope.startsWith('binary'))
    const provisional = ['announcements', 'cd', 'gboom'].includes(commandName(item))
    const dock = tests.includes('PARITY-152-dock')
    return { key: item.key, stories: unique(owners.flatMap(n => tickets.find(ticket => ticket.number === n).stories)),
      tickets: owners, acceptance: tests, status: 'pending-parity', evidence: item.observations.map(o => o.locator),
      blocker: dock ? 'Dock availability and enabled-mode behavior in frozen 1.0.34 remain unverified; source/config declarations are not runtime verification. Exercise pane interactions and state effects before claiming parity.'
        : provisional ? 'Frozen 1.0.34 availability and complete interactive behavior remain unverified; source export 1.0.35 is not a proven binary match. Source declarations and idle/no-session probes do not verify banner, new-agent cwd or active-session overlay effects.'
          : sourceOnly ? 'Source export is 1.0.35, not a proven 1.0.34 match; verify availability and semantics against the frozen binary before candidate implementation.'
            : 'Reference declaration/documentation is recorded; this exact behavior and its error/mode/platform variants still require downstream installed-product parity evidence.' }
  })
  return { schemaVersion: 1, discoverySha256: createHash('sha256').update(JSON.stringify(discovery)).digest('hex'), tickets, acceptance, items }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [rootArg = 'docs/rewrite/reference', outputArg] = process.argv.slice(2), root = resolve(rootArg)
  const read = name => JSON.parse(readFileSync(resolve(root, name), 'utf8'))
  const register = buildRegister(read('discovery.json'), read('inventory.json').tickets, { capture: read('observations.json'), source: read('source-evidence.json') })
  writeFileSync(resolve(outputArg ?? `${root}/inventory.json`), `${JSON.stringify(register, null, 2)}\n`)
  console.log(`Mapped ${register.items.length} surfaces from scoped guide/namespace rules.`)
}
