use crate::extra_ca::{self, HttpError};
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{Value as JsonValue, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use toml::Value as TomlValue;

pub const AUTH_FILE_NAME: &str = "auth.json";
pub const SIGNATURE_SIDECAR: &str = "managed_config.sig.json";
pub const OFFICIAL_LOGIN_NOTICE: &str = "Official grok.com / auth.x.ai login, subscription billing, auto-topup, and team entitlements are not reproduced and are not substitutes.";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_OIDC_SCOPES: &[&str] =
    &["openid", "profile", "email", "offline_access", "api:access"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthMethod {
    ApiKey,
    External,
    Oidc,
    Oauth2,
}

impl AuthMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ApiKey => "api_key",
            Self::External => "external",
            Self::Oidc => "oidc",
            Self::Oauth2 => "oauth2",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    None,
    Loopback,
    Device,
    Command,
}

impl Transport {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Loopback => "loopback",
            Self::Device => "device",
            Self::Command => "command",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportOverride {
    None,
    ForceLoopback,
    ForceDevice,
}

impl TransportOverride {
    pub fn from_flags(oauth: bool, device: bool) -> Self {
        if oauth {
            Self::ForceLoopback
        } else if device {
            Self::ForceDevice
        } else {
            Self::None
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForceLoginTeam {
    pub teams: Vec<String>,
}

impl ForceLoginTeam {
    pub fn allows(&self, team: Option<&str>) -> bool {
        if self.teams.is_empty() {
            return false;
        }
        team.is_some_and(|value| self.teams.iter().any(|team| team == value))
    }

    pub fn display(&self) -> String {
        if self.teams.is_empty() {
            "(none; fail closed)".into()
        } else {
            self.teams.join(", ")
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OidcIssuer {
    pub issuer: String,
    pub client_id: String,
    pub scopes: Vec<String>,
    pub audience: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthRecord {
    pub method: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<u64>,
    pub issuer: Option<String>,
    pub client_id: Option<String>,
    pub team_id: Option<String>,
    pub label: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthConfig {
    pub method: AuthMethod,
    pub transport: Transport,
    pub transport_source: String,
    pub provider_command: Option<String>,
    pub provider_label: Option<String>,
    pub token_ttl: Option<u64>,
    pub early_invalidation_secs: u64,
    pub oidc: Option<OidcIssuer>,
    pub oauth2: Option<OidcIssuer>,
    pub disable_api_key_auth: bool,
    pub force_login_team: Option<ForceLoginTeam>,
    pub preferred_method: Option<AuthMethod>,
    pub managed_config_url: Option<String>,
    pub deployment_key: Option<String>,
    pub managed_pubkey: Option<Vec<u8>>,
    pub extra_ca: Option<PathBuf>,
    pub extra_ca_source: Option<String>,
    pub extra_ca_warnings: Vec<String>,
    pub subscription_watch_secs: Option<u64>,
    pub uncharged_401_park: bool,
    pub official_entitlements: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct LoginFlags {
    pub oauth: bool,
    pub device_auth: bool,
    pub debug: bool,
    pub debug_file: Option<PathBuf>,
}

#[derive(Clone, Debug, Default)]
pub struct SetupFlags {
    pub json: bool,
    pub debug: bool,
    pub debug_file: Option<PathBuf>,
}

pub fn official_entitlements() -> Vec<String> {
    vec![
        "grok.com browser login".into(),
        "auth.x.ai first-party OAuth client".into(),
        "xAI subscription / SuperGrok billing".into(),
        "auto-topup and prepaid wallet".into(),
        "official team/organization entitlements".into(),
        "compiled-in official managed-config signing key".into(),
    ]
}

pub fn auth_json_path(grok_home: &Path, env: &BTreeMap<String, String>) -> PathBuf {
    match env.get("GROK_AUTH_PATH").map(String::as_str) {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => grok_home.join(AUTH_FILE_NAME),
    }
}

pub fn parse_token_output(stdout: &str, status_ok: bool) -> Result<AuthRecord, String> {
    if !status_ok {
        return Err("external auth provider failed".into());
    }
    let stdout = stdout.trim();
    if stdout.is_empty() {
        return Err("external auth provider produced no output on stdout".into());
    }
    if stdout.starts_with('{') {
        let parsed: JsonValue = serde_json::from_str(stdout)
            .map_err(|error| format!("produced JSON that is not a token payload: {error}"))?;
        let access = parsed
            .get("access_token")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "produced JSON with an empty access_token".to_string())?;
        reject_control_chars(access)?;
        let ttl = parsed.get("expires_in").and_then(JsonValue::as_u64);
        return Ok(AuthRecord {
            method: "external".into(),
            access_token: access.to_string(),
            refresh_token: parsed
                .get("refresh_token")
                .and_then(JsonValue::as_str)
                .map(str::to_string),
            expires_at: ttl.and_then(expiry_after_seconds),
            issuer: parsed
                .get("issuer")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            client_id: None,
            team_id: peek_team_id(access),
            label: None,
        });
    }
    reject_control_chars(stdout)?;
    Ok(AuthRecord {
        method: "external".into(),
        access_token: stdout.to_string(),
        refresh_token: None,
        expires_at: None,
        issuer: None,
        client_id: None,
        team_id: peek_team_id(stdout),
        label: None,
    })
}

fn reject_control_chars(token: &str) -> Result<(), String> {
    if token.contains(char::is_control) {
        return Err("token contains control characters".into());
    }
    Ok(())
}

fn expiry_after_seconds(secs: u64) -> Option<u64> {
    now_unix().checked_add(secs)
}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn peek_team_id(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .ok()?;
    let value: JsonValue = serde_json::from_slice(&bytes).ok()?;
    if value.get("principal_type").and_then(JsonValue::as_str) == Some("Team") {
        value
            .get("principal_id")
            .and_then(JsonValue::as_str)
            .map(str::to_string)
    } else {
        value
            .get("team_id")
            .and_then(JsonValue::as_str)
            .map(str::to_string)
    }
}

pub fn read_auth_json(path: &Path) -> io::Result<Option<AuthRecord>> {
    match fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(None),
        Ok(text) => {
            tighten_owner_only(path);
            parse_auth_file(&text)
                .map(Some)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn parse_auth_file(text: &str) -> Result<AuthRecord, String> {
    let value: JsonValue =
        serde_json::from_str(text).map_err(|error| format!("corrupt auth.json: {error}"))?;
    if let Some(token) = value.get("access_token").and_then(JsonValue::as_str) {
        return Ok(AuthRecord {
            method: value
                .get("method")
                .and_then(JsonValue::as_str)
                .unwrap_or("session")
                .to_string(),
            access_token: token.to_string(),
            refresh_token: value
                .get("refresh_token")
                .and_then(JsonValue::as_str)
                .map(str::to_string),
            expires_at: value.get("expires_at").and_then(JsonValue::as_u64),
            issuer: value
                .get("issuer")
                .and_then(JsonValue::as_str)
                .map(str::to_string),
            client_id: value
                .get("client_id")
                .and_then(JsonValue::as_str)
                .map(str::to_string),
            team_id: value
                .get("team_id")
                .and_then(JsonValue::as_str)
                .map(str::to_string)
                .or_else(|| peek_team_id(token)),
            label: value
                .get("label")
                .and_then(JsonValue::as_str)
                .map(str::to_string),
        });
    }
    Err("auth.json has no access_token".into())
}

pub fn write_auth_json(path: &Path, record: &AuthRecord) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(&json!({
        "version": 1,
        "method": record.method,
        "access_token": record.access_token,
        "refresh_token": record.refresh_token,
        "expires_at": record.expires_at,
        "issuer": record.issuer,
        "client_id": record.client_id,
        "team_id": record.team_id,
        "label": record.label,
    }))
    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    atomic_write(path, body.as_bytes(), 0o600)
}

fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    let mut file = options.open(&tmp)?;
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()?;
    fs::rename(&tmp, path)?;
    tighten_owner_only(path);
    Ok(())
}

fn tighten_owner_only(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = fs::metadata(path) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(0o600);
            let _ = fs::set_permissions(path, permissions);
        }
    }
}

pub fn clear_auth_json(path: &Path) -> io::Result<bool> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub fn session_usable(record: &AuthRecord, early_secs: u64, now: u64) -> bool {
    match record.expires_at {
        Some(expires) => now + early_secs < expires,
        None => true,
    }
}

pub fn parse_force_login_team(raw: &str) -> Option<ForceLoginTeam> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('[') {
        return match serde_json::from_str::<Vec<String>>(trimmed) {
            Ok(teams) => Some(ForceLoginTeam {
                teams: teams
                    .into_iter()
                    .map(|team| team.trim().to_string())
                    .collect(),
            }),
            Err(_) => Some(ForceLoginTeam { teams: Vec::new() }),
        };
    }
    Some(ForceLoginTeam {
        teams: vec![trimmed.to_string()],
    })
}

fn env_flag(value: Option<&String>) -> Option<bool> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" | "enabled" => Some(true),
        "0" | "false" | "no" | "off" | "disabled" | "" => Some(false),
        _ => None,
    }
}

fn toml_bool(value: Option<&TomlValue>) -> Option<bool> {
    match value? {
        TomlValue::Boolean(flag) => Some(*flag),
        TomlValue::String(text) => env_flag(Some(text)),
        _ => None,
    }
}

fn toml_string(value: Option<&TomlValue>) -> Option<String> {
    value
        .and_then(TomlValue::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn section<'a>(table: &'a TomlValue, key: &str) -> Option<&'a TomlValue> {
    table.get(key).or_else(|| {
        if key == "auth" {
            table.get("grok_com_config")
        } else {
            None
        }
    })
}

fn scopes_from(value: Option<&TomlValue>, fallback: &[&str]) -> Vec<String> {
    match value {
        Some(TomlValue::Array(items)) => items
            .iter()
            .filter_map(TomlValue::as_str)
            .map(str::to_string)
            .collect(),
        Some(TomlValue::String(text)) => text
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect(),
        _ => fallback.iter().map(|item| (*item).to_string()).collect(),
    }
}

pub fn resolve_device_flow(
    r#override: TransportOverride,
    env: Option<bool>,
    config: Option<bool>,
    remote: Option<bool>,
) -> (bool, &'static str) {
    match r#override {
        TransportOverride::ForceLoopback => (false, "cli"),
        TransportOverride::ForceDevice => (true, "cli"),
        TransportOverride::None => {
            if let Some(value) = env {
                (value, "environment")
            } else if let Some(value) = config {
                (value, "config")
            } else if let Some(value) = remote {
                (value, "remote")
            } else {
                (false, "default")
            }
        }
    }
}

pub fn resolve_uncharged_401_park(env: Option<bool>, remote: Option<bool>) -> bool {
    if remote == Some(false) {
        return false;
    }
    env.unwrap_or(true)
}

fn decode_pubkey(raw: &str) -> Option<Vec<u8>> {
    let trimmed = raw.trim();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(trimmed)
        .or_else(|_| hex_decode(trimmed))
        .ok()?;
    (bytes.len() == 32).then_some(bytes)
}

fn hex_decode(raw: &str) -> Result<Vec<u8>, ()> {
    if !raw.len().is_multiple_of(2) {
        return Err(());
    }
    (0..raw.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&raw[index..index + 2], 16).map_err(|_| ()))
        .collect()
}

/// `requirements` is the locked layer. Its `disable_api_key_auth` and
/// `force_login_team_uuid` win over environment and user config, including a
/// top-level team pin. A team pin always disables API-key-only auth.
pub fn load_auth_config_layers(
    table: &TomlValue,
    requirements: Option<&TomlValue>,
    env: &BTreeMap<String, String>,
) -> AuthConfig {
    let auth = section(table, "auth");
    let req_auth = requirements.and_then(|value| section(value, "auth"));
    let endpoints = table.get("endpoints");
    let provider_command = env
        .get("GROK_AUTH_PROVIDER_COMMAND")
        .cloned()
        .filter(|value| !value.is_empty())
        .or_else(|| toml_string(auth.and_then(|value| value.get("auth_provider_command"))));
    let provider_label = env
        .get("GROK_AUTH_PROVIDER_LABEL")
        .cloned()
        .filter(|value| !value.is_empty())
        .or_else(|| toml_string(auth.and_then(|value| value.get("auth_provider_label"))));
    let token_ttl = env
        .get("GROK_AUTH_TOKEN_TTL")
        .and_then(|value| value.parse().ok())
        .or_else(|| {
            auth.and_then(|value| value.get("auth_token_ttl"))
                .and_then(TomlValue::as_integer)
                .and_then(|value| u64::try_from(value).ok())
        });
    let early = env
        .get("GROK_AUTH_EARLY_INVALIDATION_SECS")
        .and_then(|value| value.parse().ok())
        .unwrap_or(300);
    let oidc = oidc_from(
        env.get("GROK_OIDC_ISSUER").cloned(),
        env.get("GROK_OIDC_CLIENT_ID").cloned(),
        env.get("GROK_OIDC_SCOPES").cloned(),
        env.get("GROK_OIDC_AUDIENCE").cloned(),
        auth.and_then(|value| value.get("oidc")),
    );
    let oauth2 = if oidc.is_some() {
        None
    } else {
        oidc_from(
            env.get("GROK_OAUTH2_ISSUER").cloned(),
            env.get("GROK_OAUTH2_CLIENT_ID").cloned(),
            env.get("GROK_OAUTH2_SCOPES").cloned(),
            None,
            auth.and_then(|value| value.get("oauth2")),
        )
    };
    let req_disable = toml_bool(req_auth.and_then(|value| value.get("disable_api_key_auth")));
    let env_disable = env_flag(env.get("GROK_DISABLE_API_KEY_AUTH"));
    let cfg_disable = toml_bool(auth.and_then(|value| value.get("disable_api_key_auth")));
    let disable_api_key_auth = req_disable.or(env_disable).or(cfg_disable).unwrap_or(false);
    let req_team = requirements
        .and_then(|value| value.get("force_login_team_uuid"))
        .and_then(force_team_from_toml)
        .or_else(|| {
            req_auth
                .and_then(|value| value.get("force_login_team_uuid"))
                .and_then(force_team_from_toml)
        });
    let env_team = env
        .get("GROK_FORCE_LOGIN_TEAM_ID")
        .and_then(|value| parse_force_login_team(value));
    let cfg_team = table
        .get("force_login_team_uuid")
        .and_then(force_team_from_toml)
        .or_else(|| {
            auth.and_then(|value| value.get("force_login_team_uuid"))
                .and_then(force_team_from_toml)
        });
    let force_login_team = req_team.or(env_team).or(cfg_team);
    let preferred =
        match toml_string(auth.and_then(|value| value.get("preferred_method"))).as_deref() {
            Some("api_key") => Some(AuthMethod::ApiKey),
            Some("oidc") => Some(AuthMethod::Oidc),
            Some("external") => Some(AuthMethod::External),
            _ => None,
        };
    let managed_config_url = env
        .get("GROK_MANAGED_CONFIG_URL")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| toml_string(endpoints.and_then(|value| value.get("managed_config_url"))));
    let deployment_key = env
        .get("GROK_DEPLOYMENT_KEY")
        .cloned()
        .filter(|value| !value.is_empty())
        .or_else(|| toml_string(endpoints.and_then(|value| value.get("deployment_key"))));
    let managed_pubkey = env
        .get("GROK_MANAGED_CONFIG_PUBKEY")
        .and_then(|value| decode_pubkey(value))
        .or_else(|| {
            toml_string(endpoints.and_then(|value| value.get("managed_config_pubkey")))
                .and_then(|value| decode_pubkey(&value))
        });
    let extra = extra_ca::configured_bundle(env);
    let mut extra_ca_warnings = Vec::new();
    let extra_ca_path = extra.as_ref().map(|(_, path)| path.clone());
    if let Some(path) = &extra_ca_path {
        extra_ca_warnings.extend(extra_ca::load_extra_certificates(path).1);
    }
    let subscription_watch_secs = match env
        .get("GROK_SUBSCRIPTION_WATCH_INTERVAL_SECS")
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(0) => None,
        Some(secs) => Some(secs.max(5)),
        None => None,
    };
    let remote_park = toml_bool(
        table
            .get("features")
            .and_then(|value| value.get("uncharged_401_park")),
    );
    let uncharged_401_park =
        resolve_uncharged_401_park(env_flag(env.get("GROK_UNCHARGED_401_PARK")), remote_park);
    let device_env = env_flag(env.get("GROK_LOGIN_DEVICE_FLOW"));
    let device_config = toml_bool(auth.and_then(|value| value.get("login_device_flow")));
    let (use_device, transport_source) =
        resolve_device_flow(TransportOverride::None, device_env, device_config, None);
    let method = if provider_command.is_some() {
        AuthMethod::External
    } else if oidc.is_some() {
        AuthMethod::Oidc
    } else if oauth2.is_some() {
        AuthMethod::Oauth2
    } else {
        AuthMethod::ApiKey
    };
    let transport = match method {
        AuthMethod::ApiKey => Transport::None,
        AuthMethod::External => Transport::Command,
        AuthMethod::Oidc => Transport::Loopback,
        AuthMethod::Oauth2 if use_device => Transport::Device,
        AuthMethod::Oauth2 => Transport::Loopback,
    };
    AuthConfig {
        method,
        transport,
        transport_source: transport_source.into(),
        provider_command,
        provider_label,
        token_ttl,
        early_invalidation_secs: early,
        oidc,
        oauth2,
        disable_api_key_auth: disable_api_key_auth || force_login_team.is_some(),
        force_login_team,
        preferred_method: preferred,
        managed_config_url,
        deployment_key,
        managed_pubkey,
        extra_ca: extra_ca_path,
        extra_ca_source: extra.map(|(source, _)| source),
        extra_ca_warnings,
        subscription_watch_secs,
        uncharged_401_park,
        official_entitlements: official_entitlements(),
    }
}

fn oidc_from(
    env_issuer: Option<String>,
    env_client: Option<String>,
    env_scopes: Option<String>,
    env_audience: Option<String>,
    table: Option<&TomlValue>,
) -> Option<OidcIssuer> {
    let issuer = env_issuer
        .filter(|value| !value.is_empty())
        .or_else(|| toml_string(table.and_then(|value| value.get("issuer"))))?;
    let client_id = env_client
        .filter(|value| !value.is_empty())
        .or_else(|| toml_string(table.and_then(|value| value.get("client_id"))))?;
    if looks_official_issuer(&issuer) {
        return None;
    }
    let scopes = env_scopes
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .filter(|items: &Vec<String>| !items.is_empty())
        .unwrap_or_else(|| {
            scopes_from(
                table.and_then(|value| value.get("scopes")),
                DEFAULT_OIDC_SCOPES,
            )
        });
    Some(OidcIssuer {
        issuer,
        client_id,
        scopes,
        audience: env_audience
            .filter(|value| !value.is_empty())
            .or_else(|| toml_string(table.and_then(|value| value.get("audience")))),
    })
}

fn looks_official_issuer(issuer: &str) -> bool {
    let lower = issuer.trim().trim_end_matches('/').to_ascii_lowercase();
    lower == "https://auth.x.ai"
        || lower == "https://accounts.x.ai"
        || lower == "https://grok.com"
        || lower.ends_with(".x.ai")
}

fn force_team_from_toml(value: &TomlValue) -> Option<ForceLoginTeam> {
    match value {
        TomlValue::String(text) => parse_force_login_team(text),
        TomlValue::Array(items) => Some(ForceLoginTeam {
            teams: items
                .iter()
                .filter_map(TomlValue::as_str)
                .map(str::to_string)
                .collect(),
        }),
        _ => Some(ForceLoginTeam { teams: Vec::new() }),
    }
}

pub fn selected_transport(
    config: &AuthConfig,
    flags: &LoginFlags,
    remote_device: Option<bool>,
) -> Result<(Transport, &'static str), String> {
    let r#override = TransportOverride::from_flags(flags.oauth, flags.device_auth);
    match config.method {
        AuthMethod::ApiKey => {
            if flags.oauth || flags.device_auth {
                Err(format!(
                    "No substitute identity provider is configured. {OFFICIAL_LOGIN_NOTICE} Independent API-key use does not require login. Configure [auth.oidc], [auth.oauth2], or auth.auth_provider_command."
                ))
            } else {
                Ok((Transport::None, "default"))
            }
        }
        AuthMethod::External => Ok((Transport::Command, "config")),
        AuthMethod::Oidc => {
            if flags.device_auth {
                return Err(
                    "Device-code login isn't available for enterprise OIDC; using loopback would be required, and --device-auth is refused."
                        .into(),
                );
            }
            Ok((Transport::Loopback, "oidc"))
        }
        AuthMethod::Oauth2 => {
            let (use_device, source) = resolve_device_flow(
                r#override,
                None,
                Some(config.transport == Transport::Device),
                remote_device,
            );
            let source = if r#override != TransportOverride::None {
                "cli"
            } else {
                source
            };
            Ok((
                if use_device {
                    Transport::Device
                } else {
                    Transport::Loopback
                },
                source,
            ))
        }
    }
}

