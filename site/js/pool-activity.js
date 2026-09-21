import { ApiClient } from "./api.js";
import { publicPoolData } from "./public-market.js";

const short = value => value.slice(0, 5) + "…" + value.slice(-4);
const money = value => new Intl.NumberFormat("es", { style: "currency", currency: "USD", maximumSignificantDigits: 6 }).format(value);
const explorers = { solana: "https://solscan.io/tx/", ethereum: "https://etherscan.io/tx/", base: "https://basescan.org/tx/", bsc: "https://bscscan.com/tx/" };

// Markers represent observed swaps in their containing candle, not exact-price fills.
export function activityMarkers(trades, candles, interval, wallet = "") {
  const times = new Set(candles.map(row => row.time));
  const groups = new Map();
  for (const trade of trades) {
    if (wallet && trade.wallet !== wallet) continue;
    const time = Math.floor(trade.time / interval) * interval;
    if (!times.has(time)) continue;
    const key = time + ":" + trade.side;
    const group = groups.get(key) || { time, side: trade.side, count: 0 };
    group.count++; groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.time - b.time || a.side.localeCompare(b.side)).map(row => ({
    time: row.time, position: row.side === "buy" ? "belowBar" : "aboveBar",
    color: row.side === "buy" ? "#87dded" : "#f38c9a", shape: row.side === "buy" ? "arrowUp" : "arrowDown",
    text: wallet ? (row.side === "buy" ? "C" : "V") : "", size: .7,
  }));
}

export class PoolActivity {
  constructor(tools) {
    this.tools = tools; this.root = document.getElementById("poolActivity");
    this.trades = []; this.sequence = 0; this.wallet = "";
    this.root.innerHTML = `<header><div><h3>Radar de wallets</h3><p data-summary role="status">Selecciona un pool para explorar sus operaciones.</p></div><button type="button" data-refresh>Actualizar</button></header>
      <div class="activity-controls"><label>Wallet <select data-wallet><option value="">Todas las observadas</option></select></label><label><input type="checkbox" data-markers checked> Marcas en el gráfico</label></div>
      <div class="activity-scroll"><table><caption>Operaciones recientes del pool</caption><thead><tr><th>Hora</th><th>Wallet</th><th>Operación</th><th>Precio</th><th>Volumen</th><th>Tx</th></tr></thead><tbody></tbody></table></div>
      <p class="activity-note">Muestra reciente del pool vía GeckoTerminal. Una compra o venta no demuestra la apertura o cierre completo de una posición. Las flechas agrupan operaciones por vela; el precio exacto aparece en la tabla.</p>`;
    this.root.querySelector("[data-wallet]").onchange = event => { this.wallet = event.target.value; this.render(); };
    this.root.querySelector("[data-markers]").onchange = () => this.mark();
    this.root.querySelector("[data-refresh]").onclick = () => this.refresh();
  }
  stop() { this.sequence++; clearTimeout(this.timer); this.context = null; this.trades = []; this.wallet = ""; this.meta = ""; this.render(); }
  start(chain, pool, token, interval) {
    this.stop(); this.context = { chain, pool, token, interval }; this.refresh();
  }
  async refresh() {
    if (!this.context || this.loading) return;
    clearTimeout(this.timer);
    if (document.hidden) { this.timer = setTimeout(() => this.refresh(), 30000); return; }
    const context = this.context, sequence = this.sequence;
    this.loading = true; this.root.querySelector("[data-refresh]").disabled = true;
    try {
      const query = new URLSearchParams({ chain: context.chain, pool: context.pool, token: context.token });
      const result = await ApiClient.request("/api/market/trades?" + query).catch(() =>
        publicPoolData("trades", context.chain, context.pool, context.token));
      if (sequence !== this.sequence) return;
      this.trades = result.trades || [];
      this.meta = `${result.status === "DEGRADED" ? "Caché" : "Observado"} · ${new Date(result.asOf).toLocaleTimeString()}`;
      this.render();
    } catch {
      if (sequence !== this.sequence) return;
      this.trades = []; this.render();
      this.root.querySelector("[data-summary]").textContent = "Actividad no disponible. Puedes volver a intentarlo.";
    } finally {
      this.loading = false; this.root.querySelector("[data-refresh]").disabled = false;
      if (this.context) this.timer = setTimeout(() => this.refresh(), sequence === this.sequence ? 30000 : 0);
    }
  }
  mark() {
    this.tools.setMarkers(this.context && this.root.querySelector("[data-markers]").checked
      ? activityMarkers(this.trades, this.tools.data, this.context.interval, this.wallet) : []);
  }
  render() {
    const select = this.root.querySelector("[data-wallet]");
    const wallets = [...new Set(this.trades.map(row => row.wallet))];
    if (!wallets.includes(this.wallet)) this.wallet = "";
    select.replaceChildren(new Option("Todas las observadas", ""), ...wallets.map(wallet => new Option(short(wallet), wallet)));
    select.value = this.wallet;
    const rows = this.wallet ? this.trades.filter(row => row.wallet === this.wallet) : this.trades;
    this.root.querySelector("[data-summary]").textContent = this.context
      ? `${wallets.length} wallets · ${this.trades.length} operaciones · ${this.meta || "Consultando…"}` : "Selecciona un pool para explorar sus operaciones.";
    const body = this.root.querySelector("tbody"); body.replaceChildren();
    for (const trade of rows) {
      const tr = document.createElement("tr"); tr.dataset.side = trade.side;
      const values = [new Date(trade.time * 1000).toLocaleTimeString(), short(trade.wallet), trade.side === "buy" ? "Compra" : "Venta", money(trade.priceUsd), money(trade.volumeUsd)];
      values.forEach((value, i) => {
        const td = document.createElement("td");
        if (i === 1) { const button = document.createElement("button"); button.textContent = value; button.title = trade.wallet; button.onclick = () => { this.wallet = trade.wallet; this.render(); }; td.append(button); }
        else td.textContent = value;
        tr.append(td);
      });
      const td = document.createElement("td"), base = explorers[trade.chain];
      if (base) { const a = document.createElement("a"); a.href = base + encodeURIComponent(trade.txHash); a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = "Ver"; a.setAttribute("aria-label", "Ver transacción " + trade.txHash); td.append(a); }
      else td.textContent = "—";
      tr.append(td); body.append(tr);
    }
    if (!rows.length) { const tr = document.createElement("tr"), td = document.createElement("td"); td.colSpan = 6; td.textContent = "Sin operaciones disponibles en esta muestra."; tr.append(td); body.append(tr); }
    this.mark();
  }
}
