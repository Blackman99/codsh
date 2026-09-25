//! Background commands and completion wake (ticket 175).
//!
//! dsh runs every command. `packages/cli/bin/rust-acp-background.mjs` starts
//! a foreground `bash` call as a real dsh job, waits on it in the foreground,
//! and moves it to the background on Ctrl+B, on a new message, or when the
//! `[toolset.bash]` auto-background budget runs out. It reports lifecycle
//! lines on stderr as `\u{241e}job\u{241e}{json}`. This module resolves the
//! policy the plugin reads (CODSH_BASH_POLICY) and keeps the command half of
//! the task board from those lines.
//!
//! Monitors (ticket 176) share this board: `rust-acp-monitor.mjs` runs each
//! one as a dsh job of kind `monitor` and reports it on the same channel
//! (`"kind":"monitor"`), plus a `monitor` line when an event reaches the
//! model and `hint` lines for what the user should see at once.
//!
//! A command lives exactly as long as dsh keeps it: it ends with its session
//! (closed on a switch or `/new`) and with the dsh process. The board never
//! claims a command is still running after that, and a restored history never
//! brings one back.

use serde_json::{Value, json};
use std::time::{Duration, Instant};
use toml::Value as TomlValue;

pub const MARK: &str = "\u{241e}job\u{241e}";
/// Reference `[toolset.bash] foreground_block_budget_ms` default.
pub const DEFAULT_BUDGET_MS: u64 = 15_000;
/// The user line of a transcript turn that a finished command opened.
pub const NOTICE_PREFIX: &str = "◎ Task completed · ";
/// The user line of a transcript turn that a monitor event opened.
pub const MONITOR_PREFIX: &str = "◎ Monitor event · ";
/// The `monitor` tool's result (reference wording).
pub const MONITOR_MARKER: &str = "Monitor started (task ";
/// Tool result text of a command moved to the background (the plugin's
/// `movedText`); a shell card with it has no exit code yet.
pub const MOVED_MARKER: &str = "[Command moved to background]";
/// dsh's own acknowledgement of an explicit `run_in_background` call.
pub const STARTED_MARKER: &str = "started background job ";
const OUTPUT_TAIL: usize = 4000;

/// `[toolset.bash]` as dsh should apply it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub auto_background: bool,
    pub budget_ms: u64,
    pub warnings: Vec<String>,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            auto_background: true,
            budget_ms: DEFAULT_BUDGET_MS,
            warnings: Vec::new(),
        }
    }
}

/// Resolve `[toolset.bash] auto_background_on_timeout` (default true) and
/// `foreground_block_budget_ms` (default 15000; 0 moves a command only at its
/// timeout). A value of the wrong type is reported and the default kept.
pub fn resolve(table: &TomlValue) -> Policy {
    let mut policy = Policy::default();
    let Some(section) = table.get("toolset").and_then(|value| value.get("bash")) else {
        return policy;
    };
    match section.get("auto_background_on_timeout") {
        None => {}
        Some(TomlValue::Boolean(value)) => policy.auto_background = *value,
        Some(other) => policy.warnings.push(format!(
            "[toolset.bash] auto_background_on_timeout = {other} is not true/false; using true"
        )),
    }
    match section.get("foreground_block_budget_ms") {
        None => {}
        Some(TomlValue::Integer(value)) if *value >= 0 => policy.budget_ms = *value as u64,
        Some(other) => policy.warnings.push(format!(
            "[toolset.bash] foreground_block_budget_ms = {other} is not a whole number of milliseconds >= 0; using {DEFAULT_BUDGET_MS}"
        )),
    }
    policy
}

impl Policy {
    pub fn to_json(&self) -> Value {
        json!({
            "autoBackground": self.auto_background,
            "budgetMs": self.budget_ms,
        })
    }

    /// `inspect` rows.
    pub fn inspect_lines(&self) -> Vec<String> {
        let mut lines = vec![format!(
            "Background commands: auto_background_on_timeout {} · foreground_block_budget_ms {}{} · Ctrl+B moves a running command",
            self.auto_background,
            self.budget_ms,
            if self.budget_ms == 0 {
                " (only at the command timeout)"
            } else {
                ""
            }
        )];
        lines.extend(
            self.warnings
                .iter()
                .map(|warning| format!("Background commands warning: {warning}")),
        );
        lines
    }
}