fn extra_bundle(config: &AuthConfig) -> Option<&Path> {
    config.extra_ca.as_deref()
}

pub fn run_external_provider(
    command: &str,
    expired: bool,
    timeout: Duration,
    ttl: Option<u64>,
) -> Result<AuthRecord, String> {
    let mut child = Command::new("sh");
    child
        .arg("-c")
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(if expired {
            Stdio::null()
        } else {
            Stdio::piped()
        });
    if expired {
        child.env("GROK_AUTH_EXPIRED", "1");
    } else {
        child.env_remove("GROK_AUTH_EXPIRED");
    }
    let mut spawned = child
        .spawn()
        .map_err(|error| format!("auth: failed to start external auth provider: {error}"))?;
    let started = Instant::now();
    loop {
        match spawned.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > timeout => {
                let _ = spawned.kill();
                let _ = spawned.wait();
                return Err(
                    "auth: external auth provider timed out (likely needs interactive auth), killing"
                        .into(),
                );
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => return Err(format!("auth: external auth provider failed: {error}")),
        }
    }
    let output = spawned
        .wait_with_output()
        .map_err(|error| format!("auth: external auth provider failed: {error}"))?;
    let mut record = parse_token_output(
        &String::from_utf8_lossy(&output.stdout),
        output.status.success(),
    )?;
    if record.expires_at.is_none()
        && let Some(secs) = ttl
    {
        record.expires_at = expiry_after_seconds(secs);
    }
    Ok(record)
}

