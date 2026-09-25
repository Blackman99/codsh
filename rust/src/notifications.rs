//! `[ui.notifications]` (ticket 155): terminal notifications gated by focus,
//! plus user hooks. Focus comes from DECSET 1004 focus reports; a terminal
//! that never reports focus is treated as focused, so the default
//! `condition = "unfocused"` stays quiet rather than guessing.

use crate::terminal_env::{Brand, EnvMap, Multiplexer, TermEnv, tmux_passthrough};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use toml::Value as TomlValue;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Auto,
    Osc9,
    Osc99,
    Osc777,
    Bel,
    None,
}

impl Method {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "auto" => Method::Auto,
            "osc9" => Method::Osc9,
            "osc99" => Method::Osc99,
            "osc777" => Method::Osc777,
            "bel" => Method::Bel,
            "none" => Method::None,
            _ => return None,
        })
    }

    pub fn label(self) -> &'static str {
        match self {
            Method::Auto => "auto",
            Method::Osc9 => "osc9",
            Method::Osc99 => "osc99",
            Method::Osc777 => "osc777",
            Method::Bel => "bel",
            Method::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Condition {
    Unfocused,
    Always,
    Never,
}

impl Condition {
    pub fn label(self) -> &'static str {
        match self {
            Condition::Unfocused => "unfocused",
            Condition::Always => "always",
            Condition::Never => "never",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    TurnComplete,
    ApprovalRequired,
    AgentError,
    SessionReady,
}

impl Event {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "turn_complete" => Event::TurnComplete,
            "approval_required" => Event::ApprovalRequired,
            "agent_error" => Event::AgentError,
            "session_ready" => Event::SessionReady,
            _ => return None,
        })
    }

    pub fn id(self) -> &'static str {
        match self {
            Event::TurnComplete => "turn_complete",
            Event::ApprovalRequired => "approval_required",
            Event::AgentError => "agent_error",
            Event::SessionReady => "session_ready",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hook {
    pub command: String,
    /// Empty means every event.
    pub events: Vec<Event>,
    pub only_unfocused: bool,
    pub timeout_secs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    pub method: Method,
    pub condition: Condition,
    pub idle_threshold_secs: u64,
    pub events: Vec<Event>,
    pub hooks: Vec<Hook>,
    pub warnings: Vec<String>,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            method: Method::Auto,
            condition: Condition::Unfocused,
            idle_threshold_secs: 3,
            events: vec![Event::TurnComplete, Event::ApprovalRequired],
            hooks: Vec::new(),
            warnings: Vec::new(),
        }
    }
}

const NOT_IMPLEMENTED: &[&str] = &[
    "sleep_prevention",
    "progress_bar",
    "session_recap",
    "session_recap_threshold_secs",
    "title",
];

fn parse_events(value: &TomlValue, context: &str, warnings: &mut Vec<String>) -> Vec<Event> {
    let Some(items) = value.as_array() else {
        warnings.push(format!("{context} is not a list of event names; ignored"));
        return Vec::new();
    };
    let mut events = Vec::new();
    for item in items {
        match item.as_str().and_then(Event::parse) {
            Some(event) => {
                if !events.contains(&event) {
                    events.push(event);
                }
            }
            None => warnings.push(format!(
                "{context}: `{}` is not supported here (turn_complete, approval_required, agent_error, session_ready); ignored",
                item.as_str().map(str::to_string).unwrap_or_else(|| item.to_string())
            )),
        }
    }
    events
}