/// Environment for the dsh child. `foreground` lets the plugin run a
/// foreground command as a movable dsh job. A headless (plain) turn ends when
/// dsh answers and nothing is left to wake or press Ctrl+B, so there the
/// command runs through dsh's plain foreground path to its timeout, as before.
/// Without this variable (editor ACP, shared server) the plugin leaves
/// foreground commands alone too.
pub fn dsh_env(policy: &Policy, headless: bool) -> Vec<(String, String)> {
    let mut value = policy.to_json();
    value["foreground"] = Value::Bool(!headless);
    if headless {
        value["autoBackground"] = Value::Bool(false);
    }
    vec![("CODSH_BASH_POLICY".to_string(), value.to_string())]
}

/// The monitor switch (ticket 176). Only the interactive client sets it: a
/// plain turn, editor ACP and the shared server end before an event could
/// be delivered, so dsh offers no `monitor` tool there.
pub fn monitor_env() -> Vec<(String, String)> {
    vec![("CODSH_MONITOR".to_string(), "1".to_string())]
}

/// Parse one stderr line. None when it is not a command lifecycle line.
pub fn parse_line(text: &str) -> Option<Value> {
    let body = text.strip_prefix(MARK)?;
    serde_json::from_str::<Value>(body)
        .ok()
        .filter(Value::is_object)
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn tail(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &text[start..])
}

fn seconds(elapsed: Duration) -> String {
    let secs = elapsed.as_secs_f64();
    if secs < 10.0 {
        format!("{secs:.1}s")
    } else {
        format!("{}s", elapsed.as_secs())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Running,
    /// Exited on its own (any exit code).
    Completed,
    /// Stopped by a signal, `job_kill`, the tasks pane, or a cancelled turn.
    Killed,
    Failed,
    /// Its session or the dsh process ended first; dsh stopped it with them.
    Ended,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Running => "running",
            Status::Completed => "completed",
            Status::Killed => "killed",
            Status::Failed => "failed",
            Status::Ended => "ended",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Job {
    pub id: String,
    pub session: String,
    pub label: String,
    /// `explicit` (run_in_background), `auto`, `user` (Ctrl+B), `message`,
    /// or `monitor`.
    pub reason: String,
    /// A monitor (ticket 176) rather than a command.
    pub monitor: bool,
    /// A monitor that runs until it is stopped or its session ends.
    pub persistent: bool,
    /// A monitor's deadline (0 when persistent).
    pub timeout_ms: u64,
    /// Events a monitor delivered.
    pub events: u64,
    pub status: Status,
    pub detail: String,
    pub output: String,
    pub started: Instant,
    pub elapsed: Option<Duration>,
}

impl Job {
    pub fn elapsed(&self) -> Duration {
        self.elapsed.unwrap_or_else(|| self.started.elapsed())
    }

    fn how(&self) -> &'static str {
        match self.reason.as_str() {
            "auto" => "auto-background",
            "user" => "Ctrl+B",
            "message" => "moved by a new message",
            _ => "run_in_background",
        }
    }

    /// One tasks-pane row (without the cursor mark).
    pub fn row(&self) -> String {
        if self.monitor {
            return format!(
                "[{}] {} · monitor · {} · {} · {} event{}",
                self.status.as_str(),
                self.label.lines().next().unwrap_or(""),
                seconds(self.elapsed()),
                if self.persistent || self.timeout_ms == 0 {
                    "persistent".to_string()
                } else {
                    format!(
                        "timeout {}",
                        seconds(Duration::from_millis(self.timeout_ms))
                    )
                },
                self.events,
                if self.events == 1 { "" } else { "s" }
            );
        }
        format!(
            "[{}] {} · command · {} · {}",
            self.status.as_str(),
            self.label.lines().next().unwrap_or(""),
            seconds(self.elapsed()),
            self.how()
        )
    }
}

/// What the client does with a lifecycle line besides updating the board.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Signal {
    /// A completion notice reached the model in this session.
    Notice { session: String, summary: String },
    /// Monitor events reached the model in this session.
    Monitor { session: String, summary: String },
    /// This session's agent went idle (a wake turn may close).
    Idle { session: String },
    /// This session's agent started a step run.
    Running { session: String },
    /// A line for the notice row.
    Hint(String),
}

/// The command half of the task board, fed by the plugin's lifecycle lines.
#[derive(Clone, Debug, Default)]
pub struct Jobs {
    pub entries: Vec<Job>,
    /// Session whose model is blocked in `job_output` with `wait: true`.
    pub waiting: Option<String>,
}