pub fn identity_required_message(config: &AuthConfig) -> String {
    if let Some(policy) = &config.force_login_team {
        format!(
            "Organization policy requires a matching identity session for teams: {}. Independent API-key use cannot bypass this pin. Run `codsh --rust login` with a substitute identity provider.\n{OFFICIAL_LOGIN_NOTICE}",
            policy.display()
        )
    } else {
        format!(
            "Organization policy disables API-key authentication. Independent model keys cannot bypass the required identity session. Run `codsh --rust login` with a substitute identity provider.\n{OFFICIAL_LOGIN_NOTICE}"
        )
    }
}

/// API-key auth is allowed only when no org pin is set. A pin without a
/// session, or a session whose team is not on the pin, is an error.
pub fn usable_identity_session(
    config: &AuthConfig,
    record: Option<&AuthRecord>,
) -> Result<(), String> {
    if !config.disable_api_key_auth && config.force_login_team.is_none() {
        return Ok(());
    }
    let Some(record) = record else {
        return Err(identity_required_message(config));
    };
    enforce_team(config, record)
}

pub fn enforce_team(config: &AuthConfig, record: &AuthRecord) -> Result<(), String> {
    if let Some(policy) = &config.force_login_team
        && !policy.allows(record.team_id.as_deref())
    {
        return Err(format!(
            "This deployment requires logging into one of teams: {}; login returned {}",
            policy.display(),
            record.team_id.as_deref().unwrap_or("(none)")
        ));
    }
    Ok(())
}

fn persist(
    grok_home: &Path,
    env: &BTreeMap<String, String>,
    record: &AuthRecord,
) -> Result<(), String> {
    write_auth_json(&auth_json_path(grok_home, env), record).map_err(|error| error.to_string())
}

pub fn login_help() -> &'static str {
    "Sign in to a configured identity provider\n\nUsage: codsh --rust login [OPTIONS]\n\nOptions:\n      --oauth                 Use loopback OAuth/OIDC for a configured substitute issuer\n      --device-auth           Use device-code authentication for headless/remote environments [aliases: --device-code]\n      --debug                 Enable debug logging\n      --debug-file <FILE>     Write debug logs to FILE\n  -h, --help                  Print help\n      --leader-socket <PATH>  unused; dsh owns execution. Omit the flag.\n\nIndependent API-key use does not require login unless GROK_DISABLE_API_KEY_AUTH or a team pin requires an identity session. Official grok.com login is unused. Session tokens stay in $GROK_HOME/auth.json and are not transferred to model providers, MCP, Grove, or other services."
}

pub fn logout_help() -> &'static str {
    "Sign out and clear cached identity credentials\n\nUsage: codsh --rust logout [OPTIONS]\n\nOptions:\n      --debug                 Enable debug logging\n      --debug-file <FILE>     Write debug logs to FILE\n  -h, --help                  Print help\n      --leader-socket <PATH>  unused; dsh owns execution. Omit the flag.\n\nRevokes the identity session at the configured provider before clearing $GROK_HOME/auth.json. A revocation failure keeps the local session so login can recover. Model env_key/api_key values, MCP tokens, and Grove git credentials are not revoked."
}

pub fn setup_help() -> &'static str {
    "Fetch and install managed configuration from a substitute management service\n\nUsage: codsh --rust setup [OPTIONS]\n\nOptions:\n      --json                  Print the fetched configuration as JSON instead of installing it; writes nothing to $GROK_HOME\n      --debug                 Enable debug logging\n      --debug-file <FILE>     Write debug logs to FILE\n  -h, --help                  Print help\n      --leader-socket <PATH>  unused; dsh owns execution. Omit the flag.\n\nRequires GROK_MANAGED_CONFIG_URL or endpoints.managed_config_url. Official grok.com managed config is not used. Unsigned or unverifiable policy is refused."
}

pub fn run_login(
    grok_home: &Path,
    env: &BTreeMap<String, String>,
    config: &AuthConfig,
    flags: &LoginFlags,
    table: &TomlValue,
) -> Result<String, String> {
    let _ = table;
    if let Some(command) = &config.provider_command {
        let record =
            run_external_provider(command, false, Duration::from_secs(300), config.token_ttl)?;
        enforce_team(config, &record)?;
        persist(grok_home, env, &record)?;
        return Ok(format!(
            "Signed in via external provider{}. Session token is not transferred to model providers or other services.\n{OFFICIAL_LOGIN_NOTICE}",
            config
                .provider_label
                .as_deref()
                .map(|label| format!(" ({label})"))
                .unwrap_or_default()
        ));
    }
    let (transport, source) = selected_transport(config, flags, None)?;
    match transport {
        Transport::None => {
            if config.disable_api_key_auth || config.force_login_team.is_some() {
                Err(identity_required_message(config))
            } else {
                Ok(format!(
                    "Independent API-key use does not require login. Configure a substitute identity provider for OIDC/OAuth/device flows.\n{OFFICIAL_LOGIN_NOTICE}"
                ))
            }
        }
        Transport::Command => unreachable!(),
        Transport::Loopback => {
            let issuer = config
                .oidc
                .as_ref()
                .or(config.oauth2.as_ref())
                .ok_or_else(|| {
                    format!("No substitute OIDC/OAuth issuer configured. {OFFICIAL_LOGIN_NOTICE}")
                })?;
            let record = run_loopback_login(issuer, extra_bundle(config))?;
            enforce_team(config, &record)?;
            persist(grok_home, env, &record)?;
            Ok(format!(
                "Signed in via loopback OIDC/OAuth (source={source}). Session token is not transferred to model providers or other services.\n{OFFICIAL_LOGIN_NOTICE}"
            ))
        }
        Transport::Device => {
            let issuer = config.oauth2.as_ref().ok_or_else(|| {
                "Device transport is used only for configured OAuth providers; enterprise OIDC stays loopback."
                    .to_string()
            })?;
            let record = run_device_login(issuer, extra_bundle(config))?;
            enforce_team(config, &record)?;
            persist(grok_home, env, &record)?;
            Ok(format!(
                "Signed in via device-code OAuth (source={source}). Session token is not transferred to model providers or other services.\n{OFFICIAL_LOGIN_NOTICE}"
            ))
        }
    }
}

