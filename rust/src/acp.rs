use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

pub const PROTOCOL_VERSION: u64 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcpEvent {
    Thought {
        session_id: String,
        message_id: String,
        text: String,
    },
    Answer {
        session_id: String,
        message_id: String,
        text: String,
        /// Plugin hook output, not a model answer. Headless stdout omits it.
        hook: bool,
    },
    PromptFinished {
        request_id: u64,
        stop_reason: String,
        /// The prompt response object, including `_meta` when dsh sent it.
        result: Value,
    },
    RpcError {
        request_id: Option<u64>,
        code: i64,
        message: String,
    },
    ProtocolMismatch {
        version: u64,
    },
    Disconnected {
        detail: String,
    },
    ToolCall {
        session_id: String,
        tool_call_id: String,
        title: String,
        kind: String,
        status: String,
        raw_input: Value,
        /// ACP `content` array as sent. Empty when dsh omitted it.
        content: Value,
        /// ACP `locations` array as sent. Empty when dsh omitted it.
        locations: Value,
        diff: String,
    },
    ToolCallUpdate {
        session_id: String,
        tool_call_id: String,
        /// Empty when the update omitted `status`. Not rewritten to pending.
        status: String,
        content: String,
        /// ACP `content` array as sent. Empty when dsh omitted it.
        content_items: Value,
        /// ACP `rawOutput` as sent. Null when dsh omitted it.
        raw_output: Value,
        /// ACP `locations` array as sent. Empty when dsh omitted it.
        locations: Value,
    },
    PermissionRequest {
        request_id: Value,
        session_id: String,
        tool_call_id: String,
        options: Vec<PermissionChoice>,
    },
    PermissionCancelled {
        session_id: String,
    },
    /// A dsh stderr line. Hook failures are labeled; other lines stay raw.
    Stderr {
        text: String,
    },
    /// A typed-subagent lifecycle line from rust-acp-subagents (ticket 172).
    Subagent {
        event: Value,
    },
    /// A background-command lifecycle line from rust-acp-background (ticket 175).
    Job {
        event: Value,
    },
    /// A scheduled-prompt lifecycle line from rust-acp-scheduler (ticket 177).
    Schedule {
        event: Value,
    },
    /// A goal state, round, or notice line from rust-acp-goal (ticket 180).
    Goal {
        event: Value,
    },
    Usage {
        used: Option<u64>,
        size: Option<u64>,
        cost: Option<String>,
    },
    ConfigOptions {
        options: Vec<SessionConfigOption>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionChoice {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigChoice {
    pub value: String,
    pub name: String,
    pub group: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionConfigOption {
    pub id: String,
    pub name: String,
    pub current: Option<String>,
    pub choices: Vec<ConfigChoice>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPermission {
    pub request_id: Value,
    pub session_id: String,
    pub tool_call_id: String,
    pub options: Vec<PermissionChoice>,
}

#[derive(Debug)]
pub struct AcpError {
    pub message: String,
}

impl std::fmt::Display for AcpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AcpError {}

pub fn resolve_fork_model_value(advertised: &[String], wanted: &str) -> Option<String> {
    advertised
        .iter()
        .find(|value| {
            *value == wanted
                || value.contains(&format!("\"{wanted}\""))
                || value.ends_with(&format!("/{wanted}"))
        })
        .cloned()
}

fn json_id_key(id: &Value) -> String {
    id.to_string()
}

pub fn parse_config_options(value: &Value) -> Vec<SessionConfigOption> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|option| {
            let id = option.get("id")?.as_str()?.to_string();
            let name = option
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_string();
            let current = option
                .get("currentValue")
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|value| !value.is_empty());
            Some(SessionConfigOption {
                id,
                name,
                current,
                choices: flatten_config_choices(option.get("options").unwrap_or(&Value::Null)),
            })
        })
        .collect()
}

fn flatten_config_choices(value: &Value) -> Vec<ConfigChoice> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    let mut choices = Vec::new();
    for item in items {
        if let Some(nested) = item.get("options").and_then(Value::as_array) {
            let group = item
                .get("group")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .map(str::to_string);
            for nested in nested {
                if let Some(choice) = config_choice(nested, group.clone()) {
                    choices.push(choice);
                }
            }
        } else if let Some(choice) = config_choice(item, None) {
            choices.push(choice);
        }
    }
    choices
}

fn config_choice(value: &Value, group: Option<String>) -> Option<ConfigChoice> {
    Some(ConfigChoice {
        value: value.get("value")?.as_str()?.to_string(),
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        group,
    })
}

fn permission_choices(value: &Value) -> Vec<PermissionChoice> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|option| {
            Some(PermissionChoice {
                option_id: option.get("optionId")?.as_str()?.to_string(),
                name: option
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                kind: option
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

fn tool_update_text(update: &Value) -> String {
    let mut out = String::new();
    let Some(items) = update.get("content").and_then(Value::as_array) else {
        return out;
    };
    for item in items {
        if item.get("type").and_then(Value::as_str) == Some("diff") {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&proposed_diff(
                "edit",
                &json!({
                    "file_path": item.get("path").and_then(Value::as_str).unwrap_or(""),
                    "old_string": item.get("oldText").and_then(Value::as_str).unwrap_or(""),
                    "new_string": item.get("newText").and_then(Value::as_str).unwrap_or(""),
                }),
            ));
            continue;
        }
        if let Some(text) = item.pointer("/content/text").and_then(Value::as_str) {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(text);
        } else if let Some(text) = item.get("text").and_then(Value::as_str) {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(text);
        }
    }
    out
}

pub fn proposed_diff(title: &str, raw_input: &Value) -> String {
    let path = raw_input
        .get("file_path")
        .and_then(Value::as_str)
        .unwrap_or("");
    match title {
        "write" => {
            let content = raw_input
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("");
            let mut lines = vec![
                format!("write {path}"),
                "--- /dev/null".into(),
                format!("+++ b/{path}"),
            ];
            for line in content.split_inclusive('\n') {
                let body = line.trim_end_matches(['\n', '\r']);
                lines.push(format!("+{body}"));
            }
            if content.is_empty() {
                lines.push("+".into());
            }
            lines.join("\n")
        }
        "edit" => {
            let old = raw_input
                .get("old_string")
                .and_then(Value::as_str)
                .unwrap_or("");
            let new = raw_input
                .get("new_string")
                .and_then(Value::as_str)
                .unwrap_or("");
            let mut lines = vec![
                format!("edit {path}"),
                format!("--- a/{path}"),
                format!("+++ b/{path}"),
            ];
            for line in old.split_inclusive('\n') {
                lines.push(format!("-{}", line.trim_end_matches(['\n', '\r'])));
            }
            for line in new.split_inclusive('\n') {
                lines.push(format!("+{}", line.trim_end_matches(['\n', '\r'])));
            }
            lines.join("\n")
        }
        "read" => format!("read {path}"),
        _ if !path.is_empty() => format!("{title} {path}"),
        _ => title.to_string(),
    }
}

pub struct AcpClient {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<Line>,
    next_id: u64,
    pending: HashMap<u64, PendingKind>,
    completed: HashMap<u64, Result<Value, AcpError>>,
    pub session_id: Option<String>,
    disconnected: Option<String>,
    pub pending_permission: Option<PendingPermission>,
    answered_permissions: HashSet<String>,
    prompt_cancelled: bool,
    pub can_list: bool,
    pub can_resume: bool,
    pub config_options: Vec<SessionConfigOption>,
    /// Target accepted locally, not yet sent. A refusal never closes the live id.
    prepared_resume: Option<String>,
    /// Steer / side-question channel to the dsh plugin. None where Unix
    /// sockets are unavailable; `control_unavailable` says why.
    control: Option<crate::control::ControlChannel>,
    control_unavailable: Option<String>,
    /// MCP plan file (`CODSH_MCP_PLAN`) read on every session/new and
    /// session/resume, so a rewritten plan applies to the next session.
    mcp_plan: Option<PathBuf>,
    /// Servers dsh could not start for the current session, with the reason.
    pub mcp_failed: std::collections::BTreeMap<String, String>,
    /// Extra ACP `mcpServers` an editor passed on session/new or resume.
    pub editor_mcp: Vec<Value>,
    last_error_details: Option<String>,
    /// Background commands are running: shutdown lets dsh stop them before
    /// its process group is killed (dsh starts each command in its own group).
    linger: bool,
    /// Goal lines that arrived while a request was awaited (a resumed
    /// session publishes its goal during session/resume); the next pump
    /// hands them on.
    held: Vec<AcpEvent>,
    /// Remote transport (ticket 190). See [`SpawnSpec::remote`].
    pub remote: bool,
    /// Last stderr line of a remote transport, for the disconnect reason.
    remote_stderr: Option<std::sync::Arc<std::sync::Mutex<String>>>,
    /// `session/update` notifications collected during `session/load`.
    replay_capture: Option<Vec<Value>>,
    /// The organization identity this remote asked for (ticket 207).
    pub identity: Option<RemoteIdentityLink>,
    identity_renew_at: Option<Instant>,
    /// A renewal in flight: request id, the link it establishes, and what
    /// was sent (for the audit line; the token is only fingerprinted).
    identity_pending: Option<(u64, RemoteIdentityLink, crate::remote_identity::Credential)>,
}

/// What this client sent to a remote that requires an organization identity
/// (ticket 207). The token itself is not kept: every request reads the
/// current identity session from auth.json again, so a refresh, a logout,
/// or a revoked refresh token applies to the next request.
#[derive(Clone, Debug)]
pub struct RemoteIdentityLink {
    pub label: String,
    pub offer: crate::remote_identity::Offer,
    pub fingerprint: String,
    pub subject: Option<String>,
    pub team: Option<String>,
    pub expires_at: Option<u64>,
}

/// What `session/load` against a remote hub returned (ticket 190).
pub struct RemoteLoad {
    /// Saved turns, then the running turn so far, as `session/update` params.
    pub updates: Vec<Value>,
    /// The hub attached to a session it still runs (no second executor).
    pub attached: bool,
    /// A turn is still running there; its result arrives as
    /// `_codsh/prompt_complete`.
    pub running: bool,
}

enum Line {
    Text(String),
    Stderr(String),
    Eof,
}

enum PendingKind {
    Initialize,
    SessionNew,
    SessionResume,
    SessionList,
    Prompt,
    SetConfig,
    Close,
    /// A renewed organization identity (ticket 207).
    Identity,
    Other,
}

pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    pub stderr_log: Option<PathBuf>,
    /// The child is a transport to a remote codsh hub (ticket 190), not a
    /// local dsh: no local control socket, no local path canonicalization,
    /// and its stderr (ssh, remote notes) stays out of the transcript.
    pub remote: bool,
}

const IDENTITY_CHILD_KEYS: &[&str] = &[
    "GROK_AUTH_PATH",
    "GROK_AUTH_ACCESS_TOKEN",
    "GROK_AUTH_PROVIDER_COMMAND",
];

/// Parent env keys the dsh child may inherit. The plain mask and step bound
/// (CODSH_PLAIN_TOOLS, CODSH_PLAIN_MAX_TURNS) are not here: only a plain turn
/// passes them, so a parent's value never reaches an interactive session.
pub const INHERITED_ENV: &[&str] = &[
    "HOME",
    "USERPROFILE",
    "DSH_HOME",
    "PATH",
    "TERM",
    "TERM_PROGRAM",
    "COLORTERM",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "NO_COLOR",
    "SystemRoot",
    "WINDIR",
    "DSH_CODE_CLI_MOCK_TOOL",
    "DSH_CODE_CLI_MOCK_IMAGE",
    "DSH_CODE_CLI_MOCK_DELAY_MS",
    "DSH_CODE_CLI_TOOL_DELAY_MS",
    "FAKE_ACP_MODE",
    "FAKE_ACP_VERSION",
    "FAKE_ACP_DELAY_MS",
    "FAKE_ACP_TARGET",
    "FAKE_ACP_WRITES",
    "FAKE_ACP_STORE",
    "FAKE_ACP_OWNED",
    "FAKE_ACP_STALE_OWNER",
    "FAKE_ACP_REFUSE_WHILE_LIVE",
    "FAKE_ACP_HELD_SESSION",
    "FAKE_ACP_TRACE",
    "CODSH_SESSION_READ",
    "CODSH_SESSION_FORK",
    // Command hooks (plugin hooks such as the Ship extension's) run their
    // scripts with the launcher's Node as `${CODSH_NODE:-node}`.
    "CODSH_NODE",
    "GROK_AUTO_COMPACT_THRESHOLD_PERCENT",
    "GROK_COMPACTION_WALL_CLOCK_SECS",
    "DSH_CODE_CLI_MOCK_CONTEXT_WINDOW",
    "CODSH_TEST_COMPACT_THRESHOLD",
    "CODSH_TEST_PRUNE_DISABLED",
    "CODSH_TEST_PRUNE_HEAD",
    "CODSH_TEST_PRUNE_TAIL",
    "CODSH_TEST_PRUNE_THRESHOLD",
    "CODSH_PERMISSION_POLICY",
    "CODSH_HOOK_DENY",
    "CODSH_WORKSPACE_TRUSTED",
    "CODSH_PERMISSION_REMEMBER",
    "CODSH_REVIEW_TRACE",
    "CODSH_WEB_SEARCH",
    "CODSH_WEB_FETCH",
    "CODSH_WEB_SEARCH_KEY_ENV",
    "CODSH_RUST_BIN",
    "CODSH_SHELL_MARKER",
    "CODSH_SHELL_WORKDIR",
    "CODSH_SHELL_SLEEP",
    "CODSH_TEST_SCHEDULER_TIME_SCALE",
    "CODSH_TEST_MONITOR_TIME_SCALE",
    "CODSH_MOCK_MONITOR_TRACE",
    "CODSH_TEST_SCHEDULER_EPOCH",
    "CODSH_TEST_SCHEDULER_OFFSET_MS",
    "GROK_HOME",
];

/// A marked subagent lifecycle line becomes its own event; any other stderr
/// line stays raw.
fn stderr_event(text: String) -> AcpEvent {
    if let Some(event) = crate::subagents::parse_line(&text) {
        return AcpEvent::Subagent { event };
    }
    if let Some(event) = crate::scheduler::parse_line(&text) {
        return AcpEvent::Schedule { event };
    }
    if let Some(event) = crate::goal::parse_line(&text) {
        return AcpEvent::Goal { event };
    }
    match crate::background::parse_line(&text) {
        Some(event) => AcpEvent::Job { event },
        None => AcpEvent::Stderr { text },
    }
}

pub fn dsh_spawn_spec(
    cwd: PathBuf,
    dsh_home: &Path,
    extra_env: &[(String, String)],
    patch: Option<PathBuf>,
) -> Result<SpawnSpec, AcpError> {
    let dsh = std::env::var_os("DSH_BIN").ok_or_else(|| AcpError {
        message: "missing DSH_BIN; use codsh --rust".into(),
    })?;
    let dsh = PathBuf::from(dsh);
    let js = dsh
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext == "js" || ext == "mjs" || ext == "cjs");
    let (program, mut args) = if js {
        let node = std::env::var_os("CODSH_NODE").unwrap_or_else(|| "node".into());
        (
            PathBuf::from(node),
            vec![
                dsh.to_string_lossy().into_owned(),
                "--profile".into(),
                "acp".into(),
            ],
        )
    } else {
        (dsh, vec!["--profile".into(), "acp".into()])
    };
    let patch = patch.or_else(|| std::env::var_os("CODSH_ACP_PATCH").map(PathBuf::from));
    if let Some(patch) = patch {
        args.push("--patch".into());
        args.push(patch.to_string_lossy().into_owned());
    }
    let mut env = Vec::new();
    for key in INHERITED_ENV {
        if let Some(value) = std::env::var_os(key) {
            env.push((key.to_string(), value.to_string_lossy().into_owned()));
        }
    }
    // An active policy is applied to this allowlist, not instead of it.
    // dsh builds its bash child from this process environment and only adds
    // keys, so an excluded name must already be absent here and a `set`
    // value must already be present. No policy leaves the allowlist as-is.
    if let Some(filtered) = crate::filesystem_sandbox::shell_env() {
        let kept: Vec<(String, String)> = filtered
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        env.retain(|(key, value)| kept.iter().any(|(name, kept)| name == key && kept == value));
        for (key, value) in kept {
            if !env.iter().any(|(existing, _)| existing == &key) {
                env.push((key, value));
            }
        }
    }
    env.push(("DSH_TELEMETRY_DISABLED".into(), "1".into()));
    env.push(("DSH_TELEMETRY_MODE".into(), "OFF".into()));
    env.push(("CODSH_UPDATE_CHECK".into(), "off".into()));
    env.push(("DEEPSEEK_API_KEY".into(), String::new()));
    // The dsh `workflow` tool runs Rhai scripts in this executable
    // (`__workflow-engine`, ticket 181).
    if let Ok(exe) = std::env::current_exe() {
        env.push((
            "CODSH_WORKFLOW_ENGINE".into(),
            exe.to_string_lossy().into_owned(),
        ));
    }
    for (key, value) in extra_env {
        env.retain(|(existing, _)| existing != key);
        // Only the identity session the agent core uses. Parent GROK_AUTH_*
        // noise and undocumented extra keys stay out of the dsh process.
        if key.starts_with("GROK_AUTH_") && !IDENTITY_CHILD_KEYS.contains(&key.as_str()) {
            continue;
        }
        env.push((key.clone(), value.clone()));
    }
    // The search substitute's credential, named by config. Other parent keys stay out.
    if let Some(name) = env
        .iter()
        .find(|(key, _)| key == "CODSH_WEB_SEARCH_KEY_ENV")
        .map(|(_, value)| value.clone())
        && !name.is_empty()
        && !env.iter().any(|(key, _)| key == &name)
        && let Some(value) = std::env::var_os(&name)
    {
        env.push((name, value.to_string_lossy().into_owned()));
    }
    Ok(SpawnSpec {
        program,
        args,
        env,
        cwd,
        stderr_log: Some(dsh_home.join("acp-stderr.log")),
        remote: false,
    })
}

impl AcpClient {
    pub fn spawn(spec: SpawnSpec) -> io::Result<Self> {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear();
        for (key, value) in &spec.env {
            command.env(key, value);
        }
        // Own process group, so shutdown can signal grandchildren (a bash
        // child of dsh) and not only the dsh pid. The group id is the pid.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        // The path and token are added after the allowlist on purpose: they
        // are for the control plugin, which removes them from its own
        // environment before any tool child is built.
        let (control, control_unavailable) = if spec.remote {
            (
                None,
                Some(
                    "not available in a remote session: steer and /btw need the local dsh control plugin"
                        .to_string(),
                ),
            )
        } else {
            match crate::control::ControlChannel::listen() {
                Ok((channel, env)) => {
                    for (key, value) in env {
                        command.env(key, value);
                    }
                    (Some(channel), None)
                }
                Err(error) => (None, Some(error.to_string())),
            }
        };
        let mcp_plan = spec
            .env
            .iter()
            .find(|(key, _)| key == crate::mcp::PLAN_ENV)
            .map(|(_, value)| PathBuf::from(value));
        let mut child = command.spawn()?;
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("missing ACP stdout"))?;
        let stderr = child.stderr.take();
        let (tx, rx) = mpsc::channel();
        let remote_stderr = spec
            .remote
            .then(|| std::sync::Arc::new(std::sync::Mutex::new(String::new())));
        if let Some(stderr) = stderr {
            let log_path = spec.stderr_log.clone();
            let stderr_tx = tx.clone();
            let last = remote_stderr.clone();
            thread::spawn(move || {
                let mut file = log_path.and_then(|path| std::fs::File::create(path).ok());
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    let Ok(text) = line else { break };
                    if let Some(file) = file.as_mut() {
                        let _ = writeln!(file, "{text}");
                    }
                    match &last {
                        // ssh and remote notes are diagnostics, not answer text.
                        Some(last) => {
                            if !text.trim().is_empty()
                                && let Ok(mut slot) = last.lock()
                            {
                                *slot = text;
                            }
                        }
                        None => {
                            let _ = stderr_tx.send(Line::Stderr(text));
                        }
                    }
                }
            });
        }
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        if tx.send(Line::Text(text)).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = tx.send(Line::Eof);
        });
        Ok(Self {
            child,
            stdin,
            rx,
            next_id: 1,
            pending: HashMap::new(),
            completed: HashMap::new(),
            session_id: None,
            disconnected: None,
            pending_permission: None,
            answered_permissions: HashSet::new(),
            prompt_cancelled: false,
            held: Vec::new(),
            can_list: false,
            can_resume: false,
            config_options: Vec::new(),
            prepared_resume: None,
            control,
            control_unavailable,
            mcp_plan,
            mcp_failed: std::collections::BTreeMap::new(),
            editor_mcp: Vec::new(),
            last_error_details: None,
            linger: false,
            remote: spec.remote,
            remote_stderr,
            replay_capture: None,
            identity: None,
            identity_renew_at: None,
            identity_pending: None,
        })
    }

    /// Control events since the last poll (steer outcomes, side answers).
    pub fn poll_control(&mut self) -> Vec<crate::control::ControlEvent> {
        self.control
            .as_mut()
            .map(|channel| channel.poll())
            .unwrap_or_default()
    }

    pub fn control_ready(&self) -> bool {
        self.control
            .as_ref()
            .is_some_and(crate::control::ControlChannel::is_ready)
    }

    /// Why steer and /btw cannot reach dsh right now.
    pub fn control_unavailable(&self) -> String {
        if let Some(reason) = &self.control_unavailable {
            return reason.clone();
        }
        match &self.control {
            Some(channel) => channel
                .closed_reason()
                .map(str::to_string)
                .unwrap_or_else(|| "dsh control channel is not connected yet".into()),
            None => "dsh control channel is unavailable".into(),
        }
    }

    fn control_send(&self, message: &Value) -> Result<(), String> {
        match &self.control {
            Some(channel) => channel.send(message),
            None => Err(self.control_unavailable()),
        }
    }

    /// Hand a follow-up to the running agent for its next step boundary.
    pub fn send_steer(&self, id: &str, text: &str) -> Result<(), String> {
        let session = self
            .session_id
            .as_deref()
            .ok_or_else(|| "ACP session is not ready".to_string())?;
        self.control_send(&crate::control::steer_message(id, session, text))
    }

    /// Ask a side question. dsh answers from a copy of the history.
    pub fn send_btw(&self, id: &str, question: &str) -> Result<(), String> {
        let session = self
            .session_id
            .as_deref()
            .ok_or_else(|| "ACP session is not ready".to_string())?;
        self.control_send(&crate::control::btw_message(id, session, question))
    }

    pub fn cancel_btw(&self, id: &str) {
        let _ = self.control_send(&crate::control::btw_cancel_message(id));
    }

    /// Send one ticket-179 control message (answers, dismissals, plan quit).
    pub fn send_control(&self, message: &Value) -> Result<(), String> {
        self.control_send(message)
    }

    /// Hand one `/goal` command to dsh's goal plugin (ticket 180).
    pub fn send_goal(&self, id: &str, command: &crate::goal::Command) -> Result<(), String> {
        let session = self
            .session_id
            .as_deref()
            .ok_or_else(|| "ACP session is not ready".to_string())?;
        self.control_send(&crate::goal::message(id, session, command))
    }

    /// Ask dsh to enter or leave plan mode for this session.
    pub fn send_plan_set(&self, id: &str, active: bool) -> Result<(), String> {
        let session = self
            .session_id
            .as_deref()
            .ok_or_else(|| "ACP session is not ready".to_string())?;
        self.control_send(&crate::control::plan_set_message(id, session, active))
    }

    pub fn mcp_plan_path(&self) -> Option<&Path> {
        self.mcp_plan.as_deref()
    }

    /// Send session/new or session/resume with the MCP plan. A server dsh
    /// reports as `mcp-client(<name>)` during startup is recorded with its
    /// reason and the request is retried without it, so one broken server
    /// does not stop the session.
    fn session_request(
        &mut self,
        method: &str,
        mut params: Value,
        kind: fn() -> PendingKind,
        timeout: Duration,
    ) -> Result<Value, AcpError> {
        self.mcp_failed.clear();
        let plan = self
            .mcp_plan
            .as_deref()
            .and_then(crate::mcp::read_plan)
            .unwrap_or(Value::Null);
        let run_dir = plan
            .get("runDir")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_default();
        let budget = plan
            .get("startupBudgetMs")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        loop {
            let mut servers = crate::mcp::plan_servers(&plan, &self.mcp_failed);
            for extra in &self.editor_mcp {
                let name = extra.get("name").and_then(Value::as_str).unwrap_or("");
                let taken = servers
                    .iter()
                    .any(|server| server.get("name").and_then(Value::as_str) == Some(name));
                if !taken && !self.mcp_failed.contains_key(name) {
                    servers.push(extra.clone());
                }
            }
            let names: Vec<String> = servers
                .iter()
                .filter_map(|server| server.get("name").and_then(Value::as_str))
                .map(str::to_string)
                .collect();
            params["mcpServers"] = Value::Array(servers);
            self.last_error_details = None;
            let id = self.request(method, params.clone(), kind())?;
            match self.wait_result(id, timeout + Duration::from_millis(budget)) {
                Ok(result) => return Ok(result),
                Err(error) => {
                    let details = self.last_error_details.take().unwrap_or_default();
                    let failed = crate::mcp::failed_server(&details)
                        .or_else(|| crate::mcp::failed_server(&error.message));
                    match failed {
                        Some(name)
                            if names.contains(&name) && !self.mcp_failed.contains_key(&name) =>
                        {
                            let fallback = if details.is_empty() {
                                error.message.clone()
                            } else {
                                details.clone()
                            };
                            let reason = crate::mcp::failure_reason(&run_dir, &name, &fallback);
                            self.mcp_failed.insert(name, reason);
                        }
                        _ => return Err(error),
                    }
                }
            }
        }
    }

    /// Move this session's running foreground command to the background.
    /// `reason` is `user` (Ctrl+B) or `message` (a send-now).
    pub fn send_background(&self, id: &str, reason: &str) -> Result<(), String> {
        let session = self
            .session_id
            .as_deref()
            .ok_or_else(|| "ACP session is not ready".to_string())?;
        self.control_send(&crate::control::background_message(id, session, reason))
    }

    /// Stop one background command of this session (the tasks pane).
    pub fn send_job_kill(&self, id: &str, job_id: &str) -> Result<(), String> {
        let session = self
            .session_id
            .as_deref()
            .ok_or_else(|| "ACP session is not ready".to_string())?;
        self.control_send(&crate::control::job_kill_message(id, session, job_id))
    }

    /// Hand this session's owner lock token to dsh (saved loops, ticket 178).
    pub fn send_schedule_owner(&self, id: &str, token: &str) -> Result<(), String> {
        let session = self
            .session_id
            .as_deref()
            .ok_or_else(|| "ACP session is not ready".to_string())?;
        self.control_send(&crate::control::schedule_owner_message(id, session, token))
    }

    /// Delete one scheduled prompt of this session (the tasks pane).
    pub fn send_schedule_delete(&self, id: &str, task_id: &str) -> Result<(), String> {
        let session = self
            .session_id
            .as_deref()
            .ok_or_else(|| "ACP session is not ready".to_string())?;
        self.control_send(&crate::control::schedule_delete_message(
            id, session, task_id,
        ))
    }

    /// `/workflow ...`: ask this session's workflow run manager (overview,
    /// pause, resume, stop). The reply arrives as `WorkflowResult`.
    pub fn send_workflow(&self, id: &str, text: &str) -> Result<(), String> {
        let session = self
            .session_id
            .as_deref()
            .ok_or_else(|| "ACP session is not ready".to_string())?;
        self.control_send(&crate::control::workflow_message(id, session, text))
    }

    pub fn send_workflow_launch(&self, id: &str, name: &str, args: &str) -> Result<(), String> {
        let session = self
            .session_id
            .as_deref()
            .ok_or_else(|| "ACP session is not ready".to_string())?;
        self.control_send(&crate::control::workflow_launch_message(
            id, session, name, args,
        ))
    }

    /// The session directory as sent. A remote path is the remote host's
    /// path: it is never resolved against this machine's filesystem.
    fn wire_cwd(&self, cwd: &Path) -> String {
        if self.remote {
            return cwd.to_string_lossy().into_owned();
        }
        cwd.canonicalize()
            .unwrap_or_else(|_| cwd.to_path_buf())
            .to_string_lossy()
            .into_owned()
    }

    fn eof_detail(&self) -> String {
        let Some(last) = &self.remote_stderr else {
            return "ACP connection ended".into();
        };
        // ssh writes its reason to stderr as it exits; that reader may trail
        // the stdout end-of-stream by a moment.
        let mut text = String::new();
        for _ in 0..30 {
            text = last.lock().map(|text| text.clone()).unwrap_or_default();
            if !text.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let last = text;
        if last.is_empty() {
            "remote connection ended".into()
        } else {
            format!("remote connection ended: {last}")
        }
    }

    /// `session/load` against a remote codsh hub (ticket 190). The hub sends
    /// saved turns, the running turn so far, and then the answer; a session
    /// it still runs is attached without a second executor, so nothing is
    /// executed again. A pending permission request follows the answer and
    /// reaches the next [`pump`](Self::pump).
    pub fn load_session(
        &mut self,
        session_id: &str,
        cwd: &Path,
        timeout: Duration,
    ) -> Result<RemoteLoad, AcpError> {
        let cwd = self.wire_cwd(cwd);
        self.replay_capture = Some(Vec::new());
        let id = self.request(
            "session/load",
            json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": [] }),
            PendingKind::SessionResume,
        );
        let result = id.and_then(|id| self.wait_result(id, timeout));
        let updates = self.replay_capture.take().unwrap_or_default();
        let result = result?;
        self.session_id = Some(session_id.to_string());
        self.prepared_resume = None;
        self.config_options =
            parse_config_options(result.get("configOptions").unwrap_or(&Value::Null));
        Ok(RemoteLoad {
            updates,
            attached: result
                .pointer("/_meta/codsh~1attached")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            running: result
                .pointer("/_meta/codsh~1turn/running")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    /// Events for one replayed `session/update` (ticket 190).
    pub fn replay_events(&mut self, params: Value) -> Vec<AcpEvent> {
        self.handle_notification("session/update", params)
    }

    /// Send this client's organization identity when the remote's
    /// `initialize` asks for one (ticket 207). Nothing is sent to a remote
    /// that is not listed in `[[remote_identity]]` with the audience it asks
    /// for, and a remote that asks for nothing gets nothing.
    pub fn authenticate_remote(
        &mut self,
        label: &str,
        init: &Value,
        timeout: Duration,
    ) -> Result<Option<RemoteIdentityLink>, AcpError> {
        self.identity = None;
        let Some(offer) = crate::remote_identity::offer(init) else {
            return Ok(None);
        };
        let credential = Self::identity_credential(label, &offer)?;
        self.send_identity(label, offer, credential, timeout)
            .map(Some)
    }

    fn identity_credential(
        label: &str,
        offer: &crate::remote_identity::Offer,
    ) -> Result<crate::remote_identity::Credential, AcpError> {
        let grok_home = crate::worktree::early_grok_home();
        let env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
        crate::remote_identity::credential_for(&grok_home, &env, label, offer).map_err(|message| {
            crate::remote_identity::client_audit(&grok_home, label, None, Err(&message));
            AcpError { message }
        })
    }

    fn send_identity(
        &mut self,
        label: &str,
        offer: crate::remote_identity::Offer,
        credential: crate::remote_identity::Credential,
        timeout: Duration,
    ) -> Result<RemoteIdentityLink, AcpError> {
        let grok_home = crate::worktree::early_grok_home();
        let id = self.request(
            "authenticate",
            crate::remote_identity::authenticate_params(&credential),
            PendingKind::Other,
        )?;
        match self.wait_result(id, timeout) {
            Ok(result) => {
                crate::remote_identity::client_audit(
                    &grok_home,
                    label,
                    Some(&credential),
                    Ok(&result),
                );
                let accepted = result
                    .pointer("/_meta")
                    .and_then(|meta| meta.get(crate::remote_identity::META_KEY))
                    .cloned()
                    .unwrap_or(Value::Null);
                let text = |key: &str| {
                    accepted
                        .get(key)
                        .and_then(Value::as_str)
                        .map(str::to_string)
                };
                let link = RemoteIdentityLink {
                    label: label.to_string(),
                    offer,
                    fingerprint: crate::remote_identity::fingerprint(&credential.token),
                    subject: text("subject"),
                    team: text("team"),
                    expires_at: accepted
                        .get("expiresAt")
                        .and_then(Value::as_u64)
                        .or(credential.expires_at),
                };
                self.identity = Some(link.clone());
                Ok(link)
            }
            Err(error) => {
                crate::remote_identity::client_audit(
                    &grok_home,
                    label,
                    Some(&credential),
                    Err(&error.message),
                );
                self.identity = None;
                Err(AcpError {
                    message: format!(
                        "{label} refused this organization identity: {}",
                        error.message
                    ),
                })
            }
        }
    }

    /// Before a remote request, and while idle near expiry: read the
    /// identity session again and send it when it changed (a refresh). The
    /// remote handles lines in order, so the new token is checked before the
    /// request that follows it; nothing waits here, and a running turn's
    /// updates keep flowing. A session that is gone or cannot be refreshed
    /// stops the request here, before anything is sent.
    fn renew_identity(&mut self) -> Result<(), AcpError> {
        let Some(link) = self.identity.clone() else {
            return Ok(());
        };
        let credential = Self::identity_credential(&link.label, &link.offer)?;
        let fingerprint = crate::remote_identity::fingerprint(&credential.token);
        if fingerprint == link.fingerprint
            || self
                .identity_pending
                .as_ref()
                .is_some_and(|(_, pending, _)| pending.fingerprint == fingerprint)
        {
            return Ok(());
        }
        let id = self.request(
            "authenticate",
            crate::remote_identity::authenticate_params(&credential),
            PendingKind::Identity,
        )?;
        let renewed = RemoteIdentityLink {
            fingerprint,
            expires_at: credential.expires_at,
            ..link
        };
        self.identity_pending = Some((id, renewed, credential));
        Ok(())
    }

    /// While idle: renew an identity that is about to expire, so a quiet
    /// connection is not dropped by the remote's periodic check.
    fn renew_identity_when_due(&mut self) -> Vec<AcpEvent> {
        let Some(expires_at) = self.identity.as_ref().and_then(|link| link.expires_at) else {
            return Vec::new();
        };
        if self.disconnected.is_some()
            || crate::auth::now_unix() + 60 < expires_at
            || self
                .identity_renew_at
                .is_some_and(|at| at.elapsed() < Duration::from_secs(15))
        {
            return Vec::new();
        }
        self.identity_renew_at = Some(Instant::now());
        match self.renew_identity() {
            Ok(()) => Vec::new(),
            Err(error) => vec![AcpEvent::RpcError {
                request_id: None,
                code: crate::remote_identity::AUTH_ERROR,
                message: error.message,
            }],
        }
    }

    /// The answer to a renewal sent by [`renew_identity`].
    fn identity_answer(&mut self, id: u64, result: Result<&Value, &str>) {
        let Some((pending_id, link, credential)) = self.identity_pending.take() else {
            return;
        };
        if pending_id != id {
            self.identity_pending = Some((pending_id, link, credential));
            return;
        }
        let grok_home = crate::worktree::early_grok_home();
        crate::remote_identity::client_audit(&grok_home, &link.label, Some(&credential), result);
        if result.is_ok() {
            self.identity = Some(link);
        }
    }

    pub fn initialize(&mut self, timeout: Duration) -> Result<Value, AcpError> {
        let id = self.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": {},
                "clientInfo": { "name": "codsh-rust", "version": env!("CARGO_PKG_VERSION") },
            }),
            PendingKind::Initialize,
        )?;
        let result = self.wait_result(id, timeout)?;
        let version = result
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if version != PROTOCOL_VERSION {
            self.disconnected = Some(format!("ACP protocol mismatch: agent version {version}"));
            return Err(AcpError {
                message: format!(
                    "ACP protocol mismatch: client {PROTOCOL_VERSION}, agent {version}"
                ),
            });
        }
        let capabilities = result
            .pointer("/agentCapabilities/sessionCapabilities")
            .cloned()
            .unwrap_or(Value::Null);
        self.can_list = capabilities.get("list").is_some();
        self.can_resume = capabilities.get("resume").is_some();
        Ok(result)
    }

    pub fn new_session(&mut self, cwd: &Path, timeout: Duration) -> Result<String, AcpError> {
        let cwd = self.wire_cwd(cwd);
        let result = self.session_request(
            "session/new",
            json!({ "cwd": cwd, "mcpServers": [] }),
            || PendingKind::SessionNew,
            timeout,
        )?;
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| AcpError {
                message: "ACP session/new omitted sessionId".into(),
            })?
            .to_string();
        self.session_id = Some(session_id.clone());
        self.config_options =
            parse_config_options(result.get("configOptions").unwrap_or(&Value::Null));
        Ok(session_id)
    }

    pub fn list_sessions(
        &mut self,
        cwd: &Path,
        timeout: Duration,
    ) -> Result<Vec<(String, String)>, AcpError> {
        if !self.can_list {
            return Err(AcpError {
                message: "ACP session/list is not available".into(),
            });
        }
        let cwd = self.wire_cwd(cwd);
        let id = self.request(
            "session/list",
            json!({ "cwd": cwd }),
            PendingKind::SessionList,
        )?;
        let result = self.wait_result(id, timeout)?;
        Ok(result
            .get("sessions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                Some((
                    entry.get("sessionId")?.as_str()?.to_string(),
                    entry
                        .get("cwd")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                ))
            })
            .collect())
    }

    /// Send `session/resume` while the current session is still open. dsh
    /// accepts that and replaces the active id; a refusal (`already active`
    /// / `already owned`) returns before the caller closes anything. The
    /// previous id is kept so [`finish_resume`] can close it only after this
    /// reply succeeds.
    pub fn prepare_resume(
        &mut self,
        session_id: &str,
        cwd: &Path,
        timeout: Duration,
    ) -> Result<(), AcpError> {
        if !self.can_resume {
            return Err(AcpError {
                message: "ACP session/resume is not available".into(),
            });
        }
        if session_id.is_empty() {
            return Err(AcpError {
                message: "session is not resumable".into(),
            });
        }
        if self.session_id.as_deref() == Some(session_id) {
            return Err(AcpError {
                message: format!("session is already active: {session_id}"),
            });
        }
        let previous = self.session_id.clone();
        match self.resume_session(session_id, cwd, timeout) {
            Ok(_) => {
                self.prepared_resume = previous;
                Ok(())
            }
            Err(error) => {
                self.session_id = previous;
                self.prepared_resume = None;
                Err(error)
            }
        }
    }

    /// Close the session that was live before [`prepare_resume`] succeeded.
    /// There is nothing to close when the resume was refused or this
    /// connection had no session.
    pub fn finish_resume(
        &mut self,
        previous_id: &str,
        _cwd: &Path,
        timeout: Duration,
    ) -> Result<(), AcpError> {
        let Some(previous) = self.prepared_resume.clone() else {
            if previous_id.is_empty() {
                return Ok(());
            }
            return Err(AcpError {
                message: "session/resume was not accepted".into(),
            });
        };
        if previous != previous_id {
            return Err(AcpError {
                message: format!("session/resume did not keep {previous_id}"),
            });
        }
        let current = self.session_id.clone();
        self.session_id = Some(previous);
        let closed = self.close_session(timeout);
        self.session_id = current;
        self.prepared_resume = None;
        closed
    }

    pub fn abandon_resume(&mut self) {
        self.prepared_resume = None;
    }

    pub fn resume_session(
        &mut self,
        session_id: &str,
        cwd: &Path,
        timeout: Duration,
    ) -> Result<String, AcpError> {
        if !self.can_resume {
            return Err(AcpError {
                message: "ACP session/resume is not available".into(),
            });
        }
        let cwd = self.wire_cwd(cwd);
        let result = self.session_request(
            "session/resume",
            json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": [] }),
            || PendingKind::SessionResume,
            timeout,
        )?;
        self.session_id = Some(session_id.to_string());
        self.prepared_resume = None;
        self.config_options =
            parse_config_options(result.get("configOptions").unwrap_or(&Value::Null));
        Ok(session_id.to_string())
    }

    pub fn set_config_option(
        &mut self,
        config_id: &str,
        value: &str,
        timeout: Duration,
    ) -> Result<Vec<SessionConfigOption>, AcpError> {
        let session_id = self.session_id.clone().ok_or_else(|| AcpError {
            message: "ACP session is not ready".into(),
        })?;
        let id = self.request(
            "session/set_config_option",
            json!({
                "sessionId": session_id,
                "configId": config_id,
                "value": value,
            }),
            PendingKind::SetConfig,
        )?;
        let result = self.wait_result(id, timeout)?;
        self.config_options =
            parse_config_options(result.get("configOptions").unwrap_or(&Value::Null));
        if self.config_options.is_empty() {
            self.config_options = parse_config_options(&result);
        }
        Ok(self.config_options.clone())
    }

    /// Forward a client reply (permission outcome or error) to dsh unchanged.
    pub fn write_message(&mut self, value: Value) -> Result<(), AcpError> {
        self.write_raw(value)
    }

    /// The editor answered this permission. A later duplicate from this
    /// process is rejected instead of being sent again.
    pub fn note_permission_answered(&mut self, request_id: &Value) {
        self.answered_permissions.insert(json_id_key(request_id));
        if self
            .pending_permission
            .as_ref()
            .is_some_and(|pending| json_id_key(&pending.request_id) == json_id_key(request_id))
        {
            self.pending_permission = None;
        }
    }

    pub fn config_option(&self, id: &str) -> Option<&SessionConfigOption> {
        self.config_options.iter().find(|option| option.id == id)
    }

    pub fn model_values(&self) -> Vec<String> {
        self.config_option("model")
            .into_iter()
            .flat_map(|option| option.choices.iter().map(|choice| choice.value.clone()))
            .collect()
    }

    pub fn answer_permission(
        &mut self,
        request_id: &Value,
        option_id: &str,
    ) -> Result<(), AcpError> {
        if self.prompt_cancelled {
            return Err(AcpError {
                message: "stale permission reply".into(),
            });
        }
        let key = json_id_key(request_id);
        if self.answered_permissions.contains(&key) {
            return Err(AcpError {
                message: "stale or duplicate permission reply".into(),
            });
        }
        let pending = self.pending_permission.as_ref().ok_or_else(|| AcpError {
            message: "no pending permission".into(),
        })?;
        if json_id_key(&pending.request_id) != key {
            return Err(AcpError {
                message: "stale permission reply".into(),
            });
        }
        if !pending
            .options
            .iter()
            .any(|option| option.option_id == option_id)
        {
            return Err(AcpError {
                message: format!("unknown permission option {option_id}"),
            });
        }
        self.write_raw(json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": { "outcome": { "outcome": "selected", "optionId": option_id } },
        }))?;
        self.answered_permissions.insert(key);
        self.pending_permission = None;
        Ok(())
    }

    pub fn cancel_permission(&mut self, request_id: &Value) -> Result<(), AcpError> {
        let key = json_id_key(request_id);
        if self.answered_permissions.contains(&key) {
            return Err(AcpError {
                message: "stale or duplicate permission reply".into(),
            });
        }
        let pending = self.pending_permission.as_ref().ok_or_else(|| AcpError {
            message: "no pending permission".into(),
        })?;
        if json_id_key(&pending.request_id) != key {
            return Err(AcpError {
                message: "stale permission reply".into(),
            });
        }
        self.write_raw(json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": { "outcome": { "outcome": "cancelled" } },
        }))?;
        self.answered_permissions.insert(key);
        self.pending_permission = None;
        Ok(())
    }

    pub fn cancel_prompt(&mut self) -> Result<(), AcpError> {
        let session_id = self.session_id.clone().ok_or_else(|| AcpError {
            message: "ACP session is not ready".into(),
        })?;
        self.prompt_cancelled = true;
        if let Some(pending) = self.pending_permission.clone() {
            let _ = self.cancel_permission(&pending.request_id);
        }
        self.write_raw(json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": session_id },
        }))
    }

    pub fn submit_prompt(&mut self, text: &str) -> Result<u64, AcpError> {
        self.submit_prompt_blocks(&[json!({ "type": "text", "text": text })])
    }

    /// Submit ordered ACP content. File attachments travel as a resource link
    /// plus the admitted text. The caller must not include unread file bytes.
    pub fn submit_prompt_blocks(&mut self, blocks: &[Value]) -> Result<u64, AcpError> {
        let session_id = self.session_id.clone().ok_or_else(|| AcpError {
            message: "ACP session is not ready".into(),
        })?;
        if self
            .pending
            .values()
            .any(|kind| matches!(kind, PendingKind::Prompt))
        {
            return Err(AcpError {
                message: "a prompt is already in flight".into(),
            });
        }
        if blocks.is_empty() {
            return Err(AcpError {
                message: "empty prompt".into(),
            });
        }
        self.prompt_cancelled = false;
        self.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": blocks,
            }),
            PendingKind::Prompt,
        )
    }

    pub fn close_session(&mut self, timeout: Duration) -> Result<(), AcpError> {
        let Some(session_id) = self.session_id.clone() else {
            return Ok(());
        };
        let id = self.request(
            "session/close",
            json!({ "sessionId": session_id }),
            PendingKind::Close,
        )?;
        match self.wait_result(id, timeout) {
            Ok(_) | Err(_) => {
                self.session_id = None;
                Ok(())
            }
        }
    }

    pub fn pump(&mut self, timeout: Duration) -> Vec<AcpEvent> {
        let mut events = std::mem::take(&mut self.held);
        events.extend(self.renew_identity_when_due());
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() && timeout != Duration::ZERO {
                break;
            }
            let wait = if timeout == Duration::ZERO {
                Duration::ZERO
            } else {
                remaining
            };
            match self.rx.recv_timeout(wait) {
                Ok(Line::Text(line)) => events.extend(self.handle_line(&line)),
                Ok(Line::Stderr(text)) => events.push(stderr_event(text)),
                Ok(Line::Eof) => {
                    let detail = self
                        .disconnected
                        .clone()
                        .unwrap_or_else(|| self.eof_detail());
                    self.disconnected = Some(detail.clone());
                    events.push(AcpEvent::Disconnected { detail });
                    break;
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    events.push(AcpEvent::Disconnected {
                        detail: "ACP reader stopped".into(),
                    });
                    break;
                }
            }
            if timeout == Duration::ZERO {
                while let Ok(line) = self.rx.try_recv() {
                    match line {
                        Line::Text(text) => events.extend(self.handle_line(&text)),
                        Line::Stderr(text) => events.push(stderr_event(text)),
                        Line::Eof => {
                            let detail = self
                                .disconnected
                                .clone()
                                .unwrap_or_else(|| self.eof_detail());
                            self.disconnected = Some(detail.clone());
                            events.push(AcpEvent::Disconnected { detail });
                            return events;
                        }
                    }
                }
                break;
            }
        }
        events
    }

    /// Test-only spawn of the deterministic ACP stand-in.
    #[cfg(test)]
    pub(crate) fn spawn_fake_for_test(mode: &str, extra: Vec<(String, String)>) -> Self {
        let cwd = std::env::temp_dir();
        let mut env = vec![
            ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
            ("FAKE_ACP_MODE".into(), mode.into()),
        ];
        env.extend(extra);
        Self::spawn(SpawnSpec {
            program: std::env::var_os("CODSH_NODE")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("node")),
            args: vec![
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../scripts/fake-acp-agent.mjs")
                    .to_string_lossy()
                    .into_owned(),
            ],
            env,
            cwd,
            stderr_log: None,
            remote: false,
        })
        .expect("fake ACP agent")
    }

    /// Process id of the dsh child, for status and diagnostics.
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn set_linger(&mut self, linger: bool) {
        self.linger = linger;
    }

    pub fn shutdown(&mut self) {
        if let Some(pending) = self.pending_permission.clone() {
            let _ = self.cancel_permission(&pending.request_id);
        }
        let close = if self.linger {
            // Closing the session disposes its agent, and dsh stops that
            // agent's jobs before it answers.
            Duration::from_millis(LINGER_MS)
        } else {
            Duration::from_millis(400)
        };
        let _ = self.close_session(close);
        self.stdin.take();
        if self.linger {
            // dsh runs each command in its own process group, which the
            // group kill below does not reach. With stdin closed dsh tears
            // down every remaining job and exits; wait for that, bounded.
            let deadline = Instant::now() + Duration::from_millis(LINGER_MS);
            while Instant::now() < deadline {
                if matches!(self.child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        kill_process_group(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn request(&mut self, method: &str, params: Value, kind: PendingKind) -> Result<u64, AcpError> {
        if let Some(detail) = &self.disconnected {
            return Err(AcpError {
                message: detail.clone(),
            });
        }
        if self.identity.is_some() && !matches!(method, "initialize" | "authenticate") {
            self.renew_identity()?;
        }
        let id = self.next_id;
        self.next_id += 1;
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let stdin = self.stdin.as_mut().ok_or_else(|| AcpError {
            message: "ACP stdin closed".into(),
        })?;
        stdin
            .write_all(format!("{frame}\n").as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|error| AcpError {
                message: format!("ACP write failed: {error}"),
            })?;
        self.pending.insert(id, kind);
        Ok(id)
    }

    fn wait_result(&mut self, id: u64, timeout: Duration) -> Result<Value, AcpError> {
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                return Err(AcpError {
                    message: "ACP request timed out".into(),
                });
            }
            let goal_lines = self
                .pump(Duration::from_millis(50))
                .into_iter()
                .filter(|event| matches!(event, AcpEvent::Goal { .. }));
            self.held.extend(goal_lines);
            if let Some(result) = self.completed.remove(&id) {
                return result;
            }
            // A closed remote transport answers nothing more: every line it
            // sent was handled before its end-of-stream.
            if self.disconnected.is_some() && (self.remote || !self.pending.contains_key(&id)) {
                return Err(AcpError {
                    message: self
                        .disconnected
                        .clone()
                        .unwrap_or_else(|| "ACP connection ended".into()),
                });
            }
        }
    }

    fn handle_line(&mut self, line: &str) -> Vec<AcpEvent> {
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => {
                return vec![AcpEvent::RpcError {
                    request_id: None,
                    code: -32700,
                    message: "ACP parse error".into(),
                }];
            }
        };
        if let Some(method) = value.get("method").and_then(Value::as_str) {
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            if value.get("id").is_some() {
                return self.handle_server_request(value.get("id").cloned(), method, params);
            }
            return self.handle_notification(method, params);
        }
        if let Some(id) = value.get("id").and_then(Value::as_u64) {
            return self.handle_response(id, value);
        }
        Vec::new()
    }

    fn handle_server_request(
        &mut self,
        id: Option<Value>,
        method: &str,
        params: Value,
    ) -> Vec<AcpEvent> {
        if method == "session/request_permission" {
            let Some(request_id) = id else {
                return vec![AcpEvent::RpcError {
                    request_id: None,
                    code: -32600,
                    message: "permission request omitted id".into(),
                }];
            };
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if self.prompt_cancelled {
                let _ = self.write_raw(json!({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": { "outcome": { "outcome": "cancelled" } },
                }));
                self.answered_permissions.insert(json_id_key(&request_id));
                return vec![AcpEvent::PermissionCancelled { session_id }];
            }
            let mut replaced = Vec::new();
            if let Some(previous) = self.pending_permission.take() {
                let _ = self.write_raw(json!({
                    "jsonrpc": "2.0",
                    "id": previous.request_id,
                    "result": { "outcome": { "outcome": "cancelled" } },
                }));
                self.answered_permissions
                    .insert(json_id_key(&previous.request_id));
                replaced.push(AcpEvent::PermissionCancelled {
                    session_id: previous.session_id,
                });
            }
            let tool_call_id = params
                .pointer("/toolCall/toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let options = permission_choices(params.get("options").unwrap_or(&Value::Null));
            let pending = PendingPermission {
                request_id: request_id.clone(),
                session_id: session_id.clone(),
                tool_call_id: tool_call_id.clone(),
                options: options.clone(),
            };
            self.pending_permission = Some(pending);
            replaced.push(AcpEvent::PermissionRequest {
                request_id,
                session_id,
                tool_call_id,
                options,
            });
            return replaced;
        }
        if let Some(id) = id {
            let _ = self.write_raw(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {method}") },
            }));
        }
        vec![AcpEvent::RpcError {
            request_id: None,
            code: -32601,
            message: format!("Unsupported ACP client method: {method}"),
        }]
    }

    /// Hub notifications a remote session relies on (ticket 190). A turn
    /// that was running when this client attached ends with
    /// `_codsh/prompt_complete`, not with a response to a request of ours.
    /// A stopped remote runtime or leader means the running turn has no
    /// result and its external effects are unknown; nothing is retried.
    fn remote_notification(&mut self, method: &str, params: Value) -> Vec<AcpEvent> {
        let session = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let ours = self.session_id.as_deref() == Some(session.as_str());
        match method {
            "_codsh/prompt_complete" if ours => {
                if let Some(message) = params.get("error").and_then(Value::as_str) {
                    return vec![AcpEvent::RpcError {
                        request_id: None,
                        code: -32603,
                        message: message.to_string(),
                    }];
                }
                let stop_reason = params
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                vec![AcpEvent::PromptFinished {
                    request_id: 0,
                    stop_reason,
                    result: params,
                }]
            }
            "_codsh/permission_resolved" if ours => {
                self.pending_permission = None;
                vec![AcpEvent::PermissionCancelled {
                    session_id: session,
                }]
            }
            "_codsh/runtime_exited" if ours => {
                let detail = params.get("detail").and_then(Value::as_str).unwrap_or("");
                let interrupted = params
                    .get("turnInterrupted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let message = if interrupted {
                    format!(
                        "remote dsh exited ({detail}); the running turn has no result, its external effects are unknown and were not retried"
                    )
                } else {
                    format!("remote dsh exited ({detail}); no turn was running")
                };
                self.session_id = None;
                self.disconnected = Some(message.clone());
                vec![AcpEvent::Disconnected { detail: message }]
            }
            crate::remote_identity::REVOKED_NOTIFICATION => {
                let message = params
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Organization identity refused")
                    .to_string();
                let message = format!(
                    "{message}. The remote closed this connection and cancelled any turn it had started; run `codsh --rust login` if needed, then /reconnect"
                );
                self.identity = None;
                self.disconnected = Some(message.clone());
                vec![AcpEvent::Disconnected { detail: message }]
            }
            "_codsh/leader_disconnected" => {
                let message = "remote codsh leader stopped or restarted; a running turn has no result, its external effects are unknown and were not retried".to_string();
                self.disconnected = Some(message.clone());
                vec![AcpEvent::Disconnected { detail: message }]
            }
            _ => Vec::new(),
        }
    }

    fn handle_notification(&mut self, method: &str, params: Value) -> Vec<AcpEvent> {
        if self.remote && method != "session/update" {
            return self.remote_notification(method, params);
        }
        if method != "session/update" {
            return Vec::new();
        }
        if let Some(capture) = self.replay_capture.as_mut() {
            capture.push(params);
            return Vec::new();
        }
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let update = params.get("update").cloned().unwrap_or(Value::Null);
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        let message_id = update
            .get("messageId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let text = update
            .pointer("/content/text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        match kind {
            "agent_thought_chunk" => vec![AcpEvent::Thought {
                session_id,
                message_id,
                text,
            }],
            "agent_message_chunk" => vec![AcpEvent::Answer {
                session_id,
                message_id,
                text: text.clone(),
                hook: text.contains("\u{241e}hook\u{241e}"),
            }],
            "tool_call" => {
                let tool_call_id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let title = update
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let tool_kind = update
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("other")
                    .to_string();
                let status = update
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("pending")
                    .to_string();
                let raw_input = update.get("rawInput").cloned().unwrap_or(Value::Null);
                let content = update.get("content").cloned().unwrap_or_else(|| json!([]));
                let locations = update
                    .get("locations")
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                let diff = proposed_diff(&title, &raw_input);
                vec![AcpEvent::ToolCall {
                    session_id,
                    tool_call_id,
                    title,
                    kind: tool_kind,
                    status,
                    raw_input,
                    content,
                    locations,
                    diff,
                }]
            }
            "usage_update" => {
                let used = update.get("used").and_then(Value::as_u64);
                let size = update.get("size").and_then(Value::as_u64);
                let cost = update
                    .pointer("/cost/amount")
                    .and_then(Value::as_str)
                    .or_else(|| update.get("cost").and_then(Value::as_str))
                    .map(str::to_string);
                vec![AcpEvent::Usage { used, size, cost }]
            }
            "config_option_update" => {
                if let Some(option) = update.get("configOptions") {
                    self.config_options = parse_config_options(option);
                } else if let Some(option) = update.get("configOption") {
                    let parsed = parse_config_options(&json!([option]));
                    for updated in parsed {
                        if let Some(existing) = self
                            .config_options
                            .iter_mut()
                            .find(|option| option.id == updated.id)
                        {
                            *existing = updated;
                        } else {
                            self.config_options.push(updated);
                        }
                    }
                }
                vec![AcpEvent::ConfigOptions {
                    options: self.config_options.clone(),
                }]
            }
            "tool_call_update" => {
                let tool_call_id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let status = update
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                vec![AcpEvent::ToolCallUpdate {
                    session_id,
                    tool_call_id,
                    status,
                    content: tool_update_text(&update),
                    content_items: update.get("content").cloned().unwrap_or_else(|| json!([])),
                    raw_output: update.get("rawOutput").cloned().unwrap_or(Value::Null),
                    locations: update
                        .get("locations")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                }]
            }
            _ => Vec::new(),
        }
    }

    fn handle_response(&mut self, id: u64, value: Value) -> Vec<AcpEvent> {
        let kind = self.pending.remove(&id);
        if let Some(error) = value.get("error") {
            self.last_error_details = error
                .pointer("/data/details")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    error
                        .get("data")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("ACP error")
                .to_string();
            if matches!(kind, Some(PendingKind::Identity)) {
                self.identity_answer(id, Err(&message));
            }
            self.completed.insert(
                id,
                Err(AcpError {
                    message: message.clone(),
                }),
            );
            return vec![AcpEvent::RpcError {
                request_id: Some(id),
                code,
                message,
            }];
        }
        let result = value.get("result").cloned().unwrap_or(Value::Null);
        match kind {
            Some(PendingKind::Initialize) => {
                let version = result
                    .get("protocolVersion")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if version != PROTOCOL_VERSION {
                    let message = format!(
                        "ACP protocol mismatch: client {PROTOCOL_VERSION}, agent {version}"
                    );
                    self.disconnected = Some(message.clone());
                    self.completed.insert(id, Err(AcpError { message }));
                    return vec![AcpEvent::ProtocolMismatch { version }];
                }
                let capabilities = result
                    .pointer("/agentCapabilities/sessionCapabilities")
                    .cloned()
                    .unwrap_or(Value::Null);
                self.can_list = capabilities.get("list").is_some();
                self.can_resume = capabilities.get("resume").is_some();
                self.completed.insert(id, Ok(result));
                Vec::new()
            }
            Some(PendingKind::SessionNew) | Some(PendingKind::SessionResume) => {
                if let Some(session_id) = result.get("sessionId").and_then(Value::as_str) {
                    self.session_id = Some(session_id.to_string());
                }
                self.config_options =
                    parse_config_options(result.get("configOptions").unwrap_or(&Value::Null));
                self.completed.insert(id, Ok(result));
                vec![AcpEvent::ConfigOptions {
                    options: self.config_options.clone(),
                }]
            }
            Some(PendingKind::SetConfig) => {
                self.config_options =
                    parse_config_options(result.get("configOptions").unwrap_or(&Value::Null));
                if self.config_options.is_empty() {
                    self.config_options = parse_config_options(&result);
                }
                self.completed.insert(id, Ok(result));
                vec![AcpEvent::ConfigOptions {
                    options: self.config_options.clone(),
                }]
            }
            Some(PendingKind::SessionList) => {
                self.completed.insert(id, Ok(result));
                Vec::new()
            }
            Some(PendingKind::Identity) => {
                self.identity_answer(id, Ok(&result));
                Vec::new()
            }
            Some(PendingKind::Prompt) => {
                let stop_reason = result
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn")
                    .to_string();
                if stop_reason != "cancelled" {
                    self.prompt_cancelled = false;
                }
                self.completed.insert(id, Ok(result.clone()));
                vec![AcpEvent::PromptFinished {
                    request_id: id,
                    stop_reason,
                    result,
                }]
            }
            _ => {
                self.completed.insert(id, Ok(result));
                Vec::new()
            }
        }
    }

    fn write_raw(&mut self, value: Value) -> Result<(), AcpError> {
        let stdin = self.stdin.as_mut().ok_or_else(|| AcpError {
            message: "ACP stdin closed".into(),
        })?;
        stdin
            .write_all(format!("{value}\n").as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|error| AcpError {
                message: format!("ACP write failed: {error}"),
            })
    }
}

/// Signal the whole group. `id` is the process-group id because spawn
/// called `process_group(0)`. A direct `child.kill()` would leave a
/// grandchild running after the session ends.
/// Upper bound for each shutdown step while background commands run.
const LINGER_MS: u64 = 3000;

fn kill_process_group(pid: u32) {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
    }
}

