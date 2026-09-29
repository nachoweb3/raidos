
import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {SourceTextModule,createContext} from "node:vm";
async function setup(fetcher:any) {
 let expire:()=>void=()=>{}; let cleared=false; let delay:number|null=null;
 const context=createContext({AbortController,localStorage:{getItem:()=>null},location:{hostname:"localhost",origin:"http://localhost"},
 fetch:fetcher,setTimeout:(fn:any,ms:number)=>{expire=fn;delay=ms;return 1;},clearTimeout:()=>{cleared=true;}});
 const mod=new SourceTextModule(readFileSync(new URL("../../../site/js/api.js",import.meta.url),"utf8"),{context});
 await mod.link(()=>{throw Error("unexpected import");});await mod.evaluate();
 return {api:(mod.namespace as any).ApiClient,expire:()=>expire(),delay:()=>delay,cleared:()=>cleared};
}
describe("bounded read requests",()=>{
 it("rejects a stalled read and releases its timer",async()=>{
  const t=await setup((_url:any,opts:any)=>new Promise((_resolve,reject)=>opts.signal.addEventListener("abort",()=>reject(Error("aborted")))));
  const pending=t.api.request("/api/market/catalog");
  const result=expect(pending).rejects.toThrow("El servidor tarda demasiado");
  expect(t.delay()).toBe(15000);t.expire();await result;expect(t.cleared()).toBe(true);
 });
 it("preserves caller cancellation and does not retry a write",async()=>{
  let calls=0;
  const t=await setup(async()=>{calls++;throw Error("offline");});
  await expect(t.api.request("/api/order",{method:"POST"})).rejects.toThrow("offline");
  expect(calls).toBe(1);expect(t.delay()).toBeNull();
 });
 it("gives bounded analytics a longer window and clears successful reads",async()=>{
  const t=await setup(async()=>({ok:true,json:async()=>({ok:true})}));
  expect(await t.api.request("/api/market/onchain-risk")).toEqual({ok:true});
  expect(t.delay()).toBe(60000);expect(t.cleared()).toBe(true);
 });
});
