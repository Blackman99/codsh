//! Explicit web search and fetch substitutes.
//!
//! Search calls a configured Responses-compatible endpoint. Fetch calls the
//! configured public HTTP target, optionally through one egress proxy. Official
//! hosts are refused. Disabled tools are not callable. Domain policy is loaded
//! at session start and cannot be widened by a model argument or a redirect.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use toml::Value as TomlValue;
use url::Url;

pub const MAX_URL_LENGTH: usize = 2_000;
pub const MAX_REDIRECTS: usize = 10;
pub const MAX_SEARCH_DOMAINS: usize = 5;
pub const MAX_CONTENT_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_MARKDOWN_CHARS: usize = 100_000;
const USER_AGENT: &str = "codsh-rust-web/0.1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchService {
    pub enabled: bool,
    pub enabled_source: String,
    pub model: Option<String>,
    pub model_source: String,
    pub base_url: Option<String>,
    pub base_url_source: String,
    pub env_key: String,
    /// Set only when the configured env var or an inline `api_key` is non-empty.
    /// The request uses that same value; an empty inline key is not "configured".
    pub api_key: String,
    pub api_key_set: bool,
    pub backend_search: bool,
    pub allowed_domains: Vec<String>,
    pub allowed_source: String,
    pub excluded_domains: Vec<String>,
    pub excluded_source: String,
    pub conflict: bool,
    pub cost: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchService {
    pub enabled: bool,
    pub enabled_source: String,
    pub allowed_domains: Option<Vec<String>>,
    pub allowed_source: String,
    pub proxy_endpoint: Option<String>,
    pub proxy_source: String,
    pub allow_local: bool,
    pub allow_local_source: String,
    pub cost: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebServices {
    pub search: SearchService,
    pub fetch: FetchService,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

impl WebServices {
    pub fn disabled() -> Self {
        Self {
            search: SearchService {
                enabled: false,
                enabled_source: "default".into(),
                model: None,
                model_source: "default".into(),
                base_url: None,
                base_url_source: "default".into(),
                env_key: "XAI_API_KEY".into(),
                api_key: String::new(),
                api_key_set: false,
                backend_search: false,
                allowed_domains: Vec::new(),
                allowed_source: "default".into(),
                excluded_domains: Vec::new(),
                excluded_source: "default".into(),
                conflict: false,
                cost: "unset; no search request is made".into(),
            },
            fetch: FetchService {
                enabled: false,
                enabled_source: "default".into(),
                allowed_domains: None,
                allowed_source: "default".into(),
                proxy_endpoint: None,
                proxy_source: "default".into(),
                allow_local: false,
                allow_local_source: "default".into(),
                cost: "unset; no fetch request is made".into(),
            },
            warnings: Vec::new(),
            errors: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebError {
    Disabled(&'static str),
    Unconfigured(&'static str),
    OfficialDestination,
    InvalidConfiguration(String),
    Policy(String),
    Http { status: u16, message: String },
    Network(String),
    Cancelled,
}

impl std::fmt::Display for WebError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled(tool) => write!(
                formatter,
                "{tool} is disabled. Enable it explicitly; no request was made and no page text was returned."
            ),
            Self::Unconfigured(tool) => write!(
                formatter,
                "{tool} has no configured substitute. Set its service in config.toml; nothing was fetched."
            ),
            Self::OfficialDestination => write!(
                formatter,
                "official web host refused. Configure a substitute service; nothing was fetched."
            ),
            Self::InvalidConfiguration(message) => write!(formatter, "{message}"),
            Self::Policy(message) => write!(formatter, "{message}"),
            Self::Http { status, message } => {
                write!(formatter, "HTTP {status}: {message} Body was not returned.")
            }
            Self::Network(message) => write!(formatter, "network failure: {message}"),
            Self::Cancelled => write!(formatter, "cancelled before a result was received"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Citation {
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchOutcome {
    pub query: String,
    pub content: String,
    pub citations: Vec<Citation>,
    pub service: String,
    pub model: String,
    pub allowed_domains: Vec<String>,
    pub excluded_domains: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchOutcome {
    pub url: String,
    pub content: String,
    pub content_type: String,
    pub status_code: u16,
    pub bytes: usize,
    pub truncated: bool,
    pub via_proxy: bool,
}

struct ResolvedTarget {
    url: Url,
    /// Every public address from the lookup. Empty only for a proxy hop, where
    /// the proxy resolves the origin. A direct hop always has at least one.
    addresses: Vec<SocketAddr>,
}

#[cfg(test)]
fn load_services(
    table: &TomlValue,
    env: &BTreeMap<String, String>,
    requirements: Option<&TomlValue>,
    managed: Option<&TomlValue>,
) -> WebServices {
    load_services_layered(table, table, env, requirements, managed)
}

/// `user` is the developer file before merge. `table` is the merged config the
/// model specs come from. Inspect labels use `user`, so a managed-only key is
/// not reported as `config.toml`.
pub fn load_services_layered(
    table: &TomlValue,
    user: &TomlValue,
    env: &BTreeMap<String, String>,
    requirements: Option<&TomlValue>,
    managed: Option<&TomlValue>,
) -> WebServices {
    let mut services = WebServices::disabled();
    load_search(&mut services, table, user, env, requirements, managed);
    load_fetch(&mut services, user, env, requirements, managed);
    services
}

fn load_search(
    services: &mut WebServices,
    table: &TomlValue,
    user: &TomlValue,
    env: &BTreeMap<String, String>,
    requirements: Option<&TomlValue>,
    managed: Option<&TomlValue>,
) {
    let search = &mut services.search;
    if bool_at(requirements, &["disable_web_search"]) == Some(true)
        || bool_at(Some(user), &["disable_web_search"]) == Some(true)
        || env_flag(env.get("GROK_DISABLE_WEB_SEARCH")) == Some(true)
    {
        search.enabled = false;
        search.enabled_source = if bool_at(requirements, &["disable_web_search"]) == Some(true) {
            "requirements".into()
        } else if env_flag(env.get("GROK_DISABLE_WEB_SEARCH")) == Some(true) {
            "environment".into()
        } else {
            "config.toml".into()
        };
        search.cost = "disabled; no search request and no charge".into();
        return;
    }

    // Guide 26 marks models.web_search as requirements `pin` and managed `user`.
    // The pin beats env. An env name that has no model table must not hide a
    // configured substitute; requirements still win.
    let (mut model, mut model_source) = layered_string(
        requirements,
        managed,
        user,
        env.get("GROK_WEB_SEARCH_MODEL"),
        &["models", "web_search"],
        Layer::Pin,
    );
    if model_source == "environment"
        && model
            .as_ref()
            .is_some_and(|id| table.get("model").and_then(|value| value.get(id)).is_none())
        && let Some(configured) = string_path(user, &["models", "web_search"])
    {
        model = Some(configured);
        model_source = "config.toml".into();
    }
    search.model = model;
    search.model_source = model_source;
    if search.model.is_none() {
        search.cost = "unset; no search request is made".into();
        return;
    }

    let model_id = search.model.clone().unwrap_or_default();
    let spec = table
        .get("model")
        .and_then(|value| value.get(&model_id))
        .or_else(|| {
            requirements
                .and_then(|value| value.get("model"))
                .and_then(|value| value.get(&model_id))
        });
    if let Some(spec) = spec {
        search.base_url = string_at(spec, &["base_url"]);
        search.base_url_source = "config.toml".into();
        if let Some(key) = string_at(spec, &["env_key"]) {
            search.env_key = key;
        }
        search.backend_search = bool_at_value(spec, &["supports_backend_search"]).unwrap_or(false);
    }
    // env_key wins when it is set. An inline api_key is the credential only when
    // that env var is empty. Neither an absent key nor a blank inline value counts.
    let env_key = env
        .get(&search.env_key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let inline_key = spec.and_then(|value| string_at(value, &["api_key"]));
    search.api_key = env_key.or(inline_key).unwrap_or_default();
    search.api_key_set = !search.api_key.is_empty();
    if search
        .base_url
        .as_deref()
        .is_some_and(crate::privacy::is_official_endpoint)
    {
        services.errors.push(
            "web search destination refused: official host is not used. Set [model.<id>] base_url to a substitute."
                .into(),
        );
        search.base_url = None;
        search.base_url_source = "refused".into();
    }

    // Guide 26: both lists are requirements `yes` / managed `user`.
    // requirements, then user config, then managed. Env does not set them.
    let allowed = layered_strings(
        requirements,
        managed,
        user,
        &["toolset", "web_search", "allowed_domains"],
    );
    let excluded = layered_strings(
        requirements,
        managed,
        user,
        &["toolset", "web_search", "excluded_domains"],
    );
    search.allowed_domains = allowed.0;
    search.allowed_source = allowed.1;
    search.excluded_domains = excluded.0;
    search.excluded_source = excluded.1;
    if !search.allowed_domains.is_empty() && !search.excluded_domains.is_empty() {
        search.conflict = true;
        search.excluded_domains.clear();
        services.warnings.push(
            "web search allowlist wins; excluded_domains was dropped. The two lists are mutually exclusive."
                .into(),
        );
    }
    if search.allowed_domains.len() > MAX_SEARCH_DOMAINS {
        services.errors.push(format!(
            "web search allowed_domains accepts at most {MAX_SEARCH_DOMAINS} entries"
        ));
    }
    // A named model is not a search service until it says the substitute
    // performs retrieval. Otherwise a chat model would be advertised as search.
    search.enabled = search.base_url.is_some()
        && search.api_key_set
        && search.backend_search
        && services.errors.is_empty();
    search.enabled_source = if search.enabled {
        search.model_source.clone()
    } else {
        "unconfigured".into()
    };
    search.cost = if search.enabled {
        format!(
            "one Responses request to {} using {}; citations come from that response",
            search.base_url.as_deref().unwrap_or("(unset)"),
            model_id
        )
    } else {
        "unconfigured; no search request is made".into()
    };
}

fn load_fetch(
    services: &mut WebServices,
    user: &TomlValue,
    env: &BTreeMap<String, String>,
    requirements: Option<&TomlValue>,
    managed: Option<&TomlValue>,
) {
    let fetch = &mut services.fetch;
    // Guide 26 marks features.web_fetch as requirements `pin` and managed `user`.
    // A pin beats env and the user file. Managed is only the default under them.
    // GROK_DISABLE_WEB_FETCH is the documented off switch and loses to that pin.
    let (enabled, enabled_source) = layered_pin_bool(
        requirements,
        managed,
        user,
        env.get("GROK_WEB_FETCH"),
        env.get("GROK_DISABLE_WEB_FETCH"),
        &["features", "web_fetch"],
    );
    if let Some(value) = enabled {
        fetch.enabled = value;
        fetch.enabled_source = enabled_source;
    }
    // Guide 26: proxy is requirements `yes` / managed `user`.
    // A pin is not this key. User TOML beats env; both beat requirements
    // `yes` and a managed default. The user can change a fleet proxy.
    let proxy = layered_string(
        requirements,
        managed,
        user,
        env.get("GROK_WEB_FETCH_PROXY"),
        &["toolset", "web_fetch", "proxy_endpoint"],
        Layer::Yes,
    );
    fetch.proxy_endpoint = proxy.0;
    fetch.proxy_source = proxy.1;
    if fetch
        .proxy_endpoint
        .as_deref()
        .is_some_and(crate::privacy::is_official_endpoint)
    {
        services
            .errors
            .push("web fetch proxy refused: official host is not used.".into());
        fetch.proxy_endpoint = None;
        fetch.proxy_source = "refused".into();
    }

    // Same class as the search lists: requirements, then user, then managed.
    // An explicit empty list is a block. Absence keeps the built-in public-doc list.
    let allowed = layered_domain_list(
        requirements,
        managed,
        user,
        &["toolset", "web_fetch", "allowed_domains"],
    );
    fetch.allowed_domains = allowed.0;
    fetch.allowed_source = allowed.1;
    // An explicit empty fetch allowlist blocks every request. Absence keeps
    // the built-in public-doc default, which still refuses private targets.
    if fetch.allowed_domains.as_ref().is_some_and(Vec::is_empty) {
        fetch.cost = "explicit empty allowlist; every fetch is blocked".into();
    }

    // allow_local is not in guide 26. Guide 05 says TOML over env over default off.
    // A requirements value is still an admin file, so it stays above user TOML.
    // Managed stays a default: the user file and env both beat it.
    let local = layered_bool(
        requirements,
        user,
        env.get("GROK_WEB_FETCH_ALLOW_LOCAL"),
        managed,
        &["toolset", "web_fetch", "allow_local"],
    );
    fetch.allow_local = local.0.unwrap_or(false);
    fetch.allow_local_source = local.1;
    if fetch.enabled && fetch.cost.starts_with("unset") {
        fetch.cost =
            "direct public HTTP fetch; no account and no per-page charge from codsh".into();
    }
    if !fetch.enabled {
        fetch.cost = "disabled; no fetch request is made".into();
    }
}

pub fn inspect_rows(services: &WebServices) -> Vec<(&'static str, String, String)> {
    let domains = if services.search.allowed_domains.is_empty()
        && services.search.excluded_domains.is_empty()
    {
        "(unbounded)".into()
    } else if !services.search.allowed_domains.is_empty() {
        services.search.allowed_domains.join(",")
    } else {
        services.search.excluded_domains.join(",")
    };
    let excluded = if services.search.conflict {
        "(dropped; allowlist wins)".into()
    } else if services.search.excluded_domains.is_empty() {
        "(unset)".into()
    } else {
        services.search.excluded_domains.join(",")
    };
    let fetch_domains = match &services.fetch.allowed_domains {
        None => "(built-in public docs)".into(),
        Some(domains) if domains.is_empty() => "(empty; all blocked)".into(),
        Some(domains) => domains.join(","),
    };
    vec![
        (
            "features.web_search",
            bool_text(services.search.enabled),
            services.search.enabled_source.clone(),
        ),
        (
            "models.web_search",
            services
                .search
                .model
                .clone()
                .unwrap_or_else(|| "(unset)".into()),
            services.search.model_source.clone(),
        ),
        (
            "toolset.web_search.allowed_domains",
            domains,
            services.search.allowed_source.clone(),
        ),
        (
            "toolset.web_search.excluded_domains",
            excluded,
            if services.search.conflict {
                services.search.allowed_source.clone()
            } else {
                services.search.excluded_source.clone()
            },
        ),
        (
            "features.web_fetch",
            bool_text(services.fetch.enabled),
            services.fetch.enabled_source.clone(),
        ),
        (
            "toolset.web_fetch.allowed_domains",
            fetch_domains,
            services.fetch.allowed_source.clone(),
        ),
        (
            "toolset.web_fetch.proxy_endpoint",
            services
                .fetch
                .proxy_endpoint
                .clone()
                .unwrap_or_else(|| "(unset)".into()),
            services.fetch.proxy_source.clone(),
        ),
        (
            "toolset.web_fetch.allow_local",
            bool_text(services.fetch.allow_local),
            services.fetch.allow_local_source.clone(),
        ),
    ]
}

pub fn disclosure(services: &WebServices) -> String {
    format!(
        "web search: {} ({}); web fetch: {} ({})",
        if services.search.enabled {
            "enabled"
        } else {
            "disabled"
        },
        services.search.cost,
        if services.fetch.enabled {
            "enabled"
        } else {
            "disabled"
        },
        services.fetch.cost
    )
}

pub fn search_request_body(services: &WebServices, query: &str) -> Result<Value, WebError> {
    if !services.search.enabled {
        return Err(WebError::Disabled("web_search"));
    }
    let base = services
        .search
        .base_url
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or(WebError::Unconfigured("web_search"))?;
    if crate::privacy::is_official_endpoint(base) {
        return Err(WebError::OfficialDestination);
    }
    // dsh web_search sends query and maxResults only. Filters come from the
    // configured allowlist or denylist, never from a model argument.
    let (allowed, excluded) = resolve_search_filters(&services.search);
    let mut filters = serde_json::Map::new();
    if let Some(allowed) = allowed {
        filters.insert("allowed_domains".into(), json!(allowed));
    }
    if let Some(excluded) = excluded {
        filters.insert("excluded_domains".into(), json!(excluded));
    }
    let mut tool = json!({
        "type": "web_search",
        "filters": filters,
    });
    if filters.is_empty() {
        tool.as_object_mut().unwrap().remove("filters");
    }
    Ok(json!({
        "model": services.search.model,
        "input": query,
        "tools": [tool],
        "store": false,
        "temperature": 0.1,
        "top_p": 0.95,
        "max_output_tokens": 8192,
    }))
}

fn resolve_search_filters(search: &SearchService) -> (Option<Vec<String>>, Option<Vec<String>>) {
    if !search.allowed_domains.is_empty() {
        return (Some(search.allowed_domains.clone()), None);
    }
    if !search.excluded_domains.is_empty() {
        return (None, Some(search.excluded_domains.clone()));
    }
    (None, None)
}

pub fn parse_search_response(body: &str) -> Result<(String, Vec<Citation>), WebError> {
    let value: Value = serde_json::from_str(body)
        .map_err(|error| WebError::Network(format!("search response was not JSON: {error}")))?;
    let mut texts = Vec::new();
    let mut citations = Vec::new();
    if let Some(output) = value.get("output").and_then(Value::as_array) {
        for item in output {
            let content = item.get("content").and_then(Value::as_array);
            let Some(content) = content else { continue };
            for block in content {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    texts.push(text.to_string());
                }
                if let Some(annotations) = block.get("annotations").and_then(Value::as_array) {
                    for annotation in annotations {
                        let url = annotation.get("url").and_then(Value::as_str).or_else(|| {
                            annotation
                                .pointer("/url_citation/url")
                                .and_then(Value::as_str)
                        });
                        let Some(url) = url.filter(|url| !url.is_empty()) else {
                            continue;
                        };
                        let title = annotation
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if citations.iter().any(|item: &Citation| item.url == url) {
                            continue;
                        }
                        citations.push(Citation {
                            url: url.to_string(),
                            title,
                        });
                    }
                }
            }
        }
    }
    if texts.is_empty()
        && let Some(text) = value.get("output_text").and_then(Value::as_str)
    {
        texts.push(text.to_string());
    }
    let content = if texts.is_empty() {
        "No search results found.".into()
    } else {
        texts.join("\n")
    };
    Ok((content, citations))
}

pub fn search(
    services: &WebServices,
    query: &str,
    api_key: &str,
    cancelled: &AtomicBool,
) -> Result<SearchOutcome, WebError> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(WebError::Cancelled);
    }
    let body = search_request_body(services, query)?;
    let base = services.search.base_url.clone().unwrap_or_default();
    let url = format!("{}/responses", base.trim_end_matches('/'));
    if cancelled.load(Ordering::Relaxed) {
        return Err(WebError::Cancelled);
    }
    // The loaded credential wins. A caller-supplied key is only a fallback for
    // the CLI path that already resolved the same env var.
    let key = if services.search.api_key.is_empty() {
        api_key
    } else {
        services.search.api_key.as_str()
    };
    let endpoint = Url::parse(&url)
        .map_err(|error| WebError::InvalidConfiguration(format!("search base_url: {error}")))?;
    let host = endpoint.host_str().unwrap_or("");
    let port = endpoint.port_or_known_default().unwrap_or(80);
    // Search is a direct call to the configured substitute. Pin it the same way
    // as fetch: any private answer rejects the name, and the socket uses only
    // an address from this lookup.
    // A loopback substitute is the configured search service, not a fetch of a
    // page the model named. Private and metadata answers still fail the lookup.
    let addresses = approved_addresses(host, port, is_explicit_local_host(host))?;
    let response = call_cancellable(
        &url,
        CallKind::PostJson {
            body: body.to_string(),
            api_key: key.to_string(),
        },
        CallTarget {
            proxy: None,
            addresses: &addresses,
        },
        cancelled,
        SEARCH_TIMEOUT,
    )?;
    if response.status == 401 || response.status == 403 {
        return Err(WebError::Http {
            status: response.status,
            message: format!(
                "search substitute refused the credential for {}. No page text was returned.",
                services.search.env_key
            ),
        });
    }
    if !(200..300).contains(&response.status) {
        return Err(WebError::Http {
            status: response.status,
            message: format!(
                "search substitute returned HTTP {}. No page text was returned.",
                response.status
            ),
        });
    }
    let (content, citations) = parse_search_response(&response.body)?;
    Ok(SearchOutcome {
        query: query.to_string(),
        content,
        citations,
        service: base,
        model: services.search.model.clone().unwrap_or_default(),
        allowed_domains: services.search.allowed_domains.clone(),
        excluded_domains: services.search.excluded_domains.clone(),
    })
}

pub fn format_search(outcome: &SearchOutcome) -> String {
    let mut lines = vec![format!(
        "Web search results for: \"{}\"\nservice: {}\nmodel: {}",
        outcome.query, outcome.service, outcome.model
    )];
    if !outcome.allowed_domains.is_empty() {
        lines.push(format!(
            "allowed domains: {}",
            outcome.allowed_domains.join(", ")
        ));
    }
    if !outcome.excluded_domains.is_empty() {
        lines.push(format!(
            "excluded domains: {}",
            outcome.excluded_domains.join(", ")
        ));
    }
    lines.push(String::new());
    lines.push(outcome.content.clone());
    if !outcome.citations.is_empty() {
        lines.push(String::new());
        lines.push("Sources:".into());
        for (index, citation) in outcome.citations.iter().enumerate() {
            if citation.title.is_empty() {
                lines.push(format!("{}. {}", index + 1, citation.url));
            } else {
                lines.push(format!(
                    "{}. {} ({})",
                    index + 1,
                    citation.title,
                    citation.url
                ));
            }
        }
    }
    lines.join("\n")
}

pub fn fetch_url(
    services: &WebServices,
    raw_url: &str,
    cancelled: &AtomicBool,
) -> Result<FetchOutcome, WebError> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(WebError::Cancelled);
    }
    if !services.fetch.enabled {
        return Err(WebError::Disabled("web_fetch"));
    }
    if let Some(proxy) = services.fetch.proxy_endpoint.as_deref() {
        validate_proxy(proxy)?;
    }
    let mut url = validate_fetch_url(raw_url, services.fetch.allow_local)?;
    upgrade_https(&mut url);
    let mut target = resolve_target(&url, services)?;
    let mut hops = 0;
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(WebError::Cancelled);
        }
        let response = if let Some(proxy) = services.fetch.proxy_endpoint.as_deref() {
            call_cancellable(
                target.url.as_str(),
                CallKind::Get,
                CallTarget {
                    proxy: Some(proxy),
                    addresses: &[],
                },
                cancelled,
                FETCH_TIMEOUT,
            )?
        } else {
            call_cancellable(
                target.url.as_str(),
                CallKind::Get,
                CallTarget {
                    proxy: None,
                    addresses: &target.addresses,
                },
                cancelled,
                FETCH_TIMEOUT,
            )?
        };
        if response.status == 401 || response.status == 403 {
            return Err(WebError::Http {
                status: response.status,
                message: format!(
                    "authentication required or refused for {}. No body was returned.",
                    url
                ),
            });
        }
        if response.status == 429 {
            return Err(WebError::Http {
                status: 429,
                message: format!("rate limited by {url}. No body was returned."),
            });
        }
        if (300..400).contains(&response.status) {
            hops += 1;
            if hops > MAX_REDIRECTS {
                return Err(WebError::Policy(format!(
                    "too many redirects (max {MAX_REDIRECTS}); no body was returned"
                )));
            }
            let location = response
                .headers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("location"))
                .map(|(_, value)| value.clone())
                .unwrap_or_default();
            if location.is_empty() {
                return Err(WebError::Policy(
                    "redirect had no Location; no body was returned".into(),
                ));
            }
            let mut next = target.url.join(&location).map_err(|error| {
                WebError::Policy(format!("invalid redirect: {error}; no body was returned"))
            })?;
            // Scheme, host, port, path, and private-address policy all run again.
            // A path-scoped allowlist does not become the whole host.
            next = validate_fetch_url(next.as_str(), services.fetch.allow_local)?;
            upgrade_https(&mut next);
            if !same_origin(&target.url, &next) {
                return Err(WebError::Policy(format!(
                    "cross-host redirect from {} to {next}. Make a new web_fetch call if that URL is allowed. No body was returned.",
                    target.url.host_str().unwrap_or("unknown")
                )));
            }
            target = resolve_target(&next, services)?;
            continue;
        }
        if !(200..300).contains(&response.status) {
            return Err(WebError::Http {
                status: response.status,
                message: format!("fetch failed for {}. No body was returned.", target.url),
            });
        }
        let content_type = response
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
            .map(|(_, value)| value.clone())
            .unwrap_or_else(|| "text/html".into());
        if is_binary(&content_type) {
            return Err(WebError::Policy(format!(
                "unsupported content type {content_type} from {}; no body was returned",
                target.url
            )));
        }
        if response.body.len() > MAX_CONTENT_BYTES {
            return Err(WebError::Policy(format!(
                "response body exceeds {MAX_CONTENT_BYTES} bytes; no body was returned"
            )));
        }
        let text = response.body.clone();
        let rendered = if content_type.to_ascii_lowercase().contains("html") {
            html_to_text(&text)
        } else {
            text
        };
        let bytes = rendered.len();
        let truncated = bytes > MAX_MARKDOWN_CHARS;
        let content = if truncated {
            let mut cut = rendered
                .chars()
                .take(MAX_MARKDOWN_CHARS)
                .collect::<String>();
            cut.push_str(
                "\n\n[truncated: showing the first 100000 characters; the rest was not returned]",
            );
            cut
        } else {
            rendered
        };
        return Ok(FetchOutcome {
            url: target.url.to_string(),
            content,
            content_type: if content_type.to_ascii_lowercase().contains("html") {
                "markdown".into()
            } else {
                content_type
            },
            status_code: response.status,
            bytes,
            truncated,
            via_proxy: services.fetch.proxy_endpoint.is_some(),
        });
    }
}

pub fn format_fetch(outcome: &FetchOutcome) -> String {
    let mut header = format!(
        "Fetched {}\nstatus: {}\nbytes: {}\ntruncated: {}",
        outcome.url, outcome.status_code, outcome.bytes, outcome.truncated
    );
    if outcome.via_proxy {
        header.push_str("\nvia: configured proxy");
    }
    format!("{header}\n\n{}", outcome.content)
}

fn resolve_target(url: &Url, services: &WebServices) -> Result<ResolvedTarget, WebError> {
    check_destination(url, services)?;
    // A configured proxy resolves the origin. Pinning a local answer would skip it.
    // IP literals are still checked above, so a private literal never reaches the proxy.
    if services.fetch.proxy_endpoint.is_some() {
        return Ok(ResolvedTarget {
            url: url.clone(),
            addresses: Vec::new(),
        });
    }
    let host = url.host_str().unwrap_or("");
    let port = url
        .port_or_known_default()
        .ok_or_else(|| WebError::Policy("URL has no port; no request was made".into()))?;
    let addresses = approved_addresses(host, port, services.fetch.allow_local)?;
    Ok(ResolvedTarget {
        url: url.clone(),
        addresses,
    })
}

/// Resolve once. Any private, link-local, or metadata answer rejects the name.
/// The returned addresses are the only ones the connection may use.
fn lookup_host(host: &str, port: u16) -> Result<Vec<SocketAddr>, WebError> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    (host, port)
        .to_socket_addrs()
        .map(|addresses| addresses.collect())
        .map_err(|error| {
            WebError::Network(format!(
                "could not resolve {host}: {error}; no body was returned"
            ))
        })
}

fn approved_addresses(
    host: &str,
    port: u16,
    allow_local: bool,
) -> Result<Vec<SocketAddr>, WebError> {
    approved_lookup(host, allow_local, lookup_host(host, port)?)
}

fn approved_lookup(
    host: &str,
    allow_local: bool,
    looked_up: Vec<SocketAddr>,
) -> Result<Vec<SocketAddr>, WebError> {
    if looked_up.is_empty() {
        return Err(WebError::Network(format!(
            "could not resolve {host}; no body was returned"
        )));
    }
    if let Some(blocked) = looked_up
        .iter()
        .find(|address| is_blocked_ip(address.ip(), host, allow_local))
    {
        return Err(WebError::Policy(format!(
            "SSRF blocked: {host} resolved to {}; no request was made",
            blocked.ip()
        )));
    }
    Ok(looked_up)
}

fn check_destination(url: &Url, services: &WebServices) -> Result<(), WebError> {
    let host = url.host_str().unwrap_or("");
    if crate::privacy::is_official_endpoint(url.as_str()) {
        return Err(WebError::OfficialDestination);
    }
    if let Some(domains) = &services.fetch.allowed_domains {
        if domains.is_empty() || !domains.iter().any(|domain| domain_allows(domain, url)) {
            return Err(WebError::Policy(format!(
                "domain {host} is not in the web_fetch allowlist; no request was made"
            )));
        }
    } else if !built_in_domain(host) {
        return Err(WebError::Policy(format!(
            "domain {host} is outside the built-in web_fetch allowlist. Set toolset.web_fetch.allowed_domains to allow it; no request was made"
        )));
    }
    if let Ok(ip) = host.parse::<IpAddr>()
        && is_blocked_ip(ip, host, services.fetch.allow_local)
    {
        return Err(WebError::Policy(format!(
            "SSRF blocked: {host} is a private or local address; no request was made"
        )));
    }
    Ok(())
}

fn domain_allows(entry: &str, url: &Url) -> bool {
    let Some(rule) = parse_allow_entry(entry) else {
        return false;
    };
    let Some(raw_host) = url.host_str() else {
        return false;
    };
    if normalize_domain(raw_host) != rule.host {
        return false;
    }
    if let Some(expected) = rule.port {
        let actual = url.port_or_known_default().unwrap_or(0);
        if actual != expected {
            return false;
        }
    }
    let Some(prefix) = rule.path else {
        return true;
    };
    let url_path = url.path().to_ascii_lowercase();
    url_path == prefix
        || (url_path.starts_with(&prefix) && url_path.as_bytes().get(prefix.len()) == Some(&b'/'))
}

struct AllowEntry {
    host: String,
    port: Option<u16>,
    path: Option<String>,
}

/// `host`, `host:port`, `host/path`, and `host:port/path`.
/// The port is the digits before the path, never the path itself.
fn parse_allow_entry(entry: &str) -> Option<AllowEntry> {
    let text = entry.trim().trim_end_matches('/');
    if text.is_empty() {
        return None;
    }
    let (host_port, path) = match text.split_once('/') {
        Some((host, path)) => (host, Some(format!("/{path}").to_ascii_lowercase())),
        None => (text, None),
    };
    let (host, port) = if let Some(rest) = host_port.strip_prefix('[') {
        let (host, port) = rest.split_once("]:")?;
        (host.to_string(), Some(port.parse().ok()?))
    } else {
        match host_port.rsplit_once(':') {
            Some((name, port))
                if !name.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) =>
            {
                (name.to_string(), port.parse::<u16>().ok())
            }
            _ => (host_port.to_string(), None),
        }
    };
    let host = normalize_domain(&host);
    if host.is_empty() {
        return None;
    }
    Some(AllowEntry { host, port, path })
}

fn built_in_domain(host: &str) -> bool {
    const DEFAULTS: &[&str] = &[
        "docs.rs",
        "doc.rust-lang.org",
        "developer.mozilla.org",
        "docs.python.org",
        "go.dev",
        "pkg.go.dev",
        "nodejs.org",
        "react.dev",
        "www.typescriptlang.org",
    ];
    let host = normalize_domain(host);
    DEFAULTS.iter().any(|domain| host == *domain)
}

fn normalize_domain(raw: &str) -> String {
    let text = raw.trim().trim_end_matches('/').trim_end_matches('.');
    let text = text.strip_prefix("www.").unwrap_or(text);
    text.to_ascii_lowercase()
}

pub fn validate_fetch_url(raw: &str, allow_local: bool) -> Result<Url, WebError> {
    if raw.len() > MAX_URL_LENGTH {
        return Err(WebError::Policy(format!(
            "URL exceeds {MAX_URL_LENGTH} characters; no request was made"
        )));
    }
    let parsed = Url::parse(raw)
        .map_err(|error| WebError::Policy(format!("invalid URL: {error}; no request was made")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(WebError::Policy(format!(
            "unsupported URL scheme: {} (only http/https); no request was made",
            parsed.scheme()
        )));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(WebError::Policy(
            "URLs with embedded credentials are not allowed; no request was made".into(),
        ));
    }
    let host = parsed.host_str().unwrap_or("");
    if host.split('.').count() < 2 && !(allow_local && is_explicit_local_host(host)) {
        return Err(WebError::Policy(format!(
            "hostname must have at least two labels, got {host}; no request was made"
        )));
    }
    Ok(parsed)
}

fn upgrade_https(url: &mut Url) {
    if url.scheme() != "http" {
        return;
    }
    if url.host_str().is_some_and(is_explicit_local_host) {
        return;
    }
    let _ = url.set_scheme("https");
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

pub fn is_explicit_local_host(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(&host);
    let host = host.split('%').next().unwrap_or(host);
    host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

pub fn is_blocked_ip(ip: IpAddr, host: &str, allow_local: bool) -> bool {
    if !is_non_public_ip(ip) {
        return false;
    }
    if allow_local && is_loopback_addr(ip) && is_explicit_local_host(host) {
        return false;
    }
    true
}

fn is_loopback_addr(ip: IpAddr) -> bool {
    if ip.is_loopback() {
        return true;
    }
    match ip {
        IpAddr::V6(value) => value
            .to_ipv4_mapped()
            .is_some_and(|mapped| mapped.is_loopback()),
        IpAddr::V4(_) => false,
    }
}

pub fn is_non_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => is_non_public_v4(value),
        IpAddr::V6(value) => {
            if let Some(mapped) = value.to_ipv4_mapped() {
                is_non_public_v4(mapped)
            } else {
                value.is_loopback()
                    || value.is_unspecified()
                    || value.is_multicast()
                    || value.is_unique_local()
                    || value.is_unicast_link_local()
            }
        }
    }
}

fn is_non_public_v4(ip: Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || v4_cidr(ip, [0, 0, 0, 0], 8)
        || v4_cidr(ip, [100, 64, 0, 0], 10)
        || v4_cidr(ip, [192, 0, 0, 0], 24)
        || v4_cidr(ip, [192, 0, 2, 0], 24)
        || v4_cidr(ip, [198, 18, 0, 0], 15)
        || v4_cidr(ip, [198, 51, 100, 0], 24)
        || v4_cidr(ip, [203, 0, 113, 0], 24)
        || v4_cidr(ip, [240, 0, 0, 0], 4)
}

fn v4_cidr(ip: Ipv4Addr, base: [u8; 4], prefix: u8) -> bool {
    let ip = u32::from(ip);
    let base = u32::from(Ipv4Addr::from(base));
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    (ip & mask) == (base & mask)
}

fn is_binary(content_type: &str) -> bool {
    let value = content_type.to_ascii_lowercase();
    value.contains("image/")
        || value.contains("video/")
        || value.contains("audio/")
        || value.contains("application/pdf")
        || value.contains("application/octet-stream")
        || value.contains("application/zip")
}

fn html_to_text(html: &str) -> String {
    let without = strip_tag(html, "script");
    let without = strip_tag(&without, "style");
    let mut text = String::new();
    let mut in_tag = false;
    for ch in without.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                if !text.ends_with('\n') {
                    text.push('\n');
                }
            }
            _ if !in_tag => text.push(ch),
            _ => {}
        }
    }
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn strip_tag(html: &str, tag: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut output = String::new();
    let mut cursor = 0;
    while let Some(start) = lower[cursor..].find(&open) {
        let start = cursor + start;
        output.push_str(&html[cursor..start]);
        if let Some(end) = lower[start..].find(&close) {
            cursor = start + end + close.len();
        } else {
            cursor = html.len();
            break;
        }
    }
    output.push_str(&html[cursor..]);
    output
}

