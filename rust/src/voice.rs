//! Explicit voice dictation into the composer.
//!
//! Capture starts only from `/voice` or an enabled Ctrl+Space / F8 press.
//! Audio leaves the machine only to the configured speech-to-text substitute.
//! Official hosts are refused. A transcript is inserted into the draft and is
//! never submitted. Doctor lists devices without opening a capture.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::Value;

const CAPTURE_BACKEND_ENV: &str = "GROK_VOICE_CAPTURE";
const DEFAULT_SAMPLE_RATE: u32 = 16_000;
const SILENCE_LIMIT: Duration = Duration::from_secs(10);
const MAX_AUDIO_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureMode {
    Hold,
    Toggle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoicePhase {
    Idle,
    Recording,
    Transcribing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceConfig {
    pub enabled: bool,
    pub enabled_source: String,
    pub capture_mode: CaptureMode,
    pub capture_mode_source: String,
    pub keybind_enabled: bool,
    pub keybind_source: String,
    pub session_language: Option<String>,
    pub session_language_source: String,
    pub language: String,
    pub language_source: String,
    pub api_base: Option<String>,
    pub api_base_source: String,
    pub sample_rate: u32,
    pub sample_rate_source: String,
    pub capture_backend: String,
    pub env_key: String,
    pub api_key: Option<String>,
}

impl VoiceConfig {
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            enabled_source: "default".into(),
            capture_mode: CaptureMode::Hold,
            capture_mode_source: "default".into(),
            keybind_enabled: true,
            keybind_source: "default".into(),
            session_language: None,
            session_language_source: "default".into(),
            language: "auto".into(),
            language_source: "default".into(),
            api_base: None,
            api_base_source: "default".into(),
            sample_rate: DEFAULT_SAMPLE_RATE,
            sample_rate_source: "default".into(),
            capture_backend: "inprocess".into(),
            env_key: "XAI_API_KEY".into(),
            api_key: None,
        }
    }

    /// Language sent to the substitute. A session override wins over `[voice].language`.
    pub fn request_language(&self) -> &str {
        self.session_language
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(self.language.as_str())
    }

    pub fn destination(&self) -> Result<String, VoiceError> {
        let Some(base) = self
            .api_base
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Err(VoiceError::NoDestination);
        };
        if crate::privacy::is_official_endpoint(base) {
            return Err(VoiceError::OfficialDestination);
        }
        let trimmed = base.trim_end_matches('/');
        Ok(format!("{trimmed}/audio/transcriptions"))
    }

    pub fn disclosure(&self) -> String {
        match self.destination() {
            Ok(url) => format!(
                "voice sends audio to {url}; language {}; not submitted until Enter",
                self.request_language()
            ),
            Err(VoiceError::OfficialDestination) => {
                "voice destination refused: official speech host is not used".into()
            }
            Err(_) => "voice needs [voice] api_base (a substitute speech-to-text URL)".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputDevice {
    pub name: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceReport {
    pub platform: &'static str,
    pub supported: bool,
    pub evidence: String,
    pub devices: Vec<InputDevice>,
    pub selected: Option<InputDevice>,
    pub permission: &'static str,
    pub capture_backend: String,
    pub finding: Option<&'static str>,
    pub next_steps: Vec<String>,
}

impl DeviceReport {
    pub fn text(&self) -> String {
        let mut lines = vec![
            "Voice".into(),
            format!("platform {} ({})", self.platform, self.evidence),
            format!(
                "microphone {}",
                self.selected
                    .as_ref()
                    .map(|device| device.name.as_str())
                    .unwrap_or("none")
            ),
            format!("permission {}", self.permission),
            format!("capture {}", self.capture_backend),
        ];
        if let Some(finding) = self.finding {
            lines.push(format!("finding {finding}"));
        }
        if self.devices.is_empty() {
            lines.push("no input device".into());
        } else {
            for device in &self.devices {
                lines.push(format!("device {} ({})", device.name, device.id));
            }
        }
        lines.extend(self.next_steps.iter().cloned());
        lines.join("\n")
    }

    pub fn json_value(&self) -> Value {
        serde_json::json!({
            "section": "voice",
            "platform": self.platform,
            "supported": self.supported,
            "evidence": self.evidence,
            "devices": self.devices.iter().map(|device| serde_json::json!({
                "name": device.name,
                "id": device.id,
            })).collect::<Vec<_>>(),
            "selected": self.selected.as_ref().map(|device| serde_json::json!({
                "name": device.name,
                "id": device.id,
            })),
            "permission": self.permission,
            "captureBackend": self.capture_backend,
            "finding": self.finding,
            "nextSteps": self.next_steps,
            "recording": false,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceError {
    Disabled,
    NoDestination,
    OfficialDestination,
    NoDevice,
    PermissionDenied,
    Silence,
    Cancelled,
    Service(String),
    InvalidLanguage,
    UnsupportedKeyRelease,
    Protocol(String),
}

impl std::fmt::Display for VoiceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => write!(formatter, "voice mode is off (features.voice_mode)"),
            Self::NoDestination => write!(
                formatter,
                "voice needs [voice] api_base pointing at a substitute speech-to-text service"
            ),
            Self::OfficialDestination => write!(
                formatter,
                "voice.api_base is an official host; set a substitute speech-to-text URL"
            ),
            Self::NoDevice => write!(
                formatter,
                "voice.no-input-device: no microphone is available. Run /voice doctor."
            ),
            Self::PermissionDenied => write!(
                formatter,
                "microphone permission was denied. Grant it to this terminal and restart it."
            ),
            Self::Silence => write!(
                formatter,
                "No speech was detected. Voice stopped. Check System Settings → Sound → Input, then try again."
            ),
            Self::Cancelled => write!(formatter, "voice cancelled; draft unchanged"),
            Self::Service(message) => write!(formatter, "voice service error: {message}"),
            Self::InvalidLanguage => write!(
                formatter,
                "invalid voice language; use auto or a catalog code such as en or zh"
            ),
            Self::UnsupportedKeyRelease => write!(
                formatter,
                "this terminal did not report key release; hold-to-talk cannot stop. Use /voice or ui.voice_capture_mode = \"toggle\"."
            ),
            Self::Protocol(message) => write!(formatter, "voice protocol error: {message}"),
        }
    }
}

#[derive(Debug)]
enum WorkerOutcome {
    Audio(Vec<u8>),
    Failed(VoiceError),
}

enum CaptureJob {
    Thread(JoinHandle<WorkerOutcome>),
}

/// One explicit recording. The generation is stamped into the draft only when
/// it still matches; a newer draft or a cancel drops a late transcript.
struct Capture {
    generation: u64,
    phase: VoicePhase,
    started: Instant,
    draft_at_start: String,
    job: Option<CaptureJob>,
    fixture: Option<PathBuf>,
}

pub struct VoiceSession {
    pub config: VoiceConfig,
    pub phase: VoicePhase,
    generation: u64,
    active: Option<Capture>,
    /// Completed audio waiting for transcription, keyed by generation.
    pending_audio: Option<(u64, Vec<u8>, String)>,
    pub status: String,
    fixture: Option<PathBuf>,
    devices: Option<String>,
}

impl VoiceSession {
    pub fn new(config: VoiceConfig) -> Self {
        let status = if config.enabled {
            config.disclosure()
        } else {
            "voice mode off".into()
        };
        Self {
            config,
            phase: VoicePhase::Idle,
            generation: 0,
            active: None,
            pending_audio: None,
            status,
            fixture: fixture_path_from_env(),
            devices: std::env::var("CODSH_VOICE_DEVICES").ok(),
        }
    }

    /// Test seam. Production reads the same values from the process environment.
    #[cfg(test)]
    pub fn with_fixture(mut self, audio: PathBuf, devices: &str) -> Self {
        self.fixture = Some(audio);
        self.devices = Some(devices.to_string());
        self
    }

    pub fn recording(&self) -> bool {
        self.phase != VoicePhase::Idle
    }

    /// Start only when the user asked. Returns the disclosure line.
    pub fn start(&mut self, draft: &str, mode: CaptureMode) -> Result<String, VoiceError> {
        self.preflight()?;
        if self.phase != VoicePhase::Idle {
            return Ok(self.status.clone());
        }
        let report = self.device_report();
        if report.permission == "denied" {
            return Err(VoiceError::PermissionDenied);
        }
        if report.devices.is_empty() {
            return Err(VoiceError::NoDevice);
        }
        self.generation = self.generation.saturating_add(1);
        let generation = self.generation;
        let job = spawn_capture(&self.config, generation, &report, self.fixture.clone())?;
        self.phase = VoicePhase::Recording;
        self.status = format!(
            "recording ({}) · {} · Esc cancels · audio not sent until stop",
            mode_label(mode),
            self.config.disclosure()
        );
        self.active = Some(Capture {
            generation,
            phase: VoicePhase::Recording,
            started: Instant::now(),
            draft_at_start: draft.to_string(),
            job: Some(job),
            fixture: self.fixture.clone(),
        });
        Ok(self.status.clone())
    }

    pub fn stop(&mut self) -> Result<(), VoiceError> {
        let Some(capture) = self.active.as_mut() else {
            return Ok(());
        };
        if capture.phase != VoicePhase::Recording {
            return Ok(());
        }
        let generation = capture.generation;
        let draft = capture.draft_at_start.clone();
        let outcome = finish_job(capture.job.take());
        match outcome {
            WorkerOutcome::Failed(error) => {
                self.clear_active();
                Err(error)
            }
            WorkerOutcome::Audio(bytes) if bytes.is_empty() => {
                self.clear_active();
                Err(VoiceError::Silence)
            }
            WorkerOutcome::Audio(bytes) => {
                capture.phase = VoicePhase::Transcribing;
                self.phase = VoicePhase::Transcribing;
                self.pending_audio = Some((generation, bytes, draft));
                self.status = format!(
                    "transcribing · {} · not submitted",
                    self.config.disclosure()
                );
                Ok(())
            }
        }
    }

    /// Drop the recording and any audio that has not been inserted yet.
    pub fn cancel(&mut self) -> String {
        let generation = self.active.as_ref().map(|capture| capture.generation);
        self.clear_active();
        self.pending_audio = None;
        if let Some(generation) = generation {
            // A late worker result for this generation is ignored by take_insert.
            self.generation = generation;
        }
        self.status = VoiceError::Cancelled.to_string();
        self.status.clone()
    }

    pub fn poll(&mut self) -> Result<Option<Insert>, VoiceError> {
        if self.phase == VoicePhase::Recording
            && self
                .active
                .as_ref()
                .is_some_and(|capture| capture.started.elapsed() >= SILENCE_LIMIT)
        {
            let fixture = self
                .active
                .as_ref()
                .and_then(|capture| capture.fixture.clone());
            if fixture.is_none() {
                self.clear_active();
                return Err(VoiceError::Silence);
            }
            self.stop()?;
        }
        let Some((generation, audio, draft_at_start)) = self.pending_audio.take() else {
            return Ok(None);
        };
        if generation != self.generation {
            self.clear_active();
            return Ok(None);
        }
        match transcribe(&self.config, &audio) {
            Ok(text) if text.trim().is_empty() => {
                self.clear_active();
                Err(VoiceError::Silence)
            }
            Ok(text) => {
                self.clear_active();
                self.status = "voice inserted into the draft; Enter sends it".into();
                Ok(Some(Insert {
                    generation,
                    text,
                    draft_at_start,
                }))
            }
            Err(error) => {
                self.clear_active();
                Err(error)
            }
        }
    }

    /// True when a transcript may still be appended to this exact draft.
    pub fn accepts_late(&self, generation: u64, current_draft: &str, draft_at_start: &str) -> bool {
        generation == self.generation
            && current_draft == draft_at_start
            && self.phase == VoicePhase::Idle
    }

    pub fn device_report(&self) -> DeviceReport {
        if let Some(body) = &self.devices {
            let mut env = std::collections::BTreeMap::new();
            env.insert(
                "GROK_VOICE_CAPTURE".into(),
                self.config.capture_backend.clone(),
            );
            return diagnose_fixture(body, &env);
        }
        diagnose(&std::env::vars().collect())
    }

    fn preflight(&self) -> Result<(), VoiceError> {
        if !self.config.enabled {
            return Err(VoiceError::Disabled);
        }
        validate_language(self.config.request_language())?;
        self.config.destination().map(|_| ())
    }

    fn clear_active(&mut self) {
        if let Some(mut capture) = self.active.take() {
            let _ = finish_job(capture.job.take());
        }
        self.phase = VoicePhase::Idle;
        self.pending_audio = None;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Insert {
    pub generation: u64,
    pub text: String,
    pub draft_at_start: String,
}

pub fn apply_insert(current: &str, draft_at_start: &str, text: &str) -> Option<String> {
    if current != draft_at_start {
        return None;
    }
    let addition = text.trim();
    if addition.is_empty() {
        return None;
    }
    if current.is_empty() {
        Some(addition.to_string())
    } else if current.ends_with(|ch: char| ch.is_whitespace()) {
        Some(format!("{current}{addition}"))
    } else {
        Some(format!("{current} {addition}"))
    }
}

pub fn load_config(
    table: &toml::Value,
    env: &std::collections::BTreeMap<String, String>,
) -> VoiceConfig {
    let mut config = VoiceConfig::disabled();
    config.enabled = true;
    config.capture_backend = env
        .get(CAPTURE_BACKEND_ENV)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "inprocess".into());
    if let Some(value) = env_bool(env.get("GROK_VOICE_MODE")) {
        config.enabled = value;
        config.enabled_source = "environment".into();
    } else if let Some(value) = nested_bool(table, &["features", "voice_mode"]) {
        config.enabled = value;
        config.enabled_source = "config.toml".into();
    }
    if let Some(raw) = env
        .get("GROK_VOICE_CAPTURE_MODE")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if let Some(mode) = parse_capture_mode(&raw) {
            config.capture_mode = mode;
            config.capture_mode_source = "environment".into();
        }
    } else if let Some(raw) = nested_str(table, &["ui", "voice_capture_mode"])
        && let Some(mode) = parse_capture_mode(raw)
    {
        config.capture_mode = mode;
        config.capture_mode_source = "config.toml".into();
    }
    if let Some(value) = env_bool(env.get("GROK_VOICE_KEYBIND")) {
        config.keybind_enabled = value;
        config.keybind_source = "environment".into();
    } else if let Some(value) = nested_bool(table, &["ui", "voice_keybind_enabled"]) {
        config.keybind_enabled = value;
        config.keybind_source = "config.toml".into();
    }
    if let Some(value) = env
        .get("GROK_VOICE_STT_LANGUAGE")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        config.session_language = Some(value);
        config.session_language_source = "environment".into();
    } else if let Some(value) = nested_str(table, &["ui", "voice_stt_language"]) {
        config.session_language = Some(value.to_string());
        config.session_language_source = "config.toml".into();
    }
    if let Some(value) = nested_str(table, &["voice", "language"]) {
        config.language = value.to_string();
        config.language_source = "config.toml".into();
    }
    if let Some(value) = nested_str(table, &["voice", "api_base"]) {
        config.api_base = Some(value.to_string());
        config.api_base_source = "config.toml".into();
    } else if let Some(value) = nested_str(table, &["endpoints", "xai_api_base_url"]) {
        config.api_base = Some(value.to_string());
        config.api_base_source = "endpoints.xai_api_base_url".into();
    }
    if let Some(value) = nested_u32(table, &["voice", "sample_rate"]) {
        config.sample_rate = value;
        config.sample_rate_source = "config.toml".into();
    }
    if let Some(value) = nested_str(table, &["voice", "env_key"]) {
        config.env_key = value.to_string();
    }
    config.api_key = env
        .get(&config.env_key)
        .cloned()
        .filter(|value| !value.is_empty());
    config
}

pub fn inspect_rows(config: &VoiceConfig) -> Vec<(&'static str, String, String)> {
    let destination = match &config.api_base {
        Some(url) if crate::privacy::is_official_endpoint(url) => {
            "(refused official endpoint)".into()
        }
        Some(url) => url.clone(),
        None => "(unset)".into(),
    };
    let destination_source = if config
        .api_base
        .as_deref()
        .is_some_and(crate::privacy::is_official_endpoint)
    {
        "refused".into()
    } else {
        config.api_base_source.clone()
    };
    vec![
        (
            "features.voice_mode",
            if config.enabled { "true" } else { "false" }.into(),
            config.enabled_source.clone(),
        ),
        (
            "ui.voice_capture_mode",
            mode_label(config.capture_mode).into(),
            config.capture_mode_source.clone(),
        ),
        (
            "ui.voice_keybind_enabled",
            if config.keybind_enabled {
                "true"
            } else {
                "false"
            }
            .into(),
            config.keybind_source.clone(),
        ),
        (
            "ui.voice_stt_language",
            config
                .session_language
                .clone()
                .unwrap_or_else(|| "(unset)".into()),
            config.session_language_source.clone(),
        ),
        (
            "voice.language",
            config.language.clone(),
            config.language_source.clone(),
        ),
        ("voice.api_base", destination, destination_source),
        (
            "voice.sample_rate",
            config.sample_rate.to_string(),
            config.sample_rate_source.clone(),
        ),
        (
            "voice.request_language",
            config.request_language().to_string(),
            if config.session_language.is_some() {
                config.session_language_source.clone()
            } else {
                config.language_source.clone()
            },
        ),
    ]
}

/// List input devices without starting a recording.
pub fn diagnose(env: &std::collections::BTreeMap<String, String>) -> DeviceReport {
    if let Some(fixture) = env.get("CODSH_VOICE_DEVICES") {
        return diagnose_fixture(fixture, env);
    }
    diagnose_platform(env)
}

pub fn diagnose_platform(env: &std::collections::BTreeMap<String, String>) -> DeviceReport {
    let backend = env
        .get(CAPTURE_BACKEND_ENV)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "inprocess".into());
    if cfg!(target_os = "macos") {
        let listed = list_macos_inputs();
        let supported = listed.is_ok();
        let devices = listed.unwrap_or_default();
        let selected = devices.first().cloned();
        let finding = if devices.is_empty() {
            Some("voice.no-input-device")
        } else {
            None
        };
        let mut steps = macos_steps(finding.is_some());
        steps.insert(
            0,
            "macOS device listing is verified. Opening the microphone from this process is unverified: avfoundation can hang when TCC has not granted it. Recording uses CODSH_VOICE_FIXTURE until a bounded capture helper is proven.".into(),
        );
        DeviceReport {
            platform: "macos",
            supported,
            evidence:
                "system_profiler SPAudioDataType and ffmpeg avfoundation -list_devices (no capture)"
                    .into(),
            devices: devices.clone(),
            selected,
            permission: "not-probed",
            capture_backend: backend,
            finding,
            next_steps: steps,
        }
    } else if cfg!(target_os = "linux") {
        DeviceReport {
            platform: "linux",
            supported: false,
            evidence: "not exercised on this host".into(),
            devices: Vec::new(),
            selected: None,
            permission: "unverified",
            capture_backend: backend,
            finding: Some("voice.platform-unverified"),
            next_steps: vec![
                "Linux capture is unverified in this build. Do not treat a missing device as success."
                    .into(),
            ],
        }
    } else if cfg!(target_os = "windows") {
        DeviceReport {
            platform: "windows",
            supported: false,
            evidence: "not exercised on this host".into(),
            devices: Vec::new(),
            selected: None,
            permission: "unverified",
            capture_backend: backend,
            finding: Some("voice.platform-unverified"),
            next_steps: vec!["Windows capture is unverified in this build.".into()],
        }
    } else {
        DeviceReport {
            platform: "unknown",
            supported: false,
            evidence: "no capture probe for this target".into(),
            devices: Vec::new(),
            selected: None,
            permission: "unverified",
            capture_backend: backend,
            finding: Some("voice.platform-unverified"),
            next_steps: vec!["Voice capture is not available on this target.".into()],
        }
    }
}

fn diagnose_fixture(body: &str, env: &std::collections::BTreeMap<String, String>) -> DeviceReport {
    let backend = env
        .get(CAPTURE_BACKEND_ENV)
        .cloned()
        .unwrap_or_else(|| "inprocess".into());
    let mut devices = Vec::new();
    let mut permission = "not-probed";
    let mut platform = if cfg!(target_os = "macos") {
        "macos"
    } else {
        "fixture"
    };
    for line in body.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("permission=") {
            permission = match rest {
                "denied" => "denied",
                "granted" => "granted",
                _ => "not-probed",
            };
        } else if let Some(rest) = line.strip_prefix("platform=") {
            platform = match rest {
                "macos" => "macos",
                "linux" => "linux",
                "windows" => "windows",
                _ => "fixture",
            };
        } else if let Some((name, id)) = line.split_once('|') {
            devices.push(InputDevice {
                name: name.trim().to_string(),
                id: id.trim().to_string(),
            });
        }
    }
    let finding = if permission == "denied" {
        Some("voice.permission-denied")
    } else if devices.is_empty() {
        Some("voice.no-input-device")
    } else {
        None
    };
    let supported = platform == "macos" && permission != "denied";
    DeviceReport {
        platform,
        supported,
        evidence: "CODSH_VOICE_DEVICES fixture".into(),
        selected: devices.first().cloned(),
        devices,
        permission,
        capture_backend: backend,
        finding,
        next_steps: if finding == Some("voice.no-input-device") {
            macos_steps(true)
        } else if finding == Some("voice.permission-denied") {
            vec!["Grant Microphone to this terminal in System Settings, then restart it.".into()]
        } else {
            vec![
                "Doctor does not start recording. A denied grant can still look like silence."
                    .into(),
            ]
        },
    }
}

fn macos_steps(missing: bool) -> Vec<String> {
    let mut steps = vec![
        "Doctor does not start recording and cannot see a macOS permission denial that arrives as silence.".into(),
        "System Settings → Privacy & Security → Microphone: enable this terminal, then restart it.".into(),
    ];
    if missing {
        steps.push("System Settings → Sound → Input: confirm a device and its level.".into());
    }
    steps.push(
        "GROK_VOICE_CAPTURE=inprocess uses the in-process reader; helper is the short-lived capture process."
            .into(),
    );
    steps
}

fn list_macos_inputs() -> Result<Vec<InputDevice>, ()> {
    let profiler = Command::new("/usr/sbin/system_profiler")
        .args(["SPAudioDataType", "-json"])
        .stdin(Stdio::null())
        .output();
    let profiler_failed = profiler.is_err();
    let mut devices = Vec::new();
    if let Ok(output) = profiler
        && output.status.success()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            collect_inputs(&value, &mut devices);
        }
    }
    if let Some(ffmpeg) = ffmpeg_bin()
        && let Ok(output) = Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-f",
                "avfoundation",
                "-list_devices",
                "true",
                "-i",
                "",
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::piped())
            .output()
    {
        let text = String::from_utf8_lossy(&output.stderr);
        let mut in_audio = false;
        for line in text.lines() {
            if line.contains("AVFoundation audio devices") {
                in_audio = true;
                continue;
            }
            if line.contains("AVFoundation video devices") {
                in_audio = false;
            }
            if !in_audio {
                continue;
            }
            let Some(start) = line.rfind("] [") else {
                continue;
            };
            let Some(rest) = line[start + 3..].split_once(']') else {
                continue;
            };
            let id = rest.0.trim();
            let name = rest.1.trim();
            if id.is_empty() || name.is_empty() || devices.iter().any(|device| device.name == name)
            {
                continue;
            }
            devices.push(InputDevice {
                name: name.to_string(),
                id: id.to_string(),
            });
        }
    }
    if devices.is_empty() && profiler_failed {
        return Err(());
    }
    Ok(devices)
}

