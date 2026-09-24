//! Filesystem confinement for `codsh --rust` (ticket 11 / #143).
//!
//! A requested non-`off` profile is applied to this process with the Apache-2.0
//! `nono` 0.53 library (Seatbelt on macOS, Landlock on Linux) before dsh starts.
//! Children inherit that kernel policy. This is not a dsh fork and not a
//! per-tool string check. Network and process restrictions stay with ticket 12.
//! Linux and Windows kernel effects are not claimed from a macOS run.

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
    pub read_denied_globs: Vec<String>,
    pub session_only_config: bool,
    pub devbox: bool,
    pub network_note: String,
    pub limits: Vec<String>,
}

#[derive(Debug)]
pub struct Refusal {
    pub message: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct FileConfig {
    #[serde(default)]
    profiles: BTreeMap<String, ProfileBody>,
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
    deny_globs: Vec<String>,
    dsh_home: Option<PathBuf>,
    devbox: bool,
    restrict_network: bool,
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
    let mut limits = resolved.warnings.clone();
    limits.push(
        "macOS Seatbelt does not restrict child-process network; Linux child-network blocking is ticket 12 and is not claimed here."
            .into(),
    );
    limits.push(
        "Linux glob deny is launch-time only in the reference; this client uses Seatbelt subpath rules on macOS and refuses a deny glob on Linux rather than scanning a partial tree."
            .into(),
    );
    limits.push(
        "Windows filesystem confinement is not implemented or supported by this ticket.".into(),
    );
    if resolved.devbox {
        limits.push(
            "devbox does not write-protect global hook, config, or trust files (disposable VM profile)."
                .into(),
        );
    }
    let (write_denied, read_denied) = if resolved.devbox {
        (Vec::new(), Vec::new())
    } else {
        let write = protected_paths(grok_home)?;
        let read = resolved.deny_exact.clone();
        (write, read)
    };
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
    Ok(Some(Prepared {
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
        network_note: if resolved.restrict_network {
            "child network restriction requested; not enforced by this filesystem ticket (Linux seccomp is ticket 12; macOS is a documented no-op)".into()
        } else {
            "child network unrestricted by this filesystem profile".into()
        },
        limits,
    }))
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
                prepared.read_denied_globs.join(", ")
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
    for path in &prepared.write_denied {
        caps = deny_subpath(caps, path, false, &prepared.name)?;
    }
    for directory in pinned_directories(prepared) {
        caps = pin_directory(caps, &directory, &prepared.name)?;
    }
    for path in &prepared.read_denied {
        caps = deny_subpath(caps, path, true, &prepared.name)?;
    }
    for pattern in &prepared.read_denied_globs {
        caps = deny_glob(caps, pattern, &prepared.name)?;
    }
    // nono emits platform rules before its own write allows. Seatbelt uses the
    // last match, so a write grant on $GROK_HOME would reopen config.toml.
    // Append the same denies after Sandbox builds the profile.
    let tail = deny_tail(prepared);
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

pub fn status_line(prepared: Option<&Prepared>) -> String {
    match prepared {
        Some(prepared) => prepared.summary.clone(),
        None => "sandbox off (no filesystem confinement)".into(),
    }
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

fn deny_forms(path: &Path) -> Vec<PathBuf> {
    let mut forms = vec![path.to_path_buf()];
    if let Ok(canonical) = path.canonicalize()
        && canonical != path
    {
        forms.push(canonical);
    }
    forms
}

fn tail_marker() -> String {
    "\n;; codsh-deny-tail\n".into()
}

fn deny_tail(prepared: &Prepared) -> String {
    let mut tail = String::new();
    for path in &prepared.write_denied {
        for form in deny_forms(path) {
            tail.push_str(&deny_rule(&form, false));
            tail.push('\n');
        }
    }
    // Last match wins. A file deny does not stop renaming that file's parent
    // onto a write root, which would make the protected bytes writable again.
    for directory in pinned_directories(prepared) {
        for form in deny_forms(&directory) {
            tail.push_str(&pin_rule(&form));
            tail.push('\n');
        }
    }
    for path in &prepared.read_denied {
        for form in deny_forms(path) {
            tail.push_str(&deny_rule(&form, true));
            tail.push('\n');
        }
    }
    for pattern in &prepared.read_denied_globs {
        if let Ok(regex) = glob_to_regex(pattern) {
            tail.push_str(&format!("(deny file-read* file-write* (regex {regex}))\n"));
        }
    }
    tail
}

/// Ancestors of a protected path, from its parent up through the write root
/// that contains it. The immediate parent is not enough: renaming a
/// grandparent onto another write root carries the protected file out.
/// The containing write root is included. `$GROK_HOME` is that root for
/// config and hooks, and a workspace root is that root for a nested hook.
/// Ancestors above the write root are not pinned.
fn pinned_directories(prepared: &Prepared) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    for path in prepared
        .write_denied
        .iter()
        .chain(prepared.read_denied.iter())
    {
        let mut current = path.parent();
        while let Some(directory) = current {
            if directory.as_os_str().is_empty() || directory == Path::new("/") {
                break;
            }
            if !under_write_root(directory, &prepared.write_roots) {
                break;
            }
            if directory.is_dir()
                && !directories
                    .iter()
                    .any(|existing: &PathBuf| existing == directory)
            {
                directories.push(directory.to_path_buf());
            }
            current = directory.parent();
        }
    }
    directories
}

fn under_write_root(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| {
        !root.as_os_str().is_empty() && root != Path::new("/") && path.starts_with(root)
    })
}

/// Block renaming or unlinking the directory itself. `file-write-unlink`
/// does not cover creating or rewriting children, so session files stay writable.
fn pin_rule(path: &Path) -> String {
    let escaped = seatbelt_string(&path.display().to_string());
    format!("(deny file-write-unlink (literal {escaped}))")
}

fn pin_directory(
    caps: CapabilitySet,
    path: &Path,
    profile: &str,
) -> Result<CapabilitySet, Refusal> {
    let mut rule = String::new();
    for form in deny_forms(path) {
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
    profile.push_str("(allow system-socket)\n(allow network-outbound)\n");
    profile.push_str("(allow network-inbound)\n(allow network-bind)\n");
    Ok(profile)
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
    for form in deny_forms(path) {
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

fn deny_glob(caps: CapabilitySet, pattern: &str, profile: &str) -> Result<CapabilitySet, Refusal> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = caps;
        return Err(Refusal {
            message: format!(
                "refusing sandbox profile {profile}: glob deny {pattern} is not kernel-enforced on {}",
                std::env::consts::OS
            ),
        });
    }
    #[cfg(target_os = "macos")]
    {
        let regex = glob_to_regex(pattern).map_err(|error| Refusal {
            message: format!("refusing sandbox profile {profile}: {error}"),
        })?;
        let rule = format!("(deny file-read* file-write* (regex {regex}))");
        caps.platform_rule(rule).map_err(|error| Refusal {
            message: format!(
                "refusing sandbox profile {profile}: glob deny {pattern} was not accepted ({error})"
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
                "custom profile extends devbox, so global hook/config write protection is not applied."
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
    Ok(match (user, project) {
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
    })
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
        let anchored = if Path::new(entry).is_absolute() {
            entry.to_string()
        } else {
            workspace.join(entry).display().to_string()
        };
        resolved.deny_globs.push(anchored);
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

fn glob_to_regex(pattern: &str) -> Result<String, String> {
    validate_glob(pattern).map_err(|refusal| refusal.message)?;
    let mut regex = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
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
                let class = seatbelt_class(&chars, index, pattern)?;
                regex.push_str(&class.text);
                index = class.next;
            }
            other => {
                // A backslash escape is unreliable after a group in this
                // dialect. A one-character class matches the literal.
                if ".+()|{}\\^$?".contains(other) {
                    regex.push('[');
                    regex.push(other);
                    regex.push(']');
                } else {
                    regex.push(other);
                }
                index += 1;
            }
        }
    }
    regex.push('$');
    Ok(seatbelt_string(&regex))
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
        let tail = deny_tail(&prepared);
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
            !deny_tail(&devbox).contains("file-write-unlink"),
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
        let tail = deny_tail(&prepared);
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
    fn seatbelt_glob_effects(patterns: &[String], paths: &[&Path]) -> BTreeMap<PathBuf, String> {
        // Measure the regex Seatbelt actually compiles. allow-default plus
        // the deny rules shows a match as a real read denial.
        let mut rules = String::new();
        for pattern in patterns {
            let regex = glob_to_regex(pattern).unwrap_or_else(|error| panic!("{pattern}: {error}"));
            rules.push_str(&format!("(deny file-read-data (regex {regex}))\n"));
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
