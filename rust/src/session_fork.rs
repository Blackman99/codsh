use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::session_history::{HistoryError, RestoredTurn, project_turns};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindPoint {
    pub turn: u32,
    pub summary: String,
    pub boundary: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkResult {
    pub session_id: String,
    pub parent_session: String,
    pub inherited_event_count: u64,
    pub turns: Vec<RestoredTurn>,
    pub files_restored: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiPrefs {
    pub confirm_before_rewind: bool,
    pub fork_secondary_model: Option<String>,
}

impl Default for UiPrefs {
    fn default() -> Self {
        Self {
            confirm_before_rewind: true,
            fork_secondary_model: None,
        }
    }
}

pub fn helper_path() -> PathBuf {
    if let Some(path) = std::env::var_os("CODSH_SESSION_FORK") {
        return PathBuf::from(path);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../packages/cli/bin/rust-acp-session-fork.mjs")
}

pub fn config_path(home: &Path) -> PathBuf {
    home.join("config.toml")
}

pub fn load_prefs(home: &Path) -> UiPrefs {
    let Ok(body) = std::fs::read_to_string(config_path(home)) else {
        return UiPrefs::default();
    };
    parse_prefs(&body)
}

pub fn parse_prefs(body: &str) -> UiPrefs {
    let mut prefs = UiPrefs::default();
    let mut in_ui = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') {
            in_ui = trimmed.eq_ignore_ascii_case("[ui]");
            continue;
        }
        if !in_ui {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if key == "confirm_before_rewind" {
            prefs.confirm_before_rewind = !matches!(value, "false" | "0" | "no");
        } else if key == "fork_secondary_model" && !value.is_empty() {
            prefs.fork_secondary_model = Some(value.to_string());
        }
    }
    prefs
}

pub fn save_confirm_before_rewind(home: &Path, enabled: bool) -> std::io::Result<()> {
    let path = config_path(home);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    let mut in_ui = false;
    let mut wrote = false;
    let mut has_ui = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("[ui]") {
            in_ui = true;
            has_ui = true;
            lines.push(line.to_string());
            continue;
        }
        if trimmed.starts_with('[') {
            if in_ui && !wrote {
                lines.push(format!("confirm_before_rewind = {enabled}"));
                wrote = true;
            }
            in_ui = false;
        }
        if in_ui && trimmed.starts_with("confirm_before_rewind") {
            lines.push(format!("confirm_before_rewind = {enabled}"));
            wrote = true;
            continue;
        }
        lines.push(line.to_string());
    }
    if !has_ui {
        if !lines.is_empty() && !lines.last().is_some_and(|line| line.is_empty()) {
            lines.push(String::new());
        }
        lines.push("[ui]".into());
        lines.push(format!("confirm_before_rewind = {enabled}"));
    } else if in_ui && !wrote {
        lines.push(format!("confirm_before_rewind = {enabled}"));
    }
    std::fs::write(path, format!("{}\n", lines.join("\n")))
}

pub fn project_points(value: &Value) -> Result<Vec<RewindPoint>, HistoryError> {
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        let message = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("failed to list rewind points")
            .to_string();
        return Err(HistoryError {
            damaged: message.contains("damaged") || message.contains("corrupt"),
            message,
        });
    }
    let Some(items) = value.get("rewindPoints").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    Ok(items
        .iter()
        .filter_map(|item| {
            Some(RewindPoint {
                turn: item.get("turn").and_then(Value::as_u64)? as u32,
                summary: item
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                boundary: item.get("boundary").and_then(Value::as_u64)?,
            })
        })
        .collect())
}

