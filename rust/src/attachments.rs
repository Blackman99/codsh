//! File references attached from the composer and submitted through ACP.
//!
//! Search follows the frozen Grok `@` contract: `.gitignore` files, including
//! nested ones, and dotfiles stay hidden unless the query starts with `!`.
//! Patterns use gitignore rules, so `**/*.log` hides nested logs rather than
//! looking for a directory named `**`.
//! `@path:2` keeps that line and `@path:10-50` keeps that range. A selected
//! file is a chip, not
//! flattened text. Submit reads the file then, so a removed chip is not sent
//! and a later edit or permission failure is reported instead of leaked bytes.

use serde_json::{Value, json};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

/// Whole-file preview and submit ceiling. Larger files stay unsent.
pub const MAX_ATTACHMENT_BYTES: u64 = 256 * 1024;
/// Preview shown in the composer; the model still receives the admitted range.
pub const PREVIEW_CHARS: usize = 240;
const MAX_MATCHES: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachStatus {
    Ready,
    Missing,
    Permission,
    TooLarge,
    Changed,
    NotAFile,
    Outside,
}

impl AttachStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Missing => "missing",
            Self::Permission => "permission denied",
            Self::TooLarge => "too large",
            Self::Changed => "changed since preview",
            Self::NotAFile => "not a file",
            Self::Outside => "outside workspace",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRef {
    /// Path relative to the workspace, using `/` separators.
    pub relative: String,
    pub range: Option<LineRange>,
    /// Dropped paths the user named but this workspace must not read.
    pub dropped: bool,
}

impl FileRef {
    pub fn mention(&self) -> String {
        let range = self
            .range
            .as_ref()
            .map(|span| {
                if span.start == span.end {
                    format!(":{}", span.start)
                } else {
                    format!(":{}-{}", span.start, span.end)
                }
            })
            .unwrap_or_default();
        if needs_quotes(&self.relative) {
            format!("@\"{}{}\"", self.relative, range)
        } else {
            format!("@{}{}", self.relative, range)
        }
    }

