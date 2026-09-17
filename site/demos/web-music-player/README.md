# Web Music Player (Local-Style Web Application)

This directory is a static production snapshot of a local demo project,
checked in so GitHub Pages can serve an interactive desktop-grade audio
player with relative asset URLs.

## Original requirement

> 做一个 web 音乐播放器，但是要像本地应用一样

The source project is a client-side desktop-grade Progressive Web Application
(PWA) that replicates native local audio players (such as macOS Music or foobar2000).
It features direct local file system access, cross-session IndexedDB persistence,
a 10-band graphic equalizer, a real-time frequency spectrum visualizer, synchronized
LRC lyrics, OS MediaSession controls, and bundled sample tracks for immediate
first-run auditioning.

## Provenance

- Source snapshot commit: `f494f2b45f7baec049ac6742e06054aa28d7ff78`
- Source tree: local `../test-codsh` (no git remote)
- Bundler: the source project's installed Vite, invoked with `--base ./` into a temporary outDir
- This folder contains only that built snapshot, plus the Lucide license and this note

## Lucide

The production bundle includes lucide-react 0.475.0 (ISC). The license
text is preserved in `LICENSE` next to this build.

## Update

From the codsh repository root (the importer does not edit the source project):

```
node scripts/site-music.mjs ../test-codsh
```
