use crate::appearance::{AppearanceConfig, SettingKind, SettingRow, settings_rows};
use crate::screen_mode::ScreenMode;
use crate::theme::{Theme, ThemeKind};
use crossterm::event::{
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};

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
    pub editing: Option<StringEdit>,
    pub original_theme: ThemeKind,
    pub preview_theme: Option<ThemeKind>,
    pub list_area: Rect,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StringEdit {
    pub key: String,
    pub buffer: String,
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
    pub list_area: Rect,
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
            editing: None,
            original_theme: config.theme,
            preview_theme: None,
            list_area: Rect::default(),
        }
    }

    pub fn refresh(&mut self, config: &AppearanceConfig, screen: ScreenMode) {
        let key = self.focused().map(|row| row.key.clone());
        let selected = self.selected;
        self.rows = settings_rows(config, screen);
        self.picking = None;
        self.editing = None;
        if let Some(key) = key
            && let Some(index) = self.rows.iter().position(|row| row.key == key)
        {
            self.selected = index;
        } else if !self.rows.is_empty() {
            self.selected = selected.min(self.rows.len() - 1);
        } else {
            self.selected = 0;
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
            list_area: Rect::default(),
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
    if key.kind != KeyEventKind::Press {
        return OverlayAction::None;
    }
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
    if let Some(edit) = state.editing.clone() {
        return handle_string_edit(state, edit, key);
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
                let restore = state.preview_theme.map(|_| state.original_theme);
                *overlay = Overlay::None;
                match restore {
                    Some(kind) => OverlayAction::RestoreTheme(kind),
                    None => OverlayAction::None,
                }
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
            if let OverlayAction::PreviewTheme(kind) = action {
                state.preview_theme = Some(kind);
            }
            state.picking = Some(picker);
            action
        }
        KeyCode::Down | KeyCode::Char('j') => {
            if picker.cursor + 1 < picker.choices.len() {
                picker.cursor += 1;
            }
            let action = preview_picker(&picker, config);
            if let OverlayAction::PreviewTheme(kind) = action {
                state.preview_theme = Some(kind);
            }
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
            if key == "ui.theme" {
                state.preview_theme = None;
                state.original_theme = ThemeKind::from_name_gated(&value, config.terminal_theme)
                    .unwrap_or(state.original_theme);
            }
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
        SettingKind::String(value) => {
            state.editing = Some(StringEdit {
                key: row.key,
                buffer: value,
            });
            OverlayAction::None
        }
    }
}

fn handle_string_edit(
    state: &mut SettingsState,
    mut edit: StringEdit,
    key: KeyEvent,
) -> OverlayAction {
    match key.code {
        KeyCode::Esc => {
            state.editing = None;
            OverlayAction::None
        }
        KeyCode::Enter => {
            state.editing = None;
            OverlayAction::Persist {
                key: edit.key,
                value: edit.buffer,
            }
        }
        KeyCode::Backspace => {
            edit.buffer.pop();
            state.editing = Some(edit);
            OverlayAction::None
        }
        KeyCode::Char(ch) if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT => {
            edit.buffer.push(ch);
            state.editing = Some(edit);
            OverlayAction::None
        }
        _ => {
            state.editing = Some(edit);
            OverlayAction::None
        }
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
    _area: Rect,
    config: &AppearanceConfig,
) -> OverlayAction {
    if mouse.kind != MouseEventKind::Down(MouseButton::Left) {
        return OverlayAction::None;
    }
    match overlay {
        Overlay::Theme(state) => {
            let list = state.list_area;
            if list.height == 0 || !point_in(list, mouse.column, mouse.row) {
                return OverlayAction::None;
            }
            let filtered = state.filtered();
            let index = mouse.row.saturating_sub(list.y) as usize;
            if let Some((choice_index, _)) = filtered.get(index) {
                state.cursor = *choice_index;
                return OverlayAction::PreviewTheme(state.current());
            }
            OverlayAction::None
        }
        Overlay::Settings(state) => {
            let list = state.list_area;
            if list.height == 0 || !point_in(list, mouse.column, mouse.row) {
                return OverlayAction::None;
            }
            let visible = state.visible();
            let banner = usize::from(state.rows.iter().all(|row| row.key != "ui.theme"));
            let index = mouse.row.saturating_sub(list.y) as usize;
            let index = index.saturating_sub(banner);
            if let Some(row_index) = visible.get(index).copied() {
                state.selected = row_index;
                return activate_row(state, config, ScreenMode::Fullscreen);
            }
            OverlayAction::None
        }
        Overlay::None => OverlayAction::None,
    }
}

fn point_in(area: Rect, x: u16, y: u16) -> bool {
    x >= area.x
        && x < area.x.saturating_add(area.width)
        && y >= area.y
        && y < area.y.saturating_add(area.height)
}

pub fn render(frame: &mut Frame, overlay: &mut Overlay, theme: &Theme, screen: ScreenMode) {
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

fn render_settings(
    frame: &mut Frame,
    state: &mut SettingsState,
    theme: &Theme,
    screen: ScreenMode,
) {
    let area = modal_area(frame, 78, (6 + state.rows.len() as u16).min(22));
    frame.render_widget(Clear, area);
    let block = Block::bordered()
        .title(" Settings ")
        .style(Style::default().fg(theme.text_primary).bg(theme.bg_base));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let [list, footer] = Layout::vertical([Constraint::Min(3), Constraint::Length(2)]).areas(inner);
    state.list_area = list;
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
    if let Some(edit) = &state.editing {
        lines.push(Line::from(""));
        lines.push(Line::from(format!("Edit {}: {}_", edit.key, edit.buffer)));
    }
    // One SettingRow per terminal row so mouse hit-testing matches the painted list.
    frame.render_widget(Paragraph::new(lines), list);
    let footer_text = if state.filter_focused {
        format!("filter: {}  Esc cancel", state.filter)
    } else if state.editing.is_some() {
        "type value  Enter save  Esc cancel".to_string()
    } else if state
        .focused()
        .and_then(|row| row.locked.as_ref())
        .is_some()
    {
        "↑/↓ nav  → expand  / search  Esc close".to_string()
    } else if matches!(
        state.focused().map(|row| &row.kind),
        Some(SettingKind::String(_))
    ) {
        "↑/↓ nav  Enter edit  / search  Esc close".to_string()
    } else {
        "↑/↓ nav  Enter edit  Space toggle  / search  Esc close".to_string()
    };
    frame.render_widget(
        Paragraph::new(footer_text).style(Style::default().fg(theme.gray)),
        footer,
    );
}

fn render_theme(frame: &mut Frame, state: &mut ThemeState, theme: &Theme) {
    let area = modal_area(frame, 48, 14);
    frame.render_widget(Clear, area);
    let block = Block::bordered()
        .title(" Theme ")
        .borders(Borders::ALL)
        .style(Style::default().fg(theme.text_primary).bg(theme.bg_base));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    state.list_area = inner;
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
    fn refresh_rebuilds_rows_after_bool_change() {
        let mut config = AppearanceConfig::default();
        let mut overlay = Overlay::Settings(SettingsState::open(&config, ScreenMode::Fullscreen));
        if let Overlay::Settings(state) = &overlay {
            let compact = state
                .rows
                .iter()
                .find(|row| row.key == "ui.compact_mode")
                .unwrap();
            assert_eq!(compact.value, "off");
        }
        config.compact_mode = true;
        if let Overlay::Settings(state) = &mut overlay {
            state.refresh(&config, ScreenMode::Fullscreen);
            let compact = state
                .rows
                .iter()
                .find(|row| row.key == "ui.compact_mode")
                .unwrap();
            assert_eq!(compact.value, "on");
        }
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
    fn mouse_click_toggles_compact_mode_on_list_rect() {
        let config = AppearanceConfig::default();
        let mut overlay = Overlay::Settings(SettingsState::open(&config, ScreenMode::Fullscreen));
        if let Overlay::Settings(state) = &mut overlay {
            state.list_area = Rect::new(10, 4, 60, 12);
            state.selected = 0;
        }
        let action = handle_mouse(
            &mut overlay,
            MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: 12,
                row: 4,
                modifiers: KeyModifiers::NONE,
            },
            Rect::new(0, 0, 80, 24),
            &config,
        );
        assert_eq!(
            action,
            OverlayAction::ToggleBool {
                key: "ui.compact_mode".into(),
                value: true
            }
        );
        let miss = handle_mouse(
            &mut overlay,
            MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: 1,
                row: 1,
                modifiers: KeyModifiers::NONE,
            },
            Rect::new(0, 0, 80, 24),
            &config,
        );
        assert_eq!(miss, OverlayAction::None);
    }

    #[test]
    fn string_row_enter_edits_and_enter_persists() {
        let mut config = AppearanceConfig::default();
        config.status_line.kind = crate::appearance::StatusLineKind::Command;
        config.status_line.command = Some("/tmp/status.sh".into());
        let mut overlay = Overlay::Settings(SettingsState::open(&config, ScreenMode::Fullscreen));
        if let Overlay::Settings(state) = &mut overlay {
            state.selected = state
                .rows
                .iter()
                .position(|row| row.key == "ui.status_line.command")
                .unwrap();
        }
        let action = handle_key(
            &mut overlay,
            key(KeyCode::Enter),
            &config,
            ScreenMode::Fullscreen,
        );
        assert_eq!(action, OverlayAction::None);
        let persist = handle_key(
            &mut overlay,
            key(KeyCode::Enter),
            &config,
            ScreenMode::Fullscreen,
        );
        assert_eq!(
            persist,
            OverlayAction::Persist {
                key: "ui.status_line.command".into(),
                value: "/tmp/status.sh".into()
            }
        );
    }

    #[test]
    fn settings_escape_after_theme_persist_does_not_restore() {
        let mut config = AppearanceConfig::default();
        let mut overlay = Overlay::Settings(SettingsState::open(&config, ScreenMode::Fullscreen));
        if let Overlay::Settings(state) = &mut overlay {
            state.selected = state
                .rows
                .iter()
                .position(|row| row.key == "ui.theme")
                .unwrap();
        }
        handle_key(
            &mut overlay,
            key(KeyCode::Enter),
            &config,
            ScreenMode::Fullscreen,
        );
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
        assert!(matches!(
            persist,
            OverlayAction::Persist { ref key, .. } if key == "ui.theme"
        ));
        config.theme = ThemeKind::GrokDay;
        if let Overlay::Settings(state) = &mut overlay {
            state.refresh(&config, ScreenMode::Fullscreen);
        }
        let close = handle_key(
            &mut overlay,
            key(KeyCode::Esc),
            &config,
            ScreenMode::Fullscreen,
        );
        assert_eq!(close, OverlayAction::None);
        assert!(overlay.is_none());
    }

    #[test]
    fn handle_key_ignores_repeat_and_toggles_on_press() {
        let config = AppearanceConfig::default();
        let mut overlay = Overlay::Settings(SettingsState::open(&config, ScreenMode::Fullscreen));
        if let Overlay::Settings(state) = &mut overlay {
            state.selected = state
                .rows
                .iter()
                .position(|row| row.key == "ui.compact_mode")
                .unwrap();
        }
        let mut repeat = key(KeyCode::Enter);
        repeat.kind = KeyEventKind::Repeat;
        assert_eq!(
            handle_key(&mut overlay, repeat, &config, ScreenMode::Fullscreen),
            OverlayAction::None
        );
        let press = handle_key(
            &mut overlay,
            key(KeyCode::Enter),
            &config,
            ScreenMode::Fullscreen,
        );
        assert_eq!(
            press,
            OverlayAction::ToggleBool {
                key: "ui.compact_mode".into(),
                value: true
            }
        );
    }
}
