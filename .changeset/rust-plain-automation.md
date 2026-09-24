---
'codsh-cli': minor
'codsh-bundle': minor
---

Run one plain prompt through the isolated Rust client and released dsh. `-p`/`--single`, `--prompt-file`, and `--prompt-json` print the final answer on stdout, and `--verbatim` sends that text unchanged. The tool mask is applied before the first model request, with public tool ids mapped to dsh names and deny winning over allow. `--max-turns` stops before the next model step. `help` and `completions` work for bash, zsh, fish, powershell, and elvish. Unknown options and missing values exit 2. JSON output and other specialized flags stay later tickets.