fn validate_proxy(proxy: &str) -> Result<Url, WebError> {
    let parsed = Url::parse(proxy).map_err(|error| {
        WebError::InvalidConfiguration(format!("invalid web fetch proxy: {error}"))
    })?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(WebError::InvalidConfiguration(
            "web fetch proxy must be http or https; no direct request was made".into(),
        ));
    }
    if crate::privacy::is_official_endpoint(proxy) {
        return Err(WebError::OfficialDestination);
    }
    Ok(parsed)
}

struct RawResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const CANCEL_SLICE: Duration = Duration::from_millis(200);
/// Handshake is a blocking native-tls call. Keep it short so cancel can close
/// the socket and join the worker instead of waiting out the request budget.
const TLS_HANDSHAKE: Duration = Duration::from_secs(5);

enum CallKind {
    Get,
    PostJson { body: String, api_key: String },
}

struct CallTarget<'a> {
    proxy: Option<&'a str>,
    addresses: &'a [SocketAddr],
}

/// One request. Cancel closes the socket and the worker is joined before this returns.
/// A cancelled call never returns the response body.
fn call_cancellable(
    url: &str,
    kind: CallKind,
    target: CallTarget<'_>,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Result<RawResponse, WebError> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(WebError::Cancelled);
    }
    let parsed = Url::parse(url).map_err(|error| WebError::Network(error.to_string()))?;
    let socket: Arc<Mutex<Option<TcpStream>>> = Arc::new(Mutex::new(None));
    let stop = Arc::new(AtomicBool::new(false));
    let url_owned = url.to_string();
    let proxy = target.proxy.map(str::to_string);
    let addresses = target.addresses.to_vec();
    let socket_for_call = Arc::clone(&socket);
    let stop_for_call = Arc::clone(&stop);
    let (sender, receiver) = std::sync::mpsc::channel();
    let worker: JoinHandle<()> = thread::spawn(move || {
        let outcome = run_request(
            &url_owned,
            &parsed,
            kind,
            proxy.as_deref(),
            &addresses,
            &socket_for_call,
            &stop_for_call,
            timeout,
        );
        let _ = sender.send(outcome);
    });
    let started = Instant::now();
    let outcome = loop {
        if cancelled.load(Ordering::Relaxed) {
            stop.store(true, Ordering::Relaxed);
            shutdown_socket(&socket);
            break Err(WebError::Cancelled);
        }
        if started.elapsed() > timeout + Duration::from_secs(2) {
            stop.store(true, Ordering::Relaxed);
            shutdown_socket(&socket);
            break Err(WebError::Network(
                "request timed out; no body was returned".into(),
            ));
        }
        match receiver.recv_timeout(CANCEL_SLICE) {
            Ok(outcome) => break outcome,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                break Err(WebError::Network(
                    "request disconnected; no body was returned".into(),
                ));
            }
        }
    };
    stop.store(true, Ordering::Relaxed);
    shutdown_socket(&socket);
    let _ = worker.join();
    if cancelled.load(Ordering::Relaxed) {
        return Err(WebError::Cancelled);
    }
    outcome
}

