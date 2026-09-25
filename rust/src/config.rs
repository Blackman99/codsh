use crate::appearance::{self, AppearanceConfig};
use crate::auth::{self, AuthConfig};
use crate::models::{
    ApiBackend, CatalogChoice, GROK_EFFORTS, Routing, acp_model_value, effort_supported,
    load_saved_selection, normalize_effort,
};
use crate::permission::{self, PermissionMode, PermissionPolicy};
use crate::screen_mode::ScreenMode;
use crate::trust::{
    self, DecideInputs, GrantOutcome, PersistStatus, TRUST_FILE_NAME, TrustOutcome, TrustStore,
};
use serde_json::{Value as JsonValue, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use toml::Value as TomlValue;

pub const GENERATED_MARKER: &str = "# generated-by: codsh-rust-config";

pub const UNTRUSTED_DSH_PLUGIN_PATCH: &str = "\
- id: agent-instructions
  disabled: true
- id: skill
  disabled: true
- id: skill-filesystem
  disabled: true
- id: tool-skill
  disabled: true
";

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
    pub api_backend: Option<ApiBackend>,
    pub api_backend_raw: String,
    pub context_window: Option<u64>,
    pub supports_reasoning_effort: bool,
    pub reasoning_efforts: Vec<String>,
    pub reasoning_effort: Option<String>,
    pub extra_headers: BTreeMap<String, String>,
    /// Declared input modalities. Empty means the model did not advertise image input.
    pub input_modalities: Vec<String>,
    pub unusable_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigError {
    pub path: Option<PathBuf>,
    pub reason: String,
}

#[derive(Clone, Debug)]
pub struct EffectiveConfig {
    pub grok_home: PathBuf,
    pub config_path: PathBuf,
    pub dsh_home: PathBuf,
    pub cwd: PathBuf,
    pub files: Vec<FileLayer>,
    pub settings: Vec<Setting>,
    pub default_model: Option<String>,
    pub default_effort: Option<String>,
    /// Saved advertised ACP model value. Used when the saved id is not a
    /// catalog id, so a terminal resume applies the same route the editor saved.
    pub saved_acp_value: Option<String>,
    /// Saved selection id that is not in the catalog. Presence means the
    /// catalog default must not be used as a silent substitute.
    pub unmatched_saved_model: Option<String>,
    /// Catalog id from `config.toml` before a saved selection replaced it.
    catalog_default_model: Option<String>,
    pub models: BTreeMap<String, ModelSpec>,
    pub telemetry: bool,
    pub feedback: bool,
    pub trace_upload: bool,
    pub share_content: bool,
    pub share_session: bool,
    pub telemetry_url: Option<String>,
    pub feedback_url: Option<String>,
    pub trace_url: Option<String>,
    pub remote_fetch: bool,
    pub ready: bool,
    pub missing_credential: Option<String>,
    pub errors: Vec<ConfigError>,
    pub warnings: Vec<String>,
    pub imported_legacy_credentials: bool,
    pub official_login_disabled: bool,
    pub settings_yaml: PathBuf,
    pub compact_threshold_percent: Option<u8>,
    pub compact_wall_clock_secs: Option<u64>,
    pub simple_mode: bool,
    pub prompt_suggestions: bool,
    pub prune_enabled: bool,
    pub prune_threshold_chars: u64,
    pub prune_head_chars: u64,
    pub prune_tail_chars: u64,
    pub workspace_trusted: bool,
    pub project_assets_active: bool,
    pub trust_prompt: bool,
    pub trust_message: String,
    pub appearance: AppearanceConfig,
    pub plugins: crate::plugin::PluginInspect,
    pub auth: AuthConfig,
    pub auth_session: Option<auth::AuthRecord>,
    pub fail_closed: bool,
    pub merged_table: TomlValue,
    pub permission: PermissionPolicy,
    pub voice: crate::voice::VoiceConfig,
    pub web: crate::web::WebServices,
    pub assets: crate::assets::AssetCatalog,
    /// Process and config gate. A `/memory` `t` toggle does not change this.
    pub memory: crate::memory::Enablement,
    /// Selected filesystem profile and the layer that won. A requirements pin
    /// is already applied here; CLI and `GROK_SANDBOX` do not beat it.
    pub sandbox_profile: String,
    pub sandbox_profile_source: String,
    /// Process flags for the subagent policy. The policy itself is resolved
    /// when dsh is spawned, after trust has settled the agent assets.
    pub subagent_cli: crate::subagents::CliSubagents,
    /// Environment the client passed to config (for the subagent knobs).
    pub subagent_env: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default)]
pub struct LoadInput {
    pub home: PathBuf,
    pub dsh_home: PathBuf,
    pub cwd: PathBuf,
    pub grok_home: Option<PathBuf>,
    pub env: BTreeMap<String, String>,
    pub cli_model: Option<String>,
    pub cli_effort: Option<String>,
    pub cli_trust: bool,
    pub cli_revoke_trust: bool,
    pub cli_trust_path: Option<PathBuf>,
    pub interactive: bool,
    pub cli_permission_mode: Option<String>,
    pub cli_always_approve: bool,
    pub cli_auto: bool,
    pub cli_allow: Vec<String>,
    pub cli_deny: Vec<String>,
    pub cli_no_memory: bool,
    pub cli_sandbox: Option<String>,
    /// `--disable-web-search` for this process.
    pub cli_disable_web_search: bool,
    /// `--no-subagents` and `--disallowed-tools Agent(type)`.
    pub cli_subagents: crate::subagents::CliSubagents,
}

impl EffectiveConfig {
    pub fn active_model(&self) -> Option<&ModelSpec> {
        let id = self.default_model.as_ref()?;
        self.models.get(id)
    }

    /// Credential for a background title call. Empty when the configured model
    /// has neither an environment key nor a file key.
    pub fn model_api_key(&self, model: &ModelSpec, env: &BTreeMap<String, String>) -> String {
        env.get(&model.env_key)
            .filter(|value| !value.is_empty())
            .cloned()
            .or_else(|| model.api_key.clone())
            .unwrap_or_default()
    }

    pub fn catalog(&self) -> Vec<CatalogChoice> {
        self.models
            .values()
            .map(|model| CatalogChoice {
                id: model.id.clone(),
                provider: model.provider.clone(),
                model: model.model.clone(),
                name: model.name.clone(),
                api: model
                    .api_backend
                    .map(ApiBackend::dsh_api)
                    .unwrap_or("unavailable")
                    .to_string(),
                backend: model.api_backend_raw.clone(),
                acp_value: acp_model_value(&model.provider, &model.model),
                efforts: model.reasoning_efforts.clone(),
                reasoning: model.supports_reasoning_effort,
                advertised_context: model.context_window,
                input_modalities: model.input_modalities.clone(),
                usable: model.unusable_reason.is_none()
                    && model.base_url.as_ref().is_some_and(|url| !url.is_empty()),
                unavailable: model.unusable_reason.clone(),
            })
            .collect()
    }

    /// Re-read `$GROK_HOME/model-selection.toml` onto this config.
    /// A terminal or a later editor write can change the file after connect.
    /// CLI and requirements pins stay; an unmatched saved id is not replaced
    /// by the catalog default.
    pub fn refresh_saved_selection(&mut self) {
        let pinned = self.settings.iter().any(|setting| {
            setting.key == "models.default"
                && matches!(setting.source.as_str(), "cli" | "requirements")
        });
        let Some(saved) = crate::models::load_saved_selection(&self.grok_home) else {
            return;
        };
        self.saved_acp_value = saved.acp_value.filter(|value| !value.is_empty());
        if self.models.contains_key(&saved.model_id) {
            self.unmatched_saved_model = None;
            if !pinned {
                self.default_model = Some(saved.model_id);
            }
        } else {
            self.unmatched_saved_model = Some(saved.model_id);
            if !pinned && let Some(catalog_id) = self.catalog_default_model.clone() {
                self.default_model = Some(catalog_id);
            }
        }
        if let Some(effort) = saved.effort {
            self.default_effort = Some(effort);
        }
    }

    pub fn routing(&self) -> Option<Routing> {
        let model = self.active_model()?;
        Some(Routing {
            catalog_id: model.id.clone(),
            provider: model.provider.clone(),
            model: model.model.clone(),
            backend: model.api_backend_raw.clone(),
            api: model
                .api_backend
                .map(ApiBackend::dsh_api)
                .unwrap_or("unavailable")
                .to_string(),
            effort: self.default_effort.clone(),
            advertised_context: model.context_window,
            accepts_images: crate::images::model_accepts_images(Some(&model.input_modalities)),
            source: self
                .settings
                .iter()
                .find(|setting| setting.key == "models.default")
                .map(|setting| setting.source.clone())
                .unwrap_or_else(|| "default".into()),
        })
    }

    pub fn first_run_message(&self) -> String {
        if let Some(error) = self.errors.first() {
            let location = error
                .path
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "config".into());
            let extra = if self.trust_message.is_empty() {
                String::new()
            } else {
                format!("\n{}", self.trust_message)
            };
            return format!(
                "Invalid configuration: {location}: {}\nOriginal file was not changed.{extra}",
                error.reason
            );
        }
        if let Some(missing) = &self.missing_credential {
            if self.trust_prompt {
                return format!("{missing}\n{}", self.trust_message);
            }
            return missing.clone();
        }
        if self.auth.disable_api_key_auth
            && auth::usable_identity_session(&self.auth, self.auth_session.as_ref()).is_err()
        {
            return auth::identity_required_message(&self.auth);
        }
        if !self.ready && !self.trust_prompt {
            return "First-run: no usable provider. Official grok.com login/telemetry unused.\nWrite ~/.codsh-rust/.grok/config.toml ([model.<id>] base_url, env_key). Export the key. inspect shows origins.".into();
        }
        if self.trust_prompt {
            return self.trust_message.clone();
        }
        String::new()
    }

    /// Inspect/connect stay fail-closed without a matching identity session.
    /// `login` and `setup` still run so that session can be minted. Other
    /// config errors keep blocking those commands.
    pub fn blocks_auth_command(&self) -> bool {
        self.errors
            .iter()
            .any(|error| !is_identity_session_gate(error))
    }
}

fn is_identity_session_gate(error: &ConfigError) -> bool {
    let name = error
        .path
        .as_ref()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if name == "auth.json"
        && (error.reason.contains("Organization policy")
            || error.reason.contains("identity session")
            || error.reason.contains("requires logging into"))
    {
        return true;
    }
    // Unsigned fail-closed requirements still refuse execution, but login
    // must remain available so a session can be minted and setup can install
    // a verifiable sidecar.
    (name == "requirements.toml" || name == auth::SIGNATURE_SIDECAR)
        && (error.reason.contains("cannot be verified") || error.reason.contains("principal"))
}

pub fn grok_home_from(home: &Path, env_home: Option<&str>) -> PathBuf {
    match env_home {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => home.join(".grok"),
    }
}

