/** Market terminal: real provider OHLC, settled backend positions, explicit execution capability. */

import { ApiClient } from "./api.js";
import { PriceFeed } from "./discover.js";
import { TokenMeta } from "./tokens.js";
import { DexFeed } from "./dexfeed.js";
import { ChartTools } from "./chart-tools.js";
import { PoolActivity } from "./pool-activity.js";
import { publicPoolData } from "./public-market.js";
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Canonical addresses for the handful of tokens that need no lookup. */
const WELL_KNOWN_ADDR = {
  solana: { USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", SOL: "So11111111111111111111111111111111111111112" },
  ethereum: { USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  base: { USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  bsc: { USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" },
};

export const TradingEngine = {
  currentSymbol: "SOL",
  currentChain: "solana",
  currentTokenAddress: null, // real trade routing needs addresses, not symbols
  currentPrice: 0,
  currentDelta24h: 0,
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  chartType: "candle", // 'candle' | 'line'
  orderSide: "BUY", // 'BUY' | 'SELL'
  tradeType: "MARKET", // 'MARKET' | 'LIMIT'
  leverage: 1,
  positions: [],
  orders: [],
  chartInterval: 300, // seconds; matches common Candle UI (used for request size)
  lastCandleFetch: 0,
  chainCapabilities: null, // /api/chains cache: { [chainId]: { liveExecution, status, ... } }

  /** Cache real execution capabilities so the order button never lies. */
  async refreshCapabilities() {
    try {
      const data = await ApiClient.getChains();
      const map = {};
      for (const row of data?.chains ?? []) map[row.id] = row;
      this.chainCapabilities = map;
    } catch {
      // Unknown capabilities keep every order button disabled (fail closed).
      this.chainCapabilities = this.chainCapabilities || {};
    }
    this.updateTokenDisplay();
  },

  /** Best current real price for the active symbol from PriceFeed. */
  async refreshPrice() {
    const row = this.currentTokenAddress ? DexFeed.get(this.currentTokenAddress, this.currentChain) : null;
    const reference = this.currentTokenAddress ? null : PriceFeed.get(this.currentSymbol);
    this.currentPrice = row?.priceUsd ?? reference?.price ?? 0;
    this.currentDelta24h = row?.change24h ?? reference?.delta24h ?? null;
    this.updateTokenDisplay();
  },

  init() {
    this.initChart();
    this.refreshCapabilities();
    this.refreshPrice().then(async () => {
      if (ApiClient.isAuthenticated()) {
        await this.fetchPendingTrades();
        await this.fetchPositions();
      }
    });
    this.updateTokenDisplay();
    // ⏱ LIVE PnL: re-price open positions every 5s from real pair data
    // (DexFeed by address, PriceFeed by ticker fallback). Client-side view
    // only — realized PnL from the backend is never overwritten.
    if (!this._pnlTimer) {
      this._pnlTimer = setInterval(() => {
        if (document.visibilityState === "visible" && this.positions.length) {
          this.tickPositionPnl();
        }
      }, 5_000);
    }
  },

  /** Settled PnL remains the backend value; unverified mark-to-market is not calculated here. */
  tickPositionPnl() { this.renderPositions(); },

  setAsset(symbol, chain, price, opts = {}) {
    this.currentSymbol = String(symbol ?? "").toUpperCase();
    this.currentChain = chain || "solana";
    this.currentTokenAddress = opts.tokenAddress || null;
    const dex = this.currentTokenAddress ? DexFeed.get(this.currentTokenAddress, this.currentChain) : null;
    const reference = this.currentTokenAddress ? null : PriceFeed.get(this.currentSymbol);
    const passed = Number(price);
    this.currentPrice = passed > 0 ? passed : dex?.priceUsd ?? reference?.price ?? 0;
    this.currentDelta24h = dex?.change24h ?? reference?.delta24h ?? null;
    this.updateTokenDisplay();
    this.generateCandleData();
    this.loadTheses();
  },

  /* ── 📊 Tesis de la comunidad (panel lateral del terminal) ───────────── */

  /** Fetch theses for the active token from the public feed. */
  async loadTheses() {
    const el = document.getElementById("terminalThesisList");
    if (!el) return;
    const key = this.currentTokenAddress || this.currentSymbol;
    try {
      const data = await ApiClient.request(`/api/feed?token=${encodeURIComponent(key)}&limit=8`);
      const events = (data?.events ?? []).filter((e) => e.type === "post" || e.type === "thesis");
      if (!events.length) {
        el.innerHTML = `<div style="color:var(--text-tertiary); font-size:11px; line-height:1.5">
          Sin tesis todavía para <strong>${esc(this.currentSymbol)}</strong>. Sé el primero:
          <a href="#" onclick="window.TradingEngine.openThesisComposer(); return false" style="color:var(--accent)">publica la tuya</a>.
        </div>`;
        return;
      }
      el.innerHTML = events.map((e) => {
        const p = e.payload ?? {};
        const name = e.actor_name || p.authorName || "trader";
        const text = String(p.text ?? "").slice(0, 140);
        return `
        <div style="background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:8px; padding:8px 10px">
          <div style="display:flex; justify-content:space-between; gap:8px; margin-bottom:3px">
            <strong style="font-size:11px; color:#fff">${this._esc(name)}</strong>
            <span style="font-size:9.5px; color:var(--text-tertiary)">${this._age(e.created_at)}</span>
          </div>
          <div style="font-size:11px; color:var(--text-secondary); line-height:1.45">${this._esc(text)}</div>
        </div>`;
      }).join("");
    } catch {
      el.innerHTML = `<div style="color:var(--text-tertiary); font-size:11px">No se pudieron cargar las tesis.</div>`;
    }
  },

  /** Open the thesis composer pre-filled with the ACTIVE terminal token. */
  openThesisComposer() {
    window.App?.openNewPostModal({
      token: this.currentTokenAddress || this.currentSymbol,
      symbol: this.currentSymbol,
      chain: this.currentChain,
      price: this.currentPrice,
      imageUrl: null,
    });
  },

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  },

  _age(ts) {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts ?? 0));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  },

  /**
   * Resolve the active token to a routable address for Jupiter/0x:
   * explicit address → DexFeed pair cache → well-known tokens (USDC/SOL…).
   */
  resolveTokenAddress(symbol, chain) {
    const sym = String(symbol ?? "").toUpperCase();
    if (sym === "USDC") {
      return WELL_KNOWN_ADDR[chain || "solana"]?.USDC;
    }
    if (sym === "SOL" && (chain || "solana") === "solana") {
      return "So11111111111111111111111111111111111111112"; // wrapped SOL
    }
    return (
      this.currentTokenAddress ||
      null
    );
  },

  /**
   * ⚡ One-click market buy from Trenches: 0.1 USDC → token, routed by real
   * address through the normal execution path. Returns the exec result.
   */
  async submitSelfCustodyTrade(tradeParams, walletAddress) {
    const capabilities = await ApiClient.request("/api/chains");
    const chain = capabilities.chains?.find((row) => row.id === tradeParams.fromChain);
    if (capabilities.mode !== "live" || !chain?.liveExecution || chain.status !== "LIVE") {
      throw new Error("Trading no disponible en esta red: UNAVAILABLE");
    }
    const prepared = await ApiClient.prepareSelfCustodyTrade(tradeParams, walletAddress);
    const tx = prepared.unsignedTransaction;
    if (tx.kind === "solana") {
      if (!window.solana?.signAndSendTransaction) throw new Error("Phantom no disponible para firmar esta operación");
      const { VersionedTransaction } = await import("https://esm.sh/@solana/web3.js@1.98.4");
      const raw = Uint8Array.from(atob(tx.serialized), (char) => char.charCodeAt(0));
      const unsigned = VersionedTransaction.deserialize(raw);
      const signed = await window.solana.signAndSendTransaction(unsigned);
      return ApiClient.submitSelfCustodyTrade(prepared.sessionId, signed.signature);
    }
    if (!window.ethereum) throw new Error("MetaMask no disponible para firmar esta operación");
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    const expected = `0x${Number(tx.chainId).toString(16)}`;
    if (String(chainId).toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`Cambia MetaMask a la red correcta (chainId ${tx.chainId})`);
    }
    const from = walletAddress;
    const txHash = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{ from, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value || "0").toString(16)}`, ...(tx.gas ? { gas: `0x${BigInt(tx.gas).toString(16)}` } : {}) }],
    });
    return ApiClient.submitSelfCustodyTrade(prepared.sessionId, txHash);
  },

  async quickMarketBuy(t) {
    this.setAsset(t.symbol, t.chain, t.priceUsd, { tokenAddress: t.tokenAddress });
    this.orderSide = "BUY";
    this.currentTokenAddress = t.tokenAddress || null;
    const addr = this.resolveTokenAddress(t.symbol, t.chain);
    if (!addr) {
      window.App?.openTradeForToken?.(t.symbol, t.chain, t.priceUsd);
      alert("No se pudo resolver la dirección on-chain de " + t.symbol + " — usa el terminal.");
      return null;
    }
    // Capability gate mirrors executeTrade: no wallet prompt on disabled chains.
    const chain = this.chainCapabilities?.[t.chain || this.currentChain];
    if (!chain?.liveExecution || chain.status !== "LIVE") {
      alert("Ejecución real no disponible en " + String(t.chain || this.currentChain).toUpperCase() + " todavía.");
      return null;
    }
    try {
      const walletAddress = t.chain === "solana"
        ? window.solana?.publicKey?.toString()
        : (await window.ethereum?.request({ method: "eth_accounts" }))?.[0];
      if (!walletAddress) throw new Error("Conecta tu wallet antes de operar");
      const exec = await this.submitSelfCustodyTrade({
        fromChain: t.chain || "solana",
        toChain: t.chain || "solana",
        sellToken: "USDC",
        buyToken: addr,
        amount: "100000", // 0.1 USDC in micro-units
        type: "swap",
      }, walletAddress);
      alert(`⚡ Comprado ${t.symbol} por 0.1 USDC (tx: ${String(exec?.result?.txHash ?? exec?.txHash ?? "ok").slice(0, 12)}…)`);
      this.fetchPositions();
      return exec;
    } catch (err) {
      alert("❌ " + String(err?.message || err));
      return null;
    }
  },

  updateTokenDisplay() {
    const symEl = document.getElementById("terminalSymbol");
    const chainEl = document.getElementById("terminalChain");
    const priceEl = document.getElementById("terminalPrice");
    const deltaEl = document.getElementById("terminalDelta");
    const orderBtn = document.getElementById("executeOrderBtn");
    const logoEl = document.getElementById("terminalLogo");
    if (logoEl) logoEl.innerHTML = TokenMeta.logoHtml(this.currentSymbol, { size: 44 });

    if (symEl) symEl.textContent = `${this.currentSymbol} / USDC`;
    if (chainEl) chainEl.textContent = this.currentChain.toUpperCase();
    const contractEl = document.getElementById("terminalContract");
    if (contractEl) contractEl.textContent = this.currentTokenAddress || "Activo de referencia";
    if (priceEl) {
      priceEl.textContent =
        this.currentPrice > 0 && this.currentPrice < 0.01
          ? "$" + this.currentPrice.toLocaleString(undefined, { maximumSignificantDigits: 6 })
          : this.currentPrice > 0
            ? "$" + this.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })
            : "—";
    }
    if (deltaEl) {
      const isUp = this.currentDelta24h >= 0;
      deltaEl.textContent = this.currentDelta24h == null ? "—" : `${isUp ? "+" : ""}${this.currentDelta24h.toFixed(2)}% 24h`;
      deltaEl.style.color = isUp ? "var(--delta-green)" : "var(--delta-red)";
    }
    if (orderBtn) {
      const chain = this.chainCapabilities?.[this.currentChain];
      const executable = Boolean(chain?.liveExecution && chain.status === "LIVE" && this.currentTokenAddress);
      orderBtn.disabled = !executable;
      orderBtn.textContent = executable
        ? (this.orderSide === "BUY" ? `Comprar ${this.currentSymbol} con USDC` : `Vender ${this.currentSymbol} por USDC`)
        : "Ejecución no disponible en esta red";
      orderBtn.className = `btn btn-lg ${this.orderSide === "BUY" ? "btn-primary" : "btn-secondary"}`;
      if (this.orderSide === "SELL") {
        orderBtn.style.background = "var(--delta-red)";
        orderBtn.style.color = "#ffffff";
        orderBtn.style.borderColor = "var(--delta-red)";
      } else {
        orderBtn.style.background = "#ffffff";
        orderBtn.style.color = "#000000";
      }
    }
  },

  initChart() {
    const container = document.getElementById("tvChartContainer");
    if (!container || typeof window.LightweightCharts === "undefined") return;
    if (this.chart) {
      this.chart.applyOptions({ width: container.clientWidth || 600 });
      return;
    }

    container.innerHTML = "";
    this.chart = window.LightweightCharts.createChart(container, {
      width: container.clientWidth || 600,
      height: 380,
      layout: {
        background: { color: "transparent" },
        textColor: "#71717a",
        fontSize: 11,
        fontFamily: "'SF Mono', monospace",
      },
      grid: {
        vertLines: { color: "rgba(255, 255, 255, 0.03)" },
        horzLines: { color: "rgba(255, 255, 255, 0.03)" },
      },
      rightPriceScale: {
        borderColor: "rgba(255, 255, 255, 0.08)",
      },
      timeScale: {
        borderColor: "rgba(255, 255, 255, 0.08)",
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: "rgba(255, 255, 255, 0.2)", width: 1, style: 2 },
        horzLine: { color: "rgba(255, 255, 255, 0.2)", width: 1, style: 2 },
      },
    });

    this.candleSeries = this.chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    this.chartTools = new ChartTools(this.chart, this.candleSeries, window.LightweightCharts);
    this.poolActivity = new PoolActivity(this.chartTools);
    this.generateCandleData();

    window.addEventListener("resize", () => {
      if (this.chart && container) {
        this.chart.applyOptions({ width: container.clientWidth });
      }
    });
  },

  /** Real pool OHLCV for any resolved token; reference OHLC only for known assets. */
  async fetchRealCandles(refresh = false) {
    if (!this.candleSeries) return [];
    const request = this._candleRequest = (this._candleRequest || 0) + 1;
    const chain = this.currentChain, symbol = this.currentSymbol, address = this.currentTokenAddress, aggregate = this.chartInterval / 60;
    this._chartAbort?.abort();
    this._chartAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
    const options = this._chartAbort ? { signal: this._chartAbort.signal } : {};
    if (!refresh) { this.setChartData([]); this.poolActivity?.stop(); }
    const label = document.getElementById("chartDataStatus");
    if (label) label.textContent = "Cargando historial real...";
    try {
      let result;
      const token = address || WELL_KNOWN_ADDR[chain]?.[symbol];
      let pair = token ? DexFeed.get(token, chain) : null;
      if (token && !pair && DexFeed.ensureAddresses) {
        await DexFeed.ensureAddresses([{ address: token, chain }]);
        if (request !== this._candleRequest) return [];
        pair = DexFeed.get(token, chain);
      }
      const referenceCoin = !address ? CoinGeckoIdForSymbol(symbol)
        : chain === "solana" && token === WELL_KNOWN_ADDR.solana.SOL ? "solana" : null;
      let reference = false;
      if (pair?.pairAddress && token) {
        if (!refresh) this.poolActivity?.start(chain, pair.pairAddress, token, this.chartInterval);
        try {
          result = await ApiClient.request("/api/market/candles?chain=" + encodeURIComponent(chain) +
            "&pool=" + encodeURIComponent(pair.pairAddress) + "&token=" + encodeURIComponent(token) + "&aggregate=" + aggregate, options)
            .catch(error => { if (options.signal?.aborted) throw error; return publicPoolData("candles", chain, pair.pairAddress, token, aggregate); });
        } catch {
          if (!referenceCoin) throw new Error("No indexed pool history");
        }
      }
      if (!result?.candles?.length && referenceCoin) {
        if (request !== this._candleRequest) return [];
        reference = true;
        result = await ApiClient.request("/api/market/reference-candles?coin=" + encodeURIComponent(referenceCoin), options);
      }
      if (!result) throw new Error("No indexed pool history");
      if (request !== this._candleRequest) return [];
      const data = result.candles ?? [];
      if (!data.length) throw new Error("No real candles");
      this.setChartData(data);
      if (!refresh) this.chart?.timeScale().fitContent();
      if (reference) this.poolActivity?.stop();
      else this.poolActivity?.mark();
      this.lastCandleFetch = result.asOf;
      if (label) label.textContent = `${reference ? "Referencia 30m (sin pool)" : "Pool " + pair.pairAddress + " · " + aggregate + "m"} · ${result.source} · ${result.status === "DEGRADED" ? "Caché · " : ""}${new Date(result.asOf).toLocaleTimeString()}`;
      return data;
    } catch {
      if (request === this._candleRequest) {
        if (!refresh) this.setChartData([]);
        if (label) label.textContent = "Historial no disponible para este token";
      }
      return [];
    }
  },

  setChartData(data) {
    if (this.chartTools) this.chartTools.setData(data);
    else this.candleSeries.setData(data.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    this.poolActivity?.mark();
  },

  generateCandleData() {
    return this.fetchRealCandles();
  },

  setCandleInterval(minutes) {
    const value = Number(minutes);
    if (![1, 5, 15].includes(value)) return;
    this.chartInterval = value * 60;
    return this.fetchRealCandles();
  },

  setSide(side) {
    this.orderSide = side.toUpperCase();
    this.updateTokenDisplay();
  },

  setOrderType(type) {
    this.tradeType = type.toUpperCase();
    const limitRow = document.getElementById("limitPriceRow");
    if (limitRow) {
      limitRow.style.display = this.tradeType === "LIMIT" ? "flex" : "none";
    }
  },

  setLeverage(lev) {
    this.leverage = Number(lev);
    const label = document.getElementById("leverageVal");
    if (label) label.textContent = `${this.leverage}x`;
  },

  setAmountPercent(percent) {
    const input = document.getElementById("orderAmountInput");
    const balance = this.availableBalance();
    if (balance === null) {
      alert("Saldo no disponible. Introduce el importe manualmente.");
      return;
    }
    if (input) {
      input.value = Math.round((balance * percent) / 100);
      this.calculateEstOutput();
    }
  },

  availableBalance() {
    // Connected-wallet balances are not yet verified for this order form.
    return null;
  },

  calculateEstOutput() {
    const outputEl = document.getElementById("estReceiveAmount");
    const feeEl = document.getElementById("estFeeAmount");
    if (outputEl) outputEl.textContent = "Requiere cotización";
    if (feeEl) feeEl.textContent = "—";
  },

  /** Execute through the API; failed requests never create local positions. */
  async executeTrade() {
    const amountInput = document.getElementById("orderAmountInput");
    const amount = Number(amountInput?.value || 0);
    if (amount <= 0) {
      alert("Por favor introduce una cantidad en USDC.");
      return;
    }

    const btn = document.getElementById("executeOrderBtn");
    const originalText = btn.textContent;
    btn.textContent = "ENRUTANDO & EJECUTANDO...";
    btn.disabled = true;

    try {
      // Capability gate: never ask the wallet to sign on an unavailable chain.
      const chain = this.chainCapabilities?.[this.currentChain];
      if (!chain?.liveExecution || chain.status !== "LIVE") {
        alert("Ejecución real no disponible en " + String(this.currentChain).toUpperCase() + " todavía.");
        return;
      }
      // Route by REAL address — Jupiter/0x don't understand tickers. Well-known
      // tokens resolve to canonical addresses; everything else must have been
      // selected from a row that carries its address (Trenches/Discover).
      const buyAddr = this.resolveTokenAddress(
        this.orderSide === "BUY" ? this.currentSymbol : "USDC",
        this.currentChain,
      );
      const sellAddr = this.resolveTokenAddress(
        this.orderSide === "BUY" ? "USDC" : this.currentSymbol,
        this.currentChain,
      );
      if (!buyAddr || !sellAddr) {
        alert(
          "No hay dirección on-chain para " + this.currentSymbol +
          " en " + this.currentChain.toUpperCase() + ". Selecciónalo desde TRENCHES o DISCOVER (datos de mercado reales)."
        );
        return;
      }
      // Exact integer micro-USDC from the decimal input — no float math on money.
      const raw = String(amountInput?.value ?? "").trim();
      const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(raw);
      if (!match) {
        alert("Cantidad inválida. Usa un número en USDC con hasta 6 decimales.");
        return;
      }
      const micros = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0") || "0");
      if (micros <= 0n) {
        alert("Por favor introduce una cantidad en USDC.");
        return;
      }
      const tradeParams = {
        fromChain: this.currentChain,
        toChain: this.currentChain,
        sellToken: sellAddr,
        buyToken: buyAddr,
        amount: micros.toString(),
        type: "swap",
      };

      const walletAddress = this.currentChain === "solana"
        ? window.solana?.publicKey?.toString()
        : (await window.ethereum?.request({ method: "eth_accounts" }))?.[0];
      if (!walletAddress) throw new Error("Conecta Phantom o MetaMask antes de operar");
      const exec = await this.submitSelfCustodyTrade(tradeParams, walletAddress);
      const status = exec?.status || "pending";
      const mode = exec?.mode || "live";
      await this.fetchPositions();
      if (amountInput) amountInput.value = "";
      alert(
        status === "settled"
          ? `Orden ${this.orderSide} liquidada on-chain (mode: ${mode}).`
          : `Orden ${this.orderSide} enviada. Estado: ${status}. Se confirmará al verificar el recibo on-chain.`
      );
    } catch (err) {
      alert("❌ " + String(err?.message || err));
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  },

  async fetchPendingTrades() {
    try {
      const data = await ApiClient.getPendingTrades();
      const count = Array.isArray(data?.transactions) ? data.transactions.length : 0;
      if (count > 0) {
        const el = document.getElementById("terminalStatus");
        if (el) el.textContent = `${count} operación${count === 1 ? "" : "es"} pendiente${count === 1 ? "" : "s"}`;
      }
    } catch {
      // Pending status is advisory; positions remain API-backed only.
    }
  },

  async fetchPositions() {
    try {
      const data = await ApiClient.getPositions();
      if (data && data.positions && data.positions.length > 0) {
        this.positions = data.positions.map((p) => ({
          id: "api_pos_" + p.id,
          symbol: TokenMeta.resolveSymbol(p.token, p.token_symbol),
          chain: p.chain,
          side: "SPOT",
          sizeUsdc: Number(p.net_invested_usdc || 0) / 1e6,
          entryPrice: null,
          currentPrice: null,
          pnlUsdc: p.realized_pnl_usdc != null ? Number(p.realized_pnl_usdc) / 1e6 : 0,
          pnlPercent: null,
          leverage: 1,
          tokenAddress: p.token,
        }));
      } else {
        this.positions = [];
      }
    } catch {
      // Keep whatever we had; never invent positions
    }
    this.renderPositions();
  },

  closePosition(id) {
    if (!this.positions.some((position) => position.id === id)) return;
    alert("El cierre requiere una venta confirmada. La ejecución está pendiente de verificación; tu posición sigue abierta.");
  },

  renderPositions() {
    const container = document.getElementById("activePositionsTable");
    if (!container) return;

    if (this.positions.length === 0) {
      container.innerHTML = `
        <div style="padding:24px; text-align:center; color:var(--text-tertiary); font-size:12px">
          No hay posiciones abiertas actualmente.
        </div>
      `;
      return;
    }

    container.innerHTML = this.positions.map((p) => {
      const isProfit = p.pnlUsdc >= 0;
      const live = p.currentPrice > 0;
      return `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--border-subtle); font-family:var(--font-mono); font-size:12px">
          <div>
            <div style="display:flex; align-items:center; gap:8px">
              ${TokenMeta.logoHtml(p.symbol, { size: 22 })}
              <strong style="color:#fff">${esc(p.symbol)}</strong>
              <span class="elite-badge" style="font-size:9px; color:${p.side === "LONG" ? "var(--delta-green)" : "var(--delta-red)"}">${p.side}</span>
              <span style="font-size:10px; color:var(--text-tertiary)">${esc(p.chain)}</span>
            </div>
            <div style="color:var(--text-secondary); font-size:11px; margin-top:2px">
              Coste restante: $${p.sizeUsdc.toFixed(2)} · Entrada unitaria: pendiente
              ${live ? ` · <span style="color:var(--text-tertiary)">Live: $${p.currentPrice < 0.01 ? p.currentPrice.toFixed(6) : p.currentPrice.toPrecision(4)}</span>` : ""}
            </div>
          </div>

          <div style="text-align:right">
            <div style="font-weight:700; color:${isProfit ? "var(--delta-green)" : "var(--delta-red)"}">
              Realizado: ${isProfit ? "+" : ""}$${p.pnlUsdc.toFixed(2)}
            </div>
            <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:4px">
              <button class="btn btn-ghost btn-sm" onclick="window.TradingEngine.openShareCard(${esc(JSON.stringify(p))})">Share Card</button>
              <button class="btn btn-secondary btn-sm" onclick="window.TradingEngine.closePosition('${p.id}')">Cerrar</button>
            </div>
          </div>
        </div>
      `;
    }).join("");
  },

  openShareCard(position) {
    const canvas = document.getElementById("shareCardCanvas");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = 600;
    const height = 340;
    canvas.width = width;
    canvas.height = height;

    // Background pitch black
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    // Smoked border
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 2;
    ctx.strokeRect(10, 10, width - 20, height - 20);

    // Watermark brand
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 22px system-ui, sans-serif";
    ctx.fillText("TRENCHES", 36, 52);

    ctx.fillStyle = "#71717a";
    ctx.font = "12px monospace";
    ctx.fillText("// THE SOCIAL NETWORK FOR MARKETS", 116, 48);

    // Trade details
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 20px system-ui, sans-serif";
    ctx.fillText(`${position.side} $${position.symbol} (${position.chain.toUpperCase()})`, 36, 110);

    // Token logo (drawn async; over the title once loaded)
    TokenMeta.drawOnCanvas(ctx, position.symbol, width - 36 - 48, 36, 48).catch(() => {});

    // Massive PnL
    const isWin = position.pnlUsdc >= 0;
    ctx.fillStyle = isWin ? "#22c55e" : "#ef4444";
    ctx.font = "900 48px monospace";
    ctx.fillText(`${isWin ? "+" : ""}$${position.pnlUsdc.toFixed(2)}`, 36, 175);

    ctx.fillStyle = "#a1a1aa";
    ctx.font = "15px monospace";
    ctx.fillText(`PnL: ${isWin ? "+" : ""}$${position.pnlUsdc.toFixed(2)} USDC`, 36, 215);
    ctx.fillText("PnL realizado registrado por el servidor", 36, 245);

    // Footer
    ctx.fillStyle = "#52525b";
    ctx.font = "11px monospace";
    ctx.fillText(`REGISTRO DE TRENCHES · ${new Date().toLocaleDateString()}`, 36, 305);

    const modal = document.getElementById("shareCardModal");
    if (modal) modal.classList.add("active");
  },
};

/** Map a trading symbol to the best CoinGecko id we have in PriceFeed.coinMap. */
function CoinGeckoIdForSymbol(symbol) {
  const map = {
    SOL: "solana",
    ETH: "ethereum",
    BTC: "bitcoin",
    BRETT: "brett",
    VIRTUAL: "virtuals",
    JUP: "jupiter-exchange-token",
    PENDLE: "pendle-finance",
    PEPE: "pepe",
    BONK: "bonk",
    AERO: "aerodrome",
    BNB: "binancecoin",
    GMX: "gmx",
    POL: "matic-network",
  };
  return map[symbol.toUpperCase()] || null;
}
