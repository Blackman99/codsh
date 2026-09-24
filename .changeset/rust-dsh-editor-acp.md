---
'codsh-cli': minor
'codsh-bundle': minor
---

Editors can attach to the isolated Rust client with `codsh --rust agent stdio`. The process speaks ACP/JSON-RPC 1 and forwards sessions, prompts, config, approval, and cancel to dsh. `session/load` resumes the same dsh session and replays saved history without running tools again. A denied tool whose call id lives on the nested session message is replayed as failed. Model and reasoning changes are written to `$GROK_HOME/model-selection.toml` before the next prompt and restored on load and on a terminal resume, including an advertised model that is not a catalog id. An unknown model is refused. Terminal `/dontAsk` and `/acceptEdits` share the editor permission mode, and that mode is written before dsh starts. Unsupported `x.ai` methods return method-not-found instead of a success stub. Closing the editor releases the write owner so a terminal can resume the same session.
