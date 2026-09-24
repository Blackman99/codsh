//! Filesystem, network, and launch-environment confinement for `codsh --rust`
//! (tickets 11 / #143 and 12 / #144).
//!
//! A requested non-`off` profile is applied to this process with the Apache-2.0
//! `nono` 0.53 library (Seatbelt on macOS, Landlock on Linux) before dsh starts.
//! Children inherit that kernel policy. This is not a dsh fork and not a
//! per-tool string check. dsh's per-call file mode is not a network sandbox.
//! On macOS a `restrict_network` profile denies `network*` in the same Seatbelt
//! profile. Linux Landlock/seccomp network blocking is a different mechanism
//! and is not claimed from a macOS run: a profile that asks for it refuses
//! startup there. Windows confinement is not implemented.

use nono::{AccessMode, CapabilitySet, Sandbox};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

const BUILTINS: &[&str] = &["off", "workspace", "read-only", "strict", "devbox"];
const PROTECTED_FILES: &[&str] = &[
    "config.toml",
    "trusted_folders.toml",
    "managed_config.toml",
    "requirements.toml",
    "sandbox.toml",
    "hooks-paths",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prepared {
    pub name: String,
    pub summary: String,
    pub mechanism: String,
    pub platform: String,
    pub read_roots: Vec<PathBuf>,
    pub write_roots: Vec<PathBuf>,
    pub write_denied: Vec<PathBuf>,
    pub read_denied: Vec<PathBuf>,
    pub read_denied_globs: Vec<DenyGlob>,
    pub session_only_config: bool,
    pub devbox: bool,
    /// When true, the kernel profile denies outbound network for this process
    /// and every child. A dsh file mode is not this switch.
    pub restrict_network: bool,
    pub network_note: String,
    /// `None` keeps the launch environment. `Some` is the filtered map a
    /// shell child is allowed to see, including names forced by `set`.
    pub shell_env: Option<BTreeMap<String, String>>,
    pub limits: Vec<String>,
}

#[derive(Debug)]
pub struct Refusal {
    pub message: String,
}

/// A deny glob split at its first glob segment. `root` is literal: a
/// workspace or directory name that contains `[`, `*`, or `?` is not glob
/// syntax. Seatbelt matches resolved paths, so the root is resolved through
/// its deepest existing ancestor before the rule is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DenyGlob {
    pub pattern: String,
    pub root: PathBuf,
    pub tail: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct FileConfig {
    #[serde(default)]
    profiles: BTreeMap<String, ProfileBody>,
    #[serde(default, rename = "shell_environment_policy")]
    shell_environment_policy: Option<ShellEnvironmentPolicy>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ProfileBody {
    extends: Option<String>,
    #[serde(default)]
    restrict_network: Option<bool>,
    #[serde(default)]
    read_only: Vec<String>,
    #[serde(default)]
    read_write: Vec<String>,
    #[serde(default)]
    deny: Vec<String>,
}

/// `[shell_environment_policy]` in `$GROK_HOME/sandbox.toml`.
///
/// Order matches the reference: start from `inherit`, drop `*KEY*` /
/// `*SECRET*` / `*TOKEN*` unless `ignore_default_excludes`, drop `exclude`,
/// apply `set`, then keep only `include_only` when that list is non-empty.
/// Patterns are case-insensitive `*` / `?` globs. This filters the launch
/// environment of shell children and of the dsh process. dsh's bash tool is
/// built from that process environment. Credential keys the client adds for
/// the model route stay a separate execution grant.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
struct ShellEnvironmentPolicy {
    #[serde(default)]
    inherit: Option<String>,
    #[serde(default)]
    ignore_default_excludes: bool,
    #[serde(default)]
    exclude: Vec<String>,
    #[serde(default)]
    include_only: Vec<String>,
    #[serde(default)]
    set: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
struct Resolved {
    base: String,
    read_everywhere: bool,
    write_workspace: bool,
    write_grok: bool,
    write_sessions_only: bool,
    write_temps: bool,
    read_only_extra: Vec<PathBuf>,
    read_write_extra: Vec<PathBuf>,
    deny_exact: Vec<PathBuf>,
    deny_globs: Vec<DenyGlob>,
    dsh_home: Option<PathBuf>,
    devbox: bool,
    restrict_network: bool,
    shell_env: Option<ShellEnvironmentPolicy>,
    warnings: Vec<String>,
}

static ACTIVE: OnceLock<Prepared> = OnceLock::new();

pub fn active() -> Option<&'static Prepared> {
    ACTIVE.get()
}

/// True when a settings write would change a kernel-protected global file.
/// The caller keeps the change in memory and must not pretend it was saved.
pub fn session_only_write(path: &Path) -> bool {
    let Some(active) = ACTIVE.get() else {
        return false;
    };
    if !active.session_only_config {
        return false;
    }
    active
        .write_denied
        .iter()
        .any(|denied| paths_same(denied, path))
        || active
            .read_denied
            .iter()
            .any(|denied| paths_same(denied, path))
}

fn paths_same(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// Highest source wins. A requirements pin beats CLI and `GROK_SANDBOX`.
/// A managed default does not: CLI, environment, overlay, and the user file
/// all override it. An empty value is absent, not a profile named `off`.
pub fn select_profile(layers: &[(ProfileSource, Option<&str>)]) -> (String, ProfileSource) {
    let mut chosen: Option<(String, ProfileSource)> = None;
    for (source, value) in layers {
        let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
            continue;
        };
        if *source == ProfileSource::Requirements {
            return (value.to_string(), *source);
        }
        if chosen.is_none() {
            chosen = Some((value.to_string(), *source));
        }
    }
    chosen.unwrap_or_else(|| ("off".into(), ProfileSource::Default))
}

/// Which layer named the profile. A requirements pin is not a user default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileSource {
    Requirements,
    Cli,
    Environment,
    Overlay,
    User,
    Workspace,
    Managed,
    Default,
}

/// Resolve a profile without applying it. `off` returns `Ok(None)`.
///
/// `workspace_trusted` is the same folder-trust decision inspect reports.
/// It does not select the profile name. It only decides whether
/// `.grok/sandbox.toml` may supply a definition. Naming a profile with
/// `--sandbox` does not trust that file.
pub fn prepare(
    name: &str,
    workspace: &Path,
    grok_home: &Path,
    dsh_home: Option<&Path>,
    workspace_trusted: bool,
) -> Result<Option<Prepared>, Refusal> {
    let name = name.trim();
    if name.is_empty() || name == "off" {
        return Ok(None);
    }
    let support = Sandbox::support_info();
    if !support.is_supported {
        return Err(Refusal {
            message: format!(
                "refusing sandbox profile {name}: kernel confinement is unavailable on {} ({})",
                support.platform, support.details
            ),
        });
    }
    let resolved = resolve(name, workspace, grok_home, dsh_home, workspace_trusted)?;
    // A requested network restriction that this platform cannot apply is a
    // refusal, not a warning. Linux Landlock/seccomp is not claimed here.
    if resolved.restrict_network {
        network_enforceable(name)?;
    }
    let shell_env = match &resolved.shell_env {
        Some(policy) => Some(filter_launch_env(policy, &std::env::vars().collect())?),
        None => None,
    };
    let mut limits = resolved.warnings.clone();
    limits.push(platform_network_limit(resolved.restrict_network));
    limits.push(
        "Linux glob deny is launch-time only in the reference; this client uses Seatbelt subpath rules on macOS and refuses a deny glob on Linux rather than scanning a partial tree."
            .into(),
    );
    limits.push(
        "Windows filesystem confinement is not implemented or supported by this ticket.".into(),
    );
    limits.push(
        "dsh's own per-call file sandbox cannot nest inside this policy and is set to danger-full-access; approvals are unchanged and writes are bounded by this profile's write roots."
            .into(),
    );
    limits.push(
        "The launchd escape (launchctl submit / bootstrap gui/$UID) is kernel-blocked under this profile, matching the reference nono profile's mach-lookup rules. A directory under a deny glob, including one created after launch, cannot be renamed or unlinked: Seatbelt matches the resolved path, so moving that directory onto another write root would carry a matched file out from under the regex."
            .into(),
    );
    if resolved.devbox {
        limits.push(
            "devbox does not write-protect global hook, config, or trust files (disposable VM profile)."
                .into(),
        );
    }
    // devbox skips only the global hook/config/trust write protection. A
    // user's deny list is still a requested protection and stays enforced.
    let write_denied = if resolved.devbox {
        Vec::new()
    } else {
        protected_paths(grok_home)?
    };
    let read_denied = resolved.deny_exact.clone();
    let mut read_roots = Vec::new();
    let mut write_roots = Vec::new();
    if resolved.read_everywhere {
        read_roots.push(PathBuf::from("/"));
    } else {
        read_roots.push(workspace.to_path_buf());
        read_roots.push(grok_home.to_path_buf());
        for root in system_read_roots() {
            if root.exists() {
                read_roots.push(root);
            }
        }
    }
    if resolved.write_workspace {
        write_roots.push(workspace.to_path_buf());
    }
    if resolved.write_sessions_only {
        write_roots.push(grok_home.join("sessions"));
    } else if resolved.write_grok {
        write_roots.push(grok_home.to_path_buf());
    }
    if resolved.write_temps {
        for root in temp_roots() {
            if root.exists() {
                write_roots.push(root);
            }
        }
    }
    if let Some(dsh_home) = resolved.dsh_home {
        write_roots.push(dsh_home);
    }
    write_roots.extend(resolved.read_write_extra.iter().cloned());
    read_roots.extend(resolved.read_only_extra.iter().cloned());
    read_roots.extend(resolved.read_write_extra.iter().cloned());
    let summary = format!(
        "sandbox {name}: read {}, write {}; kernel {} on {}",
        if resolved.read_everywhere {
            "everywhere except denied paths".to_string()
        } else {
            format!(
                "workspace, $GROK_HOME, and system paths ({})",
                display_paths(&read_roots)
            )
        },
        display_paths(&write_roots),
        mechanism_name(),
        std::env::consts::OS
    );
    let prepared = Prepared {
        name: name.to_string(),
        summary,
        mechanism: mechanism_name().into(),
        platform: std::env::consts::OS.into(),
        read_roots,
        write_roots,
        write_denied,
        read_denied,
        read_denied_globs: resolved.deny_globs,
        session_only_config: !resolved.devbox,
        devbox: resolved.devbox,
        restrict_network: resolved.restrict_network,
        network_note: network_note(resolved.restrict_network),
        shell_env,
        limits,
    };
    // Every rule must be expressible and resolved before the report says
    // the profile is applied. A dead rule is refused, not shown as enforced.
    deny_tail(&prepared)?;
    Ok(Some(prepared))
}

pub fn apply(prepared: &Prepared) -> Result<(), Refusal> {
    if ACTIVE.get().is_some() {
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    if !prepared.read_denied_globs.is_empty() {
        return Err(Refusal {
            message: format!(
                "refusing sandbox profile {}: Linux cannot kernel-deny globs created after launch ({}); name exact paths or run on macOS",
                prepared.name,
                prepared
                    .read_denied_globs
                    .iter()
                    .map(|glob| glob.pattern.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        });
    }
    let mut caps = CapabilitySet::new();
    for root in &prepared.read_roots {
        caps = grant(caps, root, AccessMode::Read, &prepared.name)?;
    }
    for root in &prepared.write_roots {
        caps = grant(caps, root, AccessMode::ReadWrite, &prepared.name)?;
    }
    for directory in pinned_directories(prepared) {
        // Metadata read only. A write grant here would reopen the directory.
        caps = grant(caps, &directory, AccessMode::Read, &prepared.name)?;
    }
    if prepared.restrict_network {
        caps.set_network_blocked(true);
    }
    for path in &prepared.write_denied {
        caps = deny_subpath(caps, path, false, &prepared.name)?;
    }
    for directory in pinned_directories(prepared) {
        caps = pin_directory(caps, &directory, &prepared.name)?;
    }
    for path in &prepared.read_denied {
        caps = deny_subpath(caps, path, true, &prepared.name)?;
    }
    for glob in &prepared.read_denied_globs {
        caps = deny_glob(caps, glob, &prepared.write_roots, &prepared.name)?;
    }
    // nono emits platform rules before its own write allows. Seatbelt uses the
    // last match, so a write grant on $GROK_HOME would reopen config.toml.
    // Append the same denies after Sandbox builds the profile.
    let tail = deny_tail(prepared)?;
    match apply_with_tail(&caps, &tail) {
        Ok(()) => {
            let _ = ACTIVE.set(prepared.clone());
            Ok(())
        }
        Err(error) => Err(Refusal {
            message: format!(
                "refusing sandbox profile {}: kernel policy was not applied ({error})",
                prepared.name
            ),
        }),
    }
}

/// The dsh overlay used while a profile is applied to this process.
///
/// A process already under Seatbelt cannot apply another policy to itself or
/// a child (`sandbox_apply: Operation not permitted`), so dsh's per-call
/// `sandbox-exec` wrapper refuses every bash command. The kernel policy here
/// already confines dsh and every child, so dsh's own per-call file mode is
/// set to `danger-full-access`. The approval rows are not touched: fresh
/// sessions keep `approval: ask`, and codsh's own approval plugin still asks.
/// Patch rows replace a row's whole config, so both rows are restated.
pub fn dsh_overlay(workspace: &Path) -> Option<String> {
    ACTIVE.get()?;
    let root = workspace.display().to_string().replace('\'', "''");
    Some(format!(
        "# Written by codsh-rust while a filesystem sandbox profile is applied.\n\
         - id: sandbox-policy\n  config:\n    mode: danger-full-access\n    workspaceRoot: '{root}'\n\
         - id: permission\n  config:\n    presets:\n\
         \x20     codsh-kernel-sandbox:\n        sandbox: danger-full-access\n        approval: ask\n\
         \x20     read-only:\n        sandbox: read-only\n        approval: ask\n\
         \x20     workspace-write:\n        sandbox: workspace-write\n        approval: ask\n\
         \x20     danger-full-access:\n        sandbox: danger-full-access\n        approval: never\n\
         \x20   defaultPreset: codsh-kernel-sandbox\n"
    ))
}

pub fn status_line(prepared: Option<&Prepared>) -> String {
    match prepared {
        Some(prepared) => prepared.summary.clone(),
        None => "sandbox off (no filesystem confinement)".into(),
    }
}

/// What this process can actually enforce. A macOS run does not claim the
/// Linux mechanism, and a requested restriction that cannot be enforced is
/// refused by the caller rather than recorded as applied.
fn network_enforceable(profile: &str) -> Result<(), Refusal> {
    match std::env::consts::OS {
        "macos" => Ok(()),
        "linux" => Err(Refusal {
            message: format!(
                "refusing sandbox profile {profile}: restrict_network needs a Linux seccomp child filter, which is not applied by this Landlock profile. Startup is refused instead of continuing with network open."
            ),
        }),
        other => Err(Refusal {
            message: format!(
                "refusing sandbox profile {profile}: network isolation is not enforceable on {other}"
            ),
        }),
    }
}

fn network_note(restricted: bool) -> String {
    if !restricted {
        return format!(
            "network unrestricted ({}); dsh per-call file mode is not a network sandbox",
            mechanism_name()
        );
    }
    match std::env::consts::OS {
        "macos" => "network denied by macOS Seatbelt (deny network*) for this process and its children; dsh per-call file mode is not this control".into(),
        "linux" => "network restriction requested; Linux seccomp is not applied by this profile".into(),
        other => format!("network restriction requested; not enforceable on {other}"),
    }
}

fn platform_network_limit(restricted: bool) -> String {
    let base = "macOS Seatbelt denies network* for a restrict_network profile, including the in-process client and every child. Linux Landlock network is a different mechanism and is not claimed from a macOS run; a profile that asks for network isolation refuses startup there. Windows network confinement is not implemented. dsh's per-call file mode is not a network sandbox. The shell environment policy filters a shell child this client starts (sh -c) and the dsh process. dsh's bash tool is built from that process environment, so it sees the same filter. A second Seatbelt profile is not applied inside this one.";
    if restricted {
        format!("{base} This profile restricts network.")
    } else {
        base.into()
    }
}

/// Names a shell child keeps when `inherit = "core"`. A secret is not here.
const CORE_ENV: &[&str] = &[
    "HOME",
    "USERPROFILE",
    "LOGNAME",
    "USER",
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TZ",
];

/// Build the environment a shell child may see. An unknown `inherit` value,
/// or a pattern this filter cannot express, refuses instead of keeping the
/// secret.
fn filter_launch_env(
    policy: &ShellEnvironmentPolicy,
    parent: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, Refusal> {
    let inherit = policy.inherit.as_deref().unwrap_or("all").trim();
    let mut env = match inherit {
        "all" => parent.clone(),
        "core" => parent
            .iter()
            .filter(|(key, _)| CORE_ENV.iter().any(|core| core.eq_ignore_ascii_case(key)))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        "none" => BTreeMap::new(),
        other => {
            return Err(Refusal {
                message: format!(
                    "refusing sandbox: shell_environment_policy.inherit {other:?} is not all, core, or none"
                ),
            });
        }
    };
    if !policy.ignore_default_excludes {
        env.retain(|key, _| !default_secret_name(key));
    }
    for pattern in &policy.exclude {
        validate_env_pattern(pattern)?;
        env.retain(|key, _| !env_glob_match(pattern, key));
    }
    for (key, value) in &policy.set {
        validate_env_name(key)?;
        env.insert(key.clone(), value.clone());
    }
    if !policy.include_only.is_empty() {
        for pattern in &policy.include_only {
            validate_env_pattern(pattern)?;
        }
        env.retain(|key, _| {
            policy
                .include_only
                .iter()
                .any(|pattern| env_glob_match(pattern, key))
        });
    }
    Ok(env)
}

fn default_secret_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.contains("KEY") || upper.contains("SECRET") || upper.contains("TOKEN")
}

fn validate_env_name(name: &str) -> Result<(), Refusal> {
    if name.is_empty() || name.contains(['=', '\0']) || name.chars().any(char::is_control) {
        return Err(Refusal {
            message: format!(
                "refusing sandbox: shell_environment_policy name {name:?} cannot be set"
            ),
        });
    }
    Ok(())
}

fn validate_env_pattern(pattern: &str) -> Result<(), Refusal> {
    if pattern.is_empty()
        || pattern.contains(['=', '\0', '[', ']'])
        || pattern.chars().any(char::is_control)
    {
        return Err(Refusal {
            message: format!(
                "refusing sandbox: shell_environment_policy pattern {pattern:?} is not a * or ? glob"
            ),
        });
    }
    Ok(())
}

/// Case-insensitive `*` / `?`. `*` matches any run, including empty.
fn env_glob_match(pattern: &str, name: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().flat_map(char::to_lowercase).collect();
    let name: Vec<char> = name.chars().flat_map(char::to_lowercase).collect();
    fn rec(pattern: &[char], name: &[char]) -> bool {
        match (pattern.first(), name.first()) {
            (None, None) => true,
            (Some('*'), _) => {
                rec(&pattern[1..], name) || (!name.is_empty() && rec(pattern, &name[1..]))
            }
            (Some('?'), Some(_)) => rec(&pattern[1..], &name[1..]),
            (Some(left), Some(right)) if left == right => rec(&pattern[1..], &name[1..]),
            _ => false,
        }
    }
    rec(&pattern, &name)
}

fn mechanism_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "Seatbelt",
        "linux" => "Landlock",
        other => other,
    }
}

fn grant(
    caps: CapabilitySet,
    path: &Path,
    mode: AccessMode,
    profile: &str,
) -> Result<CapabilitySet, Refusal> {
    if !path.exists()
        && let Err(error) = fs::create_dir_all(path)
    {
        return Err(Refusal {
            message: format!(
                "refusing sandbox profile {profile}: cannot prepare {} ({error})",
                path.display()
            ),
        });
    }
    let is_file = path.is_file();
    let granted = if is_file {
        caps.allow_file(path, mode)
    } else {
        caps.allow_path(path, mode)
    };
    granted.map_err(|error| Refusal {
        message: format!(
            "refusing sandbox profile {profile}: cannot grant {} on {} ({error})",
            access_name(mode),
            path.display()
        ),
    })
}

/// The path as written plus the path the kernel will check. Seatbelt matches
/// resolved paths: `/tmp/x` is checked as `/private/tmp/x`, and a file under a
/// symlinked directory is checked at the link target. A path that does not
/// exist yet is resolved through its deepest existing ancestor, so a rule for
/// a file created later still matches. A dangling or unreadable symlink, a
/// control character, or a non-UTF-8 path cannot be written as a rule that
/// matches, so it refuses instead of producing a dead deny.
fn resolved_forms(path: &Path) -> Result<Vec<PathBuf>, Refusal> {
    expressible(path)?;
    let mut forms = vec![path.to_path_buf()];
    let resolved = resolve_through_existing_ancestor(path)?;
    expressible(&resolved)?;
    if resolved != path {
        forms.push(resolved);
    }
    Ok(forms)
}

fn expressible(path: &Path) -> Result<(), Refusal> {
    let Some(text) = path.to_str() else {
        return Err(Refusal {
            message: format!(
                "refusing sandbox: {} is not UTF-8 and cannot be written as a kernel rule",
                path.display()
            ),
        });
    };
    if text.chars().any(char::is_control) {
        return Err(Refusal {
            message: format!(
                "refusing sandbox: {text:?} contains a control character and cannot be written as a kernel rule"
            ),
        });
    }
    Ok(())
}

fn resolve_through_existing_ancestor(path: &Path) -> Result<PathBuf, Refusal> {
    let mut existing = path.to_path_buf();
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(&existing) {
            Ok(_) => break,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                let (Some(name), Some(parent)) = (existing.file_name(), existing.parent()) else {
                    return Err(Refusal {
                        message: format!(
                            "refusing sandbox: no existing ancestor of {} can be resolved",
                            path.display()
                        ),
                    });
                };
                missing.push(name.to_os_string());
                existing = parent.to_path_buf();
            }
            Err(error) => {
                return Err(Refusal {
                    message: format!(
                        "refusing sandbox: cannot resolve {} for a deny rule ({error})",
                        existing.display()
                    ),
                });
            }
        }
    }
    let canonical = existing.canonicalize().map_err(|error| Refusal {
        message: format!(
            "refusing sandbox: cannot resolve {} for a deny rule of {} ({error}); a dangling symlink cannot be denied at its real path",
            existing.display(),
            path.display()
        ),
    })?;
    Ok(missing
        .iter()
        .rev()
        .fold(canonical, |resolved, name| resolved.join(name)))
}

