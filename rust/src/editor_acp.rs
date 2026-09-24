//! Editor-facing ACP agent. dsh remains the only executor and durable writer.
//! Standard methods are forwarded. `session/load` is the editor name for dsh
//! `session/resume` plus a read-only history replay. Proprietary `x.ai/*`
//! methods and unadvertised standard methods return method-not-found.

use crate::acp::{self, AcpClient, AcpEvent, PROTOCOL_VERSION};
use crate::config::{self, EffectiveConfig};
use crate::models;
use crate::permission::{self, PermissionMode};
use crate::session_history::{self, RestoredTurn};
use crate::session_owner::SessionOwner;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

const AGENT_NAME: &str = "codsh-rust";
const READ_TIMEOUT: Duration = Duration::from_millis(50);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtensionEntry {
    pub method: String,
    pub status: &'static str,
    pub reason: &'static str,
}

pub fn extension_inventory() -> Vec<ExtensionEntry> {
    const UNSUPPORTED: &[(&str, &str)] = &[
        (
            "x.ai/session/update",
            "dsh ACP does not expose a session-update subscription",
        ),
        (
            "x.ai/session/updates",
            "dsh ACP does not expose paginated session replay",
        ),
        (
            "x.ai/session/updates/chunk",
            "dsh ACP does not expose session replay chunks",
        ),
        (
            "x.ai/models/list",
            "models are the advertised session/set_config_option model choices",
        ),
        (
            "x.ai/models/update",
            "model changes use session/set_config_option",
        ),
        (
            "x.ai/billing",
            "official subscription billing is not reproduced",
        ),
        (
            "x.ai/review/comment",
            "review upload is not a configured substitute",
        ),
        (
            "x.ai/capabilities",
            "capabilities are the initialize result, not a second method",
        ),
        (
            "session/delete",
            "dsh ACP does not advertise sessionCapabilities.delete",
        ),
        (
            "session/fork",
            "dsh ACP does not advertise sessionCapabilities.fork",
        ),
        (
            "session/set_mode",
            "permission mode is session config option permission_mode",
        ),
    ];
    let mut entries = vec![
        ExtensionEntry {
            method: "session/load".into(),
            status: "supported",
            reason: "editor load is dsh session/resume plus read-only history replay",
        },
        ExtensionEntry {
            method: "session/resume".into(),
            status: "supported",
            reason: "forwarded to dsh when sessionCapabilities.resume is advertised",
        },
        ExtensionEntry {
            method: "session/new".into(),
            status: "supported",
            reason: "forwarded to dsh",
        },
        ExtensionEntry {
            method: "session/prompt".into(),
            status: "supported",
            reason: "forwarded to dsh",
        },
        ExtensionEntry {
            method: "session/cancel".into(),
            status: "supported",
            reason: "forwarded to dsh",
        },
        ExtensionEntry {
            method: "session/set_config_option".into(),
            status: "supported",
            reason: "model and reasoning_effort go to dsh; permission_mode updates the shared policy",
        },
    ];
    for (method, reason) in UNSUPPORTED {
        entries.push(ExtensionEntry {
            method: (*method).into(),
            status: "unsupported",
            reason,
        });
    }
    entries
}

pub fn extension_supported(method: &str) -> bool {
    extension_inventory()
        .iter()
        .any(|entry| entry.method == method && entry.status == "supported")
}

struct LiveSession {
    // The lock file stays open for the life of the session.
    #[allow(dead_code)]
    owner: SessionOwner,
    mode: PermissionMode,
    mode_locked: bool,
}

struct Bridge {
    client: AcpClient,
    effective: EffectiveConfig,
    sessions: HashMap<String, LiveSession>,
    active: Option<String>,
    prompt_request: Option<u64>,
    prompt_session: Option<String>,
    prompt_text: String,
    prompt_message_id: String,
    prompt_response_id: Option<Value>,
    user_chunk_sent: bool,
    tool_titles: HashMap<String, String>,
}

pub fn serve(launch: EditorLaunch) -> io::Result<()> {
    let (tx, rx) = mpsc::channel();
    // Buffer editor lines before initialize connects to dsh. A blocking read
    // inside initialize would drop a pipelined session/new until too late.
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(Ok(None));
                    break;
                }
                Ok(_) => {
                    if tx.send(Ok(Some(line))).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = tx.send(Err(error));
                    break;
                }
            }
        }
    });
    let stdout = io::stdout();
    let mut server = EditorServer::connect(rx, stdout.lock(), launch)?;
    server.run()
}

#[derive(Clone, Debug)]
pub struct EditorLaunch {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub always_approve: bool,
    pub auto: bool,
    pub allow: Vec<String>,
    pub deny: Vec<String>,
}

struct EditorServer<W> {
    lines: Receiver<io::Result<Option<String>>>,
    output: W,
    launch: EditorLaunch,
    bridge: Option<Bridge>,
    initialized: bool,
    stdin_closed: bool,
}

