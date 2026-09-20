use serde_json::{Value as JsonValue, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use toml::Value as TomlValue;

pub const GENERATED_MARKER: &str = "# generated-by: codsh-rust-config";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Setting {
    pub key: String,
    pub value: String,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileLayer {
    pub path: PathBuf,
    pub role: String,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelSpec {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub model: String,
    pub base_url: Option<String>,
    pub env_key: String,
    pub api_key_set: bool,
    api_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigError {
    pub path: Option<PathBuf>,
    pub reason: String,
}

#[derive(Clone, Debug)]
pub struct EffectiveConfig {
    #[allow(dead_code)]
    pub grok_home: PathBuf,
    pub config_path: PathBuf,
    pub dsh_home: PathBuf,
    pub files: Vec<FileLayer>,
    pub settings: Vec<Setting>,
    pub default_model: Option<String>,
    pub models: BTreeMap<String, ModelSpec>,
    pub telemetry: bool,
    pub feedback: bool,
    pub trace_upload: bool,
    pub ready: bool,
    pub missing_credential: Option<String>,
    pub errors: Vec<ConfigError>,
    pub warnings: Vec<String>,
    pub imported_legacy_credentials: bool,
    pub official_login_disabled: bool,
    pub settings_yaml: PathBuf,
}

#[derive(Clone, Debug, Default)]
pub struct LoadInput {
    pub home: PathBuf,
    pub dsh_home: PathBuf,
    #[allow(dead_code)]
    pub cwd: PathBuf,
    pub grok_home: Option<PathBuf>,
    pub env: BTreeMap<String, String>,
    pub cli_model: Option<String>,
}

impl EffectiveConfig {
    pub fn active_model(&self) -> Option<&ModelSpec> {
        let id = self.default_model.as_ref()?;
        self.models.get(id)
    }

    pub fn first_run_message(&self) -> String {
        if let Some(error) = self.errors.first() {
            let location = error
                .path
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "config".into());
            return format!(
                "Invalid configuration: {location}: {}\nOriginal file was not changed.",
                error.reason
            );
        }
        if let Some(missing) = &self.missing_credential {
            return missing.clone();
        }
        if !self.ready {
            return "First-run: no usable provider. Official grok.com login/telemetry unused.\nWrite ~/.codsh-rust/.grok/config.toml ([model.<id>] base_url, env_key). Export the key. inspect shows origins.".into();
        }
        String::new()
    }
}

pub fn grok_home_from(home: &Path, env_home: Option<&str>) -> PathBuf {
    match env_home {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => home.join(".grok"),
    }
}

pub fn load() -> EffectiveConfig {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let dsh_home =
        PathBuf::from(std::env::var_os("DSH_HOME").unwrap_or_else(|| home.join("dsh").into()));
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut env = BTreeMap::new();
    for (key, value) in std::env::vars() {
        env.insert(key, value);
    }
    load_from(LoadInput {
        grok_home: env
            .get("GROK_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from),
        home,
        dsh_home,
        cwd,
        env,
        cli_model: None,
    })
}

pub fn load_from(mut input: LoadInput) -> EffectiveConfig {
    if let Some(model) = input.cli_model.clone() {
        input.env.insert("CODSH_CLI_MODEL".into(), model);
    }
    let grok_home = grok_home_from(&input.home, input.env.get("GROK_HOME").map(String::as_str));
    let grok_home = input.grok_home.clone().unwrap_or(grok_home);
    let config_path = grok_home.join("config.toml");
    let settings_yaml = input.dsh_home.join("settings.yaml");
    let mut files = Vec::new();
    let mut settings = Vec::new();
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut models = BTreeMap::new();
    let mut default_model = None;
    let mut sources: BTreeMap<String, String> = BTreeMap::new();

    let grok_home_source = if input
        .env
        .get("GROK_HOME")
        .is_some_and(|value| !value.is_empty())
    {
        "environment"
    } else {
        "default"
    };
    settings.push(Setting {
        key: "GROK_HOME".into(),
        value: grok_home.display().to_string(),
        source: grok_home_source.into(),
    });

    let mut table = TomlValue::Table(toml::map::Map::new());
    match fs::read(&config_path) {
        Ok(bytes) => match toml::from_str::<TomlValue>(&String::from_utf8_lossy(&bytes)) {
            Ok(parsed) => {
                files.push(FileLayer {
                    path: config_path.clone(),
                    role: "config.toml".into(),
                    status: "ok".into(),
                });
                table = parsed;
            }
            Err(error) => {
                files.push(FileLayer {
                    path: config_path.clone(),
                    role: "config.toml".into(),
                    status: "invalid".into(),
                });
                errors.push(ConfigError {
                    path: Some(config_path.clone()),
                    reason: error.to_string(),
                });
            }
        },
        Err(error) if error.kind() == ErrorKind::NotFound => {
            files.push(FileLayer {
                path: config_path.clone(),
                role: "config.toml".into(),
                status: "missing".into(),
            });
        }
        Err(error) => {
            errors.push(ConfigError {
                path: Some(config_path.clone()),
                reason: error.to_string(),
            });
        }
    }

    stamp_model_sources(&table, &mut sources, "config.toml");
    if let Some(overlay) = overlay_table(&input.env, &mut warnings) {
        merge_toml(&mut table, &overlay);
        files.push(FileLayer {
            path: PathBuf::from("GROK_CONFIG"),
            role: "overlay".into(),
            status: "ok".into(),
        });
        stamp_model_sources(&overlay, &mut sources, "overlay");
    }

    if let Some(model_table) = table.get("model").and_then(TomlValue::as_table) {
        for (id, spec) in model_table {
            if let Some(model) = parse_model(id, spec) {
                models.insert(id.clone(), model);
            } else {
                errors.push(ConfigError {
                    path: Some(config_path.clone()),
                    reason: format!("invalid [model.{id}] table"),
                });
            }
        }
    }
    if let Some(value) = table
        .get("models")
        .and_then(|models| models.get("default"))
        .and_then(TomlValue::as_str)
    {
        default_model = Some(value.to_string());
        sources
            .entry("models.default".into())
            .or_insert_with(|| "config.toml".into());
    } else if models.len() == 1 {
        default_model = models.keys().next().cloned();
        sources
            .entry("models.default".into())
            .or_insert_with(|| "default".into());
    }

    let mut telemetry = bool_from_toml(
        table
            .get("features")
            .and_then(|features| features.get("telemetry")),
    )
    .unwrap_or(false);
    sources
        .entry("features.telemetry".into())
        .or_insert_with(|| "default".into());
    let mut feedback = bool_from_toml(
        table
            .get("features")
            .and_then(|features| features.get("feedback")),
    )
    .unwrap_or(false);
    sources
        .entry("features.feedback".into())
        .or_insert_with(|| "default".into());
    let mut trace_upload = bool_from_toml(
        table
            .get("telemetry")
            .and_then(|telemetry| telemetry.get("trace_upload"))
            .or_else(|| {
                table
                    .get("features")
                    .and_then(|features| features.get("trace_upload"))
            }),
    )
    .unwrap_or(false);
    sources
        .entry("features.trace_upload".into())
        .or_insert_with(|| "default".into());

    if let Some(value) = env_bool(input.env.get("GROK_TELEMETRY_ENABLED")) {
        telemetry = value;
        sources.insert("features.telemetry".into(), "environment".into());
    }
    if let Some(value) = env_bool(input.env.get("GROK_FEEDBACK_ENABLED")) {
        feedback = value;
        sources.insert("features.feedback".into(), "environment".into());
    }
    if let Some(value) = env_bool(
        input
            .env
            .get("GROK_TRACE_UPLOAD")
            .or_else(|| input.env.get("GROK_TELEMETRY_TRACE_UPLOAD")),
    ) {
        trace_upload = value;
        sources.insert("features.trace_upload".into(), "environment".into());
    }

    if let Some(cli) = input
        .cli_model
        .clone()
        .or_else(|| input.env.get("CODSH_CLI_MODEL").cloned())
    {
        default_model = Some(cli);
        sources.insert("models.default".into(), "cli".into());
    }

    for model in models.values_mut() {
        if input.env.contains_key(&model.env_key) && !input.env[&model.env_key].is_empty() {
            sources.insert(
                format!("model.{}.env_key", model.id),
                sources
                    .get(&format!("model.{}.env_key", model.id))
                    .cloned()
                    .unwrap_or_else(|| "config.toml".into()),
            );
        }
        if model.api_key_set {
            sources
                .entry(format!("model.{}.api_key", model.id))
                .or_insert_with(|| "config.toml".into());
        }
    }

    if default_model.is_none() {
        sources
            .entry("models.default".into())
            .or_insert_with(|| "default".into());
    }
    push_setting(
        &mut settings,
        "models.default",
        default_model.as_deref().unwrap_or("(unset)"),
        sources
            .get("models.default")
            .map(String::as_str)
            .unwrap_or("default"),
    );
    for model in models.values() {
        let prefix = format!("model.{}", model.id);
        push_setting(
            &mut settings,
            &format!("{prefix}.name"),
            &model.name,
            sources
                .get(&format!("{prefix}.name"))
                .map(String::as_str)
                .unwrap_or("config.toml"),
        );
        push_setting(
            &mut settings,
            &format!("{prefix}.model"),
            &model.model,
            sources
                .get(&format!("{prefix}.model"))
                .map(String::as_str)
                .unwrap_or("config.toml"),
        );
        push_setting(
            &mut settings,
            &format!("{prefix}.base_url"),
            model.base_url.as_deref().unwrap_or("(unset)"),
            sources
                .get(&format!("{prefix}.base_url"))
                .map(String::as_str)
                .unwrap_or("config.toml"),
        );
        push_setting(
            &mut settings,
            &format!("{prefix}.env_key"),
            &model.env_key,
            sources
                .get(&format!("{prefix}.env_key"))
                .map(String::as_str)
                .unwrap_or("config.toml"),
        );
        push_setting(
            &mut settings,
            &format!("{prefix}.api_key"),
            if model.api_key_set {
                "(set)"
            } else {
                "(unset)"
            },
            sources
                .get(&format!("{prefix}.api_key"))
                .map(String::as_str)
                .unwrap_or("default"),
        );
        let env_present = input
            .env
            .get(&model.env_key)
            .is_some_and(|value| !value.is_empty());
        push_setting(
            &mut settings,
            &model.env_key,
            if env_present { "(set)" } else { "(unset)" },
            if env_present {
                "environment"
            } else {
                "default"
            },
        );
    }
    let (telemetry_value, telemetry_source) = applied_privacy(
        telemetry,
        sources
            .get("features.telemetry")
            .map(String::as_str)
            .unwrap_or("default"),
    );
    let (feedback_value, feedback_source) = applied_privacy(
        feedback,
        sources
            .get("features.feedback")
            .map(String::as_str)
            .unwrap_or("default"),
    );
    let (trace_value, trace_source) = applied_privacy(
        trace_upload,
        sources
            .get("features.trace_upload")
            .map(String::as_str)
            .unwrap_or("default"),
    );
    telemetry = telemetry_value == "true";
    feedback = feedback_value == "true";
    trace_upload = trace_value == "true";
    push_setting(
        &mut settings,
        "features.telemetry",
        telemetry_value,
        telemetry_source,
    );
    push_setting(
        &mut settings,
        "features.feedback",
        feedback_value,
        feedback_source,
    );
    push_setting(
        &mut settings,
        "features.trace_upload",
        trace_value,
        trace_source,
    );

    let mut missing_credential = None;
    let mut ready = false;
    if errors.is_empty()
        && let Some(id) = &default_model
        && let Some(model) = models.get(id)
        && model.base_url.as_ref().is_some_and(|url| !url.is_empty())
    {
        let env_present = input
            .env
            .get(&model.env_key)
            .is_some_and(|value| !value.is_empty());
        if env_present || model.api_key_set {
            ready = true;
        } else {
            missing_credential = Some(format!(
                "Missing credential for model {}: set {}, then restart or press Enter to reload.\nNo hidden default key is used.",
                model.id, model.env_key
            ));
        }
    }

    push_setting(
        &mut settings,
        "dsh.settings.yaml",
        &settings_yaml.display().to_string(),
        if ready {
            "generated-from-config.toml"
        } else {
            "unwritten"
        },
    );
    push_setting(
        &mut settings,
        "legacy.credentials.imported",
        "false",
        "isolated-home",
    );
    push_setting(&mut settings, "official.login", "disabled", "default");

    EffectiveConfig {
        grok_home,
        config_path,
        dsh_home: input.dsh_home,
        files,
        settings,
        default_model,
        models,
        telemetry,
        feedback,
        trace_upload,
        ready,
        missing_credential,
        errors,
        warnings,
        imported_legacy_credentials: false,
        official_login_disabled: true,
        settings_yaml,
    }
}

pub fn inspect_text(config: &EffectiveConfig) -> String {
    let mut lines = vec!["Effective configuration".into()];
    for file in &config.files {
        lines.push(format!(
            "  {:<28} {}  ({})",
            file.role,
            file.path.display(),
            file.status
        ));
    }
    for setting in &config.settings {
        lines.push(format!(
            "  {:<28} {}  ({})",
            setting.key, setting.value, setting.source
        ));
    }
    if !config.warnings.is_empty() {
        lines.push("Warnings:".into());
        lines.extend(config.warnings.iter().map(|warning| format!("  {warning}")));
    }
    if !config.errors.is_empty() || !config.ready {
        lines.push(config.first_run_message());
    }
    lines.join("\n")
}

pub fn inspect_json(config: &EffectiveConfig) -> String {
    let files: Vec<JsonValue> = config
        .files
        .iter()
        .map(|file| {
            json!({
                "path": file.path,
                "role": file.role,
                "status": file.status,
            })
        })
        .collect();
    let settings: Vec<JsonValue> = config
        .settings
        .iter()
        .map(|setting| {
            json!({
                "key": setting.key,
                "value": setting.value,
                "source": setting.source,
            })
        })
        .collect();
    format!(
        "{}\n",
        serde_json::to_string_pretty(&json!({
            "files": files,
            "settings": settings,
            "ready": config.ready,
            "missingCredential": config.missing_credential,
            "errors": config.errors.iter().map(|error| json!({
                "path": error.path,
                "reason": error.reason,
            })).collect::<Vec<_>>(),
            "warnings": config.warnings,
            "importedLegacyCredentials": config.imported_legacy_credentials,
            "officialLoginDisabled": config.official_login_disabled,
            "telemetry": config.telemetry,
            "feedback": config.feedback,
            "traceUpload": config.trace_upload,
        }))
        .unwrap_or_else(|_| "{}".into())
    )
}

pub fn is_test_execution_seam() -> bool {
    if std::env::var_os("FAKE_ACP_MODE").is_some()
        || std::env::var_os("DSH_CODE_CLI_MOCK_TOOL").is_some()
    {
        return true;
    }
    std::env::var_os("CODSH_ACP_PATCH")
        .and_then(|path| fs::read_to_string(path).ok())
        .is_some_and(|text| text.contains("cli-mock") || text.contains("rust-acp-mock-llm"))
}

pub fn apply_to_dsh(
    config: &EffectiveConfig,
    env: &BTreeMap<String, String>,
) -> io::Result<Option<PathBuf>> {
    if !config.errors.is_empty() || !config.ready {
        return Ok(None);
    }
    let Some(model) = config.active_model() else {
        return Ok(None);
    };
    let yaml = generated_settings_yaml(config, model);
    match fs::read_to_string(&config.settings_yaml) {
        Ok(existing)
            if !existing.trim_start().starts_with(GENERATED_MARKER)
                && existing.trim() != yaml.trim() =>
        {
            return Err(io::Error::other(format!(
                "dsh settings.yaml exists and is not generated from config.toml; refusing to overwrite {}. Use inspect.",
                config.settings_yaml.display()
            )));
        }
        Ok(existing) if existing == yaml => {}
        _ => {
            if let Some(parent) = config.settings_yaml.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&config.settings_yaml, yaml)?;
        }
    }
    if !env
        .get(&model.env_key)
        .is_some_and(|value| !value.is_empty())
        && let Some(key) = model.api_key.as_deref()
    {
        write_isolated_credential(
            &config.dsh_home.join(".credentials.yaml"),
            &model.env_key,
            key,
        )?;
    }
    if is_test_execution_seam() {
        return Ok(None);
    }
    let patch_path = config.dsh_home.join("rust-effective.yml");
    let existing = std::env::var_os("CODSH_ACP_PATCH")
        .and_then(|path| fs::read_to_string(path).ok())
        .unwrap_or_default();
    let combined = format!(
        "- id: acp\n  config:\n    provider: {}\n    model: {}\n- id: agent-default-model\n  config:\n    provider: {}\n    model: {}\n- id: llm-deepseek\n  disabled: true\n{existing}",
        yaml_plain(&model.provider),
        yaml_plain(&model.model),
        yaml_plain(&model.provider),
        yaml_plain(&model.model),
    );
    fs::write(&patch_path, combined)?;
    Ok(Some(patch_path))
}

pub fn credential_env(
    config: &EffectiveConfig,
    env: &BTreeMap<String, String>,
) -> Vec<(String, String)> {
    let mut extra = Vec::new();
    if let Some(model) = config.active_model() {
        if let Some(value) = env.get(&model.env_key).filter(|value| !value.is_empty()) {
            extra.push((model.env_key.clone(), value.clone()));
        } else if let Some(key) = &model.api_key {
            extra.push((model.env_key.clone(), key.clone()));
        }
    }
    extra
}

fn generated_settings_yaml(config: &EffectiveConfig, model: &ModelSpec) -> String {
    let display = if model.name.is_empty() {
        model.id.clone()
    } else {
        model.name.clone()
    };
    let base_url = model.base_url.clone().unwrap_or_default();
    format!(
        "{GENERATED_MARKER}\n# source: {}\nllm-pi-ai:\n  providers:\n    {}:\n      displayName: {}\n      apiKeyEnv: {}\n      api: openai-completions\n      baseURL: {}\n      models:\n        - id: {}\nagent-default-model:\n  provider: {}\n  model: {}\n",
        config.config_path.display(),
        yaml_plain(&model.provider),
        yaml_quote(&display),
        yaml_plain(&model.env_key),
        yaml_quote(&base_url),
        yaml_plain(&model.model),
        yaml_plain(&model.provider),
        yaml_plain(&model.model),
    )
}

fn write_isolated_credential(path: &Path, env_key: &str, value: &str) -> io::Result<()> {
    let mut refs = BTreeMap::new();
    if let Ok(existing) = fs::read_to_string(path) {
        if !existing.trim_start().starts_with("version:") && !existing.trim().is_empty() {
            return Err(io::Error::other(format!(
                "refusing to overwrite unmanaged credentials file {}",
                path.display()
            )));
        }
        if let Some(block) = existing.split("refs:\n").nth(1) {
            for line in block.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with("records:") {
                    break;
                }
                if let Some((key, val)) = line.split_once(':') {
                    refs.insert(key.trim().to_string(), val.trim().to_string());
                }
            }
        }
    }
    refs.insert(env_key.to_string(), yaml_quote(value));
    let mut body = String::from("version: 1\n\nrefs:\n");
    for (key, val) in refs {
        body.push_str(&format!("  {key}: {val}\n"));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(body.as_bytes())?;
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

fn overlay_table(env: &BTreeMap<String, String>, warnings: &mut Vec<String>) -> Option<TomlValue> {
    if let Some(raw) = env
        .get("GROK_CONFIG")
        .filter(|value| !value.trim().is_empty())
    {
        match serde_json::from_str::<JsonValue>(raw) {
            Ok(json) => return json_to_toml(&json),
            Err(error) => warnings.push(format!("malformed GROK_CONFIG ignored: {error}")),
        }
    }
    if let Some(path) = env
        .get("GROK_CONFIG_PATH")
        .filter(|value| !value.is_empty())
    {
        match fs::read_to_string(path) {
            Ok(text) if path.rsplit('.').next() == Some("json") => match serde_json::from_str::<
                JsonValue,
            >(&text)
            {
                Ok(json) => return json_to_toml(&json),
                Err(error) => warnings.push(format!("malformed GROK_CONFIG_PATH ignored: {error}")),
            },
            Ok(text) => match toml::from_str::<TomlValue>(&text) {
                Ok(parsed) => return Some(parsed),
                Err(error) => warnings.push(format!("malformed GROK_CONFIG_PATH ignored: {error}")),
            },
            Err(error) => warnings.push(format!("GROK_CONFIG_PATH unread: {error}")),
        }
    }
    None
}

fn json_to_toml(value: &JsonValue) -> Option<TomlValue> {
    toml::from_str(&toml::to_string(&json_to_toml_value(value)?).ok()?).ok()
}

fn json_to_toml_value(value: &JsonValue) -> Option<TomlValue> {
    Some(match value {
        JsonValue::Null => return None,
        JsonValue::Bool(flag) => TomlValue::Boolean(*flag),
        JsonValue::Number(number) => {
            if let Some(int) = number.as_i64() {
                TomlValue::Integer(int)
            } else {
                TomlValue::Float(number.as_f64()?)
            }
        }
        JsonValue::String(text) => TomlValue::String(text.clone()),
        JsonValue::Array(items) => {
            TomlValue::Array(items.iter().filter_map(json_to_toml_value).collect())
        }
        JsonValue::Object(map) => {
            let mut table = toml::map::Map::new();
            for (key, item) in map {
                if let Some(converted) = json_to_toml_value(item) {
                    table.insert(key.clone(), converted);
                }
            }
            TomlValue::Table(table)
        }
    })
}

fn merge_toml(base: &mut TomlValue, overlay: &TomlValue) {
    match (base, overlay) {
        (TomlValue::Table(left), TomlValue::Table(right)) => {
            for (key, value) in right {
                match left.get_mut(key) {
                    Some(existing) => merge_toml(existing, value),
                    None => {
                        left.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (left, right) => *left = right.clone(),
    }
}

fn stamp_model_sources(table: &TomlValue, sources: &mut BTreeMap<String, String>, source: &str) {
    if let Some(value) = table
        .get("models")
        .and_then(|models| models.get("default"))
        .and_then(TomlValue::as_str)
    {
        let _ = value;
        sources.insert("models.default".into(), source.into());
    }
    if let Some(models) = table.get("model").and_then(TomlValue::as_table) {
        for (id, spec) in models {
            if let Some(spec) = spec.as_table() {
                for field in ["name", "model", "base_url", "env_key", "api_key"] {
                    if spec.contains_key(field) {
                        sources.insert(format!("model.{id}.{field}"), source.into());
                    }
                }
            }
        }
    }
    if table
        .get("features")
        .and_then(|features| features.get("telemetry"))
        .is_some()
    {
        sources.insert("features.telemetry".into(), source.into());
    }
    if table
        .get("features")
        .and_then(|features| features.get("feedback"))
        .is_some()
    {
        sources.insert("features.feedback".into(), source.into());
    }
    if table
        .get("features")
        .and_then(|features| features.get("trace_upload"))
        .is_some()
        || table
            .get("telemetry")
            .and_then(|telemetry| telemetry.get("trace_upload"))
            .is_some()
    {
        sources.insert("features.trace_upload".into(), source.into());
    }
}

fn parse_model(id: &str, spec: &TomlValue) -> Option<ModelSpec> {
    let table = spec.as_table()?;
    let model = table
        .get("model")
        .and_then(TomlValue::as_str)
        .unwrap_or(id)
        .to_string();
    let name = table
        .get("name")
        .and_then(TomlValue::as_str)
        .unwrap_or(id)
        .to_string();
    let base_url = table
        .get("base_url")
        .and_then(TomlValue::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty());
    let env_key = table
        .get("env_key")
        .and_then(TomlValue::as_str)
        .unwrap_or("XAI_API_KEY")
        .to_string();
    let api_key = table
        .get("api_key")
        .and_then(TomlValue::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty());
    Some(ModelSpec {
        provider: provider_id(id),
        id: id.to_string(),
        name,
        model,
        base_url,
        env_key,
        api_key_set: api_key.is_some(),
        api_key,
    })
}

fn provider_id(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = mapped.trim_matches('-');
    if trimmed.is_empty() {
        "provider".into()
    } else {
        trimmed.to_string()
    }
}

fn bool_from_toml(value: Option<&TomlValue>) -> Option<bool> {
    match value? {
        TomlValue::Boolean(flag) => Some(*flag),
        TomlValue::String(text) => env_bool(Some(text)),
        _ => None,
    }
}

fn env_bool(value: Option<&String>) -> Option<bool> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" | "enabled" => Some(true),
        "0" | "false" | "no" | "off" | "disabled" => Some(false),
        _ => None,
    }
}

fn applied_privacy(requested: bool, source: &str) -> (&'static str, &str) {
    if requested {
        ("false", "applied")
    } else {
        ("false", source)
    }
}

fn push_setting(settings: &mut Vec<Setting>, key: &str, value: &str, source: &str) {
    settings.push(Setting {
        key: key.into(),
        value: value.into(),
        source: source.into(),
    });
}

fn yaml_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    )
}

fn yaml_plain(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' || ch == '/')
        && !value.is_empty()
    {
        value.to_string()
    } else {
        yaml_quote(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn input(dir: &TempDir) -> LoadInput {
        let home = dir.path().join(".codsh-rust");
        fs::create_dir_all(home.join("dsh")).unwrap();
        LoadInput {
            dsh_home: home.join("dsh"),
            cwd: dir.path().to_path_buf(),
            grok_home: Some(home.join(".grok")),
            home,
            env: BTreeMap::new(),
            cli_model: None,
        }
    }

    fn write_config(input: &LoadInput, body: &str) {
        fs::create_dir_all(input.grok_home.clone().unwrap()).unwrap();
        fs::write(input.grok_home.clone().unwrap().join("config.toml"), body).unwrap();
    }

    #[test]
    fn inspects_defaults_without_importing_legacy_credentials() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        fs::create_dir_all(dir.path().join(".grok")).unwrap();
        fs::create_dir_all(dir.path().join(".dsh")).unwrap();
        fs::write(dir.path().join(".grok/auth.json"), "secret-must-not-import").unwrap();
        fs::write(dir.path().join(".dsh/.credentials.yaml"), "legacy: key").unwrap();
        load.home = dir.path().to_path_buf();
        load.grok_home = Some(dir.path().join(".codsh-rust/.grok"));
        let config = load_from(load);
        assert!(!config.ready);
        assert!(!config.imported_legacy_credentials);
        assert!(config.official_login_disabled);
        assert!(!config.telemetry);
        assert_eq!(
            config
                .settings
                .iter()
                .find(|setting| setting.key == "features.telemetry")
                .map(|setting| setting.value.as_str()),
            Some("false")
        );
        let inspect = inspect_json(&config);
        assert!(inspect.contains("\"importedLegacyCredentials\": false"));
        assert!(!inspect.contains("secret-must-not-import"));
    }

    #[test]
    fn invalid_toml_preserves_original_and_reports_path() {
        let dir = TempDir::new().unwrap();
        let load = input(&dir);
        let original = "this is : not = toml [[[";
        write_config(&load, original);
        let path = load.grok_home.clone().unwrap().join("config.toml");
        let config = load_from(load);
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert_eq!(config.errors[0].path.as_ref(), Some(&path));
        assert!(!config.errors[0].reason.is_empty());
        assert!(inspect_text(&config).contains(&path.display().to_string()));
        assert!(
            config
                .first_run_message()
                .contains("Original file was not changed")
        );
    }

    #[test]
    fn cli_overrides_env_overrides_overlay_overrides_file() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        write_config(
            &load,
            r#"
[models]
default = "file-model"

[model.file-model]
model = "file"
base_url = "http://file.example/v1"
env_key = "FILE_API_KEY"

[model.overlay-model]
model = "overlay"
base_url = "http://overlay.example/v1"
env_key = "OVERLAY_API_KEY"

[model.env-model]
model = "env"
base_url = "http://env.example/v1"
env_key = "ENV_API_KEY"

[model.cli-model]
model = "cli"
base_url = "http://cli.example/v1"
env_key = "CLI_API_KEY"
"#,
        );
        load.env.insert(
            "GROK_CONFIG".into(),
            r#"{"models":{"default":"overlay-model"}}"#.into(),
        );
        load.env.insert("CLI_API_KEY".into(), "cli-secret".into());
        load.cli_model = Some("cli-model".into());
        let config = load_from(load);
        assert_eq!(config.default_model.as_deref(), Some("cli-model"));
        assert_eq!(
            config
                .settings
                .iter()
                .find(|setting| setting.key == "models.default")
                .map(|setting| setting.source.as_str()),
            Some("cli")
        );
        assert!(config.ready);
    }

    #[test]
    fn environment_wins_over_config_for_default_model_via_xai_key_origin() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        write_config(
            &load,
            r#"
[models]
default = "gateway"

[model.gateway]
model = "mock-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
"#,
        );
        load.env.insert("XAI_API_KEY".into(), "from-env".into());
        let config = load_from(load);
        assert!(config.ready);
        assert_eq!(
            config
                .settings
                .iter()
                .find(|setting| setting.key == "XAI_API_KEY")
                .map(|setting| (setting.value.as_str(), setting.source.as_str())),
            Some(("(set)", "environment"))
        );
        assert!(!inspect_json(&config).contains("from-env"));
    }

    #[test]
    fn overlay_beats_config_file() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        write_config(
            &load,
            r#"
[models]
default = "file"

[model.file]
model = "file"
base_url = "http://file.example/v1"
env_key = "FILE_API_KEY"

[model.overlay]
model = "overlay"
base_url = "http://overlay.example/v1"
env_key = "OVERLAY_API_KEY"
"#,
        );
        load.env.insert("OVERLAY_API_KEY".into(), "ok".into());
        load.env.insert(
            "GROK_CONFIG".into(),
            r#"{"models":{"default":"overlay"}}"#.into(),
        );
        let config = load_from(load);
        assert_eq!(config.default_model.as_deref(), Some("overlay"));
        assert_eq!(
            config
                .settings
                .iter()
                .find(|setting| setting.key == "models.default")
                .map(|setting| setting.source.as_str()),
            Some("overlay")
        );
    }

    #[test]
    fn maps_config_to_generated_dsh_settings_and_refuses_unmanaged_conflict() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        write_config(
            &load,
            r#"
[models]
default = "gateway"

[model.gateway]
name = "Local gateway"
model = "mock-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
"#,
        );
        load.env.insert("XAI_API_KEY".into(), "test-key".into());
        let config = load_from(load.clone());
        apply_to_dsh(&config, &load.env).unwrap();
        let yaml = fs::read_to_string(&config.settings_yaml).unwrap();
        assert!(yaml.starts_with(GENERATED_MARKER));
        assert!(yaml.contains("baseURL: \"http://127.0.0.1:9/v1\""));
        assert!(yaml.contains("apiKeyEnv: XAI_API_KEY"));
        assert!(yaml.contains("provider: gateway"));
        fs::write(&config.settings_yaml, "llm-pi-ai:\n  providers: {}\n").unwrap();
        let error = apply_to_dsh(&config, &load.env).unwrap_err();
        assert!(error.to_string().contains("refusing to overwrite"));
        assert_eq!(
            fs::read_to_string(&config.settings_yaml).unwrap(),
            "llm-pi-ai:\n  providers: {}\n"
        );
    }

    #[test]
    fn missing_credential_is_actionable_and_not_a_hidden_default() {
        let dir = TempDir::new().unwrap();
        let load = input(&dir);
        write_config(
            &load,
            r#"
[model.gateway]
model = "mock-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
"#,
        );
        let config = load_from(load);
        assert!(!config.ready);
        let message = config.first_run_message();
        assert!(message.contains("XAI_API_KEY"));
        assert!(message.contains("No hidden default key"));
    }

    #[test]
    fn writes_api_key_credentials_owner_only_without_env() {
        let dir = TempDir::new().unwrap();
        let load = input(&dir);
        write_config(
            &load,
            r#"
[model.gateway]
model = "mock-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
api_key = "file-secret"
"#,
        );
        let config = load_from(load.clone());
        assert!(config.ready);
        apply_to_dsh(&config, &load.env).unwrap();
        let path = config.dsh_home.join(".credentials.yaml");
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.contains("XAI_API_KEY:"));
        assert!(!inspect_json(&config).contains("file-secret"));
        let extra = credential_env(&config, &load.env);
        assert_eq!(extra, vec![("XAI_API_KEY".into(), "file-secret".into())]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn overlay_api_key_is_applied_without_rereading_config_file() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        write_config(
            &load,
            r#"
[model.gateway]
model = "mock-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
"#,
        );
        load.env.insert(
            "GROK_CONFIG".into(),
            r#"{"model":{"gateway":{"api_key":"overlay-secret"}}}"#.into(),
        );
        let config = load_from(load.clone());
        assert!(config.ready);
        assert_eq!(
            config
                .settings
                .iter()
                .find(|setting| setting.key == "model.gateway.api_key")
                .map(|setting| (setting.value.as_str(), setting.source.as_str())),
            Some(("(set)", "overlay"))
        );
        apply_to_dsh(&config, &load.env).unwrap();
        let body = fs::read_to_string(config.dsh_home.join(".credentials.yaml")).unwrap();
        assert!(body.contains("overlay-secret"));
        assert!(!inspect_json(&config).contains("overlay-secret"));
    }

    #[test]
    fn inspect_reports_privacy_values_applied_to_dsh() {
        let dir = TempDir::new().unwrap();
        let load = input(&dir);
        write_config(
            &load,
            r#"
[features]
telemetry = true
trace_upload = true
"#,
        );
        let config = load_from(load);
        assert!(!config.telemetry);
        assert!(!config.trace_upload);
        assert_eq!(
            config
                .settings
                .iter()
                .find(|setting| setting.key == "features.telemetry")
                .map(|setting| (setting.value.as_str(), setting.source.as_str())),
            Some(("false", "applied"))
        );
        assert_eq!(
            config
                .settings
                .iter()
                .find(|setting| setting.key == "features.trace_upload")
                .map(|setting| (setting.value.as_str(), setting.source.as_str())),
            Some(("false", "applied"))
        );
        assert!(inspect_json(&config).contains("\"telemetry\": false"));
    }
}
