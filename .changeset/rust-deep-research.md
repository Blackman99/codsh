---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust`: `/deep-research <query>` runs the built-in deep-research workflow, the reference script pinned byte for byte from grok-build. It plans questions, researches them in parallel with web search, has separate verifier agents open each cited source, and writes a cited report. Only verified claims are reported; failed branches, missing web services, rate limits, contradicted sources and failed citation checks mark the result partial (`Result status: partial`), and a stop, the agent budget or a missing query end the run as cancelled, budget-limited or blocked. The built-in takes precedence over project, personal and plugin workflows of the same name and cannot be saved over. It uses the configured web search substitute; it was tested only with the mock model and fake local web services.
