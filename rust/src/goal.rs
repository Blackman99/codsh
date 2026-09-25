//! `/goal` (ticket 180): a standing objective dsh keeps working toward.
//!
//! dsh runs the goal. Its own goal driver starts each round, and
//! `packages/cli/bin/rust-acp-goal.mjs` adds what codsh needs on top: the
//! token budget, independent verification of every completion claim, pause
//! causes, and the stop reason. There is no second agent loop here. This
//! module parses the command, resolves the policy the plugin reads
//! (CODSH_GOAL_POLICY), and keeps the goal line of the status area from the
//! plugin's `\u{241e}goal\u{241e}{json}` stderr lines.

use serde_json::{Value, json};
use std::collections::BTreeMap;
use toml::Value as TomlValue;

pub const MARK: &str = "\u{241e}goal\u{241e}";
pub const POLICY_ENV: &str = "CODSH_GOAL_POLICY";
/// The user line of a transcript turn that a goal round opened.
pub const ROUND_PREFIX: &str = "◎ Goal round ";
/// Reference `GROK_GOAL_VERIFIER_N` default and clamp.
pub const DEFAULT_VERIFIERS: u64 = 3;
pub const MAX_VERIFIERS: u64 = 5;
/// Reference `GROK_GOAL_CLASSIFIER_MAX` default: verification attempts
/// before the goal stops.
pub const DEFAULT_MAX_VERIFICATIONS: u64 = 10;
pub const DESCRIPTION: &str = "Set, manage, or check an autonomous goal";

/// One `/goal` invocation, parsed like the reference builtin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Status,
    Pause,
    Resume,
    Clear,
    Set {
        objective: String,
        budget: Option<u64>,
    },
}

impl Command {
    pub fn action(&self) -> &'static str {
        match self {
            Command::Status => "status",
            Command::Pause => "pause",
            Command::Resume => "resume",
            Command::Clear => "clear",
            Command::Set { .. } => "set",
        }
    }
}

/// The text after `/goal`. Keywords match the whole input, case-insensitive;
/// anything else is an objective with an optional trailing budget.
pub fn parse(args: &str) -> Command {
    let trimmed = args.trim();
    match trimmed.to_lowercase().as_str() {
        "" | "status" => Command::Status,
        "pause" => Command::Pause,
        "resume" => Command::Resume,
        "clear" => Command::Clear,
        _ => {
            let (objective, budget) = split_budget(trimmed);
            Command::Set { objective, budget }
        }
    }
}

/// Only a trailing, standalone `--budget <digits>` after a non-empty
/// objective is a budget; any other mention stays part of the objective.
fn split_budget(trimmed: &str) -> (String, Option<u64>) {
    if let Some((head, tail)) = trimmed.rsplit_once("--budget") {
        let value = tail.trim();
        let own_token = head.ends_with(char::is_whitespace)
            && tail.starts_with(char::is_whitespace)
            && !value.contains(char::is_whitespace);
        let head = head.trim_end();
        if own_token
            && !head.is_empty()
            && !value.is_empty()
            && value.bytes().all(|byte| byte.is_ascii_digit())
            && let Ok(budget) = value.parse::<u64>()
            && budget > 0
            && budget <= i64::MAX as u64
        {
            return (head.to_string(), Some(budget));
        }
    }
    (trimmed.to_string(), None)
}

/// A fresh request id for one command.
pub fn next_id() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    format!("goal-{id}")
}

/// The control request for one command.
pub fn message(id: &str, session_id: &str, command: &Command) -> Value {
    let mut value = json!({
        "type": "goal",
        "id": id,
        "sessionId": session_id,
        "action": command.action(),
    });
    if let Command::Set { objective, budget } = command {
        value["objective"] = json!(objective);
        if let Some(budget) = budget {
            value["budget"] = json!(budget);
        }
    }
    value
}

/// Goal mode as dsh should apply it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub enabled: bool,
    pub verifier_count: u64,
    pub max_verifications: u64,
    pub warnings: Vec<String>,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            enabled: true,
            verifier_count: DEFAULT_VERIFIERS,
            max_verifications: DEFAULT_MAX_VERIFICATIONS,
            warnings: Vec::new(),
        }
    }
}

impl Policy {
    pub fn to_json(&self) -> Value {
        json!({
            "enabled": self.enabled,
            "verifierCount": self.verifier_count,
            "maxVerifications": self.max_verifications,
        })
    }
}