fn shutdown_socket(socket: &Mutex<Option<TcpStream>>) {
    if let Ok(guard) = socket.lock()
        && let Some(stream) = guard.as_ref()
    {
        let _ = stream.shutdown(Shutdown::Both);
    }
}

fn run_request(
    url: &str,
    parsed: &Url,
    kind: CallKind,
    proxy: Option<&str>,
    addresses: &[SocketAddr],
    socket: &Arc<Mutex<Option<TcpStream>>>,
    cancelled: &Arc<AtomicBool>,
    timeout: Duration,
) -> Result<RawResponse, WebError> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(WebError::Cancelled);
    }
    let host = parsed.host_str().unwrap_or("").to_string();
    // One exchange for a direct origin and for the configured proxy. The socket
    // is stored before the first byte and closed when cancel flips. ureq's HTTP
    // path never enters a TLS connector, so it cannot publish that socket.
    let _ = url;
    if let Some(proxy) = proxy {
        let proxy_url = Url::parse(proxy).map_err(|error| {
            WebError::InvalidConfiguration(format!("invalid web fetch proxy: {error}"))
        })?;
        let proxy_host = proxy_url.host_str().unwrap_or("").to_string();
        let proxy_port = proxy_url.port_or_known_default().unwrap_or(80);
        let proxy_addresses = approved_addresses(&proxy_host, proxy_port, true)?;
        let address = proxy_addresses.first().copied().ok_or_else(|| {
            WebError::Network("proxy has no approved address; no body was returned".into())
        })?;
        return proxy_exchange(
            parsed,
            &host,
            &proxy_url,
            &proxy_host,
            address,
            &kind,
            socket,
            cancelled,
            timeout,
        );
    }
    let address = addresses
        .first()
        .copied()
        .ok_or_else(|| WebError::Network("no approved address; no body was returned".into()))?;
    http_exchange(parsed, &host, address, &kind, socket, cancelled, timeout)
}

