//! Pasted and dropped images for the isolated Rust composer.
//!
//! A clipboard image or an image file becomes an atomic `[Image #N]` chip.
//! Submit sends ACP `image` blocks only when the selected model explicitly
//! advertises image input. A text-only model keeps the original bytes in the
//! isolated attachment store and tells the model the path. Empty, corrupt,
//! oversized, cancelled, and unsupported cases stay in the composer with a
//! notice. No second vision provider is called.

use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

use crate::attachments::{AttachStatus, PreparedAttachment};

/// ACP and dsh share this raster set. Anything else is not an image chip.
pub const IMAGE_MEDIA_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/// Same ceiling the file picker uses. Larger images stay unsent.
pub const MAX_IMAGE_BYTES: u64 = 256 * 1024;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageBytes {
    pub bytes: Vec<u8>,
    pub media_type: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRefusal {
    pub status: AttachStatus,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedImage {
    pub id: u32,
    pub media_type: String,
    pub bytes: Vec<u8>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub digest: String,
    pub saved_path: Option<PathBuf>,
    pub modified: Option<SystemTime>,
}

impl PreparedImage {
    pub fn placeholder(&self) -> String {
        format!("[Image #{}]", self.id)
    }

    pub fn preview_line(&self) -> String {
        let size = match (self.width, self.height) {
            (Some(width), Some(height)) => format!("{width}x{height} "),
            _ => String::new(),
        };
        format!(
            "image #{}  {}{}  {} bytes  {}",
            self.id,
            size,
            short_type(&self.media_type),
            self.bytes.len(),
            &self.digest[..self.digest.len().min(12)]
        )
    }
}

pub fn sniff_image(bytes: &[u8]) -> Result<ImageBytes, ImageRefusal> {
    if bytes.is_empty() {
        return Err(refuse(AttachStatus::Missing, "clipboard has no image"));
    }
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(refuse(
            AttachStatus::TooLarge,
            "image is larger than 256 KiB",
        ));
    }
    let Some(media_type) = media_type_of(bytes) else {
        return Err(refuse(
            AttachStatus::NotAFile,
            "clipboard is not a png, jpeg, webp, or gif image",
        ));
    };
    let (width, height) = dimensions(bytes, media_type);
    Ok(ImageBytes {
        bytes: bytes.to_vec(),
        media_type: media_type.to_string(),
        width,
        height,
    })
}

/// Read one image from the platform clipboard.
///
/// `GROK_CLIPBOARD_NO_NATIVE_READ` disables the macOS pasteboard read. Any
/// presence, including `0`, is the kill switch. `CODSH_CLIPBOARD_IMAGE`
/// supplies bytes for a controlled session and is not a second vision route.
/// An empty clipboard is a refusal, not a silent drop.
pub fn read_clipboard_image() -> Result<ImageBytes, ImageRefusal> {
    if let Some(fixture) = std::env::var_os("CODSH_CLIPBOARD_IMAGE") {
        let path = PathBuf::from(fixture);
        if path.as_os_str().is_empty() {
            return Err(refuse(AttachStatus::Missing, "clipboard has no image"));
        }
        return read_image_file(&path).map_err(|error| {
            if error.status == AttachStatus::Missing {
                refuse(AttachStatus::Missing, "clipboard has no image")
            } else {
                error
            }
        });
    }
    if std::env::var_os("GROK_CLIPBOARD_NO_NATIVE_READ").is_some() && cfg!(target_os = "macos") {
        return Err(refuse(
            AttachStatus::Permission,
            "native clipboard image read is disabled; set CODSH_CLIPBOARD_IMAGE to a png, jpeg, webp, or gif",
        ));
    }
    match std::env::consts::OS {
        "macos" => read_macos_clipboard(),
        "linux" => read_linux_clipboard(),
        "windows" => Err(refuse(
            AttachStatus::Permission,
            "Windows image paste uses Alt+V through the platform clipboard and is not verified on this host",
        )),
        other => Err(refuse(
            AttachStatus::Permission,
            &format!("image clipboard is not available on {other}"),
        )),
    }
}

fn read_macos_clipboard() -> Result<ImageBytes, ImageRefusal> {
    let dir = std::env::temp_dir().join(format!("codsh-clip-{}", std::process::id()));
    fs::create_dir_all(&dir)
        .map_err(|error| refuse(AttachStatus::Permission, &error.to_string()))?;
    let file = dir.join("clipboard.png");
    let script = format!(
        "set png_data to (the clipboard as «class PNGf»)\nset fp to open for access POSIX file \"{}\" with write permission\nwrite png_data to fp\nclose access fp\n",
        file.display()
    );
    let ran = Command::new("osascript").arg("-e").arg(script).output();
    let result = match ran {
        Ok(output) if output.status.success() => read_image_file(&file),
        Ok(_) | Err(_) => Err(refuse(AttachStatus::Missing, "clipboard has no image")),
    };
    let _ = fs::remove_dir_all(dir);
    result
}

fn read_linux_clipboard() -> Result<ImageBytes, ImageRefusal> {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return read_wayland_clipboard();
    }
    let types = Command::new("xclip")
        .args(["-selection", "clipboard", "-t", "TARGETS", "-o"])
        .output();
    let Ok(types) = types else {
        return Err(refuse(
            AttachStatus::Permission,
            "clipboard image helper is unavailable (xclip)",
        ));
    };
    let listed = String::from_utf8_lossy(&types.stdout);
    let Some(media) = IMAGE_MEDIA_TYPES
        .iter()
        .find(|media| listed.contains(*media))
    else {
        return Err(refuse(AttachStatus::Missing, "clipboard has no image"));
    };
    let bytes = Command::new("xclip")
        .args(["-selection", "clipboard", "-t", media, "-o"])
        .output()
        .map_err(|_| {
            refuse(
                AttachStatus::Permission,
                "clipboard image helper is unavailable (xclip)",
            )
        })?;
    if !bytes.status.success() || bytes.stdout.is_empty() {
        return Err(refuse(AttachStatus::Missing, "clipboard has no image"));
    }
    sniff_image(&bytes.stdout)
}

