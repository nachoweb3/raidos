
import {describe,it,expect} from "vitest";
import {MarketDataService} from "../src/market/data.js";
const token="0x"+"a".repeat(40), first="0x"+"b".repeat(40), second="0x"+"c".repeat(40);
const json=(body:unknown)=>new Response(JSON.stringify(body));
describe("same-token chart recovery",()=>{
 it("selects an indexed alternative and reports its actual pool",async()=>{
  const urls:string[]=[];
  const market=new MarketDataService({fetcher:async(url)=>{
   urls.push(url);
   if(url.includes("/tokens/"))return json({data:[{attributes:{address:second,reserve_in_usd:"5000"},relationships:{base_token:{data:{id:"base_"+token}}}}],
    included:[{id:"base_"+token,attributes:{address:token,symbol:"TEST"}}]});
   return json({data:{attributes:{ohlcv_list:url.includes(second)?[[1700000000,1,2,0.5,1.5,10]]:[]}}});
  }});
  const result=await market.candles("base",first,token);
  expect(result.pool).toBe(second);expect(result.data).toHaveLength(1);expect(urls).toHaveLength(3);
 });
 it("never uses a pool for another token",async()=>{
  const market=new MarketDataService({fetcher:async(url)=>json(url.includes("/tokens/")?
   {data:[{attributes:{address:second},relationships:{base_token:{data:{id:"base_"+first}}}}],included:[{id:"base_"+first,attributes:{address:first}}]}:
   {data:{attributes:{ohlcv_list:[]}}})});
  const result=await market.candles("base",first,token);
  expect(result.data).toEqual([]);expect(result.pool).toBe(first);
 });
});
