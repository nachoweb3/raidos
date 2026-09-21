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
    this.dialog.querySelector("[data-terminal-share]").onclick = async () => {
      const status = this.dialog.querySelector("[data-terminal-message]");
      try { await navigator.clipboard.writeText(location.href); status.textContent = "Enlace copiado"; }
      catch { status.textContent = "No se pudo copiar. Puedes copiar la URL del navegador."; }
    };
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
