mod hero_box;
mod layout;
mod logo;
mod menu;

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
        let block = Block::new().borders(Borders::ALL).title("Draft (not sent)");
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
    let block = Block::new().borders(Borders::ALL).title("Draft (not sent)");
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

/// A notice taller than its slot keeps the latest lines, including an error.
fn render_notice(notice: &str, area: Rect, buf: &mut ratatui::buffer::Buffer) {
    let rows = wrapped_line_count(notice, area.width);
    let scroll = rows.saturating_sub(area.height as usize) as u16;
    Paragraph::new(notice)
        .wrap(Wrap { trim: false })
        .scroll((scroll, 0))
        .render(area, buf);
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
    let notice_height = if feedback_open {
        area.height.saturating_sub(1)
    } else {
        notice
            .lines()
            .count()
            .clamp(1, area.height.saturating_sub(input_height + 1) as usize) as u16
    };
    let [status, prompt] = Layout::vertical([
        Constraint::Min(notice_height),
        Constraint::Length(input_height),
    ])
    .areas(area);
    Paragraph::new(notice)
        .wrap(Wrap { trim: false })
        .render(status, frame.buffer_mut());
    let block = Block::new().borders(Borders::ALL).title("Draft (not sent)");
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
        let notice = "Execution unavailable: dsh\nNot connected. Draft kept.\nFirst-run: no usable provider. Official grok.com login/telemetry unused.\nWrite ~/.codsh-rust/.grok/config.toml ([model.<id>] base_url, env_key). Export the key. inspect shows origins.";
        terminal
            .draw(|frame| {
                render(frame, &draft, notice, None, &Theme::offline(), false, false);
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
    }

    #[test]
    fn long_error_notice_keeps_the_draft_box_on_a_short_screen() {
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        let draft = TextArea::new();
        let notice = "mode=fullscreen\nConnected to dsh ACP session demo.\nEnter submits a prompt through dsh.\nRoute: cli-mock/cli-mock id=gateway api=openai-completions\nbackend=chat_completions effort=high advertised_context=unknown (no silent\nprovider fallback)\nusage=unknown advertised_context=unknown cost=unknown\ndestination rejected the submission (HTTP 500); the local draft was kept";
        terminal
            .draw(|frame| {
                render(frame, &draft, notice, None, &Theme::offline(), false, false);
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
            render(frame, &draft, notice, None, &Theme::offline(), false, false);
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
