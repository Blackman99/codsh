//! The TUI card for an MCP elicitation (`elicitation/create`): a form the
//! server asked the user to fill in, or a URL to open. The title names the
//! server. Keys follow the reference card: ↑/↓, j/k, and Tab move between
//! fields and the action row; Space/Enter edits a text field or toggles a
//! choice; ←/→ pick Accept or Decline on the action row (and move between a
//! select field's options); Enter on Accept submits (the form is validated
//! first; a URL opens in the browser); d declines; Esc leaves text editing,
//! then parks the keyboard (Tab or Space returns), and only while waiting
//! on an accepted URL does it dismiss the card; Ctrl+C cancels; o reopens
//! the URL.

use crate::elicit_form::{self, Field, Kind, Mode};
use crate::mcp_bridge::Elicitation;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, Clear, Paragraph};
use serde_json::{Map, Value as JsonValue, json};
use unicode_width::UnicodeWidthStr;

#[derive(Clone, Debug, PartialEq)]
enum Value {
    Draft(String),
    Bool(bool),
    /// Selected option and the option cursor.
    Choice(Option<usize>, usize),
    Multi(Vec<bool>, usize),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Accept,
    Decline,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ElicitAction {
    None,
    /// Send this `{action, content?}` answer.
    Answer(JsonValue),
    /// Accept a URL elicitation: open it and answer accept.
    AcceptUrl(String),
    /// Reopen the URL.
    Open(String),
    /// Close a card that already answered (waiting on a URL).
    Dismiss,
    Hint(String),
}

#[derive(Clone, Debug)]
pub struct ElicitCard {
    pub id: String,
    pub server: String,
    pub message: String,
    fields: Vec<Field>,
    values: Vec<Value>,
    errors: Vec<Option<String>>,
    url: Option<String>,
    /// `fields.len()` is the action row.
    pub focus: usize,
    pub button: Button,
    pub editing: bool,
    pub parked: bool,
    /// The URL was accepted; the card waits for the server to finish.
    pub waiting: bool,
}

fn initial(field: &Field) -> Value {
    match &field.kind {
        Kind::Boolean => Value::Bool(
            field
                .default
                .as_ref()
                .and_then(JsonValue::as_bool)
                .unwrap_or(false),
        ),
        Kind::Choice { options } => {
            let selected = field
                .default
                .as_ref()
                .and_then(JsonValue::as_str)
                .and_then(|value| options.iter().position(|(option, _)| option == value));
            Value::Choice(selected, selected.unwrap_or(0))
        }
        Kind::Multi { options, .. } => {
            let defaults: Vec<&str> = field
                .default
                .as_ref()
                .and_then(JsonValue::as_array)
                .map(|items| items.iter().filter_map(JsonValue::as_str).collect())
                .unwrap_or_default();
            Value::Multi(
                options
                    .iter()
                    .map(|(option, _)| defaults.contains(&option.as_str()))
                    .collect(),
                0,
            )
        }
        _ => Value::Draft(match &field.default {
            Some(JsonValue::String(text)) => text.clone(),
            Some(JsonValue::Number(number)) => number.to_string(),
            _ => String::new(),
        }),
    }
}

impl ElicitCard {
    pub fn new(elicitation: &Elicitation) -> Self {
        let (fields, url) = match &elicitation.request.mode {
            Mode::Form { fields, .. } => (fields.clone(), None),
            Mode::Url { url, .. } => (Vec::new(), Some(url.clone())),
        };
        let values = fields.iter().map(initial).collect();
        let errors = vec![None; fields.len()];
        Self {
            id: elicitation.id.clone(),
            server: elicitation.server.clone(),
            message: elicitation.request.message.clone(),
            focus: 0,
            button: Button::Accept,
            editing: false,
            parked: false,
            waiting: false,
            fields,
            values,
            errors,
            url,
        }
    }

    pub fn title(&self) -> String {
        if self.url.is_some() {
            format!(" MCP · {} asks you to open a link ", self.server)
        } else {
            format!(" MCP · {} asks for input ", self.server)
        }
    }

    fn on_actions(&self) -> bool {
        self.focus >= self.fields.len()
    }

