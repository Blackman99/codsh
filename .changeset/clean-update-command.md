---
'codsh-bundle': patch
---

fix(update): silence package installation output and show updating loading hint on /update

Previously, running `/update` streamed the raw package installation output (`npm install` and `dsh profile register`) to the transcript. The command now runs the installation silently under a clean `updating` spinner loading indicator, reporting only the final success or failure message.
