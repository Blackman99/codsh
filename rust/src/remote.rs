//! Remote workspace over SSH (ticket 190).
//!
//! `codsh --rust --remote ssh://[user@]host[:port]/abs/path` runs the same
//! terminal client against a codsh hub on another machine. The transport is
//! the system OpenSSH client with public-key authentication and a pinned host
//! key (`BatchMode=yes`, `StrictHostKeyChecking=yes`); the remote end runs
//! `codsh --rust agent --leader stdio`, so the remote user's own leader, config,
//! credentials, permission policy, and sandbox execute every turn. Nothing of
//! this machine is forwarded: no agent, X11, or port forwarding, no local
//! environment, no local credentials, no local MCP servers, rules, memory, or
//! files. The session directory is a remote path and is never resolved here.
//!
//! The official Computer Hub, cloud workspaces, and the Cursor worker need
//! private infrastructure this client does not have; they stay refused.

use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::OnceLock;

use crate::acp::SpawnSpec;

pub const DEFAULT_REMOTE_COMMAND: &str = "codsh --rust";
/// Appended to the remote command. The leader keeps a session alive while
/// this client is disconnected, so a reconnect attaches instead of re-running.
pub const REMOTE_AGENT_ARGS: &str = "agent --leader stdio";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
    /// Absolute path on the remote host.
    pub path: String,
    pub identity: Option<PathBuf>,
    pub known_hosts: Option<PathBuf>,
    /// Remote shell command that starts codsh (default `codsh --rust`).
    pub command: String,
    /// Local OpenSSH client program.
    pub ssh: PathBuf,
}

static ACTIVE: OnceLock<Target> = OnceLock::new();

/// The remote target of this process, when `--remote` was given.
pub fn active() -> Option<&'static Target> {
    ACTIVE.get()
}

pub fn activate(target: Target) {
    let _ = ACTIVE.set(target);
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && !host.starts_with('-')
        && host
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ':'))
}

fn valid_user(user: &str) -> bool {
    !user.is_empty()
        && !user.starts_with('-')
        && user
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
}

/// Parse `ssh://[user@]host[:port]/absolute/path`.
pub fn parse_url(raw: &str) -> Result<Target, String> {
    let usage = || {
        format!(
            "--remote expects ssh://[user@]host[:port]/absolute/path (got {raw:?}); only SSH is supported"
        )
    };
    let rest = raw.strip_prefix("ssh://").ok_or_else(usage)?;
    let slash = rest.find('/').ok_or_else(usage)?;
    let (authority, path) = rest.split_at(slash);
    if path.len() < 2
        || path.chars().any(|ch| ch.is_control())
        || path.contains("/../")
        || path.ends_with("/..")
    {
        return Err(format!(
            "--remote: the remote directory must be an absolute path without control characters or '..' (got {path:?})"
        ));
    }
    let (user, hostport) = match authority.rsplit_once('@') {
        Some((user, hostport)) => {
            if !valid_user(user) {
                return Err(format!("--remote: invalid user name {user:?}"));
            }
            (Some(user.to_string()), hostport)
        }
        None => (None, authority),
    };
    let (host, port) = if let Some(inner) = hostport.strip_prefix('[') {
        let (host, tail) = inner.split_once(']').ok_or_else(usage)?;
        let port = match tail.strip_prefix(':') {
            Some(port) => Some(port),
            None if tail.is_empty() => None,
            None => return Err(usage()),
        };
        (host.to_string(), port)
    } else {
        match hostport.rsplit_once(':') {
            Some((host, port)) => (host.to_string(), Some(port)),
            None => (hostport.to_string(), None),
        }
    };
    if !valid_host(&host) {
        return Err(format!("--remote: invalid host {host:?}"));
    }
    let port = match port {
        Some(port) => Some(
            port.parse::<u16>()
                .ok()
                .filter(|port| *port > 0)
                .ok_or_else(|| format!("--remote: invalid port {port:?}"))?,
        ),
        None => None,
    };
    let path = path.trim_end_matches('/');
    Ok(Target {
        user,
        host,
        port,
        path: if path.is_empty() {
            "/".into()
        } else {
            path.into()
        },
        identity: None,
        known_hosts: None,
        command: DEFAULT_REMOTE_COMMAND.into(),
        ssh: PathBuf::from("ssh"),
    })
}

