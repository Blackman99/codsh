# Compared to Claude Code, Aider, OpenCode, Reasonix

**Pitch:** `/ship` = verifiable delivery. DeepSeek-native on [dsh](https://github.com/deepseek-ai/deepseek-harness). Not a Claude Code wrapper.

**Tone:** factual. Cells describe what ships today. Sources: public READMEs / sites as of 2026-09. Update when products move.

## Snapshot

| | **codsh** | **Claude Code + DeepSeek env** | **Aider** | **OpenCode** | **Reasonix** |
|---|---|---|---|---|
| **Harness** | Open [dsh](https://github.com/deepseek-ai/deepseek-harness) `code` profile + `codsh-bundle` (does not fork dsh) | Anthropic Claude Code / agent SDK (closed). DeepSeek via `ANTHROPIC_BASE_URL` (or similar) redirect | Own Python agent loop (git-native pair programmer) | Own open agent runtime ([anomalyco/opencode](https://github.com/anomalyco/opencode)) | Own Go engine ([esengine/DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix)); config/plugin-driven |
| **`/ship`-like workflow** | **Yes** — first-class `/ship`: preflight + branch isolation → grill → Gate 1 spec → Gate 2 tickets → TDD landing → dual-layer DoD; bare `/ship` resumes with cascading re-verify | **No** — prompt + your process; plan mode / skills help, but no dual-gate spec→tickets→DoD pipeline | **Partial** — chat edits + git commits; `/test`, `/lint`, architect/editor patterns; no gated grill→spec→tickets→DoD | **Partial** — build/plan agents, permissions, multi-step runs; not a dual-gate verifiable-delivery workflow like `/ship` | **Partial** — plan mode, long autonomous runs, checkpoints/sandbox; cache-first loop; not grill→two gates→TDD DoD |
| **TUI** | Yes — alternate-screen coding surface (sticky turns, timeline, folds, queue/steer, `/view` `/diff`, …) | Yes — Claude Code terminal UI | Terminal chat / REPL (pair-in-shell); not the same alternate-screen coding TUI class | Yes — full OpenCode TUI (+ desktop) | Yes — CLI/TUI (+ desktop / browser / ACP) on one local engine |
| **DeepSeek-native** | **Yes** — DeepSeek-first defaults on dsh; any OpenAI-compatible route via `$DSH_HOME/settings.yaml` + `/model` | **No** — vendor agent pointed at DeepSeek (compatibility trick). Defaults and tooling stay Anthropic-shaped | **Supported** — first-class DeepSeek models (`DEEPSEEK_API_KEY`); multi-provider by design, not DeepSeek-only | **Supported** — provider/model config (incl. DeepSeek); multi-provider open agent, not DeepSeek-first product | **Yes** — marketed DeepSeek-native; DeepSeek presets; OpenAI-compatible endpoints as config |
| **Install friction** | Medium — Node `≥22.19`; `npm i -g @deepseek-ai/dsh codsh-cli`; `DEEPSEEK_API_KEY`. Already on matching dsh → `npm i -g codsh-cli` only. Older harness refused at boot | Medium–high for DeepSeek path — vendor install **plus** base-URL / key / compat env workarounds; behavior depends on redirect quality | Low–medium — `pip` / `aider-install` / brew; API key + model flag | Low — brew / npm / choco / mise / nix, etc.; then auth/provider setup | Low — `npm i -g reasonix` (prebuilt binary) or Homebrew; `reasonix setup` |
| **License** | MIT (`codsh-cli` / `codsh-bundle`) | Proprietary (Anthropic). Env redirect does not change that | Apache-2.0 | MIT | MIT |

## How to read the table

1. **Harness column is the real fork in the road.** Redirecting Claude Code at DeepSeek keeps you on Anthropic’s loop. codsh and Reasonix are DeepSeek-oriented open products; Aider and OpenCode are open multi-provider agents with different defaults and surfaces.
2. **`/ship`-like means verifiable delivery with durable artifacts and gates** — not “the agent wrote some code.” codsh is the only row with that pipeline as a named product feature. Others may get you there with discipline; they do not ship the same contract.
3. **DeepSeek-native ≠ “can call DeepSeek.”** Native = defaults, docs, and day-1 path assume DeepSeek (or dsh). Supported = works when configured.
4. **TUI** here means an interactive terminal coding surface. Aider is excellent at git-native pairing; it is a different interaction shape.

## One-line differentiators (external posts)

| Product | Fair one-liner |
|---|---|
| **codsh** | `/ship` on open dsh — one sentence → gated, verified landing; DeepSeek-native TUI |
| **Claude Code + DeepSeek env** | Familiar Claude Code UX; DeepSeek via redirect, not a native DeepSeek product |
| **Aider** | Git-native pair programmer; multi-LLM; commits as the control surface |
| **OpenCode** | Popular open multi-provider coding agent with a strong TUI |
| **Reasonix** | DeepSeek-native Go agent optimized for long, cache-stable autonomous runs |

## Caveats (keep honest)

- Feature sets move fast; re-check before citing a missing capability as permanent.
- Reasonix’s strength is long-session cost/cache and “leave it running,” not competing on `/ship` gates — say that, don’t invent a gap fight.
- Other **dsh TUI plugins** (community skins) share the harness with codsh but typically do not ship `/ship`; they are siblings, not this table’s primary columns.
- Stars / download spikes are not proof of fit — don’t use them in comparison copy.

## Sources (starting points)

- codsh: https://github.com/Blackman99/codsh · https://blackman99.github.io/codsh/
- dsh: https://github.com/deepseek-ai/deepseek-harness
- Aider: https://github.com/Aider-AI/aider · https://aider.chat/docs/llms/deepseek.html
- OpenCode: https://github.com/anomalyco/opencode · https://opencode.ai
- Reasonix: https://github.com/esengine/DeepSeek-Reasonix · https://reasonix.io/
