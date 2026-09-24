// Modified for codsh: adapted from `try_read_dropped_paths` and its quote,
// `file://`, and backslash-escape helpers in
// xai-grok-pager-render/src/prompt_images.rs. Only all-image drops are taken;
// `~/` and Windows drive/UNC anchors and the tracing target are omitted.
// Copyright 2023-2026 xAI. Apache-2.0; see ../upstream/LICENSE.

//! Image-file paths in a bracketed paste (a Finder drop or a copied file).

use std::path::{Path, PathBuf};

/// Extensions the reference treats as an image drop. bmp and tiff are
/// recognised so they get a notice instead of becoming a binary file mention.
const DROP_IMAGE_EXTENSIONS: [&str; 8] =
    ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif"];

/// Paths of a bracketed paste that is only image files, as a Finder drop or
/// a copied file pastes them. `None` leaves the paste to the text and
/// workspace-file routes. Every token must be an absolute path or a
/// `file://` URL naming an existing file with an image extension; prose or a
/// relative name is not taken. Over SSH the path names the other machine,
/// so nothing is read.
///
/// The upstream mixed image/non-image drop is not taken here: a non-image
/// path keeps the codsh workspace-file drop.
pub fn dropped_image_paths(text: &str) -> Option<Vec<PathBuf>> {
    if ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]
        .iter()
        .any(|key| std::env::var_os(key).is_some_and(|value| !value.is_empty()))
    {
        return None;
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.replace("\r\n", "\n").replace('\r', "\n");
    let mut paths = Vec::new();
    for line in normalized.split('\n') {
        for token in split_drop_line(line) {
            paths.push(dropped_image_path(token)?);
        }
    }
    (!paths.is_empty()).then_some(paths)
}

fn dropped_image_path(token: &str) -> Option<PathBuf> {
    let unquoted = strip_matching_quotes(token.trim());
    let path = if unquoted.starts_with("file://") {
        let url = url::Url::parse(unquoted).ok()?;
        if url.scheme() != "file" {
            return None;
        }
        url.to_file_path().ok()?
    } else if unquoted.starts_with('/') {
        PathBuf::from(shell_unescape(unquoted))
    } else {
        return None;
    };
    if path.as_os_str().is_empty()
        || path == Path::new("/")
        || path
            .as_os_str()
            .as_encoded_bytes()
            .iter()
            .any(|&byte| byte == 0 || byte == b'\r' || byte == b'\n')
    {
        return None;
    }
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if !DROP_IMAGE_EXTENSIONS.contains(&extension.as_str()) || !path.is_file() {
        return None;
    }
    Some(path)
}

/// One line, or its space-separated paths when every part starts like one.
/// A sentence that only contains a path stays one token and does not match.
fn split_drop_line(line: &str) -> Vec<&str> {
    let line = line.trim();
    if line.is_empty() {
        return Vec::new();
    }
    let bytes = line.as_bytes();
    let mut parts = Vec::new();
    let mut start = 0;
    for index in 0..bytes.len() {
        if bytes[index] == b' ' && line.get(index + 1..).is_some_and(starts_with_drop_anchor) {
            parts.push(&line[start..index]);
            start = index + 1;
        }
    }
    parts.push(&line[start..]);
    let parts: Vec<&str> = parts
        .into_iter()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() > 1 && parts.iter().all(|part| starts_with_drop_anchor(part)) {
        parts
    } else {
        vec![line]
    }
}

fn starts_with_drop_anchor(text: &str) -> bool {
    let unquoted = strip_matching_quotes(text);
    unquoted.starts_with('/') || unquoted.starts_with("file://")
}

fn strip_matching_quotes(text: &str) -> &str {
    let bytes = text.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        return &text[1..text.len() - 1];
    }
    text
}

/// Terminals escape spaces and parentheses in a dropped path (`\ `).
fn shell_unescape(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some(next) => result.push(next),
                None => result.push(ch),
            }
        } else {
            result.push(ch);
        }
    }
    result
}
