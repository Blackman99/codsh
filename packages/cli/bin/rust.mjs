import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants, homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { enabled as webFlag } from './rust-acp-web.mjs'
import { dshFloorProblem, dshPackage, stampTransition, verifyArtifact, whichOnPath } from './rust-artifact.mjs'

const requireFromHere = createRequire(import.meta.url)

function hostDshHome() {
  // Match released dsh-home-paths: blank is unset; only these tilde prefixes expand.
  const value = process.env.DSH_HOME
  let dsh = value !== undefined && value.trim().length > 0 ? value : join(homedir(), '.dsh')
  if (dsh === '~') dsh = homedir()
  else if (dsh.startsWith('~/') || dsh.startsWith('~\\')) dsh = join(homedir(), dsh.slice(2))
  return resolve(dsh)
}

function hostGrokHome() {
  const grok = process.env.GROK_HOME
  if (grok?.split(process.platform === 'win32' ? /[\\/]/u : '/').includes('..')) {
    throw new Error('refusing GROK_HOME with .. components; use an unambiguous path without parent traversal')
  }
  return grok && grok.length > 0 ? grok : join(realpathSync.native(homedir()), '.grok')
}

function legacyHomes() {
  // Grok keeps nonempty overrides verbatim; lexical .. collapse can hide symlinks.
  const grok = process.env.GROK_HOME
  if (grok?.split(process.platform === 'win32' ? /[\\/]/u : '/').includes('..')) {
    throw new Error('refusing GROK_HOME with .. components; use an unambiguous path without parent traversal')
  }
  return [hostDshHome(), join(homedir(), '.dsh'), grok, join(realpathSync.native(homedir()), '.grok')]
}

function canonicalPath(path) {
  const absolute = resolve(path)
  try {
    // Native realpath resolves filesystem case aliases; the JS fallback preserves spelling.
    return { path: realpathSync.native(absolute), suffix: [] }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // ENOENT can hide a dangling link; do not reconstruct it as a missing directory.
    if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`refusing unresolved symlink in Home path: ${absolute}`)
    }
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    // Unicode folding cannot establish the filesystem identity of a missing name.
    const name = basename(absolute)
    if (/[^\x00-\x7f]/u.test(name)) throw new Error('refusing unresolved non-ASCII Home component; use an existing separate directory or ASCII missing components')
    const ancestor = canonicalPath(parent)
    return { path: ancestor.path, suffix: [...ancestor.suffix, name] }
  }
}

function directoryAncestry(home) {
  const ancestors = []
  let path = home.path
  let suffix = home.suffix
  while (true) {
    let stat
    try {
      stat = statSync(path, { bigint: true })
    } catch {
      throw new Error('cannot establish Home directory identity; refusing to write')
    }
    if (!stat.isDirectory() || stat.ino === 0n) throw new Error('cannot establish Home directory identity; refusing to write')
    ancestors.push({ device: stat.dev, inode: stat.ino, suffix })
    const parent = dirname(path)
    if (parent === path) return ancestors
    suffix = [basename(path), ...suffix]
    path = parent
  }
}

function overlaps(a, b) {
  const left = directoryAncestry(a)
  const right = directoryAncestry(b)
  const missing = a.suffix.length > 0 || b.suffix.length > 0
  const prefix = (parent, child) => parent.length <= child.length && parent.every((name, index) =>
    name === child[index] || (missing && name.toLowerCase() === child[index].toLowerCase()))
  // Firmlinks can retain different realpath strings for the same directory identity.
  return left.some(x => right.some(y => x.device === y.device && x.inode === y.inode
    && (prefix(x.suffix, y.suffix) || prefix(y.suffix, x.suffix))))
}

function findDsh() {
  const pinned = process.env.DSH_BIN
  if (pinned !== undefined && pinned !== '') return pinned
  try {
    const manifest = requireFromHere.resolve('@deepseek-ai/dsh/package.json')
    const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin
    return join(dirname(manifest), typeof bin === 'string' ? bin : bin.dsh)
  } catch {
    // Not installed beside codsh-cli. A dsh on PATH is passed as its real
    // path, so helpers that resolve harness packages from DSH_BIN can.
    // Nothing found stays the bare name; the client then reports it missing.
    return whichOnPath('dsh') ?? 'dsh'
  }
}

