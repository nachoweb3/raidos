
import {describe,it,expect} from "vitest";
import {rugcheckMetrics,goplusMetrics} from "../src/market/risk-metrics.js";
describe("risk metrics are bounded observations",()=>{
 it("keeps absent bundles and creator history unknown",()=>{expect(Object.values(rugcheckMetrics({})).every(v=>v===null)).toBe(true);});
 it("reports top account shares and observed creator rugs",()=>{
  const m=rugcheckMetrics({totalHolders:20,topHolders:Array.from({length:10},()=>({pct:2})),creatorTokens:[{rugged:true},{rugged:false},{name:"unknown"}],mintAuthority:null,freezeAuthority:"address",graphInsidersDetected:3});
  expect(m.top10Pct).toBe(20);expect(m.creatorRugs).toBe(1);expect(m.creatorTokensObserved).toBe(2);
  expect(m.mintActive).toBe(false);expect(m.freezeActive).toBe(true);expect(m.bundlesPct).toBeNull();
 });
 it("does not present an incomplete holder sample as top ten",()=>{
  expect(rugcheckMetrics({totalHolders:200,topHolders:[{pct:20}]}).top10Pct).toBeNull();
  expect(rugcheckMetrics({totalHolders:10,topHolders:Array.from({length:10},()=>({pct:20}))}).top10Pct).toBeNull();
 });
});

describe("EVM holder metrics",()=>{
 it("maps fractions and holder count without assuming rug or freeze history",()=>{
  const m=goplusMetrics({holder_count:"500",holders:Array.from({length:10},()=>({percent:"0.02"})),is_mintable:"0",creator_address:"0x"+"a".repeat(40)});
  expect(m.top10Pct).toBeCloseTo(20);expect(m.holders).toBe(500);expect(m.mintActive).toBe(false);
  expect(m.freezeActive).toBeNull();expect(m.creatorRugs).toBeNull();expect(m.creatorAddress).toBe("0x"+"a".repeat(40));
 });
 it("rejects missing, partial and impossible shares",()=>{
  expect(goplusMetrics({}).top10Pct).toBeNull();
  expect(goplusMetrics({holder_count:"500",holders:[{percent:"0.1"}]}).top10Pct).toBeNull();
  expect(goplusMetrics({holder_count:"1",holders:[{percent:""}]}).top10Pct).toBeNull();
  expect(goplusMetrics({holder_count:"1",holders:[{percent:"2"}]}).top10Pct).toBeNull();
 });
});

describe("bounded holder and creator details",()=>{
 const sol="So11111111111111111111111111111111111111112";
 const other="2o4qGPNdAHZ1gEeiWSfxFNi9WoSJvxMYaBSci49RttsK";
 const evm="0x"+"a".repeat(40);
 it("returns exact token accounts and preserves unknown shares and rug outcomes",()=>{
  const m=rugcheckMetrics({topHolders:[{address:sol,owner:other,pct:2},{address:other,pct:""}],
   creatorTokens:[{mint:sol,rugged:true},{mint:other}]});
  expect(m.topHolders).toEqual([{address:sol,pct:2},{address:other,pct:null}]);
  expect(m.creatorHistory).toEqual([{mint:sol,rugged:true},{mint:other,rugged:null}]);
 });
 it("rejects wrong-chain, malformed, duplicate and non-32-byte Solana addresses",()=>{
  const m=rugcheckMetrics({topHolders:[{address:evm,pct:1},{address:"z".repeat(44),pct:2},{address:sol,pct:0},{address:sol,pct:3}],
   creatorTokens:[{mint:evm,rugged:true},{mint:sol,rugged:false},{mint:sol,rugged:true}]});
  expect(m.topHolders).toEqual([{address:sol,pct:0}]);
  expect(m.creatorHistory).toEqual([{mint:sol,rugged:false}]);
 });
 it("caps both detail lists without altering aggregate observations",()=>{
  const rows=Array.from({length:25},(_,i)=>({address:"1".repeat(31)+"23456789ABCDEFGHJKLMNPQRS"[i],pct:1}));
  const m=rugcheckMetrics({topHolders:rows,creatorTokens:rows.map(h=>({mint:h.address,rugged:false}))});
  expect(m.topHolders).toHaveLength(20);expect(m.creatorHistory).toHaveLength(20);
  expect(m.top10Pct).toBe(10);expect(m.creatorTokensObserved).toBe(25);
 });
 it("maps EVM fractions and excludes Solana and duplicate addresses",()=>{
  const m=goplusMetrics({holders:[{address:sol,percent:"0.5"},{address:evm,percent:"0.2"},
   {address:evm.toUpperCase().replace("0X","0x"),percent:"0.3"},{address:"0x"+"b".repeat(40),percent:""}]});
  expect(m.topHolders).toEqual([{address:evm,pct:20},{address:"0x"+"b".repeat(40),pct:null}]);
  expect(m.creatorHistory).toBeUndefined();
 });
 it("omits detail fields when no valid rows exist",()=>{
  expect(rugcheckMetrics({topHolders:[],creatorTokens:[]})).not.toHaveProperty("topHolders");
  expect(rugcheckMetrics({creatorTokens:[{mint:"bad",rugged:true}]})).not.toHaveProperty("creatorHistory");
 });
});
