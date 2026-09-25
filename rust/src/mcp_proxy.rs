//! The stdio launcher dsh runs for each configured MCP server, and the
//! `mcp doctor` probe.
//!
//! `__mcp-stdio-proxy` sits between dsh and the real server. Bytes pass
//! through unchanged. It records why a server stopped (spawn error, exit
//! code, startup timeout) in `<dir>/<name>.status`, keeps the server's
//! stderr in `<dir>/<name>.stderr.log`, stops a server that does not answer
//! `initialize` within its startup timeout, and answers a `tools/call` that
//! outlives its per-tool timeout with a JSON-RPC error while sending the
//! server `notifications/cancelled`.

use crate::mcp::{self, CliOutcome, DiscoverInput, Discovery, Entry, State, Transport};
use serde_json::{Value as JsonValue, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Default, PartialEq)]
struct ProxyArgs {
    name: String,
    dir: PathBuf,
    startup_ms: u64,
    tool_ms: u64,
    tool_timeouts: HashMap<String, u64>,
    cwd: Option<PathBuf>,
    program: String,
    args: Vec<String>,
}

fn parse_proxy(args: &[String]) -> Result<ProxyArgs, String> {
    let mut parsed = ProxyArgs {
        startup_ms: mcp::DEFAULT_STARTUP_TIMEOUT_MS,
        tool_ms: mcp::DEFAULT_TOOL_TIMEOUT_MS,
        ..ProxyArgs::default()
    };
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if flag == "--" {
            let mut rest = args[index + 1..].iter().cloned();
            parsed.program = rest.next().ok_or("missing server program")?;
            parsed.args = rest.collect();
            break;
        }
        index += 1;
        let value = args
            .get(index)
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag {
            "--name" => parsed.name = value.clone(),
            "--dir" => parsed.dir = PathBuf::from(value),
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
            "--cwd" => parsed.cwd = Some(PathBuf::from(value)),
            other => return Err(format!("unknown proxy flag {other}")),
        }
        index += 1;
    }
    if parsed.name.is_empty() || parsed.program.is_empty() {
        return Err("usage: __mcp-stdio-proxy --name N --dir D [...] -- PROGRAM [ARGS]".into());
    }
    Ok(parsed)
}

#[derive(Default)]
struct Shared {
    init_id: Option<String>,
    initialized: bool,
    /// The server's error answer to initialize, if it refused.
    init_error: Option<String>,
    calls: HashMap<String, (Instant, String, JsonValue)>,
    timed_out: HashSet<String>,
    stdin_closed: Option<Instant>,
}

fn id_key(value: &JsonValue) -> String {
    value.to_string()
}

fn write_status(path: &Path, text: &str) {
    let _ = fs::write(path, format!("{text}\n"));
}

fn write_line(out: &Mutex<io::Stdout>, line: &str) -> io::Result<()> {
    let mut out = out.lock().unwrap_or_else(|poison| poison.into_inner());
    out.write_all(line.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()
}

fn write_child(stdin: &Mutex<Option<ChildStdin>>, line: &str) -> io::Result<()> {
    let mut guard = stdin.lock().unwrap_or_else(|poison| poison.into_inner());
    let Some(pipe) = guard.as_mut() else {
        return Err(io::Error::from(io::ErrorKind::BrokenPipe));
    };
    pipe.write_all(line.as_bytes())?;
    pipe.write_all(b"\n")?;
    pipe.flush()
}

fn describe_exit(status: std::process::ExitStatus) -> (String, i32) {
    if let Some(code) = status.code() {
        return (format!("exited with code {code}"), code);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return (format!("killed by signal {signal}"), 128 + signal);
        }
    }
    ("exited".into(), 1)
}

