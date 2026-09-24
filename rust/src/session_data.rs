//! Session export, share, deletion, and isolated-home disk usage.
//!
//! Export writes a readable Markdown transcript of one selected session.
//! Share posts only after an explicit command and only to a configured
//! substitute. Delete removes one idle session directory outside the dsh
//! persistence seam, which has no deletion API. A live write lock is refused
//! instead of breaking the store.

use crate::privacy;
use crate::session_catalog::{self, Catalog};
use crate::session_owner;
use serde::Serialize;
use serde_json::{Value, json};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const REDACTION_NOTE: &str = "Export is a readable copy of the stored conversation. It is not a claim that secrets were removed.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataError {
    pub message: String,
}

impl std::fmt::Display for DataError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl DataError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportTarget {
    Stdout,
    Clipboard,
    File(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportRequest {
    pub session_id: String,
    pub target: ExportTarget,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportOutcome {
    pub markdown: String,
    pub message: String,
    pub wrote_file: Option<PathBuf>,
    pub clipboard: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareRequest {
    pub session_id: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareOutcome {
    pub url: String,
    pub posted: bool,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteRequest {
    pub session_id: String,
    pub confirmed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteOutcome {
    pub removed: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirUsage {
    pub name: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiskReport {
    pub schema_version: u32,
    pub home: String,
    pub total_bytes: u64,
    pub top_level_dirs: Vec<DirUsage>,
    pub root_files_bytes: u64,
    pub unreadable_dirs: u64,
    pub note: String,
}

pub fn parse_export(flags: &[&str]) -> io::Result<ExportRequest> {
    if flags.iter().any(|flag| *flag == "--help" || *flag == "-h") {
        return Err(io::Error::other(export_help()));
    }
    let mut clipboard = false;
    let mut positional = Vec::new();
    for flag in flags {
        match *flag {
            "-c" | "--clipboard" => clipboard = true,
            "--debug" | "--debug-file" | "--leader-socket" => {
                return Err(io::Error::other(format!(
                    "unsupported export flag {flag}; dsh owns execution. Omit it."
                )));
            }
            other if other.starts_with('-') => {
                return Err(io::Error::other(format!(
                    "unsupported export flag {other}; use codsh --rust export --help"
                )));
            }
            other => positional.push(other),
        }
    }
    let Some(session_id) = positional.first().copied() else {
        return Err(io::Error::other(
            "missing session id; use codsh --rust export <SESSION_ID> [OUTPUT]",
        ));
    };
    if !session_catalog::is_uuid(session_id) {
        return Err(io::Error::other(format!(
            "export requires a session id, not a title: {session_id}"
        )));
    }
    let target = if clipboard {
        if positional.len() > 1 {
            return Err(io::Error::other(
                "export --clipboard writes the clipboard, not a file",
            ));
        }
        ExportTarget::Clipboard
    } else if let Some(path) = positional.get(1) {
        ExportTarget::File(PathBuf::from(path))
    } else if positional.len() > 2 {
        return Err(io::Error::other(
            "export accepts one session id and an optional output path",
        ));
    } else {
        ExportTarget::Stdout
    };
    Ok(ExportRequest {
        session_id: session_id.to_string(),
        target,
    })
}

pub fn export_help() -> &'static str {
    "Export a session transcript as Markdown\n\n\
Usage: codsh --rust export [OPTIONS] <SESSION_ID> [OUTPUT]\n\n\
Arguments:\n  \
<SESSION_ID>  Session id to export\n  \
[OUTPUT]      Output file path (default: stdout)\n\n\
Options:\n  \
-c, --clipboard             Copy to clipboard instead of writing to stdout\n  \
-h, --help                  Print help\n\n\
The transcript keeps user text, assistant text, tool names, tool results, and attachment paths that the session log already stores. It does not claim those values were redacted. --debug, --debug-file, and --leader-socket are unused; dsh owns execution."
}

pub fn parse_share(flags: &[&str]) -> io::Result<ShareRequest> {
    if flags.iter().any(|flag| *flag == "--help" || *flag == "-h") {
        return Err(io::Error::other(share_help()));
    }
    let mut url = None;
    let mut positional = Vec::new();
    let mut index = 0;
    while index < flags.len() {
        let flag = flags[index];
        if flag == "--url" {
            index += 1;
            let value = flags.get(index).copied().ok_or_else(|| {
                io::Error::other("missing --url value; set the substitute share service")
            })?;
            url = Some(value.to_string());
        } else if let Some(value) = flag.strip_prefix("--url=") {
            if value.is_empty() {
                return Err(io::Error::other("missing --url value"));
            }
            url = Some(value.to_string());
        } else if flag.starts_with('-') {
            return Err(io::Error::other(format!(
                "unsupported share flag {flag}; use codsh --rust share --help"
            )));
        } else {
            positional.push(flag);
        }
        index += 1;
    }
    let Some(session_id) = positional.first().copied() else {
        return Err(io::Error::other(
            "missing session id; use codsh --rust share <SESSION_ID>",
        ));
    };
    if positional.len() != 1 || !session_catalog::is_uuid(session_id) {
        return Err(io::Error::other(format!(
            "share requires one session id: {}",
            positional.join(" ")
        )));
    }
    Ok(ShareRequest {
        session_id: session_id.to_string(),
        url,
    })
}

pub fn share_help() -> &'static str {
    "Share a session and print the share URL\n\n\
Usage: codsh --rust share [OPTIONS] <SESSION_ID>\n\n\
Arguments:\n  \
<SESSION_ID>  Session id to share\n\n\
Options:\n      \
--url <URL>             Substitute share service. Also endpoints.share_url or CODSH_SHARE_URL.\n  \
-h, --help              Print help\n\n\
Sharing is off unless this command is explicit and a substitute service is configured. Official grok.com, api.x.ai, and sentry hosts are refused. A missing service is an error, not a local success URL."
}

pub fn parse_delete(flags: &[&str]) -> io::Result<DeleteRequest> {
    if flags.iter().any(|flag| *flag == "--help" || *flag == "-h") {
        return Err(io::Error::other(delete_help()));
    }
    let mut confirmed = false;
    let mut positional = Vec::new();
    for flag in flags {
        match *flag {
            "--yes" | "-y" => confirmed = true,
            other if other.starts_with('-') => {
                return Err(io::Error::other(format!(
                    "unsupported sessions delete flag {other}; use codsh --rust sessions delete --help"
                )));
            }
            other => positional.push(other),
        }
    }
    let Some(session_id) = positional.first().copied() else {
        return Err(io::Error::other(
            "missing session id; use codsh --rust sessions delete <ID> --yes",
        ));
    };
    if positional.len() != 1 || !session_catalog::is_uuid(session_id) {
        return Err(io::Error::other("sessions delete requires one session id"));
    }
    Ok(DeleteRequest {
        session_id: session_id.to_string(),
        confirmed,
    })
}

pub fn delete_help() -> &'static str {
    "Permanently delete a session from history\n\n\
Usage: codsh --rust sessions delete [OPTIONS] <ID>\n\n\
Arguments:\n  \
<ID>  Session id to delete\n\n\
Options:\n      \
--yes, -y               Confirm deletion. Without it, nothing is removed.\n  \
-h, --help              Print help\n\n\
Deletes only that session directory and its codsh sidecars. Other sessions stay. A live write lock is refused. dsh persistence has no deletion API, so this removes the session directory only after the lock probe succeeds. It does not truncate a live log."
}

pub fn disk_help() -> &'static str {
    "Show what the isolated codsh home uses on disk\n\n\
Usage: codsh --rust du [OPTIONS]\n       codsh --rust disk-usage [OPTIONS]\n\n\
Options:\n      \
--json                  Emit machine-readable JSON output\n  \
-h, --help              Print help\n\n\
Lists top-level directories under $GROK_HOME, largest first, plus the isolated dsh sessions directory when it is outside that home. Worktree pools and Grove redirections are not measured here. A directory that cannot be read is counted in unreadable_dirs and is not deleted."
}

pub fn export_session(
    dsh_home: &Path,
    cwd: &Path,
    request: &ExportRequest,
    out: &mut dyn Write,
) -> Result<ExportOutcome, DataError> {
    let catalog = session_catalog::load_catalog(dsh_home, cwd);
    let session = find_session(&catalog, &request.session_id)?;
    let markdown = render_markdown(dsh_home, session)?;
    if markdown.trim().is_empty() {
        return Err(DataError::new(format!(
            "Session '{}' has no conversation content to export",
            request.session_id
        )));
    }
    match &request.target {
        ExportTarget::Stdout => {
            writeln!(out, "{markdown}").map_err(|error| DataError::new(error.to_string()))?;
            Ok(ExportOutcome {
                markdown,
                message: format!("exported {} to stdout", request.session_id),
                wrote_file: None,
                clipboard: false,
            })
        }
        ExportTarget::Clipboard => {
            copy_text(&markdown)?;
            let lines = markdown.lines().count();
            let message = format!(
                "Conversation copied to clipboard ({} chars, {} lines). {REDACTION_NOTE}",
                markdown.len(),
                lines
            );
            writeln!(out, "{message}").map_err(|error| DataError::new(error.to_string()))?;
            Ok(ExportOutcome {
                markdown,
                message,
                wrote_file: None,
                clipboard: true,
            })
        }
        ExportTarget::File(path) => {
            let expanded = expand_tilde(path);
            if let Some(parent) = expanded.parent()
                && !parent.as_os_str().is_empty()
            {
                fs::create_dir_all(parent).map_err(|error| {
                    DataError::new(format!("Failed to create {}: {error}", parent.display()))
                })?;
            }
            fs::write(&expanded, markdown.as_bytes()).map_err(|error| {
                DataError::new(format!("Failed to write {}: {error}", expanded.display()))
            })?;
            let message = format!(
                "Conversation exported to {} ({})",
                expanded.display(),
                REDACTION_NOTE
            );
            writeln!(out, "{message}").map_err(|error| DataError::new(error.to_string()))?;
            Ok(ExportOutcome {
                markdown,
                message,
                wrote_file: Some(expanded),
                clipboard: false,
            })
        }
    }
}

pub fn share_session(
    dsh_home: &Path,
    cwd: &Path,
    request: &ShareRequest,
) -> Result<ShareOutcome, DataError> {
    let catalog = session_catalog::load_catalog(dsh_home, cwd);
    let session = find_session(&catalog, &request.session_id)?;
    let Some(url) = request
        .url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
    else {
        return Err(DataError::new(
            "No share service configured. Set endpoints.share_url, CODSH_SHARE_URL, or share --url. Nothing was uploaded.",
        ));
    };
    if privacy::is_official_endpoint(url) {
        return Err(DataError::new(
            "Official share hosts are refused. Configure a substitute endpoints.share_url. Nothing was uploaded.",
        ));
    }
    let markdown = render_markdown(dsh_home, session)?;
    let body = serde_json::to_string(&json!({
        "schema_version": 1,
        "session_id": session.id,
        "title": session.display_title(),
        "cwd": session.cwd,
        "markdown": markdown,
        "redaction": "not claimed",
    }))
    .map_err(|error| DataError::new(error.to_string()))?;
    let response = ureq::post(url)
        .set("content-type", "application/json")
        .set("user-agent", "codsh-rust-share")
        .send_bytes(body.as_bytes())
        .map_err(|error| match error {
            ureq::Error::Status(code, _) => DataError::new(format!(
                "share service returned HTTP {code}; local session unchanged"
            )),
            other => DataError::new(format!(
                "share service was not reached ({other}); local session unchanged"
            )),
        })?;
    let status = response.status();
    if !(200..300).contains(&status) {
        return Err(DataError::new(format!(
            "share service returned HTTP {status}; local session unchanged"
        )));
    }
    let returned = response.into_string().unwrap_or_default();
    let share_url = serde_json::from_str::<Value>(&returned)
        .ok()
        .and_then(|value| {
            value
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            DataError::new(
                "share service did not return a url; local session unchanged and no success is claimed",
            )
        })?;
    if privacy::is_official_endpoint(&share_url) {
        return Err(DataError::new(
            "share service returned an official host; that URL is not treated as success",
        ));
    }
    Ok(ShareOutcome {
        url: share_url,
        posted: true,
        body,
    })
}

pub fn delete_session(
    dsh_home: &Path,
    cwd: &Path,
    request: &DeleteRequest,
) -> Result<DeleteOutcome, DataError> {
    if !request.confirmed {
        return Err(DataError::new(format!(
            "delete cancelled: confirm with --yes to remove {}",
            request.session_id
        )));
    }
    let catalog = session_catalog::load_catalog(dsh_home, cwd);
    let session = find_session(&catalog, &request.session_id)?;
    if session.foreign.is_some() {
        return Err(DataError::new(
            "refusing to delete a foreign vendor session from this command",
        ));
    }
    if let Some(pid) = session_owner::occupied_holder(dsh_home, &session.id) {
        return Err(DataError::new(format!(
            "refusing to delete session {}: write owner pid {pid} still holds it",
            session.id
        )));
    }
    let dir = session_directory(dsh_home, session)?;
    if !dir.is_dir() {
        return Err(DataError::new(format!(
            "session directory is missing: {}",
            dir.display()
        )));
    }
    let canonical = dir.canonicalize().unwrap_or(dir.clone());
    let sessions_root = dsh_home.join("sessions");
    let root_canonical = sessions_root
        .canonicalize()
        .unwrap_or(sessions_root.clone());
    if !canonical.starts_with(&root_canonical) {
        return Err(DataError::new(format!(
            "refusing to delete {} because it is outside {}",
            canonical.display(),
            root_canonical.display()
        )));
    }
    fs::remove_dir_all(&canonical).map_err(|error| {
        DataError::new(format!(
            "cannot remove {}: {error}. dsh has no deletion API; the log was left in place",
            canonical.display()
        ))
    })?;
    forget_sidecar(dsh_home, &session.id)?;
    Ok(DeleteOutcome {
        removed: canonical,
        message: format!(
            "deleted session {} and its session directory; other sessions were not changed",
            session.id
        ),
    })
}

pub fn collect_disk(grok_home: &Path, dsh_home: &Path) -> Result<DiskReport, DataError> {
    let mut dirs = Vec::new();
    let mut root_files_bytes = 0u64;
    let mut unreadable = 0u64;
    if grok_home.is_dir() {
        let entries = fs::read_dir(grok_home).map_err(|error| {
            DataError::new(format!("cannot read {}: {error}", grok_home.display()))
        })?;
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    unreadable += 1;
                    continue;
                }
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let meta = match fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(_) => {
                    unreadable += 1;
                    continue;
                }
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                match dir_size(&path) {
                    Ok(bytes) => dirs.push(DirUsage { name, bytes }),
                    Err(_) => unreadable += 1,
                }
            } else if meta.is_file() {
                root_files_bytes = root_files_bytes.saturating_add(meta.len());
            }
        }
    }
    let sessions = dsh_home.join("sessions");
    if sessions.is_dir() && !sessions.starts_with(grok_home) {
        match dir_size(&sessions) {
            Ok(bytes) => dirs.push(DirUsage {
                name: "dsh-sessions".into(),
                bytes,
            }),
            Err(_) => unreadable += 1,
        }
    }
    dirs.sort_by(|left, right| {
        right
            .bytes
            .cmp(&left.bytes)
            .then_with(|| left.name.cmp(&right.name))
    });
    let total_bytes = dirs.iter().fold(root_files_bytes, |total, dir| {
        total.saturating_add(dir.bytes)
    });
    Ok(DiskReport {
        schema_version: 1,
        home: grok_home.display().to_string(),
        total_bytes,
        top_level_dirs: dirs,
        root_files_bytes,
        unreadable_dirs: unreadable,
        note: "Sizes are logical file lengths for this isolated home. Worktree clones, Grove jails, and other filesystems are not included. This report does not delete anything.".into(),
    })
}

pub fn format_disk(report: &DiskReport) -> String {
    let mut lines = vec![format!("Disk usage for {}", report.home)];
    for dir in &report.top_level_dirs {
        lines.push(format!("  {:>10}  {}", format_bytes(dir.bytes), dir.name));
    }
    if report.root_files_bytes > 0 {
        lines.push(format!(
            "  {:>10}  (top-level files)",
            format_bytes(report.root_files_bytes)
        ));
    }
    lines.push(format!("  {:>10}  total", format_bytes(report.total_bytes)));
    if report.unreadable_dirs > 0 {
        lines.push(format!(
            "unreadable directories: {}",
            report.unreadable_dirs
        ));
    }
    lines.push(report.note.clone());
    lines.join("\n")
}

fn find_session<'a>(
    catalog: &'a Catalog,
    id: &str,
) -> Result<&'a session_catalog::SessionRecord, DataError> {
    catalog
        .sessions
        .iter()
        .find(|session| session.id == id)
        .ok_or_else(|| DataError::new(format!("Session '{id}' not found.")))
}

