//! Session export, share, deletion, and isolated-home disk usage.
//!
//! Export writes a readable Markdown transcript of one selected session.
//! Share posts only after an explicit command and only to the selected
//! substitute, without following a redirect. Delete is blocked: released dsh
//! persistence exposes create, open, flush, stat, and list, and no deletion
//! operation. Every delete entry refuses and leaves every session in place.

use crate::extra_ca;
use crate::privacy;
use crate::session_catalog::{self, Catalog};
use serde::Serialize;
use serde_json::{Value, json};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const SHARE_TIMEOUT: Duration = Duration::from_secs(15);
const SHARE_RESPONSE_LIMIT: u64 = 64 * 1024;

const DELETE_BLOCKED: &str = "blocked: released dsh session persistence has no deletion operation (create, open, flush, stat, and list only). Session deletion is not supported. Nothing was removed.";

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
    } else if positional.len() > 2 {
        return Err(io::Error::other(
            "export accepts one session id and an optional output path",
        ));
    } else if let Some(path) = positional.get(1) {
        ExportTarget::File(PathBuf::from(path))
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
Sharing is off unless this command is explicit and a substitute service is configured. Official grok.com, api.x.ai, and sentry hosts are refused. http and https both use the native TLS connector; GROK_EXTRA_CA_BUNDLE or SSL_CERT_FILE supplies the only extra root, and an untrusted certificate uploads nothing. A missing service is an error, not a local success URL. The POST is not followed across a redirect, and a response over 64 KiB or a 15s timeout is a failure. The local session is unchanged."
}

/// Help that names the substitute this process can see. Official hosts stay unnamed.
pub fn share_help_visible(configured: Option<&str>) -> String {
    match configured.map(str::trim).filter(|url| !url.is_empty()) {
        Some(url) if !privacy::is_official_endpoint(url) => {
            format!("{}\n\nConfigured substitute: {url}", share_help())
        }
        _ => share_help().to_string(),
    }
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
    "Session deletion is not supported\n\n\
Usage: codsh --rust sessions delete [OPTIONS] <ID>\n\n\
Arguments:\n  \
<ID>  Session id that would be deleted\n\n\
Options:\n      \
--yes, -y               Confirmation is accepted and still removes nothing.\n  \
-h, --help              Print help\n\n\
Released dsh session persistence exposes create, open, flush, stat, and list. It has no deletion operation. CLI delete, /delete, the resume picker, and the dashboard all refuse. No session directory, attachment, log, or sidecar is removed."
}

