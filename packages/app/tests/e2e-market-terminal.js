// Run against an isolated, already running local API with observed market data:
// playwright-cli --session trenches-audit run-code --filename packages/app/tests/e2e-market-terminal.js
async (page) => {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(page.url())) throw new Error("Local API required");
  const base = page.url().split("?")[0];
  await page.goto(base);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const column = page.getByRole("region", { name: "Liquidity", exact: true });
  await column.getByRole("button", { name: "Ver", exact: true }).first().waitFor();
  await column.getByRole("button", { name: "Filtros", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Liquidez mínima", exact: true }).fill("1");
  await page.getByRole("button", { name: "Aplicar filtros", exact: true }).click();
  await column.getByRole("button", { name: "Filtros activos", exact: true }).waitFor();
  const scroller = column.locator("[data-rows]");
  await scroller.evaluate((element) => { element.scrollTop = 224; });
  const scrollBefore = await scroller.evaluate((element) => element.scrollTop);
  const trigger = column.getByRole("button", { name: "Ver", exact: true }).nth(3);
  await trigger.click();
  await page.locator("#tokenTerminal").waitFor({ state: "visible" });
  if (!page.url().includes("token=")) throw new Error("Missing contract deep link");
  if (await page.locator("#executeOrderBtn").isEnabled()) throw new Error("Execution must remain disabled");
  await page.screenshot({ path: "docs/audit/2026-09-16-terminal-desktop.png" });
  await page.keyboard.press("Escape");
  await page.locator("#tokenTerminal").waitFor({ state: "hidden" });
  const scrollAfter = await scroller.evaluate((element) => element.scrollTop);
  if (scrollBefore !== scrollAfter) throw new Error(`Scroll changed: ${scrollBefore} -> ${scrollAfter}`);
  const focusRestored = await trigger.evaluate((element) => document.activeElement === element);
  if (!focusRestored) throw new Error("Trigger focus was not restored");
  await page.reload();
  await column.getByRole("button", { name: "Filtros activos", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await column.getByRole("button", { name: "Ver", exact: true }).first().click();
  await page.locator("#tokenTerminal").waitFor({ state: "visible" });
  await page.screenshot({ path: "docs/audit/2026-09-16-terminal-mobile.png" });
  const box = await page.locator("#tokenTerminal").boundingBox();
  if (!box || box.width > 390 || box.height > 844) throw new Error("Mobile terminal exceeds viewport");
  await page.goBack();
  await page.locator("#tokenTerminal").waitFor({ state: "hidden" });
  return { filtersRestored: true, scrollBefore, scrollAfter, focusRestored, mobile: box, tradingDisabled: true };
}
