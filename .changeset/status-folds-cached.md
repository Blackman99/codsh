---
"codsh-bundle": patch
---

The status row no longer re-derives plan mode and the permission preset by walking the whole session log on every event and every tick of the working indicator. Both are folded once per session and kept current by the events that change them, so a resumed long session streams without spending a share of every chunk on two booleans — six seconds of a two-minute turn on a 17,000-event session.
