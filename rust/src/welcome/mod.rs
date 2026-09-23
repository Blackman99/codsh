mod hero_box;
mod layout;
mod logo;
mod menu;

use crate::navigation::{Focus, FrameLayout, NavOverlay, NavState};
use crate::theme::Theme;
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::text::Line;
use ratatui::widgets::{Block, BorderType, Borders, Paragraph, StatefulWidgetRef, Widget, Wrap};
use xai_ratatui_textarea::{TextArea, TextAreaState};

pub fn render(
    frame: &mut Frame,
    draft: &TextArea,
    notice: &str,
    selected: Option<usize>,
    theme: &Theme,
    compact: bool,
    feedback_open: bool,
    title: &str,
) -> Rect {
    let area = frame.area();
    if area.width < 18 || area.height < 8 {
        frame.render_widget(
            Paragraph::new("codsh\nResize to continue\nCtrl+Q quit"),
            area,
        );
        return Rect::default();
    }
    let [header, content] =
        Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).areas(area);
    let heading = if area.width < 40 {
        "codsh · Rust client"
    } else {
        "codsh · Rust client · dsh ACP"
    };
    frame.render_widget(Paragraph::new(heading), header);
    let input_height = draft
        .desired_height(content.width.saturating_sub(4))
        .clamp(1, 5)
        + 2;
    let tip_height = if feedback_open {
        content.height.saturating_sub(input_height + 4)
    } else {
        wrapped_rows(notice, content.width)
    };
    let layout = layout::WelcomeLayout::compute(layout::WelcomeLayoutInput {
        content_area: content,
        menu_height: 3,
        tip_height,
        prompt_height: Some(input_height),
        compact,
        ..Default::default()
    });
    let submit = if notice.contains("Connected to dsh ACP") {
        "Submit prompt"
    } else {
        "Check availability"
    };
    let items = [
        ("enter", submit),
        ("ctrl+c", "Clear / cancel"),
        ("ctrl+q", "Quit"),
    ];
    let buf = frame.buffer_mut();
    if feedback_open {
        let footer = input_height.saturating_add(1);
        let [body, prompt] = Layout::vertical([
            Constraint::Min(0),
            Constraint::Length(footer.min(content.height)),
        ])
        .areas(content);
        Paragraph::new(notice)
            .wrap(Wrap { trim: false })
            .render(body, buf);
        let block = Block::new().borders(Borders::ALL).title(title);
        let input = block.inner(prompt);
        block.render(prompt, buf);
        let mut state = TextAreaState::default();
        draft.render_ref(input, buf, &mut state);
        return input;
    }
    if layout.has_hero_box() {
        Block::bordered()
            .border_type(BorderType::Rounded)
            .render(layout.hero_box, buf);
        logo::render_full_logo(layout.hero_logo, buf, theme);
        Paragraph::new("codsh · Rust + dsh").render(layout.hero_version, buf);
        Paragraph::new("No official account. Isolated Home.").render(layout.hero_subtitle, buf);
        menu::render_menu(layout.hero_menu, buf, theme, &items, selected, None, 0);
    } else {
        logo::render_logo_tier(layout.logo, buf, theme, layout.logo_tier);
        menu::render_menu(layout.menu, buf, theme, &items, selected, None, 0);
    }
    render_notice(notice, layout.tip, buf);
    let block = Block::new().borders(Borders::ALL).title(title);
    let input = block.inner(layout.prompt);
    block.render(layout.prompt, buf);
    let mut state = TextAreaState::default();
    draft.render_ref(input, buf, &mut state);
    let footer = if area.width < 48 {
        "Isolated dsh · Profile: rust"
    } else {
        "dsh Home: ~/.codsh-rust/dsh · Profile: rust"
    };
    Paragraph::new(Line::from(footer)).render(layout.version, buf);
    if !feedback_open && let Some((x, y)) = draft.cursor_pos(input) {
        frame.set_cursor_position((x, y));
    }
    input
}

pub fn session_chrome_height(nav: &NavState) -> u16 {
    let overlay = nav.overlay_text();
    let rows = if overlay.is_empty() {
        1
    } else {
        1 + overlay.lines().count()
    };
    rows.clamp(1, 8) as u16
}

pub fn session_notice_height(notice: &str) -> u16 {
    notice.lines().count().clamp(1, 6) as u16
}

