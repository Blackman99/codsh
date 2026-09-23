use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;
use std::collections::BTreeMap;
use std::path::Path;

pub const MOUSE_TOGGLE_HINT: &str = "Mouse reporting toggle is off. Set `[ui] mouse_reporting_toggle = true` in $GROK_HOME/config.toml to enable it.";
pub const FIND_MINIMAL: &str = "/find isn't available in minimal mode (minimal has no scrollback pane: use your terminal's own search). Run /fullscreen to switch this session.";
pub const JUMP_MINIMAL: &str = "/jump isn't available in minimal mode (minimal scrolls with your terminal's native scrollback). Run /fullscreen to switch this session.";
pub const DOCK_HIDDEN: &str = "Dock is off (features.dock / GROK_DOCK). No dock pane is shown.";
pub const DOCK_UNSUPPORTED: &str = "Dock is enabled in config but this preview has no dock pane; it is not pretended to exist. Disable features.dock to hide the gate.";
pub const PALETTE_UNSUPPORTED: &str = "No command palette. Draft kept.";
/// Columns reserved for the selected-turn marker; mouse columns skip this gutter.
pub const TRANSCRIPT_GUTTER: u16 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Prompt,
    Scrollback,
}

impl Focus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Scrollback => "scrollback",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollMode {
    Auto,
    Wheel,
    Trackpad,
}

