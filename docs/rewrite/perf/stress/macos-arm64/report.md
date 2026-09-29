# Stress bench (darwin-arm64)

| metric | reference p95 | ceiling | candidate p50 / p95 | verdict |
| --- | --- | --- | --- | --- |
| idle:input | 5 ms | 21 ms | 1 / 2 | pass |
| load:input | 9 ms | 25 ms | 2 / 3 | pass |
| load:scroll | 3 ms | 20 ms | 1 / 1 | pass |
| long:input | 13 ms | 29 ms | 1 / 3 | pass |
| long:turn | 42 ms | 59 ms | 45 / 58 | pass |
| quit:under-load | 208 ms | 249 ms | 459 / 517 | fail |
| rss:client-long-growth | 1152 KiB | 33920 KiB | 352 / 400 | pass |
| rss:load-growth | 25360 KiB | 58128 KiB | 9712 / 10752 | pass |
| rss:long-growth | 1152 KiB | 33920 KiB | 6432 / 8096 | pass |
| workflow:input | 7 ms | 24 ms | 2 / 3 | pass |
| workflow:pause | 562 ms | 675 ms | 379 / 384 | pass |
| workflow:resume | 321 ms | 385 ms | 206 / 330 | pass |

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
| rss:tree-peak | 136784 | 311296 |
| rss:client-peak | 125184 | 16688 |
| processes:peak | 7 | 7 |
| long:turn-first5 | 41.5034169999999 | 51.332875000080094 |