pub fn resolve(table: &TomlValue) -> Policy {
    let mut policy = Policy::default();
    let Some(section) = table.get("ui").and_then(|ui| ui.get("notifications")) else {
        return policy;
    };
    let Some(section) = section.as_table() else {
        policy
            .warnings
            .push("[ui.notifications] is not a table; using defaults".into());
        return policy;
    };
    for (key, value) in section {
        match key.as_str() {
            "method" => match value.as_str().and_then(Method::parse) {
                Some(method) => policy.method = method,
                None => policy.warnings.push(format!(
                    "[ui.notifications] method = {value} is not auto|osc9|osc99|osc777|bel|none; using auto"
                )),
            },
            "condition" => match value.as_str() {
                Some("unfocused") => policy.condition = Condition::Unfocused,
                Some("always") => policy.condition = Condition::Always,
                Some("never") => policy.condition = Condition::Never,
                _ => policy.warnings.push(format!(
                    "[ui.notifications] condition = {value} is not unfocused|always|never; using unfocused"
                )),
            },
            "idle_threshold_secs" => match value.as_integer() {
                Some(secs) if secs >= 0 => policy.idle_threshold_secs = secs as u64,
                _ => policy.warnings.push(format!(
                    "[ui.notifications] idle_threshold_secs = {value} is not a whole number >= 0; using 3"
                )),
            },
            "events" => {
                policy.events = parse_events(value, "[ui.notifications] events", &mut policy.warnings)
            }
            "hooks" => {
                let Some(items) = value.as_array() else {
                    policy
                        .warnings
                        .push("[[ui.notifications.hooks]] must be an array of tables; ignored".into());
                    continue;
                };
                for (index, item) in items.iter().enumerate() {
                    let context = format!("[[ui.notifications.hooks]] #{}", index + 1);
                    let Some(command) = item.get("command").and_then(TomlValue::as_str) else {
                        policy
                            .warnings
                            .push(format!("{context} has no command string; ignored"));
                        continue;
                    };
                    let events = item
                        .get("events")
                        .map(|value| {
                            parse_events(value, &format!("{context} events"), &mut policy.warnings)
                        })
                        .unwrap_or_default();
                    let only_unfocused = item
                        .get("only_unfocused")
                        .and_then(TomlValue::as_bool)
                        .unwrap_or(true);
                    let timeout_secs = item
                        .get("timeout_secs")
                        .and_then(TomlValue::as_integer)
                        .filter(|secs| *secs > 0)
                        .map(|secs| secs as u64)
                        .unwrap_or(10);
                    policy.hooks.push(Hook {
                        command: command.to_string(),
                        events,
                        only_unfocused,
                        timeout_secs,
                    });
                }
            }
            other if NOT_IMPLEMENTED.contains(&other) => policy.warnings.push(format!(
                "[ui.notifications] {other} is not implemented in codsh yet; ignored"
            )),
            other => policy
                .warnings
                .push(format!("[ui.notifications] unknown key `{other}`; ignored")),
        }
    }
    policy
}

/// Protocol `auto` picks for a terminal.
pub fn auto_method(term: &TermEnv) -> Method {
    if term.multiplexer == Multiplexer::Zellij {
        return Method::Bel;
    }
    match term.brand {
        Brand::Iterm2 | Brand::WezTerm | Brand::Warp => Method::Osc9,
        Brand::Kitty => Method::Osc99,
        Brand::Ghostty | Brand::Vte | Brand::Foot => Method::Osc777,
        _ => Method::Bel,
    }
}

pub fn effective_method(policy: &Policy, term: &TermEnv) -> Method {
    match policy.method {
        Method::Auto => auto_method(term),
        other => other,
    }
}

fn sanitize(text: &str) -> String {
    text.chars().filter(|ch| !ch.is_control()).collect()
}

/// Bytes for one notification, wrapped for tmux passthrough when needed.
pub fn sequence(method: Method, body: &str, tmux: bool) -> Option<String> {
    let body = sanitize(body);
    let raw = match method {
        Method::Osc9 => format!("\x1b]9;{body} · codsh\x07"),
        Method::Osc99 => format!("\x1b]99;i=codsh;{body}\x1b\\"),
        Method::Osc777 => format!("\x1b]777;notify;codsh;{body}\x1b\\"),
        Method::Bel => "\x07".to_string(),
        Method::None | Method::Auto => return None,
    };
    Some(if tmux { tmux_passthrough(&raw) } else { raw })
}

/// Human summary for `doctor` and `inspect`.
pub fn describe(policy: &Policy, term: &TermEnv) -> String {
    let method = effective_method(policy, term);
    let events: Vec<&str> = policy.events.iter().map(|event| event.id()).collect();
    format!(
        "method {} ({}), condition {}, idle {}s, events [{}], {} hook(s); focus via DECSET 1004 (no focus report = treated as focused)",
        method.label(),
        if policy.method == Method::Auto {
            "auto"
        } else {
            "configured"
        },
        policy.condition.label(),
        policy.idle_threshold_secs,
        events.join(", "),
        policy.hooks.len()
    )
}

struct Pending {
    event: Event,
    message: String,
    due: Instant,
}

/// Runtime state owned by the TUI loop.
pub struct Notifier {
    policy: Policy,
    method: Method,
    tmux: bool,
    env: EnvMap,
    focused: bool,
    unfocused_since: Option<Instant>,
    pending: Vec<Pending>,
    session_id: String,
}

