use ratatui::style::Color;
use std::collections::BTreeMap;
use unicode_width::UnicodeWidthChar;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ThemeKind {
    GrokNight,
    GrokDay,
    TokyoNight,
    RosePineMoon,
    OscuraMidnight,
    Terminal,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ColorLevel {
    None,
    Basic,
    Ansi256,
    TrueColor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Appearance {
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Theme {
    pub text_primary: Color,
    pub gray: Color,
    pub gray_bright: Color,
    pub bg_highlight: Color,
    pub bg_base: Color,
    pub accent: Color,
}

impl ThemeKind {
    pub const ALL: &[ThemeKind] = &[
        ThemeKind::GrokNight,
        ThemeKind::GrokDay,
        ThemeKind::TokyoNight,
        ThemeKind::RosePineMoon,
        ThemeKind::OscuraMidnight,
        ThemeKind::Terminal,
    ];

    pub fn display_name(self) -> &'static str {
        match self {
            Self::GrokNight => "groknight",
            Self::GrokDay => "grokday",
            Self::TokyoNight => "tokyonight",
            Self::RosePineMoon => "rosepine-moon",
            Self::OscuraMidnight => "oscura-midnight",
            Self::Terminal => "terminal",
            Self::Auto => "auto",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::GrokNight => "Grok Night",
            Self::GrokDay => "Grok Day",
            Self::TokyoNight => "Tokyo Night",
            Self::RosePineMoon => "Rose Pine Moon",
            Self::OscuraMidnight => "Oscura Midnight",
            Self::Terminal => "Terminal",
            Self::Auto => "Auto",
        }
    }

    pub fn aliases(self) -> &'static [&'static str] {
        match self {
            Self::GrokNight => &["grok-night", "dark"],
            Self::GrokDay => &["grok-day", "light", "day"],
            Self::TokyoNight => &["tokyo-night", "tokyo"],
            Self::RosePineMoon => &["rosepine", "rose-pine", "rose-pine-moon"],
            Self::OscuraMidnight => &["oscura"],
            Self::Terminal => &["terminal-default", "transparent", "native"],
            Self::Auto => &["system"],
        }
    }

    pub fn requires_truecolor(self) -> bool {
        matches!(
            self,
            Self::TokyoNight | Self::RosePineMoon | Self::OscuraMidnight
        )
    }

    pub fn is_auto(self) -> bool {
        self == Self::Auto
    }

    pub fn is_terminal_native(self) -> bool {
        self == Self::Terminal
    }

    #[allow(dead_code)]
    pub fn from_name(name: &str) -> Option<Self> {
        Self::from_name_gated(name, true)
    }

    pub fn from_name_gated(name: &str, terminal_theme: bool) -> Option<Self> {
        let lower = name.trim().to_ascii_lowercase();
        let kind = Self::ALL
            .iter()
            .copied()
            .chain(std::iter::once(Self::Auto))
            .find(|kind| {
                kind.display_name() == lower || kind.aliases().contains(&lower.as_str())
            })?;
        if kind.is_terminal_native() && !terminal_theme {
            return None;
        }
        Some(kind)
    }

    pub fn selectable(terminal_theme: bool) -> Vec<Self> {
        Self::ALL
            .iter()
            .copied()
            .filter(|kind| terminal_theme || !kind.is_terminal_native())
            .collect()
    }

    pub fn available(level: ColorLevel, terminal_theme: bool) -> Vec<Self> {
        Self::selectable(terminal_theme)
            .into_iter()
            .filter(|kind| level.has_truecolor() || !kind.requires_truecolor())
            .collect()
    }

    #[allow(dead_code)]
    pub fn next_available(self, level: ColorLevel, terminal_theme: bool) -> Self {
        let available = Self::available(level, terminal_theme);
        if available.is_empty() {
            return Self::GrokNight;
        }
        let index = available.iter().position(|kind| *kind == self).unwrap_or(0);
        available[(index + 1) % available.len()]
    }
}

impl ColorLevel {
    #[allow(dead_code)]
    pub fn has_color(self) -> bool {
        self > Self::None
    }

    pub fn has_truecolor(self) -> bool {
        self == Self::TrueColor
    }

    pub fn detect(env: &BTreeMap<String, String>) -> Self {
        if env.contains_key("NO_COLOR") {
            return Self::None;
        }
        let colorterm = env
            .get("COLORTERM")
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if colorterm == "truecolor" || colorterm == "24bit" {
            return Self::TrueColor;
        }
        let term = env
            .get("TERM")
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if term.contains("truecolor") || term.contains("direct") {
            return Self::TrueColor;
        }
        if term.contains("256color") || term.contains("256colour") {
            return Self::Ansi256;
        }
        if term == "dumb" || term.is_empty() {
            return Self::Basic;
        }
        Self::Basic
    }
}

impl Appearance {
    #[allow(dead_code)]
    pub fn as_env_value(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Light => "light",
        }
    }

    pub fn detect(env: &BTreeMap<String, String>) -> Option<Self> {
        for key in ["GROK_APPEARANCE", "LC_GROK_APPEARANCE"] {
            if let Some(value) = env.get(key) {
                match value.trim().to_ascii_lowercase().as_str() {
                    "dark" => return Some(Self::Dark),
                    "light" => return Some(Self::Light),
                    _ => {}
                }
            }
        }
        detect_colorfgbg(env.get("COLORFGBG").map(String::as_str))
    }
}

