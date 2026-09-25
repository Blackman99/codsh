//! Shared agent processes: `agent serve` (authenticated WebSocket on a
//! loopback port by default), `agent leader` (per-user local socket), the
//! `agent --leader stdio` proxy that auto-starts and reuses a leader, and
//! `leader list|info|kill`.
//!
//! Every transport feeds the same ACP hub (`editor_acp::run_hub`). dsh stays
//! the only executor: one dsh child owns each live session, and other
//! clients observe it through the hub. Nothing here listens unless one of
//! these commands was run explicitly; a plain launch starts no service.

use crate::editor_acp::{self, ClientSink, EditorLaunch, HubConfig, Inbound, Transport};
use crate::ws;
use serde_json::{Value, json};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const DEFAULT_BIND: &str = "127.0.0.1:2419";
/// Per-client queue. A client that stops reading this many lines behind is
/// dropped instead of stalling the others.
const CLIENT_QUEUE: usize = 4096;
const PING_EVERY: Duration = Duration::from_secs(15);
const LEADER_START_WAIT: Duration = Duration::from_secs(15);
const INFO_TIMEOUT: Duration = Duration::from_secs(3);
pub const LEADER_DISCONNECTED: &str = "_codsh/leader_disconnected";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Debug {
    pub enabled: bool,
    pub file: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServeOptions {
    pub bind: String,
    pub secret: Option<String>,
    pub debug: Debug,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaderOptions {
    pub socket: Option<PathBuf>,
    pub exit_on_disconnect: bool,
    pub debug: Debug,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentCommand {
    /// `agent stdio`, local unless `--leader` (or `[cli] use_leader`) picks
    /// the shared leader.
    Stdio {
        leader: Option<bool>,
        socket: Option<PathBuf>,
    },
    Serve(ServeOptions),
    Leader(LeaderOptions),
    Help(&'static str),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LeaderCommand {
    List {
        json: bool,
        socket: Option<PathBuf>,
    },
    Info {
        pid: Option<u32>,
        json: bool,
        socket: Option<PathBuf>,
    },
    Kill {
        socket: Option<PathBuf>,
    },
    Help,
}

fn refused(flag: &str, reason: &str) -> String {
    format!("{flag}: {reason}")
}

/// Parse everything after `agent`. Flags may come before or after the
/// command word, as on the reference client.
pub fn parse_agent(flags: &[&str]) -> Result<AgentCommand, String> {
    let mut command: Option<&str> = None;
    let mut leader = None;
    let mut socket = None;
    let mut bind = None;
    let mut secret = None;
    let mut exit_on_disconnect = true;
    let mut debug = Debug::default();
    let mut help = false;
    let mut index = 0;
    let value = |index: &mut usize, flag: &str| -> Result<String, String> {
        *index += 1;
        flags
            .get(*index)
            .filter(|value| !value.starts_with('-') || value.len() == 1)
            .map(|value| (*value).to_string())
            .ok_or_else(|| format!("missing {flag} value"))
    };
    while index < flags.len() {
        let arg = flags[index];
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value.to_string())),
            _ => (arg, None),
        };
        let take = |index: &mut usize| -> Result<String, String> {
            match &inline {
                Some(value) if !value.is_empty() => Ok(value.clone()),
                Some(_) => Err(format!("missing {name} value")),
                None => value(index, name),
            }
        };
        match name {
            "stdio" | "serve" | "leader" if command.is_none() => command = Some(name),
            "headless" if command.is_none() => {
                return Err(
                    "agent headless: this runs an agent behind the official grok.com relay; codsh has no relay service, so it is refused. Use `agent serve` for authenticated remote clients or `agent leader` for local sharing".into(),
                );
            }
            "--help" | "-h" => help = true,
            "--leader" => leader = Some(true),
            "--no-leader" => leader = Some(false),
            "--leader-socket" => socket = Some(PathBuf::from(take(&mut index)?)),
            "--bind" => bind = Some(take(&mut index)?),
            "--secret" => secret = Some(take(&mut index)?),
            "--debug" => debug.enabled = true,
            "--debug-file" => {
                debug.enabled = true;
                debug.file = Some(PathBuf::from(take(&mut index)?));
            }
            "--no-exit-on-disconnect" => exit_on_disconnect = false,
            "--remote" => {
                return Err(refused(
                    name,
                    "proxying to a remote grok agent needs the official service; not available in codsh",
                ));
            }
            "--grok-ws-url" | "--grok-ws-origin" => {
                return Err(refused(
                    name,
                    "the official Grok WebSocket relay is not available in codsh",
                ));
            }
            "--relay-on-demand" => {
                return Err(refused(
                    name,
                    "codsh has no relay, so there is nothing to start on demand",
                ));
            }
            "--no-auto-update" => {
                return Err(refused(
                    name,
                    "this client runs no update checks, so there is nothing to disable; a later ticket owns the flag",
                ));
            }
            other if other.starts_with("--cursor-worker") => {
                return Err(refused(
                    other,
                    "Cursor worker mode needs the official service; not available in codsh",
                ));
            }
            other => {
                return Err(match command {
                    None if !other.starts_with('-') => format!(
                        "unsupported agent command {other}; use codsh --rust agent stdio, agent serve, or agent leader"
                    ),
                    _ => format!("unexpected argument '{other}' for agent"),
                });
            }
        }
        index += 1;
    }
    let only = |allowed: &[&str], used: bool, flag: &str| -> Result<(), String> {
        if used && !command.is_some_and(|command| allowed.contains(&command)) {
            return Err(format!(
                "{flag} applies to agent {}",
                allowed.join(" or agent ")
            ));
        }
        Ok(())
    };
    if help {
        return Ok(AgentCommand::Help(match command {
            Some("stdio") => "stdio",
            Some("serve") => "serve",
            Some("leader") => "leader",
            _ => "agent",
        }));
    }
    let Some(command) = command else {
        return Err("missing agent command; use codsh --rust agent stdio".into());
    };
    only(&["stdio"], leader.is_some(), "--leader/--no-leader")?;
    only(&["stdio", "leader"], socket.is_some(), "--leader-socket")?;
    only(&["serve"], bind.is_some(), "--bind")?;
    only(&["serve"], secret.is_some(), "--secret")?;
    only(&["serve", "leader"], debug.enabled, "--debug")?;
    only(&["leader"], !exit_on_disconnect, "--no-exit-on-disconnect")?;
    Ok(match command {
        "stdio" => {
            if leader == Some(false) && socket.is_some() {
                return Err("--leader-socket needs the shared leader; drop --no-leader".into());
            }
            AgentCommand::Stdio { leader, socket }
        }
        "serve" => AgentCommand::Serve(ServeOptions {
            bind: bind.unwrap_or_else(|| DEFAULT_BIND.into()),
            secret,
            debug,
        }),
        _ => AgentCommand::Leader(LeaderOptions {
            socket,
            exit_on_disconnect,
            debug,
        }),
    })
}

pub fn parse_leader(flags: &[&str]) -> Result<LeaderCommand, String> {
    let mut command = None;
    let mut json = false;
    let mut pid = None;
    let mut socket = None;
    let mut help = false;
    let mut index = 0;
    while index < flags.len() {
        let arg = flags[index];
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value.to_string())),
            _ => (arg, None),
        };
        let take = |index: &mut usize| -> Result<String, String> {
            if let Some(value) = &inline {
                return Ok(value.clone());
            }
            *index += 1;
            flags
                .get(*index)
                .map(|value| (*value).to_string())
                .ok_or_else(|| format!("missing {name} value"))
        };
        match name {
            "list" | "info" | "kill" if command.is_none() => command = Some(name),
            "--json" => json = true,
            "--help" | "-h" => help = true,
            "--pid" => {
                let raw = take(&mut index)?;
                pid = Some(
                    raw.parse::<u32>()
                        .map_err(|_| format!("invalid --pid value '{raw}'"))?,
                );
            }
            "--leader-socket" => socket = Some(PathBuf::from(take(&mut index)?)),
            other if command.is_none() && !other.starts_with('-') => {
                return Err(format!(
                    "unsupported leader command {other}; use leader list, leader info, or leader kill"
                ));
            }
            other => return Err(format!("unexpected argument '{other}' for leader")),
        }
        index += 1;
    }
    if help {
        return Ok(LeaderCommand::Help);
    }
    if pid.is_some() && command != Some("info") {
        return Err("--pid applies to leader info".into());
    }
    if json && command == Some("kill") {
        return Err("--json applies to leader list or leader info".into());
    }
    Ok(match command {
        Some("list") => LeaderCommand::List { json, socket },
        Some("info") => LeaderCommand::Info { pid, json, socket },
        Some("kill") => LeaderCommand::Kill { socket },
        _ => LeaderCommand::Help,
    })
}

