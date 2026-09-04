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

**Sticky turn header**:
The real user prompt that owns the response currently crossing the top of the
Viewport. Its display-only copy stays pinned until the next real prompt pushes
it away, shrinking from at most three rows to one; the gap below it stays
empty. A prompt longer than three visual rows is a Fold by
default. While expanded it still ends the previous turn but does not pin.
Plugin context, tools, and other injected user-role messages never start a
turn, and the copied header is not transcript or clipboard content.
_Avoid_: sticky message, pinned response

**Turn navigation**:
The retained real-user Prompt descriptors exposed as numbered reading anchors.
Shift+Left/Right moves one anchor; `/jump` previews an anchor while its selector
moves, commits on Enter, and restores the exact prior Viewport on Escape.
Plugin-sourced user-role messages never enter this index — including the
template a Canned command expands into, whose echo is the Prompt that enters
in its place.

**Prompt-top anchor**:
Display-only tail space that places a newly submitted real-user Prompt at the
Viewport top while its response streams below. A Canned command's echo is
placed the same way, for the same reason: it spends a turn, so a reply is
about to fill the space. A command that only works the Chrome answers nothing
and is written where it falls. It belongs to the live turn,
not to a reading position: it scrolls with the transcript, so reading back and
returning to the tail lands on the anchored frame again. It ends when the
response fills the Viewport or the next Prompt takes it over, and is never
part of Scrollback, selection, search, replay, folds, or redirected output.

**Conversation timeline**:
The display-only one-column rail in the terminal's reserved rightmost column.
Each visible tick maps to a retained Turn navigation anchor; the current tick
uses the user colour, enabled arrows jump to the nearest Turn anchor above or
below the Viewport top, and tick hover previews up to two real-user Prompt
lines. Rendering and hit-testing share one frame geometry; modal surfaces hide
the rail.

**Content address**:
A stable raw-content address derived from assistant message events: `N` names
the Nth non-empty assistant answer, and `N:C` names its Cth closed fenced code
block. `/copy` selects these newest-first; `/copy N` copies raw Markdown and
`/copy N:C` copies the fence-free source. Tools, images, rendering chrome,
Sticky turn headers, Rules, and ANSI styling never enter this index.
_Avoid_: screen row, rendered block number

**Fullscreen viewer**:
A transient reader over one Content address, opened by `/view`, `/view N`, or
`/view N:C`, and over unified-diff text, opened by `/diff` or by clicking a
Diff card whose body was capped. It replaces transcript and Chrome for the
lifetime of the modal, reflows raw Markdown, fence-free code, or diff text at
the current terminal size, and gives wheel, shifted arrows, Page, Home/End, and
Escape to reading. Diff text is coloured by what each line does to the file,
never by the language it is written in. Closing restores the exact prior
Viewport; the viewer never adds a Prompt, Fold, search hit, session event,
clipboard write, or pipe output. Off a TTY there is no modal: `/diff` writes
its lines and stays a line reader.
_Avoid_: pager process, transcript view

**Reader hand-off**:
The raw text a Fold carries so a click opens the Fullscreen viewer instead of
expanding in place. Only a Diff card that outgrew its 24-line body takes one —
a short diff is already whole on screen. Ctrl+O is unaffected: expanding
everything still expands this block inline, and the collapsed line names both,
so the affordance never promises a gesture the block does not have.
_Avoid_: pager payload, click target

**Resume list**:
What `/resume` offers. The workspace a person is standing in is the list;
every other folder is one row that opens the rest, because the session wanted
is almost always in the folder they are in. Rows are ordered by when the
session was last touched — not when it began — and each names its title, that
age, how many messages it holds, and, only for a session from elsewhere, the
folder it belongs to.
_Avoid_: session picker, history list

**Region pointer**:
A pointer press, release, or move on the rows below the transcript — the
Chrome, and the Overlay drawn just above it. A selection may refuse it
outright (`keyboardOnly`): an approval grants a tool for the rest of the
session and cannot be taken back, so no click may decide it and no Pointer
mark may suggest one could. Those rows belong to whatever
composed them, so a pointer there never reaches the Viewport: a row that
offers something acts on it, and a row that offers nothing does nothing rather
than starting a selection. A press commits only where it is released, so
sliding off before letting go takes it back. A gesture nonetheless belongs to
where it began, through release: a drag the Viewport anchored keeps reaching it
once the pointer has left, because sweeping past the last line and letting go
over the input box is how a person selects to the end of what they can see, and
a drag the box anchored keeps selecting the same way, clamped into its text.
The Viewport keeps press-to-anchor, drag-to-extend, release-to-copy, and the
blank space under the last line anchors there too — a press with nowhere to
land is still where the pointer was resting, though only a press that landed on
a row can work that row's Fold. A press in the box that then moved is a Box
selection, not a Viewport one.
_Avoid_: click handler, hit area

**List window**:
Where an open list starts showing its rows. It follows the marked row, so the
`❯` is always in view — except while the wheel has moved it, which is the one
state it holds independently. Any key brings it back to the mark: a list
scrolled away from what Enter would take answers a question nobody asked. Only
the wheel moves it, never the keyboard's own scroll, which is why a scroll
carries where it turned and one without a place is left to the transcript.
_Avoid_: scroll offset, viewport

