# Frozen Grok reference for the parallel Rust/dsh rewrite

Accepted for #132/#133 on 2026-09-20 under the owner's implementation authorization.

## Scope

The parallel rewrite uses Grok CLI **1.0.34 (3736acbc8658)** as its frozen
behavioral reference. Within that new path only, this decision supersedes
ADR-0001's Claude-first arbitration and CONTEXT's fullscreen-only Viewport
rule. The legacy Launcher, Bundle, keybindings, native-buffer prohibition,
acceptance records and tests remain unchanged.

The new path supports both the reference's fullscreen alternate-screen lifecycle
and its minimal native-scrollback mode. In-place switches preserve the session,
draft, queue and permission state according to measured reference behavior.
Prompt editing reuses the official textarea; host-level history, completion,
multiline, prompt Vim, and external-editor round-trips must not invent a second
input state model.
Legacy choices cannot silently override those contracts.

## Source and execution ownership

Public source commit `a28ee2b2063426e8816e380ccea528b9de95e5da` is a separately
pinned research/future-import input, declaring 1.0.35 and monorepo revision
`e8563f8f182296ebb53cadb3e1eab7615d76408e`. It is **not** a proven source match
for the installed 1.0.34 binary. #133 imports no Rust implementation and starts
no replacement application. #134 owns the licensed, isolated client import.

Released dsh remains the only executing agent core and durable session owner.
A reusable Rust UI does not authorize a second agent loop, tool authority,
canonical store, or dsh fork. The new version requires both a separate dsh Home
and Profile; old data is copied only through explicit migration.

## Evidence and completeness

`docs/rewrite/reference/inventory.json` maps each discovered public surface to
stories, implementation tickets, planned external acceptance scenarios and
source/reference evidence. `discovery.json` preserves the itemized declarations
and documentation, including conflicting versions. The register is an audit
input, not an implementation-completion claim.

Every newly discovered behavior must be added, assigned and tested. A missing
published owner requires a scoped local ticket proposal and remains a release
blocker until the owner authorizes publication; it must not be hidden under
#211's final audit or excluded because it was absent from an earlier list.
Source-only behavior remains pending verification against the frozen binary.
No finite parser proves that undocumented behavior does not exist.

The permitted deliberate differences remain codsh identity, configurable service
substitutes, nonessential telemetry/content upload off by default, explicit
feedback submission, isolated/reversible migration and optional Ship. These are
not permission to omit service flows or weaken security. Missing enforcement,
platform evidence or service availability remains an explicit downstream blocker.
