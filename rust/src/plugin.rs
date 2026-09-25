//! Plugin marketplace, install, update, and remove for the isolated Rust client.
//!
//! Install records provenance and files under `$GROK_HOME`. It does not touch
//! legacy `~/.grok` / dsh profile packages. An enabled, trusted plugin feeds
//! its rules, skills, commands, agents, and command hooks into the existing
//! asset discovery and hook runner (`active_roots`, `hook_env`), and its MCP
//! servers into the same MCP discovery a session mounts (`mcp_sources`,
//! ticket 204). It never grants tool permissions; disabling, updating, or
//! removing a plugin withdraws the remembered approvals of its MCP tools.

use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use toml::Value as TomlValue;

pub const OFFICIAL_SOURCE_NAME: &str = "xAI Official";
pub const OFFICIAL_SOURCE_GIT_URL: &str = "https://github.com/xai-org/plugin-marketplace.git";
const REGISTRY_VERSION: u32 = 1;
const INSTALL_DIR_NAME: &str = "installed-plugins";
const DATA_DIR_NAME: &str = "plugin-data";
const TRUST_FILE_NAME: &str = "trusted-plugins.toml";

#[derive(Debug)]
pub struct PluginError {
    pub message: String,
    pub code: i32,
}

impl PluginError {
    fn fail(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: 1,
        }
    }
}

