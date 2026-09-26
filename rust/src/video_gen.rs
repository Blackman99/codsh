//! Video generation through an explicitly configured substitute, with a
//! local record of every remote job (ticket 56 / #188).
//!
//! The reference `image_to_video` / `reference_to_video` tools (grok-build
//! a28ee2b, `implementations/grok_build/video_gen/mod.rs`) start an async job
//! on the official Imagine API, poll it, download the mp4, and save it as
//! `<session folder>/videos/<n>.mp4`. codsh keeps their model-facing contract
//! (arguments, limits, defaults, `[Image #N]` references, the short saved
//! path, `/imagine-video`) and talks only to the service named by
//! `[models] video_gen`. An official base URL is a config error; with no
//! service neither tool exists.
//!
//! Two job protocols are spoken:
//! * `xai`: the reference contract. `POST {base}/videos/generations` answers
//!   `{request_id}`; `GET {base}/videos/{id}` answers `{status, video.url}`
//!   (202 or a pending status while it runs). The finished file is fetched
//!   only from the configured host or a `video_download_hosts` entry.
//! * `sdcpp`: stable-diffusion.cpp `sd-server`'s native async job API
//!   (`/sdcpp/v1/capabilities`, `/sdcpp/v1/vid_gen`, `/sdcpp/v1/jobs/{id}`,
//!   `/sdcpp/v1/jobs/{id}/cancel`), whose result carries the container bytes.
//!
//! Every value a tool call asks for (duration, resolution, aspect ratio, each
//! kind of input) is checked against what the configured service supports
//! before anything is sent; an unsupported value fails the call with the
//! supported list, it is never dropped. Each call writes
//! `<session folder>/video-jobs/<name>.json` before the start request and
//! updates it on every state change, so the job survives a closed terminal:
//! `/videos` tells a finished file from a job that timed out, was cancelled
//! (and whether the service confirmed it), failed, expired, or was still
//! running when codsh stopped following it, and `/videos status` asks the
//! service again after a resume. A video file is written only after the whole
//! result arrived and its bytes are a video container, atomically, never
//! replacing an existing file.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use toml::Value as TomlValue;

