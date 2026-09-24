//! `/memory` browser and `/remember` confirmation.
//!
//! The modal lists files and a read-only preview. `x` deletes a session note
//! only after a second `x`. `MEMORY.md` stays, generated index or human note.
//! `t` flips the session gate and does not rewrite config.toml. Under 80
//! columns the list is shown alone until Enter opens the preview.

use crate::memory::{self, NoteRef, Scope, Store};
use crate::theme::Theme;
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Clear, Paragraph, Wrap};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pane {
    List,
    Filter,
    Preview,
    ConfirmSave,
    ConfirmDelete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Browser {
    pub cursor: usize,
    pub scroll: usize,
    pub filter: String,
    pub pane: Pane,
    pub notes: Vec<NoteRef>,
    pub notice: String,
    /// Session gate. Independent of the process/config enablement.
    pub session_enabled: bool,
    pub force_off: bool,
    /// Mirrors the host's `memory_injected` gate: true once this session's
    /// first-turn injection chance is gone (a turn already went out, or the
    /// session resumed with history). Deriving this from `turns.is_empty()`
    /// instead is wrong: `/clear` empties the visible transcript without
    /// reopening the injection window. A fresh `t` toggle to on after this
    /// is true has no effect on any prompt in this session, and `/new`
    /// drops the toggle and follows config.toml again, not it.
    pub memory_injected: bool,
    /// True only after `t` turns memory on once `memory_injected` is already
    /// true. A later key can replace `notice` before Esc, so close uses this
    /// flag instead of the notice text. A plain close (no late `t`) stays
    /// false and keeps the short "memory on for this session" hint.
    pub late_toggle_on: bool,
    pub pending_note: String,
    pub pending_scope: Scope,
    pub fullscreen: bool,
    /// Terminal columns available to the modal. Under 80 the preview is hidden.
    pub columns: u16,
    pub list_offset: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Up,
    Down,
    PageUp,
    PageDown,
    Home,
    End,
    Enter,
    Esc,
    Backspace,
    Tab,
    Char(char),
}

impl Default for Browser {
    fn default() -> Self {
        Self {
            cursor: 0,
            scroll: 0,
            filter: String::new(),
            pane: Pane::List,
            notes: Vec::new(),
            notice: String::new(),
            session_enabled: false,
            force_off: false,
            memory_injected: false,
            late_toggle_on: false,
            pending_note: String::new(),
            pending_scope: Scope::Workspace,
            fullscreen: false,
            columns: 100,
            list_offset: 0,
        }
    }
}

impl Browser {
    pub fn open(
        store: &Store,
        session_enabled: bool,
        force_off: bool,
        memory_injected: bool,
    ) -> Self {
        let notes = memory::list_notes(store).unwrap_or_default();
        Self {
            cursor: 0,
            scroll: 0,
            filter: String::new(),
            pane: Pane::List,
            notice: if notes_empty(&notes) {
                "No memory notes yet. /remember saves one after you confirm.".into()
            } else {
                String::new()
            },
            notes,
            session_enabled,
            force_off,
            memory_injected,
            late_toggle_on: false,
            pending_note: String::new(),
            pending_scope: Scope::Workspace,
            fullscreen: false,
            columns: 100,
            list_offset: 0,
        }
    }

    pub fn reload(&mut self, store: &Store) {
        self.notes = memory::list_notes(store).unwrap_or_default();
        if self.cursor >= self.visible().len() {
            self.cursor = 0;
        }
        self.keep_cursor_visible(self.list_rows());
    }

    pub fn set_columns(&mut self, columns: u16) {
        self.columns = columns;
    }

    fn narrow(&self) -> bool {
        self.columns < 80
    }

    fn list_rows(&self) -> usize {
        // Border, title, and the key footer take three rows of a short modal.
        if self.fullscreen { 18 } else { 8 }
    }

    fn keep_cursor_visible(&mut self, rows: usize) {
        let rows = rows.max(1);
        if self.cursor < self.list_offset {
            self.list_offset = self.cursor;
        } else if self.cursor >= self.list_offset + rows {
            self.list_offset = self.cursor + 1 - rows;
        }
    }

    pub fn visible(&self) -> Vec<NoteRef> {
        let terms = self
            .filter
            .split_whitespace()
            .map(|term| term.to_ascii_lowercase())
            .filter(|term| !term.is_empty())
            .collect::<Vec<_>>();
        if terms.is_empty() {
            return self.notes.clone();
        }
        self.notes
            .iter()
            .filter(|note| {
                let name = note.name.to_ascii_lowercase();
                let body = memory::read_note(note)
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let blob = format!("{name}\n{body}");
                terms.iter().all(|term| blob.contains(term.as_str()))
            })
            .cloned()
            .collect()
    }

    pub fn selected(&self) -> Option<NoteRef> {
        self.visible().get(self.cursor).cloned()
    }
}

fn notes_empty(notes: &[NoteRef]) -> bool {
    notes.iter().all(|note| note.generated_index || note.empty)
}

/// What a key press did, for the host to act on. Replaces matching on
/// `browser.notice`'s display text, which is fragile (wording changes would
/// silently change control flow) and was wrong once: a `Copy` path could
/// collide with other notices that happened to start the same way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Memory is hidden for this process; nothing else changed.
    ForceOff,
    /// Copy this path to the clipboard.
    Copy(String),
    /// Esc from the list: close the modal.
    Close,
    /// `t` flipped the session gate. The modal stays open.
    Toggled,
    /// A note save or cancel resolved. Close the modal.
    Confirmed,
}

