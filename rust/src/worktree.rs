//! Local git worktrees for sessions and subagents (ticket 174).
//!
//! `packages/cli/bin/rust-worktree.mjs` is the one implementation: this
//! client runs it for `-w/--worktree`, `codsh --rust worktree ...`, and
//! `/worktree`, and the dsh subagent plugin imports it for
//! `isolation: "worktree"`. The pool is `$GROK_HOME/worktrees`; dsh receives
//! it as `CODSH_WORKTREE_HOME`.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// `-w [NAME]` and `--worktree-ref/--ref <REF>` from the command line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorktreeFlags {
    /// `Some("")` for a bare `-w`.
    pub name: Option<String>,
    pub reference: Option<String>,
}

impl WorktreeFlags {
    pub fn requested(&self) -> bool {
        self.name.is_some()
    }
}

/// The worktree this process started in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Created {
    pub id: String,
    pub path: PathBuf,
    pub branch: String,
    pub source_root: PathBuf,
    pub session_cwd: PathBuf,
    pub reference: Option<String>,
    pub carried: usize,
    /// The Grove gate asked for a projected worktree (ticket 191): the
    /// setting that asked. This client has no Grove backend, so the
    /// worktree is still a plain git worktree, and the notice says so.
    pub grove: Option<String>,
}

static ACTIVE: OnceLock<Created> = OnceLock::new();

