---
"codsh-bundle": minor
"codsh-cli": minor
---

Each transcript block now carries a rule down its left edge, so segments are told apart at a glance in a long history: the person's own message gets the heavy mark, a tool block the light one — in the error colour when the call failed — and what a person actually reads, an answer or a thinking summary, stays flush so the rules mark the machinery around it rather than everything equally. The rule repeats on every row a line wraps to, the blank line between blocks stays unmarked, and a selection that sweeps across a rule hands back the text without it: the mark is chrome this surface drew, not something anyone typed. Both references converge on a left border for this (Claude Code's `borderLeft`, opencode's `border: ["left"]`); the background fill opencode layers on top stays out, because the terminal's background is the theme's to decide (ADR-0001).
