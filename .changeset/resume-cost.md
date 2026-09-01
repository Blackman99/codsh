---
"codsh-bundle": patch
---

`codsh --resume`, `--continue`, and `/resume` open a long conversation quickly. Replaying a session wrote one line at a time and painted a frame after each, so a 2000-event log sent about 24,000 frames and 39MB of escape sequences to the terminal before the conversation appeared. The replay now hands over a whole event's lines at once and holds painting until the log is in: the same session sends 4 frames.
