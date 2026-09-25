//! Personal and project workflow catalog (ticket 184).
//!
//! The reference registry (`xai-grok-shell` `session/workflow/registry.rs`)
//! scans bundled, built-in, project and user workflows in that order and keeps
//! the first definition of each name. This build has no bundled or built-in
//! workflows (service flows such as deep research ship in their own tickets),
//! so the catalog is the project's `.grok/workflows` (only in a trusted
//! folder; it shadows the user scope) and `$GROK_HOME/workflows`.
//!
//! Discovery reads files and never runs them: a `.rhai` file is read with the
//! trusted-source rules (no symlink, regular file, at most 1 MiB, UTF-8), its
//! leading `meta` literal is parsed, and its stem must equal `meta.name`.
//! Files that fail are listed as skipped with the reason instead of being
//! dropped silently. Two definitions of one name in the same scope make the
//! name ambiguous (the reference `DuplicateName`). A run copies the script it
//! resolved at launch, so editing the file later changes new launches only.
//!
//! Ticket 205 adds plugin workflows: an active plugin (installed, enabled,
//! trusted, present; project plugins also need workspace trust) contributes
//! the `.rhai` files of its `workflows` directories. The reference registry
//! has no plugin scope, so this follows the plugin asset rule of ticket 166:
//! a plugin workflow always runs as `<plugin>:<name>`, and also as the bare
//! `<name>` unless a project or personal workflow owns that name or another
//! active plugin offers it too. A disabled, blocked, missing or shadowed
//! plugin loads nothing; its names are refused with the plugin's state.
//!
//! `save_project` is the reference `save_project_workflow`: folder trust is
//! required, the directories are created one real component at a time under
//! the canonical project root, and the file is created atomically without
//! replacing an existing one.

use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};
use xai_workflow::WorkflowMeta;

use crate::plugin::PluginWorkflowSource;
use crate::workflow::{
    MAX_WORKFLOW_SOURCE_BYTES, Scope, invalid_name, parse_workflow, project_root,
    read_trusted_source, valid_name,
};

/// Reference listing caps (`session/workflow/listing.rs`).
const MAX_LISTING_COMBINED_BYTES: usize = 400;
const MIN_FIELD_BYTES: usize = 20;
pub const LISTING_HEADER: &str = "The following workflows are available:\n\n";
const TRUNCATION_MARKER: &str = "…";
/// Skipped files shown by `/workflows` before "and N more".
const MAX_SHOWN_INVALID: usize = 10;
const MAX_SHOWN_ERROR_BYTES: usize = 240;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CatalogScope {
    Project,
    User,
    Plugin,
}

impl CatalogScope {
    pub fn label(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::User => "user",
            Self::Plugin => "plugin",
        }
    }
}

/// The plugin a workflow came from: identity, provenance and trust, kept
/// with every run it starts (ticket 205).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginOrigin {
    pub name: String,
    /// `user` (installed) or `project` (`.grok/plugins`).
    pub scope: String,
    pub version: Option<String>,
    pub license: Option<String>,
    pub source: String,
    pub marketplace: Option<String>,
    pub commit: Option<String>,
    pub trusted: bool,
}

impl PluginOrigin {
    fn from_source(source: &PluginWorkflowSource) -> Self {
        Self {
            name: source.name.clone(),
            scope: source.scope.clone(),
            version: source.version.clone(),
            license: source.license.clone(),
            source: source.source.clone(),
            marketplace: source.marketplace.clone(),
            commit: source.commit.clone(),
            trusted: source.trusted,
        }
    }

    /// `demo 1.2.0 · license MIT · user plugin · trusted · source … · commit …`.
    pub fn describe(&self) -> String {
        let mut parts = vec![match &self.version {
            Some(version) => format!("{} {version}", self.name),
            None => format!("{} (no version)", self.name),
        }];
        parts.push(format!(
            "license {}",
            self.license.as_deref().unwrap_or("not declared")
        ));
        parts.push(format!("{} plugin", self.scope));
        parts.push(
            if self.trusted {
                "trusted"
            } else {
                "not trusted"
            }
            .into(),
        );
        if let Some(marketplace) = &self.marketplace {
            parts.push(format!("marketplace {marketplace}"));
        }
        parts.push(format!("source {}", self.source));
        if let Some(commit) = &self.commit {
            parts.push(format!("commit {}", &commit[..commit.len().min(12)]));
        }
        parts.join(" · ")
    }

