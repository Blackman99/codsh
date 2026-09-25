//! Reference workflow host calls the engine process answers itself
//! (ticket 182): the `output_schema` contract, scratch files and
//! `git_diff_since`. Limits, checks and error texts follow the reference
//! host (`xai-grok-shell` `session/workflow/host_service.rs` and
//! `schema_contract.rs`).

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use xai_workflow::HostError;

/// One correction round after the first answer, as in the reference.
pub const SCHEMA_CONTRACT_RETRIES: u32 = 1;
/// Every attempt (first runs and schema retries) counts toward this quota.
pub const WORKFLOW_MAX_AGENT_RUNS: u64 =
    xai_workflow::MAX_AGENT_BUDGET * (SCHEMA_CONTRACT_RETRIES as u64 + 1);

const SCHEMA_MAX_BYTES: usize = 256 * 1024;
const CONTRACT_OUTPUT_MAX_BYTES: usize = 2 * 1024 * 1024;
const SCHEMA_REGEX_SIZE_LIMIT: usize = 256 * 1024;
const SCHEMA_REGEX_DFA_SIZE_LIMIT: usize = 2 * 1024 * 1024;

pub const WORKFLOW_MAX_SCRATCH_FILES: usize = 64;
pub const WORKFLOW_MAX_SCRATCH_FILE_BYTES: usize = 10 * 1024 * 1024;
pub const WORKFLOW_MAX_SCRATCH_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const WORKFLOW_MAX_SCRATCH_NAME_BYTES: usize = 255;
const SCRATCH_ARTIFACT_ROOT: &str = "scratch";

const DIFF_TIMEOUT: Duration = Duration::from_secs(20);
const DIFF_CAP_BYTES: usize = 256 * 1024;

/// The reference contract appended to a schema agent's prompt.
pub fn contract_prompt(prompt: &str, schema: &serde_json::Value) -> String {
    format!(
        "{prompt}\n\n<output-contract>\nDo the work above with your tools first. Then end \
         your final message with a single ```json fenced block containing exactly one \
         JSON value that conforms to this JSON Schema (no prose inside the block):\n\
         {schema}\n</output-contract>"
    )
}

/// The reference correction prompt sent to the same child after a miss.
pub fn retry_prompt(error: &str) -> String {
    format!(
        "Your final message did not satisfy the output contract: {error}\n\
         Reply with a single ```json fenced block containing one JSON \
         value conforming to the schema from <output-contract>, and \
         nothing else."
    )
}

#[derive(Debug)]
struct RejectExternalSchemaRefs;

impl jsonschema::Retrieve for RejectExternalSchemaRefs {
    fn retrieve(
        &self,
        uri: &jsonschema::Uri<String>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        Err(format!("external JSON Schema references are disabled: {uri}").into())
    }
}

pub fn compile_contract_schema(
    schema: &serde_json::Value,
) -> Result<jsonschema::Validator, String> {
    let schema_len = serde_json::to_vec(schema)
        .map_err(|e| format!("output_schema cannot be serialized: {e}"))?
        .len();
    if schema_len > SCHEMA_MAX_BYTES {
        return Err(format!(
            "output_schema is too large ({schema_len} bytes; maximum is {SCHEMA_MAX_BYTES})"
        ));
    }
    jsonschema::options()
        .with_retriever(RejectExternalSchemaRefs)
        .with_pattern_options(
            jsonschema::PatternOptions::regex()
                .size_limit(SCHEMA_REGEX_SIZE_LIMIT)
                .dfa_size_limit(SCHEMA_REGEX_DFA_SIZE_LIMIT),
        )
        .build(schema)
        .map_err(|e| format!("output_schema is not a valid self-contained JSON Schema: {e}"))
}

