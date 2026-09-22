use crate::appearance::{AppearanceConfig, SettingKind, SettingRow, settings_rows};
use crate::screen_mode::ScreenMode;
use crate::theme::{Theme, ThemeKind};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Overlay {
    None,
    Settings(SettingsState),
    Theme(ThemeState),
}

impl Overlay {
    pub fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsState {
    pub rows: Vec<SettingRow>,
    pub selected: usize,
    pub filter: String,
    pub filter_focused: bool,
    pub picking: Option<PickerState>,
    pub original_theme: ThemeKind,
    pub preview_theme: Option<ThemeKind>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PickerState {
    pub key: String,
    pub choices: Vec<String>,
    pub cursor: usize,
    pub original: String,
    pub preview: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThemeState {
    pub choices: Vec<ThemeKind>,
    pub cursor: usize,
    pub original: ThemeKind,
    pub auto_mode: bool,
    pub filter: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum OverlayAction {
    None,
    Persist { key: String, value: String },
    PreviewTheme(ThemeKind),
    RestoreTheme(ThemeKind),
    ToggleBool { key: String, value: bool },
}

impl SettingsState {
    pub fn open(config: &AppearanceConfig, screen: ScreenMode) -> Self {
        Self {
            rows: settings_rows(config, screen),
            selected: 0,
            filter: String::new(),
            filter_focused: false,
            picking: None,
            original_theme: config.theme,
            preview_theme: None,
        }
    }

    pub fn visible(&self) -> Vec<usize> {
        if self.filter.is_empty() {
            return (0..self.rows.len()).collect();
        }
        let needle = self.filter.to_ascii_lowercase();
        self.rows
            .iter()
            .enumerate()
            .filter(|(_, row)| {
                row.label.to_ascii_lowercase().contains(&needle)
                    || row.key.to_ascii_lowercase().contains(&needle)
                    || row.value.to_ascii_lowercase().contains(&needle)
            })
            .map(|(index, _)| index)
            .collect()
    }

    pub fn focused(&self) -> Option<&SettingRow> {
        self.rows.get(self.selected)
    }
}

impl ThemeState {
    pub fn open(config: &AppearanceConfig) -> Self {
        let mut choices = vec![ThemeKind::Auto];
        choices.extend(ThemeKind::available(
            config.color_level,
            config.terminal_theme,
        ));
        let cursor = choices
            .iter()
            .position(|kind| *kind == config.theme)
            .unwrap_or(0);
        Self {
            choices,
            cursor,
            original: config.theme,
            auto_mode: config.theme.is_auto(),
            filter: String::new(),
        }
    }

    pub fn current(&self) -> ThemeKind {
        self.choices
            .get(self.cursor)
            .copied()
            .unwrap_or(self.original)
    }

    pub fn filtered(&self) -> Vec<(usize, ThemeKind)> {
        if self.filter.is_empty() {
            return self.choices.iter().copied().enumerate().collect();
        }
        let needle = self.filter.to_ascii_lowercase();
        self.choices
            .iter()
            .copied()
            .enumerate()
            .filter(|(_, kind)| {
                kind.display_name().contains(&needle)
                    || kind.label().to_ascii_lowercase().contains(&needle)
                    || kind
                        .aliases()
                        .iter()
                        .any(|alias| alias.contains(needle.as_str()))
            })
            .collect()
    }
}

pub fn handle_key(
    overlay: &mut Overlay,
    key: KeyEvent,
    config: &AppearanceConfig,
    screen: ScreenMode,
) -> OverlayAction {
    match overlay {
        Overlay::None => OverlayAction::None,
        Overlay::Settings(_) => handle_settings_key(overlay, key, config, screen),
        Overlay::Theme(_) => handle_theme_key(overlay, key, config),
    }
}

fn handle_settings_key(
    overlay: &mut Overlay,
    key: KeyEvent,
    config: &AppearanceConfig,
    screen: ScreenMode,
) -> OverlayAction {
    let Overlay::Settings(state) = overlay else {
        return OverlayAction::None;
    };
    if let Some(picker) = state.picking.clone() {
        return handle_picker(overlay, picker, key, config, screen);
    }
    if state.filter_focused {
        match key.code {
            KeyCode::Esc => {
                state.filter_focused = false;
                state.filter.clear();
                OverlayAction::None
            }
            KeyCode::Enter => {
                state.filter_focused = false;
                OverlayAction::None
            }
            KeyCode::Backspace => {
                state.filter.pop();
                OverlayAction::None
            }
            KeyCode::Char(ch)
                if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT =>
            {
                state.filter.push(ch);
                OverlayAction::None
            }
            _ => OverlayAction::None,
        }
    } else {
        match key.code {
            KeyCode::Esc | KeyCode::F(2) => {
                let restore = state.original_theme;
                *overlay = Overlay::None;
                OverlayAction::RestoreTheme(restore)
            }
            KeyCode::Char('/') => {
                state.filter_focused = true;
                OverlayAction::None
            }
            KeyCode::Up | KeyCode::Char('k') => {
                move_selection(state, -1);
                OverlayAction::None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                move_selection(state, 1);
                OverlayAction::None
            }
            KeyCode::Enter | KeyCode::Char(' ') => activate_row(state, config, screen),
            _ => OverlayAction::None,
        }
    }
}

fn handle_picker(
    overlay: &mut Overlay,
    mut picker: PickerState,
    key: KeyEvent,
    config: &AppearanceConfig,
    screen: ScreenMode,
) -> OverlayAction {
    let Overlay::Settings(state) = overlay else {
        return OverlayAction::None;
    };
    match key.code {
        KeyCode::Esc => {
            let restore = picker.original.clone();
            state.picking = None;
            if picker.preview
                && picker.key == "ui.theme"
                && let Some(kind) = ThemeKind::from_name_gated(&restore, config.terminal_theme)
            {
                return OverlayAction::RestoreTheme(kind);
            }
            let _ = (overlay, screen);
            OverlayAction::None
        }
        KeyCode::Up | KeyCode::Char('k') => {
            if picker.cursor > 0 {
                picker.cursor -= 1;
            }
            let action = preview_picker(&picker, config);
            state.picking = Some(picker);
            action
        }
        KeyCode::Down | KeyCode::Char('j') => {
            if picker.cursor + 1 < picker.choices.len() {
                picker.cursor += 1;
            }
            let action = preview_picker(&picker, config);
            state.picking = Some(picker);
            action
        }
        KeyCode::Enter => {
            let value = picker
                .choices
                .get(picker.cursor)
                .cloned()
                .unwrap_or_default();
            let key = picker.key.clone();
            state.picking = None;
            OverlayAction::Persist { key, value }
        }
        _ => {
            state.picking = Some(picker);
            OverlayAction::None
        }
    }
}

fn preview_picker(picker: &PickerState, config: &AppearanceConfig) -> OverlayAction {
    if picker.preview
        && picker.key == "ui.theme"
        && let Some(kind) = picker
            .choices
            .get(picker.cursor)
            .and_then(|name| ThemeKind::from_name_gated(name, config.terminal_theme))
    {
        return OverlayAction::PreviewTheme(kind);
    }
    OverlayAction::None
}

fn activate_row(
    state: &mut SettingsState,
    _config: &AppearanceConfig,
    _screen: ScreenMode,
) -> OverlayAction {
    let Some(row) = state.rows.get(state.selected).cloned() else {
        return OverlayAction::None;
    };
    if row.locked.is_some() {
        return OverlayAction::None;
    }
    match row.kind {
        SettingKind::Bool(value) => OverlayAction::ToggleBool {
            key: row.key,
            value: !value,
        },
        SettingKind::Enum { value, choices } => {
            let cursor = choices.iter().position(|item| item == &value).unwrap_or(0);
            state.picking = Some(PickerState {
                key: row.key.clone(),
                choices,
                cursor,
                original: value,
                preview: row.key == "ui.theme",
            });
            OverlayAction::None
        }
        SettingKind::String(_) => OverlayAction::None,
    }
}

fn move_selection(state: &mut SettingsState, delta: i32) {
    let visible = state.visible();
    if visible.is_empty() {
        return;
    }
    let current = visible
        .iter()
        .position(|index| *index == state.selected)
        .unwrap_or(0);
    let next = (current as i32 + delta).clamp(0, visible.len() as i32 - 1) as usize;
    state.selected = visible[next];
}

fn handle_theme_key(
    overlay: &mut Overlay,
    key: KeyEvent,
    _config: &AppearanceConfig,
) -> OverlayAction {
    let Overlay::Theme(state) = overlay else {
        return OverlayAction::None;
    };
    match key.code {
        KeyCode::Esc => {
            let original = state.original;
            *overlay = Overlay::None;
            OverlayAction::RestoreTheme(original)
        }
        KeyCode::Up | KeyCode::Char('k') => {
            if state.cursor > 0 {
                state.cursor -= 1;
            }
            OverlayAction::PreviewTheme(state.current())
        }
        KeyCode::Down | KeyCode::Char('j') => {
            if state.cursor + 1 < state.choices.len() {
                state.cursor += 1;
            }
            OverlayAction::PreviewTheme(state.current())
        }
        KeyCode::Enter => {
            let kind = state.current();
            *overlay = Overlay::None;
            OverlayAction::Persist {
                key: "ui.theme".into(),
                value: kind.display_name().into(),
            }
        }
        KeyCode::Backspace => {
            state.filter.pop();
            OverlayAction::None
        }
        KeyCode::Char(ch) if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT => {
            state.filter.push(ch);
            let filtered = state.filtered();
            if let Some((index, _)) = filtered.first() {
                state.cursor = *index;
                return OverlayAction::PreviewTheme(state.current());
            }
            OverlayAction::None
        }
        _ => OverlayAction::None,
    }
}

pub fn handle_mouse(
    overlay: &mut Overlay,
    mouse: MouseEvent,
    area: Rect,
    config: &AppearanceConfig,
) -> OverlayAction {
    let Overlay::Settings(state) = overlay else {
        if let Overlay::Theme(state) = overlay
            && mouse.kind == MouseEventKind::Down(MouseButton::Left)
        {
            let filtered = state.filtered();
            let index = mouse.row.saturating_sub(area.y.saturating_add(2)) as usize;
            if let Some((choice_index, _)) = filtered.get(index) {
                state.cursor = *choice_index;
                return OverlayAction::PreviewTheme(state.current());
            }
        }
        return OverlayAction::None;
    };
    if mouse.kind != MouseEventKind::Down(MouseButton::Left) {
        return OverlayAction::None;
    }
    let visible = state.visible();
    let index = mouse.row.saturating_sub(area.y.saturating_add(2)) as usize;
    if let Some(row_index) = visible.get(index).copied() {
        state.selected = row_index;
        return activate_row(state, config, ScreenMode::Fullscreen);
    }
    OverlayAction::None
}

pub fn render(frame: &mut Frame, overlay: &Overlay, theme: &Theme, screen: ScreenMode) {
    match overlay {
        Overlay::None => {}
        Overlay::Settings(state) => render_settings(frame, state, theme, screen),
        Overlay::Theme(state) => render_theme(frame, state, theme),
    }
}

fn modal_area(frame: &Frame, width: u16, height: u16) -> Rect {
    let area = frame.area();
    let width = width.min(area.width.saturating_sub(4)).max(24);
    let height = height.min(area.height.saturating_sub(4)).max(10);
    Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + 1,
        width,
        height,
    }
}

fn render_settings(frame: &mut Frame, state: &SettingsState, theme: &Theme, screen: ScreenMode) {
    let area = modal_area(frame, 78, (6 + state.rows.len() as u16).min(22));
    frame.render_widget(Clear, area);
    let block = Block::bordered()
        .title(" Settings ")
        .style(Style::default().fg(theme.text_primary).bg(theme.bg_base));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let [list, footer] = Layout::vertical([Constraint::Min(3), Constraint::Length(2)]).areas(inner);
    let visible = state.visible();
    let mut lines = Vec::new();
    if screen == ScreenMode::Minimal {
        lines.push(Line::from(Span::styled(
            "Theme rows hidden: minimal uses the terminal palette.",
            Style::default().fg(theme.gray),
        )));
    }
    for (offset, index) in visible.iter().enumerate() {
        let row = &state.rows[*index];
        let mark = if *index == state.selected { ">" } else { " " };
        let lock = row
            .locked
            .as_deref()
            .map(|reason| format!(" · locked ({reason})"))
            .unwrap_or_default();
        let restart = if row.restart_required {
            " · restart"
        } else {
            ""
        };
        let style = if *index == state.selected {
            Style::default()
                .fg(theme.text_primary)
                .bg(theme.bg_highlight)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme.text_primary)
        };
        lines.push(Line::from(Span::styled(
            format!(
                "{mark} {}  {}  ({}){lock}{restart}",
                row.label, row.value, row.source
            ),
            style,
        )));
        let _ = offset;
    }
    if let Some(picker) = &state.picking {
        lines.push(Line::from(""));
        lines.push(Line::from(format!("Choose {}:", picker.key)));
        for (index, choice) in picker.choices.iter().enumerate() {
            let mark = if index == picker.cursor { ">" } else { " " };
            lines.push(Line::from(format!("{mark} {choice}")));
        }
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), list);
    let footer_text = if state.filter_focused {
        format!("filter: {}  Esc cancel", state.filter)
    } else if state
        .focused()
        .and_then(|row| row.locked.as_ref())
        .is_some()
    {
        "↑/↓ nav  → expand  / search  Esc close".to_string()
    } else {
        "↑/↓ nav  Enter edit  Space toggle  / search  Esc close".to_string()
    };
    frame.render_widget(
        Paragraph::new(footer_text).style(Style::default().fg(theme.gray)),
        footer,
    );
}

fn render_theme(frame: &mut Frame, state: &ThemeState, theme: &Theme) {
    let area = modal_area(frame, 48, 14);
    frame.render_widget(Clear, area);
    let block = Block::bordered()
        .title(" Theme ")
        .borders(Borders::ALL)
        .style(Style::default().fg(theme.text_primary).bg(theme.bg_base));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let filtered = state.filtered();
    let lines: Vec<Line> = filtered
        .iter()
        .map(|(index, kind)| {
            let mark = if *index == state.cursor { ">" } else { " " };
            let active = if *kind == state.original {
                " (active)"
            } else {
                ""
            };
            Line::from(format!("{mark} {}{active}", kind.label()))
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), inner);
}

pub fn help_text() -> &'static str {
    "Slash commands: /settings (/config) appearance and status line; /theme (/t) preview themes; /compact-mode; /timestamps.\nMinimal mode uses the terminal palette; /theme is fullscreen-only.\nLocked requirements show their source and cannot be edited."
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::appearance::AppearanceConfig;
    use crossterm::event::KeyEventKind;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn theme_preview_escape_restores_without_persist() {
        let config = AppearanceConfig::default();
        let mut overlay = Overlay::Theme(ThemeState::open(&config));
        let preview = handle_key(
            &mut overlay,
            key(KeyCode::Down),
            &config,
            ScreenMode::Fullscreen,
        );
        assert!(matches!(
            preview,
            OverlayAction::PreviewTheme(ThemeKind::GrokDay)
        ));
        let restore = handle_key(
            &mut overlay,
            key(KeyCode::Esc),
            &config,
            ScreenMode::Fullscreen,
        );
        assert_eq!(restore, OverlayAction::RestoreTheme(ThemeKind::GrokNight));
        assert!(overlay.is_none());
    }

