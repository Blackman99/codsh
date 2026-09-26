//! Automatic memory capture, Dream consolidation, and content-free
//! diagnostics for the legacy local store (ticket 54, issue #186).
//!
//! The storage generation is the reference default: `memory/` with
//! `MEMORY.md`, `sessions/*.md`, and `index.sqlite` (see `memory.rs`).
//! `[memory_v2] enabled = true` selects the reference topics/observations
//! store, which this client does not implement; capture and Dream then stay
//! off with that reason and `memory-v2/` is never touched.
//!
//! Behavior follows grok-build at the commit pinned in
//! `rust/upstream/import.json`:
//! - session end (`xai-grok-shell/src/session/memory/hooks.rs`): a metadata
//!   summary, no model call, only after 3 typed prompts of 50 bytes in total;
//! - flush (`xai-grok-memory/src/flush.rs`): the last 20 messages go to the
//!   session model, the answer is appended to a daily session log;
//! - Dream (`xai-grok-memory/src/dream.rs`, `dream_lock.rs`, and
//!   `xai-grok-shell/src/session/acp_session_impl/memory_dream.rs`): gates,
//!   a cross-process mutex, a consolidation marker, and a rewrite of the
//!   workspace `MEMORY.md`.
//!
//! Local deviations, each to keep a manual edit: a session log that already
//! exists is appended to, never overwritten; Dream refuses to write when
//! `MEMORY.md` changed while the model ran and keeps the previous version
//! in `sessions/.archive/`; consolidated session logs are archived there
//! instead of deleted. The prompt texts are copied verbatim (Apache-2.0).

use crate::memory::{self, Store};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Session end saves only after this many typed prompts...
pub const SESSION_MIN_QUERIES: usize = 3;
/// ...carrying at least this many bytes together.
pub const SESSION_MIN_BYTES: usize = 50;
pub const SESSION_MAX_TOPICS: usize = 5;
const TOPIC_CHARS: usize = 100;
const SLUG_CHARS: usize = 30;
/// Messages of the current session a flush sends (the reference window).
pub const FLUSH_WINDOW: usize = 20;
pub const FLUSH_CLOSER: &str = "Now write the memory summary as described in the system prompt.";
const MAX_DREAM_INPUT_CHARS: usize = 32_000;
const MAX_DREAM_CHARS: usize = 16_000;
/// A session log touched this recently is not archived (a concurrent
/// session may still append to it).
const CLEANUP_RECENCY_GUARD_SECS: u64 = 300;
/// The Dream model call may take 30 minutes; a younger lock is never taken
/// over while its process lives.
const DREAM_MIN_STALE_SECS: u64 = 3_600;
const MUTEX_FILE: &str = ".dream-mutex";
const CONSOLIDATED_FILE: &str = ".dream-consolidated";
const LEGACY_MARKER_FILE: &str = ".dream-lock";
const STATUS_FILE: &str = ".memory-status.json";
const SESSIONS: &str = "sessions";
const ARCHIVE: &str = ".archive";
const MEMORY_FILE: &str = "MEMORY.md";

/// `FLUSH_SYSTEM_PROMPT` of xai-grok-memory/src/flush.rs, verbatim.
pub const FLUSH_SYSTEM_PROMPT: &str = "\
You are a memory assistant. Extract ALL useful information from this conversation \
that would help you be more effective in future sessions with this user. \
Write a concise markdown summary with ## headers covering:

- **Decisions & rationale** — what was chosen and why
- **Technical context** — architecture, APIs, patterns, tools, file paths discussed
- **Debugging techniques & tools** — external APIs, CLI commands, query patterns, \
investigation workflows, or services discovered or used during debugging
- **Problems & solutions** — bugs found, how they were fixed, workarounds

Prioritize reusable mechanisms, rules, and root causes over a narration of the task. \
When project structure matters, name the concrete directories and stable repo-relative paths; \
include an absolute workspace root only when it is operationally necessary and appears in the conversation. \
Copy exact identifiers and numerical values only when they appear verbatim in the supplied conversation. \
Never infer a missing value; omit the detail instead.

Omit any section where there is nothing substantive to report. \
Do NOT include user preferences like OS, shell, or editor — these belong in global memory. \
Do NOT include an ephemeral progress section — transient status is not useful for future sessions.

Respond with NO_REPLY if nothing genuinely useful was learned — a routine task \
that followed standard patterns, brief Q&A, or sessions with no novel decisions \
or discoveries are not worth persisting. Only write content that a future session \
would concretely benefit from.";

/// `FLUSH_DELTA_SYSTEM_PROMPT` of xai-grok-memory/src/flush.rs, verbatim.
/// The previous flush of this session follows it.
pub const FLUSH_DELTA_SYSTEM_PROMPT: &str = "\
You are a memory assistant performing an incremental update. The previous \
flush output for this session is shown below. Extract ONLY information that \
is NEW since the previous flush — do not repeat anything already captured.

Write a concise markdown summary with ## headers covering only NEW items in:
- **Decisions & rationale** — new decisions since last flush
- **Technical context** — new architecture, APIs, patterns discovered
- **Debugging techniques** — new techniques used since last flush
- **Problems & solutions** — new bugs found and fixes

Prioritize reusable mechanisms, rules, and root causes over a narration of the task. \
When project structure matters, name the concrete directories and stable repo-relative paths; \
include an absolute workspace root only when it is operationally necessary and appears in the conversation. \
Copy exact identifiers and numerical values only when they appear verbatim in the supplied conversation; \
never reconstruct or guess missing values.

Omit any section that has no new content. Do NOT include user preferences \
like OS, shell, or editor — these are captured in global memory.
Do NOT include 'Current state' — this is ephemeral and not useful for future sessions.

Respond with NO_REPLY if nothing genuinely new and useful has happened since \
the previous flush. Routine changes that follow standard patterns are not worth \
an incremental update.

--- Previous flush content ---
";

/// `DREAM_SYSTEM_PROMPT` of xai-grok-memory/src/dream.rs, verbatim.
pub const DREAM_SYSTEM_PROMPT: &str = "\
You are performing a dream \u{2014} a reflective pass over memory files. \
Synthesize recent session logs into durable, well-organized memories \
so future sessions orient quickly.

You will receive the contents of recent session logs. \
You may also receive an existing memory document \u{2014} merge it with new sessions \
rather than discarding prior knowledge. Your job:

1. **Merge** related information into coherent topic summaries
2. **Resolve** contradictions \u{2014} if a recent session disproves an older fact, keep only the current truth
3. **Convert** relative dates (\"yesterday\", \"last week\") to absolute dates
4. **Discard** ephemeral details:
   - Greetings, meta-commentary, tool output noise
   - Message counts and tool-usage statistics
   - 'Current state' and 'Next steps' sections
   - User preferences already in global memory (OS, shell, editor)
   - Session metadata (dates, message counts)
5. **Preserve** decisions, rationale, architecture, preferences, and problem/solution pairs
6. **Generalize** task narratives into reusable mechanisms, rules, and root causes
7. **Ground details** — use stable repo-relative paths for project structure; include an absolute \
workspace root only when operationally necessary and present in the session logs. Copy exact \
identifiers and numerical values only when they appear verbatim in the input; omit unsupported details

Respond with a single markdown document. Use ## headers to separate topics. \
Each topic should be self-contained and useful to a future session that knows \
nothing about the current conversation.

If the session logs contain nothing worth persisting, respond with NO_REPLY.";

// ---------------------------------------------------------------------------
// Configuration

#[derive(Debug, Clone, PartialEq)]
pub struct DreamConfig {
    pub enabled: bool,
    pub min_hours: u64,
    pub min_sessions: u64,
    pub stale_lock_secs: u64,
    /// `None` (configured 0) checks only at launch.
    pub check_interval_secs: Option<u64>,
}

impl Default for DreamConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            min_hours: 24,
            min_sessions: 5,
            stale_lock_secs: 3_600,
            check_interval_secs: Some(3_600),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FlushConfig {
    /// Pre-compaction flush. dsh owns compaction, so this gate is reported
    /// but has no hook here; the idle flush does not read it (as upstream).
    pub enabled: bool,
    pub soft_threshold_tokens: u64,
    pub max_flush_write_chars: usize,
    pub flush_model: Option<String>,
    /// 0 turns the idle flush off.
    pub idle_timeout_secs: u64,
    pub semantic_dedup_threshold: f64,
}

impl Default for FlushConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            soft_threshold_tokens: 4_000,
            max_flush_write_chars: 8_000,
            flush_model: None,
            idle_timeout_secs: 300,
            semantic_dedup_threshold: 0.92,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum LogTarget {
    #[default]
    Off,
    File(PathBuf),
}

#[derive(Debug, Clone, PartialEq)]
pub struct CaptureConfig {
    pub save_on_end: bool,
    pub dream: DreamConfig,
    pub flush: FlushConfig,
    /// `[memory_v2] enabled = true`: the reference v2 store was asked for.
    pub v2_requested: bool,
    pub log: LogTarget,
    /// `(key, value, source)` rows for `codsh --rust inspect`.
    pub rows: Vec<(&'static str, String, String)>,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            save_on_end: true,
            dream: DreamConfig::default(),
            flush: FlushConfig::default(),
            v2_requested: false,
            log: LogTarget::Off,
            rows: Vec::new(),
        }
    }
}

fn table_path<'a>(table: &'a toml::Value, path: &[&str]) -> Option<&'a toml::Value> {
    let mut node = table;
    for key in path {
        node = node.get(key)?;
    }
    Some(node)
}

