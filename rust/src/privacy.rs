//! Local feedback drafts and opt-in, redacted diagnostics.
//!
//! Nonessential telemetry, session tracking, and content sharing stay off unless
//! the user enables them and names a substitute destination. Drafts stay on disk
//! until an explicit submit. Model provider calls are a separate route.

use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write as _};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const DRAFTS_FILENAME: &str = "feedback_drafts.json";
pub const SCHEMA_VERSION: u32 = 1;
const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_DRAFTS: usize = 1_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrivacyError {
    BlankTitle,
    BlankDetails,
    TooLarge {
        field: &'static str,
        observed: usize,
    },
    Capacity,
    NotFound,
    UnsupportedSchema(u32),
    InvalidDocument(&'static str),
    Disabled(&'static str),
    NoDestination,
    Io(String),
    Http(u16),
}

impl std::fmt::Display for PrivacyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BlankTitle => write!(formatter, "feedback title cannot be blank"),
            Self::BlankDetails => write!(formatter, "feedback details cannot be blank"),
            Self::TooLarge { field, observed } => {
                write!(formatter, "{field} is too large ({observed} bytes)")
            }
            Self::Capacity => write!(formatter, "feedback draft limit reached"),
            Self::NotFound => write!(formatter, "feedback draft not found"),
            Self::UnsupportedSchema(version) => {
                write!(formatter, "unsupported feedback drafts schema {version}")
            }
            Self::InvalidDocument(reason) => write!(formatter, "invalid feedback drafts: {reason}"),
            Self::Disabled(feature) => write!(
                formatter,
                "{feature} is disabled. Enable it in config.toml and set a substitute destination."
            ),
            Self::NoDestination => write!(
                formatter,
                "no substitute destination is configured; nothing was sent"
            ),
            Self::Io(message) => write!(formatter, "{message}"),
            Self::Http(status) => write!(
                formatter,
                "destination rejected the submission (HTTP {status}); the local draft was kept"
            ),
        }
    }
}