pub fn session_input_height(draft: &TextArea, width: u16) -> u16 {
    draft.desired_height(width.saturating_sub(4)).clamp(1, 5) + 2
}

pub fn session_transcript_height(
    area_height: u16,
    chrome_height: u16,
    notice_height: u16,
    input_height: u16,
) -> u16 {
    area_height
        .saturating_sub(2 + chrome_height + notice_height + input_height)
        .max(3)
}

/// Fullscreen session: transcript occupies its own rect so mouse hits match
/// the painted rows. The gutter is part of each line, not an extra glyph.
pub fn render_session(
    frame: &mut Frame,
    draft: &TextArea,
    notice: &str,
    nav: &NavState,
    theme: &Theme,
    title: &str,
) -> FrameLayout {
    let area = frame.area();
    if area.width < 18 || area.height < 8 {
        frame.render_widget(
            Paragraph::new("codsh\nResize to continue\nCtrl+Q quit"),
            area,
        );
        return FrameLayout {
            prompt: Rect::default(),
            transcript: Rect::default(),
            chrome: Rect::default(),
        };
    }
    let overlay = nav.overlay_text();
    let chrome_text = if overlay.is_empty() {
        nav.status_bits()
    } else {
        format!("{}\n{overlay}", nav.status_bits())
    };
    let chrome_height = session_chrome_height(nav);
    let notice_height = session_notice_height(notice);
    let input_height = session_input_height(draft, area.width);
    let transcript_height = nav.viewport_height.max(3).min(session_transcript_height(
        area.height,
        chrome_height,
        notice_height,
        input_height,
    ));
    let [header, chrome, transcript, status, prompt, footer] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(chrome_height),
        Constraint::Length(transcript_height),
        Constraint::Length(notice_height),
        Constraint::Length(input_height),
        Constraint::Length(1),
    ])
    .areas(area);
    let _ = theme;
    frame.render_widget(Paragraph::new("codsh · Rust client · dsh ACP"), header);
    Paragraph::new(chrome_text).render(chrome, frame.buffer_mut());
    Paragraph::new(nav.painted_transcript_lines().join("\n"))
        .render(transcript, frame.buffer_mut());
    render_notice(notice, status, frame.buffer_mut());
    let block = Block::new().borders(Borders::ALL).title(title);
    let input = block.inner(prompt);
    block.render(prompt, frame.buffer_mut());
    let mut state = TextAreaState::default();
    draft.render_ref(input, frame.buffer_mut(), &mut state);
    Paragraph::new("dsh Home: ~/.codsh-rust/dsh · Profile: rust")
        .render(footer, frame.buffer_mut());
    if nav.focus == Focus::Prompt
        && matches!(nav.overlay, NavOverlay::None)
        && let Some((x, y)) = draft.cursor_pos(input)
    {
        frame.set_cursor_position((x, y));
    }
    FrameLayout {
        prompt: input,
        transcript,
        chrome,
    }
}

/// A notice taller than its slot keeps the latest lines, including an error.
/// The unavailable status is pinned inside that window: a wrapped first-run
/// tip must not scroll it off a short screen.
fn render_notice(notice: &str, area: Rect, buf: &mut ratatui::buffer::Buffer) {
    if area.height == 0 || area.width == 0 {
        return;
    }
    let width = area.width.max(1) as usize;
    let mut rows: Vec<String> = Vec::new();
    for line in notice.lines() {
        let wrapped = wrap_line(line, width);
        if wrapped.is_empty() {
            rows.push(String::new());
        } else {
            rows.extend(wrapped);
        }
    }
    let height = area.height as usize;
    let mut visible: Vec<String> = if rows.len() > height {
        rows[rows.len() - height..].to_vec()
    } else {
        rows.clone()
    };
    if let Some(status) = rows
        .iter()
        .find(|row| row.contains("Execution unavailable"))
        .cloned()
        && !visible
            .iter()
            .any(|row| row.contains("Execution unavailable"))
    {
        if visible.is_empty() {
            visible.push(status);
        } else {
            let slot = visible.len() - 1;
            visible[slot] = status;
        }
    }
    Paragraph::new(visible.join("\n"))
        .wrap(Wrap { trim: false })
        .render(area, buf);
}

