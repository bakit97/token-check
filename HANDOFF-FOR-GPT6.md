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