impl Notifier {
    pub fn new(policy: Policy, term: &TermEnv, env: EnvMap) -> Self {
        let method = effective_method(&policy, term);
        let tmux = term.tmux_backed(&env);
        Notifier {
            policy,
            method,
            tmux,
            env,
            focused: true,
            unfocused_since: None,
            pending: Vec::new(),
            session_id: String::new(),
        }
    }

    pub fn set_session(&mut self, session: Option<&str>) {
        self.session_id = session.unwrap_or("").to_string();
    }

    pub fn focus(&mut self, focused: bool, now: Instant) {
        self.focused = focused;
        if focused {
            self.unfocused_since = None;
            // Coming back cancels anything still waiting for the threshold.
            self.pending.clear();
        } else if self.unfocused_since.is_none() {
            self.unfocused_since = Some(now);
        }
    }

    /// Record an event; terminal output may be deferred until `tick`.
    pub fn event(&mut self, event: Event, message: &str, now: Instant, out: &mut dyn Write) {
        for hook in &self.policy.hooks {
            if (hook.events.is_empty() || hook.events.contains(&event))
                && (!hook.only_unfocused || !self.focused)
            {
                run_hook(hook, event, message, &self.session_id, &self.env);
            }
        }
        if !self.policy.events.contains(&event) || self.method == Method::None {
            return;
        }
        match self.policy.condition {
            Condition::Never => {}
            Condition::Always => self.emit(message, out),
            Condition::Unfocused => {
                if self.focused {
                    return;
                }
                let threshold = Duration::from_secs(self.policy.idle_threshold_secs);
                let since = self.unfocused_since.unwrap_or(now);
                let due = since + threshold;
                if due <= now {
                    self.emit(message, out);
                } else {
                    self.pending.push(Pending {
                        event,
                        message: message.to_string(),
                        due,
                    });
                }
            }
        }
    }

    /// Fire deferred notifications whose idle threshold has passed.
    pub fn tick(&mut self, now: Instant, out: &mut dyn Write) {
        if self.pending.is_empty() || self.focused {
            return;
        }
        let (due, waiting): (Vec<Pending>, Vec<Pending>) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(|pending| pending.due <= now);
        self.pending = waiting;
        for pending in due {
            let _ = pending.event;
            self.emit(&pending.message, out);
        }
    }

    fn emit(&self, message: &str, out: &mut dyn Write) {
        if let Some(bytes) = sequence(self.method, message, self.tmux) {
            let _ = out.write_all(bytes.as_bytes());
            let _ = out.flush();
        }
    }
}

