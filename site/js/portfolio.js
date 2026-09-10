/**
 * 📊 PORTFOLIO ENGINE — real stats, positions, holdings and trade history.
 * Data comes from GET /api/portfolio (PnL + holdings + positions) plus
 * /api/trades and /api/wallets. Every token renders its logo through the
 * shared TokenMeta layer. Honest empty states — nothing is invented here.
 */

import { ApiClient } from "./api.js";
import { TokenMeta } from "./tokens.js";
import { PriceFeed } from "./discover.js";

const fmtUsd = (n) =>
  (n < 0 ? "-$" : "$") +
  Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtUsdMicro = (raw) => {
  // Backend stores USDC amounts as integer micro-USDC (1e6) strings
  const n = Number(raw) / 1e6;
  return Number.isFinite(n) ? fmtUsd(n) : "$0.00";
};

const signedUsdMicro = (raw) => {
  const n = Number(raw || 0) / 1e6;
  return (n >= 0 ? "+" : "") + fmtUsd(n);
};

/** HTML-escape for profile strings rendered into innerHTML. */
const escHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

export const PortfolioEngine = {
  container: null,
  trades: [],
  positions: [],
  holdings: [],
  profile: null,
  pnl: null,
  wallets: [],
  loading: false,
  loadedOnce: false,

  init() {
    const btn = document.getElementById("refreshPortfolioBtn");
    if (btn) btn.addEventListener("click", () => this.load());
  },

  /* ── Advanced profile (photo, name, bio, socials) ───────────────────── */

  /** Display name: profile → "Trader" fallback (never an empty header). */
  displayName() {
    const n = String(this.profile?.displayName ?? "").trim();
    return n || "Trader";
  },

  /** Avatar: real photo when the profile has one, initials badge otherwise. */
  renderAvatar(size = 64) {
    const url = String(this.profile?.avatarUrl ?? "");
    const initials = escHtml(this.displayName().replace(/@/, "").slice(0, 2).toUpperCase() || "ME");
    const badge = `<div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:${Math.round(size / 2.6)}px; color:#fff">${initials}</div>`;
    const img = url
      ? `<img src="${escHtml(url)}" alt="" referrerpolicy="no-referrer" style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover" onerror="this.previousElementSibling.style.display='flex'">`
      : "";
    return `<div style="position:relative; width:${size}px; height:${size}px; border-radius:50%; overflow:hidden; background:rgba(255,255,255,0.06); border:1px solid var(--border-subtle); flex-shrink:0">
      <div style="position:absolute; inset:0; display:flex">${badge}</div>
      ${img}
    </div>`;
  },

  /** Social icon links (only https URLs from the profile). */
  renderSocialLinks() {
    const s = this.profile?.socialLinks ?? {};
    const icon = (href, glyph, title) =>
      `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer" title="${title}" style="color:var(--text-secondary); text-decoration:none; font-size:14px" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='var(--text-secondary)'">${glyph}</a>`;
    const links = [];
    if (this.profile?.xHandle) links.push(`<span style="font-size:11.5px; color:var(--text-tertiary); font-family:var(--font-mono)">@${escHtml(this.profile.xHandle)}</span>`);
    if (s.twitter) links.push(icon(s.twitter, "𝕏", "X / Twitter"));
    if (s.telegram) links.push(icon(s.telegram, "✈", "Telegram"));
    if (s.discord) links.push(icon(s.discord, "🎮", "Discord"));
    if (s.website) links.push(icon(s.website, "🌐", "Website"));
    return links.join("");
  },

  openEditModal() {
    const p = this.profile ?? {};
    const s = p.socialLinks ?? {};
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = v ?? "";
    };
    set("epDisplayName", p.displayName);
    set("epBio", p.bio);
    set("epAvatarUrl", p.avatarUrl);
    set("epXHandle", p.xHandle);
    set("epTwitter", s.twitter);
    set("epTelegram", s.telegram);
    set("epDiscord", s.discord);
    set("epWebsite", s.website);
    this._updateAvatarPreview();
    const avatarInput = document.getElementById("epAvatarUrl");
    if (avatarInput && !avatarInput.dataset.wired) {
      avatarInput.addEventListener("input", () => this._updateAvatarPreview());
      avatarInput.dataset.wired = "1";
    }
    const err = document.getElementById("editProfileError");
    if (err) err.style.display = "none";
    document.getElementById("editProfileModal")?.classList.add("active");
  },

  _updateAvatarPreview() {
    const box = document.getElementById("editProfileAvatarPreview");
    if (!box) return;
    const url = String(document.getElementById("epAvatarUrl")?.value ?? "").trim();
    const initials = escHtml(String(document.getElementById("epDisplayName")?.value ?? "ME").replace(/@/, "").slice(0, 2).toUpperCase() || "ME");
    if (url) {
      box.innerHTML = `<img src="${escHtml(url)}" alt="" style="width:100%; height:100%; object-fit:cover" onerror="this.remove()">` + `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center">${initials}</div>`;
    } else {
      box.innerHTML = initials;
    }
  },

  closeEditModal() {
    document.getElementById("editProfileModal")?.classList.remove("active");
  },

  async saveProfileEdit(ev) {
    ev.preventDefault();
    const val = (id) => String(document.getElementById(id)?.value ?? "").trim();
    const patch = {
      displayName: val("epDisplayName"),
      bio: val("epBio"),
      avatarUrl: val("epAvatarUrl"),
      xHandle: val("epXHandle"),
      socialLinks: {
        twitter: val("epTwitter"),
        telegram: val("epTelegram"),
        discord: val("epDiscord"),
        website: val("epWebsite"),
      },
    };
    // Empty strings mean "clear" for socials; keep them, drop absent ones.
    for (const k of Object.keys(patch.socialLinks)) {
      if (!patch.socialLinks[k]) delete patch.socialLinks[k];
    }
    const btn = document.getElementById("epSaveBtn");
    const errBox = document.getElementById("editProfileError");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Guardando…";
    }
    if (errBox) errBox.style.display = "none";
    try {
      const res = await ApiClient.updateMyProfile(patch);
      this.profile = { ...(this.profile ?? {}), ...(res?.profile ?? {}) };
      this.closeEditModal();
      this.render();
    } catch (e) {
      if (errBox) {
        errBox.textContent = e?.message ?? "No se pudo guardar el perfil";
        errBox.style.display = "block";
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Guardar perfil";
      }
    }
  },

  async load() {
    if (this.loading) return;
    this.loading = true;
    if (!this.loadedOnce) this.renderLoading();
    try {
      const authed = ApiClient.isBetaUnlocked();
      if (!authed) {
        this.renderSignedOut();
        return;
      }

      // Portfolio snapshot (PnL + holdings + positions) in one call; profile,
      // trades and wallets may fail independently without killing the view.
      const [portfolioRes, profileRes, tradesRes, walletsRes] = await Promise.all([
        ApiClient.getPortfolio(),
        ApiClient.getMyProfile().catch(() => null),
        ApiClient.getTrades(50).catch(() => ({ trades: [] })),
        ApiClient.getWallets().catch(() => ({ wallets: [] })),
      ]);

      this.pnl = portfolioRes?.pnl ?? null;
      this.holdings = portfolioRes?.holdings ?? [];
      this.positions = portfolioRes?.positions ?? [];
      this.profile = profileRes?.profile ?? null;
      this.trades = tradesRes?.trades ?? [];
      this.wallets = walletsRes?.wallets ?? [];
      this.loadedOnce = true;
      this.render();
    } catch (e) {
      console.warn("[Portfolio] load failed:", e);
      const msg = String(e?.message || "");
      if (msg.includes("401") || /unauthorized|no auth|api key/i.test(msg)) {
        this.renderSignedOut();
      } else {
        this.renderError();
      }
    } finally {
      this.loading = false;
    }
  },

  /* ── States ────────────────────────────────────────────────────────── */

  renderLoading() {
    const el = this.target();
    if (!el) return;
    el.innerHTML = `
      <div class="glass-panel" style="padding:48px 28px; text-align:center">
        <div class="loading-pulse" style="font-size:30px; margin-bottom:12px">📊</div>
        <div style="font-size:13px; color:var(--text-secondary)">Cargando tu portfolio…</div>
      </div>`;
  },

  renderSignedOut() {
    const el = this.target();
    if (!el) return;
    el.innerHTML = `
      <div class="glass-panel" style="padding:40px 28px; text-align:center">
        <div style="font-size:34px; margin-bottom:12px">🔒</div>
        <h2 style="font-size:18px; font-weight:800; margin-bottom:8px">Conecta tu wallet para ver tu portfolio</h2>
        <p style="font-size:13px; color:var(--text-secondary); margin-bottom:20px">
          Tus estadísticas, posiciones e historial son privados hasta que inicies sesión.
        </p>
        <button class="btn btn-primary btn-lg" onclick="window.App.openWalletModal()">Conectar Wallet</button>
      </div>`;
  },

  renderError() {
    const el = this.target();
    if (!el) return;
    el.innerHTML = `
      <div class="glass-panel" style="padding:40px 28px; text-align:center">
        <div style="font-size:34px; margin-bottom:12px">⚠️</div>
        <h2 style="font-size:18px; font-weight:800; margin-bottom:8px">No se pudo cargar el portfolio</h2>
        <p style="font-size:13px; color:var(--text-secondary); margin-bottom:20px">Inténtalo de nuevo en unos segundos.</p>
        <button class="btn btn-secondary btn-lg" onclick="window.PortfolioEngine.load()">Reintentar</button>
      </div>`;
  },

  target() {
    return document.getElementById("view-profile");
  },

  /* ── Derived numbers ───────────────────────────────────────────────── */

  /** Open positions only, newest first. */
  openPositions() {
    return this.positions
      .filter((p) => p.status === "open" && Number(p.amount_remaining || 0) > 0)
      .sort((a, b) => (b.opened_at || 0) - (a.opened_at || 0));
  },

  /** Live value of a position: remaining tokens × current price (PriceFeed). */
  positionValue(p) {
    const sym = this.symbolFor(p);
    const row = PriceFeed.get(sym);
    const units = Number(p.amount_remaining || 0) / 1e6;
    if (row?.price > 0) return { value: units * row.price, price: row.price, live: true, units };
    return { value: null, price: 0, live: false, units };
  },

  /**
   * Best display symbol for a position/holding row. Backend symbols win only
   * when they are meaningful — a "symbol" that is just the raw mint/contract
   * prefix (e.g. EPjFWd for Solana USDC) is replaced by TokenMeta's address map.
   */
  symbolFor(p) {
    const raw = String(p.token || "");
    const fb = p.symbol || p.token_symbol || "";
    return TokenMeta.resolveSymbol(raw, fb);
  },

  totalOpenValue() {
    let total = 0;
    let allLive = true;
    for (const p of this.openPositions()) {
      const v = this.positionValue(p);
      if (v.live) total += v.value;
      else allLive = false;
    }
    return { total, allLive };
  },

  /* ── Render ────────────────────────────────────────────────────────── */

  render() {
    const el = this.target();
    if (!el) return;
    const pnl = this.pnl || {};

    const winRate = pnl.totalTrades > 0 ? (pnl.winningTrades / pnl.totalTrades) * 100 : 0;
    const open = this.openPositions();
    const pnlColor = Number(pnl.totalPnlUsdc || 0) >= 0 ? "var(--delta-green)" : "var(--delta-red)";
    const openVal = this.totalOpenValue();
    const netWorth = openVal.allLive ? fmtUsd(openVal.total) : "—";

    el.innerHTML = `
      <!-- Advanced profile header -->
      <div class="glass-panel" style="padding:28px; margin-bottom:20px">
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:16px">
          <div style="display:flex; align-items:center; gap:16px; min-width:0">
            ${this.renderAvatar(64)}
            <div style="min-width:0">
              <h2 style="font-size:20px; font-weight:800; display:flex; align-items:center; gap:8px; flex-wrap:wrap">
                ${escHtml(this.displayName())}
                <button class="btn btn-ghost btn-sm" onclick="window.PortfolioEngine.openEditModal()" title="Editar perfil" style="padding:2px 8px; font-size:12px">✏️</button>
              </h2>
              ${this.profile?.bio ? `<div style="font-size:12.5px; color:var(--text-secondary); margin-top:2px; max-width:520px">${escHtml(this.profile.bio)}</div>` : ""}
              <div style="display:flex; align-items:center; gap:10px; margin-top:6px; flex-wrap:wrap">
                ${this.renderSocialLinks()}
                <span style="font-size:11px; color:var(--text-tertiary); font-family:var(--font-mono)">
                  ${this.profile?.joinedAt ? "Miembro desde " + new Date(this.profile.joinedAt * 1000).toLocaleDateString("es-ES", { month: "short", year: "numeric" }) : "Wallet no custodial cifrada (AES-GCM)"}
                </span>
              </div>
            </div>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap">
            <button class="btn btn-secondary btn-sm" onclick="window.PortfolioEngine.load()">↻ Actualizar</button>
            <button class="btn btn-secondary btn-sm" onclick="window.App.openWalletModal()">Gestionar Billeteras</button>
          </div>
        </div>

        <!-- Portfolio Stats -->
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:16px; margin-top:24px">
          ${this.statCard("VALOR ABIERTO", netWorth, "#fff", openVal.allLive ? "a precios en vivo" : "sin precios en vivo")}
          ${this.statCard("PNL REALIZADO", signedUsdMicro(pnl.totalPnlUsdc), pnlColor)}
          ${this.statCard("WIN RATE", winRate.toFixed(0) + "%", "#fff")}
          ${this.statCard("POSICIONES ABIERTAS", String(open.length), "#fff")}
        </div>

        <!-- Secondary stats -->
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:16px; margin-top:12px">
          ${this.statCard("OPERACIONES", String(pnl.totalTrades || 0), "#fff")}
          ${this.statCard("VOLUMEN TOTAL", fmtUsdMicro(pnl.volumeUsdc), "#fff")}
          ${this.statCard("COMISIONES", fmtUsdMicro(pnl.totalFeesUsdc), "#fff")}
          ${this.statCard(
            "MEJOR OPERACIÓN",
            signedUsdMicro(pnl.bestTradePnlUsdc),
            Number(pnl.bestTradePnlUsdc || 0) > 0 ? "var(--delta-green)" : "#fff"
          )}
        </div>
      </div>`;

    this.appendHoldings();
    this.appendPositions();
    this.appendTrades();
    this.appendWallets();

    const credit = document.createElement("div");
    credit.style.cssText =
      "margin-top:32px; padding-top:20px; border-top:1px solid var(--border-subtle); text-align:center; font-size:13px; color:var(--text-secondary)";
    credit.innerHTML = `
      Designed by <a href="https://x.com/nacho_web3_" target="_blank" rel="noopener noreferrer" style="color:#ffffff; font-weight:700; text-decoration:underline; text-underline-offset:3px">@nacho_web3_ on 𝕏</a>
      <div style="font-size:11px; color:var(--text-tertiary); margin-top:6px; font-family:var(--font-mono)">
        TRENCHES · Mobile-First Social Trading Terminal · © 2027
      </div>`;
    el.appendChild(credit);

    // Premium & referrals panels (created/filled by premium.js)
    window.PremiumEngine?.render();
  },

  statCard(label, value, color, sub) {
    return `
      <div style="padding:14px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:var(--radius-md)">
        <div style="font-size:11px; color:var(--text-tertiary)">${label}</div>
        <div class="mono" style="font-size:20px; font-weight:800; color:${color}; margin-top:4px">${value}</div>
        ${sub ? `<div style="font-size:10px; color:var(--text-tertiary); margin-top:2px">${sub}</div>` : ""}
      </div>`;
  },

  /* ── Holdings (from /api/portfolio pnlByToken, with logos + live value) ── */

  appendHoldings() {
    const rows = this.holdings
      .filter((h) => Number(h.balance || 0) !== 0 || Number(h.realizedPnlUsdc || 0) !== 0)
      .sort((a, b) => Math.abs(Number(b.balance || 0)) - Math.abs(Number(a.balance || 0)))
      .slice(0, 12);

    const panel = this.makePanel(
      "💼 Mis Holdings",
      "Sin tokens en tu portfolio todavía. Compra en la pestaña Trade o en el Launchpad.",
      rows,
      (h) => {
        const sym = this.symbolFor(h);
        const units = Number(h.balance || 0) / 1e6;
        const row = PriceFeed.get(sym);
        const live = row?.price > 0;
        const value = live ? units * row.price : null;
        const pnlNum = Number(h.realizedPnlUsdc || 0);
        const pnlColor = pnlNum > 0 ? "var(--delta-green)" : pnlNum < 0 ? "var(--delta-red)" : "var(--text-tertiary)";
        const tokenName = TokenMeta.nameForToken(h.token, sym);
        const sub = h.chain
          ? String(h.chain).toUpperCase()
          : tokenName !== sym
            ? tokenName
            : "TOKEN";
        return `
        <div style="display:flex; align-items:center; gap:10px; min-width:0">
          ${TokenMeta.logoHtml(sym, { size: 30, imageUrl: TokenMeta.serverMeta[sym]?.imageUrl })}
          <div style="min-width:0">
            <div style="font-weight:800; font-size:13.5px">$${sym}</div>
            <div style="font-size:10.5px; color:var(--text-tertiary)">${sub}</div>
          </div>
        </div>
        <div style="text-align:right">
          <div class="mono" style="font-weight:800; font-size:13.5px; color:#fff">${value !== null ? fmtUsd(value) : "—"}</div>
          <div style="font-size:10.5px; color:var(--text-tertiary)">
            ${units.toLocaleString("en-US", { maximumFractionDigits: 4 })} unidades
            ${pnlNum !== 0 ? ` · <span style="color:${pnlColor}">PnL ${signedUsdMicro(h.realizedPnlUsdc)}</span>` : ""}
          </div>
        </div>`;
      }
    );
    this.target().appendChild(panel);
  },

  /* ── Open positions (from /api/positions rows) ── */

  appendPositions() {
    const open = this.openPositions().slice(0, 10);
    const panel = this.makePanel(
      "📈 Posiciones Abiertas",
      "Aún no tienes posiciones abiertas. Ejecuta tu primer swap en la pestaña Trade.",
      open,
      (p) => {
        const sym = this.symbolFor(p);
        const v = this.positionValue(p);
        const invested = Number(p.net_invested_usdc || 0) / 1e6;
        const unrealized = v.live && invested > 0 ? v.value - invested : null;
        const uColor = unrealized === null ? "var(--text-tertiary)" : unrealized >= 0 ? "var(--delta-green)" : "var(--delta-red)";
        return `
        <div style="display:flex; align-items:center; gap:10px; min-width:0">
          ${TokenMeta.logoHtml(sym, { size: 30 })}
          <div style="min-width:0">
            <div style="font-weight:800; font-size:14px">$${sym}</div>
            <div style="font-size:11px; color:var(--text-tertiary); text-transform:uppercase">
              ${p.chain} · entrada ${fmtUsdMicro(p.avg_entry_usdc)}
            </div>
          </div>
        </div>
        <div style="text-align:right">
          <div class="mono" style="font-weight:800; font-size:14px; color:#fff">${v.live ? fmtUsd(v.value) : fmtUsdMicro(p.net_invested_usdc)}</div>
          <div style="font-size:11px; color:var(--text-tertiary)">
            ${v.live
              ? `${unrealized >= 0 ? "+" : ""}${fmtUsd(unrealized).replace("$", "$")} no realizado`
              : `${Number(p.amount_remaining || 0).toLocaleString("en-US", { maximumFractionDigits: 4 })} unidades`}
          </div>
          <div style="font-size:10px; color:${uColor}">${v.live ? `precio $${v.price < 0.01 ? v.price.toFixed(6) : v.price.toFixed(2)}` : "sin precio en vivo"}</div>
        </div>`;
      }
    );
    this.target().appendChild(panel);
  },

  /* ── Trade history ── */

  appendTrades() {
    const rows = this.trades.slice(0, 15);
    const panel = this.makePanel(
      "🧾 Historial de Operaciones",
      "Sin operaciones todavía. Tu primer swap aparecerá aquí.",
      rows,
      (t) => {
        const hasPnl = t.realized_pnl_usdc != null && t.realized_pnl_usdc !== "null";
        const pnlNum = hasPnl ? Number(t.realized_pnl_usdc) / 1e6 : null;
        const side = t.type === "buy" ? "COMPRA" : "VENTA";
        const tokenSym = (t.buy_token === "USDC" ? t.sell_token : t.buy_token) || "?";
        const sym = String(tokenSym).toUpperCase();
        const color = !hasPnl ? "#fff" : pnlNum >= 0 ? "var(--delta-green)" : "var(--delta-red)";
        const date = new Date(t.ts * 1000).toLocaleString("es-ES", {
          day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
        });
        return `
        <div style="display:flex; align-items:center; gap:10px; min-width:0">
          ${TokenMeta.logoHtml(sym, { size: 26 })}
          <div>
            <div style="font-weight:800; font-size:13px">${side} ${sym}</div>
            <div style="font-size:11px; color:var(--text-tertiary); text-transform:uppercase">${t.from_chain} · ${date} · ${t.status}</div>
          </div>
        </div>
        <div style="text-align:right">
          <div class="mono" style="font-weight:800; font-size:13px; color:${color}">${hasPnl ? signedUsdMicro(t.realized_pnl_usdc) : fmtUsdMicro(t.buy_amount)}</div>
          ${hasPnl ? `<div style="font-size:11px; color:var(--text-tertiary)">PnL realizado</div>` : ""}
        </div>`;
      }
    );
    this.target().appendChild(panel);
  },

  /* ── Wallets ── */

  appendWallets() {
    const el = this.target();
    const wrap = document.createElement("div");
    wrap.className = "glass-panel";
    wrap.style.cssText = "padding:24px; margin-bottom:20px";
    wrap.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px">
        <h3 style="font-size:15px; font-weight:800; margin:0">👛 Mis Billeteras</h3>
        <div style="display:flex; gap:8px">
          <button class="btn btn-secondary btn-sm" onclick="window.PortfolioEngine.promptImportWallet()">+ Importar</button>
          <button class="btn btn-ghost btn-sm" onclick="window.PortfolioEngine.promptDeleteWallet()">🗑 Eliminar</button>
        </div>
      </div>`;
    const list = document.createElement("div");
    list.style.cssText = "display:flex; flex-direction:column; gap:8px";
    if (this.wallets.length === 0) {
      list.innerHTML = `<div style="font-size:13px; color:var(--text-tertiary)">Sin billeteras. Conecta Phantom/MetaMask o importa una clave privada.</div>`;
    } else {
      for (const w of this.wallets) {
        const row = document.createElement("div");
        row.style.cssText =
          "display:flex; justify-content:space-between; align-items:center; padding:12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:var(--radius-md)";
        const short = w.address ? w.address.slice(0, 6) + "…" + w.address.slice(-4) : "—";
        row.innerHTML = `
          <div>
            <div style="font-weight:800; font-size:13px">${w.label || "Wallet"} <span style="font-size:10px; color:var(--text-tertiary); text-transform:uppercase">· ${w.chain}</span></div>
            <div class="mono" style="font-size:11px; color:var(--text-tertiary)">${short}</div>
          </div>`;
        list.appendChild(row);
      }
    }
    wrap.appendChild(list);
    el.appendChild(wrap);
  },

  /* ── Panel scaffold shared by the sections above ── */

  makePanel(title, emptyText, rows, rowHtml) {
    const wrap = document.createElement("div");
    wrap.className = "glass-panel";
    wrap.style.cssText = "padding:24px; margin-bottom:20px";
    wrap.innerHTML = `<h3 style="font-size:15px; font-weight:800; margin-bottom:14px">${title}</h3>`;
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "font-size:13px; color:var(--text-tertiary)";
      empty.textContent = emptyText;
      wrap.appendChild(empty);
      return wrap;
    }
    const list = document.createElement("div");
    list.style.cssText = "display:flex; flex-direction:column; gap:10px";
    for (const row of rows) {
      const div = document.createElement("div");
      div.style.cssText =
        "display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:var(--radius-md)";
      div.innerHTML = rowHtml(row);
      list.appendChild(div);
    }
    wrap.appendChild(list);
    return wrap;
  },

  /* ── Wallet import/delete (server requires the password to decrypt) ── */

  promptImportWallet() {
    const chain = prompt("Cadena (solana, ethereum, base, bsc, arbitrum, polygon, robinhood, monad, arc):");
    if (!chain) return;
    const privateKey = prompt("Clave privada (hex para EVM, base58 para Solana):");
    if (!privateKey) return;
    const password = prompt("Contraseña para cifrar la wallet en el servidor:");
    if (!password) return;
    this.doImportWallet(chain.trim().toLowerCase(), privateKey.trim(), password);
  },

  async doImportWallet(chain, privateKey, password) {
    try {
      await ApiClient.importWallet(chain, privateKey, password);
      alert("Wallet importada correctamente.");
      this.load();
    } catch (e) {
      alert("Error al importar: " + (e?.message || "clave inválida para la cadena"));
    }
  },

  promptDeleteWallet() {
    if (this.wallets.length === 0) {
      alert("No tienes billeteras para eliminar.");
      return;
    }
    const idx = prompt(
      "Número de wallet a eliminar:\n" +
        this.wallets.map((w, i) => `${i + 1}. ${w.label || "Wallet"} (${w.chain}) — ${w.address?.slice(0, 10)}…`).join("\n")
    );
    const n = Number(idx);
    if (!n || n < 1 || n > this.wallets.length) return;
    const w = this.wallets[n - 1];
    if (!confirm(`¿Eliminar ${w.label || "Wallet"} (${w.chain})? Esta acción no se puede deshacer.`)) return;
    // The server decrypts with this password before allowing deletion.
    const password = prompt("Contraseña de la wallet para confirmar la eliminación:");
    if (!password) return;
    this.doDeleteWallet(w.id, password);
  },

  async doDeleteWallet(id, password) {
    try {
      await ApiClient.deleteWallet(id, password);
      alert("Wallet eliminada.");
      this.load();
    } catch (e) {
      alert("No se pudo eliminar la wallet: " + (e?.message || "error"));
    }
  },
};

// Global expose for inline handlers
window.PortfolioEngine = PortfolioEngine;
