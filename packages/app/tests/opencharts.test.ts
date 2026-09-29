
import {readFileSync} from "node:fs";
import {SourceTextModule} from "node:vm";
import {beforeAll,describe,it,expect} from "vitest";
import {MarketDataService} from "../src/market/data.js";
let lib:any;
beforeAll(async()=>{
 const mod=new SourceTextModule(readFileSync(new URL("../../../site/vendor/opencharts/engine.js",import.meta.url),"utf8"));
 await mod.link(()=>{throw new Error("Standalone drawing engine must not import demo services");});await mod.evaluate();lib=mod.namespace;
});
describe("OpenCharts real-data integration",()=>{
 const flat=Array.from({length:80},(_,i)=>({time:1700000000+i*60,open:100,high:101,low:99,close:100,volume:50}));
 it("MACD is zero on constant prices and leaves warmup empty",()=>{
  const d=lib.macd(flat);expect(d.macd[0].time).toBe(flat[25].time);expect(d.signal[0].time).toBe(flat[33].time);
  expect([...d.macd,...d.signal,...d.histogram].every((x:any)=>x.value===0)).toBe(true);
 });
 it("ATR reflects the true range and stochastic is centered",()=>{
  expect(lib.atr(flat)[0].value).toBe(2);expect(lib.stochastic(flat).k.every((x:any)=>x.value===50)).toBe(true);
  expect(lib.atr(flat.slice(0,10))).toEqual([]);
 });
 it.each([[60,"hour",1],[240,"hour",4],[1440,"day",1]])("maps %s minutes to real provider units",async(minutes,frame,n)=>{
  let requested="";const service=new MarketDataService({fetcher:async(url)=>{requested=String(url);return new Response(JSON.stringify({data:{attributes:{ohlcv_list:[[1700000000,1,2,0.5,1.5,10]]}}}));}});
  await service.candles("solana","So11111111111111111111111111111111111111112","So11111111111111111111111111111111111111112",Number(minutes));
  expect(requested).toContain("/ohlcv/"+frame+"?aggregate="+n);expect(requested).toContain("limit=1000");
 });
});
