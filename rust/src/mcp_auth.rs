//! MCP OAuth for remote servers (ticket 168): the credential store, OAuth
//! discovery, client registration, the PKCE browser login with a loopback
//! callback, token refresh, and revocation on logout.
//!
//! Tokens live in `$GROK_HOME/mcp_credentials.json` (owner-only, `0600` on
//! Unix), keyed `"<server>:<url>"` like the reference store. They are only
//! ever sent to the server they were issued for (the proxy reads them from
//! this file) and to the authorization server's token and revocation
//! endpoints. Nothing here prints or logs a token; `Debug` redacts them.

use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const CREDENTIALS_FILE: &str = "mcp_credentials.json";
/// The client name sent with dynamic client registration.
pub const CLIENT_NAME: &str = "codsh";
/// How long the loopback callback waits for the browser.
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);
/// A token this close to expiry is refreshed before use.
const EXPIRY_SKEW_SECS: u64 = 30;

/// OAuth settings of one server: `oauth_client_id` / `oauth_scopes` /
/// `oauth_client_secret_env_var`, or the `[mcp_servers.<name>.oauth]` table.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OAuthConfig {
    pub client_id: Option<String>,
    /// Name of the environment variable holding the client secret.
    pub client_secret_env: Option<String>,
    pub scopes: Vec<String>,
    pub callback_port: Option<u16>,
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default = "bearer")]
    pub token_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

fn bearer() -> String {
    "bearer".into()
}

/// One server's stored login. Field names follow the reference store
/// (`client_id`, `token_response`, `granted_scopes`, `token_received_at`);
/// the endpoint fields let the proxy refresh without rediscovery.
#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct StoredCredentials {
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_response: Option<TokenResponse>,
    #[serde(default)]
    pub granted_scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_received_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revocation_endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
}

impl std::fmt::Debug for StoredCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredCredentials")
            .field("client_id", &self.client_id)
            .field("has_token", &self.token_response.is_some())
            .field("issuer", &self.issuer)
            .finish()
    }
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

impl StoredCredentials {
    pub fn access_token(&self) -> Option<&str> {
        self.token_response
            .as_ref()
            .map(|token| token.access_token.as_str())
            .filter(|token| !token.is_empty())
    }

    /// Seconds until the access token expires; `None` when it has no expiry.
    pub fn expires_in(&self, now: u64) -> Option<i64> {
        let token = self.token_response.as_ref()?;
        let lifetime = token.expires_in?;
        let received = self.token_received_at.unwrap_or(now);
        Some(received as i64 + lifetime as i64 - now as i64)
    }

    pub fn is_expired(&self, now: u64) -> bool {
        self.expires_in(now)
            .is_some_and(|left| left <= EXPIRY_SKEW_SECS as i64)
    }

    pub fn can_refresh(&self) -> bool {
        self.token_response
            .as_ref()
            .and_then(|token| token.refresh_token.as_deref())
            .is_some_and(|token| !token.is_empty())
            && self.token_endpoint.is_some()
    }
}

/// `$GROK_HOME/mcp_credentials.json`.
pub fn credentials_path(grok_home: &Path) -> PathBuf {
    grok_home.join(CREDENTIALS_FILE)
}

/// The store key: `"<server>:<normalized url>"`.
pub fn store_key(server: &str, url: &str) -> String {
    let normalized = url::Url::parse(url)
        .map(|parsed| parsed.to_string())
        .unwrap_or_else(|_| url.to_string());
    format!("{server}:{normalized}")
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct CredentialStore {
    #[serde(flatten)]
    pub entries: BTreeMap<String, StoredCredentials>,
}

impl std::fmt::Debug for CredentialStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialStore")
            .field("entries", &self.entries.len())
            .finish()
    }
}

/// Make a credential file owner-only (a hand copy may be world-readable).
fn tighten(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path)
            && meta.permissions().mode() & 0o777 != 0o600
        {
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Write `bytes` to `path` owner-only through a temp file and a rename.
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    tighten(&tmp);
    fs::rename(&tmp, path)
}

/// A cross-process lock beside the store: `create_new` of a lock file, with
/// a stale lock (older than 30 s) taken over.
pub struct StoreLock {
    path: PathBuf,
}

impl StoreLock {
    pub fn acquire(store: &Path) -> Option<Self> {
        let path = store.with_extension("json.lock");
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Some(Self { path }),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let stale = fs::metadata(&path)
                        .and_then(|meta| meta.modified())
                        .ok()
                        .and_then(|modified| modified.elapsed().ok())
                        .is_some_and(|age| age > Duration::from_secs(30));
                    if stale {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    if Instant::now() >= deadline {
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(_) => return None,
            }
        }
    }
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

impl CredentialStore {
    pub fn load(path: &Path) -> Result<Self, String> {
        match fs::read_to_string(path) {
            Ok(text) => {
                tighten(path);
                if text.trim().is_empty() {
                    return Ok(Self::default());
                }
                serde_json::from_str(&text)
                    .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(format!("cannot read {}: {error}", path.display())),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
        write_private(path, &bytes)
            .map_err(|error| format!("cannot write {}: {error}", path.display()))
    }

    pub fn get(&self, server: &str, url: &str) -> Option<&StoredCredentials> {
        self.entries.get(&store_key(server, url))
    }

    /// Read-modify-write under the store lock, so another process's freshly
    /// rotated refresh token is never rolled back.
    pub fn update(
        path: &Path,
        mutate: impl FnOnce(&mut CredentialStore),
    ) -> Result<CredentialStore, String> {
        let _lock = StoreLock::acquire(path);
        let mut store = Self::load(path)?;
        mutate(&mut store);
        store.save(path)?;
        Ok(store)
    }

    /// Entries for `server` under any URL (a server whose URL changed).
    pub fn keys_for_server(&self, server: &str) -> Vec<String> {
        let prefix = format!("{server}:");
        self.entries
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect()
    }
}

/// Stored login state for `/mcps`, `mcp list`, and ACP `auth_status`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthState {
    /// No stored credentials.
    None,
    /// A client is registered but no token was obtained (unfinished login).
    NoToken,
    /// A usable token; `expires_in` seconds when known.
    Signed { expires_in: Option<i64> },
    /// Expired; the proxy refreshes it when `refreshable`.
    Expired { refreshable: bool },
}

pub fn auth_state(grok_home: &Path, server: &str, url: &str) -> AuthState {
    let Ok(store) = CredentialStore::load(&credentials_path(grok_home)) else {
        return AuthState::None;
    };
    match store.get(server, url) {
        None => AuthState::None,
        Some(entry) if entry.access_token().is_none() => AuthState::NoToken,
        Some(entry) if entry.is_expired(now_secs()) => AuthState::Expired {
            refreshable: entry.can_refresh(),
        },
        Some(entry) => AuthState::Signed {
            expires_in: entry.expires_in(now_secs()),
        },
    }
}

pub fn describe_state(state: &AuthState) -> Option<String> {
    match state {
        AuthState::None => None,
        AuthState::NoToken => Some("OAuth login unfinished".into()),
        AuthState::Signed { expires_in: None } => Some("OAuth signed in".into()),
        AuthState::Signed {
            expires_in: Some(left),
        } => Some(format!(
            "OAuth signed in (token expires in {})",
            human_secs(*left)
        )),
        AuthState::Expired { refreshable: true } => {
            Some("OAuth token expired (refreshed on next use)".into())
        }
        AuthState::Expired { refreshable: false } => {
            Some("OAuth token expired (sign in again)".into())
        }
    }
}

fn human_secs(secs: i64) -> String {
    let secs = secs.max(0);
    if secs >= 7200 {
        format!("{}h", secs / 3600)
    } else if secs >= 120 {
        format!("{}m", secs / 60)
    } else {
        format!("{secs}s")
    }
}

// ---------------------------------------------------------------------------
// Randomness, PKCE, encoding
// ---------------------------------------------------------------------------

pub fn random_bytes(len: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; len];
    getrandom::fill(&mut buf).map_err(|error| format!("no OS randomness: {error}"))?;
    Ok(buf)
}

pub fn base64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn random_token(len: usize) -> Result<String, String> {
    random_bytes(len).map(|bytes| base64url(&bytes))
}

pub fn pkce_challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

/// Constant-time comparison for the OAuth `state`.
fn same(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

fn form_encode(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs.iter())
        .finish()
}

pub fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// A URL for messages: no query, fragment, or user info (a configured URL
/// may carry a key in its query string).
pub fn display_url(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            parsed.set_query(None);
            parsed.set_fragment(None);
            let _ = parsed.set_password(None);
            let _ = parsed.set_username("");
            parsed.to_string()
        }
        Err(_) => "<invalid url>".into(),
    }
}

