import { afterEach, describe, it, expect } from "vitest";
import { ApiServer } from "../src/api/server.js";
let server: ApiServer;
afterEach(async () => { await server?.stop(); });
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==";
async function setup() {
  server = new ApiServer({dbPath: ":memory:", port: 0, siteDir: null, appMode: "mock"});
  const base = "http://127.0.0.1:" + await server.start();
  const {apiKey} = await (await fetch(base + "/api/auth/register", {method:"POST", body:"{}"})).json();
  return {base, headers: {Authorization: "Bearer " + apiKey, "Content-Type": "application/json"}};
}
describe("hosted token metadata", () => {
  it("publishes an immutable JSON and gallery image with four social links", async () => {
    const {base, headers} = await setup();
    const socials = ["https://x.com/token","https://t.me/token","https://discord.gg/token","https://instagram.com/token"];
    const body = JSON.stringify({name:"Token",symbol:"TKN",description:"Community token",image,socials});
    const response = await fetch(base + "/api/launchlab/metadata", {method:"POST",headers,body});
    expect(response.status).toBe(201);
    const data = await response.json();
    const metadata = await (await fetch(base + new URL(data.uri).pathname)).json();
    expect(metadata.name).toBe("Token");
    expect(metadata.extensions.socials).toEqual(socials);
    const photo = await fetch(base + new URL(metadata.image).pathname);
    expect(photo.headers.get("content-type")).toBe("image/png");
    expect((await photo.arrayBuffer()).byteLength).toBeGreaterThan(20);
    const again = await (await fetch(base + "/api/launchlab/metadata",{method:"POST",headers,body})).json();
    expect(again.uri).toBe(data.uri);
  });
  it("rejects unauthenticated uploads, a fifth social link, unsafe URLs and fake images", async () => {
    const {base,headers} = await setup();
    expect((await fetch(base + "/api/launchlab/metadata",{method:"POST",body:"{}"})).status).toBe(401);
    for (const extra of [{socials:Array(5).fill("https://x.com/token")},{socials:["javascript:alert(1)"]},{image:"data:image/png;base64,PGh0bWw+"}]) {
      const response = await fetch(base + "/api/launchlab/metadata",{method:"POST",headers,body:JSON.stringify({name:"Token",symbol:"TKN",image,...extra})});
      expect(response.status).toBe(400);
    }
  });
});
