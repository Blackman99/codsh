//! Frozen Grok project rules, skills, agent definitions, and custom commands.
//!
//! dsh still executes the turn. This module discovers compatible assets,
//! diagnoses conflicts and truncation, and hands trusted content to dsh.

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

pub const SKILL_BODY_TOKEN_CAP: usize = 25_000;
const CHARS_PER_TOKEN: usize = 4;
const RULE_CANDIDATES: &[&str] = &[
    "Agents.md",
    "Claude.md",
    "CLAUDE.md",
    "CLAUDE.local.md",
    "AGENT.md",
    "AGENTS.md",
];
const VENDOR_DENY: &[&str] = &["shell", "canvas", "statusline"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetDiagnostic {
    pub kind: String,
    pub path: String,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuleFile {
    pub path: PathBuf,
    pub display: String,
    pub scope: String,
    pub content: String,
    pub bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillAsset {
    pub name: String,
    pub qualified: String,
    pub description: String,
    pub source: String,
    pub path: PathBuf,
    pub user_invocable: bool,
    pub model_invocable: bool,
    pub argument_hint: String,
    pub body: String,
    pub truncated: bool,
    pub disabled: bool,
    pub collides_with: Option<String>,
    /// Directory-distance rank. Lower is closer to the working directory.
    pub rank: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentAsset {
    pub name: String,
    pub description: String,
    pub source: String,
    pub path: PathBuf,
    pub body: String,
    pub model: Option<String>,
    pub tools: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandAsset {
    pub name: String,
    pub qualified: String,
    pub description: String,
    pub source: String,
    pub path: PathBuf,
    pub argument_hint: String,
    pub body: String,
    pub collides_with: Option<String>,
    pub rank: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetCatalog {
    pub rules: Vec<RuleFile>,
    pub skills: Vec<SkillAsset>,
    pub agents: Vec<AgentAsset>,
    pub commands: Vec<CommandAsset>,
    pub diagnostics: Vec<AssetDiagnostic>,
    pub project_active: bool,
}

#[derive(Clone, Debug)]
pub struct DiscoverInput<'a> {
    pub cwd: &'a Path,
    pub grok_home: &'a Path,
    pub home: &'a Path,
    pub project_active: bool,
    pub claude_rules: bool,
    pub cursor_rules: bool,
    pub claude_agents: bool,
    pub claude_skills: bool,
    pub cursor_skills: bool,
    pub extra_rule_dirs: &'a [String],
    pub skill_paths: &'a [String],
    pub skill_ignore: &'a [String],
    pub skill_disabled: &'a [String],
    pub builtin_commands: &'a [&'a str],
}

pub fn discover(input: &DiscoverInput<'_>) -> AssetCatalog {
    let mut diagnostics = Vec::new();
    let rules = discover_rules(input, &mut diagnostics);
    let mut skills = Vec::new();
    let mut commands = Vec::new();
    discover_skills_and_commands(input, &mut skills, &mut commands, &mut diagnostics);
    mark_collisions(&mut skills, &mut commands, input.builtin_commands);
    let agents = discover_agents(input, &mut diagnostics);
    AssetCatalog {
        rules,
        skills,
        agents,
        commands,
        diagnostics,
        project_active: input.project_active,
    }
}

pub fn rule_context(catalog: &AssetCatalog) -> String {
    if catalog.rules.is_empty() {
        return String::new();
    }
    let mut body = String::from(
        "<human_rules>\nProject and user rules. Deeper files take precedence over broader ones.\n",
    );
    for rule in &catalog.rules {
        body.push_str(&format!(
            "\nInstructions from: {} ({}, {} bytes)\n{}\n",
            rule.display,
            rule.scope,
            rule.bytes,
            rule.content.trim_end()
        ));
    }
    body.push_str("</human_rules>\n");
    body
}

pub fn skill_invocation<'a>(catalog: &'a AssetCatalog, token: &str) -> Option<&'a SkillAsset> {
    let name = token.trim().trim_start_matches('/').trim();
    let (name, _) = name.split_once(char::is_whitespace).unwrap_or((name, ""));
    catalog.skills.iter().find(|skill| {
        if skill.disabled || !skill.user_invocable {
            return false;
        }
        // A contested bare name stays the host command. The skill is only
        // `/local:name`, `/ancestor:name`, `/repo:name`, or `/user:name`.
        if skill.collides_with.is_some() {
            skill.qualified == name
        } else {
            skill.name == name || skill.qualified == name
        }
    })
}

pub fn command_invocation<'a>(catalog: &'a AssetCatalog, token: &str) -> Option<&'a CommandAsset> {
    let name = token.trim().trim_start_matches('/').trim();
    let (name, _) = name.split_once(char::is_whitespace).unwrap_or((name, ""));
    catalog.commands.iter().find(|command| {
        if command.collides_with.is_some() {
            command.qualified == name
        } else {
            command.name == name || command.qualified == name
        }
    })
}

pub fn prompt_for_model(catalog: &AssetCatalog, text: &str) -> String {
    prompt_with_session(catalog, text, "", false)
}

/// Session rules from `--rules` are wrapped in `<human_rules>`.
/// `--system-prompt-override` replaces file rules, agents, and the user text.
pub fn prompt_with_session(
    catalog: &AssetCatalog,
    text: &str,
    session_rules: &str,
    system_prompt_override: bool,
) -> String {
    if system_prompt_override {
        let invocation = invocation_prompt(catalog, text).unwrap_or_default();
        let preamble = session_rules.trim();
        if preamble.is_empty() {
            return format!("{invocation}{text}");
        }
        return format!("{preamble}\n{invocation}{text}");
    }
    let rules = rule_context(catalog);
    let agents = agent_context(catalog);
    let invocation = invocation_prompt(catalog, text).unwrap_or_default();
    let session = session_rule_block(session_rules);
    if rules.is_empty() && agents.is_empty() && invocation.is_empty() && session.is_empty() {
        return text.to_string();
    }
    format!("{rules}{session}{agents}{invocation}{text}")
}

fn session_rule_block(session_rules: &str) -> String {
    let trimmed = session_rules.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    format!("<human_rules>\n{trimmed}\n</human_rules>\n")
}

fn agent_context(catalog: &AssetCatalog) -> String {
    if catalog.agents.is_empty() {
        return String::new();
    }
    let mut body = String::from("<agent-definitions>\n");
    for agent in &catalog.agents {
        body.push_str(&format!(
            "Agent {name} ({source}) from {path}: {description}\n{content}\n",
            name = agent.name,
            source = agent.source,
            path = agent.path.display(),
            description = agent.description,
            content = agent.body.trim_end()
        ));
    }
    body.push_str("</agent-definitions>\n");
    body
}

pub fn invocation_prompt(catalog: &AssetCatalog, text: &str) -> Option<String> {
    let trimmed = text.trim();
    if !trimmed.starts_with('/') {
        return None;
    }
    let args = trimmed
        .split_once(char::is_whitespace)
        .map(|(_, rest)| rest.trim())
        .unwrap_or("");
    if let Some(skill) = skill_invocation(catalog, trimmed) {
        let mut prompt = format!(
            "Follow the `{name}` skill from {path}. Arguments: {args}\n\n{body}\n",
            name = skill.qualified,
            path = skill.path.display(),
            body = skill.body.trim_end()
        );
        if skill.truncated {
            prompt.push_str(
                "\nThe skill body was truncated at 25000 tokens. Read sibling files for the rest.\n",
            );
        }
        return Some(prompt);
    }
    command_invocation(catalog, trimmed).map(|command| {
        format!(
            "Run the custom command `{name}` from {path}. Arguments: {args}\n\n{body}\n",
            name = command.qualified,
            path = command.path.display(),
            body = command.body.trim_end()
        )
    })
}

