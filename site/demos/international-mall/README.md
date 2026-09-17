# International Mall

This directory is a static production snapshot of a local Next.js demo,
checked in so GitHub Pages can serve a shoppable storefront with relative
asset URLs. Checkout and order lookup persist in this browser (localStorage)
instead of the source project's `data/store.json`.

## Original requirement

> 做一个国际商城

The source project is a bilingual, multi-currency B2C shop. Product photos
load from Unsplash; simulated card / PayPal / Apple Pay checkout does not
charge a real account.

## Provenance

- Source snapshot commit: `0392b46d5fbaf4925b2b060a019c5ff7e2d12eb3`
- Source tree: local `../test-codsh` (no git remote)
- Bundler: the source project's installed Vite, invoked with `--base ./` into a temporary outDir
- This folder contains only that built snapshot, plus the Lucide license and this note

## Lucide

The production bundle includes lucide-react 0.468.0 (ISC). The license
text is preserved in `LICENSE` next to this build.

## Update

From the codsh repository root (the importer does not edit the source project):

```
node scripts/site-mall.mjs ../test-codsh
```
