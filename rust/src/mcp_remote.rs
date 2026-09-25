//! `__mcp-remote-proxy`: the stdio server dsh starts for a remote MCP
//! server (`url = ...`).
//!
//! dsh speaks newline-delimited JSON-RPC to this process; the proxy speaks
//! MCP's streamable HTTP transport (POST with a JSON or event-stream reply,
//! `Mcp-Session-Id`, `MCP-Protocol-Version`, a GET event stream for server
//! messages, DELETE at exit) or the legacy HTTP+SSE transport (a GET event
//! stream that names a POST endpoint) to the server. It:
//!
//! - reads the URL, headers, and client secret from an owner-only config
//!   file (`--config`), so neither the plan nor the process list carries a
//!   secret, and fills `{{session_id}}` / `${session_id}` header values with
//!   the ACP session of its mount (the header is left out until known);
//! - sends the stored OAuth token (`$GROK_HOME/mcp_credentials.json`),
//!   refreshes it when it expired or the server answers 401 and retries that
//!   request once (a 401 means the server did not run it); with no usable
//!   token it records "authentication required" for `/mcps` and answers
//!   with a JSON-RPC error that names `/mcps auth <name>`;
//! - re-initializes once when the server forgets the session (404) and
//!   repeats the request the server rejected, but never repeats a request
//!   whose connection broke after it was sent: the server may have run it,
//!   so the caller gets an error instead of a duplicate side effect;
//! - never follows redirects (a credential must not travel to another
//!   origin) and never shows a URL's query or user info;
//! - applies the startup and per-tool timeouts the stdio proxy applies, and
//!   shares its elicitation, resource, and content handling
//!   ([`crate::mcp_bridge::Interposer`]).

use crate::mcp_auth::{self, RefreshError, display_url};
use crate::mcp_bridge::{Interposer, ProxyBridge, Sender, id_key};
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const SUBCOMMAND: &str = "__mcp-remote-proxy";
/// The MCP protocol version the tests speak; the proxy forwards whatever
/// dsh and the server negotiate.
#[cfg(test)]
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// What the plan writes to `<runDir>/<name>.remote.json` (owner-only).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    pub url: String,
    #[serde(default)]
    pub sse: bool,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// The credential store; `None` disables OAuth.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials: Option<PathBuf>,
    /// A configured client's secret (from its environment variable).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_ca: Option<PathBuf>,
    #[serde(default)]
    pub expose_image_base64: bool,
}

impl RemoteConfig {
    pub fn write(&self, path: &Path) -> io::Result<()> {
        mcp_auth::write_private(path, &serde_json::to_vec(self).unwrap_or_default())
    }
}

#[derive(Debug, Default, PartialEq)]
struct Args {
    name: String,
    dir: PathBuf,
    config: PathBuf,
    mount: Option<String>,
    startup_ms: u64,
    tool_ms: u64,
    tool_timeouts: HashMap<String, u64>,
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut parsed = Args {
        startup_ms: crate::mcp::DEFAULT_STARTUP_TIMEOUT_MS,
        tool_ms: crate::mcp::DEFAULT_TOOL_TIMEOUT_MS,
        ..Args::default()
    };
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag {
            "--name" => parsed.name = value.clone(),
            "--dir" => parsed.dir = PathBuf::from(value),
            "--config" => parsed.config = PathBuf::from(value),
            "--mount" => parsed.mount = Some(value.clone()),
            "--startup-timeout-ms" => {
                parsed.startup_ms = value.parse().map_err(|_| "bad --startup-timeout-ms")?;
            }
            "--tool-timeout-ms" => {
                parsed.tool_ms = value.parse().map_err(|_| "bad --tool-timeout-ms")?;
            }
            "--tool-timeout" => {
                let (tool, ms) = value.rsplit_once('=').ok_or("bad --tool-timeout")?;
                parsed.tool_timeouts.insert(
                    tool.to_string(),
                    ms.parse().map_err(|_| "bad --tool-timeout")?,
                );
            }
            other => return Err(format!("unknown proxy flag {other}")),
        }
        index += 2;
    }
    if parsed.name.is_empty() || parsed.config.as_os_str().is_empty() {
        return Err(format!(
            "usage: {SUBCOMMAND} --name N --dir D --config FILE [--mount M] [timeouts]"
        ));
    }
    Ok(parsed)
}

/// Fill `{{session_id}}` / `${session_id}`; `None` drops the header while
/// the session is unknown.
pub fn header_value(value: &str, session: Option<&str>) -> Option<String> {
    if !mcp_auth::has_session_placeholder(value) {
        return Some(value.to_string());
    }
    let session = session?;
    Some(
        value
            .replace("{{session_id}}", session)
            .replace("${session_id}", session),
    )
}

/// One server-sent event.
#[derive(Debug, Default, PartialEq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
    pub id: Option<String>,
}

/// Read events from an event stream until it ends or `each` returns false.
pub fn read_events(reader: impl Read, mut each: impl FnMut(SseEvent) -> bool) -> io::Result<()> {
    let mut reader = BufReader::new(reader);
    let mut event = SseEvent::default();
    let mut has_data = false;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let text = line.trim_end_matches(['\r', '\n']);
        if text.is_empty() {
            if has_data || !event.event.is_empty() {
                if event.event.is_empty() {
                    event.event = "message".into();
                }
                if !each(std::mem::take(&mut event)) {
                    return Ok(());
                }
            }
            has_data = false;
            continue;
        }
        if text.starts_with(':') {
            continue;
        }
        let (field, value) = text.split_once(':').unwrap_or((text, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => event.event = value.to_string(),
            "data" => {
                if has_data {
                    event.data.push('\n');
                }
                event.data.push_str(value);
                has_data = true;
            }
            "id" if !value.contains('\0') => event.id = Some(value.to_string()),
            _ => {}
        }
    }
}

/// A 3xx answer. Redirects are never followed: a token or header would go
/// to wherever the server points.
fn redirect_refused(response: &ureq::Response) -> Option<Sent> {
    let code = response.status();
    (300..400).contains(&code).then(|| {
        Sent::Refused(
            code,
            "redirects are not followed; configure the final URL".into(),
        )
    })
}

