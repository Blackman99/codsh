//! `codsh --rust clone` and the Grove gates (ticket 191).
//!
//! The reference `grok clone` asks a Grove daemon to fetch a repository into
//! a content store and mount a projected working tree (FUSE on Linux, NFS on
//! macOS). That daemon and its protocol are private infrastructure. This
//! client maps the same command onto plain `git`: a real clone on disk with
//! the same history defaults (a depth-1 bootstrap of one branch with blobs
//! fetched on demand, or `--full-history`), sparse cones, and the same
//! product gates. Differences are reported, never hidden: there is no daemon
//! and no projection, files of the checkout are written to disk, and the
//! summary prints the depth, branch, and blob mode git actually produced.
//!
//! Safety rules:
//! - The clone is written to a hidden sibling directory and renamed onto the
//!   target only after it succeeded; a failure, Ctrl-C, or a closed remote
//!   connection removes that directory. An existing repository or a
//!   non-empty directory is never written.
//! - Credentials belong to git (credential helpers, SSH keys, known_hosts)
//!   or `GROVE_AUTH_TOKEN` for https; `codsh --rust login` is never used.
//!   A token is sent as an HTTP header through the environment, so it is not
//!   on the command line and not stored in `.git/config`. A URL with an
//!   embedded password is refused for the same reason.
//! - `--remote ssh://…` runs the clone on the remote host with that host's
//!   credentials; nothing of this machine is forwarded.

use std::io::{self, IsTerminal, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::remote;

pub const HELP: &str = "Clone a git repository with git (substitute for the reference Grove lazy clone)

Usage: codsh --rust clone [OPTIONS] <URL> [DIR]

Arguments:
  <URL>  Remote repository URL (https, ssh, git, file, user@host:path, or a local path)
  [DIR]  Local directory for the clone (default: basename of the URL)

Options:
  -b, --branch <BRANCH>       Branch or ref to check out
      --cone <PATH>           Sparse-checkout cone path (repeatable)
      --full-history          Fetch complete history, every branch, and tags instead of the depth-1 bootstrap. After a depth-1 clone, `git fetch --deepen=N origin` / `git fetch --unshallow origin` affect only the selected branch. Another branch needs an explicit depth-limited refspec
      --remote <SSH_URL>      Clone on a remote host instead: ssh://[user@]host[:port]/abs/base (with --remote-identity, --remote-known-hosts, --remote-command, --remote-ssh)
      --debug                 Enable debug logging
      --debug-file <FILE>     Write debug logs to FILE
  -h, --help                  Print help

Gate: GROK_CLONE / GROVE_CLONE, then GROK_GROVE or [cli] grove in $GROK_HOME/config.toml,
then [clone] enabled in ~/.config/grove/config.toml. Off when none is set.
Backend: plain git. There is no Grove daemon, content store, or FUSE/NFS mount: the clone
is a real checkout on disk, and blobs outside it are fetched when git needs them.
Credentials: git's own (credential helper, SSH keys and known_hosts, GIT_SSH_COMMAND) or
GROVE_AUTH_TOKEN for https remotes. `codsh --rust login` is never used for git.
";

pub const EXIT_USAGE: i32 = 2;
pub const EXIT_CONFLICT: i32 = 3;
pub const EXIT_CREDENTIALS: i32 = 4;
pub const EXIT_CANCELLED: i32 = 130;

/// Hidden flag the local side of `--remote` passes: the remote clone reads
/// its stdin and cancels (removing its partial directory) when the
/// connection closes.
const LIFELINE_FLAG: &str = "--codsh-remote-lifeline";

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Options {
    pub url: String,
    pub dir: Option<String>,
    pub branch: Option<String>,
    pub cones: Vec<String>,
    pub full_history: bool,
    pub debug: bool,
    pub debug_file: Option<PathBuf>,
    pub lifeline: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    Help,
    Run(Options),
}

fn value_of(
    args: &[String],
    index: &mut usize,
    flag: &str,
    placeholder: &str,
) -> Result<String, String> {
    *index += 1;
    match args.get(*index) {
        Some(value) if !value.starts_with('-') || value.len() == 1 => Ok(value.clone()),
        _ => Err(format!("clone {flag} needs a value ({placeholder})")),
    }
}

/// Parse the arguments after `clone` (remote flags already removed).
pub fn parse(args: &[String]) -> Result<Parsed, String> {
    let mut options = Options::default();
    let mut positional: Vec<String> = Vec::new();
    let mut index = 0;
    let mut rest = false;
    while index < args.len() {
        let arg = &args[index];
        if rest {
            positional.push(arg.clone());
            index += 1;
            continue;
        }
        match arg.as_str() {
            "--" => rest = true,
            "-h" | "--help" => return Ok(Parsed::Help),
            "-b" | "--branch" => {
                if options.branch.is_some() {
                    return Err("clone --branch was given more than once".into());
                }
                options.branch = Some(value_of(args, &mut index, "--branch", "<BRANCH>")?);
            }
            "--cone" => options
                .cones
                .push(value_of(args, &mut index, "--cone", "<PATH>")?),
            "--full-history" => options.full_history = true,
            "--debug" => options.debug = true,
            "--debug-file" => {
                options.debug_file = Some(PathBuf::from(value_of(
                    args,
                    &mut index,
                    "--debug-file",
                    "<FILE>",
                )?));
            }
            "--leader-socket" => {
                return Err("clone --leader-socket is unused: this client clones with git and has no Grove daemon or leader to reach. Omit the flag.".into());
            }
            LIFELINE_FLAG => options.lifeline = true,
            other => {
                if let Some(value) = other.strip_prefix("--branch=") {
                    if options.branch.replace(value.to_string()).is_some() {
                        return Err("clone --branch was given more than once".into());
                    }
                } else if let Some(value) = other.strip_prefix("--cone=") {
                    options.cones.push(value.to_string());
                } else if let Some(value) = other.strip_prefix("--debug-file=") {
                    options.debug_file = Some(PathBuf::from(value));
                } else if other.starts_with("--leader-socket=") {
                    return Err("clone --leader-socket is unused: this client clones with git and has no Grove daemon or leader to reach. Omit the flag.".into());
                } else if other.starts_with('-') && other.len() > 1 {
                    return Err(format!(
                        "unexpected clone argument '{other}'; see codsh --rust clone --help"
                    ));
                } else {
                    positional.push(other.to_string());
                }
            }
        }
        index += 1;
    }
    let mut positional = positional.into_iter();
    options.url = positional
        .next()
        .ok_or_else(|| "clone needs a repository URL; see codsh --rust clone --help".to_string())?;
    options.dir = positional.next();
    if let Some(extra) = positional.next() {
        return Err(format!("unexpected clone argument '{extra}'"));
    }
    validate(&options)?;
    Ok(Parsed::Run(options))
}

fn has_control(text: &str) -> bool {
    text.chars().any(char::is_control)
}

/// What kind of remote a URL names. `http` tokens are only sent to loopback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrlKind {
    Https { origin: String },
    Http { origin: String, loopback: bool },
    Ssh,
    Git,
    File,
    ScpLike,
    LocalPath,
}

