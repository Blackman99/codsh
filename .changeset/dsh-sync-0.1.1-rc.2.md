---
'codsh-bundle': patch
'codsh-cli': patch
---

Sync `@deepseek-ai/dsh-*` to 0.1.1-rc.2 so the published
`deepseek-v4-flash-vision-exp` route accepts pasted images as first-class
attachments. Resolve the current model's exact modalities at submission time
so a startup or stale catalog cannot misroute them; keep the file and optional
sidecar fallback for text-only models.
