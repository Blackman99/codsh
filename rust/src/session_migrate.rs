//! `codsh --rust import sessions` (ticket 62): copy selected legacy codsh
//! sessions into the isolated dsh Home.
//!
//! The work happens in `packages/cli/bin/rust-session-migrate.mjs`, which
//! opens the legacy store with the pinned dsh persistence strictly as a
//! reader and writes each copy under a new session id in the isolated
//! store, with a provenance record in `$DSH_HOME/session-migrations/`. This
//! module parses and validates the command line, points the helper at the
//! two Homes, and reads provenance back for `/session-info`.

use serde_json::Value;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const RECORD_DIR: &str = "session-migrations";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionImportFlags {
    pub ids: Vec<String>,
    pub all: bool,
    pub apply: bool,
    pub preview: bool,
    pub again: bool,
    pub allow_partial: bool,
    pub json: bool,
    pub help: bool,
}

pub fn help() -> &'static str {
    "Copy selected legacy codsh sessions into the isolated Rust client.\n\nUsage: codsh --rust import sessions [OPTIONS] [ID]...\n\nWith no ID and no --all, list the legacy sessions with what a copy would keep\nand lose. With IDs (or --all), preview; nothing is written without --apply.\n\nOptions:\n      --all             Every legacy session not imported yet\n      --preview         Show what would be copied without writing (default)\n      --apply           Copy the selected sessions into the isolated Home\n      --again           Import another copy of a session that was imported before\n      --allow-partial   Copy even when referenced attachments or subagent logs are missing\n      --json            Emit machine-readable JSON\n  -h, --help            Print help\n\nReads the old client's dsh Home ($DSH_HOME, default ~/.dsh) and never writes,\nlocks, or migrates it: the old client keeps opening its original sessions.\nEach copy gets a NEW session id (resume it with codsh --rust --resume <id>), so\nthe two clients never write the same session, and there is no live sync: work\ncontinued in either client stays there. Messages, tool calls and results,\nimage/file attachments, titles, and subagent sessions are copied; events this\nbuild does not read, content it does not display, and missing attachments are\nreported, never hidden. A damaged log, an unsupported format, or an unknown\nrequired event is refused. A copy is verified before it counts; a failed copy\nis removed. Importing an unchanged session again reports the existing copy; a\nlegacy session that changed since is a conflict until --again. Provenance is\nkept in $DSH_HOME/session-migrations/<copy id>.json and shown by /session-info."
}

pub fn parse_flags(args: &[&str]) -> io::Result<SessionImportFlags> {
    let mut flags = SessionImportFlags::default();
    for arg in args {
        match *arg {
            "--all" => flags.all = true,
            "--apply" => flags.apply = true,
            "--preview" => flags.preview = true,
            "--again" => flags.again = true,
            "--allow-partial" => flags.allow_partial = true,
            "--json" => flags.json = true,
            "--help" | "-h" => flags.help = true,
            other if other.starts_with('-') => {
                return Err(io::Error::other(format!(
                    "unsupported import sessions option {other}; use codsh --rust import sessions --help"
                )));
            }
            "" => {
                return Err(io::Error::other("empty session id"));
            }
            id => {
                if !flags.ids.iter().any(|seen| seen == id) {
                    flags.ids.push(id.to_string());
                }
            }
        }
    }
    if flags.preview && flags.apply {
        return Err(io::Error::other(
            "use only one of --preview or --apply; --preview never writes",
        ));
    }
    if flags.all && !flags.ids.is_empty() {
        return Err(io::Error::other(
            "use either --all or session ids, not both",
        ));
    }
    if (flags.apply || flags.again || flags.allow_partial) && !flags.all && flags.ids.is_empty() {
        return Err(io::Error::other(
            "name the sessions to import (IDs from `codsh --rust import sessions`) or pass --all",
        ));
    }
    Ok(flags)
}