    pub fn json(&self) -> Value {
        json!({
            "name": self.name,
            "scope": self.scope,
            "version": self.version,
            "license": self.license,
            "source": self.source,
            "marketplace": self.marketplace,
            "commit": self.commit,
            "trusted": self.trusted,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub meta: WorkflowMeta,
    pub script: String,
    pub scope: CatalogScope,
    pub path: PathBuf,
    /// Set for a plugin workflow.
    pub plugin: Option<PluginOrigin>,
    /// Whether the bare `meta.name` runs this entry (always for project and
    /// personal workflows; for a plugin one only when nothing else owns it).
    pub bare: bool,
}

impl Entry {
    /// `<plugin>:<name>` for a plugin workflow.
    pub fn qualified(&self) -> Option<String> {
        self.plugin
            .as_ref()
            .map(|plugin| format!("{}:{}", plugin.name, self.meta.name))
    }

    /// The name that runs this entry: bare when it owns the name.
    pub fn call_name(&self) -> String {
        match self.qualified() {
            Some(qualified) if !self.bare => qualified,
            _ => self.meta.name.clone(),
        }
    }

    /// `project`, `user`, or `plugin <name>`.
    pub fn scope_label(&self) -> String {
        match &self.plugin {
            Some(plugin) => format!("plugin {}", plugin.name),
            None => self.scope.label().to_string(),
        }
    }

    /// What a run keeps about where its script came from.
    pub fn origin_json(&self) -> Value {
        json!({
            "scope": self.scope.label(),
            "callName": self.call_name(),
            "path": self.path.display().to_string(),
            "plugin": self.plugin.as_ref().map(PluginOrigin::json),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub path: PathBuf,
    pub scope: CatalogScope,
    pub error: String,
    /// The plugin whose workflow directory held the file.
    pub plugin: Option<String>,
}

/// An installed plugin with workflow directories, in any state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginState {
    pub origin: PluginOrigin,
    /// `active`, `disabled`, `blocked`, `missing`, or `shadowed`.
    pub status: String,
    pub detail: String,
    /// `.rhai` file stems in its workflow directories (read, never run).
    pub files: Vec<String>,
    pub problems: Vec<String>,
}

impl PluginState {
    fn active(&self) -> bool {
        self.status == "active"
    }

    fn unavailable(&self, name: &str) -> String {
        format!(
            "workflow '{name}' is not available: plugin '{}' is {} ({})",
            self.origin.name, self.status, self.detail
        )
    }
}

#[derive(Debug, Clone)]
pub struct Catalog {
    /// Runnable definitions, project scope first, each scope by file name.
    pub entries: Vec<Entry>,
    /// Lower-scope definitions hidden by a same-named higher one.
    pub shadowed: Vec<Entry>,
    /// Names defined twice in one scope: not runnable (reference error).
    pub duplicates: BTreeMap<String, CatalogScope>,
    pub skipped: Vec<Skipped>,
    pub project_dir: PathBuf,
    pub project_trusted: bool,
    pub user_dir: Option<PathBuf>,
    /// Installed plugins that declare workflows, active or not.
    pub plugins: Vec<PluginState>,
    /// Bare names several active plugins offer: only `<plugin>:<name>` runs.
    pub plugin_conflicts: BTreeMap<String, Vec<String>>,
}

impl Catalog {
    /// The reference `resolve_entry`: an ambiguous name is refused before a
    /// runnable same-named entry of a lower scope is considered. A
    /// `<plugin>:<name>` names one plugin's workflow.
    pub fn find(&self, name: &str) -> Result<&Entry, String> {
        if let Some(scope) = self.duplicates.get(name) {
            return Err(match name.split_once(':') {
                Some((plugin, _)) => {
                    format!("ambiguous workflow '{name}': duplicate definitions in plugin {plugin}")
                }
                None => format!(
                    "ambiguous workflow '{name}': duplicate definitions in {} scope",
                    scope.label()
                ),
            });
        }
        let stem_of =
            |bad: &Skipped, stem: &str| bad.path.file_name().and_then(|n| n.to_str()) == Some(stem);
        let invalid = |bad: &Skipped, name: &str| {
            format!(
                "workflow '{name}' is not loaded: {} is invalid: {}",
                bad.path.display(),
                bad.error
            )
        };
        if let Some((plugin, workflow)) = name.split_once(':') {
            if let Some(entry) = self.entries.iter().find(|entry| {
                entry
                    .plugin
                    .as_ref()
                    .is_some_and(|origin| origin.name == plugin)
                    && entry.meta.name == workflow
            }) {
                return Ok(entry);
            }
            if let Some(state) = self
                .plugins
                .iter()
                .find(|state| state.origin.name == plugin)
                && !state.active()
            {
                return Err(state.unavailable(name));
            }
            let stem = format!("{workflow}.rhai");
            if let Some(bad) = self
                .skipped
                .iter()
                .find(|bad| bad.plugin.as_deref() == Some(plugin) && stem_of(bad, &stem))
            {
                return Err(invalid(bad, name));
            }
            return Err(format!("unknown workflow: {name}"));
        }
        if let Some(entry) = self
            .entries
            .iter()
            .find(|entry| entry.bare && entry.meta.name == name)
        {
            return Ok(entry);
        }
        if let Some(owners) = self.plugin_conflicts.get(name) {
            let qualified: Vec<String> = owners
                .iter()
                .map(|owner| format!("{owner}:{name}"))
                .collect();
            return Err(format!(
                "ambiguous workflow '{name}': offered by plugins {}; run {}",
                owners.join(", "),
                qualified.join(" or ")
            ));
        }
        // A file named after the workflow that failed to load is named in the
        // error, so the user learns why `/<name>` does nothing.
        let stem = format!("{name}.rhai");
        if let Some(bad) = self
            .skipped
            .iter()
            .filter(|bad| stem_of(bad, &stem))
            .min_by_key(|bad| bad.plugin.is_some())
        {
            return Err(invalid(bad, name));
        }
        if let Some(state) = self
            .plugins
            .iter()
            .find(|state| !state.active() && state.files.iter().any(|file| file == name))
        {
            return Err(state.unavailable(name));
        }
        Err(format!("unknown workflow: {name}"))
    }

    /// Whether `name` means something to the catalog: runnable, or refused
    /// with a reason other than "unknown".
    pub fn knows(&self, name: &str) -> bool {
        !matches!(self.find(name), Err(error) if error.starts_with("unknown workflow:"))
    }
}

/// Scan the catalog for a session directory (reference `WorkflowRegistry::scan`)
/// with the installed plugins of `$GROK_HOME`.
pub fn scan(scope: &Scope) -> Catalog {
    let plugins = match &scope.grok_home {
        Some(home) => crate::plugin::workflow_sources(home, &scope.cwd, scope.trusted),
        None => Vec::new(),
    };
    scan_with(scope, &plugins)
}

/// [`scan`] with the plugin sources given.
pub fn scan_with(scope: &Scope, plugins: &[PluginWorkflowSource]) -> Catalog {
    let project_dir = project_root(&scope.cwd).join(".grok").join("workflows");
    let user_dir = scope.grok_home.as_ref().map(|home| home.join("workflows"));
    let mut catalog = Catalog {
        entries: Vec::new(),
        shadowed: Vec::new(),
        duplicates: BTreeMap::new(),
        skipped: Vec::new(),
        project_dir: project_dir.clone(),
        project_trusted: scope.trusted,
        user_dir: user_dir.clone(),
        plugins: Vec::new(),
        plugin_conflicts: BTreeMap::new(),
    };
    let mut dirs = Vec::new();
    if scope.trusted {
        dirs.push((project_dir, CatalogScope::Project));
    }
    if let Some(dir) = user_dir {
        dirs.push((dir, CatalogScope::User));
    }
    for (dir, label) in dirs {
        let (mut scoped, skipped) = scan_directory(&dir, label);
        catalog.skipped.extend(skipped);
        reject_same_scope_duplicates(&mut scoped, label, &mut catalog.duplicates);
        merge_scope(&mut catalog, scoped);
    }
    // An ambiguous name resolves to an error, so no entry of it is runnable.
    let (runnable, ambiguous): (Vec<Entry>, Vec<Entry>) = std::mem::take(&mut catalog.entries)
        .into_iter()
        .partition(|entry| !catalog.duplicates.contains_key(&entry.meta.name));
    catalog.entries = runnable;
    catalog.shadowed.extend(ambiguous);
    add_plugins(&mut catalog, plugins);
    catalog
}

/// Active plugins' workflows after the project and personal ones; every
/// plugin with workflow directories is recorded with its state.
fn add_plugins(catalog: &mut Catalog, plugins: &[PluginWorkflowSource]) {
    let mut contributed = Vec::new();
    for source in plugins {
        let origin = PluginOrigin::from_source(source);
        let files = rhai_stems(&source.dirs);
        catalog.plugins.push(PluginState {
            origin: origin.clone(),
            status: source.status.clone(),
            detail: source.status_detail.clone(),
            files,
            problems: source.problems.clone(),
        });
        if source.status != "active" {
            continue;
        }
        let mut scoped = Vec::new();
        for dir in &source.dirs {
            let (entries, skipped) = scan_directory(dir, CatalogScope::Plugin);
            scoped.extend(entries.into_iter().map(|mut entry| {
                entry.plugin = Some(origin.clone());
                entry.bare = false;
                entry
            }));
            catalog.skipped.extend(skipped.into_iter().map(|mut bad| {
                bad.plugin = Some(source.name.clone());
                bad
            }));
        }
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for entry in &scoped {
            *counts.entry(entry.meta.name.clone()).or_default() += 1;
        }
        for (name, count) in counts {
            if count > 1 {
                let (twice, rest): (Vec<Entry>, Vec<Entry>) = scoped
                    .into_iter()
                    .partition(|entry| entry.meta.name == name);
                scoped = rest;
                catalog.shadowed.extend(twice);
                catalog
                    .duplicates
                    .insert(format!("{}:{name}", source.name), CatalogScope::Plugin);
            }
        }
        contributed.extend(scoped);
    }
    let mut offered: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for entry in &contributed {
        if let Some(plugin) = &entry.plugin {
            offered
                .entry(entry.meta.name.clone())
                .or_default()
                .push(plugin.name.clone());
        }
    }
    for entry in &mut contributed {
        let name = &entry.meta.name;
        let local = catalog
            .entries
            .iter()
            .any(|existing| existing.meta.name == *name)
            || catalog.duplicates.contains_key(name);
        entry.bare = !local && offered.get(name).is_some_and(|owners| owners.len() == 1);
    }
    catalog.plugin_conflicts = offered
        .into_iter()
        .filter(|(_, owners)| owners.len() > 1)
        .collect();
    catalog.entries.extend(contributed);
}

/// `.rhai` file stems of some directories, without reading the files.
fn rhai_stems(dirs: &[PathBuf]) -> Vec<String> {
    let mut stems: Vec<String> = dirs
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("rhai"))
        .filter_map(|path| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_string)
        })
        .collect();
    stems.sort();
    stems.dedup();
    stems
}

/// A plugin's workflows by the qualified name that runs them, and the files
/// that do not load, for `plugin list` / `inspect` / `/plugins`.
pub fn plugin_workflow_names(plugin: &str, dirs: &[PathBuf]) -> (Vec<String>, Vec<String>) {
    let mut names = Vec::new();
    let mut problems = Vec::new();
    for dir in dirs {
        let (entries, skipped) = scan_directory(dir, CatalogScope::Plugin);
        for entry in entries {
            let qualified = format!("{plugin}:{}", entry.meta.name);
            if names.contains(&qualified) {
                problems.push(format!(
                    "workflow {qualified} is defined twice in this plugin; neither runs"
                ));
            } else {
                names.push(qualified);
            }
        }
        for bad in skipped {
            problems.push(format!(
                "workflow {} not loaded: {}",
                bad.path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| bad.path.display().to_string()),
                bad.error
            ));
        }
    }
    (names, problems)
}

fn merge_scope(catalog: &mut Catalog, scoped: Vec<Entry>) {
    for entry in scoped {
        if catalog
            .entries
            .iter()
            .any(|existing| existing.meta.name == entry.meta.name)
        {
            catalog.shadowed.push(entry);
        } else {
            catalog.entries.push(entry);
        }
    }
}

fn reject_same_scope_duplicates(
    entries: &mut Vec<Entry>,
    scope: CatalogScope,
    duplicates: &mut BTreeMap<String, CatalogScope>,
) {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for entry in entries.iter() {
        *counts.entry(entry.meta.name.clone()).or_default() += 1;
    }
    for (name, count) in counts {
        if count > 1 {
            entries.retain(|entry| entry.meta.name != name);
            duplicates.insert(name, scope);
        }
    }
}

/// Every `*.rhai` file of one directory, by file name. A symlinked or
/// non-directory `workflows` entry is skipped whole, as in the reference.
fn scan_directory(dir: &Path, scope: CatalogScope) -> (Vec<Entry>, Vec<Skipped>) {
    let mut skipped = Vec::new();
    let Ok(dir_meta) = std::fs::symlink_metadata(dir) else {
        return (Vec::new(), skipped);
    };
    if dir_meta.file_type().is_symlink() || !dir_meta.is_dir() {
        skipped.push(Skipped {
            path: dir.to_path_buf(),
            scope,
            error: "workflow directory is a symlink or not a directory; nothing in it is loaded"
                .into(),
            plugin: None,
        });
        return (Vec::new(), skipped);
    }
    let read_dir = match std::fs::read_dir(dir) {
        Ok(read_dir) => read_dir,
        Err(error) => {
            skipped.push(Skipped {
                path: dir.to_path_buf(),
                scope,
                error: format!("failed to read {}: {error}", dir.display()),
                plugin: None,
            });
            return (Vec::new(), skipped);
        }
    };
    let mut paths: Vec<PathBuf> = read_dir
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("rhai"))
        .collect();
    paths.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    let mut entries = Vec::new();
    for path in paths {
        let loaded = read_trusted_source(&path)
            .and_then(|script| parse_workflow(&script, Some(&path)).map(|meta| (meta, script)));
        match loaded {
            Ok((meta, script)) => entries.push(Entry {
                meta,
                script,
                scope,
                path,
                plugin: None,
                bare: true,
            }),
            Err(error) => skipped.push(Skipped {
                path,
                scope,
                error,
                plugin: None,
            }),
        }
    }
    (entries, skipped)
}

