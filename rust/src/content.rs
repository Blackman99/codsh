use anstyle::Style as Anstyle;
use ratatui::text::{Line, Span};
use std::collections::HashSet;
use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;
use unicode_segmentation::UnicodeSegmentation;
use xai_grok_markdown::{MarkdownStyle, Syntect};

use crate::navigation::{LineKind, NavEntry};

pub const TOOL_PREVIEW_LINES: usize = 12;
pub const FOLDED_HINT: &str = "[folded · → expand  r raw  Enter full content]";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BlockKind {
    Thought,
    Tool,
    Answer,
}

fn syntect() -> &'static Syntect {
    static SYNTECT: OnceLock<Syntect> = OnceLock::new();
    SYNTECT.get_or_init(|| {
        Syntect::new(include_bytes!(
            "../upstream/xai-grok-markdown/assets/tokyo-night.tmTheme"
        ))
    })
}

const fn rgb(r: u8, g: u8, b: u8) -> anstyle::Color {
    anstyle::Color::Rgb(anstyle::RgbColor(r, g, b))
}

const fn fg(color: anstyle::Color) -> Anstyle {
    Anstyle::new().fg_color(Some(color))
}

/// Official playground pretty style (`bin/playground_common.rs::md_style`).
/// Hidden `_outer` styles skip markdown/HTML markers in pretty mode.
pub fn pretty_markdown_style() -> MarkdownStyle {
    const TEAL: anstyle::Color = rgb(26, 188, 156);
    const BLUE: anstyle::Color = rgb(122, 162, 247);
    const ORANGE: anstyle::Color = rgb(255, 158, 100);
    const RED: anstyle::Color = rgb(247, 118, 142);
    const GREEN: anstyle::Color = rgb(158, 206, 106);
    const MAGENTA: anstyle::Color = rgb(187, 154, 247);
    const YELLOW: anstyle::Color = rgb(224, 175, 104);
    const COMMENT: anstyle::Color = rgb(86, 95, 137);
    const BG_DARK: anstyle::Color = rgb(31, 35, 53);
    MarkdownStyle {
        heading_inner: [
            fg(TEAL).bold(),
            fg(BLUE).bold(),
            fg(ORANGE).bold(),
            fg(RED).bold(),
            fg(GREEN).bold(),
            fg(MAGENTA).bold(),
        ],
        heading_outer: [
            fg(TEAL).dimmed().hidden(),
            fg(BLUE).dimmed().hidden(),
            fg(ORANGE).dimmed().hidden(),
            fg(RED).dimmed().hidden(),
            fg(GREEN).dimmed().hidden(),
            fg(MAGENTA).dimmed().hidden(),
        ],
        strong_inner: Anstyle::new().bold(),
        strong_outer: Anstyle::new().dimmed().hidden(),
        emphasis_inner: Anstyle::new().italic(),
        emphasis_outer: Anstyle::new().dimmed().hidden(),
        strikethrough_inner: Anstyle::new().strikethrough(),
        strikethrough_outer: Anstyle::new().dimmed().hidden(),
        inline_code_inner: fg(YELLOW).bold(),
        inline_code_outer: fg(YELLOW).dimmed().hidden(),
        blockquote_outer: fg(COMMENT).dimmed(),
        task_checked: fg(rgb(125, 207, 255)),
        task_unchecked: fg(BLUE).dimmed(),
        list_item: fg(BLUE).dimmed(),
        rule: fg(COMMENT),
        link_outer: fg(COMMENT),
        link_text: Anstyle::new().bold(),
        link_url: fg(COMMENT),
        link_title: fg(GREEN),
        code_outer: fg(YELLOW).dimmed().hidden(),
        code_language: fg(ORANGE).hidden(),
        code_untagged: Anstyle::new(),
        code_background: Anstyle::new().bg_color(Some(BG_DARK)),
        table_outer: fg(BLUE).hidden(),
        text: Anstyle::new(),
        math: Anstyle::new().italic(),
    }
}