fn tail_marker() -> String {
    "\n;; codsh-deny-tail\n".into()
}

pub fn deny_tail(prepared: &Prepared) -> Result<String, Refusal> {
    let mut tail = String::new();
    for path in &prepared.write_denied {
        for form in resolved_forms(path)? {
            tail.push_str(&deny_rule(&form, false));
            tail.push('\n');
        }
    }
    // Last match wins. A file deny does not stop renaming that file's parent
    // onto a write root, which would make the protected bytes writable again.
    for directory in pinned_directories(prepared) {
        for form in resolved_forms(&directory)? {
            tail.push_str(&pin_rule(&form));
            tail.push('\n');
        }
    }
    for path in &prepared.read_denied {
        for form in resolved_forms(path)? {
            tail.push_str(&deny_rule(&form, true));
            tail.push('\n');
        }
    }
    for glob in &prepared.read_denied_globs {
        for regex in glob_regexes(glob)? {
            tail.push_str(&format!("(deny file-read* file-write* (regex {regex}))\n"));
        }
        // After the file deny. A directory created inside the glob tail is
        // not a path that exists at launch, so a literal pin cannot name it.
        // The regex covers that directory whenever it is created. Last match
        // still denies its rename onto another write root.
        for regex in glob_directory_regexes(glob, &prepared.write_roots)? {
            tail.push_str(&directory_pin_rule(&regex));
            tail.push('\n');
        }
    }
    Ok(tail)
}

/// Ancestors of a protected path, from its parent up through the write root
/// that contains it. The immediate parent is not enough: renaming a
/// grandparent onto another write root carries the protected file out.
/// The containing write root is included. `$GROK_HOME` is that root for
/// config and hooks, and a workspace root is that root for a nested hook.
/// Ancestors above the write root are not pinned. The stop compares
/// resolved paths: `/private/tmp` is the write root `/tmp`, so a workspace
/// under `/tmp` does not pin `/tmp` or `/private/tmp`.
///
/// A deny glob is anchored at its literal prefix, so renaming that prefix
/// directory (or an ancestor of it under the write root) moves the whole
/// matched subtree out from under the runtime regex. The glob's literal
/// root is therefore pinned starting at the directory itself, not its parent.
/// A directory inside the tail is not pinned here: it may be created after
/// launch, so no literal path exists to name. `glob_directory_regexes`
/// denies renaming any such directory. A rename that stays under the glob
/// would still match the file regex; a rename onto another write root would
/// not, which is why the directory itself is pinned.
fn pinned_directories(prepared: &Prepared) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let pin_chain = |start: Option<&Path>, directories: &mut Vec<PathBuf>| {
        let mut current = start;
        while let Some(directory) = current {
            if directory.as_os_str().is_empty() || directory == Path::new("/") {
                break;
            }
            if !under_resolved_write_root(directory, &prepared.write_roots).unwrap_or(false) {
                break;
            }
            // A temp write root is not pinned. `/tmp` is a symlink to
            // `/private/tmp`, and pinning that vnode denies renaming any
            // directory that lives under it.
            let reached = write_root_reached(directory, &prepared.write_roots).unwrap_or(false);
            let temp_root = reached && is_temp_write_root(directory);
            if directory.is_dir()
                && !temp_root
                && !directories
                    .iter()
                    .any(|existing: &PathBuf| existing == directory)
            {
                directories.push(directory.to_path_buf());
            }
            if reached {
                break;
            }
            current = directory.parent();
        }
    };
    for path in prepared
        .write_denied
        .iter()
        .chain(prepared.read_denied.iter())
    {
        pin_chain(path.parent(), &mut directories);
    }
    for glob in &prepared.read_denied_globs {
        pin_chain(Some(glob.root.as_path()), &mut directories);
    }
    directories
}