pub fn run_logout(
    grok_home: &Path,
    env: &BTreeMap<String, String>,
    dsh_home: &Path,
) -> Result<String, String> {
    let path = auth_json_path(grok_home, env);
    let record = read_auth_json(&path).map_err(|error| error.to_string())?;
    let had = record.is_some();
    let identity_revoked = if let Some(record) = record.as_ref() {
        match revoke_identity_session(env, record) {
            Ok(true) => true,
            Ok(false) => false,
            Err(error) => {
                return Err(format!(
                    "Identity provider revocation failed: {error}. Cached session was kept so login can recover."
                ));
            }
        }
    } else {
        false
    };
    clear_auth_json(&path).map_err(|error| error.to_string())?;
    let mcp = grok_home.join("mcp_credentials.json");
    let grove = grok_home.join("grove");
    let dsh_creds = dsh_home.join(".credentials.yaml");
    let identity = if !had {
        "No cached identity session to clear. Independent API-key use is unchanged."
    } else if identity_revoked {
        "Signed out. Identity provider revoked the session and the cached token was cleared."
    } else {
        "Signed out. Cached identity token cleared. No identity-provider revocation endpoint was configured."
    };
    Ok(format!(
        "{identity}\nModel API keys, {} MCP credentials, and Grove git credentials were not revoked.\n{OFFICIAL_LOGIN_NOTICE}",
        if mcp.exists() || grove.exists() || dsh_creds.exists() {
            "existing"
        } else {
            "absent"
        }
    ))
}

/// Revoke at the substitute identity provider before deleting auth.json.
/// `Ok(false)` means no endpoint was configured. `Err` keeps the local file.
fn revoke_identity_session(
    env: &BTreeMap<String, String>,
    record: &AuthRecord,
) -> Result<bool, String> {
    let explicit = env
        .get("GROK_AUTH_REVOKE_URL")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let discovered = if explicit.is_none() {
        record
            .issuer
            .as_deref()
            .filter(|issuer| !looks_official_issuer(issuer))
            .and_then(|issuer| {
                discover(issuer, None).ok().and_then(|doc| {
                    doc.get("revocation_endpoint")
                        .and_then(JsonValue::as_str)
                        .map(str::to_string)
                })
            })
    } else {
        None
    };
    let Some(url) = explicit.map(str::to_string).or(discovered) else {
        return Ok(false);
    };
    if looks_official_issuer(&url) || url.contains("grok.com") || url.contains("x.ai") {
        return Err("refusing official grok.com/x.ai revocation endpoint".into());
    }
    let token = record
        .refresh_token
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(record.access_token.as_str());
    let hint = if record
        .refresh_token
        .as_deref()
        .is_some_and(|value| !value.is_empty())
    {
        "refresh_token"
    } else {
        "access_token"
    };
    let client_id = record.client_id.as_deref().unwrap_or("");
    extra_ca::http_post_form(
        &url,
        None,
        Duration::from_secs(15),
        &[],
        &[
            ("token", token),
            ("token_type_hint", hint),
            ("client_id", client_id),
        ],
    )
    .map_err(http_err)?;
    Ok(true)
}

pub fn refresh_session(
    grok_home: &Path,
    env: &BTreeMap<String, String>,
    config: &AuthConfig,
) -> Result<Option<AuthRecord>, String> {
    let path = auth_json_path(grok_home, env);
    let Some(record) = read_auth_json(&path).map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    if session_usable(&record, config.early_invalidation_secs, now_unix()) {
        enforce_team(config, &record)?;
        return Ok(Some(record));
    }
    if let Some(command) = &config.provider_command {
        match run_external_provider(command, true, Duration::from_secs(7), config.token_ttl) {
            Ok(fresh) => {
                enforce_team(config, &fresh)?;
                persist(grok_home, env, &fresh)?;
                return Ok(Some(fresh));
            }
            Err(error) => {
                let _ = clear_auth_json(&path);
                return Err(format!(
                    "Stored identity token expired and refresh failed: {error}. Independent API-key use is unchanged."
                ));
            }
        }
    }
    if let (Some(refresh), Some(issuer)) = (&record.refresh_token, &record.issuer) {
        match refresh_oauth_token(
            issuer,
            record.client_id.as_deref().unwrap_or(""),
            refresh,
            extra_bundle(config),
        ) {
            Ok(fresh) => {
                enforce_team(config, &fresh)?;
                persist(grok_home, env, &fresh)?;
                return Ok(Some(fresh));
            }
            Err(error) => {
                let _ = clear_auth_json(&path);
                return Err(format!(
                    "Stored identity token expired and refresh failed: {error}. Independent API-key use is unchanged."
                ));
            }
        }
    }
    let _ = clear_auth_json(&path);
    Err("Stored identity token expired and cannot be refreshed. Run `codsh --rust login`.".into())
}

fn refresh_oauth_token(
    issuer: &str,
    client_id: &str,
    refresh_token: &str,
    bundle: Option<&Path>,
) -> Result<AuthRecord, String> {
    let discovery = discover(issuer, bundle)?;
    let token_url = discovery
        .get("token_endpoint")
        .and_then(JsonValue::as_str)
        .unwrap_or("");
    if token_url.is_empty() {
        return Err("OIDC discovery omitted token_endpoint".into());
    }
    let response = extra_ca::http_post_form(
        token_url,
        bundle,
        Duration::from_secs(15),
        &[],
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ],
    )
    .map_err(http_err)?;
    token_record_from_json(&response.body, issuer, client_id, "oidc")
}

fn discover(issuer: &str, bundle: Option<&Path>) -> Result<JsonValue, String> {
    let url = format!(
        "{}/.well-known/openid-configuration",
        issuer.trim_end_matches('/')
    );
    let response =
        extra_ca::http_get(&url, bundle, Duration::from_secs(15), &[]).map_err(http_err)?;
    serde_json::from_str(&response.body).map_err(|error| error.to_string())
}

fn http_err(error: HttpError) -> String {
    error.to_string()
}

fn random_token() -> String {
    let seed = format!(
        "{}:{}:{}",
        std::process::id(),
        now_unix(),
        Instant::now().elapsed().as_nanos()
    );
    let digest = Sha256::digest(seed.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn pkce(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn run_loopback_login(issuer: &OidcIssuer, bundle: Option<&Path>) -> Result<AuthRecord, String> {
    let discovery = discover(&issuer.issuer, bundle)?;
    let authorize = discovery
        .get("authorization_endpoint")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| "OIDC discovery omitted authorization_endpoint".to_string())?;
    let token_url = discovery
        .get("token_endpoint")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| "OIDC discovery omitted token_endpoint".to_string())?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("loopback bind failure: {error}"))?;
    listener
        .set_nonblocking(false)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let verifier = random_token();
    let state = random_token();
    let challenge = pkce(&verifier);
    let mut authorize_url = format!(
        "{authorize}?response_type=code&client_id={}&redirect_uri={}&code_challenge={challenge}&code_challenge_method=S256&state={state}&scope={}",
        urlencoding(&issuer.client_id),
        urlencoding(&redirect),
        urlencoding(&issuer.scopes.join(" "))
    );
    if let Some(audience) = &issuer.audience {
        authorize_url.push_str("&audience=");
        authorize_url.push_str(&urlencoding(audience));
    }
    let expected_state = state.clone();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let result = match listener.accept() {
            Ok((stream, _)) => read_callback(stream, &expected_state),
            Err(error) => Err(format!("loopback bind failure: {error}")),
        };
        let _ = tx.send(result);
    });
    eprintln!("To sign in, open this URL in your browser:\n\n  {authorize_url}\n");
    thread::sleep(Duration::from_millis(20));
    let _ = extra_ca::http_get(&authorize_url, bundle, Duration::from_secs(5), &[]);
    let code = rx
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "loopback login cancelled or timed out before authorization".to_string())??;
    let response = extra_ca::http_post_form(
        token_url,
        bundle,
        Duration::from_secs(15),
        &[],
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect),
            ("client_id", &issuer.client_id),
            ("code_verifier", &verifier),
        ],
    )
    .map_err(http_err)?;
    token_record_from_json(&response.body, &issuer.issuer, &issuer.client_id, "oidc")
}

fn read_callback(mut stream: TcpStream, expected_state: &str) -> Result<String, String> {
    use std::io::Read;
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).unwrap_or(0);
    let request = String::from_utf8_lossy(&buf[..n]);
    let line = request.lines().next().unwrap_or("");
    let path = line.split_whitespace().nth(1).unwrap_or("");
    let query = path.split_once('?').map(|(_, query)| query).unwrap_or("");
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            match key {
                "code" => code = Some(urldecode(value)),
                "state" => state = Some(urldecode(value)),
                "error" => error = Some(urldecode(value)),
                _ => {}
            }
        }
    }
    let body = if error.is_some() || code.is_none() {
        "HTTP/1.1 400 Bad Request\r\nContent-Length: 12\r\n\r\nlogin failed"
    } else {
        "HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\nlogged in ok"
    };
    let _ = stream.write_all(body.as_bytes());
    if let Some(error) = error {
        return Err(format!("authorization denied: {error}"));
    }
    if state.as_deref() != Some(expected_state) {
        return Err("OIDC state mismatch; refusing token exchange".into());
    }
    code.ok_or_else(|| "authorization response omitted code".to_string())
}

