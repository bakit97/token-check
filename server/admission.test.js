'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AdmissionGate, kzDay } = require('./admission');

const A = 'So11111111111111111111111111111111111111112';
const B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const C = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const t = Date.UTC(2026, 9, 17, 10, 0);
const pre = (mint, ageMs, opts = {}) => ({ mint, phase:'before', publicTradingAt:t-ageMs, publicTradingVerified:true, ...opts });
const post = (mint, ageMs, opts = {}) => ({ mint, phase:'after', migrationAt:t-ageMs, migrationVerified:true, ...opts });

test('доступна в торговле ровно предельное число минут', () => {
  const gate = new AdmissionGate({beforeMinutes:2});
  assert.equal(gate.offer(pre(A, 2*60_000), t).admitted, true);
  assert.equal(gate.offer(pre(B, 2*60_000+1), t).reason, 'too-old');
  assert.equal(gate.has(B), false);
});
test('опоздала до миграции → может попасть после, если миграция свежая', () => {
  const gate = new AdmissionGate({beforeMinutes:2, afterMinutes:3});
  assert.equal(gate.offer(pre(A, 181_000), t).admitted, false);
  assert.equal(gate.offer(post(A, 20_000), t).admitted, true);
  assert.equal(gate.get(A).phase, 'after');
});
test('попала до миграции → повторно после не добавляется', () => {
  const gate = new AdmissionGate();
  assert.equal(gate.offer(pre(A, 5_000), t).admitted, true);
  assert.deepEqual(gate.offer(post(A, 5_000), t), {admitted:false,reason:'already-admitted',initialPhase:'before'});
  assert.equal(gate.snapshot().coins.length, 1);
});
test('опоздала в обоих потоках → отсутствует в главном источнике', () => {
  const gate = new AdmissionGate();
  gate.offer(pre(A, 240_000),t);
  gate.offer(post(A, 240_000),t);
  assert.equal(gate.snapshot().coins.length, 0);
});
test('неподтверждённая миграция или дата создания токена не допускаются', () => {
  const gate = new AdmissionGate();
  assert.equal(gate.offer(post(A, 10_000,{migrationVerified:false}),t).reason,'not-verified');
  assert.equal(gate.offer(pre(B, 10_000,{publicTradingAt:undefined, createdAt:t-10_000, seenAt:t-5_000}),t).reason,'invalid-event-time');
  assert.equal(gate.offer(pre(C, 10_000,{publicTradingVerified:false}),t).reason,'not-verified');
});
test('время обнаружения не подменяет публичное открытие торгов', () => {
  const gate = new AdmissionGate();
  assert.equal(gate.offer(pre(A, 3*60_000,{seenAt:t-1_000}),t).reason,'too-old');
});
test('новые настройки действуют только на будущие входные события', () => {
  const gate = new AdmissionGate({beforeMinutes:1});
  assert.equal(gate.offer(pre(A,90_000),t).reason,'too-old');
  gate.configure({beforeMinutes:2});
  assert.equal(gate.has(A),false);
  assert.equal(gate.offer(pre(B,90_000),t).admitted,true);
});
test('возраст 1–10 минут, изменение настроек атомарное', () => {
  const gate = new AdmissionGate();
  assert.throws(()=>gate.configure({beforeMinutes:3,afterMinutes:11}), RangeError);
  assert.equal(gate.beforeMinutes,2);
  assert.throws(()=>new AdmissionGate({beforeMinutes:0}),RangeError);
  assert.throws(()=>new AdmissionGate({afterMinutes:1.5}),RangeError);
});
test('пути фильтруются независимо и не меняют первоисточник', () => {
  const gate = new AdmissionGate();
  gate.offer(pre(A,2_000),t);
  gate.offer(post(B,4_000),t);
  assert.equal(gate.selectPath(c=>c.phase==='before').length,1);
  assert.equal(gate.selectPath(()=>false).length,0);
  assert.equal(gate.selectPath(()=>true,{phase:'after'}).length,1);
  assert.equal(gate.snapshot().coins.length,2);
});
test('память запрещает повторный вход после перезапуска', () => {
  const gate = new AdmissionGate();gate.offer(pre(A,1_000),t);
  const restored = new AdmissionGate({snapshot:JSON.parse(JSON.stringify(gate.snapshot()))});
  assert.equal(restored.offer(post(A,1_000),t).reason,'already-admitted');
});
test('суточный счётчик по Казахстану UTC+5', () => {
  const gate = new AdmissionGate();
  const day1 = Date.UTC(2026,9,17,18,59);
  const day2 = Date.UTC(2026,9,17,19,1);
  gate.offer({mint:A,phase:'after',migrationAt:day1-10_000,migrationVerified:true},day1);
  gate.offer({mint:B,phase:'after',migrationAt:day2-10_000,migrationVerified:true},day2);
  assert.equal(kzDay(day1),'2026-10-17');
  assert.equal(kzDay(day2),'2026-10-18');
  assert.equal(gate.countToday(day2),1);
});
test('будущие, повреждённые даты и адреса отвергаются', () => {
  const gate = new AdmissionGate();
  assert.equal(gate.offer(pre(A,-2000),t).reason,'invalid-event-time');
  assert.equal(gate.offer(post(A,1_000,{migrationAt:NaN}),t).reason,'invalid-event-time');
  assert.equal(gate.offer(pre('bad',1000),t).reason,'invalid-mint');
});
