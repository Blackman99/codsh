use serde_json::{Value, json};
use std::collections::HashMap;
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
    },
    PromptFinished {
        request_id: u64,
        stop_reason: String,
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
    PermissionCancelled {
        session_id: String,
    },
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

pub struct AcpClient {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<Line>,
    next_id: u64,
    pending: HashMap<u64, PendingKind>,
    completed: HashMap<u64, Result<Value, AcpError>>,
    pub session_id: Option<String>,
    disconnected: Option<String>,
}

enum Line {
    Text(String),
    Eof,
}

enum PendingKind {
    Initialize,
    SessionNew,
    Prompt,
    Close,
    #[allow(dead_code)]
    Other,
}

pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    pub stderr_log: Option<PathBuf>,
}

pub fn dsh_spawn_spec(cwd: PathBuf, dsh_home: &Path) -> Result<SpawnSpec, AcpError> {
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
    if let Some(patch) = std::env::var_os("CODSH_ACP_PATCH") {
        args.push("--patch".into());
        args.push(PathBuf::from(patch).to_string_lossy().into_owned());
    }
    let mut env = Vec::new();
    for key in [
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
        "FAKE_ACP_MODE",
        "FAKE_ACP_VERSION",
    ] {
        if let Some(value) = std::env::var_os(key) {
            env.push((key.to_string(), value.to_string_lossy().into_owned()));
        }
    }
    env.push(("DSH_TELEMETRY_DISABLED".into(), "1".into()));
    env.push(("DSH_TELEMETRY_MODE".into(), "OFF".into()));
    env.push(("CODSH_UPDATE_CHECK".into(), "off".into()));
    env.push(("DEEPSEEK_API_KEY".into(), String::new()));
    Ok(SpawnSpec {
        program,
        args,
        env,
        cwd,
        stderr_log: Some(dsh_home.join("acp-stderr.log")),
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
        let mut child = command.spawn()?;
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("missing ACP stdout"))?;
        let stderr = child.stderr.take();
        if let Some(log_path) = spec.stderr_log {
            thread::spawn(move || {
                if let Some(mut stderr) = stderr
                    && let Ok(mut file) = std::fs::File::create(log_path)
                {
                    let _ = io::copy(&mut stderr, &mut file);
                }
            });
        } else {
            thread::spawn(move || {
                if let Some(mut stderr) = stderr {
                    let mut sink = io::sink();
                    let _ = io::copy(&mut stderr, &mut sink);
                }
            });
        }
        let (tx, rx) = mpsc::channel();
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
        })
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
        Ok(result)
    }

    pub fn new_session(&mut self, cwd: &Path, timeout: Duration) -> Result<String, AcpError> {
        let cwd = cwd
            .canonicalize()
            .unwrap_or_else(|_| cwd.to_path_buf())
            .to_string_lossy()
            .into_owned();
        let id = self.request(
            "session/new",
            json!({ "cwd": cwd, "mcpServers": [] }),
            PendingKind::SessionNew,
        )?;
        let result = self.wait_result(id, timeout)?;
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| AcpError {
                message: "ACP session/new omitted sessionId".into(),
            })?
            .to_string();
        self.session_id = Some(session_id.clone());
        Ok(session_id)
    }

    pub fn submit_prompt(&mut self, text: &str) -> Result<u64, AcpError> {
        let session_id = self.session_id.clone().ok_or_else(|| AcpError {
            message: "ACP session is not ready".into(),
        })?;
        self.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": text }],
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
        let mut events = Vec::new();
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
                Ok(Line::Eof) => {
                    let detail = self
                        .disconnected
                        .clone()
                        .unwrap_or_else(|| "ACP connection ended".into());
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
                        Line::Eof => {
                            events.push(AcpEvent::Disconnected {
                                detail: "ACP connection ended".into(),
                            });
                            return events;
                        }
                    }
                }
                break;
            }
        }
        events
    }

    pub fn shutdown(&mut self) {
        let _ = self.close_session(Duration::from_millis(400));
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn request(&mut self, method: &str, params: Value, kind: PendingKind) -> Result<u64, AcpError> {
        if let Some(detail) = &self.disconnected {
            return Err(AcpError {
                message: detail.clone(),
            });
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
            let _ = self.pump(Duration::from_millis(50));
            if let Some(result) = self.completed.remove(&id) {
                return result;
            }
            if self.disconnected.is_some() && !self.pending.contains_key(&id) {
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
            if let Some(id) = id {
                let _ = self.write_raw(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "outcome": { "outcome": "cancelled" } },
                }));
            }
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            return vec![AcpEvent::PermissionCancelled { session_id }];
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

    fn handle_notification(&mut self, method: &str, params: Value) -> Vec<AcpEvent> {
        if method != "session/update" {
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
                text,
            }],
            _ => Vec::new(),
        }
    }

    fn handle_response(&mut self, id: u64, value: Value) -> Vec<AcpEvent> {
        let kind = self.pending.remove(&id);
        if let Some(error) = value.get("error") {
            let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("ACP error")
                .to_string();
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
                self.completed.insert(id, Ok(result));
                Vec::new()
            }
            Some(PendingKind::SessionNew) => {
                if let Some(session_id) = result.get("sessionId").and_then(Value::as_str) {
                    self.session_id = Some(session_id.to_string());
                }
                self.completed.insert(id, Ok(result));
                Vec::new()
            }
            Some(PendingKind::Prompt) => {
                let stop_reason = result
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn")
                    .to_string();
                self.completed.insert(id, Ok(result.clone()));
                vec![AcpEvent::PromptFinished {
                    request_id: id,
                    stop_reason,
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

impl Drop for AcpClient {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node_program() -> PathBuf {
        std::env::var_os("CODSH_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node"))
    }

    fn fake_agent() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-acp-agent.mjs")
    }

    fn spawn_fake(mode: &str) -> AcpClient {
        let cwd = std::env::temp_dir();
        AcpClient::spawn(SpawnSpec {
            program: node_program(),
            args: vec![fake_agent().to_string_lossy().into_owned()],
            env: vec![
                ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
                ("FAKE_ACP_MODE".into(), mode.into()),
            ],
            cwd,
            stderr_log: None,
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
}
