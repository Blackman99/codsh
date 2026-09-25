//! Headless `--output-format` for one plain prompt.
//!
//! `plain` prints the answer. `json` prints one object. `streaming-json` and
//! `streaming-messages-json` print one JSON object per line. Tool arguments,
//! tool results, and reasoning are copied from the ACP update. Usage and cost
//! are copied only from a prompt `_meta.usage` object dsh actually sent.
//! A missing ledger is `usage_absent`, never a zeroed bill.

use crate::acp::AcpEvent;
use serde_json::{Map, Value, json};
use std::io::{self, Write};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub const OUTPUT_FORMATS: &[&str] = &["plain", "json", "streaming-json", "streaming-messages-json"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputFormat {
    Plain,
    Json,
    StreamingJson,
    StreamingMessagesJson,
}

impl OutputFormat {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "plain" => Some(Self::Plain),
            "json" => Some(Self::Json),
            "streaming-json" => Some(Self::StreamingJson),
            "streaming-messages-json" => Some(Self::StreamingMessagesJson),
            _ => None,
        }
    }

    /// `--include-partial-messages` changes only the Messages stream.
    pub fn partials(self) -> bool {
        matches!(self, Self::StreamingMessagesJson)
    }
}

/// One open model response inside `streaming-messages-json`.
struct OpenResponse {
    message_id: String,
    blocks: Vec<Value>,
    /// Index of the text or thinking block still receiving chunks.
    open: Option<usize>,
    open_kind: Option<&'static str>,
}

pub struct HeadlessOutput {
    format: OutputFormat,
    include_partials: bool,
    session_id: String,
    cwd: String,
    model: String,
    permission_mode: String,
    text: String,
    thought: String,
    request_id: Option<u64>,
    stop_reason: Option<String>,
    /// Prompt `_meta.usage` when dsh sent that object. Never synthesized.
    usage: Option<Value>,
    structured_output: Option<Value>,
    structured_error: Option<String>,
    tools: Vec<String>,
    commands: Vec<String>,
    /// `streaming-json` tool call, in arrival order, by id.
    calls: Vec<ToolWire>,
    open: Option<OpenResponse>,
    /// Completed assistant frames. The last text block is `result.result`.
    assistant_frames: u64,
    init_sent: bool,
    begun: Option<Instant>,
    closed: bool,
    /// Model/tool error text. Empty when the turn itself did not fail.
    error: Option<String>,
    /// Hook stdout, stderr, and failure lines. Never copied into `text`.
    diagnostics: Vec<String>,
    /// A non-interactive permission was rejected. Not a successful edit.
    rejected: bool,
    max_turns: bool,
    partial_seq: u64,
    /// Test sink. Production writes stdout.
    capture: Option<Arc<Mutex<Vec<u8>>>>,
}

struct ToolWire {
    id: String,
    order: u64,
    result: Option<Value>,
    is_error: bool,
}