fn read_wayland_clipboard() -> Result<ImageBytes, ImageRefusal> {
    let types = Command::new("wl-paste").arg("-l").output().map_err(|_| {
        refuse(
            AttachStatus::Permission,
            "clipboard image helper is unavailable (wl-paste)",
        )
    })?;
    let listed = String::from_utf8_lossy(&types.stdout);
    let Some(media) = IMAGE_MEDIA_TYPES
        .iter()
        .find(|media| listed.contains(*media))
    else {
        return Err(refuse(AttachStatus::Missing, "clipboard has no image"));
    };
    let bytes = Command::new("wl-paste")
        .args(["-t", media])
        .output()
        .map_err(|_| {
            refuse(
                AttachStatus::Permission,
                "clipboard image helper is unavailable (wl-paste)",
            )
        })?;
    if !bytes.status.success() || bytes.stdout.is_empty() {
        return Err(refuse(AttachStatus::Missing, "clipboard has no image"));
    }
    sniff_image(&bytes.stdout)
}

pub fn read_image_file(path: &Path) -> Result<ImageBytes, ImageRefusal> {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(refuse(AttachStatus::Missing, "image file not found"));
        }
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            return Err(refuse(
                AttachStatus::Permission,
                "image file is not readable",
            ));
        }
        Err(error) => return Err(refuse(AttachStatus::Permission, &error.to_string())),
    };
    if !meta.is_file() {
        return Err(refuse(AttachStatus::NotAFile, "not a regular image file"));
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(refuse(
            AttachStatus::TooLarge,
            "image is larger than 256 KiB",
        ));
    }
    let mut file = fs::File::open(path).map_err(|error| {
        refuse(
            if error.kind() == io::ErrorKind::PermissionDenied {
                AttachStatus::Permission
            } else {
                AttachStatus::Missing
            },
            &error.to_string(),
        )
    })?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| refuse(AttachStatus::Permission, &error.to_string()))?;
    sniff_image(&bytes)
}

