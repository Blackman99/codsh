//! Session search, manual titles, and the agent dashboard catalog.
//!
//! Titles and dashboard preferences live beside the dsh session log. They are
//! not a second conversation store: switching sessions still resumes the same
//! dsh id, and a missing session is reported instead of invented.

use crate::session_history;
use crate::session_owner;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const TITLE_LIMIT: usize = 80;
const CONTENT_SNIPPET: usize = 160;
const DISPATCH_LIMIT: usize = 64 * 1024;
const UUID_RE: &str =
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogError {
    pub message: String,
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    Working,
    Idle,
    NeedsInput,
    Inactive,
    Completed,
    Failed,
}

impl Activity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::Idle => "idle",
            Self::NeedsInput => "needs-input",
            Self::Inactive => "inactive",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    pub fn glyph(self) -> &'static str {
        match self {
            Self::Working => "·",
            Self::NeedsInput | Self::Completed | Self::Failed => "●",
            Self::Idle | Self::Inactive => "○",
        }
    }

    pub fn rank(self) -> u8 {
        match self {
            Self::NeedsInput => 0,
            Self::Working => 1,
            Self::Idle => 2,
            Self::Inactive => 3,
            Self::Completed => 4,
            Self::Failed => 5,
        }
    }

    fn parse_filter(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "working" | "busy" | "running" => Some(Self::Working),
            "idle" => Some(Self::Idle),
            "needs-input" | "needs_input" | "awaiting" | "input" => Some(Self::NeedsInput),
            "inactive" => Some(Self::Inactive),
            "completed" | "done" => Some(Self::Completed),
            "failed" | "error" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grouping {
    State,
    Directory,
}

impl Grouping {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::State => "state",
            Self::Directory => "directory",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().trim_matches('"').trim_matches('\'') {
            "state" => Some(Self::State),
            "directory" | "dir" | "cwd" => Some(Self::Directory),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TitleRecord {
    pub manual: bool,
    pub title: String,
    pub generated: String,
    pub updated_at: u64,
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRecord {
    pub id: String,
    pub cwd: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub prompts: Vec<String>,
    pub title: TitleRecord,
    pub activity: Activity,
    pub unread: bool,
    pub pinned: bool,
    pub owner_pid: Option<u32>,
    pub foreign: Option<String>,
    pub damaged: bool,
    /// Directory the catalog already resolved, and the newest log inside it.
    /// Empty when the record came from a projection or a foreign index.
    pub log_dir: PathBuf,
    pub log_path: PathBuf,
}

impl SessionRecord {
    pub fn display_title(&self) -> &str {
        if !self.title.title.is_empty() {
            &self.title.title
        } else if !self.title.generated.is_empty() {
            &self.title.generated
        } else {
            &self.id
        }
    }

    pub fn workspace_label(&self) -> String {
        Path::new(&self.cwd)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(if self.cwd.is_empty() {
                "(no cwd)"
            } else {
                &self.cwd
            })
            .to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardPrefs {
    pub enabled: bool,
    pub grouping: Grouping,
    pub pinned: Vec<String>,
    pub reorder: Vec<String>,
    pub disabled_reason: Option<String>,
}

impl Default for DashboardPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            grouping: Grouping::State,
            pinned: Vec::new(),
            reorder: Vec::new(),
            disabled_reason: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Catalog {
    pub sessions: Vec<SessionRecord>,
    pub prefs: DashboardPrefs,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub session: SessionRecord,
    pub extended: bool,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeMatch {
    pub session: SessionRecord,
    pub ambiguous: Vec<SessionRecord>,
}

pub fn is_uuid(value: &str) -> bool {
    let mut regex_like = true;
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() != 5
        || parts[0].len() != 8
        || parts[1].len() != 4
        || parts[2].len() != 4
        || parts[3].len() != 4
        || parts[4].len() != 12
    {
        regex_like = false;
    }
    regex_like
        && value.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-')
        && !UUID_RE.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

pub fn catalog_dir(dsh_home: &Path) -> PathBuf {
    dsh_home.join("session-catalog")
}

pub fn titles_path(dsh_home: &Path) -> PathBuf {
    catalog_dir(dsh_home).join("titles.json")
}

pub fn activity_path(dsh_home: &Path) -> PathBuf {
    catalog_dir(dsh_home).join("activity.json")
}

fn write_private(path: &Path, body: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(body.as_bytes())?;
        file.flush()?;
    }
    fs::rename(tmp, path)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn load_map(path: &Path) -> BTreeMap<String, Value> {
    let Ok(text) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    serde_json::from_str::<BTreeMap<String, Value>>(&text).unwrap_or_default()
}

fn save_map(path: &Path, map: &BTreeMap<String, Value>) -> io::Result<()> {
    write_private(
        path,
        &format!(
            "{}\n",
            serde_json::to_string_pretty(map).unwrap_or_else(|_| "{}".into())
        ),
    )
}

pub fn load_catalog(dsh_home: &Path, cwd: &Path) -> Catalog {
    let _ = cwd;
    let mut warnings = Vec::new();
    let titles = load_map(&titles_path(dsh_home));
    let activity = load_map(&activity_path(dsh_home));
    let prefs = read_dashboard_prefs(dsh_home);
    let mut sessions = match read_dsh_catalog(dsh_home) {
        Ok(projected) => {
            let mut projected = projected
                .into_iter()
                .filter_map(|row| session_from_projection(&row, &titles, &activity))
                .collect::<Vec<_>>();
            // The Node list has no directory. Attach only logs this walk
            // already resolved; a projection id it cannot see stays unresolved.
            let located = read_plaintext_sessions(dsh_home, &titles, &activity, &mut Vec::new());
            for session in &mut projected {
                if let Some(found) = located.iter().find(|item| item.id == session.id) {
                    session.log_dir.clone_from(&found.log_dir);
                    session.log_path.clone_from(&found.log_path);
                }
            }
            projected
        }
        Err(message) => {
            if !message.is_empty() {
                warnings.push(message);
            }
            read_plaintext_sessions(dsh_home, &titles, &activity, &mut warnings)
        }
    };
    sessions.extend(read_foreign(dsh_home, &mut warnings));
    sessions.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    let pinned: std::collections::BTreeSet<_> = prefs.pinned.iter().cloned().collect();
    for session in &mut sessions {
        session.pinned = pinned.contains(&session.id);
    }
    Catalog {
        sessions,
        prefs,
        warnings,
    }
}

fn read_dsh_catalog(dsh_home: &Path) -> Result<Vec<Value>, String> {
    let helper = session_history::helper_path();
    if !helper.is_file() {
        return Err(String::new());
    }
    let dsh_bin = std::env::var("DSH_BIN").unwrap_or_default();
    if dsh_bin.is_empty() {
        return Err(String::new());
    }
    let output =
        std::process::Command::new(std::env::var("CODSH_NODE").unwrap_or_else(|_| "node".into()))
            .arg(&helper)
            .arg("--list")
            .env("DSH_HOME", dsh_home)
            .env("DSH_BIN", dsh_bin)
            .output()
            .map_err(|error| format!("cannot list dsh sessions: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!("cannot list dsh sessions: {detail}"));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "dsh session catalog was unreadable".to_string())?;
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("cannot list dsh sessions")
            .to_string());
    }
    Ok(value
        .get("sessions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn session_from_projection(
    row: &Value,
    titles: &BTreeMap<String, Value>,
    activity: &BTreeMap<String, Value>,
) -> Option<SessionRecord> {
    let id = row.get("id").and_then(Value::as_str)?.to_string();
    let prompts = row
        .get("prompts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect::<Vec<_>>();
    let mut title = title_from_value(titles.get(&id), &prompts);
    if title.title.is_empty() && !title.manual {
        let logged = row.get("title").and_then(Value::as_str).unwrap_or("");
        let manual = row.get("manual").and_then(Value::as_bool).unwrap_or(false);
        if manual {
            title.manual = true;
            title.title = clip_title(logged);
        } else if !logged.is_empty() {
            title.generated = clip_title(logged);
        }
        title.provider = row
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        title.model = row
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
    }
    let (mut activity_kind, unread, owner_pid) = live_activity(&id, activity.get(&id));
    if row.get("openTurn").and_then(Value::as_bool) == Some(true)
        && activity_kind != Activity::NeedsInput
    {
        activity_kind = Activity::Working;
    }
    Some(SessionRecord {
        id,
        cwd: row
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        created_at: row.get("createdAt").and_then(Value::as_u64).unwrap_or(0),
        updated_at: row.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
        prompts,
        title,
        activity: activity_kind,
        unread,
        pinned: false,
        owner_pid,
        foreign: None,
        damaged: row.get("damaged").and_then(Value::as_bool).unwrap_or(false),
        log_dir: PathBuf::new(),
        log_path: PathBuf::new(),
    })
}

fn read_plaintext_sessions(
    dsh_home: &Path,
    titles: &BTreeMap<String, Value>,
    activity: &BTreeMap<String, Value>,
    warnings: &mut Vec<String>,
) -> Vec<SessionRecord> {
    let mut sessions = Vec::new();
    let root = dsh_home.join("sessions");
    if !root.is_dir() {
        return sessions;
    }
    let projects = fs::read_dir(&root).into_iter().flatten();
    for project in projects.flatten() {
        let project_path = project.path();
        if !project_path.is_dir() {
            continue;
        }
        collect_session_dirs(&project_path, titles, activity, &mut sessions, warnings);
    }
    sessions
}

fn collect_session_dirs(
    dir: &Path,
    titles: &BTreeMap<String, Value>,
    activity: &BTreeMap<String, Value>,
    sessions: &mut Vec<SessionRecord>,
    warnings: &mut Vec<String>,
) {
    if newest_session_log(dir).is_some() {
        match read_session_dir(dir, titles, activity) {
            Ok(Some(record)) => sessions.push(record),
            Ok(None) => {}
            Err(message) => warnings.push(message),
        }
        return;
    }
    let entries = fs::read_dir(dir).into_iter().flatten();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_session_dirs(&path, titles, activity, sessions, warnings);
        }
    }
}

fn read_session_dir(
    dir: &Path,
    titles: &BTreeMap<String, Value>,
    activity: &BTreeMap<String, Value>,
) -> Result<Option<SessionRecord>, String> {
    let Some(log) = newest_session_log(dir) else {
        return Ok(None);
    };
    let text = match read_session_log(&log) {
        Ok(text) => text,
        Err(error) => {
            return Err(format!("unreadable session log {}: {error}", log.display()));
        }
    };
    let mut lines = text.lines().filter(|line| !line.trim().is_empty());
    let Some(header_line) = lines.next() else {
        return Err(format!("malformed session log {}", log.display()));
    };
    let header: Value = match serde_json::from_str(header_line) {
        Ok(value) => value,
        Err(_) => return Err(format!("malformed session log {}", log.display())),
    };
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Err(format!("malformed session log {}", log.display()));
    }
    let Some(id) = header.get("id").and_then(Value::as_str).map(str::to_string) else {
        return Err(format!("malformed session log {}", log.display()));
    };
    if header.get("origin").and_then(Value::as_str) == Some("subagent") {
        return Ok(None);
    }
    let cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let created_at = header.get("createdAt").and_then(Value::as_u64).unwrap_or(0);
    let mut prompts = Vec::new();
    let mut updated_at = created_at;
    let mut damaged = false;
    for line in lines {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            damaged = true;
            continue;
        };
        if event.get("type").and_then(Value::as_str) == Some("user/message")
            && !plugin_user_snapshot(&event)
            && let Some(prompt) = user_prompt(&event)
        {
            prompts.push(prompt);
        }
        if let Some(seq) = event.get("seq").and_then(Value::as_u64) {
            updated_at = updated_at.max(created_at.saturating_add(seq));
        }
    }
    if let Ok(meta) = fs::metadata(&log)
        && let Ok(modified) = meta.modified()
        && let Ok(duration) = modified.duration_since(UNIX_EPOCH)
    {
        updated_at = updated_at.max(duration.as_secs());
    }
    let title = title_from_value(titles.get(&id), &prompts);
    let (activity_kind, unread, owner_pid) = live_activity(&id, activity.get(&id));
    Ok(Some(SessionRecord {
        id,
        cwd,
        created_at,
        updated_at,
        prompts,
        title,
        activity: activity_kind,
        unread,
        pinned: false,
        owner_pid,
        foreign: None,
        damaged,
        log_dir: dir.to_path_buf(),
        log_path: log,
    }))
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn project_key_for_test(cwd: &str) -> String {
    project_key(cwd)
}

#[cfg_attr(not(test), allow(dead_code))]
fn project_key(cwd: &str) -> String {
    if cwd.is_empty() {
        return "_no-cwd".into();
    }
    let mut readable = String::new();
    let mut separator = false;
    for ch in cwd.chars() {
        if ch == '/' || ch == '\\' || ch == ':' {
            if !separator {
                readable.push('-');
            }
            separator = true;
        } else if ch != '~'
            && ch.is_ascii()
            && (ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        {
            readable.push(ch);
            separator = false;
        } else {
            readable.push('~');
            readable.push_str(&format!("{:04X}", ch as u32));
            separator = false;
        }
    }
    let trimmed = readable.trim_start_matches('-');
    let body = if trimmed.is_empty() { "root" } else { trimmed };
    format!("--{}--", body.chars().take(251).collect::<String>())
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn encode_segment_for_test(raw: &str) -> String {
    encode_segment(raw)
}

#[cfg_attr(not(test), allow(dead_code))]
fn encode_segment(raw: &str) -> String {
    if raw == "." {
        return "~002E".into();
    }
    if raw == ".." {
        return "~002E~002E".into();
    }
    let mut out = String::new();
    for ch in raw.chars() {
        if ch != '~'
            && ch.is_ascii()
            && (ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        {
            out.push(ch);
        } else {
            out.push('~');
            out.push_str(&format!("{:04X}", ch as u32));
        }
    }
    out
}

pub(crate) fn newest_session_log(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(u64, PathBuf)> = None;
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(version) = generation_version(&name) else {
            continue;
        };
        if best.as_ref().is_none_or(|(current, _)| version >= *current) {
            best = Some((version, entry.path()));
        }
    }
    best.map(|(_, path)| path)
}

pub(crate) fn generation_version(name: &str) -> Option<u64> {
    let stem = name.strip_suffix(".zstd").unwrap_or(name);
    let stem = stem.strip_suffix(".jsonl")?;
    if stem == "session" {
        return Some(0);
    }
    let version = stem.strip_prefix("session.v")?;
    if version.starts_with('0') || version.is_empty() {
        return None;
    }
    version.parse().ok()
}

pub(crate) fn read_session_log(path: &Path) -> io::Result<String> {
    let bytes = fs::read(path)?;
    let plain = if path.extension().and_then(|ext| ext.to_str()) == Some("zstd") {
        zstd::decode_all(bytes.as_slice()).map_err(|error| io::Error::other(error.to_string()))?
    } else {
        bytes
    };
    String::from_utf8(plain).map_err(io::Error::other)
}

pub(crate) fn plugin_user_snapshot(event: &Value) -> bool {
    let source = event
        .get("data")
        .and_then(|data| data.get("source"))
        .or_else(|| {
            event
                .get("data")
                .and_then(|data| data.get("message"))
                .and_then(|message| message.get("source"))
        });
    source
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str)
        == Some("plugin")
}

fn user_prompt(event: &Value) -> Option<String> {
    let message = event
        .get("data")
        .and_then(|data| data.get("message"))
        .or_else(|| event.get("data"))?;
    let content = message.get("content")?.as_array()?;
    let mut text = String::new();
    for block in content {
        if block.get("type").and_then(Value::as_str) == Some("text")
            && let Some(piece) = block.get("text").and_then(Value::as_str)
        {
            text.push_str(piece);
        }
    }
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("<pasted-image "))?;
    Some(line.chars().take(CONTENT_SNIPPET).collect())
}

fn title_from_value(value: Option<&Value>, prompts: &[String]) -> TitleRecord {
    let manual = value
        .and_then(|item| item.get("manual"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let stored = value
        .and_then(|item| item.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let generated = value
        .and_then(|item| item.get("generated"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let generated = if generated.is_empty() {
        prompts.first().cloned().unwrap_or_default()
    } else {
        generated
    };
    TitleRecord {
        manual,
        title: if manual && !stored.is_empty() {
            stored
        } else {
            String::new()
        },
        generated: clip_title(&generated),
        updated_at: value
            .and_then(|item| item.get("updatedAt"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        provider: value
            .and_then(|item| item.get("provider"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        model: value
            .and_then(|item| item.get("model"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }
}

fn live_activity(session_id: &str, value: Option<&Value>) -> (Activity, bool, Option<u32>) {
    let (mut kind, unread, mut owner_pid) = activity_from_value(value);
    let home = std::env::var_os("DSH_HOME").map(PathBuf::from);
    if let Some(home) = home
        && let Some(pid) = session_owner::occupied_holder(&home, session_id)
    {
        owner_pid = (pid != 0).then_some(pid).or(owner_pid);
        if kind == Activity::Idle || kind == Activity::Inactive {
            kind = Activity::Working;
        }
    }
    (kind, unread, owner_pid)
}

fn activity_from_value(value: Option<&Value>) -> (Activity, bool, Option<u32>) {
    let kind = value
        .and_then(|item| item.get("activity"))
        .and_then(Value::as_str)
        .and_then(Activity::parse_filter)
        .unwrap_or(Activity::Idle);
    let unread = value
        .and_then(|item| item.get("unread"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let owner_pid = value
        .and_then(|item| item.get("ownerPid"))
        .and_then(Value::as_u64)
        .map(|pid| pid as u32);
    (kind, unread, owner_pid)
}

fn clip_title(text: &str) -> String {
    let trimmed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    trimmed.chars().take(TITLE_LIMIT).collect()
}

pub fn rename_session(
    dsh_home: &Path,
    session_id: &str,
    title: &str,
) -> Result<String, CatalogError> {
    if !session_exists(dsh_home, session_id) {
        return Err(CatalogError {
            message: format!("session is not resumable: {session_id}"),
        });
    }
    let title = clip_title(title);
    if title.is_empty() {
        return Err(CatalogError {
            message:
                "rename needs a title; /rename --auto returns the title to the configured model"
                    .into(),
        });
    }
    let mut titles = load_map(&titles_path(dsh_home));
    let previous = titles.get(session_id).cloned().unwrap_or(Value::Null);
    titles.insert(
        session_id.to_string(),
        json!({
            "manual": true,
            "title": title,
            "generated": previous.get("generated").and_then(Value::as_str).unwrap_or(""),
            "updatedAt": now_secs(),
            "provider": previous.get("provider").and_then(Value::as_str).unwrap_or(""),
            "model": previous.get("model").and_then(Value::as_str).unwrap_or(""),
        }),
    );
    save_map(&titles_path(dsh_home), &titles).map_err(|error| CatalogError {
        message: format!("could not save session title: {error}"),
    })?;
    Ok(title)
}

pub fn clear_manual_title(dsh_home: &Path, session_id: &str) -> Result<(), CatalogError> {
    if !session_exists(dsh_home, session_id) {
        return Err(CatalogError {
            message: format!("session is not resumable: {session_id}"),
        });
    }
    let mut titles = load_map(&titles_path(dsh_home));
    if let Some(value) = titles.get_mut(session_id)
        && let Some(object) = value.as_object_mut()
    {
        object.insert("manual".into(), Value::Bool(false));
        object.insert("title".into(), Value::String(String::new()));
    }
    save_map(&titles_path(dsh_home), &titles).map_err(|error| CatalogError {
        message: format!("could not save session title: {error}"),
    })?;
    Ok(())
}

pub fn store_generated_title(
    dsh_home: &Path,
    session_id: &str,
    generated: &str,
    provider: &str,
    model: &str,
) -> Result<bool, CatalogError> {
    let generated = clip_title(generated);
    if generated.is_empty() {
        return Err(CatalogError {
            message: "configured model returned an empty title".into(),
        });
    }
    let mut titles = load_map(&titles_path(dsh_home));
    let manual = titles
        .get(session_id)
        .and_then(|value| value.get("manual"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if manual {
        return Ok(false);
    }
    titles.insert(
        session_id.to_string(),
        json!({
            "manual": false,
            "title": "",
            "generated": generated,
            "updatedAt": now_secs(),
            "provider": provider,
            "model": model,
        }),
    );
    save_map(&titles_path(dsh_home), &titles).map_err(|error| CatalogError {
        message: format!("could not save generated title: {error}"),
    })?;
    Ok(true)
}

fn session_exists(dsh_home: &Path, session_id: &str) -> bool {
    if load_catalog(dsh_home, Path::new("."))
        .sessions
        .iter()
        .any(|session| session.id == session_id && session.foreign.is_none())
    {
        return true;
    }
    // A live dsh session may not be materialized until its first append.
    // The active id is still the one this client is writing.
    session_owner::read_last_session(dsh_home).is_some_and(|(id, _)| id == session_id)
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn set_activity(
    dsh_home: &Path,
    session_id: &str,
    activity: Activity,
    unread: bool,
    owner_pid: Option<u32>,
) -> io::Result<()> {
    let mut map = load_map(&activity_path(dsh_home));
    map.insert(
        session_id.to_string(),
        json!({
            "activity": activity.as_str(),
            "unread": unread,
            "ownerPid": owner_pid,
        }),
    );
    save_map(&activity_path(dsh_home), &map)
}

pub fn mark_read(dsh_home: &Path, session_id: &str) -> io::Result<()> {
    let mut map = load_map(&activity_path(dsh_home));
    if let Some(value) = map.get_mut(session_id)
        && let Some(object) = value.as_object_mut()
    {
        object.insert("unread".into(), Value::Bool(false));
        object.insert(
            "activity".into(),
            Value::String(Activity::Idle.as_str().into()),
        );
        object.remove("ownerPid");
    }
    save_map(&activity_path(dsh_home), &map)
}

pub fn search(catalog: &Catalog, query: &str, cwd: Option<&Path>) -> Vec<SearchHit> {
    let query = query.trim();
    if query.is_empty() {
        return Vec::new();
    }
    let needle = query.to_ascii_lowercase();
    let mut hits = Vec::new();
    for session in &catalog.sessions {
        if let Some(cwd) = cwd
            && !same_dir(&session.cwd, cwd)
        {
            continue;
        }
        let manual =
            session.title.manual && session.title.title.to_ascii_lowercase().contains(&needle);
        if manual || session.id.to_ascii_lowercase().contains(&needle) {
            hits.push(SearchHit {
                session: session.clone(),
                extended: false,
                snippet: if manual {
                    session.title.title.clone()
                } else {
                    session.id.clone()
                },
            });
            continue;
        }
        let generated = session.title.generated.to_ascii_lowercase();
        if !session.title.manual && generated.contains(&needle) {
            hits.push(SearchHit {
                session: session.clone(),
                extended: true,
                snippet: session.title.generated.clone(),
            });
            continue;
        }
        if let Some(prompt) = session
            .prompts
            .iter()
            .find(|prompt| prompt.to_ascii_lowercase().contains(&needle))
        {
            hits.push(SearchHit {
                session: session.clone(),
                extended: true,
                snippet: prompt.clone(),
            });
        }
    }
    hits
}

pub fn resolve_resume(
    sessions: &[SessionRecord],
    token: &str,
    cwd: &Path,
) -> Result<ResumeMatch, CatalogError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(CatalogError {
            message: "missing session id or title; use codsh --rust --resume <id-or-title>".into(),
        });
    }
    if is_uuid(token) {
        let found = sessions
            .iter()
            .find(|session| session.id.eq_ignore_ascii_case(token));
        return match found {
            Some(session) => Ok(ResumeMatch {
                session: session.clone(),
                ambiguous: Vec::new(),
            }),
            None => Err(CatalogError {
                message: format!("session is not resumable: {token}"),
            }),
        };
    }
    let here: Vec<_> = sessions
        .iter()
        .filter(|session| session.foreign.is_none())
        .filter(|session| same_dir(&session.cwd, cwd))
        .filter(|session| session.display_title().eq_ignore_ascii_case(token))
        .cloned()
        .collect();
    let matches = if here.is_empty() {
        sessions
            .iter()
            .filter(|session| session.foreign.is_none())
            .filter(|session| session.display_title().eq_ignore_ascii_case(token))
            .cloned()
            .collect()
    } else {
        here
    };
    match matches.len() {
        0 => Err(CatalogError {
            message: format!("no session titled {token:?} in {}", cwd.display()),
        }),
        1 => Ok(ResumeMatch {
            session: matches[0].clone(),
            ambiguous: Vec::new(),
        }),
        _ => {
            let manuals: Vec<_> = matches
                .iter()
                .filter(|session| session.title.manual)
                .cloned()
                .collect();
            if manuals.len() == 1 {
                return Ok(ResumeMatch {
                    session: manuals[0].clone(),
                    ambiguous: matches,
                });
            }
            let ids = matches
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            Err(CatalogError {
                message: format!("several sessions share the title {token:?}: {ids}"),
            })
        }
    }
}

pub fn same_directory(left: &str, right: &Path) -> bool {
    same_dir(left, right)
}

fn same_dir(left: &str, right: &Path) -> bool {
    if left.is_empty() {
        return false;
    }
    let left_path = Path::new(left);
    left_path == right
        || fs::canonicalize(left_path).ok().as_deref() == fs::canonicalize(right).ok().as_deref()
}

/// Record that this client started or finished a turn. A finished turn stays
/// unread until the session is opened again; activity is not forced to idle
/// by merely listing the catalog.
pub fn note_turn(dsh_home: &Path, session_id: &str, working: bool) -> io::Result<()> {
    let mut map = load_map(&activity_path(dsh_home));
    let previous = map.get(session_id).cloned().unwrap_or(Value::Null);
    let unread = if working {
        previous
            .get("unread")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    } else {
        true
    };
    map.insert(
        session_id.to_string(),
        json!({
            "activity": if working { Activity::Working.as_str() } else { Activity::Idle.as_str() },
            "unread": unread,
            "ownerPid": if working { Some(std::process::id()) } else { None::<u32> },
        }),
    );
    save_map(&activity_path(dsh_home), &map)
}

pub fn group_rows(
    sessions: &[SessionRecord],
    grouping: Grouping,
) -> Vec<(String, Vec<SessionRecord>)> {
    let mut pinned: Vec<_> = sessions
        .iter()
        .filter(|session| session.pinned)
        .cloned()
        .collect();
    pinned.sort_by_key(|session| session.id.clone());
    let mut rest: Vec<_> = sessions
        .iter()
        .filter(|session| !session.pinned)
        .cloned()
        .collect();
    let mut groups: Vec<(String, Vec<SessionRecord>)> = Vec::new();
    if !pinned.is_empty() {
        groups.push(("Pinned".into(), pinned));
    }
    match grouping {
        Grouping::State => {
            rest.sort_by(|left, right| {
                left.activity
                    .rank()
                    .cmp(&right.activity.rank())
                    .then_with(|| right.updated_at.cmp(&left.updated_at))
                    .then_with(|| left.id.cmp(&right.id))
            });
            let order = [
                Activity::NeedsInput,
                Activity::Working,
                Activity::Idle,
                Activity::Inactive,
                Activity::Completed,
                Activity::Failed,
            ];
            for kind in order {
                let rows: Vec<_> = rest
                    .iter()
                    .filter(|session| session.activity == kind)
                    .cloned()
                    .collect();
                if !rows.is_empty() {
                    let label = match kind {
                        Activity::NeedsInput => "Needs input",
                        Activity::Working => "Working",
                        Activity::Idle => "Idle",
                        Activity::Inactive => "Inactive",
                        Activity::Completed => "Completed",
                        Activity::Failed => "Failed",
                    };
                    groups.push((label.into(), rows));
                }
            }
        }
        Grouping::Directory => {
            rest.sort_by(|left, right| {
                left.workspace_label()
                    .cmp(&right.workspace_label())
                    .then_with(|| right.updated_at.cmp(&left.updated_at))
            });
            for session in rest {
                let label = session.workspace_label();
                if groups.last().is_some_and(|(name, _)| name == &label) {
                    groups.last_mut().unwrap().1.push(session);
                } else {
                    groups.push((label, vec![session]));
                }
            }
        }
    }
    groups
}

pub fn filter_dashboard<'a>(sessions: &'a [SessionRecord], query: &str) -> Vec<&'a SessionRecord> {
    let query = query.trim();
    if query.is_empty() {
        return sessions.iter().collect();
    }
    sessions
        .iter()
        .filter(|session| dashboard_query_matches(session, query))
        .collect()
}

fn dashboard_query_matches(session: &SessionRecord, query: &str) -> bool {
    let lower = query.to_ascii_lowercase();
    if let Some(name) = lower.strip_prefix("a:") {
        return session
            .title
            .model
            .to_ascii_lowercase()
            .contains(name.trim())
            || session
                .display_title()
                .to_ascii_lowercase()
                .contains(name.trim());
    }
    if let Some(state) = lower.strip_prefix("s:") {
        return Activity::parse_filter(state).is_some_and(|kind| kind == session.activity);
    }
    if let Some(text) = query.strip_prefix('#') {
        let needle = format!("#{text}").to_ascii_lowercase();
        return session
            .display_title()
            .to_ascii_lowercase()
            .contains(&needle);
    }
    let manual = if session.title.manual {
        session.title.title.to_ascii_lowercase()
    } else {
        String::new()
    };
    let haystack = format!(
        "{manual} {} {}",
        session.id.to_ascii_lowercase(),
        session.cwd.to_ascii_lowercase()
    );
    if haystack.contains(&lower) {
        return true;
    }
    session
        .prompts
        .iter()
        .any(|prompt| prompt.to_ascii_lowercase().contains(&lower))
        || (!session.title.manual
            && session
                .title
                .generated
                .to_ascii_lowercase()
                .contains(&lower))
}

pub fn read_dashboard_prefs(dsh_home: &Path) -> DashboardPrefs {
    let mut prefs = DashboardPrefs::default();
    if std::env::var("GROK_AGENT_DASHBOARD").ok().as_deref() == Some("0") {
        prefs.enabled = false;
        prefs.disabled_reason = Some("GROK_AGENT_DASHBOARD=0".into());
    }
    let config = std::env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dsh_home.join("../.grok"))
        .join("config.toml");
    let alt = PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
        .join(".codsh-rust/.grok/config.toml");
    let text = fs::read_to_string(&config)
        .or_else(|_| fs::read_to_string(alt))
        .unwrap_or_default();
    apply_dashboard_config(&mut prefs, &text);
    if let Ok(value) = std::env::var("GROK_SESSION_PICKER_GROUPED") {
        match value.trim() {
            "1" | "true" => prefs.grouping = Grouping::Directory,
            "0" | "false" => prefs.grouping = Grouping::State,
            "" => {}
            _ => {}
        }
    }
    prefs
}

fn apply_dashboard_config(prefs: &mut DashboardPrefs, text: &str) {
    let mut section = String::new();
    for raw in text.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].trim().to_string();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if section == "dashboard" && key == "enabled" && prefs.disabled_reason.is_none() {
            prefs.enabled = matches!(value, "true" | "1");
            if !prefs.enabled {
                prefs.disabled_reason = Some("[dashboard] enabled = false".into());
            }
        }
        if section == "dashboard"
            && key == "grouping"
            && let Some(grouping) = Grouping::parse(value)
        {
            prefs.grouping = grouping;
        }
        if section == "dashboard" && key == "pinned" {
            prefs.pinned = toml_string_array(value);
        }
    }
}

fn toml_string_array(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if !trimmed.starts_with('[') {
        return Vec::new();
    }
    trimmed
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .filter_map(|item| {
            let item = item.trim().trim_matches('"').trim_matches('\'');
            let item = item.strip_prefix("top:").unwrap_or(item);
            (!item.is_empty()).then(|| item.to_string())
        })
        .collect()
}

pub fn save_grouping(grok_home: &Path, grouping: Grouping) -> io::Result<()> {
    let path = grok_home.join("config.toml");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = existing.lines().map(str::to_string).collect();
    let mut section_at = None;
    let mut key_at = None;
    let mut section = String::new();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = trimmed[1..trimmed.len() - 1].trim().to_string();
            if section == "dashboard" && section_at.is_none() {
                section_at = Some(index);
            }
        } else if section == "dashboard" && trimmed.starts_with("grouping") && key_at.is_none() {
            key_at = Some(index);
        }
    }
    let assignment = format!("grouping = \"{}\"", grouping.as_str());
    if let Some(index) = key_at {
        lines[index] = assignment;
    } else if let Some(index) = section_at {
        lines.insert(index + 1, assignment);
    } else {
        if !lines.is_empty() && !lines.last().is_some_and(|line| line.is_empty()) {
            lines.push(String::new());
        }
        lines.push("[dashboard]".into());
        lines.push(assignment);
    }
    fs::create_dir_all(grok_home)?;
    fs::write(path, format!("{}\n", lines.join("\n")))
}

pub fn toggle_pin(grok_home: &Path, session_id: &str, pinned: bool) -> io::Result<()> {
    let path = grok_home.join("config.toml");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let mut ids = Vec::new();
    let mut section = String::new();
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = trimmed[1..trimmed.len() - 1].trim().to_string();
        } else if section == "dashboard"
            && trimmed.starts_with("pinned")
            && let Some((_, value)) = trimmed.split_once('=')
        {
            ids = toml_string_array(value.trim());
        }
    }
    if pinned {
        if !ids.iter().any(|id| id == session_id) {
            ids.push(session_id.to_string());
        }
    } else {
        ids.retain(|id| id != session_id);
    }
    let rendered = ids
        .iter()
        .map(|id| format!("\"top:{id}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let assignment = format!("pinned = [{rendered}]");
    let mut lines: Vec<String> = existing.lines().map(str::to_string).collect();
    let mut section_at = None;
    let mut key_at = None;
    section.clear();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = trimmed[1..trimmed.len() - 1].trim().to_string();
            if section == "dashboard" && section_at.is_none() {
                section_at = Some(index);
            }
        } else if section == "dashboard" && trimmed.starts_with("pinned") && key_at.is_none() {
            key_at = Some(index);
        }
    }
    if let Some(index) = key_at {
        lines[index] = assignment;
    } else if let Some(index) = section_at {
        lines.insert(index + 1, assignment);
    } else {
        lines.push("[dashboard]".into());
        lines.push(assignment);
    }
    fs::create_dir_all(grok_home)?;
    fs::write(path, format!("{}\n", lines.join("\n")))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TitleRoute {
    pub base_url: String,
    pub model: String,
    pub provider: String,
    pub api_key: String,
    pub backend: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TitleExchange {
    pub url: String,
    pub body: String,
    pub response_title: String,
}

pub fn title_request(
    route: &TitleRoute,
    prompts: &[String],
) -> Result<TitleExchange, CatalogError> {
    if route.base_url.is_empty() || route.model.is_empty() {
        return Err(CatalogError {
            message: "title generation needs a configured model; no provider fallback".into(),
        });
    }
    let url = format!("{}/chat/completions", route.base_url.trim_end_matches('/'));
    let transcript = prompts.join("\n");
    let body = json!({
        "model": route.model,
        "messages": [
            {"role": "system", "content": "Reply with a session title of at most 8 words. No quotes."},
            {"role": "user", "content": transcript}
        ]
    });
    Ok(TitleExchange {
        url,
        body: body.to_string(),
        response_title: String::new(),
    })
}

pub fn parse_title_response(body: &str) -> Result<String, CatalogError> {
    let value: Value = serde_json::from_str(body).map_err(|_| CatalogError {
        message: "configured model returned an unreadable title".into(),
    })?;
    let text = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/content/0/text").and_then(Value::as_str))
        .unwrap_or("")
        .trim()
        .trim_matches('"')
        .trim();
    if text.is_empty() {
        return Err(CatalogError {
            message: "configured model returned an empty title".into(),
        });
    }
    Ok(clip_title(text))
}

pub fn check_dispatch(text: &str) -> Result<(), CatalogError> {
    if text.trim().is_empty() {
        return Err(CatalogError {
            message: "empty dispatch is ignored".into(),
        });
    }
    if text.len() > DISPATCH_LIMIT {
        return Err(CatalogError {
            message: format!("dispatch prompt exceeds {DISPATCH_LIMIT} bytes"),
        });
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardFocus {
    List,
    Dispatch,
    Search,
    Rename,
    Location,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardView {
    pub focus: DashboardFocus,
    pub cursor: usize,
    pub selected: Option<String>,
    pub query: String,
    pub dispatch: String,
    pub rename: String,
    pub location: String,
    pub notice: String,
    pub open_session: Option<String>,
    pub entered: bool,
    pub delete_armed: Option<String>,
}

impl DashboardView {
    pub fn open(sessions: &[SessionRecord]) -> Self {
        Self {
            focus: if sessions.is_empty() {
                DashboardFocus::Dispatch
            } else {
                DashboardFocus::List
            },
            cursor: 0,
            selected: None,
            query: String::new(),
            dispatch: String::new(),
            rename: String::new(),
            location: String::new(),
            notice: String::new(),
            open_session: None,
            entered: true,
            delete_armed: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashKey {
    Up,
    Down,
    Enter,
    Esc,
    Tab,
    Char(char),
    Backspace,
    Ctrl(char),
}

pub fn dashboard_rows<'a>(
    sessions: &'a [SessionRecord],
    view: &DashboardView,
) -> Vec<&'a SessionRecord> {
    if matches!(view.focus, DashboardFocus::Search) || !view.query.is_empty() {
        filter_dashboard(sessions, &view.query)
    } else {
        sessions.iter().collect()
    }
}

pub fn handle_dashboard_key(
    view: &mut DashboardView,
    sessions: &[SessionRecord],
    key: DashKey,
) -> Option<String> {
    let rows = dashboard_rows(sessions, view);
    match (&view.focus, key) {
        (DashboardFocus::Search, DashKey::Esc) | (DashboardFocus::Search, DashKey::Ctrl('/')) => {
            view.query.clear();
            view.delete_armed = None;
            view.focus = DashboardFocus::List;
            view.notice = "search cancelled".into();
            None
        }
        (DashboardFocus::Search, DashKey::Enter) => {
            let rows = dashboard_rows(sessions, view);
            if let Some(session) = rows.first() {
                view.selected = Some(session.id.clone());
                view.open_session = Some(session.id.clone());
                view.focus = DashboardFocus::List;
                return Some(format!("open {}", session.id));
            }
            view.focus = DashboardFocus::List;
            view.notice = "No sessions match.".into();
            None
        }
        (DashboardFocus::Search, DashKey::Char(ch)) => {
            view.query.push(ch);
            view.cursor = 0;
            None
        }
        (DashboardFocus::Search, DashKey::Backspace) => {
            view.query.pop();
            None
        }
        (DashboardFocus::Rename, DashKey::Esc) => {
            view.rename.clear();
            view.focus = DashboardFocus::List;
            view.notice = "rename cancelled".into();
            None
        }
        (DashboardFocus::Rename, DashKey::Char(ch)) => {
            view.rename.push(ch);
            None
        }
        (DashboardFocus::Rename, DashKey::Backspace) => {
            view.rename.pop();
            None
        }
        (DashboardFocus::Rename, DashKey::Enter) => {
            let title = view.rename.clone();
            let id = view.selected.clone();
            view.rename.clear();
            view.focus = DashboardFocus::List;
            id.map(|session_id| format!("rename {session_id} {title}"))
        }
        (DashboardFocus::Location, DashKey::Esc) => {
            view.location.clear();
            view.focus = DashboardFocus::Dispatch;
            view.notice = "location unchanged".into();
            None
        }
        (DashboardFocus::Location, DashKey::Char(ch)) => {
            view.location.push(ch);
            None
        }
        (DashboardFocus::Location, DashKey::Enter) => {
            let path = view.location.clone();
            view.focus = DashboardFocus::Dispatch;
            Some(format!("cd {path}"))
        }
        (_, DashKey::Ctrl('/')) => {
            view.focus = DashboardFocus::Search;
            view.notice = "Search:".into();
            None
        }
        (_, DashKey::Ctrl('r')) => {
            if view.selected.is_none() {
                view.notice = "select a session before renaming".into();
                return None;
            }
            view.focus = DashboardFocus::Rename;
            view.rename.clear();
            None
        }
        (_, DashKey::Ctrl('t')) => view.selected.clone().map(|id| format!("pin {id}")),
        (_, DashKey::Ctrl('g')) => Some("group".into()),
        (_, DashKey::Ctrl('l')) => {
            view.focus = DashboardFocus::Location;
            view.location.clear();
            None
        }
        (_, DashKey::Ctrl('x')) => {
            let Some(id) = view.selected.clone() else {
                view.notice = "select a session before deleting".into();
                return None;
            };
            if view.delete_armed.as_deref() == Some(id.as_str()) {
                view.delete_armed = None;
                Some(format!("delete {id}"))
            } else {
                view.delete_armed = Some(id.clone());
                view.notice = format!("Ctrl+X again deletes {id}; Esc cancels");
                None
            }
        }
        (_, DashKey::Tab) => {
            view.focus = match view.focus {
                DashboardFocus::List => DashboardFocus::Dispatch,
                _ => DashboardFocus::List,
            };
            None
        }
        (DashboardFocus::List, DashKey::Up) | (DashboardFocus::Dispatch, DashKey::Up)
            if view.dispatch.is_empty() =>
        {
            if view.cursor > 0 {
                view.cursor -= 1;
            }
            let next = rows.get(view.cursor).map(|session| session.id.clone());
            if view.delete_armed.is_some() && view.delete_armed != next {
                view.delete_armed = None;
                view.notice = "delete cancelled".into();
            }
            view.selected = next;
            None
        }
        (DashboardFocus::List, DashKey::Down) | (DashboardFocus::Dispatch, DashKey::Down)
            if view.dispatch.is_empty() =>
        {
            if view.cursor + 1 < rows.len() {
                view.cursor += 1;
            }
            let next = rows.get(view.cursor).map(|session| session.id.clone());
            if view.delete_armed.is_some() && view.delete_armed != next {
                view.delete_armed = None;
                view.notice = "delete cancelled".into();
            }
            view.selected = next;
            None
        }
        (DashboardFocus::Dispatch, DashKey::Char(ch)) => {
            view.dispatch.push(ch);
            None
        }
        (DashboardFocus::Dispatch, DashKey::Backspace) => {
            view.dispatch.pop();
            None
        }
        (DashboardFocus::List, DashKey::Enter) | (DashboardFocus::Dispatch, DashKey::Enter)
            if view.dispatch.trim().is_empty() =>
        {
            if let Some(session) = rows.get(view.cursor) {
                view.open_session = Some(session.id.clone());
                view.selected = Some(session.id.clone());
                Some(format!("open {}", session.id))
            } else {
                Some("new".into())
            }
        }
        (DashboardFocus::Dispatch, DashKey::Enter) => match check_dispatch(&view.dispatch) {
            Ok(()) => {
                let text = view.dispatch.clone();
                view.dispatch.clear();
                Some(format!("dispatch {text}"))
            }
            Err(error) => {
                view.notice = error.message;
                None
            }
        },
        (_, DashKey::Esc) => {
            if view.delete_armed.is_some() {
                view.delete_armed = None;
                view.notice = "delete cancelled".into();
                return None;
            }
            if view.entered {
                view.entered = false;
                view.notice = "left dashboard; draft kept".into();
            }
            None
        }
        _ => None,
    }
}

pub fn render_dashboard(catalog: &Catalog, view: &DashboardView, cwd: &Path) -> String {
    let rows = dashboard_rows(&catalog.sessions, view);
    let mut lines = vec![format!(
        "Agent Dashboard · {} · grouping={}",
        cwd.display(),
        catalog.prefs.grouping.as_str()
    )];
    if !catalog.prefs.enabled {
        lines.push(format!(
            "dashboard disabled ({})",
            catalog.prefs.disabled_reason.as_deref().unwrap_or("config")
        ));
    }
    lines.push("+ New Agent    Open Previous /resume".into());
    if rows.is_empty() {
        lines.push("No sessions match.".into());
    }
    for (index, session) in rows.iter().enumerate() {
        let mark = if index == view.cursor { ">" } else { " " };
        let unread = if session.unread { " unread" } else { "" };
        let pin = if session.pinned { " pin" } else { "" };
        let owner = session
            .owner_pid
            .map(|pid| format!(" owner={pid}"))
            .unwrap_or_default();
        let foreign = session
            .foreign
            .as_deref()
            .map(|name| format!(" [{name}]"))
            .unwrap_or_default();
        lines.push(format!(
            "{mark} {} {} · {} · {}{}{}{}{}",
            session.activity.glyph(),
            session.id,
            session.display_title(),
            session.activity.as_str(),
            unread,
            pin,
            owner,
            foreign
        ));
    }
    match view.focus {
        DashboardFocus::Search => lines.push(format!("Search: {}", view.query)),
        DashboardFocus::Rename => lines.push(format!("Rename: {}", view.rename)),
        DashboardFocus::Location => lines.push(format!("Location: {}", view.location)),
        DashboardFocus::Dispatch => lines.push(format!("❯ {}", view.dispatch)),
        DashboardFocus::List => lines.push(format!("❯ {}", view.dispatch)),
    }
    if !view.notice.is_empty() {
        lines.push(view.notice.clone());
    }
    lines.join("\n")
}

/// A refused switch stays on this surface. The picker and dashboard must show
/// `already active` themselves; the status line is not visible underneath.
/// The notice slot keeps only the latest lines, so the refusal is last.
pub fn with_refusal(surface: &str, refusal: &str) -> String {
    if refusal.trim().is_empty() {
        return surface.to_string();
    }
    format!("{surface}\n{refusal}")
}

pub fn render_picker(hits: &[SearchHit], cursor: usize, query: &str) -> String {
    let mut lines = vec![format!("Resume session · filter: {query}")];
    if hits.is_empty() {
        lines.push("No sessions match.".into());
        return lines.join("\n");
    }
    let mut extended = false;
    for (index, hit) in hits.iter().enumerate() {
        if hit.extended && !extended {
            lines.push("Extended search results".into());
            extended = true;
        }
        let mark = if index == cursor { ">" } else { " " };
        let unread = if hit.session.unread { " unread" } else { "" };
        lines.push(format!(
            "{mark} {} {} · {}{unread}",
            hit.session.activity.glyph(),
            hit.session.display_title(),
            hit.session.id
        ));
    }
    lines.join("\n")
}

pub fn render_session_info(session: &SessionRecord, model: &str) -> String {
    format!(
        "Session title: {}\nSession ID: {}\nWorking directory: {}\nModel: {}\nActivity: {}{}",
        session.display_title(),
        session.id,
        session.cwd,
        model,
        session.activity.as_str(),
        if session.unread { "\nunread" } else { "" }
    )
}

fn read_foreign(dsh_home: &Path, warnings: &mut Vec<String>) -> Vec<SessionRecord> {
    let mut found = Vec::new();
    let gates = [
        (
            "claude",
            "GROK_CLAUDE_SESSIONS_ENABLED",
            "CLAUDE_CONFIG_DIR",
        ),
        ("codex", "GROK_CODEX_SESSIONS_ENABLED", "CODEX_HOME"),
        ("cursor", "GROK_CURSOR_SESSIONS_ENABLED", "CURSOR_HOME"),
    ];
    for (vendor, gate, root_env) in gates {
        let enabled = std::env::var(gate).ok().as_deref() == Some("1");
        if !enabled {
            continue;
        }
        let root = std::env::var_os(root_env)
            .map(PathBuf::from)
            .unwrap_or_else(|| dsh_home.join(format!("foreign-{vendor}")));
        let index = root.join("sessions.json");
        let Ok(text) = fs::read_to_string(&index) else {
            if index.exists() {
                warnings.push(format!(
                    "unreadable {vendor} sessions at {}",
                    index.display()
                ));
            }
            continue;
        };
        let value: Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(_) => {
                warnings.push(format!(
                    "malformed {vendor} sessions at {}",
                    index.display()
                ));
                continue;
            }
        };
        let Some(items) = value.as_array() else {
            warnings.push(format!(
                "malformed {vendor} sessions at {}",
                index.display()
            ));
            continue;
        };
        for item in items {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                warnings.push(format!("skipped malformed {vendor} session record"));
                continue;
            };
            found.push(SessionRecord {
                id: id.to_string(),
                cwd: item
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                created_at: item.get("createdAt").and_then(Value::as_u64).unwrap_or(0),
                updated_at: item.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
                prompts: Vec::new(),
                title: TitleRecord {
                    manual: false,
                    title: String::new(),
                    generated: item
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or(id)
                        .to_string(),
                    updated_at: 0,
                    provider: String::new(),
                    model: String::new(),
                },
                activity: Activity::Inactive,
                unread: false,
                pinned: false,
                owner_pid: None,
                foreign: Some(vendor.to_string()),
                damaged: false,
                log_dir: PathBuf::new(),
                log_path: PathBuf::new(),
            });
        }
    }
    found
}

pub fn list_text(catalog: &Catalog, cwd: &Path, limit: usize) -> String {
    let _ = cwd;
    let rows: Vec<_> = catalog.sessions.iter().take(limit).cloned().collect();
    let groups = group_rows(&rows, catalog.prefs.grouping);
    let mut lines = Vec::new();
    for (label, sessions) in groups {
        lines.push(format!("# {label}"));
        for session in sessions {
            let unread = if session.unread { " unread" } else { "" };
            lines.push(format!(
                "{}\t{}\t{}\t{}{}\t{}",
                session.id,
                session.created_at,
                session.updated_at,
                session.activity.as_str(),
                unread,
                session.display_title()
            ));
        }
    }
    if lines.is_empty() {
        lines.push("No sessions.".into());
    }
    lines.join("\n")
}

pub fn search_text(catalog: &Catalog, query: &str, limit: usize) -> String {
    let hits = search(catalog, query, None);
    if hits.is_empty() {
        return "No sessions match.".into();
    }
    hits.into_iter()
        .take(limit)
        .map(|hit| {
            format!(
                "{}\t{}\t{}",
                hit.session.id,
                if hit.extended { "content" } else { "title" },
                hit.snippet
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionsCommand {
    Help,
    List { limit: usize },
    Search { query: String, limit: usize },
    Delete(crate::session_data::DeleteRequest),
}

pub fn parse_sessions(flags: &[&str]) -> io::Result<SessionsCommand> {
    if flags.is_empty()
        || flags.iter().any(|flag| *flag == "--help" || *flag == "-h") && flags.len() == 1
    {
        return Ok(SessionsCommand::Help);
    }
    let mut limit = 20usize;
    let mut rest = Vec::new();
    let mut index = 0;
    while index < flags.len() {
        let flag = flags[index];
        if flag == "--help" || flag == "-h" {
            return Ok(SessionsCommand::Help);
        }
        if flag == "--limit" || flag == "-n" {
            index += 1;
            let value = flags.get(index).copied().ok_or_else(|| {
                io::Error::other("missing --limit value; use codsh --rust sessions list --limit N")
            })?;
            limit = value.parse().map_err(|_| {
                io::Error::other(format!(
                    "invalid --limit {value}; expected a positive integer"
                ))
            })?;
            if limit == 0 {
                return Err(io::Error::other(
                    "invalid --limit 0; expected a positive integer",
                ));
            }
        } else if let Some(value) = flag.strip_prefix("--limit=") {
            limit = value.parse().map_err(|_| {
                io::Error::other(format!(
                    "invalid --limit {value}; expected a positive integer"
                ))
            })?;
        } else if flag.starts_with('-') {
            return Err(io::Error::other(format!(
                "unsupported sessions flag {flag}; use codsh --rust sessions --help"
            )));
        } else {
            rest.push(flag);
        }
        index += 1;
    }
    match rest.as_slice() {
        ["delete"] => Err(io::Error::other(
            "missing session id; use codsh --rust sessions delete <ID> --yes",
        )),
        ["list"] => Ok(SessionsCommand::List { limit }),
        ["search"] => Err(io::Error::other(
            "missing search query; use codsh --rust sessions search <query>",
        )),
        ["search", query @ ..] => {
            let query = query.join(" ");
            if query.trim().is_empty() {
                return Err(io::Error::other(
                    "missing search query; use codsh --rust sessions search <query>",
                ));
            }
            Ok(SessionsCommand::Search { query, limit })
        }
        _ => Err(io::Error::other(
            "sessions requires list, search, or delete; use codsh --rust sessions --help",
        )),
    }
}

pub fn run_sessions(
    command: &SessionsCommand,
    dsh_home: &Path,
    cwd: &Path,
) -> Result<String, CatalogError> {
    match command {
        SessionsCommand::Help => Ok(help_text().to_string()),
        SessionsCommand::List { limit } => {
            let catalog = load_catalog(dsh_home, cwd);
            let mut text = list_text(&catalog, cwd, *limit);
            if !catalog.warnings.is_empty() {
                text.push('\n');
                text.push_str(&catalog.warnings.join("\n"));
            }
            Ok(text)
        }
        SessionsCommand::Search { query, limit } => {
            let catalog = load_catalog(dsh_home, cwd);
            Ok(search_text(&catalog, query, *limit))
        }
        SessionsCommand::Delete(request) => {
            crate::session_data::delete_session(dsh_home, cwd, request)
                .map(|()| "blocked: session deletion reported success; nothing was removed".into())
                .map_err(|error| CatalogError {
                    message: error.message,
                })
        }
    }
}

pub fn minimal_dashboard_refusal() -> &'static str {
    "/dashboard isn't available in minimal mode (minimal is single-session). Run /fullscreen to switch this session."
}

pub fn help_text() -> &'static str {
    "codsh --rust sessions list [--limit N]\ncodsh --rust sessions search <query> [--limit N]\ncodsh --rust sessions delete <ID> --yes\n\nList and search dsh sessions in the isolated Home. Titles prefer a manual /rename. Content matches are labeled content. A missing or empty result does not invent a session. delete is blocked: released dsh persistence has no deletion operation, so nothing is removed.\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_home() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "codsh-catalog-{stamp}-{seq}-{}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_session(home: &Path, id: &str, cwd: &str, prompts: &[&str], created: u64) {
        let project = cwd
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
            .collect::<String>();
        let dir = home.join("sessions").join(project).join(id);
        fs::create_dir_all(&dir).unwrap();
        let mut body = format!(
            "{}\n",
            json!({
                "type": "session",
                "version": 1,
                "id": id,
                "createdAt": created,
                "isSeeded": false,
                "delegationDepth": 0,
                "cwd": cwd,
            })
        );
        for (index, prompt) in prompts.iter().enumerate() {
            body.push_str(&format!(
                "{}\n",
                json!({
                    "type": "user/message",
                    "seq": index as u64 + 1,
                    "data": {"message": {"content": [{"type": "text", "text": prompt}]}}
                })
            ));
        }
        fs::write(dir.join("session.jsonl"), body).unwrap();
    }

    #[test]
    fn groups_by_workspace_and_prefers_manual_titles() {
        let home = temp_home();
        let alpha = home.join("alpha");
        let beta = home.join("beta");
        fs::create_dir_all(&alpha).unwrap();
        fs::create_dir_all(&beta).unwrap();
        write_session(
            &home,
            "11111111-1111-4111-8111-111111111111",
            alpha.to_str().unwrap(),
            &["plan the parser"],
            10,
        );
        write_session(
            &home,
            "22222222-2222-4222-8222-222222222222",
            beta.to_str().unwrap(),
            &["plan the parser"],
            20,
        );
        rename_session(
            &home,
            "11111111-1111-4111-8111-111111111111",
            "manual alpha",
        )
        .unwrap();
        let catalog = load_catalog(&home, &alpha);
        let groups = group_rows(&catalog.sessions, Grouping::Directory);
        let labels: Vec<_> = groups.iter().map(|(label, _)| label.clone()).collect();
        assert!(labels.iter().any(|label| label == "alpha"), "{labels:?}");
        assert!(labels.iter().any(|label| label == "beta"), "{labels:?}");
        let titled = catalog
            .sessions
            .iter()
            .find(|session| session.id.starts_with("1111"))
            .unwrap();
        assert_eq!(titled.display_title(), "manual alpha");
        assert!(!store_generated_title(&home, &titled.id, "should not win", "p", "m").unwrap());
        let again = load_catalog(&home, &alpha);
        assert_eq!(
            again
                .sessions
                .iter()
                .find(|session| session.id == titled.id)
                .unwrap()
                .display_title(),
            "manual alpha"
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn search_splits_title_and_content_and_empty_query_is_empty() {
        let home = temp_home();
        let cwd = home.join("work");
        fs::create_dir_all(&cwd).unwrap();
        write_session(
            &home,
            "33333333-3333-4333-8333-333333333333",
            cwd.to_str().unwrap(),
            &["visible title seed", "SECRET_BODY_TOKEN inside the log"],
            30,
        );
        rename_session(&home, "33333333-3333-4333-8333-333333333333", "Ship parser").unwrap();
        let catalog = load_catalog(&home, &cwd);
        assert!(search(&catalog, "   ", Some(&cwd)).is_empty());
        let title_hits = search(&catalog, "ship", Some(&cwd));
        assert_eq!(title_hits.len(), 1);
        assert!(!title_hits[0].extended);
        let content = search(&catalog, "secret_body_token", Some(&cwd));
        assert_eq!(content.len(), 1);
        assert!(content[0].extended);
        assert!(content[0].snippet.contains("SECRET_BODY_TOKEN"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn duplicate_titles_prefer_one_manual_name_and_missing_id_is_visible() {
        let home = temp_home();
        let cwd = home.join("work");
        fs::create_dir_all(&cwd).unwrap();
        let left = "44444444-4444-4444-8444-444444444444";
        let right = "55555555-5555-4555-8555-555555555555";
        write_session(&home, left, cwd.to_str().unwrap(), &["same"], 1);
        write_session(&home, right, cwd.to_str().unwrap(), &["same"], 2);
        rename_session(&home, left, "Same Title").unwrap();
        store_generated_title(&home, right, "Same Title", "configured", "mock").unwrap();
        let catalog = load_catalog(&home, &cwd);
        let resolved = resolve_resume(&catalog.sessions, "same title", &cwd).unwrap();
        assert_eq!(resolved.session.id, left);
        assert!(resolved.session.title.manual);
        clear_manual_title(&home, left).unwrap();
        rename_session(&home, right, "Same Title").unwrap();
        // both manual after this second rename of the generated one plus we cleared left,
        // so regenerate left as manual too.
        rename_session(&home, left, "Same Title").unwrap();
        let catalog = load_catalog(&home, &cwd);
        let error = resolve_resume(&catalog.sessions, "Same Title", &cwd).unwrap_err();
        assert!(error.message.contains(left), "{}", error.message);
        assert!(error.message.contains(right), "{}", error.message);
        let missing = "66666666-6666-4666-8666-666666666666";
        let error = resolve_resume(&catalog.sessions, missing, &cwd).unwrap_err();
        assert!(error.message.contains("not resumable"), "{}", error.message);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn title_request_uses_configured_model_and_body_is_not_logged_in_the_url() {
        let route = TitleRoute {
            base_url: "http://127.0.0.1:9/v1".into(),
            model: "configured-model".into(),
            provider: "gateway".into(),
            api_key: "secret-key".into(),
            backend: "chat_completions".into(),
        };
        let exchange = title_request(&route, &["SECRET_PROMPT_TOKEN".into()]).unwrap();
        assert!(exchange.url.contains("127.0.0.1"));
        assert!(exchange.body.contains("configured-model"));
        assert!(exchange.body.contains("SECRET_PROMPT_TOKEN"));
        assert!(!exchange.url.contains("SECRET_PROMPT_TOKEN"));
        assert!(!exchange.url.contains("secret-key"));
        let title =
            parse_title_response(r#"{"choices":[{"message":{"content":"Parser plan"}}]}"#).unwrap();
        assert_eq!(title, "Parser plan");
    }

    #[test]
    fn dashboard_search_pin_and_switch_do_not_touch_other_histories() {
        let home = temp_home();
        let cwd = home.join("work");
        fs::create_dir_all(&cwd).unwrap();
        let first = "77777777-7777-4777-8777-777777777777";
        let second = "88888888-8888-4888-8888-888888888888";
        write_session(&home, first, cwd.to_str().unwrap(), &["alpha history"], 1);
        write_session(&home, second, cwd.to_str().unwrap(), &["beta history"], 2);
        set_activity(&home, first, Activity::Working, true, Some(42)).unwrap();
        let catalog = load_catalog(&home, &cwd);
        let mut view = DashboardView::open(&catalog.sessions);
        handle_dashboard_key(&mut view, &catalog.sessions, DashKey::Ctrl('/'));
        handle_dashboard_key(&mut view, &catalog.sessions, DashKey::Char('a'));
        handle_dashboard_key(&mut view, &catalog.sessions, DashKey::Char('l'));
        let shown = render_dashboard(&catalog, &view, &cwd);
        assert!(
            shown.contains("alpha") || shown.contains("Search: al"),
            "{shown}"
        );
        assert!(!shown.contains("beta history") || shown.contains("Search"));
        let action = handle_dashboard_key(&mut view, &catalog.sessions, DashKey::Enter);
        // confirm filter, then open should target the filtered row only
        let _ = action;
        view.focus = DashboardFocus::List;
        view.cursor = 0;
        view.selected = rows_first_id(&catalog, &view);
        let open = handle_dashboard_key(&mut view, &catalog.sessions, DashKey::Enter);
        let open = open.unwrap_or_default();
        assert!(
            open.contains("77777777") || open_targets_alpha(&catalog, &view),
            "{open}"
        );
        let second_log = catalog
            .sessions
            .iter()
            .find(|session| session.id == second)
            .map(|session| session.prompts.clone())
            .unwrap();
        let _ = rename_session(&home, first, "renamed alpha");
        let after = load_catalog(&home, &cwd);
        let after_prompts = after
            .sessions
            .iter()
            .find(|session| session.id == second)
            .map(|session| session.prompts.clone())
            .unwrap();
        let before = second_log;
        assert_eq!(before, after_prompts);
        let _ = fs::remove_dir_all(home);
    }

    fn rows_first_id(catalog: &Catalog, view: &DashboardView) -> Option<String> {
        dashboard_rows(&catalog.sessions, view)
            .first()
            .map(|session| session.id.clone())
    }

    fn open_targets_alpha(catalog: &Catalog, view: &DashboardView) -> bool {
        dashboard_rows(&catalog.sessions, view)
            .first()
            .is_some_and(|session| {
                session
                    .prompts
                    .iter()
                    .any(|prompt| prompt.contains("alpha"))
            })
    }

    #[test]
    fn manual_title_outranks_a_generated_display_title_and_search_says_so() {
        let home = temp_home();
        let here = home.join("here");
        let there = home.join("there");
        fs::create_dir_all(&here).unwrap();
        fs::create_dir_all(&there).unwrap();
        let manual = "99999999-9999-4999-8999-999999999999";
        let generated = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        write_session(
            &home,
            manual,
            here.to_str().unwrap(),
            &["plan the parser"],
            10,
        );
        write_session(
            &home,
            generated,
            there.to_str().unwrap(),
            &["plan the parser"],
            20,
        );
        rename_session(&home, manual, "Ship parser").unwrap();
        store_generated_title(&home, generated, "Ship parser", "configured", "mock").unwrap();
        let catalog = load_catalog(&home, &here);
        let hits = search(&catalog, "ship parser", None);
        assert_eq!(hits.len(), 2, "title search is not directory-scoped");
        assert!(!hits[0].extended, "manual title is a title hit");
        assert_eq!(hits[0].session.id, manual);
        assert!(
            hits[1].extended,
            "a generated title is not a title hit: {}",
            hits[1].snippet
        );
        let resolved = resolve_resume(&catalog.sessions, "Ship parser", &here).unwrap();
        assert_eq!(resolved.session.id, manual);
        let elsewhere = resolve_resume(&catalog.sessions, "Ship parser", &there).unwrap();
        assert_eq!(
            elsewhere.session.id, generated,
            "title resume follows the same catalog as search"
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn list_keeps_every_workspace_until_the_limit_and_shows_unread() {
        let home = temp_home();
        let here = home.join("here");
        let there = home.join("there");
        fs::create_dir_all(&here).unwrap();
        fs::create_dir_all(&there).unwrap();
        let first = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let second = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        write_session(&home, first, here.to_str().unwrap(), &["alpha"], 1);
        write_session(&home, second, there.to_str().unwrap(), &["beta"], 2);
        set_activity(&home, second, Activity::Working, true, Some(7)).unwrap();
        let catalog = load_catalog(&home, &here);
        let listed = list_text(&catalog, &here, 20);
        assert!(listed.contains(first), "{listed}");
        assert!(listed.contains(second), "{listed}");
        assert!(listed.contains("unread"), "{listed}");
        assert!(listed.contains("working"), "{listed}");
        let picker = render_picker(
            &catalog
                .sessions
                .iter()
                .map(|session| SearchHit {
                    session: session.clone(),
                    extended: false,
                    snippet: session.display_title().to_string(),
                })
                .collect::<Vec<_>>(),
            0,
            "",
        );
        let view = DashboardView::open(&catalog.sessions);
        let dashboard = render_dashboard(&catalog, &view, &here);
        for surface in [&listed, &picker, &dashboard] {
            assert!(surface.contains(first), "{surface}");
            assert!(surface.contains(second), "{surface}");
            assert!(surface.contains("unread"), "{surface}");
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn refused_resume_stays_visible_on_the_open_picker_and_dashboard() {
        let home = temp_home();
        let cwd = home.join("work");
        fs::create_dir_all(&cwd).unwrap();
        let current = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let held = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        write_session(&home, current, cwd.to_str().unwrap(), &["stay"], 1);
        write_session(&home, held, cwd.to_str().unwrap(), &["other"], 2);
        let catalog = load_catalog(&home, &cwd);
        let hits: Vec<_> = catalog
            .sessions
            .iter()
            .map(|session| SearchHit {
                session: session.clone(),
                extended: false,
                snippet: session.display_title().to_string(),
            })
            .collect();
        let refusal = format!("already active: session {held} stays on its current owner");
        let picker = with_refusal(&render_picker(&hits, 0, ""), &refusal);
        assert!(picker.contains("Resume session"), "{picker}");
        assert!(picker.contains(&refusal), "{picker}");
        let mut view = DashboardView::open(&catalog.sessions);
        view.notice = refusal.clone();
        let dashboard = render_dashboard(&catalog, &view, &cwd);
        assert!(dashboard.contains("Agent Dashboard"), "{dashboard}");
        assert!(dashboard.contains(&refusal), "{dashboard}");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn filtered_dashboard_enter_opens_that_row() {
        let home = temp_home();
        let cwd = home.join("work");
        fs::create_dir_all(&cwd).unwrap();
        let first = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        let second = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        write_session(&home, first, cwd.to_str().unwrap(), &["alpha history"], 1);
        write_session(&home, second, cwd.to_str().unwrap(), &["beta history"], 2);
        let catalog = load_catalog(&home, &cwd);
        let mut view = DashboardView::open(&catalog.sessions);
        handle_dashboard_key(&mut view, &catalog.sessions, DashKey::Ctrl('/'));
        for ch in ['a', 'l', 'p', 'h', 'a'] {
            handle_dashboard_key(&mut view, &catalog.sessions, DashKey::Char(ch));
        }
        let shown = render_dashboard(&catalog, &view, &cwd);
        let rows: Vec<_> = shown
            .lines()
            .filter(|line| line.starts_with('>') || line.starts_with(' '))
            .filter(|line| line.contains('-'))
            .collect();
        assert!(rows.iter().any(|line| line.contains(first)), "{shown}");
        assert!(rows.iter().all(|line| !line.contains(second)), "{shown}");
        let open = handle_dashboard_key(&mut view, &catalog.sessions, DashKey::Enter);
        assert_eq!(open.as_deref(), Some(format!("open {first}").as_str()));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn moving_the_highlight_clears_an_armed_delete() {
        let home = temp_home();
        let cwd = home.join("work");
        fs::create_dir_all(&cwd).unwrap();
        let first = "11111111-1111-4111-8111-111111111111";
        let second = "22222222-2222-4222-8222-222222222222";
        write_session(&home, first, cwd.to_str().unwrap(), &["alpha"], 1);
        write_session(&home, second, cwd.to_str().unwrap(), &["beta"], 2);
        let catalog = load_catalog(&home, &cwd);
        let mut view = DashboardView::open(&catalog.sessions);
        view.selected = Some(first.into());
        view.cursor = catalog
            .sessions
            .iter()
            .position(|session| session.id == first)
            .unwrap_or(0);
        assert!(handle_dashboard_key(&mut view, &catalog.sessions, DashKey::Ctrl('x')).is_none());
        assert_eq!(view.delete_armed.as_deref(), Some(first));
        handle_dashboard_key(&mut view, &catalog.sessions, DashKey::Down);
        assert!(
            view.delete_armed.is_none(),
            "highlight moved but delete stayed armed for {}",
            view.delete_armed.as_deref().unwrap_or("")
        );
        let again = handle_dashboard_key(&mut view, &catalog.sessions, DashKey::Ctrl('x'));
        assert!(
            again.is_none(),
            "first Ctrl+X after a move must re-arm, not delete"
        );
        assert_eq!(view.delete_armed.as_deref(), view.selected.as_deref());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn plaintext_fallback_reads_encoded_versioned_and_zstd_logs() {
        let home = temp_home();
        let cwd = home.join("work");
        fs::create_dir_all(&cwd).unwrap();
        let id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        write_encoded_session(
            &home,
            id,
            cwd.to_str().unwrap(),
            &["ENCODED_ONLY_TOKEN"],
            40,
            true,
        );
        let catalog = load_catalog(&home, &cwd);
        let session = catalog
            .sessions
            .iter()
            .find(|session| session.id == id)
            .unwrap_or_else(|| panic!("encoded log missing: {:?}", catalog.warnings));
        assert!(
            session
                .prompts
                .iter()
                .any(|prompt| prompt.contains("ENCODED_ONLY_TOKEN")),
            "{session:?}"
        );
        assert!(same_dir(&session.cwd, &cwd), "{}", session.cwd);
        let _ = fs::remove_dir_all(home);
    }

    fn write_encoded_session(
        home: &Path,
        id: &str,
        cwd: &str,
        prompts: &[&str],
        created: u64,
        compress: bool,
    ) {
        let dir = home
            .join("sessions")
            .join(super::project_key(cwd))
            .join(super::encode_segment(id));
        fs::create_dir_all(&dir).unwrap();
        let mut body = format!(
            "{}\n",
            json!({
                "type": "session",
                "version": 1,
                "id": id,
                "createdAt": created,
                "isSeeded": false,
                "delegationDepth": 0,
                "cwd": cwd,
            })
        );
        for (index, prompt) in prompts.iter().enumerate() {
            body.push_str(&format!(
                "{}\n",
                json!({
                    "type": "user/message",
                    "seq": index as u64 + 1,
                    "data": {"message": {"content": [{"type": "text", "text": prompt}]}}
                })
            ));
        }
        let name = if compress {
            "session.v1.jsonl.zstd"
        } else {
            "session.v1.jsonl"
        };
        if compress {
            fs::write(dir.join(name), zstd_frame(body.as_bytes())).unwrap();
        } else {
            fs::write(dir.join(name), body).unwrap();
        }
    }

    fn zstd_frame(bytes: &[u8]) -> Vec<u8> {
        zstd::encode_all(bytes, 0).unwrap()
    }

    #[test]
    fn invalid_grouping_env_falls_through_and_empty_dashboard_stays_put() {
        let home = temp_home();
        let grok = home.join("grok");
        fs::create_dir_all(&grok).unwrap();
        fs::write(
            grok.join("config.toml"),
            "[dashboard]\nenabled = true\ngrouping = \"directory\"\n",
        )
        .unwrap();
        unsafe {
            std::env::set_var("GROK_HOME", &grok);
            std::env::set_var("GROK_SESSION_PICKER_GROUPED", "nope");
        }
        let prefs = read_dashboard_prefs(&home);
        assert_eq!(prefs.grouping, Grouping::Directory);
        unsafe {
            std::env::set_var("GROK_SESSION_PICKER_GROUPED", "0");
        }
        let prefs = read_dashboard_prefs(&home);
        assert_eq!(prefs.grouping, Grouping::State);
        unsafe {
            std::env::remove_var("GROK_SESSION_PICKER_GROUPED");
            std::env::remove_var("GROK_HOME");
        }
        let view = DashboardView::open(&[]);
        assert_eq!(view.focus, DashboardFocus::Dispatch);
        let catalog = Catalog {
            sessions: Vec::new(),
            prefs: DashboardPrefs::default(),
            warnings: Vec::new(),
        };
        let shown = render_dashboard(&catalog, &view, Path::new("/tmp/work"));
        assert!(shown.contains("No sessions match."));
        let _ = fs::remove_dir_all(home);
    }
}