pub fn helper_path() -> PathBuf {
    if let Some(path) = std::env::var_os("CODSH_WORKTREE") {
        return PathBuf::from(path);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../packages/cli/bin/rust-worktree.mjs")
}

pub fn pool(grok_home: &Path) -> PathBuf {
    grok_home.join("worktrees")
}

/// `$GROK_HOME` before config is loaded: the same rule config uses.
pub fn early_grok_home() -> PathBuf {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    crate::config::grok_home_from(&home, std::env::var("GROK_HOME").ok().as_deref())
}

/// Environment for the dsh child, so subagent isolation uses the same pool
/// and records the same Grove request.
pub fn dsh_env(grok_home: &Path) -> Vec<(String, String)> {
    let mut env = vec![(
        "CODSH_WORKTREE_HOME".into(),
        pool(grok_home).to_string_lossy().into_owned(),
    )];
    if let Some(source) = crate::clone::worktree_grove_request(grok_home) {
        env.push(("CODSH_WORKTREE_GROVE".into(), source.into()));
    }
    env
}

/// The notice line for a Grove request that fell back to git.
pub fn grove_fallback(source: &str) -> String {
    format!(
        "Grove was requested ({source}); this client has no Grove backend, so this is a plain git worktree with a full checkout on disk"
    )
}

fn command(pool: &Path) -> Command {
    let node = std::env::var_os("CODSH_NODE").unwrap_or_else(|| "node".into());
    let mut command = Command::new(node);
    command
        .arg(helper_path())
        .env("CODSH_WORKTREE_HOME", pool)
        .env_remove("CODSH_WORKTREE_GROVE")
        .stdin(Stdio::null());
    command
}

/// Run a machine command (`create`, `attach`, `resolve`); the last stdout
/// line is one JSON object with `ok`.
fn machine(pool: &Path, cwd: Option<&Path>, args: &[&str]) -> Result<Value, String> {
    let mut command = command(pool);
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command
        .output()
        .map_err(|error| format!("cannot run the worktree helper: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: Value =
        serde_json::from_str(stdout.lines().last().unwrap_or("{}")).unwrap_or(Value::Null);
    if output.status.success() && value.get("ok") == Some(&Value::Bool(true)) {
        return Ok(value);
    }
    let message = value
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_string());
    Err(if message.is_empty() {
        "the worktree helper failed".into()
    } else {
        message
    })
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

pub fn parse_created(value: &Value) -> Option<Created> {
    let id = text(value, "id");
    let path = text(value, "path");
    if id.is_empty() || path.is_empty() {
        return None;
    }
    let session_cwd = text(value, "sessionCwd");
    Some(Created {
        id,
        path: PathBuf::from(&path),
        branch: text(value, "branch"),
        source_root: PathBuf::from(text(value, "sourceRoot")),
        session_cwd: PathBuf::from(if session_cwd.is_empty() {
            path
        } else {
            session_cwd
        }),
        reference: value.get("ref").and_then(Value::as_str).map(str::to_string),
        carried: value
            .get("carried")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0),
        grove: value
            .get("grove")
            .and_then(|grove| grove.get("source"))
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Create a session worktree from `source` (the directory the user is in).
pub fn create(
    pool: &Path,
    source: &Path,
    flags: &WorktreeFlags,
    grove: Option<&str>,
) -> Result<Created, String> {
    let source = source.to_string_lossy().into_owned();
    let pid = std::process::id().to_string();
    let mut args = vec![
        "create",
        "--source",
        source.as_str(),
        "--type",
        "session",
        "--pid",
        pid.as_str(),
    ];
    if let Some(name) = flags.name.as_deref().filter(|name| !name.is_empty()) {
        args.extend(["--label", name]);
    }
    if let Some(reference) = flags.reference.as_deref() {
        args.extend(["--ref", reference]);
    }
    if let Some(grove) = grove {
        args.extend(["--grove", grove]);
    }
    let value = machine(pool, None, &args)?;
    parse_created(&value).ok_or_else(|| "the worktree helper returned no worktree".into())
}

/// Record the session that owns the worktree and this process id.
pub fn attach(pool: &Path, id: &str, session_id: &str) -> Result<(), String> {
    let pid = std::process::id().to_string();
    machine(
        pool,
        None,
        &["attach", id, "--session", session_id, "--pid", pid.as_str()],
    )
    .map(|_| ())
}

/// Remove a worktree this process just created and never used (a failed
/// `-w -r` fork). The helper still refuses it if it holds any work.
pub fn discard(pool: &Path, id: &str) {
    let _ = command(pool)
        .args(["rm", id])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub fn set_active(created: Created) {
    let _ = ACTIVE.set(created);
}

pub fn active() -> Option<&'static Created> {
    ACTIVE.get()
}

/// The status-line segment for a worktree session.
pub fn status_segment() -> Option<String> {
    active().map(|created| format!("worktree {} ({})", created.id, created.branch))
}

/// The notice shown when a worktree session starts.
pub fn start_notice(created: &Created) -> String {
    let base = match (&created.reference, created.carried) {
        (Some(reference), _) => format!("clean checkout of {reference}"),
        (None, 0) => "clean checkout of HEAD".to_string(),
        (None, count) => format!("HEAD plus {count} uncommitted path(s) from the checkout"),
    };
    let grove = created
        .grove
        .as_deref()
        .map(|source| format!(" {}.", grove_fallback(source)))
        .unwrap_or_default();
    format!(
        "Worktree {id}: working in {cwd} on branch {branch} ({base}); {source} is not changed. /worktree apply {id} copies the changes back; /worktree rm {id} removes it.{grove}",
        id = created.id,
        cwd = created.session_cwd.display(),
        branch = created.branch,
        source = created.source_root.display(),
    )
}

/// The one-line TUI hint; `/worktree show <id>` prints the full paths.
pub fn short_notice(created: &Created) -> String {
    let base = match (&created.reference, created.carried) {
        (Some(reference), _) => format!("from {reference}"),
        (None, 0) => "from HEAD".to_string(),
        (None, count) => format!("HEAD + {count} uncommitted path(s)"),
    };
    let grove = if created.grove.is_some() {
        "; Grove requested, plain git worktree used"
    } else {
        ""
    };
    format!(
        "Worktree {id} ({base}{grove}); the checkout is not changed. /worktree show {id} · /worktree apply {id}",
        id = created.id,
    )
}

/// `codsh --rust worktree ...`: the helper prints to this terminal.
pub fn run_cli(pool: &Path, args: &[String]) -> std::io::Result<i32> {
    let mut command = command(pool);
    command
        .args(args)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let status = command.status().map_err(|error| {
        std::io::Error::other(format!("cannot run the worktree helper: {error}"))
    })?;
    Ok(status.code().unwrap_or(1))
}

/// Subcommands `/worktree` and `codsh --rust worktree` accept. The helper's
/// internal create/attach/resolve stay private to this client.
pub fn public_command(first: Option<&str>) -> bool {
    matches!(
        first,
        None | Some(
            "list"
                | "ls"
                | "show"
                | "apply"
                | "rm"
                | "gc"
                | "prune"
                | "db"
                | "detach"
                | "salvage"
                | "clean-artifacts"
                | "help"
                | "-h"
                | "--help"
        )
    )
}

pub const SLASH_USAGE: &str = "usage: /worktree [list|show <id>|apply <id> [--overwrite] [--dry-run]|rm <id> [-f]|gc [--max-age 7d] [--dry-run]]";

/// `/worktree ...` inside a session: run the helper and return its text.
pub fn slash(pool: &Path, cwd: &Path, text: &str) -> Result<String, String> {
    let words: Vec<String> = text
        .split_whitespace()
        .skip(1)
        .map(str::to_string)
        .collect();
    if !public_command(words.first().map(String::as_str)) {
        return Err(SLASH_USAGE.into());
    }
    // Removing the directory this process runs in would strand the session.
    if words.first().map(String::as_str) == Some("rm")
        && let Some(created) = active()
        && words.iter().skip(1).any(|word| {
            word == &created.id
                || Path::new(word) == created.path
                || Path::new(word) == created.session_cwd
        })
    {
        return Err(format!(
            "worktree {} is the one this session runs in; quit the session, then run codsh --rust worktree rm {}",
            created.id, created.id
        ));
    }
    let words = if words.is_empty() {
        vec!["list".to_string()]
    } else {
        words
    };
    let output = command(pool)
        .args(&words)
        .current_dir(cwd)
        .output()
        .map_err(|error| format!("cannot run the worktree helper: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stderr = stderr
        .strip_prefix("codsh: ")
        .unwrap_or(&stderr)
        .to_string();
    match output.status.code() {
        Some(0) => Ok(stdout),
        // apply with conflicts exits 5 and still prints what it did.
        Some(5) if !stdout.is_empty() => Err(stdout),
        _ => Err(if stderr.is_empty() { stdout } else { stderr }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_the_helper_record() {
        let created = parse_created(&json!({
            "ok": true,
            "id": "fix-bug",
            "path": "/pool/repo/fix-bug",
            "branch": "codsh/fix-bug",
            "sourceRoot": "/src/repo",
            "sessionCwd": "/pool/repo/fix-bug/sub",
            "ref": null,
            "carried": ["a", "b"],
        }))
        .expect("record");
        assert_eq!(created.session_cwd, PathBuf::from("/pool/repo/fix-bug/sub"));
        assert_eq!(created.carried, 2);
        assert_eq!(created.reference, None);
        let notice = start_notice(&created);
        assert!(notice.contains("working in /pool/repo/fix-bug/sub on branch codsh/fix-bug"));
        assert!(notice.contains("HEAD plus 2 uncommitted path(s)"));
        assert!(notice.contains("/src/repo is not changed"));
        assert!(notice.contains("/worktree apply fix-bug"));
        assert_eq!(
            short_notice(&created),
            "Worktree fix-bug (HEAD + 2 uncommitted path(s)); the checkout is not changed. /worktree show fix-bug · /worktree apply fix-bug"
        );
        assert!(parse_created(&json!({"ok": true})).is_none());
        let grove = parse_created(&json!({
            "ok": true, "id": "g", "path": "/p/g", "branch": "codsh/g",
            "sourceRoot": "/src", "grove": {"requested": true, "source": "env GROK_WORKTREE_TYPE"},
        }))
        .expect("record");
        assert_eq!(grove.grove.as_deref(), Some("env GROK_WORKTREE_TYPE"));
        assert!(start_notice(&grove).contains(
            "Grove was requested (env GROK_WORKTREE_TYPE); this client has no Grove backend, so this is a plain git worktree"
        ));
        assert!(short_notice(&grove).contains("Grove requested, plain git worktree used"));
    }

    #[test]
    fn only_public_subcommands_pass() {
        assert!(public_command(None));
        assert!(public_command(Some("apply")));
        assert!(public_command(Some("ls")));
        assert!(!public_command(Some("create")));
        assert!(!public_command(Some("attach")));
        assert!(!public_command(Some("resolve")));
    }

    #[test]
    fn the_pool_lives_under_grok_home() {
        assert_eq!(
            pool(Path::new("/h/.grok")),
            PathBuf::from("/h/.grok/worktrees")
        );
        assert_eq!(
            dsh_env(Path::new("/nonexistent-codsh-home/.grok"))[0],
            (
                "CODSH_WORKTREE_HOME".to_string(),
                "/nonexistent-codsh-home/.grok/worktrees".to_string()
            )
        );
    }
}