pub fn handle_key(browser: &mut Browser, store: &Store, key: Key) -> Option<Action> {
    if browser.force_off {
        return Some(Action::ForceOff);
    }
    match browser.pane {
        Pane::ConfirmSave => return confirm_save(browser, store, key),
        Pane::ConfirmDelete => return confirm_delete(browser, store, key),
        Pane::Filter => {
            match key {
                Key::Esc | Key::Enter => browser.pane = Pane::List,
                Key::Backspace => {
                    browser.filter.pop();
                    browser.cursor = 0;
                }
                Key::Char(ch) => {
                    browser.filter.push(ch);
                    browser.cursor = 0;
                }
                _ => {}
            }
            return None;
        }
        Pane::Preview => {
            match key {
                Key::Esc => browser.pane = Pane::List,
                Key::Up => browser.scroll = browser.scroll.saturating_sub(1),
                Key::Down => browser.scroll = browser.scroll.saturating_add(1),
                Key::PageUp => browser.scroll = browser.scroll.saturating_sub(10),
                Key::PageDown => browser.scroll = browser.scroll.saturating_add(10),
                Key::Home => browser.scroll = 0,
                Key::Char('y') => {
                    if let Some(note) = browser.selected() {
                        let path = note.path.display().to_string();
                        browser.notice = format!("copied {path}");
                        return Some(Action::Copy(path));
                    }
                }
                _ => {}
            }
            return None;
        }
        Pane::List => {}
    }
    match key {
        Key::Up => browser.cursor = browser.cursor.saturating_sub(1),
        Key::Down => {
            let len = browser.visible().len();
            if len > 0 && browser.cursor + 1 < len {
                browser.cursor += 1;
            }
        }
        Key::PageUp => browser.cursor = browser.cursor.saturating_sub(10),
        Key::PageDown => {
            let len = browser.visible().len();
            if len > 0 {
                browser.cursor = (browser.cursor + 10).min(len - 1);
            }
        }
        Key::Home => browser.cursor = 0,
        Key::End => {
            let len = browser.visible().len();
            browser.cursor = len.saturating_sub(1);
        }
        Key::Char('/') => {
            browser.pane = Pane::Filter;
            browser.filter.clear();
            // Opening the filter is the next search. Rebuild a damaged index
            // here so the warning can clear before the user types.
            if let Err(error) = memory::search_notes(store, "") {
                browser.notice = error.message;
            }
        }
        Key::Enter => {
            if browser.selected().is_some() {
                browser.pane = Pane::Preview;
                browser.scroll = 0;
            }
        }
        Key::Esc => return Some(Action::Close),
        Key::Char('t') => {
            browser.session_enabled = !browser.session_enabled;
            browser.notice = if browser.session_enabled {
                if browser.memory_injected {
                    browser.late_toggle_on = true;
                    // This session's only injection chance (its first turn)
                    // already happened or was skipped; a fresh `t` on now
                    // cannot reach any prompt here. `/new` also drops this
                    // toggle and follows config.toml again, so it does not
                    // carry forward either — this is display-only.
                    "memory on, but too late for this session; /new still follows config.toml"
                        .into()
                } else {
                    browser.late_toggle_on = false;
                    "memory on for this session; config.toml was not changed".into()
                }
            } else {
                browser.late_toggle_on = false;
                let kept = memory::disable_keeps_files(store)
                    .map(|files| files.len())
                    .unwrap_or(0);
                format!("memory off for this session; {kept} files were kept")
            };
            browser.keep_cursor_visible(browser.list_rows());
            return Some(Action::Toggled);
        }
        Key::Char('y') => {
            if let Some(note) = browser.selected() {
                let path = note.path.display().to_string();
                browser.notice = format!("copied {path}");
                return Some(Action::Copy(path));
            }
        }
        Key::Char('x') => {
            let Some(note) = browser.selected() else {
                browser.notice = "no note selected".into();
                return None;
            };
            if note.generated_index || note.undeletable {
                browser.notice = format!(
                    "{} cannot be deleted",
                    if note.generated_index {
                        "generated index"
                    } else {
                        "MEMORY.md"
                    }
                );
                return None;
            }
            browser.pane = Pane::ConfirmDelete;
            browser.notice = format!("press x again to delete {}", note.path.display());
        }
        _ => {}
    }
    browser.keep_cursor_visible(browser.list_rows());
    None
}