impl Drop for AcpClient {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_nested_fork_model_option_value() {
        let options = json!([{
            "id": "model",
            "category": "model",
            "options": [{
                "group": "cli-mock",
                "options": [
                    { "value": "[\"cli-mock\",\"cli-mock\"]", "name": "CLI Mock" },
                    { "value": "[\"cli-mock\",\"cli-mock-fork\"]", "name": "CLI Mock Fork" }
                ]
            }]
        }]);
        let values: Vec<String> = parse_config_options(&options)
            .into_iter()
            .find(|option| option.id == "model")
            .into_iter()
            .flat_map(|option| option.choices.into_iter().map(|choice| choice.value))
            .collect();
        assert_eq!(
            resolve_fork_model_value(&values, "cli-mock-fork").as_deref(),
            Some("[\"cli-mock\",\"cli-mock-fork\"]")
        );
        assert!(resolve_fork_model_value(&values, "missing").is_none());
    }

    fn node_program() -> PathBuf {
        std::env::var_os("CODSH_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node"))
    }

    fn fake_agent() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-acp-agent.mjs")
    }

    fn spawn_fake(mode: &str) -> AcpClient {
        spawn_fake_env(mode, Vec::new())
    }

    fn spawn_fake_env(mode: &str, extra: Vec<(String, String)>) -> AcpClient {
        let cwd = std::env::temp_dir();
        let mut env = vec![
            ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
            ("FAKE_ACP_MODE".into(), mode.into()),
        ];
        env.extend(extra);
        AcpClient::spawn(SpawnSpec {
            program: node_program(),
            args: vec![fake_agent().to_string_lossy().into_owned()],
            env,
            cwd,
            stderr_log: None,
            remote: false,
        })
        .expect("fake ACP agent")
    }

    fn ready(mode: &str) -> AcpClient {
        let mut client = spawn_fake(mode);
        client
            .initialize(Duration::from_secs(2))
            .expect("initialize");
        client
            .new_session(&std::env::temp_dir(), Duration::from_secs(2))
            .expect("session");
        client
    }

    #[test]
    fn spawn_spec_forwards_handed_identity_not_parent_auth_env() {
        let dir = tempfile::TempDir::new().unwrap();
        let dsh = dir.path().join("dsh-bin");
        std::fs::write(&dsh, "#!/bin/sh\n").unwrap();
        let previous_bin = std::env::var_os("DSH_BIN");
        unsafe {
            std::env::set_var("DSH_BIN", &dsh);
        }
        let spec = dsh_spawn_spec(
            dir.path().to_path_buf(),
            dir.path(),
            &[
                ("GROK_AUTH_PATH".into(), "/tmp/auth.json".into()),
                ("GROK_AUTH_ACCESS_TOKEN".into(), "handed-token".into()),
                ("GROK_AUTH_PROVIDER_COMMAND".into(), "printf token".into()),
                ("GROK_AUTH_NOISE".into(), "dropped".into()),
                ("XAI_API_KEY".into(), "model-key".into()),
            ],
            None,
        );
        unsafe {
            match previous_bin {
                Some(value) => std::env::set_var("DSH_BIN", value),
                None => std::env::remove_var("DSH_BIN"),
            }
        }
        let spec = spec.unwrap();
        let env: std::collections::BTreeMap<_, _> = spec.env.into_iter().collect();
        assert!(
            !env.contains_key("GROK_AUTH_NOISE"),
            "undocumented GROK_AUTH_* must not reach dsh"
        );
        assert_eq!(
            env.get("GROK_AUTH_ACCESS_TOKEN").map(String::as_str),
            Some("handed-token")
        );
        assert_eq!(
            env.get("GROK_AUTH_PATH").map(String::as_str),
            Some("/tmp/auth.json")
        );
        assert_eq!(
            env.get("GROK_AUTH_PROVIDER_COMMAND").map(String::as_str),
            Some("printf token")
        );
        assert_eq!(
            env.get("XAI_API_KEY").map(String::as_str),
            Some("model-key")
        );
        assert_eq!(
            env.get("CODSH_WORKFLOW_ENGINE").map(String::as_str),
            Some(std::env::current_exe().unwrap().to_string_lossy().as_ref()),
            "the dsh workflow tool runs scripts in this executable"
        );
    }

    #[test]
    fn rejects_protocol_mismatch() {
        let mut client = spawn_fake("mismatch");
        let error = client
            .initialize(Duration::from_secs(2))
            .expect_err("mismatch");
        assert!(error.message.contains("protocol mismatch"), "{error}");
    }

    #[test]
    fn streams_thought_then_answer_with_stable_ids() {
        let mut client = ready("reasoning");
        let id = client.submit_prompt("hello").unwrap();
        let mut thought = None;
        let mut answer = None;
        let mut finished = None;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            for event in client.pump(Duration::from_millis(50)) {
                match event {
                    AcpEvent::Thought {
                        message_id, text, ..
                    } => thought = Some((message_id, text)),
                    AcpEvent::Answer {
                        message_id, text, ..
                    } => answer = Some((message_id, text)),
                    AcpEvent::PromptFinished {
                        request_id,
                        stop_reason,
                        ..
                    } if request_id == id => {
                        finished = Some(stop_reason);
                    }
                    other => panic!("unexpected {other:?}"),
                }
            }
            if thought.is_some() && answer.is_some() && finished.is_some() {
                break;
            }
        }
        let thought = thought.expect("thought");
        let answer = answer.expect("answer");
        assert_eq!(thought.0, answer.0);
        assert_eq!(thought.1, "FAKE_ACP_THOUGHT");
        assert!(answer.1.contains("FAKE_ACP_ANSWER hello"));
        assert_eq!(finished.as_deref(), Some("end_turn"));
    }

    #[test]
    fn empty_answer_is_not_fabricated() {
        let mut client = ready("empty");
        let id = client.submit_prompt("silence").unwrap();
        let mut events = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            events.extend(client.pump(Duration::from_millis(50)));
            if events.iter().any(|event| matches!(event, AcpEvent::PromptFinished { request_id, .. } if *request_id == id)) {
                break;
            }
        }
        assert!(
            events
                .iter()
                .all(|event| !matches!(event, AcpEvent::Answer { .. }))
        );
        assert!(events.iter().any(|event| matches!(event, AcpEvent::PromptFinished { stop_reason, .. } if stop_reason == "end_turn")));
    }

    #[test]
    fn mid_stream_failure_is_not_success_and_next_prompt_works() {
        let mut client = ready("fail");
        let first = client.submit_prompt("boom").unwrap();
        let mut saw_partial = false;
        let mut saw_error = false;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            for event in client.pump(Duration::from_millis(50)) {
                match event {
                    AcpEvent::Answer { text, .. } if text.contains("FAKE_ACP_PARTIAL") => {
                        saw_partial = true;
                    }
                    AcpEvent::RpcError {
                        request_id: Some(id),
                        ..
                    } if id == first => {
                        saw_error = true;
                    }
                    AcpEvent::PromptFinished { request_id, .. } if request_id == first => {
                        panic!("failed prompt reported success");
                    }
                    _ => {}
                }
            }
            if saw_partial && saw_error {
                break;
            }
        }
        assert!(saw_partial && saw_error);
        let second = client.submit_prompt("again").unwrap();
        let mut finished = false;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            for event in client.pump(Duration::from_millis(50)) {
                if matches!(event, AcpEvent::RpcError { request_id: Some(id), .. } if id == second)
                {
                    finished = true;
                }
            }
            if finished {
                break;
            }
        }
        assert!(
            finished,
            "next prompt after failure must still reach the agent"
        );
    }

    #[test]
    fn connection_end_is_not_success() {
        let mut client = ready("drop");
        let id = client.submit_prompt("bye").unwrap();
        let mut disconnected = false;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            for event in client.pump(Duration::from_millis(50)) {
                match event {
                    AcpEvent::PromptFinished { request_id, .. } if request_id == id => {
                        panic!("dropped connection reported success");
                    }
                    AcpEvent::Disconnected { .. } => disconnected = true,
                    _ => {}
                }
            }
            if disconnected {
                break;
            }
        }
        assert!(disconnected);
    }

    #[test]
    fn unknown_method_is_rejected() {
        let mut client = ready("echo");
        let id = client
            .request(
                "session/load",
                json!({ "sessionId": "fake-session" }),
                PendingKind::Other,
            )
            .unwrap();
        let mut error = None;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            for event in client.pump(Duration::from_millis(50)) {
                if let AcpEvent::RpcError {
                    request_id: Some(request_id),
                    message,
                    ..
                } = event
                    && request_id == id
                {
                    error = Some(message);
                }
            }
            if error.is_some() {
                break;
            }
        }
        assert!(
            error
                .unwrap_or_default()
                .to_lowercase()
                .contains("not found")
        );
    }

    fn wait_permission(client: &mut AcpClient) -> PendingPermission {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            for event in client.pump(Duration::from_millis(50)) {
                if let AcpEvent::PermissionRequest {
                    request_id,
                    session_id,
                    tool_call_id,
                    options,
                } = event
                {
                    return PendingPermission {
                        request_id,
                        session_id,
                        tool_call_id,
                        options,
                    };
                }
            }
        }
        panic!("missing permission request");
    }

    #[test]
    fn proposed_diff_uses_dsh_tool_arguments() {
        let write = proposed_diff(
            "write",
            &json!({"file_path": "note.txt", "content": "hello\nworld"}),
        );
        assert!(write.contains("write note.txt"), "{write}");
        assert!(write.contains("+hello"), "{write}");
        assert!(write.contains("+world"), "{write}");
        let edit = proposed_diff(
            "edit",
            &json!({"file_path": "note.txt", "old_string": "alpha", "new_string": "ALPHA"}),
        );
        assert!(edit.contains("edit note.txt"), "{edit}");
        assert!(edit.contains("-alpha"), "{edit}");
        assert!(edit.contains("+ALPHA"), "{edit}");
        assert_eq!(
            proposed_diff("read", &json!({"file_path": "note.txt"})),
            "read note.txt"
        );
    }

    #[test]
    fn permission_allow_once_executes_and_duplicate_reply_is_rejected() {
        let target = tempfile::NamedTempFile::new().unwrap();
        let path = target.path().to_string_lossy().into_owned();
        let mut client =
            spawn_fake_env("permission", vec![("FAKE_ACP_TARGET".into(), path.clone())]);
        client
            .initialize(Duration::from_secs(2))
            .expect("initialize");
        client
            .new_session(&std::env::temp_dir(), Duration::from_secs(2))
            .expect("session");
        let prompt = client.submit_prompt("edit").unwrap();
        let mut tool = None;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            for event in client.pump(Duration::from_millis(50)) {
                if let AcpEvent::ToolCall {
                    tool_call_id, diff, ..
                } = event
                {
                    tool = Some((tool_call_id, diff));
                }
            }
            if client.pending_permission.is_some() && tool.is_some() {
                break;
            }
        }
        let permission = client
            .pending_permission
            .clone()
            .expect("permission request");
        let (tool_call_id, diff) = tool.expect("tool call");
        assert_eq!(permission.tool_call_id, tool_call_id);
        assert!(diff.contains("write note.txt"), "{diff}");
        assert!(diff.contains("+FAKE_ACP_WROTE"), "{diff}");
        client
            .answer_permission(&permission.request_id, "allow-once")
            .expect("allow");
        let duplicate = client
            .answer_permission(&permission.request_id, "allow-once")
            .expect_err("duplicate");
        assert!(
            duplicate.message.contains("duplicate") || duplicate.message.contains("stale"),
            "{duplicate}"
        );
        let mut finished = false;
        let mut result = None;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            for event in client.pump(Duration::from_millis(50)) {
                match event {
                    AcpEvent::ToolCallUpdate {
                        tool_call_id: id,
                        status,
                        content,
                        ..
                    } if id == tool_call_id => {
                        result = Some((status, content));
                    }
                    AcpEvent::PromptFinished { request_id, .. } if request_id == prompt => {
                        finished = true;
                    }
                    _ => {}
                }
            }
            if finished && result.is_some() {
                break;
            }
        }
        assert!(finished);
        let (status, content) = result.expect("tool result");
        assert_eq!(status, "completed");
        assert!(content.contains("Created file"), "{content}");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "FAKE_ACP_WROTE count=1\n"
        );
    }

    #[test]
    fn permission_reject_and_cancel_have_no_write_side_effect() {
        let target = tempfile::NamedTempFile::new().unwrap();
        let path = target.path().to_string_lossy().into_owned();
        std::fs::write(&path, "original\n").unwrap();
        let mut client =
            spawn_fake_env("permission", vec![("FAKE_ACP_TARGET".into(), path.clone())]);
        client
            .initialize(Duration::from_secs(2))
            .expect("initialize");
        client
            .new_session(&std::env::temp_dir(), Duration::from_secs(2))
            .expect("session");
        let _ = client.submit_prompt("edit").unwrap();
        let permission = wait_permission(&mut client);
        client
            .answer_permission(&permission.request_id, "reject-once")
            .expect("reject");
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut failed = false;
        while Instant::now() < deadline {
            for event in client.pump(Duration::from_millis(50)) {
                if let AcpEvent::ToolCallUpdate {
                    status, content, ..
                } = event
                {
                    assert_eq!(status, "failed");
                    assert!(!content.to_lowercase().contains("success"), "{content}");
                    failed = true;
                }
            }
            if failed {
                break;
            }
        }
        assert!(failed);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original\n");

        let mut client =
            spawn_fake_env("permission", vec![("FAKE_ACP_TARGET".into(), path.clone())]);
        client
            .initialize(Duration::from_secs(2))
            .expect("initialize");
        client
            .new_session(&std::env::temp_dir(), Duration::from_secs(2))
            .expect("session");
        let _ = client.submit_prompt("again").unwrap();
        let permission = wait_permission(&mut client);
        client
            .cancel_permission(&permission.request_id)
            .expect("cancel");
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let _ = client.pump(Duration::from_millis(50));
            if std::fs::read_to_string(&path).unwrap() != "original\n" {
                panic!("cancelled permission wrote the file");
            }
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original\n");
    }

    #[test]
    fn stale_permission_reply_is_not_success() {
        let target = tempfile::NamedTempFile::new().unwrap();
        let path = target.path().to_string_lossy().into_owned();
        std::fs::write(&path, "original\n").unwrap();
        let mut client = spawn_fake_env(
            "permission-stale",
            vec![("FAKE_ACP_TARGET".into(), path.clone())],
        );
        client
            .initialize(Duration::from_secs(2))
            .expect("initialize");
        client
            .new_session(&std::env::temp_dir(), Duration::from_secs(2))
            .expect("session");
        let _ = client.submit_prompt("edit").unwrap();
        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            for event in client.pump(Duration::from_millis(50)) {
                if let AcpEvent::PermissionRequest {
                    request_id,
                    session_id,
                    tool_call_id,
                    options,
                } = event
                {
                    seen.push(PendingPermission {
                        request_id,
                        session_id,
                        tool_call_id,
                        options,
                    });
                }
            }
            if seen.len() >= 2 {
                break;
            }
        }
        assert!(
            seen.len() >= 2,
            "need two permission requests, got {}",
            seen.len()
        );
        let first = seen[0].clone();
        let second = seen[1].clone();
        assert_ne!(first.request_id, second.request_id);
        let stale = client
            .answer_permission(&first.request_id, "allow-once")
            .expect_err("stale");
        assert!(stale.message.contains("stale"), "{stale}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original\n");
        client
            .answer_permission(&second.request_id, "allow-once")
            .expect("later allow");
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let _ = client.pump(Duration::from_millis(50));
            if std::fs::read_to_string(&path).ok().as_deref() == Some("FAKE_ACP_WROTE count=1\n") {
                break;
            }
        }
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "FAKE_ACP_WROTE count=1\n"
        );
    }

    #[test]
    fn missing_file_and_tool_error_are_failed_not_success() {
        let mut client = ready("file-missing");
        let id = client.submit_prompt("read missing").unwrap();
        let mut failed = None;
        let mut finished = false;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            for event in client.pump(Duration::from_millis(50)) {
                match event {
                    AcpEvent::ToolCallUpdate {
                        status, content, ..
                    } => {
                        failed = Some((status, content));
                    }
                    AcpEvent::PromptFinished { request_id, .. } if request_id == id => {
                        finished = true;
                    }
                    _ => {}
                }
            }
            if failed.is_some() && finished {
                break;
            }
        }
        let (status, content) = failed.expect("failed tool");
        assert_eq!(status, "failed");
        assert!(content.contains("not found"), "{content}");
        assert!(!content.to_lowercase().contains("success"), "{content}");
        assert!(finished);

        let mut client = ready("file-error");
        let id = client.submit_prompt("bad edit").unwrap();
        let mut failed = None;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            for event in client.pump(Duration::from_millis(50)) {
                match event {
                    AcpEvent::ToolCallUpdate {
                        status, content, ..
                    } => {
                        failed = Some((status, content));
                    }
                    AcpEvent::PromptFinished { request_id, .. } if request_id == id => {}
                    _ => {}
                }
            }
            if failed
                .as_ref()
                .is_some_and(|(status, _)| status == "failed")
            {
                break;
            }
        }
        let (status, content) = failed.expect("tool error");
        assert_eq!(status, "failed");
        assert!(
            content.contains("Error") || content.contains("not found"),
            "{content}"
        );
        assert!(!content.to_lowercase().contains("success"), "{content}");
    }

    fn wait_stop(client: &mut AcpClient, id: u64) -> String {
        let from_completed = |client: &AcpClient| {
            client.completed.get(&id).map(|result| match result {
                Ok(value) => value
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn")
                    .to_string(),
                Err(error) => format!("error:{}", error.message),
            })
        };
        if let Some(stop) = from_completed(client) {
            return stop;
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            for event in client.pump(Duration::from_millis(50)) {
                match event {
                    AcpEvent::PromptFinished {
                        request_id,
                        stop_reason,
                        ..
                    } if request_id == id => return stop_reason,
                    AcpEvent::RpcError {
                        request_id: Some(request_id),
                        message,
                        ..
                    } if request_id == id => return format!("error:{message}"),
                    _ => {}
                }
            }
            if let Some(stop) = from_completed(client) {
                return stop;
            }
        }
        panic!("missing prompt settlement for {id}")
    }

    #[test]
    fn cancel_slow_stream_is_cancelled_and_next_prompt_works() {
        let mut client = spawn_fake_env(
            "slow-stream",
            vec![("FAKE_ACP_DELAY_MS".into(), "1500".into())],
        );
        client
            .initialize(Duration::from_secs(2))
            .expect("initialize");
        client
            .new_session(&std::env::temp_dir(), Duration::from_secs(2))
            .expect("session");
        let first = client.submit_prompt("TOKEN_SLOW").unwrap();
        client.cancel_prompt().expect("cancel");
        assert_eq!(wait_stop(&mut client, first), "cancelled");
        let late_allow = client.answer_permission(&json!(1), "allow-once");
        assert!(late_allow.is_err(), "{late_allow:?}");
        let second = client.submit_prompt("TOKEN_AFTER").unwrap();
        let mut answer = None;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            for event in client.pump(Duration::from_millis(50)) {
                if let AcpEvent::Answer { text, .. } = event {
                    answer = Some(text);
                }
            }
            if answer
                .as_deref()
                .is_some_and(|text| text.contains("TOKEN_AFTER"))
            {
                break;
            }
        }
        assert_eq!(wait_stop(&mut client, second), "end_turn");
        assert!(
            answer
                .as_deref()
                .is_some_and(|text| text.contains("TOKEN_AFTER")),
            "{answer:?}"
        );
    }

    #[test]
    fn cancel_pending_permission_and_late_allow_do_not_write() {
        let target = tempfile::NamedTempFile::new().unwrap();
        let path = target.path().to_string_lossy().into_owned();
        std::fs::write(&path, "original\n").unwrap();
        let mut client =
            spawn_fake_env("permission", vec![("FAKE_ACP_TARGET".into(), path.clone())]);
        client
            .initialize(Duration::from_secs(2))
            .expect("initialize");
        client
            .new_session(&std::env::temp_dir(), Duration::from_secs(2))
            .expect("session");
        let id = client.submit_prompt("edit").unwrap();
        let permission = wait_permission(&mut client);
        client.cancel_prompt().expect("cancel");
        let stale = client.answer_permission(&permission.request_id, "allow-once");
        assert!(stale.is_err(), "{stale:?}");
        assert_eq!(wait_stop(&mut client, id), "cancelled");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original\n");
    }

    #[test]
    fn cancel_during_tool_does_not_write_after_process_teardown() {
        let target = tempfile::NamedTempFile::new().unwrap();
        let path = target.path().to_string_lossy().into_owned();
        std::fs::write(&path, "original\n").unwrap();
        let mut client = spawn_fake_env(
            "slow-tool",
            vec![
                ("FAKE_ACP_TARGET".into(), path.clone()),
                ("FAKE_ACP_DELAY_MS".into(), "1500".into()),
            ],
        );
        client
            .initialize(Duration::from_secs(2))
            .expect("initialize");
        client
            .new_session(&std::env::temp_dir(), Duration::from_secs(2))
            .expect("session");
        let id = client.submit_prompt("write slowly").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut saw_tool = false;
        while Instant::now() < deadline {
            for event in client.pump(Duration::from_millis(50)) {
                if let AcpEvent::ToolCall { .. } = event {
                    saw_tool = true;
                }
            }
            if saw_tool {
                break;
            }
        }
        assert!(saw_tool, "tool must start before cancel");
        client.cancel_prompt().expect("cancel");
        assert_eq!(wait_stop(&mut client, id), "cancelled");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original\n");
        client.shutdown();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original\n");
    }

    #[test]
    fn cancel_at_completion_is_truthful_and_does_not_duplicate() {
        let mut client = ready("echo");
        let id = client.submit_prompt("TOKEN_RACE").unwrap();
        let stop = wait_stop(&mut client, id);
        assert_eq!(stop, "end_turn");
        client.cancel_prompt().expect("cancel after completion");
        let second = client.submit_prompt("TOKEN_NEXT").unwrap();
        assert_eq!(wait_stop(&mut client, second), "end_turn");
    }

    #[test]
    fn same_directory_resume_waits_until_the_current_session_closes() {
        let store = tempfile::NamedTempFile::new().unwrap();
        let store_path = store.path().to_string_lossy().into_owned();
        let mut client = spawn_fake_env(
            "echo",
            vec![
                ("FAKE_ACP_STORE".into(), store_path.clone()),
                ("FAKE_ACP_REFUSE_WHILE_LIVE".into(), "1".into()),
            ],
        );
        client
            .initialize(Duration::from_secs(2))
            .expect("initialize");
        let current = client
            .new_session(&std::env::temp_dir(), Duration::from_secs(2))
            .expect("current");
        let target = "closed-same-directory-target";
        let cwd = std::env::temp_dir()
            .canonicalize()
            .unwrap_or_else(|_| std::env::temp_dir());
        let mut shared: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&store_path).unwrap_or_else(|_| "{\"sessions\":{}}".into()),
        )
        .unwrap_or_else(|_| json!({"sessions": {}}));
        shared["sessions"][target] = json!({
            "sessionId": target,
            "cwd": cwd,
            "closed": true,
            "owned": false,
            "prompts": []
        });
        std::fs::write(&store_path, format!("{shared}\n")).unwrap();
        let early = client.prepare_resume(target, &std::env::temp_dir(), Duration::from_secs(2));
        assert!(
            early
                .as_ref()
                .err()
                .is_some_and(|error| error.message.contains("already active")),
            "{early:?}"
        );
        assert_eq!(
            client.session_id.as_deref(),
            Some(current.as_str()),
            "a refused resume must not replace the live session"
        );
        let store_body = std::fs::read_to_string(&store_path).unwrap_or_default();
        let trace: serde_json::Value =
            serde_json::from_str(&store_body).unwrap_or_else(|_| json!({}));
        let methods: Vec<&str> = trace
            .get("methods")
            .and_then(|value| value.as_array())
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("method").and_then(|method| method.as_str()))
            .collect();
        let resume_at = methods
            .iter()
            .position(|method| *method == "session/resume")
            .expect("session/resume was sent");
        assert!(
            methods[..resume_at]
                .iter()
                .all(|method| *method != "session/close"),
            "close arrived before the refused resume: {methods:?}"
        );
        // The refusal is gone. A later resume of the closed target succeeds,
        // and only then is the previous session closed.
        if let serde_json::Value::Object(root) = &mut shared
            && let Some(serde_json::Value::Object(sessions)) = root.get_mut("sessions")
            && let Some(serde_json::Value::Object(record)) = sessions.get_mut(target)
        {
            record.insert("closed".into(), json!(true));
            record.insert("owned".into(), json!(false));
            record.insert("refuseWhileLive".into(), json!(false));
        }
        std::fs::write(&store_path, format!("{shared}\n")).unwrap();
        client
            .prepare_resume(target, &std::env::temp_dir(), Duration::from_secs(2))
            .expect("resume while the current session is still open");
        assert_eq!(client.session_id.as_deref(), Some(target));
        client
            .finish_resume(&current, &std::env::temp_dir(), Duration::from_secs(2))
            .expect("close the previous session only after resume");
        assert_eq!(client.session_id.as_deref(), Some(target));
    }

    #[test]
    fn refused_resume_while_another_session_is_live_keeps_the_current_session() {
        let store = tempfile::NamedTempFile::new().unwrap();
        let store_path = store.path().to_string_lossy().into_owned();
        let mut holder =
            spawn_fake_env("echo", vec![("FAKE_ACP_STORE".into(), store_path.clone())]);
        holder
            .initialize(Duration::from_secs(2))
            .expect("initialize holder");
        let held = holder
            .new_session(&std::env::temp_dir(), Duration::from_secs(2))
            .expect("held session");

        let mut live = spawn_fake_env("echo", vec![("FAKE_ACP_STORE".into(), store_path)]);
        live.initialize(Duration::from_secs(2))
            .expect("initialize live");
        let current = live
            .new_session(&std::env::temp_dir(), Duration::from_secs(2))
            .expect("current session");
        let prompt = live.submit_prompt("TOKEN_STAY").unwrap();
        assert_eq!(wait_stop(&mut live, prompt), "end_turn");

        let refused = live
            .resume_session(&held, &std::env::temp_dir(), Duration::from_secs(2))
            .expect_err("same-directory resume of a live session");
        assert!(
            refused.message.contains("already active") || refused.message.contains("already owned"),
            "{refused}"
        );
        assert_eq!(
            live.session_id.as_deref(),
            Some(current.as_str()),
            "a refused resume must not close the session this client already owns"
        );
        let follow = live.submit_prompt("TOKEN_STILL_HERE").unwrap();
        assert_eq!(wait_stop(&mut live, follow), "end_turn");
        drop(holder);
    }

    #[test]
    fn resumes_closed_fake_session_and_refuses_an_active_owner() {
        let store = tempfile::NamedTempFile::new().unwrap();
        let store_path = store.path().to_string_lossy().into_owned();
        let mut first = spawn_fake_env("echo", vec![("FAKE_ACP_STORE".into(), store_path.clone())]);
        first
            .initialize(Duration::from_secs(2))
            .expect("initialize");
        assert!(first.can_resume && first.can_list);
        let session = first
            .new_session(&std::env::temp_dir(), Duration::from_secs(2))
            .expect("session");
        let prompt = first.submit_prompt("TOKEN_ONE").unwrap();
        assert_eq!(wait_stop(&mut first, prompt), "end_turn");
        first.close_session(Duration::from_secs(2)).expect("close");
        drop(first);

        let mut owned = spawn_fake_env(
            "echo",
            vec![
                ("FAKE_ACP_STORE".into(), store_path.clone()),
                ("FAKE_ACP_OWNED".into(), "1".into()),
            ],
        );
        owned
            .initialize(Duration::from_secs(2))
            .expect("initialize owned");
        let refused = owned
            .resume_session(&session, &std::env::temp_dir(), Duration::from_secs(2))
            .expect_err("owned");
        assert!(
            refused.message.contains("already owned") || refused.message.contains("already active"),
            "{refused}"
        );
        drop(owned);

        let mut second = spawn_fake_env("echo", vec![("FAKE_ACP_STORE".into(), store_path)]);
        second
            .initialize(Duration::from_secs(2))
            .expect("initialize second");
        let listed = second
            .list_sessions(&std::env::temp_dir(), Duration::from_secs(2))
            .expect("list");
        assert!(listed.iter().any(|(id, _)| id == &session), "{listed:?}");
        second
            .resume_session(&session, &std::env::temp_dir(), Duration::from_secs(2))
            .expect("resume");
        let follow = second.submit_prompt("TOKEN_TWO").unwrap();
        assert_eq!(wait_stop(&mut second, follow), "end_turn");
    }

    #[test]
    fn stale_owner_prompt_is_refused() {
        let mut client = spawn_fake_env("echo", vec![("FAKE_ACP_STALE_OWNER".into(), "1".into())]);
        client
            .initialize(Duration::from_secs(2))
            .expect("initialize");
        client
            .new_session(&std::env::temp_dir(), Duration::from_secs(2))
            .expect("session");
        let id = client.submit_prompt("TOKEN_STALE").unwrap();
        let stop = wait_stop(&mut client, id);
        assert!(
            stop.contains("stale session owner") || stop.starts_with("error:"),
            "{stop}"
        );
        assert_ne!(stop, "end_turn");
    }

    #[test]
    fn shutdown_reaps_child_before_owner_release() {
        let home = tempfile::tempdir().unwrap();
        let mut client = ready("echo");
        let session = format!("shutdown-reap-{}", std::process::id());
        let owner =
            crate::session_owner::SessionOwner::acquire(home.path(), &session).expect("owner");
        client.shutdown();
        drop(owner);
        crate::session_owner::SessionOwner::acquire(home.path(), &session)
            .expect("successor after shutdown");
    }

    #[test]
    fn set_config_option_rejects_unadvertised_values() {
        let mut client = ready("echo");
        assert!(
            client.config_option("model").is_some_and(|option| option
                .choices
                .iter()
                .any(|choice| choice.value.contains("chat"))),
            "{:?}",
            client.config_options
        );
        let switched = client
            .set_config_option("model", r#"["chat","shared-name"]"#, Duration::from_secs(2))
            .expect("switch");
        assert!(
            switched.iter().any(|option| option.id == "model"
                && option.current.as_deref() == Some(r#"["chat","shared-name"]"#)),
            "{switched:?}"
        );
        let error = client
            .set_config_option("reasoning_effort", "xhigh", Duration::from_secs(2))
            .expect_err("unadvertised");
        assert!(error.message.contains("unsupported"), "{error}");
        assert_eq!(
            client
                .config_option("reasoning_effort")
                .and_then(|option| option.current.clone())
                .as_deref(),
            Some("high")
        );
    }
}