pub fn user_agent() -> String {
    format!("codsh/{}", env!("CARGO_PKG_VERSION"))
}

// ---------------------------------------------------------------------------
// HTTP helpers (redirects off: a credential never follows a redirect)
// ---------------------------------------------------------------------------

pub struct Http {
    agent: ureq::Agent,
}

#[derive(Debug)]
pub struct HttpReply {
    pub status: u16,
    pub body: String,
    pub www_authenticate: Option<String>,
}

impl Http {
    pub fn new(extra_ca: Option<&Path>) -> Result<Self, String> {
        let (agent, _) = crate::extra_ca::agent(extra_ca).map_err(|error| error.to_string())?;
        Ok(Self { agent })
    }

    fn finish(result: Result<ureq::Response, ureq::Error>, url: &str) -> Result<HttpReply, String> {
        match result {
            Ok(response) | Err(ureq::Error::Status(_, response)) => {
                let status = response.status();
                let www_authenticate = response.header("www-authenticate").map(str::to_string);
                let mut body = String::new();
                let _ = response
                    .into_reader()
                    .take(1024 * 1024)
                    .read_to_string(&mut body);
                Ok(HttpReply {
                    status,
                    body,
                    www_authenticate,
                })
            }
            Err(ureq::Error::Transport(transport)) => Err(format!(
                "cannot reach {}: {}",
                display_url(url),
                transport.kind()
            )),
        }
    }

    pub fn get_json(&self, url: &str) -> Result<HttpReply, String> {
        let result = self
            .agent
            .get(url)
            .set("Accept", "application/json")
            .set("User-Agent", &user_agent())
            .call();
        Self::finish(result, url)
    }

    pub fn post_form(
        &self,
        url: &str,
        pairs: &[(&str, &str)],
        basic: Option<(&str, &str)>,
    ) -> Result<HttpReply, String> {
        let mut request = self
            .agent
            .post(url)
            .set("Accept", "application/json")
            .set("Content-Type", "application/x-www-form-urlencoded")
            .set("User-Agent", &user_agent());
        if let Some((user, secret)) = basic {
            use base64::Engine;
            let enc = |text: &str| form_encode(&[("", text)])[1..].to_string();
            let pair = format!("{}:{}", enc(user), enc(secret));
            request = request.set(
                "Authorization",
                &format!(
                    "Basic {}",
                    base64::engine::general_purpose::STANDARD.encode(pair)
                ),
            );
        }
        Self::finish(request.send_string(&form_encode(pairs)), url)
    }

    pub fn post_json(&self, url: &str, body: &JsonValue) -> Result<HttpReply, String> {
        let result = self
            .agent
            .post(url)
            .set("Accept", "application/json")
            .set("Content-Type", "application/json")
            .set("User-Agent", &user_agent())
            .send_string(&body.to_string());
        Self::finish(result, url)
    }

    /// The unauthenticated probe: `initialize` (streamable HTTP) or a GET
    /// (SSE), to read the server's `WWW-Authenticate` challenge. Configured
    /// headers go along except `Authorization` and session placeholders.
    pub fn probe(
        &self,
        url: &str,
        sse: bool,
        headers: &BTreeMap<String, String>,
    ) -> Result<HttpReply, String> {
        let mut request = if sse {
            self.agent.get(url).set("Accept", "text/event-stream")
        } else {
            self.agent
                .post(url)
                .set("Accept", "application/json, text/event-stream")
                .set("Content-Type", "application/json")
        };
        request = request
            .set("User-Agent", &user_agent())
            .timeout(Duration::from_secs(15));
        for (name, value) in headers {
            if !name.eq_ignore_ascii_case("authorization") && !has_session_placeholder(value) {
                request = request.set(name, value);
            }
        }
        if sse {
            return match request.call() {
                // An open event stream: only the status matters.
                Ok(response) => Ok(HttpReply {
                    status: response.status(),
                    body: String::new(),
                    www_authenticate: None,
                }),
                other => Self::finish(other, url),
            };
        }
        let init = json!({
            "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": {
                "protocolVersion": PROBE_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "codsh-oauth-probe", "version": env!("CARGO_PKG_VERSION") },
            },
        });
        Self::finish(request.send_string(&init.to_string()), url)
    }
}

const PROBE_PROTOCOL_VERSION: &str = "2025-06-18";

/// `{{session_id}}` / `${session_id}` in a header value.
pub fn has_session_placeholder(value: &str) -> bool {
    value.contains("{{session_id}}") || value.contains("${session_id}")
}