pub const I2V_TOOL: &str = "image_to_video";
pub const R2V_TOOL: &str = "reference_to_video";
pub const VIDEOS_DIR: &str = "videos";
pub const JOBS_DIR: &str = "video-jobs";
/// The reference `reference_to_video` aspect ratios.
pub const ASPECT_RATIOS: &[&str] = &["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
/// Reference defaults and limits.
pub const DEFAULT_DURATION: u32 = 6;
pub const DEFAULT_RESOLUTION: &str = "480p";
pub const I2V_DURATIONS: &[u32] = &[6, 10];
pub const R2V_MIN_DURATION: u32 = 1;
pub const R2V_MAX_DURATION: u32 = 15;
pub const REFERENCE_RESOLUTIONS: &[&str] = &["480p", "720p"];
pub const MAX_REFERENCE_IMAGES: usize = 14;
pub const MAX_VOICES: usize = 3;
pub const MAX_KEYFRAMES: usize = 4;
pub const DEFAULT_TIMEOUT_SECS: u64 = 300;
pub const DEFAULT_POLL_SECS: u64 = 5;
const START_TIMEOUT_SECS: u64 = 60;
const POLL_REQUEST_TIMEOUT_SECS: u64 = 30;
const DOWNLOAD_TIMEOUT_SECS: u64 = 120;
const CANCEL_TIMEOUT_SECS: u64 = 10;
/// Consecutive poll failures (network, 429, 5xx) before the outcome is unknown.
const MAX_POLL_FAILURES: u32 = 3;
/// Reference `DEFAULT_MAX_PARALLEL_VIDEO_GEN`.
pub const DEFAULT_MAX_PARALLEL: u32 = 4;
pub const MAX_PARALLEL_LIMIT: u32 = 16;
pub const MAX_REFERENCE_BYTES: usize = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES: u64 = 256 * 1024 * 1024;
const MAX_JSON_BYTES: u64 = 360 * 1024 * 1024;
const MAX_REPLY_BYTES: u64 = 4 * 1024 * 1024;
/// Storage budget for one session's `videos/` folder.
pub const VIDEOS_BUDGET_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_SDCPP_FPS: u32 = 8;
const USER_AGENT: &str = "codsh-rust-video/0.1";

pub const IMAGINE_VIDEO_USAGE: &str =
    "Usage: /imagine-video <description>\nProvide a text description to generate a video.";

/// Video workflow guidance injected by `/imagine-video`, byte for byte.
const IMAGINE_VIDEO_SKILL: &str = "\
# Imagine Video

Video starts from an image — there is no text-to-video tool. \
Default to `image_to_video`; use `reference_to_video` when the user \
explicitly asks for it, a shot genuinely needs multiple reference images, \
or the subject should speak in a specific preset voice (`voices`).

If a video tool fails with a zero-data-retention (ZDR) storage error, relay \
that error verbatim and stop the workflow — do not generate more source \
images or retry.

## Default: single clip

Unless the user asks for a long video, multiple scenes, or a multi-shot sequence, \
generate **one** video:

1. Create a source image with `image_gen` that stages the first frame \
(composition, subject, lighting).
2. Call `image_to_video` with that image and a short prompt describing the motion \
or camera move (1–2 sentences, present tense).
3. After the tool completes, mention the saved file path so the user can find it.

## Longer / multi-shot videos

When the user requests a longer video, multiple scenes, or a narrative sequence:

1. **Plan the story as shots** — break the idea into distinct shots, one beat each.
2. **Favor frequent, short shots** — prefer more 6s clips over fewer long ones; more cuts keep it dynamic.
3. **Create each shot's source image** with `image_gen` (or `image_edit` to combine references), keeping characters and settings consistent across shots.
4. **Animate each shot with `image_to_video`** — the source image becomes frame 1.
5. **Assemble with FFmpeg** using stream copy (`ffmpeg -f concat ... -c copy` — never re-encode). \
Keep every shot at the same resolution and frame rate so the concat works. \
After assembly, mention the final output path.

## Shot guidance

- **Prompt-craft:** one short, vivid moment in present tense with a clear camera movement, in 1–2 sentences.
- **Minimal but interesting:** one clear subject, one simple motion or camera move per shot. Avoid complex multi-action animation; make the shot compelling through composition, lighting, and a strong moment.
- **Complex source image?** Intricate frames (busy geometry, fine detail, heavy reflections) warp when animated. Keep the subject fixed and move only the camera (slow push-in, orbit, or parallax), or break into simpler shots. For new shots, generate a simpler, animation-friendly base image rather than animating a busy one.
- **`image_to_video` animates from frame 1** — stage the first frame with `image_gen`/`image_edit` before animating.
- **Aspect ratio:** set it on the source image (`image_gen` `aspect_ratio`); don't re-crop an existing video.
- **Duration:** 6s or 10s only (prefer 6s); round to the nearest. `reference_to_video` accepts 1–15s.
- **Speaking subjects:** to give a subject a voice, use `reference_to_video` with `voices` (up to 3 preset voice identifiers, e.g. \"ara\", \"eve\") and tag them in the prompt as `<AUDIO_0>`…; combine with reference `images` tagged `<IMAGE_0>`… for a consistent character.
- **Real people:** reference-first — drive the video from a verified reference image; never animate a named person without one.
- Don't loop the same clip unless asked.";

/// The reference `/imagine-video` injection.
pub fn imagine_video_instruction(prompt: &str) -> String {
    format!("{IMAGINE_VIDEO_SKILL}\n\nUser prompt: {prompt}")
}

/// The prompt of a message built by [`imagine_video_instruction`], or None.
pub fn imagine_video_prompt_of(text: &str) -> Option<&str> {
    let rest = text.strip_prefix(IMAGINE_VIDEO_SKILL)?;
    rest.strip_prefix("\n\nUser prompt: ")
        .map(|prompt| prompt.lines().next().unwrap_or("").trim())
}

/// The arguments of an `/imagine-video` line (empty when bare), or None.
pub fn imagine_video_args(text: &str) -> Option<&str> {
    let rest = text.trim().strip_prefix("/imagine-video")?;
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some(rest.trim())
}

// ---------------------------------------------------------------------------
// Configuration

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoProtocol {
    Xai,
    Sdcpp,
}

impl VideoProtocol {
    pub fn label(self) -> &'static str {
        match self {
            Self::Xai => "xai",
            Self::Sdcpp => "sdcpp",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "xai" | "imagine" => Some(Self::Xai),
            "sdcpp" | "sd-server" | "stable-diffusion.cpp" => Some(Self::Sdcpp),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoTool {
    ImageToVideo,
    ReferenceToVideo,
}

impl VideoTool {
    pub fn name(self) -> &'static str {
        match self {
            Self::ImageToVideo => I2V_TOOL,
            Self::ReferenceToVideo => R2V_TOOL,
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name {
            I2V_TOOL => Some(Self::ImageToVideo),
            R2V_TOOL => Some(Self::ReferenceToVideo),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct VideoService {
    pub id: String,
    /// The `model` value sent in the request body (xai).
    pub model: String,
    pub base_url: String,
    pub protocol: VideoProtocol,
    pub env_key: Option<String>,
    /// Set only from a non-empty env value or inline `api_key`. Empty = keyless.
    pub api_key: String,
    /// Longest local wait for one job, from the start request.
    pub timeout_secs: u64,
    pub poll_secs: u64,
    /// `video_durations`: explicit whole seconds. None = the reference rules
    /// (image_to_video 6 or 10, reference_to_video 1–15).
    pub durations: Option<Vec<u32>>,
    /// `video_resolutions`: names such as "480p". Default 480p and 720p.
    pub resolutions: Vec<String>,
    /// `video_tools`: which of the two tools this service runs.
    pub tools: Vec<VideoTool>,
    /// sdcpp: playback rate; frames = duration × fps.
    pub fps: u32,
    /// sdcpp: `webm`, `webp` (animated), or `avi`.
    pub output_format: String,
    /// sdcpp: optional img2vid strength.
    pub strength: Option<f64>,
    /// xai: extra hosts a finished video may be downloaded from.
    pub download_hosts: Vec<String>,
}

impl VideoService {
    pub fn host(&self) -> String {
        host_of(&self.base_url).unwrap_or_else(|| "(invalid base_url)".into())
    }

    pub fn supports(&self, tool: VideoTool) -> bool {
        self.tools.contains(&tool)
    }

    /// What an approval card and a result say about money.
    pub fn cost_note(&self) -> String {
        let credential = if self.api_key.is_empty() {
            "keyless"
        } else {
            "with the configured key"
        };
        format!(
            "one video job on {} ({credential}); codsh does not know its price, so any charge is set by that service",
            self.host()
        )
    }

    /// The durations this service accepts for one tool.
    pub fn allowed_durations(&self, tool: VideoTool) -> Vec<u32> {
        match (&self.durations, tool) {
            (Some(list), _) => list.clone(),
            (None, VideoTool::ImageToVideo) => I2V_DURATIONS.to_vec(),
            (None, VideoTool::ReferenceToVideo) => (R2V_MIN_DURATION..=R2V_MAX_DURATION).collect(),
        }
    }

    fn default_duration(&self, tool: VideoTool) -> u32 {
        let allowed = self.allowed_durations(tool);
        if allowed.contains(&DEFAULT_DURATION) {
            DEFAULT_DURATION
        } else {
            allowed.first().copied().unwrap_or(DEFAULT_DURATION)
        }
    }

    fn default_resolution(&self) -> String {
        if self.resolutions.iter().any(|r| r == DEFAULT_RESOLUTION) {
            DEFAULT_RESOLUTION.to_string()
        } else {
            self.resolutions
                .first()
                .cloned()
                .unwrap_or_else(|| DEFAULT_RESOLUTION.into())
        }
    }

    /// One line for the tool descriptions and inspect.
    pub fn capability_summary(&self) -> String {
        let mut parts = Vec::new();
        for tool in &self.tools {
            parts.push(format!(
                "{} duration {} s",
                tool.name(),
                compact_list(&self.allowed_durations(*tool))
            ));
        }
        parts.push(format!("resolution_name {}", self.resolutions.join(" or ")));
        if self.supports(VideoTool::ReferenceToVideo) {
            match self.protocol {
                VideoProtocol::Xai => parts.push(format!(
                    "reference_to_video inputs: up to {MAX_REFERENCE_IMAGES} images, first_frame, last_frame, up to {MAX_KEYFRAMES} keyframes, up to {MAX_VOICES} voices"
                )),
                VideoProtocol::Sdcpp => parts.push(
                    "reference_to_video inputs: first_frame (required) and last_frame only; no images, keyframes, or voices".into(),
                ),
            }
        }
        if self.protocol == VideoProtocol::Sdcpp {
            parts.push("image references must be files or data URLs".into());
        }
        parts.join("; ")
    }
}

fn compact_list(values: &[u32]) -> String {
    if values.len() > 3 && values.windows(2).all(|pair| pair[1] == pair[0] + 1) {
        return format!("{}–{}", values[0], values[values.len() - 1]);
    }
    values
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(" or ")
}

fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url).ok().and_then(|url| {
        url.host_str().map(|host| match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        })
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct VideoServices {
    pub service: Option<VideoService>,
    pub service_source: String,
    /// The `[models] video_gen` id as written, kept for inspect when resolving fails.
    pub service_id: Option<String>,
    pub enabled: bool,
    pub enabled_source: String,
    pub max_parallel: u32,
    pub max_parallel_source: String,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

impl VideoServices {
    pub fn disabled() -> Self {
        Self {
            service: None,
            service_source: "default".into(),
            service_id: None,
            enabled: false,
            enabled_source: "unconfigured".into(),
            max_parallel: DEFAULT_MAX_PARALLEL,
            max_parallel_source: "default".into(),
            warnings: Vec::new(),
            errors: Vec::new(),
        }
    }

    pub fn tool_enabled(&self, tool: VideoTool) -> bool {
        self.enabled && self.service.as_ref().is_some_and(|s| s.supports(tool))
    }

    /// The service and request model a tool uses, when that tool is on.
    pub fn route(&self, tool: VideoTool) -> Result<(VideoService, String), VideoError> {
        let Some(service) = self.service.as_ref().filter(|_| self.enabled) else {
            return Err(VideoError::Disabled(tool.name()));
        };
        if !service.supports(tool) {
            return Err(VideoError::Unsupported(format!(
                "{} is not offered by the configured video service {} (video_tools = [{}]).",
                tool.name(),
                service.host(),
                service
                    .tools
                    .iter()
                    .map(|t| format!("{:?}", t.name()))
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
        Ok((service.clone(), service.model.clone()))
    }

    /// The service a stored job belongs to, if it is still the configured one.
    fn service_for(&self, record: &JobRecord) -> Result<VideoService, String> {
        let service = self
            .service
            .as_ref()
            .filter(|_| self.enabled)
            .ok_or("video generation is not configured now; the job's service is not asked")?;
        if service.host() != record.host || service.protocol.label() != record.protocol {
            return Err(format!(
                "this job ran on {} ({}), but the configured video service is now {} ({}); codsh only asks the service a job was started on",
                record.host,
                record.protocol,
                service.host(),
                service.protocol.label()
            ));
        }
        Ok(service.clone())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoError {
    Disabled(&'static str),
    Invalid(String),
    Unsupported(String),
    Reference(String),
    /// The service refused the start request (non-success status or error body).
    Refused {
        status: u16,
        message: String,
    },
    Malformed(String),
    Network(String),
    Storage(String),
    /// A remote job ended without a video: failed, expired, lost, cancelled
    /// by the service, or its outcome is unknown. The text says which.
    Job(String),
    TimedOut(String),
    Cancelled(String),
}

impl VideoError {
    pub fn is_cancel(&self) -> bool {
        matches!(self, Self::Cancelled(_))
    }
}

impl std::fmt::Display for VideoError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled(tool) => write!(
                formatter,
                "{tool} is not configured or is turned off. Set [models] video_gen to a [model.<id>] video service (supports_video_generation = true); no request was made and no file was saved."
            ),
            Self::Invalid(message) | Self::Unsupported(message) | Self::Reference(message) => {
                write!(
                    formatter,
                    "{message} No request was made and no file was saved."
                )
            }
            Self::Refused { status, message } => {
                write!(
                    formatter,
                    "{message} No job was started; nothing was saved."
                )?;
                if *status == 402 {
                    write!(
                        formatter,
                        " The service asked for payment; codsh never buys credits or retries a paid call."
                    )?;
                }
                Ok(())
            }
            Self::Malformed(message)
            | Self::Network(message)
            | Self::Job(message)
            | Self::TimedOut(message)
            | Self::Cancelled(message) => write!(formatter, "{message} Nothing was saved."),
            Self::Storage(message) => write!(formatter, "{message}"),
        }
    }
}

#[cfg(test)]
fn load_services(
    table: &TomlValue,
    env: &BTreeMap<String, String>,
    requirements: Option<&TomlValue>,
) -> VideoServices {
    load_services_layered(table, table, env, requirements, None)
}

/// `[models] video_gen` names a `[model.<id>]` table that says
/// `supports_video_generation = true`. `features.video_gen` (requirements
/// pin, GROK_VIDEO_GEN) can turn it off. A configured service is the
/// explicit opt-in: with none, neither tool exists.
pub fn load_services_layered(
    table: &TomlValue,
    user: &TomlValue,
    env: &BTreeMap<String, String>,
    requirements: Option<&TomlValue>,
    managed: Option<&TomlValue>,
) -> VideoServices {
    let mut services = VideoServices::disabled();
    let (id, source) = layered_string(
        requirements,
        managed,
        user,
        None,
        &["models", "video_gen"],
        true,
    );
    let mut errors = Vec::new();
    services.service_id = id.clone();
    if let Some(id) = id {
        services.service = resolve_service(table, requirements, env, &id, &mut errors);
        services.service_source = source;
    }
    let (flag, flag_source) = layered_pin_bool(
        requirements,
        managed,
        user,
        env.get("GROK_VIDEO_GEN"),
        &["features", "video_gen"],
    );
    services.enabled = services.service.is_some() && flag != Some(false) && errors.is_empty();
    services.enabled_source = if flag == Some(false) {
        flag_source
    } else if services.enabled {
        services.service_source.clone()
    } else if !errors.is_empty() {
        "invalid".into()
    } else {
        "unconfigured".into()
    };
    if services.service.is_none() && flag == Some(true) && errors.is_empty() {
        services.warnings.push(
            "features.video_gen is on but [models] video_gen names no video service; the video tools stay off (no hidden default service)."
                .into(),
        );
    }
    let path = ["tools", "media_gen", "max_parallel_video_gen_calls"];
    let raw = if let Some(value) = walk(user, &path) {
        Some((value.clone(), "config.toml"))
    } else if let Some(value) = env
        .get("GROK_MAX_PARALLEL_VIDEO_GEN_CALLS")
        .filter(|value| !value.trim().is_empty())
    {
        Some((TomlValue::String(value.trim().to_string()), "environment"))
    } else if let Some(value) = requirements.and_then(|table| walk(table, &path)) {
        Some((value.clone(), "requirements"))
    } else {
        managed
            .and_then(|table| walk(table, &path))
            .map(|value| (value.clone(), "managed"))
    };
    if let Some((value, source)) = raw {
        let parsed = match &value {
            TomlValue::Integer(number) => u32::try_from(*number).ok(),
            TomlValue::String(text) => text.parse::<u32>().ok(),
            _ => None,
        };
        match parsed {
            Some(number) if (1..=MAX_PARALLEL_LIMIT).contains(&number) => {
                services.max_parallel = number;
                services.max_parallel_source = source.into();
            }
            _ => services.errors.push(format!(
                "tools.media_gen.max_parallel_video_gen_calls must be an integer from 1 to {MAX_PARALLEL_LIMIT} (from {source})"
            )),
        }
    }
    services.errors.extend(errors);
    services
}

fn int_setting(
    spec: &TomlValue,
    id: &str,
    key: &str,
    default: u64,
    range: std::ops::RangeInclusive<i64>,
    errors: &mut Vec<String>,
) -> Option<u64> {
    match walk(spec, &[key]) {
        None => Some(default),
        Some(TomlValue::Integer(number)) if range.contains(number) => Some(*number as u64),
        Some(_) => {
            errors.push(format!(
                "[model.{id}] {key} must be an integer from {} to {}.",
                range.start(),
                range.end()
            ));
            None
        }
    }
}

fn resolve_service(
    table: &TomlValue,
    requirements: Option<&TomlValue>,
    env: &BTreeMap<String, String>,
    id: &str,
    errors: &mut Vec<String>,
) -> Option<VideoService> {
    let spec = table
        .get("model")
        .and_then(|value| value.get(id))
        .or_else(|| {
            requirements
                .and_then(|value| value.get("model"))
                .and_then(|value| value.get(id))
        });
    let Some(spec) = spec else {
        errors.push(format!(
            "[models] video_gen = {id:?} has no [model.{id}] table; video requests stay off."
        ));
        return None;
    };
    let Some(base_url) = string_at(spec, &["base_url"]) else {
        errors.push(format!(
            "[model.{id}] has no base_url; set the video service endpoint explicitly."
        ));
        return None;
    };
    if url::Url::parse(&base_url)
        .map(|url| url.scheme() != "http" && url.scheme() != "https")
        .unwrap_or(true)
    {
        errors.push(format!(
            "[model.{id}] base_url {base_url:?} is not an http(s) URL."
        ));
        return None;
    }
    if crate::privacy::is_official_endpoint(&base_url) {
        errors.push(format!(
            "video service destination refused: [model.{id}] base_url {base_url} is an official host. Configure a substitute video service; the official Imagine account is not used."
        ));
        return None;
    }
    if !bool_at_value(spec, &["supports_video_generation"]).unwrap_or(false) {
        errors.push(format!(
            "[model.{id}] is not marked supports_video_generation = true; a chat or image model is not used as a video service."
        ));
        return None;
    }
    let protocol = match string_at(spec, &["protocol"]) {
        None => VideoProtocol::Xai,
        Some(raw) => match VideoProtocol::parse(&raw) {
            Some(protocol) => protocol,
            None => {
                errors.push(format!(
                    "[model.{id}] protocol {raw:?} is not a video protocol. Use \"xai\" or \"sdcpp\"."
                ));
                return None;
            }
        },
    };
    let env_key = string_at(spec, &["env_key"]);
    let from_env = env_key
        .as_ref()
        .and_then(|name| env.get(name))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let inline = string_at(spec, &["api_key"]);
    let api_key = from_env.or(inline).unwrap_or_default();
    if let Some(name) = env_key.as_ref()
        && api_key.is_empty()
    {
        errors.push(format!(
            "[model.{id}] names env_key {name} but it is empty; the video service is not called without it."
        ));
        return None;
    }
    let timeout_secs = int_setting(
        spec,
        id,
        "timeout_secs",
        DEFAULT_TIMEOUT_SECS,
        1..=7200,
        errors,
    )?;
    let poll_secs = int_setting(spec, id, "poll_secs", DEFAULT_POLL_SECS, 1..=60, errors)?;
    let fps = int_setting(
        spec,
        id,
        "video_fps",
        DEFAULT_SDCPP_FPS as u64,
        1..=60,
        errors,
    )? as u32;
    let durations = match walk(spec, &["video_durations"]) {
        None => None,
        Some(TomlValue::Array(items)) if !items.is_empty() => {
            let mut list = Vec::new();
            for item in items {
                match item.as_integer() {
                    Some(n) if (1..=120).contains(&n) => list.push(n as u32),
                    _ => {
                        errors.push(format!(
                            "[model.{id}] video_durations must list whole seconds from 1 to 120."
                        ));
                        return None;
                    }
                }
            }
            list.sort_unstable();
            list.dedup();
            Some(list)
        }
        Some(_) => {
            errors.push(format!(
                "[model.{id}] video_durations must be a non-empty list of whole seconds."
            ));
            return None;
        }
    };
    let resolutions = match walk(spec, &["video_resolutions"]) {
        None => REFERENCE_RESOLUTIONS
            .iter()
            .map(|r| r.to_string())
            .collect(),
        Some(TomlValue::Array(items)) if !items.is_empty() => {
            let mut list = Vec::new();
            for item in items {
                match item
                    .as_str()
                    .map(str::trim)
                    .filter(|r| resolution_height(r).is_some())
                {
                    Some(name) => list.push(name.to_string()),
                    None => {
                        errors.push(format!(
                            "[model.{id}] video_resolutions entries must look like \"480p\" (64p to 2160p)."
                        ));
                        return None;
                    }
                }
            }
            list
        }
        Some(_) => {
            errors.push(format!(
                "[model.{id}] video_resolutions must be a non-empty list such as [\"480p\"]."
            ));
            return None;
        }
    };
    let tools = match walk(spec, &["video_tools"]) {
        None => vec![VideoTool::ImageToVideo, VideoTool::ReferenceToVideo],
        Some(TomlValue::Array(items)) if !items.is_empty() => {
            let mut list = Vec::new();
            for item in items {
                match item.as_str().and_then(VideoTool::parse) {
                    Some(tool) if !list.contains(&tool) => list.push(tool),
                    Some(_) => {}
                    None => {
                        errors.push(format!(
                            "[model.{id}] video_tools entries must be \"{I2V_TOOL}\" or \"{R2V_TOOL}\"."
                        ));
                        return None;
                    }
                }
            }
            list
        }
        Some(_) => {
            errors.push(format!(
                "[model.{id}] video_tools must be a non-empty list of tool names."
            ));
            return None;
        }
    };
    let output_format = string_at(spec, &["video_output_format"])
        .unwrap_or_else(|| "webm".into())
        .to_ascii_lowercase();
    if !matches!(output_format.as_str(), "webm" | "webp" | "avi") {
        errors.push(format!(
            "[model.{id}] video_output_format must be \"webm\", \"webp\", or \"avi\"."
        ));
        return None;
    }
    let strength = match walk(spec, &["video_strength"]) {
        None => None,
        Some(TomlValue::Float(value)) if (0.0..=1.0).contains(value) => Some(*value),
        Some(_) => {
            errors.push(format!(
                "[model.{id}] video_strength must be a number from 0.0 to 1.0."
            ));
            return None;
        }
    };
    let download_hosts = match walk(spec, &["video_download_hosts"]) {
        None => Vec::new(),
        Some(TomlValue::Array(items)) => {
            let mut list = Vec::new();
            for item in items {
                let Some(host) = item
                    .as_str()
                    .map(|h| h.trim().to_ascii_lowercase())
                    .filter(|h| !h.is_empty())
                else {
                    errors.push(format!(
                        "[model.{id}] video_download_hosts must list host names."
                    ));
                    return None;
                };
                if crate::privacy::is_official_endpoint(&format!("https://{host}/")) {
                    errors.push(format!(
                        "video download host refused: [model.{id}] video_download_hosts lists {host}, an official host."
                    ));
                    return None;
                }
                list.push(host);
            }
            list
        }
        Some(_) => {
            errors.push(format!(
                "[model.{id}] video_download_hosts must be a list of host names."
            ));
            return None;
        }
    };
    Some(VideoService {
        id: id.to_string(),
        model: string_at(spec, &["model"]).unwrap_or_else(|| id.to_string()),
        base_url,
        protocol,
        env_key,
        api_key,
        timeout_secs,
        poll_secs,
        durations,
        resolutions,
        tools,
        fps,
        output_format,
        strength,
        download_hosts,
    })
}

/// "480p" → 480.
pub fn resolution_height(name: &str) -> Option<u32> {
    let digits = name.trim().strip_suffix('p')?;
    let value = digits.parse::<u32>().ok()?;
    (64..=2160).contains(&value).then_some(value)
}

pub fn inspect_rows(services: &VideoServices) -> Vec<(&'static str, String, String)> {
    let service_value = match (services.service.as_ref(), services.service_id.as_ref()) {
        (Some(service), _) => format!(
            "{} ({} {} model {})",
            service.id,
            service.protocol.label(),
            service.host(),
            service.model
        ),
        (None, Some(id)) => format!("{id} (refused; see Invalid configuration)"),
        (None, None) => "unset".into(),
    };
    let mut rows = vec![
        (
            "models.video_gen",
            service_value,
            services.service_source.clone(),
        ),
        (
            "features.video_gen",
            services.enabled.to_string(),
            services.enabled_source.clone(),
        ),
        (
            "tools.media_gen.max_parallel_video_gen_calls",
            services.max_parallel.to_string(),
            services.max_parallel_source.clone(),
        ),
    ];
    if let Some(service) = services.service.as_ref() {
        rows.push((
            "video capabilities",
            service.capability_summary(),
            format!("model.{}", service.id),
        ));
    }
    rows
}

pub fn disclosure(services: &VideoServices) -> String {
    match services.service.as_ref() {
        Some(service) if services.enabled => format!("video: {}", service.cost_note()),
        _ => "video: off; no request is made".into(),
    }
}

pub fn inspect_json(services: &VideoServices) -> Value {
    let tools: Vec<&str> = services
        .service
        .as_ref()
        .filter(|_| services.enabled)
        .map(|service| service.tools.iter().map(|tool| tool.name()).collect())
        .unwrap_or_default();
    json!({
        "videoGenEnabled": services.enabled,
        "tools": tools,
        "service": services.service.as_ref().map(|service| json!({
            "id": service.id,
            "model": service.model,
            "protocol": service.protocol.label(),
            "host": service.host(),
            "keyless": service.api_key.is_empty(),
            "capabilities": service.capability_summary(),
        })),
        "maxParallelCalls": services.max_parallel,
        "disclosure": disclosure(services),
    })
}

/// What the dsh plugin needs: which tools exist, the parallel cap, the host
/// for the approval card, and what the service accepts (for the tool
/// descriptions). Policy and credentials stay in the command.
pub fn dsh_env(services: &VideoServices) -> Vec<(String, String)> {
    let flag = |on: bool| if on { "1" } else { "0" }.to_string();
    let mut extra = vec![
        (
            "CODSH_VIDEO_I2V".into(),
            flag(services.tool_enabled(VideoTool::ImageToVideo)),
        ),
        (
            "CODSH_VIDEO_R2V".into(),
            flag(services.tool_enabled(VideoTool::ReferenceToVideo)),
        ),
        (
            "CODSH_VIDEO_MAX_PARALLEL".into(),
            services.max_parallel.to_string(),
        ),
    ];
    if services.enabled
        && let Some(service) = services.service.as_ref()
    {
        extra.push(("CODSH_VIDEO_HOST".into(), service.host()));
        extra.push(("CODSH_VIDEO_CAPS".into(), service.capability_summary()));
    }
    extra
}

// ---------------------------------------------------------------------------
// Jobs

#[derive(Debug, Clone, PartialEq)]
pub struct Keyframe {
    pub image: String,
    pub timestamp_s: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    pub tool: VideoTool,
    pub prompt: String,
    /// image_to_video's source image.
    pub image: Option<String>,
    pub images: Vec<String>,
    pub first_frame: Option<String>,
    pub last_frame: Option<String>,
    pub keyframes: Vec<Keyframe>,
    pub voices: Vec<String>,
    pub aspect_ratio: Option<String>,
    pub duration: Option<u32>,
    pub resolution: Option<String>,
    pub session_dir: PathBuf,
    /// The dsh tool call id; names the job record so the UI can find it.
    pub call_id: Option<String>,
}

impl Job {
    pub fn new(tool: VideoTool, session_dir: PathBuf) -> Self {
        Self {
            tool,
            prompt: String::new(),
            image: None,
            images: Vec::new(),
            first_frame: None,
            last_frame: None,
            keyframes: Vec::new(),
            voices: Vec::new(),
            aspect_ratio: None,
            duration: None,
            resolution: None,
            session_dir,
            call_id: None,
        }
    }
}

/// An image input after resolution: bytes (sent as a data URL) or an https
/// URL the xai service fetches itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageInput {
    Bytes {
        bytes: Vec<u8>,
        media_type: &'static str,
        width: Option<u32>,
        height: Option<u32>,
    },
    Url(String),
}

impl ImageInput {
    fn data_url(&self) -> String {
        match self {
            Self::Bytes {
                bytes, media_type, ..
            } => format!(
                "data:{media_type};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
            Self::Url(url) => url.clone(),
        }
    }
}

/// A validated job: every value is one the service accepts.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub tool: VideoTool,
    pub prompt: String,
    pub duration: u32,
    pub resolution: String,
    pub aspect_ratio: Option<String>,
    /// image_to_video's image, or reference_to_video's first_frame.
    pub first: Option<ImageInput>,
    pub images: Vec<ImageInput>,
    pub last: Option<ImageInput>,
    pub keyframes: Vec<(ImageInput, f64)>,
    pub voices: Vec<String>,
    /// Notes about defaults chosen for omitted values.
    pub defaults: Vec<String>,
}

impl Plan {
    fn input_count(&self) -> usize {
        usize::from(self.first.is_some())
            + self.images.len()
            + usize::from(self.last.is_some())
            + self.keyframes.len()
            + self.voices.len()
    }
}

/// Checks that need no files: argument shapes and the service's limits.
/// Returns the duration, resolution, and notes on defaults used.
pub fn validate_job(
    service: &VideoService,
    job: &Job,
) -> Result<(u32, String, Vec<String>), VideoError> {
    let host = service.host();
    let tool = job.tool;
    match tool {
        VideoTool::ImageToVideo => {
            if job.image.as_deref().map(str::trim).unwrap_or("").is_empty() {
                return Err(VideoError::Invalid(
                    "image_to_video requires `image`: the source image to animate.".into(),
                ));
            }
        }
        VideoTool::ReferenceToVideo => {
            if job.prompt.trim().is_empty() {
                return Err(VideoError::Invalid("`prompt` must not be empty.".into()));
            }
            if job.images.is_empty()
                && job.voices.is_empty()
                && job.first_frame.is_none()
                && job.last_frame.is_none()
                && job.keyframes.is_empty()
            {
                return Err(VideoError::Invalid(format!(
                    "Provide at least one input: `images` (up to {MAX_REFERENCE_IMAGES}), `voices` (up to {MAX_VOICES}), `first_frame`, `last_frame`, and/or `keyframes` (up to {MAX_KEYFRAMES})."
                )));
            }
            if job.images.len() > MAX_REFERENCE_IMAGES {
                return Err(VideoError::Invalid(format!(
                    "`images` must contain at most {MAX_REFERENCE_IMAGES} image references."
                )));
            }
            if job.voices.len() > MAX_VOICES {
                return Err(VideoError::Invalid(format!(
                    "`voices` must contain at most {MAX_VOICES} preset voices."
                )));
            }
            if job.voices.iter().any(|voice| voice.trim().is_empty()) {
                return Err(VideoError::Invalid(
                    "`voices` entries must be non-empty voice identifiers (e.g. \"ara\").".into(),
                ));
            }
            if job.keyframes.len() > MAX_KEYFRAMES {
                return Err(VideoError::Invalid(format!(
                    "`keyframes` must contain at most {MAX_KEYFRAMES} anchors. Got {}.",
                    job.keyframes.len()
                )));
            }
            match job.aspect_ratio.as_deref() {
                None => {
                    return Err(VideoError::Invalid(format!(
                        "reference_to_video requires `aspect_ratio`, one of: {}.",
                        ASPECT_RATIOS.join(", ")
                    )));
                }
                Some(ratio) if !ASPECT_RATIOS.contains(&ratio) => {
                    return Err(VideoError::Invalid(format!(
                        "`aspect_ratio` {ratio:?} is not supported. Use one of: {}.",
                        ASPECT_RATIOS.join(", ")
                    )));
                }
                Some(_) => {}
            }
        }
    }
    let mut defaults = Vec::new();
    let allowed = service.allowed_durations(tool);
    let duration = match job.duration {
        Some(value) if allowed.contains(&value) => value,
        Some(value) => {
            return Err(VideoError::Unsupported(format!(
                "`duration` {value}s is not supported by the video service {host} for {}; supported: {} s.",
                tool.name(),
                compact_list(&allowed)
            )));
        }
        None => {
            let value = service.default_duration(tool);
            defaults.push(format!("duration {value}s (default)"));
            value
        }
    };
    let resolution = match job.resolution.as_deref().map(str::trim) {
        Some(value) if service.resolutions.iter().any(|r| r == value) => value.to_string(),
        Some(value) => {
            return Err(VideoError::Unsupported(format!(
                "`resolution_name` {value:?} is not supported by the video service {host}; supported: {}.",
                service.resolutions.join(", ")
            )));
        }
        None => {
            let value = service.default_resolution();
            defaults.push(format!("resolution {value} (default)"));
            value
        }
    };
    for keyframe in &job.keyframes {
        let t = keyframe.timestamp_s;
        if !(t > 0.0 && t < duration as f64) {
            return Err(VideoError::Invalid(format!(
                "`keyframes` timestamp {t}s must be strictly inside the clip (0 < t < {duration}s). Pin the endpoints with `first_frame` / `last_frame` instead."
            )));
        }
    }
    if service.protocol == VideoProtocol::Sdcpp {
        let unsupported = |what: &str| {
            VideoError::Unsupported(format!(
                "{what} is not supported by the video service {host} (sdcpp protocol: it takes a first frame and an optional last frame only)."
            ))
        };
        if !job.images.is_empty() {
            return Err(unsupported("`images` (style/content references)"));
        }
        if !job.voices.is_empty() {
            return Err(unsupported("`voices`"));
        }
        if !job.keyframes.is_empty() {
            return Err(unsupported("`keyframes`"));
        }
        if tool == VideoTool::ReferenceToVideo && job.first_frame.is_none() {
            return Err(unsupported("a clip without `first_frame`"));
        }
    }
    Ok((duration, resolution, defaults))
}

/// A data URL, https URL (xai only), `file://` path, or filesystem path
/// (relative to `cwd`) to an image input. `[Image #N]` is resolved by the dsh
/// plugin from the current message; one that reaches here matched nothing.
pub fn resolve_image(
    raw: &str,
    cwd: &Path,
    protocol: VideoProtocol,
) -> Result<ImageInput, VideoError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(VideoError::Reference(
            "image reference must not be empty.".into(),
        ));
    }
    if crate::image_gen::parse_attachment_token(value).is_some() {
        return Err(VideoError::Reference(format!(
            "image reference {value:?} matches no image attached to this message. If it was attached earlier, ask the user to re-attach it here; otherwise pass an absolute filesystem path or a data: URL."
        )));
    }
    if value.starts_with("https://") || value.starts_with("http://") {
        if protocol == VideoProtocol::Xai && value.starts_with("https://") {
            return Ok(ImageInput::Url(value.to_string()));
        }
        return Err(VideoError::Unsupported(format!(
            "image reference {value} is a URL; this video service needs the image bytes and codsh does not fetch URLs for it. Pass a local path or a data: URL."
        )));
    }
    let (bytes, label) = if let Some(rest) = value.strip_prefix("data:") {
        let Some((header, payload)) = rest.split_once(',') else {
            return Err(VideoError::Reference(
                "malformed data URL in image reference.".into(),
            ));
        };
        if !header.starts_with("image/") || !header.contains(";base64") {
            return Err(VideoError::Reference(
                "image references only accept base64 data:image/... URLs.".into(),
            ));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .map_err(|error| {
                VideoError::Reference(format!("invalid base64 in image reference: {error}."))
            })?;
        (bytes, "data URL".to_string())
    } else {
        let path_text = value.strip_prefix("file://").unwrap_or(value);
        let path = if Path::new(path_text).is_absolute() {
            PathBuf::from(path_text)
        } else {
            cwd.join(path_text)
        };
        let metadata = std::fs::metadata(&path).map_err(|error| {
            VideoError::Reference(format!(
                "image reference not readable: {} ({error}).",
                path.display()
            ))
        })?;
        if !metadata.is_file() {
            return Err(VideoError::Reference(format!(
                "image reference {} is not a file.",
                path.display()
            )));
        }
        if metadata.len() > MAX_REFERENCE_BYTES as u64 {
            return Err(VideoError::Reference(format!(
                "image reference {} is larger than {} MiB.",
                path.display(),
                MAX_REFERENCE_BYTES / (1024 * 1024)
            )));
        }
        let bytes = std::fs::read(&path).map_err(|error| {
            VideoError::Reference(format!(
                "image reference not readable: {} ({error}).",
                path.display()
            ))
        })?;
        (bytes, path.display().to_string())
    };
    if bytes.is_empty() || bytes.len() > MAX_REFERENCE_BYTES {
        return Err(VideoError::Reference(format!(
            "image reference {label} is empty or larger than {} MiB.",
            MAX_REFERENCE_BYTES / (1024 * 1024)
        )));
    }
    let Some((media_type, width, height)) = crate::images::identify(&bytes) else {
        return Err(VideoError::Reference(format!(
            "image reference {label} is not a png, jpeg, webp, or gif image."
        )));
    };
    Ok(ImageInput::Bytes {
        bytes,
        media_type,
        width,
        height,
    })
}

pub fn plan_job(service: &VideoService, job: &Job, cwd: &Path) -> Result<Plan, VideoError> {
    let (duration, resolution, defaults) = validate_job(service, job)?;
    let resolve = |raw: &str| resolve_image(raw, cwd, service.protocol);
    let first = match job.tool {
        VideoTool::ImageToVideo => job.image.as_deref().map(resolve).transpose()?,
        VideoTool::ReferenceToVideo => job.first_frame.as_deref().map(resolve).transpose()?,
    };
    let images = job
        .images
        .iter()
        .map(|raw| resolve(raw))
        .collect::<Result<Vec<_>, _>>()?;
    let last = job.last_frame.as_deref().map(resolve).transpose()?;
    let keyframes = job
        .keyframes
        .iter()
        .map(|keyframe| resolve(&keyframe.image).map(|image| (image, keyframe.timestamp_s)))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Plan {
        tool: job.tool,
        prompt: job.prompt.clone(),
        duration,
        resolution,
        aspect_ratio: match job.tool {
            VideoTool::ImageToVideo => None,
            VideoTool::ReferenceToVideo => job.aspect_ratio.clone(),
        },
        first,
        images,
        last,
        keyframes,
        voices: job.voices.iter().map(|v| v.trim().to_string()).collect(),
        defaults,
    })
}

/// sdcpp pixel size: the short edge is the resolution height, the long edge
/// follows the aspect ratio (reference_to_video) or the source image
/// (image_to_video), and both are multiples of 64.
pub fn sdcpp_size(plan: &Plan) -> (u32, u32) {
    let short = resolution_height(&plan.resolution).unwrap_or(480) as f64;
    let (w, h) = match (&plan.aspect_ratio, &plan.first) {
        (Some(ratio), _) => ratio
            .split_once(':')
            .and_then(|(w, h)| Some((w.parse::<f64>().ok()?, h.parse::<f64>().ok()?)))
            .filter(|(w, h)| *w > 0.0 && *h > 0.0)
            .unwrap_or((1.0, 1.0)),
        (
            None,
            Some(ImageInput::Bytes {
                width: Some(width),
                height: Some(height),
                ..
            }),
        ) => (*width as f64, *height as f64),
        _ => (1.0, 1.0),
    };
    let round = |value: f64| -> u32 { (((value / 64.0).round() as u32).max(1)) * 64 };
    if w >= h {
        (round(short * w / h), round(short))
    } else {
        (round(short), round(short * h / w))
    }
}

pub fn start_body(service: &VideoService, model: &str, plan: &Plan) -> Value {
    let mut body = serde_json::Map::new();
    match service.protocol {
        VideoProtocol::Xai => {
            body.insert("model".into(), json!(model));
            body.insert("prompt".into(), json!(plan.prompt));
            if let Some(first) = &plan.first {
                body.insert("image".into(), json!({ "url": first.data_url() }));
            }
            body.insert("duration".into(), json!(plan.duration));
            if let Some(ratio) = &plan.aspect_ratio {
                body.insert("aspect_ratio".into(), json!(ratio));
            }
            body.insert("resolution".into(), json!(plan.resolution));
            if !plan.images.is_empty() {
                let images: Vec<Value> = plan
                    .images
                    .iter()
                    .map(|image| json!({ "url": image.data_url() }))
                    .collect();
                body.insert("reference_images".into(), Value::Array(images));
            }
            if !plan.voices.is_empty() {
                let voices: Vec<Value> = plan
                    .voices
                    .iter()
                    .map(|voice| json!({ "voice_id": voice }))
                    .collect();
                body.insert("reference_audios".into(), Value::Array(voices));
            }
            if let Some(last) = &plan.last {
                body.insert("last_frame".into(), json!({ "url": last.data_url() }));
            }
            if !plan.keyframes.is_empty() {
                let keyframes: Vec<Value> = plan
                    .keyframes
                    .iter()
                    .map(|(image, t)| json!({ "image": { "url": image.data_url() }, "timestamp_s": t }))
                    .collect();
                body.insert("keyframes".into(), Value::Array(keyframes));
            }
        }
        VideoProtocol::Sdcpp => {
            let (width, height) = sdcpp_size(plan);
            body.insert("prompt".into(), json!(plan.prompt));
            body.insert("width".into(), json!(width));
            body.insert("height".into(), json!(height));
            body.insert("video_frames".into(), json!(plan.duration * service.fps));
            body.insert("fps".into(), json!(service.fps));
            body.insert("output_format".into(), json!(service.output_format));
            if let Some(first) = &plan.first {
                body.insert("init_image".into(), json!(first.data_url()));
            }
            if let Some(last) = &plan.last {
                body.insert("end_image".into(), json!(last.data_url()));
            }
            if let Some(strength) = service.strength {
                body.insert("strength".into(), json!(strength));
            }
        }
    }
    Value::Object(body)
}

fn endpoint(service: &VideoService, path: &str) -> String {
    format!("{}/{path}", service.base_url.trim_end_matches('/'))
}

fn start_url(service: &VideoService) -> String {
    match service.protocol {
        VideoProtocol::Xai => endpoint(service, "videos/generations"),
        VideoProtocol::Sdcpp => endpoint(service, "sdcpp/v1/vid_gen"),
    }
}

fn poll_url(service: &VideoService, remote_id: &str) -> String {
    match service.protocol {
        VideoProtocol::Xai => endpoint(service, &format!("videos/{remote_id}")),
        VideoProtocol::Sdcpp => endpoint(service, &format!("sdcpp/v1/jobs/{remote_id}")),
    }
}

/// Remote ids go into URL paths; anything outside this set is refused.
fn safe_remote_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
        && id != "."
        && id != ".."
}

// ---------------------------------------------------------------------------
// HTTP

struct Reply {
    status: u16,
    body: Vec<u8>,
}

enum CallError {
    Cancelled,
    Transport(String),
}

struct Http {
    agent: ureq::Agent,
}

impl Http {
    fn new(extra_ca: Option<&Path>) -> Result<Self, VideoError> {
        let (agent, _) = crate::extra_ca::agent(extra_ca)
            .map_err(|error| VideoError::Network(format!("TLS setup failed: {error}.")))?;
        Ok(Self { agent })
    }

    /// One request on a worker, so a cancel flag is honoured while it runs.
    fn call(
        &self,
        method: &'static str,
        url: &str,
        bearer: &str,
        body: Option<Vec<u8>>,
        timeout: Duration,
        cap: u64,
        cancelled: &AtomicBool,
    ) -> Result<Reply, CallError> {
        let agent = self.agent.clone();
        let url = url.to_string();
        let bearer = bearer.to_string();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut request = agent
                .request(method, &url)
                .timeout(timeout)
                .set("user-agent", USER_AGENT)
                .set("accept", "application/json, video/*;q=0.9, */*;q=0.1");
            if !bearer.is_empty() {
                request = request.set("authorization", &format!("Bearer {bearer}"));
            }
            let outcome = match body {
                Some(bytes) => request
                    .set("content-type", "application/json")
                    .send_bytes(&bytes),
                None => request.call(),
            };
            let result = match outcome {
                Ok(response) => {
                    let status = response.status();
                    read_capped(response, cap).map(|body| Reply { status, body })
                }
                Err(ureq::Error::Status(status, response)) => {
                    read_capped(response, MAX_REPLY_BYTES).map(|body| Reply { status, body })
                }
                Err(ureq::Error::Transport(error)) => Err(error.to_string()),
            };
            let _ = sender.send(result);
        });
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err(CallError::Cancelled);
            }
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(reply)) => return Ok(reply),
                Ok(Err(error)) => return Err(CallError::Transport(error)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(CallError::Transport(
                        "the request ended without a response".into(),
                    ));
                }
            }
        }
    }
}

fn read_capped(response: ureq::Response, cap: u64) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    response
        .into_reader()
        .take(cap + 1)
        .read_to_end(&mut body)
        .map_err(|error| error.to_string())?;
    if body.len() as u64 > cap {
        return Err(format!(
            "response is larger than {} MiB",
            cap / (1024 * 1024)
        ));
    }
    Ok(body)
}

fn preview(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(200).collect()
}

fn error_message(body: &[u8]) -> Option<String> {
    let parsed: Value = serde_json::from_slice(body).ok()?;
    let error = parsed.get("error").filter(|value| !value.is_null())?;
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            parsed
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| match error {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        });
    Some(message.chars().take(200).collect())
}

