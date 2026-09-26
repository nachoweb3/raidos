/**
 * 🛰️ FOMO RAILS — side rails + bottom ticker tape (FOMO-style shell).
 *
 * Left rail (desktop ≥1280px): Favoritos (majors con precio real de
 * CoinGecko vía PriceFeed) + En tendencia (DexScreener universe), click →
 * terminal. Right rail: top traders del leaderboard real con botón Seguir
 * compacto. Bottom: ticker tape persistente de movers.
 *
 * Honest data only: everything comes from PriceFeed / leaderboard / discover
 * universe already in the app. When a source fails the rail shows its honest
 * empty state — nothing is invented.
 */

import { ApiClient } from "./api.js";
import { DiscoverEngine, PriceFeed } from "./discover.js";
import { SocialEngine } from "./social.js";
import { TokenMeta } from "./tokens.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

/** Compact FOMO-style market cap label: $752.9K MC / $21M MC. */
const fmtMc = (n) => {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return "— MC";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B MC`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M MC`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K MC`;
  return `$${v.toFixed(0)} MC`;
};

/** Signed delta: +123.1% / -1.2%. */
const fmtDelta = (d) => {
  const v = Number(d || 0);
  if (!Number.isFinite(v)) return "";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
};

const fmtPrice = (p) =>
  p < 0.01 ? Number(p).toPrecision(3) : Number(p).toLocaleString("en-US", { maximumFractionDigits: 2 });

export const FomoRails = {
  _built: false,
  _timers: [],

  init() {
    if (this._built) return;
    this._built = true;
    this.buildWatchlist();
    this.buildTraders();
    this.buildTicker();
    // Live refresh: prices 15s, full rebuild 60s (catches new trending tokens).
    this._timers.push(setInterval(() => this.refreshTokenPrices(), 15_000));
    this._timers.push(setInterval(() => { this.buildWatchlist(); this.buildTicker(); }, 60_000));
    this._timers.push(setInterval(() => this.buildTraders(), 90_000));
  },

  /* ── Row data ─────────────────────────────────────────────────────── */

  /** Row for a PriceFeed (reference) symbol; null when there's no live price. */
  rowDataFor(symbol) {
    const row = PriceFeed.get(symbol);
    if (!row || !(row.price > 0)) return null;
    return {
      symbol,
      name: row.name || symbol,
      price: row.price,
      delta: Number.isFinite(row.delta24h) ? row.delta24h : 0,
      mcap: row.mcap || 0,
      chain: "solana",
      address: null,
    };
  },

  /** Row for a discover-universe token (DexScreener-backed). */
  rowFromToken(t) {
    return {
      symbol: String(t.symbol || "").toUpperCase(),
      name: t.name || t.symbol,
      price: t.price,
      delta: Number.isFinite(t.delta24h) ? t.delta24h : 0,
      mcap: t.mcap || 0,
      chain: t.chain,
      address: t.tokenAddress || null,
    };
  },

  /* ── LEFT RAIL — Watchlist (Favoritos + En tendencia) ─────────────── */

  buildWatchlist() {
    // The rail renders into both Feed and Portfolio views.
    const boxes = ["watchRail", "watchRailPortfolio"]
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    if (!boxes.length) return;

    // Favoritos: majors with real CoinGecko prices, mcap-sorted, majors first.
    const favRows = Object.keys(PriceFeed.coinMap)
      .map((s) => this.rowDataFor(s))
      .filter(Boolean)
      .sort((a, b) => (b.mcap || 0) - (a.mcap || 0))
      .slice(0, 8);
    const majors = ["SOL", "BTC", "ETH"];
    const majorsFirst = [];
    for (const s of majors) {
      const idx = favRows.findIndex((r) => r.symbol === s);
      if (idx >= 0) majorsFirst.push(favRows.splice(idx, 1)[0]);
    }
    majorsFirst.push(...favRows);

    // En tendencia: discover universe with live prices, biggest mcap first.
    const trendRows = (DiscoverEngine.tokens || [])
      .filter((t) => t.hasLivePrice && t.price > 0)
      .sort((a, b) => (b.mcap || 0) - (a.mcap || 0))
      .slice(0, 10)
      .map((t) => this.rowFromToken(t));

    // Nothing yet (PriceFeed + discover universe still resolving): show the
    // loading state and let the self-heal timer retry. Don't build empty rails.
    if (!majorsFirst.length && !trendRows.length) {
      this._watchRetry = (this._watchRetry || 0) + 1;
      if (this._watchRetry <= 20) setTimeout(() => this.buildWatchlist(), 3000);
      for (const box of boxes) box.innerHTML = `<div class="rail-empty">Cargando precios…</div>`;
      return;
    }
    this._watchRetry = 0;

    for (const box of boxes) {
      box.innerHTML = "";
      box.appendChild(this.watchGroup("Favoritos", majorsFirst, "Sin precios de referencia ahora mismo."));
      box.appendChild(this.watchGroup("En tendencia", trendRows, "Aún sin tokens en tendencia con precio."));
    }
  },

  watchGroup(title, rows, emptyText) {
    const sec = document.createElement("div");
    sec.className = "rail-group";
    sec.innerHTML = `<div class="rail-group-title">${esc(title)}</div>`;
    if (!rows.length) {
      sec.innerHTML += `<div class="rail-empty">${esc(emptyText)}</div>`;
      return sec;
    }
    for (const row of rows) sec.appendChild(this.watchRow(row));
    return sec;
  },

  watchRow(data) {
    const el = document.createElement("div");
    el.className = "rail-token";
    el.setAttribute("data-rail-symbol", data.symbol);
    el.title = `Abrir $${data.symbol}`;
    el.onclick = () => window.App.openTradeForToken(data.symbol, data.chain || "solana", data.price, data.address);
    const deltaCls = (data.delta ?? 0) >= 0 ? "up" : "down";
    el.innerHTML = `
      ${TokenMeta.logoHtml(data.symbol, { size: 26 })}
      <div class="rail-token-main">
        <div class="rail-token-sym">$${esc(data.symbol)}</div>
        <div class="rail-token-sub mono">${esc(fmtPrice(data.price))}</div>
      </div>
      <div class="rail-token-right">
        <div class="rail-token-price mono">${esc(fmtMc(data.mcap))}</div>
        <div class="rail-token-delta mono ${deltaCls}">${esc(fmtDelta(data.delta))}</div>
      </div>`;
    return el;
  },

  /** Price tick: update price/mcap/delta on already-mounted rows + ticker. */
  refreshTokenPrices() {
    document.querySelectorAll("#watchRail [data-rail-symbol], #watchRailPortfolio [data-rail-symbol]").forEach((el) => {
      // Rows may come from either source; rebuild the label from the matching source.
      const sym = el.getAttribute("data-rail-symbol");
      const token = (DiscoverEngine.tokens || []).find((t) => String(t.symbol).toUpperCase() === sym && t.hasLivePrice);
      const d = token ? this.rowFromToken(token) : this.rowDataFor(sym);
      if (!d) return;
      const sub = el.querySelector(".rail-token-sub");
      const price = el.querySelector(".rail-token-price");
      const delta = el.querySelector(".rail-token-delta");
      if (sub) sub.textContent = fmtPrice(d.price);
      if (price) price.textContent = fmtMc(d.mcap);
      if (delta) {
        delta.textContent = fmtDelta(d.delta);
        delta.className = `rail-token-delta mono ${(d.delta ?? 0) >= 0 ? "up" : "down"}`;
      }
    });
    // Ticker tape items (price + delta only; mcap is not shown there).
    document.querySelectorAll("#fomoTicker .ticker-item[data-ticker-symbol]").forEach((el) => {
      const sym = el.getAttribute("data-ticker-symbol");
      const token = (DiscoverEngine.tokens || []).find((t) => String(t.symbol).toUpperCase() === sym && t.hasLivePrice);
      const d = token ? this.rowFromToken(token) : this.rowDataFor(sym);
      if (!d) return;
      const price = el.querySelector(".ticker-price");
      const delta = el.querySelector(".ticker-delta");
      if (price) price.textContent = fmtPrice(d.price);
      if (delta) {
        const up = (d.delta ?? 0) >= 0;
        delta.textContent = `${up ? "↑" : "↓"} ${fmtDelta(d.delta)}`;
        delta.className = `ticker-delta mono ${up ? "up" : "down"}`;
      }
    });
  },

  /* ── RIGHT RAIL — Sigue a los mejores traders ─────────────────────── */

  async buildTraders() {
    // Same dual-mount as the watch rail (Feed + Portfolio views).
    const boxes = ["tradersRail", "tradersRailPortfolio"]
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    if (!boxes.length) return;
    const box = boxes[0];
    if (!box.childElementCount) box.innerHTML = `<div class="rail-empty">Cargando ranking…</div>`;
    try {
      const data = await ApiClient.getLeaderboard("all", 12);
      const leaders = (data?.leaders ?? []).filter((l) => l && (l.display_name || l.x_handle)).slice(0, 12);
      if (!leaders.length) {
        box.innerHTML = `<div class="rail-empty">El ranking está abierto — haz tu primer trade para aparecer.</div>`;
        return;
      }
      box.innerHTML = "";
      for (const l of leaders) {
        const name = String(l.display_name || l.x_handle || "trader").slice(0, 16);
        const handle = "@" + String(l.x_handle || name).replace(/[^a-zA-Z0-9_.\-]/g, "").replace(/^@/, "").slice(0, 14);
        const userId = Number(l.user_id) || 0;
        const row = document.createElement("div");
        row.className = "rail-trader";
        row.innerHTML = `
          ${TokenMeta.avatarHtml(name, { size: 28 })}
          <div class="rail-trader-main">
            <div class="rail-trader-name">${esc(name)}</div>
            <div class="rail-trader-handle mono">${esc(handle)}</div>
          </div>
          <button class="rail-follow-btn" title="Seguir a ${esc(name)}">Seguir</button>`;
        row.querySelector(".rail-follow-btn").onclick = (ev) => {
          ev.stopPropagation();
          SocialEngine.toggleFollow(userId, handle).then(() => {
            const now = SocialEngine.followingIds.has(userId) || SocialEngine.followingSet.has(handle);
            ev.target.classList.toggle("following", now);
            ev.target.textContent = now ? "Siguiendo" : "Seguir";
          }).catch(() => {});
        };
        for (const b of boxes) b.appendChild(row.cloneNode(true));
      }
      // Wire the follow buttons on every mounted copy.
      for (const b of boxes) {
        b.querySelectorAll(".rail-follow-btn").forEach((btn, i) => {
          const l = leaders[i];
          if (!l) return;
          btn.onclick = (ev) => {
            ev.stopPropagation();
            SocialEngine.toggleFollow(Number(l.user_id) || 0, "@" + String(l.x_handle || l.display_name || "").replace(/[^a-zA-Z0-9_.\-]/g, "")).then(() => {
              const now = SocialEngine.followingIds.has(Number(l.user_id) || 0) || SocialEngine.followingSet.has("@" + String(l.x_handle || "").replace(/[^a-zA-Z0-9_.\-]/g, ""));
              btn.classList.toggle("following", now);
              btn.textContent = now ? "Siguiendo" : "Seguir";
            }).catch(() => {});
          };
        });
      }
    } catch {
      for (const b of boxes) b.innerHTML = `<div class="rail-empty">Ranking no disponible ahora mismo.</div>`;
    }
  },

  /* ── BOTTOM TICKER TAPE ───────────────────────────────────────────── */

  tickerItemHtml(d) {
    const up = (d.delta ?? 0) >= 0;
    return `
      <span class="ticker-item" data-ticker-symbol="${esc(d.symbol)}" title="Abrir $${esc(d.symbol)} en el terminal">
        <span class="ticker-star">★</span>
        <span class="ticker-sym">$${esc(d.symbol)}</span>
        <span class="ticker-price mono">${esc(fmtPrice(d.price))}</span>
        <span class="ticker-delta mono ${up ? "up" : "down"}">${up ? "↑" : "↓"} ${esc(fmtDelta(d.delta))}</span>
      </span>`;
  },

  buildTicker() {
    const bar = document.getElementById("fomoTicker");
    if (!bar) return;
    const track = bar.querySelector(".ticker-track");
    if (!track) return;

    const movers = (DiscoverEngine.tokens || [])
      .filter((t) => t.hasLivePrice && t.price > 0 && Number.isFinite(t.delta24h))
      .sort((a, b) => Math.abs(b.delta24h) - Math.abs(a.delta24h))
      .slice(0, 12)
      .map((t) => this.rowFromToken(t));
    // Majors always present, even when the universe is still loading.
    for (const sym of ["SOL", "BTC", "ETH"]) {
      if (!movers.some((m) => m.symbol === sym)) {
        const d = this.rowDataFor(sym);
        if (d) movers.push(d);
      }
    }

    const statusChip = `<span class="ticker-item ticker-status"><span class="ticker-dot"></span> Estable</span>`;
    const seq = movers.length
      ? movers.map((d) => this.tickerItemHtml(d)).join("") + statusChip
      : `<span class="ticker-item"><span class="ticker-sym" style="color:var(--text-tertiary)">Precios en vivo no disponibles ahora mismo</span></span>`;
    // Nothing yet (feeds still resolving): self-heal like the watch rail.
    if (!movers.length) {
      this._tickerRetry = (this._tickerRetry || 0) + 1;
      if (this._tickerRetry <= 20) setTimeout(() => this.buildTicker(), 3000);
    } else {
      this._tickerRetry = 0;
    }
    // Duplicate the sequence for a seamless loop (CSS marquee translates -50%).
    track.innerHTML = `<div class="ticker-seq">${seq}</div><div class="ticker-seq" aria-hidden="true">${seq}</div>`;

    // Click → terminal (delegated once per build; rows carry their symbol).
    track.querySelectorAll(".ticker-item[data-ticker-symbol]").forEach((item) => {
      item.onclick = () => {
        const sym = item.getAttribute("data-ticker-symbol");
        const token = (DiscoverEngine.tokens || []).find((t) => String(t.symbol).toUpperCase() === sym && t.hasLivePrice);
        const d = token ? this.rowFromToken(token) : this.rowDataFor(sym);
        if (d) window.App.openTradeForToken(d.symbol, d.chain || "solana", d.price, d.address);
      };
    });
  },
};

window.FomoRails = FomoRails;