fn env_flag(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "on" | "yes" => Some(true),
        "0" | "false" | "off" | "no" => Some(false),
        _ => None,
    }
}

fn whole_number(value: &str) -> Option<u64> {
    let text = value.trim();
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse::<u64>().ok()
}

/// `[goal] enabled` in config, then `GROK_GOAL`, `GROK_GOAL_VERIFIER_N`
/// (clamped 1-5) and `GROK_GOAL_CLASSIFIER_MAX` (at least 1) from the
/// environment. Goal mode is on by default, as in the reference.
pub fn resolve(table: &TomlValue, env: &BTreeMap<String, String>) -> Policy {
    let mut policy = Policy::default();
    if let Some(value) = table
        .get("goal")
        .and_then(|section| section.get("enabled"))
        .and_then(TomlValue::as_bool)
    {
        policy.enabled = value;
    }
    if let Some(raw) = env.get("GROK_GOAL") {
        match env_flag(raw) {
            Some(value) => policy.enabled = value,
            None => policy
                .warnings
                .push(format!("GROK_GOAL={raw} is not 0/1; ignored")),
        }
    }
    if let Some(raw) = env.get("GROK_GOAL_VERIFIER_N") {
        match whole_number(raw) {
            Some(count) => policy.verifier_count = count.clamp(1, MAX_VERIFIERS),
            None => policy.warnings.push(format!(
                "GROK_GOAL_VERIFIER_N={raw} is not a whole number; ignored"
            )),
        }
    }
    if let Some(raw) = env.get("GROK_GOAL_CLASSIFIER_MAX") {
        match whole_number(raw) {
            Some(count) => policy.max_verifications = count.max(1),
            None => policy.warnings.push(format!(
                "GROK_GOAL_CLASSIFIER_MAX={raw} is not a whole number; ignored"
            )),
        }
    }
    policy
}

pub fn dsh_env(policy: &Policy) -> Vec<(String, String)> {
    vec![(POLICY_ENV.to_string(), policy.to_json().to_string())]
}

/// Parse one stderr line. None when it is not a goal line.
pub fn parse_line(text: &str) -> Option<Value> {
    let body = text.strip_prefix(MARK)?;
    serde_json::from_str::<Value>(body)
        .ok()
        .filter(Value::is_object)
}

/// The goal as the plugin last published it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Goal {
    pub objective: String,
    pub phase: String,
    pub armed: bool,
    pub rounds: u64,
    pub max_rounds: Option<u64>,
    pub tokens: u64,
    pub budget: Option<u64>,
    pub attempts: u64,
    pub max_verifications: u64,
    pub verifiers: u64,
    pub verifying: bool,
    /// The last panel: achieved of total, and whether it passed.
    pub verdict: Option<(u64, u64, bool)>,
    /// Why the goal stopped (paused, blocked, complete), in words.
    pub stop: Option<String>,
    pub stop_kind: Option<String>,
    /// The user sent a message while the goal was active.
    pub takeover: bool,
}

/// What an event asks the client to show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Signal {
    /// A goal round began in this session.
    Round { session: String, line: String },
    /// A stop worth a hint (paused, stopped, complete).
    Notice { session: String, text: String },
}

