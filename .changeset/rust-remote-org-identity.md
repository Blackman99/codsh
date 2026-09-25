---
'codsh-cli': patch
'codsh-bundle': patch
---

A remote host can require an organization identity for `codsh --rust --remote ssh://…`: `[remote_access] identity = "required"` in its `requirements.toml` makes the leader proxy admit only an access token that your own OpenID Connect provider (RFC 7662 introspection) reports active for the configured issuer, audience, and teams, checked again on every request and on a timer, with `deny_subjects`, `locked`, and fail-closed policy errors. The client sends its `codsh --rust login` session only to remotes listed in `[[remote_identity]]` with that audience, refreshes it before expiry, and both sides audit a token fingerprint, never the token. Without a policy a remote works as before.