pub fn inspect_text(catalog: &AssetCatalog) -> String {
    let mut lines = vec![format!(
        "Assets: project {} · {} rules · {} skills · {} commands · {} agents",
        if catalog.project_active {
            "active"
        } else {
            "inactive"
        },
        catalog.rules.len(),
        catalog.skills.len(),
        catalog.commands.len(),
        catalog.agents.len()
    )];
    for rule in &catalog.rules {
        lines.push(format!(
            "  rule {:<8} {}  ({} bytes)",
            rule.scope, rule.display, rule.bytes
        ));
    }
    for skill in &catalog.skills {
        let state = if skill.disabled {
            "[disabled]"
        } else if !skill.user_invocable {
            "model-only"
        } else {
            "enabled"
        };
        let collision = skill
            .collides_with
            .as_deref()
            .map(|name| format!(" [collides with {name} → /{}]", skill.qualified))
            .unwrap_or_default();
        let truncated = if skill.truncated { " [truncated]" } else { "" };
        lines.push(format!(
            "  skill {:<8} /{}  {}{collision}{truncated}",
            skill.source, skill.name, state
        ));
    }
    for command in &catalog.commands {
        let collision = command
            .collides_with
            .as_deref()
            .map(|name| format!(" [collides with {name} → /{}]", command.qualified))
            .unwrap_or_default();
        lines.push(format!(
            "  command {:<8} /{}{collision}",
            command.source, command.name
        ));
    }
    for agent in &catalog.agents {
        lines.push(format!(
            "  agent {:<8} {}  {}",
            agent.source, agent.name, agent.description
        ));
    }
    for diagnostic in &catalog.diagnostics {
        lines.push(format!(
            "  diagnostic {:<16} {}  {}",
            diagnostic.kind, diagnostic.path, diagnostic.detail
        ));
    }
    lines.join("\n")
}

pub fn inspect_json(catalog: &AssetCatalog) -> serde_json::Value {
    serde_json::json!({
        "projectActive": catalog.project_active,
        "rules": catalog.rules.iter().map(|rule| serde_json::json!({
            "path": rule.display,
            "scope": rule.scope,
            "bytes": rule.bytes,
        })).collect::<Vec<_>>(),
        "skills": catalog.skills.iter().map(|skill| serde_json::json!({
            "name": skill.name,
            "description": skill.description,
            "source": skill.source,
            "path": skill.path,
            "userInvocable": skill.user_invocable,
            "modelInvocable": skill.model_invocable,
            "disabled": skill.disabled,
            "truncated": skill.truncated,
            "collidesWith": skill.collides_with,
            "invocableAs": format!("/{}", if skill.collides_with.is_some() { &skill.qualified } else { &skill.name }),
        })).collect::<Vec<_>>(),
        "commands": catalog.commands.iter().map(|command| serde_json::json!({
            "name": command.name,
            "description": command.description,
            "source": command.source,
            "path": command.path,
            "collidesWith": command.collides_with,
            "invocableAs": format!("/{}", if command.collides_with.is_some() { &command.qualified } else { &command.name }),
        })).collect::<Vec<_>>(),
        "agents": catalog.agents.iter().map(|agent| serde_json::json!({
            "name": agent.name,
            "description": agent.description,
            "source": agent.source,
            "path": agent.path,
            "model": agent.model,
        })).collect::<Vec<_>>(),
        "diagnostics": catalog.diagnostics.iter().map(|item| serde_json::json!({
            "kind": item.kind,
            "path": item.path,
            "detail": item.detail,
        })).collect::<Vec<_>>(),
    })
}

pub fn menu_entries(catalog: &AssetCatalog) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    for skill in &catalog.skills {
        if skill.disabled || !skill.user_invocable {
            continue;
        }
        let label = if skill.collides_with.is_some() {
            format!("/{}", skill.qualified)
        } else {
            format!("/{}", skill.name)
        };
        entries.push((
            label,
            format!("skill · {}  {}", skill.source, skill.description),
        ));
    }
    for command in &catalog.commands {
        let label = if command.collides_with.is_some() {
            format!("/{}", command.qualified)
        } else {
            format!("/{}", command.name)
        };
        entries.push((
            label,
            format!("command · {}  {}", command.source, command.description),
        ));
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    entries
}

fn discover_rules(
    input: &DiscoverInput<'_>,
    diagnostics: &mut Vec<AssetDiagnostic>,
) -> Vec<RuleFile> {
    let mut rules = Vec::new();
    let mut seen = BTreeSet::new();
    push_rule_dir(
        &mut rules,
        &mut seen,
        diagnostics,
        &input.grok_home.join("rules"),
        "global",
        true,
        false,
    );
    if input.claude_rules {
        push_named(
            &mut rules,
            &mut seen,
            diagnostics,
            &input.home.join(".claude"),
            RULE_CANDIDATES,
            "global",
            false,
        );
        push_rule_dir(
            &mut rules,
            &mut seen,
            diagnostics,
            &input.home.join(".claude").join("rules"),
            "global",
            true,
            false,
        );
    }
    if input.cursor_rules {
        push_named(
            &mut rules,
            &mut seen,
            diagnostics,
            &input.home.join(".cursor"),
            RULE_CANDIDATES,
            "global",
            false,
        );
        push_rule_dir(
            &mut rules,
            &mut seen,
            diagnostics,
            &input.home.join(".cursor").join("rules"),
            "global",
            true,
            false,
        );
    }
    for raw in input.extra_rule_dirs {
        match expand_absolute(raw, input.home) {
            Ok(path) => push_rule_dir(
                &mut rules,
                &mut seen,
                diagnostics,
                &path,
                "global",
                true,
                false,
            ),
            Err(detail) => diagnostics.push(AssetDiagnostic {
                kind: "rule-path".into(),
                path: raw.clone(),
                detail,
            }),
        }
    }
    if !input.project_active {
        return rules;
    }
    for directory in project_chain(input.cwd) {
        push_named(
            &mut rules,
            &mut seen,
            diagnostics,
            &directory,
            RULE_CANDIDATES,
            "project",
            true,
        );
        if input.claude_agents {
            for name in ["CLAUDE.md", "CLAUDE.local.md"] {
                push_file(
                    &mut rules,
                    &mut seen,
                    diagnostics,
                    &directory.join(".claude").join(name),
                    "project",
                    true,
                );
            }
        }
        push_rule_dir(
            &mut rules,
            &mut seen,
            diagnostics,
            &directory.join(".grok").join("rules"),
            "project",
            true,
            true,
        );
        if input.claude_rules {
            push_rule_dir(
                &mut rules,
                &mut seen,
                diagnostics,
                &directory.join(".claude").join("rules"),
                "project",
                true,
                true,
            );
        }
        if input.cursor_rules {
            push_rule_dir(
                &mut rules,
                &mut seen,
                diagnostics,
                &directory.join(".cursor").join("rules"),
                "project",
                true,
                true,
            );
        }
    }
    rules
}

struct RawSkill {
    name: String,
    description: String,
    source: String,
    scope: String,
    path: PathBuf,
    user_invocable: bool,
    model_invocable: bool,
    argument_hint: String,
    body: String,
    truncated: bool,
    disabled: bool,
    rank: u16,
}

