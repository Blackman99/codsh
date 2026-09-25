//! Organization identity for remote workspaces (ticket 207).
//!
//! A remote host can require an organization identity before anyone uses its
//! codsh endpoint over SSH. The host's `[remote_access]` policy names the
//! identity provider (an OAuth 2.0 / OpenID Connect issuer), the audience that
//! stands for this workspace, the RFC 7662 introspection endpoint, and
//! optionally the teams that may connect, locked subjects, or an
//! administrator lock of the whole host. The SSH key only opens the channel;
//! the identity decides whether requests go through.
//!
//! Wire mapping: the `agent --leader stdio` proxy adds an ACP `authMethods`
//! entry (`codsh-org-identity`) to the leader's `initialize` answer and
//! refuses every other request until an `authenticate` call carries an access
//! token in `_meta."codsh/identity"`. The token is checked with the issuer's
//! introspection endpoint, never forwarded to the leader or dsh, and checked
//! again before every later request and on a timer, so an expired, revoked,
//! re-teamed, or locked identity stops working on the next real request. A
//! revoked identity also cancels the prompts it started and the connection is
//! closed. Nothing about "being logged in" in a client UI grants access.
//!
//! The client sends its identity session (ticket 189 `auth.json`) only to a
//! remote listed in its own `[[remote_identity]]` entries with the same
//! audience, and only when the remote names the same issuer the session came
//! from. Both sides append audit lines without the token (a SHA-256
//! fingerprint prefix identifies it).

use crate::auth;
use crate::extra_ca::{self, HttpError};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use toml::Value as TomlValue;

pub const METHOD_ID: &str = "codsh-org-identity";
pub const META_KEY: &str = "codsh/identity";
/// ACP's "authentication required" error code.
pub const AUTH_ERROR: i64 = -32000;
pub const REVOKED_NOTIFICATION: &str = "_codsh/remote_access_revoked";
pub const SERVER_LOG: &str = "remote-access.log";
pub const CLIENT_LOG: &str = "remote-identity.log";
const LOG_LIMIT: u64 = 1024 * 1024;
const TOKEN_LIMIT: usize = 16 * 1024;
const DEFAULT_RECHECK_SECS: u64 = 30;

// ---------------------------------------------------------------------------
// Config layers
// ---------------------------------------------------------------------------

/// `config.toml`, `managed_config.toml`, and `requirements.toml` of one
/// `$GROK_HOME`. An unreadable or invalid file is an error, not an empty layer.
#[derive(Debug, Default)]
pub struct Layers {
    pub user: Option<TomlValue>,
    pub managed: Option<TomlValue>,
    pub requirements: Option<TomlValue>,
    pub errors: Vec<String>,
}