fn parse_json_reply(reply: &HttpReply, what: &str) -> Result<JsonValue, String> {
    if !(200..300).contains(&reply.status) {
        let detail = serde_json::from_str::<JsonValue>(&reply.body)
            .ok()
            .and_then(|value| {
                let code = value.get("error").and_then(JsonValue::as_str)?.to_string();
                let text = value
                    .get("error_description")
                    .and_then(JsonValue::as_str)
                    .map(|text| format!(": {text}"))
                    .unwrap_or_default();
                Some(format!("{code}{text}"))
            })
            .unwrap_or_else(|| {
                if (300..400).contains(&reply.status) {
                    "redirect refused (credentials never follow a redirect)".into()
                } else {
                    reply.body.chars().take(200).collect()
                }
            });
        return Err(format!("{what} failed (HTTP {}): {detail}", reply.status));
    }
    serde_json::from_str(&reply.body)
        .map_err(|_| format!("{what} returned a body that is not JSON"))
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// `key="value"` parameters of a `WWW-Authenticate: Bearer ...` challenge.
pub fn challenge_params(header: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let trimmed = header.trim();
    let rest = if trimmed.len() >= 6 && trimmed[..6].eq_ignore_ascii_case("bearer") {
        &trimmed[6..]
    } else {
        trimmed
    };
    let mut chars = rest.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace() || *c == ',') {
            chars.next();
        }
        let key: String = std::iter::from_fn(|| chars.next_if(|c| *c != '=' && *c != ','))
            .collect::<String>()
            .trim()
            .to_ascii_lowercase();
        if key.is_empty() {
            break;
        }
        if chars.next() != Some('=') {
            continue;
        }
        let value = if chars.peek() == Some(&'"') {
            chars.next();
            let mut value = String::new();
            while let Some(c) = chars.next() {
                match c {
                    '\\' => {
                        if let Some(next) = chars.next() {
                            value.push(next);
                        }
                    }
                    '"' => break,
                    other => value.push(other),
                }
            }
            value
        } else {
            std::iter::from_fn(|| chars.next_if(|c| *c != ','))
                .collect::<String>()
                .trim()
                .to_string()
        };
        out.insert(key, value);
    }
    out
}

#[derive(Clone, Debug, PartialEq)]
pub struct Discovered {
    pub resource: String,
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    pub revocation_endpoint: Option<String>,
    pub scopes_supported: Vec<String>,
    /// Scopes the server's challenge asked for.
    pub challenge_scopes: Vec<String>,
    pub iss_parameter_required: bool,
    pub token_auth_methods: Vec<String>,
}

fn is_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// OAuth endpoints must be HTTPS, loopback HTTP, or HTTP on the MCP server's
/// own host (a plain-HTTP internal server).
fn endpoint_allowed(endpoint: &str, server: &url::Url) -> Result<url::Url, String> {
    let parsed =
        url::Url::parse(endpoint).map_err(|_| "invalid OAuth endpoint in metadata".to_string())?;
    let ok = match parsed.scheme() {
        "https" => true,
        "http" => is_loopback(&parsed) || parsed.host_str() == server.host_str(),
        _ => false,
    };
    if ok {
        Ok(parsed)
    } else {
        Err(format!(
            "refusing OAuth endpoint {} (HTTPS required off this host)",
            display_url(endpoint)
        ))
    }
}

fn strs(value: Option<&JsonValue>) -> Vec<String> {
    value
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(JsonValue::as_str)
        .map(str::to_string)
        .collect()
}

fn origin_of(url: &url::Url) -> String {
    url.origin().ascii_serialization()
}

/// The protected resource a server URL names: no fragment.
pub fn canonical_resource(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            parsed.set_fragment(None);
            parsed.to_string()
        }
        Err(_) => url.to_string(),
    }
}

/// Well-known candidates for a URL with a path: path-inserted first, then root.
fn well_known(base: &url::Url, suffix: &str) -> Vec<String> {
    let origin = origin_of(base);
    let path = base.path().trim_end_matches('/');
    let mut out = Vec::new();
    if !path.is_empty() {
        out.push(format!("{origin}/.well-known/{suffix}{path}"));
    }
    out.push(format!("{origin}/.well-known/{suffix}"));
    out
}

/// Resolve the authorization server for `server_url` from its challenge
/// (RFC 9728 protected resource metadata, then RFC 8414 / OIDC metadata).
pub fn discover(
    http: &Http,
    server_url: &str,
    challenge: Option<&str>,
) -> Result<Discovered, String> {
    let server = url::Url::parse(server_url).map_err(|_| "invalid server URL".to_string())?;
    let params = challenge.map(challenge_params).unwrap_or_default();
    let challenge_scopes: Vec<String> = params
        .get("scope")
        .map(|scope| scope.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default();
    let mut candidates = Vec::new();
    if let Some(meta) = params.get("resource_metadata") {
        let parsed = endpoint_allowed(meta, &server)?;
        candidates.push(parsed.to_string());
    }
    candidates.extend(well_known(&server, "oauth-protected-resource"));
    let mut prm = None;
    for candidate in &candidates {
        if let Ok(reply) = http.get_json(candidate)
            && reply.status == 200
            && let Ok(value) = serde_json::from_str::<JsonValue>(&reply.body)
            && value.is_object()
        {
            prm = Some(value);
            break;
        }
    }
    let named = prm
        .as_ref()
        .and_then(|prm| prm.get("resource"))
        .and_then(JsonValue::as_str);
    let resource = match named {
        Some(named) => {
            let parsed = url::Url::parse(named)
                .map_err(|_| "protected resource metadata has an invalid `resource`".to_string())?;
            let prefix = parsed.path().trim_end_matches('/');
            let covers = origin_of(&parsed) == origin_of(&server)
                && (prefix.is_empty()
                    || server.path().trim_end_matches('/') == prefix
                    || server.path().starts_with(&format!("{prefix}/")));
            if !covers {
                return Err(format!(
                    "protected resource metadata names a different resource ({}); refusing to send credentials for it",
                    display_url(named)
                ));
            }
            named.to_string()
        }
        None => canonical_resource(server_url),
    };
    let issuer = prm
        .as_ref()
        .map(|prm| strs(prm.get("authorization_servers")))
        .and_then(|servers| servers.into_iter().next())
        .unwrap_or_else(|| origin_of(&server));
    let issuer_url = endpoint_allowed(&issuer, &server)?;
    let issuer_path = issuer_url.path().trim_end_matches('/').to_string();
    let origin = origin_of(&issuer_url);
    let as_candidates = if issuer_path.is_empty() {
        vec![
            format!("{origin}/.well-known/oauth-authorization-server"),
            format!("{origin}/.well-known/openid-configuration"),
        ]
    } else {
        vec![
            format!("{origin}/.well-known/oauth-authorization-server{issuer_path}"),
            format!("{origin}/.well-known/openid-configuration{issuer_path}"),
            format!("{origin}{issuer_path}/.well-known/openid-configuration"),
        ]
    };
    let mut metadata = None;
    for candidate in &as_candidates {
        if let Ok(reply) = http.get_json(candidate)
            && reply.status == 200
            && let Ok(value) = serde_json::from_str::<JsonValue>(&reply.body)
            && value.get("authorization_endpoint").is_some()
        {
            metadata = Some(value);
            break;
        }
    }
    let Some(metadata) = metadata else {
        return Err(format!(
            "{} publishes no OAuth authorization server metadata",
            display_url(&issuer)
        ));
    };
    let norm = |text: &str| text.trim_end_matches('/').to_string();
    if let Some(named) = metadata.get("issuer").and_then(JsonValue::as_str)
        && norm(named) != norm(&issuer)
    {
        return Err(format!(
            "authorization server metadata names issuer {} instead of {}",
            display_url(named),
            display_url(&issuer)
        ));
    }
    let methods = strs(metadata.get("code_challenge_methods_supported"));
    if !methods.is_empty() && !methods.iter().any(|method| method == "S256") {
        return Err("authorization server does not support PKCE S256".into());
    }
    let field = |name: &str| -> Result<Option<String>, String> {
        match metadata.get(name).and_then(JsonValue::as_str) {
            Some(value) => endpoint_allowed(value, &server).map(|url| Some(url.to_string())),
            None => Ok(None),
        }
    };
    let authorization_endpoint = field("authorization_endpoint")?
        .ok_or("authorization server metadata has no authorization_endpoint")?;
    let token_endpoint =
        field("token_endpoint")?.ok_or("authorization server metadata has no token_endpoint")?;
    let scopes_supported = {
        let from_prm = prm
            .as_ref()
            .map(|prm| strs(prm.get("scopes_supported")))
            .unwrap_or_default();
        if from_prm.is_empty() {
            strs(metadata.get("scopes_supported"))
        } else {
            from_prm
        }
    };
    Ok(Discovered {
        resource,
        issuer: metadata
            .get("issuer")
            .and_then(JsonValue::as_str)
            .map(str::to_string)
            .unwrap_or(issuer),
        authorization_endpoint,
        token_endpoint,
        registration_endpoint: field("registration_endpoint")?,
        revocation_endpoint: field("revocation_endpoint")?,
        scopes_supported,
        challenge_scopes,
        iss_parameter_required: metadata
            .get("authorization_response_iss_parameter_supported")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false),
        token_auth_methods: strs(metadata.get("token_endpoint_auth_methods_supported")),
    })
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/// What `login` needs to know about one server.
pub struct LoginTarget<'a> {
    pub grok_home: &'a Path,
    pub server: &'a str,
    pub url: &'a str,
    pub sse: bool,
    /// Configured headers (non-secret ones are sent with the probe).
    pub headers: &'a BTreeMap<String, String>,
    pub oauth: Option<&'a OAuthConfig>,
    pub env: &'a BTreeMap<String, String>,
    pub extra_ca: Option<&'a Path>,
}

