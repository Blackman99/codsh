//! The rendezvous between MCP proxies and the surface codsh shows.
//!
//! dsh speaks MCP to each server through a codsh proxy
//! (`__mcp-stdio-proxy`, `__mcp-remote-proxy`), and dsh itself has no
//! elicitation, resource, or prompt support. The proxy handles those parts
//! of the protocol and meets the front (TUI or editor hub) through files in
//! `<runDir>/bridge/` (owner-only directory, owner-only files written
//! through a rename):
//!
//! - `surface`: present while a surface can answer elicitations. Without
//!   it the proxy does not advertise the elicitation capability and
//!   declines any `elicitation/create`, as the reference does with no
//!   bridge.
//! - `e-<id>.req.json` / `e-<id>.ans.json`: one elicitation and its
//!   answer. The proxy deletes the request when the server or dsh cancels,
//!   which withdraws the card; `e-<id>.done` marks a URL elicitation the
//!   server reported complete.
//! - `c-<mount>-<server>-<n>.req.json` / `.res.json`: a front request for
//!   `resources/*` or `prompts/*` (never `tools/call`: tool calls only go
//!   through dsh and its permission gate).
//! - `<runDir>/mounts/<nonce>`: the ACP session a proxy instance belongs
//!   to (its `--mount` argument), for `{{session_id}}` headers and for
//!   routing an elicitation to its session.

use crate::elicit_form;
use crate::mcp_auth::write_private;
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const CONTROL_METHODS: &[&str] = &[
    "resources/list",
    "resources/templates/list",
    "resources/read",
    "prompts/list",
    "prompts/get",
];

const POLL: Duration = Duration::from_millis(40);

pub fn bridge_dir(run_dir: &Path) -> PathBuf {
    run_dir.join("bridge")
}

/// Create `path` (and parents) and make it owner-only.
pub fn ensure_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// File-name-safe form of a server name.
pub fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn next_seq() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

fn read_json(path: &Path) -> Option<JsonValue> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

// ---------------------------------------------------------------------------
// Surface marker and mounts
// ---------------------------------------------------------------------------

/// Mark the run as having a surface that answers elicitations. Call it
/// before dsh starts the servers: the proxies read it at `initialize`.
pub fn announce_surface(run_dir: &Path, kind: &str) -> io::Result<()> {
    let dir = bridge_dir(run_dir);
    ensure_private_dir(&dir)?;
    write_private(
        &dir.join("surface"),
        format!("{kind} {}\n", std::process::id()).as_bytes(),
    )
}

pub fn surface_present(run_dir: &Path) -> bool {
    bridge_dir(run_dir).join("surface").is_file()
}

/// A fresh mount nonce for one proxied server start.
pub fn new_mount() -> String {
    crate::mcp_auth::random_bytes(12)
        .map(|bytes| bytes.iter().map(|b| format!("{b:02x}")).collect())
        .unwrap_or_else(|_| format!("{}{}", std::process::id(), next_seq()))
}

/// Record the ACP session a mount nonce belongs to.
pub fn record_mount(run_dir: &Path, nonce: &str, session_id: &str) {
    let dir = run_dir.join("mounts");
    if ensure_private_dir(&dir).is_ok() {
        let _ = write_private(&dir.join(sanitize(nonce)), session_id.as_bytes());
    }
}