    pub fn keys_hint(&self) -> String {
        if self.waiting {
            return "o reopen · Esc dismiss · Ctrl+C cancel".into();
        }
        if self.parked {
            return "Tab or Space returns to the card".into();
        }
        if self.editing {
            return "type · Enter/Tab done · Esc stop editing".into();
        }
        if self.on_actions() {
            "←/→ choose · Enter confirm · d decline · Esc park · Ctrl+C cancel".into()
        } else {
            "↑/↓ move · Space/Enter edit · d decline · Esc park · Ctrl+C cancel".into()
        }
    }

    /// Build the accepted content, or mark the fields that fail.
    fn content(&mut self) -> Result<Map<String, JsonValue>, usize> {
        let mut content = Map::new();
        let mut first_bad = None;
        for (index, field) in self.fields.iter().enumerate() {
            let value = match &self.values[index] {
                Value::Draft(draft) => elicit_form::draft_value(field, draft),
                Value::Bool(flag) => Ok(Some(json!(flag))),
                Value::Choice(selected, _) => Ok(selected.and_then(|i| match &field.kind {
                    Kind::Choice { options } => options.get(i).map(|(value, _)| json!(value)),
                    _ => None,
                })),
                Value::Multi(flags, _) => Ok(match &field.kind {
                    Kind::Multi { options, .. } => {
                        let picked: Vec<JsonValue> = options
                            .iter()
                            .zip(flags)
                            .filter(|(_, on)| **on)
                            .map(|((value, _), _)| json!(value))
                            .collect();
                        (!picked.is_empty() || field.required).then(|| JsonValue::Array(picked))
                    }
                    _ => None,
                }),
            };
            let checked = value.and_then(|value| {
                elicit_form::check_value(field, value.as_ref())?;
                Ok(value)
            });
            match checked {
                Ok(Some(value)) => {
                    content.insert(field.name.clone(), value);
                    self.errors[index] = None;
                }
                Ok(None) => self.errors[index] = None,
                Err(error) => {
                    self.errors[index] = Some(error);
                    first_bad.get_or_insert(index);
                }
            }
        }
        match first_bad {
            Some(index) => Err(index),
            None => Ok(content),
        }
    }

    fn move_focus(&mut self, forward: bool) {
        let count = self.fields.len() + 1;
        self.focus = if forward {
            (self.focus + 1) % count
        } else {
            (self.focus + count - 1) % count
        };
    }