fn host_of(authority: &str) -> String {
    let hostport = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    if let Some(inner) = hostport.strip_prefix('[') {
        return inner.split(']').next().unwrap_or_default().to_string();
    }
    hostport.split(':').next().unwrap_or_default().to_string()
}

pub fn url_kind(url: &str) -> Result<UrlKind, String> {
    if url.is_empty() || url.starts_with('-') || has_control(url) {
        return Err(format!(
            "clone: invalid repository URL {url:?} (empty, starting with '-', or with control characters)"
        ));
    }
    if url.contains("::") {
        return Err(
            "clone: `transport::address` URLs run remote helpers and are refused; use https, ssh, git, or file".into(),
        );
    }
    if let Some((scheme, rest)) = url.split_once("://") {
        let authority = rest.split('/').next().unwrap_or_default();
        if let Some((userinfo, _)) = authority.rsplit_once('@')
            && userinfo.contains(':')
        {
            return Err("clone: the URL carries a password; it would be stored in .git/config. Use a git credential helper or GROVE_AUTH_TOKEN instead".into());
        }
        let origin = format!("{scheme}://{authority}/");
        return match scheme.to_ascii_lowercase().as_str() {
            "https" => Ok(UrlKind::Https { origin }),
            "http" => {
                let host = host_of(authority);
                Ok(UrlKind::Http {
                    origin,
                    loopback: matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1"),
                })
            }
            "ssh" | "git+ssh" | "ssh+git" => Ok(UrlKind::Ssh),
            "git" => Ok(UrlKind::Git),
            "file" => Ok(UrlKind::File),
            other => Err(format!(
                "clone: unsupported URL scheme {other:?}; use https, http, ssh, git, or file"
            )),
        };
    }
    // git's rule: a colon before the first slash is scp-like host:path.
    match (url.find(':'), url.find('/')) {
        (Some(colon), slash) if slash.is_none_or(|slash| colon < slash) => Ok(UrlKind::ScpLike),
        _ => Ok(UrlKind::LocalPath),
    }
}

fn validate(options: &Options) -> Result<(), String> {
    url_kind(&options.url)?;
    if let Some(dir) = &options.dir
        && (dir.is_empty() || dir.starts_with('-') || has_control(dir))
    {
        return Err(format!("clone: invalid directory {dir:?}"));
    }
    if let Some(branch) = &options.branch
        && (branch.is_empty()
            || branch.starts_with('-')
            || has_control(branch)
            || branch.chars().any(char::is_whitespace))
    {
        return Err(format!("clone: invalid branch {branch:?}"));
    }
    for cone in &options.cones {
        validate_cone(cone)?;
    }
    Ok(())
}

pub fn validate_cone(cone: &str) -> Result<(), String> {
    let path = Path::new(cone);
    if cone.is_empty()
        || cone.starts_with('-')
        || has_control(cone)
        || path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(format!(
            "clone --cone {cone:?}: a cone is a relative directory inside the repository"
        ));
    }
    Ok(())
}

/// The directory git would pick: the last path part without `.git`.
pub fn humanish(url: &str) -> Option<String> {
    let trimmed = url.trim_end_matches('/');
    let trimmed = trimmed.strip_suffix("/.git").unwrap_or(trimmed);
    let last = trimmed
        .rsplit(['/', ':'])
        .next()
        .unwrap_or_default()
        .trim_end_matches(".git");
    let last = last.strip_suffix(".bundle").unwrap_or(last);
    if last.is_empty() || last == "." || last == ".." || last.starts_with('-') {
        None
    } else {
        Some(last.to_string())
    }
}

// ---------------------------------------------------------------------------
// Gates

/// Grove spellings from the reference config: true/false words, transports.
pub fn grove_word(text: &str) -> Option<bool> {
    match text.trim().to_ascii_lowercase().as_str() {
        "grove" | "grove-fuse" | "grove-nfs" | "grove-projfs" | "nfs" | "true" | "1" | "on"
        | "yes" => Some(true),
        "copy" | "false" | "0" | "off" | "no" => Some(false),
        _ => None,
    }
}

fn enable_all_word(text: &str) -> Option<bool> {
    if text.trim().eq_ignore_ascii_case("all") {
        return Some(true);
    }
    grove_word(text)
}

fn toml_flag(value: &toml::Value, words: fn(&str) -> Option<bool>) -> Option<bool> {
    value.as_bool().or_else(|| value.as_str().and_then(words))
}

/// `[cli]` of `$GROK_HOME/config.toml`.
pub fn user_cli_table(grok_home: &Path) -> Option<toml::Value> {
    let text = std::fs::read_to_string(grok_home.join("config.toml")).ok()?;
    let root: toml::Value = toml::from_str(&text).ok()?;
    root.get("cli").cloned()
}

/// `~/.config/grove/config.toml` of the person running codsh: the host home
/// the launcher records, since this client's own HOME is isolated.
pub fn grove_config_path() -> PathBuf {
    if let Some(dir) = std::env::var_os("XDG_CONFIG_HOME").filter(|dir| !dir.is_empty()) {
        return PathBuf::from(dir).join("grove/config.toml");
    }
    host_home().join(".config/grove/config.toml")
}

pub fn host_home() -> PathBuf {
    std::env::var_os("CODSH_HOST_HOME")
        .filter(|home| !home.is_empty())
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

pub fn grove_clone_enabled(path: &Path) -> Option<bool> {
    let text = std::fs::read_to_string(path).ok()?;
    let root: toml::Value = toml::from_str(&text).ok()?;
    root.get("clone")
        .and_then(|clone| clone.get("enabled"))
        .and_then(|value| toml_flag(value, grove_word))
}

fn enable_all(
    env: &dyn Fn(&str) -> Option<String>,
    cli: Option<&toml::Value>,
) -> Option<&'static str> {
    // A set GROK_GROVE=false skips [cli] grove rather than forcing it off.
    match env("GROK_GROVE").as_deref().and_then(enable_all_word) {
        Some(true) => Some("env GROK_GROVE"),
        Some(false) => None,
        None => cli
            .and_then(|cli| cli.get("grove"))
            .and_then(|value| toml_flag(value, enable_all_word))
            .filter(|on| *on)
            .map(|_| "config [cli] grove"),
    }
}

/// The `codsh --rust clone` product gate, in the reference order.
pub fn clone_gate(
    env: &dyn Fn(&str) -> Option<String>,
    cli: Option<&toml::Value>,
    grove_clone: Option<bool>,
) -> (bool, &'static str) {
    for key in ["GROK_CLONE", "GROVE_CLONE"] {
        if let Some(on) = env(key).as_deref().and_then(grove_word) {
            return (
                on,
                if key == "GROK_CLONE" {
                    "env GROK_CLONE"
                } else {
                    "env GROVE_CLONE"
                },
            );
        }
    }
    if let Some(source) = enable_all(env, cli) {
        return (true, source);
    }
    if let Some(on) = grove_clone {
        return (on, "grove config [clone] enabled");
    }
    (false, "default")
}