fn toml_bool(value: &toml::Value) -> Option<bool> {
    match value {
        toml::Value::Boolean(flag) => Some(*flag),
        toml::Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn toml_u64(value: &toml::Value) -> Option<u64> {
    match value {
        toml::Value::Integer(number) if *number >= 0 => Some(*number as u64),
        _ => None,
    }
}

fn toml_f64(value: &toml::Value) -> Option<f64> {
    match value {
        toml::Value::Float(number) => Some(*number),
        toml::Value::Integer(number) => Some(*number as f64),
        _ => None,
    }
}

struct Loader<'a> {
    table: &'a toml::Value,
    rows: Vec<(&'static str, String, String)>,
}

impl Loader<'_> {
    fn read<T: ToString>(
        &mut self,
        key: &'static str,
        default: T,
        parse: impl Fn(&toml::Value) -> Option<T>,
    ) -> T {
        let path: Vec<&str> = key.split('.').collect();
        let (value, source) = match table_path(self.table, &path) {
            None => (default, "default".to_string()),
            Some(raw) => match parse(raw) {
                Some(value) => (value, "config.toml".to_string()),
                None => (default, "default (invalid value ignored)".to_string()),
            },
        };
        self.rows.push((key, value.to_string(), source));
        value
    }
}

/// Settings under `[memory.session]`, `[memory.dream]`,
/// `[compaction.memory_flush]`, `[memory_v2]`, and `GROK_MEMORY_LOG`.
pub fn load_config(
    table: &toml::Value,
    env: &std::collections::BTreeMap<String, String>,
    grok_home: &Path,
) -> CaptureConfig {
    let mut loader = Loader {
        table,
        rows: Vec::new(),
    };
    let save_on_end = loader.read("memory.session.save_on_end", true, toml_bool);
    let defaults = DreamConfig::default();
    let dream_enabled = loader.read("memory.dream.enabled", defaults.enabled, toml_bool);
    let min_hours = loader.read("memory.dream.min_hours", defaults.min_hours, toml_u64);
    let min_sessions = loader.read("memory.dream.min_sessions", defaults.min_sessions, toml_u64);
    let stale_lock_secs = loader.read(
        "memory.dream.stale_lock_secs",
        defaults.stale_lock_secs,
        toml_u64,
    );
    let interval = loader.read("memory.dream.check_interval_secs", 3_600, toml_u64);
    let flush_defaults = FlushConfig::default();
    let flush_enabled = loader.read(
        "compaction.memory_flush.enabled",
        flush_defaults.enabled,
        toml_bool,
    );
    let soft_threshold_tokens = loader.read(
        "compaction.memory_flush.soft_threshold_tokens",
        flush_defaults.soft_threshold_tokens,
        toml_u64,
    );
    let max_flush_write_chars = loader.read(
        "compaction.memory_flush.max_flush_write_chars",
        flush_defaults.max_flush_write_chars as u64,
        |value| toml_u64(value).filter(|chars| *chars > 0),
    );
    let flush_model = loader.read(
        "compaction.memory_flush.flush_model",
        String::new(),
        |value| value.as_str().map(|text| text.trim().to_string()),
    );
    let idle_timeout_secs = loader.read(
        "compaction.memory_flush.idle_timeout_secs",
        flush_defaults.idle_timeout_secs,
        toml_u64,
    );
    let semantic_dedup_threshold = loader.read(
        "compaction.memory_flush.semantic_dedup_threshold",
        flush_defaults.semantic_dedup_threshold,
        |value| toml_f64(value).filter(|number| (0.0..=1.0).contains(number)),
    );
    let v2_requested = loader.read("memory_v2.enabled", false, toml_bool);
    let mut rows = loader.rows;
    if let Some(row) = rows
        .iter_mut()
        .find(|row| row.0 == "compaction.memory_flush.flush_model")
        && row.1.is_empty()
    {
        row.1 = "(session model)".into();
    }
    if let Some(row) = rows
        .iter_mut()
        .find(|row| row.0 == "compaction.memory_flush.semantic_dedup_threshold")
    {
        row.1.push_str(" (inactive: no embeddings in this client)");
    }
    if let Some(row) = rows
        .iter_mut()
        .find(|row| row.0 == "compaction.memory_flush.enabled")
    {
        row.1
            .push_str(" (pre-compaction flush: dsh owns compaction, not wired)");
    }
    if v2_requested && let Some(row) = rows.iter_mut().find(|row| row.0 == "memory_v2.enabled") {
        row.1
            .push_str(" (not implemented: capture and Dream stay off)");
    }
    let (log, log_value, log_source) = resolve_log(env.get("GROK_MEMORY_LOG"), grok_home);
    rows.push(("memory.log", log_value, log_source));
    CaptureConfig {
        save_on_end,
        dream: DreamConfig {
            enabled: dream_enabled,
            min_hours,
            min_sessions,
            stale_lock_secs,
            check_interval_secs: (interval > 0).then_some(interval),
        },
        flush: FlushConfig {
            enabled: flush_enabled,
            soft_threshold_tokens,
            max_flush_write_chars: max_flush_write_chars as usize,
            flush_model: (!flush_model.is_empty()).then_some(flush_model),
            idle_timeout_secs,
            semantic_dedup_threshold,
        },
        v2_requested,
        log,
        rows,
    }
}

/// `GROK_MEMORY_LOG`: unset or `""|0|false|off|no` is off, `1|true|on|yes`
/// is `$GROK_HOME/logs/memory.log`, any other value is a file path.
pub fn resolve_log(value: Option<&String>, grok_home: &Path) -> (LogTarget, String, String) {
    let Some(raw) = value else {
        return (LogTarget::Off, "off".into(), "default".into());
    };
    let trimmed = raw.trim();
    match trimmed.to_ascii_lowercase().as_str() {
        "" | "0" | "false" | "off" | "no" => {
            (LogTarget::Off, "off".into(), "GROK_MEMORY_LOG".into())
        }
        "1" | "true" | "on" | "yes" => {
            let path = grok_home.join("logs").join("memory.log");
            let shown = path.display().to_string();
            (LogTarget::File(path), shown, "GROK_MEMORY_LOG".into())
        }
        _ => (
            LogTarget::File(PathBuf::from(trimmed)),
            trimmed.to_string(),
            "GROK_MEMORY_LOG".into(),
        ),
    }
}

/// Open the log once so an unwritable path is reported at startup.
pub fn probe_log(target: &LogTarget) -> Option<String> {
    let LogTarget::File(path) = target else {
        return None;
    };
    match open_log(path) {
        Ok(_) => None,
        Err(error) => Some(format!(
            "GROK_MEMORY_LOG: cannot write {}: {error}; the memory log is off",
            path.display()
        )),
    }
}

fn open_log(path: &Path) -> io::Result<fs::File> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}

/// One content-free event line: an event name and enum or count fields.
/// Prompts, notes, model output, and session text never reach this log.
pub fn log_event(target: &LogTarget, event: &str, fields: &[(&str, String)]) {
    let LogTarget::File(path) = target else {
        return;
    };
    let mut line = format!("{} {event}", iso_utc(now_secs()));
    for (key, value) in fields {
        line.push_str(&format!(" {key}={value}"));
    }
    line.push('\n');
    if let Ok(mut file) = open_log(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

// ---------------------------------------------------------------------------
// Time

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

fn civil(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (
        year,
        month,
        day,
        (rem / 3_600) as u32,
        ((rem % 3_600) / 60) as u32,
        (rem % 60) as u32,
    )
}

pub fn utc_date(secs: u64) -> String {
    let (y, m, d, ..) = civil(secs);
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn utc_minute(secs: u64) -> String {
    let (y, m, d, h, min, _) = civil(secs);
    format!("{y:04}-{m:02}-{d:02} {h:02}:{min:02} UTC")
}

fn utc_clock(secs: u64) -> String {
    let (.., h, min, s) = civil(secs);
    format!("{h:02}:{min:02}:{s:02} UTC")
}

fn iso_utc(secs: u64) -> String {
    let (y, m, d, h, min, s) = civil(secs);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}Z")
}

fn system_secs(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

pub fn age_text(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3_600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        format!("{}h {}m", secs / 3_600, (secs % 3_600) / 60)
    } else {
        format!("{}d {}h", secs / 86_400, (secs % 86_400) / 3_600)
    }
}

// ---------------------------------------------------------------------------
// Session logs

/// Lowercase ASCII alphanumerics; every other char becomes one dash; runs
/// collapse; truncated to `max_len` chars; dashes trimmed (upstream slugify).
pub fn slugify(input: &str, max_len: usize) -> String {
    let mut result = String::new();
    let mut prev_dash = false;
    for ch in input.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            result.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            result.push('-');
            prev_dash = true;
        }
    }
    let truncated: String = result.chars().take(max_len).collect();
    truncated.trim_matches('-').to_string()
}

fn sid8(session_id: &str) -> String {
    session_id.chars().take(8).collect()
}

pub fn sessions_dir(store: &Store) -> PathBuf {
    store.workspace_dir.join(SESSIONS)
}

fn archive_dir(store: &Store) -> PathBuf {
    sessions_dir(store).join(ARCHIVE)
}

pub fn workspace_memory_path(store: &Store) -> PathBuf {
    store.workspace_dir.join(MEMORY_FILE)
}

fn refuse_symlink(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(io::Error::other(format!(
            "refusing to write through symlink {}",
            path.display()
        )));
    }
    Ok(())
}

/// `sessions/{date}-{slug}-{sid8}.md`. An existing file is appended to with
/// the upstream separator (`label` is `flush` or `session-end`); a new file
/// is created exclusively. Nothing already on disk is overwritten.
pub fn write_daily_log(
    store: &Store,
    date: &str,
    slug: &str,
    session_id: &str,
    content: &str,
    label: &str,
    now: u64,
) -> io::Result<PathBuf> {
    let dir = sessions_dir(store);
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{date}-{slug}-{}.md", sid8(session_id)));
    refuse_symlink(&path)?;
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => file.write_all(content.as_bytes())?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let mut file = OpenOptions::new().append(true).open(&path)?;
            write!(
                file,
                "\n\n---\n\n<!-- {label} {} -->\n\n{content}",
                utc_clock(now)
            )?;
        }
        Err(error) => return Err(error),
    }
    Ok(path)
}

/// What the live session showed, counted from ACP events (never replay).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionLedger {
    pub session_id: String,
    pub queries: Vec<String>,
    answer_ids: BTreeSet<String>,
    anonymous_answers: usize,
    answering: bool,
    tools: BTreeSet<String>,
}

impl SessionLedger {
    pub fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            ..Self::default()
        }
    }

    /// A prompt the user typed. Slash commands and empty text are not queries.
    pub fn note_query(&mut self, text: &str) {
        let text = text.trim();
        if text.is_empty() || text.starts_with('/') {
            return;
        }
        self.queries.push(text.to_string());
        self.answering = false;
    }

    pub fn note_answer(&mut self, message_id: &str) {
        if self.queries.is_empty() {
            return;
        }
        if message_id.is_empty() {
            if !self.answering {
                self.anonymous_answers += 1;
            }
        } else {
            self.answer_ids.insert(message_id.to_string());
        }
        self.answering = true;
    }

    pub fn note_tool(&mut self, tool_call_id: &str) {
        if !self.queries.is_empty() && !tool_call_id.is_empty() {
            self.tools.insert(tool_call_id.to_string());
            self.answering = false;
        }
    }

    pub fn assistant_messages(&self) -> usize {
        self.answer_ids.len() + self.anonymous_answers
    }

    pub fn tool_results(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.queries.is_empty()
    }

    /// Upstream thresholds: 3 prompts, 50 bytes together.
    pub fn meets_threshold(&self) -> bool {
        self.queries.len() >= SESSION_MIN_QUERIES
            && self.queries.iter().map(String::len).sum::<usize>() >= SESSION_MIN_BYTES
    }
}

/// The upstream metadata summary. No model is called.
pub fn session_summary(ledger: &SessionLedger, now: u64) -> String {
    let mut summary = String::from("## Session Summary\n\n");
    summary.push_str(&format!(
        "- **Messages:** {} user, {} assistant, {} tool results\n",
        ledger.queries.len(),
        ledger.assistant_messages(),
        ledger.tool_results()
    ));
    summary.push_str(&format!("- **Date:** {}\n\n", utc_minute(now)));
    let topics: Vec<String> = ledger
        .queries
        .iter()
        .take(SESSION_MAX_TOPICS)
        .map(|query| query.chars().take(TOPIC_CHARS).collect())
        .collect();
    if !topics.is_empty() {
        summary.push_str("## Topics Discussed\n\n");
        for (index, topic) in topics.iter().enumerate() {
            summary.push_str(&format!("{}. {topic}\n", index + 1));
        }
        summary.push('\n');
    }
    summary
}

/// Where the session end writes, and whether it may.
#[derive(Debug, Clone, PartialEq)]
pub struct CaptureTarget {
    pub store: Store,
    pub save_on_end: bool,
    /// Memory is on for this session and the legacy store is selected.
    pub active: bool,
    pub log: LogTarget,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEnd {
    Off,
    Skipped(&'static str),
    Written(PathBuf),
    Failed(String),
}

pub fn finish_session(target: &CaptureTarget, ledger: &SessionLedger, now: u64) -> SessionEnd {
    let outcome = if !target.active || ledger.session_id.is_empty() {
        SessionEnd::Off
    } else if !target.save_on_end {
        SessionEnd::Skipped("save_on_end_off")
    } else if !ledger.meets_threshold() {
        SessionEnd::Skipped("below_threshold")
    } else {
        let slug = slugify(
            ledger.queries.first().map(String::as_str).unwrap_or(""),
            SLUG_CHARS,
        );
        let slug = if slug.is_empty() {
            "session".into()
        } else {
            slug
        };
        match write_daily_log(
            &target.store,
            &utc_date(now),
            &slug,
            &ledger.session_id,
            &session_summary(ledger, now),
            "session-end",
            now,
        ) {
            Ok(path) => {
                let _ = memory::rebuild_index(&target.store);
                SessionEnd::Written(path)
            }
            Err(error) => SessionEnd::Failed(error.to_string()),
        }
    };
    if outcome != SessionEnd::Off {
        let label = match &outcome {
            SessionEnd::Written(_) => "written",
            SessionEnd::Skipped(reason) => reason,
            SessionEnd::Failed(_) => "failed",
            SessionEnd::Off => "off",
        };
        record_status(&target.store, "session_save", label, now, &[]);
        log_event(
            &target.log,
            "session_end",
            &[
                ("outcome", label.to_string()),
                ("user", ledger.queries.len().to_string()),
            ],
        );
    }
    outcome
}

// ---------------------------------------------------------------------------
// Status file: enums, timestamps, and counts only.

fn status_path(store: &Store) -> PathBuf {
    store.workspace_dir.join(STATUS_FILE)
}

fn read_status(store: &Store) -> Value {
    fs::read_to_string(status_path(store))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "version": 1 }))
}