fn truncate_with_marker(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    if TRUNCATION_MARKER.len() > max_bytes {
        let mut end = max_bytes;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        return text[..end].to_string();
    }
    let mut end = max_bytes - TRUNCATION_MARKER.len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{TRUNCATION_MARKER}", &text[..end])
}

fn field_budgets(description: &str, when_to_use: Option<&str>) -> (usize, usize) {
    let Some(when) = when_to_use.filter(|text| !text.is_empty()) else {
        return (MAX_LISTING_COMBINED_BYTES, 0);
    };
    let desc_len = description.len().max(1);
    let when_len = when.len().max(1);
    let desc_budget = MAX_LISTING_COMBINED_BYTES * desc_len / (desc_len + when_len);
    let when_budget = MAX_LISTING_COMBINED_BYTES.saturating_sub(desc_budget);
    if desc_budget < MIN_FIELD_BYTES && when_budget > MIN_FIELD_BYTES {
        (
            MIN_FIELD_BYTES,
            MAX_LISTING_COMBINED_BYTES.saturating_sub(MIN_FIELD_BYTES),
        )
    } else if when_budget < MIN_FIELD_BYTES && desc_budget > MIN_FIELD_BYTES {
        (
            MAX_LISTING_COMBINED_BYTES.saturating_sub(MIN_FIELD_BYTES),
            MIN_FIELD_BYTES,
        )
    } else {
        (desc_budget, when_budget)
    }
}

/// The reference model listing (`format_workflow_listing`), or `None` for an
/// empty catalog.
pub fn listing(catalog: &Catalog) -> Option<String> {
    if catalog.entries.is_empty() {
        return None;
    }
    let mut body = String::from(LISTING_HEADER);
    for (index, entry) in catalog.entries.iter().enumerate() {
        if index > 0 {
            body.push('\n');
        }
        let when = entry.meta.when_to_use.as_deref();
        let (desc_budget, when_budget) = field_budgets(&entry.meta.description, when);
        body.push_str(&format!(
            "- {}: {}",
            entry.call_name(),
            truncate_with_marker(&entry.meta.description, desc_budget)
        ));
        if let Some(when) = when.filter(|text| !text.is_empty()) {
            body.push_str(&format!(
                "\n  Use when: {}",
                truncate_with_marker(when, when_budget)
            ));
        }
        body.push_str(&format!("\n  Absolute path: {}", entry.path.display()));
    }
    Some(body)
}

fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `/workflows`: the catalog in a few lines that fit the status area (the
/// client keeps the last lines of a tall notice, so the run hint comes last).
/// Every name that is not runnable is counted with where to look, and
/// `/workflows <name>` gives one workflow's details. `taken(name)` says
/// whether `/<name>` is already a command.
pub fn overview(catalog: &Catalog, taken: &dyn Fn(&str) -> bool) -> String {
    let mut lines = Vec::new();
    if catalog.entries.is_empty() {
        lines.push("No saved workflows found.".to_string());
    } else {
        let names: Vec<String> = catalog
            .entries
            .iter()
            .map(|entry| {
                let name = entry.call_name();
                if taken(&name) {
                    format!(
                        "{name} [{}, run with /workflow {name}]",
                        entry.scope_label()
                    )
                } else {
                    format!("/{name} [{}]", entry.scope_label())
                }
            })
            .collect();
        lines.push(format!(
            "Saved workflows ({}): {}.",
            catalog.entries.len(),
            names.join(", ")
        ));
    }
    let mut hidden: Vec<String> = catalog
        .shadowed
        .iter()
        .filter(|entry| {
            entry.plugin.is_none() && !catalog.duplicates.contains_key(&entry.meta.name)
        })
        .map(|entry| format!("{} [{}]", entry.meta.name, entry.scope.label()))
        .collect();
    hidden.dedup();
    let mut problems = Vec::new();
    if !hidden.is_empty() {
        problems.push(format!(
            "Hidden: {} (a project workflow of the same name takes precedence)",
            hidden.join(", ")
        ));
    }
    for (name, scope) in &catalog.duplicates {
        match name.split_once(':') {
            Some((plugin, _)) => problems.push(format!(
                "Not runnable: '{name}' is defined twice in plugin {plugin} (ambiguous)"
            )),
            None => problems.push(format!(
                "Not runnable: '{name}' is defined twice in {} scope (ambiguous)",
                scope.label()
            )),
        }
    }
    if !catalog.skipped.is_empty() {
        let files: Vec<String> = catalog
            .skipped
            .iter()
            .take(MAX_SHOWN_INVALID)
            .map(|bad| {
                let file = bad
                    .path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| bad.path.display().to_string());
                match &bad.plugin {
                    Some(plugin) => format!("{file} [plugin {plugin}]"),
                    None => format!("{file} [{}]", bad.scope.label()),
                }
            })
            .collect();
        let more = catalog.skipped.len().saturating_sub(MAX_SHOWN_INVALID);
        problems.push(format!(
            "Not loaded (invalid, never run): {}{}",
            files.join(", "),
            if more > 0 {
                format!(" and {more} more")
            } else {
                String::new()
            }
        ));
    }
    // Plugin notes share the problems line so the overview still fits.
    problems.extend(plugin_notes(catalog));
    if !problems.is_empty() {
        lines.push(format!(
            "{}; /workflows <name> says why.",
            problems.join("; ")
        ));
    }
    let user = catalog
        .user_dir
        .as_ref()
        .map(|dir| format!("{} (user)", dir.display()))
        .unwrap_or_else(|| "no user folder (GROK_HOME is unset)".into());
    if catalog.project_trusted {
        lines.push(format!(
            "Folders: {} (project, first), {user}, then active plugins. Built-in workflows ship separately.",
            catalog.project_dir.display()
        ));
    } else {
        lines.push(format!(
            "Folders: {user}, then active plugins; {} loads once this folder is trusted. Built-in workflows ship separately.",
            catalog.project_dir.display()
        ));
    }
    if catalog.entries.is_empty() {
        lines.push("Add <name>.rhai files (named after meta.name) to a folder above, save a run with /workflow save <name>, or enable a plugin that ships workflows.".into());
    } else {
        lines.push("Run /<name> or /workflow <name> [--agent-budget N] [--effort LEVEL] [text | JSON args]; details: /workflows <name>; keep a run: /workflow save <name>.".into());
    }
    lines.join("\n")
}

