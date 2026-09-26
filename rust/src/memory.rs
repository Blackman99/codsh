//! Explicit local memory: human-editable Markdown, a SQLite FTS5 index, and
//! global versus workspace scopes.
//!
//! Automatic capture and Dream consolidation live in `memory_capture.rs`
//! (ticket 54); embeddings and uploads are not implemented. Disabling memory
//! never deletes files. Notes stay authoritative. A damaged index is reported
//! and rebuilt from those notes; a foreign SQLite file and a human note are
//! never overwritten.

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const INDEX_NAME: &str = "index.sqlite";
const GLOBAL_NOTE: &str = "MEMORY.md";
const SESSIONS: &str = "sessions";
const CONFIRM_HEADING: &str = "## Preferences";
/// First-turn injection stays a bounded keyword sample, not the whole store.
const INJECTION_NOTE_CAP: usize = 6;
const INJECTION_CHARS: usize = 4_000;
const SEARCH_CAP: usize = 6;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryError {
    pub message: String,
}

impl std::fmt::Display for MemoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl MemoryError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Global,
    Workspace,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Workspace => "workspace",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enablement {
    /// `--no-memory` or `GROK_MEMORY=0`. The browser is hidden.
    ForceOff,
    /// Effective `[memory] enabled = false`, or unset. The browser stays
    /// available and `t` can turn memory on for this session only.
    ConfigOff,
    On {
        source: &'static str,
    },
}

impl Enablement {
    pub fn enabled(self) -> bool {
        matches!(self, Self::On { .. })
    }

    pub fn force_off(self) -> bool {
        matches!(self, Self::ForceOff)
    }

    pub fn source(self) -> &'static str {
        match self {
            Self::ForceOff => "force-disable",
            Self::ConfigOff => "config",
            Self::On { source } => source,
        }
    }
}

/// Process and config gates. A session toggle is not this value.
pub fn resolve_enablement(
    config_enabled: Option<bool>,
    env_memory: Option<&str>,
    cli_no_memory: bool,
) -> Enablement {
    if cli_no_memory || env_is_off(env_memory) {
        return Enablement::ForceOff;
    }
    if config_enabled == Some(false) {
        return Enablement::ConfigOff;
    }
    if env_is_on(env_memory) {
        return Enablement::On {
            source: "environment",
        };
    }
    if config_enabled == Some(true) {
        return Enablement::On {
            source: "config.toml",
        };
    }
    Enablement::ConfigOff
}

fn env_is_off(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("0" | "false" | "no" | "off" | "disabled")
    )
}

fn env_is_on(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "yes" | "on" | "enabled")
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteRef {
    pub scope: Scope,
    pub name: String,
    pub path: PathBuf,
    /// A generated `MEMORY.md` index is not a user note and cannot be deleted.
    /// A human `MEMORY.md` is also protected: the guide says it cannot be deleted.
    pub generated_index: bool,
    /// `x` cannot remove this file. Generated indexes and every `MEMORY.md`.
    pub undeletable: bool,
    pub empty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Store {
    pub root: PathBuf,
    pub workspace_dir: PathBuf,
    pub identity: String,
    pub warnings: Vec<String>,
}

/// One FTS row. `scope` is `global`, `workspace`, or `session`.
/// `line` is the note line number and only orders rows from the same file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub note: NoteRef,
    pub line: usize,
    pub scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedNote {
    pub path: PathBuf,
    pub scope: Scope,
    pub created: bool,
}

pub fn open_store(grok_home: &Path, cwd: &Path) -> Result<Store, MemoryError> {
    let root = grok_home.join("memory");
    let identity = workspace_identity(cwd);
    let workspace_dir = root.join(workspace_dirname(&identity));
    let mut warnings = Vec::new();
    inspect_index(&root.join(INDEX_NAME), &mut warnings);
    if workspace_dir != root {
        inspect_index(&workspace_dir.join(INDEX_NAME), &mut warnings);
    }
    Ok(Store {
        root,
        workspace_dir,
        identity,
        warnings,
    })
}

/// A missing index is fine. A damaged or foreign file is reported and left
/// untouched. Notes remain the source of truth until an explicit rebuild.
fn inspect_index(path: &Path, warnings: &mut Vec<String>) {
    if !path.exists() {
        return;
    }
    match index_health(path) {
        IndexHealth::Usable | IndexHealth::Missing => {}
        IndexHealth::Damaged(detail) => warnings.push(format!(
            "memory index {} is damaged ({detail}); notes were left unchanged and the index will be rebuilt from them",
            path.display()
        )),
        IndexHealth::Foreign => warnings.push(format!(
            "memory index {} is not a codsh FTS index; it was left unchanged",
            path.display()
        )),
    }
}

enum IndexHealth {
    Missing,
    Usable,
    Damaged(String),
    Foreign,
}

/// `origin` in `org/repo` form, otherwise the canonical directory path.
pub fn workspace_identity(cwd: &Path) -> String {
    if let Some(origin) = git_origin(cwd)
        && let Some(slug) = origin_slug(&origin)
    {
        return slug;
    }
    canonical_path(cwd)
}

fn canonical_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string()
}

fn git_origin(cwd: &Path) -> Option<String> {
    let mut dir = Some(cwd);
    while let Some(current) = dir {
        let git = current.join(".git");
        if git.is_dir() {
            return origin_from_config(&git.join("config"));
        }
        if git.is_file() {
            let text = fs::read_to_string(&git).ok()?;
            let target = text
                .lines()
                .find_map(|line| line.trim().strip_prefix("gitdir:"))?;
            let git_dir = PathBuf::from(target.trim());
            let git_dir = if git_dir.is_absolute() {
                git_dir
            } else {
                current.join(git_dir)
            };
            if let Some(origin) = origin_from_config(&git_dir.join("config")) {
                return Some(origin);
            }
            // A linked worktree's git dir often has no [remote "origin"].
            // The main repository config beside commondir does.
            if let Some(common) = commondir(&git_dir) {
                return origin_from_config(&common.join("config"));
            }
            return None;
        }
        // A checkout with no origin is a path-scoped workspace. Do not walk
        // into a parent repository and attribute this tree to that origin.
        if git.exists() {
            return None;
        }
        dir = current.parent();
    }
    None
}

fn commondir(git_dir: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(git_dir.join("commondir")).ok()?;
    let raw = PathBuf::from(text.trim());
    let path = if raw.is_absolute() {
        raw
    } else {
        git_dir.join(raw)
    };
    fs::canonicalize(&path).ok().or(Some(path))
}