impl From<io::Error> for PrivacyError {
    fn from(error: io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackType {
    Bug,
    Idea,
    MissingCapability,
}

impl FeedbackType {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "bug" => Some(Self::Bug),
            "idea" => Some(Self::Idea),
            "missing_capability" | "missing-capability" | "missing" => {
                Some(Self::MissingCapability)
            }
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Bug => "bug",
            Self::Idea => "idea",
            Self::MissingCapability => "missing_capability",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedbackDraft {
    pub id: String,
    pub title: String,
    pub details: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub area: Option<String>,
    #[serde(rename = "type")]
    pub r#type: FeedbackType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_mode: Option<String>,
    pub created_at: i64,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct DraftDocument {
    schema_version: u32,
    drafts: Vec<FeedbackDraft>,
}

impl Default for DraftDocument {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            drafts: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct DraftStore {
    path: PathBuf,
}

impl DraftStore {
    pub fn new(session_dir: &Path) -> Self {
        Self {
            path: session_dir.join(DRAFTS_FILENAME),
        }
    }

    pub fn append(&self, input: DraftInput<'_>) -> Result<FeedbackDraft, PrivacyError> {
        validate_title(input.title)?;
        validate_details(input.details)?;
        let task_category = parse_task_category(input.task_category)?;
        let failure_mode = parse_failure_mode(input.failure_mode)?;
        let mut document = self.load()?;
        if document.drafts.len() >= MAX_DRAFTS {
            return Err(PrivacyError::Capacity);
        }
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| PrivacyError::Io(error.to_string()))?
            .as_secs();
        let draft = FeedbackDraft {
            id: format!("draft-{created_at}-{}", document.drafts.len() + 1),
            title: input.title.trim().to_string(),
            details: input.details.trim().to_string(),
            area: trimmed_option(input.area),
            r#type: input.kind,
            task_category,
            failure_mode,
            created_at: i64::try_from(created_at).unwrap_or(i64::MAX),
            revision: 1,
        };
        document.drafts.push(draft.clone());
        self.commit(&document)?;
        Ok(draft)
    }

    pub fn list(&self) -> Result<Vec<FeedbackDraft>, PrivacyError> {
        Ok(self.load()?.drafts)
    }

    pub fn get(&self, id: &str) -> Result<Option<FeedbackDraft>, PrivacyError> {
        Ok(self.load()?.drafts.into_iter().find(|draft| draft.id == id))
    }

    pub fn update(&self, id: &str, input: DraftInput<'_>) -> Result<FeedbackDraft, PrivacyError> {
        validate_title(input.title)?;
        validate_details(input.details)?;
        let task_category = parse_task_category(input.task_category)?;
        let failure_mode = parse_failure_mode(input.failure_mode)?;
        let mut document = self.load()?;
        let Some(draft) = document.drafts.iter_mut().find(|draft| draft.id == id) else {
            return Err(PrivacyError::NotFound);
        };
        draft.title = input.title.trim().to_string();
        draft.details = input.details.trim().to_string();
        draft.area = trimmed_option(input.area);
        draft.r#type = input.kind;
        draft.task_category = task_category;
        draft.failure_mode = failure_mode;
        draft.revision = draft.revision.saturating_add(1);
        let saved = draft.clone();
        self.commit(&document)?;
        Ok(saved)
    }

    pub fn delete(&self, id: &str) -> Result<bool, PrivacyError> {
        let mut document = self.load()?;
        let before = document.drafts.len();
        document.drafts.retain(|draft| draft.id != id);
        if document.drafts.len() == before {
            return Ok(false);
        }
        self.commit(&document)?;
        Ok(true)
    }

    fn load(&self) -> Result<DraftDocument, PrivacyError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Ok(DraftDocument::default());
            }
            Err(error) => return Err(error.into()),
        };
        if bytes.is_empty() {
            return Ok(DraftDocument::default());
        }
        let document: DraftDocument = serde_json::from_slice(&bytes)
            .map_err(|_| PrivacyError::InvalidDocument("not a feedback draft document"))?;
        if document.schema_version != SCHEMA_VERSION {
            return Err(PrivacyError::UnsupportedSchema(document.schema_version));
        }
        if document.drafts.len() > MAX_DRAFTS {
            return Err(PrivacyError::Capacity);
        }
        let mut ids = std::collections::BTreeSet::new();
        for draft in &document.drafts {
            if draft.id.is_empty() || !ids.insert(draft.id.clone()) {
                return Err(PrivacyError::InvalidDocument("duplicate or empty draft id"));
            }
            if draft.revision == 0 {
                return Err(PrivacyError::InvalidDocument("revision must be positive"));
            }
            validate_title(&draft.title)?;
            validate_details(&draft.details)?;
        }
        Ok(document)
    }

    fn commit(&self, document: &DraftDocument) -> Result<(), PrivacyError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec_pretty(document)
            .map_err(|error| PrivacyError::Io(error.to_string()))?;
        let tmp = self.path.with_extension("json.tmp");
        {
            let mut options = OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(&bytes)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
        }
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrivacyPolicy {
    pub telemetry: bool,
    pub feedback: bool,
    pub trace_upload: bool,
    pub share_content: bool,
    pub telemetry_url: Option<String>,
    pub feedback_url: Option<String>,
    pub trace_url: Option<String>,
    pub share_session: bool,
    pub telemetry_locked: bool,
    pub feedback_locked: bool,
    pub trace_locked: bool,
    pub content_locked: bool,
}

impl PrivacyPolicy {
    pub fn from_config(config: &crate::config::EffectiveConfig) -> Self {
        let setting = |key: &str| {
            config
                .settings
                .iter()
                .find(|row| row.key == key)
                .map(|row| (row.value.as_str(), row.source.as_str()))
        };
        let locked = |key: &str| {
            setting(&format!("{key}.lock"))
                .is_some_and(|(_, source)| source == "locked" || source == "requirements")
        };
        Self {
            telemetry: config.telemetry,
            feedback: config.feedback,
            trace_upload: config.trace_upload,
            share_content: config.share_content,
            telemetry_url: config.telemetry_url.clone(),
            feedback_url: config.feedback_url.clone(),
            trace_url: config.trace_url.clone(),
            share_session: config.share_session,
            telemetry_locked: locked("features.telemetry"),
            feedback_locked: locked("features.feedback"),
            trace_locked: locked("features.trace_upload"),
            content_locked: locked("privacy.share_content"),
        }
    }
}

/// Public feedback POST body. `structured_feedback` is reserved for this client
/// envelope and is stripped from `GROK_USER_METADATA` before the merge.
#[derive(Clone, Debug, Serialize)]
pub struct FeedbackSubmission {
    pub schema_version: u32,
    pub source: &'static str,
    pub title: String,
    pub details: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub area: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub metadata: serde_json::Value,
}

pub const TASK_CATEGORIES: &[&str] = &[
    "code_edit",
    "debug",
    "explain",
    "plan",
    "shell",
    "search",
    "review",
    "other",
];

pub const FAILURE_MODES: &[&str] = &[
    "overeager",
    "stopped_early",
    "unwanted_scope",
    "didnt_ask_for_help",
    "excessive_questions",
    "subagent_overspawn",
    "over_correction",
    "ignored_instructions",
    "hallucinated",
    "sloppy_code",
    "destructive",
    "lost_context",
    "stuck_in_a_loop",
    "model_regression",
    "disputed",
    "wrong_tone",
    "unclear_output",
    "other",
];

/// Fields the public `send_feedback` tool accepts. `draft_id` is the existing
/// local id to update and is never written into the posted envelope.
#[derive(Clone, Debug)]
pub struct DraftInput<'a> {
    pub title: &'a str,
    pub details: &'a str,
    pub area: Option<&'a str>,
    pub kind: FeedbackType,
    pub task_category: Option<&'a str>,
    pub failure_mode: Option<&'a str>,
}

const REDACTED_DETAILS: &str = "[redacted: privacy.share_content is off]";

pub fn submission_from_draft(
    draft: &FeedbackDraft,
    share_content: bool,
    user_metadata: Option<&str>,
) -> Result<FeedbackSubmission, PrivacyError> {
    let mut metadata = serde_json::Map::new();
    if let Some(user_meta) = parse_user_metadata(user_metadata)? {
        metadata = user_meta;
    }
    metadata.remove("structured_feedback");
    let mut structured = serde_json::Map::new();
    structured.insert("schema_version".into(), serde_json::json!(SCHEMA_VERSION));
    structured.insert("source".into(), serde_json::json!("draft"));
    structured.insert("type".into(), serde_json::json!(draft.r#type.as_str()));
    if let Some(category) = draft.task_category.as_deref() {
        structured.insert("task_category".into(), serde_json::json!(category));
    }
    if let Some(mode) = draft.failure_mode.as_deref() {
        structured.insert("failure_mode".into(), serde_json::json!(mode));
    }
    metadata.insert(
        "structured_feedback".into(),
        serde_json::Value::Object(structured),
    );
    let details = if share_content {
        draft.details.clone()
    } else {
        REDACTED_DETAILS.to_string()
    };
    let area = if share_content {
        draft.area.clone()
    } else {
        None
    };
    let title = if share_content {
        draft.title.clone()
    } else {
        format!("{} (redacted)", draft.r#type.as_str())
    };
    Ok(FeedbackSubmission {
        schema_version: SCHEMA_VERSION,
        source: "draft",
        title,
        details,
        area,
        kind: draft.r#type.as_str().to_string(),
        metadata: serde_json::Value::Object(metadata),
    })
}

fn parse_user_metadata(
    raw: Option<&str>,
) -> Result<Option<serde_json::Map<String, serde_json::Value>>, PrivacyError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let value: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|_| PrivacyError::Io("GROK_USER_METADATA must be a JSON object".into()))?;
    match value {
        serde_json::Value::Object(map) => Ok(Some(map)),
        _ => Err(PrivacyError::Io(
            "GROK_USER_METADATA must be a JSON object".into(),
        )),
    }
}

/// Counters and kinds only. Prompts, keys, paths, and free-form errors never enter this body.
#[derive(Clone, Debug, Serialize)]
pub struct DiagnosticEvent {
    pub schema_version: u32,
    pub kind: &'static str,
    pub ok: bool,
    pub count: u32,
}

pub fn diagnostic_preview(event: &DiagnosticEvent) -> String {
    format!(
        "Diagnostic preview (redacted)\n\
         Sent only when telemetry is enabled and endpoints.telemetry_url is set.\n\
         Included: kind, ok, count.\n\
         Excluded: prompts, answers, draft text, API keys, tokens, paths, and free-form errors.\n\
         This is not model traffic. Model calls use the configured provider base_url only.\n\
         {payload}",
        payload = serde_json::to_string(event).unwrap_or_else(|_| "{}".into())
    )
}

pub struct SubmitResult {
    pub status: u16,
    pub deleted: bool,
}

pub fn submit_draft(
    store: &DraftStore,
    id: &str,
    policy: &PrivacyPolicy,
) -> Result<SubmitResult, PrivacyError> {
    if !policy.feedback {
        return Err(PrivacyError::Disabled("feedback"));
    }
    let Some(url) = substitute_url(policy.feedback_url.as_deref()) else {
        return Err(PrivacyError::NoDestination);
    };
    let Some(draft) = store.get(id)? else {
        return Err(PrivacyError::NotFound);
    };
    let share_content = policy.share_content && !policy.content_locked;
    let user_metadata = std::env::var("GROK_USER_METADATA").ok();
    let submission = submission_from_draft(&draft, share_content, user_metadata.as_deref())?;
    let body =
        serde_json::to_string(&submission).map_err(|error| PrivacyError::Io(error.to_string()))?;
    match post_json(&url, &body) {
        Ok(status) if (200..300).contains(&status) => {
            let deleted = store.delete(id).unwrap_or(false);
            Ok(SubmitResult { status, deleted })
        }
        Ok(status) => Err(PrivacyError::Http(status)),
        Err(PrivacyError::Http(status)) => Err(PrivacyError::Http(status)),
        Err(_) => Err(PrivacyError::Io(
            "feedback destination did not accept the draft; local copy kept".into(),
        )),
    }
}

/// One redacted counter posted to `endpoints.trace_upload_url` when trace
/// upload is effectively on. The body never includes prompts, drafts, or keys.
/// `share_session` only adds the caller-supplied session id; it never invents
/// one and never attaches draft text.
pub fn emit_trace(
    policy: &PrivacyPolicy,
    session_id: Option<&str>,
    kind: &'static str,
    count: u32,
) -> Result<Option<String>, PrivacyError> {
    if !policy.trace_upload || policy.trace_locked {
        return Ok(None);
    }
    let Some(url) = substitute_url(policy.trace_url.as_deref()) else {
        return Err(PrivacyError::NoDestination);
    };
    let mut body = serde_json::json!({
        "schema_version": SCHEMA_VERSION,
        "kind": kind,
        "ok": true,
        "count": count,
        "share_content": false,
    });
    if policy.share_session
        && let Some(session_id) = session_id.filter(|value| !value.is_empty())
        && let Some(object) = body.as_object_mut()
    {
        object.insert(
            "session_id".into(),
            serde_json::Value::String(session_id.to_string()),
        );
    }
    let encoded =
        serde_json::to_string(&body).map_err(|error| PrivacyError::Io(error.to_string()))?;
    match post_json(&url, &encoded) {
        Ok(status) if (200..300).contains(&status) => Ok(Some(encoded)),
        Ok(status) => Err(PrivacyError::Http(status)),
        Err(PrivacyError::Http(status)) => Err(PrivacyError::Http(status)),
        Err(_) => Err(PrivacyError::Io(
            "trace destination was not reached; no prompt or key was included".into(),
        )),
    }
}

fn substitute_url(url: Option<&str>) -> Option<String> {
    let value = url.map(str::trim).filter(|value| !value.is_empty())?;
    if is_official_endpoint(value) {
        return None;
    }
    Some(value.to_string())
}

pub fn emit_diagnostic(
    policy: &PrivacyPolicy,
    event: &DiagnosticEvent,
) -> Result<Option<String>, PrivacyError> {
    if !policy.telemetry {
        return Ok(None);
    }
    let Some(url) = policy
        .telemetry_url
        .as_deref()
        .filter(|url| !url.is_empty())
    else {
        return Err(PrivacyError::NoDestination);
    };
    if is_official_endpoint(url) {
        return Err(PrivacyError::NoDestination);
    }
    let body = serde_json::to_string(event).map_err(|error| PrivacyError::Io(error.to_string()))?;
    match post_json(url, &body) {
        Ok(status) if (200..300).contains(&status) => Ok(Some(body)),
        Ok(status) => Err(PrivacyError::Http(status)),
        Err(PrivacyError::Http(status)) => Err(PrivacyError::Http(status)),
        Err(_) => Err(PrivacyError::Io(
            "telemetry destination was not reached; no prompt or key was included".into(),
        )),
    }
}

/// Official hosts are refused by parsed host, not by a raw substring.
/// Only `http` and `https` are destinations. Userinfo, path, and query text
/// that merely mention an official name do not make a loopback URL official.
pub fn is_official_endpoint(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url.trim()) else {
        return true;
    };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return true;
    }
    let Some(host) = parsed.host_str() else {
        return true;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "x.ai"
        || host.ends_with(".x.ai")
        || host == "grok.com"
        || host.ends_with(".grok.com")
        || host == "sentry.io"
        || host.ends_with(".sentry.io")
}

fn post_json(url: &str, body: &str) -> Result<u16, PrivacyError> {
    let response = ureq::post(url)
        .set("content-type", "application/json")
        .set("user-agent", "codsh-rust-privacy")
        .send_bytes(body.as_bytes())
        .map_err(|error| match error {
            ureq::Error::Status(code, _) => PrivacyError::Http(code),
            other => PrivacyError::Io(other.to_string()),
        })?;
    Ok(response.status())
}

pub fn session_dir(dsh_home: &Path, session_id: &str) -> Result<PathBuf, PrivacyError> {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return Err(PrivacyError::InvalidDocument("unsafe session id"));
    }
    Ok(dsh_home.join("feedback-sessions").join(session_id))
}

