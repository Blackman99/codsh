---
'codsh-cli': minor
'codsh-bundle': minor
---

Add substitute login, logout, and managed-config setup to `codsh --rust`. Identity tokens stay isolated from model keys and other services; organization pins refuse API-key-only use until a matching session exists; unsigned or unverifiable organization policy is refused, and official grok.com entitlements are not reproduced. Startup and inspect refresh an expired session or clear it without blocking login or an otherwise valid API key. Slash login keeps the live dsh client when a settings write fails, and replaces it when the settings patch changes. A usable identity session is passed to the executing dsh child, while other parent `GROK_AUTH_*` variables are not. Logout revokes the session at the identity provider before clearing it, and keeps the local session when revocation fails. A signature for another principal, or fail-closed policy with no pubkey and no sidecar, is refused.
