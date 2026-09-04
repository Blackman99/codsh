# codsh-bundle

The [codsh](https://github.com/Blackman99/codsh) runtime: the interactive TTY surface and the `code-cli` agent preset, packaged as a dsh bundle. It is installed **into dsh profiles**, not globally — either by the [`codsh-cli`](https://www.npmjs.com/package/codsh-cli) launcher on first run, or directly:

```sh
dsh plugin --profile code add codsh-bundle
dsh --profile code
```

Full documentation: [github.com/Blackman99/codsh](https://github.com/Blackman99/codsh)
