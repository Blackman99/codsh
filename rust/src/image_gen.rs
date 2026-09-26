//! Image generation and editing through an explicitly configured substitute
//! (ticket 55 / #187).
//!
//! The reference `image_gen` / `image_edit` tools (grok-build a28ee2b,
//! `implementations/grok_build/{image_gen,image_edit,storage}.rs`) post to
//! the official Imagine API with the signed-in account. codsh keeps their
//! model-facing contract (arguments, `[Image #N]` references, the saved
//! `<session folder>/images/<n>.<ext>` file and its short path, `/imagine`)
//! and sends the request only to the service named by `[models] image_gen`
//! (and optionally `[models] image_edit`). Nothing falls back to an official
//! host: an official base URL is a config error, a missing service leaves the
//! tools unregistered, and a service that answers with a URL instead of
//! image bytes is refused rather than fetched.
//!
//! Two wire formats are spoken. `xai` is the reference JSON body
//! (`aspect_ratio`, `resolution: "1k"`, data-URL references). `openai` is the
//! OpenAI Images shape many local servers implement (`size`, multipart
//! `image[]` edits), for example stable-diffusion.cpp `sd-server`.
//!
//! A result is written only after the whole response arrived and its bytes
//! are a png, jpeg, webp, or gif image: a temp file in the images folder is
//! fsynced and linked into place without replacing an existing file, so a
//! refusal, a malformed body, a cancel, or a crash leaves no numbered file.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{Value, json};
use toml::Value as TomlValue;

pub const IMAGE_GEN_TOOL: &str = "image_gen";
pub const IMAGE_EDIT_TOOL: &str = "image_edit";
pub const IMAGES_DIR: &str = "images";
/// The reference `image_edit` schema's supported values. `image_gen` takes the same set.
pub const ASPECT_RATIOS: &[&str] = &[
    "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5",
    "20:9", "9:20",
];
/// The reference waits up to 300 s: some services buffer the whole image first.
pub const DEFAULT_TIMEOUT_SECS: u64 = 300;
pub const DEFAULT_MAX_PARALLEL: u32 = 4;
pub const MAX_PARALLEL_LIMIT: u32 = 16;
pub const MAX_REFERENCES: usize = 5;
pub const MAX_REFERENCE_BYTES: usize = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;
/// Reference storage budget for one session's `images/` folder.
pub const IMAGES_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;
const DEFAULT_IMAGE_SIZE: u32 = 1024;
const USER_AGENT: &str = "codsh-rust-image/0.1";

pub const IMAGINE_USAGE: &str =
    "Usage: /imagine <description>\nProvide a text description to generate an image.";

/// The reference `/imagine` injection, byte for byte.
pub fn imagine_instruction(prompt: &str) -> String {
    format!(
        "Call the image_gen tool immediately, passing the user's prompt below verbatim — do not rewrite, embellish, or expand it. After the tool completes, briefly acknowledge and mention where the image was saved.\n\nPrompt: {prompt}"
    )
}

/// The prompt of a message built by [`imagine_instruction`], or None.
pub fn imagine_prompt_of(text: &str) -> Option<&str> {
    let marker = imagine_instruction("");
    text.strip_prefix(marker.as_str())
        .map(|rest| rest.lines().next().unwrap_or("").trim())
}

