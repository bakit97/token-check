# Completed observation retention

The collector keeps verified coins for 26 hours. Other candidates expire after
two hours; a genuinely new migration signal starts a fresh proof window.
Unfinished research retains its original cohort through its observation deadline
(five hours by default, plus the classifier's existing small completion grace).
Pending raw uploads and active requests are not discarded.

Retirement is a transaction:

1. Seed any historical records missing from the candidate map from the existing
   `day/` and `obs/` files. Replay them incrementally, retaining original receipt
   times. Recover available raw/trade archives after checking their identities.
   Keep historical observations, never old research labels or rules.
2. Append each completed coin to a local journal and fsync. Its checksum fixes
   the snapshot being published, even if another callback updates the hot coin.
3. Stream combined archived and hot rows to `day/`, `obs/` and
   `observations-v2/`. A hot row supersedes an older snapshot of that same coin;
   old coins remain in subsequent exports even after leaving memory.
4. Confirm only the exact archived snapshots actually included in all three
   successful uploads. Persist these confirmations before removing matching,
   still-eligible coins from the candidate map.
5. Atomically save the reduced `state.json`. A failed save retains the journal.
   Remove a local day's journal only after all its snapshots are confirmed,
   no hot coins remain, and the last possible birth that day is 26 hours old.
   The published day is preserved; sealed-day markers are bounded.

Raw upload payloads are also saved before their full data leaves a hot coin.
Restart restores lightweight queue entries; sending loads one payload at a
time and removes it only after acknowledgement. Publication failures never
authorize eviction to satisfy a size target.

`status.retention` exposes the state-file byte count, 30 MB target, over-target
flag, eviction and research/queued-work counts. Its archive summary reports
unconfirmed snapshots, actual local journal bytes and historical seed gaps.
The old writers remain enabled while observation-contract comparisons continue.

Tests cover failed uploads, failed state commits, partial journal replay,
updates during upload, pool/raw provenance and 35 successive daily cohorts.
History grows in daily archives rather than in the hot state file.