pub fn detect_colorfgbg(value: Option<&str>) -> Option<Appearance> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    let bg = raw.split([';', ':']).nth(1).unwrap_or(raw).trim();
    let number: u8 = bg.parse().ok()?;
    Some(if number >= 8 {
        Appearance::Light
    } else {
        Appearance::Dark
    })
}

impl Theme {
    pub fn groknight() -> Self {
        Self {
            text_primary: rgb(225, 225, 225),
            gray: rgb(108, 108, 108),
            gray_bright: rgb(120, 120, 120),
            bg_highlight: rgb(36, 36, 36),
            bg_base: rgb(20, 20, 20),
            accent: rgb(187, 154, 247),
        }
    }

    pub fn grokday() -> Self {
        Self {
            text_primary: rgb(38, 38, 38),
            gray: rgb(118, 118, 118),
            gray_bright: rgb(98, 98, 98),
            bg_highlight: rgb(222, 222, 222),
            bg_base: rgb(238, 238, 238),
            accent: rgb(125, 75, 198),
        }
    }

    pub fn tokyonight() -> Self {
        Self {
            text_primary: rgb(192, 202, 245),
            gray: rgb(86, 95, 137),
            gray_bright: rgb(115, 122, 162),
            bg_highlight: rgb(41, 46, 66),
            bg_base: rgb(36, 40, 59),
            accent: rgb(122, 162, 247),
        }
    }

    pub fn rosepine_moon() -> Self {
        Self {
            text_primary: rgb(224, 222, 244),
            gray: rgb(110, 106, 134),
            gray_bright: rgb(144, 140, 170),
            bg_highlight: rgb(57, 53, 82),
            bg_base: rgb(35, 33, 54),
            accent: rgb(196, 167, 231),
        }
    }

    pub fn oscura_midnight() -> Self {
        Self {
            text_primary: rgb(228, 228, 228),
            gray: rgb(129, 134, 143),
            gray_bright: rgb(190, 190, 190),
            bg_highlight: rgb(36, 32, 52),
            bg_base: rgb(3, 3, 4),
            accent: rgb(155, 126, 206),
        }
    }

    pub fn terminal_default() -> Self {
        Self {
            text_primary: Color::Reset,
            gray: Color::Reset,
            gray_bright: Color::Reset,
            bg_highlight: Color::Reset,
            bg_base: Color::Reset,
            accent: Color::Magenta,
        }
    }

    pub fn offline() -> Self {
        Self::terminal_default()
    }

    pub fn for_kind(kind: ThemeKind) -> Self {
        match kind {
            ThemeKind::GrokNight | ThemeKind::Auto => Self::groknight(),
            ThemeKind::GrokDay => Self::grokday(),
            ThemeKind::TokyoNight => Self::tokyonight(),
            ThemeKind::RosePineMoon => Self::rosepine_moon(),
            ThemeKind::OscuraMidnight => Self::oscura_midnight(),
            ThemeKind::Terminal => Self::terminal_default(),
        }
    }