/// The arguments of an `/imagine` line (empty for a bare `/imagine`), or None.
pub fn imagine_args(text: &str) -> Option<&str> {
    let rest = text.trim().strip_prefix("/imagine")?;
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some(rest.trim())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageProtocol {
    Xai,
    Openai,
}

impl ImageProtocol {
    pub fn label(self) -> &'static str {
        match self {
            Self::Xai => "xai",
            Self::Openai => "openai",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "xai" | "imagine" => Some(Self::Xai),
            "openai" | "openai-images" | "openai_images" => Some(Self::Openai),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageService {
    pub id: String,
    /// The `model` value sent in the request body.
    pub model: String,
    pub base_url: String,
    pub protocol: ImageProtocol,
    pub env_key: Option<String>,
    /// Set only from a non-empty env value or inline `api_key`. Empty = keyless.
    pub api_key: String,
    /// Long edge in pixels for the `openai` `size` field.
    pub image_size: u32,
    pub timeout_secs: u64,
    pub supports_edit: bool,
}

impl ImageService {
    pub fn host(&self) -> String {
        url::Url::parse(&self.base_url)
            .ok()
            .and_then(|url| {
                url.host_str().map(|host| match url.port() {
                    Some(port) => format!("{host}:{port}"),
                    None => host.to_string(),
                })
            })
            .unwrap_or_else(|| "(invalid base_url)".into())
    }

    /// What an approval card and a result say about money. codsh does not
    /// know the price and never reports an unknown cost as free.
    pub fn cost_note(&self) -> String {
        let credential = if self.api_key.is_empty() {
            "keyless"
        } else {
            "with the configured key"
        };
        format!(
            "one request to {} ({credential}); codsh does not know its price, so any charge is set by that service",
            self.host()
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageServices {
    pub gen_service: Option<ImageService>,
    pub gen_service_source: String,
    pub edit_service: Option<ImageService>,
    pub edit_service_source: String,
    /// The `[models]` ids as written, kept for inspect when resolving fails.
    pub gen_service_id: Option<String>,
    pub edit_service_id: Option<String>,
    pub gen_enabled: bool,
    pub gen_enabled_source: String,
    pub edit_enabled: bool,
    pub edit_enabled_source: String,
    pub gen_model_override: Option<String>,
    pub gen_model_override_source: String,
    pub edit_model_override: Option<String>,
    pub edit_model_override_source: String,
    pub max_parallel: u32,
    pub max_parallel_source: String,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

impl ImageServices {
    pub fn disabled() -> Self {
        Self {
            gen_service: None,
            gen_service_source: "default".into(),
            edit_service: None,
            edit_service_source: "default".into(),
            gen_service_id: None,
            edit_service_id: None,
            gen_enabled: false,
            gen_enabled_source: "unconfigured".into(),
            edit_enabled: false,
            edit_enabled_source: "unconfigured".into(),
            gen_model_override: None,
            gen_model_override_source: "default".into(),
            edit_model_override: None,
            edit_model_override_source: "default".into(),
            max_parallel: DEFAULT_MAX_PARALLEL,
            max_parallel_source: "default".into(),
            warnings: Vec::new(),
            errors: Vec::new(),
        }
    }

    /// The service and request model one tool uses, when that tool is on.
    pub fn route(&self, kind: JobKind) -> Result<(ImageService, String), ImageError> {
        let (enabled, service, overridden, tool) = match kind {
            JobKind::Generate => (
                self.gen_enabled,
                self.gen_service.as_ref(),
                self.gen_model_override.as_ref(),
                IMAGE_GEN_TOOL,
            ),
            JobKind::Edit => (
                self.edit_enabled,
                self.edit_service.as_ref(),
                self.edit_model_override.as_ref(),
                IMAGE_EDIT_TOOL,
            ),
        };
        let Some(service) = service.filter(|_| enabled) else {
            return Err(ImageError::Disabled(tool));
        };
        let model = overridden.cloned().unwrap_or_else(|| service.model.clone());
        Ok((service.clone(), model))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobKind {
    Generate,
    Edit,
}

impl JobKind {
    pub fn tool(self) -> &'static str {
        match self {
            Self::Generate => IMAGE_GEN_TOOL,
            Self::Edit => IMAGE_EDIT_TOOL,
        }
    }

    fn verb(self) -> &'static str {
        match self {
            Self::Generate => "Image generation",
            Self::Edit => "Image edit",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageError {
    Disabled(&'static str),
    Invalid(String),
    Reference(String),
    /// The service answered with a non-success status or an explicit refusal.
    Refused {
        status: u16,
        message: String,
    },
    Malformed(String),
    Network(String),
    Storage(String),
    Cancelled,
}

impl std::fmt::Display for ImageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled(tool) => write!(
                formatter,
                "{tool} is not configured or is turned off. Set [models] {tool} to a [model.<id>] image service; no request was made and no file was saved."
            ),
            Self::Invalid(message) | Self::Reference(message) => {
                write!(
                    formatter,
                    "{message} No request was made and no file was saved."
                )
            }
            Self::Refused { status, message } => {
                write!(formatter, "{message} Nothing was saved.")?;
                if *status == 402 {
                    write!(
                        formatter,
                        " The service asked for payment; codsh never buys credits or retries a paid call."
                    )?;
                }
                Ok(())
            }
            Self::Malformed(message) => write!(formatter, "{message} Nothing was saved."),
            Self::Network(message) => write!(formatter, "{message} Nothing was saved."),
            Self::Storage(message) => write!(formatter, "{message}"),
            Self::Cancelled => write!(
                formatter,
                "cancelled before the image arrived; nothing was saved"
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// Configuration

#[cfg(test)]
fn load_services(
    table: &TomlValue,
    env: &BTreeMap<String, String>,
    requirements: Option<&TomlValue>,
) -> ImageServices {
    load_services_layered(table, table, env, requirements, None)
}

/// `[models] image_gen` / `image_edit` name `[model.<id>]` tables that say
/// `supports_image_generation = true` (and `supports_image_edit = true` for
/// edits). `features.image_gen` (requirements pin, GROK_IMAGE_GEN) can turn
/// generation off; `features.image_edit` is a requirements-only pin and
/// GROK_IMAGE_EDIT (default on) the user switch. A configured service is the
/// explicit opt-in: with none, neither tool exists.
pub fn load_services_layered(
    table: &TomlValue,
    user: &TomlValue,
    env: &BTreeMap<String, String>,
    requirements: Option<&TomlValue>,
    managed: Option<&TomlValue>,
) -> ImageServices {
    let mut services = ImageServices::disabled();
    let (gen_id, gen_source) = layered_string(
        requirements,
        managed,
        user,
        None,
        &["models", "image_gen"],
        true,
    );
    let (edit_id, edit_source) = layered_string(
        requirements,
        managed,
        user,
        None,
        &["models", "image_edit"],
        true,
    );
    let mut gen_errors = Vec::new();
    services.gen_service_id = gen_id.clone();
    services.edit_service_id = edit_id.clone();
    if let Some(id) = gen_id {
        services.gen_service = resolve_service(
            table,
            requirements,
            env,
            &id,
            JobKind::Generate,
            &mut gen_errors,
        );
        services.gen_service_source = gen_source;
    }
    let mut edit_errors = Vec::new();
    if let Some(id) = edit_id {
        services.edit_service = resolve_service(
            table,
            requirements,
            env,
            &id,
            JobKind::Edit,
            &mut edit_errors,
        );
        services.edit_service_source = edit_source;
    } else if let Some(service) = services.gen_service.as_ref().filter(|s| s.supports_edit) {
        services.edit_service = Some(service.clone());
        services.edit_service_source = "models.image_gen".into();
    }

    let (gen_flag, gen_flag_source) = layered_pin_bool(
        requirements,
        managed,
        user,
        env.get("GROK_IMAGE_GEN"),
        &["features", "image_gen"],
    );
    services.gen_enabled =
        services.gen_service.is_some() && gen_flag != Some(false) && gen_errors.is_empty();
    services.gen_enabled_source = if gen_flag == Some(false) {
        gen_flag_source
    } else if services.gen_enabled {
        services.gen_service_source.clone()
    } else if !gen_errors.is_empty() {
        "invalid".into()
    } else {
        "unconfigured".into()
    };
    if services.gen_service.is_none() && gen_flag == Some(true) && gen_errors.is_empty() {
        services.warnings.push(
            "features.image_gen is on but [models] image_gen names no image service; image_gen stays off (no hidden default service)."
                .into(),
        );
    }

    if bool_at(Some(user), &["features", "image_edit"]).is_some() {
        services.warnings.push(
            "features.image_edit is a requirements-only pin; the config.toml entry is ignored (use GROK_IMAGE_EDIT or [models] image_edit)."
                .into(),
        );
    }
    let (edit_flag, edit_flag_source) =
        if let Some(value) = bool_at(requirements, &["features", "image_edit"]) {
            (value, "requirements".to_string())
        } else if let Some(value) = env_flag(env.get("GROK_IMAGE_EDIT")) {
            (value, "environment".to_string())
        } else {
            (true, "default".to_string())
        };
    services.edit_enabled = services.edit_service.is_some() && edit_flag && edit_errors.is_empty();
    services.edit_enabled_source = if !edit_flag {
        edit_flag_source
    } else if services.edit_enabled {
        services.edit_service_source.clone()
    } else if !edit_errors.is_empty() {
        "invalid".into()
    } else {
        "unconfigured".into()
    };

    let (gen_override, gen_override_source) = layered_string(
        requirements,
        managed,
        user,
        env.get("GROK_IMAGE_GEN_MODEL_OVERRIDE"),
        &["features", "image_gen_model_override"],
        false,
    );
    services.gen_model_override = gen_override;
    services.gen_model_override_source = gen_override_source;
    let (edit_override, edit_override_source) = layered_string(
        requirements,
        managed,
        user,
        env.get("GROK_IMAGE_EDIT_MODEL_OVERRIDE"),
        &["features", "image_edit_model_override"],
        false,
    );
    services.edit_model_override = edit_override;
    services.edit_model_override_source = edit_override_source;

    let path = ["tools", "media_gen", "max_parallel_image_gen_calls"];
    let raw = if let Some(value) = walk(user, &path) {
        Some((value.clone(), "config.toml"))
    } else if let Some(value) = env
        .get("GROK_MAX_PARALLEL_IMAGE_GEN_CALLS")
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
                "tools.media_gen.max_parallel_image_gen_calls must be an integer from 1 to {MAX_PARALLEL_LIMIT} (from {source})"
            )),
        }
    }
    services.errors.extend(gen_errors);
    for error in edit_errors {
        if !services.errors.contains(&error) {
            services.errors.push(error);
        }
    }
    services
}

fn resolve_service(
    table: &TomlValue,
    requirements: Option<&TomlValue>,
    env: &BTreeMap<String, String>,
    id: &str,
    kind: JobKind,
    errors: &mut Vec<String>,
) -> Option<ImageService> {
    let key = kind.tool();
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
            "[models] {key} = {id:?} has no [model.{id}] table; image requests stay off."
        ));
        return None;
    };
    let Some(base_url) = string_at(spec, &["base_url"]) else {
        errors.push(format!(
            "[model.{id}] has no base_url; set the image service endpoint explicitly."
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
            "image service destination refused: [model.{id}] base_url {base_url} is an official host. Configure a substitute image service; the official Imagine account is not used."
        ));
        return None;
    }
    let protocol = match string_at(spec, &["protocol"]) {
        None => ImageProtocol::Xai,
        Some(raw) => match ImageProtocol::parse(&raw) {
            Some(protocol) => protocol,
            None => {
                errors.push(format!(
                    "[model.{id}] protocol {raw:?} is not an image protocol. Use \"xai\" or \"openai\"."
                ));
                return None;
            }
        },
    };
    let generation = bool_at_value(spec, &["supports_image_generation"]).unwrap_or(false);
    let edit = bool_at_value(spec, &["supports_image_edit"]).unwrap_or(false);
    match kind {
        JobKind::Generate if !generation => {
            errors.push(format!(
                "[model.{id}] is not marked supports_image_generation = true; a chat model is not used as an image service."
            ));
            return None;
        }
        JobKind::Edit if !edit => {
            errors.push(format!(
                "[model.{id}] is not marked supports_image_edit = true; image_edit stays off."
            ));
            return None;
        }
        _ => {}
    }
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
            "[model.{id}] names env_key {name} but it is empty; the image service is not called without it."
        ));
        return None;
    }
    let image_size = match walk(spec, &["image_size"]) {
        None => DEFAULT_IMAGE_SIZE,
        Some(TomlValue::Integer(number)) if (64..=4096).contains(number) => *number as u32,
        Some(_) => {
            errors.push(format!(
                "[model.{id}] image_size must be an integer from 64 to 4096."
            ));
            return None;
        }
    };
    let timeout_secs = match walk(spec, &["timeout_secs"]) {
        None => DEFAULT_TIMEOUT_SECS,
        Some(TomlValue::Integer(number)) if (1..=3600).contains(number) => *number as u64,
        Some(_) => {
            errors.push(format!(
                "[model.{id}] timeout_secs must be an integer from 1 to 3600."
            ));
            return None;
        }
    };
    Some(ImageService {
        id: id.to_string(),
        model: string_at(spec, &["model"]).unwrap_or_else(|| id.to_string()),
        base_url,
        protocol,
        env_key,
        api_key,
        image_size,
        timeout_secs,
        supports_edit: edit,
    })
}

pub fn inspect_rows(services: &ImageServices) -> Vec<(&'static str, String, String)> {
    let service_value = |service: Option<&ImageService>, id: Option<&String>| match (service, id) {
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
    vec![
        (
            "models.image_gen",
            service_value(
                services.gen_service.as_ref(),
                services.gen_service_id.as_ref(),
            ),
            services.gen_service_source.clone(),
        ),
        (
            "models.image_edit",
            service_value(
                services.edit_service.as_ref(),
                services.edit_service_id.as_ref(),
            ),
            services.edit_service_source.clone(),
        ),
        (
            "features.image_gen",
            services.gen_enabled.to_string(),
            services.gen_enabled_source.clone(),
        ),
        (
            "features.image_edit",
            services.edit_enabled.to_string(),
            services.edit_enabled_source.clone(),
        ),
        (
            "features.image_gen_model_override",
            services
                .gen_model_override
                .clone()
                .unwrap_or_else(|| "unset".into()),
            services.gen_model_override_source.clone(),
        ),
        (
            "features.image_edit_model_override",
            services
                .edit_model_override
                .clone()
                .unwrap_or_else(|| "unset".into()),
            services.edit_model_override_source.clone(),
        ),
        (
            "tools.media_gen.max_parallel_image_gen_calls",
            services.max_parallel.to_string(),
            services.max_parallel_source.clone(),
        ),
    ]
}

pub fn disclosure(services: &ImageServices) -> String {
    let line = |label: &str, enabled: bool, service: Option<&ImageService>| match service {
        Some(service) if enabled => format!("{label}: {}", service.cost_note()),
        _ => format!("{label}: off; no request is made"),
    };
    format!(
        "{} · {}",
        line(
            "image_gen",
            services.gen_enabled,
            services.gen_service.as_ref()
        ),
        line(
            "image_edit",
            services.edit_enabled,
            services.edit_service.as_ref()
        )
    )
}

pub fn inspect_json(services: &ImageServices) -> Value {
    let service = |service: Option<&ImageService>| {
        service.map(|service| {
            json!({
                "id": service.id,
                "model": service.model,
                "protocol": service.protocol.label(),
                "host": service.host(),
                "keyless": service.api_key.is_empty(),
            })
        })
    };
    json!({
        "imageGenEnabled": services.gen_enabled,
        "imageEditEnabled": services.edit_enabled,
        "generationService": service(services.gen_service.as_ref()),
        "editService": service(services.edit_service.as_ref()),
        "maxParallelCalls": services.max_parallel,
        "disclosure": disclosure(services),
    })
}

/// What the dsh plugin needs: which tools exist, the parallel cap, and the
/// host for the approval card. Policy and credentials stay in the command.
pub fn dsh_env(services: &ImageServices) -> Vec<(String, String)> {
    let flag = |on: bool| if on { "1" } else { "0" }.to_string();
    let mut extra = vec![
        ("CODSH_IMAGE_GEN".into(), flag(services.gen_enabled)),
        ("CODSH_IMAGE_EDIT".into(), flag(services.edit_enabled)),
        (
            "CODSH_IMAGE_MAX_PARALLEL".into(),
            services.max_parallel.to_string(),
        ),
    ];
    if services.gen_enabled
        && let Some(service) = services.gen_service.as_ref()
    {
        extra.push(("CODSH_IMAGE_GEN_HOST".into(), service.host()));
    }
    if services.edit_enabled
        && let Some(service) = services.edit_service.as_ref()
    {
        extra.push(("CODSH_IMAGE_EDIT_HOST".into(), service.host()));
    }
    extra
}

// ---------------------------------------------------------------------------
// Requests

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    pub label: String,
    pub bytes: Vec<u8>,
    pub media_type: &'static str,
}

impl Reference {
    fn data_url(&self) -> String {
        format!(
            "data:{};base64,{}",
            self.media_type,
            base64::engine::general_purpose::STANDARD.encode(&self.bytes)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub kind: JobKind,
    pub prompt: String,
    pub aspect_ratio: String,
    pub images: Vec<String>,
    pub session_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub url: String,
    pub content_type: String,
    pub body: Vec<u8>,
}

/// `[Image #1]`, `Image #1`, `image #1`, or `#1`. The reference's parser.
pub fn parse_attachment_token(value: &str) -> Option<usize> {
    let trimmed = value.trim();
    let inner = trimmed
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(trimmed)
        .trim();
    let rest = match inner.get(..5).map(str::to_ascii_lowercase).as_deref() {
        Some("image") => inner.get(5..)?.trim_start(),
        _ => inner,
    };
    let digits = rest.strip_prefix('#')?.trim();
    match digits.parse::<usize>() {
        Ok(n) if n >= 1 => Some(n),
        _ => None,
    }
}

pub fn validate_job(job: &Job) -> Result<(), ImageError> {
    if job.prompt.trim().is_empty() {
        return Err(ImageError::Invalid(format!(
            "{} needs a non-empty prompt.",
            job.kind.tool()
        )));
    }
    if !ASPECT_RATIOS.contains(&job.aspect_ratio.as_str()) {
        return Err(ImageError::Invalid(format!(
            "aspect_ratio {:?} is not supported. Use one of: {}.",
            job.aspect_ratio,
            ASPECT_RATIOS.join(", ")
        )));
    }
    match job.kind {
        JobKind::Generate if !job.images.is_empty() => Err(ImageError::Invalid(
            "image_gen takes no reference images; use image_edit.".into(),
        )),
        JobKind::Edit if job.images.is_empty() => Err(ImageError::Invalid(
            "image_edit requires at least one reference image. Use image_gen for text-only generation."
                .into(),
        )),
        JobKind::Edit if job.images.len() > MAX_REFERENCES => Err(ImageError::Invalid(format!(
            "image_edit accepts at most {MAX_REFERENCES} reference images."
        ))),
        _ => Ok(()),
    }
}

/// A data URL, `file://` path, or filesystem path (relative to `cwd`) to
/// validated image bytes. `[Image #N]` is resolved by the dsh plugin from the
/// current message; one that reaches here matched nothing.
pub fn resolve_reference(raw: &str, cwd: &Path) -> Result<Reference, ImageError> {
    let value = raw.trim();
    if parse_attachment_token(value).is_some() {
        return Err(ImageError::Reference(format!(
            "image reference {value:?} matches no image attached to this message. If it was attached earlier, ask the user to re-attach it here; otherwise pass an absolute filesystem path or a data: URL."
        )));
    }
    let (bytes, label) = if let Some(rest) = value.strip_prefix("data:") {
        let Some((header, payload)) = rest.split_once(',') else {
            return Err(ImageError::Reference(
                "malformed data URL in image reference.".into(),
            ));
        };
        if !header.starts_with("image/") {
            return Err(ImageError::Reference(
                "image references only accept data:image/... URLs.".into(),
            ));
        }
        if !header.contains(";base64") {
            return Err(ImageError::Reference(
                "image references only support base64 data URLs.".into(),
            ));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .map_err(|error| {
                ImageError::Reference(format!("invalid base64 in image reference: {error}."))
            })?;
        (bytes, "data URL".to_string())
    } else {
        let path_text = value.strip_prefix("file://").unwrap_or(value);
        if path_text.is_empty() {
            return Err(ImageError::Reference("empty image reference.".into()));
        }
        let path = if Path::new(path_text).is_absolute() {
            PathBuf::from(path_text)
        } else {
            cwd.join(path_text)
        };
        let metadata = std::fs::metadata(&path).map_err(|error| {
            ImageError::Reference(format!(
                "image reference not readable: {} ({error}).",
                path.display()
            ))
        })?;
        if !metadata.is_file() {
            return Err(ImageError::Reference(format!(
                "image reference {} is not a file.",
                path.display()
            )));
        }
        if metadata.len() > MAX_REFERENCE_BYTES as u64 {
            return Err(ImageError::Reference(format!(
                "image reference {} is larger than {} MiB.",
                path.display(),
                MAX_REFERENCE_BYTES / (1024 * 1024)
            )));
        }
        let bytes = std::fs::read(&path).map_err(|error| {
            ImageError::Reference(format!(
                "image reference not readable: {} ({error}).",
                path.display()
            ))
        })?;
        (bytes, path.display().to_string())
    };
    if bytes.is_empty() {
        return Err(ImageError::Reference(format!(
            "image reference {label} contained no data."
        )));
    }
    if bytes.len() > MAX_REFERENCE_BYTES {
        return Err(ImageError::Reference(format!(
            "image reference {label} is larger than {} MiB.",
            MAX_REFERENCE_BYTES / (1024 * 1024)
        )));
    }
    let Some((media_type, _, _)) = crate::images::identify(&bytes) else {
        return Err(ImageError::Reference(format!(
            "image reference {label} is not a png, jpeg, webp, or gif image."
        )));
    };
    Ok(Reference {
        label,
        bytes,
        media_type,
    })
}

/// `size` for the `openai` protocol: the long edge is `image_size`, the short
/// edge follows the ratio, and both are multiples of 64 (at least 64).
pub fn openai_size(aspect_ratio: &str, long_edge: u32) -> String {
    let (w, h) = aspect_ratio
        .split_once(':')
        .and_then(|(w, h)| Some((w.parse::<f64>().ok()?, h.parse::<f64>().ok()?)))
        .filter(|(w, h)| *w > 0.0 && *h > 0.0)
        .unwrap_or((1.0, 1.0));
    let round = |value: f64| -> u32 { (((value / 64.0).round() as u32).max(1)) * 64 };
    let long = round(long_edge as f64);
    let (width, height) = if w >= h {
        (long, round(long as f64 * h / w))
    } else {
        (round(long as f64 * w / h), long)
    };
    format!("{width}x{height}")
}

fn endpoint(service: &ImageService, path: &str) -> String {
    format!("{}/{path}", service.base_url.trim_end_matches('/'))
}

pub fn build_request(
    service: &ImageService,
    model: &str,
    job: &Job,
    references: &[Reference],
) -> HttpRequest {
    match (job.kind, service.protocol) {
        (JobKind::Generate, ImageProtocol::Xai) => json_request(
            endpoint(service, "images/generations"),
            json!({
                "model": model,
                "prompt": job.prompt,
                "n": 1,
                "aspect_ratio": job.aspect_ratio,
                "resolution": "1k",
                "response_format": "b64_json",
            }),
        ),
        (JobKind::Generate, ImageProtocol::Openai) => json_request(
            endpoint(service, "images/generations"),
            json!({
                "model": model,
                "prompt": job.prompt,
                "n": 1,
                "size": openai_size(&job.aspect_ratio, service.image_size),
                "response_format": "b64_json",
            }),
        ),
        (JobKind::Edit, ImageProtocol::Xai) => {
            let mut body = json!({
                "model": model,
                "prompt": job.prompt,
                "n": 1,
                "resolution": "1k",
                "response_format": "b64_json",
            });
            let mut images: Vec<Value> = references
                .iter()
                .map(|reference| json!({ "url": reference.data_url() }))
                .collect();
            if let Some(object) = body.as_object_mut() {
                // Reference: one image is an object and the service keeps its
                // ratio; several are an array with an explicit ratio.
                if images.len() == 1 {
                    object.insert("image".into(), images.pop().unwrap_or(Value::Null));
                } else {
                    object.insert("images".into(), Value::Array(images));
                    object.insert("aspect_ratio".into(), json!(job.aspect_ratio));
                }
            }
            json_request(endpoint(service, "images/edits"), body)
        }
        (JobKind::Edit, ImageProtocol::Openai) => {
            let boundary = format!("codsh-image-{}", random_hex());
            let mut body = Vec::new();
            let mut field = |name: &str, value: &str| {
                body.extend_from_slice(
                    format!(
                        "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
                    )
                    .as_bytes(),
                );
            };
            field("model", model);
            field("prompt", &job.prompt);
            field("n", "1");
            field("response_format", "b64_json");
            if job.aspect_ratio != "auto" || references.len() > 1 {
                field("size", &openai_size(&job.aspect_ratio, service.image_size));
            }
            for (index, reference) in references.iter().enumerate() {
                body.extend_from_slice(
                    format!(
                        "--{boundary}\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"reference-{}.{}\"\r\nContent-Type: {}\r\n\r\n",
                        index + 1,
                        crate::images::extension_for(reference.media_type),
                        reference.media_type
                    )
                    .as_bytes(),
                );
                body.extend_from_slice(&reference.bytes);
                body.extend_from_slice(b"\r\n");
            }
            body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
            HttpRequest {
                url: endpoint(service, "images/edits"),
                content_type: format!("multipart/form-data; boundary={boundary}"),
                body,
            }
        }
    }
}

fn json_request(url: String, body: Value) -> HttpRequest {
    HttpRequest {
        url,
        content_type: "application/json".into(),
        body: body.to_string().into_bytes(),
    }
}

fn random_hex() -> String {
    let mut bytes = [0u8; 12];
    if getrandom::fill(&mut bytes).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        bytes[..8].copy_from_slice(&(nanos as u64).to_le_bytes());
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The service's answer to image bytes. Only `data[0].b64_json` counts: a
/// URL would be a destination nobody configured, so it is refused.
pub fn parse_response(kind: JobKind, status: u16, body: &[u8]) -> Result<Vec<u8>, ImageError> {
    let text = String::from_utf8_lossy(body);
    if !(200..300).contains(&status) {
        let truncated: String = text.chars().take(200).collect();
        return Err(ImageError::Refused {
            status,
            message: format!("{} failed with HTTP {status}: {truncated}", kind.verb()),
        });
    }
    let parsed: Value = serde_json::from_slice(body).map_err(|error| {
        let preview: String = text.chars().take(200).collect();
        ImageError::Malformed(format!(
            "Failed to parse {} response: {error} — body preview: {preview}",
            kind.verb().to_ascii_lowercase()
        ))
    })?;
    if let Some(error) = parsed.get("error").filter(|value| !value.is_null()) {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| match error {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            });
        let truncated: String = message.chars().take(200).collect();
        return Err(ImageError::Refused {
            status,
            message: format!("{} was refused by the service: {truncated}", kind.verb()),
        });
    }
    let first = parsed
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first());
    let b64 = first
        .and_then(|item| item.get("b64_json"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if b64.is_empty() {
        if first.and_then(|item| item.get("url")).is_some() {
            return Err(ImageError::Malformed(format!(
                "{} returned a URL instead of b64_json image data; codsh does not fetch a destination nobody configured.",
                kind.verb()
            )));
        }
        return Err(ImageError::Malformed(format!(
            "{} returned no image data.",
            kind.verb()
        )));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|error| {
            ImageError::Malformed(format!("Failed to decode base64 image data: {error}."))
        })?;
    if crate::images::identify(&bytes).is_none() {
        return Err(ImageError::Malformed(format!(
            "{} returned data that is not a png, jpeg, webp, or gif image.",
            kind.verb()
        )));
    }
    Ok(bytes)
}

/// One POST. The call runs on a worker so a cancel flag is honoured while the
/// service is still working; the process exits on cancel and the half-read
/// response is dropped with it.
pub fn send(
    service: &ImageService,
    request: HttpRequest,
    kind: JobKind,
    extra_ca: Option<PathBuf>,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, ImageError> {
    let (agent, _) = crate::extra_ca::agent(extra_ca.as_deref())
        .map_err(|error| ImageError::Network(format!("TLS setup failed: {error}.")))?;
    let host = service.host();
    let timeout = Duration::from_secs(service.timeout_secs);
    let api_key = service.api_key.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut call = agent
            .post(&request.url)
            .timeout(timeout)
            .set("content-type", &request.content_type)
            .set("accept", "application/json")
            .set("user-agent", USER_AGENT);
        if !api_key.is_empty() {
            call = call.set("authorization", &format!("Bearer {api_key}"));
        }
        let outcome = match call.send_bytes(&request.body) {
            Ok(response) => read_body(response).map(|body| (200u16, body)),
            Err(ureq::Error::Status(status, response)) => {
                read_body(response).map(|body| (status, body))
            }
            Err(ureq::Error::Transport(error)) => Err(error.to_string()),
        };
        let _ = sender.send(outcome);
    });
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(ImageError::Cancelled);
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok((status, body))) => {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(ImageError::Cancelled);
                }
                return parse_response(kind, status, &body);
            }
            Ok(Err(error)) => {
                return Err(ImageError::Network(format!(
                    "{} request to {host} failed: {error}.",
                    kind.verb()
                )));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(ImageError::Network(format!(
                    "{} request to {host} ended without a response.",
                    kind.verb()
                )));
            }
        }
    }
}

fn read_body(response: ureq::Response) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    response
        .into_reader()
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|error| error.to_string())?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(format!(
            "response is larger than {} MiB",
            MAX_RESPONSE_BYTES / (1024 * 1024)
        ));
    }
    Ok(body)
}

