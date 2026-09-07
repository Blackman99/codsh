---
'codsh-bundle': patch
'codsh-cli': patch
---

docs: show the surface as it is now — captures, banner, and the gaps in between

The pages described a surface two months of UI work had moved on from, and the
pictures were worse than the prose: the site's terminals were captured before
the panel work landed, and could not have shown it anyway.

- **The site's captures can show a panel.** The terminal model behind them
  tracked foreground colour and attributes only, so every background the
  surface paints — the person's own message, a tool run, thinking — was dropped
  on the way out, and the frame generator then read the `2` inside a direct
  colour as *dim text*. A blank cell carrying a fill is ink, not padding, so it
  also survives the trailing-blank trim now. Re-shot: the plum message panel,
  the tool card on its own fill, the collapsed `✻ thought for` row, and the
  timeline rail are all on the page.
- **The README banner is the current surface**, read off a real capture rather
  than memory — which is how the rules got their colours back: cyan for the
  person, amber for a tool card, magenta for thinking. It had been showing a
  thin left rule where the plum panel goes, a status row of fields that moved
  into `/status` two releases ago, and a placeholder missing half its menus.
- **`/ui compact|comfortable` is documented**, in both languages. It persists
  across sessions and was written down nowhere.
- **Inline graphics join the progressive-protocol paragraph**: chosen by what
  each terminal implements, not by what it is.
- **The development loop matches itself.** `CONTRIBUTING.md` sent readers to
  the README for the `MOCK` modes and `INSPECT=1`, and the README documented
  neither; the mode list in `scripts/dev.mjs` was four modes short of the
  fixture it describes; `pnpm run site:screens` sets `CAPTURE_SCREENS=1` on its
  own and no longer asks to be given it.