    pub fn quantized(self, level: ColorLevel) -> Self {
        Self {
            text_primary: quantize(self.text_primary, level),
            gray: quantize(self.gray, level),
            gray_bright: quantize(self.gray_bright, level),
            bg_highlight: quantize(self.bg_highlight, level),
            bg_base: quantize(self.bg_base, level),
            accent: quantize(self.accent, level),
        }
    }

    pub fn is_bandless(&self) -> bool {
        self.bg_base == Color::Reset
    }

    pub fn cursor_osc(self) -> Option<String> {
        match self.accent {
            Color::Rgb(r, g, b) => Some(format!("\x1b]12;#{r:02x}{g:02x}{b:02x}\x07")),
            _ => None,
        }
    }
}

pub fn resolve_auto(
    appearance: Option<Appearance>,
    dark: ThemeKind,
    light: ThemeKind,
) -> ThemeKind {
    match appearance.unwrap_or(Appearance::Dark) {
        Appearance::Dark => concrete_auto(dark, ThemeKind::GrokNight),
        Appearance::Light => concrete_auto(light, ThemeKind::GrokDay),
    }
}

fn concrete_auto(kind: ThemeKind, fallback: ThemeKind) -> ThemeKind {
    if kind.is_auto() { fallback } else { kind }
}

pub fn env_theme(env: &BTreeMap<String, String>, terminal_theme: bool) -> Option<ThemeKind> {
    for key in ["GROK_THEME", "LC_GROK_THEME"] {
        if let Some(value) = env
            .get(key)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            return ThemeKind::from_name_gated(value, terminal_theme);
        }
    }
    None
}

const fn rgb(r: u8, g: u8, b: u8) -> Color {
    Color::Rgb(r, g, b)
}

pub fn quantize(color: Color, level: ColorLevel) -> Color {
    match (color, level) {
        (_, ColorLevel::None) => Color::Reset,
        (Color::Rgb(r, g, b), ColorLevel::Basic) => nearest_ansi16(r, g, b),
        (Color::Rgb(r, g, b), ColorLevel::Ansi256) => Color::Indexed(nearest_indexed(r, g, b)),
        (other, _) => other,
    }
}

fn nearest_ansi16(r: u8, g: u8, b: u8) -> Color {
    const ANSI: [(u8, u8, u8, Color); 16] = [
        (0, 0, 0, Color::Black),
        (128, 0, 0, Color::Red),
        (0, 128, 0, Color::Green),
        (128, 128, 0, Color::Yellow),
        (0, 0, 128, Color::Blue),
        (128, 0, 128, Color::Magenta),
        (0, 128, 128, Color::Cyan),
        (192, 192, 192, Color::Gray),
        (128, 128, 128, Color::DarkGray),
        (255, 0, 0, Color::LightRed),
        (0, 255, 0, Color::LightGreen),
        (255, 255, 0, Color::LightYellow),
        (0, 0, 255, Color::LightBlue),
        (255, 0, 255, Color::LightMagenta),
        (0, 255, 255, Color::LightCyan),
        (255, 255, 255, Color::White),
    ];
    ANSI.iter()
        .min_by_key(|(ar, ag, ab, _)| distance(r, g, b, *ar, *ag, *ab))
        .map(|(_, _, _, color)| *color)
        .unwrap_or(Color::White)
}

fn nearest_indexed(r: u8, g: u8, b: u8) -> u8 {
    let cube = |v: u8| -> u8 {
        if v < 48 {
            0
        } else if v < 115 {
            1
        } else {
            ((v - 35) / 40).min(5)
        }
    };
    let cr = cube(r);
    let cg = cube(g);
    let cb = cube(b);
    let cube_index = 16 + 36 * cr + 6 * cg + cb;
    let cube_rgb = |n: u8| if n == 0 { 0 } else { 55 + 40 * n };
    let cube_dist = distance(r, g, b, cube_rgb(cr), cube_rgb(cg), cube_rgb(cb));
    let gray = ((r as u16 + g as u16 + b as u16) / 3).clamp(8, 238);
    let gray_index = 232 + ((gray.saturating_sub(8)) / 10) as u8;
    let gray_value = 8 + 10 * (gray_index - 232);
    let gray_dist = distance(r, g, b, gray_value, gray_value, gray_value);
    if gray_dist < cube_dist {
        gray_index
    } else {
        cube_index
    }
}