pub fn append_local_log(path: &Path, line: &str) -> Result<(), PrivacyError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    writeln!(file, "{line}")?;
    Ok(())
}

pub fn local_log_line(kind: &str, ok: bool, count: u32) -> String {
    format!(
        "{{\"kind\":\"{}\",\"ok\":{},\"count\":{}}}",
        kind.replace('"', ""),
        ok,
        count
    )
}

fn trimmed_option(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn parse_task_category(value: Option<&str>) -> Result<Option<String>, PrivacyError> {
    let Some(value) = trimmed_option(value) else {
        return Ok(None);
    };
    if TASK_CATEGORIES.contains(&value.as_str()) {
        Ok(Some(value))
    } else {
        Err(PrivacyError::Io(format!(
            "task_category must be one of {}",
            TASK_CATEGORIES.join(", ")
        )))
    }
}

pub fn parse_failure_mode(value: Option<&str>) -> Result<Option<String>, PrivacyError> {
    let Some(value) = trimmed_option(value) else {
        return Ok(None);
    };
    if FAILURE_MODES.contains(&value.as_str()) {
        Ok(Some(value))
    } else {
        Err(PrivacyError::Io(format!(
            "failure_mode must be one of {}",
            FAILURE_MODES.join(", ")
        )))
    }
}

fn validate_title(title: &str) -> Result<(), PrivacyError> {
    if title.trim().is_empty() {
        return Err(PrivacyError::BlankTitle);
    }
    if title.len() > MAX_TEXT_BYTES {
        return Err(PrivacyError::TooLarge {
            field: "title",
            observed: title.len(),
        });
    }
    Ok(())
}

fn validate_details(details: &str) -> Result<(), PrivacyError> {
    if details.trim().is_empty() {
        return Err(PrivacyError::BlankDetails);
    }
    if details.len() > MAX_TEXT_BYTES {
        return Err(PrivacyError::TooLarge {
            field: "details",
            observed: details.len(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn serve(status: &str, capture: std::sync::Arc<std::sync::Mutex<Vec<u8>>>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let status = status.to_string();
        thread::spawn(move || {
            for _ in 0..8 {
                let Ok((mut socket, _)) = listener.accept() else {
                    break;
                };
                let mut buf = [0_u8; 8192];
                let n = socket.read(&mut buf).unwrap_or(0);
                capture.lock().unwrap().extend_from_slice(&buf[..n]);
                let body = if status == "200" {
                    "{\"ok\":true}"
                } else {
                    "{\"ok\":false}"
                };
                let response = format!(
                    "HTTP/1.1 {status} OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes());
            }
        });
        format!("http://127.0.0.1:{port}/feedback")
    }

    #[test]
    fn drafts_stay_local_until_explicit_submit_and_survive_failure() {
        let dir = tempfile::tempdir().unwrap();
        let store = DraftStore::new(dir.path());
        let draft = store
            .append(DraftInput {
                title: "Broken fold",
                details: "The fold loses the prompt.",
                area: None,
                kind: FeedbackType::Bug,
                task_category: Some("debug"),
                failure_mode: None,
            })
            .unwrap();
        assert!(dir.path().join(DRAFTS_FILENAME).is_file());
        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 1);
        let off = PrivacyPolicy {
            telemetry: false,
            feedback: false,
            trace_upload: false,
            share_content: false,
            telemetry_url: None,
            feedback_url: Some("http://127.0.0.1:9/feedback".into()),
            trace_url: None,
            share_session: false,
            telemetry_locked: false,
            feedback_locked: false,
            trace_locked: false,
            content_locked: false,
        };
        assert!(matches!(
            submit_draft(&store, &draft.id, &off),
            Err(PrivacyError::Disabled(_))
        ));
        assert!(store.get(&draft.id).unwrap().is_some());

        let capture = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let url = serve("500", capture.clone());
        let mut failing = off.clone();
        failing.feedback = true;
        failing.feedback_url = Some(url);
        assert!(matches!(
            submit_draft(&store, &draft.id, &failing),
            Err(PrivacyError::Http(500))
        ));
        let kept = store.get(&draft.id).unwrap().unwrap();
        let edited = store
            .update(
                &kept.id,
                DraftInput {
                    title: "Broken fold again",
                    details: "Still loses the prompt after retry.",
                    area: Some("composer"),
                    kind: FeedbackType::Bug,
                    task_category: Some("debug"),
                    failure_mode: None,
                },
            )
            .unwrap();
        assert_eq!(edited.revision, 2);
        assert!(
            store
                .get(&draft.id)
                .unwrap()
                .unwrap()
                .title
                .contains("again")
        );

        let ok_capture = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let ok_url = serve("200", ok_capture.clone());
        failing.feedback_url = Some(ok_url);
        let sent = submit_draft(&store, &draft.id, &failing).unwrap();
        assert!(sent.deleted);
        assert!(store.get(&draft.id).unwrap().is_none());
        let wire = String::from_utf8(ok_capture.lock().unwrap().clone()).unwrap();
        assert!(wire.contains("structured_feedback"));
        assert!(wire.contains("task_category"));
        assert!(wire.contains("[redacted: privacy.share_content is off]"));
        assert!(!wire.contains("Still loses the prompt"));
        assert!(!wire.contains("sk-"));
        assert!(!store.delete("missing").unwrap());

        let redacted = submission_from_draft(
            &edited,
            false,
            Some(r#"{"structured_feedback":{"type":"idea"},"client":"codsh"}"#),
        )
        .unwrap();
        let encoded = serde_json::to_string(&redacted).unwrap();
        assert!(encoded.contains("\"client\":\"codsh\""));
        assert!(!encoded.contains("\"type\":\"idea\""));
        assert!(encoded.contains("\"type\":\"bug\""));
        let shared = submission_from_draft(&edited, true, None).unwrap();
        assert_eq!(shared.details, "Still loses the prompt after retry.");
        assert_eq!(shared.area.as_deref(), Some("composer"));
    }

    #[test]
    fn official_hosts_use_the_parsed_host_not_a_substring() {
        assert!(is_official_endpoint("https://api.x.ai/v1"));
        assert!(is_official_endpoint("https://API.X.AI./v1"));
        assert!(is_official_endpoint("https://telemetry.x.ai/v1"));
        assert!(is_official_endpoint("https://user:pass@grok.com/feedback"));
        assert!(is_official_endpoint(
            "https://o123.ingest.sentry.io/api/1/envelope/"
        ));
        assert!(is_official_endpoint("ftp://127.0.0.1/feedback"));
        assert!(is_official_endpoint("not a url"));
        assert!(!is_official_endpoint(
            "http://127.0.0.1/feedback?next=https://api.x.ai/v1"
        ));
        assert!(!is_official_endpoint(
            "http://api.x.ai.example.test/feedback"
        ));
        assert!(!is_official_endpoint("http://localhost/x.ai/traces"));
    }

    #[test]
    fn trace_upload_posts_a_redacted_counter_only_when_enabled() {
        let capture = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let url = serve("200", capture.clone());
        let mut policy = PrivacyPolicy {
            telemetry: false,
            feedback: false,
            trace_upload: false,
            share_content: true,
            telemetry_url: None,
            feedback_url: None,
            trace_url: Some(url),
            share_session: true,
            telemetry_locked: false,
            feedback_locked: false,
            trace_locked: false,
            content_locked: false,
        };
        assert_eq!(
            emit_trace(&policy, Some("session-1"), "trace_op", 1).unwrap(),
            None
        );
        assert!(capture.lock().unwrap().is_empty());
        policy.trace_upload = true;
        let body = emit_trace(&policy, Some("session-1"), "trace_op", 2)
            .unwrap()
            .unwrap();
        assert!(body.contains("session-1"));
        assert!(body.contains("\"count\":2"));
        assert!(!body.contains("prompt"));
        policy.share_session = false;
        let quiet = emit_trace(&policy, Some("session-1"), "trace_op", 1)
            .unwrap()
            .unwrap();
        assert!(!quiet.contains("session-1"));
        policy.trace_url = Some("https://api.x.ai/v1/traces".into());
        assert!(matches!(
            emit_trace(&policy, None, "trace_op", 1),
            Err(PrivacyError::NoDestination)
        ));
    }

    #[test]
    fn diagnostics_omit_prompts_and_refuse_unconfigured_official_hosts() {
        let event = DiagnosticEvent {
            schema_version: 1,
            kind: "feedback_draft_op",
            ok: true,
            count: 1,
        };
        let preview = diagnostic_preview(&event);
        assert!(preview.contains("Excluded: prompts"));
        assert!(preview.contains("not model traffic"));
        let off = PrivacyPolicy {
            telemetry: false,
            feedback: false,
            trace_upload: false,
            share_content: false,
            telemetry_url: Some("https://telemetry.x.ai/v1".into()),
            feedback_url: None,
            trace_url: None,
            share_session: false,
            telemetry_locked: false,
            feedback_locked: false,
            trace_locked: false,
            content_locked: false,
        };
        assert_eq!(emit_diagnostic(&off, &event).unwrap(), None);
        let mut on = off.clone();
        on.telemetry = true;
        assert!(matches!(
            emit_diagnostic(&on, &event),
            Err(PrivacyError::NoDestination)
        ));
        let capture = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let url = serve("200", capture.clone());
        on.telemetry_url = Some(url);
        let body = emit_diagnostic(&on, &event).unwrap().unwrap();
        assert!(!body.contains("prompt"));
        assert!(body.contains("feedback_draft_op"));
        let wire = String::from_utf8(capture.lock().unwrap().clone()).unwrap();
        assert!(!wire.to_ascii_lowercase().contains("sk-secret"));
        assert!(is_official_endpoint("https://api.x.ai/v1"));
        assert!(!is_official_endpoint("http://127.0.0.1:9/v1"));
    }
}
