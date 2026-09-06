---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(screen): ensure uniform hover fill without resting background text cutouts

- Strip resting background escape sequences when rendering hover fill (`fill`), ensuring uniform, clean highlight across the entire hovered block without dark text cutouts.
- Order rendering so full-width padding applies before hover fill overlays.
