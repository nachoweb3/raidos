/**
 * 🪙 TOKEN META ENGINE — one shared layer for token logos, names and colors.
 * Every token row in the app (Discover, Feed pills, Terminal, Portfolio,
 * Launchpad) renders its logo through TokenMeta.logoHtml() so all assets get a
 * real logo when one exists and a deterministic colored-initials badge when it
 * doesn't. No invented images: sources are, in priority order —
 *   1. explicit imageUrl (launchpad rows / API payloads)
 *   2. live CoinGecko image via PriceFeed (registered by discover.js)
 *   3. curated static fallbacks (CoinGecko CDN, stable well-known coins)
 *   4. launchpad metadata from GET /api/tokens/meta (server-side DB)
 *   5. colored initials fallback (always renders, never breaks)
 */

import { ApiClient } from "./api.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

export const TokenMeta = {
  /** Curated fallback logos (stable, well-known CoinGecko CDN assets). */
  logoUrls: {
    BTC: "https://assets.coingecko.com/coins/images/1/large/bitcoin.png",
    ETH: "https://assets.coingecko.com/coins/images/279/large/ethereum.png",
    SOL: "https://assets.coingecko.com/coins/images/4128/large/solana-1644736111.png",
    BNB: "https://assets.coingecko.com/coins/images/825/large/bnb-icon2_2x.png",
    USDC: "https://assets.coingecko.com/coins/images/6319/large/usdc.png",
    POL: "https://assets.coingecko.com/coins/images/47139/large/polygon.png",
    PEPE: "https://assets.coingecko.com/coins/images/29850/large/pepe-token.jpeg",
    BONK: "https://assets.coingecko.com/coins/images/24678/large/bonk.jpeg",
    JUP: "https://assets.coingecko.com/coins/images/32627/large/jupiter-logo.png",
    GMX: "https://assets.coingecko.com/coins/images/14221/large/gmx.png",
    PENDLE: "https://assets.coingecko.com/coins/images/13469/large/pdle.png",
  },

  /** Display names for tokens we can't resolve from a live feed. */
  names: {
    USDC: "USD Coin",
    BTC: "Bitcoin",
    ETH: "Ethereum",
    SOL: "Solana",
    BNB: "BNB",
    POL: "Polygon Ecosystem",
  },

  /**
   * Well-known on-chain token contracts/mints → symbol. Holdings and positions
   * often key by raw address; without this they render as ugly address prefixes
   * instead of the real logo. Only canonical, verified addresses live here.
   */
  wellKnown: {
    // Solana
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", name: "USD Coin" },
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", name: "Tether USD" },
    So11111111111111111111111111111111111111112: { symbol: "SOL", name: "Solana (wrapped)" },
    DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: "BONK", name: "Bonk" },
    EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: "WIF", name: "dogwifhat" },
    JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", name: "Jupiter" },
    // Ethereum
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": { symbol: "USDC", name: "USD Coin" },
    "0xdAC17F958D2ee523a2206206994597C13D831ec7": { symbol: "USDT", name: "Tether USD" },
    "0x6982508145454Ce325dDbE47a25d4ec3d2311933": { symbol: "PEPE", name: "Pepe" },
    // Base
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": { symbol: "USDC", name: "USD Coin" },
    // BSC
    "0x2170Ed0880ac9A755fd29B2688956BD959F933F8": { symbol: "ETH", name: "Ethereum (BSC)" },
    "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c": { symbol: "BNB", name: "BNB" },
    // Polygon
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359": { symbol: "USDC", name: "USD Coin" },
  },

  /** Launchpad metadata from the backend: symbol → { name, imageUrl, chain, tokenAddress }. */
  serverMeta: {},
  serverMetaAt: 0,
  serverMetaTtlMs: 10 * 60 * 1000,

  /** PriceFeed registers itself here (avoids a circular module import). */
  _priceFeed: null,

  setPriceFeed(priceFeed) {
    this._priceFeed = priceFeed;
  },

  /** Pull launchpad token metadata (names + images) once per session. */
  async ensureServerMeta(force = false) {
    if (!force && Date.now() - this.serverMetaAt < this.serverMetaTtlMs && Object.keys(this.serverMeta).length) {
      return this.serverMeta;
    }
    try {
      const data = await ApiClient.getTokenMeta();
      const map = {};
      for (const [sym, m] of Object.entries(data?.meta ?? {})) {
        map[String(sym).toUpperCase()] = m;
      }
      this.serverMeta = map;
      this.serverMetaAt = Date.now();
    } catch {
      // offline / API down — initials fallbacks keep the UI whole
    }
    return this.serverMeta;
  },

  /**
   * Resolve the best display symbol for a raw token reference. Holdings and
   * positions may arrive keyed by mint/contract address — well-known addresses
   * map to their real ticker; a backend-provided symbol wins only when it is
   * meaningful (not a truncated address prefix).
   */
  resolveSymbol(rawToken, fallbackSymbol = "") {
    const raw = String(rawToken || "").trim();
    const known = this.wellKnown[raw] ?? this.wellKnown[raw.toLowerCase()] ?? null;
    if (known) return known.symbol;
    const fb = String(fallbackSymbol || "").trim();
    // A "symbol" that is just the first chars of the raw address is not a symbol.
    if (fb && fb.toUpperCase() !== raw.slice(0, fb.length).toUpperCase()) return fb.toUpperCase();
    return (raw.length > 20 ? raw.slice(0, 6) : raw).toUpperCase();
  },

  /** Best image URL for a symbol, or null when only the initials badge applies. */
  imageFor(symbol, explicit = null) {
    const sym = String(symbol || "").toUpperCase();
    if (explicit) return explicit;
    const row = this._priceFeed?.get?.(sym);
    if (row?.image) return row.image;
    if (this.logoUrls[sym]) return this.logoUrls[sym];
    if (this.serverMeta[sym]?.imageUrl) return this.serverMeta[sym].imageUrl;
    return null;
  },

  /** Best display name for a symbol (falls back to the symbol itself). */
  nameFor(symbol) {
    const sym = String(symbol || "").toUpperCase();
    return (
      this.names[sym] ||
      this._priceFeed?.get?.(sym)?.name ||
      this.serverMeta[sym]?.name ||
      sym
    );
  },

  /** Display name for a raw token reference (address-aware). */
  nameForToken(rawToken, fallbackSymbol = "") {
    const raw = String(rawToken || "").trim();
    const known = this.wellKnown[raw] ?? this.wellKnown[raw.toLowerCase()] ?? null;
    if (known) return known.name;
    const sym = this.resolveSymbol(raw, fallbackSymbol);
    return this.nameFor(sym);
  },

  /** Deterministic dark tone per symbol so initials badges feel branded. */
  colorFor(symbol) {
    const sym = String(symbol || "?").toUpperCase();
    let h = 0;
    for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) % 360;
    return `hsl(${h}, 45%, 20%)`;
  },

  /**
   * Render a token logo: real image layered over a colored initials badge.
   * If the image 404s or never loads, the badge underneath simply shows —
   * the row never renders broken-image icons.
   * opts: { size=32, round=true, imageUrl, title }
   */
  logoHtml(symbol, opts = {}) {
    const sym = String(symbol || "?").toUpperCase();
    const size = opts.size ?? 32;
    const radius = opts.round === false ? "12px" : "50%";
    const url = this.imageFor(sym, opts.imageUrl);
    const initials = esc(sym.slice(0, 4));
    const fontPx = Math.max(8, Math.round(size / 2.7));
    const badge = `<div style="position:absolute;inset:0;border-radius:${radius};background:${this.colorFor(sym)};border:1px solid var(--border-subtle, rgba(255,255,255,0.08));display:flex;align-items:center;justify-content:center;font-weight:800;font-size:${fontPx}px;color:#fff;letter-spacing:-0.02em;overflow:hidden">${initials}</div>`;
    const img = url
      ? `<img src="${esc(url)}" alt="${esc(sym)}" loading="lazy" referrerpolicy="no-referrer" style="position:absolute;inset:0;width:100%;height:100%;border-radius:${radius};object-fit:cover;background:rgba(255,255,255,0.04)" onerror="this.remove()">`
      : "";
    return `<div style="position:relative;width:${size}px;height:${size}px;flex-shrink:0" title="${esc(opts.title || this.nameFor(sym))}">${badge}${img}</div>`;
  },

  /** Load an image element for canvas drawing (share cards); resolves null on failure. */
  loadImage(url) {
    return new Promise((resolve) => {
      if (!url) return resolve(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  },

  /** Draw a circular-cropped token logo onto a 2D canvas context. */
  async drawOnCanvas(ctx, symbol, x, y, size) {
    const img = await this.loadImage(this.imageFor(symbol));
    if (!img) return false;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    try {
      ctx.drawImage(img, x, y, size, size);
    } catch {
      ctx.restore();
      return false;
    }
    ctx.restore();
    return true;
  },
};

window.TokenMeta = TokenMeta;
