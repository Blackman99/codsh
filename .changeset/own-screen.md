---
"codsh-cli": minor
---

The session is now its own terminal space, the way Codex and opencode feel: codsh takes the alternate screen, keeps the transcript in a scrollback buffer it owns (mouse wheel, PgUp/PgDn, Shift+arrows; a notice shows how far back you are), and pins the input box to the bottom by construction. Your shell's history is untouched underneath and restored on exit, with a short session summary left behind. Every frame paints as a synchronized, row-diffed update, which removes the resize-ghost and overlap bugs of the old in-place drawing wholesale. Piped and `--print` runs are unchanged.