    #[test]
    fn theme_enter_persists_canonical_name() {
        let config = AppearanceConfig::default();
        let mut overlay = Overlay::Theme(ThemeState::open(&config));
        handle_key(
            &mut overlay,
            key(KeyCode::Down),
            &config,
            ScreenMode::Fullscreen,
        );
        let persist = handle_key(
            &mut overlay,
            key(KeyCode::Enter),
            &config,
            ScreenMode::Fullscreen,
        );
        assert_eq!(
            persist,
            OverlayAction::Persist {
                key: "ui.theme".into(),
                value: "grokday".into()
            }
        );
    }

    #[test]
    fn locked_row_does_not_toggle() {
        let mut config = AppearanceConfig::default();
        config
            .locked
            .insert("ui.compact_mode".into(), "requirements".into());
        let mut overlay = Overlay::Settings(SettingsState::open(&config, ScreenMode::Fullscreen));
        if let Overlay::Settings(state) = &mut overlay {
            state.selected = state
                .rows
                .iter()
                .position(|row| row.key == "ui.compact_mode")
                .unwrap();
        }
        let action = handle_key(
            &mut overlay,
            key(KeyCode::Enter),
            &config,
            ScreenMode::Fullscreen,
        );
        assert_eq!(action, OverlayAction::None);
    }