fn proxy_exchange(
    origin: &Url,
    origin_host: &str,
    proxy: &Url,
    proxy_host: &str,
    address: SocketAddr,
    kind: &CallKind,
    socket: &Arc<Mutex<Option<TcpStream>>>,
    cancelled: &Arc<AtomicBool>,
    timeout: Duration,
) -> Result<RawResponse, WebError> {
    if proxy.scheme() != "http" {
        return Err(WebError::InvalidConfiguration(
            "web fetch proxy must be an http proxy; https proxying is not enabled. No direct request was made.".into(),
        ));
    }
    if cancelled.load(Ordering::Relaxed) {
        return Err(WebError::Cancelled);
    }
    let stream = TcpStream::connect_timeout(&address, Duration::from_secs(5)).map_err(|error| {
        WebError::Network(format!(
            "connect proxy {proxy_host}: {error}; no body was returned"
        ))
    })?;
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(CANCEL_SLICE));
    let _ = stream.set_write_timeout(Some(CANCEL_SLICE));
    if let Ok(copy) = stream.try_clone()
        && let Ok(mut slot) = socket.lock()
    {
        *slot = Some(copy);
    }
    // CONNECT for http and https. The proxy never sees an absolute-form
    // request, and a refused tunnel does not fall through to a direct fetch.
    let port = origin
        .port_or_known_default()
        .ok_or_else(|| WebError::Policy("URL has no port; no request was made".into()))?;
    let connect = format!(
        "CONNECT {origin_host}:{port} HTTP/1.1\r\nHost: {origin_host}:{port}\r\nUser-Agent: {USER_AGENT}\r\nProxy-Connection: keep-alive\r\n\r\n"
    );
    let mut plain: Box<dyn HttpIo> = Box::new(
        stream
            .try_clone()
            .map_err(|error| WebError::Network(format!("{error}; no body was returned")))?,
    );
    write_until(&mut plain, connect.as_bytes(), &stream, cancelled, timeout)?;
    // CONNECT 200 has headers and no body. Waiting for content-length or
    // connection close would consume the origin response that follows.
    let tunnel = read_headers(&mut plain, &stream, cancelled, timeout)?;
    if !(200..300).contains(&tunnel.status) {
        return Err(WebError::Http {
            status: tunnel.status,
            message: format!(
                "proxy refused CONNECT to {origin_host}:{port}. No body was returned."
            ),
        });
    }
    let secure = origin.scheme() == "https";
    let mut io = session_io(&stream, secure, origin_host, cancelled)?;
    let request = http_request(origin, origin_host, kind)?;
    write_until(&mut io, request.as_bytes(), &stream, cancelled, timeout)?;
    read_http(&mut io, &stream, cancelled, timeout)
}

/// Dial the one approved address and read one response. Each read waits only
/// `CANCEL_SLICE`, then checks the flag and shuts the socket down. A cancelled
/// read returns no body.
fn http_exchange(
    url: &Url,
    host: &str,
    address: SocketAddr,
    kind: &CallKind,
    socket: &Arc<Mutex<Option<TcpStream>>>,
    cancelled: &Arc<AtomicBool>,
    timeout: Duration,
) -> Result<RawResponse, WebError> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(WebError::Cancelled);
    }
    let stream = TcpStream::connect_timeout(&address, Duration::from_secs(5)).map_err(|error| {
        WebError::Network(format!("connect {host}: {error}; no body was returned"))
    })?;
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(CANCEL_SLICE));
    let _ = stream.set_write_timeout(Some(CANCEL_SLICE));
    if let Ok(copy) = stream.try_clone()
        && let Ok(mut slot) = socket.lock()
    {
        *slot = Some(copy);
    }
    let mut io = session_io(&stream, url.scheme() == "https", host, cancelled)?;
    let request = http_request(url, host, kind)?;
    write_until(&mut io, request.as_bytes(), &stream, cancelled, timeout)?;
    read_http(&mut io, &stream, cancelled, timeout)
}

