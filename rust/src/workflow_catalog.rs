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
//! `save_project` is the reference `save_project_workflow`: folder trust is
//! required, the directories are created one real component at a time under
//! the canonical project root, and the file is created atomically without
//! replacing an existing one.

use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};
use xai_workflow::WorkflowMeta;

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
}

impl CatalogScope {
    pub fn label(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::User => "user",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub meta: WorkflowMeta,
    pub script: String,
    pub scope: CatalogScope,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub path: PathBuf,
    pub scope: CatalogScope,
    pub error: String,
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
}

impl Catalog {
    /// The reference `resolve_entry`: an ambiguous name is refused before a
    /// runnable same-named entry of a lower scope is considered.
    pub fn find(&self, name: &str) -> Result<&Entry, String> {
        if let Some(scope) = self.duplicates.get(name) {
            return Err(format!(
                "ambiguous workflow '{name}': duplicate definitions in {} scope",
                scope.label()
            ));
        }
        if let Some(entry) = self.entries.iter().find(|entry| entry.meta.name == name) {
            return Ok(entry);
        }
        // A file named after the workflow that failed to load is named in the
        // error, so the user learns why `/<name>` does nothing.
        let stem = format!("{name}.rhai");
        if let Some(bad) = self
            .skipped
            .iter()
            .find(|bad| bad.path.file_name().and_then(|n| n.to_str()) == Some(stem.as_str()))
        {
            return Err(format!(
                "workflow '{name}' is not loaded: {} is invalid: {}",
                bad.path.display(),
                bad.error
            ));
        }
        Err(format!("unknown workflow: {name}"))
    }
}

/// Scan the catalog for a session directory (reference `WorkflowRegistry::scan`).
pub fn scan(scope: &Scope) -> Catalog {
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
    catalog
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
            }),
            Err(error) => skipped.push(Skipped { path, scope, error }),
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
            entry.meta.name,
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
                let name = &entry.meta.name;
                if taken(name) {
                    format!(
                        "{name} [{}, run with /workflow {name}]",
                        entry.scope.label()
                    )
                } else {
                    format!("/{name} [{}]", entry.scope.label())
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
        .filter(|entry| !catalog.duplicates.contains_key(&entry.meta.name))
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
        problems.push(format!(
            "Not runnable: '{name}' is defined twice in {} scope (ambiguous)",
            scope.label()
        ));
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
                format!("{file} [{}]", bad.scope.label())
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
            "Folders: {} (project, first) and {user}. Built-in and plugin workflows are not part of this catalog; they ship separately.",
            catalog.project_dir.display()
        ));
    } else {
        lines.push(format!(
            "Folders: {user}; {} loads once this folder is trusted. Built-in and plugin workflows are not part of this catalog; they ship separately.",
            catalog.project_dir.display()
        ));
    }
    if catalog.entries.is_empty() {
        lines.push("Add <name>.rhai files (named after meta.name) to a folder above, or save a run with /workflow save <name>.".into());
    } else {
        lines.push("Run /<name> or /workflow <name> [--agent-budget N] [--effort LEVEL] [text | JSON args]; details: /workflows <name>; keep a run: /workflow save <name>.".into());
    }
    lines.join("\n")
}

/// `/workflows <name>`: one workflow's description, how to run it, its file,
/// and the copies it hides; or why a file of that name is not loaded.
pub fn detail(catalog: &Catalog, name: &str, taken: &dyn Fn(&str) -> bool) -> String {
    let file = format!("{name}.rhai");
    let mut lines = Vec::new();
    if let Some(entry) = catalog.entries.iter().find(|entry| entry.meta.name == name) {
        lines.push(format!(
            "{name} [{}] — {}",
            entry.scope.label(),
            truncate_with_marker(&squash(&entry.meta.description), 400)
        ));
        if let Some(when) = entry.meta.when_to_use.as_deref().filter(|w| !w.is_empty()) {
            lines.push(format!(
                "Use when: {}",
                truncate_with_marker(&squash(when), 400)
            ));
        }
        if taken(name) {
            lines.push(format!(
                "Run: /workflow {name} [args] (/{name} is taken by another command)"
            ));
        } else {
            lines.push(format!("Run: /{name} [args] or /workflow {name} [args]"));
        }
        lines.push(format!("Path: {}", entry.path.display()));
    }
    for entry in catalog
        .shadowed
        .iter()
        .filter(|entry| entry.meta.name == name)
    {
        let why = if catalog.duplicates.contains_key(name) {
            "the name is ambiguous"
        } else {
            "the project workflow takes precedence"
        };
        lines.push(format!(
            "Hidden: {} [{}] — {why}.",
            entry.path.display(),
            entry.scope.label()
        ));
    }
    if let Some(scope) = catalog.duplicates.get(name) {
        lines.push(format!(
            "Not runnable: '{name}' is defined twice in {} scope (ambiguous); rename one file and its meta.name.",
            scope.label()
        ));
    }
    for bad in catalog
        .skipped
        .iter()
        .filter(|bad| bad.path.file_name().and_then(|n| n.to_str()) == Some(file.as_str()))
    {
        lines.push(format!(
            "Not loaded: {} [{}] — {}",
            bad.path.display(),
            bad.scope.label(),
            truncate_with_marker(&squash(&bad.error), MAX_SHOWN_ERROR_BYTES)
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
        .filter(|entry| !taken(&entry.meta.name))
        .map(|entry| {
            (
                format!("/{}", entry.meta.name),
                format!(
                    "workflow · {}  {}",
                    entry.scope.label(),
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
            "path": entry.path.display().to_string(),
        })
    };
    json!({
        "type": "catalog",
        "entries": catalog.entries.iter().map(entry).collect::<Vec<_>>(),
        "shadowed": catalog.shadowed.iter().map(entry).collect::<Vec<_>>(),
        "duplicates": catalog.duplicates.iter().map(|(name, scope)| json!({"name": name, "scope": scope.label()})).collect::<Vec<_>>(),
        "skipped": catalog.skipped.iter().map(|skipped| json!({"path": skipped.path.display().to_string(), "scope": skipped.scope.label(), "error": skipped.error})).collect::<Vec<_>>(),
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
        assert!(empty.contains("Built-in and plugin workflows are not part of this catalog"));
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
}