/// `kind` is `session_save`, `flush`, or `dream`; `outcome` an enum word.
pub fn record_status(store: &Store, kind: &str, outcome: &str, now: u64, counts: &[(&str, u64)]) {
    let mut status = read_status(store);
    let mut entry = json!({ "at": now, "outcome": outcome });
    for (key, value) in counts {
        entry[*key] = json!(value);
    }
    status[kind] = entry;
    status["version"] = json!(1);
    if fs::create_dir_all(&store.workspace_dir).is_ok() {
        let _ = memory::atomic_write(
            &status_path(store),
            &format!(
                "{}\n",
                serde_json::to_string_pretty(&status).unwrap_or_default()
            ),
        );
    }
}

// ---------------------------------------------------------------------------
// Dream lock (port of xai-grok-memory/src/dream_lock.rs)

fn owner_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let nonce = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    format!("{} {nonce}", std::process::id())
}

fn token_pid(content: &str) -> Option<u32> {
    content.split_whitespace().next()?.parse().ok()
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the pid exists.
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

pub fn last_consolidated_at(workspace_dir: &Path) -> Option<SystemTime> {
    [CONSOLIDATED_FILE, LEGACY_MARKER_FILE]
        .iter()
        .find_map(|name| fs::metadata(workspace_dir.join(name)).ok()?.modified().ok())
}

/// Holds `.dream-mutex`. Dropping it releases the mutex without recording a
/// consolidation; [`DreamGuard::commit`] writes `.dream-consolidated`.
#[derive(Debug)]
pub struct DreamGuard {
    path: PathBuf,
    token: String,
}

impl PartialEq for DreamGuard {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path && self.token == other.token
    }
}

impl DreamGuard {
    #[must_use]
    pub fn commit(self) -> bool {
        let marker = self.path.with_file_name(CONSOLIDATED_FILE);
        fs::write(marker, "").is_ok()
    }
}

impl Drop for DreamGuard {
    fn drop(&mut self) {
        if fs::read_to_string(&self.path).is_ok_and(|content| content.trim() == self.token) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn reclaimable(path: &Path, stale_secs: u64) -> io::Result<bool> {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    };
    let age = SystemTime::now()
        .duration_since(meta.modified()?)
        .unwrap_or_default()
        .as_secs();
    if age >= stale_secs {
        return Ok(true);
    }
    match fs::read_to_string(path) {
        Ok(content) => Ok(token_pid(&content).is_some_and(|pid| !pid_alive(pid))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error),
    }
}

/// `Ok(None)` when another live process holds a fresh lock.
pub fn acquire_dream_lock(workspace_dir: &Path, stale_secs: u64) -> io::Result<Option<DreamGuard>> {
    fs::create_dir_all(workspace_dir)?;
    let path = workspace_dir.join(MUTEX_FILE);
    let token = owner_token();
    for _ in 0..8 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = write!(file, "{token}") {
                    let _ = fs::remove_file(&path);
                    return Err(error);
                }
                return Ok(Some(DreamGuard { path, token }));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if !reclaimable(&path, stale_secs)? {
                    return Ok(None);
                }
                if let Err(error) = fs::remove_file(&path)
                    && error.kind() != io::ErrorKind::NotFound
                {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

/// Lease state for diagnostics: `free`, `held (this process)`,
/// `held (live process, age)`, or `stale (reclaimable)`.
pub fn lease_state(workspace_dir: &Path, stale_secs: u64) -> String {
    let path = workspace_dir.join(MUTEX_FILE);
    let Ok(meta) = fs::metadata(&path) else {
        return "free".into();
    };
    let age = meta
        .modified()
        .ok()
        .and_then(|time| SystemTime::now().duration_since(time).ok())
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let pid = fs::read_to_string(&path)
        .ok()
        .and_then(|text| token_pid(&text));
    if pid == Some(std::process::id()) {
        return format!("held by this process ({})", age_text(age));
    }
    if age >= stale_secs || pid.is_some_and(|pid| !pid_alive(pid)) || pid.is_none() {
        return format!("stale, reclaimable ({})", age_text(age));
    }
    format!("held by another codsh process ({})", age_text(age))
}

/// Session log stems changed after `since`, except this session's own logs.
pub fn sessions_since(
    sessions_dir: &Path,
    since: SystemTime,
    exclude_sid8: Option<&str>,
) -> io::Result<Vec<String>> {
    let entries = match fs::read_dir(sessions_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut stems = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") || !path.is_file() {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if exclude_sid8.is_some_and(|sid| !sid.is_empty() && stem.ends_with(sid)) {
            continue;
        }
        if entry.metadata()?.modified()? > since {
            stems.push(stem.to_string());
        }
    }
    stems.sort();
    Ok(stems)
}

// ---------------------------------------------------------------------------
// Dream

/// Short scaffold text is not fed to the model as existing memory.
fn is_scaffold(content: &str) -> bool {
    const MARKERS: &[&str] = &[
        "Auto-populated by dream consolidation",
        "Add project-specific knowledge here",
        "Add any cross-project preferences here",
    ];
    let trimmed = content.trim();
    trimmed.len() < 500 && MARKERS.iter().any(|marker| trimmed.contains(marker))
}

pub fn is_no_reply(text: &str) -> bool {
    let normalized: String = text
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .collect();
    normalized == "noreply"
}

fn has_markdown_headers(text: &str) -> bool {
    text.contains("## ") || text.contains("# ")
}

fn prefix_bytes(text: &str, cap: usize) -> &str {
    if text.len() <= cap {
        return text;
    }
    let mut end = cap;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The Dream user message and the stems actually read (within 32k chars).
pub fn build_dream_input(
    sessions_dir: &Path,
    stems: &[String],
    existing: Option<&str>,
) -> Option<(String, Vec<String>)> {
    let mut buf = String::new();
    if let Some(memory) = existing {
        let trimmed = memory.trim();
        if !trimmed.is_empty() && !is_scaffold(trimmed) {
            buf.push_str("--- Existing Memory (merge with new sessions) ---\n\n");
            buf.push_str(prefix_bytes(trimmed, MAX_DREAM_INPUT_CHARS / 2));
        }
    }
    let mut processed = Vec::new();
    for stem in stems {
        let Ok(content) = fs::read_to_string(sessions_dir.join(format!("{stem}.md"))) else {
            continue;
        };
        if content.trim().is_empty() {
            continue;
        }
        if !buf.is_empty() {
            buf.push_str("\n\n");
        }
        buf.push_str(&format!("--- Session: {stem} ---\n\n{content}"));
        processed.push(stem.clone());
        if buf.len() >= MAX_DREAM_INPUT_CHARS {
            break;
        }
    }
    (!processed.is_empty()).then_some((buf, processed))
}

/// `None` is nothing to consolidate (empty, NO_REPLY, or no headers).
pub fn process_dream_response(response: &str) -> Option<String> {
    let trimmed = response.trim();
    if trimmed.is_empty() || is_no_reply(trimmed) || !has_markdown_headers(trimmed) {
        return None;
    }
    Some(trimmed.chars().take(MAX_DREAM_CHARS).collect())
}

#[derive(Debug, PartialEq)]
pub struct DreamPlan {
    pub guard: DreamGuard,
    pub input: String,
    pub stems: Vec<String>,
    /// Sessions that passed the gate, including any beyond the input cap.
    pub eligible: usize,
    /// Workspace `MEMORY.md` when the plan was made (`None`: no file).
    pub previous: Option<String>,
    pub started: u64,
    pub manual: bool,
}

#[derive(Debug, PartialEq)]
pub enum DreamStart {
    Plan(DreamPlan),
    /// Another process holds the lock.
    Busy,
    /// Manual Dream with no session logs.
    NoWork,
    /// An automatic gate is closed (the reason is content-free).
    Gated(String),
    Failed(String),
}

/// Gates cheapest first (enabled, min_hours, min_sessions), then the lock.
/// A manual Dream bypasses the gates and takes every other session log.
pub fn plan_dream(
    store: &Store,
    config: &DreamConfig,
    current_session: Option<&str>,
    manual: bool,
) -> DreamStart {
    let dir = &store.workspace_dir;
    let sessions = sessions_dir(store);
    let exclude = current_session.map(sid8);
    let last = last_consolidated_at(dir);
    if !manual {
        if !config.enabled {
            return DreamStart::Gated("memory.dream.enabled = false".into());
        }
        if let Some(last) = last {
            let hours = SystemTime::now()
                .duration_since(last)
                .unwrap_or_default()
                .as_secs()
                / 3_600;
            if hours < config.min_hours {
                return DreamStart::Gated(format!(
                    "{hours}h since the last Dream (needs {}h)",
                    config.min_hours
                ));
            }
        }
    }
    let since = if manual {
        UNIX_EPOCH
    } else {
        last.unwrap_or(UNIX_EPOCH)
    };
    let stems = match sessions_since(&sessions, since, exclude.as_deref()) {
        Ok(stems) => stems,
        Err(error) => return DreamStart::Failed(format!("cannot read session logs: {error}")),
    };
    if !manual && (stems.len() as u64) < config.min_sessions {
        return DreamStart::Gated(format!(
            "{} of {} new session logs",
            stems.len(),
            config.min_sessions
        ));
    }
    if stems.is_empty() {
        return DreamStart::NoWork;
    }
    let memory_path = workspace_memory_path(store);
    let previous = match fs::read_to_string(&memory_path) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return DreamStart::Failed(format!("cannot read MEMORY.md: {error}")),
    };
    if previous.as_deref().is_some_and(memory::is_generated_index) {
        return DreamStart::Failed(
            "workspace MEMORY.md is a generated index; Dream does not overwrite it".into(),
        );
    }
    if refuse_symlink(&memory_path).is_err() {
        return DreamStart::Failed(
            "workspace MEMORY.md is a symlink; Dream does not write through it".into(),
        );
    }
    let stale = config.stale_lock_secs.max(DREAM_MIN_STALE_SECS);
    let guard = match acquire_dream_lock(dir, stale) {
        Ok(Some(guard)) => guard,
        Ok(None) => return DreamStart::Busy,
        Err(error) => return DreamStart::Failed(format!("cannot take the Dream lock: {error}")),
    };
    let Some((input, processed)) = build_dream_input(&sessions, &stems, previous.as_deref()) else {
        return DreamStart::NoWork;
    };
    DreamStart::Plan(DreamPlan {
        guard,
        input,
        stems: processed,
        eligible: stems.len(),
        previous,
        started: now_secs(),
        manual,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DreamOutcome {
    Completed {
        chars: usize,
        sessions: usize,
        archived: usize,
        backup: Option<PathBuf>,
    },
    NothingToConsolidate,
    /// `MEMORY.md` changed while the model ran; the edit was kept.
    Conflict,
    Failed(String),
}

impl DreamOutcome {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Completed { .. } => "completed",
            Self::NothingToConsolidate => "nothing_to_consolidate",
            Self::Conflict => "conflict_kept_edit",
            Self::Failed(_) => "failed",
        }
    }
}

fn unique_in(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.md"));
    if !first.exists() {
        return first;
    }
    (1..1_000)
        .map(|n| dir.join(format!("{stem}-{n}.md")))
        .find(|path| !path.exists())
        .unwrap_or(first)
}

/// Write the Dream answer. The marker is committed on Completed and
/// NothingToConsolidate only; a conflict or failure leaves the gate open.
pub fn commit_dream(store: &Store, plan: DreamPlan, response: &str) -> DreamOutcome {
    let Some(content) = process_dream_response(response) else {
        let _ = plan.guard.commit();
        return DreamOutcome::NothingToConsolidate;
    };
    let memory_path = workspace_memory_path(store);
    let current = match fs::read_to_string(&memory_path) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return DreamOutcome::Failed(format!("cannot read MEMORY.md: {error}")),
    };
    if current != plan.previous {
        return DreamOutcome::Conflict;
    }
    if refuse_symlink(&memory_path).is_err() {
        return DreamOutcome::Failed("workspace MEMORY.md is a symlink".into());
    }
    let archive = archive_dir(store);
    let mut backup = None;
    if let Some(previous) = plan
        .previous
        .as_deref()
        .filter(|text| !text.trim().is_empty())
    {
        if let Err(error) = fs::create_dir_all(&archive) {
            return DreamOutcome::Failed(format!("cannot create the archive: {error}"));
        }
        let path = unique_in(&archive, &format!("MEMORY-before-dream-{}", plan.started));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(previous.as_bytes()) {
                    return DreamOutcome::Failed(format!("cannot back up MEMORY.md: {error}"));
                }
            }
            Err(error) => {
                return DreamOutcome::Failed(format!("cannot back up MEMORY.md: {error}"));
            }
        }
        backup = Some(path);
    }
    let body = format!("{content}\n");
    if let Err(error) = memory::atomic_write(&memory_path, &body) {
        return DreamOutcome::Failed(error.message);
    }
    let archived = archive_sessions(store, &plan.stems, plan.started);
    let _ = memory::rebuild_index(store);
    let sessions = plan.stems.len();
    let _ = plan.guard.commit();
    DreamOutcome::Completed {
        chars: content.chars().count(),
        sessions,
        archived,
        backup,
    }
}

