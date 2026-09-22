use std::fs;
use std::path::{Path, PathBuf};

pub const GROK_SCREEN_MODE_ENV: &str = "GROK_SCREEN_MODE";
pub const SCREEN_MODE_SWITCH_ENV: &str = "GROK_SCREEN_MODE_SWITCH";
pub const MINIMAL_OVERLAY_HEIGHT: u16 = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenMode {
    Fullscreen,
    Minimal,
}

impl ScreenMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fullscreen => "fullscreen",
            Self::Minimal => "minimal",
        }
    }

    pub fn cli_flag(self) -> &'static str {
        match self {
            Self::Fullscreen => "--fullscreen",
            Self::Minimal => "--minimal",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim() {
            "fullscreen" | "full" => Ok(Self::Fullscreen),
            "minimal" => Ok(Self::Minimal),
            other => Err(format!(
                "invalid ui.screen_mode {other:?}: expected fullscreen or minimal"
            )),
        }
    }

    pub fn switch_marker(self) -> &'static str {
        match self {
            Self::Minimal => "Switched to minimal. /fullscreen returns to fullscreen.",
            Self::Fullscreen => "Switched to fullscreen. /minimal returns to minimal.",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwitchPolicy {
    InPlace,
    Exec,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlashAction {
    Switch(ScreenMode),
    Refuse(&'static str),
}

pub fn switch_policy_from_env(value: Option<&str>) -> SwitchPolicy {
    match value.map(str::trim) {
        Some("exec") => SwitchPolicy::Exec,
        _ => SwitchPolicy::InPlace,
    }
}

pub fn config_path(home: &Path) -> PathBuf {
    home.join(".grok/config.toml")
}

pub fn read_persisted_mode(home: &Path) -> Result<Option<ScreenMode>, String> {
    let path = config_path(home);
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(None);
    };
    parse_persisted_mode(&text)
}

pub fn parse_persisted_mode(text: &str) -> Result<Option<ScreenMode>, String> {
    let mut section = String::new();
    let mut found = None;
    for raw in text.lines() {
        let line = strip_comment(raw).trim();
        if line.is_empty() {
            continue;
        }
        if let Some(name) = section_name(line) {
            section = name;
            continue;
        }
        let Some((key, value)) = split_key_value(line) else {
            continue;
        };
        if section == "ui" && key == "screen_mode" {
            found = Some(ScreenMode::parse(&unquote(value))?);
        }
    }
    Ok(found)
}

pub fn resolve_mode(
    cli: Option<ScreenMode>,
    env: Option<&str>,
    persisted: Option<ScreenMode>,
) -> Result<ScreenMode, String> {
    if let Some(mode) = cli {
        return Ok(mode);
    }
    if let Some(value) = env.map(str::trim).filter(|value| !value.is_empty()) {
        return ScreenMode::parse(value)
            .map_err(|error| error.replacen("ui.screen_mode", "GROK_SCREEN_MODE", 1));
    }
    Ok(persisted.unwrap_or(ScreenMode::Fullscreen))
}

pub fn slash_action(text: &str) -> Option<SlashAction> {
    let trimmed = text.trim();
    if !trimmed.starts_with('/') {
        return None;
    }
    let command = trimmed
        .trim_start_matches('/')
        .split_whitespace()
        .next()
        .unwrap_or("");
    match command {
        "minimal" => Some(SlashAction::Switch(ScreenMode::Minimal)),
        "fullscreen" | "full" => Some(SlashAction::Switch(ScreenMode::Fullscreen)),
        "find" => Some(SlashAction::Refuse(
            "/find isn't available in minimal mode (search overlay needs fullscreen). Run /fullscreen to switch this session.",
        )),
        "jump" => Some(SlashAction::Refuse(
            "/jump isn't available in minimal mode (turn navigation needs fullscreen). Run /fullscreen to switch this session.",
        )),
        "timeline" => Some(SlashAction::Refuse(
            "/timeline isn't available in minimal mode (the timeline sidebar needs fullscreen). Run /fullscreen to switch this session.",
        )),
        "tutorial" => Some(SlashAction::Refuse(
            "/tutorial isn't available in minimal mode (the tutorial overlay needs fullscreen). Run /fullscreen to switch this session.",
        )),
        "tour" => Some(SlashAction::Refuse(
            "/tour isn't available in minimal mode (the tutorial overlay needs fullscreen). Run /fullscreen to switch this session.",
        )),
        "onboarding" => Some(SlashAction::Refuse(
            "/onboarding isn't available in minimal mode (the tutorial overlay needs fullscreen). Run /fullscreen to switch this session.",
        )),
        "dashboard" | "agents-dashboard" | "sessions" => {
            Some(SlashAction::Refuse(dashboard_refusal(command)))
        }
        "expand" => Some(SlashAction::Refuse(
            "/expand isn't available in fullscreen mode: press Tab to focus the scrollback, then → on the block.",
        )),
        _ => None,
    }
}

pub fn mode_command_message(mode: ScreenMode, action: SlashAction) -> Option<String> {
    match action {
        SlashAction::Switch(target) if target == mode => {
            Some(format!("Already in {} mode.", mode.as_str()))
        }
        SlashAction::Switch(_) => None,
        SlashAction::Refuse(message) => {
            let fullscreen_only = message.contains("Run /fullscreen");
            let minimal_only = message.contains("fullscreen mode:");
            if (fullscreen_only && mode == ScreenMode::Minimal)
                || (minimal_only && mode == ScreenMode::Fullscreen)
            {
                Some(message.to_string())
            } else if fullscreen_only {
                Some(format!(
                    "{} is already available in fullscreen.",
                    message.split(' ').next().unwrap_or("/command")
                ))
            } else {
                Some(format!(
                    "{} is already available in minimal.",
                    message.split(' ').next().unwrap_or("/command")
                ))
            }
        }
    }
}

pub fn exec_args(session_id: &str, target: ScreenMode) -> Vec<String> {
    vec![
        "--resume".into(),
        session_id.into(),
        target.cli_flag().into(),
    ]
}

pub fn exec_failure_message(session_id: Option<&str>, target: ScreenMode, error: &str) -> String {
    match session_id {
        Some(id) => format!(
            "Screen-mode relaunch failed: {error}. Resume with: codsh --rust --resume {id} {}. Draft was not saved across exec.",
            target.cli_flag()
        ),
        None => format!(
            "Screen-mode relaunch needs a session. Resume with: codsh --rust {} --resume <id> after a session exists. Draft was not saved across exec.",
            target.cli_flag()
        ),
    }
}

fn dashboard_refusal(command: &str) -> &'static str {
    match command {
        "agents-dashboard" => {
            "/agents-dashboard isn't available in minimal mode (minimal is single-session). Run /fullscreen to switch this session."
        }
        "sessions" => {
            "/sessions isn't available in minimal mode (minimal is single-session). Run /fullscreen to switch this session."
        }
        _ => {
            "/dashboard isn't available in minimal mode (minimal is single-session). Run /fullscreen to switch this session."
        }
    }
}

fn strip_comment(line: &str) -> &str {
    let mut in_string = None;
    for (index, character) in line.char_indices() {
        match (in_string, character) {
            (None, '#') => return &line[..index],
            (None, '"' | '\'') => in_string = Some(character),
            (Some(quote), character) if character == quote => in_string = None,
            _ => {}
        }
    }
    line
}

fn section_name(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        Some(trimmed[1..trimmed.len() - 1].trim().to_string())
    } else {
        None
    }
}

