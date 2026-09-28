| metric | frozen limit | candidate p50 / p95 | reference control p95 | verdict |
|---|---|---|---|---|
| fullscreen:start:first-output | <= 69.3 ms | 89.4 / 140.9 | 72.9 | fail |
| fullscreen:start:ready | <= 928.3 ms | 91.8 / 145.5 | 744.6 | pass |
| fullscreen:cold:first-output | <= 1728.6 ms | 483.7 / 904.2 | - | pass |
| fullscreen:cold:ready | <= 2649.2 ms | 487.2 / 911.2 | - | pass |
| fullscreen:input:draft | <= 24.0 ms | 1.1 / 2.2 | 7.4 | pass |
| fullscreen:input:paste | <= 46.9 ms | 21.0 / 33.1 | 32.6 | pass |
| fullscreen:output:first-visible | <= 105.1 ms | 185.8 / 246.3 | 57.1 | fail |
| fullscreen:output:end-after-model | <= 166.4 ms | 72.4 / 102.1 | 129.0 | pass |
| fullscreen:scroll:page-up | <= 18.8 ms | 4.8 / 10.5 | 2.9 | pass |
| fullscreen:scroll:page-down | <= 18.0 ms | 8.2 / 17.2 | 2.9 | pass |
| fullscreen:resize:narrow | <= 37.6 ms | 0.5 / 2.7 | 36.6 | pass |
| fullscreen:resize:wide | <= 39.1 ms | 0.3 / 1.9 | 24.1 | pass |
| fullscreen:quit:exit | <= 263.8 ms | 35.2 / 73.7 | 151.3 | pass |
| fullscreen:output:throughput | >= 662839 bytes/s | 935204.6 / 1268089.2 | 763387.4 | pass |
| fullscreen:rss:tree-peak | <= 132076.8 KiB | 312552.0 / 319328.0 | 102464.0 | fail |
| minimal:start:first-output | <= 85.2 ms | 95.1 / 134.4 | 109.0 | fail |
| minimal:start:ready | <= 949.8 ms | 97.1 / 143.4 | 839.2 | pass |
| minimal:cold:first-output | <= 1712.6 ms | 671.2 / 1021.5 | - | pass |
| minimal:cold:ready | <= 2637.6 ms | 676.8 / 1025.6 | - | pass |
| minimal:input:draft | <= 23.0 ms | 0.9 / 2.1 | 6.5 | pass |
| minimal:input:paste | <= 47.6 ms | 22.4 / 35.5 | 30.4 | pass |
| minimal:output:first-visible | <= 79.7 ms | 206.4 / 347.2 | 102.5 | fail |
| minimal:output:end-after-model | <= 152.4 ms | 90.1 / 405.7 | 172.3 | fail |
| minimal:scroll:page-up | n/a (0/30 reference runs) | - | - | not-applicable |
| minimal:scroll:page-down | n/a (0/30 reference runs) | - | - | not-applicable |
| minimal:resize:narrow | <= 70.0 ms | 0.8 / 2.5 | 58.7 | pass |
| minimal:resize:wide | n/a (25/30 reference runs) | - | - | not-applicable |
| minimal:quit:exit | <= 185.0 ms | 36.6 / 67.1 | 165.4 | pass |
| minimal:output:throughput | >= 705603 bytes/s | 738555.8 / 1076625.9 | 627066.6 | pass |
| minimal:rss:tree-peak | <= 127276.8 KiB | 310696.0 / 317040.0 | 97584.0 | fail |