/** Harness package entry beside the dsh this launch uses, or undefined. */
function resolveBesideDsh(dshBin, name) {
  const owner = dshPackage(dshBin)
  if (owner === undefined) return undefined
  try {
    return createRequire(join(owner.root, 'package.json')).resolve(name)
  } catch {
    return undefined
  }
}

const OWN = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function report(problem) {
  console.error(`codsh: ${problem.message}`)
  for (const line of problem.recovery ?? []) console.error(`  ${line}`)
}

/**
 * `codsh --rust install-check [--json]` (ticket 66): what this install would
 * run, verified without starting the client or dsh and without writing.
 */
function installCheck(args) {
  const json = args.includes('--json')
  const unknown = args.filter(arg => arg !== '--json')
  if (unknown.length > 0) {
    console.error(`codsh: install-check takes only --json (got ${unknown.join(' ')})`)
    return 2
  }
  const nativeRoot = fileURLToPath(new URL('../native/', import.meta.url))
  const artifact = verifyArtifact({ nativeRoot, version: OWN.version })
  const dshBin = findDsh()
  const need = OWN.codsh?.requiresDsh
  const owner = dshPackage(dshBin)
  const reachable = isAbsolute(dshBin) ? existsSync(dshBin) : whichOnPath(dshBin) !== undefined
  const dshProblem = !reachable
    ? {
        ok: false, code: 'dsh-missing',
        message: `no dsh runtime found (DSH_BIN=${dshBin}) — the Rust client runs its turns through dsh.`,
        recovery: [`install one:      npm install -g @deepseek-ai/dsh${need ? `   (${need} or newer)` : ''}`, 'or point at one:  DSH_BIN=/path/to/dsh codsh --rust'],
      }
    : dshFloorProblem(dshBin, need, OWN.version)
  let stamp
  try {
    stamp = JSON.parse(readFileSync(join(realpathSync(homedir()), '.codsh-rust', 'codsh-version.json'), 'utf8'))
  } catch {
    stamp = undefined
  }
  const result = {
    schema: 'codsh.install-check.v1',
    ok: artifact.ok && dshProblem === undefined,
    launcher: { name: OWN.name, version: OWN.version, node: process.version, platform: process.platform, arch: process.arch },
    artifact: artifact.ok
      ? { ok: true, key: artifact.key, binary: artifact.binary, target: artifact.manifest.target, version: artifact.manifest.version ?? null, sha256: artifact.sha256, format: artifact.header.format, cpus: artifact.header.cpus }
      : { ok: false, code: artifact.code, message: artifact.message, recovery: artifact.recovery },
    dsh: {
      ok: dshProblem === undefined, entry: dshBin, version: owner?.version ?? null, requires: need ?? null,
      ...(dshProblem === undefined ? {} : { code: dshProblem.code, message: dshProblem.message, recovery: dshProblem.recovery }),
    },
    home: { path: join(realpathSync(homedir()), '.codsh-rust'), lastVersion: stamp?.lastVersion ?? null, previousVersion: stamp?.previousVersion ?? null },
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    console.log(`codsh-cli ${OWN.version} · Node ${process.version} ${process.platform}-${process.arch}`)
    console.log(artifact.ok
      ? `Rust client: ok · ${artifact.key} (${artifact.manifest.target ?? 'unknown target'}) · ${artifact.header.format} ${artifact.header.cpus.join('+')} · sha256 ${artifact.sha256.slice(0, 12)}…`
      : `Rust client: ${artifact.code} · ${artifact.message}`)
    console.log(dshProblem === undefined
      ? `dsh: ok · ${dshBin}${owner ? ` · ${owner.version}` : ' · version not readable'}${need ? ` (needs ${need}+)` : ''}`
      : `dsh: ${dshProblem.code} · ${dshProblem.message}`)
    console.log(`Rust Home: ${result.home.path}${stamp?.lastVersion ? ` · last used by ${stamp.lastVersion}` : ' · not used yet'}`)
    for (const line of [...(artifact.ok ? [] : artifact.recovery), ...(dshProblem?.recovery ?? [])]) console.log(`  ${line}`)
  }
  return result.ok ? 0 : 1
}

