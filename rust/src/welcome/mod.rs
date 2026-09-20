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

pub fn render(frame: &mut Frame, draft: &TextArea, notice: &str, selected: Option<usize>) -> Rect {
    let area = frame.area();
    let theme = Theme::offline();
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
    let tip_height = wrapped_rows(notice, content.width);
    let layout = layout::WelcomeLayout::compute(layout::WelcomeLayoutInput {
        content_area: content,
        menu_height: 3,
        tip_height,
        prompt_height: Some(input_height),
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
    if layout.has_hero_box() {
        Block::bordered()
            .border_type(BorderType::Rounded)
            .render(layout.hero_box, buf);
        logo::render_full_logo(layout.hero_logo, buf, &theme);
        Paragraph::new("codsh · Rust + dsh").render(layout.hero_version, buf);
        Paragraph::new("No official account. Isolated Home.").render(layout.hero_subtitle, buf);
        menu::render_menu(layout.hero_menu, buf, &theme, &items, selected, None, 0);
    } else {
        logo::render_logo_tier(layout.logo, buf, &theme, layout.logo_tier);
        menu::render_menu(layout.menu, buf, &theme, &items, selected, None, 0);
    }
    Paragraph::new(notice)
        .wrap(Wrap { trim: false })
        .render(layout.tip, buf);
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
    if let Some((x, y)) = draft.cursor_pos(input) {
        frame.set_cursor_position((x, y));
    }
    input
}

fn wrapped_rows(text: &str, width: u16) -> u16 {
    let width = width.max(1) as usize;
    let rows = text
        .lines()
        .map(|line| {
            unicode_width::UnicodeWidthStr::width(line)
                .max(1)
                .div_ceil(width)
        })
        .sum::<usize>();
    rows.clamp(2, 24) as u16
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
                    render(frame, &draft, "No execution adapter configured.", None);
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
                render(frame, &draft, notice, None);
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
}
