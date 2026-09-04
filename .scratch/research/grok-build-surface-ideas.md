# Grok Build Surface Ideas for codsh

Research date: 2026-08-30  
Official source revision: `bc7f02eddd3d84085849dc19ed216f11c23b0571`

## Recommendation

Build a conversation timeline and semantic turn navigation next. The Sticky
Turn Header work already gives codsh turn descriptors, physical-row mapping,
resize handling, and trim behavior, so this adds substantial navigation value
without changing the dsh session schema.

## Surface-only candidates

1. **Conversation timeline and turn jumps (M)** — one tick per user turn,
   current-turn highlight, hover preview, and reversible `/jump` preview.
   Sources: [timeline](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/timeline.rs#L1-L23),
   [window and jump calculation](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/timeline.rs#L65-L170),
   [jump view contract](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/jump.rs#L1-L8).
2. **Copy response/block/metadata and fullscreen block viewer (S-M)** — reuse
   codsh clipboard support, but retain raw block source and metadata alongside
   rendered rows. Sources: [block actions](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md#L55-L84),
   [`/copy`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/04-slash-commands.md#L54-L65).
3. **Adaptive scrolling (S-M)** — snap a submitted prompt to the viewport top,
   then add wheel/trackpad tuning and a scrollbar. Sources:
   [page flip and scroll settings](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md#L177-L201).
4. **OSC 8 links and file:line targets (M)** — visible-link hit maps with a
   plain-text fallback when terminal/tmux capabilities are insufficient.
   Sources: [link map](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/link_map.rs#L1-L67),
   [routing policy](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/hyperlink_route.rs#L9-L38).
5. **Draft stash/restore and external editor (S-M)** — start with text-only
   stash, then preserve image chips and add `$VISUAL` / `$EDITOR` editing.
   Sources: [stash semantics](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md#L217-L247),
   [`/edit-prompt`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/04-slash-commands.md#L147-L153).
6. **Terminal doctor and richer notifications (M)** — codsh already detects
   focus and emits BEL/title updates; add capability findings for Kitty keys,
   Shift+Enter, mouse reporting, OSC 52, tmux, and alternate screen before
   adding terminal-specific notification routes. Source:
   [terminal doctor](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/21-terminal-support.md).

## Requires upstream dsh support

- `/rewind` and `/fork`: need reliable session truncate/fork APIs.
- `/context`: needs token usage split into system/messages/reasoning/tools/MCP.
- Full active-turn follow-up queue steering: needs runtime injection semantics,
  not only a queue pane.

These should remain later work until the upstream API is verified.