fn flatten_lines(lines: &[Line<'_>]) -> String {
    lines
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Official pretty mode leaves InlineHtml tags (`<font>`, `<b>`) visible,
/// sometimes split across spans and lines. Drop a tag wherever it starts and
/// keep the text it wraps. Not applied to raw mode.
fn hide_inline_html_tags(lines: &mut [Line<'static>]) {
    let mut dropping = false;
    for line in lines.iter_mut() {
        for span in &mut line.spans {
            let text = span.content.as_ref();
            if !dropping && !text.contains('<') {
                continue;
            }
            let mut out = String::new();
            for ch in text.chars() {
                if dropping {
                    if ch == '>' {
                        dropping = false;
                    } else if ch == '\n' {
                        dropping = false;
                        out.push(ch);
                    }
                    continue;
                }
                if ch == '<' {
                    dropping = true;
                    continue;
                }
                out.push(ch);
            }
            if out != text {
                span.content = std::borrow::Cow::Owned(out);
            }
        }
        if dropping {
            dropping = false;
        }
    }
}

/// Ratatui wraps on grapheme boundaries and then skips a zero-width joiner, so
/// 👩‍💻 becomes woman, a hole, then laptop when the cluster crosses a cell.
/// Keep the whole cluster in the span that starts it.
fn glue_zwj_clusters(lines: &mut [Line<'static>]) {
    for line in lines.iter_mut() {
        let mut spans = Vec::with_capacity(line.spans.len());
        let mut pending: Option<(String, ratatui::style::Style)> = None;
        for span in line.spans.drain(..) {
            let style = span.style;
            let mut text = span.content.into_owned();
            if let Some((prefix, prefix_style)) = pending.take() {
                if prefix_style == style {
                    text.insert_str(0, &prefix);
                } else {
                    spans.push(Span::styled(prefix, prefix_style));
                }
            }
            if text.ends_with('\u{200d}') {
                pending = Some((text, style));
                continue;
            }
            spans.push(Span::styled(text, style));
        }
        if let Some((text, style)) = pending {
            spans.push(Span::styled(text, style));
        }
        line.spans = spans;
    }
}

fn owned_lines(lines: Vec<Line<'_>>) -> Vec<Line<'static>> {
    lines
        .into_iter()
        .map(|line| {
            Line::from(
                line.spans
                    .into_iter()
                    .map(|span| Span::styled(span.content.into_owned(), span.style))
                    .collect::<Vec<_>>(),
            )
        })
        .collect()
}

fn plain_lines(text: &str) -> Vec<Line<'static>> {
    if text.is_empty() {
        return Vec::new();
    }
    text.lines()
        .map(|line| Line::from(line.to_string()))
        .collect()
}

fn preview_line_vec(lines: Vec<Line<'static>>, limit: usize) -> Vec<Line<'static>> {
    if lines.len() <= limit {
        return lines;
    }
    let hidden = lines.len() - limit;
    let mut out = lines.into_iter().take(limit).collect::<Vec<_>>();
    out.push(Line::from(format!("{FOLDED_HINT} · {hidden} more lines")));
    out
}

pub fn render_markdown_lines(text: &str) -> Vec<Line<'static>> {
    let sanitized = sanitize(text);
    let (lines, _) = xai_grok_markdown::render_markdown_ratatui(
        &sanitized,
        pretty_markdown_style(),
        true,
        Some(syntect()),
    );
    let mut out = owned_lines(lines);
    hide_inline_html_tags(&mut out);
    glue_zwj_clusters(&mut out);
    if xai_grok_markdown_core::analyze(&sanitized)
        .issues
        .contains(&xai_grok_markdown_core::StructuralIssue::UnterminatedCodeBlock)
    {
        out.push(Line::from("[unclosed code fence]"));
    }
    out
}

pub fn render_markdown(text: &str) -> String {
    flatten_lines(&render_markdown_lines(text))
}

pub struct ToolView {
    pub id: String,
    pub title: String,
    pub status: String,
    pub diff: String,
    pub result: String,
}

pub struct TurnView {
    pub user: String,
    pub thought: String,
    pub answer: String,
    pub error: Option<String>,
    pub tools: Vec<ToolView>,
    pub permission: Option<String>,
    pub done: bool,
    pub cancelled: bool,
    pub interrupted: bool,
    pub compacted: bool,
    pub compaction: Option<String>,
}

pub fn sanitize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut skip_csi = false;
    for grapheme in text.graphemes(true) {
        if skip_csi {
            if grapheme
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_alphabetic())
            {
                skip_csi = false;
            }
            continue;
        }
        if grapheme == "\n" || grapheme == "\t" {
            out.push_str(grapheme);
            continue;
        }
        if grapheme == "\r" {
            continue;
        }
        if grapheme == "\0" {
            out.push_str("^@");
            continue;
        }
        if grapheme == "\u{0007}" {
            out.push_str("^G");
            continue;
        }
        if grapheme == "\u{001b}" {
            skip_csi = true;
            continue;
        }
        if grapheme.chars().all(|ch| ch.is_control()) {
            continue;
        }
        out.push_str(grapheme);
    }
    out
}

#[cfg(test)]
pub fn preview_lines(text: &str, limit: usize) -> (String, bool, usize) {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= limit {
        return (text.trim_end().to_string(), false, 0);
    }
    let mut preview = lines[..limit].join("\n");
    let hidden = lines.len() - limit;
    preview.push('\n');
    preview.push_str(&format!("{FOLDED_HINT} · {hidden} more lines"));
    (preview, true, hidden)
}

fn foldable_source(text: &str) -> bool {
    text.lines().count() > TOOL_PREVIEW_LINES
}

fn display_plain(text: &str) -> String {
    sanitize(text)
}

/// Display state for one block. Fold and raw are paint-only: they never
/// rewrite the model history or the bytes a copy/pager reads.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DisplayState {
    pub raw: HashSet<String>,
    pub expanded_history: HashSet<String>,
}

pub fn block_key(turn: usize, kind: BlockKind, tool_id: &str) -> String {
    match kind {
        BlockKind::Thought => format!("{turn}:thought"),
        BlockKind::Answer => format!("{turn}:answer"),
        BlockKind::Tool => format!("{turn}:tool:{tool_id}"),
    }
}

fn body_lines(text: &str, raw: bool, folded: bool, foldable: bool) -> Vec<Line<'static>> {
    let rendered = if raw {
        plain_lines(&display_plain(text))
    } else {
        render_markdown_lines(text)
    };
    if foldable && folded {
        preview_line_vec(rendered, TOOL_PREVIEW_LINES)
    } else {
        rendered
    }
}

