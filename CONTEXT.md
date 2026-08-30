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
— a click anywhere in the one under the pointer works it, Ctrl+O works them
all — and collapsed when the conversation moves on. Thinking, long tool
output, and long finished answers are all folds. A fold names itself under the
pointer, as the **Hover readout**.
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

**Hover readout**:
The chrome row naming the fold the pointer rests on — what it is, how many
lines it holds, whether a click opens or folds it — for as long as it rests
there. Outranked by a flash, and it outranks the working indicator. It
borrows that chrome row rather than adding one, so the box does not jump.
Paired with a panel fill on every visible row of that block, the way
opencode marks the block under the pointer; the readout is what still
speaks when the head row is off the screen.
_Avoid_: tooltip, status hint

**Pasted image**:
The clipboard image Ctrl+V attaches behind an `[Image #N]` token in the box —
one backspace removes the token whole, and a deleted token drops its image.
At submit an image-capable model gets it as a first-class attachment block. A
text-only model always gets the original saved under
`$DSH_HOME/attachments/pasted/`; an explicit `CODSH_VISION_*` sidecar adds a
verbatim description first, otherwise a `deepseek-official` text model borrows
`deepseek-v4-flash-vision-exp` for that description automatically. Failure
keeps the file-only path. The file context and any description ride the same
message so they survive `--resume`; the selected conversation model never
changes.
_Avoid_: upload, embed

**Todo readout**:
The chrome row that holds the agent's todo list — progress plus the item in
flight — for as long as a list is live, opened into the full list with Ctrl+T.
Read from the `todos` projection, never remembered from the write.
_Avoid_: todo panel, task bar, progress bar

### Workflows

**Ship gates**:
The two approvals in the `/ship` workflow — the confirmed spec file (gate 1)
and the approved ticket breakdown (gate 2). Everything after gate 2 is
autonomous. Grill-me runs first (design tree, frontier rounds); to-spec and
to-tickets then synthesize without another interview. The spec file is the
workflow's memory, not the conversation: the approved tickets live in it as
checkboxes, its `Status:` line names the phase, a baseline run is recorded
before any code, each green ticket is committed, and a bare `/ship` offers
to resume whatever it finds unfinished.
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
implement, pin with tests, verify in the real TUI (PTY e2e or
`MOCK=… pnpm run dev`), sync, changeset, report.