impl<W: Write> EditorServer<W> {
    fn connect(
        lines: Receiver<io::Result<Option<String>>>,
        output: W,
        launch: EditorLaunch,
    ) -> io::Result<Self> {
        Ok(Self {
            lines,
            output,
            launch,
            bridge: None,
            initialized: false,
            stdin_closed: false,
        })
    }

    fn run(&mut self) -> io::Result<()> {
        loop {
            if self.stdin_closed
                && self
                    .bridge
                    .as_ref()
                    .is_none_or(|bridge| bridge.prompt_request.is_none())
            {
                break;
            }
            match self.next_line()? {
                Some(line) => self.handle_line(&line)?,
                None if self.stdin_closed
                    && self
                        .bridge
                        .as_ref()
                        .is_none_or(|bridge| bridge.prompt_request.is_none()) =>
                {
                    break;
                }
                None => {}
            }
            self.pump_bridge()?;
        }
        self.shutdown_bridge();
        Ok(())
    }

    fn next_line(&mut self) -> io::Result<Option<String>> {
        let wait = self.initialized;
        let message = if wait {
            match self.lines.recv_timeout(READ_TIMEOUT) {
                Ok(message) => message,
                Err(RecvTimeoutError::Timeout) => return Ok(None),
                Err(RecvTimeoutError::Disconnected) => {
                    self.stdin_closed = true;
                    return Ok(None);
                }
            }
        } else {
            match self.lines.recv() {
                Ok(message) => message,
                Err(_) => {
                    self.stdin_closed = true;
                    return Ok(None);
                }
            }
        };
        match message {
            Ok(None) => {
                self.stdin_closed = true;
                Ok(None)
            }
            Ok(Some(line)) => Ok(Some(line)),
            Err(error) => Err(error),
        }
    }

    fn pump_bridge(&mut self) -> io::Result<()> {
        let events = self
            .bridge
            .as_mut()
            .map(|bridge| bridge.client.pump(READ_TIMEOUT))
            .unwrap_or_default();
        let request = self
            .bridge
            .as_ref()
            .and_then(|bridge| bridge.prompt_request);
        if let Some(request) = request {
            for event in events {
                self.forward_and_maybe_finish(event, request)?;
            }
        }
        Ok(())
    }

    fn shutdown_bridge(&mut self) {
        if let Some(bridge) = self.bridge.as_mut() {
            let _ = bridge.client.close_session(Duration::from_secs(2));
            bridge.client.shutdown();
        }
    }