fn take_value(args: &mut Vec<String>, name: &str) -> Result<Option<String>, String> {
    let mut found = None;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == name {
            if index + 1 >= args.len() {
                return Err(format!("missing {name} value"));
            }
            let value = args.remove(index + 1);
            args.remove(index);
            if found.replace(value).is_some() {
                return Err(format!("{name} was given more than once"));
            }
            continue;
        }
        if let Some(value) = arg.strip_prefix(&format!("{name}=")) {
            let value = value.to_string();
            args.remove(index);
            if found.replace(value).is_some() {
                return Err(format!("{name} was given more than once"));
            }
            continue;
        }
        if arg == "--" {
            break;
        }
        index += 1;
    }
    Ok(found)
}

/// Remove the remote flags from the launch arguments. `Ok(None)` when no
/// `--remote` was given; the companion flags are refused without it.
pub fn extract_flags(args: &mut Vec<String>) -> Result<Option<Target>, String> {
    let url = take_value(args, "--remote")?;
    let identity = take_value(args, "--remote-identity")?;
    let known_hosts = take_value(args, "--remote-known-hosts")?;
    let command = take_value(args, "--remote-command")?;
    let ssh = take_value(args, "--remote-ssh")?;
    let Some(url) = url else {
        if identity.is_some() || known_hosts.is_some() || command.is_some() || ssh.is_some() {
            return Err(
                "--remote-identity, --remote-known-hosts, --remote-command, and --remote-ssh need --remote ssh://…"
                    .into(),
            );
        }
        return Ok(None);
    };
    let mut target = parse_url(&url)?;
    let absolute = |flag: &str, value: String| -> Result<PathBuf, String> {
        let path = PathBuf::from(&value);
        if !path.is_absolute() {
            return Err(format!(
                "{flag} must be an absolute local path (got {value:?})"
            ));
        }
        if !path.is_file() {
            return Err(format!("{flag}: {value} is not a readable file"));
        }
        Ok(path)
    };
    if let Some(identity) = identity {
        target.identity = Some(absolute("--remote-identity", identity)?);
    }
    if let Some(known_hosts) = known_hosts {
        target.known_hosts = Some(absolute("--remote-known-hosts", known_hosts)?);
    }
    if let Some(command) = command {
        if command.trim().is_empty() || command.contains('\n') {
            return Err("--remote-command must be one non-empty line".into());
        }
        target.command = command;
    }
    if let Some(ssh) = ssh.or_else(|| std::env::var("CODSH_REMOTE_SSH").ok()) {
        target.ssh = PathBuf::from(ssh);
    }
    Ok(Some(target))
}

impl Target {
    /// `ssh://user@host:port/path`, for status lines and reports.
    pub fn label(&self) -> String {
        let user = self
            .user
            .as_deref()
            .map(|user| format!("{user}@"))
            .unwrap_or_default();
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        let port = self.port.map(|port| format!(":{port}")).unwrap_or_default();
        format!("ssh://{user}{host}{port}{}", self.path)
    }

    /// Arguments for the OpenSSH client. Command-line `-o` values win over
    /// any ssh_config entry, so a config file cannot turn forwarding or
    /// password prompts back on.
    pub fn ssh_args(&self) -> Vec<String> {
        self.ssh_args_for(&format!("{} {REMOTE_AGENT_ARGS}", self.command))
    }

    /// The same hardened client for another remote command line (ticket
    /// 191 runs `codsh --rust clone` there). `command_line` is passed to the
    /// remote shell as one argument after `--` and the host.
    pub fn ssh_args_for(&self, command_line: &str) -> Vec<String> {
        let mut args: Vec<String> = vec!["-T".into(), "-a".into(), "-x".into()];
        for option in [
            "BatchMode=yes",
            "StrictHostKeyChecking=yes",
            "UpdateHostKeys=no",
            "PreferredAuthentications=publickey",
            "PubkeyAuthentication=yes",
            "PasswordAuthentication=no",
            "KbdInteractiveAuthentication=no",
            "ForwardAgent=no",
            "ForwardX11=no",
            "ClearAllForwardings=yes",
            "PermitLocalCommand=no",
            "Tunnel=no",
            "SendEnv=-*",
            "ConnectTimeout=15",
            "ServerAliveInterval=10",
            "ServerAliveCountMax=3",
            "LogLevel=ERROR",
        ] {
            args.push("-o".into());
            args.push(option.into());
        }
        if let Some(known_hosts) = &self.known_hosts {
            args.push("-o".into());
            args.push(format!("UserKnownHostsFile={}", known_hosts.display()));
            args.push("-o".into());
            args.push("GlobalKnownHostsFile=/dev/null".into());
        }
        if let Some(identity) = &self.identity {
            args.push("-i".into());
            args.push(identity.to_string_lossy().into_owned());
            args.push("-o".into());
            args.push("IdentitiesOnly=yes".into());
        }
        if let Some(port) = self.port {
            args.push("-p".into());
            args.push(port.to_string());
        }
        if let Some(user) = &self.user {
            args.push("-l".into());
            args.push(user.clone());
        }
        args.push("--".into());
        args.push(self.host.clone());
        args.push(command_line.to_string());
        args
    }