pub fn mount_session(run_dir: &Path, nonce: &str) -> Option<String> {
    fs::read_to_string(run_dir.join("mounts").join(sanitize(nonce)))
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

// ---------------------------------------------------------------------------
// Front side
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ElicitFile {
    pub id: String,
    pub server: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mount: Option<String>,
    pub params: JsonValue,
}

/// One elicitation waiting for the user.
#[derive(Clone, Debug, PartialEq)]
pub struct Elicitation {
    pub id: String,
    pub run_dir: PathBuf,
    pub server: String,
    pub session_id: Option<String>,
    pub request: elicit_form::Request,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SurfaceEvent {
    Opened(Elicitation),
    /// The request went away unanswered (cancelled, or the server stopped).
    Withdrawn(String),
    /// The server reported a URL elicitation complete.
    Completed(String),
}

/// Watches the bridge directories of the runs a surface owns.
#[derive(Debug, Default)]
pub struct SurfaceWatch {
    runs: Vec<PathBuf>,
    open: HashMap<String, PathBuf>,
    answered: HashSet<String>,
}

impl SurfaceWatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start watching `run_dir` and announce the surface there.
    pub fn watch(&mut self, run_dir: &Path, kind: &str) {
        if !self.runs.iter().any(|known| known == run_dir) {
            let _ = announce_surface(run_dir, kind);
            self.runs.push(run_dir.to_path_buf());
        }
    }

    /// Stop watching runs outside `keep` (their dsh went away).
    pub fn retain_runs(&mut self, keep: &[PathBuf]) {
        self.runs.retain(|run| keep.contains(run));
        let runs = &self.runs;
        self.open.retain(|_, run| runs.contains(run));
    }

    pub fn poll(&mut self) -> Vec<SurfaceEvent> {
        let mut events = Vec::new();
        let mut present = HashSet::new();
        let mut refused = Vec::new();
        for run in &self.runs {
            let dir = bridge_dir(run);
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            let mut names: Vec<String> = entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            for name in names {
                if let Some(id) = name
                    .strip_prefix("e-")
                    .and_then(|rest| rest.strip_suffix(".req.json"))
                {
                    present.insert(id.to_string());
                    if self.open.contains_key(id) || self.answered.contains(id) {
                        continue;
                    }
                    let Some(file) = read_json(&dir.join(&name))
                        .and_then(|value| serde_json::from_value::<ElicitFile>(value).ok())
                    else {
                        continue;
                    };
                    self.open.insert(id.to_string(), run.clone());
                    match elicit_form::check_request(&file.params) {
                        Ok(request) => events.push(SurfaceEvent::Opened(Elicitation {
                            id: id.to_string(),
                            run_dir: run.clone(),
                            server: file.server.clone(),
                            session_id: file
                                .mount
                                .as_deref()
                                .and_then(|mount| mount_session(run, mount)),
                            request,
                        })),
                        Err(_) => refused.push(id.to_string()),
                    }
                } else if let Some(id) = name
                    .strip_prefix("e-")
                    .and_then(|rest| rest.strip_suffix(".done"))
                {
                    let _ = fs::remove_file(dir.join(&name));
                    events.push(SurfaceEvent::Completed(id.to_string()));
                }
            }
        }
        for id in refused {
            let _ = self.answer(&id, &json!({"action": "decline"}));
        }
        let gone: Vec<String> = self
            .open
            .keys()
            .filter(|id| !present.contains(*id))
            .cloned()
            .collect();
        for id in gone {
            self.open.remove(&id);
            if !self.answered.remove(&id) {
                events.push(SurfaceEvent::Withdrawn(id));
            }
        }
        self.answered.retain(|id| present.contains(id));
        events
    }

    /// Answer an open elicitation with `{action, content?}`.
    pub fn answer(&mut self, id: &str, result: &JsonValue) -> Result<(), String> {
        let run = self
            .open
            .get(id)
            .cloned()
            .ok_or("the elicitation is no longer open")?;
        let dir = bridge_dir(&run);
        if !dir.join(format!("e-{id}.req.json")).is_file() {
            return Err("the elicitation was withdrawn".into());
        }
        write_private(
            &dir.join(format!("e-{id}.ans.json")),
            result.to_string().as_bytes(),
        )
        .map_err(|error| error.to_string())?;
        self.answered.insert(id.to_string());
        Ok(())
    }

    /// Decline everything still open (the surface is going away).
    pub fn decline_all(&mut self) {
        let ids: Vec<String> = self.open.keys().cloned().collect();
        for id in ids {
            let _ = self.answer(&id, &json!({"action": "cancel"}));
        }
        for run in &self.runs {
            let _ = fs::remove_file(bridge_dir(run).join("surface"));
        }
    }
}

/// Send a `resources/*` or `prompts/*` request to one mounted server and
/// wait for its answer.
pub fn control(
    run_dir: &Path,
    mount: Option<&str>,
    server: &str,
    method: &str,
    params: &JsonValue,
    timeout: Duration,
) -> Result<JsonValue, String> {
    if !CONTROL_METHODS.contains(&method) {
        return Err(format!("{method} is not available through the bridge"));
    }
    let dir = bridge_dir(run_dir);
    ensure_private_dir(&dir).map_err(|error| error.to_string())?;
    let stem = format!(
        "c-{}-{}-{}x{}",
        sanitize(mount.unwrap_or("_")),
        sanitize(server),
        std::process::id(),
        next_seq()
    );
    let request = dir.join(format!("{stem}.req.json"));
    let response = dir.join(format!("{stem}.res.json"));
    write_private(
        &request,
        json!({"method": method, "params": params})
            .to_string()
            .as_bytes(),
    )
    .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(value) = read_json(&response) {
            let _ = fs::remove_file(&response);
            if let Some(error) = value.get("error") {
                let message = error
                    .get("message")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("error");
                return Err(format!("MCP server '{server}': {message}"));
            }
            return Ok(value.get("result").cloned().unwrap_or(JsonValue::Null));
        }
        if Instant::now() >= deadline {
            let _ = fs::remove_file(&request);
            return Err(format!(
                "MCP server '{server}' did not answer {method} (is it running?)"
            ));
        }
        thread::sleep(POLL);
    }
}

