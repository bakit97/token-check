'use strict';
// Public Solana discovery only. Proof RPC remains metered independently.
class PoolLogs {
 constructor({WebSocket,definitions,onSignal,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,maxBytesSecond=1000000}={}){this.WebSocket=WebSocket;this.definitions=definitions;this.onSignal=onSignal;this.now=now;this.setTimer=setTimer;this.clearTimer=clearTimer;this.maxBytesSecond=maxBytesSecond;this.running=false;this.timer=null;this.socket=null;this.subs=new Map();this.acks=new Set();this.seen=new Map();this.state={provider:'public-solana',endpoint:'wss://api.mainnet-beta.solana.com',heliusWS:false,connected:false,available:false,bytes:0,messages:0,noise:0,signals:0,duplicates:0,errors:0,overload:0,oversized:0,reconnects:0,connectedAt:null,lastMessageAt:null};}
 summary(){return {...this.state,programs:[...new Set(this.definitions.map(s=>s.program))],subscriptions:this.acks.size};}
 start(){if(this.running)return;this.running=true;this.connect();}
 stop(){this.running=false;this.clearTimer(this.timer);this.timer=null;this.state.available=false;this.state.connected=false;this.socket?.close();}
 connect(){if(!this.running)return;const programs=[...new Set(this.definitions.map(s=>s.program))];this.subs.clear();this.acks.clear();const ws=this.socket=new this.WebSocket(this.state.endpoint);let retry=5000;this.windowAt=this.now();this.windowBytes=0;
  ws.onopen=()=>{if(ws!==this.socket||!this.running)return;this.state.connected=true;this.state.connectedAt=this.now();programs.forEach((program,i)=>ws.send(JSON.stringify({jsonrpc:'2.0',id:i+1,method:'logsSubscribe',params:[{mentions:[program]},{commitment:'confirmed'}]})));};
  ws.onmessage=e=>{if(ws!==this.socket||!this.running||typeof e.data!=='string')return;const txt=e.data,at=this.now(),bytes=Buffer.byteLength(txt);this.state.bytes+=bytes;this.state.messages++;this.state.lastMessageAt=at;
   if(at-this.windowAt>=5000){this.windowAt=at;this.windowBytes=0;}this.windowBytes+=bytes;if(this.windowBytes>this.maxBytesSecond*5){this.state.overload++;retry=60000;ws.close();return;}if(bytes>512000){this.state.oversized++;return;}
   // Most messages are swaps. No JSON.parse for the discarded traffic.
   if(txt.includes('logsNotification')&&!this.definitions.some(s=>txt.includes('Instruction: '+s.name.replace(/(^|_)([a-z0-9])/g,(_,p,c)=>c.toUpperCase())))){this.state.noise++;return;}
   let m;try{m=JSON.parse(txt);}catch{this.state.errors++;return;}
   if(Number.isInteger(m.id)&&m.id>=1&&m.id<=programs.length){if(m.error||!Number.isSafeInteger(m.result)){this.state.errors++;ws.close();return;}this.subs.set(m.result,programs[m.id-1]);this.acks.add(m.id);this.state.available=this.acks.size===programs.length;return;}
   const program=this.subs.get(m.params?.subscription),v=m.params?.result?.value,slot=m.params?.result?.context?.slot;if(!program||v?.err!==null||typeof v.signature!=='string'||!Number.isSafeInteger(slot))return;
   const names=this.definitions.filter(s=>s.program===program).map(s=>'Program log: Instruction: '+s.name.replace(/(^|_)([a-z0-9])/g,(_,p,c)=>c.toUpperCase()));if(!v.logs?.some(l=>names.includes(l))||!v.logs.some(l=>l.startsWith('Program '+program+' invoke')))return;
   for(const [key,t] of this.seen)if(at-t>600000)this.seen.delete(key);if(this.seen.has(v.signature)){this.state.duplicates++;return;}if(this.seen.size>=2000){this.state.overload++;return;}this.seen.set(v.signature,at);this.state.signals++;this.onSignal({signature:v.signature,slot,kind:'pool',receivedAt:at});
  };
  ws.onerror=()=>{this.state.errors++;ws.close();};ws.onclose=()=>{if(ws!==this.socket)return;this.state.connected=false;this.state.available=false;this.acks.clear();if(this.running){this.state.reconnects++;this.timer=this.setTimer(()=>this.connect(),retry);this.timer?.unref?.();}};
 }
}
module.exports={PoolLogs};
