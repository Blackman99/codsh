//! Scheduled prompts (ticket 177): the client half.
//!
//! `packages/cli/bin/rust-acp-scheduler.mjs` owns the tasks inside dsh: the
//! `scheduler_create`, `scheduler_delete` and `scheduler_list` tools, the
//! timers, and the fires, each a real dsh background subagent. It writes one
//! `\u{241e}schedule\u{241e}{json}` line per lifecycle step on stderr. This
//! module keeps the client's view of those tasks for the tasks pane (Ctrl+G
//! or /tasks) and the status line, and builds the `/loop` command: its usage
//! line, the model instruction it expands into (the reference wording), and
//! the provisional schedule preview shown while the model schedules it.
//!
//! Only the interactive client turns the scheduler on (CODSH_SCHEDULER=1).
//!
//! Saved loops (ticket 178): dsh saves a session's tasks once this client,
//! holding the session's owner lock, hands over the lock token
//! (`schedule_owner` on the control channel), and restores the saved ones
//! when the session is resumed. Each row says whether its loop is saved,
//! durable, paused (and why), what became of the last fire (including a
//! fire whose outcome is unknown because its process ended while it ran),
//! and whether the permission mode changed since the loop was created.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

pub const MARK: &str = "\u{241e}schedule\u{241e}";

/// The switch the dsh plugin reads. A plain turn, editor ACP and the shared
/// server never set it, so no scheduler tool reaches a process that would
/// end before a task could fire.
pub fn dsh_env() -> Vec<(String, String)> {
    vec![("CODSH_SCHEDULER".to_string(), "1".to_string())]
}

/// Parse one stderr line. None when it is not a scheduler lifecycle line.
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

/// Wall-clock milliseconds, the clock of `wakeAtMs`.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn short(text: &str, max: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() > max {
        format!("{}…", line.chars().take(max).collect::<String>())
    } else {
        line
    }
}

/// A fire's outcome as dsh recorded it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FireResult {
    pub fire: u64,
    /// `completed`, `failed`, `cancelled`, `not started`, or `unknown`.
    pub status: String,
    pub detail: String,
}

/// One active scheduled task as the client knows it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Task {
    pub id: String,
    pub session: String,
    pub prompt: String,
    pub human: String,
    /// Fires that started.
    pub fires: u64,
    /// A fire is running now.
    pub running: bool,
    /// Wall-clock milliseconds of the next wake (fire or expiry).
    pub wake_at_ms: Option<i64>,
    /// The latest outcome: a fire's status, a skip, or a failed start.
    pub last: String,
    pub durable: bool,
    /// Saved with the session: it comes back when the session is resumed.
    pub saved: bool,
    /// Why it is not saved (empty when saved).
    pub save_note: String,
    /// Restored from the saved session.
    pub restored: bool,
    /// Stopped and not firing, with the reason (empty when active).
    pub paused: String,
    /// The permission mode at creation and the one fires run under now.
    pub permission: Option<(String, String)>,
    pub last_result: Option<FireResult>,
}

impl Task {
    /// `[every 5 minutes] check deploy · next in 4m 10s · 2 fires · saved`
    pub fn row_at(&self, now: i64) -> String {
        let next = match self.wake_at_ms {
            Some(at) if self.paused.is_empty() => {
                format!(" · next in {}", countdown(at.saturating_sub(now)))
            }
            _ => String::new(),
        };
        let fires = match self.fires {
            0 => String::new(),
            1 => " · 1 fire".to_string(),
            count => format!(" · {count} fires"),
        };
        let running = if self.running { " · running" } else { "" };
        let kept = if self.durable && self.saved {
            " · durable"
        } else if self.saved {
            " · saved"
        } else {
            " · not saved"
        };
        let paused = if self.paused.is_empty() {
            ""
        } else {
            " · paused"
        };
        let outcome = match &self.last_result {
            Some(result) if result.status == "unknown" => {
                format!(" · fire {} outcome unknown", result.fire)
            }
            Some(result) if result.status == "failed" || result.status == "not started" => {
                format!(" · fire {} {}", result.fire, result.status)
            }
            _ => String::new(),
        };
        let permission = if self.permission.is_some() {
            " · permissions changed"
        } else {
            ""
        };
        format!(
            "[{}] {}{next}{fires}{running}{kept}{paused}{outcome}{permission}",
            self.human,
            short(&self.prompt, 60)
        )
    }

