# Resource controls — deployed canonical collector

## Helius accounting

`resource-budget.json` is an atomic local ledger retained through restarts. RPC attempts are charged before network access, including failed attempts and retries. Standard RPC methods used here (`getTransaction`, `getSignaturesForAddress`, `getBlock`, `getSlot`, account batches) are estimated at 1 credit; `getProgramAccounts` at 10. The current WS estimator charges exactly the UTF-8 bytes received at 20 credits per decimal MB, without block rounding. Historical estimates are retained.

This is a local estimate, not reconciliation with provider billing. `status.json.resources.helius.wsMetering.billingVerified` remains false until dashboard totals can be compared. Minute samples and hourly windows expose the cumulative local estimate, WS bytes and separate estimated RPC/WS charges. Dashboard screenshots need only total credits and their times; no credentials are needed.

The combined operating target is at most 18 credits/minute, reduced further if the remaining monthly allowance requires it. Existing ledger usage and reset time take precedence over first-start defaults. A reset is never inferred automatically. The saved usage/reset still require dashboard confirmation.

Fresh migration proofs have priority, followed by due pool/vault batches, holders and metadata. Migration and pool reservations subtract already-spent lane credits. Pool balances are batched every five minutes during the first two hours, then every thirty minutes. Deferred attempts and discovery/confirmation reasons remain visible.

DBC and LaunchLab use a separate socket that is never disconnected for budget. Pump pre receives residual capacity after proof/pool reservations; no fixed hourly WS quota is imposed. Its budget pause is bounded at 90 seconds followed by a short metered probe. Bytes arriving during probes are fully charged. Pump create proof comes from verified program logs and CreateEvent/PDA identity rather than a transaction RPC for every new mint.

Daily Pump diagnostics reset at 00:00 UTC+5 and distinguish received unique creates, accepted creates, observed active time, budget gaps and network/restart gaps. Lost events during budget pauses are explicitly low-confidence estimates, never an exact count or a count of slots presented as events.

## Publication and VM

`server/` is the single runtime source. The hash manifest and module inventory must agree. Publication compares object hashes, updates changed modules first and collector last, and uses object-generation preconditions. Identical code does not restart the collector.

JSON histories are streamed and gzip-compressed through temporary files; publication sends metadata and content in a single multipart request. Full histories remain in daily observations-v2 archives. The phone receives small summaries. Raw uploads are durable and acknowledged before their pending payload is removed. Legacy writers and classic research calculation are disabled.

The strict monthly GCS write governor is **not active** (`gcsGovernorActive: false`). This release preserves fresh public status and observations; it does not certify zero GCP charges or compliance with the free monthly operation allowance. Successful collector writes/hour are visible in `memory.uploadsHour`. Billing and other clients' operations are outside the local counter. Reducing unchanged data and consolidating live publication remain separate work; enabling the existing strict spool alone would make public files stale.

VM and disk sizes and the Node heap limit were not increased. Hot-state retention, confirmed disk archives and streamed uploads bound memory growth; [RETENTION.md](RETENTION.md) describes the transaction. `status.json` includes RSS/heap/external memory in decimal MB, peak RSS, event-loop lag, queue sizes, research banks, raw upload backlog and state-file bytes.

Each rollout must pass: fresh matching collector version; all four modules active without configuration errors; RSS and measured peak below 450 MB; state below 30 MB; estimated Helius at most 18/min; DBC and LaunchLab connected. A short startup interval is allowed before the check succeeds; missing subscriptions never count as healthy.

## Verification limits

Linux CI covers runtime tests, journal durability, frozen decision windows, restart, forecast/accounting, pool batch receipts, archive acknowledgements and one-request streamed uploads. Mobile Chromium exercises the phone interface. Some directory-fsync durability tests require Linux; Windows-only filesystem limitations do not replace Linux CI.

Incomplete coverage remains unknown or pending. No missing observation becomes zero, no historical research label is imported, and synthetic test results are never published as real cohorts.

Provider references: [Helius credits](https://www.helius.dev/docs/billing/credits), [Helius WS metering](https://www.helius.dev/blog/laserstream-websockets), [Google Cloud Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features).
