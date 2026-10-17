# Observation contract audit before removing legacy exports

This inventory is based on actual code, not an assertion of complete source
coverage. Each absent sample remains absent. No old research outcome, label,
auto-discovered rule or evaluation statistic is imported into the new research.
`day/`, `obs/` and `raw/` must remain available until replacements are verified.

| Required observation | Current persisted path / fields | Time meaning | Present in new source files? |
| --- | --- | --- | --- |
| DS snapshots every minute for 2h, then every 5m through 24h | `obs/YYYY-MM-DD.json`, `coins[].ds` | `[0]` is receipt Unix seconds; multiply by 1000 | No |
| Vault balances | `obs/YYYY-MM-DD.json`, `coins[].lq` | `[0]` receipt Unix seconds, `[1]` slot, `[2:4]` balances | No |
| Vault identity and decimals | `day/YYYY-MM-DD.json`, `vmint`, `vdec`; addresses `vaults` in VM `state.json` and `raw/*-state.json` | Identity at actual check; do not guess missing addresses | No |
| First-ten-minute candles from covered trades | `day/YYYY-MM-DD.json`, `k10` with `src: trades`; underlying `raw/YYYY-MM-DD/<mint>-trades.json` (`f`, `x`) | `k10.at` is receipt/computation time; candle `[0]` is market interval time | No |
| Holders at minute ten | `day/YYYY-MM-DD.json`, `hold["10"]` | `.at` is actual receipt; missed window is `.miss`, not zero | No |
| Raw pool and vault accounts | Live VM `c.raw[minute]`; `raw/YYYY-MM-DD/<mint>-state.json` after archival | `.at`, `.slot`, `.b` (base64 account data) | No |

`source/day/*` and `source/live.json` currently contain admission identity,
proof and event times. `research-v2/*` contains results and frozen feature rows;
neither replaces the observation table above. `day/` alone also does not replace
`obs/`: day serialization truncates DS and vault series to the first 20 minutes.

Additional points that must survive migration:

- Actual DS requests for admitted pools use the pairs endpoint, not a token's
  arbitrarily selected pool. Meteora zero USD liquidity is unknown, not a rug.
- Trade-derived candles require coverage evidence; the GT OHLCV fallback is a
  separate provenance and must not be relabeled `trades`.
- The raw trade archive has receipt evidence in `f`; individual `x` timestamps
  are market trade times. They are not interchangeable.
- Full base64 raw states are absent from `day/` (`raw` there is only at/slot/miss).
- Pool changes preserve observation provenance. Audit `takeObs()` carefully:
  raw data currently sits in its temporary-deletion list, which can lose an
  unarchived pre-migration pool snapshot. Preserve it before removing old logic.
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