fn run_hook(hook: &Hook, event: Event, message: &str, session: &str, env: &EnvMap) {
    let spawned = Command::new("sh")
        .arg("-c")
        .arg(&hook.command)
        .env_clear()
        .envs(env)
        .env("GROK_EVENT", event.id())
        .env("GROK_MESSAGE", message)
        .env("GROK_SESSION_ID", session)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = spawned else {
        return;
    };
    let timeout = Duration::from_secs(hook.timeout_secs);
    // Reap off the UI thread; kill a hook that outlives its timeout.
    std::thread::spawn(move || {
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => return,
                Ok(None) if started.elapsed() >= timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_env::HostOs;

    fn term(pairs: &[(&str, &str)]) -> (TermEnv, EnvMap) {
        let env: EnvMap = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        (TermEnv::from_env(&env, HostOs::Linux, false), env)
    }

    fn table(text: &str) -> TomlValue {
        toml::from_str(text).unwrap()
    }

    #[test]
    fn defaults_and_parsing() {
        let policy = resolve(&table(""));
        assert_eq!(policy, Policy::default());
        let policy = resolve(&table(
            "[ui.notifications]\nmethod = \"osc777\"\ncondition = \"always\"\nidle_threshold_secs = 0\nevents = [\"agent_error\", \"task_complete\"]\nprogress_bar = true\n[[ui.notifications.hooks]]\ncommand = \"echo hi\"\nevents = [\"turn_complete\"]\n",
        ));
        assert_eq!(policy.method, Method::Osc777);
        assert_eq!(policy.condition, Condition::Always);
        assert_eq!(policy.idle_threshold_secs, 0);
        assert_eq!(policy.events, vec![Event::AgentError]);
        assert_eq!(policy.hooks.len(), 1);
        assert!(policy.hooks[0].only_unfocused);
        assert_eq!(policy.hooks[0].timeout_secs, 10);
        assert!(policy.warnings.iter().any(|w| w.contains("task_complete")));
        assert!(policy.warnings.iter().any(|w| w.contains("progress_bar")));
        let bad = resolve(&table("[ui.notifications]\nmethod = \"loud\"\n"));
        assert_eq!(bad.method, Method::Auto);
        assert_eq!(bad.warnings.len(), 1);
    }

    #[test]
    fn auto_matrix() {
        let cases = [
            (vec![("TERM_PROGRAM", "iTerm.app")], Method::Osc9),
            (vec![("TERM", "xterm-kitty")], Method::Osc99),
            (vec![("TERM_PROGRAM", "ghostty")], Method::Osc777),
            (vec![("WEZTERM_PANE", "1")], Method::Osc9),
            (vec![("TERM", "alacritty")], Method::Bel),
            (vec![("TERM_PROGRAM", "vscode")], Method::Bel),
            (vec![("VTE_VERSION", "7000")], Method::Osc777),
            (
                vec![("TERM_PROGRAM", "ghostty"), ("ZELLIJ", "0")],
                Method::Bel,
            ),
            (vec![], Method::Bel),
        ];
        for (pairs, method) in cases {
            assert_eq!(auto_method(&term(&pairs).0), method, "{pairs:?}");
        }
    }

    #[test]
    fn sequences_sanitize_and_wrap() {
        assert_eq!(
            sequence(Method::Osc9, "done\x07\x1b]x", false).unwrap(),
            "\x1b]9;done]x · codsh\x07"
        );
        assert_eq!(
            sequence(Method::Osc777, "t", true).unwrap(),
            "\x1bPtmux;\x1b\x1b]777;notify;codsh;t\x1b\x1b\\\x1b\\"
        );
        assert!(sequence(Method::None, "x", false).is_none());
    }

    #[test]
    fn unfocused_condition_waits_for_threshold_and_focus_cancels() {
        let (term, env) = term(&[("TERM_PROGRAM", "iTerm.app")]);
        let mut notifier = Notifier::new(Policy::default(), &term, env);
        let start = Instant::now();
        let mut out = Vec::new();
        notifier.event(Event::TurnComplete, "focused", start, &mut out);
        assert!(out.is_empty(), "focused terminal gets nothing");
        notifier.focus(false, start);
        notifier.event(Event::TurnComplete, "away", start, &mut out);
        assert!(out.is_empty(), "idle threshold not reached");
        notifier.tick(start + Duration::from_secs(1), &mut out);
        assert!(out.is_empty());
        notifier.tick(start + Duration::from_secs(4), &mut out);
        assert_eq!(String::from_utf8_lossy(&out), "\x1b]9;away · codsh\x07");
        out.clear();
        notifier.event(
            Event::ApprovalRequired,
            "later",
            start + Duration::from_secs(5),
            &mut out,
        );
        assert!(
            !out.is_empty(),
            "already away past the threshold: immediate"
        );
        out.clear();
        let second = start + Duration::from_secs(10);
        notifier.focus(true, second);
        notifier.focus(false, second);
        notifier.event(Event::TurnComplete, "cancel me", second, &mut out);
        notifier.focus(true, second + Duration::from_secs(1));
        notifier.tick(second + Duration::from_secs(9), &mut out);
        assert!(
            out.is_empty(),
            "focus gain cancels the pending notification"
        );
        notifier.event(Event::SessionReady, "not subscribed", second, &mut out);
        assert!(out.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn hooks_get_event_env_and_respect_focus() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("hook.log");
        let policy = Policy {
            condition: Condition::Never,
            hooks: vec![Hook {
                command: format!(
                    "printf '%s|%s|%s\\n' \"$GROK_EVENT\" \"$GROK_MESSAGE\" \"$GROK_SESSION_ID\" >> '{}'",
                    log.display()
                ),
                events: vec![Event::TurnComplete],
                only_unfocused: true,
                timeout_secs: 5,
            }],
            ..Policy::default()
        };
        let (term, mut env) = term(&[]);
        env.insert("PATH".into(), "/usr/bin:/bin".into());
        let mut notifier = Notifier::new(policy, &term, env);
        notifier.set_session(Some("sess-1"));
        let now = Instant::now();
        let mut out = Vec::new();
        notifier.event(Event::TurnComplete, "focused", now, &mut out);
        notifier.focus(false, now);
        notifier.event(Event::ApprovalRequired, "other", now, &mut out);
        notifier.event(Event::TurnComplete, "hello", now, &mut out);
        assert!(out.is_empty(), "condition never: no terminal bytes");
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && !log.exists() {
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            "turn_complete|hello|sess-1\n"
        );
    }
}
