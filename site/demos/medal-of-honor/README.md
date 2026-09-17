# Medal of Honor Web (unofficial tribute)

This directory is a static production build of a local demo project, checked
in so GitHub Pages can serve a playable snapshot with relative asset URLs.

## Original requirement

> 做一个 web 版的荣誉勋章游戏

The source project is a desktop-browser first-person shooter. It requires a
**keyboard and mouse** (pointer-lock look, WASD movement, click to fire). It
is not built for touch controls.

## Provenance

- Source snapshot commit: `4bbf68e77dfea4f3d8497f120067604aa671cf47`
- Source tree: local `../test-codsh` (no git remote)
- Bundler: the source project's installed Vite, invoked with `--base ./` into a temporary outDir
- This folder contains only that built snapshot, plus the Three.js license and this note

## Affiliation

This is an **unofficial fan tribute**. It is not associated with, endorsed by,
or affiliated with Electronic Arts, Danger Close, or the Medal of Honor
franchise.

## Three.js

The production bundle includes three.js 0.170.0 (MIT). The license text
is preserved in `LICENSE` next to this build.

## Update

From the codsh repository root (the importer does not edit the source project):

```
node scripts/site-demo.mjs ../test-codsh
```
