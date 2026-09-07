---
'codsh-bundle': patch
---

fix(timing): calculate individual step duration for each thought segment on resume and live execution

Previously, `totalSeconds` calculated on resume and at the end of a turn incorrectly used the entire multi-step conversation turn duration (e.g. 10 minutes), causing every thought segment in the same turn to display identical long total durations. Thinking duration and total segment elapsed time are now calculated per step (from `step/start` to `step/end`), accurately reporting the exact start-to-finish duration for each output segment independently.
