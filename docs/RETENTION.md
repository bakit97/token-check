# Completed observation retention

The collector keeps verified coins for 26 hours. Other candidates expire after
two hours; a genuinely new migration signal starts a fresh proof window.
Unfinished research retains its original cohort through its observation deadline
(five hours by default, plus the classifier's existing small completion grace).
Pending raw uploads and active requests are not discarded.

Retirement is a transaction:

1. Recover missing historical records incrementally from the canonical
   `observations-v2/YYYY-MM-DD.json` files, preserving receipt times, pool
   identity and archive references. The initial legacy comparison is complete.
   Normal recovery never requires old day/obs writers or old research labels.
2. Append each completed coin to a local journal and fsync. Its checksum fixes
   the snapshot being published, even if another callback updates the hot coin.
3. Stream combined archived and hot rows to the full `observations-v2/`
   contract and its small phone summary. A hot row supersedes an older snapshot;
   old coins remain in subsequent exports even after leaving memory.
4. Confirm only the exact archived snapshots actually included in both
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
The old writers are disabled after successful observation-contract comparison.
Closed archived records are not restored merely because Source still lists them.
Recovery of an already duplicated, completed pre cohort requires an exact
confirmed archive that covers every actual hot observation; new observations,
new proof and active research always prevent this deduplication.

Tests cover failed uploads, failed state commits, partial journal replay,
updates during upload, pool/raw provenance and 35 successive daily cohorts.
History grows in daily archives rather than in the hot state file.