pub fn agent_help(topic: &str) -> String {
    match topic {
        "serve" => format!(
            "Serve ACP over an authenticated WebSocket (route /ws).\n\nUsage: codsh --rust agent serve [--bind ADDR] [--secret SECRET] [--debug] [--debug-file PATH]\n\n  --bind ADDR        listen address (default {DEFAULT_BIND}; a non-loopback address prints a warning)\n  --secret SECRET    shared secret (else GROK_AGENT_SECRET, else a generated one printed once)\n  --debug            log connections and session events to stderr\n  --debug-file PATH  append the debug log to PATH\n\nClients authenticate with `Authorization: Bearer <secret>` or `?server-key=<secret>`.\nOne dsh process owns each live session; other clients attach with session/load.\n--remote, --grok-ws-url, and --grok-ws-origin need the official service and are refused.\n"
        ),
        "leader" => "Run the per-user shared leader on a local socket.\n\nUsage: codsh --rust agent leader [--leader-socket PATH] [--no-exit-on-disconnect] [--debug] [--debug-file PATH]\n\n  --leader-socket PATH     socket path (default $GROK_HOME/leader.sock, or GROK_LEADER_SOCKET)\n  --no-exit-on-disconnect  keep running after the last client leaves\n\nThe socket is mode 0600 and only accepts connections from the same user.\n`agent --leader stdio` starts a leader when none runs and connects to it.\n".to_string(),
        "stdio" => "Serve ACP on stdin/stdout for one editor.\n\nUsage: codsh --rust agent [--leader | --no-leader] [--leader-socket PATH] stdio\n\n  --leader     route this editor through the shared leader (started if needed)\n  --no-leader  run the agent in this process (default; wins over [cli] use_leader)\n\nA sandbox profile other than off keeps the agent in this process.\nWith --leader the leader owns model and permission policy, so -m, --effort,\n--permission-mode, --always-approve, --auto, --allow, and --deny are refused.\n".to_string(),
        _ => format!(
            "Agent Client Protocol endpoints backed by dsh.\n\nUsage: codsh --rust agent [--leader | --no-leader] <COMMAND>\n\nCommands:\n  stdio   one editor on stdin/stdout\n  serve   authenticated WebSocket server (default {DEFAULT_BIND})\n  leader  per-user shared leader on a local socket\n\n`agent headless` needs the official grok.com relay and is refused.\nRun `codsh --rust agent <COMMAND> --help` for details.\n"
        ),
    }
}

pub fn leader_help() -> &'static str {
    "Inspect shared leader processes.\n\nUsage: codsh --rust leader <COMMAND> [--leader-socket PATH]\n\nCommands:\n  list [--json]              leader sockets under $GROK_HOME and their state\n  info [--pid N] [--json]    clients and live sessions of a running leader\n  kill                       stop every live leader and remove stale sockets\n"
}

type Log = editor_acp::HubLog;

fn logger(debug: &Debug) -> io::Result<Option<Log>> {
    if !debug.enabled {
        return Ok(None);
    }
    let file = match &debug.file {
        Some(path) => {
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                std::fs::create_dir_all(parent)?;
            }
            Some(Mutex::new(
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)?,
            ))
        }
        None => None,
    };
    Ok(Some(Arc::new(move |message: &str| {
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs_f64())
            .unwrap_or(0.0);
        let line = format!("[{seconds:.3}] {message}");
        match &file {
            Some(file) => {
                if let Ok(mut file) = file.lock() {
                    let _ = writeln!(file, "{line}");
                }
            }
            None => eprintln!("{line}"),
        }
    })))
}

/// 12 characters from [A-Za-z0-9], like the reference's generated secret.
fn generate_secret() -> io::Result<String> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = String::new();
    let mut bytes = [0u8; 64];
    let mut file = std::fs::File::open("/dev/urandom").map_err(|error| {
        io::Error::other(format!(
            "no system random source for a generated secret ({error}); pass --secret or set GROK_AGENT_SECRET"
        ))
    })?;
    while out.len() < 12 {
        file.read_exact(&mut bytes)?;
        for byte in bytes {
            // Reject the top of the range so every character is equally likely.
            if byte < 248 && out.len() < 12 {
                out.push(ALPHABET[(byte % 62) as usize] as char);
            }
        }
    }
    Ok(out)
}

