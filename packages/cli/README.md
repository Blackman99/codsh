# codsh-cli

**codsh** is a terminal coding agent for DeepSeek — and any OpenAI-compatible endpoint — built directly on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

Its flagship command, **`/ship`**, turns a one-sentence idea into verified code through an autonomous 7-stage engineering pipeline with a real-time task flow panorama across terminal and browser.

```sh
npm install -g @deepseek-ai/dsh codsh-cli
export DEEPSEEK_API_KEY="your-api-key"
codsh
```

[![The /ship flow](https://raw.githubusercontent.com/Blackman99/codsh/main/assets/ship-demo.gif)](https://blackman99.github.io/codsh/)

## `/ship`

`/ship <one-sentence idea>` automatically drives the complete engineering workflow:
wayfinder → grill → spec → tickets → landing → done.

- **Live Task Flow Panorama**: Real-time TTY teaser row, fullscreen ASCII DAG overlay (`Ctrl+G`), and local interactive Web flowchart (`127.0.0.1:<port>`).
- **Autonomous Conflict Resolution**: Parallel git worktrees with automated merge conflict handling and validation.

## The launcher

`codsh-cli` is a zero-dependency launcher that locates your installed `dsh`, registers the [`codsh-bundle`](https://www.npmjs.com/package/codsh-bundle) runtime into a `code` profile, and boots `dsh --profile code`.

- `DSH_BIN=/path/to/dsh`: Pin a specific `dsh` executable.
- `CODSH_BUNDLE_SPEC`: Point to an alternate bundle package or local tarball.

Full documentation: [github.com/Blackman99/codsh](https://github.com/Blackman99/codsh)