// ---------------------------------------------------------------------------
// Storage

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedImage {
    pub path: PathBuf,
    pub short: String,
    pub media_type: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub bytes: u64,
}

impl SavedImage {
    pub fn summary(&self) -> String {
        let size = match (self.width, self.height) {
            (Some(width), Some(height)) => format!("{width}x{height} "),
            _ => String::new(),
        };
        format!(
            "{} ({size}{}, {})",
            self.short,
            self.media_type.trim_start_matches("image/"),
            human_bytes(self.bytes)
        )
    }
}

pub fn human_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// The session folder must be `$GROK_HOME/sessions/<encoded cwd>/<id>`; a
/// tool call cannot point the writer anywhere else.
pub fn check_session_dir(grok_home: &Path, session_dir: &Path) -> Result<(), ImageError> {
    let root = grok_home.join("sessions");
    let inside = session_dir.is_absolute()
        && session_dir.starts_with(&root)
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
        Err(ImageError::Storage(format!(
            "session folder {} is not a session under {}; nothing was saved.",
            session_dir.display(),
            root.display()
        )))
    }
}

fn numbered(name: &str) -> Option<u32> {
    let (stem, ext) = name.rsplit_once('.')?;
    if !matches!(ext, "jpg" | "png" | "webp" | "gif") {
        return None;
    }
    stem.parse::<u32>().ok().filter(|n| *n > 0)
}