/// Stop the hub on SIGINT, SIGTERM, or SIGHUP and remember which one came,
/// so the process exits 130, 143, or 129 after cleanup like the terminal.
fn install_signals(stop: &Arc<AtomicBool>) -> io::Result<Arc<AtomicUsize>> {
    let caught = Arc::new(AtomicUsize::new(0));
    #[cfg(unix)]
    {
        for signal in [
            signal_hook::consts::SIGINT,
            signal_hook::consts::SIGTERM,
            signal_hook::consts::SIGHUP,
        ] {
            let stop = Arc::clone(stop);
            let caught = Arc::clone(&caught);
            // SAFETY: the handler only stores to atomics, which is
            // async-signal-safe.
            unsafe {
                signal_hook::low_level::register(signal, move || {
                    caught.store(signal as usize, Ordering::SeqCst);
                    stop.store(true, Ordering::SeqCst);
                })?;
            }
        }
    }
    #[cfg(not(unix))]
    let _ = stop;
    Ok(caught)
}

fn exit_for_signal(caught: &AtomicUsize) {
    #[cfg(unix)]
    {
        let code = match caught.load(Ordering::SeqCst) as i32 {
            signal_hook::consts::SIGINT => 130,
            signal_hook::consts::SIGTERM => 143,
            signal_hook::consts::SIGHUP => 129,
            _ => return,
        };
        std::process::exit(code);
    }
    #[cfg(not(unix))]
    let _ = caught;
}

/// `agent serve`: ACP over WebSocket. The default bind is loopback; the
/// secret is required on every connection.
pub fn run_serve(launch: EditorLaunch, options: ServeOptions, sandbox: Value) -> io::Result<()> {
    let address: SocketAddr = options.bind.parse().map_err(|_| {
        io::Error::other(format!(
            "invalid --bind address '{}'; use IP:PORT such as {DEFAULT_BIND}",
            options.bind
        ))
    })?;
    let env_secret = std::env::var("GROK_AGENT_SECRET")
        .ok()
        .filter(|value| !value.is_empty());
    let (secret, source) = match (options.secret.clone(), env_secret) {
        (Some(secret), _) => (secret, "--secret"),
        (None, Some(secret)) => (secret, "GROK_AGENT_SECRET"),
        (None, None) => (generate_secret()?, "generated"),
    };
    if secret.is_empty() {
        return Err(io::Error::other("--secret must not be empty"));
    }
    let log = logger(&options.debug)?;
    let listener = TcpListener::bind(address)
        .map_err(|error| io::Error::other(format!("couldn't bind {address}: {error}")))?;
    let local = listener.local_addr()?;
    if !local.ip().is_loopback() {
        eprintln!(
            "warning: listening on {local}, which is not a loopback address. Anyone who can reach it and knows the secret can run tools as this user; traffic is not encrypted."
        );
    }
    let shown = if source == "generated" {
        secret.clone()
    } else {
        format!("(from {source})")
    };
    let key = if source == "generated" {
        secret.clone()
    } else {
        "<secret>".into()
    };
    eprintln!(
        "codsh agent server starting...\n  Address: {local}\n  Secret: {shown}\n  WebSocket URL: ws://{local}/ws?server-key={key}"
    );
    let stop = Arc::new(AtomicBool::new(false));
    let caught = install_signals(&stop)?;
    let (tx, rx) = mpsc::channel();
    let next = Arc::new(AtomicU64::new(1));
    let secret = Arc::new(secret);
    {
        let log = log.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let tx = tx.clone();
                let next = Arc::clone(&next);
                let secret = Arc::clone(&secret);
                let log = log.clone();
                thread::spawn(move || serve_connection(stream, &secret, tx, &next, log));
            }
        });
    }
    let config = HubConfig {
        transport: Transport::WebSocket,
        endpoint: format!("ws://{local}/ws"),
        exit_on_disconnect: false,
        stop: Arc::clone(&stop),
        sandbox,
        log,
    };
    let result = editor_acp::run_hub(launch, config, rx);
    exit_for_signal(&caught);
    result
}

