---
'codsh-cli': patch
'codsh-bundle': patch
---

The optional Ship extension for `codsh --rust` now runs the whole `/ship` flow while dsh executes every agent: grill, to-spec and tickets with both gates auto-Confirmed (gate 1 seals the Mission Contract), a parallel landing wave in isolated worktrees with serial `merge --no-ff` and the legacy conflict validation, a separate final verification turn, and Merge-back. The Stop hook continues each phase, a bare `/ship` resumes any phase, a failed or cancelled child is never merged or ticked (its worktree is kept and the ticket is dispatched again on resume), a missing sealed contract stops the run, and a lost run state is rebuilt from the files. The Rust client now shows the text of a Stop-hook-continued model call, and a hook that exits without reading its input (or is killed by a cancel) no longer crashes dsh.