fn discover_skills_and_commands(
    input: &DiscoverInput<'_>,
    skills: &mut Vec<SkillAsset>,
    commands: &mut Vec<CommandAsset>,
    diagnostics: &mut Vec<AssetDiagnostic>,
) {
    let mut raw = Vec::new();
    let mut command_raw = Vec::new();
    // Higher rank is closer to the working directory and wins a name.
    // Each directory between the repo root and cwd is its own tier.
    if input.project_active {
        if let Some(repo) = git_root(input.cwd) {
            let chain = ancestor_dirs(&repo, input.cwd);
            let last = chain.len().saturating_sub(1);
            for (index, directory) in chain.iter().enumerate() {
                let scope = skill_scope(index, last);
                let rank = 100u16.saturating_add(index as u16);
                scan_skill_tier(
                    input,
                    directory,
                    "project",
                    scope,
                    rank,
                    &mut raw,
                    &mut command_raw,
                    diagnostics,
                );
            }
        } else {
            scan_skill_tier(
                input,
                input.cwd,
                "project",
                "local",
                100,
                &mut raw,
                &mut command_raw,
                diagnostics,
            );
        }
    }
    scan_user_skills(input, &mut raw, &mut command_raw, diagnostics);
    for raw_path in input.skill_paths {
        match expand_user(raw_path, input.home) {
            Ok(path) => scan_configured_skill(input, &path, &mut raw, diagnostics),
            Err(detail) => diagnostics.push(AssetDiagnostic {
                kind: "skill-path".into(),
                path: raw_path.clone(),
                detail,
            }),
        }
    }
    // Higher rank is closer to the working directory. Same rank keeps both.
    raw.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(right.rank.cmp(&left.rank))
            .then(left.path.cmp(&right.path))
    });
    let mut winners: Vec<RawSkill> = Vec::new();
    for skill in raw {
        if let Some(existing) = winners
            .iter()
            .find(|item| item.name == skill.name && item.rank == skill.rank)
        {
            diagnostics.push(AssetDiagnostic {
                kind: "skill-collision".into(),
                path: skill.path.display().to_string(),
                detail: format!(
                    "{} stays invocable beside {} at the same scope",
                    skill.path.display(),
                    existing.path.display()
                ),
            });
            winners.push(skill);
            continue;
        }
        if let Some(existing) = winners.iter().find(|item| item.name == skill.name) {
            diagnostics.push(AssetDiagnostic {
                kind: "skill-collision".into(),
                path: skill.path.display().to_string(),
                detail: format!(
                    "{} is shadowed by {} ({})",
                    skill.path.display(),
                    existing.path.display(),
                    existing.source
                ),
            });
            continue;
        }
        winners.push(skill);
    }
    for skill in winners {
        skills.push(SkillAsset {
            qualified: format!("{}:{}", skill.scope, skill.name),
            name: skill.name,
            description: skill.description,
            source: skill.source,
            path: skill.path,
            user_invocable: skill.user_invocable,
            model_invocable: skill.model_invocable,
            argument_hint: skill.argument_hint,
            body: skill.body,
            truncated: skill.truncated,
            disabled: skill.disabled,
            collides_with: None,
            rank: skill.rank,
        });
    }
    // Same-scope command names both stay invocable. A closer directory
    // (higher rank) outranks a broader one and records the loser as shadowed.
    command_raw.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(right.rank.cmp(&left.rank))
            .then(left.path.cmp(&right.path))
    });
    let mut winners: Vec<CommandAsset> = Vec::new();
    for command in command_raw {
        if let Some(existing) = winners
            .iter()
            .find(|item| item.name == command.name && item.rank == command.rank)
        {
            diagnostics.push(AssetDiagnostic {
                kind: "command-collision".into(),
                path: command.path.display().to_string(),
                detail: format!(
                    "{} stays invocable beside {} at the same scope",
                    command.path.display(),
                    existing.path.display()
                ),
            });
            commands.push(command);
            continue;
        }
        if let Some(existing) = winners.iter().find(|item| item.name == command.name) {
            diagnostics.push(AssetDiagnostic {
                kind: "command-collision".into(),
                path: command.path.display().to_string(),
                detail: format!(
                    "{} is shadowed by {} ({})",
                    command.path.display(),
                    existing.path.display(),
                    existing.source
                ),
            });
            continue;
        }
        winners.push(command);
    }
    commands.extend(winners);
}

fn scan_skill_tier(
    input: &DiscoverInput<'_>,
    directory: &Path,
    source: &str,
    scope: &str,
    rank: u16,
    skills: &mut Vec<RawSkill>,
    commands: &mut Vec<CommandAsset>,
    diagnostics: &mut Vec<AssetDiagnostic>,
) {
    for root_name in [".grok", ".agents"] {
        let root = directory.join(root_name);
        scan_skill_root(
            input,
            &root.join("skills"),
            source,
            scope,
            rank,
            skills,
            diagnostics,
        );
        scan_command_root(input, &root.join("commands"), source, scope, rank, commands);
    }
    if input.claude_skills {
        let root = directory.join(".claude");
        scan_skill_root(
            input,
            &root.join("skills"),
            "project",
            scope,
            rank,
            skills,
            diagnostics,
        );
        scan_command_root(
            input,
            &root.join("commands"),
            "project",
            scope,
            rank,
            commands,
        );
    }
    if input.cursor_skills {
        scan_skill_root(
            input,
            &directory.join(".cursor").join("skills"),
            "project",
            scope,
            rank,
            skills,
            diagnostics,
        );
    }
}

fn skill_scope(index: usize, last: usize) -> &'static str {
    if index == last {
        "local"
    } else if index == 0 {
        "repo"
    } else {
        "ancestor"
    }
}

fn scan_user_skills(
    input: &DiscoverInput<'_>,
    skills: &mut Vec<RawSkill>,
    commands: &mut Vec<CommandAsset>,
    diagnostics: &mut Vec<AssetDiagnostic>,
) {
    let rank = 10;
    scan_skill_root(
        input,
        &input.grok_home.join("skills"),
        "user",
        "user",
        rank,
        skills,
        diagnostics,
    );
    scan_command_root(
        input,
        &input.grok_home.join("commands"),
        "user",
        "user",
        rank,
        commands,
    );
    if input.claude_skills {
        scan_skill_root(
            input,
            &input.home.join(".claude").join("skills"),
            "user",
            "user",
            rank,
            skills,
            diagnostics,
        );
        scan_command_root(
            input,
            &input.home.join(".claude").join("commands"),
            "user",
            "user",
            rank,
            commands,
        );
    }
    if input.cursor_skills {
        scan_skill_root(
            input,
            &input.home.join(".cursor").join("skills"),
            "user",
            "user",
            rank,
            skills,
            diagnostics,
        );
    }
}

fn scan_configured_skill(
    input: &DiscoverInput<'_>,
    path: &Path,
    skills: &mut Vec<RawSkill>,
    diagnostics: &mut Vec<AssetDiagnostic>,
) {
    if ignored_skill(input, path) {
        return;
    }
    if path.is_file() && path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
        if let Some(skill) = parse_skill(input, path, "config", "config", 30, diagnostics) {
            skills.push(skill);
        }
        return;
    }
    if !path.is_dir() {
        diagnostics.push(AssetDiagnostic {
            kind: "skill-path".into(),
            path: path.display().to_string(),
            detail: "configured skill path is missing".into(),
        });
        return;
    }
    // find_skill_md_paths loads this directory's own SKILL.md, then calls
    // walk_for_skill_md(dir, 0). That walk lists children and recurses at
    // depth + 1, so the configured directory is depth 0 and its children
    // start at depth 1. A sixth child is depth 6 and is not loaded.
    // walk_named_skills records SKILL.md before descending, which is the
    // same order for a directory that is itself a skill.
    walk_named_skills(input, path, "config", "config", 30, skills, diagnostics, 0);
}