fn write_status(dir: &Path, name: &str, text: &str) {
    let _ = fs::write(dir.join(format!("{name}.status")), format!("{text}\n"));
}

fn clear_status(dir: &Path, name: &str) {
    let _ = fs::remove_file(dir.join(format!("{name}.status")));
}

fn log_line(dir: &Path, name: &str, text: &str) {
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{name}.stderr.log")))
    {
        let _ = writeln!(file, "{text}");
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn rpc_error(id: &JsonValue, code: i64, message: &str) -> JsonValue {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// How one POST went.
#[derive(Debug)]
enum Sent {
    /// Delivered; any reply messages were handed on.
    Done,
    /// 401: the server did not run it.
    Unauthorized,
    /// 403 insufficient scope.
    Forbidden(String),
    /// 404 with a session: the server forgot it; it did not run the request.
    SessionGone,
    /// The server refused it with this HTTP status (it did not run it).
    Refused(u16, String),
    /// Could not connect: nothing was sent.
    Unreachable(String),
    /// The connection broke after the request went out: it may have run.
    Broken(String),
}

struct Call {
    deadline: Instant,
    tool: String,
    id: JsonValue,
}

struct Proxy {
    args: Args,
    cfg: RemoteConfig,
    agent: ureq::Agent,
    interposer: Interposer,
    out: Mutex<Box<dyn Write + Send>>,
    init_sent: Mutex<Option<Instant>>,
    init_answered: AtomicBool,
    session: Mutex<Option<String>>,
    protocol: Mutex<Option<String>>,
    /// dsh's `initialize` (after the interposer adjusted it), repeated when
    /// the server loses the session.
    init: Mutex<Option<JsonValue>>,
    initialized: AtomicBool,
    listening: AtomicBool,
    last_event_id: Mutex<Option<String>>,
    waiters: Mutex<HashMap<String, std::sync::mpsc::Sender<JsonValue>>>,
    calls: Mutex<HashMap<String, Call>>,
    timed_out: Mutex<std::collections::HashSet<String>>,
    /// Legacy SSE: the POST endpoint the event stream announced.
    endpoint: (Mutex<Option<String>>, Condvar),
    stop: AtomicBool,
    seq: std::sync::atomic::AtomicU64,
}

fn is_request(message: &JsonValue) -> bool {
    message.get("method").is_some() && message.get("id").is_some_and(|id| !id.is_null())
}

fn method_of(message: &JsonValue) -> &str {
    message
        .get("method")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
}

fn same_origin(a: &url::Url, b: &url::Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

impl Proxy {
    fn sender(self: &Arc<Self>) -> Sender {
        let proxy = Arc::clone(self);
        Arc::new(move |message: JsonValue| {
            let proxy = Arc::clone(&proxy);
            thread::spawn(move || {
                if let Err(error) = proxy.send(&message, true) {
                    log_line(
                        &proxy.args.dir,
                        &proxy.args.name,
                        &format!("reply not delivered: {error}"),
                    );
                }
            });
        })
    }

    fn write_out(&self, message: &JsonValue) {
        let mut out = lock(&self.out);
        let _ = out.write_all(message.to_string().as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }

    /// A message from the server (or a local error standing in for one).
    fn deliver(self: &Arc<Self>, message: JsonValue) {
        if let JsonValue::Array(list) = message {
            for item in list {
                self.deliver(item);
            }
            return;
        }
        if let Some(version) = message
            .pointer("/result/protocolVersion")
            .and_then(JsonValue::as_str)
            .filter(|_| message.pointer("/result/capabilities").is_some())
        {
            *lock(&self.protocol) = Some(version.to_string());
            self.init_answered.store(true, Ordering::Relaxed);
        }
        if message.get("method").is_none()
            && let Some(id) = message.get("id").filter(|id| !id.is_null())
        {
            let key = id_key(id);
            if let Some(waiter) = lock(&self.waiters).remove(&key) {
                let _ = waiter.send(message);
                return;
            }
            if lock(&self.timed_out).remove(&key) {
                return;
            }
            lock(&self.calls).remove(&key);
        }
        let reply = self.sender();
        if let Some(out) = self.interposer.inbound(message, &reply) {
            self.write_out(&out);
        }
    }

    fn uses_oauth(&self) -> bool {
        self.cfg.credentials.is_some()
            && !self
                .cfg
                .headers
                .keys()
                .any(|name| name.eq_ignore_ascii_case("authorization"))
    }

    /// The stored access token, refreshed first when it expired.
    fn token(&self) -> Option<String> {
        if !self.uses_oauth() {
            return None;
        }
        let path = self.cfg.credentials.as_deref()?;
        let store = mcp_auth::CredentialStore::load(path).ok()?;
        let entry = store.get(&self.args.name, &self.cfg.url)?.clone();
        let current = entry.access_token()?.to_string();
        if !entry.is_expired(mcp_auth::now_secs()) {
            return Some(current);
        }
        match self.refresh(Some(&current)) {
            Ok(token) => Some(token),
            // A transient failure: try the old token; the server decides.
            Err(RefreshError::Transient(_)) => Some(current),
            Err(_) => None,
        }
    }

    fn refresh(&self, used: Option<&str>) -> Result<String, RefreshError> {
        let path = self
            .cfg
            .credentials
            .as_deref()
            .ok_or(RefreshError::Unavailable)?;
        mcp_auth::refresh(
            path,
            &self.args.name,
            &self.cfg.url,
            used,
            self.cfg.client_secret.as_deref(),
            self.cfg.extra_ca.as_deref(),
        )
    }

    fn auth_required(&self, detail: &str) -> String {
        let name = &self.args.name;
        let text = format!(
            "authentication required{detail}: run /mcps auth {name} (or `codsh --rust mcp login {name}`)"
        );
        write_status(&self.args.dir, name, &text);
        format!("MCP server '{name}': {text}")
    }

    fn decorate(
        &self,
        mut request: ureq::Request,
        token: Option<&str>,
        with_session: bool,
    ) -> ureq::Request {
        let session = self.interposer.bridge().and_then(ProxyBridge::session_id);
        let mut agent_set = false;
        for (name, value) in &self.cfg.headers {
            if let Some(value) = header_value(value, session.as_deref()) {
                agent_set |= name.eq_ignore_ascii_case("user-agent");
                request = request.set(name, &value);
            }
        }
        if !agent_set {
            request = request.set("User-Agent", &mcp_auth::user_agent());
        }
        if let Some(token) = token {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        if with_session {
            if let Some(id) = lock(&self.session).clone() {
                request = request.set("Mcp-Session-Id", &id);
            }
            if let Some(version) = lock(&self.protocol).clone() {
                request = request.set("MCP-Protocol-Version", &version);
            }
        }
        request
    }

    fn classify_status(&self, code: u16, response: ureq::Response) -> Sent {
        let challenge = response.header("www-authenticate").map(str::to_string);
        let mut body = String::new();
        let _ = response.into_reader().take(4096).read_to_string(&mut body);
        match code {
            401 => Sent::Unauthorized,
            403 if challenge
                .as_deref()
                .is_some_and(|c| c.contains("insufficient_scope")) =>
            {
                let scope = challenge
                    .as_deref()
                    .map(mcp_auth::challenge_params)
                    .and_then(|params| params.get("scope").cloned())
                    .unwrap_or_default();
                Sent::Forbidden(scope)
            }
            404 if lock(&self.session).is_some() => Sent::SessionGone,
            _ => {
                let detail = serde_json::from_str::<JsonValue>(&body)
                    .ok()
                    .and_then(|v| {
                        v.pointer("/error/message")
                            .and_then(JsonValue::as_str)
                            .map(str::to_string)
                    })
                    .unwrap_or_default();
                Sent::Refused(code, detail)
            }
        }
    }

    fn transport_error(error: ureq::Transport, url: &str) -> Sent {
        use ureq::ErrorKind;
        let text = format!("cannot reach {}: {}", display_url(url), error.kind());
        match error.kind() {
            ErrorKind::Dns
            | ErrorKind::ConnectionFailed
            | ErrorKind::InvalidUrl
            | ErrorKind::UnknownScheme
            | ErrorKind::ProxyConnect
            | ErrorKind::InvalidProxyUrl => Sent::Unreachable(text),
            _ => Sent::Broken(format!(
                "the connection to {} failed: {}",
                display_url(url),
                error.kind()
            )),
        }
    }

    /// One POST of `body`; replies are delivered.
    fn post(self: &Arc<Self>, body: &JsonValue, token: Option<&str>) -> Sent {
        let limit = self.limit_for(body);
        if self.cfg.sse {
            let Some(endpoint) = self.legacy_endpoint(Duration::from_millis(self.args.startup_ms))
            else {
                return Sent::Unreachable(format!(
                    "no message endpoint from {}",
                    display_url(&self.cfg.url)
                ));
            };
            let request = self
                .agent
                .post(&endpoint)
                .set("Content-Type", "application/json")
                .timeout(Duration::from_secs(30));
            let request = self.decorate(request, token, false);
            return match request.send_string(&body.to_string()) {
                Ok(response) => redirect_refused(&response).unwrap_or(Sent::Done),
                Err(ureq::Error::Status(code, response)) => self.classify_status(code, response),
                Err(ureq::Error::Transport(error)) => Self::transport_error(error, &endpoint),
            };
        }
        let request = self
            .agent
            .post(&self.cfg.url)
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .timeout(limit);
        let request = self.decorate(request, token, true);
        let response = match request.send_string(&body.to_string()) {
            Ok(response) => response,
            Err(ureq::Error::Status(code, response)) => {
                return self.classify_status(code, response);
            }
            Err(ureq::Error::Transport(error)) => {
                return Self::transport_error(error, &self.cfg.url);
            }
        };
        if let Some(refused) = redirect_refused(&response) {
            return refused;
        }
        if method_of(body) == "initialize"
            && let Some(id) = response.header("mcp-session-id")
        {
            *lock(&self.session) = Some(id.to_string());
        }
        if response.status() == 202 || !is_request(body) {
            return Sent::Done;
        }
        let expect = body.get("id").map(id_key);
        let event_stream = response.content_type() == "text/event-stream";
        let mut answered = false;
        if event_stream {
            let result = read_events(response.into_reader(), |event| {
                if let Some(id) = &event.id {
                    *lock(&self.last_event_id) = Some(id.clone());
                }
                if event.event == "message"
                    && let Ok(message) = serde_json::from_str::<JsonValue>(&event.data)
                {
                    let reply_id = message.get("id").map(id_key);
                    let done = message.get("method").is_none() && reply_id == expect;
                    self.deliver(message);
                    answered |= done;
                }
                !answered
            });
            if !answered {
                let why = result
                    .err()
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "the stream ended".into());
                return Sent::Broken(format!(
                    "the reply stream from {} broke before the answer ({why})",
                    display_url(&self.cfg.url)
                ));
            }
            return Sent::Done;
        }
        let mut text = String::new();
        if let Err(error) = response
            .into_reader()
            .take(64 * 1024 * 1024)
            .read_to_string(&mut text)
        {
            return Sent::Broken(format!("reading the reply failed: {error}"));
        }
        match serde_json::from_str::<JsonValue>(&text) {
            Ok(message) => {
                self.deliver(message);
                Sent::Done
            }
            Err(_) => Sent::Broken(format!(
                "{} sent a reply that is not JSON-RPC",
                display_url(&self.cfg.url)
            )),
        }
    }

    fn limit_for(&self, body: &JsonValue) -> Duration {
        let ms = match method_of(body) {
            "initialize" => self.args.startup_ms,
            "tools/call" => {
                let tool = body
                    .pointer("/params/name")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("");
                self.args
                    .tool_timeouts
                    .get(tool)
                    .copied()
                    .unwrap_or(self.args.tool_ms)
                    + 5_000
            }
            _ => 120_000,
        };
        Duration::from_millis(ms.max(1_000))
    }

    /// POST with the auth and session recovery rules. `Err` is the message
    /// for the caller.
    fn send(self: &Arc<Self>, body: &JsonValue, allow_reinit: bool) -> Result<(), String> {
        let mut refreshed = false;
        let mut reinitialized = false;
        loop {
            let token = self.token();
            match self.post(body, token.as_deref()) {
                Sent::Done => return Ok(()),
                Sent::Unauthorized if !refreshed && self.uses_oauth() => {
                    refreshed = true;
                    match self.refresh(token.as_deref()) {
                        Ok(_) => continue,
                        Err(RefreshError::Rejected(_)) => {
                            return Err(self.auth_required(" (the stored login was rejected)"));
                        }
                        Err(RefreshError::Transient(error)) => {
                            return Err(format!(
                                "MCP server '{}': token refresh failed: {error}",
                                self.args.name
                            ));
                        }
                        Err(RefreshError::Unavailable) => return Err(self.auth_required("")),
                    }
                }
                Sent::Unauthorized => {
                    let configured = self
                        .cfg
                        .headers
                        .keys()
                        .any(|name| name.eq_ignore_ascii_case("authorization"));
                    let detail = if configured {
                        " (the configured Authorization header was refused)"
                    } else {
                        ""
                    };
                    return Err(self.auth_required(detail));
                }
                Sent::Forbidden(scope) => {
                    return Err(format!(
                        "MCP server '{}' needs more access (scope `{scope}`): sign in again with /mcps auth {}",
                        self.args.name, self.args.name
                    ));
                }
                Sent::SessionGone
                    if allow_reinit && !reinitialized && method_of(body) != "initialize" =>
                {
                    reinitialized = true;
                    self.reinitialize()?;
                }
                Sent::SessionGone => {
                    return Err(format!("MCP server '{}' ended the session", self.args.name));
                }
                Sent::Refused(code, detail) => {
                    let detail = if detail.is_empty() {
                        String::new()
                    } else {
                        format!(": {detail}")
                    };
                    return Err(format!(
                        "MCP server '{}' answered HTTP {code}{detail}",
                        self.args.name
                    ));
                }
                Sent::Unreachable(error) => {
                    return Err(format!("MCP server '{}': {error}", self.args.name));
                }
                Sent::Broken(error) => {
                    return Err(format!(
                        "MCP server '{}': {error}; the request was not repeated because the server may have run it",
                        self.args.name
                    ));
                }
            }
        }
    }

    /// Start a new session with dsh's own `initialize` after the server
    /// lost the old one.
    fn reinitialize(self: &Arc<Self>) -> Result<(), String> {
        let Some(mut init) = lock(&self.init).clone() else {
            return Err(format!("MCP server '{}' lost the session", self.args.name));
        };
        *lock(&self.session) = None;
        let n = self.seq.fetch_add(1, Ordering::Relaxed);
        let id = json!(format!("codsh-internal-init-{n}"));
        init["id"] = id.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        lock(&self.waiters).insert(id_key(&id), tx);
        let sent = self.send(&init, false);
        let answer = sent.and_then(|()| {
            rx.recv_timeout(Duration::from_millis(self.args.startup_ms))
                .map_err(|_| {
                    format!(
                        "MCP server '{}' did not answer initialize again",
                        self.args.name
                    )
                })
        });
        lock(&self.waiters).remove(&id_key(&id));
        let answer = answer?;
        if answer.get("result").is_none() {
            return Err(format!(
                "MCP server '{}' refused to start a new session",
                self.args.name
            ));
        }
        log_line(&self.args.dir, &self.args.name, "session re-initialized");
        self.send(
            &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            false,
        )
    }

    /// Legacy SSE: wait for the endpoint the stream announced.
    fn legacy_endpoint(&self, wait: Duration) -> Option<String> {
        let (slot, ready) = &self.endpoint;
        let guard = lock(slot);
        let (guard, _) = ready
            .wait_timeout_while(guard, wait, |endpoint| {
                endpoint.is_none() && !self.stop.load(Ordering::Relaxed)
            })
            .unwrap_or_else(|poison| poison.into_inner());
        guard.clone()
    }

    /// Legacy SSE: keep the event stream open; reconnect (and start a new
    /// session) when it drops.
    fn legacy_stream(self: Arc<Self>) {
        let base = match url::Url::parse(&self.cfg.url) {
            Ok(url) => url,
            Err(_) => return,
        };
        let mut backoff = Duration::from_millis(500);
        let mut refreshed = false;
        let mut connected_before = false;
        while !self.stop.load(Ordering::Relaxed) {
            let token = self.token();
            let request = self
                .agent
                .get(&self.cfg.url)
                .set("Accept", "text/event-stream");
            let request = self.decorate(request, token.as_deref(), false);
            match request.call() {
                Ok(response) if redirect_refused(&response).is_some() => {
                    write_status(
                        &self.args.dir,
                        &self.args.name,
                        &format!(
                            "{} answered HTTP {} to the event stream request; redirects are not followed",
                            display_url(&self.cfg.url),
                            response.status()
                        ),
                    );
                }
                Ok(response) => {
                    refreshed = false;
                    backoff = Duration::from_millis(500);
                    let proxy = Arc::clone(&self);
                    let reconnect = connected_before;
                    let _ = read_events(response.into_reader(), |event| {
                        match event.event.as_str() {
                            "endpoint" => {
                                let Ok(url) = base.join(event.data.trim()) else {
                                    return true;
                                };
                                if !same_origin(&url, &base) {
                                    write_status(
                                        &proxy.args.dir,
                                        &proxy.args.name,
                                        &format!(
                                            "the SSE server named a message endpoint on another origin ({}); refused",
                                            display_url(url.as_str())
                                        ),
                                    );
                                    return false;
                                }
                                let (slot, ready) = &proxy.endpoint;
                                *lock(slot) = Some(url.to_string());
                                ready.notify_all();
                                if reconnect && proxy.initialized.load(Ordering::Relaxed) {
                                    let proxy = Arc::clone(&proxy);
                                    thread::spawn(move || {
                                        if let Err(error) = proxy.reinitialize() {
                                            log_line(&proxy.args.dir, &proxy.args.name, &error);
                                        }
                                    });
                                }
                            }
                            "message" => {
                                if let Ok(message) = serde_json::from_str::<JsonValue>(&event.data)
                                {
                                    proxy.deliver(message);
                                }
                            }
                            _ => {}
                        }
                        !proxy.stop.load(Ordering::Relaxed)
                    });
                    connected_before = true;
                    *lock(&self.endpoint.0) = None;
                    if !self.stop.load(Ordering::Relaxed) {
                        log_line(
                            &self.args.dir,
                            &self.args.name,
                            "event stream closed; reconnecting",
                        );
                        self.fail_pending("the connection to the server was lost");
                    }
                }
                Err(ureq::Error::Status(401, _)) if !refreshed && self.uses_oauth() => {
                    refreshed = true;
                    if self.refresh(token.as_deref()).is_ok() {
                        continue;
                    }
                    let _ = self.auth_required("");
                }
                Err(ureq::Error::Status(401, _)) => {
                    let _ = self.auth_required("");
                }
                Err(ureq::Error::Status(code, _)) => {
                    write_status(
                        &self.args.dir,
                        &self.args.name,
                        &format!(
                            "{} answered HTTP {code} to the event stream request",
                            display_url(&self.cfg.url)
                        ),
                    );
                }
                Err(ureq::Error::Transport(error)) => {
                    log_line(
                        &self.args.dir,
                        &self.args.name,
                        &format!(
                            "cannot reach {}: {}",
                            display_url(&self.cfg.url),
                            error.kind()
                        ),
                    );
                }
            }
            thread::sleep(backoff);
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    }

    /// Streamable HTTP: the optional GET stream for server-initiated
    /// messages (a 405 means the server has none).
    fn listen(self: Arc<Self>) {
        let mut backoff = Duration::from_millis(500);
        while !self.stop.load(Ordering::Relaxed) {
            let token = self.token();
            let mut request = self
                .agent
                .get(&self.cfg.url)
                .set("Accept", "text/event-stream");
            request = self.decorate(request, token.as_deref(), true);
            if let Some(last) = lock(&self.last_event_id).clone() {
                request = request.set("Last-Event-ID", &last);
            }
            match request.call() {
                Ok(response) if response.content_type() == "text/event-stream" => {
                    backoff = Duration::from_millis(500);
                    let proxy = Arc::clone(&self);
                    let _ = read_events(response.into_reader(), |event| {
                        if let Some(id) = &event.id {
                            *lock(&proxy.last_event_id) = Some(id.clone());
                        }
                        if event.event == "message"
                            && let Ok(message) = serde_json::from_str::<JsonValue>(&event.data)
                        {
                            proxy.deliver(message);
                        }
                        !proxy.stop.load(Ordering::Relaxed)
                    });
                }
                Ok(_) | Err(ureq::Error::Status(405, _)) => return,
                Err(ureq::Error::Status(401 | 403, _)) => {
                    if self.refresh(token.as_deref()).is_err() {
                        return;
                    }
                }
                Err(_) => {}
            }
            thread::sleep(backoff);
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    }

    /// Answer every call in flight with an error (the connection is gone).
    fn fail_pending(self: &Arc<Self>, why: &str) {
        let calls: Vec<Call> = lock(&self.calls).drain().map(|(_, call)| call).collect();
        self.interposer.abandon();
        self.interposer.fail_controls(why);
        for call in calls {
            self.write_out(&rpc_error(
                &call.id,
                -32000,
                &format!(
                    "MCP server '{}': {why} during '{}'; the call was not repeated because the server may have run it",
                    self.args.name, call.tool
                ),
            ));
        }
    }

    /// One message from dsh.
    fn from_dsh(self: &Arc<Self>, mut message: JsonValue) {
        self.interposer.outbound(&mut message);
        let method = method_of(&message).to_string();
        let id = message.get("id").filter(|id| !id.is_null()).cloned();
        if method == "initialize"
            && let Some(id) = &id
        {
            *lock(&self.init) = Some(message.clone());
            *lock(&self.init_sent) = Some(Instant::now());
            match self.send(&message, false) {
                Ok(()) => {}
                Err(error) => {
                    if !error.contains("authentication required") {
                        write_status(
                            &self.args.dir,
                            &self.args.name,
                            error.trim_start_matches(&format!("MCP server '{}': ", self.args.name)),
                        );
                    }
                    self.write_out(&rpc_error(id, -32001, &error));
                }
            }
            return;
        }
        if method == "notifications/initialized" {
            let _ = self.send(&message, true);
            self.initialized.store(true, Ordering::Relaxed);
            clear_status(&self.args.dir, &self.args.name);
            if !self.cfg.sse && !self.listening.swap(true, Ordering::Relaxed) {
                let proxy = Arc::clone(self);
                thread::spawn(move || proxy.listen());
            }
            return;
        }
        if method == "notifications/cancelled"
            && let Some(request) = message.pointer("/params/requestId")
        {
            lock(&self.calls).remove(&id_key(request));
        }
        let Some(id) = id.filter(|_| !method.is_empty()) else {
            // Notifications and dsh's answers to server requests, in order.
            if let Err(error) = self.send(&message, true) {
                log_line(&self.args.dir, &self.args.name, &error);
            }
            return;
        };
        if method == "tools/call" {
            let tool = message
                .pointer("/params/name")
                .and_then(JsonValue::as_str)
                .unwrap_or("")
                .to_string();
            let limit = self
                .args
                .tool_timeouts
                .get(&tool)
                .copied()
                .unwrap_or(self.args.tool_ms);
            lock(&self.calls).insert(
                id_key(&id),
                Call {
                    deadline: Instant::now() + Duration::from_millis(limit),
                    tool,
                    id: id.clone(),
                },
            );
        }
        let proxy = Arc::clone(self);
        thread::spawn(move || {
            if let Err(error) = proxy.send(&message, true) {
                proxy.deliver(rpc_error(&id, -32000, &error));
            }
        });
    }

    fn expire_calls(self: &Arc<Self>) {
        let now = Instant::now();
        let expired: Vec<Call> = {
            let mut calls = lock(&self.calls);
            let keys: Vec<String> = calls
                .iter()
                .filter(|(_, c)| c.deadline <= now)
                .map(|(k, _)| k.clone())
                .collect();
            keys.into_iter()
                .filter_map(|key| {
                    let call = calls.remove(&key)?;
                    lock(&self.timed_out).insert(key);
                    Some(call)
                })
                .collect()
        };
        for call in expired {
            let limit = self
                .args
                .tool_timeouts
                .get(&call.tool)
                .copied()
                .unwrap_or(self.args.tool_ms);
            self.interposer.call_ended(&id_key(&call.id));
            self.write_out(&rpc_error(
                &call.id,
                -32001,
                &format!(
                    "MCP tool call '{}' timed out after {:.1}s (codsh tool timeout)",
                    call.tool,
                    limit as f64 / 1000.0
                ),
            ));
            let cancel = json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": call.id, "reason": "tool timeout"}});
            let proxy = Arc::clone(self);
            thread::spawn(move || {
                let _ = proxy.send(&cancel, false);
            });
        }
    }

    fn close_session(&self) {
        if self.cfg.sse {
            return;
        }
        let Some(session) = lock(&self.session).clone() else {
            return;
        };
        let token = self.token();
        let request = self
            .agent
            .delete(&self.cfg.url)
            .timeout(Duration::from_secs(3));
        let request = self
            .decorate(request, token.as_deref(), true)
            .set("Mcp-Session-Id", &session);
        let _ = request.call();
    }
}

fn build_agent(extra_ca: Option<&Path>) -> Result<ureq::Agent, String> {
    let (connector, _) =
        crate::extra_ca::native_connector(extra_ca).map_err(|error| error.to_string())?;
    Ok(ureq::AgentBuilder::new()
        .tls_connector(connector)
        .redirects(0)
        .timeout_connect(Duration::from_secs(15))
        .build())
}

fn make_proxy(
    args: Args,
    cfg: RemoteConfig,
    out: Box<dyn Write + Send>,
) -> Result<Arc<Proxy>, (PathBuf, String, String)> {
    let agent = build_agent(cfg.extra_ca.as_deref())
        .map_err(|error| (args.dir.clone(), args.name.clone(), error))?;
    let bridge = ProxyBridge::new(&args.dir, &args.name, args.mount.as_deref());
    Ok(Arc::new(Proxy {
        interposer: Interposer::new(Some(bridge), cfg.expose_image_base64),
        args,
        cfg,
        agent,
        out: Mutex::new(out),
        init_sent: Mutex::new(None),
        init_answered: AtomicBool::new(false),
        session: Mutex::new(None),
        protocol: Mutex::new(None),
        init: Mutex::new(None),
        initialized: AtomicBool::new(false),
        listening: AtomicBool::new(false),
        last_event_id: Mutex::new(None),
        waiters: Mutex::new(HashMap::new()),
        calls: Mutex::new(HashMap::new()),
        timed_out: Mutex::new(Default::default()),
        endpoint: (Mutex::new(None), Condvar::new()),
        stop: AtomicBool::new(false),
        seq: Default::default(),
    }))
}

/// Entry point for `codsh-rust __mcp-remote-proxy ...`. Returns the exit code.
pub fn run_proxy(args: &[String]) -> i32 {
    let args = match parse_args(args) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("codsh mcp remote proxy: {error}");
            return 2;
        }
    };
    let _ = fs::create_dir_all(&args.dir);
    let cfg: RemoteConfig = match fs::read(&args.config)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    {
        Some(cfg) => cfg,
        None => {
            write_status(&args.dir, &args.name, "remote server settings are missing");
            return 2;
        }
    };
    let proxy = match make_proxy(args, cfg, Box::new(io::stdout())) {
        Ok(proxy) => proxy,
        Err((dir, name, error)) => {
            write_status(&dir, &name, &format!("TLS setup failed: {error}"));
            return 1;
        }
    };
    let terminate = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    for signal in [
        signal_hook::consts::SIGTERM,
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGHUP,
    ] {
        let _ = signal_hook::flag::register(signal, Arc::clone(&terminate));
    }
    if proxy.cfg.sse {
        let stream = Arc::clone(&proxy);
        thread::spawn(move || stream.legacy_stream());
    }
    let closed = Arc::new(AtomicBool::new(false));
    {
        let proxy = Arc::clone(&proxy);
        let closed = Arc::clone(&closed);
        thread::spawn(move || {
            for line in BufReader::new(io::stdin()).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<JsonValue>(&line) {
                    Ok(message) => proxy.from_dsh(message),
                    Err(_) => log_line(
                        &proxy.args.dir,
                        &proxy.args.name,
                        "dropped a line from dsh that is not JSON",
                    ),
                }
            }
            closed.store(true, Ordering::Relaxed);
        });
    }
    loop {
        if closed.load(Ordering::Relaxed) || terminate.load(Ordering::Relaxed) {
            proxy.stop.store(true, Ordering::Relaxed);
            proxy.endpoint.1.notify_all();
            proxy.interposer.abandon();
            proxy.close_session();
            return if terminate.load(Ordering::Relaxed) {
                143
            } else {
                0
            };
        }
        let started = *lock(&proxy.init_sent);
        if let Some(started) = started
            && !proxy.init_answered.load(Ordering::Relaxed)
            && started.elapsed() > Duration::from_millis(proxy.args.startup_ms + 1_000)
        {
            write_status(
                &proxy.args.dir,
                &proxy.args.name,
                &format!(
                    "startup timed out after {:.1}s without an initialize response",
                    proxy.args.startup_ms as f64 / 1000.0
                ),
            );
            proxy.stop.store(true, Ordering::Relaxed);
            return 124;
        }
        proxy.expire_calls();
        for request in proxy.interposer.control_requests() {
            let proxy = Arc::clone(&proxy);
            thread::spawn(move || {
                if let Err(error) = proxy.send(&request, true) {
                    proxy.deliver(rpc_error(&request["id"], -32000, &error));
                }
            });
        }
        thread::sleep(Duration::from_millis(40));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_auth::tests::{Handler, serve};
    use std::sync::atomic::AtomicUsize;

    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);

    impl Write for Buf {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            lock(&self.0).extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Buf {
        fn messages(&self) -> Vec<JsonValue> {
            String::from_utf8_lossy(&lock(&self.0))
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect()
        }
        fn wait_for(&self, id: i64) -> JsonValue {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(found) = self.messages().into_iter().find(|m| m["id"] == id) {
                    return found;
                }
                assert!(Instant::now() < deadline, "no answer for id {id}");
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    fn proxy_for(
        url: &str,
        dir: &Path,
        credentials: Option<PathBuf>,
        headers: BTreeMap<String, String>,
    ) -> (Arc<Proxy>, Buf) {
        let buf = Buf::default();
        let args = Args {
            name: "srv".into(),
            dir: dir.to_path_buf(),
            config: dir.join("unused.json"),
            mount: Some("m1".into()),
            startup_ms: 5_000,
            tool_ms: 10_000,
            tool_timeouts: HashMap::new(),
        };
        let cfg = RemoteConfig {
            url: url.into(),
            headers,
            credentials,
            ..RemoteConfig::default()
        };
        let proxy = make_proxy(args, cfg, Box::new(buf.clone()))
            .map_err(|e| e.2)
            .unwrap();
        (proxy, buf)
    }

    fn init() -> JsonValue {
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}})
    }

    fn call(id: i64) -> JsonValue {
        json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": "echo", "arguments": {}}})
    }

    fn init_reply(body: &str, session: &str) -> (u16, Vec<(String, String)>, String) {
        let id: JsonValue = serde_json::from_str::<JsonValue>(body).unwrap()["id"].clone();
        (200, vec![("Content-Type".into(), "application/json".into()), ("Mcp-Session-Id".into(), session.into())],
            json!({"jsonrpc": "2.0", "id": id, "result": {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {}}, "serverInfo": {"name": "t", "version": "1"}}}).to_string())
    }

    #[test]
    fn args_headers_and_events_parse() {
        let args: Vec<String> = [
            "--name",
            "a",
            "--dir",
            "/d",
            "--config",
            "/c",
            "--mount",
            "m",
            "--tool-timeout",
            "x=5",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let parsed = parse_args(&args).unwrap();
        assert_eq!(parsed.mount.as_deref(), Some("m"));
        assert_eq!(parsed.tool_timeouts["x"], 5);
        assert!(parse_args(&["--name".to_string()]).is_err());
        assert_eq!(header_value("{{session_id}}", None), None);
        assert_eq!(
            header_value("s-${session_id}", Some("abc")).as_deref(),
            Some("s-abc")
        );
        assert_eq!(header_value("plain", None).as_deref(), Some("plain"));
        let stream =
            ": comment\nevent: endpoint\ndata: /messages?x=1\n\nid: 7\ndata: {\"a\":\ndata: 1}\n\n";
        let mut events = Vec::new();
        read_events(stream.as_bytes(), |event| {
            events.push(event);
            true
        })
        .unwrap();
        assert_eq!(events[0].event, "endpoint");
        assert_eq!(events[0].data, "/messages?x=1");
        assert_eq!(
            events[1],
            SseEvent {
                event: "message".into(),
                data: "{\"a\":\n1}".into(),
                id: Some("7".into())
            }
        );
        let a = url::Url::parse("http://127.0.0.1:5/a").unwrap();
        assert!(same_origin(
            &a,
            &url::Url::parse("http://127.0.0.1:5/b?c").unwrap()
        ));
        assert!(!same_origin(
            &a,
            &url::Url::parse("http://127.0.0.1:6/a").unwrap()
        ));
    }

    #[test]
    fn a_lost_session_is_restarted_once_and_the_rejected_call_repeated() {
        let dir = tempfile::TempDir::new().unwrap();
        let inits = Arc::new(AtomicUsize::new(0));
        let executed = Arc::new(AtomicUsize::new(0));
        let (i2, e2) = (Arc::clone(&inits), Arc::clone(&executed));
        let handler: Handler = Arc::new(move |method, _path, body, headers| {
            if method != "POST" {
                return (405, vec![], String::new());
            }
            let message: JsonValue = serde_json::from_str(body).unwrap_or_default();
            match message["method"].as_str().unwrap_or("") {
                "initialize" => {
                    let n = i2.fetch_add(1, Ordering::SeqCst) + 1;
                    init_reply(body, &format!("s{n}"))
                }
                "tools/call" => {
                    if headers.get("mcp-session-id").map(String::as_str) != Some("s2") {
                        return (404, vec![], String::new());
                    }
                    assert_eq!(
                        headers.get("mcp-protocol-version").map(String::as_str),
                        Some(PROTOCOL_VERSION)
                    );
                    e2.fetch_add(1, Ordering::SeqCst);
                    let reply = json!({"jsonrpc": "2.0", "id": message["id"], "result": {"content": [{"type": "text", "text": "ok"}]}});
                    (
                        200,
                        vec![("Content-Type".into(), "text/event-stream".into())],
                        format!("id: 1\nevent: message\ndata: {reply}\n\n"),
                    )
                }
                _ => (202, vec![], String::new()),
            }
        });
        let base = serve(handler);
        let (proxy, buf) = proxy_for(&format!("{base}/mcp"), dir.path(), None, BTreeMap::new());
        proxy.from_dsh(init());
        assert!(buf.wait_for(1).get("result").is_some());
        proxy.from_dsh(call(2));
        assert_eq!(buf.wait_for(2)["result"]["content"][0]["text"], "ok");
        assert_eq!(inits.load(Ordering::SeqCst), 2);
        assert_eq!(executed.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_broken_reply_stream_is_not_repeated() {
        let dir = tempfile::TempDir::new().unwrap();
        let executed = Arc::new(AtomicUsize::new(0));
        let e2 = Arc::clone(&executed);
        let handler: Handler = Arc::new(move |_method, _path, body, _headers| {
            let message: JsonValue = serde_json::from_str(body).unwrap_or_default();
            match message["method"].as_str().unwrap_or("") {
                "initialize" => init_reply(body, "s1"),
                "tools/call" => {
                    e2.fetch_add(1, Ordering::SeqCst);
                    (
                        200,
                        vec![("Content-Type".into(), "text/event-stream".into())],
                        ": working\n\n".into(),
                    )
                }
                _ => (202, vec![], String::new()),
            }
        });
        let base = serve(handler);
        let (proxy, buf) = proxy_for(&format!("{base}/mcp"), dir.path(), None, BTreeMap::new());
        proxy.from_dsh(init());
        buf.wait_for(1);
        proxy.from_dsh(call(2));
        let answer = buf.wait_for(2);
        let text = answer["error"]["message"].as_str().unwrap();
        assert!(text.contains("not repeated"), "{text}");
        thread::sleep(Duration::from_millis(200));
        assert_eq!(executed.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn an_expired_token_is_refreshed_on_401_and_the_request_retried_once() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = dir.path().join("mcp_credentials.json");
        let calls = Arc::new(Mutex::new(Vec::<String>::new()));
        let c2 = Arc::clone(&calls);
        let handler: Handler = Arc::new(move |method, path, body, headers| {
            let auth = headers.get("authorization").cloned().unwrap_or_default();
            lock(&c2).push(format!("{method} {path} {auth}"));
            if path == "/token" {
                assert!(
                    body.contains("grant_type=refresh_token") && body.contains("refresh_token=r1")
                );
                return (
                    200,
                    vec![("Content-Type".into(), "application/json".into())],
                    json!({"access_token": "fresh", "token_type": "Bearer", "expires_in": 3600})
                        .to_string(),
                );
            }
            if auth != "Bearer fresh" {
                return (
                    401,
                    vec![(
                        "WWW-Authenticate".into(),
                        "Bearer error=\"invalid_token\"".into(),
                    )],
                    String::new(),
                );
            }
            init_reply(body, "s1")
        });
        let base = serve(handler);
        let url = format!("{base}/mcp");
        mcp_auth::CredentialStore::update(&store, |s| {
            s.entries.insert(
                mcp_auth::store_key("srv", &url),
                mcp_auth::StoredCredentials {
                    client_id: "c1".into(),
                    token_response: Some(mcp_auth::TokenResponse {
                        access_token: "stale".into(),
                        token_type: "Bearer".into(),
                        expires_in: Some(3600),
                        refresh_token: Some("r1".into()),
                        scope: None,
                    }),
                    token_received_at: Some(mcp_auth::now_secs()),
                    token_endpoint: Some(format!("{base}/token")),
                    ..Default::default()
                },
            );
        })
        .unwrap();
        let (proxy, buf) = proxy_for(&url, dir.path(), Some(store.clone()), BTreeMap::new());
        proxy.from_dsh(init());
        assert!(buf.wait_for(1).get("result").is_some());
        let seen = lock(&calls).clone();
        assert_eq!(
            seen.iter().filter(|c| c.starts_with("POST /mcp")).count(),
            2,
            "{seen:?}"
        );
        let stored = mcp_auth::CredentialStore::load(&store).unwrap();
        assert_eq!(
            stored.get("srv", &url).unwrap().access_token(),
            Some("fresh")
        );
    }

    #[test]
    fn without_credentials_a_401_names_the_login_command_and_redirects_are_refused() {
        let dir = tempfile::TempDir::new().unwrap();
        let handler: Handler = Arc::new(move |_method, path, _body, _headers| {
            if path.starts_with("/moved") {
                return (
                    307,
                    vec![("Location".into(), "http://127.0.0.1:1/elsewhere".into())],
                    String::new(),
                );
            }
            (
                401,
                vec![(
                    "WWW-Authenticate".into(),
                    "Bearer resource_metadata=\"x\"".into(),
                )],
                String::new(),
            )
        });
        let base = serve(handler);
        let store = dir.path().join("mcp_credentials.json");
        let (proxy, buf) = proxy_for(
            &format!("{base}/mcp?key=secret"),
            dir.path(),
            Some(store),
            BTreeMap::new(),
        );
        proxy.from_dsh(init());
        let text = buf.wait_for(1)["error"]["message"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(text.contains("/mcps auth srv"), "{text}");
        let status = fs::read_to_string(dir.path().join("srv.status")).unwrap();
        assert!(status.contains("authentication required"), "{status}");
        let (proxy, buf) = proxy_for(
            &format!("{base}/moved?key=secret"),
            dir.path(),
            None,
            BTreeMap::new(),
        );
        proxy.from_dsh(init());
        let text = buf.wait_for(1)["error"]["message"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(text.contains("HTTP 307"), "{text}");
        assert!(!text.contains("secret"), "{text}");
    }

    #[test]
    fn session_placeholder_headers_wait_for_the_session() {
        let dir = tempfile::TempDir::new().unwrap();
        let seen = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
        let s2 = Arc::clone(&seen);
        let handler: Handler = Arc::new(move |_method, _path, body, headers| {
            lock(&s2).push(headers.get("x-mcp-session-id").cloned());
            init_reply(body, "s1")
        });
        let base = serve(handler);
        let headers =
            BTreeMap::from([("x-mcp-session-id".to_string(), "{{session_id}}".to_string())]);
        let (proxy, buf) = proxy_for(&format!("{base}/mcp"), dir.path(), None, headers.clone());
        proxy.from_dsh(init());
        buf.wait_for(1);
        crate::mcp_bridge::record_mount(dir.path(), "m1", "acp-session-9");
        let (proxy, buf) = proxy_for(&format!("{base}/mcp"), dir.path(), None, headers);
        proxy.from_dsh(init());
        buf.wait_for(1);
        assert_eq!(*lock(&seen), vec![None, Some("acp-session-9".to_string())]);
    }

    #[cfg(unix)]
    #[test]
    fn the_config_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("srv.remote.json");
        RemoteConfig {
            url: "https://x.test/mcp".into(),
            headers: BTreeMap::from([("Authorization".into(), "Bearer t".into())]),
            ..Default::default()
        }
        .write(&path)
        .unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
