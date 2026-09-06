/**
 * 🧭 DISCOVER ENGINE — Multi-Chain Market Radar (real data layer)
 * Real-time scanning across Solana, Base, Ethereum, BNB Chain, Arbitrum, Polygon, Monad, Arc.
 * Categories: Trending, Gainers, Losers, New, Volume, Smart Money, Memecoins, AI, RWA, Perps, Watchlist.
 *
 * Price layer: CoinGecko public API (no key) with a 5-minute localStorage cache so
 * reloads don't hammer public endpoints. Falls back to last cache / safe defaults.
 */

import { EliteScoreEngine } from "./intelligence.js";
import { ApiClient } from "./api.js";

/**
 * Shared real-price feed used by Discover, Feed and the Trading terminal.
 * CoinGecko's /markets endpoint returns USD price + 24h stats for many tokens
 * in a single request, which is the cheapest real source available today.
 */
export const PriceFeed = {
  cacheKey: "raidos_price_cache_v1",
  cacheTtlMs: 5 * 60 * 1000,

  /** Our canonical symbol → CoinGecko coin id mapping (kept lean for the UI today). */
  coinMap: {
    SOL: "solana",
    ETH: "ethereum",
    BTC: "bitcoin",
    BRETT: "brett",
    VIRTUAL: "virtuals",
    JUP: "jupiter-exchange-token",
    PENDLE: "pendle-finance",
    PEPE: "pepe",
    BONK: "bonk",
    MON: "monad",
    AERO: "aerodrome",
    BNB: "binancecoin",
    GMX: "gmx",
    POL: "matic-network",
  },

  cache: null,
  cacheUpdatedAt: 0,

  async ensureCache() {
    if (this.cache) {
      const stale = Date.now() - this.cacheUpdatedAt > this.cacheTtlMs;
      if (!stale) return this.cache;
    }

    const stored = localStorage.getItem(this.cacheKey);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed && Array.isArray(parsed.rows)) {
          const stale = Date.now() - parsed._updatedAt > this.cacheTtlMs;
          if (!stale) {
            this.cache = parsed.rows;
            this.cacheUpdatedAt = parsed._updatedAt;
            return this.cache;
          }
        }
      } catch {}
    }

    const ids = Object.values(this.coinMap).filter(Boolean);
    const fetched = [];
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids.join(","))}&sparkline=false&price_change_percentage=24h&order=market_cap_desc`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
      const markets = await res.json();
      for (let i = 0; i < markets.length; i++) {
        const m = markets[i];
        const symbol = (m.symbol || "").toUpperCase();
        fetched.push({
          symbol,
          price: Number(m.current_price ?? 0),
          delta24h: Number(m.price_change_percentage_24h ?? 0),
          vol24h: Number(m.total_volume ?? 0),
          mcap: Number(m.market_cap ?? 0),
        });
      }
    } catch (err) {
      console.warn("[PriceFeed] real fetch failed, keeping last cache:", err);
      if (this.cache) return this.cache;
    }

    this.cache = fetched;
    this.cacheUpdatedAt = Date.now();
    try {
      localStorage.setItem(this.cacheKey, JSON.stringify({ _updatedAt: this.cacheUpdatedAt, rows: fetched }));
    } catch {}
    return this.cache;
  },

  /** Latest price row for a symbol; safe fallback defaults if unknown/stale. */
  get(symbol) {
    const sym = symbol.toUpperCase();
    const row = this.cache?.find((r) => r.symbol === sym);
    if (row && row.price > 0) return row;
    return this._fallback(sym);
  },

  /**
   * No invented prices. If CoinGecko is unreachable and there's no cache,
   * the token has no price data — callers render "—".
   */
  _fallback(symbol) {
    return { symbol: symbol.toUpperCase(), price: 0, delta24h: 0, vol24h: 0, mcap: 0, noData: true };
  },

  async refresh() {
    this.cache = null;
    return this.ensureCache();
  },
};

export const DiscoverEngine = {
  container: null,
  activeCategory: "TRENDING",
  activeChain: "all",
  searchQuery: "",
  tokens: [],
  watchlist: new Set(JSON.parse(localStorage.getItem("trenches_watchlist") || '["SOL","BRETT","VIRTUAL"]')),

  async init(containerElement) {
    this.container = containerElement;
    await this.loadTokens();
  },

  async loadTokens() {
    // Real price layer: CoinGecko rows keyed by symbol (never by index —
    // CoinGecko returns rows ordered by market cap, not by our map order).
    await PriceFeed.ensureCache();
    const priceById = new Map();
    for (const [sym, id] of Object.entries(PriceFeed.coinMap)) {
      const row = PriceFeed.cache?.find((r) => r.symbol === sym.toUpperCase());
      if (row && row.price > 0) priceById.set(sym, row);
    }

    const p = (sym, key, fb) => {
      const row = priceById.get(sym);
      const v = row?.[key];
      return Number.isFinite(v) && v !== 0 ? v : fb;
    };

    // Static universe: only display metadata (name/chain/sector). All numeric
    // fields come from the real CoinGecko fetch; metrics we cannot source yet
    // (liquidity, holder concentration, smart-money inflow) are omitted and
    // shown as "—" instead of invented values.
    const baseUniverse = [
      { symbol: "SOL", name: "Solana", chain: "solana", category: "TRENDING", sector: "L1" },
      { symbol: "BTC", name: "Bitcoin", chain: "bitcoin", category: "VOLUME", sector: "L1" },
      { symbol: "ETH", name: "Ethereum", chain: "ethereum", category: "VOLUME", sector: "L1" },
      { symbol: "BRETT", name: "Brett", chain: "base", category: "MEMECOINS", sector: "Memecoins" },
      { symbol: "VIRTUAL", name: "Virtuals Protocol", chain: "base", category: "AI", sector: "AI" },
      { symbol: "JUP", name: "Jupiter", chain: "solana", category: "TRENDING", sector: "DeFi" },
      { symbol: "PENDLE", name: "Pendle", chain: "ethereum", category: "RWA", sector: "RWA" },
      { symbol: "PEPE", name: "Pepe", chain: "ethereum", category: "LOSERS", sector: "Memecoins" },
      { symbol: "BONK", name: "Bonk", chain: "solana", category: "MEMECOINS", sector: "Memecoins" },
      { symbol: "MON", name: "Monad", chain: "monad", category: "NEW", sector: "L1" },
      { symbol: "ARC", name: "Arc (Circle)", chain: "arc", category: "NEW", sector: "Stablecoin L1", fixedPrice: 1.0 },
      { symbol: "AERO", name: "Aerodrome", chain: "base", category: "GAINERS", sector: "DeFi" },
      { symbol: "BNB", name: "BNB Chain", chain: "bsc", category: "VOLUME", sector: "L1" },
      { symbol: "GMX", name: "GMX", chain: "arbitrum", category: "PERPS", sector: "Perps" },
      { symbol: "POL", name: "Polygon Ecosystem", chain: "polygon", category: "TRENDING", sector: "L2" },
    ];

    this.tokens = baseUniverse.map((t) => {
      const hasLive = priceById.has(t.symbol) || t.fixedPrice !== undefined;
      const price = t.fixedPrice ?? p(t.symbol, "price", null);
      const delta24h = t.fixedPrice !== undefined ? 0 : p(t.symbol, "delta24h", 0);
      const vol24h = p(t.symbol, "vol24h", 0);
      const mcap = p(t.symbol, "mcap", 0);
      const scoreObj = hasLive
        ? EliteScoreEngine.calculate({
            liquidityUsd: 0,
            volume24hUsd: vol24h,
            mcapUsd: mcap,
            priceChange24h: delta24h,
          })
        : { score: null, tier: "NO DATA" };
      return {
        ...t,
        price: price ?? 0,
        delta24h,
        vol24h,
        mcap,
        liquidity: null,
        top10: null,
        smInflow: null,
        hasLivePrice: hasLive,
        eliteScore: scoreObj.score,
        eliteTier: scoreObj.tier,
        isWatchlist: this.watchlist.has(t.symbol),
      };
    });

    try {
      const launchData = await ApiClient.request("/api/launches?limit=10");
      if (launchData && launchData.launches) {
        for (const l of launchData.launches) {
          this.tokens.unshift({
            symbol: l.symbol,
            name: l.name,
            chain: l.chain,
            category: "NEW",
            sector: "Launchpad",
            price: Number(l.priceUsdc || 0),
            delta24h: 0,
            vol24h: 0,
            mcap: 0,
            liquidity: null,
            top10: null,
            smInflow: null,
            hasLivePrice: Number(l.priceUsdc || 0) > 0,
            eliteScore: null,
            eliteTier: "NEW LAUNCH",
            isWatchlist: this.watchlist.has(l.symbol),
          });
        }
      }
    } catch {}

    this.render();
    this.renderCategoryCounts();
  },

  setCategory(category) {
    this.activeCategory = category;
    this.render();
    this.renderCategoryCounts();
  },

  setChain(chain) {
    this.activeChain = chain;
    this.render();
  },

  setSearch(query) {
    this.searchQuery = query.toLowerCase().trim();
    this.render();
  },

  toggleWatchlist(symbol) {
    if (this.watchlist.has(symbol)) {
      this.watchlist.delete(symbol);
    } else {
      this.watchlist.add(symbol);
    }
    localStorage.setItem("trenches_watchlist", JSON.stringify([...this.watchlist]));
    this.render();
  },

  async refresh() {
    await PriceFeed.refresh();
    await this.loadTokens();
  },

  render() {
    if (!this.container) return;

    let list = [...this.tokens];

    if (this.searchQuery) {
      list = list.filter(
        (t) =>
          t.symbol.toLowerCase().includes(this.searchQuery) ||
          t.name.toLowerCase().includes(this.searchQuery) ||
          t.chain.toLowerCase().includes(this.searchQuery) ||
          (t.sector && t.sector.toLowerCase().includes(this.searchQuery))
      );
    }

    if (this.activeChain !== "all") {
      list = list.filter((t) => t.chain.toLowerCase() === this.activeChain.toLowerCase());
    }

    if (this.activeCategory === "WATCHLIST") {
      list = list.filter((t) => t.isWatchlist);
    } else if (this.activeCategory === "GAINERS") {
      list = list.sort((a, b) => b.delta24h - a.delta24h);
    } else if (this.activeCategory === "LOSERS") {
      list = list.sort((a, b) => a.delta24h - b.delta24h);
    } else if (this.activeCategory === "VOLUME") {
      list = list.sort((a, b) => b.vol24h - a.vol24h);
    } else if (this.activeCategory === "SMART MONEY") {
      list = list.sort((a, b) => b.smInflow - a.smInflow);
    } else if (this.activeCategory === "MEMECOINS") {
      list = list.filter((t) => t.sector === "Memecoins");
    } else if (this.activeCategory === "AI") {
      list = list.filter((t) => t.sector === "AI");
    } else if (this.activeCategory === "RWA") {
      list = list.filter((t) => t.sector === "RWA");
    } else if (this.activeCategory === "PERPS") {
      list = list.filter((t) => t.sector === "Perps");
    } else if (this.activeCategory === "NEW") {
      list = list.filter((t) => t.category === "NEW" || t.sector === "Launchpad");
    } else {
      list = list.sort((a, b) => b.eliteScore - a.eliteScore);
    }

    if (list.length === 0) {
      this.container.innerHTML = `
        <div style="padding:40px; text-align:center; color:var(--text-tertiary)">
          No se encontraron activos para los filtros seleccionados.
        </div>
      `;
      return;
    }

    this.container.innerHTML = list.map((t) => this.renderTokenRow(t)).join("");
  },

  renderCategoryCounts() {
    const counts = {
      "TRENDING": this.tokens.filter((t) => t.category === "TRENDING").length,
      "GAINERS": this.tokens.filter((t) => t.delta24h >= 5).length,
      "LOSERS": this.tokens.filter((t) => t.delta24h <= -5).length,
      "VOLUME": this.tokens.filter((t) => t.vol24h > 50000000).length,
      "SMART MONEY": this.tokens.filter((t) => t.smInflow >= 40000).length,
      "MEMECOINS": this.tokens.filter((t) => t.sector === "Memecoins").length,
      "AI": this.tokens.filter((t) => t.sector === "AI").length,
      "RWA": this.tokens.filter((t) => t.sector === "RWA").length,
      "PERPS": this.tokens.filter((t) => t.sector === "Perps").length,
      "NEW": this.tokens.filter((t) => t.category === "NEW" || t.sector === "Launchpad").length,
      "WATCHLIST": this.tokens.filter((t) => t.isWatchlist).length,
    };

    document.querySelectorAll(".pill-tab").forEach((btn) => {
      const onclick = btn.getAttribute("onclick") || "";
      const match = onclick.match(/'(TRENDING|GAINERS|LOSERS|VOLUME|SMART MONEY|MEMECOINS|AI|RWA|PERPS|NEW|WATCHLIST)'/);
      const cat = match ? match[1] : null;
      if (cat && counts[cat] !== undefined) {
        let existing = btn.querySelector(".cat-count");
        if (!existing) {
          existing = document.createElement("span");
          existing.className = "cat-count";
          existing.style.cssText = "font-size:10px; color:var(--text-tertiary); margin-left:4px";
          btn.appendChild(existing);
        }
        existing.textContent = String(counts[cat]);
      }
    });
  },

  renderTokenRow(t) {
    const isUp = t.delta24h >= 0;
    const isSaved = t.isWatchlist;
    const formattedPrice =
      t.price > 0 && t.price < 0.01
        ? "$" + t.price.toFixed(6)
        : t.price > 0
          ? "$" + t.price.toLocaleString(undefined, { minimumFractionDigits: t.price < 1 ? 4 : 2 })
          : "—";
    const formattedVol = t.vol24h > 0 ? formatNumber(t.vol24h) : "—";
    const formattedMcap = t.mcap > 0 ? formatNumber(t.mcap) : "—";
    const scoreBadge =
      t.eliteScore !== null && t.eliteScore !== undefined
        ? `<div class="elite-badge ${t.eliteScore >= 88 ? 'high' : 'mid'}" title="Elite Score Algorítmico">⚡ ${t.eliteScore}/100</div>`
        : `<div class="elite-badge mid" title="Datos insuficientes para puntuar" style="opacity:0.55">⚡ —</div>`;

    return `
      <div class="token-row glass-panel-interactive" onclick="window.App.openTradeForToken('${t.symbol}', '${t.chain}', ${t.price})" style="display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid var(--border-subtle); cursor:pointer">
        <div style="display:flex; align-items:center; gap:14px">
          <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); window.DiscoverEngine.toggleWatchlist('${t.symbol}')" style="padding:4px; font-size:14px; color:${isSaved ? '#fde047' : 'var(--text-muted)'}" title="Guardar en Watchlist">
            ${isSaved ? '★' : '☆'}
          </button>

          <div style="width:34px; height:34px; border-radius:50%; background:#141417; border:1px solid var(--border-subtle); display:flex; align-items:center; justify-content:center; font-weight:800; font-size:12px; color:#fff">
            ${t.symbol.slice(0, 3)}
          </div>

          <div>
            <div style="display:flex; align-items:center; gap:8px">
              <span style="font-weight:800; font-size:14px; color:#fff">${t.symbol}</span>
              <span class="brand-badge" style="font-size:9px">${t.chain.toUpperCase()}</span>
              ${t.sector ? `<span style="font-size:10px; color:var(--text-tertiary)">${t.sector}</span>` : ''}
            </div>
            <div style="font-size:12px; color:var(--text-secondary)">${t.name}</div>
          </div>
        </div>

        <div style="display:flex; align-items:center; gap:24px">
          <div class="desktop-only" style="text-align:right; font-family:var(--font-mono); font-size:12px">
            <div style="color:var(--text-secondary)">Vol 24h: <span style="color:#fff">${formattedVol}</span></div>
            <div style="color:var(--text-tertiary)">MCap: ${formattedMcap}</div>
          </div>

          <div style="text-align:right">
            ${scoreBadge}
            <div style="font-family:var(--font-mono); font-weight:700; font-size:13.5px; margin-top:3px; color:#fff">${formattedPrice}</div>
            <div style="font-family:var(--font-mono); font-size:11.5px; color:${isUp ? 'var(--delta-green)' : 'var(--delta-red)'}">
              ${isUp ? '+' : ''}${t.delta24h.toFixed(2)}%
            </div>
          </div>

          <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); window.App.openTradeForToken('${t.symbol}', '${t.chain}', ${t.price})">
            TRADE
          </button>
        </div>
      </div>
    `;
  },
};

function formatNumber(num) {
  if (num >= 1000000000) return "$" + (num / 1000000000).toFixed(1) + "B";
  if (num >= 1000000) return "$" + (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return "$" + (num / 1000).toFixed(1) + "K";
  return "$" + num.toLocaleString();
}