fn ffmpeg_bin() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join("ffmpeg");
        candidate.is_file().then_some(candidate)
    })
}

fn collect_inputs(value: &Value, out: &mut Vec<InputDevice>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_inputs(item, out);
            }
        }
        Value::Object(map) => {
            let name = map.get("_name").and_then(Value::as_str);
            let input = map
                .get("coreaudio_device_input")
                .or_else(|| map.get("coreaudio_default_audio_input_device"))
                .and_then(Value::as_str);
            let is_input = input.is_some_and(|value| value != "0")
                || map
                    .keys()
                    .any(|key| key.to_ascii_lowercase().contains("input"));
            if let Some(name) = name
                && is_input
                && !out.iter().any(|device| device.name == name)
            {
                out.push(InputDevice {
                    name: name.to_string(),
                    id: name.to_string(),
                });
            }
            for child in map.values() {
                collect_inputs(child, out);
            }
        }
        _ => {}
    }
}

fn spawn_capture(
    config: &VoiceConfig,
    generation: u64,
    report: &DeviceReport,
    fixture: Option<PathBuf>,
) -> Result<CaptureJob, VoiceError> {
    if report.permission == "denied" {
        return Err(VoiceError::PermissionDenied);
    }
    if report.devices.is_empty() {
        return Err(VoiceError::NoDevice);
    }
    if let Some(path) = fixture {
        let path_for_thread = path.clone();
        let handle = thread::spawn(move || read_fixture(&path_for_thread));
        return Ok(CaptureJob::Thread(handle));
    }
    if config.capture_backend == "helper" {
        return Err(VoiceError::Protocol(
            "GROK_VOICE_CAPTURE=helper has no fixture and no verified system recorder on this host"
                .into(),
        ));
    }
    let _ = (generation, report);
    Err(VoiceError::Protocol(
        "no CODSH_VOICE_FIXTURE; live microphone capture is unverified on this host and was not started"
            .into(),
    ))
}

