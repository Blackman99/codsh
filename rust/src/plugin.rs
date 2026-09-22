//! Plugin marketplace, install, update, and remove for the isolated Rust client.
//!
//! Install records provenance and files under `$GROK_HOME`. It does not enable
//! execution, load hooks/MCP, or touch legacy `~/.grok` / dsh profile packages.

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
    pub trusted: bool,
    pub enabled: bool,
    pub execution_granted: bool,
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
Leader sockets are unused; dsh owns execution. Install records files and provenance only; it does not enable hooks, MCP, or tool execution."
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
    match command {
        PluginCommand::Help => Ok(plugin_help().to_string()),
        PluginCommand::MarketplaceHelp => Ok(marketplace_help().to_string()),
        PluginCommand::List { json, available } => cmd_list(&ctx, *json, *available),
        PluginCommand::Install { source, trust } => cmd_install(&ctx, source, *trust),
        PluginCommand::Uninstall {
            name,
            confirm,
            keep_data,
        } => cmd_uninstall(&ctx, name, *confirm, *keep_data),
        PluginCommand::Update { name } => cmd_update(&ctx, name.as_deref()),
        PluginCommand::Enable { name } => cmd_enable(&ctx, name, true),
        PluginCommand::Disable { name } => cmd_enable(&ctx, name, false),
        PluginCommand::MarketplaceList { json } => cmd_marketplace_list(&ctx, *json),
        PluginCommand::MarketplaceAdd { url, force } => cmd_marketplace_add(&ctx, url, *force),
        PluginCommand::MarketplaceRemove { source } => cmd_marketplace_remove(&ctx, source),
        PluginCommand::MarketplaceUpdate { name } => cmd_marketplace_update(&ctx, name.as_deref()),
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
    PluginInspect {
        auto_register_official: auto_register_enabled(&ctx.env),
        require_sha: require_sha(&ctx),
        marketplaces: load_marketplace_sources(&ctx),
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
            "trusted": plugin.trusted,
            "enabled": plugin.enabled,
            "executionGranted": plugin.execution_granted,
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
                    let mark = if index == overlay.cursor { ">" } else { " " };
                    lines.push(format!(
                        "{mark} {}  v{}  {}  {}  trusted={} enabled={} exec={}  license={}",
                        plugin.name,
                        plugin.version.as_deref().unwrap_or("unspecified"),
                        plugin.scope,
                        plugin
                            .marketplace
                            .as_deref()
                            .unwrap_or(plugin.source.as_str()),
                        plugin.trusted,
                        plugin.enabled,
                        plugin.execution_granted,
                        plugin.license.as_deref().unwrap_or("unspecified")
                    ));
                    if overlay.expanded && index == overlay.cursor {
                        lines.push(format!("    path {}", plugin.path.display()));
                        lines.push(format!("    source {}", plugin.source));
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
            "  {}: {} [{}] license={} trusted={} enabled={} exec={}",
            plugin.name,
            plugin.source,
            plugin.scope,
            plugin.license.as_deref().unwrap_or("unspecified"),
            plugin.trusted,
            plugin.enabled,
            plugin.execution_granted
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
    let sources = load_marketplace_sources(ctx);
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
    if let Some(plugin_ref) = parse_marketplace_plugin_ref(source) {
        return install_from_marketplace(ctx, &plugin_ref, trust);
    }
    let parsed = parse_install_source(source, &ctx.cwd)?;
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
    if require_sha(ctx) && !parsed.local && !is_full_sha(parsed.git_ref.as_deref().unwrap_or("")) {
        return Err(PluginError::fail(format!(
            "refusing unpinned remote plugin code for '{source}' from {}: marketplace.require_sha / GROK_MARKETPLACE_REQUIRE_SHA is enabled and no full commit sha (40/64 hex) is pinned",
            parsed.identity
        )));
    }
    let outcome = install_from_parsed(ctx, &parsed, None)?;
    record_trust(ctx, &outcome.names, true)?;
    Ok(format!(
        "Installed {} plugin(s) from {source}: {}\nTrusted for later enablement; execution is not granted until the plugin is enabled.",
        outcome.names.len(),
        outcome.names.join(", ")
    ))
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
            if require_sha(ctx)
                && !parsed.local
                && !is_full_sha(parsed.git_ref.as_deref().unwrap_or(""))
            {
                return Err(PluginError::fail(format!(
                    "refusing unpinned remote plugin code for '{}' from {}",
                    plugin.name, parsed.identity
                )));
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
    if !keep_data {
        for plugin in &names {
            let data = ctx.data_dir().join(plugin);
            if data.exists() {
                let _ = fs::remove_dir_all(data);
            }
        }
    }
    registry.repos.remove(&repo_key);
    save_registry(ctx, &registry)?;
    let mut enabled = enabled_set(ctx);
    let mut disabled = disabled_set(ctx);
    for plugin in &names {
        enabled.remove(plugin);
        disabled.remove(plugin);
    }
    write_enabled_lists(ctx, &enabled, &disabled)?;
    let mut trusted = trusted_set(ctx)?;
    for plugin in &names {
        trusted.remove(plugin);
    }
    write_trusted_set(ctx, &trusted)?;
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
    if enable {
        Ok(format!(
            "Enabled plugin: {name}\nDiscovery may load on the next session; install trust is unchanged and does not grant tools."
        ))
    } else {
        Ok(format!("Disabled plugin: {name}"))
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
            identity: url.clone(),
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
                identity: source.identity(),
                subject: format!("from directory {}", plugin_path.display()),
                local: true,
                source_path: Some(plugin_path),
                git_url: None,
                git_ref: None,
                subdir: None,
            })
        }
        SourceKind::Git { url, branch } => Ok(ParsedSource {
            identity: url.clone(),
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
            format!(
                "{repo_key}: updated ({} -> {})",
                &commit[..7.min(commit.len())],
                &new_commit[..7.min(new_commit.len())]
            )
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
        if let InstallKind::Git { commit, .. } = &mut entry.kind
            && let Ok(new_commit) = git_head(&entry.path)
        {
            *commit = new_commit;
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
    Ok(removed)
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
    let registry = load_registry(ctx).unwrap_or_else(|_| InstallRegistry::empty());
    let trusted = trusted_set(ctx).unwrap_or_default();
    let enabled = enabled_set(ctx);
    let mut views = Vec::new();
    for repo in registry.repos.values() {
        for (name, plugin) in &repo.plugins {
            let path = match &plugin.subdir {
                Some(subdir) => repo.path.join(subdir),
                None => repo.path.clone(),
            };
            let is_trusted = trusted.contains(name);
            let is_enabled = enabled.contains(name);
            views.push(InstalledView {
                name: name.clone(),
                version: plugin.version.clone(),
                license: plugin.license.clone(),
                scope: "user".into(),
                source: match &repo.kind {
                    InstallKind::Git { url, .. } => url.clone(),
                    InstallKind::Local { source_path, .. } => source_path.display().to_string(),
                },
                path,
                marketplace: repo
                    .marketplace
                    .as_ref()
                    .map(|item| item.source_display_name.clone()),
                trusted: is_trusted,
                enabled: is_enabled,
                execution_granted: false,
            });
        }
    }
    let project = ctx.cwd.join(".grok").join("plugins");
    if project.is_dir() {
        for child in read_dirs(&project).unwrap_or_default() {
            if let Ok(Some((name, plugin))) = read_plugin_at(&child) {
                if views.iter().any(|row| row.name == name) {
                    continue;
                }
                views.push(InstalledView {
                    name,
                    version: plugin.version,
                    license: plugin.license,
                    scope: "project".into(),
                    source: child.display().to_string(),
                    path: child,
                    marketplace: None,
                    trusted: ctx.workspace_trusted,
                    enabled: false,
                    execution_granted: false,
                });
            }
        }
    }
    views.sort_by(|a, b| a.name.cmp(&b.name));
    views
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
    let mut sources = Vec::new();
    let mut seen = BTreeSet::new();
    for (origin, value) in load_toml_layers(ctx) {
        for source in sources_from_toml(&value, origin) {
            let identity = canonicalize_git(&source.identity());
            if seen.insert(identity) {
                sources.push(source);
            }
        }
    }
    sources
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

fn allowlist_block(ctx: &Context, identity: &str, is_local: bool) -> Option<String> {
    let mut present = false;
    let mut allowed = Vec::new();
    for (_, value) in load_toml_layers(ctx) {
        if let Some(list) = value.get("strict_known_marketplaces") {
            present = true;
            if let Some(entries) = list.as_array() {
                for entry in entries {
                    if let Some(url) = entry.get("url").and_then(TomlValue::as_str) {
                        allowed.push(canonicalize_git(url));
                    }
                    if let Some(repo) = entry.get("repo").and_then(TomlValue::as_str) {
                        allowed.push(canonicalize_git(&format!("https://github.com/{repo}.git")));
                    }
                }
            } else {
                allowed.clear();
            }
        }
    }
    if !present {
        return None;
    }
    if is_local {
        return Some(
            "local-path adds are refused while a strict marketplace allowlist is present".into(),
        );
    }
    if allowed.is_empty() {
        return Some(
            "strict_known_marketplaces is present but empty or unsupported; all adds are refused"
                .into(),
        );
    }
    let canon = canonicalize_git(identity);
    if allowed.iter().any(|item| item == &canon) {
        None
    } else {
        Some("source not in strict_known_marketplaces".into())
    }
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
    let without_lists = strip_plugin_list_keys(&existing);
    let mut text = without_lists;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    if !text.contains("[plugins]") {
        text.push_str("\n[plugins]\n");
    }
    text.push_str(&format!(
        "enabled = [{}]\n",
        enabled
            .iter()
            .map(|name| format!("\"{}\"", escape_toml(name)))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    text.push_str(&format!(
        "disabled = [{}]\n",
        disabled
            .iter()
            .map(|name| format!("\"{}\"", escape_toml(name)))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    atomic_write(&path, text.as_bytes())
}

fn strip_plugin_list_keys(text: &str) -> String {
    let mut out = String::new();
    let mut in_plugins = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            in_plugins = trimmed.starts_with("[plugins]");
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

fn is_valid_plugin_name(name: &str) -> bool {
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
    canonical_github_owner_repo(url).as_deref() == Some("xai-org/plugin-marketplace")
}

fn canonical_github_owner_repo(url: &str) -> Option<String> {
    let text = url.trim();
    let text = text.strip_suffix('/').unwrap_or(text);
    let text = text.strip_suffix(".git").unwrap_or(text);
    let lower = text.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .or_else(|| lower.strip_prefix("ssh://"))
        .unwrap_or(&lower);
    let rest = rest.strip_prefix("git@").unwrap_or(rest);
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    let owner_repo = rest
        .strip_prefix("github.com/")
        .or_else(|| rest.strip_prefix("github.com:"))?;
    (!owner_repo.is_empty()).then(|| owner_repo.to_string())
}

fn canonicalize_git(url: &str) -> String {
    if let Some(owner_repo) = canonical_github_owner_repo(url) {
        return format!("https://github.com/{owner_repo}.git");
    }
    let text = url.trim();
    let text = text.strip_suffix('/').unwrap_or(text);
    let text = text.strip_suffix(".git").unwrap_or(text);
    text.to_ascii_lowercase()
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
        let plugin = root.join("plugins").join(plugin_name);
        write_plugin(&plugin, plugin_name, "1.0.0", "MIT");
        fs::create_dir_all(root.join(".grok-plugin")).unwrap();
        fs::write(
            root.join(".grok-plugin/marketplace.json"),
            format!(
                r#"{{"name":"Fixtures","plugins":[{{"name":"{plugin_name}","version":"1.0.0","license":"MIT","source":{{"type":"local","path":"./plugins/{plugin_name}"}}}}]}}"#
            ),
        )
        .unwrap();
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
}