#[allow(dead_code)]
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
        cli_effort: None,
        cli_trust: false,
        cli_revoke_trust: false,
        cli_trust_path: None,
        interactive: true,
        cli_permission_mode: None,
        cli_always_approve: false,
        cli_auto: false,
        cli_allow: Vec::new(),
        cli_deny: Vec::new(),
        cli_no_memory: false,
        cli_sandbox: None,
        cli_disable_web_search: false,
        cli_subagents: Default::default(),
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
    let mut default_effort = None;
    let mut saved_acp_value = None;
    let mut unmatched_saved_model = None;
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

    let managed_path = grok_home.join("managed_config.toml");
    let requirements_path = grok_home.join("requirements.toml");
    let managed = read_layer(
        &managed_path,
        "managed_config.toml",
        false,
        &mut files,
        &mut errors,
    );
    let user = read_layer(&config_path, "config.toml", true, &mut files, &mut errors);
    let requirements = read_layer(
        &requirements_path,
        "requirements.toml",
        false,
        &mut files,
        &mut errors,
    );
    let admin_fail_closed = bool_from_toml(
        requirements
            .as_ref()
            .and_then(|value| value.get("fail_closed")),
    )
    .unwrap_or(false);
    let env_fail_closed = env_bool(input.env.get("GROK_MANAGED_CONFIG_FAIL_CLOSED")) == Some(true);
    let fail_closed = admin_fail_closed || env_fail_closed;
    diagnose_unknown_security(
        managed.as_ref(),
        Some(&managed_path),
        "managed",
        fail_closed,
        &mut errors,
        &mut warnings,
    );
    diagnose_unknown_security(
        requirements.as_ref(),
        Some(&requirements_path),
        "requirements",
        true,
        &mut errors,
        &mut warnings,
    );
    diagnose_unknown_security(
        user.as_ref(),
        Some(&config_path),
        "config.toml",
        fail_closed,
        &mut errors,
        &mut warnings,
    );
    diagnose_invalid_policy(
        requirements.as_ref(),
        Some(&requirements_path),
        "requirements",
        &mut errors,
    );
    diagnose_invalid_policy(
        managed.as_ref(),
        Some(&managed_path),
        "managed",
        &mut errors,
    );

    let requirement_folder_trust = bool_from_toml(
        requirements
            .as_ref()
            .and_then(|value| value.get("folder_trust"))
            .and_then(|value| value.get("enabled")),
    );
    let user_folder_trust = bool_from_toml(
        user.as_ref()
            .and_then(|value| value.get("folder_trust"))
            .and_then(|value| value.get("enabled")),
    );
    let managed_folder_trust = bool_from_toml(
        managed
            .as_ref()
            .and_then(|value| value.get("folder_trust"))
            .and_then(|value| value.get("enabled")),
    );
    let (folder_trust_on, folder_trust_source) = trust::folder_trust_enabled(
        input.env.get("GROK_FOLDER_TRUST").map(String::as_str),
        user_folder_trust,
        managed_folder_trust,
        requirement_folder_trust,
    );
    let workspace_key = input
        .cli_trust_path
        .as_ref()
        .map(|path| trust::workspace_key(path, &input.home))
        .unwrap_or_else(|| trust::workspace_key(&input.cwd, &input.home));
    let workspace_path = workspace_key.join(".grok").join("config.toml");
    let mut store = TrustStore::load_from(grok_home.join(TRUST_FILE_NAME), input.home.clone());
    if !store.disk_readable() {
        errors.push(ConfigError {
            path: Some(grok_home.join(TRUST_FILE_NAME)),
            reason: "trusted_folders.toml could not be read; folder trust fails closed. Fix or delete the file."
                .into(),
        });
    }
    if input.cli_revoke_trust {
        let _ = trust::revoke_folder_trust(&mut store, &workspace_key);
        store = TrustStore::load_from(grok_home.join(TRUST_FILE_NAME), input.home.clone());
    }
    let mut trust_message = String::new();
    if input.cli_trust {
        match trust::grant_folder_trust_key(Some(&grok_home), &input.home, &workspace_key) {
            GrantOutcome::Granted {
                persist: PersistStatus::ProcessLocalOnly { .. },
                ..
            } => {
                trust_message = "Couldn't save folder trust. Check that $GROK_HOME is writable, then run `codsh --rust --trust` in this folder.".into();
            }
            GrantOutcome::Refused { reason } => {
                errors.push(ConfigError {
                    path: Some(workspace_key.clone()),
                    reason: reason.to_string(),
                });
            }
            _ => {}
        }
        store = TrustStore::load_from(grok_home.join(TRUST_FILE_NAME), input.home.clone());
    }
    let kinds = trust::repo_config_kinds(&input.cwd);
    let outcome = if let Some(trusted) = trust::process_decision(&workspace_key) {
        if trusted {
            TrustOutcome::Trusted
        } else {
            TrustOutcome::Untrusted
        }
    } else {
        trust::decide(
            folder_trust_on,
            &DecideInputs {
                store_trusted: trust::is_trusted_this_process(&workspace_key, &store),
                repo_configs_present: !kinds.is_empty(),
                is_interactive: input.interactive,
                key_recordable: !trust::is_unsafe_trust_root(&workspace_key, &input.home),
            },
        )
    };
    let trust_prompt = outcome == TrustOutcome::Prompt;
    let workspace_trusted = matches!(outcome, TrustOutcome::Trusted);
    let store_trusted = trust::is_trusted_this_process(&workspace_key, &store);
    if trust_prompt {
        trust_message = format!(
            "This folder contains repo-local config ({}) that would otherwise apply automatically.\nFolder: {}\nTrust this workspace? y=allow  n=deny (untrusted Hooks/plugins/project capabilities will not run)",
            if kinds.is_empty() {
                "project assets".into()
            } else {
                kinds.join(", ")
            },
            workspace_key.display()
        );
    } else if !workspace_trusted && !kinds.is_empty() {
        trust_message = format!(
            "Workspace untrusted; inactive project assets: {}. Use --trust or press y when prompted.",
            kinds.join(", ")
        );
    }
    let skipped_untrusted_assets =
        trust::skip_untrusted_project_hooks(&input.cwd, workspace_trusted).unwrap_or(false);
    if skipped_untrusted_assets {
        files.push(FileLayer {
            path: workspace_key.clone(),
            role: "project-assets".into(),
            status: "skipped-untrusted".into(),
        });
    }

    let overlay = overlay_table(&input.env, &mut warnings);
    let mut table = TomlValue::Table(toml::map::Map::new());
    if let Some(value) = &managed {
        merge_toml(&mut table, value);
        stamp_model_sources(value, &mut sources, "managed");
    }
    if let Some(value) = &user {
        merge_toml(&mut table, value);
        stamp_model_sources(value, &mut sources, "config.toml");
    }
    // A runtime `/model` or `/effort` is stored before workspace config is
    // known. Trusted workspace config for the current directory replaces that
    // saved model and effort; an unknown saved id still does not.
    if let Some(saved) = load_saved_selection(&grok_home)
        && let Some(models_table) = table.get("model").and_then(TomlValue::as_table)
        && models_table.contains_key(&saved.model_id)
    {
        let mut selection = toml::map::Map::new();
        let mut models_value = toml::map::Map::new();
        models_value.insert("default".into(), TomlValue::String(saved.model_id.clone()));
        if let Some(effort) = saved.effort.filter(|value| !value.is_empty()) {
            models_value.insert("default_reasoning_effort".into(), TomlValue::String(effort));
        }
        selection.insert("models".into(), TomlValue::Table(models_value));
        let selection = TomlValue::Table(selection);
        merge_toml(&mut table, &selection);
        stamp_model_sources(&selection, &mut sources, "saved");
    }
    let mut workspace_layer = None;
    let mut workspace_ui = None;
    if workspace_trusted {
        if let Some(value) =
            read_layer(&workspace_path, "workspace", false, &mut files, &mut errors)
        {
            diagnose_unknown_security(
                Some(&value),
                Some(&workspace_path),
                "workspace",
                fail_closed,
                &mut errors,
                &mut warnings,
            );
            workspace_layer = Some(value.clone());
            workspace_ui = Some(value.clone());
            merge_toml(&mut table, &value);
            stamp_model_sources(&value, &mut sources, "workspace");
        }
    } else if workspace_path.exists() {
        files.push(FileLayer {
            path: workspace_path.clone(),
            role: "workspace".into(),
            status: "skipped-untrusted".into(),
        });
    }
    let confined_overlay = overlay.as_ref().and_then(|overlay| {
        confine_overlay(overlay.clone(), fail_closed, &mut warnings, &mut errors)
    });
    if let Some(confined) = &confined_overlay {
        merge_toml(&mut table, confined);
        files.push(FileLayer {
            path: PathBuf::from("GROK_CONFIG"),
            role: "overlay".into(),
            status: "ok".into(),
        });
        stamp_model_sources(confined, &mut sources, "overlay");
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
    if let Some(value) = table
        .get("models")
        .and_then(|models| models.get("default_reasoning_effort"))
        .and_then(TomlValue::as_str)
    {
        default_effort = normalize_effort(value);
        sources
            .entry("models.default_reasoning_effort".into())
            .or_insert_with(|| "config.toml".into());
    }
    // A saved advertised pair that is not a catalog id stays unmatched. The
    // catalog default remains for pins, but the ACP value is applied later
    // and is not silently swapped for that catalog model.
    let catalog_default_model = default_model.clone();
    if let Some(saved) = load_saved_selection(&grok_home) {
        saved_acp_value = saved.acp_value.filter(|value| !value.is_empty());
        if models.contains_key(&saved.model_id) {
            // The early merge above already applied a catalog id, and a later
            // trusted workspace layer may replace that model and effort.
        } else {
            unmatched_saved_model = Some(saved.model_id);
            // Not a catalog id, so the early merge did not apply its effort.
            // A trusted workspace default still wins for the catalog model.
            if let Some(effort) = saved.effort {
                default_effort = Some(effort);
                sources.insert("models.default_reasoning_effort".into(), "saved".into());
            }
        }
    }
    let mut remote_fetch = bool_from_toml(
        table
            .get("features")
            .and_then(|features| features.get("remote_fetch")),
    )
    .unwrap_or(false);
    sources
        .entry("features.remote_fetch".into())
        .or_insert_with(|| "default".into());

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
    let mut share_content = bool_from_toml(
        table
            .get("privacy")
            .and_then(|privacy| privacy.get("share_content")),
    )
    .unwrap_or(false);
    sources
        .entry("privacy.share_content".into())
        .or_insert_with(|| "default".into());
    let mut share_session = bool_from_toml(
        table
            .get("privacy")
            .and_then(|privacy| privacy.get("share_session")),
    )
    .unwrap_or(false);
    sources
        .entry("privacy.share_session".into())
        .or_insert_with(|| "default".into());
    if let Some(value) = env_bool(input.env.get("GROK_SHARE_CONTENT")) {
        share_content = value;
        sources.insert("privacy.share_content".into(), "environment".into());
    }
    if let Some(value) = env_bool(input.env.get("GROK_SHARE_SESSION")) {
        share_session = value;
        sources.insert("privacy.share_session".into(), "environment".into());
    }
    let telemetry_url = optional_url(
        table
            .get("endpoints")
            .and_then(|endpoints| endpoints.get("telemetry_url"))
            .and_then(TomlValue::as_str),
    );
    let feedback_url = optional_url(
        table
            .get("endpoints")
            .and_then(|endpoints| endpoints.get("feedback_base_url"))
            .and_then(TomlValue::as_str)
            .or_else(|| {
                table
                    .get("endpoints")
                    .and_then(|endpoints| endpoints.get("feedback_url"))
                    .and_then(TomlValue::as_str)
            }),
    );
    let trace_url = optional_url(
        table
            .get("endpoints")
            .and_then(|endpoints| endpoints.get("trace_upload_url"))
            .and_then(TomlValue::as_str),
    );

    if let Some(cli) = input
        .cli_model
        .clone()
        .or_else(|| input.env.get("CODSH_CLI_MODEL").cloned())
    {
        default_model = Some(cli);
        sources.insert("models.default".into(), "cli".into());
    }
    if let Some(cli) = input.cli_effort.clone().or_else(|| {
        input
            .env
            .get("CODSH_CLI_EFFORT")
            .cloned()
            .or_else(|| input.env.get("GROK_EFFORT").cloned())
    }) {
        default_effort = normalize_effort(&cli);
        sources.insert("models.default_reasoning_effort".into(), "cli".into());
    }

    if let Some(req) = &requirements {
        if let Some(model_table) = req.get("model").and_then(TomlValue::as_table) {
            for (id, spec) in model_table {
                if let Some(model) = parse_model(id, spec) {
                    models.insert(id.clone(), model);
                }
            }
            stamp_model_sources(req, &mut sources, "requirements");
        }
        if let Some(value) = req
            .get("models")
            .and_then(|models| models.get("default"))
            .and_then(TomlValue::as_str)
        {
            default_model = Some(value.to_string());
            sources.insert("models.default".into(), "requirements".into());
        }
        if let Some(value) = bool_from_toml(
            req.get("features")
                .and_then(|features| features.get("remote_fetch")),
        ) {
            remote_fetch = value;
            sources.insert("features.remote_fetch".into(), "requirements".into());
        }
        if let Some(value) = bool_from_toml(
            req.get("features")
                .and_then(|features| features.get("telemetry")),
        ) {
            telemetry = value;
            sources.insert("features.telemetry".into(), "requirements".into());
        }
        if let Some(value) = bool_from_toml(
            req.get("features")
                .and_then(|features| features.get("feedback")),
        ) {
            feedback = value;
            sources.insert("features.feedback".into(), "requirements".into());
        }
        if let Some(value) = bool_from_toml(
            req.get("features")
                .and_then(|features| features.get("trace_upload"))
                .or_else(|| {
                    req.get("telemetry")
                        .and_then(|telemetry| telemetry.get("trace_upload"))
                }),
        ) {
            trace_upload = value;
            sources.insert("features.trace_upload".into(), "requirements".into());
        }
        if let Some(value) = bool_from_toml(
            req.get("privacy")
                .and_then(|privacy| privacy.get("share_content")),
        ) {
            share_content = value;
            sources.insert("privacy.share_content".into(), "requirements".into());
        }
        if let Some(value) = bool_from_toml(
            req.get("privacy")
                .and_then(|privacy| privacy.get("share_session")),
        ) {
            share_session = value;
            sources.insert("privacy.share_session".into(), "requirements".into());
        }
        if let Some(url) = req
            .get("endpoints")
            .and_then(|endpoints| endpoints.get("managed_config_url"))
            .and_then(TomlValue::as_str)
            && !url.is_empty()
        {
            warnings.push(format!(
                "managed_config_url is locked at {url}; malformed or stale remote policy cannot weaken requirements.toml"
            ));
        }
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
        push_setting(
            &mut settings,
            &format!("{prefix}.api_backend"),
            &model.api_backend_raw,
            sources
                .get(&format!("{prefix}.api_backend"))
                .map(String::as_str)
                .unwrap_or("default"),
        );
        push_setting(
            &mut settings,
            &format!("{prefix}.api"),
            model
                .api_backend
                .map(ApiBackend::dsh_api)
                .unwrap_or("unavailable"),
            sources
                .get(&format!("{prefix}.api_backend"))
                .map(String::as_str)
                .unwrap_or("default"),
        );
        push_setting(
            &mut settings,
            &format!("{prefix}.context_window"),
            &model
                .context_window
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".into()),
            sources
                .get(&format!("{prefix}.context_window"))
                .map(String::as_str)
                .unwrap_or("default"),
        );
        push_setting(
            &mut settings,
            &format!("{prefix}.supports_reasoning_effort"),
            if model.supports_reasoning_effort {
                "true"
            } else {
                "false"
            },
            sources
                .get(&format!("{prefix}.supports_reasoning_effort"))
                .map(String::as_str)
                .unwrap_or("default"),
        );
        push_setting(
            &mut settings,
            &format!("{prefix}.reasoning_efforts"),
            &if model.reasoning_efforts.is_empty() {
                "unavailable".into()
            } else {
                model.reasoning_efforts.join(",")
            },
            sources
                .get(&format!("{prefix}.reasoning_efforts"))
                .map(String::as_str)
                .unwrap_or("default"),
        );
        push_setting(
            &mut settings,
            &format!("{prefix}.extra_headers"),
            &if model.extra_headers.is_empty() {
                "(unset)".into()
            } else {
                model
                    .extra_headers
                    .keys()
                    .map(|key| format!("{key}=(set)"))
                    .collect::<Vec<_>>()
                    .join(",")
            },
            sources
                .get(&format!("{prefix}.extra_headers"))
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
    let telemetry_source_name = sources
        .get("features.telemetry")
        .map(String::as_str)
        .unwrap_or("default");
    let feedback_source_name = sources
        .get("features.feedback")
        .map(String::as_str)
        .unwrap_or("default");
    let trace_source_name = sources
        .get("features.trace_upload")
        .map(String::as_str)
        .unwrap_or("default");
    let content_source_name = sources
        .get("privacy.share_content")
        .map(String::as_str)
        .unwrap_or("default");
    let session_source_name = sources
        .get("privacy.share_session")
        .map(String::as_str)
        .unwrap_or("default");
    let (telemetry, telemetry_source) = resolve_privacy(
        telemetry,
        telemetry_source_name,
        telemetry_url.as_deref(),
        telemetry_source_name == "requirements" && !telemetry,
    );
    let (feedback, feedback_source) = resolve_privacy(
        feedback,
        feedback_source_name,
        feedback_url.as_deref(),
        feedback_source_name == "requirements" && !feedback,
    );
    let (trace_upload, trace_source) = resolve_privacy(
        trace_upload,
        trace_source_name,
        trace_url.as_deref(),
        trace_source_name == "requirements" && !trace_upload,
    );
    let (share_content, content_source) = resolve_privacy(
        share_content,
        content_source_name,
        if share_content {
            feedback_url.as_deref().or(telemetry_url.as_deref())
        } else {
            None
        },
        content_source_name == "requirements" && !share_content,
    );
    // Session tracking is a boolean gate, not an upload by itself.
    let share_session_source = if session_source_name == "requirements" && !share_session {
        "requirements".to_string()
    } else if session_source_name == "default" {
        "default".to_string()
    } else {
        session_source_name.to_string()
    };
    push_setting(
        &mut settings,
        "features.telemetry",
        if telemetry { "true" } else { "false" },
        &telemetry_source,
    );
    if telemetry_source == "requirements" {
        push_setting(
            &mut settings,
            "features.telemetry.lock",
            "requirements",
            "locked",
        );
    }
    push_setting(
        &mut settings,
        "features.feedback",
        if feedback { "true" } else { "false" },
        &feedback_source,
    );
    if feedback_source == "requirements" {
        push_setting(
            &mut settings,
            "features.feedback.lock",
            "requirements",
            "locked",
        );
    }
    push_setting(
        &mut settings,
        "features.trace_upload",
        if trace_upload { "true" } else { "false" },
        &trace_source,
    );
    if trace_source == "requirements" {
        push_setting(
            &mut settings,
            "features.trace_upload.lock",
            "requirements",
            "locked",
        );
    }
    push_setting(
        &mut settings,
        "privacy.share_content",
        if share_content { "true" } else { "false" },
        &content_source,
    );
    if content_source == "requirements" {
        push_setting(
            &mut settings,
            "privacy.share_content.lock",
            "requirements",
            "locked",
        );
    }
    push_setting(
        &mut settings,
        "privacy.share_session",
        if share_session { "true" } else { "false" },
        &share_session_source,
    );
    push_endpoint(
        &mut settings,
        "endpoints.telemetry_url",
        telemetry_url.as_deref(),
    );
    push_endpoint(
        &mut settings,
        "endpoints.feedback_base_url",
        feedback_url.as_deref(),
    );
    push_endpoint(
        &mut settings,
        "endpoints.trace_upload_url",
        trace_url.as_deref(),
    );
    if telemetry_url
        .as_deref()
        .is_some_and(crate::privacy::is_official_endpoint)
        || feedback_url
            .as_deref()
            .is_some_and(crate::privacy::is_official_endpoint)
        || trace_url
            .as_deref()
            .is_some_and(crate::privacy::is_official_endpoint)
    {
        warnings.push(
            "an official telemetry or feedback host was refused; configure a substitute endpoint"
                .into(),
        );
    }
    push_setting(
        &mut settings,
        "features.remote_fetch",
        if remote_fetch { "true" } else { "false" },
        sources
            .get("features.remote_fetch")
            .map(String::as_str)
            .unwrap_or("default"),
    );
    push_setting(
        &mut settings,
        "folder_trust.enabled",
        if folder_trust_on { "true" } else { "false" },
        folder_trust_source,
    );
    push_setting(
        &mut settings,
        "workspace.trust",
        match outcome {
            TrustOutcome::Trusted => "trusted",
            TrustOutcome::Untrusted => "untrusted",
            TrustOutcome::Prompt => "prompt",
        },
        if store_trusted {
            "store"
        } else if input.cli_trust {
            "cli"
        } else {
            folder_trust_source
        },
    );
    push_setting(
        &mut settings,
        "workspace.key",
        &workspace_key.display().to_string(),
        "workspace",
    );
    let project_assets_active = workspace_trusted;
    push_setting(
        &mut settings,
        "workspace.project_assets",
        if project_assets_active {
            "active"
        } else {
            "inactive"
        },
        if project_assets_active {
            "trusted"
        } else {
            "untrusted"
        },
    );
    let mut simple_mode = true;
    let mut prompt_suggestions = true;
    let mut ui_sources: BTreeMap<&str, &str> = BTreeMap::new();
    if let Some(value) = bool_from_toml(
        managed
            .as_ref()
            .and_then(|value| value.get("ui"))
            .and_then(|ui| ui.get("simple_mode")),
    ) {
        simple_mode = value;
        ui_sources.insert("ui.simple_mode", "managed");
    }
    if let Some(value) = bool_from_toml(
        user.as_ref()
            .and_then(|value| value.get("ui"))
            .and_then(|ui| ui.get("simple_mode")),
    ) {
        simple_mode = value;
        ui_sources.insert("ui.simple_mode", "config.toml");
    }
    if let Some(value) = bool_from_toml(
        requirements
            .as_ref()
            .and_then(|value| value.get("ui"))
            .and_then(|ui| ui.get("simple_mode")),
    ) {
        simple_mode = value;
        ui_sources.insert("ui.simple_mode", "requirements");
    }
    if let Some(value) = bool_from_toml(
        managed
            .as_ref()
            .and_then(|value| value.get("ui"))
            .and_then(|ui| ui.get("prompt_suggestions")),
    ) {
        prompt_suggestions = value;
        ui_sources.insert("ui.prompt_suggestions", "managed");
    }
    if let Some(value) = bool_from_toml(
        user.as_ref()
            .and_then(|value| value.get("ui"))
            .and_then(|ui| ui.get("prompt_suggestions")),
    ) {
        prompt_suggestions = value;
        ui_sources.insert("ui.prompt_suggestions", "config.toml");
    }
    if let Some(value) = env_bool(input.env.get("GROK_PROMPT_SUGGESTIONS")) {
        prompt_suggestions = value;
        ui_sources.insert("ui.prompt_suggestions", "environment");
    }
    if let Some(value) = bool_from_toml(
        requirements
            .as_ref()
            .and_then(|value| value.get("ui"))
            .and_then(|ui| ui.get("prompt_suggestions")),
    ) {
        prompt_suggestions = value;
        ui_sources.insert("ui.prompt_suggestions", "requirements");
    }
    push_setting(
        &mut settings,
        "ui.simple_mode",
        if simple_mode { "true" } else { "false" },
        ui_sources
            .get("ui.simple_mode")
            .copied()
            .unwrap_or("default"),
    );
    push_setting(
        &mut settings,
        "ui.prompt_suggestions",
        if prompt_suggestions { "true" } else { "false" },
        ui_sources
            .get("ui.prompt_suggestions")
            .copied()
            .unwrap_or("default"),
    );
    push_setting(
        &mut settings,
        "fail_closed",
        if fail_closed { "true" } else { "false" },
        if admin_fail_closed {
            "requirements"
        } else if env_fail_closed {
            "environment"
        } else {
            "default"
        },
    );

    if let Some(id) = &default_model
        && !models.contains_key(id)
    {
        errors.push(ConfigError {
            path: Some(config_path.clone()),
            reason: format!(
                "selected model {id} is not in the configured catalog; no silent provider fallback"
            ),
        });
    }
    if let Some(id) = &default_model
        && let Some(model) = models.get(id)
        && let Some(reason) = &model.unusable_reason
    {
        errors.push(ConfigError {
            path: Some(config_path.clone()),
            reason: reason.clone(),
        });
    }
    if let Some(id) = &default_model
        && let Some(model) = models.get(id)
    {
        let effort_source = sources
            .get("models.default_reasoning_effort")
            .map(String::as_str);
        if !model.supports_reasoning_effort {
            if let Some(effort) = default_effort.as_deref()
                && effort_source == Some("cli")
            {
                errors.push(ConfigError {
                    path: Some(config_path.clone()),
                    reason: format!(
                        "model {} does not support reasoning effort; {effort} is unavailable",
                        model.id
                    ),
                });
            } else {
                default_effort = None;
            }
        } else if let Some(effort) = default_effort.as_deref() {
            if !effort_supported(&model.reasoning_efforts, effort) {
                errors.push(ConfigError {
                    path: Some(config_path.clone()),
                    reason: format!(
                        "unsupported effort {effort} for {} (api={}). Available: {}.",
                        model.id,
                        model
                            .api_backend
                            .map(ApiBackend::dsh_api)
                            .unwrap_or("unavailable"),
                        model.reasoning_efforts.join(", ")
                    ),
                });
            }
        } else if model.supports_reasoning_effort {
            default_effort = model.reasoning_effort.clone();
            sources
                .entry("models.default_reasoning_effort".into())
                .or_insert_with(|| "config.toml".into());
        }
    }
    push_setting(
        &mut settings,
        "models.default_reasoning_effort",
        default_effort.as_deref().unwrap_or("unavailable"),
        sources
            .get("models.default_reasoning_effort")
            .map(String::as_str)
            .unwrap_or("default"),
    );

    let mut missing_credential = None;
    let mut ready = false;
    let policy_blocked = errors.iter().any(|error| {
        error
            .path
            .as_ref()
            .is_some_and(|path| path.ends_with("requirements.toml"))
            && fail_closed
    });
    if errors.is_empty()
        && !policy_blocked
        && !trust_prompt
        && let Some(id) = &default_model
        && let Some(model) = models.get(id)
        && model.unusable_reason.is_none()
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
    let auth = auth::load_auth_config_layers(&table, requirements.as_ref(), &input.env);
    warnings.extend(auth.extra_ca_warnings.iter().cloned());
    // Startup, inspect, and slash reload all come through here. An expired
    // auth.json must be refreshed or cleared before the team pin is treated
    // as a usable identity session. A cleared unrefreshable token is not a
    // config error: login still has to run, and an independent API key stays
    // usable. The file is already removed, so the message is a warning.
    // The signature check needs this session: a sidecar signed for another
    // team, or one that names no principal, is not authentic for this caller.
    let session = match auth::refresh_session(&grok_home, &input.env, &auth) {
        Ok(record) => record,
        Err(error) => {
            warnings.push(error);
            None
        }
    };
    let caller_deployment = if auth.deployment_key.is_some() {
        Some(auth::DEPLOYMENT_KEY_PRINCIPAL)
    } else {
        None
    };
    if let Err(error) = auth::verify_on_disk_signature(
        &grok_home,
        auth.managed_pubkey.as_deref(),
        fail_closed,
        session
            .as_ref()
            .and_then(|record| record.team_id.as_deref()),
        caller_deployment,
    ) {
        errors.push(ConfigError {
            path: Some(grok_home.join(auth::SIGNATURE_SIDECAR)),
            reason: error,
        });
    }
    if let Err(error) = auth::usable_identity_session(&auth, session.as_ref()) {
        if missing_credential.is_none() {
            missing_credential = Some(error.clone());
        }
        errors.push(ConfigError {
            path: Some(auth::auth_json_path(&grok_home, &input.env)),
            reason: error,
        });
        ready = false;
    }
    if !errors.is_empty() {
        ready = false;
    }
    push_setting(
        &mut settings,
        "auth.method",
        auth.method.as_str(),
        "resolved",
    );
    push_setting(
        &mut settings,
        "auth.transport",
        auth.transport.as_str(),
        &auth.transport_source,
    );
    push_setting(
        &mut settings,
        "auth.session",
        if session.is_some() {
            "present"
        } else {
            "absent"
        },
        "auth.json",
    );
    push_setting(
        &mut settings,
        "auth.transferred_to_external_services",
        "false",
        "isolated-home",
    );
    push_setting(&mut settings, "official.login", "disabled", "default");
    if let Some(url) = &auth.managed_config_url {
        push_setting(
            &mut settings,
            "endpoints.managed_config_url",
            url,
            if input.env.contains_key("GROK_MANAGED_CONFIG_URL") {
                "environment"
            } else {
                "config.toml"
            },
        );
    }
    if let Some(source) = &auth.extra_ca_source {
        push_setting(&mut settings, "tls.extra_ca", source, source);
    }
    push_setting(
        &mut settings,
        "auth.uncharged_401_park",
        if auth.uncharged_401_park {
            "true"
        } else {
            "false"
        },
        "resolved",
    );
    push_setting(
        &mut settings,
        "auth.subscription_watch_secs",
        &auth
            .subscription_watch_secs
            .map(|secs| secs.to_string())
            .unwrap_or_else(|| "disabled".into()),
        "environment",
    );

    let compact_threshold_percent = resolve_compact_threshold(&table, &input.env, &mut sources);
    let compact_wall_clock_secs =
        resolve_wall_clock(&table, &input.env, &mut sources, &mut warnings);
    let (prune_enabled, prune_threshold_chars, prune_head_chars, prune_tail_chars) =
        resolve_pruning(&table, &mut sources, &mut warnings);
    push_setting(
        &mut settings,
        "session.auto_compact_threshold_percent",
        &compact_threshold_percent
            .map(|value| value.to_string())
            .unwrap_or_else(|| "80".into()),
        sources
            .get("session.auto_compact_threshold_percent")
            .map(String::as_str)
            .unwrap_or("default"),
    );
    push_setting(
        &mut settings,
        "compaction.wall_clock_secs",
        &compact_wall_clock_secs
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unset".into()),
        sources
            .get("compaction.wall_clock_secs")
            .map(String::as_str)
            .unwrap_or("default"),
    );
    push_setting(
        &mut settings,
        "compaction.pruning.enabled",
        if prune_enabled { "true" } else { "false" },
        sources
            .get("compaction.pruning.enabled")
            .map(String::as_str)
            .unwrap_or("default"),
    );
    push_setting(
        &mut settings,
        "compaction.pruning.soft_trim_threshold",
        &prune_threshold_chars.to_string(),
        sources
            .get("compaction.pruning.soft_trim_threshold")
            .map(String::as_str)
            .unwrap_or("default"),
    );
    push_setting(
        &mut settings,
        "compaction.pruning.soft_trim_head",
        &prune_head_chars.to_string(),
        sources
            .get("compaction.pruning.soft_trim_head")
            .map(String::as_str)
            .unwrap_or("default"),
    );
    push_setting(
        &mut settings,
        "compaction.pruning.soft_trim_tail",
        &prune_tail_chars.to_string(),
        sources
            .get("compaction.pruning.soft_trim_tail")
            .map(String::as_str)
            .unwrap_or("default"),
    );
    if table
        .get("compaction")
        .and_then(|value| value.get("pruning"))
        .and_then(|value| value.get("keep_last_n_turns"))
        .is_some()
    {
        warnings.push(
            "compaction.pruning.keep_last_n_turns is not a dsh token budget; dsh retains a recent ratio/tail instead"
                .into(),
        );
    }
    if table
        .get("compaction")
        .and_then(|value| value.get("pruning"))
        .and_then(|value| value.get("hard_clear_age_turns"))
        .is_some()
    {
        warnings.push(
            "compaction.pruning.hard_clear_age_turns is unavailable on dsh and was not applied"
                .into(),
        );
    }
    if let Some(percent) = compact_threshold_percent {
        warnings.extend(compact_threshold_warnings(percent));
    }

    let appearance = appearance::load(
        managed.as_ref(),
        user.as_ref(),
        requirements.as_ref(),
        &input.env,
        workspace_ui.as_ref(),
        &mut sources,
        &mut warnings,
    );
    for (key, value, source) in appearance::inspect_rows(&appearance, ScreenMode::Fullscreen) {
        push_setting(&mut settings, &key, &value, &source);
    }
    let nav_prefs = crate::navigation::load_prefs(&grok_home, &input.env);
    for (key, value, source) in crate::navigation::inspect_rows(&nav_prefs) {
        push_setting(&mut settings, key, &value, source);
    }
    let plugins = crate::plugin::inspect(&grok_home, &input.cwd, &input.env, workspace_trusted);
    warnings.extend(plugins.warnings.iter().cloned());
    push_setting(
        &mut settings,
        "marketplace.auto_register",
        if plugins.auto_register_official {
            "true"
        } else {
            "false"
        },
        if plugins.auto_register_official {
            "environment"
        } else {
            "default"
        },
    );
    push_setting(
        &mut settings,
        "marketplace.require_sha",
        if plugins.require_sha { "true" } else { "false" },
        if plugins.require_sha {
            "policy"
        } else {
            "default"
        },
    );

    let sandbox = resolve_sandbox_profile(
        &input,
        managed.as_ref(),
        user.as_ref(),
        workspace_layer.as_ref(),
        confined_overlay.as_ref(),
        requirements.as_ref(),
    );
    push_setting(&mut settings, "sandbox.profile", &sandbox.0, &sandbox.1);
    let workspace_tables = permission::collect_workspace_tables(&input.cwd, workspace_trusted);
    let claude = permission::load_claude_settings(&input.cwd, &input.home, workspace_trusted);
    let permission = match permission::build_policy(
        input.cwd.clone(),
        &grok_home,
        &input.home,
        input.interactive,
        workspace_trusted,
        user.as_ref(),
        managed.as_ref(),
        requirements.as_ref(),
        &workspace_tables,
        &claude,
        input.cli_permission_mode.as_deref(),
        input.cli_always_approve,
        input.cli_auto,
        input.env.get("GROK_PERMISSION_MODE").map(String::as_str),
        input
            .env
            .get("GROK_REMEMBER_TOOL_APPROVALS")
            .map(String::as_str),
        &input.cli_allow,
        &input.cli_deny,
    ) {
        Ok(policy) => {
            warnings.extend(policy.skipped.iter().cloned());
            policy
        }
        Err(reason) => {
            errors.push(ConfigError {
                path: Some(requirements_path.clone()),
                reason,
            });
            permission::build_policy(
                input.cwd.clone(),
                &grok_home,
                &input.home,
                input.interactive,
                workspace_trusted,
                user.as_ref(),
                managed.as_ref(),
                requirements.as_ref(),
                &workspace_tables,
                &claude,
                None,
                false,
                false,
                None,
                input
                    .env
                    .get("GROK_REMEMBER_TOOL_APPROVALS")
                    .map(String::as_str),
                &[],
                &input.cli_deny,
            )
            .unwrap_or_else(|_| PermissionPolicy {
                mode: PermissionMode::Ask,
                mode_source: "default".into(),
                always_approve_locked: true,
                lock_source: Some(
                    "always-approve disabled by managed policy ([ui] disable_bypass_permissions_mode = true in requirements.toml)"
                        .into(),
                ),
                remember_tool_approvals: true,
                remember_source: "default".into(),
                interactive: input.interactive,
                cwd: input.cwd.clone(),
                rules: Vec::new(),
                skipped: Vec::new(),
                grants_path: permission::workspace_grants_path(&grok_home, &input.cwd, &input.home),
                grants: permission::GrantStore::default(),
            })
        }
    };
    push_setting(
        &mut settings,
        "ui.permission_mode",
        permission.mode.as_str(),
        &permission.mode_source,
    );
    push_setting(
        &mut settings,
        "ui.remember_tool_approvals",
        if permission.remember_tool_approvals {
            "true"
        } else {
            "false"
        },
        &permission.remember_source,
    );
    if permission.always_approve_locked {
        push_setting(
            &mut settings,
            "ui.disable_bypass_permissions_mode",
            "true",
            "requirements",
        );
    }
    push_setting(
        &mut settings,
        "permission.rules",
        &permission.rules.len().to_string(),
        "merged",
    );
    let assets = discover_assets(
        &input.cwd,
        &grok_home,
        &input.home,
        project_assets_active,
        &table,
    );

    let voice = crate::voice::load_config(&table, &input.env);
    for (key, value, source) in crate::voice::inspect_rows(&voice) {
        push_setting(&mut settings, key, &value, &source);
    }

    let memory_configured =
        bool_from_toml(table.get("memory").and_then(|value| value.get("enabled")));
    let memory = crate::memory::resolve_enablement(
        memory_configured,
        input.env.get("GROK_MEMORY").map(String::as_str),
        input.cli_no_memory,
    );
    push_setting(
        &mut settings,
        "memory.enabled",
        if memory.enabled() { "true" } else { "false" },
        memory.source(),
    );
    push_setting(
        &mut settings,
        "memory.force_disable",
        if memory.force_off() { "true" } else { "false" },
        if memory.force_off() {
            memory.source()
        } else {
            "default"
        },
    );
    push_setting(&mut settings, "memory.uploads", "false", "default");
    let mut web = crate::web::load_services_layered(
        &table,
        user.as_ref()
            .unwrap_or(&TomlValue::Table(toml::map::Map::new())),
        &input.env,
        requirements.as_ref(),
        managed.as_ref(),
    );
    if input.cli_disable_web_search {
        web.disable_for_process();
    }
    warnings.extend(web.warnings.iter().cloned());
    for reason in &web.errors {
        errors.push(ConfigError {
            path: Some(config_path.clone()),
            reason: reason.clone(),
        });
    }
    for (key, value, source) in crate::web::inspect_rows(&web) {
        push_setting(&mut settings, key, &value, &source);
    }

    EffectiveConfig {
        grok_home,
        config_path,
        dsh_home: input.dsh_home,
        cwd: input.cwd,
        files,
        settings,
        default_model,
        default_effort,
        saved_acp_value,
        unmatched_saved_model,
        catalog_default_model,
        models,
        telemetry,
        feedback,
        trace_upload,
        share_content,
        share_session,
        telemetry_url,
        feedback_url,
        trace_url,
        remote_fetch,
        ready,
        missing_credential,
        errors,
        warnings,
        imported_legacy_credentials: false,
        official_login_disabled: true,
        settings_yaml,
        compact_threshold_percent,
        compact_wall_clock_secs,
        simple_mode,
        prompt_suggestions,
        prune_enabled,
        prune_threshold_chars,
        prune_head_chars,
        prune_tail_chars,
        workspace_trusted,
        project_assets_active,
        trust_prompt,
        trust_message,
        appearance,
        plugins,
        auth,
        auth_session: session,
        fail_closed,
        merged_table: table.clone(),
        permission,
        voice,
        web,
        assets,
        memory,
        sandbox_profile: sandbox.0,
        sandbox_profile_source: sandbox.1,
        subagent_cli: input.cli_subagents,
        subagent_env: input
            .env
            .iter()
            .filter(|(key, _)| {
                key.starts_with("GROK_SUBAGENT") || key.as_str() == "GROK_MAX_CONCURRENT_SUBAGENTS"
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    }
}

/// The subagent policy for the next dsh spawn.
pub fn subagent_policy(config: &EffectiveConfig) -> crate::subagents::Policy {
    crate::subagents::resolve(
        &config.merged_table,
        &config.subagent_env,
        &config.subagent_cli,
        &config.assets.agents,
        &config.grok_home,
    )
}

/// CODSH_SUBAGENT_POLICY and the control directory for dsh.
pub fn subagent_env(config: &EffectiveConfig) -> Vec<(String, String)> {
    crate::subagents::dsh_env(&subagent_policy(config), &config.dsh_home)
}

pub fn refresh_assets(config: &mut EffectiveConfig, home: &Path) {
    config.assets = discover_assets(
        &config.cwd,
        &config.grok_home,
        home,
        config.project_assets_active,
        &config.merged_table,
    );
}

fn discover_assets(
    cwd: &Path,
    grok_home: &Path,
    home: &Path,
    project_active: bool,
    table: &TomlValue,
) -> crate::assets::AssetCatalog {
    let compat = table.get("compat");
    let claude = compat.and_then(|value| value.get("claude"));
    let cursor = compat.and_then(|value| value.get("cursor"));
    let extra_rule_dirs = string_list(
        table
            .get("paths")
            .and_then(|value| value.get("extra_rule_dirs")),
    );
    let skill_paths = string_list(table.get("skills").and_then(|value| value.get("paths")));
    let skill_ignore = string_list(table.get("skills").and_then(|value| value.get("ignore")));
    let skill_disabled = string_list(table.get("skills").and_then(|value| value.get("disabled")));
    let claude_skills = compat_surface(
        bool_from_toml(claude.and_then(|value| value.get("skills"))),
        std::env::var("GROK_CLAUDE_SKILLS_ENABLED").ok().as_ref(),
    );
    let cursor_skills = compat_surface(
        bool_from_toml(cursor.and_then(|value| value.get("skills"))),
        std::env::var("GROK_CURSOR_SKILLS_ENABLED").ok().as_ref(),
    );
    crate::assets::discover(&crate::assets::DiscoverInput {
        cwd,
        grok_home,
        home,
        project_active,
        claude_rules: bool_from_toml(claude.and_then(|value| value.get("rules"))).unwrap_or(true),
        cursor_rules: bool_from_toml(cursor.and_then(|value| value.get("rules"))).unwrap_or(true),
        claude_agents: bool_from_toml(claude.and_then(|value| value.get("agents"))).unwrap_or(true),
        claude_skills,
        cursor_skills,
        extra_rule_dirs: &extra_rule_dirs,
        skill_paths: &skill_paths,
        skill_ignore: &skill_ignore,
        skill_disabled: &skill_disabled,
        builtin_commands: crate::prompt_edit::builtin_command_names(),
    })
}

fn string_list(value: Option<&TomlValue>) -> Vec<String> {
    value
        .and_then(TomlValue::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(TomlValue::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// `sandbox.profile` from one already-parsed layer. Not a line scan.
fn sandbox_profile_value(layer: Option<&TomlValue>) -> Option<String> {
    layer
        .and_then(|value| value.get("sandbox"))
        .and_then(|value| value.get("profile"))
        .and_then(TomlValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Guide 26 marks `sandbox.profile` as a requirements pin and a managed user
/// default. The pin beats CLI, `GROK_SANDBOX`, overlay, and every file below
/// it. A managed value is only the default those sources override.
fn resolve_sandbox_profile(
    input: &LoadInput,
    managed: Option<&TomlValue>,
    user: Option<&TomlValue>,
    workspace: Option<&TomlValue>,
    overlay: Option<&TomlValue>,
    requirements: Option<&TomlValue>,
) -> (String, String) {
    let env_profile = input
        .env
        .get("GROK_SANDBOX")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let layers = [
        (
            crate::filesystem_sandbox::ProfileSource::Requirements,
            sandbox_profile_value(requirements),
        ),
        (
            crate::filesystem_sandbox::ProfileSource::Cli,
            input.cli_sandbox.clone(),
        ),
        (
            crate::filesystem_sandbox::ProfileSource::Environment,
            env_profile.map(str::to_string),
        ),
        (
            crate::filesystem_sandbox::ProfileSource::Overlay,
            sandbox_profile_value(overlay),
        ),
        (
            crate::filesystem_sandbox::ProfileSource::Workspace,
            sandbox_profile_value(workspace),
        ),
        (
            crate::filesystem_sandbox::ProfileSource::User,
            sandbox_profile_value(user),
        ),
        (
            crate::filesystem_sandbox::ProfileSource::Managed,
            sandbox_profile_value(managed),
        ),
    ];
    let borrowed: Vec<_> = layers
        .iter()
        .map(|(source, value)| (*source, value.as_deref()))
        .collect();
    let (name, source) = crate::filesystem_sandbox::select_profile(&borrowed);
    let label = match source {
        crate::filesystem_sandbox::ProfileSource::Requirements => "requirements",
        crate::filesystem_sandbox::ProfileSource::Cli => "cli",
        crate::filesystem_sandbox::ProfileSource::Environment => "environment",
        crate::filesystem_sandbox::ProfileSource::Overlay => "overlay",
        crate::filesystem_sandbox::ProfileSource::User => "config.toml",
        crate::filesystem_sandbox::ProfileSource::Workspace => "workspace",
        crate::filesystem_sandbox::ProfileSource::Managed => "managed",
        crate::filesystem_sandbox::ProfileSource::Default => "default",
    };
    (name, label.into())
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
    lines.push(format!(
        "  {:<28} {}  ({})",
        "auth.official_entitlements", "unavailable", "default"
    ));
    lines.push(
        "Privacy: nonessential telemetry, trace upload, session tracking, and content sharing default off."
            .into(),
    );
    lines.push(
        "Model calls use the configured provider base_url and are not telemetry. Diagnostics never include prompts, keys, or paths."
            .into(),
    );
    if !config.warnings.is_empty() {
        lines.push("Warnings:".into());
        lines.extend(config.warnings.iter().map(|warning| format!("  {warning}")));
    }
    if !config.errors.is_empty() || !config.ready {
        lines.push(config.first_run_message());
    }
    lines.push(crate::plugin::inspect_text(&config.plugins));
    lines.push(crate::assets::inspect_text(&config.assets));
    lines.extend(subagent_policy(config).inspect_lines());
    lines.push(crate::filesystem_sandbox::status_line(
        crate::filesystem_sandbox::active(),
    ));
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
    let mut value = json!({
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
        "shareContent": config.share_content,
        "shareSession": config.share_session,
        "telemetryUrl": public_endpoint(config.telemetry_url.as_deref()),
        "feedbackUrl": public_endpoint(config.feedback_url.as_deref()),
        "traceUrl": public_endpoint(config.trace_url.as_deref()),
        "defaultModel": config.default_model,
        "defaultEffort": config.default_effort,
        "remoteFetch": config.remote_fetch,
        "workspaceTrusted": config.workspace_trusted,
        "projectAssetsActive": config.project_assets_active,
        "assets": crate::assets::inspect_json(&config.assets),
        "subagents": subagent_policy(config).to_json(),
        "trustPrompt": config.trust_prompt,
        "plugins": crate::plugin::inspect_json_value(&config.plugins),
        "auth": auth::inspect_auth_json(&config.auth, config.auth_session.as_ref()),
        "officialEntitlementsUnavailable": config.auth.official_entitlements,
        "compactThresholdPercent": config.compact_threshold_percent.unwrap_or(80),
        "compactWallClockSecs": config.compact_wall_clock_secs,
        "pruneEnabled": config.prune_enabled,
        "simpleMode": config.simple_mode,
        "promptSuggestions": config.prompt_suggestions,
        "appearance": appearance::inspect_json_fragment(&config.appearance, ScreenMode::Fullscreen),
        "voice": {
            "enabled": config.voice.enabled,
            "captureMode": if config.voice.capture_mode == crate::voice::CaptureMode::Toggle {
                "toggle"
            } else {
                "hold"
            },
            "keybindEnabled": config.voice.keybind_enabled,
            "requestLanguage": config.voice.request_language(),
            "apiBase": public_endpoint(config.voice.api_base.as_deref()),
            "sampleRate": config.voice.sample_rate,
            "disclosure": config.voice.disclosure(),
        },
    });
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "web".into(),
            json!({
                "webSearchEnabled": config.web.search.enabled,
                "searchModel": config.web.search.model,
                "searchProtocol": config.web.search.protocol.label(),
                "searchBase": public_endpoint(config.web.search.base_url.as_deref()),
                "searchAllowedDomains": config.web.search.allowed_domains,
                "searchExcludedDomains": config.web.search.excluded_domains,
                "searchCost": config.web.search.cost,
                "webFetchEnabled": config.web.fetch.enabled,
                "fetchAllowedDomains": config.web.fetch.allowed_domains,
                "fetchProxy": public_endpoint(config.web.fetch.proxy_endpoint.as_deref()),
                "fetchAllowLocal": config.web.fetch.allow_local,
                "fetchCost": config.web.fetch.cost,
                "disclosure": crate::web::disclosure(&config.web),
            }),
        );
        object.insert(
            "sandboxProfile".into(),
            JsonValue::String(config.sandbox_profile.clone()),
        );
        object.insert(
            "sandboxProfileSource".into(),
            JsonValue::String(config.sandbox_profile_source.clone()),
        );
        object.insert(
            "permissionMode".into(),
            JsonValue::String(config.permission.mode.as_str().into()),
        );
        object.insert(
            "permissionModeSource".into(),
            JsonValue::String(config.permission.mode_source.clone()),
        );
        object.insert(
            "alwaysApproveLocked".into(),
            JsonValue::Bool(config.permission.always_approve_locked),
        );
        object.insert(
            "rememberToolApprovals".into(),
            JsonValue::Bool(config.permission.remember_tool_approvals),
        );
        object.insert(
            "permissionRules".into(),
            JsonValue::from(config.permission.rules.len()),
        );
        object.insert(
            "permissionGrantsPath".into(),
            JsonValue::String(config.permission.grants_path.display().to_string()),
        );
        object.insert(
            "routing".into(),
            config.routing().map_or(JsonValue::Null, |routing| {
                json!({
                    "catalogId": routing.catalog_id,
                    "provider": routing.provider,
                    "model": routing.model,
                    "backend": routing.backend,
                    "api": routing.api,
                    "effort": routing.effort,
                    "advertisedContext": routing.advertised_context,
                    "source": routing.source,
                    "line": routing.line(),
                })
            }),
        );
    }
    let catalog: Vec<JsonValue> = config
        .catalog()
        .iter()
        .map(|choice| {
            json!({
                "id": choice.id,
                "provider": choice.provider,
                "model": choice.model,
                "api": choice.api,
                "backend": choice.backend,
                "reasoning": choice.reasoning,
                "efforts": choice.efforts,
                "advertisedContext": choice.advertised_context,
                "usable": choice.usable,
                "unavailable": choice.unavailable,
            })
        })
        .collect();
    if let Some(object) = value.as_object_mut() {
        object.insert("catalog".into(), JsonValue::Array(catalog));
    }
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "privacyBoundary".into(),
            JsonValue::String(
                "Model calls use the configured provider. Telemetry, feedback, and trace upload use only their own configured substitute endpoints and stay off without one. Diagnostic payloads contain kind/ok/count only.".into(),
            ),
        );
    }
    format!(
        "{}\n",
        serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".into())
    )
}

fn toml_u64(value: Option<&TomlValue>) -> Option<u64> {
    match value {
        Some(TomlValue::Integer(number)) if *number >= 0 => Some(*number as u64),
        Some(TomlValue::String(text)) => text.parse().ok(),
        Some(TomlValue::Float(number)) if *number >= 0.0 && number.fract() == 0.0 => {
            Some(*number as u64)
        }
        _ => None,
    }
}

pub fn compact_retain_ratio(threshold_ratio: f64) -> f64 {
    0.16_f64.min(threshold_ratio * 0.5)
}

pub fn compact_threshold_warnings(percent: u8) -> Vec<String> {
    if percent == 0 {
        return vec![
            "session.auto_compact_threshold_percent=0 is not a valid dsh thresholdRatio; auto compaction is disabled"
                .into(),
        ];
    }
    let threshold = (percent as f64) / 100.0;
    if compact_retain_ratio(threshold) < 0.16 {
        vec![format!(
            "session.auto_compact_threshold_percent={percent} is below dsh default retainRatio 0.16; emitting retainRatio {} so plugin load does not fail",
            compact_retain_ratio(threshold)
        )]
    } else {
        Vec::new()
    }
}

pub fn compaction_basic_yaml(percent: u8) -> String {
    if percent == 0 {
        return "- id: compaction-basic\n  config:\n    auto: false\n".into();
    }
    let threshold = (percent as f64) / 100.0;
    let retain = compact_retain_ratio(threshold);
    format!(
        "- id: compaction-basic\n  config:\n    thresholdRatio: {threshold}\n    retainRatio: {retain}\n    auto: true\n"
    )
}

fn parse_threshold_percent(raw: &str) -> Option<u8> {
    let value = raw.trim().parse::<i64>().ok()?;
    if (0..=100).contains(&value) {
        Some(value as u8)
    } else {
        None
    }
}

fn resolve_compact_threshold(
    table: &TomlValue,
    env: &BTreeMap<String, String>,
    sources: &mut BTreeMap<String, String>,
) -> Option<u8> {
    let mut value = table
        .get("session")
        .and_then(|session| session.get("auto_compact_threshold_percent"))
        .and_then(|item| match item {
            TomlValue::Integer(number) => parse_threshold_percent(&number.to_string()),
            TomlValue::String(text) => parse_threshold_percent(text),
            _ => None,
        });
    if table
        .get("session")
        .and_then(|session| session.get("auto_compact_threshold_percent"))
        .is_some()
    {
        sources.insert(
            "session.auto_compact_threshold_percent".into(),
            "config.toml".into(),
        );
    }
    if let Some(raw) = env.get("GROK_AUTO_COMPACT_THRESHOLD_PERCENT")
        && let Some(parsed) = parse_threshold_percent(raw)
    {
        value = Some(parsed);
        sources.insert(
            "session.auto_compact_threshold_percent".into(),
            "environment".into(),
        );
    }
    value
}

fn resolve_wall_clock(
    table: &TomlValue,
    env: &BTreeMap<String, String>,
    sources: &mut BTreeMap<String, String>,
    warnings: &mut Vec<String>,
) -> Option<u64> {
    let mut value = toml_u64(
        table
            .get("compaction")
            .and_then(|compaction| compaction.get("wall_clock_secs")),
    );
    if table
        .get("compaction")
        .and_then(|compaction| compaction.get("wall_clock_secs"))
        .is_some()
    {
        sources.insert("compaction.wall_clock_secs".into(), "config.toml".into());
    }
    if let Some(raw) = env.get("GROK_COMPACTION_WALL_CLOCK_SECS")
        && raw.trim().parse::<u64>().is_ok()
    {
        value = raw.trim().parse().ok();
        sources.insert("compaction.wall_clock_secs".into(), "environment".into());
    }
    if let Some(secs) = value
        && secs > 0
        && secs < 5
    {
        warnings.push(format!(
            "GROK_COMPACTION_WALL_CLOCK_SECS={secs} is a low positive budget and is used as-is rather than clamped"
        ));
    }
    value
}

fn resolve_pruning(
    table: &TomlValue,
    sources: &mut BTreeMap<String, String>,
    _warnings: &mut [String],
) -> (bool, u64, u64, u64) {
    let pruning = table
        .get("compaction")
        .and_then(|compaction| compaction.get("pruning"));
    let enabled = bool_from_toml(pruning.and_then(|value| value.get("enabled"))).unwrap_or(true);
    if pruning.and_then(|value| value.get("enabled")).is_some() {
        sources.insert("compaction.pruning.enabled".into(), "config.toml".into());
    }
    let threshold =
        toml_u64(pruning.and_then(|value| value.get("soft_trim_threshold"))).unwrap_or(8192);
    if pruning
        .and_then(|value| value.get("soft_trim_threshold"))
        .is_some()
    {
        sources.insert(
            "compaction.pruning.soft_trim_threshold".into(),
            "config.toml".into(),
        );
    }
    let head = toml_u64(pruning.and_then(|value| value.get("soft_trim_head"))).unwrap_or(4096);
    if pruning
        .and_then(|value| value.get("soft_trim_head"))
        .is_some()
    {
        sources.insert(
            "compaction.pruning.soft_trim_head".into(),
            "config.toml".into(),
        );
    }
    let tail = toml_u64(pruning.and_then(|value| value.get("soft_trim_tail"))).unwrap_or(1024);
    if pruning
        .and_then(|value| value.get("soft_trim_tail"))
        .is_some()
    {
        sources.insert(
            "compaction.pruning.soft_trim_tail".into(),
            "config.toml".into(),
        );
    }
    (enabled, threshold, head, tail)
}

pub fn is_test_execution_seam() -> bool {
    is_test_execution_seam_env(&std::env::vars().collect::<BTreeMap<String, String>>())
}

fn is_test_execution_seam_env(env: &BTreeMap<String, String>) -> bool {
    if env.contains_key("FAKE_ACP_MODE") || env.contains_key("DSH_CODE_CLI_MOCK_TOOL") {
        return true;
    }
    env.get("CODSH_ACP_PATCH")
        .and_then(|path| fs::read_to_string(path).ok())
        .is_some_and(|text| text.contains("cli-mock") || text.contains("rust-acp-mock-llm"))
}

pub fn apply_to_dsh(
    config: &EffectiveConfig,
    env: &BTreeMap<String, String>,
) -> io::Result<Option<PathBuf>> {
    permission::write_policy_file(&config.dsh_home, &config.permission).map_err(|error| {
        io::Error::other(format!(
            "couldn't write permission policy to {}: {error}; refusing rather than dropping deny rules",
            config.dsh_home.join(permission::POLICY_FILE_NAME).display()
        ))
    })?;
    if !config.errors.is_empty() || !config.ready {
        // The mock seam has no configured model, but its overlay still has to
        // reach dsh. A real missing model keeps the existing refusal.
        if is_test_execution_seam_env(env) {
            return write_test_seam_patch(config, env);
        }
        return Ok(None);
    }
    let Some(model) = config.active_model() else {
        if is_test_execution_seam_env(env) {
            return write_test_seam_patch(config, env);
        }
        return Ok(None);
    };
    let yaml = generated_settings_yaml(config)?;
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
    for model in config.models.values() {
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
    }
    let existing = env
        .get("CODSH_ACP_PATCH")
        .cloned()
        .or_else(|| std::env::var("CODSH_ACP_PATCH").ok())
        .and_then(|path| fs::read_to_string(path).ok())
        .unwrap_or_default();
    let threshold = config.compact_threshold_percent.unwrap_or(80);
    let pruner = if config.prune_enabled {
        format!(
            "- id: tool-result-pruner\n  config:\n    thresholdChars: {}\n    headChars: {}\n    tailChars: {}\n",
            config.prune_threshold_chars, config.prune_head_chars, config.prune_tail_chars
        )
    } else {
        "- id: tool-result-pruner\n  disabled: true\n".into()
    };
    let compact_yaml = compaction_basic_yaml(threshold);
    let gate = if config.project_assets_active {
        String::new()
    } else {
        UNTRUSTED_DSH_PLUGIN_PATCH.to_string()
    };
    let patch_path = config.dsh_home.join("rust-effective.yml");
    // Mock/PTY overlays already declare acp + llm adapters. Prepend only the
    // mapped compaction/pruner so the installed mock still loads dsh auto-compact.
    // Untrusted workspaces still append the instruction/skill gate.
    // A saved advertised pair that is not the catalog id is appended. dsh
    // applies later rows with the same id over earlier ones, so this wins
    // without a second YAML file and without dropping compaction or the gate.
    let saved_route = saved_advertised_route(config);
    let combined = if is_test_execution_seam_env(env) {
        format!("{compact_yaml}{pruner}{existing}{gate}{saved_route}")
    } else {
        format!(
            "- id: acp\n  config:\n    provider: {}\n    model: {}\n- id: agent-default-model\n  config:\n    provider: {}\n    model: {}\n- id: llm-deepseek\n  disabled: true\n{compact_yaml}{pruner}{existing}{gate}{saved_route}",
            yaml_plain(&model.provider),
            yaml_plain(&model.model),
            yaml_plain(&model.provider),
            yaml_plain(&model.model),
        )
    };
    fs::write(&patch_path, combined)?;
    Ok(Some(patch_path))
}

fn write_test_seam_patch(
    config: &EffectiveConfig,
    env: &BTreeMap<String, String>,
) -> io::Result<Option<PathBuf>> {
    let existing = env
        .get("CODSH_ACP_PATCH")
        .cloned()
        .or_else(|| std::env::var("CODSH_ACP_PATCH").ok())
        .and_then(|path| fs::read_to_string(path).ok())
        .unwrap_or_default();
    if existing.trim().is_empty() {
        return Ok(None);
    }
    let patch_path = config.dsh_home.join("rust-effective.yml");
    if let Some(parent) = patch_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&patch_path, existing)?;
    Ok(Some(patch_path))
}

/// ACP route rows for a saved advertised pair whose id is not in the catalog.
/// Empty when that id was applied as the catalog default, or when CLI or
/// requirements replaced it, so a pin is not rewritten by a stale `acp` value.
fn saved_advertised_route(config: &EffectiveConfig) -> String {
    if config.unmatched_saved_model.is_none() {
        return String::new();
    }
    let overridden = config.settings.iter().any(|setting| {
        setting.key == "models.default" && matches!(setting.source.as_str(), "cli" | "requirements")
    });
    if overridden {
        return String::new();
    }
    let Some(value) = config.saved_acp_value.as_deref() else {
        return String::new();
    };
    let Some((provider, model)) = crate::models::parse_acp_model_value(value) else {
        return String::new();
    };
    format!(
        "- id: acp\n  config:\n    provider: {}\n    model: {}\n- id: agent-default-model\n  config:\n    provider: {}\n    model: {}\n",
        yaml_plain(&provider),
        yaml_plain(&model),
        yaml_plain(&provider),
        yaml_plain(&model),
    )
}

pub fn credential_env(
    config: &EffectiveConfig,
    env: &BTreeMap<String, String>,
) -> Vec<(String, String)> {
    if auth::usable_identity_session(&config.auth, config.auth_session.as_ref()).is_err() {
        return Vec::new();
    }
    let mut extra = Vec::new();
    for model in config.models.values() {
        if extra.iter().any(|(key, _)| key == &model.env_key) {
            continue;
        }
        if let Some(value) = env.get(&model.env_key).filter(|value| !value.is_empty()) {
            extra.push((model.env_key.clone(), value.clone()));
        } else if let Some(key) = &model.api_key {
            extra.push((model.env_key.clone(), key.clone()));
        }
    }
    // A usable identity session is part of execution, not only local auth.json.
    // The spawned dsh process does not inherit GROK_AUTH_*; hand it the token
    // and the provider command the agent core can refresh with.
    if let Some(record) = config
        .auth_session
        .as_ref()
        .filter(|record| auth::usable_identity_session(&config.auth, Some(record)).is_ok())
    {
        let path = auth::auth_json_path(&config.grok_home, env);
        extra.push(("GROK_AUTH_PATH".into(), path.display().to_string()));
        extra.push(("GROK_AUTH_ACCESS_TOKEN".into(), record.access_token.clone()));
        if let Some(command) = env
            .get("GROK_AUTH_PROVIDER_COMMAND")
            .filter(|value| !value.is_empty())
            .cloned()
            .or_else(|| config.auth.provider_command.clone())
        {
            extra.push(("GROK_AUTH_PROVIDER_COMMAND".into(), command));
        }
    }
    extra
}

pub fn web_env(config: &EffectiveConfig) -> Vec<(String, String)> {
    let mut extra = vec![
        (
            "CODSH_WEB_SEARCH".into(),
            if config.web.search.enabled {
                "1".into()
            } else {
                "0".into()
            },
        ),
        (
            "CODSH_WEB_FETCH".into(),
            if config.web.fetch.enabled {
                "1".into()
            } else {
                "0".into()
            },
        ),
        (
            "CODSH_RUST_BIN".into(),
            std::env::current_exe()
                .map(|path| path.display().to_string())
                .unwrap_or_default(),
        ),
        ("GROK_HOME".into(), config.grok_home.display().to_string()),
    ];
    // The plugin only needs the two enablement flags. Policy, domains, and the
    // proxy stay in the `web` command, which reloads config.toml. The credential
    // name is forwarded so the child can copy that one env value.
    if config.web.search.enabled {
        extra.push((
            "CODSH_WEB_SEARCH_KEY_ENV".into(),
            config.web.search.env_key.clone(),
        ));
    }
    // A registered tool-web tool would still be offered to the model. The
    // plain plugin drops web_search / web_fetch from every agent schema.
    if config.web.process_off {
        extra.push(("CODSH_DISABLE_WEB_TOOLS".into(), "1".into()));
    }
    extra
}

pub fn compact_env(config: &EffectiveConfig) -> Vec<(String, String)> {
    let mut extra = Vec::new();
    if let Some(secs) = config.compact_wall_clock_secs {
        extra.push(("GROK_COMPACTION_WALL_CLOCK_SECS".into(), secs.to_string()));
    }
    extra
}

pub fn permission_env(config: &EffectiveConfig) -> Vec<(String, String)> {
    vec![
        (
            "CODSH_PERMISSION_POLICY".into(),
            config
                .dsh_home
                .join(permission::POLICY_FILE_NAME)
                .display()
                .to_string(),
        ),
        (
            "CODSH_WORKSPACE_TRUSTED".into(),
            if config.workspace_trusted {
                "1".into()
            } else {
                "0".into()
            },
        ),
    ]
}

fn generated_settings_yaml(config: &EffectiveConfig) -> Result<String, io::Error> {
    let mut body = format!(
        "{GENERATED_MARKER}\n# source: {}\nllm-pi-ai:\n  providers:\n",
        config.config_path.display()
    );
    let mut by_provider: BTreeMap<String, Vec<&ModelSpec>> = BTreeMap::new();
    for model in config.models.values() {
        if model.unusable_reason.is_some()
            || model.api_backend.is_none()
            || model.base_url.as_ref().is_none_or(|url| url.is_empty())
        {
            continue;
        }
        let group = by_provider.entry(model.provider.clone()).or_default();
        // A provider is one YAML key. Models join it only when the key,
        // backend, URL, and headers are the same. A disagreeing entry would
        // either duplicate the key or silently drop its own credentials.
        let agrees = group.iter().all(|existing| {
            existing.env_key == model.env_key
                && existing.api_backend == model.api_backend
                && existing.base_url == model.base_url
                && existing.extra_headers == model.extra_headers
        });
        if !agrees {
            return Err(io::Error::other(format!(
                "model {} reuses provider {} with a different key, backend, url, or headers; dsh has one block per provider",
                model.id, model.provider
            )));
        }
        group.push(model);
    }
    for (provider, models) in &by_provider {
        let first = models[0];
        let backend = first.api_backend.expect("usable model has a backend");
        let display = if first.name.is_empty() {
            first.id.clone()
        } else {
            first.name.clone()
        };
        body.push_str(&format!(
            "    {}:\n      displayName: {}\n      apiKeyEnv: {}\n      api: {}\n      baseURL: {}\n",
            yaml_plain(provider),
            yaml_quote(&display),
            yaml_plain(&first.env_key),
            yaml_plain(backend.dsh_api()),
            yaml_quote(first.base_url.as_deref().unwrap_or("")),
        ));
        if !first.extra_headers.is_empty() {
            body.push_str("      headers:\n");
            for (key, value) in &first.extra_headers {
                body.push_str(&format!(
                    "        {}: {}\n",
                    yaml_plain(key),
                    yaml_quote(value)
                ));
            }
        }
        if backend == ApiBackend::ChatCompletions
            && models.iter().any(|model| model.supports_reasoning_effort)
        {
            body.push_str("      compat:\n        supportsReasoningEffort: true\n");
        }
        body.push_str("      models:\n");
        for model in models {
            body.push_str(&format!("        - id: {}\n", yaml_plain(&model.model)));
            if !model.name.is_empty() {
                body.push_str(&format!("          name: {}\n", yaml_quote(&model.name)));
            }
            if let Some(window) = model.context_window {
                body.push_str(&format!("          contextWindow: {window}\n"));
            }
            // Only an explicit list is written. Omitting it leaves dsh unable
            // to treat the model as vision-capable.
            if !model.input_modalities.is_empty() {
                let listed = model
                    .input_modalities
                    .iter()
                    .map(|item| yaml_quote(item))
                    .collect::<Vec<_>>()
                    .join(", ");
                body.push_str(&format!("          inputModalities: [{listed}]\n"));
            }
            if model.supports_reasoning_effort {
                body.push_str("          reasoningEfforts:\n");
                for effort in &model.reasoning_efforts {
                    body.push_str(&format!(
                        "            {}: {}\n",
                        yaml_plain(effort),
                        yaml_plain(effort)
                    ));
                }
            } else {
                body.push_str("          reasoningEfforts: false\n");
            }
        }
    }
    if let Some(model) = config.active_model() {
        body.push_str(&format!(
            "agent-default-model:\n  provider: {}\n  model: {}\n",
            yaml_plain(&model.provider),
            yaml_plain(&model.model),
        ));
    }
    Ok(body)
}

fn write_isolated_credential(path: &Path, env_key: &str, value: &str) -> io::Result<()> {
    let quoted = yaml_quote(value);
    let body = match fs::read_to_string(path) {
        Ok(existing) if existing.trim().is_empty() => {
            format!("version: 1\n\nrefs:\n  {env_key}: {quoted}\n")
        }
        Ok(existing) => patch_credential_ref(&existing, env_key, &quoted).map_err(|_| {
            io::Error::other(format!(
                "refusing to overwrite unmanaged credentials file {}",
                path.display()
            ))
        })?,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            format!("version: 1\n\nrefs:\n  {env_key}: {quoted}\n")
        }
        Err(error) => return Err(error),
    };
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

fn patch_credential_ref(existing: &str, env_key: &str, quoted: &str) -> io::Result<String> {
    if !existing.trim_start().starts_with("version:") {
        return Err(io::Error::other(
            "refusing to overwrite unmanaged credentials file",
        ));
    }
    let records_at = top_level_key_offset(existing, "records:");
    let (head, records) = match records_at {
        Some(index) => (&existing[..index], &existing[index..]),
        None => (existing, ""),
    };
    let prefix = format!("{env_key}:");
    let mut lines: Vec<String> = Vec::new();
    let mut in_refs = false;
    let mut replaced = false;
    if !head.contains("refs:") {
        let mut body = head.trim_end().to_string();
        body.push_str("\n\nrefs:\n");
        body.push_str(&format!("  {env_key}: {quoted}\n"));
        if !records.is_empty() {
            if !body.ends_with('\n') {
                body.push('\n');
            }
            body.push_str(records);
        }
        return Ok(body);
    }
    for line in head.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("refs:") {
            in_refs = true;
            lines.push(line.to_string());
            continue;
        }
        if in_refs && trimmed.starts_with(&prefix) {
            let indent_len = line.len() - trimmed.len();
            lines.push(format!("{}{env_key}: {quoted}", &line[..indent_len]));
            replaced = true;
            continue;
        }
        lines.push(line.to_string());
    }
    if !replaced {
        let mut with_insert = Vec::new();
        for line in lines {
            with_insert.push(line.clone());
            if line.trim_start().starts_with("refs:") {
                with_insert.push(format!("  {env_key}: {quoted}"));
            }
        }
        lines = with_insert;
    }
    let mut body = lines.join("\n");
    if !body.ends_with('\n') {
        body.push('\n');
    }
    body.push_str(records);
    Ok(body)
}

fn top_level_key_offset(text: &str, key: &str) -> Option<usize> {
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        if line.starts_with(key) {
            return Some(offset);
        }
        offset += line.len();
    }
    None
}

const KNOWN_POLICY_KEYS: &[&str] = &[
    "models",
    "model",
    "features",
    "folder_trust",
    "fail_closed",
    "cli",
    "endpoints",
    "permission",
    "ui",
    "session",
    "compaction",
    "tools",
    "telemetry",
    "mcp_servers",
    "mcp",
    "disabled_mcp_servers",
    "compat",
    "marketplace",
    "strict_known_marketplaces",
    "extra_known_marketplaces",
    "plugins",
    "hooks",
    "sandbox",
    "campaigns",
    "memory",
    "subagents",
    "auth",
    "force_login_team_uuid",
    "grok_com_config",
    "toolset",
    "disable_web_search",
];

const OVERLAY_ALLOWED: &[&str] = &["models", "model", "features", "auth", "endpoints"];
const OVERLAY_FORBIDDEN: &[&str] = &[
    "folder_trust",
    "permission",
    "hooks",
    "plugins",
    "mcp_servers",
    "fail_closed",
    "endpoints",
    "cli",
    "trusted_folders",
    "grok_com_config",
];

fn read_layer(
    path: &Path,
    role: &str,
    record_missing: bool,
    files: &mut Vec<FileLayer>,
    errors: &mut Vec<ConfigError>,
) -> Option<TomlValue> {
    match fs::read(path) {
        Ok(bytes) => match toml::from_str::<TomlValue>(&String::from_utf8_lossy(&bytes)) {
            Ok(parsed) => {
                files.push(FileLayer {
                    path: path.to_path_buf(),
                    role: role.into(),
                    status: "ok".into(),
                });
                Some(parsed)
            }
            Err(error) => {
                files.push(FileLayer {
                    path: path.to_path_buf(),
                    role: role.into(),
                    status: "invalid".into(),
                });
                errors.push(ConfigError {
                    path: Some(path.to_path_buf()),
                    reason: error.to_string(),
                });
                None
            }
        },
        Err(error) if error.kind() == ErrorKind::NotFound => {
            if record_missing {
                files.push(FileLayer {
                    path: path.to_path_buf(),
                    role: role.into(),
                    status: "missing".into(),
                });
            }
            None
        }
        Err(error) => {
            errors.push(ConfigError {
                path: Some(path.to_path_buf()),
                reason: error.to_string(),
            });
            None
        }
    }
}

fn diagnose_unknown_security(
    table: Option<&TomlValue>,
    path: Option<&Path>,
    source: &str,
    fail_closed: bool,
    errors: &mut Vec<ConfigError>,
    warnings: &mut Vec<String>,
) {
    let Some(root) = table.and_then(TomlValue::as_table) else {
        return;
    };
    for key in root.keys() {
        if KNOWN_POLICY_KEYS.contains(&key.as_str()) {
            continue;
        }
        let valid = KNOWN_POLICY_KEYS.join(", ");
        let reason = format!(
            "unknown security/policy field `{key}` in {source} is not silently ignored. Valid top-level keys: {valid}. Locked requirements still win over CLI, environment, overlay, workspace, and user config."
        );
        if fail_closed || source == "requirements" {
            errors.push(ConfigError {
                path: path.map(Path::to_path_buf),
                reason,
            });
        } else {
            warnings.push(reason);
        }
    }
}

fn diagnose_invalid_policy(
    table: Option<&TomlValue>,
    path: Option<&Path>,
    source: &str,
    errors: &mut Vec<ConfigError>,
) {
    let Some(root) = table else {
        return;
    };
    if let Some(value) = root.get("fail_closed")
        && bool_from_toml(Some(value)).is_none()
    {
        errors.push(ConfigError {
            path: path.map(Path::to_path_buf),
            reason: format!(
                "invalid fail_closed in {source}: expected boolean true/false. Environment GROK_MANAGED_CONFIG_FAIL_CLOSED can only tighten an admin true, never weaken it."
            ),
        });
    }
    if let Some(value) = root
        .get("folder_trust")
        .and_then(|folder| folder.get("enabled"))
        && bool_from_toml(Some(value)).is_none()
    {
        errors.push(ConfigError {
            path: path.map(Path::to_path_buf),
            reason: format!(
                "invalid folder_trust.enabled in {source}: expected boolean. Valid sources: requirements (lock), GROK_FOLDER_TRUST, config.toml, managed_config.toml, default true."
            ),
        });
    }
    if let Some(value) = root
        .get("features")
        .and_then(|features| features.get("remote_fetch"))
        && bool_from_toml(Some(value)).is_none()
    {
        errors.push(ConfigError {
            path: path.map(Path::to_path_buf),
            reason: format!(
                "invalid features.remote_fetch in {source}: expected boolean. A locked false cannot be enabled by later CLI, environment, overlay, or workspace values."
            ),
        });
    }
}

fn confine_overlay(
    value: TomlValue,
    fail_closed: bool,
    warnings: &mut Vec<String>,
    errors: &mut Vec<ConfigError>,
) -> Option<TomlValue> {
    let TomlValue::Table(table) = value else {
        return Some(value);
    };
    let mut confined = toml::map::Map::new();
    for (key, item) in table {
        if key == "sandbox" {
            // sandbox.profile is a real config key (guide 26), not a soft
            // model setting and not a forbidden escalation table. Keep only
            // the profile string; auto_allow_bash stays with permission.
            if let Some(profile) = item
                .get("profile")
                .and_then(TomlValue::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let mut sandbox = toml::map::Map::new();
                sandbox.insert("profile".into(), TomlValue::String(profile.to_string()));
                confined.insert(key, TomlValue::Table(sandbox));
            }
        } else if OVERLAY_FORBIDDEN.contains(&key.as_str()) {
            let reason = format!(
                "GROK_CONFIG cannot set `{key}`; overlay allowlist is {}. Trust, permission, hooks, plugins, and endpoints stay on disk requirements/managed layers.",
                OVERLAY_ALLOWED.join(", ")
            );
            if fail_closed {
                errors.push(ConfigError {
                    path: Some(PathBuf::from("GROK_CONFIG")),
                    reason,
                });
            } else {
                warnings.push(reason);
            }
        } else if OVERLAY_ALLOWED.contains(&key.as_str()) {
            confined.insert(key, item);
        } else {
            warnings.push(format!(
                "GROK_CONFIG ignored `{key}`; valid overlay keys: {}.",
                OVERLAY_ALLOWED.join(", ")
            ));
        }
    }
    Some(TomlValue::Table(confined))
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
                for field in [
                    "name",
                    "model",
                    "base_url",
                    "env_key",
                    "api_key",
                    "api_backend",
                    "context_window",
                    "supports_reasoning_effort",
                    "reasoning_efforts",
                    "reasoning_effort",
                    "extra_headers",
                ] {
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
    if table
        .get("models")
        .and_then(|models| models.get("default_reasoning_effort"))
        .is_some()
    {
        sources.insert("models.default_reasoning_effort".into(), source.into());
    }
    if table
        .get("features")
        .and_then(|features| features.get("remote_fetch"))
        .is_some()
    {
        sources.insert("features.remote_fetch".into(), source.into());
    }
    if table
        .get("folder_trust")
        .and_then(|folder| folder.get("enabled"))
        .is_some()
    {
        sources.insert("folder_trust.enabled".into(), source.into());
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
    let env_key = parse_env_key(table.get("env_key")).unwrap_or_else(|| "XAI_API_KEY".into());
    let api_key = table
        .get("api_key")
        .and_then(TomlValue::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty());
    let api_backend_raw = table
        .get("api_backend")
        .and_then(TomlValue::as_str)
        .unwrap_or("chat_completions")
        .to_string();
    let api_backend = ApiBackend::parse(Some(&api_backend_raw)).ok();
    let unusable_reason = if api_backend.is_none() {
        Some(format!(
            "unsupported api_backend {api_backend_raw} for model {id}; not treated as chat_completions"
        ))
    } else {
        None
    };
    let context_window = table.get("context_window").and_then(|value| match value {
        TomlValue::Integer(number) if *number > 0 => Some(*number as u64),
        TomlValue::String(text) => text.parse().ok(),
        _ => None,
    });
    let supports_explicit = bool_from_toml(table.get("supports_reasoning_effort"));
    let reasoning_efforts = parse_effort_list(table.get("reasoning_efforts"));
    let supports_reasoning_effort = supports_explicit.unwrap_or(!reasoning_efforts.is_empty());
    let reasoning_efforts = if supports_reasoning_effort && reasoning_efforts.is_empty() {
        GROK_EFFORTS
            .iter()
            .map(|value| (*value).to_string())
            .collect()
    } else if supports_reasoning_effort {
        reasoning_efforts
    } else {
        Vec::new()
    };
    let reasoning_effort = table
        .get("reasoning_effort")
        .and_then(TomlValue::as_str)
        .and_then(normalize_effort);
    let extra_headers = parse_string_map(table.get("extra_headers"));
    let provider = table
        .get("provider")
        .and_then(TomlValue::as_str)
        .filter(|value| !value.is_empty())
        .map(provider_id)
        .unwrap_or_else(|| provider_id(id));
    Some(ModelSpec {
        provider,
        id: id.to_string(),
        name,
        model,
        base_url,
        env_key,
        api_key_set: api_key.is_some(),
        api_key,
        api_backend,
        api_backend_raw,
        context_window,
        supports_reasoning_effort,
        reasoning_efforts,
        reasoning_effort,
        extra_headers,
        input_modalities: parse_modalities(table.get("input_modalities")),
        unusable_reason,
    })
}

fn parse_modalities(value: Option<&TomlValue>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let raw: Vec<String> = match value {
        TomlValue::Array(items) => items
            .iter()
            .filter_map(TomlValue::as_str)
            .map(str::to_string)
            .collect(),
        TomlValue::String(text) => text
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    };
    raw.into_iter()
        .map(|item| item.to_ascii_lowercase())
        .filter(|item| item == "text" || item == "image")
        .collect()
}

fn parse_env_key(value: Option<&TomlValue>) -> Option<String> {
    match value? {
        TomlValue::String(text) if !text.is_empty() => Some(text.clone()),
        TomlValue::Array(items) => items
            .iter()
            .filter_map(TomlValue::as_str)
            .find(|text| !text.is_empty())
            .map(str::to_string),
        _ => None,
    }
}

fn parse_effort_list(value: Option<&TomlValue>) -> Vec<String> {
    match value {
        Some(TomlValue::Array(items)) => items
            .iter()
            .filter_map(TomlValue::as_str)
            .filter_map(normalize_effort)
            .collect(),
        Some(TomlValue::Table(table)) => table
            .keys()
            .filter_map(|key| normalize_effort(key))
            .collect(),
        Some(TomlValue::String(text)) => text.split(',').filter_map(normalize_effort).collect(),
        Some(TomlValue::Boolean(false)) => Vec::new(),
        _ => Vec::new(),
    }
}

fn parse_string_map(value: Option<&TomlValue>) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    if let Some(table) = value.and_then(TomlValue::as_table) {
        for (key, item) in table {
            if let Some(text) = item.as_str() {
                map.insert(key.clone(), text.to_string());
            }
        }
    }
    map
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

/// A vendor skill cell defaults on. The matching environment variable wins.
fn compat_surface(cell: Option<bool>, env: Option<&String>) -> bool {
    env_bool(env).or(cell).unwrap_or(true)
}

fn bool_from_toml(value: Option<&TomlValue>) -> Option<bool> {
    match value? {
        TomlValue::Boolean(flag) => Some(*flag),
        TomlValue::String(text) => env_bool(Some(text)),
        _ => None,
    }
}

fn public_endpoint(url: Option<&str>) -> Option<String> {
    match url {
        Some(value) if crate::privacy::is_official_endpoint(value) => {
            Some("(refused official endpoint)".into())
        }
        Some(value) => Some(value.to_string()),
        None => None,
    }
}

fn push_endpoint(settings: &mut Vec<Setting>, key: &str, url: Option<&str>) {
    match url {
        Some(value) if crate::privacy::is_official_endpoint(value) => {
            push_setting(settings, key, "(refused official endpoint)", "refused");
        }
        Some(value) => push_setting(settings, key, value, "config.toml"),
        None => push_setting(settings, key, "(unset)", "default"),
    }
}

fn optional_url(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn env_bool(value: Option<&String>) -> Option<bool> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" | "enabled" => Some(true),
        "0" | "false" | "no" | "off" | "disabled" => Some(false),
        _ => None,
    }
}

/// Opt-in privacy switch. A requested upload stays off until a non-official
/// substitute destination exists. Locked requirements can force the switch off
/// but cannot force an upload to an unconfigured or official host.
fn resolve_privacy(
    requested: bool,
    source: &str,
    destination: Option<&str>,
    locked_off: bool,
) -> (bool, String) {
    if locked_off {
        return (false, "requirements".into());
    }
    if !requested {
        let label = if source == "default" {
            "default".into()
        } else {
            source.to_string()
        };
        return (false, label);
    }
    match destination.map(str::trim).filter(|value| !value.is_empty()) {
        Some(url) if crate::privacy::is_official_endpoint(url) => {
            (false, "refused-official-endpoint".into())
        }
        Some(_) => (true, "opt-in".into()),
        None => (false, "disabled-no-destination".into()),
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
    use base64::Engine;
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
            cli_effort: None,
            cli_trust: false,
            cli_revoke_trust: false,
            cli_trust_path: None,
            interactive: true,
            cli_permission_mode: None,
            cli_always_approve: false,
            cli_auto: false,
            cli_allow: Vec::new(),
            cli_deny: Vec::new(),
            cli_no_memory: false,
            cli_sandbox: None,
            cli_disable_web_search: false,
            cli_subagents: Default::default(),
        }
    }

    fn write_config(input: &LoadInput, body: &str) {
        fs::create_dir_all(input.grok_home.clone().unwrap()).unwrap();
        fs::write(input.grok_home.clone().unwrap().join("config.toml"), body).unwrap();
    }

    fn setting<'a>(config: &'a EffectiveConfig, key: &str) -> Option<(&'a str, &'a str)> {
        config
            .settings
            .iter()
            .find(|setting| setting.key == key)
            .map(|setting| (setting.value.as_str(), setting.source.as_str()))
    }

    #[test]
    fn web_search_and_fetch_policy_is_explicit_and_session_scoped() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        write_config(
            &load,
            r#"
[models]
default = "gateway"
web_search = "search-model"

[model.gateway]
model = "mock-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"

[model.search-model]
model = "search-model"
base_url = "http://search.example/v1"
env_key = "SEARCH_API_KEY"
supports_backend_search = true

[features]
web_fetch = true

[toolset.web_search]
allowed_domains = ["docs.example"]
excluded_domains = ["blocked.example"]

[toolset.web_fetch]
proxy_endpoint = "http://proxy.example:8080"
allowed_domains = ["docs.example"]
allow_local = false
"#,
        );
        load.env.insert("XAI_API_KEY".into(), "present".into());
        load.env.insert("SEARCH_API_KEY".into(), "present".into());
        let config = load_from(load);
        assert!(config.ready, "{}", config.first_run_message());
        assert_eq!(
            setting(&config, "features.web_fetch"),
            Some(("true", "config.toml"))
        );
        assert_eq!(
            setting(&config, "models.web_search"),
            Some(("search-model", "config.toml"))
        );
        assert_eq!(
            setting(&config, "toolset.web_search.allowed_domains"),
            Some(("docs.example", "config.toml"))
        );
        assert_eq!(
            setting(&config, "toolset.web_search.excluded_domains"),
            Some(("(dropped; allowlist wins)", "config.toml"))
        );
        assert!(
            config
                .warnings
                .iter()
                .any(|warning| warning.contains("allowlist wins"))
        );
        assert_eq!(
            setting(&config, "toolset.web_fetch.allowed_domains"),
            Some(("docs.example", "config.toml"))
        );
        assert_eq!(
            setting(&config, "toolset.web_fetch.proxy_endpoint"),
            Some(("http://proxy.example:8080", "config.toml"))
        );
        assert_eq!(
            setting(&config, "toolset.web_fetch.allow_local"),
            Some(("false", "config.toml"))
        );
        let inspect = inspect_json(&config);
        assert!(inspect.contains("\"webSearchEnabled\": true"));
        assert!(inspect.contains("\"webFetchEnabled\": true"));
        assert!(inspect.contains("search-model"));
        assert!(inspect.contains("http://proxy.example:8080"));
        assert!(!inspect.contains("present"));
        assert!(config.web.search.allowed_domains == vec!["docs.example"]);
        assert!(config.web.search.excluded_domains.is_empty());
        assert!(!config.web.fetch.allow_local);
        assert_eq!(
            config.web.fetch.proxy_endpoint.as_deref(),
            Some("http://proxy.example:8080")
        );
    }

    #[test]
    fn managed_only_web_settings_are_not_labeled_config_toml() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        let grok = load.grok_home.clone().unwrap();
        fs::create_dir_all(&grok).unwrap();
        fs::write(
            grok.join("managed_config.toml"),
            r#"
[models]
web_search = "managed-search"

[model.managed-search]
model = "managed-search"
base_url = "http://search.example/v1"
env_key = "SEARCH_API_KEY"
supports_backend_search = true

[features]
web_fetch = true

[toolset.web_search]
allowed_domains = ["docs.example"]

[toolset.web_fetch]
allowed_domains = ["docs.example"]
"#,
        )
        .unwrap();
        load.env.insert("SEARCH_API_KEY".into(), "present".into());
        let config = load_from(load);
        assert_eq!(
            setting(&config, "models.web_search"),
            Some(("managed-search", "managed"))
        );
        assert_eq!(
            setting(&config, "toolset.web_search.allowed_domains"),
            Some(("docs.example", "managed"))
        );
        assert_eq!(
            setting(&config, "features.web_fetch"),
            Some(("true", "managed"))
        );
        assert_eq!(
            setting(&config, "toolset.web_fetch.allowed_domains"),
            Some(("docs.example", "managed"))
        );
        assert!(config.web.search.enabled);
        assert_eq!(
            config.web.fetch.allowed_domains.as_deref(),
            Some(["docs.example".to_string()].as_slice())
        );
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
        assert!(inspect.contains("\"theme\": \"groknight\""));
        assert!(inspect.contains("\"statusLine\": \"disabled\""));
        assert!(inspect.contains("\"sessionTransferredToExternalServices\": false"));
        assert_eq!(config.auth.method, crate::auth::AuthMethod::ApiKey);
    }

    #[test]
    fn appearance_inspect_reports_locked_theme() {
        let dir = TempDir::new().unwrap();
        let load = input(&dir);
        write_config(
            &load,
            "[ui]\ntheme = \"grokday\"\n[ui.status_line]\ntype = \"builtin\"\n",
        );
        fs::write(
            load.grok_home.clone().unwrap().join("requirements.toml"),
            "[ui]\ntheme = \"groknight\"\n",
        )
        .unwrap();
        let config = load_from(load);
        let settings: BTreeMap<_, _> = config
            .settings
            .iter()
            .map(|row| (row.key.clone(), row.clone()))
            .collect();
        assert_eq!(settings["ui.theme"].value, "groknight");
        assert_eq!(settings["ui.theme"].source, "requirements");
        assert_eq!(settings["ui.theme.lock"].value, "requirements");
        assert_eq!(settings["ui.status_line.type"].value, "builtin");
        let err = appearance::apply_setting(&mut config.appearance.clone(), "ui.theme", "grokday")
            .unwrap_err();
        assert!(err.contains("locked"), "{err}");
    }

    #[test]
    fn session_token_is_not_injected_as_model_credential() {
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
        let grok = load.grok_home.clone().unwrap();
        fs::create_dir_all(&grok).unwrap();
        fs::write(
            grok.join("auth.json"),
            r#"{"access_token":"identity-session","method":"external"}"#,
        )
        .unwrap();
        let config = load_from(load.clone());
        assert_eq!(
            config
                .auth_session
                .as_ref()
                .map(|record| record.access_token.as_str()),
            Some("identity-session")
        );
        let extra = credential_env(&config, &load.env);
        assert!(
            extra.iter().all(|(key, _)| key.starts_with("GROK_AUTH_")),
            "identity token must not become a model credential: {extra:?}"
        );
        assert!(
            !extra
                .iter()
                .any(|(key, value)| key == "XAI_API_KEY" && value == "identity-session")
        );
        assert!(!config.ready);
        assert!(!inspect_json(&config).contains("identity-session"));
    }

    #[test]
    fn organization_pin_refuses_api_key_ready_until_matching_session() {
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
            "XAI_API_KEY".into(),
            "test-key-not-a-secret-for-logs".into(),
        );
        load.env
            .insert("GROK_DISABLE_API_KEY_AUTH".into(), "1".into());
        let blocked = load_from(load.clone());
        assert!(!blocked.ready);
        assert!(blocked.auth.disable_api_key_auth);
        assert!(inspect_json(&blocked).contains("\"disableApiKeyAuth\": true"));
        assert!(credential_env(&blocked, &load.env).is_empty());
        assert!(
            blocked
                .first_run_message()
                .contains("disables API-key authentication")
        );
        assert!(!blocked.blocks_auth_command());

        load.env
            .insert("GROK_FORCE_LOGIN_TEAM_ID".into(), "[]".into());
        let empty = load_from(load.clone());
        assert!(!empty.ready);
        assert!(credential_env(&empty, &load.env).is_empty());
        assert_eq!(
            empty
                .auth
                .force_login_team
                .as_ref()
                .map(|team| team.teams.clone()),
            Some(Vec::new())
        );

        let grok = load.grok_home.clone().unwrap();
        fs::create_dir_all(&grok).unwrap();
        let locked_requirements = "\
fail_closed = true
[auth]
disable_api_key_auth = true
force_login_team_uuid = \"team-good\"
";
        fs::write(grok.join("requirements.toml"), locked_requirements).unwrap();
        load.env.remove("GROK_DISABLE_API_KEY_AUTH");
        load.env.remove("GROK_FORCE_LOGIN_TEAM_ID");
        let locked = load_from(load.clone());
        assert!(locked.auth.disable_api_key_auth);
        assert_eq!(
            locked
                .auth
                .force_login_team
                .as_ref()
                .map(|team| team.teams.clone()),
            Some(vec!["team-good".into()])
        );
        assert!(!locked.ready);
        assert!(credential_env(&locked, &load.env).is_empty());
        assert!(
            !locked
                .errors
                .iter()
                .any(|error| error.reason.contains("unknown security/policy field"))
        );

        let top_requirements = "\
fail_closed = true
force_login_team_uuid = \"team-good\"
";
        fs::write(grok.join("requirements.toml"), top_requirements).unwrap();
        let top_level = load_from(load.clone());
        assert!(top_level.auth.disable_api_key_auth);
        assert_eq!(
            top_level
                .auth
                .force_login_team
                .as_ref()
                .map(|team| team.teams.clone()),
            Some(vec!["team-good".into()])
        );
        assert!(!top_level.ready);
        assert!(credential_env(&top_level, &load.env).is_empty());
        assert!(!top_level.blocks_auth_command());

        fs::write(
            grok.join("auth.json"),
            r#"{"access_token":"sess","method":"oidc","team_id":"team-good"}"#,
        )
        .unwrap();
        // The same fail-closed file is now verifiable, so the matching
        // session is what makes the pin ready rather than an absent sidecar.
        let signing = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let payload = json!({
            "typ": "managed-policy",
            "expires_at": crate::auth::now_unix() + 3600,
            "team_id": "team-good",
            "managed_config": "",
            "requirements": top_requirements,
        })
        .to_string();
        let signature = ed25519_dalek::Signer::sign(&signing, payload.as_bytes());
        fs::write(
            grok.join(crate::auth::SIGNATURE_SIDECAR),
            json!({
                "signed_payload": payload,
                "signature": base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
            })
            .to_string(),
        )
        .unwrap();
        load.env.insert(
            "GROK_MANAGED_CONFIG_PUBKEY".into(),
            base64::engine::general_purpose::STANDARD.encode(signing.verifying_key().to_bytes()),
        );
        let allowed_env = load.env.clone();
        let allowed = load_from(load);
        assert!(allowed.ready);
        assert!(!credential_env(&allowed, &allowed_env).is_empty());
        assert_eq!(
            allowed
                .auth_session
                .as_ref()
                .and_then(|record| record.team_id.as_deref()),
            Some("team-good")
        );
    }

    #[test]
    fn identity_session_is_handed_to_the_executing_core() {
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
        load.env.insert("XAI_API_KEY".into(), "test-key".into());
        load.env
            .insert("GROK_DISABLE_API_KEY_AUTH".into(), "1".into());
        load.env.insert(
            "GROK_AUTH_PROVIDER_COMMAND".into(),
            "printf '%s' '{\"access_token\":\"handed\"}'".into(),
        );
        let grok = load.grok_home.clone().unwrap();
        fs::create_dir_all(&grok).unwrap();
        fs::write(
            grok.join("auth.json"),
            r#"{"access_token":"handed-token","method":"external","issuer":"https://idp.example"}"#,
        )
        .unwrap();
        let config = load_from(load.clone());
        assert!(config.ready, "{:?}", config.errors);
        let extra = credential_env(&config, &load.env);
        let keys: Vec<&str> = extra.iter().map(|(key, _)| key.as_str()).collect();
        assert!(
            keys.iter().any(|key| {
                *key == "GROK_AUTH_PATH"
                    || *key == "GROK_AUTH_ACCESS_TOKEN"
                    || *key == "GROK_AUTH_PROVIDER_COMMAND"
            }),
            "dsh child must receive the identity session, got {keys:?}"
        );
        assert!(
            extra.iter().any(|(_, value)| value.contains("handed")),
            "identity token must be present for the agent core, got {extra:?}"
        );
    }

    #[test]
    fn expired_pinned_session_is_refreshed_or_cleared_on_load() {
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
        load.env.insert("XAI_API_KEY".into(), "present".into());
        load.env
            .insert("GROK_FORCE_LOGIN_TEAM_ID".into(), "team-good".into());
        load.env
            .insert("GROK_AUTH_EARLY_INVALIDATION_SECS".into(), "0".into());
        let grok = load.grok_home.clone().unwrap();
        fs::create_dir_all(&grok).unwrap();
        let expired = json!({
            "access_token": "expired-token",
            "method": "oidc",
            "team_id": "team-good",
            "expires_at": 1,
        });
        fs::write(grok.join("auth.json"), expired.to_string()).unwrap();
        let stale = load_from(load.clone());
        assert!(!stale.ready, "expired auth.json must not stay ready");
        assert!(stale.auth_session.is_none());
        assert!(
            !grok.join("auth.json").exists(),
            "unrefreshable expiry is cleared"
        );
        assert!(
            !stale.blocks_auth_command(),
            "a cleared expiry must not stop `codsh --rust login`"
        );
        assert!(
            stale
                .warnings
                .iter()
                .any(|warning| warning.to_ascii_lowercase().contains("expired"))
        );
        assert!(
            !stale
                .errors
                .iter()
                .any(|error| error.reason.to_ascii_lowercase().contains("expired"))
        );

        // parse_token_output reads team only from the access token, not a
        // sibling JSON field. This payload is {"team_id":"team-good"}.
        let team_jwt = "e30.eyJ0ZWFtX2lkIjoidGVhbS1nb29kIn0";
        let refresh =
            format!("printf '%s' '{{\"access_token\":\"{team_jwt}\",\"expires_in\":3600}}'");
        fs::write(grok.join("auth.json"), expired.to_string()).unwrap();
        load.env
            .insert("GROK_AUTH_PROVIDER_COMMAND".into(), refresh);
        let renewed = load_from(load);
        assert!(renewed.ready);
        assert_eq!(
            renewed
                .auth_session
                .as_ref()
                .map(|record| record.access_token.as_str()),
            Some(team_jwt)
        );
        assert_eq!(
            renewed
                .auth_session
                .as_ref()
                .and_then(|record| record.team_id.as_deref()),
            Some("team-good")
        );
        assert!(
            fs::read_to_string(grok.join("auth.json"))
                .unwrap()
                .contains(team_jwt)
        );
    }

    #[test]
    fn expired_unrefreshable_auth_does_not_block_login_or_api_key() {
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
        load.env.insert("XAI_API_KEY".into(), "present".into());
        load.env
            .insert("GROK_AUTH_EARLY_INVALIDATION_SECS".into(), "0".into());
        let grok = load.grok_home.clone().unwrap();
        fs::create_dir_all(&grok).unwrap();
        fs::write(
            grok.join("auth.json"),
            json!({
                "access_token": "expired-token",
                "method": "oidc",
                "expires_at": 1,
            })
            .to_string(),
        )
        .unwrap();
        let recovered = load_from(load);
        assert!(
            recovered.ready,
            "a cleared expired session must not block an independent API key"
        );
        assert!(recovered.auth_session.is_none());
        assert!(!grok.join("auth.json").exists());
        assert!(
            !recovered.blocks_auth_command(),
            "login must still run after an unrefreshable expiry: {}",
            recovered.first_run_message()
        );
        assert!(
            !recovered
                .errors
                .iter()
                .any(|error| error.reason.to_ascii_lowercase().contains("expired")),
            "cleared expiry is a warning, not a fatal config error: {:?}",
            recovered.errors
        );
    }

    #[test]
    fn requirements_lock_simple_mode_and_prompt_suggestions() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        let grok = load.grok_home.clone().unwrap();
        fs::create_dir_all(&grok).unwrap();
        fs::write(
            grok.join("config.toml"),
            "[ui]\nsimple_mode = true\nprompt_suggestions = true\n",
        )
        .unwrap();
        fs::write(
            grok.join("managed_config.toml"),
            "[ui]\nsimple_mode = true\nprompt_suggestions = true\n",
        )
        .unwrap();
        fs::write(
            grok.join("requirements.toml"),
            "[ui]\nsimple_mode = false\nprompt_suggestions = false\n",
        )
        .unwrap();
        load.env
            .insert("GROK_PROMPT_SUGGESTIONS".into(), "true".into());
        let config = load_from(load);
        assert!(!config.simple_mode);
        assert!(!config.prompt_suggestions);
        assert_eq!(
            config
                .settings
                .iter()
                .find(|setting| setting.key == "ui.simple_mode")
                .map(|setting| (setting.value.as_str(), setting.source.as_str())),
            Some(("false", "requirements"))
        );
        assert_eq!(
            config
                .settings
                .iter()
                .find(|setting| setting.key == "ui.prompt_suggestions")
                .map(|setting| (setting.value.as_str(), setting.source.as_str())),
            Some(("false", "requirements"))
        );
        let inspect = inspect_json(&config);
        assert!(inspect.contains("\"simpleMode\": false"));
        assert!(inspect.contains("\"promptSuggestions\": false"));
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
        assert_eq!(yaml.matches("    gateway:").count(), 1);

        let dir = TempDir::new().unwrap();
        let mut shared = input(&dir);
        write_config(
            &shared,
            r#"
[models]
default = "vision"

[model.vision]
name = "Vision"
provider = "cli-mock"
model = "cli-mock"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
input_modalities = ["text", "image"]

[model.fork]
name = "Fork"
provider = "cli-mock"
model = "cli-mock-fork"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
input_modalities = ["text"]
"#,
        );
        shared.env.insert("XAI_API_KEY".into(), "test-key".into());
        let shared_config = load_from(shared.clone());
        apply_to_dsh(&shared_config, &shared.env).unwrap();
        let shared_yaml = fs::read_to_string(&shared_config.settings_yaml).unwrap();
        assert_eq!(
            shared_yaml.matches("    cli-mock:").count(),
            1,
            "{shared_yaml}"
        );
        assert!(shared_yaml.contains("id: cli-mock\n"), "{shared_yaml}");
        assert!(shared_yaml.contains("id: cli-mock-fork\n"), "{shared_yaml}");

        let dir = TempDir::new().unwrap();
        let mut clash = input(&dir);
        write_config(
            &clash,
            r#"
[models]
default = "vision"

[model.vision]
provider = "cli-mock"
model = "cli-mock"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"

[model.other]
provider = "cli-mock"
model = "other"
base_url = "http://127.0.0.1:10/v1"
env_key = "XAI_API_KEY"
"#,
        );
        clash.env.insert("XAI_API_KEY".into(), "test-key".into());
        let clash_config = load_from(clash.clone());
        let clash_error = apply_to_dsh(&clash_config, &clash.env).unwrap_err();
        assert!(
            clash_error.to_string().contains("reuses provider"),
            "{clash_error}"
        );

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
    fn credential_write_patches_one_ref_and_keeps_records() {
        let dir = TempDir::new().unwrap();
        let load = input(&dir);
        let path = load.dsh_home.join(".credentials.yaml");
        fs::write(
            &path,
            "version: 1\n\nrefs:\n  OPENAI_API_KEY: keep-me\n\nrecords:\n  llm-pi-ai/openai-codex:\n    kind: grant\n    payload:\n      type: oauth\n      access: keep-this\n",
        )
        .unwrap();
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
        apply_to_dsh(&config, &load.env).unwrap();
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.contains("OPENAI_API_KEY: keep-me"));
        assert!(body.contains("XAI_API_KEY:"));
        assert!(body.contains("records:"));
        assert!(body.contains("llm-pi-ai/openai-codex:"));
        assert!(body.contains("access: keep-this"));
        assert!(body.contains("kind: grant"));
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
        assert!(
            !config.telemetry,
            "opt-in telemetry without a configured destination must stay off"
        );
        assert!(!config.trace_upload);
        assert_eq!(
            config
                .settings
                .iter()
                .find(|setting| setting.key == "features.telemetry")
                .map(|setting| (setting.value.as_str(), setting.source.as_str())),
            Some(("false", "disabled-no-destination"))
        );
        assert_eq!(
            config
                .settings
                .iter()
                .find(|setting| setting.key == "features.trace_upload")
                .map(|setting| (setting.value.as_str(), setting.source.as_str())),
            Some(("false", "disabled-no-destination"))
        );
        assert!(inspect_json(&config).contains("\"telemetry\": false"));
        assert!(inspect_text(&config).contains("Model calls use the configured provider"));
    }

    #[test]
    fn opt_in_telemetry_requires_a_substitute_destination_and_respects_locks() {
        let dir = TempDir::new().unwrap();
        let load = input(&dir);
        write_config(
            &load,
            r#"
[features]
telemetry = true
feedback = true
trace_upload = true

[privacy]
share_content = true
share_session = true

[endpoints]
telemetry_url = "http://127.0.0.1:9/telemetry"
feedback_base_url = "http://127.0.0.1:9/feedback"
trace_upload_url = "https://api.x.ai/traces"
"#,
        );
        let config = load_from(load.clone());
        assert!(config.telemetry);
        assert!(config.feedback);
        assert!(!config.trace_upload);
        assert!(config.share_content);
        assert!(config.share_session);
        let row = |key: &str| {
            config
                .settings
                .iter()
                .find(|setting| setting.key == key)
                .map(|setting| (setting.value.as_str(), setting.source.as_str()))
        };
        assert_eq!(row("features.telemetry"), Some(("true", "opt-in")));
        assert_eq!(
            row("features.trace_upload"),
            Some(("false", "refused-official-endpoint"))
        );
        assert!(
            config
                .warnings
                .iter()
                .any(|warning| warning.contains("official"))
        );

        fs::write(
            load.grok_home.clone().unwrap().join("requirements.toml"),
            "[features]\ntelemetry = false\nfeedback = false\n",
        )
        .unwrap();
        let locked = load_from(load);
        assert!(!locked.telemetry);
        assert!(!locked.feedback);
        assert_eq!(
            locked
                .settings
                .iter()
                .find(|setting| setting.key == "features.telemetry")
                .map(|setting| setting.source.as_str()),
            Some("requirements")
        );
        assert!(
            locked
                .settings
                .iter()
                .any(|setting| setting.key == "features.telemetry.lock")
        );
    }

    #[test]
    fn distinct_backends_and_efforts_map_into_dsh_without_silent_fallback() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        write_config(
            &load,
            r#"
[models]
default = "chat"
default_reasoning_effort = "high"

[model.chat]
name = "Shared name"
model = "shared-name"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
api_backend = "chat_completions"
supports_reasoning_effort = true
reasoning_efforts = ["low", "high"]
context_window = 128000

[model.messages]
name = "Shared name"
model = "shared-name"
base_url = "http://127.0.0.1:9/v1"
env_key = "ANTHROPIC_API_KEY"
api_backend = "messages"
supports_reasoning_effort = false

[model.responses]
name = "Shared name"
model = "shared-name"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
api_backend = "responses"
supports_reasoning_effort = true
reasoning_efforts = ["low", "high"]

[model.mystery]
model = "shared-name"
base_url = "http://127.0.0.1:9/v1"
api_backend = "mystery-protocol"
env_key = "XAI_API_KEY"
"#,
        );
        load.env.insert("XAI_API_KEY".into(), "test-key".into());
        load.env
            .insert("ANTHROPIC_API_KEY".into(), "ant-key".into());
        let config = load_from(load.clone());
        assert_eq!(config.default_model.as_deref(), Some("chat"));
        assert_eq!(config.default_effort.as_deref(), Some("high"));
        let yaml = apply_to_dsh(&config, &load.env).unwrap();
        let _ = yaml;
        let generated = fs::read_to_string(&config.settings_yaml).unwrap();
        assert!(generated.contains("api: openai-completions"));
        assert!(generated.contains("api: openai-responses"));
        assert!(generated.contains("api: anthropic-messages"));
        assert!(generated.contains("contextWindow: 128000"));
        assert!(generated.contains("reasoningEfforts:\n            low: low"));
        assert!(generated.contains("reasoningEfforts: false"));
        assert!(!generated.contains("mystery-protocol"));
        assert!(generated.matches("shared-name").count() >= 2);
        let inspect = inspect_json(&config);
        assert!(inspect.contains("openai-completions"));
        assert!(inspect.contains("openai-responses"));
        assert!(inspect.contains("anthropic-messages"));
        assert!(inspect.contains("unavailable"));
        assert!(!inspect.contains("ant-key"));
        load.cli_effort = Some("xhigh".into());
        let rejected = load_from(load);
        assert!(!rejected.ready);
        assert!(
            rejected
                .errors
                .iter()
                .any(|error| error.reason.contains("unsupported effort"))
        );
    }

    #[test]
    fn saved_selection_restores_model_and_effort() {
        let dir = TempDir::new().unwrap();
        let load = input(&dir);
        write_config(
            &load,
            r#"
[models]
default = "plain"
default_reasoning_effort = "high"

[model.plain]
model = "plain-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
supports_reasoning_effort = false

[model.think]
model = "think-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
supports_reasoning_effort = true
reasoning_efforts = ["low", "high"]
"#,
        );
        crate::models::save_selection(&load.grok_home.clone().unwrap(), "think", Some("low"))
            .unwrap();
        let mut keyed = load;
        keyed.env.insert("XAI_API_KEY".into(), "test-key".into());
        let config = load_from(keyed.clone());
        assert_eq!(config.default_model.as_deref(), Some("think"));
        assert_eq!(config.default_effort.as_deref(), Some("low"));
        crate::models::save_selection(&config.grok_home, "plain", None).unwrap();
        let restored = load_from(keyed.clone());
        assert_eq!(restored.default_model.as_deref(), Some("plain"));
        assert_eq!(restored.default_effort.as_deref(), None);
        crate::models::save_selection_route(
            &config.grok_home,
            "not-a-catalog-id",
            Some("high"),
            Some(r#"["cli-mock","cli-mock-fork"]"#),
        )
        .unwrap();
        let advertised = load_from(keyed.clone());
        assert_eq!(advertised.default_model.as_deref(), Some("plain"));
        assert_eq!(
            advertised.unmatched_saved_model.as_deref(),
            Some("not-a-catalog-id")
        );
        assert_eq!(
            advertised.saved_acp_value.as_deref(),
            Some(r#"["cli-mock","cli-mock-fork"]"#)
        );
        apply_to_dsh(&advertised, &keyed.env).unwrap();
        let patch = fs::read_to_string(advertised.dsh_home.join("rust-effective.yml")).unwrap();
        assert!(patch.contains("model: cli-mock-fork"));
        assert!(patch.contains("id: compaction-basic") || patch.contains("cli-mock"));
        crate::models::save_selection(&config.grok_home, "think", Some("low")).unwrap();
        let pinned = load_from(keyed.clone());
        assert_eq!(pinned.default_model.as_deref(), Some("think"));
        apply_to_dsh(&pinned, &keyed.env).unwrap();
        let pinned_patch = fs::read_to_string(pinned.dsh_home.join("rust-effective.yml")).unwrap();
        assert!(pinned_patch.contains("model: think-model"));
        assert!(!pinned_patch.contains("cli-mock-fork"));
        assert!(restored.ready);
        assert_eq!(
            config
                .settings
                .iter()
                .find(|setting| setting.key == "models.default")
                .map(|setting| setting.source.as_str()),
            Some("saved")
        );
    }

    #[test]
    fn trusted_workspace_replaces_saved_model_and_effort() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        write_config(
            &load,
            r#"
[models]
default = "chat"
default_reasoning_effort = "high"

[model.chat]
name = "Local chat"
model = "shared-name"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
supports_reasoning_effort = true
reasoning_efforts = ["low", "high"]

[model.workspace-chat]
name = "Workspace chat"
model = "shared-name"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
supports_reasoning_effort = true
reasoning_efforts = ["low", "high"]
"#,
        );
        crate::models::save_selection(&load.grok_home.clone().unwrap(), "chat", Some("high"))
            .unwrap();
        fs::create_dir_all(load.cwd.join(".git")).unwrap();
        let workspace = load.cwd.join(".grok");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(
            workspace.join("config.toml"),
            r#"
[models]
default = "workspace-chat"
default_reasoning_effort = "low"
"#,
        )
        .unwrap();
        load.cli_trust = true;
        load.env.insert("XAI_API_KEY".into(), "ROUTE_TOKEN".into());
        let config = load_from(load);
        assert!(config.workspace_trusted);
        assert_eq!(config.default_model.as_deref(), Some("workspace-chat"));
        assert_eq!(config.default_effort.as_deref(), Some("low"));
        assert_eq!(
            config
                .settings
                .iter()
                .find(|setting| setting.key == "models.default")
                .map(|setting| setting.source.as_str()),
            Some("workspace")
        );
        assert_eq!(
            config
                .settings
                .iter()
                .find(|setting| setting.key == "models.default_reasoning_effort")
                .map(|setting| setting.source.as_str()),
            Some("workspace")
        );
    }

    #[test]
    fn compact_threshold_and_pruning_map_into_dsh_without_fabricating_invalid_values() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        write_config(
            &load,
            r#"
[model.chat]
model = "shared-name"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
context_window = 64000

[session]
auto_compact_threshold_percent = 50

[compaction.pruning]
enabled = true
soft_trim_threshold = 64
soft_trim_head = 16
soft_trim_tail = 8
keep_last_n_turns = 2
hard_clear_age_turns = 9
"#,
        );
        load.env.insert("XAI_API_KEY".into(), "test-key".into());
        load.env
            .insert("GROK_AUTO_COMPACT_THRESHOLD_PERCENT".into(), "40".into());
        load.env
            .insert("GROK_COMPACTION_WALL_CLOCK_SECS".into(), "1".into());
        let config = load_from(load.clone());
        assert_eq!(config.compact_threshold_percent, Some(40));
        assert_eq!(config.compact_wall_clock_secs, Some(1));
        assert!(config.prune_enabled);
        assert_eq!(config.prune_threshold_chars, 64);
        assert_eq!(config.prune_head_chars, 16);
        assert_eq!(config.prune_tail_chars, 8);
        assert!(
            config
                .warnings
                .iter()
                .any(|warning| warning.contains("keep_last_n_turns"))
        );
        assert!(
            config
                .warnings
                .iter()
                .any(|warning| warning.contains("hard_clear_age_turns"))
        );
        assert!(
            config
                .warnings
                .iter()
                .any(|warning| warning.contains("low positive budget"))
        );
        apply_to_dsh(&config, &load.env).unwrap();
        let patch = fs::read_to_string(config.dsh_home.join("rust-effective.yml")).unwrap();
        assert!(patch.contains("thresholdRatio: 0.4"));
        assert!(patch.contains("retainRatio: 0.16"));
        assert!(patch.contains("thresholdChars: 64"));
        assert!(patch.contains("headChars: 16"));
        assert!(patch.contains("tailChars: 8"));
        load.env
            .insert("GROK_AUTO_COMPACT_THRESHOLD_PERCENT".into(), "140".into());
        let ignored = load_from(load.clone());
        assert_eq!(ignored.compact_threshold_percent, Some(50));
        load.env
            .insert("GROK_AUTO_COMPACT_THRESHOLD_PERCENT".into(), "10".into());
        let low = load_from(load.clone());
        assert_eq!(low.compact_threshold_percent, Some(10));
        assert!(
            low.warnings
                .iter()
                .any(|warning| warning.contains("retainRatio"))
        );
        apply_to_dsh(&low, &load.env).unwrap();
        let low_patch = fs::read_to_string(low.dsh_home.join("rust-effective.yml")).unwrap();
        assert!(low_patch.contains("thresholdRatio: 0.1"));
        assert!(low_patch.contains("retainRatio: 0.05"));
        load.env
            .insert("GROK_AUTO_COMPACT_THRESHOLD_PERCENT".into(), "0".into());
        let disabled = load_from(load.clone());
        assert_eq!(disabled.compact_threshold_percent, Some(0));
        apply_to_dsh(&disabled, &load.env).unwrap();
        let disabled_patch =
            fs::read_to_string(disabled.dsh_home.join("rust-effective.yml")).unwrap();
        assert!(disabled_patch.contains("auto: false"));
        assert!(!disabled_patch.contains("thresholdRatio: 0\n"));
    }

    #[test]
    fn memory_gate_is_off_until_enabled_and_force_disable_wins() {
        let dir = TempDir::new().unwrap();
        let load = input(&dir);
        let off = load_from(load.clone());
        assert!(!off.memory.enabled());
        assert!(!off.memory.force_off());
        let row = off
            .settings
            .iter()
            .find(|setting| setting.key == "memory.enabled")
            .unwrap();
        assert_eq!(row.value, "false");
        write_config(&load, "[memory]\nenabled = true\n");
        let mut enabled = load.clone();
        let on = load_from(enabled.clone());
        assert!(on.memory.enabled());
        assert_eq!(on.memory.source(), "config.toml");
        enabled.env.insert("GROK_MEMORY".into(), "0".into());
        let forced = load_from(enabled.clone());
        assert!(forced.memory.force_off());
        assert!(!forced.memory.enabled());
        enabled.env.insert("GROK_MEMORY".into(), "1".into());
        enabled.cli_no_memory = true;
        let cli = load_from(enabled);
        assert!(cli.memory.force_off());
        let store = crate::memory::open_store(&off.grok_home, &off.cwd).unwrap();
        crate::memory::save_note(&store, crate::memory::Scope::Global, "kept while disabled")
            .unwrap();
        let note = store.root.join("MEMORY.md");
        let before = fs::read_to_string(&note).unwrap();
        assert!(cli.memory.force_off());
        assert_eq!(fs::read_to_string(&note).unwrap(), before);
        write_config(&load, "[memory]\nenabled = false\n");
        let mut explicit = load.clone();
        explicit.env.insert("GROK_MEMORY".into(), "1".into());
        let stopped = load_from(explicit);
        assert!(!stopped.memory.enabled());
        assert!(!stopped.memory.force_off());
        assert_eq!(stopped.memory.source(), "config");
        let block = crate::memory::injection_block(&store, stopped.memory.enabled()).unwrap();
        assert!(block.is_empty());
        assert!(note.is_file());
    }

    #[test]
    fn locked_requirements_beat_cli_env_overlay_and_workspace() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        write_config(
            &load,
            r#"
[models]
default = "user-model"

[model.user-model]
model = "user"
base_url = "http://user.example/v1"
env_key = "USER_API_KEY"

[model.managed-model]
model = "managed"
base_url = "http://managed.example/v1"
env_key = "MANAGED_API_KEY"

[model.locked-model]
model = "locked"
base_url = "http://locked.example/v1"
env_key = "LOCKED_API_KEY"

[features]
remote_fetch = true
"#,
        );
        let grok = load.grok_home.clone().unwrap();
        fs::write(
            grok.join("managed_config.toml"),
            r#"
[models]
default = "managed-model"

[features]
remote_fetch = true
"#,
        )
        .unwrap();
        fs::write(
            grok.join("requirements.toml"),
            r#"
fail_closed = true

[models]
default = "locked-model"

[features]
remote_fetch = false
"#,
        )
        .unwrap();
        let workspace = load.cwd.join(".grok");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(
            workspace.join("config.toml"),
            r#"
[models]
default = "user-model"
"#,
        )
        .unwrap();
        load.env.insert(
            "GROK_CONFIG".into(),
            r#"{"models":{"default":"user-model"}}"#.into(),
        );
        load.env
            .insert("LOCKED_API_KEY".into(), "locked-secret".into());
        load.cli_model = Some("user-model".into());
        load.cli_trust = true;
        let config = load_from(load);
        assert_eq!(config.default_model.as_deref(), Some("locked-model"));
        let default = config
            .settings
            .iter()
            .find(|setting| setting.key == "models.default")
            .unwrap();
        assert_eq!(default.source, "requirements");
        let fetch = config
            .settings
            .iter()
            .find(|setting| setting.key == "features.remote_fetch")
            .unwrap();
        assert_eq!(fetch.value, "false");
        assert_eq!(fetch.source, "requirements");
        assert!(!config.remote_fetch);
    }

    #[test]
    fn untrusted_workspace_does_not_apply_project_config_or_run_hooks() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        fs::create_dir_all(load.cwd.join(".git")).unwrap();
        write_config(
            &load,
            r#"
[models]
default = "user-model"

[model.user-model]
model = "user"
base_url = "http://user.example/v1"
env_key = "USER_API_KEY"

[model.project-model]
model = "project"
base_url = "http://project.example/v1"
env_key = "PROJECT_API_KEY"
"#,
        );
        let workspace = load.cwd.join(".grok");
        fs::create_dir_all(workspace.join("hooks")).unwrap();
        fs::write(
            workspace.join("config.toml"),
            r#"
[models]
default = "project-model"
"#,
        )
        .unwrap();
        fs::write(
            workspace.join("hooks").join("sessionstart.sh"),
            "#!/bin/sh\necho ran > canary\n",
        )
        .unwrap();
        load.env.insert("USER_API_KEY".into(), "user-secret".into());
        load.env
            .insert("PROJECT_API_KEY".into(), "project-secret".into());
        load.interactive = false;
        let config = load_from(load);
        assert_eq!(config.default_model.as_deref(), Some("user-model"));
        assert!(!config.workspace_trusted);
        assert!(!config.project_assets_active);
        assert!(!load_cwd_canary(&config));
        assert_eq!(
            config
                .settings
                .iter()
                .find(|setting| setting.key == "workspace.project_assets")
                .map(|setting| setting.value.as_str()),
            Some("inactive")
        );
        let mut env = BTreeMap::new();
        env.insert("USER_API_KEY".into(), "user-secret".into());
        env.insert("DSH_CODE_CLI_MOCK_TOOL".into(), "echo".into());
        let patch = apply_to_dsh(&config, &env)
            .unwrap()
            .expect("untrusted seam still writes a gate patch");
        let body = fs::read_to_string(&patch).unwrap();
        assert!(body.contains("id: agent-instructions"));
        assert!(body.contains("disabled: true"));
        assert!(
            config
                .files
                .iter()
                .any(|file| file.role == "project-assets" && file.status == "skipped-untrusted")
        );
    }

    #[test]
    fn git_root_workspace_config_is_the_trust_layer_from_a_subdir() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        fs::create_dir_all(load.cwd.join(".git")).unwrap();
        let subdir = load.cwd.join("crates").join("inner");
        fs::create_dir_all(&subdir).unwrap();
        write_config(
            &load,
            r#"
[models]
default = "user-model"

[model.user-model]
model = "user"
base_url = "http://user.example/v1"
env_key = "USER_API_KEY"

[model.project-model]
model = "project"
base_url = "http://project.example/v1"
env_key = "PROJECT_API_KEY"
"#,
        );
        let workspace = load.cwd.join(".grok");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(
            workspace.join("config.toml"),
            r#"
[models]
default = "project-model"
"#,
        )
        .unwrap();
        fs::write(
            load.cwd.join("AGENTS.md"),
            "# MARKER_UNTRUSTED_INSTRUCTIONS\n",
        )
        .unwrap();
        load.env.insert("USER_API_KEY".into(), "user-secret".into());
        load.env
            .insert("PROJECT_API_KEY".into(), "project-secret".into());
        load.cwd = subdir.clone();
        load.interactive = false;
        let denied = load_from(load.clone());
        assert!(!denied.workspace_trusted);
        assert_eq!(denied.default_model.as_deref(), Some("user-model"));
        assert!(
            denied
                .files
                .iter()
                .any(|file| file.role == "workspace" && file.status == "skipped-untrusted")
        );
        load.cli_trust = true;
        let trusted = load_from(load);
        assert!(trusted.workspace_trusted);
        assert_eq!(trusted.default_model.as_deref(), Some("project-model"));
        assert_eq!(
            trusted
                .settings
                .iter()
                .find(|setting| setting.key == "models.default")
                .map(|setting| setting.source.as_str()),
            Some("workspace")
        );
    }

    fn load_cwd_canary(config: &EffectiveConfig) -> bool {
        config
            .files
            .iter()
            .any(|file| file.role == "workspace-canary" && file.status == "executed")
            || config.cwd.join("canary").exists()
    }

    #[test]
    fn unknown_security_fields_are_diagnosed() {
        let dir = TempDir::new().unwrap();
        let load = input(&dir);
        write_config(&load, "[model.x]\nmodel=\"x\"\nbase_url=\"http://x/v1\"\n");
        let grok = load.grok_home.clone().unwrap();
        fs::write(
            grok.join("requirements.toml"),
            "fail_closed = true\nunknown_security_gate = true\n",
        )
        .unwrap();
        let config = load_from(load);
        assert!(!config.errors.is_empty());
        let message = config.first_run_message();
        assert!(message.contains("unknown_security_gate"));
        assert!(message.contains("fail_closed") || message.contains("folder_trust"));
        assert!(message.contains("requirements"));
    }

    #[test]
    fn marketplace_policy_keys_are_known() {
        let dir = TempDir::new().unwrap();
        let load = input(&dir);
        write_config(
            &load,
            "[model.x]\nmodel=\"x\"\nbase_url=\"http://x/v1\"\nenv_key=\"XAI_API_KEY\"\n",
        );
        let grok = load.grok_home.clone().unwrap();
        fs::write(
            grok.join("managed_config.toml"),
            "fail_closed = true\n\n[[marketplace.sources]]\nname = \"Org\"\npath = \"/tmp/org-plugins\"\n",
        )
        .unwrap();
        fs::create_dir_all(load.cwd.join(".grok")).unwrap();
        fs::write(
            load.cwd.join(".grok").join("config.toml"),
            "[[marketplace.sources]]\nname = \"Workspace\"\npath = \"/tmp/ws-plugins\"\n",
        )
        .unwrap();
        let mut trusted = load.clone();
        trusted.cli_trust = true;
        trusted.env.insert("XAI_API_KEY".into(), "k".into());
        let config = load_from(trusted);
        assert!(
            !config.errors.iter().any(|error| error
                .reason
                .contains("unknown security/policy field `marketplace`")),
            "{:?}",
            config.errors
        );
        assert!(
            !config
                .warnings
                .iter()
                .any(|warning| warning.contains("unknown security/policy field `marketplace`")),
            "{:?}",
            config.warnings
        );
        assert!(
            config
                .plugins
                .marketplaces
                .iter()
                .any(|source| source.name == "Org")
        );
    }

    #[test]
    fn sandbox_is_a_known_policy_key_in_user_and_trusted_project_config() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        write_config(&load, "[sandbox]\nprofile = \"strict\"\n");
        fs::create_dir_all(load.cwd.join(".grok")).unwrap();
        fs::write(
            load.cwd.join(".grok").join("config.toml"),
            "[sandbox]\nprofile = \"workspace\"\n",
        )
        .unwrap();
        let grok = load.grok_home.clone().unwrap();
        let requirements = "fail_closed = true\n";
        fs::write(grok.join("requirements.toml"), requirements).unwrap();
        // An unsigned fail_closed file is a separate refusal. Sign it so the
        // assertion is only about the sandbox key.
        let signing = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let payload = json!({
            "typ": "managed-policy",
            "expires_at": crate::auth::now_unix() + 3600,
            "team_id": "team-good",
            "managed_config": "",
            "requirements": requirements,
            "fail_closed": true,
        })
        .to_string();
        let signature = ed25519_dalek::Signer::sign(&signing, payload.as_bytes());
        fs::write(
            grok.join(crate::auth::SIGNATURE_SIDECAR),
            json!({
                "signed_payload": payload,
                "signature": base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
            })
            .to_string(),
        )
        .unwrap();
        load.env.insert(
            "GROK_MANAGED_CONFIG_PUBKEY".into(),
            base64::engine::general_purpose::STANDARD.encode(signing.verifying_key().to_bytes()),
        );
        fs::write(
            grok.join("auth.json"),
            r#"{"access_token":"sess","method":"oidc","team_id":"team-good"}"#,
        )
        .unwrap();
        load.cli_trust = true;
        let config = load_from(load);
        assert!(
            !config
                .errors
                .iter()
                .any(|error| error.reason.contains("`sandbox`")),
            "{:?}",
            config.errors
        );
        assert!(
            !config
                .warnings
                .iter()
                .any(|warning| warning.contains("`sandbox`")),
            "{:?}",
            config.warnings
        );
        // Trusted project config beats the user file. The pin is not set.
        assert_eq!(config.sandbox_profile, "workspace");
        assert_eq!(config.sandbox_profile_source, "workspace");
    }

    #[test]
    fn requirements_pin_beats_cli_env_and_config_path() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        write_config(&load, "[sandbox]\nprofile = \"workspace\"\n");
        let grok = load.grok_home.clone().unwrap();
        fs::write(
            grok.join("managed_config.toml"),
            "[sandbox]\nprofile = \"read-only\"\n",
        )
        .unwrap();
        let requirements = "fail_closed = true\n\n[sandbox]\nprofile = \"strict\"\n";
        fs::write(grok.join("requirements.toml"), requirements).unwrap();
        let signing = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let payload = json!({
            "typ": "managed-policy",
            "expires_at": crate::auth::now_unix() + 3600,
            "team_id": "team-good",
            "managed_config": "[sandbox]\nprofile = \"read-only\"\n",
            "requirements": requirements,
            "fail_closed": true,
        })
        .to_string();
        let signature = ed25519_dalek::Signer::sign(&signing, payload.as_bytes());
        fs::write(
            grok.join(crate::auth::SIGNATURE_SIDECAR),
            json!({
                "signed_payload": payload,
                "signature": base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
            })
            .to_string(),
        )
        .unwrap();
        load.env.insert(
            "GROK_MANAGED_CONFIG_PUBKEY".into(),
            base64::engine::general_purpose::STANDARD.encode(signing.verifying_key().to_bytes()),
        );
        fs::write(
            grok.join("auth.json"),
            r#"{"access_token":"sess","method":"oidc","team_id":"team-good"}"#,
        )
        .unwrap();
        load.cli_sandbox = Some("off".into());
        load.env.insert("GROK_SANDBOX".into(), "off".into());
        let overlay = dir.path().join("overlay.toml");
        fs::write(&overlay, "[sandbox]\nprofile = \"workspace\"\n").unwrap();
        load.env
            .insert("GROK_CONFIG_PATH".into(), overlay.display().to_string());
        let pinned = load_from(load.clone());
        assert!(
            pinned.errors.is_empty(),
            "signed pin should load: {:?}",
            pinned.errors
        );
        assert_eq!(pinned.sandbox_profile, "strict");
        assert_eq!(pinned.sandbox_profile_source, "requirements");

        // A managed default is user-overridable. CLI off wins; the overlay
        // path is still read and would win over the user file alone.
        let _ = fs::remove_file(grok.join("requirements.toml"));
        let _ = fs::remove_file(grok.join(crate::auth::SIGNATURE_SIDECAR));
        load.env.remove("GROK_MANAGED_CONFIG_PUBKEY");
        load.cli_sandbox = Some("off".into());
        let managed = load_from(load.clone());
        assert_eq!(managed.sandbox_profile, "off");
        assert_eq!(managed.sandbox_profile_source, "cli");
        load.cli_sandbox = None;
        load.env.remove("GROK_SANDBOX");
        let from_path = load_from(load);
        assert_eq!(from_path.sandbox_profile, "workspace");
        assert_eq!(from_path.sandbox_profile_source, "overlay");
    }

    #[test]
    fn requirements_pin_still_names_a_profile_when_the_project_is_untrusted() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        load.interactive = false;
        let grok = load.grok_home.clone().unwrap();
        fs::create_dir_all(&grok).unwrap();
        let requirements = "fail_closed = true\n\n[sandbox]\nprofile = \"locked\"\n";
        fs::write(grok.join("requirements.toml"), requirements).unwrap();
        let signing = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let payload = json!({
            "typ": "managed-policy",
            "expires_at": crate::auth::now_unix() + 3600,
            "team_id": "team-good",
            "managed_config": "",
            "requirements": requirements,
            "fail_closed": true,
        })
        .to_string();
        let signature = ed25519_dalek::Signer::sign(&signing, payload.as_bytes());
        fs::write(
            grok.join(crate::auth::SIGNATURE_SIDECAR),
            json!({
                "signed_payload": payload,
                "signature": base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
            })
            .to_string(),
        )
        .unwrap();
        load.env.insert(
            "GROK_MANAGED_CONFIG_PUBKEY".into(),
            base64::engine::general_purpose::STANDARD.encode(signing.verifying_key().to_bytes()),
        );
        fs::write(
            grok.join("auth.json"),
            r#"{"access_token":"sess","method":"oidc","team_id":"team-good"}"#,
        )
        .unwrap();
        fs::create_dir_all(load.cwd.join(".grok")).unwrap();
        // sandbox.toml alone is not a repo-config kind, so trust stays on.
        // A project instruction is, and non-interactive startup then skips it.
        fs::write(load.cwd.join("AGENTS.md"), "# project\n").unwrap();
        fs::write(
            load.cwd.join(".grok").join("config.toml"),
            "[sandbox]\nprofile = \"off\"\n",
        )
        .unwrap();
        fs::write(
            load.cwd.join(".grok").join("sandbox.toml"),
            "[profiles.open]\nextends = \"workspace\"\nread_write = [\"/**\"]\n",
        )
        .unwrap();
        load.cli_sandbox = Some("open".into());
        load.env.insert("GROK_SANDBOX".into(), "off".into());
        let pinned = load_from(load);
        assert!(pinned.errors.is_empty(), "{:?}", pinned.errors);
        assert!(!pinned.workspace_trusted, "{:?}", pinned.trust_message);
        assert_eq!(pinned.sandbox_profile, "locked");
        assert_eq!(pinned.sandbox_profile_source, "requirements");
        assert!(
            pinned
                .files
                .iter()
                .any(|file| file.role == "workspace" && file.status == "skipped-untrusted")
        );
    }

    #[test]
    fn malformed_untrusted_project_file_does_not_veto_a_pinned_user_profile() {
        let dir = TempDir::new().unwrap();
        let mut load = input(&dir);
        load.interactive = false;
        let grok = load.grok_home.clone().unwrap();
        fs::create_dir_all(&grok).unwrap();
        let requirements = "fail_closed = true\n\n[sandbox]\nprofile = \"open\"\n";
        fs::write(grok.join("requirements.toml"), requirements).unwrap();
        let signing = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let payload = json!({
            "typ": "managed-policy",
            "expires_at": crate::auth::now_unix() + 3600,
            "team_id": "team-good",
            "managed_config": "",
            "requirements": requirements,
            "fail_closed": true,
        })
        .to_string();
        let signature = ed25519_dalek::Signer::sign(&signing, payload.as_bytes());
        fs::write(
            grok.join(crate::auth::SIGNATURE_SIDECAR),
            json!({
                "signed_payload": payload,
                "signature": base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
            })
            .to_string(),
        )
        .unwrap();
        load.env.insert(
            "GROK_MANAGED_CONFIG_PUBKEY".into(),
            base64::engine::general_purpose::STANDARD.encode(signing.verifying_key().to_bytes()),
        );
        fs::write(
            grok.join("auth.json"),
            r#"{"access_token":"sess","method":"oidc","team_id":"team-good"}"#,
        )
        .unwrap();
        fs::write(
            grok.join("sandbox.toml"),
            "[profiles.open]\nextends = \"workspace\"\ndeny = [\"secret.txt\"]\n",
        )
        .unwrap();
        fs::create_dir_all(load.cwd.join(".grok")).unwrap();
        fs::write(load.cwd.join("AGENTS.md"), "# project\n").unwrap();
        fs::write(load.cwd.join("secret.txt"), "keep").unwrap();
        fs::write(load.cwd.join(".grok").join("sandbox.toml"), "profiles = [").unwrap();
        load.cli_sandbox = Some("off".into());
        load.env.insert("GROK_SANDBOX".into(), "off".into());
        let pinned = load_from(load);
        assert!(pinned.errors.is_empty(), "{:?}", pinned.errors);
        assert!(!pinned.workspace_trusted, "{:?}", pinned.trust_message);
        assert_eq!(pinned.sandbox_profile, "open");
        assert_eq!(pinned.sandbox_profile_source, "requirements");
        let prepared = crate::filesystem_sandbox::prepare(
            &pinned.sandbox_profile,
            &pinned.cwd,
            &pinned.grok_home,
            None,
            pinned.workspace_trusted,
        )
        .unwrap_or_else(|error| panic!("pinned user profile was vetoed: {}", error.message))
        .expect("pinned profile should confine");
        assert!(
            prepared
                .read_denied
                .iter()
                .any(|path| path.ends_with("secret.txt")),
            "user deny was not applied: {:?}",
            prepared.read_denied
        );
        assert!(
            !prepared
                .write_roots
                .iter()
                .any(|path| path == Path::new("/")),
            "untrusted project widened the pin: {:?}",
            prepared.write_roots
        );
    }
}
