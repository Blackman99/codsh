use crate::screen_mode::ScreenMode;
use crate::theme::{Appearance, ColorLevel, Theme, ThemeKind};
use serde_json::{Value as JsonValue, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use toml::Value as TomlValue;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppearanceConfig {
    pub theme: ThemeKind,
    pub auto_dark_theme: ThemeKind,
    pub auto_light_theme: ThemeKind,
    pub compact_mode: bool,
    pub show_timestamps: bool,
    pub screen_mode: ScreenMode,
    pub confirm_before_rewind: bool,
    pub terminal_theme: bool,
    pub status_line: StatusLineConfig,
    pub sources: BTreeMap<String, String>,
    pub locked: BTreeMap<String, String>,
    pub color_level: ColorLevel,
    pub appearance: Option<Appearance>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusLineConfig {
    pub kind: StatusLineKind,
    pub items: Vec<StatusLineItem>,
    pub command: Option<String>,
    pub refresh_interval: Option<u64>,
    pub padding: u8,
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusLineKind {
    Disabled,
    Builtin,
    Command,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusLineItem {
    Cwd,
    Model,
    Context,
    Cost,
    TurnTimer,
    SessionName,
}

impl Default for StatusLineConfig {
    fn default() -> Self {
        Self {
            kind: StatusLineKind::Disabled,
            items: vec![
                StatusLineItem::Cwd,
                StatusLineItem::Model,
                StatusLineItem::Context,
            ],
            command: None,
            refresh_interval: None,
            padding: 0,
            message: None,
        }
    }
}

impl StatusLineKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Builtin => "builtin",
            Self::Command => "command",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "disabled" | "off" | "none" | "hidden" => Some(Self::Disabled),
            "builtin" => Some(Self::Builtin),
            "command" => Some(Self::Command),
            _ => None,
        }
    }
}

impl StatusLineItem {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cwd => "cwd",
            Self::Model => "model",
            Self::Context => "context",
            Self::Cost => "cost",
            Self::TurnTimer => "turn-timer",
            Self::SessionName => "session-name",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "cwd" => Some(Self::Cwd),
            "model" => Some(Self::Model),
            "context" => Some(Self::Context),
            "cost" => Some(Self::Cost),
            "turn-timer" | "turn_timer" => Some(Self::TurnTimer),
            "session-name" | "session_name" => Some(Self::SessionName),
            _ => None,
        }
    }
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            theme: ThemeKind::GrokNight,
            auto_dark_theme: ThemeKind::GrokNight,
            auto_light_theme: ThemeKind::GrokDay,
            compact_mode: false,
            show_timestamps: true,
            screen_mode: ScreenMode::Fullscreen,
            confirm_before_rewind: true,
            terminal_theme: false,
            status_line: StatusLineConfig::default(),
            sources: BTreeMap::from([
                ("ui.theme".into(), "default".into()),
                ("ui.compact_mode".into(), "default".into()),
                ("ui.show_timestamps".into(), "default".into()),
                ("ui.status_line.type".into(), "default".into()),
            ]),
            locked: BTreeMap::new(),
            color_level: ColorLevel::TrueColor,
            appearance: None,
        }
    }
}

impl AppearanceConfig {
    pub fn resolved_kind(&self, screen: ScreenMode) -> ThemeKind {
        if screen == ScreenMode::Minimal {
            return ThemeKind::Terminal;
        }
        if self.theme.is_auto() {
            crate::theme::resolve_auto(self.appearance, self.auto_dark_theme, self.auto_light_theme)
        } else {
            self.theme
        }
    }

    pub fn resolved_theme(&self, screen: ScreenMode) -> Theme {
        let kind = self.resolved_kind(screen);
        let theme = if screen == ScreenMode::Minimal {
            Theme::terminal_default()
        } else {
            Theme::for_kind(kind)
        };
        let level = if screen == ScreenMode::Minimal || kind.is_terminal_native() {
            self.color_level.min(ColorLevel::Basic)
        } else {
            self.color_level
        };
        theme.quantized(level)
    }

    #[allow(dead_code)]
    pub fn is_locked(&self, key: &str) -> bool {
        self.locked.contains_key(key)
    }

    pub fn lock_reason(&self, key: &str) -> Option<&str> {
        self.locked.get(key).map(String::as_str)
    }

