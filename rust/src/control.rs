//! Private control channel to the dsh child: steering queued follow-ups into a
//! running turn, side questions (`/btw`), and (ticket 179) the question card,
//! plan review, plan-mode state, and todos. The dsh half is
//! `packages/cli/bin/rust-acp-control.mjs`.
//!
//! The client listens on a Unix socket inside a fresh 0700 directory and
//! passes the path and a random one-time token to dsh. It accepts exactly one
//! connection, requires the token as the first line, then unlinks the socket.
//! A wrong token closes the channel for good. Nothing here runs a model or a
//! tool: dsh stays the execution core, this only carries requests to it.

use serde_json::{Value, json};
use std::io;
use std::sync::mpsc::{self, Receiver, TryRecvError};

pub const SOCKET_ENV: &str = "CODSH_CONTROL_SOCKET";
pub const TOKEN_ENV: &str = "CODSH_CONTROL_TOKEN";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlEvent {
    /// dsh connected and presented the token.
    Ready,
    SteerAccepted(String),
    /// The agent was not running; the row stays queued.
    SteerIdle(String),
    /// The running agent took the steer into a step.
    SteerClaimed(String),
    /// dsh discarded or gave back the steer; the row is queued again.
    SteerReturned(String),
    BtwAnswer {
        id: String,
        text: String,
    },
    BtwError {
        id: String,
        message: String,
    },
    /// dsh asks the user (`ask_user_question`, or `exit_plan_mode` when
    /// `review` is set). Only the question card answers it.
    Question {
        id: String,
        session_id: String,
        questions: Value,
        review: Option<Review>,
    },
    /// dsh closed a question (timeout, aborted turn) or refused a late answer.
    QuestionClosed {
        id: String,
        reason: String,
    },
    PlanState {
        session_id: String,
        active: bool,
        pending: Option<bool>,
        plan_file: String,
    },
    PlanResult {
        id: String,
        outcome: String,
        message: String,
    },
    /// The `todos` projection: `None` before the first write of a turn.
    Todos {
        session_id: String,
        todos: Option<Value>,
    },
    /// Ctrl+B or a send-now: how many foreground commands dsh moved to the
    /// background (0 when none was running).
    BackgroundResult {
        id: String,
        count: u64,
    },
    /// The tasks pane's stop request: dsh's kill outcome, or why it failed.
    JobKillResult {
        id: String,
        job: String,
        outcome: Result<String, String>,
    },
    /// The channel is gone (dsh exited, never connected, or failed the handshake).
    Closed(String),
}

/// The plan under review. `plan` is empty when none was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Review {
    pub plan: String,
    pub plan_file: String,
}

pub fn parse_event(line: &str) -> Option<ControlEvent> {
    let value: Value = serde_json::from_str(line).ok()?;
    let kind = value.get("type")?.as_str()?;
    let id = || value.get("id").and_then(Value::as_str).map(str::to_string);
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    Some(match kind {
        "steer_accepted" => ControlEvent::SteerAccepted(id()?),
        "steer_idle" => ControlEvent::SteerIdle(id()?),
        "steer_claimed" => ControlEvent::SteerClaimed(id()?),
        "steer_returned" => ControlEvent::SteerReturned(id()?),
        "btw_answer" => ControlEvent::BtwAnswer {
            id: id()?,
            text: text("text"),
        },
        "btw_error" => ControlEvent::BtwError {
            id: id()?,
            message: text("message"),
        },
        "question" => ControlEvent::Question {
            id: id()?,
            session_id: text("sessionId"),
            questions: value.get("questions").cloned().unwrap_or(Value::Null),
            review: value
                .get("review")
                .filter(|v| v.is_object())
                .map(|review| Review {
                    plan: review
                        .get("plan")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    plan_file: review
                        .get("planFile")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                }),
        },
        "question_closed" => ControlEvent::QuestionClosed {
            id: id()?,
            reason: text("reason"),
        },
        "plan_state" => ControlEvent::PlanState {
            session_id: text("sessionId"),
            active: value.get("active").and_then(Value::as_bool)?,
            pending: value.get("pending").and_then(Value::as_bool),
            plan_file: text("planFile"),
        },
        "plan_result" => ControlEvent::PlanResult {
            id: id()?,
            outcome: text("outcome"),
            message: text("message"),
        },
        "todos" => ControlEvent::Todos {
            session_id: text("sessionId"),
            todos: value.get("todos").filter(|v| v.is_array()).cloned(),
        },
        "background_result" => ControlEvent::BackgroundResult {
            id: id()?,
            count: value.get("count").and_then(Value::as_u64).unwrap_or(0),
        },
        "job_kill_result" => ControlEvent::JobKillResult {
            id: id()?,
            job: text("jobId"),
            outcome: match value.get("error").and_then(Value::as_str) {
                Some(error) => Err(error.to_string()),
                None => Ok(text("outcome")),
            },
        },
        _ => return None,
    })
}

