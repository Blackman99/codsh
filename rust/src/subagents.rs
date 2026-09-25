//! Typed dsh subagents (ticket 172): policy resolution, the task board, the
//! control channel, and the tasks / child-view modal.
//!
//! dsh runs every child. `packages/cli/bin/rust-acp-subagents.mjs` registers
//! the `subagent` tool, starts children through `ctx.subagents`, and reports
//! lifecycle lines on stderr as `\u{241e}subagent\u{241e}{json}`. This module
//! resolves the policy the plugin reads (CODSH_SUBAGENT_POLICY), keeps one
//! board per process from those lines, and asks the plugin to cancel a child
//! by dropping a command file into a private control directory
//! (CODSH_SUBAGENT_CONTROL).

use crate::assets::AgentAsset;
use crate::theme::Theme;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, Clear, Paragraph, Wrap};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use toml::Value as TomlValue;

pub const MARK: &str = "\u{241e}subagent\u{241e}";
pub const DEFAULT_MAX_CONCURRENT: u64 = 32;
pub const DEFAULT_MAX_DEPTH: u64 = 1;
pub const CAPABILITIES: &[&str] = &["read-only", "read-write", "execute", "all"];

/// Process flags that shape the policy.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CliSubagents {
    /// `--no-subagents`.
    pub disabled: bool,
    /// Types named by `--disallowed-tools Agent(type, ...)`.
    pub denied_types: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubagentType {
    pub name: String,
    pub description: String,
    pub capability: String,
    pub model: Option<String>,
    pub instructions: Option<String>,
    pub tools: Option<Vec<String>>,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub enabled: bool,
    /// Why spawning is off, for inspect and the refusal.
    pub disabled_by: Option<String>,
    pub max_concurrent: u64,
    pub limit_behavior: String,
    pub max_depth: u64,
    pub types: Vec<SubagentType>,
    /// A fatal policy error. The plugin refuses every spawn with it.
    pub error: Option<String>,
    pub warnings: Vec<String>,
}

fn builtin(
    name: &str,
    description: &str,
    capability: &str,
    instructions: Option<&str>,
) -> SubagentType {
    SubagentType {
        name: name.into(),
        description: description.into(),
        capability: capability.into(),
        model: None,
        instructions: instructions.map(str::to_string),
        tools: None,
        source: "built-in".into(),
    }
}

pub fn builtin_types() -> Vec<SubagentType> {
    vec![
        builtin(
            "general-purpose",
            "General-purpose agent for multi-step research and implementation. Has every tool the parent has.",
            "all",
            None,
        ),
        builtin(
            "explore",
            "Fast read-only exploration: reads, searches, and runs shell commands. Cannot edit or write files.",
            "execute",
            Some(
                "You are an exploration subagent. Investigate and report findings. Do not modify files.",
            ),
        ),
        builtin(
            "plan",
            "Planning agent: reads, searches, and runs shell commands, then returns a step-by-step plan. Cannot edit or write files.",
            "execute",
            Some(
                "You are a planning subagent. Investigate the code, then return a concrete step-by-step implementation plan. Do not modify files.",
            ),
        ),
    ]
}

fn env_flag(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "on" | "yes" => Some(true),
        "0" | "false" | "off" | "no" => Some(false),
        _ => None,
    }
}

/// A positive whole number in plain digits, or None.
fn positive_digits(value: &str) -> Option<u64> {
    let text = value.trim();
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse::<u64>().ok().filter(|parsed| *parsed > 0)
}

/// Agent-file tool names (`Read, Grep, Bash`) are kept as written; the
/// plugin maps public names onto dsh tools.
fn agent_tools(raw: &str) -> Option<Vec<String>> {
    let names: Vec<String> = raw
        .trim_matches(|ch| ch == '[' || ch == ']')
        .split(',')
        .map(|name| {
            name.trim()
                .trim_matches(|ch| ch == '"' || ch == '\'')
                .to_string()
        })
        .filter(|name| !name.is_empty())
        .collect();
    (!names.is_empty()).then_some(names)
}