    /// The selected row's detail lines, without indentation.
    pub fn details(&self) -> Vec<String> {
        let mut lines = vec![format!("id {}", self.id)];
        lines.push(if self.saved {
            format!(
                "{} with this session: it comes back when the session is resumed",
                if self.durable {
                    "saved (durable)"
                } else {
                    "saved"
                }
            )
        } else if self.save_note.is_empty() {
            "not saved: it ends with this dsh process".to_string()
        } else {
            format!("not saved: {}", self.save_note)
        });
        if self.restored {
            lines.push("restored from the saved session".into());
        }
        if !self.paused.is_empty() {
            lines.push(self.paused.clone());
        }
        if let Some((created, now)) = &self.permission {
            lines.push(format!(
                "permissions changed: created under {created}, fires now run under {now}"
            ));
        }
        if !self.last.is_empty() {
            lines.push(format!("last: {}", self.last.lines().next().unwrap_or("")));
        }
        lines
    }
}

fn countdown(ms: i64) -> String {
    let secs = (ms.max(0) + 999) / 1000;
    if secs >= 86_400 {
        format!("{}d {}h", secs / 86_400, (secs % 86_400) / 3600)
    } else if secs >= 3600 {
        format!("{}h {}m", secs / 3600, (secs % 3600) / 60)
    } else if secs >= 60 {
        format!("{}m {}s", secs / 60, secs % 60)
    } else {
        format!("{secs}s")
    }
}

/// Every active task this client heard about, in creation order.
#[derive(Clone, Debug, Default)]
pub struct Schedules {
    pub entries: Vec<Task>,
    /// When the last restore hint was issued. The restored loops' catch-up
    /// fires settle right after it, and their notices must not hide it.
    restore_hint_at: Option<std::time::Instant>,
}

/// How long a restore hint outranks subagent notices.
const RESTORE_HINT_HOLD: std::time::Duration = std::time::Duration::from_secs(4);

impl Schedules {
    /// A restore hint went out recently: keep it over subagent notices.
    pub fn restore_hint_fresh(&self) -> bool {
        self.restore_hint_at
            .is_some_and(|at| at.elapsed() < RESTORE_HINT_HOLD)
    }

    fn find_mut(&mut self, session: &str, id: &str) -> Option<&mut Task> {
        self.entries
            .iter_mut()
            .find(|task| task.id == id && (session.is_empty() || task.session == session))
    }

    fn timing(task: &mut Task, event: &Value) {
        if let Some(at) = event.get("wakeAtMs").and_then(Value::as_i64) {
            task.wake_at_ms = Some(at);
        }
    }

    /// Saved, paused, permission and last-fire fields, when the line has them.
    fn flags(task: &mut Task, event: &Value) {
        if let Some(durable) = event.get("durable").and_then(Value::as_bool) {
            task.durable = durable;
        }
        if let Some(saved) = event.get("saved").and_then(Value::as_bool) {
            task.saved = saved;
            task.save_note = text(event, "saveNote");
        }
        if let Some(restored) = event.get("restored").and_then(Value::as_bool) {
            task.restored = restored;
        }
        if event.get("paused").is_some() {
            task.paused = text(event, "paused");
        }
        if let Some(permission) = event.get("permission") {
            task.permission = permission.as_object().map(|pair| {
                let side = |key: &str| {
                    pair.get(key)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                };
                (side("created"), side("now"))
            });
        }
        if let Some(result) = event.get("lastResult") {
            task.last_result = result.as_object().map(|result| FireResult {
                fire: result.get("fire").and_then(Value::as_u64).unwrap_or(0),
                status: result
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                detail: result
                    .get("detail")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            });
            if let Some(result) = &task.last_result
                && task.last.is_empty()
            {
                task.last = if result.detail.is_empty() {
                    format!("fire {}: {}", result.fire, result.status)
                } else {
                    format!("fire {}: {}: {}", result.fire, result.status, result.detail)
                };
            }
        }
    }

