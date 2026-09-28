| metric | frozen limit | candidate p50 / p95 | reference control p95 | verdict |
|---|---|---|---|---|
| fullscreen:start:first-output | <= 77.4 ms | 133.2 / 157.8 | 57.3 | fail |
| fullscreen:start:ready | <= 985.6 ms | 137.5 / 163.0 | 785.0 | pass |
| fullscreen:cold:first-output | <= 1465.0 ms | 877.5 / 972.0 | - | pass |
| fullscreen:cold:ready | <= 2759.9 ms | 880.6 / 975.5 | - | pass |
| fullscreen:input:draft | <= 24.3 ms | 2.8 / 6.4 | 8.8 | pass |
| fullscreen:input:paste | <= 42.8 ms | 54.1 / 66.8 | 29.8 | fail |
| fullscreen:output:first-visible | <= 91.5 ms | 375.5 / 485.8 | 65.2 | fail |
| fullscreen:output:end-after-model | <= 181.5 ms | 240.3 / 315.2 | 133.1 | fail |
| fullscreen:scroll:page-up | <= 19.4 ms | 7.0 / 8.9 | 2.7 | pass |
| fullscreen:scroll:page-down | <= 18.9 ms | 8.1 / 17.6 | 2.2 | pass |
| fullscreen:resize:narrow | <= 46.0 ms | 0.6 / 6.1 | 29.7 | pass |
| fullscreen:resize:wide | <= 41.3 ms | 0.4 / 3.5 | 26.7 | pass |
| fullscreen:quit:exit | <= 171.5 ms | 679.2 / 1931.3 | 156.9 | fail |
| fullscreen:output:throughput | >= 600173 bytes/s | 290761.2 / 974699.5 | 719154.7 | fail |
| fullscreen:rss:tree-peak | <= 132307.2 KiB | 336608.0 / 343088.0 | 102304.0 | fail |
| minimal:start:first-output | <= 84.2 ms | 110.8 / 166.5 | 216.9 | fail |
| minimal:start:ready | <= 1015.8 ms | 113.0 / 168.4 | 723.8 | pass |
| minimal:cold:first-output | <= 1951.1 ms | 475.1 / 1052.8 | - | pass |
| minimal:cold:ready | <= 2846.4 ms | 489.2 / 1055.0 | - | pass |
| minimal:input:draft | <= 23.0 ms | 1.8 / 3.1 | 6.4 | pass |
| minimal:input:paste | <= 39.1 ms | 49.5 / 68.5 | 27.5 | fail |
| minimal:output:first-visible | <= 83.0 ms | 298.7 / 400.7 | 60.3 | fail |
| minimal:output:end-after-model | <= 185.4 ms | 195.2 / 533.1 | 150.6 | fail |
| minimal:scroll:page-up | n/a (0/30 reference runs) | - | - | not-applicable |
| minimal:scroll:page-down | n/a (0/30 reference runs) | - | - | not-applicable |
| minimal:resize:narrow | <= 76.1 ms | 0.7 / 9.5 | 56.7 | pass |
| minimal:resize:wide | n/a (20/30 reference runs) | - | - | not-applicable |
| minimal:quit:exit | <= 201.9 ms | 621.5 / 1652.3 | 152.5 | fail |
| minimal:output:throughput | >= 630984 bytes/s | 358836.9 / 476794.0 | 789729.5 | fail |
| minimal:rss:tree-peak | <= 127488.0 KiB | 335720.0 / 341520.0 | 97328.0 | fail |
