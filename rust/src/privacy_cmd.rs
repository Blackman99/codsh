//! Headless `codsh --rust feedback` commands. Drafts stay local until submit.

use crate::privacy::{
    DiagnosticEvent, DraftStore, FeedbackType, PrivacyError, PrivacyPolicy, diagnostic_preview,
    emit_diagnostic, local_log_line, session_dir, submit_draft,
};
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FeedbackCommand {
    Help,
    Save {
        session: String,
        title: String,
        details: String,
        area: Option<String>,
        kind: FeedbackType,
    },
    List {
        session: String,
    },
    Show {
        session: String,
        id: String,
    },
    Edit {
        session: String,
        id: String,
        title: String,
        details: String,
        area: Option<String>,
        kind: FeedbackType,
    },
    Delete {
        session: String,
        id: String,
    },
    Submit {
        session: String,
        id: String,
    },
    Preview,
}

pub fn parse_feedback(args: &[String]) -> Result<FeedbackCommand, PrivacyError> {
    if args.is_empty() || args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Ok(FeedbackCommand::Help);
    }
    let session = flag(args, "--session").unwrap_or_else(|| "local".into());
    match args[0].as_str() {
        "save" => Ok(FeedbackCommand::Save {
            session,
            title: required(args, "--title")?,
            details: required(args, "--details")?,
            area: flag(args, "--area"),
            kind: kind_of(args)?,
        }),
        "list" => Ok(FeedbackCommand::List { session }),
        "show" => Ok(FeedbackCommand::Show {
            session,
            id: required(args, "--id")?,
        }),
        "edit" => Ok(FeedbackCommand::Edit {
            session,
            id: required(args, "--id")?,
            title: required(args, "--title")?,
            details: required(args, "--details")?,
            area: flag(args, "--area"),
            kind: kind_of(args)?,
        }),
        "delete" => Ok(FeedbackCommand::Delete {
            session,
            id: required(args, "--id")?,
        }),
        "submit" => Ok(FeedbackCommand::Submit {
            session,
            id: required(args, "--id")?,
        }),
        "preview" => Ok(FeedbackCommand::Preview),
        other => Err(PrivacyError::Io(format!(
            "unsupported feedback command {other}; use codsh --rust feedback --help"
        ))),
    }
}

pub fn debug_log_path(dsh_home: &Path) -> Option<std::path::PathBuf> {
    std::env::var_os("GROK_DEBUG_LOG")
        .filter(|value| !value.is_empty() && value != "0" && value != "false")
        .map(|value| {
            if value == "1" || value == "true" {
                dsh_home.join("privacy.log")
            } else {
                std::path::PathBuf::from(value)
            }
        })
}

pub fn help_text() -> &'static str {
    "Local feedback drafts and opt-in diagnostics.\n\n\
Usage: codsh --rust feedback <save|list|show|edit|delete|submit|preview>\n\n\
save/edit: --session <id> --title <text> --details <text> [--area <text>] [--type bug|idea|missing_capability]\n\
list/show/delete/submit: --session <id> [--id <draft>]\n\
preview: print the redaction boundary. Nothing is uploaded.\n\n\
Drafts stay in the isolated dsh Home until submit. Submit requires features.feedback and endpoints.feedback_base_url. Failed submit keeps the draft. Official grok.com / api.x.ai endpoints are refused."
}

