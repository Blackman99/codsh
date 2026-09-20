use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use toml::Value as TomlValue;

pub const TRUST_FILE_NAME: &str = "trusted_folders.toml";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustOutcome {
    Trusted,
    Untrusted,
    Prompt,
}

#[derive(Debug, Clone, Copy)]
pub struct DecideInputs {
    pub store_trusted: bool,
    pub repo_configs_present: bool,
    pub is_interactive: bool,
    pub key_recordable: bool,
}

pub fn decide(feature_enabled: bool, inputs: &DecideInputs) -> TrustOutcome {
    if !feature_enabled {
        return TrustOutcome::Trusted;
    }
    if inputs.store_trusted {
        return TrustOutcome::Trusted;
    }
    if !inputs.key_recordable {
        return TrustOutcome::Trusted;
    }
    if !inputs.repo_configs_present {
        return TrustOutcome::Trusted;
    }
    if inputs.is_interactive {
        return TrustOutcome::Prompt;
    }
    TrustOutcome::Untrusted
}

pub fn folder_trust_enabled(
    env: Option<&str>,
    user: Option<bool>,
    managed: Option<bool>,
    requirement: Option<bool>,
) -> (bool, &'static str) {
    if let Some(value) = requirement {
        return (value, "requirements");
    }
    if let Some(value) = env_bool(env) {
        return (value, "environment");
    }
    if let Some(value) = user {
        return (value, "config.toml");
    }
    if let Some(value) = managed {
        return (value, "managed");
    }
    (true, "default")
}

fn env_bool(value: Option<&str>) -> Option<bool> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" | "enabled" => Some(true),
        "0" | "false" | "no" | "off" | "disabled" => Some(false),
        _ => None,
    }
}