fn scan_skill_root(
    input: &DiscoverInput<'_>,
    root: &Path,
    source: &str,
    scope: &str,
    rank: u16,
    skills: &mut Vec<RawSkill>,
    diagnostics: &mut Vec<AssetDiagnostic>,
) {
    if !root.is_dir() {
        return;
    }
    let mut names = match fs::read_dir(root) {
        Ok(entries) => entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect::<Vec<_>>(),
        Err(error) => {
            diagnostics.push(AssetDiagnostic {
                kind: "skill-root".into(),
                path: root.display().to_string(),
                detail: error.to_string(),
            });
            return;
        }
    };
    names.sort();
    for directory in names {
        walk_named_skills(
            input,
            &directory,
            source,
            scope,
            rank,
            skills,
            diagnostics,
            0,
        );
    }
}

const SKILL_WALK_DEPTH: u8 = 5;

fn walk_named_skills(
    input: &DiscoverInput<'_>,
    directory: &Path,
    source: &str,
    scope: &str,
    rank: u16,
    skills: &mut Vec<RawSkill>,
    diagnostics: &mut Vec<AssetDiagnostic>,
    depth: u8,
) {
    // The caller chooses depth 0. A named skill root passes each child, so
    // six directories under that root load. find_skill_md_paths passes the
    // configured directory itself, so its children start at depth 1 and a
    // sixth child does not load. The walk returns only when depth is greater
    // than five. A directory that already has SKILL.md is still entered.
    if depth > SKILL_WALK_DEPTH {
        return;
    }
    let file = directory.join("SKILL.md");
    if file.is_file()
        && !ignored_skill(input, &file)
        && let Some(skill) = parse_skill(input, &file, source, scope, rank, diagnostics)
    {
        skills.push(skill);
    }
    if !directory.is_dir() {
        return;
    }
    let mut children = match fs::read_dir(directory) {
        Ok(entries) => entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect::<Vec<_>>(),
        Err(_) => return,
    };
    children.sort();
    for child in children {
        walk_named_skills(
            input,
            &child,
            source,
            scope,
            rank,
            skills,
            diagnostics,
            depth + 1,
        );
    }
}

fn scan_command_root(
    input: &DiscoverInput<'_>,
    root: &Path,
    source: &str,
    scope: &str,
    rank: u16,
    commands: &mut Vec<CommandAsset>,
) {
    if !root.is_dir() {
        return;
    }
    let mut files = match fs::read_dir(root) {
        Ok(entries) => entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("md")
            })
            .collect::<Vec<_>>(),
        Err(_) => return,
    };
    files.sort();
    for file in files {
        if ignored_skill(input, &file) {
            continue;
        }
        let stem = file
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("command");
        let name = normalize_name(stem);
        if name.is_empty() {
            continue;
        }
        let (meta, body) = split_frontmatter(&read_text(&file).unwrap_or_default());
        let description = meta
            .get("description")
            .cloned()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| first_paragraph(&body));
        commands.push(CommandAsset {
            qualified: format!("{scope}:{name}"),
            name,
            description,
            source: source.into(),
            path: file,
            argument_hint: meta.get("argument-hint").cloned().unwrap_or_default(),
            body,
            collides_with: None,
            rank,
        });
    }
}

fn parse_skill(
    input: &DiscoverInput<'_>,
    file: &Path,
    source: &str,
    scope: &str,
    rank: u16,
    diagnostics: &mut Vec<AssetDiagnostic>,
) -> Option<RawSkill> {
    let text = read_text(file)?;
    let (meta, body) = split_frontmatter(&text);
    let fallback = if file.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
        file.parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .unwrap_or("skill")
    } else {
        file.file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("skill")
    };
    let name = normalize_name(meta.get("name").map(String::as_str).unwrap_or(fallback));
    let vendor_root = file.ancestors().any(|parent| {
        parent
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == ".cursor" || name == ".claude")
    });
    if name.is_empty() || name.len() > 64 || (vendor_root && VENDOR_DENY.contains(&name.as_str())) {
        diagnostics.push(AssetDiagnostic {
            kind: "skill-name".into(),
            path: file.display().to_string(),
            detail: format!("rejected skill name {name}"),
        });
        return None;
    }
    let description = meta
        .get("description")
        .cloned()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| first_paragraph(&body));
    let (body, truncated) = cap_body(&body);
    if truncated {
        diagnostics.push(AssetDiagnostic {
            kind: "skill-truncation".into(),
            path: file.display().to_string(),
            detail: format!("{name} body truncated at {SKILL_BODY_TOKEN_CAP} tokens"),
        });
    }
    let disabled = input.skill_disabled.iter().any(|item| item == &name);
    Some(RawSkill {
        name,
        description,
        source: source.into(),
        scope: scope.into(),
        path: file.to_path_buf(),
        user_invocable: flag_true_default(meta.get("user-invocable").map(String::as_str)),
        model_invocable: !flag_true(meta.get("disable-model-invocation").map(String::as_str)),
        argument_hint: meta.get("argument-hint").cloned().unwrap_or_default(),
        body,
        truncated,
        disabled,
        rank,
    })
}

fn discover_agents(
    input: &DiscoverInput<'_>,
    diagnostics: &mut Vec<AssetDiagnostic>,
) -> Vec<AgentAsset> {
    let mut agents = Vec::new();
    let mut seen = BTreeSet::new();
    if input.project_active {
        for directory in project_chain(input.cwd) {
            push_agents(
                &mut agents,
                &mut seen,
                diagnostics,
                &directory.join(".grok").join("agents"),
                "project",
            );
        }
    }
    push_agents(
        &mut agents,
        &mut seen,
        diagnostics,
        &input.grok_home.join("agents"),
        "user",
    );
    agents
}

fn push_agents(
    agents: &mut Vec<AgentAsset>,
    seen: &mut BTreeSet<String>,
    diagnostics: &mut Vec<AssetDiagnostic>,
    directory: &Path,
    source: &str,
) {
    if !directory.is_dir() {
        return;
    }
    let mut files = match fs::read_dir(directory) {
        Ok(entries) => entries
            .flatten()
            .map(|entry| entry.path())
            .collect::<Vec<_>>(),
        Err(error) => {
            diagnostics.push(AssetDiagnostic {
                kind: "agent-root".into(),
                path: directory.display().to_string(),
                detail: error.to_string(),
            });
            return;
        }
    };
    files.sort();
    for file in files {
        if file.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        let Some(text) = read_text(&file) else {
            continue;
        };
        let (meta, body) = split_frontmatter(&text);
        let fallback = file
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("agent");
        let name = normalize_name(meta.get("name").map(String::as_str).unwrap_or(fallback));
        if name.is_empty() || !seen.insert(name.clone()) {
            diagnostics.push(AssetDiagnostic {
                kind: "agent-collision".into(),
                path: file.display().to_string(),
                detail: format!("{name} is shadowed by a higher-priority agent"),
            });
            continue;
        }
        agents.push(AgentAsset {
            name,
            description: meta
                .get("description")
                .cloned()
                .unwrap_or_else(|| first_paragraph(&body)),
            source: source.into(),
            path: file,
            body,
            model: meta.get("model").cloned(),
            tools: meta.get("tools").cloned().unwrap_or_default(),
        });
    }
}