/** Record the running version in the Rust Home; say so when it changed. */
function stampHome(root) {
  const file = join(root, 'codsh-version.json')
  const existing = lstatSync(file, { throwIfNoEntry: false })
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error(`refusing non-file or symlink: ${file}`)
  let previous
  try {
    previous = existing ? JSON.parse(readFileSync(file, 'utf8')) : undefined
  } catch {
    previous = undefined
  }
  const { next, notice } = stampTransition(previous, OWN.version)
  if (notice) console.error(notice)
  if (previous?.lastVersion !== next.lastVersion || previous?.newestVersion !== next.newestVersion || existing === undefined) {
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  }
}

function frontmatter(body, key) {
  const match = body.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  return match?.[1]?.trim() ?? ''
}

function skillRecord(file, source) {
  const body = readFileSync(file, 'utf8')
  const name = frontmatter(body, 'name')
  if (!name) return undefined
  const invocable = frontmatter(body, 'user-invocable').toLowerCase()
  const userInvocable = !['false', 'no', 'off', '0'].includes(invocable)
  return {
    name,
    description: frontmatter(body, 'description'),
    source,
    path: file,
    userInvocable,
    modelInvocable: true,
    disabled: false,
    truncated: false,
    collidesWith: null,
    invocableAs: `/${name}`,
  }
}

// Used only when a staged binary predates the catalog and omits `assets`.
// Vendor scans stay off when their env flag is off. Project .grok skills are
// still listed; vendor project dirs are not a substitute for folder trust.
function catalogFromDisk(home, cwd) {
  const skills = []
  const commands = []
  const claude = !['0', 'false', 'no', 'off'].includes(String(process.env.GROK_CLAUDE_SKILLS_ENABLED ?? 'true').trim().toLowerCase())
  const cursor = !['0', 'false', 'no', 'off'].includes(String(process.env.GROK_CURSOR_SKILLS_ENABLED ?? 'true').trim().toLowerCase())
  const projectActive = ['1', 'true', 'yes', 'on'].includes(String(process.env.GROK_FOLDER_TRUST ?? '').trim().toLowerCase())
  // GROK_FOLDER_TRUST=0 is not a stored grant, but the packed inspect
  // still lists the project .grok skill. Vendor dirs stay behind their flags.
  const roots = []
  if (cwd) roots.push([cwd, 'project'])
  if (home) roots.push([home, 'user'])
  for (const [base, source] of roots) {
    collectSkills(join(base, '.grok', 'skills'), source, skills, 0)
    collectCommands(join(base, '.grok', 'commands'), source, commands)
    if (claude) {
      collectSkills(join(base, '.claude', 'skills'), source, skills, 0)
      collectCommands(join(base, '.claude', 'commands'), source, commands)
    }
    if (cursor) collectSkills(join(base, '.cursor', 'skills'), source, skills, 0)
  }
  return { projectActive, rules: [], skills, commands, agents: [], diagnostics: [] }
}

function collectSkills(root, source, skills, depth) {
  if (depth > 5 || !existsSync(root)) return
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const file = join(dir, 'SKILL.md')
    if (existsSync(file)) {
      const skill = skillRecord(file, source)
      if (skill && !skills.some(item => item.name === skill.name)) skills.push(skill)
    }
    collectSkills(dir, source, skills, depth + 1)
  }
}

function collectCommands(root, source, commands) {
  if (!existsSync(root)) return
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const file = join(root, entry.name)
    const name = entry.name.replace(/\.md$/u, '')
    if (commands.some(item => item.name === name)) continue
    commands.push({
      name,
      description: frontmatter(readFileSync(file, 'utf8'), 'description'),
      source,
      path: file,
      collidesWith: null,
      invocableAs: `/${name}`,
    })
  }
}

function parseInspectObject(stdout, stderr) {
  for (const chunk of [stdout, stderr]) {
    const text = String(chunk ?? '')
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // A prefix is not the inspect object.
    }
  }
  return undefined
}

function privateDirectory(path) {
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`refusing non-directory or symlink: ${path}`)
  } else mkdirSync(path, { mode: 0o700 })
}