/// The session / `-w` Grove-vs-copy gate: env, local config, enable-all.
/// There is no remote settings service, so the remote layers never apply.
pub fn worktree_gate(
    env: &dyn Fn(&str) -> Option<String>,
    cli: Option<&toml::Value>,
) -> (bool, &'static str) {
    if let Some(on) = env("GROK_WORKTREE_TYPE").as_deref().and_then(grove_word) {
        return (on, "env GROK_WORKTREE_TYPE");
    }
    if let Some(cli) = cli {
        for (key, source) in [
            ("grove_worktree", "config [cli] grove_worktree"),
            ("nfs_worktree", "config [cli] nfs_worktree"),
        ] {
            if let Some(value) = cli.get(key) {
                if let Some(on) = toml_flag(value, grove_word) {
                    return (on, source);
                }
                break;
            }
        }
        if let Some(kind) = cli.get("worktree_type").and_then(|value| value.as_str()) {
            match kind {
                "grove" | "grove-fuse" | "grove-nfs" | "grove-projfs" | "nfs" => {
                    return (true, "config [cli] worktree_type");
                }
                "copy" => return (false, "config [cli] worktree_type"),
                _ => {}
            }
        }
    }
    if let Some(source) = enable_all(env, cli) {
        return (true, source);
    }
    (false, "default")
}

fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// The Grove request for a new worktree, as its source label, or `None`.
pub fn worktree_grove_request(grok_home: &Path) -> Option<&'static str> {
    let cli = user_cli_table(grok_home);
    let (on, source) = worktree_gate(&process_env, cli.as_ref());
    on.then_some(source)
}

// ---------------------------------------------------------------------------
// Git process plumbing

struct Debug {
    stderr: bool,
    file: Option<std::fs::File>,
}

impl Debug {
    fn open(options: &Options) -> io::Result<Self> {
        let file = match &options.debug_file {
            Some(path) => {
                let mut open = std::fs::OpenOptions::new();
                open.create(true).append(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    open.mode(0o600);
                }
                Some(open.open(path).map_err(|error| {
                    io::Error::other(format!("clone --debug-file {}: {error}", path.display()))
                })?)
            }
            None => None,
        };
        Ok(Self {
            stderr: options.debug,
            file,
        })
    }

    fn log(&mut self, text: &str) {
        if self.stderr {
            let _ = writeln!(io::stderr(), "codsh clone debug: {text}");
        }
        if let Some(file) = self.file.as_mut() {
            let _ = writeln!(file, "{text}");
        }
    }
}

fn say(text: &str) {
    // A closed stderr (remote connection gone) must not abort the cleanup.
    let _ = writeln!(io::stderr(), "{text}");
}

fn out(text: &str) {
    let _ = writeln!(io::stdout(), "{text}");
}

fn git_base() -> Command {
    let mut command = Command::new(std::env::var_os("CODSH_GIT").unwrap_or_else(|| "git".into()));
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_COMMON_DIR",
    ] {
        command.env_remove(key);
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("HOME", host_home())
        .args([
            "-c",
            "protocol.ext.allow=never",
            "-c",
            "protocol.fd.allow=never",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .stdin(Stdio::null());
    command
}

fn git_text(dir: &Path, args: &[&str]) -> Option<String> {
    let output = git_base()
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_version() -> String {
    git_base()
        .arg("--version")
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_else(|| "git (version unknown)".into())
}

/// `GROVE_AUTH_TOKEN` as git config through the environment, scoped to the
/// clone's origin. Returns the credential description for the summary.
fn token_env(
    command: &mut Command,
    kind: &UrlKind,
    token: Option<&str>,
) -> Result<&'static str, String> {
    let Some(token) = token.filter(|token| !token.is_empty()) else {
        return Ok("git (credential helper, SSH keys and known_hosts, GIT_SSH_COMMAND)");
    };
    let origin = match kind {
        UrlKind::Https { origin } => origin,
        UrlKind::Http {
            origin,
            loopback: true,
        } => origin,
        UrlKind::Http { .. } => {
            return Err("clone: GROVE_AUTH_TOKEN is not sent over plain http to a non-loopback host; use https".into());
        }
        _ => {
            say(
                "codsh: GROVE_AUTH_TOKEN applies to https remotes only; this remote uses git's own credentials (SSH keys, known_hosts).",
            );
            return Ok("git (credential helper, SSH keys and known_hosts, GIT_SSH_COMMAND)");
        }
    };
    if token
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err("clone: GROVE_AUTH_TOKEN contains whitespace or control characters".into());
    }
    use base64::Engine as _;
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    let count: usize = std::env::var("GIT_CONFIG_COUNT")
        .ok()
        .and_then(|count| count.parse().ok())
        .unwrap_or(0);
    command
        .env("GIT_CONFIG_COUNT", (count + 1).to_string())
        .env(
            format!("GIT_CONFIG_KEY_{count}"),
            format!("http.{origin}.extraHeader"),
        )
        .env(
            format!("GIT_CONFIG_VALUE_{count}"),
            format!("Authorization: Basic {basic}"),
        );
    Ok(
        "GROVE_AUTH_TOKEN (an https Authorization header from the environment; not stored in .git/config)",
    )
}

const PROGRESS: &[&str] = &[
    "remote: Enumerating objects",
    "remote: Counting objects",
    "remote: Compressing objects",
    "remote: Total",
    "Enumerating objects",
    "Counting objects",
    "Compressing objects",
    "Receiving objects",
    "Resolving deltas",
    "Unpacking objects",
    "Updating files",
    "Checking out files",
    "Filtering content",
    "Updating index flags",
];

fn is_progress(text: &str) -> bool {
    PROGRESS.iter().any(|prefix| text.starts_with(prefix))
}

/// Forward git's progress lines; keep every line for the failure report.
fn pump_stderr(
    mut stderr: impl Read + Send + 'static,
    show: bool,
    tail: Arc<Mutex<Vec<String>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut pending: Vec<u8> = Vec::new();
        let mut buffer = [0u8; 4096];
        let emit = |segment: &[u8], end: u8| {
            let text = String::from_utf8_lossy(segment).trim_end().to_string();
            if text.is_empty() {
                return;
            }
            if show && is_progress(&text) {
                let mut err = io::stderr();
                let _ = err.write_all(text.as_bytes());
                let _ = err.write_all(&[end]);
                let _ = err.flush();
            }
            if let Ok(mut lines) = tail.lock() {
                if end == b'\r' && lines.last().is_some_and(|last| is_progress(last)) {
                    lines.pop();
                }
                lines.push(text);
                let excess = lines.len().saturating_sub(200);
                lines.drain(..excess);
            }
        };
        loop {
            let read = match stderr.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            pending.extend_from_slice(&buffer[..read]);
            while let Some(position) = pending.iter().position(|b| *b == b'\n' || *b == b'\r') {
                let end = pending[position];
                let segment: Vec<u8> = pending.drain(..=position).collect();
                emit(&segment[..segment.len() - 1], end);
            }
        }
        if !pending.is_empty() {
            emit(&pending, b'\n');
        }
    })
}

