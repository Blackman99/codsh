use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoredTool {
    pub id: String,
    pub title: String,
    pub status: String,
    pub diff: String,
    pub result: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoredCompaction {
    pub items: Option<u64>,
    pub tokens: Option<u64>,
    pub provider: String,
    pub model: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoredTurn {
    pub user: String,
    pub thought: String,
    pub answer: String,
    pub tools: Vec<RestoredTool>,
    pub error: Option<String>,
    pub cancelled: bool,
    pub interrupted: bool,
    pub compacted: bool,
    pub compaction: Option<RestoredCompaction>,
}

#[derive(Debug)]
pub struct HistoryError {
    pub message: String,
    pub damaged: bool,
}

impl std::fmt::Display for HistoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for HistoryError {}

pub fn helper_path() -> PathBuf {
    if let Some(path) = std::env::var_os("CODSH_SESSION_READ") {
        return PathBuf::from(path);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../packages/cli/bin/rust-acp-session-read.mjs")
}

pub fn project_turns(value: &Value) -> Result<Vec<RestoredTurn>, HistoryError> {
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        let message = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("failed to read dsh session")
            .to_string();
        return Err(HistoryError {
            damaged: message.contains("damaged") || message.contains("corrupt"),
            message,
        });
    }
    let Some(items) = value.get("turns").and_then(Value::as_array) else {
        return Err(HistoryError {
            message: "dsh session projection omitted turns".into(),
            damaged: true,
        });
    };
    let mut turns = Vec::new();
    for item in items {
        let tools = item
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|tool| RestoredTool {
                id: tool
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                title: tool
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string(),
                status: tool
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                diff: tool
                    .get("diff")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                result: tool
                    .get("result")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
            .collect();
        turns.push(RestoredTurn {
            user: item
                .get("user")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            thought: item
                .get("thought")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            answer: item
                .get("answer")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            tools,
            error: item
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string),
            cancelled: item
                .get("cancelled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            interrupted: item
                .get("interrupted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            compacted: item
                .get("compacted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            compaction: item.get("compaction").and_then(|value| {
                if value.is_null() {
                    None
                } else {
                    Some(RestoredCompaction {
                        items: value.get("items").and_then(Value::as_u64),
                        tokens: value.get("tokens").and_then(Value::as_u64),
                        provider: value
                            .get("provider")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        model: value
                            .get("model")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        error: value
                            .get("error")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                }
            }),
        });
    }
    Ok(turns)
}

pub fn load_turns(dsh_home: &Path, session_id: &str) -> Result<Vec<RestoredTurn>, HistoryError> {
    let node = std::env::var_os("CODSH_NODE").unwrap_or_else(|| "node".into());
    let helper = helper_path();
    let output = Command::new(node)
        .arg(&helper)
        .arg("--session-id")
        .arg(session_id)
        .env("DSH_HOME", dsh_home)
        .output()
        .map_err(|error| HistoryError {
            message: format!("cannot read dsh session: {error}"),
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
                "cannot read dsh session".into()
            } else {
                message
            },
        });
    }
    project_turns(&value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn projects_interrupted_unknown_tools() {
        let value = json!({
            "ok": true,
            "sessionId": "s1",
            "turns": [{
                "user": "edit the note",
                "thought": "",
                "answer": "",
                "tools": [{
                    "id": "t1",
                    "title": "edit",
                    "status": "unknown",
                    "diff": "edit note.txt",
                    "result": "The tool call was interrupted after it was recorded, but no result was durably recorded."
                }],
                "error": null,
                "cancelled": false,
                "interrupted": true,
                "compacted": false,
                "compaction": null
            }]
        });
        let turns = project_turns(&value).expect("turns");
        assert_eq!(turns[0].user, "edit the note");
        assert!(!turns[0].compacted);
        assert!(turns[0].interrupted);
        assert_eq!(turns[0].tools[0].status, "unknown");
        assert_ne!(turns[0].tools[0].status, "pending");
        assert!(turns[0].tools[0].result.contains("interrupted"));
    }

    #[test]
    fn projects_compaction_checkpoint_without_claiming_success_on_failure() {
        let value = json!({
            "ok": true,
            "sessionId": "s1",
            "turns": [{
                "user": "compaction summary",
                "thought": "",
                "answer": "MOCK_COMPACTION_SUMMARY",
                "tools": [],
                "error": null,
                "cancelled": false,
                "interrupted": false,
                "compacted": true,
                "compaction": {
                    "items": 4,
                    "tokens": 210,
                    "provider": "cli-mock",
                    "model": "cli-mock",
                    "error": null
                }
            }]
        });
        let turns = project_turns(&value).expect("turns");
        assert!(turns[0].compacted);
        assert_eq!(turns[0].compaction.as_ref().unwrap().provider, "cli-mock");
        let failed = json!({
            "ok": true,
            "turns": [{
                "user": "still here",
                "thought": "",
                "answer": "original",
                "tools": [{
                    "id": "todo-1",
                    "title": "todo_write",
                    "status": "completed",
                    "diff": "todo",
                    "result": "TODO_KEEP"
                }],
                "error": null,
                "cancelled": false,
                "interrupted": false,
                "compacted": false,
                "compaction": { "error": "summarizer failed" }
            }]
        });
        let restored = project_turns(&failed).expect("failed compact");
        assert_eq!(restored[0].user, "still here");
        assert_eq!(restored[0].tools[0].result, "TODO_KEEP");
        assert!(
            restored[0]
                .compaction
                .as_ref()
                .unwrap()
                .error
                .as_deref()
                .unwrap()
                .contains("summarizer failed")
        );
    }

    #[test]
    fn damaged_source_is_refused() {
        let error = project_turns(&json!({ "ok": false, "error": "source data is damaged: torn" }))
            .expect_err("damaged");
        assert!(error.damaged);
        assert!(error.message.contains("damaged"));
    }
}
