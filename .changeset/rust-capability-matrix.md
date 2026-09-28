---
'codsh-cli': patch
'codsh-bundle': patch
---

Three-platform capability matrix for the installed Rust client (#201):
`scripts/rust-capability-matrix.py` and the `capability-matrix` job record OS /
terminal versions and the real effect of keys, mouse, shell, cancel, screen
modes, terminal restore, the real clipboard (macOS pasteboard, X11 `xclip`,
Windows `clip.exe` UTF-16LE), voice doctor without fixtures, sandbox profiles,
loopback SSH, real tmux, and the Windows ConPTY harness. Missing devices and
refused features are `refused` / `unavailable`, never a silent pass. Related:
`docs/rewrite/platform-capabilities.md`, `scripts/rust-clipboard-pty-test.py`,
`scripts/rust-tmux-pty-test.py`. Windows `/copy` sends UTF-16LE to `clip.exe`
so CJK survives; an unreachable Linux display is no longer reported as an
empty clipboard. macOS `/copy` forces a UTF-8 locale for `pbcopy` so CJK is not
turned into MacRoman, and a closed terminal window now ends the client on
macOS too (stdin readable with nothing pending counts as a hangup when no
POLLHUP arrives).
