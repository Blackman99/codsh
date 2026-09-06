---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(ci): restore clean line layout and fix viewport background/hover coordinate alignment

- Revert artificial synthetic vpad rows in transcripts that caused line count and turn offset mismatches in PTY and sticky headers.
- Keep left gutter glyphs clean without inner background wrappers to prevent trailing line truncation anomalies.
- Align viewport padding and hover fill index coordinates in `Screen.render`.
