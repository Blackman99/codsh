---
'codsh-bundle': patch
---

Deduplicate redundant todos and clean up ticket titles in the `/ship` plan readout.

When `/ship` landed tickets in-session, tracking them via `todo_write` duplicated
the spec's plan readout verbatim when opened with `Ctrl+T`. The readout now omits
the duplicate todo section when a live plan covers the same tickets, keeping the
panel concise. Ticket titles read from spec checkboxes also strip verbose metadata
(such as blocking edges and deliverables) to avoid overflow and clipping in the TUI.