    /// The ACP child: the ssh client. Its environment is an allowlist that
    /// carries no provider key, token, or codsh setting of this machine.
    pub fn spawn_spec(&self, stderr_log: Option<PathBuf>) -> SpawnSpec {
        let mut env = Vec::new();
        for key in ["PATH", "HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK", "LANG"] {
            if let Some(value) = std::env::var_os(key) {
                env.push((key.to_string(), value.to_string_lossy().into_owned()));
            }
        }
        SpawnSpec {
            program: self.ssh.clone(),
            args: self.ssh_args(),
            env,
            cwd: std::env::temp_dir(),
            stderr_log,
            remote: true,
        }
    }

    pub fn auth_summary(&self) -> String {
        format!(
            "ssh public key ({}), host key pinned in {} (StrictHostKeyChecking=yes, BatchMode=yes)",
            self.identity
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "ssh default identities or agent".into()),
            self.known_hosts
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "the ssh known_hosts files".into()),
        )
    }
}

/// Launch flags that would carry this machine's model, permission, sandbox,
/// rules, or workspace policy to the remote. The remote config governs them.
pub fn refused_flags(flags: &[(&str, bool)]) -> Result<(), String> {
    let given: Vec<&str> = flags
        .iter()
        .filter(|(_, set)| *set)
        .map(|(name, _)| *name)
        .collect();
    if given.is_empty() {
        return Ok(());
    }
    Err(format!(
        "--remote refuses {}: the remote host's own config, permission policy, and sandbox govern a remote session, and this client does not forward local policy",
        given.join(", ")
    ))
}

/// Slash commands a remote session supports. Everything else reads or
/// writes this machine's dsh home, plugins, memory, or control channel.
pub fn slash_allowed(command: &str) -> bool {
    matches!(
        command,
        "/remote"
            | "/reconnect"
            | "/new"
            | "/clear"
            | "/queue"
            | "/find"
            | "/jump"
            | "/expand"
            | "/transcript"
            | "/log"
            | "/minimal"
            | "/fullscreen"
            | "/full"
            | "/vim-mode"
            | "/toggle-mouse-reporting"
            | "/history"
            | "/multiline"
            | "/ml"
            | "/edit-prompt"
            | "/theme"
    )
}

pub const UNAVAILABLE_REASON: &str = "not available in a remote session: it uses this machine's dsh home, plugins, memory, or control channel. A remote session supports /remote, /reconnect, /new, /clear, /queue, and the transcript and screen commands";

/// Features the remote client reports as unavailable, with the reason.
pub fn unavailable_features() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "steer, /btw, plan, questions, todos, subagents, background jobs, goal, workflow, scheduled loops",
            "they need the local dsh control plugin and stderr markers; the remote hub does not relay them",
        ),
        (
            "/resume picker, fork, rewind, export, session info",
            "the session catalog lives on the remote host; use --resume <id> or --continue",
        ),
        (
            "memory, rules, skills, local MCP servers, plugins",
            "local context is not sent to a remote host; the remote config applies",
        ),
        (
            "@file attachments and images",
            "local files are never presented as remote files; the hub advertises no image prompts",
        ),
        (
            "--model, --permission-mode, --always-approve, --auto, --allow, --deny, --sandbox",
            "local policy is not forwarded; the remote config governs",
        ),
    ]
}

/// Features that need official private infrastructure (ticket 190 refusal).
pub fn official_refusals() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "workspace start/stop/status --hub-url",
            "exposes a workspace to the official Computer Hub (private infrastructure)",
        ),
        (
            "x.ai/cloud/*, x.ai/workspaces/list",
            "official cloud workspaces and sandbox environments",
        ),
        ("cursor-worker", "official Cursor worker relay"),
        (
            "agent serve --remote",
            "proxy to an official remote agent URL",
        ),
    ]
}