pub fn canonicalize_or_owned(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn is_home_dir(path: &Path, home: &Path) -> bool {
    canonicalize_or_owned(path) == canonicalize_or_owned(home)
}

pub fn is_unsafe_trust_root(key: &Path, home: &Path) -> bool {
    !key.is_absolute() || key.parent().is_none() || is_home_dir(key, home)
}

fn git_root(path: &Path) -> Option<PathBuf> {
    let mut current = canonicalize_or_owned(path);
    loop {
        if current.join(".git").exists() {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

pub fn workspace_key(cwd: &Path, home: &Path) -> PathBuf {
    if let Some(root) = git_root(cwd) {
        if is_unsafe_trust_root(&root, home) {
            return canonicalize_or_owned(cwd);
        }
        return root;
    }
    canonicalize_or_owned(cwd)
}

fn workspace_id(path: &Path, home: &Path) -> PathBuf {
    workspace_key(
        path.ancestors()
            .find(|candidate| candidate.exists())
            .unwrap_or(path),
        home,
    )
}

pub fn repo_config_kinds(cwd: &Path) -> Vec<&'static str> {
    collect_repo_config_kinds(cwd, false)
}

pub fn repo_configs_present(cwd: &Path) -> bool {
    !collect_repo_config_kinds(cwd, true).is_empty()
}

fn directory_present_or_uncertain(path: &Path) -> bool {
    match fs::metadata(path) {
        Ok(metadata) => metadata.is_dir(),
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

fn path_present_or_uncertain(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

fn walk_to_git_root(cwd: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut current = canonicalize_or_owned(cwd);
    loop {
        dirs.push(current.clone());
        if current.join(".git").exists() {
            break;
        }
        if !current.pop() {
            break;
        }
    }
    dirs
}

fn permission_contributes(value: &TomlValue) -> bool {
    let Some(table) = value.as_table() else {
        return true;
    };
    for key in ["deny", "allow", "ask"] {
        if table
            .get(key)
            .and_then(TomlValue::as_array)
            .is_some_and(|items| !items.is_empty())
        {
            return true;
        }
    }
    table
        .get("rules")
        .and_then(TomlValue::as_array)
        .is_some_and(|items| !items.is_empty())
}

#[allow(clippy::collapsible_if)]
fn collect_repo_config_kinds(cwd: &Path, first_only: bool) -> Vec<&'static str> {
    let chain = walk_to_git_root(cwd);
    let mut kinds: Vec<&'static str> = Vec::new();
    let mut hit = |kind: &'static str| -> bool {
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
        first_only
    };
    let git_root = chain
        .iter()
        .find(|path| path.join(".git").exists())
        .cloned()
        .unwrap_or_else(|| canonicalize_or_owned(cwd));

    if cwd.join(".mcp.json").is_file()
        || chain.iter().any(|dir| dir.join(".mcp.json").is_file())
        || cwd.join(".cursor").join("mcp.json").is_file()
    {
        if hit("mcp") {
            return kinds;
        }
    }
    if cwd.join(".envrc").is_file() && hit("envrc") {
        return kinds;
    }
    if cwd.join(".grok").join("lsp.json").is_file() && hit("lsp") {
        return kinds;
    }
    for dir in &chain {
        let grok = dir.join(".grok");
        if grok.join("config.toml").is_file() {
            if let Ok(text) = fs::read_to_string(grok.join("config.toml"))
                && let Ok(root) = toml::from_str::<TomlValue>(&text)
            {
                let has_mcp = root
                    .get("mcp_servers")
                    .and_then(TomlValue::as_table)
                    .is_some_and(|table| !table.is_empty());
                let has_plugins = root
                    .get("plugins")
                    .and_then(|value| value.get("paths"))
                    .and_then(TomlValue::as_array)
                    .is_some_and(|items| !items.is_empty());
                let has_permission = root.get("permission").is_some_and(permission_contributes);
                if has_mcp && hit("mcp") {
                    return kinds;
                }
                if has_plugins && hit("plugins") {
                    return kinds;
                }
                if has_permission && hit("permission") {
                    return kinds;
                }
            }
        }
        if directory_present_or_uncertain(&grok.join("plugins")) && hit("plugins") {
            return kinds;
        }
        if directory_present_or_uncertain(&grok.join("agents")) && hit("agents") {
            return kinds;
        }
        if dir.join(".claude").join("agents").is_dir() && hit("agents") {
            return kinds;
        }
        if dir.join(".claude").join("settings.json").exists() && hit("claude") {
            return kinds;
        }
        if directory_present_or_uncertain(&dir.join(".grok").join("skills"))
            || directory_present_or_uncertain(&dir.join(".grok").join("commands"))
        {
            if hit("skills") {
                return kinds;
            }
        }
        for name in [
            "Agents.md",
            "Claude.md",
            "CLAUDE.md",
            "CLAUDE.local.md",
            "AGENT.md",
            "AGENTS.md",
        ] {
            if dir.join(name).is_file() && hit("instructions") {
                return kinds;
            }
        }
        if directory_present_or_uncertain(&dir.join(".grok").join("rules")) && hit("instructions") {
            return kinds;
        }
    }
    if cwd.join(".grok").join("roles").is_dir() && hit("roles") {
        return kinds;
    }
    if cwd.join(".grok").join("personas").is_dir() && hit("personas") {
        return kinds;
    }
    if directory_present_or_uncertain(&git_root.join(".grok").join("workflows")) && hit("workflows")
    {
        return kinds;
    }
    if path_present_or_uncertain(&git_root.join(".grok").join("hooks"))
        || path_present_or_uncertain(&git_root.join(".cursor").join("hooks.json"))
    {
        hit("hooks");
    }
    kinds
}

#[derive(Debug, Clone)]
struct FolderRecord {
    trusted: bool,
}

#[derive(Debug, Clone)]
pub struct TrustStore {
    folders: BTreeMap<String, FolderRecord>,
    path: Option<PathBuf>,
    disk_readable: bool,
    home: PathBuf,
}

#[derive(Debug)]
pub enum PersistError {
    Unreadable(io::Error),
    Publish(io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recorded {
    Durable,
    Skipped,
}

impl TrustStore {
    pub fn load_from(path: PathBuf, home: PathBuf) -> Self {
        match read_document(&path) {
            Ok(Some(folders)) => Self {
                folders,
                path: Some(path),
                disk_readable: true,
                home,
            },
            Ok(None) => Self {
                folders: BTreeMap::new(),
                path: Some(path),
                disk_readable: true,
                home,
            },
            Err(_) => Self {
                folders: BTreeMap::new(),
                path: Some(path),
                disk_readable: false,
                home,
            },
        }
    }

    #[allow(dead_code)]
    pub fn empty(home: PathBuf) -> Self {
        Self {
            folders: BTreeMap::new(),
            path: None,
            disk_readable: true,
            home,
        }
    }

    pub fn disk_readable(&self) -> bool {
        self.disk_readable
    }

    pub fn has_store_path(&self) -> bool {
        self.path.is_some()
    }

    pub fn is_trusted(&self, key: &Path) -> bool {
        if !self.disk_readable {
            return false;
        }
        let query = canonicalize_or_owned(key);
        let query_id = workspace_id(&query, &self.home);
        let mut best_depth: Option<usize> = None;
        let mut trusted = false;
        for (folder, record) in &self.folders {
            let folder = Path::new(folder);
            if is_unsafe_trust_root(folder, &self.home) || !query.starts_with(folder) {
                continue;
            }
            if workspace_id(folder, &self.home) != query_id {
                continue;
            }
            let depth = folder.components().count();
            match best_depth {
                Some(existing) if depth < existing => {}
                Some(existing) if depth == existing => trusted &= record.trusted,
                _ => {
                    best_depth = Some(depth);
                    trusted = record.trusted;
                }
            }
        }
        trusted
    }

    pub fn has_decision(&self, key: &Path) -> bool {
        let canonical = canonicalize_or_owned(key);
        self.folders
            .contains_key(canonical.to_string_lossy().as_ref())
    }

    #[allow(dead_code)]
    pub fn set_trusted(&mut self, key: &Path) -> io::Result<()> {
        self.record_decision(key, true)?;
        Ok(())
    }

    pub fn set_untrusted(&mut self, key: &Path) -> io::Result<()> {
        self.record_decision(key, false)?;
        Ok(())
    }

    fn record_decision(&mut self, key: &Path, trusted: bool) -> Result<Recorded, io::Error> {
        match self.record_decision_strict(key, trusted) {
            Ok(recorded) => Ok(recorded),
            Err(PersistError::Unreadable(error) | PersistError::Publish(error)) => Err(error),
        }
    }

    pub fn record_decision_strict(
        &mut self,
        key: &Path,
        trusted: bool,
    ) -> Result<Recorded, PersistError> {
        let canonical = canonicalize_or_owned(key);
        if is_unsafe_trust_root(&canonical, &self.home) {
            return Ok(Recorded::Skipped);
        }
        let Some(path) = self.path.clone() else {
            return Ok(Recorded::Skipped);
        };
        if !self.disk_readable {
            match read_document(&path) {
                Ok(_) => {}
                Err(error) => return Err(PersistError::Unreadable(error)),
            }
        }
        let parent = path.parent().ok_or_else(|| {
            PersistError::Publish(io::Error::new(
                ErrorKind::InvalidInput,
                "trust store path has no parent",
            ))
        })?;
        fs::create_dir_all(parent).map_err(PersistError::Publish)?;
        let mut folders = match read_document(&path) {
            Ok(Some(folders)) => folders,
            Ok(None) => BTreeMap::new(),
            Err(error) => return Err(PersistError::Unreadable(error)),
        };
        folders.insert(
            canonical.to_string_lossy().into_owned(),
            FolderRecord { trusted },
        );
        persist_document(&path, &folders).map_err(PersistError::Publish)?;
        self.folders = folders;
        self.disk_readable = true;
        Ok(Recorded::Durable)
    }
}

fn read_document(path: &Path) -> io::Result<Option<BTreeMap<String, FolderRecord>>> {
    let link_meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    if link_meta.file_type().is_dir() {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "trust store path is a directory",
        ));
    }
    let contents = match fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => return Ok(Some(BTreeMap::new())),
        Ok(text) => text,
        Err(error)
            if !link_meta.file_type().is_symlink()
                && matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let parsed: TomlValue =
        toml::from_str(&contents).map_err(|error| io::Error::new(ErrorKind::InvalidData, error))?;
    let mut folders = BTreeMap::new();
    if let Some(table) = parsed.get("folders").and_then(TomlValue::as_table) {
        for (key, value) in table {
            let trusted = value
                .get("trusted")
                .and_then(TomlValue::as_bool)
                .ok_or_else(|| {
                    io::Error::new(ErrorKind::InvalidData, "folder record missing trusted")
                })?;
            folders.insert(key.clone(), FolderRecord { trusted });
        }
    }
    Ok(Some(folders))
}

fn persist_document(path: &Path, folders: &BTreeMap<String, FolderRecord>) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "trust store path has no parent"))?;
    fs::create_dir_all(parent)?;
    let mut body = String::from("# folder-trust store\n");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    for (folder, record) in folders {
        let escaped = folder.replace('\\', "\\\\").replace('\'', "\\'");
        body.push_str(&format!(
            "\n[folders.'{escaped}']\ntrusted = {}\ndecided_at = {now}\n",
            record.trusted
        ));
    }
    let temp = parent.join(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("trusted_folders.toml")
    ));
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(body.as_bytes())?;
        file.flush()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = file.metadata()?.permissions();
            permissions.set_mode(0o600);
            fs::set_permissions(&temp, permissions)?;
        }
    }
    fs::rename(&temp, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantRefuse {
    UnsafeRoot,
    NoHome,
    Unreadable,
    KeyMoved,
}

impl std::fmt::Display for GrantRefuse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsafeRoot => write!(formatter, "folder trust is not recorded for this path"),
            Self::NoHome => write!(
                formatter,
                "Couldn't save folder trust: no home directory for the trust store. \
                 Set GROK_HOME to an absolute directory, then start again."
            ),
            Self::Unreadable => write!(
                formatter,
                "Couldn't save folder trust: the trust store could not be read. \
                 Fix or delete $GROK_HOME/trusted_folders.toml, then start again and press y."
            ),
            Self::KeyMoved => write!(
                formatter,
                "Couldn't save folder trust: the folder path changed. \
                 Start again from the folder you want to trust."
            ),
        }
    }
}

