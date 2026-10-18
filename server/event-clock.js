'use strict';
// A slot is an ordering reference, not a wall-clock timestamp or migration proof.
class EventClock {
  constructor({rpc,now=Date.now}={}){this.rpc=rpc;this.now=now;this.anchor=null;this.checkedAt=0;this.busy=null;this.stats={calls:0,deferred:0};}
  observe(slot,at=this.now()){
    if(!Number.isSafeInteger(slot)||slot<=0)return;
    if(!this.anchor||slot>this.anchor.slot)this.anchor={slot,at,source:'ws'};
  }
  async refresh(){
    const at=this.now();
    if(this.busy)return this.busy;
    if(at-this.checkedAt<10000||(this.anchor&&at-this.anchor.at<10000))return;
    this.checkedAt=at;
    this.busy=(async()=>{try{const slot=await this.rpc('getSlot',[{commitment:'confirmed'}]);this.stats.calls++;
      if(Number.isSafeInteger(slot)&&slot>0)this.anchor={slot,at:this.now(),source:'rpc'};
    }catch(e){this.stats.deferred++;}finally{this.busy=null}})();
    return this.busy;
  }
  estimate(slot,at=this.now()){
    if(!Number.isSafeInteger(slot)||slot<=0||!this.anchor||at-this.anchor.at>30000)return null;
    const estimate=this.anchor.at+(slot-this.anchor.slot)*400;
    if(estimate>at+30000)return null;
    return {at:Math.min(at,estimate),ageMs:Math.max(0,at-estimate),source:'slot-estimate',slot,anchorSlot:this.anchor.slot};
  }
  summary(){return {...this.stats,anchor:this.anchor,slotDurationMs:400,cacheMs:10000,estimateOnly:true};}
}
module.exports={EventClock};
