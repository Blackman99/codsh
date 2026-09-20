use serde_json::{Value as JsonValue, json};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const GROK_EFFORTS: [&str; 4] = ["low", "medium", "high", "xhigh"];
pub const DSH_EFFORTS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
pub const SELECTION_FILE: &str = "model-selection.toml";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiBackend {
    ChatCompletions,
    Responses,
    Messages,
}

impl ApiBackend {
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.unwrap_or("chat_completions").trim() {
            "" | "chat_completions" | "openai-completions" => Ok(Self::ChatCompletions),
            "responses" | "openai-responses" => Ok(Self::Responses),
            "messages" | "anthropic-messages" => Ok(Self::Messages),
            other => Err(format!(
                "unsupported api_backend {other}; supported: chat_completions, responses, messages. Same-named models on different backends are not equivalent."
            )),
        }
    }

    pub fn dsh_api(self) -> &'static str {
        match self {
            Self::ChatCompletions => "openai-completions",
            Self::Responses => "openai-responses",
            Self::Messages => "anthropic-messages",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedSelection {
    pub model_id: String,
    pub effort: Option<String>,
}

pub fn selection_path(grok_home: &Path) -> PathBuf {
    grok_home.join(SELECTION_FILE)
}

pub fn load_saved_selection(grok_home: &Path) -> Option<SavedSelection> {
    let text = fs::read_to_string(selection_path(grok_home)).ok()?;
    let table = toml::from_str::<toml::Table>(&text).ok()?;
    let model_id = table
        .get("default")
        .and_then(toml::Value::as_str)?
        .to_string();
    if model_id.is_empty() {
        return None;
    }
    let effort = table
        .get("effort")
        .and_then(toml::Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty());
    Some(SavedSelection { model_id, effort })
}

pub fn save_selection(grok_home: &Path, model_id: &str, effort: Option<&str>) -> io::Result<()> {
    fs::create_dir_all(grok_home)?;
    let mut body = format!("default = {}\n", toml_quote(model_id));
    if let Some(effort) = effort.filter(|value| !value.is_empty()) {
        body.push_str(&format!("effort = {}\n", toml_quote(effort)));
    }
    let path = selection_path(grok_home);
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    file.write_all(body.as_bytes())?;
    file.flush()?;
    Ok(())
}

pub fn normalize_effort(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    DSH_EFFORTS
        .iter()
        .chain(GROK_EFFORTS.iter())
        .find(|value| **value == lower)
        .map(|value| (*value).to_string())
        .or(Some(lower))
}

pub fn effort_supported(efforts: &[String], requested: &str) -> bool {
    let Some(normalized) = normalize_effort(requested) else {
        return false;
    };
    efforts.iter().any(|effort| effort == &normalized)
}

pub fn acp_model_value(provider: &str, model: &str) -> String {
    json!([provider, model]).to_string()
}

pub fn parse_acp_model_value(value: &str) -> Option<(String, String)> {
    let parsed: JsonValue = serde_json::from_str(value).ok()?;
    let items = parsed.as_array()?;
    Some((
        items.first()?.as_str()?.to_string(),
        items.get(1)?.as_str()?.to_string(),
    ))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogChoice {
    pub id: String,
    pub provider: String,
    pub model: String,
    pub name: String,
    pub api: String,
    pub backend: String,
    pub acp_value: String,
    pub efforts: Vec<String>,
    pub reasoning: bool,
    pub advertised_context: Option<u64>,
    pub usable: bool,
    pub unavailable: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Routing {
    pub catalog_id: String,
    pub provider: String,
    pub model: String,
    pub backend: String,
    pub api: String,
    pub effort: Option<String>,
    pub advertised_context: Option<u64>,
    pub source: String,
}

impl Routing {
    pub fn line(&self) -> String {
        let effort = self
            .effort
            .as_deref()
            .map(|value| format!(" effort={value}"))
            .unwrap_or_else(|| " effort=unavailable".into());
        let context = self
            .advertised_context
            .map(|value| format!(" advertised_context={value}"))
            .unwrap_or_else(|| " advertised_context=unknown".into());
        format!(
            "Route: {}/{} id={} api={} backend={}{effort}{context} (no silent provider fallback)",
            self.provider, self.model, self.catalog_id, self.api, self.backend
        )
    }
}

pub fn usage_line(
    used: Option<u64>,
    size: Option<u64>,
    cost: Option<&str>,
    advertised: Option<u64>,
) -> String {
    let mut parts = Vec::new();
    match used {
        Some(value) if value > 0 => parts.push(format!("used={value}")),
        _ => parts.push("usage=unknown".into()),
    }
    match (size, advertised) {
        (_, Some(advertised)) => parts.push(format!("advertised_context={advertised} (config)")),
        (Some(size), None) if size > 0 => {
            parts.push(format!("reported_context={size} (unverified provider report; not treated as a configured limit)"));
        }
        _ => parts.push("advertised_context=unknown".into()),
    }
    match cost {
        Some(value) if !value.is_empty() => parts.push(format!("cost={value}")),
        _ => parts.push("cost=unknown".into()),
    }
    parts.join(" ")
}

pub fn menu_text(choices: &[CatalogChoice], current: Option<&str>) -> String {
    let mut lines = vec!["Model menu (configured catalog; ACP advertised options only)".into()];
    if choices.is_empty() {
        lines.push("  (none)".into());
        return lines.join("\n");
    }
    for (index, choice) in choices.iter().enumerate() {
        let mark = if current == Some(choice.id.as_str()) {
            "*"
        } else {
            " "
        };
        let state = if let Some(reason) = &choice.unavailable {
            format!("unavailable: {reason}")
        } else if choice.reasoning {
            format!("efforts={}", choice.efforts.join(","))
        } else {
            "reasoning=unavailable".into()
        };
        lines.push(format!(
            "{mark}{}. {}  {}/{}  api={}  {state}",
            index + 1,
            choice.id,
            choice.provider,
            choice.model,
            choice.api
        ));
    }
    lines.push("Type /model <id-or-name> [effort], /m, or a list number. Runtime changes apply to the next turn.".into());
    lines.join("\n")
}

pub fn effort_menu_text(choice: Option<&CatalogChoice>, current: Option<&str>) -> String {
    let Some(choice) = choice else {
        return "No active model. Use /model first.".into();
    };
    if !choice.reasoning {
        return format!(
            "Model {} ({}) does not support reasoning effort; /effort is unavailable.",
            choice.id, choice.api
        );
    }
    let current = current.unwrap_or("(provider default)");
    format!(
        "Effort menu for {} ({})\n  current={current}\n  available={}\nType /effort <level>. Runtime changes apply to the next turn.",
        choice.id,
        choice.api,
        choice.efforts.join(", ")
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Model {
        query: Option<String>,
        effort: Option<String>,
    },
    Effort {
        query: Option<String>,
    },
}

fn slash_rest<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let rest = text.strip_prefix(name)?;
    if rest.is_empty() || rest.starts_with(char::is_whitespace) {
        Some(rest)
    } else {
        None
    }
}

pub fn parse_slash(text: &str) -> Option<Command> {
    let trimmed = text.trim();
    let (name, rest) = slash_rest(trimmed, "/model")
        .map(|rest| ("model", rest))
        .or_else(|| slash_rest(trimmed, "/m").map(|rest| ("model", rest)))
        .or_else(|| slash_rest(trimmed, "/effort").map(|rest| ("effort", rest)))?;
    let mut parts = rest.split_whitespace();
    match name {
        "model" => Some(Command::Model {
            query: parts.next().map(str::to_string),
            effort: parts.next().map(str::to_string),
        }),
        _ => Some(Command::Effort {
            query: parts.next().map(str::to_string),
        }),
    }
}

pub fn resolve_model_query<'a>(
    choices: &'a [CatalogChoice],
    query: &str,
) -> Result<&'a CatalogChoice, String> {
    if let Ok(index) = query.parse::<usize>()
        && index >= 1
        && let Some(choice) = choices.get(index - 1)
    {
        return accept_choice(choice);
    }
    let needle = query.trim().to_ascii_lowercase();
    let matches: Vec<_> = choices
        .iter()
        .filter(|choice| {
            choice.id.eq_ignore_ascii_case(&needle)
                || choice.name.eq_ignore_ascii_case(&needle)
                || choice.model.eq_ignore_ascii_case(&needle)
                || format!("{}/{}", choice.provider, choice.model).eq_ignore_ascii_case(&needle)
                || choice.acp_value.eq_ignore_ascii_case(query.trim())
        })
        .collect();
    match matches.as_slice() {
        [choice] => accept_choice(choice),
        [] => Err(format!(
            "Unknown model {query}. Not in the configured catalog; no silent provider fallback."
        )),
        many => Err(format!(
            "Ambiguous model {query} matches {} catalog entries (same name is not the same backend). Use the catalog id.",
            many.len()
        )),
    }
}

fn accept_choice(choice: &CatalogChoice) -> Result<&CatalogChoice, String> {
    if let Some(reason) = &choice.unavailable {
        return Err(format!("Model {} is unavailable: {reason}", choice.id));
    }
    Ok(choice)
}

pub fn resolve_effort(choice: &CatalogChoice, requested: &str) -> Result<String, String> {
    if !choice.reasoning {
        return Err(format!(
            "Model {} does not support reasoning effort; option {requested} is unavailable.",
            choice.id
        ));
    }
    let Some(normalized) = normalize_effort(requested) else {
        return Err("missing effort value".into());
    };
    if effort_supported(&choice.efforts, &normalized) {
        Ok(normalized)
    } else {
        Err(format!(
            "Unsupported effort {requested} for {} (api={}). Available: {}.",
            choice.id,
            choice.api,
            choice.efforts.join(", ")
        ))
    }
}

fn toml_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn backends_with_the_same_model_id_are_not_equivalent() {
        let chat = ApiBackend::parse(Some("chat_completions")).unwrap();
        let messages = ApiBackend::parse(Some("messages")).unwrap();
        assert_ne!(chat.dsh_api(), messages.dsh_api());
        assert_eq!(chat.dsh_api(), "openai-completions");
        assert_eq!(messages.dsh_api(), "anthropic-messages");
        assert_eq!(
            acp_model_value("chat", "shared-name"),
            r#"["chat","shared-name"]"#
        );
        assert_ne!(
            acp_model_value("chat", "shared-name"),
            acp_model_value("messages", "shared-name")
        );
    }

    #[test]
    fn unknown_backend_is_rejected_instead_of_silently_becoming_chat_completions() {
        let error = ApiBackend::parse(Some("mystery-protocol")).unwrap_err();
        assert!(error.contains("unsupported api_backend"));
        assert!(!error.contains("openai-completions") || error.contains("supported:"));
        assert!(ApiBackend::parse(None).unwrap() == ApiBackend::ChatCompletions);
    }

    #[test]
    fn unsupported_effort_is_rejected() {
        let choice = CatalogChoice {
            id: "think".into(),
            provider: "think".into(),
            model: "shared-name".into(),
            name: "Think".into(),
            api: "openai-completions".into(),
            backend: "chat_completions".into(),
            acp_value: acp_model_value("think", "shared-name"),
            efforts: vec!["low".into(), "high".into()],
            reasoning: true,
            advertised_context: Some(128000),
            usable: true,
            unavailable: None,
        };
        assert_eq!(resolve_effort(&choice, "HIGH").unwrap(), "high");
        let error = resolve_effort(&choice, "xhigh").unwrap_err();
        assert!(error.contains("Unsupported effort"));
        let plain = CatalogChoice {
            reasoning: false,
            efforts: Vec::new(),
            ..choice.clone()
        };
        assert!(
            resolve_effort(&plain, "high")
                .unwrap_err()
                .contains("does not support")
        );
    }

    #[test]
    fn usage_line_does_not_fabricate_zero_cost_or_context() {
        let unknown = usage_line(None, None, None, None);
        assert!(unknown.contains("usage=unknown"));
        assert!(unknown.contains("advertised_context=unknown"));
        assert!(unknown.contains("cost=unknown"));
        assert!(!unknown.contains("used=0"));
        assert!(!unknown.contains("cost=0"));
        let configured = usage_line(Some(12), Some(999999), None, Some(128000));
        assert!(configured.contains("used=12"));
        assert!(configured.contains("advertised_context=128000 (config)"));
        assert!(!configured.contains("999999"));
    }

    #[test]
    fn slash_parser_and_saved_selection_round_trip() {
        assert_eq!(
            parse_slash("/model think high"),
            Some(Command::Model {
                query: Some("think".into()),
                effort: Some("high".into()),
            })
        );
        assert_eq!(
            parse_slash("/m"),
            Some(Command::Model {
                query: None,
                effort: None,
            })
        );
        assert_eq!(
            parse_slash("/effort low"),
            Some(Command::Effort {
                query: Some("low".into()),
            })
        );
        assert!(parse_slash("hello").is_none());
        let dir = TempDir::new().unwrap();
        save_selection(dir.path(), "think", Some("high")).unwrap();
        let saved = load_saved_selection(dir.path()).unwrap();
        assert_eq!(saved.model_id, "think");
        assert_eq!(saved.effort.as_deref(), Some("high"));
    }
}