    pub fn display(&self) -> String {
        let name = Path::new(&self.relative)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(self.relative.as_str());
        match &self.range {
            Some(span) => format!("{name}:{}-{}", span.start, span.end),
            None => name.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMatch {
    pub relative: String,
    pub directory: bool,
}

/// A drop that was not admitted. Small enough to return as a `Result` error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachRefusal {
    pub status: AttachStatus,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedAttachment {
    pub mention: String,
    pub status: AttachStatus,
    pub bytes: Option<Vec<u8>>,
    pub text: Option<String>,
    pub size: u64,
    pub modified: Option<SystemTime>,
    pub preview: String,
    pub detail: String,
}

#[derive(Debug, Clone)]
struct IgnoreRule {
    matcher: ignore::gitignore::Gitignore,
}

/// Workspace file search and admission. Reads happen only for an explicit ref.
#[derive(Debug, Clone)]
pub struct WorkspaceIndex {
    root: PathBuf,
    /// Rules from every `.gitignore`, each already rooted at the directory that
    /// contained the file. Nested files apply to their descendants.
    rules: Vec<IgnoreRule>,
}

impl WorkspaceIndex {
    pub fn new(root: &Path) -> Self {
        let root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let mut rules = Vec::new();
        collect_gitignore(&root, &root, &mut rules);
        Self { root, rules }
    }

    pub fn search(&self, query: &str) -> Vec<FileMatch> {
        let (include_hidden, needle) = split_hidden_query(query);
        let mut found = Vec::new();
        self.walk(&self.root, "", include_hidden, &needle, &mut found);
        found.sort_by(|left, right| {
            let left_rank = match_rank(&left.relative, &needle, left.directory);
            let right_rank = match_rank(&right.relative, &needle, right.directory);
            left_rank
                .cmp(&right_rank)
                .then_with(|| left.relative.cmp(&right.relative))
        });
        found.truncate(MAX_MATCHES);
        found
    }

    /// Resolve a typed `@` token. `Err(false)` means the token is not a file query.
    pub fn parse_query(token: &str) -> Result<(bool, String, Option<LineRange>), bool> {
        let Some(rest) = token.strip_prefix('@') else {
            return Err(false);
        };
        if rest.is_empty() || rest.starts_with(' ') {
            return Ok((false, String::new(), None));
        }
        if rest.contains('\n') || rest.contains('\r') {
            return Err(false);
        }
        let (include_hidden, body) = if let Some(stripped) = rest.strip_prefix('!') {
            (true, stripped)
        } else {
            (false, rest)
        };
        let (path, range) = split_range(body);
        if path.is_empty() && range.is_some() {
            return Err(false);
        }
        Ok((include_hidden, path, range))
    }

    pub fn resolve_typed(&self, token: &str) -> Option<FileRef> {
        let (hidden, path, range) = Self::parse_query(token).ok()?;
        if path.is_empty() {
            return None;
        }
        let relative = normalize_relative(&path)?;
        if !hidden && self.is_excluded(&relative) {
            return None;
        }
        let full = self
            .root
            .join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if !full.is_file() {
            return None;
        }
        Some(FileRef {
            relative,
            range,
            dropped: false,
        })
    }

    pub fn resolve_drop(&self, raw: &str) -> Result<FileRef, AttachRefusal> {
        let trimmed = raw.trim().trim_matches('"');
        let path = Path::new(trimmed);
        let candidate = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.root.join(path)
        };
        let Ok(canonical) = fs::canonicalize(&candidate) else {
            return Err(AttachRefusal {
                status: AttachStatus::Missing,
                detail: "file not found".into(),
            });
        };
        if !canonical.starts_with(&self.root) {
            return Err(AttachRefusal {
                status: AttachStatus::Outside,
                detail: "path is outside the workspace".into(),
            });
        }
        let relative = canonical
            .strip_prefix(&self.root)
            .unwrap_or(Path::new(""))
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if relative.is_empty() || !canonical.is_file() {
            return Err(AttachRefusal {
                status: AttachStatus::NotAFile,
                detail: "drop a file, not a directory".into(),
            });
        }
        Ok(FileRef {
            relative,
            range: None,
            dropped: true,
        })
    }

    pub fn prepare(
        &self,
        reference: &FileRef,
        previous: Option<&PreparedAttachment>,
    ) -> PreparedAttachment {
        let mention = reference.mention();
        if reference.relative.contains('\0')
            || reference
                .relative
                .split('/')
                .any(|part| part == ".." || part.is_empty())
        {
            return failure_attachment(
                &mention,
                AttachStatus::Outside,
                "path is outside the workspace",
            );
        }
        let full = self.root.join(
            reference
                .relative
                .replace('/', std::path::MAIN_SEPARATOR_STR),
        );
        let meta = match fs::symlink_metadata(&full) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return failure_attachment(&mention, AttachStatus::Missing, "file not found");
            }
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                return failure_attachment(
                    &mention,
                    AttachStatus::Permission,
                    "read permission denied",
                );
            }
            Err(error) => {
                return failure_attachment(&mention, AttachStatus::Permission, &error.to_string());
            }
        };
        if meta.file_type().is_symlink() {
            match fs::canonicalize(&full) {
                Ok(target) if target.starts_with(&self.root) => {}
                Ok(_) => {
                    return failure_attachment(
                        &mention,
                        AttachStatus::Outside,
                        "symlink target is outside the workspace",
                    );
                }
                Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                    return failure_attachment(
                        &mention,
                        AttachStatus::Permission,
                        "read permission denied",
                    );
                }
                Err(_) => {
                    return failure_attachment(&mention, AttachStatus::Missing, "file not found");
                }
            }
        }
        if !meta.file_type().is_file() && !full.is_file() {
            return failure_attachment(&mention, AttachStatus::NotAFile, "not a regular file");
        }
        if meta.len() > MAX_ATTACHMENT_BYTES {
            return PreparedAttachment {
                mention,
                status: AttachStatus::TooLarge,
                bytes: None,
                text: None,
                size: meta.len(),
                modified: meta.modified().ok(),
                preview: String::new(),
                detail: format!(
                    "file is {} bytes; limit is {MAX_ATTACHMENT_BYTES}",
                    meta.len()
                ),
            };
        }
        let mut file = match File::open(&full) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                return failure_attachment(
                    &mention,
                    AttachStatus::Permission,
                    "read permission denied",
                );
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return failure_attachment(&mention, AttachStatus::Missing, "file not found");
            }
            Err(error) => {
                return failure_attachment(&mention, AttachStatus::Permission, &error.to_string());
            }
        };
        let mut bytes = Vec::new();
        if let Err(error) = file.read_to_end(&mut bytes) {
            let status = if error.kind() == io::ErrorKind::PermissionDenied {
                AttachStatus::Permission
            } else {
                AttachStatus::Missing
            };
            return failure_attachment(&mention, status, &error.to_string());
        }
        if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
            return PreparedAttachment {
                mention,
                status: AttachStatus::TooLarge,
                bytes: None,
                text: None,
                size: bytes.len() as u64,
                modified: meta.modified().ok(),
                preview: String::new(),
                detail: format!("file exceeds {MAX_ATTACHMENT_BYTES} bytes"),
            };
        }
        let modified = meta.modified().ok();
        if let Some(previous) = previous
            && previous.status == AttachStatus::Ready
            && (previous.size != bytes.len() as u64 || previous.modified != modified)
        {
            return PreparedAttachment {
                mention,
                status: AttachStatus::Changed,
                bytes: None,
                text: None,
                size: bytes.len() as u64,
                modified,
                preview: String::new(),
                detail: "file changed since it was attached; remove it or attach it again".into(),
            };
        }
        let text = String::from_utf8(bytes.clone()).ok();
        let sliced = match (&text, &reference.range) {
            (Some(body), Some(span)) => match slice_lines(body, span) {
                Ok(slice) => slice,
                Err(detail) => {
                    return PreparedAttachment {
                        mention,
                        status: AttachStatus::Missing,
                        bytes: None,
                        text: None,
                        size: bytes.len() as u64,
                        modified,
                        preview: String::new(),
                        detail,
                    };
                }
            },
            (None, Some(_)) => {
                return failure_attachment(
                    &mention,
                    AttachStatus::NotAFile,
                    "line ranges require a text file",
                );
            }
            (Some(body), None) => body.clone(),
            (None, None) => String::new(),
        };
        let preview_source = if sliced.is_empty() && text.is_none() {
            format!("binary {} bytes", bytes.len())
        } else {
            sliced.chars().take(PREVIEW_CHARS).collect()
        };
        PreparedAttachment {
            mention,
            status: AttachStatus::Ready,
            bytes: Some(bytes),
            text: if sliced.is_empty() && text.is_none() {
                None
            } else {
                Some(sliced)
            },
            size: meta.len(),
            modified,
            preview: preview_source,
            detail: String::new(),
        }
    }

    fn walk(
        &self,
        dir: &Path,
        prefix: &str,
        include_hidden: bool,
        needle: &str,
        found: &mut Vec<FileMatch>,
    ) {
        if found.len() >= MAX_MATCHES.saturating_mul(8) {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "." || name == ".." {
                continue;
            }
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let hidden =
                name.starts_with('.') || prefix.split('/').any(|part| part.starts_with('.'));
            if !include_hidden && (hidden || self.is_ignored(&relative)) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if needle.is_empty() || relative_matches(&relative, needle) {
                    found.push(FileMatch {
                        relative: format!("{relative}/"),
                        directory: true,
                    });
                }
                self.walk(&entry.path(), &relative, include_hidden, needle, found);
            } else if file_type.is_file()
                && (needle.is_empty() || relative_matches(&relative, needle))
            {
                found.push(FileMatch {
                    relative,
                    directory: false,
                });
            }
        }
    }

    fn is_excluded(&self, relative: &str) -> bool {
        relative.split('/').any(|part| part.starts_with('.')) || self.is_ignored(relative)
    }

    fn is_ignored(&self, relative: &str) -> bool {
        let path = relative.trim_end_matches('/');
        if path.is_empty() {
            return false;
        }
        let is_dir = relative.ends_with('/') || self.root.join(path).is_dir();
        let mut ignored = false;
        let mut ancestors = Vec::new();
        let mut prefix = String::new();
        for part in path.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            ancestors.push(prefix.clone());
        }
        for rule in &self.rules {
            for (index, ancestor) in ancestors.iter().enumerate() {
                let directory = index + 1 < ancestors.len() || is_dir;
                match rule.matched(&self.root, ancestor, directory) {
                    Some(true) => ignored = true,
                    Some(false) => ignored = false,
                    None => {}
                }
            }
        }
        ignored
    }
}

