//! #220: approval requests from subagents and workflow children, shown in
//! the main session.
//!
//! dsh's ACP server only asks the client about the top-level session. A
//! child agent's ask comes over the private control channel instead
//! (`child_approval`, see `packages/cli/bin/rust-acp-child-approval.mjs`).
//! The requests wait here in arrival order behind the main session's own
//! permission prompt; the first one is shown on the status line with who is
//! asking (workflow or subagent, and its label), the tool, and the target.
//! `y` allows once, `a` also records a remembered grant exactly as the main
//! prompt does, `n` rejects. dsh closes a request itself when the child's
//! call is aborted (workflow cancel, Ctrl+C) or the child goes away.
//!
//! Reference (grok-build a28ee2b `acp_handler/permissions.rs`): a subagent's
//! request joins the owning session's permission queue with a
//! `Subagent "<description>" (<type>):` label.

use crate::permission::{self, AccessKind};
use serde_json::Value;
use std::collections::VecDeque;

const TARGET_MAX: usize = 160;

/// One child's pending ask.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub id: String,
    pub session_id: String,
    pub child: String,
    pub label: String,
    pub agent_type: String,
    pub workflow: Option<String>,
    pub phase: Option<String>,
    pub tool: String,
    pub input: Value,
}

impl Request {
    /// What the tool would touch, as permission rules see it.
    pub fn access(&self) -> AccessKind {
        permission::access_from_tool(&self.tool, &self.input)
    }

    /// Who is asking: the workflow and the child's label, or the subagent.
    pub fn source(&self) -> String {
        let label = if self.label.is_empty() {
            "child"
        } else {
            self.label.as_str()
        };
        let kind = if self.agent_type.is_empty() || self.agent_type == label {
            String::new()
        } else {
            format!(" ({})", self.agent_type)
        };
        match &self.workflow {
            Some(workflow) => {
                let phase = self
                    .phase
                    .as_deref()
                    .filter(|phase| !phase.is_empty())
                    .map(|phase| format!(" [{phase}]"))
                    .unwrap_or_default();
                format!("workflow {workflow}{phase} · {label}{kind}")
            }
            None if self.label.is_empty() && self.agent_type.is_empty() => {
                "child session (untracked)".into()
            }
            None => format!("subagent \"{label}\"{kind}"),
        }
    }

    /// The target of the call: URL, command, path, or the arguments.
    pub fn target(&self) -> String {
        let text = match self.access() {
            AccessKind::WebFetch(url) => url,
            AccessKind::WebSearch(query) => query,
            AccessKind::Bash(command) => command,
            AccessKind::Edit(path) => path,
            AccessKind::Read(path) | AccessKind::Grep { path } => path.unwrap_or_default(),
            AccessKind::Mcp { .. } | AccessKind::Tool(_) => match &self.input {
                Value::Object(map) if map.is_empty() => String::new(),
                Value::Null => String::new(),
                other => other.to_string(),
            },
        };
        let flat: String = text
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        if flat.chars().count() > TARGET_MAX {
            let cut: String = flat.chars().take(TARGET_MAX - 1).collect();
            format!("{cut}…")
        } else {
            flat
        }
    }

    /// What `a` saves, or None when this kind of call is never remembered.
    pub fn remember_label(&self) -> Option<&'static str> {
        match self.access() {
            AccessKind::WebFetch(url) if permission_host(&url) => Some("a=remember domain"),
            AccessKind::Bash(_) | AccessKind::Mcp { .. } | AccessKind::Edit(_) => {
                Some("a=always this project")
            }
            _ => None,
        }
    }
}

fn permission_host(url: &str) -> bool {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or("");
    !rest.split(['/', '?', '#']).next().unwrap_or("").is_empty()
}

/// Requests in arrival order; the first is the one shown.
#[derive(Debug, Default)]
pub struct Queue {
    items: VecDeque<Request>,
}

impl Queue {
    /// Queue a request. A repeated id (a resend) is ignored.
    pub fn push(&mut self, request: Request) -> bool {
        if request.id.is_empty() || self.items.iter().any(|item| item.id == request.id) {
            return false;
        }
        self.items.push_back(request);
        true
    }

    pub fn current(&self) -> Option<&Request> {
        self.items.front()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Take the shown request to answer it.
    pub fn take_current(&mut self) -> Option<Request> {
        self.items.pop_front()
    }

    /// Put an answered request back in front (the answer could not be sent).
    pub fn restore(&mut self, request: Request) {
        if !self.items.iter().any(|item| item.id == request.id) {
            self.items.push_front(request);
        }
    }

    /// dsh closed a request (aborted child, stale answer). True when it was queued.
    pub fn close(&mut self, id: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|item| item.id != id);
        before != self.items.len()
    }

    /// Drop everything (the control channel closed). Returns how many were dropped.
    pub fn clear(&mut self) -> usize {
        let count = self.items.len();
        self.items.clear();
        count
    }

    /// Keep only requests of the live session (after /new or /resume).
    pub fn retain_session(&mut self, live: Option<&str>) -> usize {
        let before = self.items.len();
        match live {
            Some(live) => self.items.retain(|item| item.session_id == live),
            None => self.items.clear(),
        }
        before - self.items.len()
    }

