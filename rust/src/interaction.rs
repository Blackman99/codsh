//! Ticket 179: the question card (`ask_user_question`), the plan review
//! (`exit_plan_mode`), the todos pane, and plan-mode state.
//!
//! dsh owns every decision here. `packages/cli/bin/rust-acp-interaction.mjs`
//! answers dsh's `user-questions/request` waterfall by sending the questions
//! over the private control channel; this module is the pure state machine
//! and renderer for the card the user answers on. Nothing in it runs a model
//! or a tool, and no answer is ever taken from the prompt or the queue.

use crate::theme::Theme;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Clear, Paragraph, Wrap};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use unicode_width::UnicodeWidthStr;

/// Empty-plan notice in the review header.
pub const EMPTY_PLAN: &str = "No plan written yet";
/// Default `[toolset.ask_user_question] timeout_secs`.
pub const DEFAULT_TIMEOUT_SECS: u64 = 1800;

// ---------------------------------------------------------------------------
// Plan file location

const MAX_DIRNAME_BYTES: usize = 255;

/// `urlencoding::encode` form of the working directory (unreserved bytes
/// kept), or `<slug>-<sha256 hex16>` when that is longer than one path
/// component may be. The reference hashes with blake3; the long form here is
/// sha256, so a >255-byte directory name differs from the reference.
pub fn encode_cwd_dirname(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len());
    for byte in cwd.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    if out.len() <= MAX_DIRNAME_BYTES {
        return out;
    }
    let leaf = Path::new(cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("workspace");
    let mut slug = String::new();
    let mut dash = false;
    for ch in leaf.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !dash && !slug.is_empty() {
            slug.push('-');
            dash = true;
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    let slug = if slug.is_empty() { "workspace" } else { slug };
    let digest = Sha256::digest(cwd.as_bytes());
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("{slug}-{hex}")
}

/// `$GROK_HOME/sessions/<encoded cwd>`: the parent of every session's plan.
pub fn plan_root(grok_home: &Path, cwd: &Path) -> PathBuf {
    grok_home
        .join("sessions")
        .join(encode_cwd_dirname(&cwd.to_string_lossy()))
}

/// `$GROK_HOME/sessions/<encoded cwd>/<session-id>/plan.md`.
pub fn plan_file(grok_home: &Path, cwd: &Path, session_id: &str) -> PathBuf {
    plan_root(grok_home, cwd).join(session_id).join("plan.md")
}

// ---------------------------------------------------------------------------
// Settings

/// Session-scoped flags: `--no-plan`, `--no-ask-user`, `--todo-gate`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CliInteraction {
    pub no_plan: bool,
    pub no_ask_user: bool,
    pub todo_gate: bool,
}

/// Environment for the dsh plugins (`rust-acp-plan.mjs`,
/// `rust-acp-interaction.mjs`). `plan_root` is the parent of every
/// session's `plan.md` for this working directory.
pub fn dsh_env(cli: &CliInteraction, ask: &AskSettings, plan_root: &Path) -> Vec<(String, String)> {
    let flag = |on: bool| if on { "1".to_string() } else { "0".to_string() };
    vec![
        ("CODSH_NO_PLAN".into(), flag(cli.no_plan)),
        (
            "CODSH_NO_ASK_USER".into(),
            flag(cli.no_ask_user || !ask.enabled),
        ),
        ("CODSH_TODO_GATE".into(), flag(cli.todo_gate)),
        (
            "CODSH_ASK_USER_TIMEOUT_SECS".into(),
            ask.effective_timeout().to_string(),
        ),
        ("CODSH_PLAN_ROOT".into(), plan_root.display().to_string()),
    ]
}

/// `features.ask_user_question` and `[toolset.ask_user_question]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AskSettings {
    pub enabled: bool,
    pub enabled_source: String,
    pub timeout_enabled: bool,
    pub timeout_enabled_source: String,
    pub timeout_secs: u64,
    pub timeout_secs_source: String,
    pub errors: Vec<String>,
}

impl Default for AskSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            enabled_source: "default".into(),
            timeout_enabled: true,
            timeout_enabled_source: "default".into(),
            timeout_secs: DEFAULT_TIMEOUT_SECS,
            timeout_secs_source: "default".into(),
            errors: Vec::new(),
        }
    }
}

impl AskSettings {
    /// Seconds dsh waits before closing an unanswered card; 0 waits forever.
    pub fn effective_timeout(&self) -> u64 {
        if self.timeout_enabled {
            self.timeout_secs
        } else {
            0
        }
    }
}