fn prefix_first(mut lines: Vec<Line<'static>>, prefix: &str) -> Vec<Line<'static>> {
    if let Some(first) = lines.first_mut() {
        let mut spans = vec![Span::raw(prefix.to_string())];
        spans.extend(first.spans.clone());
        *first = Line::from(spans);
    } else {
        lines.push(Line::from(prefix.to_string()));
    }
    lines
}

/// Pretty (or raw) lines for one navigation entry. Folded blocks keep a real
/// prefix of the rendered body plus the fold hint; they do not invent text.
pub fn entry_lines(
    turn: usize,
    entry: &NavEntry,
    display: &DisplayState,
) -> Vec<(LineKind, String)> {
    let mut out = Vec::new();
    out.push((
        LineKind::User,
        format!("> {}", entry.user.replace('\n', " ")),
    ));
    if !entry.thought.is_empty() {
        let key = block_key(turn, BlockKind::Thought, "");
        let raw = display.raw.contains(&key);
        let foldable = foldable_source(&entry.thought);
        let folded = entry.folded_thought;
        let lines = if folded && !foldable {
            vec![Line::from("[thought] folded · click to expand".to_string())]
        } else {
            prefix_first(
                body_lines(&entry.thought, raw, folded, foldable),
                "[thought] ",
            )
        };
        for line in lines {
            out.push((
                LineKind::Thought,
                flatten_lines(std::slice::from_ref(&line)),
            ));
        }
    }
    for (index, (title, result)) in entry.tools.iter().enumerate() {
        let key = block_key(turn, BlockKind::Tool, title);
        let raw = display.raw.contains(&key);
        let (id, status) = entry
            .tool_meta
            .get(index)
            .map(|(id, status)| (id.as_str(), status.as_str()))
            .unwrap_or(("", ""));
        let status_line = if status.is_empty() {
            String::new()
        } else if id.is_empty() {
            format!("[tool {title} {status}]")
        } else {
            format!("[tool {title} {id} {status}]")
        };
        let source = if result.contains('\n') || result.len() > 80 {
            let body = result.trim_end();
            if status_line.is_empty() {
                format!("```text\n{body}\n```")
            } else {
                format!("{status_line}\n```text\n{body}\n```")
            }
        } else if status_line.is_empty() {
            result.clone()
        } else if result.is_empty() {
            status_line
        } else {
            format!("{status_line}\n{result}")
        };
        let foldable = foldable_source(result);
        let folded = entry.folded_tools && foldable;
        let lines = prefix_first(
            body_lines(&source, raw, folded, foldable),
            &format!("[tool {title}] "),
        );
        for line in lines {
            out.push((LineKind::Tool, flatten_lines(std::slice::from_ref(&line))));
        }
    }
    if !entry.answer.is_empty() {
        let key = block_key(turn, BlockKind::Answer, "");
        let raw = display.raw.contains(&key);
        let foldable = foldable_source(&entry.answer);
        let folded = entry.folded_answer && foldable && !raw;
        for line in body_lines(&entry.answer, raw, folded, foldable) {
            out.push((LineKind::Answer, flatten_lines(std::slice::from_ref(&line))));
        }
    }
    for error in &entry.errors {
        if error.is_empty() {
            continue;
        }
        out.push((LineKind::Tool, format!("[error] {error}")));
    }
    out
}

pub fn render_turn_text(turn: &TurnView, display: &DisplayState) -> String {
    let entry = NavEntry {
        user: turn.user.clone(),
        thought: turn.thought.clone(),
        answer: turn.answer.clone(),
        tools: turn
            .tools
            .iter()
            .map(|tool| (tool.title.clone(), tool.result.clone()))
            .collect(),
        tool_meta: Vec::new(),
        errors: Vec::new(),
        diffs: Vec::new(),
        folded_thought: false,
        folded_answer: false,
        folded_tools: false,
    };
    let mut lines: Vec<String> = entry_lines(0, &entry, display)
        .into_iter()
        .map(|(_, text)| text)
        .collect();
    if turn.compacted {
        if let Some(info) = &turn.compaction {
            lines.push(info.clone());
        } else {
            lines.push("✂ compacted history into a summary · purpose=compaction".into());
        }
    }
    for tool in &turn.tools {
        if !tool.diff.is_empty() {
            lines.push(sanitize(&tool.diff));
        }
        if !tool.status.is_empty() {
            lines.push(format!("[tool {} {} {}]", tool.title, tool.id, tool.status));
        }
    }
    if let Some(permission) = &turn.permission {
        lines.push(permission.clone());
    }
    if turn.interrupted {
        lines.push("[interrupted]".into());
    } else if turn.cancelled {
        lines.push("[cancelled]".into());
    } else if let Some(error) = &turn.error {
        lines.push(format!("[error] {error}"));
    } else if turn.done
        && turn.answer.is_empty()
        && turn.thought.is_empty()
        && turn.tools.is_empty()
    {
        lines.push("[empty answer]".into());
    } else if !turn.done {
        lines.push("…".into());
    }
    lines.join("\n")
}

pub fn render_transcript(status: &str, turns: &[TurnView], display: &DisplayState) -> String {
    let mut parts = Vec::new();
    if !status.is_empty() {
        parts.push(status.to_string());
    }
    for turn in turns {
        parts.push(render_turn_text(turn, display));
    }
    parts.join("\n\n")
}

pub fn original_block(turn: &TurnView, kind: BlockKind, tool: usize) -> String {
    match kind {
        BlockKind::Thought => turn.thought.clone(),
        BlockKind::Answer => turn.answer.clone(),
        BlockKind::Tool => turn
            .tools
            .get(tool)
            .map(|tool| {
                let mut body = tool.diff.to_string();
                if !tool.result.is_empty() {
                    if !body.is_empty() {
                        body.push('\n');
                    }
                    body.push_str(&tool.result);
                }
                body
            })
            .unwrap_or_default(),
    }
}

pub fn toggle_raw(display: &mut DisplayState, key: &str) {
    if !display.raw.remove(key) {
        display.raw.insert(key.to_string());
    }
}

pub fn last_folded_block(turns: &[TurnView], display: &DisplayState) -> Option<(String, String)> {
    for (turn_index, turn) in turns.iter().enumerate().rev() {
        let candidates = [
            (
                block_key(turn_index, BlockKind::Answer, ""),
                turn.answer.as_str(),
            ),
            (
                block_key(turn_index, BlockKind::Thought, ""),
                turn.thought.as_str(),
            ),
        ];
        for (key, source) in candidates {
            if source.is_empty() || display.expanded_history.contains(&key) {
                continue;
            }
            if foldable_source(source) {
                let rendered = if display.raw.contains(&key) {
                    display_plain(source)
                } else {
                    render_markdown(source)
                };
                return Some((key, rendered));
            }
        }
        for tool in turn.tools.iter().rev() {
            let key = block_key(turn_index, BlockKind::Tool, &tool.title);
            if display.expanded_history.contains(&key) {
                continue;
            }
            if foldable_source(&tool.result) {
                let source = format!("```text\n{}\n```", tool.result.trim_end());
                let rendered = if display.raw.contains(&key) {
                    display_plain(&source)
                } else {
                    render_markdown(&source)
                };
                return Some((key, rendered));
            }
        }
    }
    None
}

pub fn raw_transcript(turns: &[TurnView]) -> String {
    let mut out = String::new();
    for turn in turns {
        out.push_str("## User\n\n");
        out.push_str(&turn.user);
        out.push_str("\n\n");
        if !turn.thought.is_empty() {
            out.push_str("## Thought\n\n");
            out.push_str(&turn.thought);
            out.push_str("\n\n");
        }
        for tool in &turn.tools {
            out.push_str(&format!("## Tool {} ({})\n\n", tool.title, tool.status));
            if !tool.diff.is_empty() {
                out.push_str("```diff\n");
                out.push_str(&tool.diff);
                out.push_str("\n```\n\n");
            }
            if !tool.result.is_empty() {
                out.push_str(&tool.result);
                out.push_str("\n\n");
            }
        }
        if !turn.answer.is_empty() {
            out.push_str("## Answer\n\n");
            out.push_str(&turn.answer);
            out.push_str("\n\n");
        }
        if let Some(error) = &turn.error {
            out.push_str("## Error\n\n");
            out.push_str(error);
            out.push_str("\n\n");
        }
    }
    out
}

pub fn resolve_pager() -> Vec<String> {
    let raw = std::env::var("PAGER")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "less".into());
    raw.split_whitespace().map(str::to_string).collect()
}

