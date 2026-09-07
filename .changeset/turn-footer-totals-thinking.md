---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(tui): total a turn's thinking time in the footer instead of listing every segment

A turn that stopped to think before each of seventeen tool calls ended on
`10m 22s (thought 0.9s, 4.2s, 0.1s, 1.1s, 0.1s, 10.0s, 0.0s, 6.0s, 3.8s, 6.1s, 0.1s, 5.1s, 2.1s, 0.0s, 1.1s, 0.0s, 1.7s) · 9.5M tokens`
— a line of durations longer than some of the answers it summarized, and one
that said nothing new: every thinking block already carries its own clock, on
its own summary row, written into the transcript where that thinking actually
happened (`✻ thought for 4.2s`). The footer now reports the total it belongs
to instead: `10m 22s (thought 42s) · 9.5M tokens`. A turn with a single
thinking block reads exactly as it did before.