/// Decode a base64 image supplied by a test or a clipboard helper.
pub fn decode_image_payload(encoded: &str) -> Result<ImageBytes, ImageRefusal> {
    let trimmed = encoded.trim();
    if trimmed.is_empty() {
        return Err(refuse(AttachStatus::Missing, "clipboard has no image"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(trimmed)
        .map_err(|_| refuse(AttachStatus::NotAFile, "image payload is not valid base64"))?;
    sniff_image(&bytes)
}

pub fn content_digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub fn prepare_image(id: u32, image: ImageBytes) -> PreparedImage {
    let digest = content_digest(&image.bytes);
    PreparedImage {
        id,
        media_type: image.media_type,
        bytes: image.bytes,
        width: image.width,
        height: image.height,
        digest,
        saved_path: None,
        modified: Some(SystemTime::now()),
    }
}

/// Re-sniff bytes and require the stored digest, type, and size to match.
/// A missing or stale digest is a refusal, not a send of the stored bytes.
/// A stored width or height that disagrees with the header is the same refusal.
pub fn revalidate_image(image: &PreparedImage) -> Result<PreparedImage, ImageRefusal> {
    if image.digest.is_empty() {
        return Err(refuse(AttachStatus::Changed, "image digest is missing"));
    }
    let sniffed = sniff_image(&image.bytes)?;
    let again = prepare_image(image.id, sniffed);
    if again.digest != image.digest {
        return Err(refuse(
            AttachStatus::Changed,
            "image digest does not match its bytes",
        ));
    }
    if again.media_type != image.media_type {
        return Err(refuse(
            AttachStatus::Changed,
            "image type does not match its bytes",
        ));
    }
    if image.width != again.width || image.height != again.height {
        return Err(refuse(
            AttachStatus::Changed,
            "image size does not match its bytes",
        ));
    }
    if image.bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(refuse(
            AttachStatus::TooLarge,
            "image is larger than 256 KiB",
        ));
    }
    let mut verified = again;
    verified.saved_path.clone_from(&image.saved_path);
    verified.modified = image.modified;
    Ok(verified)
}

/// Keep the original bytes under the isolated dsh home. The path is what a
/// text-only model is told about; the bytes are not sent on that route.
pub fn save_original(store: &Path, image: &PreparedImage) -> io::Result<PathBuf> {
    let dir = store.join("attachments").join("pasted");
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!(
        "{}.{}",
        image.digest,
        extension_for(&image.media_type)
    ));
    fs::write(&path, &image.bytes)?;
    Ok(path)
}

pub fn image_still_matches(image: &PreparedImage) -> Result<PreparedImage, ImageRefusal> {
    let verified = revalidate_image(image)?;
    let Some(path) = &image.saved_path else {
        return Ok(verified);
    };
    let current = read_image_file(path).map_err(|error| {
        if error.status == AttachStatus::NotAFile {
            refuse(AttachStatus::Changed, "saved image no longer decodes")
        } else {
            error
        }
    })?;
    let again = prepare_image(image.id, current);
    if again.digest != verified.digest {
        return Err(refuse(AttachStatus::Changed, "image changed since preview"));
    }
    Ok(verified)
}

/// `true` only when the catalog explicitly lists `image`. Missing and
/// text-only catalogs are not vision routes.
pub fn model_accepts_images(input_modalities: Option<&[String]>) -> bool {
    input_modalities.is_some_and(|items| items.iter().any(|item| item == "image"))
}

/// File attachments stay resource links. Images replace that path so a png is
/// not described as a binary file that was never sent. Each image is
/// revalidated before a block is built.
pub fn prompt_blocks_with_images(
    text: &str,
    attachments: &[PreparedAttachment],
    images: &[PreparedImage],
    accepts_images: bool,
) -> Result<Vec<Value>, String> {
    let mut blocks = crate::attachments::prompt_blocks(text, attachments).or_else(|error| {
        if attachments.is_empty() && error == "empty prompt" && !images.is_empty() {
            Ok(Vec::new())
        } else {
            Err(error)
        }
    })?;
    if blocks.is_empty() && text.trim().is_empty() && images.is_empty() {
        return Err("empty prompt".into());
    }
    for image in images {
        let verified = image_still_matches(image).map_err(|error| {
            format!(
                "{}: {}",
                image.placeholder(),
                if error.detail.is_empty() {
                    error.status.label().to_string()
                } else {
                    error.detail
                }
            )
        })?;
        if accepts_images {
            let data = base64::engine::general_purpose::STANDARD.encode(&verified.bytes);
            blocks.push(json!({
                "type": "image",
                "data": data,
                "mimeType": verified.media_type,
                "uri": format!("codsh-image://{}", verified.digest),
            }));
        } else {
            let path = verified
                .saved_path
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| format!("unsaved:{}", verified.digest));
            let size = match (verified.width, verified.height) {
                (Some(width), Some(height)) => format!(" dimensions=\"{width}x{height}\""),
                _ => String::new(),
            };
            blocks.push(json!({
                "type": "text",
                "text": format!(
                    "\n<pasted-image id=\"{}\" media=\"{}\"{size} path=\"{path}\">\n</pasted-image>\n",
                    verified.id, verified.media_type
                ),
            }));
        }
    }
    if blocks.is_empty() {
        return Err("empty prompt".into());
    }
    Ok(blocks)
}

