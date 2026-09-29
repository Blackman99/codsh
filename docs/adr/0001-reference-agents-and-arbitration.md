# Reference agents, and Claude Code wins ties

> Superseded for the interactive TUI by [ADR-0002](0002-grok-cli-primary-tui-reference.md):
> there Grok CLI wins ties and Claude Code decides only where Grok has no
> equivalent. This ADR still arbitrates everything outside the TUI.

codsh aligns its interaction design against four reference agents — Claude
Code, opencode, Codex CLI, and gemini-cli — and when they disagree on a
behavior, Claude Code's behavior is copied; where Claude Code lacks the
feature, opencode decides; Codex CLI and gemini-cli are corroboration only.
This is a standing arbitration rule, not a per-case debate: it settles every
future UX fork the moment it appears, and it encodes the project owner's
stated preference ("参考 claude") from field use. Diverging from ALL
references is allowed only as an explicit, user-confirmed design rejection
recorded in the Alignment Matrix.
