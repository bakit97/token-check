# One authoritative runtime

`server/collector.js` and its `MODULES` list are the only server version.
`python deployment/update-manifest.py` freezes the reviewed source hashes;
`python deployment/build-recovery.py` copies those exact files into the deployment
folder and verifies every hash. The historical filename remains for compatibility;
there is no old-commit overlay or alternate collector implementation.

`publish-runtime.py` compares object MD5 values, uploads changed modules with
object-generation leases, and uploads the collector last to trigger its normal
self-restart. An identical release does not restart the VM. The health check
requires a fresh expected version, both migration subscriptions, RSS below
450 MB and estimated combined Helius usage at most 18 credits/minute.
No deployment changes the VM type or disk. Keys remain on the server.

Full observation contracts live under `observations-v2/`; the phone uses their
small `summary/` projections. Source admission and both research streams remain
separate durable ledgers. Old research labels are excluded. Historical raw/trade
references may resolve under `archive/legacy/` after a verified archival copy;
missing historical files remain explicit gaps. Never delete an original before
its archived copy has matching object size and checksum.

The offline archive audit is `audit-observation-archives.cjs`. It validates mint,
pool, event generation, actual receipt times and observations without RPC.
