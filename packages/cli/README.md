# codsh-cli

The `codsh` command: a **zero-dependency launcher** for [codsh](https://github.com/Blackman99/codsh), a Claude Code-style coding agent for the terminal composed on the DeepSeek Harness (dsh).

This package bundles nothing. It finds the dsh you already have (`DSH_BIN`, a resolvable `@deepseek-ai/dsh`, or `dsh` on PATH), registers the [`codsh-bundle`](https://www.npmjs.com/package/codsh-bundle) runtime into a dsh `code` profile on first run, and boots `dsh --profile code`. No dsh yet? `npm install -g @deepseek-ai/dsh` first.

Full documentation: [github.com/Blackman99/codsh](https://github.com/Blackman99/codsh)
