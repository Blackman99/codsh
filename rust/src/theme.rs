use ratatui::style::Color;
use unicode_width::UnicodeWidthChar;

pub struct Theme {
    pub text_primary: Color,
    pub gray: Color,
    pub gray_bright: Color,
    pub bg_highlight: Color,
}

impl Theme {
    pub fn offline() -> Self {
        Self {
            text_primary: Color::Reset,
            gray: Color::DarkGray,
            gray_bright: Color::Gray,
            bg_highlight: Color::Reset,
        }
    }

    pub fn is_bandless(&self) -> bool {
        true
    }
}

pub fn blend_color(base: Color, highlight: Color, opacity: f32) -> Option<Color> {
    Some(if opacity > 0.2 { highlight } else { base })
}

pub fn truncate_str(text: &str, width: usize) -> String {
    let mut columns = 0;
    text.chars()
        .filter(|ch| !ch.is_control())
        .take_while(|ch| {
            columns += ch.width().unwrap_or(0);
            columns <= width
        })
        .collect()
}