fn serve_connection(
    mut stream: TcpStream,
    secret: &str,
    tx: mpsc::Sender<Inbound>,
    next: &AtomicU64,
    log: Option<Log>,
) {
    let peer = stream
        .peer_addr()
        .map(|address| address.to_string())
        .unwrap_or_else(|_| "unknown".into());
    match ws::accept(&mut stream, secret) {
        Ok(ws::Handshake::Accepted) => {}
        Ok(ws::Handshake::Rejected(reason)) => {
            if let Some(log) = &log {
                log(&format!("rejected {peer}: {reason}"));
            }
            return;
        }
        Err(error) => {
            if let Some(log) = &log {
                log(&format!("handshake with {peer} failed: {error}"));
            }
            return;
        }
    }
    let _ = stream.set_read_timeout(None);
    let _ = stream.set_nodelay(true);
    let Ok(writer) = stream.try_clone() else {
        return;
    };
    let writer = Arc::new(Mutex::new(writer));
    let client = next.fetch_add(1, Ordering::Relaxed);
    let (queue, lines) = mpsc::sync_channel::<String>(CLIENT_QUEUE);
    if tx
        .send(Inbound::Open {
            client,
            sink: ClientSink::Queue(queue),
            peer: format!("ws {peer}"),
        })
        .is_err()
    {
        return;
    }
    {
        let writer = Arc::clone(&writer);
        thread::spawn(move || {
            loop {
                let frame = match lines.recv_timeout(PING_EVERY) {
                    Ok(line) => ws::text_frame(&line),
                    Err(mpsc::RecvTimeoutError::Timeout) => ws::ping_frame(),
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                let Ok(mut stream) = writer.lock() else { break };
                if stream.write_all(&frame).is_err() {
                    break;
                }
            }
            // The hub dropped this client (closed or too slow): end the socket
            // so the reader stops too.
            if let Ok(stream) = writer.lock() {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        });
    }
    let mut reader = ws::FrameReader::new();
    loop {
        match reader.next(&mut stream) {
            Ok(ws::Incoming::Text(text)) => {
                if tx.send(Inbound::Line { client, line: text }).is_err() {
                    break;
                }
            }
            Ok(ws::Incoming::Ping(payload)) => {
                if let Ok(mut stream) = writer.lock() {
                    let _ = stream.write_all(&ws::pong_frame(&payload));
                }
            }
            Ok(ws::Incoming::Close) => {
                if let Ok(mut stream) = writer.lock() {
                    let _ = stream.write_all(&ws::close_frame(1000, ""));
                }
                break;
            }
            Err(error) => {
                if let Some(log) = &log {
                    log(&format!("client {client} read ended: {error}"));
                }
                if error.kind() == io::ErrorKind::InvalidData
                    && let Ok(mut stream) = writer.lock()
                {
                    let _ = stream.write_all(&ws::close_frame(1002, "protocol error"));
                }
                break;
            }
        }
    }
    let _ = tx.send(Inbound::Closed { client });
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

/// Leader socket: `--leader-socket`, else `GROK_LEADER_SOCKET`, else
/// `$GROK_HOME/leader.sock`.
pub fn leader_socket(explicit: Option<&Path>, grok_home: &Path) -> PathBuf {
    if let Some(path) = explicit {
        return path.to_path_buf();
    }
    if let Some(path) = std::env::var_os("GROK_LEADER_SOCKET").filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }
    grok_home.join("leader.sock")
}

pub fn lock_path(socket: &Path) -> PathBuf {
    socket.with_extension("lock")
}

/// Unix socket paths are limited to about 104-108 bytes.
const SOCKET_PATH_MAX: usize = 100;

fn check_socket_path(socket: &Path) -> io::Result<()> {
    if socket.as_os_str().len() > SOCKET_PATH_MAX {
        return Err(io::Error::other(format!(
            "leader socket path is too long for a Unix socket ({} bytes, limit {SOCKET_PATH_MAX}): {}; pass a shorter --leader-socket",
            socket.as_os_str().len(),
            socket.display()
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn run_leader(_: EditorLaunch, _: LeaderOptions, _: &Path, _: Value) -> io::Result<()> {
    Err(io::Error::other(
        "agent leader needs Unix domain sockets; it is not available on this platform. Use agent stdio or agent serve",
    ))
}

#[cfg(unix)]
pub fn run_leader(
    launch: EditorLaunch,
    options: LeaderOptions,
    grok_home: &Path,
    sandbox: Value,
) -> io::Result<()> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    use std::os::unix::io::AsRawFd;
    use std::os::unix::net::UnixListener;

    let socket = leader_socket(options.socket.as_deref(), grok_home);
    check_socket_path(&socket)?;
    if let Some(parent) = socket
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    let lock = lock_path(&socket);
    let mut lock_file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock)?;
    let _ = std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o600));
    // SAFETY: flock on a descriptor this function owns.
    let locked = unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
    if !locked {
        let mut text = String::new();
        let _ = lock_file.read_to_string(&mut text);
        let pid = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| value.get("pid").and_then(Value::as_u64));
        return Err(io::Error::other(format!(
            "a leader already runs on {}{}; use codsh --rust leader info",
            socket.display(),
            pid.map(|pid| format!(" (pid {pid})")).unwrap_or_default()
        )));
    }
    match std::fs::symlink_metadata(&socket) {
        Ok(metadata) if metadata.file_type().is_socket() => {
            // We hold the lock, so whoever bound this is gone.
            std::fs::remove_file(&socket)?;
        }
        Ok(_) => {
            return Err(io::Error::other(format!(
                "refusing to replace {}: it exists and is not a socket",
                socket.display()
            )));
        }
        Err(_) => {}
    }
    // SAFETY: umask only changes this process's creation mask. The listener
    // must never exist with group or world access, even briefly.
    let previous = unsafe { libc::umask(0o177) };
    let bound = UnixListener::bind(&socket);
    unsafe { libc::umask(previous) };
    let listener = bound.map_err(|error| {
        io::Error::other(format!("couldn't bind {}: {error}", socket.display()))
    })?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    let started = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let record = json!({
        "pid": std::process::id(),
        "socket": socket,
        "version": env!("CARGO_PKG_VERSION"),
        "startedAt": started,
    });
    lock_file.set_len(0)?;
    use std::io::Seek;
    lock_file.seek(io::SeekFrom::Start(0))?;
    writeln!(lock_file, "{record}")?;
    lock_file.flush()?;
    let log = logger(&options.debug)?;
    if let Some(log) = &log {
        log(&format!(
            "leader {} listening on {}",
            std::process::id(),
            socket.display()
        ));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let caught = install_signals(&stop)?;
    let (tx, rx) = mpsc::channel();
    let next = Arc::new(AtomicU64::new(1));
    {
        let log = log.clone();
        let listener = listener.try_clone()?;
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                if !same_user(&stream) {
                    if let Some(log) = &log {
                        log("refused a connection from another user");
                    }
                    continue;
                }
                let tx = tx.clone();
                let client = next.fetch_add(1, Ordering::Relaxed);
                thread::spawn(move || leader_connection(stream, client, tx));
            }
        });
    }
    let config = HubConfig {
        transport: Transport::Leader,
        endpoint: socket.display().to_string(),
        exit_on_disconnect: options.exit_on_disconnect,
        stop: Arc::clone(&stop),
        sandbox,
        log: log.clone(),
    };
    let result = editor_acp::run_hub(launch, config, rx);
    // This process holds the lock, so the socket at this path is the one it
    // bound.
    if std::fs::symlink_metadata(&socket).is_ok_and(|now| now.file_type().is_socket()) {
        let _ = std::fs::remove_file(&socket);
    }
    let _ = lock_file.set_len(0);
    drop(lock_file);
    if let Some(log) = &log {
        log("leader stopped");
    }
    exit_for_signal(&caught);
    result
}

#[cfg(unix)]
fn same_user(stream: &std::os::unix::net::UnixStream) -> bool {
    use std::os::unix::io::AsRawFd;
    let fd = stream.as_raw_fd();
    // SAFETY: plain credential queries on a connected socket this process owns.
    unsafe {
        let me = libc::geteuid();
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            let mut cred: libc::ucred = std::mem::zeroed();
            let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
            let rc = libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut cred as *mut libc::ucred).cast(),
                &mut len,
            );
            rc == 0 && cred.uid == me
        }
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        {
            let mut uid: libc::uid_t = 0;
            let mut gid: libc::gid_t = 0;
            libc::getpeereid(fd, &mut uid, &mut gid) == 0 && uid == me
        }
    }
}

