//! `codsh --rust wrap <command> [args...]` (ticket 155).
//!
//! Runs a command (usually `ssh host`) locally inside a pseudo-terminal,
//! forwards OSC 52 clipboard writes from it to the local clipboard, and
//! restores terminal modes the command left enabled when it exits or the
//! connection drops. The child gets `GROK_OSC52_SINK=1` and
//! `LC_GROK_OSC52_SINK=1`; the `LC_` form survives OpenSSH's default
//! `SendEnv LC_*`.

use base64::Engine;
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

const MAX_SEQUENCE: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Chunk {
    Pass(Vec<u8>),
    Copy(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Ground,
    Esc,
    Osc,
    OscEsc,
    Csi,
    Dcs,
    DcsEsc,
}

/// Private modes that are restored by turning them off.
const OFF_MODES: &[(u32, &str)] = &[
    (1, "application cursor keys"),
    (9, "mouse reporting"),
    (66, "application keypad"),
    (1000, "mouse reporting"),
    (1001, "mouse reporting"),
    (1002, "mouse reporting"),
    (1003, "mouse reporting"),
    (1004, "focus reporting"),
    (1005, "mouse reporting"),
    (1006, "mouse reporting"),
    (1015, "mouse reporting"),
    (1016, "mouse reporting"),
    (2004, "bracketed paste"),
    (2026, "synchronized output"),
    (1049, "alternate screen"),
    (1047, "alternate screen"),
    (47, "alternate screen"),
];
/// Private modes that are restored by turning them back on.
const ON_MODES: &[(u32, &str)] = &[(25, "hidden cursor"), (7, "line wrapping")];

/// Byte-stream filter: passes everything through except OSC 52 clipboard
/// writes, which become `Chunk::Copy`, and tracks modes to restore.
#[derive(Debug)]
pub struct Filter {
    state: State,
    buf: Vec<u8>,
    enabled: BTreeSet<u32>,
    disabled: BTreeSet<u32>,
    kitty_depth: u32,
    kitty_set: bool,
    modify_other_keys: bool,
    keypad: bool,
    last_copy: Option<(String, Instant)>,
    pub copies: usize,
    pub queries_dropped: usize,
}

impl Default for Filter {
    fn default() -> Self {
        Self::new()
    }
}

impl Filter {
    pub fn new() -> Self {
        Filter {
            state: State::Ground,
            buf: Vec::new(),
            enabled: BTreeSet::new(),
            disabled: BTreeSet::new(),
            kitty_depth: 0,
            kitty_set: false,
            modify_other_keys: false,
            keypad: false,
            last_copy: None,
            copies: 0,
            queries_dropped: 0,
        }
    }

    pub fn feed(&mut self, input: &[u8]) -> Vec<Chunk> {
        let mut out = Vec::new();
        let mut pass = Vec::new();
        for &byte in input {
            match self.state {
                State::Ground => {
                    if byte == 0x1b {
                        self.buf.clear();
                        self.buf.push(byte);
                        self.state = State::Esc;
                    } else {
                        pass.push(byte);
                    }
                }
                State::Esc => {
                    self.buf.push(byte);
                    self.state = match byte {
                        b']' => State::Osc,
                        b'[' => State::Csi,
                        b'P' => State::Dcs,
                        0x1b => {
                            // Lone ESC followed by another: pass the first.
                            pass.push(0x1b);
                            self.buf.clear();
                            self.buf.push(0x1b);
                            State::Esc
                        }
                        _ => {
                            match byte {
                                b'c' => self.reset_all(),
                                b'=' => self.keypad = true,
                                b'>' => self.keypad = false,
                                _ => {}
                            }
                            pass.append(&mut self.buf);
                            State::Ground
                        }
                    };
                }
                State::Osc => {
                    self.buf.push(byte);
                    if byte == 0x07 {
                        self.finish_osc(&mut pass, &mut out, 1);
                    } else if byte == 0x1b {
                        self.state = State::OscEsc;
                    }
                }
                State::OscEsc => {
                    self.buf.push(byte);
                    if byte == b'\\' {
                        self.finish_osc(&mut pass, &mut out, 2);
                    } else {
                        pass.append(&mut self.buf);
                        self.state = State::Ground;
                    }
                }
                State::Csi => {
                    self.buf.push(byte);
                    if (0x40..=0x7e).contains(&byte) {
                        self.track_csi();
                        pass.append(&mut self.buf);
                        self.state = State::Ground;
                    }
                }
                State::Dcs => {
                    self.buf.push(byte);
                    if byte == 0x1b {
                        self.state = State::DcsEsc;
                    }
                }
                State::DcsEsc => {
                    self.buf.push(byte);
                    self.state = State::Dcs;
                    if byte == b'\\' {
                        self.finish_dcs(&mut pass, &mut out);
                    }
                }
            }
            if self.state != State::Ground && self.buf.len() > MAX_SEQUENCE {
                // Unterminated giant sequence: give up on it, pass it raw.
                pass.append(&mut self.buf);
                self.state = State::Ground;
            }
        }
        if !pass.is_empty() {
            out.push(Chunk::Pass(pass));
        }
        out
    }

    /// Bytes of an unfinished sequence, released at exit.
    pub fn take_pending(&mut self) -> Vec<u8> {
        self.state = State::Ground;
        std::mem::take(&mut self.buf)
    }

    fn flush_pass(pass: &mut Vec<u8>, out: &mut Vec<Chunk>) {
        if !pass.is_empty() {
            out.push(Chunk::Pass(std::mem::take(pass)));
        }
    }

    fn finish_osc(&mut self, pass: &mut Vec<u8>, out: &mut Vec<Chunk>, terminator: usize) {
        self.state = State::Ground;
        let body = &self.buf[2..self.buf.len() - terminator];
        match self.osc52_text(body) {
            Osc52::NotClipboard => pass.append(&mut self.buf),
            Osc52::Query => {
                // A remote program asking for the local clipboard is not answered.
                self.queries_dropped += 1;
                self.buf.clear();
            }
            Osc52::Text(text) => {
                self.buf.clear();
                Self::flush_pass(pass, out);
                if let Some(text) = self.dedupe(text) {
                    out.push(Chunk::Copy(text));
                }
            }
        }
    }

    fn finish_dcs(&mut self, pass: &mut Vec<u8>, out: &mut Vec<Chunk>) {
        self.state = State::Ground;
        let prefix = b"\x1bPtmux;";
        if self.buf.starts_with(prefix) {
            let inner = &self.buf[prefix.len()..self.buf.len() - 2];
            let mut unescaped = Vec::with_capacity(inner.len());
            let mut index = 0;
            while index < inner.len() {
                if inner[index] == 0x1b && inner.get(index + 1) == Some(&0x1b) {
                    unescaped.push(0x1b);
                    index += 2;
                } else {
                    unescaped.push(inner[index]);
                    index += 1;
                }
            }
            let terminator = if unescaped.ends_with(b"\x1b\\") {
                2
            } else if unescaped.ends_with(b"\x07") {
                1
            } else {
                0
            };
            if terminator > 0 && unescaped.starts_with(b"\x1b]") {
                let body = &unescaped[2..unescaped.len() - terminator];
                match self.osc52_text(body) {
                    Osc52::Text(text) => {
                        self.buf.clear();
                        Self::flush_pass(pass, out);
                        if let Some(text) = self.dedupe(text) {
                            out.push(Chunk::Copy(text));
                        }
                        return;
                    }
                    Osc52::Query => {
                        self.queries_dropped += 1;
                        self.buf.clear();
                        return;
                    }
                    Osc52::NotClipboard => {}
                }
            }
        }
        pass.append(&mut self.buf);
    }

    fn osc52_text(&self, body: &[u8]) -> Osc52 {
        let Some(rest) = body.strip_prefix(b"52;") else {
            return Osc52::NotClipboard;
        };
        let Some(split) = rest.iter().position(|byte| *byte == b';') else {
            return Osc52::NotClipboard;
        };
        let data = &rest[split + 1..];
        if data == b"?" {
            return Osc52::Query;
        }
        match base64::engine::general_purpose::STANDARD.decode(data) {
            Ok(bytes) => Osc52::Text(String::from_utf8_lossy(&bytes).into_owned()),
            Err(_) => Osc52::NotClipboard,
        }
    }

    /// Programs inside tmux often send the same copy twice (plain and
    /// passthrough); deliver it once.
    fn dedupe(&mut self, text: String) -> Option<String> {
        let now = Instant::now();
        if let Some((last, at)) = &self.last_copy
            && *last == text
            && now.duration_since(*at) < Duration::from_secs(1)
        {
            return None;
        }
        self.last_copy = Some((text.clone(), now));
        self.copies += 1;
        Some(text)
    }

    fn reset_all(&mut self) {
        self.enabled.clear();
        self.disabled.clear();
        self.kitty_depth = 0;
        self.kitty_set = false;
        self.modify_other_keys = false;
        self.keypad = false;
    }

    fn track_csi(&mut self) {
        let seq = &self.buf[2..];
        let Some((&last, params)) = seq.split_last() else {
            return;
        };
        let params = String::from_utf8_lossy(params);
        let numbers = |text: &str| -> Vec<u32> {
            text.split(';')
                .filter_map(|part| part.parse::<u32>().ok())
                .collect()
        };
        if let Some(modes) = params.strip_prefix('?') {
            if last != b'h' && last != b'l' {
                return;
            }
            let on = last == b'h';
            for mode in numbers(modes) {
                if ON_MODES.iter().any(|(known, _)| *known == mode) {
                    if on {
                        self.disabled.remove(&mode);
                    } else {
                        self.disabled.insert(mode);
                    }
                } else if OFF_MODES.iter().any(|(known, _)| *known == mode) {
                    if on {
                        self.enabled.insert(mode);
                    } else {
                        self.enabled.remove(&mode);
                    }
                }
            }
            return;
        }
        match last {
            b'u' => {
                if let Some(flags) = params.strip_prefix('>') {
                    let _ = flags;
                    self.kitty_depth += 1;
                } else if let Some(count) = params.strip_prefix('<') {
                    let count = count.parse::<u32>().unwrap_or(1).max(1);
                    self.kitty_depth = self.kitty_depth.saturating_sub(count);
                } else if let Some(flags) = params.strip_prefix('=') {
                    let value = flags.split(';').next().unwrap_or("0");
                    self.kitty_set = value != "0";
                }
            }
            b'm' => {
                if let Some(rest) = params.strip_prefix('>') {
                    let parts = numbers(rest);
                    if parts.first() == Some(&4) {
                        self.modify_other_keys = parts.get(1).copied().unwrap_or(0) != 0;
                    }
                }
            }
            _ => {}
        }
    }

    /// Bytes that undo what the child left enabled, and a label for each.
    pub fn restore_sequence(&self) -> (Vec<u8>, Vec<&'static str>) {
        let mut bytes = String::new();
        let mut names: Vec<&'static str> = Vec::new();
        let name = |label: &'static str, names: &mut Vec<&'static str>| {
            if !names.contains(&label) {
                names.push(label);
            }
        };
        if self.kitty_depth > 0 {
            bytes.push_str(&format!("\x1b[<{}u", self.kitty_depth));
            name("kitty keyboard", &mut names);
        }
        if self.kitty_set {
            bytes.push_str("\x1b[=0;1u");
            name("kitty keyboard", &mut names);
        }
        if self.modify_other_keys {
            bytes.push_str("\x1b[>4;0m");
            name("modifyOtherKeys", &mut names);
        }
        if self.keypad {
            bytes.push_str("\x1b>");
            name("application keypad", &mut names);
        }
        let alt = [1049u32, 1047, 47];
        for (mode, label) in OFF_MODES {
            if alt.contains(mode) || !self.enabled.contains(mode) {
                continue;
            }
            bytes.push_str(&format!("\x1b[?{mode}l"));
            name(label, &mut names);
        }
        for (mode, label) in ON_MODES {
            if self.disabled.contains(mode) {
                bytes.push_str(&format!("\x1b[?{mode}h"));
                name(label, &mut names);
            }
        }
        for mode in alt {
            if self.enabled.contains(&mode) {
                bytes.push_str(&format!("\x1b[?{mode}l"));
                name("alternate screen", &mut names);
            }
        }
        if !bytes.is_empty() {
            bytes.push_str("\x1b[0m");
        }
        (bytes.into_bytes(), names)
    }
}

enum Osc52 {
    NotClipboard,
    Query,
    Text(String),
}

pub fn usage() -> &'static str {
    "usage: codsh --rust wrap <command> [args...]\n\
     Runs <command> (for example `ssh user@host`) in a local pseudo-terminal.\n\
     OSC 52 clipboard writes from it are copied to this machine's clipboard,\n\
     and terminal modes it leaves on are restored when it exits or drops.\n\
     The command sees GROK_OSC52_SINK=1 and LC_GROK_OSC52_SINK=1."
}

