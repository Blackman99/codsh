# codsh-cli

**codsh** is a terminal coding agent for DeepSeek — and any OpenAI-compatible endpoint — built directly on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

Its flagship command, **`/ship`**, turns a one-sentence idea into verified code through an autonomous 7-stage engineering pipeline with a real-time task flow panorama across terminal and browser.

```sh
npm install -g @deepseek-ai/dsh codsh-cli
export DEEPSEEK_API_KEY="your-api-key"
codsh
```

## `/ship`

`/ship <one-sentence idea>` automatically drives the complete engineering workflow:
wayfinder → grill → spec → tickets → landing → done.

- **Live Task Flow Panorama**: Real-time TTY teaser row, fullscreen ASCII DAG overlay (`Ctrl+G`), and local interactive Web flowchart (`127.0.0.1:<port>`).
- **Autonomous Conflict Resolution**: Parallel git worktrees with automated merge conflict handling and validation.

## The launcher

`codsh-cli` is a zero-dependency launcher that locates your installed `dsh`, registers the [`codsh-bundle`](https://www.npmjs.com/package/codsh-bundle) runtime into a `code` profile, and boots `dsh --profile code`.

- `DSH_BIN=/path/to/dsh`: Pin a specific `dsh` executable.
- `CODSH_BUNDLE_SPEC`: Point to an alternate bundle package or local tarball.

## Local Rust candidates

`codsh --rust` selects the isolated offline Rust welcome/input preview. Plain
`codsh` is unchanged. The candidate uses `~/.codsh-rust/dsh`, Profile `rust`,
never imports old credentials or sessions, and starts no agent or network
service. Enter explicitly refuses execution until the dsh adapter is available.
`Ctrl+Q`/`Ctrl+D` quits; `Ctrl+C` clears a draft or quits when empty.

Maintainers run `pnpm run build:rust` before locally packing this package. The
candidate carries its native binary, dependency/license records, and digest;
users of that package need no Rust compiler. Missing/platform-mismatched or
corrupted artifacts fail, without downloading or falling back. No official
account or executable is required. This is not a published replacement release.

Full documentation: [github.com/Blackman99/codsh](https://github.com/Blackman99/codsh)