#[cfg(unix)]
fn leader_connection(
    stream: std::os::unix::net::UnixStream,
    client: u64,
    tx: mpsc::Sender<Inbound>,
) {
    let Ok(mut writer) = stream.try_clone() else {
        return;
    };
    let (queue, lines) = mpsc::sync_channel::<String>(CLIENT_QUEUE);
    if tx
        .send(Inbound::Open {
            client,
            sink: ClientSink::Queue(queue),
            peer: "leader socket".into(),
        })
        .is_err()
    {
        return;
    }
    thread::spawn(move || {
        while let Ok(line) = lines.recv() {
            if writeln!(writer, "{line}").is_err() {
                break;
            }
        }
        let _ = writer.shutdown(std::net::Shutdown::Both);
    });
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) if line.len() > ws::MAX_MESSAGE_BYTES => break,
            Ok(_) => {
                if tx
                    .send(Inbound::Line {
                        client,
                        line: line.clone(),
                    })
                    .is_err()
                {
                    break;
                }
            }
        }
    }
    let _ = tx.send(Inbound::Closed { client });
    let _ = reader.get_ref().shutdown(std::net::Shutdown::Both);
}

enum ProxyEvent {
    Leader(String),
    LeaderEnded,
    Client(String),
    ClientEnded,
    /// Time to confirm the organization identity again (ticket 207).
    Tick,
}

#[cfg(unix)]
fn connect_leader(socket: &Path) -> io::Result<std::os::unix::net::UnixStream> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let metadata = std::fs::symlink_metadata(socket)?;
    if !metadata.file_type().is_socket() {
        return Err(io::Error::other(format!(
            "{} is not a socket",
            socket.display()
        )));
    }
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    if metadata.uid() != me {
        return Err(io::Error::other(format!(
            "refusing leader socket {} owned by uid {}; it must belong to this user",
            socket.display(),
            metadata.uid()
        )));
    }
    std::os::unix::net::UnixStream::connect(socket)
}

#[cfg(unix)]
fn start_leader(socket: &Path) -> io::Result<std::process::Child> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::process::CommandExt;
    let exe = std::env::current_exe()?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(socket.with_extension("log"))?;
    let mut command = std::process::Command::new(exe);
    command
        .arg("agent")
        .arg("leader")
        .arg("--leader-socket")
        .arg(socket)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(log)
        // Own process group: the editor's Ctrl-C or hangup is not the
        // leader's, and other clients keep it.
        .process_group(0);
    command.spawn()
}

#[cfg(not(unix))]
pub fn run_proxy(_: &Path, _: Option<crate::remote_identity::Gate>) -> io::Result<i32> {
    Err(io::Error::other(
        "the shared leader needs Unix domain sockets; use agent --no-leader stdio on this platform",
    ))
}

/// `agent --leader stdio`: connect the editor on stdin/stdout to the
/// leader, starting one if none runs. The leader owns execution; a lost
/// leader fails every request still waiting instead of retrying it.
/// With a `gate` (ticket 207) every client line passes the host's
/// organization identity policy first.
#[cfg(unix)]
pub fn run_proxy(socket: &Path, mut gate: Option<crate::remote_identity::Gate>) -> io::Result<i32> {
    check_socket_path(socket)?;
    if let Some(parent) = socket
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    let stream = match connect_leader(socket) {
        Ok(stream) => stream,
        Err(first) => {
            if std::fs::symlink_metadata(socket).is_ok_and(|metadata| {
                use std::os::unix::fs::FileTypeExt;
                !metadata.file_type().is_socket()
            }) {
                return Err(first);
            }
            let mut child = start_leader(socket)?;
            let deadline = Instant::now() + LEADER_START_WAIT;
            loop {
                if let Ok(stream) = connect_leader(socket) {
                    break stream;
                }
                if let Ok(Some(status)) = child.try_wait() {
                    // Another client may have won the race; its leader is fine.
                    if let Ok(stream) = connect_leader(socket) {
                        break stream;
                    }
                    let log =
                        std::fs::read_to_string(socket.with_extension("log")).unwrap_or_default();
                    let tail: Vec<&str> = log.lines().rev().take(5).collect();
                    return Err(io::Error::other(format!(
                        "the shared leader exited {status} before accepting connections on {}: {}",
                        socket.display(),
                        tail.into_iter().rev().collect::<Vec<_>>().join(" | ")
                    )));
                }
                if Instant::now() >= deadline {
                    return Err(io::Error::other(format!(
                        "the shared leader did not accept connections on {} within {}s",
                        socket.display(),
                        LEADER_START_WAIT.as_secs()
                    )));
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
    };
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    writeln!(
        writer,
        "{}",
        json!({ "jsonrpc": "2.0", "id": "codsh-proxy-info", "method": editor_acp::LEADER_INFO })
    )?;
    let mut first = String::new();
    reader.read_line(&mut first)?;
    let info: Value = serde_json::from_str(first.trim()).unwrap_or(Value::Null);
    let version = info
        .pointer("/result/version")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if version != env!("CARGO_PKG_VERSION") {
        eprintln!(
            "warning: the shared leader at {} runs codsh {version}; this client is {}. Stop it with `codsh --rust leader kill` to start a matching one.",
            socket.display(),
            env!("CARGO_PKG_VERSION")
        );
    }
    let (tx, rx) = mpsc::channel();
    let tick_tx = tx.clone();
    {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => {
                        let _ = tx.send(ProxyEvent::LeaderEnded);
                        break;
                    }
                    Ok(_) => {
                        if tx.send(ProxyEvent::Leader(line.clone())).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        let mut line = String::new();
        loop {
            line.clear();
            match input.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(ProxyEvent::ClientEnded);
                    break;
                }
                Ok(_) => {
                    if tx.send(ProxyEvent::Client(line.clone())).is_err() {
                        break;
                    }
                }
            }
        }
    });
    if let Some(gate) = &gate {
        let tx = tick_tx;
        let interval = gate.recheck_interval();
        thread::spawn(move || {
            loop {
                thread::sleep(interval);
                if tx.send(ProxyEvent::Tick).is_err() {
                    break;
                }
            }
        });
    }
    let mut outstanding: Vec<Value> = Vec::new();
    let mut client_done = false;
    let stdout = io::stdout();
    while let Ok(event) = rx.recv() {
        let event = match (event, gate.as_mut()) {
            (ProxyEvent::Client(line), Some(gate)) => match gate.on_client(&line) {
                crate::remote_identity::Action::Forward(line) => ProxyEvent::Client(line),
                crate::remote_identity::Action::Drop => continue,
                crate::remote_identity::Action::Reply(reply) => {
                    let mut out = stdout.lock();
                    if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() {
                        return Ok(0);
                    }
                    continue;
                }
                crate::remote_identity::Action::Revoke { reply, cancel } => {
                    return Ok(revoke_connection(
                        &mut writer,
                        &stdout,
                        &outstanding,
                        reply,
                        cancel,
                    ));
                }
            },
            (ProxyEvent::Leader(line), Some(gate)) => ProxyEvent::Leader(gate.on_leader(&line)),
            (ProxyEvent::Tick, Some(gate)) => match gate.on_tick() {
                Some(crate::remote_identity::Action::Revoke { reply, cancel }) => {
                    return Ok(revoke_connection(
                        &mut writer,
                        &stdout,
                        &outstanding,
                        reply,
                        cancel,
                    ));
                }
                _ => continue,
            },
            (ProxyEvent::Tick, None) => continue,
            (event, _) => event,
        };
        match event {
            ProxyEvent::Tick => {}
            ProxyEvent::Client(line) => {
                if let Ok(message) = serde_json::from_str::<Value>(line.trim())
                    && message.get("method").is_some()
                    && let Some(id) = message.get("id")
                {
                    outstanding.push(id.clone());
                }
                if writer.write_all(line.as_bytes()).is_err()
                    || (!line.ends_with('\n') && writer.write_all(b"\n").is_err())
                {
                    // The reader sees the same loss and reports it.
                    continue;
                }
            }
            ProxyEvent::Leader(line) => {
                if let Ok(message) = serde_json::from_str::<Value>(line.trim())
                    && message.get("method").is_none()
                    && let Some(id) = message.get("id")
                {
                    outstanding.retain(|pending| pending != id);
                }
                let mut out = stdout.lock();
                if out
                    .write_all(line.as_bytes())
                    .and_then(|_| out.flush())
                    .is_err()
                {
                    return Ok(0);
                }
            }
            ProxyEvent::LeaderEnded => {
                let mut out = stdout.lock();
                for id in outstanding.drain(..) {
                    let _ = writeln!(
                        out,
                        "{}",
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32603,
                                "message": format!(
                                    "the shared leader at {} disconnected; this request's outcome is unknown and it was not retried",
                                    socket.display()
                                )
                            }
                        })
                    );
                }
                let _ = writeln!(
                    out,
                    "{}",
                    json!({
                        "jsonrpc": "2.0",
                        "method": LEADER_DISCONNECTED,
                        "params": { "socket": socket }
                    })
                );
                let _ = out.flush();
                eprintln!("the shared leader at {} disconnected", socket.display());
                return Ok(1);
            }
            ProxyEvent::ClientEnded => client_done = true,
        }
        // Like agent stdio: a closed editor still gets the answers it is
        // owed. The leader keeps the session for the next client.
        if client_done && outstanding.is_empty() {
            return Ok(0);
        }
    }
    Ok(0)
}

