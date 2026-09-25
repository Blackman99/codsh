//! ACP hub for editors and shared clients. dsh remains the only executor and
//! durable writer. Standard methods are forwarded. `session/load` is the
//! editor name for dsh `session/resume` plus a read-only history replay or,
//! for a session this process already runs, an attach that re-executes
//! nothing. Proprietary `x.ai/*` methods and unadvertised standard methods
//! return method-not-found.
//!
//! One hub serves `agent stdio` (one client), `agent serve` (WebSocket
//! clients), and `agent leader` (local socket clients). One dsh process owns
//! each live session; every other client observes it and asks through here.

use crate::acp::{self, AcpClient, AcpEvent, PROTOCOL_VERSION};
use crate::config::{self, EffectiveConfig};
use crate::models;
use crate::permission::{self, PermissionMode};
use crate::session_history::{self, RestoredTurn};
use crate::session_owner::SessionOwner;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

const AGENT_NAME: &str = "codsh-rust";
const POLL: Duration = Duration::from_millis(10);
/// Per-process policy files, one per dsh child, under DSH_HOME.
const RUNTIME_POLICY_DIR: &str = "runtime-policy";
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
            "x.ai/session/prompt_complete",
            "shared clients get _codsh/prompt_complete; the x.ai notification contract is not claimed",
        ),
        (
            "x.ai/leader/version_mismatch",
            "the leader version is in initialize _meta codsh/server; a mismatch is a stderr warning",
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
            reason: "editor load is dsh session/resume plus read-only history replay; a session this process already runs is attached without a second executor",
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
            reason: "model and reasoning_effort go to dsh; permission_mode updates this session's policy; other attached clients get config_option_update",
        },
        ExtensionEntry {
            method: LEADER_INFO.into(),
            status: "supported",
            reason: "read-only state of this process: clients, live sessions, dsh pids, running turns",
        },
        ExtensionEntry {
            method: LEADER_SHUTDOWN.into(),
            status: "supported",
            reason: "leader transport only; stops the leader and its dsh processes",
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

/// One connection to the hub. stdio has exactly one; the shared server and
/// the leader have one per socket.
pub type ClientId = u64;

/// Where a client's JSON-RPC lines go. stdio writes synchronously, like the
/// single-editor server did. A network client has a bounded queue drained by
/// its own writer thread; a client that stops reading is dropped rather than
/// stalling every other observer.
pub enum ClientSink {
    Writer(Box<dyn Write + Send>),
    Queue(mpsc::SyncSender<String>),
}

impl ClientSink {
    fn send(&mut self, line: &str) -> bool {
        match self {
            ClientSink::Writer(writer) => writeln!(writer, "{line}")
                .and_then(|_| writer.flush())
                .is_ok(),
            ClientSink::Queue(queue) => queue.try_send(line.to_string()).is_ok(),
        }
    }
}

pub enum Inbound {
    Open {
        client: ClientId,
        sink: ClientSink,
        peer: String,
    },
    Line {
        client: ClientId,
        line: String,
    },
    Closed {
        client: ClientId,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    Stdio,
    WebSocket,
    Leader,
}

impl Transport {
    fn as_str(self) -> &'static str {
        match self {
            Transport::Stdio => "stdio",
            Transport::WebSocket => "websocket",
            Transport::Leader => "leader",
        }
    }
}

/// Debug log sink shared by the hub and its transport threads.
pub type HubLog = Arc<dyn Fn(&str) + Send + Sync>;

pub struct HubConfig {
    pub transport: Transport,
    /// Public address: `stdio`, the `ws://` URL, or the leader socket path.
    pub endpoint: String,
    /// Leader only: stop once no client is connected and no turn runs.
    pub exit_on_disconnect: bool,
    /// Set by signals and by `_codsh/leader/shutdown`.
    pub stop: Arc<AtomicBool>,
    /// Confinement this process runs under, reported to every client.
    pub sandbox: Value,
    pub log: Option<HubLog>,
}

impl HubConfig {
    pub fn stdio() -> Self {
        Self {
            transport: Transport::Stdio,
            endpoint: "stdio".into(),
            exit_on_disconnect: true,
            stop: Arc::new(AtomicBool::new(false)),
            sandbox: Value::Null,
            log: None,
        }
    }
}

/// Live sessions a shared process keeps at once. Each one is a dsh process.
pub const MAX_LIVE_SESSIONS: usize = 8;
/// Notifications of a running turn kept for a client that attaches late.
const LIVE_LOG_LIMIT: usize = 4096;
/// Leader grace after the last client leaves, so a quick reconnect finds
/// the running state instead of a fresh process.
const LEADER_IDLE_GRACE: Duration = Duration::from_secs(2);
/// A leader nobody ever connected to stops after this.
const LEADER_FIRST_CLIENT_WAIT: Duration = Duration::from_secs(60);

/// Hub-originated notifications. ACP reserves `_`-prefixed names for
/// implementation extensions; none of these claim an `x.ai/*` contract.
pub const PROMPT_COMPLETE: &str = "_codsh/prompt_complete";
pub const PERMISSION_RESOLVED: &str = "_codsh/permission_resolved";
pub const STALE_RESPONSE: &str = "_codsh/stale_response";
pub const RUNTIME_EXITED: &str = "_codsh/runtime_exited";
pub const LEADER_INFO: &str = "_codsh/leader/info";
pub const LEADER_SHUTDOWN: &str = "_codsh/leader/shutdown";

/// One dsh process. It serves at most one live session.
struct Runtime {
    client: AcpClient,
    effective: EffectiveConfig,
    cwd: PathBuf,
    /// This process's own permission policy. Two live sessions in one
    /// shared process must not read each other's mode.
    policy_path: PathBuf,
}

struct Turn {
    request: u64,
    client: ClientId,
    response_id: Value,
    text: String,
    message_id: String,
    user_chunk_sent: bool,
}

struct Approval {
    /// The id every client sees. dsh ids are per process and would collide.
    public_id: Value,
    dsh_id: Value,
    request: Value,
}

struct Live {
    rt: Runtime,
    // The lock file stays open for the life of the session.
    #[allow(dead_code)]
    owner: SessionOwner,
    cwd: String,
    mode: PermissionMode,
    mode_locked: bool,
    turn: Option<Turn>,
    approval: Option<Approval>,
    /// Updates of the running turn, for a client that attaches mid-turn.
    live_log: Vec<Value>,
    live_log_truncated: bool,
}

struct Client {
    sink: ClientSink,
    initialized: bool,
    session: Option<String>,
    peer: String,
}

struct Hub {
    launch: EditorLaunch,
    config: HubConfig,
    inbound: Receiver<Inbound>,
    clients: BTreeMap<ClientId, Client>,
    dead: Vec<ClientId>,
    /// A connected dsh with no session: the capability probe from
    /// `initialize`, reused by the first `session/new` in the same cwd.
    spare: Option<Runtime>,
    live: BTreeMap<String, Live>,
    upstream: Option<(bool, bool)>,
    current: ClientId,
    next_approval: u64,
    stdio_closed: bool,
    ever_connected: bool,
    idle_since: Instant,
    started: Instant,
    started_unix: u64,
}

static RUNTIME_SEQ: AtomicU64 = AtomicU64::new(1);

pub fn serve(launch: EditorLaunch, sandbox: Value) -> io::Result<()> {
    let (tx, rx) = mpsc::channel();
    let _ = tx.send(Inbound::Open {
        client: 1,
        sink: ClientSink::Writer(Box::new(io::stdout())),
        peer: "stdio".into(),
    });
    // Buffer editor lines before initialize connects to dsh. A blocking read
    // inside initialize would drop a pipelined session/new until too late.
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(Inbound::Closed { client: 1 });
                    break;
                }
                Ok(_) => {
                    if tx.send(Inbound::Line { client: 1, line }).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let mut config = HubConfig::stdio();
    config.sandbox = sandbox;
    run_hub(launch, config, rx)
}

/// Run the ACP hub until its transport ends. dsh remains the only executor
/// and durable writer; the hub routes, never executes.
pub fn run_hub(
    launch: EditorLaunch,
    config: HubConfig,
    inbound: Receiver<Inbound>,
) -> io::Result<()> {
    let started_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let mut hub = Hub {
        launch,
        config,
        inbound,
        clients: BTreeMap::new(),
        dead: Vec::new(),
        spare: None,
        live: BTreeMap::new(),
        upstream: None,
        current: 0,
        next_approval: 1,
        stdio_closed: false,
        ever_connected: false,
        idle_since: Instant::now(),
        started: Instant::now(),
        started_unix,
    };
    let result = hub.run();
    hub.shutdown_all();
    result
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

impl Hub {
    fn log(&self, message: &str) {
        if let Some(log) = &self.config.log {
            log(message);
        }
    }

    fn run(&mut self) -> io::Result<()> {
        loop {
            if self.config.stop.load(Ordering::SeqCst) {
                break;
            }
            match self.inbound.recv_timeout(POLL) {
                Ok(message) => {
                    self.inbound_message(message);
                    // Take what is already queued before pumping, so a burst
                    // of pipelined requests keeps its order and pace.
                    for _ in 0..64 {
                        match self.inbound.try_recv() {
                            Ok(message) => self.inbound_message(message),
                            Err(_) => break,
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    if self.config.transport == Transport::Stdio {
                        self.stdio_closed = true;
                    } else if self.clients.is_empty() {
                        break;
                    }
                }
            }
            self.pump_all();
            self.reap_dead();
            if self.should_exit() {
                break;
            }
        }
        Ok(())
    }

    fn busy(&self) -> bool {
        self.live
            .values()
            .any(|live| live.turn.is_some() || live.approval.is_some())
    }

    fn should_exit(&self) -> bool {
        match self.config.transport {
            Transport::Stdio => {
                self.stdio_closed && self.live.values().all(|live| live.turn.is_none())
            }
            Transport::Leader => {
                if !self.config.exit_on_disconnect || !self.clients.is_empty() || self.busy() {
                    return false;
                }
                if self.ever_connected {
                    self.idle_since.elapsed() >= LEADER_IDLE_GRACE
                } else {
                    self.started.elapsed() >= LEADER_FIRST_CLIENT_WAIT
                }
            }
            Transport::WebSocket => false,
        }
    }

    fn inbound_message(&mut self, message: Inbound) {
        match message {
            Inbound::Open { client, sink, peer } => {
                self.log(&format!("client {client} connected ({peer})"));
                self.ever_connected = true;
                self.clients.insert(
                    client,
                    Client {
                        sink,
                        initialized: false,
                        session: None,
                        peer,
                    },
                );
            }
            Inbound::Line { client, line } => {
                if !self.clients.contains_key(&client) {
                    return;
                }
                self.current = client;
                self.handle_line(&line);
            }
            Inbound::Closed { client } => {
                self.disconnect(client);
                if self.config.transport == Transport::Stdio {
                    self.stdio_closed = true;
                }
            }
        }
    }

    /// A client went away. Its session keeps running: a disconnect is not a
    /// cancel, and the turn's result stays with the dsh session.
    fn disconnect(&mut self, client: ClientId) {
        let Some(removed) = self.clients.remove(&client) else {
            return;
        };
        self.log(&format!(
            "client {client} disconnected ({}); session {} keeps running",
            removed.peer,
            removed.session.as_deref().unwrap_or("-")
        ));
        if self.clients.is_empty() {
            self.idle_since = Instant::now();
        }
    }

    fn reap_dead(&mut self) {
        for client in std::mem::take(&mut self.dead) {
            self.disconnect(client);
        }
    }

    fn shutdown_all(&mut self) {
        let ids: Vec<String> = self.live.keys().cloned().collect();
        for id in ids {
            if let Some(live) = self.live.remove(&id) {
                live.rt.shutdown();
            }
        }
        if let Some(spare) = self.spare.take() {
            spare.shutdown();
        }
    }

    fn attached(&self, session_id: &str) -> Vec<ClientId> {
        self.clients
            .iter()
            .filter(|(_, client)| client.session.as_deref() == Some(session_id))
            .map(|(id, _)| *id)
            .collect()
    }

    fn send_to(&mut self, client: ClientId, message: &Value) {
        let line = message.to_string();
        if let Some(entry) = self.clients.get_mut(&client)
            && !entry.sink.send(&line)
            && !self.dead.contains(&client)
        {
            self.dead.push(client);
        }
    }

    fn broadcast(&mut self, session_id: &str, message: &Value, except: Option<ClientId>) {
        for client in self.attached(session_id) {
            if Some(client) != except {
                self.send_to(client, message);
            }
        }
    }

    fn notify_all(
        &mut self,
        session_id: &str,
        method: &str,
        params: Value,
        except: Option<ClientId>,
    ) {
        let message = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        self.broadcast(session_id, &message, except);
    }

    fn handle_line(&mut self, line: &str) {
        if line.trim().is_empty() {
            return;
        }
        match serde_json::from_str::<Value>(line.trim()) {
            Ok(message) => self.dispatch(message),
            Err(_) => self.write_current(&json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": -32700, "message": "Parse error" },
            })),
        }
    }

    fn write_current(&mut self, message: &Value) {
        let client = self.current;
        self.send_to(client, message);
    }

    fn result(&mut self, id: &Value, result: Value) {
        self.write_current(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    fn error(&mut self, id: &Value, code: i64, message: &str) {
        self.write_current(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        }));
    }

    fn current_session(&self) -> Option<String> {
        self.clients
            .get(&self.current)
            .and_then(|client| client.session.clone())
    }

    fn dispatch(&mut self, message: Value) {
        let id = message.get("id").cloned();
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string);
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let Some(method) = method else {
            if let Some(id) = id {
                self.client_response(id, &message);
            }
            return;
        };
        let Some(id) = id else {
            if method == "session/cancel" {
                let _ = self.cancel(&params);
            }
            return;
        };
        let initialized = self
            .clients
            .get(&self.current)
            .is_some_and(|client| client.initialized);
        if method == LEADER_INFO {
            let info = self.info();
            return self.result(&id, info);
        }
        if method == LEADER_SHUTDOWN {
            if self.config.transport != Transport::Leader {
                return self.error(
                    &id,
                    -32601,
                    &format!("Method not found: {method}; only a leader stops on request"),
                );
            }
            self.log("shutdown requested by a client");
            self.result(&id, json!({ "stopping": true, "pid": std::process::id() }));
            self.config.stop.store(true, Ordering::SeqCst);
            return;
        }
        if !initialized && method != "initialize" {
            return self.error(&id, -32002, "initialize is required before other methods");
        }
        match method.as_str() {
            "initialize" => self.initialize(&id),
            "authenticate" => self.error(
                &id,
                -32601,
                "Method not found: authenticate; this agent does not advertise auth methods",
            ),
            "session/new" => self.session_new(&id, &params),
            "session/load" => self.session_resume(&id, &params, true),
            "session/resume" => self.session_resume(&id, &params, false),
            "session/list" => self.session_list(&id, &params),
            "session/close" => self.session_close(&id, &params),
            "session/prompt" => self.session_prompt(&id, &params),
            "session/set_config_option" => self.session_config(&id, &params),
            "session/cancel" => match self.cancel(&params) {
                Ok(()) => self.result(&id, json!({})),
                Err(error) => self.error(&id, -32602, &error),
            },
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

    /// A client answered a request the hub sent: today only permission
    /// prompts. The first answer for a live prompt wins; any other is stale
    /// and is told so instead of reaching dsh.
    fn client_response(&mut self, id: Value, message: &Value) {
        let session = self.current_session();
        let found = session.as_ref().and_then(|session| {
            self.live.get(session).and_then(|live| {
                live.approval
                    .as_ref()
                    .filter(|approval| approval.public_id == id)
                    .map(|approval| (session.clone(), approval.dsh_id.clone()))
            })
        });
        let Some((session_id, dsh_id)) = found else {
            let message = json!({
                "jsonrpc": "2.0",
                "method": STALE_RESPONSE,
                "params": {
                    "requestId": id,
                    "sessionId": session,
                    "reason": "no pending request with this id in your session; it was already answered, cancelled, or never sent to you",
                }
            });
            self.write_current(&message);
            return;
        };
        let outcome = message
            .pointer("/result/outcome/outcome")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                if message.get("error").is_some() {
                    "error".into()
                } else {
                    "unknown".into()
                }
            });
        let option = message
            .pointer("/result/outcome/optionId")
            .cloned()
            .unwrap_or(Value::Null);
        let forwarded = if let Some(error) = message.get("error").cloned() {
            json!({ "jsonrpc": "2.0", "id": dsh_id, "error": error })
        } else {
            json!({
                "jsonrpc": "2.0",
                "id": dsh_id,
                "result": message.get("result").cloned().unwrap_or(Value::Null),
            })
        };
        if let Some(live) = self.live.get_mut(&session_id) {
            live.rt.client.note_permission_answered(&dsh_id);
            let _ = live.rt.client.write_message(forwarded);
            live.approval = None;
        }
        let answered_by = self.current;
        self.notify_all(
            &session_id,
            PERMISSION_RESOLVED,
            json!({
                "sessionId": session_id,
                "requestId": id,
                "outcome": outcome,
                "optionId": option,
                "clientId": answered_by,
            }),
            Some(answered_by),
        );
    }

    fn server_meta(&self, client: ClientId) -> Value {
        json!({
            "transport": self.config.transport.as_str(),
            "endpoint": self.config.endpoint,
            "shared": self.config.transport != Transport::Stdio,
            "clientId": client,
            "pid": std::process::id(),
            "version": env!("CARGO_PKG_VERSION"),
            "executor": "dsh",
            "writer": "one dsh process per live session; other clients observe it and send requests through this process",
            "maxLiveSessions": MAX_LIVE_SESSIONS,
            "liveSessions": self.live.keys().cloned().collect::<Vec<_>>(),
            "attach": "session/load or session/resume of a session this process runs attaches without a second executor; saved turns, the running turn, and a pending permission request are sent again",
            "concurrentPrompt": "refused while the session runs a turn; nothing is queued or executed twice",
            "notifications": [PROMPT_COMPLETE, PERMISSION_RESOLVED, STALE_RESPONSE, RUNTIME_EXITED],
            "sandbox": self.config.sandbox,
        })
    }

    fn info(&self) -> Value {
        let sessions = self
            .live
            .iter()
            .map(|(id, live)| {
                json!({
                    "sessionId": id,
                    "cwd": live.cwd,
                    "attachedClients": self.attached(id),
                    "turnRunning": live.turn.is_some(),
                    "turnClient": live.turn.as_ref().map(|turn| turn.client),
                    "approvalPending": live.approval.is_some(),
                    "runtimePid": live.rt.client.pid(),
                    "permissionMode": live.mode.as_str(),
                })
            })
            .collect::<Vec<_>>();
        json!({
            "pid": std::process::id(),
            "version": env!("CARGO_PKG_VERSION"),
            "transport": self.config.transport.as_str(),
            "endpoint": self.config.endpoint,
            "startedAt": self.started_unix,
            "clients": self.clients.keys().copied().collect::<Vec<_>>(),
            "sessions": sessions,
            "exitOnDisconnect": self.config.transport == Transport::Leader && self.config.exit_on_disconnect,
            "sandbox": self.config.sandbox,
        })
    }

    fn initialize(&mut self, id: &Value) {
        if self.upstream.is_none() {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            match Runtime::connect(&self.launch, &cwd, None) {
                Ok(runtime) => {
                    self.upstream = Some((runtime.client.can_list, runtime.client.can_resume));
                    self.spare = Some(runtime);
                }
                Err(error) => {
                    return self.error(
                        id,
                        -32603,
                        &format!("Execution unavailable: dsh ACP did not connect: {error}"),
                    );
                }
            }
        }
        let Some((can_list, can_resume)) = self.upstream else {
            return self.error(id, -32603, "Execution unavailable: dsh ACP did not connect");
        };
        let client = self.current;
        if let Some(entry) = self.clients.get_mut(&client) {
            entry.initialized = true;
        }
        let mut extensions = Map::new();
        for entry in extension_inventory() {
            extensions.insert(
                entry.method,
                json!({ "status": entry.status, "reason": entry.reason }),
            );
        }
        let server = self.server_meta(client);
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
                        "codsh/server": server,
                        "codsh/upstream": {
                            "agent": "dsh",
                            "protocolVersion": PROTOCOL_VERSION,
                            "loadSession": false,
                            "sessionCapabilities": {
                                "list": can_list,
                                "resume": can_resume,
                                "close": true
                            }
                        }
                    }
                },
                "authMethods": []
            }),
        );
    }

    /// Leave the current session. It closes only when nobody else watches it
    /// and nothing is running or waiting on an answer; otherwise it stays
    /// live for the other clients and for a reconnect.
    fn detach(&mut self, client: ClientId) -> Result<(), String> {
        let Some(session_id) = self
            .clients
            .get(&client)
            .and_then(|entry| entry.session.clone())
        else {
            return Ok(());
        };
        let alone = self.attached(&session_id).len() == 1;
        if alone
            && self
                .live
                .get(&session_id)
                .is_some_and(|live| live.turn.is_some())
        {
            return Err("a prompt is already in flight".into());
        }
        if let Some(entry) = self.clients.get_mut(&client) {
            entry.session = None;
        }
        if alone {
            self.close_live(&session_id);
        }
        Ok(())
    }

    fn close_live(&mut self, session_id: &str) {
        if let Some(mut live) = self.live.remove(session_id) {
            let _ = live.rt.client.close_session(REQUEST_TIMEOUT);
            live.rt.shutdown();
        }
    }

    /// Make room for one more live session. A session nobody is attached to
    /// and nothing runs in is kept only for a reconnect; it is the first to
    /// go. Busy or watched sessions are never evicted.
    fn at_capacity(&mut self, id: &Value) -> bool {
        if self.live.len() < MAX_LIVE_SESSIONS {
            return false;
        }
        let idle = self
            .live
            .iter()
            .find(|(session_id, live)| {
                live.turn.is_none()
                    && live.approval.is_none()
                    && self.attached(session_id).is_empty()
            })
            .map(|(session_id, _)| session_id.clone());
        if let Some(session_id) = idle {
            self.log(&format!(
                "closing unattached idle session {session_id} to make room"
            ));
            self.close_live(&session_id);
            return false;
        }
        self.error(
            id,
            -32603,
            &format!(
                "this process already runs {MAX_LIVE_SESSIONS} live sessions that are busy or watched; close one or attach to it"
            ),
        );
        true
    }

    fn take_runtime(&mut self, cwd: &Path, session_id: Option<&str>) -> Result<Runtime, String> {
        if session_id.is_none()
            && let Some(spare) = self.spare.take()
        {
            let wanted = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
            if spare.cwd == wanted {
                return Ok(spare);
            }
            self.spare = Some(spare);
        }
        Runtime::connect(&self.launch, cwd, session_id)
    }

    fn join(&mut self, client: ClientId, session_id: &str) {
        if let Some(entry) = self.clients.get_mut(&client) {
            entry.session = Some(session_id.to_string());
        }
    }

    fn session_new(&mut self, id: &Value, params: &Value) {
        let Some(cwd) = absolute_cwd(params) else {
            return self.error(id, -32602, "cwd must be an absolute path");
        };
        let client = self.current;
        if let Err(error) = self.detach(client) {
            return self.error(id, -32603, &error);
        }
        if self.at_capacity(id) {
            return;
        }
        let mut runtime = match self.take_runtime(Path::new(&cwd), None) {
            Ok(runtime) => runtime,
            Err(error) => {
                return self.error(
                    id,
                    -32603,
                    &format!("Execution unavailable: dsh ACP did not connect: {error}"),
                );
            }
        };
        runtime.client.editor_mcp = editor_mcp_servers(params);
        let session_id = match runtime.client.new_session(Path::new(&cwd), REQUEST_TIMEOUT) {
            Ok(session_id) => session_id,
            Err(error) => {
                runtime.shutdown();
                return self.error(id, -32603, &error.message);
            }
        };
        let mut live = match Live::hold(runtime, &session_id, &cwd) {
            Ok(live) => live,
            Err((mut runtime, error)) => {
                let _ = runtime.client.close_session(REQUEST_TIMEOUT);
                runtime.shutdown();
                return self.error(id, -32603, &error);
            }
        };
        // The spawn patch already carries a saved advertised route. Apply it
        // on this session so the returned options match a later load.
        // set_config_option needs the session id.
        if let Err(error) = crate::apply_live_selection(&mut live.rt.client, &live.rt.effective) {
            let _ = live.rt.client.close_session(REQUEST_TIMEOUT);
            live.rt.shutdown();
            return self.error(id, -32603, &error);
        }
        let options = live.public_options();
        self.live.insert(session_id.clone(), live);
        self.join(client, &session_id);
        self.log(&format!("client {client} created session {session_id}"));
        self.result(
            id,
            json!({ "sessionId": session_id, "configOptions": options }),
        );
    }

    fn session_resume(&mut self, id: &Value, params: &Value, replay: bool) {
        let Some(session_id) = params
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return self.error(id, -32602, "sessionId is required");
        };
        let Some(cwd) = absolute_cwd(params) else {
            return self.error(id, -32602, "cwd must be an absolute path");
        };
        let client = self.current;
        if self.current_session().as_deref() == Some(session_id.as_str()) {
            return self.error(
                id,
                -32602,
                &format!("session is already active: {session_id}"),
            );
        }
        if self.live.contains_key(&session_id) {
            return self.attach(id, &session_id, replay);
        }
        if self.upstream.is_some_and(|(_, can_resume)| !can_resume) {
            return self.error(
                id,
                -32601,
                "Method not found: dsh did not advertise session/resume",
            );
        }
        let dsh_home = self.dsh_home();
        let history = match session_history::load_session(&dsh_home, &session_id) {
            Ok(history) => history,
            Err(error) => return self.error(id, -32602, &error.message),
        };
        if let Err(error) = self.detach(client) {
            return self.error(id, -32603, &error);
        }
        if self.at_capacity(id) {
            return;
        }
        // The session's mode file is read before the child starts, so dsh
        // runs that policy instead of the mode of a previous session.
        let runtime = match self.take_runtime(Path::new(&cwd), Some(&session_id)) {
            Ok(runtime) => runtime,
            Err(error) => return self.error(id, -32603, &error),
        };
        // Take the write owner before dsh attaches. A live terminal or editor
        // already holds this lock; dsh would otherwise answer with a generic
        // internal error and a second executor.
        let mut live = match Live::hold(runtime, &session_id, &cwd) {
            Ok(live) => live,
            Err((runtime, error)) => {
                runtime.shutdown();
                return self.error(id, -32602, &error);
            }
        };
        live.rt.client.editor_mcp = editor_mcp_servers(params);
        if let Err(error) =
            live.rt
                .client
                .resume_session(&session_id, Path::new(&cwd), REQUEST_TIMEOUT)
        {
            live.rt.shutdown();
            return self.error(id, -32602, &error.message);
        }
        // Same advertised-value apply the terminal uses on resume. The
        // selection file can change after this process connected.
        live.rt.effective.refresh_saved_selection();
        if let Err(error) = crate::apply_live_selection(&mut live.rt.client, &live.rt.effective) {
            let _ = live.rt.client.close_session(REQUEST_TIMEOUT);
            live.rt.shutdown();
            return self.error(id, -32603, &error);
        }
        let options = live.public_options();
        self.live.insert(session_id.clone(), live);
        self.join(client, &session_id);
        self.log(&format!("client {client} resumed session {session_id}"));
        if replay {
            self.replay(&session_id, &history.turns);
        }
        self.result(id, json!({ "configOptions": options }));
    }

    /// Join a session this process already runs. No second dsh attaches and
    /// nothing is re-executed: the client gets saved history, the running
    /// turn so far, and a permission request that still waits.
    fn attach(&mut self, id: &Value, session_id: &str, replay: bool) {
        let client = self.current;
        if let Err(error) = self.detach(client) {
            return self.error(id, -32603, &error);
        }
        let running = self.live.get(session_id).and_then(|live| {
            live.turn
                .as_ref()
                .map(|turn| (turn.client, turn.text.clone()))
        });
        if replay {
            let dsh_home = self.dsh_home();
            let mut turns = session_history::load_session(&dsh_home, session_id)
                .map(|restored| restored.turns)
                .unwrap_or_default();
            // The running turn may already be partly on disk. It is sent
            // from memory below, with its live status, not as history.
            if let Some((_, text)) = &running
                && turns
                    .last()
                    .is_some_and(|turn| turn.user.trim() == text.trim())
            {
                turns.pop();
            }
            self.replay(session_id, &turns);
        }
        let Some(live) = self.live.get(session_id) else {
            return self.error(id, -32603, &format!("session ended: {session_id}"));
        };
        let options = live.public_options();
        let log = live.live_log.clone();
        let truncated = live.live_log_truncated;
        let approval = live
            .approval
            .as_ref()
            .map(|approval| approval.request.clone());
        self.join(client, session_id);
        self.log(&format!(
            "client {client} attached to live session {session_id}"
        ));
        // Like history replay, the running turn so far arrives before the
        // load response, so the client has the full picture when it resolves.
        for message in log {
            self.send_to(client, &message);
        }
        self.result(
            id,
            json!({
                "configOptions": options,
                "_meta": {
                    "codsh/attached": true,
                    "codsh/turn": {
                        "running": running.is_some(),
                        "clientId": running.as_ref().map(|(owner, _)| *owner),
                        "replayTruncated": truncated,
                    }
                }
            }),
        );
        if let Some(request) = approval {
            self.send_to(client, &request);
        }
    }

    fn dsh_home(&self) -> PathBuf {
        self.spare
            .as_ref()
            .map(|runtime| runtime.effective.dsh_home.clone())
            .or_else(|| {
                self.live
                    .values()
                    .next()
                    .map(|live| live.rt.effective.dsh_home.clone())
            })
            .unwrap_or_else(|| PathBuf::from(std::env::var_os("DSH_HOME").unwrap_or_default()))
    }

    fn replay(&mut self, session_id: &str, turns: &[RestoredTurn]) {
        let client = self.current;
        for (index, turn) in turns.iter().enumerate() {
            let message_id = format!("restored-{index}");
            let mut updates = Vec::new();
            if !turn.user.is_empty() {
                updates.push(json!({
                    "sessionUpdate": "user_message_chunk",
                    "messageId": message_id,
                    "content": { "type": "text", "text": turn.user }
                }));
            }
            if !turn.thought.is_empty() {
                updates.push(json!({
                    "sessionUpdate": "agent_thought_chunk",
                    "messageId": message_id,
                    "content": { "type": "text", "text": turn.thought }
                }));
            }
            if !turn.answer.is_empty() {
                updates.push(json!({
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": message_id,
                    "content": { "type": "text", "text": turn.answer }
                }));
            }
            for tool in &turn.tools {
                updates.push(json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": tool.id,
                    "title": tool.title,
                    "status": replay_tool_status(&tool.status),
                    "kind": "other",
                    "content": tool_content(&tool.result, &tool.diff)
                }));
            }
            for update in updates {
                let message = json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": { "sessionId": session_id, "update": update }
                });
                self.send_to(client, &message);
            }
        }
    }

    fn session_list(&mut self, id: &Value, params: &Value) {
        if self.upstream.is_some_and(|(can_list, _)| !can_list) {
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
        // A live runtime is never borrowed for this: its request wait would
        // drop the streamed updates of a running turn.
        if self.spare.is_none() {
            let process_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            match Runtime::connect(&self.launch, &process_cwd, None) {
                Ok(runtime) => self.spare = Some(runtime),
                Err(error) => {
                    return self.error(
                        id,
                        -32603,
                        &format!("Execution unavailable: dsh ACP did not connect: {error}"),
                    );
                }
            }
        }
        let Some(spare) = self.spare.as_mut() else {
            return self.error(id, -32603, "Execution unavailable: dsh ACP did not connect");
        };
        match spare.client.list_sessions(&cwd, REQUEST_TIMEOUT) {
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

    fn session_close(&mut self, id: &Value, params: &Value) {
        let Some(session_id) = params
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return self.error(id, -32602, "sessionId is required");
        };
        if self.current_session().as_deref() != Some(session_id.as_str()) {
            return self.error(id, -32602, &format!("unknown session: {session_id}"));
        }
        let client = self.current;
        let others = self.attached(&session_id).len().saturating_sub(1);
        if others > 0 {
            // Other clients still watch it: this client leaves, the session
            // and any running turn stay.
            if let Some(entry) = self.clients.get_mut(&client) {
                entry.session = None;
            }
            return self.result(
                id,
                json!({ "_meta": { "codsh/detached": true, "codsh/otherClients": others } }),
            );
        }
        if self
            .live
            .get(&session_id)
            .is_some_and(|live| live.turn.is_some())
        {
            return self.error(
                id,
                -32603,
                "a prompt is running in this session; send session/cancel first",
            );
        }
        let closed = match self.live.get_mut(&session_id) {
            Some(live) => live.rt.client.close_session(REQUEST_TIMEOUT),
            None => Ok(()),
        };
        match closed {
            Ok(()) => {
                if let Some(entry) = self.clients.get_mut(&client) {
                    entry.session = None;
                }
                if let Some(live) = self.live.remove(&session_id) {
                    live.rt.shutdown();
                }
                self.result(id, json!({}))
            }
            Err(error) => self.error(id, -32603, &error.message),
        }
    }

    fn session_prompt(&mut self, id: &Value, params: &Value) {
        let Some(session_id) = params
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return self.error(id, -32602, "sessionId is required");
        };
        if self.current_session().as_deref() != Some(session_id.as_str()) {
            return self.error(id, -32602, &format!("unknown session: {session_id}"));
        }
        let client = self.current;
        let text = prompt_text(params);
        let Some(live) = self.live.get_mut(&session_id) else {
            return self.error(id, -32602, &format!("unknown session: {session_id}"));
        };
        if let Some(turn) = &live.turn {
            let message = if turn.client == client {
                "a prompt is already in flight".to_string()
            } else {
                format!(
                    "a prompt is already in flight: client {} runs a turn in session {session_id}; this prompt was not executed",
                    turn.client
                )
            };
            return self.error(id, -32603, &message);
        }
        if text.trim().is_empty() {
            return self.error(id, -32602, "prompt text is required");
        }
        let request = match live.rt.client.submit_prompt(&text) {
            Ok(request) => request,
            Err(error) => return self.error(id, -32603, &error.message),
        };
        live.live_log.clear();
        live.live_log_truncated = false;
        live.turn = Some(Turn {
            request,
            client,
            response_id: id.clone(),
            text,
            message_id: format!("editor-{request}"),
            user_chunk_sent: false,
        });
    }

    fn session_config(&mut self, id: &Value, params: &Value) {
        let Some(session_id) = params
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return self.error(id, -32602, "sessionId is required");
        };
        let Some(config_id) = params.get("configId").and_then(Value::as_str) else {
            return self.error(id, -32602, "configId is required");
        };
        let Some(value) = params.get("value").and_then(Value::as_str) else {
            return self.error(id, -32602, "value must be a string");
        };
        if self.current_session().as_deref() != Some(session_id.as_str()) {
            return self.error(id, -32602, &format!("unknown session: {session_id}"));
        }
        let Some(live) = self.live.get_mut(&session_id) else {
            return self.error(id, -32602, &format!("unknown session: {session_id}"));
        };
        if live.turn.is_some() && config_id != "permission_mode" {
            // dsh's request wait would discard the running turn's stream for
            // every observer. The change is refused, not queued.
            return self.error(
                id,
                -32603,
                "a prompt is running in this session; change this option after it finishes",
            );
        }
        let outcome = if config_id == "permission_mode" {
            live.set_permission_mode(value, &session_id)
                .map_err(|error| (-32602, error))
        } else {
            match live
                .rt
                .client
                .set_config_option(config_id, value, REQUEST_TIMEOUT)
            {
                // Persist before answering. A later prompt must not be what
                // first writes the shared selection file.
                Ok(_) => live
                    .persist_advertised_selection()
                    .map(|()| live.public_options())
                    .map_err(|error| (-32603, error)),
                Err(error) => Err((-32602, error.message)),
            }
        };
        match outcome {
            Ok(options) => {
                let client = self.current;
                self.result(id, json!({ "configOptions": options.clone() }));
                // Every other observer gets the same option list, before any
                // later update of this session.
                self.notify_all(
                    &session_id,
                    "session/update",
                    json!({
                        "sessionId": session_id,
                        "update": {
                            "sessionUpdate": "config_option_update",
                            "configOptions": options,
                            "_meta": { "codsh/clientId": client }
                        }
                    }),
                    Some(client),
                );
            }
            Err((code, error)) => self.error(id, code, &error),
        }
    }

    fn cancel(&mut self, params: &Value) -> Result<(), String> {
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if self.current_session().as_deref() != Some(session_id.as_str()) {
            return Err(format!("unknown session: {session_id}"));
        }
        let Some(live) = self.live.get_mut(&session_id) else {
            return Err(format!("unknown session: {session_id}"));
        };
        live.rt
            .client
            .cancel_prompt()
            .map_err(|error| error.message)?;
        // cancel_prompt also answered dsh's pending permission as cancelled.
        if let Some(approval) = live.approval.take() {
            let client = self.current;
            self.notify_all(
                &session_id,
                PERMISSION_RESOLVED,
                json!({
                    "sessionId": session_id,
                    "requestId": approval.public_id,
                    "outcome": "cancelled",
                    "clientId": client,
                }),
                None,
            );
        }
        Ok(())
    }

    fn pump_all(&mut self) {
        if let Some(spare) = self.spare.as_mut() {
            let events = spare.client.pump(Duration::ZERO);
            if events
                .iter()
                .any(|event| matches!(event, AcpEvent::Disconnected { .. }))
                && let Some(spare) = self.spare.take()
            {
                spare.shutdown();
            }
        }
        let ids: Vec<String> = self.live.keys().cloned().collect();
        for session_id in ids {
            let events = match self.live.get_mut(&session_id) {
                Some(live) => live.rt.client.pump(Duration::ZERO),
                None => continue,
            };
            for event in events {
                if !self.live.contains_key(&session_id) {
                    break;
                }
                self.session_event(&session_id, event);
            }
        }
    }

    fn record(&mut self, session_id: &str, message: Value) {
        if let Some(live) = self.live.get_mut(session_id) {
            if live.live_log.len() < LIVE_LOG_LIMIT {
                live.live_log.push(message.clone());
            } else {
                live.live_log_truncated = true;
            }
        }
        self.broadcast(session_id, &message, None);
    }

    fn update(&mut self, session_id: &str, update: Value) {
        let message = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "sessionId": session_id, "update": update }
        });
        self.record(session_id, message);
    }

    fn emit_user_chunk(&mut self, session_id: &str) {
        let Some(turn) = self
            .live
            .get_mut(session_id)
            .and_then(|live| live.turn.as_mut())
        else {
            return;
        };
        if turn.user_chunk_sent || turn.text.is_empty() {
            return;
        }
        turn.user_chunk_sent = true;
        let update = json!({
            "sessionUpdate": "user_message_chunk",
            "messageId": turn.message_id,
            "content": { "type": "text", "text": turn.text }
        });
        self.update(session_id, update);
    }

    fn session_event(&mut self, session_id: &str, event: AcpEvent) {
        if let AcpEvent::Disconnected { detail } = &event {
            return self.runtime_exited(session_id, detail);
        }
        let Some((request, message_id)) = self.live.get(session_id).and_then(|live| {
            live.turn
                .as_ref()
                .map(|turn| (turn.request, turn.message_id.clone()))
        }) else {
            return;
        };
        match event {
            AcpEvent::Thought {
                text,
                message_id: dsh_id,
                ..
            } => {
                self.emit_user_chunk(session_id);
                self.update(
                    session_id,
                    json!({
                        "sessionUpdate": "agent_thought_chunk",
                        "messageId": id_or(&dsh_id, &message_id),
                        "content": { "type": "text", "text": text }
                    }),
                );
            }
            AcpEvent::Answer {
                text,
                message_id: dsh_id,
                ..
            } => {
                self.emit_user_chunk(session_id);
                self.update(
                    session_id,
                    json!({
                        "sessionUpdate": "agent_message_chunk",
                        "messageId": id_or(&dsh_id, &message_id),
                        "content": { "type": "text", "text": text }
                    }),
                );
            }
            AcpEvent::ToolCall {
                tool_call_id,
                title,
                kind,
                status,
                raw_input,
                content,
                diff,
                ..
            } => {
                self.emit_user_chunk(session_id);
                let body = if content.as_array().is_some_and(|items| !items.is_empty()) {
                    content
                } else {
                    json!(tool_content("", &diff))
                };
                self.update(
                    session_id,
                    json!({
                        "sessionUpdate": "tool_call",
                        "toolCallId": tool_call_id,
                        "title": title,
                        "kind": kind,
                        "status": status,
                        "rawInput": raw_input,
                        "content": body
                    }),
                );
            }
            AcpEvent::ToolCallUpdate {
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
                self.update(
                    session_id,
                    json!({
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": tool_call_id,
                        "status": status,
                        "content": body
                    }),
                );
            }
            AcpEvent::PermissionRequest {
                request_id,
                tool_call_id,
                options,
                ..
            } => {
                let public_id = json!(format!("codsh-approval-{}", self.next_approval));
                self.next_approval += 1;
                let request = json!({
                    "jsonrpc": "2.0",
                    "id": public_id,
                    "method": "session/request_permission",
                    "params": {
                        "sessionId": session_id,
                        "toolCall": { "toolCallId": tool_call_id },
                        "options": options.iter().map(|option| json!({
                            "optionId": option.option_id,
                            "name": option.name,
                            "kind": option.kind
                        })).collect::<Vec<_>>()
                    }
                });
                if let Some(live) = self.live.get_mut(session_id) {
                    live.approval = Some(Approval {
                        public_id,
                        dsh_id: request_id,
                        request: request.clone(),
                    });
                }
                // Not kept in the turn log: a late client gets the request
                // only while it still waits, from `approval`.
                self.broadcast(session_id, &request, None);
            }
            AcpEvent::PermissionCancelled { .. } => {
                let approval = self
                    .live
                    .get_mut(session_id)
                    .and_then(|live| live.approval.take());
                if let Some(approval) = approval {
                    self.notify_all(
                        session_id,
                        PERMISSION_RESOLVED,
                        json!({
                            "sessionId": session_id,
                            "requestId": approval.public_id,
                            "outcome": "cancelled",
                        }),
                        None,
                    );
                }
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
                self.update(session_id, Value::Object(update));
            }
            AcpEvent::PromptFinished {
                request_id,
                stop_reason,
                ..
            } if request_id == request => {
                self.finish_turn(session_id, Ok(stop_reason));
            }
            AcpEvent::RpcError {
                request_id: Some(request_id),
                message,
                ..
            } if request_id == request => {
                self.finish_turn(session_id, Err(message));
            }
            _ => {}
        }
    }

    fn finish_turn(&mut self, session_id: &str, outcome: Result<String, String>) {
        let Some(live) = self.live.get_mut(session_id) else {
            return;
        };
        let Some(turn) = live.turn.take() else {
            return;
        };
        live.live_log.clear();
        live.live_log_truncated = false;
        let unanswered = live.approval.take();
        let response = match &outcome {
            Ok(stop_reason) => json!({
                "jsonrpc": "2.0",
                "id": turn.response_id,
                "result": { "stopReason": stop_reason }
            }),
            Err(message) => json!({
                "jsonrpc": "2.0",
                "id": turn.response_id,
                "error": { "code": -32603, "message": message }
            }),
        };
        // The request id belongs to the submitting connection. A client that
        // left mid-turn gets no answer here; after it reattaches, the saved
        // turn is in the replay.
        self.send_to(turn.client, &response);
        if let Some(approval) = unanswered {
            self.notify_all(
                session_id,
                PERMISSION_RESOLVED,
                json!({
                    "sessionId": session_id,
                    "requestId": approval.public_id,
                    "outcome": "cancelled",
                }),
                None,
            );
        }
        let mut params = json!({ "sessionId": session_id, "clientId": turn.client });
        match outcome {
            Ok(stop_reason) => params["stopReason"] = json!(stop_reason),
            Err(message) => params["error"] = json!(message),
        }
        self.notify_all(session_id, PROMPT_COMPLETE, params, Some(turn.client));
    }

    /// The dsh process ended. That is not a client disconnect: the session
    /// is no longer live here and a running turn has no result. Its external
    /// effects are unknown, and nothing is retried.
    fn runtime_exited(&mut self, session_id: &str, detail: &str) {
        let Some(live) = self.live.remove(session_id) else {
            return;
        };
        let attached = self.attached(session_id);
        self.log(&format!("dsh for session {session_id} exited: {detail}"));
        let interrupted = live.turn.is_some();
        if let Some(turn) = &live.turn {
            let response = json!({
                "jsonrpc": "2.0",
                "id": turn.response_id,
                "error": {
                    "code": -32603,
                    "message": format!(
                        "Execution runtime exited: {detail}. The running turn has no result; its external effects are unknown and were not retried."
                    )
                }
            });
            self.send_to(turn.client, &response);
        }
        let message = json!({
            "jsonrpc": "2.0",
            "method": RUNTIME_EXITED,
            "params": {
                "sessionId": session_id,
                "detail": detail,
                "turnInterrupted": interrupted,
                "effects": if interrupted { "unknown" } else { "none-running" },
            }
        });
        for client in attached {
            self.send_to(client, &message);
            if let Some(entry) = self.clients.get_mut(&client) {
                entry.session = None;
            }
        }
        live.rt.shutdown();
    }
}