fn refuse(status: AttachStatus, detail: &str) -> ImageRefusal {
    ImageRefusal {
        status,
        detail: detail.to_string(),
    }
}

fn short_type(media_type: &str) -> &str {
    media_type.rsplit('/').next().unwrap_or(media_type)
}

fn extension_for(media_type: &str) -> &'static str {
    match media_type {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    }
}

fn media_type_of(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8 && bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if bytes.len() >= 3 && bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.len() >= 6 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

fn dimensions(bytes: &[u8], media_type: &str) -> (Option<u32>, Option<u32>) {
    match media_type {
        "image/png" => png_size(bytes),
        "image/gif" => gif_size(bytes),
        "image/jpeg" => jpeg_size(bytes),
        "image/webp" => webp_size(bytes),
        _ => (None, None),
    }
}

fn nonzero(width: u32, height: u32) -> (Option<u32>, Option<u32>) {
    if width == 0 || height == 0 {
        (None, None)
    } else {
        (Some(width), Some(height))
    }
}

/// SOF0/SOF1/SOF2. Restart and other markers are skipped by their length.
fn jpeg_size(bytes: &[u8]) -> (Option<u32>, Option<u32>) {
    if bytes.len() < 4 || !bytes.starts_with(&[0xFF, 0xD8]) {
        return (None, None);
    }
    let mut offset = 2usize;
    while offset + 1 < bytes.len() {
        if bytes[offset] != 0xFF {
            break;
        }
        while offset < bytes.len() && bytes[offset] == 0xFF {
            offset += 1;
        }
        if offset >= bytes.len() {
            break;
        }
        let marker = bytes[offset];
        offset += 1;
        if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) {
            continue;
        }
        if offset + 1 >= bytes.len() {
            break;
        }
        let len = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as usize;
        if len < 2 || offset + len > bytes.len() {
            break;
        }
        if matches!(marker, 0xC0..=0xC2) && len >= 7 && offset + 6 < bytes.len() {
            let height = u16::from_be_bytes([bytes[offset + 3], bytes[offset + 4]]) as u32;
            let width = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]) as u32;
            return nonzero(width, height);
        }
        offset += len;
    }
    (None, None)
}

