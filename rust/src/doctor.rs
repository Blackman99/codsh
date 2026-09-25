//! `codsh --rust doctor` and `/doctor` (ticket 155): terminal diagnostics.
//!
//! The report lists detected facts (human and JSON). The only fixes edit
//! the user's tmux config, need explicit confirmation, keep a backup and
//! print the undo command. codsh never runs `tmux source-file` itself.

use crate::clipboard::{self, CopyContext};
use crate::terminal_env::{Brand, EnvMap, Multiplexer, non_empty, which};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const SCHEMA: &str = "codsh.doctor.v1";

/// Things this build has not been run against; reported with every doctor
/// output so a clean report is never read as "verified everywhere".
pub const UNVERIFIED: &[&str] = &[
    "macOS pbcopy and Windows clip.exe native clipboard legs (only Linux fake tools are tested)",
    "real terminals: iTerm2, Kitty, Ghostty, WezTerm, Alacritty, Apple Terminal, Windows Terminal, VS Code/Cursor/Zed terminals",
    "OSC 52 acceptance by a real terminal or by tmux set-clipboard/allow-passthrough",
    "real SSH sessions through `codsh --rust wrap ssh ...`",
    "Wayland wl-copy and X11 xclip/xsel on a real display server",
    "desktop notification display for OSC 9/99/777 (only emitted bytes are tested)",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixKind {
    /// `set <flags> <option> <value>`; existing direct assignments are checked.
    Set {
        option: &'static str,
        accepted: &'static [&'static str],
    },
    /// `set -as terminal-features ",*:RGB"`; present if any line already appends RGB.
    AppendRgb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TmuxFix {
    pub id: &'static str,
    pub line: &'static str,
    pub kind: FixKind,
    pub summary: &'static str,
}

pub const TMUX_FIXES: &[TmuxFix] = &[
    TmuxFix {
        id: "terminal.tmux-clipboard",
        line: "set -g set-clipboard on",
        kind: FixKind::Set {
            option: "set-clipboard",
            accepted: &["on"],
        },
        summary: "let programs inside tmux set the outer clipboard with OSC 52",
    },
    TmuxFix {
        id: "terminal.dcs-passthrough",
        line: "set -wg allow-passthrough on",
        kind: FixKind::Set {
            option: "allow-passthrough",
            accepted: &["on", "all"],
        },
        summary: "let OSC 52 and notification sequences pass through tmux (tmux >= 3.3)",
    },
    TmuxFix {
        id: "terminal.tmux-extended-keys",
        line: "set -g extended-keys on",
        kind: FixKind::Set {
            option: "extended-keys",
            accepted: &["on", "always"],
        },
        summary: "forward Shift+Enter and other modified keys through tmux",
    },
    TmuxFix {
        id: "terminal.tmux-truecolor",
        line: "set -as terminal-features \",*:RGB\"",
        kind: FixKind::AppendRgb,
        summary: "advertise 24-bit color through tmux",
    },
];

pub fn fix_by_id(id: &str) -> Option<&'static TmuxFix> {
    TMUX_FIXES.iter().find(|fix| fix.id == id)
}

#[derive(Debug, Clone)]
pub struct Finding {
    pub id: &'static str,
    pub severity: &'static str,
    pub title: String,
    pub detail: String,
    pub fixable: bool,
}

#[derive(Debug, Clone)]
pub struct Report {
    pub facts: Vec<(String, String)>,
    pub json_facts: Map<String, Value>,
    pub findings: Vec<Finding>,
}

/// Reads one tmux value; `None` when tmux is absent or the option unknown.
pub type TmuxProbe<'a> = &'a dyn Fn(&[&str]) -> Option<String>;

pub fn live_tmux_probe(env: &EnvMap) -> impl Fn(&[&str]) -> Option<String> + '_ {
    move |args: &[&str]| {
        let tmux = which(env, "tmux")?;
        let mut child = Command::new(tmux)
            .args(args)
            .env_clear()
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return None;
                    }
                    let mut out = String::new();
                    use std::io::Read;
                    child.stdout.take()?.read_to_string(&mut out).ok()?;
                    return Some(out.trim().to_string());
                }
                Ok(None) if started.elapsed() > Duration::from_secs(2) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(_) => return None,
            }
        }
    }
}

fn fact(report: &mut Report, key: &str, human: &str, value: Value) {
    let shown = match &value {
        Value::String(text) => text.clone(),
        Value::Null => "unknown".into(),
        other => other.to_string(),
    };
    report.facts.push((human.to_string(), shown));
    report.json_facts.insert(key.to_string(), value);
}

