
import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {SourceTextModule,SyntheticModule,createContext} from "node:vm";
async function load(){
 const context=createContext({URL,window:{}});
 const mod=new SourceTextModule(readFileSync(new URL("../../../site/js/tokens.js",import.meta.url),"utf8"),{context});
 await mod.link(()=>new SyntheticModule(["ApiClient"],function(){this.setExport("ApiClient",{});},{context}));
 await mod.evaluate();return (mod.namespace as any).TokenMeta;
}
describe("token image recovery",()=>{
 it("normalizes IPFS and rejects unsafe image schemes",async()=>{
  const m=await load();expect(m.imageUrl("ipfs://cid/logo.png")).toBe("https://ipfs.io/ipfs/cid/logo.png");
  expect(m.imageUrl("javascript:alert(1)")).toBeNull();expect(m.imageUrl("https://user:secret@example.org/logo")).toBeNull();
 });
 it("tries alternate artwork before removing a failed image",async()=>{
  const m=await load();let removed=false;
  const img={src:"https://one.org/a.png",getAttribute:()=>"https://one.org/a.png",dataset:{logoFallbacks:JSON.stringify(["https://two.org/a.png"])},remove:()=>{removed=true;}};
  m.nextLogo(img);expect(img.src).toBe("https://two.org/a.png");expect(removed).toBe(false);
  expect(m.failedUrls.has("https://one.org/a.png")).toBe(true);
  m.nextLogo(img);expect(removed).toBe(true);
 });
});