/// The remote command as shown in reports: values of assignments whose
/// name looks like a credential are replaced.
pub fn redact_command(command: &str) -> String {
    command
        .split(' ')
        .map(|word| match word.split_once('=') {
            Some((name, _))
                if ["KEY", "TOKEN", "SECRET", "PASSWORD", "AUTH"]
                    .iter()
                    .any(|needle| name.to_ascii_uppercase().contains(needle)) =>
            {
                format!("{name}=<redacted>")
            }
            _ => word.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The `remote check` report and the `/remote` view, from a real connection.
pub fn capability_report(target: &Target, init: &Value, sessions: Option<usize>) -> Value {
    let server = init
        .pointer("/agentCapabilities/_meta/codsh~1server")
        .cloned()
        .unwrap_or(Value::Null);
    let shared = server
        .get("shared")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    json!({
        "target": target.label(),
        "transport": "ssh",
        "auth": target.auth_summary(),
        "remoteCommand": format!("{} {REMOTE_AGENT_ARGS}", redact_command(&target.command)),
        "agentInfo": init.get("agentInfo").cloned().unwrap_or(Value::Null),
        "server": {
            "transport": server.get("transport").cloned().unwrap_or(Value::Null),
            "shared": shared,
            "version": server.get("version").cloned().unwrap_or(Value::Null),
            "sandbox": server.get("sandbox").cloned().unwrap_or(Value::Null),
            "liveSessions": server
                .get("liveSessions")
                .and_then(Value::as_array)
                .map(Vec::len),
        },
        "reattach": if shared {
            "yes: the remote leader keeps a session while this client is disconnected; /reconnect attaches without re-running anything"
        } else {
            "no: the remote agent runs in the ssh session (for example a sandbox profile other than off), so a lost connection ends the session"
        },
        "promptCapabilities": init
            .pointer("/agentCapabilities/promptCapabilities")
            .cloned()
            .unwrap_or(Value::Null),
        "sessionsInDirectory": sessions,
        "unavailable": unavailable_features()
            .into_iter()
            .map(|(feature, reason)| json!({ "feature": feature, "reason": reason }))
            .collect::<Vec<_>>(),
        "needsOfficialInfrastructure": official_refusals()
            .into_iter()
            .map(|(feature, reason)| json!({ "feature": feature, "reason": reason }))
            .collect::<Vec<_>>(),
    })
}

pub fn report_text(report: &Value) -> String {
    let get = |pointer: &str| {
        report
            .pointer(pointer)
            .map(|value| match value {
                Value::String(text) => text.clone(),
                Value::Null => "unknown".into(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| "unknown".into())
    };
    let mut out = format!(
        "remote {}\n  auth: {}\n  remote command: {}\n  agent: {} {}\n  server: transport={} shared={} sandbox={} live sessions={}\n  reattach: {}\n  sessions in directory: {}\n",
        get("/target"),
        get("/auth"),
        get("/remoteCommand"),
        get("/agentInfo/name"),
        get("/agentInfo/version"),
        get("/server/transport"),
        get("/server/shared"),
        get("/server/sandbox"),
        get("/server/liveSessions"),
        get("/reattach"),
        get("/sessionsInDirectory"),
    );
    out.push_str("  unavailable here:\n");
    for (feature, reason) in unavailable_features() {
        out.push_str(&format!("    - {feature}: {reason}\n"));
    }
    out.push_str("  needs official infrastructure (refused):\n");
    for (feature, reason) in official_refusals() {
        out.push_str(&format!("    - {feature}: {reason}\n"));
    }
    out
}

pub const HELP: &str = "Check a remote workspace over SSH.\n\nUsage: codsh --rust remote check ssh://[user@]host[:port]/abs/path [--remote-identity FILE] [--remote-known-hosts FILE] [--remote-command CMD] [--remote-ssh PROG] [--json]\n\nConnects with public-key auth and a pinned host key (BatchMode=yes, StrictHostKeyChecking=yes), runs `<remote-command> agent --leader stdio` there (default remote command: codsh --rust), and prints what that real remote reports: agent, leader, sandbox, reattach, and the features a remote session does not have.\n\nInteractive and plain sessions: codsh --rust --remote ssh://host/abs/path [-p PROMPT | --continue | --resume ID].\nThe remote host's config, credentials, permission policy, and sandbox execute every turn. Nothing local is forwarded.\n";

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn parses_ssh_urls() {
        let target = parse_url("ssh://dev@example.org:2222/srv/app/").unwrap();
        assert_eq!(target.user.as_deref(), Some("dev"));
        assert_eq!(target.host, "example.org");
        assert_eq!(target.port, Some(2222));
        assert_eq!(target.path, "/srv/app");
        assert_eq!(target.label(), "ssh://dev@example.org:2222/srv/app");
        let v6 = parse_url("ssh://[::1]:22/w").unwrap();
        assert_eq!(v6.host, "::1");
        assert_eq!(v6.label(), "ssh://[::1]:22/w");
        let bare = parse_url("ssh://box/home/box").unwrap();
        assert_eq!(bare.user, None);
        assert_eq!(bare.port, None);
    }

    #[test]
    fn refuses_unsafe_or_unsupported_targets() {
        for bad in [
            "https://example.org/x",
            "ssh://example.org",
            "ssh://example.org/",
            "ssh://-oProxyCommand=x/tmp",
            "ssh://-l@host/tmp",
            "ssh://host:0/tmp",
            "ssh://host:99999/tmp",
            "ssh://host/tmp/../etc",
            "ssh://ho st/tmp",
            "ssh://host/tmp\nx",
        ] {
            assert!(parse_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn extracts_flags_and_requires_remote_for_companions() {
        let mut list = args(&[
            "--remote",
            "ssh://h/w",
            "-p",
            "hi",
            "--remote-command=env X=1 codsh",
        ]);
        let target = extract_flags(&mut list).unwrap().unwrap();
        assert_eq!(list, args(&["-p", "hi"]));
        assert_eq!(target.command, "env X=1 codsh");
        let mut alone = args(&["--remote-command", "codsh"]);
        assert!(extract_flags(&mut alone).is_err());
        let mut twice = args(&["--remote", "ssh://h/w", "--remote=ssh://h/v"]);
        assert!(extract_flags(&mut twice).is_err());
        let mut relative = args(&["--remote", "ssh://h/w", "--remote-identity", "key"]);
        assert!(extract_flags(&mut relative).is_err());
        let mut none = args(&["-p", "hi"]);
        assert_eq!(extract_flags(&mut none).unwrap(), None);
    }

    #[test]
    fn ssh_arguments_pin_the_host_and_forward_nothing() {
        let mut target = parse_url("ssh://dev@example.org:2200/srv").unwrap();
        target.known_hosts = Some(PathBuf::from("/k/known_hosts"));
        target.identity = Some(PathBuf::from("/k/id"));
        let args = target.ssh_args();
        let joined = args.join(" ");
        for needle in [
            "BatchMode=yes",
            "StrictHostKeyChecking=yes",
            "PasswordAuthentication=no",
            "ForwardAgent=no",
            "ForwardX11=no",
            "ClearAllForwardings=yes",
            "PermitLocalCommand=no",
            "SendEnv=-*",
            "UserKnownHostsFile=/k/known_hosts",
            "IdentitiesOnly=yes",
        ] {
            assert!(joined.contains(needle), "{needle}");
        }
        let dash = args.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(args[dash + 1], "example.org");
        assert_eq!(args[dash + 2], "codsh --rust agent --leader stdio");
        assert_eq!(args.len(), dash + 3);
        let spec = target.spawn_spec(None);
        assert!(spec.remote);
        for (key, _) in &spec.env {
            assert!(
                ["PATH", "HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK", "LANG"]
                    .contains(&key.as_str()),
                "{key}"
            );
        }
    }

    #[test]
    fn reports_redact_credentials_in_the_remote_command() {
        assert_eq!(
            redact_command("env XAI_API_KEY=abc HOME=/h codsh --rust"),
            "env XAI_API_KEY=<redacted> HOME=/h codsh --rust"
        );
    }

    #[test]
    fn local_policy_flags_are_refused() {
        assert!(refused_flags(&[("--model", false)]).is_ok());
        let error = refused_flags(&[("--model", true), ("--always-approve", true)]).unwrap_err();
        assert!(error.contains("--model, --always-approve"));
        assert!(slash_allowed("/reconnect"));
        assert!(!slash_allowed("/memory"));
        assert!(!slash_allowed("/resume"));
    }
}