/// Plugin workflows that only run qualified, offered by several plugins, or
/// not loaded because their plugin is not active.
fn plugin_notes(catalog: &Catalog) -> Vec<String> {
    let mut notes = Vec::new();
    let qualified_only: Vec<String> = catalog
        .entries
        .iter()
        .filter(|entry| {
            entry.plugin.is_some()
                && !entry.bare
                && !catalog.plugin_conflicts.contains_key(&entry.meta.name)
        })
        .filter_map(Entry::qualified)
        .collect();
    if !qualified_only.is_empty() {
        notes.push(format!("Qualified only: {}", qualified_only.join(", ")));
    }
    for (name, owners) in &catalog.plugin_conflicts {
        let runs: Vec<String> = owners
            .iter()
            .map(|owner| format!("{owner}:{name}"))
            .collect();
        notes.push(format!(
            "'{name}' is offered by plugins {}; run {}",
            owners.join(", "),
            runs.join(" or ")
        ));
    }
    let inactive: Vec<String> = catalog
        .plugins
        .iter()
        .filter(|state| !state.active() && !state.files.is_empty())
        .map(|state| {
            format!(
                "{} ({}, {} workflow{})",
                state.origin.name,
                state.status,
                state.files.len(),
                if state.files.len() == 1 { "" } else { "s" }
            )
        })
        .collect();
    if !inactive.is_empty() {
        notes.push(format!(
            "Plugin workflows not loaded: {}",
            inactive.join(", ")
        ));
    }
    notes
}

/// `/workflows <name>`: one workflow's description, how to run it, its file,
/// and the copies it hides; or why a file of that name is not loaded.
pub fn detail(catalog: &Catalog, name: &str, taken: &dyn Fn(&str) -> bool) -> String {
    let (plugin_part, bare_name) = match name.split_once(':') {
        Some((plugin, workflow)) => (Some(plugin), workflow),
        None => (None, name),
    };
    let file = format!("{bare_name}.rhai");
    let mut lines = Vec::new();
    let matches = |entry: &Entry| match plugin_part {
        Some(plugin) => {
            entry.meta.name == bare_name
                && entry
                    .plugin
                    .as_ref()
                    .is_some_and(|origin| origin.name == plugin)
        }
        None => entry.meta.name == name,
    };
    for entry in catalog.entries.iter().filter(|entry| matches(entry)) {
        let call = entry.call_name();
        lines.push(format!(
            "{call} [{}] — {}",
            entry.scope_label(),
            truncate_with_marker(&squash(&entry.meta.description), 400)
        ));
        if let Some(when) = entry.meta.when_to_use.as_deref().filter(|w| !w.is_empty()) {
            lines.push(format!(
                "Use when: {}",
                truncate_with_marker(&squash(when), 400)
            ));
        }
        let qualified = entry.qualified().filter(|qualified| *qualified != call);
        let mut runs = Vec::new();
        for run in std::iter::once(call.clone()).chain(qualified) {
            if taken(&run) {
                runs.push(format!(
                    "/workflow {run} [args] (/{run} is taken by another command)"
                ));
            } else {
                runs.push(format!("/{run} [args] or /workflow {run} [args]"));
            }
        }
        lines.push(format!("Run: {}", runs.join("; ")));
        if let Some(origin) = &entry.plugin {
            lines.push(format!("Plugin: {}", origin.describe()));
            if !entry.bare {
                let why = if catalog.plugin_conflicts.contains_key(&entry.meta.name) {
                    "other plugins offer it too"
                } else {
                    "a project or personal workflow owns it"
                };
                lines.push(format!(
                    "/{} does not run this one: {why}.",
                    entry.meta.name
                ));
            }
        }
        lines.push(format!("Path: {}", entry.path.display()));
    }
    for entry in catalog.shadowed.iter().filter(|entry| matches(entry)) {
        let why = match &entry.plugin {
            Some(_) => "the name is defined twice in this plugin".to_string(),
            None if catalog.duplicates.contains_key(name) => "the name is ambiguous".into(),
            None => "the project workflow takes precedence".into(),
        };
        lines.push(format!(
            "Hidden: {} [{}] — {why}.",
            entry.path.display(),
            entry.scope_label()
        ));
    }
    if let Some(scope) = catalog.duplicates.get(name) {
        lines.push(match plugin_part {
            Some(plugin) => format!(
                "Not runnable: '{name}' is defined twice in plugin {plugin} (ambiguous); the plugin must rename one."
            ),
            None => format!(
                "Not runnable: '{name}' is defined twice in {} scope (ambiguous); rename one file and its meta.name.",
                scope.label()
            ),
        });
    }
    if plugin_part.is_none()
        && let Some(owners) = catalog.plugin_conflicts.get(name)
    {
        let runs: Vec<String> = owners
            .iter()
            .map(|owner| format!("/{owner}:{name}"))
            .collect();
        lines.push(format!(
            "/{name} is ambiguous: plugins {} each offer it; run {}.",
            owners.join(", "),
            runs.join(" or ")
        ));
    }
    for bad in catalog.skipped.iter().filter(|bad| {
        bad.path.file_name().and_then(|n| n.to_str()) == Some(file.as_str())
            && plugin_part.is_none_or(|plugin| bad.plugin.as_deref() == Some(plugin))
    }) {
        let scope = match &bad.plugin {
            Some(plugin) => format!("plugin {plugin}"),
            None => bad.scope.label().to_string(),
        };
        lines.push(format!(
            "Not loaded: {} [{scope}] — {}",
            bad.path.display(),
            truncate_with_marker(&squash(&bad.error), MAX_SHOWN_ERROR_BYTES)
        ));
    }
    for state in catalog.plugins.iter().filter(|state| {
        !state.active()
            && plugin_part.is_none_or(|plugin| state.origin.name == plugin)
            && state.files.iter().any(|file| file == bare_name)
    }) {
        lines.push(format!(
            "Not available: plugin {} is {} ({}); its workflow {}:{bare_name} does not run until the plugin is active. Plugin: {}",
            state.origin.name,
            state.status,
            state.detail,
            state.origin.name,
            state.origin.describe()
        ));
    }
    if lines.is_empty() {
        return format!(
            "No saved workflow or workflow file named '{name}'. /workflows lists them."
        );
    }
    lines.join("\n")
}

/// Slash-completion rows `/<name>` for names no other command owns.
pub fn menu_entries(catalog: &Catalog, taken: &dyn Fn(&str) -> bool) -> Vec<(String, String)> {
    catalog
        .entries
        .iter()
        .filter(|entry| !taken(&entry.call_name()))
        .map(|entry| {
            (
                format!("/{}", entry.call_name()),
                format!(
                    "workflow · {}  {}",
                    entry.scope_label(),
                    truncate_with_marker(&squash(&entry.meta.description), 120)
                ),
            )
        })
        .collect()
}