fn wrap_line(line: &str, width: usize) -> Vec<String> {
    if line.is_empty() {
        return vec![String::new()];
    }
    let mut rows = Vec::new();
    let mut current = String::new();
    let mut current_width = 0usize;
    for ch in line.chars() {
        let ch_width = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if ch_width > width {
            if !current.is_empty() {
                rows.push(std::mem::take(&mut current));
                current_width = 0;
            }
            rows.push(ch.to_string());
            continue;
        }
        if current_width + ch_width > width && !current.is_empty() {
            rows.push(std::mem::take(&mut current));
            current_width = 0;
        }
        current.push(ch);
        current_width += ch_width;
    }
    if !current.is_empty() {
        rows.push(current);
    }
    rows
}

fn wrapped_line_count(text: &str, width: u16) -> usize {
    let width = width.max(1) as usize;
    text.lines()
        .map(|line| {
            unicode_width::UnicodeWidthStr::width(line)
                .max(1)
                .div_ceil(width)
        })
        .sum()
}

fn wrapped_rows(text: &str, width: u16) -> u16 {
    wrapped_line_count(text, width).clamp(2, 40) as u16
}

pub fn render_minimal(
    frame: &mut Frame,
    draft: &TextArea,
    notice: &str,
    _selected: Option<usize>,
    _theme: &Theme,
    feedback_open: bool,
    title: &str,
) -> Rect {
    let area = frame.area();
    if area.width < 8 || area.height < 3 {
        frame.render_widget(Paragraph::new("codsh minimal · /fullscreen"), area);
        return Rect::default();
    }
    let input_height = draft
        .desired_height(area.width.saturating_sub(4))
        .clamp(1, 4)
        + 2;
    let prompt_height = input_height.min(area.height.saturating_sub(1));
    let [status, prompt] = Layout::vertical([
        Constraint::Length(area.height.saturating_sub(prompt_height)),
        Constraint::Length(prompt_height),
    ])
    .areas(area);
    let _ = feedback_open;
    Paragraph::new(notice)
        .wrap(Wrap { trim: false })
        .render(status, frame.buffer_mut());
    let block = Block::new().borders(Borders::ALL).title(title);
    let input = block.inner(prompt);
    block.render(prompt, frame.buffer_mut());
    let mut state = TextAreaState::default();
    draft.render_ref(input, frame.buffer_mut(), &mut state);
    if !feedback_open && let Some((x, y)) = draft.cursor_pos(input) {
        frame.set_cursor_position((x, y));
    }
    input
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};

    #[test]
    fn welcome_handles_narrow_short_wide_and_unicode_drafts() {
        for (width, height) in [(1, 1), (12, 4), (18, 8), (32, 12), (80, 24), (120, 40)] {
            let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
            let mut draft = TextArea::new();
            draft.set_text("你好 👩‍💻\nDraft survives resize");
            terminal
                .draw(|frame| {
                    render(
                        frame,
                        &draft,
                        "No execution adapter configured.",
                        None,
                        &Theme::offline(),
                        false,
                        false,
                        "Draft (not sent)",
                    );
                })
                .unwrap();
            let text: String = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect();
            assert!(text.contains('c'));
            assert_eq!(draft.text(), "你好 👩‍💻\nDraft survives resize");
        }
    }

    #[test]
    fn first_run_tip_keeps_config_fields_visible() {
        let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
        let draft = TextArea::new();
        let notice = "mode=fullscreen\nFirst-run: no usable provider. Official grok.com login/telemetry unused.\nWrite ~/.codsh-rust/.grok/config.toml ([model.<id>] base_url, env_key). Export the key. inspect shows origins.\nExecution unavailable: dsh\nNot connected. Draft kept.";
        terminal
            .draw(|frame| {
                render(
                    frame,
                    &draft,
                    notice,
                    None,
                    &Theme::offline(),
                    false,
                    false,
                    "Draft (not sent)",
                );
            })
            .unwrap();
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(text.contains("base_url"));
        assert!(text.contains("env_key"));
        assert!(text.contains("inspect"));
        assert!(text.contains("Execution unavailable"));
        let mut narrow = Terminal::new(TestBackend::new(32, 14)).unwrap();
        narrow
            .draw(|frame| {
                render(
                    frame,
                    &draft,
                    notice,
                    None,
                    &Theme::offline(),
                    false,
                    false,
                    "Draft (not sent)",
                );
            })
            .unwrap();
        let narrow_text: String = narrow
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(
            narrow_text.contains("Execution unavailable"),
            "a 32-column screen still shows the unavailable status: {narrow_text}"
        );
        // The packed PTY types a draft before Enter. That box is taller than
        // an empty prompt, so the notice slot must still show the status.
        let mut typed = TextArea::new();
        typed.set_text("draft survives resize");
        let mut typed_narrow = Terminal::new(TestBackend::new(32, 14)).unwrap();
        typed_narrow
            .draw(|frame| {
                render(
                    frame,
                    &typed,
                    notice,
                    None,
                    &Theme::offline(),
                    false,
                    false,
                    "Draft (not sent)",
                );
            })
            .unwrap();
        let typed_text: String = typed_narrow
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(
            typed_text.contains("draft survives resize"),
            "the typed draft stays in the box: {typed_text}"
        );
        assert!(
            typed_text.contains("Execution unavailable"),
            "a typed draft on a 32-column screen still shows the unavailable status: {typed_text}"
        );
        // A draft that wraps inside the 32-column box grows the prompt and
        // shrinks the notice. The status still has to be on screen.
        let mut wrapped = TextArea::new();
        wrapped.set_text("draft survives resize and still reports the disconnect");
        let mut wrapped_narrow = Terminal::new(TestBackend::new(32, 14)).unwrap();
        wrapped_narrow
            .draw(|frame| {
                render(
                    frame,
                    &wrapped,
                    notice,
                    None,
                    &Theme::offline(),
                    false,
                    false,
                    "Draft (not sent)",
                );
            })
            .unwrap();
        let wrapped_text: String = wrapped_narrow
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(
            wrapped_text.contains("draft survives resize"),
            "the wrapped draft stays in the box: {wrapped_text}"
        );
        assert!(
            wrapped_text.contains("Execution unavailable"),
            "a wrapped draft on a 32-column screen still shows the unavailable status: {wrapped_text}"
        );
    }

    #[test]
    fn long_error_notice_keeps_the_draft_box_on_a_short_screen() {
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        let draft = TextArea::new();
        let notice = "mode=fullscreen\nConnected to dsh ACP session demo.\nEnter submits a prompt through dsh.\nRoute: cli-mock/cli-mock id=gateway api=openai-completions\nbackend=chat_completions effort=high advertised_context=unknown (no silent\nprovider fallback)\nusage=unknown advertised_context=unknown cost=unknown\ndestination rejected the submission (HTTP 500); the local draft was kept";
        terminal
            .draw(|frame| {
                render(
                    frame,
                    &draft,
                    notice,
                    None,
                    &Theme::offline(),
                    false,
                    false,
                    "Draft (not sent)",
                );
            })
            .unwrap();
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(
            text.contains("Draft (not sent)"),
            "prompt box must stay visible when the notice wraps"
        );
        let mut wide = Terminal::new(TestBackend::new(100, 24)).unwrap();
        wide.draw(|frame| {
            render(
                frame,
                &draft,
                notice,
                None,
                &Theme::offline(),
                false,
                false,
                "Draft (not sent)",
            );
        })
        .unwrap();
        let wide_text: String = wide
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(
            wide_text.contains("Draft (not sent)"),
            "hero layout must keep the prompt when the notice wraps"
        );
        assert!(
            wide_text.contains("HTTP 500"),
            "the latest error stays visible above the prompt"
        );
        assert!(text.contains("HTTP 500"));
    }

    #[test]
    fn minimal_overlay_keeps_draft_and_native_mode_label() {
        let mut terminal = Terminal::new(TestBackend::new(80, 12)).unwrap();
        let mut draft = TextArea::new();
        draft.set_text("keep-draft");
        terminal
            .draw(|frame| {
                render_minimal(
                    frame,
                    &draft,
                    "mode=minimal\nConnected to dsh ACP session demo.",
                    None,
                    &Theme::offline(),
                    false,
                    "Draft (not sent)",
                );
            })
            .unwrap();
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(text.contains("mode=minimal"), "{text}");
        assert!(text.contains("keep-draft"), "{text}");
        assert_eq!(draft.text(), "keep-draft");
    }
}
