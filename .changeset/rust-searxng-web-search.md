---
'codsh-cli': patch
'codsh-bundle': patch
---

Web search can use a keyless SearXNG JSON substitute (`protocol = "searxng"`) beside the existing Responses-shaped substitute. The request is `{base}/search?q=...&format=json`. Domain allow and deny apply to result URLs and cannot be widened by a model argument. Official hosts stay refused. A local fixture covers the protocol, and one real SearXNG process on localhost was the live verification target.