/// Progress for the surface that started the login.
pub enum LoginEvent {
    /// Open this URL (the browser was asked to; `opened` says if that worked).
    Browser { url: String, opened: bool },
}

pub struct LoginOptions {
    pub timeout: Duration,
    /// Try to open the system browser (`$BROWSER`, else the platform opener).
    pub open_browser: bool,
}

impl Default for LoginOptions {
    fn default() -> Self {
        Self {
            timeout: LOGIN_TIMEOUT,
            open_browser: true,
        }
    }
}

fn client_secret(oauth: Option<&OAuthConfig>, env: &BTreeMap<String, String>) -> Option<String> {
    let var = oauth?.client_secret_env.as_deref()?;
    env.get(var).filter(|value| !value.is_empty()).cloned()
}

/// Launch the browser: `$BROWSER` (a command; `%s` is replaced by the URL,
/// otherwise the URL is the last argument), else `open` / `xdg-open` /
/// the URL protocol handler. Only http(s) URLs are opened, and never through
/// a shell. Returns whether a launcher ran.
pub fn open_browser(url: &str, env: &BTreeMap<String, String>) -> bool {
    use std::process::{Command, Stdio};
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return false;
    }
    let spawn = |program: &str, args: Vec<String>| {
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok()
    };
    if let Some(browser) = env.get("BROWSER").filter(|value| !value.trim().is_empty()) {
        let first = browser.split(':').next().unwrap_or(browser);
        let mut words = first.split_whitespace().map(str::to_string);
        if let Some(program) = words.next() {
            let mut args: Vec<String> = words.collect();
            if args.iter().any(|arg| arg.contains("%s")) {
                for arg in &mut args {
                    *arg = arg.replace("%s", url);
                }
            } else {
                args.push(url.to_string());
            }
            return spawn(&program, args);
        }
    }
    if cfg!(target_os = "macos") {
        spawn("open", vec![url.to_string()])
    } else if cfg!(windows) {
        // Not `cmd /C start`: cmd would treat the query's `&` as a command
        // separator.
        spawn(
            "rundll32",
            vec!["url.dll,FileProtocolHandler".into(), url.to_string()],
        )
    } else {
        spawn("xdg-open", vec![url.to_string()])
    }
}

struct Callback {
    code: String,
    iss: Option<String>,
}

fn respond(stream: &mut TcpStream, status: &str, title: &str, body: &str) {
    let html = format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>{title}</title></head><body style=\"font-family: sans-serif; text-align: center; padding: 50px;\"><h1>{title}</h1><p>{body}</p><p>You can close this window and return to the terminal.</p></body></html>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.flush();
}

/// Serve the loopback callback until the browser returns (or `deadline`).
/// A redirect with another login's `state` is answered and ignored.
fn await_callback(
    listener: &TcpListener,
    state: &str,
    deadline: Instant,
    cancel: &dyn Fn() -> bool,
) -> Result<Callback, String> {
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("loopback listener: {error}"))?;
    loop {
        if Instant::now() >= deadline {
            return Err("timed out waiting for the browser to finish the OAuth login".into());
        }
        if cancel() {
            return Err("OAuth login cancelled".into());
        }
        let (mut stream, _) = match listener.accept() {
            Ok(pair) => pair,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(25));
                continue;
            }
            Err(error) => return Err(format!("loopback listener: {error}")),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let Ok(clone) = stream.try_clone() else {
            continue;
        };
        let mut reader = BufReader::new(clone);
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            continue;
        }
        loop {
            let mut header = String::new();
            match reader.read_line(&mut header) {
                Ok(0) | Err(_) => break,
                Ok(_) if header == "\r\n" || header == "\n" => break,
                Ok(_) => {}
            }
        }
        let target = line.split_whitespace().nth(1).unwrap_or("");
        let Ok(parsed) = url::Url::parse(&format!("http://127.0.0.1{target}")) else {
            respond(&mut stream, "400 Bad Request", "Bad request", "");
            continue;
        };
        if parsed.path() != "/callback" {
            respond(&mut stream, "404 Not Found", "Not found", "");
            continue;
        }
        let query: BTreeMap<String, String> = parsed.query_pairs().into_owned().collect();
        let state_ok = query.get("state").is_some_and(|got| same(got, state));
        if !state_ok {
            respond(
                &mut stream,
                "400 Bad Request",
                "Authorization Failed",
                "state mismatch",
            );
            continue;
        }
        if let Some(error) = query.get("error") {
            let detail = query
                .get("error_description")
                .map(|text| format!(": {text}"))
                .unwrap_or_default();
            let message = format!("{error}{detail}");
            respond(
                &mut stream,
                "200 OK",
                "Authorization Failed",
                &html_escape(&message),
            );
            return Err(format!("the authorization server refused: {message}"));
        }
        let Some(code) = query.get("code").filter(|code| !code.is_empty()) else {
            respond(
                &mut stream,
                "400 Bad Request",
                "Authorization Failed",
                "missing code",
            );
            continue;
        };
        respond(
            &mut stream,
            "200 OK",
            "Authorization Complete",
            "codsh received the authorization.",
        );
        return Ok(Callback {
            code: code.clone(),
            iss: query.get("iss").cloned(),
        });
    }
}