    fn handle_line(&mut self, line: &str) -> io::Result<()> {
        if line.trim().is_empty() {
            return Ok(());
        }
        match serde_json::from_str::<Value>(line.trim()) {
            Ok(message) => self.dispatch(message),
            Err(_) => self.write_message(&json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": -32700, "message": "Parse error" },
            })),
        }
    }

    fn dispatch(&mut self, message: Value) -> io::Result<()> {
        let id = message.get("id").cloned();
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string);
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        if method.is_none() {
            if let (Some(bridge), Some(id)) = (self.bridge.as_mut(), id.clone()) {
                bridge.client.note_permission_answered(&id);
                let forwarded = if let Some(error) = message.get("error").cloned() {
                    json!({ "jsonrpc": "2.0", "id": id, "error": error })
                } else {
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": message.get("result").cloned().unwrap_or(Value::Null),
                    })
                };
                let _ = bridge.client.write_message(forwarded);
            }
            return Ok(());
        }
        let method = method.unwrap_or_default();
        if id.is_none() {
            self.notification(&method, &params)?;
            return Ok(());
        }
        let id = id.unwrap_or(Value::Null);
        if !self.initialized && method != "initialize" {
            return self.error(&id, -32002, "initialize is required before other methods");
        }
        match method.as_str() {
            "initialize" => self.initialize(&id, &params),
            "authenticate" => self.error(
                &id,
                -32601,
                "Method not found: authenticate; this agent does not advertise auth methods",
            ),
            "session/new" => self.session_new(&id, &params),
            "session/load" => self.session_load(&id, &params),
            "session/resume" => self.session_resume(&id, &params, false),
            "session/list" => self.session_list(&id, &params),
            "session/close" => self.session_close(&id, &params),
            "session/prompt" => self.session_prompt(&id, &params),
            "session/set_config_option" => self.session_config(&id, &params),
            "session/cancel" => self.session_cancel(&id, &params),
            other if other.starts_with("x.ai/") || !extension_supported(other) => {
                let reason = extension_inventory()
                    .into_iter()
                    .find(|entry| entry.method == other)
                    .map(|entry| entry.reason.to_string())
                    .unwrap_or_else(|| "not advertised by dsh ACP".into());
                self.error(&id, -32601, &format!("Method not found: {other}; {reason}"))
            }
            other => self.error(&id, -32601, &format!("Method not found: {other}")),
        }
    }

    fn notification(&mut self, method: &str, params: &Value) -> io::Result<()> {
        if method == "session/cancel"
            && let Some(bridge) = self.bridge.as_mut()
        {
            let _ = bridge.cancel(params);
        }
        Ok(())
    }

    fn initialize(&mut self, id: &Value, _params: &Value) -> io::Result<()> {
        if self.bridge.is_none() {
            match Bridge::connect(&self.launch) {
                Ok(bridge) => self.bridge = Some(bridge),
                Err(error) => {
                    return self.error(
                        id,
                        -32603,
                        &format!("Execution unavailable: dsh ACP did not connect: {error}"),
                    );
                }
            }
        }
        let Some(bridge) = self.bridge.as_ref() else {
            return self.error(id, -32603, "Execution unavailable: dsh ACP did not connect");
        };
        self.initialized = true;
        let mut extensions = Map::new();
        for entry in extension_inventory() {
            extensions.insert(
                entry.method,
                json!({ "status": entry.status, "reason": entry.reason }),
            );
        }
        self.result(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "agentInfo": { "name": AGENT_NAME, "version": env!("CARGO_PKG_VERSION") },
                "agentCapabilities": {
                    "loadSession": true,
                    "promptCapabilities": {
                        "image": false,
                        "audio": false,
                        "embeddedContext": false
                    },
                    "mcpCapabilities": { "http": false },
                    "sessionCapabilities": {
                        "list": {},
                        "resume": {},
                        "close": {}
                    },
                    "_meta": {
                        "codsh/extensions": extensions,
                        "codsh/upstream": {
                            "agent": "dsh",
                            "protocolVersion": PROTOCOL_VERSION,
                            "loadSession": false,
                            "sessionCapabilities": {
                                "list": bridge.client.can_list,
                                "resume": bridge.client.can_resume,
                                "close": true
                            }
                        }
                    }
                },
                "authMethods": []
            }),
        )
    }

    fn session_new(&mut self, id: &Value, params: &Value) -> io::Result<()> {
        let Some(cwd) = absolute_cwd(params) else {
            return self.error(id, -32602, "cwd must be an absolute path");
        };
        let Some(bridge) = self.bridge.as_mut() else {
            return self.error(id, -32603, "Execution unavailable: dsh ACP did not connect");
        };
        if let Err(error) = bridge.release_active() {
            return self.error(id, -32603, &error);
        }
        match bridge.client.new_session(Path::new(&cwd), REQUEST_TIMEOUT) {
            Ok(session_id) => match bridge.hold(&session_id, &cwd, false) {
                Ok(()) => {
                    // The spawn patch already carries a saved advertised route.
                    // Apply it on this session so the returned options match
                    // a later load. set_config_option needs the session id.
                    if let Err(error) =
                        crate::apply_live_selection(&mut bridge.client, &bridge.effective)
                    {
                        bridge.release_held(&session_id);
                        return self.error(id, -32603, &error);
                    }
                    let options = bridge.public_options();
                    self.result(
                        id,
                        json!({ "sessionId": session_id, "configOptions": options }),
                    )
                }
                Err(error) => {
                    let _ = bridge.client.close_session(REQUEST_TIMEOUT);
                    self.error(id, -32603, &error)
                }
            },
            Err(error) => self.error(id, -32603, &error.message),
        }
    }

    fn session_load(&mut self, id: &Value, params: &Value) -> io::Result<()> {
        self.session_resume(id, params, true)
    }

    fn session_resume(&mut self, id: &Value, params: &Value, replay: bool) -> io::Result<()> {
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return self.error(id, -32602, "sessionId is required");
        };
        let Some(cwd) = absolute_cwd(params) else {
            return self.error(id, -32602, "cwd must be an absolute path");
        };
        let Some(bridge) = self.bridge.as_mut() else {
            return self.error(id, -32603, "Execution unavailable: dsh ACP did not connect");
        };
        if bridge.sessions.contains_key(session_id) {
            return self.error(
                id,
                -32602,
                &format!("session is already active: {session_id}"),
            );
        }
        if !bridge.client.can_resume {
            return self.error(
                id,
                -32601,
                "Method not found: dsh did not advertise session/resume",
            );
        }
        let history = session_history::load_session(&bridge.effective.dsh_home, session_id);
        if let Err(error) = &history {
            return self.error(id, -32602, &error.message);
        }
        if let Err(error) = bridge.release_active() {
            return self.error(id, -32603, &error);
        }
        // The mode file is known before resume. Replace the child so it starts
        // with that policy instead of the mode from the previous session.
        if let Err(error) = bridge.relaunch_for_session(session_id) {
            return self.error(id, -32603, &error);
        }
        // Take the write owner before dsh attaches. A live terminal or editor
        // already holds this lock; dsh would otherwise answer with a generic
        // internal error and a second executor.
        if let Err(error) = bridge.hold(session_id, &cwd, true) {
            return self.error(id, -32602, &error);
        }
        match bridge
            .client
            .resume_session(session_id, Path::new(&cwd), REQUEST_TIMEOUT)
        {
            Ok(_) => {
                // Same advertised-value apply the terminal uses on resume.
                // The selection file can change after this process connected.
                bridge.effective.refresh_saved_selection();
                if let Err(error) =
                    crate::apply_live_selection(&mut bridge.client, &bridge.effective)
                {
                    bridge.release_held(session_id);
                    return self.error(id, -32603, &error);
                }
                let turns = if replay {
                    history
                        .unwrap_or_else(|_| session_history::RestoredSession {
                            turns: Vec::new(),
                            compaction: Vec::new(),
                            breakdown: None,
                        })
                        .turns
                } else {
                    Vec::new()
                };
                let options = bridge.public_options();
                let session_id = session_id.to_string();
                let _ = bridge;
                if replay {
                    self.replay(&session_id, &turns)?;
                }
                self.result(id, json!({ "configOptions": options }))
            }
            Err(error) => {
                bridge.release_held(session_id);
                self.error(id, -32602, &error.message)
            }
        }
    }

    fn replay(&mut self, session_id: &str, turns: &[RestoredTurn]) -> io::Result<()> {
        for (index, turn) in turns.iter().enumerate() {
            let message_id = format!("restored-{index}");
            if !turn.user.is_empty() {
                self.notify(json!({
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "user_message_chunk",
                        "messageId": message_id,
                        "content": { "type": "text", "text": turn.user }
                    }
                }))?;
            }
            if !turn.thought.is_empty() {
                self.notify(json!({
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "agent_thought_chunk",
                        "messageId": message_id,
                        "content": { "type": "text", "text": turn.thought }
                    }
                }))?;
            }
            if !turn.answer.is_empty() {
                self.notify(json!({
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "messageId": message_id,
                        "content": { "type": "text", "text": turn.answer }
                    }
                }))?;
            }
            for tool in &turn.tools {
                self.notify(json!({
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": tool.id,
                        "title": tool.title,
                        "status": replay_tool_status(&tool.status),
                        "kind": "other",
                        "content": tool_content(&tool.result, &tool.diff)
                    }
                }))?;
            }
        }
        Ok(())
    }

    fn session_list(&mut self, id: &Value, params: &Value) -> io::Result<()> {
        let Some(bridge) = self.bridge.as_mut() else {
            return self.error(id, -32603, "Execution unavailable: dsh ACP did not connect");
        };
        if !bridge.client.can_list {
            return self.error(
                id,
                -32601,
                "Method not found: dsh did not advertise session/list",
            );
        }
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        match bridge.client.list_sessions(&cwd, REQUEST_TIMEOUT) {
            Ok(sessions) => {
                let sessions = sessions
                    .into_iter()
                    .map(|(session_id, cwd)| json!({ "sessionId": session_id, "cwd": cwd }))
                    .collect::<Vec<_>>();
                self.result(id, json!({ "sessions": sessions }))
            }
            Err(error) => self.error(id, -32603, &error.message),
        }
    }

    fn session_close(&mut self, id: &Value, params: &Value) -> io::Result<()> {
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return self.error(id, -32602, "sessionId is required");
        };
        let Some(bridge) = self.bridge.as_mut() else {
            return self.error(id, -32603, "Execution unavailable: dsh ACP did not connect");
        };
        if bridge.active.as_deref() != Some(session_id) {
            return self.error(id, -32602, &format!("unknown session: {session_id}"));
        }
        match bridge.client.close_session(REQUEST_TIMEOUT) {
            Ok(()) => {
                bridge.sessions.remove(session_id);
                bridge.active = None;
                self.result(id, json!({}))
            }
            Err(error) => self.error(id, -32603, &error.message),
        }
    }

    fn session_prompt(&mut self, id: &Value, params: &Value) -> io::Result<()> {
        let Some(session_id) = params
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return self.error(id, -32602, "sessionId is required");
        };
        let Some(bridge) = self.bridge.as_mut() else {
            return self.error(id, -32603, "Execution unavailable: dsh ACP did not connect");
        };
        if bridge.active.as_deref() != Some(session_id.as_str()) {
            return self.error(id, -32602, &format!("unknown session: {session_id}"));
        }
        if bridge.prompt_request.is_some() {
            return self.error(id, -32603, "a prompt is already in flight");
        }
        let text = prompt_text(params);
        if text.trim().is_empty() {
            return self.error(id, -32602, "prompt text is required");
        }
        let request = match bridge.client.submit_prompt(&text) {
            Ok(request) => request,
            Err(error) => return self.error(id, -32603, &error.message),
        };
        bridge.prompt_request = Some(request);
        bridge.prompt_session = Some(session_id);
        bridge.prompt_text = text;
        bridge.prompt_message_id = format!("editor-{request}");
        bridge.user_chunk_sent = false;
        bridge.prompt_response_id = Some(id.clone());
        Ok(())
    }

    fn forward_and_maybe_finish(&mut self, event: AcpEvent, request: u64) -> io::Result<()> {
        let response_id = self
            .bridge
            .as_ref()
            .and_then(|bridge| bridge.prompt_response_id.clone());
        match self.forward_event(event, request) {
            Ok(Some(stop_reason)) => {
                if let Some(bridge) = self.bridge.as_mut() {
                    bridge.prompt_request = None;
                    bridge.prompt_session = None;
                    bridge.prompt_text.clear();
                    bridge.prompt_response_id = None;
                }
                if let Some(id) = response_id {
                    self.result(&id, json!({ "stopReason": stop_reason }))?;
                }
                Ok(())
            }
            Ok(None) => Ok(()),
            Err(error) => {
                if let Some(bridge) = self.bridge.as_mut() {
                    bridge.prompt_request = None;
                    bridge.prompt_session = None;
                    bridge.prompt_text.clear();
                    bridge.prompt_response_id = None;
                }
                if let Some(id) = response_id {
                    self.error(&id, -32603, &error.to_string())
                } else {
                    Err(error)
                }
            }
        }
    }

    fn forward_event(&mut self, event: AcpEvent, request: u64) -> io::Result<Option<String>> {
        let session = self
            .bridge
            .as_ref()
            .and_then(|bridge| bridge.prompt_session.clone())
            .unwrap_or_default();
        let message_id = self
            .bridge
            .as_ref()
            .map(|bridge| bridge.prompt_message_id.clone())
            .unwrap_or_default();
        match event {
            AcpEvent::Thought {
                text,
                message_id: dsh_id,
                session_id,
                ..
            } => {
                self.emit_user_chunk()?;
                self.notify(json!({
                    "sessionId": session_id_or(&session_id, &session),
                    "update": {
                        "sessionUpdate": "agent_thought_chunk",
                        "messageId": id_or(&dsh_id, &message_id),
                        "content": { "type": "text", "text": text }
                    }
                }))?;
            }
            AcpEvent::Answer {
                text,
                message_id: dsh_id,
                session_id,
                ..
            } => {
                self.emit_user_chunk()?;
                self.notify(json!({
                    "sessionId": session_id_or(&session_id, &session),
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "messageId": id_or(&dsh_id, &message_id),
                        "content": { "type": "text", "text": text }
                    }
                }))?;
            }
            AcpEvent::ToolCall {
                session_id,
                tool_call_id,
                title,
                kind,
                status,
                raw_input,
                content,
                diff,
                ..
            } => {
                self.emit_user_chunk()?;
                if let Some(bridge) = self.bridge.as_mut() {
                    bridge
                        .tool_titles
                        .insert(tool_call_id.clone(), title.clone());
                }
                let body = if content.as_array().is_some_and(|items| !items.is_empty()) {
                    content
                } else {
                    json!(tool_content("", &diff))
                };
                self.notify(json!({
                    "sessionId": session_id_or(&session_id, &session),
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": tool_call_id,
                        "title": title,
                        "kind": kind,
                        "status": status,
                        "rawInput": raw_input,
                        "content": body
                    }
                }))?;
            }
            AcpEvent::ToolCallUpdate {
                session_id,
                tool_call_id,
                status,
                content,
                content_items,
                ..
            } => {
                let body = if content_items
                    .as_array()
                    .is_some_and(|items| !items.is_empty())
                {
                    content_items
                } else {
                    json!([{ "type": "content", "content": { "type": "text", "text": content } }])
                };
                self.notify(json!({
                    "sessionId": session_id_or(&session_id, &session),
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": tool_call_id,
                        "status": status,
                        "content": body
                    }
                }))?;
            }
            AcpEvent::PermissionRequest {
                request_id,
                session_id,
                tool_call_id,
                options,
            } => {
                self.notify(json!({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "session/request_permission",
                    "params": {
                        "sessionId": session_id_or(&session_id, &session),
                        "toolCall": { "toolCallId": tool_call_id },
                        "options": options.iter().map(|option| json!({
                            "optionId": option.option_id,
                            "name": option.name,
                            "kind": option.kind
                        })).collect::<Vec<_>>()
                    }
                }))?;
            }
            AcpEvent::Usage { used, size, cost } => {
                let mut update = Map::new();
                update.insert("sessionUpdate".into(), json!("usage_update"));
                if let Some(used) = used {
                    update.insert("used".into(), json!(used));
                }
                if let Some(size) = size {
                    update.insert("size".into(), json!(size));
                }
                if let Some(cost) = cost.filter(|value| !value.is_empty()) {
                    update.insert("cost".into(), json!({ "amount": cost }));
                }
                self.notify(json!({ "sessionId": session, "update": Value::Object(update) }))?;
            }
            AcpEvent::PromptFinished {
                request_id,
                stop_reason,
                ..
            } if request_id == request => {
                return Ok(Some(stop_reason));
            }
            AcpEvent::RpcError {
                request_id: Some(request_id),
                message,
                ..
            } if request_id == request => {
                return Err(io::Error::other(message));
            }
            AcpEvent::Disconnected { detail } => {
                return Err(io::Error::other(detail));
            }
            _ => {}
        }
        Ok(None)
    }

    fn emit_user_chunk(&mut self) -> io::Result<()> {
        let Some(bridge) = self.bridge.as_mut() else {
            return Ok(());
        };
        if bridge.user_chunk_sent || bridge.prompt_text.is_empty() {
            return Ok(());
        }
        bridge.user_chunk_sent = true;
        let session = bridge.prompt_session.clone().unwrap_or_default();
        let message_id = bridge.prompt_message_id.clone();
        let text = bridge.prompt_text.clone();
        self.notify(json!({
            "sessionId": session,
            "update": {
                "sessionUpdate": "user_message_chunk",
                "messageId": message_id,
                "content": { "type": "text", "text": text }
            }
        }))
    }

    fn session_config(&mut self, id: &Value, params: &Value) -> io::Result<()> {
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return self.error(id, -32602, "sessionId is required");
        };
        let Some(config_id) = params.get("configId").and_then(Value::as_str) else {
            return self.error(id, -32602, "configId is required");
        };
        let Some(value) = params.get("value").and_then(Value::as_str) else {
            return self.error(id, -32602, "value must be a string");
        };
        let Some(bridge) = self.bridge.as_mut() else {
            return self.error(id, -32603, "Execution unavailable: dsh ACP did not connect");
        };
        if bridge.active.as_deref() != Some(session_id) {
            return self.error(id, -32602, &format!("unknown session: {session_id}"));
        }
        if config_id == "permission_mode" {
            return match bridge.set_permission_mode(value) {
                Ok(options) => self.result(id, json!({ "configOptions": options })),
                Err(error) => self.error(id, -32602, &error),
            };
        }
        match bridge
            .client
            .set_config_option(config_id, value, REQUEST_TIMEOUT)
        {
            Ok(_) => {
                // Persist and reattach before answering. A later prompt must
                // not be what first writes the shared selection file.
                if let Err(error) = bridge.persist_advertised_selection() {
                    return self.error(id, -32603, &error);
                }
                let options = bridge.public_options();
                self.result(id, json!({ "configOptions": options }))
            }
            Err(error) => self.error(id, -32602, &error.message),
        }
    }

    fn session_cancel(&mut self, id: &Value, params: &Value) -> io::Result<()> {
        let Some(bridge) = self.bridge.as_mut() else {
            return self.error(id, -32603, "Execution unavailable: dsh ACP did not connect");
        };
        match bridge.cancel(params) {
            Ok(()) => self.result(id, json!({})),
            Err(error) => self.error(id, -32602, &error),
        }
    }

    fn notify(&mut self, params: Value) -> io::Result<()> {
        let message = if params.get("method").is_some() {
            params
        } else {
            json!({ "jsonrpc": "2.0", "method": "session/update", "params": params })
        };
        self.write_message(&message)
    }

    fn result(&mut self, id: &Value, result: Value) -> io::Result<()> {
        self.write_message(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }

    fn error(&mut self, id: &Value, code: i64, message: &str) -> io::Result<()> {
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        }))
    }

    fn write_message(&mut self, value: &Value) -> io::Result<()> {
        writeln!(self.output, "{value}")?;
        self.output.flush()
    }
}