/// Why a clone failed, from git's messages (LC_ALL=C).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    Credentials,
    HostKey,
    NotFound,
    Branch,
    Network(String),
    Other(String),
}

pub fn classify(lines: &[String]) -> Failure {
    let any = |needles: &[&str]| {
        lines
            .iter()
            .any(|line| needles.iter().any(|needle| line.contains(needle)))
    };
    if any(&[
        "Host key verification failed",
        "REMOTE HOST IDENTIFICATION HAS CHANGED",
    ]) {
        return Failure::HostKey;
    }
    if any(&[
        "Authentication failed",
        "could not read Username",
        "could not read Password",
        "Permission denied (publickey",
        "Permission denied, please try again",
        "returned error: 401",
        "returned error: 403",
        "HTTP Basic: Access denied",
        "Invalid username or password",
    ]) {
        return Failure::Credentials;
    }
    if any(&["Remote branch", "remote branch"]) && any(&["not found"]) {
        return Failure::Branch;
    }
    if any(&[
        "Repository not found",
        "does not appear to be a git repository",
        "returned error: 404",
    ]) || lines
        .iter()
        .any(|line| line.contains("repository '") && line.contains("not found"))
    {
        return Failure::NotFound;
    }
    let last = lines
        .iter()
        .rev()
        .find(|line| line.starts_with("fatal:") || line.starts_with("error:"))
        .or_else(|| lines.last())
        .cloned()
        .unwrap_or_else(|| "git exited without a message".into());
    if any(&[
        "Could not resolve host",
        "Connection refused",
        "Connection timed out",
        "Failed to connect",
        "Network is unreachable",
        "Connection reset",
        "Connection closed by",
    ]) {
        return Failure::Network(last);
    }
    Failure::Other(last)
}

fn failure_text(failure: &Failure, url: &str, branch: Option<&str>) -> (String, i32) {
    let scrub = |line: &str| line.replace(url, "<the remote>");
    match failure {
        Failure::Credentials => (
            "Git credentials rejected (unavailable).\nGit credentials for `codsh --rust clone` belong to git (credential helper, SSH keys, GIT_SSH_COMMAND) or GROVE_AUTH_TOKEN for https remotes, not `codsh --rust login`.\nCheck `git credential fill` or your SSH key, then retry.".into(),
            EXIT_CREDENTIALS,
        ),
        Failure::HostKey => (
            "The remote's SSH host key is not trusted (host key verification failed).\nAdd its key to known_hosts (or the UserKnownHostsFile of GIT_SSH_COMMAND), then retry.".into(),
            EXIT_CREDENTIALS,
        ),
        Failure::NotFound => (
            "Repository not found. Check the URL; a private repository your credentials cannot see looks the same, so this is not reported as a credential problem.".into(),
            1,
        ),
        Failure::Branch => (
            format!(
                "Branch or ref {} was not found on the remote.",
                branch.unwrap_or("(default)")
            ),
            1,
        ),
        Failure::Network(line) => (format!("Cannot reach the remote: {}", scrub(line)), 1),
        Failure::Other(line) => (format!("git clone failed: {}", scrub(line)), 1),
    }
}

// ---------------------------------------------------------------------------
// Cancellation

fn install_cancel(lifeline: bool) -> Arc<AtomicBool> {
    let cancel = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    for signal in [
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGTERM,
        signal_hook::consts::SIGHUP,
    ] {
        let _ = signal_hook::flag::register(signal, Arc::clone(&cancel));
    }
    if lifeline {
        let flag = Arc::clone(&cancel);
        std::thread::spawn(move || {
            let mut stdin = io::stdin();
            let mut buffer = [0u8; 256];
            loop {
                match stdin.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            flag.store(true, Ordering::SeqCst);
        });
    }
    cancel
}

fn spawn_group(command: &mut Command) -> io::Result<Child> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own group: the terminal's Ctrl-C reaches this process, which
        // stops git and removes the partial clone before exiting.
        command.process_group(0);
    }
    command.spawn()
}

