//! Rhai workflow engine process (tickets 181 and 182).
//!
//! `codsh-rust __workflow-engine` runs one workflow script with the vendored
//! reference engine (`rust/upstream/xai-workflow`, Rhai 1.25). The dsh plugin
//! `packages/cli/bin/rust-acp-workflow.mjs` starts it for every `workflow`
//! tool call and speaks JSON lines with it:
//!
//! * host -> engine, first line: `{"op":"run"|"validate", "source":
//!   {"type":"script","script"} | {"type":"script_path","script_path"},
//!   "cwd", "grokHome", "trusted", "args", "agentBudget", "scratchDir"}`.
//! * engine -> host: `rejected`, `validated`, `started`, `request`
//!   (`spawn_agent` with normalized options, `resume_agent` with the
//!   `agent` request id and a prompt), `close` (`agent`, `status`,
//!   `detail`), `phase`, `log`, `outcome`.
//! * host -> engine afterwards: `{"type":"reply","id","ok"|"error","open"}`
//!   and `{"type":"cancel"}`. End of input cancels too.
//!
//! The engine answers the reference host calls it can decide alone: agent
//! budget reservation and queries (reference tracker semantics), templates
//! (none are registered, as in a host without built-in workflows), scratch
//! files and `git_diff_since` (`workflow_host.rs`), and the per-agent option
//! checks of the reference host (prompt/label/phase size, effort, capability
//! mode, `fork_context`, `output_schema` compilation). Only valid
//! `spawn_agent` requests reach the dsh side, which starts real dsh
//! children.
//!
//! `output_schema` (ticket 182) follows the reference attempt loop: the
//! prompt carries the output contract, a `spawn_agent` request is marked
//! `contract`, and the host keeps a child that finished successfully open
//! (`"open": true`). The engine validates the final text; on a miss it sends
//! one `resume_agent` with the reference correction prompt to the same
//! child, then `close`s it with the final status. Every attempt counts
//! toward the reference agent-run quota (2048); the budget charges one
//! logical call.
//!
//! This is a separate process with Rhai operation, depth and size limits and
//! no filesystem, network or process functions registered. It is not a
//! security sandbox: the script runs with the user's privileges and the
//! children it starts are ordinary dsh subagents.

use std::collections::HashMap;
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;

use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use xai_workflow::{
    AgentOpts, AgentResult, BudgetState, HostError, Journal, WorkflowHostRequest, WorkflowMeta,
    WorkflowOutcome, WorkflowRunParams, extract_meta, run_workflow,
};

use crate::workflow_host::{
    SCHEMA_CONTRACT_RETRIES, Scratch, WORKFLOW_MAX_AGENT_RUNS, compile_contract_schema,
    contract_prompt, retry_prompt, validate_contract_output,
};

pub const SUBCOMMAND: &str = "__workflow-engine";

/// Reference limits (`xai-grok-shell` workflow registry and host service).
pub const MAX_WORKFLOW_SOURCE_BYTES: u64 = 1024 * 1024;
const MAX_WORKFLOW_NAME_BYTES: usize = 64;
const MAX_AGENT_PROMPT_BYTES: usize = 1024 * 1024;
const MAX_PHASE_BYTES: usize = 256;
const MAX_LOG_BYTES: usize = 4 * 1024;
/// Reasoning efforts the reference accepts for `agent(..., #{ effort })`.
pub const EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];
pub const CAPABILITIES: &[&str] = &["read-only", "read-write", "execute", "all"];
/// The first line carries the script (at most 1 MiB) and the args.
const MAX_START_LINE_BYTES: u64 = 16 * 1024 * 1024;
/// A reply carries one child's output.
const MAX_REPLY_LINE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Script(String),
    Path(String),
}

#[derive(Debug, Clone)]
pub struct Resolved {
    pub meta: WorkflowMeta,
    pub script: String,
    pub path: Option<PathBuf>,
}

/// Where a `script_path` may live, as in the reference `resolve_by_path`.
#[derive(Debug, Clone)]
pub struct Scope {
    pub cwd: PathBuf,
    pub grok_home: Option<PathBuf>,
    pub trusted: bool,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_WORKFLOW_NAME_BYTES
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn parse_workflow(script: &str, path: Option<&Path>) -> Result<WorkflowMeta, String> {
    let meta = extract_meta(script).map_err(|error| format!("invalid workflow script: {error}"))?;
    if !valid_name(&meta.name) {
        return Err(format!(
            "invalid workflow name '{}': expected 1-64 lowercase letters, digits, or single hyphens",
            meta.name
        ));
    }
    if let Some(path) = path {
        let stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("");
        let filename = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if path.extension().and_then(|ext| ext.to_str()) != Some("rhai") || !valid_name(stem) {
            return Err(format!(
                "invalid workflow filename '{filename}': expected <safe-name>.rhai"
            ));
        }
        if stem != meta.name {
            return Err(format!(
                "saved workflow filename '{filename}' must match meta.name '{}'",
                meta.name
            ));
        }
    }
    Ok(meta)
}

/// The repository root above `cwd` (the nearest `.git` entry), else `cwd`.
fn project_root(cwd: &Path) -> PathBuf {
    cwd.ancestors()
        .find(|dir| dir.join(".git").exists())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| cwd.to_path_buf())
}