// ---------------------------------------------------------------------------
// Proxy side
// ---------------------------------------------------------------------------

pub struct ProxyBridge {
    run_dir: PathBuf,
    server: String,
    mount: Option<String>,
    /// URL elicitations accepted by the user: elicitation id -> request id.
    url_waits: Mutex<HashMap<String, String>>,
}

fn decline() -> JsonValue {
    json!({"action": "decline"})
}

fn cancel() -> JsonValue {
    json!({"action": "cancel"})
}

impl ProxyBridge {
    pub fn new(run_dir: &Path, server: &str, mount: Option<&str>) -> Self {
        Self {
            run_dir: run_dir.to_path_buf(),
            server: server.to_string(),
            mount: mount.map(str::to_string),
            url_waits: Mutex::new(HashMap::new()),
        }
    }

    pub fn surface_present(&self) -> bool {
        surface_present(&self.run_dir)
    }

    pub fn session_id(&self) -> Option<String> {
        mount_session(&self.run_dir, self.mount.as_deref()?)
    }

    /// Ask the surface. Returns the `elicitation/create` result: accept
    /// (with content checked against the requested schema), decline, or
    /// cancel (the server or dsh gave up, or the surface went away).
    pub fn elicit(&self, params: &JsonValue, cancelled: &AtomicBool) -> JsonValue {
        let Ok(request) = elicit_form::check_request(params) else {
            return decline();
        };
        if !self.surface_present() {
            return decline();
        }
        let dir = bridge_dir(&self.run_dir);
        if ensure_private_dir(&dir).is_err() {
            return decline();
        }
        let id = format!(
            "{}-{}x{}",
            sanitize(&self.server),
            std::process::id(),
            next_seq()
        );
        let request_path = dir.join(format!("e-{id}.req.json"));
        let answer_path = dir.join(format!("e-{id}.ans.json"));
        let file = ElicitFile {
            id: id.clone(),
            server: self.server.clone(),
            mount: self.mount.clone(),
            params: params.clone(),
        };
        if write_private(
            &request_path,
            serde_json::to_vec(&file).unwrap_or_default().as_slice(),
        )
        .is_err()
        {
            return decline();
        }
        let answer = loop {
            if let Some(answer) = read_json(&answer_path) {
                break answer;
            }
            if cancelled.load(Ordering::Relaxed)
                || !request_path.is_file()
                || !self.surface_present()
            {
                let _ = fs::remove_file(&request_path);
                let _ = fs::remove_file(&answer_path);
                return cancel();
            }
            thread::sleep(POLL);
        };
        let _ = fs::remove_file(&request_path);
        let _ = fs::remove_file(&answer_path);
        match answer.get("action").and_then(JsonValue::as_str) {
            Some("accept") => match &request.mode {
                elicit_form::Mode::Form { fields, .. } => {
                    let content = answer
                        .get("content")
                        .and_then(JsonValue::as_object)
                        .cloned()
                        .unwrap_or_default();
                    if elicit_form::check_content(fields, &content).is_err() {
                        return decline();
                    }
                    json!({"action": "accept", "content": content})
                }
                elicit_form::Mode::Url { elicitation_id, .. } => {
                    lock(&self.url_waits).insert(elicitation_id.clone(), id);
                    json!({"action": "accept"})
                }
            },
            Some("cancel") => cancel(),
            _ => decline(),
        }
    }

