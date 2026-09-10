# Coming from Claude Code or Codex → codsh

You already have Claude Code / Codex muscle memory and are trying **codsh** for DeepSeek (or your own gateway) on open [dsh](https://github.com/deepseek-ai/deepseek-harness).

Redirecting Claude Code with `ANTHROPIC_BASE_URL` is a **compatibility trick**. codsh is a **different product** on an open harness — not a wrapper.

This page is a **map**, not a feature ballot. Corrections welcome on [issue #64](https://github.com/Blackman99/codsh/issues/64).

## Mental model

| | Claude Code / Codex | codsh |
|---|---|---|
| Runtime | Closed / vendor harness | Open dsh profile (`code`) + `codsh-bundle` |
| Default model story | Vendor models (or env redirects) | DeepSeek-first; any OpenAI-compatible route |
| One sentence → shipped | Prompt + your process | `/ship` — grill, two gates, TDD landing, dual-layer DoD |
| Install | Vendor installer | `npm i -g @deepseek-ai/dsh codsh-cli` (Node ≥22.19) |

## Command / habit mapping

Rough equivalents — names differ on purpose. Mark cells Maps / Partial / Missing as the community corrects them.

| You reach for… | In codsh try… | Maps? / notes |
|---|---|---|
| New session in a repo | `codsh` | Maps — boots `dsh --profile code` |
| Resume | `codsh --resume <id>` / `/resume` | Maps |
| Continue last | `codsh --continue` | Maps |
| One-shot / print mode | `codsh -p "…"` | Maps — off-TTY line reader |
| Compact | `/compact` | Maps — folds show summary meta |
| Switch model | `/model` | Maps — routes from `~/.dsh/settings.yaml` |
| Thinking / effort | `/thinking` or `/effort` | Maps — per-model persistence; MetaBar shows level |
| Plan mode | `⇧Tab` | Maps |
| Permissions / always-allow | Approval widget 3rd option → `.dsh/permissions*.json` | Maps with different files — prefix allow; compound cmds never match loose prefix |
| Clear | `/clear` | Maps |
| Rewind / fork | `/rewind` | Maps — original stays under `/resume`; Esc Esc recalls last prompt |
| Jump / browse turns | Shift+←/→, `/jump`, timeline rail | Maps (surface-specific) |
| Copy answer / code | `/copy`, `/copy N`, `/copy N:C` | Maps |
| Fullscreen read | `/view`, `/view N`, `/view N:C` | Maps |
| Diff reader | `/diff` / click long diff card | Maps |
| Shell in session | `!cmd` | Maps — agent sees output |
| Skills / slash extras | `$…` skills | Partial — inventory differs from CC plugins/skills |
| Attach files | `@…` | Maps |
| Queue while busy / interrupt-steer | Type → `↳ queued:` · Ctrl+Q · `s` / Ctrl+Enter | Maps with different keys |
| Update | `codsh update` / `/update` | Maps — also moves profile runtime |
| Status | `/status` | Maps |
| Vendor Remote Control / IDE deep links / subscription UX | — | **Missing / N/A** |
| Claude/Codex-only tool or model combo | — | **May still go back** — useful signal on #64 |

## `/ship` vs ad-hoc plan-in-chat

| | Ad-hoc plan in chat (CC / Codex habit) | `/ship` |
|---|---|---|
| Memory | Conversation (drifts) | Spec on disk |
| Approvals | Informal | Gate 1 spec, Gate 2 tickets |
| Landing | Hope | Red→green TDD, commit per ticket, dual-layer DoD |
| Resume | Scroll up | Bare `/ship` + cascading re-verify |

Gates may get in the way for tiny edits — use plain chat or plan mode; `/ship` is for “one sentence → verified landing.”

## What’s missing / different

Fill from real week-long use (comment on [#64](https://github.com/Blackman99/codsh/issues/64)):

- Vendor-only surfaces (Remote Control, subscription, IDE deep links, …)
- Permission feel: safer? naggier? prefix allow vs CC allow rules
- Long-session reading: sticky header / timeline / folds vs CC transcript
- `/ship` two gates: helped or blocked for *your* work shape
- Skills / plugins / MCP inventory gaps
- Windows: WSL first-tier vs native pwsh best-effort ([#62](https://github.com/Blackman99/codsh/issues/62))
- Anything you still open the other CLI for

## Feedback ask

If you already run Claude Code or Codex and tried **codsh for a week**, comment on [#64](https://github.com/Blackman99/codsh/issues/64) with:

1. Commands you reached for that are named differently
2. Permissions: what felt safer, what nagged
3. Long sessions: could you read them back
4. Whether `/ship`’s two gates helped or got in the way
5. Anything you still go back to the other CLI for

Not a feature ballot — a map so the next migrant isn’t guessing.

## Quick start

```sh
npm install -g @deepseek-ai/dsh codsh-cli
export DEEPSEEK_API_KEY=…
codsh
```

Site: https://blackman99.github.io/codsh/

See also: [Compared to…](./compare.md).