fn stop_group(child: &mut Child) {
    #[cfg(unix)]
    {
        let group = child.id() as i32;
        // SAFETY: kill(2) on the child's own process group.
        unsafe {
            libc::kill(-group, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                // SAFETY: as above; stray group members get SIGKILL.
                unsafe {
                    libc::kill(-group, libc::SIGKILL);
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // SAFETY: as above.
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

enum Waited {
    Exited(std::process::ExitStatus),
    Cancelled,
}

fn wait_or_cancel(child: &mut Child, cancel: &AtomicBool) -> io::Result<Waited> {
    loop {
        if cancel.load(Ordering::SeqCst) {
            stop_group(child);
            return Ok(Waited::Cancelled);
        }
        if let Some(status) = child.try_wait()? {
            return Ok(Waited::Exited(status));
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

// ---------------------------------------------------------------------------
// Target directory

#[derive(Debug, PartialEq, Eq)]
enum Target {
    Fresh,
    Empty,
    SameClone,
}

fn absolute(path: &Path) -> io::Result<PathBuf> {
    let base = if path.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir()?
    };
    let mut out = base;
    for part in path.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}

fn same_remote(a: &str, b: &str) -> bool {
    let norm = |url: &str| {
        let url = url.trim_end_matches('/');
        url.strip_suffix(".git").unwrap_or(url).to_string()
    };
    norm(a) == norm(b)
}

fn inspect_target(target: &Path, url: &str) -> Result<Target, (String, i32)> {
    let meta = match std::fs::symlink_metadata(target) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Target::Fresh),
        Err(error) => return Err((format!("cannot inspect {}: {error}", target.display()), 1)),
    };
    let conflict = |what: &str| {
        Err((
            format!(
                "{} {what}; nothing was changed. Choose another directory.",
                target.display()
            ),
            EXIT_CONFLICT,
        ))
    };
    if meta.file_type().is_symlink() {
        return conflict("is a symbolic link");
    }
    if !meta.is_dir() {
        return conflict("already exists and is not a directory");
    }
    let empty = std::fs::read_dir(target)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false);
    if empty {
        return Ok(Target::Empty);
    }
    if target.join(".git").exists()
        && git_text(target, &["rev-parse", "--show-toplevel"])
            .map(PathBuf::from)
            .and_then(|top| top.canonicalize().ok())
            == target.canonicalize().ok()
        && git_text(target, &["config", "--get", "remote.origin.url"])
            .is_some_and(|origin| same_remote(&origin, url))
    {
        return Ok(Target::SameClone);
    }
    conflict("already exists and is not empty")
}

fn temp_prefix(name: &str) -> String {
    format!(".{name}.codsh-clone-")
}

#[cfg(unix)]
fn pid_alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn pid_alive(_pid: i32) -> bool {
    true
}

/// Remove partial clones a killed run left beside the target (their owner
/// process is gone). Only this exact hidden name pattern is touched.
fn sweep_stale(parent: &Path, name: &str) {
    let prefix = temp_prefix(name);
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let Some(rest) = file_name.strip_prefix(&prefix) else {
            continue;
        };
        let Some((pid, stamp)) = rest.split_once('-') else {
            continue;
        };
        let (Ok(pid), true) = (
            pid.parse::<i32>(),
            !stamp.is_empty() && stamp.chars().all(|ch| ch.is_ascii_digit()),
        ) else {
            continue;
        };
        let is_dir = entry
            .file_type()
            .map(|kind| kind.is_dir() && !kind.is_symlink())
            .unwrap_or(false);
        if is_dir && pid > 0 && !pid_alive(pid) && std::fs::remove_dir_all(entry.path()).is_ok() {
            say(&format!(
                "codsh: removed a partial clone an interrupted run left behind ({})",
                entry.path().display()
            ));
        }
    }
}

// ---------------------------------------------------------------------------
// Summary

struct Summary {
    lines: Vec<String>,
}

fn summarize(dir: &Path, options: &Options, credentials: &str, git_lines: &[String]) -> Summary {
    let mut lines = Vec::new();
    let head = git_text(dir, &["rev-parse", "--verify", "--quiet", "HEAD"]);
    let branch = git_text(dir, &["symbolic-ref", "--short", "-q", "HEAD"]);
    let sparse =
        git_text(dir, &["config", "--bool", "core.sparseCheckout"]).as_deref() == Some("true");
    let cones = if sparse {
        git_text(dir, &["sparse-checkout", "list"])
            .map(|list| list.lines().map(str::to_string).collect::<Vec<_>>())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    match &head {
        Some(sha) => lines.push(format!(
            "  checkout:    {} at {} ({})",
            branch.as_deref().unwrap_or("detached HEAD"),
            &sha[..sha.len().min(12)],
            if sparse {
                format!("sparse cones: {}", cones.join(", "))
            } else {
                "full checkout".into()
            }
        )),
        None => lines.push("  checkout:    empty repository (no commits yet)".into()),
    }
    let shallow =
        git_text(dir, &["rev-parse", "--is-shallow-repository"]).as_deref() == Some("true");
    let commits = head
        .as_ref()
        .and_then(|_| git_text(dir, &["rev-list", "--count", "HEAD"]))
        .unwrap_or_else(|| "0".into());
    let remote_branches = git_text(
        dir,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/remotes/origin",
        ],
    )
    .map(|list| {
        list.lines()
            .filter(|name| !name.is_empty() && *name != "origin/HEAD" && *name != "origin")
            .count()
    })
    .unwrap_or(0);
    let tags = git_text(dir, &["tag", "--list"])
        .map(|list| list.lines().filter(|name| !name.is_empty()).count())
        .unwrap_or(0);
    if shallow {
        lines.push(format!(
            "  history:     depth {commits} (shallow; {remote_branches} remote branch tracked; `git fetch --deepen=N origin` or `git fetch --unshallow origin` deepens it)"
        ));
    } else if !options.full_history && head.is_some() {
        lines.push(format!(
            "  history:     full ({commits} commits, {remote_branches} remote branch(es), {tags} tag(s)): git does not shorten history for this source (local paths ignore --depth; use a file:// URL)"
        ));
    } else {
        lines.push(format!(
            "  history:     full ({commits} commits, {remote_branches} remote branch(es), {tags} tag(s))"
        ));
    }
    // git records the promisor remote even when it ignored the filter.
    let filter_ignored = git_lines.iter().any(|line| {
        line.contains("--filter is ignored") || line.contains("filtering not recognized by server")
    });
    let promisor = !filter_ignored
        && git_text(dir, &["config", "--bool", "remote.origin.promisor"]).as_deref()
            == Some("true");
    lines.push(if promisor {
        "  blobs:       fetched on demand (partial clone, filter blob:none)".into()
    } else {
        "  blobs:       all fetched (the remote or a local path does not use partial clone)".into()
    });
    lines.push(format!(
        "  backend:     {} (substitute for Grove: a real clone on disk; no daemon, content store, or FUSE/NFS projection)",
        git_version()
    ));
    lines.push(format!("  credentials: {credentials}"));
    Summary { lines }
}

// ---------------------------------------------------------------------------
// Entry points

fn gate_or_refuse(debug: &mut Debug) -> Result<(), (String, i32)> {
    let cli = user_cli_table(&crate::worktree::early_grok_home());
    let grove_path = grove_config_path();
    let (on, source) = clone_gate(&process_env, cli.as_ref(), grove_clone_enabled(&grove_path));
    debug.log(&format!(
        "gate: {} ({source})",
        if on { "on" } else { "off" }
    ));
    if on {
        return Ok(());
    }
    Err((
        format!(
            "codsh --rust clone is off ({}). Turn it on with GROK_CLONE=1, GROK_GROVE=1 or [cli] grove = true in $GROK_HOME/config.toml, or [clone] enabled = true in {}. It clones with plain git; there is no Grove daemon or mount.",
            if source == "default" {
                "no gate is set".to_string()
            } else {
                format!("{source} is off")
            },
            grove_path.display()
        ),
        EXIT_USAGE,
    ))
}

/// `codsh --rust clone ...`. Returns the process exit code.
pub fn run(args: &[String], remote_target: Option<remote::Target>) -> io::Result<i32> {
    let options = match parse(args) {
        Ok(Parsed::Help) => {
            print!("{HELP}");
            return Ok(0);
        }
        Ok(Parsed::Run(options)) => options,
        Err(message) => {
            say(&format!("error: {message}"));
            return Ok(EXIT_USAGE);
        }
    };
    let mut debug = Debug::open(&options)?;
    if let Err((message, code)) = gate_or_refuse(&mut debug) {
        say(&message);
        return Ok(code);
    }
    match remote_target {
        Some(target) => run_remote(&options, &target, &mut debug),
        None => run_local(&options, &mut debug),
    }
}

fn run_local(options: &Options, debug: &mut Debug) -> io::Result<i32> {
    let kind = match url_kind(&options.url) {
        Ok(kind) => kind,
        Err(message) => {
            say(&message);
            return Ok(EXIT_USAGE);
        }
    };
    let dir = match options.dir.clone().or_else(|| humanish(&options.url)) {
        Some(dir) => dir,
        None => {
            say("clone: cannot pick a directory name from this URL; pass [DIR]");
            return Ok(EXIT_USAGE);
        }
    };
    let target = absolute(Path::new(&dir))?;
    let (Some(parent), Some(name)) = (
        target.parent().map(Path::to_path_buf),
        target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()),
    ) else {
        say(&format!(
            "clone: {} cannot be a clone directory",
            target.display()
        ));
        return Ok(EXIT_USAGE);
    };
    if !parent.is_dir() {
        say(&format!(
            "clone: the parent directory {} does not exist; nothing was created",
            parent.display()
        ));
        return Ok(1);
    }
    let parent = parent.canonicalize()?;
    let target = parent.join(&name);
    let state = match inspect_target(&target, &options.url) {
        Ok(state) => state,
        Err((message, code)) => {
            say(&format!("clone: {message}"));
            return Ok(code);
        }
    };
    let token = std::env::var("GROVE_AUTH_TOKEN").ok();
    if state == Target::SameClone {
        let current = git_text(&target, &["symbolic-ref", "--short", "-q", "HEAD"]);
        if let Some(wanted) = &options.branch
            && current.as_deref() != Some(wanted.as_str())
        {
            say(&format!(
                "clone: {} is already a clone of this remote on {} (asked for {wanted}); nothing was changed.",
                target.display(),
                current.as_deref().unwrap_or("a detached HEAD")
            ));
            return Ok(EXIT_CONFLICT);
        }
        out(&format!(
            "{} is already a clone of {}; nothing was fetched or changed.",
            target.display(),
            options.url
        ));
        for line in summarize(&target, options, "not used (nothing was fetched)", &[]).lines {
            out(&line);
        }
        if !options.lifeline {
            out(&format!("Next: cd {} && codsh --rust", target.display()));
        }
        return Ok(0);
    }
    if std::env::var_os("GROVE_TOKEN_ROTATION").is_some() {
        say(
            "codsh: GROVE_TOKEN_ROTATION is a Grove daemon setting; this client has no daemon and reads GROVE_AUTH_TOKEN once per clone.",
        );
    }
    sweep_stale(&parent, &name);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let temp = parent.join(format!(
        "{}{}-{stamp}",
        temp_prefix(&name),
        std::process::id()
    ));
    let cancel = install_cancel(options.lifeline);
    let show_progress = options.lifeline || io::stderr().is_terminal();
    let mut command = git_base();
    let credentials = match token_env(&mut command, &kind, token.as_deref()) {
        Ok(credentials) => credentials,
        Err(message) => {
            say(&message);
            return Ok(EXIT_USAGE);
        }
    };
    command.arg("clone");
    if show_progress {
        command.arg("--progress");
    }
    command.arg("--filter=blob:none");
    if options.full_history {
        command.arg("--no-single-branch");
    } else {
        command.args(["--depth=1", "--single-branch", "--no-tags"]);
    }
    if let Some(branch) = &options.branch {
        command.args(["--branch", branch]);
    }
    if !options.cones.is_empty() {
        command.arg("--sparse");
    }
    command
        .arg("--")
        .arg(&options.url)
        .arg(&temp)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    say(&format!(
        "Cloning {} into {} with git ({}{}{}, blobs on demand)…",
        options.url,
        target.display(),
        if options.full_history {
            "full history"
        } else {
            "depth 1"
        },
        options
            .branch
            .as_deref()
            .map(|branch| format!(", branch {branch}"))
            .unwrap_or_default(),
        if options.cones.is_empty() {
            String::new()
        } else {
            format!(", sparse cones {}", options.cones.join(" "))
        }
    ));
    debug.log(&format!(
        "git clone{} {} -> {} (temporary {})",
        if options.full_history {
            " --filter=blob:none --no-single-branch"
        } else {
            " --filter=blob:none --depth=1 --single-branch --no-tags"
        },
        options.url,
        target.display(),
        temp.display()
    ));
    let started = Instant::now();
    let leave = |state: &Target| match state {
        Target::Empty => format!("{} is still empty", target.display()),
        _ => format!("nothing was left at {}", target.display()),
    };
    let cleanup = |debug: &mut Debug| {
        if temp.exists() {
            let _ = std::fs::remove_dir_all(&temp);
        }
        debug.log(&format!("removed temporary {}", temp.display()));
    };
    let tail = Arc::new(Mutex::new(Vec::new()));
    let mut child = match spawn_group(&mut command) {
        Ok(child) => child,
        Err(error) => {
            say(&format!("clone: cannot run git: {error}"));
            return Ok(1);
        }
    };
    let pump = child
        .stderr
        .take()
        .map(|stderr| pump_stderr(stderr, show_progress, Arc::clone(&tail)));
    let waited = wait_or_cancel(&mut child, &cancel)?;
    if let Some(pump) = pump {
        let _ = pump.join();
    }
    let lines = tail.lock().map(|lines| lines.clone()).unwrap_or_default();
    for line in &lines {
        debug.log(&format!("git: {line}"));
    }
    match waited {
        Waited::Cancelled => {
            cleanup(debug);
            say(&format!("Clone cancelled; {}.", leave(&state)));
            return Ok(EXIT_CANCELLED);
        }
        Waited::Exited(status) if !status.success() => {
            cleanup(debug);
            let failure = classify(&lines);
            debug.log(&format!("git exited {status}: {failure:?}"));
            let (message, code) = failure_text(&failure, &options.url, options.branch.as_deref());
            say(&format!("{message}\n{}.", capitalize(&leave(&state))));
            return Ok(code);
        }
        Waited::Exited(_) => {}
    }
    if !options.cones.is_empty() {
        say(&format!(
            "Checking out sparse cones: {}…",
            options.cones.join(", ")
        ));
        let mut sparse = git_base();
        sparse
            .arg("-C")
            .arg(&temp)
            .args(["sparse-checkout", "set", "--cone", "--"])
            .args(&options.cones)
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let tail = Arc::new(Mutex::new(Vec::new()));
        let mut child = spawn_group(&mut sparse)?;
        let pump = child
            .stderr
            .take()
            .map(|stderr| pump_stderr(stderr, show_progress, Arc::clone(&tail)));
        let waited = wait_or_cancel(&mut child, &cancel)?;
        if let Some(pump) = pump {
            let _ = pump.join();
        }
        match waited {
            Waited::Cancelled => {
                cleanup(debug);
                say(&format!("Clone cancelled; {}.", leave(&state)));
                return Ok(EXIT_CANCELLED);
            }
            Waited::Exited(status) if !status.success() => {
                cleanup(debug);
                let lines = tail.lock().map(|lines| lines.clone()).unwrap_or_default();
                let (message, code) = failure_text(&classify(&lines), &options.url, None);
                say(&format!("{message}\n{}.", capitalize(&leave(&state))));
                return Ok(code);
            }
            Waited::Exited(_) => {}
        }
    }
    if cancel.load(Ordering::SeqCst) {
        cleanup(debug);
        say(&format!("Clone cancelled; {}.", leave(&state)));
        return Ok(EXIT_CANCELLED);
    }
    // rename(2) onto a missing or empty directory; a directory someone
    // filled meanwhile makes it fail, and nothing of theirs is replaced.
    if let Err(error) = std::fs::rename(&temp, &target) {
        cleanup(debug);
        say(&format!(
            "clone: cannot move the finished clone into {} ({error}); it was removed, and {} was not changed.",
            target.display(),
            target.display()
        ));
        return Ok(EXIT_CONFLICT);
    }
    debug.log(&format!(
        "finished in {:.1}s",
        started.elapsed().as_secs_f64()
    ));
    let summary = summarize(&target, options, credentials, &lines);
    out(&format!("Cloned {} into {}", options.url, target.display()));
    for line in summary.lines {
        out(&line);
    }
    if !options.lifeline {
        out(&format!("Next: cd {} && codsh --rust", target.display()));
    }
    Ok(0)
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// POSIX single-quoting for the remote shell.
pub fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// The remote directory: absolute, or relative to the `--remote` path.
pub fn remote_dir(base: &str, dir: Option<&str>, url: &str) -> Result<String, String> {
    let dir = match dir {
        Some(dir) => dir.to_string(),
        None => humanish(url).ok_or_else(|| {
            "clone: cannot pick a directory name from this URL; pass [DIR]".to_string()
        })?,
    };
    let joined = if dir.starts_with('/') {
        dir
    } else {
        format!("{}/{}", base.trim_end_matches('/'), dir)
    };
    if has_control(&joined)
        || joined
            .split('/')
            .any(|part| part == ".." || part.starts_with('-'))
    {
        return Err(format!(
            "clone: the remote directory {joined:?} must not contain '..', control characters, or parts starting with '-'"
        ));
    }
    let trimmed = joined.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("clone: / cannot be a clone directory".into());
    }
    Ok(trimmed.to_string())
}

/// The command line the remote host runs.
pub fn remote_command(target: &remote::Target, options: &Options, dir: &str) -> String {
    let mut words = vec![LIFELINE_FLAG.to_string()];
    if let Some(branch) = &options.branch {
        words.push("--branch".into());
        words.push(shell_quote(branch));
    }
    for cone in &options.cones {
        words.push("--cone".into());
        words.push(shell_quote(cone));
    }
    if options.full_history {
        words.push("--full-history".into());
    }
    words.push("--".into());
    words.push(shell_quote(&options.url));
    words.push(shell_quote(dir));
    format!("{} clone {}", target.command, words.join(" "))
}

fn run_remote(options: &Options, target: &remote::Target, debug: &mut Debug) -> io::Result<i32> {
    let dir = match remote_dir(&target.path, options.dir.as_deref(), &options.url) {
        Ok(dir) => dir,
        Err(message) => {
            say(&message);
            return Ok(EXIT_USAGE);
        }
    };
    let there = remote::Target {
        path: dir.clone(),
        ..target.clone()
    };
    if std::env::var_os("GROVE_AUTH_TOKEN").is_some() {
        say(
            "codsh: GROVE_AUTH_TOKEN is not sent to the remote host; the clone there uses that host's own git credentials.",
        );
    }
    let command_line = remote_command(target, options, &dir);
    say(&format!(
        "Cloning {} on {} into {} (the remote host's git and credentials; nothing of this machine is forwarded)…",
        options.url,
        target.label(),
        dir
    ));
    debug.log(&format!("ssh {} runs: {command_line}", target.label()));
    let spec = target.spawn_spec(None);
    let mut ssh = Command::new(&spec.program);
    ssh.args(target.ssh_args_for(&command_line))
        .env_clear()
        .envs(spec.env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let cancel = install_cancel(false);
    let mut child = match ssh.spawn() {
        Ok(child) => child,
        Err(error) => {
            say(&format!("clone: cannot start ssh: {error}"));
            return Ok(1);
        }
    };
    // stdin stays open and silent: the remote clone's lifeline.
    let lifeline = child.stdin.take();
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            drop(lifeline);
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) {
                std::thread::sleep(Duration::from_millis(40));
            }
            let _ = child.kill();
            let _ = child.wait();
            say(&format!(
                "Clone cancelled; the connection closed, so the clone on {} stops and removes its partial directory. Rerun the same command to check {dir}: a finished clone is reported, never replaced.",
                target.label()
            ));
            return Ok(EXIT_CANCELLED);
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    drop(lifeline);
    let code = status.code().unwrap_or(1);
    debug.log(&format!("ssh exited {code}"));
    if code == 255 {
        say(&format!(
            "ssh to {} failed or the connection ended (exit 255). A clone that had started there stops and removes its partial directory; rerun to clone, or to confirm a finished clone at {dir}.",
            target.label()
        ));
        return Ok(1);
    }
    if code == 0 {
        out(&format!("Next: codsh --rust --remote {}", there.label()));
    }
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |key| {
            pairs
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn parses_reference_flags_and_refuses_the_leader_socket() {
        let Parsed::Run(options) = parse(&strings(&[
            "-b",
            "dev",
            "--cone",
            "src",
            "--cone=docs",
            "--full-history",
            "--debug",
            "--debug-file",
            "/tmp/x.log",
            "https://example.com/org/repo.git",
            "work",
        ]))
        .unwrap() else {
            panic!("run");
        };
        assert_eq!(options.branch.as_deref(), Some("dev"));
        assert_eq!(options.cones, vec!["src", "docs"]);
        assert!(options.full_history && options.debug);
        assert_eq!(options.dir.as_deref(), Some("work"));
        assert_eq!(parse(&strings(&["--help"])).unwrap(), Parsed::Help);
        assert!(
            parse(&strings(&["--leader-socket", "/x", "u"]))
                .unwrap_err()
                .contains("no Grove daemon")
        );
        assert!(parse(&strings(&[])).is_err());
        assert!(parse(&strings(&["a", "b", "c"])).is_err());
        assert!(parse(&strings(&["--cone", "../up", "u"])).is_err());
        assert!(parse(&strings(&["--cone", "/abs", "u"])).is_err());
        assert!(parse(&strings(&["-b", "--x", "u"])).is_err());
        assert!(parse(&strings(&["--", "-u"])).is_err());
    }

    #[test]
    fn classifies_urls_and_refuses_passwords_and_helpers() {
        assert!(
            matches!(url_kind("https://h/r.git"), Ok(UrlKind::Https { origin }) if origin == "https://h/")
        );
        assert!(matches!(
            url_kind("http://127.0.0.1:9/r"),
            Ok(UrlKind::Http { loopback: true, .. })
        ));
        assert!(matches!(
            url_kind("http://example.com/r"),
            Ok(UrlKind::Http {
                loopback: false,
                ..
            })
        ));
        assert_eq!(url_kind("ssh://git@h:22/r").unwrap(), UrlKind::Ssh);
        assert_eq!(
            url_kind("git@github.com:org/r.git").unwrap(),
            UrlKind::ScpLike
        );
        assert_eq!(url_kind("/srv/r.git").unwrap(), UrlKind::LocalPath);
        assert_eq!(url_kind("file:///srv/r.git").unwrap(), UrlKind::File);
        assert!(
            url_kind("https://u:secret@h/r")
                .unwrap_err()
                .contains("password")
        );
        assert!(url_kind("ext::sh -c evil").is_err());
        assert!(url_kind("-uhttps://h").is_err());
        assert!(url_kind("ftp://h/r").is_err());
    }

    #[test]
    fn picks_the_directory_git_would() {
        assert_eq!(humanish("https://h/org/repo.git").as_deref(), Some("repo"));
        assert_eq!(humanish("git@h:org/repo.git/").as_deref(), Some("repo"));
        assert_eq!(humanish("/srv/repo/.git").as_deref(), Some("repo"));
        assert_eq!(humanish("file:///srv/tools").as_deref(), Some("tools"));
        assert_eq!(humanish("https://h/"), Some("h".into()));
        assert_eq!(humanish("/"), None);
    }

    #[test]
    fn clone_gate_follows_the_reference_order() {
        let none: Option<bool> = None;
        assert_eq!(clone_gate(&env_of(&[]), None, none), (false, "default"));
        assert_eq!(
            clone_gate(&env_of(&[("GROK_CLONE", "1")]), None, none),
            (true, "env GROK_CLONE")
        );
        assert_eq!(
            clone_gate(
                &env_of(&[("GROK_CLONE", "0"), ("GROK_GROVE", "1")]),
                None,
                Some(true)
            ),
            (false, "env GROK_CLONE")
        );
        assert_eq!(
            clone_gate(&env_of(&[("GROVE_CLONE", "on")]), None, none),
            (true, "env GROVE_CLONE")
        );
        assert_eq!(
            clone_gate(&env_of(&[("GROK_GROVE", "all")]), None, none),
            (true, "env GROK_GROVE")
        );
        let cli: toml::Value = toml::from_str("grove = true").unwrap();
        assert_eq!(
            clone_gate(&env_of(&[]), Some(&cli), Some(false)),
            (true, "config [cli] grove")
        );
        // A set GROK_GROVE=false skips [cli] grove; it does not force clone off.
        assert_eq!(
            clone_gate(&env_of(&[("GROK_GROVE", "false")]), Some(&cli), Some(true)),
            (true, "grove config [clone] enabled")
        );
        assert_eq!(
            clone_gate(&env_of(&[]), None, Some(false)),
            (false, "grove config [clone] enabled")
        );
    }

    #[test]
    fn worktree_gate_follows_the_reference_order() {
        assert_eq!(worktree_gate(&env_of(&[]), None), (false, "default"));
        assert_eq!(
            worktree_gate(&env_of(&[("GROK_WORKTREE_TYPE", "grove-fuse")]), None),
            (true, "env GROK_WORKTREE_TYPE")
        );
        let copy: toml::Value = toml::from_str("grove_worktree = \"copy\"\ngrove = true").unwrap();
        assert_eq!(
            worktree_gate(&env_of(&[]), Some(&copy)),
            (false, "config [cli] grove_worktree")
        );
        let alias: toml::Value = toml::from_str("nfs_worktree = true").unwrap();
        assert_eq!(
            worktree_gate(&env_of(&[]), Some(&alias)),
            (true, "config [cli] nfs_worktree")
        );
        let kind: toml::Value = toml::from_str("worktree_type = \"nfs\"").unwrap();
        assert_eq!(
            worktree_gate(&env_of(&[]), Some(&kind)),
            (true, "config [cli] worktree_type")
        );
        let linked: toml::Value = toml::from_str("worktree_type = \"linked\"").unwrap();
        assert_eq!(
            worktree_gate(&env_of(&[]), Some(&linked)),
            (false, "default")
        );
        assert_eq!(
            worktree_gate(&env_of(&[("GROK_GROVE", "1")]), None),
            (true, "env GROK_GROVE")
        );
        // GROK_CLONE does not enable worktrees, and GROK_WORKTREE_TYPE does not enable clone.
        assert_eq!(
            worktree_gate(&env_of(&[("GROK_CLONE", "1")]), None),
            (false, "default")
        );
        assert_eq!(
            clone_gate(&env_of(&[("GROK_WORKTREE_TYPE", "grove")]), None, None),
            (false, "default")
        );
    }

    #[test]
    fn classifies_git_failures_without_the_url() {
        let lines = |text: &[&str]| text.iter().map(|line| line.to_string()).collect::<Vec<_>>();
        assert_eq!(
            classify(&lines(&["fatal: Authentication failed for 'http://h/r/'"])),
            Failure::Credentials
        );
        assert_eq!(
            classify(&lines(&[
                "git@h: Permission denied (publickey).",
                "fatal: Could not read from remote repository."
            ])),
            Failure::Credentials
        );
        assert_eq!(
            classify(&lines(&[
                "Host key verification failed.",
                "fatal: Could not read from remote repository."
            ])),
            Failure::HostKey
        );
        assert_eq!(
            classify(&lines(&["fatal: repository 'http://h/x/' not found"])),
            Failure::NotFound
        );
        assert_eq!(
            classify(&lines(&[
                "fatal: '/srv/x' does not appear to be a git repository"
            ])),
            Failure::NotFound
        );
        assert_eq!(
            classify(&lines(&[
                "warning: Could not find remote branch nope to clone.",
                "fatal: Remote branch nope not found in upstream origin"
            ])),
            Failure::Branch
        );
        assert!(matches!(
            classify(&lines(&[
                "fatal: unable to access 'x': Could not resolve host: h"
            ])),
            Failure::Network(_)
        ));
        let (text, code) = failure_text(&Failure::Credentials, "https://h/r", None);
        assert_eq!(code, EXIT_CREDENTIALS);
        assert!(text.starts_with("Git credentials rejected (unavailable)."));
        assert!(!text.contains("https://h/r"));
        let (text, _) = failure_text(
            &Failure::Other("fatal: bad https://h/r".into()),
            "https://h/r",
            None,
        );
        assert!(!text.contains("https://h/r"));
    }

    #[test]
    fn builds_a_quoted_remote_command_under_the_remote_path() {
        let target = remote::parse_url("ssh://me@h:2222/srv/work").unwrap();
        assert_eq!(
            remote_dir("/srv/work", None, "file:///x/repo.git").unwrap(),
            "/srv/work/repo"
        );
        assert_eq!(
            remote_dir("/srv/work", Some("/abs/dir"), "u").unwrap(),
            "/abs/dir"
        );
        assert!(remote_dir("/srv/work", Some("../up"), "u").is_err());
        let options = Options {
            url: "https://h/it's.git".into(),
            branch: Some("dev".into()),
            cones: vec!["src".into()],
            ..Options::default()
        };
        let line = remote_command(&target, &options, "/srv/work/it's");
        assert_eq!(
            line,
            "codsh --rust clone --codsh-remote-lifeline --branch 'dev' --cone 'src' -- 'https://h/it'\\''s.git' '/srv/work/it'\\''s'"
        );
    }
}