fn webp_size(bytes: &[u8]) -> (Option<u32>, Option<u32>) {
    if bytes.len() < 16 || !bytes.starts_with(b"RIFF") || &bytes[8..12] != b"WEBP" {
        return (None, None);
    }
    let mut offset = 12usize;
    while offset + 8 <= bytes.len() {
        let tag = &bytes[offset..offset + 4];
        let size =
            u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap_or([0; 4])) as usize;
        let body = offset + 8;
        if body > bytes.len() {
            break;
        }
        let end = body.saturating_add(size).min(bytes.len());
        match tag {
            b"VP8X" if end >= body + 10 => {
                let width =
                    1 + u32::from_le_bytes([bytes[body + 4], bytes[body + 5], bytes[body + 6], 0]);
                let height =
                    1 + u32::from_le_bytes([bytes[body + 7], bytes[body + 8], bytes[body + 9], 0]);
                return nonzero(width, height);
            }
            b"VP8 "
                if end >= body + 10 && bytes.get(body..body + 3) == Some(&[0x9D, 0x01, 0x2A]) =>
            {
                let width = u16::from_le_bytes([bytes[body + 6], bytes[body + 7]]) as u32 & 0x3FFF;
                let height = u16::from_le_bytes([bytes[body + 8], bytes[body + 9]]) as u32 & 0x3FFF;
                return nonzero(width, height);
            }
            b"VP8L" if end >= body + 5 && bytes.get(body) == Some(&0x2F) => {
                let b0 = bytes[body + 1];
                let b1 = bytes[body + 2];
                let b2 = bytes[body + 3];
                let b3 = bytes[body + 4];
                let width = 1 + ((((b1 & 0x3F) as u32) << 8) | b0 as u32);
                let height = 1
                    + ((((b3 & 0x0F) as u32) << 10)
                        | ((b2 as u32) << 2)
                        | ((b1 as u32 & 0xC0) >> 6));
                return nonzero(width, height);
            }
            _ => {}
        }
        let padded = size + (size & 1);
        offset = body.saturating_add(padded);
    }
    (None, None)
}

fn png_size(bytes: &[u8]) -> (Option<u32>, Option<u32>) {
    if bytes.len() < 24 || &bytes[12..16] != b"IHDR" {
        return (None, None);
    }
    let Ok(width_bytes) = bytes[16..20].try_into() else {
        return (None, None);
    };
    let Ok(height_bytes) = bytes[20..24].try_into() else {
        return (None, None);
    };
    let width = u32::from_be_bytes(width_bytes);
    let height = u32::from_be_bytes(height_bytes);
    if width == 0 || height == 0 {
        return (None, None);
    }
    (Some(width), Some(height))
}

fn gif_size(bytes: &[u8]) -> (Option<u32>, Option<u32>) {
    if bytes.len() < 10 {
        return (None, None);
    }
    let Ok(width_bytes) = bytes[6..8].try_into() else {
        return (None, None);
    };
    let Ok(height_bytes) = bytes[8..10].try_into() else {
        return (None, None);
    };
    let width = u16::from_le_bytes(width_bytes) as u32;
    let height = u16::from_le_bytes(height_bytes) as u32;
    if width == 0 || height == 0 {
        return (None, None);
    }
    (Some(width), Some(height))
}

/// 1×1 PNG used by tests. The bytes are a real image, not a label.
#[cfg(test)]
pub fn tiny_png() -> Vec<u8> {
    const PNG: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2,
        0, 0, 0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 0, 0,
        3, 1, 1, 0, 201, 254, 146, 239, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];
    PNG.to_vec()
}