fn split_key_value(line: &str) -> Option<(&str, &str)> {
    let (key, value) = line.split_once('=')?;
    Some((key.trim(), value.trim()))
}

fn unquote(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        value[1..value.len() - 1].to_string()
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_home() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("codsh-screen-{stamp}-{}", std::process::id()));
        fs::create_dir_all(path.join(".grok")).unwrap();
        path
    }

    #[test]
    fn persisted_default_is_session_overridable_and_not_implied_by_cli() {
        let text = "[ui]\nscreen_mode = \"minimal\"\n";
        assert_eq!(
            parse_persisted_mode(text).unwrap(),
            Some(ScreenMode::Minimal)
        );
        assert_eq!(
            resolve_mode(
                Some(ScreenMode::Fullscreen),
                None,
                Some(ScreenMode::Minimal)
            )
            .unwrap(),
            ScreenMode::Fullscreen
        );
        assert_eq!(
            resolve_mode(None, Some("minimal"), Some(ScreenMode::Fullscreen)).unwrap(),
            ScreenMode::Minimal
        );
        assert_eq!(
            resolve_mode(None, None, None).unwrap(),
            ScreenMode::Fullscreen
        );
    }

    #[test]
    fn invalid_persisted_and_env_values_are_explicit() {
        let error = parse_persisted_mode("[ui]\nscreen_mode = \"banana\"\n").unwrap_err();
        assert!(error.contains("invalid ui.screen_mode"), "{error}");
        let error = resolve_mode(None, Some("banana"), None).unwrap_err();
        assert!(error.contains("GROK_SCREEN_MODE"), "{error}");
        let home = temp_home();
        fs::write(config_path(&home), "[ui]\nscreen_mode = true\n").unwrap();
        let error = read_persisted_mode(&home).unwrap_err();
        assert!(error.contains("invalid ui.screen_mode"), "{error}");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn slash_commands_match_reference_mode_gates() {
        assert_eq!(
            slash_action("/minimal"),
            Some(SlashAction::Switch(ScreenMode::Minimal))
        );
        assert_eq!(
            slash_action("  /full  "),
            Some(SlashAction::Switch(ScreenMode::Fullscreen))
        );
        assert_eq!(slash_action("/theme"), None);
        let dashboard = slash_action("/dashboard").unwrap();
        assert!(
            mode_command_message(ScreenMode::Minimal, dashboard)
                .unwrap()
                .contains("Run /fullscreen to switch this session.")
        );
        let expand = slash_action("/expand").unwrap();
        assert_eq!(
            mode_command_message(ScreenMode::Fullscreen, expand).as_deref(),
            Some(
                "/expand isn't available in fullscreen mode: press Tab to focus the scrollback, then → on the block."
            )
        );
        assert_eq!(
            mode_command_message(
                ScreenMode::Minimal,
                SlashAction::Switch(ScreenMode::Minimal)
            )
            .as_deref(),
            Some("Already in minimal mode.")
        );
    }

    #[test]
    fn exec_relaunch_does_not_claim_draft_survival() {
        assert_eq!(
            exec_args("sess-1", ScreenMode::Minimal),
            vec!["--resume", "sess-1", "--minimal"]
        );
        assert_eq!(switch_policy_from_env(Some("exec")), SwitchPolicy::Exec);
        assert_eq!(
            switch_policy_from_env(Some("in-place")),
            SwitchPolicy::InPlace
        );
        let message = exec_failure_message(None, ScreenMode::Minimal, "no session");
        assert!(
            message.contains("Draft was not saved across exec"),
            "{message}"
        );
        assert!(message.contains("--minimal"), "{message}");
    }

    #[test]
    fn cli_and_slash_do_not_rewrite_config_bytes() {
        let home = temp_home();
        let original = "[ui]\nscreen_mode = \"minimal\"\nother = 1\n";
        fs::write(config_path(&home), original).unwrap();
        assert_eq!(
            read_persisted_mode(&home).unwrap(),
            Some(ScreenMode::Minimal)
        );
        assert_eq!(fs::read_to_string(config_path(&home)).unwrap(), original);
        let _ = fs::remove_dir_all(home);
    }
}
