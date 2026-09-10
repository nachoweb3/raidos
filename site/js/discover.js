/**
 * 🧭 DISCOVER ENGINE — Multi-Chain Market Radar (real data layer)
 * Real-time scanning across Solana, Base, Ethereum, BNB Chain, Arbitrum, Polygon, Monad, Arc.
 * Categories: Trending, Gainers, Losers, New, Volume, Smart Money, Memecoins, AI, RWA, Perps, Watchlist.
 * Advanced filters: MCap, volume, txns, liquidity, socials, sector + quick chips
 * (Launchpad, Graduated, Most holded, Hot narratives) and multi-column sorting.
 *
 * Price layer: CoinGecko public API (no key) with a 5-minute localStorage cache.
 * Pair layer:  DexScreener public API (no key) via DexFeed — liquidity, txns,
 *              socials, per-hour changes. Honest "—" when a token isn't listed.
 */

import { EliteScoreEngine } from "./intelligence.js";
import { ApiClient } from "./api.js";
import { TokenMeta } from "./tokens.js";
import { DexFeed, SecurityFeed } from "./dexfeed.js";

/**
 * Shared real-price feed used by Discover, Feed and the Trading terminal.
 * CoinGecko's /markets endpoint returns USD price + 24h stats for many tokens
 * in a single request, which is the cheapest real source available today.
 */
export const PriceFeed = {
  cacheKey: "raidos_price_cache_v2",
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
          // Real logo + name straight from the market feed — every token row
          // gets its official image, not just the ones in our curated map.
          image: typeof m.image === "string" && m.image.startsWith("http") ? m.image : null,
          name: typeof m.name === "string" && m.name ? m.name : null,
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
    return { symbol: symbol.toUpperCase(), price: 0, delta24h: 0, vol24h: 0, mcap: 0, image: null, name: null, noData: true };
  },

  async refresh() {
    this.cache = null;
    return this.ensureCache();

  },
};

// Shared logo/name layer (tokens.js takes the feed via setter — no import cycle).
TokenMeta.setPriceFeed(PriceFeed);