#[cfg(not(unix))]
pub fn run(_args: &[String], _grok_home: &std::path::Path) -> i32 {
    eprintln!("codsh wrap is not supported on this platform yet (needs a Unix pseudo-terminal)");
    2
}

#[cfg(unix)]
mod unix {
    use super::{Chunk, Filter};
    use crate::clipboard::{self, CopyContext, Delivery};
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    struct TermiosGuard {
        saved: Option<libc::termios>,
    }

    impl TermiosGuard {
        fn restore(&mut self) {
            if let Some(saved) = self.saved.take() {
                unsafe {
                    libc::tcsetattr(0, libc::TCSANOW, &saved);
                }
            }
        }
    }

    impl Drop for TermiosGuard {
        fn drop(&mut self) {
            self.restore();
        }
    }

    fn winsize(fd: RawFd) -> Option<libc::winsize> {
        let mut size: libc::winsize = unsafe { std::mem::zeroed() };
        let ok = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut size) } == 0;
        (ok && size.ws_row > 0).then_some(size)
    }

    fn write_out(bytes: &[u8]) {
        let mut stdout = std::io::stdout().lock();
        let _ = stdout.write_all(bytes);
        let _ = stdout.flush();
    }

    pub fn run(args: &[String], grok_home: &Path) -> i32 {
        let Some(program) = args.first() else {
            eprintln!("{}", super::usage());
            return 2;
        };
        let tty = unsafe { libc::isatty(0) } == 1;
        let mut saved: Option<libc::termios> = None;
        if tty {
            let mut current: libc::termios = unsafe { std::mem::zeroed() };
            if unsafe { libc::tcgetattr(0, &mut current) } == 0 {
                saved = Some(current);
            }
        }
        let size = winsize(1).or_else(|| winsize(0));
        let mut master: libc::c_int = -1;
        let mut slave: libc::c_int = -1;
        let opened = unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                saved
                    .as_ref()
                    .map_or(std::ptr::null(), |termios| termios as *const libc::termios),
                size.as_ref()
                    .map_or(std::ptr::null(), |size| size as *const libc::winsize),
            )
        };
        if opened != 0 {
            eprintln!(
                "codsh wrap: cannot open a pseudo-terminal: {}",
                std::io::Error::last_os_error()
            );
            return 1;
        }
        unsafe {
            libc::fcntl(master, libc::F_SETFD, libc::FD_CLOEXEC);
        }
        let slave_file = unsafe { std::fs::File::from_raw_fd(slave) };
        let stdio = |file: &std::fs::File| {
            file.try_clone()
                .map(Stdio::from)
                .unwrap_or_else(|_| Stdio::null())
        };
        let mut command = Command::new(program);
        command
            .args(&args[1..])
            .env("GROK_OSC52_SINK", "1")
            .env("LC_GROK_OSC52_SINK", "1")
            .env_remove("CODSH_WRAP_GROK_HOME")
            .stdin(stdio(&slave_file))
            .stdout(stdio(&slave_file))
            .stderr(stdio(&slave_file));
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                drop(slave_file);
                unsafe {
                    libc::close(master);
                }
                eprintln!("codsh wrap: cannot run {program}: {error}");
                return 127;
            }
        };
        drop(slave_file);
        let child_pid = child.id() as libc::pid_t;
        let mut guard = TermiosGuard { saved };
        if let Some(saved) = guard.saved {
            let mut raw = saved;
            unsafe {
                libc::cfmakeraw(&mut raw);
                libc::tcsetattr(0, libc::TCSANOW, &raw);
            }
        }
        let winch = Arc::new(AtomicBool::new(false));
        let hangup = Arc::new(AtomicBool::new(false));
        let terminate = Arc::new(AtomicBool::new(false));
        let _ = signal_hook::flag::register(signal_hook::consts::SIGWINCH, Arc::clone(&winch));
        let _ = signal_hook::flag::register(signal_hook::consts::SIGHUP, Arc::clone(&hangup));
        let _ = signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&terminate));
        let _ = signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&terminate));

        // Keyboard → child. The thread may stay blocked in read() after the
        // child ends; the process exits right after, which ends it.
        let input_master = unsafe { libc::dup(master) };
        std::thread::spawn(move || {
            let mut writer = unsafe { std::fs::File::from_raw_fd(input_master) };
            let mut stdin = std::io::stdin().lock();
            let mut buf = [0u8; 4096];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if writer.write_all(&buf[..count]).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let copy_ctx = CopyContext::detect(grok_home);
        let mut filter = Filter::new();
        let mut reader = unsafe { std::fs::File::from_raw_fd(master) };
        let mut buf = vec![0u8; 16384];
        let mut exited: Option<std::process::ExitStatus> = None;
        let mut exited_at: Option<Instant> = None;
        let mut signalled = false;
        let mut last_copy: Option<(Delivery, String)> = None;
        loop {
            if winch.swap(false, Ordering::Relaxed)
                && let Some(size) = winsize(1).or_else(|| winsize(0))
            {
                unsafe {
                    libc::ioctl(reader.as_raw_fd(), libc::TIOCSWINSZ, &size);
                }
            }
            if !signalled && (hangup.load(Ordering::Relaxed) || terminate.load(Ordering::Relaxed)) {
                let signal = if hangup.load(Ordering::Relaxed) {
                    libc::SIGHUP
                } else {
                    libc::SIGTERM
                };
                unsafe {
                    libc::kill(child_pid, signal);
                }
                signalled = true;
            }
            if exited.is_none()
                && let Ok(Some(status)) = child.try_wait()
            {
                exited = Some(status);
                exited_at = Some(Instant::now());
            }
            let mut poll = libc::pollfd {
                fd: reader.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = unsafe { libc::poll(&mut poll, 1, 50) };
            if ready > 0 && poll.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        for chunk in filter.feed(&buf[..count]) {
                            match chunk {
                                Chunk::Pass(bytes) => write_out(&bytes),
                                Chunk::Copy(text) => {
                                    let mut stdout = std::io::stdout().lock();
                                    let report = clipboard::copy(&text, &copy_ctx, &mut stdout);
                                    last_copy = Some((report.delivery, report.message));
                                }
                            }
                        }
                    }
                }
            } else if let Some(at) = exited_at {
                // The child is gone and nothing is left to drain (a
                // grandchild may still hold the terminal open).
                if at.elapsed() > Duration::from_millis(200) {
                    break;
                }
            }
        }
        let pending = filter.take_pending();
        if !pending.is_empty() {
            write_out(&pending);
        }
        let status = match exited {
            Some(status) => status,
            None => child
                .wait()
                .unwrap_or_else(|_| std::process::ExitStatus::from_raw(1 << 8)),
        };
        let (restore, names) = filter.restore_sequence();
        if !restore.is_empty() {
            write_out(&restore);
        }
        guard.restore();
        if !names.is_empty() {
            eprintln!(
                "codsh wrap: restored terminal state left on by {program}: {}",
                names.join(", ")
            );
        }
        if filter.copies > 0
            && let Some((delivery, message)) = last_copy
        {
            eprintln!(
                "codsh wrap: forwarded {} clipboard cop{} (last: {}): {message}",
                filter.copies,
                if filter.copies == 1 { "y" } else { "ies" },
                delivery.label()
            );
        }
        if filter.queries_dropped > 0 {
            eprintln!(
                "codsh wrap: refused {} OSC 52 clipboard read request(s) from {program}",
                filter.queries_dropped
            );
        }
        match (status.code(), status.signal()) {
            (Some(code), _) => code,
            (None, Some(signal)) => {
                eprintln!("codsh wrap: {program} ended by signal {signal} (connection dropped?)");
                128 + signal
            }
            _ => 1,
        }
    }
}