/// `images/<n>.<ext>` in number order.
pub fn list_images(session_dir: &Path) -> Vec<SavedImage> {
    let dir = session_dir.join(IMAGES_DIR);
    let mut found: Vec<(u32, SavedImage)> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let number = numbered(&name)?;
            let path = entry.path();
            let metadata = entry.metadata().ok().filter(|meta| meta.is_file())?;
            let mut head = vec![0u8; 64 * 1024];
            let read = std::fs::File::open(&path)
                .and_then(|mut file| file.read(&mut head))
                .unwrap_or(0);
            head.truncate(read);
            let (media_type, width, height) =
                crate::images::identify(&head).unwrap_or(("unknown", None, None));
            Some((
                number,
                SavedImage {
                    short: format!("{IMAGES_DIR}/{name}"),
                    path,
                    media_type: media_type.to_string(),
                    width,
                    height,
                    bytes: metadata.len(),
                },
            ))
        })
        .collect();
    found.sort_by_key(|(number, _)| *number);
    found.into_iter().map(|(_, image)| image).collect()
}

/// Atomic save: the temp file is fsynced, then hard-linked to the next free
/// number (never replacing a file, so parallel calls cannot overwrite each
/// other) and removed. Orphan temp files from an interrupted save go first.
pub fn save_image(session_dir: &Path, bytes: &[u8]) -> Result<SavedImage, ImageError> {
    let Some((media_type, width, height)) = crate::images::identify(bytes) else {
        return Err(ImageError::Malformed(
            "refusing to save bytes that are not an image.".into(),
        ));
    };
    let dir = session_dir.join(IMAGES_DIR);
    let storage = |error: std::io::Error| {
        ImageError::Storage(format!(
            "could not save the image under {}: {error}; no file was kept.",
            dir.display()
        ))
    };
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(storage)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
                .map_err(storage)?;
        }
    }
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
    if total + bytes.len() as u64 > IMAGES_BUDGET_BYTES {
        return Err(ImageError::Storage(format!(
            "this session's images folder would exceed {}; nothing was saved.",
            human_bytes(IMAGES_BUDGET_BYTES)
        )));
    }
    let mut temp = tempfile::Builder::new()
        .prefix(".tmp")
        .tempfile_in(&dir)
        .map_err(storage)?;
    temp.write_all(bytes).map_err(storage)?;
    temp.as_file().sync_all().map_err(storage)?;
    let ext = crate::images::extension_for(media_type);
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
                return Ok(SavedImage {
                    path: target,
                    short: format!("{IMAGES_DIR}/{name}"),
                    media_type: media_type.to_string(),
                    width,
                    height,
                    bytes: bytes.len() as u64,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => number += 1,
            Err(error) => return Err(storage(error)),
        }
        if number > max + 10_000 {
            return Err(ImageError::Storage(
                "no free image number in this session; nothing was saved.".into(),
            ));
        }
    }
}

