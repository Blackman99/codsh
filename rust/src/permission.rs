#![allow(dead_code)]

use crate::trust;
use serde_json::{Value as JsonValue, json};
use std::collections::HashSet;
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
    pub allowed_edit_paths: Vec<String>,
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
        "loadError": "",
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
            "allowedEditPaths": policy.grants.allowed_edit_paths,
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
        allowed_edit_paths: string_array(&value, "allowed_edit_paths"),
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
    body.push_str("allow_edits_for_session = false\n");
    write_list(&mut body, "allowed_edit_paths", &grants.allowed_edit_paths);
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
    let always_approve = policy.mode == PermissionMode::AlwaysApprove;
    if let Some(decision) = evaluate_rules(policy, access) {
        match decision {
            Decision::Deny { .. } => return decision,
            Decision::Ask { .. } => {
                if always_approve && !matches!(access, AccessKind::Bash(_)) {
                    return Decision::Allow {
                        reason: "always-approve".into(),
                    };
                }
                if always_approve {
                    return decision;
                }
                if let Some(grant) = evaluate_grants(policy, access) {
                    return grant;
                }
                return decision;
            }
            Decision::Allow { .. } => return decision,
        }
    }
    if !always_approve && let Some(grant) = evaluate_grants(policy, access) {
        return grant;
    }
    if is_readonly_access(access) {
        return Decision::Allow {
            reason: "read-only tool".into(),
        };
    }
    if let AccessKind::Bash(command) = access
        && !is_unsplittable(command)
        && {
            let segments = bash_segments(command);
            !segments.is_empty()
                && segments.iter().all(|segment| {
                    let words = shell_words(segment);
                    let refs: Vec<&str> = words.iter().map(String::as_str).collect();
                    is_readonly_command(&refs)
                })
                && segments.iter().all(|segment| {
                    let words = shell_words(segment);
                    let refs: Vec<&str> = words.iter().map(String::as_str).collect();
                    !is_dangerous_command(&refs)
                })
        }
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
        for segment in bash_inspect_subjects(command) {
            match evaluate_rules_for(policy, &AccessKind::Bash(segment)) {
                Some(Decision::Deny { reason }) => {
                    return Some(Decision::Deny { reason });
                }
                Some(Decision::Ask { reason }) => ask = Some(Decision::Ask { reason }),
                _ => {}
            }
        }
        match evaluate_shell_path_rules(policy, command) {
            Some(Decision::Deny { reason }) => {
                return Some(Decision::Deny { reason });
            }
            Some(Decision::Ask { reason }) => ask = Some(Decision::Ask { reason }),
            _ => {}
        }
        if let Some(ask) = ask {
            return Some(ask);
        }
        if is_unsplittable(command) && bash_restrictions_configured(policy) {
            return Some(Decision::Ask {
                reason: "unsplittable command".into(),
            });
        }
        if bash_chain_allowed(policy, command) {
            return Some(Decision::Allow {
                reason: "allow rule".into(),
            });
        }
        return None;
    }
    evaluate_rules_for(policy, access)
}

fn evaluate_rules_for(policy: &PermissionPolicy, access: &AccessKind) -> Option<Decision> {
    if let Some(path) = match access {
        AccessKind::Read(path) => path.as_deref(),
        AccessKind::Edit(path) => Some(path.as_str()),
        AccessKind::Grep { path } => path.as_deref(),
        _ => None,
    } {
        let inspected = inspect_path(path, &policy.cwd);
        let tool = match access {
            AccessKind::Edit(_) => ToolFilter::Edit,
            _ => ToolFilter::Read,
        };
        if inspected.unresolved && file_rule_applies(policy, tool) {
            return Some(Decision::Ask {
                reason: "unresolved symlink".into(),
            });
        }
    }
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
    let scripts = extract_dash_c_scripts(command);
    if !scripts.is_empty() {
        return scripts
            .iter()
            .all(|script| bash_chain_allowed(policy, script));
    }
    if is_unsplittable(command) {
        return false;
    }
    let segments = bash_segments(command);
    if segments.is_empty() {
        return false;
    }
    let allow_rules = policy.rules.iter().any(|rule| {
        rule.action == RuleAction::Allow && matches!(rule.tool, ToolFilter::Bash | ToolFilter::Any)
    });
    allow_rules
        && segments.iter().all(|segment| {
            let trimmed = segment.trim_start();
            policy.rules.iter().any(|rule| {
                rule.action == RuleAction::Allow
                    && matches!(rule.tool, ToolFilter::Bash | ToolFilter::Any)
                    && bash_allow_matches(trimmed, rule)
            })
        })
}

fn bash_policy_subjects(command: &str) -> Vec<String> {
    bash_inspect_subjects(command)
}

fn bash_restrictions_configured(policy: &PermissionPolicy) -> bool {
    policy
        .rules
        .iter()
        .any(|rule| matches!(rule.tool, ToolFilter::Bash | ToolFilter::Any))
}

