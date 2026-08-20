---
'codsh-bundle': patch
'codsh-cli': patch
---

Plan mode no longer kills the session. `/plan` and Shift-Tab crashed the app
outright — `Cannot read properties of undefined (reading 'length')` from inside
the harness's plan-mode plugin — for anyone whose profile resolved the newer
plugin against an older runtime, which a fresh install did by default.

The cause was a version split, not a bug in either half: every
`@deepseek-ai/dsh-*` range was a caret on a prerelease, which admits the next
`rc`, so a lockfile-free profile install picked up `0.1.0-rc.8` plugins while
the launcher found an `rc.7` runtime — and rc.8's command registry passes an
image-attachment batch that rc.7 never did. Every dsh range is now on rc.8, so
the pair matches, and the surface passes the empty batch a plain slash command
carries.