**Caret placement**:
Where a click inside the box puts the cursor. Near misses clamp rather than
miss — a border row takes the nearest content row, a column outside the text
takes the nearest end of it — because the text inside a frame is a narrow
target and "just above the first line" is an ordinary intention. The inverse
reads the same wrapped rows and the same window the box drew, so the cursor
cannot land somewhere the box never showed, and a shell box's hidden `!` is
given back. The press only has to land in the box: the release is the position
it means, because putting a cursor somewhere is not a thing to be undone. A
press that then moved is a Box selection, not this.
_Avoid_: click to focus, text hit test

**Box selection**:
A mouse selection over the text inside the box. Press anchors, drag extends,
release copies — the same gesture the Viewport gives the transcript, because
mouse reporting has taken the terminal's own selection. A press that never
moved is still Caret placement, and sliding off before any drag takes it back.
The span stays marked until the next click or move; typing, paste, and delete
replace it. Escape dismisses it before it means leave.
_Avoid_: input highlight, textarea selection

**Pointer mark**:
The row a Region pointer rests on, shown as a dim `·` in the column `❯` marks
from. One column answering two questions that cannot be confused: `❯` is what
Enter takes, `·` is only where the pointer is. Kept apart on purpose — a
pointer often comes to rest somewhere nobody chose, and moving the mark would
change what Enter does as a side effect of where the mouse is. The completion
menu is why it is the marker column rather than an underline: the label
already underlines the fragment that was typed.
_Avoid_: highlight, focus

**Plan progress**:
How far a `/ship` run has got, read from the spec file's `## Plan` checkboxes
rather than from the conversation — the spec file is the workflow's memory, and
its boxes are the only place the work is counted. The working line reports it
as `done/total` and names the first unticked ticket, which is what the round in
flight is landing. The round number a Workflow reports counts against a budget
and is the fallback, shown only when no plan has been found.
_Avoid_: todo list, task count

**Workflow progress**:
What a `tool-workflow/*` record becomes on screen. A run opens with its name,
each round prints one line as it settles, and the stop reason closes it. The
round still running is named in the working line instead, because the
transcript is append-only and cannot unprint a line when it ends. The line is
all a round gets: a workflow's children run in a worker thread, so their
sessions are never in this process and no click could enter one.
_Avoid_: workflow log, progress bar

**Canned command**:
A command whose body is a prompt template rather than a handler: `/ship`,
`/init`, and a person's own `custom-commands` entries. It spends a turn, so
what a person typed is echoed as a Prompt and the template itself never
reaches the transcript.
_Avoid_: macro, alias

**Fold preference**:
An ephemeral, per-Fold choice created by clicking a block or pressing Ctrl+O.
Explicit expanded and collapsed choices survive streaming completion, resize,
scrollback trimming, search, and later turns; moving on collapses only automatic
fresh-output states. A clear or session replacement discards preferences, and
replay creates capable but automatically collapsed Folds from durable events.
_Avoid_: session fold state, global expanded mode

**Chrome**:
The bottom-pinned rows: input box, menus, hint row, status row. Never scrolls.

**Row**:
One line of a frame, painted at a position of its own. A row is text and
nothing else: a control character inside one is not a character but a cursor
movement, and the width authority scores it zero columns — so a row carrying a
newline measures as a fit, paints its head where it belongs, and drops the rest
at column 1 of the row below. That row is usually one the frame diff considers
unchanged, so nothing paints over the spill and it outlives every later frame.
Text becomes a row by being cut to fit (Chrome, menus, cards) or wrapped to fit
(transcript); both flatten control characters first — the cut before it
measures, the wrap by breaking a row where a newline asked for one — and the
frame flattens again as it paints, for whatever composes a row next.
_Avoid_: line (a transcript line may occupy several rows)

**Fold**:
A transcript block kept in both a summary and a full form, swappable in place
— a click anywhere in the one under the pointer works it, Ctrl+O works them
all — and collapsed when the conversation moves on. Thinking and long tool
output are folds. A finished answer is transcript: it stays whole, a click
does not work it, and the pointer resting on it names nothing.
_Avoid_: collapse block, expandable section

**Rule**:
The mark drawn down a transcript block's left edge to say where the block
starts and ends — heavy for the person's own message, light for a tool block,
error-coloured for a failed one, absent for what a person reads. Chrome, not
content: it repeats on wrapped rows and never reaches the clipboard.
_Avoid_: border, gutter, sidebar

**Scrollback notice**:
The row that says how far back the reader has gone and takes the click that
ends it. Display-only, drawn over the Viewport's last row — under what is
being read, never over it, and never a chrome row, which would move the input
box while scrolling. A drag that starts on it is a drag, not a click.

**Update check**:
One cached read of the `codsh-cli` dist-tag, behind a two-second budget, that
can only ever add a dim line under the welcome naming the newer version. It is
never a chrome row (the chrome's height is what keeps the box still), never
blocks the boot, and never installs anything on its own. Asking is `/update`
inside a session or `codsh update` outside one; both run
`npm install -g codsh-cli@<latest>` in the open and then move the code
profile's runtime to match, so a profile that launches straight through dsh
never waits for a boot to catch up. The boot's registration remains the catch
for a runtime a bare `npm install -g codsh-cli` upgrade, or a failed move,
left behind. `CODSH_UPDATE_CHECK=off` silences the automatic check but neither
of those; `CODSH_UPDATE_REGISTRY` points every one of them at another
registry.

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