/// Compare without an early exit on the first differing byte.
pub fn token_matches(expected: &str, got: &str) -> bool {
    let a = expected.as_bytes();
    let b = got.as_bytes();
    let mut diff = (a.len() ^ b.len()) as u8 | u8::from(a.len() != b.len());
    for (index, byte) in a.iter().enumerate() {
        diff |= byte ^ b.get(index).copied().unwrap_or(0);
    }
    diff == 0 && !a.is_empty()
}

pub fn steer_message(id: &str, session_id: &str, text: &str) -> Value {
    json!({ "type": "steer", "id": id, "sessionId": session_id, "text": text })
}

pub fn btw_message(id: &str, session_id: &str, question: &str) -> Value {
    json!({ "type": "btw", "id": id, "sessionId": session_id, "question": question })
}

pub fn btw_cancel_message(id: &str) -> Value {
    json!({ "type": "btw_cancel", "id": id })
}

/// Answer the question card. `comments` rides along with a plan approval.
pub fn question_answer_message(id: &str, answers: Vec<Value>, comments: Option<&str>) -> Value {
    let mut value = json!({ "type": "question_answer", "id": id, "answers": answers });
    if let Some(comments) = comments {
        value["comments"] = json!(comments);
    }
    value
}

/// Shift+X: the agent continues without an answer.
pub fn question_dismiss_message(id: &str) -> Value {
    json!({ "type": "question_dismiss", "id": id })
}

/// `q` in the plan review: abandon the plan and turn plan mode off.
pub fn plan_quit_message(id: &str) -> Value {
    json!({ "type": "plan_quit", "id": id })
}

pub fn plan_set_message(id: &str, session_id: &str, active: bool) -> Value {
    json!({ "type": "plan_set", "id": id, "sessionId": session_id, "active": active })
}

/// `reason` is `user` (Ctrl+B) or `message` (a send-now interrupting a command).
pub fn background_message(id: &str, session_id: &str, reason: &str) -> Value {
    json!({ "type": "background", "id": id, "sessionId": session_id, "reason": reason })
}

pub fn job_kill_message(id: &str, session_id: &str, job_id: &str) -> Value {
    json!({ "type": "job_kill", "id": id, "sessionId": session_id, "jobId": job_id })
}

pub struct ControlChannel {
    rx: Receiver<ControlEvent>,
    ready: bool,
    closed: Option<String>,
    #[cfg(unix)]
    unix: unix::Shared,
}

impl ControlChannel {
    /// Start listening. Returns the channel and the environment to hand dsh.
    #[cfg(unix)]
    pub fn listen() -> io::Result<(Self, Vec<(String, String)>)> {
        let (tx, rx) = mpsc::channel();
        let (shared, env) = unix::listen(tx)?;
        Ok((
            Self {
                rx,
                ready: false,
                closed: None,
                unix: shared,
            },
            env,
        ))
    }

    #[cfg(not(unix))]
    pub fn listen() -> io::Result<(Self, Vec<(String, String)>)> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "steer and /btw need a Unix socket; unavailable on this platform",
        ))
    }

    /// Drain events. `Ready` and `Closed` also update the channel state.
    pub fn poll(&mut self) -> Vec<ControlEvent> {
        let mut out = Vec::new();
        loop {
            match self.rx.try_recv() {
                Ok(event) => {
                    match &event {
                        ControlEvent::Ready => self.ready = true,
                        ControlEvent::Closed(reason) => {
                            self.ready = false;
                            self.closed = Some(reason.clone());
                        }
                        _ => {}
                    }
                    out.push(event);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    if self.closed.is_none() {
                        self.ready = false;
                        self.closed = Some("control channel closed".into());
                        out.push(ControlEvent::Closed("control channel closed".into()));
                    }
                    break;
                }
            }
        }
        out
    }

    pub fn is_ready(&self) -> bool {
        self.ready && self.closed.is_none()
    }

    pub fn closed_reason(&self) -> Option<&str> {
        self.closed.as_deref()
    }

    pub fn send(&self, message: &Value) -> Result<(), String> {
        if !self.is_ready() {
            return Err(self
                .closed
                .clone()
                .unwrap_or_else(|| "dsh control channel is not connected yet".into()));
        }
        #[cfg(unix)]
        {
            self.unix.write_line(&message.to_string())
        }
        #[cfg(not(unix))]
        {
            let _ = message;
            Err("control channel unavailable on this platform".into())
        }
    }
}