#[cfg(unix)]
pub fn run(args: &[String], grok_home: &std::path::Path) -> i32 {
    unix::run(args, grok_home)
}

/// Where wrap keeps its copy backup: the launcher passes the isolated
/// GROK_HOME as CODSH_WRAP_GROK_HOME because wrap itself runs with the
/// user's real environment.
pub fn grok_home() -> std::path::PathBuf {
    for key in ["CODSH_WRAP_GROK_HOME", "GROK_HOME"] {
        if let Some(value) = std::env::var_os(key).filter(|value| !value.is_empty()) {
            return value.into();
        }
    }
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default()
        .join(".grok")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(filter: &mut Filter, parts: &[&[u8]]) -> Vec<Chunk> {
        let mut chunks = Vec::new();
        for part in parts {
            chunks.extend(filter.feed(part));
        }
        chunks
    }

    fn passed(chunks: &[Chunk]) -> Vec<u8> {
        chunks
            .iter()
            .filter_map(|chunk| match chunk {
                Chunk::Pass(bytes) => Some(bytes.clone()),
                Chunk::Copy(_) => None,
            })
            .flatten()
            .collect()
    }

    fn copies(chunks: &[Chunk]) -> Vec<String> {
        chunks
            .iter()
            .filter_map(|chunk| match chunk {
                Chunk::Copy(text) => Some(text.clone()),
                Chunk::Pass(_) => None,
            })
            .collect()
    }

    #[test]
    fn osc52_is_intercepted_even_when_split() {
        let mut filter = Filter::new();
        let chunks = feed_all(
            &mut filter,
            &[
                b"before\x1b]5",
                b"2;c;aGVs",
                b"bG8=\x07after",
                b"\x1b]0;title\x07",
            ],
        );
        assert_eq!(copies(&chunks), vec!["hello".to_string()]);
        assert_eq!(passed(&chunks), b"beforeafter\x1b]0;title\x07".to_vec());
    }

    #[test]
    fn st_terminated_and_tmux_wrapped_copies_dedupe() {
        let mut filter = Filter::new();
        let chunks = filter.feed(
            b"\x1b]52;c;YWJj\x1b\\\x1bPtmux;\x1b\x1b]52;c;YWJj\x07\x1b\\\x1bPtmux;\x1b\x1b]52;c;eHl6\x1b\x1b\\\x1b\\",
        );
        assert_eq!(copies(&chunks), vec!["abc".to_string(), "xyz".to_string()]);
        assert!(passed(&chunks).is_empty());
        assert_eq!(filter.copies, 2);
    }

    #[test]
    fn queries_are_dropped_and_other_dcs_pass() {
        let mut filter = Filter::new();
        let chunks = filter.feed(b"\x1b]52;c;?\x07\x1bPtmux;\x1b\x1b]9;hi\x07\x1b\\");
        assert!(copies(&chunks).is_empty());
        assert_eq!(filter.queries_dropped, 1);
        assert_eq!(
            passed(&chunks),
            b"\x1bPtmux;\x1b\x1b]9;hi\x07\x1b\\".to_vec()
        );
    }

    #[test]
    fn modes_left_on_are_restored_in_order() {
        let mut filter = Filter::new();
        filter.feed(b"\x1b[?1049h\x1b[?1000;1006h\x1b[?2004h\x1b[?25l\x1b[>1u\x1b[?1h\x1b=");
        filter.feed(b"\x1b[?1000l");
        let (bytes, names) = filter.restore_sequence();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with("\x1b[<1u"));
        assert!(text.contains("\x1b[?1006l"));
        assert!(
            !text.contains("\x1b[?1000l"),
            "already turned off by the child"
        );
        assert!(text.contains("\x1b[?2004l"));
        assert!(text.contains("\x1b[?25h"));
        assert!(text.contains("\x1b[?1l"));
        assert!(text.contains("\x1b>"));
        assert!(text.ends_with("\x1b[?1049l\x1b[0m"));
        for label in [
            "alternate screen",
            "mouse reporting",
            "bracketed paste",
            "hidden cursor",
            "kitty keyboard",
        ] {
            assert!(names.contains(&label), "{names:?}");
        }
    }

    #[test]
    fn clean_exit_needs_no_restore_and_ris_resets() {
        let mut filter = Filter::new();
        filter.feed(b"\x1b[?1049h\x1b[?2004h\x1b[?2004l\x1b[?1049l");
        assert!(filter.restore_sequence().0.is_empty());
        filter.feed(b"\x1b[?1000h\x1bc");
        assert!(filter.restore_sequence().0.is_empty());
        let mut split = Filter::new();
        let chunks = feed_all(&mut split, &[b"\x1b[?10", b"49h"]);
        assert_eq!(passed(&chunks), b"\x1b[?1049h".to_vec());
        assert!(!split.restore_sequence().0.is_empty());
    }
}
