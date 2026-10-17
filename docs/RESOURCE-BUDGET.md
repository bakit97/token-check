# Resource controls (development only)

This describes the full feature design, not every feature active in production.
The owner later authorized a staged production recovery; see
[the recovery record](../deployment/README.md). That build enables Helius-only
budgeting and preserves legacy exports. Strict GCS pacing and the 5,000-candidate
cap are **not** enabled there. VM/disk types, owner configs and the metadata key
remain unchanged. Its conservative estimated checkpoint is 185,000 credits.

## Helius

`resource-budget.json` in the collector data directory is a small, atomic,
fsynced accounting ledger. RPC attempts are reserved **before** sending, including
network failures and each HTTP 429 retry. Archival methods (including
`getTransaction` and `getSignaturesForAddress`) and `getProgramAccounts` cost 10;
other methods used here cost 1. WS is estimated at 20 credits per decimal MB of
received UTF-8 payload. Small stream blocks are reserved ahead of processing;
an in-flight server message can overshoot the local minute threshold before
the socket closes. This is an estimate, not Helius invoice reconciliation.

The default initial checkpoint is the owner's **174,302 used credits**.
`HELIUS_RESET_AT` defaults to **2026-11-14T00:00:00Z**, conservatively interpreting
the October 17 report of 28 days left. The exact reset timestamp and current
usage MUST be reconciled with the dashboard before deployment. On first start,
`HELIUS_USED_CREDITS` and `HELIUS_RESET_AT` can supply an updated checkpoint.
Existing ledger values survive restarts and take precedence over environment
defaults. No renewal is invented: spending stops at the saved reset time.
For a new period, stop the collector and update the existing ledger with the
new dashboard checkpoint (preserving other fields), then restart. Do not delete
the ledger: that would forget reservations and GCS operations.

`HELIUS_CREDITS_PER_MINUTE` can lower, never raise, the 20-credit ceiling.
The combined operational target is 18 credits/minute, capped by the remaining
monthly allowance. Second-resolution rolling accounting expires a charge after
60 seconds; it no longer counts both a current and a previous whole-minute bin.
Migration proofs/reconciliation and due pool batches have reserved capacity that
accounts for each lane's already-spent credits. Holders and pre use spare capacity
with independent hourly caps. Pool/vault cadence is 5 minutes during the first
2 hours, then 30 minutes through the observation horizon.

DBC/LaunchLab run on a dedicated socket with no budget disconnection. Pump pre
uses a separate socket and only its own stream quota pauses it. RPC shortage is
reported and leaves migration candidates/reconciliation batches pending. The
status separates deferred RPC attempts, pending unique events, known pre losses
and unknown events during pre disconnection. See the recovery record for exact
lane caps, actual deployed generations and live coverage measurements.

At this budget, proving every new Pump launch is **not possible**: one
transaction proof alone costs 10 credits. Budget deferrals and capacity drops
are reported separately; missing observations do not become successful proof,
zero trades, dead labels or weak labels. No retroactive admission is added.

## GCS and freshness tradeoff

The free Class A allowance is **5,000/month**, shared with other work in eligible
US regions. A single object every minute is **43,200 writes in 30 days**.
Thus fresh multi-file publication every 30–60 seconds and strict free-only
operation cannot both be promised with this architecture.

The collector reserves at most **4,000 Class A attempts/calendar month** and
paces them across the remaining UTC month, leaving 1,000 for other clients.
`GCS_CLASS_A_USED` is an optional first-start checkpoint of collector operations
already consumed this month. Default 0 is **not a verified Billing balance**;
other services, previous versions, storage size, network egress and Class B
reads are outside this local governor. The total GCP bill cannot be guaranteed
zero without checking Billing and those other resources.

Changed exports are compressed asynchronously into a bounded disk spool
(128 MiB, 1,000 objects). New versions replace queued versions of the same name;
unchanged content (ignoring `updated` fields) does not consume another write.
Items rotate by waiting time; the heartbeat gets every fifth slot. Failures
consume a reservation and retain the pending item. Successful writes combine
JSON metadata and gzip bytes in one multipart request; no second metadata
PATCH is sent. Raw observations are only trimmed after their archive is
durably queued. Queue overflow retains local data and reports an error.

This strict mode can delay individual public files by **hours**; it is not
30-second LIVE. Embedded `updated` times remain observation/queue times, not
invented freshness. The current UI should continue treating old files as stale.
An architectural change (for example one compact shared snapshot, plus a
different read endpoint for rapid updates) is required before promising a
fresh UI on the free write budget. The existing deployment freshness verifier
requires updates within 180 seconds, and must not be used as proof of success
in this mode. It has not been weakened to accept stale data.

## VM protections and diagnostics

No machine/disk size or Node heap limit was increased. `status.json.resources`
includes RSS/heap MiB, last/max event-loop lag, estimated Helius forecast,
GCS attempted/successful writes per hour, remaining spool size and actual
per-object publication times. `mem` remains for compatibility.

At 360 MiB RSS or excessive loop lag, new candidates and background work pause.
Candidates are capped at 5,000, websocket dedup at 20,000, prelaunch dedup at
10,000, and GeckoTerminal pending tasks at 160 (96 background), with expiry.
Source lifetime index is capped at 100,000 records and journal replay at
64 MiB: it refuses additional admissions/replay at capacity rather than deleting
historical deduplication. This is a safety stop, **not** indefinite archival
scalability; a bounded disk index/streamed replay remains required for long-term
unattended operation. Replay and JSON allocation spikes have not been load
tested on the actual e2-micro, so <400 MiB RSS is a target, not a measured guarantee.

Auto discovery and filter audit run no more than hourly, sequentially in worker
threads with 48 MiB old-generation limits, a 120-second timeout, and a parent
RSS threshold of 280 MiB. Failed jobs also wait an hour. Legacy research yields
between days/features. Existing incremental classification is already bounded;
it remains separate from hourly rule discovery so classification deadlines
are not unnecessarily delayed.

## Validation and rollout

Offline tests cover accounting, forecasts, minute boundaries, restart,
expiry, bounded durable queue, network failure/replacement races, collector
RPC integration and one-request multipart uploads. A Linux-only GitHub Actions
job runs all existing tests without secrets or deployment. Windows cannot fsync
directories used by some existing Linux durability tests; those failures must
be distinguished from algorithmic regressions.

Before owner-approved rollout: reconcile Helius reset/usage and GCP Billing;
resolve the public-freshness architecture; test live create_v2 discovery,
real-state startup, RSS/lag and actual provider counters. Preserve ledger/spool
on restart and rollback. Reverting code alone must not erase durable source,
Passed, research histories or owner settings.

Sources checked 2026-10-17:
- https://www.helius.dev/pricing
- https://www.helius.dev/blog/laserstream-websockets
- https://docs.cloud.google.com/free/docs/free-cloud-features