fn session_directory(
    dsh_home: &Path,
    session: &session_catalog::SessionRecord,
) -> Result<PathBuf, DataError> {
    // dsh percent-encodes the session directory (hyphens become ~002D) and
    // the catalog only stores the raw id. Walk the log headers instead of
    // reconstructing that path.
    let root = dsh_home.join("sessions");
    if let Some(dir) = find_session_dir(&root, &session.id) {
        return Ok(dir);
    }
    Err(DataError::new(format!(
        "session directory for {} was not found under {}",
        session.id,
        root.display()
    )))
}

fn find_session_dir(dir: &Path, session_id: &str) -> Option<PathBuf> {
    let log = newest_log(dir);
    if let Some(log) = log.as_ref()
        && log_session_id(log).as_deref() == Some(session_id)
    {
        return Some(dir.to_path_buf());
    }
    if log.is_some() {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir()
            && let Some(found) = find_session_dir(&path, session_id)
        {
            return Some(found);
        }
    }
    None
}

fn log_session_id(log: &Path) -> Option<String> {
    let text = read_log_text(log).ok()?;
    let header = text.lines().find(|line| !line.trim().is_empty())?;
    let value: Value = serde_json::from_str(header).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    value.get("id").and_then(Value::as_str).map(str::to_string)
}

