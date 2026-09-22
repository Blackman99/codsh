---
'codsh-cli': minor
'codsh-bundle': minor
---

Add explicit `codsh --rust import` for selected legacy dsh providers and preferences. Preview lists conversions, conflicts, and unsupported items from current `settings.yaml` sources without copying tokens, credential files, or trust grants. The imported model follows `agent-default-model` when that model is listed. Inline keys are not copied, a missing `apiKeyEnv` is not invented, and existing nested settings are kept. UI density maps to isolated compact mode; apply writes only into the isolated Home.
