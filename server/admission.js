'use strict';

/**
 * SOL·СКАН: входной шлюз главного источника «Все».
 * Никакой другой раздел не создаёт новые исходные монеты.
 * Модуль НЕ получает события из сети: доверенный адаптер должен
 * предоставить подтверждённые времена начала публичной торговли / миграции.
 */
const MS_MINUTE = 60_000;
const KZ_OFFSET = 5 * 60 * MS_MINUTE;
const PHASES = new Set(['before', 'after']);

function validMinutes(value) {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new RangeError('Возрастной фильтр должен быть целым числом от 1 до 10 минут');
  }
  return value;
}
function validTimestamp(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
}
function kzDay(timestamp) {
  if (!validTimestamp(timestamp)) throw new RangeError('Некорректное время');
  return new Date(timestamp + KZ_OFFSET).toISOString().slice(0, 10);
}
function normalizeMint(mint) {
  if (typeof mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    throw new TypeError('Нужен действительный адрес mint Solana (base58)');
  }
  return mint;
}

class AdmissionGate {
  constructor({ beforeMinutes = 2, afterMinutes = 2, snapshot } = {}) {
    this.beforeMinutes = validMinutes(beforeMinutes);
    this.afterMinutes = validMinutes(afterMinutes);
    this.accepted = new Map();
    if (snapshot != null) {
      if (snapshot.schema !== 1 || !Array.isArray(snapshot.coins)) throw new TypeError('Неизвестный формат сохранённой памяти');
      for (const coin of snapshot.coins) {
        const mint = normalizeMint(coin.mint);
        if (!PHASES.has(coin.phase) || !validTimestamp(coin.eventAt) || !validTimestamp(coin.acceptedAt)) {
          throw new TypeError('Повреждённая запись памяти главного источника');
        }
        if (this.accepted.has(mint)) throw new TypeError('Дубликат адреса в памяти');
        this.accepted.set(mint, Object.freeze({ mint, phase: coin.phase, eventAt: coin.eventAt, acceptedAt: coin.acceptedAt }));
      }
    }
  }

  configure({ beforeMinutes = this.beforeMinutes, afterMinutes = this.afterMinutes } = {}) {
    // Проверяем оба значения ДО обновления: ошибка не должна изменить часть настроек.
    const before = validMinutes(beforeMinutes);
    const after = validMinutes(afterMinutes);
    this.beforeMinutes = before;
    this.afterMinutes = after;
    return { beforeMinutes: before, afterMinutes: after };
  }

  /**
   * before: {mint, phase:'before', publicTradingAt, publicTradingVerified:true}
   * after:  {mint, phase:'after', migrationAt, migrationVerified:true}
   * Времена подтверждены по сети, а не c.seen / регистрации токена / API.
   */
  offer(event, now = Date.now()) {
    if (!event || !PHASES.has(event.phase)) return { admitted: false, reason: 'invalid-phase' };
    let mint;
    try { mint = normalizeMint(event.mint); }
    catch { return { admitted: false, reason: 'invalid-mint' }; }
    if (!validTimestamp(now)) return { admitted: false, reason: 'invalid-now' };
    const previous = this.accepted.get(mint);
    if (previous) return { admitted: false, reason: 'already-admitted', initialPhase: previous.phase };

    const before = event.phase === 'before';
    const verified = before ? event.publicTradingVerified === true : event.migrationVerified === true;
    if (!verified) return { admitted: false, reason: 'not-verified' };
    const eventAt = before ? event.publicTradingAt : event.migrationAt;
    if (!validTimestamp(eventAt) || eventAt > now) return { admitted: false, reason: 'invalid-event-time' };
    const ageMs = now - eventAt;
    const allowedMs = (before ? this.beforeMinutes : this.afterMinutes) * MS_MINUTE;
    if (ageMs > allowedMs) {
      // Не входит в главный источник. Вторая попытка после будущей миграции допустима.
      return { admitted: false, reason: 'too-old', ageMs, allowedMs };
    }
    const record = Object.freeze({ mint, phase: event.phase, eventAt, acceptedAt: now });
    this.accepted.set(mint, record);
    return { admitted: true, reason: 'accepted', record };
  }

  has(mint) { return this.accepted.has(mint); }
  get(mint) { return this.accepted.get(mint) || null; }

  /** Фильтры отдельных путей не изменяют «Все» и не создают монеты. */
  selectPath(predicate, { phase } = {}) {
    if (typeof predicate !== 'function') throw new TypeError('Нужна функция фильтра пути');
    if (phase !== undefined && !PHASES.has(phase)) throw new TypeError('Неверный поток');
    return [...this.accepted.values()].filter(c => (!phase || c.phase === phase) && predicate(c));
  }

  /** Считает монеты по времени принятия в систему за сутки UTC+5. */
  countToday(now = Date.now()) {
    const day = kzDay(now);
    return [...this.accepted.values()].filter(c => kzDay(c.acceptedAt) === day).length;
  }

  snapshot() {
    return { schema: 1, coins: [...this.accepted.values()].map(c => ({ ...c })) };
  }
}
module.exports = { AdmissionGate, kzDay, validMinutes };
