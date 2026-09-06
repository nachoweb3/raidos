/**
 * 🏆 SOCIAL TRADING & LEADERBOARD ENGINE
 * Performance rankings (24H, 7D, 30D, ALL TIME), follow system,
 * and copy-trading entry points. Data comes from /api/leaderboard.
 * When no traders qualify yet, an honest empty state is shown —
 * no invented seed traders.
 */

import { ApiClient } from "./api.js";

const fmtUsd = (n) =>
  (n < 0 ? "-$" : "$") +
  Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Keep only characters safe for inline JS handler strings. */
const safeHandle = (h) => String(h || "").replace(/[^a-zA-Z0-9_@.\-]/g, "");

export const SocialEngine = {
  container: null,
  activePeriod: "all", // '24h' | '7d' | '30d' | 'all' | 'rising'
  leaders: [],
  followingSet: new Set(JSON.parse(localStorage.getItem("trenches_following") || "[]")),

  init(containerElement) {
    this.container = containerElement;
    this.loadLeaderboard();
  },

  async loadLeaderboard() {
    this.renderLoading();
    try {
      const data = await ApiClient.getLeaderboard(this.activePeriod, 30);
      this.leaders = this.mapLeaders(data?.leaders ?? []);
    } catch (e) {
      console.warn("[Social] leaderboard load failed:", e);
      this.leaders = [];
    }
    this.render();
  },

  mapLeaders(rows) {
    const mapped = rows.map((l, index) => {
      const pnlUsdc = Number(l.total_pnl_usdc ?? l.pnl_usdc ?? 0) / 1_000_000;
      const handle = safeHandle(l.x_handle) || `@trader_${l.user_id}`;
      const displayName = l.display_name || handle;
      return {
        rank: index + 1,
        userId: l.user_id,
        handle,
        displayName,
        avatar: displayName.slice(0, 2).toUpperCase(),
        pnlUsdc,
        winRate: Number(l.win_rate ?? 0),
        trades: Number(l.total_trades ?? l.trades ?? 0),
        followers: Number(l.followers_count ?? 0),
      };
    });
    if (this.activePeriod === "rising") {
      // Rising = profitable with a solid hit rate, few assumptions beyond the data
      return mapped.filter((l) => l.pnlUsdc > 0 && l.winRate >= 50);
    }
    return mapped;
  },

  setPeriod(period) {
    this.activePeriod = period;
    this.loadLeaderboard();
  },

  toggleFollow(handle) {
    const h = safeHandle(handle);
    if (this.followingSet.has(h)) {
      this.followingSet.delete(h);
    } else {
      this.followingSet.add(h);
    }
    localStorage.setItem("trenches_following", JSON.stringify([...this.followingSet]));
    this.render();
  },

  openCopyModal(trader) {
    const nameEl = document.getElementById("copyTraderName");
    if (nameEl) nameEl.textContent = trader.displayName + " (" + trader.handle + ")";
    const modal = document.getElementById("copyTradeModal");
    if (modal) modal.classList.add("active");
  },

  renderLoading() {
    if (!this.container) return;
    this.container.innerHTML = `
      <div class="glass-panel" style="padding:32px; text-align:center; font-size:13px; color:var(--text-tertiary)">
        Cargando ranking…
      </div>`;
  },

  renderEmpty() {
    if (!this.container) return;
    const periodLabel = { all: "histórico completo", "30d": "30 días", "7d": "7 días", "24h": "24 horas", rising: "emergentes" }[this.activePeriod] || this.activePeriod;
    this.container.innerHTML = `
      <div class="glass-panel" style="padding:40px 28px; text-align:center">
        <div style="font-size:34px; margin-bottom:12px">🏁</div>
        <h3 style="font-size:17px; font-weight:800; margin-bottom:8px">El ranking está abierto</h3>
        <p style="font-size:13px; color:var(--text-secondary); margin-bottom:20px; max-width:420px; margin-left:auto; margin-right:auto">
          Nadie ha ejecutado operaciones suficientes para aparecer en el ranking (${periodLabel}) todavía.
          Haz tu primer trade y sé el #1.
        </p>
        <button class="btn btn-primary btn-lg" onclick="window.App.switchView('trade')">Ir a Trade</button>
      </div>`;
  },

  render() {
    if (!this.container) return;

    if (this.leaders.length === 0) {
      this.renderEmpty();
      return;
    }

    this.container.innerHTML = this.leaders.map((l) => {
      const isFollowing = this.followingSet.has(l.handle);
      const pnlColor = l.pnlUsdc >= 0 ? "var(--delta-green)" : "var(--delta-red)";
      const pnlSign = l.pnlUsdc >= 0 ? "+" : "";
      return `
        <div class="glass-panel-interactive" style="display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid var(--border-subtle); margin-bottom:10px; border-radius:var(--radius-lg)">
          <div style="display:flex; align-items:center; gap:16px">
            <span class="mono" style="font-size:16px; font-weight:800; width:26px; color:${l.rank === 1 ? '#fde047' : l.rank === 2 ? '#e2e8f0' : l.rank === 3 ? '#b45309' : 'var(--text-tertiary)'}">
              #${l.rank}
            </span>

            <div class="author-avatar" style="width:40px; height:40px; font-size:14px">${l.avatar}</div>

            <div>
              <div style="display:flex; align-items:center; gap:8px">
                <span style="font-weight:700; font-size:14.5px; color:#fff">${l.displayName}</span>
                <span class="brand-badge" style="font-size:10px; color:var(--text-tertiary)">${l.handle}</span>
              </div>
              <div style="font-size:11.5px; color:var(--text-tertiary); font-family:var(--font-mono); margin-top:2px">
                Win Rate: <strong style="color:var(--text-primary)">${l.winRate.toFixed(1)}%</strong> · ${l.trades} trade${l.trades === 1 ? "" : "s"} · ${l.followers.toLocaleString()} followers
              </div>
            </div>
          </div>

          <div style="display:flex; align-items:center; gap:20px">
            <div style="text-align:right">
              <div class="mono" style="font-weight:800; font-size:15px; color:${pnlColor}">
                ${pnlSign}$${fmtUsd(l.pnlUsdc).replace("$", "")} USDC
              </div>
              <div class="mono" style="font-size:11px; color:var(--text-secondary)">
                ${l.trades === 0 ? "sin operaciones" : `${l.trades} operaciones`}
              </div>
            </div>

            <div style="display:flex; gap:8px">
              <button class="btn ${isFollowing ? 'btn-ghost' : 'btn-secondary'} btn-sm" onclick="window.SocialEngine.toggleFollow('${l.handle}')">
                ${isFollowing ? 'Siguiendo' : 'Follow'}
              </button>
              <button class="btn btn-primary btn-sm" onclick='window.SocialEngine.openCopyModal(${JSON.stringify({ handle: l.handle, displayName: l.displayName }).replace(/'/g, "&#39;")})'>
                Copy
              </button>
            </div>
          </div>
        </div>
      `;
    }).join("");
  },
};
