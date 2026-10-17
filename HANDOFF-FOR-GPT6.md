# Verification correction

See `docs/DEPLOYMENT-CHECK-2026-10-18.md` for the final live checkpoint and CI.
A 620 MB RSS peak recurred after disabling legacy research. That timer was not
the only source of memory pressure; the 400 MB RSS requirement remains unresolved.
Migration/pre separation, 18-credit target, pool collection and loss diagnostics
are deployed. A retained proof backlog remains visible and must not be described
as completed proof coverage.

# Latest correction — 2026-10-18 (UTC+5)

Owner requested migration coverage and meaningful pool observations over the
previous overly restrictive shared governor. DBC/LaunchLab now have a dedicated
always-reconnecting socket; budgeting never closes it. Only the separate Pump
pre channel pauses on its own stream share. No PumpSwap subscription was added.
Proof/reconciliation and pool work have non-starving reserved capacity, with
holders/pre last. Target 18 estimated combined credits/minute. See
`deployment/README.md` and the manifest for exact staged code and generations.

Live intermediate verification: 978/978 then 970/970 current pool/vault snapshots,
no overdue pools; 15.80224 then 17.6384 estimated credits/minute; both DBC and
LaunchLab subscriptions acknowledged. These counts naturally change with the
24-hour observation window. Pending migration proofs remain; detection coverage
must not be confused with completed proof coverage. Per-source pending/skipped
counters and pre pause gaps are in status. Historical missing raw windows stay
missing, with no invented timestamps. Legacy day/obs/raw remain enabled.

Final live generation is in the manifest. Legacy scheduled research is disabled
(owner declared its results invalid); day/obs/raw and new v2 processing remain
enabled. A 636 MB RSS spike was observed before disabling that timer, so do not
claim a proven hard RSS ceiling. Linux 114/114 passed for `5a5358f`.

Final fixes also retain deferred hourly-reconciliation batches, clear old process
locks on restart, and prioritize continuation of partially paid migration proofs.
Recovery-focused regression: 27 passed / 1 intentional multipart-GCS skip.
The earlier recovery record below is historical and is superseded by this section.

# UPDATE — owner-approved staged production recovery, 2026-10-18 (UTC+5)

This update supersedes the older statement below that production was untouched.
The owner explicitly authorized restoring 48cb0f8 first, then separately checking
each deployment before further migration. **Do not deploy the whole feature
collector**: use the reproducible pinned recovery build while cutover is pending.

Actual steps: restored the four changed files from exact 48cb0f8, preserved a
local backup, reset stuck VM once; verified live startup. Then deployed a bounded
archive-flush repair and checked heartbeat. Then deployed Helius-only accounting
and corrected headroom/priority based on live counters. `main`, VM/disk type,
owner configs and the Helius metadata key were not changed. Legacy day/obs/raw
exports remain active; no old UI/data was deleted or archived.

Active collector generation: **1792263193310124**.
Recovery base: **48cb0f8621e3a822cc65e0a7c23ba485ad3a574e**.
First separate queue repair in GitHub: **bfe1be1c5489257b7186c43df7aead4a3698fe47**.
See `deployment/recovery-manifest.json` for exact deployed SHA-256 hashes and
`deployment/build-recovery.py` to reproduce them from pinned Git history plus
`deployment/recovery-48cb0f8-helius.patch`. This temporary patch captures the
actual deployed build; it is not a second deployed server or second UI.

Latest verified status at 2026-10-18 00:00:18 UTC+5: heartbeat 3 seconds old,
WS connected, RSS 311 MB, minute-window estimated WS+RPC 16.5536 credits.
Monthly forecast 581,649 was based on a short sample, not provider billing.
Accounting checkpoint 185,000 conservatively covers owner-reported 174,302
plus measured recovery traffic. Existing resource ledger persists on VM.

Important limitation: 1 of 142 prelaunch create events in the observed interval
was admitted; 141 were budget-deferred. Source is sampling, not covering every
launch. Preserve unknown/missing status. Startup/export memory earlier exceeded
400 MB, so a hard bound and long-duration behavior have not been proven. GCS
Class A/B and Billing remain unverified; legacy frequent exports still run.