/// Entry point for `codsh-rust __mcp-stdio-proxy ...`. Returns the exit code.
pub fn run_proxy(args: &[String]) -> i32 {
    let parsed = match parse_proxy(args) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("codsh mcp proxy: {error}");
            return 2;
        }
    };
    let _ = fs::create_dir_all(&parsed.dir);
    let status_path = parsed.dir.join(format!("{}.status", parsed.name));
    let log_path = parsed.dir.join(format!("{}.stderr.log", parsed.name));
    let stderr_target = match fs::File::create(&log_path) {
        Ok(file) => Stdio::from(file),
        Err(_) => Stdio::inherit(),
    };
    let mut command = Command::new(&parsed.program);
    command
        .args(&parsed.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr_target);
    if let Some(cwd) = &parsed.cwd {
        command.current_dir(cwd);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            write_status(
                &status_path,
                &format!("failed to start {}: {error}", parsed.program),
            );
            return 127;
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
    let shared = Arc::new(Mutex::new(Shared::default()));
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let child_stdin = Arc::new(Mutex::new(child.stdin.take()));
    let child_stdout = child.stdout.take();

    // dsh -> server
    {
        let shared = Arc::clone(&shared);
        let child_stdin = Arc::clone(&child_stdin);
        let tool_ms = parsed.tool_ms;
        let tool_timeouts = parsed.tool_timeouts.clone();
        thread::spawn(move || {
            let reader = BufReader::new(io::stdin());
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Ok(message) = serde_json::from_str::<JsonValue>(&line) {
                    let method = message.get("method").and_then(JsonValue::as_str);
                    let id = message.get("id").filter(|id| !id.is_null());
                    let mut state = shared.lock().unwrap_or_else(|poison| poison.into_inner());
                    match (method, id) {
                        (Some("initialize"), Some(id)) => state.init_id = Some(id_key(id)),
                        (Some("tools/call"), Some(id)) => {
                            let tool = message
                                .pointer("/params/name")
                                .and_then(JsonValue::as_str)
                                .unwrap_or("")
                                .to_string();
                            let limit = tool_timeouts.get(&tool).copied().unwrap_or(tool_ms);
                            state.calls.insert(
                                id_key(id),
                                (
                                    Instant::now() + Duration::from_millis(limit),
                                    tool,
                                    id.clone(),
                                ),
                            );
                        }
                        (Some("notifications/cancelled"), None) => {
                            if let Some(request) = message.pointer("/params/requestId") {
                                state.calls.remove(&id_key(request));
                            }
                        }
                        _ => {}
                    }
                }
                if write_child(&child_stdin, &line).is_err() {
                    // The server is gone; its exit is reported by the wait loop.
                    return;
                }
            }
            // EOF from dsh: close the server's stdin so it can exit.
            child_stdin
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .take();
            shared
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .stdin_closed = Some(Instant::now());
        });
    }

    // server -> dsh
    let reader_thread = child_stdout.map(|pipe| {
        let shared = Arc::clone(&shared);
        let stdout = Arc::clone(&stdout);
        thread::spawn(move || {
            let reader = BufReader::new(pipe);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Ok(message) = serde_json::from_str::<JsonValue>(&line)
                    && message.get("method").is_none()
                    && let Some(id) = message.get("id").filter(|id| !id.is_null())
                {
                    let key = id_key(id);
                    let mut state = shared.lock().unwrap_or_else(|poison| poison.into_inner());
                    if state.timed_out.remove(&key) {
                        // dsh already got the timeout error for this id.
                        continue;
                    }
                    state.calls.remove(&key);
                    if state.init_id.as_deref() == Some(key.as_str()) {
                        if message.get("result").is_some() {
                            state.initialized = true;
                        } else if let Some(error) = message.get("error") {
                            let text = error
                                .get("message")
                                .and_then(JsonValue::as_str)
                                .unwrap_or("error");
                            let code = error.get("code").and_then(JsonValue::as_i64).unwrap_or(0);
                            state.init_error = Some(format!("initialize failed ({code}): {text}"));
                        }
                    }
                }
                if write_line(&stdout, &line).is_err() {
                    break;
                }
            }
        })
    });

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if let Some(handle) = reader_thread {
                    let _ = handle.join();
                }
                let (initialized, init_error, closed) = {
                    let state = shared.lock().unwrap_or_else(|poison| poison.into_inner());
                    (
                        state.initialized,
                        state.init_error.clone(),
                        state.stdin_closed.is_some(),
                    )
                };
                if closed && init_error.is_none() {
                    // dsh closed the connection first: an ordinary stop, not
                    // a failure to report.
                    return describe_exit(status).1;
                }
                let (text, code) = describe_exit(status);
                let status_text = match init_error {
                    Some(error) => format!("{error}; then {text}"),
                    None if initialized => format!("{text} after initialize"),
                    None => format!("{text} before answering initialize"),
                };
                write_status(&status_path, &status_text);
                return code;
            }
            Ok(None) => {}
            Err(error) => {
                write_status(&status_path, &format!("wait failed: {error}"));
                return 1;
            }
        }
        if terminate.load(Ordering::Relaxed) {
            stop(&mut child);
            return 143;
        }
        let mut expired = Vec::new();
        let mut stop_reason = None;
        {
            let mut state = shared.lock().unwrap_or_else(|poison| poison.into_inner());
            if !state.initialized && started.elapsed() > Duration::from_millis(parsed.startup_ms) {
                stop_reason = Some(format!(
                    "startup timed out after {:.1}s without an initialize response",
                    parsed.startup_ms as f64 / 1000.0
                ));
            }
            if stop_reason.is_none()
                && state
                    .stdin_closed
                    .is_some_and(|closed| closed.elapsed() > Duration::from_secs(3))
            {
                // dsh is gone and the server ignored stdin EOF: stop it quietly.
                drop(state);
                stop(&mut child);
                return 0;
            }
            let now = Instant::now();
            let keys: Vec<String> = state
                .calls
                .iter()
                .filter(|(_, (deadline, _, _))| *deadline <= now)
                .map(|(key, _)| key.clone())
                .collect();
            for key in keys {
                if let Some((_, tool, id)) = state.calls.remove(&key) {
                    state.timed_out.insert(key);
                    expired.push((tool, id));
                }
            }
        }
        if let Some(reason) = stop_reason {
            write_status(&status_path, &reason);
            stop(&mut child);
            return 124;
        }
        for (tool, id) in expired {
            let limit = parsed
                .tool_timeouts
                .get(&tool)
                .copied()
                .unwrap_or(parsed.tool_ms);
            let error = json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32001,
                    "message": format!("MCP tool call '{tool}' timed out after {:.1}s (codsh tool timeout)", limit as f64 / 1000.0),
                },
            });
            let _ = write_line(&stdout, &error.to_string());
            let cancel = json!({
                "jsonrpc": "2.0",
                "method": "notifications/cancelled",
                "params": { "requestId": id, "reason": "tool timeout" },
            });
            let _ = write_child(&child_stdin, &cancel.to_string());
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