export const DiscoverEngine = {
  container: null,
  activeCategory: "TRENDING",
  activeChain: "all",
  searchQuery: "",
  tokens: [],
  serverResults: null,
  watchlist: new Set(JSON.parse(localStorage.getItem("trenches_watchlist") || '["SOL","BRETT","VIRTUAL"]')),

  /** Advanced filter state (advanced panel + quick chips + sort). */
  filters: { mcapMin: "", mcapMax: "", volMin: "", txnsMin: "", liqMin: "", hasSocials: false, sector: "" },
  sort: "score",
  chips: { launchpad: false, graduated: false, holded: false, narratives: false },

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
      { symbol: "SOL", name: "Solana", chain: "solana", category: "TRENDING", sector: "L1", imageUrl: TokenMeta.logoUrls.SOL },
      { symbol: "BTC", name: "Bitcoin", chain: "bitcoin", category: "VOLUME", sector: "L1", imageUrl: TokenMeta.logoUrls.BTC },
      { symbol: "ETH", name: "Ethereum", chain: "ethereum", category: "VOLUME", sector: "L1", imageUrl: TokenMeta.logoUrls.ETH },
      { symbol: "BRETT", name: "Brett", chain: "base", category: "MEMECOINS", sector: "Memecoins" },
      { symbol: "VIRTUAL", name: "Virtuals Protocol", chain: "base", category: "AI", sector: "AI" },
      { symbol: "JUP", name: "Jupiter", chain: "solana", category: "TRENDING", sector: "DeFi" },
      { symbol: "PENDLE", name: "Pendle", chain: "ethereum", category: "RWA", sector: "RWA" },
      { symbol: "PEPE", name: "Pepe", chain: "ethereum", category: "LOSERS", sector: "Memecoins" },
      { symbol: "BONK", name: "Bonk", chain: "solana", category: "MEMECOINS", sector: "Memecoins" },
      { symbol: "MON", name: "Monad", chain: "monad", category: "NEW", sector: "L1" },
      { symbol: "ARC", name: "Arc (Circle)", chain: "arc", category: "NEW", sector: "Stablecoin L1", fixedPrice: 1.0, imageUrl: TokenMeta.logoUrls.USDC },
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
      const liveRow = priceById.get(t.symbol);
      return {
        ...t,
        price: price ?? 0,
        delta24h,
        vol24h,
        mcap,
        imageUrl: t.imageUrl || liveRow?.image || null,
        liquidity: null,
        txns24h: null,
        holders: null,
        socials: {},
        launchStatus: null,
        buyersCount: null,
        tokenAddress: null,
        smInflow: null,
        hasLivePrice: hasLive,
        eliteScore: scoreObj.score,
        eliteTier: scoreObj.tier,
        isWatchlist: this.watchlist.has(t.symbol),
      };
    });

    try {
      const launchData = await ApiClient.request("/api/launches?limit=20");
      if (launchData && launchData.launches) {
        for (const l of launchData.launches) {
          this.tokens.unshift({
            symbol: l.symbol,
            name: l.name,
            chain: l.chain,
            category: "NEW",
            sector: "Launchpad",
            imageUrl: l.imageUrl || null,
            price: Number(l.priceUsdc ?? l.currentPriceUsdc ?? 0),
            delta24h: 0,
            vol24h: 0,
            mcap: Number(l.marketCapUsdc ?? 0),
            liquidity: null,
            txns24h: null,
            holders: null,
            socials: {
              ...(l.twitterUrl ? { twitter: l.twitterUrl } : {}),
              ...(l.telegramUrl ? { telegram: l.telegramUrl } : {}),
              ...(l.websiteUrl ? { website: l.websiteUrl } : {}),
            },
            launchStatus: l.status ?? null,
            buyersCount: Number(l.buyersCount ?? 0),
            tokenAddress: l.tokenAddress ?? null,
            launchId: l.id,
            progressPct: Number(l.progressPct ?? 0),
            smInflow: null,
            hasLivePrice: Number(l.priceUsdc ?? l.currentPriceUsdc ?? 0) > 0,
            eliteScore: null,
            eliteTier: "NEW LAUNCH",
            isWatchlist: this.watchlist.has(l.symbol),
          });
        }
      }
    } catch {}

    this.render();
    this.renderCategoryCounts();
    this.enrichWithDexData(); // async, re-renders when real pair data lands
  },

  /**
   * Pair-level enrichment (DexScreener): liquidity, txns, h1/h6 changes,
   * socials, logos, mcap for tokens CoinGecko doesn't cover. Runs after first
   * paint so the UI is never blocked on it.
   */
  async enrichWithDexData() {
    try {
      const refs = this.tokens.map((t) => ({
        symbol: t.symbol,
        address: t.tokenAddress || undefined,
        chain: t.chain,
      }));
      await DexFeed.ensureTokens(refs);
      for (const t of this.tokens) {
        const row = DexFeed.get(t.tokenAddress || t.symbol);
        if (!row) continue;
        t.dex = row;
        // Capture the real pair address so the terminal can route swaps by it.
        if (!t.tokenAddress && row.address) t.tokenAddress = row.address;
        if (row.mcap > 0) t.mcap = t.mcap > 0 ? Math.max(t.mcap, row.mcap) : row.mcap;
        if (row.vol24h > 0) t.vol24h = t.vol24h > 0 ? Math.max(t.vol24h, row.vol24h) : row.vol24h;
        if (row.liqUsd > 0) t.liquidity = row.liqUsd;
        if (row.txns24h > 0) t.txns24h = row.txns24h;
        if (row.change24h !== 0 && !t.fixedPrice) t.delta24h = row.change24h;
        if (row.priceUsd > 0 && !t.hasLivePrice) {
          t.price = row.priceUsd;
          t.hasLivePrice = true;
        }
        if (row.logo) t.imageUrl = t.imageUrl || row.logo;
        t.socials = { ...(t.socials || {}), ...row.socials };
        // Re-score with real liquidity when we got it.
        if (t.liquidity && t.hasLivePrice) {
          const s = EliteScoreEngine.calculate({
            liquidityUsd: t.liquidity,
            volume24hUsd: t.vol24h,
            mcapUsd: t.mcap,
            priceChange24h: t.delta24h,
          });
          t.eliteScore = s.score;
          t.eliteTier = s.tier;
        }
      }
      // 🛡️ Security badges for every token with a known address.
      const secRefs = this.tokens
        .filter((t) => t.tokenAddress)
        .map((t) => ({ address: t.tokenAddress, chain: t.chain }));
      if (secRefs.length) {
        const results = await SecurityFeed.fetchMany(secRefs).catch(() => ({}));
        for (const t of this.tokens) {
          const sec = results[String(t.tokenAddress ?? "").toLowerCase()];
          if (sec) t.security = sec;
        }
      }
      // Holders where an on-chain provider exists (launchpad tokens only —
      // they carry real addresses; keeps requests bounded).
      const withAddr = this.tokens.filter((t) => t.tokenAddress && t.chain).slice(0, 8);
      await Promise.allSettled(
        withAddr.map(async (t) => {
          const data = await ApiClient.request(`/api/tokens/${t.chain}/${t.tokenAddress}/holders?limit=5`);
          if (data && typeof data.stats?.holdersCount === "number") {
            t.holders = data.stats.holdersCount;
            t.top10 = data.stats?.top10Percent ?? null;
          }
        })
      );
      if (this.activeCategory || this.searchQuery) this.render();
    } catch (err) {
      console.warn("[Discover] Dex enrichment failed (rows stay honest):", err);
    }
  },

  /* ── Filter/sort state setters (wired from app.html) ─────────────────── */

  setFilter(key, value) {
    this.filters[key] = value;
    this.render();
  },

  setSort(sort) {
    this.sort = sort;
    this.render();
  },

  toggleQuickChip(chip, btn) {
    this.chips[chip] = !this.chips[chip];
    if (btn) btn.classList.toggle("active", this.chips[chip]);
    this.render();
  },

  toggleFiltersPanel() {
    const panel = document.getElementById("discoverFiltersPanel");
    const btn = document.getElementById("filtersToggleBtn");
    if (!panel) return;
    const open = panel.style.display !== "none";
    panel.style.display = open ? "none" : "block";
    if (btn) btn.classList.toggle("active", !open);
  },

  clearFilters() {
    this.filters = { mcapMin: "", mcapMax: "", volMin: "", txnsMin: "", liqMin: "", hasSocials: false, sector: "" };
    for (const id of ["fMcapMin", "fMcapMax", "fVolMin", "fTxnsMin", "fLiqMin"]) {
      const el = document.getElementById(id);
      if (el) el.value = "";
    }
    const sector = document.getElementById("fSector");
    if (sector) sector.value = "";
    const socials = document.getElementById("fSocials");
    if (socials) socials.checked = false;
    for (const chip of Object.keys(this.chips)) {
      this.chips[chip] = false;
      const btn = document.getElementById("chip" + chip.charAt(0).toUpperCase() + chip.slice(1));
      if (btn) btn.classList.remove("active");
    }
    this.render();
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
    this.scheduleServerSearch();
  },

  /** Debounced server-wide search: launches + traders beyond the static universe. */
  scheduleServerSearch() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    if (this.searchQuery.length < 2) {
      this.serverResults = null;
      return;
    }
    this._searchTimer = setTimeout(async () => {
      const seq = (this._searchSeq = (this._searchSeq || 0) + 1);
      try {
        const data = await ApiClient.search(this.searchQuery, 5);
        if (seq !== this._searchSeq) return; // stale response
        this.serverResults = {
          launches: data?.tokens ?? [],
          users: data?.users ?? [],
        };
      } catch {
        if (seq === this._searchSeq) this.serverResults = null;
      }
      this.render();
    }, 300);
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
    await this.enrichWithDexData();
  },

  /* ── Filtering pipeline ──────────────────────────────────────────────── */

  _num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  },

  /** Does a token pass the advanced numeric/social filters? */
  _passesAdvanced(t) {
    const f = this.filters;
    const mcap = Number(t.mcap ?? 0);
    const vol = Number(t.vol24h ?? 0);
    const txns = Number(t.txns24h ?? 0);
    const liq = Number(t.liquidity ?? 0);
    const mcapMin = this._num(f.mcapMin);
    const mcapMax = this._num(f.mcapMax);
    const volMin = this._num(f.volMin);
    const txnsMin = this._num(f.txnsMin);
    const liqMin = this._num(f.liqMin);
    if (mcapMin !== null && (mcap <= 0 || mcap < mcapMin)) return false;
    if (mcapMax !== null && (mcap <= 0 || mcap > mcapMax)) return false;
    if (volMin !== null && (vol <= 0 || vol < volMin)) return false;
    if (txnsMin !== null && (txns <= 0 || txns < txnsMin)) return false;
    if (liqMin !== null && (liq <= 0 || liq < liqMin)) return false;
    if (f.hasSocials && !Object.keys(t.socials ?? {}).length) return false;
    if (f.sector && t.sector !== f.sector) return false;
    return true;
  },

  /** Does a token pass the active quick chips? */
  _passesChips(t) {
    if (this.chips.launchpad && t.sector !== "Launchpad") return false;
    if (this.chips.graduated && t.launchStatus !== "graduated") return false;
    if (this.chips.holded) {
      const holders = this._holdersProxy(t);
      if (holders === null) return false;
    }
    return true;
  },

  /**
   * Holder proxy, honest edition: launchpad tokens report real buyers_count,
   * enriched tokens report the on-chain holders count when a provider answered.
   * Everything else is "unknown" and excluded from MOST HOLDED.
   */
  _holdersProxy(t) {
    if (t.holders && t.holders > 0) return t.holders;
    if (t.sector === "Launchpad" && t.buyersCount > 0) return t.buyersCount;
    return null;
  },

  _sortList(list) {
    const val = (t) => {
      switch (this.sort) {
        case "mcap": return Number(t.mcap ?? 0);
        case "vol": return Number(t.vol24h ?? 0);
        case "txns": return Number(t.txns24h ?? 0);
        case "liq": return Number(t.liquidity ?? 0);
        case "change": return Number(t.delta24h ?? 0);
        default: return t.eliteScore ?? -1;
      }
    };
    return list.sort((a, b) => val(b) - val(a));
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
      list = list.sort((a, b) => (b.smInflow ?? -1) - (a.smInflow ?? -1));
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
      list = this._sortList(list);
    }

    // Advanced filters + quick chips (applied after category logic).
    list = list.filter((t) => this._passesAdvanced(t) && this._passesChips(t));

    // MOST HOLDED chip re-sorts by holders proxy.
    if (this.chips.holded) {
      list = list.sort((a, b) => (this._holdersProxy(b) ?? 0) - (this._holdersProxy(a) ?? 0));
    }

    if (list.length === 0 && !this.hasServerResults() && !this.chips.narratives) {
      this.container.innerHTML = `
        <div style="padding:40px; text-align:center; color:var(--text-tertiary)">
          No se encontraron activos para los filtros seleccionados.
        </div>
      `;
      return;
    }

    if (this.chips.narratives) {
      this.container.innerHTML = this.renderNarratives(list);
      return;
    }

    this.container.innerHTML =
      this.renderListHeader() +
      list.map((t) => this.renderTokenRow(t)).join("") +
      this.renderServerResults();
  },

  /** Column header strip for the enriched rows (desktop only). */
  renderListHeader() {
    return `
      <div class="desktop-only" style="display:flex; justify-content:flex-end; gap:24px; padding:10px 18px 6px; font-size:9.5px; font-weight:800; letter-spacing:1px; text-transform:uppercase; color:var(--text-tertiary); border-bottom:1px solid var(--border-subtle)">
        <div style="width:76px; text-align:right">Vol 24h</div>
        <div style="width:64px; text-align:right">MCap</div>
        <div style="width:64px; text-align:right">Liq</div>
        <div style="width:58px; text-align:right">Txns</div>
        <div style="width:110px; text-align:right">Precio / 24h</div>
        <div style="width:70px"></div>
      </div>`;
  },

  /** HOT NARRATIVES view: sector heat ranking + tokens of the hottest sectors. */
  renderNarratives(list) {
    const heat = DexFeed.narrativeHeat(this.tokens);
    let html = "";
    if (!heat.length) {
      html += `
        <div style="padding:28px; text-align:center; color:var(--text-tertiary); font-size:12.5px">
          Calentando el radar… sin datos de momentum por sector todavía.<br>
          <span style="font-size:11px">Los sectores se clasifican con volumen y cambio horario reales de DexScreener.</span>
        </div>`;
    } else {
      html += `<div style="padding:16px 18px 4px; font-size:10.5px; font-weight:800; letter-spacing:1px; text-transform:uppercase; color:var(--text-tertiary)">🔥 Calor por narrativa (volumen 6h × |Δ6h|, datos reales)</div>`;
      html += `<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(230px, 1fr)); gap:12px; padding:12px 18px">`;
      for (const s of heat) {
        const logoRow = this.tokens.find((t) => t.sector === s.sector);
        html += `
          <div class="glass-panel-interactive" style="padding:14px; cursor:pointer; border-radius:var(--radius)" onclick="window.DiscoverEngine.focusSector('${String(s.sector).replace(/'/g, "\\'")}')">
            <div style="display:flex; align-items:center; gap:10px">
              ${logoRow ? TokenMeta.logoHtml(logoRow.symbol, { size: 26 }) : ""}
              <div style="font-weight:800; font-size:13px; color:#fff">${String(s.sector)}</div>
              <div style="margin-left:auto; font-weight:900; font-size:13px; color:var(--delta-green)">${s.score}</div>
            </div>
            <div style="margin-top:10px; height:6px; border-radius:3px; background:rgba(255,255,255,0.06); overflow:hidden">
              <div style="height:100%; width:${s.score}%; background:linear-gradient(90deg, var(--delta-green), #fde047); border-radius:3px"></div>
            </div>
            <div style="margin-top:8px; font-size:10.5px; color:var(--text-tertiary)">${s.tokens} token(s) con datos</div>
          </div>`;
      }
      html += `</div>`;
    }
    const rest = list.slice(0, 20);
    if (rest.length) {
      html += `<div style="padding:16px 18px 4px; font-size:10.5px; font-weight:800; letter-spacing:1px; text-transform:uppercase; color:var(--text-tertiary)">Tokens con mejor momentum</div>`;
      html += rest.map((t) => this.renderTokenRow(t)).join("");
    }
    return html + this.renderServerResults();
  },

  /** Click on a narrative card → filter by that sector. */
  focusSector(sector) {
    this.filters.sector = sector;
    this.chips.narratives = false;
    const chipBtn = document.getElementById("chipNarratives");
    if (chipBtn) chipBtn.classList.remove("active");
    const sel = document.getElementById("fSector");
    if (sel) {
      const opt = [...sel.options].find((o) => o.value === sector || o.text === sector);
      if (opt) sel.value = opt.value;
      else {
        const o = document.createElement("option");
        o.textContent = sector;
        sel.appendChild(o);
        sel.value = sector;
      }
    }
    this.render();
  },

  hasServerResults() {
    const r = this.serverResults;
    return !!(r && (r.launches.length || r.users.length));
  },

  /** Social icon links for a token (only real, user-visible links). */
  renderSocialIcons(t) {
    const s = t.socials ?? {};
    const icons = [];
    if (s.twitter) icons.push(`<a href="${s.twitter}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="X / Twitter" style="color:var(--text-tertiary); text-decoration:none; font-size:13px">𝕏</a>`);
    if (s.telegram) icons.push(`<a href="${s.telegram}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="Telegram" style="color:var(--text-tertiary); text-decoration:none; font-size:13px">✈</a>`);
    if (s.website) icons.push(`<a href="${s.website}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="Website" style="color:var(--text-tertiary); text-decoration:none; font-size:12px">🌐</a>`);
    return icons.length ? `<div style="display:flex; gap:7px; align-items:center">${icons.join("")}</div>` : "";
  },

  /** Server-wide matches (launchpad tokens + registered traders) for the active query. */
  renderServerResults() {
    if (!this.searchQuery || this.searchQuery.length < 2) return "";
    const r = this.serverResults;
    if (!r) return "";
    const esc = (s) =>
      String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      })[c]);
    const safe = (s) => String(s ?? "").replace(/[^a-zA-Z0-9_@.\\-]/g, "");
    let html = "";
    if (r.launches.length) {
      html +=
        `<div style="padding:12px 18px 4px; font-size:10.5px; font-weight:800; letter-spacing:1px; text-transform:uppercase; color:var(--text-tertiary)">🚀 Launchpad</div>` +
        r.launches
          .map(
            (l) => `
        <div class="token-row glass-panel-interactive" onclick="window.App.openTradeForToken('${safe(l.symbol)}', '${safe(l.chain)}', 0)" style="display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid var(--border-subtle); cursor:pointer">
          <div style="display:flex; align-items:center; gap:10px; min-width:0">
            ${TokenMeta.logoHtml(l.symbol, { size: 32, round: false, imageUrl: l.imageUrl })}
            <div style="min-width:0">
              <div style="font-size:13px; font-weight:700; color:var(--text-primary)">${esc(l.name)} <span style="color:var(--text-tertiary); font-weight:400">\$${esc(l.symbol)}</span></div>
              <div style="font-size:10.5px; color:var(--text-tertiary)">Launchpad · ${esc(l.chain)}</div>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); window.MarketsEngine && window.MarketsEngine.viewLaunchpad()">Ver</button>
        </div>`
          )
          .join("");
    }
    if (r.users.length) {
      html +=
        `<div style="padding:12px 18px 4px; font-size:10.5px; font-weight:800; letter-spacing:1px; text-transform:uppercase; color:var(--text-tertiary)">👤 Traders</div>` +
        r.users
          .map((u) => {
            const handle = safe(u.x_handle) || `@trader_${u.user_id}`;
            const name = esc(u.display_name || handle);
            return `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid var(--border-subtle)">
          <div style="display:flex; align-items:center; gap:10px; min-width:0">
            <div class="author-avatar" style="width:32px; height:32px; font-size:11px">${esc((u.display_name || handle).replace("@", "").slice(0, 2).toUpperCase())}</div>
            <div style="min-width:0">
              <div style="font-size:13px; font-weight:700; color:var(--text-primary)">${name}</div>
              <div style="font-size:10.5px; color:var(--text-tertiary)">${esc(handle)} · ${Number(u.followers_count ?? 0)} seguidores</div>
            </div>
          </div>
        </div>`;
          })
          .join("");
    }
    if (!html) {
      return `
        <div style="padding:18px; text-align:center; font-size:11.5px; color:var(--text-tertiary)">
          Sin resultados en launchpad o traders para "${esc(this.searchQuery)}"
        </div>`;
    }
    return html;
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
    const formattedLiq = t.liquidity > 0 ? formatNumber(t.liquidity) : "—";
    const formattedTxns = t.txns24h > 0 ? t.txns24h.toLocaleString("en-US") : "—";
    const holders = this._holdersProxy(t);
    const launchBadge =
      t.sector === "Launchpad"
        ? `<span class="brand-badge" style="font-size:9px; background:rgba(253,224,71,0.12); color:#fde047; border:1px solid rgba(253,224,71,0.25)">${t.launchStatus === "graduated" ? "🎓 GRADUATED" : "🚀 LAUNCH"}</span>`
        : "";
    // 🛡️ Security badge (RugCheck/GoPlus) — hidden when unknown, never "safe".
    const secBadge = t.security
      ? `<span title="🛡️ ${String(t.security.title ?? t.security.label ?? "").replace(/[&<>"]'/g, "")}" style="font-size:8.5px; font-weight:800; letter-spacing:0.4px; color:${t.security.level === "good" ? "var(--delta-green)" : t.security.level === "warn" ? "#fde047" : "var(--delta-red)"}; border:1px solid currentColor; border-radius:4px; padding:0 4px; line-height:13px">🛡️ ${t.security.level === "good" ? "OK" : t.security.level === "warn" ? "MED" : "HIGH"}</span>`
      : "";
    const scoreBadge =
      t.eliteScore !== null && t.eliteScore !== undefined
        ? `<div class="elite-badge ${t.eliteScore >= 88 ? 'high' : 'mid'}" title="Elite Score Algorítmico">⚡ ${t.eliteScore}/100</div>`
        : `<div class="elite-badge mid" title="Datos insuficientes para puntuar" style="opacity:0.55">⚡ —</div>`;

    return `
      <div class="token-row glass-panel-interactive" onclick="window.App.openTradeForToken('${t.symbol}', '${t.chain}', ${t.price}, '${t.tokenAddress ?? ""}')" style="display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid var(--border-subtle); cursor:pointer">
        <div style="display:flex; align-items:center; gap:14px">
          <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); window.DiscoverEngine.toggleWatchlist('${t.symbol}')" style="padding:4px; font-size:14px; color:${isSaved ? '#fde047' : 'var(--text-muted)'}" title="Guardar en Watchlist">
            ${isSaved ? '★' : '☆'}
          </button>

          ${TokenMeta.logoHtml(t.symbol, { size: 34, imageUrl: t.imageUrl })}

          <div>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
              <span style="font-weight:800; font-size:14px; color:#fff">${t.symbol}</span>
              <span class="brand-badge" style="font-size:9px">${t.chain.toUpperCase()}</span>
              ${launchBadge}
              ${secBadge}
              ${t.sector ? `<span style="font-size:10px; color:var(--text-tertiary)">${t.sector}</span>` : ''}
              ${holders !== null ? `<span title="${t.holders ? "Holders on-chain" : "Compradores del launchpad"}" style="font-size:10px; color:var(--text-tertiary)">🐋 ${holders.toLocaleString("en-US")}</span>` : ""}
              ${this.renderSocialIcons(t)}
            </div>
            <div style="font-size:12px; color:var(--text-secondary)">${t.name}</div>
          </div>
        </div>

        <div style="display:flex; align-items:center; gap:24px">
          <div class="desktop-only" style="text-align:right; font-family:var(--font-mono); font-size:12px; width:76px">
            <div style="color:var(--text-secondary)">${formattedVol}</div>
          </div>
          <div class="desktop-only" style="text-align:right; font-family:var(--font-mono); font-size:12px; width:64px">
            <div style="color:var(--text-tertiary)">${formattedMcap}</div>
          </div>
          <div class="desktop-only" style="text-align:right; font-family:var(--font-mono); font-size:12px; width:64px">
            <div style="color:${t.liquidity > 0 ? '#fff' : 'var(--text-tertiary)'}">${formattedLiq}</div>
          </div>
          <div class="desktop-only" style="text-align:right; font-family:var(--font-mono); font-size:12px; width:58px">
            <div style="color:${t.txns24h > 0 ? '#fff' : 'var(--text-tertiary)'}">${formattedTxns}</div>
          </div>

          <div style="text-align:right; width:110px">
            ${scoreBadge}
            <div style="font-family:var(--font-mono); font-weight:700; font-size:13.5px; margin-top:3px; color:#fff">${formattedPrice}</div>
            <div style="font-family:var(--font-mono); font-size:11.5px; color:${isUp ? 'var(--delta-green)' : 'var(--delta-red)'}">
              ${isUp ? '+' : ''}${t.delta24h.toFixed(2)}%
            </div>
          </div>

          <div style="display:flex; flex-direction:column; gap:6px">
            <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); window.App.openTradeForToken('${t.symbol}', '${t.chain}', ${t.price})" style="width:70px">
              TRADE
            </button>
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); window.App.openNewPostModal({ token: '${t.symbol}', chain: '${t.chain}', price: ${t.price}, imageUrl: '${String(t.imageUrl ?? "").replace(/'/g, "")}' })" style="width:70px; font-size:10.5px" title="Publicar tesis sobre este token">
              📊 TESIS
            </button>
          </div>
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
