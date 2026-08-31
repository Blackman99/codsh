# codsh-cli

**`/ship`** takes one sentence to verified code. [codsh](https://github.com/Blackman99/codsh) is a
terminal coding agent composed on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

```sh
npm install -g @deepseek-ai/dsh codsh-cli   # already have dsh? npm i -g codsh-cli
codsh
```

Key: `DEEPSEEK_API_KEY`.

[![The /ship flow](https://raw.githubusercontent.com/Blackman99/codsh/main/assets/ship-demo.gif)](https://blackman99.github.io/codsh/)

`/ship <one-sentence idea>` grills the idea into a spec, cuts it into tracer-bullet tickets, lands
them with TDD, and re-runs every criterion before it says done. The [site](https://blackman99.github.io/codsh/)
shows the rest of the surface as real terminal captures.

## The launcher

This package bundles nothing. It finds the dsh you already have (`DSH_BIN`, a resolvable `@deepseek-ai/dsh`, or `dsh` on PATH), registers the [`codsh-bundle`](https://www.npmjs.com/package/codsh-bundle) runtime into a dsh `code` profile on first run, and boots `dsh --profile code`. No dsh yet? `npm install -g @deepseek-ai/dsh` first.

Set `DSH_BIN=/path/to/dsh` to pin a specific dsh; set `CODSH_BUNDLE_SPEC` to register a bundle other than the launcher's paired `codsh-bundle@^<version>` (development installs use a `file:` tarball here, which the launcher never overwrites).

Full documentation: [github.com/Blackman99/codsh](https://github.com/Blackman99/codsh)
