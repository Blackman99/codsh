# codsh

A terminal coding agent composed on the dsh plugin runtime, whose interaction
design deliberately aligns with the best of today's agent CLIs.

## Language

### Product shape

**Launcher**:
The `codsh-cli` npm package — a zero-dependency command that finds an existing
dsh, registers the Bundle into a profile, and boots it.
_Avoid_: wrapper, shim, cli package

**Bundle**:
The `codsh-bundle` npm package — the interactive surface and agent preset,
installed into dsh profiles, never globally.
_Avoid_: runtime package, plugin (alone)

**Profile**:
A dsh-owned installation root under `$DSH_HOME/profiles/<name>` holding the
Bundle and its resolved dependencies. The unit a machine installs codsh into.

**Preset**:
The `code-cli` agent composition the Bundle ships; what a session mounts to
decide the model-facing toolset.

### Surface

**Viewport**:
The alternate-screen area the session owns: its own scrollback, wrapping,
scrolling, and frame painting. The terminal's native buffer is never touched.

**Chrome**:
The bottom-pinned rows: input box, menus, hint row, status row. Never scrolls.

**Fold**:
A transcript block kept in both a summary and a full form, swappable in place
(Ctrl+O), collapsed when the conversation moves on. Thinking, long tool
output, and long finished answers are all folds.
_Avoid_: collapse block, expandable section

**Rule**:
The mark drawn down a transcript block's left edge to say where the block
starts and ends — heavy for the person's own message, light for a tool block,
error-coloured for a failed one, absent for what a person reads. Chrome, not
content: it repeats on wrapped rows and never reaches the clipboard.
_Avoid_: border, gutter, sidebar

**Flash**:
A short-lived notice that borrows the hint row and gives it back (e.g. the
copy toast).

**Todo readout**:
The chrome row that holds the agent's todo list — progress plus the item in
flight — for as long as a list is live, opened into the full list with Ctrl+T.
Read from the `todos` projection, never remembered from the write.
_Avoid_: todo panel, task bar, progress bar

### Workflows

**Ship gates**:
The two approvals in the `/ship` workflow — the confirmed spec file (gate 1)
and the approved implementation plan (gate 2). Everything after gate 2 is
autonomous.
_Avoid_: checkpoints, review steps

### Alignment pipeline

**Reference Agent**:
One of the four agent CLIs codsh aligns against: Claude Code, opencode,
Codex CLI, gemini-cli. Claude Code wins ties (ADR-0001).

**Alignment Matrix**:
The in-repo table (`docs/alignment.md`) of every interaction/feature gap and
its state. The pipeline's memory and the definition of done.

**Behavioral Probing**:
Driving a real Reference Agent in a PTY with the VT emulator and diffing its
observable behavior against codsh. Used only when knowledge and source
reading leave a dispute.

**Batch**:
One user-initiated autonomous run of the pipeline: pick open matrix rows,
implement, pin with tests, sync, changeset, report.
