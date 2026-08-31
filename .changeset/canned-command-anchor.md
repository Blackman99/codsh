---
"codsh-bundle": patch
---

`/ship`, `/init`, and custom commands now take the top of the viewport the way a typed message does, so the reply fills the space beneath instead of scrolling the command off. Commands that only work the chrome are unchanged: they answer nothing, and clearing the screen for a reply that never comes would only lose what was on it.