pub fn disk_help() -> &'static str {
    "Show what the isolated codsh home uses on disk\n\n\
Usage: codsh --rust du [OPTIONS]\n       codsh --rust disk-usage [OPTIONS]\n\n\
Options:\n      \
--json                  Emit machine-readable JSON output\n  \
-h, --help              Print help\n\n\
Lists top-level directories under $GROK_HOME, largest first, plus the isolated dsh tree when it sits beside that home. Worktree pools and Grove redirections are not measured here. A directory that cannot be read is counted in unreadable_dirs and is not deleted."
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
    let response = post_share(url, body.as_bytes())?;
    let returned = response;
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
) -> Result<(), DataError> {
    // Confirm, cancel, a live writer, and a missing id all stop here.
    // There is no filesystem deletion to gate.
    let _ = (dsh_home, cwd, request);
    Err(DataError::new(DELETE_BLOCKED))
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
    // Isolated layout is ~/.codsh-rust/.grok beside ~/.codsh-rust/dsh. Name
    // that dsh tree once. A sessions directory that is not inside it is still
    // listed on its own; counting both would double the same bytes.
    let dsh_beside =
        dsh_home.is_dir() && !dsh_home.starts_with(grok_home) && !grok_home.starts_with(dsh_home);
    if dsh_beside {
        match dir_size(dsh_home) {
            Ok(bytes) => dirs.push(DirUsage {
                name: "dsh".into(),
                bytes,
            }),
            Err(_) => unreadable += 1,
        }
    } else if sessions.is_dir() && !sessions.starts_with(grok_home) {
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

fn render_markdown(
    _dsh_home: &Path,
    session: &session_catalog::SessionRecord,
) -> Result<String, DataError> {
    if session.log_path.as_os_str().is_empty() {
        return Err(DataError::new(format!(
            "Session '{}' log was not resolved by the catalog",
            session.id
        )));
    }
    let text = session_catalog::read_session_log(&session.log_path).map_err(|error| {
        DataError::new(format!(
            "unreadable session log {}: {error}",
            session.log_path.display()
        ))
    })?;
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
                if session_catalog::plugin_user_snapshot(&event) {
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
                    .or_else(|| {
                        message
                            .get("source")
                            .and_then(|source| source.get("callId"))
                    })
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
        } else if kind == "tool-result" {
            // Live dsh nests the result text one level under content[].content[].
            parts.push(message_text_from_blocks(block.get("content")));
        }
    }
    parts.join("")
}

fn message_text_from_blocks(content: Option<&Value>) -> String {
    let Some(blocks) = content.and_then(Value::as_array) else {
        return String::new();
    };
    let mut parts = Vec::new();
    for block in blocks {
        if matches!(
            block.get("type").and_then(Value::as_str),
            Some("text" | "reasoning")
        ) && let Some(text) = block.get("text").and_then(Value::as_str)
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
            let attachment = block.get("attachment");
            let path = block
                .get("uri")
                .or_else(|| block.get("path"))
                .or_else(|| block.get("name"))
                .or_else(|| attachment.and_then(|item| item.get("name")))
                .and_then(Value::as_str)
                .unwrap_or("(unnamed)");
            lines.push(format!("- {kind}: {path}"));
        }
    }
    lines.join("\n")
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

fn post_share(url: &str, body: &[u8]) -> Result<String, DataError> {
    // ureq's native-tls feature has no default connector. Reuse the extra-CA
    // agent so HTTPS and a configured root work, and HTTP still refuses redirects.
    let bundle = extra_ca::select_bundle(
        std::env::var_os(extra_ca::ENV_GROK_EXTRA_CA_BUNDLE),
        std::env::var_os(extra_ca::ENV_SSL_CERT_FILE),
    )
    .map(|(_, path)| path);
    let (agent, _) = extra_ca::agent(bundle.as_deref()).map_err(|error| {
        DataError::new(format!(
            "share service was not reached ({error}); local session unchanged"
        ))
    })?;
    let response = agent
        .post(url)
        .timeout(SHARE_TIMEOUT)
        .set("content-type", "application/json")
        .set("user-agent", "codsh-rust-share")
        .send_bytes(body)
        .map_err(|error| match error {
            ureq::Error::Status(code, response) => {
                // redirects(0) surfaces a 3xx as a status error instead of a body.
                let redirected = (300..400).contains(&code)
                    || response.header("location").is_some();
                if redirected {
                    DataError::new(format!(
                        "share service redirected with HTTP {code}; redirects are not followed and nothing else was uploaded"
                    ))
                } else {
                    DataError::new(format!(
                        "share service returned HTTP {code}; local session unchanged"
                    ))
                }
            }
            other => DataError::new(format!(
                "share service was not reached ({other}); local session unchanged"
            )),
        })?;
    let status = response.status();
    if (300..400).contains(&status) || response.header("location").is_some() {
        return Err(DataError::new(format!(
            "share service redirected with HTTP {status}; redirects are not followed and nothing else was uploaded"
        )));
    }
    if !(200..300).contains(&status) {
        return Err(DataError::new(format!(
            "share service returned HTTP {status}; local session unchanged"
        )));
    }
    let mut limited = response
        .into_reader()
        .take(SHARE_RESPONSE_LIMIT.saturating_add(1));
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes).map_err(|error| {
        DataError::new(format!(
            "share response could not be read ({error}); no success is claimed"
        ))
    })?;
    if bytes.len() as u64 > SHARE_RESPONSE_LIMIT {
        return Err(DataError::new(
            "share response exceeded 64 KiB; no success is claimed",
        ));
    }
    String::from_utf8(bytes)
        .map_err(|_| DataError::new("share response was not UTF-8; no success is claimed"))
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
    use crate::session_owner;
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

    fn outside_log(path: &Path, id: &str, secret: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let body = format!(
            "{header}\n{user}\n",
            header = json!({
                "type": "session",
                "version": 1,
                "id": id,
                "createdAt": 10,
                "isSeeded": false,
                "delegationDepth": 0,
                "cwd": "/outside",
            }),
            user = json!({
                "type": "user/message",
                "seq": 1,
                "data": {"message": {"content": [{"type": "text", "text": secret}]}}
            }),
        );
        fs::write(path, body).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn export_and_share_refuse_symlinked_session_roots_projects_dirs_and_logs() {
        use std::os::unix::fs::symlink;
        let home = temp_home();
        let cwd = home.join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let real_id = "44444444-4444-4444-8444-444444444444";
        write_session(
            &home,
            real_id,
            &cwd,
            "REAL_PROMPT",
            "real-secret",
            "real-tool",
        );
        let outside = home.join("outside");
        let outside_id = "55555555-5555-4555-8555-555555555555";
        let outside_secret = "OUTSIDE_SECRET";
        let outside_dir = outside.join("session-dir");
        outside_log(
            &outside_dir.join("session.jsonl"),
            outside_id,
            outside_secret,
        );
        let project = session_catalog::project_key_for_test(cwd.to_str().unwrap());
        let sessions = home.join("sessions");
        let project_dir = sessions.join(&project);
        symlink(&outside_dir, project_dir.join("linked-session")).unwrap();
        let outside_project = outside.join("project");
        outside_log(
            &outside_project.join("nested").join("session.jsonl"),
            outside_id,
            outside_secret,
        );
        symlink(&outside_project, sessions.join("linked-project")).unwrap();
        let real_encoded: String = real_id
            .chars()
            .map(|ch| {
                if ch == '-' {
                    "~002D".to_string()
                } else {
                    ch.to_string()
                }
            })
            .collect();
        let real_log = project_dir.join(&real_encoded).join("session.jsonl");
        let parked = project_dir.join(&real_encoded).join("session.jsonl.real");
        let decoy = project_dir.join(&real_encoded).join("session.jsonl.link");
        symlink(outside_dir.join("session.jsonl"), &decoy).unwrap();
        fs::rename(&real_log, &parked).unwrap();
        symlink(outside_dir.join("session.jsonl"), &real_log).unwrap();
        let linked_root_home = home.join("linked-root-home");
        fs::create_dir_all(&linked_root_home).unwrap();
        symlink(&outside, linked_root_home.join("sessions")).unwrap();
        let outside_before = fs::read(outside_dir.join("session.jsonl")).unwrap();
        let hidden = session_catalog::load_catalog(&home, &cwd);
        assert!(
            hidden
                .sessions
                .iter()
                .all(|session| session.id != outside_id),
            "catalog published a symlinked session: {:?}",
            hidden
                .sessions
                .iter()
                .map(|session| &session.id)
                .collect::<Vec<_>>()
        );
        assert!(
            hidden.sessions.iter().all(|session| session.id != real_id),
            "catalog followed a symlinked log"
        );
        let export_path = home.join("leaked.md");
        let mut sink = Vec::new();
        let export_error = export_session(
            &home,
            &cwd,
            &ExportRequest {
                session_id: outside_id.into(),
                target: ExportTarget::File(export_path.clone()),
            },
            &mut sink,
        )
        .unwrap_err();
        assert!(
            export_error.message.contains("not found")
                || export_error.message.contains("refusing symlinked"),
            "{export_error}"
        );
        assert!(!export_path.exists(), "symlink export created a file");
        assert!(
            !String::from_utf8_lossy(&sink).contains(outside_secret),
            "export wrote the outside secret"
        );
        let share_error = share_session(
            &home,
            &cwd,
            &ShareRequest {
                session_id: outside_id.into(),
                url: Some("http://127.0.0.1:9/share".into()),
            },
        )
        .unwrap_err();
        assert!(
            share_error.message.contains("not found")
                || share_error.message.contains("refusing symlinked"),
            "{share_error}"
        );
        assert!(
            !share_error.message.contains(outside_secret),
            "share error included the outside secret"
        );
        let root_error = export_session(
            &linked_root_home,
            &cwd,
            &ExportRequest {
                session_id: outside_id.into(),
                target: ExportTarget::File(export_path.clone()),
            },
            &mut Vec::new(),
        )
        .unwrap_err();
        assert!(root_error.message.contains("not found"), "{root_error}");
        assert!(!export_path.exists());
        assert_eq!(
            fs::read(outside_dir.join("session.jsonl")).unwrap(),
            outside_before
        );
        fs::remove_file(&real_log).unwrap();
        fs::rename(&parked, &real_log).unwrap();
        fs::remove_file(&decoy).unwrap();
        let plain = fs::read_to_string(&real_log).unwrap();
        let compressed = zstd::encode_all(plain.as_bytes(), 0).unwrap();
        fs::write(
            real_log.with_file_name("session.v1.jsonl.zstd"),
            &compressed,
        )
        .unwrap();
        fs::remove_file(&real_log).unwrap();
        let zstd_out = home.join("real.md");
        let mut sink = Vec::new();
        export_session(
            &home,
            &cwd,
            &ExportRequest {
                session_id: real_id.into(),
                target: ExportTarget::File(zstd_out.clone()),
            },
            &mut sink,
        )
        .unwrap();
        let written = fs::read_to_string(&zstd_out).unwrap();
        assert!(written.contains("REAL_PROMPT"), "{written}");
        assert!(written.contains("real-secret"), "{written}");
        assert!(!written.contains(outside_secret), "{written}");
        assert_eq!(
            fs::read(outside_dir.join("session.jsonl")).unwrap(),
            outside_before,
            "outside file changed"
        );
        let catalog = session_catalog::load_catalog(&home, &cwd);
        assert!(
            catalog
                .sessions
                .iter()
                .all(|session| session.id != outside_id)
        );
        let resolved = catalog
            .sessions
            .iter()
            .find(|session| session.id == real_id)
            .expect("real session missing after the log was restored");
        assert!(
            resolved.log_path.ends_with("session.v1.jsonl.zstd"),
            "{}",
            resolved.log_path.display()
        );
        assert!(!resolved.log_path.as_os_str().is_empty());
    }

    #[test]
    fn export_reads_live_dsh_shapes_and_skips_plugin_snapshots() {
        let home = temp_home();
        let cwd = home.join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let id = "33333333-3333-4333-8333-333333333333";
        let project = session_catalog::project_key_for_test(cwd.to_str().unwrap());
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
        let dir = home.join("sessions").join(&project).join(encoded);
        fs::create_dir_all(&dir).unwrap();
        let cwd_text = cwd.to_str().unwrap();
        let body = format!(
            "{header}\n{agents}\n{skills}\n{user}\n{call}\n{result}\n{answer}\n",
            header = json!({
                "type": "session",
                "version": 3,
                "id": id,
                "createdAt": 10,
                "isSeeded": false,
                "delegationDepth": 0,
                "cwd": cwd_text,
            }),
            agents = json!({
                "type": "user/message",
                "seq": 1,
                "data": {
                    "role": "user",
                    "content": [{"type": "text", "text": "AGENT_INSTRUCTIONS_SECRET"}],
                    "source": {"kind": "plugin", "plugin": "agent-instructions"}
                }
            }),
            skills = json!({
                "type": "user/message",
                "seq": 2,
                "data": {
                    "role": "user",
                    "content": [{"type": "text", "text": "SKILL_CATALOG_SECRET"}],
                    "source": {"kind": "plugin", "plugin": "skill-catalog"}
                }
            }),
            user = json!({
                "type": "user/message",
                "seq": 3,
                "data": {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "LIVE_USER_PROMPT"},
                        {"type": "image", "attachment": {"name": "shot.png", "mediaType": "image/png"}}
                    ],
                    "source": {"kind": "user"}
                }
            }),
            call = json!({
                "type": "tool/call",
                "seq": 4,
                "data": {"callId": "call-live", "name": "read", "arguments": "{\"file_path\":\"shot.png\"}", "step": 1, "turn": 1}
            }),
            result = json!({
                "type": "tool/result",
                "seq": 5,
                "data": {
                    "message": {
                        "role": "user",
                        "content": [{
                            "type": "tool-result",
                            "toolCallId": "call-live",
                            "isError": false,
                            "content": [{"type": "text", "text": "NESTED_TOOL_TEXT"}]
                        }],
                        "source": {"kind": "tool", "callId": "call-live"}
                    }
                }
            }),
            answer = json!({
                "type": "assistant/message",
                "seq": 6,
                "data": {"message": {"content": [{"type": "text", "text": "saw LIVE_USER_PROMPT"}]}}
            }),
        );
        let encoded_log = zstd::encode_all(body.as_bytes(), 0).unwrap();
        fs::write(dir.join("session.v3.jsonl.zstd"), encoded_log).unwrap();
        let out_path = home.join("live.md");
        let mut sink = Vec::new();
        export_session(
            &home,
            &cwd,
            &ExportRequest {
                session_id: id.into(),
                target: ExportTarget::File(out_path.clone()),
            },
            &mut sink,
        )
        .unwrap();
        let written = fs::read_to_string(&out_path).unwrap();
        assert!(written.contains("LIVE_USER_PROMPT"), "{written}");
        assert!(written.contains("shot.png"), "{written}");
        assert!(written.contains("call-live"), "{written}");
        assert!(written.contains("NESTED_TOOL_TEXT"), "{written}");
        assert!(written.contains("## User"), "{written}");
        assert!(!written.contains("AGENT_INSTRUCTIONS_SECRET"), "{written}");
        assert!(!written.contains("SKILL_CATALOG_SECRET"), "{written}");
        let user_blocks: Vec<_> = written
            .split("## ")
            .filter(|section| section.starts_with("User"))
            .collect();
        assert_eq!(user_blocks.len(), 1, "{written}");
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
    fn share_does_not_follow_a_redirect() {
        let home = temp_home();
        let cwd = home.join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let (_keep, drop_id) = write_pair(&home, &cwd);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let uploaded = home.join("redirected.txt");
        let marker = uploaded.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let _ = stream.read(&mut buf);
            let body = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(body.as_bytes());
            let _ = stream.flush();
            drop(stream);
            // A followed redirect comes back to this listener.
            listener.set_nonblocking(true).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(300));
            if listener.accept().is_ok() {
                fs::write(&marker, b"followed").unwrap();
            }
        });
        let error = share_session(
            &home,
            &cwd,
            &ShareRequest {
                session_id: drop_id,
                url: Some(format!("http://127.0.0.1:{port}/share")),
            },
        )
        .unwrap_err();
        let _ = server.join();
        assert!(error.message.contains("redirect"), "{error}");
        assert!(error.message.contains("not followed"), "{error}");
        assert!(!uploaded.exists(), "a redirected upload was sent");
    }

    fn snapshot_tree(root: &Path) -> Vec<(String, Vec<u8>)> {
        let mut files = Vec::new();
        let mut pending = vec![root.to_path_buf()];
        while let Some(current) = pending.pop() {
            let Ok(meta) = fs::symlink_metadata(&current) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                let target = fs::read_link(&current).unwrap_or_default();
                files.push((
                    format!("link:{}", current.display()),
                    target.to_string_lossy().as_bytes().to_vec(),
                ));
                continue;
            }
            if meta.is_dir() {
                if let Ok(entries) = fs::read_dir(&current) {
                    for entry in entries.flatten() {
                        pending.push(entry.path());
                    }
                }
                continue;
            }
            if meta.is_file()
                && let Ok(bytes) = fs::read(&current)
            {
                files.push((current.display().to_string(), bytes));
            }
        }
        files.sort();
        files
    }

    fn assert_delete_preserves(home: &Path, cwd: &Path, session_id: &str, confirmed: bool) {
        let before = snapshot_tree(home);
        let error = delete_session(
            home,
            cwd,
            &DeleteRequest {
                session_id: session_id.to_string(),
                confirmed,
            },
        )
        .unwrap_err();
        assert!(error.message.contains("blocked"), "{error}");
        assert!(error.message.contains("Nothing was removed"), "{error}");
        assert!(!error.message.contains("deleted session"), "{error}");
        assert_eq!(snapshot_tree(home), before);
    }

    #[test]
    fn export_rejects_extra_arguments_before_writing() {
        let home = temp_home();
        let cwd = home.join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let (_keep, drop_id) = write_pair(&home, &cwd);
        let error = parse_export(&[drop_id.as_str(), "one.md", "EXTRA"]).unwrap_err();
        assert!(error.to_string().contains("optional output path"));
        assert!(!home.join("one.md").exists());
        assert!(!Path::new("one.md").exists());
        assert!(!Path::new("EXTRA").exists());
    }

    #[test]
    fn delete_is_blocked_and_preserves_every_session() {
        let home = temp_home();
        let cwd = home.join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let (keep, drop_id) = write_pair(&home, &cwd);
        let titles = session_catalog::titles_path(&home);
        let activity = session_catalog::activity_path(&home);
        fs::create_dir_all(titles.parent().unwrap()).unwrap();
        fs::write(
            &titles,
            format!("{{\"{keep}\":{{\"title\":\"keep-title\",\"manual\":true}}}}\n"),
        )
        .unwrap();
        fs::write(&activity, "{not-json").unwrap();
        let selected = "33333333-3333-4333-8333-333333333333";
        let project = session_catalog::project_key_for_test(cwd.to_str().unwrap());
        let nested = home.join("sessions").join(&project).join("selected");
        fs::create_dir_all(&nested).unwrap();
        let header = json!({
            "type": "session",
            "version": 1,
            "id": selected,
            "createdAt": 10,
            "isSeeded": false,
            "delegationDepth": 0,
            "cwd": cwd.to_str().unwrap(),
        });
        let nested_body = format!(
            "{header}\n{}\n",
            json!({"type":"user/message","seq":1,"data":{"message":{"content":[{"type":"text","text":"NESTED"}]}}})
        );
        fs::write(nested.join("session.jsonl"), &nested_body).unwrap();
        fs::write(home.join("sessions").join("session.jsonl"), &nested_body).unwrap();
        let outside = home.join("outside-keep");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), b"other-work").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, home.join("sessions").join("linked-other"))
                .unwrap();
        }
        let readonly = home.join("sessions").join("readonly.json");
        fs::write(&readonly, b"preserve").unwrap();
        let mut permissions = fs::metadata(&readonly).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&readonly, permissions).unwrap();
        let _owner = session_owner::SessionOwner::acquire(&home, &drop_id).unwrap();
        for (id, confirmed) in [
            (&drop_id, false),
            (&drop_id, true),
            (&selected.to_string(), true),
        ] {
            assert_delete_preserves(&home, &cwd, id, confirmed);
        }
        let catalog = session_catalog::load_catalog(&home, &cwd);
        assert!(catalog.sessions.iter().any(|session| session.id == keep));
        assert!(catalog.sessions.iter().any(|session| session.id == drop_id));
        assert!(
            catalog
                .sessions
                .iter()
                .any(|session| session.id == selected)
        );
        assert_eq!(fs::read(&activity).unwrap(), b"{not-json");
        assert!(fs::read_to_string(&titles).unwrap().contains("keep-title"));
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"other-work");
        let _ = keep;
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

    struct HttpsShare {
        url: String,
        captured: PathBuf,
        contacted: PathBuf,
        _guard: std::thread::JoinHandle<()>,
    }

    fn openssl_share_material(dir: &Path, cn: &str) -> (PathBuf, PathBuf) {
        let key = dir.join("key.pem");
        let cert = dir.join("cert.pem");
        let p12 = dir.join("server.p12");
        assert!(
            std::process::Command::new("openssl")
                .args([
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-keyout",
                    key.to_str().unwrap(),
                    "-out",
                    cert.to_str().unwrap(),
                    "-days",
                    "1",
                    "-nodes",
                    "-subj",
                    &format!("/CN={cn}"),
                    "-addext",
                    "subjectAltName=DNS:localhost,IP:127.0.0.1",
                    "-addext",
                    "extendedKeyUsage=serverAuth",
                    "-addext",
                    "keyUsage=digitalSignature,keyEncipherment",
                ])
                .status()
                .unwrap()
                .success(),
            "openssl could not mint the isolated share certificate"
        );
        assert!(
            std::process::Command::new("openssl")
                .args([
                    "pkcs12",
                    "-export",
                    "-out",
                    p12.to_str().unwrap(),
                    "-inkey",
                    key.to_str().unwrap(),
                    "-in",
                    cert.to_str().unwrap(),
                    "-passout",
                    "pass:test",
                ])
                .status()
                .unwrap()
                .success(),
            "openssl could not export the isolated share identity"
        );
        (cert, p12)
    }

    fn spawn_https_share(p12: &Path, captured: PathBuf, redirect: bool) -> HttpsShare {
        let bytes = fs::read(p12).unwrap();
        let identity = native_tls::Identity::from_pkcs12(&bytes, "test").unwrap();
        let acceptor = native_tls::TlsAcceptor::new(identity).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let contacted = captured.with_extension("contacted");
        let contacted_flag = contacted.clone();
        let captured_body = captured.clone();
        let handle = std::thread::spawn(move || {
            let Ok((stream, _)) = listener.accept() else {
                return;
            };
            let Ok(mut tls) = acceptor.accept(stream) else {
                return;
            };
            use std::io::{Read, Write};
            let _ = fs::write(&contacted_flag, b"1");
            let mut request = Vec::new();
            let mut buf = [0u8; 4096];
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while std::time::Instant::now() < deadline {
                match tls.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        request.extend_from_slice(&buf[..n]);
                        if request.windows(4).any(|window| window == b"\r\n\r\n") {
                            break;
                        }
                    }
                }
            }
            let header_end = request
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|index| index + 4);
            if let Some(header_end) = header_end {
                let header = String::from_utf8_lossy(&request[..header_end]);
                let length = header.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    if name.eq_ignore_ascii_case("content-length") {
                        value.trim().parse::<usize>().ok()
                    } else {
                        None
                    }
                });
                if let Some(length) = length {
                    while request.len() < header_end + length
                        && std::time::Instant::now() < deadline
                    {
                        match tls.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => request.extend_from_slice(&buf[..n]),
                        }
                    }
                    if request.len() >= header_end + length {
                        let _ =
                            fs::write(&captured_body, &request[header_end..header_end + length]);
                    }
                }
            }
            let reply = if redirect {
                b"HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
            } else {
                let payload = br#"{"url":"https://127.0.0.1/shared/selected"}"#;
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                )
                .into_bytes()
                .into_iter()
                .chain(payload.iter().copied())
                .collect()
            };
            let _ = tls.write_all(&reply);
            let _ = tls.flush();
        });
        HttpsShare {
            url: format!("https://127.0.0.1:{port}/share"),
            captured,
            contacted,
            _guard: handle,
        }
    }

    fn without_share_ca<T>(run: impl FnOnce() -> T) -> T {
        let saved_extra = std::env::var_os(extra_ca::ENV_GROK_EXTRA_CA_BUNDLE);
        let saved_ssl = std::env::var_os(extra_ca::ENV_SSL_CERT_FILE);
        unsafe {
            std::env::remove_var(extra_ca::ENV_GROK_EXTRA_CA_BUNDLE);
            std::env::remove_var(extra_ca::ENV_SSL_CERT_FILE);
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run));
        unsafe {
            match saved_extra {
                Some(value) => std::env::set_var(extra_ca::ENV_GROK_EXTRA_CA_BUNDLE, value),
                None => std::env::remove_var(extra_ca::ENV_GROK_EXTRA_CA_BUNDLE),
            }
            match saved_ssl {
                Some(value) => std::env::set_var(extra_ca::ENV_SSL_CERT_FILE, value),
                None => std::env::remove_var(extra_ca::ENV_SSL_CERT_FILE),
            }
        }
        match result {
            Ok(value) => value,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }

    #[test]
    fn share_https_accepts_only_the_configured_test_ca_and_does_not_follow_redirects() {
        let home = temp_home();
        let cwd = home.join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let (_keep, drop_id) = write_pair(&home, &cwd);
        let material = tempfile::TempDir::new().unwrap();
        let (cert, p12) = openssl_share_material(material.path(), "localhost");
        let wrong = material.path().join("wrong.pem");
        fs::write(
            &wrong,
            "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
        )
        .unwrap();

        let trusted = spawn_https_share(&p12, home.join("trusted.json"), false);
        let outcome = without_share_ca(|| {
            unsafe {
                std::env::set_var(extra_ca::ENV_GROK_EXTRA_CA_BUNDLE, &cert);
            }
            share_session(
                &home,
                &cwd,
                &ShareRequest {
                    session_id: drop_id.clone(),
                    url: Some(trusted.url.clone()),
                },
            )
        });
        let _ = trusted._guard.join();
        let outcome = outcome.unwrap();
        assert_eq!(outcome.url, "https://127.0.0.1/shared/selected");
        assert!(
            trusted.contacted.exists(),
            "trusted HTTPS server was not contacted"
        );
        let posted = fs::read_to_string(&trusted.captured).unwrap();
        let value: Value = serde_json::from_str(&posted).unwrap();
        assert_eq!(value["session_id"], drop_id);
        assert!(value["markdown"].as_str().unwrap().contains("DROP_PROMPT"));
        assert!(!value["markdown"].as_str().unwrap().contains("KEEP_PROMPT"));
        assert_eq!(value["redaction"], "not claimed");

        let untrusted = spawn_https_share(&p12, home.join("untrusted.json"), false);
        let missing = without_share_ca(|| {
            share_session(
                &home,
                &cwd,
                &ShareRequest {
                    session_id: drop_id.clone(),
                    url: Some(untrusted.url.clone()),
                },
            )
        })
        .unwrap_err();
        let _ = untrusted._guard.join();
        assert!(
            missing.message.contains("not reached") || missing.message.contains("certificate"),
            "{missing}"
        );
        assert!(
            !missing.message.contains("no TLS backend"),
            "HTTPS still has no native-tls connector: {missing}"
        );
        assert!(!untrusted.captured.exists(), "untrusted CA still uploaded");
        assert!(!missing.message.contains("https://grok.com"));

        let mismatched = spawn_https_share(&p12, home.join("wrong.json"), false);
        let wrong_ca = without_share_ca(|| {
            unsafe {
                std::env::set_var(extra_ca::ENV_GROK_EXTRA_CA_BUNDLE, &wrong);
            }
            share_session(
                &home,
                &cwd,
                &ShareRequest {
                    session_id: drop_id.clone(),
                    url: Some(mismatched.url.clone()),
                },
            )
        })
        .unwrap_err();
        let _ = mismatched._guard.join();
        assert!(
            wrong_ca.message.contains("not reached") || wrong_ca.message.contains("certificate"),
            "{wrong_ca}"
        );
        assert!(
            !wrong_ca.message.contains("no TLS backend"),
            "HTTPS still has no native-tls connector: {wrong_ca}"
        );
        assert!(!mismatched.captured.exists(), "wrong CA still uploaded");

        let redirected = spawn_https_share(&p12, home.join("redirect.json"), true);
        let redirect = without_share_ca(|| {
            unsafe {
                std::env::set_var(extra_ca::ENV_SSL_CERT_FILE, &cert);
            }
            share_session(
                &home,
                &cwd,
                &ShareRequest {
                    session_id: drop_id,
                    url: Some(redirected.url.clone()),
                },
            )
        })
        .unwrap_err();
        let _ = redirected._guard.join();
        assert!(redirect.message.contains("redirect"), "{redirect}");
        assert!(redirect.message.contains("not followed"), "{redirect}");
        assert!(
            redirected.contacted.exists(),
            "redirect response was not an HTTPS handshake"
        );
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

    #[test]
    fn disk_json_names_the_isolated_dsh_tree_beside_grok_home() {
        let root = temp_home();
        let grok = root.join(".grok");
        let dsh = root.join("dsh");
        fs::create_dir_all(grok.join("config")).unwrap();
        fs::create_dir_all(dsh.join("sessions").join("one")).unwrap();
        touch_for_size(&grok.join("config").join("note"), 8).unwrap();
        touch_for_size(
            &dsh.join("sessions").join("one").join("session.v1.jsonl"),
            2048,
        )
        .unwrap();
        let report = collect_disk(&grok, &dsh).unwrap();
        let names: Vec<_> = report
            .top_level_dirs
            .iter()
            .map(|dir| dir.name.as_str())
            .collect();
        assert!(
            names.contains(&"dsh"),
            "isolated dsh tree missing from {names:?}"
        );
        let dsh_bytes = report
            .top_level_dirs
            .iter()
            .find(|dir| dir.name == "dsh")
            .map(|dir| dir.bytes)
            .unwrap_or(0);
        assert!(dsh_bytes >= 2048, "{dsh_bytes}");
        assert!(report.note.contains("does not delete"));
    }
}
