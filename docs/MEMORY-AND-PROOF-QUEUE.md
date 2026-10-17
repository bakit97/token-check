# Memory and migration proof queue — 2026-10-18

## Measured cause

Diagnostic generation 1792266727476590 retained 12,058 candidates, 1,015,984 DS
rows, 127,984 vault observations and about 9 MB of raw base64. Both research
banks were empty. There were no candidates older than the existing 50-hour
retention horizon. Journals held 6,284 source records and no Passed records.

Saving a 77,235,360-character state snapshot raised RSS from 352.9 to 509.7 MB.
The older implementation also made a complete JSON string and UTF-8 buffer for
GCS uploads. These temporary whole-dataset copies were the demonstrated cause;
empty research banks were not the explanation in this sample.

## Implemented memory controls

- Replay state incrementally in 64 KiB reads, one coin at a time; reject malformed
  or incomplete snapshots without overwriting the last state.
- Save rows individually to a temporary file, fsync, then atomically rename.
- Stream JSON row collections through gzip into a bounded-buffer temporary file;
  stream that file to GCS. Do not retain whole JSON strings or UTF-8 copies.
- Send metadata and compressed data in one multipart request. The VM lacks the
  separate metadata PATCH permission (403); no IAM expansion is used. This also
  halves the old per-object Class A operations.
- Close HTTP/file streams, consume responses and remove completed/failed temps.
  Stale temps from previous processes are removed at next publication.
- Serialize heavy day exports; minute heartbeat is independent of them.
- Preserve all day/obs/raw observations and timestamps. The Node heap flag,
  machine type, disk and owner settings are unchanged.

The isolated regression processes an 81.78 MB snapshot with a 128 MB old-space
limit; observed RSS was about 104 MB. Run:
`node --max-old-space-size=128 tests/memory-stream-acceptance.cjs`.
That is not a claim that the full live service uses only 104 MB.

Early live streamed samples were 314–388 MB, peak 395.5 MB; row-wise saving a
later 77.96 MB state used 346.2 MB RSS. Final validation must inspect multiple
full export cycles, rather than a startup-only sample.

## Minute diagnostics in status.json

`memory` includes RSS, heap used/committed, native/external and ArrayBuffer MB,
heap limit, process and minute RSS peaks, event-loop lag, in-flight publications,
successful uploads/hour and phase measurements. Sizes (counts, not expensive
whole-structure serialization) are under `memory.structures`:

- `C`: records by age, DS/vault/candle/trade/raw rows and raw base64 characters;
- `wsSeen`, `rpcCache`, GT/raw/pre queues and pre signature deduplication;
- active and earlier research banks, processed/retry/lookup/attempt maps;
- source/recent/admission/Passed/audit in-memory journals and RPC history.

`mem` remains the legacy decimal-MB RSS field for existing clients. The status
publisher has a busy guard and runs every minute, independently of day exports.

## Queue and buying-window semantics

`migrationQueue` reports length, ready count, oldest enqueue time and age,
fresh-under-15-minute tasks, budget waiters, terminal expirations, open buying
windows, missed pending windows and rejected late proofs. Unfetched hourly
reconciliation batches remain separately visible.

Priority: open buying window; then other fresh tasks under 15 minutes; then older
pending work. Within a band continue partially paid proofs before cache expiry,
then rotate fairly. A task older than two hours becomes terminal unknown with
`не подтверждена (просрочено)`, never a fabricated dead/rug outcome.
A new on-chain migration signal for an old token starts a fresh task; token age
must not expire that genuinely new event. Replays remain deduplicated.

A late verified proof may remain an archived observation, but cannot create a
new main-source admission after the configured post-migration buying window.
This prevents retrospective entries; priority does not guarantee that a fixed
20-credit/minute service can verify arbitrarily many simultaneous migrations.
No old research result is imported. Consolidation remains gated by the full
observation mapping in OBSERVATION-MIGRATION.md.
