---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(transcript): add vertical padding (vpad) and breathing room around functional blocks

- Add vertical padding rows (`vpad`) at the top and bottom of functional blocks (user prompts, tool cards, execution results, thinking deliberation, and code blocks) so text is not pressed directly against block edges.
- Ensure tool call invocations and completed results are cleanly separated with proper margins.