// ---------------------------------------------------------------------------
// mcp doctor
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct Check {
    pub label: String,
    pub passed: bool,
    pub detail: Option<String>,
    pub hint: Option<String>,
}

impl Check {
    fn pass(label: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            passed: true,
            detail: Some(detail.into()),
            hint: None,
        }
    }

    fn fail(label: impl Into<String>, detail: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            passed: false,
            detail: Some(detail.into()),
            hint: Some(hint.into()),
        }
    }

    fn json(&self) -> JsonValue {
        let mut object = serde_json::Map::new();
        object.insert("label".into(), json!(self.label));
        object.insert("passed".into(), json!(self.passed));
        if let Some(detail) = &self.detail {
            object.insert("detail".into(), json!(detail));
        }
        if let Some(hint) = &self.hint {
            object.insert("hint".into(), json!(hint));
        }
        JsonValue::Object(object)
    }
}

const PROTOCOL_VERSION: &str = "2025-06-18";

fn initialize_request() -> JsonValue {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "codsh-mcp-doctor", "version": env!("CARGO_PKG_VERSION") },
        },
    })
}

/// Admission rule for one listed tool (Grok `qualify_mcp_tool_name` plus
/// dsh's function-name normalization).
fn admission_problem(server: &str, tool: &str) -> Option<String> {
    if tool.is_empty() {
        return Some("empty tool name".into());
    }
    if !tool
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Some("tool name has characters outside [A-Za-z0-9_-]".into());
    }
    if tool.contains("__") || tool.starts_with('_') {
        return Some("ambiguous server__tool key".into());
    }
    let public = format!("mcp__{server}__{tool}");
    if public.len() > 64 {
        return Some(format!(
            "dsh shortens `{public}` to 64 characters with a hash suffix"
        ));
    }
    None
}