impl Jobs {
    #[cfg(test)]
    pub fn get(&self, id: &str) -> Option<&Job> {
        self.entries.iter().find(|job| job.id == id)
    }

    /// dsh numbers jobs per process (`bash-1`, `bash-2`, ...), so a new dsh
    /// process after /new or a reconnect reuses ids: a job is its session
    /// and id. A line without a session matches the newest job with that id.
    fn find_mut(&mut self, session: &str, id: &str) -> Option<&mut Job> {
        self.entries
            .iter_mut()
            .rev()
            .find(|job| job.id == id && (session.is_empty() || job.session == session))
    }

    /// Apply one lifecycle line. An end is applied once.
    pub fn apply(&mut self, event: &Value) -> Option<Signal> {
        let kind = text(event, "event");
        let session = text(event, "session");
        match kind.as_str() {
            "start" => {
                let id = text(event, "id");
                if id.is_empty()
                    || self
                        .entries
                        .iter()
                        .any(|job| job.id == id && job.session == session)
                {
                    return None;
                }
                let reason = text(event, "reason");
                let monitor = text(event, "kind") == "monitor";
                let job = Job {
                    id,
                    session,
                    label: text(event, "label"),
                    reason,
                    monitor,
                    persistent: event.get("persistent").and_then(Value::as_bool) == Some(true),
                    timeout_ms: event.get("timeoutMs").and_then(Value::as_u64).unwrap_or(0),
                    events: 0,
                    status: Status::Running,
                    detail: String::new(),
                    output: tail(&text(event, "output"), OUTPUT_TAIL),
                    started: Instant::now(),
                    elapsed: None,
                };
                let hint = match job.reason.as_str() {
                    _ if job.monitor => Some(format!(
                        "monitor started: \"{}\" · events reach this session · Ctrl+G or /tasks",
                        job.label.lines().next().unwrap_or("")
                    )),
                    "explicit" => None,
                    "auto" => Some(format!(
                        "command moved to the background after the foreground budget: \"{}\" · Ctrl+G or /tasks",
                        job.label.lines().next().unwrap_or("")
                    )),
                    _ => Some(format!(
                        "command moved to the background: \"{}\" · Ctrl+G or /tasks",
                        job.label.lines().next().unwrap_or("")
                    )),
                };
                self.entries.push(job);
                hint.map(Signal::Hint)
            }
            "output" => {
                let id = text(event, "id");
                let job = self.find_mut(&session, &id)?;
                job.output.push_str(&text(event, "text"));
                job.output = tail(&job.output, OUTPUT_TAIL);
                if job.monitor {
                    job.events += 1;
                }
                None
            }
            "end" => {
                let id = text(event, "id");
                let job = self.find_mut(&session, &id)?;
                if job.status != Status::Running {
                    return None;
                }
                job.status = match text(event, "status").as_str() {
                    "completed" => Status::Completed,
                    "killed" => Status::Killed,
                    _ => Status::Failed,
                };
                job.detail = text(event, "detail");
                job.elapsed = event
                    .get("elapsedMs")
                    .and_then(Value::as_u64)
                    .map(Duration::from_millis)
                    .or_else(|| Some(job.started.elapsed()));
                // A monitor's end (and why) shows at once, failure or not.
                job.monitor.then(|| {
                    let why = job
                        .detail
                        .strip_prefix("monitor ended: ")
                        .unwrap_or(&job.detail);
                    Signal::Hint(format!(
                        "monitor \"{}\" ended: {}",
                        job.label.lines().next().unwrap_or(""),
                        if why.is_empty() {
                            job.status.as_str()
                        } else {
                            why
                        }
                    ))
                })
            }
            "wait" => {
                if event.get("on").and_then(Value::as_bool) == Some(true) {
                    self.waiting = Some(session);
                } else if self.waiting.as_deref() == Some(session.as_str()) {
                    self.waiting = None;
                }
                None
            }
            "notice" => Some(Signal::Notice {
                session,
                summary: text(event, "summary"),
            }),
            "monitor" => Some(Signal::Monitor {
                session,
                summary: text(event, "summary"),
            }),
            "hint" => {
                let line = text(event, "text");
                (!line.is_empty()).then_some(Signal::Hint(line))
            }
            // A workflow completion notice names the run (`what`) instead of a job.
            "requeued" => Some(Signal::Hint(
                match event.get("what").and_then(Value::as_str) {
                    Some(what) if !what.is_empty() => format!(
                        "{what} finished during the cancelled turn; the model sees it with your next message"
                    ),
                    _ => format!(
                        "background job {} finished during the cancelled turn; the model sees it with your next message",
                        text(event, "job")
                    ),
                },
            )),
            "status" => match text(event, "status").as_str() {
                "idle" => {
                    if self.waiting.as_deref() == Some(session.as_str()) {
                        self.waiting = None;
                    }
                    Some(Signal::Idle { session })
                }
                "running" => Some(Signal::Running { session }),
                _ => None,
            },
            "disposed" => {
                let count = self.end_session(&session, "stopped when its dsh session closed");
                (count > 0).then(|| {
                    Signal::Hint(format!(
                        "{count} background command(s) stopped with the closed session"
                    ))
                })
            }
            _ => None,
        }
    }

