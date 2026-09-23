use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;
use xai_ratatui_textarea::TextArea;

pub const HISTORY_FILE: &str = "prompt-history.json";
pub const MAX_HISTORY: usize = 500;
const ESC_CLEAR_MS: u128 = 800;

pub const SLASH_COMMANDS: &[SlashCommand] = &[
    SlashCommand::new("compact", &[], "Compact conversation context", true),
    SlashCommand::new("context", &[], "Show context occupancy", true),
    SlashCommand::new(
        "dashboard",
        &["agents-dashboard", "sessions"],
        "Open the agent dashboard",
        true,
    ),
    SlashCommand::new(
        "edit-prompt",
        &[],
        "Open an external editor for an empty prompt",
        true,
    ),
    SlashCommand::new("effort", &[], "Select reasoning effort", false),
    SlashCommand::new("expand", &[], "Expand a scrollback block", true),
    SlashCommand::new("find", &[], "Search the transcript", true),
    SlashCommand::new("fork", &[], "Fork conversation history", false),
    SlashCommand::new("fullscreen", &["full"], "Switch to fullscreen", true),
    SlashCommand::new("history", &[], "Search prompt history", true),
    SlashCommand::new("jump", &[], "Jump to a turn", true),
    SlashCommand::new("minimal", &[], "Switch to minimal native history", true),
    SlashCommand::new("model", &["m"], "Select a model", false),
    SlashCommand::new("multiline", &["ml"], "Toggle multiline input", true),
    SlashCommand::new("onboarding", &[], "Open onboarding", true),
    SlashCommand::new("rewind", &["undo"], "Rewind conversation", false),
    SlashCommand::new("theme", &[], "Open themes", true),
    SlashCommand::new("timeline", &[], "Open the timeline", true),
    SlashCommand::new("tour", &[], "Open the tutorial", true),
    SlashCommand::new("tutorial", &[], "Open the tutorial", true),
    SlashCommand::new("vim-mode", &[], "Toggle vim-style scrollback keys", true),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlashCommand {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub hint: &'static str,
    pub run_immediate: bool,
}

impl SlashCommand {
    const fn new(
        name: &'static str,
        aliases: &'static [&'static str],
        hint: &'static str,
        run_immediate: bool,
    ) -> Self {
        Self {
            name,
            aliases,
            hint,
            run_immediate,
        }
    }

    fn rank(self, query: &str) -> Option<u8> {
        let q = query.trim_start_matches('/').to_ascii_lowercase();
        if q.is_empty() {
            return Some(3);
        }
        self.names()
            .map(|name| {
                if name == q {
                    0
                } else if name.starts_with(&q) {
                    1
                } else if name.contains(&q) {
                    2
                } else if subsequence(name, &q) {
                    3
                } else {
                    4
                }
            })
            .min()
            .filter(|rank| *rank < 4)
    }

    pub fn names(self) -> impl Iterator<Item = &'static str> {
        std::iter::once(self.name).chain(self.aliases.iter().copied())
    }

    pub fn primary(self) -> String {
        format!("/{}", self.name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Overlay {
    None,
    Slash,
    HistorySearch,
    HistoryBrowse,
    ShellComplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VimPrompt {
    Insert,
    Normal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    None,
    Unhandled,
    Submit(String),
    Slash(String),
    External { preserve: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostContext {
    pub inflight: bool,
    pub minimal: bool,
}

#[derive(Debug)]
pub struct PromptComposer {
    pub draft: TextArea,
    pub history: Vec<String>,
    pub stash: String,
    pub slash_stash: String,
    pub overlay: Overlay,
    pub matches: Vec<String>,
    pub cursor: usize,
    pub ghost: Option<String>,
    pub ghost_generation: u64,
    pub ghost_dismissed: bool,
    pub simple_mode: bool,
    pub vim: VimPrompt,
    pub multiline: bool,
    pub prompt_suggestions: bool,
    pub suggestions: bool,
    pub histfile: Option<PathBuf>,
    pub shell_history: Vec<String>,
    pub shell_mode: bool,
    pub chips: bool,
    pub footer_notice: String,
    pub last_esc: Option<Instant>,
    browse_origin: Option<String>,
    grok_home: PathBuf,
}

impl PromptComposer {
    pub fn load(grok_home: &Path, env: &[(String, String)]) -> Self {
        let prefs = load_prefs(grok_home, env);
        let history = load_history(grok_home);
        let histfile = env
            .iter()
            .find(|(key, _)| key == "HISTFILE")
            .map(|(_, value)| PathBuf::from(value));
        let shell_history = histfile
            .as_ref()
            .map(|path| load_histfile(path))
            .unwrap_or_default();
        Self {
            draft: TextArea::new(),
            history,
            stash: String::new(),
            slash_stash: String::new(),
            overlay: Overlay::None,
            matches: Vec::new(),
            cursor: 0,
            ghost: None,
            ghost_generation: 0,
            ghost_dismissed: false,
            simple_mode: prefs.simple_mode,
            vim: if prefs.simple_mode {
                VimPrompt::Insert
            } else {
                VimPrompt::Normal
            },
            multiline: false,
            prompt_suggestions: prefs.prompt_suggestions,
            suggestions: prefs.suggestions,
            histfile,
            shell_history,
            shell_mode: false,
            chips: false,
            footer_notice: String::new(),
            last_esc: None,
            browse_origin: None,
            grok_home: grok_home.to_path_buf(),
        }
    }

    pub fn text(&self) -> &str {
        self.draft.text()
    }

    pub fn set_text(&mut self, text: &str) {
        self.replace_draft(text);
        if text.is_empty() && !self.simple_mode {
            self.vim = VimPrompt::Normal;
        }
        self.refresh_slash_from_draft();
    }

    fn replace_draft(&mut self, text: &str) {
        self.draft.set_text(text);
        self.draft.set_cursor(self.draft.text().len());
    }

    pub fn is_empty(&self) -> bool {
        self.draft.is_empty() && self.slash_stash.is_empty()
    }

    pub fn footer(&self) -> String {
        let send = if self.multiline {
            "Shift+Enter:send"
        } else {
            "Enter:send"
        };
        let mode = if self.simple_mode {
            "readline"
        } else {
            match self.vim {
                VimPrompt::Insert => "vim-insert",
                VimPrompt::Normal => "vim-normal",
            }
        };
        // The draft border title is clipped on a normal terminal, so keep the
        // mode token first and the chords short enough to remain visible.
        let ghost = self
            .visible_ghost()
            .map(|rest| format!("  ghost:{rest}"))
            .unwrap_or_default();
        if !matches!(self.overlay, Overlay::None) {
            let label = match self.overlay {
                Overlay::Slash => "slash completion",
                Overlay::HistorySearch => "prompt history search",
                Overlay::HistoryBrowse => "history browse",
                Overlay::ShellComplete => "shell completion",
                Overlay::None => "",
            };
            return format!("{mode}  Draft (not sent)  {label}{ghost}");
        }
        format!("{mode}  Draft (not sent)  {send}{ghost}")
    }

    pub fn overlay_text(&self) -> String {
        match self.overlay {
            Overlay::None => self.footer_notice.clone(),
            Overlay::Slash => {
                let mut lines = vec!["slash completion  Tab/Enter accept  Esc cancel".into()];
                for (index, item) in self.matches.iter().enumerate() {
                    let mark = if index == self.cursor { ">" } else { " " };
                    let hint = SLASH_COMMANDS
                        .iter()
                        .find(|command| {
                            command.primary() == *item
                                || command.names().any(|name| format!("/{name}") == *item)
                        })
                        .map(|command| command.hint)
                        .unwrap_or("");
                    lines.push(format!("{mark} {item}  {hint}"));
                }
                if self.matches.is_empty() {
                    lines.push("  (no matches)".into());
                }
                lines.join("\n")
            }
            Overlay::HistorySearch => {
                let mut lines = vec!["prompt history search  Enter/Tab insert  Esc cancel".into()];
                for (index, item) in self.matches.iter().enumerate() {
                    let mark = if index == self.cursor { ">" } else { " " };
                    lines.push(format!("{mark} {item}"));
                }
                if self.matches.is_empty() {
                    lines.push("  (no matches)".into());
                }
                lines.join("\n")
            }
            Overlay::HistoryBrowse => {
                format!(
                    "history browse  {}/{}  ↓ past newest closes",
                    self.cursor.saturating_add(1),
                    self.history.len().max(1)
                )
            }
            Overlay::ShellComplete => {
                let mut lines = vec!["shell completion  Tab/Enter insert  Esc cancel".into()];
                for (index, item) in self.matches.iter().enumerate() {
                    let mark = if index == self.cursor { ">" } else { " " };
                    lines.push(format!("{mark} {item}"));
                }
                lines.join("\n")
            }
        }
    }

    pub fn paste(&mut self, text: &str) {
        if !self.simple_mode && self.vim == VimPrompt::Normal {
            self.vim = VimPrompt::Insert;
        }
        self.close_transient_overlays(false);
        self.draft.insert_str(text);
        self.refresh_slash_from_draft();
        self.footer_notice.clear();
    }

    pub fn record_history(&mut self, text: &str) {
        let trimmed = text.trim_end_matches('\n');
        if trimmed.is_empty() {
            return;
        }
        self.history.push(trimmed.to_string());
        if self.history.len() > MAX_HISTORY {
            let extra = self.history.len() - MAX_HISTORY;
            self.history.drain(0..extra);
        }
        let _ = save_history(&self.grok_home, &self.history);
    }

    #[cfg(test)]
    pub fn offer_ghost(&mut self, generation: u64, text: String) {
        if generation != self.ghost_generation || self.ghost_dismissed || !self.prompt_suggestions {
            return;
        }
        if text.is_empty() {
            return;
        }
        self.ghost = Some(text);
    }

    pub fn on_turn_finished(&mut self, suggestion: Option<String>) {
        self.ghost_generation = self.ghost_generation.saturating_add(1);
        self.ghost_dismissed = false;
        self.ghost = None;
        if self.prompt_suggestions
            && let Some(text) = suggestion.filter(|value| !value.is_empty())
        {
            self.ghost = Some(text);
        }
        if !self.simple_mode && self.draft.is_empty() {
            self.vim = VimPrompt::Normal;
        }
    }

    pub fn open_history_search(&mut self) {
        self.slash_stash = self.draft.text().to_string();
        self.overlay = Overlay::HistorySearch;
        self.replace_draft("");
        self.rebuild_history_matches("");
        self.footer_notice.clear();
    }

    pub fn toggle_multiline(&mut self) -> String {
        self.multiline = !self.multiline;
        format!("multiline {}", if self.multiline { "on" } else { "off" })
    }

    pub fn handle_key(&mut self, key: KeyEvent, ctx: HostContext) -> Action {
        if key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('m'))
            && !key.modifiers.contains(KeyModifiers::SHIFT)
            && !key.modifiers.contains(KeyModifiers::ALT)
            && !matches!(key.code, KeyCode::Enter)
        {
            // Kitty-protocol Ctrl+M is distinct from Enter (0x0d). Classic terminals
            // deliver Ctrl+M as Enter; `/multiline` remains the portable toggle.
            self.footer_notice = self.toggle_multiline();
            return Action::None;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('g'))
            && ctx.minimal
        {
            if self.chips {
                self.footer_notice =
                    "external editor refused: pasted, file-reference, or image chips must stay in the composer".into();
                return Action::None;
            }
            return Action::External { preserve: true };
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('s'))
            || (key.modifiers.contains(KeyModifiers::ALT) && matches!(key.code, KeyCode::Char('s')))
        {
            self.toggle_stash();
            return Action::None;
        }

        match self.overlay {
            Overlay::Slash => return self.handle_slash_overlay(key),
            Overlay::HistorySearch => return self.handle_history_search(key),
            Overlay::HistoryBrowse => return self.handle_history_browse(key),
            Overlay::ShellComplete => return self.handle_shell_complete(key),
            Overlay::None => {}
        }

        if !self.simple_mode && self.vim == VimPrompt::Insert && matches!(key.code, KeyCode::Esc) {
            self.leave_insert();
            return Action::None;
        }
        if matches!(key.code, KeyCode::Esc) {
            return self.handle_esc(ctx);
        }
        if self.is_send(&key) {
            if ctx.inflight && !self.draft.text().trim().starts_with('/') {
                return Action::None;
            }
            return self.submit_or_slash();
        }
        if self.is_newline(&key) {
            if !self.simple_mode && self.vim == VimPrompt::Normal {
                return Action::None;
            }
            self.draft.insert_str("\n");
            return Action::None;
        }
        if matches!(key.code, KeyCode::Tab) {
            return self.handle_tab();
        }
        if self.accept_ghost_right(&key) {
            return Action::None;
        }
        if self.handle_history_arrows(&key) {
            return Action::None;
        }
        if !self.simple_mode {
            return self.handle_vim(key);
        }
        self.handle_insert(key)
    }

    fn handle_insert(&mut self, key: KeyEvent) -> Action {
        if key.modifiers.is_empty()
            && matches!(key.code, KeyCode::Char('!'))
            && self.draft.is_empty()
        {
            self.shell_mode = true;
            self.draft.input(key);
            self.footer_notice = "shell mode  Tab completes HISTFILE".into();
            return Action::None;
        }
        if key.modifiers.is_empty()
            && matches!(key.code, KeyCode::Char('/'))
            && !self.draft.is_empty()
            && !self.draft.text().starts_with('/')
        {
            self.footer_notice.clear();
            // A nonempty prompt is not a slash command. Stash it so /minimal
            // and /fullscreen can run, then put the same draft back.
            self.slash_stash = self.draft.text().to_string();
            self.replace_draft("/");
            self.open_slash();
            return Action::None;
        }
        self.draft.input(key);
        if self.draft.text().starts_with('/') {
            self.open_slash();
        } else if (self.shell_mode || self.draft.text().starts_with('!')) && self.suggestions {
            self.open_shell_complete(false);
        } else {
            self.overlay = Overlay::None;
        }
        Action::None
    }

    fn handle_vim(&mut self, key: KeyEvent) -> Action {
        match self.vim {
            VimPrompt::Insert => self.handle_insert(key),
            VimPrompt::Normal => {
                match key.code {
                    KeyCode::Char('i') if key.modifiers.is_empty() => {
                        self.vim = VimPrompt::Insert;
                        self.footer_notice = "vim-insert".into();
                    }
                    KeyCode::Char('a') if key.modifiers.is_empty() => {
                        self.draft
                            .input(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
                        self.vim = VimPrompt::Insert;
                        self.footer_notice = "vim-insert".into();
                    }
                    KeyCode::Char('h') if key.modifiers.is_empty() => {
                        self.draft
                            .input(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
                    }
                    KeyCode::Char('l') if key.modifiers.is_empty() => {
                        self.draft
                            .input(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
                    }
                    KeyCode::Char('j') if key.modifiers.is_empty() => {
                        self.draft
                            .input(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
                    }
                    KeyCode::Char('k') if key.modifiers.is_empty() => {
                        self.draft
                            .input(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
                    }
                    KeyCode::Char('x') if key.modifiers.is_empty() => {
                        self.draft
                            .input(KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE));
                    }
                    KeyCode::Char('0') if key.modifiers.is_empty() => {
                        self.draft
                            .input(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
                    }
                    KeyCode::Char('$') => {
                        self.draft
                            .input(KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
                    }
                    _ => {}
                }
                Action::None
            }
        }
    }

    fn handle_slash_overlay(&mut self, key: KeyEvent) -> Action {
        if matches!(key.code, KeyCode::Esc) {
            self.cancel_slash();
            return Action::None;
        }
        if matches!(key.code, KeyCode::Up) {
            if self.cursor > 0 {
                self.cursor -= 1;
            }
            return Action::None;
        }
        if matches!(key.code, KeyCode::Down) {
            if self.cursor + 1 < self.matches.len() {
                self.cursor += 1;
            }
            return Action::None;
        }
        if matches!(key.code, KeyCode::Tab)
            || (matches!(key.code, KeyCode::Enter) && key.modifiers.is_empty())
        {
            if matches!(key.code, KeyCode::Enter)
                && (self.matches.is_empty() || slash_has_arguments(self.draft.text()))
            {
                return self.submit_or_slash();
            }
            return self.accept_slash();
        }
        if self.is_send(&key) {
            return self.submit_or_slash();
        }
        self.draft.input(key);
        if !self.draft.text().starts_with('/') {
            self.overlay = Overlay::None;
            self.matches.clear();
        } else {
            self.open_slash();
        }
        Action::None
    }

    fn handle_history_search(&mut self, key: KeyEvent) -> Action {
        if matches!(key.code, KeyCode::Esc) {
            let restored = std::mem::take(&mut self.slash_stash);
            self.replace_draft(&restored);
            self.overlay = Overlay::None;
            self.matches.clear();
            self.footer_notice = "history search cancelled".into();
            return Action::None;
        }
        if matches!(key.code, KeyCode::Up) {
            if self.cursor > 0 {
                self.cursor -= 1;
            }
            return Action::None;
        }
        if matches!(key.code, KeyCode::Down) {
            if self.cursor + 1 < self.matches.len() {
                self.cursor += 1;
            }
            return Action::None;
        }
        if matches!(key.code, KeyCode::Tab | KeyCode::Enter) {
            if let Some(item) = self.matches.get(self.cursor).cloned() {
                self.replace_draft(&item);
                self.overlay = Overlay::None;
                self.slash_stash.clear();
                self.footer_notice.clear();
            }
            return Action::None;
        }
        self.draft.input(key);
        let query = self.draft.text().to_string();
        self.rebuild_history_matches(&query);
        Action::None
    }

    fn handle_history_browse(&mut self, key: KeyEvent) -> Action {
        if matches!(key.code, KeyCode::Esc) {
            if let Some(origin) = self.browse_origin.take() {
                self.replace_draft(&origin);
            }
            self.overlay = Overlay::None;
            return Action::None;
        }
        if matches!(key.code, KeyCode::Up) {
            self.step_history(-1);
            return Action::None;
        }
        if matches!(key.code, KeyCode::Down) {
            if self.cursor + 1 >= self.history.len() {
                if let Some(origin) = self.browse_origin.take() {
                    self.replace_draft(&origin);
                } else {
                    self.replace_draft("");
                }
                self.overlay = Overlay::None;
                return Action::None;
            }
            self.step_history(1);
            return Action::None;
        }
        if self.is_send(&key) {
            self.overlay = Overlay::None;
            return self.submit_or_slash();
        }
        self.overlay = Overlay::None;
        self.browse_origin = None;
        self.draft.input(key);
        Action::None
    }

    fn handle_shell_complete(&mut self, key: KeyEvent) -> Action {
        if matches!(key.code, KeyCode::Esc) {
            self.overlay = Overlay::None;
            self.matches.clear();
            self.footer_notice = "completion cancelled".into();
            return Action::None;
        }
        if matches!(key.code, KeyCode::Up) {
            if self.cursor > 0 {
                self.cursor -= 1;
            }
            return Action::None;
        }
        if matches!(key.code, KeyCode::Down) {
            if self.cursor + 1 < self.matches.len() {
                self.cursor += 1;
            }
            return Action::None;
        }
        if matches!(key.code, KeyCode::Tab | KeyCode::Enter) {
            if let Some(item) = self.matches.get(self.cursor).cloned() {
                self.replace_draft(&item);
            }
            self.overlay = Overlay::None;
            return Action::None;
        }
        self.draft.input(key);
        self.open_shell_complete(false);
        Action::None
    }

    fn leave_insert(&mut self) {
        self.vim = VimPrompt::Normal;
        if !self.draft.is_empty() && self.draft.cursor() == self.draft.text().len() {
            self.draft
                .input(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
        }
        self.footer_notice = "vim-normal".into();
    }

    fn handle_esc(&mut self, ctx: HostContext) -> Action {
        if ctx.inflight {
            self.footer_notice = "Press Ctrl+C to cancel the turn".into();
            self.last_esc = None;
            return Action::None;
        }
        if self.visible_ghost().is_some() && self.draft.is_empty() {
            self.ghost_dismissed = true;
            self.ghost = None;
            self.footer_notice = "ghost dismissed".into();
            self.last_esc = None;
            return Action::None;
        }
        if !self.draft.is_empty() {
            let again = self
                .last_esc
                .is_some_and(|at| at.elapsed().as_millis() <= ESC_CLEAR_MS);
            if again {
                self.stash = self.draft.text().to_string();
                let stashed = self.stash.clone();
                self.record_history(&stashed);
                self.replace_draft("");
                self.slash_stash.clear();
                self.last_esc = None;
                self.footer_notice = "draft cleared (Ctrl+S restores)".into();
            } else {
                self.last_esc = Some(Instant::now());
                self.footer_notice = "press again to clear".into();
            }
            return Action::None;
        }
        Action::Unhandled
    }

    fn handle_tab(&mut self) -> Action {
        if self.accept_visible_ghost() {
            return Action::None;
        }
        if self.draft.text().starts_with('/') {
            self.open_slash();
            if self.matches.len() == 1 {
                return self.accept_slash();
            }
            return Action::None;
        }
        if self.shell_mode || self.draft.text().starts_with('!') {
            if self.histfile.as_ref().is_some_and(|path| {
                path.as_os_str().is_empty() || fs::read_to_string(path).is_err()
            }) {
                self.matches.clear();
                self.overlay = Overlay::None;
                self.footer_notice = "HISTFILE missing or unreadable".into();
                return Action::None;
            }
            self.open_shell_complete(true);
            if self.matches.len() == 1 {
                return self
                    .handle_shell_complete(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
            }
            return Action::None;
        }
        Action::None
    }

    fn handle_history_arrows(&mut self, key: &KeyEvent) -> bool {
        if !matches!(key.code, KeyCode::Up | KeyCode::Down) || !key.modifiers.is_empty() {
            return false;
        }
        if matches!(key.code, KeyCode::Down) && self.overlay != Overlay::HistoryBrowse {
            return false;
        }
        if !self.draft.is_empty() && self.overlay != Overlay::HistoryBrowse {
            return false;
        }
        if self.history.is_empty() {
            return false;
        }
        if self.overlay != Overlay::HistoryBrowse {
            self.browse_origin = Some(self.draft.text().to_string());
            self.overlay = Overlay::HistoryBrowse;
            self.cursor = self.history.len() - 1;
            if let Some(item) = self.history.get(self.cursor).cloned() {
                self.set_text(&item);
            }
            return true;
        }
        if matches!(key.code, KeyCode::Up) {
            self.step_history(-1);
        } else {
            self.step_history(1);
        }
        true
    }

    fn step_history(&mut self, delta: i32) {
        if self.history.is_empty() {
            return;
        }
        let next = self.cursor as i32 + delta;
        if next < 0 {
            self.cursor = 0;
        } else if next as usize >= self.history.len() {
            if let Some(origin) = self.browse_origin.take() {
                self.replace_draft(&origin);
            } else {
                self.replace_draft("");
            }
            self.overlay = Overlay::None;
            return;
        } else {
            self.cursor = next as usize;
        }
        if let Some(item) = self.history.get(self.cursor).cloned() {
            self.set_text(&item);
        }
    }

    fn submit_or_slash(&mut self) -> Action {
        let text = self.draft.text().to_string();
        if let Some(command) = slash_action(&text) {
            self.overlay = Overlay::None;
            let restored = std::mem::take(&mut self.slash_stash);
            return match command {
                PromptSlash::History => {
                    self.replace_draft("");
                    if !restored.is_empty() {
                        self.replace_draft(&restored);
                    }
                    self.open_history_search();
                    Action::None
                }
                PromptSlash::Multiline => {
                    self.replace_draft("");
                    if !restored.is_empty() {
                        self.replace_draft(&restored);
                    }
                    self.footer_notice = self.toggle_multiline();
                    Action::None
                }
                PromptSlash::EditPrompt => {
                    if restored.is_empty() {
                        self.replace_draft("");
                        Action::External { preserve: false }
                    } else {
                        self.replace_draft(&restored);
                        self.footer_notice = "/edit-prompt opens an empty prompt; use Ctrl+G in minimal to preserve a draft".into();
                        Action::None
                    }
                }
                PromptSlash::Passthrough(value) => {
                    self.replace_draft("");
                    if !restored.is_empty() {
                        self.replace_draft(&restored);
                    }
                    Action::Slash(value)
                }
            };
        }
        if text.trim().starts_with('/') {
            self.overlay = Overlay::None;
            let restored = std::mem::take(&mut self.slash_stash);
            self.replace_draft("");
            if !restored.is_empty() {
                self.replace_draft(&restored);
            }
            return Action::Slash(text.trim().to_string());
        }
        if text.trim().is_empty() {
            return Action::Submit(String::new());
        }
        self.record_history(&text);
        self.replace_draft("");
        self.overlay = Overlay::None;
        self.slash_stash.clear();
        self.shell_mode = false;
        self.ghost_dismissed = false;
        Action::Submit(text)
    }

    fn open_slash(&mut self) {
        let query = self.draft.text();
        let mut ranked: Vec<(u8, String)> = SLASH_COMMANDS
            .iter()
            .filter_map(|command| command.rank(query).map(|rank| (rank, command.primary())))
            .collect();
        ranked.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
        self.matches = ranked.into_iter().map(|(_, name)| name).collect();
        self.cursor = 0;
        self.overlay = Overlay::Slash;
    }

    fn accept_slash(&mut self) -> Action {
        let Some(item) = self.matches.get(self.cursor).cloned() else {
            self.overlay = Overlay::None;
            return Action::None;
        };
        let command = SLASH_COMMANDS
            .iter()
            .find(|candidate| candidate.primary() == item);
        self.overlay = Overlay::None;
        if command.is_some_and(|candidate| candidate.run_immediate) {
            let typed = self.draft.text().to_string();
            self.replace_draft("");
            let restored = std::mem::take(&mut self.slash_stash);
            if !restored.is_empty() {
                self.replace_draft(&restored);
            }
            if item == "/history" {
                self.open_history_search();
                return Action::None;
            }
            if item == "/multiline" || item == "/ml" {
                self.footer_notice = self.toggle_multiline();
                return Action::None;
            }
            if item == "/edit-prompt" {
                if self.draft.is_empty() {
                    return Action::External { preserve: false };
                }
                self.footer_notice =
                    "/edit-prompt opens an empty prompt; use Ctrl+G in minimal to preserve a draft"
                        .into();
                return Action::None;
            }
            if item == "/compact" {
                return Action::Slash(if typed.trim().starts_with("/compact") {
                    typed
                } else {
                    item
                });
            }
            return Action::Slash(item);
        }
        self.replace_draft(&format!("{item} "));
        Action::None
    }

    fn cancel_slash(&mut self) {
        let restored = std::mem::take(&mut self.slash_stash);
        if restored.is_empty() {
            self.replace_draft("");
        } else {
            self.replace_draft(&restored);
        }
        self.overlay = Overlay::None;
        self.matches.clear();
        self.footer_notice = "completion cancelled".into();
    }

    fn refresh_slash_from_draft(&mut self) {
        if self.overlay == Overlay::Slash && self.draft.text().starts_with('/') {
            self.open_slash();
        } else if self.overlay == Overlay::Slash {
            self.overlay = Overlay::None;
            self.matches.clear();
        }
    }

    fn rebuild_history_matches(&mut self, query: &str) {
        let q = query.trim().to_ascii_lowercase();
        self.matches = self
            .history
            .iter()
            .rev()
            .filter(|item| {
                q.is_empty()
                    || item.to_ascii_lowercase().contains(&q)
                    || subsequence(&item.to_ascii_lowercase(), &q)
            })
            .cloned()
            .collect();
        self.cursor = 0;
    }

    fn open_shell_complete(&mut self, force: bool) {
        if !self.suggestions && !force {
            return;
        }
        let typed = self.draft.text().trim_start_matches('!').trim_start();
        self.matches = self
            .shell_history
            .iter()
            .filter(|item| typed.is_empty() || item.starts_with(typed) || item.contains(typed))
            .cloned()
            .collect();
        self.matches.sort();
        self.matches.dedup();
        self.cursor = 0;
        if self.matches.is_empty() {
            if force {
                self.overlay = Overlay::ShellComplete;
            } else {
                self.overlay = Overlay::None;
            }
            return;
        }
        self.overlay = Overlay::ShellComplete;
    }

    fn visible_ghost(&self) -> Option<&str> {
        if self.ghost_dismissed || !self.prompt_suggestions {
            return None;
        }
        let ghost = self.ghost.as_deref()?;
        let text = self.draft.text();
        if text.is_empty() {
            return Some(ghost);
        }
        if ghost.starts_with(text) && self.draft.cursor() == text.len() {
            return Some(&ghost[text.len()..]);
        }
        None
    }

    fn accept_visible_ghost(&mut self) -> bool {
        let Some(ghost) = self.ghost.clone() else {
            return false;
        };
        if self.visible_ghost().is_none() {
            return false;
        }
        self.replace_draft(&ghost);
        self.ghost = None;
        true
    }

    fn accept_ghost_right(&mut self, key: &KeyEvent) -> bool {
        if matches!(key.code, KeyCode::Right)
            && key.modifiers.is_empty()
            && self.visible_ghost().is_some()
        {
            return self.accept_visible_ghost();
        }
        false
    }

    fn toggle_stash(&mut self) {
        if self.draft.is_empty() {
            if !self.stash.is_empty() {
                let restored = self.stash.clone();
                self.replace_draft(&restored);
                self.stash.clear();
                self.footer_notice = "stash restored".into();
            }
        } else {
            if !self.stash.is_empty() {
                let previous = self.stash.clone();
                self.record_history(&previous);
            }
            self.stash = self.draft.text().to_string();
            self.replace_draft("");
            self.footer_notice = "stashed".into();
        }
    }

    fn is_send(&self, key: &KeyEvent) -> bool {
        if !matches!(key.code, KeyCode::Enter) {
            return false;
        }
        if key.modifiers.contains(KeyModifiers::SUPER) {
            return false;
        }
        let modified = key.modifiers.contains(KeyModifiers::SHIFT)
            || key.modifiers.contains(KeyModifiers::ALT);
        if self.multiline { modified } else { !modified }
    }

    fn is_newline(&self, key: &KeyEvent) -> bool {
        if matches!(key.code, KeyCode::Enter) && key.modifiers.contains(KeyModifiers::SUPER) {
            return true;
        }
        if !matches!(key.code, KeyCode::Enter) {
            return false;
        }
        let modified = key.modifiers.contains(KeyModifiers::SHIFT)
            || key.modifiers.contains(KeyModifiers::ALT);
        if self.multiline { !modified } else { modified }
    }

    fn close_transient_overlays(&mut self, restore: bool) {
        if restore && matches!(self.overlay, Overlay::Slash | Overlay::HistorySearch) {
            let restored = std::mem::take(&mut self.slash_stash);
            if !restored.is_empty() {
                self.replace_draft(&restored);
            }
        }
        if self.overlay != Overlay::None {
            self.overlay = Overlay::None;
            self.matches.clear();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptSlash {
    History,
    Multiline,
    EditPrompt,
    #[allow(dead_code)]
    Passthrough(String),
}

fn slash_has_arguments(text: &str) -> bool {
    let rest = text.trim().trim_start_matches('/');
    rest.split_once(char::is_whitespace)
        .is_some_and(|(_, args)| !args.trim().is_empty())
}

pub fn slash_action(text: &str) -> Option<PromptSlash> {
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
        "history" => Some(PromptSlash::History),
        "multiline" | "ml" => Some(PromptSlash::Multiline),
        "edit-prompt" => Some(PromptSlash::EditPrompt),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptPrefs {
    pub simple_mode: bool,
    pub prompt_suggestions: bool,
    pub suggestions: bool,
}

pub fn load_prefs(grok_home: &Path, env: &[(String, String)]) -> PromptPrefs {
    let mut prefs = PromptPrefs {
        simple_mode: true,
        prompt_suggestions: env_flag(env, "GROK_PROMPT_SUGGESTIONS").unwrap_or(true),
        suggestions: env_flag(env, "GROK_SUGGESTIONS").unwrap_or(false),
    };
    if let Ok(body) = fs::read_to_string(grok_home.join("config.toml")) {
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
            let value = unquote(value.trim());
            match key {
                "simple_mode" => prefs.simple_mode = is_true(&value),
                "prompt_suggestions" if env_flag(env, "GROK_PROMPT_SUGGESTIONS").is_none() => {
                    prefs.prompt_suggestions = is_true(&value);
                }
                _ => {}
            }
        }
    }
    if env_flag(env, "GROK_PROMPT_SUGGESTIONS") == Some(false) {
        prefs.prompt_suggestions = false;
    }
    prefs
}

fn env_flag(env: &[(String, String)], name: &str) -> Option<bool> {
    env.iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| is_true(value))
}

fn is_true(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
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

fn subsequence(haystack: &str, needle: &str) -> bool {
    let mut chars = haystack.chars();
    needle
        .chars()
        .all(|wanted| chars.any(|have| have == wanted))
}

pub fn history_path(grok_home: &Path) -> PathBuf {
    grok_home.join(HISTORY_FILE)
}

pub fn load_history(grok_home: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(history_path(grok_home)) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save_history(grok_home: &Path, history: &[String]) -> std::io::Result<()> {
    fs::create_dir_all(grok_home)?;
    fs::write(history_path(grok_home), serde_json::to_vec_pretty(history)?)
}

pub fn load_histfile(path: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            if let Some(rest) = line.strip_prefix(": ")
                && let Some((_, command)) = rest.split_once(';')
            {
                return Some(command.to_string());
            }
            if line.starts_with('#') {
                return None;
            }
            Some(line.to_string())
        })
        .collect()
}

pub fn split_command(value: &str) -> Result<Vec<String>, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("empty editor command".into());
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = value.chars().peekable();
    let mut quote = None;
    while let Some(character) = chars.next() {
        match (quote, character) {
            (None, '"' | '\'') => quote = Some(character),
            (Some(mark), character) if character == mark => quote = None,
            (None, character) if character.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            (_, '\\') if quote != Some('\'') => {
                if let Some(next) = chars.next() {
                    cur.push(next);
                }
            }
            (_, character) => cur.push(character),
        }
    }
    if quote.is_some() {
        return Err("malformed editor command: unmatched quote".into());
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    if out.is_empty() {
        Err("malformed editor command".into())
    } else {
        Ok(out)
    }
}

pub fn resolve_editor(visual: Option<&str>, editor: Option<&str>) -> Result<Vec<String>, String> {
    let chosen = visual
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| editor.map(str::trim).filter(|value| !value.is_empty()))
        .unwrap_or("vi");
    split_command(chosen)
}

pub fn apply_saved_editor_text(saved: &str) -> String {
    let mut text = saved.to_string();
    if text.ends_with('\n') {
        text.pop();
        if text.ends_with('\r') {
            text.pop();
        }
    }
    text
}

pub fn run_external_editor(
    argv: &[String],
    path: &Path,
    extra_env: &[(String, String)],
) -> Result<String, String> {
    if argv.is_empty() {
        return Err("empty editor command".into());
    }
    let program = argv
        .first()
        .ok_or_else(|| "empty editor command".to_string())?;
    let mut command = Command::new(program);
    if argv.len() > 1 {
        command.args(&argv[1..]);
    }
    command.arg(path);
    for (key, value) in extra_env {
        command.env(key, value);
    }
    let status = command
        .status()
        .map_err(|error| format!("external editor failed to start: {error}"))?;
    if !status.success() {
        return Err(format!(
            "external editor exited {}",
            status.code().unwrap_or(-1)
        ));
    }
    let saved = fs::read_to_string(path).map_err(|error| error.to_string())?;
    Ok(apply_saved_editor_text(&saved))
}

pub fn write_editor_temp(home: &Path, draft: &str) -> std::io::Result<PathBuf> {
    let dir = home.join("tmp");
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("codsh-prompt-{}.md", std::process::id()));
    fs::write(&path, draft)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEvent;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    fn temp_home() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("codsh-prompt-{}-{}", std::process::id(), stamp));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn chord(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    fn ctx() -> HostContext {
        HostContext {
            inflight: false,
            minimal: false,
        }
    }

    #[test]
    fn official_textarea_keeps_unicode_undo_and_paste_without_submit() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.paste("你好👩\u{200d}💻");
        assert_eq!(composer.text(), "你好👩\u{200d}💻");
        composer.handle_key(key(KeyCode::Char(' ')), ctx());
        composer.handle_key(key(KeyCode::Char('a')), ctx());
        assert!(composer.text().ends_with('a'));
        composer.handle_key(chord(KeyCode::Char('z'), KeyModifiers::CONTROL), ctx());
        assert_eq!(composer.text(), "你好👩\u{200d}💻 ");
        let large = "α".repeat(8000);
        composer.paste(&large);
        assert!(composer.text().contains(&large));
        assert!(!matches!(
            composer.handle_key(chord(KeyCode::Enter, KeyModifiers::SHIFT), ctx()),
            Action::Submit(_)
        ));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn multiline_swaps_enter_and_shift_enter() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.handle_key(key(KeyCode::Char('a')), ctx());
        let action = composer.handle_key(chord(KeyCode::Enter, KeyModifiers::ALT), ctx());
        assert_eq!(action, Action::None);
        assert_eq!(composer.text(), "a\n");
        composer.footer_notice = composer.toggle_multiline();
        composer.handle_key(key(KeyCode::Char('b')), ctx());
        assert_eq!(
            composer.handle_key(key(KeyCode::Enter), ctx()),
            Action::None
        );
        assert_eq!(composer.text(), "a\nb\n");
        assert_eq!(
            composer.handle_key(chord(KeyCode::Enter, KeyModifiers::SHIFT), ctx()),
            Action::Submit("a\nb\n".into())
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn slash_completion_accept_and_escape_restore_draft() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_text("KEEP");
        composer.handle_key(key(KeyCode::Char('/')), ctx());
        assert_eq!(composer.text(), "/");
        assert_eq!(composer.slash_stash, "KEEP");
        assert_eq!(composer.overlay, Overlay::Slash);
        composer.set_text("");
        composer.handle_key(key(KeyCode::Char('/')), ctx());
        composer.handle_key(key(KeyCode::Char('h')), ctx());
        composer.handle_key(key(KeyCode::Char('i')), ctx());
        assert_eq!(composer.overlay, Overlay::Slash);
        assert!(composer.matches.iter().any(|item| item == "/history"));
        composer.handle_key(key(KeyCode::Esc), ctx());
        assert_eq!(composer.text(), "KEEP");
        assert_eq!(composer.overlay, Overlay::None);
        composer.set_text("");
        composer.handle_key(key(KeyCode::Char('/')), ctx());
        composer.handle_key(key(KeyCode::Char('m')), ctx());
        composer.handle_key(key(KeyCode::Char('l')), ctx());
        let action = composer.handle_key(key(KeyCode::Tab), ctx());
        assert_eq!(action, Action::None);
        assert!(composer.multiline);
        assert_eq!(composer.text(), "");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn edit_prompt_refuses_nonempty_draft() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_text("/edit-prompt");
        assert_eq!(
            composer.handle_key(key(KeyCode::Enter), ctx()),
            Action::External { preserve: false }
        );
        composer.slash_stash = "KEEP".into();
        composer.replace_draft("/edit-prompt");
        assert_eq!(
            composer.handle_key(key(KeyCode::Enter), ctx()),
            Action::None
        );
        assert!(composer.footer_notice.contains("empty prompt"));
        assert_eq!(composer.text(), "KEEP");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn history_search_and_browse_select_without_submitting() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.record_history("TOKEN_HIST_ONE");
        composer.record_history("TOKEN_HIST_TWO 你好");
        composer.open_history_search();
        composer.handle_key(key(KeyCode::Char('两')), ctx());
        composer.handle_key(key(KeyCode::Char('好')), ctx());
        composer.rebuild_history_matches("你好");
        assert!(
            composer
                .matches
                .iter()
                .any(|item| item.contains("TOKEN_HIST_TWO"))
        );
        composer.handle_key(key(KeyCode::Enter), ctx());
        assert_eq!(composer.text(), "TOKEN_HIST_TWO 你好");
        assert_eq!(composer.overlay, Overlay::None);
        composer.set_text("");
        composer.handle_key(key(KeyCode::Up), ctx());
        assert_eq!(composer.overlay, Overlay::HistoryBrowse);
        assert_eq!(composer.text(), "TOKEN_HIST_TWO 你好");
        composer.handle_key(key(KeyCode::Up), ctx());
        assert_eq!(composer.text(), "TOKEN_HIST_ONE");
        composer.handle_key(key(KeyCode::Char('x')), ctx());
        assert!(composer.text().contains("TOKEN_HIST_ONE"));
        assert!(composer.text().ends_with('x'));
        assert_eq!(composer.overlay, Overlay::None);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn vim_prompt_mode_does_not_insert_until_insert() {
        let home = temp_home();
        fs::write(home.join("config.toml"), "[ui]\nsimple_mode = false\n").unwrap();
        let mut composer = PromptComposer::load(&home, &[]);
        assert!(!composer.simple_mode);
        assert_eq!(composer.vim, VimPrompt::Normal);
        composer.handle_key(key(KeyCode::Char('h')), ctx());
        assert_eq!(composer.text(), "");
        composer.handle_key(key(KeyCode::Char('i')), ctx());
        composer.handle_key(key(KeyCode::Char('z')), ctx());
        composer.handle_key(key(KeyCode::Char('中')), ctx());
        assert_eq!(composer.text(), "z中");
        composer.handle_key(key(KeyCode::Esc), ctx());
        composer.handle_key(key(KeyCode::Char('x')), ctx());
        assert_eq!(composer.text(), "z");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn ghost_tab_accepts_without_submit_and_stale_generation_is_ignored() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.on_turn_finished(Some("TOKEN_GHOST_HINT".into()));
        assert_eq!(composer.visible_ghost(), Some("TOKEN_GHOST_HINT"));
        let action = composer.handle_key(key(KeyCode::Tab), ctx());
        assert_eq!(action, Action::None);
        assert_eq!(composer.text(), "TOKEN_GHOST_HINT");
        composer.set_text("");
        composer.on_turn_finished(Some("fresh".into()));
        let stale = composer.ghost_generation - 1;
        composer.offer_ghost(stale, "STALE_GHOST".into());
        assert_eq!(composer.ghost.as_deref(), Some("fresh"));
        composer.set_text("");
        composer.handle_key(key(KeyCode::Esc), ctx());
        assert!(composer.ghost_dismissed);
        assert!(composer.visible_ghost().is_none());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn histfile_completion_edits_without_executing() {
        let home = temp_home();
        let hist = home.join("bash_history");
        fs::write(&hist, "ls /tmp\nls /var\ngit status\n").unwrap();
        let tab_env = env(&[
            ("HISTFILE", hist.to_str().unwrap()),
            ("GROK_SUGGESTIONS", "false"),
        ]);
        let mut composer = PromptComposer::load(&home, &tab_env);
        assert!(!composer.suggestions);
        composer.handle_key(key(KeyCode::Char('!')), ctx());
        composer.handle_key(key(KeyCode::Char('l')), ctx());
        composer.handle_key(key(KeyCode::Char('s')), ctx());
        assert_eq!(composer.overlay, Overlay::None);
        composer.handle_key(key(KeyCode::Tab), ctx());
        assert_eq!(composer.overlay, Overlay::ShellComplete);
        assert!(composer.matches.iter().any(|item| item.starts_with("ls ")));
        composer.handle_key(key(KeyCode::Esc), ctx());
        assert_eq!(composer.text(), "!ls");
        composer.handle_key(key(KeyCode::Tab), ctx());
        composer.handle_key(key(KeyCode::Enter), ctx());
        assert!(composer.text().starts_with("ls "));
        assert_ne!(composer.overlay, Overlay::ShellComplete);
        let accepted = composer.text().to_string();
        assert!(accepted.starts_with("ls "));
        let as_you_type_env = env(&[
            ("HISTFILE", hist.to_str().unwrap()),
            ("GROK_SUGGESTIONS", "true"),
        ]);
        let mut live = PromptComposer::load(&home, &as_you_type_env);
        live.handle_key(key(KeyCode::Char('!')), ctx());
        live.handle_key(key(KeyCode::Char('l')), ctx());
        assert_eq!(live.overlay, Overlay::ShellComplete);
        let missing = home.join("missing_history");
        let missing_env = env(&[("HISTFILE", missing.to_str().unwrap())]);
        let mut empty = PromptComposer::load(&home, &missing_env);
        empty.handle_key(key(KeyCode::Char('!')), ctx());
        empty.handle_key(key(KeyCode::Char('l')), ctx());
        empty.handle_key(key(KeyCode::Tab), ctx());
        assert_eq!(empty.overlay, Overlay::None);
        assert!(empty.footer_notice.contains("HISTFILE"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn visual_wins_quoted_args_and_empty_save_clears_without_submit() {
        assert_eq!(
            resolve_editor(Some(r#"/bin/ed --flag "quoted arg""#), Some("nano")).unwrap(),
            vec!["/bin/ed", "--flag", "quoted arg"]
        );
        assert_eq!(
            resolve_editor(Some("  "), Some("nano")).unwrap(),
            vec!["nano"]
        );
        assert_eq!(resolve_editor(None, None).unwrap(), vec!["vi"]);
        assert!(split_command("ed 'unterminated").is_err());
        assert_eq!(apply_saved_editor_text("hello\n"), "hello");
        assert_eq!(apply_saved_editor_text("\n"), "");
        let home = temp_home();
        let script = home.join("editor.sh");
        fs::write(&script, "#!/bin/sh\nprintf '\\n' > \"$1\"\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
            let path = write_editor_temp(&home, "KEEP").unwrap();
            let saved =
                run_external_editor(&[script.to_string_lossy().into_owned()], &path, &[]).unwrap();
            assert_eq!(saved, "");
            let fail = home.join("fail.sh");
            fs::write(&fail, "#!/bin/sh\nexit 3\n").unwrap();
            fs::set_permissions(&fail, fs::Permissions::from_mode(0o755)).unwrap();
            let err = run_external_editor(&[fail.to_string_lossy().into_owned()], &path, &[])
                .unwrap_err();
            assert!(err.contains("exited 3"), "{err}");
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn slash_from_nonempty_draft_keeps_text_after_minimal() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_text("TOKEN_MODE_DRAFT");
        composer.handle_key(key(KeyCode::Char('/')), ctx());
        assert_eq!(composer.text(), "/");
        assert_eq!(composer.slash_stash, "TOKEN_MODE_DRAFT");
        assert_eq!(
            composer.handle_key(key(KeyCode::Char('m')), ctx()),
            Action::None
        );
        for ch in "inimal".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), ctx());
        }
        assert_eq!(
            composer.handle_key(key(KeyCode::Enter), ctx()),
            Action::Slash("/minimal".into())
        );
        assert_eq!(composer.text(), "TOKEN_MODE_DRAFT");
        assert!(!composer.chips);
        composer.on_turn_finished(None);
        assert!(composer.visible_ghost().is_none());
        assert_eq!(composer.handle_key(key(KeyCode::Tab), ctx()), Action::None);
        assert_eq!(composer.text(), "TOKEN_MODE_DRAFT");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn prompt_suggestions_env_disables_ghost() {
        let home = temp_home();
        fs::write(
            home.join("config.toml"),
            "[ui]\nprompt_suggestions = true\nsimple_mode = true\n",
        )
        .unwrap();
        let composer = PromptComposer::load(&home, &env(&[("GROK_PROMPT_SUGGESTIONS", "false")]));
        assert!(!composer.prompt_suggestions);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn slash_action_recognizes_prompt_commands() {
        assert!(matches!(
            slash_action("/history"),
            Some(PromptSlash::History)
        ));
        assert!(matches!(
            slash_action(" /ml "),
            Some(PromptSlash::Multiline)
        ));
        assert!(matches!(
            slash_action("/edit-prompt"),
            Some(PromptSlash::EditPrompt)
        ));
        assert!(slash_action("/model").is_none());
    }

    #[test]
    fn argument_slash_enter_submits_instead_of_completing() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        for ch in "/compact keep the auth plan".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), ctx());
        }
        assert_eq!(
            composer.handle_key(key(KeyCode::Enter), ctx()),
            Action::Slash("/compact keep the auth plan".into())
        );
        assert_eq!(composer.text(), "");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn bare_compact_enter_submits_compact_command() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        for ch in "/compact".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), ctx());
        }
        assert_eq!(
            composer.handle_key(key(KeyCode::Enter), ctx()),
            Action::Slash("/compact".into())
        );
        assert_eq!(composer.text(), "");
        let _ = fs::remove_dir_all(home);
    }
}
