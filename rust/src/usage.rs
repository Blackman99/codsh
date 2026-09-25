//! Session usage and cost (ticket 65 / #197).
//!
//! One ledger, folded by `packages/cli/bin/rust-usage.mjs` from the durable
//! dsh session logs (the session and every subagent child it spawned), backs
//! every surface: `/usage` and `/cost`, `/session-info`, the status line, the
//! headless result, and `codsh --rust usage <session-id> [turn]`. The live
//! surfaces ask the control plugin (`usage` request); the CLI reads the logs
//! offline through the session-read helper. Both run the same fold.
//!
//! Cost is never shown as zero and never estimated. dsh reports token usage
//! only (its `TokenUsage` has no cost and its pi-ai adapter never reads price
//! metadata), so the cost is "not available (not reported by the provider)".
//! A ledger that carries a reported cost (`costUsdTicks`, 1e10 ticks = $1)
//! is shown as reported; a partial one is not available, as in the reference.
//! Calls that reported no usage are counted and flag the ledger incomplete.

use serde_json::{Map, Value, json};
use std::path::Path;
use std::process::Command;

pub const TICKS_PER_USD: f64 = 10_000_000_000.0;
pub const EXCLUDED_NOTE: &str = "  Not counted: auxiliary calls outside the session log (session title, compaction summary, /btw, memory).";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Buckets {
    /// Full prompt: uncached input plus cache reads plus cache writes.
    pub input: u64,
    pub uncached_input: u64,
    pub cached_read: u64,
    pub cache_creation: u64,
    pub output: u64,
    pub reasoning: u64,
    pub total: u64,
    pub model_calls: u64,
    pub unreported_calls: u64,
    pub api_duration_ms: u64,
}