    pub fn source(&self, key: &str) -> &str {
        self.sources
            .get(key)
            .map(String::as_str)
            .unwrap_or("default")
    }
}

pub fn load(
    managed: Option<&TomlValue>,
    user: Option<&TomlValue>,
    requirements: Option<&TomlValue>,
    env: &BTreeMap<String, String>,
    workspace_ui: Option<&TomlValue>,
    sources: &mut BTreeMap<String, String>,
    warnings: &mut Vec<String>,
) -> AppearanceConfig {
    let mut config = AppearanceConfig {
        color_level: ColorLevel::detect(env),
        appearance: Appearance::detect(env),
        terminal_theme: managed
            .and_then(|table| bool_from(table, &["features", "terminal_theme"]))
            .or_else(|| user.and_then(|table| bool_from(table, &["features", "terminal_theme"])))
            .unwrap_or(false),
        ..Default::default()
    };
    sources
        .entry("features.terminal_theme".into())
        .or_insert_with(|| "default".into());
    if managed
        .and_then(|table| {
            table
                .get("features")
                .and_then(|features| features.get("terminal_theme"))
        })
        .is_some()
    {
        sources.insert("features.terminal_theme".into(), "managed".into());
    }
    if user
        .and_then(|table| {
            table
                .get("features")
                .and_then(|features| features.get("terminal_theme"))
        })
        .is_some()
    {
        sources.insert("features.terminal_theme".into(), "config.toml".into());
    }
    if let Some(value) = env_bool(env.get("GROK_TERMINAL_THEME")) {
        config.terminal_theme = value;
        sources.insert("features.terminal_theme".into(), "environment".into());
    }

    let terminal_theme = config.terminal_theme;
    if let Some(table) = managed {
        apply_ui_table(
            table.get("ui"),
            &mut config,
            sources,
            "managed",
            terminal_theme,
            warnings,
        );
    }
    if let Some(table) = user {
        apply_ui_table(
            table.get("ui"),
            &mut config,
            sources,
            "config.toml",
            terminal_theme,
            warnings,
        );
    }
    if let Some(workspace) = workspace_ui
        && workspace.get("ui").is_some()
    {
        warnings.push(
            "workspace [ui] is ignored; appearance, theme, and status line load from user or administrator config only."
                .into(),
        );
        if workspace
            .get("ui")
            .and_then(|ui| ui.get("status_line"))
            .is_some()
        {
            warnings.push(
                "[ui.status_line] from a repository is ignored; only the user or administrator config may run a status-line command."
                    .into(),
            );
        }
    }

    if let Some(value) = crate::theme::env_theme(env, config.terminal_theme) {
        config.theme = value;
        sources.insert("ui.theme".into(), "environment".into());
        config.locked.insert(
            "ui.theme".into(),
            "environment GROK_THEME/LC_GROK_THEME".into(),
        );
    } else if sources.get("ui.theme").is_none() {
        sources.insert("ui.theme".into(), "default".into());
    }

    if let Some(req) = requirements {
        let terminal_theme = config.terminal_theme;
        apply_ui_table(
            req.get("ui"),
            &mut config,
            sources,
            "requirements",
            terminal_theme,
            warnings,
        );
        if let Some(value) = bool_from(req, &["features", "terminal_theme"]) {
            config.terminal_theme = value;
            sources.insert("features.terminal_theme".into(), "requirements".into());
            config
                .locked
                .insert("features.terminal_theme".into(), "requirements".into());
        }
        lock_present(req, "ui.theme", &mut config);
        lock_present(req, "ui.auto_dark_theme", &mut config);
        lock_present(req, "ui.auto_light_theme", &mut config);
        lock_present(req, "ui.compact_mode", &mut config);
        lock_present(req, "ui.show_timestamps", &mut config);
        lock_present(req, "ui.screen_mode", &mut config);
        lock_present(req, "ui.confirm_before_rewind", &mut config);
        if req.get("ui").and_then(|ui| ui.get("status_line")).is_some() {
            config
                .locked
                .insert("ui.status_line.type".into(), "requirements".into());
            config
                .locked
                .insert("ui.status_line.command".into(), "requirements".into());
            config
                .locked
                .insert("ui.status_line.items".into(), "requirements".into());
            config.locked.insert(
                "ui.status_line.refresh_interval".into(),
                "requirements".into(),
            );
        }
    }

    config.sources = sources
        .iter()
        .filter(|(key, _)| {
            key.starts_with("ui.")
                || key.starts_with("features.terminal_theme")
                || key.starts_with("ui.status_line")
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    config
}

fn lock_present(req: &TomlValue, key: &str, config: &mut AppearanceConfig) {
    let parts: Vec<&str> = key.split('.').collect();
    if toml_path(req, &parts).is_some() {
        config.locked.insert(key.into(), "requirements".into());
    }
}

fn apply_ui_table(
    ui: Option<&TomlValue>,
    config: &mut AppearanceConfig,
    sources: &mut BTreeMap<String, String>,
    source: &str,
    terminal_theme: bool,
    warnings: &mut Vec<String>,
) {
    let Some(ui) = ui else {
        return;
    };
    if let Some(value) = ui.get("theme").and_then(TomlValue::as_str) {
        match ThemeKind::from_name_gated(value, terminal_theme) {
            Some(kind) => {
                config.theme = kind;
                sources.insert("ui.theme".into(), source.into());
            }
            None => warnings.push(format!(
                "unknown ui.theme {value:?}; using {}",
                config.theme.display_name()
            )),
        }
    }
    if let Some(value) = ui.get("auto_dark_theme").and_then(TomlValue::as_str)
        && let Some(kind) =
            ThemeKind::from_name_gated(value, terminal_theme).filter(|kind| !kind.is_auto())
    {
        config.auto_dark_theme = kind;
        sources.insert("ui.auto_dark_theme".into(), source.into());
    }
    if let Some(value) = ui.get("auto_light_theme").and_then(TomlValue::as_str)
        && let Some(kind) =
            ThemeKind::from_name_gated(value, terminal_theme).filter(|kind| !kind.is_auto())
    {
        config.auto_light_theme = kind;
        sources.insert("ui.auto_light_theme".into(), source.into());
    }
    if let Some(value) = bool_from_value(ui.get("compact_mode")) {
        config.compact_mode = value;
        sources.insert("ui.compact_mode".into(), source.into());
    }
    if let Some(value) = bool_from_value(ui.get("show_timestamps")) {
        config.show_timestamps = value;
        sources.insert("ui.show_timestamps".into(), source.into());
    }
    if let Some(value) = ui.get("screen_mode").and_then(TomlValue::as_str)
        && let Ok(mode) = ScreenMode::parse(value)
    {
        config.screen_mode = mode;
        sources.insert("ui.screen_mode".into(), source.into());
    }
    if let Some(value) = bool_from_value(ui.get("confirm_before_rewind")) {
        config.confirm_before_rewind = value;
        sources.insert("ui.confirm_before_rewind".into(), source.into());
    }
    if ui.get("status_line").is_some() {
        config.status_line = parse_status_line(ui.get("status_line"), sources, source, warnings);
    }
}

fn parse_status_line(
    value: Option<&TomlValue>,
    sources: &mut BTreeMap<String, String>,
    source: &str,
    warnings: &mut Vec<String>,
) -> StatusLineConfig {
    let mut config = StatusLineConfig::default();
    let Some(table) = value.and_then(TomlValue::as_table) else {
        if value.is_some() {
            config.message = Some("[ui.status_line] could not be read; row disabled".into());
        }
        return config;
    };
    if let Some(raw) = table.get("type").and_then(TomlValue::as_str) {
        match StatusLineKind::parse(raw) {
            Some(kind) => {
                config.kind = kind;
                sources.insert("ui.status_line.type".into(), source.into());
            }
            None => {
                config.message = Some(format!(
                    "[ui.status_line] type {raw:?} is not builtin, command, or disabled"
                ));
                warnings.push(config.message.clone().unwrap());
            }
        }
    }
    if let Some(items) = table.get("items").and_then(TomlValue::as_array) {
        let parsed: Vec<_> = items
            .iter()
            .filter_map(|item| item.as_str().and_then(StatusLineItem::parse))
            .collect();
        if !parsed.is_empty() {
            config.items = parsed;
            sources.insert("ui.status_line.items".into(), source.into());
        }
    }
    if let Some(command) = table.get("command").and_then(TomlValue::as_str)
        && !command.trim().is_empty()
    {
        config.command = Some(expand_home(command));
        sources.insert("ui.status_line.command".into(), source.into());
    }
    if let Some(interval) = table.get("refresh_interval") {
        let secs = match interval {
            TomlValue::Integer(value) if *value >= 1 && *value <= 86_400 => Some(*value as u64),
            TomlValue::String(text) => text
                .parse::<u64>()
                .ok()
                .filter(|value| (1..=86_400).contains(value)),
            _ => None,
        };
        if let Some(secs) = secs {
            config.refresh_interval = Some(secs);
            sources.insert("ui.status_line.refresh_interval".into(), source.into());
        } else {
            warnings.push("[ui.status_line] refresh_interval must be 1..=86400 seconds".into());
        }
    }
    if let Some(padding) = table.get("padding").and_then(TomlValue::as_integer) {
        config.padding = padding.clamp(0, 16) as u8;
    }
    if config.kind == StatusLineKind::Command && config.command.is_none() {
        config.message = Some("[ui.status_line] command is required for type = \"command\"".into());
        config.kind = StatusLineKind::Disabled;
    }
    config
}

fn expand_home(command: &str) -> String {
    if let Some(rest) = command.strip_prefix("~/")
        && let Some(home) = std::env::var_os("HOME")
    {
        return format!("{}/{rest}", PathBuf::from(home).display());
    }
    command.to_string()
}

pub fn settings_rows(config: &AppearanceConfig, screen: ScreenMode) -> Vec<SettingRow> {
    let minimal = screen == ScreenMode::Minimal;
    let mut rows = vec![
        bool_row(
            config,
            "ui.compact_mode",
            "Compact mode",
            config.compact_mode,
        ),
        enum_row(
            config,
            "ui.screen_mode",
            "Default screen mode",
            config.screen_mode.as_str(),
            &["fullscreen", "minimal"],
            true,
        ),
        bool_row(
            config,
            "ui.show_timestamps",
            "Show timestamps",
            config.show_timestamps,
        ),
        bool_row(
            config,
            "ui.confirm_before_rewind",
            "Confirm before rewind",
            config.confirm_before_rewind,
        ),
    ];
    if !minimal {
        let mut themes: Vec<&'static str> =
            ThemeKind::available(config.color_level, config.terminal_theme)
                .into_iter()
                .map(ThemeKind::display_name)
                .collect();
        themes.insert(0, "auto");
        rows.push(enum_row(
            config,
            "ui.theme",
            "Theme",
            config.theme.display_name(),
            &themes,
            false,
        ));
        let concrete: Vec<&'static str> =
            ThemeKind::available(config.color_level, config.terminal_theme)
                .into_iter()
                .map(ThemeKind::display_name)
                .collect();
        rows.push(enum_row(
            config,
            "ui.auto_dark_theme",
            "Auto dark theme",
            config.auto_dark_theme.display_name(),
            &concrete,
            false,
        ));
        rows.push(enum_row(
            config,
            "ui.auto_light_theme",
            "Auto light theme",
            config.auto_light_theme.display_name(),
            &concrete,
            false,
        ));
    }
    rows.push(enum_row(
        config,
        "ui.status_line.type",
        "Status line",
        config.status_line.kind.as_str(),
        &["disabled", "builtin", "command"],
        false,
    ));
    if config.status_line.kind == StatusLineKind::Builtin {
        rows.push(string_row(
            config,
            "ui.status_line.items",
            "Status line items",
            &config
                .status_line
                .items
                .iter()
                .map(|item| item.as_str())
                .collect::<Vec<_>>()
                .join(","),
        ));
    }
    if config.status_line.kind == StatusLineKind::Command {
        rows.push(string_row(
            config,
            "ui.status_line.command",
            "Status line command",
            config.status_line.command.as_deref().unwrap_or(""),
        ));
        rows.push(string_row(
            config,
            "ui.status_line.refresh_interval",
            "Status line refresh (s)",
            &config
                .status_line
                .refresh_interval
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ));
    }
    rows
}

fn bool_row(config: &AppearanceConfig, key: &str, label: &str, value: bool) -> SettingRow {
    SettingRow {
        key: key.into(),
        label: label.into(),
        value: if value { "on".into() } else { "off".into() },
        kind: SettingKind::Bool(value),
        source: config.source(key).into(),
        locked: config.lock_reason(key).map(str::to_string),
        restart_required: false,
    }
}

fn enum_row(
    config: &AppearanceConfig,
    key: &str,
    label: &str,
    value: &str,
    choices: &[&str],
    restart_required: bool,
) -> SettingRow {
    SettingRow {
        key: key.into(),
        label: label.into(),
        value: value.into(),
        kind: SettingKind::Enum {
            value: value.into(),
            choices: choices.iter().map(|item| (*item).to_string()).collect(),
        },
        source: config.source(key).into(),
        locked: config.lock_reason(key).map(str::to_string),
        restart_required,
    }
}

fn string_row(config: &AppearanceConfig, key: &str, label: &str, value: &str) -> SettingRow {
    SettingRow {
        key: key.into(),
        label: label.into(),
        value: value.into(),
        kind: SettingKind::String(value.into()),
        source: config.source(key).into(),
        locked: config.lock_reason(key).map(str::to_string),
        restart_required: false,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingRow {
    pub key: String,
    pub label: String,
    pub value: String,
    pub kind: SettingKind,
    pub source: String,
    pub locked: Option<String>,
    pub restart_required: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SettingKind {
    Bool(bool),
    Enum { value: String, choices: Vec<String> },
    String(String),
}

pub fn inspect_rows(
    config: &AppearanceConfig,
    screen: ScreenMode,
) -> Vec<(String, String, String)> {
    let resolved = config.resolved_kind(screen);
    let mut rows = vec![
        (
            "ui.theme".into(),
            config.theme.display_name().into(),
            config.source("ui.theme").into(),
        ),
        (
            "ui.theme.resolved".into(),
            resolved.display_name().into(),
            if screen == ScreenMode::Minimal {
                "minimal-palette".into()
            } else {
                config.source("ui.theme").into()
            },
        ),
        (
            "ui.auto_dark_theme".into(),
            config.auto_dark_theme.display_name().into(),
            config.source("ui.auto_dark_theme").into(),
        ),
        (
            "ui.auto_light_theme".into(),
            config.auto_light_theme.display_name().into(),
            config.source("ui.auto_light_theme").into(),
        ),
        (
            "ui.compact_mode".into(),
            flag(config.compact_mode),
            config.source("ui.compact_mode").into(),
        ),
        (
            "ui.show_timestamps".into(),
            flag(config.show_timestamps),
            config.source("ui.show_timestamps").into(),
        ),
        (
            "ui.status_line.type".into(),
            config.status_line.kind.as_str().into(),
            config.source("ui.status_line.type").into(),
        ),
        (
            "ui.status_line.items".into(),
            config
                .status_line
                .items
                .iter()
                .map(|item| item.as_str())
                .collect::<Vec<_>>()
                .join(","),
            config.source("ui.status_line.items").into(),
        ),
        (
            "ui.status_line.command".into(),
            config
                .status_line
                .command
                .clone()
                .unwrap_or_else(|| "(unset)".into()),
            config.source("ui.status_line.command").into(),
        ),
        (
            "features.terminal_theme".into(),
            flag(config.terminal_theme),
            config.source("features.terminal_theme").into(),
        ),
        (
            "color.level".into(),
            format!("{:?}", config.color_level).to_ascii_lowercase(),
            "detected".into(),
        ),
    ];
    if let Some(interval) = config.status_line.refresh_interval {
        rows.push((
            "ui.status_line.refresh_interval".into(),
            interval.to_string(),
            config.source("ui.status_line.refresh_interval").into(),
        ));
    }
    for (key, reason) in &config.locked {
        rows.push((format!("{key}.lock"), reason.clone(), "locked".into()));
    }
    rows
}

fn flag(value: bool) -> String {
    if value { "true".into() } else { "false".into() }
}

pub fn persist(path: &Path, updates: &[(&str, String)]) -> io::Result<()> {
    if crate::filesystem_sandbox::session_only_write(path) {
        return Err(io::Error::new(
            ErrorKind::PermissionDenied,
            "sandbox kept this change for the session; the protected config file was not written",
        ));
    }
    let existing = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    let mut body = existing;
    for (key, value) in updates {
        body = upsert_toml(&body, key, value);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("toml.tmp");
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(body.as_bytes())?;
        if !body.ends_with('\n') {
            file.write_all(b"\n")?;
        }
        file.flush()?;
    }
    fs::rename(&tmp, path).or_else(|_| {
        fs::copy(&tmp, path)?;
        fs::remove_file(&tmp)
    })
}

pub fn upsert_toml(existing: &str, key: &str, value: &str) -> String {
    let (section, field) = split_key(key);
    let mut lines: Vec<String> = Vec::new();
    let mut in_section = false;
    let mut saw_section = false;
    let mut wrote = false;
    let target = format!("[{section}]");
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case(&target) {
            if in_section && !wrote {
                lines.push(format!("{field} = {value}"));
                wrote = true;
            }
            in_section = true;
            saw_section = true;
            lines.push(line.to_string());
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if in_section && !wrote {
                lines.push(format!("{field} = {value}"));
                wrote = true;
            }
            in_section = false;
        }
        if in_section && trimmed.starts_with(field) && trimmed.contains('=') {
            let prefix = trimmed.split('=').next().unwrap_or(field).trim();
            if prefix == field {
                lines.push(format!("{field} = {value}"));
                wrote = true;
                continue;
            }
        }
        lines.push(line.to_string());
    }
    if !saw_section {
        if !lines.is_empty() && !lines.last().is_some_and(|line| line.is_empty()) {
            lines.push(String::new());
        }
        lines.push(format!("[{section}]"));
        lines.push(format!("{field} = {value}"));
    } else if in_section && !wrote {
        lines.push(format!("{field} = {value}"));
    }
    lines.join("\n")
}

fn split_key(key: &str) -> (&str, &str) {
    if let Some((section, field)) = key.rsplit_once('.') {
        (section, field)
    } else {
        ("ui", key)
    }
}

pub fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn toml_bool(value: bool) -> String {
    if value { "true".into() } else { "false".into() }
}

pub fn apply_setting(
    config: &mut AppearanceConfig,
    key: &str,
    value: &str,
) -> Result<String, String> {
    if let Some(reason) = config.lock_reason(key) {
        return Err(format!("{key} is locked ({reason})"));
    }
    match key {
        "ui.theme" => {
            let kind =
                ThemeKind::from_name_gated(value, config.terminal_theme).ok_or_else(|| {
                    format!(
                        "Unknown theme: {value}. Available: auto, {}",
                        ThemeKind::available(config.color_level, config.terminal_theme)
                            .iter()
                            .map(|kind| kind.display_name())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                })?;
            config.theme = kind;
            Ok(toml_string(kind.display_name()))
        }
        "ui.auto_dark_theme" => {
            let kind = ThemeKind::from_name_gated(value, config.terminal_theme)
                .filter(|kind| !kind.is_auto())
                .ok_or_else(|| format!("invalid auto_dark_theme {value}"))?;
            config.auto_dark_theme = kind;
            Ok(toml_string(kind.display_name()))
        }
        "ui.auto_light_theme" => {
            let kind = ThemeKind::from_name_gated(value, config.terminal_theme)
                .filter(|kind| !kind.is_auto())
                .ok_or_else(|| format!("invalid auto_light_theme {value}"))?;
            config.auto_light_theme = kind;
            Ok(toml_string(kind.display_name()))
        }
        "ui.compact_mode" => {
            config.compact_mode = parse_bool(value)?;
            Ok(toml_bool(config.compact_mode))
        }
        "ui.show_timestamps" => {
            config.show_timestamps = parse_bool(value)?;
            Ok(toml_bool(config.show_timestamps))
        }
        "ui.confirm_before_rewind" => {
            config.confirm_before_rewind = parse_bool(value)?;
            Ok(toml_bool(config.confirm_before_rewind))
        }
        "ui.screen_mode" => {
            config.screen_mode = ScreenMode::parse(value)?;
            Ok(toml_string(config.screen_mode.as_str()))
        }
        "ui.status_line.type" => {
            config.status_line.kind = StatusLineKind::parse(value)
                .ok_or_else(|| format!("invalid status line type {value}"))?;
            Ok(toml_string(config.status_line.kind.as_str()))
        }
        "ui.status_line.command" => {
            let command = value.trim();
            config.status_line.command = if command.is_empty() {
                None
            } else {
                Some(command.to_string())
            };
            Ok(toml_string(command))
        }
        "ui.status_line.items" => {
            let items: Vec<_> = value
                .split([',', ' '])
                .filter_map(StatusLineItem::parse)
                .collect();
            if items.is_empty() {
                return Err("status line items must include cwd, model, context, cost, turn-timer, or session-name".into());
            }
            config.status_line.items = items;
            Ok(format!(
                "[{}]",
                config
                    .status_line
                    .items
                    .iter()
                    .map(|item| toml_string(item.as_str()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        }
        "ui.status_line.refresh_interval" => {
            if value.trim().is_empty() {
                config.status_line.refresh_interval = None;
                return Ok("0".into());
            }
            let secs: u64 = value
                .parse()
                .map_err(|_| "refresh_interval must be 1..=86400".to_string())?;
            if !(1..=86_400).contains(&secs) {
                return Err("refresh_interval must be 1..=86400".into());
            }
            config.status_line.refresh_interval = Some(secs);
            Ok(secs.to_string())
        }
        _ => Err(format!("{key} is not a live setting in this preview")),
    }
}

fn parse_bool(value: &str) -> Result<bool, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(format!("expected boolean, got {value}")),
    }
}

pub fn slash(text: &str) -> Option<AppearanceSlash> {
    let trimmed = text.trim();
    if !trimmed.starts_with('/') {
        return None;
    }
    let rest = trimmed.trim_start_matches('/');
    let (name, args) = rest
        .split_once(char::is_whitespace)
        .map(|(name, args)| (name, args.trim()))
        .unwrap_or((rest, ""));
    match name {
        "theme" | "t" => Some(AppearanceSlash::Theme(args.to_string())),
        "settings" | "config" | "preferences" | "prefs" => Some(AppearanceSlash::Settings),
        "compact-mode" => Some(AppearanceSlash::ToggleCompact),
        "timestamps" => Some(AppearanceSlash::ToggleTimestamps),
        "help" => Some(AppearanceSlash::Help),
        "docs" | "howto" | "guides" | "tutorial" | "tour" | "onboarding" | "debug"
        | "scroll-debug" | "announcements" | "gboom" => Some(AppearanceSlash::Unavailable(
            format!("/{name} is not available in this isolated preview yet."),
        )),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppearanceSlash {
    Theme(String),
    Settings,
    ToggleCompact,
    ToggleTimestamps,
    Help,
    Unavailable(String),
}

pub fn minimal_theme_refuse() -> &'static str {
    "/theme isn't available in minimal mode (minimal renders with your terminal's own palette). Run /fullscreen to switch this session."
}

pub fn inspect_json_fragment(config: &AppearanceConfig, screen: ScreenMode) -> JsonValue {
    json!({
        "theme": config.theme.display_name(),
        "resolvedTheme": config.resolved_kind(screen).display_name(),
        "compactMode": config.compact_mode,
        "showTimestamps": config.show_timestamps,
        "statusLine": config.status_line.kind.as_str(),
        "terminalTheme": config.terminal_theme,
        "colorLevel": format!("{:?}", config.color_level).to_ascii_lowercase(),
        "locked": config.locked,
    })
}

fn bool_from(table: &TomlValue, path: &[&str]) -> Option<bool> {
    bool_from_value(toml_path(table, path))
}

fn toml_path<'a>(table: &'a TomlValue, path: &[&str]) -> Option<&'a TomlValue> {
    let mut current = table;
    for part in path {
        current = current.get(*part)?;
    }
    Some(current)
}

fn bool_from_value(value: Option<&TomlValue>) -> Option<bool> {
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

fn env_bool(value: Option<&String>) -> Option<bool> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" | "enabled" => Some(true),
        "0" | "false" | "no" | "off" | "disabled" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(body: &str) -> TomlValue {
        toml::from_str(body).unwrap()
    }

    #[test]
    fn theme_env_locks_and_minimal_ignores_fullscreen_theme() {
        let mut sources = BTreeMap::new();
        let mut warnings = Vec::new();
        let env = BTreeMap::from([("GROK_THEME".into(), "tokyonight".into())]);
        let loaded = load(
            None,
            Some(&table("[ui]\ntheme = \"grokday\"\n")),
            None,
            &env,
            None,
            &mut sources,
            &mut warnings,
        );
        assert_eq!(loaded.theme, ThemeKind::TokyoNight);
        assert_eq!(loaded.source("ui.theme"), "environment");
        assert!(loaded.is_locked("ui.theme"));
        let theme = loaded.resolved_theme(ScreenMode::Minimal);
        assert!(theme.is_bandless());
        assert_eq!(
            loaded.resolved_kind(ScreenMode::Minimal),
            ThemeKind::Terminal
        );
    }

    #[test]
    fn workspace_cannot_install_a_status_line_command() {
        let mut sources = BTreeMap::new();
        let mut warnings = Vec::new();
        let user = table("[ui.status_line]\ntype = \"builtin\"\n");
        let workspace = table("[ui.status_line]\ntype = \"command\"\ncommand = \"./evil.sh\"\n");
        let loaded = load(
            None,
            Some(&user),
            None,
            &BTreeMap::new(),
            Some(&workspace),
            &mut sources,
            &mut warnings,
        );
        assert_eq!(loaded.status_line.kind, StatusLineKind::Builtin);
        assert!(warnings.iter().any(|item| item.contains("repository")));
    }

    #[test]
    fn requirements_lock_theme_and_status_line() {
        let mut sources = BTreeMap::new();
        let mut warnings = Vec::new();
        let req = table("[ui]\ntheme = \"groknight\"\n[ui.status_line]\ntype = \"disabled\"\n");
        let loaded = load(
            None,
            Some(&table("[ui]\ntheme = \"grokday\"\n")),
            Some(&req),
            &BTreeMap::new(),
            None,
            &mut sources,
            &mut warnings,
        );
        assert_eq!(loaded.theme, ThemeKind::GrokNight);
        assert_eq!(loaded.lock_reason("ui.theme"), Some("requirements"));
        assert!(loaded.is_locked("ui.status_line.type"));
        let err = apply_setting(&mut loaded.clone(), "ui.theme", "grokday").unwrap_err();
        assert!(err.contains("locked"));
    }

    #[test]
    fn persist_theme_keeps_unrelated_keys() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "[ui]\nscreen_mode = \"minimal\"\nother = 1\n").unwrap();
        persist(&path, &[("ui.theme", toml_string("tokyonight"))]).unwrap();
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.contains("screen_mode = \"minimal\""));
        assert!(body.contains("other = 1"));
        assert!(body.contains("theme = \"tokyonight\""));
    }

    #[test]
    fn settings_catalog_hides_theme_in_minimal() {
        let config = AppearanceConfig::default();
        let full = settings_rows(&config, ScreenMode::Fullscreen);
        assert!(full.iter().any(|row| row.key == "ui.theme"));
        let mini = settings_rows(&config, ScreenMode::Minimal);
        assert!(!mini.iter().any(|row| row.key == "ui.theme"));
        assert!(mini.iter().any(|row| row.key == "ui.compact_mode"));
    }

    #[test]
    fn slash_aliases_and_unavailable_are_honest() {
        assert_eq!(slash("/config"), Some(AppearanceSlash::Settings));
        assert_eq!(
            slash("/t tokyonight"),
            Some(AppearanceSlash::Theme("tokyonight".into()))
        );
        assert!(matches!(
            slash("/tutorial"),
            Some(AppearanceSlash::Unavailable(_))
        ));
        assert_eq!(slash("/model"), None);
    }

    #[test]
    fn toggling_confirm_before_rewind_updates_live_appearance() {
        let mut config = AppearanceConfig::default();
        assert!(config.confirm_before_rewind);
        let encoded = apply_setting(&mut config, "ui.confirm_before_rewind", "false").unwrap();
        assert_eq!(encoded, "false");
        assert!(!config.confirm_before_rewind);
        let rows = settings_rows(&config, ScreenMode::Fullscreen);
        let row = rows
            .iter()
            .find(|row| row.key == "ui.confirm_before_rewind")
            .unwrap();
        assert_eq!(row.value, "off");
    }

    #[test]
    fn disabled_status_line_is_default_and_aliases_parse() {
        assert_eq!(StatusLineKind::parse("off"), Some(StatusLineKind::Disabled));
        assert_eq!(
            StatusLineKind::parse("hidden"),
            Some(StatusLineKind::Disabled)
        );
        let mut sources = BTreeMap::new();
        let mut warnings = Vec::new();
        let loaded = load(
            None,
            Some(&table("")),
            None,
            &BTreeMap::new(),
            None,
            &mut sources,
            &mut warnings,
        );
        assert_eq!(loaded.status_line.kind, StatusLineKind::Disabled);
    }
}