fn walk<'a>(value: &'a toml::Value, path: &[&str]) -> Option<&'a toml::Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn env_flag(value: Option<&String>) -> Option<bool> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Guide 05/26: `features.ask_user_question` is requirements `pin`, managed
/// `user` (GROK_ASK_USER_QUESTION also sets it). The toolset keys resolve
/// requirements → env → user config → managed → default.
pub fn load_ask_settings(
    user: &toml::Value,
    env: &std::collections::BTreeMap<String, String>,
    requirements: Option<&toml::Value>,
    managed: Option<&toml::Value>,
) -> AskSettings {
    let mut out = AskSettings::default();
    let feature = ["features", "ask_user_question"];
    let bool_in = |layer: Option<&toml::Value>, path: &[&str]| -> Option<bool> {
        layer
            .and_then(|value| walk(value, path))
            .and_then(toml::Value::as_bool)
    };
    if let Some(value) = bool_in(requirements, &feature) {
        out.enabled = value;
        out.enabled_source = "requirements".into();
    } else if let Some(value) = bool_in(Some(user), &feature) {
        out.enabled = value;
        out.enabled_source = "config.toml".into();
    } else if let Some(value) = env_flag(env.get("GROK_ASK_USER_QUESTION")) {
        out.enabled = value;
        out.enabled_source = "environment".into();
    } else if let Some(value) = bool_in(managed, &feature) {
        out.enabled = value;
        out.enabled_source = "managed".into();
    }
    let enabled_path = ["toolset", "ask_user_question", "timeout_enabled"];
    if let Some(value) = bool_in(requirements, &enabled_path) {
        out.timeout_enabled = value;
        out.timeout_enabled_source = "requirements".into();
    } else if let Some(value) = env_flag(env.get("GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED")) {
        out.timeout_enabled = value;
        out.timeout_enabled_source = "environment".into();
    } else if let Some(value) = bool_in(Some(user), &enabled_path) {
        out.timeout_enabled = value;
        out.timeout_enabled_source = "config.toml".into();
    } else if let Some(value) = bool_in(managed, &enabled_path) {
        out.timeout_enabled = value;
        out.timeout_enabled_source = "managed".into();
    }
    let secs_path = ["toolset", "ask_user_question", "timeout_secs"];
    let secs_in = |layer: Option<&toml::Value>, errors: &mut Vec<String>, name: &str| {
        let value = layer.and_then(|value| walk(value, &secs_path))?;
        let parsed = value.as_integer().or_else(|| {
            value
                .as_float()
                .filter(|f| f.fract() == 0.0)
                .map(|f| f as i64)
        });
        match parsed {
            Some(secs) if secs > 0 => Some(secs as u64),
            _ => {
                errors.push(format!(
                    "{name}: toolset.ask_user_question.timeout_secs must be a positive integer; got {value}"
                ));
                None
            }
        }
    };
    let mut errors = Vec::new();
    if let Some(secs) = secs_in(requirements, &mut errors, "requirements") {
        out.timeout_secs = secs;
        out.timeout_secs_source = "requirements".into();
    } else if let Some(raw) = env
        .get("GROK_ASK_USER_QUESTION_TIMEOUT_SECS")
        .filter(|v| !v.trim().is_empty())
    {
        match raw.trim().parse::<u64>() {
            Ok(secs) if secs > 0 => {
                out.timeout_secs = secs;
                out.timeout_secs_source = "environment".into();
            }
            _ => errors.push(format!(
                "GROK_ASK_USER_QUESTION_TIMEOUT_SECS must be a positive integer; got {raw}"
            )),
        }
    }
    if out.timeout_secs_source == "default" {
        if let Some(secs) = secs_in(Some(user), &mut errors, "config.toml") {
            out.timeout_secs = secs;
            out.timeout_secs_source = "config.toml".into();
        } else if let Some(secs) = secs_in(managed, &mut errors, "managed") {
            out.timeout_secs = secs;
            out.timeout_secs_source = "managed".into();
        }
    }
    out.errors = errors;
    out
}

// ---------------------------------------------------------------------------
// Question card

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Question {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<QuestionOption>,
    pub multi: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    pub id: String,
    pub selected: Vec<String>,
    pub custom: Option<String>,
}

impl Answer {
    pub fn to_json(&self) -> Value {
        let mut value = json!({ "id": self.id, "selected": self.selected });
        if let Some(custom) = &self.custom {
            value["custom"] = json!(custom);
        }
        value
    }
}