impl Bridge {
    fn connect(launch: &EditorLaunch) -> Result<Self, String> {
        let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
        let input = config::LoadInput {
            home: PathBuf::from(std::env::var_os("HOME").unwrap_or_default()),
            dsh_home: PathBuf::from(std::env::var_os("DSH_HOME").unwrap_or_default()),
            cwd: cwd.clone(),
            grok_home: std::env::var_os("GROK_HOME").map(PathBuf::from),
            env: std::env::vars().collect(),
            cli_model: launch.model.clone(),
            cli_effort: launch.effort.clone(),
            cli_trust: false,
            cli_revoke_trust: false,
            cli_trust_path: None,
            interactive: false,
            cli_permission_mode: launch.permission_mode.clone(),
            cli_always_approve: launch.always_approve,
            cli_auto: launch.auto,
            cli_allow: launch.allow.clone(),
            cli_deny: launch.deny.clone(),
            cli_no_memory: false,
            cli_sandbox: None,
            cli_disable_web_search: false,
        };
        if input.dsh_home.as_os_str().is_empty() {
            return Err("missing isolated DSH_HOME; use codsh --rust agent stdio".into());
        }
        let mut effective = config::load_from(input.clone());
        effective.permission.interactive = false;
        // Same spawn patch as the terminal: compaction, pruner, trust gate,
        // and a saved advertised route that is not a catalog id. apply_to_dsh
        // writes the policy before the child exists. A later session/load
        // replaces the child once the session mode file is known.
        let applied =
            config::apply_to_dsh(&effective, &input.env).map_err(|error| error.to_string())?;
        let mut extra = config::credential_env(&effective, &input.env);
        extra.extend(config::permission_env(&effective));
        extra.extend(config::compact_env(&effective));
        extra.extend(config::web_env(&effective));
        if !extra
            .iter()
            .any(|(key, _)| key == "CODSH_PERMISSION_POLICY")
        {
            extra.push((
                "CODSH_PERMISSION_POLICY".into(),
                effective
                    .dsh_home
                    .join(permission::POLICY_FILE_NAME)
                    .display()
                    .to_string(),
            ));
        }
        let spec = acp::dsh_spawn_spec(cwd, &effective.dsh_home, &extra, applied)
            .map_err(|error| error.message)?;
        let mut client = AcpClient::spawn(spec).map_err(|error| error.to_string())?;
        client
            .initialize(REQUEST_TIMEOUT)
            .map_err(|error| error.message)?;
        Ok(Self {
            client,
            effective,
            sessions: HashMap::new(),
            active: None,
            prompt_request: None,
            prompt_session: None,
            prompt_text: String::new(),
            prompt_message_id: String::new(),
            prompt_response_id: None,
            user_chunk_sent: false,
            tool_titles: HashMap::new(),
        })
    }