fn token_request(
    http: &Http,
    endpoint: &str,
    mut pairs: Vec<(&str, String)>,
    client_id: &str,
    secret: Option<&str>,
    auth_methods: &[String],
) -> Result<TokenResponse, String> {
    let post_secret = auth_methods.iter().any(|m| m == "client_secret_post")
        && !auth_methods.iter().any(|m| m == "client_secret_basic");
    let basic = secret.filter(|_| !post_secret);
    match (secret, basic) {
        (Some(secret), None) => {
            pairs.push(("client_id", client_id.to_string()));
            pairs.push(("client_secret", secret.to_string()));
        }
        (_, Some(_)) => {}
        (None, None) => pairs.push(("client_id", client_id.to_string())),
    }
    let borrowed: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let reply = http.post_form(endpoint, &borrowed, basic.map(|secret| (client_id, secret)))?;
    let value = parse_json_reply(&reply, "token request")?;
    let token: TokenResponse = serde_json::from_value(value)
        .map_err(|_| "token response has no access_token".to_string())?;
    if token.access_token.is_empty() {
        return Err("token response has an empty access_token".into());
    }
    if !token.token_type.eq_ignore_ascii_case("bearer") {
        return Err(format!("unsupported token type `{}`", token.token_type));
    }
    Ok(token)
}