impl ScrollMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Wheel => "wheel",
            Self::Trackpad => "trackpad",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "wheel" => Self::Wheel,
            "trackpad" => Self::Trackpad,
            "auto" => Self::Auto,
            _ => Self::Auto,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollKind {
    Wheel,
    Trackpad,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NavigationPrefs {
    pub vim_mode: bool,
    pub mouse_reporting_toggle: bool,
    pub scroll_mode: ScrollMode,
    pub scroll_speed: u8,
    pub scroll_lines: Option<u8>,
    pub invert_scroll: bool,
    pub dock_enabled: bool,
    pub origins: PrefOrigins,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrefOrigins {
    pub vim_mode: &'static str,
    pub mouse_reporting_toggle: &'static str,
    pub scroll_mode: &'static str,
    pub scroll_speed: &'static str,
    pub scroll_lines: &'static str,
    pub invert_scroll: &'static str,
    pub dock_enabled: &'static str,
}

impl Default for PrefOrigins {
    fn default() -> Self {
        Self {
            vim_mode: "default",
            mouse_reporting_toggle: "default",
            scroll_mode: "default",
            scroll_speed: "default",
            scroll_lines: "default",
            invert_scroll: "default",
            dock_enabled: "default",
        }
    }
}

impl Default for NavigationPrefs {
    fn default() -> Self {
        Self {
            vim_mode: false,
            mouse_reporting_toggle: false,
            scroll_mode: ScrollMode::Auto,
            scroll_speed: 50,
            scroll_lines: None,
            invert_scroll: false,
            dock_enabled: false,
            origins: PrefOrigins::default(),
        }
    }
}

impl NavigationPrefs {
    pub fn speed_multiplier(&self) -> f64 {
        let speed = self.scroll_speed.clamp(1, 100) as f64;
        if speed <= 50.0 {
            0.1 + (speed - 1.0) / 49.0 * 0.9
        } else {
            1.0 + (speed - 50.0) / 50.0 * 5.0
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadingBookmark {
    pub entry: usize,
    pub line_in_entry: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NavEntry {
    pub user: String,
    pub thought: String,
    pub answer: String,
    pub tools: Vec<(String, String)>,
    /// Tool call id and status, parallel to `tools`. Paint-only; not model history.
    pub tool_meta: Vec<(String, String)>,
    /// Turn errors such as a failed tool. Paint-only; not model history.
    pub errors: Vec<String>,
    pub diffs: Vec<String>,
    pub folded_thought: bool,
    pub folded_answer: bool,
    pub folded_tools: bool,
}

impl NavEntry {
    pub fn from_parts(
        user: impl Into<String>,
        thought: impl Into<String>,
        answer: impl Into<String>,
        tools: Vec<(String, String)>,
    ) -> Self {
        Self {
            user: user.into(),
            thought: thought.into(),
            answer: answer.into(),
            tools,
            tool_meta: Vec::new(),
            errors: Vec::new(),
            diffs: Vec::new(),
            folded_thought: false,
            folded_answer: false,
            folded_tools: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    User,
    Thought,
    Answer,
    Tool,
    Folded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptLine {
    pub entry: usize,
    pub kind: LineKind,
    pub text: String,
    pub line_in_entry: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectionSpan {
    pub start_line: usize,
    pub start_col: u16,
    pub end_line: usize,
    pub end_col: u16,
}

impl SelectionSpan {
    pub fn ordered(self) -> (usize, u16, usize, u16) {
        if (self.start_line, self.start_col) <= (self.end_line, self.end_col) {
            (self.start_line, self.start_col, self.end_line, self.end_col)
        } else {
            (self.end_line, self.end_col, self.start_line, self.start_col)
        }
    }

    pub fn is_empty(self) -> bool {
        self.start_line == self.end_line && self.start_col == self.end_col
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SelectionAnchor {
    start_entry: usize,
    start_kind: LineKind,
    start_line_in_entry: usize,
    start_col: u16,
    end_entry: usize,
    end_kind: LineKind,
    end_line_in_entry: usize,
    end_col: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PointerOrigin {
    Transcript,
    Prompt,
    Chrome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchMatch {
    pub entry: usize,
    pub line_in_entry: usize,
    pub byte_start: usize,
    pub byte_end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchSession {
    pub query: String,
    pub matches: Vec<SearchMatch>,
    pub current: Option<usize>,
    pub composing: bool,
    pub error: bool,
    pub restore: ReadingBookmark,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JumpSession {
    pub selected: usize,
    pub restore: ReadingBookmark,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewerSession {
    pub entry: usize,
    pub offset: usize,
    pub restore: ReadingBookmark,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavOverlay {
    None,
    Search(SearchSession),
    Jump(JumpSession),
    Viewer(ViewerSession),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HitTarget {
    Transcript { line: usize, col: u16 },
    Prompt,
    Chrome { line: usize },
    Outside,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameLayout {
    pub prompt: Rect,
    pub transcript: Rect,
    pub chrome: Rect,
}

impl FrameLayout {
    pub fn hit(self, column: u16, row: u16) -> HitTarget {
        if contains(self.prompt, column, row) {
            return HitTarget::Prompt;
        }
        if contains(self.transcript, column, row) {
            let line = row.saturating_sub(self.transcript.y) as usize;
            let col = column.saturating_sub(self.transcript.x);
            return HitTarget::Transcript { line, col };
        }
        if contains(self.chrome, column, row) {
            return HitTarget::Chrome {
                line: row.saturating_sub(self.chrome.y) as usize,
            };
        }
        HitTarget::Outside
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavCommand {
    None,
    Consume,
    TypePrompt,
    CopyBlock,
    ToggleMouse,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NavState {
    pub entries: Vec<NavEntry>,
    pub lines: Vec<TranscriptLine>,
    pub offset: usize,
    pub viewport_height: u16,
    pub width: u16,
    pub selected: Option<usize>,
    pub focus: Focus,
    pub overlay: NavOverlay,
    pub selection: Option<SelectionSpan>,
    selection_anchor: Option<SelectionAnchor>,
    pub mouse_captured: bool,
    pub follow: bool,
    pub display: crate::content::DisplayState,
    pub prefs: NavigationPrefs,
    pointer_origin: Option<PointerOrigin>,
    pointer_anchor: Option<(u16, u16)>,
    pointer_moved: bool,
    scroll_burst: u32,
    metadata_copy: Option<String>,
}

impl NavState {
    pub fn new(prefs: NavigationPrefs, fullscreen: bool) -> Self {
        Self {
            entries: Vec::new(),
            lines: Vec::new(),
            offset: 0,
            viewport_height: 8,
            width: 80,
            selected: None,
            focus: Focus::Prompt,
            overlay: NavOverlay::None,
            selection: None,
            selection_anchor: None,
            mouse_captured: fullscreen,
            follow: true,
            display: crate::content::DisplayState::default(),
            prefs,
            pointer_origin: None,
            pointer_anchor: None,
            pointer_moved: false,
            scroll_burst: 0,
            metadata_copy: None,
        }
    }

    fn clear_selection(&mut self) {
        self.selection = None;
        self.selection_anchor = None;
    }

    fn capture_selection_anchor(&self) -> Option<SelectionAnchor> {
        self.selection_anchor.or_else(|| self.anchor_from_span())
    }

    fn anchor_from_span(&self) -> Option<SelectionAnchor> {
        let span = self.selection?;
        let (start_line, start_col, end_line, end_col) = span.ordered();
        let start = self.lines.get(start_line)?;
        let end = self.lines.get(end_line)?;
        Some(SelectionAnchor {
            start_entry: start.entry,
            start_kind: start.kind,
            start_line_in_entry: start.line_in_entry,
            start_col,
            end_entry: end.entry,
            end_kind: end.kind,
            end_line_in_entry: end.line_in_entry,
            end_col,
        })
    }

    fn remember_selection_anchor(&mut self) {
        self.selection_anchor = self.anchor_from_span();
        if self.selection_anchor.is_none() {
            self.selection = None;
        }
    }

    fn remap_selection(&mut self, anchor: Option<SelectionAnchor>) {
        let Some(anchor) = anchor else {
            self.clear_selection();
            return;
        };
        let Some(start_line) = find_anchored_line(
            &self.lines,
            anchor.start_entry,
            anchor.start_kind,
            anchor.start_line_in_entry,
        ) else {
            self.clear_selection();
            return;
        };
        let Some(end_line) = find_anchored_line(
            &self.lines,
            anchor.end_entry,
            anchor.end_kind,
            anchor.end_line_in_entry,
        ) else {
            self.clear_selection();
            return;
        };
        let start_col = anchor
            .start_col
            .min(display_width(&self.lines[start_line].text) as u16);
        let end_col = anchor
            .end_col
            .min(display_width(&self.lines[end_line].text) as u16);
        self.selection = Some(SelectionSpan {
            start_line,
            start_col,
            end_line,
            end_col,
        });
        self.selection_anchor = Some(SelectionAnchor {
            start_col,
            end_col,
            ..anchor
        });
    }

    pub fn bookmark(&self) -> ReadingBookmark {
        let line = self.lines.get(self.offset);
        ReadingBookmark {
            entry: line.map(|item| item.entry).unwrap_or(0),
            line_in_entry: line.map(|item| item.line_in_entry).unwrap_or(0),
        }
    }

    pub fn restore(&mut self, bookmark: ReadingBookmark) {
        self.follow = false;
        if let Some(index) = self.lines.iter().position(|line| {
            line.entry == bookmark.entry && line.line_in_entry == bookmark.line_in_entry
        }) {
            self.offset = index;
        } else if let Some(index) = self
            .lines
            .iter()
            .position(|line| line.entry == bookmark.entry)
        {
            self.offset = index;
        }
        self.clamp_offset();
    }

    pub fn rebuild(&mut self, entries: Vec<NavEntry>, width: u16, viewport_height: u16) {
        let bookmark = self.bookmark();
        let following = self.follow;
        let anchor = self.capture_selection_anchor();
        self.entries = merge_fold_state(&self.entries, entries);
        self.width = width.max(1);
        self.viewport_height = viewport_height.max(1);
        self.relayout();
        if following {
            self.goto_bottom();
            self.follow = true;
        } else {
            self.restore(bookmark);
        }
        self.remap_selection(anchor);
        if let Some(selected) = self.selected
            && selected >= self.entries.len()
        {
            self.selected = self.entries.len().checked_sub(1);
        }
        self.refresh_search();
    }

    /// Relayout only when turn content or viewport size changed; keep folds by turn identity.
    pub fn sync_entries(&mut self, entries: Vec<NavEntry>, width: u16, viewport_height: u16) {
        let width = width.max(1);
        let viewport_height = viewport_height.max(1);
        let entries = merge_fold_state(&self.entries, entries);
        if self.width == width && self.viewport_height == viewport_height && self.entries == entries
        {
            return;
        }
        self.rebuild(entries, width, viewport_height);
    }

    pub fn visible_lines(&self) -> &[TranscriptLine] {
        let end = (self.offset + self.viewport_height as usize).min(self.lines.len());
        &self.lines[self.offset.min(end)..end]
    }

    pub fn status_bits(&self) -> String {
        let mouse = if self.mouse_captured {
            "captured"
        } else {
            "native"
        };
        let vim = if self.prefs.vim_mode { "on" } else { "off" };
        let dock = if self.prefs.dock_enabled {
            "unsupported"
        } else {
            "hidden"
        };
        let bookmark = self.bookmark();
        format!(
            "focus={} mouse={} vim={} dock={} read={}.{}",
            self.focus.as_str(),
            mouse,
            vim,
            dock,
            bookmark.entry,
            bookmark.line_in_entry
        )
    }

    pub fn overlay_text(&self) -> String {
        self.overlay_text_for(self.viewport_height.max(1) as usize)
    }

    pub fn overlay_text_for(&self, rows: usize) -> String {
        match &self.overlay {
            NavOverlay::None => String::new(),
            NavOverlay::Search(search) => {
                let count = search.matches.len();
                let current = search.current.map(|index| index + 1).unwrap_or(0);
                let err = if search.error {
                    "  (invalid regex)"
                } else {
                    ""
                };
                let phase = if search.composing {
                    "composing"
                } else {
                    "browse n/N"
                };
                format!(
                    "Find: {}  [{current}/{count}] {phase}{err}  Esc restores reading position",
                    search.query
                )
            }
            NavOverlay::Jump(jump) => {
                let mut lines = vec!["Jump to which turn?  Esc restores reading position".into()];
                for (index, entry) in self.entries.iter().enumerate() {
                    let mark = if index == jump.selected { ">" } else { " " };
                    let preview = truncate(&entry.user.replace('\n', " "), 48);
                    lines.push(format!("{mark} {}. {preview}", index + 1));
                }
                if self.entries.is_empty() {
                    lines.push("  (no turns)".into());
                }
                lines.join("\n")
            }
            NavOverlay::Viewer(viewer) => {
                let body = if viewer.entry == self.selected.unwrap_or(viewer.entry) {
                    let full = self.selected_full_lines();
                    if full.is_empty() {
                        viewer_body(self.entries.get(viewer.entry))
                    } else {
                        full
                    }
                } else {
                    viewer_body(self.entries.get(viewer.entry))
                };
                let height = rows.max(1);
                let max = body.len().saturating_sub(height);
                let start = viewer.offset.min(max);
                let end = (start + height).min(body.len());
                let window = body.get(start..end).unwrap_or(&[]);
                format!(
                    "full content · Esc closes full content · Esc restores reading position\n{}",
                    window.join("\n")
                )
            }
        }
    }

    pub fn copy_target(&self) -> Option<String> {
        if let Some(text) = &self.metadata_copy {
            return (!text.is_empty()).then(|| text.clone());
        }
        let span = self.selection.filter(|span| !span.is_empty())?;
        let text = text_for_span(&self.lines, span);
        (!text.is_empty()).then_some(text)
    }

    pub fn painted_transcript_lines(&self) -> Vec<String> {
        self.visible_lines()
            .iter()
            .enumerate()
            .map(|(index, line)| {
                let marked = self.selected == Some(line.entry);
                let prefix = if marked { "> " } else { "  " };
                let mut text = format!("{prefix}{}", line.text);
                if let Some(span) = self.selection {
                    let abs = self.offset + index;
                    text = paint_selection(&text, span, abs);
                }
                text
            })
            .collect()
    }

    /// Column inside the painted gutter that maps to transcript column 0.
    pub fn content_column(&self, line_index: usize) -> u16 {
        let marked = self
            .visible_lines()
            .get(line_index)
            .is_some_and(|line| self.selected == Some(line.entry));
        if marked { 2 } else { TRANSCRIPT_GUTTER }
    }

    pub fn open_search(&mut self, query: Option<String>) {
        let restore = self.bookmark();
        self.focus = Focus::Scrollback;
        let mut session = SearchSession {
            query: String::new(),
            matches: Vec::new(),
            current: None,
            composing: true,
            error: false,
            restore,
        };
        if let Some(query) = query {
            session.query = query;
            session.composing = false;
        }
        self.overlay = NavOverlay::Search(session);
        self.clear_selection();
        self.refresh_search();
    }

    pub fn open_jump(&mut self) {
        let restore = self.bookmark();
        self.focus = Focus::Scrollback;
        let selected = self
            .selected
            .unwrap_or(0)
            .min(self.entries.len().saturating_sub(1));
        self.overlay = NavOverlay::Jump(JumpSession { selected, restore });
        if !self.entries.is_empty() {
            self.jump_preview(selected);
        }
        self.clear_selection();
    }

    pub fn open_viewer(&mut self) {
        let Some(entry) = self.selected else {
            return;
        };
        let restore = self.bookmark();
        self.overlay = NavOverlay::Viewer(ViewerSession {
            entry,
            offset: 0,
            restore,
        });
        self.clear_selection();
    }

    pub fn dismiss_overlay(&mut self) {
        let restore = match &self.overlay {
            NavOverlay::None => return,
            NavOverlay::Search(search) => search.restore,
            NavOverlay::Jump(jump) => jump.restore,
            NavOverlay::Viewer(viewer) => viewer.restore,
        };
        self.overlay = NavOverlay::None;
        self.restore(restore);
        self.clear_selection();
    }

    pub fn toggle_vim(&mut self) {
        self.prefs.vim_mode = !self.prefs.vim_mode;
    }

    pub fn toggle_mouse(&mut self) -> bool {
        if !self.prefs.mouse_reporting_toggle {
            return false;
        }
        self.mouse_captured = !self.mouse_captured;
        true
    }

    pub fn classify_scroll(&self) -> ScrollKind {
        match self.prefs.scroll_mode {
            ScrollMode::Wheel => ScrollKind::Wheel,
            ScrollMode::Trackpad => ScrollKind::Trackpad,
            ScrollMode::Auto => {
                if self.scroll_burst >= 3 {
                    ScrollKind::Trackpad
                } else {
                    ScrollKind::Wheel
                }
            }
        }
    }

    pub fn scroll_distance(&self, kind: ScrollKind) -> i32 {
        let base = self.prefs.scroll_lines.unwrap_or(match kind {
            ScrollKind::Wheel => 3,
            ScrollKind::Trackpad => 1,
        }) as f64;
        (base * self.prefs.speed_multiplier()).round().max(1.0) as i32
    }

    pub fn apply_scroll(&mut self, down: bool) {
        self.scroll_burst = self.scroll_burst.saturating_add(1);
        let kind = self.classify_scroll();
        let mut delta = self.scroll_distance(kind);
        if self.prefs.invert_scroll {
            delta = -delta;
        }
        if !down {
            delta = -delta;
        }
        self.scroll_by(delta);
    }

    pub fn scroll_by(&mut self, delta: i32) {
        self.follow = false;
        let next = self.offset as i32 + delta;
        self.offset = next.max(0) as usize;
        self.clamp_offset();
        if self.at_bottom() {
            self.follow = true;
        }
    }

    pub fn goto_top(&mut self) {
        self.follow = false;
        self.offset = 0;
        if let Some(first) = self.lines.first() {
            self.selected = Some(first.entry);
        }
    }

    pub fn goto_bottom(&mut self) {
        self.offset = self.max_offset();
        self.follow = true;
        if let Some(last) = self.lines.last() {
            self.selected = Some(last.entry);
        }
    }

    pub fn select_delta(&mut self, delta: i32) {
        if self.entries.is_empty() {
            return;
        }
        let current = self.selected.unwrap_or(0) as i32;
        let next = (current + delta).clamp(0, self.entries.len() as i32 - 1) as usize;
        self.selected = Some(next);
        self.reveal_entry(next);
    }

    pub fn jump_turn(&mut self, delta: i32) {
        self.select_delta(delta);
    }

    pub fn toggle_fold_selected(&mut self) {
        let Some(index) = self.selected else {
            return;
        };
        self.toggle_fold_at(index, LineKind::Thought);
    }

    pub fn toggle_fold_at(&mut self, entry: usize, kind: LineKind) {
        let Some(item) = self.entries.get_mut(entry) else {
            return;
        };
        match kind {
            LineKind::Thought | LineKind::Folded => item.folded_thought = !item.folded_thought,
            LineKind::Answer => item.folded_answer = !item.folded_answer,
            LineKind::Tool => item.folded_tools = !item.folded_tools,
            LineKind::User => {}
        }
        let bookmark = self.bookmark();
        self.relayout();
        self.restore(bookmark);
    }

    pub fn relayout(&mut self) {
        self.lines = layout_lines(&self.entries, self.width, &self.display);
    }

    /// Toggle raw markdown for the selected block. Display only: the entry
    /// text and model history stay the original bytes.
    pub fn toggle_raw_selected(&mut self) -> bool {
        let Some(key) = self.selected_content_key() else {
            return false;
        };
        crate::content::toggle_raw(&mut self.display, &key);
        let bookmark = self.bookmark();
        self.relayout();
        self.restore(bookmark);
        true
    }

    pub fn selected_content_key(&self) -> Option<String> {
        let entry = self.selected?;
        let kind = self
            .lines
            .iter()
            .find(|line| line.entry == entry && line.kind != LineKind::User)
            .map(|line| line.kind)
            .unwrap_or(LineKind::Answer);
        let tool = self
            .entries
            .get(entry)
            .and_then(|item| item.tools.first())
            .map(|(title, _)| title.as_str())
            .unwrap_or("");
        let block = match kind {
            LineKind::Thought | LineKind::Folded
                if self
                    .entries
                    .get(entry)
                    .is_some_and(|item| item.folded_thought) =>
            {
                crate::content::BlockKind::Thought
            }
            LineKind::Tool | LineKind::Folded => crate::content::BlockKind::Tool,
            _ => crate::content::BlockKind::Answer,
        };
        if block == crate::content::BlockKind::Tool && tool.is_empty() {
            if self
                .entries
                .get(entry)
                .is_some_and(|item| !item.answer.is_empty())
            {
                return Some(crate::content::block_key(
                    entry,
                    crate::content::BlockKind::Answer,
                    "",
                ));
            }
            if self
                .entries
                .get(entry)
                .is_some_and(|item| !item.thought.is_empty())
            {
                return Some(crate::content::block_key(
                    entry,
                    crate::content::BlockKind::Thought,
                    "",
                ));
            }
        }
        Some(crate::content::block_key(entry, block, tool))
    }

    /// Full rendered (or raw) lines of the selected turn, not the folded preview.
    pub fn selected_full_lines(&self) -> Vec<String> {
        let Some(entry_index) = self.selected else {
            return Vec::new();
        };
        let Some(entry) = self.entries.get(entry_index) else {
            return Vec::new();
        };
        let mut opened = entry.clone();
        opened.folded_thought = false;
        opened.folded_answer = false;
        opened.folded_tools = false;
        crate::content::entry_lines(entry_index, &opened, &self.display)
            .into_iter()
            .map(|(_, text)| text)
            .collect()
    }

    #[cfg(test)]
    pub fn handle_key(&mut self, key: KeyEvent, fullscreen: bool) -> NavCommand {
        self.handle_key_with_prompt(key, fullscreen, true)
    }

    pub fn handle_key_with_prompt(
        &mut self,
        key: KeyEvent,
        fullscreen: bool,
        prompt_empty: bool,
    ) -> NavCommand {
        if key.kind == crossterm::event::KeyEventKind::Release {
            return NavCommand::None;
        }
        if !fullscreen {
            return NavCommand::TypePrompt;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('f') if self.focus == Focus::Scrollback => {
                    self.open_viewer();
                    return NavCommand::Consume;
                }
                KeyCode::Char('r') if self.focus == Focus::Scrollback => {
                    if self.prefs.mouse_reporting_toggle {
                        self.toggle_mouse();
                        return NavCommand::ToggleMouse;
                    }
                    return NavCommand::Consume;
                }
                KeyCode::Char('p') if matches!(self.overlay, NavOverlay::None) => {
                    return NavCommand::None;
                }
                KeyCode::Char('j') if self.focus == Focus::Scrollback => {
                    self.scroll_by(1);
                    return NavCommand::Consume;
                }
                KeyCode::Char('k') if self.focus == Focus::Scrollback => {
                    self.scroll_by(-1);
                    return NavCommand::Consume;
                }
                KeyCode::Char('d') if self.focus == Focus::Scrollback => {
                    self.scroll_by(self.viewport_height as i32 / 2);
                    return NavCommand::Consume;
                }
                KeyCode::Char('u') if self.focus == Focus::Scrollback => {
                    self.scroll_by(-(self.viewport_height as i32 / 2));
                    return NavCommand::Consume;
                }
                _ => {}
            }
        }
        match &mut self.overlay {
            NavOverlay::Search(search) if search.composing => match key.code {
                KeyCode::Esc => {
                    self.dismiss_overlay();
                    NavCommand::Consume
                }
                KeyCode::Enter => {
                    search.composing = false;
                    NavCommand::Consume
                }
                KeyCode::Backspace => {
                    search.query.pop();
                    self.refresh_search();
                    NavCommand::Consume
                }
                KeyCode::Char(ch)
                    if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT =>
                {
                    search.query.push(ch);
                    self.refresh_search();
                    NavCommand::Consume
                }
                _ => NavCommand::Consume,
            },
            NavOverlay::Search(search) => match key.code {
                KeyCode::Esc => {
                    self.dismiss_overlay();
                    NavCommand::Consume
                }
                KeyCode::Char('n') => {
                    step_search(search, 1);
                    if let Some(current) = search.current {
                        let found = search.matches[current].clone();
                        reveal_match(self, &found);
                    }
                    NavCommand::Consume
                }
                KeyCode::Char('N') => {
                    step_search(search, -1);
                    if let Some(current) = search.current {
                        let found = search.matches[current].clone();
                        reveal_match(self, &found);
                    }
                    NavCommand::Consume
                }
                _ => NavCommand::Consume,
            },
            NavOverlay::Jump(jump) => match key.code {
                KeyCode::Esc => {
                    self.dismiss_overlay();
                    NavCommand::Consume
                }
                KeyCode::Enter => {
                    let selected = jump.selected;
                    self.overlay = NavOverlay::None;
                    self.selected = Some(selected);
                    self.reveal_entry(selected);
                    NavCommand::Consume
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    if jump.selected > 0 {
                        jump.selected -= 1;
                    }
                    let selected = jump.selected;
                    self.jump_preview(selected);
                    NavCommand::Consume
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    if jump.selected + 1 < self.entries.len() {
                        jump.selected += 1;
                    }
                    let selected = jump.selected;
                    self.jump_preview(selected);
                    NavCommand::Consume
                }
                _ => NavCommand::Consume,
            },
            NavOverlay::Viewer(_) => match key.code {
                KeyCode::Esc => {
                    self.dismiss_overlay();
                    NavCommand::Consume
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    if let NavOverlay::Viewer(viewer) = &mut self.overlay {
                        viewer.offset = viewer.offset.saturating_sub(1);
                    }
                    NavCommand::Consume
                }
                KeyCode::Down | KeyCode::Char('j') | KeyCode::End | KeyCode::PageDown => {
                    let lines = self.selected_full_lines().len();
                    let page = self.viewport_height.max(1) as usize;
                    if let NavOverlay::Viewer(viewer) = &mut self.overlay {
                        let max = lines.saturating_sub(1);
                        let step = match key.code {
                            KeyCode::End => max,
                            KeyCode::PageDown => page,
                            _ => 1,
                        };
                        viewer.offset = (viewer.offset + step).min(max);
                    }
                    NavCommand::Consume
                }
                KeyCode::PageUp => {
                    let page = self.viewport_height.max(1) as usize;
                    if let NavOverlay::Viewer(viewer) = &mut self.overlay {
                        viewer.offset = viewer.offset.saturating_sub(page);
                    }
                    NavCommand::Consume
                }
                _ => NavCommand::Consume,
            },
            NavOverlay::None => self.handle_idle_key(key, prompt_empty),
        }
    }

    fn handle_idle_key(&mut self, key: KeyEvent, prompt_empty: bool) -> NavCommand {
        if matches!(key.code, KeyCode::PageUp | KeyCode::PageDown) {
            let delta = self.viewport_height as i32;
            self.scroll_by(if key.code == KeyCode::PageDown {
                delta
            } else {
                -delta
            });
            if self.focus == Focus::Scrollback {
                self.select_visible_edge(key.code == KeyCode::PageDown);
            }
            return NavCommand::Consume;
        }
        if self.focus == Focus::Prompt {
            if is_tab_key(&key) && key.modifiers.is_empty() {
                if self.entries.is_empty() || !prompt_empty {
                    return NavCommand::None;
                }
                self.focus = Focus::Scrollback;
                if self.selected.is_none() {
                    self.selected = self.entries.len().checked_sub(1);
                }
                return NavCommand::Consume;
            }
            if key.modifiers.contains(KeyModifiers::SHIFT)
                && matches!(key.code, KeyCode::Left | KeyCode::Right)
            {
                self.focus = Focus::Scrollback;
                self.jump_turn(if key.code == KeyCode::Right { 1 } else { -1 });
                return NavCommand::Consume;
            }
            return NavCommand::TypePrompt;
        }
        match key.code {
            KeyCode::Tab | KeyCode::Char('\t') | KeyCode::Char(' ') => {
                self.focus = Focus::Prompt;
                NavCommand::Consume
            }
            KeyCode::Esc => {
                self.clear_selection();
                NavCommand::None
            }
            KeyCode::Up => {
                self.select_delta(-1);
                NavCommand::Consume
            }
            KeyCode::Down => {
                self.select_delta(1);
                NavCommand::Consume
            }
            KeyCode::Left if key.modifiers.contains(KeyModifiers::SHIFT) => {
                self.jump_turn(-1);
                NavCommand::Consume
            }
            KeyCode::Right if key.modifiers.contains(KeyModifiers::SHIFT) => {
                self.jump_turn(1);
                NavCommand::Consume
            }
            KeyCode::Left => {
                if let Some(index) = self.selected {
                    self.fold_kind(index, true);
                }
                NavCommand::Consume
            }
            KeyCode::Right => {
                if let Some(index) = self.selected {
                    self.fold_kind(index, false);
                }
                NavCommand::Consume
            }
            KeyCode::Enter => {
                self.open_viewer();
                NavCommand::Consume
            }
            KeyCode::Char('g') if self.prefs.vim_mode && key.modifiers.is_empty() => {
                self.goto_top();
                NavCommand::Consume
            }
            KeyCode::Char('G') if self.prefs.vim_mode => {
                self.goto_bottom();
                NavCommand::Consume
            }
            KeyCode::Char('j') if self.prefs.vim_mode => {
                self.select_delta(1);
                NavCommand::Consume
            }
            KeyCode::Char('k') if self.prefs.vim_mode => {
                self.select_delta(-1);
                NavCommand::Consume
            }
            KeyCode::Char('h') if self.prefs.vim_mode => {
                if let Some(index) = self.selected {
                    self.fold_kind(index, true);
                }
                NavCommand::Consume
            }
            KeyCode::Char('l') if self.prefs.vim_mode || self.focus == Focus::Scrollback => {
                if let Some(index) = self.selected {
                    self.fold_kind(index, false);
                }
                NavCommand::Consume
            }
            KeyCode::Char('H') if self.prefs.vim_mode => {
                self.jump_turn(-1);
                NavCommand::Consume
            }
            KeyCode::Char('L') if self.prefs.vim_mode => {
                self.jump_turn(1);
                NavCommand::Consume
            }
            KeyCode::Char('J') if self.prefs.vim_mode => {
                self.jump_viewport_turn(1);
                NavCommand::Consume
            }
            KeyCode::Char('K') if self.prefs.vim_mode => {
                self.jump_viewport_turn(-1);
                NavCommand::Consume
            }
            KeyCode::Char('e') if self.prefs.vim_mode => {
                self.toggle_fold_selected();
                NavCommand::Consume
            }
            KeyCode::Char('y') if key.modifiers.is_empty() && self.focus == Focus::Scrollback => {
                if self.prefs.vim_mode {
                    self.select_block_span();
                }
                NavCommand::CopyBlock
            }
            KeyCode::Char('r') if key.modifiers.is_empty() && self.focus == Focus::Scrollback => {
                self.toggle_raw_selected();
                NavCommand::Consume
            }
            KeyCode::Char('Y') if self.prefs.vim_mode => {
                self.select_block_metadata();
                NavCommand::CopyBlock
            }
            KeyCode::Char('i') if self.prefs.vim_mode => {
                self.focus = Focus::Prompt;
                NavCommand::Consume
            }
            KeyCode::Char(_) if !self.prefs.vim_mode => {
                self.focus = Focus::Prompt;
                NavCommand::TypePrompt
            }
            _ => NavCommand::TypePrompt,
        }
    }

    pub fn handle_mouse(
        &mut self,
        mouse: MouseEvent,
        layout: FrameLayout,
        fullscreen: bool,
    ) -> NavCommand {
        if !fullscreen || !self.mouse_captured {
            return NavCommand::None;
        }
        match mouse.kind {
            MouseEventKind::ScrollDown => {
                self.apply_scroll(true);
                NavCommand::Consume
            }
            MouseEventKind::ScrollUp => {
                self.apply_scroll(false);
                NavCommand::Consume
            }
            MouseEventKind::Down(MouseButton::Left) => {
                self.pointer_anchor = Some((mouse.column, mouse.row));
                self.pointer_moved = false;
                self.pointer_origin = match layout.hit(mouse.column, mouse.row) {
                    HitTarget::Prompt => Some(PointerOrigin::Prompt),
                    HitTarget::Chrome { .. } => Some(PointerOrigin::Chrome),
                    HitTarget::Transcript { .. } => Some(PointerOrigin::Transcript),
                    HitTarget::Outside => None,
                };
                if self.pointer_origin == Some(PointerOrigin::Prompt) {
                    self.focus = Focus::Prompt;
                }
                if self.pointer_origin == Some(PointerOrigin::Transcript) {
                    self.focus = Focus::Scrollback;
                }
                NavCommand::Consume
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if let Some(anchor) = self.pointer_anchor
                    && (anchor.0 != mouse.column || anchor.1 != mouse.row)
                {
                    self.pointer_moved = true;
                }
                if self.pointer_moved
                    && self.pointer_origin == Some(PointerOrigin::Transcript)
                    && let (Some(anchor), HitTarget::Transcript { line, col }) =
                        (self.pointer_anchor, layout.hit(mouse.column, mouse.row))
                {
                    let start = layout.hit(anchor.0, anchor.1);
                    if let HitTarget::Transcript {
                        line: start_line,
                        col: start_col,
                    } = start
                    {
                        let start_content = self.content_column(start_line);
                        let end_content = self.content_column(line);
                        self.selection = Some(SelectionSpan {
                            start_line: self.offset + start_line,
                            start_col: start_col.saturating_sub(start_content),
                            end_line: self.offset + line,
                            end_col: col.saturating_sub(end_content),
                        });
                        self.remember_selection_anchor();
                        self.metadata_copy = None;
                    }
                }
                NavCommand::Consume
            }
            MouseEventKind::Up(MouseButton::Left) => {
                let origin = self.pointer_origin.take();
                let moved = self.pointer_moved;
                self.pointer_anchor = None;
                self.pointer_moved = false;
                if moved {
                    if self.selection.is_some_and(|span| !span.is_empty()) {
                        return NavCommand::CopyBlock;
                    }
                    self.clear_selection();
                    return NavCommand::Consume;
                }
                match (origin, layout.hit(mouse.column, mouse.row)) {
                    (Some(PointerOrigin::Transcript), HitTarget::Transcript { line, .. }) => {
                        let hit = self
                            .visible_lines()
                            .get(line)
                            .map(|item| (item.entry, item.kind));
                        if let Some((entry, kind)) = hit {
                            self.selected = Some(entry);
                            if matches!(
                                kind,
                                LineKind::Folded
                                    | LineKind::Thought
                                    | LineKind::Tool
                                    | LineKind::Answer
                            ) {
                                self.toggle_fold_at(entry, kind);
                            }
                        }
                        NavCommand::Consume
                    }
                    (Some(PointerOrigin::Prompt), _) => {
                        self.focus = Focus::Prompt;
                        NavCommand::Consume
                    }
                    _ => NavCommand::Consume,
                }
            }
            _ => NavCommand::None,
        }
    }

    fn jump_preview(&mut self, selected: usize) {
        self.selected = Some(selected);
        self.reveal_entry(selected);
    }

    fn jump_viewport_turn(&mut self, delta: i32) {
        let top_entry = self
            .lines
            .get(self.offset)
            .map(|line| line.entry)
            .unwrap_or(0);
        let next = (top_entry as i32 + delta).clamp(0, self.entries.len() as i32 - 1) as usize;
        self.selected = Some(next);
        self.reveal_entry(next);
    }

    fn fold_kind(&mut self, entry: usize, collapse: bool) {
        if let Some(item) = self.entries.get_mut(entry) {
            item.folded_thought = collapse;
            item.folded_tools = collapse;
        }
        let bookmark = self.bookmark();
        self.relayout();
        self.restore(bookmark);
    }

    fn select_block_span(&mut self) {
        self.metadata_copy = None;
        let Some(entry) = self.selected else {
            self.clear_selection();
            return;
        };
        let kind = self
            .visible_lines()
            .iter()
            .find(|line| line.entry == entry)
            .or_else(|| self.lines.iter().find(|line| line.entry == entry))
            .map(|line| line.kind)
            .unwrap_or(LineKind::User);
        let mut start = None;
        let mut end = None;
        for (index, line) in self.lines.iter().enumerate() {
            if line.entry == entry && line.kind == kind {
                if start.is_none() {
                    start = Some(index);
                }
                end = Some(index);
            }
        }
        self.selection = match (start, end) {
            (Some(start_line), Some(end_line)) => Some(SelectionSpan {
                start_line,
                start_col: 0,
                end_line,
                end_col: display_width(&self.lines[end_line].text) as u16,
            }),
            _ => None,
        };
        self.remember_selection_anchor();
    }

    fn select_block_metadata(&mut self) {
        self.clear_selection();
        let Some(entry) = self.selected.and_then(|index| self.entries.get(index)) else {
            self.metadata_copy = None;
            return;
        };
        let kind = self
            .lines
            .iter()
            .find(|line| Some(line.entry) == self.selected)
            .map(|line| line.kind)
            .unwrap_or(LineKind::User);
        self.metadata_copy = Some(block_metadata(entry, kind));
    }

    fn reveal_entry(&mut self, entry: usize) {
        if let Some(index) = self.lines.iter().position(|line| line.entry == entry) {
            self.follow = false;
            self.offset = index;
            self.clamp_offset();
        }
    }

    fn select_visible_edge(&mut self, bottom: bool) {
        let lines = self.visible_lines();
        let line = if bottom { lines.last() } else { lines.first() };
        if let Some(line) = line {
            self.selected = Some(line.entry);
        }
    }

    pub fn refresh_search(&mut self) {
        let NavOverlay::Search(search) = &mut self.overlay else {
            return;
        };
        apply_search(&self.lines, search);
        if let Some(current) = search.current {
            let found = search.matches[current].clone();
            reveal_match(self, &found);
        }
    }

    fn clamp_offset(&mut self) {
        self.offset = self.offset.min(self.max_offset());
    }

    fn max_offset(&self) -> usize {
        self.lines
            .len()
            .saturating_sub(self.viewport_height as usize)
    }

    fn at_bottom(&self) -> bool {
        self.offset >= self.max_offset()
    }
}

pub fn load_prefs(home: &Path, env: &BTreeMap<String, String>) -> NavigationPrefs {
    let text = std::fs::read_to_string(home.join("config.toml")).unwrap_or_default();
    let mut prefs = parse_prefs(&text);
    apply_env(&mut prefs, env, true);
    prefs
}

pub fn parse_prefs(text: &str) -> NavigationPrefs {
    let mut prefs = NavigationPrefs::default();
    let mut section = String::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].trim().to_ascii_lowercase();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"').trim_matches('\'');
        match (section.as_str(), key) {
            ("ui", "vim_mode") => {
                if let Some(flag) = parse_bool_text(value) {
                    prefs.vim_mode = flag;
                    prefs.origins.vim_mode = "config";
                }
            }
            ("ui", "mouse_reporting_toggle") => {
                if let Some(flag) = parse_bool_text(value) {
                    prefs.mouse_reporting_toggle = flag;
                    prefs.origins.mouse_reporting_toggle = "config";
                }
            }
            ("ui", "invert_scroll") => {
                if let Some(flag) = parse_bool_text(value) {
                    prefs.invert_scroll = flag;
                    prefs.origins.invert_scroll = "config";
                }
            }
            ("ui", "scroll_mode") => {
                prefs.scroll_mode = ScrollMode::parse(value);
                prefs.origins.scroll_mode = "config";
            }
            ("ui", "scroll_speed") => {
                if let Ok(speed) = value.parse::<i64>() {
                    prefs.scroll_speed = speed.clamp(1, 100) as u8;
                    prefs.origins.scroll_speed = "config";
                }
            }
            ("ui", "scroll_lines") => {
                if let Ok(lines) = value.parse::<i64>() {
                    prefs.scroll_lines = Some(lines.clamp(1, 10) as u8);
                    prefs.origins.scroll_lines = "config";
                }
            }
            ("features", "dock") => {
                if let Some(flag) = parse_bool_text(value) {
                    prefs.dock_enabled = flag;
                    prefs.origins.dock_enabled = "config";
                }
            }
            _ => {}
        }
    }
    prefs
}

pub fn apply_env(prefs: &mut NavigationPrefs, env: &BTreeMap<String, String>, first_load: bool) {
    if !first_load {
        return;
    }
    if let Some(value) = env
        .get("GROK_VIM_MODE")
        .and_then(|text| parse_bool_text(text))
    {
        prefs.vim_mode = value;
        prefs.origins.vim_mode = "env";
    }
    if let Some(value) = env
        .get("GROK_MOUSE_REPORTING_TOGGLE")
        .and_then(|text| parse_bool_text(text))
    {
        prefs.mouse_reporting_toggle = value;
        prefs.origins.mouse_reporting_toggle = "env";
    }
    if let Some(value) = env
        .get("GROK_INVERT_SCROLL")
        .and_then(|text| parse_bool_text(text))
    {
        prefs.invert_scroll = value;
        prefs.origins.invert_scroll = "env";
    }
    if let Some(value) = env.get("GROK_SCROLL_MODE") {
        prefs.scroll_mode = ScrollMode::parse(value);
        prefs.origins.scroll_mode = "env";
    }
    if let Some(value) = env
        .get("GROK_SCROLL_SPEED")
        .and_then(|text| text.parse::<i64>().ok())
    {
        prefs.scroll_speed = value.clamp(1, 100) as u8;
        prefs.origins.scroll_speed = "env";
    }
    if let Some(value) = env
        .get("GROK_SCROLL_LINES")
        .and_then(|text| text.parse::<i64>().ok())
    {
        prefs.scroll_lines = Some(value.clamp(1, 10) as u8);
        prefs.origins.scroll_lines = "env";
    }
    if let Some(value) = env
        .get("GROK_DOCK")
        .or_else(|| env.get("GROK_DOCK_V2"))
        .and_then(|text| parse_bool_text(text))
    {
        prefs.dock_enabled = value;
        prefs.origins.dock_enabled = "env";
    }
}

pub fn inspect_rows(prefs: &NavigationPrefs) -> Vec<(&'static str, String, &'static str)> {
    vec![
        (
            "ui.vim_mode",
            prefs.vim_mode.to_string(),
            prefs.origins.vim_mode,
        ),
        (
            "ui.mouse_reporting_toggle",
            prefs.mouse_reporting_toggle.to_string(),
            prefs.origins.mouse_reporting_toggle,
        ),
        (
            "ui.scroll_mode",
            prefs.scroll_mode.as_str().to_string(),
            prefs.origins.scroll_mode,
        ),
        (
            "ui.scroll_speed",
            prefs.scroll_speed.to_string(),
            prefs.origins.scroll_speed,
        ),
        (
            "ui.scroll_lines",
            prefs
                .scroll_lines
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unset".into()),
            prefs.origins.scroll_lines,
        ),
        (
            "ui.invert_scroll",
            prefs.invert_scroll.to_string(),
            prefs.origins.invert_scroll,
        ),
        (
            "features.dock",
            prefs.dock_enabled.to_string(),
            prefs.origins.dock_enabled,
        ),
    ]
}

pub fn save_vim_mode(home: &Path, enabled: bool) -> std::io::Result<()> {
    write_ui_key(home, "vim_mode", if enabled { "true" } else { "false" })
}

pub fn write_ui_key(home: &Path, key: &str, value: &str) -> std::io::Result<()> {
    let path = home.join("config.toml");
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
                lines.push(format!("{key} = {value}"));
                wrote = true;
            }
            in_ui = false;
        }
        if in_ui
            && trimmed
                .split_once('=')
                .is_some_and(|(name, _)| name.trim() == key)
        {
            lines.push(format!("{key} = {value}"));
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
        lines.push(format!("{key} = {value}"));
    } else if in_ui && !wrote {
        lines.push(format!("{key} = {value}"));
    }
    std::fs::write(path, format!("{}\n", lines.join("\n")))
}

pub fn osc52(text: &str) -> String {
    format!("\x1b]52;c;{}\x07", base64_encode(text.as_bytes()))
}

pub fn dock_message(enabled: bool) -> &'static str {
    if enabled {
        DOCK_UNSUPPORTED
    } else {
        DOCK_HIDDEN
    }
}

fn merge_fold_state(previous: &[NavEntry], mut next: Vec<NavEntry>) -> Vec<NavEntry> {
    for (index, entry) in next.iter_mut().enumerate() {
        let Some(prior) = previous.get(index) else {
            continue;
        };
        if prior.user == entry.user {
            let thought_grew = prior.thought.lines().count() <= crate::content::TOOL_PREVIEW_LINES
                && entry.thought.lines().count() > crate::content::TOOL_PREVIEW_LINES;
            let answer_grew = prior.answer.lines().count() <= crate::content::TOOL_PREVIEW_LINES
                && entry.answer.lines().count() > crate::content::TOOL_PREVIEW_LINES;
            let tools_grew =
                prior.tools.iter().all(|(_, result)| {
                    result.lines().count() <= crate::content::TOOL_PREVIEW_LINES
                }) && entry
                    .tools
                    .iter()
                    .any(|(_, result)| result.lines().count() > crate::content::TOOL_PREVIEW_LINES);
            entry.folded_thought = if thought_grew {
                true
            } else {
                prior.folded_thought
            };
            entry.folded_answer = if answer_grew {
                true
            } else {
                prior.folded_answer
            };
            entry.folded_tools = if tools_grew { true } else { prior.folded_tools };
        }
    }
    next
}

fn layout_lines(
    entries: &[NavEntry],
    width: u16,
    display: &crate::content::DisplayState,
) -> Vec<TranscriptLine> {
    let mut lines = Vec::new();
    let width = width.max(1) as usize;
    for (index, entry) in entries.iter().enumerate() {
        for (kind, text) in crate::content::entry_lines(index, entry, display) {
            let kind = if matches!(
                (
                    kind,
                    entry.folded_thought,
                    entry.folded_answer,
                    entry.folded_tools
                ),
                (LineKind::Thought, true, _, _)
                    | (LineKind::Answer, _, true, _)
                    | (LineKind::Tool, _, _, true)
            ) {
                LineKind::Folded
            } else {
                kind
            };
            push_wrapped(&mut lines, index, kind, &text, width);
        }
        for diff in &entry.diffs {
            if diff.is_empty() {
                continue;
            }
            push_wrapped(&mut lines, index, LineKind::Tool, diff, width);
        }
    }
    lines
}

fn push_wrapped(
    lines: &mut Vec<TranscriptLine>,
    entry: usize,
    kind: LineKind,
    text: &str,
    width: usize,
) {
    let mut line_in_entry = lines.iter().filter(|line| line.entry == entry).count();
    for raw in text.split('\n') {
        let wrapped = wrap_text(raw, width);
        if wrapped.is_empty() {
            lines.push(TranscriptLine {
                entry,
                kind,
                text: String::new(),
                line_in_entry,
            });
            line_in_entry += 1;
            continue;
        }
        for piece in wrapped {
            lines.push(TranscriptLine {
                entry,
                kind,
                text: piece,
                line_in_entry,
            });
            line_in_entry += 1;
        }
    }
}

fn wrap_text(text: &str, width: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    let mut out = Vec::new();
    let mut current = String::new();
    let mut current_width = 0usize;
    for grapheme in unicode_segmentation::UnicodeSegmentation::graphemes(text, true) {
        let w = unicode_width::UnicodeWidthStr::width(grapheme).max(if grapheme.is_empty() {
            0
        } else {
            1
        });
        let crosses = current_width + w > width && !current.is_empty();
        // Graphemes, including a ZWJ cluster, move intact instead of splitting
        // woman, joiner, and laptop into separate cells.
        if crosses {
            out.push(std::mem::take(&mut current));
            current_width = 0;
        }
        current.push_str(grapheme);
        current_width += w;
        if current_width >= width {
            out.push(std::mem::take(&mut current));
            current_width = 0;
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn apply_search(lines: &[TranscriptLine], search: &mut SearchSession) {
    search.error = false;
    search.matches.clear();
    search.current = None;
    if search.query.is_empty() {
        return;
    }
    let Ok(regex) = compile_query(&search.query) else {
        search.error = true;
        return;
    };
    let mut index = 0;
    while index < lines.len() {
        let entry = lines[index].entry;
        let kind = lines[index].kind;
        let mut joined = String::new();
        let mut pieces = Vec::new();
        while index < lines.len() && lines[index].entry == entry && lines[index].kind == kind {
            let start = joined.len();
            joined.push_str(&lines[index].text);
            pieces.push((start, lines[index].line_in_entry));
            index += 1;
        }
        for mat in regex.find_iter(&joined) {
            if mat.start() == mat.end() {
                continue;
            }
            let line_in_entry = pieces
                .iter()
                .rev()
                .find(|(start, _)| mat.start() >= *start)
                .map(|(_, line)| *line)
                .unwrap_or(0);
            search.matches.push(SearchMatch {
                entry,
                line_in_entry,
                byte_start: mat.start(),
                byte_end: mat.end(),
            });
        }
    }
    if !search.matches.is_empty() {
        search.current = Some(0);
    }
}

fn compile_query(query: &str) -> Result<regex::Regex, regex::Error> {
    let smart_case = query.chars().all(|ch| !ch.is_uppercase());
    let pattern = if smart_case {
        format!("(?i){query}")
    } else {
        query.to_string()
    };
    regex::Regex::new(&pattern)
}

fn step_search(search: &mut SearchSession, delta: i32) {
    let len = search.matches.len() as i32;
    if len == 0 {
        search.current = None;
        return;
    }
    let from = search.current.unwrap_or(0) as i32;
    search.current = Some((from + delta).rem_euclid(len) as usize);
}

fn reveal_match(state: &mut NavState, found: &SearchMatch) {
    state.selected = Some(found.entry);
    state.reveal_entry(found.entry);
    if let Some(index) = state
        .lines
        .iter()
        .position(|line| line.entry == found.entry && line.line_in_entry == found.line_in_entry)
    {
        state.offset = index.min(state.max_offset());
        state.follow = false;
    }
}

fn find_anchored_line(
    lines: &[TranscriptLine],
    entry: usize,
    kind: LineKind,
    line_in_entry: usize,
) -> Option<usize> {
    lines.iter().position(|line| {
        line.entry == entry && line.kind == kind && line.line_in_entry == line_in_entry
    })
}

fn paint_selection(painted: &str, span: SelectionSpan, abs: usize) -> String {
    let (start_line, start_col, end_line, end_col) = span.ordered();
    if abs < start_line || abs > end_line {
        return painted.to_string();
    }
    let gutter = 2usize;
    let body = painted.get(gutter..).unwrap_or(painted);
    let lo = if abs == start_line {
        slice_at_width(body, start_col as usize)
    } else {
        0
    };
    let hi = if abs == end_line {
        slice_at_width(body, end_col as usize)
    } else {
        body.len()
    };
    if lo >= hi {
        return painted.to_string();
    }
    let mut out = String::new();
    out.push_str(&painted[..gutter.min(painted.len())]);
    out.push_str(&body[..lo]);
    out.push('\u{2588}');
    out.push_str(&body[lo..hi]);
    out.push('\u{2588}');
    out.push_str(&body[hi..]);
    out
}

fn text_for_span(lines: &[TranscriptLine], span: SelectionSpan) -> String {
    let (start_line, start_col, end_line, end_col) = span.ordered();
    let mut out = String::new();
    for (index, line) in lines.iter().enumerate() {
        if index < start_line || index > end_line {
            continue;
        }
        let lo = if index == start_line {
            slice_at_width(&line.text, start_col as usize)
        } else {
            0
        };
        let hi = if index == end_line {
            slice_at_width(&line.text, end_col as usize)
        } else {
            line.text.len()
        };
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line.text.get(lo..hi).unwrap_or(""));
    }
    out
}

fn slice_at_width(text: &str, width: usize) -> usize {
    let mut current = 0usize;
    for (index, ch) in text.char_indices() {
        let w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(1);
        if current + w > width {
            return index;
        }
        current += w;
        if current == width {
            return index + ch.len_utf8();
        }
    }
    text.len()
}

fn display_width(text: &str) -> usize {
    unicode_width::UnicodeWidthStr::width(text)
}

fn viewer_body(entry: Option<&NavEntry>) -> Vec<String> {
    let Some(entry) = entry else {
        return Vec::new();
    };
    let mut lines = vec![entry.user.clone()];
    if !entry.thought.is_empty() {
        lines.push(format!("[thought] {}", entry.thought));
    }
    for (title, result) in &entry.tools {
        lines.push(format!("[tool {title}] {result}"));
    }
    if !entry.answer.is_empty() {
        lines.extend(entry.answer.lines().map(str::to_string));
    }
    lines
}

fn block_metadata(entry: &NavEntry, kind: LineKind) -> String {
    match kind {
        LineKind::User => format!("user {}", truncate(&entry.user.replace('\n', " "), 48)),
        LineKind::Thought | LineKind::Folded if !entry.thought.is_empty() => {
            format!("thought {} bytes", entry.thought.len())
        }
        LineKind::Tool => format!("tools {}", entry.tools.len()),
        LineKind::Answer => format!("answer {} bytes", entry.answer.len()),
        LineKind::Folded => "folded block".into(),
        LineKind::Thought => format!("thought {} bytes", entry.thought.len()),
    }
}

fn is_tab_key(key: &KeyEvent) -> bool {
    matches!(key.code, KeyCode::Tab | KeyCode::Char('\t'))
}

fn contains(area: Rect, column: u16, row: u16) -> bool {
    area.width > 0
        && area.height > 0
        && column >= area.x
        && column < area.x.saturating_add(area.width)
        && row >= area.y
        && row < area.y.saturating_add(area.height)
}

fn truncate(text: &str, width: usize) -> String {
    if text.chars().count() <= width {
        return text.to_string();
    }
    text.chars()
        .take(width.saturating_sub(1))
        .collect::<String>()
        + "…"
}

fn parse_bool_text(text: &str) -> Option<bool> {
    match text.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut index = 0;
    while index < bytes.len() {
        let remaining = bytes.len() - index;
        let b0 = bytes[index];
        let b1 = if remaining > 1 { bytes[index + 1] } else { 0 };
        let b2 = if remaining > 2 { bytes[index + 2] } else { 0 };
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if remaining == 1 {
            out.push('=');
            out.push('=');
        } else {
            out.push(TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
            if remaining == 2 {
                out.push('=');
            } else {
                out.push(TABLE[(b2 & 0x3f) as usize] as char);
            }
        }
        index += 3;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyEventKind, KeyEventState};

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent {
            code,
            modifiers: KeyModifiers::empty(),
            kind: KeyEventKind::Press,
            state: KeyEventState::empty(),
        }
    }

    fn shift(code: KeyCode) -> KeyEvent {
        KeyEvent {
            code,
            modifiers: KeyModifiers::SHIFT,
            kind: KeyEventKind::Press,
            state: KeyEventState::empty(),
        }
    }

    fn ctrl(code: char) -> KeyEvent {
        KeyEvent {
            code: KeyCode::Char(code),
            modifiers: KeyModifiers::CONTROL,
            kind: KeyEventKind::Press,
            state: KeyEventState::empty(),
        }
    }

    fn mouse(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
        MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::empty(),
        }
    }

    fn sample() -> NavState {
        let mut state = NavState::new(NavigationPrefs::default(), true);
        let mut entries = vec![
            NavEntry::from_parts(
                "TOKEN_ALPHA prompt",
                "thinking alpha that is long enough to wrap under a narrow width",
                "answer ALPHA unique\nline two of alpha\nline three of alpha\nline four of alpha",
                vec![],
            ),
            NavEntry::from_parts(
                "TOKEN_BETA prompt",
                "thinking beta",
                "answer BETA unique\nbeta line two\nbeta line three",
                vec![("edit".into(), "changed note".into())],
            ),
        ];
        for index in 3..=12 {
            entries.push(NavEntry::from_parts(
                format!("TOKEN_{index:02} prompt"),
                format!("thinking {index}"),
                format!("answer {index} body that keeps the transcript long"),
                vec![],
            ));
        }
        entries[0].folded_thought = true;
        state.rebuild(entries, 40, 6);
        state
    }

    #[test]
    fn click_selects_and_drag_does_not_toggle_fold() {
        let mut state = sample();
        state.goto_top();
        let layout = FrameLayout {
            prompt: Rect::new(0, 20, 40, 4),
            transcript: Rect::new(0, 0, 40, 10),
            chrome: Rect::new(0, 24, 40, 1),
        };
        let folded_row = state
            .visible_lines()
            .iter()
            .position(|line| line.kind == LineKind::Folded)
            .expect("folded thought row");
        let folded = state.entries[0].folded_thought;
        let row = folded_row as u16;
        state.handle_mouse(
            mouse(MouseEventKind::Down(MouseButton::Left), 2, row),
            layout,
            true,
        );
        state.handle_mouse(
            mouse(MouseEventKind::Up(MouseButton::Left), 2, row),
            layout,
            true,
        );
        assert_eq!(state.selected, Some(0));
        assert_ne!(state.entries[0].folded_thought, folded);
        let after_click = state.entries[0].folded_thought;
        state.handle_mouse(
            mouse(MouseEventKind::Down(MouseButton::Left), 2, row),
            layout,
            true,
        );
        state.handle_mouse(
            mouse(MouseEventKind::Drag(MouseButton::Left), 18, row),
            layout,
            true,
        );
        let command = state.handle_mouse(
            mouse(MouseEventKind::Up(MouseButton::Left), 18, row),
            layout,
            true,
        );
        assert_eq!(command, NavCommand::CopyBlock);
        assert_eq!(state.entries[0].folded_thought, after_click);
        assert!(state.selection.is_some());
        let copied = state.copy_target().unwrap();
        assert!(!copied.is_empty());
        assert_eq!(
            copied,
            text_for_span(&state.lines, state.selection.unwrap())
        );
    }

    #[test]
    fn rebuild_preserves_fold_flags_by_turn_identity() {
        let mut state = sample();
        state.goto_top();
        state.entries[0].folded_thought = true;
        state.relayout();
        let mut next = state.entries.clone();
        for entry in &mut next {
            entry.folded_thought = false;
            entry.folded_answer = false;
            entry.folded_tools = false;
        }
        next[0].answer.push_str(" STREAM");
        state.sync_entries(next, 40, 6);
        assert!(state.entries[0].folded_thought);
        assert!(
            state
                .lines
                .iter()
                .any(|line| line.kind == LineKind::Folded && line.entry == 0)
        );
        let unchanged = state.entries.clone();
        let offset = state.offset;
        state.sync_entries(unchanged, 40, 6);
        assert_eq!(state.offset, offset);
    }

    #[test]
    fn drag_copy_requires_nonempty_span_and_outside_is_noop() {
        let mut state = sample();
        state.goto_top();
        state.selected = Some(0);
        let layout = FrameLayout {
            prompt: Rect::new(0, 20, 40, 4),
            transcript: Rect::new(0, 0, 40, 10),
            chrome: Rect::new(0, 24, 40, 1),
        };
        state.handle_mouse(
            mouse(MouseEventKind::Down(MouseButton::Left), 50, 30),
            layout,
            true,
        );
        let command = state.handle_mouse(
            mouse(MouseEventKind::Up(MouseButton::Left), 50, 31),
            layout,
            true,
        );
        assert_eq!(command, NavCommand::Consume);
        assert!(state.copy_target().is_none());
        assert_eq!(state.selected, Some(0));
        state.handle_mouse(
            mouse(MouseEventKind::Down(MouseButton::Left), 2, 24),
            layout,
            true,
        );
        state.handle_mouse(
            mouse(MouseEventKind::Drag(MouseButton::Left), 8, 24),
            layout,
            true,
        );
        let command = state.handle_mouse(
            mouse(MouseEventKind::Up(MouseButton::Left), 8, 24),
            layout,
            true,
        );
        assert_eq!(command, NavCommand::Consume);
        assert!(state.copy_target().is_none());
        assert_eq!(state.selected, Some(0));
    }

    #[test]
    fn search_jumps_then_escape_restores_reading_position() {
        let mut state = sample();
        state.goto_bottom();
        let before = state.bookmark();
        state.open_search(Some("ALPHA unique".into()));
        assert!(matches!(state.overlay, NavOverlay::Search(_)));
        assert_eq!(state.selected, Some(0));
        assert_ne!(state.bookmark(), before);
        state.dismiss_overlay();
        assert_eq!(state.overlay, NavOverlay::None);
        assert_eq!(state.bookmark(), before);
    }

    #[test]
    fn find_with_query_browses_n_without_appending() {
        let mut state = sample();
        state.goto_bottom();
        state.open_search(Some("unique".into()));
        let NavOverlay::Search(search) = &state.overlay else {
            panic!("expected search");
        };
        assert!(!search.composing);
        let first = search.current;
        let count = search.matches.len();
        assert!(count >= 2, "{count}");
        state.handle_key(key(KeyCode::Char('n')), true);
        let NavOverlay::Search(search) = &state.overlay else {
            panic!("expected search");
        };
        assert_eq!(search.query, "unique");
        assert_ne!(search.current, first);
        assert!(!search.composing);
    }

    #[test]
    fn empty_session_tab_is_not_consumed() {
        let mut state = NavState::new(NavigationPrefs::default(), true);
        state.focus = Focus::Prompt;
        assert_eq!(state.handle_key(key(KeyCode::Tab), true), NavCommand::None);
        assert_eq!(state.focus, Focus::Prompt);
    }

    #[test]
    fn ctrl_p_does_not_type_into_prompt() {
        let mut state = sample();
        state.focus = Focus::Prompt;
        assert_eq!(state.handle_key(ctrl('p'), true), NavCommand::None);
        state.focus = Focus::Scrollback;
        assert_eq!(state.handle_key(ctrl('p'), true), NavCommand::None);
        assert_eq!(state.overlay, NavOverlay::None);
    }

    #[test]
    fn ctrl_d_half_pages_scrollback() {
        let mut state = sample();
        state.goto_top();
        state.focus = Focus::Scrollback;
        let before = state.offset;
        assert_eq!(state.handle_key(ctrl('d'), true), NavCommand::Consume);
        assert!(state.offset > before);
        assert_eq!(state.overlay, NavOverlay::None);
    }

    #[test]
    fn jump_preview_escape_restores_and_enter_commits() {
        let mut state = sample();
        state.goto_top();
        state.selected = Some(0);
        let before = state.bookmark();
        state.open_jump();
        state.handle_key(key(KeyCode::Down), true);
        assert_eq!(state.selected, Some(1));
        assert_ne!(state.bookmark(), before);
        state.handle_key(key(KeyCode::Esc), true);
        assert_eq!(state.bookmark(), before);
        state.selected = Some(0);
        state.open_jump();
        state.handle_key(key(KeyCode::Down), true);
        state.handle_key(key(KeyCode::Enter), true);
        assert_eq!(state.overlay, NavOverlay::None);
        assert_eq!(state.selected, Some(1));
    }

    #[test]
    fn viewer_escape_restores_without_changing_draft_contract() {
        let mut state = sample();
        state.selected = Some(1);
        let before = state.bookmark();
        state.open_viewer();
        assert!(
            state
                .overlay_text()
                .contains("Esc restores reading position")
        );
        state.handle_key(key(KeyCode::Esc), true);
        assert_eq!(state.bookmark(), before);
    }

    #[test]
    fn streaming_and_resize_keep_reading_position() {
        let mut state = sample();
        state.scroll_by(-10);
        let bookmark = state.bookmark();
        let mut entries = state.entries.clone();
        entries[1].answer.push_str(" STREAM_TAIL");
        state.rebuild(entries.clone(), 40, 6);
        assert_eq!(state.bookmark(), bookmark);
        state.rebuild(entries, 20, 4);
        assert_eq!(state.bookmark().entry, bookmark.entry);
    }

    #[test]
    fn scroll_prefs_classify_and_clamp() {
        let mut prefs = NavigationPrefs::default();
        assert!((prefs.speed_multiplier() - 1.0).abs() < f64::EPSILON);
        prefs.scroll_speed = 1;
        assert!((prefs.speed_multiplier() - 0.1).abs() < 0.02);
        prefs.scroll_speed = 100;
        assert!((prefs.speed_multiplier() - 6.0).abs() < 0.02);
        prefs.scroll_speed = 200;
        prefs.scroll_speed = prefs.scroll_speed.clamp(1, 100);
        let mut state = NavState::new(prefs, true);
        state.prefs.scroll_mode = ScrollMode::parse("banana");
        assert_eq!(state.prefs.scroll_mode, ScrollMode::Auto);
        state.prefs.scroll_mode = ScrollMode::Wheel;
        assert_eq!(state.classify_scroll(), ScrollKind::Wheel);
        state.prefs.scroll_speed = 50;
        state.prefs.scroll_lines = None;
        assert_eq!(state.scroll_distance(ScrollKind::Trackpad), 1);
        assert_eq!(state.scroll_distance(ScrollKind::Wheel), 3);
        state.prefs.invert_scroll = true;
        let before = state.offset;
        state.apply_scroll(true);
        assert!(state.offset <= before);
    }

    #[test]
    fn parse_prefs_reads_mouse_and_vim_flags() {
        let prefs = parse_prefs(
            "[ui]\nmouse_reporting_toggle = true\nvim_mode = false\nscroll_mode = \"wheel\"\n",
        );
        assert!(prefs.mouse_reporting_toggle);
        assert!(!prefs.vim_mode);
        assert_eq!(prefs.scroll_mode, ScrollMode::Wheel);
    }

    #[test]
    fn env_overrides_only_on_first_load() {
        let mut prefs = NavigationPrefs::default();
        let mut env = BTreeMap::new();
        env.insert("GROK_SCROLL_MODE".into(), "trackpad".into());
        env.insert("GROK_SCROLL_SPEED".into(), "80".into());
        env.insert("GROK_INVERT_SCROLL".into(), "true".into());
        env.insert("GROK_MOUSE_REPORTING_TOGGLE".into(), "1".into());
        apply_env(&mut prefs, &env, true);
        assert_eq!(prefs.scroll_mode, ScrollMode::Trackpad);
        assert_eq!(prefs.scroll_speed, 80);
        assert!(prefs.invert_scroll);
        assert!(prefs.mouse_reporting_toggle);
        prefs.scroll_mode = ScrollMode::Wheel;
        apply_env(&mut prefs, &env, false);
        assert_eq!(prefs.scroll_mode, ScrollMode::Wheel);
        let rows = inspect_rows(&prefs);
        let mode = rows.iter().find(|row| row.0 == "ui.scroll_mode").unwrap();
        assert_eq!(mode.2, "env");
        let parsed = parse_prefs("[ui]\nscroll_mode = \"wheel\"\n");
        let config_row = inspect_rows(&parsed)
            .into_iter()
            .find(|row| row.0 == "ui.scroll_mode")
            .unwrap();
        assert_eq!(config_row.1, "wheel");
        assert_eq!(config_row.2, "config");
    }

    #[test]
    fn mouse_capture_toggle_does_not_open_picker_or_edit_prompt() {
        let mut state = sample();
        state.focus = Focus::Scrollback;
        assert!(!state.toggle_mouse());
        assert_eq!(state.handle_key(ctrl('r'), true), NavCommand::Consume);
        assert!(state.mouse_captured);
        state.prefs.mouse_reporting_toggle = true;
        let captured = state.mouse_captured;
        assert_eq!(state.handle_key(ctrl('r'), true), NavCommand::ToggleMouse);
        assert_ne!(state.mouse_captured, captured);
        assert_eq!(state.focus, Focus::Scrollback);
        assert_eq!(state.overlay, NavOverlay::None);
    }

    #[test]
    fn ctrl_f_opens_viewer_not_search() {
        let mut state = sample();
        state.goto_top();
        state.selected = Some(0);
        state.focus = Focus::Scrollback;
        assert_eq!(state.handle_key(ctrl('f'), true), NavCommand::Consume);
        assert!(matches!(state.overlay, NavOverlay::Viewer(_)));
        assert!(!matches!(state.overlay, NavOverlay::Search(_)));
    }

    #[test]
    fn vim_mode_letters_navigate_and_off_types_into_prompt() {
        let mut state = sample();
        state.goto_top();
        state.selected = Some(0);
        state.focus = Focus::Scrollback;
        state.prefs.vim_mode = true;
        assert_eq!(
            state.handle_key(key(KeyCode::Char('j')), true),
            NavCommand::Consume
        );
        assert_eq!(state.selected, Some(1));
        assert_eq!(
            state.handle_key(key(KeyCode::Char('k')), true),
            NavCommand::Consume
        );
        assert_eq!(state.selected, Some(0));
        assert_eq!(
            state.handle_key(key(KeyCode::Char('y')), true),
            NavCommand::CopyBlock
        );
        let yanked = state.copy_target().unwrap();
        assert!(!yanked.contains("answer ALPHA unique"), "{yanked}");
        assert!(yanked.contains("TOKEN_ALPHA prompt"), "{yanked}");
        state.selected = Some(0);
        state.goto_top();
        state.handle_key(key(KeyCode::Down), true);
        assert_eq!(
            state.handle_key(key(KeyCode::Char('Y')), true),
            NavCommand::CopyBlock
        );
        let meta = state.copy_target().unwrap();
        assert!(
            meta.starts_with("thought ") || meta.starts_with("user "),
            "{meta}"
        );
        assert!(!meta.contains('\n'), "{meta}");
        state.prefs.vim_mode = false;
        assert_eq!(
            state.handle_key(key(KeyCode::Char('j')), true),
            NavCommand::TypePrompt
        );
        assert_eq!(state.focus, Focus::Prompt);
    }

    #[test]
    fn simple_mode_shift_arrows_jump_turns_without_submitting() {
        let mut state = sample();
        state.goto_top();
        state.selected = Some(0);
        state.focus = Focus::Prompt;
        assert_eq!(
            state.handle_key(shift(KeyCode::Right), true),
            NavCommand::Consume
        );
        assert_eq!(state.focus, Focus::Scrollback);
        assert_eq!(state.selected, Some(1));
    }

    #[test]
    fn page_keys_from_prompt_keep_focus_and_draft_contract() {
        let mut state = sample();
        state.focus = Focus::Prompt;
        let selected = state.selected;
        assert_eq!(
            state.handle_key(key(KeyCode::PageUp), true),
            NavCommand::Consume
        );
        assert_eq!(state.focus, Focus::Prompt);
        assert_eq!(state.selected, selected);
    }

    #[test]
    fn invalid_regex_and_empty_query_find_nothing() {
        let mut state = sample();
        state.open_search(Some("[invalid".into()));
        if let NavOverlay::Search(search) = &state.overlay {
            assert!(search.error);
            assert!(search.matches.is_empty());
        } else {
            panic!("expected search");
        }
        state.open_search(Some(String::new()));
        if let NavOverlay::Search(search) = &state.overlay {
            assert!(!search.error);
            assert!(search.matches.is_empty());
        }
    }

    #[test]
    fn search_uses_laid_out_wrap_offsets() {
        let mut state = NavState::new(NavigationPrefs::default(), true);
        state.rebuild(
            vec![NavEntry::from_parts(
                "prompt",
                "",
                "abcdefghij wrapped-unique-tail",
                vec![],
            )],
            8,
            2,
        );
        state.goto_top();
        let before = state.bookmark();
        state.open_search(Some("wrapped-unique-tail".into()));
        if let NavOverlay::Search(search) = &state.overlay {
            assert_eq!(search.matches.len(), 1);
            assert_eq!(
                search.matches[0].line_in_entry,
                state.bookmark().line_in_entry
            );
            assert!(search.matches[0].line_in_entry > 0);
        } else {
            panic!("expected search");
        }
        assert_ne!(state.bookmark(), before);
        state.dismiss_overlay();
        assert_eq!(state.bookmark(), before);
    }

    #[test]
    fn viewer_page_keys_move_offset() {
        let mut state = sample();
        state.selected = Some(0);
        state.open_viewer();
        let NavOverlay::Viewer(viewer) = &state.overlay else {
            panic!("expected viewer");
        };
        assert_eq!(viewer.offset, 0);
        state.handle_key(key(KeyCode::Down), true);
        let NavOverlay::Viewer(viewer) = &state.overlay else {
            panic!("expected viewer");
        };
        assert_eq!(viewer.offset, 1);
        state.handle_key(key(KeyCode::PageDown), true);
        let NavOverlay::Viewer(after) = &state.overlay else {
            panic!("expected viewer");
        };
        assert!(after.offset >= 1);
        let overlay = state.overlay_text();
        assert!(
            overlay.contains("Esc restores reading position"),
            "{overlay}"
        );
        let body = overlay.split_once('\n').map(|(_, rest)| rest).unwrap_or("");
        assert!(
            after.offset == 0 || !body.starts_with("TOKEN_ALPHA prompt"),
            "{overlay}"
        );
    }

    #[test]
    fn drag_copy_slices_by_display_width() {
        let mut state = NavState::new(NavigationPrefs::default(), true);
        state.rebuild(
            vec![NavEntry::from_parts("prompt", "", "你好ALPHA", vec![])],
            40,
            6,
        );
        state.goto_top();
        let answer = state
            .lines
            .iter()
            .position(|line| line.kind == LineKind::Answer)
            .expect("answer");
        let layout = FrameLayout {
            prompt: Rect::new(0, 20, 40, 4),
            transcript: Rect::new(0, 0, 40, 10),
            chrome: Rect::new(0, 24, 40, 1),
        };
        let row = answer as u16;
        state.selected = Some(state.lines[answer].entry);
        let gutter = state.content_column(answer);
        let start = gutter + 4;
        let end = gutter + 9;
        state.handle_mouse(
            mouse(MouseEventKind::Down(MouseButton::Left), start, row),
            layout,
            true,
        );
        state.handle_mouse(
            mouse(MouseEventKind::Drag(MouseButton::Left), end, row),
            layout,
            true,
        );
        let command = state.handle_mouse(
            mouse(MouseEventKind::Up(MouseButton::Left), end, row),
            layout,
            true,
        );
        assert_eq!(command, NavCommand::CopyBlock);
        assert_eq!(state.copy_target().as_deref(), Some("ALPHA"));
    }

    #[test]
    fn click_and_drag_hit_geometry_matches_visible_lines() {
        let mut state = sample();
        let layout = FrameLayout {
            prompt: Rect::new(0, 12, 40, 3),
            transcript: Rect::new(0, 2, 40, 8),
            chrome: Rect::new(0, 0, 40, 1),
        };
        assert_eq!(layout.hit(3, 13), HitTarget::Prompt);
        assert_eq!(layout.hit(1, 0), HitTarget::Chrome { line: 0 });
        assert!(matches!(
            layout.hit(2, 3),
            HitTarget::Transcript { line: 1, .. }
        ));
        state.handle_mouse(
            mouse(MouseEventKind::Down(MouseButton::Left), 2, 3),
            layout,
            true,
        );
        state.handle_mouse(
            mouse(MouseEventKind::Up(MouseButton::Left), 2, 3),
            layout,
            true,
        );
        assert!(state.selected.is_some());
    }

    #[test]
    fn dock_gate_never_fabricates_a_pane() {
        assert_eq!(dock_message(false), DOCK_HIDDEN);
        assert_eq!(dock_message(true), DOCK_UNSUPPORTED);
    }

    #[test]
    fn minimal_mode_keys_fall_through_to_prompt() {
        let mut state = sample();
        state.focus = Focus::Scrollback;
        assert_eq!(
            state.handle_key(key(KeyCode::Char('j')), false),
            NavCommand::TypePrompt
        );
    }

    #[test]
    fn write_vim_mode_does_not_clobber_mouse_toggle() {
        let root = std::env::temp_dir().join(format!(
            "codsh-nav-prefs-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("config.toml"),
            "[ui]\nmouse_reporting_toggle = true\nvim_mode = false\n",
        )
        .unwrap();
        save_vim_mode(&root, true).unwrap();
        let body = std::fs::read_to_string(root.join("config.toml")).unwrap();
        assert!(body.contains("vim_mode = true"), "{body}");
        assert!(body.contains("mouse_reporting_toggle = true"), "{body}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn osc52_round_trip_ascii() {
        let payload = osc52("hello");
        assert!(payload.starts_with("\x1b]52;c;"));
        assert!(payload.ends_with('\u{7}'));
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
    }

    #[test]
    fn rebuild_remaps_selection_across_wrap_and_drops_missing_anchor() {
        let mut state = NavState::new(NavigationPrefs::default(), true);
        state.rebuild(
            vec![NavEntry::from_parts(
                "prompt",
                "",
                "abcdefghij wrapped-unique-tail KEEP",
                vec![],
            )],
            40,
            6,
        );
        state.goto_top();
        let answer = state
            .lines
            .iter()
            .position(|line| line.text.contains("abcdefghij"))
            .expect("answer");
        let start_col = state.lines[answer].text.find("abc").unwrap() as u16;
        state.selection = Some(SelectionSpan {
            start_line: answer,
            start_col,
            end_line: answer,
            end_col: start_col + 3,
        });
        state.remember_selection_anchor();
        let copied = state.copy_target().unwrap();
        assert_eq!(copied, "abc");
        state.rebuild(state.entries.clone(), 8, 4);
        let copied = state.copy_target().expect("selection survives wrap");
        assert_eq!(copied, "abc");
        assert!(
            state
                .painted_transcript_lines()
                .iter()
                .any(|line| line.contains('\u{2588}')
                    && line.contains("abc")
                    && !line.starts_with('|'))
        );
        state.rebuild(Vec::new(), 8, 4);
        assert!(state.selection.is_none());
        assert!(state.copy_target().is_none());
    }

    #[test]
    fn fullscreen_layout_paints_failed_tool_status_and_keeps_zwj_together() {
        let mut state = NavState::new(NavigationPrefs::default(), true);
        let mut entry = NavEntry::from_parts(
            "TOKEN_CONTENT_MISS",
            "",
            "Unicode: 你好 👩‍💻 café",
            vec![(
                "read".into(),
                "Error: cannot read missing-note.txt: not found".into(),
            )],
        );
        entry.tool_meta = vec![("t1".into(), "failed".into())];
        entry.errors = vec!["tool t1 failed".into()];
        state.rebuild(vec![entry], 80, 12);
        let painted = state
            .lines
            .iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(painted.contains("failed"), "{painted}");
        assert!(painted.contains("[error] tool t1 failed"), "{painted}");
        assert!(painted.contains("cannot read"), "{painted}");
        assert!(
            !painted.to_ascii_lowercase().contains("successfully"),
            "{painted}"
        );
        state.rebuild(state.entries.clone(), 10, 8);
        for line in &state.lines {
            let text = &line.text;
            if text.contains('👩') || text.contains('💻') || text.contains('\u{200d}') {
                assert!(
                    text.contains("👩\u{200d}💻"),
                    "ZWJ cluster split across a wrapped cell: {text:?}"
                );
            }
        }
        let joined = state
            .lines
            .iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>()
            .join("");
        assert!(joined.contains("👩\u{200d}💻"), "{joined}");
    }

    #[test]
    fn drag_uses_painted_gutter_not_an_inserted_bar() {
        let mut state = NavState::new(NavigationPrefs::default(), true);
        state.rebuild(
            vec![NavEntry::from_parts(
                "prompt",
                "",
                "\u{4f60}\u{597d}ALPHA",
                vec![],
            )],
            40,
            6,
        );
        state.goto_top();
        state.selected = Some(0);
        let answer = state
            .lines
            .iter()
            .position(|line| line.kind == LineKind::Answer)
            .expect("answer");
        let layout = FrameLayout {
            prompt: Rect::new(0, 20, 40, 4),
            transcript: Rect::new(0, 0, 40, 10),
            chrome: Rect::new(0, 24, 40, 1),
        };
        let row = answer as u16;
        let gutter = state.content_column(answer);
        assert_eq!(gutter, 2);
        let painted = &state.painted_transcript_lines()[answer];
        assert!(painted.starts_with("> ") || painted.starts_with("  "));
        assert!(!painted.starts_with('|'), "{painted}");
        let start = gutter + 4;
        let end = gutter + 9;
        state.handle_mouse(
            mouse(MouseEventKind::Down(MouseButton::Left), start, row),
            layout,
            true,
        );
        state.handle_mouse(
            mouse(MouseEventKind::Drag(MouseButton::Left), end, row),
            layout,
            true,
        );
        let command = state.handle_mouse(
            mouse(MouseEventKind::Up(MouseButton::Left), end, row),
            layout,
            true,
        );
        assert_eq!(command, NavCommand::CopyBlock);
        assert_eq!(state.copy_target().as_deref(), Some("ALPHA"));
        let painted = state.painted_transcript_lines().join("\n");
        assert!(painted.contains('\u{2588}'));
        assert!(!painted.lines().any(|line| line.starts_with('|')));
    }
}
