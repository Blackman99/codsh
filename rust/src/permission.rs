#![allow(dead_code)]

use crate::trust;
use serde_json::{Value as JsonValue, json};
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use toml::Value as TomlValue;

pub const POLICY_FILE_NAME: &str = "permission-policy.json";
pub const GRANTS_FILE_NAME: &str = "permission.toml";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionMode {
    Ask,
    Auto,
    AlwaysApprove,
    DontAsk,
    AcceptEdits,
}

impl PermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Auto => "auto",
            Self::AlwaysApprove => "always-approve",
            Self::DontAsk => "dontAsk",
            Self::AcceptEdits => "acceptEdits",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim() {
            "ask" | "default" | "plan" => Ok(Self::Ask),
            "auto" => Ok(Self::Auto),
            "always-approve" | "alwaysApprove" | "bypassPermissions" | "yolo" => {
                Ok(Self::AlwaysApprove)
            }
            "dontAsk" | "dont-ask" => Ok(Self::DontAsk),
            "acceptEdits" | "accept-edits" => Ok(Self::AcceptEdits),
            other => Err(format!(
                "invalid permission mode {other:?}; expected ask, auto, always-approve, dontAsk, or acceptEdits"
            )),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuleAction {
    Deny,
    Ask,
    Allow,
}

impl RuleAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Deny => "deny",
            Self::Ask => "ask",
            Self::Allow => "allow",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolFilter {
    Any,
    Bash,
    Edit,
    Read,
    Grep,
    Mcp,
    WebFetch,
    WebSearch,
}

impl ToolFilter {
    fn as_str(self) -> &'static str {
        match self {
            Self::Any => "any",
            Self::Bash => "bash",
            Self::Edit => "edit",
            Self::Read => "read",
            Self::Grep => "grep",
            Self::Mcp => "mcp",
            Self::WebFetch => "web_fetch",
            Self::WebSearch => "web_search",
        }
    }

    fn parse_name(name: &str) -> Option<Self> {
        match name {
            "Bash" | "bash" => Some(Self::Bash),
            "Read" | "read" => Some(Self::Read),
            "Edit" | "edit" | "Write" | "write" => Some(Self::Edit),
            "Grep" | "grep" | "Glob" | "glob" => Some(Self::Grep),
            "MCPTool" | "mcp" => Some(Self::Mcp),
            "WebFetch" | "webfetch" | "web_fetch" => Some(Self::WebFetch),
            "WebSearch" | "websearch" | "web_search" => Some(Self::WebSearch),
            "*" | "any" => Some(Self::Any),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PatternMode {
    Glob,
    Domain,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionRule {
    pub action: RuleAction,
    pub tool: ToolFilter,
    pub pattern: Option<String>,
    pub pattern_mode: PatternMode,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccessKind {
    Read(Option<String>),
    Grep { path: Option<String> },
    Edit(String),
    Bash(String),
    Mcp { name: String },
    WebFetch(String),
    WebSearch(String),
    Tool(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Allow { reason: String },
    Ask { reason: String },
    Deny { reason: String },
}

impl Decision {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Allow { .. } => "allow",
            Self::Ask { .. } => "ask",
            Self::Deny { .. } => "deny",
        }
    }

    pub fn reason(&self) -> &str {
        match self {
            Self::Allow { reason } | Self::Ask { reason } | Self::Deny { reason } => reason,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GrantStore {
    pub allowed_bash: Vec<String>,
    pub denied_bash: Vec<String>,
    pub allowed_mcp: Vec<String>,
    pub denied_mcp: Vec<String>,
    pub allowed_domains: Vec<String>,
    pub denied_domains: Vec<String>,
    pub allowed_edits: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionPolicy {
    pub mode: PermissionMode,
    pub mode_source: String,
    pub always_approve_locked: bool,
    pub lock_source: Option<String>,
    pub remember_tool_approvals: bool,
    pub remember_source: String,
    pub interactive: bool,
    pub cwd: PathBuf,
    pub rules: Vec<PermissionRule>,
    pub skipped: Vec<String>,
    pub grants_path: PathBuf,
    pub grants: GrantStore,
}

pub fn compile_policy_json(policy: &PermissionPolicy) -> JsonValue {
    json!({
        "mode": policy.mode.as_str(),
        "modeSource": policy.mode_source,
        "alwaysApproveLocked": policy.always_approve_locked,
        "lockSource": policy.lock_source,
        "rememberToolApprovals": policy.remember_tool_approvals,
        "rememberSource": policy.remember_source,
        "interactive": policy.interactive,
        "cwd": policy.cwd,
        "grantsPath": policy.grants_path,
        "skipped": policy.skipped,
        "rules": policy.rules.iter().map(|rule| json!({
            "action": rule.action.as_str(),
            "tool": rule.tool.as_str(),
            "pattern": rule.pattern,
            "patternMode": match rule.pattern_mode {
                PatternMode::Glob => "glob",
                PatternMode::Domain => "domain",
            },
            "source": rule.source,
        })).collect::<Vec<_>>(),
        "grants": {
            "allowedBash": policy.grants.allowed_bash,
            "deniedBash": policy.grants.denied_bash,
            "allowedMcp": policy.grants.allowed_mcp,
            "deniedMcp": policy.grants.denied_mcp,
            "allowedDomains": policy.grants.allowed_domains,
            "deniedDomains": policy.grants.denied_domains,
            "allowedEdits": policy.grants.allowed_edits,
        }
    })
}

pub fn write_policy_file(dsh_home: &Path, policy: &PermissionPolicy) -> io::Result<PathBuf> {
    let path = dsh_home.join(POLICY_FILE_NAME);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, format!("{}\n", compile_policy_json(policy)))?;
    Ok(path)
}

pub fn grants_path(grok_home: &Path, workspace_key: &Path) -> PathBuf {
    grok_home
        .join("sessions")
        .join(encode_scope(workspace_key))
        .join(GRANTS_FILE_NAME)
}

fn encode_scope(path: &Path) -> String {
    path.to_string_lossy()
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

pub fn load_grants(path: &Path) -> GrantStore {
    let Ok(text) = fs::read_to_string(path) else {
        return GrantStore::default();
    };
    let Ok(value) = toml::from_str::<TomlValue>(&text) else {
        return GrantStore::default();
    };
    GrantStore {
        allowed_bash: string_array(&value, "allowed_bash_commands"),
        denied_bash: string_array(&value, "disallowed_bash_commands"),
        allowed_mcp: string_array(&value, "allowed_mcp_tools"),
        denied_mcp: string_array(&value, "disallowed_mcp_tools"),
        allowed_domains: string_array(&value, "allowed_web_fetch_domains"),
        denied_domains: string_array(&value, "disallowed_web_fetch_domains"),
        allowed_edits: value
            .get("allow_edits_for_session")
            .and_then(TomlValue::as_bool)
            .unwrap_or(false),
    }
}

fn string_array(value: &TomlValue, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(TomlValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(TomlValue::as_str)
        .map(str::to_string)
        .collect()
}

pub fn persist_grants(path: &Path, grants: &GrantStore) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            ErrorKind::InvalidInput,
            "permission grant path has no parent",
        )
    })?;
    fs::create_dir_all(parent)?;
    let mut body = String::from("# remembered permission grants (this project only)\n");
    fn write_list(body: &mut String, key: &str, items: &[String]) {
        body.push_str(key);
        body.push_str(" = [");
        for (index, item) in items.iter().enumerate() {
            if index > 0 {
                body.push_str(", ");
            }
            body.push_str(&toml_quote(item));
        }
        body.push_str("]\n");
    }
    write_list(&mut body, "allowed_bash_commands", &grants.allowed_bash);
    write_list(&mut body, "disallowed_bash_commands", &grants.denied_bash);
    write_list(&mut body, "allowed_mcp_tools", &grants.allowed_mcp);
    write_list(&mut body, "disallowed_mcp_tools", &grants.denied_mcp);
    write_list(
        &mut body,
        "allowed_web_fetch_domains",
        &grants.allowed_domains,
    );
    write_list(
        &mut body,
        "disallowed_web_fetch_domains",
        &grants.denied_domains,
    );
    body.push_str(&format!(
        "allow_edits_for_session = {}\n",
        grants.allowed_edits
    ));
    let temp = parent.join(format!(".{GRANTS_FILE_NAME}.tmp"));
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(body.as_bytes())?;
        file.flush()?;
    }
    fs::rename(&temp, path)?;
    Ok(())
}

fn toml_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn remember_prefix(command: &str) -> String {
    let words: Vec<&str> = command.split_whitespace().collect();
    if words.is_empty() {
        return command.trim().to_string();
    }
    if is_dangerous_command(&words) || is_exec_vehicle(words[0]) {
        return words.join(" ");
    }
    if is_readonly_command(&words) {
        if matches!(words[0], "git" | "kubectl") && words.len() >= 2 {
            return words[..2].join(" ");
        }
        return words[0].to_string();
    }
    words.iter().take(2).copied().collect::<Vec<_>>().join(" ")
}

pub fn parse_permission_rule(
    rule: &str,
    action: RuleAction,
    source: &str,
) -> Result<PermissionRule, String> {
    let rule = rule.trim();
    if rule.is_empty() {
        return Err("empty permission rule".into());
    }
    if let Some(open) = find_unescaped(rule, b'(') {
        let prefix = rule[..open].trim();
        let rest = &rule[open + 1..];
        let close =
            find_last_unescaped(rest, b')').ok_or_else(|| format!("malformed rule: {rule}"))?;
        let content = unescape(&rest[..close]).trim().to_string();
        if matches!(prefix, "EnterWorktree" | "NotebookEdit" | "NotebookRead") {
            return Err(format!("unsupported tool prefix: {prefix}"));
        }
        let tool = ToolFilter::parse_name(prefix)
            .ok_or_else(|| format!("unknown tool prefix: {prefix}"))?;
        let content = if tool == ToolFilter::Bash {
            content
                .strip_suffix(":*")
                .map(str::to_string)
                .unwrap_or(content)
        } else {
            content
        };
        let (pattern, pattern_mode) = if let Some(domain) = content.strip_prefix("domain:") {
            (domain.to_string(), PatternMode::Domain)
        } else {
            (content, PatternMode::Glob)
        };
        let pattern = if pattern.is_empty() || pattern == "*" {
            None
        } else {
            Some(pattern)
        };
        return Ok(PermissionRule {
            action,
            tool,
            pattern,
            pattern_mode,
            source: source.into(),
        });
    }
    if matches!(rule, "EnterWorktree" | "NotebookEdit" | "NotebookRead") {
        return Err(format!("unsupported tool prefix: {rule}"));
    }
    if let Some(tool) = ToolFilter::parse_name(rule) {
        return Ok(PermissionRule {
            action,
            tool,
            pattern: None,
            pattern_mode: PatternMode::Glob,
            source: source.into(),
        });
    }
    if let Some(rest) = rule.strip_prefix("mcp__") {
        if rest.is_empty() {
            return Err("unknown tool prefix: mcp__".into());
        }
        let pattern = if rest == "*" {
            None
        } else if rest.contains("__") {
            Some(rest.to_string())
        } else {
            Some(format!("{rest}__*"))
        };
        return Ok(PermissionRule {
            action,
            tool: ToolFilter::Mcp,
            pattern,
            pattern_mode: PatternMode::Glob,
            source: source.into(),
        });
    }
    Ok(PermissionRule {
        action,
        tool: ToolFilter::Any,
        pattern: Some(rule.to_string()),
        pattern_mode: PatternMode::Glob,
        source: source.into(),
    })
}

fn find_unescaped(text: &str, target: u8) -> Option<usize> {
    let bytes = text.as_bytes();
    bytes
        .iter()
        .enumerate()
        .find_map(|(index, byte)| (*byte == target && is_unescaped(bytes, index)).then_some(index))
}

fn find_last_unescaped(text: &str, target: u8) -> Option<usize> {
    let bytes = text.as_bytes();
    (0..bytes.len())
        .rev()
        .find(|&index| bytes[index] == target && is_unescaped(bytes, index))
}

fn is_unescaped(bytes: &[u8], pos: usize) -> bool {
    let mut count = 0usize;
    let mut index = pos;
    while index > 0 && bytes[index - 1] == b'\\' {
        count += 1;
        index -= 1;
    }
    count.is_multiple_of(2)
}

fn unescape(text: &str) -> String {
    text.replace("\\(", "(")
        .replace("\\)", ")")
        .replace("\\\\", "\\")
}

pub fn extract_toml_rules(
    table: &TomlValue,
    source: &str,
    skipped: &mut Vec<String>,
) -> Vec<PermissionRule> {
    let Some(section) = table.get("permission") else {
        return Vec::new();
    };
    let mut rules = Vec::new();
    let mut compact = false;
    for (action, key) in [
        (RuleAction::Deny, "deny"),
        (RuleAction::Ask, "ask"),
        (RuleAction::Allow, "allow"),
    ] {
        let Some(value) = section.get(key) else {
            continue;
        };
        compact = true;
        let Some(items) = value.as_array() else {
            skipped.push(format!(
                "{source}: permission.{key} must be an array of rule strings"
            ));
            continue;
        };
        for (index, item) in items.iter().enumerate() {
            match item.as_str() {
                Some(rule) => match parse_permission_rule(rule, action, source) {
                    Ok(parsed) => rules.push(parsed),
                    Err(error) => {
                        skipped.push(format!("{source} permission.{key}[{index}]: {error}"))
                    }
                },
                None => skipped.push(format!(
                    "{source} permission.{key}[{index}] is not a string"
                )),
            }
        }
    }
    if compact {
        return rules;
    }
    if let Some(items) = section.get("rules").and_then(TomlValue::as_array) {
        for (index, item) in items.iter().enumerate() {
            let Some(row) = item.as_table() else {
                skipped.push(format!("{source} permission.rules[{index}] is not a table"));
                continue;
            };
            let action = match row.get("action").and_then(TomlValue::as_str) {
                Some("allow") => RuleAction::Allow,
                Some("ask") => RuleAction::Ask,
                Some("deny") | None => RuleAction::Deny,
                Some(other) => {
                    skipped.push(format!(
                        "{source} permission.rules[{index}] unknown action {other}"
                    ));
                    continue;
                }
            };
            let tool = match row
                .get("tool")
                .and_then(TomlValue::as_str)
                .and_then(ToolFilter::parse_name)
            {
                Some(tool) => tool,
                None => {
                    skipped.push(format!("{source} permission.rules[{index}] unknown tool"));
                    continue;
                }
            };
            rules.push(PermissionRule {
                action,
                tool,
                pattern: row
                    .get("pattern")
                    .and_then(TomlValue::as_str)
                    .map(str::to_string)
                    .filter(|value| !value.is_empty() && value != "*"),
                pattern_mode: PatternMode::Glob,
                source: source.into(),
            });
        }
    }
    rules
}

pub fn extract_claude_rules(
    value: &JsonValue,
    source: &str,
    skipped: &mut Vec<String>,
) -> (Vec<PermissionRule>, Option<PermissionMode>) {
    let permissions = value.get("permissions");
    let mut rules = Vec::new();
    if let Some(permissions) = permissions {
        for (action, key) in [
            (RuleAction::Deny, "deny"),
            (RuleAction::Ask, "ask"),
            (RuleAction::Allow, "allow"),
        ] {
            if let Some(items) = permissions.get(key).and_then(JsonValue::as_array) {
                for (index, item) in items.iter().enumerate() {
                    match item.as_str() {
                        Some(rule) => match parse_permission_rule(rule, action, source) {
                            Ok(parsed) => rules.push(parsed),
                            Err(error) => skipped.push(format!("{source} {key}[{index}]: {error}")),
                        },
                        None => skipped.push(format!("{source} {key}[{index}] is not a string")),
                    }
                }
            }
        }
    }
    let mode_raw = permissions
        .and_then(|value| value.get("defaultMode"))
        .or_else(|| value.get("defaultMode"))
        .and_then(JsonValue::as_str);
    let mode = match mode_raw {
        Some(raw) => match PermissionMode::parse(raw) {
            Ok(mode) => Some(mode),
            Err(_) => {
                skipped.push(format!(
                    "{source}: unrecognized defaultMode {raw}; treated as ask"
                ));
                Some(PermissionMode::Ask)
            }
        },
        None => None,
    };
    (rules, mode)
}

pub fn access_from_tool(name: &str, args: &JsonValue) -> AccessKind {
    let path = string_field(args, &["file_path", "filePath", "path", "target_directory"]);
    match name {
        "read" | "read_file" | "list_dir" | "read_image" => AccessKind::Read(path),
        "grep" | "glob" => AccessKind::Grep { path },
        "write" | "edit" | "search_replace" => AccessKind::Edit(path.unwrap_or_default()),
        "bash" | "run_terminal_cmd" | "run_terminal_command" => {
            AccessKind::Bash(string_field(args, &["command"]).unwrap_or_default())
        }
        "web_fetch" => AccessKind::WebFetch(string_field(args, &["url"]).unwrap_or_default()),
        "web_search" => AccessKind::WebSearch(
            string_field(args, &["query"])
                .or_else(|| {
                    args.get("queries")
                        .and_then(JsonValue::as_array)
                        .and_then(|items| items.first())
                        .and_then(JsonValue::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default(),
        ),
        "todo_write" | "skill" => AccessKind::Read(None),
        other if other.contains("__") => AccessKind::Mcp { name: other.into() },
        other => {
            if path.is_some()
                && (args.get("old_string").is_some()
                    || args.get("new_string").is_some()
                    || args.get("content").is_some())
            {
                AccessKind::Edit(path.unwrap_or_default())
            } else if let Some(command) = string_field(args, &["command"]) {
                AccessKind::Bash(command)
            } else {
                AccessKind::Tool(other.into())
            }
        }
    }
}

fn string_field(value: &JsonValue, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(JsonValue::as_str))
        .map(str::to_string)
}

pub fn evaluate(
    policy: &PermissionPolicy,
    access: &AccessKind,
    hook_deny: Option<&str>,
) -> Decision {
    if let Some(reason) = hook_deny.filter(|value| !value.is_empty()) {
        return Decision::Deny {
            reason: format!("Denied by hook: {reason}"),
        };
    }
    if let Some(decision) = evaluate_rules(policy, access) {
        match decision {
            Decision::Deny { .. } => return decision,
            Decision::Ask { .. } => {
                if let Some(grant) = evaluate_grants(policy, access) {
                    return grant;
                }
                return decision;
            }
            Decision::Allow { .. } => return decision,
        }
    }
    if policy.mode != PermissionMode::AlwaysApprove
        && let Some(grant) = evaluate_grants(policy, access)
    {
        return grant;
    }
    if is_readonly_access(access) {
        return Decision::Allow {
            reason: "read-only tool".into(),
        };
    }
    if let AccessKind::Bash(command) = access
        && bash_segments(command)
            .iter()
            .all(|segment| is_readonly_command(&segment.split_whitespace().collect::<Vec<_>>()))
        && bash_segments(command)
            .iter()
            .all(|segment| !is_dangerous_command(&segment.split_whitespace().collect::<Vec<_>>()))
    {
        return Decision::Allow {
            reason: "read-only shell command".into(),
        };
    }
    match policy.mode {
        PermissionMode::AlwaysApprove => Decision::Allow {
            reason: "always-approve".into(),
        },
        PermissionMode::AcceptEdits if matches!(access, AccessKind::Edit(_)) => Decision::Allow {
            reason: "acceptEdits".into(),
        },
        PermissionMode::DontAsk => Decision::Deny {
            reason: "dontAsk blocked this action; it is not on the allow list".into(),
        },
        PermissionMode::Auto if !policy.interactive => Decision::Deny {
            reason: "Auto mode blocked this action (no classifier available; refusing rather than unconfined auto-allow).".into(),
        },
        PermissionMode::Auto | PermissionMode::Ask | PermissionMode::AcceptEdits => Decision::Ask {
            reason: format!("permission mode {}", policy.mode.as_str()),
        },
    }
}

fn evaluate_rules(policy: &PermissionPolicy, access: &AccessKind) -> Option<Decision> {
    if let AccessKind::Bash(command) = access {
        let mut ask = None;
        for segment in bash_policy_subjects(command) {
            match evaluate_rules_for(policy, &AccessKind::Bash(segment)) {
                Some(Decision::Deny { reason }) => {
                    return Some(Decision::Deny { reason });
                }
                Some(Decision::Ask { reason }) => ask = Some(Decision::Ask { reason }),
                _ => {}
            }
        }
        if let Some(ask) = ask {
            return Some(ask);
        }
        if policy.rules.iter().any(|rule| {
            rule.action == RuleAction::Allow
                && matches!(rule.tool, ToolFilter::Bash | ToolFilter::Any)
        }) && bash_chain_allowed(policy, command)
        {
            return Some(Decision::Allow {
                reason: "allow rule".into(),
            });
        }
        return None;
    }
    evaluate_rules_for(policy, access)
}

fn evaluate_rules_for(policy: &PermissionPolicy, access: &AccessKind) -> Option<Decision> {
    let mut matched_ask = false;
    let mut matched_allow = false;
    for rule in &policy.rules {
        if !rule_reaches(access, rule) || !pattern_matches(access, rule, &policy.cwd) {
            continue;
        }
        match rule.action {
            RuleAction::Deny => {
                let pattern = rule.pattern.as_deref().unwrap_or("*");
                return Some(Decision::Deny {
                    reason: format!(
                        "Denied by permission policy: deny rule on {} matching \"{pattern}\"",
                        rule.tool.as_str()
                    ),
                });
            }
            RuleAction::Ask => matched_ask = true,
            RuleAction::Allow => matched_allow = true,
        }
    }
    if matched_ask {
        return Some(Decision::Ask {
            reason: "ask rule".into(),
        });
    }
    if matched_allow && !matches!(access, AccessKind::Bash(_)) {
        return Some(Decision::Allow {
            reason: "allow rule".into(),
        });
    }
    None
}

fn bash_chain_allowed(policy: &PermissionPolicy, command: &str) -> bool {
    let segments = bash_segments(command);
    if segments.is_empty() {
        return false;
    }
    segments.iter().all(|segment| {
        let trimmed = segment.trim_start();
        policy.rules.iter().any(|rule| {
            rule.action == RuleAction::Allow
                && matches!(rule.tool, ToolFilter::Bash | ToolFilter::Any)
                && bash_allow_matches(trimmed, rule)
        })
    })
}

fn bash_policy_subjects(command: &str) -> Vec<String> {
    let mut subjects = vec![command.trim_start().to_string()];
    subjects.extend(bash_segments(command));
    subjects
}

fn evaluate_grants(policy: &PermissionPolicy, access: &AccessKind) -> Option<Decision> {
    match access {
        AccessKind::Bash(command) => {
            let subjects = bash_policy_subjects(command);
            if let Some(denied) = policy.grants.denied_bash.iter().find(|prefix| {
                subjects
                    .iter()
                    .any(|subject| matches_command_prefix(subject.trim_start(), prefix))
            }) {
                return Some(Decision::Deny {
                    reason: format!("User previously rejected `{denied}` in this project"),
                });
            }
            if !policy.remember_tool_approvals {
                return None;
            }
            if subjects.iter().any(|subject| {
                let words: Vec<&str> = subject.split_whitespace().collect();
                is_dangerous_command(&words)
                    && !policy
                        .grants
                        .allowed_bash
                        .iter()
                        .any(|grant| grant == subject.trim_start())
            }) {
                return None;
            }
            if bash_segments(command).iter().all(|segment| {
                let trimmed = segment.trim_start();
                policy
                    .grants
                    .allowed_bash
                    .iter()
                    .any(|grant| matches_command_prefix(trimmed, grant) || trimmed == grant)
            }) {
                return Some(Decision::Allow {
                    reason: "remembered project grant".into(),
                });
            }
            None
        }
        AccessKind::Mcp { name } => {
            if policy.grants.denied_mcp.iter().any(|denied| denied == name) {
                return Some(Decision::Deny {
                    reason: format!("User previously rejected `{name}` in this project"),
                });
            }
            if policy.remember_tool_approvals
                && policy
                    .grants
                    .allowed_mcp
                    .iter()
                    .any(|allowed| allowed == name)
            {
                return Some(Decision::Allow {
                    reason: "remembered project grant".into(),
                });
            }
            None
        }
        AccessKind::WebFetch(url) => {
            if let Some(host) = url_host(url) {
                if let Some(denied) = policy
                    .grants
                    .denied_domains
                    .iter()
                    .find(|denied| domain_covers(denied, &host))
                {
                    return Some(Decision::Deny {
                        reason: format!("User previously rejected `{denied}` in this project"),
                    });
                }
                if policy.remember_tool_approvals
                    && policy
                        .grants
                        .allowed_domains
                        .iter()
                        .any(|allowed| domain_covers(allowed, &host))
                {
                    return Some(Decision::Allow {
                        reason: "remembered project grant".into(),
                    });
                }
            }
            None
        }
        AccessKind::Edit(_) if policy.grants.allowed_edits => Some(Decision::Allow {
            reason: "allow all edits this session".into(),
        }),
        _ => None,
    }
}

fn rule_reaches(access: &AccessKind, rule: &PermissionRule) -> bool {
    match rule.tool {
        ToolFilter::Any => true,
        ToolFilter::Bash => matches!(access, AccessKind::Bash(_)),
        ToolFilter::Edit => matches!(access, AccessKind::Edit(_) | AccessKind::Tool(_)),
        ToolFilter::Read => matches!(access, AccessKind::Read(_) | AccessKind::Grep { .. }),
        ToolFilter::Grep => matches!(access, AccessKind::Grep { .. }),
        ToolFilter::Mcp => matches!(access, AccessKind::Mcp { .. }),
        ToolFilter::WebFetch => matches!(access, AccessKind::WebFetch(_)),
        ToolFilter::WebSearch => matches!(access, AccessKind::WebSearch(_)),
    }
}

fn pattern_matches(access: &AccessKind, rule: &PermissionRule, cwd: &Path) -> bool {
    let Some(pattern) = rule.pattern.as_deref() else {
        return true;
    };
    if pattern == "*" {
        return true;
    }
    match access {
        AccessKind::Bash(command) => {
            let command = command.trim_start();
            command.starts_with(pattern) || glob_match(pattern, command, false)
        }
        AccessKind::Edit(path) | AccessKind::Read(Some(path)) => path_matches(pattern, path, cwd),
        AccessKind::Grep { path: Some(path) } => path_matches(pattern, path, cwd),
        AccessKind::Read(None) | AccessKind::Grep { path: None } => false,
        AccessKind::Mcp { name } => glob_match(pattern, name, false),
        AccessKind::WebFetch(url) => match rule.pattern_mode {
            PatternMode::Domain => url_host(url).is_some_and(|host| domain_covers(pattern, &host)),
            PatternMode::Glob => glob_match(pattern, url, false),
        },
        AccessKind::WebSearch(query) => {
            glob_match(pattern, query, false) || query.starts_with(pattern)
        }
        AccessKind::Tool(name) => {
            if rule.tool == ToolFilter::Edit && rule.pattern.is_some() {
                return false;
            }
            glob_match(pattern, name, false) || name.starts_with(pattern)
        }
    }
}

fn bash_allow_matches(command: &str, rule: &PermissionRule) -> bool {
    match rule.pattern.as_deref() {
        None | Some("*") => true,
        Some(pattern) => {
            matches_command_prefix(command, pattern) || glob_match(pattern, command, false)
        }
    }
}

fn path_matches(pattern: &str, path: &str, cwd: &Path) -> bool {
    path_forms(path, cwd)
        .iter()
        .any(|form| glob_match(pattern, form, true))
}

fn path_forms(path: &str, cwd: &Path) -> Vec<String> {
    let raw = Path::new(path);
    if is_tilde_path(raw) {
        return vec![path.replace('\\', "/")];
    }
    let joined = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        cwd.join(raw)
    };
    let abs = normalize_lexically(&joined);
    let mut forms = vec![path_text(&abs)];
    if let Ok(rel) = abs.strip_prefix(normalize_lexically(cwd)) {
        let rel_text = path_text(rel);
        if rel_text.is_empty() || rel_text == "." {
            forms.extend([".".into(), "./".into()]);
        } else {
            forms.push(format!("./{rel_text}"));
            forms.push(rel_text);
        }
    }
    forms
}

fn is_tilde_path(path: &Path) -> bool {
    matches!(
        path.components().next(),
        Some(Component::Normal(first)) if first.to_string_lossy().starts_with('~')
    )
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let _ = out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn glob_match(pattern: &str, text: &str, path_mode: bool) -> bool {
    glob_match_inner(pattern.as_bytes(), text.as_bytes(), path_mode)
}

fn glob_match_inner(pattern: &[u8], text: &[u8], path_mode: bool) -> bool {
    let mut p = 0usize;
    let mut t = 0usize;
    while p < pattern.len() {
        match pattern[p] {
            b'*' if p + 1 < pattern.len() && pattern[p + 1] == b'*' => {
                let rest = if p + 2 < pattern.len() && pattern[p + 2] == b'/' {
                    p + 3
                } else {
                    p + 2
                };
                if glob_match_inner(&pattern[rest..], &text[t..], path_mode) {
                    return true;
                }
                if t < text.len() {
                    t += 1;
                    continue;
                }
                return false;
            }
            b'*' => {
                let next = p + 1;
                if glob_match_inner(&pattern[next..], &text[t..], path_mode) {
                    return true;
                }
                if t < text.len() && !(path_mode && text[t] == b'/') {
                    t += 1;
                    continue;
                }
                return false;
            }
            b'?' => {
                if t >= text.len() || (path_mode && text[t] == b'/') {
                    return false;
                }
                p += 1;
                t += 1;
            }
            b'[' => {
                let Some((consumed, ok)) = class_match(&pattern[p..], text.get(t).copied()) else {
                    return false;
                };
                if !ok {
                    return false;
                }
                p += consumed;
                t += 1;
            }
            byte => {
                if text.get(t) != Some(&byte) {
                    return false;
                }
                p += 1;
                t += 1;
            }
        }
    }
    t == text.len()
}

fn class_match(pattern: &[u8], candidate: Option<u8>) -> Option<(usize, bool)> {
    let candidate = candidate?;
    let mut index = 1usize;
    let negate = pattern.get(index) == Some(&b'!') || pattern.get(index) == Some(&b'^');
    if negate {
        index += 1;
    }
    let mut matched = false;
    while index < pattern.len() && pattern[index] != b']' {
        if index + 2 < pattern.len() && pattern[index + 1] == b'-' && pattern[index + 2] != b']' {
            let start = pattern[index];
            let end = pattern[index + 2];
            if candidate >= start && candidate <= end {
                matched = true;
            }
            index += 3;
        } else {
            if pattern[index] == candidate {
                matched = true;
            }
            index += 1;
        }
    }
    if index >= pattern.len() || pattern[index] != b']' {
        return None;
    }
    Some((index + 1, if negate { !matched } else { matched }))
}

pub fn bash_segments(command: &str) -> Vec<String> {
    if command.contains("$(")
        || command.contains('`')
        || command.contains("$(")
        || has_unquoted(&['(', ')'], command)
    {
        return vec![command.trim().to_string()];
    }
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut chars = command.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(ch) = chars.next() {
        if quote == Some(ch) {
            quote = None;
            current.push(ch);
            continue;
        }
        if quote.is_none() && (ch == '\'' || ch == '"') {
            quote = Some(ch);
            current.push(ch);
            continue;
        }
        if quote.is_none() {
            if ch == '&' && chars.peek() == Some(&'&') {
                chars.next();
                push_segment(&mut segments, &mut current);
                continue;
            }
            if ch == '|' && chars.peek() == Some(&'|') {
                chars.next();
                push_segment(&mut segments, &mut current);
                continue;
            }
            if ch == '|' || ch == ';' || ch == '\n' {
                push_segment(&mut segments, &mut current);
                continue;
            }
        }
        current.push(ch);
    }
    push_segment(&mut segments, &mut current);
    segments
}

fn has_unquoted(needles: &[char], text: &str) -> bool {
    let mut quote: Option<char> = None;
    for ch in text.chars() {
        if quote == Some(ch) {
            quote = None;
            continue;
        }
        if quote.is_none() && (ch == '\'' || ch == '"') {
            quote = Some(ch);
            continue;
        }
        if quote.is_none() && needles.contains(&ch) {
            return true;
        }
    }
    false
}

fn push_segment(segments: &mut Vec<String>, current: &mut String) {
    let trimmed = current.trim();
    if !trimmed.is_empty() {
        segments.push(strip_env_and_wrappers(trimmed));
    }
    current.clear();
}

fn strip_env_and_wrappers(command: &str) -> String {
    let mut words: Vec<String> = command.split_whitespace().map(str::to_string).collect();
    while words
        .first()
        .is_some_and(|word| word.contains('=') && !word.starts_with('-'))
    {
        words.remove(0);
    }
    const WRAPPERS: &[&str] = &[
        "timeout", "nice", "ionice", "chrt", "stdbuf", "env", "command",
    ];
    while let Some(head) = words.first().cloned() {
        let base = Path::new(&head)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(head.as_str())
            .to_string();
        if !WRAPPERS.contains(&base.as_str()) {
            break;
        }
        words.remove(0);
        while words.first().is_some_and(|word| word.starts_with('-')) {
            let flag = words.remove(0);
            if !flag.contains('=')
                && words.first().is_some_and(|word| {
                    !word.starts_with('-') && !WRAPPERS.contains(&word.as_str())
                })
                && matches!(
                    base.as_str(),
                    "timeout" | "nice" | "ionice" | "chrt" | "stdbuf"
                )
            {
                words.remove(0);
            }
        }
    }
    words.join(" ")
}

fn matches_command_prefix(command: &str, pattern: &str) -> bool {
    command == pattern
        || (command.starts_with(pattern) && command.as_bytes().get(pattern.len()) == Some(&b' '))
}

fn is_readonly_access(access: &AccessKind) -> bool {
    matches!(
        access,
        AccessKind::Read(_) | AccessKind::Grep { .. } | AccessKind::WebSearch(_)
    )
}

fn is_readonly_command(words: &[&str]) -> bool {
    if words.is_empty() {
        return false;
    }
    let head = words[0];
    if matches!(
        head,
        "ls" | "cat"
            | "pwd"
            | "date"
            | "whoami"
            | "hostname"
            | "uptime"
            | "ps"
            | "head"
            | "tail"
            | "wc"
            | "sort"
            | "uniq"
            | "tr"
            | "cut"
            | "grep"
            | "rg"
    ) {
        return true;
    }
    if head == "git" && words.len() >= 2 {
        return matches!(
            words[1],
            "status"
                | "branch"
                | "log"
                | "diff"
                | "ls-files"
                | "show"
                | "rev-parse"
                | "blame"
                | "describe"
                | "merge-base"
                | "shortlog"
        );
    }
    if head == "kubectl" && words.len() >= 2 {
        return matches!(words[1], "get" | "logs" | "describe");
    }
    false
}

fn is_dangerous_command(words: &[&str]) -> bool {
    let Some(head) = words.first() else {
        return false;
    };
    let base = Path::new(head)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(head)
        .trim_end_matches(".exe")
        .to_ascii_lowercase();
    if matches!(
        base.as_str(),
        "rm" | "chmod" | "chown" | "chgrp" | "chattr" | "pkill" | "kill" | "killall"
    ) {
        return true;
    }
    base == "git" && words.get(1).is_some_and(|word| *word == "push")
}

fn is_exec_vehicle(head: &str) -> bool {
    let base = Path::new(head)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(head)
        .trim_end_matches(".exe")
        .to_ascii_lowercase();
    matches!(
        base.as_str(),
        "sh" | "bash" | "zsh" | "python" | "python3" | "node" | "sudo" | "ssh" | "docker" | "npx"
    )
}

fn url_host(url: &str) -> Option<String> {
    let rest = url
        .split("://")
        .nth(1)
        .unwrap_or(url)
        .split(['/', '?', '#'])
        .next()?;
    let host = rest
        .rsplit('@')
        .next()?
        .split('%')
        .next()?
        .trim_end_matches('.')
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    let host = host.split(':').next()?.to_string();
    (!host.is_empty()).then_some(host)
}

fn domain_covers(pattern: &str, host: &str) -> bool {
    let pattern = pattern
        .trim_start_matches("www.")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    host == pattern || host.ends_with(&format!(".{pattern}"))
}

pub fn is_catchall_allow(rule: &PermissionRule) -> bool {
    rule.action == RuleAction::Allow
        && !matches!(
            rule.tool,
            ToolFilter::Read | ToolFilter::Edit | ToolFilter::Grep
        )
        && rule.pattern.is_none()
}

pub fn always_approve_lock(requirements: Option<&TomlValue>) -> Option<String> {
    let ui = requirements?.get("ui")?;
    if ui
        .get("disable_bypass_permissions_mode")
        .and_then(TomlValue::as_bool)
        == Some(true)
    {
        return Some(
            "always-approve disabled by managed policy ([ui] disable_bypass_permissions_mode = true in requirements.toml)"
                .into(),
        );
    }
    if ui.get("yolo").and_then(TomlValue::as_bool) == Some(false) {
        return Some(
            "always-approve disabled by managed policy ([ui] yolo = false in requirements.toml)"
                .into(),
        );
    }
    None
}

pub fn parse_bool(value: Option<&TomlValue>) -> Option<bool> {
    match value? {
        TomlValue::Boolean(flag) => Some(*flag),
        TomlValue::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

pub fn resolve_mode(
    cli_mode: Option<&str>,
    cli_always_approve: bool,
    cli_auto: bool,
    env_mode: Option<&str>,
    user: Option<&TomlValue>,
    managed: Option<&TomlValue>,
    requirements: Option<&TomlValue>,
    claude_mode: Option<PermissionMode>,
    lock: Option<&str>,
) -> Result<(PermissionMode, String), String> {
    let mut mode = PermissionMode::Ask;
    let mut source = "default".to_string();
    if let Some(raw) = toml_mode(managed) {
        mode = PermissionMode::parse(raw)?;
        source = "managed".into();
    }
    if let Some(raw) = toml_mode(user) {
        mode = PermissionMode::parse(raw)?;
        source = "config.toml".into();
    }
    if let Some(claude) = claude_mode {
        mode = claude;
        source = "claude".into();
    }
    if let Some(raw) = env_mode.filter(|value| !value.is_empty()) {
        mode = PermissionMode::parse(raw)?;
        source = "environment".into();
    }
    if cli_auto {
        mode = PermissionMode::Auto;
        source = "cli".into();
    }
    if let Some(raw) = cli_mode {
        mode = PermissionMode::parse(raw)?;
        source = "cli".into();
    }
    if cli_always_approve {
        mode = PermissionMode::AlwaysApprove;
        source = "cli".into();
    }
    if let Some(raw) = toml_mode(requirements) {
        mode = PermissionMode::parse(raw)?;
        source = "requirements".into();
    }
    if mode == PermissionMode::AlwaysApprove
        && let Some(lock) = lock
    {
        if source == "cli" || source == "environment" {
            return Err(lock.to_string());
        }
        mode = PermissionMode::Ask;
        source = "requirements".into();
    }
    Ok((mode, source))
}

fn toml_mode(table: Option<&TomlValue>) -> Option<&str> {
    table?
        .get("ui")
        .and_then(|ui| {
            ui.get("permission_mode")
                .or_else(|| ui.get("approval_mode"))
        })
        .and_then(TomlValue::as_str)
}

pub fn remember_enabled(
    env: Option<&str>,
    user: Option<&TomlValue>,
    managed: Option<&TomlValue>,
    requirements: Option<&TomlValue>,
) -> (bool, String) {
    if let Some(value) = parse_bool(
        requirements
            .and_then(|table| table.get("ui"))
            .and_then(|ui| ui.get("remember_tool_approvals")),
    ) {
        return (value, "requirements".into());
    }
    if let Some(raw) = env {
        match raw.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => return (true, "environment".into()),
            "0" | "false" | "no" | "off" => return (false, "environment".into()),
            _ => {}
        }
    }
    if let Some(value) = parse_bool(
        user.and_then(|table| table.get("ui"))
            .and_then(|ui| ui.get("remember_tool_approvals")),
    ) {
        return (value, "config.toml".into());
    }
    if let Some(value) = parse_bool(
        managed
            .and_then(|table| table.get("ui"))
            .and_then(|ui| ui.get("remember_tool_approvals")),
    ) {
        return (value, "managed".into());
    }
    (true, "default".into())
}

pub fn prompt_lines(
    access: &AccessKind,
    remember: bool,
    persist_ok: bool,
) -> (String, Vec<&'static str>) {
    let subject = match access {
        AccessKind::Bash(command) => format!("bash `{command}`"),
        AccessKind::Edit(path) => format!("edit `{path}`"),
        AccessKind::Read(Some(path)) => format!("read `{path}`"),
        AccessKind::Read(None) => "read".into(),
        AccessKind::Grep { path } => format!("grep {}", path.clone().unwrap_or_else(|| ".".into())),
        AccessKind::Mcp { name } => format!("MCP `{name}`"),
        AccessKind::WebFetch(url) => format!("fetch `{url}`"),
        AccessKind::WebSearch(query) => format!("search `{query}`"),
        AccessKind::Tool(name) => name.clone(),
    };
    let mut options = vec!["y=allow once", "n=reject"];
    if remember {
        options.insert(1, "a=always allow this project");
    }
    let mut line = format!("Allow {subject}? {}", options.join("  "));
    if remember && persist_ok {
        if let AccessKind::Bash(command) = access {
            line.push_str(&format!(
                "\nAlways allow prefix `{}` is this project only; y is once, not a permanent rule.",
                remember_prefix(command)
            ));
        } else {
            line.push_str("\ny allows this call once; a remembers it for this project only.");
        }
    }
    if !persist_ok {
        line.push_str("\nCouldn't save a permanent rule; this allow is once.");
    }
    (line, options)
}

pub fn workspace_grants_path(grok_home: &Path, cwd: &Path, home: &Path) -> PathBuf {
    grants_path(grok_home, &trust::workspace_key(cwd, home))
}

pub fn record_grant(path: &Path, access: &AccessKind, allow: bool) -> io::Result<GrantStore> {
    let mut grants = load_grants(path);
    match access {
        AccessKind::Bash(command) => {
            let prefix = remember_prefix(command);
            if allow {
                if !grants.allowed_bash.iter().any(|item| item == &prefix) {
                    grants.allowed_bash.push(prefix);
                }
            } else if !grants.denied_bash.iter().any(|item| item == &prefix) {
                grants.denied_bash.push(prefix);
            }
        }
        AccessKind::Mcp { name } => {
            if allow {
                if !grants.allowed_mcp.iter().any(|item| item == name) {
                    grants.allowed_mcp.push(name.clone());
                }
            } else if !grants.denied_mcp.iter().any(|item| item == name) {
                grants.denied_mcp.push(name.clone());
            }
        }
        AccessKind::WebFetch(url) => {
            if let Some(host) = url_host(url) {
                if allow {
                    if !grants.allowed_domains.iter().any(|item| item == &host) {
                        grants.allowed_domains.push(host);
                    }
                } else if !grants.denied_domains.iter().any(|item| item == &host) {
                    grants.denied_domains.push(host);
                }
            }
        }
        AccessKind::Edit(_) => {
            if allow {
                grants.allowed_edits = true;
            }
        }
        AccessKind::Read(_)
        | AccessKind::Grep { .. }
        | AccessKind::WebSearch(_)
        | AccessKind::Tool(_) => {}
    }
    persist_grants(path, &grants)?;
    Ok(grants)
}

pub fn clear_grants(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn drop_locked_catchalls(
    rules: Vec<PermissionRule>,
    locked: bool,
    skipped: &mut Vec<String>,
) -> Vec<PermissionRule> {
    if !locked {
        return rules;
    }
    rules
        .into_iter()
        .filter(|rule| {
            if is_catchall_allow(rule) && rule.source != "requirements" {
                skipped.push(format!(
                    "catch-all allow from {} ignored: always-approve disabled by managed policy",
                    rule.source
                ));
                false
            } else {
                true
            }
        })
        .collect()
}

pub fn walk_project_configs(cwd: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut current = cwd.to_path_buf();
    loop {
        dirs.push(current.clone());
        if current.join(".git").exists() {
            break;
        }
        if !current.pop() {
            break;
        }
    }
    dirs.reverse();
    dirs.into_iter()
        .map(|dir| dir.join(".grok").join("config.toml"))
        .filter(|path| path.is_file())
        .collect()
}

#[allow(clippy::too_many_arguments)]
pub fn build_policy(
    cwd: PathBuf,
    grok_home: &Path,
    home: &Path,
    interactive: bool,
    workspace_trusted: bool,
    user: Option<&TomlValue>,
    managed: Option<&TomlValue>,
    requirements: Option<&TomlValue>,
    workspace_tables: &[(PathBuf, TomlValue)],
    claude: Option<&JsonValue>,
    cli_mode: Option<&str>,
    cli_always_approve: bool,
    cli_auto: bool,
    env_mode: Option<&str>,
    env_remember: Option<&str>,
    cli_allow: &[String],
    cli_deny: &[String],
) -> Result<PermissionPolicy, String> {
    let lock = always_approve_lock(requirements);
    let mut skipped = Vec::new();
    let mut rules = Vec::new();
    if let Some(table) = requirements {
        rules.extend(extract_toml_rules(table, "requirements", &mut skipped));
    }
    if let Some(table) = managed {
        rules.extend(extract_toml_rules(table, "managed", &mut skipped));
    }
    if let Some(table) = user {
        rules.extend(extract_toml_rules(table, "config.toml", &mut skipped));
    }
    if workspace_trusted {
        for (path, table) in workspace_tables {
            rules.extend(extract_toml_rules(
                table,
                &path.display().to_string(),
                &mut skipped,
            ));
        }
    }
    let mut claude_mode = None;
    if let Some(value) = claude {
        let (claude_rules, mode) = extract_claude_rules(value, "claude", &mut skipped);
        rules.extend(claude_rules);
        claude_mode = mode;
    }
    for rule in cli_deny {
        match parse_permission_rule(rule, RuleAction::Deny, "cli") {
            Ok(parsed) => rules.push(parsed),
            Err(error) => skipped.push(format!("--deny: {error}")),
        }
    }
    for rule in cli_allow {
        match parse_permission_rule(rule, RuleAction::Allow, "cli") {
            Ok(parsed) => rules.push(parsed),
            Err(error) => skipped.push(format!("--allow: {error}")),
        }
    }
    let locked = lock.is_some();
    rules = drop_locked_catchalls(rules, locked, &mut skipped);
    let (mode, mode_source) = resolve_mode(
        cli_mode,
        cli_always_approve,
        cli_auto,
        env_mode,
        user,
        managed,
        requirements,
        claude_mode,
        lock.as_deref(),
    )?;
    let (remember_tool_approvals, remember_source) =
        remember_enabled(env_remember, user, managed, requirements);
    let grants_path = workspace_grants_path(grok_home, &cwd, home);
    let grants = load_grants(&grants_path);
    Ok(PermissionPolicy {
        mode,
        mode_source,
        always_approve_locked: locked,
        lock_source: lock,
        remember_tool_approvals,
        remember_source,
        interactive,
        cwd,
        rules,
        skipped,
        grants_path,
        grants,
    })
}

pub fn collect_workspace_tables(cwd: &Path, trusted: bool) -> Vec<(PathBuf, TomlValue)> {
    if !trusted {
        return Vec::new();
    }
    walk_project_configs(cwd)
        .into_iter()
        .filter_map(|path| {
            let text = fs::read_to_string(&path).ok()?;
            let value = toml::from_str::<TomlValue>(&text).ok()?;
            Some((path, value))
        })
        .collect()
}

pub fn load_claude_settings(cwd: &Path, trusted: bool) -> Option<JsonValue> {
    if !trusted {
        return None;
    }
    for name in [".claude/settings.local.json", ".claude/settings.json"] {
        let path = cwd.join(name);
        if let Ok(text) = fs::read_to_string(&path)
            && let Ok(value) = serde_json::from_str::<JsonValue>(&text)
        {
            return Some(value);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn policy(rules: Vec<PermissionRule>, mode: PermissionMode) -> PermissionPolicy {
        PermissionPolicy {
            mode,
            mode_source: "test".into(),
            always_approve_locked: false,
            lock_source: None,
            remember_tool_approvals: true,
            remember_source: "default".into(),
            interactive: true,
            cwd: PathBuf::from("/workspace"),
            rules,
            skipped: Vec::new(),
            grants_path: PathBuf::from("/tmp/permission.toml"),
            grants: GrantStore::default(),
        }
    }

    fn rule(action: RuleAction, spec: &str) -> PermissionRule {
        parse_permission_rule(spec, action, "test").unwrap()
    }

    #[test]
    fn deny_beats_allow_and_always_approve() {
        let policy = policy(
            vec![
                rule(RuleAction::Allow, "Bash(*)"),
                rule(RuleAction::Deny, "Bash(rm -rf *)"),
            ],
            PermissionMode::AlwaysApprove,
        );
        assert!(matches!(
            evaluate(&policy, &AccessKind::Bash("rm -rf /tmp/x".into()), None),
            Decision::Deny { .. }
        ));
        assert!(matches!(
            evaluate(&policy, &AccessKind::Bash("ls".into()), None),
            Decision::Allow { .. }
        ));
    }

    #[test]
    fn compound_allow_does_not_cover_unrelated_segment() {
        let policy = policy(
            vec![rule(RuleAction::Allow, "Bash(git *)")],
            PermissionMode::Ask,
        );
        assert!(matches!(
            evaluate(&policy, &AccessKind::Bash("git status".into()), None),
            Decision::Allow { .. }
        ));
        let decision = evaluate(
            &policy,
            &AccessKind::Bash("git status && rm -rf /".into()),
            None,
        );
        assert!(!matches!(decision, Decision::Allow { .. }), "{decision:?}");
    }

    #[test]
    fn path_glob_and_explicit_ask() {
        let policy = policy(
            vec![
                rule(RuleAction::Deny, "Read(/workspace/secret/**)"),
                rule(RuleAction::Ask, "Read(src/**)"),
            ],
            PermissionMode::Ask,
        );
        assert!(matches!(
            evaluate(
                &policy,
                &AccessKind::Read(Some("/workspace/secret/key".into())),
                None
            ),
            Decision::Deny { .. }
        ));
        assert!(matches!(
            evaluate(&policy, &AccessKind::Read(Some("src/main.rs".into())), None),
            Decision::Ask { .. }
        ));
    }

    #[test]
    fn hook_deny_wins_over_always_approve() {
        let policy = policy(Vec::new(), PermissionMode::AlwaysApprove);
        assert!(matches!(
            evaluate(&policy, &AccessKind::Edit("note.txt".into()), Some("blocked")),
            Decision::Deny { reason } if reason.contains("hook")
        ));
    }

    #[test]
    fn remembered_grant_is_project_scoped_and_exact_for_dangerous() {
        let mut policy = policy(Vec::new(), PermissionMode::Ask);
        policy.grants.allowed_bash.push("git status".into());
        assert!(matches!(
            evaluate(&policy, &AccessKind::Bash("git status".into()), None),
            Decision::Allow { reason } if reason.contains("remembered")
        ));
        policy.grants.allowed_bash = vec!["rm".into()];
        assert!(matches!(
            evaluate(&policy, &AccessKind::Bash("rm -rf /tmp/x".into()), None),
            Decision::Ask { .. }
        ));
        policy.grants.allowed_bash = vec!["rm -rf /tmp/x".into()];
        assert!(matches!(
            evaluate(&policy, &AccessKind::Bash("rm -rf /tmp/x".into()), None),
            Decision::Allow { .. }
        ));
    }

    #[test]
    fn locked_always_approve_rejects_cli() {
        let requirements =
            toml::from_str::<TomlValue>("[ui]\ndisable_bypass_permissions_mode = true\n").unwrap();
        let lock = always_approve_lock(Some(&requirements));
        let error = resolve_mode(
            Some("always-approve"),
            true,
            false,
            None,
            None,
            None,
            Some(&requirements),
            None,
            lock.as_deref(),
        )
        .unwrap_err();
        assert!(error.contains("disable_bypass_permissions_mode"), "{error}");
    }

    #[test]
    fn grant_round_trip_and_failed_write_is_not_permanent() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("permission.toml");
        record_grant(&path, &AccessKind::Bash("git status --short".into()), true).unwrap();
        let loaded = load_grants(&path);
        assert_eq!(loaded.allowed_bash, vec!["git status".to_string()]);
        clear_grants(&path).unwrap();
        assert!(load_grants(&path).allowed_bash.is_empty());
        let (line, _) = prompt_lines(&AccessKind::Bash("git status".into()), true, false);
        assert!(line.contains("once"));
        assert!(!line.to_lowercase().contains("permanent rule saved"));
    }

    #[test]
    fn bash_git_prefix_without_boundary_matches_gitleaks_on_deny() {
        let policy = policy(
            vec![rule(RuleAction::Deny, "Bash(git)")],
            PermissionMode::Ask,
        );
        assert!(matches!(
            evaluate(&policy, &AccessKind::Bash("gitleaks detect".into()), None),
            Decision::Deny { .. }
        ));
    }

    #[test]
    fn access_from_tool_covers_named_kinds() {
        assert!(matches!(
            access_from_tool("grep", &json!({ "path": "src" })),
            AccessKind::Grep { .. }
        ));
        assert!(matches!(
            access_from_tool("linear__save_issue", &json!({})),
            AccessKind::Mcp { .. }
        ));
        assert!(matches!(
            access_from_tool("web_fetch", &json!({ "url": "https://example.com" })),
            AccessKind::WebFetch(_)
        ));
        assert!(matches!(
            access_from_tool("web_search", &json!({ "query": "rust" })),
            AccessKind::WebSearch(_)
        ));
        assert!(matches!(
            access_from_tool("scheduler_create", &json!({})),
            AccessKind::Tool(_)
        ));
        let deny = evaluate(
            &policy(Vec::new(), PermissionMode::DontAsk),
            &AccessKind::Tool("scheduler_create".into()),
            None,
        );
        assert_eq!(deny.kind(), "deny");
        assert!(!deny.reason().is_empty());
    }
}
