import bs58 from "bs58";

export interface RiskMetrics {
 top10Pct:number|null; holders:number|null; insiderDetections:number|null;
 bundlesPct:number|null; creatorRugs:number|null; creatorTokensObserved:number|null;
 mintActive:boolean|null; freezeActive:boolean|null;
 creatorAddress?:string|null;
 topHolders?:Array<{address:string;pct:number|null}>;
 creatorHistory?:Array<{mint:string;rugged:boolean|null}>;
}
const count=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?v:null;
const pct=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=100?v:null;
const solanaAddress=(v:unknown):v is string=>{
 if(typeof v!=="string"||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v))return false;
 try{return bs58.decode(v).length===32;}catch{return false;}
};
const evmAddress=(v:unknown):v is string=>typeof v==="string"&&/^0x[0-9a-fA-F]{40}$/.test(v);
const fractionPct=(v:unknown)=>{
 if(typeof v!=="string"&&typeof v!=="number")return null;
 if(String(v).trim()==="")return null;
 const n=Number(v);
 return Number.isFinite(n)&&n>=0&&n<=1?n*100:null;
};
function holderRows(rows:unknown,valid:(v:unknown)=>v is string,share:(v:any)=>number|null){
 if(!Array.isArray(rows))return [];
 const seen=new Set<string>();
 return rows.filter(h=>{
  if(!valid(h?.address))return false;
  const key=valid===evmAddress?h.address.toLowerCase():h.address;
  if(seen.has(key))return false;
  seen.add(key);return true;
 }).slice(0,20).map(h=>({address:h.address as string,pct:share(h)}));
}
export function rugcheckMetrics(body:any):RiskMetrics {
 const holders=count(body?.totalHolders);
 const topHolders=holderRows(body?.topHolders,solanaAddress,h=>pct(h?.pct));
 const seenMints=new Set<string>();
 const creatorHistory=Array.isArray(body?.creatorTokens)?body.creatorTokens.filter((t:any)=>{
  if(!solanaAddress(t?.mint)||seenMints.has(t.mint))return false;
  seenMints.add(t.mint);return true;
 }).slice(0,20).map((t:any)=>({mint:t.mint as string,rugged:typeof t.rugged==="boolean"?t.rugged:null})):[];
 const top=Array.isArray(body?.topHolders)?body.topHolders.slice(0,10):[];
 const percentages=top.map((h:any)=>pct(h?.pct));
 const complete=top.length===10||(holders!==null&&holders>0&&top.length===holders);
 const total=complete&&percentages.every((p:any)=>p!==null)?percentages.reduce((a:number,b:number)=>a+b,0):null;
 const history=Array.isArray(body?.creatorTokens)?body.creatorTokens.filter((t:any)=>typeof t?.rugged==="boolean"):null;
 const authority=(field:string)=>Object.hasOwn(body??{},field)?body[field]===null?false:typeof body[field]==="string"&&body[field].length>0?true:null:null;
 return {...(topHolders.length?{topHolders}:{}),...(creatorHistory.length?{creatorHistory}:{}),top10Pct:total!==null&&total<=100.001?Math.min(total,100):null,holders,insiderDetections:count(body?.graphInsidersDetected),
 bundlesPct:null,creatorRugs:history?.length?history.filter((t:any)=>t.rugged).length:null,creatorTokensObserved:history?.length||null,
 mintActive:authority("mintAuthority"),freezeActive:authority("freezeAuthority"),
 creatorAddress:typeof body?.creator==="string"&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.creator)?body.creator:null};
}

// GoPlus holder percentages are fractions: 1 means 100%, not 1%.
export function goplusMetrics(body:any):RiskMetrics {
 const parsedCount=typeof body?.holder_count==="string"&&/^\d+$/.test(body.holder_count)?Number(body.holder_count):body?.holder_count;
 const holders=count(parsedCount);
 const top=Array.isArray(body?.holders)?body.holders.slice(0,10):[];
 const shares=top.map((h:any)=>fractionPct(h?.percent));
 const topHolders=holderRows(body?.holders,evmAddress,h=>fractionPct(h?.percent));
 const complete=top.length===10||(holders!==null&&holders>0&&top.length===holders);
 const total=complete&&shares.every((v:any)=>v!==null)?shares.reduce((a:number,b:number)=>a+b,0):null;
 return {...rugcheckMetrics({}),holders,...(topHolders.length?{topHolders}:{}),
  top10Pct:total!==null&&total<=100.001?Math.min(total,100):null,
  mintActive:body?.is_mintable==="1"?true:body?.is_mintable==="0"?false:null,
  creatorAddress:typeof body?.creator_address==="string"&&/^0x[0-9a-fA-F]{40}$/.test(body.creator_address)?body.creator_address:null
 };
}
