'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {SourceRuntime}=require('./source-runtime');

const A='So11111111111111111111111111111111111111112';
const B='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const C='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const stamp=Date.UTC(2026,9,17,10,0);
function ephemeral(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sol-scan-source-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return dir;
}
const migrated=(mint,at,seen,overrides={})=>({
 a:mint,seen,
 mg:{st:'ok',mT:at,seenAt:seen,k:'pump',sig:'proof-tx-123',pool:A},...overrides
});
test('Публичная торговля: 2:00 включительно, 2:00.001 поздно',t=>{
 const src=new SourceRuntime({dir:ephemeral(t)});
 assert.equal(src.before({mint:A,publicTradingAt:stamp-120000,observedAt:stamp,verified:true}).admitted,true);
 assert.equal(src.before({mint:B,publicTradingAt:stamp-120001,observedAt:stamp,verified:true}).reason,'too-old');
 assert.equal(src.records.size,1);
});
test('Опоздала до — появилась после, но только один раз',t=>{
 const src=new SourceRuntime({dir:ephemeral(t)});
 src.before({mint:A,publicTradingAt:stamp-130000,observedAt:stamp,verified:true});
 assert.equal(src.afterVerifiedMigration(migrated(A,stamp-5000,stamp)).admitted,true);
 assert.equal(src.before({mint:A,publicTradingAt:stamp-3000,observedAt:stamp,verified:true}).reason,'already-admitted');
 assert.equal(src.records.size,1);
 assert.equal(src.get(A).phase,'after');
});
test('Попала до — не появляется после; путь фильтруется независимо',t=>{
 const src=new SourceRuntime({dir:ephemeral(t)});
 assert.equal(src.before({mint:A,publicTradingAt:stamp-500,observedAt:stamp,verified:true}).admitted,true);
 assert.equal(src.afterVerifiedMigration(migrated(A,stamp-5000,stamp)).reason,'already-admitted');
 assert.equal(src.path({predicate:()=>false}).length,0);
 assert.equal(src.path({phase:'before'}).length,1);
 assert.equal(src.path({phase:'after'}).length,0);
 assert.equal(src.records.size,1);
});
test('Настоящее доказательство пула + подпись обязательны',t=>{
 const src=new SourceRuntime({dir:ephemeral(t)});
 assert.equal(src.afterVerifiedMigration(migrated(A,stamp-1000,stamp,{mg:{st:'ok',mT:stamp-1000,seenAt:stamp}})).reason,'not-verified');
 assert.equal(src.before({mint:B,publicTradingAt:stamp-2000,observedAt:stamp,verified:false}).reason,'not-verified');
 assert.equal(src.records.size,0);
});
test('Первая отметка о миграции важнее позднего окончания проверки',t=>{
 const src=new SourceRuntime({dir:ephemeral(t)});
 const late=stamp+5*60000;
 const item=migrated(A,stamp,late,{wsSeen:stamp+15000});
 assert.equal(src.afterVerifiedMigration(item).admitted,true);
 assert.equal(src.get(A).acceptedAt,stamp+15000);
});
test('Строго позднее первое обнаружение отсеивает миграцию',t=>{
 const src=new SourceRuntime({dir:ephemeral(t)});
 assert.equal(src.afterVerifiedMigration(migrated(A,stamp-120001,stamp)).reason,'too-old');
 assert.equal(src.records.size,0);
});
test('Полная память после перезапуска и недопущение дублей',t=>{
 const dir=ephemeral(t),src=new SourceRuntime({dir});
 src.before({mint:A,publicTradingAt:stamp-1000,observedAt:stamp,verified:true,proof:'verified-chain'});
 src.afterVerifiedMigration(migrated(B,stamp-9000,stamp));
 const restarted=new SourceRuntime({dir});
 assert.equal(restarted.records.size,2);
 assert.equal(restarted.get(A).proof,'verified-chain');
 assert.equal(restarted.afterVerifiedMigration(migrated(A,stamp+500,stamp+1000)).reason,'already-admitted');
 assert.equal(fs.readFileSync(restarted.logPath,'utf8').trim().split('\n').length,2);
});
test('Отдельные фильтры 1–10 минут и сохранение конфигурации',t=>{
 const dir=ephemeral(t),src=new SourceRuntime({dir});
 src.configure({beforeMinutes:1,afterMinutes:9});
 assert.equal(src.before({mint:A,publicTradingAt:stamp-90000,observedAt:stamp,verified:true}).reason,'too-old');
 assert.equal(src.afterVerifiedMigration(migrated(B,stamp-8*60000,stamp)).admitted,true);
 const restart=new SourceRuntime({dir});
 assert.deepEqual(restart.settings(),{beforeMinutes:1,afterMinutes:9});
 assert.equal(restart.records.size,1);
});
test('Казахстанские сутки и дневной счётчик',t=>{
 const src=new SourceRuntime({dir:ephemeral(t)});
 const beforeMidnight=Date.UTC(2026,9,17,18,59);
 const afterMidnight=Date.UTC(2026,9,17,19,1);
 src.before({mint:A,publicTradingAt:beforeMidnight-1000,observedAt:beforeMidnight,verified:true});
 src.afterVerifiedMigration(migrated(B,afterMidnight-1000,afterMidnight));
 assert.equal(src.summary(afterMidnight).today,1);
 assert.equal(src.summary(afterMidnight).todayAfter,1);
 assert.equal(src.day('2026-10-17').length,1);
});
test('Повреждённая середина журнала — не делать вид, что загрузка успешна',t=>{
 const dir=ephemeral(t),src=new SourceRuntime({dir});
 src.before({mint:A,publicTradingAt:stamp-1000,observedAt:stamp,verified:true});
 fs.appendFileSync(src.logPath,'{bad-json}\n');
 assert.throws(()=>new SourceRuntime({dir}),SyntaxError);
});
