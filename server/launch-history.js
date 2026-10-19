'use strict';
// Only earlier, actually observed launches. Names never imply originality.
const DAY=24*3600000;
const text=x=>typeof x==='string'?x.trim().toLowerCase():'';
function identity(row,coin={}){const proof=row.proof||{},name=text(proof.name)||text(coin.n),symbol=text(proof.symbol)||text(coin.s);return {mint:row.mint,at:row.acceptedAt,name,symbol,nameAt:text(proof.name)?row.acceptedAt:coin.nameObservedAt??Infinity,symbolAt:text(proof.symbol)?row.acceptedAt:coin.nameObservedAt??Infinity};}
function cloneSnapshot(target,rows,now){const before=rows.filter(r=>r.mint!==target.mint&&r.at<target.at&&r.at>=target.at-DAY),nameMatches=new Set(),matches=new Set();let unknown=false,nameUnknown=false;
 for(const r of before){const nk=!!r.name&&r.nameAt<=target.at,sk=!!r.symbol&&r.symbolAt<=target.at;if(target.name&&!nk)nameUnknown=true;if(target.name&&!nk||target.symbol&&!sk)unknown=true;if(target.name&&nk&&r.name===target.name){nameMatches.add(r.mint);matches.add(r.mint);}if(target.symbol&&sk&&r.symbol===target.symbol)matches.add(r.mint);}
 if(!target.name&&!target.symbol)return {at:now,cloneCount:null,cloneRank:null,isFirstOfName:null,cloneCountLowerBound:false,scope:'observed-launches-24h'};
 return {at:now,cloneCount:matches.size,cloneRank:matches.size+1,isFirstOfName:!target.name?null:nameMatches.size?0:nameUnknown?null:1,cloneCountLowerBound:unknown,scope:'observed-launches-24h'};
}
class LaunchHistory{
 constructor(){this.stats={snapshots:0,lowerBounds:0};}
 update({source,coins,metadata=()=>null,now=Date.now(),limit=100}){const records=[...source.records.values()].filter(r=>r.acceptedAt>=now-2*DAY&&r.acceptedAt<=now),history=records.map(r=>identity(r,coins.get(r.mint)||metadata(r.mint)||{}));let n=0;
 for(const row of records.slice().sort((a,b)=>b.acceptedAt-a.acceptedAt)){const c=coins.get(row.mint);if(!c||c.discoveryFeatures||now-row.acceptedAt>26*3600000)continue;if(n++>=limit)break;if(c.n&&!Number.isFinite(c.nameObservedAt))c.nameObservedAt=now;const snap=cloneSnapshot(identity(row,c),history,now);c.discoveryFeatures=snap;this.stats.snapshots++;if(snap.cloneCountLowerBound)this.stats.lowerBounds++;}
 return {...this.stats};
 }
}
module.exports={identity,cloneSnapshot,LaunchHistory};