/// Plain HTTP, or native-tls over the already pinned socket. The handshake
/// shares the extra-CA connector and checks the cancel flag between slices.
fn session_io(
    stream: &TcpStream,
    secure: bool,
    host: &str,
    cancelled: &AtomicBool,
) -> Result<Box<dyn HttpIo>, WebError> {
    if !secure {
        return Ok(Box::new(stream.try_clone().map_err(|error| {
            WebError::Network(format!("{error}; no body was returned"))
        })?));
    }
    if cancelled.load(Ordering::Relaxed) {
        return Err(WebError::Cancelled);
    }
    let handshake = stream
        .try_clone()
        .map_err(|error| WebError::Network(format!("{error}; no body was returned")))?;
    let _ = handshake.set_read_timeout(Some(TLS_HANDSHAKE));
    let _ = handshake.set_write_timeout(Some(TLS_HANDSHAKE));
    let (connector, _) = crate::extra_ca::native_tls_connector(configured_extra_ca().as_deref())
        .map_err(|error| WebError::Network(format!("{error}; no body was returned")))?;
    let host = host.to_string();
    let flag = Arc::new(AtomicBool::new(false));
    let stop = Arc::clone(&flag);
    let worker = thread::spawn(move || {
        let outcome = connector.connect(&host, handshake).map_err(|error| {
            WebError::Network(format!("tls {host}: {error}; no body was returned"))
        });
        stop.store(true, Ordering::Relaxed);
        outcome
    });
    let started = Instant::now();
    loop {
        if cancelled.load(Ordering::Relaxed) || started.elapsed() > TLS_HANDSHAKE {
            let _ = stream.shutdown(Shutdown::Both);
        }
        if flag.load(Ordering::Relaxed) || worker.is_finished() {
            break;
        }
        thread::sleep(CANCEL_SLICE);
    }
    let tls = worker
        .join()
        .map_err(|_| WebError::Network("tls handshake failed; no body was returned".into()))?;
    if cancelled.load(Ordering::Relaxed) {
        return Err(WebError::Cancelled);
    }
    let tls = tls?;
    let _ = stream.set_read_timeout(Some(CANCEL_SLICE));
    let _ = stream.set_write_timeout(Some(CANCEL_SLICE));
    Ok(Box::new(tls))
}

fn http_request(url: &Url, host: &str, kind: &CallKind) -> Result<String, WebError> {
    let port = url.port_or_known_default().unwrap_or(0);
    let default_port = if url.scheme() == "https" { 443 } else { 80 };
    let host_header = if port == default_port {
        host.to_string()
    } else if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let path = match (url.path(), url.query()) {
        (path, Some(query)) => format!("{path}?{query}"),
        ("", None) => "/".into(),
        (path, None) => path.to_string(),
    };
    let body = match kind {
        CallKind::Get => String::new(),
        CallKind::PostJson { body, .. } => body.clone(),
    };
    let mut headers = match kind {
        CallKind::Get => vec![
            format!("GET {path} HTTP/1.1"),
            format!("Host: {host_header}"),
            format!("User-Agent: {USER_AGENT}"),
            "Accept: text/markdown,text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8"
                .into(),
            "Accept-Language: en-US,en;q=0.9".into(),
            "Connection: close".into(),
        ],
        CallKind::PostJson { api_key, .. } => vec![
            format!("POST {path} HTTP/1.1"),
            format!("Host: {host_header}"),
            format!("User-Agent: {USER_AGENT}"),
            format!("Authorization: Bearer {api_key}"),
            "Content-Type: application/json".into(),
            "Accept: application/json".into(),
            format!("Content-Length: {}", body.len()),
            "Connection: close".into(),
        ],
    };
    headers.push(String::new());
    Ok(format!("{}\r\n{body}", headers.join("\r\n")))
}

trait HttpIo: std::io::Read + std::io::Write + Send {}
impl<T: std::io::Read + std::io::Write + Send> HttpIo for T {}

fn write_until(
    io: &mut Box<dyn HttpIo>,
    bytes: &[u8],
    socket: &TcpStream,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Result<(), WebError> {
    let started = Instant::now();
    let mut sent = 0;
    while sent < bytes.len() {
        if cancelled.load(Ordering::Relaxed) {
            let _ = socket.shutdown(Shutdown::Both);
            return Err(WebError::Cancelled);
        }
        if started.elapsed() > timeout {
            return Err(WebError::Network(
                "request timed out; no body was returned".into(),
            ));
        }
        match io.write(&bytes[sent..]) {
            Ok(0) => {
                return Err(WebError::Network(
                    "connection closed while sending; no body was returned".into(),
                ));
            }
            Ok(count) => sent += count,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                thread::sleep(CANCEL_SLICE);
                continue;
            }
            Err(error) => {
                return Err(WebError::Network(format!("{error}; no body was returned")));
            }
        }
    }
    io.flush()
        .map_err(|error| WebError::Network(format!("{error}; no body was returned")))
}

fn read_headers(
    io: &mut Box<dyn HttpIo>,
    socket: &TcpStream,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Result<RawResponse, WebError> {
    read_limited(io, socket, cancelled, timeout, true)
}

fn read_http(
    io: &mut Box<dyn HttpIo>,
    socket: &TcpStream,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Result<RawResponse, WebError> {
    read_limited(io, socket, cancelled, timeout, false)
}

fn read_limited(
    io: &mut Box<dyn HttpIo>,
    socket: &TcpStream,
    cancelled: &AtomicBool,
    timeout: Duration,
    headers_only: bool,
) -> Result<RawResponse, WebError> {
    let started = Instant::now();
    let mut raw = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        if cancelled.load(Ordering::Relaxed) {
            let _ = socket.shutdown(Shutdown::Both);
            return Err(WebError::Cancelled);
        }
        if started.elapsed() > timeout {
            return Err(WebError::Network(
                "request timed out; no body was returned".into(),
            ));
        }
        if raw.len() > MAX_CONTENT_BYTES + 65_536 {
            return Err(WebError::Policy(format!(
                "response body exceeds {MAX_CONTENT_BYTES} bytes; no body was returned"
            )));
        }
        match io.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => raw.extend_from_slice(&buffer[..count]),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                thread::sleep(CANCEL_SLICE);
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                return Err(WebError::Cancelled);
            }
            Err(error) => {
                return Err(WebError::Network(format!("{error}; no body was returned")));
            }
        }
        if let Some(split) = find_header_end(&raw) {
            if headers_only {
                raw.truncate(split);
                break;
            }
            if response_complete(&raw, split) {
                raw.truncate(framed_end(&raw, split));
                break;
            }
            if matches!(frame_status(&raw, split), FrameStatus::Invalid) {
                return Err(WebError::Network(
                    "invalid chunk framing; no body was returned".into(),
                ));
            }
        }
    }
    if cancelled.load(Ordering::Relaxed) {
        return Err(WebError::Cancelled);
    }
    parse_http(&raw)
}

fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

fn is_chunked(header: &str) -> bool {
    header_value(header, "transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
}

fn content_length(header: &str) -> Option<usize> {
    header_value(header, "content-length").and_then(|value| value.parse::<usize>().ok())
}

enum FrameStatus {
    /// Index just past the bytes that belong to this response.
    Complete(usize),
    /// A size line, payload, CRLF, or trailer blank line is still missing.
    Incomplete,
    /// A finished line is not valid chunk framing. Do not wait for EOF.
    Invalid,
}

/// How many bytes of `raw` belong to this response once it is complete.
/// Chunk size lines are framing, so a payload that contains `0\r\n\r\n` is
/// not the terminator. The next size is read only after that many bytes.
fn frame_status(raw: &[u8], body_at: usize) -> FrameStatus {
    let header = String::from_utf8_lossy(&raw[..body_at]);
    if is_chunked(&header) {
        return match chunked_message_end(raw, body_at) {
            ChunkEnd::Complete(end) => FrameStatus::Complete(end),
            ChunkEnd::Incomplete => FrameStatus::Incomplete,
            ChunkEnd::Invalid => FrameStatus::Invalid,
        };
    }
    if let Some(length) = content_length(&header) {
        return if raw.len().saturating_sub(body_at) >= length {
            FrameStatus::Complete((body_at + length).min(raw.len()))
        } else {
            FrameStatus::Incomplete
        };
    }
    // No length and not chunked: only EOF finishes the body.
    FrameStatus::Incomplete
}

fn response_complete(raw: &[u8], body_at: usize) -> bool {
    matches!(frame_status(raw, body_at), FrameStatus::Complete(_))
}

fn framed_end(raw: &[u8], body_at: usize) -> usize {
    match frame_status(raw, body_at) {
        FrameStatus::Complete(end) => end,
        FrameStatus::Incomplete | FrameStatus::Invalid => raw.len(),
    }
}

const MAX_CHUNK_LINE: usize = 4096;
const MAX_TRAILER_BYTES: usize = 8192;

enum ChunkEnd {
    Complete(usize),
    Incomplete,
    Invalid,
}

/// End of a chunked message. `Incomplete` while a size line, its payload and
/// CRLF, or the trailer section after the zero chunk is still short. A payload
/// that itself contains `0\r\n\r\n` is data: the cursor skips `size` bytes and
/// never scans them for a terminator.
///
/// RFC 9112: after the zero-size line come optional trailer fields, then one
/// blank line. `0\r\n\r\n` is the no-trailer form. `0\r\nX-Trail: 1\r\n\r\n`
/// ends at the blank line, not at the trailer field. A finished line that is
/// not a chunk size or a trailer field is `Invalid`.
fn chunked_message_end(raw: &[u8], body_at: usize) -> ChunkEnd {
    let mut cursor = body_at;
    loop {
        let (size, payload) = match chunk_size_line(raw, cursor) {
            ChunkLine::Size(size, payload) => (size, payload),
            ChunkLine::Incomplete => return ChunkEnd::Incomplete,
            ChunkLine::Invalid => return ChunkEnd::Invalid,
        };
        if size == 0 {
            return chunk_trailer_end(raw, payload);
        }
        // Skip the payload and its CRLF. Do not search those bytes.
        let Some(after) = payload.checked_add(size).and_then(|end| end.checked_add(2)) else {
            return ChunkEnd::Invalid;
        };
        if after > raw.len() {
            return ChunkEnd::Incomplete;
        }
        if &raw[after - 2..after] != b"\r\n" {
            return ChunkEnd::Invalid;
        }
        cursor = after;
    }
}

enum ChunkLine {
    Size(usize, usize),
    Incomplete,
    Invalid,
}

/// Chunk-size line at `cursor`. `Size` is `(size, index of the first payload byte)`.
fn chunk_size_line(raw: &[u8], cursor: usize) -> ChunkLine {
    let Some(rest) = raw.get(cursor..) else {
        return ChunkLine::Incomplete;
    };
    let Some(line_at) = rest.windows(2).position(|window| window == b"\r\n") else {
        return if rest.len() > MAX_CHUNK_LINE {
            ChunkLine::Invalid
        } else {
            ChunkLine::Incomplete
        };
    };
    if line_at > MAX_CHUNK_LINE {
        return ChunkLine::Invalid;
    }
    let line_end = cursor + line_at;
    let Ok(line) = std::str::from_utf8(&raw[cursor..line_end]) else {
        return ChunkLine::Invalid;
    };
    let size_text = line.split(';').next().unwrap_or("").trim();
    if size_text.is_empty() || !size_text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return ChunkLine::Invalid;
    }
    // BWS and `chunk-ext` are allowed. The size is what advances the cursor,
    // so the extension is not scanned as a terminator. A control byte or an
    // unquoted delimiter is not an extension.
    if let Some(extension) = line.split_once(';').map(|(_, extension)| extension)
        && !valid_chunk_extension(extension)
    {
        return ChunkLine::Invalid;
    }
    let Ok(size) = usize::from_str_radix(size_text, 16) else {
        return ChunkLine::Invalid;
    };
    if size > MAX_CONTENT_BYTES {
        return ChunkLine::Invalid;
    }
    ChunkLine::Size(size, line_end + 2)
}

