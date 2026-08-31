---
"codsh-bundle": patch
---

Arrow keys work with Caps Lock or Num Lock held. A lock rides in the modifier field of a CSI report, so Down arrived as `ESC [ 1;65 B`, matched none of the chords the decoder listed, and was typed into the box as `[1;65B` instead of moving the command menu. Cursor and editing keys are now parsed rather than enumerated, and locks are stripped the way the kitty path already stripped them.