fn read_trusted_source(path: &Path) -> Result<String, String> {
    let shown = path.display().to_string();
    let meta = std::fs::symlink_metadata(path)
        .map_err(|error| format!("failed to read {shown}: {error}"))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(format!(
            "workflow path is not trusted: {shown} (expected a non-symlink regular file)"
        ));
    }
    let too_large =
        || format!("workflow source exceeds {MAX_WORKFLOW_SOURCE_BYTES} bytes: {shown}");
    if meta.len() > MAX_WORKFLOW_SOURCE_BYTES {
        return Err(too_large());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("failed to read {shown}: {error}"))?;
    let opened = file
        .metadata()
        .map_err(|error| format!("failed to read {shown}: {error}"))?;
    if !opened.is_file() {
        return Err(format!(
            "workflow path is not trusted: {shown} (expected a regular file)"
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_WORKFLOW_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read {shown}: {error}"))?;
    if bytes.len() as u64 > MAX_WORKFLOW_SOURCE_BYTES {
        return Err(too_large());
    }
    String::from_utf8(bytes).map_err(|error| format!("failed to read {shown}: {error}"))
}

/// Resolve a workflow source like the reference registry: an inline script
/// (at most 1 MiB), or a `.rhai` file named after its `meta.name` inside the
/// project (folder trust required) or `$GROK_HOME/workflows`.
pub fn resolve(source: &Source, scope: &Scope) -> Result<Resolved, String> {
    match source {
        Source::Script(script) => {
            if script.len() as u64 > MAX_WORKFLOW_SOURCE_BYTES {
                return Err(format!(
                    "workflow source exceeds {MAX_WORKFLOW_SOURCE_BYTES} bytes: <inline>"
                ));
            }
            let meta = parse_workflow(script, None)?;
            Ok(Resolved {
                meta,
                script: script.clone(),
                path: None,
            })
        }
        Source::Path(raw) => {
            let raw = Path::new(raw);
            let candidate = if raw.is_absolute() {
                raw.to_path_buf()
            } else {
                scope.cwd.join(raw)
            };
            let shown = candidate.display().to_string();
            let meta = std::fs::symlink_metadata(&candidate)
                .map_err(|error| format!("failed to read {shown}: {error}"))?;
            if meta.file_type().is_symlink() || !meta.is_file() {
                return Err(format!(
                    "workflow path is not trusted: {shown} (expected a non-symlink regular file)"
                ));
            }
            let canonical = std::fs::canonicalize(&candidate)
                .map_err(|error| format!("failed to read {shown}: {error}"))?;
            let project = std::fs::canonicalize(project_root(&scope.cwd)).ok();
            let user = scope
                .grok_home
                .as_ref()
                .and_then(|home| std::fs::canonicalize(home.join("workflows")).ok());
            let in_user = user
                .as_ref()
                .is_some_and(|root| canonical.starts_with(root));
            let in_project = project
                .as_ref()
                .is_some_and(|root| canonical.starts_with(root));
            if in_project && !in_user && !scope.trusted {
                return Err(format!(
                    "workflow path is not trusted: {shown} (project workflows require folder trust)"
                ));
            }
            if !in_project && !in_user {
                return Err(format!(
                    "workflow path is not trusted: {shown} (outside the project and the grok home workflows)"
                ));
            }
            let script = read_trusted_source(&canonical)?;
            let meta = parse_workflow(&script, Some(&canonical))?;
            Ok(Resolved {
                meta,
                script,
                path: Some(canonical),
            })
        }
    }
}

/// Reference agent budget: `requested = used + count > budget` is refused.
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    pub total: u64,
    pub used: u64,
}

impl Budget {
    pub fn reserve(&mut self, count: u64) -> Result<(), HostError> {
        let requested = self.used.saturating_add(count);
        if requested > self.total {
            return Err(HostError::AgentCallQuotaExceeded {
                requested,
                maximum: self.total,
            });
        }
        self.used = requested;
        Ok(())
    }

    pub fn release(&mut self, count: u64) {
        self.used = self.used.saturating_sub(count);
    }

    pub fn state(&self) -> BudgetState {
        BudgetState {
            total: Some(self.total),
            spent: self.used,
            reserved: 0,
            remaining: Some(self.total.saturating_sub(self.used)),
        }
    }
}

/// A checked `spawn_agent`: the request the dsh side receives and, for an
/// `output_schema` agent, the compiled contract.
pub struct Checked {
    pub request: Value,
    pub validator: Option<jsonschema::Validator>,
}

/// The reference host's option checks, in its order. `Ok` is the request the
/// dsh side receives; `Err` is the host error the script sees.
pub fn check_agent_opts(opts: &AgentOpts) -> Result<Checked, HostError> {
    if opts.prompt.len() > MAX_AGENT_PROMPT_BYTES {
        return Err(HostError::Failed(format!(
            "agent prompt exceeds {MAX_AGENT_PROMPT_BYTES} bytes"
        )));
    }
    if opts.fork_context {
        return Err(HostError::Unsupported(
            "fork_context is restricted to built-in workflows".into(),
        ));
    }
    if opts
        .label
        .as_ref()
        .is_some_and(|label| label.len() > MAX_PHASE_BYTES)
        || opts
            .phase
            .as_ref()
            .is_some_and(|phase| phase.len() > MAX_PHASE_BYTES)
    {
        return Err(HostError::Failed(
            "agent label and phase must each be at most 256 bytes".into(),
        ));
    }
    let effort = match opts.effort.as_deref().map(str::trim) {
        None => None,
        Some(effort) => {
            let lower = effort.to_ascii_lowercase();
            if !EFFORTS.contains(&lower.as_str()) {
                return Err(HostError::Failed(format!(
                    "invalid workflow agent effort: unknown reasoning effort '{effort}' (expected one of {})",
                    EFFORTS.join(", ")
                )));
            }
            Some(lower)
        }
    };
    if let Some(mode) = opts.capability_mode.as_deref()
        && !CAPABILITIES.contains(&mode)
    {
        return Err(HostError::Failed(format!(
            "invalid capability_mode '{mode}' (expected read-only, read-write, execute, or all)"
        )));
    }
    if opts.resume_from.is_some() {
        return Err(HostError::Unsupported(
            "resume_from is not supported by this host yet: workflow children cannot be resumed"
                .into(),
        ));
    }
    let validator = match &opts.output_schema {
        None => None,
        Some(schema) => Some(compile_contract_schema(schema).map_err(HostError::Failed)?),
    };
    let prompt = match &opts.output_schema {
        None => opts.prompt.clone(),
        Some(schema) => contract_prompt(&opts.prompt, schema),
    };
    let text = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let request = json!({
        "prompt": prompt,
        "contract": validator.is_some(),
        "label": text(&opts.label),
        "model": text(&opts.model),
        "effort": effort,
        "agentType": text(&opts.agent_type),
        "capabilityMode": opts.capability_mode,
        "isolationWorktree": opts.isolation_worktree,
        "phase": text(&opts.phase),
    });
    Ok(Checked { request, validator })
}

fn host_error_from_json(value: &Value) -> HostError {
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("workflow host failure")
        .to_string();
    match value.get("kind").and_then(Value::as_str) {
        Some("cancelled") => HostError::Cancelled,
        Some("budget_exceeded") => HostError::BudgetExceeded,
        Some("unsupported") => HostError::Unsupported(message),
        _ => HostError::Failed(message),
    }
}

pub fn outcome_json(outcome: &WorkflowOutcome, budget: &Budget) -> Value {
    let mut value = serde_json::to_value(outcome).unwrap_or_else(|error| {
        json!({"outcome": "failed", "error": format!("outcome could not be encoded: {error}")})
    });
    if let Some(map) = value.as_object_mut() {
        map.insert("type".into(), json!("outcome"));
        map.insert("agentsUsed".into(), json!(budget.used));
        map.insert("agentBudget".into(), json!(budget.total));
    }
    value
}

#[derive(Debug, Clone)]
pub struct Start {
    pub validate: bool,
    pub source: Source,
    pub scope: Scope,
    pub args: Value,
    pub agent_budget: u64,
    /// This run's scratch directory; `None` refuses scratch files.
    pub scratch_dir: Option<PathBuf>,
}

pub fn parse_start(line: &str) -> Result<Start, String> {
    let value: Value =
        serde_json::from_str(line).map_err(|error| format!("invalid engine request: {error}"))?;
    let validate = match value.get("op").and_then(Value::as_str) {
        Some("run") => false,
        Some("validate") => true,
        other => return Err(format!("invalid engine request: unknown op {other:?}")),
    };
    let source = value
        .get("source")
        .ok_or("invalid engine request: missing source")?;
    let source = match source.get("type").and_then(Value::as_str) {
        Some("script") => Source::Script(
            source
                .get("script")
                .and_then(Value::as_str)
                .ok_or("invalid engine request: script source needs `script`")?
                .to_string(),
        ),
        Some("script_path") => Source::Path(
            source
                .get("script_path")
                .and_then(Value::as_str)
                .ok_or("invalid engine request: script_path source needs `script_path`")?
                .to_string(),
        ),
        other => {
            return Err(format!(
                "invalid engine request: unsupported source type {other:?}"
            ));
        }
    };
    let cwd = value
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| Path::new(cwd).is_absolute())
        .ok_or("invalid engine request: cwd must be an absolute path")?;
    let grok_home = value
        .get("grokHome")
        .and_then(Value::as_str)
        .filter(|home| !home.is_empty())
        .map(PathBuf::from);
    let agent_budget = match value.get("agentBudget") {
        None | Some(Value::Null) => xai_workflow::DEFAULT_AGENT_BUDGET,
        Some(budget) => match budget.as_u64() {
            Some(0) | None => return Err("`agent_budget` must be a positive integer".into()),
            Some(n) if n > xai_workflow::MAX_AGENT_BUDGET => {
                return Err(format!(
                    "`agent_budget` must be at most {} agents",
                    xai_workflow::MAX_AGENT_BUDGET
                ));
            }
            Some(n) => n,
        },
    };
    Ok(Start {
        validate,
        source,
        scope: Scope {
            cwd: PathBuf::from(cwd),
            grok_home,
            trusted: value.get("trusted").and_then(Value::as_bool) == Some(true),
        },
        args: match value.get("args") {
            None => Value::Null,
            Some(args) => args.clone(),
        },
        agent_budget,
        scratch_dir: value
            .get("scratchDir")
            .and_then(Value::as_str)
            .filter(|dir| Path::new(dir).is_absolute())
            .map(PathBuf::from),
    })
}

