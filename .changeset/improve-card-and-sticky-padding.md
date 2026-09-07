---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(tui): pad transcript panels at their edges, not around every card

Background-filled blocks read as panels only when their text does not touch the
panel edge — but padding each card separately spent three rows on every card
that had one line to say, so a batch of reads pushed the answer off the screen.

- Tool cards that follow one another now share one panel: the first pads above,
  the last pads below, and inside the run a card with body rows keeps the pad
  above it as its divider while a bare one-liner takes that row over. Three
  consecutive reads went from twelve rows to five.
- A card closes on that padding row instead of on a plain blank, so the gap to
  whatever follows is one row rather than two. Piped output is unchanged.
- The person's own message is a panel too, inset two columns like every other
  block and padded above and below. Its padding wraps the block rather than
  joining it, so the turn's navigation seam, its fold, and its pinned copy stay
  the text that was actually typed — and a submitted prompt arrives with that
  opening row showing rather than pressed against the top of the screen.
- A collapsed thinking block is one row again. Padding a one-line summary only
  stacked the `✻` the gutter repeats down every row of a block, three deep, to
  say one word.
- Card heads, thinking summaries and prompt text are inset two columns, lining
  up with the body lines under them and off the block rule beside them.
- The pinned sticky turn header is a panel too: a padding row of its fill above
  the prompt and one below, then the divider that hands the screen back to the
  transcript. It spends one more viewport row than before.