/// The organization identity was refused while connected (ticket 207):
/// cancel the prompts this client started at the leader, answer what the
/// client still waits for, tell it why, and close.
#[cfg(unix)]
fn revoke_connection(
    writer: &mut std::os::unix::net::UnixStream,
    stdout: &io::Stdout,
    outstanding: &[Value],
    reply: Vec<Value>,
    cancel: Vec<String>,
) -> i32 {
    for session in cancel {
        let _ = writeln!(
            writer,
            "{}",
            json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": session } })
        );
    }
    let _ = writer.flush();
    let reason = reply
        .iter()
        .find_map(|message| {
            message
                .pointer("/params/message")
                .or_else(|| message.pointer("/error/message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Organization identity refused".into());
    let replied: Vec<&Value> = reply
        .iter()
        .filter_map(|message| message.get("id"))
        .collect();
    let mut out = stdout.lock();
    for id in outstanding {
        if replied.contains(&id) {
            continue;
        }
        let _ = writeln!(
            out,
            "{}",
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": crate::remote_identity::AUTH_ERROR, "message": reason.clone() }
            })
        );
    }
    for message in reply {
        let _ = writeln!(out, "{message}");
    }
    let _ = out.flush();
    eprintln!("{reason}");
    1
}

#[derive(Clone, Debug)]
struct Candidate {
    socket: PathBuf,
    lock: PathBuf,
    pid_from_lock: Option<u32>,
    lock_held: bool,
    info: Option<Value>,
}

impl Candidate {
    fn pid(&self) -> Option<u32> {
        self.info
            .as_ref()
            .and_then(|info| info.get("pid").and_then(Value::as_u64))
            .map(|pid| pid as u32)
            .or(self.pid_from_lock)
    }

    fn classification(&self) -> &'static str {
        if self.info.is_some() {
            "live"
        } else if self.lock_held {
            "unresponsive"
        } else {
            "stale"
        }
    }

    fn json(&self) -> Value {
        json!({
            "pid": self.pid(),
            "pidFromLock": self.pid_from_lock,
            "pidLive": self.pid().is_some_and(pid_alive),
            "classification": self.classification(),
            "socketPath": self.socket,
            "lockPath": self.lock,
            "version": self.info.as_ref().and_then(|info| info.get("version").cloned()),
        })
    }
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the process exists.
        let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
        rc == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

#[cfg(unix)]
fn lock_is_held(lock: &Path) -> bool {
    use std::os::unix::io::AsRawFd;
    let Ok(file) = std::fs::OpenOptions::new().read(true).open(lock) else {
        return false;
    };
    // SAFETY: flock on a descriptor owned here; released when it closes.
    let free = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
    !free
}

#[cfg(unix)]
fn leader_request(socket: &Path, method: &str) -> Option<Value> {
    let stream = connect_leader(socket).ok()?;
    stream.set_read_timeout(Some(INFO_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(INFO_TIMEOUT)).ok()?;
    let mut writer = stream.try_clone().ok()?;
    writeln!(
        writer,
        "{}",
        json!({ "jsonrpc": "2.0", "id": "codsh-leader-cli", "method": method })
    )
    .ok()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let message: Value = serde_json::from_str(line.trim()).ok()?;
    message.get("result").cloned()
}

#[cfg(unix)]
fn candidates(grok_home: &Path, explicit: Option<&Path>) -> Vec<Candidate> {
    let mut sockets: Vec<PathBuf> = Vec::new();
    let mut push = |path: PathBuf| {
        if !sockets.contains(&path) {
            sockets.push(path);
        }
    };
    if let Some(path) = explicit {
        push(path.to_path_buf());
    } else if let Some(path) =
        std::env::var_os("GROK_LEADER_SOCKET").filter(|value| !value.is_empty())
    {
        push(PathBuf::from(path));
    }
    if let Ok(entries) = std::fs::read_dir(grok_home) {
        let mut names: Vec<String> = entries
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("leader"))
            .collect();
        names.sort();
        for name in names {
            if let Some(stem) = name.strip_suffix(".sock") {
                push(grok_home.join(format!("{stem}.sock")));
            } else if let Some(stem) = name.strip_suffix(".lock") {
                push(grok_home.join(format!("{stem}.sock")));
            }
        }
    }
    sockets
        .into_iter()
        .filter_map(|socket| {
            let lock = lock_path(&socket);
            let lock_held = lock_is_held(&lock);
            // A lock file nobody holds, with no socket, is what a leader that
            // exited cleanly leaves behind. It is not a candidate.
            if std::fs::symlink_metadata(&socket).is_err() && !lock_held {
                return None;
            }
            let pid_from_lock = std::fs::read_to_string(&lock)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(text.trim()).ok())
                .and_then(|value| value.get("pid").and_then(Value::as_u64))
                .map(|pid| pid as u32);
            let info = leader_request(&socket, editor_acp::LEADER_INFO);
            Some(Candidate {
                socket,
                lock,
                pid_from_lock,
                lock_held,
                info,
            })
        })
        .collect()
}