#[cfg(unix)]
mod unix {
    use super::{ControlEvent, SOCKET_ENV, TOKEN_ENV, parse_event, token_matches};
    use std::fs;
    use std::io::{self, BufRead, BufReader, Read, Write};
    use std::os::unix::fs::DirBuilderExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::Sender;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    /// How long dsh has to load the plugin and connect.
    const CONNECT_DEADLINE: Duration = Duration::from_secs(120);
    const HELLO_DEADLINE: Duration = Duration::from_secs(5);
    const MAX_LINE: usize = 4 * 1024 * 1024;

    pub struct Shared {
        writer: Arc<Mutex<Option<UnixStream>>>,
        stop: Arc<AtomicBool>,
        dir: PathBuf,
    }

    impl Shared {
        pub fn write_line(&self, line: &str) -> Result<(), String> {
            let mut guard = self.writer.lock().map_err(|_| "control lock poisoned")?;
            let Some(stream) = guard.as_mut() else {
                return Err("dsh control channel is not connected".into());
            };
            stream
                .write_all(format!("{line}\n").as_bytes())
                .and_then(|()| stream.flush())
                .map_err(|error| format!("control channel write failed: {error}"))
        }
    }

    impl Drop for Shared {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Ok(mut guard) = self.writer.lock()
                && let Some(stream) = guard.take()
            {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
            cleanup(&self.dir);
        }
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_file(dir.join("s"));
        let _ = fs::remove_dir(dir);
    }

    fn random_hex(bytes: usize) -> io::Result<String> {
        let mut buf = vec![0u8; bytes];
        fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
        Ok(buf.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    pub fn listen(tx: Sender<ControlEvent>) -> io::Result<(Shared, Vec<(String, String)>)> {
        let token = random_hex(32)?;
        let dir = std::env::temp_dir().join(format!(
            "codsh-ctl-{}-{}",
            std::process::id(),
            random_hex(8)?
        ));
        // `create` fails if the path exists, so a planted directory is refused.
        fs::DirBuilder::new().mode(0o700).create(&dir)?;
        let path = dir.join("s");
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) => {
                cleanup(&dir);
                return Err(error);
            }
        };
        listener.set_nonblocking(true)?;
        let writer = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let env = vec![
            (SOCKET_ENV.to_string(), path.to_string_lossy().into_owned()),
            (TOKEN_ENV.to_string(), token.clone()),
        ];
        let thread_writer = Arc::clone(&writer);
        let thread_stop = Arc::clone(&stop);
        let thread_dir = dir.clone();
        thread::spawn(move || {
            let outcome = accept_one(&listener, &token, &thread_stop);
            drop(listener);
            // One connection only. The socket file goes as soon as it is decided.
            cleanup(&thread_dir);
            let (stream, reader) = match outcome {
                Ok(pair) => pair,
                Err(reason) => {
                    let _ = tx.send(ControlEvent::Closed(reason));
                    return;
                }
            };
            if let Ok(mut guard) = thread_writer.lock() {
                *guard = Some(stream);
            }
            let _ = tx.send(ControlEvent::Ready);
            read_events(reader, &tx);
            if let Ok(mut guard) = thread_writer.lock() {
                guard.take();
            }
            let _ = tx.send(ControlEvent::Closed(
                "dsh closed the control channel".into(),
            ));
        });
        Ok((Shared { writer, stop, dir }, env))
    }

