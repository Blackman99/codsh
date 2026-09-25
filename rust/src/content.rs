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

fn line_text(line: &Line<'_>) -> String {
    line.spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect()
}

fn flatten_lines(lines: &[Line<'_>]) -> String {
    lines.iter().map(line_text).collect::<Vec<_>>().join("\n")
}

/// Failed and error labels stay distinct from a completed tool. Success is
/// not a color; these two are, so a green status cannot hide a failure.
fn color_status_label(lines: &mut [Line<'static>], label: &str) {
    let painted = status_span(label);
    for line in lines {
        let mut next = Vec::with_capacity(line.spans.len());
        for span in line.spans.drain(..) {
            let text = span.content.as_ref();
            if let Some(at) = text.find(label) {
                if at > 0 {
                    next.push(Span::styled(text[..at].to_string(), span.style));
                }
                next.push(Span::styled(label.to_string(), painted.style));
                let after = at + label.len();
                if after < text.len() {
                    next.push(Span::styled(text[after..].to_string(), span.style));
                }
            } else {
                next.push(span);
            }
        }
        line.spans = next;
    }
}

pub fn status_span(text: &str) -> Span<'static> {
    let lower = text.to_ascii_lowercase();
    let style = if lower.contains("failed") || lower.contains("[error]") || lower.contains("error")
    {
        ratatui::style::Style::default().fg(ratatui::style::Color::Rgb(247, 118, 142))
    } else if lower.contains("successfully") || lower.contains("completed") {
        ratatui::style::Style::default().fg(ratatui::style::Color::Rgb(158, 206, 106))
    } else {
        ratatui::style::Style::default()
    };
    Span::styled(text.to_string(), style)
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
/// Styles stay on the spans so the session painter can emit them.
pub fn entry_lines(
    turn: usize,
    entry: &NavEntry,
    display: &DisplayState,
) -> Vec<(LineKind, Line<'static>)> {
    let mut out = Vec::new();
    out.push((
        LineKind::User,
        Line::from(format!("> {}", entry.user.replace('\n', " "))),
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
            out.push((LineKind::Thought, line));
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
            status_line.clone()
        } else {
            format!("{status_line}\n{result}")
        };
        let foldable = foldable_source(result);
        let folded = entry.folded_tools && foldable;
        let mut lines = prefix_first(
            body_lines(&source, raw, folded, foldable),
            &format!("[tool {title}] "),
        );
        if !status.is_empty() && !status_line.is_empty() {
            color_status_label(&mut lines, &status_line);
        }
        for line in lines {
            out.push((LineKind::Tool, line));
        }
    }
    if !entry.answer.is_empty() {
        let key = block_key(turn, BlockKind::Answer, "");
        let raw = display.raw.contains(&key);
        let foldable = foldable_source(&entry.answer);
        let folded = entry.folded_answer && foldable && !raw;
        for line in body_lines(&entry.answer, raw, folded, foldable) {
            out.push((LineKind::Answer, line));
        }
    }
    for error in &entry.errors {
        if error.is_empty() {
            continue;
        }
        out.push((
            LineKind::Tool,
            Line::from(status_span(&format!("[error] {error}"))),
        ));
    }
    if let Some(sentence) = entry.compaction.as_ref().filter(|text| !text.is_empty()) {
        out.push((LineKind::Tool, Line::from(sentence.clone())));
    }
    // Interrupted wins over cancelled, an already-painted error, an empty
    // answer, and a still-open turn. Do not infer interrupted from a tool
    // status of unknown: that status is a separate fact.
    let marker = if entry.interrupted {
        Some("[interrupted]".to_string())
    } else if entry.cancelled {
        Some("[cancelled]".to_string())
    } else if entry.done
        && entry.errors.is_empty()
        && entry.answer.is_empty()
        && entry.thought.is_empty()
        && entry.tools.is_empty()
    {
        Some("[empty answer]".to_string())
    } else if !entry.done {
        Some("…".to_string())
    } else {
        None
    };
    if let Some(marker) = marker {
        out.push((LineKind::Tool, Line::from(marker)));
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
        // Status lines stay here, after the body. `entry_lines` would also
        // paint them from `tool_meta`, so leave that empty and avoid a second copy.
        tool_meta: Vec::new(),
        errors: turn.error.iter().cloned().collect(),
        diffs: Vec::new(),
        interrupted: turn.interrupted,
        cancelled: turn.cancelled,
        done: turn.done,
        compaction: if turn.compacted {
            Some(turn.compaction.clone().unwrap_or_else(|| {
                "✂ compacted history into a summary · purpose=compaction".into()
            }))
        } else {
            None
        },
        folded_thought: false,
        folded_answer: false,
        folded_tools: false,
    };
    let marker_added = entry.interrupted
        || entry.cancelled
        || (entry.done
            && entry.errors.is_empty()
            && entry.answer.is_empty()
            && entry.thought.is_empty()
            && entry.tools.is_empty())
        || !entry.done;
    let mut lines: Vec<String> = entry_lines(0, &entry, display)
        .into_iter()
        .map(|(_, line)| line_text(&line))
        .collect();
    // Diffs and the extra status lines stay outside `entry_lines`. The
    // terminal marker still has to be the last line.
    let marker = if marker_added { lines.pop() } else { None };
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
    if let Some(marker) = marker {
        lines.push(marker);
    }
    lines.join("\n")
}

/// One screen line for a finished shell. `None` while it is still running
/// or the body is not a shell result. A marker dsh already printed wins, so
/// this does not invent a second code.
pub fn shell_exit_line(title: &str, result: &str, status: &str) -> Option<String> {
    if !is_shell_tool(title) || result.is_empty() {
        return None;
    }
    if result.contains("[exit code:") || result.contains("[killed by signal:") {
        return None;
    }
    // A command moved to the background has not exited; its completion
    // arrives later as its own notice.
    if crate::background::mentions_background(result) {
        return None;
    }
    if result.contains("[timed out after") {
        return Some("[exit timed out]".into());
    }
    match status {
        "completed" => Some("[exit code: 0]".into()),
        "failed" => Some("[exit failed]".into()),
        "cancelled" => Some("[exit cancelled]".into()),
        _ => None,
    }
}

pub fn is_shell_tool(title: &str) -> bool {
    matches!(
        title,
        "bash" | "run_terminal_cmd" | "run_terminal_command" | "terminal_send" | "terminal_open"
    )
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
            rendered.contains("<font color=\"green\">")
                && rendered.contains("GAIN")
                && rendered.contains("</font>")
                && rendered.contains("<b>")
                && rendered.contains("held")
                && rendered.contains("</b>"),
            "official pretty mode keeps inline tags and the text they wrap: {rendered}"
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

    /// Official pretty mode keeps generic and comparison brackets. A pass that
    /// deletes every `<`…`>` pair turns `Vec<T>` into `Vec` and `a < b && c > d`
    /// into `a  d`, including inside a fence.
    #[test]
    fn pretty_keeps_generics_and_comparisons_like_official_markdown() {
        let prose = "Use Vec<T> when a < b && c > d.\n";
        let fence = "```rust\nfn f<T>(v: Vec<T>) -> bool { a < b && c > d }\n```\n";
        let official = |source: &str| {
            let (lines, _) = xai_grok_markdown::render_markdown_ratatui(
                source,
                pretty_markdown_style(),
                true,
                Some(syntect()),
            );
            flatten_lines(&lines)
        };
        for source in [prose, fence] {
            let rendered = render_markdown(source);
            let expected = official(source);
            assert!(
                rendered.contains("Vec<T>"),
                "generic brackets must survive pretty mode:\n{rendered}"
            );
            assert!(
                rendered.contains("a < b && c > d"),
                "comparison brackets must survive pretty mode:\n{rendered}"
            );
            assert_eq!(
                rendered, expected,
                "pretty output must match official markdown for {source:?}"
            );
        }
        let lines = render_markdown_lines(fence);
        let width = 80;
        let height = (lines.len() + 2) as u16;
        let area = ratatui::layout::Rect::new(0, 0, width, height);
        let mut buffer = ratatui::buffer::Buffer::empty(area);
        ratatui::widgets::Widget::render(
            ratatui::widgets::Paragraph::new(lines).wrap(ratatui::widgets::Wrap { trim: false }),
            area,
            &mut buffer,
        );
        let painted = (0..area.height)
            .map(|row| {
                (0..area.width)
                    .map(|column| buffer[(column, row)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            painted.contains("Vec<T>"),
            "painted cells must keep generic brackets:\n{painted}"
        );
        assert!(
            painted.contains("a < b && c > d"),
            "painted cells must keep comparison brackets:\n{painted}"
        );
    }

    #[test]
    fn shell_exit_is_visible_and_not_invented_twice() {
        assert_eq!(
            shell_exit_line("bash", "STDOUT\n", "completed").as_deref(),
            Some("[exit code: 0]")
        );
        assert_eq!(
            shell_exit_line("bash", "STDOUT\n[exit code: 7]\n", "completed"),
            None
        );
        assert_eq!(
            shell_exit_line(
                "bash",
                "partial\n[killed by signal: SIGTERM]\n",
                "completed"
            ),
            None
        );
        assert_eq!(
            shell_exit_line("bash", "partial\n[timed out after 1000ms]\n", "completed").as_deref(),
            Some("[exit timed out]")
        );
        assert_eq!(
            shell_exit_line("bash", "Error: denied\n", "failed").as_deref(),
            Some("[exit failed]")
        );
        assert_eq!(shell_exit_line("bash", "", "completed"), None);
        assert_eq!(
            shell_exit_line(
                "bash",
                "[Command moved to background]\nUser moved command \"sleep 9\" to background. Process is still running.\n",
                "completed"
            ),
            None,
            "a moved command has not exited"
        );
        assert_eq!(
            shell_exit_line("bash", "started background job bash-1", "completed"),
            None
        );
        assert_eq!(shell_exit_line("read", "hello\n", "completed"), None);
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
        // The copy itself goes through crate::clipboard (ticket 155).
        let original = original_block(&turn, BlockKind::Tool, 0);
        assert_eq!(original, "read missing.txt\ncannot read");
        let painted = render_transcript("", std::slice::from_ref(&turn), &DisplayState::default());
        assert!(painted.contains("[error] tool t1 failed"), "{painted}");
        assert!(painted.contains("failed"), "{painted}");
        assert!(!painted.contains("successfully"), "{painted}");
    }

    #[test]
    fn pretty_lines_keep_heading_code_and_failure_colors() {
        let lines = render_markdown_lines(
            "# Heading\n\n`code` and a table\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
        );
        let colored = lines
            .iter()
            .any(|line| line.spans.iter().any(|span| span.style.fg.is_some()));
        assert!(colored, "official styles must survive as span colors");
        let failed = status_span("failed");
        assert!(
            failed.style.fg.is_some(),
            "a failed tool status is not plain text"
        );
        let error = status_span("[error] tool t1 failed");
        assert!(error.style.fg.is_some(), "an error line is not plain text");
        let ok = status_span("successfully.");
        assert_ne!(
            failed.style.fg, ok.style.fg,
            "failure must not reuse the success color"
        );
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
            interrupted: false,
            cancelled: false,
            done: true,
            compaction: None,
            folded_thought: false,
            folded_answer: false,
            folded_tools: true,
        };
        let folded = entry_lines(0, &entry, &DisplayState::default());
        let painted = folded
            .iter()
            .map(|(_, line)| line_text(line))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(painted.contains("HUGE_LINE_001_MARKER"), "{painted}");
        assert!(!painted.contains("HUGE_LINE_020_MARKER"), "{painted}");
        assert!(painted.contains("folded"), "{painted}");
        assert_eq!(original_block(&turn, BlockKind::Tool, 0), huge);
        assert!(raw_transcript(std::slice::from_ref(&turn)).contains("HUGE_LINE_020_MARKER"));
    }

    fn marker_view(
        interrupted: bool,
        cancelled: bool,
        done: bool,
        error: Option<&str>,
        tools: Vec<ToolView>,
        compacted: bool,
        compaction: Option<&str>,
    ) -> TurnView {
        TurnView {
            user: "TOKEN_CRASH_EDIT".into(),
            thought: String::new(),
            answer: String::new(),
            error: error.map(str::to_string),
            tools,
            permission: None,
            done,
            cancelled,
            interrupted,
            compacted,
            compaction: compaction.map(str::to_string),
        }
    }

    #[test]
    fn terminal_markers_keep_priority_and_compaction_order() {
        let interrupted = marker_view(true, false, true, None, Vec::new(), false, None);
        let cancelled = marker_view(false, true, true, None, Vec::new(), false, None);
        let failed = marker_view(
            false,
            false,
            true,
            Some("tool t1 failed"),
            Vec::new(),
            false,
            None,
        );
        let empty = marker_view(false, false, true, None, Vec::new(), false, None);
        let display = DisplayState::default();
        let interrupted_text = render_turn_text(&interrupted, &display);
        let cancelled_text = render_turn_text(&cancelled, &display);
        let failed_text = render_turn_text(&failed, &display);
        let empty_text = render_turn_text(&empty, &display);
        assert!(
            interrupted_text.ends_with("[interrupted]"),
            "{interrupted_text}"
        );
        assert!(cancelled_text.ends_with("[cancelled]"), "{cancelled_text}");
        assert!(
            failed_text.contains("[error] tool t1 failed"),
            "{failed_text}"
        );
        assert!(
            !failed_text.contains("[interrupted]") && !failed_text.contains("[empty answer]"),
            "{failed_text}"
        );
        assert!(empty_text.ends_with("[empty answer]"), "{empty_text}");

        let both = marker_view(
            true,
            false,
            true,
            Some("disconnect"),
            Vec::new(),
            false,
            None,
        );
        let both_text = render_turn_text(&both, &display);
        assert!(both_text.contains("[error] disconnect"), "{both_text}");
        assert!(both_text.ends_with("[interrupted]"), "{both_text}");
        assert_eq!(both_text.matches("[error]").count(), 1, "{both_text}");

        let sentence = "✂ compacted 4 history items (~210 tokens) into a summary · cli-mock/cli-mock purpose=compaction";
        let compact = marker_view(true, false, true, None, Vec::new(), true, Some(sentence));
        let compact_text = render_turn_text(&compact, &display);
        let compact_at = compact_text.find(sentence).expect("compaction sentence");
        let marker_at = compact_text.rfind("[interrupted]").expect("marker");
        assert!(compact_at < marker_at, "{compact_text}");
        assert!(compact_text.ends_with("[interrupted]"), "{compact_text}");

        let open = marker_view(false, false, false, None, Vec::new(), false, None);
        let open_text = render_turn_text(&open, &display);
        assert!(open_text.ends_with('…'), "{open_text}");
        assert!(!open_text.contains("[empty answer]"), "{open_text}");
    }
}