fn run_device_login(issuer: &OidcIssuer, bundle: Option<&Path>) -> Result<AuthRecord, String> {
    let code_url = format!("{}/oauth2/device/code", issuer.issuer.trim_end_matches('/'));
    let token_url = format!("{}/oauth2/token", issuer.issuer.trim_end_matches('/'));
    let response = extra_ca::http_post_form(
        &code_url,
        bundle,
        Duration::from_secs(15),
        &[],
        &[
            ("client_id", issuer.client_id.as_str()),
            ("scope", &issuer.scopes.join(" ")),
        ],
    );
    match response {
        Err(HttpError::Status(404, _)) => Err(
            "Device-code login is not available for this deployment. Try loopback login or set a model API key instead."
                .into(),
        ),
        Err(error) => Err(http_err(error)),
        Ok(body) => {
            let payload: JsonValue =
                serde_json::from_str(&body.body).map_err(|error| error.to_string())?;
            let device_code = payload
                .get("device_code")
                .and_then(JsonValue::as_str)
                .ok_or_else(|| "device-code response omitted device_code".to_string())?;
            let user_code = payload
                .get("user_code")
                .and_then(JsonValue::as_str)
                .unwrap_or("");
            if !user_code
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
            {
                return Err("Server returned invalid user_code format (expected [A-Z0-9-])".into());
            }
            let verification = payload
                .get("verification_uri_complete")
                .and_then(JsonValue::as_str)
                .or_else(|| payload.get("verification_uri").and_then(JsonValue::as_str))
                .ok_or_else(|| "device-code response omitted verification_uri".to_string())?;
            validate_verification_uri(verification)?;
            eprintln!("To sign in, open this URL in your browser:\n\n  {verification}\n");
            eprintln!("Then enter this code:\n\n  {user_code}\n\nWaiting for authorization...");
            let interval = payload
                .get("interval")
                .and_then(JsonValue::as_u64)
                .unwrap_or(1)
                .max(1);
            let expires = payload
                .get("expires_in")
                .and_then(JsonValue::as_u64)
                .unwrap_or(60);
            let deadline = Instant::now() + Duration::from_secs(expires.max(5));
            let mut wait = Duration::from_secs(interval);
            while Instant::now() < deadline {
                std::thread::sleep(wait);
                match extra_ca::http_post_form(
                    &token_url,
                    bundle,
                    Duration::from_secs(15),
                    &[],
                    &[
                        ("grant_type", DEVICE_GRANT),
                        ("device_code", device_code),
                        ("client_id", issuer.client_id.as_str()),
                    ],
                ) {
                    Ok(tokens) => {
                        return token_record_from_json(
                            &tokens.body,
                            &issuer.issuer,
                            &issuer.client_id,
                            "device",
                        );
                    }
                    Err(HttpError::Status(_, body)) => {
                        let err: JsonValue = serde_json::from_str(&body).unwrap_or(json!({}));
                        match err.get("error").and_then(JsonValue::as_str) {
                            Some("authorization_pending") => {}
                            Some("slow_down") => wait += Duration::from_secs(5),
                            Some("access_denied") => {
                                return Err(
                                    "Authorization denied. The user rejected the request.".into()
                                );
                            }
                            Some("expired_token") => {
                                return Err(
                                    "Device code expired. Run `codsh --rust login --device-auth` again."
                                        .into(),
                                );
                            }
                            Some(other) => return Err(format!("Token exchange error: {other}")),
                            None => return Err(format!("Token exchange error: {body}")),
                        }
                    }
                    Err(error) => return Err(http_err(error)),
                }
            }
            Err("Device code expired. Run `codsh --rust login --device-auth` again.".into())
        }
    }
}

fn validate_verification_uri(uri: &str) -> Result<(), String> {
    if uri.chars().any(|ch| ch.is_ascii_control()) {
        return Err("Server returned invalid verification URI".into());
    }
    if uri.starts_with("https://") {
        return Ok(());
    }
    if uri.starts_with("http://127.0.0.1") || uri.starts_with("http://localhost") {
        return Ok(());
    }
    Err("Server returned unsupported verification URI scheme".into())
}

fn token_record_from_json(
    body: &str,
    issuer: &str,
    client_id: &str,
    method: &str,
) -> Result<AuthRecord, String> {
    let payload: JsonValue = serde_json::from_str(body).map_err(|error| error.to_string())?;
    if let Some(error) = payload.get("error").and_then(JsonValue::as_str) {
        return Err(format!("Token exchange error: {error}"));
    }
    let access = payload
        .get("access_token")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| "token response omitted access_token".to_string())?;
    reject_control_chars(access)?;
    Ok(AuthRecord {
        method: method.into(),
        access_token: access.to_string(),
        refresh_token: payload
            .get("refresh_token")
            .and_then(JsonValue::as_str)
            .map(str::to_string),
        expires_at: payload
            .get("expires_in")
            .and_then(JsonValue::as_u64)
            .and_then(expiry_after_seconds),
        issuer: Some(issuer.to_string()),
        client_id: Some(client_id.to_string()),
        team_id: peek_team_id(access),
        label: None,
    })
}

fn urlencoding(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn urldecode(value: &str) -> String {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16)
        {
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Clone, Debug)]
pub struct SetupResult {
    pub message: String,
    #[allow(dead_code)]
    pub json: JsonValue,
    #[allow(dead_code)]
    pub wrote: bool,
}

pub fn run_setup(
    grok_home: &Path,
    env: &BTreeMap<String, String>,
    config: &AuthConfig,
    flags: &SetupFlags,
    fail_closed: bool,
) -> Result<SetupResult, String> {
    let Some(url) = &config.managed_config_url else {
        return Err(format!(
            "No substitute management service configured. Set GROK_MANAGED_CONFIG_URL or endpoints.managed_config_url. {OFFICIAL_LOGIN_NOTICE}"
        ));
    };
    if looks_official_issuer(url) || url.contains("grok.com") || url.contains("x.ai") {
        return Err(format!(
            "Refusing official grok.com/x.ai management endpoint. Configure a substitute. {OFFICIAL_LOGIN_NOTICE}"
        ));
    }
    let session = match refresh_session(grok_home, env, config) {
        Ok(record) => record,
        Err(_) if config.deployment_key.is_some() => None,
        Err(error) => return Err(error),
    };
    let bearer = config
        .deployment_key
        .as_deref()
        .or(session.as_ref().map(|record| record.access_token.as_str()))
        .ok_or_else(|| {
            "setup requires GROK_DEPLOYMENT_KEY or a signed-in substitute identity session"
                .to_string()
        })?;
    if let Some(policy) = &config.force_login_team
        && let Some(session) = &session
        && config.deployment_key.is_none()
        && !policy.allows(session.team_id.as_deref())
    {
        return Err(format!(
            "Organization restriction: login team {} is not allowed ({})",
            session.team_id.as_deref().unwrap_or("(none)"),
            policy.display()
        ));
    }
    let authorization = format!("Bearer {bearer}");
    let response = extra_ca::http_get(
        url,
        extra_bundle(config),
        Duration::from_secs(15),
        &[("Authorization", authorization.as_str())],
    )
    .map_err(http_err)?;
    let body: JsonValue = serde_json::from_str(&response.body)
        .map_err(|error| format!("The server returned an unexpected response. ({error})"))?;
    if flags.json {
        return Ok(SetupResult {
            message: serde_json::to_string_pretty(&body).unwrap_or_else(|_| response.body.clone()),
            json: body,
            wrote: false,
        });
    }
    let sidecar = body
        .get("signatures")
        .and_then(JsonValue::as_array)
        .and_then(|items| items.first())
        .cloned();
    let managed = body
        .get("managed_config")
        .and_then(JsonValue::as_str)
        .unwrap_or("");
    let requirements = body
        .get("requirements")
        .and_then(JsonValue::as_str)
        .unwrap_or("");
    if sidecar.is_none() {
        if fail_closed || config.managed_pubkey.is_some() {
            return Err(
                "The server's response could not be verified as authentic managed policy, so nothing was installed."
                    .into(),
            );
        }
        return Err(
            "Substitute management service returned unsigned policy; refusing to install.".into(),
        );
    }
    let sidecar = sidecar.unwrap();
    verify_signed_policy(
        &sidecar,
        managed,
        requirements,
        config.managed_pubkey.as_deref(),
        session
            .as_ref()
            .and_then(|record| record.team_id.as_deref()),
        // Missing deployment_id is not "no caller principal". Pass "" so a
        // signed payload cannot skip the check by omitting the field.
        body.get("deployment_id")
            .and_then(JsonValue::as_str)
            .or(Some("")),
        fail_closed,
    )?;
    fs::create_dir_all(grok_home).map_err(|error| error.to_string())?;
    if !managed.is_empty() {
        atomic_write(
            &grok_home.join("managed_config.toml"),
            managed.as_bytes(),
            0o600,
        )
        .map_err(|error| error.to_string())?;
    }
    if !requirements.is_empty() {
        atomic_write(
            &grok_home.join("requirements.toml"),
            requirements.as_bytes(),
            0o600,
        )
        .map_err(|error| error.to_string())?;
    }
    atomic_write(
        &grok_home.join(SIGNATURE_SIDECAR),
        serde_json::to_vec_pretty(&sidecar)
            .map_err(|error| error.to_string())?
            .as_slice(),
        0o600,
    )
    .map_err(|error| error.to_string())?;
    Ok(SetupResult {
        message: format!(
            "Installed substitute managed configuration into {}. Official grok.com policy was not used.",
            grok_home.display()
        ),
        json: body,
        wrote: true,
    })
}