Tests: queue repair 3/3 local PASS; final recovery-focused suite 18 PASS,
1 deliberate SKIP (multipart GCS path is not installed in recovery build).
Reconstruction verifies exact artifact hashes. Verified Linux workflow for implementation commit
`602c364ceeb72b4384f3036410d66da10ae10f36`:
https://github.com/bakit97/token-check/actions/runs/39060970383 — **105/105 PASS**,
plus exact recovery reconstruction and **18 PASS / 1 deliberate SKIP**.
Existing v2-path-integration and v2-server-paths-ci also PASS.
Latest live verification at 2026-10-18 00:07:35 UTC+5: heartbeat age 72 seconds,
version 1792263193310124, memory 309 MB, estimated minute credits 13.62144,
source initialization error empty, source total 6276. WS was budget-paused in
that sample; do not describe it as continuously connected.

**Next required work — single-version migration is NOT complete:**
1. Complete `docs/OBSERVATION-MIGRATION.md` contract gate. New source files have
   admission identity only; no replacement yet for full DS, vault balances,
   first-ten-minute trade candles, holders-at-ten and raw states. Keep day/obs.
2. Preserve raw snapshots on pool migration (`takeObs` currently deletes raw),
   transfer chain quote-vault <5% drain logic, and keep no-lookahead timestamps.
3. Respect the eight proven mechanisms listed by the owner; do not substitute
   DS zero liquidity, synthetic prices or new unverified migration assumptions.
4. Resolve coverage versus twenty-credit budget honestly. Investigate efficient
   proof/batching approaches before promising complete capture; do not increase
   the limit or expose the key. Then complete the observation cutover, deploy
   and verify it before deleting any legacy interface/writer.
5. Only after equivalent observations exist: one new root index, remove old UI
   and duplicate lab collector logic; start clean research epochs without old
   results; copy/verify/archive day/obs/research before removing source paths.
6. GCS free-operation budget and full LIVE freshness still conflict under the
   existing many-object publication scheme. Keep this visible; do not silently
   deploy the slow strict governor or claim Billing is verified.

Full audit/results: `deployment/README.md`, `docs/OBSERVATION-MIGRATION.md`.
Recovery scratch/backups: `work/recovery-48cb0f8/` (local, not committed).
The older Claude/GPT notes below are retained as historical context.

---

# HANDOFF — Codex resource controls, 2026-10-17

Branch: `feature/serverside-passed-r2-20261017`; existing draft PR: https://github.com/bakit97/token-check/pull/15
Implementation commit: **8df8c12d47ed6334333088a8680c8998f9306bcc**.
This report is a subsequent documentation-only commit; use the branch HEAD for its SHA.
Claude's original report is preserved below as historical context, not current verification.

## Scope actually completed

The owner's follow-up requested a combined Helius budget of <=20 credits/minute,
monthly forecast and automatic background throttling, plus Always Free VM/GCS
protections. This commit implements that scope. It does **not** complete or
certify the whole original SOL·СКАН v2 specification.

Changed files: `server/collector.js`, `server/resource-budget.js`,
`server/resource-budget.test.js`, `server/pre-watcher.js`, `server/source-runtime.js`,
`tests/resource-collector-smoke.cjs`, `.github/workflows/resource-budget-tests.yml`,
`.github/workflows/deploy-server.yml`, `docs/RESOURCE-BUDGET.md`.

- Helius accounting persists before RPC attempts, includes failures/retries,
  accounts archival methods at 10 credits, and reserves received WS payload at
  20 credits/MB. RPC contexts capture priority at submission. Shared rolling
  minute/hour/month guards defer background first; fresh proofs have priority.
- Forecast, estimated balance, reset deadline and throttling diagnostics appear
  under `status.json.resources.helius`. Checkpoint starts at owner-reported
  174,302 credits; exact reset time/current usage still require dashboard reconciliation.
- Background pool requests slowed to 5 minutes; curve sweeps to 10 minutes.
  Five-minute, 128-entry proof cache avoids paying repeatedly for immutable
  responses during partially completed migration proofs.
- GCS governor limits this collector to 4,000 paced write attempts/month,
  including failed requests, leaving 1,000 for other consumers. It merges gzip
  content and metadata in one multipart operation (removed metadata PATCH).
  Actual successful and attempted writes/hour are separate diagnostics.
- Changed exports coalesce into a bounded disk spool (128 MiB / 1,000 files),
  survive restart/failures, and rotate fairly. Raw observations are only removed
  from RAM after durable queue acceptance. Full spool reports errors and retains
  local observations; it does not imply successful cloud publication.
- RSS/heap, event-loop lag, memory backpressure, bounded candidate/dedup/GT
  queues, expired background work and distinct budget deferral counters added.
  Hourly discovery and filter audit run sequentially in bounded workers.
- Source lifetime index/replay have explicit capacity safety stops. Historical
  deduplication and labels are retained; capacity is not cleared on restart.

## Validation actually performed