fn evaluate_shell_path_rules(policy: &PermissionPolicy, command: &str) -> Option<Decision> {
    let mut ask = None;
    for path in shell_operands(command) {
        let read = evaluate_rules_for(policy, &AccessKind::Read(Some(path.clone())));
        if let Some(Decision::Deny { reason }) = read {
            return Some(Decision::Deny { reason });
        }
        let edit = evaluate_rules_for(policy, &AccessKind::Edit(path));
        if let Some(Decision::Deny { reason }) = edit {
            return Some(Decision::Deny { reason });
        }
        if matches!(read, Some(Decision::Ask { .. })) {
            ask = read;
        } else if matches!(edit, Some(Decision::Ask { .. })) {
            ask = edit;
        }
    }
    ask
}

fn shell_operands(command: &str) -> Vec<String> {
    let mut operands = Vec::new();
    for subject in bash_inspect_subjects(command) {
        let words: Vec<&str> = subject.split_whitespace().collect();
        for word in words.iter().skip(1) {
            let unquoted = unquote_word(word);
            if unquoted.is_empty() || unquoted.starts_with('-') {
                continue;
            }
            operands.push(unquoted);
        }
    }
    operands
}

fn unquote_word(word: &str) -> String {
    if (word.starts_with('"') && word.ends_with('"') && word.len() >= 2)
        || (word.starts_with('\'') && word.ends_with('\'') && word.len() >= 2)
    {
        word[1..word.len() - 1].to_string()
    } else {
        word.to_string()
    }
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
            let segments = bash_segments(command);
            if segments.is_empty() || is_unpeelable(command) {
                return None;
            }
            if segments.iter().all(|segment| {
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
        AccessKind::Edit(path)
            if policy.remember_tool_approvals
                && path_forms(path, &policy.cwd).iter().any(|form| {
                    policy
                        .grants
                        .allowed_edit_paths
                        .iter()
                        .any(|allowed| allowed == form)
                }) =>
        {
            Some(Decision::Allow {
                reason: "remembered project grant".into(),
            })
        }
        _ => None,
    }
}

fn rule_reaches(access: &AccessKind, rule: &PermissionRule) -> bool {
    match rule.tool {
        ToolFilter::Any => true,
        ToolFilter::Bash => matches!(access, AccessKind::Bash(_)),
        ToolFilter::Edit => matches!(access, AccessKind::Edit(_)),
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
            let parsed = parsed_command(command);
            command.starts_with(pattern)
                || glob_match(pattern, command, false)
                || parsed.starts_with(pattern)
                || glob_match(pattern, &parsed, false)
        }
        AccessKind::Edit(path) | AccessKind::Read(Some(path)) => {
            path_matches(pattern, path, cwd, rule.action)
        }
        AccessKind::Grep { path: Some(path) } => path_matches(pattern, path, cwd, rule.action),
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

fn path_matches(pattern: &str, path: &str, cwd: &Path, action: RuleAction) -> bool {
    let inspected = inspect_path(path, cwd);
    let forms = if matches!(action, RuleAction::Deny | RuleAction::Ask) {
        inspected.forms
    } else {
        path_forms(path, cwd)
    };
    forms.iter().any(|form| glob_match(pattern, form, true))
}

struct InspectedPath {
    forms: Vec<String>,
    unresolved: bool,
}

fn inspect_path(path: &str, cwd: &Path) -> InspectedPath {
    let lexical = path_forms(path, cwd);
    if path.is_empty() || is_tilde_path(Path::new(path)) {
        return InspectedPath {
            forms: lexical,
            unresolved: false,
        };
    }
    let abs = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        cwd.join(path)
    };
    match abs.symlink_metadata() {
        Ok(meta) if meta.file_type().is_symlink() => match abs.canonicalize() {
            Ok(resolved) => {
                let mut forms = lexical;
                let resolved_text = path_text(&resolved);
                if !forms.contains(&resolved_text) {
                    forms.push(resolved_text.clone());
                }
                for extra in path_forms(&resolved_text, cwd) {
                    if !forms.contains(&extra) {
                        forms.push(extra);
                    }
                }
                InspectedPath {
                    forms,
                    unresolved: false,
                }
            }
            Err(_) => InspectedPath {
                forms: lexical,
                unresolved: true,
            },
        },
        _ => InspectedPath {
            forms: lexical,
            unresolved: false,
        },
    }
}

fn file_rule_applies(policy: &PermissionPolicy, tool: ToolFilter) -> bool {
    policy.rules.iter().any(|rule| {
        matches!(rule.action, RuleAction::Deny | RuleAction::Ask)
            && (rule.tool == tool || rule.tool == ToolFilter::Any)
    })
}

fn cwd_roots(cwd: &Path) -> Vec<PathBuf> {
    let mut roots = vec![normalize_lexically(cwd)];
    if let Ok(real) = cwd.canonicalize() {
        let real = normalize_lexically(&real);
        if !roots.contains(&real) {
            roots.push(real);
        }
    }
    roots
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
    for root in cwd_roots(cwd) {
        if let Ok(rel) = abs.strip_prefix(&root) {
            let rel_text = path_text(rel);
            if rel_text.is_empty() || rel_text == "." {
                forms.extend([".".into(), "./".into()]);
            } else {
                forms.push(format!("./{rel_text}"));
                forms.push(rel_text);
            }
        }
    }
    forms.sort();
    forms.dedup();
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

const CONTROL_FLOW: &[&str] = &[
    "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
];

fn is_control_flow(command: &str) -> bool {
    command
        .split_whitespace()
        .any(|word| CONTROL_FLOW.contains(&word))
}

fn has_background_amp(command: &str) -> bool {
    let mut quote = None;
    let chars: Vec<char> = command.chars().collect();
    for (index, ch) in chars.iter().enumerate() {
        if quote == Some(*ch) {
            quote = None;
            continue;
        }
        if quote.is_none() && (*ch == '\'' || *ch == '"') {
            quote = Some(*ch);
            continue;
        }
        if quote.is_none()
            && *ch == '&'
            && chars.get(index + 1) != Some(&'&')
            && (index == 0 || chars.get(index - 1) != Some(&'&'))
        {
            return true;
        }
    }
    false
}

fn is_unpeelable(command: &str) -> bool {
    let words: Vec<&str> = command.split_whitespace().collect();
    words.windows(2).any(|pair| {
        Path::new(pair[0])
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(pair[0])
            == "env"
            && pair[1] == "-S"
    })
}

fn is_unsplittable(command: &str) -> bool {
    command.contains("$(")
        || command.contains('`')
        || has_unquoted(&['(', ')', '{', '}'], command)
        || has_background_amp(command)
        || is_control_flow(command)
        || is_unpeelable(command)
}

fn split_simple(command: &str) -> Vec<String> {
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

pub fn bash_segments(command: &str) -> Vec<String> {
    if is_unpeelable(command) {
        return Vec::new();
    }
    if is_unsplittable(command) {
        let stripped = strip_env_and_wrappers(command.trim());
        return if stripped.is_empty() {
            Vec::new()
        } else {
            vec![stripped]
        };
    }
    split_simple(command)
}

fn extract_substitutions(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let chars: Vec<char> = command.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '$' && chars.get(index + 1) == Some(&'(') {
            let (inner, next) = take_balanced(&chars, index + 2, '(', ')');
            if !inner.trim().is_empty() {
                out.push(inner.trim().to_string());
            }
            index = next;
            continue;
        }
        if chars[index] == '`'
            && let Some(end) = chars[index + 1..].iter().position(|ch| *ch == '`')
        {
            let inner: String = chars[index + 1..index + 1 + end].iter().collect();
            if !inner.trim().is_empty() {
                out.push(inner.trim().to_string());
            }
            index += end + 2;
            continue;
        }
        index += 1;
    }
    out
}

fn take_balanced(chars: &[char], start: usize, open: char, close: char) -> (String, usize) {
    let mut depth = 1usize;
    let mut quote = None;
    let mut index = start;
    while index < chars.len() {
        let ch = chars[index];
        if quote == Some(ch) {
            quote = None;
        } else if quote.is_none() && (ch == '\'' || ch == '"') {
            quote = Some(ch);
        } else if quote.is_none() {
            if ch == open {
                depth += 1;
            } else if ch == close {
                depth -= 1;
                if depth == 0 {
                    return (chars[start..index].iter().collect(), index + 1);
                }
            }
        }
        index += 1;
    }
    (chars[start..].iter().collect(), chars.len())
}

fn extract_dash_c_scripts(command: &str) -> Vec<String> {
    let mut scripts = Vec::new();
    let chars: Vec<char> = command.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        while index < chars.len() && chars[index].is_whitespace() {
            index += 1;
        }
        if index >= chars.len() {
            break;
        }
        let (word, next) = next_shell_word(&chars, index);
        index = next;
        let base = Path::new(&word)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&word);
        if !matches!(base, "bash" | "sh" | "dash" | "zsh" | "ksh") {
            continue;
        }
        let mut want_script = false;
        loop {
            while index < chars.len() && chars[index].is_whitespace() {
                index += 1;
            }
            if index >= chars.len() {
                break;
            }
            let (flag, after) = next_shell_word(&chars, index);
            if flag == "--" {
                index = after;
                if want_script && index < chars.len() {
                    while index < chars.len() && chars[index].is_whitespace() {
                        index += 1;
                    }
                    let (script, done) = next_shell_word(&chars, index);
                    if !script.is_empty() {
                        scripts.push(unquote_word(&script));
                    }
                    index = done;
                }
                break;
            }
            if flag == "-c" || flag == "--command" || flag.starts_with("--command=") {
                if let Some(value) = flag.strip_prefix("--command=") {
                    scripts.push(value.to_string());
                    index = after;
                    break;
                }
                want_script = true;
                index = after;
                continue;
            }
            if flag.starts_with("--") {
                index = after;
                continue;
            }
            if flag.starts_with('-') && flag.len() > 1 {
                if flag[1..].contains('c') {
                    want_script = true;
                }
                index = after;
                continue;
            }
            if want_script {
                scripts.push(unquote_word(&flag));
                index = after;
                break;
            }
            break;
        }
    }
    scripts
}