pub fn toggle_fullscreen(browser: &mut Browser) {
    browser.fullscreen = !browser.fullscreen;
    browser.notice = if browser.fullscreen {
        "memory fullscreen".into()
    } else {
        "memory split view".into()
    };
}

fn confirm_delete(browser: &mut Browser, store: &Store, key: Key) -> Option<Action> {
    match key {
        Key::Char('x') => {
            if let Some(note) = browser.selected() {
                match memory::forget_note(store, &note) {
                    Ok(()) => {
                        browser.notice = format!("deleted {}", note.path.display());
                        browser.reload(store);
                    }
                    Err(error) => browser.notice = error.message,
                }
            }
            browser.pane = Pane::List;
        }
        Key::Esc | Key::Char('n') => {
            browser.pane = Pane::List;
            browser.notice = "delete cancelled; file kept".into();
        }
        _ => {}
    }
    None
}

fn confirm_save(browser: &mut Browser, store: &Store, key: Key) -> Option<Action> {
    match key {
        Key::Char('y') | Key::Enter => {
            match memory::save_note(store, browser.pending_scope, &browser.pending_note) {
                Ok(saved) => {
                    browser.notice = memory::saved_message(&saved.path);
                    browser.reload(store);
                    browser.pane = Pane::List;
                    return Some(Action::Confirmed);
                }
                Err(error) => {
                    browser.notice = error.message;
                    browser.pane = Pane::List;
                }
            }
        }
        Key::Esc | Key::Char('n') => {
            browser.notice = "memory note cancelled; nothing was written".into();
            browser.pane = Pane::List;
            browser.pending_note.clear();
            return Some(Action::Confirmed);
        }
        Key::Tab => {
            browser.notice = "keeping the typed note; no rewrite".into();
        }
        _ => {}
    }
    None
}

pub fn begin_remember(browser: &mut Browser, store: &Store, text: &str, scope: Scope) {
    browser.pending_note = text.trim().to_string();
    browser.pending_scope = scope;
    browser.pane = Pane::ConfirmSave;
    let path = match scope {
        Scope::Global => store.root.join("MEMORY.md"),
        Scope::Workspace => store.workspace_dir.join("MEMORY.md"),
    };
    browser.notice = memory::confirm_prompt(&browser.pending_note, scope, &path);
}

pub fn render(browser: &Browser, store: &Store) -> String {
    render_width(browser, store, browser.columns)
}

pub fn render_width(browser: &Browser, store: &Store, columns: u16) -> String {
    let mut view = browser.clone();
    view.set_columns(columns);
    render_view(&view, store)
}

