use serde_json::{Value as JsonValue, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use toml::Value as TomlValue;

use crate::models::{ApiBackend, normalize_effort};

pub const IMPORT_MARKER: &str = "# generated-by: codsh-rust-legacy-import";
pub const IMPORT_RECORD: &str = "legacy-import.toml";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderSelection {
    All,
    Named(Vec<String>),
}

#[derive(Clone, Debug)]
pub struct ImportRequest {
    pub host_home: PathBuf,
    pub host_dsh_home: PathBuf,
    pub host_grok_home: PathBuf,
    pub isolated_home: PathBuf,
    pub isolated_dsh_home: PathBuf,
    pub grok_home: PathBuf,
    pub cwd: PathBuf,
    pub providers: ProviderSelection,
    pub include_preferences: bool,
    pub authorize_env: bool,
    pub apply: bool,
    pub env: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceOrigin {
    pub kind: String,
    pub path: PathBuf,
    pub status: String,
    pub role: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanItem {
    pub id: String,
    pub kind: String,
    pub source: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectedProvider {
    pub catalog_id: String,
    pub provider: String,
    pub model: String,
    pub name: String,
    pub api: String,
    pub backend: String,
    pub env_key: String,
    pub base_url: Option<String>,
    pub context_window: Option<u64>,
    pub reasoning_efforts: Vec<String>,
    pub reasoning_effort: Option<String>,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectedPreference {
    pub key: String,
    pub value: String,
    pub source: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImportPlan {
    pub sources: Vec<SourceOrigin>,
    pub conversions: Vec<PlanItem>,
    pub conflicts: Vec<PlanItem>,
    pub unsupported: Vec<PlanItem>,
    pub skipped_secrets: Vec<PlanItem>,
    pub skipped_trust: Vec<PlanItem>,
    pub selected: Vec<SelectedProvider>,
    pub preferences: Vec<SelectedPreference>,
    pub default_model: Option<String>,
    pub default_effort: Option<String>,
    pub default_source: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplyResult {
    pub applied: bool,
    pub written: Vec<PathBuf>,
    pub cancelled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportFlags {
    pub preview: bool,
    pub apply: bool,
    pub json: bool,
    pub help: bool,
    pub providers: ProviderSelection,
    pub include_preferences: bool,
    pub authorize_env: bool,
}

impl Default for ImportFlags {
    fn default() -> Self {
        Self {
            preview: false,
            apply: false,
            json: false,
            help: false,
            providers: ProviderSelection::All,
            include_preferences: true,
            authorize_env: false,
        }
    }
}

pub fn import_help() -> &'static str {
    "Preview and copy selected legacy dsh providers and preferences into the isolated Rust client.\n\nUsage: codsh --rust import [OPTIONS]\n\nOptions:\n      --preview               Show conversions, conflicts, and unsupported items without writing\n      --apply                 Write selected providers/preferences into the isolated Home\n      --json                  Emit machine-readable JSON\n      --providers <IDS>       Comma-separated dsh provider route ids (default: all convertible)\n      --no-preferences        Skip UI/thinking/default-model preference mapping\n      --authorize-env         Use already-exported env_key values; never copy credential files\n  -h, --help                  Print help\n\nReads current dsh `$DSH_HOME/settings.yaml` (llm-pi-ai providers, llm-deepseek, agent-default-model),\n`code-cli-thinking.json`, and `code-cli-ui.json`. Does not read outdated\n`code-cli-settings.json` as a provider source. Never copies `.credentials.yaml`,\n`.env`, `~/.grok/auth.json`, tokens, or permission/trust grants. Source files and\nexisting isolated settings stay unchanged on preview, cancel, or failure."
}

pub fn parse_flags(args: &[&str]) -> io::Result<ImportFlags> {
    let mut flags = ImportFlags {
        include_preferences: true,
        ..ImportFlags::default()
    };
    let mut index = 0;
    while index < args.len() {
        let arg = args[index];
        match arg {
            "--preview" => flags.preview = true,
            "--apply" => flags.apply = true,
            "--json" => flags.json = true,
            "--help" | "-h" => flags.help = true,
            "--no-preferences" => flags.include_preferences = false,
            "--authorize-env" => flags.authorize_env = true,
            "--providers" => {
                index += 1;
                let value = args.get(index).ok_or_else(|| {
                    io::Error::other("missing --providers value; use codsh --rust import --help")
                })?;
                flags.providers = parse_provider_list(value)?;
            }
            other if other.starts_with("--providers=") => {
                flags.providers = parse_provider_list(&other[12..])?;
            }
            other => {
                return Err(io::Error::other(format!(
                    "unsupported import option {other}; use codsh --rust import --help"
                )));
            }
        }
        index += 1;
    }
    if flags.preview && flags.apply {
        return Err(io::Error::other(
            "use only one of --preview or --apply; --preview never writes",
        ));
    }
    Ok(flags)
}

fn parse_provider_list(raw: &str) -> io::Result<ProviderSelection> {
    let ids: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    if ids.is_empty() {
        return Err(io::Error::other(
            "missing --providers value; use comma-separated dsh route ids",
        ));
    }
    Ok(ProviderSelection::Named(ids))
}

pub fn host_request_from_env(
    env: &BTreeMap<String, String>,
    isolated_home: PathBuf,
    isolated_dsh_home: PathBuf,
    grok_home: PathBuf,
    cwd: PathBuf,
) -> Result<ImportRequest, String> {
    let host_home = env
        .get("CODSH_HOST_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            "legacy import needs the host Home; launch with `codsh --rust import`".to_string()
        })?;
    let host_dsh_home = env
        .get("CODSH_HOST_DSH_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| host_home.join(".dsh"));
    let host_grok_home = env
        .get("CODSH_HOST_GROK_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| host_home.join(".grok"));
    Ok(ImportRequest {
        host_home,
        host_dsh_home,
        host_grok_home,
        isolated_home,
        isolated_dsh_home,
        grok_home,
        cwd,
        providers: ProviderSelection::All,
        include_preferences: true,
        authorize_env: false,
        apply: false,
        env: env.clone(),
    })
}

pub fn discover(request: &ImportRequest) -> ImportPlan {
    let mut plan = ImportPlan::default();
    let settings_path = request.host_dsh_home.join("settings.yaml");
    let thinking_path = request.host_dsh_home.join("code-cli-thinking.json");
    let ui_path = request.host_dsh_home.join("code-cli-ui.json");
    let outdated_path = request.host_dsh_home.join("code-cli-settings.json");
    push_source(
        &mut plan,
        "dsh.settings.yaml",
        &settings_path,
        "llm-pi-ai providers, llm-deepseek, agent-default-model",
    );
    push_source(
        &mut plan,
        "agent-default-model",
        &settings_path,
        "default provider/model/effort from current dsh settings.yaml",
    );
    push_source(
        &mut plan,
        "code-cli-thinking.json",
        &thinking_path,
        "per-model reasoning preference",
    );
    push_source(
        &mut plan,
        "code-cli-ui.json",
        &ui_path,
        "surface density preference",
    );

    if outdated_path.exists() {
        plan.unsupported.push(PlanItem {
            id: "code-cli-settings.json".into(),
            kind: "outdated-source".into(),
            source: outdated_path.display().to_string(),
            message: "outdated documentation location; not a current dsh provider or default-model source. Use settings.yaml namespaces instead.".into(),
        });
    }

    skip_secret(
        &mut plan,
        request.host_dsh_home.join(".credentials.yaml"),
        "dsh credential file",
    );
    skip_secret(
        &mut plan,
        request.host_dsh_home.join(".env"),
        "dsh home .env",
    );
    skip_secret(
        &mut plan,
        request.host_grok_home.join("auth.json"),
        "official grok token/auth file",
    );
    skip_trust(
        &mut plan,
        request.host_dsh_home.join("permissions.json"),
        "user permission grants",
    );
    skip_trust(
        &mut plan,
        request.cwd.join(".dsh").join("permissions.json"),
        "project permission grants",
    );
    skip_trust(
        &mut plan,
        request.cwd.join(".dsh").join("permissions.local.json"),
        "project-local permission grants",
    );
    skip_trust(
        &mut plan,
        request
            .host_home
            .join(".codsh-rust")
            .join(".grok")
            .join("trusted_folders.toml"),
        "isolated trust store is not seeded from legacy grants",
    );

    let thinking = load_thinking(&thinking_path, &mut plan);
    match fs::read_to_string(&settings_path) {
        Ok(text) => match parse_yaml(&text) {
            Ok(root) => fill_from_settings(&mut plan, request, &root, &settings_path, &thinking),
            Err(error) => plan.unsupported.push(PlanItem {
                id: "settings.yaml".into(),
                kind: "parse".into(),
                source: settings_path.display().to_string(),
                message: format!("current dsh settings.yaml could not be parsed: {error}"),
            }),
        },
        Err(error) if error.kind() == ErrorKind::NotFound => {
            plan.unsupported.push(PlanItem {
                id: "settings.yaml".into(),
                kind: "missing".into(),
                source: settings_path.display().to_string(),
                message: "no current dsh settings.yaml; provider mounts live at $DSH_HOME/settings.yaml, not code-cli-settings.json".into(),
            });
        }
        Err(error) => plan.unsupported.push(PlanItem {
            id: "settings.yaml".into(),
            kind: "unreadable".into(),
            source: settings_path.display().to_string(),
            message: error.to_string(),
        }),
    }

    if request.include_preferences {
        fill_ui_preferences(&mut plan, &ui_path);
    } else {
        plan.preferences.clear();
        plan.default_model = None;
        plan.default_effort = None;
        plan.default_source = None;
    }

    if let ProviderSelection::Named(ids) = &request.providers {
        plan.selected.retain(|item| {
            ids.iter()
                .any(|id| id == &item.provider || id == &item.catalog_id)
        });
        if request.include_preferences
            && let Some(default) = &plan.default_model
            && !plan
                .selected
                .iter()
                .any(|item| &item.catalog_id == default || &item.provider == default)
        {
            plan.default_model = None;
            plan.default_effort = None;
        }
    }

    detect_conflicts(&mut plan, request);
    plan
}

pub fn render_preview(plan: &ImportPlan) -> String {
    let mut lines = vec!["Legacy configuration import preview".into()];
    lines.push("Sources (current dsh locations, not outdated docs):".into());
    for source in &plan.sources {
        lines.push(format!(
            "  {:<24} {}  ({}; {})",
            source.kind,
            source.path.display(),
            source.status,
            source.role
        ));
    }
    push_section(&mut lines, "Conversions", &plan.conversions);
    push_section(&mut lines, "Conflicts", &plan.conflicts);
    push_section(&mut lines, "Unsupported", &plan.unsupported);
    push_section(&mut lines, "Secrets not copied", &plan.skipped_secrets);
    push_section(
        &mut lines,
        "Trust/permissions not granted",
        &plan.skipped_trust,
    );
    lines.push("Selected providers:".into());
    if plan.selected.is_empty() {
        lines.push("  (none)".into());
    } else {
        for item in &plan.selected {
            lines.push(format!(
                "  {}  {}/{}  api={} env_key={} source={}",
                item.catalog_id, item.provider, item.model, item.api, item.env_key, item.source
            ));
        }
    }
    if let Some(default) = &plan.default_model {
        lines.push(format!(
            "Default model: {default} effort={} ({})",
            plan.default_effort.as_deref().unwrap_or("unavailable"),
            plan.default_source.as_deref().unwrap_or("unknown")
        ));
    }
    if !plan.preferences.is_empty() {
        lines.push("Preferences:".into());
        for pref in &plan.preferences {
            lines.push(format!(
                "  {} = {}  ({})",
                pref.key, pref.value, pref.source
            ));
        }
    }
    lines.push(
        "Credentials, official tokens, and original trust/execution grants are never copied."
            .into(),
    );
    lines.push("Preview, cancel, and failed apply leave source files and existing isolated settings unchanged.".into());
    lines.join("\n")
}

pub fn render_preview_json(plan: &ImportPlan) -> String {
    let item = |entry: &PlanItem| {
        json!({
            "id": entry.id,
            "kind": entry.kind,
            "source": entry.source,
            "message": entry.message,
        })
    };
    format!(
        "{}\n",
        serde_json::to_string_pretty(&json!({
            "sources": plan.sources.iter().map(|source| json!({
                "kind": source.kind,
                "path": source.path,
                "status": source.status,
                "role": source.role,
            })).collect::<Vec<_>>(),
            "conversions": plan.conversions.iter().map(item).collect::<Vec<_>>(),
            "conflicts": plan.conflicts.iter().map(item).collect::<Vec<_>>(),
            "unsupported": plan.unsupported.iter().map(item).collect::<Vec<_>>(),
            "skippedSecrets": plan.skipped_secrets.iter().map(item).collect::<Vec<_>>(),
            "skippedTrust": plan.skipped_trust.iter().map(item).collect::<Vec<_>>(),
            "selected": plan.selected.iter().map(|item| json!({
                "catalogId": item.catalog_id,
                "provider": item.provider,
                "model": item.model,
                "name": item.name,
                "api": item.api,
                "backend": item.backend,
                "envKey": item.env_key,
                "baseUrl": item.base_url,
                "contextWindow": item.context_window,
                "reasoningEfforts": item.reasoning_efforts,
                "reasoningEffort": item.reasoning_effort,
                "source": item.source,
            })).collect::<Vec<_>>(),
            "preferences": plan.preferences.iter().map(|pref| json!({
                "key": pref.key,
                "value": pref.value,
                "source": pref.source,
            })).collect::<Vec<_>>(),
            "defaultModel": plan.default_model,
            "defaultEffort": plan.default_effort,
            "defaultSource": plan.default_source,
            "importedLegacyCredentials": false,
            "officialTokensCopied": false,
            "trustGranted": false,
        }))
        .unwrap_or_else(|_| "{}".into())
    )
}

pub fn apply(request: &ImportRequest, plan: &ImportPlan) -> io::Result<ApplyResult> {
    if !request.apply {
        return Ok(ApplyResult {
            applied: false,
            written: Vec::new(),
            cancelled: true,
        });
    }
    fs::create_dir_all(&request.grok_home)?;
    let dest = request.grok_home.join("config.toml");
    let record_path = request.grok_home.join(IMPORT_RECORD);
    let previous = fs::read_to_string(&dest).ok();
    let body = render_config(request, plan, previous.as_deref())?;
    let tmp = request.grok_home.join("config.toml.import-tmp");
    let record_tmp = request.grok_home.join("legacy-import.toml.import-tmp");
    let write_attempt = (|| {
        write_owner_file(&tmp, body.as_bytes())?;
        write_owner_file(&record_tmp, render_record(request, plan).as_bytes())?;
        fs::rename(&tmp, &dest)?;
        fs::rename(&record_tmp, &record_path)?;
        Ok::<(), io::Error>(())
    })();
    if let Err(error) = write_attempt {
        let _ = fs::remove_file(&tmp);
        let _ = fs::remove_file(&record_tmp);
        if let Some(original) = previous {
            let _ = write_owner_file(&dest, original.as_bytes());
        }
        return Err(error);
    }
    Ok(ApplyResult {
        applied: true,
        written: vec![dest, record_path],
        cancelled: false,
    })
}

fn render_config(
    request: &ImportRequest,
    plan: &ImportPlan,
    previous: Option<&str>,
) -> io::Result<String> {
    let existing = previous
        .map(|text| {
            toml::from_str::<TomlValue>(text).map_err(|error| {
                io::Error::other(format!(
                    "existing isolated config.toml is invalid; original file was not changed: {error}"
                ))
            })
        })
        .transpose()?;
    let conflicted: Vec<&str> = plan.conflicts.iter().map(|item| item.id.as_str()).collect();
    let mut model_tables: BTreeMap<String, TomlValue> = BTreeMap::new();
    let mut models_default = None;
    let mut models_effort = None;
    let mut ui: BTreeMap<String, TomlValue> = BTreeMap::new();
    let mut extras: BTreeMap<String, TomlValue> = BTreeMap::new();

    if let Some(TomlValue::Table(root)) = existing.as_ref() {
        if let Some(TomlValue::Table(models)) = root.get("models") {
            models_default = models
                .get("default")
                .and_then(TomlValue::as_str)
                .map(str::to_string);
            models_effort = models
                .get("default_reasoning_effort")
                .and_then(TomlValue::as_str)
                .map(str::to_string);
        }
        if let Some(TomlValue::Table(models)) = root.get("model") {
            for (id, spec) in models {
                model_tables.insert(id.clone(), spec.clone());
            }
        }
        if let Some(TomlValue::Table(existing_ui)) = root.get("ui") {
            for (key, value) in existing_ui {
                ui.insert(key.clone(), value.clone());
            }
        }
        for (key, value) in root {
            if !matches!(key.as_str(), "models" | "model" | "ui") {
                extras.insert(key.clone(), value.clone());
            }
        }
    }

    for item in &plan.selected {
        if conflicted.contains(&item.catalog_id.as_str()) {
            continue;
        }
        model_tables.insert(item.catalog_id.clone(), provider_table(item));
    }
    if models_default.is_none()
        && let Some(default) = &plan.default_model
        && model_tables.contains_key(default)
    {
        models_default = Some(default.clone());
        if models_effort.is_none() {
            models_effort = plan.default_effort.clone();
        }
    }
    if request.include_preferences {
        for pref in &plan.preferences {
            let key = pref.key.strip_prefix("ui.").unwrap_or(&pref.key);
            ui.insert(key.to_string(), preference_toml(&pref.value));
        }
    }

    let mut out = String::new();
    out.push_str(IMPORT_MARKER);
    out.push('\n');
    out.push_str(&format!(
        "# source: {}\n",
        request.host_dsh_home.join("settings.yaml").display()
    ));
    out.push_str("# secrets, official tokens, and trust/execution grants were not copied\n\n");
    if models_default.is_some() || models_effort.is_some() {
        out.push_str("[models]\n");
        if let Some(default) = &models_default {
            out.push_str(&format!("default = {}\n", toml_quote(default)));
        }
        if let Some(effort) = &models_effort {
            out.push_str(&format!(
                "default_reasoning_effort = {}\n",
                toml_quote(effort)
            ));
        }
        out.push('\n');
    }
    for (id, spec) in &model_tables {
        out.push_str(&format!("[model.{id}]\n"));
        out.push_str(&emit_table(spec));
        out.push('\n');
    }
    if !ui.is_empty() {
        out.push_str("[ui]\n");
        for (key, value) in &ui {
            out.push_str(&format!("{key} = {}\n", emit_value(value)));
        }
        out.push('\n');
    }
    for (key, value) in extras {
        match value {
            TomlValue::Table(table) => {
                out.push_str(&format!("[{key}]\n"));
                out.push_str(&emit_table(&TomlValue::Table(table)));
                out.push('\n');
            }
            other => {
                out.push_str(&format!("{key} = {}\n", emit_value(&other)));
            }
        }
    }
    Ok(out)
}

fn preference_toml(value: &str) -> TomlValue {
    match value {
        "true" => TomlValue::Boolean(true),
        "false" => TomlValue::Boolean(false),
        other => TomlValue::String(other.to_string()),
    }
}

fn provider_table(item: &SelectedProvider) -> TomlValue {
    let mut table = toml::map::Map::new();
    table.insert("name".into(), TomlValue::String(item.name.clone()));
    table.insert("model".into(), TomlValue::String(item.model.clone()));
    if let Some(url) = &item.base_url {
        table.insert("base_url".into(), TomlValue::String(url.clone()));
    }
    table.insert("env_key".into(), TomlValue::String(item.env_key.clone()));
    table.insert(
        "api_backend".into(),
        TomlValue::String(item.backend.clone()),
    );
    if let Some(window) = item.context_window {
        table.insert("context_window".into(), TomlValue::Integer(window as i64));
    }
    if !item.reasoning_efforts.is_empty() {
        table.insert("supports_reasoning_effort".into(), TomlValue::Boolean(true));
        table.insert(
            "reasoning_efforts".into(),
            TomlValue::Array(
                item.reasoning_efforts
                    .iter()
                    .map(|effort| TomlValue::String(effort.clone()))
                    .collect(),
            ),
        );
    }
    if let Some(effort) = &item.reasoning_effort {
        table.insert("reasoning_effort".into(), TomlValue::String(effort.clone()));
    }
    TomlValue::Table(table)
}

fn emit_table(value: &TomlValue) -> String {
    let mut out = String::new();
    let Some(table) = value.as_table() else {
        return out;
    };
    for (key, item) in table {
        out.push_str(&format!("{key} = {}\n", emit_value(item)));
    }
    out
}

fn emit_value(value: &TomlValue) -> String {
    match value {
        TomlValue::String(text) => toml_quote(text),
        TomlValue::Integer(number) => number.to_string(),
        TomlValue::Boolean(flag) => flag.to_string(),
        TomlValue::Float(number) => number.to_string(),
        TomlValue::Array(items) => {
            let body = items.iter().map(emit_value).collect::<Vec<_>>().join(", ");
            format!("[{body}]")
        }
        TomlValue::Table(_) => toml_quote(&value.to_string()),
        TomlValue::Datetime(value) => value.to_string(),
    }
}

fn render_record(request: &ImportRequest, plan: &ImportPlan) -> String {
    let mut body = format!("{IMPORT_MARKER}\n");
    body.push_str(&format!(
        "source_settings = {}\n",
        toml_quote(
            &request
                .host_dsh_home
                .join("settings.yaml")
                .display()
                .to_string()
        )
    ));
    body.push_str(&format!(
        "isolated_home = {}\n",
        toml_quote(&request.isolated_home.display().to_string())
    ));
    body.push_str(&format!(
        "isolated_dsh_home = {}\n",
        toml_quote(&request.isolated_dsh_home.display().to_string())
    ));
    body.push_str("copied_credentials = false\n");
    body.push_str("copied_official_tokens = false\n");
    body.push_str("granted_trust = false\n");
    body.push_str("selected = [");
    body.push_str(
        &plan
            .selected
            .iter()
            .filter(|item| {
                !plan
                    .conflicts
                    .iter()
                    .any(|conflict| conflict.id == item.catalog_id)
            })
            .map(|item| toml_quote(&item.catalog_id))
            .collect::<Vec<_>>()
            .join(", "),
    );
    body.push_str("]\n");
    body
}

fn write_owner_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.flush()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = file.metadata()?.permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

fn fill_from_settings(
    plan: &mut ImportPlan,
    request: &ImportRequest,
    root: &YamlValue,
    settings_path: &Path,
    thinking: &BTreeMap<String, String>,
) {
    let source = settings_path.display().to_string();
    if let Some(providers) = root
        .path(&["llm-pi-ai", "providers"])
        .and_then(YamlValue::as_map)
    {
        for (route, spec) in providers {
            convert_pi_provider(plan, request, route, spec, &source, thinking);
        }
    } else if root.path(&["llm-pi-ai"]).is_some() {
        plan.conversions.push(PlanItem {
            id: "llm-pi-ai".into(),
            kind: "empty".into(),
            source: source.clone(),
            message:
                "llm-pi-ai is present without providers; nothing to import from that namespace"
                    .into(),
        });
    }
    if let Some(deepseek) = root.get("llm-deepseek") {
        convert_deepseek(plan, request, deepseek, &source, thinking);
    }
    if let Some(default) = root.get("agent-default-model") {
        let provider = default
            .get("provider")
            .and_then(YamlValue::as_str)
            .map(str::to_string);
        let model = default
            .get("model")
            .and_then(YamlValue::as_str)
            .map(str::to_string);
        let effort = default
            .get("reasoningEffort")
            .and_then(YamlValue::as_str)
            .and_then(normalize_effort);
        if let Some(provider) = provider {
            let catalog_id = plan
                .selected
                .iter()
                .find(|item| {
                    item.provider == provider
                        && model
                            .as_deref()
                            .is_none_or(|expected| item.model == expected)
                })
                .map(|item| item.catalog_id.clone())
                .unwrap_or(provider);
            plan.default_model = Some(catalog_id);
            plan.default_effort = effort;
            plan.default_source = Some(format!("{source}:agent-default-model"));
            plan.conversions.push(PlanItem {
                id: "agent-default-model".into(),
                kind: "default".into(),
                source: format!("{source}:agent-default-model"),
                message: "default provider/model/effort taken from current dsh settings.yaml agent-default-model, not from outdated code-cli-settings.json".into(),
            });
        }
    }
    if request.include_preferences
        && let Some(runner) = root.get("coding-cli-runner")
        && let Some(map) = runner.as_map()
    {
        for key in ["bell", "notify", "bangTimeoutMs", "bangOutputLines"] {
            if map.get(key).is_some() {
                plan.unsupported.push(PlanItem {
                    id: key.into(),
                    kind: "preference".into(),
                    source: format!("{source}:coding-cli-runner"),
                    message: format!(
                        "{key} is a legacy coding-cli-runner preference; the isolated client has no equivalent control, so it is not written as a silent no-op"
                    ),
                });
            }
        }
    }
}

fn convert_pi_provider(
    plan: &mut ImportPlan,
    request: &ImportRequest,
    route: &str,
    spec: &YamlValue,
    source: &str,
    thinking: &BTreeMap<String, String>,
) {
    let origin = format!("{source}:llm-pi-ai.providers.{route}");
    let api_raw = spec.get("api").and_then(YamlValue::as_str);
    let mapped = match api_raw {
        Some(api) => match ApiBackend::from_dsh(api) {
            Ok(backend) => Some((backend, api.to_string())),
            Err(reason) => {
                plan.unsupported.push(PlanItem {
                    id: route.into(),
                    kind: "api".into(),
                    source: origin,
                    message: reason,
                });
                return;
            }
        },
        None => Some((ApiBackend::ChatCompletions, "openai-completions".into())),
    };
    let Some((backend, api)) = mapped else {
        return;
    };
    let base_url = spec
        .get("baseURL")
        .and_then(YamlValue::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty());
    if base_url.is_none() {
        plan.unsupported.push(PlanItem {
            id: route.into(),
            kind: "base_url".into(),
            source: origin,
            message: format!(
                "provider {route} has no baseURL; catalog-only routes are not silently given an official endpoint"
            ),
        });
        return;
    }
    if api_raw.is_none() {
        plan.conversions.push(PlanItem {
            id: route.into(),
            kind: "api".into(),
            source: origin.clone(),
            message: format!(
                "omitted llm-pi-ai api for {route} mapped to chat_completions / openai-completions"
            ),
        });
    } else {
        plan.conversions.push(PlanItem {
            id: route.into(),
            kind: "api".into(),
            source: origin.clone(),
            message: format!(
                "dsh api {api} maps to Grok api_backend {}",
                backend.grok_name()
            ),
        });
    }
    let env_key = spec
        .get("apiKeyEnv")
        .and_then(YamlValue::as_str)
        .unwrap_or("XAI_API_KEY")
        .to_string();
    note_credential(plan, request, route, &env_key, &origin);
    let name = spec
        .get("displayName")
        .and_then(YamlValue::as_str)
        .unwrap_or(route)
        .to_string();
    let models = collect_models(spec);
    if models.is_empty() {
        plan.unsupported.push(PlanItem {
            id: route.into(),
            kind: "models".into(),
            source: origin,
            message: format!(
                "provider {route} declares no models list; refusing to invent a catalog"
            ),
        });
        return;
    }
    if models.len() > 1 {
        plan.conversions.push(PlanItem {
            id: route.into(),
            kind: "models".into(),
            source: origin.clone(),
            message: format!(
                "provider {route} has {} models; import uses the first listed model and records extras as conversions",
                models.len()
            ),
        });
    }
    let (model_id, model_name, context, efforts, effort) = &models[0];
    let mut reasoning_effort =
        thinking_effort(thinking, route, model_id).or_else(|| effort.clone());
    if reasoning_effort.is_none() && !efforts.is_empty() {
        reasoning_effort = None;
    }
    for extra in models.iter().skip(1) {
        plan.conversions.push(PlanItem {
            id: format!("{route}/{}", extra.0),
            kind: "extra-model".into(),
            source: origin.clone(),
            message: format!(
                "extra model {} on {route} was not turned into a separate catalog entry",
                extra.0
            ),
        });
    }
    plan.selected.push(SelectedProvider {
        catalog_id: route.to_string(),
        provider: route.to_string(),
        model: model_id.clone(),
        name: if model_name.is_empty() {
            name
        } else {
            model_name.clone()
        },
        api: api.clone(),
        backend: backend.grok_name().to_string(),
        env_key,
        base_url,
        context_window: *context,
        reasoning_efforts: efforts.clone(),
        reasoning_effort,
        source: origin,
    });
}

fn convert_deepseek(
    plan: &mut ImportPlan,
    request: &ImportRequest,
    spec: &YamlValue,
    source: &str,
    thinking: &BTreeMap<String, String>,
) {
    let origin = format!("{source}:llm-deepseek");
    let env_key = spec
        .get("apiKeyEnv")
        .and_then(YamlValue::as_str)
        .unwrap_or("DEEPSEEK_API_KEY")
        .to_string();
    note_credential(plan, request, "deepseek-official", &env_key, &origin);
    let base_url = spec
        .get("baseURL")
        .and_then(YamlValue::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            plan.conversions.push(PlanItem {
                id: "deepseek-official".into(),
                kind: "base_url".into(),
                source: origin.clone(),
                message: "llm-deepseek omitted baseURL; import uses https://api.deepseek.com"
                    .into(),
            });
            Some("https://api.deepseek.com".into())
        });
    let models = collect_models(spec);
    let (model_id, model_name, context, efforts, effort) = if models.is_empty() {
        plan.conversions.push(PlanItem {
            id: "deepseek-official".into(),
            kind: "models".into(),
            source: origin.clone(),
            message: "llm-deepseek omitted models; import uses deepseek-chat as the route model id"
                .into(),
        });
        (
            "deepseek-chat".to_string(),
            "deepseek-chat".to_string(),
            None,
            Vec::new(),
            spec.get("reasoningEffort")
                .and_then(YamlValue::as_str)
                .and_then(normalize_effort),
        )
    } else {
        models.into_iter().next().unwrap()
    };
    let reasoning_effort = thinking_effort(thinking, "deepseek-official", &model_id)
        .or(effort)
        .or_else(|| {
            spec.get("reasoningEffort")
                .and_then(YamlValue::as_str)
                .and_then(normalize_effort)
        });
    plan.conversions.push(PlanItem {
        id: "deepseek-official".into(),
        kind: "api".into(),
        source: origin.clone(),
        message: "llm-deepseek maps to provider deepseek-official api openai-completions / chat_completions".into(),
    });
    plan.selected.push(SelectedProvider {
        catalog_id: "deepseek-official".into(),
        provider: "deepseek-official".into(),
        model: model_id,
        name: if model_name.is_empty() {
            "deepseek-official".into()
        } else {
            model_name
        },
        api: "openai-completions".into(),
        backend: "chat_completions".into(),
        env_key,
        base_url,
        context_window: context,
        reasoning_efforts: efforts,
        reasoning_effort,
        source: origin,
    });
}

type ImportedModel = (String, String, Option<u64>, Vec<String>, Option<String>);

fn collect_models(spec: &YamlValue) -> Vec<ImportedModel> {
    let mut out = Vec::new();
    let Some(models) = spec.get("models").and_then(YamlValue::as_seq) else {
        return out;
    };
    for model in models {
        let id = model
            .get("id")
            .and_then(YamlValue::as_str)
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let name = model
            .get("name")
            .and_then(YamlValue::as_str)
            .unwrap_or(&id)
            .to_string();
        let context = model.get("contextWindow").and_then(YamlValue::as_u64);
        let efforts = parse_efforts(model.get("reasoningEfforts"));
        let effort = model
            .get("reasoningEffort")
            .and_then(YamlValue::as_str)
            .and_then(normalize_effort);
        out.push((id, name, context, efforts, effort));
    }
    out
}

fn parse_efforts(value: Option<&YamlValue>) -> Vec<String> {
    match value {
        Some(YamlValue::Mapping(map)) => {
            map.keys().filter_map(|key| normalize_effort(key)).collect()
        }
        Some(YamlValue::Sequence(items)) => items
            .iter()
            .filter_map(YamlValue::as_str)
            .filter_map(normalize_effort)
            .collect(),
        Some(YamlValue::String(text)) => text.split(',').filter_map(normalize_effort).collect(),
        Some(YamlValue::Bool(false)) => Vec::new(),
        _ => Vec::new(),
    }
}

fn thinking_effort(
    thinking: &BTreeMap<String, String>,
    provider: &str,
    model: &str,
) -> Option<String> {
    thinking
        .get(&format!("{provider}/{model}"))
        .cloned()
        .or_else(|| thinking.get(model).cloned())
        .and_then(|value| normalize_effort(&value))
}

fn load_thinking(path: &Path, plan: &mut ImportPlan) -> BTreeMap<String, String> {
    let Ok(text) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    match serde_json::from_str::<JsonValue>(&text) {
        Ok(JsonValue::Object(map)) => {
            let mut out = BTreeMap::new();
            for (key, value) in map {
                if let Some(effort) = value.as_str().and_then(normalize_effort) {
                    out.insert(key, effort);
                }
            }
            if !out.is_empty() {
                plan.conversions.push(PlanItem {
                    id: "code-cli-thinking.json".into(),
                    kind: "preference".into(),
                    source: path.display().to_string(),
                    message: "per-model reasoning preferences taken from $DSH_HOME/code-cli-thinking.json".into(),
                });
            }
            out
        }
        Ok(_) => {
            plan.unsupported.push(PlanItem {
                id: "code-cli-thinking.json".into(),
                kind: "parse".into(),
                source: path.display().to_string(),
                message: "code-cli-thinking.json is not an object; ignored".into(),
            });
            BTreeMap::new()
        }
        Err(error) => {
            plan.unsupported.push(PlanItem {
                id: "code-cli-thinking.json".into(),
                kind: "parse".into(),
                source: path.display().to_string(),
                message: format!("code-cli-thinking.json could not be parsed: {error}"),
            });
            BTreeMap::new()
        }
    }
}

fn fill_ui_preferences(plan: &mut ImportPlan, path: &Path) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    match serde_json::from_str::<JsonValue>(&text) {
        Ok(JsonValue::Object(map)) => {
            match map.get("density").and_then(JsonValue::as_str) {
                Some("compact") => {
                    plan.preferences.push(SelectedPreference {
                        key: "ui.compact_mode".into(),
                        value: "true".into(),
                        source: path.display().to_string(),
                    });
                    plan.conversions.push(PlanItem {
                        id: "density".into(),
                        kind: "preference".into(),
                        source: path.display().to_string(),
                        message: "code-cli-ui.json density=compact maps to isolated [ui] compact_mode = true".into(),
                    });
                }
                Some("comfortable") => {
                    plan.preferences.push(SelectedPreference {
                        key: "ui.compact_mode".into(),
                        value: "false".into(),
                        source: path.display().to_string(),
                    });
                    plan.conversions.push(PlanItem {
                        id: "density".into(),
                        kind: "preference".into(),
                        source: path.display().to_string(),
                        message: "code-cli-ui.json density=comfortable maps to isolated [ui] compact_mode = false".into(),
                    });
                }
                Some(other) => plan.unsupported.push(PlanItem {
                    id: "density".into(),
                    kind: "preference".into(),
                    source: path.display().to_string(),
                    message: format!(
                        "code-cli-ui.json density {other:?} is not compact or comfortable; left unchanged"
                    ),
                }),
                None => {}
            }
        }
        Ok(_) => plan.unsupported.push(PlanItem {
            id: "code-cli-ui.json".into(),
            kind: "parse".into(),
            source: path.display().to_string(),
            message: "code-cli-ui.json is not an object; ignored".into(),
        }),
        Err(error) => plan.unsupported.push(PlanItem {
            id: "code-cli-ui.json".into(),
            kind: "parse".into(),
            source: path.display().to_string(),
            message: format!("code-cli-ui.json could not be parsed: {error}"),
        }),
    }
}

fn detect_conflicts(plan: &mut ImportPlan, request: &ImportRequest) {
    let path = request.grok_home.join("config.toml");
    let Ok(text) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(parsed) = toml::from_str::<TomlValue>(&text) else {
        plan.conflicts.push(PlanItem {
            id: "config.toml".into(),
            kind: "invalid".into(),
            source: path.display().to_string(),
            message: "existing isolated config.toml is invalid; import will refuse to overwrite it"
                .into(),
        });
        return;
    };
    for item in &plan.selected {
        if parsed
            .get("model")
            .and_then(|models| models.get(&item.catalog_id))
            .is_some()
        {
            plan.conflicts.push(PlanItem {
                id: item.catalog_id.clone(),
                kind: "existing-model".into(),
                source: path.display().to_string(),
                message: format!(
                    "isolated [model.{}] already exists; import will keep the existing table and skip this provider",
                    item.catalog_id
                ),
            });
        }
    }
}

fn note_credential(
    plan: &mut ImportPlan,
    request: &ImportRequest,
    route: &str,
    env_key: &str,
    source: &str,
) {
    let env_present = request
        .env
        .get(env_key)
        .is_some_and(|value| !value.is_empty());
    if request.authorize_env && env_present {
        plan.conversions.push(PlanItem {
            id: route.into(),
            kind: "credential".into(),
            source: source.into(),
            message: format!(
                "uses already-exported {env_key}; stored credential files are not copied"
            ),
        });
        return;
    }
    plan.conversions.push(PlanItem {
        id: route.into(),
        kind: "credential".into(),
        source: source.into(),
        message: format!(
            "provider {route} imported with env_key {env_key}; export that variable yourself. File secrets are not copied."
        ),
    });
}

fn push_source(plan: &mut ImportPlan, kind: &str, path: &Path, role: &str) {
    let status = if path.exists() { "ok" } else { "missing" };
    plan.sources.push(SourceOrigin {
        kind: kind.into(),
        path: path.to_path_buf(),
        status: status.into(),
        role: role.into(),
    });
}

fn skip_secret(plan: &mut ImportPlan, path: PathBuf, label: &str) {
    if path.exists() {
        plan.skipped_secrets.push(PlanItem {
            id: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| label.into()),
            kind: "secret".into(),
            source: path.display().to_string(),
            message: format!("{label} is not copied into the isolated Home"),
        });
    }
}

fn skip_trust(plan: &mut ImportPlan, path: PathBuf, label: &str) {
    if path.exists() {
        plan.skipped_trust.push(PlanItem {
            id: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| label.into()),
            kind: "trust".into(),
            source: path.display().to_string(),
            message: format!("{label} are not granted in the new client"),
        });
    }
}

fn push_section(lines: &mut Vec<String>, title: &str, items: &[PlanItem]) {
    lines.push(format!("{title}:"));
    if items.is_empty() {
        lines.push("  (none)".into());
        return;
    }
    for item in items {
        lines.push(format!(
            "  {}  {}  ({})",
            item.id, item.message, item.source
        ));
    }
}

fn toml_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

trait ApiBackendMap {
    fn from_dsh(api: &str) -> Result<ApiBackend, String>;
    fn grok_name(self) -> &'static str;
}

impl ApiBackendMap for ApiBackend {
    fn from_dsh(api: &str) -> Result<ApiBackend, String> {
        match api.trim() {
            "openai-completions" | "chat_completions" => Ok(ApiBackend::ChatCompletions),
            "openai-responses" | "responses" => Ok(ApiBackend::Responses),
            "anthropic-messages" | "messages" => Ok(ApiBackend::Messages),
            other => Err(format!(
                "unsupported api {other}; not treated as chat_completions"
            )),
        }
    }

    fn grok_name(self) -> &'static str {
        match self {
            ApiBackend::ChatCompletions => "chat_completions",
            ApiBackend::Responses => "responses",
            ApiBackend::Messages => "messages",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
enum YamlValue {
    Null,
    Bool(bool),
    Integer(i64),
    String(String),
    Sequence(Vec<YamlValue>),
    Mapping(BTreeMap<String, YamlValue>),
}

impl YamlValue {
    fn as_map(&self) -> Option<&BTreeMap<String, YamlValue>> {
        match self {
            YamlValue::Mapping(map) => Some(map),
            _ => None,
        }
    }

    fn as_seq(&self) -> Option<&[YamlValue]> {
        match self {
            YamlValue::Sequence(items) => Some(items),
            _ => None,
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            YamlValue::String(text) => Some(text),
            _ => None,
        }
    }

    fn as_u64(&self) -> Option<u64> {
        match self {
            YamlValue::Integer(number) if *number >= 0 => Some(*number as u64),
            YamlValue::String(text) => text.parse().ok(),
            _ => None,
        }
    }

    fn get(&self, key: &str) -> Option<&YamlValue> {
        self.as_map()?.get(key)
    }

    fn path(&self, keys: &[&str]) -> Option<&YamlValue> {
        let mut current = self;
        for key in keys {
            current = current.get(key)?;
        }
        Some(current)
    }
}

fn parse_yaml(text: &str) -> Result<YamlValue, String> {
    let mut lines = Vec::new();
    for raw in text.lines() {
        if raw.trim().is_empty() || raw.trim_start().starts_with('#') {
            continue;
        }
        let indent = raw.chars().take_while(|ch| *ch == ' ').count();
        let content = strip_comment(&raw[indent..]).trim_end().to_string();
        if content.is_empty() {
            continue;
        }
        lines.push((indent, content));
    }
    if lines.is_empty() {
        return Ok(YamlValue::Mapping(BTreeMap::new()));
    }
    let (value, index) = parse_block(&lines, 0, lines[0].0)?;
    if index != lines.len() {
        return Err(format!("unparsed YAML starting at {}", lines[index].1));
    }
    Ok(value)
}

fn parse_block(
    lines: &[(usize, String)],
    index: usize,
    indent: usize,
) -> Result<(YamlValue, usize), String> {
    if index >= lines.len() {
        return Ok((YamlValue::Null, index));
    }
    if lines[index].1.starts_with("- ") || lines[index].1 == "-" {
        parse_sequence(lines, index, indent)
    } else {
        parse_mapping(lines, index, indent)
    }
}

fn parse_mapping(
    lines: &[(usize, String)],
    mut index: usize,
    indent: usize,
) -> Result<(YamlValue, usize), String> {
    let mut map = BTreeMap::new();
    while index < lines.len() {
        let (line_indent, content) = &lines[index];
        if *line_indent < indent {
            break;
        }
        if *line_indent > indent {
            return Err(format!("unexpected indent before {content}"));
        }
        if content.starts_with("- ") || content == "-" {
            break;
        }
        let (key, rest) = split_key(content)?;
        index += 1;
        let value = if rest.is_empty() {
            if index < lines.len() && lines[index].0 > indent {
                let (nested, next) = parse_block(lines, index, lines[index].0)?;
                index = next;
                nested
            } else {
                YamlValue::Null
            }
        } else {
            parse_scalar(&rest)?
        };
        map.insert(key, value);
    }
    Ok((YamlValue::Mapping(map), index))
}

fn parse_sequence(
    lines: &[(usize, String)],
    mut index: usize,
    indent: usize,
) -> Result<(YamlValue, usize), String> {
    let mut items = Vec::new();
    while index < lines.len() {
        let (line_indent, content) = &lines[index];
        if *line_indent != indent || !(content.starts_with("- ") || content == "-") {
            break;
        }
        let rest = if content == "-" {
            ""
        } else {
            content[2..].trim()
        };
        index += 1;
        if rest.is_empty() {
            if index < lines.len() && lines[index].0 > indent {
                let (nested, next) = parse_block(lines, index, lines[index].0)?;
                index = next;
                items.push(nested);
            } else {
                items.push(YamlValue::Null);
            }
            continue;
        }
        if let Ok((key, value)) = split_key(rest) {
            let mut map = BTreeMap::new();
            map.insert(
                key,
                if value.is_empty() {
                    YamlValue::Null
                } else {
                    parse_scalar(&value)?
                },
            );
            if index < lines.len() && lines[index].0 > indent && !lines[index].1.starts_with("- ") {
                let (YamlValue::Mapping(more), next) = parse_mapping(lines, index, lines[index].0)?
                else {
                    return Err("expected mapping continuation in sequence item".into());
                };
                map.extend(more);
                index = next;
            }
            items.push(YamlValue::Mapping(map));
        } else {
            items.push(parse_scalar(rest)?);
        }
    }
    Ok((YamlValue::Sequence(items), index))
}

fn split_key(content: &str) -> Result<(String, String), String> {
    let Some(offset) = content.find(':') else {
        return Err(format!("expected key: value in {content}"));
    };
    let key = unquote(content[..offset].trim())?;
    if key.is_empty() {
        return Err("empty YAML key".into());
    }
    let rest = content[offset + 1..].trim().to_string();
    Ok((key, rest))
}

fn parse_scalar(raw: &str) -> Result<YamlValue, String> {
    if raw == "~" || raw == "null" {
        return Ok(YamlValue::Null);
    }
    if raw == "true" {
        return Ok(YamlValue::Bool(true));
    }
    if raw == "false" {
        return Ok(YamlValue::Bool(false));
    }
    if let Some(stripped) = raw.strip_prefix('"')
        && let Some(inner) = stripped.strip_suffix('"')
    {
        return Ok(YamlValue::String(
            inner.replace("\\\"", "\"").replace("\\\\", "\\"),
        ));
    }
    if let Some(stripped) = raw.strip_prefix('\'')
        && let Some(inner) = stripped.strip_suffix('\'')
    {
        return Ok(YamlValue::String(inner.to_string()));
    }
    if let Ok(number) = raw.parse::<i64>() {
        return Ok(YamlValue::Integer(number));
    }
    Ok(YamlValue::String(raw.to_string()))
}

fn unquote(raw: &str) -> Result<String, String> {
    if let Some(stripped) = raw.strip_prefix('"')
        && let Some(inner) = stripped.strip_suffix('"')
    {
        return Ok(inner.replace("\\\"", "\"").replace("\\\\", "\\"));
    }
    if let Some(stripped) = raw.strip_prefix('\'')
        && let Some(inner) = stripped.strip_suffix('\'')
    {
        return Ok(inner.to_string());
    }
    Ok(raw.to_string())
}

fn strip_comment(line: &str) -> &str {
    let mut in_single = false;
    let mut in_double = false;
    for (index, ch) in line.char_indices() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '#' if !in_single && !in_double => return &line[..index],
            _ => {}
        }
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{LoadInput, inspect_json, load_from};
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    fn hash_tree(root: &Path) -> BTreeMap<String, (u32, String)> {
        let mut map = BTreeMap::new();
        if !root.exists() {
            return map;
        }
        let mut stack = vec![root.to_path_buf()];
        while let Some(path) = stack.pop() {
            if path.is_dir() {
                for entry in fs::read_dir(&path).unwrap() {
                    stack.push(entry.unwrap().path());
                }
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let meta = fs::metadata(&path).unwrap();
            let body = fs::read(&path).unwrap();
            map.insert(
                rel,
                (
                    meta.permissions().mode(),
                    String::from_utf8_lossy(&body).into_owned(),
                ),
            );
        }
        map
    }

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    fn fixture(dir: &TempDir) -> ImportRequest {
        let host = dir.path().join("host");
        let isolated = dir.path().join("isolated").join(".codsh-rust");
        fs::create_dir_all(host.join(".dsh")).unwrap();
        fs::create_dir_all(host.join(".grok")).unwrap();
        fs::create_dir_all(isolated.join("dsh")).unwrap();
        fs::create_dir_all(isolated.join(".grok")).unwrap();
        write(
            &host.join(".dsh/settings.yaml"),
            r#"
llm-pi-ai:
  providers:
    acme-gateway:
      displayName: Acme Gateway
      apiKeyEnv: ACME_GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.acme.example/v1
      models:
        - id: acme-large
          name: Acme Large
          contextWindow: 65536
          reasoningEfforts:
            low: low
            high: high
    responses-gateway:
      displayName: Responses Gateway
      apiKeyEnv: RESPONSES_API_KEY
      api: openai-responses
      baseURL: https://responses.acme.example/v1
      models:
        - id: resp-one
    broken-gateway:
      displayName: Broken
      api: carrier-pigeon
      baseURL: https://invalid.example
      models:
        - id: pigeon
llm-deepseek:
  apiKeyEnv: DEEPSEEK_API_KEY
  baseURL: https://api.deepseek.com
  reasoningEffort: high
  models:
    - id: deepseek-chat
agent-default-model:
  provider: acme-gateway
  model: acme-large
  reasoningEffort: high
coding-cli-runner:
  bell: false
"#,
        );
        write(
            &host.join(".dsh/.credentials.yaml"),
            "version: 1\n\nrefs:\n  ACME_GATEWAY_API_KEY: legacy-secret-must-not-copy\n  DEEPSEEK_API_KEY: another-secret\n",
        );
        write(
            &host.join(".dsh/.env"),
            "ACME_GATEWAY_API_KEY=dotenv-secret\n",
        );
        write(
            &host.join(".dsh/code-cli-thinking.json"),
            r#"{"acme-gateway/acme-large":"low","orphan-model":"max"}"#,
        );
        write(
            &host.join(".dsh/code-cli-ui.json"),
            r#"{"density":"comfortable"}"#,
        );
        write(
            &host.join(".dsh/code-cli-settings.json"),
            r#"{"bell":false,"notify":true,"bangTimeoutMs":1}"#,
        );
        write(
            &host.join(".dsh/permissions.json"),
            r#"{"allow":["bash(git *)"]}"#,
        );
        write(
            &host.join(".grok/auth.json"),
            r#"{"token":"official-token-must-not-copy"}"#,
        );
        write(
            &dir.path().join("workspace/.dsh/permissions.local.json"),
            r#"{"allow":["write"]}"#,
        );
        ImportRequest {
            host_home: host.clone(),
            host_dsh_home: host.join(".dsh"),
            host_grok_home: host.join(".grok"),
            isolated_home: isolated.clone(),
            isolated_dsh_home: isolated.join("dsh"),
            grok_home: isolated.join(".grok"),
            cwd: dir.path().join("workspace"),
            providers: ProviderSelection::All,
            include_preferences: true,
            authorize_env: false,
            apply: false,
            env: BTreeMap::new(),
        }
    }

    #[test]
    fn discovers_current_dsh_sources_not_outdated_settings_json() {
        let dir = TempDir::new().unwrap();
        let request = fixture(&dir);
        let plan = discover(&request);
        let kinds: Vec<_> = plan
            .sources
            .iter()
            .map(|source| source.kind.as_str())
            .collect();
        assert!(kinds.contains(&"dsh.settings.yaml"));
        assert!(kinds.contains(&"agent-default-model"));
        assert!(kinds.contains(&"code-cli-thinking.json"));
        assert!(kinds.contains(&"code-cli-ui.json"));
        assert!(
            plan.unsupported
                .iter()
                .any(|item| item.source.contains("code-cli-settings.json")
                    && item.message.contains("outdated")),
            "{:?}",
            plan.unsupported
        );
        assert_eq!(plan.default_model.as_deref(), Some("acme-gateway"));
        let expected_default_source = format!(
            "{}:agent-default-model",
            request.host_dsh_home.join("settings.yaml").display()
        );
        assert_eq!(
            plan.default_source.as_deref(),
            Some(expected_default_source.as_str())
        );
        assert!(plan.selected.iter().any(|item| {
            item.provider == "acme-gateway"
                && item.model == "acme-large"
                && item.api == "openai-completions"
        }));
        assert!(plan.selected.iter().any(|item| {
            item.provider == "deepseek-official" && item.env_key == "DEEPSEEK_API_KEY"
        }));
        assert!(plan.unsupported.iter().any(|item| {
            item.id.contains("broken-gateway") && item.message.contains("carrier-pigeon")
        }));
    }

    #[test]
    fn preview_lists_conversions_conflicts_and_never_copies_secrets_or_trust() {
        let dir = TempDir::new().unwrap();
        let mut request = fixture(&dir);
        write(
            &request.grok_home.join("config.toml"),
            r#"
[model.acme-gateway]
model = "already-here"
base_url = "https://existing.example/v1"
env_key = "EXISTING_KEY"
"#,
        );
        let host_before = hash_tree(&request.host_home);
        let isolated_before = hash_tree(&request.isolated_home);
        let plan = discover(&request);
        let preview = render_preview(&plan);
        let json = render_preview_json(&plan);
        assert!(preview.contains("Conversions"));
        assert!(preview.contains("Conflicts"));
        assert!(preview.contains("Unsupported"));
        assert!(preview.contains("Secrets not copied"));
        assert!(preview.contains("Trust/permissions not granted"));
        assert!(plan.conflicts.iter().any(|item| item.id == "acme-gateway"));
        assert!(plan.conversions.iter().any(|item| {
            item.message.contains("openai-completions") || item.message.contains("chat_completions")
        }));
        assert!(
            plan.skipped_secrets
                .iter()
                .any(|item| item.source.contains(".credentials.yaml"))
        );
        assert!(
            plan.skipped_trust
                .iter()
                .any(|item| item.source.contains("permissions.json"))
        );
        assert!(!preview.contains("legacy-secret-must-not-copy"));
        assert!(!preview.contains("official-token-must-not-copy"));
        assert!(!preview.contains("dotenv-secret"));
        assert!(!json.contains("legacy-secret-must-not-copy"));
        assert_eq!(hash_tree(&request.host_home), host_before);
        assert_eq!(hash_tree(&request.isolated_home), isolated_before);
        request.apply = true;
        let result = apply(&request, &plan).unwrap();
        assert!(result.applied);
        assert_eq!(hash_tree(&request.host_home), host_before);
        let new_config = fs::read_to_string(request.grok_home.join("config.toml")).unwrap();
        assert!(new_config.contains("already-here"));
        assert!(new_config.contains("https://existing.example/v1"));
        assert!(!new_config.contains("legacy-secret-must-not-copy"));
    }

    #[test]
    fn cancel_failure_and_repeat_import_keep_sources_and_existing_settings() {
        let dir = TempDir::new().unwrap();
        let mut request = fixture(&dir);
        write(
            &request.grok_home.join("config.toml"),
            "[ui]\nshow_timestamps = false\n",
        );
        let host_before = hash_tree(&request.host_home);
        let isolated_before = hash_tree(&request.isolated_home);
        let plan = discover(&request);
        request.apply = false;
        let cancelled = apply(&request, &plan).unwrap();
        assert!(cancelled.cancelled);
        assert!(!cancelled.applied);
        assert_eq!(hash_tree(&request.host_home), host_before);
        assert_eq!(hash_tree(&request.isolated_home), isolated_before);

        let mut failing = request.clone();
        failing.apply = true;
        failing.grok_home = failing.isolated_home.join(".grok");
        fs::create_dir_all(&failing.grok_home).unwrap();
        let mut perms = fs::metadata(&failing.grok_home).unwrap().permissions();
        perms.set_mode(0o555);
        fs::set_permissions(&failing.grok_home, perms).unwrap();
        let failed = apply(&failing, &plan);
        let mut restore = fs::metadata(&failing.grok_home).unwrap().permissions();
        restore.set_mode(0o755);
        fs::set_permissions(&failing.grok_home, restore).unwrap();
        assert!(failed.is_err());
        assert_eq!(hash_tree(&request.host_home), host_before);
        assert_eq!(
            fs::read_to_string(request.grok_home.join("config.toml")).unwrap(),
            "[ui]\nshow_timestamps = false\n"
        );

        request.apply = true;
        request.providers = ProviderSelection::Named(vec!["acme-gateway".into()]);
        let first = apply(&request, &discover(&request)).unwrap();
        assert!(first.applied);
        let after_first = fs::read_to_string(request.grok_home.join("config.toml")).unwrap();
        let host_mid = hash_tree(&request.host_home);
        let second = apply(&request, &discover(&request)).unwrap();
        assert!(second.applied);
        assert_eq!(
            fs::read_to_string(request.grok_home.join("config.toml")).unwrap(),
            after_first
        );
        assert_eq!(hash_tree(&request.host_home), host_mid);
        assert!(after_first.contains(IMPORT_MARKER));
        assert!(after_first.contains("acme-gateway"));
        assert!(after_first.contains("https://gateway.acme.example/v1"));
        assert!(
            after_first.contains("compact_mode = false")
                || after_first.contains("compact_mode = \"false\"")
        );
        assert!(!after_first.contains("density"));
        assert!(!after_first.contains("bangTimeoutMs"));
        assert!(
            plan.unsupported
                .iter()
                .any(|item| item.id == "bell" && item.source.contains("coding-cli-runner")),
            "{:?}",
            plan.unsupported
        );
        let loaded = load_from(LoadInput {
            home: request.isolated_home.clone(),
            dsh_home: request.isolated_dsh_home.clone(),
            cwd: request.cwd.clone(),
            grok_home: Some(request.grok_home.clone()),
            env: BTreeMap::new(),
            cli_model: None,
            cli_effort: None,
            cli_trust: false,
            cli_revoke_trust: false,
            cli_trust_path: None,
            interactive: false,
        });
        assert_eq!(loaded.default_model.as_deref(), Some("acme-gateway"));
        assert!(!loaded.imported_legacy_credentials);
        let inspect = inspect_json(&loaded);
        assert!(inspect.contains("\"importedLegacyCredentials\": false"));
        assert!(!inspect.contains("legacy-secret-must-not-copy"));
    }

    #[test]
    fn authorize_env_uses_exported_keys_and_still_refuses_file_secrets() {
        let dir = TempDir::new().unwrap();
        let mut request = fixture(&dir);
        request.authorize_env = true;
        request.env.insert(
            "ACME_GATEWAY_API_KEY".into(),
            "exported-not-from-file".into(),
        );
        request.apply = true;
        let plan = discover(&request);
        apply(&request, &plan).unwrap();
        let config = fs::read_to_string(request.grok_home.join("config.toml")).unwrap();
        assert!(!config.contains("legacy-secret-must-not-copy"));
        assert!(!config.contains("exported-not-from-file"));
        assert!(
            config.contains("env_key = \"ACME_GATEWAY_API_KEY\"")
                || config.contains("env_key = 'ACME_GATEWAY_API_KEY'")
        );
        let cred = request.isolated_dsh_home.join(".credentials.yaml");
        assert!(!cred.exists());
        assert!(
            fs::read_to_string(request.host_dsh_home.join(".credentials.yaml"))
                .unwrap()
                .contains("legacy-secret-must-not-copy")
        );
    }
}