#[derive(Debug)]
pub enum PersistStatus {
    Durable,
    ProcessLocalOnly {
        #[allow(dead_code)]
        error: io::Error,
    },
}

#[derive(Debug)]
pub enum GrantOutcome {
    Granted {
        #[allow(dead_code)]
        key: PathBuf,
        persist: PersistStatus,
    },
    AlreadyDurable {
        #[allow(dead_code)]
        key: PathBuf,
    },
    Refused {
        reason: GrantRefuse,
    },
}

impl std::fmt::Display for GrantOutcome {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Granted {
                persist: PersistStatus::ProcessLocalOnly { .. },
                ..
            } => write!(
                formatter,
                "Couldn't save folder trust. Check that $GROK_HOME is writable, \
                 then run `codsh --rust --trust` in this folder."
            ),
            Self::Refused { reason } => write!(formatter, "{reason}"),
            Self::Granted { .. } | Self::AlreadyDurable { .. } => {
                write!(formatter, "folder trust was saved")
            }
        }
    }
}

static PROCESS_DECISIONS: Mutex<Option<HashMap<PathBuf, bool>>> = Mutex::new(None);

fn process_map() -> HashMap<PathBuf, bool> {
    PROCESS_DECISIONS
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_default()
}

fn record_process_decision(key: &Path, trusted: bool) {
    if let Ok(mut guard) = PROCESS_DECISIONS.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(key.to_path_buf(), trusted);
    }
}