/// `chunk-ext` after the first `;`: `*( ";" name [ "=" token | quoted ] )`.
/// OWS is allowed around the name and `=`. A control byte is not an extension.
fn valid_chunk_extension(extension: &str) -> bool {
    if extension.is_empty() {
        return false;
    }
    extension.split(';').all(|part| {
        let part = part.trim();
        if part.is_empty() {
            return false;
        }
        let (name, value) = match part.split_once('=') {
            Some((name, value)) => (name.trim(), Some(value.trim())),
            None => (part, None),
        };
        !name.is_empty()
            && name.bytes().all(token_byte)
            && value.is_none_or(|value| {
                if let Some(inner) = value.strip_prefix('"') {
                    inner
                        .strip_suffix('"')
                        .is_some_and(|quoted| quoted.bytes().all(quoted_byte))
                } else {
                    !value.is_empty() && value.bytes().all(token_byte)
                }
            })
    })
}

fn quoted_byte(byte: u8) -> bool {
    byte == b'\t' || byte == b' ' || (byte.is_ascii_graphic() && byte != b'\\' && byte != b'"')
}

fn token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

/// Trailer section that begins at `at` (the first byte after `0[;ext]\r\n`).
/// `Complete` is the index just past the terminating blank line.
///
/// A trailer field is `token: value` ending in CRLF. The blank line is CRLF
/// with nothing before it. Missing bytes stay `Incomplete`. A finished line
/// that is neither a field nor the blank line is `Invalid`, so a keep-alive
/// read does not wait for the peer to close.
fn chunk_trailer_end(raw: &[u8], at: usize) -> ChunkEnd {
    let mut cursor = at;
    let limit = at.saturating_add(MAX_TRAILER_BYTES);
    loop {
        if cursor > limit {
            return ChunkEnd::Invalid;
        }
        let Some(rest) = raw.get(cursor..) else {
            return ChunkEnd::Incomplete;
        };
        let Some(line_at) = rest.windows(2).position(|window| window == b"\r\n") else {
            return if rest.len() > MAX_CHUNK_LINE {
                ChunkEnd::Invalid
            } else {
                ChunkEnd::Incomplete
            };
        };
        if line_at > MAX_CHUNK_LINE {
            return ChunkEnd::Invalid;
        }
        let line_end = cursor + line_at;
        if line_at == 0 {
            return ChunkEnd::Complete(line_end + 2);
        }
        let Ok(line) = std::str::from_utf8(&raw[cursor..line_end]) else {
            return ChunkEnd::Invalid;
        };
        if !valid_trailer_line(line) {
            return ChunkEnd::Invalid;
        }
        cursor = line_end + 2;
    }
}

fn valid_trailer_line(line: &str) -> bool {
    let Some((name, value)) = line.split_once(':') else {
        return false;
    };
    let name = name.trim();
    if name.is_empty() || !name.bytes().all(token_byte) {
        return false;
    }
    // obs-fold is forbidden. The value may otherwise be empty.
    !value
        .as_bytes()
        .iter()
        .any(|byte| matches!(byte, b'\0' | b'\r' | b'\n'))
        && !name.eq_ignore_ascii_case("transfer-encoding")
        && !name.eq_ignore_ascii_case("content-length")
        && !name.eq_ignore_ascii_case("host")
        && !name.eq_ignore_ascii_case("trailer")
}

fn header_value<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn parse_http(raw: &[u8]) -> Result<RawResponse, WebError> {
    let body_at = find_header_end(raw)
        .ok_or_else(|| WebError::Network("response had no header; no body was returned".into()))?;
    let header = String::from_utf8_lossy(&raw[..body_at]).to_string();
    let status = header
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| WebError::Network("response had no status; no body was returned".into()))?;
    let mut headers = Vec::new();
    for line in header.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        headers.push((name.trim().to_string(), value.trim().to_string()));
    }
    let encoded = &raw[body_at..];
    let bytes = if is_chunked(&header) {
        decode_chunks(encoded)?
    } else if let Some(length) = content_length(&header) {
        encoded.get(..length).unwrap_or(encoded).to_vec()
    } else {
        encoded.to_vec()
    };
    let body = if (200..300).contains(&status) {
        String::from_utf8_lossy(&bytes).to_string()
    } else {
        String::new()
    };
    Ok(RawResponse {
        status,
        headers,
        body,
    })
}

fn decode_chunks(raw: &[u8]) -> Result<Vec<u8>, WebError> {
    let mut output = Vec::new();
    let mut cursor = 0;
    while cursor < raw.len() {
        let line_end = raw[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .map(|index| cursor + index)
            .ok_or_else(|| WebError::Network("truncated chunk; no body was returned".into()))?;
        let line = std::str::from_utf8(&raw[cursor..line_end]).unwrap_or("");
        let size = usize::from_str_radix(line.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| WebError::Network("invalid chunk size; no body was returned".into()))?;
        cursor = line_end + 2;
        if size == 0 {
            break;
        }
        let end = cursor + size;
        if end + 2 > raw.len() {
            return Err(WebError::Network(
                "truncated chunk; no body was returned".into(),
            ));
        }
        output.extend_from_slice(&raw[cursor..end]);
        cursor = end + 2;
    }
    Ok(output)
}

fn configured_extra_ca() -> Option<std::path::PathBuf> {
    let env = std::env::vars().collect::<BTreeMap<_, _>>();
    crate::extra_ca::configured_bundle(&env).map(|(_, path)| path)
}

fn bool_text(value: bool) -> String {
    if value { "true" } else { "false" }.into()
}

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

fn string_path(value: &TomlValue, path: &[&str]) -> Option<String> {
    string_at(value, path)
}

fn walk<'a>(value: &'a TomlValue, path: &[&str]) -> Option<&'a TomlValue> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

/// Guide 26 Requirements column. `pin` holds against user, env, and managed.
/// `yes` is valid in requirements but loses to the user file and env.
enum Layer {
    Pin,
    Yes,
}