/// A 2×1 PNG. Order checks need a different size from [`tiny_png`].
#[cfg(test)]
pub fn tiny_png_green() -> Vec<u8> {
    const PNG: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 1, 8, 2,
        0, 0, 0, 123, 64, 232, 221, 0, 0, 0, 13, 73, 68, 65, 84, 120, 218, 99, 96, 248, 207, 0, 68,
        0, 7, 0, 1, 255, 191, 245, 82, 193, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];
    PNG.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capable_model_gets_the_image_bytes_and_text_only_gets_the_saved_path() {
        let image = prepare_image(1, sniff_image(&tiny_png()).unwrap());
        let home = std::env::temp_dir().join(format!("codsh-image-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        let mut stored = image.clone();
        stored.saved_path = Some(save_original(&home, &stored).unwrap());
        let sent = prompt_blocks_with_images("look", &[], &[stored.clone()], true).unwrap();
        let image_block = sent.iter().find(|block| block["type"] == "image").unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(image_block["data"].as_str().unwrap())
            .unwrap();
        assert_eq!(decoded, tiny_png());
        assert_eq!(image_block["mimeType"], "image/png");
        assert!(sent.iter().any(|block| block["text"] == "look"));
        let text_only = prompt_blocks_with_images("look", &[], &[stored], false).unwrap();
        let joined = text_only
            .iter()
            .filter_map(|block| block["text"].as_str())
            .collect::<String>();
        assert!(joined.contains("<pasted-image "), "{joined}");
        assert!(joined.contains("image/png"), "{joined}");
        assert!(!joined.contains("iVBORw0KGgo"), "{joined}");
        assert!(!model_accepts_images(None));
        assert!(!model_accepts_images(Some(&[String::from("text")])));
        assert!(model_accepts_images(Some(&[
            String::from("text"),
            String::from("image")
        ])));
        let empty = sniff_image(&[]);
        assert_eq!(empty.unwrap_err().detail, "clipboard has no image");
        let garbage = sniff_image(b"not an image");
        assert!(garbage.unwrap_err().detail.contains("not a png"));
        let mut tampered = prepare_image(1, sniff_image(&tiny_png()).unwrap());
        tampered.bytes = tiny_png_green();
        let refused = prompt_blocks_with_images("look", &[], &[tampered], true);
        let message = refused.expect_err("tampered digest must not send");
        assert!(message.contains("digest does not match"), "{message}");
        assert!(!message.contains("iVBORw0KGgo"), "{message}");
        let mut resized = prepare_image(1, sniff_image(&tiny_png()).unwrap());
        resized.width = Some(9);
        let sized = prompt_blocks_with_images("look", &[], &[resized], true);
        let sized_message = sized.expect_err("a stored size that disagrees must not send");
        assert!(
            sized_message.contains("size does not match"),
            "{sized_message}"
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn jpeg_and_webp_headers_report_pixel_size() {
        // APP0 length is 16 and covers through the last 0x00 before SOF0.
        let jpeg = [
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00, 0x01, 0x01, 0x00,
            0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x02, 0x00,
            0x03, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xD9, 0x00, 0x00, 0x00, 0x00,
        ];
        let sniffed = sniff_image(&jpeg).expect("jpeg");
        assert_eq!(sniffed.media_type, "image/jpeg");
        assert_eq!((sniffed.width, sniffed.height), (Some(3), Some(2)));

        let mut vp8x = vec![0u8; 30];
        vp8x[0..4].copy_from_slice(b"RIFF");
        vp8x[8..12].copy_from_slice(b"WEBP");
        vp8x[12..16].copy_from_slice(b"VP8X");
        vp8x[16..20].copy_from_slice(&10u32.to_le_bytes());
        vp8x[24] = 1;
        vp8x[27] = 2;
        let webp = sniff_image(&vp8x).expect("webp");
        assert_eq!(webp.media_type, "image/webp");
        assert_eq!((webp.width, webp.height), (Some(2), Some(3)));
    }
}