fn read_toml(path: &Path, errors: &mut Vec<String>) -> Option<TomlValue> {
    match fs::read_to_string(path) {
        Ok(text) => match toml::from_str::<TomlValue>(&text) {
            Ok(value) => Some(value),
            Err(error) => {
                errors.push(format!("{}: {error}", path.display()));
                None
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            errors.push(format!("{}: {error}", path.display()));
            None
        }
    }
}

pub fn load_layers(grok_home: &Path) -> Layers {
    let mut errors = Vec::new();
    let user = read_toml(&grok_home.join("config.toml"), &mut errors);
    let managed = read_toml(&grok_home.join("managed_config.toml"), &mut errors);
    let requirements = read_toml(&grok_home.join("requirements.toml"), &mut errors);
    Layers {
        user,
        managed,
        requirements,
        errors,
    }
}

impl Layers {
    /// managed, then user: the table ticket 189 reads `[auth]` from.
    pub fn merged(&self) -> TomlValue {
        let mut table = toml::map::Map::new();
        for layer in [&self.managed, &self.user].into_iter().flatten() {
            if let Some(map) = layer.as_table() {
                for (key, value) in map {
                    match (table.get_mut(key), value) {
                        (Some(TomlValue::Table(existing)), TomlValue::Table(incoming)) => {
                            for (inner, inner_value) in incoming {
                                existing.insert(inner.clone(), inner_value.clone());
                            }
                        }
                        _ => {
                            table.insert(key.clone(), value.clone());
                        }
                    }
                }
            }
        }
        TomlValue::Table(table)
    }

    /// `[remote_access] <key>`: requirements win, then managed, then user.
    fn access_value(&self, key: &str) -> Option<(&TomlValue, &'static str)> {
        for (layer, source) in [
            (&self.requirements, "requirements.toml"),
            (&self.managed, "managed_config.toml"),
            (&self.user, "config.toml"),
        ] {
            if let Some(value) = layer
                .as_ref()
                .and_then(|table| table.get("remote_access"))
                .and_then(|table| table.get(key))
            {
                return Some((value, source));
            }
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Server policy
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccessPolicy {
    pub issuer: String,
    pub audience: String,
    pub introspection_url: String,
    pub introspection_client_id: Option<String>,
    pub introspection_secret_file: Option<PathBuf>,
    pub teams: Vec<String>,
    pub deny_subjects: Vec<String>,
    pub recheck: Duration,
    pub applies_to_all: bool,
    /// Where `identity = "required"` came from.
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyState {
    /// No identity requirement; plain SSH-key remote access (ticket 190).
    Off,
    Required(AccessPolicy),
    /// An administrator locked remote access to this host.
    Locked {
        message: String,
        source: String,
        applies_to_all: bool,
    },
    /// The policy asks for identity but cannot be enforced: fail closed.
    Invalid(String),
}

fn string_of(value: &TomlValue) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn strings_of(value: &TomlValue) -> Option<Vec<String>> {
    match value {
        TomlValue::String(text) => Some(vec![text.trim().to_string()]),
        TomlValue::Array(items) => items
            .iter()
            .map(|item| item.as_str().map(|text| text.trim().to_string()))
            .collect(),
        _ => None,
    }
    .map(|items| items.into_iter().filter(|item| !item.is_empty()).collect())
}

pub fn normalize_issuer(issuer: &str) -> String {
    issuer.trim().trim_end_matches('/').to_string()
}

fn official_host(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    ["x.ai", "grok.com"].iter().any(|host| {
        lower.contains(&format!("://{host}"))
            || lower.contains(&format!(".{host}/"))
            || lower.contains(&format!(".{host}:"))
            || lower.ends_with(&format!(".{host}"))
    })
}

fn http_url(url: &str) -> bool {
    url.starts_with("https://")
        || url.starts_with("http://127.0.0.1")
        || url.starts_with("http://localhost")
        || url.starts_with("http://[::1]")
}

pub fn policy_from_layers(layers: &Layers) -> PolicyState {
    let applies_to_all = matches!(
        layers
            .access_value("applies_to")
            .and_then(|(value, _)| string_of(value))
            .as_deref(),
        Some("all")
    );
    let locked = layers.access_value("locked");
    if let Some((value, source)) = locked {
        match value.as_bool() {
            Some(true) => {
                let message = layers
                    .access_value("lock_message")
                    .and_then(|(value, _)| string_of(value))
                    .unwrap_or_else(|| {
                        "remote access to this host is locked by an administrator".into()
                    });
                return PolicyState::Locked {
                    message,
                    source: source.into(),
                    applies_to_all,
                };
            }
            Some(false) => {}
            None => {
                return PolicyState::Invalid(format!(
                    "[remote_access] locked in {source} must be true or false"
                ));
            }
        }
    }
    let Some((identity, source)) = layers.access_value("identity") else {
        return PolicyState::Off;
    };
    match identity.as_str() {
        Some("off") => return PolicyState::Off,
        Some("required") => {}
        _ => {
            return PolicyState::Invalid(format!(
                "[remote_access] identity in {source} must be \"required\" or \"off\""
            ));
        }
    }
    let required = |key: &str| -> Result<String, String> {
        layers
            .access_value(key)
            .and_then(|(value, _)| string_of(value))
            .ok_or_else(|| format!("[remote_access] identity = \"required\" needs {key}"))
    };
    let issuer = match required("issuer") {
        Ok(value) => normalize_issuer(&value),
        Err(error) => return PolicyState::Invalid(error),
    };
    let audience = match required("audience") {
        Ok(value) => value,
        Err(error) => return PolicyState::Invalid(error),
    };
    let introspection_url = match required("introspection_url") {
        Ok(value) => value,
        Err(error) => return PolicyState::Invalid(error),
    };
    for (name, url) in [
        ("issuer", &issuer),
        ("introspection_url", &introspection_url),
    ] {
        if !http_url(url) {
            return PolicyState::Invalid(format!(
                "[remote_access] {name} must be https (plain http only on loopback): {url}"
            ));
        }
        if official_host(url) {
            return PolicyState::Invalid(format!(
                "[remote_access] {name} names an official grok.com/x.ai service, which is not a substitute: {url}"
            ));
        }
    }
    let list = |key: &str| -> Result<Vec<String>, String> {
        match layers.access_value(key) {
            None => Ok(Vec::new()),
            Some((value, source)) => strings_of(value).ok_or_else(|| {
                format!("[remote_access] {key} in {source} must be a list of strings")
            }),
        }
    };
    let teams = match list("teams") {
        Ok(value) => value,
        Err(error) => return PolicyState::Invalid(error),
    };
    let deny_subjects = match list("deny_subjects") {
        Ok(value) => value,
        Err(error) => return PolicyState::Invalid(error),
    };
    let recheck = match layers.access_value("recheck_secs") {
        None => DEFAULT_RECHECK_SECS,
        Some((value, source)) => match value.as_integer() {
            Some(secs) if (5..=3600).contains(&secs) => secs as u64,
            _ => {
                return PolicyState::Invalid(format!(
                    "[remote_access] recheck_secs in {source} must be an integer from 5 to 3600"
                ));
            }
        },
    };
    let introspection_client_id = layers
        .access_value("introspection_client_id")
        .and_then(|(value, _)| string_of(value));
    let introspection_secret_file = layers
        .access_value("introspection_secret_file")
        .and_then(|(value, _)| string_of(value))
        .map(PathBuf::from);
    if introspection_secret_file.is_some() != introspection_client_id.is_some() {
        return PolicyState::Invalid(
            "[remote_access] introspection_client_id and introspection_secret_file go together"
                .into(),
        );
    }
    PolicyState::Required(AccessPolicy {
        issuer,
        audience,
        introspection_url,
        introspection_client_id,
        introspection_secret_file,
        teams,
        deny_subjects,
        recheck: Duration::from_secs(recheck),
        applies_to_all,
        source: source.into(),
    })
}

/// The connection arrived through sshd (it sets SSH_CONNECTION).
pub fn over_ssh() -> bool {
    std::env::var("SSH_CONNECTION").is_ok_and(|value| !value.trim().is_empty())
}

/// The policy for this process's entry point, or `None` when nothing is
/// required here.
pub fn policy_here(grok_home: &Path) -> Option<PolicyState> {
    let layers = load_layers(grok_home);
    // A config file that cannot be read may be the one that requires
    // identity or locks the host: fail closed.
    let state = if layers.errors.is_empty() {
        policy_from_layers(&layers)
    } else {
        PolicyState::Invalid(format!(
            "remote access policy could not be read: {}",
            layers.errors.join("; ")
        ))
    };
    let applies = match &state {
        PolicyState::Off => false,
        PolicyState::Required(policy) => policy.applies_to_all || over_ssh(),
        PolicyState::Locked { applies_to_all, .. } => *applies_to_all || over_ssh(),
        PolicyState::Invalid(_) => over_ssh(),
    };
    applies.then_some(state)
}

// ---------------------------------------------------------------------------
// Verification (RFC 7662 introspection)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Principal {
    pub subject: String,
    pub team: Option<String>,
    pub expires_at: Option<u64>,
    pub client_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Denial {
    pub reason: &'static str,
    pub message: String,
}

impl Denial {
    fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }
}

pub fn fingerprint(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Unverified JWT payload. It only explains an inactive token and keeps a
/// client from sending a token to another audience; access is never
/// granted from it.
fn jwt_payload(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn audiences(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(one)) => one.split(' ').map(str::to_string).collect(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn team_of(claims: &Value) -> Option<String> {
    claims
        .get("team_id")
        .or_else(|| claims.pointer("/ext/team_id"))
        .and_then(Value::as_str)
        .filter(|team| !team.is_empty())
        .map(str::to_string)
}

fn introspection_auth(policy: &AccessPolicy) -> Result<Option<String>, Denial> {
    let (Some(client), Some(file)) = (
        &policy.introspection_client_id,
        &policy.introspection_secret_file,
    ) else {
        return Ok(None);
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = fs::metadata(file)
            && metadata.permissions().mode() & 0o077 != 0
        {
            return Err(Denial::new(
                "policy_invalid",
                format!(
                    "the introspection secret {} is readable by other users; make it owner-only (chmod 600)",
                    file.display()
                ),
            ));
        }
    }
    let secret = fs::read_to_string(file).map_err(|error| {
        Denial::new(
            "policy_invalid",
            format!(
                "the introspection secret {} cannot be read: {error}",
                file.display()
            ),
        )
    })?;
    let pair = format!("{client}:{}", secret.trim());
    Ok(Some(format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(pair)
    )))
}

/// Check an access token against the host's policy with the issuer's
/// introspection endpoint. The message never contains the token.
pub fn verify(policy: &AccessPolicy, token: &str, now: u64) -> Result<Principal, Denial> {
    if token.is_empty()
        || token.len() > TOKEN_LIMIT
        || token
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err(Denial::new(
            "malformed",
            "the identity token is empty, too long, or contains whitespace or control characters",
        ));
    }
    let auth_header = introspection_auth(policy)?;
    let mut headers: Vec<(&str, &str)> = vec![("Accept", "application/json")];
    if let Some(value) = auth_header.as_deref() {
        headers.push(("Authorization", value));
    }
    let response = extra_ca::http_post_form(
        &policy.introspection_url,
        None,
        Duration::from_secs(10),
        &headers,
        &[("token", token), ("token_type_hint", "access_token")],
    )
    .map_err(|error| {
        let detail = match error {
            HttpError::Status(status, _) => format!("HTTP {status}"),
            other => other.to_string(),
        };
        Denial::new(
            "identity_unavailable",
            format!(
                "the identity provider's introspection endpoint could not confirm the token ({detail}); access fails closed"
            ),
        )
    })?;
    let claims: Value = serde_json::from_str(&response.body).map_err(|_| {
        Denial::new(
            "identity_unavailable",
            "the introspection endpoint answered with something other than JSON; access fails closed",
        )
    })?;
    if claims.get("active").and_then(Value::as_bool) != Some(true) {
        let expired = jwt_payload(token)
            .and_then(|payload| payload.get("exp").and_then(Value::as_u64))
            .is_some_and(|exp| exp <= now);
        return Err(if expired {
            Denial::new(
                "expired",
                "the identity token has expired; the client refreshes it, or run `codsh --rust login`",
            )
        } else {
            Denial::new(
                "inactive",
                "the identity provider reports this token inactive (revoked, logged out, or unknown); run `codsh --rust login`",
            )
        });
    }
    if let Some(kind) = claims.get("token_use").and_then(Value::as_str)
        && kind != "access_token"
    {
        return Err(Denial::new(
            "wrong_token_type",
            format!("a {kind} is not an access token"),
        ));
    }
    if let Some(exp) = claims.get("exp").and_then(Value::as_u64)
        && exp <= now
    {
        return Err(Denial::new(
            "expired",
            "the identity token has expired; the client refreshes it, or run `codsh --rust login`",
        ));
    }
    let iss = claims.get("iss").and_then(Value::as_str).unwrap_or("");
    if normalize_issuer(iss) != policy.issuer {
        return Err(Denial::new(
            "issuer",
            format!(
                "the token was issued by {}, not by this host's identity provider {}",
                if iss.is_empty() {
                    "an unnamed issuer"
                } else {
                    iss
                },
                policy.issuer
            ),
        ));
    }
    let granted = audiences(claims.get("aud"));
    if !granted.iter().any(|aud| aud == &policy.audience) {
        return Err(Denial::new(
            "audience",
            format!(
                "the token is not issued for this workspace ({}); it is for {}",
                policy.audience,
                if granted.is_empty() {
                    "no audience".to_string()
                } else {
                    granted.join(", ")
                }
            ),
        ));
    }
    let subject = claims
        .get("sub")
        .and_then(Value::as_str)
        .filter(|sub| !sub.is_empty())
        .ok_or_else(|| Denial::new("malformed", "the introspection answer names no subject"))?
        .to_string();
    if policy.deny_subjects.iter().any(|denied| denied == &subject) {
        return Err(Denial::new(
            "locked_user",
            format!("an administrator locked remote access for {subject} on this host"),
        ));
    }
    let team = team_of(&claims);
    if !policy.teams.is_empty()
        && !team
            .as_ref()
            .is_some_and(|team| policy.teams.contains(team))
    {
        return Err(Denial::new(
            "team",
            format!(
                "{subject} belongs to {}, but this host admits teams: {}",
                team.as_deref().unwrap_or("no team"),
                policy.teams.join(", ")
            ),
        ));
    }
    Ok(Principal {
        subject,
        team,
        expires_at: claims.get("exp").and_then(Value::as_u64),
        client_id: claims
            .get("client_id")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

pub fn audit(grok_home: &Path, name: &str, mut entry: Value) {
    if fs::create_dir_all(grok_home).is_err() {
        return;
    }
    let path = grok_home.join(name);
    if fs::metadata(&path).is_ok_and(|metadata| metadata.len() > LOG_LIMIT) {
        let _ = fs::rename(&path, grok_home.join(format!("{name}.1")));
    }
    if let Some(object) = entry.as_object_mut() {
        object.insert("time".into(), json!(auth::now_unix()));
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(&path) {
        let _ = writeln!(file, "{entry}");
    }
}

fn peer() -> Value {
    std::env::var("SSH_CONNECTION")
        .ok()
        .and_then(|value| {
            let parts: Vec<&str> = value.split_whitespace().collect();
            (parts.len() >= 2).then(|| json!(format!("{}:{}", parts[0], parts[1])))
        })
        .unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------
// Proxy gate (the remote side)
// ---------------------------------------------------------------------------

pub enum Action {
    /// Send this line to the leader.
    Forward(String),
    /// Answer the client directly.
    Reply(Value),
    /// Answer the client, cancel these sessions at the leader, and close.
    Revoke {
        reply: Vec<Value>,
        cancel: Vec<String>,
    },
    Drop,
}

pub struct Gate {
    policy: AccessPolicy,
    grok_home: PathBuf,
    token: Option<String>,
    principal: Option<Principal>,
    verified_at: Option<std::time::Instant>,
    initialize_id: Option<Value>,
    failures: u32,
    /// Prompt request id -> session id, for cancel on revocation.
    prompts: BTreeMap<String, String>,
}

fn error_reply(id: &Value, denial: &Denial) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": AUTH_ERROR,
            "message": format!("Organization identity refused: {}", denial.message),
            "data": { "reason": denial.reason, "method": METHOD_ID },
        }
    })
}

/// Methods a client may call before authenticating.
fn open_method(method: &str) -> bool {
    matches!(method, "initialize" | "authenticate")
}

impl Gate {
    pub fn new(policy: AccessPolicy, grok_home: PathBuf) -> Self {
        Self {
            policy,
            grok_home,
            token: None,
            principal: None,
            verified_at: None,
            initialize_id: None,
            failures: 0,
            prompts: BTreeMap::new(),
        }
    }

    pub fn recheck_interval(&self) -> Duration {
        self.policy.recheck
    }

    fn log(&self, event: &str, method: &str, outcome: Result<&Principal, &Denial>) {
        let mut entry = json!({
            "event": event,
            "method": method,
            "peer": peer(),
            "audience": self.policy.audience,
            "issuer": self.policy.issuer,
            "token": self.token.as_deref().map(fingerprint),
        });
        match outcome {
            Ok(principal) => {
                entry["outcome"] = json!("allowed");
                entry["subject"] = json!(principal.subject);
                entry["team"] = json!(principal.team);
            }
            Err(denial) => {
                entry["outcome"] = json!("denied");
                entry["reason"] = json!(denial.reason);
                entry["subject"] = json!(self.principal.as_ref().map(|p| p.subject.clone()));
            }
        }
        audit(&self.grok_home, SERVER_LOG, entry);
    }

    fn check(&mut self, event: &str, method: &str) -> Result<(), Denial> {
        let Some(token) = self.token.clone() else {
            return Err(Denial::new(
                "auth_required",
                format!(
                    "this host requires an organization identity for {}; authenticate first",
                    self.policy.audience
                ),
            ));
        };
        let result = verify(&self.policy, &token, auth::now_unix());
        match &result {
            Ok(principal) => {
                if let Some(previous) = &self.principal
                    && previous.subject != principal.subject
                {
                    let denial = Denial::new(
                        "subject_changed",
                        "the identity changed during this connection; reconnect to switch identities",
                    );
                    self.log(event, method, Err(&denial));
                    return Err(denial);
                }
                self.log(event, method, Ok(principal));
                self.principal = Some(principal.clone());
                self.verified_at = Some(std::time::Instant::now());
                Ok(())
            }
            Err(denial) => {
                self.log(event, method, Err(denial));
                self.verified_at = None;
                Err(denial.clone())
            }
        }
    }

    /// Cancel everything this client started, report why, and close.
    fn revoke(&mut self, denial: &Denial, reply: Option<Value>) -> Action {
        let mut replies: Vec<Value> = reply.into_iter().collect();
        replies.push(json!({
            "jsonrpc": "2.0",
            "method": REVOKED_NOTIFICATION,
            "params": {
                "reason": denial.reason,
                "message": format!("Organization identity refused: {}", denial.message),
            }
        }));
        let cancel = self.prompts.values().cloned().collect::<Vec<_>>();
        self.prompts.clear();
        Action::Revoke {
            reply: replies,
            cancel,
        }
    }

    pub fn on_client(&mut self, line: &str) -> Action {
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
            return if self.principal.is_some() {
                Action::Forward(line.to_string())
            } else {
                Action::Drop
            };
        };
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string);
        let id = message.get("id").cloned();
        match (method.as_deref(), id) {
            (Some("initialize"), Some(id)) => {
                self.initialize_id = Some(id);
                Action::Forward(line.to_string())
            }
            (Some("authenticate"), Some(id)) => self.authenticate(&message, id),
            (Some(method), Some(id)) if !open_method(method) => {
                if self.principal.is_none() {
                    let denial = Denial::new(
                        "auth_required",
                        format!(
                            "this host requires an organization identity for {} before {method}; this client did not authenticate",
                            self.policy.audience
                        ),
                    );
                    self.log("request", method, Err(&denial));
                    return Action::Reply(error_reply(&id, &denial));
                }
                if method == "session/cancel" {
                    return Action::Forward(line.to_string());
                }
                match self.check("request", method) {
                    Ok(()) => {
                        if method == "session/prompt"
                            && let Some(session) =
                                message.pointer("/params/sessionId").and_then(Value::as_str)
                        {
                            self.prompts.insert(id.to_string(), session.to_string());
                        }
                        Action::Forward(line.to_string())
                    }
                    Err(denial) => self.revoke(&denial, Some(error_reply(&id, &denial))),
                }
            }
            (Some(method), None) => {
                // Notifications (session/cancel) pass only for an identity
                // that was confirmed recently.
                if self.principal.is_none() {
                    return Action::Drop;
                }
                if method == "session/cancel" || self.fresh() {
                    return Action::Forward(line.to_string());
                }
                match self.check("notification", method) {
                    Ok(()) => Action::Forward(line.to_string()),
                    Err(denial) => self.revoke(&denial, None),
                }
            }
            (None, Some(_)) => {
                // A response to a leader request (an approval answer).
                if self.principal.is_none() {
                    return Action::Drop;
                }
                if self.fresh() {
                    return Action::Forward(line.to_string());
                }
                match self.check("response", "approval") {
                    Ok(()) => Action::Forward(line.to_string()),
                    Err(denial) => self.revoke(&denial, None),
                }
            }
            _ => Action::Drop,
        }
    }

    fn fresh(&self) -> bool {
        self.verified_at
            .is_some_and(|at| at.elapsed() < self.policy.recheck)
    }

    fn authenticate(&mut self, message: &Value, id: Value) -> Action {
        let method_id = message
            .pointer("/params/methodId")
            .and_then(Value::as_str)
            .unwrap_or("");
        if method_id != METHOD_ID {
            let denial = Denial::new(
                "unknown_method",
                format!("unknown auth method {method_id:?}; this host offers {METHOD_ID}"),
            );
            return Action::Reply(error_reply(&id, &denial));
        }
        let token = message
            .pointer("/params/_meta")
            .and_then(|meta| meta.get(META_KEY))
            .and_then(|identity| identity.get("accessToken"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let previous = self.token.replace(token);
        match self.check("authenticate", "authenticate") {
            Ok(()) => {
                self.failures = 0;
                let principal = self.principal.clone().expect("checked");
                Action::Reply(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "_meta": { META_KEY: {
                        "subject": principal.subject,
                        "team": principal.team,
                        "expiresAt": principal.expires_at,
                        "audience": self.policy.audience,
                        "issuer": self.policy.issuer,
                        "recheckSecs": self.policy.recheck.as_secs(),
                    } } }
                }))
            }
            Err(denial) => {
                self.failures += 1;
                if self.principal.is_some() {
                    // A failed re-authentication does not keep the old token.
                    return self.revoke(&denial, Some(error_reply(&id, &denial)));
                }
                let _ = previous;
                self.token = None;
                if self.failures >= 3 {
                    return self.revoke(&denial, Some(error_reply(&id, &denial)));
                }
                Action::Reply(error_reply(&id, &denial))
            }
        }
    }

    /// A line from the leader. The `initialize` answer gains the auth method;
    /// finished prompts are forgotten.
    pub fn on_leader(&mut self, line: &str) -> String {
        let Ok(mut message) = serde_json::from_str::<Value>(line.trim()) else {
            return line.to_string();
        };
        if message.get("method").is_none()
            && let Some(id) = message.get("id").cloned()
        {
            self.prompts.remove(&id.to_string());
            if self.initialize_id.as_ref() == Some(&id)
                && let Some(result) = message.get_mut("result").and_then(Value::as_object_mut)
            {
                self.initialize_id = None;
                // Session ids and directories are for authenticated clients.
                if let Some(server) = result
                    .get_mut("agentCapabilities")
                    .and_then(|caps| caps.get_mut("_meta"))
                    .and_then(|meta| meta.get_mut("codsh/server"))
                    .and_then(Value::as_object_mut)
                {
                    server.remove("liveSessions");
                }
                result.insert(
                    "authMethods".into(),
                    json!([{
                        "id": METHOD_ID,
                        "name": "Organization identity",
                        "description": format!(
                            "This host admits requests only with an access token for {} from {}, checked with the identity provider on every request.",
                            self.policy.audience, self.policy.issuer
                        ),
                        "_meta": { META_KEY: {
                            "issuer": self.policy.issuer,
                            "audience": self.policy.audience,
                            "teams": self.policy.teams,
                            "recheckSecs": self.policy.recheck.as_secs(),
                        } }
                    }]),
                );
                let mut text = message.to_string();
                text.push('\n');
                return text;
            }
        }
        line.to_string()
    }

    /// The timer: confirm the identity again while connected.
    pub fn on_tick(&mut self) -> Option<Action> {
        if self.principal.is_none() || self.fresh() {
            return None;
        }
        match self.check("recheck", "timer") {
            Ok(()) => None,
            Err(denial) => Some(self.revoke(&denial, None)),
        }
    }
}

/// Answer for an entry point this host refuses outright (locked, invalid
/// policy, or an entry that cannot carry an identity).
pub fn refusal_message(state: &PolicyState) -> Option<String> {
    match state {
        PolicyState::Off | PolicyState::Required(_) => None,
        PolicyState::Locked {
            message, source, ..
        } => Some(format!(
            "Remote access refused: {message} ([remote_access] locked in {source})."
        )),
        PolicyState::Invalid(reason) => Some(format!(
            "Remote access refused: this host's organization identity policy cannot be enforced, so access fails closed: {reason}."
        )),
    }
}

/// The audit `reason` for [`refusal_message`].
pub fn refusal_reason(state: &PolicyState) -> &'static str {
    match state {
        PolicyState::Locked { .. } => "locked",
        PolicyState::Invalid(_) => "invalid_policy",
        PolicyState::Off | PolicyState::Required(_) => "refused",
    }
}

/// Serve refusals on stdin/stdout until the client leaves.
pub fn serve_refusal(message: &str, reason: &str, grok_home: &Path) -> i32 {
    use std::io::BufRead;
    audit(
        grok_home,
        SERVER_LOG,
        json!({ "event": "connect", "peer": peer(), "outcome": "denied", "reason": reason }),
    );
    eprintln!("{message}");
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if let Some(id) = value.get("id")
            && value.get("method").is_some()
        {
            let reply = json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": AUTH_ERROR, "message": message, "data": { "reason": reason } }
            });
            if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() {
                break;
            }
        }
    }
    1
}