#[cfg(not(unix))]
pub fn run_leader_command(_: LeaderCommand, _: &Path) -> io::Result<i32> {
    Err(io::Error::other(
        "shared leaders need Unix domain sockets; they are not available on this platform",
    ))
}

#[cfg(unix)]
pub fn run_leader_command(command: LeaderCommand, grok_home: &Path) -> io::Result<i32> {
    match command {
        LeaderCommand::Help => {
            print!("{}", leader_help());
            Ok(0)
        }
        LeaderCommand::List { json, socket } => {
            let found = candidates(grok_home, socket.as_deref());
            if json {
                let items: Vec<Value> = found.iter().map(Candidate::json).collect();
                println!(
                    "{}",
                    serde_json::to_string_pretty(&items).unwrap_or_default()
                );
                return Ok(0);
            }
            if found.is_empty() {
                eprintln!("No leader candidates found.");
                return Ok(0);
            }
            for candidate in &found {
                let pid = candidate
                    .pid()
                    .map(|pid| pid.to_string())
                    .unwrap_or_else(|| "?".into());
                eprintln!(
                    "  PID {pid} ({}) -- {}",
                    candidate.classification(),
                    candidate.socket.display()
                );
            }
            Ok(0)
        }
        LeaderCommand::Info { pid, json, socket } => {
            let found = candidates(grok_home, socket.as_deref());
            let chosen = found.iter().find(|candidate| {
                candidate.info.is_some() && pid.is_none_or(|pid| candidate.pid() == Some(pid))
            });
            let Some(candidate) = chosen else {
                return Err(io::Error::other(match pid {
                    Some(pid) => {
                        format!("no live leader with pid {pid}; see codsh --rust leader list")
                    }
                    None => "no live leader found; see codsh --rust leader list".into(),
                }));
            };
            let info = candidate.info.clone().unwrap_or(Value::Null);
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&info).unwrap_or_default()
                );
                return Ok(0);
            }
            println!(
                "Leader pid {} (codsh {})",
                info.get("pid").and_then(Value::as_u64).unwrap_or(0),
                info.get("version").and_then(Value::as_str).unwrap_or("?")
            );
            println!("  Socket: {}", candidate.socket.display());
            let clients = info
                .get("clients")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            println!("  Clients: {clients}");
            let sessions = info
                .get("sessions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if sessions.is_empty() {
                println!("  Sessions: none");
            } else {
                println!("  Sessions:");
                for session in sessions {
                    println!(
                        "    {} dsh pid {} attached {} turn {}{}  {}",
                        session
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .unwrap_or("?"),
                        session
                            .get("runtimePid")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                        session
                            .get("attachedClients")
                            .and_then(Value::as_array)
                            .map_or(0, Vec::len),
                        if session.get("turnRunning").and_then(Value::as_bool) == Some(true) {
                            "running"
                        } else {
                            "idle"
                        },
                        if session.get("approvalPending").and_then(Value::as_bool) == Some(true) {
                            ", approval pending"
                        } else {
                            ""
                        },
                        session.get("cwd").and_then(Value::as_str).unwrap_or("")
                    );
                }
            }
            Ok(0)
        }
        LeaderCommand::Kill { socket } => {
            let found = candidates(grok_home, socket.as_deref());
            let mut killed = 0;
            for candidate in found {
                match candidate.classification() {
                    "live" => {
                        let pid = candidate.pid();
                        if leader_request(&candidate.socket, editor_acp::LEADER_SHUTDOWN).is_some()
                        {
                            let deadline = Instant::now() + Duration::from_secs(10);
                            while Instant::now() < deadline
                                && pid.is_some_and(pid_alive)
                                && lock_is_held(&candidate.lock)
                            {
                                thread::sleep(Duration::from_millis(50));
                            }
                            killed += 1;
                        }
                    }
                    "unresponsive" => {
                        // The lock holder wrote this pid itself, so it is the
                        // leader process, not a recycled pid.
                        if let Some(pid) = candidate.pid_from_lock.filter(|pid| pid_alive(*pid)) {
                            // SAFETY: SIGTERM to the process that holds the lock.
                            unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
                            killed += 1;
                        }
                    }
                    _ => {
                        use std::os::unix::fs::FileTypeExt;
                        if std::fs::symlink_metadata(&candidate.socket)
                            .is_ok_and(|metadata| metadata.file_type().is_socket())
                        {
                            let _ = std::fs::remove_file(&candidate.socket);
                        }
                        let _ = std::fs::remove_file(&candidate.lock);
                    }
                }
            }
            if killed == 0 {
                eprintln!("No live leader processes found.");
            } else {
                eprintln!("Killed {killed} leader process(es).");
            }
            Ok(0)
        }
    }
}