fn render_view(browser: &Browser, store: &Store) -> String {
    if browser.force_off {
        return "Memory is off for this process (--no-memory or GROK_MEMORY=0). Notes were not deleted.".into();
    }
    if browser.pane == Pane::ConfirmSave {
        return browser.notice.clone();
    }
    let visible = browser.visible();
    let mut lines = vec![format!(
        "Memory  session={}  store={}",
        if browser.session_enabled { "on" } else { "off" },
        store.root.display()
    )];
    if !browser.filter.is_empty() || browser.pane == Pane::Filter {
        lines.push(format!("filter: {}", browser.filter));
    }
    let warnings = memory::warning_notice(store);
    if !warnings.is_empty() {
        lines.push(warnings);
    }
    if visible.is_empty() {
        lines.push(if browser.filter.is_empty() {
            "No memory notes. The list is empty; files on disk were not removed.".into()
        } else {
            "No notes match. Backspace clears the filter.".into()
        });
    }
    let show_preview = !browser.narrow() || browser.pane == Pane::Preview;
    let show_list = !browser.narrow() || browser.pane != Pane::Preview;
    let rows = browser.list_rows();
    if show_list {
        let window = visible
            .iter()
            .enumerate()
            .skip(browser.list_offset)
            .take(rows);
        for (index, note) in window {
            lines.push(row_label(index == browser.cursor, note));
        }
    }
    if show_preview && let Some(note) = visible.get(browser.cursor) {
        lines.push(format!("preview {} (read-only)", note.path.display()));
        match memory::read_note(note) {
            Ok(body) => {
                let preview: Vec<&str> = body.lines().skip(browser.scroll).take(8).collect();
                if preview.is_empty() {
                    lines.push("(empty note)".into());
                } else {
                    lines.extend(preview.into_iter().map(str::to_string));
                }
            }
            Err(error) => lines.push(error.message),
        }
    } else if browser.narrow() && browser.pane != Pane::Preview {
        lines.push("narrow: preview hidden; Enter reads the selected file".into());
    }
    if !browser.notice.is_empty() {
        lines.push(browser.notice.clone());
    }
    lines.push(
        "j/k move  / filter  Enter read  y copy path  x delete  t session toggle  Esc close".into(),
    );
    lines.join("\n")
}

fn row_label(selected: bool, note: &NoteRef) -> String {
    let mark = if selected { ">" } else { " " };
    let kind = if note.generated_index {
        "index"
    } else if note.empty {
        "empty"
    } else {
        "note"
    };
    format!("{mark} [{}] {} ({kind})", note.scope.as_str(), note.name)
}

fn modal_area(frame: &Frame, fullscreen: bool) -> Rect {
    let area = frame.area();
    if fullscreen || area.width < 24 || area.height < 8 {
        return area;
    }
    let width = area.width.saturating_sub(4).max(24);
    let height = area.height.saturating_sub(4).clamp(10, 22);
    Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + 1,
        width,
        height,
    }
}

/// Paint the memory browser as a modal. The selected row stays in the list
/// window. A content area under 80 columns hides the preview.
pub fn render_modal(frame: &mut Frame, browser: &mut Browser, _store: &Store, theme: &Theme) {
    browser.set_columns(frame.area().width);
    if browser.force_off {
        return;
    }
    let area = modal_area(frame, browser.fullscreen);
    frame.render_widget(Clear, area);
    let title = if browser.fullscreen {
        " Memory (fullscreen) "
    } else {
        " Memory "
    };
    let block = Block::bordered()
        .title(title)
        .style(Style::default().fg(theme.text_primary).bg(theme.bg_base));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.width == 0 || inner.height == 0 {
        return;
    }
    let [body, footer] = Layout::vertical([Constraint::Min(1), Constraint::Length(2)]).areas(inner);
    let visible = browser.visible();
    let rows = body.height.max(1) as usize;
    let warnings = memory::warning_notice(_store);
    browser.keep_cursor_visible(rows);
    let narrow = inner.width < 80;
    let show_preview = !narrow || browser.pane == Pane::Preview;
    let show_list = !narrow || browser.pane != Pane::Preview;
    let mut lines = Vec::new();
    if browser.pane == Pane::ConfirmSave || browser.pane == Pane::ConfirmDelete {
        for line in browser.notice.lines() {
            lines.push(Line::from(line.to_string()));
        }
    } else if visible.is_empty() {
        lines.push(Line::from(if browser.filter.is_empty() {
            "No memory notes. The list is empty; files on disk were not removed."
        } else {
            "No notes match. Backspace clears the filter."
        }));
    } else if show_list && show_preview && body.width >= 80 {
        let split = (body.width as usize / 2).clamp(24, body.width as usize - 20);
        let [list, preview] =
            Layout::horizontal([Constraint::Length(split as u16), Constraint::Min(20)]).areas(body);
        paint_list(frame, browser, &visible, list, theme);
        paint_preview(frame, browser, &visible, preview, theme);
        paint_footer(frame, browser, footer, theme, &warnings);
        return;
    } else if show_list {
        for (index, note) in visible
            .iter()
            .enumerate()
            .skip(browser.list_offset)
            .take(rows)
        {
            lines.push(styled_row(index == browser.cursor, note, theme));
        }
        if narrow && browser.pane != Pane::Preview {
            lines.push(Line::from("narrow: preview hidden"));
        }
    } else if show_preview {
        lines.extend(preview_lines(browser, &visible));
    }
    if !warnings.is_empty() {
        lines.push(Line::from(warnings));
    }
    if !browser.notice.is_empty()
        && !matches!(browser.pane, Pane::ConfirmSave | Pane::ConfirmDelete)
    {
        lines.push(Line::from(browser.notice.clone()));
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), body);
    paint_footer(frame, browser, footer, theme, "");
}

