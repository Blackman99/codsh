---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(tui): accurately calculate thinking duration from step start to handle buffered reasoning deltas

When model providers or proxies buffer reasoning tokens and deliver them in a single burst or delta late in a step, measuring elapsed thinking time only between chunk arrivals resulted in inaccurate durations (such as 0.1s). Deliberation timing now anchors to step start and concludes when reasoning finishes or subsequent text/tool calls begin.