fn tools_check(server: &str, tools: &[String]) -> Check {
    if tools.is_empty() {
        return Check::fail(
            "0 tools discovered",
            "server returned an empty tool list",
            "check server config",
        );
    }
    let skipped: Vec<String> = tools
        .iter()
        .filter_map(|tool| admission_problem(server, tool).map(|why| format!("{tool} ({why})")))
        .collect();
    if skipped.is_empty() {
        return Check::pass(format!("{} tools discovered", tools.len()), "");
    }
    Check::fail(
        format!(
            "{} tools listed, {} not kept as listed",
            tools.len(),
            skipped.len()
        ),
        skipped.join("; "),
        "rename the tool or server so each segment is a valid MCP id",
    )
}

fn probe_stdio(
    name: &str,
    command: &str,
    args: &[String],
    server_env: &BTreeMap<String, String>,
    server_cwd: Option<&str>,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    startup: Duration,
) -> Vec<Check> {
    let mut checks = Vec::new();
    let run_cwd = server_cwd
        .map(|dir| {
            let path = Path::new(dir);
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                cwd.join(path)
            }
        })
        .unwrap_or_else(|| cwd.to_path_buf());
    let mut lookup = env.clone();
    if let Some(path) = server_env.get("PATH") {
        lookup.insert("PATH".into(), path.clone());
    }
    let Some(program) = mcp::resolve_program(command, &run_cwd, &lookup) else {
        checks.push(Check::fail(
            "command not found",
            command,
            "verify the binary exists and is in PATH",
        ));
        return checks;
    };
    checks.push(Check::pass("command found", program.display().to_string()));
    let started = Instant::now();
    let mut child = match Command::new(&program)
        .args(args)
        .envs(server_env)
        .current_dir(&run_cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            checks.push(Check::fail(
                "spawn failed",
                error.to_string(),
                "check command and permissions",
            ));
            return checks;
        }
    };
    let (tx, rx) = mpsc::channel::<Option<String>>();
    if let Some(stdout) = child.stdout.take() {
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(Some(line)).is_err() {
                    return;
                }
            }
            let _ = tx.send(None);
        });
    }
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    if let Some(mut stderr) = child.stderr.take() {
        let buf = Arc::clone(&stderr_buf);
        thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while let Ok(read) = stderr.read(&mut chunk) {
                if read == 0 {
                    break;
                }
                let mut text = buf.lock().unwrap_or_else(|poison| poison.into_inner());
                if text.len() < 64 * 1024 {
                    text.push_str(&String::from_utf8_lossy(&chunk[..read]));
                }
            }
        });
    }
    let mut stdin = child.stdin.take();
    let mut send = |value: JsonValue| -> bool {
        stdin.as_mut().is_some_and(|pipe| {
            pipe.write_all(format!("{value}\n").as_bytes()).is_ok() && pipe.flush().is_ok()
        })
    };
    let stderr_tail = |buf: &Arc<Mutex<String>>| {
        let text = buf
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        let lines: Vec<&str> = text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect();
        let start = lines.len().saturating_sub(3);
        lines[start..].join(" | ")
    };
    let wait_for = |id: u64, deadline: Instant, child: &mut Child| -> Result<JsonValue, String> {
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(format!("no response within {:.1}s", startup.as_secs_f64()));
            }
            match rx.recv_timeout(left.min(Duration::from_millis(100))) {
                Ok(Some(line)) => {
                    let Ok(message) = serde_json::from_str::<JsonValue>(&line) else {
                        continue;
                    };
                    if message.get("id").and_then(JsonValue::as_u64) == Some(id)
                        && message.get("method").is_none()
                    {
                        return Ok(message);
                    }
                }
                Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    thread::sleep(Duration::from_millis(50));
                    let status = child
                        .try_wait()
                        .ok()
                        .flatten()
                        .map(|status| describe_exit(status).0)
                        .unwrap_or_else(|| "closed stdout".into());
                    return Err(status);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    };
    let deadline = started + startup;
    send(initialize_request());
    match wait_for(1, deadline, &mut child) {
        Err(reason) => {
            thread::sleep(Duration::from_millis(50));
            let tail = stderr_tail(&stderr_buf);
            let detail = if tail.is_empty() {
                reason.clone()
            } else {
                format!("{reason}; stderr: {tail}")
            };
            if reason.starts_with("no response") {
                checks.push(Check::fail(
                    "server timed out",
                    detail,
                    "try increasing startup_timeout_sec in config.toml",
                ));
            } else {
                checks.push(Check::fail(
                    "server failed to start",
                    detail,
                    "check server logs",
                ));
            }
        }
        Ok(message) => {
            checks.push(Check::pass(
                "server started",
                format!("{:.1}s", started.elapsed().as_secs_f64()),
            ));
            if let Some(error) = message.get("error") {
                checks.push(Check::fail(
                    "handshake failed",
                    error
                        .get("message")
                        .and_then(JsonValue::as_str)
                        .unwrap_or("error")
                        .to_string(),
                    "check server logs",
                ));
            } else {
                let protocol = message
                    .pointer("/result/protocolVersion")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("unknown");
                checks.push(Check::pass("handshake OK", format!("protocol {protocol}")));
                send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
                let mut tools = Vec::new();
                let mut cursor: Option<String> = None;
                let mut next_id = 2;
                let result = loop {
                    let mut params = json!({});
                    if let Some(cursor) = &cursor {
                        params["cursor"] = json!(cursor);
                    }
                    send(
                        json!({ "jsonrpc": "2.0", "id": next_id, "method": "tools/list", "params": params }),
                    );
                    match wait_for(next_id, Instant::now() + startup, &mut child) {
                        Err(reason) => break Err(reason),
                        Ok(message) => {
                            if let Some(error) = message.get("error") {
                                break Err(error
                                    .get("message")
                                    .and_then(JsonValue::as_str)
                                    .unwrap_or("error")
                                    .to_string());
                            }
                            for tool in message
                                .pointer("/result/tools")
                                .and_then(JsonValue::as_array)
                                .into_iter()
                                .flatten()
                            {
                                if let Some(name) = tool.get("name").and_then(JsonValue::as_str) {
                                    tools.push(name.to_string());
                                }
                            }
                            cursor = message
                                .pointer("/result/nextCursor")
                                .and_then(JsonValue::as_str)
                                .map(str::to_string);
                            if cursor.is_none() || next_id > 50 {
                                break Ok(());
                            }
                            next_id += 1;
                        }
                    }
                };
                match result {
                    Ok(()) => checks.push(tools_check(name, &tools)),
                    Err(reason) => checks.push(Check::fail(
                        "tools/list failed",
                        reason,
                        "check server logs",
                    )),
                }
            }
        }
    }
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    checks
}

