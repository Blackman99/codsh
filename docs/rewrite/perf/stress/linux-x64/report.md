# Stress bench (linux-x64)

| metric | reference p95 | ceiling | candidate p50 / p95 | verdict |
| --- | --- | --- | --- | --- |
| idle:input | 4 ms | 20 ms | 1 / 1 | pass |
| load:input | 5 ms | 21 ms | 2 / 2 | pass |
| load:scroll | 2 ms | 18 ms | 1 / 1 | pass |
| long:input | 4 ms | 21 ms | 1 / 1 | pass |
| long:turn | 26 ms | 42 ms | 40 / 42 | pass |
| quit:under-load | 113 ms | 135 ms | 358 / 404 | fail |
| rss:client-long-growth | 980 KiB | 33748 KiB | 348 / 356 | pass |
| rss:load-growth | 25112 KiB | 57880 KiB | 9488 / 10340 | pass |
| rss:long-growth | 980 KiB | 33748 KiB | 8224 / 8952 | pass |
| workflow:input | 4 ms | 21 ms | 2 / 3 | pass |
| workflow:pause | 210 ms | 252 ms | 172 / 185 | pass |
| workflow:resume | 60 ms | 77 ms | 178 / 195 | fail |

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
| rss:tree-peak | 154140 | 290872 |
| rss:client-peak | 146444 | 22108 |
| processes:peak | 4 | 5 |
| long:turn-first5 | 25.205189999891445 | 44.46291200001724 |