    fn confirm(&mut self) -> ElicitAction {
        if self.button == Button::Decline {
            return ElicitAction::Answer(json!({"action": "decline"}));
        }
        if let Some(url) = &self.url {
            self.waiting = true;
            return ElicitAction::AcceptUrl(url.clone());
        }
        match self.content() {
            Ok(content) => ElicitAction::Answer(json!({"action": "accept", "content": content})),
            Err(index) => {
                self.focus = index;
                ElicitAction::Hint(format!(
                    "{}: {}",
                    self.fields[index].title,
                    self.errors[index].clone().unwrap_or_default()
                ))
            }
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> ElicitAction {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && key.code == KeyCode::Char('c') {
            return if self.waiting {
                ElicitAction::Dismiss
            } else {
                ElicitAction::Answer(json!({"action": "cancel"}))
            };
        }
        if self.waiting {
            return match key.code {
                KeyCode::Esc => ElicitAction::Dismiss,
                KeyCode::Char('o') => ElicitAction::Open(self.url.clone().unwrap_or_default()),
                _ => ElicitAction::None,
            };
        }
        if self.parked {
            if matches!(key.code, KeyCode::Tab | KeyCode::Char(' ')) {
                self.parked = false;
            }
            return ElicitAction::None;
        }
        if self.editing {
            let Some(Value::Draft(draft)) = self.values.get_mut(self.focus) else {
                self.editing = false;
                return ElicitAction::None;
            };
            match key.code {
                KeyCode::Esc => self.editing = false,
                KeyCode::Enter => self.editing = false,
                KeyCode::Tab => {
                    self.editing = false;
                    self.move_focus(true);
                }
                KeyCode::Backspace => {
                    draft.pop();
                }
                KeyCode::Char(c)
                    if !ctrl && draft.chars().count() < elicit_form::MAX_DRAFT_CHARS =>
                {
                    draft.push(c);
                }
                _ => {}
            }
            return ElicitAction::None;
        }
        match key.code {
            KeyCode::Up | KeyCode::Char('k') | KeyCode::BackTab => self.move_focus(false),
            KeyCode::Down | KeyCode::Char('j') | KeyCode::Tab => self.move_focus(true),
            KeyCode::Esc => {
                self.parked = true;
                return ElicitAction::Hint(
                    "keyboard parked; Tab or Space returns to the MCP card".into(),
                );
            }
            KeyCode::Char('d') => return ElicitAction::Answer(json!({"action": "decline"})),
            KeyCode::Char('o') if self.url.is_some() => {
                return ElicitAction::Open(self.url.clone().unwrap_or_default());
            }
            KeyCode::Left | KeyCode::Right | KeyCode::Char('h') | KeyCode::Char('l') => {
                let forward = matches!(key.code, KeyCode::Right | KeyCode::Char('l'));
                if self.on_actions() {
                    self.button = if self.button == Button::Accept {
                        Button::Decline
                    } else {
                        Button::Accept
                    };
                } else if let (
                    Some(Value::Choice(_, cursor) | Value::Multi(_, cursor)),
                    Some(field),
                ) = (self.values.get_mut(self.focus), self.fields.get(self.focus))
                {
                    let count = match &field.kind {
                        Kind::Choice { options } | Kind::Multi { options, .. } => options.len(),
                        _ => 1,
                    };
                    *cursor = if forward {
                        (*cursor + 1) % count
                    } else {
                        (*cursor + count - 1) % count
                    };
                }
            }
            KeyCode::Enter | KeyCode::Char(' ') => {
                if self.on_actions() {
                    if key.code == KeyCode::Char(' ') {
                        return ElicitAction::None;
                    }
                    return self.confirm();
                }
                match self.values.get_mut(self.focus) {
                    Some(Value::Draft(_)) => self.editing = true,
                    Some(Value::Bool(flag)) => *flag = !*flag,
                    Some(Value::Choice(selected, cursor)) => {
                        *selected = if *selected == Some(*cursor) {
                            None
                        } else {
                            Some(*cursor)
                        };
                    }
                    Some(Value::Multi(flags, cursor)) => {
                        if let Some(flag) = flags.get_mut(*cursor) {
                            *flag = !*flag;
                        }
                    }
                    None => {}
                }
            }
            _ => {}
        }
        ElicitAction::None
    }

    fn field_text(&self, index: usize) -> String {
        let field = &self.fields[index];
        match (&self.values[index], &field.kind) {
            (Value::Draft(draft), _) => {
                if self.editing && self.focus == index {
                    format!("{draft}▏")
                } else if draft.is_empty() {
                    "(empty)".into()
                } else {
                    draft.clone()
                }
            }
            (Value::Bool(flag), _) => {
                if *flag {
                    "[x] yes".into()
                } else {
                    "[ ] no".into()
                }
            }
            (Value::Choice(selected, cursor), Kind::Choice { options }) => options
                .iter()
                .enumerate()
                .map(|(i, (_, label))| {
                    let mark = if *selected == Some(i) { "(•)" } else { "( )" };
                    if i == *cursor && self.focus == index {
                        format!("›{mark} {label}")
                    } else {
                        format!(" {mark} {label}")
                    }
                })
                .collect::<Vec<_>>()
                .join(" "),
            (Value::Multi(flags, cursor), Kind::Multi { options, .. }) => options
                .iter()
                .enumerate()
                .map(|(i, (_, label))| {
                    let mark = if flags.get(i).copied().unwrap_or(false) {
                        "[x]"
                    } else {
                        "[ ]"
                    };
                    if i == *cursor && self.focus == index {
                        format!("›{mark} {label}")
                    } else {
                        format!(" {mark} {label}")
                    }
                })
                .collect::<Vec<_>>()
                .join(" "),
            _ => String::new(),
        }
    }

    /// Rows of the card body: `(text, focused)`.
    pub fn lines(&self, width: usize) -> Vec<(String, bool)> {
        let mut out = Vec::new();
        for line in wrap(&self.message, width.max(10)) {
            out.push((line, false));
        }
        out.push((String::new(), false));
        if let Some(url) = &self.url {
            out.push((format!("  {url}"), false));
            out.push((String::new(), false));
            if self.waiting {
                out.push((
                    format!("Waiting for {} to finish in the browser…", self.server),
                    false,
                ));
                return out;
            }
            out.push(("Accept opens this link in your browser.".into(), false));
        }
        for (index, field) in self.fields.iter().enumerate() {
            let focused = self.focus == index && !self.parked;
            let star = if field.required { "*" } else { "" };
            out.push((
                format!(
                    "{} {}{star}: {}",
                    if focused { "›" } else { " " },
                    field.title,
                    self.field_text(index)
                ),
                focused,
            ));
            if let Some(description) = &field.description
                && focused
            {
                out.push((format!("    {description}"), false));
            }
            if let Some(error) = &self.errors[index] {
                out.push((format!("    ! {error}"), false));
            }
        }
        let focused = self.on_actions() && !self.parked;
        let (accept, decline) = match (focused, self.button) {
            (true, Button::Accept) => ("[ Accept ]", "  Decline  "),
            (true, Button::Decline) => ("  Accept  ", "[ Decline ]"),
            _ => ("  Accept  ", "  Decline  "),
        };
        out.push((String::new(), false));
        out.push((format!("  {accept}  {decline}"), focused));
        out
    }

    pub fn height(&self, width: usize) -> u16 {
        (self.lines(width).len() as u16).saturating_add(2)
    }
}

/// Greedy word wrap by display width (long words are split).
fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut out = Vec::new();
    for paragraph in text.lines() {
        let mut line = String::new();
        for word in paragraph.split(' ') {
            let candidate = if line.is_empty() {
                word.to_string()
            } else {
                format!("{line} {word}")
            };
            if candidate.width() <= width {
                line = candidate;
                continue;
            }
            if !line.is_empty() {
                out.push(std::mem::take(&mut line));
            }
            let mut rest = word.to_string();
            while rest.width() > width {
                let mut head = String::new();
                for c in rest.chars() {
                    if head.width() + unicode_width::UnicodeWidthChar::width(c).unwrap_or(0) > width
                    {
                        break;
                    }
                    head.push(c);
                }
                if head.is_empty() {
                    break;
                }
                rest = rest[head.len()..].to_string();
                out.push(head);
            }
            line = rest;
        }
        out.push(line);
    }
    out
}

fn clip(text: &str, width: usize) -> String {
    if text.width() <= width {
        return text.to_string();
    }
    let mut out = String::new();
    for c in text.chars() {
        if out.width() + unicode_width::UnicodeWidthChar::width(c).unwrap_or(0) + 1 > width {
            break;
        }
        out.push(c);
    }
    out.push('…');
    out
}

pub fn render(frame: &mut Frame, area: Rect, card: &ElicitCard, theme: &crate::theme::Theme) {
    if area.height < 4 || area.width < 16 {
        return;
    }
    let inner_width = area.width.saturating_sub(2) as usize;
    let height = card.height(inner_width).min(area.height);
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
        .title(card.title())
        .title_bottom(format!(" {} ", card.keys_hint()))
        .border_style(Style::default().fg(border))
        .style(Style::default().fg(theme.text_primary).bg(theme.bg_base));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let lines = card.lines(inner.width as usize);
    let rows = inner.height as usize;
    let focus_line = lines.iter().position(|(_, focused)| *focused).unwrap_or(0);
    let start = if lines.len() <= rows {
        0
    } else {
        focus_line
            .saturating_sub(rows.saturating_sub(2))
            .min(lines.len() - rows)
    };
    let body: Vec<Line> = lines
        .iter()
        .skip(start)
        .take(rows)
        .map(|(text, focused)| {
            let text = clip(text, inner.width as usize);
            if *focused {
                Line::styled(
                    text,
                    Style::default()
                        .bg(theme.bg_highlight)
                        .add_modifier(Modifier::BOLD),
                )
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
    use crossterm::event::KeyEventKind;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent {
            code,
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Press,
            state: crossterm::event::KeyEventState::NONE,
        }
    }

    fn card(params: JsonValue) -> ElicitCard {
        ElicitCard::new(&Elicitation {
            id: "e1".into(),
            run_dir: std::path::PathBuf::new(),
            server: "demo".into(),
            session_id: None,
            request: elicit_form::check_request(&params).unwrap(),
        })
    }

    fn form() -> ElicitCard {
        card(
            json!({"message": "Tell me", "requestedSchema": {"type": "object", "properties": {
            "name": {"type": "string", "title": "Name"},
            "age": {"type": "integer", "minimum": 1},
            "tea": {"type": "boolean"},
            "color": {"type": "string", "enum": ["red", "blue"]}
        }, "required": ["name"]}}),
        )
    }

    #[test]
    fn a_form_validates_before_it_submits() {
        let mut card = form();
        assert!(card.title().contains("demo"));
        // Straight to Accept with the required name empty.
        for _ in 0..4 {
            card.handle_key(key(KeyCode::Down));
        }
        assert!(
            matches!(card.handle_key(key(KeyCode::Enter)), ElicitAction::Hint(text) if text.contains("required"))
        );
        let name = card.focus;
        assert_eq!(
            card.fields[name].name, "name",
            "the invalid required field takes focus"
        );
        // Fields are sorted by name: age, color, name, tea.
        let position =
            |card: &ElicitCard, n: &str| card.fields.iter().position(|f| f.name == n).unwrap();
        card.focus = position(&card, "name");
        card.handle_key(key(KeyCode::Enter));
        for c in "Ann".chars() {
            card.handle_key(key(KeyCode::Char(c)));
        }
        card.handle_key(key(KeyCode::Enter));
        card.focus = position(&card, "age");
        card.handle_key(key(KeyCode::Enter));
        card.handle_key(key(KeyCode::Char('0')));
        card.handle_key(key(KeyCode::Esc));
        card.focus = card.fields.len();
        assert!(
            matches!(card.handle_key(key(KeyCode::Enter)), ElicitAction::Hint(text) if text.contains("at least"))
        );
        card.focus = position(&card, "age");
        card.handle_key(key(KeyCode::Enter));
        card.handle_key(key(KeyCode::Backspace));
        card.handle_key(key(KeyCode::Char('7')));
        card.handle_key(key(KeyCode::Esc));
        card.focus = position(&card, "tea");
        card.handle_key(key(KeyCode::Char(' ')));
        card.focus = position(&card, "color");
        card.handle_key(key(KeyCode::Right));
        card.handle_key(key(KeyCode::Enter));
        card.focus = card.fields.len();
        let action = card.handle_key(key(KeyCode::Enter));
        assert_eq!(
            action,
            ElicitAction::Answer(
                json!({"action": "accept", "content": {"name": "Ann", "age": 7, "tea": true, "color": "blue"}})
            )
        );
    }

    #[test]
    fn decline_cancel_and_park() {
        let mut card = form();
        assert_eq!(
            card.handle_key(key(KeyCode::Char('d'))),
            ElicitAction::Answer(json!({"action": "decline"}))
        );
        let ctrl_c = KeyEvent {
            modifiers: KeyModifiers::CONTROL,
            ..key(KeyCode::Char('c'))
        };
        assert_eq!(
            card.handle_key(ctrl_c),
            ElicitAction::Answer(json!({"action": "cancel"}))
        );
        card.handle_key(key(KeyCode::Esc));
        assert!(card.parked);
        assert_eq!(card.handle_key(key(KeyCode::Char('d'))), ElicitAction::None);
        card.handle_key(key(KeyCode::Tab));
        assert!(!card.parked);
        card.focus = card.fields.len();
        card.handle_key(key(KeyCode::Right));
        assert_eq!(
            card.handle_key(key(KeyCode::Enter)),
            ElicitAction::Answer(json!({"action": "decline"}))
        );
    }

    #[test]
    fn a_url_card_opens_waits_and_dismisses() {
        let mut card = card(
            json!({"message": "Sign in", "mode": "url", "url": "https://auth.test/x", "elicitationId": "el"}),
        );
        assert!(card.title().contains("open a link"));
        assert_eq!(
            card.handle_key(key(KeyCode::Enter)),
            ElicitAction::AcceptUrl("https://auth.test/x".into())
        );
        assert!(card.waiting);
        assert_eq!(
            card.handle_key(key(KeyCode::Char('o'))),
            ElicitAction::Open("https://auth.test/x".into())
        );
        assert_eq!(card.handle_key(key(KeyCode::Esc)), ElicitAction::Dismiss);
    }
}
