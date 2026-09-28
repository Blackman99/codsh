# Three-platform capability matrix (#201)

The installed Rust client is checked on Linux, macOS and Windows with
`scripts/rust-capability-matrix.py` (the `capability-matrix` job of
`rust-platforms.yml`). Every cell is `ok`, `refused` or `unavailable`. A
missing device or a feature the platform cannot enforce is never a silent pass.

## How to run

```sh
# After pnpm install and build:rust (or with CODSH_MATRIX_LAUNCHER set to an install):
python3 scripts/rust-capability-matrix.py --output DIR
# Linux clipboard under X11:
xvfb-run -a python3 scripts/rust-capability-matrix.py --output DIR
```

Branches whose name contains `matrix` also run the job on ubuntu-22.04,
macos-15 and windows-2022. The job installs the packed `codsh-cli` tarball with
the registry dsh, records OS / terminal versions, and uploads
`capability-matrix-<name>` plus the Windows ConPTY report.

## Matrix rows

| Cell | What it proves |
| --- | --- |
| `keys_prompt` | Editing, history, CJK, paste, external editor, vim (Unix PTY; Windows: ConPTY `keys-history`) |
| `mouse_nav` | Mouse reporting and dock / welcome / fullscreen nav |
| `shell_tools` | Shell tool through dsh (pwsh on Windows) |
| `cancel_turn` | Cancel of a running turn / shell tree |
| `screen_modes` | Fullscreen ↔ minimal, alternate-screen restore |
| `terminal_restore_hangup_early_quit` | wrap / doctor / hangup / early-quit / early-keys |
| `clipboard_real` | Real pasteboard / X11 / Windows clipboard (no `CODSH_CLIPBOARD_IMAGE` fixture) |
| `voice_doctor` | `/voice doctor` without fixtures — never invents a microphone |
| `sandbox_profiles` | Bad glob refuses; workspace profile confines a probe child, or refuses with an actionable message |
| `remote_ssh` | Loopback OpenSSH remote PTY (refused on Windows) |
| `tmux_real` | Client inside a real tmux server: CJK, `/copy` → tmux buffer, mouse reporting, restore on quit |
| `windows_conpty` | Full ConPTY harness on Windows |

## Documented differences

### Linux

- Empty bracketed paste matches the reference (`Ignore`). Ctrl+V reads the
  image clipboard through `xclip` / `wl-paste` when a display is reachable.
  When the helper cannot open the display (missing `XAUTHORITY`, no
  `DISPLAY`/`WAYLAND_DISPLAY`), the client says so and attaches nothing —
  it does not pretend the clipboard was empty.
- A plain workspace profile is probed; Landlock cannot deny globs created
  after launch, so those profiles refuse. The known bubblewrap gap stays in
  the filesystem_sandbox unit tests.
- `voice.platform-unverified`: capture is not exercised; doctor lists no device.
- Real GNOME Terminal / Wayland sessions are not driven in CI; X11 is under
  `xvfb-run`.

### macOS

- Empty paste reads the pasteboard (Cmd+V → empty bracketed paste).
- Ad-hoc signature only; no Developer ID or notarization.
- Doctor can list microphones; opening the mic from this process is
  unverified (avfoundation / TCC). Recording uses `CODSH_VOICE_FIXTURE`.
  The CI runner lists only virtual devices (Apple Virtual Sound Device,
  Null Audio Device); that is a listing, not a recording.
- A closed terminal window is detected without SIGHUP: macOS does not report
  POLLHUP on the PTY slave, so stdin that stays readable with nothing pending
  (FIONREAD 0) for three checks 200 ms apart counts as a hangup; the client
  exits 129 and dsh ends with it.
- `/copy` forces a UTF-8 locale for `pbcopy`; without one (LANG unset, as
  under launchd or a bare CI shell) CJK reached the pasteboard as MacRoman.

### Windows

- ConPTY harness only (not Windows Terminal, conhost or VS Code).
- Clipboard image paste is unavailable: Ctrl+V and an empty paste say so and
  attach nothing. `/copy` goes through `clip.exe` as UTF-16LE (CJK survives).
- `voice.platform-unverified` with an empty device list.
- Sandbox profiles are refused (`not implemented on Windows`).
- Shared server, `--remote` and wrap are unavailable.
- dsh 0.1.5-rc.3 ACL sandbox cannot enter a workspace inside `%USERPROFILE%`;
  keep projects outside the profile or set dsh sandbox yourself.
- `npm` update fails with EBUSY while `codsh-rust.exe` is still running.
- No win32-arm64 prebuild.

## Related scripts

- `scripts/rust-clipboard-pty-test.py` — real clipboard (macOS pasteboard / X11)
- `scripts/rust-tmux-pty-test.py` — real tmux server
- `scripts/rust-windows-pty-test.py` — ConPTY harness (keys, clipboard, voice doctor, …)
- `scripts/rust-remote-pty-test.py` — loopback SSH