pub fn parse_questions(value: &Value) -> Vec<Question> {
    let text = |item: &Value, key: &str| {
        item.get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id")?.as_str()?.to_string();
                    let options = item
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|options| {
                            options
                                .iter()
                                .filter_map(|option| {
                                    Some(QuestionOption {
                                        label: option.get("label")?.as_str()?.to_string(),
                                        description: text(option, "description"),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(Question {
                        id,
                        header: text(item, "header"),
                        question: text(item, "question"),
                        options,
                        multi: item
                            .get("multiSelect")
                            .or_else(|| item.get("multi_select"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CardAction {
    None,
    Submit(Vec<Answer>),
    Dismiss,
    Copy(String),
    Park,
    Hint(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuestionCard {
    pub id: String,
    pub questions: Vec<Question>,
    pub current: usize,
    /// Focused row per question; `options.len()` is the free-text row.
    pub focus: Vec<usize>,
    pub selected: Vec<BTreeSet<usize>>,
    pub custom: Vec<String>,
    pub typing: bool,
    pub parked: bool,
    pub expanded: bool,
    /// Set once an answer or dismissal is sent; later keys do nothing.
    pub sent: bool,
}

/// Row index for `1`–`9` then `a`–`f`.
fn pick_index(ch: char) -> Option<usize> {
    match ch {
        '1'..='9' => Some(ch as usize - '1' as usize),
        'a'..='f' => Some(9 + ch as usize - 'a' as usize),
        _ => None,
    }
}

impl QuestionCard {
    pub fn new(id: impl Into<String>, questions: Vec<Question>) -> Self {
        let count = questions.len();
        Self {
            id: id.into(),
            questions,
            current: 0,
            focus: vec![0; count],
            selected: vec![BTreeSet::new(); count],
            custom: vec![String::new(); count],
            typing: false,
            parked: false,
            expanded: false,
            sent: false,
        }
    }

    fn rows(&self, question: usize) -> usize {
        self.questions[question].options.len() + 1
    }

    fn free_row(&self, question: usize) -> usize {
        self.questions[question].options.len()
    }

    pub fn answered(&self, question: usize) -> bool {
        !self.selected[question].is_empty() || !self.custom[question].trim().is_empty()
    }

    pub fn answers(&self) -> Vec<Answer> {
        self.questions
            .iter()
            .enumerate()
            .map(|(index, question)| {
                let custom = self.custom[index].trim();
                Answer {
                    id: question.id.clone(),
                    selected: self.selected[index]
                        .iter()
                        .filter_map(|row| question.options.get(*row))
                        .map(|option| option.label.clone())
                        .collect(),
                    custom: (!custom.is_empty()).then(|| custom.to_string()),
                }
            })
            .collect()
    }

    /// Advance to the next question, or submit when every one is answered.
    fn advance(&mut self) -> CardAction {
        if self.current + 1 < self.questions.len() {
            self.current += 1;
            return CardAction::None;
        }
        if let Some(missing) = (0..self.questions.len()).find(|index| !self.answered(*index)) {
            self.current = missing;
            return CardAction::Hint(format!(
                "answer question {} of {} before submitting",
                missing + 1,
                self.questions.len()
            ));
        }
        self.sent = true;
        CardAction::Submit(self.answers())
    }

    fn choose(&mut self, row: usize, advance: bool) -> CardAction {
        let q = self.current;
        if row == self.free_row(q) {
            self.focus[q] = row;
            self.typing = true;
            return CardAction::None;
        }
        self.focus[q] = row;
        if self.questions[q].multi {
            if !advance || !self.selected[q].contains(&row) {
                if self.selected[q].contains(&row) {
                    self.selected[q].remove(&row);
                } else {
                    self.selected[q].insert(row);
                }
            }
            if advance {
                return self.advance();
            }
            return CardAction::None;
        }
        self.selected[q].clear();
        self.selected[q].insert(row);
        self.custom[q].clear();
        if advance {
            return self.advance();
        }
        CardAction::None
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> CardAction {
        if self.sent || self.questions.is_empty() {
            return CardAction::None;
        }
        let q = self.current;
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if self.typing {
            match key.code {
                KeyCode::Enter => {
                    self.typing = false;
                    if self.custom[q].trim().is_empty() {
                        return CardAction::Hint("type an answer, or Esc to go back".into());
                    }
                    if !self.questions[q].multi {
                        self.selected[q].clear();
                    }
                    return self.advance();
                }
                KeyCode::Esc => self.typing = false,
                KeyCode::Backspace => {
                    self.custom[q].pop();
                }
                KeyCode::Char('u') if ctrl => self.custom[q].clear(),
                KeyCode::Char(ch) if !ctrl => self.custom[q].push(ch),
                _ => {}
            }
            return CardAction::None;
        }
        if ctrl {
            if key.code == KeyCode::Char('f') {
                self.expanded = !self.expanded;
            }
            return CardAction::None;
        }
        let rows = self.rows(q);
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.focus[q] = self.focus[q].saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') => self.focus[q] = (self.focus[q] + 1).min(rows - 1),
            KeyCode::Tab => self.focus[q] = (self.focus[q] + 1) % rows,
            KeyCode::BackTab => self.focus[q] = (self.focus[q] + rows - 1) % rows,
            KeyCode::Left | KeyCode::Char('h') | KeyCode::Char('[') => {
                self.current = self.current.saturating_sub(1);
            }
            KeyCode::Right | KeyCode::Char('l') | KeyCode::Char(']') => {
                self.current = (self.current + 1).min(self.questions.len() - 1);
            }
            KeyCode::Char('z') => {
                self.focus[q] = self.free_row(q);
                self.typing = true;
            }
            KeyCode::Char(' ') => {
                let row = self.focus[q];
                return self.choose(row, false);
            }
            KeyCode::Enter => {
                let row = self.focus[q];
                if row != self.free_row(q)
                    && self.questions[q].multi
                    && !self.selected[q].is_empty()
                {
                    return self.advance();
                }
                if row == self.free_row(q) && !self.custom[q].trim().is_empty() {
                    self.typing = true;
                    return CardAction::None;
                }
                return self.choose(row, true);
            }
            KeyCode::Esc => {
                if self.answered(q) {
                    self.selected[q].clear();
                    self.custom[q].clear();
                } else {
                    self.parked = true;
                    return CardAction::Park;
                }
            }
            KeyCode::Char('y') => {
                let row = self.focus[q];
                let text = match self.questions[q].options.get(row) {
                    Some(option) => option.label.clone(),
                    None => self.custom[q].clone(),
                };
                if text.is_empty() {
                    return CardAction::Hint("nothing to copy on this row".into());
                }
                return CardAction::Copy(text);
            }
            KeyCode::Char('X') => {
                self.sent = true;
                return CardAction::Dismiss;
            }
            KeyCode::Char(ch) => {
                if let Some(row) = pick_index(ch) {
                    if row < self.questions[q].options.len() {
                        return self.choose(row, !self.questions[q].multi);
                    }
                    return CardAction::Hint(format!("no answer {ch} on this question"));
                }
            }
            _ => {}
        }
        CardAction::None
    }

    /// Shortcut line for the footer of the card.
    pub fn keys_hint(&self) -> &'static str {
        if self.parked {
            "Tab/Space: question"
        } else if self.typing {
            "type your answer · Enter submit · Esc back"
        } else if self.questions.get(self.current).is_some_and(|q| q.multi) {
            "↑↓ move · Space toggle · Enter next/submit · ←→ question · z type · y copy · Shift+X dismiss · Esc unselect/park"
        } else {
            "↑↓ move · 1-9 pick · Enter select · ←→ question · z type · y copy · Shift+X dismiss · Ctrl+F full · Esc unselect/park"
        }
    }

    pub fn lines(&self) -> Vec<(String, bool)> {
        let mut out = Vec::new();
        let Some(question) = self.questions.get(self.current) else {
            return out;
        };
        let q = self.current;
        let mut head = String::new();
        if self.questions.len() > 1 {
            head.push_str(&format!("[{}/{}] ", q + 1, self.questions.len()));
        }
        if !question.header.is_empty() {
            head.push_str(&question.header);
            head.push_str(": ");
        }
        head.push_str(&question.question);
        out.push((head, false));
        for (row, option) in question.options.iter().enumerate() {
            let mark = if question.multi {
                if self.selected[q].contains(&row) {
                    "[x]"
                } else {
                    "[ ]"
                }
            } else if self.selected[q].contains(&row) {
                "(•)"
            } else {
                "( )"
            };
            let key = if row < 9 {
                char::from(b'1' + row as u8)
            } else if row < 15 {
                char::from(b'a' + (row - 9) as u8)
            } else {
                ' '
            };
            let pointer = if self.focus[q] == row && !self.parked {
                '›'
            } else {
                ' '
            };
            let mut text = format!("{pointer} {key}. {mark} {}", option.label);
            if !option.description.is_empty() {
                text.push_str(" — ");
                text.push_str(&option.description);
            }
            out.push((text, self.focus[q] == row && !self.parked));
        }
        let free = self.free_row(q);
        let pointer = if self.focus[q] == free && !self.parked {
            '›'
        } else {
            ' '
        };
        let typed = &self.custom[q];
        let body = if self.typing {
            format!("{typed}▏")
        } else if typed.is_empty() {
            "type your own answer (z)".into()
        } else {
            typed.clone()
        };
        out.push((
            format!("{pointer} z. {body}"),
            self.focus[q] == free && !self.parked,
        ));
        out
    }

    /// Rows the card wants (border included).
    pub fn height(&self) -> u16 {
        (self.lines().len() as u16).saturating_add(3)
    }
}

// ---------------------------------------------------------------------------
// Plan review

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewFocus {
    Preview,
    Prompt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanComment {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReviewAction {
    None,
    /// Approve. `comments` rides along as a follow-up message.
    Approve {
        comments: Option<String>,
    },
    Quit,
    Copy(String),
    FocusPrompt,
    Hint(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanReview {
    pub id: String,
    pub plan: String,
    pub plan_file: String,
    pub lines: Vec<String>,
    pub cursor: usize,
    pub anchor: Option<usize>,
    pub scroll: usize,
    pub comments: Vec<PlanComment>,
    pub commenting: Option<String>,
    pub focus: ReviewFocus,
    /// Minimal mode has printed the plan into scrollback already.
    pub committed: bool,
    pub sent: bool,
    /// `/view-plan`: a saved plan, nothing to answer.
    pub readonly: bool,
}

impl PlanReview {
    pub fn new(id: impl Into<String>, plan: &str, plan_file: impl Into<String>) -> Self {
        let lines = if plan.trim().is_empty() {
            Vec::new()
        } else {
            plan.lines().map(str::to_string).collect()
        };
        Self {
            id: id.into(),
            plan: plan.to_string(),
            plan_file: plan_file.into(),
            lines,
            cursor: 0,
            anchor: None,
            scroll: 0,
            comments: Vec::new(),
            commenting: None,
            focus: ReviewFocus::Preview,
            committed: false,
            sent: false,
            readonly: false,
        }
    }

    /// The saved plan preview (`/view-plan`): scroll, copy, Esc or q closes.
    pub fn viewer(plan: &str, plan_file: impl Into<String>) -> Self {
        let mut view = Self::new("", plan, plan_file);
        view.readonly = true;
        view
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    pub fn title(&self) -> String {
        if self.is_empty() {
            return EMPTY_PLAN.into();
        }
        self.lines
            .iter()
            .find_map(|line| {
                let trimmed = line.trim_start();
                trimmed
                    .starts_with('#')
                    .then(|| trimmed.trim_start_matches('#').trim().to_string())
            })
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| "Plan".into())
    }

    fn range(&self) -> (usize, usize) {
        match self.anchor {
            Some(anchor) => (anchor.min(self.cursor), anchor.max(self.cursor)),
            None => (self.cursor, self.cursor),
        }
    }

    /// Inline comments as model-facing notes.
    pub fn comment_notes(&self) -> Option<String> {
        if self.comments.is_empty() {
            return None;
        }
        let mut out = String::from("Comments on the plan:\n");
        for comment in &self.comments {
            let quoted = self
                .lines
                .get(comment.start)
                .map(|line| line.trim())
                .unwrap_or("");
            let span = if comment.start == comment.end {
                format!("line {}", comment.start + 1)
            } else {
                format!("lines {}-{}", comment.start + 1, comment.end + 1)
            };
            out.push_str(&format!("- {span} (\"{quoted}\"): {}\n", comment.text));
        }
        Some(out.trim_end().to_string())
    }

    /// Notes for "request changes": comments plus the typed text.
    pub fn feedback(&self, typed: &str) -> String {
        let typed = typed.trim();
        match (self.comment_notes(), typed.is_empty()) {
            (Some(notes), true) => notes,
            (Some(notes), false) => format!("{notes}\n\n{typed}"),
            (None, _) => typed.to_string(),
        }
    }

    pub fn keys_hint(&self, minimal: bool) -> String {
        if self.readonly {
            return "↑↓ scroll · y copy · Esc/q close".into();
        }
        if self.commenting.is_some() {
            return "type a comment · Enter save · Esc cancel".into();
        }
        if self.focus == ReviewFocus::Prompt {
            return "type revision notes · Enter send · Esc back to the plan".into();
        }
        let approve = if self.comments.is_empty() {
            "a approve"
        } else {
            "a approve w/ comments"
        };
        if minimal {
            format!("{approve} · s request changes · y copy · q quit plan")
        } else {
            format!(
                "{approve} · s request changes · c comment · y copy · q quit plan · ↑↓ scroll · Shift+↑↓ range · Tab prompt"
            )
        }
    }

    /// `pending_command` is a complete slash command waiting in the prompt;
    /// approving is refused until it runs or is deleted.
    pub fn handle_key(
        &mut self,
        key: KeyEvent,
        minimal: bool,
        pending_command: bool,
    ) -> ReviewAction {
        if self.sent {
            return ReviewAction::None;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if let Some(draft) = self.commenting.as_mut() {
            match key.code {
                KeyCode::Enter => {
                    let text = draft.trim().to_string();
                    self.commenting = None;
                    if !text.is_empty() {
                        let (start, end) = self.range();
                        self.comments.push(PlanComment { start, end, text });
                        self.anchor = None;
                        return ReviewAction::Hint(format!(
                            "{} comment(s); a approves with them, s sends them as changes",
                            self.comments.len()
                        ));
                    }
                }
                KeyCode::Esc => self.commenting = None,
                KeyCode::Backspace => {
                    draft.pop();
                }
                KeyCode::Char(ch) if !ctrl => draft.push(ch),
                _ => {}
            }
            return ReviewAction::None;
        }
        if self.focus == ReviewFocus::Prompt {
            if matches!(key.code, KeyCode::Esc | KeyCode::Tab) {
                self.focus = ReviewFocus::Preview;
            }
            return ReviewAction::None;
        }
        let last = self.lines.len().saturating_sub(1);
        if self.readonly {
            match key.code {
                KeyCode::Esc | KeyCode::Char('q') => return ReviewAction::Quit,
                KeyCode::Char('a' | 's' | 'c') | KeyCode::Enter | KeyCode::Tab => {
                    return ReviewAction::Hint(
                        "this is the saved plan; there is nothing to approve".into(),
                    );
                }
                _ => {}
            }
        }
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        match key.code {
            KeyCode::Up | KeyCode::Char('k') | KeyCode::Char('K') => {
                if shift || key.code == KeyCode::Char('K') {
                    self.anchor.get_or_insert(self.cursor);
                } else {
                    self.anchor = None;
                }
                self.cursor = self.cursor.saturating_sub(1);
            }
            KeyCode::Down | KeyCode::Char('j') | KeyCode::Char('J') => {
                if shift || key.code == KeyCode::Char('J') {
                    self.anchor.get_or_insert(self.cursor);
                } else {
                    self.anchor = None;
                }
                self.cursor = (self.cursor + 1).min(last);
            }
            KeyCode::PageUp => self.cursor = self.cursor.saturating_sub(10),
            KeyCode::PageDown => self.cursor = (self.cursor + 10).min(last),
            KeyCode::Home | KeyCode::Char('g') => self.cursor = 0,
            KeyCode::End | KeyCode::Char('G') => self.cursor = last,
            KeyCode::Tab => {
                self.focus = ReviewFocus::Prompt;
                return ReviewAction::FocusPrompt;
            }
            KeyCode::Esc => self.anchor = None,
            KeyCode::Char('a') => {
                if pending_command {
                    return ReviewAction::Hint(
                        "a command is waiting in the prompt; press Enter to run it or delete it before approving".into(),
                    );
                }
                self.sent = true;
                return ReviewAction::Approve {
                    comments: self.comment_notes(),
                };
            }
            KeyCode::Char('s') => {
                self.focus = ReviewFocus::Prompt;
                return ReviewAction::FocusPrompt;
            }
            KeyCode::Char('c') | KeyCode::Enter => {
                if minimal {
                    return ReviewAction::Hint(
                        "line comments need the fullscreen preview; use s to send notes".into(),
                    );
                }
                if self.is_empty() {
                    return ReviewAction::Hint("no plan lines to comment on".into());
                }
                self.commenting = Some(String::new());
            }
            KeyCode::Char('y') => {
                if self.is_empty() {
                    return ReviewAction::Hint("no plan written yet; nothing to copy".into());
                }
                return ReviewAction::Copy(self.plan.clone());
            }
            KeyCode::Char('q') => {
                self.sent = true;
                return ReviewAction::Quit;
            }
            _ => {}
        }
        ReviewAction::None
    }

    /// Text committed to minimal scrollback when the review opens.
    pub fn scrollback_text(&self) -> String {
        if self.is_empty() {
            return format!("── Plan review ──\n{EMPTY_PLAN}\n");
        }
        format!(
            "── Plan review: {} ──\n{}\n",
            self.title(),
            self.plan.trim_end()
        )
    }
}

// ---------------------------------------------------------------------------
// Plan state and todos

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PlanState {
    pub active: bool,
    /// A selection awaiting dsh's next step boundary.
    pub pending: Option<bool>,
    pub plan_file: String,
}

impl PlanState {
    /// Where plan mode is heading: the pending selection, else the logged state.
    pub fn effective(&self) -> bool {
        self.pending.unwrap_or(self.active)
    }

    /// Status-line flag, or `None` outside plan mode.
    pub fn flag(&self) -> Option<&'static str> {
        match (self.active, self.pending) {
            (true, Some(false)) => Some("plan (exiting)"),
            (true, _) => Some("plan"),
            (false, Some(true)) => Some("plan (next step)"),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TodoItem {
    pub content: String,
    pub status: String,
}

pub fn parse_todos(value: &Value) -> Option<Vec<TodoItem>> {
    let items = value.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| {
                Some(TodoItem {
                    content: item.get("content")?.as_str()?.to_string(),
                    status: item
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("pending")
                        .to_string(),
                })
            })
            .collect(),
    )
}

pub fn todo_lines(todos: &[TodoItem]) -> Vec<String> {
    let done = todos.iter().filter(|t| t.status == "completed").count();
    let mut out = vec![format!("Todos {done}/{} (Ctrl+T hides)", todos.len())];
    for todo in todos {
        let mark = match todo.status.as_str() {
            "completed" => "[x]",
            "in_progress" => "[~]",
            _ => "[ ]",
        };
        out.push(format!("{mark} {}", todo.content));
    }
    out
}

// ---------------------------------------------------------------------------
// Rendering

fn clip(text: &str, width: usize) -> String {
    if text.width() <= width {
        return text.to_string();
    }
    let mut out = String::new();
    for ch in text.chars() {
        if out.width() + 2 > width {
            break;
        }
        out.push(ch);
    }
    out.push('…');
    out
}

/// Draw the card at the bottom of `area` (or over all of it when expanded).
pub fn render_card(frame: &mut Frame, area: Rect, card: &QuestionCard, theme: &Theme) {
    if area.height < 3 || area.width < 10 {
        return;
    }
    let want = card.height();
    let height = if card.expanded {
        area.height
    } else {
        want.min(area.height)
    };
    let rect = Rect {
        x: area.x,
        y: area.y + area.height - height,
        width: area.width,
        height,
    };
    frame.render_widget(Clear, rect);
    let border = if card.parked {
        theme.gray
    } else {
        theme.accent
    };
    let block = Block::bordered()
        .title(" Question ")
        .title_bottom(format!(" {} ", card.keys_hint()))
        .border_style(Style::default().fg(border))
        .style(Style::default().fg(theme.text_primary).bg(theme.bg_base));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let lines = card.lines();
    let rows = inner.height as usize;
    // Keep the focused row visible when the card is taller than the area.
    let focus_line = lines.iter().position(|(_, focused)| *focused).unwrap_or(0);
    let start = if lines.len() <= rows {
        0
    } else {
        focus_line
            .saturating_sub(rows.saturating_sub(2))
            .min(lines.len() - rows)
    };
    let width = inner.width as usize;
    let body: Vec<Line> = lines
        .iter()
        .enumerate()
        .skip(start)
        .take(rows)
        .map(|(index, (text, focused))| {
            let text = clip(text, width);
            if index == 0 {
                Line::styled(text, Style::default().add_modifier(Modifier::BOLD))
            } else if *focused {
                Line::styled(text, Style::default().bg(theme.bg_highlight))
            } else {
                Line::from(text)
            }
        })
        .collect();
    frame.render_widget(Paragraph::new(body), inner);
}

/// Full preview with the action bar (fullscreen).
pub fn render_review(frame: &mut Frame, area: Rect, review: &mut PlanReview, theme: &Theme) {
    if area.height < 4 || area.width < 16 {
        return;
    }
    frame.render_widget(Clear, area);
    let block = Block::bordered()
        .title(if review.readonly {
            format!(" Plan: {} ", review.title())
        } else {
            format!(" Plan review: {} ", review.title())
        })
        .title_bottom(format!(" {} ", review.keys_hint(false)))
        .border_style(Style::default().fg(theme.accent))
        .style(Style::default().fg(theme.text_primary).bg(theme.bg_base));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let extra = usize::from(review.commenting.is_some());
    let rows = (inner.height as usize).saturating_sub(extra).max(1);
    if review.is_empty() {
        let text = vec![
            Line::styled(EMPTY_PLAN, Style::default().add_modifier(Modifier::BOLD)),
            Line::from(""),
            Line::from("The agent left plan mode without writing a plan."),
            Line::from(
                "a approves and starts implementing, s sends it back to planning, q quits plan mode.",
            ),
        ];
        frame.render_widget(Paragraph::new(text).wrap(Wrap { trim: false }), inner);
        return;
    }
    if review.cursor < review.scroll {
        review.scroll = review.cursor;
    } else if review.cursor >= review.scroll + rows {
        review.scroll = review.cursor + 1 - rows;
    }
    let (start, end) = review.range();
    let width = inner.width as usize;
    let mut body: Vec<Line> = Vec::new();
    for (index, line) in review
        .lines
        .iter()
        .enumerate()
        .skip(review.scroll)
        .take(rows)
    {
        let commented = review
            .comments
            .iter()
            .any(|comment| index >= comment.start && index <= comment.end);
        let gutter = if commented { "✎ " } else { "  " };
        let text = clip(&format!("{gutter}{line}"), width);
        let in_range = index >= start && index <= end;
        let style = if in_range && review.focus == ReviewFocus::Preview {
            Style::default().bg(theme.bg_highlight)
        } else {
            Style::default()
        };
        body.push(Line::from(Span::styled(text, style)));
    }
    if let Some(draft) = &review.commenting {
        body.push(Line::styled(
            clip(&format!("comment: {draft}▏"), width),
            Style::default().fg(theme.accent),
        ));
    }
    frame.render_widget(Paragraph::new(body), inner);
}

/// Controls strip for minimal mode (the plan itself is in scrollback).
pub fn render_review_strip(frame: &mut Frame, area: Rect, review: &PlanReview, theme: &Theme) {
    if area.height < 3 || area.width < 16 {
        return;
    }
    let height = 3.min(area.height);
    let rect = Rect {
        x: area.x,
        y: area.y + area.height - height,
        width: area.width,
        height,
    };
    frame.render_widget(Clear, rect);
    let header = if review.is_empty() {
        EMPTY_PLAN.to_string()
    } else {
        format!("Plan review: {}", review.title())
    };
    let block = Block::bordered()
        .title(format!(" {header} "))
        .border_style(Style::default().fg(theme.accent))
        .style(Style::default().fg(theme.text_primary).bg(theme.bg_base));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    frame.render_widget(
        Paragraph::new(clip(&review.keys_hint(true), inner.width as usize)),
        inner,
    );
}

/// Todos pane at the bottom of `area`.
pub fn render_todos(frame: &mut Frame, area: Rect, todos: &[TodoItem], theme: &Theme) {
    if todos.is_empty() || area.height < 3 || area.width < 16 {
        return;
    }
    let lines = todo_lines(todos);
    let height = ((lines.len() as u16) + 1).min(area.height).min(10);
    let width = (lines.iter().map(|l| l.width()).max().unwrap_or(0) as u16 + 4)
        .min(area.width)
        .max(20.min(area.width));
    let rect = Rect {
        x: area.x + area.width - width,
        y: area.y,
        width,
        height,
    };
    frame.render_widget(Clear, rect);
    let block = Block::bordered()
        .title(format!(" {} ", lines[0]))
        .border_style(Style::default().fg(theme.gray))
        .style(Style::default().fg(theme.text_primary).bg(theme.bg_base));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let body: Vec<Line> = lines
        .iter()
        .skip(1)
        .take(inner.height as usize)
        .map(|line| {
            let text = clip(line, inner.width as usize);
            if line.starts_with("[x]") {
                Line::styled(text, Style::default().fg(theme.gray))
            } else if line.starts_with("[~]") {
                Line::styled(text, Style::default().add_modifier(Modifier::BOLD))
            } else {
                Line::from(text)
            }
        })
        .collect();
    frame.render_widget(Paragraph::new(body), inner);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn q(id: &str, labels: &[&str], multi: bool) -> Question {
        Question {
            id: id.into(),
            header: String::new(),
            question: format!("{id}?"),
            options: labels
                .iter()
                .map(|label| QuestionOption {
                    label: (*label).into(),
                    description: String::new(),
                })
                .collect(),
            multi,
        }
    }

    #[test]
    fn encodes_cwd_like_urlencoding_and_hashes_long_names() {
        assert_eq!(encode_cwd_dirname("/tmp/a b"), "%2Ftmp%2Fa%20b");
        assert_eq!(encode_cwd_dirname("/x/y-z_1.~"), "%2Fx%2Fy-z_1.~");
        assert_eq!(encode_cwd_dirname("/中"), "%2F%E4%B8%AD");
        let long = format!("/{}/My Project", "d".repeat(300));
        let encoded = encode_cwd_dirname(&long);
        assert!(encoded.starts_with("my-project-"), "{encoded}");
        assert_eq!(encoded.len(), "my-project-".len() + 16);
        let file = plan_file(Path::new("/h"), Path::new("/w"), "s1");
        assert_eq!(file, PathBuf::from("/h/sessions/%2Fw/s1/plan.md"));
    }

    #[test]
    fn single_select_picks_and_submits() {
        let mut card = QuestionCard::new("r1", vec![q("color", &["Red", "Blue"], false)]);
        assert_eq!(card.handle_key(key(KeyCode::Down)), CardAction::None);
        assert_eq!(card.handle_key(key(KeyCode::Down)), CardAction::None);
        assert_eq!(card.focus[0], 2, "clamped at the free-text row");
        assert_eq!(card.handle_key(key(KeyCode::Down)), CardAction::None);
        assert_eq!(card.focus[0], 2);
        card.handle_key(key(KeyCode::Tab));
        assert_eq!(card.focus[0], 0, "Tab wraps within the question");
        let action = card.handle_key(key(KeyCode::Char('2')));
        assert_eq!(
            action,
            CardAction::Submit(vec![Answer {
                id: "color".into(),
                selected: vec!["Blue".into()],
                custom: None
            }])
        );
        assert!(card.sent);
        assert_eq!(card.handle_key(key(KeyCode::Char('1'))), CardAction::None);
    }

    #[test]
    fn multi_select_toggles_and_free_text_answers() {
        let mut card = QuestionCard::new(
            "r2",
            vec![
                q("langs", &["Rust", "Go", "TS"], true),
                q("name", &[], false),
            ],
        );
        card.handle_key(key(KeyCode::Char(' ')));
        card.handle_key(key(KeyCode::Char('3')));
        assert_eq!(card.selected[0], BTreeSet::from([0, 2]));
        card.handle_key(key(KeyCode::Char('3')));
        assert_eq!(card.selected[0], BTreeSet::from([0]));
        assert_eq!(card.handle_key(key(KeyCode::Enter)), CardAction::None);
        assert_eq!(card.current, 1);
        // No options: only the free-text row.
        assert_eq!(card.handle_key(key(KeyCode::Enter)), CardAction::None);
        assert!(card.typing);
        for ch in "ada".chars() {
            card.handle_key(key(KeyCode::Char(ch)));
        }
        let action = card.handle_key(key(KeyCode::Enter));
        let CardAction::Submit(answers) = action else {
            panic!("expected submit, got {action:?}");
        };
        assert_eq!(answers[0].selected, vec!["Rust".to_string()]);
        assert_eq!(answers[1].custom.as_deref(), Some("ada"));
    }

    #[test]
    fn esc_unselects_then_parks_and_shift_x_dismisses() {
        let mut card = QuestionCard::new(
            "r3",
            vec![q("a", &["x", "y"], false), q("b", &["z"], false)],
        );
        card.handle_key(key(KeyCode::Char(' ')));
        assert!(card.answered(0));
        assert_eq!(card.handle_key(key(KeyCode::Esc)), CardAction::None);
        assert!(!card.answered(0));
        assert_eq!(card.handle_key(key(KeyCode::Esc)), CardAction::Park);
        assert!(card.parked);
        card.parked = false;
        card.handle_key(key(KeyCode::Char(']')));
        assert_eq!(card.current, 1);
        card.handle_key(key(KeyCode::Char('h')));
        assert_eq!(card.current, 0);
        // Submitting with an unanswered question jumps to it.
        card.handle_key(key(KeyCode::Char('l')));
        let action = card.handle_key(key(KeyCode::Char('1')));
        assert!(matches!(action, CardAction::Hint(_)), "{action:?}");
        assert_eq!(card.current, 0);
        assert_eq!(
            card.handle_key(KeyEvent::new(KeyCode::Char('X'), KeyModifiers::SHIFT)),
            CardAction::Dismiss
        );
        assert_eq!(card.handle_key(key(KeyCode::Char('1'))), CardAction::None);
    }

    #[test]
    fn typing_keeps_letters_out_of_the_shortcuts() {
        let mut card = QuestionCard::new("r4", vec![q("a", &["x"], false)]);
        card.handle_key(key(KeyCode::Char('z')));
        for ch in "yXq1".chars() {
            assert_eq!(card.handle_key(key(KeyCode::Char(ch))), CardAction::None);
        }
        assert_eq!(card.custom[0], "yXq1");
        card.handle_key(key(KeyCode::Esc));
        assert!(!card.typing);
        // Focus stays on the free-text row, so `y` copies what was typed.
        assert_eq!(
            card.handle_key(key(KeyCode::Char('y'))),
            CardAction::Copy("yXq1".into())
        );
        card.handle_key(key(KeyCode::Up));
        assert_eq!(
            card.handle_key(key(KeyCode::Char('y'))),
            CardAction::Copy("x".into())
        );
        card.handle_key(KeyEvent::new(KeyCode::Char('f'), KeyModifiers::CONTROL));
        assert!(card.expanded);
    }

    #[test]
    fn review_comments_approve_feedback_and_quit() {
        let plan = "# Ship it\n\n1. step one\n2. step two\n";
        let mut review = PlanReview::new("p1", plan, "/tmp/plan.md");
        assert_eq!(review.title(), "Ship it");
        review.handle_key(key(KeyCode::Down), false, false);
        review.handle_key(key(KeyCode::Down), false, false);
        review.handle_key(
            KeyEvent::new(KeyCode::Down, KeyModifiers::SHIFT),
            false,
            false,
        );
        review.handle_key(key(KeyCode::Char('c')), false, false);
        for ch in "merge".chars() {
            review.handle_key(key(KeyCode::Char(ch)), false, false);
        }
        assert!(matches!(
            review.handle_key(key(KeyCode::Enter), false, false),
            ReviewAction::Hint(_)
        ));
        let notes = review.comment_notes().unwrap();
        assert!(
            notes.contains("lines 3-4 (\"1. step one\"): merge"),
            "{notes}"
        );
        assert!(review.keys_hint(false).contains("approve w/ comments"));
        assert!(matches!(
            review.handle_key(key(KeyCode::Char('a')), false, true),
            ReviewAction::Hint(_)
        ));
        assert!(!review.sent, "a pending command blocks approve");
        assert_eq!(
            review.handle_key(key(KeyCode::Char('s')), false, false),
            ReviewAction::FocusPrompt
        );
        assert_eq!(review.focus, ReviewFocus::Prompt);
        assert_eq!(
            review.feedback("  and test it "),
            format!("{notes}\n\nand test it")
        );
        review.handle_key(key(KeyCode::Esc), false, false);
        assert_eq!(review.focus, ReviewFocus::Preview);
        assert_eq!(
            review.handle_key(key(KeyCode::Char('a')), false, false),
            ReviewAction::Approve {
                comments: Some(notes)
            }
        );
        assert_eq!(
            review.handle_key(key(KeyCode::Char('q')), false, false),
            ReviewAction::None
        );
        let mut other = PlanReview::new("p2", "# x", "");
        assert_eq!(
            other.handle_key(key(KeyCode::Char('q')), true, false),
            ReviewAction::Quit
        );
    }

    #[test]
    fn viewer_only_scrolls_copies_and_closes() {
        let mut view = PlanReview::viewer("# Saved\nline", "/p.md");
        assert!(matches!(
            view.handle_key(key(KeyCode::Char('a')), false, false),
            ReviewAction::Hint(_)
        ));
        assert!(!view.sent);
        view.handle_key(key(KeyCode::Down), false, false);
        assert_eq!(view.cursor, 1);
        assert_eq!(
            view.handle_key(key(KeyCode::Char('y')), false, false),
            ReviewAction::Copy("# Saved\nline".into())
        );
        assert_eq!(
            view.handle_key(key(KeyCode::Esc), false, false),
            ReviewAction::Quit
        );
    }

    #[test]
    fn empty_plan_still_reviews() {
        let mut review = PlanReview::new("p3", "  \n", "");
        assert!(review.is_empty());
        assert_eq!(review.title(), EMPTY_PLAN);
        assert!(review.scrollback_text().contains(EMPTY_PLAN));
        assert!(matches!(
            review.handle_key(key(KeyCode::Char('c')), false, false),
            ReviewAction::Hint(_)
        ));
        assert!(matches!(
            review.handle_key(key(KeyCode::Char('c')), true, false),
            ReviewAction::Hint(_)
        ));
        assert_eq!(
            review.handle_key(key(KeyCode::Char('a')), false, false),
            ReviewAction::Approve { comments: None }
        );
    }

    #[test]
    fn plan_state_flags_and_todos() {
        let mut state = PlanState::default();
        assert_eq!(state.flag(), None);
        state.pending = Some(true);
        assert_eq!(state.flag(), Some("plan (next step)"));
        assert!(state.effective());
        state.active = true;
        state.pending = None;
        assert_eq!(state.flag(), Some("plan"));
        state.pending = Some(false);
        assert_eq!(state.flag(), Some("plan (exiting)"));
        assert!(!state.effective());
        let todos = parse_todos(&json!([
            {"content": "a", "status": "completed"},
            {"content": "b", "status": "in_progress"},
            {"content": "c", "status": "pending"}
        ]))
        .unwrap();
        let lines = todo_lines(&todos);
        assert_eq!(lines[0], "Todos 1/3 (Ctrl+T hides)");
        assert_eq!(&lines[1..], ["[x] a", "[~] b", "[ ] c"]);
        assert_eq!(parse_todos(&Value::Null), None);
    }

    #[test]
    fn dsh_env_carries_flags_and_timeout() {
        let cli = CliInteraction {
            no_plan: true,
            no_ask_user: false,
            todo_gate: true,
        };
        let mut ask = AskSettings::default();
        let env = dsh_env(&cli, &ask, Path::new("/r"));
        let get = |env: &[(String, String)], key: &str| {
            env.iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .unwrap()
        };
        assert_eq!(get(&env, "CODSH_NO_PLAN"), "1");
        assert_eq!(get(&env, "CODSH_NO_ASK_USER"), "0");
        assert_eq!(get(&env, "CODSH_TODO_GATE"), "1");
        assert_eq!(get(&env, "CODSH_ASK_USER_TIMEOUT_SECS"), "1800");
        assert_eq!(get(&env, "CODSH_PLAN_ROOT"), "/r");
        ask.enabled = false;
        ask.timeout_enabled = false;
        let env = dsh_env(&CliInteraction::default(), &ask, Path::new("/r"));
        assert_eq!(
            get(&env, "CODSH_NO_ASK_USER"),
            "1",
            "features.ask_user_question = false"
        );
        assert_eq!(get(&env, "CODSH_ASK_USER_TIMEOUT_SECS"), "0");
    }

    #[test]
    fn ask_settings_follow_the_documented_precedence() {
        let user: toml::Value = toml::from_str(
            "[features]\nask_user_question = false\n[toolset.ask_user_question]\ntimeout_secs = 60\n",
        )
        .unwrap();
        let mut env = std::collections::BTreeMap::new();
        env.insert("GROK_ASK_USER_QUESTION".to_string(), "1".to_string());
        env.insert(
            "GROK_ASK_USER_QUESTION_TIMEOUT_SECS".to_string(),
            "90".to_string(),
        );
        let settings = load_ask_settings(&user, &env, None, None);
        assert!(
            !settings.enabled,
            "user config beats env for the feature pin column"
        );
        assert_eq!(
            settings.timeout_secs, 90,
            "env beats user config for toolset"
        );
        assert_eq!(settings.timeout_secs_source, "environment");
        let requirements: toml::Value = toml::from_str(
            "[features]\nask_user_question = true\n[toolset.ask_user_question]\ntimeout_enabled = false\n",
        )
        .unwrap();
        let settings = load_ask_settings(&user, &env, Some(&requirements), None);
        assert!(settings.enabled);
        assert_eq!(settings.effective_timeout(), 0);
        let bad: toml::Value =
            toml::from_str("[toolset.ask_user_question]\ntimeout_secs = -1\n").unwrap();
        let settings = load_ask_settings(&bad, &Default::default(), None, None);
        assert_eq!(settings.timeout_secs, DEFAULT_TIMEOUT_SECS);
        assert_eq!(settings.errors.len(), 1);
    }
}
