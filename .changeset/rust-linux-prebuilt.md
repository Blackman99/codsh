---
'codsh-cli': patch
'codsh-bundle': patch
---

The Linux Rust client no longer needs `libssl` (OpenSSL is compiled in), ships for arm64 as well as x64, and is checked before it starts: an older glibc, a musl system such as Alpine, or a missing shared library is refused with what to install, and `codsh --rust install-check` shows the glibc it found.
