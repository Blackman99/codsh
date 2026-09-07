---
'codsh-bundle': minor
'codsh-cli': minor
---

feat(tui): preview a pasted image with the terminal's own graphics protocol, and stop the card corrupting the surface

The preview card came up as an empty box in Ghostty and took the rest of the frame with it. Two causes, both fixed:

- **The wrong protocol was being sent.** Ghostty, kitty, and WezTerm implement Kitty graphics and ignore `OSC 1337 ; File=`; iTerm2 is the other way round. Sending the wrong one fails silently — the payload is swallowed and the card is blank. The protocol is now read off the terminal: Kitty graphics (`APC _G`, chunked, `C=1` so a placement cannot scroll the layout, `q=2` so the terminal's reply never arrives as keystrokes) for the first three, `OSC 1337` for iTerm2. A multiplexer forwards neither, so inside tmux or screen no graphic is attempted at all.
- **The payload was being cut into a row.** Base64 image bytes inside a card row measure as tens of thousands of display columns, so the row fitting cut the escape mid-sequence and dropped its terminator; the terminal then ate every following sequence as string data, which is what smeared the frame across the prompt. The card now reserves blank cells and the frame paints the picture over them at an absolute position — a graphic travels beside the rows, never inside one.

Also in this change:

- **No native image decoder is loaded in the TTY process.** Pixel dimensions come from a pure-JS header parser (PNG, JPEG, WebP, GIF), and the half-block mosaic used by terminals without a graphics protocol is resampled in a short-lived child process. Loading sharp here pulls libvips in, and with a second copy reachable — a checkout and an installed profile each resolving their own, the normal development shape — the macOS Objective-C runtime prints a `GNotificationCenterDelegate` duplicate-class warning straight to file descriptor 2. There is no JavaScript hook on that write: it lands on the terminal, over a frame the surface believes it owns.
- **The card fits the viewport.** It is sized against the rows the chrome leaves rather than the terminal's own height. Measured against the terminal, its caption and bottom border fell off the bottom while the picture kept the space.
- **Centered, near-fullscreen, and uncropped** — the whole picture in frame rather than a centre cut of it.
- **Ctrl+O, or a click on the card, opens the original** in the platform viewer (Preview.app, `xdg-open`, `start`). When the card closes, a Kitty placement is deleted by id: it is not cell content, so clearing the rows it covered would leave the picture on screen.