/// MCP servers the editor declared on session/new or session/resume. They
/// are mounted after configured servers; a configured name wins.
fn editor_mcp_servers(params: &Value) -> Vec<Value> {
    params
        .get("mcpServers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

impl Runtime {
    fn connect(
        launch: &EditorLaunch,
        cwd: &Path,
        session_id: Option<&str>,
    ) -> Result<Self, String> {
        let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let input = config::LoadInput {
            home: PathBuf::from(std::env::var_os("HOME").unwrap_or_default()),
            dsh_home: PathBuf::from(std::env::var_os("DSH_HOME").unwrap_or_default()),
            // Trust and project config follow the session's workspace, not
            // wherever the shared process happened to start.
            cwd: cwd.clone(),
            grok_home: std::env::var_os("GROK_HOME").map(PathBuf::from),
            env: env.clone().into_iter().collect(),
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
            cli_subagents: Default::default(),
        };
        if input.dsh_home.as_os_str().is_empty() {
            return Err("missing isolated DSH_HOME; use codsh --rust agent stdio".into());
        }
        let mut effective = config::load_from(input.clone());
        effective.permission.interactive = false;
        crate::apply_saved_session_mode(&mut effective, session_id)?;
        // Same spawn patch as the terminal: compaction, pruner, trust gate,
        // and a saved advertised route that is not a catalog id.
        let applied =
            config::apply_to_dsh(&effective, &input.env).map_err(|error| error.to_string())?;
        let policy_path = effective.dsh_home.join(RUNTIME_POLICY_DIR).join(format!(
            "{}-{}.json",
            std::process::id(),
            RUNTIME_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        permission::write_policy_to(&policy_path, &effective.permission).map_err(|error| {
            format!(
                "couldn't write permission policy to {}: {error}; refusing rather than dropping deny rules",
                policy_path.display()
            )
        })?;
        let mut extra = config::credential_env(&effective, &input.env);
        extra.extend(config::permission_env(&effective));
        extra.extend(config::compact_env(&effective));
        extra.extend(config::web_env(&effective));
        extra.extend(crate::worktree::dsh_env(&effective.grok_home));
        extra.retain(|(key, _)| key != "CODSH_PERMISSION_POLICY");
        extra.push((
            "CODSH_PERMISSION_POLICY".into(),
            policy_path.display().to_string(),
        ));
        let mcp_tag = format!("editor{}", RUNTIME_SEQ.fetch_add(1, Ordering::Relaxed));
        if let Ok(pair) = crate::mcp::plan_env(&effective, &env, &mcp_tag) {
            extra.push(pair);
        }
        let spawned = acp::dsh_spawn_spec(cwd.clone(), &effective.dsh_home, &extra, applied)
            .map_err(|error| error.message)
            .and_then(|spec| AcpClient::spawn(spec).map_err(|error| error.to_string()));
        let mut client = match spawned {
            Ok(client) => client,
            Err(error) => {
                let _ = std::fs::remove_file(&policy_path);
                return Err(error);
            }
        };
        if let Err(error) = client.initialize(REQUEST_TIMEOUT) {
            client.shutdown();
            let _ = std::fs::remove_file(&policy_path);
            return Err(error.message);
        }
        Ok(Self {
            client,
            effective,
            cwd,
            policy_path,
        })
    }

    fn shutdown(mut self) {
        self.client.shutdown();
        let _ = std::fs::remove_file(&self.policy_path);
    }
}

impl Live {
    fn hold(rt: Runtime, session_id: &str, cwd: &str) -> Result<Self, (Box<Runtime>, String)> {
        let owner = match SessionOwner::acquire(&rt.effective.dsh_home, session_id) {
            Ok(owner) => owner,
            Err(error) => return Err((Box::new(rt), error.message)),
        };
        let _ = crate::session_owner::write_last_session(
            &rt.effective.dsh_home,
            session_id,
            Path::new(cwd),
        );
        let mode = rt.effective.permission.mode;
        let mode_locked = rt.effective.permission.always_approve_locked;
        Ok(Self {
            rt,
            owner,
            cwd: cwd.to_string(),
            mode,
            mode_locked,
            turn: None,
            approval: None,
            live_log: Vec::new(),
            live_log_truncated: false,
        })
    }

    fn public_options(&self) -> Vec<Value> {
        let mut options = Vec::new();
        for option in &self.rt.client.config_options {
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
        let mode_choices = ["ask", "auto", "always-approve", "dontAsk", "acceptEdits"]
            .into_iter()
            .map(|value| json!({ "value": value, "name": value }))
            .collect::<Vec<_>>();
        options.push(json!({
            "id": "permission_mode",
            "name": "Permission mode",
            "category": "mode",
            "type": "select",
            "currentValue": self.mode.as_str(),
            "options": mode_choices
        }));
        options
    }

    fn set_permission_mode(&mut self, value: &str, session_id: &str) -> Result<Vec<Value>, String> {
        let mode = PermissionMode::parse(value)?;
        if mode == PermissionMode::AlwaysApprove && self.mode_locked {
            return Err(self
                .rt
                .effective
                .permission
                .lock_source
                .clone()
                .unwrap_or_else(|| "always-approve is locked".into()));
        }
        let mut policy = self.rt.effective.permission.clone();
        policy.mode = mode;
        policy.mode_source = "session".into();
        // Only this session's dsh reads this file. Another live session in
        // the same process keeps its own mode.
        permission::write_policy_to(&self.rt.policy_path, &policy)
            .map_err(|error| error.to_string())?;
        crate::session_owner::write_session_mode(
            &self.rt.effective.dsh_home,
            session_id,
            mode.as_str(),
        )
        .map_err(|error| error.to_string())?;
        self.rt.effective.permission = policy;
        self.mode = mode;
        Ok(self.public_options())
    }

    /// Write the advertised route to the same selection file the terminal
    /// saves in `apply_catalog_choice` and reapplies after resume.
    fn persist_advertised_selection(&mut self) -> Result<(), String> {
        let model_value = self
            .rt
            .client
            .config_option("model")
            .and_then(|option| option.current.clone());
        let Some(model_value) = model_value else {
            return Ok(());
        };
        let catalog = self.rt.effective.catalog();
        let choice = catalog
            .iter()
            .find(|choice| choice.acp_value == model_value);
        let model_id = choice
            .map(|choice| choice.id.clone())
            .or_else(|| models::parse_acp_model_value(&model_value).map(|(_, model)| model))
            .unwrap_or_else(|| model_value.clone());
        let effort = self
            .rt
            .client
            .config_option("reasoning_effort")
            .and_then(|option| option.current.clone())
            .filter(|value| !value.is_empty());
        let matched = choice.is_some();
        let effective = &mut self.rt.effective;
        if matched {
            effective.default_model = Some(model_id.clone());
            effective.unmatched_saved_model = None;
        } else {
            // Not a catalog id. Keep the catalog default out of the live route.
            effective.unmatched_saved_model = Some(model_id.clone());
        }
        effective.saved_acp_value = Some(model_value.clone());
        effective.default_effort = effort.clone();
        models::save_selection_route(
            &effective.grok_home,
            &model_id,
            effort.as_deref(),
            Some(model_value.as_str()),
        )
        .map_err(|error| error.to_string())
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