fn decode_ansi_c(body: &str) -> String {
    let chars: Vec<char> = body.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '\\' {
            out.push(chars[index]);
            index += 1;
            continue;
        }
        let Some(next) = chars.get(index + 1).copied() else {
            out.push('\\');
            break;
        };
        let simple = match next {
            'n' => Some('\n'),
            't' => Some('\t'),
            'r' => Some('\r'),
            'a' => Some('\u{0007}'),
            'b' => Some('\u{0008}'),
            'f' => Some('\u{000c}'),
            'v' => Some('\u{000b}'),
            '\\' | '\'' | '"' => Some(next),
            _ => None,
        };
        if let Some(ch) = simple {
            out.push(ch);
            index += 2;
            continue;
        }
        if next == '\n' {
            index += 2;
            continue;
        }
        if next == 'x' {
            let hex: String = chars[index + 2..]
                .iter()
                .take(2)
                .take_while(|ch| ch.is_ascii_hexdigit())
                .collect();
            if !hex.is_empty()
                && let Ok(value) = u32::from_str_radix(&hex, 16)
                && let Some(ch) = char::from_u32(value)
            {
                out.push(ch);
                index += 2 + hex.len();
                continue;
            }
        }
        if next.is_digit(8) {
            let oct: String = chars[index + 1..]
                .iter()
                .take(3)
                .take_while(|ch| ch.is_digit(8))
                .collect();
            if let Ok(value) = u32::from_str_radix(&oct, 8)
                && let Some(ch) = char::from_u32(value)
            {
                out.push(ch);
                index += 1 + oct.len();
                continue;
            }
        }
        out.push(next);
        index += 2;
    }
    out
}

