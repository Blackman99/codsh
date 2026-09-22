use serde_json::{Value, json};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct OwnerError {
    pub message: String,
}

impl std::fmt::Display for OwnerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for OwnerError {}

#[derive(Debug)]
pub struct SessionOwner {
    _file: File,
    pub path: PathBuf,
    pub session_id: String,
    pub pid: u32,
    pub token: String,
}

fn owner_dir(dsh_home: &Path) -> PathBuf {
    dsh_home.join("session-owners")
}

pub fn lock_path(dsh_home: &Path, session_id: &str) -> PathBuf {
    owner_dir(dsh_home).join(format!("{session_id}.lock"))
}

fn parse_owner(body: &str) -> Option<(u32, String)> {
    let value: Value = serde_json::from_str(body).ok()?;
    let pid = value.get("pid").and_then(Value::as_u64)? as u32;
    let token = value.get("token").and_then(Value::as_str)?.to_string();
    Some((pid, token))
}

#[cfg(unix)]
fn try_lock(file: &File) -> io::Result<bool> {
    use std::os::unix::io::AsRawFd;
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        return Ok(true);
    }
    let err = io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::EWOULDBLOCK) || err.raw_os_error() == Some(libc::EAGAIN) {
        Ok(false)
    } else {
        Err(err)
    }
}

#[cfg(windows)]
fn try_lock(file: &File) -> io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        h_event: *mut core::ffi::c_void,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LockFileEx(
            h_file: *mut core::ffi::c_void,
            dw_flags: u32,
            dw_reserved: u32,
            n_low: u32,
            n_high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
        fn GetLastError() -> u32;
    }
    const LOCKFILE_FAIL_IMMEDIATELY: u32 = 0x0000_0001;
    const LOCKFILE_EXCLUSIVE_LOCK: u32 = 0x0000_0002;
    const ERROR_LOCK_VIOLATION: u32 = 33;
    let mut overlapped = Overlapped {
        internal: 0,
        internal_high: 0,
        offset: 0,
        offset_high: 0,
        h_event: core::ptr::null_mut(),
    };
    let ok = unsafe {
        LockFileEx(
            file.as_raw_handle(),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut overlapped,
        )
    };
    if ok != 0 {
        return Ok(true);
    }
    let err = unsafe { GetLastError() };
    if err == ERROR_LOCK_VIOLATION {
        Ok(false)
    } else {
        Err(io::Error::from_raw_os_error(err as i32))
    }
}

impl SessionOwner {
    pub fn acquire(dsh_home: &Path, session_id: &str) -> Result<Self, OwnerError> {
        if session_id.is_empty()
            || session_id.contains('/')
            || session_id.contains('\\')
            || session_id.contains("..")
        {
            return Err(OwnerError {
                message: "invalid session id".into(),
            });
        }
        fs::create_dir_all(owner_dir(dsh_home)).map_err(|error| OwnerError {
            message: format!("cannot create session owner directory: {error}"),
        })?;
        let path = lock_path(dsh_home, session_id);
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| OwnerError {
                message: format!("cannot open session owner lock: {error}"),
            })?;
        if !try_lock(&file).map_err(|error| OwnerError {
            message: format!("cannot lock session owner: {error}"),
        })? {
            let mut body = String::new();
            let _ = file.read_to_string(&mut body);
            let pid = parse_owner(&body).map(|(pid, _)| pid);
            return Err(OwnerError {
                message: match pid {
                    Some(pid) => format!(
                        "Write owner refused: session {session_id} is already running (pid {pid})."
                    ),
                    None => {
                        format!("Write owner refused: session {session_id} is already running.")
                    }
                },
            });
        }
        let pid = std::process::id();
        let token = format!(
            "{pid}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0)
        );
        let body = format!(
            "{}\n",
            json!({
                "sessionId": session_id,
                "pid": pid,
                "token": token,
            })
        );
        file.set_len(0).map_err(|error| OwnerError {
            message: error.to_string(),
        })?;
        file.seek(SeekFrom::Start(0)).map_err(|error| OwnerError {
            message: error.to_string(),
        })?;
        file.write_all(body.as_bytes())
            .map_err(|error| OwnerError {
                message: error.to_string(),
            })?;
        file.flush().map_err(|error| OwnerError {
            message: error.to_string(),
        })?;
        Ok(Self {
            _file: file,
            path,
            session_id: session_id.to_string(),
            pid,
            token,
        })
    }

    pub fn still_held(&self) -> bool {
        let Ok(body) = fs::read_to_string(&self.path) else {
            return false;
        };
        parse_owner(&body).is_some_and(|(pid, token)| pid == self.pid && token == self.token)
    }
}

impl Drop for SessionOwner {
    fn drop(&mut self) {
        // flock releases when the descriptor closes. Unlink only this holder's
        // file so a replacement owner is not erased and a parallel test does
        // not inherit a stale pid from a leftover lock.
        let Ok(body) = fs::read_to_string(&self.path) else {
            return;
        };
        if parse_owner(&body).is_some_and(|(pid, token)| pid == self.pid && token == self.token) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub fn last_session_path(dsh_home: &Path) -> PathBuf {
    dsh_home.join("rust-last-session.json")
}

pub fn write_last_session(dsh_home: &Path, session_id: &str, cwd: &Path) -> io::Result<()> {
    fs::create_dir_all(dsh_home)?;
    let tmp = dsh_home.join("rust-last-session.json.tmp");
    let body = json!({
        "sessionId": session_id,
        "cwd": cwd.to_string_lossy(),
    });
    fs::write(&tmp, format!("{body}\n"))?;
    fs::rename(tmp, last_session_path(dsh_home))
}

pub fn read_last_session(dsh_home: &Path) -> Option<(String, PathBuf)> {
    let body = fs::read_to_string(last_session_path(dsh_home)).ok()?;
    let value: Value = serde_json::from_str(&body).ok()?;
    let session_id = value.get("sessionId").and_then(Value::as_str)?.to_string();
    let cwd = value.get("cwd").and_then(Value::as_str)?;
    Some((session_id, PathBuf::from(cwd)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_home() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = NEXT.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("codsh-owner-{stamp}-{seq}-{}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn acquire_records_pid_and_second_lock_is_refused() {
        let home = temp_home();
        let first = SessionOwner::acquire(&home, "session-a").expect("first owner");
        assert!(first.still_held());
        let error = SessionOwner::acquire(&home, "session-a").expect_err("second owner");
        assert!(
            error.message.contains("Write owner refused"),
            "{}",
            error.message
        );
        assert!(
            error.message.contains(&first.pid.to_string()),
            "{}",
            error.message
        );
        let path = first.path.clone();
        drop(first);
        assert!(!path.exists(), "released owner must unlink its lock file");
        let again = SessionOwner::acquire(&home, "session-a").expect("reacquire after release");
        let kept = again.path.clone();
        drop(again);
        assert!(!kept.exists(), "reacquired owner must unlink its lock file");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn last_session_round_trip() {
        let home = temp_home();
        write_last_session(&home, "abc", Path::new("/tmp/ws")).unwrap();
        let (id, cwd) = read_last_session(&home).expect("pointer");
        assert_eq!(id, "abc");
        assert_eq!(cwd, PathBuf::from("/tmp/ws"));
        let _ = fs::remove_dir_all(home);
    }
}
