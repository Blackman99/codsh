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
it away, shrinking from at most three rows to one. Pinned, it is a panel: one
padding row of its fill above the prompt and one below, then the divider that
hands the screen back to the transcript. A prompt longer than three visual rows is a Fold by
default. Clicking the pinned copy expands that floating panel in place;
the inline prompt and the reading position stay where they were. Ctrl+O
on the original still expands the transcript fold, which then does not pin.
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
its boxes are the only place the work is counted. The chrome re-reads that
file as tickets tick, and pins it as its own row (`plan k/n · current ticket`).
The working line names a Workflow round
while one is in flight; it reports `done/total` and the first unticked ticket
only when no round is running, so the two rows never stack the same figure.
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
The bottom-pinned rows: input box, menus, the Queue and Todo readouts, hint
row, status row. Never scrolls.

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

**Child view**:
The nested Viewport of an in-process child's transcript. A Fold that names a
child Session is a view: a click enters, Esc pops one level, and the child's
thinking, text, and tool cards stream the way they do on the parent. The view
is read-only; typing flashes that Esc returns. Fork views skip the inherited
parent prefix. Worker-thread Workflow children are not views — their sessions
are never in this process, so the round line never offers `click to enter`.
_Avoid_: catalog, inspector, pager

**Card run**:
Tool cards that follow one another share one panel rather than each opening and
closing one of its own. The first pads above, the last pads below, and inside
the run a card with body rows keeps the pad above it as its divider while a
bare one-liner takes that row over — so a batch of reads costs one row each
rather than three. Any other block printed under a run ends it.
_Avoid_: card group, merged cards

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

**Image preview card**:
The card centered over the transcript while the cursor rests against an
`[Image #N]` token — it says what is attached, and shows it. A terminal with an
inline-graphics protocol is handed the image itself: Kitty graphics for
Ghostty, kitty, and WezTerm, `OSC 1337` for iTerm2. Sending the protocol a
terminal does not implement fails silently, and a multiplexer forwards neither,
so both are read off the environment rather than assumed; whatever is left gets
a half-block mosaic, resampled in a child process so no native decoder is
loaded here. The payload never travels as row text — a base64 image measures as
thousands of columns and is cut mid-sequence by the width every row is fitted
to, which leaves the terminal eating the rest of the frame as string data — so
the rows reserve blank cells and the frame paints the picture over them at an
absolute position. Transcript around the card is dimmed so the picture is what
reads; the card itself stays undimmed. Ctrl+O and a click on the card open the original in the
platform viewer. Card and picture come down together: a Kitty placement is not
cell content, so clearing its rows would leave it on screen.
_Avoid_: thumbnail, attachment chip

**Todo readout**:
The chrome row that holds the agent's todo list — progress plus the item in
flight — for as long as a list is live, and the `/ship` plan when one is on
disk. A click anywhere in the readout, or Ctrl+T, opens the full list and
closes it again, the way a Fold works. Read from the `todos` projection and
the spec file, never remembered from the write.
_Avoid_: todo panel, task bar, progress bar

**Queue**:
The lines submitted while nothing was asking for one — a turn running, a
question open — held by the Prompt in the order they were typed, each a
Prompt, a `!` line, or a `/` command with the images its tokens claimed.
Adjacent Prompts leave as ONE message, a blank line between them; a `!` or
`/` line is a boundary that keeps its place and leaves alone, so shell output
lands between the thoughts it separated. Shown as the `↳ queued:` chrome row
(count, each line's first line, `Ctrl+Q`). Surface state, never the dsh inbox:
the inbox holds only Steers. An interrupt leaves it alone, and it goes as the
next message; Escape is always the interrupt.
_Avoid_: inbox, backlog, type-ahead buffer

**Queue panel**:
The Queue opened in its row's place — Ctrl+Q, or a click on the readout — as
a numbered list with the keyboard: Enter edits the marked line back into the
box (its images with it; refused while the box holds text), `d` deletes,
Shift+↑/↓ reorders, `s` Steers a Prompt while a turn runs, digits pick a row,
Escape or Ctrl+Q closes. One open panel at a time with the Todo readout. It
closes itself after an edit or a Steer and when the Queue empties; the box
receives no keys while it is open, and the pointer marks and clicks its rows.
_Avoid_: selector (which replaces the box and settles once), menu

**Steer**:
A Prompt handed to the RUNNING turn instead of the Queue — Ctrl+Enter from
the box on a kitty-protocol terminal, `s` in the Queue panel anywhere — via
the agent's `steer`, which delivers it at the next step boundary. Shown as the
`↳ steering:` chrome row until the agent claims it, when it renders as a
Prompt block like any other. A turn that ends without taking it, an interrupt,
or a session switch reclaims it to the head of the Queue, so nothing typed is
lost. A `!` or `/` line cannot Steer; it joins the Queue.
_Avoid_: inject (dsh's model-facing context), interrupt, follow-up

### Workflows

**Ship gates**:
The two approvals in the `/ship` workflow — the confirmed spec file (gate 1)
and the approved ticket breakdown (gate 2). Everything after gate 2 is
autonomous. Grill-me runs first as the grill-me skill (recon, design tree,
frontier rounds with recommended answers, exhaustion handshake); to-spec and
to-tickets then run as those skills (exhaustive stories, vertical tickets
with a DAG and per-ticket acceptance, `.scratch/` plus tracker when
configured) without another interview. Landing follows the tdd skill: one
red test witnessed failing, then minimal green, then the suite. Each `/ship`
turn injects only the phase the spec's `Status:` names — grill, to-spec,
to-tickets, and TDD do not share context. The MetaBar chip follows that
Status (`ship · grill` / `spec` / `tickets` / `land k/n`). The spec file is the workflow's memory,
not the conversation: the approved tickets live in it as checkboxes, its
`Status:` line names the phase, a baseline run is recorded before any code,
each green ticket is committed, and a bare `/ship` offers to resume
whatever it finds unfinished.
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