/// The last published goal of each session dsh reported on. A switch may
/// deliver the new session's state before the client moves to it, so
/// nothing is dropped by session here; the status line picks the live one.
#[derive(Clone, Debug, Default)]
pub struct Track {
    goals: BTreeMap<String, Goal>,
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

pub fn round_line(round: u64, max_rounds: Option<u64>) -> String {
    match max_rounds {
        Some(max) if max > 0 => format!("{ROUND_PREFIX}{round}/{max}"),
        _ => format!("{ROUND_PREFIX}{round}"),
    }
}

fn goal_from(value: &Value) -> Option<Goal> {
    let goal = value.get("goal").filter(|goal| goal.is_object())?;
    let stop = value.get("stop").filter(|stop| stop.is_object());
    let verdict = value
        .get("lastVerdict")
        .filter(|verdict| verdict.is_object())
        .map(|verdict| {
            (
                number(verdict, "achieved"),
                number(verdict, "total"),
                verdict.get("passed").and_then(Value::as_bool) == Some(true),
            )
        });
    Some(Goal {
        objective: text(goal, "objective"),
        phase: text(goal, "phase"),
        armed: text(goal, "activation") != "disarmed",
        rounds: number(goal, "rounds"),
        max_rounds: goal.get("maxRounds").and_then(Value::as_u64),
        tokens: number(value, "tokens"),
        budget: value.get("budget").and_then(Value::as_u64),
        attempts: number(value, "attempts"),
        max_verifications: number(value, "maxVerifications"),
        verifiers: number(value, "verifiers"),
        verifying: value.get("verifying").and_then(Value::as_bool) == Some(true),
        verdict,
        stop: stop
            .map(|stop| text(stop, "message"))
            .filter(|message| !message.is_empty()),
        stop_kind: stop
            .map(|stop| text(stop, "kind"))
            .filter(|kind| !kind.is_empty()),
        takeover: value.get("takeover").and_then(Value::as_bool) == Some(true),
    })
}

impl Track {
    /// Take one plugin line.
    pub fn apply(&mut self, event: &Value) -> Option<Signal> {
        let session = text(event, "session");
        match event.get("event").and_then(Value::as_str)? {
            "state" => {
                match goal_from(event) {
                    Some(goal) => self.goals.insert(session, goal),
                    None => self.goals.remove(&session),
                };
                None
            }
            "round" => Some(Signal::Round {
                line: round_line(
                    number(event, "round"),
                    event.get("maxRounds").and_then(Value::as_u64),
                ),
                session,
            }),
            "notice" => Some(Signal::Notice {
                text: text(event, "text"),
                session,
            }),
            _ => None,
        }
    }

    pub fn get(&self, session: Option<&str>) -> Option<&Goal> {
        self.goals.get(session?)
    }

    /// The live session's status line, or empty when it has no goal.
    pub fn status_text(&self, session: Option<&str>) -> String {
        let Some(goal) = self.get(session) else {
            return String::new();
        };
        let mut parts = Vec::new();
        let rounds = match goal.max_rounds {
            Some(max) if max > 0 => format!("round {}/{max}", goal.rounds),
            _ => format!("round {}", goal.rounds),
        };
        let tokens = match goal.budget {
            Some(budget) => format!("{}/{} tokens", compact(goal.tokens), compact(budget)),
            None => format!("{} tokens", compact(goal.tokens)),
        };
        match goal.phase.as_str() {
            "active" => {
                parts.push(if goal.armed {
                    "goal active".to_string()
                } else {
                    "goal active (waiting for /goal resume)".to_string()
                });
                parts.push(rounds);
                parts.push(tokens);
                if goal.verifying {
                    parts.push(format!(
                        "verifying with {} checker{}",
                        goal.verifiers,
                        if goal.verifiers == 1 { "" } else { "s" }
                    ));
                } else if let Some((achieved, total, false)) = goal.verdict {
                    parts.push(format!(
                        "last check {achieved}/{total} · attempt {}/{}",
                        goal.attempts, goal.max_verifications
                    ));
                }
                if goal.takeover {
                    parts.push("your message first".into());
                }
            }
            "paused" => {
                parts.push("goal paused".into());
                parts.push(rounds);
                parts.push(tokens);
                parts.push("/goal resume".into());
            }
            "blocked" => {
                let kind = goal.stop_kind.as_deref().unwrap_or("blocked");
                parts.push(format!("goal stopped ({kind})"));
                parts.push(rounds);
                parts.push(tokens);
                parts.push(if kind == "budget-limited" {
                    "/goal clear".to_string()
                } else {
                    "/goal resume or /goal clear".to_string()
                });
            }
            "complete" => {
                parts.push(match goal.verdict {
                    Some((achieved, total, true)) => {
                        format!("goal complete · verified {achieved}/{total}")
                    }
                    _ => "goal complete".to_string(),
                });
                parts.push(rounds);
                parts.push(tokens);
            }
            other => {
                parts.push(format!("goal {other}"));
                parts.push(rounds);
            }
        }
        let head = format!("◎ {}", parts.join(" · "));
        format!("{head} · {}", clip(&goal.objective, 48))
    }
}

fn compact(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        format!("{:.1}M", tokens as f64 / 1_000_000.0)
    } else if tokens >= 1_000 {
        format!("{:.1}k", tokens as f64 / 1_000.0)
    } else {
        tokens.to_string()
    }
}