pub fn open_transcript_pager(turns: &[TurnView], home: &Path) -> Result<String, String> {
    let pager = resolve_pager();
    let Some((program, args)) = pager.split_first() else {
        return Err("pager failed: empty PAGER".into());
    };
    let dir = home.join("tmp");
    std::fs::create_dir_all(&dir).map_err(|error| format!("pager failed: {error}"))?;
    let path = dir.join(format!("transcript-{}.md", std::process::id()));
    std::fs::write(&path, raw_transcript(turns))
        .map_err(|error| format!("pager failed: {error}"))?;
    let mut command = Command::new(program);
    command.args(args);
    if Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        == Some("less")
        && !args.iter().any(|arg| arg == "-R" || arg == "-r")
    {
        command.arg("-R");
    }
    command.arg(&path);
    let status = command.status();
    let _ = std::fs::remove_file(&path);
    match status {
        Ok(status) if status.success() => Ok("opened in pager".into()),
        Ok(status) => Err(format!(
            "pager failed: {program} exited {}",
            status.code().unwrap_or(1)
        )),
        Err(error) => Err(format!("pager failed: {error}")),
    }
}

pub fn copy_original(original: &str, home: &Path) -> Result<String, String> {
    let dir = home.join("tmp");
    std::fs::create_dir_all(&dir).map_err(|error| format!("copy failed: {error}"))?;
    let path = dir.join("copied-block.md");
    std::fs::write(&path, original.as_bytes()).map_err(|error| format!("copy failed: {error}"))?;
    Ok(format!("copied original {} bytes", original.len()))
}