fn verify_signed_policy(
    sidecar: &JsonValue,
    managed: &str,
    requirements: &str,
    pubkey: Option<&[u8]>,
    team_id: Option<&str>,
    deployment_id: Option<&str>,
    fail_closed: bool,
) -> Result<(), String> {
    let Some(key_bytes) = pubkey else {
        return Err(
            "Signature/locking requirements cannot be verified: no substitute managed_config pubkey is configured. Refusing related configuration."
                .into(),
        );
    };
    let signed_payload = sidecar
        .get("signed_payload")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| "managed policy signature omitted signed_payload".to_string())?;
    let signature = sidecar
        .get("signature")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| "managed policy signature omitted signature".to_string())?;
    let key: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| "managed_config pubkey must be 32 raw Ed25519 bytes".to_string())?;
    let verifying = VerifyingKey::from_bytes(&key)
        .map_err(|_| "managed_config pubkey is not a valid Ed25519 key".to_string())?;
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature.trim())
        .map_err(|_| "signature is not valid base64".to_string())?;
    let sig_array: [u8; 64] = sig_bytes
        .as_slice()
        .try_into()
        .map_err(|_| "signature does not verify against the provided public key".to_string())?;
    verifying
        .verify(
            signed_payload.as_bytes(),
            &Signature::from_bytes(&sig_array),
        )
        .map_err(|_| "signature does not verify against the provided public key".to_string())?;
    let payload: JsonValue = serde_json::from_str(signed_payload)
        .map_err(|_| "signed payload is not valid JSON".to_string())?;
    if payload.get("typ").and_then(JsonValue::as_str) != Some("managed-policy") {
        return Err("signed payload carries the wrong message type".into());
    }
    if payload
        .get("expires_at")
        .and_then(JsonValue::as_u64)
        .is_some_and(|expires| now_unix() > expires)
    {
        return Err("signed policy has expired".into());
    }
    if payload.get("managed_config").and_then(JsonValue::as_str) != Some(managed)
        || payload.get("requirements").and_then(JsonValue::as_str) != Some(requirements)
    {
        return Err("served policy does not match the signed payload".into());
    }
    let signed_deployment = nonempty_str(payload.get("deployment_id"));
    let signed_team = nonempty_str(payload.get("team_id"));
    let expected_deployment = nonempty_str_opt(deployment_id);
    let expected_team = nonempty_str_opt(team_id);
    // A signature is only for the caller that already has a principal.
    // Omitting deployment_id from the response, or both ids from the payload,
    // must not verify: that signature could belong to another principal.
    if expected_deployment.is_some() || expected_team.is_some() {
        let deployment_matches = match (signed_deployment, expected_deployment) {
            (Some(signed), Some(expected)) => signed == expected,
            _ => false,
        };
        let team_matches = match (signed_team, expected_team) {
            (Some(signed), Some(expected)) => signed == expected,
            _ => false,
        };
        if !deployment_matches && !team_matches {
            let signed_any = signed_deployment.or(signed_team);
            return Err(if signed_any.is_none() {
                "signed policy omits its principal".into()
            } else {
                "signed policy is bound to a different principal".into()
            });
        }
    }
    let _ = fail_closed;
    Ok(())
}

fn nonempty_str(value: Option<&JsonValue>) -> Option<&str> {
    value
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn nonempty_str_opt(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|text| !text.is_empty())
}

pub fn verify_on_disk_signature(
    grok_home: &Path,
    pubkey: Option<&[u8]>,
    fail_closed: bool,
) -> Result<(), String> {
    let sidecar_path = grok_home.join(SIGNATURE_SIDECAR);
    let locked_files = grok_home.join("managed_config.toml").exists()
        || grok_home.join("requirements.toml").exists();
    if !sidecar_path.exists() {
        if fail_closed && locked_files {
            return Err(if pubkey.is_none() {
                "Signature/locking requirements cannot be verified: fail-closed policy has no pubkey and no authentic sidecar. Refusing related configuration."
                    .into()
            } else {
                "Signature/locking requirements cannot be verified: managed policy has no authentic sidecar. Refusing related configuration."
                    .into()
            });
        }
        return Ok(());
    }
    let sidecar: JsonValue = serde_json::from_str(
        &fs::read_to_string(&sidecar_path).map_err(|error| error.to_string())?,
    )
    .map_err(|_| "managed_config.sig.json is not valid JSON".to_string())?;
    let managed = fs::read_to_string(grok_home.join("managed_config.toml")).unwrap_or_default();
    let requirements = fs::read_to_string(grok_home.join("requirements.toml")).unwrap_or_default();
    verify_signed_policy(
        &sidecar,
        &managed,
        &requirements,
        pubkey,
        None,
        None,
        fail_closed,
    )
}

