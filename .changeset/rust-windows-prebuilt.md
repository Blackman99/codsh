---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust` now ships a native Windows x64 client (`win32-x64`, static MSVC runtime) and runs in a Windows console: typing (including CJK and characters that arrive as Alt codes), file approvals, dsh's `pwsh` shell tool, cancelling a command together with its process tree, resume, and install/update/rollback of the Rust Home. The codsh sandbox profiles are refused on Windows; the shared server, `--remote` and `wrap` are not available there.