    /// Apply one lifecycle line. Returns a hint worth showing once.
    pub fn apply(&mut self, event: &Value) -> Option<String> {
        if text(event, "event") == "restore" {
            let restored = event.get("restored").and_then(Value::as_u64).unwrap_or(0);
            let error = text(event, "error");
            if restored > 0 || !error.is_empty() {
                self.restore_hint_at = Some(std::time::Instant::now());
            }
            return if !error.is_empty() {
                Some(format!(
                    "Saved loops for this session could not be read ({error}); the file is left as is: {}",
                    text(event, "path")
                ))
            } else if restored > 0 {
                Some(format!(
                    "Restored {restored} saved loop(s) for this session · Ctrl+G or /tasks"
                ))
            } else {
                None
            };
        }
        let id = text(event, "id");
        if id.is_empty() {
            return None;
        }
        let session = text(event, "session");
        match text(event, "event").as_str() {
            "created" => {
                let updated = event
                    .get("updated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let prompt = text(event, "prompt");
                let human = text(event, "human");
                if self.find_mut(&session, &id).is_none() {
                    self.entries.push(Task {
                        id: id.clone(),
                        session: session.clone(),
                        ..Default::default()
                    });
                }
                let task = self.find_mut(&session, &id)?;
                task.prompt = prompt;
                task.human = human;
                if let Some(fires) = event.get("fires").and_then(Value::as_u64) {
                    task.fires = fires;
                }
                Self::timing(task, event);
                Self::flags(task, event);
                // A restored loop is covered by the one restore hint.
                if task.restored && !updated {
                    return None;
                }
                Some(format!(
                    "{} {} · {} · Ctrl+G or /tasks",
                    if updated {
                        "Loop updated:"
                    } else {
                        "Loop scheduled:"
                    },
                    task.human,
                    short(&task.prompt, 48)
                ))
            }
            "state" => {
                let task = self.find_mut(&session, &id)?;
                let was = task.paused.clone();
                Self::timing(task, event);
                Self::flags(task, event);
                (task.paused != was && !task.paused.is_empty())
                    .then(|| format!("Loop paused ({}): {}", short(&task.prompt, 32), task.paused))
            }
            "fired" => {
                let task = self.find_mut(&session, &id)?;
                task.fires = event.get("fire").and_then(Value::as_u64).unwrap_or(0);
                task.running = true;
                Self::timing(task, event);
                Self::flags(task, event);
                None
            }
            "skipped" => {
                let task = self.find_mut(&session, &id)?;
                task.last = "skipped: the previous iteration is still running".into();
                Self::timing(task, event);
                None
            }
            "failed" => {
                let detail = text(event, "detail");
                let task = self.find_mut(&session, &id)?;
                task.running = false;
                task.last = format!("fire did not start: {detail}");
                task.last_result = Some(FireResult {
                    fire: event.get("fire").and_then(Value::as_u64).unwrap_or(0),
                    status: "not started".into(),
                    detail: detail.clone(),
                });
                Self::timing(task, event);
                Some(format!(
                    "Loop fire did not start ({}): {detail}",
                    short(&task.prompt, 32)
                ))
            }
            "result" => {
                // A deleted task's last fire still settles; nothing to show.
                let task = self.find_mut(&session, &id)?;
                task.running = false;
                let summary = text(event, "summary");
                let status = text(event, "status");
                task.last = if summary.is_empty() {
                    status.clone()
                } else {
                    format!("{status}: {summary}")
                };
                task.last_result = Some(FireResult {
                    fire: event.get("fire").and_then(Value::as_u64).unwrap_or(0),
                    status,
                    detail: summary,
                });
                None
            }
            "removed" => {
                let index = self.entries.iter().position(|task| {
                    task.id == id && (session.is_empty() || task.session == session)
                })?;
                let task = self.entries.remove(index);
                let saved = event.get("saved").and_then(Value::as_bool).unwrap_or(false);
                let reason = match (text(event, "reason").as_str(), saved) {
                    ("deleted", _) => "deleted".to_string(),
                    ("expired", _) => "expired after 7 days".to_string(),
                    ("session_closed", true) => {
                        "stopped with its session (saved; it comes back when the session is resumed)"
                            .to_string()
                    }
                    ("session_closed", false) => "ended with its session".to_string(),
                    ("shutdown", true) => {
                        "stopped with the dsh process (saved; it comes back when the session is resumed)"
                            .to_string()
                    }
                    ("shutdown", false) => "ended with the dsh process".to_string(),
                    (other, _) => other.to_string(),
                };
                Some(format!("Loop {reason}: {}", short(&task.prompt, 48)))
            }
            _ => None,
        }
    }

    /// Tasks of one session (the live one), oldest first.
    pub fn active(&self, session: Option<&str>) -> Vec<&Task> {
        self.entries
            .iter()
            .filter(|task| session == Some(task.session.as_str()))
            .collect()
    }

    /// Loops that fire on their own now (not paused).
    pub fn firing(&self, session: Option<&str>) -> usize {
        self.active(session)
            .iter()
            .filter(|task| task.paused.is_empty())
            .count()
    }

    /// The dsh process or its session is gone: every task stopped here.
    /// Returns (saved, not saved); saved ones come back on resume.
    pub fn end_all(&mut self) -> (usize, usize) {
        let saved = self.entries.iter().filter(|task| task.saved).count();
        let count = self.entries.len();
        self.entries.clear();
        (saved, count - saved)
    }
}

/// The hint for loops that stopped with their dsh process or session.
pub fn ended_hint(saved: usize, unsaved: usize, why: &str) -> Option<String> {
    match (saved, unsaved) {
        (0, 0) => None,
        (saved, 0) => Some(format!(
            "{saved} saved loop(s) stopped {why}; they come back when this session is resumed"
        )),
        (0, unsaved) => Some(format!("{unsaved} unsaved loop(s) ended {why}")),
        (saved, unsaved) => Some(format!(
            "{saved} saved loop(s) stopped {why} (they come back when this session is resumed); {unsaved} unsaved loop(s) ended"
        )),
    }
}

/// `/loop` with no arguments (the reference usage message).
pub const LOOP_USAGE: &str = "Usage: /loop [interval] <prompt>\nExample: /loop 30m check deploy status\nExample: /loop check deploy status every hour\n\nTell me how often it should run (e.g. 30m, 1 hour, every 2 days).";

/// The model instruction `/loop` expands into (reference wording). The
/// model, not host parsing, turns the request into the scheduler_create
/// interval, so every natural phrasing works and a missing cadence is asked
/// for rather than invented.
pub fn loop_instruction(args: &str) -> String {
    let fire_context = "Each fire runs in a detached background subagent, not in this conversation,\n\
         so the prompt you store must stand on its own.\n\n\
         ## Writing a prompt that survives a fresh fire\n\
         - Inline the state a fire needs: paths, job/PR/branch ids, the command that checks\n\
           status, and what \"healthy\" looks like. A fire cannot see this conversation, and\n\
           a long-running task restarts from a short summary every few iterations.\n\
         - Only a short status comes back here, so say what that status must contain.";
    format!(
        "# /loop -- schedule a recurring prompt\n\n\
         Turn the input below into a scheduler_create call. {fire_context}\n\
         - Say what one fire does and when it bails: \"if still pending, report one line and\n\
           stop.\" A fire must not poll inline.\n\
         - Give it a stop condition and an exit: \"when <condition> holds, report it and call\n\
           scheduler_delete <task_id>.\" Without that the loop runs until it expires.\n\
         - Keep it short and concrete -- the stored prompt is re-sent on every fire.\n\n\
         ## Deriving the interval\n\
         Convert the user's cadence -- however phrased, at either end of the request -- into a\n\
         compact `<number><unit>` string (`s`/`m`/`h`/`d`); the remaining text is the prompt.\n\
         The minimum is 60 seconds and shorter values are raised, so say so when it applies.\n\
         If no cadence is given, ask the user how often it should run -- never invent one.\n\n\
         ## Action\n\
         Schedule from what the user already gave you \u{2014} do not explore the workspace or run\n\
         checks before scheduling; the first fire does that.\n\
         1. Call scheduler_create with the interval, the prompt, and fire_immediately: true.\n\
            If the interval is rejected, fix the string rather than guessing.\n\
         2. Confirm what's scheduled, the cadence, its stop condition, that it auto-expires\n\
            after 7 days, and the task_id to cancel with scheduler_delete.\n\
         3. Do NOT execute the prompt inline. The scheduler fires it immediately.\n\n\
         ## Wrong tool for the job\n\
         - \"Tell me when X finishes\" -> a background command or watch tool that wakes you on\n\
           the event, not a recurring loop that re-checks on a timer.\n\
         - \"Do X once in N minutes\" -> background `sleep <secs> && <command>`; scheduling is\n\
           recurring-only.\n\n\
         ## Changing an existing loop\n\
         Call scheduler_create with its task_id and only the changed fields; do not\n\
         delete and recreate. If later work changes what a loop should do, update its\n\
         prompt the same way.\n\n\
         ## Input\n\
         {args}"
    )
}

/// Seconds for a compact interval token (`30m`), raised to the 60-second
/// minimum. None for anything else, including zero.
pub fn interval_secs(token: &str) -> Option<u64> {
    let last = token.chars().last()?;
    let (digits, suffix) = token.split_at(token.len() - last.len_utf8());
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value: u64 = digits.parse().ok()?;
    if value == 0 {
        return None;
    }
    let unit = match suffix {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86_400,
        _ => return None,
    };
    value.checked_mul(unit).map(|secs| secs.max(60))
}

/// `every 30 minutes`, `every 1 hour` (reference wording).
pub fn human(secs: u64) -> String {
    let unit = |count: u64, word: &str| {
        if count == 1 {
            format!("every 1 {word}")
        } else {
            format!("every {count} {word}s")
        }
    };
    if secs.is_multiple_of(86_400) {
        unit(secs / 86_400, "day")
    } else if secs.is_multiple_of(3600) {
        unit(secs / 3600, "hour")
    } else if secs.is_multiple_of(60) {
        unit(secs / 60, "minute")
    } else {
        unit(secs, "second")
    }
}

/// The provisional schedule shown while the model schedules a `/loop`: a
/// leading interval token followed by a prompt gives its cadence, anything
/// else "scheduling…". The model's scheduler_create call is what counts.
pub fn loop_preview(args: &str) -> String {
    let mut words = args.split_whitespace();
    match (words.next().and_then(interval_secs), words.next()) {
        (Some(secs), Some(_)) => human(secs),
        _ => "scheduling…".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_line_accepts_only_marked_objects() {
        assert!(parse_line("\u{241e}schedule\u{241e}{\"event\":\"created\"}").is_some());
        assert!(parse_line("\u{241e}schedule\u{241e}[1]").is_none());
        assert!(parse_line("\u{241e}job\u{241e}{\"event\":\"start\"}").is_none());
        assert!(parse_line("plain stderr").is_none());
        assert_eq!(dsh_env(), vec![("CODSH_SCHEDULER".into(), "1".into())]);
    }

    #[test]
    fn follows_a_task_from_creation_to_delete() {
        let mut schedules = Schedules::default();
        let hint = schedules.apply(&json!({"event":"created","id":"t1","session":"s1","prompt":"check the deploy status","human":"every 5 minutes","updated":false,"wakeAtMs":1_000_000}));
        assert_eq!(
            hint.as_deref(),
            Some("Loop scheduled: every 5 minutes · check the deploy status · Ctrl+G or /tasks")
        );
        assert_eq!(schedules.active(Some("s1")).len(), 1);
        assert!(schedules.active(Some("s2")).is_empty());
        assert!(schedules.active(None).is_empty());
        let task = &schedules.entries[0];
        assert_eq!(
            task.row_at(1_000_000 - 250_000),
            "[every 5 minutes] check the deploy status · next in 4m 10s · not saved"
        );
        assert_eq!(
            schedules.apply(
                &json!({"event":"fired","id":"t1","session":"s1","fire":1,"wakeAtMs":1_300_000})
            ),
            None
        );
        assert!(schedules.entries[0].running);
        assert_eq!(
            schedules.entries[0].row_at(1_000_000),
            "[every 5 minutes] check the deploy status · next in 5m 0s · 1 fire · running · not saved"
        );
        schedules.apply(&json!({"event":"skipped","id":"t1","session":"s1","wakeAtMs":1_600_000}));
        assert_eq!(
            schedules.entries[0].last,
            "skipped: the previous iteration is still running"
        );
        schedules.apply(&json!({"event":"result","id":"t1","session":"s1","fire":1,"status":"completed","summary":"all green"}));
        assert!(!schedules.entries[0].running);
        assert_eq!(schedules.entries[0].last, "completed: all green");
        let updated = schedules.apply(&json!({"event":"created","id":"t1","session":"s1","prompt":"check the deploy status","human":"every 1 hour","updated":true}));
        assert!(updated.unwrap().starts_with("Loop updated: every 1 hour"));
        assert_eq!(schedules.entries.len(), 1);
        let failed =
            schedules.apply(&json!({"event":"failed","id":"t1","session":"s1","detail":"limit"}));
        assert!(failed.unwrap().contains("did not start"));
        let removed = schedules
            .apply(&json!({"event":"removed","id":"t1","session":"s1","reason":"deleted"}));
        assert_eq!(
            removed.as_deref(),
            Some("Loop deleted: check the deploy status")
        );
        assert!(schedules.entries.is_empty());
        // A deleted task's in-flight fire still settles; nothing is revived.
        assert_eq!(
            schedules
                .apply(&json!({"event":"result","id":"t1","session":"s1","status":"completed"})),
            None
        );
        assert!(schedules.entries.is_empty());
    }

    #[test]
    fn tasks_are_per_session_and_end_with_the_process() {
        let mut schedules = Schedules::default();
        for (id, session) in [("a", "s1"), ("b", "s1"), ("c", "s2")] {
            schedules.apply(&json!({"event":"created","id":id,"session":session,"prompt":"p","human":"every 1 minute"}));
        }
        assert_eq!(schedules.active(Some("s1")).len(), 2);
        assert_eq!(schedules.active(Some("s2")).len(), 1);
        let expired =
            schedules.apply(&json!({"event":"removed","id":"c","session":"s2","reason":"expired"}));
        assert_eq!(expired.as_deref(), Some("Loop expired after 7 days: p"));
        assert_eq!(schedules.end_all(), (0, 2));
        assert!(schedules.entries.is_empty());
    }

    #[test]
    fn saved_loops_show_restore_pause_outcome_and_permissions() {
        let mut schedules = Schedules::default();
        assert_eq!(
            schedules.apply(&json!({"event":"restore","session":"s1","restored":1,"path":"/h/codsh-schedules/s1.json"})),
            Some("Restored 1 saved loop(s) for this session · Ctrl+G or /tasks".into())
        );
        assert!(schedules.restore_hint_fresh());
        assert_eq!(
            schedules
                .apply(&json!({"event":"restore","session":"s1","restored":0,"path":"/h/x.json"})),
            None
        );
        let damaged = schedules
            .apply(&json!({"event":"restore","session":"s1","restored":0,"error":"bad JSON","path":"/h/x.json"}))
            .unwrap();
        assert!(
            damaged.contains("could not be read (bad JSON)"),
            "{damaged}"
        );
        // A restored loop is covered by the restore hint.
        let created = schedules.apply(&json!({
            "event":"created","id":"t1","session":"s1","prompt":"check deploy","human":"every 5 minutes",
            "updated":false,"fires":3,"durable":true,"saved":true,"saveNote":"","restored":true,"paused":"",
            "permission":{"created":"always-approve","now":"ask"},
            "lastResult":{"fire":3,"status":"unknown","detail":"its dsh process ended while it ran"},
            "wakeAtMs":1_000_000
        }));
        assert_eq!(created, None);
        let task = &schedules.entries[0];
        assert_eq!(
            task.row_at(1_000_000),
            "[every 5 minutes] check deploy · next in 0s · 3 fires · durable · fire 3 outcome unknown · permissions changed"
        );
        let details = task.details();
        assert!(details.contains(&"restored from the saved session".to_string()));
        assert!(
            details.contains(
                &"permissions changed: created under always-approve, fires now run under ask"
                    .to_string()
            )
        );
        assert!(
            details
                .iter()
                .any(|line| line == "last: fire 3: unknown: its dsh process ended while it ran")
        );
        assert_eq!(schedules.firing(Some("s1")), 1);
        let paused = schedules.apply(&json!({"event":"state","id":"t1","session":"s1","saved":true,"saveNote":"","paused":"owner lost","permission":null,"lastResult":null}));
        assert_eq!(
            paused.as_deref(),
            Some("Loop paused (check deploy): owner lost")
        );
        let task = &schedules.entries[0];
        assert_eq!(
            task.row_at(0),
            "[every 5 minutes] check deploy · 3 fires · durable · paused"
        );
        assert_eq!(schedules.firing(Some("s1")), 0);
        schedules.apply(&json!({"event":"created","id":"t2","session":"s1","prompt":"p","human":"every 1 minute","saved":false,"saveNote":"this dsh has no session owner"}));
        assert!(
            schedules.entries[1]
                .details()
                .contains(&"not saved: this dsh has no session owner".to_string())
        );
        assert_eq!(schedules.end_all(), (1, 1));
        assert_eq!(
            ended_hint(1, 1, "with the dsh process").unwrap(),
            "1 saved loop(s) stopped with the dsh process (they come back when this session is resumed); 1 unsaved loop(s) ended"
        );
        assert_eq!(ended_hint(0, 0, "x"), None);
        schedules.apply(&json!({"event":"created","id":"t3","session":"s1","prompt":"p","human":"every 1 minute","saved":true}));
        let stopped = schedules.apply(
            &json!({"event":"removed","id":"t3","session":"s1","reason":"shutdown","saved":true}),
        );
        assert_eq!(
            stopped.as_deref(),
            Some(
                "Loop stopped with the dsh process (saved; it comes back when the session is resumed): p"
            )
        );
    }

    #[test]
    fn loop_command_matches_the_reference() {
        assert!(LOOP_USAGE.starts_with("Usage: /loop [interval] <prompt>\n"));
        let instruction = loop_instruction("30m check deploy");
        assert!(instruction.starts_with("# /loop -- schedule a recurring prompt\n\n"));
        assert!(instruction.contains(
            "1. Call scheduler_create with the interval, the prompt, and fire_immediately: true."
        ));
        assert!(instruction.contains("never invent one"));
        assert!(instruction.contains("3. Do NOT execute the prompt inline."));
        assert!(instruction.ends_with("## Input\n30m check deploy"));
        assert_eq!(loop_preview("30m check deploy"), "every 30 minutes");
        assert_eq!(loop_preview("1h watch"), "every 1 hour");
        assert_eq!(loop_preview("30s tick"), "every 1 minute");
        assert_eq!(loop_preview("90s tick"), "every 90 seconds");
        assert_eq!(loop_preview("0m nothing"), "scheduling…");
        assert_eq!(loop_preview("30m"), "scheduling…");
        assert_eq!(loop_preview("check deploy every hour"), "scheduling…");
        assert_eq!(loop_preview("5x nope"), "scheduling…");
        assert_eq!(loop_preview("é"), "scheduling…");
        assert_eq!(human(172_800), "every 2 days");
    }
}