/// Shift+Enter reaches the app natively (kitty keyboard protocol or CSI-u).
fn shift_enter_native(brand: Brand) -> bool {
    matches!(
        brand,
        Brand::Kitty
            | Brand::Ghostty
            | Brand::WezTerm
            | Brand::Foot
            | Brand::Alacritty
            | Brand::Iterm2
    )
}

pub fn collect(ctx: &CopyContext, notifications: &str, probe: TmuxProbe) -> Report {
    let term = &ctx.term;
    let env = &ctx.env;
    let mut report = Report {
        facts: Vec::new(),
        json_facts: Map::new(),
        findings: Vec::new(),
    };
    fact(&mut report, "os", "OS", json!(term.host_os.label()));
    fact(
        &mut report,
        "terminal",
        "Terminal",
        json!(format!("{} ({})", term.brand.label(), term.brand_source)),
    );
    report
        .json_facts
        .insert("terminalId".into(), json!(term.brand.id()));
    fact(&mut report, "term", "TERM", json!(term.term));
    fact(&mut report, "colorterm", "COLORTERM", json!(term.colorterm));
    fact(
        &mut report,
        "color",
        "Color depth",
        json!(term.color.label()),
    );
    fact(
        &mut report,
        "multiplexer",
        "Multiplexer",
        json!(term.multiplexer.label()),
    );
    fact(&mut report, "remote", "SSH session", json!(term.remote));
    fact(&mut report, "container", "Container", json!(term.container));
    fact(
        &mut report,
        "display",
        "Display server",
        json!(term.display.label()),
    );
    fact(
        &mut report,
        "wrapSink",
        "codsh wrap sink",
        json!(term.osc52_sink),
    );
    let newline = if shift_enter_native(term.brand) {
        "Shift+Enter or Alt+Enter inserts a newline"
    } else {
        "Alt+Enter (Option+Enter) inserts a newline; Shift+Enter depends on the terminal"
    };
    fact(&mut report, "newline", "Newline key", json!(newline));
    let plan = clipboard::plan(ctx);
    let routes = clipboard::plan_json(ctx, &plan);
    report.facts.push((
        "Clipboard native".into(),
        format!(
            "{}{}",
            plan.native_note,
            if plan.native_trusted {
                " (trusted)"
            } else {
                ""
            }
        ),
    ));
    report
        .facts
        .push(("Clipboard tmux".into(), plan.tmux_note.clone()));
    report.facts.push((
        "Clipboard OSC 52".into(),
        format!(
            "{} — {}",
            if plan.osc52 { "enabled" } else { "off" },
            plan.osc52_note
        ),
    ));
    report
        .facts
        .push(("Copy backup file".into(), plan.backup.display().to_string()));
    let expected = clipboard::expected_delivery(ctx, &plan);
    report
        .facts
        .push(("Expected copy result".into(), expected.label().to_string()));
    report.json_facts.insert("clipboard".into(), routes);
    fact(
        &mut report,
        "notifications",
        "Notifications",
        json!(notifications),
    );

    let tmux = term.tmux_backed(env);
    if tmux {
        let version = probe(&["-V"]);
        fact(&mut report, "tmuxVersion", "tmux version", json!(version));
        let read = |args: &[&str]| probe(args);
        let clipboard_value = read(&["show-options", "-gv", "set-clipboard"]);
        let passthrough = read(&["show-options", "-gwv", "allow-passthrough"]);
        let extended = read(&["show-options", "-gv", "extended-keys"]);
        let features = read(&["show-options", "-gv", "terminal-features"]);
        let overrides = read(&["show-options", "-gv", "terminal-overrides"]);
        let mut tmux_facts = Map::new();
        for (name, value) in [
            ("set-clipboard", &clipboard_value),
            ("allow-passthrough", &passthrough),
            ("extended-keys", &extended),
            ("terminal-features", &features),
        ] {
            tmux_facts.insert(name.into(), json!(value));
            report.facts.push((
                format!("tmux {name}"),
                value.clone().unwrap_or_else(|| "unreadable".into()),
            ));
        }
        report
            .json_facts
            .insert("tmuxOptions".into(), Value::Object(tmux_facts));
        let checks: [(&str, &Option<String>, &[&str], &str); 3] = [
            (
                "terminal.tmux-clipboard",
                &clipboard_value,
                &["on"],
                "tmux set-clipboard is not `on`; OSC 52 copies from codsh may not reach your clipboard",
            ),
            (
                "terminal.dcs-passthrough",
                &passthrough,
                &["on", "all"],
                "tmux allow-passthrough is off; wrapped OSC 52 and notifications are dropped",
            ),
            (
                "terminal.tmux-extended-keys",
                &extended,
                &["on", "always"],
                "tmux extended-keys is off; Shift+Enter arrives as plain Enter",
            ),
        ];
        for (id, value, accepted, title) in checks {
            let severity = if id == "terminal.tmux-extended-keys" {
                "info"
            } else {
                "warn"
            };
            match value {
                Some(value) if accepted.contains(&value.as_str()) => {}
                Some(value) => report.findings.push(Finding {
                    id,
                    severity,
                    title: title.into(),
                    detail: format!(
                        "current value: {value}. Fix: `codsh --rust doctor fix {id}` appends `{}`",
                        fix_by_id(id).map(|fix| fix.line).unwrap_or("")
                    ),
                    fixable: true,
                }),
                None => report.findings.push(Finding {
                    id,
                    severity: "info",
                    title: format!("could not read this tmux option ({title})"),
                    detail: format!(
                        "tmux may be too old or unreachable. `codsh --rust doctor fix {id}` can still add the setting"
                    ),
                    fixable: true,
                }),
            }
        }
        let rgb = [&features, &overrides].iter().any(|value| {
            value
                .as_deref()
                .is_some_and(|text| text.contains("RGB") || text.contains("Tc"))
        });
        if !rgb {
            report.findings.push(Finding {
                id: "terminal.tmux-truecolor",
                severity: "info",
                title: "tmux does not advertise 24-bit color (no RGB/Tc terminal feature)".into(),
                detail: "Fix: `codsh --rust doctor fix terminal.tmux-truecolor` appends `set -as terminal-features \",*:RGB\"`".into(),
                fixable: true,
            });
        }
    }
    if matches!(term.multiplexer, Multiplexer::Screen)
        || (term.multiplexer == Multiplexer::Byobu && !tmux)
    {
        report.findings.push(Finding {
            id: "terminal.byobu-screen",
            severity: "warn",
            title: "GNU screen (or byobu's screen backend) usually drops OSC 52".into(),
            detail: "copies fall back to the backup file; use tmux with set-clipboard on, or copy from the backup file".into(),
            fixable: false,
        });
    }
    if term.remote && !term.osc52_sink {
        report.findings.push(Finding {
            id: "terminal.ssh-wrap",
            severity: "info",
            title: "SSH session without codsh wrap".into(),
            detail: "on your local machine run `codsh --rust wrap ssh <host>` so OSC 52 copies land in your local clipboard and the terminal is restored if the connection drops".into(),
            fixable: false,
        });
    }
    if term.brand.is_editor_terminal() {
        report.findings.push(Finding {
            id: "terminal.newline-fallback",
            severity: "info",
            title: format!("{} may send Shift+Enter as plain Enter", term.brand.label()),
            detail: "use Alt+Enter (Option+Enter) for a newline, or bind Shift+Enter to send \"\\u001b\\r\" in the editor's keybindings".into(),
            fixable: false,
        });
    }
    if term.brand == Brand::Iterm2 {
        report.findings.push(Finding {
            id: "terminal.iterm2-clipboard-permission",
            severity: "info",
            title: "iTerm2 only accepts OSC 52 when \"Applications in terminal may access clipboard\" is enabled".into(),
            detail: "iTerm2 → Settings → General → Selection; codsh reports OSC 52 copies here as unconfirmed".into(),
            fixable: false,
        });
    }
    if term.brand == Brand::WezTerm {
        report.findings.push(Finding {
            id: "terminal.wezterm-kitty",
            severity: "info",
            title: "WezTerm reports Shift+Enter only with the kitty keyboard protocol".into(),
            detail:
                "set `config.enable_kitty_keyboard = true` in wezterm.lua (codsh does not edit it)"
                    .into(),
            fixable: false,
        });
    }
    if expected == clipboard::Delivery::Unreachable {
        report.findings.push(Finding {
            id: "clipboard.unreachable",
            severity: "warn",
            title: "no clipboard route is expected to work here".into(),
            detail: format!(
                "copies are still written to {} (set GROK_COPY_FILE to move it)",
                plan.backup.display()
            ),
            fixable: false,
        });
    }
    report
}