/// Parse and validate a child's final text: the last ```json fence, then the
/// whole text, then the outermost `{...}` and `[...]` spans. The first
/// candidate that parses decides.
pub fn validate_contract_output(
    validator: &jsonschema::Validator,
    final_text: &str,
) -> Result<serde_json::Value, String> {
    if final_text.len() > CONTRACT_OUTPUT_MAX_BYTES {
        return Err(format!(
            "final message exceeds the {CONTRACT_OUTPUT_MAX_BYTES} byte structured-output limit"
        ));
    }
    let text = final_text.trim();
    let mut candidates: Vec<&str> = Vec::new();
    if let Some(start) = text.rfind("```json")
        && let Some(body) = text.get(start + "```json".len()..)
        && let Some(end) = body.find("```")
    {
        candidates.push(body.get(..end).unwrap_or("").trim());
    }
    candidates.push(text);
    for (open, close) in [('{', '}'), ('[', ']')] {
        if let (Some(s), Some(e)) = (text.find(open), text.rfind(close))
            && s < e
            && let Some(slice) = text.get(s..=e)
        {
            candidates.push(slice.trim());
        }
    }
    let mut parse_err = String::new();
    for cand in candidates {
        match serde_json::from_str::<serde_json::Value>(cand) {
            Ok(value) => {
                return match validator.validate(&value) {
                    Ok(()) => Ok(value),
                    Err(e) => Err(format!("output does not match the required schema: {e}")),
                };
            }
            Err(e) => {
                if parse_err.is_empty() {
                    parse_err = e.to_string();
                }
            }
        }
    }
    Err(format!(
        "final message did not contain valid JSON (expected a ```json fenced block): {parse_err}"
    ))
}

/// A run's scratch directory
/// (`$GROK_HOME/sessions/<encoded cwd>/<session id>/workflows/<run>/scratch`).
#[derive(Debug, Clone)]
pub struct Scratch {
    pub dir: PathBuf,
}

fn failed(message: impl Into<String>) -> HostError {
    HostError::Failed(message.into())
}

impl Scratch {
    fn paths(&self, name: &str) -> Result<(PathBuf, String), HostError> {
        if name.len() > WORKFLOW_MAX_SCRATCH_NAME_BYTES {
            return Err(failed(format!(
                "scratch file name exceeds {WORKFLOW_MAX_SCRATCH_NAME_BYTES} bytes"
            )));
        }
        let mut components = Path::new(name).components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(part)), None) if !part.is_empty() => {}
            _ => {
                return Err(failed(format!(
                    "scratch file name must be a single relative path component, got: {name}"
                )));
            }
        }
        Ok((
            self.dir.join(name),
            format!("{SCRATCH_ARTIFACT_ROOT}/{name}"),
        ))
    }

    fn reject_symlink(path: &Path, what: &str) -> Result<(), HostError> {
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_symlink() => Err(failed(format!(
                "{what} must not be a symlink: {}",
                path.display()
            ))),
            Ok(meta) if what == "scratch directory" && !meta.is_dir() => Err(failed(format!(
                "scratch directory is not a real directory: {}",
                path.display()
            ))),
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(failed(format!("{what} metadata: {e}"))),
        }
    }

    fn usage(&self, replacing: &Path) -> Result<(usize, u64), HostError> {
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
            Err(e) => return Err(failed(format!("scratch dir listing: {e}"))),
        };
        let mut files = 0usize;
        let mut bytes = 0u64;
        for entry in entries {
            let entry = entry.map_err(|e| failed(format!("scratch dir entry: {e}")))?;
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path)
                .map_err(|e| failed(format!("scratch metadata: {e}")))?;
            if meta.file_type().is_symlink() {
                return Err(failed(format!(
                    "scratch directory contains a symlink: {}",
                    path.display()
                )));
            }
            if meta.is_file() && path != replacing {
                files = files.saturating_add(1);
                bytes = bytes.saturating_add(meta.len());
            }
        }
        Ok((files, bytes))
    }

    /// Write one file atomically and return its artifact path
    /// (`scratch/<name>`).
    pub fn write(&self, name: &str, content: &str) -> Result<String, HostError> {
        if content.len() > WORKFLOW_MAX_SCRATCH_FILE_BYTES {
            return Err(failed(format!(
                "scratch file exceeds {WORKFLOW_MAX_SCRATCH_FILE_BYTES} byte limit"
            )));
        }
        let (path, artifact_path) = self.paths(name)?;
        Self::reject_symlink(&self.dir, "scratch directory")?;
        std::fs::create_dir_all(&self.dir).map_err(|e| failed(format!("scratch dir: {e}")))?;
        Self::reject_symlink(&self.dir, "scratch directory")?;
        Self::reject_symlink(&path, "scratch file")?;

        let (other_files, other_bytes) = self.usage(&path)?;
        let target_exists = std::fs::symlink_metadata(&path)
            .is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink());
        let resulting_files = other_files.saturating_add(usize::from(!target_exists));
        let resulting_bytes = other_bytes.saturating_add(content.len() as u64);
        if resulting_files > WORKFLOW_MAX_SCRATCH_FILES {
            return Err(failed(format!(
                "scratch file quota exceeded (maximum {WORKFLOW_MAX_SCRATCH_FILES})"
            )));
        }
        if resulting_bytes > WORKFLOW_MAX_SCRATCH_TOTAL_BYTES {
            return Err(failed(format!(
                "scratch byte quota exceeded (maximum {WORKFLOW_MAX_SCRATCH_TOTAL_BYTES})"
            )));
        }
        let mut tmp = tempfile::NamedTempFile::new_in(&self.dir)
            .map_err(|e| failed(format!("scratch temp file: {e}")))?;
        Self::reject_symlink(&self.dir, "scratch directory")?;
        Self::reject_symlink(&path, "scratch file")?;
        tmp.write_all(content.as_bytes())
            .map_err(|e| failed(format!("scratch write: {e}")))?;
        tmp.persist(&path)
            .map_err(|e| failed(format!("scratch atomic persist: {}", e.error)))?;
        Ok(artifact_path)
    }

    /// Read one regular UTF-8 file of at most 10 MiB.
    pub fn read(&self, name: &str) -> Result<String, HostError> {
        let (path, _) = self.paths(name)?;
        Self::reject_symlink(&self.dir, "scratch directory")?;
        Self::reject_symlink(&path, "scratch file")?;
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| failed(format!("scratch read metadata: {e}")))?;
        if meta.file_type().is_symlink() {
            return Err(failed("scratch file must not be a symlink"));
        }
        if !meta.is_file() {
            return Err(failed("scratch path is not a regular file"));
        }
        if meta.len() > WORKFLOW_MAX_SCRATCH_FILE_BYTES as u64 {
            return Err(failed(format!(
                "scratch file exceeds {WORKFLOW_MAX_SCRATCH_FILE_BYTES} byte read limit"
            )));
        }
        let bytes = std::fs::read(&path).map_err(|e| failed(format!("scratch read: {e}")))?;
        String::from_utf8(bytes).map_err(|e| failed(format!("scratch file is not UTF-8: {e}")))
    }
}

