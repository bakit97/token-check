'use strict';
const fs=require('node:fs'),path=require('node:path');
const METHOD='gt-ohlcv-20m-v1',MIN=60000;
function active(row,now){return !!row&&now>=row.acceptedAt&&now-row.acceptedAt<20*MIN;}
function config(raw={}){return {...raw,outcomeMethod:METHOD,...(raw.phases?{phases:Object.fromEntries(Object.entries(raw.phases).map(([k,v])=>[k,{...v,outcomeMethod:METHOD}]))}:{})};}
function reset(raw){return raw?{...raw,id:('ohlcv1-'+(raw.id.length<=72?raw.id:require('node:crypto').createHash('sha256').update(raw.id).digest('hex')))}:{id:'ohlcv1-initial-method',requestedAt:Date.now()};}
function mask(features,approvedAt,cutoff){const out={...features};for(const key of require('./research-v2').RULE_KEYS)if(!(approvedAt?.[key]>0&&approvedAt[key]<=cutoff))out[key]=null;return out;}
class FeatureProbe{
 constructor({dir,startedAt,now=Date.now}={}){this.file=path.join(dir,'feature-probe-p43.json');this.now=now;let saved;try{saved=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}this.startedAt=saved?.startedAt||startedAt;this.rows=new Map(saved?.rows||[]);this.approvals=saved?.approvals||{};this.lastSave=0;}
 observe(coin,state){if(state.acceptedAt<this.startedAt)return;const keys=require('./research-v2').RULE_KEYS,old=this.rows.get(coin.a)||{anchor:state.acceptedAt,phase:state.phase,minutes:{}};for(const [m,s] of Object.entries(state.snapshots||{})){const f=Object.fromEntries(keys.map(k=>[k,s['1']?.[k]??s['2']?.[k]]));old.minutes[m]=keys.filter(k=>f[k]!=null&&(typeof f[k]!=='number'||Number.isFinite(f[k])));}this.rows.set(coin.a,old);for(const [k,r] of this.rows)if(this.now()-r.anchor>90*MIN)this.rows.delete(k);while(this.rows.size>200)this.rows.delete(this.rows.keys().next().value);}
 evaluate(){const now=this.now();if(this.summaryCache&&now-this.evaluatedAt<30000)return this.summaryCache;this.evaluatedAt=now;const keys=require('./research-v2').RULE_KEYS,out={};for(let m=1;m<=20;m++){const rows=[...this.rows.values()].filter(r=>r.minutes[m]&&r.anchor+m*MIN<=now&&r.anchor+m*MIN>=now-60*MIN).sort((a,b)=>b.anchor-a.anchor).slice(0,50);const features={};for(const key of keys){const known=rows.filter(r=>r.minutes[m].includes(key)).length,percent=rows.length?100*known/rows.length:null,ready=now-this.startedAt>=60*MIN&&rows.length>=50&&percent>=90;this.approvals[m]=this.approvals[m]||{};if(ready)this.approvals[m][key]??=now;else delete this.approvals[m][key];features[key]={known,total:rows.length,percent,enabled:ready,enabledAt:this.approvals[m][key]||null,reason:ready?null:rows.length<50?'probe-needs-50-coins':now-this.startedAt<60*MIN?'probe-needs-one-hour':'coverage-below-90'};}out[m]={samples:rows.length,features};}this.summaryCache={method:METHOD,startedAt:this.startedAt,updated:now,probe:{minimumCoins:50,minimumMs:60*MIN,targetPercent:90},anchor:'acceptedAt',receiptTimeOnly:true,minutes:out};if(now-this.lastSave>=MIN){const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify({startedAt:this.startedAt,rows:[...this.rows],approvals:this.approvals}),{mode:0o600});fs.renameSync(tmp,this.file);this.lastSave=now;}return this.summaryCache;}
 summary(minute=12){const all=this.evaluate();return {...all,selectedMinute:minute,features:all.minutes[minute]?.features||{},retainedCoins:this.rows.size};}
}
class TaskQuota{
 constructor({now=Date.now,limits={discovery:2,early:3,outcome:3}}={}){this.now=now;this.limits=limits;this.used={};this.deferred={};}
 lane(key){return key?.startsWith('outcome:')?'outcome':key?.startsWith('p43-early:')?'early':'discovery';}
 available(key){const lane=this.lane(key),now=this.now();this.used[lane]=(this.used[lane]||[]).filter(t=>t>now-MIN);return this.used[lane].length<this.limits[lane];}
 charge(key){if(!this.available(key)){const l=this.lane(key);this.deferred[l]=(this.deferred[l]||0)+1;return false;}this.used[this.lane(key)].push(this.now());return true;}
 summary(){return {independent:true,borrowing:false,requestsPerMinute:this.limits,used:Object.fromEntries(Object.keys(this.limits).map(k=>{this.available(k==='outcome'?'outcome:':k==='early'?'p43-early:':'new');return [k,this.used[k]?.length||0]})),deferred:this.deferred};}
}
class RPCQuota{
 constructor({now=Date.now}={}){this.now=now;this.limits={opening:4,holders:4,lp:9,identity:4};this.used={};this.deferred={};}
 take(lane){const at=this.now();this.used[lane]=(this.used[lane]||[]).filter(t=>t>at-MIN);if(this.used[lane].length>=this.limits[lane]){this.deferred[lane]=(this.deferred[lane]||0)+1;return false;}this.used[lane].push(at);return true;}
 summary(){return {independent:true,provider:'public-solana',heliusCredits:0,requestsPerMinute:this.limits,deferred:this.deferred};}
}
module.exports={METHOD,active,config,reset,mask,FeatureProbe,TaskQuota,RPCQuota};