impl IgnoreRule {
    /// `Some(true)` ignores, `Some(false)` re-includes, `None` does not apply.
    fn matched(&self, workspace: &Path, relative: &str, is_dir: bool) -> Option<bool> {
        let root = self.matcher.path();
        let rooted = if root.as_os_str().is_empty() {
            PathBuf::from(relative)
        } else {
            match Path::new(relative).strip_prefix(root) {
                Ok(rest) => rest.to_path_buf(),
                Err(_) => return None,
            }
        };
        let candidate = workspace.join(root).join(rooted);
        match self.matcher.matched(&candidate, is_dir) {
            ignore::Match::Ignore(_) => Some(true),
            ignore::Match::Whitelist(_) => Some(false),
            ignore::Match::None => None,
        }
    }
}

pub fn prompt_blocks(text: &str, attachments: &[PreparedAttachment]) -> Result<Vec<Value>, String> {
    let mut blocks = Vec::new();
    if !text.trim().is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    for attachment in attachments {
        if attachment.status != AttachStatus::Ready {
            return Err(format!(
                "{}: {}",
                attachment.mention,
                if attachment.detail.is_empty() {
                    attachment.status.label().to_string()
                } else {
                    attachment.detail.clone()
                }
            ));
        }
        let Some(body) = &attachment.text else {
            return Err(format!(
                "{}: binary files are not sent as text",
                attachment.mention
            ));
        };
        let uri = format!("file://{}", attachment.mention.trim_start_matches('@'));
        blocks.push(json!({
            "type": "resource_link",
            "name": attachment.mention,
            "uri": uri,
        }));
        blocks.push(json!({
            "type": "text",
            "text": format!(
                "\nAttached file {}:\n```\n{body}\n```\n",
                attachment.mention
            ),
        }));
    }
    if blocks.is_empty() {
        return Err("empty prompt".into());
    }
    Ok(blocks)
}