fn fixture_path_from_env() -> Option<PathBuf> {
    std::env::var_os("CODSH_VOICE_FIXTURE").map(PathBuf::from)
}

fn read_fixture(path: &Path) -> WorkerOutcome {
    match std::fs::read(path) {
        Ok(bytes) if bytes.is_empty() => WorkerOutcome::Failed(VoiceError::Silence),
        Ok(bytes) => WorkerOutcome::Audio(bytes),
        Err(error) => WorkerOutcome::Failed(VoiceError::Service(error.to_string())),
    }
}

fn finish_job(job: Option<CaptureJob>) -> WorkerOutcome {
    match job {
        Some(CaptureJob::Thread(handle)) => handle
            .join()
            .unwrap_or(WorkerOutcome::Failed(VoiceError::Cancelled)),
        None => WorkerOutcome::Failed(VoiceError::Cancelled),
    }
}

pub fn transcribe(config: &VoiceConfig, audio: &[u8]) -> Result<String, VoiceError> {
    if audio.is_empty() {
        return Err(VoiceError::Silence);
    }
    if audio.len() > MAX_AUDIO_BYTES {
        return Err(VoiceError::Protocol("audio exceeds 8 MiB".into()));
    }
    let url = config.destination()?;
    let language = config.request_language();
    validate_language(language)?;
    let boundary = "codsh-voice-boundary";
    let mut body = Vec::new();
    write_part(
        &mut body,
        boundary,
        "file",
        Some("dictation.wav"),
        "application/octet-stream",
        audio,
    );
    write_part(
        &mut body,
        boundary,
        "model",
        None,
        "text/plain",
        b"whisper-1",
    );
    if language != "auto" {
        write_part(
            &mut body,
            boundary,
            "language",
            None,
            "text/plain",
            language.as_bytes(),
        );
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    let mut request = ureq::post(&url)
        .timeout(Duration::from_secs(20))
        .set(
            "content-type",
            &format!("multipart/form-data; boundary={boundary}"),
        )
        .set("user-agent", "codsh-rust-voice");
    if let Some(key) = config.api_key.as_deref().filter(|value| !value.is_empty()) {
        request = request.set("authorization", &format!("Bearer {key}"));
    }
    let response = request.send_bytes(&body).map_err(|error| match error {
        ureq::Error::Status(code, response) => {
            let mut text = String::new();
            let _ = response.into_reader().take(1024).read_to_string(&mut text);
            VoiceError::Service(format!("HTTP {code}: {}", text.trim()))
        }
        other => VoiceError::Service(other.to_string()),
    })?;
    let mut text = String::new();
    response
        .into_reader()
        .take(64 * 1024)
        .read_to_string(&mut text)
        .map_err(|error| VoiceError::Protocol(error.to_string()))?;
    parse_transcript(&text)
}

fn write_part(
    body: &mut Vec<u8>,
    boundary: &str,
    name: &str,
    filename: Option<&str>,
    content_type: &str,
    bytes: &[u8],
) {
    let _ = write!(body, "--{boundary}\r\n");
    if let Some(filename) = filename {
        let _ = write!(
            body,
            "content-disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n"
        );
    } else {
        let _ = write!(body, "content-disposition: form-data; name=\"{name}\"\r\n");
    }
    let _ = write!(body, "content-type: {content_type}\r\n\r\n");
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n");
}

pub fn parse_transcript(body: &str) -> Result<String, VoiceError> {
    let value: Value = serde_json::from_str(body)
        .map_err(|error| VoiceError::Protocol(format!("malformed transcript JSON: {error}")))?;
    if let Some(message) = value.get("error").and_then(|error| {
        error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| error.as_str())
    }) {
        return Err(VoiceError::Service(message.to_string()));
    }
    if value.get("text").is_none() && value.get("transcript").is_none() {
        return Err(VoiceError::Protocol(
            "transcript response has no text field".into(),
        ));
    }
    let text = value
        .get("text")
        .or_else(|| value.get("transcript"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if text.trim().is_empty() {
        return Err(VoiceError::Silence);
    }
    Ok(text.trim().to_string())
}

pub fn validate_language(language: &str) -> Result<(), VoiceError> {
    if language == "auto" {
        return Ok(());
    }
    let bytes = language.as_bytes();
    if (2..=16).contains(&bytes.len())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-' || *byte == b'_')
    {
        Ok(())
    } else {
        Err(VoiceError::InvalidLanguage)
    }
}

fn parse_capture_mode(value: &str) -> Option<CaptureMode> {
    match value.trim().to_ascii_lowercase().as_str() {
        "hold" => Some(CaptureMode::Hold),
        "toggle" => Some(CaptureMode::Toggle),
        _ => None,
    }
}

fn mode_label(mode: CaptureMode) -> &'static str {
    match mode {
        CaptureMode::Hold => "hold",
        CaptureMode::Toggle => "toggle",
    }
}

fn nested_str<'a>(table: &'a toml::Value, path: &[&str]) -> Option<&'a str> {
    let mut current = table;
    for key in path {
        current = current.get(*key)?;
    }
    current
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn nested_bool(table: &toml::Value, path: &[&str]) -> Option<bool> {
    let mut current = table;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_bool()
}