    /// Mark every running command of a session ended. Returns how many.
    pub fn end_session(&mut self, session: &str, why: &str) -> usize {
        let mut count = 0;
        for job in &mut self.entries {
            if job.session == session && job.status == Status::Running {
                job.status = Status::Ended;
                job.detail = why.to_string();
                job.elapsed = Some(job.started.elapsed());
                count += 1;
            }
        }
        if self.waiting.as_deref() == Some(session) {
            self.waiting = None;
        }
        count
    }

    /// The dsh process is gone and every job with it.
    pub fn end_all(&mut self, why: &str) -> usize {
        let mut count = 0;
        for job in &mut self.entries {
            if job.status == Status::Running {
                job.status = Status::Ended;
                job.detail = why.to_string();
                job.elapsed = Some(job.started.elapsed());
                count += 1;
            }
        }
        self.waiting = None;
        count
    }

    pub fn running(&self) -> usize {
        self.entries
            .iter()
            .filter(|job| job.status == Status::Running)
            .count()
    }

    /// Running commands (not monitors).
    pub fn running_commands(&self) -> usize {
        self.entries
            .iter()
            .filter(|job| job.status == Status::Running && !job.monitor)
            .count()
    }

    /// Running monitors.
    pub fn running_monitors(&self) -> usize {
        self.entries
            .iter()
            .filter(|job| job.status == Status::Running && job.monitor)
            .count()
    }

    pub fn has_monitors(&self) -> bool {
        self.entries.iter().any(|job| job.monitor)
    }

    pub fn is_waiting(&self, session: Option<&str>) -> bool {
        session.is_some() && self.waiting.as_deref() == session
    }

    pub fn visible(&self, hide_completed: bool) -> Vec<&Job> {
        self.entries
            .iter()
            .filter(|job| !hide_completed || job.status == Status::Running)
            .collect()
    }
}

/// The transcript line for a completion notice (`summary` is dsh's
/// `<kind> <label> [status: …]`).
pub fn notice_line(summary: &str) -> String {
    let summary = summary.trim();
    if summary.is_empty() {
        NOTICE_PREFIX.trim_end_matches(" · ").to_string()
    } else {
        format!("{NOTICE_PREFIX}{summary}")
    }
}

/// The hint when commands and monitors were stopped (`when`: "with the
/// previous session", "when dsh exited").
pub fn ended_hint(commands: usize, monitors: usize, when: &str) -> String {
    let what = match (commands, monitors) {
        (0, m) => format!("{m} monitor(s)"),
        (c, 0) => format!("{c} background command(s)"),
        (c, m) => format!("{c} background command(s) and {m} monitor(s)"),
    };
    format!("{what} stopped {when}")
}

/// The transcript line for monitor events that reached the model
/// (`summary` is the plugin's `<description>: <first line>`).
pub fn monitor_line(summary: &str) -> String {
    let summary = summary.trim();
    if summary.is_empty() {
        MONITOR_PREFIX.trim_end_matches(" · ").to_string()
    } else {
        format!("{MONITOR_PREFIX}{summary}")
    }
}

pub fn is_notice_line(text: &str) -> bool {
    text.starts_with(NOTICE_PREFIX.trim_end_matches(" · "))
        || text.starts_with(MONITOR_PREFIX.trim_end_matches(" · "))
}

/// A restored tool result that describes a background command or monitor.
pub fn mentions_background(result: &str) -> bool {
    result.contains(MOVED_MARKER)
        || result.starts_with(STARTED_MARKER)
        || result.starts_with(MONITOR_MARKER)
}