    fn accept_one(
        listener: &UnixListener,
        token: &str,
        stop: &AtomicBool,
    ) -> Result<(UnixStream, BufReader<UnixStream>), String> {
        let deadline = Instant::now() + CONNECT_DEADLINE;
        let stream = loop {
            if stop.load(Ordering::Relaxed) {
                return Err("control channel stopped".into());
            }
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err("dsh did not open the control channel".into());
                    }
                    thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(format!("control channel accept failed: {error}")),
            }
        };
        stream
            .set_nonblocking(false)
            .and_then(|()| stream.set_read_timeout(Some(HELLO_DEADLINE)))
            .map_err(|error| format!("control channel setup failed: {error}"))?;
        let reader_stream = stream
            .try_clone()
            .map_err(|error| format!("control channel setup failed: {error}"))?;
        let mut reader = BufReader::new(reader_stream);
        let mut hello = String::new();
        let read = (&mut reader)
            .take(4096)
            .read_line(&mut hello)
            .map_err(|_| "control channel handshake timed out".to_string())?;
        let presented = serde_json::from_str::<serde_json::Value>(hello.trim())
            .ok()
            .filter(|value| value.get("type").and_then(|kind| kind.as_str()) == Some("hello"))
            .and_then(|value| {
                value
                    .get("token")
                    .and_then(|token| token.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_default();
        if read == 0 || !token_matches(token, &presented) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
            return Err("control channel refused a connection without the token".into());
        }
        stream
            .set_read_timeout(None)
            .map_err(|error| format!("control channel setup failed: {error}"))?;
        Ok((stream, reader))
    }

    fn read_events(mut reader: BufReader<UnixStream>, tx: &Sender<ControlEvent>) {
        loop {
            let mut line = String::new();
            match (&mut reader).take(MAX_LINE as u64).read_line(&mut line) {
                Ok(0) => return,
                Ok(_) if !line.ends_with('\n') && line.len() >= MAX_LINE => return,
                Ok(_) => {
                    if let Some(event) = parse_event(line.trim())
                        && tx.send(event).is_err()
                    {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_event_and_rejects_unknown() {
        assert_eq!(
            parse_event(r#"{"type":"steer_claimed","id":"q1"}"#),
            Some(ControlEvent::SteerClaimed("q1".into()))
        );
        assert_eq!(
            parse_event(r#"{"type":"steer_returned","id":"q1"}"#),
            Some(ControlEvent::SteerReturned("q1".into()))
        );
        assert_eq!(
            parse_event(r#"{"type":"steer_idle","id":"q2"}"#),
            Some(ControlEvent::SteerIdle("q2".into()))
        );
        assert_eq!(
            parse_event(r#"{"type":"btw_answer","id":"b1","text":"hi"}"#),
            Some(ControlEvent::BtwAnswer {
                id: "b1".into(),
                text: "hi".into()
            })
        );
        assert_eq!(
            parse_event(r#"{"type":"btw_error","id":"b1","message":"x"}"#),
            Some(ControlEvent::BtwError {
                id: "b1".into(),
                message: "x".into()
            })
        );
        assert_eq!(
            parse_event(
                r##"{"type":"question","id":"q9","sessionId":"s","questions":[{"id":"a"}],"review":{"plan":"# P","planFile":"/p.md"}}"##
            ),
            Some(ControlEvent::Question {
                id: "q9".into(),
                session_id: "s".into(),
                questions: json!([{ "id": "a" }]),
                review: Some(Review {
                    plan: "# P".into(),
                    plan_file: "/p.md".into()
                }),
            })
        );
        assert_eq!(
            parse_event(r#"{"type":"background_result","id":"g1","count":1}"#),
            Some(ControlEvent::BackgroundResult {
                id: "g1".into(),
                count: 1
            })
        );
        assert_eq!(
            parse_event(
                r#"{"type":"plan_state","sessionId":"s","active":true,"pending":false,"planFile":"/p"}"#
            ),
            Some(ControlEvent::PlanState {
                session_id: "s".into(),
                active: true,
                pending: Some(false),
                plan_file: "/p".into()
            })
        );
        assert_eq!(
            parse_event(r#"{"type":"todos","sessionId":"s","todos":null}"#),
            Some(ControlEvent::Todos {
                session_id: "s".into(),
                todos: None
            })
        );
        assert_eq!(
            parse_event(r#"{"type":"question_closed","id":"q9","reason":"timeout"}"#),
            Some(ControlEvent::QuestionClosed {
                id: "q9".into(),
                reason: "timeout".into()
            })
        );
        assert_eq!(
            parse_event(r#"{"type":"plan_state","sessionId":"s"}"#),
            None
        );
        assert_eq!(
            parse_event(
                r#"{"type":"job_kill_result","id":"k1","jobId":"j1","outcome":"requested"}"#
            ),
            Some(ControlEvent::JobKillResult {
                id: "k1".into(),
                job: "j1".into(),
                outcome: Ok("requested".into())
            })
        );
        assert_eq!(
            parse_event(r#"{"type":"job_kill_result","id":"k2","jobId":"j1","error":"gone"}"#),
            Some(ControlEvent::JobKillResult {
                id: "k2".into(),
                job: "j1".into(),
                outcome: Err("gone".into())
            })
        );
        assert_eq!(
            background_message("g1", "s1", "user"),
            serde_json::json!({"type":"background","id":"g1","sessionId":"s1","reason":"user"})
        );
        assert_eq!(
            job_kill_message("k1", "s1", "j1"),
            serde_json::json!({"type":"job_kill","id":"k1","sessionId":"s1","jobId":"j1"})
        );
        assert_eq!(parse_event(r#"{"type":"ready"}"#), None);
        assert_eq!(parse_event(r#"{"type":"steer_claimed"}"#), None);
        assert_eq!(parse_event("not json"), None);
    }

    #[test]
    fn token_compare_requires_exact_match() {
        assert!(token_matches("abc123", "abc123"));
        assert!(!token_matches("abc123", "abc124"));
        assert!(!token_matches("abc123", "abc12"));
        assert!(!token_matches("abc123", "abc1234"));
        assert!(!token_matches("", ""));
    }

    #[cfg(unix)]
    fn wait_for(
        channel: &mut ControlChannel,
        want: impl Fn(&ControlEvent) -> bool,
    ) -> ControlEvent {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            for event in channel.poll() {
                if want(&event) {
                    return event;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "no matching control event"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    #[test]
    fn handshake_accepts_the_token_then_unlinks_the_socket() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::net::UnixStream;
        let (mut channel, env) = ControlChannel::listen().expect("listen");
        let path = std::path::PathBuf::from(&env.iter().find(|(k, _)| k == SOCKET_ENV).unwrap().1);
        let token = env.iter().find(|(k, _)| k == TOKEN_ENV).unwrap().1.clone();
        assert_eq!(token.len(), 64, "256-bit token");
        let mode = std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700, "private socket directory");
        assert!(
            channel.send(&steer_message("q", "s", "t")).is_err(),
            "not ready yet"
        );
        let mut client = UnixStream::connect(&path).expect("connect");
        writeln!(client, "{}", json!({ "type": "hello", "token": token })).unwrap();
        assert_eq!(
            wait_for(&mut channel, |event| matches!(event, ControlEvent::Ready)),
            ControlEvent::Ready
        );
        assert!(
            !path.exists(),
            "socket unlinked after the one accepted connection"
        );
        assert!(!path.parent().unwrap().exists(), "socket directory removed");
        channel
            .send(&steer_message("q1", "sess", "go left"))
            .expect("send");
        let mut reader = BufReader::new(client.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let sent: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(sent["type"], "steer");
        assert_eq!(sent["id"], "q1");
        assert_eq!(sent["sessionId"], "sess");
        assert_eq!(sent["text"], "go left");
        writeln!(client, r#"{{"type":"steer_claimed","id":"q1"}}"#).unwrap();
        assert_eq!(
            wait_for(&mut channel, |event| matches!(
                event,
                ControlEvent::SteerClaimed(_)
            )),
            ControlEvent::SteerClaimed("q1".into())
        );
        drop(reader);
        drop(client);
        assert!(matches!(
            wait_for(&mut channel, |event| matches!(
                event,
                ControlEvent::Closed(_)
            )),
            ControlEvent::Closed(_)
        ));
        assert!(!channel.is_ready());
    }

    #[cfg(unix)]
    #[test]
    fn a_wrong_token_closes_the_channel_for_good() {
        use std::io::Write;
        use std::os::unix::net::UnixStream;
        let (mut channel, env) = ControlChannel::listen().expect("listen");
        let path = std::path::PathBuf::from(&env.iter().find(|(k, _)| k == SOCKET_ENV).unwrap().1);
        let mut client = UnixStream::connect(&path).expect("connect");
        writeln!(client, "{}", json!({ "type": "hello", "token": "nope" })).unwrap();
        assert!(matches!(
            wait_for(&mut channel, |event| matches!(
                event,
                ControlEvent::Closed(_)
            )),
            ControlEvent::Closed(_)
        ));
        assert!(!channel.is_ready());
        assert!(!path.exists(), "no second chance: the socket is gone");
        assert!(channel.send(&btw_message("b", "s", "q")).is_err());
    }
}