    /// `notifications/elicitation/complete` from the server.
    pub fn complete(&self, elicitation_id: &str) {
        if let Some(id) = lock(&self.url_waits).remove(elicitation_id) {
            let _ = write_private(
                &bridge_dir(&self.run_dir).join(format!("e-{id}.done")),
                b"done\n",
            );
        }
    }

    fn control_prefix(&self) -> String {
        format!(
            "c-{}-{}-",
            sanitize(self.mount.as_deref().unwrap_or("_")),
            sanitize(&self.server)
        )
    }

    /// Claim pending front requests: `(stem, method, params)`. A method
    /// outside [`CONTROL_METHODS`] is answered with an error here.
    pub fn take_controls(&self) -> Vec<(String, String, JsonValue)> {
        let dir = bridge_dir(&self.run_dir);
        let prefix = self.control_prefix();
        let Ok(entries) = fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(stem) = name
                .strip_suffix(".req.json")
                .filter(|stem| stem.starts_with(&prefix))
            else {
                continue;
            };
            let path = entry.path();
            let value = read_json(&path);
            if fs::remove_file(&path).is_err() {
                continue;
            }
            let Some(value) = value else { continue };
            let method = value
                .get("method")
                .and_then(JsonValue::as_str)
                .unwrap_or("")
                .to_string();
            if !CONTROL_METHODS.contains(&method.as_str()) {
                self.finish_control(
                    stem,
                    &json!({"error": {"code": -32601, "message": "method not available"}}),
                );
                continue;
            }
            let params = value.get("params").cloned().unwrap_or(json!({}));
            out.push((stem.to_string(), method, params));
        }
        out
    }

    pub fn finish_control(&self, stem: &str, reply: &JsonValue) {
        let _ = write_private(
            &bridge_dir(&self.run_dir).join(format!("{stem}.res.json")),
            reply.to_string().as_bytes(),
        );
    }
}

// ---------------------------------------------------------------------------
// Tool result projection
// ---------------------------------------------------------------------------

fn text_block(text: String) -> JsonValue {
    json!({"type": "text", "text": text})
}

/// Rewrite a `tools/call` result into blocks dsh shows: an embedded image
/// resource becomes an image block, other embedded resources become their
/// JSON text (as the reference does), audio becomes a note, and with
/// `expose_image_base64` each image also gets its base64 as text. An error
/// result keeps only its text. `structuredContent` a server did not also
/// put in a text block is appended as compact JSON.
pub fn project_result(result: &mut JsonValue, expose_base64: bool) {
    let is_error = result
        .get("isError")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let Some(blocks) = result.get("content").and_then(JsonValue::as_array).cloned() else {
        return;
    };
    let mut out = Vec::new();
    for block in blocks {
        let kind = block.get("type").and_then(JsonValue::as_str).unwrap_or("");
        if is_error {
            if kind == "text" {
                out.push(block);
            }
            continue;
        }
        match kind {
            "resource" => {
                let resource = block.get("resource").cloned().unwrap_or(JsonValue::Null);
                let mime = resource
                    .get("mimeType")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("");
                match resource.get("blob").and_then(JsonValue::as_str) {
                    Some(blob) if mime.starts_with("image/") => {
                        push_image(&mut out, blob, mime, expose_base64);
                    }
                    _ => out.push(text_block(resource.to_string())),
                }
            }
            "image" => {
                let data = block.get("data").and_then(JsonValue::as_str).unwrap_or("");
                let mime = block
                    .get("mimeType")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("image/png");
                push_image(&mut out, data, mime, expose_base64);
            }
            "audio" => {
                let mime = block
                    .get("mimeType")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("audio");
                let bytes = block
                    .get("data")
                    .and_then(JsonValue::as_str)
                    .map_or(0, |data| data.len() * 3 / 4);
                out.push(text_block(format!(
                    "[audio content ({mime}, about {bytes} bytes) is not shown to the model]"
                )));
            }
            _ => out.push(block),
        }
    }
    if let Some(structured) = result.get("structuredContent").filter(|v| !v.is_null()) {
        let inlined = out.iter().any(|block| {
            let Some(text) = block.get("text").and_then(JsonValue::as_str) else {
                return false;
            };
            let open = match structured {
                JsonValue::Object(_) => '{',
                JsonValue::Array(_) => '[',
                JsonValue::String(s) => return s == text,
                _ => {
                    return serde_json::from_str::<JsonValue>(text).ok().as_ref()
                        == Some(structured);
                }
            };
            text.find(open).is_some_and(|start| {
                let mut stream =
                    serde_json::Deserializer::from_str(&text[start..]).into_iter::<JsonValue>();
                stream.next().and_then(Result::ok).as_ref() == Some(structured)
            })
        });
        if !inlined && !is_error {
            out.push(text_block(structured.to_string()));
        }
    }
    result["content"] = JsonValue::Array(out);
}