    fn relaunch_for_session(&mut self, session_id: &str) -> Result<(), String> {
        crate::apply_saved_session_mode(&mut self.effective, Some(session_id))?;
        let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
        let env = std::env::vars().collect();
        let applied =
            config::apply_to_dsh(&self.effective, &env).map_err(|error| error.to_string())?;
        let mut extra = config::credential_env(&self.effective, &env);
        extra.extend(config::permission_env(&self.effective));
        extra.extend(config::compact_env(&self.effective));
        extra.extend(config::web_env(&self.effective));
        let spec = acp::dsh_spawn_spec(cwd, &self.effective.dsh_home, &extra, applied)
            .map_err(|error| error.message)?;
        self.client.shutdown();
        let mut client = AcpClient::spawn(spec).map_err(|error| error.to_string())?;
        client
            .initialize(REQUEST_TIMEOUT)
            .map_err(|error| error.message)?;
        self.client = client;
        Ok(())
    }

    fn hold(&mut self, session_id: &str, cwd: &str, resumed: bool) -> Result<(), String> {
        let _ = resumed;
        let owner = SessionOwner::acquire(&self.effective.dsh_home, session_id)
            .map_err(|error| error.message)?;
        let _ = crate::session_owner::write_last_session(
            &self.effective.dsh_home,
            session_id,
            Path::new(cwd),
        );
        self.sessions.insert(
            session_id.to_string(),
            LiveSession {
                owner,
                mode: self.effective.permission.mode,
                mode_locked: self.effective.permission.always_approve_locked,
            },
        );
        self.active = Some(session_id.to_string());
        Ok(())
    }

