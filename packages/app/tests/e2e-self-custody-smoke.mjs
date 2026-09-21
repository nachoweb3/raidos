// Public smoke check for the self-custody release on https://inusaur.online.
// Read-only: no login, no signatures, no orders.
import { chromium } from "playwright";

const results = {};
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto("https://inusaur.online/app.html", { waitUntil: "domcontentloaded", timeout: 60000 });

  // 1) The served page must carry the new module-graph version.
  const html = await page.content();
  if (!html.includes("20260917-2")) throw new Error("Served page lacks module version 20260917-2");
  results.version = "20260917-2";

  // 2) Frontend fetches capabilities from the API; solana/ethereum/base LIVE.
  const caps = await page.evaluate(async () => {
    const data = await fetch("https://raidos-api.fly.dev/api/chains").then((r) => r.json());
    return Object.fromEntries(data.chains.map((c) => [c.id, { status: c.status, liveExecution: c.liveExecution }]));
  });
  for (const id of ["solana", "ethereum", "base"]) {
    if (caps[id]?.status !== "LIVE" || caps[id]?.liveExecution !== true) throw new Error(`${id} not LIVE: ${JSON.stringify(caps[id])}`);
  }
  if (caps.bsc?.liveExecution !== false) throw new Error("bsc must stay unavailable");
  results.capabilities = caps;

  // 3) Without a logged-in session the order button must stay disabled (no fake execution).
  await page.waitForTimeout(4000); // allow modules to render
  const disabled = await page.locator("#executeOrderBtn").isDisabled();
  if (!disabled) throw new Error("Order button must be disabled without authentication");
  results.orderButtonWithoutLogin = "disabled";

  // 4) Console errors = broken module graph.
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  results.pageErrors = errors;

  await page.screenshot({ path: "output/playwright/inusaur-selfcustody-desktop.png", fullPage: false });

  // 5) Mobile pass.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto("https://inusaur.online/app.html", { waitUntil: "domcontentloaded", timeout: 60000 });
  await mobile.waitForTimeout(3000);
  const mobileDisabled = await mobile.locator("#executeOrderBtn").isDisabled();
  if (!mobileDisabled) throw new Error("Mobile order button must be disabled without authentication");
  await mobile.screenshot({ path: "output/playwright/inusaur-selfcustody-mobile.png", fullPage: false });
  results.mobile = "ok";

  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