/// The notice for a resumed history that started background commands.
pub const RESTORED_HINT: &str = "Background commands and monitors in this history are not running: dsh stopped them when their previous process or session ended. Rerun a command or monitor to start it again.";

#[cfg(test)]
mod tests {
    use super::*;

    fn table(text: &str) -> TomlValue {
        toml::from_str(text).unwrap()
    }

    #[test]
    fn policy_defaults_follow_the_reference() {
        let policy = resolve(&table(""));
        assert!(policy.auto_background);
        assert_eq!(policy.budget_ms, 15_000);
        assert!(policy.warnings.is_empty());
        assert_eq!(
            dsh_env(&policy, false),
            vec![(
                "CODSH_BASH_POLICY".to_string(),
                r#"{"autoBackground":true,"budgetMs":15000,"foreground":true}"#.to_string()
            )]
        );
    }

    #[test]
    fn policy_reads_toolset_bash_and_reports_bad_values() {
        let policy = resolve(&table(
            "[toolset.bash]\nauto_background_on_timeout = false\nforeground_block_budget_ms = 0\n",
        ));
        assert!(!policy.auto_background);
        assert_eq!(policy.budget_ms, 0);
        assert!(policy.inspect_lines()[0].contains("only at the command timeout"));
        let bad = resolve(&table(
            "[toolset.bash]\nauto_background_on_timeout = \"yes\"\nforeground_block_budget_ms = -1\n",
        ));
        assert!(bad.auto_background);
        assert_eq!(bad.budget_ms, DEFAULT_BUDGET_MS);
        assert_eq!(bad.warnings.len(), 2);
        assert!(
            bad.inspect_lines()
                .iter()
                .any(|line| line.contains("warning"))
        );
    }

    #[test]
    fn headless_turns_never_auto_background() {
        let env = dsh_env(&Policy::default(), true);
        let value: Value = serde_json::from_str(&env[0].1).unwrap();
        assert_eq!(value["autoBackground"], Value::Bool(false));
        assert_eq!(value["foreground"], Value::Bool(false));
    }

    #[test]
    fn parses_only_marked_lines() {
        assert!(parse_line(&format!("{MARK}{{\"event\":\"start\"}}")).is_some());
        assert!(parse_line(&format!("{MARK}[1]")).is_none());
        assert!(parse_line(&format!("{MARK}not json")).is_none());
        assert!(parse_line("{\"event\":\"start\"}").is_none());
    }

    fn start(jobs: &mut Jobs, id: &str, session: &str, reason: &str) -> Option<Signal> {
        jobs.apply(&json!({"event":"start","id":id,"session":session,"label":"sleep 30","reason":reason,"output":"tick\n"}))
    }

    #[test]
    fn board_tracks_start_output_and_one_end() {
        let mut jobs = Jobs::default();
        assert!(
            matches!(start(&mut jobs, "j1", "s1", "auto"), Some(Signal::Hint(text)) if text.contains("foreground budget"))
        );
        assert_eq!(start(&mut jobs, "j2", "s1", "explicit"), None);
        assert_eq!(
            start(&mut jobs, "j1", "s1", "auto"),
            None,
            "a repeated start is ignored"
        );
        assert_eq!(jobs.running(), 2);
        jobs.apply(&json!({"event":"output","id":"j1","text":"tock\n"}));
        assert_eq!(jobs.get("j1").unwrap().output, "tick\ntock\n");
        jobs.apply(&json!({"event":"end","id":"j1","status":"completed","detail":"exit code: 0","elapsedMs":2500}));
        jobs.apply(&json!({"event":"end","id":"j1","status":"killed","detail":"signal: SIGTERM"}));
        let job = jobs.get("j1").unwrap();
        assert_eq!(job.status, Status::Completed);
        assert_eq!(job.detail, "exit code: 0");
        assert_eq!(job.elapsed(), Duration::from_millis(2500));
        assert!(
            job.row()
                .starts_with("[completed] sleep 30 · command · 2.5s · auto-background")
        );
        assert_eq!(jobs.running(), 1);
        assert_eq!(jobs.visible(true).len(), 1);
        assert_eq!(jobs.visible(false).len(), 2);
    }