fn origin_from_config(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let mut in_origin = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_origin = trimmed == "[remote \"origin\"]";
            continue;
        }
        if in_origin && let Some(url) = trimmed.strip_prefix("url") {
            let url = url.trim().trim_start_matches('=').trim();
            if !url.is_empty() {
                return Some(url.to_string());
            }
        }
    }
    None
}

fn origin_slug(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/').trim_end_matches(".git");
    if trimmed.is_empty() {
        return None;
    }
    let path = if let Some(rest) = trimmed.strip_prefix("git@") {
        rest.split_once(':').map(|(_, path)| path)?
    } else if let Some(rest) = trimmed.split("://").nth(1) {
        rest.split_once('/').map(|(_, path)| path).unwrap_or(rest)
    } else if trimmed.starts_with('/') || trimmed.contains('\\') {
        return None;
    } else {
        trimmed
    };
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    let org = parts[parts.len() - 2];
    let repo = parts[parts.len() - 1];
    Some(format!("{org}/{repo}"))
}

fn workspace_dirname(identity: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(identity.as_bytes());
    let digest = hasher.finalize();
    let hash8 = digest
        .iter()
        .take(4)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let slug = identity
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "workspace" } else { slug };
    let slug: String = slug.chars().take(48).collect();
    format!("{slug}-{hash8}")
}

pub fn list_notes(store: &Store) -> Result<Vec<NoteRef>, MemoryError> {
    let mut notes = Vec::new();
    push_scope_notes(&mut notes, &store.root, Scope::Global)?;
    if store.workspace_dir != store.root {
        push_scope_notes(&mut notes, &store.workspace_dir, Scope::Workspace)?;
    }
    notes.sort_by(|left, right| {
        scope_rank(left.scope)
            .cmp(&scope_rank(right.scope))
            .then_with(|| note_name_order(&left.name, &right.name))
    });
    Ok(notes)
}

fn scope_rank(scope: Scope) -> u8 {
    match scope {
        Scope::Global => 0,
        Scope::Workspace => 1,
    }
}

/// `MEMORY.md` stays before session logs. Session names are reverse
/// chronological by filename, so a later log stays nearer the top.
fn note_name_order(left: &str, right: &str) -> std::cmp::Ordering {
    let left_session = left.starts_with("sessions/");
    let right_session = right.starts_with("sessions/");
    match (left_session, right_session) {
        (false, true) => std::cmp::Ordering::Less,
        (true, false) => std::cmp::Ordering::Greater,
        (true, true) => right.cmp(left),
        (false, false) => left.cmp(right),
    }
}

fn push_scope_notes(notes: &mut Vec<NoteRef>, dir: &Path, scope: Scope) -> Result<(), MemoryError> {
    let memory = dir.join(GLOBAL_NOTE);
    if memory.is_file() {
        notes.push(note_ref(scope, GLOBAL_NOTE, memory, true)?);
    }
    let sessions = dir.join(SESSIONS);
    if sessions.is_dir() {
        let mut entries = fs::read_dir(&sessions)
            .map_err(|error| {
                MemoryError::new(format!("cannot read {}: {error}", sessions.display()))
            })?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            })
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = format!("{SESSIONS}/{}", entry.file_name().to_string_lossy());
            notes.push(note_ref(scope, &name, entry.path(), false)?);
        }
    }
    Ok(())
}

fn note_ref(
    scope: Scope,
    name: &str,
    path: PathBuf,
    index_candidate: bool,
) -> Result<NoteRef, MemoryError> {
    let body = fs::read_to_string(&path)
        .map_err(|error| MemoryError::new(format!("cannot read {}: {error}", path.display())))?;
    let generated_index = index_candidate && is_generated_index(&body);
    // The guide's undeletable file is MEMORY.md itself, generated or human.
    let undeletable = generated_index || name == GLOBAL_NOTE;
    Ok(NoteRef {
        scope,
        name: name.to_string(),
        path,
        generated_index,
        undeletable,
        empty: body.trim().is_empty(),
    })
}

pub(crate) fn is_generated_index(body: &str) -> bool {
    body.lines().any(|line| {
        let trimmed = line.trim();
        trimmed == "<!-- codsh-memory-index -->" || trimmed.starts_with("<!-- grok-memory-index")
    })
}

pub fn read_note(note: &NoteRef) -> Result<String, MemoryError> {
    fs::read_to_string(&note.path)
        .map_err(|error| MemoryError::new(format!("cannot read {}: {error}", note.path.display())))
}

/// Keyword search through the FTS5 index. Generated indexes are not rows.
/// A missing or damaged index is rebuilt from the notes first. A foreign
/// SQLite file is not opened as if it were this catalog.
pub fn search_notes(store: &Store, query: &str) -> Result<Vec<SearchHit>, MemoryError> {
    ensure_search_index(store)?;
    if fts_terms(query).is_empty() {
        return Ok(Vec::new());
    }
    search_indexed(store, query)
}

fn search_indexed(store: &Store, query: &str) -> Result<Vec<SearchHit>, MemoryError> {
    let terms = fts_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    for path in index_paths(store) {
        if !path.is_file() {
            continue;
        }
        let match_query = fts_match(&terms);
        hits.extend(
            search_index_file(&path, store, &match_query)?
                .into_iter()
                .map(|(_, hit)| hit),
        );
    }
    hits.sort_by(|left, right| {
        scope_rank_name(&left.scope)
            .cmp(&scope_rank_name(&right.scope))
            .then_with(|| left.note.name.cmp(&right.note.name))
            .then_with(|| left.line.cmp(&right.line))
    });
    hits.truncate(SEARCH_CAP);
    Ok(hits)
}

fn scope_rank_name(scope: &str) -> u8 {
    match scope {
        "global" => 0,
        "workspace" => 1,
        _ => 2,
    }
}

pub fn has_search_terms(query: &str) -> bool {
    !fts_terms(query).is_empty()
}

fn fts_terms(query: &str) -> Vec<String> {
    query
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(|term| term.to_ascii_lowercase())
        .collect()
}

/// Session-log hits for first-turn recall, best BM25 rank first. The
/// reference (`index.rs` `search_fts_by_sources`) drops stop words with
/// `extract_keywords` and joins the rest with ` OR `, so a conversational
/// prompt still finds a log that shares only some of its words.
/// `search_notes` keeps every term required.
fn recall_indexed(store: &Store, query: &str) -> Result<Vec<SearchHit>, MemoryError> {
    let keywords = crate::memory_keywords::extract_keywords(query);
    if keywords.is_empty() {
        return Ok(Vec::new());
    }
    let match_query = fts_any(&keywords);
    let mut ranked = Vec::new();
    for path in index_paths(store) {
        if !path.is_file() {
            continue;
        }
        ranked.extend(search_index_file(&path, store, &match_query)?);
    }
    ranked.sort_by(|left, right| left.0.total_cmp(&right.0));
    Ok(ranked.into_iter().map(|(_, hit)| hit).collect())
}

