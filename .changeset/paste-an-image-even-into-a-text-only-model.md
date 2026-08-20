---
"codsh-bundle": minor
"codsh-cli": minor
---

Ctrl+V pastes an image, even into a model that only reads text. The surface
reads your system clipboard itself — an image has no way in through the
terminal — and attaches it behind an `[Image #N]` token in the box; one
backspace removes the token whole, and deleting it drops the image.

What happens at submit depends on the route. A model whose catalog declares
image input (set `inputModalities: [text, image]` for your model in
`$DSH_HOME/settings.yaml`) receives the image as a first-class attachment
block through dsh's durable store, downscaled only as far as the store's
admission limits demand; `/plan` and `/goal` accept images there too. The
default DeepSeek routes are text-only, so there the image is saved to a
content-addressed file under `$DSH_HOME/attachments/pasted/` and the model is
told its path and dimensions — the agent can still open, commit, or transform
it with its tools. And when `CODSH_VISION_BASE_URL` + `CODSH_VISION_MODEL`
(plus optional `CODSH_VISION_API_KEY`) name any OpenAI-compatible multimodal
endpoint, that sidecar describes the image — everything in it transcribed
verbatim — and the description rides the same message, standing in for sight.
A sidecar failure never loses the turn: it flashes, and the text still goes.

The transcript shows the token and a dim meta line saying what became of each
image (`[image #1 · 2880×1800 png · described]`) rather than pages of
machine-facing context, on resume as well as live. `CODSH_CLIPBOARD_IMAGE_CMD`
overrides the platform clipboard reader, which is how the tests drive the
whole path without touching a real clipboard.