pub fn process_decision(key: &Path) -> Option<bool> {
    process_map().get(key).copied()
}

pub fn remember_process_decision(key: &Path, trusted: bool) {
    record_process_decision(key, trusted);
}

pub fn is_trusted_this_process(key: &Path, store: &TrustStore) -> bool {
    if let Some(trusted) = process_decision(key) {
        return trusted;
    }
    store.is_trusted(key)
}

pub fn grant_folder_trust_key(store_home: Option<&Path>, home: &Path, key: &Path) -> GrantOutcome {
    if let Ok(canonical) = fs::canonicalize(key) {
        if canonical != key {
            return GrantOutcome::Refused {
                reason: GrantRefuse::KeyMoved,
            };
        }
    } else {
        return GrantOutcome::Refused {
            reason: GrantRefuse::KeyMoved,
        };
    }
    if is_unsafe_trust_root(key, home) {
        return GrantOutcome::Refused {
            reason: GrantRefuse::UnsafeRoot,
        };
    }
    let Some(store_home) = store_home.filter(|path| path.is_absolute()) else {
        return GrantOutcome::Refused {
            reason: GrantRefuse::NoHome,
        };
    };
    let mut store = TrustStore::load_from(store_home.join(TRUST_FILE_NAME), home.to_path_buf());
    apply_grant_to_store(&mut store, key)
}