pub fn to_json(catalog: &Catalog) -> Value {
    let entry = |entry: &Entry| {
        json!({
            "name": entry.meta.name,
            "description": entry.meta.description,
            "whenToUse": entry.meta.when_to_use,
            "scope": entry.scope.label(),
            "callName": entry.call_name(),
            "plugin": entry.plugin.as_ref().map(PluginOrigin::json),
            "path": entry.path.display().to_string(),
        })
    };
    json!({
        "type": "catalog",
        "entries": catalog.entries.iter().map(entry).collect::<Vec<_>>(),
        "shadowed": catalog.shadowed.iter().map(entry).collect::<Vec<_>>(),
        "duplicates": catalog.duplicates.iter().map(|(name, scope)| json!({"name": name, "scope": scope.label()})).collect::<Vec<_>>(),
        "skipped": catalog.skipped.iter().map(|skipped| json!({"path": skipped.path.display().to_string(), "scope": skipped.scope.label(), "plugin": skipped.plugin, "error": skipped.error})).collect::<Vec<_>>(),
        "plugins": catalog.plugins.iter().map(|state| json!({"plugin": state.origin.json(), "status": state.status, "detail": state.detail, "files": state.files, "problems": state.problems})).collect::<Vec<_>>(),
        "pluginConflicts": catalog.plugin_conflicts,
        "projectDir": catalog.project_dir.display().to_string(),
        "projectTrusted": catalog.project_trusted,
        "userDir": catalog.user_dir.as_ref().map(|dir| dir.display().to_string()),
        "listing": listing(catalog),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveError {
    pub code: &'static str,
    pub message: String,
}

impl SaveError {
    fn new(code: &'static str, message: String) -> Self {
        Self { code, message }
    }
}

/// Reference `save_project_workflow`: `<project>/.grok/workflows/<name>.rhai`,
/// never replacing an existing file.
pub fn save_project(scope: &Scope, name: &str, script: &str) -> Result<PathBuf, SaveError> {
    if !valid_name(name) {
        return Err(SaveError::new("workflow_invalid_input", invalid_name(name)));
    }
    let root = project_root(&scope.cwd);
    if !scope.trusted {
        return Err(SaveError::new(
            "workflow_untrusted",
            format!(
                "workflow path is not trusted: {} (project workflows require folder trust)",
                root.display()
            ),
        ));
    }
    if script.len() as u64 > MAX_WORKFLOW_SOURCE_BYTES {
        return Err(SaveError::new(
            "workflow_invalid_input",
            format!("workflow source exceeds {MAX_WORKFLOW_SOURCE_BYTES} bytes: <saved workflow>"),
        ));
    }
    let meta = parse_workflow(script, None)
        .map_err(|error| SaveError::new("workflow_invalid_input", error))?;
    if meta.name != name {
        return Err(SaveError::new(
            "workflow_invalid_input",
            format!(
                "saved workflow filename '{name}.rhai' must match meta.name '{}'",
                meta.name
            ),
        ));
    }
    let io_error = |path: &Path, error: io::Error| {
        SaveError::new(
            "workflow_not_writable",
            format!("failed to write {}: {error}", path.display()),
        )
    };
    let canonical_root = std::fs::canonicalize(&root).map_err(|error| io_error(&root, error))?;
    let dir = canonical_root.join(".grok").join("workflows");
    create_contained_dir(&canonical_root, &dir)?;
    let canonical_dir = std::fs::canonicalize(&dir).map_err(|error| io_error(&dir, error))?;
    let target = canonical_dir.join(format!("{name}.rhai"));
    match atomic_create_new(&target, script.as_bytes()) {
        Ok(()) => Ok(target),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(SaveError::new(
            "workflow_exists",
            format!(
                "{} already exists; saving never replaces a workflow file",
                target.display()
            ),
        )),
        Err(error) => Err(io_error(&target, error)),
    }
}

fn untrusted_component(path: &Path, reason: &str) -> SaveError {
    SaveError::new(
        "workflow_untrusted",
        format!(
            "workflow path is not trusted: {} ({reason})",
            path.display()
        ),
    )
}

fn create_contained_dir(root: &Path, dir: &Path) -> Result<(), SaveError> {
    let relative = dir
        .strip_prefix(root)
        .map_err(|_| untrusted_component(dir, "save directory escaped project root"))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(untrusted_component(
                dir,
                "save directory contains a non-normal component",
            ));
        };
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err(untrusted_component(
                    &current,
                    "save directory component is not a real directory",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                std::fs::create_dir(&current).map_err(|error| {
                    SaveError::new(
                        "workflow_not_writable",
                        format!("failed to write {}: {error}", current.display()),
                    )
                })?;
            }
            Err(error) => {
                return Err(SaveError::new(
                    "workflow_not_writable",
                    format!("failed to write {}: {error}", current.display()),
                ));
            }
        }
    }
    let canonical = std::fs::canonicalize(dir).map_err(|error| {
        SaveError::new(
            "workflow_not_writable",
            format!("failed to write {}: {error}", dir.display()),
        )
    })?;
    if !canonical.starts_with(root) {
        return Err(untrusted_component(
            dir,
            "save directory escaped project root",
        ));
    }
    Ok(())
}

/// Write a temporary file, then hard-link it to `target`: the link fails
/// when `target` exists, so nothing is replaced and no partial file shows.
fn atomic_create_new(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no parent"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let temp = parent.join(format!(".workflow-{}-{nanos}.tmp", std::process::id()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        #[cfg(unix)]
        std::fs::hard_link(&temp, target)?;
        #[cfg(not(unix))]
        {
            if target.exists() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "destination already exists",
                ));
            }
            std::fs::rename(&temp, target)?;
        }
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(&temp);
    result
}

fn scope_from(value: &Value) -> Result<Scope, String> {
    let cwd = value
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| Path::new(cwd).is_absolute())
        .ok_or("invalid engine request: cwd must be an absolute path")?;
    Ok(Scope {
        cwd: PathBuf::from(cwd),
        grok_home: value
            .get("grokHome")
            .and_then(Value::as_str)
            .filter(|home| !home.is_empty())
            .map(PathBuf::from),
        trusted: value.get("trusted").and_then(Value::as_bool) == Some(true),
    })
}

