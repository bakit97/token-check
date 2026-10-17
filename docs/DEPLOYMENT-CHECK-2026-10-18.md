# Live deployment check — 2026-10-18 (UTC+5)

Code commit: `3f6412ba993d7f448dc8b8a9745c16fc60364df5`.
Collector generation: `1792265832057819`. Observation timestamp: `2026-10-17T19:42:49.312000+00:00`.

- DBC and LaunchLab subscription acknowledgements: both true.
- Combined estimated credits in the rolling minute: 16.6384; target 18.
- Pool/vault balances recorded: 954/954 eligible coins.
- Current balance snapshots: 932; due: 22, oldest overdue 7 seconds.
- Pool cadence: 5 minutes in first 2 hours, then 30 minutes through 24 hours.
- Per-source budget event counters, retained proof/reconciliation backlog and pre gaps are published in status.
- A proof backlog remains. Live event detection is not a claim that all migration proofs have completed.
- Historical missing raw windows remain missing, without fabricated observations.
- Legacy scheduled research disabled; new v2 and day/obs/raw observation exports retained.

**Open issue:** a 620 MB RSS peak recurred after disabling legacy research.
That change alone did not resolve memory pressure; a hard 400 MB RSS ceiling
is not established. Earlier 327/354 MB samples must not be presented as a hard bound.
No VM/disk increase or observation shutdown was used to conceal this issue.

Linux CI: https://github.com/bakit97/token-check/actions/runs/39063357406
114/114 tests pass; exact recovery reconstruction passes; recovery suite
27 pass / 1 intentional multipart-GCS skip. Matching source and hashes are
recorded in deployment/recovery-manifest.json. Main remains unchanged.
