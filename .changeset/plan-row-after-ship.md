---
'codsh-bundle': patch
---

fix(ship): take the plan's ticket rows out of the chrome once the spec has shipped

After `/ship` finished, the plan readout stayed pinned under the input box saying `plan N/N · every ticket landed` for the rest of the session. The plan is pinned only while the spec's `Status:` is not `shipped`; the moment the final status is written the rows come down, the way the done chip already clears itself. The next `/ship` pins its own plan again.