pub fn expand_last_folded(
    display: &mut DisplayState,
    turns: &[TurnView],
) -> Result<String, String> {
    let Some((key, body)) = last_folded_block(turns, display) else {
        return Err("no folded block to expand".into());
    };
    display.expanded_history.insert(key);
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_eats_markers_tables_and_unclosed_fences() {
        let source = "# Heading\n\nProse with **bold**, *em*, `code`, and a [link](https://example.com).\nGain: <font color=\"green\">GAIN</font> &amp; <b>held</b>\nUnicode: 你好 👩‍💻 café\n\n| 维度 | 内容 |\n|---|---|\n| 一句话 | 单元格 |\n\n```ts\nconst answer = \"text\"\n";
        let rendered = render_markdown(source);
        assert!(rendered.contains("Heading"), "{rendered}");
        assert!(!rendered.contains("**bold**"), "{rendered}");
        assert!(!rendered.contains("`code`"), "{rendered}");
        assert!(!rendered.contains("&amp;"), "{rendered}");
        assert!(
            rendered.contains("GAIN") && rendered.contains("held"),
            "{rendered}"
        );
        assert!(!rendered.contains("|---"), "{rendered}");
        assert!(rendered.contains("维度"), "{rendered}");
        assert!(rendered.contains("const answer = \"text\""), "{rendered}");
        assert!(rendered.contains("unclosed code fence"), "{rendered}");
        assert!(rendered.contains("你好 👩‍💻 café"), "{rendered}");
        assert!(rendered.contains("link"), "{rendered}");
        assert!(
            xai_grok_markdown_core::analyze(source)
                .issues
                .contains(&xai_grok_markdown_core::StructuralIssue::UnterminatedCodeBlock)
        );
        assert!(
            !rendered.contains('<'),
            "pretty markdown must not paint raw html tags: {rendered}"
        );
        let lines = render_markdown_lines(
            "Unicode: 你好 👩‍💻 café\nGain: <font color=\"green\">GAIN</font> <b>held</b>\n",
        );
        let area = ratatui::layout::Rect::new(0, 0, 20, 6);
        let mut buffer = ratatui::buffer::Buffer::empty(area);
        ratatui::widgets::Widget::render(
            ratatui::widgets::Paragraph::new(lines).wrap(ratatui::widgets::Wrap { trim: false }),
            area,
            &mut buffer,
        );
        let mut symbols = Vec::new();
        for row in 0..area.height {
            for column in 0..area.width {
                let symbol = buffer[(column, row)].symbol();
                if symbol != " " {
                    symbols.push(symbol.to_string());
                }
            }
        }
        assert!(
            symbols.iter().any(|symbol| symbol.contains('\u{200d}')),
            "ZWJ emoji must occupy one cell, got {symbols:?}"
        );
        assert!(
            symbols.iter().all(|symbol| symbol != "\u{200d}"),
            "ZWJ must not be its own cell: {symbols:?}"
        );
    }

    #[test]
    fn mermaid_keeps_node_labels() {
        let rendered = render_markdown("```mermaid\ngraph TD\nA[Start] --> B{Decision}\n```");
        assert!(rendered.contains("Start"));
        assert!(rendered.contains("Decision"));
    }

    #[test]
    fn sanitize_strips_control_characters() {
        let cleaned = sanitize("visible\u{0007}\u{001b}[31mred\u{001b}[0m\u{0000}nul 你好 👩‍💻 café");
        assert!(cleaned.contains("visible"));
        assert!(cleaned.contains("red"));
        assert!(cleaned.contains("你好 👩‍💻 café"));
        assert!(!cleaned.contains('\u{0007}'));
        assert!(!cleaned.contains('\0'));
        assert!(!cleaned.contains('\u{001b}'));
    }

    #[test]
    fn fold_hides_tail_until_expanded() {
        let huge = (1..=80)
            .map(|i| format!("HUGE_LINE_{i:03}_MARKER"))
            .collect::<Vec<_>>()
            .join("\n");
        let (preview, folded, hidden) = preview_lines(&huge, TOOL_PREVIEW_LINES);
        assert!(folded);
        assert_eq!(hidden, 68);
        assert!(preview.contains("HUGE_LINE_001_MARKER"));
        assert!(!preview.contains("HUGE_LINE_080_MARKER"));
        assert!(preview.contains("folded"));
    }

    #[test]
    fn raw_transcript_is_independent_of_fold_state() {
        let turn = TurnView {
            user: "TOKEN".into(),
            thought: String::new(),
            answer: "**bold**".into(),
            error: Some("tool t1 failed".into()),
            tools: vec![ToolView {
                id: "t1".into(),
                title: "read".into(),
                status: "failed".into(),
                diff: "read missing.txt".into(),
                result: "cannot read".into(),
            }],
            permission: None,
            done: true,
            cancelled: false,
            interrupted: false,
            compacted: false,
            compaction: None,
        };
        let markdown = raw_transcript(std::slice::from_ref(&turn));
        assert!(markdown.contains("**bold**"));
        assert!(markdown.contains("cannot read"));
        assert!(markdown.contains("failed"));
        assert!(!markdown.contains("successfully"));
        let dir = tempfile::tempdir().unwrap();
        let original = original_block(&turn, BlockKind::Tool, 0);
        let copied = copy_original(&original, dir.path()).unwrap();
        assert!(copied.contains("copied original"));
        let bytes = std::fs::read_to_string(dir.path().join("tmp/copied-block.md")).unwrap();
        assert_eq!(bytes, "read missing.txt\ncannot read");
        let painted = render_transcript("", std::slice::from_ref(&turn), &DisplayState::default());
        assert!(painted.contains("[error] tool t1 failed"), "{painted}");
        assert!(painted.contains("failed"), "{painted}");
        assert!(!painted.contains("successfully"), "{painted}");
    }

    #[test]
    fn fold_and_raw_do_not_rewrite_original_bytes() {
        let huge = (1..=20)
            .map(|index| format!("HUGE_LINE_{index:03}_MARKER"))
            .collect::<Vec<_>>()
            .join("\n");
        let turn = TurnView {
            user: "TOKEN".into(),
            thought: String::new(),
            answer: String::new(),
            error: None,
            tools: vec![ToolView {
                id: "t1".into(),
                title: "read".into(),
                status: "completed".into(),
                diff: String::new(),
                result: huge.clone(),
            }],
            permission: None,
            done: true,
            cancelled: false,
            interrupted: false,
            compacted: false,
            compaction: None,
        };
        let entry = NavEntry {
            user: turn.user.clone(),
            thought: String::new(),
            answer: String::new(),
            tools: vec![("read".into(), huge.clone())],
            tool_meta: Vec::new(),
            errors: Vec::new(),
            diffs: Vec::new(),
            folded_thought: false,
            folded_answer: false,
            folded_tools: true,
        };
        let folded = entry_lines(0, &entry, &DisplayState::default());
        let painted = folded
            .iter()
            .map(|(_, text)| text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(painted.contains("HUGE_LINE_001_MARKER"), "{painted}");
        assert!(!painted.contains("HUGE_LINE_020_MARKER"), "{painted}");
        assert!(painted.contains("folded"), "{painted}");
        assert_eq!(original_block(&turn, BlockKind::Tool, 0), huge);
        assert!(raw_transcript(std::slice::from_ref(&turn)).contains("HUGE_LINE_020_MARKER"));
    }
}
