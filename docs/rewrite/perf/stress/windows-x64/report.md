# Stress bench (win32-x64)

| metric | reference p95 | ceiling | candidate p50 / p95 | verdict |
| --- | --- | --- | --- | --- |
| idle:input | 103 ms | 123 ms | 98 / 103 | pass |
| load:input | 137 ms | 164 ms | 117 / 118 | pass |
| load:scroll | 103 ms | 124 ms | 3 / 3 | pass |
| long:input | 121 ms | 146 ms | 108 / 120 | pass |
| long:turn | 104 ms | 125 ms | 207 / 213 | fail |
| quit:under-load | 182 ms | 219 ms | 560 / 610 | fail |
| rss:client-long-growth | 2168 KiB | 34936 KiB | 812 / 964 | pass |
| rss:load-growth | 97636 KiB | 130404 KiB | 3216 / 3584 | pass |
| rss:long-growth | 2168 KiB | 34936 KiB | 5936 / 6568 | pass |
| workflow:input | 139 ms | 167 ms | 116 / 120 | pass |
| workflow:pause | 248 ms | 298 ms | 15188 / 15253 | fail |
| workflow:resume | 568 ms | 681 ms | - | fail |

| requirement | candidate | reference (reported) |
| --- | --- | --- |
| quit:no-leftover-process | pass | True |
| quit:no-model-traffic-after-exit | pass | True |
| crash:no-orphan-process | pass | True |
| crash:no-model-traffic-after-crash | pass | True |
| resume:does-not-claim-killed-work-runs | pass | True |
| measured | pass | True |

| reported | reference median | candidate median |
| --- | --- | --- |
| rss:tree-peak | 163880 | 211876 |
| rss:client-peak | 80212 | 16692 |
| processes:peak | 4 | 3 |
| long:turn-first5 | 103.61290000006557 | 108.16660000011325 |
