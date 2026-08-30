---
"codsh-bundle": minor
---

DeepSeek Flash and Pro now read pasted images automatically: codsh asks `deepseek-v4-flash-vision-exp` for a one-shot description, then gives that text to the still-selected conversation model and tells it to answer directly from the visual context without a no-image disclaimer. Explicit `CODSH_VISION_*` sidecars keep priority, and vision failures still fall back to the saved image file.