    /// The status-line prompt for the shown request.
    pub fn line(&self, remember: bool) -> Option<String> {
        let request = self.current()?;
        let target = request.target();
        let subject = if target.is_empty() {
            request.tool.clone()
        } else {
            format!("{} {target}", request.tool)
        };
        let keys = match request.remember_label().filter(|_| remember) {
            Some(label) => format!("y=allow once  {label}  n=reject"),
            None => "y=allow once  n=reject".into(),
        };
        let waiting = match self.len() {
            0 | 1 => String::new(),
            n => format!(" (+{} more waiting)", n - 1),
        };
        Some(format!(
            "Approval from {}: allow {subject}? {keys}{waiting}",
            request.source()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fetch(id: &str, url: &str) -> Request {
        Request {
            id: id.into(),
            session_id: "s1".into(),
            child: format!("child-{id}"),
            label: "researcher-1".into(),
            agent_type: "researcher".into(),
            workflow: Some("deep-research".into()),
            phase: None,
            tool: "web_fetch".into(),
            input: json!({ "url": url }),
        }
    }

    #[test]
    fn line_names_workflow_agent_tool_and_target() {
        let mut queue = Queue::default();
        assert!(queue.line(true).is_none());
        queue.push(fetch("a", "https://example.org/page"));
        assert_eq!(
            queue.line(true).unwrap(),
            "Approval from workflow deep-research · researcher-1 (researcher): allow web_fetch https://example.org/page? y=allow once  a=remember domain  n=reject"
        );
        // Remembering disabled: no `a`.
        assert_eq!(
            queue.line(false).unwrap(),
            "Approval from workflow deep-research · researcher-1 (researcher): allow web_fetch https://example.org/page? y=allow once  n=reject"
        );
    }

    #[test]
    fn requests_queue_in_order_and_are_not_lost() {
        let mut queue = Queue::default();
        assert!(queue.push(fetch("a", "https://a.test/")));
        assert!(queue.push(fetch("b", "https://b.test/")));
        assert!(queue.push(fetch("c", "https://c.test/")));
        assert!(
            !queue.push(fetch("b", "https://b.test/")),
            "resend is ignored"
        );
        assert!(queue.line(true).unwrap().ends_with("(+2 more waiting)"));
        let first = queue.take_current().unwrap();
        assert_eq!(first.id, "a");
        queue.restore(first.clone());
        assert_eq!(
            queue.current().unwrap().id,
            "a",
            "an unsent answer keeps its place"
        );
        assert_eq!(queue.take_current().unwrap().id, "a");
        assert_eq!(queue.current().unwrap().id, "b");
        assert_eq!(queue.take_current().unwrap().id, "b");
        assert_eq!(queue.take_current().unwrap().id, "c");
        assert!(queue.take_current().is_none());
    }

    #[test]
    fn close_removes_an_aborted_request_anywhere_in_the_queue() {
        let mut queue = Queue::default();
        queue.push(fetch("a", "https://a.test/"));
        queue.push(fetch("b", "https://b.test/"));
        assert!(queue.close("b"));
        assert!(!queue.close("b"), "already closed");
        assert!(queue.close("a"));
        assert!(queue.is_empty());
        queue.push(fetch("c", "https://c.test/"));
        assert_eq!(queue.clear(), 1);
        assert!(queue.current().is_none());
    }

    #[test]
    fn retain_session_drops_requests_of_an_old_session() {
        let mut queue = Queue::default();
        queue.push(fetch("a", "https://a.test/"));
        let mut other = fetch("b", "https://b.test/");
        other.session_id = "s2".into();
        queue.push(other);
        assert_eq!(queue.retain_session(Some("s2")), 1);
        assert_eq!(queue.current().unwrap().id, "b");
        assert_eq!(queue.retain_session(None), 1);
        assert!(queue.is_empty());
    }

    #[test]
    fn source_and_target_for_other_children() {
        let request = Request {
            id: "x".into(),
            session_id: "s1".into(),
            child: "c".into(),
            label: "fix tests".into(),
            agent_type: "general-purpose".into(),
            workflow: None,
            phase: None,
            tool: "bash".into(),
            input: json!({ "command": "cargo test\n--all" }),
        };
        assert_eq!(request.source(), "subagent \"fix tests\" (general-purpose)");
        assert_eq!(request.target(), "cargo test --all");
        assert_eq!(request.remember_label(), Some("a=always this project"));
        let untracked = Request {
            label: String::new(),
            agent_type: String::new(),
            tool: "image_gen".into(),
            input: json!({}),
            ..request.clone()
        };
        assert_eq!(untracked.source(), "child session (untracked)");
        assert_eq!(untracked.target(), "");
        assert_eq!(untracked.remember_label(), None);
        let long = Request {
            input: json!({ "command": "x".repeat(400) }),
            ..request
        };
        assert_eq!(long.target().chars().count(), TARGET_MAX);
        let phased = Request {
            phase: Some("verify".into()),
            ..fetch("p", "notaurl")
        };
        assert_eq!(
            phased.source(),
            "workflow deep-research [verify] · researcher-1 (researcher)"
        );
        assert_eq!(phased.remember_label(), None, "no host to remember");
    }
}