impl HeadlessOutput {
    pub fn new(
        format: OutputFormat,
        include_partials: bool,
        session_id: String,
        cwd: String,
        model: String,
        permission_mode: String,
    ) -> Self {
        Self {
            format,
            include_partials: include_partials && format.partials(),
            session_id,
            cwd,
            model,
            permission_mode,
            text: String::new(),
            thought: String::new(),
            request_id: None,
            stop_reason: None,
            usage: None,
            structured_output: None,
            structured_error: None,
            tools: Vec::new(),
            commands: Vec::new(),
            calls: Vec::new(),
            open: None,
            assistant_frames: 0,
            init_sent: false,
            begun: Some(Instant::now()),
            closed: false,
            error: None,
            diagnostics: Vec::new(),
            rejected: false,
            max_turns: false,
            partial_seq: 0,
            capture: None,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn has_tool_call(&self) -> bool {
        !self.calls.is_empty()
    }

    /// True after a non-interactive reject. The turn must not report success.
    pub fn rejected(&self) -> bool {
        self.rejected
    }

    fn emit(&mut self, value: &Value) {
        self.write_line(&value.to_string());
    }

    fn write_line(&mut self, body: &str) {
        if self.closed {
            return;
        }
        let mut line = body.to_string();
        line.push('\n');
        if let Some(capture) = &self.capture {
            if let Ok(mut sink) = capture.lock() {
                sink.extend_from_slice(line.as_bytes());
            }
            return;
        }
        if let Err(error) = io::stdout().write_all(line.as_bytes()) {
            self.closed = true;
            if error.kind() != io::ErrorKind::BrokenPipe {
                let _ = writeln!(io::stderr(), "codsh: stdout write failed: {error}");
            }
        }
    }

    fn note_session(&mut self, session_id: &str) {
        if !session_id.is_empty() && self.session_id.is_empty() {
            self.session_id = session_id.to_string();
        }
    }

    /// Copy a prompt `_meta` object. Absent usage stays absent.
    fn take_meta(&mut self, result: &Value) {
        let Some(meta) = result.get("_meta") else {
            return;
        };
        if let Some(usage) = meta.get("usage")
            && usage.is_object()
        {
            self.usage = Some(usage.clone());
        }
        if let Some(err) = meta.get("structuredOutputError").and_then(Value::as_str) {
            self.structured_error = Some(err.to_string());
        } else if let Some(value) = meta.get("structuredOutput") {
            self.structured_output = Some(value.clone());
        }
    }

    pub fn on_event(&mut self, event: &AcpEvent) {
        match event {
            AcpEvent::Thought {
                session_id, text, ..
            } => {
                self.note_session(session_id);
                if text.is_empty() {
                    return;
                }
                self.thought.push_str(text);
                match self.format {
                    OutputFormat::Plain | OutputFormat::Json => {}
                    OutputFormat::StreamingJson => {
                        self.emit(&json!({"type": "thought", "data": text}));
                    }
                    OutputFormat::StreamingMessagesJson => self.push_text("thinking", text),
                }
            }
            AcpEvent::Answer {
                session_id,
                text,
                hook,
                ..
            } => {
                self.note_session(session_id);
                if text.is_empty() {
                    return;
                }
                // Hook stdout and stderr are not the model answer.
                if *hook {
                    self.diagnostics.push(text.clone());
                    return;
                }
                self.text.push_str(text);
                match self.format {
                    OutputFormat::Plain | OutputFormat::Json => {}
                    OutputFormat::StreamingJson => {
                        self.emit(&json!({"type": "text", "data": text}));
                    }
                    OutputFormat::StreamingMessagesJson => self.push_text("text", text),
                }
            }
            AcpEvent::ToolCall {
                session_id,
                tool_call_id,
                title,
                kind,
                status,
                raw_input,
                content,
                locations,
                ..
            } => {
                self.note_session(session_id);
                let name = if title.is_empty() {
                    kind.clone()
                } else {
                    title.clone()
                };
                let order = self.calls.len() as u64;
                self.calls.push(ToolWire {
                    id: tool_call_id.clone(),
                    order,
                    result: None,
                    is_error: false,
                });
                if self.format == OutputFormat::StreamingJson {
                    let mut line = Map::new();
                    line.insert("type".into(), json!("tool_call"));
                    line.insert("toolCallId".into(), json!(tool_call_id));
                    line.insert("title".into(), json!(title));
                    if !kind.is_empty() {
                        line.insert("kind".into(), json!(kind));
                    }
                    if !status.is_empty() {
                        line.insert("status".into(), json!(status));
                    }
                    line.insert("toolName".into(), json!(name));
                    line.insert("rawInput".into(), raw_input.clone());
                    line.insert("content".into(), content.clone());
                    line.insert("locations".into(), locations.clone());
                    self.emit(&Value::Object(line));
                } else if self.format == OutputFormat::StreamingMessagesJson {
                    self.push_tool_use(tool_call_id, &name, raw_input);
                }
            }
            AcpEvent::ToolCallUpdate {
                session_id,
                tool_call_id,
                status,
                content_items,
                raw_output,
                locations,
                ..
            } => {
                self.note_session(session_id);
                if let Some(call) = self.calls.iter_mut().find(|call| call.id == *tool_call_id) {
                    call.is_error = status == "failed";
                    call.result = Some(
                        if !content_items
                            .as_array()
                            .is_some_and(|items| items.is_empty())
                        {
                            content_items.clone()
                        } else if !raw_output.is_null() {
                            raw_output.clone()
                        } else {
                            Value::Null
                        },
                    );
                }
                if self.format == OutputFormat::StreamingJson {
                    let mut line = Map::new();
                    line.insert("type".into(), json!("tool_call_update"));
                    line.insert("toolCallId".into(), json!(tool_call_id));
                    if !status.is_empty() {
                        line.insert("status".into(), json!(status));
                    }
                    line.insert("content".into(), content_items.clone());
                    line.insert("rawOutput".into(), raw_output.clone());
                    line.insert("locations".into(), locations.clone());
                    self.emit(&Value::Object(line));
                }
            }
            AcpEvent::ConfigOptions { .. } => {
                // Config option ids are not the tool list. dsh does not send
                // available_commands on this client, so tools stay empty.
            }
            AcpEvent::PromptFinished {
                request_id,
                stop_reason,
                result,
            } => {
                self.request_id = Some(*request_id);
                self.stop_reason = Some(stop_reason.clone());
                self.take_meta(result);
            }
            AcpEvent::RpcError { message, .. } => {
                if self.error.is_none() {
                    self.error = Some(message.clone());
                }
            }
            AcpEvent::PermissionRequest { .. } => {
                // No TTY can approve. Recording the request keeps a later
                // model sentence from looking like a successful tool run.
                self.rejected = true;
            }
            AcpEvent::Usage { .. }
            | AcpEvent::PermissionCancelled { .. }
            | AcpEvent::ProtocolMismatch { .. }
            | AcpEvent::Disconnected { .. } => {}
            AcpEvent::Stderr { text } => {
                if text.contains("hook") {
                    self.diagnostics.push(text.clone());
                }
            }
            // Lifecycle lines of background commands; a plain turn prints
            // only what dsh answered.
            AcpEvent::Job { .. } | AcpEvent::Schedule { .. } | AcpEvent::Goal { .. } => {}
            AcpEvent::Subagent { event } => {
                // A settled or refused child is a diagnostic line on stderr;
                // the answer stays the parent's.
                let kind = event.get("event").and_then(Value::as_str).unwrap_or("");
                if kind == "end" || kind == "refused" {
                    let field = |key: &str| {
                        event
                            .get(key)
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string()
                    };
                    self.diagnostics.push(format!(
                        "subagent {} {} ({}): {}",
                        field("type"),
                        if kind == "end" {
                            field("status")
                        } else {
                            "refused".into()
                        },
                        field("label"),
                        field("detail").lines().next().unwrap_or("")
                    ));
                }
            }
        }
    }

    pub fn mark_max_turns(&mut self) {
        self.max_turns = true;
        if self.format == OutputFormat::StreamingJson {
            self.emit(&json!({"type": "max_turns_reached"}));
        }
    }

    pub fn fail(&mut self, message: &str) {
        if self.error.is_none() {
            self.error = Some(message.to_string());
        }
    }

    fn push_text(&mut self, kind: &'static str, text: &str) {
        self.ensure_open();
        let continued = self
            .open
            .as_ref()
            .is_some_and(|open| open.open_kind == Some(kind) && open.open.is_some());
        if continued {
            let index = self.open.as_ref().and_then(|open| open.open).unwrap_or(0);
            if let Some(open) = self.open.as_mut()
                && let Some(block) = open.blocks.get_mut(index)
            {
                let slot = block
                    .get(kind)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let mut next = slot;
                next.push_str(text);
                block[kind] = json!(next);
            }
            if self.include_partials {
                self.partial_delta(index, kind, text);
            }
            return;
        }
        if self.include_partials {
            self.partial_close_block();
        }
        let block = if kind == "thinking" {
            json!({"type": "thinking", "thinking": text, "signature": ""})
        } else {
            json!({"type": "text", "text": text})
        };
        let index = {
            let Some(open) = self.open.as_mut() else {
                return;
            };
            open.blocks.push(block);
            open.open = Some(open.blocks.len() - 1);
            open.open_kind = Some(kind);
            open.blocks.len() - 1
        };
        if self.include_partials {
            self.partial_block_start(index, kind);
            self.partial_delta(index, kind, text);
        }
    }

    fn push_tool_use(&mut self, id: &str, name: &str, input: &Value) {
        self.ensure_open();
        if self.include_partials {
            self.partial_close_block();
        }
        let index = {
            let Some(open) = self.open.as_mut() else {
                return;
            };
            open.blocks.push(json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input,
            }));
            open.open = None;
            open.open_kind = None;
            open.blocks.len() - 1
        };
        if self.include_partials {
            self.emit(&json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_start",
                    "index": index,
                    "content_block": {"type": "tool_use", "id": id, "name": name, "input": {}}
                },
                "session_id": self.session_id,
            }));
            let encoded = input.to_string();
            self.emit(&json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": index,
                    "delta": {"type": "input_json_delta", "partial_json": encoded}
                },
                "session_id": self.session_id,
            }));
            self.emit(&json!({
                "type": "stream_event",
                "event": {"type": "content_block_stop", "index": index},
                "session_id": self.session_id,
            }));
        }
    }

    fn ensure_open(&mut self) {
        if self.open.is_some() {
            return;
        }
        self.partial_seq += 1;
        let message_id = format!("msg_{}", self.partial_seq - 1);
        if self.include_partials {
            self.ensure_init();
            // Usage arrives on prompt finish, after this event. Do not invent
            // a zero bill; a later message_start copies a ledger already seen.
            let mut message = json!({
                "id": message_id,
                "type": "message",
                "role": "assistant",
                "model": self.model_or_unknown(),
                "content": [],
                "stop_reason": Value::Null,
                "stop_sequence": Value::Null,
            });
            if let Some(usage) = &self.usage {
                message["usage"] = usage.clone();
            }
            self.emit(&json!({
                "type": "stream_event",
                "event": {
                    "type": "message_start",
                    "message": message,
                },
                "session_id": self.session_id,
            }));
        }
        self.open = Some(OpenResponse {
            message_id,
            blocks: Vec::new(),
            open: None,
            open_kind: None,
        });
    }

    fn partial_block_start(&mut self, index: usize, kind: &str) {
        let block = if kind == "thinking" {
            json!({"type": "thinking", "thinking": "", "signature": ""})
        } else {
            json!({"type": "text", "text": ""})
        };
        self.emit(&json!({
            "type": "stream_event",
            "event": {"type": "content_block_start", "index": index, "content_block": block},
            "session_id": self.session_id,
        }));
    }

    fn partial_delta(&mut self, index: usize, kind: &str, text: &str) {
        let delta = if kind == "thinking" {
            json!({"type": "thinking_delta", "thinking": text})
        } else {
            json!({"type": "text_delta", "text": text})
        };
        self.emit(&json!({
            "type": "stream_event",
            "event": {"type": "content_block_delta", "index": index, "delta": delta},
            "session_id": self.session_id,
        }));
    }

    fn partial_close_block(&mut self) {
        let Some(open) = self.open.as_ref() else {
            return;
        };
        let Some(index) = open.open else {
            return;
        };
        self.emit(&json!({
            "type": "stream_event",
            "event": {"type": "content_block_stop", "index": index},
            "session_id": self.session_id,
        }));
        if let Some(open) = self.open.as_mut() {
            open.open = None;
            open.open_kind = None;
        }
    }

    fn model_or_unknown(&self) -> String {
        if self.model.is_empty() {
            "unknown".to_string()
        } else {
            self.model.clone()
        }
    }

    fn duration_ms(&self) -> u64 {
        self.begun
            .map_or(0, |start| start.elapsed().as_millis() as u64)
    }

    fn ensure_init(&mut self) {
        if self.init_sent || self.format != OutputFormat::StreamingMessagesJson {
            return;
        }
        self.init_sent = true;
        self.emit(&json!({
            "type": "system",
            "subtype": "init",
            "session_id": self.session_id,
            "apiKeySource": "user",
            "model": self.model_or_unknown(),
            "cwd": self.cwd,
            "permissionMode": messages_permission_mode(&self.permission_mode),
            "tools": self.tools,
            "slash_commands": self.commands,
            "mcp_servers": [],
            "skills": [],
            "uuid": fresh_uuid(),
        }));
    }

    fn flush_open(&mut self, stop_reason: Option<&str>) {
        if self.include_partials {
            self.partial_close_block();
        }
        let Some(open) = self.open.take() else {
            return;
        };
        if open.blocks.is_empty() {
            if self.include_partials {
                self.emit_message_delta(&open.message_id, stop_reason);
            }
            return;
        }
        if self.include_partials {
            self.emit_message_delta(&open.message_id, stop_reason);
        }
        self.ensure_init();
        self.assistant_frames += 1;
        self.emit(&json!({
            "type": "assistant",
            "message": {
                "id": open.message_id,
                "type": "message",
                "role": "assistant",
                "model": self.model_or_unknown(),
                "content": open.blocks,
                "stop_reason": stop_reason,
                "stop_sequence": Value::Null,
            },
            "parent_tool_use_id": Value::Null,
            "session_id": self.session_id,
            "uuid": fresh_uuid(),
        }));
    }

    fn emit_message_delta(&mut self, _message_id: &str, stop_reason: Option<&str>) {
        self.emit(&json!({
            "type": "stream_event",
            "event": {
                "type": "message_delta",
                "delta": {"stop_reason": stop_reason, "stop_sequence": Value::Null},
            },
            "session_id": self.session_id,
        }));
        self.emit(&json!({
            "type": "stream_event",
            "event": {"type": "message_stop"},
            "session_id": self.session_id,
        }));
    }

    fn flush_tool_results(&mut self) {
        let mut pending: Vec<&ToolWire> = self
            .calls
            .iter()
            .filter(|call| call.result.is_some())
            .collect();
        pending.sort_by_key(|call| call.order);
        if pending.is_empty() {
            return;
        }
        let content: Vec<Value> = pending
            .iter()
            .map(|call| {
                json!({
                    "type": "tool_result",
                    "tool_use_id": call.id,
                    "content": call.result.clone().unwrap_or(Value::Null),
                    "is_error": call.is_error,
                })
            })
            .collect();
        self.emit(&json!({
            "type": "user",
            "message": {"role": "user", "content": content},
            "parent_tool_use_id": Value::Null,
            "session_id": self.session_id,
            "uuid": fresh_uuid(),
        }));
    }

    /// Terminal line. `failed` is a runtime error, distinct from a model stop.
    pub fn finish(&mut self, failed: bool, message: &str) {
        match self.format {
            OutputFormat::Plain => {
                for line in &self.diagnostics {
                    eprintln!("hook: {line}");
                }
                if !self.text.is_empty() {
                    let mut answer = self.text.clone();
                    if !answer.ends_with('\n') {
                        answer.push('\n');
                    }
                    let _ = io::stdout().write_all(answer.as_bytes());
                }
                let _ = io::stdout().flush();
            }
            OutputFormat::Json => {
                // A model stop such as max_tokens keeps its text and reason.
                // A runtime failure, including a rejected approval, is an
                // error object even when dsh still said end_turn.
                if self.failed_turn(failed) {
                    let mut err = json!({"type": "error", "message": message});
                    self.attach_usage(&mut err);
                    self.emit(&err);
                } else {
                    let mut body = json!({
                        "text": self.text,
                        "stopReason": self.stop_reason.clone().unwrap_or_else(|| "end_turn".into()),
                        "sessionId": self.session_id,
                        "requestId": self.request_id.map(|id| id.to_string()).unwrap_or_default(),
                    });
                    if !self.thought.is_empty() {
                        body["thought"] = json!(self.thought);
                    }
                    self.attach_usage(&mut body);
                    self.attach_structured(&mut body);
                    let rendered =
                        serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string());
                    self.write_line(&rendered);
                }
            }
            OutputFormat::StreamingJson => {
                if self.failed_turn(failed) {
                    let mut err = json!({"type": "error", "message": message});
                    self.attach_usage(&mut err);
                    self.emit(&err);
                } else {
                    let mut end = json!({
                        "type": "end",
                        "stopReason": self.stop_reason.clone().unwrap_or_else(|| "end_turn".into()),
                        "sessionId": self.session_id,
                        "requestId": self.request_id.map(|id| id.to_string()).unwrap_or_default(),
                    });
                    self.attach_usage(&mut end);
                    self.attach_structured(&mut end);
                    self.emit(&end);
                }
                let _ = io::stdout().flush();
            }
            OutputFormat::StreamingMessagesJson => {
                let stop = self.stop_reason.clone();
                let failed_turn = self.failed_turn(failed);
                let default_stop = if failed_turn { None } else { Some("end_turn") };
                self.flush_open(stop.as_deref().or(default_stop));
                self.flush_tool_results();
                self.ensure_init();
                let subtype = if self.max_turns {
                    "error_max_turns"
                } else if failed || self.rejected {
                    "error_during_execution"
                } else {
                    "success"
                };
                let mut result = json!({
                    "type": "result",
                    "subtype": subtype,
                    "is_error": failed || self.rejected || self.max_turns,
                    "duration_ms": self.duration_ms(),
                    "num_turns": self.assistant_frames,
                    "result": self.text,
                    "stop_reason": if failed_turn {
                        Value::Null
                    } else {
                        match &self.stop_reason {
                            Some(reason) => Value::String(reason.clone()),
                            None => Value::Null,
                        }
                    },
                    "session_id": self.session_id,
                    "uuid": fresh_uuid(),
                });
                if failed && !message.is_empty() {
                    result["errors"] = json!([message]);
                }
                self.attach_usage(&mut result);
                self.attach_structured(&mut result);
                self.emit(&result);
                let _ = io::stdout().flush();
            }
        }
    }

    /// Truncation, the turn cap, cancel, and refusal are model stops.
    /// They keep `stopReason`. A runtime failure does not.
    fn model_stop(&self) -> bool {
        matches!(
            self.stop_reason.as_deref(),
            Some("max_tokens" | "max_turn_requests" | "cancelled" | "refusal")
        )
    }

    /// A rejected approval is a failure even when dsh still said `end_turn`.
    /// A named model stop keeps its reason instead.
    fn failed_turn(&self, failed: bool) -> bool {
        (failed || self.rejected) && !self.model_stop()
    }

    /// Spend from dsh, or an explicit absence. Never a zero bill.
    fn attach_usage(&self, target: &mut Value) {
        let Some(object) = target.as_object_mut() else {
            return;
        };
        match &self.usage {
            Some(usage) => {
                object.insert("usage".into(), usage.clone());
            }
            None => {
                object.insert("usage_absent".into(), json!(true));
            }
        }
    }

    fn attach_structured(&self, target: &mut Value) {
        let Some(object) = target.as_object_mut() else {
            return;
        };
        if let Some(value) = &self.structured_output {
            object.insert("structuredOutput".into(), value.clone());
        }
        if let Some(err) = &self.structured_error {
            object.insert("structuredOutput".into(), Value::Null);
            object.insert("structuredOutputError".into(), json!(err));
        }
    }
}