pub fn helper_path() -> PathBuf {
    if let Some(path) = std::env::var_os("CODSH_SESSION_MIGRATE") {
        return PathBuf::from(path);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../packages/cli/bin/rust-session-migrate.mjs")
}

/// Helper arguments for one parsed command line.
pub fn helper_args(flags: &SessionImportFlags) -> Vec<String> {
    let mut args = flags.ids.clone();
    for (on, name) in [
        (flags.all, "--all"),
        (flags.apply && !flags.preview, "--apply"),
        (flags.again, "--again"),
        (flags.allow_partial, "--allow-partial"),
        (flags.json, "--json"),
    ] {
        if on {
            args.push(name.to_string());
        }
    }
    args
}

/// The old client's dsh Home, as the launcher passed it.
pub fn legacy_home(env: &std::collections::BTreeMap<String, String>) -> Result<PathBuf, String> {
    if let Some(home) = env
        .get("CODSH_HOST_DSH_HOME")
        .filter(|value| !value.is_empty())
    {
        return Ok(PathBuf::from(home));
    }
    if let Some(home) = env.get("CODSH_HOST_HOME").filter(|value| !value.is_empty()) {
        return Ok(Path::new(home).join(".dsh"));
    }
    Err(
        "session import needs the legacy dsh Home; launch with `codsh --rust import sessions`"
            .into(),
    )
}

/// Run the helper with inherited stdio; returns its exit code.
pub fn run(flags: &SessionImportFlags, dsh_home: &Path, legacy: &Path) -> io::Result<i32> {
    let node = std::env::var_os("CODSH_NODE").unwrap_or_else(|| "node".into());
    let status = Command::new(node)
        .arg(helper_path())
        .args(helper_args(flags))
        .env("DSH_HOME", dsh_home)
        .env("CODSH_HOST_DSH_HOME", legacy)
        .status()
        .map_err(|error| {
            io::Error::other(format!("cannot start the session import helper: {error}"))
        })?;
    Ok(status.code().unwrap_or(1))
}

/// `/session-info` line for a session that is a copy of a legacy session.
pub fn provenance_line(dsh_home: &Path, session_id: &str) -> Option<String> {
    if session_id.is_empty() || session_id.contains(['/', '\\']) || session_id.starts_with('.') {
        return None;
    }
    let path = dsh_home.join(RECORD_DIR).join(format!("{session_id}.json"));
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let status = value.get("status").and_then(Value::as_str)?;
    if status != "complete" && status != "partial" {
        return None;
    }
    let source = value.get("source")?;
    let id = source.get("sessionId").and_then(Value::as_str)?;
    let home = source.get("home").and_then(Value::as_str).unwrap_or("");
    let gaps = value
        .pointer("/report/gaps")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let skipped: u64 = value
        .pointer("/report/skippedEvents")
        .and_then(Value::as_object)
        .map(|map| map.values().filter_map(Value::as_u64).sum())
        .unwrap_or(0);
    let mut line = format!("Imported from: legacy dsh session {id} ({home}), copy {status}");
    if gaps > 0 {
        line.push_str(&format!(", {gaps} missing item(s)"));
    }
    if skipped > 0 {
        line.push_str(&format!(", {skipped} skipped event(s)"));
    }
    Some(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_validates_session_import_flags() {
        assert_eq!(parse_flags(&[]).unwrap(), SessionImportFlags::default());
        let flags = parse_flags(&[
            "session-a",
            "b",
            "session-a",
            "--apply",
            "--again",
            "--json",
        ])
        .unwrap();
        assert_eq!(flags.ids, vec!["session-a".to_string(), "b".to_string()]);
        assert_eq!(
            helper_args(&flags),
            ["session-a", "b", "--apply", "--again", "--json"]
        );
        assert!(
            parse_flags(&["--all", "--allow-partial", "--apply"])
                .unwrap()
                .all
        );
        assert_eq!(
            helper_args(&parse_flags(&["x", "--preview"]).unwrap()),
            ["x"]
        );
        for bad in [
            &["--apply", "--preview", "x"][..],
            &["--all", "x"],
            &["--bogus"],
            &["--apply"],
            &["--again"],
            &[""],
        ] {
            assert!(parse_flags(bad).is_err(), "{bad:?}");
        }
        assert!(parse_flags(&["-h"]).unwrap().help);
        assert!(help().contains("never writes"));
        assert!(help().contains("NEW session id"));
    }

    #[test]
    fn legacy_home_prefers_the_launcher_value() {
        let mut env = std::collections::BTreeMap::new();
        assert!(legacy_home(&env).is_err());
        env.insert("CODSH_HOST_HOME".to_string(), "/h".to_string());
        assert_eq!(legacy_home(&env).unwrap(), PathBuf::from("/h/.dsh"));
        env.insert("CODSH_HOST_DSH_HOME".to_string(), "/legacy".to_string());
        assert_eq!(legacy_home(&env).unwrap(), PathBuf::from("/legacy"));
    }

    #[test]
    fn provenance_line_reads_completed_records_only() {
        let dir = std::env::temp_dir().join(format!("codsh-194-provenance-{}", std::process::id()));
        let records = dir.join(RECORD_DIR);
        std::fs::create_dir_all(&records).unwrap();
        std::fs::write(
            records.join("copy-1.json"),
            r#"{"copyId":"copy-1","status":"partial","source":{"sessionId":"session-old","home":"/legacy"},"report":{"gaps":["x"],"skippedEvents":{"a":2}}}"#,
        )
        .unwrap();
        std::fs::write(
            records.join("copy-2.json"),
            r#"{"copyId":"copy-2","status":"pending","source":{"sessionId":"session-old"}}"#,
        )
        .unwrap();
        assert_eq!(
            provenance_line(&dir, "copy-1").unwrap(),
            "Imported from: legacy dsh session session-old (/legacy), copy partial, 1 missing item(s), 2 skipped event(s)"
        );
        assert_eq!(provenance_line(&dir, "copy-2"), None);
        assert_eq!(provenance_line(&dir, "missing"), None);
        assert_eq!(provenance_line(&dir, "../copy-1"), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
