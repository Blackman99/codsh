use crate::attachments::{
    AttachStatus, FileRef, PreparedAttachment, WorkspaceIndex, prompt_blocks,
};
use crate::images::{self, ImageRefusal, PreparedImage};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseEvent};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;
use xai_ratatui_textarea::{ElementId, ElementKind, TextArea};

/// Host tag for a file-reference chip. Paste and image chips use other tags.
pub const FILE_CHIP: ElementKind = ElementKind(2);
/// Atomic image chip. Backspace removes the placeholder and its bytes together.
pub const IMAGE_CHIP: ElementKind = ElementKind(3);

pub const HISTORY_FILE: &str = "prompt-history.json";
pub const MAX_HISTORY: usize = 500;
const ESC_CLEAR_MS: u128 = 800;

pub fn builtin_command_names() -> &'static [&'static str] {
    &[
        "compact",
        "context",
        "dashboard",
        "edit-prompt",
        "effort",
        "expand",
        "feedback",
        "find",
        "fork",
        "fullscreen",
        "history",
        "jump",
        "login",
        "logout",
        "minimal",
        "model",
        "multiline",
        "onboarding",
        "rewind",
        "theme",
        "timeline",
        "tour",
        "tutorial",
        "vim-mode",
        "reload-assets",
    ]
}

