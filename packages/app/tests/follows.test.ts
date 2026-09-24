import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiServer } from "../src/api/server.js";
import { generateApiKey } from "../src/api/auth.js";

describe("follow graph (persisted)", () => {
  let server: ApiServer;
  let base = "";
  let seq = 1;

  beforeAll(async () => {
    server = new ApiServer({ dbPath: ":memory:", siteDir: null, port: 0, appMode: "live" });
    const port = await server.start();
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => { await server.stop(); });

  function mkUser(): { id: number; key: string } {
    const { apiKey, keyHash } = generateApiKey();
    const id = 91_000_000 + seq++;
    server.db.createUser(id, keyHash);
    return { id, key: apiKey };
  }

  function setHandle(userId: number, handle: string) {
    server.db.ensureProfile(userId);
    server.db.updateProfile(userId, { xHandle: handle });
  }

  const auth = (key: string) => ({ "Content-Type": "application/json", Authorization: "Bearer " + key });

  it("401 without auth; 404 for unknown target; 400 for self-follow", async () => {
    const a = mkUser();
    const b = mkUser();

    const anon = await fetch(base +  `/api/users/${b.id}/follow`, { method: "POST" });
    expect(anon.status).toBe(401);

    const missing = await fetch(base +  `/api/users/424242/follow`, { method: "POST", headers: auth(a.key) });
    expect(missing.status).toBe(404);

    const self = await fetch(base +  `/api/users/${a.id}/follow`, { method: "POST", headers: auth(a.key) });
    expect(self.status).toBe(400);
  });

  it("follow → isFollowing true, followersCount increments, idempotent repeat does not double", async () => {
    const a = mkUser();
    const b = mkUser();

    const first = await (await fetch(base +  `/api/users/${b.id}/follow`, { method: "POST", headers: auth(a.key) })).json() as any;
    expect(first).toMatchObject({ following: true, created: true, followersCount: 1 });

    const repeat = await (await fetch(base +  `/api/users/${b.id}/follow`, { method: "POST", headers: auth(a.key) })).json() as any;
    expect(repeat).toMatchObject({ following: true, created: false, followersCount: 1 });

    const state = await (await fetch(base +  `/api/users/${b.id}/follow`, { headers: auth(a.key) })).json() as any;
    expect(state).toEqual({ following: true });
  });

  it("unfollow removes and decrements; repeating unfollow reports removed:false", async () => {
    const a = mkUser();
    const b = mkUser();
    await fetch(base +  `/api/users/${b.id}/follow`, { method: "POST", headers: auth(a.key) });

    const del = await (await fetch(base +  `/api/users/${b.id}/follow`, { method: "DELETE", headers: auth(a.key) })).json() as any;
    expect(del).toMatchObject({ following: false, removed: true, followersCount: 0 });

    const del2 = await (await fetch(base +  `/api/users/${b.id}/follow`, { method: "DELETE", headers: auth(a.key) })).json() as any;
    expect(del2).toMatchObject({ following: false, removed: false, followersCount: 0 });
  });

  it("follow listings use the canonical actor shape (x_handle when present)", async () => {
    const a = mkUser();
    const b = mkUser();
    setHandle(b.id, "satoshi");
    await fetch(base +  `/api/users/${b.id}/follow`, { method: "POST", headers: auth(a.key) });

    const following = await (await fetch(base +  `/api/users/${a.id}/following`, { headers: auth(a.key) })).json() as any;
    expect(following.following).toHaveLength(1);
    expect(following.following[0]).toMatchObject({ userId: b.id, handle: "@satoshi", displayName: "@satoshi" });    const followers = await (await fetch(base + `/api/users/${b.id}/followers`)).json() as any;
    expect(followers.followers).toHaveLength(1);
    expect(followers.followers[0]).toMatchObject({ userId: a.id, handle: `@trader_${a.id}` });
  });

  it("listings accept 'me' as the authenticated user; anonymous 'me' is 401", async () => {
    const a = mkUser();
    const b = mkUser();
    await fetch(base + `/api/users/${b.id}/follow`, { method: "POST", headers: auth(a.key) });

    const mine = await (await fetch(base + `/api/users/me/following`, { headers: auth(a.key) })).json() as any;
    expect(mine.following).toHaveLength(1);
    expect(mine.following[0].userId).toBe(b.id);

    const anon = await fetch(base + `/api/users/me/following`);
    expect(anon.status).toBe(401);
  });

  it("feed ?actorIds= returns only events from the given actors; junk degrades to no filter", async () => {
    const a = mkUser();
    const b = mkUser();
    const eA = await fetch(base +  "/api/feed/post", { method: "POST", headers: auth(a.key), body: JSON.stringify({ text: "tesis de A" }) });
    expect(eA.status).toBe(201);
    const eB = await fetch(base +  "/api/feed/post", { method: "POST", headers: auth(b.key), body: JSON.stringify({ text: "tesis de B" }) });
    expect(eB.status).toBe(201);

    const onlyA = await (await fetch(base +  `/api/feed?actorIds=${a.id}`)).json() as any;
    expect(onlyA.events.length).toBeGreaterThanOrEqual(1);
    expect(onlyA.events.every((e: any) => e.actor_id === a.id)).toBe(true);

    // B follows A: the "following" filter for B is exactly actorIds=A.
    await fetch(base +  `/api/users/${a.id}/follow`, { method: "POST", headers: auth(b.key) });
    const feed = await (await fetch(base +  `/api/feed?actorIds=${a.id}`)).json() as any;
    expect(feed.events.some((e: any) => e.actor_id === a.id)).toBe(true);
    expect(feed.events.every((e: any) => e.actor_id === a.id)).toBe(true);

    const junk = await fetch(base +  `/api/feed?actorIds=abc,,0`);
    expect(junk.status).toBe(200);
  });
});
