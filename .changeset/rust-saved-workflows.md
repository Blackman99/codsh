---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust` now loads saved Rhai workflows from `<project>/.grok/workflows` (trusted folders, taking precedence) and `$GROK_HOME/workflows`. `/workflows` lists them with what is hidden or invalid, `/<name> [args]` and `/workflow <name> [--agent-budget N] [--effort LEVEL] [args]` launch one in the background, the model can launch one by name and sees the listing, and `/workflow save <name>` keeps a finished run as a project workflow without replacing files. A running or resumed run keeps the script it launched with.
