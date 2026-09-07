---
'codsh-bundle': patch
---

fix(transcript): format ask_user_question result as user reply instead of raw json

When `ask_user_question` completed, the transcript rendered the tool's raw `{ answers: [...] }` JSON payload into the terminal card. Tool results for `ask_user_question` are now formatted directly as the user's reply (selected options or custom text), cleanly omitting the body when dismissed or aborted without displaying raw JSON.