fn failure_attachment(mention: &str, status: AttachStatus, detail: &str) -> PreparedAttachment {
    let mention = if mention.starts_with('@') {
        mention.to_string()
    } else if mention.is_empty() {
        "@".into()
    } else {
        format!("@{mention}")
    };
    PreparedAttachment {
        mention,
        status,
        bytes: None,
        text: None,
        size: 0,
        modified: None,
        preview: String::new(),
        detail: detail.to_string(),
    }
}

fn split_hidden_query(query: &str) -> (bool, String) {
    let query = query.trim().trim_matches('"');
    if let Some(rest) = query.strip_prefix('!') {
        (true, rest.trim_start_matches('/').to_string())
    } else {
        (false, query.trim_start_matches('/').to_string())
    }
}

fn split_range(body: &str) -> (String, Option<LineRange>) {
    let (path, suffix) = if let Some(quoted) = body.strip_prefix('"') {
        match quoted.find('"') {
            Some(end) => (quoted[..end].to_string(), &quoted[end + 1..]),
            None => (quoted.to_string(), ""),
        }
    } else {
        match body.rfind(':') {
            Some(index)
                if body[index + 1..]
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.is_ascii_digit()) =>
            {
                (body[..index].to_string(), &body[index..])
            }
            _ => (body.to_string(), ""),
        }
    };
    let range = suffix.strip_prefix(':').and_then(parse_range);
    (path, range)
}

fn parse_range(value: &str) -> Option<LineRange> {
    let value = value.trim();
    if value.is_empty() || value.contains(':') {
        return None;
    }
    let (start, end) = if let Some((start, end)) = value.split_once('-') {
        (start.trim(), end.trim())
    } else {
        (value, value)
    };
    if start.is_empty() || end.is_empty() {
        return None;
    }
    if !start.bytes().all(|byte| byte.is_ascii_digit())
        || !end.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let start: usize = start.parse().ok()?;
    let end: usize = end.parse().ok()?;
    if start == 0 || end == 0 || end < start {
        return None;
    }
    Some(LineRange { start, end })
}

fn slice_lines(body: &str, span: &LineRange) -> Result<String, String> {
    let lines: Vec<&str> = body.split_inclusive('\n').collect();
    let total = if body.is_empty() { 0 } else { lines.len() };
    if span.start > total {
        return Err(format!(
            "line {} is past the end of the file ({total} lines)",
            span.start
        ));
    }
    let end = span.end.min(total);
    Ok(lines[span.start - 1..end].concat())
}