pub fn render_text(report: &Report) -> String {
    let mut out = String::from("codsh doctor — terminal diagnostics\n\nDetected:\n");
    let width = report
        .facts
        .iter()
        .map(|(key, _)| key.chars().count())
        .max()
        .unwrap_or(0);
    for (key, value) in &report.facts {
        out.push_str(&format!("  {key:width$}  {value}\n"));
    }
    out.push('\n');
    if report.findings.is_empty() {
        out.push_str("Findings: none\n");
    } else {
        out.push_str("Findings:\n");
        for finding in &report.findings {
            out.push_str(&format!(
                "  [{}] {} — {}\n      {}\n",
                finding.severity, finding.id, finding.title, finding.detail
            ));
        }
        if report.findings.iter().any(|finding| finding.fixable) {
            out.push_str(
                "\n  Fixes edit your tmux config only after confirmation (`doctor fix <id>` shows the plan; add --yes to apply).\n",
            );
        }
    }
    out.push_str("\nNot verified by this build:\n");
    for item in UNVERIFIED {
        out.push_str(&format!("  - {item}\n"));
    }
    out
}

pub fn render_json(report: &Report) -> Value {
    json!({
        "schema": SCHEMA,
        "facts": Value::Object(report.json_facts.clone()),
        "findings": report.findings.iter().map(|finding| json!({
            "id": finding.id,
            "severity": finding.severity,
            "title": finding.title,
            "detail": finding.detail,
            "fixable": finding.fixable,
        })).collect::<Vec<_>>(),
        "unverified": UNVERIFIED,
    })
}