pub const SLASH_COMMANDS: &[SlashCommand] = &[
    SlashCommand::new("cd", &[], "Choose the next new-agent directory", false),
    SlashCommand::new("clear", &[], "Clear the visible transcript", true),
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
    SlashCommand::new("feedback", &[], "Open product feedback", true),
    SlashCommand::new("find", &[], "Search the transcript", true),
    SlashCommand::new("fork", &[], "Fork conversation history", false),
    SlashCommand::new("fullscreen", &["full"], "Switch to fullscreen", true),
    SlashCommand::new("history", &[], "Search prompt history", true),
    SlashCommand::new("jump", &[], "Jump to a turn", true),
    SlashCommand::new(
        "login",
        &[],
        "Sign in to a configured identity provider",
        true,
    ),
    SlashCommand::new(
        "logout",
        &[],
        "Sign out and clear cached identity credentials",
        true,
    ),
    SlashCommand::new("memory", &["mem"], "Browse local memory notes", true),
    SlashCommand::new("minimal", &[], "Switch to minimal native history", true),
    SlashCommand::new("model", &["m"], "Select a model", false),
    SlashCommand::new("multiline", &["ml"], "Toggle multiline input", true),
    SlashCommand::new("new", &[], "Start a new dsh session", true),
    SlashCommand::new("rename", &["title"], "Rename the current session", false),
    SlashCommand::new("resume", &[], "Resume a previous session", true),
    SlashCommand::new(
        "remember",
        &[],
        "Save a memory note after confirmation",
        true,
    ),
    SlashCommand::new("session-info", &["info"], "Show the current session", true),
    SlashCommand::new("onboarding", &[], "Open onboarding", true),
    SlashCommand::new(
        "reload-assets",
        &[],
        "Rescan rules, skills, and commands",
        true,
    ),
    SlashCommand::new("rewind", &["undo"], "Rewind conversation", false),
    SlashCommand::new("theme", &[], "Open themes", true),
    SlashCommand::new("timeline", &[], "Open the timeline", true),
    SlashCommand::new("tour", &[], "Open the tutorial", true),
    SlashCommand::new("tutorial", &[], "Open the tutorial", true),
    SlashCommand::new("vim-mode", &[], "Toggle vim-style scrollback keys", true),
    SlashCommand::new(
        "voice",
        &[],
        "Dictate into the draft; nothing is sent until Enter",
        true,
    ),
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
    FilePick,
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
    External {
        preserve: bool,
    },
    /// Explicit dictation. The host inserts text and never submits it.
    Voice(VoiceGesture),
    /// Ctrl+V / Alt+V. The host reads the platform clipboard and attaches an image.
    PasteImage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceGesture {
    /// Ctrl+Space or F8 pressed. Hold mode starts; toggle mode flips.
    Press,
    /// Key released. Only hold mode stops and transcribes.
    Release,
    /// The terminal cannot report release, so hold-to-talk must not start.
    UnsupportedRelease,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmittedPrompt {
    pub text: String,
    pub blocks: Vec<serde_json::Value>,
    /// Mentions that were attached when the turn started.
    pub mentions: Vec<String>,
    /// Verified rasters for a queued image. Blocks are rebuilt at send time
    /// from the model selected then, so a later text-only route is not an image block.
    pub images: Vec<PreparedImage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostContext {
    pub inflight: bool,
    pub minimal: bool,
    /// Hold-to-talk needs a key-release event. Terminals that omit it cannot stop a hold.
    pub voice_release: bool,
}

#[derive(Debug)]
pub struct PromptComposer {
    pub draft: TextArea,
    pub history: Vec<String>,
    pub stash: String,
    pub slash_stash: String,
    /// Image bytes hidden while a slash or history overlay replaces the draft.
    slash_images: Vec<PreparedImage>,
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
    pub asset_commands: Vec<(String, String)>,
    pub last_esc: Option<Instant>,
    browse_origin: Option<String>,
    /// Prompt text cleared for a submit the host has not accepted yet.
    pending_submit: Option<String>,
    pending_files: Vec<AttachedFile>,
    pending_images: Vec<PreparedImage>,
    prepared_submit: Option<SubmittedPrompt>,
    /// Prompts typed while a turn is running. Each keeps its own chips.
    queue: Vec<SubmittedPrompt>,
    grok_home: PathBuf,
    workspace: Option<WorkspaceIndex>,
    files: Vec<AttachedFile>,
    images: Vec<AttachedImage>,
    next_image_id: u32,
    /// The selected model declared `image` in `input_modalities`.
    accepts_images: bool,
    /// Isolated dsh home. Originals of text-only images are stored here.
    attachment_store: Option<PathBuf>,
    /// Cursor or pointer is on an image chip, so the preview line is showing.
    preview_image: Option<u32>,
    /// The pointer is over a chip. Leaving that chip returns to the cursor.
    hover_image: Option<ElementId>,
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
            slash_images: Vec::new(),
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
            asset_commands: Vec::new(),
            last_esc: None,
            browse_origin: None,
            pending_submit: None,
            pending_files: Vec::new(),
            pending_images: Vec::new(),
            prepared_submit: None,
            queue: Vec::new(),
            grok_home: grok_home.to_path_buf(),
            workspace: None,
            files: Vec::new(),
            images: Vec::new(),
            next_image_id: 1,
            accepts_images: false,
            attachment_store: None,
            preview_image: None,
            hover_image: None,
        }
    }

    pub fn set_workspace(&mut self, root: &Path) {
        self.workspace = Some(WorkspaceIndex::new(root));
    }

    /// Record whether the selected model declared image input, and where a
    /// text-only paste stores the original bytes.
    pub fn set_image_route(&mut self, accepts_images: bool, store: Option<&Path>) {
        self.accepts_images = accepts_images;
        self.attachment_store = store.map(Path::to_path_buf);
    }

    /// Put back a prompt whose submit did not start a turn. Returns whether
    /// the composer was already showing that text.
    pub fn restore_pending_submit(&mut self) -> bool {
        let files = std::mem::take(&mut self.pending_files);
        let images = std::mem::take(&mut self.pending_images);
        let Some(text) = self.pending_submit.take() else {
            return true;
        };
        if self.draft.text() == text && self.files == files && self.images.len() == images.len() {
            return true;
        }
        self.set_text(&text);
        self.restore_file_chips(&files);
        self.rebind_image_chips(&images);
        false
    }

    pub fn accept_pending_submit(&mut self) {
        self.pending_submit = None;
        self.pending_files.clear();
        self.pending_images.clear();
    }

    /// A bare slash submit was accepted. Do not put the parked draft back.
    pub fn discard_parked_draft(&mut self) {
        self.slash_stash.clear();
        self.slash_images.clear();
    }

    pub fn take_prepared_submit(&mut self) -> Option<SubmittedPrompt> {
        self.prepared_submit.take()
    }

    pub fn stage_prepared_submit(&mut self, prepared: SubmittedPrompt) {
        self.prepared_submit = Some(prepared);
    }

    pub fn queue_count(&self) -> usize {
        self.queue.len()
    }

    /// Put the oldest queued prompt back when send-time admission refuses it.
    /// The chip and its bytes stay visible; nothing is sent.
    pub fn restore_refused_queue_head(&mut self) -> bool {
        self.edit_queued(0)
    }

    /// Put a queued prompt back in the composer. Refused while the box holds text.
    pub fn edit_queued(&mut self, index: usize) -> bool {
        if !self.draft.is_empty() || index >= self.queue.len() {
            return false;
        }
        let item = self.queue.remove(index);
        // `set_text` already puts the mention in the draft. Re-inserting a
        // chip would append a second copy of the same file.
        self.set_text(&item.text);
        self.rebind_file_chips(&item.mentions);
        self.rebind_image_chips(&item.images);
        true
    }

    /// Prompts waiting for the current turn to finish.
    pub fn take_ready_queue(&mut self) -> Vec<SubmittedPrompt> {
        std::mem::take(&mut self.queue)
    }

    pub fn requeue(&mut self, items: Vec<SubmittedPrompt>) {
        let mut kept = items;
        kept.append(&mut self.queue);
        self.queue = kept;
    }

    /// Blocks for a prompt that was queued under a different model.
    /// The model and the bytes can change while it waits, so the digest is
    /// checked again and a text-only route replaces an image block with the
    /// saved path. An immediate submit already built its blocks and does not
    /// call this again.
    pub fn blocks_for_route(
        &self,
        prepared: &SubmittedPrompt,
    ) -> Result<Vec<serde_json::Value>, String> {
        if prepared.images.is_empty() {
            return Ok(prepared.blocks.clone());
        }
        let mut verified = Vec::with_capacity(prepared.images.len());
        for image in &prepared.images {
            let mut current = images::image_still_matches(image)
                .map_err(|error| format!("{}: {}", image.placeholder(), error.detail))?;
            if !self.accepts_images && current.saved_path.is_none() {
                let Some(store) = &self.attachment_store else {
                    return Err(format!(
                        "{}: text-only model needs the attachment store",
                        current.placeholder()
                    ));
                };
                current.saved_path = Some(
                    images::save_original(store, &current)
                        .map_err(|error| format!("{}: {error}", current.placeholder()))?,
                );
            }
            verified.push(current);
        }
        images::prompt_blocks_with_images(&prepared.text, &[], &verified, self.accepts_images)
    }

    fn enqueue_current(&mut self) -> bool {
        let prepared = match self.prepare_submit() {
            Ok(prepared) => prepared,
            Err(error) => {
                self.footer_notice = error;
                return false;
            }
        };
        self.files.clear();
        self.replace_draft("");
        self.overlay = Overlay::None;
        self.matches.clear();
        self.queue.push(prepared);
        self.footer_notice = format!("queued {}", self.queue.len());
        true
    }

    pub fn text(&self) -> &str {
        self.draft.text()
    }

    /// Text a late transcript may append to. A slash overlay hides the draft
    /// in `slash_stash`; that parked text is still the user's draft.
    pub fn voice_draft(&self) -> String {
        if matches!(self.overlay, Overlay::Slash | Overlay::HistorySearch)
            && !self.slash_stash.is_empty()
        {
            return self.slash_stash.clone();
        }
        self.draft.text().to_string()
    }

    /// Put a parked slash draft back after the host finishes a command.
    /// An empty stash must not wipe a draft the composer already restored.
    pub fn restore_slash_draft(&mut self) {
        if self.slash_stash.is_empty() {
            return;
        }
        let restored = std::mem::take(&mut self.slash_stash);
        self.restore_parked_draft(&restored);
    }

    /// Clear a slash command line without dropping a draft that was parked
    /// behind the overlay. `parked` is the draft captured before the host
    /// discarded `slash_stash`. The parked image bytes stay until this runs.
    pub fn clear_slash_line(&mut self, parked: &str) {
        self.slash_stash.clear();
        self.overlay = Overlay::None;
        self.matches.clear();
        self.restore_parked_draft(parked);
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
        self.refresh_file_state();
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
                Overlay::FilePick => "file picker",
                Overlay::None => "",
            };
            return format!("{mode}  Draft (not sent)  {label}{ghost}");
        }
        let queued = if self.queue_count() == 0 {
            String::new()
        } else {
            format!("  queued:{}", self.queue_count())
        };
        format!("{mode}  Draft (not sent)  {send}{queued}{ghost}")
    }

    pub fn overlay_text(&self) -> String {
        match self.overlay {
            Overlay::None => self.footer_notice.clone(),
            Overlay::Slash => {
                let mut lines = vec!["slash completion  Tab/Enter accept  Esc cancel".into()];
                // The session notice keeps one match row under this header.
                // Paint the cursor row so Down reveals the next command.
                let start = self.cursor.min(self.matches.len().saturating_sub(1));
                for (index, item) in self.matches.iter().enumerate().skip(start).take(1) {
                    let mark = if index == self.cursor { ">" } else { " " };
                    let hint = SLASH_COMMANDS
                        .iter()
                        .find(|command| {
                            command.primary() == *item
                                || command.names().any(|name| format!("/{name}") == *item)
                        })
                        .map(|command| command.hint)
                        .or_else(|| {
                            self.asset_commands
                                .iter()
                                .find(|(name, _)| name == item)
                                .map(|(_, hint)| hint.as_str())
                        })
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
            Overlay::FilePick => {
                let mut lines = vec![
                    "file picker  Tab/Enter attach  Esc cancel  ! searches hidden files".into(),
                ];
                for (index, item) in self.matches.iter().enumerate() {
                    let mark = if index == self.cursor { ">" } else { " " };
                    lines.push(format!("{mark} {item}"));
                }
                if self.matches.is_empty() {
                    lines.push("  (no files)".into());
                }
                if let Some(preview) = self.selected_file_preview() {
                    lines.push(preview);
                }
                lines.join("\n")
            }
        }
    }

    /// A bracketed paste. Whitespace alone inserts nothing, as in the
    /// reference: that is how a terminal delivers Cmd+V on an image-only
    /// clipboard, and the host probes the clipboard for the image instead.
    pub fn paste(&mut self, text: &str) {
        if text.trim().is_empty() {
            return;
        }
        if !self.simple_mode && self.vim == VimPrompt::Normal {
            self.vim = VimPrompt::Insert;
        }
        self.close_transient_overlays(false);
        if self.try_paste_image_payload(text) {
            return;
        }
        // An image file wins over the workspace-file drop, like the
        // reference: a png is an image chip, not a binary @file mention.
        if let Some(paths) = crate::dropped_paths::dropped_image_paths(text) {
            self.attach_dropped_images(&paths);
            return;
        }
        if self.try_drop_paths(text) {
            self.refresh_file_state();
            return;
        }
        self.draft.insert_str(text);
        self.refresh_slash_from_draft();
        self.footer_notice.clear();
    }

    /// Each dropped file is read and sniffed now. A corrupt, oversized, or
    /// unsupported one is named in the notice and adds no chip.
    fn attach_dropped_images(&mut self, paths: &[PathBuf]) {
        let mut refused = None;
        for path in paths {
            match images::read_image_file(path) {
                Ok(image) => self.insert_image(image),
                Err(error) => {
                    let name = path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| path.display().to_string());
                    // The sniffer speaks about the clipboard; this is a file.
                    let detail = match error.status {
                        AttachStatus::NotAFile => "not a png, jpeg, webp, or gif image".to_string(),
                        AttachStatus::Missing if path.is_file() => "image file is empty".into(),
                        _ => image_notice(&error),
                    };
                    refused = Some(format!("{name}: {detail}; not attached"));
                }
            }
        }
        if let Some(notice) = refused {
            self.footer_notice = notice;
        }
    }

    /// Ctrl+V image paste. An empty or corrupt clipboard stays out of the draft.
    pub fn paste_image_bytes(&mut self, bytes: &[u8]) -> Result<(), String> {
        match images::sniff_image(bytes) {
            Ok(image) => {
                self.insert_image(image);
                Ok(())
            }
            Err(error) => {
                self.footer_notice = image_notice(&error);
                Err(self.footer_notice.clone())
            }
        }
    }

    /// Metadata for the chip under the pointer, or under the cursor when the
    /// pointer has left. Frozen guide 03 shows the path here, not a graphics
    /// protocol. This client has no Kitty, OSC 1337, or half-block renderer.
    pub fn image_preview(&self) -> Option<String> {
        let id = self.preview_image?;
        let image = self.images.iter().find(|image| image.prepared.id == id)?;
        let path = image
            .prepared
            .saved_path
            .as_ref()
            .map(|path| format!("  {}", path.display()))
            .unwrap_or_default();
        Some(format!(
            "Pasted image #{}  {}{path}",
            image.prepared.id,
            image.prepared.preview_line()
        ))
    }

    /// Pointing at a chip shows that image. Moving off it follows the cursor.
    /// The prompt rect is the inner textarea from the last paint.
    pub fn hover_image(&mut self, mouse: MouseEvent, area: ratatui::layout::Rect) {
        if !matches!(mouse.kind, crossterm::event::MouseEventKind::Moved) {
            return;
        }
        let inside = mouse.column >= area.x
            && mouse.column < area.x.saturating_add(area.width)
            && mouse.row >= area.y
            && mouse.row < area.y.saturating_add(area.height);
        let hovered = if inside {
            self.draft
                .element_at_screen(
                    mouse.column,
                    mouse.row,
                    area,
                    xai_ratatui_textarea::TextAreaState::default(),
                )
                .filter(|element| element.kind == IMAGE_CHIP)
                .map(|element| element.id)
        } else {
            None
        };
        if hovered == self.hover_image {
            return;
        }
        self.hover_image = hovered;
        self.refresh_image_preview();
    }

    /// Backspace or delete that lands on a file chip removes that attachment.
    /// The cursor sits on the chip's end boundary after insert, so backspace
    /// there still belongs to that chip.
    pub fn delete_file_chip(&mut self, forward: bool) -> bool {
        let cursor = self.draft.cursor();
        let element = self
            .draft
            .elements()
            .iter()
            .find(|element| {
                (element.kind == FILE_CHIP || element.kind == IMAGE_CHIP)
                    && if forward {
                        cursor >= element.range.start && cursor < element.range.end
                    } else {
                        cursor > element.range.start && cursor <= element.range.end
                    }
            })
            .cloned();
        let Some(element) = element else {
            return false;
        };
        let id = element.id;
        self.files.retain(|file| file.id != id);
        self.images.retain(|image| image.id != id);
        self.draft.set_cursor(element.range.end);
        // One atomic grapheme removes the whole chip and its undo entry.
        self.draft.delete_backward(1);
        self.refresh_file_state();
        self.footer_notice = "attachment removed".into();
        true
    }

    pub fn prepare_submit(&mut self) -> Result<SubmittedPrompt, String> {
        self.sync_file_chips();
        self.sync_image_chips();
        let text = self.draft.text().to_string();
        let attachments: Vec<PreparedAttachment> = self
            .files
            .iter()
            .filter_map(|file| file.prepared.clone())
            .collect();
        let images: Vec<PreparedImage> = self
            .images
            .iter()
            .map(|image| image.prepared.clone())
            .collect();
        if attachments.is_empty() && images.is_empty() && text.trim().is_empty() {
            return Err("empty prompt".into());
        }
        let fresh = self.refresh_attached_bytes()?;
        let fresh_images = self.refresh_images()?;
        let blocks = if fresh_images.is_empty() {
            prompt_blocks(&text, &fresh)?
        } else {
            images::prompt_blocks_with_images(&text, &fresh, &fresh_images, self.accepts_images)?
        };
        let _ = attachments;
        let _ = images;
        Ok(SubmittedPrompt {
            text,
            blocks,
            mentions: fresh.iter().map(|item| item.mention.clone()).collect(),
            images: fresh_images,
        })
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
        self.park_draft_for_slash();
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
        if is_voice_chord(&key) {
            self.footer_notice.clear();
            return Action::Voice(voice_gesture(&key, ctx.voice_release));
        }
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
        if self.is_image_paste(&key) {
            return Action::PasteImage;
        }

        match self.overlay {
            Overlay::Slash => return self.handle_slash_overlay(key),
            Overlay::HistorySearch => return self.handle_history_search(key),
            Overlay::HistoryBrowse => return self.handle_history_browse(key),
            Overlay::ShellComplete => return self.handle_shell_complete(key),
            Overlay::FilePick => return self.handle_file_pick(key),
            Overlay::None => {}
        }

        if !self.simple_mode && self.vim == VimPrompt::Insert && matches!(key.code, KeyCode::Esc) {
            self.leave_insert();
            return Action::None;
        }
        if matches!(key.code, KeyCode::Esc) {
            return self.handle_esc(ctx);
        }
        if key.modifiers.contains(KeyModifiers::ALT)
            && matches!(key.code, KeyCode::Up)
            && self.edit_queued(0)
        {
            self.footer_notice = "queued prompt restored".into();
            return Action::None;
        }
        if self.is_send(&key) {
            // A slash line is a command, including while a turn is running.
            // Queuing it would send `/model` as the next prompt instead of
            // changing the route that queued images are rebuilt for.
            if ctx.inflight && !self.draft.text().trim().starts_with('/') {
                self.enqueue_current();
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
            && (!self.draft.is_empty() || self.chips)
            && !self.draft.text().starts_with('/')
        {
            self.footer_notice.clear();
            // A nonempty prompt is not a slash command. Stash it so /minimal
            // and /fullscreen can run, then put the same draft back.
            self.park_draft_for_slash();
            self.replace_draft("/");
            self.open_slash();
            return Action::None;
        }
        if matches!(key.code, KeyCode::Backspace) {
            let deleted = self.delete_file_chip(false);
            if deleted {
                return Action::None;
            }
        }
        if matches!(key.code, KeyCode::Delete) && self.delete_file_chip(true) {
            return Action::None;
        }
        self.draft.input(key);
        self.sync_file_chips();
        self.sync_image_chips();
        self.refresh_image_preview();
        if self.draft.text().starts_with('/') {
            self.open_slash();
        } else if (self.shell_mode || self.draft.text().starts_with('!')) && self.suggestions {
            self.open_shell_complete(false);
        } else if self.file_query_active() {
            self.open_file_pick(false);
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
                // `/model cli-mock-fork` is the typed command. The menu item
                // is only `/model` and would drop the selected id.
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
            self.restore_parked_draft(&restored);
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

    fn handle_file_pick(&mut self, key: KeyEvent) -> Action {
        if matches!(key.code, KeyCode::Esc) {
            self.cancel_file_pick();
            return Action::None;
        }
        if matches!(key.code, KeyCode::Up) {
            if self.cursor > 0 {
                self.cursor -= 1;
            }
            self.footer_notice = self.selected_file_preview().unwrap_or_default();
            return Action::None;
        }
        if matches!(key.code, KeyCode::Down) {
            if self.cursor + 1 < self.matches.len() {
                self.cursor += 1;
            }
            self.footer_notice = self.selected_file_preview().unwrap_or_default();
            return Action::None;
        }
        if matches!(key.code, KeyCode::Tab | KeyCode::Enter) {
            return self.accept_file_pick();
        }
        if matches!(key.code, KeyCode::Backspace) {
            self.draft.input(key);
            self.sync_file_chips();
            if !self.file_query_active() {
                self.overlay = Overlay::None;
                self.matches.clear();
                return Action::None;
            }
            self.open_file_pick(false);
            return Action::None;
        }
        self.draft.input(key);
        if !self.file_query_active() {
            self.overlay = Overlay::None;
            self.matches.clear();
        } else {
            self.open_file_pick(false);
        }
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
        if self.file_query_active() {
            self.open_file_pick(true);
            if self.matches.len() == 1 && !self.matches[0].ends_with('/') {
                return self.accept_file_pick();
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
        // An empty draft has no completion. Leave Tab for the welcome menu.
        if self.draft.is_empty() {
            return Action::Unhandled;
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

    fn restore_stashed_draft(&mut self, restored: &str) {
        if restored.is_empty() {
            return;
        }
        self.restore_parked_draft(restored);
    }

    fn submit_or_slash(&mut self) -> Action {
        let text = self.draft.text().to_string();
        if let Some(command) = slash_action(&text) {
            self.overlay = Overlay::None;
            let restored = std::mem::take(&mut self.slash_stash);
            let action = match command {
                PromptSlash::History => {
                    self.replace_draft("");
                    self.restore_stashed_draft(&restored);
                    self.open_history_search();
                    Action::None
                }
                PromptSlash::Multiline => {
                    self.replace_draft("");
                    self.restore_stashed_draft(&restored);
                    self.footer_notice = self.toggle_multiline();
                    Action::None
                }
                PromptSlash::ReloadAssets => {
                    self.replace_draft("");
                    self.restore_stashed_draft(&restored);
                    Action::Slash("/reload-assets".into())
                }
                PromptSlash::EditPrompt => {
                    if restored.is_empty() {
                        self.replace_draft("");
                        Action::External { preserve: false }
                    } else {
                        self.restore_stashed_draft(&restored);
                        self.footer_notice = "/edit-prompt opens an empty prompt; use Ctrl+G in minimal to preserve a draft".into();
                        Action::None
                    }
                }
                PromptSlash::Voice => {
                    self.replace_draft("");
                    self.restore_stashed_draft(&restored);
                    Action::Slash(text.trim().to_string())
                }
                PromptSlash::Passthrough(value) => {
                    self.replace_draft("");
                    self.restore_stashed_draft(&restored);
                    Action::Slash(value)
                }
            };
            self.refresh_file_state();
            return action;
        }
        if text.trim().starts_with('/') {
            self.overlay = Overlay::None;
            let restored = std::mem::take(&mut self.slash_stash);
            self.replace_draft("");
            self.restore_stashed_draft(&restored);
            self.refresh_file_state();
            return Action::Slash(text.trim().to_string());
        }
        if text.trim().is_empty() && !self.chips {
            return Action::Submit(String::new());
        }
        let prepared = match self.prepare_submit() {
            Ok(prepared) => prepared,
            Err(error) => {
                // Admission failed before the draft moved, so the chip and
                // its unread bytes stay in the composer.
                self.footer_notice = error;
                return Action::None;
            }
        };
        // History is recorded by the host only after dsh accepts the prompt.
        // Keep the cleared text and chips until that accept; a refused
        // submit puts both back. Removed chips are already gone.
        self.pending_submit = Some(prepared.text.clone());
        self.pending_files = self.files.clone();
        self.pending_images = self
            .images
            .iter()
            .map(|image| image.prepared.clone())
            .collect();
        self.prepared_submit = Some(prepared.clone());
        self.files.clear();
        self.images.clear();
        self.replace_draft("");
        self.overlay = Overlay::None;
        self.slash_stash.clear();
        self.shell_mode = false;
        self.ghost_dismissed = false;
        self.chips = false;
        Action::Submit(prepared.text)
    }

    fn open_slash(&mut self) {
        let query = self.draft.text();
        let mut ranked: Vec<(u8, String)> = SLASH_COMMANDS
            .iter()
            .filter_map(|command| command.rank(query).map(|rank| (rank, command.primary())))
            .chain(self.asset_commands.iter().filter_map(|(name, _)| {
                rank_slash_name(name, query).map(|rank| (rank, name.clone()))
            }))
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
        let asset = self.asset_commands.iter().any(|(name, _)| name == &item);
        if asset || command.is_some_and(|candidate| candidate.run_immediate) {
            let typed = self.draft.text().to_string();
            self.replace_draft("");
            let restored = std::mem::take(&mut self.slash_stash);
            if !restored.is_empty() {
                self.restore_parked_draft(&restored);
            }
            if item == "/history" {
                self.open_history_search();
                return Action::None;
            }
            if item == "/multiline" || item == "/ml" {
                self.footer_notice = self.toggle_multiline();
                return Action::None;
            }
            if item == "/reload-assets" {
                return Action::Slash(item);
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
            if item == "/voice" {
                return Action::Slash("/voice".into());
            }
            if item == "/compact"
                || item == "/login"
                || item == "/logout"
                || item == "/feedback"
                || item == "/remember"
                || item == "/memory"
                || item == "/mem"
            {
                return Action::Slash(if typed.trim().starts_with(&item) {
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
        self.restore_parked_draft(&restored);
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

    fn replace_file_query(&mut self, replacement: &str) {
        let Some((start, token)) = self.file_query() else {
            self.draft.insert_str(replacement);
            return;
        };
        let end = start + token.len();
        if end > start {
            self.draft.set_cursor(end);
            let mut remaining = end - start;
            while remaining > 0 {
                let before = self.draft.cursor();
                self.draft.delete_backward(1);
                let after = self.draft.cursor();
                if after == before {
                    break;
                }
                remaining = remaining.saturating_sub(before - after);
            }
        }
        if !replacement.is_empty() {
            self.draft.insert_str(replacement);
        }
    }

    fn file_query(&self) -> Option<(usize, String)> {
        let text = self.draft.text();
        let cursor = self.draft.cursor().min(text.len());
        if self.draft.elements().iter().any(|element| {
            element.kind == FILE_CHIP && cursor > element.range.start && cursor <= element.range.end
        }) {
            return None;
        }
        let head = &text[..cursor];
        let start = head
            .rfind([' ', '\n', '\t'])
            .map(|index| index + 1)
            .unwrap_or(0);
        let token = &head[start..];
        if token.starts_with('@') && !token.contains(' ') {
            Some((start, token.to_string()))
        } else {
            None
        }
    }

    fn file_query_active(&self) -> bool {
        self.workspace.is_some()
            && self
                .file_query()
                .is_some_and(|(_, token)| WorkspaceIndex::parse_query(&token).is_ok())
    }

    fn open_file_pick(&mut self, force: bool) {
        let Some(index) = self.workspace.as_ref() else {
            return;
        };
        let Some((_, token)) = self.file_query() else {
            self.overlay = Overlay::None;
            return;
        };
        let Ok((hidden, path, _range)) = WorkspaceIndex::parse_query(&token) else {
            self.overlay = Overlay::None;
            return;
        };
        let _ = force;
        let query = if hidden {
            format!("!{path}")
        } else {
            path.clone()
        };
        let matches = index.search(&query);
        self.matches = matches
            .into_iter()
            .map(|item| item.relative)
            .filter(|relative| {
                path.is_empty()
                    || relative
                        .to_ascii_lowercase()
                        .contains(&path.to_ascii_lowercase())
                    || relative
                        .trim_end_matches('/')
                        .ends_with(path.trim_end_matches('/'))
            })
            .take(8)
            .collect();
        if self.cursor >= self.matches.len() {
            self.cursor = 0;
        }
        if self.matches.is_empty() && !force && path.is_empty() {
            self.overlay = Overlay::FilePick;
            return;
        }
        self.overlay = Overlay::FilePick;
        self.footer_notice = self.selected_file_preview().unwrap_or_default();
    }

    fn selected_file_preview(&self) -> Option<String> {
        let relative = self.matches.get(self.cursor)?;
        if relative.ends_with('/') {
            return Some(format!("directory {relative}"));
        }
        let index = self.workspace.as_ref()?;
        let reference = FileRef {
            relative: relative.trim_end_matches('/').to_string(),
            range: self.file_query().and_then(|(_, token)| {
                WorkspaceIndex::parse_query(&token)
                    .ok()
                    .and_then(|(_, _, range)| range)
            }),
            dropped: false,
        };
        let prepared = index.prepare(&reference, None);
        if prepared.status != AttachStatus::Ready {
            return Some(format!("{}: {}", prepared.status.label(), prepared.detail));
        }
        let body = prepared.preview.replace('\n', " ");
        Some(format!("preview {body}"))
    }

    fn accept_file_pick(&mut self) -> Action {
        let Some(relative) = self.matches.get(self.cursor).cloned() else {
            self.footer_notice = "no file matches".into();
            return Action::None;
        };
        if relative.ends_with('/') {
            self.replace_file_query(&format!("@{relative}"));
            self.open_file_pick(true);
            return Action::None;
        }
        let range = self
            .file_query()
            .and_then(|(_, token)| WorkspaceIndex::parse_query(&token).ok())
            .and_then(|(_, _, range)| range);
        let reference = FileRef {
            relative: relative.trim_end_matches('/').to_string(),
            range,
            dropped: false,
        };
        self.insert_file_chip(reference);
        Action::None
    }

    fn cancel_file_pick(&mut self) {
        self.overlay = Overlay::None;
        self.matches.clear();
        self.footer_notice = "file picker cancelled".into();
    }

    fn insert_file_chip(&mut self, reference: FileRef) {
        let Some(index) = self.workspace.clone() else {
            self.footer_notice = "no workspace for file attachments".into();
            return;
        };
        let prepared = index.prepare(&reference, None);
        if prepared.status != AttachStatus::Ready {
            self.footer_notice = format!(
                "{}: {}",
                prepared.status.label(),
                if prepared.detail.is_empty() {
                    "not attached".to_string()
                } else {
                    prepared.detail.clone()
                }
            );
            self.overlay = Overlay::None;
            return;
        }
        let mention = reference.mention();
        self.replace_file_query("");
        let display = ratatui::text::Line::from(format!("[{}]", reference.display()));
        let id = self.draft.replace_range_with_element(
            self.draft.cursor()..self.draft.cursor(),
            &mention,
            FILE_CHIP,
            Some(display),
        );
        self.files.push(AttachedFile {
            id,
            reference,
            prepared: Some(prepared),
        });
        self.overlay = Overlay::None;
        self.matches.clear();
        self.refresh_file_state();
        self.footer_notice = format!("attached {mention}");
    }

    fn try_drop_paths(&mut self, text: &str) -> bool {
        let Some(index) = self.workspace.clone() else {
            return false;
        };
        let lines: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        if lines.is_empty() {
            return false;
        }
        let paths: Vec<std::result::Result<FileRef, crate::attachments::AttachRefusal>> = lines
            .iter()
            .copied()
            .map(|line| index.resolve_drop(line))
            .collect();
        // Every line has to be a workspace file. A sentence that only mentions
        // a path does not resolve, so it stays in the draft. Names may contain
        // spaces; the whole line is the path.
        let looks_like_paths = !paths.is_empty() && paths.iter().all(Result::is_ok);
        if !looks_like_paths {
            return false;
        }
        for item in paths {
            match item {
                Ok(reference) => self.insert_file_chip(reference),
                Err(rejected) => {
                    self.footer_notice =
                        format!("{}: {}", rejected.status.label(), rejected.detail);
                }
            }
        }
        true
    }

    fn sync_file_chips(&mut self) {
        let live: Vec<(ElementId, String)> = self
            .draft
            .elements()
            .iter()
            .filter(|element| element.kind == FILE_CHIP)
            .filter_map(|element| {
                self.draft
                    .element_text(element.id)
                    .map(|text| (element.id, text.to_string()))
            })
            .collect();
        self.files
            .retain(|file| live.iter().any(|(id, _)| *id == file.id));
        let index = self.workspace.clone();
        for (id, text) in live {
            if self.files.iter().any(|file| file.id == id) {
                continue;
            }
            let Some(reference) = index.as_ref().and_then(|index| index.resolve_typed(&text))
            else {
                continue;
            };
            let prepared = index.as_ref().map(|index| index.prepare(&reference, None));
            self.files.push(AttachedFile {
                id,
                reference,
                prepared,
            });
        }
        self.refresh_file_state();
    }

    fn park_draft_for_slash(&mut self) {
        // The overlay replaces the visible text, which drops chip metadata.
        // Hold the verified bytes only until that text is put back.
        self.slash_stash = self.draft.text().to_string();
        if self.slash_images.is_empty() {
            self.slash_images = self
                .images
                .iter()
                .map(|image| image.prepared.clone())
                .collect();
        }
    }

    /// Put stashed placeholder text back and retag the held image bytes.
    /// The cursor stays at the end of that text. A caller that already put
    /// the same draft back is left alone, so a second call cannot wipe it.
    /// An empty stash means there was no parked draft; it does not clear a
    /// draft the caller already restored.
    fn restore_parked_draft(&mut self, text: &str) {
        let parked = std::mem::take(&mut self.slash_images);
        if text.is_empty() {
            self.refresh_image_preview();
            return;
        }
        let images = if parked.is_empty() {
            self.images
                .iter()
                .map(|image| image.prepared.clone())
                .collect::<Vec<_>>()
        } else {
            parked
        };
        if self.draft.text() == text && images_match_draft(&self.images, &images) {
            self.refresh_image_preview();
            return;
        }
        self.replace_draft(text);
        self.rebind_image_chips(&images);
    }

    fn is_image_paste(&self, key: &KeyEvent) -> bool {
        let control = key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('v') | KeyCode::Char('V'));
        let alt = key.modifiers.contains(KeyModifiers::ALT)
            && matches!(key.code, KeyCode::Char('v') | KeyCode::Char('V'));
        control || alt
    }

    fn try_paste_image_payload(&mut self, text: &str) -> bool {
        let trimmed = text.trim();
        let encoded = trimmed
            .strip_prefix("codsh-image:")
            .or_else(|| trimmed.strip_prefix("data:image/"));
        let Some(rest) = encoded else {
            return false;
        };
        let payload = rest
            .split_once(";base64,")
            .map(|(_, data)| data)
            .unwrap_or(rest);
        match images::decode_image_payload(payload) {
            Ok(image) => {
                self.insert_image(image);
                true
            }
            Err(error) => {
                self.footer_notice = image_notice(&error);
                true
            }
        }
    }

    fn insert_image(&mut self, image: images::ImageBytes) {
        let id = self.next_image_id;
        self.next_image_id = self.next_image_id.saturating_add(1);
        let mut prepared = images::prepare_image(id, image);
        if !self.accepts_images
            && let Some(store) = &self.attachment_store
            && let Ok(path) = images::save_original(store, &prepared)
        {
            prepared.saved_path = Some(path);
        }
        let placeholder = prepared.placeholder();
        let display = ratatui::text::Line::from(placeholder.clone());
        let element = self.draft.replace_range_with_element(
            self.draft.cursor()..self.draft.cursor(),
            &placeholder,
            IMAGE_CHIP,
            Some(display),
        );
        self.images.push(AttachedImage {
            id: element,
            prepared,
        });
        self.refresh_file_state();
        self.refresh_image_preview();
        // Say it now, not after submit: a text-only route never sees the
        // pixels. It gets the `<pasted-image>` path of the saved original.
        self.footer_notice = if self.accepts_images {
            format!("image #{id} attached")
        } else {
            format!(
                "image #{id} attached; this model cannot see images and gets only the saved path"
            )
        };
    }

    fn sync_image_chips(&mut self) {
        let live: Vec<ElementId> = self
            .draft
            .elements()
            .iter()
            .filter(|element| element.kind == IMAGE_CHIP)
            .map(|element| element.id)
            .collect();
        self.images.retain(|image| live.contains(&image.id));
        self.refresh_file_state();
        self.refresh_image_preview();
    }

    fn refresh_images(&mut self) -> Result<Vec<PreparedImage>, String> {
        let mut fresh = Vec::new();
        for image in &self.images {
            if let Err(error) = images::image_still_matches(&image.prepared) {
                return Err(format!(
                    "{}: {}",
                    image.prepared.placeholder(),
                    error.detail
                ));
            }
            let mut prepared = image.prepared.clone();
            if !self.accepts_images && prepared.saved_path.is_none() {
                let Some(store) = &self.attachment_store else {
                    return Err(format!(
                        "{}: text-only model needs the attachment store",
                        prepared.placeholder()
                    ));
                };
                prepared.saved_path = Some(
                    images::save_original(store, &prepared)
                        .map_err(|error| format!("{}: {error}", prepared.placeholder()))?,
                );
            }
            fresh.push(prepared);
        }
        for (image, prepared) in self.images.iter_mut().zip(fresh.iter()) {
            image.prepared.saved_path.clone_from(&prepared.saved_path);
        }
        Ok(fresh)
    }

    fn rebind_image_chips(&mut self, parked: &[PreparedImage]) {
        if parked.is_empty() {
            return;
        }
        let text = self.draft.text().to_string();
        let mut cursor = 0;
        let mut elements = Vec::new();
        let mut rebound = Vec::new();
        for image in parked {
            let Ok(prepared) = images::revalidate_image(image) else {
                continue;
            };
            let placeholder = prepared.placeholder();
            let Some(offset) = text[cursor..].find(&placeholder) else {
                continue;
            };
            let start = cursor + offset;
            let end = start + placeholder.len();
            cursor = end;
            elements.push((
                start..end,
                IMAGE_CHIP,
                Some(ratatui::text::Line::from(placeholder)),
            ));
            rebound.push(prepared);
        }
        if elements.is_empty() {
            return;
        }
        self.draft.restore_elements(elements);
        let live: Vec<ElementId> = self
            .draft
            .elements()
            .iter()
            .filter(|element| element.kind == IMAGE_CHIP)
            .map(|element| element.id)
            .collect();
        self.images = rebound
            .into_iter()
            .zip(live)
            .map(|(prepared, id)| AttachedImage { id, prepared })
            .collect();
        if let Some(max_id) = self.images.iter().map(|image| image.prepared.id).max() {
            self.next_image_id = self.next_image_id.max(max_id.saturating_add(1));
        }
        // `set_text` left the cursor after the placeholder. Resting it on the
        // last chip is what shows that image until the pointer moves.
        if let Some(end) = self
            .draft
            .elements()
            .iter()
            .filter(|element| element.kind == IMAGE_CHIP)
            .map(|element| element.range.end)
            .max()
        {
            self.draft.set_cursor(end);
        }
        self.refresh_file_state();
        self.refresh_image_preview();
    }

    fn refresh_image_preview(&mut self) {
        let cursor = self.draft.cursor();
        let hovered = self.hover_image.and_then(|id| {
            self.images
                .iter()
                .find(|image| image.id == id)
                .map(|image| image.prepared.id)
        });
        self.preview_image = hovered.or_else(|| {
            self.draft
                .elements()
                .iter()
                .find(|element| {
                    element.kind == IMAGE_CHIP
                        && cursor >= element.range.start
                        && cursor <= element.range.end
                })
                .and_then(|element| {
                    self.images
                        .iter()
                        .find(|image| image.id == element.id)
                        .map(|image| image.prepared.id)
                })
        });
    }

    fn refresh_file_state(&mut self) {
        self.chips = self
            .draft
            .elements()
            .iter()
            .any(|element| element.kind == FILE_CHIP || element.kind == IMAGE_CHIP);
    }

    fn refresh_attached_bytes(&mut self) -> Result<Vec<PreparedAttachment>, String> {
        let Some(index) = self.workspace.clone() else {
            if self.files.is_empty() {
                return Ok(Vec::new());
            }
            return Err("no workspace for file attachments".into());
        };
        let mut fresh = Vec::new();
        for file in &mut self.files {
            let prepared = index.prepare(&file.reference, file.prepared.as_ref());
            if prepared.status != AttachStatus::Ready {
                let detail = if prepared.detail.is_empty() {
                    prepared.status.label().to_string()
                } else {
                    prepared.detail.clone()
                };
                file.prepared = Some(prepared);
                return Err(format!("{}: {detail}", file.reference.mention()));
            }
            file.prepared = Some(prepared.clone());
            fresh.push(prepared);
        }
        Ok(fresh)
    }

    fn rebind_file_chips(&mut self, mentions: &[String]) {
        let Some(index) = self.workspace.clone() else {
            return;
        };
        let text = self.draft.text().to_string();
        let mut cursor = 0;
        let mut elements = Vec::new();
        let mut restored = Vec::new();
        for mention in mentions {
            let Some(reference) = index.resolve_typed(mention) else {
                continue;
            };
            let Some(offset) = text[cursor..].find(mention.as_str()) else {
                continue;
            };
            let start = cursor + offset;
            let end = start + mention.len();
            cursor = end;
            let display = ratatui::text::Line::from(format!("[{}]", reference.display()));
            elements.push((start..end, FILE_CHIP, Some(display)));
            let prepared = index.prepare(&reference, None);
            restored.push(AttachedFile {
                id: ElementId::from_raw(0),
                reference,
                prepared: Some(prepared),
            });
        }
        self.files = restored;
        if elements.is_empty() {
            self.refresh_file_state();
            return;
        }
        self.draft.restore_elements(elements);
        let ids: Vec<ElementId> = self
            .draft
            .elements()
            .iter()
            .filter(|element| element.kind == FILE_CHIP)
            .map(|element| element.id)
            .collect();
        for (file, id) in self.files.iter_mut().zip(ids) {
            file.id = id;
        }
        self.refresh_file_state();
    }

    fn restore_file_chips(&mut self, files: &[AttachedFile]) {
        self.files.clear();
        for file in files {
            let display = ratatui::text::Line::from(format!("[{}]", file.reference.display()));
            let mention = file.reference.mention();
            if let Some(range) = self
                .draft
                .text()
                .find(&mention)
                .map(|start| start..start + mention.len())
            {
                let id = self.draft.replace_range_with_element(
                    range,
                    &mention,
                    FILE_CHIP,
                    Some(display),
                );
                self.files.push(AttachedFile {
                    id,
                    reference: file.reference.clone(),
                    prepared: file.prepared.clone(),
                });
            }
        }
        self.refresh_file_state();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AttachedFile {
    id: ElementId,
    reference: FileRef,
    prepared: Option<PreparedAttachment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AttachedImage {
    id: ElementId,
    prepared: PreparedImage,
}

fn image_notice(error: &ImageRefusal) -> String {
    if error.detail.is_empty() {
        error.status.label().to_string()
    } else {
        error.detail.clone()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptSlash {
    History,
    Multiline,
    EditPrompt,
    Voice,
    ReloadAssets,
    #[allow(dead_code)]
    Passthrough(String),
}

fn rank_slash_name(name: &str, query: &str) -> Option<u8> {
    let q = query.trim_start_matches('/').to_ascii_lowercase();
    let name = name.trim_start_matches('/').to_ascii_lowercase();
    if q.is_empty() {
        return Some(3);
    }
    if name == q {
        Some(0)
    } else if name.starts_with(&q) {
        Some(1)
    } else if name.contains(&q) {
        Some(2)
    } else if subsequence(&name, &q) {
        Some(3)
    } else {
        None
    }
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
        "voice" => Some(PromptSlash::Voice),
        "reload-assets" => Some(PromptSlash::ReloadAssets),
        _ => None,
    }
}

fn is_voice_chord(key: &KeyEvent) -> bool {
    let ctrl_space = key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char(' '))
        && !key.modifiers.contains(KeyModifiers::ALT)
        && !key.modifiers.contains(KeyModifiers::SHIFT);
    let f8 = matches!(key.code, KeyCode::F(8)) && key.modifiers.is_empty();
    ctrl_space || f8
}

fn voice_gesture(key: &KeyEvent, release_supported: bool) -> VoiceGesture {
    if matches!(key.kind, crossterm::event::KeyEventKind::Release) {
        VoiceGesture::Release
    } else if release_supported {
        VoiceGesture::Press
    } else {
        VoiceGesture::UnsupportedRelease
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

fn images_match_draft(live: &[AttachedImage], parked: &[PreparedImage]) -> bool {
    live.len() == parked.len()
        && live.iter().zip(parked).all(|(live, parked)| {
            live.prepared.id == parked.id && live.prepared.digest == parked.digest
        })
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
        use std::sync::atomic::{AtomicU64, Ordering};
        static HOMES: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "codsh-prompt-{}-{}-{}",
            std::process::id(),
            stamp,
            HOMES.fetch_add(1, Ordering::Relaxed)
        ));
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
            voice_release: true,
        }
    }

    fn image_block_bytes(submitted: &SubmittedPrompt) -> Vec<Vec<u8>> {
        image_block_bytes_from(&submitted.blocks)
    }

    fn image_block_bytes_from(blocks: &[serde_json::Value]) -> Vec<Vec<u8>> {
        blocks
            .iter()
            .filter(|block| block.get("type").and_then(|value| value.as_str()) == Some("image"))
            .map(|block| {
                base64::Engine::decode(
                    &base64::engine::general_purpose::STANDARD,
                    block.get("data").and_then(|value| value.as_str()).unwrap(),
                )
                .unwrap()
            })
            .collect()
    }

    fn moved(column: u16, row: u16) -> crossterm::event::MouseEvent {
        crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Moved,
            column,
            row,
            modifiers: KeyModifiers::NONE,
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
    fn submit_does_not_record_history_until_host_accepts() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_text("TOKEN_ONCE");
        let action = composer.handle_key(key(KeyCode::Enter), ctx());
        assert_eq!(action, Action::Submit("TOKEN_ONCE".into()));
        assert!(composer.history.is_empty());
        assert!(load_history(&home).is_empty());
        composer.record_history("TOKEN_ONCE");
        assert_eq!(composer.history, vec!["TOKEN_ONCE".to_string()]);
        assert_eq!(load_history(&home), vec!["TOKEN_ONCE".to_string()]);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn failed_submit_restores_the_cleared_draft() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_text("draft survives resize");
        let action = composer.handle_key(key(KeyCode::Enter), ctx());
        assert_eq!(action, Action::Submit("draft survives resize".into()));
        assert_eq!(composer.text(), "");
        assert!(!composer.restore_pending_submit());
        assert_eq!(composer.text(), "draft survives resize");
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
    fn file_picker_attaches_a_line_range_and_a_removed_chip_is_not_sent() {
        let root = temp_home();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join(".gitignore"), "secret.log\n").unwrap();
        fs::write(root.join("src/main.rs"), "one\ntwo\nthree\n").unwrap();
        fs::write(root.join("secret.log"), "HIDDEN_LOG\n").unwrap();
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_workspace(&root);
        for ch in "@src/main.rs:2-3".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), ctx());
        }
        assert_eq!(composer.overlay, Overlay::FilePick);
        assert!(
            composer.overlay_text().contains("src/main.rs"),
            "{}",
            composer.overlay_text()
        );
        assert!(
            !composer.overlay_text().contains("secret.log"),
            "{}",
            composer.overlay_text()
        );
        assert_eq!(
            composer.handle_key(key(KeyCode::Enter), ctx()),
            Action::None
        );
        assert!(composer.chips);
        assert!(
            composer.text().contains("@src/main.rs:2-3"),
            "{}",
            composer.text()
        );
        for ch in " look".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), ctx());
        }
        let submitted = composer.prepare_submit().expect("ready attachment");
        let encoded = submitted
            .blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(|value| value.as_str()))
            .collect::<String>();
        assert!(encoded.contains("two\nthree\n"), "{encoded}");
        assert!(!encoded.contains("HIDDEN_LOG"), "{encoded}");
        for _ in 0.." look".chars().count() {
            composer.handle_key(key(KeyCode::Backspace), ctx());
        }
        assert!(
            composer.chips,
            "text remains before chip delete: {}",
            composer.text()
        );
        composer.handle_key(key(KeyCode::Backspace), ctx());
        assert!(
            !composer.chips && composer.text().is_empty(),
            "chips={} text={:?} notice={} elements={}",
            composer.chips,
            composer.text(),
            composer.footer_notice,
            composer.draft.elements().len()
        );
        let after = composer.prepare_submit();
        assert!(after.is_err(), "removed chip must not submit: {after:?}");
        let message = after.unwrap_err();
        assert!(!message.contains("two"), "{message}");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn single_line_chip_and_prose_paste_do_not_drop_the_draft() {
        let root = temp_home();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/main.rs"),
            "ALPHA_LINE\nBETA_LINE\nGAMMA_LINE\n",
        )
        .unwrap();
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_workspace(&root);
        for ch in "@src/main.rs:2".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), ctx());
        }
        composer.handle_key(key(KeyCode::Enter), ctx());
        let submitted = composer.prepare_submit().expect("single line attaches");
        let encoded = submitted
            .blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(|value| value.as_str()))
            .collect::<String>();
        assert!(encoded.contains("BETA_LINE"), "{encoded}");
        assert!(!encoded.contains("ALPHA_LINE"), "{encoded}");
        assert!(!encoded.contains("GAMMA_LINE"), "{encoded}");
        assert!(
            submitted
                .mentions
                .iter()
                .any(|mention| mention == "@src/main.rs:2")
        );

        composer.accept_pending_submit();
        composer.set_text("");
        composer.paste("see src/main.rs before editing");
        assert!(
            composer.text() == "see src/main.rs before editing" && !composer.chips,
            "chips={} notice={} text={:?} elements={:?}",
            composer.chips,
            composer.footer_notice,
            composer.text(),
            composer.draft.elements()
        );
        composer.set_text("");
        composer.paste(&format!("{}/src/main.rs", root.display()));
        assert!(composer.chips, "a pasted workspace path attaches");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn pasted_gitignore_path_stays_text_and_sends_no_bytes() {
        let root = temp_home();
        fs::create_dir_all(root.join("logs")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join(".gitignore"), "logs/*.log\n").unwrap();
        fs::write(root.join("logs/nested.log"), "PROBE_SLASH_LOG\n").unwrap();
        fs::write(root.join("src/keep.txt"), "VISIBLE\n").unwrap();
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_workspace(&root);

        let ignored = format!("{}/logs/nested.log", root.display());
        assert!(
            composer.overlay_text().contains("no files") || composer.matches.is_empty(),
            "picker starts closed"
        );
        for ch in "@logs/nested.log".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), ctx());
        }
        assert!(
            !composer
                .matches
                .iter()
                .any(|item| item.contains("nested.log")),
            "picker hides logs/*.log: {:?}",
            composer.matches
        );
        composer.handle_key(key(KeyCode::Esc), ctx());
        composer.set_text("");

        composer.paste(&ignored);
        assert!(
            !composer.chips,
            "a pasted gitignored path must not attach: notice={} text={:?}",
            composer.footer_notice,
            composer.text()
        );
        assert_eq!(composer.text(), ignored);
        let submitted = composer.prepare_submit().expect("prose path still submits");
        let encoded = serde_json::to_string(&submitted.blocks).unwrap();
        assert!(
            !encoded.contains("PROBE_SLASH_LOG"),
            "ignored paste must not send file bytes: {encoded}"
        );
        assert!(submitted.mentions.is_empty(), "{:?}", submitted.mentions);

        composer.set_text("");
        composer.paste(&format!("{}/src/keep.txt", root.display()));
        assert!(composer.chips, "a visible pasted path still attaches");
        let visible = composer.prepare_submit().expect("visible file");
        let visible_text = serde_json::to_string(&visible.blocks).unwrap();
        assert!(visible_text.contains("VISIBLE"), "{visible_text}");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn pasted_images_preview_submit_and_follow_the_model_route() {
        let home = temp_home();
        let store = temp_home();
        let png = images::tiny_png();
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png);
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_image_route(true, Some(&store));
        composer.paste(&format!("codsh-image:{encoded}"));
        assert!(
            composer.chips,
            "image chip missing: {}",
            composer.footer_notice
        );
        assert!(
            composer.text().contains("[Image #1]"),
            "{}",
            composer.text()
        );
        let preview = composer
            .image_preview()
            .expect("preview while the cursor is on the chip");
        assert!(preview.contains("Pasted image #1"), "{preview}");
        assert!(preview.contains("1x1"), "{preview}");
        composer.paste(&format!("codsh-image:{encoded}"));
        assert!(
            composer.text().contains("[Image #1]"),
            "order lost: {}",
            composer.text()
        );
        assert!(
            composer.text().contains("[Image #2]"),
            "second image missing: {}",
            composer.text()
        );
        for ch in " look".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), ctx());
        }
        let submitted = composer.prepare_submit().expect("capable model submits");
        let image_blocks: Vec<_> = submitted
            .blocks
            .iter()
            .filter(|block| block.get("type").and_then(|value| value.as_str()) == Some("image"))
            .collect();
        assert_eq!(image_blocks.len(), 2, "{:?}", submitted.blocks);
        let first = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            image_blocks[0]
                .get("data")
                .and_then(|value| value.as_str())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            first, png,
            "submitted bytes differ from the previewed image"
        );
        assert_eq!(
            submitted
                .images
                .iter()
                .map(|image| image.id)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        for _ in 0.." look".chars().count() {
            composer.handle_key(key(KeyCode::Backspace), ctx());
        }
        composer.handle_key(key(KeyCode::Backspace), ctx());
        assert!(
            !composer.text().contains("[Image #2]"),
            "removed image still in the draft: {}",
            composer.text()
        );
        let after = composer.prepare_submit().expect("one image remains");
        let remaining = after
            .blocks
            .iter()
            .filter(|block| block.get("type").and_then(|value| value.as_str()) == Some("image"))
            .count();
        assert_eq!(
            remaining, 1,
            "deleted image was still sent: {:?}",
            after.blocks
        );

        composer.set_text("");
        composer.set_image_route(false, Some(&store));
        composer.paste_image_bytes(&png).expect("bytes attach");
        let text_only = composer
            .prepare_submit()
            .expect("text-only still submits the path");
        let joined = text_only
            .blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(|value| value.as_str()))
            .collect::<String>();
        assert!(joined.contains("<pasted-image "), "{joined}");
        assert!(
            text_only
                .blocks
                .iter()
                .all(|block| block.get("type").and_then(|value| value.as_str()) != Some("image")),
            "text-only model must not receive an image block: {:?}",
            text_only.blocks
        );
        let empty = composer.paste_image_bytes(&[]);
        assert!(empty.is_err(), "empty clipboard must not attach");
        assert!(
            composer.footer_notice.contains("clipboard has no image")
                || empty.unwrap_err().contains("clipboard")
        );
        let corrupt = composer.paste_image_bytes(b"not-an-image");
        assert!(corrupt.unwrap_err().contains("not a png"));
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(store);
    }

    #[test]
    fn image_draft_survives_a_model_switch_but_not_a_new_process() {
        let home = temp_home();
        let store = temp_home();
        let png = images::tiny_png();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_image_route(true, Some(&store));
        composer.paste_image_bytes(&png).unwrap();
        assert_eq!(composer.footer_notice, "image #1 attached");
        for ch in " keep".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), ctx());
        }
        let draft = composer.text().to_string();
        composer.set_image_route(false, Some(&store));
        assert!(composer.chips, "switching the model drops the chip");
        assert_eq!(composer.text(), draft);
        let submitted = composer.prepare_submit().expect("text-only submit");
        let joined = serde_json::to_string(&submitted.blocks).unwrap();
        assert!(joined.contains("<pasted-image "), "{joined}");
        assert!(!joined.contains("\"type\":\"image\""), "{joined}");
        composer.paste_image_bytes(&png).unwrap();
        assert!(
            composer.footer_notice.contains("cannot see images")
                && composer.footer_notice.contains("saved path"),
            "a text-only attach must say the model gets only the path: {}",
            composer.footer_notice
        );

        // Like the reference, the draft lives in this process. Nothing about
        // it is written to the Home, so a later launch starts empty.
        let written: Vec<_> = fs::read_dir(&home)
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default();
        assert!(written.is_empty(), "draft state reached disk: {written:?}");
        let next = PromptComposer::load(&home, &[]);
        assert!(next.text().is_empty(), "{}", next.text());
        assert!(!next.chips);
        assert!(next.image_preview().is_none());
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(store);
    }

    #[test]
    fn whitespace_paste_inserts_nothing_and_keeps_the_notice() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_text("keep");
        composer.footer_notice = "earlier".into();
        for empty in ["", " ", "\n", "\r\n\t"] {
            composer.paste(empty);
            assert_eq!(composer.text(), "keep", "{empty:?}");
            assert_eq!(composer.footer_notice, "earlier", "{empty:?}");
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn dropped_image_paths_become_image_chips() {
        let home = temp_home();
        let store = temp_home();
        let work = temp_home();
        fs::create_dir_all(work.join("dir with space")).unwrap();
        let first = work.join("shot.png");
        let second = work.join("dir with space").join("two (1).PNG");
        fs::write(&first, images::tiny_png()).unwrap();
        fs::write(&second, images::tiny_png_green()).unwrap();
        fs::write(work.join("broken.png"), b"not-an-image").unwrap();
        fs::write(work.join("notes.txt"), b"text").unwrap();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_workspace(&work);
        composer.set_image_route(true, Some(&store));
        let escaped = second
            .display()
            .to_string()
            .replace(' ', "\\ ")
            .replace('(', "\\(")
            .replace(')', "\\)");
        composer.paste(&format!("{} {escaped}", first.display()));
        assert_eq!(
            composer.text(),
            "[Image #1][Image #2]",
            "{}",
            composer.footer_notice
        );
        let sent = composer.prepare_submit().expect("two images");
        assert_eq!(
            image_block_bytes(&sent),
            vec![images::tiny_png(), images::tiny_png_green()]
        );
        composer.set_text("");
        let url = url::Url::from_file_path(&second).unwrap().to_string();
        composer.paste(&format!("'{url}'"));
        assert!(
            composer.text().contains("[Image #3]"),
            "{}",
            composer.text()
        );

        // A corrupt image file says so and adds nothing.
        composer.set_text("");
        composer.paste(&work.join("broken.png").display().to_string());
        assert_eq!(composer.text(), "");
        assert!(
            composer.footer_notice.contains("broken.png")
                && composer.footer_notice.contains("not a png"),
            "{}",
            composer.footer_notice
        );
        // Prose, a relative name, and a non-image path are not image drops.
        for text in [
            format!("see {} please", first.display()),
            "shot.png".to_string(),
            work.join("notes.txt").display().to_string(),
            format!("{} {}", first.display(), work.join("notes.txt").display()),
        ] {
            composer.set_text("");
            composer.paste(&text);
            assert!(
                !composer.text().contains("[Image #"),
                "{text}: {}",
                composer.text()
            );
        }
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(store);
        let _ = fs::remove_dir_all(work);
    }

    #[test]
    fn queued_image_is_rebuilt_for_the_model_selected_at_send() {
        let home = temp_home();
        let store = temp_home();
        let png = images::tiny_png();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_image_route(true, Some(&store));
        composer.paste_image_bytes(&png).unwrap();
        let busy = HostContext {
            inflight: true,
            minimal: false,
            voice_release: true,
        };
        assert_eq!(
            composer.handle_key(key(KeyCode::Enter), busy),
            Action::None,
            "a running turn queues the image"
        );
        assert_eq!(composer.queue_count(), 1);
        let queued = composer.take_ready_queue();
        assert!(
            queued[0]
                .blocks
                .iter()
                .any(|block| block.get("type").and_then(|value| value.as_str()) == Some("image")),
            "queued under a vision model: {:?}",
            queued[0].blocks
        );
        composer.requeue(queued);
        composer.set_image_route(false, Some(&store));
        let released = composer.take_ready_queue();
        let rebuilt = composer
            .blocks_for_route(&released[0])
            .expect("text-only rebuilds the path");
        assert!(
            rebuilt.iter().all(|block| {
                block.get("type").and_then(|value| value.as_str()) != Some("image")
            }),
            "a later text-only model must not receive the queued image block: {rebuilt:?}"
        );
        let joined = rebuilt
            .iter()
            .filter_map(|block| block.get("text").and_then(|value| value.as_str()))
            .collect::<String>();
        assert!(joined.contains("<pasted-image "), "{joined}");

        composer.requeue(released);
        composer.set_image_route(true, Some(&store));
        let again = composer.take_ready_queue();
        let vision = composer
            .blocks_for_route(&again[0])
            .expect("vision route rebuilds the bytes");
        assert_eq!(image_block_bytes_from(&vision), vec![png]);
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(store);
    }

    #[test]
    fn image_preview_follows_the_pointer_and_returns_to_the_cursor() {
        let home = temp_home();
        let store = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_image_route(false, Some(&store));
        composer.paste_image_bytes(&images::tiny_png()).unwrap();
        composer
            .paste_image_bytes(&images::tiny_png_green())
            .unwrap();
        let first = composer
            .image_preview()
            .expect("cursor rests on the last chip");
        assert!(first.contains("Pasted image #2"), "{first}");
        assert!(first.contains("2x1"), "{first}");
        assert!(
            first.contains("attachments"),
            "a saved path is the preview, not a graphics protocol: {first}"
        );
        let area = ratatui::layout::Rect {
            x: 0,
            y: 0,
            width: 40,
            height: 1,
        };
        composer.hover_image(moved(0, 0), area);
        let hovered = composer.image_preview().expect("hover the first chip");
        assert!(hovered.contains("Pasted image #1"), "{hovered}");
        assert!(hovered.contains("1x1"), "{hovered}");
        composer.hover_image(moved(0, 5), area);
        let back = composer.image_preview().expect("cursor chip returns");
        assert!(back.contains("Pasted image #2"), "{back}");
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(store);
    }

    #[test]
    fn screen_mode_slash_restores_parked_image_bytes() {
        let home = temp_home();
        let store = temp_home();
        let first = images::tiny_png();
        let second = images::tiny_png_green();
        assert_ne!(first, second);
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_image_route(true, Some(&store));
        composer.paste_image_bytes(&first).unwrap();
        for ch in " keep".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), ctx());
        }
        composer.paste_image_bytes(&second).unwrap();
        let before = composer.prepare_submit().expect("image is attached");
        let before_bytes = image_block_bytes(&before);
        assert_eq!(before_bytes, vec![first.clone(), second.clone()]);
        composer.restore_pending_submit();
        let draft = composer.text().to_string();

        for command in ["/minimal", "/fullscreen", "/reload-assets"] {
            assert_eq!(composer.text(), draft);
            composer.handle_key(key(KeyCode::Char('/')), ctx());
            assert_eq!(composer.text(), "/");
            for ch in command[1..].chars() {
                composer.handle_key(key(KeyCode::Char(ch)), ctx());
            }
            assert_eq!(
                composer.handle_key(key(KeyCode::Enter), ctx()),
                Action::Slash(command.into()),
                "{command}"
            );
            assert_eq!(composer.text(), draft, "{command} replaced the draft");
            assert!(composer.chips, "{command} dropped the image chip");
            let after = composer.prepare_submit().expect(command);
            assert_eq!(
                image_block_bytes(&after),
                vec![first.clone(), second.clone()],
                "{command} restored the placeholder without the parked bytes"
            );
            composer.restore_pending_submit();
        }
        composer.handle_key(key(KeyCode::Backspace), ctx());
        assert_eq!(
            composer.text(),
            "[Image #1] keep",
            "backspace was not on the last chip: {}",
            composer.text()
        );
        let remaining = composer.prepare_submit().expect("first image remains");
        assert_eq!(image_block_bytes(&remaining), vec![first]);
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(store);
    }

    #[test]
    fn oversized_image_and_a_refused_submit_keep_the_draft_bytes() {
        let home = temp_home();
        let store = temp_home();
        let png = images::tiny_png();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_image_route(true, Some(&store));
        let huge = vec![0u8; (images::MAX_IMAGE_BYTES as usize) + 1];
        let refused = composer.paste_image_bytes(&huge);
        assert!(
            refused.unwrap_err().contains("256 KiB"),
            "oversize image was attached"
        );
        assert!(!composer.chips, "oversize image became a chip");
        composer.paste_image_bytes(&png).unwrap();
        for ch in " stay".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), ctx());
        }
        let draft = composer.text().to_string();
        let submitted = composer.prepare_submit().expect("image submits");
        assert_eq!(image_block_bytes(&submitted), vec![png.clone()]);
        assert!(
            composer.restore_pending_submit(),
            "a refused submit must put the same draft back"
        );
        assert_eq!(composer.text(), draft);
        let again = composer
            .prepare_submit()
            .expect("bytes survived the refusal");
        assert_eq!(image_block_bytes(&again), vec![png]);
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(store);
    }

    #[test]
    fn queued_attachment_can_be_edited_and_a_removed_chip_is_not_sent() {
        let root = temp_home();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "QUEUE_BODY\n").unwrap();
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_workspace(&root);
        let busy = HostContext {
            inflight: true,
            minimal: false,
            voice_release: true,
        };
        for ch in "@src/main.rs".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), busy);
        }
        composer.handle_key(key(KeyCode::Enter), busy);
        assert!(composer.chips);
        assert_eq!(
            composer.handle_key(key(KeyCode::Enter), busy),
            Action::None,
            "a busy turn queues instead of sending"
        );
        assert!(
            composer.queue_count() == 1,
            "queued {}",
            composer.queue_count()
        );
        assert!(composer.text().is_empty());
        composer.handle_key(chord(KeyCode::Up, KeyModifiers::ALT), busy);
        assert!(composer.chips, "editing a queued prompt restores its chip");
        let restored = composer.text().to_string();
        let chip_count = composer
            .draft
            .elements()
            .iter()
            .filter(|element| element.kind == FILE_CHIP)
            .count();
        let mention_count = restored.matches("@src/main.rs").count();
        assert_eq!(
            (chip_count, mention_count, restored.as_str()),
            (1, 1, "@src/main.rs"),
            "set_text already contains the mention, so restore must not append a second chip"
        );
        composer.handle_key(key(KeyCode::Backspace), busy);
        assert!(!composer.chips, "removed queued chip");
        for ch in "plain".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), busy);
        }
        composer.handle_key(key(KeyCode::Enter), busy);
        let released = composer.take_ready_queue();
        assert_eq!(released.len(), 1);
        let encoded = serde_json::to_string(&released[0].blocks).unwrap();
        assert!(encoded.contains("plain"), "{encoded}");
        assert!(!encoded.contains("QUEUE_BODY"), "{encoded}");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn undo_restores_a_file_chip_and_changed_bytes_are_refused() {
        let root = temp_home();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "alpha\n").unwrap();
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_workspace(&root);
        for ch in "@src/main.rs".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), ctx());
        }
        composer.handle_key(key(KeyCode::Tab), ctx());
        assert!(composer.chips, "{}", composer.text());
        composer.handle_key(chord(KeyCode::Char('z'), KeyModifiers::CONTROL), ctx());
        assert!(
            !composer.chips,
            "undo removes the chip: {}",
            composer.text()
        );
        let undone = composer.prepare_submit();
        if let Ok(prompt) = &undone {
            let encoded = serde_json::to_string(&prompt.blocks).unwrap();
            assert!(!encoded.contains("alpha"), "{encoded}");
        }
        composer.handle_key(
            chord(
                KeyCode::Char('z'),
                KeyModifiers::CONTROL | KeyModifiers::SHIFT,
            ),
            ctx(),
        );
        if !composer.chips {
            composer.handle_key(key(KeyCode::Char('y')), ctx());
        }
        fs::write(root.join("src/main.rs"), "beta\n").unwrap();
        let refused = composer.prepare_submit();
        assert!(
            refused.is_err(),
            "changed file must not be sent: {refused:?}"
        );
        let message = refused.unwrap_err();
        assert!(!message.contains("beta"), "{message}");
        assert!(!message.contains("alpha"), "{message}");
        let _ = fs::remove_dir_all(root);
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
        assert!(matches!(slash_action("/voice"), Some(PromptSlash::Voice)));
        assert!(slash_action("/model").is_none());
    }

    #[test]
    fn voice_chord_does_not_insert_or_submit() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_text("keep");
        let press = KeyEvent::new(KeyCode::Char(' '), KeyModifiers::CONTROL);
        assert_eq!(
            composer.handle_key(press, ctx()),
            Action::Voice(VoiceGesture::Press)
        );
        assert_eq!(composer.text(), "keep");
        let mut no_release = ctx();
        no_release.voice_release = false;
        assert_eq!(
            composer.handle_key(
                KeyEvent::new(KeyCode::F(8), KeyModifiers::empty()),
                no_release
            ),
            Action::Voice(VoiceGesture::UnsupportedRelease)
        );
        assert_eq!(composer.text(), "keep");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn empty_draft_tab_is_unhandled_for_the_welcome_menu() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        assert_eq!(
            composer.handle_key(key(KeyCode::Tab), ctx()),
            Action::Unhandled
        );
        composer.set_text("keep");
        assert_eq!(composer.handle_key(key(KeyCode::Tab), ctx()), Action::None);
        assert_eq!(composer.text(), "keep");
        let _ = fs::remove_dir_all(home);
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
    fn slash_while_dictating_keeps_the_parked_draft_after_compact() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.set_text("KEEP");
        composer.handle_key(key(KeyCode::Char('/')), ctx());
        assert_eq!(composer.text(), "/");
        assert_eq!(composer.slash_stash, "KEEP");
        assert_eq!(composer.voice_draft(), "KEEP");
        for ch in "compact".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), ctx());
        }
        assert_eq!(
            composer.handle_key(key(KeyCode::Enter), ctx()),
            Action::Slash("/compact".into())
        );
        // The host captures the draft, drops the stash, then clears the command line.
        let parked = composer.voice_draft();
        composer.slash_stash.clear();
        composer.clear_slash_line(&parked);
        assert_eq!(composer.text(), "KEEP");
        assert_ne!(composer.text(), "/");
        assert!(composer.slash_stash.is_empty());
        assert_eq!(composer.overlay, Overlay::None);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn slash_menu_keeps_the_cursor_row_visible() {
        let home = temp_home();
        let mut composer = PromptComposer::load(&home, &[]);
        composer.asset_commands = (0..6)
            .map(|index| (format!("/item-{index}"), "skill".into()))
            .collect();
        for ch in "/item".chars() {
            composer.handle_key(key(KeyCode::Char(ch)), ctx());
        }
        composer.handle_key(key(KeyCode::Down), ctx());
        composer.handle_key(key(KeyCode::Down), ctx());
        let shown = composer.overlay_text();
        assert!(shown.contains("> /item-2"), "{shown}");
        assert_eq!(
            shown
                .lines()
                .filter(|line| line.starts_with('>') || line.starts_with(' '))
                .count(),
            1,
            "{shown}"
        );
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