1. `node --check` for every `server/*.js`, `lab-core.js`, `v2.js`: PASS.
2. `git diff --check`: PASS before implementation commit.
3. Windows focused suite:
   `node --test server/resource-budget.test.js tests/resource-collector-smoke.cjs server/pre-watcher.test.js server/source-runtime.test.js`
   **29/29 PASS** (TEMP/TMP pointed at workspace test scratch).
4. Windows full suite:
   `node --test server/*.test.js tests/source-collector-smoke.cjs tests/research-collector-smoke.cjs tests/v2-smoke.cjs tests/resource-collector-smoke.cjs`
   **87 PASS / 13 FAIL**; all 13 failures are existing directory-fsync EPERM on
   Windows. Directory fsync was not disabled in the Linux production modules.
5. Exact implementation SHA on GitHub, Ubuntu + Node 20:
   https://github.com/bakit97/token-check/actions/runs/39057623504
   Same full offline suite: **100 tests / 100 PASS / 0 FAIL**; syntax PASS.
6. Existing GitHub workflows for that SHA also PASS:
   https://github.com/bakit97/token-check/actions/runs/39057623467 (v2-path-integration)
   https://github.com/bakit97/token-check/actions/runs/39057623432 (v2-server-paths-ci).
7. Live Helius, actual VM state/RSS/load, actual GCS Billing, real create_v2
   subscription discovery and production deployment: **NOT performed**.

## Release blockers / next work, in order

1. **Freshness versus free writes is unresolved architecturally.** A single
   object/minute costs 43,200 writes/30 days; 5,000 free writes cannot support
   dozens of fresh objects every 30–60 seconds. Strict mode can delay individual
   public files by hours. Existing UI freshness checks correctly reject old
   files. Do not deploy this as a ready LIVE website. Plan a compact shared
   snapshot / suitable read endpoint; do not merely loosen stale thresholds.
   Existing deployment verification requires 180-second freshness and was
   deliberately not weakened to accept this delayed mode.
2. Reconcile provider checkpoints: exact Helius reset/usage, GCS month-to-date
   Class A usage, other consumers, Class B reads, egress/storage and Billing.
   Initial GCS used=0 is an unverified estimate, not evidence of free headroom.
   Helius default reset 2026-11-14T00:00:00Z is a conservative interpretation of
   the owner's October 17 '28 days left' report. Existing ledger takes precedence
   over first-start env defaults. Renewal stops spending until reconciled.
3. Proving every incoming Pump launch is impossible with 20 credits/minute at
   10 credits/transaction proof. Measure achievable sampling and explicitly show
   deferred/lost candidates. Keep missing observations as unknown.
4. Load-test actual existing state on a separate environment, including replay
   and JSON peaks. Target <400 MiB is not a measured VM guarantee. The candidate
   cap is 5,000; source index 100,000, replay max 64 MiB. Safety stops need a proper
   bounded disk index/streamed archival replay for indefinite operation. Do not
   delete historical ledgers or truncate active cohorts to bypass the limits.
5. After explicit owner approval only, deploy and verify real create_v2 coverage,
   provider counters, heartbeat, lag, memory and recovery. Add no credentials
   to chat/git/public objects. Helius key remains VM metadata `helius-key`.
6. The existing draft PR is open and reports mergeable=false against current
   main. No merge/conflict resolution against main was performed in this scope.
7. Continue original full-spec audit: six tabs, owner control, no-lookahead,
   cohort epochs, audit/holdout correctness and mobile lazy loading. Current
   statuses of all six tabs and both end-to-end research paths remain
   **unverified in production**, not certified complete by this budget change.

## Restart and rollback

Keep `resource-budget.json` and `publish-spool/` with the existing data volume.
Budget ledger is atomic/fsynced; damaged accounting fails closed instead of
resetting spend. Spool restores pending exports. Preserve existing source,
Passed, research journals, epochs and owner configs. See `docs/RESOURCE-BUDGET.md`
for exact limits, settings, tradeoffs and the reset procedure.

No `main` update, merge, production VM command, machine/disk change, GCS code/
config publication, owner-rule activation or production deploy was performed.
Workflows were edited only as source code in the feature branch; test runs used
no cloud credentials. Production status from Claude's earlier report was not
re-verified. His inconsistent historical claims about a code/ upload remain
unresolved; do not infer a successful deployment from them.

---

## Historical Claude handoff (unchanged)

# HANDOFF FOR GPT-6 (from Claude Code, 2026-10-17)

Ветка: `feature/serverside-passed-r2-20261017` · PR #15. SHA см. в последнем коммите (`fix(collector): pump WS only on create + single module loader`).
Объём работы Claude ограничен (у владельца закончился лимит), поэтому сделано только самое срочное: запуск сервера. Остальное ТЗ не выполнялось.

