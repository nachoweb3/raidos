import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";

it("escapes profile content in leaderboard HTML and handler attributes", async () => {
  const context = createContext({ localStorage: { getItem: () => null } });
  const module = new SourceTextModule(readFileSync(new URL("../../../site/js/social.js", import.meta.url), "utf8"), { context });
  await module.link(async () => new SyntheticModule(["ApiClient"], function () { this.setExport("ApiClient", { isAuthenticated: () => false }); }, { context }));
  await module.evaluate();
  const social = (module.namespace as any).SocialEngine;
  social.container = { innerHTML: "" };
  social.leaders = social.mapLeaders([{ user_id: 1, display_name: '<img src=x onerror="alert(1)">', total_pnl_usdc: "0" }]);
  social.render();
  expect(social.container.innerHTML).not.toContain('<img src=x');
  expect(social.container.innerHTML).toContain('&lt;img');
});