fn shell_words(command: &str) -> Vec<String> {
    let chars: Vec<char> = command.chars().collect();
    let mut words = Vec::new();
    let mut index = 0;
    let mut current = String::new();
    let mut open = false;
    let push = |words: &mut Vec<String>, current: &mut String, open: &mut bool| {
        if *open {
            words.push(std::mem::take(current));
        }
        *open = false;
    };
    while index < chars.len() {
        let ch = chars[index];
        if !open && ch.is_whitespace() {
            index += 1;
            continue;
        }
        if open && ch.is_whitespace() {
            push(&mut words, &mut current, &mut open);
            continue;
        }
        open = true;
        if ch == '$' && chars.get(index + 1) == Some(&'\'') {
            index += 2;
            let begin = index;
            while index < chars.len() && chars[index] != '\'' {
                index += 1;
            }
            let body: String = chars[begin..index].iter().collect();
            current.push_str(&decode_ansi_c(&body));
            if index < chars.len() {
                index += 1;
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            let mark = ch;
            index += 1;
            let begin = index;
            while index < chars.len() && chars[index] != mark {
                index += 1;
            }
            current.extend(chars[begin..index].iter());
            if index < chars.len() {
                index += 1;
            }
            continue;
        }
        if ch == '\\' {
            match chars.get(index + 1).copied() {
                Some('\n') => index += 2,
                Some(next) => {
                    current.push(next);
                    index += 2;
                }
                None => {
                    current.push('\\');
                    index += 1;
                }
            }
            continue;
        }
        current.push(ch);
        index += 1;
    }
    push(&mut words, &mut current, &mut open);
    words
}

fn parsed_command(command: &str) -> String {
    shell_words(command).join(" ")
}

fn next_shell_word(chars: &[char], start: usize) -> (String, usize) {
    let mut index = start;
    if index >= chars.len() {
        return (String::new(), index);
    }
    if chars[index] == '$' && chars.get(index + 1) == Some(&'\'') {
        index += 2;
        let begin = index;
        while index < chars.len() && chars[index] != '\'' {
            index += 1;
        }
        let body: String = chars[begin..index].iter().collect();
        if index < chars.len() {
            index += 1;
        }
        return (decode_ansi_c(&body), index);
    }
    let quote = if chars[index] == '\'' || chars[index] == '"' {
        Some(chars[index])
    } else {
        None
    };
    if let Some(mark) = quote {
        index += 1;
        let begin = index;
        while index < chars.len() && chars[index] != mark {
            index += 1;
        }
        let word: String = chars[begin..index].iter().collect();
        if index < chars.len() {
            index += 1;
        }
        return (word, index);
    }
    let begin = index;
    while index < chars.len() && !chars[index].is_whitespace() {
        index += 1;
    }
    let raw: String = chars[begin..index].iter().collect();
    (unescape_word(&raw), index)
}

fn unescape_word(word: &str) -> String {
    let chars: Vec<char> = word.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '\\' {
            match chars.get(index + 1).copied() {
                Some('\n') => index += 2,
                Some(next) => {
                    out.push(next);
                    index += 2;
                }
                None => {
                    out.push('\\');
                    break;
                }
            }
            continue;
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

fn brace_bodies(command: &str) -> Vec<String> {
    let chars: Vec<char> = command.chars().collect();
    let mut out = Vec::new();
    let mut index = 0;
    let mut quote = None;
    while index < chars.len() {
        let ch = chars[index];
        if quote == Some(ch) {
            quote = None;
            index += 1;
            continue;
        }
        if quote.is_none() && (ch == '\'' || ch == '"') {
            quote = Some(ch);
            index += 1;
            continue;
        }
        if quote.is_none() && ch == '{' {
            let (inner, next) = take_balanced(&chars, index + 1, '{', '}');
            if !inner.trim().is_empty() {
                out.push(inner.trim().to_string());
            }
            index = next;
            continue;
        }
        index += 1;
    }
    out
}

fn control_flow_bodies(command: &str) -> Vec<String> {
    if !is_control_flow(command) {
        return Vec::new();
    }
    let padded = command.replace(';', " ; ");
    let stripped = padded
        .split_whitespace()
        .map(|token| {
            if CONTROL_FLOW.contains(&token) {
                ";"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    split_simple(&stripped)
}

fn inner_shell_scripts(command: &str) -> Vec<String> {
    let mut scripts = extract_dash_c_scripts(command);
    let words = shell_words(command);
    for (index, word) in words.iter().enumerate() {
        let base = Path::new(word)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(word)
            .trim_end_matches(".exe");
        if base == "eval" && index + 1 < words.len() {
            let joined = words[index + 1..].join(" ");
            if !joined.trim().is_empty() {
                scripts.push(joined);
            }
        }
    }
    scripts
}

fn bash_inspect_subjects(command: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    fn walk(command: &str, seen: &mut HashSet<String>, out: &mut Vec<String>) {
        let trimmed = command.trim_start().to_string();
        if trimmed.is_empty() || !seen.insert(trimmed.clone()) {
            return;
        }
        out.push(trimmed.clone());
        let parsed = parsed_command(&trimmed);
        if !parsed.is_empty() && seen.insert(parsed.clone()) {
            out.push(parsed);
        }
        for segment in bash_segments(&trimmed) {
            if seen.insert(segment.clone()) {
                out.push(segment);
            }
        }
        for inner in extract_substitutions(&trimmed)
            .into_iter()
            .chain(inner_shell_scripts(&trimmed))
            .chain(control_flow_bodies(&trimmed))
            .chain(brace_bodies(&trimmed))
        {
            walk(&inner, seen, out);
        }
    }
    walk(command, &mut seen, &mut out);
    out
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

fn strip_assignments(words: &mut Vec<String>) {
    while words
        .first()
        .is_some_and(|word| word.contains('=') && !word.starts_with('-'))
    {
        words.remove(0);
    }
}

fn is_duration_token(word: &str) -> bool {
    let trimmed = word.trim_end_matches(['s', 'm', 'h', 'd']);
    !trimmed.is_empty() && trimmed.parse::<f64>().is_ok()
}

fn is_priority_token(word: &str) -> bool {
    word.parse::<i32>().is_ok()
}

fn consume_bare_positional(wrapper: &str, word: &str) -> bool {
    match wrapper {
        "timeout" => is_duration_token(word),
        "nice" | "ionice" | "chrt" => is_priority_token(word),
        _ => false,
    }
}

fn wrapper_takes_positional(wrapper: &str, flag: &str) -> bool {
    matches!(
        (wrapper, flag),
        ("timeout", "-s" | "--signal" | "-k" | "--kill-after")
            | ("nice", "-n" | "--adjustment")
            | (
                "ionice",
                "-c" | "-n" | "-p" | "--class" | "--classdata" | "--pid"
            )
            | (
                "chrt",
                "-p" | "--pid" | "-o" | "--other" | "-f" | "--fifo" | "-r" | "--rr"
            )
            | (
                "stdbuf",
                "-i" | "-o" | "-e" | "--input" | "--output" | "--error"
            )
            | ("env", "-u" | "--unset" | "-C" | "--chdir")
    )
}

fn strip_env_and_wrappers(command: &str) -> String {
    let mut words: Vec<String> = command.split_whitespace().map(str::to_string).collect();
    strip_assignments(&mut words);
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
        if base == "env" && words.first().is_some_and(|word| word == "-S") {
            return String::new();
        }
        let mut consumed_bare = false;
        while !words.is_empty() {
            let flag = words[0].clone();
            if flag == "--" {
                words.remove(0);
                break;
            }
            if base == "env" && flag.contains('=') && !flag.starts_with('-') {
                words.remove(0);
                continue;
            }
            if !flag.starts_with('-') {
                if !consumed_bare && consume_bare_positional(&base, &flag) {
                    words.remove(0);
                    consumed_bare = true;
                    continue;
                }
                break;
            }
            words.remove(0);
            if flag.contains('=') {
                continue;
            }
            if wrapper_takes_positional(&base, &flag)
                && words.first().is_some_and(|word| !word.starts_with('-'))
            {
                words.remove(0);
            }
        }
        strip_assignments(&mut words);
    }
    strip_assignments(&mut words);
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

fn unique_long_option(word: &str, canonical: &str) -> bool {
    let Some(name) = word.strip_prefix("--") else {
        return false;
    };
    if name.starts_with('-') {
        return false;
    }
    let name = name.split('=').next().unwrap_or(name);
    !name.is_empty() && name.len() <= canonical.len() && canonical.starts_with(name)
}

fn unique_among(name: &str, candidates: &[&str]) -> bool {
    candidates
        .iter()
        .filter(|candidate| candidate.starts_with(name))
        .count()
        == 1
}

fn git_write_option(subcommand: &str, word: &str) -> bool {
    if subcommand == "branch" && matches!(word, "-d" | "-D" | "--delete") {
        return true;
    }
    let Some(name) = word.strip_prefix("--") else {
        return false;
    };
    if name.starts_with('-') {
        return false;
    }
    let name = name.split('=').next().unwrap_or(name);
    match subcommand {
        "show" => unique_among(name, &["output"]),
        "cat-file" => unique_among(name, &["filters", "filter", "textconv"]),
        _ => false,
    }
}

fn raises_readonly_floor(words: &[&str]) -> bool {
    let Some(head) = words.first() else {
        return false;
    };
    if *head == "rg"
        && words
            .iter()
            .any(|word| *word == "--pre" || word.starts_with("--pre="))
    {
        return true;
    }
    if *head == "sort"
        && words
            .iter()
            .any(|word| unique_long_option(word, "compress-program"))
    {
        return true;
    }
    if *head == "eval" {
        return true;
    }
    *head == "git"
        && (words
            .iter()
            .any(|word| *word == "-c" || word.starts_with("--config-env"))
            || words.get(1).is_some_and(|subcommand| {
                words[2..]
                    .iter()
                    .any(|word| git_write_option(subcommand, word))
            }))
}

fn is_readonly_command(words: &[&str]) -> bool {
    if words.is_empty() || raises_readonly_floor(words) {
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
                | "check-ignore"
                | "check-attr"
                | "cat-file"
                | "ls-tree"
                | "show-ref"
                | "for-each-ref"
                | "rev-list"
                | "name-rev"
                | "count-objects"
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
        AccessKind::Edit(path) => {
            if allow && !path.is_empty() {
                let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
                for form in path_forms(path, &cwd) {
                    if !grants.allowed_edit_paths.iter().any(|item| item == &form) {
                        grants.allowed_edit_paths.push(form);
                    }
                }
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
    claude: &[JsonValue],
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
    for value in claude {
        let (claude_rules, mode) = extract_claude_rules(value, "claude", &mut skipped);
        rules.extend(claude_rules);
        if mode.is_some() {
            claude_mode = mode;
        }
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

fn read_json_file(path: &Path) -> Option<JsonValue> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<JsonValue>(&text).ok()
}

fn claude_project_dirs(cwd: &Path) -> Vec<PathBuf> {
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
    dirs
}

/// User `~/.claude` plus every `.claude` from the repo root down to `cwd`.
/// Later files are returned last so a closer deny still wins by action, not order.
pub fn load_claude_settings(cwd: &Path, home: &Path, trusted: bool) -> Vec<JsonValue> {
    if !trusted {
        return Vec::new();
    }
    let mut files = Vec::new();
    let user = home.join(".claude");
    for name in ["settings.json", "settings.local.json"] {
        files.push(user.join(name));
    }
    for dir in claude_project_dirs(cwd) {
        let claude = dir.join(".claude");
        files.push(claude.join("settings.json"));
        files.push(claude.join("settings.local.json"));
    }
    files
        .into_iter()
        .filter_map(|path| read_json_file(&path))
        .collect()
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
    fn always_approve_skips_non_shell_ask_path_rule() {
        let always_ask = policy(
            vec![rule(RuleAction::Ask, "Read(src/**)")],
            PermissionMode::AlwaysApprove,
        );
        assert!(matches!(
            evaluate(&always_ask, &AccessKind::Read(Some("src/main.rs".into())), None),
            Decision::Allow { reason } if reason == "always-approve"
        ));
    }

    #[test]
    fn unsplittable_and_control_flow_cannot_bypass_deny_or_conjunctive_allow() {
        let mixed = policy(
            vec![
                rule(RuleAction::Allow, "Bash(git *)"),
                rule(RuleAction::Deny, "Bash(rm -rf *)"),
            ],
            PermissionMode::AlwaysApprove,
        );
        assert!(matches!(
            evaluate(
                &mixed,
                &AccessKind::Bash("git status && $(rm -rf /)".into()),
                None
            ),
            Decision::Deny { .. }
        ));
        let control_flow = policy(
            vec![rule(RuleAction::Deny, "Bash(rm -rf *)")],
            PermissionMode::AlwaysApprove,
        );
        assert!(matches!(
            evaluate(
                &control_flow,
                &AccessKind::Bash("if true; then rm -rf /; fi".into()),
                None
            ),
            Decision::Deny { .. }
        ));
        let allow_only = policy(
            vec![rule(RuleAction::Allow, "Bash(git *)")],
            PermissionMode::Ask,
        );
        assert!(matches!(
            evaluate(
                &allow_only,
                &AccessKind::Bash("bash -c \"git status && git diff\"".into()),
                None
            ),
            Decision::Allow { .. }
        ));
        let mixed = evaluate(
            &allow_only,
            &AccessKind::Bash("bash -c \"git status && rm -rf /\"".into()),
            None,
        );
        assert!(!matches!(mixed, Decision::Allow { .. }), "{mixed:?}");
    }

    #[test]
    fn read_deny_applies_to_shell_operands_before_readonly_auto_allow() {
        let policy = policy(
            vec![rule(RuleAction::Deny, "Read(secret/**)")],
            PermissionMode::Ask,
        );
        assert!(matches!(
            evaluate(&policy, &AccessKind::Bash("cat secret/key".into()), None),
            Decision::Deny { .. }
        ));
    }

    #[test]
    fn always_approve_skips_grants_and_non_shell_ask() {
        let mut granted = policy(
            vec![rule(RuleAction::Ask, "Edit(note.txt)")],
            PermissionMode::AlwaysApprove,
        );
        granted.grants.allowed_edits = true;
        assert!(matches!(
            evaluate(&granted, &AccessKind::Edit("note.txt".into()), None),
            Decision::Allow { reason } if reason == "always-approve"
        ));
        let shell_ask = policy(
            vec![rule(RuleAction::Ask, "Bash(git *)")],
            PermissionMode::AlwaysApprove,
        );
        assert!(matches!(
            evaluate(&shell_ask, &AccessKind::Bash("git status".into()), None),
            Decision::Ask { .. }
        ));
    }

    #[test]
    fn wrapper_peel_and_env_s_cannot_bypass_deny() {
        let deny = policy(
            vec![rule(RuleAction::Deny, "Bash(rm -rf *)")],
            PermissionMode::AlwaysApprove,
        );
        for command in [
            "timeout 30 rm -rf /",
            "env FOO=1 rm -rf /",
            "stdbuf -oL rm -rf /",
            "nice rm -rf /",
            "timeout rm -rf /",
            "ionice rm -rf /",
            "chrt rm -rf /",
            "timeout --verbose rm -rf /",
            "nice -n 10 rm -rf /",
            "timeout 30 nice -n 10 rm -rf /",
            "ionice -c 3 rm -rf /",
            "bash -lc \"rm -rf /\"",
            "bash --login -c \"rm -rf /\"",
            "bash -ec \"rm -rf /\"",
            "bash -c -- \"rm -rf /\"",
        ] {
            assert!(
                matches!(
                    evaluate(&deny, &AccessKind::Bash(command.into()), None),
                    Decision::Deny { .. }
                ),
                "{command}"
            );
        }
        assert!(matches!(
            evaluate(&deny, &AccessKind::Bash("env -S rm -rf /".into()), None),
            Decision::Ask { .. }
        ));
    }

    #[test]
    fn glob_classes_and_readonly_floors() {
        let deny = policy(
            vec![rule(RuleAction::Deny, "Bash(rm -[rf]*)")],
            PermissionMode::AlwaysApprove,
        );
        assert!(matches!(
            evaluate(&deny, &AccessKind::Bash("rm -rf /".into()), None),
            Decision::Deny { .. }
        ));
        let ask = policy(Vec::new(), PermissionMode::Ask);
        assert!(matches!(
            evaluate(&ask, &AccessKind::Bash("rg --pre cat foo".into()), None),
            Decision::Ask { .. }
        ));
        assert!(matches!(
            evaluate(
                &ask,
                &AccessKind::Bash("sort --compress-program=gzip file".into()),
                None
            ),
            Decision::Ask { .. }
        ));
        let quiet = policy(Vec::new(), PermissionMode::DontAsk);
        assert!(matches!(
            evaluate(
                &quiet,
                &AccessKind::Bash("sort --compress-pro=gzip file".into()),
                None
            ),
            Decision::Deny { .. }
        ));
        assert!(matches!(
            evaluate(
                &quiet,
                &AccessKind::Bash("sort --compress-p=gzip file".into()),
                None
            ),
            Decision::Deny { .. }
        ));
    }

    #[test]
    fn brace_groups_and_ansi_c_bash_c_cannot_bypass_deny() {
        let deny = policy(
            vec![rule(RuleAction::Deny, "Bash(rm -rf *)")],
            PermissionMode::AlwaysApprove,
        );
        for command in [
            "{ rm -rf /; }",
            "{rm -rf /}",
            "true && { rm -rf /; }",
            "function x { rm -rf /; }",
            "bash -c \"{ rm -rf /; }\"",
            "bash -c $'rm -rf /'",
            "bash -c $'rm \\\\\n-rf /'",
        ] {
            assert!(
                matches!(
                    evaluate(&deny, &AccessKind::Bash(command.into()), None),
                    Decision::Deny { .. }
                ),
                "{command}"
            );
        }
    }

    #[test]
    fn frozen_git_readonly_subcommands_allow_and_writes_do_not() {
        let quiet = policy(Vec::new(), PermissionMode::DontAsk);
        for command in [
            "git cat-file -t HEAD",
            "git ls-tree HEAD",
            "git check-ignore path",
            "git show-ref",
            "git for-each-ref",
            "git rev-list HEAD",
            "git name-rev HEAD",
            "git count-objects",
            "git check-attr -a path",
        ] {
            assert!(
                matches!(
                    evaluate(&quiet, &AccessKind::Bash(command.into()), None),
                    Decision::Allow { .. }
                ),
                "{command}"
            );
        }
        assert!(matches!(
            evaluate(&quiet, &AccessKind::Bash("git commit -m x".into()), None),
            Decision::Deny { .. }
        ));
        for command in [
            "git branch -D topic",
            "git branch -d topic",
            "git show --output=/tmp/out HEAD",
            "git cat-file --filters HEAD:path",
        ] {
            assert!(
                matches!(
                    evaluate(&quiet, &AccessKind::Bash(command.into()), None),
                    Decision::Deny { .. }
                ),
                "{command}"
            );
        }
        for command in ["git branch", "git show HEAD", "git cat-file -t HEAD"] {
            assert!(
                matches!(
                    evaluate(&quiet, &AccessKind::Bash(command.into()), None),
                    Decision::Allow { .. }
                ),
                "{command}"
            );
        }
    }

    #[test]
    fn quoted_and_eval_spellings_cannot_bypass_deny() {
        let deny = policy(
            vec![rule(RuleAction::Deny, "Bash(rm -rf *)")],
            PermissionMode::AlwaysApprove,
        );
        for command in [
            "'rm' -rf /",
            "\"rm\" -rf /",
            "$'rm' -rf /",
            "\\rm -rf /",
            "bash -c \"'rm' -rf /\"",
            "bash -c \"\\\\rm -rf /\"",
            "eval \"rm -rf /\"",
            "eval $'rm -rf /'",
        ] {
            assert!(
                matches!(
                    evaluate(&deny, &AccessKind::Bash(command.into()), None),
                    Decision::Deny { .. }
                ),
                "{command}"
            );
        }
    }

    #[test]
    fn remembered_edit_grant_is_path_scoped() {
        let mut granted = policy(Vec::new(), PermissionMode::Ask);
        granted.grants.allowed_edit_paths.push("note.txt".into());
        assert!(matches!(
            evaluate(&granted, &AccessKind::Edit("note.txt".into()), None),
            Decision::Allow { .. }
        ));
        assert!(matches!(
            evaluate(&granted, &AccessKind::Edit("other.txt".into()), None),
            Decision::Ask { .. }
        ));
    }

    #[test]
    fn read_deny_follows_in_path_symlink_and_unresolved_prompts() {
        let dir = tempfile::TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("secret")).unwrap();
        fs::write(dir.path().join("secret/key"), "SECRET").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(dir.path().join("secret/key"), dir.path().join("visible")).unwrap();
            symlink(dir.path().join("missing-target"), dir.path().join("broken")).unwrap();
        }
        let mut deny = policy(
            vec![rule(RuleAction::Deny, "Read(secret/**)")],
            PermissionMode::Ask,
        );
        deny.cwd = dir.path().to_path_buf();
        assert!(matches!(
            evaluate(&deny, &AccessKind::Read(Some("visible".into())), None),
            Decision::Deny { .. }
        ));
        assert!(matches!(
            evaluate(&deny, &AccessKind::Bash("cat visible".into()), None),
            Decision::Deny { .. }
        ));
        assert!(matches!(
            evaluate(&deny, &AccessKind::Read(Some("broken".into())), None),
            Decision::Ask { .. }
        ));
    }

    #[test]
    fn claude_settings_walk_home_and_parents_to_repo_root() {
        let dir = TempDir::new().unwrap();
        let home = dir.path().join("home");
        let repo = dir.path().join("repo");
        let nested = repo.join("pkg");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(repo.join(".claude")).unwrap();
        fs::create_dir_all(nested.join(".claude")).unwrap();
        fs::write(repo.join(".git"), "gitdir: unused\n").unwrap();
        fs::write(
            home.join(".claude/settings.json"),
            r#"{"permissions":{"deny":["Bash(rm -rf *)"]}}"#,
        )
        .unwrap();
        fs::write(
            repo.join(".claude/settings.json"),
            r#"{"permissions":{"allow":["Bash(git *)"]}}"#,
        )
        .unwrap();
        fs::write(
            nested.join(".claude/settings.local.json"),
            r#"{"permissions":{"deny":["Read(secret/**)"]}}"#,
        )
        .unwrap();
        let loaded = load_claude_settings(&nested, &home, true);
        assert_eq!(loaded.len(), 3, "home, repo, and nested claude files");
        let policy = build_policy(
            nested.clone(),
            dir.path(),
            &home,
            true,
            true,
            None,
            None,
            None,
            &[],
            &loaded,
            None,
            false,
            false,
            None,
            None,
            &[],
            &[],
        )
        .unwrap();
        assert!(matches!(
            evaluate(&policy, &AccessKind::Bash("rm -rf /tmp/x".into()), None),
            Decision::Deny { .. }
        ));
        assert!(matches!(
            evaluate(&policy, &AccessKind::Bash("git status".into()), None),
            Decision::Allow { .. }
        ));
        let mut read_policy = policy.clone();
        read_policy.cwd = nested.clone();
        assert!(matches!(
            evaluate(
                &read_policy,
                &AccessKind::Read(Some("secret/key".into())),
                None
            ),
            Decision::Deny { .. }
        ));
        assert!(
            load_claude_settings(&nested, &home, false).is_empty(),
            "untrusted workspaces do not load claude rules"
        );
    }

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