/// Whether `agent stdio` goes through the shared leader. `--no-leader`
/// wins, then `--leader`, then `[cli] use_leader`. A sandbox profile other
/// than off keeps tool calls in this process: a leader started without that
/// profile must not run them.
pub fn resolve_leader(
    flag: Option<bool>,
    use_leader: Option<bool>,
    sandbox_profile: &str,
) -> (bool, Option<String>) {
    let wanted = flag.or(use_leader).unwrap_or(false);
    if wanted && sandbox_profile != "off" {
        return (
            false,
            Some(format!(
                "note: sandbox profile '{sandbox_profile}' was requested, so leader mode is off for this session and tool calls stay in this process instead of the shared leader. Use --sandbox off to share the leader."
            )),
        );
    }
    (wanted, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_commands_parse_with_flags_in_any_position() {
        assert_eq!(
            parse_agent(&["stdio"]).unwrap(),
            AgentCommand::Stdio {
                leader: None,
                socket: None
            }
        );
        assert_eq!(
            parse_agent(&["--leader", "stdio"]).unwrap(),
            AgentCommand::Stdio {
                leader: Some(true),
                socket: None
            }
        );
        assert_eq!(
            parse_agent(&["stdio", "--leader-socket", "/tmp/x.sock"]).unwrap(),
            AgentCommand::Stdio {
                leader: None,
                socket: Some(PathBuf::from("/tmp/x.sock"))
            }
        );
        assert_eq!(
            parse_agent(&["serve"]).unwrap(),
            AgentCommand::Serve(ServeOptions {
                bind: DEFAULT_BIND.into(),
                secret: None,
                debug: Debug::default()
            })
        );
        assert_eq!(
            parse_agent(&["serve", "--bind=0.0.0.0:9", "--secret", "s3", "--debug"]).unwrap(),
            AgentCommand::Serve(ServeOptions {
                bind: "0.0.0.0:9".into(),
                secret: Some("s3".into()),
                debug: Debug {
                    enabled: true,
                    file: None
                }
            })
        );
        assert_eq!(
            parse_agent(&[
                "leader",
                "--no-exit-on-disconnect",
                "--debug-file",
                "/tmp/l.log"
            ])
            .unwrap(),
            AgentCommand::Leader(LeaderOptions {
                socket: None,
                exit_on_disconnect: false,
                debug: Debug {
                    enabled: true,
                    file: Some(PathBuf::from("/tmp/l.log"))
                }
            })
        );
        assert_eq!(
            parse_agent(&["serve", "--help"]).unwrap(),
            AgentCommand::Help("serve")
        );
    }

    #[test]
    fn agent_refuses_official_only_and_misplaced_flags() {
        for (args, needle) in [
            (vec!["headless"], "grok.com relay"),
            (vec!["serve", "--remote", "wss://x"], "official service"),
            (vec!["serve", "--grok-ws-url", "wss://x"], "relay"),
            (vec!["leader", "--relay-on-demand"], "no relay"),
            (vec!["leader", "--no-auto-update"], "no update checks"),
            (vec!["leader", "--cursor-worker"], "Cursor"),
            (
                vec!["stdio", "--bind", "127.0.0.1:1"],
                "--bind applies to agent serve",
            ),
            (vec!["serve", "--leader"], "applies to agent stdio"),
            (
                vec!["stdio", "--no-exit-on-disconnect"],
                "applies to agent leader",
            ),
            (
                vec!["--no-leader", "--leader-socket", "/x", "stdio"],
                "drop --no-leader",
            ),
            (vec!["serve", "--secret"], "missing --secret value"),
            (vec!["bogus"], "unsupported agent command bogus"),
            (vec!["--leader"], "missing agent command"),
        ] {
            let error = parse_agent(&args).unwrap_err();
            assert!(error.contains(needle), "{args:?}: {error}");
        }
    }

    #[test]
    fn leader_commands_parse() {
        assert_eq!(
            parse_leader(&["list", "--json"]).unwrap(),
            LeaderCommand::List {
                json: true,
                socket: None
            }
        );
        assert_eq!(
            parse_leader(&["info", "--pid", "42"]).unwrap(),
            LeaderCommand::Info {
                pid: Some(42),
                json: false,
                socket: None
            }
        );
        assert_eq!(
            parse_leader(&["kill", "--leader-socket=/tmp/a.sock"]).unwrap(),
            LeaderCommand::Kill {
                socket: Some(PathBuf::from("/tmp/a.sock"))
            }
        );
        assert_eq!(parse_leader(&[]).unwrap(), LeaderCommand::Help);
        assert!(parse_leader(&["list", "--pid", "1"]).is_err());
        assert!(parse_leader(&["info", "--pid", "x"]).is_err());
        assert!(parse_leader(&["kill", "--json"]).is_err());
        assert!(
            parse_leader(&["restart"])
                .unwrap_err()
                .contains("unsupported leader command")
        );
    }

    #[test]
    fn leader_mode_resolution_and_sandbox_veto() {
        assert_eq!(resolve_leader(None, None, "off"), (false, None));
        assert_eq!(resolve_leader(Some(true), None, "off"), (true, None));
        assert_eq!(resolve_leader(None, Some(true), "off"), (true, None));
        assert_eq!(
            resolve_leader(Some(false), Some(true), "off"),
            (false, None)
        );
        let (shared, note) = resolve_leader(Some(true), None, "workspace");
        assert!(!shared);
        assert!(
            note.unwrap()
                .contains("sandbox profile 'workspace' was requested")
        );
        let (shared, note) = resolve_leader(None, Some(true), "strict");
        assert!(!shared && note.is_some());
        assert_eq!(resolve_leader(None, None, "strict"), (false, None));
    }

    #[test]
    fn socket_path_defaults_and_limits() {
        let home = Path::new("/home/u/.grok");
        assert_eq!(
            leader_socket(Some(Path::new("/tmp/s.sock")), home),
            PathBuf::from("/tmp/s.sock")
        );
        assert_eq!(
            lock_path(Path::new("/a/leader.sock")),
            PathBuf::from("/a/leader.lock")
        );
        assert!(check_socket_path(Path::new("/tmp/short.sock")).is_ok());
        let long = PathBuf::from(format!("/tmp/{}.sock", "x".repeat(120)));
        assert!(
            check_socket_path(&long)
                .unwrap_err()
                .to_string()
                .contains("too long")
        );
    }

    #[test]
    fn generated_secrets_are_twelve_alphanumerics() {
        let first = generate_secret().unwrap();
        let second = generate_secret().unwrap();
        assert_eq!(first.len(), 12);
        assert!(first.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_ne!(first, second);
    }
}