// ---------------------------------------------------------------------------
// Running one job

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub saved: SavedImage,
    pub service: ImageService,
    pub model: String,
    pub references: usize,
    pub elapsed_ms: u128,
}

impl Outcome {
    pub fn text(&self, kind: JobKind) -> String {
        let action = match kind {
            JobKind::Generate => "Generated",
            JobKind::Edit => "Edited",
        };
        let refs = if self.references > 0 {
            format!(
                " from {} reference image{}",
                self.references,
                if self.references == 1 { "" } else { "s" }
            )
        } else {
            String::new()
        };
        format!(
            "{action} image{refs}: saved {}\nPath: {}\nService: {} · model {} · {:.1}s\nCost: {}",
            self.saved.summary(),
            self.saved.path.display(),
            self.service.host(),
            self.model,
            self.elapsed_ms as f64 / 1000.0,
            self.service.cost_note()
        )
    }

    pub fn json(&self, kind: JobKind) -> Value {
        json!({
            "ok": true,
            "tool": kind.tool(),
            "path": self.saved.path.display().to_string(),
            "short": self.saved.short,
            "mediaType": self.saved.media_type,
            "width": self.saved.width,
            "height": self.saved.height,
            "bytes": self.saved.bytes,
            "service": self.service.host(),
            "model": self.model,
            "protocol": self.service.protocol.label(),
            "references": self.references,
            "elapsedMs": self.elapsed_ms as u64,
            "cost": self.service.cost_note(),
            "text": self.text(kind),
        })
    }
}

