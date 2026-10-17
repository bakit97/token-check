# Staged production recovery

The owner explicitly authorized restoring production first, then migrating in
separately deployed and checked steps. Do **not** deploy the entire feature
branch's collector: its strict GCS governor delays individual public files and
its 5,000-candidate safety cap is unsuitable for the existing 11,000+ candidate
snapshot. Those features have not been enabled in production.

The active recovery collector is reproducible with:

```sh
python3 deployment/build-recovery.py
```

This reads pinned Git history, writes only `work/recovery-build/`, applies the
committed patch and verifies SHA-256 against `recovery-manifest.json`. It makes
no network requests, changes no Git history and does not deploy anything.
The original 48cb0f8 collector and its proven adapters remain the base.
The patch adds bounded archive flushing and Helius-only budgeting, not a second
running service or a second UI. It is a temporary pinned recovery artifact until
the single-version migration is complete.

Actual steps performed, in order:

1. Downloaded the existing 13 code files as a local backup. Compared them with
   exact commit `48cb0f8621e3a822cc65e0a7c23ba485ad3a574e`; four differed.
2. Uploaded only those four files, modules before collector, using GCS generation
   preconditions and verified checksums. Collector generation
   `1792262070736784`. Reset the already-stuck VM once; kept machine/disk/configs.
3. Verified the real collector started and independent live exports resumed.
   Found a further recovery issue: `flushUploads()` drained an unbounded restored
   backlog before publishing source/status. Capped a flush at four items / ten
   seconds, retaining unsent items. Verified heartbeat generation
   `1792262532383746` after automatic restart. Three queue regression tests pass.
4. Real startup traffic was approximately 876 estimated credits/minute over
   its first three minutes (RPC archival calls correctly priced at ten, plus WS).
   Deployed Helius-only budget with unchanged legacy observation exports.
   Generation `1792262809733401`; fresh status confirmed. GCS pacing was excluded.
5. Live counters revealed a small WS-reservation overshoot and competition from
   metadata. Increased WS headroom, limited metadata's share, prioritized Pump
   proof calls, and gave hourly reconciliation a separate 50-credit share under
   the combined ceiling. Final generation and hashes are in the manifest.

The ledger starts conservatively at **185,000 estimated used credits**: owner's
174,302 checkpoint plus allowance for measured recovery traffic. This is not a
fresh Helius invoice reading. Existing ledger survives every code restart.
The old shared-socket pause was removed by the October 18 correction below. DBC/LaunchLab are never disconnected by budgeting; only the independent Pump pre socket can pause on its own stream quota. Deferrals remain
unknown observations, never fabricated successful proof or zero activity.
At twenty credits/minute, every launch cannot be proved. In-flight WS traffic
can still have a bounded metering lag; inspect actual counters after changes.

No old UI, `day/`, `obs/`, `raw/` or historical datasets have been deleted,
moved or disabled. No owner config, Helius metadata key, VM size/disk size or
`main` was changed. GCS Class A/B and Billing are not reconciled here; frequent
legacy exports still prevent a claim that the complete service is free-only.
Next is a complete observation contract and controlled cutover, not deletion
of the old feeds while their observations are still needed.

## Earlier recovery verification checkpoint

Final collector generation: `1792263193310124`.
At **2026-10-17 19:00:18 UTC / 2026-10-18 00:00:18 UTC+5**, status was three
seconds old, WS connected, RSS 311 decimal MB, no source initialization error.
Estimated shared rolling-window consumption was **16.5536 credits** against a
20-credit target. The short-window projected reset usage was 581,649 credits;
that is not a monthly guarantee or provider invoice reading.

The source's prelaunch counters showed 142 examined create events, 1 admission
and 141 budget deferrals in the observed interval. Budget compliance therefore
comes with incomplete sampling; do not describe this as full market coverage.
The exact-restoration build had initially shown roughly 876 estimated credits/
minute, explaining why unconstrained capture cannot simply remain enabled.

Memory peaked above 400 MB during earlier startup/export samples and then fell
below 400 MB. The 311 MB sample is observed behavior, not a hard RSS guarantee.
GCS write/read totals, Billing and 24-hour stability remain unverified. No
legacy observation feed is disabled, no old result is imported into new work,
and migration/deletion remains gated by the observation contract audit.

