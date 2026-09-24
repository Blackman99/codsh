---
'codsh-cli': patch
'codsh-bundle': patch
---

Fullscreen resume paints the same turn markers as minimal mode. An interrupted or cancelled turn, an empty answer, a still-open turn, and a compaction sentence stay on the transcript, the full-content view, and a later `--resume`. A completed tool whose status is unknown is not marked interrupted. An error line is not painted twice.