fn http_call(
    agent: &ureq::Agent,
    url: &str,
    headers: &BTreeMap<String, String>,
    session: Option<&str>,
    body: &JsonValue,
    id: Option<u64>,
) -> Result<(Option<JsonValue>, Option<String>), String> {
    let mut request = agent
        .post(url)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .set(
            "User-Agent",
            concat!("codsh-rust/", env!("CARGO_PKG_VERSION")),
        );
    for (name, value) in headers {
        request = request.set(name, value);
    }
    if let Some(session) = session {
        request = request.set("Mcp-Session-Id", session);
    }
    let response = match request.send_string(&body.to_string()) {
        Ok(response) => response,
        Err(ureq::Error::Status(code, response)) => {
            let text = response.into_string().unwrap_or_default();
            let clipped: String = text.chars().take(200).collect();
            return Err(format!("HTTP {code}: {clipped}"));
        }
        Err(error) => return Err(error.to_string()),
    };
    let session = response.header("mcp-session-id").map(str::to_string);
    let content_type = response.content_type().to_string();
    let Some(id) = id else {
        return Ok((None, session));
    };
    let text = response.into_string().map_err(|error| error.to_string())?;
    let candidates: Vec<String> = if content_type.contains("event-stream") {
        text.lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(|data| data.trim().to_string())
            .collect()
    } else {
        vec![text]
    };
    for candidate in candidates {
        if let Ok(message) = serde_json::from_str::<JsonValue>(&candidate)
            && message.get("id").and_then(JsonValue::as_u64) == Some(id)
        {
            return Ok((Some(message), session));
        }
    }
    Err("no JSON-RPC response in the HTTP reply".into())
}