fn apply_grant_to_store(store: &mut TrustStore, key: &Path) -> GrantOutcome {
    let key = key.to_path_buf();
    if !store.disk_readable() {
        return GrantOutcome::Refused {
            reason: GrantRefuse::Unreadable,
        };
    }
    if !store.has_store_path() {
        return GrantOutcome::Refused {
            reason: GrantRefuse::NoHome,
        };
    }
    if store.has_decision(&key) && store.is_trusted(&key) {
        record_process_decision(&key, true);
        return GrantOutcome::AlreadyDurable { key };
    }
    match store.record_decision_strict(&key, true) {
        Ok(Recorded::Durable) => {
            record_process_decision(&key, true);
            GrantOutcome::Granted {
                key,
                persist: PersistStatus::Durable,
            }
        }
        Ok(Recorded::Skipped) => GrantOutcome::Refused {
            reason: GrantRefuse::UnsafeRoot,
        },
        Err(PersistError::Unreadable(_)) => GrantOutcome::Refused {
            reason: GrantRefuse::Unreadable,
        },
        Err(PersistError::Publish(error)) => {
            record_process_decision(&key, true);
            GrantOutcome::Granted {
                key,
                persist: PersistStatus::ProcessLocalOnly { error },
            }
        }
    }
}

pub fn revoke_folder_trust(store: &mut TrustStore, key: &Path) -> bool {
    let was_trusted = store.is_trusted(key) || process_map().get(key).copied() == Some(true);
    if was_trusted {
        let _ = store.set_untrusted(key);
        record_process_decision(key, false);
    }
    was_trusted
}

