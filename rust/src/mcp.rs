//! Local MCP servers: discovery, the per-session plan dsh mounts, the
//! `mcp` subcommand, and config edits.
//!
//! dsh executes every MCP call. This module only decides which servers a
//! session asks dsh to mount (ACP `mcpServers`), wraps stdio servers in the
//! `__mcp-stdio-proxy` launcher so startup failures, stderr, startup
//! timeouts, and per-tool timeouts are visible, and edits config files for
//! `codsh --rust mcp add|remove|enable|disable`.

use serde_json::{Value as JsonValue, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use toml::Value as TomlValue;

/// Env key naming the plan file for a dsh child.
pub const PLAN_ENV: &str = "CODSH_MCP_PLAN";
/// Hidden launcher subcommand dsh runs for each stdio server.
pub const PROXY_SUBCOMMAND: &str = "__mcp-stdio-proxy";
pub const DEFAULT_MAX_OUTPUT_BYTES: u64 = 20_000;
pub const DEFAULT_STARTUP_TIMEOUT_MS: u64 = 30_000;
pub const DEFAULT_TOOL_TIMEOUT_MS: u64 = 6_000_000;
/// dsh-mcp-client's fixed per-call bound. ACP cannot change it.
pub const DSH_TOOL_CALL_LIMIT_MS: u64 = 60_000;
/// dsh keeps `[A-Za-z0-9_-]{1,32}` names and hashes longer ones.
pub const DSH_SERVER_NAME_LIMIT: usize = 32;

#[derive(Clone, Debug, PartialEq)]
pub enum Transport {
    Stdio {
        command: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
        cwd: Option<String>,
    },
    Http {
        url: String,
        headers: BTreeMap<String, String>,
    },
    Sse {
        url: String,
        headers: BTreeMap<String, String>,
    },
}

impl Transport {
    pub fn kind(&self) -> &'static str {
        match self {
            Transport::Stdio { .. } => "stdio",
            Transport::Http { .. } => "http",
            Transport::Sse { .. } => "sse",
        }
    }

    pub fn target(&self) -> String {
        match self {
            Transport::Stdio { command, args, .. } => {
                if args.is_empty() {
                    command.clone()
                } else {
                    format!("{command} {}", args.join(" "))
                }
            }
            Transport::Http { url, .. } | Transport::Sse { url, .. } => url.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    User(PathBuf),
    Project(PathBuf),
    Claude(PathBuf),
    Cursor(PathBuf),
    CursorProject(PathBuf),
    McpJson(PathBuf),
}

impl Source {
    /// `scope` in `mcp list --json`, matching the reference labels.
    pub fn scope(&self) -> &'static str {
        match self {
            Source::User(_) => "user",
            Source::Project(_) => "project",
            Source::Claude(_) => "claude",
            Source::Cursor(_) | Source::CursorProject(_) => "cursor",
            Source::McpJson(_) => "mcp.json",
        }
    }

    pub fn path(&self) -> &Path {
        match self {
            Source::User(path)
            | Source::Project(path)
            | Source::Claude(path)
            | Source::Cursor(path)
            | Source::CursorProject(path)
            | Source::McpJson(path) => path,
        }
    }

    /// Repo-controlled definitions only load in a trusted folder.
    pub fn repo_controlled(&self) -> bool {
        matches!(
            self,
            Source::Project(_) | Source::CursorProject(_) | Source::McpJson(_)
        )
    }

    pub fn label(&self) -> String {
        format!("{} ({})", self.scope(), self.path().display())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ServerDef {
    pub name: String,
    pub transport: Transport,
    pub enabled: bool,
    pub startup_timeout_sec: Option<f64>,
    pub tool_timeout_sec: Option<f64>,
    pub tool_timeouts: BTreeMap<String, f64>,
    pub source: Source,
    /// Non-fatal notes about this definition (unsupported OAuth fields, unset variables).
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Ready,
    Disabled,
    Untrusted,
    Invalid(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub def: ServerDef,
    pub state: State,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SourceStatus {
    pub path: String,
    pub found: Option<usize>,
    pub skipped: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Discovery {
    pub entries: Vec<Entry>,
    pub sources: Vec<SourceStatus>,
    pub warnings: Vec<String>,
    pub disabled: BTreeSet<String>,
    pub max_output_bytes: u64,
    pub max_output_source: String,
}

impl Discovery {
    pub fn get(&self, name: &str) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.def.name == name)
    }

    pub fn names(&self) -> Vec<String> {
        self.entries
            .iter()
            .map(|entry| entry.def.name.clone())
            .collect()
    }
}

pub struct DiscoverInput<'a> {
    pub grok_home: &'a Path,
    pub config_path: &'a Path,
    pub home: &'a Path,
    pub cwd: &'a Path,
    pub trusted: bool,
    pub env: &'a BTreeMap<String, String>,
}

/// Grok admission rule plus dsh's namespace limit.
pub fn validate_server_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return Err("server name is empty".into());
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err(format!(
            "server name `{name}` must start with a letter or underscore"
        ));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "server name `{name}` may only contain letters, numbers, hyphens, and underscores"
        ));
    }
    if name.ends_with('_') || name.contains("__") {
        return Err(format!(
            "server name `{name}` makes an ambiguous `server__tool` key (no trailing `_` or `__`)"
        ));
    }
    if name.len() > DSH_SERVER_NAME_LIMIT {
        return Err(format!(
            "server name `{name}` is longer than {DSH_SERVER_NAME_LIMIT} characters; dsh would rename its tools"
        ));
    }
    Ok(())
}

