---
"codsh-cli": patch
---

Tables whose cells wrap now rule between rows too: a full-width `─┼─` separator under every record, so a wrapped continuation cannot blur into the next row. Compact tables — nothing wrapped — keep only the head rule and stay dense.