fn normalize_relative(path: &str) -> Option<String> {
    if path.contains('\0') {
        return None;
    }
    let mut parts = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

fn needs_quotes(path: &str) -> bool {
    path.chars()
        .any(|ch| ch.is_whitespace() || matches!(ch, '"' | '\\'))
}

fn relative_matches(relative: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    let haystack = relative.trim_end_matches('/').to_ascii_lowercase();
    let needle = needle.trim_end_matches('/').to_ascii_lowercase();
    haystack.contains(&needle) || subsequence(&haystack, &needle)
}

fn match_rank(relative: &str, needle: &str, directory: bool) -> u8 {
    if needle.is_empty() {
        return if directory { 2 } else { 1 };
    }
    let haystack = relative.trim_end_matches('/').to_ascii_lowercase();
    let needle = needle.to_ascii_lowercase();
    let name = haystack.rsplit('/').next().unwrap_or(&haystack);
    if name == needle {
        0
    } else if name.starts_with(&needle) || haystack.ends_with(&needle) {
        1
    } else if haystack.contains(&needle) {
        2
    } else {
        3
    }
}

fn subsequence(haystack: &str, needle: &str) -> bool {
    let mut chars = haystack.chars();
    needle
        .chars()
        .all(|wanted| chars.any(|have| have == wanted))
}

#[cfg(test)]
fn joined_text(blocks: &[Value]) -> String {
    blocks
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect()
}

fn collect_gitignore(root: &Path, dir: &Path, rules: &mut Vec<IgnoreRule>) {
    let relative = dir
        .strip_prefix(root)
        .unwrap_or(Path::new(""))
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if let Ok(text) = fs::read_to_string(dir.join(".gitignore")) {
        rules.extend(parse_gitignore(&text, &relative));
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        collect_gitignore(root, &entry.path(), rules);
    }
}

fn parse_gitignore(text: &str, base: &str) -> Vec<IgnoreRule> {
    // `base` is the directory that owned this `.gitignore`, relative to the
    // workspace. The `ignore` crate applies the file from that directory, so
    // `**/*.log` reaches nested logs instead of a literal `**` segment.
    let root = PathBuf::from(base);
    let mut builder = ignore::gitignore::GitignoreBuilder::new(&root);
    let mut kept = false;
    for line in text.lines() {
        if builder.add_line(None, line).is_ok() {
            kept = true;
        }
    }
    if !kept {
        return Vec::new();
    }
    match builder.build() {
        Ok(matcher) => vec![IgnoreRule { matcher }],
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fixture() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static FIXTURES: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "codsh-attach-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            FIXTURES.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(path.join("src")).unwrap();
        fs::create_dir_all(path.join(".hidden")).unwrap();
        fs::create_dir_all(path.join("build")).unwrap();
        fs::write(path.join(".gitignore"), "build/\n*.log\n").unwrap();
        fs::write(path.join("src/main.rs"), "one\ntwo\nthree\nfour\n").unwrap();
        fs::write(path.join("src/my file.rs"), "spaced\n").unwrap();
        fs::write(path.join(".hidden/secret.txt"), "SECRET_BYTES\n").unwrap();
        fs::write(path.join(".env"), "TOKEN_ENV\n").unwrap();
        fs::write(path.join("build/out.txt"), "ignored\n").unwrap();
        fs::write(path.join("notes.log"), "ignored-log\n").unwrap();
        path
    }

    #[test]
    fn search_hides_ignored_and_dotfiles_until_bang() {
        let root = fixture();
        let index = WorkspaceIndex::new(&root);
        let visible = index.search("secret");
        assert!(
            visible.iter().all(|item| !item.relative.contains("secret")),
            "{visible:?}"
        );
        let hidden = index.search("!secret");
        assert!(
            hidden
                .iter()
                .any(|item| item.relative.ends_with("secret.txt")),
            "{hidden:?}"
        );
        let env = index.search("!.env");
        assert!(env.iter().any(|item| item.relative == ".env"), "{env:?}");
        let ignored = index.search("out.txt");
        assert!(ignored.is_empty(), "{ignored:?}");
        let logs = index.search("notes");
        assert!(logs.is_empty(), "{logs:?}");
        assert!(
            index.resolve_typed("@build/out.txt").is_none(),
            "a build/ rule hides files inside that directory"
        );
        assert!(index.resolve_typed("@notes.log").is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn nested_gitignore_hides_descendants_until_bang() {
        let root = fixture();
        fs::create_dir_all(root.join("src/gen")).unwrap();
        fs::write(root.join("src/.gitignore"), "secret.rs\n").unwrap();
        fs::write(root.join("src/gen/.gitignore"), "*\n").unwrap();
        fs::write(root.join("src/secret.rs"), "NESTED_SECRET\n").unwrap();
        fs::write(root.join("src/gen/out.rs"), "GENERATED\n").unwrap();
        let index = WorkspaceIndex::new(&root);
        let visible = index.search("");
        let names: Vec<_> = visible.iter().map(|item| item.relative.as_str()).collect();
        assert!(
            !names.iter().any(|name| name.contains("secret.rs")),
            "{names:?}"
        );
        assert!(
            !names.iter().any(|name| name.contains("gen/out.rs")),
            "{names:?}"
        );
        assert!(
            index.resolve_typed("@src/secret.rs").is_none(),
            "a nested ignore must not admit the file without !"
        );
        assert!(index.resolve_typed("@src/gen/out.rs").is_none());
        let forced = index.search("!secret.rs");
        assert!(
            forced.iter().any(|item| item.relative == "src/secret.rs"),
            "{forced:?}"
        );
        let admitted = index.resolve_typed("@!src/secret.rs").unwrap();
        assert_eq!(
            index.prepare(&admitted, None).text.as_deref(),
            Some("NESTED_SECRET\n")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn double_star_log_pattern_hides_nested_logs() {
        let root = fixture();
        fs::create_dir_all(root.join("src/logs")).unwrap();
        fs::write(root.join(".gitignore"), "**/*.log\n").unwrap();
        fs::write(root.join("src/logs/debug.log"), "NESTED_LOG\n").unwrap();
        fs::write(root.join("src/logs/keep.txt"), "KEEP_LOG_DIR\n").unwrap();
        let index = WorkspaceIndex::new(&root);
        let packed = index.search("");
        let names: Vec<_> = packed.iter().map(|item| item.relative.as_str()).collect();
        assert!(
            !names.iter().any(|name| name.ends_with(".log")),
            "a **/*.log rule must not list nested logs: {names:?}"
        );
        assert!(
            names.iter().any(|name| *name == "src/logs/keep.txt"),
            "non-log files under the same directory stay visible: {names:?}"
        );
        assert!(index.resolve_typed("@src/logs/debug.log").is_none());
        fs::write(root.join("src/logs/.gitignore"), "!keep.log\n").unwrap();
        fs::write(root.join("src/logs/keep.log"), "REINCLUDED\n").unwrap();
        let reincluded = WorkspaceIndex::new(&root);
        let visible = reincluded.search("");
        assert!(
            visible
                .iter()
                .any(|item| item.relative == "src/logs/keep.log"),
            "a nested ! pattern re-includes that file: {visible:?}"
        );
        assert!(
            visible
                .iter()
                .all(|item| item.relative != "src/logs/debug.log"),
            "{visible:?}"
        );
        let forced = index.search("!debug.log");
        assert!(
            forced
                .iter()
                .any(|item| item.relative == "src/logs/debug.log"),
            "{forced:?}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn single_line_reference_keeps_only_that_line() {
        let root = fixture();
        fs::write(
            root.join("src/main.rs"),
            "ALPHA_LINE\nBETA_LINE\nGAMMA_LINE\n",
        )
        .unwrap();
        let index = WorkspaceIndex::new(&root);
        let line = index.resolve_typed("@src/main.rs:2").unwrap();
        assert_eq!(line.range, Some(LineRange { start: 2, end: 2 }));
        assert_eq!(line.mention(), "@src/main.rs:2");
        let prepared = index.prepare(&line, None);
        assert_eq!(prepared.text.as_deref(), Some("BETA_LINE\n"));
        assert!(!prepared.text.as_deref().unwrap().contains("ALPHA_LINE"));
        assert!(!prepared.text.as_deref().unwrap().contains("GAMMA_LINE"));
        let ranged = index.resolve_typed("@src/main.rs:2-3").unwrap();
        assert_eq!(
            index.prepare(&ranged, None).text.as_deref(),
            Some("BETA_LINE\nGAMMA_LINE\n")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn line_range_spaces_and_missing_file_are_explicit() {
        let root = fixture();
        let index = WorkspaceIndex::new(&root);
        let ranged = index.resolve_typed("@src/main.rs:2-3").unwrap();
        let prepared = index.prepare(&ranged, None);
        assert_eq!(prepared.status, AttachStatus::Ready);
        assert_eq!(prepared.text.as_deref(), Some("two\nthree\n"));
        let spaced = index.resolve_typed("@\"src/my file.rs\"").unwrap();
        assert_eq!(spaced.mention(), "@\"src/my file.rs\"");
        assert_eq!(
            index.prepare(&spaced, None).text.as_deref(),
            Some("spaced\n")
        );
        let missing = FileRef {
            relative: "src/missing.rs".into(),
            range: None,
            dropped: false,
        };
        let prepared = index.prepare(&missing, None);
        assert_eq!(prepared.status, AttachStatus::Missing);
        assert!(prepared.bytes.is_none());
        let blocks = prompt_blocks("look", &[prepared]);
        assert!(blocks.is_err(), "missing files must not be sent");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn removed_large_denied_and_changed_files_do_not_leak() {
        let root = fixture();
        let index = WorkspaceIndex::new(&root);
        let reference = index.resolve_typed("@src/main.rs").unwrap();
        let first = index.prepare(&reference, None);
        assert_eq!(first.status, AttachStatus::Ready);
        let kept = prompt_blocks("see", &[first.clone()]).unwrap();
        let kept_text = joined_text(&kept);
        assert!(kept_text.contains("one\ntwo\nthree\nfour\n"), "{kept_text}");
        let removed = prompt_blocks("kept", &[]).unwrap();
        let removed_text = joined_text(&removed);
        assert!(!removed_text.contains("one\n"), "{removed_text}");

        let huge = root.join("src/huge.txt");
        fs::write(&huge, vec![b'x'; (MAX_ATTACHMENT_BYTES as usize) + 8]).unwrap();
        let huge_ref = index.resolve_typed("@src/huge.txt").unwrap();
        let huge_prepared = index.prepare(&huge_ref, None);
        assert_eq!(huge_prepared.status, AttachStatus::TooLarge);
        assert!(huge_prepared.bytes.is_none());
        assert!(prompt_blocks("see", &[huge_prepared]).is_err());

        let denied = root.join("src/denied.txt");
        fs::write(&denied, "SECRET_DENIED\n").unwrap();
        let mut perms = fs::metadata(&denied).unwrap().permissions();
        perms.set_mode(0o000);
        fs::set_permissions(&denied, perms).unwrap();
        let denied_ref = FileRef {
            relative: "src/denied.txt".into(),
            range: None,
            dropped: false,
        };
        let denied_prepared = index.prepare(&denied_ref, None);
        assert_eq!(denied_prepared.status, AttachStatus::Permission);
        assert!(denied_prepared.text.is_none());
        let err = prompt_blocks("see", &[denied_prepared]).unwrap_err();
        assert!(!err.contains("SECRET_DENIED"), "{err}");
        let mut perms = fs::metadata(&denied).unwrap().permissions();
        perms.set_mode(0o644);
        fs::set_permissions(&denied, perms).unwrap();

        fs::write(root.join("src/main.rs"), "changed\n").unwrap();
        let again = index.prepare(&reference, Some(&first));
        assert_eq!(again.status, AttachStatus::Changed);
        assert!(again.bytes.is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn drop_rejects_paths_outside_the_workspace() {
        let root = fixture();
        let index = WorkspaceIndex::new(&root);
        let outside = std::env::temp_dir().join(format!("codsh-outside-{}", std::process::id()));
        fs::write(&outside, "OUTSIDE_SECRET\n").unwrap();
        let rejected = index.resolve_drop(outside.to_str().unwrap()).unwrap_err();
        assert_eq!(rejected.status, AttachStatus::Outside);
        assert!(
            !rejected.detail.contains("OUTSIDE_SECRET"),
            "{}",
            rejected.detail
        );
        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(root);
    }
}