/// Move consolidated logs to `sessions/.archive/`. A log changed during the
/// Dream, or in the last five minutes, stays where it is.
fn archive_sessions(store: &Store, stems: &[String], started: u64) -> usize {
    let dir = sessions_dir(store);
    let archive = archive_dir(store);
    if fs::create_dir_all(&archive).is_err() {
        return 0;
    }
    let now = now_secs();
    let mut moved = 0;
    for stem in stems {
        let path = dir.join(format!("{stem}.md"));
        let Some(mtime) = fs::metadata(&path)
            .ok()
            .and_then(|meta| meta.modified().ok())
        else {
            continue;
        };
        let mtime = system_secs(mtime);
        if mtime >= started || now.saturating_sub(mtime) < CLEANUP_RECENCY_GUARD_SECS {
            continue;
        }
        if fs::rename(&path, unique_in(&archive, stem)).is_ok() {
            moved += 1;
        }
    }
    moved
}

// ---------------------------------------------------------------------------
// Flush

pub fn flush_system_prompt(previous: Option<&str>) -> String {
    match previous.filter(|text| !text.trim().is_empty()) {
        Some(previous) => format!("{FLUSH_DELTA_SYSTEM_PROMPT}{previous}"),
        None => FLUSH_SYSTEM_PROMPT.to_string(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlushOutcome {
    Written {
        path: PathBuf,
        chars: usize,
        content: String,
    },
    NothingToStore,
    Rejected(String),
    Failed(String),
}

impl FlushOutcome {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Written { .. } => "written",
            Self::NothingToStore => "nothing_to_store",
            Self::Rejected(_) => "rejected",
            Self::Failed(_) => "failed",
        }
    }
}

/// Flush triggers whose logs are `sessions/{date}-{trigger}-{sid8}.md`.
const FLUSH_TRIGGERS: [&str; 2] = ["user_requested", "interval"];

/// Whether `name` is a flush log of `sid8` (Dream archives may add `-N`).
fn is_flush_log_of(name: &str, sid8: &str) -> bool {
    let Some(stem) = name.strip_suffix(".md") else {
        return false;
    };
    let stem = match stem.rsplit_once('-') {
        Some((head, tail))
            if tail != sid8 && !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) =>
        {
            head
        }
        _ => stem,
    };
    let Some(head) = stem
        .strip_suffix(sid8)
        .and_then(|head| head.strip_suffix('-'))
    else {
        return false;
    };
    // `YYYY-MM-DD-{trigger}`
    let (Some(date), Some(trigger)) = (head.get(..10), head.get(10..)) else {
        return false;
    };
    date.bytes().all(|b| b.is_ascii_digit() || b == b'-')
        && trigger
            .strip_prefix('-')
            .is_some_and(|trigger| FLUSH_TRIGGERS.contains(&trigger))
}

/// The last flush this session wrote, read back from its newest flush log
/// (live or archived by Dream): the segment after the final
/// `<!-- flush … -->` separator, or the whole file when it has one segment.
pub fn previous_flush_on_disk(store: &Store, session_id: &str) -> Option<String> {
    let sid8 = sid8(session_id);
    if sid8.is_empty() {
        return None;
    }
    let newest = [sessions_dir(store), archive_dir(store)]
        .iter()
        .filter_map(|dir| fs::read_dir(dir).ok())
        .flatten()
        .flatten()
        .filter(|entry| is_flush_log_of(&entry.file_name().to_string_lossy(), &sid8))
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .max_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)))?
        .1;
    let text = fs::read_to_string(newest).ok()?;
    let last = match text.rfind("<!-- flush ") {
        Some(start) => text[start..].split_once("-->").map_or("", |(_, rest)| rest),
        None => text.as_str(),
    };
    let last = last.trim();
    (!last.is_empty()).then(|| last.to_string())
}

