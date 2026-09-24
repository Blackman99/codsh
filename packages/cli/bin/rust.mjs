import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants, homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { enabled as webFlag } from './rust-acp-web.mjs'

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
    return 'dsh'
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
    const native = fileURLToPath(new URL(`../native/${process.platform}-${process.arch}/`, import.meta.url))
    const binary = join(native, process.platform === 'win32' ? 'codsh-rust.exe' : 'codsh-rust')
    if (!existsSync(binary)) {
      throw new Error(`Rust client artifact is not installed for ${process.platform}-${process.arch}. Use a locally staged candidate (pnpm run build:rust); ordinary codsh remains available.`)
    }
    const manifest = JSON.parse(readFileSync(join(native, 'artifact.json'), 'utf8'))
    const digest = createHash('sha256').update(readFileSync(binary)).digest('hex')
    if (manifest.sha256 !== digest || manifest.platform !== process.platform || manifest.arch !== process.arch) {
      throw new Error('Rust client artifact integrity/platform mismatch; rebuild the candidate')
    }
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
    if (!helpOnly) {
      privateDirectory(root)
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
      DSH_BIN: findDsh(),
      CODSH_NODE: process.execPath,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'OFF',
      CODSH_UPDATE_CHECK: 'off',
      CODSH_HOST_HOME: hostHome,
      CODSH_HOST_DSH_HOME: hostDshHome(),
      CODSH_HOST_GROK_HOME: hostGrokHome(),
    }
    for (const key of ['PATH', 'TERM', 'TERM_PROGRAM', 'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'NO_COLOR', 'SystemRoot', 'WINDIR', 'PAGER', 'CODSH_ACP_PATCH', 'CODSH_SESSION_READ', 'CODSH_SESSION_FORK', 'DSH_CODE_CLI_MOCK_TOOL', 'DSH_CODE_CLI_MOCK_DELAY_MS', 'DSH_CODE_CLI_MOCK_CONTEXT_WINDOW', 'DSH_CODE_CLI_TOOL_DELAY_MS', 'FAKE_ACP_MODE', 'FAKE_ACP_VERSION', 'FAKE_ACP_DELAY_MS', 'FAKE_ACP_TARGET', 'FAKE_ACP_WRITES', 'FAKE_ACP_STORE', 'FAKE_ACP_OWNED', 'FAKE_ACP_STALE_OWNER', 'FAKE_ACP_REFUSE_WHILE_LIVE', 'FAKE_ACP_HELD_SESSION', 'FAKE_ACP_TRACE', 'GROK_CONFIG', 'GROK_CONFIG_PATH', 'GROK_TELEMETRY_ENABLED', 'GROK_FEEDBACK_ENABLED', 'GROK_TRACE_UPLOAD', 'GROK_TELEMETRY_TRACE_UPLOAD', 'GROK_SHARE_CONTENT', 'GROK_SHARE_SESSION', 'CODSH_SHARE_URL', 'GROK_DEBUG_LOG', 'GROK_USER_METADATA', 'GROK_SETTINGS_CACHE', 'GROK_AUTO_COMPACT_THRESHOLD_PERCENT', 'GROK_COMPACTION_WALL_CLOCK_SECS', 'CODSH_TEST_COMPACT_THRESHOLD', 'CODSH_TEST_PRUNE_DISABLED', 'CODSH_TEST_PRUNE_HEAD', 'CODSH_TEST_PRUNE_TAIL', 'CODSH_TEST_PRUNE_THRESHOLD', 'GROK_FOLDER_TRUST', 'GROK_MANAGED_CONFIG', 'GROK_MANAGED_CONFIG_FAIL_CLOSED', 'GROK_MANAGED_CONFIG_URL', 'GROK_REQUIRED_MINIMUM_VERSION', 'GROK_REQUIRED_MAXIMUM_VERSION', 'GROK_SCREEN_MODE', 'GROK_SCREEN_MODE_SWITCH', 'GROK_OPEN_DASHBOARD_AT_STARTUP', 'GROK_AGENT_DASHBOARD', 'GROK_SESSION_PICKER_GROUPED', 'GROK_CLAUDE_SESSIONS_ENABLED', 'GROK_CODEX_SESSIONS_ENABLED', 'GROK_CURSOR_SESSIONS_ENABLED', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CURSOR_HOME', 'GROK_PERMISSION_MODE', 'GROK_REMEMBER_TOOL_APPROVALS', 'CODSH_PERMISSION_POLICY', 'CODSH_HOOK_DENY', 'CODSH_WORKSPACE_TRUSTED', 'CODSH_PERMISSION_REMEMBER', 'CODSH_PLAIN_TOOLS', 'CODSH_PLAIN_MAX_TURNS', 'CODSH_REVIEW_TRACE', 'GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER', 'GROK_MARKETPLACE_REQUIRE_SHA', 'GROK_MANAGED_CONFIG_PUBKEY', 'GROK_AUTH_PATH', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_AUTH_PROVIDER_LABEL', 'GROK_AUTH_TOKEN_TTL', 'GROK_AUTH_EARLY_INVALIDATION_SECS', 'GROK_AUTH_EXPIRED', 'GROK_AUTH_REVOKE_URL', 'GROK_LOGIN_DEVICE_FLOW', 'GROK_OIDC_ISSUER', 'GROK_OIDC_CLIENT_ID', 'GROK_OIDC_SCOPES', 'GROK_OIDC_AUDIENCE', 'GROK_OAUTH2_ISSUER', 'GROK_OAUTH2_CLIENT_ID', 'GROK_OAUTH2_SCOPES', 'GROK_DISABLE_API_KEY_AUTH', 'GROK_FORCE_LOGIN_TEAM_ID', 'GROK_DEPLOYMENT_KEY', 'GROK_EXTRA_CA_BUNDLE', 'SSL_CERT_FILE', 'GROK_SUBSCRIPTION_WATCH_INTERVAL_SECS', 'GROK_UNCHARGED_401_PARK', 'CODSH_HOST_HOME', 'CODSH_HOST_DSH_HOME', 'CODSH_HOST_GROK_HOME', 'VISUAL', 'EDITOR', 'GROK_PROMPT_SUGGESTIONS', 'GROK_SUGGESTIONS', 'HISTFILE', 'GROK_MOUSE_REPORTING_TOGGLE', 'GROK_SCROLL_MODE', 'GROK_SCROLL_SPEED', 'GROK_SCROLL_LINES', 'GROK_INVERT_SCROLL', 'GROK_VIM_MODE', 'GROK_DOCK', 'GROK_DOCK_V2', 'GROK_VOICE_MODE', 'GROK_VOICE_CAPTURE', 'GROK_VOICE_CAPTURE_MODE', 'GROK_VOICE_KEYBIND', 'GROK_VOICE_STT_LANGUAGE', 'CODSH_VOICE_FIXTURE', 'CODSH_VOICE_DEVICES', 'CODSH_STT_KEY', 'GROK_CLAUDE_SKILLS_ENABLED', 'GROK_CURSOR_SKILLS_ENABLED', 'GROK_MEMORY', 'DSH_CODE_CLI_MOCK_IMAGE', 'CODSH_CLIPBOARD_IMAGE', 'GROK_CLIPBOARD_NO_NATIVE_READ', 'GROK_WEB_FETCH', 'GROK_DISABLE_WEB_FETCH', 'GROK_WEB_FETCH_ALLOW_LOCAL', 'GROK_WEB_FETCH_PROXY', 'GROK_WEB_SEARCH_MODEL', 'GROK_DISABLE_WEB_SEARCH', 'CODSH_WEB_SEARCH', 'CODSH_WEB_FETCH', 'CODSH_WEB_SEARCH_KEY_ENV', 'CODSH_RUST_BIN', 'CODSH_SHELL_MARKER', 'CODSH_SHELL_WORKDIR']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    if (process.env.GROK_SANDBOX !== undefined) env.GROK_SANDBOX = process.env.GROK_SANDBOX
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && (key === 'XAI_API_KEY' || key.endsWith('_API_KEY'))) env[key] = value
    }
    // Inherited GROK_HOME names a legacy Home; the client reads and writes only the isolated one.
    env.GROK_HOME = join(root, '.grok')
    if (!helpOnly && env.CODSH_ACP_PATCH === undefined) {
      const approval = fileURLToPath(new URL('./rust-acp-file-approval.mjs', import.meta.url))
      const compact = fileURLToPath(new URL('./rust-acp-compact.mjs', import.meta.url))
      const web = fileURLToPath(new URL('./rust-acp-web.mjs', import.meta.url))
      const plain = fileURLToPath(new URL('./rust-acp-plain.mjs', import.meta.url))
      const hooks = fileURLToPath(new URL('./rust-acp-hooks.mjs', import.meta.url))
      const overlay = join(root, 'dsh', 'rust-file-approval.yml')
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
        '- insert:',
        `    - id: rust-acp-plain`,
        `      name: '${pathToFileURL(plain).href}'`,
        `    - id: rust-acp-hooks`,
        `      name: '${pathToFileURL(hooks).href}'`,
        `    - id: rust-acp-file-approval`,
        `      name: '${pathToFileURL(approval).href}'`,
        `    - id: rust-acp-compact`,
        `      name: '${pathToFileURL(compact).href}'`,
        `    - id: rust-acp-web`,
        `      name: '${pathToFileURL(web).href}'`,
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
    return await new Promise(resolveExit => {
      const child = spawn(binary, args, { env, stdio: 'inherit', shell: false })
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