// ---------------------------------------------------------------------------
// Client side
// ---------------------------------------------------------------------------

/// One `[[remote_identity]]` entry: send the identity session to remotes
/// whose URL starts with `target` and that ask for exactly `audience`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Destination {
    pub target: String,
    pub audience: String,
    pub source: &'static str,
}

pub fn destinations(layers: &Layers) -> Vec<Destination> {
    let mut out = Vec::new();
    for (layer, source) in [
        (&layers.requirements, "requirements.toml"),
        (&layers.managed, "managed_config.toml"),
        (&layers.user, "config.toml"),
    ] {
        if let Some(items) = layer
            .as_ref()
            .and_then(|table| table.get("remote_identity"))
            .and_then(TomlValue::as_array)
        {
            for item in items {
                if let (Some(target), Some(audience)) = (
                    item.get("target").and_then(string_of),
                    item.get("audience").and_then(string_of),
                ) {
                    out.push(Destination {
                        target,
                        audience,
                        source,
                    });
                }
            }
        }
    }
    out
}

/// `ssh://h:1/w` matches target `ssh://h:1` or `ssh://h:1/w`, not
/// `ssh://h:10` or `ssh://h:1/workspace2` against `ssh://h:1/w`.
pub fn target_matches(label: &str, target: &str) -> bool {
    let target = target.trim_end_matches('/');
    label == target
        || label
            .strip_prefix(target)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub issuer: String,
    pub audience: String,
    pub teams: Vec<String>,
}

