# Agent output follows grok-build, with deliberate divergences

The agent-output rendering redesign (`docs/specs/agent-output-rendering.md`)
follows the output model of `xai-org/grok-build`: reasoning is the main display
area, a tool call is one quiet row, and consecutive calls merge into a verb-group
Fold. That registers `grok-build` as a fifth reference source, in the last
arbitration slot *behind* the four agents ADR-0001 names — it decides only where
Claude Code, opencode, Codex CLI and gemini-cli are all silent. ADR-0001's
priority chain is not rewritten.

Two divergences from `grok-build` are deliberate and owner-confirmed:

1. **Everything merges, including commands and edits.** grok-build's eager
   folding excludes `Command` and `EditFile` from the group; codsh folds them
   too, and an edit's expanded payload is the real diff, so folding its row
   loses nothing.
2. **`✻` is kept as the thinking mark.** grok-build draws `◆`; codsh keeps `✻`
   because it is already the agent role in the gutter and the banner, and the
   glyph vocabulary is not what this rendering change is about.

A third, codsh-specific divergence is the safety carve-out: a destructive
command breaks out of the group onto its own warning row, and a call waiting on
the person is never folded. grok-build has no equivalent.