/// The first bytes of a video container: mp4/mov (`ftyp`), webm/mkv (EBML),
/// AVI (`RIFF…AVI `), or animated WebP (`RIFF…WEBP` with an ANIM chunk).
pub fn identify_video(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return Some(("video/mp4", "mp4"));
    }
    if bytes.len() >= 4 && bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        let head = &bytes[..bytes.len().min(64)];
        if head.windows(4).any(|w| w == b"webm") {
            return Some(("video/webm", "webm"));
        }
        return Some(("video/x-matroska", "mkv"));
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"AVI " {
        return Some(("video/x-msvideo", "avi"));
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        let head = &bytes[..bytes.len().min(256)];
        if head.windows(4).any(|w| w == b"ANIM") {
            return Some(("image/webp", "webp"));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Job records

pub mod status {
    pub const SUBMITTING: &str = "submitting";
    pub const QUEUED: &str = "queued";
    pub const GENERATING: &str = "generating";
    pub const DOWNLOADING: &str = "downloading";
    pub const COMPLETED: &str = "completed";
    pub const FAILED: &str = "failed";
    pub const EXPIRED: &str = "expired";
    pub const REFUSED: &str = "refused";
    pub const CANCELLED: &str = "cancelled";
    pub const TIMED_OUT: &str = "timed_out";
    pub const UNKNOWN: &str = "unknown";
    pub const LOST: &str = "lost";
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct JobRecord {
    pub version: u32,
    pub name: String,
    pub call_id: Option<String>,
    pub tool: String,
    pub prompt: String,
    pub service: String,
    pub host: String,
    pub protocol: String,
    pub model: String,
    pub duration: u32,
    pub resolution: String,
    pub aspect_ratio: Option<String>,
    pub inputs: usize,
    pub remote_id: Option<String>,
    pub status: String,
    pub remote_status: Option<String>,
    pub queue_position: Option<u64>,
    pub created: u64,
    pub updated: u64,
    pub pid: Option<u32>,
    pub saved: Option<String>,
    pub saved_path: Option<String>,
    pub bytes: Option<u64>,
    pub media_type: Option<String>,
    pub frames: Option<u64>,
    pub fps: Option<u64>,
    pub error: Option<String>,
    pub note: Option<String>,
    /// confirmed | already_finished | refused | not_supported | unreachable
    pub cancel: Option<String>,
}

impl JobRecord {
    pub fn is_active(&self) -> bool {
        matches!(
            self.status.as_str(),
            status::SUBMITTING | status::QUEUED | status::GENERATING | status::DOWNLOADING
        )
    }

    /// A remote job whose final result may still be asked for.
    pub fn followable(&self) -> bool {
        self.remote_id.is_some()
            && match self.status.as_str() {
                status::QUEUED
                | status::GENERATING
                | status::DOWNLOADING
                | status::TIMED_OUT
                | status::UNKNOWN => true,
                status::CANCELLED => matches!(
                    self.cancel.as_deref(),
                    Some("not_supported" | "refused" | "unreachable" | "already_finished")
                ),
                _ => false,
            }
    }

    /// True while the tool call that started it is still following it.
    pub fn runner_alive(&self) -> bool {
        self.is_active() && self.pid.is_some_and(process_alive)
    }

    pub fn remote_label(&self) -> String {
        match &self.remote_id {
            Some(id) => format!("remote job {id}"),
            None => "no remote job id".into(),
        }
    }

    /// The state a person reads: interrupted when nobody follows an active job.
    pub fn display_status(&self) -> String {
        if self.is_active() && !self.runner_alive() {
            return match &self.remote_id {
                Some(_) => "interrupted: codsh stopped following it while it ran; the service may still be working (/videos status asks again)".into(),
                None => "interrupted before the service answered the start request (outcome unknown; no remote job id)".into(),
            };
        }
        match self.status.as_str() {
            status::COMPLETED => format!(
                "completed → {}",
                self.saved.clone().unwrap_or_else(|| "(file missing)".into())
            ),
            status::QUEUED => match self.queue_position.filter(|p| *p > 0) {
                Some(position) => format!("queued (position {position})"),
                None => "queued".into(),
            },
            status::GENERATING => "generating".into(),
            status::FAILED => format!(
                "failed: {}",
                self.error.clone().unwrap_or_else(|| "no reason given".into())
            ),
            status::EXPIRED => "expired on the service".into(),
            status::REFUSED => format!(
                "refused, no job started: {}",
                self.error.clone().unwrap_or_default()
            ),
            status::CANCELLED => match self.cancel.as_deref() {
                Some("confirmed") => "cancelled (the service confirmed it)".into(),
                Some("already_finished") => "cancelled locally; the service had already finished the job (not saved; /videos status fetches it)".into(),
                Some("refused") => "cancelled locally; the service refused to stop the job and may still finish it (/videos status)".into(),
                Some("not_supported") => "stopped waiting; this service has no cancel request, so the remote job may still finish and be charged (/videos status)".into(),
                Some("unreachable") => "cancelled locally; the cancel request did not reach the service (remote state unknown)".into(),
                _ => "cancelled before a remote job id was received".into(),
            },
            status::TIMED_OUT => "timed out locally; the remote job may still be running (/videos status asks again)".into(),
            status::UNKNOWN => match &self.remote_id {
                Some(_) => "outcome unknown: the service stopped answering (/videos status asks again)".into(),
                None => "outcome unknown: the start request got no answer, so there is no remote job id".into(),
            },
            status::LOST => "lost: the service no longer knows this job".into(),
            other => other.to_string(),
        }
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid_i32) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only checks that the process exists.
    let exists = unsafe { libc::kill(pid_i32, 0) } == 0
        || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    if !exists {
        return false;
    }
    // Guard against pid reuse where /proc is available.
    match std::fs::read(format!("/proc/{pid}/cmdline")) {
        Ok(cmdline) => cmdline.windows(5).any(|w| w == b"video"),
        Err(_) => true,
    }
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    false
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

fn random_hex() -> String {
    let mut bytes = [0u8; 6];
    if getrandom::fill(&mut bytes).is_err() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        bytes.copy_from_slice(&(nanos as u64).to_le_bytes()[..6]);
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A file-name-safe job name from the call id, or a fresh one.
pub fn job_name(call_id: Option<&str>) -> String {
    let cleaned: String = call_id
        .unwrap_or("")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    if cleaned.trim_matches('_').is_empty() {
        format!("job-{}-{}", now_secs(), random_hex())
    } else {
        cleaned
    }
}

fn private_dir(dir: &Path) -> std::io::Result<()> {
    if !dir.exists() {
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

pub fn record_path(session_dir: &Path, name: &str) -> PathBuf {
    session_dir.join(JOBS_DIR).join(format!("{name}.json"))
}

/// Write a record atomically (temp file, fsync, rename).
pub fn write_record(session_dir: &Path, record: &JobRecord) -> Result<(), String> {
    let dir = session_dir.join(JOBS_DIR);
    private_dir(&dir).map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    let mut temp = tempfile::Builder::new()
        .prefix(".tmp")
        .tempfile_in(&dir)
        .map_err(|error| error.to_string())?;
    let text = serde_json::to_vec_pretty(record).map_err(|error| error.to_string())?;
    temp.write_all(&text).map_err(|error| error.to_string())?;
    temp.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temp.persist(record_path(session_dir, &record.name))
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn read_record(path: &Path) -> Option<JobRecord> {
    let text = std::fs::read(path).ok()?;
    serde_json::from_slice(&text).ok()
}

/// All job records, oldest first; `/videos` numbers them from 1.
pub fn list_jobs(session_dir: &Path) -> Vec<JobRecord> {
    let mut records: Vec<JobRecord> = std::fs::read_dir(session_dir.join(JOBS_DIR))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.ends_with(".json") && !name.starts_with('.')
        })
        .filter_map(|entry| read_record(&entry.path()))
        .collect();
    records.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.name.cmp(&b.name)));
    records
}

/// The record of one tool call, for the live row.
pub fn record_for_call(session_dir: &Path, call_id: &str) -> Option<JobRecord> {
    read_record(&record_path(session_dir, &job_name(Some(call_id))))
}

/// `N` (1-based, as `/videos` lists them), a job name or remote id, or
/// nothing (the latest).
pub fn find_job(session_dir: &Path, which: &str) -> Result<(usize, JobRecord), String> {
    let jobs = list_jobs(session_dir);
    if jobs.is_empty() {
        return Err("no video jobs in this session yet".into());
    }
    let which = which.trim();
    if which.is_empty() {
        let index = jobs.len();
        return Ok((index, jobs[index - 1].clone()));
    }
    if let Ok(number) = which.parse::<usize>()
        && (1..=jobs.len()).contains(&number)
    {
        return Ok((number, jobs[number - 1].clone()));
    }
    jobs.iter()
        .enumerate()
        .find(|(_, job)| job.name == which || job.remote_id.as_deref() == Some(which))
        .map(|(index, job)| (index + 1, job.clone()))
        .ok_or_else(|| {
            format!(
                "{which} is not a video job of this session (it has {} job{}; see /videos)",
                jobs.len(),
                if jobs.len() == 1 { "" } else { "s" }
            )
        })
}

// ---------------------------------------------------------------------------
// Storage

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedVideo {
    pub path: PathBuf,
    pub short: String,
    pub media_type: String,
    pub bytes: u64,
}

impl SavedVideo {
    pub fn summary(&self) -> String {
        format!(
            "{} ({}, {})",
            self.short,
            self.media_type
                .trim_start_matches("video/")
                .trim_start_matches("image/"),
            crate::image_gen::human_bytes(self.bytes)
        )
    }
}

/// The session folder must be `$GROK_HOME/sessions/<encoded cwd>/<id>`.
pub fn check_session_dir(grok_home: &Path, session_dir: &Path) -> Result<(), VideoError> {
    let root = grok_home.join("sessions");
    let inside = session_dir.is_absolute()
        && session_dir
            .strip_prefix(&root)
            .map(|rest| {
                let parts: Vec<_> = rest.components().collect();
                parts.len() == 2
                    && parts
                        .iter()
                        .all(|part| matches!(part, Component::Normal(_)))
            })
            .unwrap_or(false);
    if inside {
        Ok(())
    } else {
        Err(VideoError::Storage(format!(
            "session folder {} is not a session under {}; no request was made and nothing was saved.",
            session_dir.display(),
            root.display()
        )))
    }
}

fn numbered(name: &str) -> Option<u32> {
    let (stem, ext) = name.rsplit_once('.')?;
    if !matches!(ext, "mp4" | "webm" | "mkv" | "avi" | "webp") {
        return None;
    }
    stem.parse::<u32>().ok().filter(|n| *n > 0)
}

/// `videos/<n>.<ext>` in number order.
pub fn list_videos(session_dir: &Path) -> Vec<SavedVideo> {
    let dir = session_dir.join(VIDEOS_DIR);
    let mut found: Vec<(u32, SavedVideo)> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let number = numbered(&name)?;
            let metadata = entry.metadata().ok().filter(|meta| meta.is_file())?;
            let mut head = vec![0u8; 256];
            let read = std::fs::File::open(entry.path())
                .and_then(|mut file| file.read(&mut head))
                .unwrap_or(0);
            head.truncate(read);
            let media_type = identify_video(&head)
                .map(|(media, _)| media)
                .unwrap_or("unknown");
            Some((
                number,
                SavedVideo {
                    short: format!("{VIDEOS_DIR}/{name}"),
                    path: entry.path(),
                    media_type: media_type.to_string(),
                    bytes: metadata.len(),
                },
            ))
        })
        .collect();
    found.sort_by_key(|(number, _)| *number);
    found.into_iter().map(|(_, video)| video).collect()
}

/// Atomic save: fsynced temp file hard-linked to the next free number
/// (never replacing a file), then removed.
pub fn save_video(session_dir: &Path, bytes: &[u8]) -> Result<SavedVideo, VideoError> {
    let Some((media_type, ext)) = identify_video(bytes) else {
        return Err(VideoError::Malformed(
            "refusing to save bytes that are not a video container.".into(),
        ));
    };
    let dir = session_dir.join(VIDEOS_DIR);
    let storage = |error: std::io::Error| {
        VideoError::Storage(format!(
            "could not save the video under {}: {error}; no file was kept.",
            dir.display()
        ))
    };
    private_dir(&dir).map_err(storage)?;
    let mut max = 0u32;
    let mut total = 0u64;
    for entry in std::fs::read_dir(&dir).map_err(storage)?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(".tmp") {
            let _ = std::fs::remove_file(entry.path());
            continue;
        }
        if let Some(number) = numbered(&name) {
            max = max.max(number);
            total += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        }
    }
    if total + bytes.len() as u64 > VIDEOS_BUDGET_BYTES {
        return Err(VideoError::Storage(format!(
            "this session's videos folder would exceed {}; nothing was saved.",
            crate::image_gen::human_bytes(VIDEOS_BUDGET_BYTES)
        )));
    }
    let mut temp = tempfile::Builder::new()
        .prefix(".tmp")
        .tempfile_in(&dir)
        .map_err(storage)?;
    temp.write_all(bytes).map_err(storage)?;
    temp.as_file().sync_all().map_err(storage)?;
    let mut number = max + 1;
    loop {
        let name = format!("{number}.{ext}");
        let target = dir.join(&name);
        match std::fs::hard_link(temp.path(), &target) {
            Ok(()) => {
                drop(temp);
                if let Ok(handle) = std::fs::File::open(&dir) {
                    let _ = handle.sync_all();
                }
                return Ok(SavedVideo {
                    path: target,
                    short: format!("{VIDEOS_DIR}/{name}"),
                    media_type: media_type.to_string(),
                    bytes: bytes.len() as u64,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => number += 1,
            Err(error) => return Err(storage(error)),
        }
        if number > max + 10_000 {
            return Err(VideoError::Storage(
                "no free video number in this session; nothing was saved.".into(),
            ));
        }
    }
}

// ---------------------------------------------------------------------------
// Following a remote job

/// What one status request said.
#[derive(Debug, Clone, PartialEq)]
pub enum Poll {
    Pending {
        remote_status: String,
        queue_position: Option<u64>,
    },
    /// xai: the finished file's URL.
    DoneUrl(String),
    /// sdcpp: the finished container bytes.
    DoneBytes {
        bytes: Vec<u8>,
        frames: Option<u64>,
        fps: Option<u64>,
    },
    Failed(String),
    Expired,
    CancelledRemotely(String),
    Lost(String),
    /// Network trouble, 429, or 5xx: worth asking again.
    Transient(String),
    /// Any other refusal of the status request.
    Refused(u16, String),
}

pub fn parse_poll(protocol: VideoProtocol, status_code: u16, body: &[u8]) -> Poll {
    if status_code == 404 || status_code == 410 {
        return Poll::Lost(format!(
            "the service answered HTTP {status_code} ({}); it no longer knows this job",
            error_message(body).unwrap_or_else(|| preview(body))
        ));
    }
    if status_code == 429 || status_code >= 500 {
        return Poll::Transient(format!("HTTP {status_code}: {}", preview(body)));
    }
    if !(200..300).contains(&status_code) {
        return Poll::Refused(
            status_code,
            format!(
                "status request failed with HTTP {status_code}: {}",
                error_message(body).unwrap_or_else(|| preview(body))
            ),
        );
    }
    let Ok(parsed) = serde_json::from_slice::<Value>(body) else {
        if status_code == 202 {
            return Poll::Pending {
                remote_status: "pending".into(),
                queue_position: None,
            };
        }
        return Poll::Transient(format!("status reply is not JSON: {}", preview(body)));
    };
    let state = parsed
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let reason = || error_message(body).unwrap_or_else(|| "no reason given".into());
    match protocol {
        VideoProtocol::Xai => match state.as_str() {
            "done" => match parsed
                .get("video")
                .and_then(|video| video.get("url"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|url| !url.is_empty())
            {
                Some(url) => Poll::DoneUrl(url.to_string()),
                None => Poll::Failed("the service said done but returned no video URL".into()),
            },
            "failed" => Poll::Failed(reason()),
            "expired" => Poll::Expired,
            other => Poll::Pending {
                remote_status: if other.is_empty() {
                    "pending".into()
                } else {
                    other.to_string()
                },
                queue_position: None,
            },
        },
        VideoProtocol::Sdcpp => {
            let queue_position = parsed.get("queue_position").and_then(Value::as_u64);
            match state.as_str() {
                "queued" | "generating" => Poll::Pending {
                    remote_status: state.clone(),
                    queue_position,
                },
                "completed" => {
                    let result = parsed.get("result").cloned().unwrap_or(Value::Null);
                    let b64 = result.get("b64_json").and_then(Value::as_str).unwrap_or("");
                    if b64.is_empty() {
                        return Poll::Failed(
                            "the service said completed but returned no video data".into(),
                        );
                    }
                    match base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                        Ok(bytes) => Poll::DoneBytes {
                            bytes,
                            frames: result.get("frame_count").and_then(Value::as_u64),
                            fps: result.get("fps").and_then(Value::as_u64),
                        },
                        Err(error) => {
                            Poll::Failed(format!("the video data is not valid base64: {error}"))
                        }
                    }
                }
                "failed" => Poll::Failed(reason()),
                "cancelled" => Poll::CancelledRemotely(reason()),
                other => Poll::Transient(format!("unknown job status {other:?}")),
            }
        }
    }
}

/// The host a finished video may be fetched from: the configured service
/// host or a `video_download_hosts` entry, never an official host.
pub fn download_allowed(service: &VideoService, url: &str) -> Result<(), String> {
    let parsed =
        url::Url::parse(url).map_err(|_| format!("the video URL {url:?} is not a valid URL"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(format!(
            "the video URL uses {}:, not http(s)",
            parsed.scheme()
        ));
    }
    if crate::privacy::is_official_endpoint(url) {
        return Err(format!(
            "the video URL points at an official host ({}); codsh does not fetch from it",
            parsed.host_str().unwrap_or("")
        ));
    }
    let host = host_of(url).unwrap_or_default().to_ascii_lowercase();
    let bare = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let configured = service.host().to_ascii_lowercase();
    if host == configured
        || service
            .download_hosts
            .iter()
            .any(|allowed| *allowed == host || *allowed == bare)
    {
        Ok(())
    } else {
        Err(format!(
            "the video URL is on {host}, which is neither the configured service host {configured} nor listed in video_download_hosts; codsh does not fetch from an unconfigured destination"
        ))
    }
}

struct Follower<'a> {
    service: &'a VideoService,
    http: Http,
    session_dir: &'a Path,
    record: JobRecord,
}

impl Follower<'_> {
    fn save_record(&mut self) {
        self.record.updated = now_secs();
        let _ = write_record(self.session_dir, &self.record);
    }

    /// The key is sent only to the configured service host.
    fn bearer_for(&self, url: &str) -> String {
        if host_of(url).map(|h| h.to_ascii_lowercase())
            == Some(self.service.host().to_ascii_lowercase())
        {
            self.service.api_key.clone()
        } else {
            String::new()
        }
    }

    fn poll_once(&self, remote_id: &str, cancelled: &AtomicBool) -> Result<Poll, CallError> {
        let url = poll_url(self.service, remote_id);
        let cap = match self.service.protocol {
            VideoProtocol::Xai => MAX_REPLY_BYTES,
            VideoProtocol::Sdcpp => MAX_JSON_BYTES,
        };
        let reply = self.http.call(
            "GET",
            &url,
            &self.bearer_for(&url),
            None,
            Duration::from_secs(POLL_REQUEST_TIMEOUT_SECS),
            cap,
            cancelled,
        )?;
        Ok(parse_poll(self.service.protocol, reply.status, &reply.body))
    }

    fn download(&self, url: &str, cancelled: &AtomicBool) -> Result<Vec<u8>, VideoError> {
        download_allowed(self.service, url).map_err(|message| {
            VideoError::Malformed(format!("Video download refused: {message}."))
        })?;
        match self.http.call(
            "GET",
            url,
            &self.bearer_for(url),
            None,
            Duration::from_secs(DOWNLOAD_TIMEOUT_SECS),
            MAX_VIDEO_BYTES,
            cancelled,
        ) {
            Ok(reply) if (200..300).contains(&reply.status) => Ok(reply.body),
            Ok(reply) => Err(VideoError::Network(format!(
                "Video download failed (HTTP {}).",
                reply.status
            ))),
            Err(CallError::Cancelled) => Err(VideoError::Cancelled(
                "cancelled while downloading the video.".into(),
            )),
            Err(CallError::Transport(error)) => Err(VideoError::Network(format!(
                "Video download failed: {error}."
            ))),
        }
    }

    /// Ask the service to stop the job (sdcpp) and record what it said.
    fn cancel_remote(&mut self) -> String {
        let Some(remote_id) = self.record.remote_id.clone() else {
            self.record.cancel = None;
            return "no remote job id had been received yet".into();
        };
        if self.service.protocol == VideoProtocol::Xai {
            self.record.cancel = Some("not_supported".into());
            return format!(
                "this service has no cancel request, so remote job {remote_id} may still finish (and be charged); /videos status fetches it if it does"
            );
        }
        let url = endpoint(self.service, &format!("sdcpp/v1/jobs/{remote_id}/cancel"));
        let never = AtomicBool::new(false);
        match self.http.call(
            "POST",
            &url,
            &self.bearer_for(&url),
            Some(b"{}".to_vec()),
            Duration::from_secs(CANCEL_TIMEOUT_SECS),
            MAX_REPLY_BYTES,
            &never,
        ) {
            Ok(reply) if reply.status == 200 => {
                let state = serde_json::from_slice::<Value>(&reply.body)
                    .ok()
                    .and_then(|v| v.get("status").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_default();
                self.record.remote_status = Some(state.clone());
                if state == "cancelled" {
                    self.record.cancel = Some("confirmed".into());
                    format!("the service confirmed remote job {remote_id} is cancelled")
                } else {
                    self.record.cancel = Some("already_finished".into());
                    format!(
                        "the service had already finished remote job {remote_id} ({state}); its result was not saved"
                    )
                }
            }
            Ok(reply) if reply.status == 404 || reply.status == 410 => {
                self.record.cancel = Some("confirmed".into());
                format!(
                    "the service no longer knows remote job {remote_id} (HTTP {})",
                    reply.status
                )
            }
            Ok(reply) => {
                self.record.cancel = Some("refused".into());
                format!(
                    "the service refused to cancel remote job {remote_id} (HTTP {}: {}); it may still finish",
                    reply.status,
                    error_message(&reply.body).unwrap_or_else(|| preview(&reply.body))
                )
            }
            Err(CallError::Transport(error)) => {
                self.record.cancel = Some("unreachable".into());
                format!(
                    "the cancel request for remote job {remote_id} failed ({error}); remote state unknown"
                )
            }
            Err(CallError::Cancelled) => {
                self.record.cancel = Some("unreachable".into());
                format!("the cancel request for remote job {remote_id} did not complete")
            }
        }
    }

    fn finish_bytes(
        &mut self,
        bytes: &[u8],
        frames: Option<u64>,
        fps: Option<u64>,
    ) -> Result<SavedVideo, VideoError> {
        if identify_video(bytes).is_none() {
            self.record.status = status::FAILED.into();
            self.record.error =
                Some("the service returned data that is not a video container".into());
            self.save_record();
            return Err(VideoError::Malformed(format!(
                "The video service returned data that is not an mp4, webm, avi, or animated webp video ({}).",
                self.record.remote_label()
            )));
        }
        match save_video(self.session_dir, bytes) {
            Ok(saved) => {
                self.record.status = status::COMPLETED.into();
                self.record.saved = Some(saved.short.clone());
                self.record.saved_path = Some(saved.path.display().to_string());
                self.record.bytes = Some(saved.bytes);
                self.record.media_type = Some(saved.media_type.clone());
                self.record.frames = frames;
                self.record.fps = fps;
                self.record.error = None;
                self.save_record();
                Ok(saved)
            }
            Err(error) => {
                self.record.status = status::FAILED.into();
                self.record.error = Some(error.to_string());
                self.save_record();
                Err(error)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub saved: SavedVideo,
    pub record: JobRecord,
    pub service: VideoService,
    pub defaults: Vec<String>,
    pub elapsed_ms: u128,
}

impl Outcome {
    pub fn text(&self) -> String {
        let frames = match (self.record.frames, self.record.fps) {
            (Some(frames), Some(fps)) => format!(", {frames} frames @ {fps} fps"),
            (Some(frames), None) => format!(", {frames} frames"),
            _ => String::new(),
        };
        let defaults = if self.defaults.is_empty() {
            String::new()
        } else {
            format!(" ({})", self.defaults.join(", "))
        };
        let ratio = self
            .record
            .aspect_ratio
            .as_ref()
            .map(|ratio| format!(" {ratio}"))
            .unwrap_or_default();
        format!(
            "Video saved to {}{frames}.\nAbsolute path: {}\nRequest: {} {}s {}{ratio}{defaults}\nService: {} · {} · {:.1}s\nCost: {}",
            self.saved.summary(),
            self.saved.path.display(),
            self.record.tool,
            self.record.duration,
            self.record.resolution,
            self.service.host(),
            self.record.remote_label(),
            self.elapsed_ms as f64 / 1000.0,
            self.service.cost_note()
        )
    }

    pub fn json(&self) -> Value {
        json!({
            "ok": true,
            "tool": self.record.tool,
            "path": self.saved.path.display().to_string(),
            "short": self.saved.short,
            "mediaType": self.saved.media_type,
            "bytes": self.saved.bytes,
            "frames": self.record.frames,
            "fps": self.record.fps,
            "duration": self.record.duration,
            "resolution": self.record.resolution,
            "service": self.service.host(),
            "model": self.record.model,
            "protocol": self.service.protocol.label(),
            "job": self.record.name,
            "remoteId": self.record.remote_id,
            "elapsedMs": self.elapsed_ms as u64,
            "cost": self.service.cost_note(),
            "text": self.text(),
        })
    }
}

/// sdcpp: the loaded model must offer `vid_gen` and every input the plan uses.
fn check_sdcpp_capabilities(
    http: &Http,
    service: &VideoService,
    plan: &Plan,
    cancelled: &AtomicBool,
) -> Result<(), VideoError> {
    let url = endpoint(service, "sdcpp/v1/capabilities");
    let reply = match http.call(
        "GET",
        &url,
        &service.api_key,
        None,
        Duration::from_secs(POLL_REQUEST_TIMEOUT_SECS),
        MAX_REPLY_BYTES,
        cancelled,
    ) {
        Ok(reply) => reply,
        Err(CallError::Cancelled) => {
            return Err(VideoError::Cancelled(
                "cancelled before the job was started.".into(),
            ));
        }
        Err(CallError::Transport(error)) => {
            return Err(VideoError::Network(format!(
                "could not read the capabilities of {}: {error}. No job was started.",
                service.host()
            )));
        }
    };
    if !(200..300).contains(&reply.status) {
        return Err(VideoError::Unsupported(format!(
            "{} answered HTTP {} for its capabilities; it does not look like an sd-server video service.",
            service.host(),
            reply.status
        )));
    }
    let caps: Value = serde_json::from_slice(&reply.body).map_err(|_| {
        VideoError::Unsupported(format!(
            "{} returned capabilities that are not JSON.",
            service.host()
        ))
    })?;
    let modes: Vec<&str> = caps
        .get("supported_modes")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !modes.contains(&"vid_gen") {
        return Err(VideoError::Unsupported(format!(
            "the model loaded on {} does not support video generation (supported modes: {}).",
            service.host(),
            if modes.is_empty() {
                "none listed".into()
            } else {
                modes.join(", ")
            }
        )));
    }
    let features = caps
        .get("features_by_mode")
        .and_then(|value| value.get("vid_gen"))
        .cloned()
        .unwrap_or(Value::Null);
    let has = |key: &str| features.get(key).and_then(Value::as_bool).unwrap_or(false);
    if plan.first.is_some() && !has("init_image") {
        return Err(VideoError::Unsupported(format!(
            "the video model on {} does not accept a starting image (init_image).",
            service.host()
        )));
    }
    if plan.last.is_some() && !has("end_image") {
        return Err(VideoError::Unsupported(format!(
            "`last_frame` is not supported by the video model on {} (no end_image).",
            service.host()
        )));
    }
    if let Some(formats) = caps
        .get("output_formats_by_mode")
        .and_then(|value| value.get("vid_gen"))
        .and_then(Value::as_array)
        && !formats
            .iter()
            .any(|format| format.as_str() == Some(service.output_format.as_str()))
    {
        return Err(VideoError::Unsupported(format!(
            "{} cannot write {} video (it offers: {}); set video_output_format.",
            service.host(),
            service.output_format,
            formats
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    if let Some(limits) = caps.get("limits") {
        let (width, height) = sdcpp_size(plan);
        let get = |key: &str| limits.get(key).and_then(Value::as_u64);
        let too_small = get("min_width").is_some_and(|m| (width as u64) < m)
            || get("min_height").is_some_and(|m| (height as u64) < m);
        let too_big = get("max_width").is_some_and(|m| (width as u64) > m)
            || get("max_height").is_some_and(|m| (height as u64) > m);
        if too_small || too_big {
            return Err(VideoError::Unsupported(format!(
                "`resolution_name` {} ({width}x{height}) is outside what {} accepts.",
                plan.resolution,
                service.host()
            )));
        }
    }
    Ok(())
}

fn sleep_until(next: Instant, deadline: Instant, cancelled: &AtomicBool) {
    while Instant::now() < next && Instant::now() < deadline {
        if cancelled.load(Ordering::Relaxed) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub fn run_job(
    services: &VideoServices,
    grok_home: &Path,
    cwd: &Path,
    job: &Job,
    extra_ca: Option<PathBuf>,
    cancelled: &AtomicBool,
) -> Result<Outcome, VideoError> {
    let (service, model) = services.route(job.tool)?;
    check_session_dir(grok_home, &job.session_dir)?;
    let plan = plan_job(&service, job, cwd)?;
    let http = Http::new(extra_ca.as_deref())?;
    if service.protocol == VideoProtocol::Sdcpp {
        check_sdcpp_capabilities(&http, &service, &plan, cancelled)?;
    }
    if cancelled.load(Ordering::Relaxed) {
        return Err(VideoError::Cancelled(
            "cancelled before the job was started.".into(),
        ));
    }
    let now = now_secs();
    let record = JobRecord {
        version: 1,
        name: job_name(job.call_id.as_deref()),
        call_id: job.call_id.clone(),
        tool: job.tool.name().into(),
        prompt: job.prompt.clone(),
        service: service.id.clone(),
        host: service.host(),
        protocol: service.protocol.label().into(),
        model: model.clone(),
        duration: plan.duration,
        resolution: plan.resolution.clone(),
        aspect_ratio: plan.aspect_ratio.clone(),
        inputs: plan.input_count(),
        status: status::SUBMITTING.into(),
        created: now,
        updated: now,
        pid: Some(std::process::id()),
        ..JobRecord::default()
    };
    let mut follower = Follower {
        service: &service,
        http,
        session_dir: &job.session_dir,
        record,
    };
    write_record(&job.session_dir, &follower.record).map_err(|error| {
        VideoError::Storage(format!(
            "could not record the video job under {}: {error}; no request was made.",
            job.session_dir.join(JOBS_DIR).display()
        ))
    })?;
    let started = Instant::now();
    let deadline = started + Duration::from_secs(service.timeout_secs);
    let body = start_body(&service, &model, &plan).to_string().into_bytes();
    let url = start_url(&service);
    let reply = match follower.http.call(
        "POST",
        &url,
        &service.api_key,
        Some(body),
        Duration::from_secs(START_TIMEOUT_SECS),
        MAX_REPLY_BYTES,
        cancelled,
    ) {
        Ok(reply) => reply,
        Err(CallError::Cancelled) => {
            follower.record.status = status::CANCELLED.into();
            follower.record.note = Some(
                "cancelled while the start request was in flight; the service may have started a job codsh has no id for"
                    .into(),
            );
            follower.save_record();
            return Err(VideoError::Cancelled(
                "Video job cancelled while the start request was in flight; the service may still have started a job, but codsh received no job id.".into(),
            ));
        }
        Err(CallError::Transport(error)) => {
            follower.record.status = status::UNKNOWN.into();
            follower.record.error = Some(error.clone());
            follower.record.note = Some(
                "the start request failed without an answer; if it reached the service, a job may exist that codsh has no id for"
                    .into(),
            );
            follower.save_record();
            return Err(VideoError::Network(format!(
                "Video start request to {} failed: {error}. If it reached the service a job may exist, but codsh received no job id.",
                service.host()
            )));
        }
    };
    if !(200..300).contains(&reply.status) {
        let message = format!(
            "Video generation failed with HTTP {}: {}",
            reply.status,
            error_message(&reply.body).unwrap_or_else(|| preview(&reply.body))
        );
        follower.record.status = status::REFUSED.into();
        follower.record.error = Some(message.clone());
        follower.save_record();
        return Err(VideoError::Refused {
            status: reply.status,
            message,
        });
    }
    let started_reply: Value = serde_json::from_slice(&reply.body).unwrap_or(Value::Null);
    let id_key = match service.protocol {
        VideoProtocol::Xai => "request_id",
        VideoProtocol::Sdcpp => "id",
    };
    let remote_id = started_reply
        .get(id_key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let Some(remote_id) = remote_id.filter(|id| safe_remote_id(id)) else {
        follower.record.status = status::UNKNOWN.into();
        follower.record.error = Some(format!(
            "the start reply had no usable {id_key}: {}",
            preview(&reply.body)
        ));
        follower.save_record();
        return Err(VideoError::Malformed(format!(
            "No usable {id_key} received from the video service {}; a job may have started, but codsh cannot follow it.",
            service.host()
        )));
    };
    follower.record.remote_id = Some(remote_id.clone());
    follower.record.status = status::QUEUED.into();
    follower.record.remote_status = started_reply
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_string);
    follower.save_record();

    let outcome = |follower: &Follower, saved: SavedVideo| Outcome {
        saved,
        record: follower.record.clone(),
        service: service.clone(),
        defaults: plan.defaults.clone(),
        elapsed_ms: started.elapsed().as_millis(),
    };
    let mut failures = 0u32;
    let mut next = Instant::now();
    loop {
        sleep_until(next, deadline, cancelled);
        if cancelled.load(Ordering::Relaxed) {
            let what = follower.cancel_remote();
            follower.record.status = status::CANCELLED.into();
            follower.record.note = Some(what.clone());
            follower.save_record();
            return Err(VideoError::Cancelled(format!(
                "Video job cancelled: {what}."
            )));
        }
        if Instant::now() >= deadline {
            follower.record.status = status::TIMED_OUT.into();
            follower.record.note = Some(format!(
                "no result within {}s; remote job {remote_id} may still be running",
                service.timeout_secs
            ));
            follower.save_record();
            return Err(VideoError::TimedOut(format!(
                "Video generation did not complete within {}s (remote job {remote_id} on {}); it may still be running there. /videos status asks the service again and saves the video if it finished.",
                service.timeout_secs,
                service.host()
            )));
        }
        next = Instant::now() + Duration::from_secs(service.poll_secs);
        let poll = match follower.poll_once(&remote_id, cancelled) {
            Ok(poll) => poll,
            Err(CallError::Cancelled) => continue,
            Err(CallError::Transport(error)) => Poll::Transient(error),
        };
        match poll {
            Poll::Pending {
                remote_status,
                queue_position,
            } => {
                failures = 0;
                follower.record.status = if remote_status == "queued" {
                    status::QUEUED.into()
                } else {
                    status::GENERATING.into()
                };
                follower.record.remote_status = Some(remote_status);
                follower.record.queue_position = queue_position;
                follower.save_record();
            }
            Poll::Transient(error) => {
                failures += 1;
                if failures >= MAX_POLL_FAILURES {
                    follower.record.status = status::UNKNOWN.into();
                    follower.record.error = Some(error.clone());
                    follower.save_record();
                    return Err(VideoError::Job(format!(
                        "The video service {} stopped answering about remote job {remote_id} ({error}); its outcome is unknown. /videos status asks again later.",
                        service.host()
                    )));
                }
            }
            Poll::Refused(code, message) => {
                follower.record.status = status::UNKNOWN.into();
                follower.record.error = Some(message.clone());
                follower.save_record();
                let mut text = format!(
                    "Video poll for remote job {remote_id} was refused ({message}); its outcome is unknown."
                );
                if code == 402 {
                    text.push_str(" The service asked for payment; codsh never buys credits.");
                }
                return Err(VideoError::Job(text));
            }
            Poll::Failed(message) => {
                follower.record.status = status::FAILED.into();
                follower.record.error = Some(message.clone());
                follower.save_record();
                return Err(VideoError::Job(format!(
                    "Video generation failed on the service (remote job {remote_id}): {message}."
                )));
            }
            Poll::Expired => {
                follower.record.status = status::EXPIRED.into();
                follower.record.error = Some("the service says the request expired".into());
                follower.save_record();
                return Err(VideoError::Job(format!(
                    "Video generation request expired (remote job {remote_id})."
                )));
            }
            Poll::CancelledRemotely(message) => {
                follower.record.status = status::CANCELLED.into();
                follower.record.cancel = Some("confirmed".into());
                follower.record.note = Some(format!("cancelled on the service: {message}"));
                follower.save_record();
                return Err(VideoError::Job(format!(
                    "The service cancelled remote job {remote_id}: {message}."
                )));
            }
            Poll::Lost(message) => {
                follower.record.status = status::LOST.into();
                follower.record.error = Some(message.clone());
                follower.save_record();
                return Err(VideoError::Job(format!(
                    "Remote job {remote_id} is gone: {message}."
                )));
            }
            Poll::DoneBytes { bytes, frames, fps } => {
                if cancelled.load(Ordering::Relaxed) {
                    continue;
                }
                let saved = follower.finish_bytes(&bytes, frames, fps)?;
                return Ok(outcome(&follower, saved));
            }
            Poll::DoneUrl(url) => {
                follower.record.status = status::DOWNLOADING.into();
                follower.record.remote_status = Some("done".into());
                follower.save_record();
                let bytes = match follower.download(&url, cancelled) {
                    Ok(bytes) => bytes,
                    Err(VideoError::Cancelled(_)) => continue,
                    Err(error) => {
                        follower.record.status = status::FAILED.into();
                        follower.record.error = Some(error.to_string());
                        follower.save_record();
                        return Err(error);
                    }
                };
                if cancelled.load(Ordering::Relaxed) {
                    continue;
                }
                let saved = follower.finish_bytes(&bytes, None, None)?;
                return Ok(outcome(&follower, saved));
            }
        }
    }
}

/// SIGINT/SIGTERM set the flag; the plugin sends SIGTERM when dsh aborts.
pub fn cancel_flag() -> Arc<AtomicBool> {
    crate::image_gen::cancel_flag()
}

// ---------------------------------------------------------------------------
// After the tool call: status, cancel, listing, opening

fn job_head(number: usize, record: &JobRecord) -> String {
    format!(
        "Video job {number} ({} \"{}\")",
        record.tool,
        short_prompt(&record.prompt)
    )
}

/// Ask the service about a job nobody is following, and save the video if
/// it finished. Returns the line `/videos status` shows.
pub fn query_job(
    services: &VideoServices,
    session_dir: &Path,
    which: &str,
    extra_ca: Option<PathBuf>,
) -> Result<String, String> {
    let (number, record) = find_job(session_dir, which)?;
    let head = job_head(number, &record);
    if record.runner_alive() {
        return Ok(format!(
            "{head}: {} on {} ({}), still followed by its tool call.",
            record.status,
            record.host,
            record.remote_label()
        ));
    }
    let Some(remote_id) = record
        .remote_id
        .clone()
        .filter(|_| record.followable() || record.is_active())
    else {
        return Ok(format!(
            "{head}: {} ({}).",
            record.display_status(),
            record.host
        ));
    };
    let service = services.service_for(&record)?;
    let http = Http::new(extra_ca.as_deref()).map_err(|error| error.to_string())?;
    let mut follower = Follower {
        service: &service,
        http,
        session_dir,
        record,
    };
    let never = AtomicBool::new(false);
    let poll = match follower.poll_once(&remote_id, &never) {
        Ok(poll) => poll,
        Err(CallError::Transport(error)) => Poll::Transient(error),
        Err(CallError::Cancelled) => Poll::Transient("no answer".into()),
    };
    let recovered = |follower: &mut Follower, bytes: &[u8], frames, fps| {
        follower.record.pid = None;
        follower.record.note = Some("fetched by /videos status after the tool call ended".into());
        match follower.finish_bytes(bytes, frames, fps) {
            Ok(saved) => format!(
                "{head}: finished on {}; saved {} (recovered after the tool call ended).",
                service.host(),
                saved.summary()
            ),
            Err(error) => format!("{head}: {error}"),
        }
    };
    let text = match poll {
        Poll::Pending {
            remote_status,
            queue_position,
        } => {
            if follower.record.is_active() {
                follower.record.status = status::UNKNOWN.into();
            }
            follower.record.pid = None;
            follower.record.note =
                Some("codsh is not following it; the service still reports it running".into());
            follower.record.remote_status = Some(remote_status.clone());
            follower.record.queue_position = queue_position;
            follower.save_record();
            let queue = queue_position
                .filter(|position| *position > 0)
                .map(|position| format!(", queue position {position}"))
                .unwrap_or_default();
            format!(
                "{head}: still {remote_status} on {} ({}{queue}). Nothing is saved yet; ask again with /videos status {number}.",
                service.host(),
                follower.record.remote_label()
            )
        }
        Poll::Transient(error) => format!(
            "{head}: {} could not be asked ({error}); recorded state: {}.",
            service.host(),
            follower.record.display_status()
        ),
        Poll::Refused(_, message) => format!("{head}: {message}."),
        Poll::Failed(message) => {
            follower.record.status = status::FAILED.into();
            follower.record.error = Some(message.clone());
            follower.save_record();
            format!("{head}: failed on the service: {message}. Nothing was saved.")
        }
        Poll::Expired => {
            follower.record.status = status::EXPIRED.into();
            follower.save_record();
            format!("{head}: expired on the service. Nothing was saved.")
        }
        Poll::CancelledRemotely(message) => {
            follower.record.status = status::CANCELLED.into();
            follower.record.cancel = Some("confirmed".into());
            follower.record.note = Some(format!("cancelled on the service: {message}"));
            follower.save_record();
            format!("{head}: cancelled on the service ({message}). Nothing was saved.")
        }
        Poll::Lost(message) => {
            follower.record.status = status::LOST.into();
            follower.record.error = Some(message.clone());
            follower.save_record();
            format!("{head}: {message}. Nothing was saved.")
        }
        Poll::DoneBytes { bytes, frames, fps } => recovered(&mut follower, &bytes, frames, fps),
        Poll::DoneUrl(url) => match follower.download(&url, &never) {
            Ok(bytes) => recovered(&mut follower, &bytes, None, None),
            Err(error) => {
                follower.record.error = Some(error.to_string());
                follower.save_record();
                format!("{head}: {error}")
            }
        },
    };
    Ok(text)
}

/// Cancel a job no tool call follows any more.
pub fn cancel_job(
    services: &VideoServices,
    session_dir: &Path,
    which: &str,
    extra_ca: Option<PathBuf>,
) -> Result<String, String> {
    let (number, record) = find_job(session_dir, which)?;
    let head = format!("Video job {number}");
    if record.runner_alive() {
        return Err(format!(
            "{head} is still followed by its tool call; press Esc or Ctrl+C on that turn to cancel it (codsh then asks the service to cancel)."
        ));
    }
    if record.remote_id.is_none() {
        return Ok(format!(
            "{head}: nothing codsh can cancel ({}).",
            record.display_status()
        ));
    }
    if !record.followable() && !record.is_active() {
        return Ok(format!(
            "{head}: nothing to cancel ({}).",
            record.display_status()
        ));
    }
    let service = services.service_for(&record)?;
    let http = Http::new(extra_ca.as_deref()).map_err(|error| error.to_string())?;
    let mut follower = Follower {
        service: &service,
        http,
        session_dir,
        record,
    };
    follower.record.pid = None;
    let what = follower.cancel_remote();
    follower.record.status = status::CANCELLED.into();
    follower.record.note = Some(what.clone());
    follower.save_record();
    Ok(format!("{head}: {what}."))
}

fn short_prompt(prompt: &str) -> String {
    let flat = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 60 {
        format!("{}…", flat.chars().take(59).collect::<String>())
    } else {
        flat
    }
}

/// `videos/<n>.<ext>`, `<n>`, or nothing (the latest) to one saved file.
pub fn find_video(session_dir: &Path, which: &str) -> Result<SavedVideo, String> {
    let videos = list_videos(session_dir);
    let which = which.trim();
    let Some(last) = videos.last() else {
        return Err(format!(
            "no videos saved in this session yet ({})",
            session_dir.join(VIDEOS_DIR).display()
        ));
    };
    if which.is_empty() {
        return Ok(last.clone());
    }
    let wanted = which.trim_start_matches("videos/");
    videos
        .iter()
        .find(|video| {
            let name = video.short.trim_start_matches("videos/");
            name == wanted || name.split('.').next() == Some(wanted)
        })
        .cloned()
        .ok_or_else(|| {
            format!(
                "{which} is not a video of this session; saved: {}",
                videos
                    .iter()
                    .map(|video| video.short.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

pub fn listing(session_dir: &Path) -> String {
    let videos = list_videos(session_dir);
    let jobs = list_jobs(session_dir);
    if videos.is_empty() && jobs.is_empty() {
        return format!(
            "No video jobs in this session yet. image_to_video / reference_to_video results go to {}.",
            session_dir.join(VIDEOS_DIR).display()
        );
    }
    let mut lines = Vec::new();
    if videos.is_empty() {
        lines.push("No videos saved in this session.".to_string());
    } else {
        lines.push(format!(
            "Session videos ({}) in {}:",
            videos.len(),
            session_dir.join(VIDEOS_DIR).display()
        ));
        for video in &videos {
            lines.push(format!("  {}", video.summary()));
        }
    }
    if !jobs.is_empty() {
        lines.push(format!("Video jobs ({}):", jobs.len()));
        for (index, job) in jobs.iter().enumerate() {
            lines.push(format!(
                "  {}. {} \"{}\" · {}s {} · {} · {} · {}",
                index + 1,
                job.tool,
                short_prompt(&job.prompt),
                job.duration,
                job.resolution,
                job.host,
                job.remote_label(),
                job.display_status()
            ));
        }
    }
    lines.push("/videos open [N] opens a video · /videos status [N] asks the service about a job · /videos cancel N cancels one".into());
    lines.join("\n")
}

/// Session jobs with no saved result whose remote outcome is still open:
/// interrupted while running, timed out locally, or unknown (shown after a
/// resume, so saved conversation is not mistaken for finished work).
pub fn unsettled_jobs(session_dir: &Path) -> usize {
    list_jobs(session_dir)
        .iter()
        .filter(|job| {
            if job.is_active() {
                !job.runner_alive()
            } else {
                job.followable()
            }
        })
        .count()
}

/// The notice after a resume, when some video jobs are unsettled.
pub fn resume_notice(session_dir: &Path) -> Option<String> {
    let count = unsettled_jobs(session_dir);
    (count > 0).then(|| {
        format!(
            "{count} video job{} of this session {} no saved result yet (interrupted, timed out, or unknown); the conversation was restored, not the work. /videos lists them; /videos status N asks the service again.",
            if count == 1 { "" } else { "s" },
            if count == 1 { "has" } else { "have" }
        )
    })
}

/// Open a saved video with CODSH_VIDEO_OPENER, else `open` or `xdg-open`.
pub fn open_video(path: &Path, env: &BTreeMap<String, String>) -> Result<String, String> {
    use std::process::{Command, Stdio};
    let (program, mut args) = match env
        .get("CODSH_VIDEO_OPENER")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        Some(opener) => {
            let mut words = opener.split_whitespace().map(str::to_string);
            let program = words.next().unwrap_or_default();
            (program, words.collect::<Vec<_>>())
        }
        None if cfg!(target_os = "macos") => ("open".to_string(), Vec::new()),
        None => ("xdg-open".to_string(), Vec::new()),
    };
    args.push(path.display().to_string());
    Command::new(&program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| program.clone())
        .map_err(|error| {
            format!(
                "could not open {} with {program}: {error}. Set CODSH_VIDEO_OPENER to a video player.",
                path.display()
            )
        })
}

// ---------------------------------------------------------------------------
// Rows

/// Tool rows already titled by [`card_title`].
pub fn is_video_title(title: &str) -> bool {
    title.starts_with("Animate image") || title.starts_with("Reference video")
}

/// The card title of a video row: what is asked, and the host it goes to.
pub fn card_title(name: &str, raw_input: &Value, services: &VideoServices) -> Option<String> {
    let tool = VideoTool::parse(name)?;
    let host = services
        .service
        .as_ref()
        .map(VideoService::host)
        .unwrap_or_else(|| "the configured service".into());
    let prompt = short_prompt(
        raw_input
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let duration = raw_input
        .get("duration")
        .and_then(|value| match value {
            Value::Number(number) => Some(format!("{number}s")),
            Value::String(text) if !text.trim().is_empty() => Some(format!("{}s", text.trim())),
            _ => None,
        })
        .unwrap_or_else(|| "default length".into());
    let resolution = raw_input
        .get("resolution_name")
        .and_then(Value::as_str)
        .unwrap_or("default resolution");
    Some(match tool {
        VideoTool::ImageToVideo => {
            format!("Animate image ({duration}, {resolution}) \"{prompt}\" via {host}")
        }
        VideoTool::ReferenceToVideo => {
            let ratio = raw_input
                .get("aspect_ratio")
                .and_then(Value::as_str)
                .unwrap_or("no ratio");
            format!(
                "Reference video ({}; {duration}, {resolution}, {ratio}) \"{prompt}\" via {host}",
                reference_inputs(raw_input)
            )
        }
    })
}

fn reference_inputs(raw_input: &Value) -> String {
    let count = |key: &str| {
        raw_input
            .get(key)
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
    };
    let plural = |n: usize, word: &str| format!("{n} {word}{}", if n == 1 { "" } else { "s" });
    let mut parts = Vec::new();
    if count("images") > 0 {
        parts.push(plural(count("images"), "ref"));
    }
    if raw_input
        .get("first_frame")
        .and_then(Value::as_str)
        .is_some()
    {
        parts.push("first frame".into());
    }
    if raw_input
        .get("last_frame")
        .and_then(Value::as_str)
        .is_some()
    {
        parts.push("last frame".into());
    }
    if count("keyframes") > 0 {
        parts.push(plural(count("keyframes"), "keyframe"));
    }
    if count("voices") > 0 {
        parts.push(plural(count("voices"), "voice"));
    }
    if parts.is_empty() {
        "no inputs".into()
    } else {
        parts.join(", ")
    }
}

fn host_in(title: &str) -> String {
    title
        .rsplit_once(" via ")
        .map(|(_, host)| host.trim().to_string())
        .unwrap_or_else(|| "the configured service".into())
}

/// The second line of a video approval card: what is sent where, and cost.
pub fn approval_note(title: &str, raw_input: &Value) -> String {
    let host = host_in(title);
    let text = |key: &str| usize::from(raw_input.get(key).and_then(Value::as_str).is_some());
    let list = |key: &str| {
        raw_input
            .get(key)
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
    };
    let images = text("image")
        + text("first_frame")
        + text("last_frame")
        + list("images")
        + list("keyframes");
    let sends = match images {
        0 => format!("Starts one video job on {host} with the prompt."),
        1 => format!("Starts one video job on {host} with the prompt and 1 image."),
        n => format!("Starts one video job on {host} with the prompt and {n} images."),
    };
    format!(
        "{sends} codsh does not know its price; any charge is set by that service. Each video request asks again."
    )
}

/// The live line under a running video call, from its job record.
pub fn progress_line(title: &str, elapsed: Duration, record: Option<&JobRecord>) -> String {
    let host = host_in(title);
    let state = match record {
        None => format!("starting a job on {host}"),
        Some(record) => match (record.status.as_str(), record.remote_id.as_deref()) {
            (status::QUEUED, Some(id)) => match record.queue_position.filter(|p| *p > 0) {
                Some(position) => format!("job {id} queued on {host} (position {position})"),
                None => format!("job {id} queued on {host}"),
            },
            (status::GENERATING, Some(id)) => format!(
                "job {id} {} on {host}",
                record
                    .remote_status
                    .clone()
                    .unwrap_or_else(|| "generating".into())
            ),
            (status::DOWNLOADING, Some(id)) => {
                format!("job {id} finished on {host}; downloading the video")
            }
            _ => format!("starting a job on {host}"),
        },
    };
    format!(
        "video: {state} · {}s elapsed · Ctrl+C cancels; nothing is saved until the video arrives",
        elapsed.as_secs()
    )
}

// ---------------------------------------------------------------------------
// Layered settings (same rules as image_gen.rs)

fn env_flag(value: Option<&String>) -> Option<bool> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn bool_at(table: Option<&TomlValue>, path: &[&str]) -> Option<bool> {
    table.and_then(|value| bool_at_value(value, path))
}

fn bool_at_value(value: &TomlValue, path: &[&str]) -> Option<bool> {
    walk(value, path)?.as_bool()
}

fn string_at(value: &TomlValue, path: &[&str]) -> Option<String> {
    walk(value, path)?
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn walk<'a>(value: &'a TomlValue, path: &[&str]) -> Option<&'a TomlValue> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn layered_string(
    requirements: Option<&TomlValue>,
    managed: Option<&TomlValue>,
    user: &TomlValue,
    env_value: Option<&String>,
    path: &[&str],
    pin: bool,
) -> (Option<String>, String) {
    let required = requirements.and_then(|table| string_at(table, path));
    if pin && let Some(value) = required.clone() {
        return (Some(value), "requirements".into());
    }
    if let Some(value) = string_at(user, path) {
        return (Some(value), "config.toml".into());
    }
    if let Some(value) = env_value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return (Some(value), "environment".into());
    }
    if let Some(value) = required {
        return (Some(value), "requirements".into());
    }
    if let Some(value) = managed.and_then(|table| string_at(table, path)) {
        return (Some(value), "managed".into());
    }
    (None, "default".into())
}

fn layered_pin_bool(
    requirements: Option<&TomlValue>,
    managed: Option<&TomlValue>,
    user: &TomlValue,
    env_on: Option<&String>,
    path: &[&str],
) -> (Option<bool>, String) {
    if let Some(value) = bool_at(requirements, path) {
        return (Some(value), "requirements".into());
    }
    if let Some(value) = env_flag(env_on) {
        return (Some(value), "environment".into());
    }
    if let Some(value) = bool_at_value(user, path) {
        return (Some(value), "config.toml".into());
    }
    if let Some(value) = bool_at(managed, path) {
        return (Some(value), "managed".into());
    }
    (None, "default".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::Mutex;

    fn toml(text: &str) -> TomlValue {
        TomlValue::Table(text.parse::<toml::Table>().unwrap())
    }

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    const XAI: &str = r#"
[models]
default = "chat"
video_gen = "clips"
[model.chat]
base_url = "http://127.0.0.1:9/v1"
[model.clips]
model = "clip-model"
base_url = "http://127.0.0.1:7/v1"
supports_video_generation = true
poll_secs = 1
"#;

    const SDCPP: &str = r#"
[models]
video_gen = "local"
[model.local]
base_url = "http://127.0.0.1:7"
protocol = "sdcpp"
supports_video_generation = true
poll_secs = 1
video_durations = [1, 2]
video_resolutions = ["256p"]
video_tools = ["image_to_video", "reference_to_video"]
video_fps = 4
"#;

    fn webm() -> Vec<u8> {
        let mut bytes = vec![0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x82, 0x84];
        bytes.extend_from_slice(b"webm");
        bytes.extend_from_slice(&[0u8; 64]);
        bytes
    }

    fn mp4() -> Vec<u8> {
        let mut bytes = vec![0, 0, 0, 0x18];
        bytes.extend_from_slice(b"ftypisom");
        bytes.extend_from_slice(&[0u8; 64]);
        bytes
    }

    fn temp_home(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "codsh-video-{name}-{}-{}",
            std::process::id(),
            random_hex()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn session(home: &Path) -> PathBuf {
        let dir = home.join("sessions").join("%2Ftmp%2Fw").join("sess-1");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn png_file(home: &Path) -> PathBuf {
        let path = home.join("source.png");
        std::fs::write(&path, crate::images::tiny_png()).unwrap();
        path
    }

    fn i2v(dir: &Path, image: &Path) -> Job {
        let mut job = Job::new(VideoTool::ImageToVideo, dir.to_path_buf());
        job.prompt = "the square drifts".into();
        job.image = Some(image.display().to_string());
        job
    }

    #[test]
    fn nothing_is_enabled_without_an_explicit_service() {
        let services = load_services(&toml("[features]\nvideo_gen = true\n"), &env(&[]), None);
        assert!(!services.enabled);
        assert!(!services.tool_enabled(VideoTool::ImageToVideo));
        assert!(services.errors.is_empty());
        assert!(services.warnings[0].contains("no hidden default service"));
        assert_eq!(
            services.route(VideoTool::ImageToVideo).unwrap_err(),
            VideoError::Disabled("image_to_video")
        );
        assert_eq!(disclosure(&services), "video: off; no request is made");
        let dsh = dsh_env(&services);
        assert!(dsh.contains(&("CODSH_VIDEO_I2V".into(), "0".into())));
        assert!(dsh.contains(&("CODSH_VIDEO_R2V".into(), "0".into())));
        assert!(!dsh.iter().any(|(key, _)| key == "CODSH_VIDEO_HOST"));
    }

    #[test]
    fn configured_service_enables_both_tools_and_env_or_requirements_turn_them_off() {
        let services = load_services(&toml(XAI), &env(&[]), None);
        assert!(services.enabled, "{services:?}");
        let (service, model) = services.route(VideoTool::ReferenceToVideo).unwrap();
        assert_eq!(
            (service.host().as_str(), model.as_str()),
            ("127.0.0.1:7", "clip-model")
        );
        assert!(service.cost_note().contains("keyless"));
        assert!(service.cost_note().contains("does not know its price"));
        let dsh = dsh_env(&services);
        assert!(dsh.contains(&("CODSH_VIDEO_I2V".into(), "1".into())));
        assert!(dsh.contains(&("CODSH_VIDEO_R2V".into(), "1".into())));
        assert!(dsh.contains(&("CODSH_VIDEO_MAX_PARALLEL".into(), "4".into())));
        assert!(dsh.contains(&("CODSH_VIDEO_HOST".into(), "127.0.0.1:7".into())));
        let caps = dsh
            .iter()
            .find(|(key, _)| key == "CODSH_VIDEO_CAPS")
            .unwrap();
        assert!(
            caps.1.contains("image_to_video duration 6 or 10 s"),
            "{caps:?}"
        );
        assert!(
            caps.1.contains("reference_to_video duration 1–15 s"),
            "{caps:?}"
        );
        let off = load_services(&toml(XAI), &env(&[("GROK_VIDEO_GEN", "0")]), None);
        assert!(!off.enabled);
        assert_eq!(off.enabled_source, "environment");
        let requirements = toml("[features]\nvideo_gen = false\n");
        let pinned = load_services(
            &toml(XAI),
            &env(&[("GROK_VIDEO_GEN", "1")]),
            Some(&requirements),
        );
        assert!(!pinned.enabled);
        assert_eq!(pinned.enabled_source, "requirements");
        let rows = inspect_rows(&services);
        assert!(rows.iter().any(|row| row.0 == "video capabilities"));
        assert_eq!(
            inspect_json(&services)["tools"],
            json!(["image_to_video", "reference_to_video"])
        );
    }

    #[test]
    fn official_hosts_chat_models_bad_values_and_missing_keys_are_config_errors() {
        let official = XAI.replace("http://127.0.0.1:7/v1", "https://api.x.ai/v1");
        let services = load_services(&toml(&official), &env(&[]), None);
        assert!(!services.enabled);
        assert!(
            services.errors[0].contains("official host"),
            "{:?}",
            services.errors
        );
        assert!(
            inspect_rows(&services)[0]
                .1
                .ends_with("(refused; see Invalid configuration)")
        );
        let download = format!("{XAI}video_download_hosts = [\"vidgen.x.ai\"]\n");
        let services = load_services(&toml(&download), &env(&[]), None);
        assert!(
            services.errors[0].contains("video download host refused"),
            "{:?}",
            services.errors
        );
        let chat = XAI.replace("supports_video_generation = true\n", "");
        let services = load_services(&toml(&chat), &env(&[]), None);
        assert!(services.errors[0].contains("supports_video_generation"));
        let keyed = format!("{XAI}env_key = \"CLIPS_KEY\"\n");
        let services = load_services(&toml(&keyed), &env(&[("CLIPS_KEY", " ")]), None);
        assert!(services.errors[0].contains("CLIPS_KEY but it is empty"));
        let services = load_services(&toml(&keyed), &env(&[("CLIPS_KEY", "k-1")]), None);
        assert!(services.enabled);
        assert_eq!(services.service.as_ref().unwrap().api_key, "k-1");
        for (extra, needle) in [
            ("protocol = \"openai\"\n", "not a video protocol"),
            ("video_durations = [0]\n", "video_durations"),
            ("video_resolutions = [\"big\"]\n", "video_resolutions"),
            ("video_tools = [\"image_gen\"]\n", "video_tools"),
            ("video_output_format = \"gif\"\n", "video_output_format"),
            ("timeout_secs = 0\n", "timeout_secs"),
        ] {
            let services = load_services(&toml(&format!("{XAI}{extra}")), &env(&[]), None);
            assert!(!services.enabled, "{extra}");
            assert!(
                services.errors[0].contains(needle),
                "{extra}: {:?}",
                services.errors
            );
        }
        let services = load_services(
            &toml(XAI),
            &env(&[("GROK_MAX_PARALLEL_VIDEO_GEN_CALLS", "99")]),
            None,
        );
        assert!(services.errors[0].contains("max_parallel_video_gen_calls"));
        let services = load_services(
            &toml(XAI),
            &env(&[("GROK_MAX_PARALLEL_VIDEO_GEN_CALLS", "2")]),
            None,
        );
        assert_eq!(
            (services.max_parallel, services.max_parallel_source.as_str()),
            (2, "environment")
        );
    }

    #[test]
    fn unsupported_values_are_refused_with_the_supported_ones_and_defaults_are_named() {
        let services = load_services(&toml(XAI), &env(&[]), None);
        let service = services.service.clone().unwrap();
        let home = temp_home("validate");
        let dir = session(&home);
        let image = png_file(&home);
        let mut job = i2v(&dir, &image);
        let (duration, resolution, defaults) = validate_job(&service, &job).unwrap();
        assert_eq!((duration, resolution.as_str()), (6, "480p"));
        assert_eq!(
            defaults,
            vec!["duration 6s (default)", "resolution 480p (default)"]
        );
        job.duration = Some(7);
        let error = validate_job(&service, &job).unwrap_err().to_string();
        assert!(error.contains("`duration` 7s is not supported"), "{error}");
        assert!(error.contains("supported: 6 or 10 s"), "{error}");
        assert!(error.contains("No request was made"), "{error}");
        job.duration = Some(10);
        job.resolution = Some("1080p".into());
        let error = validate_job(&service, &job).unwrap_err().to_string();
        assert!(error.contains("supported: 480p, 720p"), "{error}");
        job.resolution = Some("720p".into());
        assert_eq!(validate_job(&service, &job).unwrap().0, 10);
        job.image = None;
        assert!(
            validate_job(&service, &job)
                .unwrap_err()
                .to_string()
                .contains("requires `image`")
        );

        let mut reference = Job::new(VideoTool::ReferenceToVideo, dir.clone());
        reference.prompt = "two cats".into();
        reference.aspect_ratio = Some("16:9".into());
        assert!(
            validate_job(&service, &reference)
                .unwrap_err()
                .to_string()
                .contains("at least one input")
        );
        reference.images = vec![image.display().to_string(); 15];
        assert!(
            validate_job(&service, &reference)
                .unwrap_err()
                .to_string()
                .contains("at most 14")
        );
        reference.images = vec![image.display().to_string()];
        reference.voices = vec!["ara".into(); 4];
        assert!(
            validate_job(&service, &reference)
                .unwrap_err()
                .to_string()
                .contains("at most 3")
        );
        reference.voices = vec!["ara".into()];
        reference.aspect_ratio = Some("21:9".into());
        assert!(
            validate_job(&service, &reference)
                .unwrap_err()
                .to_string()
                .contains("21:9")
        );
        reference.aspect_ratio = None;
        assert!(
            validate_job(&service, &reference)
                .unwrap_err()
                .to_string()
                .contains("requires `aspect_ratio`")
        );
        reference.aspect_ratio = Some("9:16".into());
        reference.duration = Some(4);
        reference.keyframes = vec![Keyframe {
            image: image.display().to_string(),
            timestamp_s: 4.0,
        }];
        assert!(
            validate_job(&service, &reference)
                .unwrap_err()
                .to_string()
                .contains("strictly inside")
        );
        reference.keyframes[0].timestamp_s = 2.0;
        assert_eq!(validate_job(&service, &reference).unwrap().0, 4);
        reference.duration = Some(16);
        assert!(
            validate_job(&service, &reference)
                .unwrap_err()
                .to_string()
                .contains("supported: 1–15 s")
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn the_sdcpp_protocol_refuses_inputs_it_cannot_take() {
        let services = load_services(&toml(SDCPP), &env(&[]), None);
        let service = services.service.clone().unwrap();
        assert_eq!(service.protocol, VideoProtocol::Sdcpp);
        let home = temp_home("sdcpp-validate");
        let dir = session(&home);
        let image = png_file(&home);
        let mut reference = Job::new(VideoTool::ReferenceToVideo, dir.clone());
        reference.prompt = "a wave".into();
        reference.aspect_ratio = Some("1:1".into());
        reference.images = vec![image.display().to_string()];
        let error = validate_job(&service, &reference).unwrap_err().to_string();
        assert!(
            error.contains("`images` (style/content references) is not supported"),
            "{error}"
        );
        reference.images.clear();
        reference.voices = vec!["ara".into()];
        assert!(
            validate_job(&service, &reference)
                .unwrap_err()
                .to_string()
                .contains("`voices`")
        );
        reference.voices.clear();
        reference.last_frame = Some(image.display().to_string());
        assert!(
            validate_job(&service, &reference)
                .unwrap_err()
                .to_string()
                .contains("without `first_frame`")
        );
        reference.first_frame = Some(image.display().to_string());
        assert_eq!(validate_job(&service, &reference).unwrap().0, 1);
        let mut job = i2v(&dir, &image);
        job.duration = Some(6);
        assert!(
            validate_job(&service, &job)
                .unwrap_err()
                .to_string()
                .contains("supported: 1 or 2 s")
        );
        let error =
            resolve_image("https://example.com/a.png", &dir, VideoProtocol::Sdcpp).unwrap_err();
        assert!(error.to_string().contains("is a URL"));
        assert_eq!(
            resolve_image("https://example.com/a.png", &dir, VideoProtocol::Xai).unwrap(),
            ImageInput::Url("https://example.com/a.png".into())
        );
        assert!(
            resolve_image("[Image #2]", &dir, VideoProtocol::Xai)
                .unwrap_err()
                .to_string()
                .contains("matches no image attached")
        );
        assert!(
            resolve_image("missing.png", &dir, VideoProtocol::Xai)
                .unwrap_err()
                .to_string()
                .contains("not readable")
        );
        let text = home.join("notes.txt");
        std::fs::write(&text, "hello").unwrap();
        assert!(
            resolve_image(&text.display().to_string(), &dir, VideoProtocol::Xai)
                .unwrap_err()
                .to_string()
                .contains("not a png")
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn start_bodies_follow_each_protocol() {
        let home = temp_home("bodies");
        let dir = session(&home);
        let image = png_file(&home);
        let xai = load_services(&toml(XAI), &env(&[]), None).service.unwrap();
        let mut reference = Job::new(VideoTool::ReferenceToVideo, dir.clone());
        reference.prompt = "<IMAGE_0> waves".into();
        reference.aspect_ratio = Some("16:9".into());
        reference.images = vec![image.display().to_string()];
        reference.voices = vec![" ara ".into()];
        reference.last_frame = Some(image.display().to_string());
        reference.keyframes = vec![Keyframe {
            image: image.display().to_string(),
            timestamp_s: 2.5,
        }];
        let plan = plan_job(&xai, &reference, &home).unwrap();
        let body = start_body(&xai, "clip-model", &plan);
        assert_eq!(body["model"], "clip-model");
        assert_eq!(body["duration"], 6);
        assert_eq!(body["resolution"], "480p");
        assert_eq!(body["aspect_ratio"], "16:9");
        assert!(
            body["reference_images"][0]["url"]
                .as_str()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
        assert_eq!(body["reference_audios"], json!([{ "voice_id": "ara" }]));
        assert!(body["last_frame"]["url"].is_string());
        assert_eq!(body["keyframes"][0]["timestamp_s"], 2.5);
        assert!(body.get("image").is_none());
        assert_eq!(plan.input_count(), 4);

        let sdcpp = load_services(&toml(SDCPP), &env(&[]), None)
            .service
            .unwrap();
        let mut job = i2v(&dir, &image);
        job.duration = Some(2);
        let plan = plan_job(&sdcpp, &job, &home).unwrap();
        let body = start_body(&sdcpp, "local", &plan);
        assert_eq!(
            (body["width"].as_u64(), body["height"].as_u64()),
            (Some(256), Some(256))
        );
        assert_eq!(body["video_frames"], 8);
        assert_eq!(body["fps"], 4);
        assert_eq!(body["output_format"], "webm");
        assert!(
            body["init_image"]
                .as_str()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
        assert!(body.get("model").is_none());
        let mut wide = plan.clone();
        wide.aspect_ratio = Some("16:9".into());
        assert_eq!(sdcpp_size(&wide), (448, 256));
        wide.aspect_ratio = Some("9:16".into());
        assert_eq!(sdcpp_size(&wide), (256, 448));
        assert!(safe_remote_id("job-1_a.b:c") && !safe_remote_id("../x") && !safe_remote_id(""));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn status_replies_map_to_distinct_states() {
        let x = VideoProtocol::Xai;
        let s = VideoProtocol::Sdcpp;
        assert_eq!(
            parse_poll(x, 202, b""),
            Poll::Pending {
                remote_status: "pending".into(),
                queue_position: None
            }
        );
        assert_eq!(
            parse_poll(x, 200, br#"{"status":"pending"}"#),
            Poll::Pending {
                remote_status: "pending".into(),
                queue_position: None
            }
        );
        assert_eq!(
            parse_poll(
                x,
                200,
                br#"{"status":"done","video":{"url":"http://h/v.mp4"}}"#
            ),
            Poll::DoneUrl("http://h/v.mp4".into())
        );
        assert!(matches!(
            parse_poll(x, 200, br#"{"status":"done","video":{}}"#),
            Poll::Failed(_)
        ));
        assert_eq!(
            parse_poll(x, 200, br#"{"status":"failed","error":{"message":"nsfw"}}"#),
            Poll::Failed("nsfw".into())
        );
        assert_eq!(
            parse_poll(x, 200, br#"{"status":"expired"}"#),
            Poll::Expired
        );
        assert!(matches!(parse_poll(x, 404, b"{}"), Poll::Lost(_)));
        assert!(matches!(parse_poll(x, 410, b"{}"), Poll::Lost(_)));
        assert!(matches!(parse_poll(x, 503, b"busy"), Poll::Transient(_)));
        assert!(matches!(parse_poll(x, 429, b"slow"), Poll::Transient(_)));
        assert!(matches!(
            parse_poll(x, 402, br#"{"error":"pay"}"#),
            Poll::Refused(402, _)
        ));
        assert!(matches!(parse_poll(x, 200, b"<html>"), Poll::Transient(_)));
        assert_eq!(
            parse_poll(s, 200, br#"{"status":"queued","queue_position":2}"#),
            Poll::Pending {
                remote_status: "queued".into(),
                queue_position: Some(2)
            }
        );
        assert_eq!(
            parse_poll(s, 200, br#"{"status":"generating"}"#),
            Poll::Pending {
                remote_status: "generating".into(),
                queue_position: None
            }
        );
        let b64 = base64::engine::general_purpose::STANDARD.encode(webm());
        let body = format!(
            r#"{{"status":"completed","result":{{"b64_json":"{b64}","frame_count":9,"fps":4}}}}"#
        );
        assert_eq!(
            parse_poll(s, 200, body.as_bytes()),
            Poll::DoneBytes {
                bytes: webm(),
                frames: Some(9),
                fps: Some(4)
            }
        );
        assert!(matches!(
            parse_poll(s, 200, br#"{"status":"completed","result":{}}"#),
            Poll::Failed(_)
        ));
        assert_eq!(
            parse_poll(
                s,
                200,
                br#"{"status":"failed","error":{"code":"x","message":"oom"}}"#
            ),
            Poll::Failed("oom".into())
        );
        assert!(matches!(
            parse_poll(s, 200, br#"{"status":"cancelled"}"#),
            Poll::CancelledRemotely(_)
        ));
        assert!(matches!(
            parse_poll(s, 200, br#"{"status":"weird"}"#),
            Poll::Transient(_)
        ));
    }

    #[test]
    fn only_video_containers_are_recognised_and_saved_atomically() {
        assert_eq!(identify_video(&mp4()), Some(("video/mp4", "mp4")));
        assert_eq!(identify_video(&webm()), Some(("video/webm", "webm")));
        let mut avi = b"RIFF\0\0\0\0AVI LIST".to_vec();
        avi.extend_from_slice(&[0u8; 16]);
        assert_eq!(identify_video(&avi), Some(("video/x-msvideo", "avi")));
        let mut anim = b"RIFF\0\0\0\0WEBPVP8X\0\0\0\0\0\0\0\0\0\0\0\0\0\0ANIM".to_vec();
        anim.extend_from_slice(&[0u8; 16]);
        assert_eq!(identify_video(&anim), Some(("image/webp", "webp")));
        assert_eq!(identify_video(b"RIFF\0\0\0\0WEBPVP8 still"), None);
        assert_eq!(identify_video(&crate::images::tiny_png()), None);
        assert_eq!(identify_video(b"{\"error\":1}"), None);
        let home = temp_home("save");
        let dir = session(&home);
        assert!(save_video(&dir, b"not a video").is_err());
        assert!(!dir.join(VIDEOS_DIR).exists() || list_videos(&dir).is_empty());
        let first = save_video(&dir, &mp4()).unwrap();
        let second = save_video(&dir, &webm()).unwrap();
        assert_eq!(
            (first.short.as_str(), second.short.as_str()),
            ("videos/1.mp4", "videos/2.webm")
        );
        assert_eq!(list_videos(&dir).len(), 2);
        assert_eq!(find_video(&dir, "").unwrap().short, "videos/2.webm");
        assert_eq!(find_video(&dir, "1").unwrap().short, "videos/1.mp4");
        assert!(find_video(&dir, "9").is_err());
        assert!(check_session_dir(&home, &dir).is_ok());
        assert!(check_session_dir(&home, Path::new("/tmp/elsewhere")).is_err());
        assert!(check_session_dir(&home, &home.join("sessions/x/../../y")).is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    type Handler = dyn Fn(&str, &str, &str) -> (u16, Vec<u8>) + Send + Sync;

    /// A loopback HTTP server: `handler(method, path, body)` answers each
    /// request; every request line (with its authorization) is logged.
    struct Fake {
        base: String,
        port: u16,
        log: Arc<Mutex<Vec<String>>>,
    }

    fn fake(handler: Arc<Handler>) -> Fake {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Arc::new(Mutex::new(Vec::new()));
        let seen = log.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let handler = handler.clone();
                let seen = seen.clone();
                std::thread::spawn(move || {
                    stream
                        .set_read_timeout(Some(Duration::from_millis(2000)))
                        .unwrap();
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 65536];
                    let (head, body) = loop {
                        match stream.read(&mut buffer) {
                            Ok(0) | Err(_) => return,
                            Ok(count) => {
                                request.extend_from_slice(&buffer[..count]);
                                let text = String::from_utf8_lossy(&request).to_string();
                                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                                    let length = head
                                        .lines()
                                        .find_map(|line| {
                                            line.to_ascii_lowercase()
                                                .strip_prefix("content-length:")
                                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                                        })
                                        .unwrap_or(0);
                                    if body.len() >= length {
                                        break (head.to_string(), body.to_string());
                                    }
                                }
                            }
                        }
                    };
                    let first = head.lines().next().unwrap_or("").to_string();
                    let mut parts = first.split_whitespace();
                    let method = parts.next().unwrap_or("").to_string();
                    let path = parts.next().unwrap_or("").to_string();
                    let auth = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .starts_with("authorization:")
                                .then(|| line[14..].trim().to_string())
                        })
                        .unwrap_or_default();
                    seen.lock()
                        .unwrap()
                        .push(format!("{method} {path} [{auth}]"));
                    let (status, reply) = handler(&method, &path, &body);
                    let kind = if reply.first() == Some(&b'{') {
                        "application/json"
                    } else {
                        "application/octet-stream"
                    };
                    let head = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        reply.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(&reply);
                });
            }
        });
        Fake {
            base: format!("http://127.0.0.1:{port}"),
            port,
            log,
        }
    }

    fn json_reply(status: u16, value: Value) -> (u16, Vec<u8>) {
        (status, value.to_string().into_bytes())
    }

    fn xai_services(fake: &Fake, extra: &str) -> VideoServices {
        let config = XAI.replace("http://127.0.0.1:7/v1", &format!("{}/v1", fake.base))
            + "api_key = \"k-1\"\n"
            + extra;
        let services = load_services(&toml(&config), &env(&[]), None);
        assert!(services.enabled, "{services:?}");
        services
    }

    fn sdcpp_services(fake: &Fake, extra: &str) -> VideoServices {
        let config = SDCPP.replace("http://127.0.0.1:7", &fake.base) + extra;
        let services = load_services(&toml(&config), &env(&[]), None);
        assert!(services.enabled, "{services:?}");
        services
    }

    fn capabilities() -> Value {
        json!({
            "supported_modes": ["img_gen", "vid_gen"],
            "features_by_mode": { "vid_gen": { "init_image": true, "end_image": false, "cancel_queued": true, "cancel_generating": false } },
            "output_formats_by_mode": { "vid_gen": ["webm", "webp", "avi"] },
            "limits": { "min_width": 64, "max_width": 1024, "min_height": 64, "max_height": 1024 }
        })
    }

    #[test]
    fn an_xai_job_is_polled_downloaded_and_saved_with_its_record() {
        let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let port = Arc::new(std::sync::atomic::AtomicU16::new(0));
        let (p, q) = (polls.clone(), port.clone());
        let server = fake(Arc::new(
            move |method: &str, path: &str, body: &str| match (method, path) {
                ("POST", "/v1/videos/generations") => {
                    let sent: Value = serde_json::from_str(body).unwrap();
                    assert_eq!(sent["model"], "clip-model");
                    assert_eq!(sent["duration"], 10);
                    assert!(
                        sent["image"]["url"]
                            .as_str()
                            .unwrap()
                            .starts_with("data:image/png")
                    );
                    json_reply(200, json!({ "request_id": "req-1" }))
                }
                ("GET", "/v1/videos/req-1") => match p.fetch_add(1, Ordering::SeqCst) {
                    0 => (202, Vec::new()),
                    1 => json_reply(200, json!({ "status": "pending" })),
                    _ => json_reply(
                        200,
                        json!({ "status": "done", "video": { "url": format!("http://127.0.0.1:{}/files/out.mp4", q.load(Ordering::SeqCst)), "duration": 10 } }),
                    ),
                },
                ("GET", "/files/out.mp4") => (200, mp4()),
                _ => (500, b"unexpected".to_vec()),
            },
        ));
        port.store(server.port, Ordering::SeqCst);
        let services = xai_services(&server, "");
        let home = temp_home("xai-ok");
        let dir = session(&home);
        let mut job = i2v(&dir, &png_file(&home));
        job.duration = Some(10);
        job.call_id = Some("call/7".into());
        let flag = AtomicBool::new(false);
        let outcome = run_job(&services, &home, &home, &job, None, &flag).unwrap();
        assert_eq!(outcome.saved.short, "videos/1.mp4");
        assert_eq!(std::fs::read(&outcome.saved.path).unwrap(), mp4());
        let text = outcome.text();
        assert!(text.contains("Video saved to videos/1.mp4 (mp4"), "{text}");
        assert!(text.contains("remote job req-1"), "{text}");
        assert!(text.contains("resolution 480p (default)"), "{text}");
        assert!(text.contains("does not know its price"), "{text}");
        assert_eq!(outcome.json()["ok"], true);
        let record = record_for_call(&dir, "call/7").unwrap();
        assert_eq!(record.name, "call_7");
        assert_eq!(record.status, status::COMPLETED);
        assert_eq!(record.saved.as_deref(), Some("videos/1.mp4"));
        assert!(
            record
                .display_status()
                .starts_with("completed → videos/1.mp4")
        );
        let log = server.log.lock().unwrap().clone();
        assert!(
            log.iter().all(|line| line.ends_with("[Bearer k-1]")),
            "{log:?}"
        );
        assert_eq!(unsettled_jobs(&dir), 0);
        assert!(resume_notice(&dir).is_none());
        let listing = listing(&dir);
        assert!(listing.contains("Session videos (1)"), "{listing}");
        assert!(
            listing.contains("1. image_to_video \"the square drifts\" · 10s 480p"),
            "{listing}"
        );
        let _ = std::fs::remove_dir_all(home);
    }

    /// An xai fake whose start reply and status replies are fixed.
    fn xai_fake(start: (u16, Value), poll: (u16, Value), file: Vec<u8>) -> Fake {
        let start = Arc::new(start);
        let poll = Arc::new(poll);
        let port = Arc::new(std::sync::atomic::AtomicU16::new(0));
        let q = port.clone();
        let server = fake(Arc::new(move |method: &str, path: &str, _: &str| {
            let fix = |value: &Value| {
                value
                    .to_string()
                    .replace("PORT", &q.load(Ordering::SeqCst).to_string())
            };
            match (method, path) {
                ("POST", "/v1/videos/generations") => (start.0, fix(&start.1).into_bytes()),
                ("GET", p) if p.starts_with("/v1/videos/") => (poll.0, fix(&poll.1).into_bytes()),
                ("GET", "/files/out.bin") => (200, file.clone()),
                _ => (500, b"unexpected".to_vec()),
            }
        }));
        port.store(server.port, Ordering::SeqCst);
        server
    }

    #[test]
    fn every_failure_is_distinct_and_saves_nothing() {
        let started = (200, json!({ "request_id": "req-9" }));
        type Case<'a> = (
            &'a str,
            (u16, Value),
            (u16, Value),
            Vec<u8>,
            &'a str,
            &'a str,
        );
        let cases: Vec<Case> = vec![
            (
                "failed",
                started.clone(),
                (
                    200,
                    json!({ "status": "failed", "error": { "message": "content rejected" } }),
                ),
                vec![],
                status::FAILED,
                "failed on the service (remote job req-9): content rejected",
            ),
            (
                "expired",
                started.clone(),
                (200, json!({ "status": "expired" })),
                vec![],
                status::EXPIRED,
                "request expired (remote job req-9)",
            ),
            (
                "lost",
                started.clone(),
                (404, json!({ "error": { "message": "no such job" } })),
                vec![],
                status::LOST,
                "is gone",
            ),
            (
                "unpaid",
                (
                    402,
                    json!({ "error": { "message": "insufficient credits" } }),
                ),
                (200, json!({})),
                vec![],
                status::REFUSED,
                "asked for payment",
            ),
            (
                "poll-402",
                started.clone(),
                (402, json!({ "error": "pay" })),
                vec![],
                status::UNKNOWN,
                "outcome is unknown",
            ),
            (
                "no-id",
                (200, json!({ "id": "wrong-key" })),
                (200, json!({})),
                vec![],
                status::UNKNOWN,
                "No usable request_id",
            ),
            (
                "garbage",
                started.clone(),
                (
                    200,
                    json!({ "status": "done", "video": { "url": "http://127.0.0.1:PORT/files/out.bin" } }),
                ),
                b"<html>nope</html>".to_vec(),
                status::FAILED,
                "not an mp4, webm, avi, or animated webp",
            ),
            (
                "foreign-host",
                started.clone(),
                (
                    200,
                    json!({ "status": "done", "video": { "url": "http://localhost:PORT/files/out.bin" } }),
                ),
                mp4(),
                status::FAILED,
                "neither the configured service host",
            ),
            (
                "official-host",
                started.clone(),
                (
                    200,
                    json!({ "status": "done", "video": { "url": "https://vidgen.x.ai/out.mp4" } }),
                ),
                mp4(),
                status::FAILED,
                "official host",
            ),
        ];
        for (name, start, poll, file, state, needle) in cases {
            let server = xai_fake(start, poll, file);
            let services = xai_services(&server, "");
            let home = temp_home(name);
            let dir = session(&home);
            let job = i2v(&dir, &png_file(&home));
            let flag = AtomicBool::new(false);
            let error = run_job(&services, &home, &home, &job, None, &flag).unwrap_err();
            let text = error.to_string();
            assert!(text.contains(needle), "{name}: {text}");
            assert!(text.contains("aved"), "{name}: {text}");
            assert!(list_videos(&dir).is_empty(), "{name}");
            let jobs = list_jobs(&dir);
            assert_eq!(jobs.len(), 1, "{name}");
            assert_eq!(jobs[0].status, state, "{name}: {:?}", jobs[0]);
            if name == "foreign-host" {
                let log = server.log.lock().unwrap().clone();
                assert!(!log.iter().any(|line| line.contains("/files/")), "{log:?}");
            }
            let _ = std::fs::remove_dir_all(home);
        }
    }

    #[test]
    fn a_local_timeout_is_recoverable_by_asking_again_later() {
        let done = Arc::new(AtomicBool::new(false));
        let port = Arc::new(std::sync::atomic::AtomicU16::new(0));
        let (d, q) = (done.clone(), port.clone());
        let server = fake(Arc::new(move |method: &str, path: &str, _: &str| {
            match (method, path) {
                ("POST", "/v1/videos/generations") => {
                    json_reply(200, json!({ "request_id": "slow-1" }))
                }
                ("GET", "/v1/videos/slow-1") if d.load(Ordering::SeqCst) => json_reply(
                    200,
                    json!({ "status": "done", "video": { "url": format!("http://127.0.0.1:{}/v1/files/slow.mp4", q.load(Ordering::SeqCst)) } }),
                ),
                ("GET", "/v1/videos/slow-1") => json_reply(200, json!({ "status": "pending" })),
                ("GET", "/v1/files/slow.mp4") => (200, mp4()),
                _ => (500, Vec::new()),
            }
        }));
        port.store(server.port, Ordering::SeqCst);
        let services = xai_services(&server, "timeout_secs = 1\n");
        let home = temp_home("timeout");
        let dir = session(&home);
        let job = i2v(&dir, &png_file(&home));
        let flag = AtomicBool::new(false);
        let error = run_job(&services, &home, &home, &job, None, &flag).unwrap_err();
        assert!(matches!(error, VideoError::TimedOut(_)), "{error}");
        assert!(
            error.to_string().contains("may still be running"),
            "{error}"
        );
        assert!(list_videos(&dir).is_empty());
        let record = find_job(&dir, "").unwrap().1;
        assert_eq!(record.status, status::TIMED_OUT);
        assert!(record.followable());
        assert!(record.display_status().starts_with("timed out locally"));
        assert_eq!(unsettled_jobs(&dir), 1);
        assert!(
            resume_notice(&dir)
                .unwrap()
                .contains("1 video job of this session has no saved result yet")
        );
        let still = query_job(&services, &dir, "1", None).unwrap();
        assert!(still.contains("still pending"), "{still}");
        assert!(list_videos(&dir).is_empty());
        done.store(true, Ordering::SeqCst);
        let fetched = query_job(&services, &dir, "slow-1", None).unwrap();
        assert!(fetched.contains("saved videos/1.mp4"), "{fetched}");
        assert!(
            fetched.contains("recovered after the tool call ended"),
            "{fetched}"
        );
        let record = find_job(&dir, "1").unwrap().1;
        assert_eq!(record.status, status::COMPLETED);
        assert_eq!(unsettled_jobs(&dir), 0);
        let again = query_job(&services, &dir, "1", None).unwrap();
        assert!(again.contains("completed → videos/1.mp4"), "{again}");
        assert_eq!(list_videos(&dir).len(), 1);
        let other = load_services(
            &toml(&XAI.replace("127.0.0.1:7", "127.0.0.1:8")),
            &env(&[]),
            None,
        );
        let mut moved = record.clone();
        moved.status = status::TIMED_OUT.into();
        write_record(&dir, &moved).unwrap();
        let refused = query_job(&other, &dir, "1", None).unwrap_err();
        assert!(
            refused.contains("only asks the service a job was started on"),
            "{refused}"
        );
        let _ = std::fs::remove_dir_all(home);
    }

    /// An sdcpp fake: capabilities, a job that is queued, then generating,
    /// then `last` (completed or stays generating), and a cancel answer.
    fn sdcpp_fake(caps: Value, finish: bool, cancel: (u16, Value)) -> Fake {
        let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let caps = Arc::new(caps);
        let cancel = Arc::new(cancel);
        fake(Arc::new(
            move |method: &str, path: &str, body: &str| match (method, path) {
                ("GET", "/sdcpp/v1/capabilities") => json_reply(200, (*caps).clone()),
                ("POST", "/sdcpp/v1/vid_gen") => {
                    let sent: Value = serde_json::from_str(body).unwrap();
                    assert!(
                        sent["init_image"]
                            .as_str()
                            .unwrap()
                            .starts_with("data:image/png")
                    );
                    assert_eq!(sent["video_frames"], 8);
                    json_reply(
                        202,
                        json!({ "id": "job_1", "kind": "vid_gen", "status": "queued", "created": 1, "poll_url": "/sdcpp/v1/jobs/job_1" }),
                    )
                }
                ("GET", "/sdcpp/v1/jobs/job_1") => match polls.fetch_add(1, Ordering::SeqCst) {
                    0 => json_reply(
                        200,
                        json!({ "id": "job_1", "status": "queued", "queue_position": 1 }),
                    ),
                    1 => json_reply(
                        200,
                        json!({ "id": "job_1", "status": "generating", "queue_position": 0 }),
                    ),
                    _ if finish => json_reply(
                        200,
                        json!({ "id": "job_1", "status": "completed", "result": { "b64_json": base64::engine::general_purpose::STANDARD.encode(webm()), "mime_type": "video/webm", "output_format": "webm", "fps": 4, "frame_count": 9 } }),
                    ),
                    _ => json_reply(
                        200,
                        json!({ "id": "job_1", "status": "generating", "queue_position": 0 }),
                    ),
                },
                ("POST", "/sdcpp/v1/jobs/job_1/cancel") => json_reply(cancel.0, cancel.1.clone()),
                _ => (500, Vec::new()),
            },
        ))
    }

    #[test]
    fn an_sdcpp_job_checks_capabilities_then_saves_the_returned_video() {
        let server = sdcpp_fake(capabilities(), true, (200, json!({})));
        let services = sdcpp_services(&server, "");
        let home = temp_home("sdcpp-ok");
        let dir = session(&home);
        let mut job = i2v(&dir, &png_file(&home));
        job.duration = Some(2);
        job.call_id = Some("call-s".into());
        let flag = AtomicBool::new(false);
        let outcome = run_job(&services, &home, &home, &job, None, &flag).unwrap();
        assert_eq!(outcome.saved.short, "videos/1.webm");
        assert!(
            outcome.text().contains("9 frames @ 4 fps"),
            "{}",
            outcome.text()
        );
        assert!(outcome.text().contains("keyless"));
        let record = record_for_call(&dir, "call-s").unwrap();
        assert_eq!(
            (record.status.as_str(), record.frames),
            (status::COMPLETED, Some(9))
        );
        let log = server.log.lock().unwrap().clone();
        assert_eq!(log[0], "GET /sdcpp/v1/capabilities []");
        assert_eq!(log[1], "POST /sdcpp/v1/vid_gen []");

        let mut last = job.clone();
        last.tool = VideoTool::ReferenceToVideo;
        last.first_frame = last.image.take();
        last.last_frame = last.first_frame.clone();
        last.aspect_ratio = Some("1:1".into());
        last.call_id = None;
        let error = run_job(&services, &home, &home, &last, None, &flag).unwrap_err();
        assert!(error.to_string().contains("no end_image"), "{error}");

        let images_only = json!({ "supported_modes": ["img_gen"] });
        let server = sdcpp_fake(images_only, true, (200, json!({})));
        let services = sdcpp_services(&server, "");
        let error = run_job(&services, &home, &home, &job, None, &flag).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("does not support video generation (supported modes: img_gen)"),
            "{error}"
        );
        assert_eq!(server.log.lock().unwrap().len(), 1, "no job is started");
        let big = sdcpp_services(&sdcpp_fake(capabilities(), true, (200, json!({}))), "");
        let mut service = big.service.clone().unwrap();
        service.resolutions = vec!["2048p".into()];
        let mut huge = job.clone();
        huge.resolution = Some("2048p".into());
        let services = VideoServices {
            service: Some(service),
            ..big
        };
        let error = run_job(&services, &home, &home, &huge, None, &flag).unwrap_err();
        assert!(error.to_string().contains("outside what"), "{error}");
        assert_eq!(list_videos(&dir).len(), 1);
        let _ = std::fs::remove_dir_all(home);
    }

    fn cancel_after(ms: u64) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let setter = flag.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            setter.store(true, Ordering::SeqCst);
        });
        flag
    }

    #[test]
    fn ctrl_c_asks_the_service_to_cancel_and_says_what_it_answered() {
        let home = temp_home("cancel");
        let dir = session(&home);
        let image = png_file(&home);
        let mut job = i2v(&dir, &image);
        job.duration = Some(2);
        for (answer, cancel, needle) in [
            (
                (200, json!({ "id": "job_1", "status": "cancelled" })),
                "confirmed",
                "cancelled (the service confirmed it)",
            ),
            (
                (
                    409,
                    json!({ "error": { "code": "conflict", "message": "cannot be interrupted yet" } }),
                ),
                "refused",
                "refused to stop the job",
            ),
            (
                (200, json!({ "id": "job_1", "status": "completed" })),
                "already_finished",
                "had already finished",
            ),
        ] {
            let server = sdcpp_fake(capabilities(), false, answer);
            let services = sdcpp_services(&server, "");
            let flag = cancel_after(2500);
            let error = run_job(&services, &home, &home, &job, None, &flag).unwrap_err();
            assert!(error.is_cancel(), "{error}");
            assert!(error.to_string().contains("Nothing was saved"), "{error}");
            let record = find_job(&dir, "").unwrap().1;
            assert_eq!(record.cancel.as_deref(), Some(cancel), "{record:?}");
            assert!(
                record.display_status().contains(needle),
                "{}",
                record.display_status()
            );
            assert!(
                server
                    .log
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|line| line.starts_with("POST /sdcpp/v1/jobs/job_1/cancel"))
            );
        }
        assert!(list_videos(&dir).is_empty());

        let server = xai_fake(
            (200, json!({ "request_id": "req-c" })),
            (200, json!({ "status": "pending" })),
            vec![],
        );
        let services = xai_services(&server, "");
        let flag = cancel_after(300);
        let error = run_job(&services, &home, &home, &i2v(&dir, &image), None, &flag).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("may still finish (and be charged)"),
            "{error}"
        );
        let (number, record) = find_job(&dir, "").unwrap();
        assert_eq!(record.cancel.as_deref(), Some("not_supported"));
        assert!(record.followable());
        let listed = listing(&dir);
        assert!(
            listed.contains("stopped waiting; this service has no cancel request"),
            "{listed}"
        );
        let again = cancel_job(&services, &dir, &number.to_string(), None).unwrap();
        assert!(again.contains("no cancel request"), "{again}");
        assert!(list_videos(&dir).is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn interrupted_jobs_read_as_interrupted_and_can_be_cancelled_later() {
        let home = temp_home("interrupted");
        let dir = session(&home);
        let server = sdcpp_fake(
            capabilities(),
            false,
            (200, json!({ "id": "job_1", "status": "cancelled" })),
        );
        let services = sdcpp_services(&server, "");
        let record = JobRecord {
            version: 1,
            name: "call-z".into(),
            tool: I2V_TOOL.into(),
            prompt: "waves".into(),
            host: services.service.as_ref().unwrap().host(),
            protocol: "sdcpp".into(),
            duration: 2,
            resolution: "256p".into(),
            remote_id: Some("job_1".into()),
            status: status::GENERATING.into(),
            pid: Some(u32::MAX - 1),
            created: 5,
            ..JobRecord::default()
        };
        write_record(&dir, &record).unwrap();
        assert!(!record.runner_alive());
        assert!(
            record
                .display_status()
                .starts_with("interrupted: codsh stopped following it")
        );
        assert_eq!(unsettled_jobs(&dir), 1);
        let mut unsent = record.clone();
        unsent.name = "call-y".into();
        unsent.remote_id = None;
        unsent.status = status::SUBMITTING.into();
        unsent.created = 6;
        write_record(&dir, &unsent).unwrap();
        assert!(
            unsent
                .display_status()
                .contains("interrupted before the service answered")
        );
        assert_eq!(unsettled_jobs(&dir), 2);
        assert!(
            cancel_job(&services, &dir, "2", None)
                .unwrap()
                .contains("nothing codsh can cancel")
        );
        let text = cancel_job(&services, &dir, "1", None).unwrap();
        assert!(
            text.contains("confirmed remote job job_1 is cancelled"),
            "{text}"
        );
        assert_eq!(
            find_job(&dir, "call-z").unwrap().1.status,
            status::CANCELLED
        );
        assert_eq!(unsettled_jobs(&dir), 1);
        assert!(find_job(&dir, "7").unwrap_err().contains("has 2 jobs"));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn cards_progress_and_the_imagine_video_instruction() {
        let services = load_services(&toml(XAI), &env(&[]), None);
        let input = json!({ "prompt": "a cat\nnaps", "image": "[Image #1]", "duration": 10 });
        let title = card_title(I2V_TOOL, &input, &services).unwrap();
        assert_eq!(
            title,
            "Animate image (10s, default resolution) \"a cat naps\" via 127.0.0.1:7"
        );
        assert!(is_video_title(&title));
        let note = approval_note(&title, &input);
        assert!(
            note.contains("Starts one video job on 127.0.0.1:7 with the prompt and 1 image."),
            "{note}"
        );
        assert!(note.contains("codsh does not know its price"), "{note}");
        let input = json!({ "prompt": "duo", "images": ["a", "b"], "voices": ["ara"], "aspect_ratio": "16:9", "resolution_name": "720p", "first_frame": "c" });
        let title = card_title(R2V_TOOL, &input, &services).unwrap();
        assert_eq!(
            title,
            "Reference video (2 refs, first frame, 1 voice; default length, 720p, 16:9) \"duo\" via 127.0.0.1:7"
        );
        assert!(approval_note(&title, &input).contains("with the prompt and 3 images."));
        assert!(card_title("image_gen", &input, &services).is_none());
        let mut record = JobRecord {
            status: status::QUEUED.into(),
            remote_id: Some("r1".into()),
            queue_position: Some(2),
            ..JobRecord::default()
        };
        let line = progress_line(&title, Duration::from_secs(12), Some(&record));
        assert_eq!(
            line,
            "video: job r1 queued on 127.0.0.1:7 (position 2) · 12s elapsed · Ctrl+C cancels; nothing is saved until the video arrives"
        );
        record.status = status::DOWNLOADING.into();
        assert!(
            progress_line(&title, Duration::ZERO, Some(&record)).contains("downloading the video")
        );
        assert!(
            progress_line(&title, Duration::ZERO, None)
                .starts_with("video: starting a job on 127.0.0.1:7")
        );
        let instruction = imagine_video_instruction("a fox runs");
        assert!(instruction.starts_with("# Imagine Video"));
        assert!(instruction.ends_with("\n\nUser prompt: a fox runs"));
        assert_eq!(imagine_video_prompt_of(&instruction), Some("a fox runs"));
        assert_eq!(imagine_video_args("/imagine-video  a fox "), Some("a fox"));
        assert_eq!(imagine_video_args("/imagine-video"), Some(""));
        assert_eq!(imagine_video_args("/imagine a fox"), None);
        assert_eq!(job_name(Some("call 1/2")), "call_1_2");
        assert!(job_name(None).starts_with("job-"));
    }
}