/// Read one line of at most `limit` bytes. `Ok(None)` is end of input.
fn read_bounded_line(input: &mut impl BufRead, limit: u64) -> io::Result<Option<String>> {
    let mut bytes = Vec::new();
    let read = input
        .by_ref()
        .take(limit + 1)
        .read_until(b'\n', &mut bytes)?;
    if read == 0 {
        return Ok(None);
    }
    if bytes.len() as u64 > limit && bytes.last() != Some(&b'\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("engine input line exceeds {limit} bytes"),
        ));
    }
    String::from_utf8(bytes)
        .map(|text| Some(text.trim_end_matches(['\n', '\r']).to_string()))
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_line(output: &mut impl Write, value: &Value) {
    let _ = writeln!(output, "{value}");
    let _ = output.flush();
}

enum Event {
    Host(Box<WorkflowHostRequest>),
    HostClosed,
    Line(String),
    InputError(String),
    Eof,
    Outcome(WorkflowOutcome),
    Validated(Result<xai_workflow::ValidationReport, String>),
}

fn meta_json(meta: &WorkflowMeta) -> Value {
    json!({
        "name": meta.name,
        "description": meta.description,
        "whenToUse": meta.when_to_use,
        "phases": meta.phases.iter().map(|phase| json!({"title": phase.title, "detail": phase.detail})).collect::<Vec<_>>(),
    })
}

/// One live agent call: the script's reply and, for an `output_schema`
/// agent, the reference attempt state.
struct Call {
    reply: oneshot::Sender<Result<AgentResult, HostError>>,
    validator: Option<jsonschema::Validator>,
    /// The `spawn_agent` request id; the host knows the child by it.
    agent: u64,
    attempts: u32,
    agent_id: Option<String>,
    duration_ms: u64,
}

fn no_scratch() -> HostError {
    HostError::Unsupported(
        "scratch files need a session directory, and this run was started without one".into(),
    )
}

/// Serve one engine session. Returns the process exit code.
pub fn serve<R, W>(input: R, output: W, max_ops: u64) -> i32
where
    R: BufRead + Send + 'static,
    W: Write,
{
    serve_with(input, output, max_ops, WORKFLOW_MAX_AGENT_RUNS)
}