export async function launchRust(args) {
  try {
    if (args[0] === 'install-check') return installCheck(args.slice(1))
    const artifact = verifyArtifact({ nativeRoot: fileURLToPath(new URL('../native/', import.meta.url)), version: OWN.version })
    if (!artifact.ok) {
      report(artifact)
      return 1
    }
    const binary = artifact.binary
    const parent = realpathSync(homedir())
    const root = join(parent, '.codsh-rust')
    if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`refusing symlink: ${root}`)
    const canonicalRoot = canonicalPath(root)
    for (const oldHome of legacyHomes()) {
      if (!oldHome) continue
      if (overlaps(canonicalRoot, canonicalPath(oldHome))) throw new Error('Rust Home overlaps a legacy Home; refusing to access legacy data')
    }
    const helpOnly = (args.length === 1 && ['--help', '-h', '--version', '-V', '-v', 'help'].includes(args[0]))
      || (['inspect', 'import', 'login', 'logout', 'setup', 'voice', 'completions'].includes(args[0]) && args.length > 1 && args.slice(1).every(flag => flag === '--help' || flag === '-h'))
      || (args[0] === 'plugin' && args.slice(1).every(flag => flag === '--help' || flag === '-h'))
      || (args[0] === 'completions' && args.length === 2 && !args[1].startsWith('-'))
      || (args[0] === 'help' && args.length === 2 && args[1] === 'completions')
    const dshBin = findDsh()
    if (!helpOnly) {
      const floor = dshFloorProblem(dshBin, OWN.codsh?.requiresDsh, OWN.version)
      if (floor !== undefined) {
        report(floor)
        return 1
      }
      privateDirectory(root)
      stampHome(root)
      privateDirectory(join(root, 'dsh'))
      privateDirectory(join(root, 'dsh', 'profiles'))
      privateDirectory(join(root, 'dsh', 'profiles', 'rust'))
      const profile = join(root, 'dsh', 'profiles', 'rust', 'package.json')
      if (existsSync(profile) && lstatSync(profile).isSymbolicLink()) throw new Error('refusing symlinked Rust Profile')
      if (!existsSync(profile)) writeFileSync(profile, `${JSON.stringify({
        name: 'dsh-profile-rust', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
      }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    }
    const hostHome = realpathSync(homedir())
    const env = {
      HOME: root,
      USERPROFILE: root,
      DSH_HOME: join(root, 'dsh'),
      DSH_PROFILE: 'rust',
      DSH_BIN: dshBin,
      CODSH_REQUIRES_DSH: OWN.codsh?.requiresDsh ?? '',
      CODSH_NODE: process.execPath,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'OFF',
      CODSH_UPDATE_CHECK: 'off',
      CODSH_HOST_HOME: hostHome,
      CODSH_HOST_DSH_HOME: hostDshHome(),
      CODSH_HOST_GROK_HOME: hostGrokHome(),
    }
    for (const key of ['PATH', 'TERM', 'TERM_PROGRAM', 'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'NO_COLOR', 'SystemRoot', 'WINDIR', 'PAGER', 'CODSH_ACP_PATCH', 'CODSH_SESSION_READ', 'CODSH_SESSION_FORK', 'CODSH_WORKTREE', 'CODSH_SESSION_MIGRATE', 'CODSH_TEST_MIGRATION_FAIL', 'DSH_CODE_CLI_MOCK_TOOL', 'DSH_CODE_CLI_MOCK_DELAY_MS', 'DSH_CODE_CLI_MOCK_CONTEXT_WINDOW', 'DSH_CODE_CLI_MOCK_MEMORY', 'DSH_CODE_CLI_MOCK_MEMORY_DELAY_MS', 'DSH_CODE_CLI_MOCK_USAGE', 'GROK_MEMORY_LOG', 'DSH_CODE_CLI_TOOL_DELAY_MS', 'FAKE_ACP_MODE', 'FAKE_ACP_VERSION', 'FAKE_ACP_DELAY_MS', 'FAKE_ACP_TARGET', 'FAKE_ACP_WRITES', 'FAKE_ACP_STORE', 'FAKE_ACP_OWNED', 'FAKE_ACP_STALE_OWNER', 'FAKE_ACP_REFUSE_WHILE_LIVE', 'FAKE_ACP_HELD_SESSION', 'FAKE_ACP_TRACE', 'GROK_CONFIG', 'GROK_CONFIG_PATH', 'GROK_TELEMETRY_ENABLED', 'GROK_FEEDBACK_ENABLED', 'GROK_TRACE_UPLOAD', 'GROK_TELEMETRY_TRACE_UPLOAD', 'GROK_SHARE_CONTENT', 'GROK_SHARE_SESSION', 'CODSH_SHARE_URL', 'GROK_DEBUG_LOG', 'GROK_AGENT_SECRET', 'GROK_USER_METADATA', 'GROK_SETTINGS_CACHE', 'GROK_AUTO_COMPACT_THRESHOLD_PERCENT', 'GROK_COMPACTION_WALL_CLOCK_SECS', 'CODSH_TEST_COMPACT_THRESHOLD', 'CODSH_TEST_PRUNE_DISABLED', 'CODSH_TEST_PRUNE_HEAD', 'CODSH_TEST_PRUNE_TAIL', 'CODSH_TEST_PRUNE_THRESHOLD', 'GROK_FOLDER_TRUST', 'GROK_MANAGED_CONFIG', 'GROK_MANAGED_CONFIG_FAIL_CLOSED', 'GROK_MANAGED_CONFIG_URL', 'GROK_REQUIRED_MINIMUM_VERSION', 'GROK_REQUIRED_MAXIMUM_VERSION', 'GROK_SCREEN_MODE', 'GROK_SCREEN_MODE_SWITCH', 'GROK_OPEN_DASHBOARD_AT_STARTUP', 'GROK_AGENT_DASHBOARD', 'GROK_SESSION_PICKER_GROUPED', 'GROK_CLAUDE_SESSIONS_ENABLED', 'GROK_CODEX_SESSIONS_ENABLED', 'GROK_CURSOR_SESSIONS_ENABLED', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CURSOR_HOME', 'GROK_PERMISSION_MODE', 'GROK_REMEMBER_TOOL_APPROVALS', 'CODSH_PERMISSION_POLICY', 'CODSH_HOOK_DENY', 'CODSH_WORKSPACE_TRUSTED', 'CODSH_PERMISSION_REMEMBER', 'CODSH_PLAIN_TOOLS', 'CODSH_PLAIN_MAX_TURNS', 'GROK_SUBAGENTS', 'GROK_MAX_CONCURRENT_SUBAGENTS', 'GROK_SUBAGENT_LIMIT_BEHAVIOR', 'GROK_SUBAGENTS_MAX_DEPTH', 'GROK_WORKFLOW_MAX_CONCURRENT_AGENTS', 'GROK_ACTIVE_AGENT_MESSAGES', 'CODSH_REVIEW_TRACE', 'CODSH_TEST_SCHEDULER_TIME_SCALE', 'CODSH_TEST_SCHEDULER_EPOCH', 'CODSH_TEST_SCHEDULER_OFFSET_MS', 'CODSH_TEST_MONITOR_TIME_SCALE', 'CODSH_MOCK_MONITOR_TRACE', 'GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER', 'GROK_MARKETPLACE_REQUIRE_SHA', 'GROK_MANAGED_CONFIG_PUBKEY', 'GROK_AUTH_PATH', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_AUTH_PROVIDER_LABEL', 'GROK_AUTH_TOKEN_TTL', 'GROK_AUTH_EARLY_INVALIDATION_SECS', 'GROK_AUTH_EXPIRED', 'GROK_AUTH_REVOKE_URL', 'GROK_LOGIN_DEVICE_FLOW', 'GROK_OIDC_ISSUER', 'GROK_OIDC_CLIENT_ID', 'GROK_OIDC_SCOPES', 'GROK_OIDC_AUDIENCE', 'GROK_OAUTH2_ISSUER', 'GROK_OAUTH2_CLIENT_ID', 'GROK_OAUTH2_SCOPES', 'GROK_DISABLE_API_KEY_AUTH', 'GROK_FORCE_LOGIN_TEAM_ID', 'GROK_DEPLOYMENT_KEY', 'GROK_EXTRA_CA_BUNDLE', 'SSL_CERT_FILE', 'GROK_SUBSCRIPTION_WATCH_INTERVAL_SECS', 'GROK_UNCHARGED_401_PARK', 'CODSH_HOST_HOME', 'CODSH_HOST_DSH_HOME', 'CODSH_HOST_GROK_HOME', 'VISUAL', 'EDITOR', 'BROWSER', 'GROK_PROMPT_SUGGESTIONS', 'GROK_SUGGESTIONS', 'HISTFILE', 'GROK_MOUSE_REPORTING_TOGGLE', 'GROK_SCROLL_MODE', 'GROK_SCROLL_SPEED', 'GROK_SCROLL_LINES', 'GROK_INVERT_SCROLL', 'GROK_VIM_MODE', 'GROK_DOCK', 'GROK_DOCK_V2', 'GROK_VOICE_MODE', 'GROK_VOICE_CAPTURE', 'GROK_VOICE_CAPTURE_MODE', 'GROK_VOICE_KEYBIND', 'GROK_VOICE_STT_LANGUAGE', 'CODSH_VOICE_FIXTURE', 'CODSH_VOICE_DEVICES', 'CODSH_STT_KEY', 'GROK_CLAUDE_SKILLS_ENABLED', 'GROK_CURSOR_SKILLS_ENABLED', 'GROK_MEMORY', 'DSH_CODE_CLI_MOCK_IMAGE', 'CODSH_CLIPBOARD_IMAGE', 'GROK_CLIPBOARD_NO_NATIVE_READ', 'GROK_WEB_FETCH', 'GROK_DISABLE_WEB_FETCH', 'GROK_WEB_FETCH_ALLOW_LOCAL', 'GROK_WEB_FETCH_PROXY', 'GROK_WEB_SEARCH_MODEL', 'GROK_DISABLE_WEB_SEARCH', 'CODSH_WEB_SEARCH', 'CODSH_WEB_FETCH', 'CODSH_WEB_SEARCH_KEY_ENV', 'GROK_IMAGE_GEN', 'GROK_IMAGE_EDIT', 'GROK_IMAGE_GEN_MODEL_OVERRIDE', 'GROK_IMAGE_EDIT_MODEL_OVERRIDE', 'GROK_MAX_PARALLEL_IMAGE_GEN_CALLS', 'CODSH_IMAGE_GEN', 'CODSH_IMAGE_EDIT', 'CODSH_IMAGE_MAX_PARALLEL', 'CODSH_IMAGE_GEN_HOST', 'CODSH_IMAGE_EDIT_HOST', 'CODSH_IMAGE_KEY_ENV', 'CODSH_IMAGE_OPENER', 'GROK_VIDEO_GEN', 'GROK_MAX_PARALLEL_VIDEO_GEN_CALLS', 'CODSH_VIDEO_I2V', 'CODSH_VIDEO_R2V', 'CODSH_VIDEO_MAX_PARALLEL', 'CODSH_VIDEO_HOST', 'CODSH_VIDEO_CAPS', 'CODSH_VIDEO_KEY_ENV', 'CODSH_VIDEO_OPENER', 'CODSH_RUST_BIN', 'CODSH_SHELL_MARKER', 'CODSH_SHELL_WORKDIR', 'GROK_MAX_MCP_OUTPUT_BYTES', 'MAX_MCP_OUTPUT_BYTES', 'GROK_MCP_STARTUP_TIMEOUT_SECS', 'MCP_TIMEOUT', 'GROK_CLAUDE_MCPS_ENABLED', 'GROK_CURSOR_MCPS_ENABLED', 'GROK_ASK_USER_QUESTION', 'GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED', 'GROK_ASK_USER_QUESTION_TIMEOUT_SECS', 'GROK_GOAL', 'GROK_GOAL_VERIFIER_N', 'GROK_GOAL_CLASSIFIER_MAX', 'GROK_CLONE', 'GROVE_CLONE', 'GROK_GROVE', 'GROK_WORKTREE_TYPE', 'GROVE_AUTH_TOKEN', 'GROVE_TOKEN_ROTATION', 'GIT_SSH_COMMAND',
      // Ticket 155: terminal, multiplexer and display facts for clipboard routes, doctor and notifications.
      'TMUX', 'TMUX_PANE', 'STY', 'ZELLIJ', 'BYOBU_BACKEND', 'BYOBU_CONFIG_DIR', 'BYOBU_TTY', 'BYOBU_SESSION', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'container', 'TERM_PROGRAM_VERSION', 'LC_TERMINAL', 'LC_TERMINAL_VERSION', 'ITERM_SESSION_ID', 'KITTY_WINDOW_ID', 'GHOSTTY_RESOURCES_DIR', 'WEZTERM_PANE', 'WEZTERM_EXECUTABLE', 'ALACRITTY_WINDOW_ID', 'ALACRITTY_SOCKET', 'ZED_TERM', 'TERMINAL_EMULATOR', 'WT_SESSION', 'VTE_VERSION', 'CURSOR_TRACE_ID', 'GROK_COPY_FILE', 'GROK_CLIPBOARD_NO_OSC52', 'GROK_OSC52_SINK', 'LC_GROK_OSC52_SINK', 'GROK_EXIT_TIMEOUT_SECS']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    if (process.env.GROK_SANDBOX !== undefined) env.GROK_SANDBOX = process.env.GROK_SANDBOX
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && (key === 'XAI_API_KEY' || key.endsWith('_API_KEY'))) env[key] = value
    }
    // Inherited GROK_HOME names a legacy Home; the client reads and writes only the isolated one.
    env.GROK_HOME = join(root, '.grok')
    // GROK_LEADER_SOCKET is not copied for the same reason: it names the
    // legacy client's leader. The isolated leader is $GROK_HOME/leader.sock
    // unless --leader-socket names another path.
    if (!helpOnly && env.CODSH_ACP_PATCH === undefined) {
      const approval = fileURLToPath(new URL('./rust-acp-file-approval.mjs', import.meta.url))
      const compact = fileURLToPath(new URL('./rust-acp-compact.mjs', import.meta.url))
      const web = fileURLToPath(new URL('./rust-acp-web.mjs', import.meta.url))
      const plain = fileURLToPath(new URL('./rust-acp-plain.mjs', import.meta.url))
      const hooks = fileURLToPath(new URL('./rust-acp-hooks.mjs', import.meta.url))
      const subagents = fileURLToPath(new URL('./rust-acp-subagents.mjs', import.meta.url))
      const control = fileURLToPath(new URL('./rust-acp-control.mjs', import.meta.url))
      const plan = fileURLToPath(new URL('./rust-acp-plan.mjs', import.meta.url))
      const mcp = fileURLToPath(new URL('./rust-acp-mcp.mjs', import.meta.url))
      const background = fileURLToPath(new URL('./rust-acp-background.mjs', import.meta.url))
      const goal = fileURLToPath(new URL('./rust-acp-goal.mjs', import.meta.url))
      const image = fileURLToPath(new URL('./rust-acp-image.mjs', import.meta.url))
      const video = fileURLToPath(new URL('./rust-acp-video.mjs', import.meta.url))
      const overlay = join(root, 'dsh', 'rust-file-approval.yml')
      // Optional harness plugins come from the dsh this launch uses; the
      // relative paths are a development checkout's workspace node_modules.
      const lsp = resolveBesideDsh(dshBin, '@deepseek-ai/dsh-lsp') ?? fileURLToPath(new URL('../../../node_modules/@deepseek-ai/dsh-lsp/lib/index.js', import.meta.url))
      const toolLsp = resolveBesideDsh(dshBin, '@deepseek-ai/dsh-tool-lsp') ?? fileURLToPath(new URL('../../../node_modules/@deepseek-ai/dsh-tool-lsp/lib/index.js', import.meta.url))
      const lspInsert = existsSync(lsp) && existsSync(toolLsp)
        ? ['    - id: lsp', `      name: '${pathToFileURL(lsp).href}'`, '    - id: tool-lsp', `      name: '${pathToFileURL(toolLsp).href}'`]
        : []
      // ask_user_question (ticket 179): the acp profile does not load dsh's tool.
      const askUser = resolveBesideDsh(dshBin, '@deepseek-ai/dsh-tool-ask-user') ?? fileURLToPath(new URL('../../../node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js', import.meta.url))
      const askInsert = existsSync(askUser) ? ['    - id: tool-ask-user', `      name: '${pathToFileURL(askUser).href}'`] : []
      writeFileSync(overlay, [
        '- id: web-search-deepseek',
        '  disabled: true',
        '- id: web-fetch-http',
        '  disabled: true',
        '- id: web',
        '  config:',
        '    searchProvider: codsh-substitute',
        '    fetchProvider: codsh-substitute',
        '- id: tool-web',
        '  config:',
        `    search: ${webFlag('CODSH_WEB_SEARCH', env) ? 'true' : 'false'}`,
        `    fetch: ${webFlag('CODSH_WEB_FETCH', env) ? 'true' : 'false'}`,
        // rust-acp-subagents registers the typed `subagent` tool in its place.
        '- id: tool-subagent',
        '  disabled: true',
        // rust-acp-subagents registers the Rhai `workflow` tool in its place
        // (ticket 181). workflow-worker-thread stays: tool-ralph needs it.
        '- id: tool-workflow',
        '  disabled: true',
        '- insert:',
        ...lspInsert,
        ...askInsert,
        `    - id: rust-acp-plain`,
        `      name: '${pathToFileURL(plain).href}'`,
        `    - id: rust-acp-hooks`,
        `      name: '${pathToFileURL(hooks).href}'`,
        `    - id: rust-acp-subagents`,
        `      name: '${pathToFileURL(subagents).href}'`,
        `    - id: rust-acp-file-approval`,
        `      name: '${pathToFileURL(approval).href}'`,
        `    - id: rust-acp-compact`,
        `      name: '${pathToFileURL(compact).href}'`,
        `    - id: rust-acp-web`,
        `      name: '${pathToFileURL(web).href}'`,
        `    - id: rust-acp-plan`,
        `      name: '${pathToFileURL(plan).href}'`,
        `    - id: rust-acp-background`,
        `      name: '${pathToFileURL(background).href}'`,
        `    - id: rust-acp-goal`,
        `      name: '${pathToFileURL(goal).href}'`,
        `    - id: rust-acp-control`,
        `      name: '${pathToFileURL(control).href}'`,
        `    - id: rust-acp-mcp`,
        `      name: '${pathToFileURL(mcp).href}'`,
        `    - id: rust-acp-image`,
        `      name: '${pathToFileURL(image).href}'`,
        `    - id: rust-acp-video`,
        `      name: '${pathToFileURL(video).href}'`,
        '',
      ].join('\n'))
      env.CODSH_ACP_PATCH = overlay
    }
    if (env.CODSH_SESSION_READ === undefined) {
      env.CODSH_SESSION_READ = fileURLToPath(new URL('./rust-acp-session-read.mjs', import.meta.url))
    }
    if (env.CODSH_SESSION_FORK === undefined) {
      env.CODSH_SESSION_FORK = fileURLToPath(new URL('./rust-acp-session-fork.mjs', import.meta.url))
    }
    // Optional extensions shipped in this package (`plugin install bundled:<name>`).
    // Only the path is passed; nothing is installed or enabled here.
    env.CODSH_BUNDLED_EXTENSIONS = fileURLToPath(new URL('../extensions/', import.meta.url))
    if (env.CODSH_WORKTREE === undefined) {
      env.CODSH_WORKTREE = fileURLToPath(new URL('./rust-worktree.mjs', import.meta.url))
    }
    if (env.CODSH_SESSION_MIGRATE === undefined) {
      env.CODSH_SESSION_MIGRATE = fileURLToPath(new URL('./rust-session-migrate.mjs', import.meta.url))
    }
    if (args.includes('inspect') && args.includes('--json')) {
      const probed = spawnSync(binary, args, { env, encoding: 'utf8', timeout: 20000 })
      const parsed = parseInspectObject(probed.stdout, probed.stderr)
      if (parsed) {
        const assets = parsed.assets
        const declared = assets && typeof assets === 'object' && !Array.isArray(assets)
          && Array.isArray(assets.skills) && Array.isArray(assets.commands)
        if (!declared) {
          // HOME here is the isolated root. Project files stay in the caller's cwd.
          parsed.assets = catalogFromDisk(env.HOME, process.cwd())
        }
        process.stdout.write(`${JSON.stringify(parsed)}\n`)
        if (probed.stderr) process.stderr.write(probed.stderr)
        return probed.status ?? 1
      }
    }
    // `wrap` (ticket 155) runs the user's own command, e.g. ssh, so it gets
    // the caller's real environment; only the copy backup stays in the isolated home.
    const runEnv = args[0] === 'wrap'
      ? { ...process.env, CODSH_WRAP_GROK_HOME: env.GROK_HOME, CODSH_HOST_HOME: env.CODSH_HOST_HOME }
      : env
    return await new Promise(resolveExit => {
      const child = spawn(binary, args, { env: runEnv, stdio: 'inherit', shell: false })
      const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => { child.kill(signal) }]))
      for (const [signal, handler] of handlers) process.on(signal, handler)
      const finish = code => {
        for (const [signal, handler] of handlers) process.off(signal, handler)
        resolveExit(code)
      }
      child.once('error', error => { console.error(`codsh: Rust startup failed: ${error.message}`); finish(1) })
      // A child killed by a signal exits 128+N, as a shell reports it: SIGINT 130, SIGTERM 143.
      child.once('exit', (code, signal) => { finish(code ?? (signal && constants.signals[signal] ? 128 + constants.signals[signal] : 1)) })
    })
  } catch (error) {
    console.error(`codsh: ${error.message}`)
    return 1
  }
}
