async (page) => {
  // Public read-only journey; no wallet connection or transaction signing.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.waitForFunction(() => window.TradingEngine?.poolActivity?.trades.length > 0, { timeout: 45000 });
  const before = await page.evaluate(() => ({ candles: window.TradingEngine.chartTools.data.length, trades: window.TradingEngine.poolActivity.trades.length, markers: window.TradingEngine.chartTools.markers.length }));
  if (!before.candles || !before.markers) throw Error("Expected real candles and chart markers");
  const filter = page.getByRole("combobox", { name: "Wallet", exact: true });
  await filter.selectOption({ index: 1 });
  const filtered = await page.evaluate(() => {
    const activity = window.TradingEngine.poolActivity;
    return { selected: activity.wallet, expected: activity.trades.filter(t => t.wallet === activity.wallet).length,
      rendered: document.querySelectorAll("#poolActivity tbody tr").length };
  });
  if (!filtered.selected || filtered.expected !== filtered.rendered) throw Error("Wallet filter failed");
  await page.getByRole("checkbox", { name: "Marcas en el gráfico" }).uncheck();
  if (await page.evaluate(() => window.TradingEngine.chartTools.markers.length)) throw Error("Markers not hidden");
  await page.getByRole("checkbox", { name: "Marcas en el gráfico" }).check();
  await filter.selectOption("");
  await page.screenshot({ path: "output/playwright/radar-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.locator("#tokenTerminal").evaluate(el => el.scrollWidth > el.clientWidth + 1);
  if (overflow) throw Error("Mobile terminal overflows horizontally");
  await page.getByRole("heading", { name: "Radar de wallets" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/playwright/radar-mobile.png" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (await page.locator(".terminal-atmosphere").isVisible()) throw Error("Reduced motion not respected");
  await page.keyboard.press("Escape");
  await page.locator("#tokenTerminal").waitFor({ state: "hidden" });
  if (await page.evaluate(() => window.TradingEngine.poolActivity.context !== null)) throw Error("Polling not stopped");
  console.log(JSON.stringify({ before, filtered, mobileOverflow: overflow, reducedMotion: true, closeStopsPolling: true }));
}