fn read_log_text(log: &Path) -> Result<String, DataError> {
    let bytes = fs::read(log).map_err(|error| {
        DataError::new(format!("unreadable session log {}: {error}", log.display()))
    })?;
    let plain = if log.extension().and_then(|ext| ext.to_str()) == Some("zstd") {
        zstd::decode_all(bytes.as_slice()).map_err(|error| {
            DataError::new(format!("unreadable session log {}: {error}", log.display()))
        })?
    } else {
        bytes
    };
    String::from_utf8(plain).map_err(|error| {
        DataError::new(format!("unreadable session log {}: {error}", log.display()))
    })
}

fn render_markdown(
    dsh_home: &Path,
    session: &session_catalog::SessionRecord,
) -> Result<String, DataError> {
    let dir = session_directory(dsh_home, session)?;
    let log = newest_log(&dir).ok_or_else(|| {
        DataError::new(format!(
            "Session '{}' log missing in {}",
            session.id,
            dir.display()
        ))
    })?;
    let text = read_log_text(&log)?;
    let mut sections = Vec::new();
    sections.push(format!("# {}", session.display_title()));
    sections.push(format!(
        "Session: `{}`\nDirectory: `{}`\n\n{REDACTION_NOTE}",
        session.id, session.cwd
    ));
    let mut saw_content = false;
    for line in text.lines().filter(|line| !line.trim().is_empty()).skip(1) {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            sections.push(format!("## unreadable record\n\n{line}"));
            saw_content = true;
            continue;
        };
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "user/message" => {
                if is_plugin_snapshot(&event) {
                    continue;
                }
                let body = message_text(&event);
                let attachments = attachment_lines(&event);
                if body.trim().is_empty() && attachments.is_empty() {
                    continue;
                }
                saw_content = true;
                let mut block = format!("## User\n\n{body}");
                if !attachments.is_empty() {
                    block.push_str("\n\nAttachments:\n");
                    block.push_str(&attachments);
                }
                sections.push(block);
            }
            "assistant/message" => {
                let body = message_text(&event);
                if body.trim().is_empty() {
                    continue;
                }
                saw_content = true;
                sections.push(format!("## Assistant\n\n{body}"));
            }
            "tool/call" => {
                saw_content = true;
                let data = event.get("data").cloned().unwrap_or(Value::Null);
                let name = data.get("name").and_then(Value::as_str).unwrap_or("tool");
                let id = data
                    .get("callId")
                    .or_else(|| data.get("toolCallId"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let arguments = data.get("arguments").and_then(Value::as_str).unwrap_or("");
                sections.push(format!(
                    "## Tool {name}\n\nCall: `{id}`\n\n```json\n{arguments}\n```"
                ));
            }
            "tool/result" => {
                saw_content = true;
                let data = event.get("data").cloned().unwrap_or(Value::Null);
                let message = data.get("message").cloned().unwrap_or(Value::Null);
                let id = message
                    .get("toolCallId")
                    .or_else(|| message.get("callId"))
                    .or_else(|| data.get("callId"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let body = message_text(&event);
                sections.push(format!("## Tool result `{id}`\n\n{body}"));
            }
            _ => {}
        }
    }
    if !saw_content {
        return Ok(String::new());
    }
    Ok(sections.join("\n\n"))
}

fn is_plugin_snapshot(event: &Value) -> bool {
    event
        .get("data")
        .and_then(|data| data.get("source"))
        .and_then(|source| source.get("kind"))
        .and_then(Value::as_str)
        == Some("plugin")
}

fn message_text(event: &Value) -> String {
    let message = event
        .get("data")
        .and_then(|data| data.get("message"))
        .or_else(|| event.get("data"));
    let Some(content) = message
        .and_then(|value| value.get("content"))
        .and_then(Value::as_array)
    else {
        return String::new();
    };
    let mut parts = Vec::new();
    for block in content {
        let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(kind, "text" | "reasoning")
            && let Some(text) = block.get("text").and_then(Value::as_str)
        {
            parts.push(text.to_string());
        }
    }
    parts.join("")
}

fn attachment_lines(event: &Value) -> String {
    let message = event
        .get("data")
        .and_then(|data| data.get("message"))
        .or_else(|| event.get("data"));
    let Some(content) = message
        .and_then(|value| value.get("content"))
        .and_then(Value::as_array)
    else {
        return String::new();
    };
    let mut lines = Vec::new();
    for block in content {
        let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "resource_link" || kind == "image" || kind == "file" {
            let path = block
                .get("uri")
                .or_else(|| block.get("path"))
                .or_else(|| block.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("(unnamed)");
            lines.push(format!("- {kind}: {path}"));
        }
    }
    lines.join("\n")
}

fn newest_log(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(u64, PathBuf)> = None;
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(stem) = name
            .strip_suffix(".jsonl")
            .or_else(|| name.strip_suffix(".jsonl.zstd"))
        else {
            continue;
        };
        let version = if stem == "session" {
            0
        } else if let Some(raw) = stem.strip_prefix("session.v") {
            if raw.starts_with('0') || raw.is_empty() {
                continue;
            }
            let Ok(parsed) = raw.parse() else {
                continue;
            };
            parsed
        } else {
            continue;
        };
        if best.as_ref().is_none_or(|(current, _)| version >= *current) {
            best = Some((version, entry.path()));
        }
    }
    best.map(|(_, path)| path)
}

fn forget_sidecar(dsh_home: &Path, session_id: &str) -> Result<(), DataError> {
    for path in [
        session_catalog::titles_path(dsh_home),
        session_catalog::activity_path(dsh_home),
    ] {
        if !path.is_file() {
            continue;
        }
        let text = fs::read_to_string(&path).map_err(|error| DataError::new(error.to_string()))?;
        let mut map: serde_json::Map<String, Value> =
            serde_json::from_str(&text).unwrap_or_default();
        map.remove(session_id);
        let body = serde_json::to_string_pretty(&map).unwrap_or_else(|_| "{}".into());
        fs::write(&path, format!("{body}\n")).map_err(|error| DataError::new(error.to_string()))?;
    }
    Ok(())
}

fn expand_tilde(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix("~/")
        && let Some(home) = std::env::var_os("HOME")
    {
        return PathBuf::from(home).join(rest);
    }
    path.to_path_buf()
}

fn copy_text(text: &str) -> Result<(), DataError> {
    let mut child = std::process::Command::new("pbcopy");
    child
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut process = child.spawn().map_err(|error| {
        DataError::new(format!(
            "clipboard is unreachable ({error}); write export to a file instead"
        ))
    })?;
    if let Some(stdin) = process.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| DataError::new(error.to_string()))?;
    }
    let status = process
        .wait()
        .map_err(|error| DataError::new(error.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(DataError::new(
            "clipboard copy failed; the transcript was not written anywhere else",
        ))
    }
}

fn dir_size(path: &Path) -> io::Result<u64> {
    let mut total = 0u64;
    let mut pending = vec![path.to_path_buf()];
    while let Some(current) = pending.pop() {
        let meta = fs::symlink_metadata(&current)?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_file() {
            total = total.saturating_add(meta.len());
            continue;
        }
        if !meta.is_dir() {
            continue;
        }
        for entry in fs::read_dir(&current)? {
            pending.push(entry?.path());
        }
    }
    Ok(total)
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} {}", UNITS[0])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

pub fn confirm_delete_prompt(session_id: &str) -> String {
    format!("Delete session {session_id}? y=yes n=cancel")
}

#[cfg(test)]
pub fn touch_for_size(path: &Path, bytes: usize) -> io::Result<()> {
    use std::fs::File;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = File::create(path)?;
    file.write_all(&vec![b'x'; bytes])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_home() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "codsh-session-data-{stamp}-{seq}-{}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_pair(home: &Path, cwd: &Path) -> (String, String) {
        let keep = "11111111-1111-4111-8111-111111111111";
        let drop = "22222222-2222-4222-8222-222222222222";
        write_session(home, keep, cwd, "KEEP_PROMPT", "keep-secret", "keep-tool");
        write_session(home, drop, cwd, "DROP_PROMPT", "drop-secret", "drop-tool");
        (keep.into(), drop.into())
    }

    fn write_session(home: &Path, id: &str, cwd: &Path, prompt: &str, secret: &str, tool: &str) {
        let cwd_text = cwd.to_str().unwrap();
        let project = session_catalog::project_key_for_test(cwd_text);
        // Match the installed dsh layout: hyphens in the id are ~002D.
        let encoded: String = id
            .chars()
            .map(|ch| {
                if ch == '-' {
                    "~002D".to_string()
                } else {
                    ch.to_string()
                }
            })
            .collect();
        assert!(encoded.contains("~002D"));
        let dir = home.join("sessions").join(&project).join(encoded);
        fs::create_dir_all(&dir).unwrap();
        let attachment = dir.join("note.txt");
        fs::write(&attachment, secret).unwrap();
        let body = format!(
            "{header}\n{user}\n{call}\n{result}\n{answer}\n",
            header = json!({
                "type": "session",
                "version": 1,
                "id": id,
                "createdAt": 10,
                "isSeeded": false,
                "delegationDepth": 0,
                "cwd": cwd_text,
            }),
            user = json!({
                "type": "user/message",
                "seq": 1,
                "data": {"message": {"content": [
                    {"type": "text", "text": prompt},
                    {"type": "resource_link", "uri": attachment}
                ]}}
            }),
            call = json!({
                "type": "tool/call",
                "seq": 2,
                "data": {"callId": tool, "name": "read", "arguments": "{\"file_path\":\"note.txt\"}"}
            }),
            result = json!({
                "type": "tool/result",
                "seq": 3,
                "data": {"message": {"toolCallId": tool, "content": [{"type": "text", "text": secret}]}}
            }),
            answer = json!({
                "type": "assistant/message",
                "seq": 4,
                "data": {"message": {"content": [{"type": "text", "text": format!("saw {prompt}")}]}}
            }),
        );
        fs::write(dir.join("session.jsonl"), body).unwrap();
    }

    #[test]
    fn export_keeps_message_tool_and_attachment_and_names_the_file() {
        let home = temp_home();
        let cwd = home.join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let (keep, drop_id) = write_pair(&home, &cwd);
        let out_path = home.join("out").join("one.md");
        let mut sink = Vec::new();
        let outcome = export_session(
            &home,
            &cwd,
            &ExportRequest {
                session_id: drop_id.clone(),
                target: ExportTarget::File(out_path.clone()),
            },
            &mut sink,
        )
        .unwrap();
        let written = fs::read_to_string(&out_path).unwrap();
        assert!(written.contains("DROP_PROMPT"));
        assert!(written.contains("drop-tool"));
        assert!(written.contains("drop-secret"));
        assert!(written.contains("note.txt"));
        assert!(!written.contains("KEEP_PROMPT"));
        assert!(written.contains("not a claim"));
        assert_eq!(outcome.wrote_file.as_deref(), Some(out_path.as_path()));
        assert!(outcome.message.contains(out_path.to_str().unwrap()));
        let _ = keep;
    }

    #[test]
    fn share_without_a_service_does_not_claim_success() {
        let home = temp_home();
        let cwd = home.join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let (_keep, drop_id) = write_pair(&home, &cwd);
        let error = share_session(
            &home,
            &cwd,
            &ShareRequest {
                session_id: drop_id,
                url: None,
            },
        )
        .unwrap_err();
        assert!(error.message.contains("No share service"));
        assert!(error.message.contains("Nothing was uploaded"));
        assert!(!error.message.contains("https://grok.com"));
    }

    #[test]
    fn share_refuses_an_official_host() {
        let home = temp_home();
        let cwd = home.join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let (_keep, drop_id) = write_pair(&home, &cwd);
        let error = share_session(
            &home,
            &cwd,
            &ShareRequest {
                session_id: drop_id,
                url: Some("https://grok.com/build/share".into()),
            },
        )
        .unwrap_err();
        assert!(error.message.contains("Official"));
        assert!(error.message.contains("Nothing was uploaded"));
    }

    #[test]
    fn unconfirmed_delete_leaves_both_sessions() {
        let home = temp_home();
        let cwd = home.join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let (keep, drop_id) = write_pair(&home, &cwd);
        let error = delete_session(
            &home,
            &cwd,
            &DeleteRequest {
                session_id: drop_id.clone(),
                confirmed: false,
            },
        )
        .unwrap_err();
        assert!(error.message.contains("cancelled"));
        let catalog = session_catalog::load_catalog(&home, &cwd);
        assert!(catalog.sessions.iter().any(|session| session.id == keep));
        assert!(catalog.sessions.iter().any(|session| session.id == drop_id));
    }

    #[test]
    fn confirmed_delete_removes_only_the_selected_directory() {
        let home = temp_home();
        let cwd = home.join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let (keep, drop_id) = write_pair(&home, &cwd);
        let outcome = delete_session(
            &home,
            &cwd,
            &DeleteRequest {
                session_id: drop_id.clone(),
                confirmed: true,
            },
        )
        .unwrap();
        assert!(!outcome.removed.exists());
        let catalog = session_catalog::load_catalog(&home, &cwd);
        assert!(catalog.sessions.iter().any(|session| session.id == keep));
        assert!(!catalog.sessions.iter().any(|session| session.id == drop_id));
        let keep_prompt = catalog
            .sessions
            .iter()
            .find(|session| session.id == keep)
            .unwrap();
        assert_eq!(keep_prompt.prompts, vec!["KEEP_PROMPT".to_string()]);
    }

    #[test]
    fn delete_refuses_a_live_write_lock() {
        let home = temp_home();
        let cwd = home.join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let (_keep, drop_id) = write_pair(&home, &cwd);
        let _owner = session_owner::SessionOwner::acquire(&home, &drop_id).unwrap();
        let error = delete_session(
            &home,
            &cwd,
            &DeleteRequest {
                session_id: drop_id.clone(),
                confirmed: true,
            },
        )
        .unwrap_err();
        assert!(error.message.contains("write owner"));
        let catalog = session_catalog::load_catalog(&home, &cwd);
        assert!(catalog.sessions.iter().any(|session| session.id == drop_id));
    }

    #[test]
    fn share_posts_only_the_selected_session_to_the_configured_service() {
        let home = temp_home();
        let cwd = home.join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let (keep, drop_id) = write_pair(&home, &cwd);
        let captured = home.join("posted.json");
        let port_file = home.join("port");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/share-fixture.py");
        let mut child = std::process::Command::new("python3")
            .arg(&fixture)
            .arg(&captured)
            .arg(&port_file)
            .spawn()
            .unwrap();
        let port = loop {
            if let Ok(text) = fs::read_to_string(&port_file)
                && let Ok(port) = text.trim().parse::<u16>()
            {
                break port;
            }
            if child.try_wait().unwrap().is_some() {
                panic!("share fixture exited before binding");
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        let outcome = share_session(
            &home,
            &cwd,
            &ShareRequest {
                session_id: drop_id.clone(),
                url: Some(format!("http://127.0.0.1:{port}/share")),
            },
        )
        .unwrap();
        let _ = child.wait();
        assert_eq!(outcome.url, "http://127.0.0.1/shared/selected");
        assert!(outcome.posted);
        let posted = fs::read_to_string(&captured).unwrap();
        assert!(posted.contains(&drop_id));
        assert!(posted.contains("DROP_PROMPT"));
        assert!(!posted.contains("KEEP_PROMPT"));
        assert!(posted.contains("\"redaction\":\"not claimed\"") || posted.contains("not claimed"));
        let _ = keep;
    }

    #[test]
    fn disk_report_orders_directories_and_does_not_delete() {
        let home = temp_home();
        let grok = home.join("grok");
        fs::create_dir_all(grok.join("sessions")).unwrap();
        fs::create_dir_all(grok.join("small")).unwrap();
        touch_for_size(&grok.join("sessions").join("a.bin"), 4096).unwrap();
        touch_for_size(&grok.join("small").join("b.bin"), 10).unwrap();
        let before = fs::read_dir(&grok).unwrap().count();
        let report = collect_disk(&grok, &home.join("dsh")).unwrap();
        assert!(report.top_level_dirs[0].name == "sessions");
        assert!(report.total_bytes >= 4106);
        assert_eq!(fs::read_dir(&grok).unwrap().count(), before);
        let text = format_disk(&report);
        assert!(text.contains("sessions"));
        assert!(text.contains("does not delete"));
    }
}
