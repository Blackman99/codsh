---
'codsh-cli': minor
'codsh-bundle': minor
---

Add substitute login, logout, and managed-config setup to `codsh --rust`. Identity tokens stay isolated from model keys and other services; organization pins refuse API-key-only use until a matching session exists; unsigned or unverifiable organization policy is refused, and official grok.com entitlements are not reproduced.