fn push_image(out: &mut Vec<JsonValue>, data: &str, mime: &str, expose_base64: bool) {
    out.push(json!({"type": "image", "data": data, "mimeType": mime}));
    if expose_base64 {
        out.push(text_block(format!(
            "<mcp_image_base64 mime=\"{mime}\">\n{data}\n</mcp_image_base64>"
        )));
    }
}

// ---------------------------------------------------------------------------
// The shared proxy logic
// ---------------------------------------------------------------------------

pub type Sender = Arc<dyn Fn(JsonValue) + Send + Sync>;

/// What both proxies do with the messages they relay: advertise and answer
/// elicitation, project tool results, and run front control requests.
pub struct Interposer {
    bridge: Option<Arc<ProxyBridge>>,
    expose_base64: bool,
    tool_calls: Mutex<HashSet<String>>,
    /// Internal control request id -> bridge stem.
    controls: Mutex<HashMap<String, String>>,
    /// Server request id of a pending elicitation -> (withdraw flag,
    /// the server itself cancelled it).
    elicits: Arc<Mutex<HashMap<String, ElicitFlags>>>,
}

/// (withdraw flag, the server itself cancelled it).
type ElicitFlags = (Arc<AtomicBool>, Arc<AtomicBool>);

pub fn id_key(value: &JsonValue) -> String {
    value.to_string()
}

