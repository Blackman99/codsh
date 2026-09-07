---
'codsh-bundle': patch
---

fix(replay): restore thinking duration and turn total elapsed time on session resume

During session replay (`/resume` or continuing a prior session), `replayEvents` previously rendered thinking folds with no timing arguments, causing all thought clocks to degrade to a bare `thought` string. Replay now indexes recorded step and turn boundary event timestamps, restoring the exact thinking duration and total turn duration for each deliberated step.