fn probe_http(
    name: &str,
    url: &str,
    headers: &BTreeMap<String, String>,
    startup: Duration,
) -> Vec<Check> {
    let mut checks = Vec::new();
    let agent = ureq::AgentBuilder::new()
        .timeout(startup)
        .redirects(0)
        .build();
    let started = Instant::now();
    let (message, session) =
        match http_call(&agent, url, headers, None, &initialize_request(), Some(1)) {
            Ok((Some(message), session)) => (message, session),
            Ok((None, _)) => unreachable!("initialize has an id"),
            Err(reason) => {
                checks.push(Check::fail(
                    "server failed to start",
                    reason,
                    "check the URL, headers, and network",
                ));
                return checks;
            }
        };
    checks.push(Check::pass(
        "server started",
        format!("{:.1}s", started.elapsed().as_secs_f64()),
    ));
    if let Some(error) = message.get("error") {
        checks.push(Check::fail(
            "handshake failed",
            error
                .get("message")
                .and_then(JsonValue::as_str)
                .unwrap_or("error")
                .to_string(),
            "check server logs",
        ));
        return checks;
    }
    let protocol = message
        .pointer("/result/protocolVersion")
        .and_then(JsonValue::as_str)
        .unwrap_or("unknown");
    checks.push(Check::pass("handshake OK", format!("protocol {protocol}")));
    let _ = http_call(
        &agent,
        url,
        headers,
        session.as_deref(),
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        None,
    );
    match http_call(
        &agent,
        url,
        headers,
        session.as_deref(),
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
        Some(2),
    ) {
        Ok((Some(message), _)) => {
            let tools: Vec<String> = message
                .pointer("/result/tools")
                .and_then(JsonValue::as_array)
                .into_iter()
                .flatten()
                .filter_map(|tool| {
                    tool.get("name")
                        .and_then(JsonValue::as_str)
                        .map(str::to_string)
                })
                .collect();
            checks.push(tools_check(name, &tools));
        }
        Ok((None, _)) => {}
        Err(reason) => checks.push(Check::fail(
            "tools/list failed",
            reason,
            "check server logs",
        )),
    }
    checks
}