fn paint_list(
    frame: &mut Frame,
    browser: &Browser,
    visible: &[NoteRef],
    area: Rect,
    theme: &Theme,
) {
    let rows = area.height as usize;
    let lines: Vec<Line> = visible
        .iter()
        .enumerate()
        .skip(browser.list_offset)
        .take(rows)
        .map(|(index, note)| styled_row(index == browser.cursor, note, theme))
        .collect();
    frame.render_widget(Paragraph::new(lines), area);
}

fn paint_preview(
    frame: &mut Frame,
    browser: &Browser,
    visible: &[NoteRef],
    area: Rect,
    theme: &Theme,
) {
    let lines = preview_lines(browser, visible);
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .style(Style::default().fg(theme.gray)),
        area,
    );
}

fn preview_lines(browser: &Browser, visible: &[NoteRef]) -> Vec<Line<'static>> {
    let Some(note) = visible.get(browser.cursor) else {
        return vec![Line::from(if browser.filter.is_empty() {
            "No memory notes."
        } else {
            "No notes match."
        })];
    };
    let mut lines = vec![Line::from(format!(
        "preview {} (read-only)",
        note.path.display()
    ))];
    match memory::read_note(note) {
        Ok(body) => {
            let preview: Vec<&str> = body.lines().skip(browser.scroll).take(12).collect();
            if preview.is_empty() {
                lines.push(Line::from("(empty note)"));
            } else {
                lines.extend(preview.into_iter().map(|line| Line::from(line.to_string())));
            }
        }
        Err(error) => lines.push(Line::from(error.message)),
    }
    lines
}

fn styled_row(selected: bool, note: &NoteRef, theme: &Theme) -> Line<'static> {
    let style = if selected {
        Style::default()
            .fg(theme.text_primary)
            .bg(theme.bg_highlight)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(theme.text_primary)
    };
    Line::from(Span::styled(row_label(selected, note), style))
}