pub fn inspect_auth_json(config: &AuthConfig, record: Option<&AuthRecord>) -> JsonValue {
    json!({
        "method": config.method.as_str(),
        "transport": config.transport.as_str(),
        "transportSource": config.transport_source,
        "providerLabel": config.provider_label,
        "issuer": config.oidc.as_ref().or(config.oauth2.as_ref()).map(|item| &item.issuer),
        "disableApiKeyAuth": config.disable_api_key_auth,
        "forceLoginTeam": config.force_login_team.as_ref().map(|team| team.teams.clone()),
        "managedConfigUrl": config.managed_config_url,
        "extraCaSource": config.extra_ca_source,
        "subscriptionWatchSecs": config.subscription_watch_secs,
        "uncharged401Park": config.uncharged_401_park,
        "sessionPresent": record.is_some(),
        "sessionMethod": record.map(|item| item.method.clone()),
        "sessionIssuer": record.and_then(|item| item.issuer.clone()),
        "officialEntitlementsUnavailable": config.official_entitlements,
        "sessionTransferredToExternalServices": false,
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    fn env() -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    fn serve(script: impl Fn(String) -> (u16, String, &'static str) + Send + 'static) -> String {
        // ureq 2 pools by scheme/host/port. Alternate loopback names so
        // parallel fixtures never share a key, and close each response.
        static FIXTURE_HOSTS: std::sync::atomic::AtomicUsize =
            std::sync::atomic::AtomicUsize::new(0);
        let host = if FIXTURE_HOSTS
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .is_multiple_of(2)
        {
            "127.0.0.1"
        } else {
            "localhost"
        };
        let listener = TcpListener::bind(format!("{host}:0")).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = handle_http(stream, &script);
            }
        });
        format!("http://{host}:{port}")
    }

    fn handle_http(
        mut stream: TcpStream,
        script: &impl Fn(String) -> (u16, String, &'static str),
    ) -> io::Result<()> {
        use std::io::Read;
        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf)?;
        let request = String::from_utf8_lossy(&buf[..n]);
        let line = request.lines().next().unwrap_or("").to_string();
        let (status, body, content_type) = script(line);
        let reason = if status == 200 { "OK" } else { "ERR" };
        let response = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes())?;
        let _ = stream.shutdown(std::net::Shutdown::Both);
        Ok(())
    }

    #[test]
    fn parse_token_output_json_and_bare_and_rejects_error_objects() {
        let json = parse_token_output(
            r#"{"access_token":"a","refresh_token":"r","expires_in":3600,"issuer":"https://idp.example"}"#,
            true,
        )
        .unwrap();
        assert_eq!(json.access_token, "a");
        assert_eq!(json.refresh_token.as_deref(), Some("r"));
        assert_eq!(json.issuer.as_deref(), Some("https://idp.example"));
        assert!(parse_token_output(r#"{"error":"expired"}"#, true).is_err());
        assert!(parse_token_output("tok\ninjected", true).is_err());
        assert_eq!(
            parse_token_output("bare", true).unwrap().access_token,
            "bare"
        );
        assert!(parse_token_output("token", false).is_err());
    }

    #[test]
    fn auth_json_roundtrip_is_owner_only_and_path_override() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("auth.json");
        let record = AuthRecord {
            method: "external".into(),
            access_token: "secret-token".into(),
            refresh_token: Some("refresh".into()),
            expires_at: Some(now_unix() + 60),
            issuer: Some("https://idp.example".into()),
            client_id: None,
            team_id: None,
            label: Some("Acme".into()),
        };
        write_auth_json(&path, &record).unwrap();
        let loaded = read_auth_json(&path).unwrap().unwrap();
        assert_eq!(loaded.access_token, "secret-token");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let mut env = env();
        env.insert(
            "GROK_AUTH_PATH".into(),
            dir.path().join("custom.json").display().to_string(),
        );
        assert_eq!(
            auth_json_path(dir.path(), &env),
            dir.path().join("custom.json")
        );
    }

    #[test]
    fn device_flow_cli_beats_env_config_and_oidc_stays_loopback() {
        assert_eq!(
            resolve_device_flow(
                TransportOverride::ForceLoopback,
                Some(true),
                Some(true),
                Some(true)
            ),
            (false, "cli")
        );
        assert_eq!(
            resolve_device_flow(
                TransportOverride::ForceDevice,
                Some(false),
                Some(false),
                Some(false)
            ),
            (true, "cli")
        );
        assert_eq!(
            resolve_device_flow(TransportOverride::None, Some(false), Some(true), Some(true)),
            (false, "environment")
        );
        assert_eq!(
            resolve_device_flow(TransportOverride::None, None, Some(true), Some(false)),
            (true, "config")
        );
        assert_eq!(
            resolve_device_flow(TransportOverride::None, None, None, Some(true)),
            (true, "remote")
        );
        assert_eq!(
            resolve_device_flow(TransportOverride::None, None, None, None),
            (false, "default")
        );
        let table: TomlValue = toml::from_str(
            r#"
[auth.oidc]
issuer = "http://127.0.0.1:9"
client_id = "client"
"#,
        )
        .unwrap();
        let config = load_auth_config_layers(&table, None, &env());
        let err = selected_transport(
            &config,
            &LoginFlags {
                device_auth: true,
                ..LoginFlags::default()
            },
            None,
        )
        .unwrap_err();
        assert!(err.contains("enterprise OIDC"));
    }

    #[test]
    fn uncharged_park_remote_disable_cannot_be_forced_on() {
        assert!(!resolve_uncharged_401_park(Some(true), Some(false)));
        assert!(!resolve_uncharged_401_park(Some(false), Some(true)));
        assert!(resolve_uncharged_401_park(None, None));
    }

    #[test]
    fn logout_does_not_revoke_model_or_mcp_or_grove() {
        let dir = tempfile::TempDir::new().unwrap();
        let grok = dir.path().join("grok");
        let dsh = dir.path().join("dsh");
        fs::create_dir_all(&grok).unwrap();
        fs::create_dir_all(&dsh).unwrap();
        fs::write(grok.join("auth.json"), r#"{"access_token":"sess"}"#).unwrap();
        fs::write(grok.join("mcp_credentials.json"), r#"{"keep":true}"#).unwrap();
        fs::write(dsh.join(".credentials.yaml"), "XAI_API_KEY: keep-me\n").unwrap();
        let message = run_logout(&grok, &env(), &dsh).unwrap();
        assert!(!grok.join("auth.json").exists());
        assert_eq!(
            fs::read_to_string(grok.join("mcp_credentials.json")).unwrap(),
            r#"{"keep":true}"#
        );
        assert!(
            fs::read_to_string(dsh.join(".credentials.yaml"))
                .unwrap()
                .contains("keep-me")
        );
        assert!(message.contains("not revoked"));
    }

    #[test]
    fn external_provider_login_refresh_and_expired_flag() {
        let dir = tempfile::TempDir::new().unwrap();
        let grok = dir.path().join("grok");
        fs::create_dir_all(&grok).unwrap();
        let login = r#"if [ "$GROK_AUTH_EXPIRED" = "1" ]; then printf '%s' '{"access_token":"refreshed","expires_in":60,"issuer":"https://idp.example"}'; else printf '%s' '{"access_token":"initial","refresh_token":"r","expires_in":1,"issuer":"https://idp.example"}'; fi"#;
        let table: TomlValue = toml::from_str(&format!(
            "auth_token_ttl = 1\n[auth]\nauth_provider_command = {login:?}\n"
        ))
        .unwrap();
        let mut env = env();
        env.insert("GROK_AUTH_EARLY_INVALIDATION_SECS".into(), "0".into());
        let mut config = load_auth_config_layers(&table, None, &env);
        config.provider_command = Some(login.into());
        let message = run_login(&grok, &env, &config, &LoginFlags::default(), &table).unwrap();
        assert!(message.contains("external provider"));
        let stored = read_auth_json(&grok.join("auth.json")).unwrap().unwrap();
        assert_eq!(stored.access_token, "initial");
        std::thread::sleep(Duration::from_secs(2));
        let refreshed = refresh_session(&grok, &env, &config).unwrap().unwrap();
        assert_eq!(refreshed.access_token, "refreshed");
    }

    #[test]
    fn official_issuer_is_not_a_configured_substitute() {
        let table: TomlValue = toml::from_str(
            r#"
[auth.oauth2]
issuer = "https://auth.x.ai"
client_id = "official"
"#,
        )
        .unwrap();
        let config = load_auth_config_layers(&table, None, &env());
        assert_eq!(config.method, AuthMethod::ApiKey);
        let err = run_login(
            Path::new("/tmp"),
            &env(),
            &config,
            &LoginFlags {
                oauth: true,
                ..LoginFlags::default()
            },
            &table,
        )
        .unwrap_err();
        assert!(err.contains("Official grok.com"));
    }

    #[test]
    fn loopback_oidc_against_local_fixture() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let issuer_for_thread = issuer.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = handle_http(stream, &|line: String| {
                    if line.contains("openid-configuration") {
                        (
                            200,
                            format!(
                                r#"{{"authorization_endpoint":"{issuer_for_thread}/authorize","token_endpoint":"{issuer_for_thread}/token"}}"#
                            ),
                            "application/json",
                        )
                    } else if line.contains("/authorize") {
                        let path = line.split(' ').nth(1).unwrap_or("");
                        let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
                        let mut redirect = String::new();
                        let mut state = String::new();
                        for part in query.split('&') {
                            if let Some(value) = part.strip_prefix("redirect_uri=") {
                                redirect = urldecode(value);
                            }
                            if let Some(value) = part.strip_prefix("state=") {
                                state = urldecode(value);
                            }
                        }
                        let callback = format!("{redirect}?code=abc&state={state}");
                        thread::spawn(move || {
                            for _ in 0..50 {
                                if extra_ca::http_get(
                                    &callback,
                                    None,
                                    Duration::from_millis(200),
                                    &[],
                                )
                                .is_ok()
                                {
                                    break;
                                }
                                thread::sleep(Duration::from_millis(20));
                            }
                        });
                        (200, "ok".into(), "text/plain")
                    } else if line.starts_with("POST /token") {
                        (
                            200,
                            r#"{"access_token":"oidc-token","refresh_token":"rt","expires_in":3600}"#
                                .into(),
                            "application/json",
                        )
                    } else {
                        (404, "no".into(), "text/plain")
                    }
                });
            }
        });
        let issuer = OidcIssuer {
            issuer,
            client_id: "client".into(),
            scopes: vec!["openid".into()],
            audience: None,
        };
        let record = run_loopback_login(&issuer, None).unwrap();
        assert_eq!(record.access_token, "oidc-token");
        assert_eq!(record.method, "oidc");
    }

    #[test]
    fn device_code_denied_and_expired_do_not_succeed() {
        let denied = serve(|line| {
            if line.contains("/oauth2/device/code") {
                (
                    200,
                    r#"{"device_code":"d","user_code":"ABCD-EFGH","verification_uri":"http://127.0.0.1/device","expires_in":30,"interval":1}"#.into(),
                    "application/json",
                )
            } else {
                (
                    400,
                    r#"{"error":"access_denied"}"#.into(),
                    "application/json",
                )
            }
        });
        let issuer = OidcIssuer {
            issuer: denied,
            client_id: "client".into(),
            scopes: vec!["openid".into()],
            audience: None,
        };
        let err = run_device_login(&issuer, None).unwrap_err();
        assert!(err.contains("denied"));
        let expired = serve(|line| {
            if line.contains("/oauth2/device/code") {
                (
                    200,
                    r#"{"device_code":"d","user_code":"ABCD-EFGH","verification_uri":"http://127.0.0.1/device","expires_in":30,"interval":1}"#.into(),
                    "application/json",
                )
            } else {
                (
                    400,
                    r#"{"error":"expired_token"}"#.into(),
                    "application/json",
                )
            }
        });
        let issuer = OidcIssuer {
            issuer: expired,
            client_id: "client".into(),
            scopes: vec!["openid".into()],
            audience: None,
        };
        let err = run_device_login(&issuer, None).unwrap_err();
        assert!(err.to_ascii_lowercase().contains("expired"));
    }

    #[test]
    fn device_code_pending_then_token_completes_login() {
        let polls = std::sync::atomic::AtomicUsize::new(0);
        let issuer_url = serve(move |line| {
            if line.contains("/oauth2/device/code") {
                (
                    200,
                    r#"{"device_code":"d","user_code":"ABCD-EFGH","verification_uri":"http://127.0.0.1/device","expires_in":30,"interval":1}"#.into(),
                    "application/json",
                )
            } else if polls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                (
                    400,
                    r#"{"error":"authorization_pending"}"#.into(),
                    "application/json",
                )
            } else {
                (
                    200,
                    r#"{"access_token":"device-token","refresh_token":"rt","expires_in":3600}"#
                        .into(),
                    "application/json",
                )
            }
        });
        let issuer = OidcIssuer {
            issuer: issuer_url,
            client_id: "client".into(),
            scopes: vec!["openid".into()],
            audience: None,
        };
        let record = run_device_login(&issuer, None).unwrap();
        assert_eq!(record.access_token, "device-token");
        assert_eq!(record.method, "device");
        assert_eq!(record.refresh_token.as_deref(), Some("rt"));
    }

    fn sign_policy(managed: &str, requirements: &str) -> (String, JsonValue) {
        sign_policy_for(managed, requirements, Some("dep-1"), None)
    }

    fn sign_policy_for(
        managed: &str,
        requirements: &str,
        deployment_id: Option<&str>,
        team_id: Option<&str>,
    ) -> (String, JsonValue) {
        let secret = [7u8; 32];
        let signing = SigningKey::from_bytes(&secret);
        let pubkey =
            base64::engine::general_purpose::STANDARD.encode(signing.verifying_key().to_bytes());
        let mut payload = json!({
            "typ": "managed-policy",
            "key_id": "v1",
            "expires_at": now_unix() + 3600,
            "managed_config": managed,
            "requirements": requirements,
            "fail_closed": true,
        });
        if let Some(deployment_id) = deployment_id {
            payload["deployment_id"] = json!(deployment_id);
        }
        if let Some(team_id) = team_id {
            payload["team_id"] = json!(team_id);
        }
        let payload = payload.to_string();
        let signature = signing.sign(payload.as_bytes());
        (
            pubkey,
            json!({
                "signed_payload": payload,
                "signature": base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
                "key_id": "v1",
            }),
        )
    }

    #[test]
    fn setup_installs_signed_policy_and_refuses_unverified() {
        let (pubkey, sidecar) = sign_policy("remote_fetch = false\n", "fail_closed = true\n");
        let body = json!({
            "deployment_id": "dep-1",
            "managed_config": "remote_fetch = false\n",
            "requirements": "fail_closed = true\n",
            "signatures": [sidecar],
        })
        .to_string();
        let url = serve(move |line| {
            if line.starts_with("GET /deployment/config") {
                (200, body.clone(), "application/json")
            } else {
                (404, "no".into(), "text/plain")
            }
        });
        let dir = tempfile::TempDir::new().unwrap();
        let grok = dir.path().join("grok");
        fs::create_dir_all(&grok).unwrap();
        let mut env = env();
        env.insert(
            "GROK_MANAGED_CONFIG_URL".into(),
            format!("{url}/deployment/config"),
        );
        env.insert("GROK_DEPLOYMENT_KEY".into(), "dep-key".into());
        env.insert("GROK_MANAGED_CONFIG_PUBKEY".into(), pubkey);
        let table = TomlValue::Table(toml::map::Map::new());
        let config = load_auth_config_layers(&table, None, &env);
        let result = run_setup(&grok, &env, &config, &SetupFlags::default(), true).unwrap();
        assert!(result.wrote);
        assert!(grok.join("managed_config.toml").exists());
        assert!(grok.join(SIGNATURE_SIDECAR).exists());

        let unsigned = serve(|line| {
            let _ = line;
            (
                200,
                r#"{"deployment_id":"dep-1","managed_config":"x=1\n"}"#.into(),
                "application/json",
            )
        });
        env.insert(
            "GROK_MANAGED_CONFIG_URL".into(),
            format!("{unsigned}/deployment/config"),
        );
        let config = load_auth_config_layers(&table, None, &env);
        let err = run_setup(&grok, &env, &config, &SetupFlags::default(), true).unwrap_err();
        assert!(err.to_ascii_lowercase().contains("verif") || err.contains("unsigned"));
    }

    fn setup_against(
        grok: &Path,
        env: &mut BTreeMap<String, String>,
        body: &str,
        pubkey: &str,
    ) -> Result<SetupResult, String> {
        let body = body.to_string();
        let url = serve(move |line| {
            if line.starts_with("GET /deployment/config") {
                (200, body.clone(), "application/json")
            } else {
                (404, "no".into(), "text/plain")
            }
        });
        env.insert(
            "GROK_MANAGED_CONFIG_URL".into(),
            format!("{url}/deployment/config"),
        );
        env.insert("GROK_MANAGED_CONFIG_PUBKEY".into(), pubkey.to_string());
        let table = TomlValue::Table(toml::map::Map::new());
        let config = load_auth_config_layers(&table, None, env);
        run_setup(grok, env, &config, &SetupFlags::default(), true)
    }

    #[test]
    fn signed_policy_for_another_principal_is_refused() {
        let dir = tempfile::TempDir::new().unwrap();
        let grok = dir.path().join("grok");
        fs::create_dir_all(&grok).unwrap();
        let mut env = env();
        env.insert("GROK_DEPLOYMENT_KEY".into(), "dep-key".into());
        let record = AuthRecord {
            method: "external".into(),
            access_token: "sess".into(),
            refresh_token: None,
            expires_at: Some(now_unix() + 3600),
            issuer: Some("https://idp.example".into()),
            client_id: None,
            team_id: Some("team-caller".into()),
            label: None,
        };
        write_auth_json(&grok.join("auth.json"), &record).unwrap();

        let (pubkey, other) = sign_policy_for(
            "remote_fetch = false\n",
            "fail_closed = true\n",
            Some("dep-other"),
            None,
        );
        let body = json!({
            "deployment_id": "dep-1",
            "managed_config": "remote_fetch = false\n",
            "requirements": "fail_closed = true\n",
            "signatures": [other],
        })
        .to_string();
        let err = setup_against(&grok, &mut env, &body, &pubkey).unwrap_err();
        assert!(err.contains("different principal"), "{err}");
        assert!(!grok.join("managed_config.toml").exists());

        let (pubkey, omitted) =
            sign_policy_for("remote_fetch = false\n", "fail_closed = true\n", None, None);
        let body = json!({
            "managed_config": "remote_fetch = false\n",
            "requirements": "fail_closed = true\n",
            "signatures": [omitted],
        })
        .to_string();
        let err = setup_against(&grok, &mut env, &body, &pubkey).unwrap_err();
        assert!(
            err.contains("omits its principal") || err.contains("different principal"),
            "{err}"
        );
        assert!(!grok.join("managed_config.toml").exists());
    }

    #[test]
    fn unverifiable_locked_policy_without_pubkey_or_sidecar_is_refused() {
        let dir = tempfile::TempDir::new().unwrap();
        let grok = dir.path().join("grok");
        fs::create_dir_all(&grok).unwrap();
        fs::write(grok.join("managed_config.toml"), "remote_fetch = false\n").unwrap();
        fs::write(grok.join("requirements.toml"), "fail_closed = true\n").unwrap();
        let err = verify_on_disk_signature(&grok, None, true).unwrap_err();
        assert!(
            err.to_ascii_lowercase().contains("cannot be verified")
                || err.to_ascii_lowercase().contains("unverifiable"),
            "{err}"
        );
    }

    #[test]
    fn logout_calls_identity_provider_revocation_and_recovers() {
        let revoked = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen = std::sync::Arc::clone(&revoked);
        let url = serve(move |line| {
            if line.starts_with("POST /revoke") {
                seen.store(true, std::sync::atomic::Ordering::SeqCst);
                (200, r#"{"revoked":true}"#.into(), "application/json")
            } else {
                (404, "no".into(), "text/plain")
            }
        });
        let dir = tempfile::TempDir::new().unwrap();
        let grok = dir.path().join("grok");
        let dsh = dir.path().join("dsh");
        fs::create_dir_all(&grok).unwrap();
        fs::create_dir_all(&dsh).unwrap();
        let record = AuthRecord {
            method: "oidc".into(),
            access_token: "sess".into(),
            refresh_token: Some("refresh".into()),
            expires_at: Some(now_unix() + 3600),
            issuer: Some(url.clone()),
            client_id: Some("client".into()),
            team_id: None,
            label: None,
        };
        write_auth_json(&grok.join("auth.json"), &record).unwrap();
        let mut env = env();
        env.insert("GROK_AUTH_REVOKE_URL".into(), format!("{url}/revoke"));
        let message = run_logout(&grok, &env, &dsh).unwrap();
        assert!(!grok.join("auth.json").exists());
        assert!(
            revoked.load(std::sync::atomic::Ordering::SeqCst),
            "logout must call the identity provider"
        );
        assert!(message.to_ascii_lowercase().contains("revok"), "{message}");

        write_auth_json(&grok.join("auth.json"), &record).unwrap();
        let down = serve(|line| {
            let _ = line;
            (500, "down".into(), "text/plain")
        });
        env.insert("GROK_AUTH_REVOKE_URL".into(), format!("{down}/revoke"));
        let err = run_logout(&grok, &env, &dsh).unwrap_err();
        assert!(
            err.to_ascii_lowercase().contains("revok") || err.to_ascii_lowercase().contains("fail"),
            "{err}"
        );
        assert!(
            grok.join("auth.json").exists(),
            "failed revocation must keep the local session for recovery"
        );
    }

    #[test]
    fn team_pin_rejects_wrong_session_and_empty_list_fails_closed() {
        assert!(!parse_force_login_team("[]").unwrap().allows(Some("team-a")));
        assert!(
            parse_force_login_team(r#"["team-a"]"#)
                .unwrap()
                .allows(Some("team-a"))
        );
        let mut config =
            load_auth_config_layers(&TomlValue::Table(toml::map::Map::new()), None, &env());
        config.force_login_team = parse_force_login_team("team-good");
        let record = AuthRecord {
            method: "oidc".into(),
            access_token: "x".into(),
            refresh_token: None,
            expires_at: None,
            issuer: None,
            client_id: None,
            team_id: Some("team-wrong".into()),
            label: None,
        };
        assert!(enforce_team(&config, &record).is_err());
        let mut record = record;
        assert!(usable_identity_session(&config, None).is_err());
        config.force_login_team = parse_force_login_team("[]");
        config.disable_api_key_auth = true;
        assert!(usable_identity_session(&config, None).is_err());
        let locked: TomlValue = toml::from_str(
            r#"
[auth]
disable_api_key_auth = true
force_login_team_uuid = "team-good"
"#,
        )
        .unwrap();
        let user = TomlValue::Table(toml::map::Map::new());
        let merged = load_auth_config_layers(&user, Some(&locked), &env());
        assert!(merged.disable_api_key_auth);
        assert_eq!(
            merged
                .force_login_team
                .as_ref()
                .map(|team| team.teams.clone()),
            Some(vec!["team-good".into()])
        );
        let top_level: TomlValue =
            toml::from_str(r#"force_login_team_uuid = "team-good""#).unwrap();
        let merged_top = load_auth_config_layers(&user, Some(&top_level), &env());
        assert!(merged_top.disable_api_key_auth);
        assert_eq!(
            merged_top
                .force_login_team
                .as_ref()
                .map(|team| team.teams.clone()),
            Some(vec!["team-good".into()])
        );
        let mut env_locked = env();
        env_locked.insert("GROK_DISABLE_API_KEY_AUTH".into(), "1".into());
        let from_env = load_auth_config_layers(&user, None, &env_locked);
        assert!(from_env.disable_api_key_auth);
        assert!(usable_identity_session(&from_env, None).is_err());
        record.team_id = Some("team-good".into());
        config.force_login_team = parse_force_login_team("team-good");
        assert!(usable_identity_session(&config, Some(&record)).is_ok());
    }

    #[test]
    fn subscription_zero_disables_and_entitlements_are_listed() {
        let mut env = env();
        env.insert("GROK_SUBSCRIPTION_WATCH_INTERVAL_SECS".into(), "0".into());
        let config = load_auth_config_layers(&TomlValue::Table(toml::map::Map::new()), None, &env);
        assert_eq!(config.subscription_watch_secs, None);
        assert!(
            config
                .official_entitlements
                .iter()
                .any(|item| item.contains("subscription"))
        );
    }
}