fn skip_checks(entry: &Entry, disabled: bool) -> Vec<Check> {
    let mut checks = Vec::new();
    match &entry.state {
        State::Untrusted => checks.push(Check::fail(
            "folder untrusted",
            "repo-local (project-scoped) server not started for an untrusted folder",
            "re-run with --trust to allow repo-local servers",
        )),
        State::Invalid(reason) => checks.push(Check::fail(
            "invalid config",
            reason.clone(),
            "fix the server entry",
        )),
        _ => {}
    }
    if disabled {
        let check = Check::fail(
            "disabled in config",
            "server is disabled in config.toml",
            "set enabled = true or remove from disabled_mcp_servers",
        );
        checks.push(if checks.is_empty() {
            check
        } else {
            Check {
                hint: None,
                ..check
            }
        });
    }
    checks
}

pub fn check_entry(
    entry: &Entry,
    discovery: &Discovery,
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> Vec<Check> {
    let skipped = skip_checks(entry, discovery.disabled.contains(&entry.def.name));
    if !skipped.is_empty() {
        return skipped;
    }
    let startup = Duration::from_millis(mcp::startup_timeout_ms(&entry.def, env));
    let mut checks = match &entry.def.transport {
        Transport::Stdio {
            command,
            args,
            env: server_env,
            cwd: server_cwd,
        } => probe_stdio(
            &entry.def.name,
            command,
            args,
            server_env,
            server_cwd.as_deref(),
            cwd,
            env,
            startup,
        ),
        Transport::Http { url, headers } => probe_http(&entry.def.name, url, headers, startup),
        Transport::Sse { .. } => vec![Check::fail(
            "sse unsupported",
            "dsh has no SSE transport",
            "use the server's streamable HTTP endpoint",
        )],
    };
    let tool_secs = entry.def.tool_timeout_sec.unwrap_or(0.0);
    let longest = entry
        .def
        .tool_timeouts
        .values()
        .copied()
        .fold(tool_secs, f64::max);
    if longest * 1000.0 > mcp::DSH_TOOL_CALL_LIMIT_MS as f64 {
        checks.push(Check {
            label: "tool timeout capped".into(),
            passed: true,
            detail: Some(format!(
                "dsh ends each MCP call after {}s, so {longest}s is not reached",
                mcp::DSH_TOOL_CALL_LIMIT_MS / 1000
            )),
            hint: None,
        });
    }
    for note in &entry.def.notes {
        checks.push(Check {
            label: "note".into(),
            passed: true,
            detail: Some(note.clone()),
            hint: None,
        });
    }
    checks
}

pub fn run_doctor(ctx: &DiscoverInput<'_>, json_out: bool, filter: Option<&str>) -> CliOutcome {
    let discovery = mcp::discover(ctx);
    let mut outcome = CliOutcome::default();
    let targets: Vec<&Entry> = discovery
        .entries
        .iter()
        .filter(|entry| filter.is_none_or(|name| entry.def.name == name))
        .collect();
    if let Some(name) = filter
        && targets.is_empty()
    {
        outcome
            .stderr
            .push_str(&format!("MCP server '{name}' not found.\n"));
        if !discovery.entries.is_empty() {
            outcome.stderr.push_str(&format!(
                "Available servers: {}\n",
                discovery.names().join(", ")
            ));
        }
        outcome.code = 1;
        return outcome;
    }
    let mut results = Vec::new();
    for entry in targets {
        let checks = check_entry(entry, &discovery, ctx.cwd, ctx.env);
        let healthy = checks.iter().all(|check| check.passed);
        results.push((entry, checks, healthy));
    }
    let healthy_count = results.iter().filter(|(_, _, healthy)| *healthy).count();
    let failing_count = results.len() - healthy_count;
    if json_out {
        let sources: Vec<JsonValue> = discovery
            .sources
            .iter()
            .map(|source| {
                let status = match (&source.skipped, source.found) {
                    (Some(reason), _) => json!({ "status": "skipped", "reason": reason }),
                    (None, Some(count)) => json!({ "status": "found", "server_count": count }),
                    (None, None) => json!({ "status": "not_found" }),
                };
                json!({ "path": source.path, "status": status })
            })
            .collect();
        let servers: Vec<JsonValue> = results
            .iter()
            .map(|(entry, checks, healthy)| {
                json!({
                    "name": entry.def.name,
                    "transport": entry.def.transport.kind(),
                    "target": entry.def.transport.target(),
                    "source": entry.def.source.label(),
                    "checks": checks.iter().map(Check::json).collect::<Vec<_>>(),
                    "healthy": healthy,
                })
            })
            .collect();
        let report = json!({
            "sources": sources,
            "servers": servers,
            "healthy_count": healthy_count,
            "failing_count": failing_count,
        });
        outcome.stdout = format!(
            "{}\n",
            serde_json::to_string_pretty(&report).unwrap_or_default()
        );
    } else {
        let mut text = String::from("\nMCP Doctor\n\n  Config sources\n");
        for source in &discovery.sources {
            let status = match (&source.skipped, source.found) {
                (Some(reason), Some(count)) => format!(
                    "{count} server{} (skipped: {reason})",
                    if count == 1 { "" } else { "s" }
                ),
                (Some(reason), None) => format!("skipped ({reason})"),
                (None, Some(count)) => {
                    format!("{count} server{}", if count == 1 { "" } else { "s" })
                }
                (None, None) => "not found".into(),
            };
            text.push_str(&format!("    {:<40} {status}\n", source.path));
        }
        text.push('\n');
        if results.is_empty() {
            text.push_str("  No MCP servers configured.\n  Run `codsh --rust mcp add --help` to get started.\n\n");
        }
        for (entry, checks, _) in &results {
            text.push_str(&format!(
                "  {} ({}: {})\n",
                entry.def.name,
                entry.def.transport.kind(),
                entry.def.transport.target()
            ));
            for check in checks {
                let icon = if check.passed { "\u{2713}" } else { "\u{2717}" };
                match check.detail.as_deref().filter(|detail| !detail.is_empty()) {
                    Some(detail) => {
                        text.push_str(&format!("    {icon} {} ({detail})\n", check.label))
                    }
                    None => text.push_str(&format!("    {icon} {}\n", check.label)),
                }
                if let Some(hint) = &check.hint {
                    text.push_str(&format!("    \u{2192} {hint}\n"));
                }
            }
            text.push('\n');
        }
        if !results.is_empty() {
            text.push_str(&format!(
                "Found {healthy_count} healthy, {failing_count} failing.{}\n\n",
                if failing_count > 0 {
                    " Run `codsh --rust mcp doctor --json` for full diagnostics."
                } else {
                    ""
                }
            ));
        }
        outcome.stdout = text;
    }
    if failing_count > 0 {
        outcome.code = 1;
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_args_keep_server_flags_after_separator() {
        let args: Vec<String> = [
            "--name",
            "fx",
            "--dir",
            "/tmp/x",
            "--startup-timeout-ms",
            "500",
            "--tool-timeout-ms",
            "9000",
            "--tool-timeout",
            "slow=100",
            "--",
            "/bin/server",
            "--name",
            "inner",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let parsed = parse_proxy(&args).unwrap();
        assert_eq!(parsed.name, "fx");
        assert_eq!(parsed.startup_ms, 500);
        assert_eq!(parsed.tool_ms, 9000);
        assert_eq!(parsed.tool_timeouts.get("slow"), Some(&100));
        assert_eq!(parsed.program, "/bin/server");
        assert_eq!(parsed.args, vec!["--name".to_string(), "inner".to_string()]);
        assert!(parse_proxy(&["--name".into(), "fx".into()]).is_err());
    }

    #[test]
    fn admission_flags_ambiguous_and_long_tools() {
        assert!(admission_problem("fx", "echo").is_none());
        assert!(admission_problem("fx", "2fa_enable").is_none());
        assert!(admission_problem("fx", "a__b").is_some());
        assert!(admission_problem("fx", "has space").is_some());
        assert!(admission_problem("fx", &"x".repeat(80)).is_some());
    }
}