// ---------------------------------------------------------------- fixes

/// Which tmux config file fixes edit.
pub fn tmux_conf_path(ctx: &CopyContext) -> Result<PathBuf, String> {
    if ctx.term.multiplexer == Multiplexer::Byobu {
        return match non_empty(&ctx.env, "BYOBU_CONFIG_DIR") {
            Some(dir) => Ok(Path::new(dir).join(".tmux.conf")),
            None => Err(
                "byobu detected but BYOBU_CONFIG_DIR is unset; refusing to guess which tmux config byobu reads"
                    .into(),
            ),
        };
    }
    match crate::terminal_env::user_home(&ctx.env) {
        Some(home) => Ok(home.join(".tmux.conf")),
        None => Err("HOME is unset; refusing to guess where ~/.tmux.conf is".into()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineState {
    Missing,
    Present(usize),
    Conflict(usize, String),
    Ambiguous(usize),
}

fn strip_quotes(value: &str) -> &str {
    value.trim_matches(|ch| ch == '"' || ch == '\'')
}

/// Inspect an existing config for the fix's option.
pub fn inspect(content: &str, fix: &TmuxFix) -> LineState {
    let mut state = LineState::Missing;
    for (index, raw) in content.lines().enumerate() {
        let number = index + 1;
        let line = raw.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let command = tokens.first().copied().unwrap_or("");
        let simple = matches!(command, "set" | "set-option" | "setw" | "set-window-option");
        match fix.kind {
            FixKind::Set { option, accepted } => {
                if !line.contains(option) {
                    continue;
                }
                if !simple {
                    return LineState::Ambiguous(number);
                }
                let rest: Vec<&str> = tokens[1..]
                    .iter()
                    .copied()
                    .skip_while(|token| token.starts_with('-'))
                    .collect();
                if rest.first().copied() != Some(option) {
                    return LineState::Ambiguous(number);
                }
                let value = rest.get(1).map(|value| strip_quotes(value)).unwrap_or("");
                if accepted.contains(&value) {
                    state = LineState::Present(number);
                } else {
                    // A later conflicting line would override ours only if it
                    // came after; any conflicting direct assignment is refused.
                    return LineState::Conflict(number, value.to_string());
                }
            }
            FixKind::AppendRgb => {
                if line.contains("terminal-features") || line.contains("terminal-overrides") {
                    if !simple {
                        return LineState::Ambiguous(number);
                    }
                    if line.contains("RGB") || line.contains(":Tc") {
                        state = LineState::Present(number);
                    }
                }
            }
        }
    }
    state
}

#[derive(Debug, Clone)]
pub struct FixPlan {
    pub path: PathBuf,
    pub exists: bool,
    pub to_add: Vec<&'static TmuxFix>,
    pub already: Vec<(&'static TmuxFix, usize)>,
    pub refused: Vec<(&'static TmuxFix, String)>,
}

pub fn plan_fixes(ctx: &CopyContext, ids: &[&'static TmuxFix]) -> Result<FixPlan, String> {
    let path = tmux_conf_path(ctx)?;
    let meta = std::fs::symlink_metadata(&path).ok();
    let exists = meta.is_some();
    if meta
        .as_ref()
        .is_some_and(|meta| meta.file_type().is_symlink())
    {
        return Err(format!(
            "{} is a symlink; refusing to edit it (edit the target yourself)",
            path.display()
        ));
    }
    let content = if exists {
        std::fs::read_to_string(&path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?
    } else {
        String::new()
    };
    let mut plan = FixPlan {
        path,
        exists,
        to_add: Vec::new(),
        already: Vec::new(),
        refused: Vec::new(),
    };
    for fix in ids {
        match inspect(&content, fix) {
            LineState::Missing => plan.to_add.push(fix),
            LineState::Present(line) => plan.already.push((fix, line)),
            LineState::Conflict(line, value) => plan.refused.push((
                fix,
                format!("line {line} already sets it to `{value}`; edit that line yourself"),
            )),
            LineState::Ambiguous(line) => plan.refused.push((
                fix,
                format!("line {line} mentions it in a form codsh cannot safely rewrite"),
            )),
        }
    }
    Ok(plan)
}

pub fn render_plan(plan: &FixPlan) -> String {
    let mut out = format!("tmux config: {}\n", plan.path.display());
    for fix in &plan.to_add {
        out.push_str(&format!(
            "  + {}   # {} ({})\n",
            fix.line, fix.id, fix.summary
        ));
    }
    for (fix, line) in &plan.already {
        out.push_str(&format!("  = {} already set on line {line}\n", fix.id));
    }
    for (fix, reason) in &plan.refused {
        out.push_str(&format!("  ! {} refused: {reason}\n", fix.id));
    }
    if !plan.to_add.is_empty() {
        if plan.exists {
            out.push_str("  A backup copy is written next to the file before any change.\n");
        } else {
            out.push_str("  The file does not exist yet and would be created.\n");
        }
    }
    out
}

/// Apply a plan. Returns the human outcome; the caller already confirmed.
pub fn apply(plan: &FixPlan, stamp: u64) -> Result<String, String> {
    if plan.to_add.is_empty() {
        let mut out = String::from("Nothing to change.\n");
        if !plan.already.is_empty() {
            out.push_str(&format!(
                "Settings are in the file; if tmux does not show them yet, reload it yourself: tmux source-file '{}'\n",
                plan.path.display()
            ));
        }
        return Ok(out);
    }
    let existing = if plan.exists {
        std::fs::read(&plan.path)
            .map_err(|error| format!("cannot read {}: {error}", plan.path.display()))?
    } else {
        Vec::new()
    };
    let text = String::from_utf8(existing.clone())
        .map_err(|_| format!("{} is not UTF-8; refusing to edit it", plan.path.display()))?;
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut updated = text.clone();
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push_str(eol);
    }
    for fix in &plan.to_add {
        updated.push_str(&format!("# added by codsh doctor fix ({}){eol}", fix.id));
        updated.push_str(fix.line);
        updated.push_str(eol);
    }
    let mut out = String::new();
    let undo = if plan.exists {
        let name = plan
            .path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| ".tmux.conf".into());
        let backup = plan
            .path
            .with_file_name(format!("{name}.codsh-backup-{stamp}"));
        if backup.exists() {
            return Err(format!(
                "backup {} already exists; not overwriting it",
                backup.display()
            ));
        }
        // fs::copy keeps the permission bits.
        std::fs::copy(&plan.path, &backup)
            .map_err(|error| format!("cannot write backup {}: {error}", backup.display()))?;
        // Truncating in place keeps the file's mode, owner and inode.
        std::fs::write(&plan.path, updated.as_bytes())
            .map_err(|error| format!("cannot write {}: {error}", plan.path.display()))?;
        out.push_str(&format!("Backup: {}\n", backup.display()));
        format!("cp '{}' '{}'", backup.display(), plan.path.display())
    } else {
        if let Some(parent) = plan.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
        }
        std::fs::write(&plan.path, updated.as_bytes())
            .map_err(|error| format!("cannot write {}: {error}", plan.path.display()))?;
        format!("rm '{}'", plan.path.display())
    };
    for fix in &plan.to_add {
        out.push_str(&format!("Applied {}: {}\n", fix.id, fix.line));
    }
    out.push_str(&format!("Undo: {undo}\n"));
    out.push_str(&format!(
        "Reload tmux yourself to use it now: tmux source-file '{}' (codsh never runs this)\n",
        plan.path.display()
    ));
    Ok(out)
}

/// Resolve fix ids; empty `ids` means every fixable current finding.
pub fn select_fixes(ids: &[String], report: &Report) -> Result<Vec<&'static TmuxFix>, String> {
    if ids.is_empty() {
        return Ok(report
            .findings
            .iter()
            .filter(|finding| finding.fixable)
            .filter_map(|finding| fix_by_id(finding.id))
            .collect());
    }
    let mut chosen = Vec::new();
    for id in ids {
        match fix_by_id(id) {
            Some(fix) => {
                if !chosen.iter().any(|known: &&TmuxFix| known.id == fix.id) {
                    chosen.push(fix);
                }
            }
            None => {
                let known: Vec<&str> = TMUX_FIXES.iter().map(|fix| fix.id).collect();
                return Err(format!(
                    "unknown fix `{id}`; fixable ids: {}",
                    known.join(", ")
                ));
            }
        }
    }
    Ok(chosen)
}

pub fn now_stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// `/doctor ...` inside the TUI: report, or `fix [ids] [--yes]`.
pub fn slash(args: &str, ctx: &CopyContext, notifications: &str) -> String {
    let probe = live_tmux_probe(&ctx.env);
    let report = collect(ctx, notifications, &probe);
    let words: Vec<&str> = args.split_whitespace().collect();
    if words.first().copied() != Some("fix") {
        if !words.is_empty() {
            return "usage: /doctor [fix [<id>...] [--yes]]".into();
        }
        return render_text(&report);
    }
    let yes = words.contains(&"--yes");
    let ids: Vec<String> = words[1..]
        .iter()
        .filter(|word| **word != "--yes")
        .map(|word| word.to_string())
        .collect();
    let fixes = match select_fixes(&ids, &report) {
        Ok(fixes) => fixes,
        Err(error) => return error,
    };
    if fixes.is_empty() {
        return "No fixable findings. Name a fix id to add it anyway: /doctor fix terminal.tmux-clipboard".into();
    }
    let plan = match plan_fixes(ctx, &fixes) {
        Ok(plan) => plan,
        Err(error) => return format!("doctor fix refused: {error}"),
    };
    let mut out = render_plan(&plan);
    if !yes {
        if !plan.to_add.is_empty() {
            let named: Vec<&str> = fixes.iter().map(|fix| fix.id).collect();
            out.push_str(&format!(
                "Not applied. Confirm with: /doctor fix {} --yes\n",
                named.join(" ")
            ));
        }
        return out;
    }
    match apply(&plan, now_stamp()) {
        Ok(done) => out.push_str(&done),
        Err(error) => out.push_str(&format!("doctor fix failed: {error}\n")),
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cli {
    Report { json: bool },
    Fix { ids: Vec<String>, yes: bool },
    Help,
}

pub fn cli_help() -> &'static str {
    "usage: codsh --rust doctor [--json]\n       codsh --rust doctor fix [<id>...] [--yes]\n\n\
     Reports terminal, multiplexer, color, newline-key and clipboard facts.\n\
     Findings do not change the exit code. `doctor fix` only edits your tmux\n\
     config (~/.tmux.conf, or $BYOBU_CONFIG_DIR/.tmux.conf under byobu): it shows\n\
     the plan, asks for confirmation (or --yes), writes a backup first, prints\n\
     the undo command, and never runs `tmux source-file` for you.\n\
     Fix ids: terminal.tmux-clipboard, terminal.dcs-passthrough,\n\
     terminal.tmux-extended-keys, terminal.tmux-truecolor."
}

pub fn parse_cli(flags: &[&str]) -> Result<Cli, String> {
    if flags.iter().any(|flag| matches!(*flag, "--help" | "-h")) {
        return Ok(Cli::Help);
    }
    if flags.first().copied() == Some("fix") {
        let mut ids = Vec::new();
        let mut yes = false;
        for flag in &flags[1..] {
            match *flag {
                "--yes" | "-y" => yes = true,
                other if other.starts_with('-') => {
                    return Err(format!(
                        "unsupported doctor fix flag {other}; use codsh --rust doctor --help"
                    ));
                }
                other => ids.push(other.to_string()),
            }
        }
        return Ok(Cli::Fix { ids, yes });
    }
    let mut json = false;
    for flag in flags {
        match *flag {
            "--json" => json = true,
            other => {
                return Err(format!(
                    "unsupported doctor argument {other}; use codsh --rust doctor --help"
                ));
            }
        }
    }
    Ok(Cli::Report { json })
}

/// Runs the CLI form; returns the process exit code.
pub fn run_cli(cli: &Cli, ctx: &CopyContext, notifications: &str) -> i32 {
    use std::io::{BufRead, IsTerminal, Write};
    let probe = live_tmux_probe(&ctx.env);
    let report = collect(ctx, notifications, &probe);
    match cli {
        Cli::Help => {
            println!("{}", cli_help());
            0
        }
        Cli::Report { json } => {
            if *json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&render_json(&report)).unwrap_or_default()
                );
            } else {
                print!("{}", render_text(&report));
            }
            0
        }
        Cli::Fix { ids, yes } => {
            let fixes = match select_fixes(ids, &report) {
                Ok(fixes) => fixes,
                Err(error) => {
                    eprintln!("codsh doctor: {error}");
                    return 2;
                }
            };
            if fixes.is_empty() {
                println!(
                    "No fixable findings. Name a fix id to add it anyway, e.g. `codsh --rust doctor fix terminal.tmux-clipboard`."
                );
                return 0;
            }
            let plan = match plan_fixes(ctx, &fixes) {
                Ok(plan) => plan,
                Err(error) => {
                    eprintln!("codsh doctor: fix refused: {error}");
                    return 1;
                }
            };
            print!("{}", render_plan(&plan));
            if plan.to_add.is_empty() {
                print!("{}", apply(&plan, now_stamp()).unwrap_or_default());
                return if plan.refused.is_empty() { 0 } else { 1 };
            }
            if !*yes {
                let interactive = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
                if !interactive {
                    println!("Not applied: confirm with --yes (nothing was changed).");
                    return 1;
                }
                print!("Apply these changes to {}? [y/N] ", plan.path.display());
                let _ = std::io::stdout().flush();
                let mut answer = String::new();
                let _ = std::io::stdin().lock().read_line(&mut answer);
                if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
                    println!("Not applied (nothing was changed).");
                    return 1;
                }
            }
            match apply(&plan, now_stamp()) {
                Ok(done) => {
                    print!("{done}");
                    if plan.refused.is_empty() { 0 } else { 1 }
                }
                Err(error) => {
                    eprintln!("codsh doctor: fix failed: {error}");
                    1
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_env::HostOs;

    fn ctx(pairs: &[(&str, &str)]) -> CopyContext {
        let env: EnvMap = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        CopyContext::from_env(env, HostOs::Linux, false, Path::new("/nonexistent-grok"))
    }

    fn probe_with(
        values: &'static [(&'static str, &'static str)],
    ) -> impl Fn(&[&str]) -> Option<String> {
        move |args: &[&str]| {
            let key = args.last().copied().unwrap_or("");
            values
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn tmux_findings_follow_probed_options() {
        let context = ctx(&[
            ("TMUX", "/tmp/t,1,0"),
            ("TERM", "tmux-256color"),
            ("PATH", "/nonexistent"),
        ]);
        let probe = probe_with(&[
            ("-V", "tmux 3.4"),
            ("set-clipboard", "external"),
            ("allow-passthrough", "off"),
            ("extended-keys", "on"),
            ("terminal-features", "xterm*:clipboard:ccolour"),
        ]);
        let report = collect(&context, "auto", &probe);
        let ids: Vec<&str> = report.findings.iter().map(|finding| finding.id).collect();
        assert!(ids.contains(&"terminal.tmux-clipboard"));
        assert!(ids.contains(&"terminal.dcs-passthrough"));
        assert!(!ids.contains(&"terminal.tmux-extended-keys"));
        assert!(ids.contains(&"terminal.tmux-truecolor"));
        let json = render_json(&report);
        assert_eq!(json["schema"], SCHEMA);
        assert_eq!(json["facts"]["multiplexer"], "tmux");
        assert_eq!(json["facts"]["tmuxOptions"]["set-clipboard"], "external");
        let text = render_text(&report);
        assert!(text.contains("terminal.tmux-clipboard"));
        assert!(text.contains("Not verified by this build"));
    }

    #[test]
    fn ssh_editor_iterm_findings() {
        let context = ctx(&[("SSH_TTY", "/dev/pts/1"), ("TERM_PROGRAM", "vscode")]);
        let report = collect(&context, "auto", &|_: &[&str]| None);
        let ids: Vec<&str> = report.findings.iter().map(|finding| finding.id).collect();
        assert!(ids.contains(&"terminal.ssh-wrap"));
        assert!(ids.contains(&"terminal.newline-fallback"));
        let iterm = ctx(&[("TERM_PROGRAM", "iTerm.app")]);
        let report = collect(&iterm, "auto", &|_: &[&str]| None);
        assert!(
            report
                .findings
                .iter()
                .any(|f| f.id == "terminal.iterm2-clipboard-permission")
        );
        let wrapped = ctx(&[("SSH_TTY", "/dev/pts/1"), ("LC_GROK_OSC52_SINK", "1")]);
        let report = collect(&wrapped, "auto", &|_: &[&str]| None);
        assert!(!report.findings.iter().any(|f| f.id == "terminal.ssh-wrap"));
    }

    #[test]
    fn inspect_detects_present_conflict_and_ambiguous() {
        let fix = fix_by_id("terminal.tmux-clipboard").unwrap();
        assert_eq!(inspect("", fix), LineState::Missing);
        assert_eq!(
            inspect("set -g set-clipboard on\n", fix),
            LineState::Present(1)
        );
        assert_eq!(
            inspect("# x\nset-option -g set-clipboard external\n", fix),
            LineState::Conflict(2, "external".into())
        );
        assert_eq!(
            inspect("if-shell 'true' 'set -g set-clipboard off'\n", fix),
            LineState::Ambiguous(1)
        );
        let rgb = fix_by_id("terminal.tmux-truecolor").unwrap();
        assert_eq!(
            inspect("set -ga terminal-overrides \",xterm*:Tc\"\n", rgb),
            LineState::Present(1)
        );
        let pass = fix_by_id("terminal.dcs-passthrough").unwrap();
        assert_eq!(
            inspect("setw -g allow-passthrough all\n", pass),
            LineState::Present(1)
        );
    }

    #[test]
    fn apply_backs_up_preserves_crlf_and_mode() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_str().unwrap().to_string();
        let conf = dir.path().join(".tmux.conf");
        std::fs::write(&conf, "set -g mouse on\r\nset -g history-limit 5000").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&conf, std::fs::Permissions::from_mode(0o640)).unwrap();
        }
        let context = ctx(&[("HOME", &home)]);
        let fixes = vec![
            fix_by_id("terminal.tmux-clipboard").unwrap(),
            fix_by_id("terminal.dcs-passthrough").unwrap(),
        ];
        let plan = plan_fixes(&context, &fixes).unwrap();
        assert_eq!(plan.to_add.len(), 2);
        let shown = render_plan(&plan);
        assert!(shown.contains("+ set -g set-clipboard on"));
        let done = apply(&plan, 42).unwrap();
        assert!(done.contains("Undo: cp"));
        assert!(done.contains("tmux source-file"));
        let updated = std::fs::read_to_string(&conf).unwrap();
        assert!(updated.starts_with("set -g mouse on\r\nset -g history-limit 5000\r\n"));
        assert!(updated.contains("set -g set-clipboard on\r\n"));
        assert!(updated.contains("set -wg allow-passthrough on\r\n"));
        let backup = dir.path().join(".tmux.conf.codsh-backup-42");
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            "set -g mouse on\r\nset -g history-limit 5000"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&conf).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o640);
        }
        // Second run: nothing to add, and the first backup is untouched.
        let again = plan_fixes(&context, &fixes).unwrap();
        assert!(again.to_add.is_empty());
        assert_eq!(again.already.len(), 2);
    }

    #[test]
    fn conflicts_and_byobu_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_str().unwrap().to_string();
        std::fs::write(dir.path().join(".tmux.conf"), "set -g set-clipboard off\n").unwrap();
        let context = ctx(&[("HOME", &home)]);
        let fix = fix_by_id("terminal.tmux-clipboard").unwrap();
        let plan = plan_fixes(&context, &[fix]).unwrap();
        assert!(plan.to_add.is_empty());
        assert_eq!(plan.refused.len(), 1);
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".tmux.conf")).unwrap(),
            "set -g set-clipboard off\n"
        );
        let byobu = ctx(&[
            ("HOME", &home),
            ("TMUX", "/t,1,0"),
            ("BYOBU_BACKEND", "tmux"),
        ]);
        assert!(
            tmux_conf_path(&byobu)
                .unwrap_err()
                .contains("BYOBU_CONFIG_DIR")
        );
        let fresh = tempfile::tempdir().unwrap();
        let context = ctx(&[("HOME", fresh.path().to_str().unwrap())]);
        let plan = plan_fixes(&context, &[fix]).unwrap();
        let done = apply(&plan, 1).unwrap();
        assert!(done.contains("Undo: rm"));
    }

    #[test]
    fn cli_parsing() {
        assert_eq!(parse_cli(&[]).unwrap(), Cli::Report { json: false });
        assert_eq!(parse_cli(&["--json"]).unwrap(), Cli::Report { json: true });
        assert_eq!(
            parse_cli(&["fix", "terminal.tmux-clipboard", "--yes"]).unwrap(),
            Cli::Fix {
                ids: vec!["terminal.tmux-clipboard".into()],
                yes: true
            }
        );
        assert_eq!(parse_cli(&["fix", "--help"]).unwrap(), Cli::Help);
        assert!(parse_cli(&["--bogus"]).is_err());
    }

    #[test]
    fn select_rejects_unknown_ids() {
        let report = Report {
            facts: Vec::new(),
            json_facts: Map::new(),
            findings: Vec::new(),
        };
        assert!(select_fixes(&["terminal.nope".into()], &report).is_err());
        assert_eq!(
            select_fixes(&["terminal.tmux-truecolor".into()], &report)
                .unwrap()
                .len(),
            1
        );
    }
}