/// Engine start lines that are answered at once: `catalog` (the scan and the
/// model listing) and `save`. `None` for the run and validate ops.
pub fn serve_op(value: &Value) -> Option<Value> {
    let op = value.get("op").and_then(Value::as_str)?;
    if op != "catalog" && op != "save" {
        return None;
    }
    let scope = match scope_from(value) {
        Ok(scope) => scope,
        Err(error) => {
            return Some(
                json!({"type": "rejected", "code": "workflow_invalid_input", "error": error}),
            );
        }
    };
    if op == "catalog" {
        return Some(to_json(&scan(&scope)));
    }
    let name = value.get("name").and_then(Value::as_str).unwrap_or("");
    let script = value.get("script").and_then(Value::as_str).unwrap_or("");
    Some(match save_project(&scope, name, script) {
        Ok(path) => json!({"type": "saved", "name": name, "path": path.display().to_string()}),
        Err(error) => json!({"type": "rejected", "code": error.code, "error": error.message}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(name: &str, description: &str) -> String {
        format!("let meta = #{{ name: \"{name}\", description: \"{description}\" }};\n\"ok\"")
    }

    struct Fixture {
        _root: tempfile::TempDir,
        project: PathBuf,
        home: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let project = root.path().join("repo");
            let home = root.path().join("grok");
            std::fs::create_dir_all(project.join(".git")).unwrap();
            std::fs::create_dir_all(project.join("nested")).unwrap();
            Self {
                _root: root,
                project,
                home,
            }
        }

        fn scope(&self, trusted: bool) -> Scope {
            Scope {
                cwd: self.project.join("nested"),
                grok_home: Some(self.home.clone()),
                trusted,
            }
        }

        fn project_dir(&self) -> PathBuf {
            self.project.join(".grok").join("workflows")
        }

        fn user_dir(&self) -> PathBuf {
            self.home.join("workflows")
        }

        fn write(&self, dir: &Path, file: &str, body: &str) -> PathBuf {
            std::fs::create_dir_all(dir).unwrap();
            let path = dir.join(file);
            std::fs::write(&path, body).unwrap();
            path
        }
    }

    #[test]
    fn project_shadows_user_only_in_a_trusted_folder() {
        let fx = Fixture::new();
        fx.write(
            &fx.project_dir(),
            "review.rhai",
            &script("review", "project review"),
        );
        fx.write(
            &fx.user_dir(),
            "review.rhai",
            &script("review", "user review"),
        );
        fx.write(&fx.user_dir(), "notes.rhai", &script("notes", "user notes"));
        fx.write(&fx.user_dir(), "README.md", "not a workflow");

        let trusted = scan(&fx.scope(true));
        let names: Vec<_> = trusted
            .entries
            .iter()
            .map(|entry| (entry.meta.name.as_str(), entry.scope))
            .collect();
        assert_eq!(
            names,
            [
                ("review", CatalogScope::Project),
                ("notes", CatalogScope::User)
            ]
        );
        assert_eq!(trusted.shadowed.len(), 1);
        assert_eq!(trusted.shadowed[0].meta.description, "user review");
        assert_eq!(
            trusted.find("review").unwrap().meta.description,
            "project review"
        );
        assert!(trusted.skipped.is_empty(), "{:?}", trusted.skipped);

        let untrusted = scan(&fx.scope(false));
        assert_eq!(
            untrusted.find("review").unwrap().meta.description,
            "user review"
        );
        assert!(untrusted.shadowed.is_empty());
        let text = overview(&untrusted, &|_| false);
        assert!(text.contains("loads once this folder is trusted"), "{text}");
        let text = overview(&trusted, &|_| false);
        assert!(
            text.starts_with("Saved workflows (2): /review [project], /notes [user]."),
            "{text}"
        );
        assert!(
            text.contains("Hidden: review [user] (a project workflow"),
            "{text}"
        );
        let about = detail(&trusted, "review", &|_| false);
        assert!(
            about.starts_with("review [project] — project review\n"),
            "{about}"
        );
        assert!(about.contains("Hidden: "), "{about}");
        assert!(
            about.contains("[user] — the project workflow takes precedence."),
            "{about}"
        );
        assert!(overview(&trusted, &|_| false).lines().count() <= 6);
        assert_eq!(
            untrusted.find("absent").unwrap_err(),
            "unknown workflow: absent"
        );
    }

    #[test]
    fn invalid_files_are_skipped_with_the_reason_and_never_run() {
        let fx = Fixture::new();
        let dir = fx.user_dir();
        fx.write(&dir, "good.rhai", &script("good", "fine"));
        // A script that would loop forever if it ran: discovery only reads meta.
        fx.write(
            &dir,
            "spin.rhai",
            "let meta = #{ name: \"spin\", description: \"loops\" };\nloop { }",
        );
        fx.write(&dir, "wrong.rhai", &script("other", "mismatch"));
        fx.write(&dir, "Upper.rhai", &script("upper", "bad stem"));
        fx.write(&dir, "broken.rhai", "let x = 1;");
        std::fs::write(dir.join("binary.rhai"), [0xff, 0xfe, 0x00]).unwrap();
        let big = format!(
            "{}\n//{}",
            script("big", "large"),
            "x".repeat(MAX_WORKFLOW_SOURCE_BYTES as usize)
        );
        fx.write(&dir, "big.rhai", &big);
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("good.rhai"), dir.join("link.rhai")).unwrap();

        let catalog = scan(&fx.scope(false));
        let names: Vec<_> = catalog
            .entries
            .iter()
            .map(|entry| entry.meta.name.as_str())
            .collect();
        assert_eq!(names, ["good", "spin"]);
        let reasons: BTreeMap<String, String> = catalog
            .skipped
            .iter()
            .map(|skipped| {
                (
                    skipped
                        .path
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    skipped.error.clone(),
                )
            })
            .collect();
        assert!(reasons["wrong.rhai"].contains("must match meta.name 'other'"));
        assert!(reasons["Upper.rhai"].contains("expected <safe-name>.rhai"));
        assert!(reasons["broken.rhai"].starts_with("invalid workflow script"));
        assert!(reasons["binary.rhai"].starts_with("failed to read"));
        assert!(reasons["big.rhai"].contains("exceeds 1048576 bytes"));
        #[cfg(unix)]
        assert!(reasons["link.rhai"].contains("non-symlink regular file"));
        let text = overview(&catalog, &|_| false);
        assert!(text.contains("Not loaded (invalid, never run): "), "{text}");
        assert!(text.contains("wrong.rhai [user]"), "{text}");
        assert!(text.starts_with("Saved workflows (2):"), "{text}");
        let why = detail(&catalog, "wrong", &|_| false);
        assert!(why.starts_with("Not loaded: "), "{why}");
        assert!(
            why.contains("wrong.rhai [user] — saved workflow filename"),
            "{why}"
        );
        // Launching an invalid file by name names the file and the reason.
        let err = catalog.find("broken").err().unwrap();
        assert!(
            err.starts_with("workflow 'broken' is not loaded: "),
            "{err}"
        );
        assert!(
            err.contains("broken.rhai is invalid: invalid workflow script"),
            "{err}"
        );
        assert_eq!(
            catalog.find("ghost").err().unwrap(),
            "unknown workflow: ghost"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_workflow_directory_is_not_scanned() {
        let fx = Fixture::new();
        let elsewhere = fx.project.join("elsewhere");
        fx.write(&elsewhere, "evil.rhai", &script("evil", "x"));
        std::fs::create_dir_all(fx.project.join(".grok")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, fx.project_dir()).unwrap();
        let catalog = scan(&fx.scope(true));
        assert!(catalog.entries.is_empty());
        assert_eq!(catalog.skipped.len(), 1);
        assert!(
            catalog.skipped[0]
                .error
                .contains("symlink or not a directory")
        );
    }

    #[test]
    fn a_name_defined_twice_in_one_scope_is_ambiguous() {
        let path = |dir: &str| PathBuf::from(format!("{dir}/dup.rhai"));
        let entry = |dir: &str, scope| Entry {
            meta: xai_workflow::extract_meta(&script("dup", dir)).unwrap(),
            script: script("dup", dir),
            scope,
            path: path(dir),
            plugin: None,
            bare: true,
        };
        let mut project = vec![
            entry("a", CatalogScope::Project),
            entry("b", CatalogScope::Project),
        ];
        let mut catalog = Catalog {
            entries: Vec::new(),
            shadowed: Vec::new(),
            duplicates: BTreeMap::new(),
            skipped: Vec::new(),
            project_dir: PathBuf::from("p"),
            project_trusted: true,
            user_dir: None,
            plugins: Vec::new(),
            plugin_conflicts: BTreeMap::new(),
        };
        reject_same_scope_duplicates(&mut project, CatalogScope::Project, &mut catalog.duplicates);
        assert!(project.is_empty());
        merge_scope(&mut catalog, vec![entry("u", CatalogScope::User)]);
        assert_eq!(
            catalog.find("dup").unwrap_err(),
            "ambiguous workflow 'dup': duplicate definitions in project scope"
        );
        assert!(overview(&catalog, &|_| false).contains("'dup' is defined twice in project scope"));
        assert!(detail(&catalog, "dup", &|_| false).contains("rename one file"));
    }

    #[test]
    fn the_listing_follows_the_reference_layout_and_caps() {
        let fx = Fixture::new();
        let long = "d".repeat(900);
        fx.write(
            &fx.user_dir(),
            "alpha.rhai",
            &format!(
                "let meta = #{{ name: \"alpha\", description: \"{long}\", when_to_use: \"when it helps\" }};\n1"
            ),
        );
        fx.write(&fx.user_dir(), "beta.rhai", &script("beta", "short"));
        let catalog = scan(&fx.scope(false));
        let text = listing(&catalog).unwrap();
        assert!(text.starts_with(LISTING_HEADER), "{text}");
        let alpha = text
            .lines()
            .find(|line| line.starts_with("- alpha: "))
            .unwrap();
        assert!(alpha.ends_with('…'));
        assert!(alpha.len() <= "- alpha: ".len() + MAX_LISTING_COMBINED_BYTES);
        assert!(text.contains("\n  Use when: when it helps"), "{text}");
        assert!(text.contains(&format!(
            "- beta: short\n  Absolute path: {}",
            fx.user_dir().join("beta.rhai").display()
        )));
        assert!(listing(&scan(&fx.scope(false).clone_with_home(None))).is_none());
    }

    impl Scope {
        fn clone_with_home(&self, home: Option<PathBuf>) -> Scope {
            Scope {
                cwd: self.cwd.clone(),
                grok_home: home,
                trusted: self.trusted,
            }
        }
    }

    #[test]
    fn completion_skips_names_other_commands_own() {
        let fx = Fixture::new();
        fx.write(&fx.user_dir(), "plan.rhai", &script("plan", "clashes"));
        fx.write(
            &fx.user_dir(),
            "triage.rhai",
            &script("triage", "Sort   issues"),
        );
        let catalog = scan(&fx.scope(false));
        let taken = |name: &str| name == "plan";
        assert_eq!(
            menu_entries(&catalog, &taken),
            [(
                "/triage".to_string(),
                "workflow · user  Sort issues".to_string()
            )]
        );
        let text = overview(&catalog, &taken);
        assert!(
            text.contains("plan [user, run with /workflow plan], /triage [user]"),
            "{text}"
        );
        assert!(
            detail(&catalog, "plan", &taken).contains("Run: /workflow plan [args] (/plan is taken"),
        );
        assert!(
            detail(&catalog, "triage", &taken)
                .contains("Run: /triage [args] or /workflow triage [args]"),
        );
        assert!(detail(&catalog, "ghost", &taken).starts_with("No saved workflow"));
        let empty = overview(&scan(&fx.scope(false).clone_with_home(None)), &taken);
        assert!(empty.starts_with("No saved workflows found."), "{empty}");
        assert!(empty.contains("then active plugins"), "{empty}");
        assert!(
            empty.contains("Built-in workflows ship separately."),
            "{empty}"
        );
    }

    #[test]
    fn save_needs_trust_matches_meta_and_never_replaces() {
        let fx = Fixture::new();
        let body = script("keep", "saved run");
        let error = save_project(&fx.scope(false), "keep", &body).unwrap_err();
        assert_eq!(error.code, "workflow_untrusted");
        assert!(
            error
                .message
                .ends_with("(project workflows require folder trust)")
        );
        assert!(!fx.project_dir().exists());

        let error = save_project(&fx.scope(true), "other", &body).unwrap_err();
        assert_eq!(
            error.message,
            "saved workflow filename 'other.rhai' must match meta.name 'keep'"
        );
        let error = save_project(&fx.scope(true), "Bad", &body).unwrap_err();
        assert!(error.message.starts_with("invalid workflow name 'Bad'"));

        let path = save_project(&fx.scope(true), "keep", &body).unwrap();
        assert_eq!(
            path,
            std::fs::canonicalize(fx.project_dir())
                .unwrap()
                .join("keep.rhai")
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), body);
        // The saved file is runnable by name at once.
        assert_eq!(
            scan(&fx.scope(true)).find("keep").unwrap().scope,
            CatalogScope::Project
        );
        let error = save_project(&fx.scope(true), "keep", &script("keep", "changed")).unwrap_err();
        assert_eq!(error.code, "workflow_exists");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), body);
        let leftovers: Vec<_> = std::fs::read_dir(fx.project_dir())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, [std::ffi::OsString::from("keep.rhai")]);
    }

    #[cfg(unix)]
    #[test]
    fn save_refuses_a_symlinked_directory_and_reports_an_unwritable_project() {
        use std::os::unix::fs::PermissionsExt;
        let fx = Fixture::new();
        let elsewhere = fx.project.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, fx.project.join(".grok")).unwrap();
        let error = save_project(&fx.scope(true), "keep", &script("keep", "x")).unwrap_err();
        assert_eq!(error.code, "workflow_untrusted");
        assert!(
            error
                .message
                .contains("save directory component is not a real directory")
        );
        assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none());

        std::fs::remove_file(fx.project.join(".grok")).unwrap();
        std::fs::set_permissions(&fx.project, std::fs::Permissions::from_mode(0o555)).unwrap();
        let probe = std::fs::create_dir(fx.project.join("probe"));
        if probe.is_ok() {
            // Running as root: permissions do not apply, nothing to check.
            std::fs::remove_dir(fx.project.join("probe")).unwrap();
        } else {
            let error = save_project(&fx.scope(true), "keep", &script("keep", "x")).unwrap_err();
            assert_eq!(error.code, "workflow_not_writable");
            assert!(
                error.message.starts_with("failed to write "),
                "{}",
                error.message
            );
        }
        std::fs::set_permissions(&fx.project, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn engine_ops_answer_with_one_line() {
        let fx = Fixture::new();
        fx.write(&fx.user_dir(), "notes.rhai", &script("notes", "user notes"));
        let base = json!({"cwd": fx.project.to_str().unwrap(), "grokHome": fx.home.to_str().unwrap(), "trusted": true});
        let mut request = base.clone();
        request["op"] = json!("catalog");
        let reply = serve_op(&request).unwrap();
        assert_eq!(reply["type"], "catalog");
        assert_eq!(reply["entries"][0]["name"], "notes");
        assert_eq!(reply["entries"][0]["scope"], "user");
        assert!(
            reply["listing"]
                .as_str()
                .unwrap()
                .starts_with(LISTING_HEADER)
        );
        let mut request = base.clone();
        request["op"] = json!("save");
        request["name"] = json!("kept");
        request["script"] = json!(script("kept", "k"));
        let reply = serve_op(&request).unwrap();
        assert_eq!(reply["type"], "saved");
        let reply = serve_op(&request).unwrap();
        assert_eq!(reply["code"], "workflow_exists");
        assert!(serve_op(&json!({"op": "run"})).is_none());
        let reply = serve_op(&json!({"op": "catalog", "cwd": "relative"})).unwrap();
        assert_eq!(reply["type"], "rejected");
    }

    fn plugin_source(fx: &Fixture, name: &str, status: &str) -> PluginWorkflowSource {
        let root = fx.home.join("plugins").join(name);
        PluginWorkflowSource {
            name: name.into(),
            scope: "user".into(),
            version: Some("1.2.0".into()),
            license: Some("MIT".into()),
            source: root.display().to_string(),
            marketplace: None,
            commit: Some("0123456789abcdef".into()),
            trusted: status != "blocked",
            status: status.into(),
            status_detail: format!("{status} for the test"),
            dirs: vec![root.join("workflows")],
            root,
            problems: Vec::new(),
        }
    }

    #[test]
    fn plugin_workflows_run_qualified_and_bare_below_project_and_user() {
        let fx = Fixture::new();
        fx.write(
            &fx.project_dir(),
            "review.rhai",
            &script("review", "project review"),
        );
        let demo = plugin_source(&fx, "demo", "active");
        fx.write(
            &demo.dirs[0],
            "review.rhai",
            &script("review", "plugin review"),
        );
        fx.write(
            &demo.dirs[0],
            "triage.rhai",
            &script("triage", "plugin triage"),
        );
        fx.write(&demo.dirs[0], "broken.rhai", "let meta = ");
        let catalog = scan_with(&fx.scope(true), std::slice::from_ref(&demo));

        assert_eq!(
            catalog.find("review").unwrap().meta.description,
            "project review"
        );
        let qualified = catalog.find("demo:review").unwrap();
        assert_eq!(qualified.meta.description, "plugin review");
        assert_eq!(qualified.call_name(), "demo:review");
        assert_eq!(qualified.scope_label(), "plugin demo");
        let triage = catalog.find("triage").unwrap();
        assert!(triage.bare);
        assert_eq!(triage.call_name(), "triage");
        assert_eq!(catalog.find("demo:triage").unwrap().path, triage.path);
        let origin = triage.origin_json();
        assert_eq!(origin["plugin"]["name"], "demo");
        assert_eq!(origin["plugin"]["version"], "1.2.0");
        assert_eq!(origin["plugin"]["commit"], "0123456789abcdef");
        assert!(
            catalog
                .find("demo:broken")
                .unwrap_err()
                .contains("is invalid"),
            "invalid plugin files are named"
        );
        assert_eq!(
            catalog.find("demo:ghost").unwrap_err(),
            "unknown workflow: demo:ghost"
        );
        assert!(catalog.knows("demo:broken"));
        assert!(!catalog.knows("demo:ghost"));

        let names: Vec<String> = catalog.entries.iter().map(Entry::call_name).collect();
        assert_eq!(names, ["review", "demo:review", "triage"]);
        let list = listing(&catalog).unwrap();
        assert!(list.contains("- demo:review: plugin review"), "{list}");
        assert!(list.contains("- triage: plugin triage"), "{list}");

        let text = overview(&catalog, &|_| false);
        assert!(
            text.starts_with("Saved workflows (3): /review [project], /demo:review [plugin demo], /triage [plugin demo]."),
            "{text}"
        );
        assert!(text.contains("broken.rhai [plugin demo]"), "{text}");
        assert!(text.contains("Qualified only: demo:review"), "{text}");
        assert!(text.lines().count() <= 6, "{text}");

        let about = detail(&catalog, "review", &|_| false);
        assert!(
            about.contains("review [project] — project review"),
            "{about}"
        );
        assert!(
            about.contains("demo:review [plugin demo] — plugin review"),
            "{about}"
        );
        assert!(
            about.contains("Plugin: demo 1.2.0 · license MIT · user plugin · trusted · source "),
            "{about}"
        );
        assert!(about.contains("commit 0123456789ab"), "{about}");
        assert!(
            about
                .contains("/review does not run this one: a project or personal workflow owns it."),
            "{about}"
        );
        let about = detail(&catalog, "demo:triage", &|_| false);
        assert!(
            about.contains("Run: /triage [args] or /workflow triage [args]; /demo:triage [args]"),
            "{about}"
        );

        let menu = menu_entries(&catalog, &|name| name == "triage");
        let rows: Vec<&str> = menu.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(rows, ["/review", "/demo:review"]);
        assert!(
            menu[1]
                .1
                .starts_with("workflow · plugin demo  plugin review")
        );

        let value = to_json(&catalog);
        assert_eq!(value["entries"][1]["callName"], "demo:review");
        assert_eq!(value["entries"][1]["plugin"]["license"], "MIT");
        assert_eq!(value["plugins"][0]["status"], "active");
        assert_eq!(value["skipped"][0]["plugin"], "demo");
        assert!(value["listing"].as_str().unwrap().contains("demo:review"));

        // Untrusted project: the plugin's bare name is free again.
        let untrusted = scan_with(&fx.scope(false), std::slice::from_ref(&demo));
        assert_eq!(
            untrusted.find("review").unwrap().meta.description,
            "plugin review"
        );
    }

    #[test]
    fn two_plugins_with_one_name_run_only_qualified() {
        let fx = Fixture::new();
        let one = plugin_source(&fx, "one", "active");
        let two = plugin_source(&fx, "two", "active");
        fx.write(&one.dirs[0], "lint.rhai", &script("lint", "one lint"));
        fx.write(&two.dirs[0], "lint.rhai", &script("lint", "two lint"));
        fx.write(&two.dirs[0], "solo.rhai", &script("solo", "two solo"));
        let catalog = scan_with(&fx.scope(true), &[one, two]);
        assert_eq!(
            catalog.find("lint").unwrap_err(),
            "ambiguous workflow 'lint': offered by plugins one, two; run one:lint or two:lint"
        );
        assert!(!catalog.knows("ghost"));
        assert!(catalog.knows("lint"));
        assert_eq!(
            catalog.find("one:lint").unwrap().meta.description,
            "one lint"
        );
        assert_eq!(
            catalog.find("two:lint").unwrap().meta.description,
            "two lint"
        );
        assert_eq!(catalog.find("solo").unwrap().meta.description, "two solo");
        let text = overview(&catalog, &|_| false);
        assert!(
            text.contains("'lint' is offered by plugins one, two; run one:lint or two:lint"),
            "{text}"
        );
        let about = detail(&catalog, "lint", &|_| false);
        assert!(
            about.contains("/lint is ambiguous: plugins one, two each offer it"),
            "{about}"
        );
        assert_eq!(to_json(&catalog)["pluginConflicts"]["lint"][1], "two");
    }

    #[test]
    fn a_plugin_that_defines_a_name_twice_runs_neither() {
        let fx = Fixture::new();
        let mut demo = plugin_source(&fx, "demo", "active");
        let extra = demo.root.join("more");
        demo.dirs.push(extra.clone());
        fx.write(&demo.dirs[0], "twice.rhai", &script("twice", "first"));
        fx.write(&extra, "twice.rhai", &script("twice", "second"));
        let catalog = scan_with(&fx.scope(true), &[demo.clone()]);
        assert_eq!(
            catalog.find("demo:twice").unwrap_err(),
            "ambiguous workflow 'demo:twice': duplicate definitions in plugin demo"
        );
        assert_eq!(
            catalog.find("twice").unwrap_err(),
            "unknown workflow: twice"
        );
        let (names, problems) = plugin_workflow_names("demo", &demo.dirs);
        assert_eq!(names, ["demo:twice"]);
        assert_eq!(
            problems,
            ["workflow demo:twice is defined twice in this plugin; neither runs"]
        );
        let text = overview(&catalog, &|_| false);
        assert!(
            text.contains("'demo:twice' is defined twice in plugin demo"),
            "{text}"
        );
    }

    #[test]
    fn inactive_plugins_load_nothing_and_say_why() {
        let fx = Fixture::new();
        for status in ["disabled", "blocked", "missing", "shadowed"] {
            let off = plugin_source(&fx, "off", status);
            fx.write(
                &off.dirs[0],
                "deploy.rhai",
                &script("deploy", "never loads"),
            );
            let catalog = scan_with(&fx.scope(true), &[off]);
            assert!(catalog.entries.is_empty(), "{status}");
            let expected = format!(
                "workflow 'deploy' is not available: plugin 'off' is {status} ({status} for the test)"
            );
            assert_eq!(catalog.find("deploy").unwrap_err(), expected);
            assert_eq!(
                catalog.find("off:deploy").unwrap_err(),
                expected.replace("'deploy'", "'off:deploy'")
            );
            assert!(catalog.knows("deploy"));
            assert!(listing(&catalog).is_none());
            let text = overview(&catalog, &|_| false);
            assert!(
                text.contains(&format!(
                    "Plugin workflows not loaded: off ({status}, 1 workflow)"
                )),
                "{text}"
            );
            let about = detail(&catalog, "off:deploy", &|_| false);
            assert!(
                about.starts_with(&format!("Not available: plugin off is {status}")),
                "{about}"
            );
            assert_eq!(to_json(&catalog)["plugins"][0]["files"][0], "deploy");
        }
    }

    #[test]
    fn qualified_names_are_validated() {
        use crate::workflow::{invalid_call_name, valid_call_name};
        assert!(valid_call_name("demo:review"));
        assert!(valid_call_name("review"));
        assert!(!valid_call_name("demo:"));
        assert!(!valid_call_name(":review"));
        assert!(!valid_call_name("Demo:review"));
        assert!(!valid_call_name("demo:re:view"));
        assert!(invalid_call_name("demo:").contains("<plugin>:<name>"));
    }
}
