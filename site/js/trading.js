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
  slippageBps: 50, // order-form slippage tolerance, user-selectable (50/100/300)
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
    // Li.Fi flow (e.g. Arc): an exact ERC-20 approve must be confirmed BEFORE
    // the swap. Both txs are sent from the same wallet — the mempool keeps
    // sequential nonces, so the swap can never front-run its approval.
    if (tx.approveTx?.to && tx.approveTx?.data) {
      await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from, to: tx.approveTx.to, data: tx.approveTx.data, value: "0x0" }],
      });
    }
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
    // Order-form labels follow the side: BUY pays USDC, SELL spends the token.
    const amountLabel = document.getElementById("amountLabel");
    if (amountLabel) amountLabel.textContent = this.orderSide === "BUY" ? "Pagar en USDC" : `Vender ${this.currentSymbol}`;
    const amountInput = document.getElementById("orderAmountInput");
    if (amountInput) amountInput.placeholder = this.orderSide === "BUY" ? "0.00 USDC" : `0.00 ${this.currentSymbol}`;
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
    this._balanceCache = null;
    this.updateTokenDisplay();
    this.scheduleQuote();
  },

  /** Slippage chips: 0.5% / 1% / 3% (clamped 50..500 bps server-side). */
  setSlippage(percent, chip) {
    const value = Number(percent);
    if (!Number.isFinite(value) || value < 0.1 || value > 5) return;
    this.slippageBps = Math.round(value * 100);
    document.querySelectorAll("#slippageChips .slippage-chip").forEach((el) => el.classList.remove("active"));
    chip?.classList?.add("active");
    this.scheduleQuote();
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

  /* ── 💧 Balance (real, read-only) ───────────────────────────────────── */

  /**
   * Real connected-wallet balance for the CURRENT side: USDC when buying,
   * the token itself when selling. Sourced from GET /api/wallets/balances
   * (public RPCs, server-side scan). null = unknown, never invented.
   */
  async availableBalance() {
    if (!ApiClient.isAuthenticated()) return null;
    const key = this.currentChain + ":" + (this.orderSide === "BUY" ? "USDC" : String(this.currentTokenAddress || "").toLowerCase());
    if (this._balanceCache?.key === key && Date.now() - this._balanceCache.at < 30_000) return this._balanceCache.value;
    try {
      const data = await ApiClient.getWalletBalances();
      let value = null;
      for (const wallet of data?.balances ?? []) {
        if (wallet.chain !== this.currentChain) continue;
        if (this.orderSide === "BUY") {
          if (wallet.usdcAmount != null) value = (value ?? 0) + Number(wallet.usdcAmount);
        } else if (this.currentTokenAddress) {
          for (const token of wallet.tokens ?? []) {
            if (String(token.address).toLowerCase() === String(this.currentTokenAddress).toLowerCase() && token.amount != null) {
              value = (value ?? 0) + Number(token.amount);
            }
          }
        }
      }
      this._balanceCache = { key, at: Date.now(), value };
      return value;
    } catch {
      return this._balanceCache?.key === key ? this._balanceCache.value : null;
    }
  },

  async setAmountPercent(percent) {
    const input = document.getElementById("orderAmountInput");
    if (!input) return;
    const label = document.getElementById("balanceLabel");
    input.dataset.balancePending = "1";
    const balance = await this.availableBalance();
    delete input.dataset.balancePending;
    if (balance === null || balance <= 0) {
      if (label) label.textContent = balance === null ? "Saldo no disponible" : "Sin saldo";
      return;
    }
    input.value = this.orderSide === "BUY"
      ? String(Math.floor(balance * percent) / 100).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")
      : (balance * percent / 100).toFixed(6).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    if (label) label.textContent = `Disponible: ${balance < 0.01 && balance > 0 ? balance.toFixed(6) : balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    this.calculateEstOutput();
  },

  /* ── 💱 Real quote (debounced) ──────────────────────────────────────── */

  /** Quote debounce timer id (calculateEstOutput is called on every keystroke). */
  _quoteTimer: null,

  /** Debounced wrapper: quotes fire 350 ms after the last keystroke. */
  scheduleQuote() {
    clearTimeout(this._quoteTimer);
    this._quoteTimer = setTimeout(() => this.calculateEstOutput(), 350);
  },

  /**
   * Live quote for the order form: POST /api/trades/quote with the REAL
   * addresses and the selected slippage. Fills "Recibir estimado", fee and
   * price impact. Honest states: sign-in required, no route, provider down.
   */
  async calculateEstOutput() {
    const outputEl = document.getElementById("estReceiveAmount");
    const feeEl = document.getElementById("estFeeAmount");
    const impactEl = document.getElementById("estImpactAmount");
    const raw = String(document.getElementById("orderAmountInput")?.value ?? "").trim();
    const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(raw);
    if (!outputEl) return;
    if (!match) { outputEl.textContent = "—"; if (feeEl) feeEl.textContent = "—"; if (impactEl) impactEl.textContent = "—"; return; }
    if (!ApiClient.isAuthenticated()) { outputEl.textContent = "Inicia sesión para cotizar"; if (feeEl) feeEl.textContent = "—"; if (impactEl) impactEl.textContent = "—"; return; }
    if (!this.currentTokenAddress && !WELL_KNOWN_ADDR[this.currentChain]?.[this.currentSymbol]) {
      outputEl.textContent = "Sin contrato on-chain"; return;
    }
    const sellAddr = this.resolveTokenAddress(this.orderSide === "BUY" ? "USDC" : this.currentSymbol, this.currentChain);
    const buyAddr = this.resolveTokenAddress(this.orderSide === "BUY" ? this.currentSymbol : "USDC", this.currentChain);
    if (!sellAddr || !buyAddr) { outputEl.textContent = "Sin ruta en esta red"; return; }
    // Units: USDC has 6 decimals on every supported chain; SELL routes in the
    // TOKEN's own smallest units (fetched on-chain, cached 10 min).
    let amount;
    if (this.orderSide === "BUY") {
      amount = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
    } else {
      const decimals = await this._tokenDecimals(this.currentChain, sellAddr);
      if (decimals == null) { outputEl.textContent = "Decimales del token desconocidos"; return; }
      if ((match[2] ?? "").length > decimals) { outputEl.textContent = `Máximo ${decimals} decimales`; return; }
      const whole = match[1], frac = match[2] ?? "";
      amount = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0"));
    }
    if (amount <= 0n) { outputEl.textContent = "Cantidad inválida"; return; }
    const request = this._quoteRequest = (this._quoteRequest || 0) + 1;
    outputEl.textContent = "Cotizando…";
    try {
      const data = await ApiClient.getQuote({
        fromChain: this.currentChain, toChain: this.currentChain,
        sellToken: sellAddr, buyToken: buyAddr,
        amount: amount.toString(), type: "swap",
        slippageBps: this.slippageBps,
      });
      if (request !== this._quoteRequest) return;
      const quote = data?.quote;
      if (!quote?.buyAmount) throw new Error(quote?.error || "sin ruta");
      const buyDecimals = this.orderSide === "BUY" ? await this._tokenDecimals(this.currentChain, buyAddr) : 6;
      if (buyDecimals == null) { outputEl.textContent = "Decimales del token desconocidos"; return; }
      const divisor = 10n ** BigInt(buyDecimals);
      const whole = BigInt(quote.buyAmount) / divisor;
      const frac = (BigInt(quote.buyAmount) % divisor).toString().padStart(buyDecimals, "0").slice(0, 4);
      outputEl.textContent = `${whole.toLocaleString("en-US")}${frac ? "." + frac : ""} ${this.orderSide === "BUY" ? this.currentSymbol : "USDC"}`;
      if (feeEl) {
        const feeMicro = Number(quote.feeUsdc);
        feeEl.textContent = Number.isFinite(feeMicro) ? `$${(feeMicro / 1e6).toFixed(4)}` : "—";
      }
      if (impactEl) {
        const impact = Number(quote.priceImpact);
        impactEl.textContent = Number.isFinite(impact) && impact >= 0 ? `${(impact * 100).toFixed(2)}%` : "—";
        impactEl.style.color = impact > 0.05 ? "var(--delta-red)" : impact > 0.01 ? "#eac184" : "var(--delta-green)";
      }
    } catch (err) {
      if (request !== this._quoteRequest) return;
      outputEl.textContent = String(err?.message || "Cotización no disponible").slice(0, 60);
      if (feeEl) feeEl.textContent = "—";
      if (impactEl) impactEl.textContent = "—";
    }
  },

  /**
   * On-chain decimals via GET /api/market/token-info (real chain RPC).
   * Cache 10 min per address; unknown stays null (never guessed).
   */
  async _tokenDecimals(chain, address) {
    if (!address) return null;
    if (!this._decimalsCache) this._decimalsCache = new Map();
    const key = chain + ":" + address.toLowerCase();
    const hit = this._decimalsCache.get(key);
    if (hit && Date.now() - hit.at < 600_000) return hit.value;
    try {
      const info = await ApiClient.request(`/api/market/token-info?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`);
      this._decimalsCache.set(key, { value: info?.decimals ?? null, at: Date.now() });
      return info?.decimals ?? null;
    } catch {
      this._decimalsCache.set(key, { value: null, at: Date.now() });
      return null;
    }
  },

  /** Execute through the API; failed requests never create local positions. */
  async executeTrade() {
    const amountInput = document.getElementById("orderAmountInput");
    const amount = Number(amountInput?.value || 0);
    if (amount <= 0) {
      alert("Por favor introduce una cantidad mayor que cero.");
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
      // Exact integer smallest units — no float math on money. BUY converts the
      // USDC input to micro-units (6 decimals); SELL converts the token input
      // to the TOKEN's own smallest units using its on-chain decimals.
      const raw = String(amountInput?.value ?? "").trim();
      const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(raw);
      if (!match) {
        alert("Cantidad inválida. Usa un número positivo con decimales.");
        return;
      }
      let micros;
      if (this.orderSide === "BUY") {
        micros = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0").slice(0, 6));
      } else {
        const decimals = await this._tokenDecimals(this.currentChain, sellAddr);
        if (decimals == null) {
          alert("No se pudieron verificar los decimales on-chain del token; venta bloqueada por seguridad.");
          return;
        }
        if ((match[2] ?? "").length > decimals) {
          alert(`Máximo ${decimals} decimales para vender este token.`);
          return;
        }
        micros = BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt((match[2] ?? "").padEnd(decimals, "0"));
      }
      if (micros <= 0n) {
        alert("Por favor introduce una cantidad mayor que cero.");
        return;
      }
      const tradeParams = {
        fromChain: this.currentChain,
        toChain: this.currentChain,
        sellToken: sellAddr,
        buyToken: buyAddr,
        amount: micros.toString(),
        type: "swap",
        slippageBps: this.slippageBps,
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