/// Quoted keywords joined with ` OR `.
fn fts_any(keywords: &[String]) -> String {
    keywords
        .iter()
        .map(|keyword| format!("\"{}\"", keyword.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// Quote each term so user text cannot change the FTS expression.
fn fts_match(terms: &[String]) -> String {
    terms
        .iter()
        .map(|term| format!("\"{term}\""))
        .collect::<Vec<_>>()
        .join(" AND ")
}

pub fn save_note(store: &Store, scope: Scope, text: &str) -> Result<SavedNote, MemoryError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(MemoryError::new(
            "memory note is empty; nothing was written",
        ));
    }
    let dir = scope_dir(store, scope);
    fs::create_dir_all(dir)
        .map_err(|error| MemoryError::new(format!("cannot create {}: {error}", dir.display())))?;
    let path = dir.join(GLOBAL_NOTE);
    let created = !path.exists();
    if created {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|error| {
                MemoryError::new(format!("cannot write {}: {error}", path.display()))
            })?;
        writeln!(file, "{CONFIRM_HEADING}").map_err(write_error)?;
        writeln!(file, "- {text}").map_err(write_error)?;
        file.flush().map_err(write_error)?;
    } else {
        let previous = fs::read_to_string(&path).map_err(|error| {
            MemoryError::new(format!("cannot read {}: {error}", path.display()))
        })?;
        if is_generated_index(&previous) {
            return Err(MemoryError::new(format!(
                "generated index {} is read-only; the note was not written over it",
                path.display()
            )));
        }
        let note = NoteRef {
            scope,
            name: GLOBAL_NOTE.to_string(),
            path: path.clone(),
            generated_index: false,
            undeletable: true,
            empty: false,
        };
        let mut next = previous.clone();
        if !next.contains(CONFIRM_HEADING) {
            if !next.ends_with('\n') {
                next.push('\n');
            }
            next.push_str(&format!("\n{CONFIRM_HEADING}\n"));
        } else if !next.ends_with('\n') {
            next.push('\n');
        }
        next.push_str(&format!("- {text}\n"));
        // A concurrent editor keeps the file already on disk.
        edit_note(store, &note, &previous, &next)?;
    }
    rebuild_scope_index(store, scope)?;
    Ok(SavedNote {
        path,
        scope,
        created,
    })
}

fn write_error(error: io::Error) -> MemoryError {
    MemoryError::new(format!("cannot write memory note: {error}"))
}

fn scope_dir(store: &Store, scope: Scope) -> &Path {
    match scope {
        Scope::Global => &store.root,
        Scope::Workspace => &store.workspace_dir,
    }
}

/// Delete one session note. `MEMORY.md` (human or generated) and files
/// outside the store are refused. `x` is not `memory clear`.
pub fn forget_note(store: &Store, note: &NoteRef) -> Result<(), MemoryError> {
    if note.generated_index || note.undeletable || note.name == GLOBAL_NOTE {
        return Err(MemoryError::new(format!(
            "{} cannot be deleted; edit it or use memory clear for that scope",
            note.path.display()
        )));
    }
    if !path_in_store(store, &note.path) {
        return Err(MemoryError::new(
            "refusing to delete a file outside the memory store",
        ));
    }
    fs::remove_file(&note.path).map_err(|error| {
        MemoryError::new(format!("cannot delete {}: {error}", note.path.display()))
    })?;
    rebuild_scope_index(store, note.scope)?;
    Ok(())
}

fn path_in_store(store: &Store, path: &Path) -> bool {
    let Ok(root) = store.root.canonicalize() else {
        return false;
    };
    let Ok(target) = path.canonicalize() else {
        return false;
    };
    target.starts_with(root)
}

/// Replace the note body. A same-path conflict keeps the file that is already
/// on disk and returns it so the caller can show both versions.
pub fn edit_note(
    store: &Store,
    note: &NoteRef,
    previous: &str,
    next: &str,
) -> Result<String, MemoryError> {
    if note.generated_index {
        return Err(MemoryError::new(
            "generated indexes are read-only; edit the source note",
        ));
    }
    if note.name == GLOBAL_NOTE && is_generated_index(&read_note(note)?) {
        return Err(MemoryError::new(
            "generated indexes are read-only; edit the source note",
        ));
    }
    if !path_in_store(store, &note.path) {
        return Err(MemoryError::new(
            "refusing to edit a file outside the memory store",
        ));
    }
    let current = read_note(note)?;
    if current != previous {
        return Err(MemoryError::new(format!(
            "memory file changed on disk; kept {} and did not overwrite it",
            note.path.display()
        )));
    }
    atomic_write(&note.path, next)?;
    rebuild_scope_index(store, note.scope)?;
    Ok(next.to_string())
}

pub(crate) fn atomic_write(path: &Path, body: &str) -> Result<(), MemoryError> {
    let parent = path.parent().unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("note");
    // A fixed sibling name is shared by every writer and can already be a
    // symlink. Create a private file and refuse to open a link.
    let tmp = exclusive_temp(parent, name)?;
    let wrote = fs::write(&tmp, body);
    if let Err(error) = wrote {
        let _ = fs::remove_file(&tmp);
        return Err(MemoryError::new(format!(
            "cannot write {}: {error}",
            tmp.display()
        )));
    }
    if let Err(error) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(MemoryError::new(format!(
            "cannot replace {}: {error}",
            path.display()
        )));
    }
    Ok(())
}

/// `.{name}.tmp.<pid>.<n>`, created with `create_new`. An existing symlink at
/// a guessed name is never opened or replaced.
fn exclusive_temp(parent: &Path, name: &str) -> Result<PathBuf, MemoryError> {
    let pid = std::process::id();
    for salt in 0..64u32 {
        let path = parent.join(format!(".{name}.tmp.{pid}.{salt}"));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                drop(file);
                return Ok(path);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(MemoryError::new(format!(
                    "cannot create {}: {error}",
                    path.display()
                )));
            }
        }
    }
    Err(MemoryError::new(
        "cannot create a private temporary file for the memory note",
    ))
}

#[derive(Clone)]
struct Chunk {
    scope: String,
    name: String,
    path: String,
    line: i64,
    body: String,
}

fn rebuild_scope_index(store: &Store, scope: Scope) -> Result<(), MemoryError> {
    let notes = list_notes(store)?;
    let chunks = chunks_for(&notes, Some(scope))?;
    let path = scope_dir(store, scope).join(INDEX_NAME);
    write_sqlite_index(&path, &chunks)
}

