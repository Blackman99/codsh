---
'codsh-bundle': patch
'codsh-cli': patch
---

feat(tui): atomic image token navigation and automatic image preview overlay

- Treat `[Image #N]` tokens as atomic units in the input editor: cursor navigation (Left/Right, Up/Down, Word, Home/End, mouse clicks) jumps over the token and never positions the cursor inside it.
- Support atomic forward deletion for image tokens (`delete` key before `[`).
- Style `[Image #N]` tokens in the input box with accent color (`theme.accent`).
- Automatically show a floating image preview overlay above the prompt box when the cursor is directly at the left or right edge of an image token, displaying image metadata, dimensions, file size, and half-block ANSI thumbnail.