    fn release_held(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
        if self.active.as_deref() == Some(session_id) {
            self.active = None;
        }
        let _ = self.client.close_session(REQUEST_TIMEOUT);
    }

    fn release_active(&mut self) -> Result<(), String> {
        if self.prompt_request.is_some() {
            return Err("a prompt is already in flight".into());
        }
        if self.active.is_some() {
            self.client
                .close_session(REQUEST_TIMEOUT)
                .map_err(|error| error.message)?;
            if let Some(id) = self.active.take() {
                self.sessions.remove(&id);
            }
        }
        Ok(())
    }

    fn public_options(&self) -> Vec<Value> {
        let mut options = Vec::new();
        for option in &self.client.config_options {
            options.push(json!({
                "id": option.id,
                "name": option.name,
                "category": if option.id == "model" { "model" } else { "thought_level" },
                "type": "select",
                "currentValue": option.current,
                "options": option.choices.iter().map(|choice| json!({
                    "value": choice.value,
                    "name": choice.name
                })).collect::<Vec<_>>()
            }));
        }
        let mode = self
            .active
            .as_ref()
            .and_then(|id| self.sessions.get(id))
            .map(|session| session.mode)
            .unwrap_or(self.effective.permission.mode);
        let mode_choices = ["ask", "auto", "always-approve", "dontAsk", "acceptEdits"]
            .into_iter()
            .map(|value| json!({ "value": value, "name": value }))
            .collect::<Vec<_>>();
        options.push(json!({
            "id": "permission_mode",
            "name": "Permission mode",
            "category": "mode",
            "type": "select",
            "currentValue": mode.as_str(),
            "options": mode_choices
        }));
        options
    }