pub fn run_job(
    services: &ImageServices,
    grok_home: &Path,
    cwd: &Path,
    job: &Job,
    extra_ca: Option<PathBuf>,
    cancelled: &AtomicBool,
) -> Result<Outcome, ImageError> {
    let (service, model) = services.route(job.kind)?;
    validate_job(job)?;
    check_session_dir(grok_home, &job.session_dir)?;
    let references = job
        .images
        .iter()
        .map(|raw| resolve_reference(raw, cwd))
        .collect::<Result<Vec<_>, _>>()?;
    let request = build_request(&service, &model, job, &references);
    let started = Instant::now();
    let bytes = send(&service, request, job.kind, extra_ca, cancelled)?;
    if cancelled.load(Ordering::Relaxed) {
        return Err(ImageError::Cancelled);
    }
    let saved = save_image(&job.session_dir, &bytes)?;
    Ok(Outcome {
        saved,
        service,
        model,
        references: references.len(),
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// SIGINT/SIGTERM set the flag; the plugin sends SIGTERM when dsh aborts.
pub fn cancel_flag() -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    {
        for signal in [signal_hook::consts::SIGINT, signal_hook::consts::SIGTERM] {
            let hooked = flag.clone();
            let _ = unsafe {
                signal_hook::low_level::register(signal, move || {
                    hooked.store(true, Ordering::Relaxed);
                })
            };
        }
    }
    flag
}

// ---------------------------------------------------------------------------
// Session view: listing, opening, progress

/// `images/<n>.<ext>`, `<n>`, or nothing (the latest) to one saved file.
pub fn find_image(session_dir: &Path, which: &str) -> Result<SavedImage, String> {
    let images = list_images(session_dir);
    let which = which.trim();
    if images.is_empty() {
        return Err(format!(
            "no images saved in this session yet ({})",
            session_dir.join(IMAGES_DIR).display()
        ));
    }
    if which.is_empty() {
        return Ok(images.last().cloned().unwrap_or_else(|| images[0].clone()));
    }
    let wanted = which.trim_start_matches("images/");
    images
        .iter()
        .find(|image| {
            let name = image.short.trim_start_matches("images/");
            name == wanted || name.split('.').next() == Some(wanted)
        })
        .cloned()
        .ok_or_else(|| {
            format!(
                "{which} is not an image of this session; saved: {}",
                images
                    .iter()
                    .map(|image| image.short.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

pub fn listing(session_dir: &Path) -> String {
    let images = list_images(session_dir);
    if images.is_empty() {
        return format!(
            "No images saved in this session yet. image_gen / image_edit results go to {}.",
            session_dir.join(IMAGES_DIR).display()
        );
    }
    let mut lines = vec![format!(
        "Session images ({}) in {}:",
        images.len(),
        session_dir.join(IMAGES_DIR).display()
    )];
    for image in &images {
        lines.push(format!("  {}", image.summary()));
    }
    lines.push("Open one with /images open <N> (the latest without N).".into());
    lines.join("\n")
}

/// Open a saved image with CODSH_IMAGE_OPENER, else `open` (macOS) or
/// `xdg-open`. The viewer runs detached; its output is discarded.
pub fn open_image(path: &Path, env: &BTreeMap<String, String>) -> Result<String, String> {
    use std::process::{Command, Stdio};
    let (program, mut args) = match env
        .get("CODSH_IMAGE_OPENER")
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
                "could not open {} with {program}: {error}. Set CODSH_IMAGE_OPENER to an image viewer.",
                path.display()
            )
        })
}

/// Tool rows already titled by [`card_title`] (`Generate image …` / `Edit image …`).
pub fn is_image_title(title: &str) -> bool {
    title.starts_with("Generate image") || title.starts_with("Edit image")
}

fn short_prompt(prompt: &str) -> String {
    let flat = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 60 {
        format!("{}…", flat.chars().take(59).collect::<String>())
    } else {
        flat
    }
}

/// The card title of an `image_gen` / `image_edit` row. dsh's ACP titles a
/// call with its tool name; the client names the prompt and the host it goes to.
pub fn card_title(name: &str, raw_input: &Value, services: &ImageServices) -> Option<String> {
    let kind = match name {
        IMAGE_GEN_TOOL => JobKind::Generate,
        IMAGE_EDIT_TOOL => JobKind::Edit,
        _ => return None,
    };
    let host = services
        .route(kind)
        .map(|(service, _)| service.host())
        .unwrap_or_else(|_| "the configured service".into());
    let prompt = short_prompt(
        raw_input
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    Some(match kind {
        JobKind::Generate => format!("Generate image \"{prompt}\" via {host}"),
        JobKind::Edit => {
            let count = raw_input
                .get("image")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            let plural = if count == 1 { "" } else { "s" };
            format!("Edit image ({count} ref{plural}) \"{prompt}\" via {host}")
        }
    })
}

/// The second line of an image approval card: what is sent where, and cost.
pub fn approval_note(title: &str, raw_input: &Value) -> String {
    let host = title
        .rsplit_once(" via ")
        .map(|(_, host)| host.trim().to_string())
        .unwrap_or_else(|| "the configured service".into());
    let count = raw_input
        .get("image")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let sends = match count {
        0 => format!("Sends the prompt to {host}."),
        1 => format!("Sends the prompt and 1 reference image to {host}."),
        n => format!("Sends the prompt and {n} reference images to {host}."),
    };
    format!(
        "{sends} codsh does not know its price; any charge is set by that service. Each image request asks again."
    )
}

/// The live line under a running image call.
pub fn progress_line(title: &str, elapsed: Duration) -> String {
    let host = title
        .rsplit_once(" via ")
        .map(|(_, host)| host.trim())
        .unwrap_or("the configured service");
    format!(
        "waiting for {host} · {}s elapsed · Ctrl+C cancels; no file is saved until the image arrives",
        elapsed.as_secs()
    )
}

// ---------------------------------------------------------------------------
// Layered settings (same rules as web.rs; kept private there)

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

/// `pin`: requirements beat everything. Otherwise the user file, then env,
/// then a requirements `yes` value, then managed.
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

/// A requirements pin beats env, user, and managed. Env beats the user file.
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

    fn toml(text: &str) -> TomlValue {
        TomlValue::Table(text.parse::<toml::Table>().unwrap())
    }

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    const SERVICE: &str = r#"
[models]
default = "chat"
image_gen = "imagine"
[model.chat]
base_url = "http://127.0.0.1:9/v1"
[model.imagine]
model = "sd-turbo"
base_url = "http://127.0.0.1:7/v1"
protocol = "openai"
supports_image_generation = true
supports_image_edit = true
image_size = 512
"#;

    fn temp_home(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "codsh-image-{name}-{}-{}",
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

    fn job(kind: JobKind, images: Vec<String>, dir: &Path) -> Job {
        Job {
            kind,
            prompt: "a red square".into(),
            aspect_ratio: "auto".into(),
            images,
            session_dir: dir.to_path_buf(),
        }
    }

    #[test]
    fn nothing_is_enabled_without_an_explicit_service() {
        let services = load_services(&toml("[features]\nimage_gen = true\n"), &env(&[]), None);
        assert!(!services.gen_enabled && !services.edit_enabled);
        assert!(services.errors.is_empty());
        assert!(services.warnings[0].contains("no hidden default service"));
        assert_eq!(
            services.route(JobKind::Generate).unwrap_err(),
            ImageError::Disabled("image_gen")
        );
        assert!(disclosure(&services).contains("image_gen: off; no request is made"));
    }

    #[test]
    fn configured_service_enables_both_tools_and_env_can_turn_them_off() {
        let services = load_services(&toml(SERVICE), &env(&[]), None);
        assert!(
            services.gen_enabled && services.edit_enabled,
            "{services:?}"
        );
        assert_eq!(services.edit_service_source, "models.image_gen");
        let (service, model) = services.route(JobKind::Generate).unwrap();
        assert_eq!(
            (service.host().as_str(), model.as_str()),
            ("127.0.0.1:7", "sd-turbo")
        );
        assert!(service.cost_note().contains("keyless"));
        assert!(service.cost_note().contains("does not know its price"));
        let off = load_services(
            &toml(SERVICE),
            &env(&[("GROK_IMAGE_GEN", "0"), ("GROK_IMAGE_EDIT", "false")]),
            None,
        );
        assert!(!off.gen_enabled && !off.edit_enabled);
        assert_eq!(off.gen_enabled_source, "environment");
        let overridden = load_services(
            &toml(SERVICE),
            &env(&[("GROK_IMAGE_GEN_MODEL_OVERRIDE", "other-model")]),
            None,
        );
        assert_eq!(
            overridden.route(JobKind::Generate).unwrap().1,
            "other-model"
        );
        let dsh = dsh_env(&services);
        assert!(dsh.contains(&("CODSH_IMAGE_GEN".into(), "1".into())));
        assert!(dsh.contains(&("CODSH_IMAGE_GEN_HOST".into(), "127.0.0.1:7".into())));
    }

    #[test]
    fn requirements_pin_beats_env_and_image_edit_is_requirements_only() {
        let requirements = toml("[features]\nimage_gen = false\nimage_edit = false\n");
        let services = load_services(
            &toml(&format!("{SERVICE}\n[features]\nimage_edit = true\n")),
            &env(&[("GROK_IMAGE_GEN", "1"), ("GROK_IMAGE_EDIT", "1")]),
            Some(&requirements),
        );
        assert!(!services.gen_enabled && !services.edit_enabled);
        assert_eq!(services.gen_enabled_source, "requirements");
        assert_eq!(services.edit_enabled_source, "requirements");
        assert!(
            services
                .warnings
                .iter()
                .any(|warning| warning.contains("requirements-only"))
        );
    }

    #[test]
    fn official_hosts_chat_models_and_missing_keys_are_config_errors() {
        let official = SERVICE.replace("http://127.0.0.1:7/v1", "https://api.x.ai/v1");
        let services = load_services(&toml(&official), &env(&[]), None);
        assert!(!services.gen_enabled);
        assert!(
            services.errors[0].contains("official host"),
            "{:?}",
            services.errors
        );
        let rows = inspect_rows(&services);
        assert!(
            rows[0].1.ends_with("(refused; see Invalid configuration)"),
            "{rows:?}"
        );
        let chat = SERVICE.replace("supports_image_generation = true\n", "");
        let services = load_services(&toml(&chat), &env(&[]), None);
        assert!(services.errors[0].contains("supports_image_generation"));
        let keyed = SERVICE.replace(
            "image_size = 512",
            "image_size = 512\nenv_key = \"IMG_KEY\"",
        );
        let services = load_services(&toml(&keyed), &env(&[]), None);
        assert!(services.errors[0].contains("IMG_KEY"));
        let services = load_services(&toml(&keyed), &env(&[("IMG_KEY", "k-1")]), None);
        assert!(services.errors.is_empty() && services.gen_enabled);
        assert!(
            services
                .gen_service
                .unwrap()
                .cost_note()
                .contains("configured key")
        );
        let bad = SERVICE.replace("protocol = \"openai\"", "protocol = \"dalle\"");
        assert!(load_services(&toml(&bad), &env(&[]), None).errors[0].contains("dalle"));
        let parallel = format!("{SERVICE}\n[tools.media_gen]\nmax_parallel_image_gen_calls = 0\n");
        assert!(load_services(&toml(&parallel), &env(&[]), None).errors[0].contains("1 to 16"));
        let parallel = load_services(
            &toml(SERVICE),
            &env(&[("GROK_MAX_PARALLEL_IMAGE_GEN_CALLS", "2")]),
            None,
        );
        assert_eq!(parallel.max_parallel, 2);
    }

    #[test]
    fn requests_match_the_reference_and_openai_shapes() {
        let services = load_services(&toml(SERVICE), &env(&[]), None);
        let (mut service, model) = services.route(JobKind::Generate).unwrap();
        let dir = Path::new("/tmp");
        let mut generate = job(JobKind::Generate, Vec::new(), dir);
        generate.aspect_ratio = "16:9".into();
        let request = build_request(&service, &model, &generate, &[]);
        assert_eq!(request.url, "http://127.0.0.1:7/v1/images/generations");
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["size"], "512x320");
        assert_eq!(body["response_format"], "b64_json");
        service.protocol = ImageProtocol::Xai;
        let body: Value =
            serde_json::from_slice(&build_request(&service, &model, &generate, &[]).body).unwrap();
        assert_eq!(body["aspect_ratio"], "16:9");
        assert_eq!(body["resolution"], "1k");
        assert_eq!(body["n"], 1);
        let reference = Reference {
            label: "x".into(),
            bytes: crate::images::tiny_png(),
            media_type: "image/png",
        };
        let edit = job(JobKind::Edit, vec!["x".into()], dir);
        let one: Value = serde_json::from_slice(
            &build_request(&service, &model, &edit, std::slice::from_ref(&reference)).body,
        )
        .unwrap();
        assert!(
            one["image"]["url"]
                .as_str()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
        assert!(one.get("aspect_ratio").is_none());
        let two: Value = serde_json::from_slice(
            &build_request(
                &service,
                &model,
                &edit,
                &[reference.clone(), reference.clone()],
            )
            .body,
        )
        .unwrap();
        assert_eq!(two["images"].as_array().unwrap().len(), 2);
        assert_eq!(two["aspect_ratio"], "auto");
        service.protocol = ImageProtocol::Openai;
        let multipart = build_request(&service, &model, &edit, &[reference]);
        assert!(
            multipart
                .content_type
                .starts_with("multipart/form-data; boundary=")
        );
        let text = String::from_utf8_lossy(&multipart.body);
        assert!(text.contains("name=\"image[]\"; filename=\"reference-1.png\""));
        assert!(text.contains("name=\"prompt\"\r\n\r\na red square\r\n"));
        assert_eq!(openai_size("9:16", 1024), "576x1024");
        assert_eq!(openai_size("auto", 512), "512x512");
    }

    #[test]
    fn jobs_and_references_fail_explicitly() {
        let dir = Path::new("/tmp");
        let empty = job(JobKind::Edit, Vec::new(), dir);
        assert!(
            validate_job(&empty)
                .unwrap_err()
                .to_string()
                .contains("image_edit requires at least one reference image")
        );
        let mut ratio = job(JobKind::Generate, Vec::new(), dir);
        ratio.aspect_ratio = "5:4".into();
        assert!(
            validate_job(&ratio)
                .unwrap_err()
                .to_string()
                .contains("5:4")
        );
        assert_eq!(parse_attachment_token("[Image #2]"), Some(2));
        assert_eq!(parse_attachment_token("image #1"), Some(1));
        assert_eq!(parse_attachment_token("#3"), Some(3));
        assert_eq!(parse_attachment_token("/tmp/#1.png"), None);
        assert!(
            resolve_reference("[Image #1]", dir)
                .unwrap_err()
                .to_string()
                .contains("re-attach")
        );
        let home = temp_home("refs");
        let png = home.join("in.png");
        std::fs::write(&png, crate::images::tiny_png()).unwrap();
        let text = home.join("note.txt");
        std::fs::write(&text, "hello").unwrap();
        assert_eq!(
            resolve_reference(png.to_str().unwrap(), dir)
                .unwrap()
                .media_type,
            "image/png"
        );
        assert_eq!(
            resolve_reference(&format!("file://{}", png.display()), dir)
                .unwrap()
                .media_type,
            "image/png"
        );
        assert_eq!(
            resolve_reference("in.png", &home).unwrap().media_type,
            "image/png"
        );
        assert!(
            resolve_reference(text.to_str().unwrap(), dir)
                .unwrap_err()
                .to_string()
                .contains("not a png")
        );
        let data = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(crate::images::tiny_png())
        );
        assert_eq!(resolve_reference(&data, dir).unwrap().label, "data URL");
        assert!(resolve_reference("data:image/png,abc", dir).is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn responses_are_checked_before_anything_is_saved() {
        let kind = JobKind::Generate;
        let refused = parse_response(kind, 400, br#"{"error":"content policy"}"#).unwrap_err();
        assert!(
            refused
                .to_string()
                .starts_with("Image generation failed with HTTP 400: ")
        );
        assert!(refused.to_string().ends_with("Nothing was saved."));
        let paid = parse_response(kind, 402, b"pay").unwrap_err().to_string();
        assert!(paid.contains("never buys credits"), "{paid}");
        let policy = parse_response(kind, 200, br#"{"error":{"message":"blocked prompt"}}"#)
            .unwrap_err()
            .to_string();
        assert!(
            policy.contains("refused by the service: blocked prompt"),
            "{policy}"
        );
        let url = parse_response(
            kind,
            200,
            br#"{"data":[{"url":"https://cdn.example/x.png"}]}"#,
        )
        .unwrap_err()
        .to_string();
        assert!(url.contains("does not fetch"), "{url}");
        let junk = base64::engine::general_purpose::STANDARD.encode(b"not an image");
        let body = format!(r#"{{"data":[{{"b64_json":"{junk}"}}]}}"#);
        assert!(
            parse_response(kind, 200, body.as_bytes())
                .unwrap_err()
                .to_string()
                .contains("not a png")
        );
        assert!(parse_response(kind, 200, b"<html>").is_err());
        let png = base64::engine::general_purpose::STANDARD.encode(crate::images::tiny_png());
        let body = format!(r#"{{"data":[{{"b64_json":"{png}"}}]}}"#);
        assert_eq!(
            parse_response(kind, 200, body.as_bytes()).unwrap(),
            crate::images::tiny_png()
        );
    }

    #[test]
    fn saves_are_atomic_numbered_and_resume_the_counter() {
        let home = temp_home("save");
        let dir = session(&home);
        let first = save_image(&dir, &crate::images::tiny_png()).unwrap();
        assert_eq!(first.short, "images/1.png");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("images"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        std::fs::write(dir.join("images/.tmpORPHAN"), b"partial").unwrap();
        std::fs::write(dir.join("images/7.jpg"), b"\xFF\xD8\xFFsmall").unwrap();
        let next = save_image(&dir, &crate::images::tiny_png()).unwrap();
        assert_eq!(next.short, "images/8.png");
        assert!(!dir.join("images/.tmpORPHAN").exists());
        assert!(save_image(&dir, b"text").is_err());
        let names: Vec<String> = list_images(&dir)
            .iter()
            .map(|image| image.short.clone())
            .collect();
        assert_eq!(names, ["images/1.png", "images/7.jpg", "images/8.png"]);
        assert_eq!(find_image(&dir, "").unwrap().short, "images/8.png");
        assert_eq!(find_image(&dir, "1").unwrap().short, "images/1.png");
        assert_eq!(
            find_image(&dir, "images/7.jpg").unwrap().short,
            "images/7.jpg"
        );
        assert!(
            find_image(&dir, "3")
                .unwrap_err()
                .contains("not an image of this session")
        );
        assert!(listing(&dir).contains("images/1.png (1x1 png, "));
        assert!(check_session_dir(&home, &dir).is_ok());
        assert!(check_session_dir(&home, Path::new("/tmp/elsewhere")).is_err());
        assert!(check_session_dir(&home, &home.join("sessions/x/../../y")).is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    fn one_shot_server(
        response: Vec<u8>,
        hang: bool,
    ) -> (String, std::thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(500)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 65536];
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        request.extend_from_slice(&buffer[..count]);
                        let text = String::from_utf8_lossy(&request);
                        if let Some((head, body)) = text.split_once("\r\n\r\n") {
                            let length = head
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                                })
                                .unwrap_or(0);
                            if body.len() >= length {
                                break;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            if hang {
                std::thread::sleep(Duration::from_secs(3));
            } else {
                let _ = stream.write_all(&response);
            }
            request
        });
        (format!("http://{address}/v1"), handle)
    }

    #[test]
    fn a_real_http_exchange_saves_and_a_cancel_saves_nothing() {
        let png = base64::engine::general_purpose::STANDARD.encode(crate::images::tiny_png());
        let body = format!(r#"{{"data":[{{"b64_json":"{png}"}}]}}"#);
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let (base, server) = one_shot_server(response.into_bytes(), false);
        let config = SERVICE.replace("http://127.0.0.1:7/v1", &base).replace(
            "image_size = 512",
            "image_size = 512\napi_key = \"inline-key\"",
        );
        let services = load_services(&toml(&config), &env(&[]), None);
        let home = temp_home("http");
        let dir = session(&home);
        let flag = AtomicBool::new(false);
        let outcome = run_job(
            &services,
            &home,
            &home,
            &job(JobKind::Generate, Vec::new(), &dir),
            None,
            &flag,
        )
        .unwrap();
        assert_eq!(outcome.saved.short, "images/1.png");
        assert!(
            outcome
                .text(JobKind::Generate)
                .contains("Generated image: saved images/1.png (1x1 png")
        );
        let request = String::from_utf8_lossy(&server.join().unwrap()).to_string();
        assert!(
            request.starts_with("POST /v1/images/generations HTTP/1.1"),
            "{request}"
        );
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer inline-key")
        );
        assert!(request.contains("\"prompt\":\"a red square\""));

        let (base, _server) = one_shot_server(Vec::new(), true);
        let config = SERVICE.replace("http://127.0.0.1:7/v1", &base);
        let services = load_services(&toml(&config), &env(&[]), None);
        let flag = Arc::new(AtomicBool::new(false));
        let setter = flag.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            setter.store(true, Ordering::Relaxed);
        });
        let started = Instant::now();
        let error = run_job(
            &services,
            &home,
            &home,
            &job(JobKind::Generate, Vec::new(), &dir),
            None,
            &flag,
        )
        .unwrap_err();
        assert_eq!(error, ImageError::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(list_images(&dir).len(), 1, "a cancel must not add a file");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn imagine_matches_the_reference_text() {
        assert_eq!(imagine_args("/imagine"), Some(""));
        assert_eq!(imagine_args("  /imagine   a cat "), Some("a cat"));
        assert_eq!(imagine_args("/imagines x"), None);
        assert!(
            imagine_instruction("a cat")
                .ends_with("mention where the image was saved.\n\nPrompt: a cat")
        );
        assert!(IMAGINE_USAGE.starts_with("Usage: /imagine <description>\n"));
        assert!(is_image_title("Generate image via 127.0.0.1:7"));
        assert!(
            progress_line("Generate image via 127.0.0.1:7", Duration::from_secs(3))
                .starts_with("waiting for 127.0.0.1:7 · 3s elapsed")
        );
        assert_eq!(
            imagine_prompt_of(&imagine_instruction("a cat")),
            Some("a cat")
        );
        assert_eq!(imagine_prompt_of("a cat"), None);
    }

    #[test]
    fn cards_name_the_prompt_host_and_what_is_sent() {
        let services = load_services(&toml(SERVICE), &env(&[]), None);
        let generate =
            card_title("image_gen", &json!({"prompt": "a  red\nfox"}), &services).unwrap();
        assert_eq!(generate, "Generate image \"a red fox\" via 127.0.0.1:7");
        assert!(is_image_title(&generate));
        let edit = card_title(
            "image_edit",
            &json!({"prompt": "x".repeat(80), "image": ["[Image #1]", "/a.png"]}),
            &services,
        )
        .unwrap();
        assert!(edit.starts_with("Edit image (2 refs) \"xxxx"), "{edit}");
        assert!(edit.contains("…\" via 127.0.0.1:7"), "{edit}");
        assert_eq!(card_title("bash", &json!({}), &services), None);
        let none = load_services(&toml(""), &env(&[]), None);
        assert!(
            card_title("image_gen", &json!({"prompt": "p"}), &none)
                .unwrap()
                .ends_with("via the configured service")
        );
        let note = approval_note(&edit, &json!({"image": ["a", "b"]}));
        assert!(
            note.starts_with("Sends the prompt and 2 reference images to 127.0.0.1:7."),
            "{note}"
        );
        assert!(note.contains("does not know its price"));
        assert!(
            approval_note(&generate, &json!({})).starts_with("Sends the prompt to 127.0.0.1:7.")
        );
    }
}