/// Run the browser login for one server and store the tokens. `on_event`
/// hears the authorization URL (for the surface to show); `cancel` stops the
/// wait for the callback.
pub fn login(
    target: &LoginTarget,
    options: &LoginOptions,
    on_event: &mut dyn FnMut(LoginEvent),
    cancel: &dyn Fn() -> bool,
) -> Result<String, String> {
    let http = Http::new(target.extra_ca)?;
    let probe = http.probe(target.url, target.sse, target.headers)?;
    let discovered = discover(&http, target.url, probe.www_authenticate.as_deref())?;
    let port = target
        .oauth
        .and_then(|oauth| oauth.callback_port)
        .unwrap_or(0);
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|error| format!("cannot bind loopback port {port}: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let configured_scopes = target
        .oauth
        .map(|oauth| oauth.scopes.clone())
        .unwrap_or_default();
    let scopes = if !configured_scopes.is_empty() {
        configured_scopes
    } else if !discovered.challenge_scopes.is_empty() {
        discovered.challenge_scopes.clone()
    } else {
        discovered.scopes_supported.clone()
    };
    let scope = scopes.join(" ");
    let byo = target.oauth.and_then(|oauth| oauth.client_id.clone());
    let (client_id, client_secret) = match byo {
        Some(id) => (id, client_secret(target.oauth, target.env)),
        None => {
            let Some(endpoint) = discovered.registration_endpoint.as_deref() else {
                return Err(
                    "the authorization server has no dynamic client registration; set oauth_client_id for this server"
                        .into(),
                );
            };
            let mut body = json!({
                "client_name": CLIENT_NAME,
                "redirect_uris": [redirect_uri],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
                "application_type": "native",
            });
            if !scope.is_empty() {
                body["scope"] = json!(scope);
            }
            let reply = http.post_json(endpoint, &body)?;
            let value = parse_json_reply(&reply, "dynamic client registration")?;
            let id = value
                .get("client_id")
                .and_then(JsonValue::as_str)
                .filter(|id| !id.is_empty())
                .ok_or("dynamic client registration returned no client_id")?
                .to_string();
            let secret = value
                .get("client_secret")
                .and_then(JsonValue::as_str)
                .map(str::to_string);
            (id, secret)
        }
    };
    let verifier = random_token(32)?;
    let state = random_token(24)?;
    let mut auth_url = url::Url::parse(&discovered.authorization_endpoint)
        .map_err(|_| "invalid authorization endpoint".to_string())?;
    {
        let mut query = auth_url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &client_id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("code_challenge", &pkce_challenge(&verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("resource", &discovered.resource);
        if !scope.is_empty() {
            query.append_pair("scope", &scope);
        }
    }
    let auth_url = auth_url.to_string();
    let opened = options.open_browser && open_browser(&auth_url, target.env);
    on_event(LoginEvent::Browser {
        url: auth_url,
        opened,
    });
    let callback = await_callback(&listener, &state, Instant::now() + options.timeout, cancel)?;
    drop(listener);
    match &callback.iss {
        Some(iss) if iss.trim_end_matches('/') != discovered.issuer.trim_end_matches('/') => {
            return Err(format!(
                "the authorization response came from issuer {} instead of {}",
                display_url(iss),
                display_url(&discovered.issuer)
            ));
        }
        None if discovered.iss_parameter_required => {
            return Err("the authorization response has no `iss` parameter".into());
        }
        _ => {}
    }
    let token = token_request(
        &http,
        &discovered.token_endpoint,
        vec![
            ("grant_type", "authorization_code".into()),
            ("code", callback.code.clone()),
            ("redirect_uri", redirect_uri.clone()),
            ("code_verifier", verifier),
            ("resource", discovered.resource.clone()),
        ],
        &client_id,
        client_secret.as_deref(),
        &discovered.token_auth_methods,
    )?;
    let granted: Vec<String> = token
        .scope
        .as_deref()
        .map(|scope| scope.split_whitespace().map(str::to_string).collect())
        .unwrap_or_else(|| scopes.clone());
    let key = store_key(target.server, target.url);
    // A configured client's secret stays in its environment variable; only
    // a secret handed out by dynamic registration is stored.
    let stored_secret = if target.oauth.and_then(|o| o.client_id.as_ref()).is_some() {
        None
    } else {
        client_secret
    };
    let entry = StoredCredentials {
        client_id,
        client_secret: stored_secret,
        token_response: Some(token),
        granted_scopes: granted,
        token_received_at: Some(now_secs()),
        issuer: Some(discovered.issuer.clone()),
        token_endpoint: Some(discovered.token_endpoint.clone()),
        revocation_endpoint: discovered.revocation_endpoint.clone(),
        resource: Some(discovered.resource.clone()),
    };
    CredentialStore::update(&credentials_path(target.grok_home), |store| {
        store.entries.insert(key, entry);
    })?;
    Ok(format!(
        "Signed in to MCP server '{}' ({}).",
        target.server,
        display_url(&discovered.issuer)
    ))
}

// ---------------------------------------------------------------------------
// Refresh and revocation
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub enum RefreshError {
    /// The authorization server refused the refresh token (revoked, expired):
    /// the token was dropped and the user must sign in again.
    Rejected(String),
    /// Network or server trouble; the stored token is untouched.
    Transient(String),
    /// Nothing to refresh with.
    Unavailable,
}

/// Refresh the stored token for `(server, url)` unless another process
/// already rotated it away from `used`. Returns the access token to use.
pub fn refresh(
    store_path: &Path,
    server: &str,
    url: &str,
    used: Option<&str>,
    secret: Option<&str>,
    extra_ca: Option<&Path>,
) -> Result<String, RefreshError> {
    let _lock = StoreLock::acquire(store_path);
    let mut store = CredentialStore::load(store_path).map_err(RefreshError::Transient)?;
    let key = store_key(server, url);
    let Some(entry) = store.entries.get(&key).cloned() else {
        return Err(RefreshError::Unavailable);
    };
    if let (Some(current), Some(used)) = (entry.access_token(), used)
        && current != used
        && !entry.is_expired(now_secs())
    {
        return Ok(current.to_string());
    }
    if !entry.can_refresh() {
        return Err(RefreshError::Unavailable);
    }
    let token = entry.token_response.clone().unwrap_or_default();
    let refresh_token = token.refresh_token.clone().unwrap_or_default();
    let endpoint = entry.token_endpoint.clone().unwrap_or_default();
    let http = Http::new(extra_ca).map_err(RefreshError::Transient)?;
    let secret = entry.client_secret.clone().or(secret.map(str::to_string));
    let mut pairs = vec![
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh_token.clone()),
    ];
    if let Some(resource) = &entry.resource {
        pairs.push(("resource", resource.clone()));
    }
    match token_request(
        &http,
        &endpoint,
        pairs,
        &entry.client_id,
        secret.as_deref(),
        &[],
    ) {
        Ok(mut fresh) => {
            if fresh.refresh_token.is_none() {
                fresh.refresh_token = Some(refresh_token);
            }
            let access = fresh.access_token.clone();
            if let Some(stored) = store.entries.get_mut(&key) {
                stored.token_response = Some(fresh);
                stored.token_received_at = Some(now_secs());
            }
            store.save(store_path).map_err(RefreshError::Transient)?;
            Ok(access)
        }
        Err(error) if error.contains("cannot reach") || error.contains("(HTTP 5") => {
            Err(RefreshError::Transient(error))
        }
        Err(error) => {
            if let Some(stored) = store.entries.get_mut(&key) {
                stored.token_response = None;
                stored.token_received_at = None;
            }
            let _ = store.save(store_path);
            Err(RefreshError::Rejected(error))
        }
    }
}

/// Sign out: revoke the refresh and access tokens at the authorization
/// server when it has a revocation endpoint (RFC 7009), then delete the
/// stored credentials. Returns what happened.
pub fn logout(
    grok_home: &Path,
    server: &str,
    url: Option<&str>,
    extra_ca: Option<&Path>,
) -> Result<String, String> {
    let path = credentials_path(grok_home);
    let _lock = StoreLock::acquire(&path);
    let mut store = CredentialStore::load(&path)?;
    let keys = match url {
        Some(url) if store.entries.contains_key(&store_key(server, url)) => {
            vec![store_key(server, url)]
        }
        _ => store.keys_for_server(server),
    };
    if keys.is_empty() {
        return Ok(format!(
            "No stored OAuth credentials for MCP server '{server}'."
        ));
    }
    let mut revoked = 0;
    let mut failed = Vec::new();
    for key in &keys {
        let Some(entry) = store.entries.get(key) else {
            continue;
        };
        let (Some(endpoint), Some(token)) = (&entry.revocation_endpoint, &entry.token_response)
        else {
            continue;
        };
        let http = Http::new(extra_ca)?;
        let mut targets = Vec::new();
        if let Some(refresh) = token.refresh_token.as_deref() {
            targets.push((refresh.to_string(), "refresh_token"));
        }
        targets.push((token.access_token.clone(), "access_token"));
        for (value, hint) in targets {
            let mut pairs = vec![("token", value.as_str()), ("token_type_hint", hint)];
            if entry.client_secret.is_none() {
                pairs.push(("client_id", entry.client_id.as_str()));
            }
            let basic = entry
                .client_secret
                .as_deref()
                .map(|secret| (entry.client_id.as_str(), secret));
            match http.post_form(endpoint, &pairs, basic) {
                Ok(reply) if (200..300).contains(&reply.status) => revoked += 1,
                Ok(reply) => failed.push(format!("{hint}: HTTP {}", reply.status)),
                Err(error) => failed.push(format!("{hint}: {error}")),
            }
        }
    }
    for key in &keys {
        store.entries.remove(key);
    }
    store.save(&path)?;
    let mut message = format!("Removed stored OAuth credentials for MCP server '{server}'");
    if revoked > 0 {
        message.push_str("; the authorization server revoked the tokens");
    } else if failed.is_empty() {
        message.push_str(" (the authorization server has no revocation endpoint)");
    }
    if !failed.is_empty() {
        message.push_str(&format!("; revocation failed ({})", failed.join(", ")));
    }
    message.push('.');
    Ok(message)
}

/// Remove every stored login for `server` (the server was removed).
pub fn forget(grok_home: &Path, server: &str) -> usize {
    let path = credentials_path(grok_home);
    if !path.exists() {
        return 0;
    }
    let mut removed = 0;
    let _ = CredentialStore::update(&path, |store| {
        for key in store.keys_for_server(server) {
            store.entries.remove(&key);
            removed += 1;
        }
    });
    removed
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    pub(crate) type Handler = Arc<
        dyn Fn(&str, &str, &str, &BTreeMap<String, String>) -> (u16, Vec<(String, String)>, String)
            + Send
            + Sync,
    >;

    /// A tiny loopback HTTP/1.1 server for tests: one thread per connection,
    /// `handler(method, path, body, headers) -> (status, headers, body)`.
    pub(crate) fn serve(handler: Handler) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let handler = Arc::clone(&handler);
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() {
                        return;
                    }
                    let mut headers = BTreeMap::new();
                    loop {
                        let mut header = String::new();
                        if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                            break;
                        }
                        if let Some((k, v)) = header.split_once(':') {
                            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
                        }
                    }
                    let len: usize = headers
                        .get("content-length")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0);
                    let mut body = vec![0; len];
                    let _ = reader.read_exact(&mut body);
                    let mut parts = line.split_whitespace();
                    let method = parts.next().unwrap_or("").to_string();
                    let path = parts.next().unwrap_or("").to_string();
                    let (status, extra, body) =
                        handler(&method, &path, &String::from_utf8_lossy(&body), &headers);
                    let mut head = format!(
                        "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                        body.len()
                    );
                    for (k, v) in extra {
                        head.push_str(&format!("{k}: {v}\r\n"));
                    }
                    head.push_str("\r\n");
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(body.as_bytes());
                });
            }
        });
        base
    }

    #[test]
    fn challenge_parsing_handles_quotes_and_commas() {
        let params = challenge_params(
            r#"Bearer error="invalid_token", resource_metadata="http://127.0.0.1:9/.well-known/oauth-protected-resource/mcp", scope="a b""#,
        );
        assert_eq!(params["error"], "invalid_token");
        assert_eq!(
            params["resource_metadata"],
            "http://127.0.0.1:9/.well-known/oauth-protected-resource/mcp"
        );
        assert_eq!(params["scope"], "a b");
        assert!(challenge_params("Bearer").is_empty());
        assert_eq!(challenge_params("bearer realm=x")["realm"], "x");
    }

    #[test]
    fn pkce_is_unpadded_base64url_sha256() {
        // Expected value computed independently with Python hashlib/base64.
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K1uhbUJU1p1r_wW1gFWFOEjXk"),
            "DpW_nzyKLmXOCjIx2Ik4CEMHAv6AF_zNMXGb5Z9P0oI"
        );
        let a = random_token(32).unwrap();
        assert_eq!(a.len(), 43);
        assert_ne!(a, random_token(32).unwrap());
    }

    #[test]
    fn store_round_trip_is_owner_only_and_debug_redacts() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = credentials_path(dir.path());
        CredentialStore::update(&path, |store| {
            store.entries.insert(
                store_key("srv", "http://127.0.0.1:1/mcp"),
                StoredCredentials {
                    client_id: "c".into(),
                    token_response: Some(TokenResponse {
                        access_token: "secret-token-value".into(),
                        token_type: "bearer".into(),
                        expires_in: Some(3600),
                        refresh_token: Some("secret-refresh".into()),
                        scope: None,
                    }),
                    token_received_at: Some(now_secs()),
                    token_endpoint: Some("http://127.0.0.1:1/token".into()),
                    ..Default::default()
                },
            );
        })
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let store = CredentialStore::load(&path).unwrap();
        let entry = store.get("srv", "http://127.0.0.1:1/mcp").unwrap();
        assert_eq!(entry.access_token(), Some("secret-token-value"));
        assert!(entry.can_refresh());
        assert!(!format!("{entry:?}").contains("secret"));
        assert!(!format!("{store:?}").contains("secret"));
        assert!(matches!(
            auth_state(dir.path(), "srv", "http://127.0.0.1:1/mcp"),
            AuthState::Signed { .. }
        ));
        assert_eq!(
            auth_state(dir.path(), "other", "http://127.0.0.1:1/mcp"),
            AuthState::None
        );
        assert_eq!(forget(dir.path(), "srv"), 1);
        assert_eq!(
            auth_state(dir.path(), "srv", "http://127.0.0.1:1/mcp"),
            AuthState::None
        );
    }

    #[test]
    fn expiry_uses_received_time_and_skew() {
        let entry = StoredCredentials {
            client_id: "c".into(),
            token_response: Some(TokenResponse {
                access_token: "a".into(),
                token_type: "bearer".into(),
                expires_in: Some(100),
                refresh_token: None,
                scope: None,
            }),
            token_received_at: Some(1000),
            ..Default::default()
        };
        assert!(!entry.is_expired(1000));
        assert!(entry.is_expired(1071));
        assert_eq!(entry.expires_in(1050), Some(50));
        assert!(!entry.can_refresh());
    }

    #[test]
    fn display_url_drops_query_and_userinfo() {
        assert_eq!(
            display_url("https://user:pw@mcp.example.com/api?key=SECRET#x"),
            "https://mcp.example.com/api"
        );
    }

    #[test]
    fn endpoints_need_https_off_loopback() {
        let server = url::Url::parse("https://mcp.example.com/mcp").unwrap();
        assert!(endpoint_allowed("https://auth.example.com/token", &server).is_ok());
        assert!(endpoint_allowed("http://127.0.0.1:9/token", &server).is_ok());
        assert!(endpoint_allowed("http://auth.example.com/token", &server).is_err());
        assert!(endpoint_allowed("javascript:alert(1)", &server).is_err());
    }

    fn fake_oauth(revocations: Arc<Mutex<Vec<String>>>, refresh_ok: Arc<Mutex<bool>>) -> String {
        let base = Arc::new(Mutex::new(String::new()));
        let base_in = Arc::clone(&base);
        let handler: Handler = Arc::new(move |method, path, body, _headers| {
            let base = base_in.lock().unwrap().clone();
            let json_ct = vec![("Content-Type".to_string(), "application/json".to_string())];
            let form: BTreeMap<String, String> = url::form_urlencoded::parse(body.as_bytes())
                .into_owned()
                .collect();
            match (method, path.split('?').next().unwrap_or("")) {
                ("POST", "/mcp") => (
                    401,
                    vec![(
                        "WWW-Authenticate".into(),
                        format!(
                            "Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\""
                        ),
                    )],
                    String::new(),
                ),
                ("GET", "/.well-known/oauth-protected-resource/mcp") => (
                    200,
                    json_ct,
                    json!({"resource": format!("{base}/mcp"), "authorization_servers": [base], "scopes_supported": ["mcp:tools"]}).to_string(),
                ),
                ("GET", "/.well-known/oauth-authorization-server") => (
                    200,
                    json_ct,
                    json!({
                        "issuer": base,
                        "authorization_endpoint": format!("{base}/authorize"),
                        "token_endpoint": format!("{base}/token"),
                        "registration_endpoint": format!("{base}/register"),
                        "revocation_endpoint": format!("{base}/revoke"),
                        "code_challenge_methods_supported": ["S256"],
                    })
                    .to_string(),
                ),
                ("POST", "/register") => (
                    201,
                    json_ct,
                    json!({"client_id": "dyn-client"}).to_string(),
                ),
                ("POST", "/token") => {
                    if form.get("grant_type").map(String::as_str) == Some("refresh_token") {
                        if *refresh_ok.lock().unwrap() {
                            (200, json_ct, json!({"access_token": "at-2", "token_type": "Bearer", "expires_in": 3600}).to_string())
                        } else {
                            (400, json_ct, json!({"error": "invalid_grant", "error_description": "revoked"}).to_string())
                        }
                    } else if form.get("code").map(String::as_str) == Some("the-code")
                        && form.get("client_id").map(String::as_str) == Some("dyn-client")
                        && form.get("code_verifier").is_some_and(|v| v.len() >= 43)
                        && form.get("resource").map(String::as_str)
                            == Some(format!("{base}/mcp").as_str())
                    {
                        (200, json_ct, json!({"access_token": "at-1", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "rt-1"}).to_string())
                    } else {
                        (400, json_ct, json!({"error": "invalid_request"}).to_string())
                    }
                }
                ("POST", "/revoke") => {
                    revocations
                        .lock()
                        .unwrap()
                        .push(form.get("token").cloned().unwrap_or_default());
                    (200, vec![], String::new())
                }
                _ => (404, vec![], String::new()),
            }
        });
        let url = serve(handler);
        *base.lock().unwrap() = url.clone();
        url
    }

    /// The browser: follow the authorization URL's redirect back to the
    /// loopback callback with a code and a state.
    fn consent(url: &str, code: &str, state_override: Option<&str>) {
        let parsed = url::Url::parse(url).unwrap();
        let query: BTreeMap<String, String> = parsed.query_pairs().into_owned().collect();
        let redirect = query["redirect_uri"].clone();
        let state = state_override
            .map(str::to_string)
            .unwrap_or(query["state"].clone());
        let target = format!("{redirect}?code={code}&state={state}");
        std::thread::spawn(move || {
            let _ = ureq::get(&target).call();
        });
    }

    #[test]
    fn login_refresh_and_logout_against_a_loopback_authorization_server() {
        let revocations = Arc::new(Mutex::new(Vec::new()));
        let refresh_ok = Arc::new(Mutex::new(true));
        let base = fake_oauth(Arc::clone(&revocations), Arc::clone(&refresh_ok));
        let home = tempfile::TempDir::new().unwrap();
        let url = format!("{base}/mcp");
        let headers = BTreeMap::new();
        let env = BTreeMap::new();
        let target = LoginTarget {
            grok_home: home.path(),
            server: "remote",
            url: &url,
            sse: false,
            headers: &headers,
            oauth: None,
            env: &env,
            extra_ca: None,
        };
        let options = LoginOptions {
            timeout: Duration::from_secs(20),
            open_browser: false,
        };
        let mut seen = Vec::new();
        let message = login(
            &target,
            &options,
            &mut |event| {
                let LoginEvent::Browser { url, opened } = event;
                assert!(!opened);
                // A forged state is ignored; the real redirect still completes.
                consent(&url, "the-code", Some("forged"));
                std::thread::sleep(Duration::from_millis(200));
                consent(&url, "the-code", None);
                seen.push(url);
            },
            &|| false,
        )
        .unwrap();
        assert!(message.contains("Signed in"), "{message}");
        let auth = url::Url::parse(&seen[0]).unwrap();
        let query: BTreeMap<String, String> = auth.query_pairs().into_owned().collect();
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(query["client_id"], "dyn-client");
        assert_eq!(query["resource"], url);
        assert_eq!(query["scope"], "mcp:tools");
        let path = credentials_path(home.path());
        let store = CredentialStore::load(&path).unwrap();
        let entry = store.get("remote", &url).unwrap();
        assert_eq!(entry.access_token(), Some("at-1"));
        assert_eq!(
            entry.revocation_endpoint.as_deref(),
            Some(format!("{base}/revoke").as_str())
        );

        // Refresh rotates the access token and keeps the refresh token.
        assert_eq!(
            refresh(&path, "remote", &url, Some("at-1"), None, None).unwrap(),
            "at-2"
        );
        let entry = CredentialStore::load(&path)
            .unwrap()
            .get("remote", &url)
            .cloned()
            .unwrap();
        assert_eq!(entry.access_token(), Some("at-2"));
        assert_eq!(
            entry
                .token_response
                .as_ref()
                .unwrap()
                .refresh_token
                .as_deref(),
            Some("rt-1")
        );
        // A stale caller gets the already-rotated token without a new request.
        assert_eq!(
            refresh(&path, "remote", &url, Some("at-1"), None, None).unwrap(),
            "at-2"
        );

        // Logout revokes both tokens and deletes the entry.
        let out = logout(home.path(), "remote", Some(&url), None).unwrap();
        assert!(out.contains("revoked"), "{out}");
        assert_eq!(
            *revocations.lock().unwrap(),
            vec!["rt-1".to_string(), "at-2".to_string()]
        );
        assert_eq!(auth_state(home.path(), "remote", &url), AuthState::None);
    }

    #[test]
    fn a_rejected_refresh_drops_the_token() {
        let base = fake_oauth(
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(false)),
        );
        let home = tempfile::TempDir::new().unwrap();
        let url = format!("{base}/mcp");
        let path = credentials_path(home.path());
        CredentialStore::update(&path, |store| {
            store.entries.insert(
                store_key("remote", &url),
                StoredCredentials {
                    client_id: "dyn-client".into(),
                    token_response: Some(TokenResponse {
                        access_token: "old".into(),
                        token_type: "bearer".into(),
                        expires_in: Some(1),
                        refresh_token: Some("rt".into()),
                        scope: None,
                    }),
                    token_received_at: Some(1),
                    token_endpoint: Some(format!("{base}/token")),
                    ..Default::default()
                },
            );
        })
        .unwrap();
        let error = refresh(&path, "remote", &url, Some("old"), None, None).unwrap_err();
        assert!(
            matches!(error, RefreshError::Rejected(ref text) if text.contains("invalid_grant")),
            "{error:?}"
        );
        assert_eq!(auth_state(home.path(), "remote", &url), AuthState::NoToken);
    }

    #[test]
    fn discovery_refuses_a_resource_on_another_origin() {
        let handler: Handler = Arc::new(|_method, path, _body, _headers| {
            match path {
            "/.well-known/oauth-protected-resource/mcp" => (
                200,
                vec![("Content-Type".into(), "application/json".into())],
                json!({"resource": "https://evil.example.com/mcp", "authorization_servers": ["https://evil.example.com"]}).to_string(),
            ),
            _ => (404, vec![], String::new()),
        }
        });
        let base = serve(handler);
        let http = Http::new(None).unwrap();
        let error = discover(&http, &format!("{base}/mcp"), None).unwrap_err();
        assert!(error.contains("different resource"), "{error}");
    }

    #[test]
    fn a_refused_consent_fails_the_login() {
        let base = fake_oauth(Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(true)));
        let home = tempfile::TempDir::new().unwrap();
        let url = format!("{base}/mcp");
        let (headers, env) = (BTreeMap::new(), BTreeMap::new());
        let target = LoginTarget {
            grok_home: home.path(),
            server: "remote",
            url: &url,
            sse: false,
            headers: &headers,
            oauth: None,
            env: &env,
            extra_ca: None,
        };
        let options = LoginOptions {
            timeout: Duration::from_secs(20),
            open_browser: false,
        };
        let error = login(
            &target,
            &options,
            &mut |event| {
                let LoginEvent::Browser { url, .. } = event;
                let query: BTreeMap<String, String> = url::Url::parse(&url)
                    .unwrap()
                    .query_pairs()
                    .into_owned()
                    .collect();
                let target = format!(
                    "{}?error=access_denied&state={}",
                    query["redirect_uri"], query["state"]
                );
                std::thread::spawn(move || {
                    let _ = ureq::get(&target).call();
                });
            },
            &|| false,
        )
        .unwrap_err();
        assert!(error.contains("access_denied"), "{error}");
        assert_eq!(auth_state(home.path(), "remote", &url), AuthState::None);
    }
}