impl Buckets {
    fn parse(value: &Value) -> Self {
        let n = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
        Self {
            input: n("inputTokens"),
            uncached_input: n("uncachedInputTokens"),
            cached_read: n("cachedReadTokens"),
            cache_creation: n("cacheCreationTokens"),
            output: n("outputTokens"),
            reasoning: n("reasoningTokens"),
            total: n("totalTokens"),
            model_calls: n("modelCalls"),
            unreported_calls: n("unreportedCalls"),
            api_duration_ms: n("apiDurationMs"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cost {
    /// A provider-reported bill in ticks (1e10 per USD).
    Reported(u64),
    /// Some calls reported a cost and some did not: not a total.
    Partial,
    /// No bill was reported; the reason is shown.
    Unknown(String),
}

impl Cost {
    fn parse(value: &Value) -> Self {
        let partial = value.get("costIsPartial").and_then(Value::as_bool) == Some(true);
        let ticks = value
            .get("costUsdTicks")
            .and_then(Value::as_u64)
            .filter(|ticks| *ticks > 0);
        match (partial, ticks) {
            (true, _) => Cost::Partial,
            (false, Some(ticks)) => Cost::Reported(ticks),
            (false, None) => Cost::Unknown(
                value
                    .get("costReason")
                    .and_then(Value::as_str)
                    .filter(|reason| !reason.is_empty())
                    .unwrap_or("not reported")
                    .to_string(),
            ),
        }
    }

    pub fn usd(&self) -> Option<f64> {
        match self {
            Cost::Reported(ticks) => Some(*ticks as f64 / TICKS_PER_USD),
            _ => None,
        }
    }

    /// The reference `/usage` cost cell.
    pub fn cell(&self) -> String {
        match self {
            Cost::Reported(ticks) => format!("${:.4}", *ticks as f64 / TICKS_PER_USD),
            Cost::Partial => "not available (not reported for some calls)".into(),
            Cost::Unknown(reason) => format!("not available ({reason})"),
        }
    }

    /// The per-model cell: a price when reported, else "cost unknown".
    pub fn short_cell(&self) -> String {
        match self {
            Cost::Reported(ticks) => format!("${:.4}", *ticks as f64 / TICKS_PER_USD),
            Cost::Partial | Cost::Unknown(_) => "cost unknown".into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRow {
    pub route: String,
    pub buckets: Buckets,
    pub cost: Cost,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    pub buckets: Buckets,
    /// Model calls of the session's own main loop (the reference `numTurns`).
    pub num_turns: u64,
    pub cost: Cost,
    pub incomplete: bool,
    pub reasons: Vec<String>,
    pub models: Vec<ModelRow>,
    pub subagent_sessions: u64,
    pub subagent: Buckets,
}

impl Summary {
    pub fn parse(value: &Value) -> Option<Self> {
        if !value.is_object() {
            return None;
        }
        let models = value
            .get("modelUsage")
            .and_then(Value::as_object)
            .map(|rows| {
                rows.iter()
                    .map(|(route, row)| ModelRow {
                        route: route.clone(),
                        buckets: Buckets::parse(row),
                        cost: Cost::parse(row),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let subagents = value.get("subagents").cloned().unwrap_or(Value::Null);
        Some(Self {
            buckets: Buckets::parse(value),
            num_turns: value.get("numTurns").and_then(Value::as_u64).unwrap_or(0),
            cost: Cost::parse(value),
            incomplete: value.get("usageIsIncomplete").and_then(Value::as_bool) == Some(true),
            reasons: value
                .get("incompleteReasons")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            models,
            subagent_sessions: subagents
                .get("sessions")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            subagent: Buckets::parse(&subagents),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ledger {
    pub session_id: String,
    pub session: Summary,
    /// Turns that started during the headless prompt, when asked for.
    pub prompt: Option<Summary>,
}

impl Ledger {
    pub fn parse(value: &Value) -> Option<Self> {
        Some(Self {
            session_id: value
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            session: Summary::parse(value.get("session")?)?,
            prompt: value.get("prompt").and_then(Summary::parse),
        })
    }
}

/// The control request for one ledger. `since_ms` also asks for the slice of
/// turns started at or after that wall-clock time (headless prompts).
pub fn request_message(id: &str, session_id: &str, since_ms: Option<u64>) -> Value {
    let mut message = json!({"type": "usage", "id": id, "sessionId": session_id, "turns": false});
    if let Some(since) = since_ms {
        message["sinceTime"] = json!(since);
    }
    message
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

pub fn group_thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// Compact duration as in the reference: `5.2s`, `32s`, `2m5s`, `1h2m`.
pub fn format_duration_ms(ms: u64) -> String {
    let secs = ms / 1000;
    if secs < 10 {
        return format!("{:.1}s", ms as f64 / 1000.0);
    }
    if secs < 60 {
        return format!("{secs}s");
    }
    let mins = secs / 60;
    if mins < 60 {
        return format!("{mins}m{}s", secs % 60);
    }
    format!("{}h{}m", mins / 60, mins % 60)
}

fn plural(n: u64, one: &str, many: &str) -> String {
    format!("{} {}", group_thousands(n), if n == 1 { one } else { many })
}

/// `/usage` and `/cost`: the reference block, over the whole dsh session log
/// (a resume re-reads the log, so nothing is counted twice).
pub fn block_text(summary: &Summary) -> String {
    // The TUI notice area holds a few rows, so the block stays at most five
    // lines; `codsh usage <id>` prints the full ledger.
    let t = &summary.buckets;
    if t.model_calls == 0 && summary.models.is_empty() {
        return if summary.incomplete {
            format!(
                "Session usage: none recorded, but tracking is incomplete and may under-count.{}",
                reasons_suffix(summary)
            )
        } else {
            "Session usage: no model calls yet in this session.".to_string()
        };
    }
    if t.model_calls > 0 && t.unreported_calls >= t.model_calls {
        // No call reported usage: there is no token count to show, and a
        // zero would read as a free session.
        return [
            format!(
                "{HEADER} Tokens: not reported by the provider ({})",
                plural(t.model_calls, "model call", "model calls")
            ),
            format!("  Cost: {}", summary.cost.cell()),
            format!(
                "  Note: usage is incomplete and may under-count.{}",
                reasons_suffix(summary)
            ),
            EXCLUDED_NOTE.to_string(),
        ]
        .join("\n");
    }
    let cache_writes = if t.cache_creation > 0 {
        format!(", {} cache writes", group_thousands(t.cache_creation))
    } else {
        String::new()
    };
    let mut rows = vec![
        format!(
            "{HEADER} Total tokens: {} · Model calls: {} · API time: {}",
            group_thousands(t.total),
            group_thousands(t.model_calls),
            format_duration_ms(t.api_duration_ms)
        ),
        format!(
            "  Input tokens: {} ({} cached{cache_writes}) · Output tokens: {} ({} reasoning) · Cost: {}",
            group_thousands(t.input),
            group_thousands(t.cached_read),
            group_thousands(t.output),
            group_thousands(t.reasoning),
            summary.cost.cell()
        ),
    ];
    let mut extra = Vec::new();
    if summary.subagent_sessions > 0 {
        extra.push(format!(
            "Subagents: {} · {} · {} tokens",
            plural(summary.subagent_sessions, "session", "sessions"),
            plural(summary.subagent.model_calls, "call", "calls"),
            group_thousands(summary.subagent.total)
        ));
    }
    if summary.models.len() > 1 {
        let routes = summary
            .models
            .iter()
            .map(|row| {
                format!(
                    "{} {} in / {} out ({})",
                    row.route,
                    group_thousands(row.buckets.input),
                    group_thousands(row.buckets.output),
                    row.cost.short_cell()
                )
            })
            .collect::<Vec<_>>()
            .join(" · ");
        extra.push(format!("By model: {routes}"));
    }
    if !extra.is_empty() {
        rows.push(format!("  {}", extra.join(" · ")));
    }
    if summary.incomplete {
        rows.push(format!(
            "  Note: usage is incomplete and may under-count.{}",
            reasons_suffix(summary)
        ));
    }
    rows.push(EXCLUDED_NOTE.to_string());
    rows.join("\n")
}

const HEADER: &str = "Session usage (whole dsh session log, subagents included):";

fn reasons_suffix(summary: &Summary) -> String {
    if summary.reasons.is_empty() {
        String::new()
    } else {
        format!(" ({})", summary.reasons.join("; "))
    }
}

/// Why `/usage` has no ledger to show.
pub fn unavailable_text(reason: &str) -> String {
    if reason.is_empty() {
        "Session usage is unavailable until the session starts.".into()
    } else {
        format!("Session usage is unavailable: {reason}")
    }
}

/// The `/session-info` usage line.
pub fn session_info_line(summary: &Summary) -> String {
    let t = &summary.buckets;
    if t.model_calls > 0 && t.unreported_calls >= t.model_calls {
        return format!(
            "Usage: tokens not reported by the provider · {} · cost {} · incomplete, may under-count",
            plural(t.model_calls, "model call", "model calls"),
            summary.cost.cell()
        );
    }
    let mut line = format!(
        "Usage: {} tokens ({} in / {} out) · {} · cost {}",
        group_thousands(t.total),
        group_thousands(t.input),
        group_thousands(t.output),
        plural(t.model_calls, "model call", "model calls"),
        summary.cost.cell()
    );
    if summary.subagent_sessions > 0 {
        line.push_str(&format!(
            " · subagents {}",
            plural(summary.subagent_sessions, "session", "sessions")
        ));
    }
    if summary.incomplete {
        line.push_str(" · incomplete, may under-count");
    }
    line
}

/// Headless spend fields in the reference `project_result_usage` shape:
/// `usage` (input is uncached), `modelUsage`, `num_turns`, and the flags.
/// A cost appears only when a provider reported it; otherwise `cost_status`
/// says it is unknown. A failed turn is always marked incomplete.
pub fn headless_fields(summary: &Summary, failed: bool) -> Map<String, Value> {
    let mut out = Map::new();
    let t = &summary.buckets;
    let incomplete = summary.incomplete || failed;
    // Incomplete with no reported tokens: only the flag (reference rule).
    if t.model_calls > t.unreported_calls {
        out.insert(
            "usage".into(),
            json!({
                "input_tokens": t.uncached_input,
                "cache_read_input_tokens": t.cached_read,
                "cache_creation_input_tokens": t.cache_creation,
                "output_tokens": t.output,
                "reasoning_tokens": t.reasoning,
                "total_tokens": t.total,
            }),
        );
        let mut models = Map::new();
        for row in &summary.models {
            let mut entry = json!({
                "inputTokens": row.buckets.uncached_input,
                "outputTokens": row.buckets.output,
                "cacheReadInputTokens": row.buckets.cached_read,
                "cacheCreationInputTokens": row.buckets.cache_creation,
                "modelCalls": row.buckets.model_calls,
            });
            if let Some(usd) = row.cost.usd() {
                entry["costUSD"] = json!(usd);
            }
            models.insert(row.route.clone(), entry);
        }
        out.insert("modelUsage".into(), Value::Object(models));
    }
    if t.model_calls > 0 {
        out.insert("num_turns".into(), json!(summary.num_turns));
    }
    match &summary.cost {
        Cost::Reported(ticks) if !incomplete => {
            out.insert(
                "total_cost_usd".into(),
                json!(*ticks as f64 / TICKS_PER_USD),
            );
            out.insert("total_cost_usd_ticks".into(), json!(ticks));
        }
        Cost::Partial => {
            out.insert("cost_is_partial".into(), json!(true));
        }
        _ => {
            out.insert("cost_status".into(), json!("unknown"));
        }
    }
    if incomplete {
        out.insert("usage_is_incomplete".into(), json!(true));
    }
    out
}

/// Status-line context fields from the session ledger.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StatusUsage {
    pub session_input_tokens: u64,
    pub session_output_tokens: u64,
    pub uncached_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub model_calls: u64,
    pub api_duration_ms: u64,
    pub cost_usd: Option<f64>,
    pub incomplete: bool,
    /// At least one call reported tokens; otherwise no token field is shown.
    pub tokens_reported: bool,
}

impl StatusUsage {
    pub fn from_summary(summary: &Summary) -> Self {
        let t = &summary.buckets;
        Self {
            session_input_tokens: t.input,
            session_output_tokens: t.output,
            uncached_input_tokens: t.uncached_input,
            cache_read_input_tokens: t.cached_read,
            cache_creation_input_tokens: t.cache_creation,
            model_calls: t.model_calls,
            api_duration_ms: t.api_duration_ms,
            cost_usd: if summary.incomplete {
                None
            } else {
                summary.cost.usd()
            },
            incomplete: summary.incomplete,
            tokens_reported: t.model_calls > t.unreported_calls,
        }
    }
}

/// `codsh --rust usage <session-id> [turn]`: the persisted ledger as pretty
/// JSON (`{sessionId, updatedAt, session, turns}`, or one turn row).
pub fn run_command(dsh_home: &Path, session_id: &str, turn: Option<u64>) -> Result<String, String> {
    let helper = crate::session_history::helper_path();
    let dsh_bin = std::env::var("DSH_BIN").unwrap_or_default();
    if dsh_bin.is_empty() {
        return Err(
            "cannot read usage: DSH_BIN is not set (run through the codsh launcher)".into(),
        );
    }
    let output = Command::new(std::env::var_os("CODSH_NODE").unwrap_or_else(|| "node".into()))
        .arg(&helper)
        .arg("--usage")
        .arg("--session-id")
        .arg(session_id)
        .env("DSH_HOME", dsh_home)
        .env("DSH_BIN", dsh_bin)
        .output()
        .map_err(|error| format!("cannot read usage: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: Value =
        serde_json::from_str(stdout.lines().last().unwrap_or("")).unwrap_or(Value::Null);
    render_command(
        session_id,
        turn,
        &value,
        &String::from_utf8_lossy(&output.stderr),
    )
}

fn render_command(
    session_id: &str,
    turn: Option<u64>,
    value: &Value,
    stderr: &str,
) -> Result<String, String> {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = value
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| stderr.trim().to_string());
        return Err(if message.is_empty() {
            format!("cannot read usage for session '{session_id}'")
        } else {
            message
        });
    }
    let ledger = value.get("ledger").cloned().unwrap_or(Value::Null);
    let turns = ledger
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if turns.is_empty() {
        return Err(format!("No usage recorded for session '{session_id}'."));
    }
    let body = match turn {
        Some(number) => turns
            .into_iter()
            .find(|row| row.get("turnNumber").and_then(Value::as_u64) == Some(number))
            .ok_or_else(|| format!("Turn {number} not found in session '{session_id}'."))?,
        None => json!({
            "sessionId": ledger.get("sessionId").cloned().unwrap_or(json!(session_id)),
            "updatedAt": ledger.get("updatedAt").cloned().unwrap_or(Value::Null),
            "session": ledger.get("session").cloned().unwrap_or(Value::Null),
            "turns": turns,
        }),
    };
    Ok(serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()))
}

pub fn command_help() -> &'static str {
    "Usage: codsh --rust usage <SESSION_ID> [TURN]\n\nPrint the usage ledger of a dsh session as JSON: input (cached read and\ncache write), output (reasoning), and total tokens, model calls, API time,\nper-model rows, subagent children folded into the parent, and per-turn rows.\nWith TURN, print only that turn. Cost is unknown unless a provider reported\none: dsh reports tokens only, and codsh never estimates a price.\nAuxiliary calls outside the session log (title, compaction summary, /btw,\nmemory) are not counted."
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger(extra: Value) -> Value {
        let mut session = json!({
            "inputTokens": 1340, "uncachedInputTokens": 1000, "cachedReadTokens": 300,
            "cacheCreationTokens": 40, "outputTokens": 200, "reasoningTokens": 50,
            "totalTokens": 1540, "modelCalls": 1, "unreportedCalls": 0, "apiDurationMs": 1200,
            "numTurns": 1, "costUsdTicks": null, "costIsPartial": false, "costStatus": "unknown",
            "costReason": "not reported by the provider", "usageIsIncomplete": false,
            "incompleteReasons": [],
            "modelUsage": {"cli-mock/cli-mock": {"inputTokens": 1340, "uncachedInputTokens": 1000,
                "cachedReadTokens": 300, "cacheCreationTokens": 40, "outputTokens": 200,
                "reasoningTokens": 50, "totalTokens": 1540, "modelCalls": 1, "costUsdTicks": null}},
            "subagents": {"sessions": 0, "modelCalls": 0, "totalTokens": 0},
        });
        for (key, value) in extra.as_object().unwrap() {
            session[key] = value.clone();
        }
        json!({"sessionId": "s1", "session": session})
    }

    fn summary(extra: Value) -> Summary {
        Ledger::parse(&ledger(extra)).unwrap().session
    }

    #[test]
    fn block_matches_reference_rows_and_never_prints_a_zero_cost() {
        let text = block_text(&summary(json!({})));
        assert!(text.starts_with("Session usage (whole dsh session log, subagents included): Total tokens: 1,540 · Model calls: 1 · API time: 1.2s\n"), "{text}");
        assert!(text.contains("  Input tokens: 1,340 (300 cached, 40 cache writes) · Output tokens: 200 (50 reasoning) · Cost: not available (not reported by the provider)\n"), "{text}");
        assert!(text.lines().count() <= 5, "{text}");
        assert!(!text.contains("$0"), "{text}");
        assert!(!text.contains("By model"), "one model has no breakdown");
        assert!(text.ends_with(EXCLUDED_NOTE));
    }

    #[test]
    fn empty_incomplete_partial_and_reported_states() {
        let empty = summary(json!({"modelCalls": 0, "modelUsage": {}}));
        assert_eq!(
            block_text(&empty),
            "Session usage: no model calls yet in this session."
        );
        let missing = summary(
            json!({"modelCalls": 0, "modelUsage": {}, "usageIsIncomplete": true,
            "incompleteReasons": ["subagent c1 is still running"]}),
        );
        assert!(
            block_text(&missing)
                .starts_with("Session usage: none recorded, but tracking is incomplete")
        );
        let partial = summary(json!({"costIsPartial": true, "costUsdTicks": null}));
        assert!(block_text(&partial).contains("not available (not reported for some calls)"));
        assert!(
            headless_fields(&partial, false)
                .get("total_cost_usd")
                .is_none()
        );
        assert_eq!(
            headless_fields(&partial, false)["cost_is_partial"],
            json!(true)
        );
        let reported = summary(json!({"costUsdTicks": 123_400_000u64}));
        assert!(block_text(&reported).contains("$0.0123"));
        assert_eq!(reported.cost.usd(), Some(0.01234));
        // A zero or negative tick count is unreported, never free.
        let zero = summary(json!({"costUsdTicks": 0}));
        assert!(matches!(zero.cost, Cost::Unknown(_)));
        let incomplete = summary(json!({"usageIsIncomplete": true, "unreportedCalls": 1,
            "incompleteReasons": ["1 model call reported no token usage"]}));
        let text = block_text(&incomplete);
        assert!(text.contains("Note: usage is incomplete and may under-count. (1 model call reported no token usage)"), "{text}");
    }

    #[test]
    fn by_model_rows_and_subagents() {
        let two = summary(json!({
            "modelUsage": {
                "cli-mock/cli-mock": {"inputTokens": 1340, "outputTokens": 200, "modelCalls": 1},
                "narrow/narrow": {"inputTokens": 500, "outputTokens": 100, "modelCalls": 1},
            },
            "subagents": {"sessions": 1, "modelCalls": 1, "totalTokens": 600},
        }));
        let text = block_text(&two);
        assert!(text.contains("  Subagents: 1 session · 1 call · 600 tokens · By model: cli-mock/cli-mock 1,340 in / 200 out (cost unknown) · narrow/narrow 500 in / 100 out (cost unknown)\n"), "{text}");
        assert!(text.lines().count() <= 5, "{text}");
        assert!(session_info_line(&two).contains("subagents 1 session"));
    }

    #[test]
    fn headless_projection_uses_uncached_input_and_hides_unknown_cost() {
        let fields = headless_fields(&summary(json!({})), false);
        assert_eq!(fields["usage"]["input_tokens"], json!(1000));
        assert_eq!(fields["usage"]["cache_read_input_tokens"], json!(300));
        assert_eq!(fields["usage"]["cache_creation_input_tokens"], json!(40));
        assert_eq!(fields["usage"]["total_tokens"], json!(1540));
        assert_eq!(
            fields["modelUsage"]["cli-mock/cli-mock"]["inputTokens"],
            json!(1000)
        );
        assert!(
            fields["modelUsage"]["cli-mock/cli-mock"]
                .get("costUSD")
                .is_none()
        );
        assert_eq!(fields["num_turns"], json!(1));
        assert_eq!(fields["cost_status"], json!("unknown"));
        assert!(fields.get("total_cost_usd").is_none());
        assert!(fields.get("usage_is_incomplete").is_none());
        let failed = headless_fields(&summary(json!({})), true);
        assert_eq!(failed["usage_is_incomplete"], json!(true));
        let none = headless_fields(&summary(json!({"modelCalls": 0, "modelUsage": {}})), true);
        assert!(none.get("usage").is_none());
        assert_eq!(none["usage_is_incomplete"], json!(true));
    }

    #[test]
    fn unreported_tokens_are_never_shown_as_zero() {
        let none = summary(
            json!({"inputTokens": 0, "uncachedInputTokens": 0, "cachedReadTokens": 0,
            "cacheCreationTokens": 0, "outputTokens": 0, "reasoningTokens": 0, "totalTokens": 0,
            "modelCalls": 3, "unreportedCalls": 3, "usageIsIncomplete": true,
            "incompleteReasons": ["3 model calls reported no token usage"]}),
        );
        let text = block_text(&none);
        assert!(
            text.contains("Tokens: not reported by the provider (3 model calls)"),
            "{text}"
        );
        assert!(!text.contains("Input tokens"), "{text}");
        assert!(
            session_info_line(&none)
                .starts_with("Usage: tokens not reported by the provider · 3 model calls")
        );
        let fields = headless_fields(&none, false);
        assert!(fields.get("usage").is_none() && fields.get("modelUsage").is_none());
        assert_eq!(fields["usage_is_incomplete"], json!(true));
        assert_eq!(fields["num_turns"], json!(1));
    }

    #[test]
    fn status_usage_and_session_info() {
        let s = summary(json!({}));
        let status = StatusUsage::from_summary(&s);
        assert_eq!(status.session_input_tokens, 1340);
        assert_eq!(status.uncached_input_tokens, 1000);
        assert_eq!(status.cost_usd, None);
        assert_eq!(
            session_info_line(&s),
            "Usage: 1,540 tokens (1,340 in / 200 out) · 1 model call · cost not available (not reported by the provider)"
        );
    }

    #[test]
    fn command_rendering_and_errors() {
        let ok = json!({"ok": true, "ledger": {"sessionId": "s1", "updatedAt": "t",
            "session": {"modelCalls": 1}, "turns": [{"turnNumber": 1}, {"turnNumber": 2}]}});
        let all: Value =
            serde_json::from_str(&render_command("s1", None, &ok, "").unwrap()).unwrap();
        assert_eq!(all["turns"].as_array().unwrap().len(), 2);
        assert_eq!(all["sessionId"], json!("s1"));
        let one: Value =
            serde_json::from_str(&render_command("s1", Some(2), &ok, "").unwrap()).unwrap();
        assert_eq!(one["turnNumber"], json!(2));
        assert_eq!(
            render_command("s1", Some(9), &ok, "").unwrap_err(),
            "Turn 9 not found in session 's1'."
        );
        let empty = json!({"ok": true, "ledger": {"sessionId": "s1", "session": {}, "turns": []}});
        assert_eq!(
            render_command("s1", None, &empty, "").unwrap_err(),
            "No usage recorded for session 's1'."
        );
        let missing = json!({"ok": false, "error": "Session 'nope' not found."});
        assert_eq!(
            render_command("nope", None, &missing, "").unwrap_err(),
            "Session 'nope' not found."
        );
    }

    #[test]
    fn formats() {
        assert_eq!(group_thousands(1234567), "1,234,567");
        assert_eq!(format_duration_ms(1200), "1.2s");
        assert_eq!(format_duration_ms(32_000), "32s");
        assert_eq!(format_duration_ms(125_000), "2m5s");
        let request = request_message("u1", "s1", Some(5));
        assert_eq!(request["sinceTime"], json!(5));
        assert_eq!(request["turns"], json!(false));
    }
}