/// Resolve the policy. Precedence for each knob: environment, then
/// `[subagents]` in the merged config, then the reference default.
/// `--no-subagents` always wins for `enabled`.
pub fn resolve(
    table: &TomlValue,
    env: &BTreeMap<String, String>,
    cli: &CliSubagents,
    agents: &[AgentAsset],
    grok_home: &Path,
) -> Policy {
    let section = table.get("subagents");
    let mut warnings = Vec::new();
    let mut disabled_by = None;
    let mut enabled = true;
    if let Some(value) = section
        .and_then(|value| value.get("enabled"))
        .and_then(TomlValue::as_bool)
    {
        enabled = value;
        if !value {
            disabled_by = Some("[subagents] enabled = false".to_string());
        }
    }
    if let Some(raw) = env.get("GROK_SUBAGENTS") {
        match env_flag(raw) {
            Some(value) => {
                enabled = value;
                disabled_by = (!value).then(|| "GROK_SUBAGENTS".to_string());
            }
            None => warnings.push(format!("GROK_SUBAGENTS={raw} is not 0/1; ignored")),
        }
    }
    if cli.disabled {
        enabled = false;
        disabled_by = Some("--no-subagents".into());
    }
    let config_int = |key: &str| {
        section
            .and_then(|value| value.get(key))
            .and_then(TomlValue::as_integer)
    };
    let mut max_concurrent = config_int("max_concurrent")
        .map(|value| value.max(1) as u64)
        .unwrap_or(DEFAULT_MAX_CONCURRENT);
    if let Some(raw) = env.get("GROK_MAX_CONCURRENT_SUBAGENTS") {
        match positive_digits(raw) {
            Some(value) => max_concurrent = value,
            None => warnings.push(format!(
                "GROK_MAX_CONCURRENT_SUBAGENTS={raw} is not a positive whole number; ignored"
            )),
        }
    }
    let mut limit_behavior = section
        .and_then(|value| value.get("limit_behavior"))
        .and_then(TomlValue::as_str)
        .map(str::to_ascii_lowercase)
        .filter(|value| value == "queue" || value == "fail")
        .unwrap_or_else(|| "queue".into());
    if let Some(raw) = env.get("GROK_SUBAGENT_LIMIT_BEHAVIOR") {
        let value = raw.trim().to_ascii_lowercase();
        if value == "queue" || value == "fail" {
            limit_behavior = value;
        } else {
            warnings.push(format!(
                "GROK_SUBAGENT_LIMIT_BEHAVIOR={raw} is not queue or fail; keeping {limit_behavior}"
            ));
        }
    }
    let mut max_depth = config_int("max_depth")
        .map(|value| value.max(1) as u64)
        .unwrap_or(DEFAULT_MAX_DEPTH);
    if let Some(raw) = env.get("GROK_SUBAGENTS_MAX_DEPTH") {
        match raw.trim().parse::<i64>() {
            Ok(value) => max_depth = value.max(1) as u64,
            Err(_) => warnings.push(format!(
                "GROK_SUBAGENTS_MAX_DEPTH={raw} is not an integer; ignored"
            )),
        }
    }

    let mut types = builtin_types();
    let upsert = |types: &mut Vec<SubagentType>, entry: SubagentType| {
        if let Some(slot) = types.iter_mut().find(|item| item.name == entry.name) {
            *slot = entry;
        } else {
            types.push(entry);
        }
    };
    if let Some(roles) = section
        .and_then(|value| value.get("roles"))
        .and_then(TomlValue::as_table)
    {
        for (name, role) in roles {
            let description = role
                .get("description")
                .and_then(TomlValue::as_str)
                .unwrap_or("");
            if description.is_empty() {
                warnings.push(format!(
                    "[subagents.roles.{name}] needs a description; skipped"
                ));
                continue;
            }
            let capability = role
                .get("default_capability_mode")
                .and_then(TomlValue::as_str)
                .unwrap_or("all");
            if !CAPABILITIES.contains(&capability) {
                warnings.push(format!(
                    "[subagents.roles.{name}] default_capability_mode \"{capability}\" must be one of {}; skipped",
                    CAPABILITIES.join(", ")
                ));
                continue;
            }
            let mut instructions = None;
            if let Some(file) = role.get("prompt_file").and_then(TomlValue::as_str) {
                let path = PathBuf::from(file);
                let path = if path.is_absolute() {
                    path
                } else {
                    grok_home.join(path)
                };
                match std::fs::read_to_string(&path) {
                    Ok(text) if !text.trim().is_empty() => {
                        instructions = Some(text.trim().to_string())
                    }
                    Ok(_) => warnings.push(format!(
                        "[subagents.roles.{name}] prompt_file {} is empty",
                        path.display()
                    )),
                    Err(error) => warnings.push(format!(
                        "[subagents.roles.{name}] prompt_file {} cannot be read: {error}; skipped",
                        path.display()
                    )),
                }
                if instructions.is_none() {
                    continue;
                }
            }
            upsert(
                &mut types,
                SubagentType {
                    name: name.clone(),
                    description: description.into(),
                    capability: capability.into(),
                    model: role
                        .get("model")
                        .and_then(TomlValue::as_str)
                        .map(str::to_string),
                    instructions,
                    tools: None,
                    source: "config".into(),
                },
            );
        }
    }
    for agent in agents {
        let model = agent
            .model
            .clone()
            .filter(|model| !model.trim().is_empty() && !model.eq_ignore_ascii_case("inherit"));
        upsert(
            &mut types,
            SubagentType {
                name: agent.name.clone(),
                description: agent.description.clone(),
                capability: "all".into(),
                model,
                instructions: Some(agent.body.trim().to_string()).filter(|body| !body.is_empty()),
                tools: agent_tools(&agent.tools),
                source: agent.source.clone(),
            },
        );
    }
    if let Some(models) = section
        .and_then(|value| value.get("models"))
        .and_then(TomlValue::as_table)
    {
        for (name, model) in models {
            match (
                types.iter_mut().find(|item| &item.name == name),
                model.as_str(),
            ) {
                (Some(entry), Some(model)) if !model.trim().is_empty() => {
                    entry.model = Some(model.into())
                }
                (None, _) => warnings.push(format!("[subagents.models] names unknown type {name}")),
                _ => warnings.push(format!(
                    "[subagents.models] {name} must be a model id string"
                )),
            }
        }
    }
    if let Some(toggle) = section
        .and_then(|value| value.get("toggle"))
        .and_then(TomlValue::as_table)
    {
        for (name, on) in toggle {
            if on.as_bool() == Some(false) {
                types.retain(|item| &item.name != name);
            }
        }
    }
    let mut error = None;
    for denied in &cli.denied_types {
        let before = types.len();
        types.retain(|item| !item.name.eq_ignore_ascii_case(denied));
        if types.len() == before {
            error = Some(format!(
                "--disallowed-tools names unknown subagent type Agent({denied}); known types: {}",
                builtin_types()
                    .iter()
                    .map(|item| item.name.clone())
                    .chain(agents.iter().map(|agent| agent.name.clone()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    Policy {
        enabled,
        disabled_by,
        max_concurrent,
        limit_behavior,
        max_depth,
        types,
        error,
        warnings,
    }
}

impl Policy {
    pub fn to_json(&self) -> Value {
        json!({
            "enabled": self.enabled,
            "maxConcurrent": self.max_concurrent,
            "limitBehavior": self.limit_behavior,
            "maxDepth": self.max_depth,
            "error": self.error,
            "types": self.types.iter().map(|item| json!({
                "name": item.name,
                "description": item.description,
                "capability": item.capability,
                "model": item.model,
                "instructions": item.instructions,
                "tools": item.tools,
                "source": item.source,
            })).collect::<Vec<_>>(),
        })
    }

    /// `inspect` rows: key, value, source-free summary.
    pub fn inspect_lines(&self) -> Vec<String> {
        let mut lines = vec![format!(
            "Subagents: {} · max_concurrent {} ({}) · max_depth {} · types {}",
            if self.enabled {
                "on".to_string()
            } else {
                format!(
                    "off ({})",
                    self.disabled_by.as_deref().unwrap_or("disabled")
                )
            },
            self.max_concurrent,
            self.limit_behavior,
            self.max_depth,
            self.types
                .iter()
                .map(|item| format!("{}[{}]", item.name, item.capability))
                .collect::<Vec<_>>()
                .join(", ")
        )];
        if let Some(error) = &self.error {
            lines.push(format!("Subagents refused: {error}"));
        }
        lines.extend(
            self.warnings
                .iter()
                .map(|warning| format!("Subagents warning: {warning}")),
        );
        lines
    }
}

/// The private per-process directory the plugin polls for commands.
pub fn control_dir(dsh_home: &Path) -> PathBuf {
    dsh_home
        .join("run")
        .join(format!("subagent-control-{}", std::process::id()))
}

/// Environment for the dsh child: the policy JSON and the control directory.
pub fn dsh_env(policy: &Policy, dsh_home: &Path) -> Vec<(String, String)> {
    let mut env = vec![(
        "CODSH_SUBAGENT_POLICY".to_string(),
        policy.to_json().to_string(),
    )];
    let dir = control_dir(dsh_home);
    if ensure_private_dir(&dir).is_ok() {
        env.push((
            "CODSH_SUBAGENT_CONTROL".into(),
            dir.to_string_lossy().into_owned(),
        ));
    }
    env
}

fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Ask the plugin to cancel one child. The file is written beside its final
/// name and renamed, so the plugin never reads half a command.
pub fn request_cancel(dsh_home: &Path, id: &str) -> io::Result<()> {
    let dir = control_dir(dsh_home);
    ensure_private_dir(&dir)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let final_path = dir.join(format!("{stamp}.json"));
    let temp = dir.join(format!("{stamp}.tmp"));
    std::fs::write(&temp, json!({"action": "cancel", "id": id}).to_string())?;
    std::fs::rename(&temp, &final_path)
}

/// Remove this process's control directory on exit.
pub fn cleanup(dsh_home: &Path) {
    let _ = std::fs::remove_dir_all(control_dir(dsh_home));
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Queued => "queued",
            Status::Running => "running",
            Status::Completed => "completed",
            Status::Failed => "failed",
            Status::Cancelled => "cancelled",
        }
    }

    pub fn live(self) -> bool {
        matches!(self, Status::Queued | Status::Running)
    }
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub id: String,
    pub type_name: String,
    pub label: String,
    pub model: String,
    pub background: bool,
    pub child: Option<String>,
    pub job: Option<String>,
    pub status: Status,
    pub activity: String,
    pub detail: String,
    pub started: Instant,
    pub elapsed: Option<Duration>,
    /// `isolation: "worktree"` (ticket 174): the child's worktree while it
    /// runs and, after it ends, only when the worktree was kept.
    pub worktree: Option<String>,
    /// After the end: whether the worktree was kept (it holds changes).
    pub worktree_kept: Option<bool>,
}

impl Entry {
    fn short_model(&self) -> &str {
        self.model.rsplit('/').next().unwrap_or(&self.model)
    }

    pub fn elapsed(&self) -> Duration {
        self.elapsed.unwrap_or_else(|| self.started.elapsed())
    }

    /// The parent-scrollback line for this child's tool block.
    pub fn block_title(&self) -> String {
        let tag = format!("({} · {})", self.type_name, self.short_model());
        match self.status {
            Status::Queued => format!(
                "Subagent queued: \"{}\" {tag} · waiting for a slot",
                self.label
            ),
            Status::Running if self.background => {
                format!(
                    "Subagent started: \"{}\" {tag}{}",
                    self.label,
                    activity(&self.activity)
                )
            }
            Status::Running => format!(
                "Subagent running: \"{}\" {tag}{}",
                self.label,
                activity(&self.activity)
            ),
            status => format!(
                "Subagent {} in {}: \"{}\" {tag}{}",
                status.as_str(),
                seconds(self.elapsed()),
                self.label,
                self.worktree_note()
            ),
        }
    }

    /// ` · worktree kept: <path>` for an isolated child that changed files,
    /// ` · worktree removed (no changes)` for one that did not.
    pub fn worktree_note(&self) -> String {
        match (self.worktree_kept, &self.worktree) {
            (Some(true), Some(path)) => format!(" · worktree kept: {path}"),
            (Some(false), _) => " · worktree removed (no changes)".into(),
            (None, Some(path)) => format!(" · worktree {path}"),
            _ => String::new(),
        }
    }
}

fn activity(text: &str) -> String {
    if text.is_empty() {
        String::new()
    } else {
        format!(" · {text}")
    }
}

fn seconds(elapsed: Duration) -> String {
    let secs = elapsed.as_secs_f64();
    if secs < 10.0 {
        format!("{secs:.1}s")
    } else {
        format!("{}s", elapsed.as_secs())
    }
}

/// One process-wide board of children, fed by the plugin's lifecycle lines.
#[derive(Clone, Debug, Default)]
pub struct Board {
    pub entries: Vec<Entry>,
    pub hide_completed: bool,
}

/// A line the client shows once, e.g. a background child finishing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice(pub String);

/// Parse one stderr line. None when it is not a lifecycle line.
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

impl Board {
    pub fn get(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.id == id)
    }

    fn upsert(&mut self, event: &Value) -> Option<&mut Entry> {
        let id = text(event, "id");
        if id.is_empty() {
            return None;
        }
        if let Some(index) = self.entries.iter().position(|entry| entry.id == id) {
            return self.entries.get_mut(index);
        }
        self.entries.push(Entry {
            id,
            type_name: text(event, "type"),
            label: text(event, "label"),
            model: text(event, "model"),
            background: event
                .get("background")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            child: None,
            job: None,
            status: Status::Queued,
            activity: String::new(),
            detail: String::new(),
            started: Instant::now(),
            elapsed: None,
            worktree: None,
            worktree_kept: None,
        });
        self.entries.last_mut()
    }

    /// Apply one lifecycle event. An end is applied once; a repeated end for
    /// a settled child is ignored, so a result is never delivered twice.
    pub fn apply(&mut self, event: &Value) -> Option<Notice> {
        let kind = text(event, "event");
        match kind.as_str() {
            "queued" => {
                let entry = self.upsert(event)?;
                entry.status = Status::Queued;
                None
            }
            "start" => {
                let entry = self.upsert(event)?;
                if entry.status.live() {
                    entry.status = Status::Running;
                    entry.started = Instant::now();
                    let child = text(event, "child");
                    entry.child = (!child.is_empty()).then_some(child);
                    let worktree = text(event, "worktree");
                    entry.worktree = (!worktree.is_empty()).then_some(worktree);
                }
                None
            }
            "job" => {
                let entry = self.upsert(event)?;
                let job = text(event, "job");
                entry.job = (!job.is_empty()).then_some(job);
                None
            }
            "activity" => {
                let id = text(event, "id");
                let entry = self.entries.iter_mut().find(|entry| entry.id == id)?;
                if entry.status == Status::Running {
                    entry.activity = text(event, "tool");
                }
                None
            }
            "end" => {
                let entry = self.upsert(event)?;
                if !entry.status.live() {
                    return None;
                }
                entry.status = match text(event, "status").as_str() {
                    "completed" => Status::Completed,
                    "cancelled" => Status::Cancelled,
                    _ => Status::Failed,
                };
                entry.detail = text(event, "detail");
                entry.activity.clear();
                entry.elapsed = event
                    .get("elapsedMs")
                    .and_then(Value::as_u64)
                    .map(Duration::from_millis)
                    .or_else(|| Some(entry.started.elapsed()));
                let child = text(event, "child");
                if !child.is_empty() {
                    entry.child = Some(child);
                }
                if let Some(kept) = event.get("worktreeKept").and_then(Value::as_bool) {
                    entry.worktree_kept = Some(kept);
                    if !kept {
                        entry.worktree = None;
                    }
                }
                entry.background.then(|| Notice(entry.block_title()))
            }
            "refused" => {
                let detail = text(event, "detail");
                let id = text(event, "id");
                let label = text(event, "label");
                Some(Notice(if label.is_empty() {
                    format!("subagent {id}: {detail}")
                } else {
                    format!("Subagent refused: \"{label}\" · {detail}")
                }))
            }
            _ => None,
        }
    }

    pub fn running(&self) -> usize {
        self.entries
            .iter()
            .filter(|entry| entry.status.live())
            .count()
    }

    /// `◎ 1 subagent still running`, or empty.
    pub fn status_text(&self) -> String {
        match self.running() {
            0 => String::new(),
            1 => "◎ 1 subagent still running · Ctrl+G or /tasks".into(),
            count => format!("◎ {count} subagents still running · Ctrl+G or /tasks"),
        }
    }

    /// Entries the tasks pane lists, newest last.
    pub fn visible(&self) -> Vec<&Entry> {
        self.entries
            .iter()
            .filter(|entry| !self.hide_completed || entry.status.live())
            .collect()
    }
}

/// Read-only transcript of one child.
#[derive(Clone, Debug, Default)]
pub struct ChildView {
    pub id: String,
    pub child: String,
    pub lines: Vec<String>,
    pub offset: usize,
    pub error: String,
    /// The answer to the last key (a cancel request); a reload keeps it.
    pub notice: String,
    pub loaded: Option<Instant>,
    /// The transcript was read after the child settled; it no longer changes.
    pub settled: bool,
}

#[derive(Clone, Debug, Default)]
pub struct TasksModal {
    pub cursor: usize,
    pub view: Option<ChildView>,
    pub notice: String,
}

impl TasksModal {
    pub fn selected<'a>(&self, board: &'a Board) -> Option<&'a Entry> {
        board.visible().get(self.cursor).copied()
    }

    pub fn clamp(&mut self, board: &Board) {
        let count = board.visible().len();
        if count == 0 {
            self.cursor = 0;
        } else if self.cursor >= count {
            self.cursor = count - 1;
        }
    }
}

/// Lines of the tasks list, for the modal and for tests.
pub fn list_lines(board: &Board, modal: &TasksModal) -> Vec<String> {
    let visible = board.visible();
    let mut lines = vec![format!(
        "Subagents ({} running, {} total{})",
        board.running(),
        board.entries.len(),
        if board.hide_completed {
            ", completed hidden"
        } else {
            ""
        }
    )];
    if visible.is_empty() {
        lines.push(if board.entries.is_empty() {
            "No subagents in this session yet.".into()
        } else {
            "No running subagents. h shows completed ones.".into()
        });
    }
    for (index, entry) in visible.iter().enumerate() {
        let mark = if index == modal.cursor { ">" } else { " " };
        lines.push(format!(
            "{mark} [{}] {} · {} · {}{}{}",
            entry.status.as_str(),
            entry.label,
            entry.type_name,
            seconds(entry.elapsed()),
            if entry.background {
                " · background"
            } else {
                ""
            },
            activity(&entry.activity)
        ));
        let note = entry.worktree_note();
        if !note.is_empty() {
            lines.push(format!("   {}", note.trim_start_matches(" · ")));
        }
        if index == modal.cursor && !entry.detail.is_empty() {
            lines.push(format!("    {}", entry.detail.lines().next().unwrap_or("")));
        }
    }
    lines.push(String::new());
    lines.push(
        "↑/↓ select · Enter/Ctrl+F inspect · x cancel · h hide completed · Esc/q close".into(),
    );
    if !modal.notice.is_empty() {
        lines.push(modal.notice.clone());
    }
    lines
}

/// Header and footer of the child view.
pub fn child_lines(board: &Board, view: &ChildView) -> (String, String) {
    let entry = board.get(&view.id);
    let header = entry.map_or_else(
        || format!("Subagent {}", view.child),
        |entry| {
            format!(
                "Subagent \"{}\" ({} · {}) · {} · {}",
                entry.label,
                entry.type_name,
                entry.short_model(),
                entry.status.as_str(),
                seconds(entry.elapsed())
            )
        },
    );
    let live = entry.is_some_and(|entry| entry.status.live());
    let footer = format!(
        "read-only{} · ↑/↓ PgUp/PgDn scroll · Esc/q close · Ctrl+Q quit{}",
        if live {
            " · Ctrl+C cancels this subagent only"
        } else {
            ""
        },
        [view.notice.as_str(), view.error.as_str()]
            .iter()
            .filter(|text| !text.is_empty())
            .map(|text| format!(" · {text}"))
            .collect::<String>()
    );
    (header, footer)
}

fn modal_area(frame: &Frame) -> Rect {
    let area = frame.area();
    if area.width < 24 || area.height < 8 {
        return area;
    }
    let width = area.width.saturating_sub(4).max(24);
    let height = area.height.saturating_sub(2).max(8);
    Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + 1,
        width,
        height,
    }
}