## 1. Главное: рабочий сервер (prod) лежит с 17.10 10:35 UTC
- `status.json` не обновлялся с ~10:35 UTC. VM `solscan` в статусе RUNNING. SSH из среды Claude недоступен, а serial log не содержит вывода сборщика.
- До остановки в `errors` шли `diag/live/export fetch failed` с 10:06 UTC: выгрузки в GCS перестали проходить.
- В 11:11 UTC в `code/` выложен новый код (collector + 11 модулей), но свежего heartbeat так и не появилось.
- **Prod-код в `main` уже содержит изменения v2** (в ТЗ сказано «рабочий сайт на старой версии» — это не так).

### Корневая причина (вероятная, по данным status.json)
`chainWatch` подписывался `logsSubscribe {mentions:[PUMP program]}`. Это **каждая** покупка и продажа pump.fun: `ws.msgs.pre = 3 021 775`, `ws.kb ≈ 4,5 ГБ` за сутки, около 94 тыс. кредитов Helius на WS. На e2-micro (0,25 vCPU, 1 ГБ) `JSON.parse` каждого сообщения забивает CPU, таймауты превращаются в «fetch failed», процесс зависает и не замечает новую версию кода. Кроме того, сторож «>5000 сообщений в час → закрыть ws» постоянно рвал соединение (`ws.on=false`), а вместе с ним и подписки DBC и LaunchLab.

## 2. Что исправлено в коде (только `server/collector.js`)
1. **Подписка pre**: `mentions:[PUMP_MINT_AUTH]`, где `PUMP_MINT_AUTH='TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM'`. Это PDA mint-authority pump.fun, она есть только в create/create_v2; переопределяется через env `PUMP_MINT_AUTH`. Ожидаемый трафик — около 1–2 тыс. create в час вместо миллионов сделок. **Проверь на живом Helius**, что create_v2 (Token-2022) тоже упоминает этот адрес. Если нет, добавь вторую подписку.
2. **Дешёвый отсев** в `ws.onmessage`: `logsNotification` без строки `Instruction: Create` отбрасывается до `JSON.parse` (счётчик `WS.preDrop`).
3. **Единый загрузчик модулей** `ensureModules()`: все 11 модулей скачиваются одним шагом до любого `require` и вызываются в начале `initSource`, `initResearchV2` и `initPathsV2`. Раньше `pass-runtime.js → require('./research-v2')` зависел от того, что `initResearchV2` успел скачать research-v2.js: при ошибке исследования «Прошли» падал с MODULE_NOT_FOUND (пункт 9.1 ТЗ). Старые циклы загрузки внутри init* оставлены (они идемпотентны), их можно удалить.

## 3. Проверки (реально выполненные)
- `node --check` для всех `server/*.js`, `lab-core.js`, `v2.js` — OK.
- `node server/<x>.test.js` для 8 тестов (admission, path-runtime, pre-watcher, pump-pre, research-runtime, research-v2, source-runtime, v2-paths) — все OK.
- Запуск collector в песочнице (сеть подменена: GCS из локальной папки, внешние API выключены, пустое состояние): старт, «главный источник готов», «исследование v2 готово», «серверные пути готовы», все 11 модулей скачаны, выгружены `source/*`, `passed-v2/*`, `research-v2/*`, `status.json`. На **реальном состоянии VM** (11 тыс. монет, живой Helius) не проверялось.

## 4. Не сделано (по ТЗ, в порядке важности)
1. **Поднять prod**: нужен деплой исправленного collector и, вероятно, `gcloud compute instances reset solscan` (процесс завис). Только с разрешения владельца. После деплоя убедиться: `status.json.updated` свежий каждые ~30 с, `ws.on=true`, `ws.msgs.pre` — сотни в час, а не сотни тысяч.
2. **Бюджет Helius**: `creditsHour=4252` (≈70 в минуту) против цели ≤20 в минуту. Разбивка в `rpcCtx`: «пулы» 6965 и «миграция» 5099 — главные. Нужно урезать.
3. **Очередь GeckoTerminal**: 5221 задача, самая старая 9,5 ч. Фоновые задачи (prio 2) не ограничены. Нужен лимит или сброс устаревших задач.
4. Остальное из ТЗ §3–§10 (UI шести вкладок, control-api/Cloud Run, аудит версий, holdout) Claude не проверял и не менял.

## 5. Не трогалось
`main`, prod VM, GCS `code/` и `config/`, workflows.