/// [`serve`] with an explicit agent-run quota (tests lower it).
fn serve_with<R, W>(mut input: R, mut output: W, max_ops: u64, max_agent_runs: u64) -> i32
where
    R: BufRead + Send + 'static,
    W: Write,
{
    let start = match read_bounded_line(&mut input, MAX_START_LINE_BYTES) {
        Ok(Some(line)) => line,
        Ok(None) => return 2,
        Err(error) => {
            write_line(
                &mut output,
                &json!({"type": "rejected", "code": "workflow_invalid_input", "error": error.to_string()}),
            );
            return 2;
        }
    };
    let start = match parse_start(&start) {
        Ok(start) => start,
        Err(error) => {
            write_line(
                &mut output,
                &json!({"type": "rejected", "code": "workflow_invalid_input", "error": error}),
            );
            return 0;
        }
    };
    let resolved = match resolve(&start.source, &start.scope) {
        Ok(resolved) => resolved,
        Err(error) => {
            write_line(
                &mut output,
                &json!({"type": "rejected", "code": "workflow_resolve_failed", "error": error}),
            );
            return 0;
        }
    };

    let (events, inbox) = mpsc::channel::<Event>();
    {
        let events = events.clone();
        std::thread::spawn(move || {
            loop {
                match read_bounded_line(&mut input, MAX_REPLY_LINE_BYTES) {
                    Ok(Some(line)) => {
                        if events.send(Event::Line(line)).is_err() {
                            return;
                        }
                    }
                    Ok(None) => {
                        let _ = events.send(Event::Eof);
                        return;
                    }
                    Err(error) => {
                        let _ = events.send(Event::InputError(error.to_string()));
                        return;
                    }
                }
            }
        });
    }

    if start.validate {
        let script = resolved.script.clone();
        let args = (!start.args.is_null()).then(|| start.args.clone());
        let budget = start.agent_budget;
        let validated = events.clone();
        std::thread::spawn(move || {
            let report = xai_workflow::validate_script_with_agent_budget(&script, args, budget)
                .map_err(|error| error.to_string());
            let _ = validated.send(Event::Validated(report));
        });
        drop(events);
        for event in inbox {
            match event {
                Event::Validated(Ok(report)) => {
                    write_line(
                        &mut output,
                        &json!({
                            "type": "validated",
                            "name": report.name,
                            "phases": report.phases,
                            "summary": report.outcome_summary,
                        }),
                    );
                    return 0;
                }
                Event::Validated(Err(error)) => {
                    write_line(
                        &mut output,
                        &json!({"type": "rejected", "code": "workflow_validation_failed", "error": error}),
                    );
                    return 0;
                }
                Event::Eof => return 3,
                Event::InputError(error) => {
                    eprintln!("workflow engine: {error}");
                    return 3;
                }
                Event::Line(line)
                    if serde_json::from_str::<Value>(&line)
                        .ok()
                        .is_some_and(|value| value.get("type") == Some(&json!("cancel"))) =>
                {
                    return 3;
                }
                _ => {}
            }
        }
        return 3;
    }

    let mut budget = Budget {
        total: start.agent_budget,
        used: 0,
    };
    write_line(
        &mut output,
        &json!({
            "type": "started",
            "meta": meta_json(&resolved.meta),
            "path": resolved.path.as_ref().map(|path| path.display().to_string()),
            "agentBudget": budget.total,
        }),
    );

    let cancel = CancellationToken::new();
    let (host_tx, mut host_rx) = tokio::sync::mpsc::unbounded_channel::<WorkflowHostRequest>();
    {
        let events = events.clone();
        std::thread::spawn(move || {
            while let Some(request) = host_rx.blocking_recv() {
                if events.send(Event::Host(Box::new(request))).is_err() {
                    return;
                }
            }
            let _ = events.send(Event::HostClosed);
        });
    }
    {
        let events = events.clone();
        let cancel = cancel.clone();
        let script = resolved.script.clone();
        let args = start.args.clone();
        std::thread::spawn(move || {
            let outcome = run_workflow(WorkflowRunParams {
                script,
                args,
                journal: Journal::new(None),
                host_tx,
                cancel,
                max_ops,
            });
            let _ = events.send(Event::Outcome(outcome));
        });
    }
    drop(events);

    let scratch = start.scratch_dir.clone().map(|dir| Scratch { dir });
    let cwd = start.scope.cwd.clone();
    let mut pending: HashMap<u64, Call> = HashMap::new();
    let mut next_id = 0u64;
    let mut agent_runs = 0u64;
    let mut cancelled = false;
    let mut outcome: Option<WorkflowOutcome> = None;
    let mut host_closed = false;
    let cancel_all = |pending: &mut HashMap<u64, Call>, cancelled: &mut bool| {
        *cancelled = true;
        cancel.cancel();
        for (_, call) in pending.drain() {
            let _ = call.reply.send(Err(HostError::Cancelled));
        }
    };
    let quota_error = || {
        HostError::Failed(format!(
            "workflow agent-run quota exceeded (maximum {WORKFLOW_MAX_AGENT_RUNS})"
        ))
    };
    for event in inbox {
        match event {
            Event::Host(request) => match *request {
                WorkflowHostRequest::ReserveAgentCalls { count, reply } => {
                    let _ = reply.send(if cancelled {
                        Err(HostError::Cancelled)
                    } else {
                        budget.reserve(count)
                    });
                }
                WorkflowHostRequest::ReleaseAgentCalls { count, reply } => {
                    budget.release(count);
                    let _ = reply.send(Ok(()));
                }
                WorkflowHostRequest::BudgetQuery { reply } => {
                    let _ = reply.send(if cancelled {
                        Err(HostError::Cancelled)
                    } else {
                        Ok(budget.state())
                    });
                }
                WorkflowHostRequest::SpawnAgent { opts, reply } => {
                    if cancelled {
                        let _ = reply.send(Err(HostError::Cancelled));
                        continue;
                    }
                    match check_agent_opts(&opts) {
                        Err(error) => {
                            let _ = reply.send(Err(error));
                        }
                        Ok(_) if agent_runs >= max_agent_runs => {
                            let _ = reply.send(Err(quota_error()));
                        }
                        Ok(Checked { request, validator }) => {
                            agent_runs += 1;
                            next_id += 1;
                            pending.insert(
                                next_id,
                                Call {
                                    reply,
                                    validator,
                                    agent: next_id,
                                    attempts: 1,
                                    agent_id: None,
                                    duration_ms: 0,
                                },
                            );
                            write_line(
                                &mut output,
                                &json!({"type": "request", "id": next_id, "kind": "spawn_agent", "opts": request}),
                            );
                        }
                    }
                }
                WorkflowHostRequest::Phase { title, replayed } => {
                    if !replayed && title.len() <= MAX_PHASE_BYTES {
                        write_line(&mut output, &json!({"type": "phase", "title": title}));
                    }
                }
                WorkflowHostRequest::Log { message, replayed } => {
                    if !replayed && message.len() <= MAX_LOG_BYTES {
                        write_line(&mut output, &json!({"type": "log", "message": message}));
                    }
                }
                // Script telemetry is suppressed, as in the reference host.
                WorkflowHostRequest::Telemetry { .. } => {}
                WorkflowHostRequest::RenderTemplate { name, reply, .. } => {
                    let _ = reply.send(if cancelled {
                        Err(HostError::Cancelled)
                    } else {
                        Err(HostError::Failed(format!("unknown template: {name}")))
                    });
                }
                WorkflowHostRequest::WriteScratchFile {
                    name,
                    content,
                    reply,
                } => {
                    let _ = reply.send(match (&scratch, cancelled) {
                        (_, true) => Err(HostError::Cancelled),
                        (None, _) => Err(no_scratch()),
                        (Some(scratch), _) => scratch.write(&name, &content),
                    });
                }
                WorkflowHostRequest::ReadScratchFile { name, reply } => {
                    let _ = reply.send(match (&scratch, cancelled) {
                        (_, true) => Err(HostError::Cancelled),
                        (None, _) => Err(no_scratch()),
                        (Some(scratch), _) => scratch.read(&name),
                    });
                }
                WorkflowHostRequest::GitDiffSince { commit, reply } => {
                    if cancelled {
                        let _ = reply.send(Err(HostError::Cancelled));
                        continue;
                    }
                    // Off the event loop: git may take up to 20 s.
                    let cwd = cwd.clone();
                    std::thread::spawn(move || {
                        let _ = reply.send(crate::workflow_host::git_diff_since(&cwd, &commit));
                    });
                }
            },
            Event::Line(line) => {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                match value.get("type").and_then(Value::as_str) {
                    Some("cancel") => cancel_all(&mut pending, &mut cancelled),
                    Some("reply") => {
                        let Some(mut call) = value
                            .get("id")
                            .and_then(Value::as_u64)
                            .and_then(|id| pending.remove(&id))
                        else {
                            continue;
                        };
                        let open = value.get("open") == Some(&json!(true));
                        let result = if let Some(ok) = value.get("ok") {
                            serde_json::from_value::<AgentResult>(ok.clone()).map_err(|error| {
                                HostError::Failed(format!(
                                    "invalid agent result from host: {error}"
                                ))
                            })
                        } else {
                            Err(host_error_from_json(
                                value.get("error").unwrap_or(&Value::Null),
                            ))
                        };
                        let close = |output: &mut W, status: &str, detail: &str, agent: u64| {
                            if open {
                                write_line(
                                    output,
                                    &json!({"type": "close", "agent": agent, "status": status, "detail": detail}),
                                );
                            }
                        };
                        let mut result = match result {
                            Err(error) => {
                                close(&mut output, "failed", &error.to_string(), call.agent);
                                let _ = call.reply.send(Err(error));
                                continue;
                            }
                            Ok(result) => result,
                        };
                        let Some(validator) = call.validator.as_ref() else {
                            close(&mut output, "completed", "", call.agent);
                            let _ = call.reply.send(Ok(result));
                            continue;
                        };
                        // The reference reports the first attempt's id and
                        // the summed duration of every attempt.
                        call.duration_ms = call.duration_ms.saturating_add(result.duration_ms);
                        let agent_id = call
                            .agent_id
                            .get_or_insert_with(|| result.agent_id.clone())
                            .clone();
                        result.agent_id = agent_id;
                        result.duration_ms = call.duration_ms;
                        if !result.success {
                            close(&mut output, "failed", "", call.agent);
                            let _ = call.reply.send(Ok(result));
                            continue;
                        }
                        let text = match &result.output {
                            Value::String(text) => text.clone(),
                            other => other.to_string(),
                        };
                        match validate_contract_output(validator, &text) {
                            Ok(value) => {
                                result.output = value;
                                close(&mut output, "completed", "", call.agent);
                                let _ = call.reply.send(Ok(result));
                            }
                            Err(error) if call.attempts <= SCHEMA_CONTRACT_RETRIES && open => {
                                if agent_runs >= max_agent_runs {
                                    let error = quota_error();
                                    close(&mut output, "failed", &error.to_string(), call.agent);
                                    let _ = call.reply.send(Err(error));
                                    continue;
                                }
                                agent_runs += 1;
                                call.attempts += 1;
                                next_id += 1;
                                write_line(
                                    &mut output,
                                    &json!({"type": "request", "id": next_id, "kind": "resume_agent", "agent": call.agent, "prompt": retry_prompt(&error)}),
                                );
                                pending.insert(next_id, call);
                            }
                            Err(error) => {
                                let message =
                                    format!("structured output validation failed: {error}");
                                result.success = false;
                                result.output = Value::String(message.clone());
                                close(&mut output, "failed", &message, call.agent);
                                let _ = call.reply.send(Ok(result));
                            }
                        }
                    }
                    _ => {}
                }
            }
            Event::Eof => cancel_all(&mut pending, &mut cancelled),
            Event::InputError(error) => {
                eprintln!("workflow engine: {error}; cancelling the run");
                cancel_all(&mut pending, &mut cancelled);
            }
            Event::HostClosed => host_closed = true,
            Event::Outcome(done) => outcome = Some(done),
            Event::Validated(_) => {}
        }
        if host_closed && let Some(done) = outcome.take() {
            write_line(&mut output, &outcome_json(&done, &budget));
            return 0;
        }
    }
    1
}