fn layered_string(
    requirements: Option<&TomlValue>,
    managed: Option<&TomlValue>,
    user: &TomlValue,
    env_value: Option<&String>,
    path: &[&str],
    layer: Layer,
) -> (Option<String>, String) {
    let required = requirements.and_then(|table| string_path(table, path));
    if matches!(layer, Layer::Pin)
        && let Some(value) = required.clone()
    {
        return (Some(value), "requirements".into());
    }
    // Managed is `user`, so the developer file wins over env and over a
    // requirements `yes`. Env still beats that requirements value and managed.
    if let Some(value) = string_path(user, path) {
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
    if let Some(value) = managed.and_then(|table| string_path(table, path)) {
        return (Some(value), "managed".into());
    }
    (None, "default".into())
}

fn layered_strings(
    requirements: Option<&TomlValue>,
    managed: Option<&TomlValue>,
    user: &TomlValue,
    path: &[&str],
) -> (Vec<String>, String) {
    // Guide 26 marks both search lists `yes` / `user`. Env does not set them.
    // The user file beats requirements `yes`; managed is the default under both.
    if let Some(value) = string_list(user, path) {
        return (value, "config.toml".into());
    }
    if let Some(value) = requirements.and_then(|table| string_list(table, path)) {
        return (value, "requirements".into());
    }
    if let Some(value) = managed.and_then(|table| string_list(table, path)) {
        return (value, "managed".into());
    }
    (Vec::new(), "default".into())
}

fn layered_domain_list(
    requirements: Option<&TomlValue>,
    managed: Option<&TomlValue>,
    user: &TomlValue,
    path: &[&str],
) -> (Option<Vec<String>>, String) {
    // Same `yes` / `user` column as the search lists. An explicit empty user
    // list still blocks and beats requirements; managed is only the default.
    if walk(user, path).is_some() {
        return (
            Some(string_list(user, path).unwrap_or_default()),
            "config.toml".into(),
        );
    }
    if requirements.and_then(|table| walk(table, path)).is_some() {
        return (
            Some(
                requirements
                    .and_then(|table| string_list(table, path))
                    .unwrap_or_default(),
            ),
            "requirements".into(),
        );
    }
    if managed.and_then(|table| walk(table, path)).is_some() {
        return (
            Some(
                managed
                    .and_then(|table| string_list(table, path))
                    .unwrap_or_default(),
            ),
            "managed".into(),
        );
    }
    (None, "default".into())
}

/// `features.web_fetch` is requirements `pin` and managed `user`.
/// A pin beats env, user, and managed. `GROK_DISABLE_WEB_FETCH` is an off
/// switch under that pin, not a way around it.
fn layered_pin_bool(
    requirements: Option<&TomlValue>,
    managed: Option<&TomlValue>,
    user: &TomlValue,
    env_on: Option<&String>,
    env_off: Option<&String>,
    path: &[&str],
) -> (Option<bool>, String) {
    if let Some(value) = bool_at(requirements, path) {
        return (Some(value), "requirements".into());
    }
    // The documented off switch and GROK_WEB_FETCH beat the user file.
    // Managed remains a default under both. A requirements pin already returned.
    if env_flag(env_off) == Some(true) {
        return (Some(false), "environment".into());
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

fn layered_bool(
    requirements: Option<&TomlValue>,
    user: &TomlValue,
    env_value: Option<&String>,
    managed: Option<&TomlValue>,
    path: &[&str],
) -> (Option<bool>, String) {
    // allow_local is absent from guide 26. Guide 05 puts TOML over env.
    // Requirements stay an admin file. Both beat a managed default.
    if let Some(value) = bool_at(requirements, path) {
        return (Some(value), "requirements".into());
    }
    if let Some(value) = bool_at_value(user, path) {
        return (Some(value), "config.toml".into());
    }
    if let Some(value) = env_flag(env_value) {
        return (Some(value), "environment".into());
    }
    if let Some(value) = bool_at(managed, path) {
        return (Some(value), "managed".into());
    }
    (None, "default".into())
}

fn string_list(value: &TomlValue, path: &[&str]) -> Option<Vec<String>> {
    walk(value, path)?.as_array().map(|items| {
        items
            .iter()
            .filter_map(TomlValue::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect()
    })
}

fn _ipv6_link_local_blocked() -> bool {
    is_non_public_ip("fe80::1".parse::<Ipv6Addr>().unwrap().into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_fetch_allowlist_blocks_and_search_allowlist_wins() {
        let mut services = WebServices::disabled();
        services.fetch.enabled = true;
        services.fetch.allowed_domains = Some(Vec::new());
        let blocked = fetch_url(
            &services,
            "https://docs.rs/tokio",
            &std::sync::atomic::AtomicBool::new(false),
        );
        assert!(blocked.unwrap_err().to_string().contains("allowlist"));

        services.search.enabled = true;
        services.search.base_url = Some("http://search.example/v1".into());
        services.search.model = Some("search-model".into());
        services.search.allowed_domains = vec!["docs.example".into()];
        services.search.excluded_domains = vec!["blocked.example".into()];
        let body = search_request_body(&services, "rust").unwrap();
        let filters = &body["tools"][0]["filters"];
        assert_eq!(filters["allowed_domains"][0], "docs.example");
        assert!(filters.get("excluded_domains").is_none());
    }

    #[test]
    fn private_and_metadata_targets_stay_blocked() {
        assert!(is_blocked_ip("10.0.0.1".parse().unwrap(), "10.0.0.1", true));
        assert!(is_blocked_ip(
            "169.254.169.254".parse().unwrap(),
            "169.254.169.254",
            true
        ));
        assert!(is_blocked_ip(
            "127.0.0.1".parse().unwrap(),
            "127.0.0.1",
            false
        ));
        assert!(!is_blocked_ip(
            "127.0.0.1".parse().unwrap(),
            "localhost",
            true
        ));
        assert!(is_blocked_ip(
            "127.0.0.1".parse().unwrap(),
            "evil.example",
            true
        ));
    }

    #[test]
    fn fetch_toml_beats_env_and_search_block_uses_configured_domains() {
        let mut env = BTreeMap::new();
        env.insert("GROK_WEB_FETCH_ALLOW_LOCAL".into(), "1".into());
        env.insert(
            "GROK_WEB_FETCH_PROXY".into(),
            "http://env-proxy.example:9".into(),
        );
        env.insert("GROK_WEB_SEARCH_MODEL".into(), "env-model".into());
        env.insert("SEARCH_API_KEY".into(), "present".into());
        let table = r#"
[models]
web_search = "search-model"
[model.search-model]
model = "search-model"
base_url = "http://search.example/v1"
env_key = "SEARCH_API_KEY"
supports_backend_search = true
[features]
web_fetch = true
[toolset.web_fetch]
allow_local = false
proxy_endpoint = "http://toml-proxy.example:9"
[toolset.web_search]
excluded_domains = ["blocked.example"]
"#;
        let parsed: TomlValue = toml::from_str(table).unwrap();
        let services = load_services(&parsed, &env, None, None);
        assert!(!services.fetch.allow_local);
        assert_eq!(services.fetch.allow_local_source, "config.toml");
        assert_eq!(
            services.fetch.proxy_endpoint.as_deref(),
            Some("http://toml-proxy.example:9")
        );
        assert!(
            services.search.enabled,
            "enabled={} backend={} key={} base={:?} errors={:?} model={:?}",
            services.search.enabled,
            services.search.backend_search,
            services.search.api_key_set,
            services.search.base_url,
            services.errors,
            services.search.model,
        );
        let body = search_request_body(&services, "rust").unwrap();
        assert!(body["tools"][0]["filters"].get("allowed_domains").is_none());
        assert_eq!(
            body["tools"][0]["filters"]["excluded_domains"][0],
            "blocked.example"
        );
    }

    #[test]
    fn requirements_lock_fetch_off_and_empty_search_stays_unbounded() {
        let mut env = BTreeMap::new();
        env.insert("GROK_WEB_FETCH".into(), "1".into());
        let requirements: TomlValue = toml::from_str("[features]\nweb_fetch = false\n").unwrap();
        let user: TomlValue = toml::from_str("[features]\nweb_fetch = true\n").unwrap();
        let services = load_services(&user, &env, Some(&requirements), None);
        assert!(!services.fetch.enabled);
        assert_eq!(services.fetch.enabled_source, "requirements");
        assert!(services.fetch.allowed_domains.is_none());

        let search = r#"
[models]
web_search = "search-model"
[model.search-model]
model = "search-model"
base_url = "http://search.example/v1"
env_key = "SEARCH_API_KEY"
supports_backend_search = true
"#;
        let search: TomlValue = toml::from_str(search).unwrap();
        let mut env = BTreeMap::new();
        env.insert("SEARCH_API_KEY".into(), "present".into());
        let services = load_services(&search, &env, None, None);
        let body = search_request_body(&services, "rust").unwrap();
        assert!(body["tools"][0].get("filters").is_none());
    }

    #[test]
    fn one_private_answer_rejects_the_name() {
        let host = "mixed.invalid";
        let looked_up = vec![
            SocketAddr::from(([1, 2, 3, 4], 80)),
            SocketAddr::from(([10, 1, 2, 3], 80)),
        ];
        let decision = approved_lookup(host, false, looked_up);
        assert!(decision.unwrap_err().to_string().contains("SSRF"));
        let literal = lookup_host("127.0.0.1", 9).unwrap();
        assert_eq!(literal, vec![SocketAddr::from(([127, 0, 0, 1], 9))]);
        assert!(approved_addresses("10.1.2.3", 80, true).is_err());
        let entry = parse_allow_entry("127.0.0.1:9/public").unwrap();
        assert_eq!(entry.port, Some(9));
        assert_eq!(entry.path.as_deref(), Some("/public"));
        let url = Url::parse("http://127.0.0.1:9/public/page").unwrap();
        assert!(domain_allows("127.0.0.1:9/public", &url));
        let widened = Url::parse("http://127.0.0.1:9/secret-path").unwrap();
        assert!(!domain_allows("127.0.0.1:9/public", &widened));
    }

    #[test]
    fn managed_web_values_stay_user_overridable() {
        let user: TomlValue = toml::from_str(
            "[features]\nweb_fetch = true\n[toolset.web_fetch]\nproxy_endpoint = \"http://user-proxy.example:9\"\nallowed_domains = [\"docs.example\"]\n",
        )
        .unwrap();
        let managed: TomlValue = toml::from_str(
            "[features]\nweb_fetch = false\n[toolset.web_fetch]\nproxy_endpoint = \"http://managed-proxy.example:9\"\nallowed_domains = [\"locked.example\"]\n",
        )
        .unwrap();
        let services = load_services(&user, &BTreeMap::new(), None, Some(&managed));
        assert!(services.fetch.enabled);
        assert_eq!(services.fetch.enabled_source, "config.toml");
        assert_eq!(
            services.fetch.proxy_endpoint.as_deref(),
            Some("http://user-proxy.example:9")
        );
        assert_eq!(
            services.fetch.allowed_domains.as_deref(),
            Some(["docs.example".to_string()].as_slice())
        );
    }

    #[test]
    fn chunk_payload_containing_zero_terminator_is_not_the_end() {
        let payload = b"BEFORE 0\r\n\r\n AFTER";
        let next = b"TAIL";
        let mut raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        raw.extend(format!("{:x}\r\n", payload.len()).into_bytes());
        raw.extend_from_slice(payload);
        raw.extend_from_slice(b"\r\n");
        raw.extend(format!("{:x}\r\n", next.len()).into_bytes());
        raw.extend_from_slice(next);
        raw.extend_from_slice(b"\r\n0\r\n\r\n");
        let split = find_header_end(&raw).unwrap();
        let inside = split + format!("{:x}\r\n", payload.len()).len() + payload.len();
        assert!(
            !response_complete(&raw[..inside], split),
            "the payload's 0\\r\\n\\r\\n is not a chunk terminator"
        );
        assert!(response_complete(&raw, split));
        assert_eq!(framed_end(&raw, split), raw.len());
        let parsed = parse_http(&raw).unwrap();
        let mut expected = payload.to_vec();
        expected.extend_from_slice(next);
        assert_eq!(parsed.body.as_bytes(), expected.as_slice());
        assert!(!parsed.body.contains("truncated"));
    }

    fn chunked_response(chunks: &[&[u8]], trailer: &[u8]) -> Vec<u8> {
        let mut raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        for chunk in chunks {
            raw.extend(format!("{:x}\r\n", chunk.len()).into_bytes());
            raw.extend_from_slice(chunk);
            raw.extend_from_slice(b"\r\n");
        }
        raw.extend_from_slice(b"0\r\n");
        raw.extend_from_slice(trailer);
        raw
    }

    #[test]
    fn chunked_message_end_accepts_optional_trailers_and_rejects_bad_ones() {
        let page = b"PAGE";
        let bare = chunked_response(&[page], b"\r\n");
        let split = find_header_end(&bare).unwrap();
        assert!(response_complete(&bare, split));
        assert_eq!(framed_end(&bare, split), bare.len());
        assert_eq!(parse_http(&bare).unwrap().body, "PAGE");

        let with_trailer = chunked_response(&[page], b"X-Trail: 1\r\n\r\n");
        let split = find_header_end(&with_trailer).unwrap();
        assert!(
            response_complete(&with_trailer, split),
            "0\\r\\nX-Trail: 1\\r\\n\\r\\n is a complete chunked message"
        );
        assert_eq!(framed_end(&with_trailer, split), with_trailer.len());
        assert_eq!(parse_http(&with_trailer).unwrap().body, "PAGE");
        assert!(!response_complete(
            &with_trailer[..with_trailer.len() - 2],
            split
        ));
        assert!(!response_complete(
            &with_trailer[..with_trailer.len() - 4],
            split
        ));

        let two = chunked_response(&[page], b"X-Trail: 1\r\nX-Other: ok\r\n\r\nNEXT");
        let split = find_header_end(&two).unwrap();
        let end = framed_end(&two, split);
        assert!(end < two.len());
        assert_eq!(&two[end..], b"NEXT");
        assert_eq!(parse_http(&two[..end]).unwrap().body, "PAGE");

        let extended = {
            let mut raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
            raw.extend_from_slice(b"4;ext=v;note=\"a b\"\r\nPAGE\r\n0;last\r\nEx: 1\r\n\r\n");
            raw
        };
        let split = find_header_end(&extended).unwrap();
        assert!(response_complete(&extended, split));
        assert_eq!(parse_http(&extended).unwrap().body, "PAGE");

        let embedded = chunked_response(&[b"BEFORE 0\r\n\r\n AFTER"], b"X-Trail: 1\r\n\r\n");
        let split = find_header_end(&embedded).unwrap();
        let size_line = format!("{:x}\r\n", b"BEFORE 0\r\n\r\n AFTER".len());
        let inside = split + size_line.len() + b"BEFORE 0\r\n\r\n AFTER".len();
        assert!(!response_complete(&embedded[..inside], split));
        assert!(response_complete(&embedded, split));
        assert_eq!(
            parse_http(&embedded).unwrap().body,
            "BEFORE 0\r\n\r\n AFTER"
        );

        let message_end = with_trailer.len();
        for prefix in 1..message_end {
            let partial = &with_trailer[..prefix];
            if let Some(at) = find_header_end(partial) {
                assert!(
                    !response_complete(partial, at),
                    "split {prefix} must stay incomplete until the blank line"
                );
            }
        }
        assert!(response_complete(&with_trailer, split));

        let bad_name = chunked_response(&[page], b"Not A Field\r\n\r\n");
        let split = find_header_end(&bad_name).unwrap();
        assert!(matches!(
            frame_status(&bad_name, split),
            FrameStatus::Invalid
        ));
        let forbidden = chunked_response(&[page], b"Content-Length: 1\r\n\r\n");
        let split = find_header_end(&forbidden).unwrap();
        assert!(matches!(
            frame_status(&forbidden, split),
            FrameStatus::Invalid
        ));
        let missing_crlf = {
            let mut raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
            raw.extend_from_slice(b"4\r\nPAGE0\r\n\r\n");
            raw
        };
        let split = find_header_end(&missing_crlf).unwrap();
        assert!(matches!(
            frame_status(&missing_crlf, split),
            FrameStatus::Invalid
        ));
    }

    #[test]
    fn chunked_keepalive_returns_before_close_and_cancel_still_closes() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            for _ in 0..2 {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut request = [0_u8; 1024];
                let count = stream.read(&mut request).unwrap_or(0);
                let text = String::from_utf8_lossy(&request[..count]);
                if text.contains("GET /trail") {
                    let body = b"PAGE";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n{:x}\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    thread::sleep(Duration::from_millis(30));
                    let _ = stream.write_all(body);
                    let _ = stream.write_all(b"\r\n0\r\n");
                    thread::sleep(Duration::from_millis(30));
                    let _ = stream.write_all(b"X-Trail: 1\r\n\r\n");
                    thread::sleep(Duration::from_secs(8));
                } else if text.contains("GET /slow") {
                    let started = Instant::now();
                    loop {
                        if started.elapsed() > Duration::from_secs(5) {
                            break;
                        }
                        if stream.write(&[]).is_err() || stream.read(&mut [0; 1]).is_err() {
                            break;
                        }
                        thread::sleep(Duration::from_millis(50));
                    }
                }
            }
        });
        let mut services = WebServices::disabled();
        services.fetch.enabled = true;
        services.fetch.allow_local = true;
        services.fetch.allowed_domains = Some(vec![format!("127.0.0.1:{port}")]);
        let started = Instant::now();
        let page = fetch_url(
            &services,
            &format!("http://127.0.0.1:{port}/trail"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "trailer fetch waited {:?}",
            started.elapsed()
        );
        assert_eq!(page.content, "PAGE");
        let flag = Arc::new(AtomicBool::new(false));
        let flag_for_cancel = Arc::clone(&flag);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            flag_for_cancel.store(true, Ordering::Relaxed);
        });
        let started = Instant::now();
        let cancelled = fetch_url(&services, &format!("http://127.0.0.1:{port}/slow"), &flag);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "cancel waited {:?}",
            started.elapsed()
        );
        assert!(cancelled.unwrap_err().to_string().contains("cancelled"));
        drop(server);
    }

    #[test]
    fn direct_http_fetch_follows_policy_and_cancel_drops_the_body() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            for _ in 0..3 {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut request = [0_u8; 1024];
                let count = stream.read(&mut request).unwrap_or(0);
                let text = String::from_utf8_lossy(&request[..count]);
                let body = if text.contains("GET /slow") {
                    let started = Instant::now();
                    loop {
                        if started.elapsed() > Duration::from_secs(5) {
                            break;
                        }
                        if stream.write(&[]).is_err() || stream.read(&mut [0; 1]).is_err() {
                            break;
                        }
                        thread::sleep(Duration::from_millis(50));
                    }
                    b"SLOW_BODY".to_vec()
                } else if text.contains("GET /secret-path") {
                    b"SECRET_PATH_BODY".to_vec()
                } else if text.contains("GET /redir") {
                    let location = format!("http://127.0.0.1:{port}/secret-path");
                    let response = format!(
                        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = stream.write_all(response.as_bytes());
                    continue;
                } else {
                    b"PAGE_BODY".to_vec()
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        let mut services = WebServices::disabled();
        services.fetch.enabled = true;
        services.fetch.allow_local = true;
        services.fetch.allowed_domains = Some(vec![
            format!("127.0.0.1:{port}/public"),
            format!("127.0.0.1:{port}/slow"),
        ]);
        let page = fetch_url(
            &services,
            &format!("http://127.0.0.1:{port}/public/page"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(page.content.contains("PAGE_BODY"));
        assert!(!page.truncated);
        let widened = fetch_url(
            &services,
            &format!("http://127.0.0.1:{port}/redir"),
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(!widened.to_string().contains("SECRET_PATH_BODY"));
        let flag = Arc::new(AtomicBool::new(false));
        let flag_for_cancel = Arc::clone(&flag);
        let slow = thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            flag_for_cancel.store(true, Ordering::Relaxed);
        });
        let cancelled = fetch_url(&services, &format!("http://127.0.0.1:{port}/slow"), &flag);
        let _ = slow.join();
        let message = cancelled.unwrap_err().to_string();
        assert!(
            message.contains("cancelled"),
            "slow fetch returned {message}"
        );
        drop(handle);
    }

    #[test]
    fn http_proxy_connects_and_does_not_fetch_directly() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let origin = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin_port = origin.local_addr().unwrap().port();
        let origin_thread = thread::spawn(move || {
            let Ok((mut stream, _)) = origin.accept() else {
                return;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut request = [0_u8; 2048];
            let count = stream.read(&mut request).unwrap_or(0);
            let text = String::from_utf8_lossy(&request[..count]);
            let body = if text.contains("GET /via-proxy") && !text.contains("CONNECT") {
                b"PROXY_PAGE".to_vec()
            } else {
                b"DIRECT_OR_TUNNEL_LEAK".to_vec()
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(&body);
        });
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_port = proxy.local_addr().unwrap().port();
        let proxy_thread = thread::spawn(move || {
            let Ok((mut client, _)) = proxy.accept() else {
                return;
            };
            let _ = client.set_read_timeout(Some(Duration::from_secs(2)));
            let mut request = [0_u8; 2048];
            let count = client.read(&mut request).unwrap_or(0);
            let text = String::from_utf8_lossy(&request[..count]).to_string();
            assert!(
                text.starts_with(&format!("CONNECT 127.0.0.1:{origin_port} ")),
                "proxy saw {text}"
            );
            let _ = client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n");
            let mut origin = TcpStream::connect(("127.0.0.1", origin_port)).unwrap();
            let _ = client.set_read_timeout(Some(Duration::from_millis(200)));
            let _ = origin.set_read_timeout(Some(Duration::from_millis(200)));
            let started = Instant::now();
            let mut from_client = [0_u8; 2048];
            let mut from_origin = [0_u8; 2048];
            while started.elapsed() < Duration::from_secs(3) {
                if let Ok(count) = client.read(&mut from_client)
                    && count > 0
                {
                    let _ = origin.write_all(&from_client[..count]);
                }
                if let Ok(count) = origin.read(&mut from_origin)
                    && count > 0
                {
                    let _ = client.write_all(&from_origin[..count]);
                }
            }
        });
        let mut services = WebServices::disabled();
        services.fetch.enabled = true;
        services.fetch.allow_local = true;
        services.fetch.allowed_domains = Some(vec![format!("127.0.0.1:{origin_port}")]);
        services.fetch.proxy_endpoint = Some(format!("http://127.0.0.1:{proxy_port}"));
        let page = fetch_url(
            &services,
            &format!("http://127.0.0.1:{origin_port}/via-proxy"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(page.content.contains("PROXY_PAGE"), "{}", page.content);
        assert!(page.via_proxy);
        let _ = origin_thread.join();
        let _ = proxy_thread.join();
    }

    #[test]
    fn direct_https_uses_native_tls_and_cancel_drops_the_body() {
        let dir = tempfile::TempDir::new().unwrap();
        let key = dir.path().join("key.pem");
        let cert = dir.path().join("cert.pem");
        let p12 = dir.path().join("server.p12");
        assert!(
            std::process::Command::new("openssl")
                .args([
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-keyout",
                    key.to_str().unwrap(),
                    "-out",
                    cert.to_str().unwrap(),
                    "-days",
                    "1",
                    "-nodes",
                    "-subj",
                    "/CN=127.0.0.1",
                    "-addext",
                    "subjectAltName=IP:127.0.0.1",
                    "-addext",
                    "extendedKeyUsage=serverAuth",
                ])
                .status()
                .unwrap()
                .success()
        );
        assert!(
            std::process::Command::new("openssl")
                .args([
                    "pkcs12",
                    "-export",
                    "-out",
                    p12.to_str().unwrap(),
                    "-inkey",
                    key.to_str().unwrap(),
                    "-in",
                    cert.to_str().unwrap(),
                    "-passout",
                    "pass:test",
                ])
                .status()
                .unwrap()
                .success()
        );
        let bytes = std::fs::read(&p12).unwrap();
        let identity = native_tls::Identity::from_pkcs12(&bytes, "test").unwrap();
        let acceptor = native_tls::TlsAcceptor::new(identity).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            for _ in 0..2 {
                let Ok((stream, _)) = listener.accept() else {
                    break;
                };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let Ok(mut tls) = acceptor.accept(stream) else {
                    break;
                };
                let mut request = [0_u8; 1024];
                let count = tls.read(&mut request).unwrap_or(0);
                let text = String::from_utf8_lossy(&request[..count]);
                if text.contains("GET /slow") {
                    thread::sleep(Duration::from_secs(3));
                }
                let body = if text.contains("GET /slow") {
                    "SLOW_BODY"
                } else {
                    "HTTPS_PAGE"
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = tls.write_all(response.as_bytes());
            }
        });
        // SAFETY: the test process is the only reader of this variable.
        unsafe { std::env::set_var("GROK_EXTRA_CA_BUNDLE", &cert) };
        let mut services = WebServices::disabled();
        services.fetch.enabled = true;
        services.fetch.allow_local = true;
        services.fetch.allowed_domains = Some(vec![format!("127.0.0.1:{port}")]);
        let page = fetch_url(
            &services,
            &format!("https://127.0.0.1:{port}/page"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(page.content.contains("HTTPS_PAGE"), "{}", page.content);
        let flag = Arc::new(AtomicBool::new(false));
        let flag_for_cancel = Arc::clone(&flag);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(200));
            flag_for_cancel.store(true, Ordering::Relaxed);
        });
        let started = Instant::now();
        let cancelled = fetch_url(&services, &format!("https://127.0.0.1:{port}/slow"), &flag);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "https cancel waited {:?}",
            started.elapsed()
        );
        assert!(cancelled.unwrap_err().to_string().contains("cancelled"));
        unsafe { std::env::remove_var("GROK_EXTRA_CA_BUNDLE") };
        let _ = server.join();
    }

    #[test]
    fn citations_are_deduped_and_truncation_is_marked() {
        let body = r#"{"output":[{"content":[{"type":"output_text","text":"found","annotations":[
            {"type":"url_citation","url":"https://docs.example/a","title":"A"},
            {"type":"url_citation","url":"https://docs.example/a","title":"A again"},
            {"type":"url_citation","url":"https://docs.example/b","title":""}
        ]}]}]}"#;
        let (content, citations) = parse_search_response(body).unwrap();
        assert_eq!(content, "found");
        assert_eq!(citations.len(), 2);
        assert_eq!(citations[0].title, "A");
        assert!(_ipv6_link_local_blocked());
    }
}