fn nested_u32(table: &toml::Value, path: &[&str]) -> Option<u32> {
    let mut current = table;
    for key in path {
        current = current.get(*key)?;
    }
    current
        .as_integer()
        .and_then(|value| u32::try_from(value).ok())
}

fn env_bool(value: Option<&String>) -> Option<bool> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Public doctor text. Recording stays off.
pub fn doctor_text(config: &VoiceConfig, report: &DeviceReport) -> String {
    format!(
        "{}\n{}\nrecording false",
        report.text(),
        config.disclosure()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    fn table(body: &str) -> toml::Value {
        toml::from_str(body).unwrap()
    }

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn session_language_overrides_voice_language_and_refuses_official_base() {
        let loaded = load_config(
            &table(
                "[ui]\nvoice_stt_language = \"zh\"\n[voice]\nlanguage = \"en\"\napi_base = \"https://api.x.ai/v1\"\n",
            ),
            &BTreeMap::new(),
        );
        assert_eq!(loaded.request_language(), "zh");
        assert!(matches!(
            loaded.destination(),
            Err(VoiceError::OfficialDestination)
        ));
        assert!(loaded.disclosure().contains("official"));
    }

    #[test]
    fn missing_device_permission_and_cancel_do_not_replace_a_new_draft() {
        let report = diagnose_fixture("permission=denied\n", &env(&[]));
        assert_eq!(report.finding, Some("voice.permission-denied"));
        assert!(report.text().contains("permission denied"));
        let empty = diagnose_fixture("platform=macos\n", &env(&[]));
        assert_eq!(empty.finding, Some("voice.no-input-device"));
        assert!(empty.json_value()["recording"].as_bool() == Some(false));
        let mut current = "kept draft".to_string();
        assert!(apply_insert(&current, "old draft", "late words").is_none());
        assert_eq!(current, "kept draft");
        current = apply_insert("old draft", "old draft", "hello").unwrap();
        assert_eq!(current, "old draft hello");
    }

    #[test]
    fn malformed_transcript_and_service_error_stay_explicit() {
        let error = parse_transcript("not-json").unwrap_err();
        assert!(matches!(error, VoiceError::Protocol(_)));
        let missing = parse_transcript("{\"ok\":true}").unwrap_err();
        assert!(matches!(missing, VoiceError::Protocol(_)));
        let service = parse_transcript("{\"error\":{\"message\":\"quota\"}}").unwrap_err();
        assert_eq!(service, VoiceError::Service("quota".into()));
        assert!(validate_language("bad language").is_err());
    }

    #[test]
    fn substitute_route_posts_language_override_and_audio_only() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(String::new()));
        let seen_thread = Arc::clone(&seen);
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 8192];
            let count = stream.read(&mut buffer).unwrap_or(0);
            *seen_thread.lock().unwrap() = String::from_utf8_lossy(&buffer[..count]).to_string();
            let body = "{\"text\":\"substitute hello\"}";
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        });
        let mut config = VoiceConfig::disabled();
        config.enabled = true;
        config.api_base = Some(format!("http://{address}/v1"));
        config.language = "en".into();
        config.session_language = Some("zh".into());
        config.api_key = Some("fixture-key".into());
        let text = transcribe(&config, b"RIFFfake-audio").unwrap();
        assert_eq!(text, "substitute hello");
        let posted = seen.lock().unwrap().clone();
        assert!(posted.contains("POST /v1/audio/transcriptions"));
        assert!(posted.contains("name=\"language\""));
        assert!(posted.contains("zh"));
        assert!(posted.contains("RIFFfake-audio"));
        assert!(posted.contains("Bearer fixture-key"));
        assert!(!posted.contains("api.x.ai"));
    }

    #[test]
    fn cancel_and_a_changed_draft_drop_the_fixture_transcript() {
        let path = std::env::temp_dir().join(format!(
            "codsh-voice-fixture-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::write(&path, b"RIFFnot-sent").unwrap();
        let mut config = VoiceConfig::disabled();
        config.enabled = true;
        config.api_base = Some("http://127.0.0.1:9/v1".into());
        let mut session =
            VoiceSession::new(config).with_fixture(path.clone(), "Mic|0\npermission=granted\n");
        let started = session.start("old draft", CaptureMode::Toggle).unwrap();
        assert!(started.contains("recording"));
        assert!(started.contains("not submitted"));
        session.cancel();
        let late = session.poll().unwrap();
        assert!(late.is_none());
        assert_eq!(session.phase, VoicePhase::Idle);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn linux_and_windows_stay_unverified_without_claiming_a_device() {
        let mut report = diagnose_platform(&BTreeMap::new());
        if cfg!(target_os = "linux") || cfg!(target_os = "windows") {
            assert!(!report.supported);
            assert_eq!(report.finding, Some("voice.platform-unverified"));
        }
        report = diagnose_fixture("platform=linux\nMic|0\n", &BTreeMap::new());
        assert_eq!(report.platform, "linux");
        assert!(!report.supported);
    }
}