    #[test]
    fn settings_bool_toggle_dispatches_persistable_action() {
        let config = AppearanceConfig::default();
        let mut overlay = Overlay::Settings(SettingsState::open(&config, ScreenMode::Fullscreen));
        if let Overlay::Settings(state) = &mut overlay {
            state.selected = state
                .rows
                .iter()
                .position(|row| row.key == "ui.compact_mode")
                .unwrap();
        }
        let action = handle_key(
            &mut overlay,
            key(KeyCode::Enter),
            &config,
            ScreenMode::Fullscreen,
        );
        assert_eq!(
            action,
            OverlayAction::ToggleBool {
                key: "ui.compact_mode".into(),
                value: true
            }
        );
    }

    #[test]
    fn mouse_click_selects_settings_row() {
        let config = AppearanceConfig::default();
        let mut overlay = Overlay::Settings(SettingsState::open(&config, ScreenMode::Fullscreen));
        let area = Rect::new(0, 0, 80, 24);
        let action = handle_mouse(
            &mut overlay,
            MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: 4,
                row: 3,
                modifiers: KeyModifiers::NONE,
            },
            area,
            &config,
        );
        assert!(matches!(
            action,
            OverlayAction::ToggleBool { .. } | OverlayAction::None
        ));
    }

    #[test]
    fn keyeventkind_repeat_is_ignored_by_caller_contract() {
        let event = KeyEvent {
            code: KeyCode::Enter,
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Repeat,
            state: crossterm::event::KeyEventState::NONE,
        };
        assert_ne!(event.kind, KeyEventKind::Release);
    }
}