fn distance(r: u8, g: u8, b: u8, or: u8, og: u8, ob: u8) -> u32 {
    let dr = r as i32 - or as i32;
    let dg = g as i32 - og as i32;
    let db = b as i32 - ob as i32;
    (dr * dr + dg * dg + db * db) as u32
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

pub const CURSOR_RESET: &str = "\x1b]112\x07";

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).into(), (*value).into()))
            .collect()
    }

    #[test]
    fn parses_names_aliases_and_terminal_gate() {
        assert_eq!(ThemeKind::from_name("Dark"), Some(ThemeKind::GrokNight));
        assert_eq!(ThemeKind::from_name("system"), Some(ThemeKind::Auto));
        assert_eq!(
            ThemeKind::from_name_gated("transparent", true),
            Some(ThemeKind::Terminal)
        );
        assert_eq!(ThemeKind::from_name_gated("terminal", false), None);
        assert_eq!(ThemeKind::from_name("banana"), None);
    }

    #[test]
    fn hides_truecolor_only_themes_and_gated_terminal() {
        let basic = ThemeKind::available(ColorLevel::Basic, false);
        assert!(basic.contains(&ThemeKind::GrokNight));
        assert!(basic.contains(&ThemeKind::GrokDay));
        assert!(!basic.contains(&ThemeKind::TokyoNight));
        assert!(!basic.contains(&ThemeKind::Terminal));
        let truecolor = ThemeKind::available(ColorLevel::TrueColor, true);
        assert!(truecolor.contains(&ThemeKind::TokyoNight));
        assert!(truecolor.contains(&ThemeKind::Terminal));
    }

    #[test]
    fn auto_follows_env_then_colorfgbg_then_dark_default() {
        assert_eq!(
            resolve_auto(
                Appearance::detect(&env(&[("GROK_APPEARANCE", "light")])),
                ThemeKind::TokyoNight,
                ThemeKind::GrokDay
            ),
            ThemeKind::GrokDay
        );
        assert_eq!(
            resolve_auto(
                Appearance::detect(&env(&[("COLORFGBG", "15;0")])),
                ThemeKind::GrokNight,
                ThemeKind::GrokDay
            ),
            ThemeKind::GrokNight
        );
        assert_eq!(
            resolve_auto(None, ThemeKind::GrokNight, ThemeKind::GrokDay),
            ThemeKind::GrokNight
        );
    }

    #[test]
    fn no_color_and_quantization_degrade_without_claiming_truecolor() {
        assert_eq!(
            ColorLevel::detect(&env(&[("NO_COLOR", "1")])),
            ColorLevel::None
        );
        assert_eq!(
            ColorLevel::detect(&env(&[("COLORTERM", "truecolor")])),
            ColorLevel::TrueColor
        );
        assert_eq!(
            ColorLevel::detect(&env(&[("TERM", "xterm-256color")])),
            ColorLevel::Ansi256
        );
        let color = Theme::tokyonight().quantized(ColorLevel::Basic).bg_base;
        assert!(!matches!(color, Color::Rgb(_, _, _)));
        assert_eq!(
            Theme::groknight().quantized(ColorLevel::None).text_primary,
            Color::Reset
        );
        assert!(Theme::terminal_default().is_bandless());
        assert!(!Theme::groknight().is_bandless());
    }

    #[test]
    fn grokday_is_not_the_fullscreen_night_palette() {
        assert_ne!(Theme::groknight().bg_base, Theme::grokday().bg_base);
        assert_ne!(
            Theme::for_kind(ThemeKind::Terminal).bg_base,
            Theme::groknight().bg_base
        );
    }
}