/// The identity requirement a remote advertised in `initialize`.
pub fn offer(init: &Value) -> Option<Offer> {
    let method = init
        .get("authMethods")?
        .as_array()?
        .iter()
        .find(|method| method.get("id").and_then(Value::as_str) == Some(METHOD_ID))?;
    let meta = method
        .pointer("/_meta")
        .and_then(|meta| meta.get(META_KEY))?;
    Some(Offer {
        issuer: normalize_issuer(meta.get("issuer").and_then(Value::as_str)?),
        audience: meta.get("audience").and_then(Value::as_str)?.to_string(),
        teams: meta
            .get("teams")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// What the client decided to send, before sending it. `Debug` never
/// shows the token.
#[derive(Clone)]
pub struct Credential {
    pub token: String,
    pub audience: String,
    pub issuer: String,
    pub expires_at: Option<u64>,
    pub destination: Destination,
}

/// Pick the identity session for this remote, or explain why nothing is sent.
pub fn credential_for(
    grok_home: &Path,
    env: &BTreeMap<String, String>,
    label: &str,
    offer: &Offer,
) -> Result<Credential, String> {
    let layers = load_layers(grok_home);
    let destination = destinations(&layers)
        .into_iter()
        .find(|entry| target_matches(label, &entry.target) && entry.audience == offer.audience)
        .ok_or_else(|| {
            format!(
                "{label} requires an organization identity (audience {}, issuer {}), but this client sends its identity session only to remotes listed in [[remote_identity]] with that audience. If you trust this host with your organization identity, add to $GROK_HOME/config.toml:\n\n[[remote_identity]]\ntarget = \"{label}\"\naudience = \"{}\"\n",
                offer.audience, offer.issuer, offer.audience
            )
        })?;
    let config = auth::load_auth_config_layers(&layers.merged(), layers.requirements.as_ref(), env);
    let record = auth::refresh_session(grok_home, env, &config)
        .map_err(|error| format!("{label} requires an organization identity: {error}"))?
        .ok_or_else(|| {
            format!(
                "{label} requires an organization identity from {}; run `codsh --rust login` first (no identity session in auth.json)",
                offer.issuer
            )
        })?;
    let issuer = record
        .issuer
        .as_deref()
        .map(normalize_issuer)
        .unwrap_or_default();
    if issuer != offer.issuer {
        return Err(format!(
            "{label} requires an identity from {}, but this client's session is from {}; nothing was sent",
            offer.issuer,
            if issuer.is_empty() {
                "an external provider without an issuer".to_string()
            } else {
                issuer
            }
        ));
    }
    // A token that says whom it is for (a JWT `aud`) is not sent to a
    // remote with another audience. An opaque token is checked there.
    if let Some(claims) = jwt_payload(&record.access_token)
        && claims.get("aud").is_some()
    {
        let intended = audiences(claims.get("aud"));
        if !intended.contains(&offer.audience) {
            return Err(format!(
                "{label} requires a token for {}, but this client's identity session is for {}; nothing was sent. Log in with GROK_OIDC_AUDIENCE={} (or [auth] audience) for this remote",
                offer.audience,
                if intended.is_empty() {
                    "no audience".to_string()
                } else {
                    intended.join(", ")
                },
                offer.audience
            ));
        }
    }
    Ok(Credential {
        token: record.access_token,
        audience: offer.audience.clone(),
        issuer,
        expires_at: record.expires_at,
        destination,
    })
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Credential")
            .field("token", &fingerprint(&self.token))
            .field("audience", &self.audience)
            .field("issuer", &self.issuer)
            .field("expires_at", &self.expires_at)
            .field("destination", &self.destination)
            .finish()
    }
}

/// The `identity` part of `remote check` (ticket 207).
pub fn report(
    init: &Value,
    outcome: Result<&Option<crate::acp::RemoteIdentityLink>, &str>,
) -> Value {
    let Some(offer) = offer(init) else {
        return json!({ "required": false });
    };
    let mut out = json!({
        "required": true,
        "method": METHOD_ID,
        "issuer": offer.issuer,
        "audience": offer.audience,
        "teams": offer.teams,
    });
    match outcome {
        Ok(Some(link)) => {
            out["status"] = json!("accepted");
            out["subject"] = json!(link.subject);
            out["team"] = json!(link.team);
            out["expiresAt"] = json!(link.expires_at);
        }
        Ok(None) => out["status"] = json!("not sent"),
        Err(detail) => {
            out["status"] = json!("refused or not sent");
            out["detail"] = json!(detail);
        }
    }
    out
}

/// One line for `remote check` and `/remote`.
pub fn report_line(identity: &Value) -> String {
    if identity.get("required").and_then(Value::as_bool) != Some(true) {
        return "not required by this remote".into();
    }
    let text = |key: &str| {
        identity
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("unknown")
    };
    let wanted = format!("audience {} from {}", text("audience"), text("issuer"));
    match text("status") {
        "accepted" => format!(
            "accepted: {} (team {}) for {wanted}",
            text("subject"),
            identity
                .get("team")
                .and_then(Value::as_str)
                .unwrap_or("none")
        ),
        status => format!(
            "required ({wanted}); {status}: {}",
            identity
                .get("detail")
                .and_then(Value::as_str)
                .unwrap_or("no identity was sent")
                .lines()
                .next()
                .unwrap_or("")
        ),
    }
}

pub fn authenticate_params(credential: &Credential) -> Value {
    json!({
        "methodId": METHOD_ID,
        "_meta": { META_KEY: {
            "accessToken": credential.token,
            "audience": credential.audience,
        } }
    })
}

pub fn client_audit(
    grok_home: &Path,
    label: &str,
    credential: Option<&Credential>,
    outcome: Result<&Value, &str>,
) {
    let mut entry = json!({
        "event": "authenticate",
        "target": label,
        "audience": credential.map(|c| c.audience.clone()),
        "issuer": credential.map(|c| c.issuer.clone()),
        "destination": credential.map(|c| format!("{} ({})", c.destination.target, c.destination.source)),
        "token": credential.map(|c| fingerprint(&c.token)),
    });
    match outcome {
        Ok(result) => {
            entry["outcome"] = json!("accepted");
            entry["subject"] = result
                .pointer("/_meta")
                .and_then(|meta| meta.get(META_KEY))
                .and_then(|identity| identity.get("subject"))
                .cloned()
                .unwrap_or(Value::Null);
        }
        Err(reason) => {
            entry["outcome"] = json!("not sent or refused");
            entry["detail"] = json!(reason);
        }
    }
    audit(grok_home, CLIENT_LOG, entry);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layers(user: &str, managed: &str, requirements: &str) -> Layers {
        let parse = |text: &str| (!text.is_empty()).then(|| toml::from_str(text).unwrap());
        Layers {
            user: parse(user),
            managed: parse(managed),
            requirements: parse(requirements),
            errors: Vec::new(),
        }
    }

    const REQUIRED: &str = "[remote_access]\nidentity = \"required\"\nissuer = \"http://127.0.0.1:4444/\"\naudience = \"codsh-remote:a\"\nintrospection_url = \"http://127.0.0.1:4445/admin/oauth2/introspect\"\nteams = [\"team-a\"]\n";

    #[test]
    fn requirements_win_and_a_user_cannot_turn_identity_off() {
        let state = policy_from_layers(&layers(
            "[remote_access]\nidentity = \"off\"\n",
            "",
            REQUIRED,
        ));
        let PolicyState::Required(policy) = state else {
            panic!("{state:?}")
        };
        assert_eq!(policy.issuer, "http://127.0.0.1:4444");
        assert_eq!(policy.teams, vec!["team-a".to_string()]);
        assert_eq!(policy.source, "requirements.toml");
        assert_eq!(policy.recheck, Duration::from_secs(30));
        assert_eq!(policy_from_layers(&layers("", "", "")), PolicyState::Off);
    }

    #[test]
    fn incomplete_or_official_policies_fail_closed_and_lock_wins() {
        for bad in [
            "[remote_access]\nidentity = \"required\"\n",
            "[remote_access]\nidentity = \"yes\"\n",
            "[remote_access]\nidentity = \"required\"\nissuer = \"https://auth.x.ai\"\naudience = \"a\"\nintrospection_url = \"https://auth.x.ai/i\"\n",
            "[remote_access]\nidentity = \"required\"\nissuer = \"http://idp.example\"\naudience = \"a\"\nintrospection_url = \"http://idp.example/i\"\n",
            "[remote_access]\nlocked = \"yes\"\n",
        ] {
            assert!(
                matches!(
                    policy_from_layers(&layers(bad, "", "")),
                    PolicyState::Invalid(_)
                ),
                "{bad}"
            );
        }
        let locked = policy_from_layers(&layers(
            REQUIRED,
            "",
            "[remote_access]\nlocked = true\nlock_message = \"incident 42\"\n",
        ));
        assert!(
            matches!(locked, PolicyState::Locked { ref message, .. } if message == "incident 42")
        );
        assert!(refusal_message(&locked).unwrap().contains("incident 42"));
    }

    #[test]
    fn destinations_match_whole_path_segments() {
        assert!(target_matches("ssh://h:1/w", "ssh://h:1"));
        assert!(target_matches("ssh://h:1/w/x", "ssh://h:1/w/"));
        assert!(!target_matches("ssh://h:10/w", "ssh://h:1"));
        assert!(!target_matches("ssh://h:1/workspace2", "ssh://h:1/w"));
        let list = destinations(&layers(
            "[[remote_identity]]\ntarget = \"ssh://h:1\"\naudience = \"codsh-remote:a\"\n",
            "",
            "",
        ));
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].source, "config.toml");
    }

    #[test]
    fn offers_come_only_from_the_codsh_method() {
        let init = json!({ "authMethods": [
            { "id": "other" },
            { "id": METHOD_ID, "_meta": { META_KEY: { "issuer": "http://i/", "audience": "a", "teams": ["t"] } } }
        ] });
        assert_eq!(
            offer(&init),
            Some(Offer {
                issuer: "http://i".into(),
                audience: "a".into(),
                teams: vec!["t".into()]
            })
        );
        assert_eq!(offer(&json!({ "authMethods": [] })), None);
        assert_eq!(offer(&json!({})), None);
    }

    fn policy() -> AccessPolicy {
        let PolicyState::Required(policy) = policy_from_layers(&layers("", "", REQUIRED)) else {
            unreachable!()
        };
        policy
    }

    #[test]
    fn the_gate_refuses_everything_before_authenticate_and_never_forwards_the_token() {
        let mut gate = Gate::new(policy(), std::env::temp_dir().join("codsh-207-gate-test"));
        match gate.on_client(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#) {
            Action::Forward(line) => assert!(line.contains("initialize")),
            _ => panic!("initialize must reach the leader"),
        }
        let answered = gate.on_leader(r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#);
        let answered: Value = serde_json::from_str(&answered).unwrap();
        assert_eq!(
            offer(&answered["result"]).unwrap().audience,
            "codsh-remote:a"
        );
        match gate
            .on_client(r#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/w"}}"#)
        {
            Action::Reply(reply) => {
                assert_eq!(reply["error"]["code"], AUTH_ERROR);
                assert_eq!(reply["error"]["data"]["reason"], "auth_required");
            }
            _ => panic!("session/new must be refused before authenticate"),
        }
        assert!(matches!(
            gate.on_client(r#"{"jsonrpc":"2.0","method":"session/cancel","params":{}}"#),
            Action::Drop
        ));
        // A malformed token is refused without an introspection call, and
        // the answer does not repeat it.
        match gate.on_client(
            r#"{"jsonrpc":"2.0","id":3,"method":"authenticate","params":{"methodId":"codsh-org-identity","_meta":{"codsh/identity":{"accessToken":"secret token"}}}}"#,
        ) {
            Action::Reply(reply) => {
                assert_eq!(reply["error"]["data"]["reason"], "malformed");
                assert!(!reply.to_string().contains("secret token"));
            }
            _ => panic!("a malformed token is refused"),
        }
    }

    /// A one-shot introspection endpoint: answers `body` to each request and
    /// returns the requests it saw.
    fn introspection_server(bodies: Vec<String>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/introspect", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for body in bodies {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let read = stream.read(&mut chunk).unwrap();
                    request.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&request);
                    if let Some(head) = text.find("\r\n\r\n") {
                        let length = text[..head]
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= head + 4 + length {
                            break;
                        }
                    }
                    if read == 0 {
                        break;
                    }
                }
                seen.push(String::from_utf8_lossy(&request).into_owned());
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
            seen
        });
        (url, handle)
    }

    #[test]
    fn introspection_uses_the_owner_only_client_secret_and_fails_closed() {
        let dir = std::env::temp_dir().join(format!("codsh-207-secret-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let secret = dir.join("secret");
        fs::write(&secret, "s3cret\n").unwrap();
        let good = r#"{"active":true,"iss":"http://127.0.0.1:4444/","aud":["codsh-remote:a"],"sub":"alice","team_id":"team-a","token_use":"access_token","exp":99999999999}"#;
        let refresh = good.replace("\"access_token\"", "\"refresh_token\"");
        let unnamed = good.replace("\"iss\":\"http://127.0.0.1:4444/\",", "");
        let (url, server) = introspection_server(vec![good.into(), refresh, unnamed]);
        let mut policy = policy();
        policy.introspection_url = url;
        policy.introspection_client_id = Some("codsh-remote".into());
        policy.introspection_secret_file = Some(secret.clone());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&secret, fs::Permissions::from_mode(0o644)).unwrap();
            let denial = verify(&policy, "tok.en.one", 1).unwrap_err();
            assert_eq!(denial.reason, "policy_invalid");
            fs::set_permissions(&secret, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let principal = verify(&policy, "tok.en.one", 1).unwrap();
        assert_eq!(principal.subject, "alice");
        assert_eq!(principal.team.as_deref(), Some("team-a"));
        assert_eq!(
            verify(&policy, "tok.en.two", 1).unwrap_err().reason,
            "wrong_token_type"
        );
        let unnamed = verify(&policy, "tok.en.three", 1).unwrap_err();
        assert_eq!(unnamed.reason, "issuer");
        assert!(!unnamed.message.contains("tok.en"));
        let seen = server.join().unwrap();
        let basic = base64::engine::general_purpose::STANDARD.encode("codsh-remote:s3cret");
        assert!(seen[0].contains(&format!("Basic {basic}")), "{}", seen[0]);
        assert!(seen[0].contains("token=tok.en.one"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fingerprints_do_not_reveal_the_token() {
        let print = fingerprint("abc.def.ghi");
        assert_eq!(print.len(), 12);
        assert!(!print.contains("abc"));
    }
}