/// Resolved containment. `path.starts_with("/tmp")` is true for
/// `/private/tmp`, which is the `/tmp` write root itself.
fn under_resolved_write_root(path: &Path, roots: &[PathBuf]) -> Result<bool, Refusal> {
    let path = resolve_through_existing_ancestor(path)?;
    for root in roots {
        if root.as_os_str().is_empty() || root == Path::new("/") {
            continue;
        }
        let root = resolve_through_existing_ancestor(root)?;
        if path.starts_with(&root) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// True when `directory` is a write root, including `/tmp` and `/private/tmp`.
fn write_root_reached(directory: &Path, write_roots: &[PathBuf]) -> Result<bool, Refusal> {
    let directory = resolve_through_existing_ancestor(directory)?;
    for root in write_roots {
        if root.as_os_str().is_empty() || root == Path::new("/") {
            continue;
        }
        let resolved = resolve_through_existing_ancestor(root)?;
        if resolved == directory {
            return Ok(true);
        }
    }
    Ok(false)
}

fn is_temp_write_root(directory: &Path) -> bool {
    temp_roots()
        .iter()
        .any(|root| write_root_reached(directory, std::slice::from_ref(root)).unwrap_or(false))
}

/// Block renaming or unlinking the directory itself. `file-write-unlink`
/// does not cover creating or rewriting children, so session files stay writable.
fn pin_rule(path: &Path) -> String {
    let escaped = seatbelt_string(&path.display().to_string());
    format!("(deny file-write-unlink (literal {escaped}))")
}

/// Block renaming or unlinking a directory the glob can match, including one
/// created after launch. `vnode-type DIRECTORY` is required: a bare regex
/// also matches files, and then a note next to a denied key could not be
/// renamed. Creating and rewriting children stays allowed.
fn directory_pin_rule(regex: &str) -> String {
    format!("(deny file-write-unlink (require-all (vnode-type DIRECTORY) (regex {regex})))")
}

/// Seatbelt regexes for directories under a deny glob. The file regex only
/// matches the protected file, so renaming a directory that contains it onto
/// another write root (`/tmp`, an in-workspace `public/`, or a sibling of an
/// absolute glob root) carries the file out from under that regex. The regex
/// matches the directory being renamed, including one created after launch.
/// Seatbelt does not see the destination, so the rename is denied even when
/// the new path would still match. A directory that cannot contain a match
/// is not covered: `secrets/other` stays renameable under `secrets/sub/*.key`.
fn glob_directory_regexes(
    glob: &DenyGlob,
    write_roots: &[PathBuf],
) -> Result<Vec<String>, Refusal> {
    let mut regexes = Vec::new();
    let forms = resolved_forms(&glob.root).map_err(|refusal| Refusal {
        message: format!("{} (deny glob {})", refusal.message, glob.pattern),
    })?;
    for form in forms {
        let root = form.to_str().ok_or_else(|| Refusal {
            message: format!(
                "refusing sandbox: glob root {} is not UTF-8",
                form.display()
            ),
        })?;
        let ancestors = directory_ancestors(&form, write_roots)?;
        // A leading `**` on a write root would pin every directory under it.
        // A narrower root (`secrets`) still pins the directories under it.
        let root_is_write_root = write_root_reached(Path::new(root), write_roots)?;
        let regex = glob_directory_regex(root, &glob.tail, &ancestors, root_is_write_root)
            .map_err(|message| Refusal {
                message: format!("refusing sandbox: {message} (deny glob {})", glob.pattern),
            })?;
        if !regexes.contains(&regex) {
            regexes.push(regex);
        }
    }
    Ok(regexes)
}

/// Parents of the glob root, up through the write root that contains it.
/// A literal pin only names a directory that already exists. These stay in
/// the regex so a prefix created after launch cannot be renamed away either.
/// The walk stops at the resolved write root and does not emit that root
/// when it is `/tmp`: `/private/tmp` equals `/tmp` after resolution, and a
/// pin of that vnode denies renaming any directory under it.
fn directory_ancestors(path: &Path, write_roots: &[PathBuf]) -> Result<Vec<String>, Refusal> {
    let mut ancestors = Vec::new();
    let mut current = path.parent();
    while let Some(directory) = current {
        if directory.as_os_str().is_empty() || directory == Path::new("/") {
            break;
        }
        if write_root_reached(directory, write_roots)? {
            if !is_temp_write_root(directory)
                && let Some(text) = directory.to_str()
            {
                ancestors.push(text.to_string());
            }
            break;
        }
        if !under_resolved_write_root(directory, write_roots)? {
            break;
        }
        let Some(text) = directory.to_str() else {
            break;
        };
        ancestors.push(text.to_string());
        current = directory.parent();
    }
    Ok(ancestors)
}

fn glob_directory_regex(
    root: &str,
    tail: &str,
    ancestors: &[String],
    root_is_write_root: bool,
) -> Result<String, String> {
    // Seatbelt checks the path without a trailing slash. Each segment
    // therefore starts with `/`; a pattern that ends in `/` misses the rename.
    let segments = directory_tail_segments(tail);
    let star = segments.iter().position(|segment| *segment == "**");
    let prefix = match star {
        Some(index) => &segments[..index],
        None => segments.as_slice(),
    };
    // `**` can put a match under any later directory. Names after `**` do
    // not narrow the pin: that directory is an ancestor of the match.
    // A leading `**` whose root is a write root (a workspace `**/.env`)
    // does not pin every directory under that root: the file regex still
    // covers the matched file, and pinning the tree would deny renaming a
    // directory that the caller can move onto another directory of the
    // same write root. A narrower root keeps the descendant pin.
    let mut chain = if star.is_some() && !(prefix.is_empty() && root_is_write_root) {
        "(/[^/]+)*".to_string()
    } else {
        String::new()
    };
    for segment in prefix.iter().rev() {
        let mut piece = String::from("(/");
        append_segment_regex(&mut piece, segment)?;
        piece.push_str(&chain);
        piece.push_str(")?");
        chain = piece;
    }
    let mut body = String::new();
    for ancestor in ancestors {
        if !body.is_empty() {
            body.push('|');
        }
        for ch in ancestor.chars() {
            push_regex_literal(&mut body, ch);
        }
    }
    // `*.key` makes the glob root the same directory as its write-root
    // ancestor and adds no further directory. Emitting it twice is noise.
    let root_already = chain.is_empty() && ancestors.iter().any(|ancestor| ancestor == root);
    if !root_already {
        if !body.is_empty() {
            body.push('|');
        }
        if root != "/" {
            for ch in root.chars() {
                push_regex_literal(&mut body, ch);
            }
        }
        body.push_str(&chain);
    }
    Ok(seatbelt_string(&format!("^({body})$")))
}

/// Tail segments that name a directory. The last segment is the file, so
/// `secrets/**/*.key` contributes `**` and `sub/*.key` contributes `sub`.
/// A trailing `**` (`certs/**`) is itself a directory and stays.
fn directory_tail_segments(tail: &str) -> Vec<&str> {
    if tail.is_empty() {
        return Vec::new();
    }
    let mut segments: Vec<&str> = tail.split('/').collect();
    if segments.last().is_some_and(|segment| *segment != "**") {
        segments.pop();
    }
    segments
}

fn append_segment_regex(regex: &mut String, segment: &str) -> Result<(), String> {
    let chars: Vec<char> = segment.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '*' if chars.get(index + 1) == Some(&'*') => {
                return Err(format!("unsupported deny glob directory segment {segment}"));
            }
            '*' => {
                regex.push_str("[^/]*");
                index += 1;
            }
            '?' => {
                regex.push_str("[^/]");
                index += 1;
            }
            '[' => {
                let class = seatbelt_class(&chars, index, segment)?;
                regex.push_str(&class.text);
                index = class.next;
            }
            other => {
                push_regex_literal(regex, other);
                index += 1;
            }
        }
    }
    Ok(())
}