#[cfg(unix)]
const PASSTHROUGH_PAGER: &str = "cat";
#[cfg(not(unix))]
const PASSTHROUGH_PAGER: &str = "more";
#[cfg(unix)]
const NOOP_CMD: &str = "true";
#[cfg(not(unix))]
const NOOP_CMD: &str = "rem";

/// Keep the first `cap` bytes of a pipe and drain the rest.
fn read_capped(mut pipe: impl Read, cap: usize) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) | Err(_) => return kept,
            Ok(n) => {
                let room = cap.saturating_sub(kept.len());
                kept.extend_from_slice(&buf[..n.min(room)]);
            }
        }
    }
}

/// `git diff <commit>` in the session directory, 20 s and 256 KiB bounded.
pub fn git_diff_since(cwd: &Path, commit: &str) -> Result<String, HostError> {
    if commit.is_empty() || !commit.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(failed(format!(
            "git_diff_since expects a commit hash, got: {commit}"
        )));
    }
    let mut cmd = Command::new("git");
    cmd.arg("diff")
        .arg(commit)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in [
        "PAGER",
        "GIT_PAGER",
        "GH_PAGER",
        "MANPAGER",
        "SYSTEMD_PAGER",
    ] {
        cmd.env(key, PASSTHROUGH_PAGER);
    }
    cmd.env("AWS_PAGER", "")
        .env("GIT_EDITOR", NOOP_CMD)
        .env("GIT_SEQUENCE_EDITOR", NOOP_CMD)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GPG_TTY", "");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe; it detaches git from the
        // controlling terminal as the reference `detach_command` does.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    let mut child = cmd.spawn().map_err(|e| failed(format!("git diff: {e}")))?;
    let stdout = child
        .stdout
        .take()
        .map(|pipe| std::thread::spawn(move || read_capped(pipe, DIFF_CAP_BYTES + 4)));
    let stderr = child
        .stderr
        .take()
        .map(|pipe| std::thread::spawn(move || read_capped(pipe, 64 * 1024)));
    let deadline = Instant::now() + DIFF_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(failed("git diff timed out"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(failed(format!("git diff: {e}"))),
        }
    };
    let out = stdout
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    let err = stderr
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    if !status.success() {
        return Err(failed(format!(
            "git diff exited with {}: {}",
            status,
            String::from_utf8_lossy(&err)
        )));
    }
    let mut text = String::from_utf8_lossy(&out).to_string();
    if out.len() > DIFF_CAP_BYTES {
        let mut end = DIFF_CAP_BYTES.min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n… [diff truncated]");
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v() -> jsonschema::Validator {
        compile_contract_schema(&json!({
            "type": "object", "required": ["ok"],
            "properties": { "ok": { "type": "boolean" } }
        }))
        .unwrap()
    }

    #[test]
    fn contract_output_follows_the_reference_candidates() {
        let text = "I scanned all 12 files with grep.\n\n```json\n{\"ok\": true}\n```";
        assert_eq!(
            validate_contract_output(&v(), text).unwrap(),
            json!({"ok": true})
        );
        assert!(validate_contract_output(&v(), "{\"ok\": false}").is_ok());
        assert!(
            validate_contract_output(&v(), "Here is my result: {\"ok\": true} — done.").is_ok()
        );
        let last = "```json\n{\"wrong\": 1}\n```\ncorrected:\n```json\n{\"ok\": true}\n```";
        assert!(validate_contract_output(&v(), last).is_ok());
        let err = validate_contract_output(&v(), "{\"ok\": \"yes\"}").unwrap_err();
        assert!(
            err.starts_with("output does not match the required schema: "),
            "{err}"
        );
        let err = validate_contract_output(&v(), "I finished the scan, all clear.").unwrap_err();
        assert!(
            err.starts_with(
                "final message did not contain valid JSON (expected a ```json fenced block): "
            ),
            "{err}"
        );
        let big = "x".repeat(CONTRACT_OUTPUT_MAX_BYTES + 1);
        assert_eq!(
            validate_contract_output(&v(), &big).unwrap_err(),
            "final message exceeds the 2097152 byte structured-output limit"
        );
    }

    #[test]
    fn schemas_are_self_contained_and_bounded() {
        let err = compile_contract_schema(&json!({"$ref": "https://example.com/schema.json"}))
            .unwrap_err();
        assert!(
            err.contains("external JSON Schema references are disabled"),
            "{err}"
        );
        let validator = compile_contract_schema(&json!({"type": "string", "pattern": "^(a+)+$"}))
            .expect("nested repetition is supported by the linear regex engine");
        assert!(validator.is_valid(&json!("aaaa")));
        let err =
            compile_contract_schema(&json!({"type": "string", "pattern": "(?=x)"})).unwrap_err();
        assert!(err.contains("regex"), "{err}");
        let err = compile_contract_schema(&json!({"type": 7})).unwrap_err();
        assert!(
            err.starts_with("output_schema is not a valid self-contained JSON Schema: "),
            "{err}"
        );
        let huge = json!({"description": "d".repeat(SCHEMA_MAX_BYTES)});
        assert!(
            compile_contract_schema(&huge)
                .unwrap_err()
                .starts_with("output_schema is too large (")
        );
        let prompt = contract_prompt("scan", &json!({"type": "object"}));
        assert!(
            prompt
                .starts_with("scan\n\n<output-contract>\nDo the work above with your tools first.")
        );
        assert!(prompt.ends_with("{\"type\":\"object\"}\n</output-contract>"));
        assert!(retry_prompt("E").starts_with("Your final message did not satisfy the output contract: E\nReply with a single ```json fenced block"));
        assert_eq!(WORKFLOW_MAX_AGENT_RUNS, 2048);
    }

    #[test]
    fn scratch_files_follow_the_reference_rules() {
        let root = tempfile::tempdir().unwrap();
        let scratch = Scratch {
            dir: root.path().join("run").join("scratch"),
        };
        assert_eq!(
            scratch.write("notes.md", "one").unwrap(),
            "scratch/notes.md"
        );
        assert_eq!(scratch.read("notes.md").unwrap(), "one");
        assert_eq!(
            scratch.write("notes.md", "two").unwrap(),
            "scratch/notes.md"
        );
        assert_eq!(scratch.read("notes.md").unwrap(), "two");
        for bad in ["../x", "a/b", "", ".", "/etc/passwd"] {
            let HostError::Failed(err) = scratch.write(bad, "x").unwrap_err() else {
                panic!()
            };
            assert!(
                err.starts_with("scratch file name must be a single relative path component"),
                "{bad}: {err}"
            );
        }
        let HostError::Failed(err) = scratch.write(&"n".repeat(256), "x").unwrap_err() else {
            panic!()
        };
        assert_eq!(err, "scratch file name exceeds 255 bytes");
        let HostError::Failed(err) = scratch.read("missing").unwrap_err() else {
            panic!()
        };
        assert!(err.starts_with("scratch read metadata: "), "{err}");
        let HostError::Failed(err) = scratch
            .write("big", &"x".repeat(WORKFLOW_MAX_SCRATCH_FILE_BYTES + 1))
            .unwrap_err()
        else {
            panic!()
        };
        assert_eq!(err, "scratch file exceeds 10485760 byte limit");
        for n in 1..WORKFLOW_MAX_SCRATCH_FILES {
            scratch.write(&format!("f{n}"), "x").unwrap();
        }
        let HostError::Failed(err) = scratch.write("one-too-many", "x").unwrap_err() else {
            panic!()
        };
        assert_eq!(err, "scratch file quota exceeded (maximum 64)");
        // Replacing an existing file stays within the file quota.
        assert!(scratch.write("f1", "y").is_ok());
        #[cfg(unix)]
        {
            let other = root.path().join("outside");
            std::fs::write(&other, "secret").unwrap();
            let linked = Scratch {
                dir: root.path().join("linked"),
            };
            std::fs::create_dir_all(&linked.dir).unwrap();
            std::os::unix::fs::symlink(&other, linked.dir.join("link")).unwrap();
            let HostError::Failed(err) = linked.read("link").unwrap_err() else {
                panic!()
            };
            assert!(
                err.starts_with("scratch file must not be a symlink: "),
                "{err}"
            );
            let HostError::Failed(err) = linked.write("new", "x").unwrap_err() else {
                panic!()
            };
            assert!(
                err.starts_with("scratch directory contains a symlink: "),
                "{err}"
            );
            let dir_link = Scratch {
                dir: root.path().join("dirlink"),
            };
            std::os::unix::fs::symlink(root.path(), &dir_link.dir).unwrap();
            let HostError::Failed(err) = dir_link.write("x", "x").unwrap_err() else {
                panic!()
            };
            assert!(
                err.starts_with("scratch directory must not be a symlink: "),
                "{err}"
            );
        }
    }

    #[test]
    fn scratch_reads_need_utf8_and_the_byte_quota_holds() {
        let root = tempfile::tempdir().unwrap();
        let scratch = Scratch {
            dir: root.path().join("scratch"),
        };
        std::fs::create_dir_all(&scratch.dir).unwrap();
        std::fs::write(scratch.dir.join("bin"), [0xff, 0xfe]).unwrap();
        let HostError::Failed(err) = scratch.read("bin").unwrap_err() else {
            panic!()
        };
        assert!(err.starts_with("scratch file is not UTF-8: "), "{err}");
        std::fs::create_dir(scratch.dir.join("sub")).unwrap();
        let HostError::Failed(err) = scratch.read("sub").unwrap_err() else {
            panic!()
        };
        assert_eq!(err, "scratch path is not a regular file");
        let chunk = "x".repeat(WORKFLOW_MAX_SCRATCH_FILE_BYTES);
        for n in 0..6 {
            scratch.write(&format!("c{n}"), &chunk).unwrap();
        }
        let HostError::Failed(err) = scratch.write("c6", &chunk).unwrap_err() else {
            panic!()
        };
        assert_eq!(err, "scratch byte quota exceeded (maximum 67108864)");
    }

    #[test]
    fn git_diff_since_checks_the_commit_and_reports_git_errors() {
        let root = tempfile::tempdir().unwrap();
        let HostError::Failed(err) = git_diff_since(root.path(), "HEAD~1").unwrap_err() else {
            panic!()
        };
        assert_eq!(err, "git_diff_since expects a commit hash, got: HEAD~1");
        let HostError::Failed(err) = git_diff_since(root.path(), "").unwrap_err() else {
            panic!()
        };
        assert_eq!(err, "git_diff_since expects a commit hash, got: ");
        let git = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(root.path())
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@example.com")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@example.com")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        };
        git(&["init", "-q"]);
        std::fs::write(root.path().join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-q", "-m", "one"]);
        let head = String::from_utf8(
            Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(root.path())
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        std::fs::write(root.path().join("a.txt"), "two\n").unwrap();
        let diff = git_diff_since(root.path(), head.trim()).unwrap();
        assert!(diff.contains("-one\n+two"), "{diff}");
        std::fs::write(root.path().join("a.txt"), "x\n".repeat(200_000)).unwrap();
        let diff = git_diff_since(root.path(), head.trim()).unwrap();
        assert!(diff.ends_with("\n… [diff truncated]"));
        assert_eq!(diff.len(), DIFF_CAP_BYTES + "\n… [diff truncated]".len());
        let HostError::Failed(err) = git_diff_since(root.path(), "deadbeef").unwrap_err() else {
            panic!()
        };
        assert!(err.starts_with("git diff exited with "), "{err}");
    }
}