/// Empty or NO_REPLY stores nothing; the answer is capped, then must carry
/// a markdown header; it is appended to `{date}-{trigger}-{sid8}.md`.
pub fn commit_flush(
    store: &Store,
    config: &FlushConfig,
    session_id: &str,
    trigger: &str,
    response: &str,
) -> FlushOutcome {
    let trimmed = response.trim();
    if trimmed.is_empty() || is_no_reply(trimmed) {
        return FlushOutcome::NothingToStore;
    }
    let content: String = trimmed.chars().take(config.max_flush_write_chars).collect();
    if !has_markdown_headers(&content) {
        return FlushOutcome::Rejected(
            "flush response lacks markdown structure (no ## headers)".into(),
        );
    }
    let now = now_secs();
    match write_daily_log(
        store,
        &utc_date(now),
        trigger,
        session_id,
        &content,
        "flush",
        now,
    ) {
        Ok(path) => {
            let _ = memory::rebuild_index(store);
            FlushOutcome::Written {
                path,
                chars: content.chars().count(),
                content,
            }
        }
        Err(error) => FlushOutcome::Failed(error.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Control messages (`memory_model` in rust-acp-control.mjs)

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Usage {
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub total: Option<u64>,
    pub cache_read: Option<u64>,
}

/// Where a request went and how much of it: the explainable part.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Route {
    pub provider: String,
    pub model: String,
    pub messages: Option<u64>,
    pub chars: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelReply {
    pub text: String,
    pub route: Route,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelFailure {
    pub message: String,
    pub cancelled: bool,
    /// A flush with no conversation to send; nothing left the machine.
    pub empty: bool,
    pub route: Route,
}

fn route_of(value: &Value) -> Route {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    Route {
        provider: text("provider"),
        model: text("model"),
        messages: value.get("sentMessages").and_then(Value::as_u64),
        chars: value.get("sentChars").and_then(Value::as_u64),
    }
}

pub fn parse_reply(value: &Value) -> ModelReply {
    let usage = value
        .get("usage")
        .filter(|usage| usage.is_object())
        .map(|usage| Usage {
            input: usage.get("inputTokens").and_then(Value::as_u64),
            output: usage.get("outputTokens").and_then(Value::as_u64),
            total: usage.get("totalTokens").and_then(Value::as_u64),
            cache_read: usage.get("cacheReadTokens").and_then(Value::as_u64),
        });
    ModelReply {
        text: value
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        route: route_of(value),
        usage,
    }
}

pub fn parse_failure(value: &Value) -> ModelFailure {
    ModelFailure {
        message: value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("memory request failed")
            .to_string(),
        cancelled: value.get("cancelled").and_then(Value::as_bool) == Some(true),
        empty: value.get("empty").and_then(Value::as_bool) == Some(true),
        route: route_of(value),
    }
}

pub fn request_message(
    id: &str,
    session_id: &str,
    purpose: &str,
    system: &str,
    user: &str,
    window: Option<usize>,
    model: Option<&str>,
) -> Value {
    let mut message = json!({
        "type": "memory_model",
        "id": id,
        "sessionId": session_id,
        "purpose": purpose,
        "system": system,
        "user": user,
    });
    if let Some(window) = window {
        message["window"] = json!(window);
    }
    if let Some(model) = model {
        message["model"] = json!(model);
    }
    message
}

pub fn cancel_message(id: &str) -> Value {
    json!({ "type": "memory_model_cancel", "id": id })
}

fn thousands(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// `sent 21 messages / 9,120 chars to deepseek/deepseek-chat · tokens in 2,
/// out 2 · cost not reported`.
pub fn route_line(route: &Route, usage: Option<&Usage>) -> String {
    let target = if route.provider.is_empty() && route.model.is_empty() {
        "the session model".to_string()
    } else {
        format!("{}/{}", route.provider, route.model)
    };
    let mut line = match (route.messages, route.chars) {
        (Some(messages), Some(chars)) => format!(
            "sent {messages} message{} / {} chars to {target}",
            if messages == 1 { "" } else { "s" },
            thousands(chars)
        ),
        _ => format!("model {target}"),
    };
    match usage {
        Some(usage) if usage.input.is_some() || usage.output.is_some() => {
            let shown = |value: Option<u64>| value.map_or("?".into(), thousands);
            line.push_str(&format!(
                " · tokens in {}, out {}",
                shown(usage.input),
                shown(usage.output)
            ));
        }
        _ => line.push_str(" · usage not reported"),
    }
    line.push_str(" · cost not reported by the provider");
    line
}

// ---------------------------------------------------------------------------
// Runner: at most one background memory request at a time.

/// Longest wait for a memory answer (the upstream model timeout is 30 min).
const JOB_TIMEOUT: Duration = Duration::from_secs(35 * 60);

#[derive(Debug)]
pub enum JobKind {
    Flush {
        trigger: &'static str,
        session_id: String,
    },
    Dream {
        plan: DreamPlan,
    },
}

#[derive(Debug)]
pub struct Job {
    pub id: String,
    pub kind: JobKind,
    pub started: Instant,
    /// The dsh session the request went to; another session cancels it.
    pub session_id: String,
}

impl Job {
    pub fn name(&self) -> &'static str {
        match self.kind {
            JobKind::Flush { .. } => "flush",
            JobKind::Dream { .. } => "dream",
        }
    }
}

/// Sends one control message to the plugin.
pub type SendFn<'a> = &'a dyn Fn(&Value) -> Result<(), String>;

/// What the runner needs from the host for one call.
pub struct Ctx<'a> {
    pub store: &'a Store,
    pub config: &'a CaptureConfig,
    /// Memory is on for this session (config or the `/memory` toggle).
    pub active: bool,
    pub session_id: Option<&'a str>,
    /// Sends one control message; `Err` names why the channel is down.
    pub send: SendFn<'a>,
}

/// Busy refusals of `/flush` and `/dream`. They are transient: the next
/// memory notice (the running job settled or was cancelled) supersedes them.
pub const FLUSH_BUSY: &str = "Another memory flush is already running.";
pub const FLUSH_BUSY_DREAM: &str = "Dream is running; flush again when it finishes.";
pub const DREAM_BUSY: &str = "Dream is already running; try again when it finishes.";
pub const DREAM_BUSY_FLUSH: &str = "A memory flush is running; try /dream when it finishes.";

/// Whether `text` is one of the busy refusals above.
pub fn is_busy_refusal(text: &str) -> bool {
    [FLUSH_BUSY, FLUSH_BUSY_DREAM, DREAM_BUSY, DREAM_BUSY_FLUSH].contains(&text)
}

pub const V2_REFUSAL: &str = "[memory_v2] enabled = true selects the reference v2 store, which this client does not implement; background capture and Dream stay off and memory-v2/ is not touched";

#[derive(Debug, Default)]
pub struct Runner {
    job: Option<Job>,
    inbox: Vec<(String, Result<ModelReply, ModelFailure>)>,
    next_id: u64,
    /// Last flush content per session, for the delta prompt.
    previous_flush: Option<(String, String)>,
    /// Conversation length the idle flush last saw, per session.
    idle_baseline: Option<(String, usize)>,
    next_idle: Option<Instant>,
    next_dream: Option<Instant>,
    launch_checked: bool,
}

impl Runner {
    /// The session of the running request, if any.
    pub fn job_session(&self) -> Option<&str> {
        self.job.as_ref().map(|job| job.session_id.as_str())
    }

    pub fn running(&self) -> Option<(&'static str, u64)> {
        self.job
            .as_ref()
            .map(|job| (job.name(), job.started.elapsed().as_secs()))
    }

    pub fn accept(&mut self, id: String, outcome: Result<ModelReply, ModelFailure>) {
        self.inbox.push((id, outcome));
    }

    fn refusal(ctx: &Ctx, dream: bool) -> Option<String> {
        if !ctx.active {
            return Some(if dream {
                "Dream is turned off for this session.".into()
            } else {
                "Memory is turned off for this session.".into()
            });
        }
        if ctx.config.v2_requested {
            return Some(V2_REFUSAL.into());
        }
        None
    }

    fn next_id(&mut self) -> String {
        self.next_id += 1;
        format!("mem{}", self.next_id)
    }

    /// `/flush` (trigger `user_requested`) or the idle flush (`interval`).
    pub fn start_flush(&mut self, ctx: &Ctx, trigger: &'static str) -> Result<String, String> {
        if let Some(reason) = Self::refusal(ctx, false) {
            return Err(reason);
        }
        if let Some(job) = &self.job {
            return Err(match job.kind {
                JobKind::Flush { .. } => FLUSH_BUSY.into(),
                JobKind::Dream { .. } => FLUSH_BUSY_DREAM.into(),
            });
        }
        let Some(session_id) = ctx.session_id.filter(|id| !id.is_empty()) else {
            return Err("/flush needs a live dsh session; send a prompt first".into());
        };
        // Local deviation: the reference keeps the last flush in memory only,
        // so the first flush after a restart or `--resume` resent the whole
        // window and duplicated the log. Recover it from disk instead.
        let recovered;
        let previous = match self
            .previous_flush
            .as_ref()
            .filter(|(session, _)| session == session_id)
        {
            Some((_, content)) => Some(content.as_str()),
            None => {
                recovered = previous_flush_on_disk(ctx.store, session_id);
                recovered.as_deref()
            }
        };
        let delta = previous.is_some();
        let system = flush_system_prompt(previous);
        let id = self.next_id();
        let model = ctx.config.flush.flush_model.as_deref();
        let message = request_message(
            &id,
            session_id,
            "flush",
            &system,
            FLUSH_CLOSER,
            Some(FLUSH_WINDOW),
            model,
        );
        (ctx.send)(&message).map_err(|error| format!("memory flush unavailable: {error}"))?;
        log_event(
            &ctx.config.log,
            "flush.start",
            &[("trigger", trigger.into()), ("delta", delta.to_string())],
        );
        self.job = Some(Job {
            id,
            kind: JobKind::Flush {
                trigger,
                session_id: session_id.to_string(),
            },
            started: Instant::now(),
            session_id: session_id.to_string(),
        });
        let target = model.map_or("the session model".to_string(), |model| {
            format!("model {model}")
        });
        let who = if trigger == "interval" {
            "Background memory flush"
        } else {
            "Memory flush"
        };
        Ok(format!(
            "{who} running: the last {FLUSH_WINDOW} messages of this session{} go to {target}…",
            if delta {
                " (new since the last flush)"
            } else {
                ""
            }
        ))
    }

    /// `/dream` (manual) or the gated automatic Dream. `Ok(None)` is a
    /// silent skip (automatic only).
    pub fn start_dream(&mut self, ctx: &Ctx, manual: bool) -> Result<Option<String>, String> {
        if let Some(reason) = Self::refusal(ctx, true) {
            return if manual { Err(reason) } else { Ok(None) };
        }
        if let Some(job) = &self.job {
            if !manual {
                return Ok(None);
            }
            return Err(match job.kind {
                JobKind::Dream { .. } => DREAM_BUSY.into(),
                JobKind::Flush { .. } => DREAM_BUSY_FLUSH.into(),
            });
        }
        let Some(session_id) = ctx.session_id.filter(|id| !id.is_empty()) else {
            return if manual {
                Err("/dream needs a live dsh session; send a prompt first".into())
            } else {
                Ok(None)
            };
        };
        let plan = match plan_dream(ctx.store, &ctx.config.dream, Some(session_id), manual) {
            DreamStart::Plan(plan) => plan,
            DreamStart::Busy => {
                return if manual {
                    Err(DREAM_BUSY.into())
                } else {
                    Ok(None)
                };
            }
            DreamStart::NoWork => {
                if !manual {
                    return Ok(None);
                }
                record_status(
                    ctx.store,
                    "dream",
                    "nothing_to_consolidate",
                    now_secs(),
                    &[],
                );
                log_event(
                    &ctx.config.log,
                    "dream.done",
                    &[("outcome", "no_sessions".into())],
                );
                return Ok(Some("Nothing to consolidate.".into()));
            }
            DreamStart::Gated(_) => return Ok(None),
            DreamStart::Failed(error) => {
                record_status(ctx.store, "dream", "failed", now_secs(), &[]);
                return Err(format!("Dream failed: {error}"));
            }
        };
        let id = self.next_id();
        let chars = plan.input.chars().count();
        let sessions = plan.stems.len();
        let with_memory = plan
            .previous
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty() && !is_scaffold(text));
        let message = request_message(
            &id,
            session_id,
            "dream",
            DREAM_SYSTEM_PROMPT,
            &plan.input,
            None,
            None,
        );
        (ctx.send)(&message).map_err(|error| format!("Dream unavailable: {error}"))?;
        log_event(
            &ctx.config.log,
            "dream.start",
            &[
                ("trigger", if manual { "manual" } else { "auto" }.into()),
                ("sessions", sessions.to_string()),
                ("eligible", plan.eligible.to_string()),
            ],
        );
        self.job = Some(Job {
            id,
            kind: JobKind::Dream { plan },
            started: Instant::now(),
            session_id: session_id.to_string(),
        });
        Ok(Some(format!(
            "{} running: {}{sessions} session log{} ({} chars) go to the session model…",
            if manual { "Dream" } else { "Automatic Dream" },
            if with_memory {
                "workspace MEMORY.md and "
            } else {
                ""
            },
            if sessions == 1 { "" } else { "s" },
            thousands(chars as u64)
        )))
    }

    /// Cancel the running request (`/new`, a session switch, or quit). The
    /// Dream lock is released without a consolidation marker.
    pub fn cancel(
        &mut self,
        ctx_store: Option<&Store>,
        log: &LogTarget,
        send: Option<SendFn<'_>>,
    ) -> Option<String> {
        let job = self.job.take()?;
        if let Some(send) = send {
            let _ = send(&cancel_message(&job.id));
        }
        let kind = job.name();
        if let Some(store) = ctx_store {
            record_status(store, kind, "cancelled", now_secs(), &[]);
        }
        log_event(
            log,
            &format!("{kind}.done"),
            &[("outcome", "cancelled".into())],
        );
        Some(match job.kind {
            JobKind::Flush { .. } => "Memory flush cancelled.".into(),
            JobKind::Dream { .. } => "Dream cancelled.".into(),
        })
    }

    /// Apply answers that arrived for the running request.
    pub fn settle(&mut self, ctx: &Ctx) -> Vec<String> {
        let mut notices = Vec::new();
        for (id, outcome) in std::mem::take(&mut self.inbox) {
            if self.job.as_ref().is_none_or(|job| job.id != id) {
                continue;
            }
            let Some(job) = self.job.take() else {
                continue;
            };
            notices.push(self.finish(ctx, job, outcome));
        }
        if self
            .job
            .as_ref()
            .is_some_and(|job| job.started.elapsed() >= JOB_TIMEOUT)
            && let Some(job) = self.job.take()
        {
            let _ = (ctx.send)(&cancel_message(&job.id));
            let failure = ModelFailure {
                message: "no answer within 35 minutes".into(),
                cancelled: false,
                empty: false,
                route: Route::default(),
            };
            notices.push(self.finish(ctx, job, Err(failure)));
        }
        notices
    }

    fn finish(&mut self, ctx: &Ctx, job: Job, outcome: Result<ModelReply, ModelFailure>) -> String {
        let now = now_secs();
        match (job.kind, outcome) {
            (
                JobKind::Flush {
                    trigger,
                    session_id,
                },
                Ok(reply),
            ) => {
                let route = route_line(&reply.route, reply.usage.as_ref());
                let result = commit_flush(
                    ctx.store,
                    &ctx.config.flush,
                    &session_id,
                    trigger,
                    &reply.text,
                );
                record_status(ctx.store, "flush", result.label(), now, &[]);
                log_event(
                    &ctx.config.log,
                    "flush.done",
                    &[
                        ("trigger", trigger.into()),
                        ("outcome", result.label().into()),
                        (
                            "sent_messages",
                            reply.route.messages.unwrap_or(0).to_string(),
                        ),
                        ("sent_chars", reply.route.chars.unwrap_or(0).to_string()),
                    ],
                );
                match result {
                    FlushOutcome::Written {
                        path,
                        chars,
                        content,
                    } => {
                        self.previous_flush = Some((session_id, content));
                        format!(
                            "Memory flushed: {} chars appended to {} · {route}",
                            thousands(chars as u64),
                            display_in_store(ctx.store, &path)
                        )
                    }
                    FlushOutcome::NothingToStore => {
                        format!(
                            "Memory flush: nothing new worth keeping (the model answered NO_REPLY) · {route}"
                        )
                    }
                    FlushOutcome::Rejected(reason) => {
                        format!("Memory flush rejected: {reason} · {route}")
                    }
                    FlushOutcome::Failed(error) => {
                        format!("Memory flush failed: {error} · {route}")
                    }
                }
            }
            (JobKind::Flush { trigger, .. }, Err(failure)) => {
                let label = if failure.cancelled {
                    "cancelled"
                } else if failure.empty {
                    "nothing_to_store"
                } else {
                    "failed"
                };
                record_status(ctx.store, "flush", label, now, &[]);
                log_event(
                    &ctx.config.log,
                    "flush.done",
                    &[("trigger", trigger.into()), ("outcome", label.into())],
                );
                if failure.cancelled {
                    "Memory flush cancelled.".into()
                } else if failure.empty {
                    "Memory flush: this session has no conversation to flush yet.".into()
                } else if failure.route.messages.is_some() {
                    format!(
                        "Memory flush failed: {} · {}",
                        failure.message,
                        route_line(&failure.route, None)
                    )
                } else {
                    format!("Memory flush failed: {}", failure.message)
                }
            }
            (JobKind::Dream { plan }, Ok(reply)) => {
                let route = route_line(&reply.route, reply.usage.as_ref());
                let manual = plan.manual;
                let eligible = plan.eligible as u64;
                let result = commit_dream(ctx.store, plan, &reply.text);
                let (sessions, archived) = match &result {
                    DreamOutcome::Completed {
                        sessions, archived, ..
                    } => (*sessions as u64, *archived as u64),
                    _ => (0, 0),
                };
                record_status(
                    ctx.store,
                    "dream",
                    result.label(),
                    now,
                    &[
                        ("sessions", sessions),
                        ("archived", archived),
                        ("eligible", eligible),
                    ],
                );
                log_event(
                    &ctx.config.log,
                    "dream.done",
                    &[
                        ("trigger", if manual { "manual" } else { "auto" }.into()),
                        ("outcome", result.label().into()),
                        ("sessions", sessions.to_string()),
                        ("archived", archived.to_string()),
                        ("sent_chars", reply.route.chars.unwrap_or(0).to_string()),
                    ],
                );
                match result {
                    DreamOutcome::Completed {
                        chars,
                        sessions,
                        archived,
                        backup,
                    } => {
                        let kept = backup.map_or(String::new(), |path| {
                            format!(
                                "; previous version kept in {}",
                                display_in_store(ctx.store, &path)
                            )
                        });
                        format!(
                            "Dream completed: MEMORY.md rewritten ({} chars) from {sessions} session log{}; {archived} archived{kept} · {route}",
                            thousands(chars as u64),
                            if sessions == 1 { "" } else { "s" }
                        )
                    }
                    DreamOutcome::NothingToConsolidate => {
                        format!("Nothing to consolidate. · {route}")
                    }
                    DreamOutcome::Conflict => format!(
                        "Dream not written: MEMORY.md changed while Dream ran; your edit was kept and the session logs stay for the next Dream · {route}"
                    ),
                    DreamOutcome::Failed(error) => format!("Dream failed: {error} · {route}"),
                }
            }
            (JobKind::Dream { plan }, Err(failure)) => {
                let label = if failure.cancelled {
                    "cancelled"
                } else {
                    "failed"
                };
                record_status(ctx.store, "dream", label, now, &[]);
                log_event(&ctx.config.log, "dream.done", &[("outcome", label.into())]);
                drop(plan);
                if failure.cancelled {
                    "Dream cancelled.".into()
                } else {
                    format!("Dream failed: {}", failure.message)
                }
            }
        }
    }

    /// Timers: the automatic Dream at launch and every check interval, and
    /// the idle flush every `idle_timeout_secs` when the conversation grew.
    pub fn tick(&mut self, ctx: &Ctx, idle: bool, conversation_len: usize) -> Option<String> {
        if !ctx.active || ctx.config.v2_requested {
            return None;
        }
        let session = ctx.session_id.filter(|id| !id.is_empty())?;
        let now = Instant::now();
        let mut notice = None;
        let dream_due = if !self.launch_checked {
            self.launch_checked = true;
            true
        } else {
            self.next_dream.is_some_and(|due| now >= due)
        };
        if dream_due {
            self.next_dream = ctx
                .config
                .dream
                .check_interval_secs
                .map(|secs| now + Duration::from_secs(secs));
            if ctx.config.dream.enabled {
                notice = match self.start_dream(ctx, false) {
                    Ok(started) => started,
                    Err(error) => Some(error),
                };
            }
        }
        let timeout = ctx.config.flush.idle_timeout_secs;
        if timeout == 0 {
            return notice;
        }
        match &mut self.idle_baseline {
            Some((id, len)) if id == session => {
                if conversation_len < *len {
                    *len = conversation_len;
                }
            }
            _ => self.idle_baseline = Some((session.to_string(), conversation_len)),
        }
        let due = *self
            .next_idle
            .get_or_insert_with(|| now + Duration::from_secs(timeout));
        if now < due {
            return notice;
        }
        self.next_idle = Some(now + Duration::from_secs(timeout));
        let grew = self
            .idle_baseline
            .as_ref()
            .is_some_and(|(_, len)| conversation_len > *len);
        if idle && grew && self.job.is_none() {
            if let Some((_, len)) = self.idle_baseline.as_mut() {
                *len = conversation_len;
            }
            if let Ok(started) = self.start_flush(ctx, "interval") {
                notice = Some(started);
            }
        }
        notice
    }
}

fn display_in_store(store: &Store, path: &Path) -> String {
    path.strip_prefix(&store.workspace_dir)
        .map(|relative| relative.display().to_string())
        .unwrap_or_else(|_| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        })
}

// ---------------------------------------------------------------------------
// Diagnostics: enums, counts, and times only. No prompt, note text, path,
// or session title is included, and nothing here starts a capture.

fn count_archive(store: &Store) -> (usize, usize) {
    let Ok(entries) = fs::read_dir(archive_dir(store)) else {
        return (0, 0);
    };
    let mut logs = 0;
    let mut backups = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".md") {
            continue;
        }
        if name.starts_with("MEMORY-before-dream-") {
            backups += 1;
        } else {
            logs += 1;
        }
    }
    (logs, backups)
}