fn clip(text: &str, max: usize) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.chars().count() <= max && !text.trim().contains('\n') {
        return line.to_string();
    }
    let kept: String = line.chars().take(max.saturating_sub(1)).collect();
    format!("{kept}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(objective: &str, budget: Option<u64>) -> Command {
        Command::Set {
            objective: objective.into(),
            budget,
        }
    }

    #[test]
    fn keywords_match_the_whole_input_case_insensitively() {
        assert_eq!(parse(""), Command::Status);
        assert_eq!(parse("  STATUS "), Command::Status);
        assert_eq!(parse("Pause"), Command::Pause);
        assert_eq!(parse("resume"), Command::Resume);
        assert_eq!(parse("CLEAR"), Command::Clear);
        assert_eq!(parse("pause the build"), set("pause the build", None));
        assert_eq!(parse("edit"), set("edit", None));
    }

    #[test]
    fn only_a_trailing_standalone_budget_is_consumed() {
        assert_eq!(parse("ship it --budget 5000"), set("ship it", Some(5000)));
        assert_eq!(parse("ship it   --budget   42  "), set("ship it", Some(42)));
        assert_eq!(parse("--budget 5000"), set("--budget 5000", None));
        assert_eq!(parse("ship --budget 0"), set("ship --budget 0", None));
        assert_eq!(parse("ship --budget -3"), set("ship --budget -3", None));
        assert_eq!(parse("ship --budget 5k"), set("ship --budget 5k", None));
        assert_eq!(
            parse("explain --budget 5 flag"),
            set("explain --budget 5 flag", None)
        );
        assert_eq!(parse("ship--budget 5"), set("ship--budget 5", None));
        assert_eq!(
            parse("ship --budget 99999999999999999999"),
            set("ship --budget 99999999999999999999", None)
        );
        assert_eq!(
            parse("a --budget 1 --budget 7"),
            set("a --budget 1", Some(7))
        );
    }

    #[test]
    fn the_control_request_carries_objective_and_budget() {
        let value = message("g1", "s1", &parse("fix tests --budget 900"));
        assert_eq!(value["type"], "goal");
        assert_eq!(value["action"], "set");
        assert_eq!(value["objective"], "fix tests");
        assert_eq!(value["budget"], 900);
        let value = message("g2", "s1", &Command::Pause);
        assert_eq!(value["action"], "pause");
        assert!(value.get("objective").is_none());
    }

    #[test]
    fn policy_defaults_on_and_reads_config_then_env() {
        let empty = TomlValue::Table(Default::default());
        let none = BTreeMap::new();
        let policy = resolve(&empty, &none);
        assert!(policy.enabled);
        assert_eq!(policy.verifier_count, 3);
        assert_eq!(policy.max_verifications, 10);
        let off: TomlValue = toml::from_str("[goal]\nenabled = false\n").unwrap();
        assert!(!resolve(&off, &none).enabled);
        let env = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<BTreeMap<_, _>>()
        };
        assert!(resolve(&off, &env(&[("GROK_GOAL", "1")])).enabled);
        assert!(!resolve(&empty, &env(&[("GROK_GOAL", "off")])).enabled);
        let policy = resolve(
            &empty,
            &env(&[
                ("GROK_GOAL", "maybe"),
                ("GROK_GOAL_VERIFIER_N", "9"),
                ("GROK_GOAL_CLASSIFIER_MAX", "0"),
            ]),
        );
        assert!(policy.enabled);
        assert_eq!(policy.verifier_count, 5);
        assert_eq!(policy.max_verifications, 1);
        assert_eq!(policy.warnings.len(), 1);
        let policy = resolve(&empty, &env(&[("GROK_GOAL_VERIFIER_N", "0")]));
        assert_eq!(policy.verifier_count, 1);
        let policy = resolve(&empty, &env(&[("GROK_GOAL_VERIFIER_N", "two")]));
        assert_eq!(policy.verifier_count, 3);
        assert_eq!(policy.warnings.len(), 1);
        let pairs = dsh_env(&resolve(&off, &none));
        assert_eq!(pairs[0].0, POLICY_ENV);
        let json: Value = serde_json::from_str(&pairs[0].1).unwrap();
        assert_eq!(json["enabled"], false);
        assert_eq!(json["verifierCount"], 3);
        assert_eq!(json["maxVerifications"], 10);
    }

    fn state(extra: Value) -> Value {
        let mut value = json!({
            "event": "state",
            "session": "s1",
            "enabled": true,
            "goal": {
                "id": "g", "revision": 1, "objective": "make tests pass",
                "phase": "active", "activation": "armed", "rounds": 2,
                "maxRounds": 256, "createdAt": 1,
            },
            "tokens": 1500,
            "budget": null,
            "attempts": 0,
            "maxVerifications": 10,
            "verifiers": 3,
            "verifying": false,
            "lastVerdict": null,
            "stop": null,
            "takeover": false,
        });
        if let (Some(target), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            for (key, item) in extra {
                target.insert(key.clone(), item.clone());
            }
        }
        value
    }

    #[test]
    fn state_lines_drive_the_status_text() {
        let mut track = Track::default();
        assert_eq!(track.status_text(Some("s1")), "");
        let line = format!("{MARK}{}", state(json!({})));
        let event = parse_line(&line).unwrap();
        assert_eq!(track.apply(&event), None);
        assert_eq!(
            track.status_text(Some("s1")),
            "◎ goal active · round 2/256 · 1.5k tokens · make tests pass"
        );
        track.apply(&state(json!({"verifying": true, "budget": 20000})));
        assert_eq!(
            track.status_text(Some("s1")),
            "◎ goal active · round 2/256 · 1.5k/20.0k tokens · verifying with 3 checkers · make tests pass"
        );
        track.apply(&state(json!({
            "attempts": 2,
            "lastVerdict": {"passed": false, "achieved": 1, "total": 3},
            "takeover": true,
        })));
        assert!(
            track
                .status_text(Some("s1"))
                .contains("last check 1/3 · attempt 2/10")
        );
        assert!(track.status_text(Some("s1")).contains("your message first"));
        let mut blocked = state(json!({
            "budget": 1000,
            "stop": {"kind": "budget-limited", "message": "Goal stopped: token budget reached."},
        }));
        blocked["goal"]["phase"] = json!("blocked");
        track.apply(&blocked);
        assert!(track.status_text(Some("s1")).starts_with(
            "◎ goal stopped (budget-limited) · round 2/256 · 1.5k/1.0k tokens · /goal clear"
        ));
        let mut done = state(json!({
            "lastVerdict": {"passed": true, "achieved": 3, "total": 3},
            "stop": {"kind": "complete", "message": "Goal complete"},
        }));
        done["goal"]["phase"] = json!("complete");
        track.apply(&done);
        assert!(
            track
                .status_text(Some("s1"))
                .starts_with("◎ goal complete · verified 3/3")
        );
        let mut paused = state(json!({}));
        paused["goal"]["phase"] = json!("paused");
        track.apply(&paused);
        assert!(track.status_text(Some("s1")).contains("goal paused"));
        track.apply(&state(json!({"goal": null})));
        assert_eq!(track.status_text(Some("s1")), "");
    }

    #[test]
    fn other_sessions_are_ignored_and_rounds_become_signals() {
        let mut track = Track::default();
        let mut other = state(json!({}));
        other["session"] = json!("s2");
        assert_eq!(track.apply(&other), None);
        assert_eq!(track.status_text(Some("s1")), "");
        assert!(track.status_text(Some("s2")).starts_with("◎ goal active"));
        assert_eq!(track.status_text(None), "");
        let round = json!({"event": "round", "session": "s1", "round": 3, "maxRounds": 256});
        assert_eq!(
            track.apply(&round),
            Some(Signal::Round {
                session: "s1".into(),
                line: "◎ Goal round 3/256".into()
            })
        );
        let notice = json!({"event": "notice", "session": "s1", "text": "Goal paused."});
        assert_eq!(
            track.apply(&notice),
            Some(Signal::Notice {
                session: "s1".into(),
                text: "Goal paused.".into()
            })
        );
        assert_eq!(parse_line("plain stderr"), None);
        track.apply(&state(json!({})));
        assert!(track.get(Some("s1")).is_some());
    }

    #[test]
    fn long_objectives_are_clipped_to_one_line() {
        assert_eq!(clip("short", 10), "short");
        assert_eq!(clip("abcdefghijkl", 5), "abcd…");
        assert_eq!(clip("first\nsecond", 20), "first…");
    }
}