pub fn rebuild_index(store: &Store) -> Result<(), MemoryError> {
    let notes = list_notes(store)?;
    let chunks = chunks_for(&notes, None)?;
    let global_only: Vec<Chunk> = chunks
        .iter()
        .filter(|chunk| chunk.scope == "global")
        .cloned()
        .collect();
    write_sqlite_index(&store.root.join(INDEX_NAME), &global_only)?;
    if store.workspace_dir != store.root {
        let workspace_only: Vec<Chunk> = chunks
            .iter()
            .filter(|chunk| chunk.scope != "global")
            .cloned()
            .collect();
        write_sqlite_index(&store.workspace_dir.join(INDEX_NAME), &workspace_only)?;
    }
    Ok(())
}

fn chunks_for(notes: &[NoteRef], only: Option<Scope>) -> Result<Vec<Chunk>, MemoryError> {
    let mut chunks = Vec::new();
    for note in notes {
        if note.generated_index || only.is_some_and(|scope| note.scope != scope) {
            continue;
        }
        let body = read_note(note)?;
        let scope = chunk_scope(note);
        for (index, line) in body.lines().enumerate() {
            let text = line.trim();
            if text.is_empty() {
                continue;
            }
            chunks.push(Chunk {
                scope: scope.to_string(),
                name: note.name.clone(),
                path: note.path.display().to_string(),
                line: (index + 1) as i64,
                body: text.to_string(),
            });
        }
    }
    Ok(chunks)
}

fn chunk_scope(note: &NoteRef) -> &'static str {
    if note.name.starts_with("sessions/") {
        "session"
    } else {
        note.scope.as_str()
    }
}