/// Entry point of the hidden subcommand.
pub fn run_engine() -> i32 {
    let stdout = io::stdout();
    serve(
        io::BufReader::new(io::stdin()),
        stdout.lock(),
        WorkflowRunParams::DEFAULT_MAX_OPS,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// A reader fed line by line from the test.
    struct Feed(mpsc::Receiver<Vec<u8>>, Vec<u8>);

    impl Read for Feed {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.1.is_empty() {
                match self.0.recv() {
                    Ok(bytes) => self.1 = bytes,
                    Err(_) => return Ok(0),
                }
            }
            let n = buf.len().min(self.1.len());
            buf[..n].copy_from_slice(&self.1[..n]);
            self.1.drain(..n);
            Ok(n)
        }
    }

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Sink {
        /// Complete lines only: a line may still be half written.
        fn lines(&self) -> Vec<Value> {
            let text = String::from_utf8(self.0.lock().unwrap().clone()).unwrap();
            let complete = &text[..text.rfind('\n').map_or(0, |end| end + 1)];
            complete
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }

        /// Wait until a line matches, or panic after 20 s.
        fn wait(&self, what: impl Fn(&Value) -> bool) -> Value {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if let Some(found) = self.lines().into_iter().find(|line| what(line)) {
                    return found;
                }
                assert!(
                    Instant::now() < deadline,
                    "no matching line in {:?}",
                    self.lines()
                );
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }

    struct Session {
        feed: Option<mpsc::Sender<Vec<u8>>>,
        sink: Sink,
        done: std::thread::JoinHandle<i32>,
    }

    impl Session {
        fn start(start: Value, max_ops: u64) -> Self {
            let (feed, rx) = mpsc::channel();
            feed.send(format!("{start}\n").into_bytes()).unwrap();
            let sink = Sink::default();
            let out = sink.clone();
            let done = std::thread::spawn(move || {
                serve(io::BufReader::new(Feed(rx, Vec::new())), out, max_ops)
            });
            Self {
                feed: Some(feed),
                sink,
                done,
            }
        }

        fn send(&self, value: Value) {
            self.feed
                .as_ref()
                .unwrap()
                .send(format!("{value}\n").into_bytes())
                .unwrap();
        }

        fn finish(mut self) -> (i32, Vec<Value>) {
            let code = self.done.join().unwrap();
            self.feed.take();
            (code, self.sink.lines())
        }
    }

    fn run(script: &str, args: Value) -> Value {
        json!({"op": "run", "source": {"type": "script", "script": script}, "cwd": "/", "args": args})
    }

    fn ok_result(id: &str, output: &str) -> Value {
        json!({"agent_id": id, "success": true, "output": output, "cancelled": false, "tokens_used": 0, "duration_ms": 1})
    }

    const META: &str = "let meta = #{ name: \"probe\", description: \"test\" };\n";

    #[test]
    fn args_reach_the_script_and_agent_results_come_back() {
        let script = format!(
            "{META}phase(\"scan\");\nlog(\"files: \" + args.files.len());\nlet r = agent(\"summarize \" + args.files[0], #{{ label: \"first\", model: \"m1\", effort: \"HIGH\", capability_mode: \"read-only\", agent_type: \"explore\", phase: \"scan\" }});\n#{{ out: r.output, ok: r.success, n: args.files.len() }}"
        );
        let session = Session::start(run(&script, json!({"files": ["a.rs", "b.rs"]})), 1_000_000);
        let started = session.sink.wait(|line| line["type"] == "started");
        assert_eq!(started["meta"]["name"], "probe");
        let request = session.sink.wait(|line| line["type"] == "request");
        assert_eq!(request["kind"], "spawn_agent");
        assert_eq!(request["opts"]["prompt"], "summarize a.rs");
        assert_eq!(request["opts"]["label"], "first");
        assert_eq!(request["opts"]["model"], "m1");
        assert_eq!(request["opts"]["effort"], "high");
        assert_eq!(request["opts"]["capabilityMode"], "read-only");
        assert_eq!(request["opts"]["agentType"], "explore");
        assert_eq!(request["opts"]["phase"], "scan");
        session
            .send(json!({"type": "reply", "id": request["id"], "ok": ok_result("c1", "SUMMARY")}));
        let (code, lines) = session.finish();
        assert_eq!(code, 0);
        let kinds: Vec<&str> = lines
            .iter()
            .map(|line| line["type"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["started", "phase", "log", "request", "outcome"]);
        assert_eq!(lines[2]["message"], "files: 2");
        let outcome = lines.last().unwrap();
        assert_eq!(outcome["outcome"], "completed");
        assert_eq!(
            outcome["result"],
            json!({"out": "SUMMARY", "ok": true, "n": 2})
        );
        assert_eq!(outcome["agentsUsed"], 1);
        assert_eq!(outcome["agentBudget"], 128);
    }

    #[test]
    fn a_failed_child_is_a_result_the_script_can_read() {
        let script = format!(
            "{META}let r = agent(\"x\");\nif r.success {{ \"ok\" }} else {{ \"child failed: \" + r.output }}"
        );
        let session = Session::start(run(&script, Value::Null), 1_000_000);
        let request = session.sink.wait(|line| line["type"] == "request");
        session.send(json!({"type": "reply", "id": request["id"], "ok": {"agent_id": "c", "success": false, "output": "boom", "cancelled": false, "tokens_used": 0, "duration_ms": 0}}));
        let (_, lines) = session.finish();
        assert_eq!(lines.last().unwrap()["result"], "child failed: boom");
    }

    #[test]
    fn host_failures_throw_and_uncaught_ones_fail_the_run() {
        let script = format!("{META}agent(\"x\", #{{ agent_type: \"nope\" }})");
        let session = Session::start(run(&script, Value::Null), 1_000_000);
        let request = session.sink.wait(|line| line["type"] == "request");
        session.send(json!({"type": "reply", "id": request["id"], "error": {"kind": "failed", "message": "unknown or disabled subagent type \"nope\""}}));
        let (_, lines) = session.finish();
        let outcome = lines.last().unwrap();
        assert_eq!(outcome["outcome"], "failed");
        assert!(
            outcome["error"]
                .as_str()
                .unwrap()
                .contains("unknown or disabled subagent type"),
            "{outcome}"
        );
    }

    #[test]
    fn invalid_options_are_refused_before_the_host_sees_them() {
        let long_label = format!("#{{ label: \"{}\" }}", "l".repeat(300));
        for (opts, expected) in [
            ("#{ effort: \"turbo\" }", "invalid workflow agent effort"),
            (
                "#{ capability_mode: \"root\" }",
                "invalid capability_mode 'root' (expected read-only, read-write, execute, or all)",
            ),
            (
                "#{ fork_context: true }",
                "fork_context is restricted to built-in workflows",
            ),
            ("#{ resume_from: \"c1\" }", "resume_from is not supported"),
            (
                "#{ output_schema: #{ type: 7 } }",
                "output_schema is not a valid self-contained JSON Schema: ",
            ),
            (
                "#{ output_schema: #{ \"$ref\": \"https://example.com/s.json\" } }",
                "external JSON Schema references are disabled",
            ),
            (
                long_label.as_str(),
                "agent label and phase must each be at most 256 bytes",
            ),
        ] {
            let script = format!(
                "{META}let r = \"\";\ntry {{ agent(\"x\", {opts}); r = \"spawned\"; }} catch (e) {{ r = \"refused: \" + e; }}\nr"
            );
            let session = Session::start(run(&script, Value::Null), 1_000_000);
            let (_, lines) = session.finish();
            assert!(
                lines.iter().all(|line| line["type"] != "request"),
                "{lines:?}"
            );
            let result = lines.last().unwrap()["result"]
                .as_str()
                .unwrap_or_else(|| panic!("{opts}: {lines:?}"))
                .to_string();
            assert!(
                result.starts_with("refused: ") && result.contains(expected),
                "{opts}: {result}"
            );
        }
    }

    #[test]
    fn parallel_spawns_concurrently_and_keeps_order() {
        let script = format!(
            "{META}let rs = parallel([#{{ prompt: \"a\" }}, #{{ prompt: \"b\" }}, #{{ prompt: \"c\" }}]);\nrs.map(|r| if r == () {{ \"null\" }} else {{ r.output }})"
        );
        let session = Session::start(run(&script, Value::Null), 1_000_000);
        // All three requests are out before any reply.
        let deadline = Instant::now() + Duration::from_secs(20);
        let requests = loop {
            let requests: Vec<Value> = session
                .sink
                .lines()
                .into_iter()
                .filter(|line| line["type"] == "request")
                .collect();
            if requests.len() == 3 {
                break requests;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        };
        // Reply out of order; the second child fails at the host.
        session.send(json!({"type": "reply", "id": requests[2]["id"], "ok": ok_result("c3", "C")}));
        session.send(json!({"type": "reply", "id": requests[1]["id"], "error": {"kind": "failed", "message": "x"}}));
        session.send(json!({"type": "reply", "id": requests[0]["id"], "ok": ok_result("c1", "A")}));
        let (_, lines) = session.finish();
        let outcome = lines.last().unwrap();
        assert_eq!(outcome["result"], json!(["A", "null", "C"]));
        assert_eq!(outcome["agentsUsed"], 3);
    }

    #[test]
    fn budget_is_absolute_and_a_panel_over_it_starts_nothing() {
        let start = json!({"op": "run", "source": {"type": "script", "script": format!("{META}let b = budget();\nlet rs = parallel([#{{ prompt: \"a\" }}, #{{ prompt: \"b\" }}, #{{ prompt: \"c\" }}]);\n0")}, "cwd": "/", "agentBudget": 2});
        let session = Session::start(start, 1_000_000);
        let (_, lines) = session.finish();
        assert!(lines.iter().all(|line| line["type"] != "request"));
        let outcome = lines.last().unwrap();
        assert_eq!(outcome["outcome"], "budget_exceeded");
        assert!(
            outcome["message"]
                .as_str()
                .unwrap()
                .contains("requested 3, maximum 2"),
            "{outcome}"
        );
        assert_eq!(outcome["agentsUsed"], 0);

        let script = format!(
            "{META}let b = budget();\n#{{ total: b.total, spent: b.spent, remaining: b.remaining, reserved: b.reserved }}"
        );
        let session = Session::start(
            json!({"op": "run", "source": {"type": "script", "script": script}, "cwd": "/", "agentBudget": 5}),
            1_000_000,
        );
        let (_, lines) = session.finish();
        assert_eq!(
            lines.last().unwrap()["result"],
            json!({"total": 5, "spent": 0, "remaining": 5, "reserved": 0})
        );
    }

    #[test]
    fn syntax_errors_and_bad_meta_are_rejected_before_a_run() {
        for (script, expected) in [
            (
                format!("{META}let x = ;"),
                "invalid workflow script: script failed to parse",
            ),
            (
                "let x = 1;\nlet meta = #{ name: \"a\", description: \"b\" };".to_string(),
                "first statement must be `let meta",
            ),
            (
                "let meta = #{ name: \"Bad Name\", description: \"b\" };".to_string(),
                "meta.name must be lowercase",
            ),
            (
                "let meta = #{ name: \"ok\" };".to_string(),
                "invalid workflow script",
            ),
        ] {
            let session = Session::start(run(&script, Value::Null), 1_000_000);
            let (code, lines) = session.finish();
            assert_eq!(code, 0);
            assert_eq!(lines.len(), 1, "{lines:?}");
            assert_eq!(lines[0]["type"], "rejected");
            assert_eq!(lines[0]["code"], "workflow_resolve_failed");
            assert!(
                lines[0]["error"].as_str().unwrap().contains(expected),
                "{}",
                lines[0]
            );
        }
    }

    #[test]
    fn an_endless_script_stops_at_the_operation_limit() {
        let session = Session::start(run(&format!("{META}loop {{ }}"), Value::Null), 200_000);
        let (_, lines) = session.finish();
        let outcome = lines.last().unwrap();
        assert_eq!(outcome["outcome"], "failed");
        assert!(
            outcome["error"]
                .as_str()
                .unwrap()
                .contains("Too many operations"),
            "{outcome}"
        );
    }

    #[test]
    fn cancel_stops_a_busy_script_and_a_waiting_one() {
        let session = Session::start(run(&format!("{META}loop {{ }}"), Value::Null), u64::MAX);
        session.sink.wait(|line| line["type"] == "started");
        session.send(json!({"type": "cancel"}));
        let (_, lines) = session.finish();
        assert_eq!(lines.last().unwrap()["outcome"], "cancelled");

        let session = Session::start(
            run(&format!("{META}agent(\"wait\")"), Value::Null),
            u64::MAX,
        );
        session.sink.wait(|line| line["type"] == "request");
        session.send(json!({"type": "cancel"}));
        let (_, lines) = session.finish();
        let outcome = lines.last().unwrap();
        assert_eq!(outcome["outcome"], "cancelled");
        // A cancelled spawn is released, as the reference does.
        assert_eq!(outcome["agentsUsed"], 0);
    }

    #[test]
    fn end_of_input_cancels() {
        let mut session = Session::start(
            run(&format!("{META}agent(\"wait\")"), Value::Null),
            u64::MAX,
        );
        session.sink.wait(|line| line["type"] == "request");
        session.feed.take();
        let (_, lines) = session.finish();
        assert_eq!(lines.last().unwrap()["outcome"], "cancelled");
    }

    #[test]
    fn templates_scratch_and_git_diff_follow_the_reference_host() {
        let script = format!(
            "{META}let out = [];\nfor f in [|| render_template(\"t\", #{{}}), || write_scratch_file(\"a\", \"b\"), || read_scratch_file(\"a\"), || git_diff_since(\"HEAD~1\")] {{ try {{ out.push(f.call()); }} catch (e) {{ out.push(e); }} }}\nout"
        );
        // Without a session directory scratch files are refused explicitly.
        let session = Session::start(run(&script, Value::Null), 1_000_000);
        let (_, lines) = session.finish();
        assert_eq!(
            lines.last().unwrap()["result"],
            json!([
                "unknown template: t",
                "scratch files need a session directory, and this run was started without one",
                "scratch files need a session directory, and this run was started without one",
                "git_diff_since expects a commit hash, got: HEAD~1"
            ])
        );

        let root = tempfile::tempdir().unwrap();
        let dir = root
            .path()
            .join("s")
            .join("workflows")
            .join("run")
            .join("scratch");
        let script = format!(
            "{META}let p = write_scratch_file(\"notes.md\", \"hello\");\nlet back = read_scratch_file(\"notes.md\");\nlet bad = \"\"; try {{ write_scratch_file(\"../x\", \"y\"); }} catch (e) {{ bad = e; }}\nlet missing = \"\"; try {{ read_scratch_file(\"none\"); }} catch (e) {{ missing = e; }}\n#{{ p: p, back: back, bad: bad, missing: missing }}"
        );
        let start = json!({"op": "run", "source": {"type": "script", "script": script}, "cwd": "/", "scratchDir": dir.to_str().unwrap()});
        let (_, lines) = Session::start(start, 1_000_000).finish();
        let result = &lines.last().unwrap()["result"];
        assert_eq!(result["p"], "scratch/notes.md");
        assert_eq!(result["back"], "hello");
        assert_eq!(
            result["bad"],
            "scratch file name must be a single relative path component, got: ../x"
        );
        assert!(
            result["missing"]
                .as_str()
                .unwrap()
                .starts_with("scratch read metadata: "),
            "{result}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("notes.md")).unwrap(),
            "hello"
        );
    }

    fn contract_script(schema: &str) -> String {
        format!(
            "{META}let r = agent(\"scan\", #{{ label: \"s\", output_schema: {schema} }});\n#{{ ok: r.success, out: r.output, id: r.agent_id, ms: r.duration_ms }}"
        )
    }

    const OK_SCHEMA: &str =
        "#{ type: \"object\", required: [\"ok\"], properties: #{ ok: #{ type: \"boolean\" } } }";

    fn reply_open(session: &Session, id: &Value, agent: &str, output: &str, ms: u64) {
        session.send(json!({"type": "reply", "id": id, "open": true, "ok": {"agent_id": agent, "success": true, "output": output, "cancelled": false, "tokens_used": 0, "duration_ms": ms}}));
    }

    #[test]
    fn output_schema_passes_on_the_first_answer() {
        let session = Session::start(run(&contract_script(OK_SCHEMA), Value::Null), 1_000_000);
        let request = session.sink.wait(|line| line["type"] == "request");
        assert_eq!(request["opts"]["contract"], true);
        let prompt = request["opts"]["prompt"].as_str().unwrap();
        assert!(
            prompt
                .starts_with("scan\n\n<output-contract>\nDo the work above with your tools first."),
            "{prompt}"
        );
        assert!(prompt.contains("\"required\":[\"ok\"]"), "{prompt}");
        reply_open(
            &session,
            &request["id"],
            "c1",
            "done.\n```json\n{\"ok\": true}\n```",
            5,
        );
        let (_, lines) = session.finish();
        let kinds: Vec<&str> = lines
            .iter()
            .map(|line| line["type"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["started", "request", "close", "outcome"]);
        assert_eq!(
            lines[2],
            json!({"type": "close", "agent": request["id"], "status": "completed", "detail": ""})
        );
        assert_eq!(
            lines.last().unwrap()["result"],
            json!({"ok": true, "out": {"ok": true}, "id": "c1", "ms": 5})
        );
        assert_eq!(lines.last().unwrap()["agentsUsed"], 1);
    }

    #[test]
    fn output_schema_resumes_the_same_child_once_then_accepts() {
        let session = Session::start(run(&contract_script(OK_SCHEMA), Value::Null), 1_000_000);
        let request = session.sink.wait(|line| line["type"] == "request");
        reply_open(&session, &request["id"], "c1", "all clear", 5);
        let resume = session.sink.wait(|line| line["kind"] == "resume_agent");
        assert_eq!(resume["agent"], request["id"]);
        let prompt = resume["prompt"].as_str().unwrap();
        assert!(prompt.starts_with("Your final message did not satisfy the output contract: final message did not contain valid JSON (expected a ```json fenced block): "), "{prompt}");
        assert!(prompt.ends_with("Reply with a single ```json fenced block containing one JSON value conforming to the schema from <output-contract>, and nothing else."), "{prompt}");
        reply_open(
            &session,
            &resume["id"],
            "c1-again",
            "```json\n{\"ok\": false}\n```",
            7,
        );
        let (_, lines) = session.finish();
        let closes: Vec<&Value> = lines
            .iter()
            .filter(|line| line["type"] == "close")
            .collect();
        assert_eq!(closes.len(), 1);
        assert_eq!(closes[0]["status"], "completed");
        // One logical call; the first attempt's id and the summed time.
        let outcome = lines.last().unwrap();
        assert_eq!(
            outcome["result"],
            json!({"ok": true, "out": {"ok": false}, "id": "c1", "ms": 12})
        );
        assert_eq!(outcome["agentsUsed"], 1);
    }

    #[test]
    fn output_schema_fails_after_the_retry_and_a_failed_child_is_not_retried() {
        let session = Session::start(run(&contract_script(OK_SCHEMA), Value::Null), 1_000_000);
        let request = session.sink.wait(|line| line["type"] == "request");
        reply_open(&session, &request["id"], "c1", "{\"ok\": \"yes\"}", 1);
        let resume = session.sink.wait(|line| line["kind"] == "resume_agent");
        assert!(
            resume["prompt"]
                .as_str()
                .unwrap()
                .contains("output does not match the required schema: ")
        );
        reply_open(&session, &resume["id"], "c1", "still no", 1);
        let (_, lines) = session.finish();
        let close = lines.iter().find(|line| line["type"] == "close").unwrap();
        assert_eq!(close["status"], "failed");
        let result = &lines.last().unwrap()["result"];
        assert_eq!(result["ok"], false);
        assert!(
            result["out"].as_str().unwrap().starts_with(
                "structured output validation failed: final message did not contain valid JSON"
            ),
            "{result}"
        );
        assert_eq!(
            lines
                .iter()
                .filter(|line| line["kind"] == "resume_agent")
                .count(),
            1
        );

        // A child that failed is handed back as is: no retry, no close
        // (the host closed it).
        let session = Session::start(run(&contract_script(OK_SCHEMA), Value::Null), 1_000_000);
        let request = session.sink.wait(|line| line["type"] == "request");
        session.send(json!({"type": "reply", "id": request["id"], "ok": {"agent_id": "c", "success": false, "output": "subagent run failed", "cancelled": false, "tokens_used": 0, "duration_ms": 0}}));
        let (_, lines) = session.finish();
        assert!(
            lines
                .iter()
                .all(|line| line["type"] != "close" && line["kind"] != "resume_agent"),
            "{lines:?}"
        );
        assert_eq!(
            lines.last().unwrap()["result"]["out"],
            "subagent run failed"
        );
    }

    #[test]
    fn the_agent_run_quota_counts_every_attempt() {
        let start = |script: &str| {
            let (feed, rx) = mpsc::channel::<Vec<u8>>();
            feed.send(format!("{}\n", run(script, Value::Null)).into_bytes())
                .unwrap();
            let sink = Sink::default();
            let out = sink.clone();
            let done = std::thread::spawn(move || {
                serve_with(io::BufReader::new(Feed(rx, Vec::new())), out, 1_000_000, 1)
            });
            Session {
                feed: Some(feed),
                sink,
                done,
            }
        };
        // The second first-attempt run is over a quota of one.
        let session = start(&format!(
            "{META}agent(\"a\"); let r = \"\"; try {{ agent(\"b\"); }} catch (e) {{ r = e; }}\nr"
        ));
        let request = session.sink.wait(|line| line["type"] == "request");
        session.send(json!({"type": "reply", "id": request["id"], "ok": ok_result("c1", "A")}));
        let (_, lines) = session.finish();
        assert_eq!(
            lines.last().unwrap()["result"],
            "workflow agent-run quota exceeded (maximum 2048)"
        );
        // A schema retry needs a run too; without one the child is closed
        // as failed and the call fails.
        let session = start(&format!(
            "{META}let r = \"\"; try {{ agent(\"a\", #{{ output_schema: {OK_SCHEMA} }}); }} catch (e) {{ r = e; }}\nr"
        ));
        let request = session.sink.wait(|line| line["type"] == "request");
        reply_open(&session, &request["id"], "c1", "no json", 1);
        let (_, lines) = session.finish();
        assert!(lines.iter().all(|line| line["kind"] != "resume_agent"));
        assert_eq!(
            lines.iter().find(|line| line["type"] == "close").unwrap()["status"],
            "failed"
        );
        assert_eq!(
            lines.last().unwrap()["result"],
            "workflow agent-run quota exceeded (maximum 2048)"
        );
    }

    #[test]
    fn a_parallel_panel_with_schemas_keeps_order_and_isolates_retries() {
        let script = format!(
            "{META}let rs = parallel([#{{ prompt: \"a\", output_schema: {OK_SCHEMA} }}, #{{ prompt: \"b\" }}, #{{ prompt: \"c\", output_schema: {OK_SCHEMA} }}]);\nrs.map(|r| if r == () {{ \"null\" }} else {{ r.output }})"
        );
        let session = Session::start(run(&script, Value::Null), 1_000_000);
        let deadline = Instant::now() + Duration::from_secs(20);
        let requests = loop {
            let requests: Vec<Value> = session
                .sink
                .lines()
                .into_iter()
                .filter(|line| line["kind"] == "spawn_agent")
                .collect();
            if requests.len() == 3 {
                break requests;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(
            requests
                .iter()
                .map(|r| r["opts"]["contract"].as_bool().unwrap())
                .collect::<Vec<_>>(),
            [true, false, true]
        );
        reply_open(&session, &requests[2]["id"], "c3", "nope", 1);
        let resume = session.sink.wait(|line| line["kind"] == "resume_agent");
        assert_eq!(resume["agent"], requests[2]["id"]);
        session.send(json!({"type": "reply", "id": requests[1]["id"], "ok": ok_result("c2", "B")}));
        reply_open(&session, &requests[0]["id"], "c1", "{\"ok\": true}", 1);
        reply_open(&session, &resume["id"], "c3", "{\"ok\": false}", 1);
        let (_, lines) = session.finish();
        let outcome = lines.last().unwrap();
        assert_eq!(outcome["result"], json!([{"ok": true}, "B", {"ok": false}]));
        assert_eq!(outcome["agentsUsed"], 3);
    }

    #[test]
    fn pause_and_complete_are_outcomes() {
        let session = Session::start(
            run(
                &format!("{META}pause(\"user\", \"check this\");"),
                Value::Null,
            ),
            1_000_000,
        );
        let (_, lines) = session.finish();
        let outcome = lines.last().unwrap();
        assert_eq!(outcome["outcome"], "paused");
        assert_eq!(outcome["kind"], "user");
        assert_eq!(outcome["message"], "check this");

        let session = Session::start(
            run(
                &format!("{META}complete(#{{ report: \"R\" }}); 1"),
                Value::Null,
            ),
            1_000_000,
        );
        let (_, lines) = session.finish();
        assert_eq!(lines.last().unwrap()["result"], json!({"report": "R"}));
    }

    #[test]
    fn logs_and_phases_over_the_reference_caps_are_dropped() {
        let script = format!(
            "{META}log(\"{}\"); phase(\"{}\"); log(\"kept\"); 0",
            "x".repeat(5000),
            "p".repeat(300)
        );
        let session = Session::start(run(&script, Value::Null), 1_000_000);
        let (_, lines) = session.finish();
        let kinds: Vec<&str> = lines
            .iter()
            .map(|line| line["type"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["started", "log", "outcome"]);
        assert_eq!(lines[1]["message"], "kept");
    }

    #[test]
    fn validate_only_runs_the_canned_host_path() {
        let script = format!("{META}let r = agent(\"x\");\nr.success");
        let session = Session::start(
            json!({"op": "validate", "source": {"type": "script", "script": script}, "cwd": "/"}),
            1_000_000,
        );
        let (_, lines) = session.finish();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["type"], "validated");
        assert_eq!(lines[0]["name"], "probe");
        assert_eq!(lines[0]["summary"], "completed: true");

        let script = format!("{META}throw \"bad path\";");
        let session = Session::start(
            json!({"op": "validate", "source": {"type": "script", "script": script}, "cwd": "/"}),
            1_000_000,
        );
        let (_, lines) = session.finish();
        assert_eq!(lines[0]["code"], "workflow_validation_failed");
        assert!(lines[0]["error"].as_str().unwrap().contains("bad path"));
    }

    #[test]
    fn start_line_checks_the_budget_range() {
        for (budget, expected) in [
            (json!(0), "positive integer"),
            (json!(1025), "at most 1024"),
            (json!("x"), "positive integer"),
        ] {
            let session = Session::start(
                json!({"op": "run", "source": {"type": "script", "script": META}, "cwd": "/", "agentBudget": budget}),
                1_000_000,
            );
            let (_, lines) = session.finish();
            assert_eq!(lines[0]["code"], "workflow_invalid_input");
            assert!(lines[0]["error"].as_str().unwrap().contains(expected));
        }
    }

    #[test]
    fn script_paths_follow_the_reference_trust_rules() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("repo");
        let home = root.path().join("grok");
        std::fs::create_dir_all(project.join(".git")).unwrap();
        std::fs::create_dir_all(project.join("sub")).unwrap();
        std::fs::create_dir_all(home.join("workflows")).unwrap();
        let script = "let meta = #{ name: \"scan\", description: \"d\" };\n1";
        std::fs::write(project.join("scan.rhai"), script).unwrap();
        std::fs::write(project.join("other.rhai"), script).unwrap();
        std::fs::write(project.join("scan.txt"), script).unwrap();
        std::fs::write(home.join("workflows").join("scan.rhai"), script).unwrap();
        std::fs::write(root.path().join("scan.rhai"), script).unwrap();
        let scope = |trusted| Scope {
            cwd: project.join("sub"),
            grok_home: Some(home.clone()),
            trusted,
        };
        let path = |p: &str| Source::Path(p.to_string());

        let found = resolve(&path("../scan.rhai"), &scope(true)).unwrap();
        assert_eq!(found.meta.name, "scan");
        assert_eq!(
            found.path.unwrap(),
            std::fs::canonicalize(project.join("scan.rhai")).unwrap()
        );
        let error = resolve(&path("../scan.rhai"), &scope(false)).unwrap_err();
        assert!(
            error.contains("project workflows require folder trust"),
            "{error}"
        );
        // The user workflow directory needs no folder trust.
        let user = home.join("workflows").join("scan.rhai");
        assert!(resolve(&path(user.to_str().unwrap()), &scope(false)).is_ok());
        let error = resolve(
            &path(root.path().join("scan.rhai").to_str().unwrap()),
            &scope(true),
        )
        .unwrap_err();
        assert!(error.contains("outside the project"), "{error}");
        let error = resolve(&path("../other.rhai"), &scope(true)).unwrap_err();
        assert!(
            error.contains("saved workflow filename 'other.rhai' must match meta.name 'scan'"),
            "{error}"
        );
        let error = resolve(&path("../scan.txt"), &scope(true)).unwrap_err();
        assert!(error.contains("expected <safe-name>.rhai"), "{error}");
        let error = resolve(&path("../missing.rhai"), &scope(true)).unwrap_err();
        assert!(error.starts_with("failed to read"), "{error}");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                project.join("scan.rhai"),
                project.join("sub").join("scan.rhai"),
            )
            .unwrap();
            let error = resolve(&path("scan.rhai"), &scope(true)).unwrap_err();
            assert!(
                error.contains("expected a non-symlink regular file"),
                "{error}"
            );
        }
        let big = format!(
            "let meta = #{{ name: \"big\", description: \"d\" }};\n//{}",
            "x".repeat(MAX_WORKFLOW_SOURCE_BYTES as usize)
        );
        std::fs::write(project.join("big.rhai"), &big).unwrap();
        let error = resolve(&path("../big.rhai"), &scope(true)).unwrap_err();
        assert!(
            error.contains("workflow source exceeds 1048576 bytes"),
            "{error}"
        );
        let error = resolve(&Source::Script(big), &scope(true)).unwrap_err();
        assert!(error.contains("<inline>"), "{error}");
    }
}