/// Paint the tasks list or the child view as a framed modal. The composer is
/// covered, so a child view has no input of its own.
pub fn render_modal(frame: &mut Frame, board: &Board, modal: &mut TasksModal, theme: &Theme) {
    let area = modal_area(frame);
    frame.render_widget(Clear, area);
    let style = Style::default().fg(theme.text_primary).bg(theme.bg_base);
    match modal.view.as_mut() {
        None => {
            let block = Block::bordered().title(" Tasks ").style(style);
            let inner = block.inner(area);
            frame.render_widget(block, area);
            let lines: Vec<Line> = list_lines(board, modal)
                .into_iter()
                .enumerate()
                .map(|(index, text)| {
                    if text.starts_with('>') {
                        Line::styled(
                            text,
                            Style::default()
                                .bg(theme.bg_highlight)
                                .add_modifier(Modifier::BOLD),
                        )
                    } else if index == 0 {
                        Line::styled(text, Style::default().fg(theme.accent))
                    } else {
                        Line::from(text)
                    }
                })
                .collect();
            frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
        }
        Some(view) => {
            let (header, footer) = child_lines(board, view);
            let block = Block::bordered()
                .title(format!(" {header} "))
                .title_bottom(format!(" {footer} "))
                .style(style);
            let inner = block.inner(area);
            frame.render_widget(block, area);
            let rows = inner.height.max(1) as usize;
            let max_offset = view.lines.len().saturating_sub(rows);
            if view.offset > max_offset {
                view.offset = max_offset;
            }
            let body: Vec<Line> = if view.lines.is_empty() {
                vec![Line::from(if view.error.is_empty() {
                    "Waiting for the subagent transcript…"
                } else {
                    view.error.as_str()
                })]
            } else {
                view.lines
                    .iter()
                    .skip(view.offset)
                    .take(rows)
                    .map(|line| Line::from(line.clone()))
                    .collect()
            };
            frame.render_widget(Paragraph::new(body), inner);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn table(text: &str) -> TomlValue {
        toml::from_str(text).unwrap()
    }

    fn agent(name: &str, tools: &str, model: Option<&str>) -> AgentAsset {
        AgentAsset {
            name: name.into(),
            description: format!("{name} agent"),
            source: "project".into(),
            path: PathBuf::from(format!("/p/.grok/agents/{name}.md")),
            body: format!("Be a {name}."),
            model: model.map(str::to_string),
            tools: tools.into(),
        }
    }

    #[test]
    fn defaults_match_the_reference() {
        let policy = resolve(
            &table(""),
            &env(&[]),
            &CliSubagents::default(),
            &[],
            Path::new("/g"),
        );
        assert!(policy.enabled);
        assert_eq!(policy.max_concurrent, 32);
        assert_eq!(policy.limit_behavior, "queue");
        assert_eq!(policy.max_depth, 1);
        let names: Vec<_> = policy.types.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, ["general-purpose", "explore", "plan"]);
        assert!(policy.error.is_none());
    }

    #[test]
    fn env_beats_config_and_invalid_values_keep_the_lower_layer() {
        let config = table(
            "[subagents]\nmax_concurrent = 0\nlimit_behavior = \"fail\"\nmax_depth = 3\nenabled = true\n",
        );
        let policy = resolve(
            &config,
            &env(&[]),
            &CliSubagents::default(),
            &[],
            Path::new("/g"),
        );
        assert_eq!(policy.max_concurrent, 1, "0 clamps to 1");
        assert_eq!(policy.limit_behavior, "fail");
        assert_eq!(policy.max_depth, 3);
        let overridden = resolve(
            &config,
            &env(&[
                ("GROK_MAX_CONCURRENT_SUBAGENTS", "4"),
                ("GROK_SUBAGENT_LIMIT_BEHAVIOR", "QUEUE"),
                ("GROK_SUBAGENTS_MAX_DEPTH", "0"),
                ("GROK_SUBAGENTS", "0"),
            ]),
            &CliSubagents::default(),
            &[],
            Path::new("/g"),
        );
        assert_eq!(overridden.max_concurrent, 4);
        assert_eq!(overridden.limit_behavior, "queue");
        assert_eq!(overridden.max_depth, 1);
        assert!(!overridden.enabled);
        assert_eq!(overridden.disabled_by.as_deref(), Some("GROK_SUBAGENTS"));
        let invalid = resolve(
            &config,
            &env(&[
                ("GROK_MAX_CONCURRENT_SUBAGENTS", "-2"),
                ("GROK_SUBAGENT_LIMIT_BEHAVIOR", "drop"),
            ]),
            &CliSubagents::default(),
            &[],
            Path::new("/g"),
        );
        assert_eq!(invalid.max_concurrent, 1);
        assert_eq!(invalid.limit_behavior, "fail");
        assert_eq!(invalid.warnings.len(), 2);
    }

    #[test]
    fn no_subagents_flag_wins() {
        let policy = resolve(
            &table(""),
            &env(&[("GROK_SUBAGENTS", "1")]),
            &CliSubagents {
                disabled: true,
                denied_types: vec![],
            },
            &[],
            Path::new("/g"),
        );
        assert!(!policy.enabled);
        assert_eq!(policy.disabled_by.as_deref(), Some("--no-subagents"));
        assert_eq!(policy.to_json()["enabled"], false);
    }

    #[test]
    fn roles_agents_models_and_toggles_shape_the_types() {
        let dir = std::env::temp_dir().join(format!("codsh-subagent-role-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("review.md"), "Review carefully.").unwrap();
        let config = table(
            "[subagents.roles.reviewer]\ndescription = \"reviews\"\ndefault_capability_mode = \"read-only\"\nprompt_file = \"review.md\"\n\
             [subagents.roles.bad]\ndescription = \"x\"\ndefault_capability_mode = \"root\"\n\
             [subagents.models]\nexplore = \"cli-mock-fork\"\n[subagents.toggle]\nplan = false\n",
        );
        let agents = [
            agent("general-purpose", "Read, Grep", Some("inherit")),
            agent("tester", "", Some("fast")),
        ];
        let policy = resolve(&config, &env(&[]), &CliSubagents::default(), &agents, &dir);
        let names: Vec<_> = policy.types.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, ["general-purpose", "explore", "reviewer", "tester"]);
        let reviewer = &policy.types[2];
        assert_eq!(reviewer.capability, "read-only");
        assert_eq!(reviewer.instructions.as_deref(), Some("Review carefully."));
        assert_eq!(policy.types[1].model.as_deref(), Some("cli-mock-fork"));
        let shadow = &policy.types[0];
        assert_eq!(shadow.source, "project");
        assert_eq!(shadow.model, None, "inherit keeps the parent model");
        assert_eq!(
            shadow.tools,
            Some(vec!["Read".to_string(), "Grep".to_string()])
        );
        assert_eq!(policy.types[3].model.as_deref(), Some("fast"));
        assert!(
            policy
                .warnings
                .iter()
                .any(|warning| warning.contains("roles.bad"))
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn denied_types_are_removed_and_unknown_ones_refuse() {
        let cli = CliSubagents {
            disabled: false,
            denied_types: vec!["Explore".into(), "plan".into()],
        };
        let policy = resolve(&table(""), &env(&[]), &cli, &[], Path::new("/g"));
        let names: Vec<_> = policy.types.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, ["general-purpose"]);
        assert!(policy.error.is_none());
        let unknown = CliSubagents {
            disabled: false,
            denied_types: vec!["ghost".into()],
        };
        let refused = resolve(&table(""), &env(&[]), &unknown, &[], Path::new("/g"));
        assert!(refused.error.as_deref().unwrap().contains("Agent(ghost)"));
    }

    fn event(value: Value) -> Value {
        value
    }

    #[test]
    fn board_shows_the_isolated_worktree_and_whether_it_was_kept() {
        let mut board = Board::default();
        let base = json!({"id": "w1", "type": "general-purpose", "label": "edit", "model": "m/m", "background": false, "isolation": "worktree"});
        let mut start = base.clone();
        start["event"] = json!("start");
        start["worktree"] = json!("/pool/repo/edit-1");
        board.apply(&start);
        assert_eq!(
            board.entries[0].worktree.as_deref(),
            Some("/pool/repo/edit-1")
        );
        let mut end = base.clone();
        end["event"] = json!("end");
        end["status"] = json!("completed");
        end["elapsedMs"] = json!(1000);
        end["worktree"] = json!("/pool/repo/edit-1");
        end["worktreeKept"] = json!(true);
        board.apply(&end);
        assert!(
            board.entries[0]
                .block_title()
                .ends_with(" · worktree kept: /pool/repo/edit-1")
        );
        let lines = list_lines(&board, &TasksModal::default());
        assert!(
            lines
                .iter()
                .any(|line| line == "   worktree kept: /pool/repo/edit-1"),
            "{lines:?}"
        );
        let mut other = Board::default();
        let mut start = base.clone();
        start["event"] = json!("start");
        start["worktree"] = json!("/pool/repo/pwd-1");
        other.apply(&start);
        let mut end = base;
        end["event"] = json!("end");
        end["status"] = json!("completed");
        end["worktreeKept"] = json!(false);
        other.apply(&end);
        assert_eq!(other.entries[0].worktree, None);
        assert!(
            other.entries[0]
                .block_title()
                .ends_with(" · worktree removed (no changes)")
        );
    }

    #[test]
    fn board_follows_one_lifecycle_and_settles_once() {
        let mut board = Board::default();
        let base = json!({"id": "c1", "type": "explore", "label": "scan", "model": "cli-mock/cli-mock", "background": false});
        let mut queued = base.clone();
        queued["event"] = json!("queued");
        assert_eq!(board.apply(&queued), None);
        assert_eq!(board.entries[0].status, Status::Queued);
        assert!(
            board.entries[0]
                .block_title()
                .starts_with("Subagent queued: \"scan\" (explore · cli-mock)")
        );
        let mut start = base.clone();
        start["event"] = json!("start");
        start["child"] = json!("child-session");
        board.apply(&start);
        assert_eq!(board.running(), 1);
        assert_eq!(
            board.status_text(),
            "◎ 1 subagent still running · Ctrl+G or /tasks"
        );
        board.apply(&event(
            json!({"event": "activity", "id": "c1", "tool": "grep"}),
        ));
        assert_eq!(
            board.entries[0].block_title(),
            "Subagent running: \"scan\" (explore · cli-mock) · grep"
        );
        let mut end = base.clone();
        end["event"] = json!("end");
        end["status"] = json!("cancelled");
        end["elapsedMs"] = json!(1500);
        assert_eq!(
            board.apply(&end),
            None,
            "foreground end is shown on its block"
        );
        assert_eq!(
            board.entries[0].block_title(),
            "Subagent cancelled in 1.5s: \"scan\" (explore · cli-mock)"
        );
        end["status"] = json!("completed");
        assert_eq!(board.apply(&end), None);
        assert_eq!(
            board.entries[0].status,
            Status::Cancelled,
            "a second end is ignored"
        );
        assert_eq!(board.running(), 0);
        assert_eq!(board.status_text(), "");
        assert_eq!(board.entries[0].child.as_deref(), Some("child-session"));
    }

    #[test]
    fn background_end_notices_once_and_hide_completed_filters() {
        let mut board = Board::default();
        let base =
            json!({"id": "b1", "type": "plan", "label": "bg", "model": "p/m", "background": true});
        let mut start = base.clone();
        start["event"] = json!("start");
        board.apply(&start);
        assert!(
            board.entries[0]
                .block_title()
                .starts_with("Subagent started: \"bg\"")
        );
        let mut end = base.clone();
        end["event"] = json!("end");
        end["status"] = json!("completed");
        end["elapsedMs"] = json!(12000);
        assert_eq!(
            board.apply(&end),
            Some(Notice(
                "Subagent completed in 12s: \"bg\" (plan · m)".into()
            ))
        );
        assert_eq!(board.apply(&end), None);
        board.hide_completed = true;
        assert!(board.visible().is_empty());
        let modal = TasksModal::default();
        assert!(
            list_lines(&board, &modal)
                .iter()
                .any(|line| line.contains("h shows completed"))
        );
    }

    #[test]
    fn parse_line_accepts_only_marked_json_objects() {
        assert!(parse_line("hook: something").is_none());
        assert!(parse_line(&format!("{MARK}not json")).is_none());
        assert_eq!(
            parse_line(&format!("{MARK}{{\"event\":\"end\"}}")).unwrap()["event"],
            "end"
        );
    }

    #[test]
    fn cancel_request_is_an_atomic_private_file() {
        let home = std::env::temp_dir().join(format!("codsh-subagent-home-{}", std::process::id()));
        request_cancel(&home, "call-1").unwrap();
        let dir = control_dir(&home);
        let files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .collect();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].extension().and_then(|ext| ext.to_str()),
            Some("json")
        );
        let body: Value =
            serde_json::from_str(&std::fs::read_to_string(&files[0]).unwrap()).unwrap();
        assert_eq!(body, json!({"action": "cancel", "id": "call-1"}));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        cleanup(&home);
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(home);
    }
}