    #[test]
    fn a_closed_session_or_exited_dsh_ends_its_commands() {
        let mut jobs = Jobs::default();
        start(&mut jobs, "j1", "s1", "user");
        start(&mut jobs, "j2", "s2", "user");
        jobs.apply(&json!({"event":"wait","session":"s1","job":"j1","on":true}));
        assert!(jobs.is_waiting(Some("s1")));
        assert!(matches!(
            jobs.apply(&json!({"event":"disposed","session":"s1"})),
            Some(Signal::Hint(text)) if text.starts_with("1 background command")
        ));
        assert!(!jobs.is_waiting(Some("s1")));
        assert_eq!(jobs.get("j1").unwrap().status, Status::Ended);
        assert_eq!(jobs.get("j2").unwrap().status, Status::Running);
        // A late end for an ended command does not bring it back.
        jobs.apply(&json!({"event":"end","id":"j1","status":"completed"}));
        assert_eq!(jobs.get("j1").unwrap().status, Status::Ended);
        assert_eq!(jobs.end_all("dsh exited"), 1);
        assert_eq!(jobs.running(), 0);
    }

    #[test]
    fn a_new_dsh_process_reuses_job_ids_per_session() {
        let mut jobs = Jobs::default();
        start(&mut jobs, "bash-1", "old", "explicit");
        assert_eq!(
            jobs.end_session("old", "stopped when its dsh session closed"),
            1
        );
        // After /new, the next dsh process numbers from bash-1 again.
        start(&mut jobs, "bash-1", "new", "explicit");
        assert_eq!(jobs.running(), 1);
        jobs.apply(&json!({"event":"output","id":"bash-1","session":"new","text":"fresh\n"}));
        jobs.apply(&json!({"event":"end","id":"bash-1","session":"old","status":"completed"}));
        assert_eq!(
            jobs.running(),
            1,
            "an end for the old session's job leaves the new one"
        );
        let fresh = jobs
            .entries
            .iter()
            .find(|job| job.session == "new")
            .unwrap();
        assert!(fresh.output.ends_with("fresh\n"));
        jobs.apply(&json!({"event":"end","id":"bash-1","session":"new","status":"killed","detail":"signal: SIGTERM"}));
        assert_eq!(jobs.running(), 0);
        assert_eq!(
            jobs.entries
                .iter()
                .filter(|job| job.status == Status::Ended)
                .count(),
            1
        );
    }

    #[test]
    fn wait_notice_and_status_signals() {
        let mut jobs = Jobs::default();
        jobs.apply(&json!({"event":"wait","session":"s1","job":"j1","on":true}));
        assert!(jobs.is_waiting(Some("s1")));
        assert!(!jobs.is_waiting(Some("s2")));
        assert!(!jobs.is_waiting(None));
        jobs.apply(&json!({"event":"wait","session":"s1","job":"j1","on":false}));
        assert!(!jobs.is_waiting(Some("s1")));
        assert_eq!(
            jobs.apply(&json!({"event":"notice","session":"s1","job":"j1","summary":"bash sleep 3 [exit code: 0]"})),
            Some(Signal::Notice {
                session: "s1".into(),
                summary: "bash sleep 3 [exit code: 0]".into()
            })
        );
        jobs.apply(&json!({"event":"wait","session":"s1","job":"j1","on":true}));
        assert_eq!(
            jobs.apply(&json!({"event":"status","session":"s1","status":"idle"})),
            Some(Signal::Idle {
                session: "s1".into()
            })
        );
        assert!(!jobs.is_waiting(Some("s1")), "idle ends any wait");
        assert_eq!(
            jobs.apply(&json!({"event":"status","session":"s1","status":"running"})),
            Some(Signal::Running {
                session: "s1".into()
            })
        );
        assert!(matches!(
            jobs.apply(&json!({"event":"requeued","session":"s1","job":"j9"})),
            Some(Signal::Hint(text)) if text.contains("j9")
        ));
        assert_eq!(
            jobs.apply(&json!({"event":"requeued","session":"s1","job":"","what":"workflow triage [complete]"})),
            Some(Signal::Hint(
                "workflow triage [complete] finished during the cancelled turn; the model sees it with your next message".into()
            ))
        );
    }

