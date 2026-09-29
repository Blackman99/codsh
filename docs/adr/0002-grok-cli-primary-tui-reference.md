# Grok CLI is the primary reference for the TUI, painted in DeepSeek blue

For codsh's interactive terminal UI — the viewport, transcript, composer,
pickers, keys, and slash commands of `codsh-bundle` — Grok CLI is the primary
reference agent. When references disagree on how the TUI behaves, Grok CLI's
behavior is copied. Where Grok CLI has no equivalent, Claude Code decides, then
opencode; Codex CLI and gemini-cli remain corroboration only. This supersedes
ADR-0001 for the TUI. ADR-0001 still arbitrates everything else (headless
output, configuration, sessions below the surface), and its rule stands that
diverging from every reference needs an explicit owner-confirmed rejection in
the Alignment Matrix.

The owner decided this on 2026-09-29: "对齐 Grok CLI 的用户体验", aligned
from scratch on main. The reference is the locally installed Grok CLI (1.0.41)
and its user guide (`~/.grok/docs/user-guide`). The Grok-derived Rust client
on `rewrite/grok-dsh-20260920` is not an input to this decision.

## Consequences

- **Key collisions are rebound, not negotiated.** Where Grok binds a key
  differently — Shift+Tab cycling permission modes, Ctrl+O for always-approve,
  Ctrl+R for the session picker, Ctrl+G for the tasks pane, Ctrl+Q / Ctrl+D as
  a double-press quit, Ctrl+C clearing a draft rather than quitting at an idle
  prompt, Esc never cancelling a turn — codsh adopts Grok's binding in its own
  batch. The feature a key displaced moves to a new key, and the changeset
  says so, because it breaks muscle memory.
- **Visual identity is a recorded divergence.** codsh keeps Grok's theme
  *model* — a central theme of named slots in full RGB, quantized per terminal
  depth, a `/theme` picker with live preview, `auto` following the background,
  a `terminal` theme painting only ANSI colours, and the cursor recoloured with
  OSC 12 — but not Grok's palettes. The brand is DeepSeek blue #4D6BFE, with
  its tint #7E96F5 for thinking, links, headings, and paths. Grok's own themes
  (GrokNight, TokyoNight, …) are not ported.
- **Batches.** The work lands in batches through the standing alignment
  pipeline, in dependency order: themes; keymap and permission modes;
  composer semantics; visual language; scrollback focus and entry selection;
  commands; terminal features. Each opens and closes rows in the Alignment
  Matrix's "Grok CLI alignment" section with test anchors.