fn status_line(status: &Value, kind: &str) -> String {
    let Some(entry) = status.get(kind).filter(|entry| entry.is_object()) else {
        return "none yet".into();
    };
    let outcome = entry
        .get("outcome")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    // Only known enum words are shown; anything else in the file is hidden.
    let outcome = match outcome {
        "written"
        | "save_on_end_off"
        | "below_threshold"
        | "failed"
        | "nothing_to_store"
        | "rejected"
        | "cancelled"
        | "completed"
        | "nothing_to_consolidate"
        | "conflict_kept_edit" => outcome,
        _ => "unknown",
    };
    let at = entry
        .get("at")
        .and_then(Value::as_u64)
        .map_or("unknown time".into(), utc_minute);
    let mut line = format!("{outcome} at {at}");
    for key in ["sessions", "archived"] {
        if let Some(count) = entry.get(key).and_then(Value::as_u64) {
            line.push_str(&format!(", {key} {count}"));
        }
    }
    line
}

/// `session_state` is `on`, `off (config)`, `off (this session)`, or
/// `off (force-disable)`.
pub fn diagnostics(
    store: &Store,
    config: &CaptureConfig,
    session_state: &str,
    running: Option<(&'static str, u64)>,
    current_session: Option<&str>,
) -> String {
    let now = now_secs();
    let mut out =
        String::from("Memory diagnostics (content-free: no prompts, notes, secrets, or paths)\n");
    out.push_str(&format!(
        "store: legacy (MEMORY.md, sessions/, index.sqlite); memory_v2: {}\n",
        if config.v2_requested {
            "requested but not implemented (capture and Dream off)"
        } else {
            "off"
        }
    ));
    out.push_str(&format!("memory this session: {session_state}\n"));
    out.push_str(&format!(
        "capture: session end {}; idle flush {}; pre-compaction flush not wired (dsh owns compaction)\n",
        if config.save_on_end { "on" } else { "off" },
        if config.flush.idle_timeout_secs == 0 {
            "off".to_string()
        } else {
            format!("every {}s", config.flush.idle_timeout_secs)
        }
    ));
    out.push_str(&format!(
        "automatic Dream: {} (min_hours {}, min_sessions {}, check {})\n",
        if config.dream.enabled { "on" } else { "off" },
        config.dream.min_hours,
        config.dream.min_sessions,
        config
            .dream
            .check_interval_secs
            .map_or("at launch only".into(), |secs| format!("every {secs}s"))
    ));
    let status = read_status(store);
    out.push_str(&format!(
        "capture cursor: last session save {}\n",
        status_line(&status, "session_save")
    ));
    let last = last_consolidated_at(&store.workspace_dir);
    let exclude = current_session.map(sid8);
    let waiting = sessions_since(
        &sessions_dir(store),
        last.unwrap_or(UNIX_EPOCH),
        exclude.as_deref(),
    )
    .unwrap_or_default();
    let oldest = waiting
        .iter()
        .filter_map(|stem| {
            fs::metadata(sessions_dir(store).join(format!("{stem}.md")))
                .ok()?
                .modified()
                .ok()
        })
        .min()
        .map(|time| age_text(now.saturating_sub(system_secs(time))));
    out.push_str(&format!(
        "queue: {} session log{} waiting for Dream{}\n",
        waiting.len(),
        if waiting.len() == 1 { "" } else { "s" },
        oldest.map_or(String::new(), |age| format!("; oldest pending {age}"))
    ));
    let hours_since = last.map(|time| now.saturating_sub(system_secs(time)) / 3_600);
    let gate = if !config.dream.enabled {
        "closed (automatic Dream off)".to_string()
    } else if hours_since.is_some_and(|hours| hours < config.dream.min_hours) {
        format!(
            "closed ({}h of {}h since the last Dream)",
            hours_since.unwrap_or(0),
            config.dream.min_hours
        )
    } else if (waiting.len() as u64) < config.dream.min_sessions {
        format!(
            "closed ({} of {} session logs)",
            waiting.len(),
            config.dream.min_sessions
        )
    } else {
        "open".into()
    };
    out.push_str(&format!("gate: {gate}\n"));
    out.push_str(&format!(
        "lease: {}\n",
        lease_state(
            &store.workspace_dir,
            config.dream.stale_lock_secs.max(DREAM_MIN_STALE_SECS)
        )
    ));
    out.push_str(&format!(
        "last consolidation: {}\n",
        last.map_or("never".into(), |time| utc_minute(system_secs(time)))
    ));
    out.push_str(&format!("last flush: {}\n", status_line(&status, "flush")));
    out.push_str(&format!("last Dream: {}\n", status_line(&status, "dream")));
    out.push_str(&format!(
        "running: {}\n",
        running.map_or("none".into(), |(kind, secs)| format!(
            "{kind} ({})",
            age_text(secs)
        ))
    ));
    let (logs, backups) = count_archive(store);
    out.push_str(&format!(
        "archive: {logs} consolidated session log{}, {backups} MEMORY.md backup{}\n",
        if logs == 1 { "" } else { "s" },
        if backups == 1 { "" } else { "s" }
    ));
    out.push_str(&format!("index warnings: {}\n", store.warnings.len()));
    out.push_str(&format!(
        "memory log: {}\n",
        match config.log {
            LogTarget::Off => "off",
            LogTarget::File(_) => "on (GROK_MEMORY_LOG)",
        }
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn store_in(dir: &Path) -> Store {
        let root = dir.join("memory");
        let workspace_dir = root.join("ws-1234abcd");
        fs::create_dir_all(&workspace_dir).unwrap();
        Store {
            root,
            workspace_dir,
            identity: "ws".into(),
            warnings: Vec::new(),
        }
    }

    fn age(path: &Path, secs: u64) {
        let file = OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(secs))
            .unwrap();
    }

    fn write_session(store: &Store, stem: &str, body: &str, secs_old: u64) -> PathBuf {
        let dir = sessions_dir(store);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{stem}.md"));
        fs::write(&path, body).unwrap();
        age(&path, secs_old);
        path
    }

    #[test]
    fn utc_formatting_and_slugify_follow_upstream() {
        assert_eq!(utc_date(1_790_319_909), "2026-09-25");
        assert_eq!(utc_minute(1_790_319_909), "2026-09-25 07:05 UTC");
        assert_eq!(utc_clock(1_790_319_909), "07:05:09 UTC");
        assert_eq!(utc_minute(1_709_251_140), "2024-02-29 23:59 UTC");
        assert_eq!(
            slugify("Fix the Auth bug!!  now", 30),
            "fix-the-auth-bug-now"
        );
        assert_eq!(slugify("修复 bug", 30), "bug");
        assert_eq!(slugify("修复", 30), "");
        assert_eq!(
            slugify("a very long first prompt that keeps going", 10),
            "a-very-lon"
        );
        assert!(is_no_reply("NO_REPLY"));
        assert!(is_no_reply(" no-reply. "));
        assert!(!is_no_reply("no reply needed here"));
    }

    #[test]
    fn config_defaults_overrides_and_memory_log() {
        let home = tempfile::tempdir().unwrap();
        let env = std::collections::BTreeMap::new();
        let empty = toml::Value::Table(Default::default());
        let config = load_config(&empty, &env, home.path());
        assert!(config.save_on_end);
        assert_eq!(config.dream, DreamConfig::default());
        assert_eq!(config.flush, FlushConfig::default());
        assert!(!config.v2_requested);
        assert_eq!(config.log, LogTarget::Off);
        let table: toml::Value = toml::from_str(
            "[memory.session]\nsave_on_end = false\n[memory.dream]\nenabled = false\nmin_hours = 1\nmin_sessions = 2\ncheck_interval_secs = 0\n[compaction.memory_flush]\nidle_timeout_secs = 0\nmax_flush_write_chars = 'x'\nflush_model = 'cheap'\n[memory_v2]\nenabled = true\n",
        )
        .unwrap();
        let mut env = std::collections::BTreeMap::new();
        env.insert("GROK_MEMORY_LOG".to_string(), "1".to_string());
        let config = load_config(&table, &env, home.path());
        assert!(!config.save_on_end);
        assert!(!config.dream.enabled);
        assert_eq!(config.dream.min_hours, 1);
        assert_eq!(config.dream.min_sessions, 2);
        assert_eq!(config.dream.check_interval_secs, None);
        assert_eq!(config.flush.idle_timeout_secs, 0);
        assert_eq!(config.flush.max_flush_write_chars, 8_000);
        assert_eq!(config.flush.flush_model.as_deref(), Some("cheap"));
        assert!(config.v2_requested);
        assert_eq!(
            config.log,
            LogTarget::File(home.path().join("logs").join("memory.log"))
        );
        let row = |key: &str| config.rows.iter().find(|row| row.0 == key).unwrap().clone();
        assert_eq!(row("memory.session.save_on_end").2, "config.toml");
        assert!(
            row("compaction.memory_flush.max_flush_write_chars")
                .2
                .contains("invalid")
        );
        assert!(row("memory_v2.enabled").1.contains("not implemented"));
        for value in ["", "0", "false", "off", "no"] {
            let raw = value.to_string();
            assert_eq!(resolve_log(Some(&raw), home.path()).0, LogTarget::Off);
        }
        let custom = "/tmp/custom-memory.log".to_string();
        assert_eq!(
            resolve_log(Some(&custom), home.path()).0,
            LogTarget::File(PathBuf::from(&custom))
        );
        let blocked = home.path().join("file");
        fs::write(&blocked, "x").unwrap();
        let warning = probe_log(&LogTarget::File(blocked.join("memory.log"))).unwrap();
        assert!(warning.starts_with("GROK_MEMORY_LOG: cannot write"));
        let good = LogTarget::File(home.path().join("logs/memory.log"));
        assert_eq!(probe_log(&good), None);
        log_event(&good, "flush.done", &[("outcome", "written".into())]);
        let text = fs::read_to_string(home.path().join("logs/memory.log")).unwrap();
        assert!(text.trim_end().ends_with("flush.done outcome=written"));
    }

    fn ledger(queries: &[&str]) -> SessionLedger {
        let mut ledger = SessionLedger::new("sess12345678-rest");
        for (index, query) in queries.iter().enumerate() {
            ledger.note_query(query);
            if query.starts_with('/') {
                continue;
            }
            ledger.note_answer(&format!("m{index}"));
            ledger.note_answer(&format!("m{index}"));
        }
        ledger.note_tool("t1");
        ledger
    }

    #[test]
    fn session_end_thresholds_summary_and_no_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let target = CaptureTarget {
            store: store.clone(),
            save_on_end: true,
            active: true,
            log: LogTarget::Off,
        };
        let now = 1_790_319_909;
        assert_eq!(
            finish_session(&target, &ledger(&["hi", "ok", "bye"]), now),
            SessionEnd::Skipped("below_threshold")
        );
        assert_eq!(
            finish_session(
                &target,
                &ledger(&["help me fix the auth bug", "also the tests"]),
                now
            ),
            SessionEnd::Skipped("below_threshold")
        );
        let off = CaptureTarget {
            active: false,
            ..target.clone()
        };
        let long = ledger(&[
            "help me fix the auth bug",
            "/model x",
            "also check the tests",
            "great, can you fix the login page too",
        ]);
        assert_eq!(finish_session(&off, &long, now), SessionEnd::Off);
        let summary = session_summary(&long, now);
        assert_eq!(
            summary,
            "## Session Summary\n\n- **Messages:** 3 user, 3 assistant, 1 tool results\n- **Date:** 2026-09-25 07:05 UTC\n\n## Topics Discussed\n\n1. help me fix the auth bug\n2. also check the tests\n3. great, can you fix the login page too\n\n"
        );
        let SessionEnd::Written(path) = finish_session(&target, &long, now) else {
            panic!("expected a session log");
        };
        assert_eq!(
            path,
            sessions_dir(&store).join("2026-09-25-help-me-fix-the-auth-bug-sess1234.md")
        );
        // A manual edit survives a second save of the same session.
        fs::write(&path, "my own notes\n").unwrap();
        assert!(matches!(
            finish_session(&target, &long, now),
            SessionEnd::Written(_)
        ));
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("my own notes\n"));
        assert!(
            text.contains("\n\n---\n\n<!-- session-end 07:05:09 UTC -->\n\n## Session Summary")
        );
        let status = read_status(&store);
        assert_eq!(status["session_save"]["outcome"], "written");
        let skipped = CaptureTarget {
            save_on_end: false,
            ..target
        };
        assert_eq!(
            finish_session(&skipped, &long, now),
            SessionEnd::Skipped("save_on_end_off")
        );
    }

    #[test]
    fn dream_lock_busy_stale_release_and_commit() {
        let dir = tempfile::tempdir().unwrap();
        let guard = acquire_dream_lock(dir.path(), 3_600).unwrap().unwrap();
        assert!(acquire_dream_lock(dir.path(), 3_600).unwrap().is_none());
        assert!(lease_state(dir.path(), 3_600).starts_with("held by this process"));
        drop(guard);
        assert!(!dir.path().join(MUTEX_FILE).exists());
        assert!(last_consolidated_at(dir.path()).is_none());
        // A lock left by a dead process is reclaimed (restart after a crash).
        fs::write(dir.path().join(MUTEX_FILE), "4194303 1").unwrap();
        assert!(lease_state(dir.path(), 3_600).starts_with("stale"));
        let guard = acquire_dream_lock(dir.path(), 3_600).unwrap().unwrap();
        assert!(guard.commit());
        assert!(last_consolidated_at(dir.path()).is_some());
        assert!(!dir.path().join(MUTEX_FILE).exists());
        assert_eq!(lease_state(dir.path(), 3_600), "free");
    }

    #[test]
    fn sessions_since_excludes_current_session_and_old_logs() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        write_session(&store, "2026-09-20-a-aaaaaaaa", "a", 7_200);
        write_session(&store, "2026-09-21-b-bbbbbbbb", "b", 60);
        write_session(&store, "2026-09-21-c-cccccccc", "c", 60);
        let all = sessions_since(&sessions_dir(&store), UNIX_EPOCH, Some("cccccccc")).unwrap();
        assert_eq!(all, vec!["2026-09-20-a-aaaaaaaa", "2026-09-21-b-bbbbbbbb"]);
        let recent = sessions_since(
            &sessions_dir(&store),
            SystemTime::now() - Duration::from_secs(3_600),
            None,
        )
        .unwrap();
        assert_eq!(recent.len(), 2);
    }

    #[test]
    fn dream_gates_manual_bypass_and_no_work() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let config = DreamConfig {
            min_sessions: 2,
            ..DreamConfig::default()
        };
        assert_eq!(
            plan_dream(&store, &config, Some("current1"), true),
            DreamStart::NoWork
        );
        write_session(&store, "2026-09-20-a-aaaaaaaa", "## A\nfact a\n", 7_200);
        assert!(matches!(
            plan_dream(&store, &config, Some("current1"), false),
            DreamStart::Gated(reason) if reason == "1 of 2 new session logs"
        ));
        let off = DreamConfig {
            enabled: false,
            ..config.clone()
        };
        assert!(matches!(
            plan_dream(&store, &off, None, false),
            DreamStart::Gated(_)
        ));
        // Manual Dream bypasses the gates.
        let DreamStart::Plan(plan) = plan_dream(&store, &off, Some("current1"), true) else {
            panic!("manual dream should plan");
        };
        assert_eq!(plan.stems, vec!["2026-09-20-a-aaaaaaaa"]);
        assert!(
            plan.input
                .starts_with("--- Session: 2026-09-20-a-aaaaaaaa ---\n\n## A")
        );
        // While this plan holds the lock another Dream is busy.
        assert_eq!(
            plan_dream(&store, &off, Some("current1"), true),
            DreamStart::Busy
        );
        drop(plan);
        guard_marker_absent(&store);
        let recent = acquire_dream_lock(&store.workspace_dir, 3_600)
            .unwrap()
            .unwrap();
        assert!(recent.commit());
        write_session(&store, "2026-09-21-b-bbbbbbbb", "b", 10);
        write_session(&store, "2026-09-21-c-cccccccc", "c", 10);
        assert!(matches!(
            plan_dream(&store, &config, None, false),
            DreamStart::Gated(reason) if reason.contains("since the last Dream")
        ));
    }

    fn guard_marker_absent(store: &Store) {
        assert!(!store.workspace_dir.join(MUTEX_FILE).exists());
        assert!(last_consolidated_at(&store.workspace_dir).is_none());
    }

    #[test]
    fn dream_commit_backs_up_archives_and_keeps_concurrent_edits() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let memory_path = workspace_memory_path(&store);
        fs::write(&memory_path, "# Old memory\n- keep me\n").unwrap();
        write_session(&store, "2026-09-20-a-aaaaaaaa", "## A\nfact a\n", 7_200);
        let fresh = write_session(&store, "2026-09-21-b-bbbbbbbb", "## B\nfact b\n", 10);
        let config = DreamConfig::default();
        let DreamStart::Plan(plan) = plan_dream(&store, &config, None, true) else {
            panic!("plan");
        };
        assert!(
            plan.input
                .starts_with("--- Existing Memory (merge with new sessions) ---\n\n# Old memory")
        );
        // A concurrent manual edit wins: nothing is written, no marker.
        fs::write(&memory_path, "# Old memory\n- keep me\n- my edit\n").unwrap();
        assert_eq!(
            commit_dream(&store, plan, "## Merged\nfacts\n"),
            DreamOutcome::Conflict
        );
        assert_eq!(
            fs::read_to_string(&memory_path).unwrap(),
            "# Old memory\n- keep me\n- my edit\n"
        );
        guard_marker_absent(&store);
        // Nothing to consolidate commits the marker and writes nothing.
        let DreamStart::Plan(plan) = plan_dream(&store, &config, None, true) else {
            panic!("plan");
        };
        assert_eq!(
            commit_dream(&store, plan, "NO_REPLY"),
            DreamOutcome::NothingToConsolidate
        );
        assert!(last_consolidated_at(&store.workspace_dir).is_some());
        fs::remove_file(store.workspace_dir.join(CONSOLIDATED_FILE)).unwrap();
        let DreamStart::Plan(plan) = plan_dream(&store, &config, None, true) else {
            panic!("plan");
        };
        let DreamOutcome::Completed {
            chars,
            sessions,
            archived,
            backup,
        } = commit_dream(&store, plan, "  ## Merged\nfact a\nfact b\n")
        else {
            panic!("completed");
        };
        assert_eq!(chars, "## Merged\nfact a\nfact b".chars().count());
        assert_eq!((sessions, archived), (2, 1));
        assert_eq!(
            fs::read_to_string(&memory_path).unwrap(),
            "## Merged\nfact a\nfact b\n"
        );
        let backup = backup.unwrap();
        assert_eq!(
            fs::read_to_string(&backup).unwrap(),
            "# Old memory\n- keep me\n- my edit\n"
        );
        // The fresh log stays (recency guard); the old one is archived.
        assert!(fresh.exists());
        assert!(
            archive_dir(&store)
                .join("2026-09-20-a-aaaaaaaa.md")
                .exists()
        );
        assert!(last_consolidated_at(&store.workspace_dir).is_some());
        assert!(!store.workspace_dir.join(MUTEX_FILE).exists());
        // A generated index is never overwritten by Dream.
        fs::write(&memory_path, "<!-- codsh-memory-index -->\n# Index\n").unwrap();
        assert!(matches!(
            plan_dream(&store, &config, None, true),
            DreamStart::Failed(_)
        ));
    }

    #[test]
    fn flush_processing_matches_upstream_rules() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let config = FlushConfig {
            max_flush_write_chars: 12,
            ..FlushConfig::default()
        };
        assert_eq!(
            commit_flush(
                &store,
                &config,
                "sess12345678",
                "user_requested",
                " NO_REPLY "
            ),
            FlushOutcome::NothingToStore
        );
        assert_eq!(
            commit_flush(&store, &config, "sess12345678", "user_requested", ""),
            FlushOutcome::NothingToStore
        );
        assert!(matches!(
            commit_flush(
                &store,
                &config,
                "sess12345678",
                "user_requested",
                "plain text"
            ),
            FlushOutcome::Rejected(_)
        ));
        let FlushOutcome::Written { path, chars, .. } = commit_flush(
            &store,
            &config,
            "sess12345678",
            "user_requested",
            "## Decisions\nuse sqlite",
        ) else {
            panic!("written");
        };
        assert_eq!(chars, 12);
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.ends_with("-user_requested-sess1234.md"), "{name}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "## Decisions");
        commit_flush(
            &store,
            &config,
            "sess12345678",
            "user_requested",
            "## More\n",
        );
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("## Decisions\n\n---\n\n<!-- flush "));
        assert!(text.ends_with(" UTC -->\n\n## More"));
        assert_eq!(flush_system_prompt(None), FLUSH_SYSTEM_PROMPT);
        assert!(
            flush_system_prompt(Some("## prev"))
                .ends_with("--- Previous flush content ---\n## prev")
        );
    }

    struct Harness {
        sent: RefCell<Vec<Value>>,
    }

    impl Harness {
        fn send(&self, message: &Value) -> Result<(), String> {
            self.sent.borrow_mut().push(message.clone());
            Ok(())
        }
    }

    fn reply(text: &str) -> ModelReply {
        parse_reply(&json!({
            "text": text,
            "provider": "mock",
            "model": "mock-model",
            "usage": { "inputTokens": 1200, "outputTokens": 30 },
            "sentMessages": 21,
            "sentChars": 9120,
        }))
    }

    /// Runs one `/flush` to completion and returns the system prompt sent.
    fn flush_once(runner: &mut Runner, ctx: &Ctx, harness: &Harness, answer: &str) -> String {
        runner.start_flush(ctx, "user_requested").unwrap();
        let request = harness.sent.borrow().last().unwrap().clone();
        let id = request["id"].as_str().unwrap().to_string();
        runner.accept(id, Ok(reply(answer)));
        let notices = runner.settle(ctx);
        assert!(notices[0].starts_with("Memory flushed: "), "{notices:?}");
        request["system"].as_str().unwrap().to_string()
    }

    #[test]
    fn first_flush_after_restart_uses_the_last_flush_on_disk() {
        // Issue #186 follow-up: the previous flush lived only in memory, so the
        // first /flush after a restart or --resume resent the whole window.
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let config = CaptureConfig::default();
        let harness = Harness {
            sent: RefCell::new(Vec::new()),
        };
        let send = |message: &Value| harness.send(message);
        let ctx = Ctx {
            store: &store,
            config: &config,
            active: true,
            session_id: Some("sess12345678-resumed"),
            send: &send,
        };
        let mut first = Runner::default();
        assert_eq!(
            flush_once(&mut first, &ctx, &harness, "## Decisions\none"),
            FLUSH_SYSTEM_PROMPT
        );
        assert!(
            flush_once(&mut first, &ctx, &harness, "## Decisions\ntwo")
                .ends_with("--- Previous flush content ---\n## Decisions\none")
        );
        // A session summary of the same session is not a flush log.
        write_daily_log(
            &store,
            "2026-09-27",
            "ship-it",
            "sess12345678",
            "## Summary\nx",
            "session-end",
            0,
        )
        .unwrap();
        // Restart: a new runner reads the last segment back from disk.
        let mut restarted = Runner::default();
        let hint = restarted.start_flush(&ctx, "user_requested").unwrap();
        assert!(hint.contains("(new since the last flush)"), "{hint}");
        let system = harness.sent.borrow().last().unwrap()["system"].clone();
        assert_eq!(system, flush_system_prompt(Some("## Decisions\ntwo")));
        assert_eq!(restarted.running().map(|(name, _)| name), Some("flush"));
        // Dream archived the log (with a `-N` suffix): still recovered.
        let live: Vec<_> = fs::read_dir(sessions_dir(&store))
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.to_string_lossy().contains("user_requested"))
            .collect();
        assert_eq!(live.len(), 1, "{live:?}");
        fs::create_dir_all(archive_dir(&store)).unwrap();
        let archived = archive_dir(&store).join(format!(
            "{}-1.md",
            live[0].file_stem().unwrap().to_string_lossy()
        ));
        fs::rename(&live[0], &archived).unwrap();
        assert_eq!(
            previous_flush_on_disk(&store, "sess12345678-resumed").as_deref(),
            Some("## Decisions\ntwo")
        );
        // Another session has no previous flush.
        assert_eq!(previous_flush_on_disk(&store, "other123-session"), None);
        assert!(is_flush_log_of(
            "2026-09-27-interval-sess1234.md",
            "sess1234"
        ));
        assert!(is_flush_log_of(
            "2026-09-27-user_requested-sess1234-12.md",
            "sess1234"
        ));
        assert!(!is_flush_log_of(
            "2026-09-27-ship-it-sess1234.md",
            "sess1234"
        ));
        assert!(!is_flush_log_of(
            "2026-09-27-interval-other123.md",
            "sess1234"
        ));
        assert!(!is_flush_log_of(
            "2026-09-27-interval-sess1234.txt",
            "sess1234"
        ));
        assert!(!is_flush_log_of(
            "日本語日本語-interval-sess1234.md",
            "sess1234"
        ));
    }

    #[test]
    fn busy_refusals_are_recognized() {
        for text in [FLUSH_BUSY, FLUSH_BUSY_DREAM, DREAM_BUSY, DREAM_BUSY_FLUSH] {
            assert!(is_busy_refusal(text));
        }
        assert!(!is_busy_refusal("Dream is turned off for this session."));
        assert!(!is_busy_refusal(V2_REFUSAL));
    }

    #[test]
    fn runner_flush_dream_busy_cancel_and_refusals() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let config = CaptureConfig::default();
        let harness = Harness {
            sent: RefCell::new(Vec::new()),
        };
        let send = |message: &Value| harness.send(message);
        let ctx = Ctx {
            store: &store,
            config: &config,
            active: true,
            session_id: Some("sess12345678"),
            send: &send,
        };
        let mut runner = Runner::default();
        let hint = runner.start_flush(&ctx, "user_requested").unwrap();
        assert!(hint.contains("the last 20 messages"), "{hint}");
        let request = harness.sent.borrow()[0].clone();
        assert_eq!(request["type"], "memory_model");
        assert_eq!(request["purpose"], "flush");
        assert_eq!(request["window"], 20);
        assert_eq!(request["user"], FLUSH_CLOSER);
        assert_eq!(request["system"], FLUSH_SYSTEM_PROMPT);
        assert_eq!(
            runner.start_flush(&ctx, "user_requested").unwrap_err(),
            "Another memory flush is already running."
        );
        let id = request["id"].as_str().unwrap().to_string();
        runner.accept("other".into(), Ok(reply("## ignored")));
        runner.accept(id, Ok(reply("## Decisions\nkeep the ledger")));
        let notices = runner.settle(&ctx);
        assert_eq!(notices.len(), 1);
        assert!(notices[0].starts_with("Memory flushed: "), "{}", notices[0]);
        assert!(notices[0].contains("sent 21 messages / 9,120 chars to mock/mock-model"));
        assert!(notices[0].contains("tokens in 1,200, out 30"));
        assert!(notices[0].contains("cost not reported"));
        // The second flush of this session asks for the delta only.
        runner.start_flush(&ctx, "user_requested").unwrap();
        let delta = harness.sent.borrow().last().unwrap().clone();
        assert!(
            delta["system"]
                .as_str()
                .unwrap()
                .ends_with("## Decisions\nkeep the ledger")
        );
        assert_eq!(
            runner
                .cancel(Some(&store), &LogTarget::Off, Some(&send))
                .unwrap(),
            "Memory flush cancelled."
        );
        assert_eq!(
            harness.sent.borrow().last().unwrap()["type"],
            "memory_model_cancel"
        );

        // Manual Dream on two old logs; a cancel releases the lock unmarked.
        write_session(&store, "2026-09-20-a-aaaaaaaa", "## A\nfact a\n", 7_200);
        let hint = runner.start_dream(&ctx, true).unwrap().unwrap();
        assert!(hint.starts_with("Dream running: 1 session log"), "{hint}");
        assert_eq!(
            runner.start_dream(&ctx, true).unwrap_err(),
            "Dream is already running; try again when it finishes."
        );
        assert!(runner.cancel(Some(&store), &LogTarget::Off, None).is_some());
        guard_marker_absent(&store);
        // A failed Dream leaves the gate open too.
        runner.start_dream(&ctx, true).unwrap();
        let id = harness.sent.borrow().last().unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        runner.accept(
            id,
            Err(parse_failure(&json!({ "message": "provider down" }))),
        );
        assert_eq!(
            runner.settle(&ctx),
            vec!["Dream failed: provider down".to_string()]
        );
        guard_marker_absent(&store);
        runner.start_dream(&ctx, true).unwrap();
        let id = harness.sent.borrow().last().unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        runner.accept(id, Ok(reply("## Merged\nfact a\n")));
        let notices = runner.settle(&ctx);
        assert!(
            notices[0].starts_with("Dream completed: MEMORY.md rewritten"),
            "{}",
            notices[0]
        );
        assert!(workspace_memory_path(&store).exists());

        let v2 = CaptureConfig {
            v2_requested: true,
            ..CaptureConfig::default()
        };
        let v2_ctx = Ctx { config: &v2, ..ctx };
        assert_eq!(
            runner.start_flush(&v2_ctx, "user_requested").unwrap_err(),
            V2_REFUSAL
        );
        assert_eq!(runner.start_dream(&v2_ctx, false).unwrap(), None);
        assert!(!store.root.join("memory-v2").exists());
        let off_ctx = Ctx {
            active: false,
            ..ctx
        };
        assert_eq!(
            runner.start_flush(&off_ctx, "user_requested").unwrap_err(),
            "Memory is turned off for this session."
        );
        assert_eq!(
            runner.start_dream(&off_ctx, true).unwrap_err(),
            "Dream is turned off for this session."
        );
    }

    #[test]
    fn idle_flush_runs_only_when_the_conversation_grew() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let mut config = CaptureConfig::default();
        config.dream.enabled = false;
        config.flush.idle_timeout_secs = 1;
        let harness = Harness {
            sent: RefCell::new(Vec::new()),
        };
        let send = |message: &Value| harness.send(message);
        let ctx = Ctx {
            store: &store,
            config: &config,
            active: true,
            session_id: Some("sess12345678"),
            send: &send,
        };
        let mut runner = Runner::default();
        assert_eq!(runner.tick(&ctx, true, 4), None);
        runner.next_idle = Some(Instant::now());
        assert_eq!(runner.tick(&ctx, true, 4), None, "no growth, no flush");
        runner.next_idle = Some(Instant::now());
        assert_eq!(
            runner.tick(&ctx, false, 6),
            None,
            "a running turn is not idle"
        );
        runner.next_idle = Some(Instant::now());
        let hint = runner.tick(&ctx, true, 6).unwrap();
        assert!(hint.starts_with("Background memory flush running"));
        assert_eq!(harness.sent.borrow().len(), 1);
    }

    #[test]
    fn diagnostics_are_content_free_and_start_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        fs::write(
            workspace_memory_path(&store),
            "# Secret project\napi_key=sk-123\n",
        )
        .unwrap();
        write_session(
            &store,
            "2026-09-20-private-title-aaaaaaaa",
            "secret body",
            7_200,
        );
        record_status(&store, "flush", "written", 1_790_319_909, &[]);
        let before = fs::read_to_string(status_path(&store)).unwrap();
        let config = CaptureConfig::default();
        let text = diagnostics(&store, &config, "on", Some(("flush", 12)), Some("current1"));
        for secret in [
            "Secret",
            "sk-123",
            "private",
            "secret body",
            &store.root.display().to_string(),
        ] {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        assert!(text.contains("queue: 1 session log waiting for Dream; oldest pending 2h 0m"));
        assert!(text.contains("gate: closed (1 of 5 session logs)"));
        assert!(text.contains("lease: free"));
        assert!(text.contains("last flush: written at 2026-09-25 07:05 UTC"));
        assert!(text.contains("running: flush (12s)"));
        assert!(text.contains("archive: 0 consolidated session logs, 0 MEMORY.md backups"));
        assert_eq!(fs::read_to_string(status_path(&store)).unwrap(), before);
        assert!(!store.workspace_dir.join(MUTEX_FILE).exists());
    }
}