fn mark_collisions(skills: &mut [SkillAsset], commands: &mut [CommandAsset], builtins: &[&str]) {
    let mut names = BTreeSet::new();
    for name in builtins {
        names.insert((*name).to_string());
    }
    let skill_names: Vec<String> = skills.iter().map(|skill| skill.name.clone()).collect();
    let command_names: Vec<String> = commands
        .iter()
        .map(|command| command.name.clone())
        .collect();
    for skill in skills.iter_mut() {
        let contested = builtins.contains(&skill.name.as_str())
            || command_names
                .iter()
                .filter(|name| *name == &skill.name)
                .count()
                > 0
            || skill_names
                .iter()
                .filter(|name| *name == &skill.name)
                .count()
                > 1;
        if contested || names.contains(&skill.name) {
            skill.collides_with = Some(format!("/{}", skill.name));
        }
        names.insert(skill.name.clone());
    }
    for command in commands.iter_mut() {
        if builtins.contains(&command.name.as_str()) || names.contains(&command.name) {
            command.collides_with = Some(format!("/{}", command.name));
        }
        names.insert(command.name.clone());
    }
}

fn push_named(
    rules: &mut Vec<RuleFile>,
    seen: &mut BTreeSet<PathBuf>,
    diagnostics: &mut Vec<AssetDiagnostic>,
    directory: &Path,
    names: &[&str],
    scope: &str,
    respect_gitignore: bool,
) {
    for name in names {
        push_file(
            rules,
            seen,
            diagnostics,
            &directory.join(name),
            scope,
            respect_gitignore,
        );
    }
}

fn push_rule_dir(
    rules: &mut Vec<RuleFile>,
    seen: &mut BTreeSet<PathBuf>,
    diagnostics: &mut Vec<AssetDiagnostic>,
    directory: &Path,
    scope: &str,
    direct_only: bool,
    respect_gitignore: bool,
) {
    if !directory.exists() {
        return;
    }
    if !directory.is_dir() {
        diagnostics.push(AssetDiagnostic {
            kind: "rule-path".into(),
            path: directory.display().to_string(),
            detail: "rules path is not a directory".into(),
        });
        return;
    }
    let mut files = match fs::read_dir(directory) {
        Ok(entries) => entries
            .flatten()
            .map(|entry| entry.path())
            .collect::<Vec<_>>(),
        Err(error) => {
            diagnostics.push(AssetDiagnostic {
                kind: "rule-path".into(),
                path: directory.display().to_string(),
                detail: error.to_string(),
            });
            return;
        }
    };
    files.sort();
    for path in files {
        if direct_only && !path.is_file() {
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            push_file(rules, seen, diagnostics, &path, scope, respect_gitignore);
        }
    }
}

fn push_file(
    rules: &mut Vec<RuleFile>,
    seen: &mut BTreeSet<PathBuf>,
    diagnostics: &mut Vec<AssetDiagnostic>,
    path: &Path,
    scope: &str,
    respect_gitignore: bool,
) {
    if !path.is_file() || (respect_gitignore && gitignored_file(path)) {
        return;
    }
    let key = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !seen.insert(key) {
        return;
    }
    match read_text(path) {
        Some(content) => rules.push(RuleFile {
            display: path.display().to_string(),
            path: path.to_path_buf(),
            scope: scope.into(),
            bytes: content.len(),
            content,
        }),
        None => diagnostics.push(AssetDiagnostic {
            kind: "rule-read".into(),
            path: path.display().to_string(),
            detail: "instruction file is unreadable".into(),
        }),
    }
}

fn project_chain(cwd: &Path) -> Vec<PathBuf> {
    if let Some(root) = git_root(cwd) {
        ancestor_dirs(&root, cwd)
    } else {
        vec![cwd.to_path_buf()]
    }
}

fn ancestor_dirs(root: &Path, cwd: &Path) -> Vec<PathBuf> {
    let mut chain = vec![root.to_path_buf()];
    if let Ok(relative) = cwd.strip_prefix(root) {
        let mut cursor = root.to_path_buf();
        for component in relative.components() {
            cursor.push(component);
            chain.push(cursor.clone());
        }
    }
    chain
}

fn git_root(start: &Path) -> Option<PathBuf> {
    let mut cursor = if start.is_dir() {
        start.to_path_buf()
    } else {
        start.parent()?.to_path_buf()
    };
    loop {
        if cursor.join(".git").exists() {
            return Some(cursor);
        }
        if !cursor.pop() {
            return None;
        }
    }
}

fn gitignored_file(path: &Path) -> bool {
    let mut matcher = GitignoreBuilder::new(path.ancestors().last().unwrap_or(path));
    let mut cursor = path.parent().map(Path::to_path_buf);
    let mut files = Vec::new();
    while let Some(directory) = cursor {
        let ignore = directory.join(".gitignore");
        if ignore.is_file() {
            files.push(ignore);
        }
        cursor = directory.parent().map(Path::to_path_buf);
    }
    // Parent gitignores apply first; a closer file can un-ignore.
    for ignore in files.into_iter().rev() {
        let _ = matcher.add(ignore);
    }
    match matcher.build() {
        Ok(set) => gitignore_matches(&set, path),
        Err(_) => false,
    }
}

fn gitignore_matches(set: &Gitignore, path: &Path) -> bool {
    let matched = set.matched_path_or_any_parents(path, path.is_dir());
    matched.is_ignore()
}

fn ignored_skill(input: &DiscoverInput<'_>, path: &Path) -> bool {
    input.skill_ignore.iter().any(|raw| {
        expand_user(raw, input.home)
            .ok()
            .is_some_and(|prefix| path.starts_with(&prefix) || path == prefix)
    })
}

fn expand_absolute(raw: &str, home: &Path) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty extra_rule_dirs entry loads nothing".into());
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return Ok(home.join(rest));
    }
    if trimmed == "~" {
        return Ok(home.to_path_buf());
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        if path.is_dir() {
            Ok(path)
        } else {
            Err("extra rule directory is missing".into())
        }
    } else {
        Err("relative extra_rule_dirs entry loads nothing".into())
    }
}

fn expand_user(raw: &str, home: &Path) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty skill path".into());
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return Ok(home.join(rest));
    }
    if trimmed == "~" {
        return Ok(home.to_path_buf());
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err("relative skill path is not scanned".into())
    }
}

fn read_text(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn split_frontmatter(text: &str) -> (std::collections::BTreeMap<String, String>, String) {
    let mut meta = std::collections::BTreeMap::new();
    let rest = text.trim_start_matches('\u{feff}');
    let Some(body) = rest
        .strip_prefix("---\n")
        .or_else(|| rest.strip_prefix("---\r\n"))
    else {
        return (meta, text.to_string());
    };
    let Some((front, markdown)) = body.split_once("\n---") else {
        return (meta, text.to_string());
    };
    for line in front.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        meta.insert(key.trim().to_string(), unquote(value.trim()));
    }
    let markdown = markdown.trim_start_matches(['\r', '\n']);
    (meta, markdown.to_string())
}

fn unquote(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string()
}

fn first_paragraph(body: &str) -> String {
    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .unwrap_or("custom asset")
        .to_string()
}

fn normalize_name(raw: &str) -> String {
    let mut name = String::new();
    let mut dash = false;
    for ch in raw.trim().chars() {
        let mapped = if ch.is_ascii_alphanumeric() {
            dash = false;
            ch.to_ascii_lowercase()
        } else if ch == ' ' || ch == '_' || ch == '-' {
            if dash || name.is_empty() {
                continue;
            }
            dash = true;
            '-'
        } else {
            continue;
        };
        name.push(mapped);
        if name.len() >= 64 {
            break;
        }
    }
    name.trim_matches('-').to_string()
}

fn flag_true(value: Option<&str>) -> bool {
    matches!(
        value
            .map(|item| item.trim().to_ascii_lowercase())
            .as_deref(),
        Some("true" | "yes" | "on" | "1")
    )
}

