# Observation contract audit before removing legacy exports

This inventory is based on actual code, not an assertion of complete source
coverage. Each absent sample remains absent. No old research outcome, label,
auto-discovered rule or evaluation statistic is imported into the new research.
`day/`, `obs/` and `raw/` must remain available until replacements are verified.

Full schema-2 contracts are the canonical observation format; legacy snapshots were compared before cutover.
Each coin lives at `observations-v2/YYYY-MM-DD.json -> coins[]`; the current
and previous pools are separate entries in `observations.pools[]`.

| Required observation | New persisted location under each pool | Receipt time / limits |
| --- | --- | --- |
| DS snapshots | `ds[].at`, `ds[].values` | Unix ms converted losslessly from legacy Unix seconds; no invented missing polls |
| Vault balances | `vaults.samples[].at`, `.slot`, `.balances` | Actual receipt, not inferred from slot |
| Vault identity / decimals | `vaults.addresses`, `.mints`, `.decimals`, `.identityAt` | Unknown historical identity time stays null |
| First ten minute candles | `candles10`, `tradeCoverage`, `tradeFetches`, `tradeRows` | Candles retain receipt `.at` and provenance; market times stay distinct |
| Holders at minute ten | `holders10`, also `holders["10"]` | Receipt `.at` and missed-window markers retained |
| Raw pool / vault accounts | `rawStates[minute]` including `.at`, `.slot`, `.b`, vault receipt/slot | Full retained base64; previous pools remain separate |
| Already archived raw/trade files | `archives.rawStates`, `.trades` | Legacy references explicitly `legacy-reference-not-reconciled` |

Live comparison of October 18 exports checked 1,331 DS rows and 53 vault rows
from the legacy obs file against the newer mirror through their common receipt
cutoff: no differences and no missing admitted coins (11 legacy obs coins;
809 total candidates in mirror). This proves that sample, not all history.
Fixtures additionally verify holders, raw bytes, candles, prior pools and
cutoff filtering. Existing historical gaps remain gaps.

`source/day/*` and `source/live.json` retain admission identity. The mirror
includes its admission record, but old research results are excluded. Server research and Passed read the full contract; the phone reads its lightweight projections.
Legacy `day/`, `obs/` and root `live.json` writers are retired after the verified cutover. Legacy day serialization truncates
DS/vault series to twenty minutes, so it cannot substitute for full obs files.

Additional points that must survive migration:

- Actual DS requests for admitted pools use the pairs endpoint, not a token's
  arbitrarily selected pool. Meteora zero USD liquidity is unknown, not a rug.
- Trade-derived candles require coverage evidence; the GT OHLCV fallback is a
  separate provenance and must not be relabeled `trades`.
- The raw trade archive has receipt evidence in `f`; individual `x` timestamps
  are market trade times. They are not interchangeable.
- Full base64 raw states are absent from `day/` (`raw` there is only at/slot/miss).
- Pool changes preserve observation provenance. Audit `takeObs()` carefully:
  raw/trade data now moves through OBS_KEYS before temporary fields are deleted,
  with a collector integration regression covering original receipt evidence.
- The new contract needs actual historical vault maxima / quote identity for
  the <5% drain rule. Do not transfer the old dollar-liquidity rug heuristic or
  fabricated post-rug prices.
- Enforce `at <= decisionAt` for early features. Market candle time does not
  imply that a later-downloaded candle was available at the original decision.

Cutover gate: demonstrate the replacement locations for **each** row above,
compare recorded observations and timestamps, test restart and pool migration,
deploy that step, then check fresh status and the combined Helius budget.
Only afterwards switch UI readers / disable old writers / archive legacy data.
Archival must copy, verify object checksums/counts, then remove original paths;
keep research results excluded from all new calculations.


## October 18 archive and reader transition

Read-only reconciliation checked 4,443 distinct referenced archives across 12,902
contract coins. 4,301 available files passed mint, pool, market-time and recorded
receipt/observation identity checks: 27,371 raw samples (25,705,036 decoded bytes),
333,352 trade rows and 1,938 fetch receipts. There were no identity or observation
conflicts among the available files. Another 142 references were already missing
(77 raw-state and 65 trade archives); neither the mirror nor the old exports
contain their missing bytes/trade rows. These remain explicit historical gaps.
They must never be reconstructed using a later receipt time or counted as data.

`server/observation-archives.js` provides an immutable, identity-checked archive
reader. `hydrateArchives` preserves actual fetch `at`; `toLegacy(row, cutoff)`
still excludes later receipts, including a trade tape downloaded after a decision.
The offline CLI `deployment/audit-observation-archives.cjs` inventories and checks
local copies without RPC or publication. A successful available-file comparison
is not a certificate of complete historical coverage.

Full histories remain at `observations-v2/YYYY-MM-DD.json`. The new phone
projection is `observations-v2/summary/day/YYYY-MM-DD.json` and
`observations-v2/summary/live.json`: admitted coins, last two DS/vault/activity
samples per pool, metadata and original receipt times. Its explicit
`latest-observations-only` scope must not be used to train or relabel research.
Server research and Passed read the canonical full observation contract one coin
at a time, including cold lookup; old research labels are not transferred.

The fresh pre-cutover comparison matched all 27,076 DS rows, 501 vault rows,
282 raw receipt records, 45 holder records and 53 candle records across 2,261
current-day coins, with no missing compared observations. Deployment checks
remain mandatory for each subsequent step. Archive movement must preserve verified copies and
resolve old raw references at their archived location before original deletion.


The single collector no longer contains the classic research calculation or the
old day/obs/live serializers. Canonical recovery reads `observations-v2` directly,
preserves complete migration proof state and previous pools, and never imports
old research labels. Completed-coin retirement waits for acknowledged full
contract and phone-summary uploads; pending raw archives remain on disk until
acknowledged. Admitted Pump pre coins retain 26 hours like admitted migrations;
unadmitted candidates retain two hours, with active research protection.

New raw archives use
`observations-v2/raw/YYYY-MM-DD/MINT/POOL-MARKET_AT-state.json` (or `-trades.json`).
The full pool identity prevents overwriting an earlier pool of the same mint.
`archiveRefs` travel with previous-pool observations. Old logical `raw/` references
can resolve under `archive/legacy/raw/` after verified archival copying.
`archiveCandidates` provides that compatibility without changing receipt times.

The live release source is `server/` alone. The build verifies a frozen hash
manifest of exactly the collector's module inventory; it no longer reconstructs
a different collector from an old commit and patches. Only changed module files
are published, with the collector last and object-generation leases. An identical
release does not cause another restart.