fn paint_footer(frame: &mut Frame, browser: &Browser, area: Rect, theme: &Theme, warnings: &str) {
    let text = if !warnings.is_empty() {
        warnings.to_string()
    } else if browser.pane == Pane::Filter {
        format!("filter: {}_  Esc leave filter", browser.filter)
    } else if browser.narrow() && browser.pane != Pane::Preview {
        "j/k move  Enter read  x delete  t toggle  Esc close  preview hidden".to_string()
    } else {
        "j/k move  / filter  Enter read  y copy  x delete  t toggle  Ctrl+F fullscreen  Esc close"
            .to_string()
    };
    frame.render_widget(
        Paragraph::new(text).style(Style::default().fg(theme.gray)),
        area,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{self, Scope};
    use std::fs;

    fn store() -> (tempfile::TempDir, memory::Store) {
        let dir = tempfile::TempDir::new().unwrap();
        let project = dir.path().join("repo");
        fs::create_dir_all(project.join(".git")).unwrap();
        fs::write(
            project.join(".git/config"),
            "[remote \"origin\"]\n\turl = https://github.com/Example/Widget.git\n",
        )
        .unwrap();
        let grok = dir.path().join(".grok");
        let store = memory::open_store(&grok, &project).unwrap();
        (dir, store)
    }

    #[test]
    fn modal_keeps_the_selected_row_and_hides_a_narrow_preview() {
        let (_dir, store) = store();
        fs::create_dir_all(&store.root).unwrap();
        fs::write(store.root.join("MEMORY.md"), "global fact\n").unwrap();
        memory::save_note(&store, Scope::Workspace, "workspace fact").unwrap();
        let sessions = store.workspace_dir.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        for index in 0..8 {
            fs::write(
                sessions.join(format!("s{index}.md")),
                format!("log {index}\n"),
            )
            .unwrap();
        }
        let mut browser = Browser::open(&store, true, false, false);
        browser.set_columns(100);
        for _ in 0..browser.visible().len().saturating_sub(1) {
            handle_key(&mut browser, &store, Key::Down);
        }
        let text = render(&browser, &store);
        let selected = browser.selected().unwrap();
        assert!(
            text.lines()
                .any(|row| row.starts_with('>') && row.contains(&selected.name)),
            "selected row missing from modal\n{text}"
        );
        assert!(text.contains("read-only"));
        browser.set_columns(60);
        let narrow = render(&browser, &store);
        assert!(
            narrow.contains("preview hidden"),
            "narrow modal still shows the preview\n{narrow}"
        );
        assert!(
            !narrow.contains("(read-only)"),
            "narrow list must not paint the preview body\n{narrow}"
        );
        handle_key(&mut browser, &store, Key::Enter);
        let reading = render(&browser, &store);
        assert!(
            reading.contains("read-only"),
            "Enter should open the note\n{reading}"
        );
        assert!(reading.contains(&selected.name) || reading.contains("log"));
    }

    #[test]
    fn browser_lists_scopes_and_refuses_generated_delete() {
        let (_dir, store) = store();
        fs::create_dir_all(&store.root).unwrap();
        fs::write(
            store.root.join("MEMORY.md"),
            "<!-- codsh-memory-index -->\n- pointer\n",
        )
        .unwrap();
        memory::save_note(&store, Scope::Workspace, "open PR links").unwrap();
        let sessions = store.workspace_dir.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(sessions.join("day.md"), "session log\n").unwrap();
        let mut browser = Browser::open(&store, true, false, false);
        let text = render(&browser, &store);
        assert!(text.contains("[workspace]"));
        assert!(text.contains("[global]"));
        assert!(text.contains("index"));
        assert!(text.contains("read-only"));
        browser.cursor = browser
            .visible()
            .iter()
            .position(|note| note.generated_index)
            .unwrap();
        handle_key(&mut browser, &store, Key::Char('x'));
        assert!(browser.notice.contains("cannot be deleted"));
        assert!(store.root.join("MEMORY.md").exists());
        browser.cursor = browser
            .visible()
            .iter()
            .position(|note| note.name == "MEMORY.md" && note.scope == Scope::Workspace)
            .unwrap();
        handle_key(&mut browser, &store, Key::Char('x'));
        assert!(browser.notice.contains("cannot be deleted"));
        assert!(store.workspace_dir.join("MEMORY.md").exists());
        browser.cursor = browser
            .visible()
            .iter()
            .position(|note| note.name.starts_with("sessions/"))
            .unwrap();
        handle_key(&mut browser, &store, Key::Char('x'));
        assert_eq!(browser.pane, Pane::ConfirmDelete);
        handle_key(&mut browser, &store, Key::Esc);
        assert!(browser.notice.contains("kept"));
        let path = store.workspace_dir.join("sessions/day.md");
        assert!(path.exists());
        handle_key(&mut browser, &store, Key::Char('x'));
        handle_key(&mut browser, &store, Key::Char('x'));
        assert!(!path.exists());
    }

    #[test]
    fn remember_writes_only_after_confirm_and_toggle_keeps_files() {
        let (_dir, store) = store();
        let mut browser = Browser::open(&store, false, false, false);
        assert!(render(&browser, &store).contains("No memory notes"));
        begin_remember(&mut browser, &store, "always open PR links", Scope::Global);
        assert!(browser.notice.contains("Save this note"));
        assert!(!store.root.join("MEMORY.md").exists());
        handle_key(&mut browser, &store, Key::Char('n'));
        assert!(!store.root.join("MEMORY.md").exists());
        begin_remember(&mut browser, &store, "always open PR links", Scope::Global);
        let saved = handle_key(&mut browser, &store, Key::Char('y')).unwrap();
        assert_eq!(saved, Action::Confirmed);
        assert!(browser.notice.contains("Memory saved to"));
        assert!(store.root.join("MEMORY.md").is_file());
        handle_key(&mut browser, &store, Key::Char('t'));
        assert!(browser.session_enabled);
        assert!(browser.notice.contains("config.toml was not changed"));
        assert!(store.root.join("MEMORY.md").is_file());
        handle_key(&mut browser, &store, Key::Char('t'));
        assert!(!browser.session_enabled);
        assert!(browser.notice.contains("were kept"));
        assert!(store.root.join("MEMORY.md").is_file());
        handle_key(&mut browser, &store, Key::Char('/'));
        handle_key(&mut browser, &store, Key::Char('z'));
        handle_key(&mut browser, &store, Key::Char('z'));
        let filtered = render(&browser, &store);
        assert!(filtered.contains("No notes match"));
    }

    #[test]
    fn toggle_notice_is_honest_about_an_already_injected_session() {
        let (_dir, store) = store();
        // Fresh session, first-turn injection still available: `t` on
        // reaches the very next prompt.
        let mut fresh = Browser::open(&store, false, false, false);
        let action = handle_key(&mut fresh, &store, Key::Char('t'));
        assert_eq!(action, Some(Action::Toggled));
        assert!(fresh.session_enabled);
        assert!(
            fresh.notice.contains("memory on for this session"),
            "{}",
            fresh.notice
        );
        assert!(!fresh.notice.contains("too late"), "{}", fresh.notice);

        // This session already had its first turn (memory_injected=true,
        // regardless of what `turns.is_empty()` says post-/clear): turning
        // memory on now reaches nothing here, and must not claim it carries
        // to `/new` either, since `/new` drops the toggle and follows
        // config.toml again (main.rs resets memory_session_on to None).
        let mut mid = Browser::open(&store, false, false, true);
        let action = handle_key(&mut mid, &store, Key::Char('t'));
        assert_eq!(action, Some(Action::Toggled));
        assert!(mid.session_enabled);
        assert!(
            mid.notice.contains("too late for this session"),
            "{}",
            mid.notice
        );
        assert!(
            mid.notice.contains("/new") && mid.notice.contains("config.toml"),
            "must say /new still follows config.toml, not this toggle: {}",
            mid.notice
        );
        assert!(
            !mid.notice.to_lowercase().contains("next new session"),
            "must not claim the toggle carries to the next new session: {}",
            mid.notice
        );
        assert!(
            mid.late_toggle_on,
            "Esc must be able to keep this wording after a later key replaces the notice"
        );

        // A close without that late `t` (memory already on, injection
        // already done) must not pick up the late-toggle wording.
        let plain = Browser::open(&store, true, false, true);
        assert!(!plain.late_toggle_on);
    }

    #[test]
    fn damaged_index_warning_is_visible() {
        let (dir, store) = store();
        memory::save_note(&store, Scope::Workspace, "visible fact").unwrap();
        fs::write(store.workspace_dir.join("index.sqlite"), b"not sqlite").unwrap();
        let reopened =
            memory::open_store(&dir.path().join(".grok"), &dir.path().join("repo")).unwrap();
        let browser = Browser::open(&reopened, true, false, false);
        let text = render(&browser, &reopened);
        assert!(text.contains("damaged"), "{text}");
        assert!(text.contains("MEMORY.md"));
        assert!(
            fs::read(store.workspace_dir.join("MEMORY.md"))
                .unwrap()
                .windows(15)
                .all(|window| window != b"SQLite format 3")
        );
    }

    #[test]
    fn force_off_hides_the_browser() {
        let (_dir, store) = store();
        memory::save_note(&store, Scope::Global, "secret fact").unwrap();
        let browser = Browser::open(&store, false, true, false);
        let text = render(&browser, &store);
        assert!(text.contains("force-disabled") || text.contains("off for this process"));
        assert!(!text.contains("secret fact"));
    }
}