## October 18: restore migration coverage and pool observations

The owner reported that the earlier governor was over-restrictive. Applied and
verified incrementally (modules first, collector last, generation leases):

1. `1792264882753488`: independent migration/pre sockets; DBC and LaunchLab
   subscription acknowledgements both true while pre paused; 13.6384 estimated
   credits in the observed minute. Removed the 5,000-message migration kill switch.
2. `1792265164974018`: batched pool/vault reads, real balance success timestamps,
   retained raw state on second-batch deferral, fair observation rotation and
   per-source skipped/deferred counters. Live: 978/978 current pools, none due,
   15.80224 credits/minute. Linux CI passed for `bb880eb`.
3. `1792265389636327`: reserves account for credits already spent by each lane,
   preventing a pool/proof scheduling deadlock. Live: 970/970 current pools,
   17.6384 estimated credits/minute; 15 migration RPC credits and 1 pool RPC credit
   in that minute, both migration subscriptions acknowledged.
4. Final generation is in the manifest. Retain hourly reconciliation batches
   until processed, clear abandoned in-flight locks on load, and continue a
   partial proof before its five-minute cached responses expire.

The target is 18 combined estimated credits/minute, still reduced by remaining
monthly allowance. Migration proof and hourly reconciliation retain priority,
with four credits/minute reserved for due pool work. Pools reserve eleven
credits for pending proofs; unused reservations are borrowable once queues are
empty. Holder and pre RPC each have a 60-credit hourly cap. Pre stream has its
own 1.5-credit rolling-minute / 60-credit rolling-hour allowance. DBC/LaunchLab
stream metering never closes their connection. No PumpSwap stream was added.

Pool/vault observations: five-minute cadence before age two hours, then thirty
minutes through the 24-hour observation horizon. Up to 33 pools per batch (99
keys when vaults are known); unknown vaults are discovered in one extra batch,
not separate RPCs per coin. Validate token mints before committing balances.
`raw[minute].at/slot` describe the pool read; `vaultAt/vaultSlot` describe the
possibly later vault read. `lqAt` advances only after two actual vault balances.

`status.json` exposes:
- `ws.connected.dbc/ll`, `ws.preOn/preBudgetPauses/preGapCurrentMs`;
- `resources.helius.lanes` minute/hour costs and `sources` deferred RPC attempts;
- `budgetEvents.sources`: unique pending/expired migrations, retained hourly
  reconciliation work, missed budget-limited raw/holder observation windows;
- `budgetEvents.pre`: known discarded creates and pause duration. Unreceived
  events during a disconnected pre interval are unknown (`null`), never zero;
- `poolObservations`: eligible/current/overdue pools and historical raw misses.

Full live candidate detection is distinct from completing all archival proofs.
A retained proof backlog remains and is visible. The 5,000+ historical missed
raw windows cannot be reconstructed as contemporaneous observations. Current
coverage is a point-in-time measurement, not proof of uninterrupted 24-hour
coverage. Ledger accounting remains an estimate, not a Helius invoice.

Recovery regression suite: 27 passed, 1 intentional GCS-only skip on Windows.
Tests cover 6,001 migration messages with an exhausted pre quota, bounded batches,
missing vaults, partial read deferral, restart locks, and retained reconciliation.
No legacy UI, observations, owner settings or machine/disk sizes were removed.

### Legacy research CPU/RAM isolation

At 2026-10-17T19:36:08.794Z the preceding generation had 967/967 current pools,
no overdue balance snapshots, both migration subscriptions acknowledged and
15.6384 estimated credits/minute. Its RSS snapshot rose to 636 decimal MB around
the legacy research timer. The owner had already declared old research results
invalid; disable only that legacy scheduled computation, rather than reducing
migration subscriptions or observation coverage. Preserve legacy source code,
UI, old data and all observation exports pending the approved contract cutover.
New v2 processing remains active. Status exposes `legacyResearch.enabled=false`.
This does not establish a hard RSS bound for export/startup peaks.

Linux verification for `5a5358f`:
https://github.com/bakit97/token-check/actions/runs/39063098846 — 114/114 tests
passed, plus reproducible recovery hashes and 27 passed / 1 intentional skip.