fn messages_permission_mode(mode: &str) -> &'static str {
    match mode {
        "always-approve" | "bypassPermissions" | "dontAsk" => "bypassPermissions",
        "acceptEdits" => "acceptEdits",
        "plan" => "plan",
        _ => "default",
    }
}

fn fresh_uuid() -> String {
    let ticks = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("codsh-{ticks:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> HeadlessOutput {
        HeadlessOutput::new(
            OutputFormat::Json,
            false,
            "session-1".into(),
            "/work".into(),
            "cli-mock".into(),
            "ask".into(),
        )
    }

    #[test]
    fn missing_usage_is_absent_not_zero() {
        let mut output = sample();
        output.on_event(&AcpEvent::PromptFinished {
            request_id: 4,
            stop_reason: "end_turn".into(),
            result: json!({"stopReason": "end_turn"}),
        });
        let mut body = json!({});
        output.attach_usage(&mut body);
        assert_eq!(body["usage_absent"], json!(true));
        assert!(body.get("usage").is_none());
        assert!(body.get("total_cost_usd").is_none());
    }

    #[test]
    fn prompt_meta_usage_is_copied_verbatim() {
        let mut output = sample();
        let usage = json!({"input_tokens": 3, "output_tokens": 4});
        output.on_event(&AcpEvent::PromptFinished {
            request_id: 4,
            stop_reason: "end_turn".into(),
            result: json!({"stopReason": "end_turn", "_meta": {"usage": usage}}),
        });
        let mut body = json!({});
        output.attach_usage(&mut body);
        assert_eq!(body["usage"]["input_tokens"], json!(3));
        assert!(body.get("usage_absent").is_none());
        assert!(body.get("total_cost_usd").is_none());
    }

    fn messages(rejected: bool) -> HeadlessOutput {
        let mut output = HeadlessOutput::new(
            OutputFormat::StreamingMessagesJson,
            true,
            "session-1".into(),
            "/work".into(),
            "cli-mock".into(),
            "ask".into(),
        );
        output.rejected = rejected;
        output
    }

    fn capture(output: &mut HeadlessOutput) -> Arc<Mutex<Vec<u8>>> {
        let sink = Arc::new(Mutex::new(Vec::new()));
        output.capture = Some(Arc::clone(&sink));
        sink
    }

    fn parsed_lines(sink: &Arc<Mutex<Vec<u8>>>) -> Vec<Value> {
        let bytes = sink.lock().expect("capture").clone();
        String::from_utf8(bytes)
            .expect("utf8")
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).expect("json line"))
            .collect()
    }

    #[test]
    fn rejected_approval_is_an_error_not_end_turn() {
        let mut output = sample();
        let sink = capture(&mut output);
        output.rejected = true;
        output.on_event(&AcpEvent::Answer {
            session_id: "session-1".into(),
            message_id: "m1".into(),
            text: "I could not edit the file.".into(),
            hook: false,
        });
        output.on_event(&AcpEvent::PromptFinished {
            request_id: 4,
            stop_reason: "end_turn".into(),
            result: json!({"stopReason": "end_turn"}),
        });
        output.finish(true, "non-interactive approval rejected the tool call");
        let body = &parsed_lines(&sink)[0];
        assert_eq!(body["type"], json!("error"));
        assert!(
            body["message"]
                .as_str()
                .unwrap()
                .contains("non-interactive approval")
        );
        assert!(body.get("stopReason").is_none());
        assert!(!body.to_string().contains("end_turn"));

        let mut stream = HeadlessOutput::new(
            OutputFormat::StreamingJson,
            false,
            "session-1".into(),
            "/work".into(),
            "cli-mock".into(),
            "ask".into(),
        );
        let stream_sink = capture(&mut stream);
        stream.rejected = true;
        stream.on_event(&AcpEvent::PromptFinished {
            request_id: 4,
            stop_reason: "end_turn".into(),
            result: json!({"stopReason": "end_turn"}),
        });
        stream.finish(true, "non-interactive approval rejected the tool call");
        let events = parsed_lines(&stream_sink);
        assert_eq!(events.last().unwrap()["type"], json!("error"));
        assert!(
            events
                .iter()
                .all(|event| event.get("type") != Some(&json!("end")))
        );
        assert!(
            events
                .iter()
                .all(|event| event.get("stopReason") != Some(&json!("end_turn")))
        );

        let mut messages = messages(true);
        let message_sink = capture(&mut messages);
        messages.on_event(&AcpEvent::PromptFinished {
            request_id: 4,
            stop_reason: "end_turn".into(),
            result: json!({"stopReason": "end_turn"}),
        });
        messages.finish(true, "non-interactive approval rejected the tool call");
        let events = parsed_lines(&message_sink);
        let terminal = events.last().unwrap();
        assert_eq!(terminal["type"], json!("result"));
        assert_ne!(terminal["subtype"], json!("success"));
        assert_eq!(terminal["is_error"], json!(true));
        assert!(terminal.get("stop_reason").unwrap().is_null());
    }

    #[test]
    fn partial_message_start_omits_usage_when_absent() {
        let mut output = messages(false);
        let sink = capture(&mut output);
        output.on_event(&AcpEvent::Answer {
            session_id: "session-1".into(),
            message_id: "m1".into(),
            text: "partial".into(),
            hook: false,
        });
        let events = parsed_lines(&sink);
        let start = events
            .iter()
            .find(|event| event["event"]["type"] == "message_start")
            .expect("message_start");
        let message = &start["event"]["message"];
        assert!(message.get("usage").is_none(), "{message}");
        assert_ne!(
            message.get("usage"),
            Some(&json!({"input_tokens": 0, "output_tokens": 0}))
        );
        assert!(output.usage.is_none());
    }

    #[test]
    fn partials_apply_only_to_messages_json() {
        assert!(OutputFormat::StreamingMessagesJson.partials());
        assert!(!OutputFormat::Json.partials());
        assert!(!OutputFormat::StreamingJson.partials());
        assert_eq!(
            OutputFormat::parse("streaming-messages-json"),
            Some(OutputFormat::StreamingMessagesJson)
        );
        assert!(OutputFormat::parse("yaml").is_none());
    }
}