/// `${VAR}` and `${VAR:-default}`. An unset variable without a default
/// expands to empty and is reported.
pub fn expand_vars(
    text: &str,
    env: &BTreeMap<String, String>,
    missing: &mut BTreeSet<String>,
) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = &after[..end];
        let (name, default) = match inner.split_once(":-") {
            Some((name, default)) => (name, Some(default)),
            None => (inner, None),
        };
        let valid = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid {
            out.push_str(&rest[start..start + 2 + end + 1]);
        } else {
            match env.get(name).filter(|value| !value.is_empty()) {
                Some(value) => out.push_str(value),
                None => match default {
                    Some(default) => out.push_str(default),
                    None => {
                        missing.insert(name.to_string());
                    }
                },
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

fn toml_number(value: Option<&TomlValue>) -> Option<f64> {
    match value {
        Some(TomlValue::Integer(number)) => Some(*number as f64),
        Some(TomlValue::Float(number)) => Some(*number),
        _ => None,
    }
}

fn json_number(value: Option<&JsonValue>) -> Option<f64> {
    value.and_then(JsonValue::as_f64)
}

fn string_map_toml(
    value: Option<&TomlValue>,
    field: &str,
) -> Result<BTreeMap<String, String>, String> {
    let mut map = BTreeMap::new();
    let Some(value) = value else {
        return Ok(map);
    };
    let table = value
        .as_table()
        .ok_or_else(|| format!("`{field}` must be a table of strings"))?;
    for (key, item) in table {
        let text = match item {
            TomlValue::String(text) => text.clone(),
            TomlValue::Integer(number) => number.to_string(),
            TomlValue::Boolean(flag) => flag.to_string(),
            _ => return Err(format!("`{field}.{key}` must be a string")),
        };
        map.insert(key.clone(), text);
    }
    Ok(map)
}

fn string_map_json(
    value: Option<&JsonValue>,
    field: &str,
) -> Result<BTreeMap<String, String>, String> {
    let mut map = BTreeMap::new();
    let Some(value) = value else {
        return Ok(map);
    };
    if value.is_null() {
        return Ok(map);
    }
    let object = value
        .as_object()
        .ok_or_else(|| format!("`{field}` must be an object of strings"))?;
    for (key, item) in object {
        let text = match item {
            JsonValue::String(text) => text.clone(),
            JsonValue::Number(number) => number.to_string(),
            JsonValue::Bool(flag) => flag.to_string(),
            _ => return Err(format!("`{field}.{key}` must be a string")),
        };
        map.insert(key.clone(), text);
    }
    Ok(map)
}

fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

fn finish_transport(
    transport: Transport,
    env: &BTreeMap<String, String>,
    notes: &mut Vec<String>,
) -> Result<Transport, String> {
    let mut missing = BTreeSet::new();
    let transport_kind = transport.kind();
    let transport = match transport {
        Transport::Stdio {
            command,
            args,
            env: server_env,
            cwd,
        } => {
            let command = expand_vars(&command, env, &mut missing);
            if command.trim().is_empty() {
                return Err("`command` is empty".into());
            }
            Transport::Stdio {
                command,
                args: args
                    .iter()
                    .map(|arg| expand_vars(arg, env, &mut missing))
                    .collect(),
                env: server_env
                    .iter()
                    .map(|(key, value)| (key.clone(), expand_vars(value, env, &mut missing)))
                    .collect(),
                cwd: cwd.map(|cwd| expand_vars(&cwd, env, &mut missing)),
            }
        }
        Transport::Http { url, headers } | Transport::Sse { url, headers } => {
            let sse = matches!(transport_kind, "sse");
            let url = expand_vars(&url, env, &mut missing);
            let headers: BTreeMap<String, String> = headers
                .iter()
                .map(|(key, value)| (key.clone(), expand_vars(value, env, &mut missing)))
                .collect();
            for (name, value) in &headers {
                if !valid_header_name(name) || value.contains(['\r', '\n', '\0']) {
                    return Err(format!("header `{name}` is not a valid HTTP header"));
                }
            }
            match url::Url::parse(&url) {
                Ok(parsed) if parsed.scheme() == "http" || parsed.scheme() == "https" => {}
                _ => {
                    return Err(format!(
                        "`url` must be an absolute http(s) URL, got `{url}`"
                    ));
                }
            }
            if sse {
                Transport::Sse { url, headers }
            } else {
                Transport::Http { url, headers }
            }
        }
    };
    if !missing.is_empty() {
        notes.push(format!(
            "unset variable(s) expanded to empty: {}",
            missing.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
    Ok(transport)
}

/// One `[mcp_servers.<name>]` table.
pub fn parse_toml_server(
    name: &str,
    value: &TomlValue,
    source: Source,
    env: &BTreeMap<String, String>,
) -> Result<ServerDef, Box<(ServerDef, String)>> {
    let placeholder = |source: Source| ServerDef {
        name: name.to_string(),
        transport: Transport::Stdio {
            command: String::new(),
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: None,
        },
        enabled: true,
        startup_timeout_sec: None,
        tool_timeout_sec: None,
        tool_timeouts: BTreeMap::new(),
        source,
        notes: Vec::new(),
    };
    let Some(table) = value.as_table() else {
        return Err(Box::new((
            placeholder(source),
            "server entry must be a table".into(),
        )));
    };
    let fail = |reason: String| Err(Box::new((placeholder(source.clone()), reason)));
    let enabled = match table.get("enabled") {
        None => true,
        Some(TomlValue::Boolean(flag)) => *flag,
        Some(_) => return fail("`enabled` must be true or false".into()),
    };
    let mut notes = Vec::new();
    let command = table.get("command");
    let url = table.get("url");
    let transport = match (command, url) {
        (Some(_), Some(_)) => return fail("set either `command` or `url`, not both".into()),
        (None, None) => return fail("missing `command` (stdio) or `url` (http)".into()),
        (Some(command), None) => {
            let Some(command) = command.as_str() else {
                return fail("`command` must be a string".into());
            };
            let args = match table.get("args") {
                None => Vec::new(),
                Some(TomlValue::Array(items)) => {
                    let mut args = Vec::new();
                    for item in items {
                        match item.as_str() {
                            Some(text) => args.push(text.to_string()),
                            None => return fail("`args` must be an array of strings".into()),
                        }
                    }
                    args
                }
                Some(_) => return fail("`args` must be an array of strings".into()),
            };
            let server_env = match string_map_toml(table.get("env"), "env") {
                Ok(map) => map,
                Err(reason) => return fail(reason),
            };
            let cwd = table
                .get("cwd")
                .and_then(TomlValue::as_str)
                .map(str::to_string);
            Transport::Stdio {
                command: command.to_string(),
                args,
                env: server_env,
                cwd,
            }
        }
        (None, Some(url)) => {
            let Some(url) = url.as_str() else {
                return fail("`url` must be a string".into());
            };
            let mut headers = match string_map_toml(table.get("headers"), "headers") {
                Ok(map) => map,
                Err(reason) => return fail(reason),
            };
            if let Some(var) = table
                .get("bearer_token_env_var")
                .and_then(TomlValue::as_str)
            {
                match env.get(var).filter(|value| !value.is_empty()) {
                    Some(token) => {
                        headers
                            .entry("Authorization".into())
                            .or_insert_with(|| format!("Bearer {token}"));
                    }
                    None => notes.push(format!("bearer_token_env_var {var} is not set")),
                }
            }
            let kind = table
                .get("transport_type")
                .or_else(|| table.get("type"))
                .and_then(TomlValue::as_str)
                .unwrap_or("http");
            if kind.eq_ignore_ascii_case("sse") {
                Transport::Sse {
                    url: url.to_string(),
                    headers,
                }
            } else {
                Transport::Http {
                    url: url.to_string(),
                    headers,
                }
            }
        }
    };
    for key in [
        "oauth",
        "oauth_client_id",
        "oauth_client_secret_env_var",
        "oauth_scopes",
    ] {
        if table.contains_key(key) {
            notes.push(format!(
                "`{key}` is not used: MCP OAuth is not available in this client"
            ));
            break;
        }
    }
    let mut tool_timeouts = BTreeMap::new();
    if let Some(value) = table.get("tool_timeouts") {
        let Some(map) = value.as_table() else {
            return fail("`tool_timeouts` must be a table of seconds".into());
        };
        for (tool, secs) in map {
            match toml_number(Some(secs)) {
                Some(secs) if secs > 0.0 => {
                    tool_timeouts.insert(tool.clone(), secs);
                }
                _ => return fail(format!("`tool_timeouts.{tool}` must be a positive number")),
            }
        }
    }
    let startup_timeout_sec = toml_number(table.get("startup_timeout_sec"));
    let tool_timeout_sec = toml_number(table.get("tool_timeout_sec"));
    for (field, value) in [
        ("startup_timeout_sec", startup_timeout_sec),
        ("tool_timeout_sec", tool_timeout_sec),
    ] {
        if value.is_some_and(|secs| secs <= 0.0) {
            return fail(format!("`{field}` must be a positive number"));
        }
    }
    let transport = match finish_transport(transport, env, &mut notes) {
        Ok(transport) => transport,
        Err(reason) => return fail(reason),
    };
    Ok(ServerDef {
        name: name.to_string(),
        transport,
        enabled,
        startup_timeout_sec,
        tool_timeout_sec,
        tool_timeouts,
        source,
        notes,
    })
}

/// One `mcpServers` entry from `.mcp.json`, Claude, or Cursor JSON.
pub fn parse_json_server(
    name: &str,
    value: &JsonValue,
    source: Source,
    env: &BTreeMap<String, String>,
) -> Result<ServerDef, Box<(ServerDef, String)>> {
    let placeholder = ServerDef {
        name: name.to_string(),
        transport: Transport::Stdio {
            command: String::new(),
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: None,
        },
        enabled: true,
        startup_timeout_sec: None,
        tool_timeout_sec: None,
        tool_timeouts: BTreeMap::new(),
        source: source.clone(),
        notes: Vec::new(),
    };
    let fail = |reason: String| Err(Box::new((placeholder.clone(), reason)));
    let Some(object) = value.as_object() else {
        return fail("server entry must be an object".into());
    };
    let kind = object
        .get("type")
        .or_else(|| object.get("transport"))
        .and_then(JsonValue::as_str)
        .unwrap_or("");
    let mut notes = Vec::new();
    let transport = if let Some(url) = object.get("url").or_else(|| object.get("serverUrl")) {
        let Some(url) = url.as_str() else {
            return fail("`url` must be a string".into());
        };
        let headers = match string_map_json(object.get("headers"), "headers") {
            Ok(map) => map,
            Err(reason) => return fail(reason),
        };
        if kind.eq_ignore_ascii_case("sse") {
            Transport::Sse {
                url: url.to_string(),
                headers,
            }
        } else {
            Transport::Http {
                url: url.to_string(),
                headers,
            }
        }
    } else if let Some(command) = object.get("command") {
        let Some(command) = command.as_str() else {
            return fail("`command` must be a string".into());
        };
        let args = match object.get("args") {
            None | Some(JsonValue::Null) => Vec::new(),
            Some(JsonValue::Array(items)) => {
                let mut args = Vec::new();
                for item in items {
                    match item.as_str() {
                        Some(text) => args.push(text.to_string()),
                        None => return fail("`args` must be an array of strings".into()),
                    }
                }
                args
            }
            Some(_) => return fail("`args` must be an array of strings".into()),
        };
        let server_env = match string_map_json(object.get("env"), "env") {
            Ok(map) => map,
            Err(reason) => return fail(reason),
        };
        Transport::Stdio {
            command: command.to_string(),
            args,
            env: server_env,
            cwd: object
                .get("cwd")
                .and_then(JsonValue::as_str)
                .map(str::to_string),
        }
    } else {
        return fail("missing `command` (stdio) or `url` (http)".into());
    };
    let enabled = !object
        .get("disabled")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let transport = match finish_transport(transport, env, &mut notes) {
        Ok(transport) => transport,
        Err(reason) => return fail(reason),
    };
    Ok(ServerDef {
        name: name.to_string(),
        transport,
        enabled,
        startup_timeout_sec: json_number(object.get("startup_timeout_sec")),
        tool_timeout_sec: json_number(object.get("tool_timeout_sec")),
        tool_timeouts: BTreeMap::new(),
        source,
        notes,
    })
}

fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// cwd first, then each parent up to and including the git root. Without a
/// git root only the cwd is used, so an unrelated parent is never read.
pub fn project_dirs(cwd: &Path) -> Vec<PathBuf> {
    let start = canonical(cwd);
    let mut dirs = Vec::new();
    let mut current = start.clone();
    loop {
        dirs.push(current.clone());
        if current.join(".git").exists() {
            return dirs;
        }
        if !current.pop() {
            break;
        }
    }
    vec![start]
}

fn read_toml(path: &Path) -> Option<TomlValue> {
    let text = fs::read_to_string(path).ok()?;
    toml::from_str::<TomlValue>(&text).ok()
}

fn read_json(path: &Path) -> Option<JsonValue> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<JsonValue>(&text).ok()
}

fn env_flag(env: &BTreeMap<String, String>, key: &str) -> Option<bool> {
    match env.get(key)?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn compat_enabled(
    user: Option<&TomlValue>,
    env: &BTreeMap<String, String>,
    vendor: &str,
    env_key: &str,
) -> bool {
    if let Some(flag) = env_flag(env, env_key) {
        return flag;
    }
    user.and_then(|root| root.get("compat"))
        .and_then(|compat| compat.get(vendor))
        .and_then(|vendor| vendor.get("mcps"))
        .and_then(TomlValue::as_bool)
        .unwrap_or(true)
}

fn positive_u64(value: Option<&TomlValue>) -> Option<u64> {
    match value {
        Some(TomlValue::Integer(number)) if *number > 0 => Some(*number as u64),
        _ => None,
    }
}

fn max_output_from(root: Option<&TomlValue>) -> Option<u64> {
    positive_u64(
        root.and_then(|root| root.get("mcp"))
            .and_then(|mcp| mcp.get("max_output_bytes")),
    )
}

/// Global startup default: `GROK_MCP_STARTUP_TIMEOUT_SECS` (seconds), then
/// `MCP_TIMEOUT` (milliseconds), then 30s.
pub fn default_startup_timeout_ms(env: &BTreeMap<String, String>) -> u64 {
    if let Some(secs) = env
        .get("GROK_MCP_STARTUP_TIMEOUT_SECS")
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|secs| *secs > 0.0)
    {
        return (secs * 1000.0) as u64;
    }
    if let Some(ms) = env
        .get("MCP_TIMEOUT")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0)
    {
        return ms;
    }
    DEFAULT_STARTUP_TIMEOUT_MS
}

pub fn startup_timeout_ms(def: &ServerDef, env: &BTreeMap<String, String>) -> u64 {
    def.startup_timeout_sec
        .map(|secs| (secs * 1000.0) as u64)
        .unwrap_or_else(|| default_startup_timeout_ms(env))
}

fn json_servers(value: Option<&JsonValue>) -> Vec<(String, JsonValue)> {
    value
        .and_then(|value| value.get("mcpServers"))
        .and_then(JsonValue::as_object)
        .map(|object| {
            object
                .iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn toml_servers(root: Option<&TomlValue>) -> Vec<(String, TomlValue)> {
    root.and_then(|root| root.get("mcp_servers"))
        .and_then(TomlValue::as_table)
        .map(|table| {
            table
                .iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// User `disabled_mcp_servers`.
pub fn user_disabled(root: Option<&TomlValue>) -> BTreeSet<String> {
    root.and_then(|root| root.get("disabled_mcp_servers"))
        .and_then(TomlValue::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(TomlValue::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Project `.grok/config.toml` files, repo root first and cwd last. The user
/// config is skipped when the walk reaches `$GROK_HOME`.
pub fn project_config_files(cwd: &Path, user_config: &Path) -> Vec<PathBuf> {
    let user = canonical(user_config);
    let mut files: Vec<PathBuf> = project_dirs(cwd)
        .into_iter()
        .map(|dir| dir.join(".grok").join("config.toml"))
        .filter(|path| canonical(path) != user)
        .collect();
    files.reverse();
    files
}

struct Candidate {
    def: Result<ServerDef, Box<(ServerDef, String)>>,
}

pub fn discover(input: &DiscoverInput<'_>) -> Discovery {
    let env = input.env;
    let mut discovery = Discovery::default();
    let user_root = read_toml(input.config_path);
    let managed_root = read_toml(&input.grok_home.join("managed_config.toml"));
    let requirements_root = read_toml(&input.grok_home.join("requirements.toml"));

    // Lowest priority first; a later candidate with the same name replaces
    // an earlier one entirely. Repo-controlled candidates only replace when
    // the folder is trusted.
    let mut ordered: Vec<Candidate> = Vec::new();

    // `.mcp.json`, repo root first so the one nearest the cwd wins.
    let mut mcp_json_found = 0usize;
    let mut mcp_json_any = false;
    for dir in project_dirs(input.cwd).into_iter().rev() {
        let path = dir.join(".mcp.json");
        if !path.is_file() {
            continue;
        }
        mcp_json_any = true;
        match read_json(&path) {
            Some(root) => {
                for (name, value) in json_servers(Some(&root)) {
                    mcp_json_found += 1;
                    ordered.push(Candidate {
                        def: parse_json_server(&name, &value, Source::McpJson(path.clone()), env),
                    });
                }
            }
            None => discovery.warnings.push(format!(
                "{} is not valid JSON; its servers were not loaded",
                path.display()
            )),
        }
    }
    discovery.sources.push(SourceStatus {
        path: ".mcp.json".into(),
        found: mcp_json_any.then_some(mcp_json_found),
        skipped: (mcp_json_any && !input.trusted).then(|| "folder not trusted".into()),
    });

    // Cursor: user file, then the project file.
    let cursor_on = compat_enabled(
        user_root.as_ref(),
        env,
        "cursor",
        "GROK_CURSOR_MCPS_ENABLED",
    );
    let cursor_user = input.home.join(".cursor").join("mcp.json");
    let cursor_project = canonical(input.cwd).join(".cursor").join("mcp.json");
    for (path, project) in [(cursor_user, false), (cursor_project, true)] {
        if !path.is_file() {
            continue;
        }
        if !cursor_on {
            discovery.sources.push(SourceStatus {
                path: path.display().to_string(),
                found: None,
                skipped: Some("[compat.cursor] mcps = false".into()),
            });
            continue;
        }
        let root = read_json(&path);
        let servers = json_servers(root.as_ref());
        discovery.sources.push(SourceStatus {
            path: path.display().to_string(),
            found: Some(servers.len()),
            skipped: (project && !input.trusted).then(|| "folder not trusted".into()),
        });
        for (name, value) in servers {
            let source = if project {
                Source::CursorProject(path.clone())
            } else {
                Source::Cursor(path.clone())
            };
            ordered.push(Candidate {
                def: parse_json_server(&name, &value, source, env),
            });
        }
    }

    // Claude: `~/.claude.json` top level, then its entry for this project.
    let claude_path = input.home.join(".claude.json");
    if claude_path.is_file() {
        if compat_enabled(
            user_root.as_ref(),
            env,
            "claude",
            "GROK_CLAUDE_MCPS_ENABLED",
        ) {
            let root = read_json(&claude_path);
            let mut servers = json_servers(root.as_ref());
            let cwd_key = canonical(input.cwd).display().to_string();
            if let Some(project) = root
                .as_ref()
                .and_then(|root| root.get("projects"))
                .and_then(|projects| projects.get(&cwd_key))
            {
                servers.extend(json_servers(Some(project)));
            }
            discovery.sources.push(SourceStatus {
                path: claude_path.display().to_string(),
                found: Some(servers.len()),
                skipped: None,
            });
            for (name, value) in servers {
                ordered.push(Candidate {
                    def: parse_json_server(&name, &value, Source::Claude(claude_path.clone()), env),
                });
            }
        } else {
            discovery.sources.push(SourceStatus {
                path: claude_path.display().to_string(),
                found: None,
                skipped: Some("[compat.claude] mcps = false".into()),
            });
        }
    }

    // Native TOML: user config, then project files root to cwd.
    let user_servers = toml_servers(user_root.as_ref());
    discovery.sources.push(SourceStatus {
        path: input.config_path.display().to_string(),
        found: input.config_path.is_file().then_some(user_servers.len()),
        skipped: None,
    });
    for (name, value) in user_servers {
        ordered.push(Candidate {
            def: parse_toml_server(
                &name,
                &value,
                Source::User(input.config_path.to_path_buf()),
                env,
            ),
        });
    }
    let mut project_max: Option<u64> = None;
    for path in project_config_files(input.cwd, input.config_path) {
        if !path.is_file() {
            continue;
        }
        let root = read_toml(&path);
        let servers = toml_servers(root.as_ref());
        discovery.sources.push(SourceStatus {
            path: path.display().to_string(),
            found: Some(servers.len()),
            skipped: (!input.trusted).then(|| "folder not trusted".into()),
        });
        if input.trusted
            && let Some(value) = max_output_from(root.as_ref())
        {
            project_max = Some(value);
        }
        for (name, value) in servers {
            ordered.push(Candidate {
                def: parse_toml_server(&name, &value, Source::Project(path.clone()), env),
            });
        }
    }

    let mut winners: BTreeMap<String, Entry> = BTreeMap::new();
    for candidate in ordered {
        let (def, invalid) = match candidate.def {
            Ok(def) => (def, None),
            Err(failed) => {
                let (def, reason) = *failed;
                (def, Some(reason))
            }
        };
        let name = def.name.clone();
        let repo = def.source.repo_controlled();
        if repo && !input.trusted {
            // Shown as skipped, never replacing a user definition.
            winners.entry(name).or_insert(Entry {
                def,
                state: State::Untrusted,
            });
            continue;
        }
        let state = match invalid {
            Some(reason) => State::Invalid(reason),
            None => match validate_server_name(&name) {
                Err(reason) => State::Invalid(reason),
                Ok(()) => match &def.transport {
                    Transport::Sse { .. } => State::Invalid(
                        "sse transport is not supported by dsh; use the server's streamable HTTP endpoint".into(),
                    ),
                    _ => State::Ready,
                },
            },
        };
        winners.insert(name, Entry { def, state });
    }

    let disabled = user_disabled(user_root.as_ref());
    for entry in winners.values_mut() {
        let off = disabled.contains(&entry.def.name) || !entry.def.enabled;
        if off {
            discovery.disabled.insert(entry.def.name.clone());
            if entry.state == State::Ready {
                entry.state = State::Disabled;
            }
        }
    }
    for name in &disabled {
        discovery.disabled.insert(name.clone());
    }
    discovery.entries = winners.into_values().collect();

    // Output cap: requirements > env > trusted repo > user > managed > default.
    let env_bytes = |key: &str| {
        env.get(key)
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|value| *value > 0)
    };
    let (bytes, source) = if let Some(value) = max_output_from(requirements_root.as_ref()) {
        (value, "requirements.toml")
    } else if let Some(value) = env_bytes("GROK_MAX_MCP_OUTPUT_BYTES") {
        (value, "GROK_MAX_MCP_OUTPUT_BYTES")
    } else if let Some(value) = env_bytes("MAX_MCP_OUTPUT_BYTES") {
        (value, "MAX_MCP_OUTPUT_BYTES")
    } else if let Some(value) = project_max {
        (value, "project .grok/config.toml")
    } else if let Some(value) = max_output_from(user_root.as_ref()) {
        (value, "config.toml")
    } else if let Some(value) = max_output_from(managed_root.as_ref()) {
        (value, "managed_config.toml")
    } else {
        (DEFAULT_MAX_OUTPUT_BYTES, "default")
    };
    discovery.max_output_bytes = bytes;
    discovery.max_output_source = source.into();
    discovery
}

/// Absolute program for a stdio command: a path (relative to `cwd`) or a
/// bare name on `PATH`. `None` means the program does not exist.
pub fn resolve_program(
    command: &str,
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    let has_separator = command.contains('/') || (cfg!(windows) && command.contains('\\'));
    if has_separator {
        let path = Path::new(command);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        };
        return is_program(&path).then_some(path);
    }
    let search = env.get("PATH").cloned().unwrap_or_default();
    let extensions: Vec<String> = if cfg!(windows) {
        env.get("PATHEXT")
            .cloned()
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .map(str::to_string)
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&search) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for extension in &extensions {
            let candidate = dir.join(format!("{command}{extension}"));
            if is_program(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn is_program(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn pairs(map: &BTreeMap<String, String>) -> JsonValue {
    JsonValue::Array(
        map.iter()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect(),
    )
}

fn entry_json(entry: &Entry) -> serde_json::Map<String, JsonValue> {
    let mut object = serde_json::Map::new();
    object.insert("name".into(), json!(entry.def.name));
    object.insert("scope".into(), json!(entry.def.source.scope()));
    object.insert(
        "source".into(),
        json!(entry.def.source.path().display().to_string()),
    );
    object.insert("transport".into(), json!(entry.def.transport.kind()));
    object.insert("target".into(), json!(entry.def.transport.target()));
    if !entry.def.notes.is_empty() {
        object.insert("notes".into(), json!(entry.def.notes));
    }
    object
}

/// Directory for one dsh child's plan, proxy status files, stderr logs,
/// and the tool catalog the dsh plugin writes.
pub fn run_dir(dsh_home: &Path, tag: &str) -> PathBuf {
    dsh_home
        .join("mcp")
        .join(format!("run-{}-{tag}", std::process::id()))
}

/// Build the plan dsh mounts. Stdio servers go through the proxy launcher
/// when this executable is known; otherwise dsh starts the program itself.
pub fn build_plan(
    discovery: &Discovery,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    dir: &Path,
    proxy: Option<&Path>,
) -> JsonValue {
    let mut servers = Vec::new();
    let mut skipped = Vec::new();
    let mut budget: u64 = 0;
    for entry in &discovery.entries {
        let mut object = entry_json(entry);
        match &entry.state {
            State::Ready => {}
            State::Disabled => {
                object.insert("state".into(), json!("disabled"));
                object.insert("reason".into(), json!("disabled in config"));
                skipped.push(JsonValue::Object(object));
                continue;
            }
            State::Untrusted => {
                object.insert("state".into(), json!("untrusted"));
                object.insert(
                    "reason".into(),
                    json!("repo-local server not started for an untrusted folder"),
                );
                skipped.push(JsonValue::Object(object));
                continue;
            }
            State::Invalid(reason) => {
                object.insert("state".into(), json!("invalid"));
                object.insert("reason".into(), json!(reason));
                skipped.push(JsonValue::Object(object));
                continue;
            }
        }
        let startup = startup_timeout_ms(&entry.def, env);
        let tool_ms = entry
            .def
            .tool_timeout_sec
            .map(|secs| (secs * 1000.0) as u64)
            .unwrap_or(DEFAULT_TOOL_TIMEOUT_MS);
        object.insert("startupTimeoutMs".into(), json!(startup));
        object.insert(
            "toolTimeoutMs".into(),
            json!(tool_ms.min(DSH_TOOL_CALL_LIMIT_MS)),
        );
        let acp = match &entry.def.transport {
            Transport::Stdio {
                command,
                args,
                env: server_env,
                cwd: server_cwd,
            } => {
                let run_cwd = server_cwd
                    .as_ref()
                    .map(|dir| {
                        let path = Path::new(dir);
                        if path.is_absolute() {
                            path.to_path_buf()
                        } else {
                            cwd.join(path)
                        }
                    })
                    .unwrap_or_else(|| cwd.to_path_buf());
                let mut lookup = env.clone();
                if let Some(path) = server_env.get("PATH") {
                    lookup.insert("PATH".into(), path.clone());
                }
                let Some(program) = resolve_program(command, &run_cwd, &lookup) else {
                    object.insert("state".into(), json!("failed"));
                    object.insert(
                        "reason".into(),
                        json!(format!("command not found: {command}")),
                    );
                    skipped.push(JsonValue::Object(object));
                    continue;
                };
                match proxy {
                    Some(exe) => {
                        let mut proxy_args = vec![
                            PROXY_SUBCOMMAND.to_string(),
                            "--name".into(),
                            entry.def.name.clone(),
                            "--dir".into(),
                            dir.display().to_string(),
                            "--startup-timeout-ms".into(),
                            startup.to_string(),
                            "--tool-timeout-ms".into(),
                            tool_ms.to_string(),
                        ];
                        for (tool, secs) in &entry.def.tool_timeouts {
                            proxy_args.push("--tool-timeout".into());
                            proxy_args.push(format!("{tool}={}", (secs * 1000.0) as u64));
                        }
                        if server_cwd.is_some() {
                            proxy_args.push("--cwd".into());
                            proxy_args.push(run_cwd.display().to_string());
                        }
                        proxy_args.push("--".into());
                        proxy_args.push(program.display().to_string());
                        proxy_args.extend(args.iter().cloned());
                        json!({
                            "name": entry.def.name,
                            "command": exe.display().to_string(),
                            "args": proxy_args,
                            "env": pairs(server_env),
                        })
                    }
                    None => json!({
                        "name": entry.def.name,
                        "command": program.display().to_string(),
                        "args": args,
                        "env": pairs(server_env),
                    }),
                }
            }
            Transport::Http { url, headers } => json!({
                "type": "http",
                "name": entry.def.name,
                "url": url,
                "headers": pairs(headers),
            }),
            Transport::Sse { .. } => continue,
        };
        budget = budget.saturating_add(startup);
        object.insert("acp".into(), acp);
        servers.push(JsonValue::Object(object));
    }
    json!({
        "version": 1,
        "runDir": dir.display().to_string(),
        "maxOutputBytes": discovery.max_output_bytes,
        "maxOutputSource": discovery.max_output_source,
        "startupBudgetMs": budget,
        "servers": servers,
        "skipped": skipped,
    })
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the pid exists.
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

/// Remove run directories left by processes that no longer exist.
fn prune_runs(dsh_home: &Path) {
    let Ok(entries) = fs::read_dir(dsh_home.join("mcp")) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix("run-") else {
            continue;
        };
        let pid = rest
            .split('-')
            .next()
            .and_then(|pid| pid.parse::<u32>().ok());
        if let Some(pid) = pid
            && pid != std::process::id()
            && !pid_alive(pid)
        {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Write the plan for one dsh child and return its path. Status files from
/// a previous start of the same child are cleared first.
pub fn write_plan(
    dsh_home: &Path,
    tag: &str,
    discovery: &Discovery,
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> io::Result<PathBuf> {
    prune_runs(dsh_home);
    let dir = run_dir(dsh_home, tag);
    fs::create_dir_all(&dir)?;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "status") {
                let _ = fs::remove_file(path);
            }
        }
    }
    let proxy = std::env::current_exe().ok();
    let plan = build_plan(discovery, cwd, env, &dir, proxy.as_deref());
    let path = dir.join("plan.json");
    let tmp = dir.join("plan.json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(&plan).unwrap_or_default())?;
    fs::rename(&tmp, &path)?;
    Ok(path)
}

pub fn read_plan(path: &Path) -> Option<JsonValue> {
    read_json(path)
}

/// ACP `mcpServers` from a plan, minus servers that already failed.
pub fn plan_servers(plan: &JsonValue, failed: &BTreeMap<String, String>) -> Vec<JsonValue> {
    plan.get("servers")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter(|server| {
            server
                .get("name")
                .and_then(JsonValue::as_str)
                .is_some_and(|name| !failed.contains_key(name))
        })
        .filter_map(|server| server.get("acp").cloned())
        .collect()
}

/// Server named by dsh's startup error `mcp-client(<name>): ...`.
pub fn failed_server(details: &str) -> Option<String> {
    let start = details.find("mcp-client(")? + "mcp-client(".len();
    let end = details[start..].find(')')?;
    Some(details[start..start + end].to_string())
}

fn tail(text: &str, lines: usize) -> String {
    let collected: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let start = collected.len().saturating_sub(lines);
    collected[start..].join(" | ")
}

/// Why a server failed to start: the proxy's status line, then the last
/// stderr lines, then dsh's own message.
pub fn failure_reason(dir: &Path, name: &str, fallback: &str) -> String {
    let status = fs::read_to_string(dir.join(format!("{name}.status"))).unwrap_or_default();
    let stderr = fs::read_to_string(dir.join(format!("{name}.stderr.log"))).unwrap_or_default();
    let mut reason = status.trim().to_string();
    if reason.is_empty() {
        reason = fallback.to_string();
    }
    let stderr = tail(&stderr, 3);
    if !stderr.is_empty() {
        let clipped: String = stderr.chars().take(400).collect();
        reason = format!("{reason}; stderr: {clipped}");
    }
    reason
}

pub fn catalog_path(dir: &Path, session_id: &str) -> PathBuf {
    dir.join(format!("catalog-{session_id}.json"))
}

/// One server as `/mcps` shows it.
#[derive(Clone, Debug, PartialEq)]
pub struct ServerRow {
    pub name: String,
    pub scope: String,
    pub target: String,
    /// connected, failed, disabled, untrusted or invalid.
    pub state: String,
    pub reason: Option<String>,
    pub tools: Vec<String>,
}

fn str_field(value: &JsonValue, key: &str) -> String {
    value
        .get(key)
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Rows for the plan this session mounted: planned servers are connected or
/// failed (dsh's startup error), skipped ones keep the plan's reason. Tool
/// names come from the catalog the dsh plugin wrote for this session.
pub fn server_rows(
    plan: &JsonValue,
    failed: &BTreeMap<String, String>,
    catalog: Option<&JsonValue>,
) -> Vec<ServerRow> {
    let mut rows = Vec::new();
    let tools_of = |name: &str| -> Vec<String> {
        catalog
            .and_then(|catalog| catalog.get("servers"))
            .and_then(|servers| servers.get(name))
            .and_then(|server| server.get("tools"))
            .and_then(JsonValue::as_array)
            .map(|tools| {
                tools
                    .iter()
                    .filter_map(|tool| tool.get("tool").and_then(JsonValue::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    for server in plan
        .get("servers")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
    {
        let name = str_field(server, "name");
        let (state, reason, tools) = match failed.get(&name) {
            Some(reason) => ("failed".to_string(), Some(reason.clone()), Vec::new()),
            None => ("connected".to_string(), None, tools_of(&name)),
        };
        rows.push(ServerRow {
            scope: str_field(server, "scope"),
            target: str_field(server, "target"),
            name,
            state,
            reason,
            tools,
        });
    }
    for server in plan
        .get("skipped")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
    {
        rows.push(ServerRow {
            name: str_field(server, "name"),
            scope: str_field(server, "scope"),
            target: str_field(server, "target"),
            state: str_field(server, "state"),
            reason: server
                .get("reason")
                .and_then(JsonValue::as_str)
                .map(str::to_string),
            tools: Vec::new(),
        });
    }
    // Editor-declared servers are not in the plan; the catalog still has them.
    if let Some(servers) = catalog
        .and_then(|catalog| catalog.get("servers"))
        .and_then(JsonValue::as_object)
    {
        for name in servers.keys() {
            if !rows.iter().any(|row| &row.name == name) {
                rows.push(ServerRow {
                    name: name.clone(),
                    scope: "editor".into(),
                    target: String::new(),
                    state: "connected".into(),
                    reason: None,
                    tools: tools_of(name),
                });
            }
        }
    }
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    rows
}

/// One line per server that should have started but did not.
pub fn startup_notices(rows: &[ServerRow]) -> Vec<String> {
    rows.iter()
        .filter(|row| row.state == "failed" || row.state == "invalid")
        .map(|row| {
            format!(
                "MCP server {} {}: {}",
                row.name,
                row.state,
                row.reason.as_deref().unwrap_or("unknown error")
            )
        })
        .collect()
}

/// The `/mcps` report.
pub fn render_rows(rows: &[ServerRow], max_output: Option<u64>) -> String {
    if rows.is_empty() {
        return "No MCP servers configured. Add one with `codsh --rust mcp add <name> -- <command>` and run /mcps refresh.".into();
    }
    let mut lines = vec!["MCP servers".to_string()];
    for row in rows {
        let mark = match row.state.as_str() {
            "connected" => "✓",
            "disabled" => "○",
            _ => "✗",
        };
        let mut line = format!("  {mark} {} [{}] {}", row.name, row.scope, row.state);
        if row.state == "connected" {
            let count = row.tools.len();
            line.push_str(&format!(
                " · {count} tool{}",
                if count == 1 { "" } else { "s" }
            ));
        }
        if let Some(reason) = &row.reason {
            line.push_str(&format!(" · {reason}"));
        }
        lines.push(line);
        if !row.tools.is_empty() {
            lines.push(format!("      {}", row.tools.join(", ")));
        }
    }
    if let Some(bytes) = max_output {
        lines.push(format!("  output limit {bytes} bytes per call"));
    }
    lines.push("  /mcps enable|disable|restart <name> · /mcps refresh".into());
    lines.join("\n")
}

/// Rows for a live client, reading its plan and this session's catalog.
pub fn live_rows(
    plan_path: Option<&Path>,
    session_id: Option<&str>,
    failed: &BTreeMap<String, String>,
) -> Option<(Vec<ServerRow>, Option<u64>)> {
    let path = plan_path?;
    let plan = read_plan(path)?;
    let dir = path.parent()?;
    let catalog = session_id.and_then(|id| read_json(&catalog_path(dir, id)));
    let max = plan.get("maxOutputBytes").and_then(JsonValue::as_u64);
    Some((server_rows(&plan, failed, catalog.as_ref()), max))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Slash {
    List,
    Enable(String),
    Disable(String),
    Restart(Option<String>),
}

/// `/mcps` (alias `/mcp`) with an optional action.
pub fn parse_slash(text: &str) -> Option<Result<Slash, String>> {
    let trimmed = text.trim();
    let rest = ["/mcps", "/mcp"].iter().find_map(|prefix| {
        trimmed
            .strip_prefix(prefix)
            .filter(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace))
    })?;
    let words: Vec<&str> = rest.split_whitespace().collect();
    let usage = || Err("usage: /mcps [enable|disable|restart <name> | refresh]".to_string());
    Some(match words.as_slice() {
        [] | ["list"] => Ok(Slash::List),
        ["enable", name] => Ok(Slash::Enable((*name).to_string())),
        ["disable", name] => Ok(Slash::Disable((*name).to_string())),
        ["restart", name] => Ok(Slash::Restart(Some((*name).to_string()))),
        ["restart"] | ["refresh"] | ["reload"] => Ok(Slash::Restart(None)),
        _ => usage(),
    })
}

// ---------------------------------------------------------------------------
// Config edits. Line-based so comments and unrelated tables survive; every
// result is parsed before it is written.
// ---------------------------------------------------------------------------

fn bare_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn toml_key(key: &str) -> String {
    if bare_key(key) {
        key.to_string()
    } else {
        TomlValue::String(key.to_string()).to_string()
    }
}

fn toml_str(value: &str) -> String {
    TomlValue::String(value.to_string()).to_string()
}

/// Keys of a `[a.b."c"]` / `[[a.b]]` header line.
fn header_keys(line: &str) -> Option<Vec<String>> {
    let trimmed = line.trim();
    let inner = if let Some(rest) = trimmed.strip_prefix("[[") {
        rest.split("]]").next()?
    } else {
        let rest = trimmed.strip_prefix('[')?;
        let end = rest.rfind(']')?;
        let after = rest[end + 1..].trim();
        if !after.is_empty() && !after.starts_with('#') {
            return None;
        }
        &rest[..end]
    };
    let mut keys = Vec::new();
    let mut chars = inner.trim().chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let mut key = String::new();
        match chars.peek() {
            Some('"') => {
                chars.next();
                let mut escaped = false;
                for c in chars.by_ref() {
                    if escaped {
                        key.push(c);
                        escaped = false;
                    } else if c == '\\' {
                        escaped = true;
                    } else if c == '"' {
                        break;
                    } else {
                        key.push(c);
                    }
                }
            }
            Some('\'') => {
                chars.next();
                for c in chars.by_ref() {
                    if c == '\'' {
                        break;
                    }
                    key.push(c);
                }
            }
            Some(_) => {
                while let Some(&c) = chars.peek() {
                    if c == '.' || c.is_whitespace() {
                        break;
                    }
                    key.push(c);
                    chars.next();
                }
            }
            None => break,
        }
        keys.push(key);
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        match chars.next() {
            Some('.') => continue,
            None => break,
            Some(_) => return None,
        }
    }
    (!keys.is_empty()).then_some(keys)
}

fn is_server_header(keys: &[String], name: &str) -> bool {
    keys.len() >= 2 && keys[0] == "mcp_servers" && keys[1] == name
}

fn server_defined(root: &TomlValue, name: &str) -> bool {
    root.get("mcp_servers")
        .and_then(|servers| servers.get(name))
        .is_some()
}

/// Drop `[mcp_servers.<name>]` and its sub-tables.
fn remove_server_sections(text: &str, name: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in text.lines() {
        if let Some(keys) = header_keys(line) {
            skipping = is_server_header(&keys, name);
        }
        if !skipping {
            out.push(line);
        }
    }
    let mut body = out.join("\n");
    while body.ends_with("\n\n") {
        body.pop();
    }
    body
}

/// Structural fallback for inline or dotted definitions. Comments in the
/// file are not kept on this path.
fn remove_server_structural(text: &str, name: &str) -> Result<String, String> {
    let mut root: TomlValue = toml::from_str(text).map_err(|error| error.to_string())?;
    if let Some(servers) = root
        .get_mut("mcp_servers")
        .and_then(TomlValue::as_table_mut)
    {
        servers.remove(name);
    }
    toml::to_string(&root).map_err(|error| error.to_string())
}

pub fn remove_server_text(text: &str, name: &str) -> Result<String, String> {
    let body = remove_server_sections(text, name);
    let parsed: TomlValue = toml::from_str(&body).map_err(|error| error.to_string())?;
    if server_defined(&parsed, name) {
        return remove_server_structural(&body, name);
    }
    Ok(body)
}

fn inline_table(map: &BTreeMap<String, String>) -> String {
    let items: Vec<String> = map
        .iter()
        .map(|(key, value)| format!("{} = {}", toml_key(key), toml_str(value)))
        .collect();
    format!("{{ {} }}", items.join(", "))
}

pub fn render_server(name: &str, transport: &Transport) -> String {
    let mut lines = vec![format!("[mcp_servers.{}]", toml_key(name))];
    match transport {
        Transport::Stdio {
            command, args, env, ..
        } => {
            lines.push(format!("command = {}", toml_str(command)));
            if !args.is_empty() {
                let items: Vec<String> = args.iter().map(|arg| toml_str(arg)).collect();
                lines.push(format!("args = [{}]", items.join(", ")));
            }
            if !env.is_empty() {
                lines.push(format!("env = {}", inline_table(env)));
            }
        }
        Transport::Http { url, headers } | Transport::Sse { url, headers } => {
            lines.push(format!("url = {}", toml_str(url)));
            if matches!(transport, Transport::Sse { .. }) {
                lines.push("transport_type = \"sse\"".into());
            }
            if !headers.is_empty() {
                lines.push(format!("headers = {}", inline_table(headers)));
            }
        }
    }
    lines.join("\n")
}

pub fn add_server_text(text: &str, name: &str, transport: &Transport) -> Result<String, String> {
    let mut body = remove_server_text(text, name)?;
    let trimmed = body.trim_end().len();
    body.truncate(trimmed);
    if !body.is_empty() {
        body.push_str("\n\n");
    }
    body.push_str(&render_server(name, transport));
    body.push('\n');
    Ok(body)
}

/// Replace, insert, or drop the top-level `disabled_mcp_servers` array.
pub fn set_disabled_text(text: &str, names: &BTreeSet<String>) -> String {
    let rendered = if names.is_empty() {
        None
    } else {
        let items: Vec<String> = names.iter().map(|name| toml_str(name)).collect();
        Some(format!("disabled_mcp_servers = [{}]", items.join(", ")))
    };
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<String> = Vec::new();
    let mut index = 0;
    let mut replaced = false;
    let mut in_top = true;
    while index < lines.len() {
        let line = lines[index];
        if header_keys(line).is_some() {
            in_top = false;
        }
        let key = line.split('=').next().unwrap_or("").trim();
        if in_top && !replaced && line.contains('=') && key == "disabled_mcp_servers" {
            // Consume a multi-line array.
            let mut depth: i32 = 0;
            let mut end = index;
            loop {
                let current = lines[end];
                let code = current.split('#').next().unwrap_or("");
                depth += code.matches('[').count() as i32 - code.matches(']').count() as i32;
                if depth <= 0 || end + 1 >= lines.len() {
                    break;
                }
                end += 1;
            }
            if let Some(rendered) = &rendered {
                out.push(rendered.clone());
            }
            replaced = true;
            index = end + 1;
            continue;
        }
        out.push(line.to_string());
        index += 1;
    }
    if !replaced && let Some(rendered) = rendered {
        out.insert(0, rendered);
    }
    let mut body = out.join("\n");
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    body
}

/// Set `enabled` inside `[mcp_servers.<name>]`, or remove it when `value`
/// is `None`. Returns `None` when that table header is not in the file.
pub fn set_entry_enabled_text(text: &str, name: &str, value: Option<bool>) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<String> = Vec::new();
    let mut found = false;
    let mut inside = false;
    let mut wrote = false;
    for line in &lines {
        if let Some(keys) = header_keys(line) {
            if inside && !wrote {
                if let Some(value) = value {
                    out.push(format!("enabled = {value}"));
                }
                wrote = true;
            }
            inside = keys.len() == 2 && is_server_header(&keys, name);
            if inside {
                found = true;
                wrote = false;
            }
            out.push(line.to_string());
            continue;
        }
        if inside {
            let key = line.split('=').next().unwrap_or("").trim();
            if line.contains('=') && key == "enabled" {
                if let Some(value) = value {
                    out.push(format!("enabled = {value}"));
                }
                wrote = true;
                continue;
            }
        }
        out.push(line.to_string());
    }
    if inside
        && !wrote
        && let Some(value) = value
    {
        out.push(format!("enabled = {value}"));
    }
    if !found {
        return None;
    }
    let mut body = out.join("\n");
    body.push('\n');
    Some(body)
}

fn write_config(path: &Path, body: &str) -> io::Result<()> {
    if crate::filesystem_sandbox::session_only_write(path) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the sandbox protects this config file; it was not written",
        ));
    }
    if let Err(error) = toml::from_str::<TomlValue>(body) {
        return Err(io::Error::other(format!(
            "refusing to write {}: the edit would not be valid TOML ({error})",
            path.display()
        )));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("toml.mcp-tmp");
    {
        use std::io::Write;
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(body.as_bytes())?;
        file.flush()?;
    }
    fs::rename(&tmp, path).or_else(|_| {
        fs::copy(&tmp, path)?;
        fs::remove_file(&tmp)
    })
}

fn read_text(path: &Path) -> io::Result<String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error),
    }
}

pub fn defined_at(path: &Path, name: &str) -> bool {
    read_toml(path).is_some_and(|root| server_defined(&root, name))
}

/// Persist the personal on/off state. Returns the files that changed.
pub fn save_enabled(
    user_config: &Path,
    cwd: &Path,
    name: &str,
    enabled: bool,
) -> io::Result<Vec<PathBuf>> {
    let mut modified = Vec::new();
    let text = read_text(user_config)?;
    let mut list = user_disabled(toml::from_str::<TomlValue>(&text).ok().as_ref());
    if enabled {
        list.remove(name);
    } else {
        list.insert(name.to_string());
    }
    let mut body = set_disabled_text(&text, &list);
    if let Some(updated) = set_entry_enabled_text(&body, name, Some(enabled)) {
        body = updated;
    }
    if body != text {
        write_config(user_config, &body)?;
        modified.push(user_config.to_path_buf());
    }
    if enabled {
        // A sticky `enabled = false` in the nearest project definition would
        // keep the server off; clear only that key.
        let nearest = project_config_files(cwd, user_config)
            .into_iter()
            .rev()
            .find(|path| defined_at(path, name));
        if let Some(path) = nearest {
            let text = read_text(&path)?;
            let sticky = toml::from_str::<TomlValue>(&text).ok().and_then(|root| {
                root.get("mcp_servers")
                    .and_then(|servers| servers.get(name))
                    .and_then(|entry| entry.get("enabled"))
                    .and_then(TomlValue::as_bool)
            }) == Some(false);
            if sticky && let Some(body) = set_entry_enabled_text(&text, name, None) {
                write_config(&path, &body)?;
                modified.push(path);
            }
        }
    }
    Ok(modified)
}

// ---------------------------------------------------------------------------
// `codsh --rust mcp ...`
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    User,
    Project,
}

impl Scope {
    fn label(self) -> &'static str {
        match self {
            Scope::User => "user",
            Scope::Project => "project",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "user" => Ok(Scope::User),
            "project" => Ok(Scope::Project),
            other => Err(format!(
                "invalid value '{other}' for '--scope <SCOPE>'\n  [possible values: user, project]"
            )),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AddArgs {
    pub name: String,
    pub command_or_url: Option<String>,
    pub args: Vec<String>,
    pub transport: Option<String>,
    pub scope: Scope,
    pub env: Vec<String>,
    pub headers: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum McpCommand {
    Help(&'static str),
    List { json: bool },
    Add(AddArgs),
    Remove { name: String, scope: Option<Scope> },
    Enable { name: String },
    Disable { name: String },
    Doctor { json: bool, name: Option<String> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpInvocation {
    pub command: McpCommand,
    pub debug: bool,
    pub debug_file: Option<PathBuf>,
}

const COMMON_OPTIONS: &str = "      --debug                 Enable debug logging
      --debug-file <FILE>     Write debug logs to FILE
  -h, --help                  Print help
      --leader-socket <PATH>  Refused: dsh owns execution, so there is no leader socket to choose";

pub fn help(topic: &str) -> String {
    match topic {
        "list" => format!(
            "List configured MCP servers\n\nUsage: codsh --rust mcp list [OPTIONS]\n\nOptions:\n      --json                  Emit machine-readable JSON output\n{COMMON_OPTIONS}"
        ),
        "add" => format!(
            "Add or update an MCP server\n\nUsage: codsh --rust mcp add [OPTIONS] <NAME> [COMMAND_OR_URL] [ARGS]...\n\nArguments:\n  <NAME>            Server name\n  [COMMAND_OR_URL]  Command to launch (stdio) or URL to connect to (http, sse)\n  [ARGS]...         Arguments passed to the server command. Place them after `--` so flags such as `-y` are passed to the server instead of codsh\n\nOptions:\n  -t, --transport <TRANSPORT>  Transport type. Defaults to stdio, or to http when the positional argument is an http(s):// URL [possible values: stdio, http, sse]\n  -s, --scope <SCOPE>          Config to write to: user ($GROK_HOME/config.toml) or project (./.grok/config.toml) [default: user]\n  -e, --env <KEY=value>        Environment variable for the server process (repeatable)\n  -H, --header <NAME: VALUE>   HTTP header for remote servers (repeatable)\n{COMMON_OPTIONS}\n\nsse is written to config but not started: dsh has no SSE transport.\n\nExamples:\n  # Add a stdio server (everything after -- is the server command)\n  codsh --rust mcp add xcode -- xcrun mcpbridge\n\n  # Add a stdio server with environment variables\n  codsh --rust mcp add postgres -e DATABASE_URL=postgres://localhost/mydb -- npx -y @modelcontextprotocol/server-postgres\n\n  # Add a remote HTTP server\n  codsh --rust mcp add --transport http sentry https://mcp.sentry.dev/mcp\n\n  # Add a remote server with an authentication header\n  codsh --rust mcp add --transport http api https://mcp.example.com/mcp --header \"Authorization: Bearer YOUR_TOKEN\"\n\n  # Add to the project config (./.grok/config.toml) instead of $GROK_HOME/config.toml\n  codsh --rust mcp add --scope project github -- npx -y @modelcontextprotocol/server-github"
        ),
        "remove" => format!(
            "Remove an MCP server\n\nUsage: codsh --rust mcp remove [OPTIONS] <NAME>\n\nArguments:\n  <NAME>  Server name to remove\n\nOptions:\n  -s, --scope <SCOPE>         Config to remove from. When omitted, all scopes are searched [possible values: user, project]\n{COMMON_OPTIONS}"
        ),
        "enable" => format!(
            "Enable an MCP server\n\nUsage: codsh --rust mcp enable [OPTIONS] <NAME>\n\nArguments:\n  <NAME>  Server name\n\nOptions:\n{COMMON_OPTIONS}"
        ),
        "disable" => format!(
            "Disable an MCP server\n\nUsage: codsh --rust mcp disable [OPTIONS] <NAME>\n\nArguments:\n  <NAME>  Server name\n\nOptions:\n{COMMON_OPTIONS}"
        ),
        "doctor" => format!(
            "Diagnose MCP server configuration and connectivity\n\nUsage: codsh --rust mcp doctor [OPTIONS] [NAME]\n\nArguments:\n  [NAME]  Server name to check\n\nOptions:\n      --json                  Emit machine-readable JSON output\n{COMMON_OPTIONS}\n\nDoctor starts each enabled, trusted server once with its own short-lived MCP handshake (initialize, tools/list) and stops it. It does not create a dsh session."
        ),
        _ => format!(
            "Manage MCP server configurations\n\nUsage: codsh --rust mcp [OPTIONS] <COMMAND>\n\nCommands:\n  list     List configured MCP servers\n  add      Add or update an MCP server\n  remove   Remove an MCP server\n  enable   Enable an MCP server\n  disable  Disable an MCP server\n  doctor   Diagnose MCP server configuration and connectivity\n  help     Print this message or the help of the given subcommand(s)\n\nOptions:\n{COMMON_OPTIONS}\n\nServers come from [mcp_servers.<name>] in $GROK_HOME/config.toml and, in a trusted folder, .grok/config.toml (cwd to git root), .mcp.json, and project .cursor/mcp.json; ~/.claude.json and ~/.cursor/mcp.json follow [compat.claude|cursor] mcps. dsh mounts them per session and executes every call; the model reaches them as search_tool / use_tool and as the direct mcp__<server>__<tool> tools. /mcps lists status and tools in a session."
        ),
    }
}

fn topic_name(sub: &str) -> Option<&'static str> {
    match sub {
        "list" => Some("list"),
        "add" => Some("add"),
        "remove" => Some("remove"),
        "enable" => Some("enable"),
        "disable" => Some("disable"),
        "doctor" => Some("doctor"),
        _ => None,
    }
}

pub fn parse(args: &[&str]) -> Result<McpInvocation, String> {
    let mut debug = false;
    let mut debug_file = None;
    let mut rest: Vec<&str> = Vec::new();
    let mut index = 0;
    let mut literal = false;
    // Global flags may appear anywhere before `--`.
    while index < args.len() {
        let arg = args[index];
        if literal {
            rest.push(arg);
            index += 1;
            continue;
        }
        match arg {
            "--" => {
                literal = true;
                rest.push(arg);
            }
            "--debug" => debug = true,
            "--debug-file" => {
                index += 1;
                let Some(path) = args.get(index) else {
                    return Err(
                        "a value is required for '--debug-file <FILE>' but none was supplied"
                            .into(),
                    );
                };
                debug_file = Some(PathBuf::from(path));
            }
            value if value.starts_with("--debug-file=") => {
                debug_file = Some(PathBuf::from(&value["--debug-file=".len()..]));
            }
            value if value == "--leader-socket" || value.starts_with("--leader-socket=") => {
                return Err("mcp --leader-socket is refused: dsh owns execution".into());
            }
            _ => rest.push(arg),
        }
        index += 1;
    }
    let wants_help = |items: &[&str]| {
        items
            .iter()
            .take_while(|item| **item != "--")
            .any(|item| *item == "-h" || *item == "--help")
    };
    let command = match rest.as_slice() {
        [] => McpCommand::Help(""),
        ["help"] => McpCommand::Help(""),
        ["help", sub, ..] => McpCommand::Help(topic_name(sub).unwrap_or("")),
        [sub, tail @ ..] if topic_name(sub).is_some() && wants_help(tail) => {
            McpCommand::Help(topic_name(sub).unwrap_or(""))
        }
        items if wants_help(items) => McpCommand::Help(""),
        ["list", tail @ ..] => {
            let mut json = false;
            for item in tail {
                match *item {
                    "--json" => json = true,
                    other => {
                        return Err(format!(
                            "unexpected argument '{other}' found\n\nUsage: codsh --rust mcp list [OPTIONS]"
                        ));
                    }
                }
            }
            McpCommand::List { json }
        }
        ["doctor", tail @ ..] => {
            let mut json = false;
            let mut name = None;
            for item in tail {
                match *item {
                    "--json" => json = true,
                    other if other.starts_with('-') => {
                        return Err(format!(
                            "unexpected argument '{other}' found\n\nUsage: codsh --rust mcp doctor [OPTIONS] [NAME]"
                        ));
                    }
                    other if name.is_none() => name = Some(other.to_string()),
                    other => {
                        return Err(format!(
                            "unexpected argument '{other}' found\n\nUsage: codsh --rust mcp doctor [OPTIONS] [NAME]"
                        ));
                    }
                }
            }
            McpCommand::Doctor { json, name }
        }
        [sub @ ("enable" | "disable"), tail @ ..] => {
            let mut name = None;
            for item in tail {
                if item.starts_with('-') || name.is_some() {
                    return Err(format!(
                        "unexpected argument '{item}' found\n\nUsage: codsh --rust mcp {sub} [OPTIONS] <NAME>"
                    ));
                }
                name = Some(item.to_string());
            }
            let Some(name) = name else {
                return Err(format!(
                    "the following required arguments were not provided:\n  <NAME>\n\nUsage: codsh --rust mcp {sub} [OPTIONS] <NAME>"
                ));
            };
            if *sub == "enable" {
                McpCommand::Enable { name }
            } else {
                McpCommand::Disable { name }
            }
        }
        ["remove", tail @ ..] => {
            let mut name = None;
            let mut scope = None;
            let mut index = 0;
            while index < tail.len() {
                let item = tail[index];
                match item {
                    "-s" | "--scope" => {
                        index += 1;
                        let value = tail.get(index).ok_or(
                            "a value is required for '--scope <SCOPE>' but none was supplied",
                        )?;
                        scope = Some(Scope::parse(value)?);
                    }
                    value if value.starts_with("--scope=") => {
                        scope = Some(Scope::parse(&value["--scope=".len()..])?);
                    }
                    value if value.starts_with('-') || name.is_some() => {
                        return Err(format!(
                            "unexpected argument '{value}' found\n\nUsage: codsh --rust mcp remove [OPTIONS] <NAME>"
                        ));
                    }
                    value => name = Some(value.to_string()),
                }
                index += 1;
            }
            let Some(name) = name else {
                return Err("the following required arguments were not provided:\n  <NAME>\n\nUsage: codsh --rust mcp remove [OPTIONS] <NAME>".into());
            };
            McpCommand::Remove { name, scope }
        }
        ["add", tail @ ..] => McpCommand::Add(parse_add(tail)?),
        [other, ..] => {
            return Err(format!(
                "unrecognized subcommand '{other}'\n\nUsage: codsh --rust mcp [OPTIONS] <COMMAND>\n\nFor more information, try 'codsh --rust mcp --help'."
            ));
        }
    };
    Ok(McpInvocation {
        command,
        debug,
        debug_file,
    })
}

fn parse_add(tail: &[&str]) -> Result<AddArgs, String> {
    let usage = "\n\nUsage: codsh --rust mcp add [OPTIONS] <NAME> [COMMAND_OR_URL] [ARGS]...";
    let mut positional: Vec<String> = Vec::new();
    let mut transport = None;
    let mut scope = Scope::User;
    let mut env = Vec::new();
    let mut headers = Vec::new();
    let mut index = 0;
    let mut literal = false;
    let take = |index: &mut usize, flag: &str| -> Result<String, String> {
        *index += 1;
        tail.get(*index)
            .map(|value| value.to_string())
            .ok_or_else(|| format!("a value is required for '{flag}' but none was supplied{usage}"))
    };
    while index < tail.len() {
        let item = tail[index];
        if literal {
            positional.push(item.to_string());
            index += 1;
            continue;
        }
        match item {
            "--" => literal = true,
            "-t" | "--transport" => transport = Some(take(&mut index, "--transport <TRANSPORT>")?),
            "-s" | "--scope" => scope = Scope::parse(&take(&mut index, "--scope <SCOPE>")?)?,
            "-e" | "--env" => env.push(take(&mut index, "--env <KEY=value>")?),
            "-H" | "--header" => headers.push(take(&mut index, "--header <NAME: VALUE>")?),
            value if value.starts_with("--transport=") => {
                transport = Some(value["--transport=".len()..].to_string());
            }
            value if value.starts_with("--scope=") => {
                scope = Scope::parse(&value["--scope=".len()..])?;
            }
            value if value.starts_with("--env=") => env.push(value["--env=".len()..].to_string()),
            value if value.starts_with("--header=") => {
                headers.push(value["--header=".len()..].to_string());
            }
            value if value.starts_with('-') && value.len() > 1 => {
                return Err(format!(
                    "unexpected argument '{value}' found\n\n  tip: to pass '{value}' as a value, use '-- {value}'{usage}"
                ));
            }
            value => positional.push(value.to_string()),
        }
        index += 1;
    }
    if let Some(kind) = &transport
        && !matches!(kind.as_str(), "stdio" | "http" | "sse")
    {
        return Err(format!(
            "invalid value '{kind}' for '--transport <TRANSPORT>'\n  [possible values: stdio, http, sse]{usage}"
        ));
    }
    let mut positional = positional.into_iter();
    let Some(name) = positional.next() else {
        return Err(format!(
            "the following required arguments were not provided:\n  <NAME>{usage}"
        ));
    };
    let command_or_url = positional.next();
    Ok(AddArgs {
        name,
        command_or_url,
        args: positional.collect(),
        transport,
        scope,
        env,
        headers,
    })
}

fn looks_like_env_pair(text: &str) -> bool {
    let Some((key, _)) = text.split_once('=') else {
        return false;
    };
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Validate an `add` request into a transport plus warnings, like the
/// reference `resolve_add`.
pub fn resolve_add(args: &AddArgs) -> Result<(Transport, Vec<String>), String> {
    if args.name.is_empty()
        || !args
            .name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "Invalid name '{}'. Names can only contain letters, numbers, hyphens, and underscores.",
            args.name
        ));
    }
    let source = args.command_or_url.as_deref();
    let inferred_http = args.transport.is_none()
        && args.args.is_empty()
        && args.env.is_empty()
        && source.is_some_and(|s| s.starts_with("http://") || s.starts_with("https://"));
    let kind = match args.transport.as_deref() {
        Some(kind) => kind,
        None if inferred_http => "http",
        None => "stdio",
    };
    let mut warnings = Vec::new();
    if kind == "stdio" {
        let Some(command) = source else {
            return Err("A command is required for stdio servers. Usage: codsh --rust mcp add <name> -- <command> [args...]".into());
        };
        if !args.headers.is_empty() {
            return Err("--header can only be used with HTTP or SSE servers.".into());
        }
        if looks_like_env_pair(command) {
            let pairs: Vec<String> = args
                .env
                .iter()
                .map(String::as_str)
                .chain([command])
                .map(|pair| format!("-e {pair}"))
                .collect();
            return Err(format!(
                "Invalid command '{command}': it looks like an environment variable. Pass each variable as its own flag: {}",
                pairs.join(" ")
            ));
        }
        let mut env = BTreeMap::new();
        for pair in &args.env {
            match pair.split_once('=') {
                Some((key, value)) if !key.is_empty() => {
                    env.insert(key.to_string(), value.to_string());
                }
                _ => {
                    return Err(format!(
                        "Invalid environment variable format: '{pair}'. Environment variables should be added as: -e KEY1=value1 -e KEY2=value2"
                    ));
                }
            }
        }
        let url_like = command.starts_with("http://")
            || command.starts_with("https://")
            || command.starts_with("localhost");
        if args.transport.is_none() && url_like {
            let suggested = if command.starts_with("http://") || command.starts_with("https://") {
                command.to_string()
            } else {
                format!("http://{command}")
            };
            warnings.push(format!(
                "Warning: '{command}' looks like a URL, but it is being added as a stdio command because --transport was not specified.\nFor a remote server, use: codsh --rust mcp add --transport http {} {suggested}",
                args.name
            ));
        }
        return Ok((
            Transport::Stdio {
                command: command.to_string(),
                args: args.args.clone(),
                env,
                cwd: None,
            },
            warnings,
        ));
    }
    let Some(url) = source else {
        return Err(format!(
            "A URL is required for {kind} servers. Usage: codsh --rust mcp add --transport {kind} <name> <url>"
        ));
    };
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!(
            "Invalid URL '{url}'. Server URLs must start with http:// or https://."
        ));
    }
    if !args.args.is_empty() {
        return Err(format!(
            "Unexpected arguments after the URL: '{}'. HTTP and SSE servers take a single URL.",
            args.args.join(" ")
        ));
    }
    if !args.env.is_empty() {
        return Err("--env can only be used with stdio servers.".into());
    }
    let mut headers = BTreeMap::new();
    for header in &args.headers {
        let Some((name, value)) = header.split_once(':') else {
            return Err(format!(
                "Invalid header format: '{header}'. Expected format: 'Name: value'"
            ));
        };
        let name = name.trim();
        if name.is_empty() {
            return Err(format!(
                "Invalid header: '{header}'. Header name cannot be empty."
            ));
        }
        headers.insert(name.to_string(), value.trim().to_string());
    }
    if inferred_http {
        warnings.push(format!(
            "No --transport given; '{url}' starts with http(s)://, adding as an HTTP server. Use --transport sse for an SSE server, or --transport stdio to force a stdio command."
        ));
    }
    if kind == "sse" {
        warnings.push(
            "Note: dsh has no SSE transport, so this server is saved but will show as invalid until it offers streamable HTTP."
                .into(),
        );
        return Ok((
            Transport::Sse {
                url: url.to_string(),
                headers,
            },
            warnings,
        ));
    }
    Ok((
        Transport::Http {
            url: url.to_string(),
            headers,
        },
        warnings,
    ))
}

/// Result of one CLI command: stdout, stderr, exit code.
#[derive(Debug, Default)]
pub struct CliOutcome {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

impl CliOutcome {
    fn out(&mut self, line: impl AsRef<str>) {
        self.stdout.push_str(line.as_ref());
        self.stdout.push('\n');
    }

    fn err(&mut self, line: impl AsRef<str>) {
        self.stderr.push_str(line.as_ref());
        self.stderr.push('\n');
    }

    fn fail(mut self, line: impl AsRef<str>) -> Self {
        self.err(line);
        self.code = 1;
        self
    }
}

fn list_json(entry: &Entry, disabled: &BTreeSet<String>) -> JsonValue {
    let mut object = serde_json::Map::new();
    object.insert("name".into(), json!(entry.def.name));
    match &entry.def.transport {
        Transport::Stdio {
            command,
            args,
            env,
            cwd,
        } => {
            object.insert("command".into(), json!(command));
            object.insert("args".into(), json!(args));
            if !env.is_empty() {
                object.insert("env".into(), json!(env));
            }
            if let Some(cwd) = cwd {
                object.insert("cwd".into(), json!(cwd));
            }
        }
        Transport::Http { url, headers } | Transport::Sse { url, headers } => {
            object.insert("url".into(), json!(url));
            if matches!(entry.def.transport, Transport::Sse { .. }) {
                object.insert("transport_type".into(), json!("sse"));
            }
            if !headers.is_empty() {
                // Values can be secrets; names are enough to diagnose.
                let names: BTreeMap<&String, &str> =
                    headers.keys().map(|name| (name, "<redacted>")).collect();
                object.insert("headers".into(), json!(names));
            }
        }
    }
    object.insert("scope".into(), json!(entry.def.source.scope()));
    object.insert(
        "source".into(),
        json!(entry.def.source.path().display().to_string()),
    );
    object.insert("enabled".into(), json!(!disabled.contains(&entry.def.name)));
    match &entry.state {
        State::Untrusted => {
            object.insert("skipped_reason".into(), json!("folder not trusted"));
        }
        State::Invalid(reason) => {
            object.insert("invalid_reason".into(), json!(reason));
        }
        _ => {}
    }
    if let Some(secs) = entry.def.startup_timeout_sec {
        object.insert("startup_timeout_sec".into(), json!(secs));
    }
    if let Some(secs) = entry.def.tool_timeout_sec {
        object.insert("tool_timeout_sec".into(), json!(secs));
    }
    if !entry.def.tool_timeouts.is_empty() {
        object.insert("tool_timeouts".into(), json!(entry.def.tool_timeouts));
    }
    JsonValue::Object(object)
}

pub fn run_list(discovery: &Discovery, json_out: bool) -> CliOutcome {
    let mut outcome = CliOutcome::default();
    for warning in &discovery.warnings {
        outcome.err(warning);
    }
    if json_out {
        let items: Vec<JsonValue> = discovery
            .entries
            .iter()
            .map(|entry| list_json(entry, &discovery.disabled))
            .collect();
        outcome.out(serde_json::to_string_pretty(&items).unwrap_or_else(|_| "[]".into()));
        return outcome;
    }
    if discovery.entries.is_empty() {
        outcome.out("No MCP servers configured. Run `codsh --rust mcp add --help` to get started.");
        return outcome;
    }
    for entry in &discovery.entries {
        let mut notes: Vec<String> = Vec::new();
        if discovery.disabled.contains(&entry.def.name) {
            notes.push("disabled".into());
        }
        match &entry.state {
            State::Untrusted => notes.push("not trusted".into()),
            State::Invalid(reason) => notes.push(format!("invalid: {reason}")),
            _ => {}
        }
        if entry.def.source.scope() != "user" {
            notes.push(entry.def.source.scope().into());
        }
        let suffix = if notes.is_empty() {
            String::new()
        } else {
            format!(" ({})", notes.join(", "))
        };
        outcome.out(format!(
            "  {}: {}{suffix}",
            entry.def.name,
            entry.def.transport.target()
        ));
    }
    outcome
}

fn scope_path(scope: Scope, ctx: &DiscoverInput<'_>) -> PathBuf {
    match scope {
        Scope::User => ctx.config_path.to_path_buf(),
        Scope::Project => canonical(ctx.cwd).join(".grok").join("config.toml"),
    }
}

pub fn run_add(ctx: &DiscoverInput<'_>, args: &AddArgs) -> CliOutcome {
    let mut outcome = CliOutcome::default();
    let (transport, warnings) = match resolve_add(args) {
        Ok(resolved) => resolved,
        Err(error) => return outcome.fail(format!("Error: {error}")),
    };
    for warning in warnings {
        outcome.err(warning);
    }
    let path = scope_path(args.scope, ctx);
    let text = match read_text(&path) {
        Ok(text) => text,
        Err(error) => {
            return outcome.fail(format!("Error: cannot read {}: {error}", path.display()));
        }
    };
    let body = match add_server_text(&text, &args.name, &transport) {
        Ok(body) => body,
        Err(error) => {
            return outcome.fail(format!(
                "Error: {} is not valid TOML ({error}); nothing was written",
                path.display()
            ));
        }
    };
    if let Err(error) = write_config(&path, &body) {
        return outcome.fail(format!("Error: {error}"));
    }
    let kind = match transport {
        Transport::Stdio { .. } => "stdio",
        Transport::Http { .. } => "HTTP",
        Transport::Sse { .. } => "SSE",
    };
    let summary = match &transport {
        Transport::Stdio { .. } => format!(
            "{kind} MCP server '{}' with command: {}",
            args.name,
            transport.target()
        ),
        _ => format!(
            "{kind} MCP server '{}' with URL: {}",
            args.name,
            transport.target()
        ),
    };
    outcome.out(format!("Added {summary} to {} config", args.scope.label()));
    outcome.out(format!("File modified: {}", path.display()));
    if args.scope == Scope::Project && !ctx.trusted {
        outcome.err(
            "note: this folder is not trusted, so project servers are not started until you trust it (`codsh --rust --trust`)",
        );
    }
    outcome
}

pub fn run_remove(ctx: &DiscoverInput<'_>, name: &str, scope: Option<Scope>) -> CliOutcome {
    let outcome = CliOutcome::default();
    let user_defined = defined_at(ctx.config_path, name);
    let project_site = || {
        project_config_files(ctx.cwd, ctx.config_path)
            .into_iter()
            .rev()
            .find(|path| defined_at(path, name))
    };
    let site = match scope {
        Some(Scope::User) => user_defined.then(|| (Scope::User, ctx.config_path.to_path_buf())),
        Some(Scope::Project) => project_site().map(|path| (Scope::Project, path)),
        None => match (user_defined, project_site()) {
            (true, Some(project)) => {
                let mut outcome = outcome;
                outcome.err(format!("MCP server '{name}' exists in multiple scopes:"));
                outcome.err(format!("  user: {}", ctx.config_path.display()));
                outcome.err(format!("  project: {}", project.display()));
                return outcome.fail(format!(
                    "Specify which one to remove, e.g.: codsh --rust mcp remove {name} --scope project"
                ));
            }
            (true, None) => Some((Scope::User, ctx.config_path.to_path_buf())),
            (false, Some(project)) => Some((Scope::Project, project)),
            (false, None) => None,
        },
    };
    let Some((scope, path)) = site else {
        let searched = scope.map_or("user or project", Scope::label);
        return outcome.fail(format!("No MCP server named '{name}' in {searched} config"));
    };
    let mut outcome = outcome;
    let text = match read_text(&path) {
        Ok(text) => text,
        Err(error) => {
            return outcome.fail(format!("Error: cannot read {}: {error}", path.display()));
        }
    };
    let body = match remove_server_text(&text, name) {
        Ok(body) => body,
        Err(error) => {
            return outcome.fail(format!(
                "Error: {} is not valid TOML ({error})",
                path.display()
            ));
        }
    };
    let body = if body.is_empty() || body.ends_with('\n') {
        body
    } else {
        format!("{body}\n")
    };
    if let Err(error) = write_config(&path, &body) {
        return outcome.fail(format!("Error: {error}"));
    }
    outcome.out(format!(
        "Removed MCP server '{name}' from {} config",
        scope.label()
    ));
    outcome.out(format!("File modified: {}", path.display()));
    if defined_at(ctx.config_path, name) {
        outcome.err(format!(
            "note: '{name}' is still defined in {}",
            ctx.config_path.display()
        ));
    } else if let Some(project) = project_site() {
        outcome.err(format!(
            "note: '{name}' is still defined in {}",
            project.display()
        ));
    }
    outcome
}

pub fn run_set_enabled(ctx: &DiscoverInput<'_>, name: &str, enabled: bool) -> CliOutcome {
    let mut outcome = CliOutcome::default();
    if name.is_empty() {
        return outcome.fail("Error: Server name cannot be empty.");
    }
    let discovery = discover(ctx);
    let known = discovery.get(name).is_some() || discovery.disabled.contains(name);
    if !known {
        outcome.err(format!("No MCP server named '{name}'."));
        let mut names = discovery.names();
        names.extend(discovery.disabled.iter().cloned());
        names.sort();
        names.dedup();
        if names.is_empty() {
            return outcome.fail(
                "No MCP servers configured. Run `codsh --rust mcp add --help` to get started.",
            );
        }
        return outcome.fail(format!("Available servers: {}", names.join(", ")));
    }
    let user_root = read_toml(ctx.config_path);
    let already = if enabled {
        !discovery.disabled.contains(name)
    } else {
        user_disabled(user_root.as_ref()).contains(name)
    };
    if already {
        let state = if enabled { "enabled" } else { "disabled" };
        outcome.out(format!("MCP server '{name}' is already {state}."));
        return outcome;
    }
    let modified = match save_enabled(ctx.config_path, ctx.cwd, name, enabled) {
        Ok(modified) => modified,
        Err(error) => return outcome.fail(format!("Error: {error}")),
    };
    let now_disabled = discover(ctx).disabled.contains(name);
    if enabled && now_disabled {
        return outcome.fail(format!(
            "Warning: '{name}' is still disabled after enable (check project-scoped config)."
        ));
    }
    if !enabled && !now_disabled {
        return outcome.fail(format!("Warning: '{name}' is still enabled after disable."));
    }
    outcome.out(if enabled {
        format!("Enabled MCP server '{name}'.")
    } else {
        format!("Disabled MCP server '{name}'.")
    });
    for path in modified {
        outcome.out(format!("File modified: {}", path.display()));
    }
    outcome
}

/// Discovery for a loaded config.
pub fn discover_for(
    effective: &crate::config::EffectiveConfig,
    env: &BTreeMap<String, String>,
) -> Discovery {
    let home = env
        .get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    discover(&DiscoverInput {
        grok_home: &effective.grok_home,
        config_path: &effective.config_path,
        home: &home,
        cwd: &effective.cwd,
        trusted: effective.workspace_trusted,
        env,
    })
}

/// Write this child's plan and return the env pair that points dsh (and
/// the Rust ACP client) at it.
pub fn plan_env(
    effective: &crate::config::EffectiveConfig,
    env: &BTreeMap<String, String>,
    tag: &str,
) -> io::Result<(String, String)> {
    let discovery = discover_for(effective, env);
    let path = write_plan(&effective.dsh_home, tag, &discovery, &effective.cwd, env)?;
    Ok((PLAN_ENV.to_string(), path.display().to_string()))
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

    fn temp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codsh-mcp-unit-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn server_names_follow_grok_admission_and_dsh_limit() {
        for name in ["fx", "_x", "my-server", "a1_b2"] {
            assert!(validate_server_name(name).is_ok(), "{name}");
        }
        for name in ["", "1x", "a b", "a.b", "a__b", "trailing_", &"x".repeat(33)] {
            assert!(validate_server_name(name).is_err(), "{name}");
        }
    }

    #[test]
    fn expands_variables_with_defaults_and_reports_missing() {
        let vars = env(&[("TOKEN", "abc"), ("EMPTY", "")]);
        let mut missing = BTreeSet::new();
        assert_eq!(
            expand_vars(
                "Bearer ${TOKEN} ${EMPTY:-d} ${NOPE} ${bad-name}",
                &vars,
                &mut missing
            ),
            "Bearer abc d  ${bad-name}"
        );
        assert_eq!(missing, BTreeSet::from(["NOPE".to_string()]));
    }

    #[test]
    fn parses_toml_and_json_definitions() {
        let vars = env(&[("HOME_DIR", "/h")]);
        let value: TomlValue = toml::from_str(
            r#"
command = "node"
args = ["srv.js", "${HOME_DIR}/x"]
env = { A = "1" }
startup_timeout_sec = 5
tool_timeout_sec = 2.5
enabled = false
"#,
        )
        .unwrap();
        let def = parse_toml_server("fx", &value, Source::User("/c".into()), &vars).unwrap();
        assert_eq!(
            def.transport,
            Transport::Stdio {
                command: "node".into(),
                args: vec!["srv.js".into(), "/h/x".into()],
                env: env(&[("A", "1")]),
                cwd: None,
            }
        );
        assert!(!def.enabled);
        assert_eq!(def.startup_timeout_sec, Some(5.0));
        assert_eq!(def.tool_timeout_sec, Some(2.5));

        let http: TomlValue =
            toml::from_str("url = \"https://x.test/mcp\"\nheaders = { X-Key = \"v\" }").unwrap();
        let def = parse_toml_server("remote", &http, Source::User("/c".into()), &vars).unwrap();
        assert_eq!(def.transport.kind(), "http");

        let json: JsonValue =
            json!({ "command": "npx", "args": ["-y", "pkg"], "env": { "K": "v" } });
        let def =
            parse_json_server("j", &json, Source::McpJson("/r/.mcp.json".into()), &vars).unwrap();
        assert_eq!(def.transport.target(), "npx -y pkg");

        let broken: TomlValue = toml::from_str("args = [\"x\"]").unwrap();
        assert!(parse_toml_server("b", &broken, Source::User("/c".into()), &vars).is_err());
    }

    fn discover_in(root: &Path, trusted: bool, vars: &BTreeMap<String, String>) -> Discovery {
        let grok = root.join("home/.grok");
        let config = grok.join("config.toml");
        let home = root.join("home");
        let cwd = root.join("repo");
        discover(&DiscoverInput {
            grok_home: &grok,
            config_path: &config,
            home: &home,
            cwd: &cwd,
            trusted,
            env: vars,
        })
    }

    #[test]
    fn repo_servers_need_trust_and_never_replace_user_servers() {
        let root = temp("trust");
        fs::create_dir_all(root.join("home/.grok")).unwrap();
        fs::create_dir_all(root.join("repo/.grok")).unwrap();
        fs::create_dir_all(root.join("repo/.git")).unwrap();
        fs::write(
            root.join("home/.grok/config.toml"),
            "disabled_mcp_servers = [\"off\"]\n[mcp_servers.shared]\ncommand = \"user-cmd\"\n[mcp_servers.off]\ncommand = \"x\"\n[mcp]\nmax_output_bytes = 1234\n",
        )
        .unwrap();
        fs::write(
            root.join("repo/.grok/config.toml"),
            "[mcp_servers.shared]\ncommand = \"repo-cmd\"\n[mcp_servers.proj]\ncommand = \"p\"\n",
        )
        .unwrap();
        fs::write(
            root.join("repo/.mcp.json"),
            r#"{"mcpServers":{"legacy":{"type":"sse","url":"https://x.test/sse"}}}"#,
        )
        .unwrap();
        let vars = BTreeMap::new();

        let untrusted = discover_in(&root, false, &vars);
        assert_eq!(untrusted.get("proj").unwrap().state, State::Untrusted);
        assert_eq!(
            untrusted.get("shared").unwrap().def.transport.target(),
            "user-cmd"
        );
        assert_eq!(untrusted.get("off").unwrap().state, State::Disabled);
        assert_eq!(untrusted.max_output_bytes, 1234);

        let trusted = discover_in(&root, true, &vars);
        assert_eq!(trusted.get("proj").unwrap().state, State::Ready);
        assert_eq!(
            trusted.get("shared").unwrap().def.transport.target(),
            "repo-cmd"
        );
        assert!(matches!(
            trusted.get("legacy").unwrap().state,
            State::Invalid(_)
        ));

        let overridden = discover_in(&root, false, &env(&[("GROK_MAX_MCP_OUTPUT_BYTES", "99")]));
        assert_eq!(overridden.max_output_bytes, 99);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn plan_wraps_stdio_in_the_proxy_and_skips_what_cannot_start() {
        let root = temp("plan");
        fs::create_dir_all(root.join("home/.grok")).unwrap();
        fs::create_dir_all(root.join("repo")).unwrap();
        let program = root.join("srv");
        fs::write(&program, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(
            root.join("home/.grok/config.toml"),
            format!(
                "[mcp_servers.ok]\ncommand = {:?}\nargs = [\"--x\"]\ntool_timeout_sec = 3\n[mcp_servers.gone]\ncommand = \"codsh-no-such-program\"\n[mcp_servers.web]\nurl = \"https://x.test/mcp\"\nheaders = {{ Authorization = \"Bearer t\" }}\n",
                program.display().to_string()
            ),
        )
        .unwrap();
        let vars = env(&[("PATH", "/nonexistent")]);
        let discovery = discover_in(&root, true, &vars);
        let dir = root.join("run");
        let plan = build_plan(
            &discovery,
            &root.join("repo"),
            &vars,
            &dir,
            Some(Path::new("/bin/codsh-rust")),
        );
        let servers = plan["servers"].as_array().unwrap();
        let ok = servers
            .iter()
            .find(|server| server["name"] == "ok")
            .unwrap();
        assert_eq!(ok["acp"]["command"], "/bin/codsh-rust");
        let args: Vec<&str> = ok["acp"]["args"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(JsonValue::as_str)
            .collect();
        assert_eq!(args[0], PROXY_SUBCOMMAND);
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--tool-timeout-ms", "3000"])
        );
        assert_eq!(args[args.len() - 2..], [program.to_str().unwrap(), "--x"]);
        let web = servers
            .iter()
            .find(|server| server["name"] == "web")
            .unwrap();
        assert_eq!(web["acp"]["type"], "http");
        assert_eq!(web["acp"]["headers"][0]["name"], "Authorization");
        let skipped = plan["skipped"].as_array().unwrap();
        let gone = skipped
            .iter()
            .find(|server| server["name"] == "gone")
            .unwrap();
        assert_eq!(gone["state"], "failed");
        assert_eq!(gone["reason"], "command not found: codsh-no-such-program");

        let failed = BTreeMap::from([("web".to_string(), "connection refused".to_string())]);
        assert_eq!(plan_servers(&plan, &failed).len(), 1);
        let catalog = json!({ "servers": { "ok": { "tools": [{ "tool": "echo" }] } } });
        let rows = server_rows(&plan, &failed, Some(&catalog));
        let names: Vec<(&str, &str)> = rows
            .iter()
            .map(|row| (row.name.as_str(), row.state.as_str()))
            .collect();
        assert_eq!(
            names,
            [("gone", "failed"), ("ok", "connected"), ("web", "failed")]
        );
        assert_eq!(rows[1].tools, ["echo"]);
        assert_eq!(
            startup_notices(&rows),
            [
                "MCP server gone failed: command not found: codsh-no-such-program",
                "MCP server web failed: connection refused"
            ]
        );
        let report = render_rows(&rows, Some(20_000));
        assert!(report.contains("✓ ok [user] connected · 1 tool"));
        assert!(report.contains("output limit 20000 bytes per call"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn dsh_startup_errors_name_the_server() {
        assert_eq!(
            failed_server("mcp-client(fx): initial connection or tool synchronization failed"),
            Some("fx".into())
        );
        assert_eq!(failed_server("other"), None);
    }

    #[test]
    fn config_edits_keep_other_tables_and_round_trip() {
        let text = "# keep me\nmodel = \"m\"\n\n[mcp_servers.a]\ncommand = \"x\"\n\n[mcp_servers.a.env]\nK = \"v\"\n\n[ui]\ntheme = \"dark\"\n";
        let removed = remove_server_text(text, "a").unwrap();
        assert!(removed.contains("# keep me"));
        assert!(removed.contains("[ui]"));
        assert!(!removed.contains("mcp_servers.a"));
        let transport = Transport::Stdio {
            command: "node".into(),
            args: vec!["s.js".into()],
            env: env(&[("K", "v")]),
            cwd: None,
        };
        let added = add_server_text(&removed, "b", &transport).unwrap();
        let parsed: TomlValue = toml::from_str(&added).unwrap();
        assert_eq!(parsed["mcp_servers"]["b"]["command"].as_str(), Some("node"));
        assert_eq!(parsed["ui"]["theme"].as_str(), Some("dark"));
        let disabled = set_disabled_text(&added, &BTreeSet::from(["b".to_string()]));
        let parsed: TomlValue = toml::from_str(&disabled).unwrap();
        assert_eq!(
            parsed["disabled_mcp_servers"].as_array().unwrap()[0].as_str(),
            Some("b")
        );
        let cleared = set_disabled_text(&disabled, &BTreeSet::new());
        assert!(
            !toml::from_str::<TomlValue>(&cleared)
                .unwrap()
                .as_table()
                .unwrap()
                .get("disabled_mcp_servers")
                .and_then(TomlValue::as_array)
                .is_some_and(|list| !list.is_empty())
        );
    }

    #[test]
    fn slash_forms() {
        assert_eq!(parse_slash("/mcps"), Some(Ok(Slash::List)));
        assert_eq!(parse_slash("/mcp"), Some(Ok(Slash::List)));
        assert_eq!(
            parse_slash("/mcps disable fx"),
            Some(Ok(Slash::Disable("fx".into())))
        );
        assert_eq!(parse_slash("/mcps refresh"), Some(Ok(Slash::Restart(None))));
        assert_eq!(
            parse_slash("/mcp restart fx"),
            Some(Ok(Slash::Restart(Some("fx".into()))))
        );
        assert!(matches!(parse_slash("/mcps enable"), Some(Err(_))));
        assert_eq!(parse_slash("/mcpx"), None);
        assert_eq!(parse_slash("/model"), None);
    }

    #[test]
    fn cli_parse_and_add_resolution() {
        let invocation = parse(&["add", "fx", "-e", "A=1", "--", "node", "s.js", "-y"]).unwrap();
        let McpCommand::Add(args) = invocation.command else {
            panic!("expected add");
        };
        let (transport, _) = resolve_add(&args).unwrap();
        assert_eq!(transport.target(), "node s.js -y");
        let invocation = parse(&["add", "web", "https://x.test/mcp"]).unwrap();
        let McpCommand::Add(args) = invocation.command else {
            panic!("expected add");
        };
        assert_eq!(resolve_add(&args).unwrap().0.kind(), "http");
        assert!(matches!(
            parse(&["doctor", "--json"]).unwrap().command,
            McpCommand::Doctor {
                json: true,
                name: None
            }
        ));
        assert!(parse(&["bogus"]).is_err());
    }
}
