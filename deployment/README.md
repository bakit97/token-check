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
WS intentionally pauses when the shared budget is unavailable. Deferrals remain
unknown observations, never fabricated successful proof or zero activity.
At twenty credits/minute, every launch cannot be proved. In-flight WS traffic
can still have a bounded metering lag; inspect actual counters after changes.

No old UI, `day/`, `obs/`, `raw/` or historical datasets have been deleted,
moved or disabled. No owner config, Helius metadata key, VM size/disk size or
`main` was changed. GCS Class A/B and Billing are not reconciled here; frequent
legacy exports still prevent a claim that the complete service is free-only.
Next is a complete observation contract and controlled cutover, not deletion
of the old feeds while their observations are still needed.

## Live verification checkpoint

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