/// Replace `index.sqlite` with an FTS5 catalog built from the notes.
/// A foreign database is left in place. A damaged file is replaced only after
/// the new database is complete, and the notes themselves are not written.
fn write_sqlite_index(path: &Path, chunks: &[Chunk]) -> Result<(), MemoryError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            MemoryError::new(format!("cannot create {}: {error}", parent.display()))
        })?;
    }
    match index_health(path) {
        IndexHealth::Foreign => {
            return Err(MemoryError::new(format!(
                "memory index {} is not a codsh FTS index; it was left unchanged",
                path.display()
            )));
        }
        IndexHealth::Missing | IndexHealth::Damaged(_) | IndexHealth::Usable => {}
    }
    let parent = path.parent().unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(INDEX_NAME);
    let tmp = exclusive_temp(parent, name)?;
    // create_new left an empty file. SQLite refuses to open that as a new
    // database, so remove the placeholder and let SQLite create it.
    let _ = fs::remove_file(&tmp);
    let built = build_index_file(&tmp, chunks);
    if let Err(error) = built {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    if let Err(error) = replace_index_file(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    Ok(())
}

fn build_index_file(path: &Path, chunks: &[Chunk]) -> Result<(), MemoryError> {
    let connection = Connection::open(path).map_err(sql_error)?;
    connection
        .execute_batch(
            "CREATE TABLE meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE notes_fts USING fts5(
                scope UNINDEXED,
                name UNINDEXED,
                path UNINDEXED,
                line UNINDEXED,
                body,
                tokenize = 'unicode61'
            );",
        )
        .map_err(sql_error)?;
    // `kind` is the only meta row readers check. Workspace identity lives on
    // the directory name, and the file mtime is the rebuild clock.
    connection
        .execute(
            "INSERT INTO meta (key, value) VALUES ('kind', 'codsh-memory-fts5')",
            [],
        )
        .map_err(sql_error)?;
    let tx = connection.unchecked_transaction().map_err(sql_error)?;
    {
        let mut insert = tx
            .prepare(
                "INSERT INTO notes_fts (scope, name, path, line, body) VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(sql_error)?;
        for chunk in chunks {
            insert
                .execute(params![
                    chunk.scope,
                    chunk.name,
                    chunk.path,
                    chunk.line,
                    chunk.body
                ])
                .map_err(sql_error)?;
        }
    }
    tx.commit().map_err(sql_error)?;
    Ok(())
}

fn sql_error(error: rusqlite::Error) -> MemoryError {
    MemoryError::new(format!("memory index: {error}"))
}

fn index_health(path: &Path) -> IndexHealth {
    if !path.exists() {
        return IndexHealth::Missing;
    }
    let header = fs::read(path).unwrap_or_default();
    if header.len() < 16 || &header[..16] != b"SQLite format 3\0" {
        return IndexHealth::Damaged("not a SQLite database".into());
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let Ok(connection) = Connection::open_with_flags(path, flags) else {
        return IndexHealth::Damaged("cannot open".into());
    };
    let kind: Result<Option<String>, _> = connection
        .query_row("SELECT value FROM meta WHERE key = 'kind'", [], |row| {
            row.get(0)
        })
        .optional();
    match kind {
        Ok(Some(kind)) if kind == "codsh-memory-fts5" => {
            let fts = connection.query_row("SELECT count(*) FROM notes_fts", [], |row| {
                row.get::<_, i64>(0)
            });
            if fts.is_ok() {
                IndexHealth::Usable
            } else {
                IndexHealth::Damaged("FTS table is unreadable".into())
            }
        }
        Ok(Some(_)) | Ok(None) => IndexHealth::Foreign,
        Err(_) => IndexHealth::Foreign,
    }
}

/// Rows matching `match_query`, with their BM25 rank (lower is better).
fn search_index_file(
    path: &Path,
    store: &Store,
    match_query: &str,
) -> Result<Vec<(f64, SearchHit)>, MemoryError> {
    if !matches!(index_health(path), IndexHealth::Usable) {
        return Ok(Vec::new());
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection = Connection::open_with_flags(path, flags).map_err(sql_error)?;
    let mut statement = connection
        .prepare(
            "SELECT scope, name, path, line, rank FROM notes_fts
             WHERE notes_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )
        .map_err(sql_error)?;
    let rows = statement
        .query_map(params![match_query, SEARCH_CAP as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, f64>(4)?,
            ))
        })
        .map_err(sql_error)?;
    let mut hits = Vec::new();
    for row in rows {
        let (scope, name, path, line, rank) = row.map_err(sql_error)?;
        let Some(note) = note_for_hit(store, &scope, &name, &path)? else {
            continue;
        };
        hits.push((
            rank,
            SearchHit {
                note,
                line: line.max(1) as usize,
                scope,
            },
        ));
    }
    Ok(hits)
}

fn note_for_hit(
    store: &Store,
    scope: &str,
    name: &str,
    path: &str,
) -> Result<Option<NoteRef>, MemoryError> {
    let notes = list_notes(store)?;
    Ok(notes.into_iter().find(|note| {
        note.name == name
            && note.path.display().to_string() == path
            && (note.scope.as_str() == scope
                || (scope == "session" && note.name.starts_with("sessions/")))
    }))
}

fn index_paths(store: &Store) -> Vec<PathBuf> {
    let mut paths = vec![store.root.join(INDEX_NAME)];
    if store.workspace_dir != store.root {
        paths.push(store.workspace_dir.join(INDEX_NAME));
    }
    paths
}

fn ensure_search_index(store: &Store) -> Result<(), MemoryError> {
    let damaged = index_paths(store)
        .into_iter()
        .any(|path| matches!(index_health(&path), IndexHealth::Damaged(_)));
    // Missing is a cleared index, not a request to recreate it. A foreign
    // database is left untouched. Damage is rebuilt from the notes.
    if damaged {
        rebuild_index(store)?;
    }
    Ok(())
}

/// Rename a finished index into place. On this platform rename replaces a
/// regular file. It does not follow a symlink, so a linked index stays put.
fn replace_index_file(tmp: &Path, path: &Path) -> Result<(), MemoryError> {
    if let Ok(meta) = fs::symlink_metadata(path)
        && meta.file_type().is_symlink()
    {
        return Err(MemoryError::new(format!(
            "refusing to replace symlinked memory index {}",
            path.display()
        )));
    }
    fs::rename(tmp, path)
        .map_err(|error| MemoryError::new(format!("cannot replace {}: {error}", path.display())))
}

/// Disable never removes notes. The session flag is in-process only.
pub fn disable_keeps_files(store: &Store) -> Result<Vec<PathBuf>, MemoryError> {
    let mut kept = Vec::new();
    if store.root.is_dir() {
        collect_files(&store.root, &mut kept)?;
    }
    Ok(kept)
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), MemoryError> {
    for entry in fs::read_dir(dir)
        .map_err(|error| MemoryError::new(format!("cannot read {}: {error}", dir.display())))?
    {
        let entry = entry.map_err(|error| MemoryError::new(error.to_string()))?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

/// First-turn context. Global and workspace `MEMORY.md` are included. Session
/// logs are included only when keyword search matches `query`. The block is
/// capped. Generated indexes are omitted. Warnings name a damaged index and
/// never replace a note.
pub fn injection_block(store: &Store, enabled: bool) -> Result<String, MemoryError> {
    injection_block_for(store, enabled, "")
}

pub fn injection_block_for(
    store: &Store,
    enabled: bool,
    query: &str,
) -> Result<String, MemoryError> {
    if !enabled {
        return Ok(String::new());
    }
    let notes = list_notes(store)?;
    let mut selected: Vec<NoteRef> = notes
        .iter()
        .filter(|note| !note.generated_index && note.name == GLOBAL_NOTE)
        .cloned()
        .collect();
    for hit in recall_indexed(store, query)? {
        if hit.scope == "session" && !selected.iter().any(|note| note.path == hit.note.path) {
            selected.push(hit.note);
        }
    }
    selected.truncate(INJECTION_NOTE_CAP);
    if selected.is_empty() && store.warnings.is_empty() {
        return Ok(String::new());
    }
    let mut body = String::from(
        "<local-memory>\nLocal memory notes the user saved. Read-only context. Do not upload them.\n",
    );
    for warning in &store.warnings {
        body.push_str(&format!("[warning] {warning}\n"));
    }
    let mut remaining = INJECTION_CHARS;
    for note in &selected {
        if remaining == 0 {
            break;
        }
        let text = read_note(note)?;
        let excerpt = clip_chars(text.trim(), remaining);
        remaining = remaining.saturating_sub(excerpt.chars().count());
        let label = if note.name.starts_with("sessions/") {
            "session"
        } else {
            note.scope.as_str()
        };
        body.push_str(&format!("[{label} {}]\n{excerpt}\n", note.name));
    }
    body.push_str("</local-memory>\n");
    Ok(body)
}

fn clip_chars(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// Surface a damaged index without hiding the notes that are still readable.
pub fn warning_notice(store: &Store) -> String {
    store.warnings.join("\n")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClearScope {
    Workspace,
    Global,
    All,
}

pub fn parse_clear(args: &[String]) -> Result<(ClearScope, bool, bool), MemoryError> {
    let mut scope = None;
    let mut yes = false;
    let mut help = false;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        match arg {
            "--workspace" => set_scope(&mut scope, ClearScope::Workspace)?,
            "--global" => set_scope(&mut scope, ClearScope::Global)?,
            "--all" => set_scope(&mut scope, ClearScope::All)?,
            "--yes" | "-y" => yes = true,
            "--help" | "-h" => help = true,
            "--debug" | "--debug-file" | "--leader-socket" => {
                return Err(MemoryError::new(format!(
                    "{arg} is not a memory clear scope; use --workspace, --global, or --all"
                )));
            }
            other
                if other.starts_with("--debug-file=") || other.starts_with("--leader-socket=") =>
            {
                return Err(MemoryError::new(format!(
                    "{other} is not a memory clear scope"
                )));
            }
            other => {
                return Err(MemoryError::new(format!(
                    "unsupported memory option {other}; use codsh --rust memory clear --help"
                )));
            }
        }
        index += 1;
    }
    Ok((scope.unwrap_or(ClearScope::Workspace), yes, help))
}

fn set_scope(slot: &mut Option<ClearScope>, next: ClearScope) -> Result<(), MemoryError> {
    if slot.is_some() {
        return Err(MemoryError::new(
            "memory clear accepts only one of --workspace, --global, or --all",
        ));
    }
    *slot = Some(next);
    Ok(())
}

pub fn clear_help() -> &'static str {
    "Clear local memory notes\n\nUsage: codsh --rust memory clear [--workspace|--global|--all] [--yes|-y]\n\nDefault scope is the current workspace (MEMORY.md, sessions/, and index.sqlite).\n--global clears the global MEMORY.md. --all clears both scopes.\nConfirmation is required unless --yes is passed.\nDisabling memory does not clear files. This command does not upload anything."
}

pub fn memory_help() -> &'static str {
    "Local memory\n\nUsage: codsh --rust memory clear [--workspace|--global|--all] [--yes|-y]\n       codsh --rust memory help\n\nBrowse notes with /memory. [memory] enabled = false leaves the browser open and keeps notes out of a session's first prompt until t turns the session on. Notes are only sent on a session's first prompt; once that prompt is already sent, toggling t no longer reaches any prompt in this session, and /new drops the toggle and follows config.toml again instead of carrying it forward.\n/remember saves a confirmed note. GROK_MEMORY=0 and --no-memory hide /memory for the process and do not delete files."
}

/// Delete the selected scope's `MEMORY.md`, and for a workspace also
/// `sessions/` and `index.sqlite`. Other scopes and unrelated files stay.
/// Global clear removes only the global `MEMORY.md`.
pub fn clear_scope(store: &Store, scope: ClearScope) -> Result<Vec<PathBuf>, MemoryError> {
    let mut removed = Vec::new();
    let clear_global = matches!(scope, ClearScope::Global | ClearScope::All);
    let clear_workspace = matches!(scope, ClearScope::Workspace | ClearScope::All);
    if clear_global {
        remove_memory_file(&store.root.join(GLOBAL_NOTE), &mut removed)?;
    }
    if clear_workspace {
        remove_memory_file(&store.workspace_dir.join(GLOBAL_NOTE), &mut removed)?;
        remove_tree(&store.workspace_dir.join(SESSIONS), &mut removed)?;
        remove_memory_file(&store.workspace_dir.join(INDEX_NAME), &mut removed)?;
    }
    // Clear removes that scope's index. Do not write a replacement over it.
    Ok(removed)
}

fn remove_memory_file(path: &Path, removed: &mut Vec<PathBuf>) -> Result<(), MemoryError> {
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(path)
        .map_err(|error| MemoryError::new(format!("cannot delete {}: {error}", path.display())))?;
    removed.push(path.to_path_buf());
    Ok(())
}

fn remove_tree(path: &Path, removed: &mut Vec<PathBuf>) -> Result<(), MemoryError> {
    if !path.exists() {
        return Ok(());
    }
    fs::remove_dir_all(path)
        .map_err(|error| MemoryError::new(format!("cannot delete {}: {error}", path.display())))?;
    removed.push(path.to_path_buf());
    Ok(())
}

pub fn confirm_prompt(text: &str, scope: Scope, path: &Path) -> String {
    format!(
        "Save this note to {} memory?\n{}\n{}\ny=save  n=cancel  Tab keeps the typed note (no rewrite)",
        scope.as_str(),
        text.trim(),
        path.display()
    )
}

pub fn saved_message(path: &Path) -> String {
    format!("Memory saved to {}", path.display())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::TempDir::new().unwrap();
        let grok = dir.path().join(".grok");
        let project = dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(project.join(".git")).unwrap();
        fs::write(
            project.join(".git/config"),
            "[remote \"origin\"]\n\turl = git@github.com:Example/Widget.git\n",
        )
        .unwrap();
        (dir, grok, project)
    }

    #[test]
    fn clones_share_workspace_scope_and_paths_do_not() {
        let (dir, grok, project) = fixture();
        let clone = dir.path().join("clone");
        fs::create_dir_all(clone.join(".git")).unwrap();
        fs::write(
            clone.join(".git/config"),
            "[remote \"origin\"]\n\turl = https://github.com/Example/Widget.git\n",
        )
        .unwrap();
        let other = dir.path().join("other");
        fs::create_dir_all(other.join(".git")).unwrap();
        fs::write(
            other.join(".git/config"),
            "[remote \"origin\"]\n\turl = git@github.com:Example/Other.git\n",
        )
        .unwrap();
        let worktree = dir.path().join("wt");
        let git_dir = project.join(".git/worktrees/wt");
        fs::create_dir_all(&git_dir).unwrap();
        fs::write(git_dir.join("commondir"), "../..\n").unwrap();
        fs::create_dir_all(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", git_dir.display()),
        )
        .unwrap();
        let first = open_store(&grok, &project).unwrap();
        let second = open_store(&grok, &clone).unwrap();
        let tree = open_store(&grok, &worktree).unwrap();
        let foreign = open_store(&grok, &other).unwrap();
        assert_eq!(first.identity, "Example/Widget");
        assert_eq!(first.workspace_dir, second.workspace_dir);
        assert_eq!(first.workspace_dir, tree.workspace_dir);
        assert_ne!(first.workspace_dir, foreign.workspace_dir);
        let plain = dir.path().join("plain");
        fs::create_dir_all(&plain).unwrap();
        let unscoped = open_store(&grok, &plain).unwrap();
        assert!(unscoped.identity.contains("plain"));
        assert_ne!(unscoped.workspace_dir, first.workspace_dir);
    }

    #[test]
    fn remember_appends_to_memory_md_and_clear_drops_sessions_and_sqlite() {
        let (dir, grok, project) = fixture();
        let store = open_store(&grok, &project).unwrap();
        fs::create_dir_all(&store.root).unwrap();
        fs::write(store.root.join(GLOBAL_NOTE), "human global note\n").unwrap();
        let sessions = store.workspace_dir.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(sessions.join("day.md"), "session log\n").unwrap();
        fs::write(store.workspace_dir.join("index.sqlite"), b"sqlite").unwrap();
        fs::write(store.workspace_dir.join("keep.txt"), "other file\n").unwrap();
        let saved = save_note(&store, Scope::Workspace, "always open PR links").unwrap();
        assert_eq!(saved.path, store.workspace_dir.join(GLOBAL_NOTE));
        let body = fs::read_to_string(&saved.path).unwrap();
        assert!(body.contains("always open PR links"));
        assert!(!saved.path.ends_with("topics/preferences.md"));
        let human = list_notes(&store)
            .unwrap()
            .into_iter()
            .find(|note| note.scope == Scope::Global)
            .unwrap();
        assert!(!human.generated_index);
        assert!(forget_note(&store, &human).is_err());
        assert!(
            fs::read_to_string(store.root.join(GLOBAL_NOTE))
                .unwrap()
                .contains("human global note")
        );
        clear_scope(&store, ClearScope::Workspace).unwrap();
        assert!(!store.workspace_dir.join(GLOBAL_NOTE).exists());
        assert!(!sessions.exists());
        assert!(!store.workspace_dir.join(INDEX_NAME).exists());
        assert_eq!(
            fs::read_to_string(store.workspace_dir.join("keep.txt")).unwrap(),
            "other file\n"
        );
        assert!(
            fs::read_to_string(store.root.join(GLOBAL_NOTE))
                .unwrap()
                .contains("human global note")
        );
        let _ = dir;
    }

    #[test]
    fn explicit_save_search_edit_and_forget_stay_in_scope() {
        let (_dir, grok, project) = fixture();
        let store = open_store(&grok, &project).unwrap();
        let other = _dir.path().join("other-repo");
        fs::create_dir_all(other.join(".git")).unwrap();
        fs::write(
            other.join(".git/config"),
            "[remote \"origin\"]\n\turl = https://github.com/Example/Other.git\n",
        )
        .unwrap();
        let foreign = open_store(&grok, &other).unwrap();
        let saved = save_note(&store, Scope::Workspace, "always open PR links").unwrap();
        assert_eq!(saved.path, store.workspace_dir.join(GLOBAL_NOTE));
        let global = save_note(&store, Scope::Global, "prefer concise diffs").unwrap();
        assert!(global.path.starts_with(&store.root));
        assert!(!global.path.starts_with(&store.workspace_dir));
        let listed = list_notes(&store).unwrap();
        assert!(listed.iter().any(|note| note.scope == Scope::Workspace));
        assert!(listed.iter().any(|note| note.scope == Scope::Global));
        let hits = search_notes(&store, "PR links").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note.scope, Scope::Workspace);
        assert_eq!(hits[0].scope, "workspace");
        assert!(is_sqlite_file(&store.root.join(INDEX_NAME)));
        assert!(!foreign.workspace_dir.join(GLOBAL_NOTE).exists());
        assert!(search_notes(&foreign, "PR links").unwrap().is_empty());
        let note = listed
            .iter()
            .find(|note| note.scope == Scope::Workspace)
            .unwrap();
        let previous = read_note(note).unwrap();
        edit_note(&store, note, &previous, "# kept\n- edited note\n").unwrap();
        assert!(read_note(note).unwrap().contains("edited note"));
        let conflict = edit_note(&store, note, "stale body", "overwrite").unwrap_err();
        assert!(conflict.message.contains("changed on disk"));
        assert!(read_note(note).unwrap().contains("edited note"));
        // A human MEMORY.md cannot be deleted with x. Clearing the workspace
        // removes that file and leaves the global note.
        assert!(forget_note(&store, note).is_err());
        assert!(note.path.exists());
        clear_scope(&store, ClearScope::Workspace).unwrap();
        assert!(!note.path.exists());
        assert!(global.path.exists());
        let reopened = open_store(&grok, &project).unwrap();
        assert!(search_notes(&reopened, "PR links").unwrap().is_empty());
        assert_eq!(search_notes(&reopened, "concise").unwrap().len(), 1);
    }

    #[test]
    fn disabling_keeps_files_and_a_damaged_index_does_not_drop_notes() {
        let (_dir, grok, project) = fixture();
        let store = open_store(&grok, &project).unwrap();
        let saved = save_note(&store, Scope::Global, "keep this fact").unwrap();
        let index = store.root.join(INDEX_NAME);
        assert!(is_sqlite_file(&index));
        fs::write(&index, b"not a sqlite database").unwrap();
        let reopened = open_store(&grok, &project).unwrap();
        assert!(
            reopened
                .warnings
                .iter()
                .any(|warning| warning.contains("damaged"))
        );
        assert!(
            fs::read_to_string(&saved.path)
                .unwrap()
                .contains("keep this fact")
        );
        let kept = disable_keeps_files(&reopened).unwrap();
        assert!(kept.iter().any(|path| path == &saved.path));
        assert!(saved.path.exists());
        rebuild_index(&reopened).unwrap();
        assert!(is_sqlite_file(&reopened.root.join(INDEX_NAME)));
        let hits = search_notes(&reopened, "keep this fact").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].scope, "global");
        let body = fs::read_to_string(&saved.path).unwrap();
        assert!(body.contains("keep this fact"));
        assert!(!body.contains("codsh-memory-index"));
        let note_bytes = fs::read(&saved.path).unwrap();
        assert_ne!(&note_bytes[..15.min(note_bytes.len())], b"SQLite format 3");
    }

    #[test]
    fn foreign_sqlite_is_not_replaced_and_fts_search_reads_the_rebuilt_index() {
        let (dir, grok, project) = fixture();
        let store = open_store(&grok, &project).unwrap();
        fs::create_dir_all(&store.root).unwrap();
        let foreign = store.root.join(INDEX_NAME);
        let connection = rusqlite::Connection::open(&foreign).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE kept (value TEXT); INSERT INTO kept VALUES ('foreign-row');",
            )
            .unwrap();
        drop(connection);
        let before = fs::read(&foreign).unwrap();
        let error = save_note(&store, Scope::Global, "do not clobber").unwrap_err();
        assert!(
            error.message.contains("left unchanged"),
            "{}",
            error.message
        );
        assert_eq!(fs::read(&foreign).unwrap(), before);
        // The note is the source of truth. A refused index does not roll it back
        // and does not replace the foreign database.
        assert!(
            fs::read_to_string(store.root.join(GLOBAL_NOTE))
                .unwrap()
                .contains("do not clobber")
        );
        let reopened = open_store(&grok, &project).unwrap();
        assert!(
            reopened
                .warnings
                .iter()
                .any(|warning| warning.contains("not a codsh FTS index"))
        );
        fs::remove_file(&foreign).unwrap();
        save_note(&store, Scope::Global, "alpha token").unwrap();
        save_note(&store, Scope::Workspace, "beta token").unwrap();
        let global_hits = search_notes(&store, "alpha").unwrap();
        assert_eq!(global_hits.len(), 1);
        assert_eq!(global_hits[0].scope, "global");
        let workspace_hits = search_notes(&store, "beta").unwrap();
        assert_eq!(workspace_hits[0].scope, "workspace");
        assert!(
            search_notes(&store, "'; DROP TABLE notes_fts; --")
                .unwrap()
                .is_empty()
        );
        let header = fs::read(store.root.join(INDEX_NAME)).unwrap();
        assert_eq!(&header[..16], b"SQLite format 3\0");
        let _ = dir;
    }

    #[test]
    fn first_turn_injection_is_bounded_and_later_turns_are_not() {
        let (_dir, grok, project) = fixture();
        let store = open_store(&grok, &project).unwrap();
        save_note(&store, Scope::Global, "global preference").unwrap();
        save_note(&store, Scope::Workspace, "workspace fact").unwrap();
        fs::create_dir_all(store.workspace_dir.join(SESSIONS)).unwrap();
        fs::write(
            store.workspace_dir.join(SESSIONS).join("day.md"),
            "session keyword zebra\n",
        )
        .unwrap();
        rebuild_index(&store).unwrap();
        let first = injection_block_for(&store, true, "zebra").unwrap();
        assert!(first.contains("global preference"));
        assert!(first.contains("workspace fact"));
        assert!(first.contains("session keyword zebra"));
        assert!(first.contains("[session "));
        let later = injection_block_for(&store, false, "zebra").unwrap();
        assert!(later.is_empty());
        let without_query = injection_block(&store, true).unwrap();
        assert!(without_query.contains("workspace fact"));
        assert!(!without_query.contains("session keyword"));
        let huge = "word ".repeat(5_000);
        save_note(&store, Scope::Workspace, &huge).unwrap();
        let bounded = injection_block(&store, true).unwrap();
        assert!(bounded.chars().count() < 6_000);
    }

    #[test]
    fn recall_matches_any_keyword_ranked_and_ignores_stop_words() {
        // Issue #186 follow-up: a conversational first prompt used to need
        // every word in one log (AND), so recall before Dream found nothing.
        let (_dir, grok, project) = fixture();
        let store = open_store(&grok, &project).unwrap();
        let sessions = store.workspace_dir.join(SESSIONS);
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("2026-09-26-user_requested-aaaa1111.md"),
            "## Decisions\n- The widget service listens on port 7431.\n",
        )
        .unwrap();
        fs::write(
            sessions.join("2026-09-26-user_requested-bbbb2222.md"),
            "## Decisions\n- The widget dashboard is blue.\n",
        )
        .unwrap();
        fs::write(
            sessions.join("2026-09-26-user_requested-cccc3333.md"),
            "## Decisions\n- Unrelated gardening notes.\n",
        )
        .unwrap();
        rebuild_index(&store).unwrap();
        let prompt = "Which port does the widget service listen on?";
        assert!(search_notes(&store, prompt).unwrap().is_empty());
        let block = injection_block_for(&store, true, prompt).unwrap();
        let port = block.find("port 7431").expect(&block);
        let blue = block.find("dashboard is blue").expect(&block);
        assert!(port < blue, "best BM25 match first: {block}");
        assert!(!block.contains("gardening"), "{block}");
        // Only stop words, numbers, or FTS syntax: no session log, no error.
        for query in ["what is that?", "7431", "\"widget\" OR NEAR(", "*"] {
            let block = injection_block_for(&store, true, query).unwrap();
            if query.contains("widget") {
                assert!(block.contains("port 7431"), "{block}");
            } else {
                assert!(!block.contains("[session "), "{query}: {block}");
            }
        }
    }

    #[test]
    fn atomic_write_does_not_follow_a_temp_symlink() {
        let (dir, grok, project) = fixture();
        let store = open_store(&grok, &project).unwrap();
        save_note(&store, Scope::Workspace, "original note").unwrap();
        let note = store.workspace_dir.join(GLOBAL_NOTE);
        let outside = dir.path().join("outside.md");
        fs::write(&outside, "outside secret\n").unwrap();
        let decoy = store.workspace_dir.join(format!(".{GLOBAL_NOTE}.tmp"));
        symlink(&outside, &decoy).unwrap();
        let current = fs::read_to_string(&note).unwrap();
        edit_note(
            &store,
            &list_notes(&store)
                .unwrap()
                .into_iter()
                .find(|item| item.path == note)
                .unwrap(),
            &current,
            "# kept\n- replaced note\n",
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside secret\n");
        assert!(decoy.symlink_metadata().unwrap().file_type().is_symlink());
        assert!(fs::read_to_string(&note).unwrap().contains("replaced note"));
        let linked_index = store.workspace_dir.join(INDEX_NAME);
        if linked_index.exists() {
            fs::remove_file(&linked_index).unwrap();
        }
        symlink(&outside, &linked_index).unwrap();
        let error = rebuild_index(&store).unwrap_err();
        assert!(error.message.contains("symlinked"));
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside secret\n");
    }

    fn is_sqlite_file(path: &Path) -> bool {
        let bytes = fs::read(path).unwrap_or_default();
        bytes.len() >= 16 && &bytes[..16] == b"SQLite format 3\0"
    }

    #[test]
    fn generated_index_is_not_a_deletable_note_and_injection_uses_human_files() {
        let (_dir, grok, project) = fixture();
        let store = open_store(&grok, &project).unwrap();
        fs::create_dir_all(&store.root).unwrap();
        fs::write(
            store.root.join(GLOBAL_NOTE),
            "<!-- codsh-memory-index -->\n- generated pointer\n",
        )
        .unwrap();
        save_note(&store, Scope::Workspace, "workspace fact").unwrap();
        let notes = list_notes(&store).unwrap();
        let index = notes.iter().find(|note| note.name == GLOBAL_NOTE).unwrap();
        assert!(index.generated_index);
        assert!(index.undeletable);
        let error = forget_note(&store, index).unwrap_err();
        assert!(error.message.contains("cannot be deleted"));
        assert!(index.path.exists());
        let block = injection_block(&store, true).unwrap();
        assert!(block.contains("workspace fact"));
        assert!(!block.contains("generated pointer"));
        assert!(injection_block(&store, false).unwrap().is_empty());
        assert_eq!(
            resolve_enablement(Some(true), Some("0"), false),
            Enablement::ForceOff
        );
        assert_eq!(
            resolve_enablement(Some(false), None, false),
            Enablement::ConfigOff
        );
        assert!(resolve_enablement(None, Some("1"), false).enabled());
        assert!(!resolve_enablement(None, None, false).enabled());
    }

    #[test]
    fn clear_scope_does_not_cross_projects_and_requires_one_scope() {
        let (dir, grok, project) = fixture();
        let store = open_store(&grok, &project).unwrap();
        save_note(&store, Scope::Workspace, "workspace only").unwrap();
        save_note(&store, Scope::Global, "global only").unwrap();
        let error = parse_clear(&["--global".into(), "--workspace".into()]).unwrap_err();
        assert!(error.message.contains("only one"));
        let (scope, yes, help) = parse_clear(&["--yes".into()]).unwrap();
        assert_eq!(scope, ClearScope::Workspace);
        assert!(yes);
        assert!(!help);
        clear_scope(&store, ClearScope::Workspace).unwrap();
        assert!(search_notes(&store, "workspace only").unwrap().is_empty());
        assert_eq!(search_notes(&store, "global only").unwrap().len(), 1);
        let outside = dir.path().join("secret.md");
        fs::write(&outside, "private").unwrap();
        let sneaky = NoteRef {
            scope: Scope::Global,
            name: "secret.md".into(),
            path: outside.clone(),
            generated_index: false,
            undeletable: false,
            empty: false,
        };
        assert!(forget_note(&store, &sneaky).is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "private");
    }

    #[test]
    fn symlink_escape_is_refused() {
        let (dir, grok, project) = fixture();
        let store = open_store(&grok, &project).unwrap();
        fs::create_dir_all(store.root.join(SESSIONS)).unwrap();
        let outside = dir.path().join("outside.md");
        fs::write(&outside, "do not delete\n").unwrap();
        let link = store.root.join(SESSIONS).join("linked.md");
        symlink(&outside, &link).unwrap();
        let note = NoteRef {
            scope: Scope::Global,
            name: "sessions/linked.md".into(),
            path: link,
            generated_index: false,
            undeletable: false,
            empty: false,
        };
        assert!(forget_note(&store, &note).is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "do not delete\n");
    }
}
