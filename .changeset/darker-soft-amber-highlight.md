---
'codsh-bundle': patch
'codsh-cli': patch
---

feat(theme): darken soft amber highlight for lower visual glare and improved contrast

- Adjust amber highlights (`warn`, `tool`, `pending`) from bright `#ffaf00` (ANSI 214) to a deeper, warm amber `#d78700` (ANSI 172) in dark mode to reduce eye strain and glare.
- Darken light mode amber highlight from `#d78700` (ANSI 172) to `#af5f00` (ANSI 130) to preserve text contrast against light backgrounds.