fn run_helper(dsh_home: &Path, args: &[&str]) -> Result<Value, HistoryError> {
    let node = std::env::var_os("CODSH_NODE").unwrap_or_else(|| "node".into());
    let output = Command::new(node)
        .arg(helper_path())
        .args(args)
        .env("DSH_HOME", dsh_home)
        .output()
        .map_err(|error| HistoryError {
            message: format!("cannot fork dsh session: {error}"),
            damaged: false,
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: Value =
        serde_json::from_str(stdout.lines().last().unwrap_or("{}")).unwrap_or(Value::Null);
    if !output.status.success() {
        let message = value
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_string());
        return Err(HistoryError {
            damaged: output.status.code() == Some(2) || message.contains("damaged"),
            message: if message.is_empty() {
                "cannot fork dsh session".into()
            } else {
                message
            },
        });
    }
    Ok(value)
}

pub fn list_points(dsh_home: &Path, session_id: &str) -> Result<Vec<RewindPoint>, HistoryError> {
    project_points(&run_helper(
        dsh_home,
        &["--session-id", session_id, "--list"],
    )?)
}

pub fn fork_conversation(
    dsh_home: &Path,
    session_id: &str,
    boundary: Option<u64>,
    child_id: Option<&str>,
) -> Result<ForkResult, HistoryError> {
    let mut args = vec!["--session-id".to_string(), session_id.to_string()];
    let boundary_text = boundary.map(|value| value.to_string());
    if let Some(value) = boundary_text.as_deref() {
        args.push("--boundary".into());
        args.push(value.to_string());
    }
    if let Some(id) = child_id {
        args.push("--child-id".into());
        args.push(id.to_string());
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let value = run_helper(dsh_home, &argv)?;
    let session = value
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| HistoryError {
            message: "fork omitted session id".into(),
            damaged: false,
        })?;
    let parent = value
        .get("parentSession")
        .and_then(Value::as_str)
        .unwrap_or(session_id);
    Ok(ForkResult {
        session_id: session.to_string(),
        parent_session: parent.to_string(),
        inherited_event_count: value
            .get("inheritedEventCount")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        turns: project_turns(&value)?,
        files_restored: value
            .get("filesRestored")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

pub fn restore_code_error() -> String {
    "Conversation rewind/fork does not restore files; --restore-code is unavailable on the dsh execution core (no repository snapshot).".into()
}

pub fn worktree_error() -> String {
    "Isolated directory / worktree fork is not part of this slice; omit --worktree.".into()
}

pub fn running_turn_error() -> String {
    "a turn is running — interrupt it before rewinding".into()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkSlash {
    pub directive: Option<String>,
}

pub fn is_conversation_slash(trimmed: &str) -> bool {
    trimmed == "/rewind"
        || trimmed == "/undo"
        || trimmed == "/fork"
        || trimmed.starts_with("/rewind ")
        || trimmed.starts_with("/undo ")
        || trimmed.starts_with("/fork ")
}

pub fn parse_fork_slash(trimmed: &str) -> Result<ForkSlash, String> {
    let rest = trimmed
        .strip_prefix("/fork")
        .ok_or_else(|| "not a /fork command".to_string())?
        .trim();
    let mut directive = Vec::new();
    for token in rest.split_whitespace() {
        if token == "--worktree" {
            return Err(worktree_error());
        }
        if token == "--no-worktree" {
            continue;
        }
        directive.push(token);
    }
    Ok(ForkSlash {
        directive: if directive.is_empty() {
            None
        } else {
            Some(directive.join(" "))
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_fork_slash_treats_no_worktree_as_conversation_copy() {
        assert_eq!(
            parse_fork_slash("/fork").unwrap(),
            ForkSlash { directive: None }
        );
        assert_eq!(
            parse_fork_slash("/fork --no-worktree").unwrap(),
            ForkSlash { directive: None }
        );
        assert_eq!(
            parse_fork_slash("/fork --no-worktree keep going").unwrap(),
            ForkSlash {
                directive: Some("keep going".into())
            }
        );
        let err = parse_fork_slash("/fork --worktree").unwrap_err();
        assert!(err.contains("omit --worktree"));
        let err = parse_fork_slash("/fork --no-worktree --worktree later").unwrap_err();
        assert!(err.contains("omit --worktree"));
        assert!(is_conversation_slash("/rewind 2"));
        assert!(is_conversation_slash("/fork --no-worktree"));
        assert!(!is_conversation_slash("/help"));
    }

    #[test]
    fn parse_confirm_and_fork_model_prefs() {
        let prefs = parse_prefs(
            "[ui]\nconfirm_before_rewind = false\nfork_secondary_model = \"cli-mock-fork\"\n",
        );
        assert!(!prefs.confirm_before_rewind);
        assert_eq!(prefs.fork_secondary_model.as_deref(), Some("cli-mock-fork"));
        assert!(parse_prefs("").confirm_before_rewind);
    }

    #[test]
    fn grok_home_config_toml_is_the_user_pref_file() {
        let root = std::env::temp_dir().join(format!(
            "codsh-fork-prefs-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let home = root.join("home");
        let grok = home.join(".grok");
        std::fs::create_dir_all(&grok).unwrap();
        std::fs::write(
            home.join("config.toml"),
            "[ui]\nconfirm_before_rewind = true\nfork_secondary_model = \"wrong-home\"\n",
        )
        .unwrap();
        std::fs::write(
            grok.join("config.toml"),
            "[ui]\nscreen_mode = \"fullscreen\"\nconfirm_before_rewind = false\nfork_secondary_model = \"cli-mock-fork\"\n",
        )
        .unwrap();
        let prefs = load_prefs(&grok);
        assert!(!prefs.confirm_before_rewind);
        assert_eq!(prefs.fork_secondary_model.as_deref(), Some("cli-mock-fork"));
        save_confirm_before_rewind(&grok, false).unwrap();
        let grok_body = std::fs::read_to_string(grok.join("config.toml")).unwrap();
        assert!(grok_body.contains("confirm_before_rewind = false"));
        assert!(grok_body.contains("screen_mode = \"fullscreen\""));
        assert!(grok_body.contains("fork_secondary_model = \"cli-mock-fork\""));
        let home_body = std::fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(home_body.contains("confirm_before_rewind = true"));
        assert!(home_body.contains("wrong-home"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn projects_rewind_points_and_fork_result() {
        let value = json!({
            "ok": true,
            "sessionId": "child",
            "parentSession": "parent",
            "isSeeded": true,
            "inheritedEventCount": 4,
            "filesRestored": false,
            "rewindPoints": [
                {"turn": 1, "summary": "first", "boundary": 4},
                {"turn": 2, "summary": "second", "boundary": 8}
            ],
            "turns": [{
                "user": "first",
                "thought": "",
                "answer": "ok",
                "tools": [],
                "error": null,
                "cancelled": false,
                "interrupted": false
            }]
        });
        let points = project_points(&value).expect("points");
        assert_eq!(points[0].summary, "first");
        assert_eq!(points[1].boundary, 8);
        let turns = project_turns(&value).expect("turns");
        assert_eq!(turns[0].user, "first");
        assert!(!value["filesRestored"].as_bool().unwrap());
    }
}