    #[test]
    fn monitors_share_the_board_with_their_own_rows_and_hints() {
        let mut jobs = Jobs::default();
        assert_eq!(
            monitor_env(),
            vec![("CODSH_MONITOR".to_string(), "1".to_string())]
        );
        let hint = jobs.apply(&json!({"event":"start","id":"monitor-1","session":"s1","kind":"monitor","label":"ci main","reason":"monitor","persistent":false,"timeoutMs":90000,"output":""}));
        assert!(
            matches!(hint, Some(Signal::Hint(text)) if text.starts_with("monitor started: \"ci main\""))
        );
        jobs.apply(&json!({"event":"start","id":"monitor-2","session":"s1","kind":"monitor","label":"pr","reason":"monitor","persistent":true,"timeoutMs":0,"output":""}));
        start(&mut jobs, "bash-1", "s1", "explicit");
        assert_eq!(jobs.running(), 3);
        assert_eq!(jobs.running_commands(), 1);
        assert_eq!(jobs.running_monitors(), 2);
        assert!(jobs.has_monitors());
        jobs.apply(
            &json!({"event":"output","id":"monitor-1","session":"s1","text":"FAILED build\n"}),
        );
        let job = jobs.get("monitor-1").unwrap();
        assert_eq!(job.events, 1);
        assert!(
            job.row().starts_with("[running] ci main · monitor · "),
            "{}",
            job.row()
        );
        assert!(
            job.row().ends_with(" · timeout 90s · 1 event"),
            "{}",
            job.row()
        );
        assert!(
            jobs.get("monitor-2")
                .unwrap()
                .row()
                .ends_with(" · persistent · 0 events")
        );
        assert_eq!(
            jobs.apply(&json!({"event":"monitor","session":"s1","id":"monitor-1","count":1,"summary":"ci main: FAILED build","text":"FAILED build"})),
            Some(Signal::Monitor {
                session: "s1".into(),
                summary: "ci main: FAILED build".into()
            })
        );
        assert_eq!(
            jobs.apply(&json!({"event":"hint","session":"s1","text":"monitor \"x\" stopped: its script produced too much output"})),
            Some(Signal::Hint(
                "monitor \"x\" stopped: its script produced too much output".into()
            ))
        );
        assert_eq!(
            jobs.apply(&json!({"event":"hint","session":"s1","text":""})),
            None
        );
        assert_eq!(
            jobs.apply(&json!({"event":"end","id":"monitor-1","session":"s1","kind":"monitor","status":"completed","detail":"monitor ended: exited (code 4)","elapsedMs":1500})),
            Some(Signal::Hint("monitor \"ci main\" ended: exited (code 4)".into()))
        );
        // A command's end stays quiet, as before.
        assert_eq!(
            jobs.apply(&json!({"event":"end","id":"bash-1","session":"s1","status":"completed","detail":"exit code: 0"})),
            None
        );
        assert_eq!(jobs.running_monitors(), 1);
        assert_eq!(
            jobs.end_session("s1", "stopped when its dsh session closed"),
            1
        );
        assert_eq!(jobs.get("monitor-2").unwrap().status, Status::Ended);
        assert_eq!(
            monitor_line("ci main: FAILED build"),
            "◎ Monitor event · ci main: FAILED build"
        );
        assert_eq!(monitor_line(" "), "◎ Monitor event");
        assert!(is_notice_line("◎ Monitor event · x"));
        assert!(mentions_background(
            "Monitor started (task monitor-1, timeout 5000ms).\nYou will be notified"
        ));
        assert!(RESTORED_HINT.contains("monitors"));
    }

    #[test]
    fn session_end_hint_names_commands_and_monitors() {
        assert_eq!(
            ended_hint(2, 0, "with the previous session"),
            "2 background command(s) stopped with the previous session"
        );
        assert_eq!(
            ended_hint(0, 1, "when dsh exited"),
            "1 monitor(s) stopped when dsh exited"
        );
        assert_eq!(
            ended_hint(1, 1, "with the previous session"),
            "1 background command(s) and 1 monitor(s) stopped with the previous session"
        );
    }

    #[test]
    fn notice_lines_and_restored_markers() {
        assert_eq!(
            notice_line("bash sleep 3 [exit code: 0]"),
            "◎ Task completed · bash sleep 3 [exit code: 0]"
        );
        assert_eq!(notice_line(""), "◎ Task completed");
        assert!(is_notice_line("◎ Task completed · x"));
        assert!(!is_notice_line("Task completed"));
        assert!(mentions_background(
            "[Command moved to background]\nUser moved…"
        ));
        assert!(mentions_background("started background job j1"));
        assert!(!mentions_background("hello"));
        assert_eq!(tail("abcdef", 3), "…def");
        assert_eq!(tail("ééé", 3), "…é");
    }
}