pub fn skip_untrusted_project_hooks(cwd: &Path, trusted: bool) -> io::Result<bool> {
    if trusted {
        return Ok(false);
    }
    for dir in walk_to_git_root(cwd) {
        let hooks = dir.join(".grok").join("hooks");
        if hooks.exists() {
            return Ok(true);
        }
        let plugins = dir.join(".grok").join("plugins");
        if plugins.exists() {
            return Ok(true);
        }
    }
    Ok(repo_configs_present(cwd))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn inputs() -> DecideInputs {
        DecideInputs {
            store_trusted: false,
            repo_configs_present: true,
            is_interactive: false,
            key_recordable: true,
        }
    }

    fn repo_tmp() -> TempDir {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".git")).unwrap();
        tmp
    }

    #[test]
    fn feature_off_is_always_trusted() {
        assert_eq!(decide(false, &inputs()), TrustOutcome::Trusted);
    }

    #[test]
    fn store_trusted_is_trusted() {
        let inputs = DecideInputs {
            store_trusted: true,
            ..inputs()
        };
        assert_eq!(decide(true, &inputs), TrustOutcome::Trusted);
    }

    #[test]
    fn no_repo_configs_is_trusted_without_prompt() {
        let inputs = DecideInputs {
            repo_configs_present: false,
            is_interactive: true,
            ..inputs()
        };
        assert_eq!(decide(true, &inputs), TrustOutcome::Trusted);
    }

    #[test]
    fn interactive_with_configs_prompts() {
        let inputs = DecideInputs {
            is_interactive: true,
            ..inputs()
        };
        assert_eq!(decide(true, &inputs), TrustOutcome::Prompt);
    }

    #[test]
    fn headless_with_configs_is_untrusted() {
        assert_eq!(decide(true, &inputs()), TrustOutcome::Untrusted);
    }

    #[test]
    fn unrecordable_key_is_trusted() {
        let inputs = DecideInputs {
            key_recordable: false,
            is_interactive: true,
            ..inputs()
        };
        assert_eq!(decide(true, &inputs), TrustOutcome::Trusted);
    }

    #[test]
    fn repo_configs_present_detects_hooks_and_instructions() {
        let tmp = repo_tmp();
        assert!(!repo_configs_present(tmp.path()));
        fs::create_dir_all(tmp.path().join(".grok").join("hooks")).unwrap();
        assert!(repo_config_kinds(tmp.path()).contains(&"hooks"));
        fs::write(tmp.path().join("AGENTS.md"), "# project\n").unwrap();
        assert!(repo_config_kinds(tmp.path()).contains(&"instructions"));
    }

    #[test]
    fn nested_git_root_is_a_separate_workspace() {
        let tmp = repo_tmp();
        let nested = tmp.path().join("vendor").join("dep");
        fs::create_dir_all(nested.join(".git")).unwrap();
        let home = tmp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let parent = workspace_key(tmp.path(), &home);
        let child = workspace_key(&nested, &home);
        assert_ne!(parent, child);
        let store_path = home.join(TRUST_FILE_NAME);
        let mut store = TrustStore::load_from(store_path, home);
        store.set_trusted(&parent).unwrap();
        assert!(store.is_trusted(&parent));
        assert!(!store.is_trusted(&child));
    }

    #[test]
    fn grant_round_trips_and_revoke_clears() {
        let tmp = repo_tmp();
        let home = tmp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let key = workspace_key(tmp.path(), &home);
        let outcome = grant_folder_trust_key(Some(&home), &home, &key);
        assert!(matches!(
            outcome,
            GrantOutcome::Granted {
                persist: PersistStatus::Durable,
                ..
            }
        ));
        let store_path = home.join(TRUST_FILE_NAME);
        let mut store = TrustStore::load_from(store_path.clone(), home.clone());
        assert!(store.is_trusted(&key));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&store_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(revoke_folder_trust(&mut store, &key));
        let reloaded = TrustStore::load_from(store_path, home);
        assert!(!reloaded.is_trusted(&key));
        assert!(reloaded.has_decision(&key));
    }

    #[test]
    fn unreadable_store_fails_closed() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let store_path = home.join(TRUST_FILE_NAME);
        fs::create_dir_all(&store_path).unwrap();
        let store = TrustStore::load_from(store_path, home.clone());
        assert!(!store.disk_readable());
        assert!(!store.is_trusted(&home.join("repo")));
        let key = home.join("repo");
        fs::create_dir_all(&key).unwrap();
        let canonical = fs::canonicalize(&key).unwrap();
        let outcome = grant_folder_trust_key(Some(&home), &tmp.path().join("other"), &canonical);
        assert!(matches!(
            outcome,
            GrantOutcome::Refused {
                reason: GrantRefuse::Unreadable
            }
        ));
    }

    #[test]
    fn untrusted_hooks_are_skipped() {
        let tmp = repo_tmp();
        let hooks = tmp.path().join(".grok").join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        fs::write(
            hooks.join("sessionstart.sh"),
            "#!/bin/sh\necho ran > canary\n",
        )
        .unwrap();
        assert!(skip_untrusted_project_hooks(tmp.path(), false).unwrap());
        assert!(!tmp.path().join("canary").exists());
        assert!(!skip_untrusted_project_hooks(tmp.path(), true).unwrap());
        assert!(!tmp.path().join("canary").exists());
    }

    #[test]
    fn requirement_locks_folder_trust_off() {
        let (enabled, source) =
            folder_trust_enabled(Some("1"), Some(true), Some(true), Some(false));
        assert!(!enabled);
        assert_eq!(source, "requirements");
    }
}