pub fn run(
    command: &FeedbackCommand,
    dsh_home: &Path,
    policy: &PrivacyPolicy,
    log_path: Option<&Path>,
) -> Result<String, PrivacyError> {
    match command {
        FeedbackCommand::Help => Ok(help_text().into()),
        FeedbackCommand::Preview => Ok(diagnostic_preview(&DiagnosticEvent {
            schema_version: 1,
            kind: "diagnostic_preview",
            ok: true,
            count: 0,
        })),
        FeedbackCommand::Save {
            session,
            title,
            details,
            area,
            kind,
        } => {
            let store = store_for(dsh_home, session)?;
            let draft = store.append(title, details, area.as_deref(), kind.clone())?;
            note(log_path, "feedback_draft_save", true, 1)?;
            let _ = maybe_telemetry(policy, "feedback_draft_op", true, 1);
            Ok(format!(
                "saved local draft {} revision {}. Not sent.",
                draft.id, draft.revision
            ))
        }
        FeedbackCommand::List { session } => {
            let store = store_for(dsh_home, session)?;
            let drafts = store.list()?;
            note(log_path, "feedback_draft_list", true, drafts.len() as u32)?;
            if drafts.is_empty() {
                return Ok("no local feedback drafts".into());
            }
            let mut lines = Vec::new();
            for draft in &drafts {
                lines.push(format!(
                    "{}  rev {}  {}  {}",
                    draft.id,
                    draft.revision,
                    draft.r#type.as_str(),
                    draft.title
                ));
            }
            Ok(lines.join("\n"))
        }
        FeedbackCommand::Show { session, id } => {
            let store = store_for(dsh_home, session)?;
            let Some(draft) = store.get(id)? else {
                return Err(PrivacyError::NotFound);
            };
            Ok(format!(
                "id={}\nrevision={}\ntype={}\ntitle={}\ndetails={}\narea={}\nstatus=local",
                draft.id,
                draft.revision,
                draft.r#type.as_str(),
                draft.title,
                draft.details,
                draft.area.as_deref().unwrap_or("(unset)")
            ))
        }
        FeedbackCommand::Edit {
            session,
            id,
            title,
            details,
            area,
            kind,
        } => {
            let store = store_for(dsh_home, session)?;
            let draft = store.update(id, title, details, area.as_deref(), kind.clone())?;
            note(log_path, "feedback_draft_edit", true, 1)?;
            Ok(format!(
                "updated local draft {} revision {}. Not sent.",
                draft.id, draft.revision
            ))
        }
        FeedbackCommand::Delete { session, id } => {
            let store = store_for(dsh_home, session)?;
            if !store.delete(id)? {
                return Err(PrivacyError::NotFound);
            }
            note(log_path, "feedback_draft_delete", true, 1)?;
            Ok(format!("deleted local draft {id}"))
        }
        FeedbackCommand::Submit { session, id } => {
            let store = store_for(dsh_home, session)?;
            match submit_draft(&store, id, policy) {
                Ok(result) => {
                    note(log_path, "feedback_submit", true, 1)?;
                    let _ = maybe_telemetry(policy, "feedback_submit", true, 1);
                    Ok(format!(
                        "submitted draft {id} to the configured feedback destination (HTTP {}). Local copy {}.",
                        result.status,
                        if result.deleted { "deleted" } else { "kept" }
                    ))
                }
                Err(error) => {
                    note(log_path, "feedback_submit", false, 1)?;
                    Err(error)
                }
            }
        }
    }
}

fn store_for(dsh_home: &Path, session: &str) -> Result<DraftStore, PrivacyError> {
    let dir = session_dir(dsh_home, session)?;
    Ok(DraftStore::new(&dir))
}

fn maybe_telemetry(
    policy: &PrivacyPolicy,
    kind: &'static str,
    ok: bool,
    count: u32,
) -> Result<(), PrivacyError> {
    let event = DiagnosticEvent {
        schema_version: 1,
        kind,
        ok,
        count,
    };
    emit_diagnostic(policy, &event).map(|_| ())
}

fn note(path: Option<&Path>, kind: &str, ok: bool, count: u32) -> Result<(), PrivacyError> {
    let Some(path) = path else {
        return Ok(());
    };
    crate::privacy::append_local_log(path, &local_log_line(kind, ok, count))
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .filter(|value| !value.starts_with('-'))
        .cloned()
        .or_else(|| {
            args.iter().find_map(|arg| {
                arg.strip_prefix(&format!("{name}="))
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })
        })
}

fn required(args: &[String], name: &str) -> Result<String, PrivacyError> {
    flag(args, name).ok_or_else(|| PrivacyError::Io(format!("missing {name}")))
}

fn kind_of(args: &[String]) -> Result<FeedbackType, PrivacyError> {
    match flag(args, "--type") {
        None => Ok(FeedbackType::Bug),
        Some(value) => FeedbackType::parse(&value).ok_or_else(|| {
            PrivacyError::Io("feedback type must be bug, idea, or missing_capability".into())
        }),
    }
}