impl Interposer {
    pub fn new(bridge: Option<ProxyBridge>, expose_base64: bool) -> Self {
        Self {
            bridge: bridge.map(Arc::new),
            expose_base64,
            tool_calls: Mutex::new(HashSet::new()),
            controls: Mutex::new(HashMap::new()),
            elicits: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn bridge(&self) -> Option<&ProxyBridge> {
        self.bridge.as_deref()
    }

    /// dsh -> server. Adjusts `message` in place.
    pub fn outbound(&self, message: &mut JsonValue) {
        let method = message
            .get("method")
            .and_then(JsonValue::as_str)
            .map(str::to_string);
        let id = message.get("id").filter(|id| !id.is_null()).cloned();
        match (method.as_deref(), id) {
            (Some("initialize"), Some(_)) => {
                if self.bridge.as_ref().is_some_and(|b| b.surface_present())
                    && let Some(params) =
                        message.get_mut("params").and_then(JsonValue::as_object_mut)
                {
                    let caps = params.entry("capabilities").or_insert_with(|| json!({}));
                    if let Some(caps) = caps.as_object_mut() {
                        caps.insert("elicitation".into(), json!({"form": {}, "url": {}}));
                    }
                }
            }
            (Some("tools/call"), Some(id)) => {
                lock(&self.tool_calls).insert(id_key(&id));
            }
            (Some("notifications/cancelled"), None) => {
                if let Some(request) = message.pointer("/params/requestId") {
                    self.call_ended(&id_key(request));
                }
            }
            _ => {}
        }
    }

    /// A tool call ended without its result reaching dsh (cancelled, timed
    /// out, connection lost). When no call is left, pending elicitations
    /// are withdrawn: the answer could no longer reach anyone.
    pub fn call_ended(&self, key: &str) {
        let mut calls = lock(&self.tool_calls);
        calls.remove(key);
        if calls.is_empty() {
            for (flag, _) in lock(&self.elicits).values() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    /// Withdraw every pending elicitation (the connection is gone).
    pub fn abandon(&self) {
        lock(&self.tool_calls).clear();
        for (flag, _) in lock(&self.elicits).values() {
            flag.store(true, Ordering::Relaxed);
        }
    }

    /// server -> dsh. Returns the message to forward, or `None` when it was
    /// handled here; `reply` sends a message back to the server.
    pub fn inbound(&self, mut message: JsonValue, reply: &Sender) -> Option<JsonValue> {
        let method = message
            .get("method")
            .and_then(JsonValue::as_str)
            .map(str::to_string);
        let id = message.get("id").filter(|id| !id.is_null()).cloned();
        match (method.as_deref(), id) {
            (Some("elicitation/create"), Some(id)) => {
                let flag = Arc::new(AtomicBool::new(false));
                let by_server = Arc::new(AtomicBool::new(false));
                let key = id_key(&id);
                lock(&self.elicits)
                    .insert(key.clone(), (Arc::clone(&flag), Arc::clone(&by_server)));
                let params = message.get("params").cloned().unwrap_or(json!({}));
                let bridge = self.bridge.clone();
                let reply = Arc::clone(reply);
                let elicits = Arc::clone(&self.elicits);
                thread::spawn(move || {
                    let result = match bridge {
                        Some(bridge) => bridge.elicit(&params, &flag),
                        None => decline(),
                    };
                    lock(&elicits).remove(&key);
                    // A request the server cancelled gets no response.
                    if !by_server.load(Ordering::Relaxed) {
                        reply(json!({"jsonrpc": "2.0", "id": id, "result": result}));
                    }
                });
                None
            }
            (Some("notifications/cancelled"), None) => {
                let request = message.pointer("/params/requestId").map(id_key);
                if let Some((flag, by_server)) =
                    request.and_then(|key| lock(&self.elicits).get(&key).cloned())
                {
                    by_server.store(true, Ordering::Relaxed);
                    flag.store(true, Ordering::Relaxed);
                    return None;
                }
                Some(message)
            }
            (Some("notifications/elicitation/complete"), None) => {
                if let (Some(bridge), Some(id)) = (
                    &self.bridge,
                    message
                        .pointer("/params/elicitationId")
                        .and_then(JsonValue::as_str),
                ) {
                    bridge.complete(id);
                }
                None
            }
            (Some("ping"), Some(id)) => {
                reply(json!({"jsonrpc": "2.0", "id": id, "result": {}}));
                None
            }
            (None, Some(id)) => {
                let key = id_key(&id);
                if let Some(stem) = lock(&self.controls).remove(&key) {
                    if let Some(bridge) = &self.bridge {
                        let mut out = json!({});
                        if let Some(result) = message.get("result") {
                            out["result"] = result.clone();
                        }
                        if let Some(error) = message.get("error") {
                            out["error"] = error.clone();
                        }
                        bridge.finish_control(&stem, &out);
                    }
                    return None;
                }
                if lock(&self.tool_calls).remove(&key)
                    && let Some(result) = message.get_mut("result")
                {
                    project_result(result, self.expose_base64);
                }
                Some(message)
            }
            _ => Some(message),
        }
    }

    /// Front requests to send to the server now, with internal ids.
    pub fn control_requests(&self) -> Vec<JsonValue> {
        let Some(bridge) = &self.bridge else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (stem, method, params) in bridge.take_controls() {
            let id = json!(format!("codsh-ctl-{stem}"));
            lock(&self.controls).insert(id_key(&id), stem);
            out.push(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        }
        out
    }

    /// Answer every outstanding control request with `message` (the
    /// connection to the server is gone).
    pub fn fail_controls(&self, message: &str) {
        let stems: Vec<String> = lock(&self.controls).drain().map(|(_, stem)| stem).collect();
        if let Some(bridge) = &self.bridge {
            for stem in stems {
                bridge.finish_control(
                    &stem,
                    &json!({"error": {"code": -32000, "message": message}}),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codsh-bridge-{tag}-{}-{}",
            std::process::id(),
            next_seq()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn form_params() -> JsonValue {
        json!({
            "message": "Who are you?",
            "requestedSchema": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"]
            }
        })
    }

    fn wait_opened(watch: &mut SurfaceWatch) -> Elicitation {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            for event in watch.poll() {
                if let SurfaceEvent::Opened(elicitation) = event {
                    return elicitation;
                }
            }
            assert!(
                Instant::now() < deadline,
                "no elicitation reached the surface"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn without_a_surface_elicitation_is_declined_and_not_advertised() {
        let dir = run_dir("nosurface");
        let bridge = ProxyBridge::new(&dir, "srv", None);
        let flag = AtomicBool::new(false);
        assert_eq!(bridge.elicit(&form_params(), &flag), decline());
        let interposer = Interposer::new(Some(ProxyBridge::new(&dir, "srv", None)), false);
        let mut init = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"capabilities": {}}});
        interposer.outbound(&mut init);
        assert!(init.pointer("/params/capabilities/elicitation").is_none());
        announce_surface(&dir, "tui").unwrap();
        interposer.outbound(&mut init);
        assert!(
            init.pointer("/params/capabilities/elicitation/form")
                .is_some()
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn answers_are_checked_against_the_schema() {
        let dir = run_dir("answer");
        let mut watch = SurfaceWatch::new();
        watch.watch(&dir, "tui");
        record_mount(&dir, "m1", "session-7");
        let bridge = Arc::new(ProxyBridge::new(&dir, "my srv", Some("m1")));
        for (content, expected) in [
            (json!({"name": "Ann"}), "accept"),
            (json!({"name": 5}), "decline"),
            (json!({"other": "x"}), "decline"),
        ] {
            let worker = {
                let bridge = Arc::clone(&bridge);
                thread::spawn(move || bridge.elicit(&form_params(), &AtomicBool::new(false)))
            };
            let opened = wait_opened(&mut watch);
            assert_eq!(opened.server, "my srv");
            assert_eq!(opened.session_id.as_deref(), Some("session-7"));
            watch
                .answer(&opened.id, &json!({"action": "accept", "content": content}))
                .unwrap();
            let result = worker.join().unwrap();
            assert_eq!(result["action"], expected, "{content}");
            if expected == "accept" {
                assert_eq!(result["content"], content);
            }
            // The answered request is not reported as withdrawn.
            assert!(watch.poll().is_empty());
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_cancelled_call_withdraws_the_card() {
        let dir = run_dir("cancel");
        let mut watch = SurfaceWatch::new();
        watch.watch(&dir, "tui");
        let bridge = Arc::new(ProxyBridge::new(&dir, "srv", None));
        let flag = Arc::new(AtomicBool::new(false));
        let worker = {
            let (bridge, flag) = (Arc::clone(&bridge), Arc::clone(&flag));
            thread::spawn(move || bridge.elicit(&form_params(), &flag))
        };
        let opened = wait_opened(&mut watch);
        flag.store(true, Ordering::Relaxed);
        assert_eq!(worker.join().unwrap(), cancel());
        let events = watch.poll();
        assert_eq!(events, vec![SurfaceEvent::Withdrawn(opened.id.clone())]);
        assert!(
            watch
                .answer(&opened.id, &json!({"action": "decline"}))
                .is_err()
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn url_elicitation_completion_reaches_the_surface() {
        let dir = run_dir("url");
        let mut watch = SurfaceWatch::new();
        watch.watch(&dir, "tui");
        let bridge = Arc::new(ProxyBridge::new(&dir, "srv", None));
        let params = json!({"message": "Sign in", "mode": "url", "url": "https://auth.test/x", "elicitationId": "el-1"});
        let worker = {
            let bridge = Arc::clone(&bridge);
            thread::spawn(move || bridge.elicit(&params, &AtomicBool::new(false)))
        };
        let opened = wait_opened(&mut watch);
        watch
            .answer(&opened.id, &json!({"action": "accept"}))
            .unwrap();
        assert_eq!(worker.join().unwrap(), json!({"action": "accept"}));
        bridge.complete("el-1");
        assert_eq!(watch.poll(), vec![SurfaceEvent::Completed(opened.id)]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn control_requests_round_trip_and_tools_call_is_refused() {
        let dir = run_dir("control");
        let interposer = Arc::new(Interposer::new(
            Some(ProxyBridge::new(&dir, "srv", Some("m2"))),
            false,
        ));
        let sent: Arc<Mutex<Vec<JsonValue>>> = Arc::default();
        let server = {
            let (interposer, sent) = (Arc::clone(&interposer), Arc::clone(&sent));
            thread::spawn(move || {
                let reply: Sender = Arc::new(|_| {});
                let deadline = Instant::now() + Duration::from_secs(5);
                while Instant::now() < deadline {
                    if let Some(request) = interposer.control_requests().into_iter().next() {
                        lock(&sent).push(request.clone());
                        let answer = json!({"jsonrpc": "2.0", "id": request["id"], "result": {"contents": [{"uri": request["params"]["uri"], "text": "hello"}]}});
                        assert!(interposer.inbound(answer, &reply).is_none());
                        return;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            })
        };
        let result = control(
            &dir,
            Some("m2"),
            "srv",
            "resources/read",
            &json!({"uri": "mem://a"}),
            Duration::from_secs(5),
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(result["contents"][0]["text"], "hello");
        assert_eq!(lock(&sent)[0]["method"], "resources/read");
        assert!(
            control(
                &dir,
                Some("m2"),
                "srv",
                "tools/call",
                &json!({}),
                Duration::from_millis(50)
            )
            .is_err()
        );
        let err = control(
            &dir,
            Some("m2"),
            "srv",
            "prompts/list",
            &json!({}),
            Duration::from_millis(100),
        )
        .unwrap_err();
        assert!(err.contains("did not answer"), "{err}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn server_elicitation_without_bridge_is_declined_and_ping_answered() {
        let interposer = Interposer::new(None, false);
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = Mutex::new(tx);
        let reply: Sender = Arc::new(move |message| {
            let _ = lock(&tx).send(message);
        });
        let request = json!({"jsonrpc": "2.0", "id": 9, "method": "elicitation/create", "params": form_params()});
        assert!(interposer.inbound(request, &reply).is_none());
        let answer = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(answer["result"]["action"], "decline");
        assert!(
            interposer
                .inbound(
                    json!({"jsonrpc": "2.0", "id": "p", "method": "ping"}),
                    &reply
                )
                .is_none()
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap()["result"],
            json!({})
        );
    }

    #[test]
    fn tool_results_are_projected() {
        let interposer = Interposer::new(None, true);
        let reply: Sender = Arc::new(|_| {});
        let mut call =
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "t"}});
        interposer.outbound(&mut call);
        let result = json!({"jsonrpc": "2.0", "id": 3, "result": {
            "content": [
                {"type": "text", "text": "summary"},
                {"type": "resource", "resource": {"uri": "img://1", "mimeType": "image/png", "blob": "iVBORw0KGgo="}},
                {"type": "resource", "resource": {"uri": "mem://doc", "mimeType": "text/plain", "text": "doc body"}},
                {"type": "audio", "data": "AAAA", "mimeType": "audio/wav"}
            ],
            "structuredContent": {"count": 2}
        }});
        let out = interposer.inbound(result, &reply).unwrap();
        let blocks = out["result"]["content"].as_array().unwrap();
        assert_eq!(
            blocks[1],
            json!({"type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png"})
        );
        assert!(
            blocks[2]["text"]
                .as_str()
                .unwrap()
                .contains("<mcp_image_base64 mime=\"image/png\">")
        );
        assert!(blocks[3]["text"].as_str().unwrap().contains("doc body"));
        assert!(blocks[4]["text"].as_str().unwrap().contains("audio/wav"));
        assert_eq!(blocks[5]["text"], "{\"count\":2}");
        let mut error = json!({"content": [{"type": "text", "text": "bad"}, {"type": "image", "data": "x", "mimeType": "image/png"}], "isError": true});
        project_result(&mut error, false);
        assert_eq!(error["content"].as_array().unwrap().len(), 1);
        let mut inlined = json!({"content": [{"type": "text", "text": "Result: {\"a\":1}"}], "structuredContent": {"a": 1}});
        project_result(&mut inlined, false);
        assert_eq!(inlined["content"].as_array().unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn bridge_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = run_dir("perm");
        announce_surface(&dir, "tui").unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&bridge_dir(&dir)), 0o700);
        assert_eq!(mode(&bridge_dir(&dir).join("surface")), 0o600);
        record_mount(&dir, "m", "s");
        assert_eq!(mode(&dir.join("mounts")), 0o700);
        let _ = fs::remove_dir_all(dir);
    }
}