impl std::fmt::Display for PluginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginCommand {
    Help,
    MarketplaceHelp,
    List {
        json: bool,
        available: bool,
    },
    Install {
        source: String,
        trust: bool,
    },
    Uninstall {
        name: String,
        confirm: bool,
        keep_data: bool,
    },
    Update {
        name: Option<String>,
    },
    Enable {
        name: String,
    },
    Disable {
        name: String,
    },
    MarketplaceList {
        json: bool,
    },
    MarketplaceAdd {
        url: String,
        force: bool,
    },
    MarketplaceRemove {
        source: String,
    },
    MarketplaceUpdate {
        name: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginTab {
    Plugins,
    Marketplace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginOverlay {
    pub tab: PluginTab,
    pub cursor: usize,
    pub confirm: Option<PluginConfirm>,
    pub expanded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginConfirm {
    pub action: ConfirmAction,
    pub target: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmAction {
    UninstallPlugin,
    RemoveMarketplace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverlayAction {
    Continue,
    Close,
    Run(PluginCommand),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum InstallKind {
    Git {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        git_ref: Option<String>,
        commit: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subdir: Option<String>,
    },
    Local {
        source_path: PathBuf,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subdir: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MarketplaceProvenance {
    pub source_url_or_path: String,
    pub source_display_name: String,
    pub plugin_subdir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepoPlugin {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstalledRepo {
    pub kind: InstallKind,
    pub installed_at: String,
    pub updated_at: String,
    pub path: PathBuf,
    pub plugins: BTreeMap<String, RepoPlugin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<MarketplaceProvenance>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallRegistry {
    pub version: u32,
    pub repos: BTreeMap<String, InstalledRepo>,
}

impl InstallRegistry {
    fn empty() -> Self {
        Self {
            version: REGISTRY_VERSION,
            repos: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceKind {
    Local { path: PathBuf },
    Git { url: String, branch: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarketplaceSource {
    pub name: String,
    pub kind: SourceKind,
    pub origin: String,
}

impl MarketplaceSource {
    pub fn identity(&self) -> String {
        match &self.kind {
            SourceKind::Local { path } => path.display().to_string(),
            SourceKind::Git { url, .. } => url.clone(),
        }
    }

    pub fn kind_label(&self) -> &'static str {
        match self.kind {
            SourceKind::Local { .. } => "local",
            SourceKind::Git { .. } => "git",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogPlugin {
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub license: Option<String>,
    pub relative_path: String,
    pub remote_url: Option<String>,
    pub remote_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledView {
    pub name: String,
    pub version: Option<String>,
    pub license: Option<String>,
    pub scope: String,
    pub source: String,
    pub path: PathBuf,
    pub marketplace: Option<String>,
    pub commit: Option<String>,
    pub trusted: bool,
    pub enabled: bool,
    /// Always false: enabling a plugin never widens tool permissions. Its
    /// hooks run under the hook contract and its tool calls still ask.
    pub execution_granted: bool,
    /// `active`, `disabled`, `blocked`, `missing`, or `shadowed`.
    pub status: String,
    /// Why the plugin is in that state, in one line.
    pub status_detail: String,
    /// Changes when the installed copy changes (commit and update time), so
    /// a live session remounts its MCP servers after an update.
    pub revision: String,
    /// What the plugin provides, read with the same parsers dsh uses.
    pub contributions: Contributions,
}

/// One MCP server a plugin declares, with the state the session sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpContribution {
    pub name: String,
    /// `ready`, `disabled`, `invalid`, `failed`, `shadowed`, or the plugin's
    /// own state when it is not active (`disabled`, `blocked`, `missing`).
    /// A live TUI view replaces `ready` with `connected` or `failed`.
    pub state: String,
    pub detail: Option<String>,
}

/// The extension view: each contribution by the name a user invokes it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Contributions {
    pub rules: Vec<String>,
    pub skills: Vec<String>,
    pub commands: Vec<String>,
    pub agents: Vec<String>,
    pub hooks: Vec<String>,
    /// Rhai workflows by the name that runs them (`plugin:name`; ticket 205).
    /// Only their `meta` is read; installing or listing never runs one.
    pub workflows: Vec<String>,
    /// MCP servers from `.mcp.json` or manifest `mcpServers`, in the state
    /// the MCP discovery of a session gives them.
    pub mcp: Vec<McpContribution>,
    pub problems: Vec<String>,
}

impl Contributions {
    pub fn summary(&self) -> String {
        let mut parts = Vec::new();
        for (count, one, many) in [
            (self.rules.len(), "rule", "rules"),
            (self.skills.len(), "skill", "skills"),
            (self.commands.len(), "command", "commands"),
            (self.agents.len(), "agent", "agents"),
            (self.hooks.len(), "hook", "hooks"),
            (self.workflows.len(), "workflow", "workflows"),
        ] {
            if count > 0 {
                parts.push(format!("{count} {}", if count == 1 { one } else { many }));
            }
        }
        match self.mcp.len() {
            0 => {}
            1 => parts.push("1 MCP server".into()),
            count => parts.push(format!("{count} MCP servers")),
        }
        if parts.is_empty() {
            "no contributions".into()
        } else {
            parts.join(" · ")
        }
    }

    fn json(&self) -> JsonValue {
        json!({
            "rules": self.rules,
            "skills": self.skills,
            "commands": self.commands,
            "agents": self.agents,
            "hooks": self.hooks,
            "workflows": self.workflows,
            "mcp": !self.mcp.is_empty(),
            "mcpServers": self.mcp.iter().map(|server| json!({
                "name": server.name,
                "state": server.state,
                "detail": server.detail,
            })).collect::<Vec<_>>(),
            "problems": self.problems,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PluginInspect {
    pub auto_register_official: bool,
    pub require_sha: bool,
    pub marketplaces: Vec<MarketplaceSource>,
    pub installed: Vec<InstalledView>,
    pub warnings: Vec<String>,
}

struct Context {
    grok_home: PathBuf,
    cwd: PathBuf,
    env: BTreeMap<String, String>,
    workspace_trusted: bool,
}

impl Context {
    fn install_dir(&self) -> PathBuf {
        self.grok_home.join(INSTALL_DIR_NAME)
    }

    fn data_dir(&self) -> PathBuf {
        self.grok_home.join(DATA_DIR_NAME)
    }

    fn registry_path(&self) -> PathBuf {
        self.install_dir().join("registry.json")
    }

    fn config_path(&self) -> PathBuf {
        self.grok_home.join("config.toml")
    }

    fn trust_path(&self) -> PathBuf {
        self.grok_home.join(TRUST_FILE_NAME)
    }
}

struct Staging {
    path: PathBuf,
    persist: bool,
}

impl Drop for Staging {
    fn drop(&mut self) {
        if !self.persist && self.path.exists() {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

pub fn plugin_help() -> &'static str {
    "Manage plugins and marketplace sources\n\n\
Usage: codsh --rust plugin [OPTIONS] <COMMAND>\n\n\
Commands:\n  \
  list         List installed plugins\n  \
  install      Install a plugin from a git URL or local path\n  \
  uninstall    Uninstall an installed plugin by name [aliases: rm, remove]\n  \
  update       Update installed plugin(s)\n  \
  enable       Enable a disabled plugin\n  \
  disable      Disable a plugin without uninstalling it\n  \
  marketplace  Manage marketplace sources\n  \
  help         Print this message or the help of the given subcommand(s)\n\n\
Options:\n      --debug                 Enable debug logging\n      \
  --debug-file <FILE>     Write debug logs to FILE\n  \
  -h, --help                  Print help\n\n\
Leader sockets are unused; dsh owns execution. Install records files and provenance only.\n\
An enabled, trusted plugin adds its rules, skills (/plugin:name), commands, agents, command hooks, and MCP servers (.mcp.json or manifest mcpServers) to the normal discovery; disable or uninstall withdraws them. Enabling never grants tool permissions: plugin MCP tools still ask, and disable, update, or uninstall forgets their remembered approvals.\n\
`install bundled:<name>` copies an optional extension shipped with codsh (bundled:ship is the Ship workflow); it is never installed or enabled by default."
}

pub fn marketplace_help() -> &'static str {
    "Manage marketplace sources\n\n\
Usage: codsh --rust plugin marketplace [OPTIONS] <COMMAND>\n\n\
Commands:\n  \
  list    List configured marketplace sources and their plugins\n  \
  add     Add a marketplace source (git URL, GitHub shorthand, or local path)\n  \
  remove  Remove a marketplace source and uninstall its plugins\n  \
  update  Refresh marketplace source(s) and sync git caches\n  \
  help    Print this message or the help of the given subcommand(s)\n\n\
Options:\n  -h, --help                  Print help\n\n\
Adding a marketplace does not install plugins. Official marketplace auto-register is off unless GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER is enabled."
}

pub fn parse_command(args: &[String]) -> Result<PluginCommand, PluginError> {
    if args
        .iter()
        .any(|arg| arg == "--leader-socket" || arg.starts_with("--leader-socket="))
    {
        return Err(PluginError::fail(
            "plugin --leader-socket is unused; dsh owns execution. Omit the flag.",
        ));
    }
    let mut json = false;
    let mut available = false;
    let mut trust = false;
    let mut confirm = false;
    let mut keep_data = false;
    let mut force = false;
    let mut positionals = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        match arg.as_str() {
            "--help" | "-h" => {
                if positionals.first().map(String::as_str) == Some("marketplace") {
                    return Ok(PluginCommand::MarketplaceHelp);
                }
                return Ok(PluginCommand::Help);
            }
            "--json" => json = true,
            "--available" => available = true,
            "--trust" => trust = true,
            "--confirm" => confirm = true,
            "--keep-data" => keep_data = true,
            "--force" => force = true,
            "--debug" => {}
            "--debug-file" => {
                index += 1;
                if args.get(index).is_none() {
                    return Err(PluginError::fail(
                        "missing --debug-file path; use codsh --rust plugin --help",
                    ));
                }
            }
            other if other.starts_with("--debug-file=") => {}
            other if other.starts_with('-') => {
                return Err(PluginError::fail(format!(
                    "unknown plugin option {other}; use codsh --rust plugin --help"
                )));
            }
            _ => positionals.push(arg.clone()),
        }
        index += 1;
    }
    if available && !json {
        return Err(PluginError::fail(
            "--available requires --json; use codsh --rust plugin list --json --available",
        ));
    }
    match positionals
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] | ["help"] => Ok(PluginCommand::Help),
        ["list"] => Ok(PluginCommand::List { json, available }),
        ["install"] => Err(PluginError::fail(
            "missing plugin source; use codsh --rust plugin install --help",
        )),
        ["install", source] => Ok(PluginCommand::Install {
            source: (*source).to_string(),
            trust,
        }),
        ["uninstall" | "rm" | "remove"] => Err(PluginError::fail(
            "missing plugin name; use codsh --rust plugin uninstall --help",
        )),
        ["uninstall" | "rm" | "remove", name] => Ok(PluginCommand::Uninstall {
            name: (*name).to_string(),
            confirm,
            keep_data,
        }),
        ["update"] => Ok(PluginCommand::Update { name: None }),
        ["update", name] => Ok(PluginCommand::Update {
            name: Some((*name).to_string()),
        }),
        ["enable", name] => Ok(PluginCommand::Enable {
            name: (*name).to_string(),
        }),
        ["disable", name] => Ok(PluginCommand::Disable {
            name: (*name).to_string(),
        }),
        ["marketplace"] | ["marketplace", "help"] => Ok(PluginCommand::MarketplaceHelp),
        ["marketplace", "list"] => Ok(PluginCommand::MarketplaceList { json }),
        ["marketplace", "add"] => Err(PluginError::fail(
            "missing marketplace URL; use codsh --rust plugin marketplace add --help",
        )),
        ["marketplace", "add", url] => Ok(PluginCommand::MarketplaceAdd {
            url: (*url).to_string(),
            force,
        }),
        ["marketplace", "remove"] => Err(PluginError::fail(
            "missing marketplace source; use codsh --rust plugin marketplace remove --help",
        )),
        ["marketplace", "remove", source] => Ok(PluginCommand::MarketplaceRemove {
            source: (*source).to_string(),
        }),
        ["marketplace", "update"] => Ok(PluginCommand::MarketplaceUpdate { name: None }),
        ["marketplace", "update", name] => Ok(PluginCommand::MarketplaceUpdate {
            name: Some((*name).to_string()),
        }),
        other => Err(PluginError::fail(format!(
            "unsupported plugin command {}; use codsh --rust plugin --help",
            other.join(" ")
        ))),
    }
}

pub fn run(
    grok_home: &Path,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    workspace_trusted: bool,
    command: &PluginCommand,
) -> Result<String, PluginError> {
    let ctx = Context {
        grok_home: grok_home.to_path_buf(),
        cwd: cwd.to_path_buf(),
        env: env.clone(),
        workspace_trusted,
    };
    maybe_auto_register(&ctx)?;
    let mutates = !matches!(
        command,
        PluginCommand::Help
            | PluginCommand::MarketplaceHelp
            | PluginCommand::List { .. }
            | PluginCommand::MarketplaceList { .. }
    );
    let before = if mutates {
        plugin_mcp_fingerprints(&ctx)
    } else {
        BTreeMap::new()
    };
    let result = run_command(&ctx, command);
    if !mutates {
        return result;
    }
    // A partly failed update may still have replaced some plugins.
    match result {
        Ok(text) => Ok(withdraw_mcp_approvals(&ctx, &before, text)),
        Err(mut error) => {
            error.message = withdraw_mcp_approvals(&ctx, &before, error.message);
            Err(error)
        }
    }
}

/// Server name -> which plugin supplies it, at which revision, with which
/// transport, for every MCP server an active plugin currently supplies.
fn plugin_mcp_fingerprints(ctx: &Context) -> BTreeMap<String, String> {
    let home = ctx
        .env
        .get("HOME")
        .or_else(|| ctx.env.get("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    let config_path = ctx.config_path();
    let discovery = crate::mcp::discover(&crate::mcp::DiscoverInput {
        grok_home: &ctx.grok_home,
        config_path: &config_path,
        home: &home,
        cwd: &ctx.cwd,
        trusted: ctx.workspace_trusted,
        env: &ctx.env,
    });
    discovery
        .entries
        .iter()
        .filter_map(|entry| {
            let origin = entry.def.source.plugin()?;
            Some((
                entry.def.name.clone(),
                format!(
                    "{}\n{}\n{:?}",
                    origin.plugin, origin.revision, entry.def.transport
                ),
            ))
        })
        .collect()
}

/// A plugin MCP server that is no longer supplied by the same plugin at the
/// same revision (disabled, updated, removed, or now shadowed by another
/// plugin) loses its remembered approvals: its tools ask again.
fn withdraw_mcp_approvals(
    ctx: &Context,
    before: &BTreeMap<String, String>,
    result: String,
) -> String {
    if before.is_empty() {
        return result;
    }
    let after = plugin_mcp_fingerprints(ctx);
    let withdrawn: BTreeSet<String> = before
        .iter()
        .filter(|(name, fingerprint)| after.get(*name) != Some(*fingerprint))
        .map(|(name, _)| name.clone())
        .collect();
    if withdrawn.is_empty() {
        return result;
    }
    let names = withdrawn.iter().cloned().collect::<Vec<_>>().join(", ");
    match crate::permission::revoke_mcp_allows(&ctx.grok_home, &withdrawn) {
        Ok(0) => format!("{result}\nPlugin MCP servers withdrawn from the next prompt: {names}."),
        Ok(count) => format!(
            "{result}\nPlugin MCP servers withdrawn from the next prompt: {names}; forgot {count} remembered approval(s) for their tools."
        ),
        Err(error) => format!(
            "{result}\nPlugin MCP servers withdrawn from the next prompt: {names}; remembered approvals could not be updated: {error}"
        ),
    }
}

fn run_command(ctx: &Context, command: &PluginCommand) -> Result<String, PluginError> {
    match command {
        PluginCommand::Help => Ok(plugin_help().to_string()),
        PluginCommand::MarketplaceHelp => Ok(marketplace_help().to_string()),
        PluginCommand::List { json, available } => cmd_list(ctx, *json, *available),
        PluginCommand::Install { source, trust } => cmd_install(ctx, source, *trust),
        PluginCommand::Uninstall {
            name,
            confirm,
            keep_data,
        } => cmd_uninstall(ctx, name, *confirm, *keep_data),
        PluginCommand::Update { name } => cmd_update(ctx, name.as_deref()),
        PluginCommand::Enable { name } => cmd_enable(ctx, name, true),
        PluginCommand::Disable { name } => cmd_enable(ctx, name, false),
        PluginCommand::MarketplaceList { json } => cmd_marketplace_list(ctx, *json),
        PluginCommand::MarketplaceAdd { url, force } => cmd_marketplace_add(ctx, url, *force),
        PluginCommand::MarketplaceRemove { source } => cmd_marketplace_remove(ctx, source),
        PluginCommand::MarketplaceUpdate { name } => cmd_marketplace_update(ctx, name.as_deref()),
    }
}

pub fn inspect(
    grok_home: &Path,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    workspace_trusted: bool,
) -> PluginInspect {
    let ctx = Context {
        grok_home: grok_home.to_path_buf(),
        cwd: cwd.to_path_buf(),
        env: env.clone(),
        workspace_trusted,
    };
    let mut warnings = Vec::new();
    if let Err(error) = maybe_auto_register(&ctx) {
        warnings.push(error.message);
    }
    let (marketplaces, extra_warnings) = load_marketplace_catalog(&ctx);
    warnings.extend(extra_warnings);
    PluginInspect {
        auto_register_official: auto_register_enabled(&ctx.env),
        require_sha: require_sha(&ctx),
        marketplaces,
        installed: list_installed_views(&ctx),
        warnings,
    }
}

pub fn inspect_json_value(snapshot: &PluginInspect) -> JsonValue {
    json!({
        "autoRegisterOfficial": snapshot.auto_register_official,
        "requireSha": snapshot.require_sha,
        "marketplaces": snapshot.marketplaces.iter().map(|source| json!({
            "name": source.name,
            "kind": source.kind_label(),
            "identity": source.identity(),
            "origin": source.origin,
        })).collect::<Vec<_>>(),
        "installed": snapshot.installed.iter().map(|plugin| json!({
            "name": plugin.name,
            "version": plugin.version,
            "license": plugin.license,
            "scope": plugin.scope,
            "source": plugin.source,
            "path": plugin.path,
            "marketplace": plugin.marketplace,
            "commit": plugin.commit,
            "trusted": plugin.trusted,
            "enabled": plugin.enabled,
            "executionGranted": plugin.execution_granted,
            "state": plugin.status,
            "stateDetail": plugin.status_detail,
            "contributions": plugin.contributions.json(),
        })).collect::<Vec<_>>(),
        "warnings": snapshot.warnings,
    })
}

pub fn inspect_text(snapshot: &PluginInspect) -> String {
    let mut lines = vec!["Plugins".into()];
    lines.push(format!(
        "  {:<28} {}  ({})",
        "marketplace.auto_register",
        snapshot.auto_register_official,
        if snapshot.auto_register_official {
            "environment"
        } else {
            "default"
        }
    ));
    lines.push(format!(
        "  {:<28} {}  ({})",
        "marketplace.require_sha",
        snapshot.require_sha,
        if snapshot.require_sha {
            "policy"
        } else {
            "default"
        }
    ));
    if snapshot.marketplaces.is_empty() {
        lines.push("  marketplaces                 (none)".into());
    } else {
        for source in &snapshot.marketplaces {
            lines.push(format!(
                "  marketplace {:<16} {} ({})  ({})",
                source.name,
                source.identity(),
                source.kind_label(),
                source.origin
            ));
        }
    }
    if snapshot.installed.is_empty() {
        lines.push("  installed                    (none)".into());
    } else {
        for plugin in &snapshot.installed {
            lines.push(format!(
                "  plugin {:<20} v{} license={} scope={} trusted={} enabled={} exec={}  ({})",
                plugin.name,
                plugin.version.as_deref().unwrap_or("unspecified"),
                plugin.license.as_deref().unwrap_or("unspecified"),
                plugin.scope,
                plugin.trusted,
                plugin.enabled,
                plugin.execution_granted,
                plugin.source
            ));
            lines.push(format!("    path {}", plugin.path.display()));
            if let Some(commit) = &plugin.commit {
                lines.push(format!("    commit {commit}"));
            }
            lines.push(format!(
                "    status {}  {}",
                plugin.status, plugin.status_detail
            ));
            lines.extend(contribution_lines(&plugin.contributions, "    "));
        }
    }
    lines.join("\n")
}

pub fn new_overlay(tab: PluginTab) -> PluginOverlay {
    PluginOverlay {
        tab,
        cursor: 0,
        confirm: None,
        expanded: false,
    }
}

pub fn overlay_text(
    overlay: &PluginOverlay,
    snapshot: &PluginInspect,
    grok_home: Option<&Path>,
) -> String {
    if let Some(confirm) = &overlay.confirm {
        let verb = match confirm.action {
            ConfirmAction::UninstallPlugin => "Uninstall plugin",
            ConfirmAction::RemoveMarketplace => "Remove marketplace source and its plugins",
        };
        return format!(
            "{verb} {}? y=yes  any other key cancels\nUnrelated user files are not deleted.",
            confirm.target
        );
    }
    match overlay.tab {
        PluginTab::Plugins => {
            let mut lines = vec![
                "Plugins  (Tab: Marketplace)  Enter expand  x uninstall  Space enable/disable  r reload"
                    .into(),
            ];
            if snapshot.installed.is_empty() {
                lines.push("  (no installed plugins)".into());
            } else {
                for (index, plugin) in snapshot.installed.iter().enumerate() {
                    // The notice area shows six rows. An expanded plugin shows
                    // only its own row and details so the view stays on screen.
                    if overlay.expanded && index != overlay.cursor {
                        continue;
                    }
                    let mark = if index == overlay.cursor { ">" } else { " " };
                    lines.push(format!(
                        "{mark} {}  v{}  {}  {}  [{}]  trusted={} enabled={} exec={}  license={}",
                        plugin.name,
                        plugin.version.as_deref().unwrap_or("unspecified"),
                        plugin.scope,
                        plugin
                            .marketplace
                            .as_deref()
                            .unwrap_or(plugin.source.as_str()),
                        plugin.status,
                        plugin.trusted,
                        plugin.enabled,
                        plugin.execution_granted,
                        plugin.license.as_deref().unwrap_or("unspecified")
                    ));
                    if overlay.expanded && index == overlay.cursor {
                        lines.extend(extension_view(plugin));
                    }
                }
            }
            lines.join("\n")
        }
        PluginTab::Marketplace => {
            let mut lines = vec![
                "Marketplace  (Tab: Plugins)  i install  x remove source  r refresh  u update"
                    .into(),
            ];
            if snapshot.marketplaces.is_empty() {
                lines.push(
                    "  (no marketplace sources; official auto-register is off by default)".into(),
                );
            } else {
                for (index, source) in snapshot.marketplaces.iter().enumerate() {
                    let mark = if index == overlay.cursor { ">" } else { " " };
                    lines.push(format!(
                        "{mark} {}  {}  ({})",
                        source.name,
                        source.identity(),
                        source.kind_label()
                    ));
                    if overlay.expanded && index == overlay.cursor {
                        for plugin in catalog_plugins_from_home(grok_home, source) {
                            lines.push(format!(
                                "    {}  v{}  {}",
                                plugin.name,
                                plugin.version.as_deref().unwrap_or("unspecified"),
                                plugin.relative_path
                            ));
                        }
                    }
                }
            }
            lines.join("\n")
        }
    }
}

pub fn handle_overlay_key_with_home(
    overlay: &mut PluginOverlay,
    snapshot: &PluginInspect,
    grok_home: Option<&Path>,
    key: char,
    enter: bool,
    tab: bool,
    esc: bool,
) -> OverlayAction {
    if let Some(confirm) = overlay.confirm.clone() {
        overlay.confirm = None;
        if key == 'y' {
            let command = match confirm.action {
                ConfirmAction::UninstallPlugin => PluginCommand::Uninstall {
                    name: confirm.target,
                    confirm: true,
                    keep_data: false,
                },
                ConfirmAction::RemoveMarketplace => PluginCommand::MarketplaceRemove {
                    source: confirm.target,
                },
            };
            return OverlayAction::Run(command);
        }
        return OverlayAction::Continue;
    }
    if esc {
        if overlay.expanded {
            overlay.expanded = false;
            return OverlayAction::Continue;
        }
        return OverlayAction::Close;
    }
    if tab {
        overlay.tab = match overlay.tab {
            PluginTab::Plugins => PluginTab::Marketplace,
            PluginTab::Marketplace => PluginTab::Plugins,
        };
        overlay.cursor = 0;
        overlay.expanded = false;
        return OverlayAction::Continue;
    }
    let len = match overlay.tab {
        PluginTab::Plugins => snapshot.installed.len(),
        PluginTab::Marketplace => snapshot.marketplaces.len(),
    };
    if key == 'j' || key == 'n' {
        if len > 0 {
            overlay.cursor = (overlay.cursor + 1).min(len.saturating_sub(1));
        }
        return OverlayAction::Continue;
    }
    if key == 'k' {
        overlay.cursor = overlay.cursor.saturating_sub(1);
        return OverlayAction::Continue;
    }
    if enter {
        overlay.expanded = !overlay.expanded;
        return OverlayAction::Continue;
    }
    match (overlay.tab, key) {
        (PluginTab::Plugins, 'x') => {
            if let Some(plugin) = snapshot.installed.get(overlay.cursor) {
                overlay.confirm = Some(PluginConfirm {
                    action: ConfirmAction::UninstallPlugin,
                    target: plugin.name.clone(),
                });
            }
            OverlayAction::Continue
        }
        (PluginTab::Plugins, ' ') => {
            if let Some(plugin) = snapshot.installed.get(overlay.cursor) {
                OverlayAction::Run(if plugin.enabled {
                    PluginCommand::Disable {
                        name: plugin.name.clone(),
                    }
                } else {
                    PluginCommand::Enable {
                        name: plugin.name.clone(),
                    }
                })
            } else {
                OverlayAction::Continue
            }
        }
        (PluginTab::Plugins, 'r') | (PluginTab::Marketplace, 'r') => OverlayAction::Continue,
        (PluginTab::Marketplace, 'i') => {
            if let Some(source) = snapshot.marketplaces.get(overlay.cursor) {
                let plugins = catalog_plugins_from_home(grok_home, source);
                if let Some(plugin) = plugins.first() {
                    OverlayAction::Run(PluginCommand::Install {
                        source: format!("{}@{}", plugin.name, source.name),
                        trust: false,
                    })
                } else {
                    OverlayAction::Continue
                }
            } else {
                OverlayAction::Continue
            }
        }
        (PluginTab::Marketplace, 'x') => {
            if let Some(source) = snapshot.marketplaces.get(overlay.cursor) {
                overlay.confirm = Some(PluginConfirm {
                    action: ConfirmAction::RemoveMarketplace,
                    target: source.name.clone(),
                });
            }
            OverlayAction::Continue
        }
        (PluginTab::Marketplace, 'u') => {
            OverlayAction::Run(PluginCommand::MarketplaceUpdate { name: None })
        }
        _ => OverlayAction::Continue,
    }
}

fn maybe_auto_register(ctx: &Context) -> Result<(), PluginError> {
    if !auto_register_enabled(&ctx.env) {
        return Ok(());
    }
    let sources = load_marketplace_sources(ctx);
    if sources
        .iter()
        .any(|source| is_official_source_url(&source.identity()))
    {
        return Ok(());
    }
    append_marketplace_source(
        ctx,
        OFFICIAL_SOURCE_NAME,
        &SourceKind::Git {
            url: OFFICIAL_SOURCE_GIT_URL.into(),
            branch: None,
        },
    )
}

fn auto_register_enabled(env: &BTreeMap<String, String>) -> bool {
    env_bool(
        env.get("GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER")
            .map(String::as_str),
    )
}

fn require_sha(ctx: &Context) -> bool {
    if env_bool(
        ctx.env
            .get("GROK_MARKETPLACE_REQUIRE_SHA")
            .map(String::as_str),
    ) {
        return true;
    }
    load_toml_layers(ctx).into_iter().any(|(_, value)| {
        value
            .get("marketplace")
            .and_then(|table| table.get("require_sha"))
            .and_then(TomlValue::as_bool)
            == Some(true)
    })
}

fn env_bool(value: Option<&str>) -> bool {
    matches!(
        value
            .map(|text| text.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on" | "enabled")
    )
}

fn cmd_list(ctx: &Context, json: bool, available: bool) -> Result<String, PluginError> {
    let installed = list_installed_views(ctx);
    if json {
        let mut entries: Vec<JsonValue> = installed
            .iter()
            .map(|plugin| {
                json!({
                    "status": "installed",
                    "name": plugin.name,
                    "version": plugin.version,
                    "license": plugin.license,
                    "path": plugin.path,
                    "source": plugin.source,
                    "marketplace": plugin.marketplace,
                    "scope": plugin.scope,
                    "trusted": plugin.trusted,
                    "enabled": plugin.enabled,
                    "executionGranted": plugin.execution_granted,
                    "state": plugin.status,
                    "stateDetail": plugin.status_detail,
                    "contributions": plugin.contributions.json(),
                })
            })
            .collect();
        if available {
            for source in load_marketplace_sources(ctx) {
                for plugin in catalog_plugins(ctx, &source) {
                    if installed.iter().any(|row| row.name == plugin.name) {
                        continue;
                    }
                    entries.push(json!({
                        "status": "available",
                        "name": plugin.name,
                        "version": plugin.version,
                        "marketplace": source.name,
                        "license": plugin.license,
                    }));
                }
            }
        }
        return serde_json::to_string_pretty(&entries)
            .map_err(|error| PluginError::fail(error.to_string()));
    }
    if installed.is_empty() {
        return Ok(
            "No plugins installed. Run `codsh --rust plugin install --help` to get started.".into(),
        );
    }
    let mut lines = Vec::new();
    for plugin in installed {
        lines.push(format!(
            "  {}: {} [{}] license={} trusted={} enabled={} exec={} status={}",
            plugin.name,
            plugin.source,
            plugin.scope,
            plugin.license.as_deref().unwrap_or("unspecified"),
            plugin.trusted,
            plugin.enabled,
            plugin.execution_granted,
            plugin.status
        ));
        lines.push(format!(
            "    {} · provides {}",
            plugin.status_detail,
            plugin.contributions.summary()
        ));
    }
    Ok(lines.join("\n"))
}

fn cmd_marketplace_list(ctx: &Context, json: bool) -> Result<String, PluginError> {
    let sources = load_marketplace_sources(ctx);
    if json {
        let entries: Vec<JsonValue> = sources
            .iter()
            .map(|source| {
                json!({
                    "name": source.name,
                    "kind": source.kind_label(),
                    "source": match &source.kind {
                        SourceKind::Git { url, branch } => json!({"url": url, "branch": branch}),
                        SourceKind::Local { path } => json!({"path": path}),
                    }
                })
            })
            .collect();
        return serde_json::to_string_pretty(&entries)
            .map_err(|error| PluginError::fail(error.to_string()));
    }
    if sources.is_empty() {
        return Ok(
            "No marketplace sources configured.\nRun `codsh --rust plugin marketplace add --help` to get started."
                .into(),
        );
    }
    let mut lines = Vec::new();
    for source in sources {
        lines.push(format!("  {}: {}", source.name, source.identity()));
        for plugin in catalog_plugins(ctx, &source) {
            lines.push(format!(
                "    {}  v{}",
                plugin.name,
                plugin.version.as_deref().unwrap_or("unspecified")
            ));
        }
    }
    Ok(lines.join("\n"))
}

fn cmd_marketplace_add(ctx: &Context, url: &str, force: bool) -> Result<String, PluginError> {
    let url = url.trim();
    if url.is_empty() {
        return Err(PluginError::fail("URL cannot be empty."));
    }
    let kind = classify_marketplace_input(url, &ctx.cwd)?;
    if let SourceKind::Local { path } = &kind
        && !path.is_dir()
    {
        return Err(PluginError::fail(format!(
            "Local marketplace path not found (or is not a directory): {}",
            path.display()
        )));
    }
    let identity = match &kind {
        SourceKind::Git { url, .. } => url.clone(),
        SourceKind::Local { path } => path.display().to_string(),
    };
    if let Some(reason) = allowlist_block(ctx, &identity, matches!(kind, SourceKind::Local { .. }))
    {
        return Err(PluginError::fail(format!(
            "Marketplace source blocked: {reason}"
        )));
    }
    let existing = load_marketplace_sources(ctx);
    if existing.iter().any(|source| {
        source.identity() == identity
            || canonicalize_git(&source.identity()) == canonicalize_git(&identity)
    }) {
        return Err(PluginError::fail(format!(
            "Marketplace source already configured: {identity}"
        )));
    }
    if !force && let SourceKind::Git { url: git_url, .. } = &kind {
        probe_git_remote(git_url)?;
    }
    let name = if is_official_source_url(&identity) {
        OFFICIAL_SOURCE_NAME.to_string()
    } else {
        name_from_identity(&kind)
    };
    append_marketplace_source(ctx, &name, &kind)?;
    if let SourceKind::Git { url, branch } = &kind {
        let cache = git_cache_dir(ctx, url);
        let _ = sync_git(url, branch.as_deref(), &cache, true);
    }
    Ok(format!("Added marketplace source: {name} ({identity})"))
}

fn cmd_marketplace_remove(ctx: &Context, input: &str) -> Result<String, PluginError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(PluginError::fail(
            "Provide the source name, git URL, or local path to remove.",
        ));
    }
    let sources = load_configured_marketplace_sources(ctx);
    let source = find_marketplace(&sources, input, &ctx.cwd)?;
    let identity = source.identity();
    let name = source.name.clone();
    let removed = uninstall_marketplace_plugins(ctx, &identity)?;
    remove_marketplace_source(ctx, &identity)?;
    if removed.is_empty() {
        Ok(format!("Removed marketplace source: {name} ({identity})"))
    } else {
        Ok(format!(
            "Removed marketplace source and uninstalled {} plugin(s): {}",
            removed.len(),
            removed.join(", ")
        ))
    }
}

fn cmd_marketplace_update(ctx: &Context, name: Option<&str>) -> Result<String, PluginError> {
    let sources = load_marketplace_sources(ctx);
    let mut refreshed = 0;
    let mut errors = Vec::new();
    let mut matched = false;
    for source in &sources {
        if let Some(filter) = name {
            if source.name != filter {
                continue;
            }
            matched = true;
        }
        match &source.kind {
            SourceKind::Local { .. } => {
                if name.is_some() {
                    return Ok(format!(
                        "Source \"{}\" is local, nothing to sync.",
                        source.name
                    ));
                }
            }
            SourceKind::Git { url, branch } => {
                let cache = git_cache_dir(ctx, url);
                match sync_git(url, branch.as_deref(), &cache, true) {
                    Ok(_) => refreshed += 1,
                    Err(error) => errors.push(format!("{}: {error}", source.name)),
                }
            }
        }
    }
    if let Some(filter) = name
        && !matched
    {
        return Err(PluginError::fail(format!(
            "Marketplace source \"{filter}\" not found."
        )));
    }
    if refreshed == 0 && errors.is_empty() && name.is_none() {
        if sources.is_empty() {
            return Ok("No marketplace sources configured.".into());
        }
        return Ok("No git marketplace sources to sync.".into());
    }
    if errors.is_empty() {
        Ok(format!("Refreshed {refreshed} source(s)."))
    } else {
        Err(PluginError::fail(format!(
            "Refreshed {refreshed} source(s) with {} error(s): {}",
            errors.len(),
            errors.join("; ")
        )))
    }
}

fn cmd_install(ctx: &Context, source: &str, trust: bool) -> Result<String, PluginError> {
    let bundled = match source.strip_prefix(BUNDLED_PREFIX) {
        Some(name) => Some(bundled_extension(ctx, name)?),
        None => None,
    };
    if bundled.is_none()
        && let Some(plugin_ref) = parse_marketplace_plugin_ref(source)
    {
        return install_from_marketplace(ctx, &plugin_ref, trust);
    }
    let parsed = match &bundled {
        Some(dir) => ParsedSource {
            identity: dir.display().to_string(),
            subject: format!("the bundled extension {source} ({})", dir.display()),
            local: true,
            source_path: Some(dir.clone()),
            git_url: None,
            git_ref: None,
            subdir: None,
        },
        None => parse_install_source(source, &ctx.cwd)?,
    };
    if !trust {
        return Err(PluginError {
            code: 1,
            message: trust_prompt(&parsed.subject, source),
        });
    }
    if let Some(reason) = allowlist_block(ctx, &parsed.identity, parsed.local) {
        return Err(PluginError::fail(format!(
            "Plugin source blocked: {reason}"
        )));
    }
    if let Some(reason) = clone_url_block(ctx, &parsed) {
        return Err(PluginError::fail(format!(
            "Plugin source blocked: {reason}"
        )));
    }
    if require_sha(ctx) && !parsed.local && !is_full_sha(parsed.git_ref.as_deref().unwrap_or("")) {
        return Err(unpinned_remote_error(
            &format!("'{source}'"),
            &parsed.identity,
        ));
    }
    let outcome = install_from_parsed(ctx, &parsed, None)?;
    record_trust(ctx, &outcome.names, true)?;
    Ok(format!(
        "Installed {} plugin(s) from {source}: {}\nTrusted for later enablement; execution is not granted until the plugin is enabled.",
        outcome.names.len(),
        outcome.names.join(", ")
    ))
}

/// `bundled:<name>` names an optional extension shipped inside the codsh
/// package (`CODSH_BUNDLED_EXTENSIONS/<name>`, set by the launcher). It is an
/// ordinary local install: trust, enable, disable, update, and uninstall are
/// the same as for any directory.
pub const BUNDLED_PREFIX: &str = "bundled:";
pub const BUNDLED_EXTENSIONS_ENV: &str = "CODSH_BUNDLED_EXTENSIONS";

fn bundled_extension(ctx: &Context, name: &str) -> Result<PathBuf, PluginError> {
    if !is_valid_plugin_name(name) {
        return Err(PluginError::fail(format!(
            "invalid bundled extension name {name:?}: must be 1-64 chars, lowercase alphanumeric + hyphens"
        )));
    }
    let root = ctx
        .env
        .get(BUNDLED_EXTENSIONS_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| {
            PluginError::fail(format!(
                "Bundled extensions are unavailable: {BUNDLED_EXTENSIONS_ENV} is not set. Run through the codsh launcher (codsh --rust)."
            ))
        })?;
    let dir = root.join(name);
    if !dir.is_dir() {
        return Err(PluginError::fail(format!(
            "Bundled extension '{name}' is not in this codsh install ({}). Build it with pnpm run build:rust in a checkout.",
            dir.display()
        )));
    }
    Ok(dir)
}

fn install_from_marketplace(
    ctx: &Context,
    plugin_ref: &MarketplacePluginRef,
    trust: bool,
) -> Result<String, PluginError> {
    let name = plugin_ref.name.as_str();
    let sources = load_marketplace_sources(ctx);
    let mut matches = Vec::new();
    for source in &sources {
        if let Some(qualifier) = &plugin_ref.qualifier
            && !source_matches_qualifier(source, qualifier)
        {
            continue;
        }
        for plugin in catalog_plugins(ctx, source) {
            if plugin.name.eq_ignore_ascii_case(name) {
                matches.push((source.clone(), plugin));
            }
        }
    }
    match matches.as_slice() {
        [] => {
            if let Some(qualifier) = &plugin_ref.qualifier {
                Err(PluginError::fail(format!(
                    "Plugin \"{name}\" was not found in marketplace \"{qualifier}\"."
                )))
            } else {
                Err(PluginError::fail(format!(
                    "Plugin \"{name}\" was not found in configured marketplace sources."
                )))
            }
        }
        [(source, plugin)] => {
            let source_arg = if plugin_ref.qualifier.is_some() {
                format!("{}@{}", plugin.name, source.name)
            } else {
                plugin.name.clone()
            };
            if !trust {
                return Err(PluginError {
                    code: 1,
                    message: trust_prompt(
                        &format!("\"{}\" from marketplace \"{}\"", plugin.name, source.name),
                        &source_arg,
                    ),
                });
            }
            let registry = load_registry(ctx)?;
            if registry
                .repos
                .values()
                .any(|repo| repo.plugins.contains_key(&plugin.name))
            {
                return Ok(format!(
                    "Plugin \"{}\" is already installed from {}. Run `codsh --rust plugin update {}` to update it.",
                    plugin.name, source.name, plugin.name
                ));
            }
            let parsed = parsed_from_catalog(source, plugin)?;
            if let Some(reason) = allowlist_block(ctx, &source.identity(), source_is_local(source))
            {
                return Err(PluginError::fail(format!(
                    "Plugin source blocked: {reason}"
                )));
            }
            if let Some(reason) = clone_url_block(ctx, &parsed) {
                return Err(PluginError::fail(format!(
                    "Plugin source blocked: {reason}"
                )));
            }
            if require_sha(ctx)
                && !parsed.local
                && !is_full_sha(parsed.git_ref.as_deref().unwrap_or(""))
            {
                return Err(unpinned_remote_error(
                    &format!("'{}'", plugin.name),
                    &parsed.identity,
                ));
            }
            let provenance = MarketplaceProvenance {
                source_url_or_path: source.identity(),
                source_display_name: source.name.clone(),
                plugin_subdir: plugin.relative_path.clone(),
            };
            let outcome = install_from_parsed(ctx, &parsed, Some(provenance))?;
            record_trust(ctx, &outcome.names, true)?;
            Ok(format!(
                "Installed {} plugin(s) from {}: {}\nTrusted for later enablement; execution is not granted until the plugin is enabled.",
                outcome.names.len(),
                source.name,
                outcome.names.join(", ")
            ))
        }
        many => Err(PluginError::fail(format!(
            "Plugin \"{name}\" is provided by multiple marketplaces: {}. Qualify the source, for example `codsh --rust plugin install {name}@{}`.",
            many.iter()
                .map(|(source, _)| source.name.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            many[0].0.name
        ))),
    }
}

fn cmd_uninstall(
    ctx: &Context,
    name: &str,
    confirm: bool,
    keep_data: bool,
) -> Result<String, PluginError> {
    let mut registry = load_registry(ctx)?;
    let Some((repo_key, repo)) = registry
        .repos
        .iter()
        .find(|(_, repo)| repo.plugins.contains_key(name))
        .map(|(key, repo)| (key.clone(), repo.clone()))
    else {
        return Err(PluginError::fail(format!(
            "Plugin \"{name}\" not found.\nRun `codsh --rust plugin list` to see installed plugins."
        )));
    };
    if repo.plugins.len() > 1 && !confirm {
        let others: Vec<_> = repo
            .plugins
            .keys()
            .filter(|plugin| plugin.as_str() != name)
            .cloned()
            .collect();
        return Err(PluginError::fail(format!(
            "Plugin \"{name}\" belongs to repo \"{repo_key}\" which also contains:\n{}\n\nUninstalling will remove all {} plugin(s). To proceed:\n  codsh --rust plugin uninstall {name} --confirm",
            others
                .iter()
                .map(|plugin| format!("  - {plugin}"))
                .collect::<Vec<_>>()
                .join("\n"),
            repo.plugins.len()
        )));
    }
    let names: Vec<String> = repo.plugins.keys().cloned().collect();
    let unrelated = ctx.cwd.join("canary-user-file");
    let _ = unrelated;
    remove_dir_if_managed(&repo.path, &ctx.install_dir())?;
    registry.repos.remove(&repo_key);
    save_registry(ctx, &registry)?;
    forget_plugin_names(ctx, &names, keep_data)?;
    let suffix = if keep_data { " (data preserved)" } else { "" };
    Ok(format!(
        "Uninstalled {} plugin(s): {}{suffix}",
        names.len(),
        names.join(", ")
    ))
}

fn cmd_update(ctx: &Context, name: Option<&str>) -> Result<String, PluginError> {
    let registry = load_registry(ctx)?;
    if registry.repos.is_empty() {
        return Ok("No installed plugins to update.".into());
    }
    let mut lines = Vec::new();
    let mut failed = 0;
    let mut considered = 0;
    for (repo_key, repo) in &registry.repos {
        if let Some(filter) = name
            && !repo.plugins.contains_key(filter)
        {
            continue;
        }
        considered += 1;
        match update_repo(ctx, repo_key, repo) {
            Ok(message) => lines.push(message),
            Err(error) => {
                failed += 1;
                lines.push(format!("{repo_key}: update failed: {error}"));
            }
        }
    }
    if let Some(filter) = name
        && considered == 0
    {
        return Err(PluginError::fail(format!(
            "Plugin \"{filter}\" not found.\nRun `codsh --rust plugin list` to see installed plugins."
        )));
    }
    if failed > 0 {
        return Err(PluginError::fail(format!(
            "{}\n{failed} of {considered} plugin update(s) failed",
            lines.join("\n")
        )));
    }
    Ok(lines.join("\n"))
}

fn cmd_enable(ctx: &Context, name: &str, enable: bool) -> Result<String, PluginError> {
    let views = list_installed_views(ctx);
    if !views.iter().any(|plugin| plugin.name == name) {
        return Err(PluginError::fail(format!(
            "Plugin \"{name}\" not found.\nRun `codsh --rust plugin list` to see installed plugins."
        )));
    }
    let mut enabled = enabled_set(ctx);
    let mut disabled = disabled_set(ctx);
    if enable {
        disabled.remove(name);
        enabled.insert(name.to_string());
    } else {
        enabled.remove(name);
        disabled.insert(name.to_string());
    }
    write_enabled_lists(ctx, &enabled, &disabled)?;
    let view = list_installed_views(ctx)
        .into_iter()
        .find(|plugin| plugin.name == name && plugin.status != "shadowed");
    let (status, detail, provides) = view
        .map(|plugin| {
            (
                plugin.status,
                plugin.status_detail,
                plugin.contributions.summary(),
            )
        })
        .unwrap_or_default();
    if enable {
        Ok(format!(
            "Enabled plugin: {name} [{status}] {detail}\nProvides {provides}. A running session picks this up on its next prompt; enabling does not grant tool permissions."
        ))
    } else {
        Ok(format!(
            "Disabled plugin: {name} [{status}]\nIts rules, skills, commands, agents, and hooks are withdrawn from the next prompt."
        ))
    }
}

struct ParsedSource {
    identity: String,
    subject: String,
    local: bool,
    source_path: Option<PathBuf>,
    git_url: Option<String>,
    git_ref: Option<String>,
    subdir: Option<String>,
}

struct InstallOutcome {
    names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MarketplacePluginRef {
    name: String,
    qualifier: Option<String>,
}

fn parse_marketplace_plugin_ref(source: &str) -> Option<MarketplacePluginRef> {
    if source.contains("://") || source.starts_with("git@") {
        return None;
    }
    if source.starts_with('/')
        || source.starts_with('.')
        || source.starts_with('~')
        || source.contains('\\')
        || source.contains('#')
    {
        return None;
    }
    let (name, qualifier) = match source.split_once('@') {
        Some((name, qualifier)) => (name, Some(qualifier)),
        None => (source, None),
    };
    if name.is_empty() || name.contains('/') {
        return None;
    }
    if qualifier.is_some_and(|value| value.trim().is_empty()) {
        return None;
    }
    Some(MarketplacePluginRef {
        name: name.to_string(),
        qualifier: qualifier.map(str::to_string),
    })
}

fn source_matches_qualifier(source: &MarketplaceSource, qualifier: &str) -> bool {
    let want = qualifier.trim();
    if want.is_empty() {
        return false;
    }
    if source.name == want
        || slugify(&source.name) == slugify(want)
        || source.identity() == want
        || canonicalize_git(&source.identity()) == canonicalize_git(want)
        || canonicalize_git(&source.identity()) == canonicalize_git(&expand_github(want))
    {
        return true;
    }
    match &source.kind {
        SourceKind::Local { path } => {
            path.display().to_string() == want
                || slugify(&source.name) == want.trim_start_matches("local/")
        }
        SourceKind::Git { url, .. } => {
            canonical_github_owner_repo(url).as_deref() == Some(want)
                || slugify(&source.name) == want.trim_start_matches("git/")
        }
    }
}

fn slugify(name: &str) -> String {
    name.to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

fn parse_install_source(source: &str, cwd: &Path) -> Result<ParsedSource, PluginError> {
    let (base, subdir) = match source.split_once('#') {
        Some((base, subdir)) => (base, Some(subdir.to_string())),
        None => (source, None),
    };
    let looks_remote = base.contains("://") || base.starts_with("git@");
    let (base, git_ref) = match base.rsplit_once('@') {
        Some((head, rest)) if !looks_remote && !Path::new(base).exists() && !rest.is_empty() => {
            (head, Some(rest.to_string()))
        }
        _ => (base, None),
    };
    let expanded = expand_path(base, cwd);
    if expanded.is_dir() {
        return Ok(ParsedSource {
            identity: expanded.display().to_string(),
            subject: format!("from directory {}", expanded.display()),
            local: true,
            source_path: Some(expanded),
            git_url: None,
            git_ref,
            subdir,
        });
    }
    let url = if base.contains("://") || base.starts_with("git@") {
        base.to_string()
    } else if let Some((owner, repo)) = base.split_once('/')
        && !owner.is_empty()
        && !repo.is_empty()
        && !base.contains('.')
    {
        format!("https://github.com/{owner}/{repo}.git")
    } else {
        return Err(PluginError::fail(format!(
            "Plugin source not found: {source}"
        )));
    };
    Ok(ParsedSource {
        identity: url.clone(),
        subject: format!("from git repo {url}"),
        local: false,
        source_path: None,
        git_url: Some(url),
        git_ref,
        subdir,
    })
}

fn parsed_from_catalog(
    source: &MarketplaceSource,
    plugin: &CatalogPlugin,
) -> Result<ParsedSource, PluginError> {
    if let Some(url) = &plugin.remote_url {
        return Ok(ParsedSource {
            identity: plugin_install_identity(url, &plugin.name),
            subject: format!("from git repo {url}"),
            local: false,
            source_path: None,
            git_url: Some(url.clone()),
            git_ref: plugin.remote_sha.clone(),
            subdir: None,
        });
    }
    match &source.kind {
        SourceKind::Local { path } => {
            let plugin_path = path.join(&plugin.relative_path);
            if !plugin_path.is_dir() {
                return Err(PluginError::fail(format!(
                    "marketplace plugin path missing: {}",
                    plugin_path.display()
                )));
            }
            Ok(ParsedSource {
                identity: plugin_install_identity(&source.identity(), &plugin.name),
                subject: format!("from directory {}", plugin_path.display()),
                local: true,
                source_path: Some(plugin_path),
                git_url: None,
                git_ref: None,
                subdir: None,
            })
        }
        SourceKind::Git { url, branch } => Ok(ParsedSource {
            identity: plugin_install_identity(url, &plugin.name),
            subject: format!("from git repo {url}"),
            local: false,
            source_path: None,
            git_url: Some(url.clone()),
            git_ref: branch.clone().or(plugin.remote_sha.clone()),
            subdir: Some(plugin.relative_path.clone()),
        }),
    }
}

fn install_from_parsed(
    ctx: &Context,
    parsed: &ParsedSource,
    marketplace: Option<MarketplaceProvenance>,
) -> Result<InstallOutcome, PluginError> {
    fs::create_dir_all(ctx.install_dir()).map_err(io_fail)?;
    let key = repo_key(&parsed.identity);
    let dest = ctx.install_dir().join(&key);
    if dest.exists() {
        return Err(PluginError::fail(format!("repo '{key}' already installed")));
    }
    let staging_path = ctx.install_dir().join(format!(
        ".staging-{}-{}",
        std::process::id(),
        now_stamp().replace(':', "")
    ));
    let mut staging = Staging {
        path: staging_path,
        persist: false,
    };
    fs::create_dir_all(&staging.path).map_err(io_fail)?;
    let (kind, plugin_root) = if parsed.local {
        let source = parsed
            .source_path
            .as_ref()
            .ok_or_else(|| PluginError::fail("missing local plugin path"))?;
        let copy_root = match &parsed.subdir {
            Some(subdir) => contained_join(source, subdir)?,
            None => source.clone(),
        };
        copy_tree(&copy_root, &staging.path)?;
        (
            InstallKind::Local {
                source_path: source.clone(),
                subdir: parsed.subdir.clone(),
            },
            staging.path.clone(),
        )
    } else {
        let url = parsed
            .git_url
            .as_ref()
            .ok_or_else(|| PluginError::fail("missing git url"))?;
        let checkout = staging.path.join("repo");
        clone_git(url, parsed.git_ref.as_deref(), &checkout)?;
        let commit = git_head(&checkout)?;
        let copy_root = match &parsed.subdir {
            Some(subdir) => contained_join(&checkout, subdir)?,
            None => checkout.clone(),
        };
        if copy_root != staging.path {
            let plugin_dest = staging.path.join("plugin");
            copy_tree(&copy_root, &plugin_dest)?;
            (
                InstallKind::Git {
                    url: url.clone(),
                    git_ref: parsed.git_ref.clone(),
                    commit,
                    subdir: parsed.subdir.clone(),
                },
                plugin_dest,
            )
        } else {
            (
                InstallKind::Git {
                    url: url.clone(),
                    git_ref: parsed.git_ref.clone(),
                    commit,
                    subdir: parsed.subdir.clone(),
                },
                staging.path.clone(),
            )
        }
    };
    let discovered = discover_plugins(&plugin_root)?;
    if discovered.is_empty() {
        return Err(PluginError::fail(format!(
            "no plugin manifest or convention directories in {}",
            plugin_root.display()
        )));
    }
    let names: Vec<String> = discovered.keys().cloned().collect();
    let mut registry = load_registry(ctx)?;
    for name in &names {
        if registry
            .repos
            .values()
            .any(|repo| repo.plugins.contains_key(name))
        {
            return Err(PluginError::fail(format!(
                "plugin '{name}' is already installed from another source"
            )));
        }
    }
    fs::rename(&plugin_root, &dest).map_err(io_fail)?;
    if plugin_root != staging.path {
        let _ = fs::remove_dir_all(&staging.path);
    }
    staging.persist = true;
    let stamp = now_stamp();
    registry.repos.insert(
        key,
        InstalledRepo {
            kind,
            installed_at: stamp.clone(),
            updated_at: stamp,
            path: dest,
            plugins: discovered,
            marketplace,
        },
    );
    save_registry(ctx, &registry)?;
    Ok(InstallOutcome { names })
}

fn update_repo(ctx: &Context, repo_key: &str, repo: &InstalledRepo) -> Result<String, PluginError> {
    if let InstallKind::Git { url, git_ref, .. } = &repo.kind {
        if let Some(reason) = allowlist_block(ctx, url, false) {
            return Err(PluginError::fail(format!(
                "Plugin source blocked: {reason}"
            )));
        }
        if require_sha(ctx) && !is_full_sha(git_ref.as_deref().unwrap_or("")) {
            return Err(unpinned_remote_error(&format!("update '{repo_key}'"), url));
        }
    }
    let backup = ctx.install_dir().join(format!(".backup-{repo_key}"));
    if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }
    fs::rename(&repo.path, &backup).map_err(io_fail)?;
    let restore = || {
        if repo.path.exists() {
            let _ = fs::remove_dir_all(&repo.path);
        }
        let _ = fs::rename(&backup, &repo.path);
    };
    let mut git_commit = None;
    let result = match &repo.kind {
        InstallKind::Local {
            source_path,
            subdir,
        } => {
            if !source_path.is_dir() {
                restore();
                return Err(PluginError::fail(format!(
                    "source missing: {}",
                    source_path.display()
                )));
            }
            let copy_root = match subdir {
                Some(subdir) => match contained_join(source_path, subdir) {
                    Ok(path) => path,
                    Err(error) => {
                        restore();
                        return Err(error);
                    }
                },
                None => source_path.clone(),
            };
            if let Err(error) = copy_tree(&copy_root, &repo.path) {
                restore();
                return Err(error);
            }
            format!("{repo_key}: updated from {}", source_path.display())
        }
        InstallKind::Git {
            url,
            git_ref,
            commit,
            subdir,
        } => {
            let checkout = ctx.install_dir().join(format!(".git-update-{repo_key}"));
            if let Err(error) = clone_git(url, git_ref.as_deref(), &checkout) {
                restore();
                let _ = fs::remove_dir_all(&checkout);
                return Err(error);
            }
            let new_commit = match git_head(&checkout) {
                Ok(value) => value,
                Err(error) => {
                    restore();
                    let _ = fs::remove_dir_all(&checkout);
                    return Err(error);
                }
            };
            let copy_root = match subdir {
                Some(subdir) => match contained_join(&checkout, subdir) {
                    Ok(path) => path,
                    Err(error) => {
                        restore();
                        let _ = fs::remove_dir_all(&checkout);
                        return Err(error);
                    }
                },
                None => checkout.clone(),
            };
            if let Err(error) = copy_tree(&copy_root, &repo.path) {
                restore();
                let _ = fs::remove_dir_all(&checkout);
                return Err(error);
            }
            let _ = fs::remove_dir_all(&checkout);
            let message = format!(
                "{repo_key}: updated ({} -> {})",
                &commit[..7.min(commit.len())],
                &new_commit[..7.min(new_commit.len())]
            );
            git_commit = Some(new_commit);
            message
        }
    };
    let discovered = match discover_plugins(&repo.path) {
        Ok(value) if !value.is_empty() => value,
        Ok(_) | Err(_) => {
            restore();
            return Err(PluginError::fail(
                "update produced no valid plugin; previous installation restored",
            ));
        }
    };
    let _ = fs::remove_dir_all(&backup);
    let mut registry = load_registry(ctx)?;
    if let Some(entry) = registry.repos.get_mut(repo_key) {
        entry.plugins = discovered;
        entry.updated_at = now_stamp();
        if let (InstallKind::Git { commit, .. }, Some(updated)) = (&mut entry.kind, git_commit) {
            *commit = updated;
        }
    }
    save_registry(ctx, &registry)?;
    Ok(result)
}

fn uninstall_marketplace_plugins(
    ctx: &Context,
    identity: &str,
) -> Result<Vec<String>, PluginError> {
    let mut registry = load_registry(ctx)?;
    let mut removed = Vec::new();
    let keys: Vec<_> = registry
        .repos
        .iter()
        .filter(|(_, repo)| {
            repo.marketplace
                .as_ref()
                .is_some_and(|item| item.source_url_or_path == identity)
        })
        .map(|(key, _)| key.clone())
        .collect();
    for key in keys {
        if let Some(repo) = registry.repos.remove(&key) {
            removed.extend(repo.plugins.keys().cloned());
            remove_dir_if_managed(&repo.path, &ctx.install_dir())?;
        }
    }
    save_registry(ctx, &registry)?;
    forget_plugin_names(ctx, &removed, false)?;
    Ok(removed)
}

fn forget_plugin_names(
    ctx: &Context,
    names: &[String],
    keep_data: bool,
) -> Result<(), PluginError> {
    if names.is_empty() {
        return Ok(());
    }
    if !keep_data {
        for plugin in names {
            let data = ctx.data_dir().join(plugin);
            if data.exists() {
                let _ = fs::remove_dir_all(data);
            }
        }
    }
    let mut enabled = enabled_set(ctx);
    let mut disabled = disabled_set(ctx);
    for plugin in names {
        enabled.remove(plugin);
        disabled.remove(plugin);
    }
    write_enabled_lists(ctx, &enabled, &disabled)?;
    let mut trusted = trusted_set(ctx)?;
    for plugin in names {
        trusted.remove(plugin);
    }
    write_trusted_set(ctx, &trusted)
}

fn remove_dir_if_managed(path: &Path, install_dir: &Path) -> Result<(), PluginError> {
    let canonical_install =
        fs::canonicalize(install_dir).unwrap_or_else(|_| install_dir.to_path_buf());
    let canonical_path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !canonical_path.starts_with(&canonical_install) {
        return Err(PluginError::fail(format!(
            "refusing to delete unmanaged path {}",
            path.display()
        )));
    }
    if path.exists() {
        fs::remove_dir_all(path).map_err(io_fail)?;
    }
    Ok(())
}

fn discover_plugins(root: &Path) -> Result<BTreeMap<String, RepoPlugin>, PluginError> {
    let mut plugins = BTreeMap::new();
    if let Some((name, plugin)) = read_plugin_at(root)? {
        plugins.insert(name, plugin);
        return Ok(plugins);
    }
    for child in read_dirs(root)? {
        if let Some((name, plugin)) = read_plugin_at(&child)? {
            let subdir = child
                .file_name()
                .map(|name| name.to_string_lossy().into_owned());
            plugins.insert(
                name,
                RepoPlugin {
                    subdir,
                    version: plugin.version,
                    license: plugin.license,
                },
            );
        }
    }
    if plugins.is_empty()
        && (root.join("skills").is_dir()
            || root.join("commands").is_dir()
            || root.join("agents").is_dir()
            || root.join("hooks").is_dir()
            || root.join(".mcp.json").is_file())
        && let Some(name) = name_from_dirname(root)
    {
        plugins.insert(
            name,
            RepoPlugin {
                subdir: None,
                version: None,
                license: None,
            },
        );
    }
    Ok(plugins)
}

fn read_plugin_at(root: &Path) -> Result<Option<(String, RepoPlugin)>, PluginError> {
    for rel in [
        "plugin.json",
        ".grok-plugin/plugin.json",
        ".claude-plugin/plugin.json",
    ] {
        let path = root.join(rel);
        if !path.is_file() {
            continue;
        }
        let text = fs::read_to_string(&path).map_err(io_fail)?;
        let value: JsonValue = serde_json::from_str(&text).map_err(|error| {
            PluginError::fail(format!("failed to parse {}: {error}", path.display()))
        })?;
        let name = value
            .get("name")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| {
                PluginError::fail(format!("missing plugin name in {}", path.display()))
            })?;
        if !is_valid_plugin_name(name) {
            return Err(PluginError::fail(format!(
                "invalid plugin name {name:?}: must be 1-64 chars, lowercase alphanumeric + hyphens"
            )));
        }
        return Ok(Some((
            name.to_string(),
            RepoPlugin {
                subdir: None,
                version: value
                    .get("version")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
                license: value
                    .get("license")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
            },
        )));
    }
    Ok(None)
}

fn list_installed_views(ctx: &Context) -> Vec<InstalledView> {
    installed_views(ctx, true)
}

/// Installed plugins with their state; `with_contributions` also reads what
/// each one provides (asset discovery), which the workflow catalog skips.
fn installed_views(ctx: &Context, with_contributions: bool) -> Vec<InstalledView> {
    let contributions = |name: &str, path: &Path| {
        if with_contributions {
            contributions_for(ctx, name, path)
        } else {
            Contributions::default()
        }
    };
    let registry = load_registry(ctx).unwrap_or_else(|_| InstallRegistry::empty());
    let trusted = trusted_set(ctx).unwrap_or_default();
    let enabled = enabled_set(ctx);
    let disabled = disabled_set(ctx);
    let mut views = Vec::new();
    let mut seen = BTreeSet::new();
    for repo in registry.repos.values() {
        for (name, plugin) in &repo.plugins {
            let path = match &plugin.subdir {
                Some(subdir) => repo.path.join(subdir),
                None => repo.path.clone(),
            };
            let is_trusted = trusted.contains(name);
            let is_enabled = enabled.contains(name) && !disabled.contains(name);
            let (status, status_detail) = if !seen.insert(name.clone()) {
                (
                    "shadowed",
                    "another installed repo already provides this name; only the first loads"
                        .to_string(),
                )
            } else {
                plugin_status(
                    &path,
                    is_enabled,
                    disabled.contains(name),
                    is_trusted,
                    "user",
                )
            };
            views.push(InstalledView {
                name: name.clone(),
                version: plugin.version.clone(),
                license: plugin.license.clone(),
                scope: "user".into(),
                source: match &repo.kind {
                    InstallKind::Git { url, .. } => url.clone(),
                    InstallKind::Local { source_path, .. } => source_path.display().to_string(),
                },
                contributions: contributions(name, &path),
                path,
                marketplace: repo
                    .marketplace
                    .as_ref()
                    .map(|item| item.source_display_name.clone()),
                commit: match &repo.kind {
                    InstallKind::Git { commit, .. } => Some(commit.clone()),
                    InstallKind::Local { .. } => None,
                },
                trusted: is_trusted,
                enabled: is_enabled,
                execution_granted: false,
                status: status.into(),
                status_detail,
                revision: format!(
                    "{}@{}",
                    match &repo.kind {
                        InstallKind::Git { commit, .. } => commit.as_str(),
                        InstallKind::Local { .. } => "local",
                    },
                    repo.updated_at
                ),
            });
        }
    }
    let project = ctx.cwd.join(".grok").join("plugins");
    if project.is_dir() {
        for child in read_dirs(&project).unwrap_or_default() {
            if let Ok(Some((name, plugin))) = read_plugin_at(&child) {
                let is_enabled = enabled.contains(&name) && !disabled.contains(&name);
                let (status, status_detail) = if seen.contains(&name) {
                    (
                        "shadowed",
                        "an installed user plugin has the same name and loads instead".to_string(),
                    )
                } else {
                    seen.insert(name.clone());
                    plugin_status(
                        &child,
                        is_enabled,
                        disabled.contains(&name),
                        ctx.workspace_trusted,
                        "project",
                    )
                };
                views.push(InstalledView {
                    contributions: contributions(&name, &child),
                    name,
                    version: plugin.version,
                    license: plugin.license,
                    scope: "project".into(),
                    source: child.display().to_string(),
                    path: child,
                    marketplace: None,
                    commit: None,
                    trusted: ctx.workspace_trusted,
                    enabled: is_enabled,
                    execution_granted: false,
                    status: status.into(),
                    status_detail,
                    revision: "project".into(),
                });
            }
        }
    }
    views.sort_by(|a, b| a.name.cmp(&b.name));
    if with_contributions {
        fill_mcp_states(ctx, &mut views);
    }
    views
}

/// Each plugin's MCP servers in the state the session's MCP discovery gives
/// them: an active plugin's server is ready, disabled, invalid, failed (its
/// program is missing), or shadowed; an inactive plugin's servers carry the
/// plugin's own state and are never mounted.
fn fill_mcp_states(ctx: &Context, views: &mut [InstalledView]) {
    if !views
        .iter()
        .any(|view| view.path.is_dir() && plugin_layout(&view.path).has_mcp())
    {
        return;
    }
    let home = ctx
        .env
        .get("HOME")
        .or_else(|| ctx.env.get("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    let config_path = ctx.config_path();
    let discovery = crate::mcp::discover(&crate::mcp::DiscoverInput {
        grok_home: &ctx.grok_home,
        config_path: &config_path,
        home: &home,
        cwd: &ctx.cwd,
        trusted: ctx.workspace_trusted,
        env: &ctx.env,
    });
    let states = crate::mcp::plugin_servers(&discovery, &ctx.cwd, &ctx.env);
    for view in views.iter_mut() {
        if !view.path.is_dir() {
            continue;
        }
        let layout = plugin_layout(&view.path);
        if !layout.has_mcp() {
            continue;
        }
        let (servers, problems) = read_mcp_servers(&layout);
        view.contributions.problems.extend(problems);
        view.contributions.mcp = servers
            .iter()
            .map(|server| {
                if view.status != "active" {
                    return McpContribution {
                        name: server.name.clone(),
                        state: view.status.clone(),
                        detail: Some("not mounted while the plugin is not active".into()),
                    };
                }
                match states
                    .iter()
                    .find(|state| state.plugin == view.name && state.name == server.name)
                {
                    Some(state) => McpContribution {
                        name: server.name.clone(),
                        state: state.state.clone(),
                        detail: state.reason.clone(),
                    },
                    None => McpContribution {
                        name: server.name.clone(),
                        state: "invalid".into(),
                        detail: Some("not loaded".into()),
                    },
                }
            })
            .collect();
    }
}

/// Replace `ready` with what the live session mounted: `connected` with its
/// tool count, `failed` with dsh's reason, or pending until the next prompt
/// replaces the dsh child. A server that is still mounted although its
/// plugin is no longer active is marked as withdrawn on the next prompt.
pub fn annotate_live_mcp(snapshot: &mut PluginInspect, rows: &[crate::mcp::ServerRow]) {
    for view in &mut snapshot.installed {
        let scope = format!("plugin: {}", view.name);
        for server in &mut view.contributions.mcp {
            let live = rows
                .iter()
                .find(|row| row.scope == scope && row.name == server.name);
            match (server.state.as_str(), live) {
                ("ready", Some(row)) if row.state == "connected" => {
                    let count = row.tools.len();
                    server.state = "connected".into();
                    server.detail =
                        Some(format!("{count} tool{}", if count == 1 { "" } else { "s" }));
                }
                ("ready", Some(row)) if row.state == "failed" => {
                    server.state = "failed".into();
                    server.detail = row.reason.clone();
                }
                ("ready", _) => {
                    server.detail = Some("mounts with the next prompt".into());
                }
                (_, Some(row)) if row.state == "connected" => {
                    server.detail = Some("still mounted; withdrawn with the next prompt".into());
                }
                _ => {}
            }
        }
    }
}

fn plugin_status(
    path: &Path,
    enabled: bool,
    disabled: bool,
    trusted: bool,
    scope: &str,
) -> (&'static str, String) {
    if !path.is_dir() {
        return (
            "missing",
            format!("plugin files are gone from {}", path.display()),
        );
    }
    if disabled {
        return ("disabled", "listed in [plugins] disabled".into());
    }
    if !enabled {
        return (
            "disabled",
            "not enabled; `plugin enable` or Space in /plugins turns it on".into(),
        );
    }
    if !trusted {
        return (
            "blocked",
            if scope == "project" {
                "enabled, but this workspace is not trusted".into()
            } else {
                "enabled, but not trusted; reinstall with --trust".into()
            },
        );
    }
    (
        "active",
        "contributions load through normal discovery; tool calls still ask".into(),
    )
}

/// Directories and hook source one plugin declares, with path problems.
#[derive(Debug, Clone, Default)]
struct PluginLayout {
    rule_dirs: Vec<PathBuf>,
    skill_dirs: Vec<PathBuf>,
    command_dirs: Vec<PathBuf>,
    agent_dirs: Vec<PathBuf>,
    workflow_dirs: Vec<PathBuf>,
    hooks_file: Option<PathBuf>,
    hooks_inline: Option<JsonValue>,
    /// MCP config files (`.mcp.json`, or manifest `mcpServers` paths).
    mcp_files: Vec<PathBuf>,
    /// Manifest `mcpServers` given inline, with the manifest path.
    mcp_inline: Option<(PathBuf, JsonValue)>,
    problems: Vec<String>,
}

impl PluginLayout {
    fn has_mcp(&self) -> bool {
        !self.mcp_files.is_empty() || self.mcp_inline.is_some()
    }
}

const MANIFEST_FILES: &[&str] = &[
    "plugin.json",
    ".grok-plugin/plugin.json",
    ".claude-plugin/plugin.json",
];

/// Manifest `rules`, `skills`, `commands`, `agents`, `workflows` (a path or
/// a list) and
/// `hooks` (a path or an inline object) replace the default `rules/`,
/// `skills/`, `commands/`, `agents/`, and `hooks/hooks.json`. Every path
/// stays inside the plugin root.
fn plugin_layout(root: &Path) -> PluginLayout {
    let mut layout = PluginLayout::default();
    let mut manifest = JsonValue::Null;
    let mut manifest_path = root.join(MANIFEST_FILES[0]);
    for rel in MANIFEST_FILES {
        let path = root.join(rel);
        if !path.is_file() {
            continue;
        }
        manifest_path = path.clone();
        match fs::read_to_string(&path)
            .map_err(|error| error.to_string())
            .and_then(|text| {
                serde_json::from_str::<JsonValue>(&text).map_err(|error| error.to_string())
            }) {
            Ok(value) => manifest = value,
            Err(error) => layout
                .problems
                .push(format!("manifest {} unreadable: {error}", path.display())),
        }
        break;
    }
    let dirs = |key: &str, problems: &mut Vec<String>| -> Vec<PathBuf> {
        let declared: Vec<String> = match manifest.get(key) {
            Some(JsonValue::String(one)) => vec![one.clone()],
            Some(JsonValue::Array(many)) => many
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_string)
                .collect(),
            Some(_) => {
                problems.push(format!("manifest {key} must be a path or a list of paths"));
                return Vec::new();
            }
            None => {
                let default = root.join(key);
                return if default.is_dir() {
                    vec![default]
                } else {
                    Vec::new()
                };
            }
        };
        let mut out = Vec::new();
        for rel in declared {
            match component_path(root, &rel) {
                Ok(path) if path.is_dir() => out.push(path),
                Ok(path) => {
                    problems.push(format!("{key} path {} is not a directory", path.display()))
                }
                Err(error) => problems.push(format!("{key} path {rel}: {error}")),
            }
        }
        out
    };
    layout.rule_dirs = dirs("rules", &mut layout.problems);
    layout.skill_dirs = dirs("skills", &mut layout.problems);
    layout.command_dirs = dirs("commands", &mut layout.problems);
    layout.agent_dirs = dirs("agents", &mut layout.problems);
    layout.workflow_dirs = dirs("workflows", &mut layout.problems);
    match manifest.get("hooks") {
        Some(JsonValue::String(rel)) => match component_path(root, rel) {
            Ok(path) if path.is_file() => layout.hooks_file = Some(path),
            Ok(path) => layout
                .problems
                .push(format!("hooks file {} is missing", path.display())),
            Err(error) => layout.problems.push(format!("hooks path {rel}: {error}")),
        },
        Some(value @ JsonValue::Object(_)) => layout.hooks_inline = Some(value.clone()),
        Some(_) => layout
            .problems
            .push("manifest hooks must be a path or an object".into()),
        None => {
            let default = root.join("hooks").join("hooks.json");
            if default.is_file() {
                layout.hooks_file = Some(default);
            }
        }
    }
    // Manifest `mcpServers`: a path, a list of paths, or the servers inline.
    match manifest.get("mcpServers") {
        None => {
            let default = root.join(".mcp.json");
            if default.is_file() {
                layout.mcp_files.push(default);
            }
        }
        Some(value @ JsonValue::Object(_)) => {
            layout.mcp_inline = Some((manifest_path.clone(), value.clone()));
        }
        Some(value) => {
            let declared: Vec<Option<&str>> = match value {
                JsonValue::String(one) => vec![Some(one.as_str())],
                JsonValue::Array(many) => many.iter().map(JsonValue::as_str).collect(),
                _ => vec![None],
            };
            for rel in declared {
                let Some(rel) = rel else {
                    layout.problems.push(
                        "manifest mcpServers must be a path, a list of paths, or an object".into(),
                    );
                    continue;
                };
                match component_path(root, rel) {
                    Ok(path) if path.is_file() => layout.mcp_files.push(path),
                    Ok(path) => layout
                        .problems
                        .push(format!("mcpServers file {} is missing", path.display())),
                    Err(error) => layout
                        .problems
                        .push(format!("mcpServers path {rel}: {error}")),
                }
            }
        }
    }
    layout
}

/// One server entry from a plugin's MCP config, not yet parsed.
#[derive(Debug, Clone, PartialEq)]
pub struct PluginMcpServer {
    pub name: String,
    pub value: JsonValue,
    /// The file that declared it (the manifest for inline servers).
    pub file: PathBuf,
}

/// `{"mcpServers": {...}}` or a bare map of servers, as Claude and Grok
/// plugins write `.mcp.json`.
fn servers_in(value: &JsonValue) -> Option<&serde_json::Map<String, JsonValue>> {
    match value.get("mcpServers") {
        Some(inner) => inner.as_object(),
        None => value.as_object(),
    }
}

/// Every server the layout declares, with problems for unreadable files.
/// A later file does not replace a name an earlier one declared.
fn read_mcp_servers(layout: &PluginLayout) -> (Vec<PluginMcpServer>, Vec<String>) {
    let mut servers: Vec<PluginMcpServer> = Vec::new();
    let mut problems = Vec::new();
    let mut add =
        |file: &Path, value: &JsonValue, problems: &mut Vec<String>| match servers_in(value) {
            Some(map) => {
                for (name, entry) in map {
                    if servers.iter().any(|server| &server.name == name) {
                        problems.push(format!(
                            "MCP server {name} is declared twice; {} is ignored",
                            file.display()
                        ));
                        continue;
                    }
                    servers.push(PluginMcpServer {
                        name: name.clone(),
                        value: entry.clone(),
                        file: file.to_path_buf(),
                    });
                }
            }
            None => problems.push(format!(
                "MCP config {} must be an object of servers",
                file.display()
            )),
        };
    for file in &layout.mcp_files {
        match fs::read_to_string(file)
            .map_err(|error| error.to_string())
            .and_then(|text| {
                serde_json::from_str::<JsonValue>(&text).map_err(|error| error.to_string())
            }) {
            Ok(value) => add(file, &value, &mut problems),
            Err(error) => {
                problems.push(format!("MCP config {} unreadable: {error}", file.display()))
            }
        }
    }
    if let Some((file, value)) = &layout.mcp_inline {
        add(file, value, &mut problems);
    }
    (servers, problems)
}

/// One installed plugin that declares MCP servers, for MCP discovery.
#[derive(Debug, Clone, PartialEq)]
pub struct PluginMcpSource {
    pub plugin: String,
    pub scope: String,
    pub root: PathBuf,
    pub data: PathBuf,
    pub revision: String,
    /// Enabled, trusted, present, and not shadowed: only then are its
    /// servers mounted.
    pub active: bool,
    pub status: String,
    pub servers: Vec<PluginMcpServer>,
    pub problems: Vec<String>,
}

/// Every installed plugin (any state) whose layout declares MCP servers,
/// in name order. Reads registry, trust, config, and the MCP config files;
/// it starts nothing.
pub fn mcp_sources(
    grok_home: &Path,
    cwd: &Path,
    workspace_trusted: bool,
    env: &BTreeMap<String, String>,
) -> Vec<PluginMcpSource> {
    let ctx = Context {
        grok_home: grok_home.to_path_buf(),
        cwd: cwd.to_path_buf(),
        env: env.clone(),
        workspace_trusted,
    };
    installed_views(&ctx, false)
        .into_iter()
        .filter(|plugin| plugin.status != "shadowed" && plugin.path.is_dir())
        .filter_map(|plugin| {
            let layout = plugin_layout(&plugin.path);
            if !layout.has_mcp() {
                return None;
            }
            let (servers, mut problems) = read_mcp_servers(&layout);
            problems.extend(
                layout
                    .problems
                    .iter()
                    .filter(|problem| problem.contains("mcpServers"))
                    .cloned(),
            );
            Some(PluginMcpSource {
                data: ctx.data_dir().join(&plugin.name),
                active: plugin.status == "active",
                plugin: plugin.name,
                scope: plugin.scope,
                root: plugin.path,
                revision: plugin.revision,
                status: plugin.status,
                servers,
                problems,
            })
        })
        .collect()
}

fn component_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let trimmed = rel.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == "./" {
        return Ok(root.to_path_buf());
    }
    let normalized =
        normalize_rel(trimmed).map_err(|_| "must stay inside the plugin".to_string())?;
    let candidate = root.join(normalized);
    let canonical_root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if let Ok(canonical) = fs::canonicalize(&candidate)
        && !canonical.starts_with(&canonical_root)
    {
        return Err("escapes the plugin root".into());
    }
    Ok(candidate)
}

/// Event and matcher labels for the view, plus handlers that will not run.
fn hook_labels(value: &JsonValue, problems: &mut Vec<String>) -> Vec<String> {
    let map = value
        .get("hooks")
        .and_then(JsonValue::as_object)
        .or_else(|| value.as_object());
    let Some(map) = map else {
        problems.push("hooks config has no event table".into());
        return Vec::new();
    };
    let mut labels = Vec::new();
    for (event, groups) in map {
        let Some(groups) = groups.as_array() else {
            continue;
        };
        for group in groups {
            let matcher = group
                .get("matcher")
                .and_then(JsonValue::as_str)
                .filter(|matcher| !matcher.is_empty());
            let handlers = group
                .get("hooks")
                .and_then(JsonValue::as_array)
                .cloned()
                .unwrap_or_default();
            for handler in handlers {
                let kind = handler
                    .get("type")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("command");
                if kind != "command" {
                    problems.push(format!(
                        "{kind} hook on {event} does not run; only command hooks run"
                    ));
                    continue;
                }
                labels.push(match matcher {
                    Some(matcher) => format!("{event}({matcher})"),
                    None => event.clone(),
                });
            }
        }
    }
    labels
}

fn read_hooks_value(layout: &PluginLayout, problems: &mut Vec<String>) -> Option<JsonValue> {
    if let Some(inline) = &layout.hooks_inline {
        return Some(inline.clone());
    }
    let file = layout.hooks_file.as_ref()?;
    match fs::read_to_string(file)
        .map_err(|error| error.to_string())
        .and_then(|text| {
            serde_json::from_str::<JsonValue>(&text).map_err(|error| error.to_string())
        }) {
        Ok(value) => Some(value),
        Err(error) => {
            problems.push(format!("hooks file {} unreadable: {error}", file.display()));
            None
        }
    }
}

fn asset_root(
    name: &str,
    scope: &str,
    root: &Path,
    layout: &PluginLayout,
) -> crate::assets::PluginRoot {
    crate::assets::PluginRoot {
        name: name.to_string(),
        scope: scope.to_string(),
        root: root.to_path_buf(),
        rule_dirs: layout.rule_dirs.clone(),
        skill_dirs: layout.skill_dirs.clone(),
        command_dirs: layout.command_dirs.clone(),
        agent_dirs: layout.agent_dirs.clone(),
    }
}

fn contributions_for(ctx: &Context, name: &str, root: &Path) -> Contributions {
    let mut out = Contributions::default();
    if !root.is_dir() {
        return out;
    }
    let layout = plugin_layout(root);
    out.problems.extend(layout.problems.iter().cloned());
    let home = ctx
        .env
        .get("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| ctx.grok_home.clone());
    let plugin = asset_root(name, "user", root, &layout);
    let input = crate::assets::DiscoverInput {
        cwd: &ctx.cwd,
        grok_home: &ctx.grok_home,
        home: &home,
        project_active: false,
        claude_rules: false,
        cursor_rules: false,
        claude_agents: false,
        claude_skills: false,
        cursor_skills: false,
        extra_rule_dirs: &[],
        skill_paths: &[],
        skill_ignore: &[],
        skill_disabled: &[],
        builtin_commands: &[],
        plugins: &[],
    };
    let found = crate::assets::plugin_assets(&input, &plugin);
    out.rules = found
        .rules
        .iter()
        .map(|rule| {
            rule.path
                .strip_prefix(root)
                .unwrap_or(&rule.path)
                .display()
                .to_string()
        })
        .collect();
    out.skills = found
        .skills
        .iter()
        .map(|skill| format!("/{}", skill.qualified))
        .collect();
    out.commands = found
        .commands
        .iter()
        .map(|command| format!("/{}", command.qualified))
        .collect();
    out.agents = found
        .agents
        .iter()
        .map(|agent| agent.name.clone())
        .collect();
    out.problems.extend(
        found
            .diagnostics
            .iter()
            .map(|item| format!("{}: {}", item.kind, item.detail)),
    );
    if let Some(value) = read_hooks_value(&layout, &mut out.problems) {
        out.hooks = hook_labels(&value, &mut out.problems);
    }
    let (workflows, problems) =
        crate::workflow_catalog::plugin_workflow_names(name, &layout.workflow_dirs);
    out.workflows = workflows;
    out.problems.extend(problems);
    out
}

fn contribution_lines(contributions: &Contributions, indent: &str) -> Vec<String> {
    let mut lines = Vec::new();
    for (label, items) in [
        ("rules", &contributions.rules),
        ("skills", &contributions.skills),
        ("commands", &contributions.commands),
        ("agents", &contributions.agents),
        ("hooks", &contributions.hooks),
        ("workflows", &contributions.workflows),
    ] {
        if !items.is_empty() {
            lines.push(format!("{indent}{label} {}", items.join(", ")));
        }
    }
    if !contributions.mcp.is_empty() {
        lines.push(format!("{indent}mcp {}", mcp_line(&contributions.mcp)));
    }
    for problem in &contributions.problems {
        lines.push(format!("{indent}problem {problem}"));
    }
    lines
}

/// The expanded `/plugins` row: state, location, and every contribution by
/// the name a user types, its MCP servers with their session state, and
/// problems: at most five lines.
fn extension_view(plugin: &InstalledView) -> Vec<String> {
    let c = &plugin.contributions;
    let mut lines = vec![
        format!("    {}: {}", plugin.status, plugin.status_detail),
        format!(
            "    path {} · source {}",
            plugin.path.display(),
            plugin.source
        ),
    ];
    let names: Vec<&str> = c
        .skills
        .iter()
        .chain(&c.commands)
        .chain(&c.agents)
        .chain(&c.hooks)
        .chain(&c.workflows)
        .chain(&c.rules)
        .map(String::as_str)
        .collect();
    lines.push(if names.is_empty() {
        format!("    provides {}", c.summary())
    } else {
        format!("    provides {}: {}", c.summary(), names.join(", "))
    });
    if !c.mcp.is_empty() {
        lines.push(format!("    mcp {}", mcp_line(&c.mcp)));
    }
    if !c.problems.is_empty() {
        lines.push(format!("    note {}", c.problems.join("; ")));
    }
    lines
}

/// `name state (detail)` for each MCP server, comma separated.
fn mcp_line(servers: &[McpContribution]) -> String {
    servers
        .iter()
        .map(|server| match &server.detail {
            Some(detail) => format!("{} {} ({detail})", server.name, server.state),
            None => format!("{} {}", server.name, server.state),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Active plugins: enabled, trusted, present, and not shadowed. This is the
/// single gate both asset discovery and the hook runner use.
fn active_plugins(ctx: &Context) -> Vec<(InstalledView, PluginLayout)> {
    list_installed_views(ctx)
        .into_iter()
        .filter(|plugin| plugin.status == "active")
        .map(|plugin| {
            let layout = plugin_layout(&plugin.path);
            (plugin, layout)
        })
        .collect()
}

fn read_context(grok_home: &Path, cwd: &Path, workspace_trusted: bool) -> Context {
    Context {
        grok_home: grok_home.to_path_buf(),
        cwd: cwd.to_path_buf(),
        env: std::env::vars().collect(),
        workspace_trusted,
    }
}

/// Asset roots for `assets::discover`, from active plugins only.
pub fn active_roots(
    grok_home: &Path,
    cwd: &Path,
    workspace_trusted: bool,
) -> Vec<crate::assets::PluginRoot> {
    let ctx = read_context(grok_home, cwd, workspace_trusted);
    active_plugins(&ctx)
        .iter()
        .map(|(plugin, layout)| asset_root(&plugin.name, &plugin.scope, &plugin.path, layout))
        .collect()
}

pub const PLUGIN_HOOKS_ENV: &str = "CODSH_PLUGIN_HOOKS";

/// `CODSH_PLUGIN_HOOKS` for the dsh child: the hook files (or inline hook
/// tables) of active plugins with their root and data directory. The hooks
/// plugin loads them beside the user's own hooks, under the same contract.
/// It is always set, so an inherited value never reaches dsh.
pub fn hook_env(grok_home: &Path, cwd: &Path, workspace_trusted: bool) -> (String, String) {
    let ctx = read_context(grok_home, cwd, workspace_trusted);
    let entries: Vec<JsonValue> = active_plugins(&ctx)
        .into_iter()
        .filter(|(_, layout)| layout.hooks_file.is_some() || layout.hooks_inline.is_some())
        .map(|(plugin, layout)| {
            json!({
                "plugin": plugin.name,
                "scope": plugin.scope,
                "version": plugin.version,
                "root": plugin.path,
                "data": ctx.data_dir().join(&plugin.name),
                "file": layout.hooks_file,
                "body": layout.hooks_inline.as_ref().map(JsonValue::to_string),
            })
        })
        .collect();
    (
        PLUGIN_HOOKS_ENV.to_string(),
        JsonValue::Array(entries).to_string(),
    )
}

/// One installed plugin that declares workflows, for the workflow catalog
/// (ticket 205): identity, provenance, trust and state, and its workflow
/// directories. Only an `active` plugin's workflows load.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginWorkflowSource {
    pub name: String,
    pub scope: String,
    pub version: Option<String>,
    pub license: Option<String>,
    pub source: String,
    pub marketplace: Option<String>,
    pub commit: Option<String>,
    pub trusted: bool,
    pub status: String,
    pub status_detail: String,
    pub root: PathBuf,
    pub dirs: Vec<PathBuf>,
    pub problems: Vec<String>,
}

/// Every installed plugin (user and project scope, any state) whose layout
/// has a `workflows` directory. Reads registry, trust and config state and
/// the manifest; it reads no workflow file and runs nothing.
pub fn workflow_sources(
    grok_home: &Path,
    cwd: &Path,
    workspace_trusted: bool,
) -> Vec<PluginWorkflowSource> {
    let ctx = read_context(grok_home, cwd, workspace_trusted);
    installed_views(&ctx, false)
        .into_iter()
        .filter_map(|plugin| {
            let layout = if plugin.path.is_dir() {
                plugin_layout(&plugin.path)
            } else {
                PluginLayout::default()
            };
            if layout.workflow_dirs.is_empty() {
                return None;
            }
            Some(PluginWorkflowSource {
                name: plugin.name,
                scope: plugin.scope,
                version: plugin.version,
                license: plugin.license,
                source: plugin.source,
                marketplace: plugin.marketplace,
                commit: plugin.commit,
                trusted: plugin.trusted,
                status: plugin.status,
                status_detail: plugin.status_detail,
                root: plugin.path,
                dirs: layout.workflow_dirs,
                problems: layout.problems,
            })
        })
        .collect()
}

fn catalog_plugins(ctx: &Context, source: &MarketplaceSource) -> Vec<CatalogPlugin> {
    let root = match &source.kind {
        SourceKind::Local { path } => path.clone(),
        SourceKind::Git { url, branch } => {
            let cache = git_cache_dir(ctx, url);
            if cache.is_dir() {
                cache
            } else {
                match sync_git(url, branch.as_deref(), &cache, false) {
                    Ok(path) => path,
                    Err(_) => return Vec::new(),
                }
            }
        }
    };
    load_index(&root).unwrap_or_default()
}

fn catalog_plugins_from_home(
    grok_home: Option<&Path>,
    source: &MarketplaceSource,
) -> Vec<CatalogPlugin> {
    let root = match &source.kind {
        SourceKind::Local { path } => path.clone(),
        SourceKind::Git { url, .. } => {
            let Some(home) = grok_home else {
                return Vec::new();
            };
            let cache = home.join("marketplace-cache").join(repo_key(url));
            if !cache.is_dir() {
                return Vec::new();
            }
            cache
        }
    };
    load_index(&root).unwrap_or_default()
}

fn load_index(root: &Path) -> Result<Vec<CatalogPlugin>, PluginError> {
    let candidates = [
        root.join(".grok-plugin/marketplace.json"),
        root.join(".grok-plugin/plugin.json"),
        root.join(".claude-plugin/marketplace.json"),
        root.join(".claude-plugin/plugin.json"),
    ];
    for path in candidates {
        if !path.is_file() {
            continue;
        }
        let text = fs::read_to_string(&path).map_err(io_fail)?;
        let value: JsonValue = serde_json::from_str(&text).map_err(|error| {
            PluginError::fail(format!("failed to parse {}: {error}", path.display()))
        })?;
        let mut plugins = Vec::new();
        let Some(entries) = value.get("plugins").and_then(JsonValue::as_array) else {
            return Ok(plugins);
        };
        for entry in entries {
            let name = entry
                .get("name")
                .and_then(JsonValue::as_str)
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                continue;
            }
            let source = entry.get("source");
            let relative = match source {
                Some(JsonValue::String(path)) => normalize_rel(path)?,
                Some(JsonValue::Object(map)) => {
                    if let Some(url) = map.get("url").and_then(JsonValue::as_str) {
                        plugins.push(CatalogPlugin {
                            name,
                            version: entry
                                .get("version")
                                .and_then(JsonValue::as_str)
                                .map(str::to_string),
                            description: entry
                                .get("description")
                                .and_then(JsonValue::as_str)
                                .map(str::to_string),
                            license: entry
                                .get("license")
                                .and_then(JsonValue::as_str)
                                .map(str::to_string),
                            relative_path: String::new(),
                            remote_url: Some(url.to_string()),
                            remote_sha: map
                                .get("sha")
                                .and_then(JsonValue::as_str)
                                .map(str::to_string),
                        });
                        continue;
                    }
                    let path = map
                        .get("path")
                        .and_then(JsonValue::as_str)
                        .ok_or_else(|| PluginError::fail("missing source path"))?;
                    normalize_rel(path)?
                }
                _ => continue,
            };
            plugins.push(CatalogPlugin {
                name,
                version: entry
                    .get("version")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
                description: entry
                    .get("description")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
                license: entry
                    .get("license")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
                relative_path: relative,
                remote_url: None,
                remote_sha: None,
            });
        }
        return Ok(plugins);
    }
    Ok(Vec::new())
}

fn normalize_rel(path: &str) -> Result<String, PluginError> {
    let stripped = path.strip_prefix("./").unwrap_or(path);
    if stripped.is_empty()
        || stripped.starts_with('/')
        || stripped.split('/').any(|part| part == "..")
    {
        return Err(PluginError::fail(format!(
            "marketplace path must be relative without parent components: {path}"
        )));
    }
    Ok(stripped.replace('\\', "/"))
}

fn load_marketplace_sources(ctx: &Context) -> Vec<MarketplaceSource> {
    load_marketplace_catalog(ctx).0
}

fn load_configured_marketplace_sources(ctx: &Context) -> Vec<MarketplaceSource> {
    collect_marketplace_sources(ctx).0
}

fn load_marketplace_catalog(ctx: &Context) -> (Vec<MarketplaceSource>, Vec<String>) {
    let (sources, mut warnings) = collect_marketplace_sources(ctx);
    let (policy, policy_warnings) = marketplace_allowlist(ctx);
    warnings.extend(policy_warnings);
    let mut kept = Vec::new();
    for source in sources {
        if let Some(reason) = catalog_allowlist_block(&policy, &source) {
            warnings.push(format!(
                "Marketplace source blocked by allowlist: {} ({}) — {reason}",
                source.name,
                source.identity()
            ));
            continue;
        }
        kept.push(source);
    }
    (kept, warnings)
}

fn collect_marketplace_sources(ctx: &Context) -> (Vec<MarketplaceSource>, Vec<String>) {
    let mut sources = Vec::new();
    let mut warnings = Vec::new();
    let mut seen_identity = BTreeSet::new();
    let mut seen_names = BTreeSet::new();
    for (origin, value) in load_toml_layers(ctx) {
        for source in extra_known_sources_from_toml(&value, origin, &mut warnings) {
            push_marketplace_source(
                source,
                &mut sources,
                &mut seen_identity,
                &mut seen_names,
                &mut warnings,
            );
        }
        for source in sources_from_toml(&value, origin) {
            push_marketplace_source(
                source,
                &mut sources,
                &mut seen_identity,
                &mut seen_names,
                &mut warnings,
            );
        }
    }
    (sources, warnings)
}

fn push_marketplace_source(
    source: MarketplaceSource,
    sources: &mut Vec<MarketplaceSource>,
    seen_identity: &mut BTreeSet<String>,
    seen_names: &mut BTreeSet<String>,
    warnings: &mut Vec<String>,
) {
    let identity = canonicalize_git(&source.identity());
    if seen_names.contains(&source.name) {
        warnings.push(format!(
            "marketplace source \"{}\" already pinned; later {} pin ignored",
            source.name, source.origin
        ));
        return;
    }
    if seen_identity.contains(&identity) {
        return;
    }
    seen_names.insert(source.name.clone());
    seen_identity.insert(identity);
    sources.push(source);
}

fn load_toml_layers(ctx: &Context) -> Vec<(&'static str, TomlValue)> {
    let mut layers = Vec::new();
    for (name, path) in [
        ("managed", ctx.grok_home.join("managed_config.toml")),
        ("config.toml", ctx.config_path()),
        ("requirements", ctx.grok_home.join("requirements.toml")),
    ] {
        if let Ok(text) = fs::read_to_string(path)
            && let Ok(value) = toml::from_str::<TomlValue>(&text)
        {
            layers.push((name, value));
        }
    }
    if ctx.workspace_trusted {
        let path = ctx.cwd.join(".grok").join("config.toml");
        if let Ok(text) = fs::read_to_string(path)
            && let Ok(value) = toml::from_str::<TomlValue>(&text)
        {
            layers.push(("workspace", value));
        }
    }
    layers
}

fn sources_from_toml(value: &TomlValue, origin: &str) -> Vec<MarketplaceSource> {
    let mut sources = Vec::new();
    if let Some(entries) = value
        .get("marketplace")
        .and_then(|table| table.get("sources"))
        .and_then(TomlValue::as_array)
    {
        for entry in entries {
            let Some(name) = entry.get("name").and_then(TomlValue::as_str) else {
                continue;
            };
            let kind = if let Some(git) = entry.get("git").and_then(TomlValue::as_str) {
                SourceKind::Git {
                    url: git.to_string(),
                    branch: entry
                        .get("branch")
                        .and_then(TomlValue::as_str)
                        .map(str::to_string),
                }
            } else if let Some(path) = entry.get("path").and_then(TomlValue::as_str) {
                SourceKind::Local {
                    path: expand_home(path),
                }
            } else {
                continue;
            };
            sources.push(MarketplaceSource {
                name: name.to_string(),
                kind,
                origin: origin.to_string(),
            });
        }
    }
    sources
}

fn extra_known_sources_from_toml(
    value: &TomlValue,
    origin: &str,
    warnings: &mut Vec<String>,
) -> Vec<MarketplaceSource> {
    let Some(raw) = value.get("extra_known_marketplaces") else {
        return Vec::new();
    };
    let Some(table) = raw.as_table() else {
        warnings.push(format!(
            "extra_known_marketplaces from {origin} was ignored: expected a table of named sources"
        ));
        return Vec::new();
    };
    let mut sources = Vec::new();
    for (name, entry) in table {
        match extra_known_kind(entry) {
            Ok(kind) => sources.push(MarketplaceSource {
                name: name.clone(),
                kind,
                origin: origin.to_string(),
            }),
            Err(reason) => warnings.push(format!(
                "extra_known_marketplaces.{name} from {origin} was ignored: {reason}"
            )),
        }
    }
    sources
}

fn extra_known_kind(entry: &TomlValue) -> Result<SourceKind, String> {
    if let Some(text) = entry.as_str() {
        return extra_known_from_text(text);
    }
    if let Some(text) = entry.get("source").and_then(TomlValue::as_str)
        && entry.get("url").is_none()
        && entry.get("git").is_none()
        && entry.get("path").is_none()
        && entry.get("repo").is_none()
    {
        return extra_known_from_text(text);
    }
    let nested = entry
        .get("source")
        .filter(|value| value.as_table().is_some())
        .unwrap_or(entry);
    let branch = nested
        .get("ref")
        .or_else(|| nested.get("branch"))
        .or_else(|| entry.get("ref"))
        .or_else(|| entry.get("branch"))
        .and_then(TomlValue::as_str)
        .map(str::to_string);
    if let Some(url) = nested
        .get("url")
        .and_then(TomlValue::as_str)
        .or_else(|| nested.get("git").and_then(TomlValue::as_str))
        .or_else(|| entry.get("url").and_then(TomlValue::as_str))
        .or_else(|| entry.get("git").and_then(TomlValue::as_str))
    {
        return Ok(SourceKind::Git {
            url: url.to_string(),
            branch,
        });
    }
    if let Some(path) = nested
        .get("path")
        .and_then(TomlValue::as_str)
        .or_else(|| entry.get("path").and_then(TomlValue::as_str))
    {
        return Ok(SourceKind::Local {
            path: expand_home(path),
        });
    }
    if let Some(repo) = nested
        .get("repo")
        .and_then(TomlValue::as_str)
        .or_else(|| entry.get("repo").and_then(TomlValue::as_str))
    {
        return Ok(SourceKind::Git {
            url: format!("https://github.com/{repo}.git"),
            branch,
        });
    }
    Err("missing git url, github repo, or local path".into())
}

fn extra_known_from_text(text: &str) -> Result<SourceKind, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("empty extra_known_marketplaces source".into());
    }
    if text.contains("://") || text.starts_with("git@") {
        return Ok(SourceKind::Git {
            url: text.to_string(),
            branch: None,
        });
    }
    if let Some((owner, repo)) = text.split_once('/')
        && !owner.is_empty()
        && !repo.is_empty()
        && !text.contains('.')
        && !text.starts_with('/')
        && !text.starts_with('~')
    {
        return Ok(SourceKind::Git {
            url: format!("https://github.com/{owner}/{repo}.git"),
            branch: None,
        });
    }
    Ok(SourceKind::Local {
        path: expand_home(text),
    })
}

fn append_marketplace_source(
    ctx: &Context,
    name: &str,
    kind: &SourceKind,
) -> Result<(), PluginError> {
    fs::create_dir_all(&ctx.grok_home).map_err(io_fail)?;
    let path = ctx.config_path();
    let existing = if path.exists() {
        fs::read_to_string(&path).map_err(io_fail)?
    } else {
        String::new()
    };
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push('\n');
    text.push_str("[[marketplace.sources]]\n");
    text.push_str(&format!("name = \"{}\"\n", escape_toml(name)));
    match kind {
        SourceKind::Git { url, branch } => {
            text.push_str(&format!("git = \"{}\"\n", escape_toml(url)));
            if let Some(branch) = branch {
                text.push_str(&format!("branch = \"{}\"\n", escape_toml(branch)));
            }
        }
        SourceKind::Local { path: local } => {
            text.push_str(&format!(
                "path = \"{}\"\n",
                escape_toml(&local.display().to_string())
            ));
        }
    }
    atomic_write(&path, text.as_bytes())
}

fn remove_marketplace_source(ctx: &Context, identity: &str) -> Result<(), PluginError> {
    let path = ctx.config_path();
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(());
    };
    let mut kept = String::new();
    let mut block = String::new();
    let mut in_source = false;
    let flush = |out: &mut String, block: &mut String| {
        if block.is_empty() {
            return;
        }
        let drop_block = source_block_matches(block, identity);
        if !drop_block {
            out.push_str(block);
        }
        block.clear();
    };
    for line in text.split_inclusive('\n') {
        if line.trim_start().starts_with("[[marketplace.sources]]") {
            flush(&mut kept, &mut block);
            in_source = true;
            block.push_str(line);
            continue;
        }
        if in_source {
            if line.starts_with('[') && !line.trim_start().starts_with("[[marketplace.sources]]") {
                flush(&mut kept, &mut block);
                in_source = false;
                kept.push_str(line);
            } else {
                block.push_str(line);
            }
        } else {
            kept.push_str(line);
        }
    }
    flush(&mut kept, &mut block);
    atomic_write(&path, kept.as_bytes())
}

fn source_block_matches(block: &str, identity: &str) -> bool {
    for line in block.lines() {
        let trimmed = line.trim();
        if let Some(value) = toml_quoted_assignment(trimmed, "git")
            && canonicalize_git(&value) == canonicalize_git(identity)
        {
            return true;
        }
        if let Some(value) = toml_quoted_assignment(trimmed, "path")
            && (expand_home(&value).display().to_string() == identity || value == identity)
        {
            return true;
        }
        if let Some(value) = toml_quoted_assignment(trimmed, "name")
            && value == identity
        {
            return true;
        }
    }
    false
}

fn toml_quoted_assignment(line: &str, key: &str) -> Option<String> {
    let prefix = format!("{key} =");
    let rest = line.strip_prefix(&prefix)?.trim();
    let rest = rest.strip_prefix('"')?.strip_suffix('"')?;
    Some(rest.replace("\\\"", "\"").replace("\\\\", "\\"))
}

fn find_marketplace<'a>(
    sources: &'a [MarketplaceSource],
    input: &str,
    cwd: &Path,
) -> Result<&'a MarketplaceSource, PluginError> {
    let named: Vec<_> = sources
        .iter()
        .filter(|source| source.name == input)
        .collect();
    match named.as_slice() {
        [source] => return Ok(source),
        [] => {}
        many => {
            return Err(PluginError::fail(format!(
                "Multiple sources are named \"{input}\"; remove by URL/path instead: {}",
                many.iter()
                    .map(|source| source.identity())
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
    }
    let expanded = classify_marketplace_input(input, cwd).ok();
    sources
        .iter()
        .find(|source| match &source.kind {
            SourceKind::Git { url, .. } => {
                canonicalize_git(url) == canonicalize_git(input)
                    || canonicalize_git(url) == canonicalize_git(&expand_github(input))
            }
            SourceKind::Local { path } => {
                path.display().to_string() == input
                    || matches!(expanded, Some(SourceKind::Local { path: ref other }) if other == path)
            }
        })
        .ok_or_else(|| {
            let names: Vec<_> = sources.iter().map(|source| source.name.as_str()).collect();
            if names.is_empty() {
                PluginError::fail(format!(
                    "Marketplace source \"{input}\" not found; no sources are configured."
                ))
            } else {
                PluginError::fail(format!(
                    "Marketplace source \"{input}\" not found. Configured sources: {}",
                    names.join(", ")
                ))
            }
        })
}

fn classify_marketplace_input(input: &str, cwd: &Path) -> Result<SourceKind, PluginError> {
    let expanded = expand_path(input, cwd);
    if expanded.exists() {
        return Ok(SourceKind::Local { path: expanded });
    }
    if input.contains("://") || input.starts_with("git@") {
        return Ok(SourceKind::Git {
            url: input.to_string(),
            branch: None,
        });
    }
    if let Some((owner, repo)) = input.split_once('/')
        && !owner.is_empty()
        && !repo.is_empty()
        && !input.contains('.')
    {
        return Ok(SourceKind::Git {
            url: format!("https://github.com/{owner}/{repo}.git"),
            branch: None,
        });
    }
    Ok(SourceKind::Local { path: expanded })
}

struct AllowEntry {
    git: Option<String>,
}

struct MarketplaceAllowlist {
    present: bool,
    locked_down: bool,
    /// Every present list must allow the source (strictest-wins). Empty when locked down.
    layers: Vec<Vec<AllowEntry>>,
    /// Admin (requirements/managed) local pins that may pass a binding strict list.
    admin_local_paths: BTreeSet<String>,
}

fn marketplace_allowlist(ctx: &Context) -> (MarketplaceAllowlist, Vec<String>) {
    let mut policy = MarketplaceAllowlist {
        present: false,
        locked_down: false,
        layers: Vec::new(),
        admin_local_paths: BTreeSet::new(),
    };
    let mut warnings = Vec::new();
    for (origin, value) in load_toml_layers(ctx) {
        if is_admin_origin(origin) {
            let mut ignored = Vec::new();
            for source in extra_known_sources_from_toml(&value, origin, &mut ignored) {
                if let SourceKind::Local { path } = &source.kind {
                    policy
                        .admin_local_paths
                        .insert(normalize_local_identity(&path.display().to_string()));
                }
            }
        }
        let Some(list) = value.get("strict_known_marketplaces") else {
            continue;
        };
        policy.present = true;
        let Some(entries) = list.as_array() else {
            policy.layers.clear();
            policy.locked_down = true;
            warnings.push(format!(
                "strict_known_marketplaces from {origin} is not a list; marketplace adds are locked down"
            ));
            continue;
        };
        if policy.locked_down {
            continue;
        }
        let mut layer = Vec::new();
        for entry in entries {
            match parse_allow_entry(entry) {
                AllowParse::Git(url) => layer.push(AllowEntry { git: Some(url) }),
                AllowParse::DroppedLocal => warnings.push(format!(
                    "strict_known_marketplaces local entry from {origin} was ignored; local paths never match the allowlist"
                )),
                AllowParse::Unsupported => warnings.push(format!(
                    "strict_known_marketplaces entry from {origin} was ignored: expected git url or github repo"
                )),
            }
        }
        // A later layer cannot widen or clear an earlier lockdown.
        policy.layers.push(layer);
    }
    if policy.locked_down || policy.layers.iter().any(|layer| layer.is_empty()) {
        policy.locked_down = policy.present;
        policy.layers.clear();
    }
    (policy, warnings)
}

fn is_admin_origin(origin: &str) -> bool {
    matches!(origin, "requirements" | "managed")
}

enum AllowParse {
    Git(String),
    DroppedLocal,
    Unsupported,
}

fn parse_allow_entry(entry: &TomlValue) -> AllowParse {
    let nested = entry
        .get("source")
        .filter(|value| value.is_table())
        .unwrap_or(entry);
    let kind = nested
        .get("source")
        .and_then(TomlValue::as_str)
        .or_else(|| entry.get("source").and_then(TomlValue::as_str));
    if kind == Some("local") || nested.get("path").is_some() || entry.get("path").is_some() {
        return AllowParse::DroppedLocal;
    }
    if let Some(url) = nested
        .get("url")
        .and_then(TomlValue::as_str)
        .or_else(|| nested.get("git").and_then(TomlValue::as_str))
        .or_else(|| entry.get("url").and_then(TomlValue::as_str))
        .or_else(|| entry.get("git").and_then(TomlValue::as_str))
    {
        if kind == Some("github") {
            return AllowParse::Unsupported;
        }
        return AllowParse::Git(canonicalize_git(url));
    }
    if let Some(repo) = nested
        .get("repo")
        .and_then(TomlValue::as_str)
        .or_else(|| entry.get("repo").and_then(TomlValue::as_str))
    {
        return AllowParse::Git(canonicalize_git(&format!("https://github.com/{repo}.git")));
    }
    AllowParse::Unsupported
}

fn source_is_local(source: &MarketplaceSource) -> bool {
    matches!(source.kind, SourceKind::Local { .. })
}

fn catalog_allowlist_block(
    policy: &MarketplaceAllowlist,
    source: &MarketplaceSource,
) -> Option<String> {
    if !policy.present {
        return None;
    }
    let local = source_is_local(source);
    let identity = source.identity();
    if local
        && policy
            .admin_local_paths
            .contains(&normalize_local_identity(&identity))
    {
        return None;
    }
    if local {
        return Some(
            "local-path sources are refused while a strict marketplace allowlist is present".into(),
        );
    }
    git_allowlist_miss(policy, &identity)
}

fn allowlist_block(ctx: &Context, identity: &str, is_local: bool) -> Option<String> {
    let (policy, _) = marketplace_allowlist(ctx);
    if !policy.present {
        return None;
    }
    if is_local {
        let normalized = normalize_local_identity(identity);
        if policy.admin_local_paths.contains(&normalized) {
            return None;
        }
        return Some(
            "local-path adds are refused while a strict marketplace allowlist is present".into(),
        );
    }
    git_allowlist_miss(&policy, identity)
}

/// Every present strict list must allow `identity`. A later user or workspace
/// list cannot widen an earlier empty or narrower list.
fn git_allowlist_miss(policy: &MarketplaceAllowlist, identity: &str) -> Option<String> {
    if policy.locked_down || policy.layers.is_empty() {
        return Some(
            "strict_known_marketplaces is present but empty or unsupported; source refused".into(),
        );
    }
    let canon = canonicalize_git(identity);
    for layer in &policy.layers {
        if !layer
            .iter()
            .any(|entry| entry.git.as_deref() == Some(canon.as_str()))
        {
            return Some("source not in strict_known_marketplaces".into());
        }
    }
    None
}

/// The URL that `clone_git` will fetch. Marketplace parent identity is not enough:
/// a catalog entry can name a different remote.
fn clone_url_block(ctx: &Context, parsed: &ParsedSource) -> Option<String> {
    let url = parsed.git_url.as_deref()?;
    allowlist_block(ctx, url, false)
}

fn normalize_local_identity(identity: &str) -> String {
    expand_home(identity).display().to_string()
}

fn load_registry(ctx: &Context) -> Result<InstallRegistry, PluginError> {
    let path = ctx.registry_path();
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|error| {
            PluginError::fail(format!("failed to parse {}: {error}", path.display()))
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(InstallRegistry::empty()),
        Err(error) => Err(io_fail(error)),
    }
}

fn save_registry(ctx: &Context, registry: &InstallRegistry) -> Result<(), PluginError> {
    fs::create_dir_all(ctx.install_dir()).map_err(io_fail)?;
    let encoded = serde_json::to_string_pretty(registry)
        .map_err(|error| PluginError::fail(error.to_string()))?;
    atomic_write(&ctx.registry_path(), encoded.as_bytes())
}

fn trusted_set(ctx: &Context) -> Result<BTreeSet<String>, PluginError> {
    let path = ctx.trust_path();
    let Ok(text) = fs::read_to_string(path) else {
        return Ok(BTreeSet::new());
    };
    let value: TomlValue = toml::from_str(&text)
        .map_err(|error| PluginError::fail(format!("trusted-plugins.toml: {error}")))?;
    Ok(value
        .get("trusted")
        .and_then(TomlValue::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(TomlValue::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default())
}

fn write_trusted_set(ctx: &Context, trusted: &BTreeSet<String>) -> Result<(), PluginError> {
    let mut text = String::from("trusted = [");
    for (index, name) in trusted.iter().enumerate() {
        if index > 0 {
            text.push_str(", ");
        }
        text.push_str(&format!("\"{}\"", escape_toml(name)));
    }
    text.push_str("]\n");
    atomic_write(&ctx.trust_path(), text.as_bytes())
}

fn record_trust(ctx: &Context, names: &[String], trusted: bool) -> Result<(), PluginError> {
    let mut set = trusted_set(ctx)?;
    for name in names {
        if trusted {
            set.insert(name.clone());
        } else {
            set.remove(name);
        }
    }
    write_trusted_set(ctx, &set)
}

fn enabled_set(ctx: &Context) -> BTreeSet<String> {
    string_list_from_config(ctx, "enabled")
}

fn disabled_set(ctx: &Context) -> BTreeSet<String> {
    string_list_from_config(ctx, "disabled")
}

fn string_list_from_config(ctx: &Context, key: &str) -> BTreeSet<String> {
    load_toml_layers(ctx)
        .into_iter()
        .filter_map(|(_, value)| {
            value
                .get("plugins")
                .and_then(|table| table.get(key))
                .and_then(TomlValue::as_array)
                .cloned()
        })
        .flatten()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect()
}

fn write_enabled_lists(
    ctx: &Context,
    enabled: &BTreeSet<String>,
    disabled: &BTreeSet<String>,
) -> Result<(), PluginError> {
    fs::create_dir_all(&ctx.grok_home).map_err(io_fail)?;
    let path = ctx.config_path();
    let existing = if path.exists() {
        fs::read_to_string(&path).map_err(io_fail)?
    } else {
        String::new()
    };
    let enabled_line = format!(
        "enabled = [{}]\n",
        enabled
            .iter()
            .map(|name| format!("\"{}\"", escape_toml(name)))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let disabled_line = format!(
        "disabled = [{}]\n",
        disabled
            .iter()
            .map(|name| format!("\"{}\"", escape_toml(name)))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let text = insert_plugin_list_keys(
        &strip_plugin_list_keys(&existing),
        &enabled_line,
        &disabled_line,
    );
    atomic_write(&path, text.as_bytes())
}

fn insert_plugin_list_keys(text: &str, enabled: &str, disabled: &str) -> String {
    if !text.contains("[plugins]") {
        let mut out = text.to_string();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("\n[plugins]\n");
        out.push_str(enabled);
        out.push_str(disabled);
        return out;
    }
    let mut out = String::new();
    let mut inserted = false;
    for line in text.split_inclusive('\n') {
        out.push_str(line);
        if !inserted && line.trim() == "[plugins]" {
            out.push_str(enabled);
            out.push_str(disabled);
            inserted = true;
        }
    }
    out
}

fn strip_plugin_list_keys(text: &str) -> String {
    let mut out = String::new();
    let mut in_plugins = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            in_plugins = trimmed.trim() == "[plugins]";
        }
        if in_plugins && (trimmed.starts_with("enabled") || trimmed.starts_with("disabled")) {
            continue;
        }
        out.push_str(line);
    }
    out
}

fn copy_tree(src: &Path, dst: &Path) -> Result<(), PluginError> {
    let meta = fs::symlink_metadata(src).map_err(io_fail)?;
    if meta.file_type().is_symlink() {
        return Err(PluginError::fail(format!(
            "refusing to copy symlink plugin source {}",
            src.display()
        )));
    }
    fs::create_dir_all(dst).map_err(io_fail)?;
    for entry in fs::read_dir(src).map_err(io_fail)? {
        let entry = entry.map_err(io_fail)?;
        let file_type = entry.file_type().map_err(io_fail)?;
        let target = dst.join(entry.file_name());
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target).map_err(io_fail)?;
        }
    }
    Ok(())
}

fn clone_git(url: &str, git_ref: Option<&str>, dest: &Path) -> Result<(), PluginError> {
    if dest.exists() {
        let _ = fs::remove_dir_all(dest);
    }
    let mut command = git_command();
    command.args(["clone", "--quiet"]);
    if let Some(value) = git_ref
        && !is_full_sha(value)
    {
        command.args(["--branch", value]);
    }
    command.args([url, &dest.display().to_string()]);
    let output = command
        .output()
        .map_err(|error| PluginError::fail(format!("git clone failed to start: {error}")))?;
    if !output.status.success() {
        let _ = fs::remove_dir_all(dest);
        return Err(PluginError::fail(format!(
            "git clone failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    if let Some(value) = git_ref
        && is_full_sha(value)
    {
        let checkout = git_command()
            .current_dir(dest)
            .args(["checkout", "--quiet", value])
            .output()
            .map_err(io_fail)?;
        if !checkout.status.success() {
            let _ = fs::remove_dir_all(dest);
            return Err(PluginError::fail(format!(
                "git checkout {value} failed: {}",
                String::from_utf8_lossy(&checkout.stderr).trim()
            )));
        }
        let head = git_head(dest)?;
        if !head.eq_ignore_ascii_case(value) {
            let _ = fs::remove_dir_all(dest);
            return Err(PluginError::fail(format!(
                "SHA verification failed: expected {value}, got {head}"
            )));
        }
    }
    Ok(())
}

fn sync_git(
    url: &str,
    branch: Option<&str>,
    dest: &Path,
    force: bool,
) -> Result<PathBuf, PluginError> {
    if dest.join(".git").exists() {
        if force {
            let fetch = git_command()
                .current_dir(dest)
                .args(["fetch", "--quiet", "--all"])
                .output()
                .map_err(io_fail)?;
            if !fetch.status.success() {
                return Err(PluginError::fail(format!(
                    "git fetch failed: {}",
                    String::from_utf8_lossy(&fetch.stderr).trim()
                )));
            }
            let target = branch.unwrap_or("HEAD");
            let checkout = git_command()
                .current_dir(dest)
                .args(["reset", "--hard", &format!("origin/{target}")])
                .output()
                .or_else(|_| {
                    git_command()
                        .current_dir(dest)
                        .args(["reset", "--hard", "HEAD"])
                        .output()
                })
                .map_err(io_fail)?;
            if !checkout.status.success() {
                return Err(PluginError::fail(
                    String::from_utf8_lossy(&checkout.stderr).trim().to_string(),
                ));
            }
        }
        return Ok(dest.to_path_buf());
    }
    clone_git(url, branch, dest)?;
    Ok(dest.to_path_buf())
}

fn probe_git_remote(url: &str) -> Result<(), PluginError> {
    let output = git_command()
        .args(["ls-remote", "--exit-code", url, "HEAD"])
        .output()
        .map_err(|error| PluginError::fail(format!("git probe failed: {error}")))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(PluginError::fail(format!(
            "{}\nNot adding \"{url}\": it doesn't look like a reachable git repository. Re-run with --force to add it anyway.",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

fn git_head(repo: &Path) -> Result<String, PluginError> {
    let output = git_command()
        .current_dir(repo)
        .args(["rev-parse", "HEAD"])
        .output()
        .map_err(io_fail)?;
    if !output.status.success() {
        return Err(PluginError::fail(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_command() -> Command {
    let mut command = Command::new("git");
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .stdin(std::process::Stdio::null());
    command
}

fn git_cache_dir(ctx: &Context, url: &str) -> PathBuf {
    ctx.grok_home.join("marketplace-cache").join(repo_key(url))
}

fn plugin_install_identity(marketplace_identity: &str, plugin_name: &str) -> String {
    format!("{marketplace_identity}#{plugin_name}")
}

fn repo_key(source: &str) -> String {
    let basename = source
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .rsplit('/')
        .next()
        .unwrap_or("plugin");
    let sanitized: String = basename
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('-');
    format!("{trimmed}-{:08x}", fnv1a32(source.as_bytes()))
}

fn fnv1a32(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in bytes {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

fn contained_join(root: &Path, rel: &str) -> Result<PathBuf, PluginError> {
    let normalized = normalize_rel(rel)?;
    let candidate = root.join(&normalized);
    let canonical_root = fs::canonicalize(root).map_err(io_fail)?;
    let canonical = fs::canonicalize(&candidate).unwrap_or(candidate.clone());
    if !canonical.starts_with(&canonical_root) {
        return Err(PluginError::fail(
            "marketplace path escapes marketplace root",
        ));
    }
    Ok(candidate)
}

pub(crate) fn is_valid_plugin_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

fn name_from_dirname(dir: &Path) -> Option<String> {
    let dirname = dir.file_name()?.to_str()?;
    let sanitized: String = dirname
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('-').to_string();
    is_valid_plugin_name(&trimmed).then_some(trimmed)
}

fn name_from_identity(kind: &SourceKind) -> String {
    match kind {
        SourceKind::Git { url, .. } => repo_key(url)
            .rsplit_once('-')
            .map(|(name, _)| name.to_string())
            .unwrap_or_else(|| "marketplace".into()),
        SourceKind::Local { path } => path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "local".into()),
    }
}

fn is_official_source_url(url: &str) -> bool {
    canonical_github_owner_repo(url)
        .as_deref()
        .is_some_and(|owner_repo| owner_repo.eq_ignore_ascii_case("xai-org/plugin-marketplace"))
}

/// GitHub owner/repo with host forms folded and the path left in original case.
/// `None` when the URL is not a GitHub repository location.
fn canonical_github_owner_repo(url: &str) -> Option<String> {
    let text = url.trim().strip_suffix('/').unwrap_or(url.trim());
    let text = text.strip_suffix(".git").unwrap_or(text);
    if let Some(path) = scp_github_owner_repo(text) {
        return Some(path);
    }
    let lower = text.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .or_else(|| lower.strip_prefix("ssh://"))?;
    let rest = rest.strip_prefix("git@").unwrap_or(rest);
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    let folded_path = rest
        .strip_prefix("github.com/")
        .or_else(|| rest.strip_prefix("github.com:"))?;
    github_path_preserving_case(text, folded_path)
}

fn scp_github_owner_repo(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let rest = lower.strip_prefix("git@")?;
    let folded_path = rest.strip_prefix("github.com:")?;
    github_path_preserving_case(text, folded_path)
}

fn github_path_preserving_case(original: &str, folded_path: &str) -> Option<String> {
    if folded_path.is_empty()
        || folded_path.contains('?')
        || folded_path.contains('#')
        || folded_path.contains('@')
    {
        return None;
    }
    let start = original.len().checked_sub(folded_path.len())?;
    let path = &original[start..];
    path.eq_ignore_ascii_case(folded_path)
        .then(|| path.to_string())
}

fn canonicalize_git(url: &str) -> String {
    if let Some(owner_repo) = canonical_github_owner_repo(url) {
        return format!("https://github.com/{owner_repo}.git");
    }
    let text = url.trim();
    let text = text.strip_suffix('/').unwrap_or(text);
    // One trailing `.git` only. `repo.git.git` is a different repository.
    let text = text.strip_suffix(".git").unwrap_or(text);
    fold_scheme_and_host(text)
}

/// Fold case on the scheme and host only. Path, user, and query stay literal.
fn fold_scheme_and_host(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return url.to_string();
    };
    let scheme = url[..scheme_end].to_ascii_lowercase();
    let rest = &url[scheme_end + 3..];
    let (authority, tail) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    let host_start = authority.rfind('@').map(|index| index + 1).unwrap_or(0);
    let host_end = authority.rfind(':').unwrap_or(authority.len());
    let host_end = if host_end < host_start {
        authority.len()
    } else {
        host_end
    };
    let mut folded = String::new();
    folded.push_str(&scheme);
    folded.push_str("://");
    folded.push_str(&authority[..host_start]);
    folded.push_str(&authority[host_start..host_end].to_ascii_lowercase());
    folded.push_str(&authority[host_end..]);
    folded.push_str(tail);
    folded
}

fn expand_github(input: &str) -> String {
    if let Some((owner, repo)) = input.split_once('/')
        && !owner.is_empty()
        && !repo.contains('/')
        && !input.contains("://")
    {
        return format!("https://github.com/{owner}/{repo}.git");
    }
    input.to_string()
}

fn expand_path(input: &str, cwd: &Path) -> PathBuf {
    let path = expand_home(input);
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}

fn expand_home(input: &str) -> PathBuf {
    if let Some(rest) = input.strip_prefix("~/")
        && let Some(home) = std::env::var_os("HOME")
    {
        return PathBuf::from(home).join(rest);
    }
    PathBuf::from(input)
}

fn is_full_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn unpinned_remote_error(subject: &str, identity: &str) -> PluginError {
    PluginError::fail(format!(
        "refusing unpinned remote plugin code for {subject} from {identity}: marketplace.require_sha / GROK_MARKETPLACE_REQUIRE_SHA is enabled and no full commit sha (40/64 hex) is pinned"
    ))
}

fn trust_prompt(subject: &str, source_arg: &str) -> String {
    format!(
        "Installing {subject} requires confirmation.\n\
Plugins can run hooks, MCP servers, and skills on your machine, so installation needs explicit trust.\n\
\n\
To proceed, re-run with --trust:\n  codsh --rust plugin install {source_arg} --trust"
    )
}

fn now_stamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|item| item.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn read_dirs(path: &Path) -> Result<Vec<PathBuf>, PluginError> {
    if !path.is_dir() {
        return Ok(Vec::new());
    }
    let mut dirs = Vec::new();
    for entry in fs::read_dir(path).map_err(io_fail)? {
        let entry = entry.map_err(io_fail)?;
        if entry.file_type().map_err(io_fail)?.is_dir() {
            dirs.push(entry.path());
        }
    }
    dirs.sort();
    Ok(dirs)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), PluginError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_fail)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)
            .map_err(io_fail)?;
        file.write_all(bytes).map_err(io_fail)?;
        file.sync_all().map_err(io_fail)?;
    }
    fs::rename(&tmp, path).map_err(io_fail)
}

fn escape_toml(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn io_fail(error: io::Error) -> PluginError {
    PluginError::fail(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn ctx(dir: &TempDir) -> Context {
        let grok = dir.path().join(".grok");
        fs::create_dir_all(&grok).unwrap();
        Context {
            grok_home: grok,
            cwd: dir.path().to_path_buf(),
            env: BTreeMap::new(),
            workspace_trusted: true,
        }
    }

    fn write_plugin(path: &Path, name: &str, version: &str, license: &str) {
        fs::create_dir_all(path).unwrap();
        fs::write(
            path.join("plugin.json"),
            format!(
                r#"{{"name":"{name}","version":"{version}","license":"{license}","description":"fixture"}}"#
            ),
        )
        .unwrap();
        fs::create_dir_all(path.join("skills")).unwrap();
        fs::write(path.join("skills/SKILL.md"), "# skill\n").unwrap();
    }

    fn write_marketplace(root: &Path, plugin_name: &str) {
        write_marketplace_plugins(root, &[plugin_name]);
    }

    fn write_marketplace_plugins(root: &Path, plugin_names: &[&str]) {
        let entries: Vec<String> = plugin_names
            .iter()
            .map(|plugin_name| {
                write_plugin(
                    &root.join("plugins").join(plugin_name),
                    plugin_name,
                    "1.0.0",
                    "MIT",
                );
                format!(
                    r#"{{"name":"{plugin_name}","version":"1.0.0","license":"MIT","source":{{"type":"local","path":"./plugins/{plugin_name}"}}}}"#
                )
            })
            .collect();
        fs::create_dir_all(root.join(".grok-plugin")).unwrap();
        fs::write(
            root.join(".grok-plugin/marketplace.json"),
            format!(r#"{{"name":"Fixtures","plugins":[{}]}}"#, entries.join(",")),
        )
        .unwrap();
    }

    fn write_mcp_plugin(path: &Path, name: &str, mcp: &str) {
        fs::create_dir_all(path.join("bin")).unwrap();
        fs::write(
            path.join("plugin.json"),
            format!(r#"{{"name":"{name}","version":"1.0.0","description":"fixture"}}"#),
        )
        .unwrap();
        fs::write(path.join("bin/server"), "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path.join("bin/server"), fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        fs::write(path.join(".mcp.json"), mcp).unwrap();
    }

    fn discover_mcp(env: &Context) -> crate::mcp::Discovery {
        crate::mcp::discover(&crate::mcp::DiscoverInput {
            grok_home: &env.grok_home,
            config_path: &env.config_path(),
            home: &env.cwd,
            cwd: &env.cwd,
            trusted: env.workspace_trusted,
            env: &env.env,
        })
    }

    fn run_ok(env: &Context, command: PluginCommand) -> String {
        run(&env.grok_home, &env.cwd, &env.env, true, &command).unwrap()
    }

    #[test]
    fn plugin_mcp_servers_follow_trust_and_enable_and_lose_grants() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let source = dir.path().join("src-echo");
        write_mcp_plugin(
            &source,
            "echo",
            r#"{"mcpServers":{
                "echo":{"command":"./bin/server","args":["${CLAUDE_PLUGIN_ROOT}/x"],
                        "env":{"STATE":"${GROK_PLUGIN_DATA}/state"}},
                "escape":{"command":"../outside/server"}
            }}"#,
        );
        let untrusted = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: source.display().to_string(),
                trust: false,
            },
        );
        assert!(untrusted.is_err(), "an untrusted install needs --trust");
        run_ok(
            &env,
            PluginCommand::Install {
                source: source.display().to_string(),
                trust: true,
            },
        );
        // Installed is not enabled: nothing mounts and nothing is granted.
        let installed = discover_mcp(&env);
        assert!(installed.get("echo").is_none());
        let view = list_installed_views(&env);
        let echo = view.iter().find(|plugin| plugin.name == "echo").unwrap();
        assert_eq!(echo.contributions.mcp.len(), 2);
        assert!(
            echo.contributions
                .mcp
                .iter()
                .all(|server| server.state != "ready"),
            "{:?}",
            echo.contributions.mcp
        );

        run_ok(
            &env,
            PluginCommand::Enable {
                name: "echo".into(),
            },
        );
        let active = discover_mcp(&env);
        let entry = active.get("echo").expect("enabled plugin server mounts");
        assert_eq!(entry.state, crate::mcp::State::Ready);
        let origin = entry.def.source.plugin().unwrap();
        assert_eq!(origin.plugin, "echo");
        assert_eq!(entry.def.source.display_scope(), "plugin: echo");
        let crate::mcp::Transport::Stdio {
            command,
            args,
            env: vars,
            ..
        } = &entry.def.transport
        else {
            panic!("stdio expected");
        };
        assert_eq!(Path::new(command), origin.root.join("bin/server"));
        assert_eq!(args, &vec![format!("{}/x", origin.root.display())]);
        let data = env.data_dir().join("echo");
        assert_eq!(
            vars.get("STATE").unwrap(),
            &format!("{}/state", data.display())
        );
        assert_eq!(
            vars.get("CLAUDE_PLUGIN_DATA").unwrap(),
            &data.display().to_string()
        );
        assert!(matches!(
            active.get("escape").unwrap().state,
            crate::mcp::State::Invalid(ref reason) if reason.contains("leaves the plugin root")
        ));
        let states = list_installed_views(&env)
            .into_iter()
            .find(|plugin| plugin.name == "echo")
            .unwrap()
            .contributions
            .mcp;
        let state_of = |name: &str| {
            states
                .iter()
                .find(|server| server.name == name)
                .map(|server| server.state.clone())
                .unwrap()
        };
        assert_eq!(state_of("echo"), "ready");
        assert_eq!(state_of("escape"), "invalid");

        // A remembered approval for the plugin's tools does not survive the
        // plugin being withdrawn; other servers' grants and denials stay.
        let grants = crate::permission::grants_path(&env.grok_home, Path::new("/work/p"));
        let store = crate::permission::GrantStore {
            allowed_mcp: vec!["echo__ping".into(), "echoes__x".into(), "other__y".into()],
            denied_mcp: vec!["echo__bad".into()],
            ..Default::default()
        };
        crate::permission::persist_grants(&grants, &store).unwrap();
        let disabled = run_ok(
            &env,
            PluginCommand::Disable {
                name: "echo".into(),
            },
        );
        assert!(
            disabled.contains("withdrawn from the next prompt: echo"),
            "{disabled}"
        );
        assert!(
            disabled.contains("forgot 1 remembered approval"),
            "{disabled}"
        );
        let left = crate::permission::load_grants(&grants);
        assert_eq!(left.allowed_mcp, vec!["echoes__x", "other__y"]);
        assert_eq!(left.denied_mcp, vec!["echo__bad"]);
        assert!(discover_mcp(&env).get("echo").is_none());
    }

    #[test]
    fn plugin_mcp_servers_yield_to_config_and_to_earlier_plugins() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        for (name, body) in [
            (
                "alpha",
                r#"{"mcpServers":{"shared":{"command":"./bin/server"},"mine":{"command":"./bin/server"}}}"#,
            ),
            ("beta", r#"{"shared":{"command":"./bin/server"}}"#),
            ("broken", "{not json"),
        ] {
            let source = dir.path().join(format!("src-{name}"));
            write_mcp_plugin(&source, name, body);
            run_ok(
                &env,
                PluginCommand::Install {
                    source: source.display().to_string(),
                    trust: true,
                },
            );
            run_ok(&env, PluginCommand::Enable { name: name.into() });
        }
        let discovery = discover_mcp(&env);
        let shared = discovery.get("shared").unwrap();
        assert_eq!(shared.def.source.plugin().unwrap().plugin, "alpha");
        assert!(discovery.shadowed.iter().any(|shadow| {
            shadow
                .def
                .source
                .plugin()
                .map(|origin| origin.plugin.as_str())
                == Some("beta")
                && shadow.by == shared.def.source.label()
        }));
        // One plugin's broken MCP file is reported without hiding the others.
        assert!(discovery.get("mine").is_some());
        assert!(
            discovery
                .warnings
                .iter()
                .any(|warning| warning.starts_with("plugin broken:")),
            "{:?}",
            discovery.warnings
        );

        // A user definition of the same name wins over any plugin, and the
        // plugin view says so instead of claiming the server is ready.
        let config = fs::read_to_string(env.config_path()).unwrap();
        fs::write(
            env.config_path(),
            format!("{config}\n[mcp_servers.shared]\ncommand = \"user-server\"\n"),
        )
        .unwrap();
        let discovery = discover_mcp(&env);
        assert_eq!(
            discovery.get("shared").unwrap().def.transport.target(),
            "user-server"
        );
        let views = list_installed_views(&env);
        let alpha = views.iter().find(|plugin| plugin.name == "alpha").unwrap();
        let shared_row = alpha
            .contributions
            .mcp
            .iter()
            .find(|server| server.name == "shared")
            .unwrap();
        assert_eq!(shared_row.state, "shadowed", "{shared_row:?}");

        // Withdrawal is per server: disabling alpha hands `mine` back and
        // leaves the user's `shared` alone.
        let disabled = run_ok(
            &env,
            PluginCommand::Disable {
                name: "alpha".into(),
            },
        );
        assert!(
            disabled.contains("withdrawn from the next prompt: mine"),
            "{disabled}"
        );
        assert!(!disabled.contains("shared"), "{disabled}");
    }

    #[test]
    fn live_dsh_is_replaced_only_when_plugin_servers_change() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let dsh_home = dir.path().join("dsh");
        let source = dir.path().join("src-echo");
        write_mcp_plugin(&source, "echo", r#"{"echo":{"command":"./bin/server"}}"#);
        run_ok(
            &env,
            PluginCommand::Install {
                source: source.display().to_string(),
                trust: true,
            },
        );
        let mount = || {
            let discovery = discover_mcp(&env);
            let path =
                crate::mcp::write_plan(&dsh_home, "main", &discovery, &env.cwd, &env.env).unwrap();
            (crate::mcp::read_plan(&path).unwrap(), path)
        };
        let differs = |mounted: &JsonValue, path: &Path| {
            crate::mcp::plugin_servers_differ(
                mounted,
                path,
                &discover_mcp(&env),
                &env.cwd,
                &env.env,
            )
        };
        let (before, path) = mount();
        assert!(!differs(&before, &path));
        run_ok(
            &env,
            PluginCommand::Enable {
                name: "echo".into(),
            },
        );
        assert!(differs(&before, &path), "an enabled plugin mounts");
        let (enabled, path) = mount();
        assert!(!differs(&enabled, &path));
        let data = env.data_dir().join("echo");
        assert!(data.is_dir(), "the plan creates the plugin data directory");

        // /mcps and /plugins read what the session mounted even when the
        // plan file was rewritten under it.
        let (rows, _) =
            crate::mcp::live_rows(Some(&path), Some(&before), None, &BTreeMap::new()).unwrap();
        assert!(rows.iter().all(|row| row.name != "echo"));
        let (rows, _) =
            crate::mcp::live_rows(Some(&path), Some(&enabled), None, &BTreeMap::new()).unwrap();
        let echo = rows.iter().find(|row| row.name == "echo").unwrap();
        assert_eq!(echo.scope, "plugin: echo");
        let mut snapshot = inspect(&env.grok_home, &env.cwd, &env.env, true);
        annotate_live_mcp(&mut snapshot, &rows);
        let server = &snapshot
            .installed
            .iter()
            .find(|plugin| plugin.name == "echo")
            .unwrap()
            .contributions
            .mcp[0];
        assert_eq!(server.state, "connected");

        // Editing unrelated MCP config keeps its /mcp reload path.
        let config = fs::read_to_string(env.config_path()).unwrap();
        fs::write(
            env.config_path(),
            format!("{config}\n[mcp_servers.user]\ncommand = \"user-server\"\n"),
        )
        .unwrap();
        assert!(!differs(&enabled, &path));

        // Updating the plugin changes its revision: remount.
        fs::write(source.join("README.md"), "v2\n").unwrap();
        let registry = env.install_dir().join("registry.json");
        let text = fs::read_to_string(&registry).unwrap();
        let mut json: JsonValue = serde_json::from_str(&text).unwrap();
        bump_updated_at(&mut json);
        fs::write(&registry, serde_json::to_string(&json).unwrap()).unwrap();
        assert!(differs(&enabled, &path), "a new plugin revision remounts");

        run_ok(
            &env,
            PluginCommand::Disable {
                name: "echo".into(),
            },
        );
        let mut snapshot = inspect(&env.grok_home, &env.cwd, &env.env, true);
        annotate_live_mcp(&mut snapshot, &rows);
        let server = &snapshot
            .installed
            .iter()
            .find(|plugin| plugin.name == "echo")
            .unwrap()
            .contributions
            .mcp[0];
        assert_eq!(server.state, "disabled");
        assert_eq!(
            server.detail.as_deref(),
            Some("still mounted; withdrawn with the next prompt")
        );
    }

    fn bump_updated_at(value: &mut JsonValue) {
        match value {
            JsonValue::Object(map) => {
                for (key, item) in map.iter_mut() {
                    if key == "updated_at" || key == "updatedAt" {
                        *item = JsonValue::String("2099-01-01T00:00:00Z".into());
                    } else {
                        bump_updated_at(item);
                    }
                }
            }
            JsonValue::Array(items) => items.iter_mut().for_each(bump_updated_at),
            _ => {}
        }
    }

    #[test]
    fn plugin_mcp_config_forms_in_the_manifest() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let inline = dir.path().join("src-inline");
        fs::create_dir_all(inline.join("bin")).unwrap();
        fs::write(
            inline.join("plugin.json"),
            r#"{"name":"inline","version":"1.0.0","mcpServers":{"inl":{"command":"./bin/server"}}}"#,
        )
        .unwrap();
        fs::write(inline.join("bin/server"), "#!/bin/sh\n").unwrap();
        let pathed = dir.path().join("src-pathed");
        fs::create_dir_all(pathed.join("config")).unwrap();
        fs::write(
            pathed.join("plugin.json"),
            r#"{"name":"pathed","version":"1.0.0","mcpServers":"./config/servers.json"}"#,
        )
        .unwrap();
        fs::write(
            pathed.join("config/servers.json"),
            r#"{"mcpServers":{"web":{"type":"http","url":"http://127.0.0.1:9/mcp"}}}"#,
        )
        .unwrap();
        for (name, source) in [("inline", &inline), ("pathed", &pathed)] {
            run_ok(
                &env,
                PluginCommand::Install {
                    source: source.display().to_string(),
                    trust: true,
                },
            );
            run_ok(&env, PluginCommand::Enable { name: name.into() });
        }
        let discovery = discover_mcp(&env);
        assert_eq!(
            discovery.get("inl").unwrap().state,
            crate::mcp::State::Ready
        );
        let web = discovery.get("web").unwrap();
        assert_eq!(web.def.transport.kind(), "http");
        assert_eq!(web.def.source.plugin().unwrap().plugin, "pathed");
        let listing = run_ok(
            &env,
            PluginCommand::List {
                json: true,
                available: false,
            },
        );
        let json: JsonValue = serde_json::from_str(&listing).unwrap();
        let pathed_json = json
            .as_array()
            .unwrap()
            .iter()
            .find(|plugin| plugin["name"] == "pathed")
            .unwrap()
            .clone();
        assert_eq!(pathed_json["contributions"]["mcp"], true, "{pathed_json}");
        assert_eq!(
            pathed_json["contributions"]["mcpServers"][0]["name"], "web",
            "{pathed_json}"
        );
    }

    #[test]
    fn parse_plugin_help_and_install_flags() {
        let help = parse_command(&["--help".into()]).unwrap();
        assert!(matches!(help, PluginCommand::Help));
        let install = parse_command(&["install".into(), "./p".into(), "--trust".into()]).unwrap();
        assert_eq!(
            install,
            PluginCommand::Install {
                source: "./p".into(),
                trust: true
            }
        );
        let err = parse_command(&["--leader-socket".into(), "x".into()]).unwrap_err();
        assert!(err.message.contains("dsh owns execution"));
        let mp = parse_command(&["marketplace".into(), "--help".into()]).unwrap();
        assert!(matches!(mp, PluginCommand::MarketplaceHelp));
    }

    #[test]
    fn marketplace_add_install_update_remove_keeps_unrelated_files() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let marketplace = dir.path().join("market");
        write_marketplace(&marketplace, "sample-tools");
        let canary = dir.path().join("notes.txt");
        fs::write(&canary, "keep-me").unwrap();
        let add = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: marketplace.display().to_string(),
                force: false,
            },
        )
        .unwrap();
        assert!(add.contains("Added marketplace source"));
        let denied = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "sample-tools".into(),
                trust: false,
            },
        )
        .unwrap_err();
        assert!(denied.message.contains("requires confirmation"));
        assert!(!env.install_dir().join("registry.json").exists());
        let installed = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "sample-tools".into(),
                trust: true,
            },
        )
        .unwrap();
        assert!(installed.contains("Installed"));
        assert!(installed.contains("execution is not granted"));
        let snapshot = inspect(&env.grok_home, &env.cwd, &env.env, true);
        assert_eq!(snapshot.installed.len(), 1);
        assert_eq!(snapshot.installed[0].name, "sample-tools");
        assert_eq!(snapshot.installed[0].version.as_deref(), Some("1.0.0"));
        assert_eq!(snapshot.installed[0].license.as_deref(), Some("MIT"));
        assert!(snapshot.installed[0].trusted);
        assert!(!snapshot.installed[0].enabled);
        assert!(!snapshot.installed[0].execution_granted);
        assert!(!snapshot.auto_register_official);
        write_plugin(
            &marketplace.join("plugins/sample-tools"),
            "sample-tools",
            "1.1.0",
            "MIT",
        );
        let updated = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Update {
                name: Some("sample-tools".into()),
            },
        )
        .unwrap();
        assert!(updated.contains("updated"));
        fs::remove_dir_all(marketplace.join("plugins/sample-tools")).unwrap();
        let failed = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Update {
                name: Some("sample-tools".into()),
            },
        )
        .unwrap_err();
        assert!(failed.message.contains("failed") || failed.message.contains("missing"));
        let after_fail = inspect(&env.grok_home, &env.cwd, &env.env, true);
        assert_eq!(after_fail.installed[0].name, "sample-tools");
        assert!(after_fail.installed[0].path.exists());
        let removed = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Uninstall {
                name: "sample-tools".into(),
                confirm: false,
                keep_data: false,
            },
        )
        .unwrap();
        assert!(removed.contains("Uninstalled"));
        assert_eq!(
            inspect(&env.grok_home, &env.cwd, &env.env, true)
                .installed
                .len(),
            0
        );
        assert_eq!(fs::read_to_string(canary).unwrap(), "keep-me");
    }

    #[test]
    fn install_without_trust_and_conflict_do_not_fabricate_success() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let plugin_a = dir.path().join("a");
        let plugin_b = dir.path().join("b");
        write_plugin(&plugin_a, "same-name", "1.0.0", "MIT");
        write_plugin(&plugin_b, "same-name", "2.0.0", "Apache-2.0");
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: plugin_a.display().to_string(),
                trust: true,
            },
        )
        .unwrap();
        let conflict = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: plugin_b.display().to_string(),
                trust: true,
            },
        )
        .unwrap_err();
        assert!(conflict.message.contains("already installed"));
        let snapshot = inspect(&env.grok_home, &env.cwd, &env.env, true);
        assert_eq!(snapshot.installed.len(), 1);
        assert_eq!(snapshot.installed[0].license.as_deref(), Some("MIT"));
    }

    #[test]
    fn project_and_user_scopes_stay_separate_and_untrusted_project_is_inactive() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let user_plugin = dir.path().join("user-plug");
        write_plugin(&user_plugin, "user-tools", "1.0.0", "MIT");
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: user_plugin.display().to_string(),
                trust: true,
            },
        )
        .unwrap();
        let project = dir.path().join(".grok/plugins/project-tools");
        write_plugin(&project, "project-tools", "0.2.0", "MIT");
        let trusted = inspect(&env.grok_home, &env.cwd, &env.env, true);
        assert!(trusted.installed.iter().any(|row| row.scope == "project"));
        let untrusted = inspect(&env.grok_home, &env.cwd, &env.env, false);
        let project_row = untrusted
            .installed
            .iter()
            .find(|row| row.name == "project-tools")
            .unwrap();
        assert!(!project_row.trusted);
        assert!(!project_row.execution_granted);
        let user_row = untrusted
            .installed
            .iter()
            .find(|row| row.name == "user-tools")
            .unwrap();
        assert_eq!(user_row.scope, "user");
        assert!(!user_row.execution_granted);
    }

    #[test]
    fn auto_register_defaults_off_and_does_not_fabricate_official_source() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let snapshot = inspect(&env.grok_home, &env.cwd, &env.env, true);
        assert!(!snapshot.auto_register_official);
        assert!(snapshot.marketplaces.is_empty());
        let mut on = env.env.clone();
        on.insert("GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER".into(), "1".into());
        let registered = inspect(&env.grok_home, &env.cwd, &on, true);
        assert!(registered.auto_register_official);
        assert_eq!(registered.marketplaces.len(), 1);
        assert_eq!(registered.marketplaces[0].name, OFFICIAL_SOURCE_NAME);
        let again = inspect(&env.grok_home, &env.cwd, &on, true);
        assert_eq!(again.marketplaces.len(), 1);
    }

    #[test]
    fn require_sha_refuses_unpinned_remote_without_writing() {
        let dir = TempDir::new().unwrap();
        let mut env = ctx(&dir);
        env.env
            .insert("GROK_MARKETPLACE_REQUIRE_SHA".into(), "1".into());
        let err = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "https://example.invalid/plugins.git".into(),
                trust: true,
            },
        )
        .unwrap_err();
        assert!(err.message.contains("unpinned"));
        assert!(!env.registry_path().exists());
    }

    #[test]
    fn staging_cleanup_on_missing_source() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let err = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: dir.path().join("missing").display().to_string(),
                trust: true,
            },
        )
        .unwrap_err();
        assert!(err.message.contains("not found") || err.message.contains("missing"));
        if env.install_dir().exists() {
            let leftovers: Vec<_> = fs::read_dir(env.install_dir())
                .unwrap()
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_name().to_string_lossy().starts_with(".staging-"))
                .collect();
            assert!(leftovers.is_empty());
        }
    }

    #[test]
    fn overlay_cancel_does_not_uninstall() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let plugin = dir.path().join("plug");
        write_plugin(&plugin, "overlay-tools", "1.0.0", "MIT");
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: plugin.display().to_string(),
                trust: true,
            },
        )
        .unwrap();
        let snapshot = inspect(&env.grok_home, &env.cwd, &env.env, true);
        let mut overlay = new_overlay(PluginTab::Plugins);
        handle_overlay_key_with_home(&mut overlay, &snapshot, None, 'x', false, false, false);
        assert!(overlay.confirm.is_some());
        handle_overlay_key_with_home(&mut overlay, &snapshot, None, 'n', false, false, false);
        assert!(overlay.confirm.is_none());
        assert_eq!(
            inspect(&env.grok_home, &env.cwd, &env.env, true)
                .installed
                .len(),
            1
        );
        let text = overlay_text(&new_overlay(PluginTab::Plugins), &snapshot, None);
        assert!(text.contains("overlay-tools"));
        assert!(text.contains("1.0.0"));
        assert!(text.contains("MIT"));
    }

    #[test]
    fn marketplace_relative_path_rejects_parent() {
        assert!(normalize_rel("../secret").is_err());
        assert_eq!(normalize_rel("./plugins/foo").unwrap(), "plugins/foo");
    }

    #[test]
    fn trust_prompt_has_no_error_framing() {
        let msg = trust_prompt("\"sentry\" from marketplace \"xAI Official\"", "sentry");
        assert!(msg.starts_with("Installing \"sentry\""));
        assert!(!msg.contains("Error"));
        assert!(msg.contains("codsh --rust plugin install sentry --trust"));
    }

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .output()
            .is_ok_and(|output| output.status.success())
    }

    fn init_git_marketplace(path: &Path, plugin_name: &str, version: &str) {
        write_marketplace(path, plugin_name);
        write_plugin(
            &path.join("plugins").join(plugin_name),
            plugin_name,
            version,
            "MIT",
        );
        run_git(path, &["init", "--initial-branch", "main"]);
        run_git(path, &["config", "user.email", "test@example.com"]);
        run_git(path, &["config", "user.name", "Test"]);
        run_git(path, &["add", "."]);
        run_git(path, &["commit", "-m", "init"]);
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(dir)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn git_marketplace_list_and_install_from_cache() {
        if !git_available() {
            return;
        }
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let market = dir.path().join("git-market");
        init_git_marketplace(&market, "git-tools", "2.0.0");
        let url = format!("file://{}", market.display());
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: url.clone(),
                force: true,
            },
        )
        .unwrap();
        let listed = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceList { json: false },
        )
        .unwrap();
        assert!(listed.contains("git-tools"), "{listed}");
        let installed = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "git-tools".into(),
                trust: true,
            },
        )
        .unwrap();
        assert!(installed.contains("Installed"));
        let snapshot = inspect(&env.grok_home, &env.cwd, &env.env, true);
        assert_eq!(snapshot.installed[0].name, "git-tools");
        assert_eq!(snapshot.installed[0].version.as_deref(), Some("2.0.0"));
        assert!(!snapshot.installed[0].execution_granted);
    }

    #[test]
    fn qualified_install_selects_duplicate_marketplace() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let m1 = dir.path().join("m1");
        let m2 = dir.path().join("m2");
        write_marketplace(&m1, "dup-tools");
        write_marketplace(&m2, "dup-tools");
        write_plugin(&m1.join("plugins/dup-tools"), "dup-tools", "1.0.0", "MIT");
        write_plugin(
            &m2.join("plugins/dup-tools"),
            "dup-tools",
            "9.0.0",
            "Apache-2.0",
        );
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: m1.display().to_string(),
                force: false,
            },
        )
        .unwrap();
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: m2.display().to_string(),
                force: false,
            },
        )
        .unwrap();
        let bare = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "dup-tools".into(),
                trust: true,
            },
        )
        .unwrap_err();
        assert!(
            bare.message.contains("Qualify the source"),
            "{}",
            bare.message
        );
        let sources = load_marketplace_sources(&env);
        let first = &sources[0].name;
        let installed = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: format!("dup-tools@{first}"),
                trust: true,
            },
        )
        .unwrap();
        assert!(installed.contains("Installed"));
        let snapshot = inspect(&env.grok_home, &env.cwd, &env.env, true);
        assert_eq!(snapshot.installed.len(), 1);
        assert_eq!(
            snapshot.installed[0].marketplace.as_deref(),
            Some(first.as_str())
        );
    }

    #[test]
    fn marketplace_add_preserves_config_comments() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        fs::write(
            env.config_path(),
            "# keep-this-comment\n[models]\ndefault = \"user-model\"\n",
        )
        .unwrap();
        let market = dir.path().join("market");
        write_marketplace(&market, "sample-tools");
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: market.display().to_string(),
                force: false,
            },
        )
        .unwrap();
        let text = fs::read_to_string(env.config_path()).unwrap();
        assert!(text.contains("# keep-this-comment"), "{text}");
        assert!(text.contains("[models]"), "{text}");
        assert!(text.find("[models]").unwrap() < text.find("[[marketplace.sources]]").unwrap());
    }

    #[test]
    fn repo_key_is_stable_fnv1a() {
        assert_eq!(
            repo_key("https://example.com/git-market.git"),
            format!(
                "git-market-{:08x}",
                fnv1a32(b"https://example.com/git-market.git")
            )
        );
        assert_ne!(
            repo_key("https://example.com/a.git"),
            repo_key("https://example.com/b.git")
        );
    }

    #[test]
    fn two_plugins_from_one_marketplace_install_independently() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let market = dir.path().join("market");
        write_marketplace_plugins(&market, &["alpha-tools", "beta-tools"]);
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: market.display().to_string(),
                force: false,
            },
        )
        .unwrap();
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "alpha-tools".into(),
                trust: true,
            },
        )
        .unwrap();
        let second = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "beta-tools".into(),
                trust: true,
            },
        )
        .unwrap();
        assert!(second.contains("Installed"), "{second}");
        let snapshot = inspect(&env.grok_home, &env.cwd, &env.env, true);
        let names: Vec<_> = snapshot
            .installed
            .iter()
            .map(|plugin| plugin.name.as_str())
            .collect();
        assert!(names.contains(&"alpha-tools"), "{names:?}");
        assert!(names.contains(&"beta-tools"), "{names:?}");
        assert_eq!(snapshot.installed.len(), 2);
        assert_ne!(
            snapshot.installed[0].path, snapshot.installed[1].path,
            "each marketplace plugin must have its own install dest"
        );
    }

    #[test]
    fn git_plugin_update_persists_clone_head() {
        if !git_available() {
            return;
        }
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let market = dir.path().join("git-market");
        init_git_marketplace(&market, "git-tools", "1.0.0");
        let url = format!("file://{}", market.display());
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: url.clone(),
                force: true,
            },
        )
        .unwrap();
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "git-tools".into(),
                trust: true,
            },
        )
        .unwrap();
        let first = inspect(&env.grok_home, &env.cwd, &env.env, true)
            .installed
            .into_iter()
            .find(|plugin| plugin.name == "git-tools")
            .unwrap()
            .commit
            .expect("git install records commit");
        write_plugin(
            &market.join("plugins").join("git-tools"),
            "git-tools",
            "1.1.0",
            "MIT",
        );
        run_git(&market, &["add", "."]);
        run_git(&market, &["commit", "-m", "bump"]);
        let expected = git_head(&market).unwrap();
        let updated = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Update {
                name: Some("git-tools".into()),
            },
        )
        .unwrap();
        assert!(updated.contains("updated"), "{updated}");
        let snapshot = inspect(&env.grok_home, &env.cwd, &env.env, true);
        let row = snapshot
            .installed
            .iter()
            .find(|plugin| plugin.name == "git-tools")
            .unwrap();
        assert_eq!(row.version.as_deref(), Some("1.1.0"));
        assert_eq!(row.commit.as_deref(), Some(expected.as_str()));
        assert_ne!(row.commit.as_deref(), Some(first.as_str()));
        let registry: InstallRegistry =
            serde_json::from_str(&fs::read_to_string(env.registry_path()).unwrap()).unwrap();
        let commit = registry.repos.values().find_map(|repo| match &repo.kind {
            InstallKind::Git { commit, .. } => Some(commit.as_str()),
            InstallKind::Local { .. } => None,
        });
        assert_eq!(commit, Some(expected.as_str()));
    }

    #[test]
    fn require_sha_refuses_unpinned_git_update_without_mutating() {
        if !git_available() {
            return;
        }
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let market = dir.path().join("git-market");
        init_git_marketplace(&market, "git-tools", "1.0.0");
        let url = format!("file://{}", market.display());
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd { url, force: true },
        )
        .unwrap();
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "git-tools".into(),
                trust: true,
            },
        )
        .unwrap();
        let before = inspect(&env.grok_home, &env.cwd, &env.env, true)
            .installed
            .into_iter()
            .find(|plugin| plugin.name == "git-tools")
            .unwrap();
        write_plugin(
            &market.join("plugins").join("git-tools"),
            "git-tools",
            "1.1.0",
            "MIT",
        );
        run_git(&market, &["add", "."]);
        run_git(&market, &["commit", "-m", "bump"]);
        let mut locked = env.env.clone();
        locked.insert("GROK_MARKETPLACE_REQUIRE_SHA".into(), "1".into());
        let err = run(
            &env.grok_home,
            &env.cwd,
            &locked,
            true,
            &PluginCommand::Update {
                name: Some("git-tools".into()),
            },
        )
        .unwrap_err();
        assert!(err.message.contains("unpinned"), "{}", err.message);
        let after = inspect(&env.grok_home, &env.cwd, &env.env, true)
            .installed
            .into_iter()
            .find(|plugin| plugin.name == "git-tools")
            .unwrap();
        assert_eq!(after.version, before.version);
        assert_eq!(after.commit, before.commit);
        assert!(after.path.exists());
        let registry: InstallRegistry =
            serde_json::from_str(&fs::read_to_string(env.registry_path()).unwrap()).unwrap();
        let commit = registry.repos.values().find_map(|repo| match &repo.kind {
            InstallKind::Git { commit, .. } => Some(commit.clone()),
            InstallKind::Local { .. } => None,
        });
        assert_eq!(commit, before.commit);
    }

    #[test]
    fn marketplace_remove_clears_trust_and_enabled_lists() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let market = dir.path().join("market");
        write_marketplace(&market, "alpha-tools");
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: market.display().to_string(),
                force: false,
            },
        )
        .unwrap();
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "alpha-tools".into(),
                trust: true,
            },
        )
        .unwrap();
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Enable {
                name: "alpha-tools".into(),
            },
        )
        .unwrap();
        assert!(
            inspect(&env.grok_home, &env.cwd, &env.env, true)
                .installed
                .iter()
                .any(|plugin| plugin.name == "alpha-tools" && plugin.enabled)
        );
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceRemove {
                source: "market".into(),
            },
        )
        .unwrap();
        let trusted = fs::read_to_string(env.trust_path()).unwrap();
        assert!(!trusted.contains("alpha-tools"), "{trusted}");
        let config = fs::read_to_string(env.config_path()).unwrap();
        assert!(!config.contains("\"alpha-tools\""), "{config}");
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: market.display().to_string(),
                force: false,
            },
        )
        .unwrap();
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "alpha-tools".into(),
                trust: true,
            },
        )
        .unwrap();
        let reinstalled = inspect(&env.grok_home, &env.cwd, &env.env, true)
            .installed
            .into_iter()
            .find(|plugin| plugin.name == "alpha-tools")
            .unwrap();
        assert!(reinstalled.trusted);
        assert!(!reinstalled.enabled);
    }

    #[test]
    fn enable_splices_lists_into_existing_plugins_table() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let plugin = dir.path().join("plug");
        write_plugin(&plugin, "alpha-tools", "1.0.0", "MIT");
        fs::write(
            env.config_path(),
            "[plugins]\npaths = [\"/tmp/keep\"]\n\n[models]\ndefault = \"user-model\"\n\n[model.user-model]\nmodel = \"mock-model\"\n",
        )
        .unwrap();
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: plugin.display().to_string(),
                trust: true,
            },
        )
        .unwrap();
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Enable {
                name: "alpha-tools".into(),
            },
        )
        .unwrap();
        let text = fs::read_to_string(env.config_path()).unwrap();
        let plugins_at = text.find("[plugins]").expect(text.as_str());
        let models_at = text.find("[models]").expect(text.as_str());
        let enabled_at = text.find("enabled = ").expect(text.as_str());
        let model_table_at = text.find("[model.user-model]").expect(text.as_str());
        assert!(plugins_at < enabled_at);
        assert!(enabled_at < models_at);
        assert!(models_at < model_table_at);
        assert!(!text[model_table_at..].contains("enabled ="));
        assert!(text.contains("paths = [\"/tmp/keep\"]"), "{text}");
        let value: TomlValue = toml::from_str(&text).unwrap();
        let enabled = value
            .get("plugins")
            .and_then(|table| table.get("enabled"))
            .and_then(TomlValue::as_array)
            .unwrap();
        assert_eq!(
            enabled
                .iter()
                .filter_map(TomlValue::as_str)
                .collect::<Vec<_>>(),
            ["alpha-tools"]
        );
        assert_eq!(
            value
                .get("models")
                .and_then(|table| table.get("default"))
                .and_then(TomlValue::as_str),
            Some("user-model")
        );
    }

    #[test]
    fn strict_known_marketplaces_drop_unlisted_catalogs_and_block_named_install() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let allowed = dir.path().join("allowed");
        let blocked = dir.path().join("blocked");
        write_marketplace(&allowed, "allowed-tools");
        write_marketplace(&blocked, "blocked-tools");
        fs::write(
            env.grok_home.join("requirements.toml"),
            format!(
                "strict_known_marketplaces = []\n\n[extra_known_marketplaces.ok]\nsource = {{ source = \"local\", path = \"{}\" }}\n",
                allowed.display()
            ),
        )
        .unwrap();
        fs::write(
            env.config_path(),
            format!(
                "[[marketplace.sources]]\nname = \"nope\"\npath = \"{}\"\n",
                blocked.display()
            ),
        )
        .unwrap();
        let snapshot = inspect(&env.grok_home, &env.cwd, &env.env, true);
        let names: Vec<_> = snapshot
            .marketplaces
            .iter()
            .map(|source| source.name.as_str())
            .collect();
        assert_eq!(names, ["ok"], "{:?} {:?}", names, snapshot.warnings);
        assert!(
            snapshot
                .warnings
                .iter()
                .any(|warning| warning.contains("blocked by allowlist") && warning.contains("nope")),
            "{:?}",
            snapshot.warnings
        );
        let listed = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceList { json: false },
        )
        .unwrap();
        assert!(listed.contains("allowed-tools"), "{listed}");
        assert!(!listed.contains("blocked-tools"), "{listed}");
        let installed = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "allowed-tools".into(),
                trust: true,
            },
        )
        .unwrap();
        assert!(installed.contains("Installed"), "{installed}");
        let refused = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "blocked-tools".into(),
                trust: true,
            },
        )
        .unwrap_err();
        assert!(
            refused.message.contains("not found") || refused.message.contains("blocked"),
            "{}",
            refused.message
        );
        assert!(
            inspect(&env.grok_home, &env.cwd, &env.env, true)
                .installed
                .iter()
                .all(|plugin| plugin.name != "blocked-tools")
        );
        let removed = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceRemove {
                source: "nope".into(),
            },
        )
        .unwrap();
        assert!(removed.contains("Removed marketplace source"), "{removed}");
        assert!(
            !fs::read_to_string(env.config_path())
                .unwrap_or_default()
                .contains(&blocked.display().to_string()),
            "blocked source must still be removable"
        );
    }

    #[test]
    fn strict_allowlist_refuses_unlisted_git_add_and_accepts_github_repo_entry() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        fs::write(
            env.grok_home.join("requirements.toml"),
            "[[strict_known_marketplaces]]\nsource = \"github\"\nrepo = \"ACME/more-plugins\"\n",
        )
        .unwrap();
        let refused = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: "https://github.com/other/plugins.git".into(),
                force: true,
            },
        )
        .unwrap_err();
        assert!(
            refused.message.contains("strict_known_marketplaces"),
            "{}",
            refused.message
        );
        assert!(
            !fs::read_to_string(env.config_path())
                .unwrap_or_default()
                .contains("other/plugins"),
            "refused add must not persist"
        );
        let allowed = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: "ACME/more-plugins".into(),
                force: true,
            },
        )
        .unwrap();
        assert!(allowed.contains("Added marketplace source"), "{allowed}");
    }

    #[test]
    fn strict_allowlist_admin_pin_is_the_only_local_path_exception() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let pinned = dir.path().join("pinned");
        let user_pinned = dir.path().join("user-pinned");
        let other = dir.path().join("other");
        write_marketplace(&pinned, "pinned-tools");
        write_marketplace(&user_pinned, "user-tools");
        write_marketplace(&other, "other-tools");
        fs::write(
            env.grok_home.join("requirements.toml"),
            format!(
                "strict_known_marketplaces = []\n\n[extra_known_marketplaces.admin]\nsource = {{ source = \"local\", path = \"{}\" }}\n",
                pinned.display()
            ),
        )
        .unwrap();
        fs::write(
            env.config_path(),
            format!(
                "[extra_known_marketplaces.user]\nsource = {{ source = \"local\", path = \"{}\" }}\n\n[[marketplace.sources]]\nname = \"loose\"\npath = \"{}\"\n",
                user_pinned.display(),
                other.display()
            ),
        )
        .unwrap();
        let snapshot = inspect(&env.grok_home, &env.cwd, &env.env, true);
        let names: Vec<_> = snapshot
            .marketplaces
            .iter()
            .map(|source| source.name.as_str())
            .collect();
        assert_eq!(names, ["admin"], "{:?} {:?}", names, snapshot.warnings);
        let installed = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "pinned-tools".into(),
                trust: true,
            },
        )
        .unwrap();
        assert!(installed.contains("Installed"), "{installed}");
        let user_install = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "user-tools".into(),
                trust: true,
            },
        )
        .unwrap_err();
        assert!(
            user_install.message.contains("not found") || user_install.message.contains("blocked"),
            "{}",
            user_install.message
        );
        let added = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: other.display().to_string(),
                force: false,
            },
        )
        .unwrap_err();
        assert!(
            added.message.contains("local-path") || added.message.contains("allowlist"),
            "{}",
            added.message
        );
    }

    fn write_remote_marketplace(root: &Path, plugin_name: &str, remote_url: &str) {
        let plugin_dir = root.join("plugins").join(plugin_name);
        write_plugin(&plugin_dir, plugin_name, "1.0.0", "MIT");
        fs::create_dir_all(root.join(".grok-plugin")).unwrap();
        fs::write(
            root.join(".grok-plugin/marketplace.json"),
            format!(
                r#"{{"name":"Fixtures","plugins":[{{"name":"{plugin_name}","version":"1.0.0","license":"MIT","source":{{"url":"{remote_url}"}}}}]}}"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn strict_allowlist_binds_catalog_remote_clone_url_and_update() {
        if !git_available() {
            return;
        }
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let allowed = dir.path().join("allowed");
        let evil = dir.path().join("evil");
        init_git_marketplace(&allowed, "listed-tools", "1.0.0");
        write_plugin(&evil, "evil-tools", "1.0.0", "MIT");
        run_git(&evil, &["init", "--initial-branch", "main"]);
        run_git(&evil, &["config", "user.email", "test@example.com"]);
        run_git(&evil, &["config", "user.name", "Test"]);
        run_git(&evil, &["add", "."]);
        run_git(&evil, &["commit", "-m", "init"]);
        let allowed_url = format!("file://{}", allowed.display());
        let evil_url = format!("file://{}", evil.display());
        write_remote_marketplace(&allowed, "evil-tools", &evil_url);
        run_git(&allowed, &["add", "."]);
        run_git(&allowed, &["commit", "-m", "point at unlisted repo"]);
        fs::write(
            env.grok_home.join("requirements.toml"),
            format!("[[strict_known_marketplaces]]\nsource = \"git\"\nurl = \"{allowed_url}\"\n"),
        )
        .unwrap();
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: allowed_url.clone(),
                force: true,
            },
        )
        .unwrap();
        let direct = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: evil_url.clone(),
                trust: true,
            },
        )
        .unwrap_err();
        assert!(
            direct.message.contains("strict_known_marketplaces"),
            "{}",
            direct.message
        );
        let nested = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "evil-tools".into(),
                trust: true,
            },
        )
        .unwrap_err();
        assert!(
            nested.message.contains("strict_known_marketplaces")
                || nested.message.contains("not in"),
            "{}",
            nested.message
        );
        assert!(
            inspect(&env.grok_home, &env.cwd, &env.env, true)
                .installed
                .iter()
                .all(|plugin| plugin.name != "evil-tools")
        );
        fs::write(env.grok_home.join("requirements.toml"), "").unwrap();
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: evil_url,
                trust: true,
            },
        )
        .unwrap();
        fs::write(
            env.grok_home.join("requirements.toml"),
            format!("[[strict_known_marketplaces]]\nsource = \"git\"\nurl = \"{allowed_url}\"\n"),
        )
        .unwrap();
        write_plugin(&evil, "evil-tools", "9.1.0", "MIT");
        run_git(&evil, &["add", "."]);
        run_git(&evil, &["commit", "-m", "bump"]);
        let updated = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Update {
                name: Some("evil-tools".into()),
            },
        )
        .unwrap_err();
        assert!(
            updated.message.contains("strict_known_marketplaces"),
            "{}",
            updated.message
        );
        let row = inspect(&env.grok_home, &env.cwd, &env.env, true)
            .installed
            .into_iter()
            .find(|plugin| plugin.name == "evil-tools")
            .unwrap();
        assert_eq!(row.version.as_deref(), Some("1.0.0"));
    }

    #[test]
    fn strict_allowlist_is_strictest_wins_across_layers() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        fs::write(
            env.grok_home.join("requirements.toml"),
            "strict_known_marketplaces = []\n",
        )
        .unwrap();
        fs::write(
            env.config_path(),
            "[[strict_known_marketplaces]]\nsource = \"github\"\nrepo = \"evil/unlock\"\n",
        )
        .unwrap();
        let added = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: "evil/unlock".into(),
                force: true,
            },
        )
        .unwrap_err();
        assert!(
            added.message.contains("strict_known_marketplaces") || added.message.contains("empty"),
            "{}",
            added.message
        );
        assert!(
            !fs::read_to_string(env.config_path())
                .unwrap_or_default()
                .contains("marketplace.sources"),
            "a later user allow entry must not widen an empty requirements list"
        );
        let workspace = env.cwd.join(".grok");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(
            workspace.join("config.toml"),
            "[[strict_known_marketplaces]]\nsource = \"github\"\nrepo = \"evil/unlock\"\n",
        )
        .unwrap();
        let workspace_add = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: "evil/unlock".into(),
                force: true,
            },
        )
        .unwrap_err();
        assert!(
            workspace_add.message.contains("strict_known_marketplaces")
                || workspace_add.message.contains("empty"),
            "{}",
            workspace_add.message
        );
    }

    #[test]
    fn git_allowlist_keeps_github_path_case_distinct() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        fs::write(
            env.grok_home.join("requirements.toml"),
            "[[strict_known_marketplaces]]\nsource = \"git\"\nurl = \"https://github.com/ACME/Plugins.git\"\n",
        )
        .unwrap();
        let folded_path = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: "https://github.com/acme/plugins.git".into(),
                force: true,
            },
        )
        .unwrap_err();
        assert!(
            folded_path.message.contains("strict_known_marketplaces"),
            "{}",
            folded_path.message
        );
        assert!(
            !fs::read_to_string(env.config_path())
                .unwrap_or_default()
                .contains("acme/plugins"),
            "a case-different GitHub path must not be added"
        );
        let ssh_form = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: "git@github.com:acme/plugins.git".into(),
                force: true,
            },
        )
        .unwrap_err();
        assert!(
            ssh_form.message.contains("strict_known_marketplaces"),
            "{}",
            ssh_form.message
        );
        let catalog_clone = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "https://github.com/acme/plugins.git".into(),
                trust: true,
            },
        )
        .unwrap_err();
        assert!(
            catalog_clone.message.contains("strict_known_marketplaces"),
            "{}",
            catalog_clone.message
        );
        let same_path = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: "HTTPS://GitHub.com/ACME/Plugins.git".into(),
                force: true,
            },
        )
        .unwrap();
        assert!(
            same_path.contains("Added marketplace source"),
            "{same_path}"
        );
        let mut registry = serde_json::json!({
            "version": 1,
            "repos": {
                "github-com-acme-plugins": {
                    "kind": {
                        "type": "Git",
                        "url": "https://github.com/acme/plugins.git",
                        "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    },
                    "installed_at": "1",
                    "updated_at": "1",
                    "path": env.grok_home.join("installed-plugins/github-com-acme-plugins"),
                    "plugins": {
                        "case-tools": { "version": "1.0.0" }
                    }
                }
            }
        });
        let install_path = env
            .grok_home
            .join("installed-plugins/github-com-acme-plugins");
        registry["repos"]["github-com-acme-plugins"]["path"] =
            serde_json::Value::String(install_path.display().to_string());
        fs::create_dir_all(&install_path).unwrap();
        fs::create_dir_all(env.grok_home.join("installed-plugins")).unwrap();
        fs::write(
            env.grok_home.join("installed-plugins/registry.json"),
            serde_json::to_string_pretty(&registry).unwrap(),
        )
        .unwrap();
        let updated = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Update {
                name: Some("case-tools".into()),
            },
        )
        .unwrap_err();
        assert!(
            updated.message.contains("strict_known_marketplaces"),
            "{}",
            updated.message
        );
    }

    #[test]
    fn git_allowlist_folds_scheme_and_host_only() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        fs::write(
            env.grok_home.join("requirements.toml"),
            "[[strict_known_marketplaces]]\nsource = \"git\"\nurl = \"https://gitlab.com/ACME/Plugins.git\"\n",
        )
        .unwrap();
        let folded_path = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: "https://gitlab.com/acme/plugins.git".into(),
                force: true,
            },
        )
        .unwrap_err();
        assert!(
            folded_path.message.contains("strict_known_marketplaces"),
            "{}",
            folded_path.message
        );
        let extra_git = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: "https://gitlab.com/ACME/Plugins.git.git".into(),
                force: true,
            },
        )
        .unwrap_err();
        assert!(
            extra_git.message.contains("strict_known_marketplaces"),
            "{}",
            extra_git.message
        );
        let folded_host = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceAdd {
                url: "HTTPS://GitLab.com/ACME/Plugins.git".into(),
                force: true,
            },
        )
        .unwrap();
        assert!(
            folded_host.contains("Added marketplace source"),
            "{folded_host}"
        );
    }

    #[test]
    fn extra_known_marketplaces_are_first_pin_sources() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let market = dir.path().join("org-plugins");
        write_marketplace(&market, "org-tools");
        fs::write(
            env.grok_home.join("managed_config.toml"),
            format!(
                "[extra_known_marketplaces.acme]\nsource = {{ source = \"local\", path = \"{}\" }}\n",
                market.display()
            ),
        )
        .unwrap();
        let snapshot = inspect(&env.grok_home, &env.cwd, &env.env, true);
        assert!(
            snapshot
                .marketplaces
                .iter()
                .any(|source| source.name == "acme"),
            "{:?}",
            snapshot.marketplaces
        );
        let listed = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::MarketplaceList { json: false },
        )
        .unwrap();
        assert!(listed.contains("org-tools"), "{listed}");
        let installed = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: "org-tools".into(),
                trust: true,
            },
        )
        .unwrap();
        assert!(installed.contains("Installed"), "{installed}");
    }

    fn write_content_plugin(path: &Path, name: &str, version: &str, marker: &str) {
        fs::create_dir_all(path.join("rules")).unwrap();
        fs::create_dir_all(path.join("skills/greet")).unwrap();
        fs::create_dir_all(path.join("commands")).unwrap();
        fs::create_dir_all(path.join("agents")).unwrap();
        fs::create_dir_all(path.join("hooks")).unwrap();
        fs::write(
            path.join("plugin.json"),
            format!(r#"{{"name":"{name}","version":"{version}","license":"MIT"}}"#),
        )
        .unwrap();
        fs::write(path.join("rules/style.md"), format!("{marker} rule\n")).unwrap();
        fs::write(
            path.join("skills/greet/SKILL.md"),
            format!("---\nname: hello\ndescription: greet\n---\n{marker} skill\n"),
        )
        .unwrap();
        fs::write(
            path.join("commands/deploy.md"),
            format!("---\ndescription: deploy\n---\n{marker} command\n"),
        )
        .unwrap();
        fs::write(
            path.join("agents/reviewer.md"),
            format!("---\ndescription: reviews\n---\n{marker} agent\n"),
        )
        .unwrap();
        fs::write(
            path.join("hooks/hooks.json"),
            r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"${GROK_PLUGIN_ROOT}/guard.sh"},{"type":"http","url":"http://127.0.0.1/x"}]}]}}"#,
        )
        .unwrap();
    }

    fn install_local(env: &Context, source: &Path) {
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: source.display().to_string(),
                trust: true,
            },
        )
        .unwrap();
    }

    fn set_enabled(env: &Context, name: &str, enable: bool) -> String {
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &if enable {
                PluginCommand::Enable { name: name.into() }
            } else {
                PluginCommand::Disable { name: name.into() }
            },
        )
        .unwrap()
    }

    fn hook_entries(env: &Context, trusted: bool) -> Vec<JsonValue> {
        let (key, value) = hook_env(&env.grok_home, &env.cwd, trusted);
        assert_eq!(key, PLUGIN_HOOKS_ENV);
        serde_json::from_str::<Vec<JsonValue>>(&value).unwrap()
    }

    #[test]
    fn bundled_ship_installs_only_on_request_and_stays_off_until_enabled() {
        let dir = TempDir::new().unwrap();
        let mut env = ctx(&dir);
        let install = |env: &Context, source: &str, trust: bool| {
            run(
                &env.grok_home,
                &env.cwd,
                &env.env,
                true,
                &PluginCommand::Install {
                    source: source.into(),
                    trust,
                },
            )
        };
        // Without the launcher there is no bundled directory to copy from.
        let unset = install(&env, "bundled:ship", true).unwrap_err();
        assert!(
            unset.message.contains(BUNDLED_EXTENSIONS_ENV),
            "{}",
            unset.message
        );
        // The checked-in extension (manifest and hooks; the build adds the command).
        let extensions = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../packages/cli/extensions")
            .canonicalize()
            .unwrap();
        env.env.insert(
            BUNDLED_EXTENSIONS_ENV.into(),
            extensions.display().to_string(),
        );
        let bad = install(&env, "bundled:../ship", true).unwrap_err();
        assert!(
            bad.message.contains("invalid bundled extension name"),
            "{}",
            bad.message
        );
        let missing = install(&env, "bundled:nope", true).unwrap_err();
        assert!(
            missing.message.contains("not in this codsh install"),
            "{}",
            missing.message
        );
        let untrusted = install(&env, "bundled:ship", false).unwrap_err();
        assert!(
            untrusted.message.contains("--trust"),
            "{}",
            untrusted.message
        );
        assert!(
            inspect(&env.grok_home, &env.cwd, &env.env, true)
                .installed
                .is_empty()
        );

        let done = install(&env, "bundled:ship", true).unwrap();
        assert!(
            done.contains("Installed 1 plugin(s) from bundled:ship: ship"),
            "{done}"
        );
        // Installing copies files only: no command, rule, or hook is active.
        let row = inspect(&env.grok_home, &env.cwd, &env.env, true).installed[0].clone();
        assert_eq!(
            (row.name.as_str(), row.status.as_str()),
            ("ship", "disabled")
        );
        assert!(active_roots(&env.grok_home, &env.cwd, true).is_empty());
        assert!(hook_entries(&env, true).is_empty());
        assert!(
            row.contributions.problems.is_empty(),
            "{:?}",
            row.contributions.problems
        );
        assert_eq!(
            row.contributions.hooks,
            vec![
                "SessionStart".to_string(),
                "UserPromptSubmit".to_string(),
                "PostToolUse(^(ask_user_question|write|edit|multi_edit|bash)$)".to_string(),
                "SessionEnd".to_string()
            ]
        );

        set_enabled(&env, "ship", true);
        let hooks = hook_entries(&env, true);
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0]["plugin"], "ship");
        assert!(
            hooks[0]["data"]
                .as_str()
                .unwrap()
                .ends_with("plugin-data/ship")
        );
        assert_eq!(active_roots(&env.grok_home, &env.cwd, true).len(), 1);
        set_enabled(&env, "ship", false);
        assert!(hook_entries(&env, true).is_empty());
        assert!(active_roots(&env.grok_home, &env.cwd, true).is_empty());
    }

    #[test]
    fn enable_disable_and_uninstall_move_contributions_in_and_out() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let source = dir.path().join("src-demo");
        write_content_plugin(&source, "demo", "1.0.0", "V1");
        install_local(&env, &source);
        // Installed and trusted, but not enabled: nothing is active.
        assert!(active_roots(&env.grok_home, &env.cwd, true).is_empty());
        assert!(hook_entries(&env, true).is_empty());
        let row = inspect(&env.grok_home, &env.cwd, &env.env, true).installed[0].clone();
        assert_eq!(row.status, "disabled");
        assert_eq!(row.contributions.skills, vec!["/demo:greet".to_string()]);
        assert_eq!(row.contributions.commands, vec!["/demo:deploy".to_string()]);
        assert_eq!(row.contributions.agents, vec!["demo:reviewer".to_string()]);
        assert_eq!(row.contributions.rules, vec!["rules/style.md".to_string()]);
        assert_eq!(
            row.contributions.hooks,
            vec!["PreToolUse(Bash)".to_string()]
        );
        assert!(
            row.contributions
                .problems
                .iter()
                .any(|problem| problem.contains("http hook on PreToolUse does not run")),
            "{:?}",
            row.contributions.problems
        );

        let enabled = set_enabled(&env, "demo", true);
        assert!(enabled.contains("[active]"), "{enabled}");
        assert!(
            enabled.contains("does not grant tool permissions"),
            "{enabled}"
        );
        let roots = active_roots(&env.grok_home, &env.cwd, true);
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].name, "demo");
        assert_eq!(roots[0].skill_dirs.len(), 1);
        let hooks = hook_entries(&env, true);
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0]["plugin"], "demo");
        assert!(
            hooks[0]["file"]
                .as_str()
                .unwrap()
                .ends_with("hooks/hooks.json")
        );
        assert!(
            hooks[0]["data"]
                .as_str()
                .unwrap()
                .ends_with("plugin-data/demo")
        );
        let row = inspect(&env.grok_home, &env.cwd, &env.env, true).installed[0].clone();
        assert_eq!(row.status, "active");
        assert!(
            !row.execution_granted,
            "enabling never grants tool permissions"
        );
        let list: Vec<JsonValue> = serde_json::from_str(
            &run(
                &env.grok_home,
                &env.cwd,
                &env.env,
                true,
                &PluginCommand::List {
                    json: true,
                    available: false,
                },
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(list[0]["status"], "installed");
        assert_eq!(list[0]["state"], "active");
        assert_eq!(list[0]["contributions"]["skills"][0], "/demo:greet");

        set_enabled(&env, "demo", false);
        assert!(active_roots(&env.grok_home, &env.cwd, true).is_empty());
        assert!(hook_entries(&env, true).is_empty());

        set_enabled(&env, "demo", true);
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Uninstall {
                name: "demo".into(),
                confirm: true,
                keep_data: false,
            },
        )
        .unwrap();
        assert!(active_roots(&env.grok_home, &env.cwd, true).is_empty());
        assert!(hook_entries(&env, true).is_empty());
    }

    #[test]
    fn plugin_workflows_are_listed_and_follow_the_plugin_state() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let source = dir.path().join("src-demo");
        write_content_plugin(&source, "demo", "1.0.0", "V1");
        std::fs::create_dir_all(source.join("workflows")).unwrap();
        std::fs::write(
            source.join("workflows/review.rhai"),
            "let meta = #{ name: \"review\", description: \"plugin review\" };\n\"V1\"",
        )
        .unwrap();
        std::fs::write(source.join("workflows/bad.rhai"), "let meta = ").unwrap();
        install_local(&env, &source);
        let row = inspect(&env.grok_home, &env.cwd, &env.env, true).installed[0].clone();
        assert_eq!(row.contributions.workflows, vec!["demo:review".to_string()]);
        assert!(
            row.contributions
                .problems
                .iter()
                .any(|problem| problem.starts_with("workflow bad.rhai not loaded")),
            "{:?}",
            row.contributions.problems
        );
        assert!(row.contributions.summary().contains("1 workflow"));
        assert_eq!(row.contributions.json()["workflows"][0], "demo:review");
        let sources = workflow_sources(&env.grok_home, &env.cwd, true);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].status, "disabled");
        assert_eq!(sources[0].version.as_deref(), Some("1.0.0"));
        assert!(sources[0].dirs[0].ends_with("workflows"));
        set_enabled(&env, "demo", true);
        let sources = workflow_sources(&env.grok_home, &env.cwd, true);
        assert_eq!(sources[0].status, "active");
        assert!(sources[0].trusted);
        run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Uninstall {
                name: "demo".into(),
                confirm: true,
                keep_data: false,
            },
        )
        .unwrap();
        assert!(workflow_sources(&env.grok_home, &env.cwd, true).is_empty());
    }

    #[test]
    fn expanded_overlay_row_fits_the_notice_and_names_contributions() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        for name in ["alpha", "demo", "zeta"] {
            let source = dir.path().join(format!("src-{name}"));
            write_content_plugin(&source, name, "1.0.0", "X");
            install_local(&env, &source);
        }
        set_enabled(&env, "demo", true);
        let snapshot = inspect(&env.grok_home, &env.cwd, &env.env, true);
        let mut overlay = new_overlay(PluginTab::Plugins);
        let collapsed = overlay_text(&overlay, &snapshot, Some(&env.grok_home));
        assert!(collapsed.contains("alpha") && collapsed.contains("zeta"));
        assert!(collapsed.contains("[disabled]") && collapsed.contains("[active]"));
        overlay.cursor = 1;
        overlay.expanded = true;
        let expanded = overlay_text(&overlay, &snapshot, Some(&env.grok_home));
        assert!(expanded.lines().count() <= 6, "{expanded}");
        assert!(
            !expanded.contains("alpha") && !expanded.contains("zeta"),
            "{expanded}"
        );
        assert!(expanded.contains("> demo"), "{expanded}");
        assert!(
            expanded.contains("active: contributions load"),
            "{expanded}"
        );
        assert!(
            expanded.contains(
                "/demo:greet, /demo:deploy, demo:reviewer, PreToolUse(Bash), rules/style.md"
            ),
            "{expanded}"
        );
        assert!(expanded.contains("note http hook"), "{expanded}");
    }

    #[test]
    fn untrusted_install_and_untrusted_project_stay_blocked() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let source = dir.path().join("src-demo");
        write_content_plugin(&source, "demo", "1.0.0", "V1");
        install_local(&env, &source);
        set_enabled(&env, "demo", true);
        // Trust revoked by hand: enabled is not enough.
        fs::write(env.trust_path(), "trusted = []\n").unwrap();
        let row = inspect(&env.grok_home, &env.cwd, &env.env, true).installed[0].clone();
        assert_eq!(row.status, "blocked");
        assert!(active_roots(&env.grok_home, &env.cwd, true).is_empty());
        assert!(hook_entries(&env, true).is_empty());

        let project = dir.path().join(".grok/plugins/proj");
        write_content_plugin(&project, "proj", "0.1.0", "P");
        set_enabled(&env, "proj", true);
        let untrusted = inspect(&env.grok_home, &env.cwd, &env.env, false);
        let row = untrusted
            .installed
            .iter()
            .find(|row| row.name == "proj")
            .unwrap();
        assert_eq!(row.status, "blocked");
        assert!(row.status_detail.contains("workspace is not trusted"));
        assert!(active_roots(&env.grok_home, &env.cwd, false).is_empty());
        assert!(hook_entries(&env, false).is_empty());
        let roots = active_roots(&env.grok_home, &env.cwd, true);
        assert_eq!(
            roots
                .iter()
                .map(|root| root.name.as_str())
                .collect::<Vec<_>>(),
            vec!["proj"]
        );
        assert_eq!(roots[0].scope, "project");
        assert_eq!(hook_entries(&env, true)[0]["scope"], "project");
    }

    #[test]
    fn manifest_paths_stay_inside_and_a_bad_hooks_file_does_not_drop_the_rest() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let source = dir.path().join("src-odd");
        write_content_plugin(&source, "odd", "1.0.0", "ODD");
        fs::create_dir_all(source.join("extra-skills/solo")).unwrap();
        fs::write(source.join("extra-skills/solo/SKILL.md"), "solo body\n").unwrap();
        fs::write(
            source.join("plugin.json"),
            r#"{"name":"odd","version":"1.0.0","skills":["./extra-skills","../outside"],"commands":"missing-dir"}"#,
        )
        .unwrap();
        fs::write(source.join("hooks/hooks.json"), "{ not json").unwrap();
        install_local(&env, &source);
        set_enabled(&env, "odd", true);
        let row = inspect(&env.grok_home, &env.cwd, &env.env, true).installed[0].clone();
        assert_eq!(row.status, "active");
        assert_eq!(row.contributions.skills, vec!["/odd:solo".to_string()]);
        assert!(row.contributions.commands.is_empty());
        assert_eq!(row.contributions.rules, vec!["rules/style.md".to_string()]);
        assert!(row.contributions.hooks.is_empty());
        let problems = row.contributions.problems.join("\n");
        assert!(problems.contains("skills path ../outside"), "{problems}");
        assert!(problems.contains("commands path"), "{problems}");
        assert!(problems.contains("hooks file"), "{problems}");
        // The file is still handed over; the hooks runner reports it as
        // unreadable and keeps every other hook source.
        assert_eq!(hook_entries(&env, true).len(), 1);
    }

    #[test]
    fn inline_hooks_and_duplicate_names_are_reported() {
        let dir = TempDir::new().unwrap();
        let env = ctx(&dir);
        let first = dir.path().join("a/dup");
        write_content_plugin(&first, "dup", "1.0.0", "FIRST");
        fs::remove_file(first.join("hooks/hooks.json")).unwrap();
        fs::write(
            first.join("plugin.json"),
            r#"{"name":"dup","version":"1.0.0","hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"true"}]}]}}"#,
        )
        .unwrap();
        install_local(&env, &first);
        let second = dir.path().join("b/dup");
        write_content_plugin(&second, "dup", "2.0.0", "SECOND");
        // A second repo with the same plugin name is refused or shadowed,
        // never loaded twice.
        let _ = run(
            &env.grok_home,
            &env.cwd,
            &env.env,
            true,
            &PluginCommand::Install {
                source: second.display().to_string(),
                trust: true,
            },
        );
        set_enabled(&env, "dup", true);
        let rows = inspect(&env.grok_home, &env.cwd, &env.env, true).installed;
        assert_eq!(rows.iter().filter(|row| row.status == "active").count(), 1);
        if rows.len() > 1 {
            assert!(rows.iter().any(|row| row.status == "shadowed"));
        }
        let hooks = hook_entries(&env, true);
        assert_eq!(hooks.len(), 1);
        assert!(
            hooks[0]["body"]
                .as_str()
                .unwrap()
                .contains("UserPromptSubmit")
        );
        assert!(hooks[0]["file"].is_null());
        assert_eq!(active_roots(&env.grok_home, &env.cwd, true).len(), 1);
    }
}