/// `user-invocable` defaults to true. Only an explicit false-like value hides it.
fn flag_true_default(value: Option<&str>) -> bool {
    match value
        .map(|item| item.trim().to_ascii_lowercase())
        .as_deref()
    {
        None | Some("") => true,
        Some("false" | "no" | "off" | "0") => false,
        Some(_) => true,
    }
}

fn cap_body(body: &str) -> (String, bool) {
    let cap = SKILL_BODY_TOKEN_CAP.saturating_mul(CHARS_PER_TOKEN);
    let mut end = 0;
    for (index, ch) in body.char_indices() {
        if index + ch.len_utf8() > cap {
            return (body[..end].to_string(), true);
        }
        end = index + ch.len_utf8();
    }
    (body.to_string(), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    fn catalog_for(
        root: &Path,
        project_active: bool,
        extra: &[String],
        disabled: &[String],
    ) -> AssetCatalog {
        let cwd = root.join("repo").join("src");
        discover(&DiscoverInput {
            cwd: &cwd,
            grok_home: &root.join("grok"),
            home: &root.join("home"),
            project_active,
            claude_rules: true,
            cursor_rules: true,
            claude_agents: true,
            claude_skills: true,
            cursor_skills: true,
            extra_rule_dirs: extra,
            skill_paths: &[],
            skill_ignore: &[],
            skill_disabled: disabled,
            builtin_commands: &["compact"],
        })
    }

    fn fixture(root: &Path) {
        let cwd = root.join("repo").join("src");
        fs::create_dir_all(root.join("repo").join(".git")).unwrap();
        write(
            &root.join("grok").join("rules").join("home.md"),
            "HOME_RULE\n",
        );
        write(&root.join("extra").join("extra.md"), "EXTRA_RULE\n");
        write(
            &root.join("extra").join("nested").join("skip.md"),
            "NESTED_RULE\n",
        );
        write(
            &root.join("repo").join("AGENTS.md"),
            "ROOT_RULE styled-components\n",
        );
        write(&cwd.join("AGENTS.md"), "DEEP_RULE css-modules\n");
        write(&cwd.join(".gitignore"), "CLAUDE.local.md\n");
        write(&cwd.join("CLAUDE.local.md"), "IGNORED_LOCAL\n");
        write(
            &cwd.join(".grok").join("rules").join("b.md"),
            "DIR_RULE_B\n",
        );
        write(
            &cwd.join(".grok").join("rules").join("a.md"),
            "DIR_RULE_A\n",
        );
        write(
            &cwd.join(".grok")
                .join("skills")
                .join("commit")
                .join("SKILL.md"),
            "---\nname: commit\ndescription: Create commits. Use when asked to commit.\nargument-hint: message\n---\nCOMMIT_BODY\n",
        );
        write(
            &cwd.join(".grok")
                .join("skills")
                .join("compact")
                .join("SKILL.md"),
            "---\nname: compact\ndescription: Not the builtin.\n---\nSKILL_COMPACT\n",
        );
        write(
            &cwd.join(".grok").join("commands").join("ship-note.md"),
            "---\ndescription: Write a ship note\nargument-hint: ticket\n---\nSHIP_NOTE_BODY\n",
        );
        write(
            &cwd.join(".grok").join("agents").join("reviewer.md"),
            "---\nname: reviewer\ndescription: Reviews diffs\ntools: read\n---\nREVIEWER_BODY\n",
        );
        write(
            &root
                .join("grok")
                .join("skills")
                .join("only-extra")
                .join("SKILL.md"),
            "---\nname: only-extra\ndescription: user skill\n---\nUSER_SKILL\n",
        );
    }

    #[test]
    fn trusted_discovery_orders_rules_and_exposes_commands() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        let extra = root.path().join("extra").display().to_string();
        let catalog = catalog_for(root.path(), true, &[extra, "relative/nope".into()], &[]);
        let joined = catalog
            .rules
            .iter()
            .map(|rule| rule.content.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(joined.contains("HOME_RULE"), "{joined}");
        assert!(joined.contains("EXTRA_RULE"), "{joined}");
        assert!(!joined.contains("NESTED_RULE"), "{joined}");
        assert!(!joined.contains("IGNORED_LOCAL"), "{joined}");
        assert!(joined.find("ROOT_RULE").unwrap() < joined.find("DEEP_RULE").unwrap());
        assert!(joined.find("DIR_RULE_A").unwrap() < joined.find("DIR_RULE_B").unwrap());
        assert!(joined.find("DEEP_RULE").unwrap() < joined.find("DIR_RULE_A").unwrap());
        assert!(
            catalog
                .diagnostics
                .iter()
                .any(|item| item.detail.contains("relative"))
        );
        assert!(
            catalog
                .skills
                .iter()
                .any(|skill| skill.name == "commit" && skill.user_invocable)
        );
        let ship = catalog
            .commands
            .iter()
            .find(|command| command.name == "ship-note")
            .expect("flat commands/*.md is a slash command, not a skill");
        assert!(ship.body.contains("SHIP_NOTE_BODY"));
        assert!(!catalog.skills.iter().any(|skill| skill.name == "ship-note"));
        assert!(
            catalog
                .agents
                .iter()
                .any(|agent| agent.name == "reviewer" && agent.tools == "read")
        );
        assert!(
            catalog
                .skills
                .iter()
                .any(|skill| skill.name == "only-extra")
        );
        let compact = catalog
            .skills
            .iter()
            .find(|skill| skill.name == "compact")
            .unwrap();
        assert_eq!(compact.collides_with.as_deref(), Some("/compact"));
        let menu = menu_entries(&catalog);
        assert!(menu.iter().any(|(name, _)| name == "/local:compact"));
        assert!(!menu.iter().any(|(name, _)| name == "/compact"));
        let prompt = invocation_prompt(&catalog, "/commit fix the build").unwrap();
        assert!(prompt.contains("COMMIT_BODY"));
        assert!(prompt.contains("fix the build"));
        let session = prompt_with_session(&catalog, "ASK", "SESSION_RULE_SENTINEL", false);
        assert!(session.contains("<human_rules>"));
        assert!(session.contains("SESSION_RULE_SENTINEL"));
        assert!(session.contains("HOME_RULE"));
        assert!(session.ends_with("ASK"));
        let replaced = prompt_with_session(&catalog, "ASK", "ONLY_THIS", true);
        assert!(!replaced.contains("HOME_RULE"));
        assert!(replaced.contains("ONLY_THIS"));
        assert!(replaced.ends_with("ASK"));
    }

    #[test]
    fn untrusted_project_assets_do_not_load_but_user_rules_do() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        let catalog = catalog_for(root.path(), false, &[], &[]);
        let joined = catalog
            .rules
            .iter()
            .map(|rule| rule.content.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(joined.contains("HOME_RULE"));
        assert!(!joined.contains("ROOT_RULE"));
        assert!(!joined.contains("DEEP_RULE"));
        assert!(catalog.skills.iter().all(|skill| skill.source != "project"));
        assert!(
            catalog
                .commands
                .iter()
                .all(|command| command.source != "project")
        );
        assert!(catalog.agents.iter().all(|agent| agent.source == "user"));
        assert!(!catalog.agents.iter().any(|agent| agent.name == "reviewer"));
    }

    #[test]
    fn closer_skill_outranks_repo_root_and_same_scope_collisions_stay() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        let cwd = root.path().join("repo").join("src");
        write(
            &root
                .path()
                .join("repo")
                .join(".grok")
                .join("skills")
                .join("commit")
                .join("SKILL.md"),
            "---\nname: commit\ndescription: repo root\n---\nREPO_COMMIT\n",
        );
        write(
            &cwd.join(".grok")
                .join("skills")
                .join("twins")
                .join("SKILL.md"),
            "---\nname: twins\ndescription: first\n---\nTWIN_A\n",
        );
        write(
            &cwd.join(".agents")
                .join("skills")
                .join("twins-b")
                .join("SKILL.md"),
            "---\nname: twins\ndescription: second\n---\nTWIN_B\n",
        );
        write(
            &cwd.join(".grok")
                .join("skills")
                .join("nested")
                .join("deep")
                .join("SKILL.md"),
            "---\nname: nested-deep\ndescription: walked\n---\nNESTED_SKILL\n",
        );
        write(
            &cwd.join(".grok")
                .join("skills")
                .join("nested")
                .join("deep")
                .join("child")
                .join("SKILL.md"),
            "---\nname: nested-child\ndescription: child of a skill directory\n---\nCHILD_SKILL\n",
        );
        write(
            &cwd.join(".grok")
                .join("skills")
                .join("hidden")
                .join("SKILL.md"),
            "---\nname: hidden\nuser-invocable: false\ndescription: model only\n---\nHIDDEN_BODY\n",
        );
        write(
            &cwd.join(".grok")
                .join("skills")
                .join("yes-skill")
                .join("SKILL.md"),
            "---\nname: yes-skill\nuser-invocable: yes\ndescription: still invocable\n---\nYES_BODY\n",
        );
        let catalog = catalog_for(root.path(), true, &[], &[]);
        let commit = catalog
            .skills
            .iter()
            .find(|skill| skill.name == "commit" && !skill.disabled)
            .unwrap();
        assert!(
            commit.body.contains("COMMIT_BODY"),
            "cwd skill must outrank the repo-root body: {}",
            commit.body
        );
        assert!(
            catalog
                .skills
                .iter()
                .any(|skill| skill.name == "nested-deep")
        );
        assert!(
            catalog
                .skills
                .iter()
                .any(|skill| skill.name == "nested-child" && skill.body.contains("CHILD_SKILL")),
            "a child of a directory that already has SKILL.md is still recorded"
        );
        let twins: Vec<_> = catalog
            .skills
            .iter()
            .filter(|skill| skill.name == "twins")
            .collect();
        assert_eq!(twins.len(), 2, "same-scope names both stay invocable");
        assert!(twins.iter().all(|skill| skill.collides_with.is_some()));
        let hidden = catalog
            .skills
            .iter()
            .find(|skill| skill.name == "hidden")
            .unwrap();
        assert!(!hidden.user_invocable);
        assert!(hidden.body.contains("HIDDEN_BODY"));
        let yes = catalog
            .skills
            .iter()
            .find(|skill| skill.name == "yes-skill")
            .unwrap();
        assert!(yes.user_invocable);
        assert!(skill_invocation(&catalog, "/yes-skill").is_some());
        let mut too_deep = cwd.join(".grok").join("skills");
        for part in ["n", "a", "b", "c", "d", "e", "f"] {
            too_deep.push(part);
        }
        write(
            &too_deep.join("SKILL.md"),
            "---\nname: deep7\ndescription: past depth five\n---\nDEEP7_BODY\n",
        );
        let mut at_limit = cwd.join(".grok").join("skills");
        for part in ["n", "a", "b", "c", "d", "e"] {
            at_limit.push(part);
        }
        write(
            &at_limit.join("SKILL.md"),
            "---\nname: deep6\ndescription: depth equals five\n---\nDEEP6_BODY\n",
        );
        let bounded = catalog_for(root.path(), true, &[], &[]);
        assert!(
            bounded.skills.iter().any(|skill| skill.name == "deep6"),
            "depth 5 is still inside the walk"
        );
        assert!(
            !bounded.skills.iter().any(|skill| skill.name == "deep7"),
            "the walk returns when depth is greater than five"
        );
    }

    #[test]
    fn host_slash_names_keep_the_bare_command() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        let cwd = root.path().join("repo").join("src");
        for name in ["login", "logout", "feedback"] {
            write(
                &cwd.join(".grok").join("skills").join(name).join("SKILL.md"),
                &format!(
                    "---\nname: {name}\ndescription: Not the builtin.\n---\n{name}_SKILL_BODY\n"
                ),
            );
        }
        let catalog = discover(&DiscoverInput {
            cwd: &cwd,
            grok_home: &root.path().join("grok"),
            home: &root.path().join("home"),
            project_active: true,
            claude_rules: true,
            cursor_rules: true,
            claude_agents: true,
            claude_skills: true,
            cursor_skills: true,
            extra_rule_dirs: &[],
            skill_paths: &[],
            skill_ignore: &[],
            skill_disabled: &[],
            builtin_commands: crate::prompt_edit::builtin_command_names(),
        });
        let menu = menu_entries(&catalog);
        for name in ["login", "logout", "feedback"] {
            let skill = catalog
                .skills
                .iter()
                .find(|skill| skill.name == name)
                .unwrap();
            let contested = format!("/{name}");
            assert_eq!(
                skill.collides_with.as_deref(),
                Some(contested.as_str()),
                "{name} collides with the host slash command, not another asset"
            );
            assert!(
                skill_invocation(&catalog, &format!("/{name}")).is_none(),
                "bare /{name} stays the built-in"
            );
            assert!(skill_invocation(&catalog, &format!("/local:{name}")).is_some());
            assert!(
                menu.iter()
                    .any(|(label, _)| label == &format!("/local:{name}"))
            );
            assert!(
                !menu.iter().any(|(label, _)| label == &format!("/{name}")),
                "the menu must not offer bare /{name} for the skill"
            );
        }
        for name in ["login", "logout", "feedback"] {
            fs::remove_dir_all(cwd.join(".grok").join("skills").join(name)).unwrap();
            write(
                &cwd.join(".grok")
                    .join("commands")
                    .join(format!("{name}.md")),
                &format!("---\ndescription: Not the builtin.\n---\n{name}_COMMAND_BODY\n"),
            );
        }
        let catalog = discover(&DiscoverInput {
            cwd: &cwd,
            grok_home: &root.path().join("grok"),
            home: &root.path().join("home"),
            project_active: true,
            claude_rules: true,
            cursor_rules: true,
            claude_agents: true,
            claude_skills: true,
            cursor_skills: true,
            extra_rule_dirs: &[],
            skill_paths: &[],
            skill_ignore: &[],
            skill_disabled: &[],
            builtin_commands: crate::prompt_edit::builtin_command_names(),
        });
        let menu = menu_entries(&catalog);
        for name in ["login", "logout", "feedback"] {
            let command = catalog
                .commands
                .iter()
                .find(|command| command.name == name)
                .unwrap();
            let contested = format!("/{name}");
            assert_eq!(command.collides_with.as_deref(), Some(contested.as_str()));
            assert!(command_invocation(&catalog, &format!("/{name}")).is_none());
            assert!(command_invocation(&catalog, &format!("/local:{name}")).is_some());
            assert!(
                menu.iter()
                    .any(|(label, _)| label == &format!("/local:{name}"))
            );
            assert!(!menu.iter().any(|(label, _)| label == &format!("/{name}")));
        }
    }

    #[test]
    fn gitignore_patterns_skip_rules_but_not_skill_roots() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        let cwd = root.path().join("repo").join("src");
        write(&cwd.join(".gitignore"), "*.local.md\nnotes/\n.claude/\n");
        write(&cwd.join("CLAUDE.local.md"), "GLOB_LOCAL\n");
        fs::create_dir_all(cwd.join("notes")).unwrap();
        write(&cwd.join("notes").join("AGENTS.md"), "DIR_IGNORED\n");
        write(
            &cwd.join(".claude").join("commands").join("frontend.md"),
            "---\ndescription: frontend command\n---\nFRONTEND_BODY\n",
        );
        write(
            &cwd.join(".cursor")
                .join("skills")
                .join("shell")
                .join("SKILL.md"),
            "---\nname: shell\ndescription: vendor default\n---\nVENDOR_SHELL\n",
        );
        write(
            &cwd.join(".grok")
                .join("skills")
                .join("shell")
                .join("SKILL.md"),
            "---\nname: shell\ndescription: user shell skill\n---\nUSER_SHELL\n",
        );
        let catalog = catalog_for(root.path(), true, &[], &[]);
        let joined = catalog
            .rules
            .iter()
            .map(|rule| rule.content.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!joined.contains("GLOB_LOCAL"), "{joined}");
        assert!(!joined.contains("DIR_IGNORED"), "{joined}");
        assert!(
            catalog
                .commands
                .iter()
                .any(|command| command.name == "frontend" && command.body.contains("FRONTEND_BODY")),
            "skill roots ignore .gitignore"
        );
        assert!(
            catalog
                .skills
                .iter()
                .any(|skill| skill.name == "shell" && skill.body.contains("USER_SHELL"))
        );
        assert!(
            !catalog
                .skills
                .iter()
                .any(|skill| skill.body.contains("VENDOR_SHELL"))
        );
    }

    #[test]
    fn disabled_skill_stays_listed_and_ancestor_tiers_keep_distinct_scope() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        let repo = root.path().join("repo");
        let mid = repo.join("pkg");
        let cwd = mid.join("src");
        write(
            &mid.join(".grok")
                .join("skills")
                .join("mid-skill")
                .join("SKILL.md"),
            "---\nname: mid-skill\ndescription: ancestor\n---\nMID_BODY\n",
        );
        write(
            &cwd.join(".grok")
                .join("skills")
                .join("commit")
                .join("SKILL.md"),
            "---\nname: commit\ndescription: Create commits. Use when asked to commit.\n---\nCOMMIT_BODY\n",
        );
        let catalog = discover(&DiscoverInput {
            cwd: &cwd,
            grok_home: &root.path().join("grok"),
            home: &root.path().join("home"),
            project_active: true,
            claude_rules: true,
            cursor_rules: true,
            claude_agents: true,
            claude_skills: true,
            cursor_skills: true,
            extra_rule_dirs: &[],
            skill_paths: &[],
            skill_ignore: &[],
            skill_disabled: &["commit".into()],
            builtin_commands: &["compact"],
        });
        let mid_skill = catalog
            .skills
            .iter()
            .find(|skill| skill.name == "mid-skill")
            .expect("intermediate ancestor is its own tier");
        assert!(
            !mid_skill.qualified.starts_with("local:") && !mid_skill.qualified.starts_with("repo:"),
            "intermediate ancestor keeps its own scope: {}",
            mid_skill.qualified
        );
        let commit = catalog
            .skills
            .iter()
            .find(|skill| skill.name == "commit")
            .unwrap();
        assert!(commit.disabled);
        assert!(
            commit.body.contains("COMMIT_BODY"),
            "disabled skills stay listed with their body"
        );
        assert!(skill_invocation(&catalog, "/commit").is_none());
        assert!(inspect_text(&catalog).contains("[disabled]"));
    }

    #[test]
    fn disabled_skill_is_not_invocable_and_long_body_truncates() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        let cwd = root.path().join("repo").join("src");
        write(
            &cwd.join(".grok")
                .join("skills")
                .join("huge")
                .join("SKILL.md"),
            &format!(
                "---\nname: huge\ndescription: big\n---\n{}\n",
                "Z".repeat(120_000)
            ),
        );
        let catalog = catalog_for(root.path(), true, &[], &["commit".into()]);
        let commit = catalog
            .skills
            .iter()
            .find(|skill| skill.name == "commit")
            .unwrap();
        assert!(commit.disabled);
        assert!(skill_invocation(&catalog, "/commit").is_none());
        let huge = catalog
            .skills
            .iter()
            .find(|skill| skill.name == "huge")
            .unwrap();
        assert!(huge.truncated);
        assert!(huge.body.chars().count() <= SKILL_BODY_TOKEN_CAP * CHARS_PER_TOKEN);
        assert!(
            catalog
                .diagnostics
                .iter()
                .any(|item| item.kind == "skill-truncation")
        );
    }

    #[test]
    fn extra_skill_dirs_are_not_discovery_roots() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        write(
            &root
                .path()
                .join("only-extra-dir")
                .join("smuggled")
                .join("SKILL.md"),
            "---\nname: smuggled\ndescription: no\n---\nSMUGGLED\n",
        );
        let catalog = discover(&DiscoverInput {
            cwd: &root.path().join("repo").join("src"),
            grok_home: &root.path().join("grok"),
            home: &root.path().join("home"),
            project_active: true,
            claude_rules: true,
            cursor_rules: false,
            claude_agents: true,
            claude_skills: true,
            cursor_skills: false,
            extra_rule_dirs: &[],
            skill_paths: &[],
            skill_ignore: &[],
            skill_disabled: &[],
            builtin_commands: &[],
        });
        assert!(!catalog.skills.iter().any(|skill| skill.name == "smuggled"));
    }

    #[test]
    fn configured_skill_path_uses_the_same_depth_cap() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        let base = root.path().join("configured");
        write(
            &base.join("SKILL.md"),
            "---\nname: config-root\ndescription: the configured directory itself\n---\nCONFIG_ROOT\n",
        );
        let mut at_limit = base.clone();
        for part in ["a", "b", "c", "d", "e"] {
            at_limit.push(part);
        }
        write(
            &at_limit.join("SKILL.md"),
            "---\nname: config-deep5\ndescription: fifth child under a configured path\n---\nCONFIG_DEEP5\n",
        );
        write(
            &at_limit.join("child").join("SKILL.md"),
            "---\nname: config-sixth\ndescription: sixth child under a configured path\n---\nCONFIG_SIXTH\n",
        );
        let mut too_deep = base.clone();
        for part in ["z", "a", "b", "c", "d", "e", "f"] {
            too_deep.push(part);
        }
        write(
            &too_deep.join("SKILL.md"),
            "---\nname: config-deep7\ndescription: seventh child under a configured path\n---\nCONFIG_DEEP7\n",
        );
        let path = base.display().to_string();
        let catalog = discover(&DiscoverInput {
            cwd: &root.path().join("repo").join("src"),
            grok_home: &root.path().join("grok"),
            home: &root.path().join("home"),
            project_active: true,
            claude_rules: true,
            cursor_rules: false,
            claude_agents: true,
            claude_skills: true,
            cursor_skills: false,
            extra_rule_dirs: &[],
            skill_paths: &[path],
            skill_ignore: &[],
            skill_disabled: &[],
            builtin_commands: &[],
        });
        assert!(
            catalog
                .skills
                .iter()
                .any(|skill| skill.name == "config-root" && skill.body.contains("CONFIG_ROOT")),
            "a configured directory loads its own SKILL.md"
        );
        assert!(
            catalog
                .skills
                .iter()
                .any(|skill| skill.name == "config-deep5" && skill.body.contains("CONFIG_DEEP5")),
            "the fifth child under a configured path is depth five"
        );
        assert!(
            !catalog
                .skills
                .iter()
                .any(|skill| skill.name == "config-sixth"),
            "a configured path starts children at depth 1, so the sixth child is not loaded"
        );
        assert!(
            !catalog
                .skills
                .iter()
                .any(|skill| skill.name == "config-deep7"),
            "a configured path returns when depth is greater than five"
        );
    }
}