    fn set_permission_mode(&mut self, value: &str) -> Result<Vec<Value>, String> {
        let mode = PermissionMode::parse(value)?;
        let session_id = self
            .active
            .clone()
            .ok_or_else(|| "ACP session is not ready".to_string())?;
        let session = self
            .sessions
            .get_mut(&session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;
        if mode == PermissionMode::AlwaysApprove && session.mode_locked {
            return Err(self
                .effective
                .permission
                .lock_source
                .clone()
                .unwrap_or_else(|| "always-approve is locked".into()));
        }
        session.mode = mode;
        self.effective.permission.mode = mode;
        self.effective.permission.mode_source = "session".into();
        permission::write_policy_file(&self.effective.dsh_home, &self.effective.permission)
            .map_err(|error| error.to_string())?;
        crate::session_owner::write_session_mode(
            &self.effective.dsh_home,
            &session_id,
            mode.as_str(),
        )
        .map_err(|error| error.to_string())?;
        Ok(self.public_options())
    }

    /// Write the advertised route to the same selection file the terminal
    /// saves in `apply_catalog_choice` and reapplies after resume.
    fn persist_advertised_selection(&mut self) -> Result<(), String> {
        let model_value = self
            .client
            .config_option("model")
            .and_then(|option| option.current.clone());
        let Some(model_value) = model_value else {
            return Ok(());
        };
        let catalog = self.effective.catalog();
        let choice = catalog
            .iter()
            .find(|choice| choice.acp_value == model_value);
        let model_id = choice
            .map(|choice| choice.id.clone())
            .or_else(|| models::parse_acp_model_value(&model_value).map(|(_, model)| model))
            .unwrap_or_else(|| model_value.clone());
        let effort = self
            .client
            .config_option("reasoning_effort")
            .and_then(|option| option.current.clone())
            .filter(|value| !value.is_empty());
        if choice.is_some() {
            self.effective.default_model = Some(model_id.clone());
            self.effective.unmatched_saved_model = None;
        } else {
            // Not a catalog id. Keep the catalog default out of the live route.
            self.effective.unmatched_saved_model = Some(model_id.clone());
        }
        self.effective.saved_acp_value = Some(model_value.clone());
        self.effective.default_effort = effort.clone();
        models::save_selection_route(
            &self.effective.grok_home,
            &model_id,
            effort.as_deref(),
            Some(model_value.as_str()),
        )
        .map_err(|error| error.to_string())
    }

    fn cancel(&mut self, params: &Value) -> Result<(), String> {
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("");
        if self.active.as_deref() != Some(session_id) {
            return Err(format!("unknown session: {session_id}"));
        }
        self.client.cancel_prompt().map_err(|error| error.message)
    }
}

fn absolute_cwd(params: &Value) -> Option<String> {
    let cwd = params.get("cwd").and_then(Value::as_str)?;
    let path = Path::new(cwd);
    if !path.is_absolute() {
        return None;
    }
    Some(
        path.canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .into_owned(),
    )
}

fn prompt_text(params: &Value) -> String {
    params
        .get("prompt")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

fn replay_tool_status(status: &str) -> &str {
    match status {
        "pending" | "in_progress" => "unknown",
        other => other,
    }
}

fn tool_content(result: &str, diff: &str) -> Vec<Value> {
    let mut content = Vec::new();
    if !diff.is_empty() {
        content.push(json!({ "type": "diff", "path": "", "oldText": "", "newText": diff }));
    }
    if !result.is_empty() {
        content.push(json!({
            "type": "content",
            "content": { "type": "text", "text": result }
        }));
    }
    content
}

fn session_id_or<'a>(reported: &'a str, fallback: &'a str) -> &'a str {
    if reported.is_empty() {
        fallback
    } else {
        reported
    }
}

fn id_or<'a>(reported: &'a str, fallback: &'a str) -> &'a str {
    if reported.is_empty() {
        fallback
    } else {
        reported
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_extensions_are_not_marked_supported() {
        let inventory = extension_inventory();
        for method in [
            "x.ai/session/update",
            "x.ai/session/updates",
            "x.ai/session/updates/chunk",
            "x.ai/billing",
            "x.ai/review/comment",
            "session/delete",
            "session/fork",
            "session/set_mode",
        ] {
            let entry = inventory
                .iter()
                .find(|entry| entry.method == method)
                .unwrap();
            assert_eq!(entry.status, "unsupported", "{method}");
            assert!(!extension_supported(method));
        }
        assert!(extension_supported("session/load"));
        assert!(extension_supported("session/prompt"));
    }
}
