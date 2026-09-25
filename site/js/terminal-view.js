import { ApiClient } from "./api.js";
import { DexFeed } from "./dexfeed.js";

// Keep the board mounted: opening a token never replaces its lists or scroll.
export const TerminalView = {
  init() {
    if (this.dialog) return;
    this.dialog = document.getElementById("tokenTerminal");
    if (!this.dialog) return;
    document.body.appendChild(this.dialog);
    this.dialog.querySelector("[data-terminal-close]").onclick = () => this.close();
    this.dialog.addEventListener("cancel", (event) => { event.preventDefault(); this.close(); });
    window.addEventListener("popstate", () => this.restore());
    this.dialog.querySelector("[data-terminal-share]").onclick = () => this.shareTerminal();
    this.restore();
  },
  show() {
    if (this.dialog.open) return;
    this.focusBefore = document.activeElement;
    this.focusColumn = this.focusBefore?.closest("[data-catalog-column]");
    this.focusAction = this.focusBefore?.getAttribute("onclick");
    this.scrollBefore = [window.scrollX, window.scrollY];
    this.overflowBefore = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    this.dialog.showModal();
    window.TradingEngine?.initChart();
    clearInterval(this.chartTimer);
    this.chartTimer = setInterval(() => {
      if (this.dialog.open && !document.hidden) window.TradingEngine?.fetchRealCandles(true);
    }, 60000);
    window.dispatchEvent(new Event("resize"));
  },
  open(symbol, chain, price, address) {
    this.init();
    const url = new URL(location.href);
    url.searchParams.set("tokenChain", chain);
    if (address) { url.searchParams.set("token", address); url.searchParams.delete("reference"); }
    else { url.searchParams.set("reference", symbol); url.searchParams.delete("token"); }
    const method = this.dialog.open ? "replaceState" : "pushState";
    history[method]({ ...history.state, trenchesTerminal: true }, "", url);
    this.sequence = (this.sequence || 0) + 1;
    this.show();
    this.dialog.querySelector("[data-terminal-message]").textContent = address ? "" : "Referencia por símbolo: selecciona un contrato para identificar el activo.";
    window.TradingEngine?.setAsset(symbol, chain, price, { tokenAddress: address });
  },
  async restore() {
    const url = new URL(location.href), address = url.searchParams.get("token"), reference = url.searchParams.get("reference"), chain = url.searchParams.get("tokenChain");
    const sequence = this.sequence = (this.sequence || 0) + 1;
    if (!chain || (!address && !reference)) { this.hide(); return; }
    this.show();
    const status = this.dialog.querySelector("[data-terminal-message]");
    window.TradingEngine?.setAsset(reference || "TOKEN", chain, 0, { tokenAddress: address });
    if (!address) { status.textContent = "Referencia por símbolo; contrato no identificado."; return; }
    status.textContent = "Consultando contrato…";
    try {
      const result = await ApiClient.request("/api/market/import", { method: "POST", body: JSON.stringify({ chain, address }) });
      if (sequence !== this.sequence) return;
      const row = DexFeed._rows(result.pairs)[0];
      if (!row) throw new Error("No se encontró un pool observado");
      window.TradingEngine?.setAsset(row.symbol, chain, row.priceUsd, { tokenAddress: address });
      status.textContent = "Pool observado; ruta de trading sin verificar.";
    } catch {
      if (sequence === this.sequence) status.textContent = "Contrato sin datos disponibles. No se ha verificado una ruta de mercado.";
    }
  },
  close() {
    if (history.state?.trenchesTerminal) { history.back(); return; }
    const url = new URL(location.href);
    for (const key of ["token", "tokenChain", "reference"]) url.searchParams.delete(key);
    history.replaceState(history.state, "", url);
    this.hide();
  },

  /* ── 📤 Share: chart image + deep link ─────────────────────────────── */

  /**
   * Share the current terminal: composes a shareable banner (chart + price +
   * branding) from the real Lightweight Charts canvas and shares it with the
   * native sheet on mobile (files + link) or downloads + copies the link on
   * desktop. Without a rendered chart it degrades to link-only sharing.
   */
  async shareTerminal() {
    const status = this.dialog.querySelector("[data-terminal-message]");
    const trading = window.TradingEngine;
    const symbol = trading?.currentSymbol || "TOKEN";
    const chain = trading?.currentChain || "solana";
    const price = document.getElementById("terminalPrice")?.textContent || "—";
    const delta = document.getElementById("terminalDelta")?.textContent || "";
    const link = location.href;
    try {
      const canvas = trading?.chart?.takeScreenshot?.();
      if (!canvas) throw new Error("no-chart");
      const blob = await new Promise((resolve) => this.composeShareImage(canvas, { symbol, chain, price, delta }).toBlob(resolve, "image/png"));
      if (!blob) throw new Error("no-blob");
      const file = new File([blob], `trenches-${symbol.toLowerCase()}-${chain}.png`, { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `${symbol} · TRENCHES`, text: `${symbol} ${price} ${delta}\n${link}` });
        status.textContent = "Compartido";
        return;
      }
      // Desktop fallback: download the image + copy the deep link.
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      await navigator.clipboard.writeText(link).catch(() => {});
      status.textContent = "Imagen descargada + enlace copiado";
    } catch (e) {
      if (e?.name === "AbortError") { status.textContent = ""; return; }
      // No chart or composition failed → honest link-only share.
      try {
        if (navigator.share) { await navigator.share({ title: `${symbol} · TRENCHES`, url: link }); status.textContent = "Compartido"; return; }
        throw new Error("no-share");
      } catch (e2) {
        if (e2?.name === "AbortError") { status.textContent = ""; return; }
        try { await navigator.clipboard.writeText(link); status.textContent = "Enlace copiado"; }
        catch { status.textContent = "No se pudo compartir. Copia la URL del navegador."; }
      }
    }
  },

  /** Chart + header/footer bars into one banner canvas (real data only). */
  composeShareImage(chartCanvas, { symbol, chain, price, delta }) {
    const W = 1000;
    const topH = 96, bottomH = 56;
    const chartW = W - 48;
    const chartH = Math.round((chartCanvas.height / chartCanvas.width) * chartW);
    const out = document.createElement("canvas");
    out.width = W;
    out.height = topH + chartH + bottomH;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#0b1221";
    ctx.fillRect(0, 0, W, out.height);
    // Top bar: brand + asset + price (real values from the terminal).
    ctx.fillStyle = "#4ade80";
    ctx.font = "800 26px system-ui, sans-serif";
    ctx.fillText("TRENCHES", 24, 40);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "600 16px system-ui, sans-serif";
    ctx.fillText(chain.toUpperCase(), 24, 68);
    ctx.fillStyle = "#ffffff";
    ctx.font = "800 30px system-ui, sans-serif";
    ctx.fillText(`${symbol} / USDC`, 190, 48);
    ctx.textAlign = "right";
    ctx.font = "700 26px ui-monospace, monospace";
    ctx.fillText(price, W - 24, 44);
    if (delta) {
      ctx.font = "700 18px ui-monospace, monospace";
      ctx.fillStyle = delta.trim().startsWith("-") ? "#f87171" : "#4ade80";
      ctx.fillText(delta, W - 24, 72);
    }
    ctx.textAlign = "left";
    // Chart (real screenshot) centered with margin.
    ctx.drawImage(chartCanvas, 24, topH, chartW, chartH);
    // Bottom bar: domain + honesty note.
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "600 15px ui-monospace, monospace";
    ctx.fillText("inusaur.online · gráfico on-chain en vivo", 24, out.height - 22);
    ctx.textAlign = "right";
    ctx.fillText("datos reales, sin custodia", W - 24, out.height - 22);
    return out;
  },
  hide() {
    clearInterval(this.chartTimer);
    this.sequence = (this.sequence || 0) + 1;
    if (!this.dialog?.open) return;
    window.App?.closeNewPostModal();
    this.dialog.close();
    window.TradingEngine?.poolActivity?.stop();
    if (window.TradingEngine) { window.TradingEngine._candleRequest++; window.TradingEngine._chartAbort?.abort(); }
    document.body.style.overflow = this.overflowBefore || "";
    const replacement = this.focusAction && this.focusColumn?.isConnected
      ? [...this.focusColumn.querySelectorAll("button")].find((button) => button.getAttribute("onclick") === this.focusAction) : null;
    const focus = this.focusBefore?.isConnected ? this.focusBefore : replacement || document.getElementById("trenchesSearch");
    focus?.focus({ preventScroll: true });
    if (this.scrollBefore) window.scrollTo({ left: this.scrollBefore[0], top: this.scrollBefore[1], behavior: "instant" });
  },
};