fn pin_directory(
    caps: CapabilitySet,
    path: &Path,
    profile: &str,
) -> Result<CapabilitySet, Refusal> {
    let mut rule = String::new();
    for form in resolved_forms(path)? {
        if !rule.is_empty() {
            rule.push(' ');
        }
        rule.push_str(&pin_rule(&form));
    }
    #[cfg(target_os = "macos")]
    {
        caps.platform_rule(rule).map_err(|error| Refusal {
            message: format!(
                "refusing sandbox profile {profile}: cannot pin {} ({error})",
                path.display()
            ),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (caps, rule);
        Err(Refusal {
            message: format!(
                "refusing sandbox profile {profile}: cannot pin {} against a directory rename without a macOS Seatbelt unlink deny",
                path.display()
            ),
        })
    }
}

fn deny_rule(path: &Path, also_read: bool) -> String {
    let escaped = seatbelt_string(&path.display().to_string());
    if also_read {
        format!(
            "(deny file-read* file-write* (subpath {escaped})) (deny file-read* file-write* (literal {escaped}))"
        )
    } else {
        format!("(deny file-write* (subpath {escaped})) (deny file-write* (literal {escaped}))")
    }
}

#[cfg(target_os = "macos")]
fn apply_with_tail(caps: &CapabilitySet, tail: &str) -> Result<(), String> {
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;
    unsafe extern "C" {
        fn sandbox_init(profile: *const c_char, flags: u64, errorbuf: *mut *mut c_char) -> i32;
        fn sandbox_free_error(errorbuf: *mut c_char);
    }
    let base = nono_profile(caps, tail)?;
    let profile = CString::new(base).map_err(|error| error.to_string())?;
    let mut error_buf: *mut c_char = std::ptr::null_mut();
    let result = unsafe { sandbox_init(profile.as_ptr(), 0, &mut error_buf) };
    if result != 0 {
        let message = if error_buf.is_null() {
            format!("sandbox_init returned {result}")
        } else {
            let message = unsafe { CStr::from_ptr(error_buf) }
                .to_string_lossy()
                .into_owned();
            unsafe { sandbox_free_error(error_buf) };
            message
        };
        return Err(message);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn apply_with_tail(caps: &CapabilitySet, _tail: &str) -> Result<(), String> {
    Sandbox::apply(caps)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// The Seatbelt profile `nono` 0.53 would install for these capabilities.
/// Exceptions inside a write root must be appended after it: Seatbelt keeps
/// the last matching rule, and nono emits platform denies before write allows.
#[cfg(target_os = "macos")]
fn nono_profile(caps: &CapabilitySet, tail: &str) -> Result<String, String> {
    use std::collections::HashSet;
    let mut profile = String::from("(version 1)\n(deny default)\n");
    profile.push_str("(allow process-exec*)\n(allow process-fork)\n");
    profile.push_str("(allow process-info* (target self))\n");
    profile.push_str("(allow process-info* (target same-sandbox))\n");
    profile.push_str("(allow sysctl-read)\n(allow mach-lookup)\n");
    // nono 0.53 denies these unless a keychain db is an explicit grant.
    // A blanket mach-lookup otherwise retrieves credentials past file denies.
    if !explicit_keychain_db(caps) {
        for name in [
            "com.apple.SecurityServer",
            "com.apple.securityd",
            "com.apple.security.keychaind",
            "com.apple.secd",
            "com.apple.security.agent",
        ] {
            profile.push_str(&format!("(deny mach-lookup (global-name \"{name}\"))\n"));
        }
    }
    profile.push_str("(allow mach-per-user-lookup)\n(allow mach-task-name)\n(deny mach-priv*)\n");
    profile.push_str("(allow ipc-posix-shm-read-data)\n(allow ipc-posix-shm-write-data)\n");
    profile.push_str("(allow ipc-posix-shm-write-create)\n");
    profile.push_str("(allow signal (target self))\n(allow signal (target same-sandbox))\n");
    profile.push_str("(allow system-fsctl)\n(allow system-info)\n");
    profile.push_str("(allow file-read* (literal \"/\"))\n");
    let mut parents = HashSet::new();
    for cap in caps.fs_capabilities() {
        for path in [&cap.resolved, &cap.original] {
            let mut current = path.parent();
            while let Some(parent) = current {
                let text = parent.to_string_lossy().to_string();
                if text == "/" || text.is_empty() || !parents.insert(text) {
                    break;
                }
                current = parent.parent();
            }
        }
    }
    for parent in &parents {
        profile.push_str(&format!(
            "(allow file-read-metadata (literal {}))\n",
            seatbelt_string(parent)
        ));
    }
    profile.push_str("(allow file-ioctl (literal \"/dev/tty\"))\n");
    profile.push_str("(allow file-ioctl (regex #\"^/dev/ttys[0-9]+$\"))\n");
    profile.push_str("(allow file-ioctl (regex #\"^/dev/pty[a-z][0-9a-f]+$\"))\n");
    // Devices the process needs. A subpath grant of all of /dev also opens
    // raw disks such as /dev/disk0; nono does not emit that blanket read.
    for device in [
        "/dev/null",
        "/dev/dtracehelper",
        "/dev/urandom",
        "/dev/random",
    ] {
        profile.push_str(&format!("(allow file-read-data (literal \"{device}\"))\n"));
    }
    profile.push_str("(allow file-write* (literal \"/dev/null\"))\n");
    profile.push_str("(allow file-ioctl (literal \"/dev/dtracehelper\"))\n");
    profile.push_str("(allow file-ioctl (literal \"/dev/null\"))\n");
    profile.push_str("(allow pseudo-tty)\n");
    for cap in caps.fs_capabilities() {
        if matches!(cap.access, AccessMode::Read | AccessMode::ReadWrite) {
            for (path, file) in [(&cap.resolved, cap.is_file), (&cap.original, cap.is_file)] {
                let Some(text) = path.to_str() else { continue };
                let kind = if file { "literal" } else { "subpath" };
                profile.push_str(&format!(
                    "(allow file-read* ({kind} {}))\n",
                    seatbelt_string(text)
                ));
                profile.push_str(&format!(
                    "(allow file-map-executable ({kind} {}))\n",
                    seatbelt_string(text)
                ));
            }
        }
    }
    for rule in caps.platform_rules() {
        profile.push_str(rule);
        profile.push('\n');
    }
    for cap in caps.fs_capabilities() {
        if matches!(cap.access, AccessMode::Write | AccessMode::ReadWrite) {
            for (path, file) in [(&cap.resolved, cap.is_file), (&cap.original, cap.is_file)] {
                let Some(text) = path.to_str() else { continue };
                let kind = if file { "literal" } else { "subpath" };
                profile.push_str(&format!(
                    "(allow file-write* ({kind} {}))\n",
                    seatbelt_string(text)
                ));
            }
        }
    }
    // Seatbelt keeps the last equally specific match. A write allow on the
    // directory that holds a protected file would otherwise reopen a rename
    // of that directory. These denies follow every write allow.
    profile.push_str(tail);
    profile.push_str(&tail_marker());
    profile.push_str(&network_rules(caps.network_mode()));
    Ok(profile)
}

/// The network rules this profile will install, empty when no profile is
/// applied. The probe reads this from the report and checks the same text
/// the kernel received.
pub fn network_profile_rules(prepared: &Prepared) -> Result<String, Refusal> {
    #[cfg(target_os = "macos")]
    {
        let mode = if prepared.restrict_network {
            nono::NetworkMode::Blocked
        } else {
            nono::NetworkMode::AllowAll
        };
        Ok(network_rules(&mode))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = prepared;
        Ok(String::new())
    }
}

/// Seatbelt network rules for the mode the profile selected.
///
/// `Blocked` is `(deny network*)`. Last match wins, so this deny is not
/// followed by an allow. Unix-domain sockets are `network-outbound` on
/// macOS; local IPC the process still needs (the listener, mDNS) is named.
/// `AllowAll` is the unrestricted profile. This is not a dsh file mode.
#[cfg(target_os = "macos")]
fn network_rules(mode: &nono::NetworkMode) -> String {
    match mode {
        nono::NetworkMode::Blocked => "\
(deny network*)
(allow system-socket (socket-domain AF_UNIX) (socket-type SOCK_STREAM))
(allow network-outbound (path \"/private/var/run/mDNSResponder\"))
(allow network-outbound (path \"/var/run/mDNSResponder\"))
(allow system-socket (socket-domain AF_INET) (socket-type SOCK_STREAM))
(allow system-socket (socket-domain AF_INET6) (socket-type SOCK_STREAM))
"
        .into(),
        nono::NetworkMode::AllowAll => "\
(allow system-socket)
(allow network-outbound)
(allow network-inbound)
(allow network-bind)
"
        .into(),
        nono::NetworkMode::ProxyOnly { .. } => String::new(),
    }
}

/// True when a capability names a keychain database itself, not a parent
/// such as `/Library`. Those grants are the nono opt-in that skips the
/// keychain mach-lookup denies.
#[cfg(target_os = "macos")]
fn explicit_keychain_db(caps: &CapabilitySet) -> bool {
    let user = std::env::var_os("HOME").map(PathBuf::from);
    caps.fs_capabilities().iter().any(|cap| {
        [&cap.resolved, &cap.original].iter().any(|path| {
            let name = path.file_name().and_then(|name| name.to_str());
            let keychain_db = matches!(name, Some("login.keychain-db" | "metadata.keychain-db"));
            if !keychain_db {
                return false;
            }
            path.starts_with("/Library/Keychains")
                || user
                    .as_ref()
                    .is_some_and(|home| path.starts_with(home.join("Library/Keychains")))
        })
    })
}

fn deny_subpath(
    caps: CapabilitySet,
    path: &Path,
    also_read: bool,
    profile: &str,
) -> Result<CapabilitySet, Refusal> {
    let mut rule = String::new();
    for form in resolved_forms(path)? {
        if !rule.is_empty() {
            rule.push(' ');
        }
        rule.push_str(&deny_rule(&form, also_read));
    }
    #[cfg(target_os = "macos")]
    {
        caps.platform_rule(rule).map_err(|error| Refusal {
            message: format!(
                "refusing sandbox profile {profile}: cannot deny {} ({error})",
                path.display()
            ),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (caps, rule, also_read);
        // Landlock is allow-only. A write grant on a parent cannot be narrowed
        // by a later deny, and a read-only bind is not available here.
        Err(Refusal {
            message: format!(
                "refusing sandbox profile {profile}: deny of {} needs a macOS Seatbelt subpath or a Linux bubblewrap bind, which is not available here",
                path.display()
            ),
        })
    }
}

fn deny_glob(
    caps: CapabilitySet,
    glob: &DenyGlob,
    write_roots: &[PathBuf],
    profile: &str,
) -> Result<CapabilitySet, Refusal> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (caps, write_roots);
        return Err(Refusal {
            message: format!(
                "refusing sandbox profile {profile}: glob deny {} is not kernel-enforced on {}",
                glob.pattern,
                std::env::consts::OS
            ),
        });
    }
    #[cfg(target_os = "macos")]
    {
        let mut rule = String::new();
        for regex in glob_regexes(glob)? {
            if !rule.is_empty() {
                rule.push(' ');
            }
            rule.push_str(&format!("(deny file-read* file-write* (regex {regex}))"));
        }
        // Same directory pin as the tail. An empty root list would treat a
        // workspace `**` as pinning every directory under that workspace.
        for regex in glob_directory_regexes(glob, write_roots)? {
            if !rule.is_empty() {
                rule.push(' ');
            }
            rule.push_str(&directory_pin_rule(&regex));
        }
        caps.platform_rule(rule).map_err(|error| Refusal {
            message: format!(
                "refusing sandbox profile {profile}: glob deny {} was not accepted ({error})",
                glob.pattern
            ),
        })
    }
}

fn access_name(mode: AccessMode) -> &'static str {
    match mode {
        AccessMode::Read => "read",
        AccessMode::Write => "write",
        AccessMode::ReadWrite => "read-write",
    }
}

fn display_paths(paths: &[PathBuf]) -> String {
    if paths.is_empty() {
        return "(none)".into();
    }
    paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn system_read_roots() -> Vec<PathBuf> {
    [
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/opt",
        "/System",
        "/Library",
        "/private/var",
        "/dev",
        "/etc",
        "/opt/homebrew",
        "/Applications",
        "/var",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

fn temp_roots() -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/tmp"),
        PathBuf::from("/private/tmp"),
        PathBuf::from("/var/tmp"),
        PathBuf::from("/private/var/tmp"),
    ];
    if let Some(value) = std::env::var_os("TMPDIR") {
        let path = PathBuf::from(value);
        if path.is_dir() && !path.is_symlink() {
            roots.push(path);
        }
    }
    roots
}

fn protected_paths(grok_home: &Path) -> Result<Vec<PathBuf>, Refusal> {
    if is_symlink(grok_home) {
        return Err(Refusal {
            message: format!(
                "refusing sandbox: $GROK_HOME {} is a symlink",
                grok_home.display()
            ),
        });
    }
    let hooks = grok_home.join("hooks");
    ensure_dir(&hooks)?;
    let registry = grok_home.join("hooks-paths");
    ensure_file(&registry)?;
    let mut paths = vec![hooks, registry];
    for name in PROTECTED_FILES {
        if *name == "hooks-paths" {
            continue;
        }
        let path = grok_home.join(name);
        if path.exists() || *name == "config.toml" {
            if !path.exists() {
                ensure_file(&path)?;
            }
            if is_symlink(&path) {
                return Err(Refusal {
                    message: format!("refusing sandbox: {} is a symlink", path.display()),
                });
            }
            paths.push(path);
        }
    }
    if let Ok(text) = fs::read_to_string(grok_home.join("hooks-paths")) {
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if !Path::new(line).is_absolute() {
                continue;
            }
            let target = PathBuf::from(line);
            if !target.exists() {
                return Err(Refusal {
                    message: format!(
                        "refusing sandbox: hooks-paths target {} is missing",
                        target.display()
                    ),
                });
            }
            if path_has_symlink(&target) {
                return Err(Refusal {
                    message: format!(
                        "refusing sandbox: hooks-paths target {} contains a symlink",
                        target.display()
                    ),
                });
            }
            paths.push(target);
        }
    }
    Ok(paths)
}

fn ensure_dir(path: &Path) -> Result<(), Refusal> {
    if path.exists() {
        if is_symlink(path) || !path.is_dir() {
            return Err(Refusal {
                message: format!(
                    "refusing sandbox: {} must be a real directory",
                    path.display()
                ),
            });
        }
        return Ok(());
    }
    fs::create_dir_all(path).map_err(|error| Refusal {
        message: format!(
            "refusing sandbox: cannot create {} ({error})",
            path.display()
        ),
    })
}

fn ensure_file(path: &Path) -> Result<(), Refusal> {
    if path.exists() {
        if is_symlink(path) || !path.is_file() {
            return Err(Refusal {
                message: format!("refusing sandbox: {} must be a real file", path.display()),
            });
        }
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| Refusal {
            message: format!(
                "refusing sandbox: cannot create {} ({error})",
                parent.display()
            ),
        })?;
    }
    let mut file = fs::File::create(path).map_err(|error| Refusal {
        message: format!(
            "refusing sandbox: cannot create {} ({error})",
            path.display()
        ),
    })?;
    file.write_all(b"").ok();
    Ok(())
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn path_has_symlink(path: &Path) -> bool {
    // macOS /var and /tmp are system symlinks. They are not a retarget of an
    // absolute hooks-paths entry that merely lives underneath them.
    let mut cursor = PathBuf::new();
    let mut seen_real_dir = false;
    for component in path.components() {
        match component {
            Component::RootDir | Component::Prefix(_) | Component::CurDir => {
                cursor.push(component);
                continue;
            }
            _ => {}
        }
        cursor.push(component);
        if is_symlink(&cursor) {
            if seen_real_dir || cursor == path {
                return true;
            }
            continue;
        }
        if cursor.is_dir() {
            seen_real_dir = true;
        }
    }
    false
}

fn checked_dsh_home(path: Option<&Path>) -> Result<Option<PathBuf>, Refusal> {
    let Some(path) = path else {
        return Ok(None);
    };
    if path.as_os_str().is_empty() {
        return Ok(None);
    }
    if is_symlink(path) || path_has_symlink(path) {
        return Err(Refusal {
            message: format!(
                "refusing sandbox: DSH_HOME {} contains a symlink",
                path.display()
            ),
        });
    }
    Ok(Some(path.to_path_buf()))
}

fn resolve(
    name: &str,
    workspace: &Path,
    grok_home: &Path,
    dsh_home: Option<&Path>,
    workspace_trusted: bool,
) -> Result<Resolved, Refusal> {
    let dsh_home = checked_dsh_home(dsh_home)?;
    let shell_env = read_shell_policy(workspace, grok_home, workspace_trusted)?;
    if name == "devbox" {
        return Ok(Resolved {
            base: "devbox".into(),
            read_everywhere: true,
            write_workspace: true,
            write_grok: true,
            write_sessions_only: false,
            write_temps: true,
            read_only_extra: Vec::new(),
            read_write_extra: Vec::new(),
            deny_exact: Vec::new(),
            deny_globs: Vec::new(),
            dsh_home,
            devbox: true,
            restrict_network: false,
            shell_env: shell_env.clone(),
            warnings: vec![
                "devbox write-deny of /data is not separately mounted; top-level write is still bounded by the kernel allowlist (workspace, $GROK_HOME, temps)."
                    .into(),
            ],
        });
    }
    let (custom, profile_warnings) = load_custom(name, workspace, grok_home, workspace_trusted)?;
    let base = if BUILTINS.contains(&name) {
        name.to_string()
    } else {
        custom
            .as_ref()
            .and_then(|body| body.extends.clone())
            .unwrap_or_else(|| "workspace".into())
    };
    if !["workspace", "read-only", "strict", "devbox"].contains(&base.as_str()) {
        return Err(Refusal {
            message: format!("refusing sandbox profile {name}: unknown base {base}"),
        });
    }
    if name == "devbox" || base == "devbox" && custom.is_none() {
        return resolve(
            "devbox",
            workspace,
            grok_home,
            dsh_home.as_deref(),
            workspace_trusted,
        );
    }
    let mut resolved = match base.as_str() {
        "workspace" => Resolved {
            base,
            read_everywhere: true,
            write_workspace: true,
            write_grok: true,
            write_sessions_only: false,
            write_temps: true,
            read_only_extra: Vec::new(),
            read_write_extra: Vec::new(),
            deny_exact: Vec::new(),
            deny_globs: Vec::new(),
            dsh_home: dsh_home.clone(),
            devbox: false,
            restrict_network: false,
            shell_env: None,
            warnings: Vec::new(),
        },
        "read-only" => Resolved {
            base,
            read_everywhere: true,
            write_workspace: false,
            write_grok: true,
            write_sessions_only: false,
            write_temps: true,
            read_only_extra: Vec::new(),
            read_write_extra: Vec::new(),
            deny_exact: Vec::new(),
            deny_globs: Vec::new(),
            dsh_home: dsh_home.clone(),
            devbox: false,
            restrict_network: true,
            shell_env: None,
            warnings: Vec::new(),
        },
        "strict" => Resolved {
            base,
            read_everywhere: false,
            write_workspace: true,
            write_grok: false,
            write_sessions_only: true,
            write_temps: true,
            read_only_extra: Vec::new(),
            read_write_extra: Vec::new(),
            deny_exact: Vec::new(),
            deny_globs: Vec::new(),
            dsh_home: dsh_home.clone(),
            devbox: false,
            restrict_network: true,
            shell_env: None,
            warnings: Vec::new(),
        },
        "devbox" => {
            let mut resolved = resolve(
                "devbox",
                workspace,
                grok_home,
                dsh_home.as_deref(),
                workspace_trusted,
            )?;
            resolved.devbox = true;
            resolved
        }
        _ => {
            return Err(Refusal {
                message: format!("refusing sandbox profile {name}: unknown base {base}"),
            });
        }
    };
    resolved.warnings = profile_warnings;
    resolved.shell_env = shell_env;
    if let Some(body) = custom {
        if let Some(flag) = body.restrict_network {
            resolved.restrict_network = flag;
        }
        for entry in &body.read_only {
            match literal_dir(entry, workspace) {
                Ok(path) => resolved.read_only_extra.push(path),
                Err(warning) => resolved.warnings.push(warning),
            }
        }
        for entry in &body.read_write {
            match literal_dir(entry, workspace) {
                Ok(path) => resolved.read_write_extra.push(path),
                Err(warning) => resolved.warnings.push(warning),
            }
        }
        for entry in &body.deny {
            classify_deny(entry, workspace, &mut resolved)?;
        }
        if resolved.base == "devbox" {
            resolved.devbox = true;
            resolved.warnings.push(
                "custom profile extends devbox, so global hook/config write protection is not applied; its deny list is still kernel-enforced."
                    .into(),
            );
        }
    } else if !BUILTINS.contains(&name) {
        return Err(Refusal {
            message: format!(
                "refusing sandbox profile {name}: not a built-in and not defined in sandbox.toml"
            ),
        });
    }
    let _ = grok_home;
    Ok(resolved)
}

fn load_custom(
    name: &str,
    workspace: &Path,
    grok_home: &Path,
    workspace_trusted: bool,
) -> Result<(Option<ProfileBody>, Vec<String>), Refusal> {
    if BUILTINS.contains(&name) {
        return Ok((None, Vec::new()));
    }
    let user_path = grok_home.join("sandbox.toml");
    let project_path = workspace.join(".grok").join("sandbox.toml");
    let user = read_profile_file(&user_path)?;
    let user_defines = user
        .as_ref()
        .is_some_and(|body| body.profiles.contains_key(name));
    // An explicit name does not trust the repo. A user definition is enough
    // on its own: a malformed, unreadable, or symlinked untrusted project
    // file must not veto it. Compare a body that actually parsed so a
    // disagreement can still name both paths. A project-only custom name
    // still refuses without becoming a grant.
    let project = if workspace_trusted {
        read_profile_file(&project_path)?
    } else if user_defines {
        // Err is a malformed, unreadable, or symlinked project file. It is
        // not a comparison and must not refuse the user profile.
        read_profile_file(&project_path).unwrap_or_default()
    } else {
        match read_profile_file(&project_path) {
            Ok(Some(body)) if body.profiles.contains_key(name) => {
                return Err(Refusal {
                    message: format!(
                        "refusing sandbox profile {name}: .grok/sandbox.toml at {} is untrusted. A profile name does not trust project contents. Trust this workspace, or define {name} in {}.",
                        project_path.display(),
                        user_path.display()
                    ),
                });
            }
            Ok(_) => None,
            // No user definition to apply. Stay fail-closed.
            Err(error) => return Err(error),
        }
    };
    let (profile, warnings) = match (user, project) {
        (Some(user_body), Some(project_body)) => {
            let user_profile = user_body.profiles.get(name).cloned();
            let project_profile = project_body.profiles.get(name).cloned();
            match (user_profile, project_profile) {
                (Some(user_profile), Some(project_profile))
                    if !profiles_equal(&user_profile, &project_profile) =>
                {
                    // The public sandbox guide keeps the user definition and
                    // warns. Refusing would hide the documented resolution.
                    let warning = format!(
                        "sandbox profile {name}: user and project sandbox.toml disagree; using the user profile at {}. The project file is {}. Run /doctor to see both locations.",
                        user_path.display(),
                        project_path.display()
                    );
                    (Some(user_profile), vec![warning])
                }
                (Some(user_profile), _) => (Some(user_profile), Vec::new()),
                (None, Some(project_profile)) => (Some(project_profile), Vec::new()),
                (None, None) => (None, Vec::new()),
            }
        }
        (Some(body), None) => (body.profiles.get(name).cloned(), Vec::new()),
        (None, Some(body)) => (body.profiles.get(name).cloned(), Vec::new()),
        (None, None) => (None, Vec::new()),
    };
    Ok((profile, warnings))
}

/// The user file wins, matching profile resolution. An untrusted project
/// file is not read as policy. A missing table leaves the environment as-is.
fn read_shell_policy(
    workspace: &Path,
    grok_home: &Path,
    workspace_trusted: bool,
) -> Result<Option<ShellEnvironmentPolicy>, Refusal> {
    let user = read_profile_file(&grok_home.join("sandbox.toml"))?;
    if let Some(policy) = user.and_then(|body| body.shell_environment_policy) {
        return Ok(Some(policy));
    }
    if !workspace_trusted {
        return Ok(None);
    }
    let project = read_profile_file(&workspace.join(".grok").join("sandbox.toml"))?;
    Ok(project.and_then(|body| body.shell_environment_policy))
}

fn profiles_equal(left: &ProfileBody, right: &ProfileBody) -> bool {
    left.extends == right.extends
        && left.restrict_network == right.restrict_network
        && left.read_only == right.read_only
        && left.read_write == right.read_write
        && left.deny == right.deny
}

fn read_profile_file(path: &Path) -> Result<Option<FileConfig>, Refusal> {
    if !path.exists() {
        return Ok(None);
    }
    if is_symlink(path) {
        return Err(Refusal {
            message: format!("refusing sandbox: {} is a symlink", path.display()),
        });
    }
    let text = fs::read_to_string(path).map_err(|error| Refusal {
        message: format!("refusing sandbox: cannot read {} ({error})", path.display()),
    })?;
    if text.trim().is_empty() {
        return Ok(Some(FileConfig::default()));
    }
    toml::from_str(&text).map(Some).map_err(|error| Refusal {
        message: format!("refusing sandbox: malformed {} ({error})", path.display()),
    })
}

fn literal_dir(entry: &str, workspace: &Path) -> Result<PathBuf, String> {
    if entry != entry.trim() {
        return Err(format!(
            "skipped {entry:?}: leading or trailing whitespace is significant"
        ));
    }
    let mut text = entry.to_string();
    if let Some(stripped) = text.strip_suffix("/**").or_else(|| text.strip_suffix("/*")) {
        text = stripped.to_string();
    }
    if text.is_empty() {
        text = "/".into();
    }
    if text.contains(['*', '?', '[']) {
        return Err(format!(
            "skipped {entry}: read_only/read_write entries are literal directories, not globs"
        ));
    }
    let path = if Path::new(&text).is_absolute() {
        PathBuf::from(text)
    } else {
        workspace.join(text)
    };
    if !path.is_dir() {
        return Err(format!(
            "skipped {}: not an existing directory",
            path.display()
        ));
    }
    Ok(path)
}

fn classify_deny(entry: &str, workspace: &Path, resolved: &mut Resolved) -> Result<(), Refusal> {
    if entry.chars().any(char::is_control) {
        return Err(Refusal {
            message: format!(
                "refusing sandbox: deny entry {entry:?} contains a control character and cannot be written as a kernel rule"
            ),
        });
    }
    if entry.contains(['{', '}'])
        || entry.contains("//")
        || entry.contains('\\')
        || entry.contains("[:")
        || entry.ends_with('/')
        || raw_dot_segment(entry)
    {
        return Err(Refusal {
            message: format!("refusing sandbox: unsupported deny glob {entry}"),
        });
    }
    if entry.contains(['*', '?', '[']) {
        validate_glob(entry)?;
        resolved.deny_globs.push(split_glob(entry, workspace));
        return Ok(());
    }
    let path = if Path::new(entry).is_absolute() {
        PathBuf::from(entry)
    } else {
        workspace.join(entry)
    };
    resolved.deny_exact.push(path);
    Ok(())
}

/// Split at the first segment that holds glob syntax. Only the pattern's own
/// segments are parsed: the workspace a relative glob is anchored at is a
/// literal root even when its name contains `[`, `*`, or `?`.
fn split_glob(pattern: &str, workspace: &Path) -> DenyGlob {
    let (mut root, rest) = match pattern.strip_prefix('/') {
        Some(absolute) => (PathBuf::from("/"), absolute),
        None => (workspace.to_path_buf(), pattern),
    };
    let segments: Vec<&str> = rest.split('/').collect();
    let first = segments
        .iter()
        .position(|segment| segment.contains(['*', '?', '[']))
        .unwrap_or(segments.len());
    for segment in &segments[..first] {
        root.push(segment);
    }
    DenyGlob {
        pattern: pattern.to_string(),
        root,
        tail: segments[first..].join("/"),
    }
}

/// `Path` drops a non-leading `.`, so `a/./secret` would otherwise become
/// `a/secret` and then fail to match the stored raw pattern. The raw text
/// is what the guide refuses.
fn raw_dot_segment(entry: &str) -> bool {
    entry
        .split(['/', '\\'])
        .any(|segment| segment == "." || segment == "..")
}

/// `**` is only a whole path segment (`**/`, `a/**`, `a/**/b`). `**.pem`
/// and `certs/**.pem` are not that form.
fn attached_globstar(pattern: &str) -> bool {
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '*' && chars.get(index + 1) == Some(&'*') {
            let before_ok = index == 0 || chars[index - 1] == '/';
            let after = chars.get(index + 2).copied();
            let after_ok = after.is_none() || after == Some('/');
            if !before_ok || !after_ok {
                return true;
            }
            index += 2;
            continue;
        }
        index += 1;
    }
    false
}

fn validate_glob(pattern: &str) -> Result<(), Refusal> {
    if pattern.is_empty()
        || pattern.contains("//")
        || pattern.ends_with('/')
        || pattern.contains('\\')
        || pattern.contains(['{', '}'])
        || raw_dot_segment(pattern)
        || attached_globstar(pattern)
    {
        return Err(Refusal {
            message: format!("refusing sandbox: unsupported deny glob {pattern}"),
        });
    }
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0;
    let mut class_open = false;
    while index < chars.len() {
        match chars[index] {
            '[' if !class_open => {
                class_open = true;
                index += 1;
            }
            ']' if class_open => {
                class_open = false;
                index += 1;
            }
            _ => index += 1,
        }
    }
    if class_open {
        return Err(Refusal {
            message: format!("refusing sandbox: malformed deny glob {pattern}"),
        });
    }
    Ok(())
}

/// One anchored Seatbelt regex per resolved form of the literal root: the
/// root as written and the path the kernel checks after symlinks.
fn glob_regexes(glob: &DenyGlob) -> Result<Vec<String>, Refusal> {
    let mut regexes = Vec::new();
    let forms = resolved_forms(&glob.root).map_err(|refusal| Refusal {
        message: format!("{} (deny glob {})", refusal.message, glob.pattern),
    })?;
    for form in forms {
        let root = form.to_str().ok_or_else(|| Refusal {
            message: format!(
                "refusing sandbox: glob root {} is not UTF-8",
                form.display()
            ),
        })?;
        let regex = glob_regex(root, &glob.tail).map_err(|message| Refusal {
            message: format!("refusing sandbox: {message} (deny glob {})", glob.pattern),
        })?;
        if !regexes.contains(&regex) {
            regexes.push(regex);
        }
    }
    Ok(regexes)
}

fn glob_regex(root: &str, tail: &str) -> Result<String, String> {
    let mut regex = String::from("^");
    if root != "/" {
        for ch in root.chars() {
            push_regex_literal(&mut regex, ch);
        }
    }
    if !tail.is_empty() {
        regex.push('/');
    }
    let chars: Vec<char> = tail.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '*' if chars.get(index + 1) == Some(&'*') => {
                // `.*` crosses `..` and a same-prefix sibling. One path
                // segment at a time stays inside the anchored directory.
                // Zero segments covers the directory itself. A slash already
                // copied before `**` must not sit in front of the group: that
                // form misses a dotfile such as `.env`.
                if regex.ends_with('/') {
                    regex.pop();
                }
                regex.push_str("(/[^/]+)*");
                index += 2;
            }
            '*' => {
                regex.push_str("[^/]*");
                index += 1;
            }
            '?' => {
                regex.push_str("[^/]");
                index += 1;
            }
            '[' => {
                let class = seatbelt_class(&chars, index, tail)?;
                regex.push_str(&class.text);
                index = class.next;
            }
            other => {
                push_regex_literal(&mut regex, other);
                index += 1;
            }
        }
    }
    regex.push('$');
    Ok(seatbelt_string(&regex))
}

/// Measured with sandbox-exec on macOS: a one-character class matches these
/// metacharacters literally both at the start and after a group. `[^]` is
/// not a class and `[\]` also matched another name after a group, so the
/// caret and backslash take a backslash escape instead.
fn push_regex_literal(regex: &mut String, ch: char) {
    match ch {
        '^' | '\\' => {
            regex.push('\\');
            regex.push(ch);
        }
        '.' | '*' | '?' | '+' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '$' => {
            regex.push('[');
            regex.push(ch);
            regex.push(']');
        }
        _ => regex.push(ch),
    }
}

struct TranslatedClass {
    text: String,
    next: usize,
}

/// Seatbelt treats `!` and `^` inside `[]` as literals, so both glob
/// negations become `[^...]`. A POSIX class, an empty class, and a caret
/// that would have to be literal are refused: none of those keep the glob
/// meaning under this regex.
fn seatbelt_class(chars: &[char], start: usize, pattern: &str) -> Result<TranslatedClass, String> {
    let end = chars
        .iter()
        .skip(start + 1)
        .position(|ch| *ch == ']')
        .ok_or_else(|| format!("malformed deny glob {pattern}"))?;
    let body: String = chars[start + 1..start + 1 + end].iter().collect();
    if body.is_empty() || body.contains("[:") {
        return Err(format!("unsupported deny glob {pattern}"));
    }
    // `[^` is already the Seatbelt negation. A later caret would be a
    // literal, which this regex dialect does not match inside a class.
    let (negated, rest) =
        if let Some(stripped) = body.strip_prefix('!').or_else(|| body.strip_prefix('^')) {
            if stripped.is_empty() || stripped.contains('^') {
                return Err(format!("unsupported deny glob {pattern}"));
            }
            (true, stripped)
        } else if body.contains('^') {
            return Err(format!("unsupported deny glob {pattern}"));
        } else {
            (false, body.as_str())
        };
    let mut text = String::from("[");
    if negated {
        text.push('^');
    }
    text.push_str(rest);
    text.push(']');
    Ok(TranslatedClass {
        text,
        next: start + end + 2,
    })
}

fn seatbelt_string(value: &str) -> String {
    let mut escaped = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' | '"' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    escaped.push('"');
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp_tree(label: &str) -> PathBuf {
        // Default TMPDIR on macOS is under /var/folders, which the workspace
        // profile also write-allows. A fixture there is not an outside root.
        let base = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .unwrap_or_else(std::env::temp_dir);
        let path = base.join(format!(
            ".codsh-fs-sandbox-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(path.join(".grok")).unwrap();
        path
    }

    #[test]
    fn strict_requests_network_isolation_and_workspace_does_not() {
        let root = temp_tree("net-builtin");
        let strict = prepare("strict", &root, &root.join(".grok"), None, true)
            .unwrap()
            .unwrap();
        let workspace = prepare("workspace", &root, &root.join(".grok"), None, true)
            .unwrap()
            .unwrap();
        assert!(strict.restrict_network, "strict must restrict network");
        assert!(!workspace.restrict_network, "workspace must not");
        assert!(
            strict.network_note.contains("Seatbelt") || strict.network_note.contains("refusing"),
            "network note must name the mechanism: {}",
            strict.network_note
        );
        assert!(
            !strict
                .limits
                .iter()
                .any(|line| line.contains("not enforced") || line.contains("no-op")),
            "a requested restriction must not be documented as a no-op: {:?}",
            strict.limits
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shell_policy_hides_a_secret_and_keeps_an_allowed_name() {
        let root = temp_tree("env-filter");
        fs::write(
            root.join(".grok/sandbox.toml"),
            "[shell_environment_policy]\ninherit = \"all\"\nexclude = [\"CODSH_TEST_SECRET\"]\n",
        )
        .unwrap();
        let prepared = prepare("workspace", &root, &root.join(".grok"), None, true)
            .unwrap()
            .unwrap();
        assert!(prepared.shell_env.is_some(), "user policy is loaded");
        let mut parent = BTreeMap::new();
        parent.insert("PATH".into(), "/usr/bin".into());
        parent.insert("CODSH_TEST_SECRET".into(), "s3cret".into());
        parent.insert("CODSH_TEST_TOKEN".into(), "tok".into());
        let policy = ShellEnvironmentPolicy {
            inherit: Some("all".into()),
            exclude: vec!["CODSH_TEST_SECRET".into()],
            ..ShellEnvironmentPolicy::default()
        };
        let filtered = filter_launch_env(&policy, &parent).unwrap();
        assert_eq!(filtered.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert!(!filtered.contains_key("CODSH_TEST_SECRET"));
        assert!(
            !filtered.contains_key("CODSH_TEST_TOKEN"),
            "default excludes drop TOKEN"
        );
        let open = filter_launch_env(
            &ShellEnvironmentPolicy {
                inherit: Some("all".into()),
                ignore_default_excludes: true,
                include_only: vec!["CODSH_TEST_SECRET".into(), "PATH".into()],
                ..ShellEnvironmentPolicy::default()
            },
            &parent,
        )
        .unwrap();
        assert_eq!(
            open.get("CODSH_TEST_SECRET").map(String::as_str),
            Some("s3cret")
        );
        assert!(!open.contains_key("CODSH_TEST_TOKEN"));
        let refused = filter_launch_env(
            &ShellEnvironmentPolicy {
                inherit: Some("maybe".into()),
                ..ShellEnvironmentPolicy::default()
            },
            &parent,
        );
        assert!(refused.is_err(), "unknown inherit must refuse");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn seatbelt_network_rules_deny_when_restricted_and_allow_otherwise() {
        let root = temp_tree("net-rules");
        let strict = prepare("strict", &root, &root.join(".grok"), None, true)
            .unwrap()
            .unwrap();
        let rules = network_profile_rules(&strict).unwrap();
        assert!(
            rules.contains("(deny network*)"),
            "restricted profile must deny network: {rules}"
        );
        assert!(
            !rules.contains("(allow network-outbound)\n"),
            "a blanket outbound allow would undo the deny: {rules}"
        );
        let workspace = prepare("workspace", &root, &root.join(".grok"), None, true)
            .unwrap()
            .unwrap();
        let open = network_profile_rules(&workspace).unwrap();
        assert!(open.contains("(allow network-outbound)"));
        assert!(!open.contains("(deny network*)"));
        // The text installed by sandbox_init, not only the report fragment.
        let mut blocked = CapabilitySet::new();
        blocked.set_network_blocked(true);
        let installed = nono_profile(&blocked, "").unwrap();
        assert!(
            installed.contains("(deny network*)"),
            "installed profile must deny network: {installed}"
        );
        assert!(
            !installed.contains("(allow network-outbound)\n"),
            "installed profile must not reopen outbound: {installed}"
        );
        let allowed = nono_profile(&CapabilitySet::new(), "").unwrap();
        assert!(allowed.contains("(allow network-outbound)"));
        assert!(!allowed.contains("(deny network*)"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn off_prepares_nothing() {
        let root = temp_tree("off");
        let prepared = prepare("off", &root, &root.join(".grok"), None, true).unwrap();
        assert!(prepared.is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unknown_custom_profile_refuses() {
        let root = temp_tree("missing");
        let error = prepare("project", &root, &root.join(".grok"), None, true).unwrap_err();
        assert!(error.message.contains("refusing"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_sandbox_toml_refuses() {
        let root = temp_tree("malformed");
        fs::write(root.join(".grok/sandbox.toml"), "profiles = [").unwrap();
        let error = prepare("project", &root, &root.join(".grok"), None, true).unwrap_err();
        assert!(error.message.contains("malformed"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn symlinked_home_refuses() {
        let root = temp_tree("symlink-home");
        let real = root.join("real-home");
        fs::create_dir_all(&real).unwrap();
        let link = root.join("link-home");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let error = prepare("workspace", &root, &link, None, true).unwrap_err();
        assert!(error.message.contains("symlink"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn brace_glob_refuses() {
        let root = temp_tree("brace");
        fs::write(
            root.join(".grok/sandbox.toml"),
            "[profiles.project]\ndeny = [\"*.{pem,key}\"]\n",
        )
        .unwrap();
        let error = prepare("project", &root, &root.join(".grok"), None, true).unwrap_err();
        assert!(error.message.contains("unsupported"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn conflicting_profile_files_use_the_user_definition_and_warn() {
        let root = temp_tree("conflict");
        let home = root.join(".grok");
        let project = root.join("project");
        fs::create_dir_all(project.join(".grok")).unwrap();
        fs::write(
            home.join("sandbox.toml"),
            "[profiles.project]\nextends = \"workspace\"\ndeny = [\"a.txt\"]\n",
        )
        .unwrap();
        fs::write(
            project.join(".grok/sandbox.toml"),
            "[profiles.project]\nextends = \"strict\"\ndeny = [\"b.txt\"]\n",
        )
        .unwrap();
        let prepared = prepare("project", &project, &home, None, true)
            .unwrap()
            .unwrap();
        assert!(
            prepared
                .read_denied
                .iter()
                .any(|path| path.ends_with("a.txt")),
            "user deny was not applied: {:?}",
            prepared.read_denied
        );
        assert!(
            !prepared
                .read_denied
                .iter()
                .any(|path| path.ends_with("b.txt")),
            "project deny replaced the user profile: {:?}",
            prepared.read_denied
        );
        assert!(
            prepared.limits.iter().any(|warning| {
                warning.contains("user profile")
                    && warning.contains(home.join("sandbox.toml").display().to_string().as_str())
                    && warning.contains(
                        project
                            .join(".grok/sandbox.toml")
                            .display()
                            .to_string()
                            .as_str(),
                    )
            }),
            "startup warning missing both file paths: {:?}",
            prepared.limits
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn untrusted_project_only_custom_refuses_without_applying_grants() {
        let root = temp_tree("untrusted-only");
        let home = root.join(".grok");
        let project = root.join("project");
        let outside = root.join("outside-grant");
        fs::create_dir_all(project.join(".grok")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(
            project.join(".grok/sandbox.toml"),
            format!(
                "[profiles.open]\nextends = \"workspace\"\nread_write = [\"{}/**\"]\n",
                outside.display()
            ),
        )
        .unwrap();
        let error = prepare("open", &project, &home, None, false).unwrap_err();
        assert!(
            error.message.contains("untrusted"),
            "untrusted project body was treated as a definition: {}",
            error.message
        );
        assert!(
            !error.message.contains(&outside.display().to_string()),
            "untrusted grant path leaked into the refusal: {}",
            error.message
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn untrusted_project_body_does_not_widen_a_user_profile() {
        let root = temp_tree("untrusted-user");
        let home = root.join(".grok");
        let project = root.join("project");
        let outside = root.join("outside-grant");
        fs::create_dir_all(project.join(".grok")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(
            home.join("sandbox.toml"),
            "[profiles.open]\nextends = \"workspace\"\ndeny = [\"secret.txt\"]\n",
        )
        .unwrap();
        fs::write(project.join("secret.txt"), "keep").unwrap();
        fs::write(
            project.join(".grok/sandbox.toml"),
            format!(
                "[profiles.open]\nextends = \"workspace\"\nread_write = [\"{}/**\"]\n",
                outside.display()
            ),
        )
        .unwrap();
        let prepared = prepare("open", &project, &home, None, false)
            .unwrap()
            .unwrap();
        assert!(
            prepared
                .read_denied
                .iter()
                .any(|path| path.ends_with("secret.txt")),
            "user deny was dropped: {:?}",
            prepared.read_denied
        );
        assert!(
            !prepared
                .write_roots
                .iter()
                .any(|path| path.starts_with(&outside) || path == &outside),
            "untrusted project grant became a write root: {:?}",
            prepared.write_roots
        );
        assert!(
            prepared
                .limits
                .iter()
                .any(|warning| warning.contains("disagree")
                    && warning.contains("using the user profile")),
            "user precedence warning missing: {:?}",
            prepared.limits
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_untrusted_project_file_does_not_veto_a_user_profile() {
        let root = temp_tree("untrusted-malformed");
        let home = root.join(".grok");
        let project = root.join("project");
        fs::create_dir_all(project.join(".grok")).unwrap();
        fs::write(
            home.join("sandbox.toml"),
            "[profiles.open]\nextends = \"workspace\"\ndeny = [\"secret.txt\"]\n",
        )
        .unwrap();
        fs::write(project.join("secret.txt"), "keep").unwrap();
        fs::write(project.join(".grok/sandbox.toml"), "profiles = [").unwrap();
        let prepared = prepare("open", &project, &home, None, false)
            .unwrap()
            .unwrap();
        assert!(
            prepared
                .read_denied
                .iter()
                .any(|path| path.ends_with("secret.txt")),
            "user deny was vetoed by a malformed untrusted project file: {:?}",
            prepared.read_denied
        );
        assert!(
            !prepared
                .limits
                .iter()
                .any(|warning| warning.contains("disagree")),
            "an unparsed project body produced a disagreement warning: {:?}",
            prepared.limits
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_untrusted_project_file_does_not_veto_a_user_profile() {
        let root = temp_tree("untrusted-symlink");
        let home = root.join(".grok");
        let project = root.join("project");
        fs::create_dir_all(project.join(".grok")).unwrap();
        fs::write(
            home.join("sandbox.toml"),
            "[profiles.open]\nextends = \"workspace\"\ndeny = [\"secret.txt\"]\n",
        )
        .unwrap();
        fs::write(project.join("secret.txt"), "keep").unwrap();
        let real = root.join("elsewhere.toml");
        fs::write(
            &real,
            "[profiles.open]\nextends = \"workspace\"\nread_write = [\"/**\"]\n",
        )
        .unwrap();
        std::os::unix::fs::symlink(&real, project.join(".grok/sandbox.toml")).unwrap();
        let prepared = prepare("open", &project, &home, None, false)
            .unwrap()
            .unwrap();
        assert!(
            prepared
                .read_denied
                .iter()
                .any(|path| path.ends_with("secret.txt")),
            "user deny was vetoed by a symlinked untrusted project file: {:?}",
            prepared.read_denied
        );
        assert!(
            !prepared
                .write_roots
                .iter()
                .any(|path| path == Path::new("/")),
            "symlinked untrusted grant became a write root: {:?}",
            prepared.write_roots
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_project_only_custom_still_refuses_while_untrusted() {
        let root = temp_tree("untrusted-malformed-only");
        let home = root.join(".grok");
        let project = root.join("project");
        fs::create_dir_all(project.join(".grok")).unwrap();
        fs::write(project.join(".grok/sandbox.toml"), "profiles = [").unwrap();
        let error = prepare("open", &project, &home, None, false).unwrap_err();
        assert!(
            error.message.contains("malformed"),
            "project-only malformed file was not fail-closed: {}",
            error.message
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn trusted_malformed_project_file_still_refuses_beside_a_user_profile() {
        let root = temp_tree("trusted-malformed");
        let home = root.join(".grok");
        let project = root.join("project");
        fs::create_dir_all(project.join(".grok")).unwrap();
        fs::write(
            home.join("sandbox.toml"),
            "[profiles.open]\nextends = \"workspace\"\ndeny = [\"secret.txt\"]\n",
        )
        .unwrap();
        fs::write(project.join(".grok/sandbox.toml"), "profiles = [").unwrap();
        let error = prepare("open", &project, &home, None, true).unwrap_err();
        assert!(
            error.message.contains("malformed"),
            "trusted malformed project file did not refuse: {}",
            error.message
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn trusted_project_custom_applies_when_the_user_file_has_no_definition() {
        let root = temp_tree("trusted-project");
        let home = root.join(".grok");
        let project = root.join("project");
        fs::create_dir_all(project.join(".grok")).unwrap();
        fs::create_dir_all(project.join("notes")).unwrap();
        fs::write(project.join("notes/keep.txt"), "keep").unwrap();
        fs::write(
            project.join(".grok/sandbox.toml"),
            "[profiles.open]\nextends = \"read-only\"\nread_write = [\"notes\"]\ndeny = [\"notes/keep.txt\"]\n",
        )
        .unwrap();
        let prepared = prepare("open", &project, &home, None, true)
            .unwrap()
            .unwrap();
        assert!(
            prepared
                .write_roots
                .iter()
                .any(|path| path.ends_with("notes")),
            "trusted project write grant missing: {:?}",
            prepared.write_roots
        );
        assert!(
            prepared
                .read_denied
                .iter()
                .any(|path| path.ends_with("keep.txt")),
            "trusted project deny missing: {:?}",
            prepared.read_denied
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn identical_profile_files_do_not_warn() {
        let root = temp_tree("identical");
        let home = root.join(".grok");
        let project = root.join("project");
        fs::create_dir_all(project.join(".grok")).unwrap();
        let body = "[profiles.project]\nextends = \"workspace\"\ndeny = [\"a.txt\"]\n";
        fs::write(home.join("sandbox.toml"), body).unwrap();
        fs::write(project.join(".grok/sandbox.toml"), body).unwrap();
        let prepared = prepare("project", &project, &home, None, true)
            .unwrap()
            .unwrap();
        assert!(
            !prepared
                .limits
                .iter()
                .any(|warning| warning.contains("user profile")),
            "identical definitions warned: {:?}",
            prepared.limits
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn seatbelt_profile_denies_keychain_lookup_and_does_not_read_all_of_dev() {
        let root = temp_tree("seatbelt");
        let home = root.join(".grok");
        let prepared = prepare("workspace", &root, &home, None, true)
            .unwrap()
            .unwrap();
        let caps = CapabilitySet::new();
        let profile = nono_profile(&caps, "").unwrap();
        for name in [
            "com.apple.SecurityServer",
            "com.apple.securityd",
            "com.apple.security.keychaind",
            "com.apple.secd",
            "com.apple.security.agent",
        ] {
            assert!(
                profile.contains(&format!("(deny mach-lookup (global-name \"{name}\"))")),
                "keychain deny missing for {name}"
            );
        }
        assert!(
            !profile.contains("(allow file-read* (subpath \"/dev\"))"),
            "blanket /dev read is still granted"
        );
        assert!(profile.contains("(allow file-read-data (literal \"/dev/null\"))"));
        let _ = (prepared, fs::remove_dir_all(root));
    }

    #[test]
    fn missing_hook_target_refuses() {
        let root = temp_tree("missing-hook");
        let home = root.join(".grok");
        fs::write(home.join("hooks-paths"), "/no/such/codsh-hook-target\n").unwrap();
        let error = prepare("workspace", &root, &home, None, true).unwrap_err();
        assert!(error.message.contains("missing"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parent_rename_is_a_protected_directory() {
        let root = temp_tree("parent");
        let home = root.join(".grok");
        let prepared = prepare("workspace", &root, &home, None, true)
            .unwrap()
            .unwrap();
        assert!(
            prepared
                .write_denied
                .iter()
                .any(|path| path.ends_with("hooks"))
        );
        let tail = deny_tail(&prepared).unwrap();
        let home_text = home.display().to_string();
        assert!(
            tail.contains(&format!(
                "(deny file-write-unlink (literal {}))",
                seatbelt_string(&home_text)
            )),
            "home rename pin missing from {tail}"
        );
        let devbox = prepare("devbox", &root, &home, None, true)
            .unwrap()
            .unwrap();
        assert!(
            !deny_tail(&devbox).unwrap().contains("file-write-unlink"),
            "devbox must not pin protected directories"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ancestor_below_the_write_root_is_pinned() {
        let root = temp_tree("ancestor");
        let home = root.join(".grok");
        let hook = root.join("mid/nested-hooks/target.sh");
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        fs::write(&hook, "nested").unwrap();
        fs::write(home.join("hooks-paths"), format!("{}\n", hook.display())).unwrap();
        let prepared = prepare("workspace", &root, &home, None, true)
            .unwrap()
            .unwrap();
        let tail = deny_tail(&prepared).unwrap();
        for directory in [root.join("mid/nested-hooks"), root.join("mid")] {
            let text = directory.display().to_string();
            assert!(
                tail.contains(&format!(
                    "(deny file-write-unlink (literal {}))",
                    seatbelt_string(&text)
                )),
                "ancestor pin missing for {text} in {tail}"
            );
        }
        assert!(
            tail.contains(&format!(
                "(deny file-write-unlink (literal {}))",
                seatbelt_string(&root.display().to_string())
            )),
            "workspace write root that holds the hook must be pinned"
        );
        let above = root.parent().unwrap();
        assert!(
            !tail.contains(&format!(
                "(deny file-write-unlink (literal {}))",
                seatbelt_string(&above.display().to_string())
            )),
            "ancestor above the write root must not be pinned"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn relative_deny_globs_stay_inside_the_workspace() {
        // The outside tree is a sibling. A child named "outside" is still
        // inside the workspace, so `.*` matching it is not the leak.
        let base = temp_tree("relative-glob");
        let root = base.join("workspace");
        let home = root.join(".grok");
        let outside = base.join("outside");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(outside.join("certs")).unwrap();
        fs::create_dir_all(root.join("certs/nested")).unwrap();
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join(".env"), "inside").unwrap();
        fs::write(root.join("nested/.env"), "deep").unwrap();
        fs::write(root.join("certs/a.pem"), "inside-pem").unwrap();
        fs::write(root.join("certs/nested/a.pem"), "deep-pem").unwrap();
        let prefixed = PathBuf::from(format!("{}-evil", root.display()));
        fs::create_dir_all(prefixed.join("certs")).unwrap();
        fs::write(outside.join(".env"), "outside").unwrap();
        fs::write(outside.join("certs/a.pem"), "outside-pem").unwrap();
        fs::write(prefixed.join(".env"), "prefix").unwrap();
        fs::write(prefixed.join("certs/a.pem"), "prefix-pem").unwrap();
        fs::write(
            home.join("sandbox.toml"),
            "[profiles.project]\nextends = \"workspace\"\ndeny = [\"**/.env\", \"certs/**/*.pem\"]\n",
        )
        .unwrap();
        let prepared = prepare("project", &root, &home, None, true)
            .unwrap()
            .unwrap();
        let inside_env = root.join(".env").canonicalize().unwrap();
        let deep_env = root.join("nested/.env").canonicalize().unwrap();
        let inside_pem = root.join("certs/a.pem").canonicalize().unwrap();
        let deep_pem = root.join("certs/nested/a.pem").canonicalize().unwrap();
        let outside_env = outside.join(".env").canonicalize().unwrap();
        let outside_pem = outside.join("certs/a.pem").canonicalize().unwrap();
        let prefix_env = prefixed.join(".env").canonicalize().unwrap();
        let prefix_pem = prefixed.join("certs/a.pem").canonicalize().unwrap();
        let effects = seatbelt_glob_effects(
            &prepared.read_denied_globs,
            &[
                &inside_env,
                &deep_env,
                &inside_pem,
                &deep_pem,
                &outside_env,
                &outside_pem,
                &prefix_env,
                &prefix_pem,
            ],
        );
        assert_eq!(
            effects.get(&inside_env).map(String::as_str),
            Some("denied"),
            "{effects:?}"
        );
        assert_eq!(
            effects.get(&deep_env).map(String::as_str),
            Some("denied"),
            "{effects:?}"
        );
        assert_eq!(
            effects.get(&inside_pem).map(String::as_str),
            Some("denied"),
            "{effects:?}"
        );
        assert_eq!(
            effects.get(&deep_pem).map(String::as_str),
            Some("denied"),
            "{effects:?}"
        );
        assert_eq!(
            effects.get(&outside_env).map(String::as_str),
            Some("allowed"),
            "{effects:?}"
        );
        assert_eq!(
            effects.get(&outside_pem).map(String::as_str),
            Some("allowed"),
            "{effects:?}"
        );
        assert_eq!(
            effects.get(&prefix_env).map(String::as_str),
            Some("allowed"),
            "{effects:?}"
        );
        assert_eq!(
            effects.get(&prefix_pem).map(String::as_str),
            Some("allowed"),
            "{effects:?}"
        );
        let _ = fs::remove_dir_all(base);
        let _ = fs::remove_dir_all(prefixed);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn negated_character_classes_deny_the_complement() {
        let root = temp_tree("class");
        let home = root.join(".grok");
        fs::write(root.join("filea.txt"), "a").unwrap();
        fs::write(root.join("fileb.txt"), "b").unwrap();
        fs::write(root.join("noteb.txt"), "b").unwrap();
        fs::write(root.join("notec.txt"), "c").unwrap();
        fs::write(
            home.join("sandbox.toml"),
            "[profiles.project]\nextends = \"workspace\"\ndeny = [\"file[!a].txt\", \"note[^b].txt\"]\n",
        )
        .unwrap();
        let prepared = prepare("project", &root, &home, None, true)
            .unwrap()
            .unwrap();
        let file_a = root.join("filea.txt").canonicalize().unwrap();
        let file_b = root.join("fileb.txt").canonicalize().unwrap();
        let note_b = root.join("noteb.txt").canonicalize().unwrap();
        let note_c = root.join("notec.txt").canonicalize().unwrap();
        let effects = seatbelt_glob_effects(
            &prepared.read_denied_globs,
            &[&file_a, &file_b, &note_b, &note_c],
        );
        assert_eq!(
            effects.get(&file_a).map(String::as_str),
            Some("allowed"),
            "{effects:?}"
        );
        assert_eq!(
            effects.get(&file_b).map(String::as_str),
            Some("denied"),
            "{effects:?}"
        );
        assert_eq!(
            effects.get(&note_b).map(String::as_str),
            Some("allowed"),
            "{effects:?}"
        );
        assert_eq!(
            effects.get(&note_c).map(String::as_str),
            Some("denied"),
            "{effects:?}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn literal_metacharacters_in_root_and_tail_match_only_themselves() {
        let base = temp_tree("metachar-root");
        let root = base.join("a.b*c?d[e]f^g$h(i)j+k{l}m|n");
        let decoy = base.join("aXbXXcXdefXgXhiXjjkXlXmXn");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&decoy).unwrap();
        for dir in [&root, &decoy] {
            fs::write(dir.join("x.pem"), "pem").unwrap();
            fs::write(dir.join("a^b.txt"), "caret").unwrap();
            fs::write(dir.join("ab.txt"), "plain").unwrap();
        }
        let globs = vec![split_glob("*.pem", &root), split_glob("a^?.txt", &root)];
        let paths = [
            root.join("x.pem").canonicalize().unwrap(),
            root.join("a^b.txt").canonicalize().unwrap(),
            root.join("ab.txt").canonicalize().unwrap(),
            decoy.join("x.pem").canonicalize().unwrap(),
            decoy.join("a^b.txt").canonicalize().unwrap(),
        ];
        let refs: Vec<&Path> = paths.iter().map(PathBuf::as_path).collect();
        let effects = seatbelt_glob_effects(&globs, &refs);
        let expect = ["denied", "denied", "allowed", "allowed", "allowed"];
        for (path, want) in paths.iter().zip(expect) {
            assert_eq!(
                effects.get(path).map(String::as_str),
                Some(want),
                "{effects:?}"
            );
        }
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn glob_root_under_a_symlink_matches_the_resolved_path() {
        let base = temp_tree("symlink-root");
        let real = base.join("real");
        fs::create_dir_all(real.join("nested")).unwrap();
        fs::write(real.join("nested/x.key"), "key").unwrap();
        fs::write(real.join("ok.txt"), "ok").unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let glob = split_glob(&format!("{}/**/*.key", link.display()), &base);
        assert_eq!(glob.root, link);
        let key = real.join("nested/x.key").canonicalize().unwrap();
        let ok = real.join("ok.txt").canonicalize().unwrap();
        let effects = seatbelt_glob_effects(&[glob], &[&key, &ok]);
        assert_eq!(
            effects.get(&key).map(String::as_str),
            Some("denied"),
            "{effects:?}"
        );
        assert_eq!(
            effects.get(&ok).map(String::as_str),
            Some("allowed"),
            "{effects:?}"
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn devbox_extension_keeps_user_denies_without_global_protection() {
        let root = temp_tree("devbox-deny");
        let home = root.join(".grok");
        fs::write(root.join("secret.txt"), "keep").unwrap();
        fs::write(
            home.join("sandbox.toml"),
            "[profiles.dev]\nextends = \"devbox\"\ndeny = [\"secret.txt\", \"**/*.key\"]\n",
        )
        .unwrap();
        let prepared = prepare("dev", &root, &home, None, true).unwrap().unwrap();
        assert!(prepared.devbox);
        assert!(
            prepared
                .read_denied
                .iter()
                .any(|path| path.ends_with("secret.txt")),
            "{:?}",
            prepared.read_denied
        );
        assert_eq!(prepared.read_denied_globs.len(), 1);
        assert!(
            prepared.write_denied.is_empty(),
            "{:?}",
            prepared.write_denied
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn glob_literal_prefix_directory_is_pinned() {
        let root = temp_tree("glob-pin");
        let home = root.join(".grok");
        fs::create_dir_all(root.join("secrets/sub")).unwrap();
        fs::write(root.join("secrets/a.key"), "key").unwrap();
        fs::write(
            home.join("sandbox.toml"),
            "[profiles.gr]\nextends = \"workspace\"\ndeny = [\"secrets/**/*.key\"]\n",
        )
        .unwrap();
        let prepared = prepare("gr", &root, &home, None, true).unwrap().unwrap();
        let tail = deny_tail(&prepared).unwrap();
        // The glob root itself is pinned against rename/unlink.
        let secrets = root.join("secrets").display().to_string();
        assert!(
            tail.contains(&format!(
                "(deny file-write-unlink (literal {}))",
                seatbelt_string(&secrets)
            )),
            "glob root pin missing from {tail}"
        );
        // The workspace write root that contains it is pinned too.
        assert!(
            tail.contains(&format!(
                "(deny file-write-unlink (literal {}))",
                seatbelt_string(&root.display().to_string())
            )),
            "write root pin missing from {tail}"
        );
        // The tail directory is not a literal pin: it may not exist at launch.
        // A regex covers it, and a directory created under it later.
        let sub = root.join("secrets/sub").display().to_string();
        assert!(
            !tail.contains(&format!(
                "(deny file-write-unlink (literal {}))",
                seatbelt_string(&sub)
            )),
            "a directory inside the glob tail is covered by regex, not a literal: {tail}"
        );
        let directory =
            glob_directory_regexes(&prepared.read_denied_globs[0], &prepared.write_roots).unwrap();
        assert!(
            directory
                .iter()
                .any(|regex| tail.contains(&directory_pin_rule(regex))),
            "glob tail directory pin missing from {tail}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_glob_does_not_pin_the_temp_write_root() {
        let base = std::env::temp_dir().join(format!(
            "codsh-pin-stop-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let workspace = base.join("ws");
        let home = workspace.join(".grok");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join("sandbox.toml"),
            "[profiles.gr]\nextends = \"workspace\"\ndeny = [\"**/.env\"]\n",
        )
        .unwrap();
        let prepared = prepare("gr", &workspace, &home, None, true)
            .unwrap()
            .unwrap();
        let tail = deny_tail(&prepared).unwrap();
        for bare in ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"] {
            let pin = format!(
                "(deny file-write-unlink (literal {}))",
                seatbelt_string(bare)
            );
            assert!(
                !tail.contains(&pin),
                "bare temp root pinned: {pin} in {tail}"
            );
            assert!(
                !tail.lines().any(|line| {
                    line.contains("vnode-type DIRECTORY") && line.contains(&format!("\"^{bare}$\""))
                }),
                "directory pin matches {bare} alone in {tail}"
            );
        }
        let directory =
            glob_directory_regexes(&prepared.read_denied_globs[0], &prepared.write_roots).unwrap();
        for regex in &directory {
            let pattern = regex.trim_matches('"');
            let Some(body) = pattern
                .strip_prefix("^(")
                .and_then(|rest| rest.strip_suffix(")$"))
            else {
                continue;
            };
            for bare in ["/tmp", "/private/tmp"] {
                assert!(
                    !body.split('|').any(|alternative| alternative == bare),
                    "{regex} matches {bare} alone"
                );
            }
        }
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn glob_tail_directory_regex_covers_later_directories_only() {
        let root = Path::new("/workspace");
        let ancestors = vec!["/workspace".to_string()];
        let cases = [
            (
                "secrets/**/*.key",
                r#"^(/workspace|/workspace/secrets(/[^/]+)*)$"#,
            ),
            // Only the directory that holds `*.key`. A subdirectory cannot.
            ("*.key", r#"^(/workspace)$"#),
            ("certs/**", r#"^(/workspace|/workspace/certs(/[^/]+)*)$"#),
            (
                "secrets/sub/*.key",
                r#"^(/workspace|/workspace/secrets/sub)$"#,
            ),
            ("a/b/*.txt", r#"^(/workspace|/workspace/a/b)$"#),
            (
                "pre/*/mid/*.key",
                r#"^(/workspace|/workspace/pre(/[^/]*(/mid)?)?)$"#,
            ),
        ];
        for (pattern, want) in cases {
            let glob = split_glob(pattern, root);
            let regex = glob_directory_regex(
                &glob.root.display().to_string(),
                &glob.tail,
                &ancestors,
                false,
            )
            .unwrap_or_else(|error| panic!("{pattern}: {error}"));
            assert_eq!(regex, seatbelt_string(want), "{pattern}");
        }
        // A literal directory that cannot carry a match is not in the regex,
        // so `other` beside `sub` is not pinned by `secrets/sub/*.key`.
        let nested = split_glob("secrets/sub/*.key", root);
        let regex = glob_directory_regex(
            &nested.root.display().to_string(),
            &nested.tail,
            &ancestors,
            false,
        )
        .unwrap();
        assert!(!regex.contains("other"), "{regex}");
    }

    #[test]
    fn unresolvable_deny_paths_refuse() {
        let root = temp_tree("unresolvable");
        let home = root.join(".grok");
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("no-such-target"), root.join("dangling")).unwrap();
        for entry in [
            "dangling/**/*.key",
            "dangling/secret.txt",
            "sec\\u0007ret.txt",
        ] {
            fs::write(
                home.join("sandbox.toml"),
                format!("[profiles.bad]\nextends = \"workspace\"\ndeny = [\"{entry}\"]\n"),
            )
            .unwrap();
            let error = prepare("bad", &root, &home, None, true).unwrap_err();
            assert!(
                error.message.contains("dangling") || error.message.contains("control"),
                "{entry}: {}",
                error.message
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dot_segment_and_attached_globstar_refuse() {
        let root = temp_tree("dot-globstar");
        let home = root.join(".grok");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a/secret.txt"), "keep").unwrap();
        for pattern in ["a/./secret.txt", "./secret.txt", "**.pem", "certs/**.pem"] {
            fs::write(
                home.join("sandbox.toml"),
                format!("[profiles.project]\nextends = \"workspace\"\ndeny = [\"{pattern}\"]\n"),
            )
            .unwrap();
            let error = prepare("project", &root, &home, None, true).unwrap_err();
            assert!(
                error.message.contains("unsupported") || error.message.contains("malformed"),
                "{pattern}: {}",
                error.message
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn requirements_pin_beats_cli_and_managed_default_does_not() {
        let (pinned, source) = select_profile(&[
            (ProfileSource::Requirements, Some("strict")),
            (ProfileSource::Cli, Some("off")),
            (ProfileSource::Environment, Some("off")),
            (ProfileSource::User, Some("workspace")),
        ]);
        assert_eq!(pinned, "strict");
        assert_eq!(source, ProfileSource::Requirements);
        let (overridden, source) = select_profile(&[
            (ProfileSource::Cli, Some("off")),
            (ProfileSource::Environment, Some("workspace")),
            (ProfileSource::Managed, Some("strict")),
        ]);
        assert_eq!(overridden, "off");
        assert_eq!(source, ProfileSource::Cli);
        let (managed, source) = select_profile(&[(ProfileSource::Managed, Some("read-only"))]);
        assert_eq!(managed, "read-only");
        assert_eq!(source, ProfileSource::Managed);
        let (absent, source) = select_profile(&[
            (ProfileSource::Requirements, Some("  ")),
            (ProfileSource::Cli, None),
        ]);
        assert_eq!(absent, "off");
        assert_eq!(source, ProfileSource::Default);
    }

    #[test]
    fn unsupported_glob_shapes_refuse() {
        let root = temp_tree("bad-glob");
        let home = root.join(".grok");
        for pattern in ["file[[:alpha:]].txt", "certs//a.pem", "certs/"] {
            fs::write(
                home.join("sandbox.toml"),
                format!("[profiles.project]\nextends = \"workspace\"\ndeny = [\"{pattern}\"]\n"),
            )
            .unwrap();
            let error = prepare("project", &root, &home, None, true).unwrap_err();
            assert!(
                error.message.contains("unsupported") || error.message.contains("malformed"),
                "{pattern}: {}",
                error.message
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(target_os = "macos")]
    fn seatbelt_glob_effects(globs: &[DenyGlob], paths: &[&Path]) -> BTreeMap<PathBuf, String> {
        // Measure the regex Seatbelt actually compiles. allow-default plus
        // the deny rules shows a match as a real read denial.
        let mut rules = String::new();
        for glob in globs {
            let regexes = glob_regexes(glob)
                .unwrap_or_else(|error| panic!("{}: {}", glob.pattern, error.message));
            for regex in regexes {
                rules.push_str(&format!("(deny file-read-data (regex {regex}))\n"));
            }
        }
        let mut script = String::from("import pathlib\n");
        for path in paths {
            // Callers pass the path the kernel opens. Canonicalizing again
            // would make the reported key differ from the path under test.
            let text = path.display().to_string();
            script.push_str(&format!(
                "p = pathlib.Path({text:?})\ntry:\n    p.read_text()\n    print({text:?}, 'allowed')\nexcept OSError:\n    print({text:?}, 'denied')\n"
            ));
        }
        let probe = std::env::temp_dir().join(format!(
            "codsh-seatbelt-probe-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        fs::write(&probe, script).unwrap();
        let wrapped = format!("(version 1)\n(allow default)\n{rules}\n");
        let output = std::process::Command::new("/usr/bin/sandbox-exec")
            .arg("-p")
            .arg(&wrapped)
            .arg("/usr/bin/python3")
            .arg(&probe)
            .output()
            .unwrap();
        let _ = fs::remove_file(&probe);
        assert!(
            output.status.success(),
            "sandbox-exec failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut effects = BTreeMap::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let mut parts = line.rsplitn(2, ' ');
            let status = parts.next().unwrap_or("");
            let path = parts.next().unwrap_or("");
            if !path.is_empty() {
                effects.insert(PathBuf::from(path), status.to_string());
            }
        }
        effects
    }

    #[test]
    fn workspace_summary_names_mechanism_and_writes() {
        let root = temp_tree("summary");
        let home = root.join(".grok");
        let prepared = prepare("workspace", &root, &home, None, true)
            .unwrap()
            .unwrap();
        assert_eq!(prepared.mechanism, mechanism_name());
        assert!(prepared.session_only_config);
        assert!(prepared.summary.contains("sandbox workspace"));
        assert!(prepared.write_roots.iter().any(|path| path == &root));
        assert!(
            prepared
                .write_denied
                .iter()
                .any(|path| path.ends_with("config.toml"))
        );
        let _ = fs::remove_dir_all(root);
    }
}
