/**
 * 🎁 REWARDS ENGINE — fee-funded trading + referral rewards dashboard.
 * Data: GET /api/rewards (balance + stats + refCode), /api/rewards/history,
 * /api/referrals, /api/rewards/leaderboard. Claim: POST /api/rewards/claim.
 * Nothing is computed client-side — every number comes from the ledger.
 */

import { ApiClient } from "./api.js";

const fmtUsdMicro = (raw) => {
  const n = Number(raw ?? 0) / 1e6;
  if (!Number.isFinite(n)) return "$0.00";
  if (Math.abs(n) >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (Math.abs(n) >= 1_000) return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return "$" + n.toFixed(2);
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

export const RewardsEngine = {
  container: null,
  data: null,
  history: [],
  referrals: [],
  leaders: [],
  leaderPeriod: "all",
  historyFilter: { type: "", status: "" },
  loading: false,
  loadedOnce: false,
  claiming: false,

  init(containerElement) {
    this.container = containerElement;
  },

  target() {
    return this.container || document.getElementById("rewardsRoot");
  },

  async load() {
    const el = this.target();
    if (!el) return;
    if (!ApiClient.isBetaUnlocked()) {
      this.renderSignedOut();
      return;
    }
    if (!this.loadedOnce) this.renderLoading();
    if (this.loading) return;
    this.loading = true;
    try {
      const [rewards, history, referrals, leaders] = await Promise.all([
        ApiClient.request("/api/rewards"),
        ApiClient.request("/api/rewards/history?limit=100").catch(() => ({ entries: [] })),
        ApiClient.request("/api/referrals").catch(() => ({ referrals: [], refCode: null })),
        ApiClient.request(`/api/rewards/leaderboard?period=${this.leaderPeriod}&limit=10`).catch(() => ({ leaders: [] })),
      ]);
      this.data = rewards;
      this.history = history?.entries ?? [];
      this.referrals = referrals?.referrals ?? [];
      this.leaders = leaders?.leaders ?? [];
      this.loadedOnce = true;
      this.render();
    } catch (err) {
      const msg = String(err?.message || err);
      if (/401|unauthorized|api key/i.test(msg)) this.renderSignedOut();
      else this.renderError(msg);
    } finally {
      this.loading = false;
    }
  },

  /* ── Actions ─────────────────────────────────────────────────────────── */

  async claim() {
    if (this.claiming) return;
    const bal = this.data?.balance;
    if (!bal || Number(bal.availableUsdc) <= 0) return;
    if (!confirm(`Reclamar ${fmtUsdMicro(bal.availableUsdc)} en rewards?`)) return;
    this.claiming = true;
    this.render();
    try {
      const res = await ApiClient.request("/api/rewards/claim", { method: "POST", body: JSON.stringify({}) });
      alert(`✅ Rewards reclamadas: ${fmtUsdMicro(res.claimedUsdc)}\nRef: ${res.txRef}`);
    } catch (err) {
      alert("❌ " + String(err?.message || err));
    } finally {
      this.claiming = false;
      this.load();
    }
  },

  copyReferralLink() {
    const code = this.data?.refCode;
    if (!code) return;
    const link = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}join.html?ref=${encodeURIComponent(code)}`;
    navigator.clipboard?.writeText(link).then(
      () => alert("📋 Link copiado:\n" + link),
      () => prompt("Copia tu link de referral:", link)
    );
  },

  setHistoryFilter(key, value) {
    this.historyFilter[key] = value;
    this.load();
  },

  setLeaderPeriod(period) {
    this.leaderPeriod = period;
    this.load();
  },

  /* ── Render states ───────────────────────────────────────────────────── */

  renderSignedOut() {
    const el = this.target();
    if (!el) return;
    el.innerHTML = `
      <div class="glass-panel" style="padding:48px 24px; text-align:center">
        <div style="font-size:34px; margin-bottom:12px">🎁</div>
        <h3 style="font-size:18px; font-weight:800; margin-bottom:8px">Rewards de TRENCHES</h3>
        <p style="font-size:13px; color:var(--text-secondary); max-width:420px; margin:0 auto 18px">
          Gana mientras operas: un porcentaje de tus fees vuelve a ti. Y gana más cuando tu red opera: invita traders y recibe un % de sus fees.
        </p>
        <button class="btn btn-primary btn-lg" onclick="window.App.openWalletModal()">Conectar para empezar</button>
      </div>`;
  },

  renderLoading() {
    const el = this.target();
    if (!el) return;
    el.innerHTML = `
      <div class="glass-panel" style="padding:48px; text-align:center">
        <div class="soft-pulse" style="display:inline-flex; align-items:center; gap:10px; color:var(--text-tertiary); font-size:13px">
          🎁 Cargando rewards…
        </div>
      </div>`;
  },

  renderError(msg) {
    const el = this.target();
    if (!el) return;
    el.innerHTML = `
      <div class="glass-panel" style="padding:36px; text-align:center">
        <div style="color:var(--delta-red); font-size:13px; margin-bottom:12px">No se pudieron cargar las rewards: ${esc(msg)}</div>
        <button class="btn btn-secondary btn-sm" onclick="window.RewardsEngine.load()">Reintentar</button>
      </div>`;
  },

  /* ── Main render ─────────────────────────────────────────────────────── */

  render() {
    const el = this.target();
    if (!el || !this.data) return;
    const bal = this.data.balance ?? {};
    const stats = this.data.stats ?? {};
    const cfg = stats.config ?? {};
    const flag = this.data.flag ?? "NORMAL";
    const pct = (v) => `${Math.round((v ?? 0) * 100)}%`;
    const canClaim = Number(bal.availableUsdc ?? 0) > 0 && flag !== "BLOCKED";

    const flagBadge =
      flag === "BLOCKED"
        ? `<span class="brand-badge" style="font-size:9.5px; background:rgba(239,68,68,0.12); color:var(--delta-red); border:1px solid rgba(239,68,68,0.35)">⛔ CUENTA BLOQUEADA — claim deshabilitado</span>`
        : flag === "REVIEW"
          ? `<span class="brand-badge" style="font-size:9.5px; background:rgba(253,224,71,0.1); color:#fde047; border:1px solid rgba(253,224,71,0.3)">⚠ EN REVISIÓN — rewards pendientes hasta aclarar</span>`
          : "";

    el.innerHTML = `
      <!-- Header -->
      <div class="glass-panel" style="padding:26px; margin-bottom:16px">
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:14px">
          <div>
            <h2 style="font-size:22px; font-weight:900; margin:0">REWARDS</h2>
            <div style="font-size:12.5px; color:var(--text-secondary); margin-top:4px">
              Earn while you trade. Earn more when your network trades.
            </div>
            <div style="margin-top:8px">${flagBadge}</div>
          </div>
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">
            <div style="text-align:right; margin-right:6px">
              <div class="mono" style="font-size:26px; font-weight:900; color:var(--delta-green)">${fmtUsdMicro(bal.availableUsdc)}</div>
              <div style="font-size:10px; color:var(--text-tertiary); letter-spacing:1px">DISPONIBLE</div>
            </div>
            <button class="btn btn-primary btn-lg" id="claimRewardsBtn" ${canClaim ? "" : "disabled style=opacity:0.45"} onclick="window.RewardsEngine.claim()">
              ${this.claiming ? "Reclamando…" : "CLAIM REWARDS"}
            </button>
          </div>
        </div>

        <!-- Balance cards -->
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:12px; margin-top:22px">
          ${this.card("TOTAL EARNED", fmtUsdMicro(bal.totalUsdc), "#fff")}
          ${this.card("DISPONIBLE", fmtUsdMicro(bal.availableUsdc), "var(--delta-green)")}
          ${this.card("PENDIENTE", fmtUsdMicro(bal.pendingUsdc), "#fde047")}
          ${this.card("RECLAMADO", fmtUsdMicro(bal.claimedUsdc), "#fff")}
          ${this.card("HOY", fmtUsdMicro(bal.todayUsdc), "#fff")}
          ${this.card("ESTA SEMANA", fmtUsdMicro(bal.weekUsdc), "#fff")}
          ${this.card("ESTE MES", fmtUsdMicro(bal.monthUsdc), "#fff")}
        </div>
      </div>

      <!-- Two program blocks -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:16px; margin-bottom:16px">
        <!-- TRADING REWARDS -->
        <div class="glass-panel" style="padding:20px">
          <div style="font-size:11px; font-weight:800; letter-spacing:1.5px; color:var(--text-tertiary)">⚡ TRADING REWARDS</div>
          <div style="font-size:14px; font-weight:800; margin:6px 0 14px">Earn while you trade</div>
          <div style="display:flex; flex-direction:column; gap:9px; font-size:12.5px">
            ${this.row("Volumen generado", fmtUsdMicro(this._myVolume()))}
            ${this.row("Fees pagadas", fmtUsdMicro(this._myFees()))}
            ${this.row("% de fee para rewards", pct(cfg.tradingRewardRate))}
            ${this.row("Rewards obtenidas", `<span style="color:var(--delta-green); font-weight:800">${fmtUsdMicro(stats.tradingRewardsUsdc)}</span>`)}
          </div>
          <div style="margin-top:14px; font-size:10.5px; color:var(--text-tertiary); line-height:1.6">
            Cada operación confirmada devuelve un % de tu fee real. Máximo diario: ${fmtUsdMicro(String((cfg.maxDailyRewardUsdc ?? 0) * 1e6))}.
          </div>
        </div>

        <!-- REFERRAL REWARDS -->
        <div class="glass-panel" style="padding:20px">
          <div style="font-size:11px; font-weight:800; letter-spacing:1.5px; color:var(--text-tertiary)">👥 REFERRAL REWARDS</div>
          <div style="font-size:14px; font-weight:800; margin:6px 0 14px">Earn by bringing traders</div>
          <div style="display:flex; flex-direction:column; gap:9px; font-size:12.5px">
            ${this.row("Referidos", String(stats.referralsTotal ?? 0))}
            ${this.row("Referidos activos", String(stats.referralsActive ?? 0))}
            ${this.row("Volumen de tu red", fmtUsdMicro(stats.referralVolumeUsdc))}
            ${this.row("Rewards generadas", `<span style="color:var(--delta-green); font-weight:800">${fmtUsdMicro(stats.referralRewardsUsdc)}</span>`)}
          </div>
          <div style="display:flex; gap:8px; margin-top:16px; align-items:center; flex-wrap:wrap">
            <code style="flex:1; min-width:150px; padding:9px 12px; background:rgba(255,255,255,0.04); border:1px solid var(--border-subtle); border-radius:8px; font-size:12px; color:#fff; overflow:hidden; text-overflow:ellipsis">${esc(this.data.refCode ?? "—")}</code>
            <button class="btn btn-secondary btn-sm" onclick="window.RewardsEngine.copyReferralLink()">📋 COPY REFERRAL LINK</button>
          </div>
          <div style="margin-top:12px; font-size:10.5px; color:var(--text-tertiary); line-height:1.6">
            Ganas ${pct(cfg.referralRewardRate)} de las fees que generan tus referidos — solo con su actividad real, nunca por registrarse.
          </div>
        </div>
      </div>

      <!-- Referral tree -->
      <div class="glass-panel" style="margin-bottom:16px; overflow:hidden">
        <div style="padding:14px 18px; border-bottom:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px">
          <span style="font-size:12px; font-weight:800; letter-spacing:1px; text-transform:uppercase; color:var(--text-tertiary)">Tus referidos</span>
          <span style="font-size:11px; color:var(--text-tertiary)">${stats.referralsTotal ?? 0} total · <span style="color:var(--delta-green)">${stats.referralsActive ?? 0} activos</span> · ${stats.referralsInactive ?? 0} inactivos</span>
        </div>
        ${this.renderReferralTable()}
      </div>

      <!-- History -->
      <div class="glass-panel" style="margin-bottom:16px; overflow:hidden">
        <div style="padding:14px 18px; border-bottom:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px">
          <span style="font-size:12px; font-weight:800; letter-spacing:1px; text-transform:uppercase; color:var(--text-tertiary)">Historial de rewards</span>
          <div style="display:flex; gap:6px">
            <select onchange="window.RewardsEngine.setHistoryFilter('type', this.value)" style="padding:5px 8px; font-size:11px">
              <option value="">Todos</option>
              <option value="TRADING" ${this.historyFilter.type === "TRADING" ? "selected" : ""}>Trading</option>
              <option value="REFERRAL" ${this.historyFilter.type === "REFERRAL" ? "selected" : ""}>Referrals</option>
            </select>
            <select onchange="window.RewardsEngine.setHistoryFilter('status', this.value)" style="padding:5px 8px; font-size:11px">
              <option value="">Todos los estados</option>
              <option value="AVAILABLE" ${this.historyFilter.status === "AVAILABLE" ? "selected" : ""}>Available</option>
              <option value="PENDING" ${this.historyFilter.status === "PENDING" ? "selected" : ""}>Pending</option>
              <option value="CLAIMED" ${this.historyFilter.status === "CLAIMED" ? "selected" : ""}>Claimed</option>
            </select>
          </div>
        </div>
        ${this.renderHistoryTable()}
      </div>

      <!-- Leaderboard -->
      <div class="glass-panel" style="overflow:hidden">
        <div style="padding:14px 18px; border-bottom:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px">
          <span style="font-size:12px; font-weight:800; letter-spacing:1px; text-transform:uppercase; color:var(--text-tertiary)">🏆 Top Reward Earners</span>
          <div style="display:flex; gap:6px">
            ${["24h", "7d", "30d", "all"].map((p) => `<button class="pill-tab ${this.leaderPeriod === p ? "active" : ""}" style="padding:4px 10px; font-size:10.5px" onclick="window.RewardsEngine.setLeaderPeriod('${p}')">${p === "all" ? "ALL TIME" : p.toUpperCase()}</button>`).join("")}
          </div>
        </div>
        ${this.renderLeaderboard()}
      </div>`;
  },

  card(label, value, color) {
    return `
      <div style="padding:13px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:var(--radius-md)">
        <div class="mono" style="font-size:16px; font-weight:800; color:${color}">${value}</div>
        <div style="font-size:9.5px; color:var(--text-tertiary); letter-spacing:1px; margin-top:3px">${label}</div>
      </div>`;
  },

  row(label, value) {
    return `
      <div style="display:flex; justify-content:space-between; gap:10px">
        <span style="color:var(--text-tertiary)">${label}</span>
        <strong style="color:#fff; text-align:right">${value}</strong>
      </div>`;
  },

  /** Personal fee/volume estimates are NOT in the ledger; derive from /api/trades/pnl cache if present. */
  _myVolume() {
    return this.data?.stats?.myVolumeUsdc ?? "0";
  },
  _myFees() {
    return this.data?.stats?.myFeesUsdc ?? "0";
  },

  renderReferralTable() {
    if (!this.referrals.length) {
      return `<div style="padding:22px; text-align:center; color:var(--text-tertiary); font-size:12px">
        Aún no tienes referidos. Comparte tu link y gana cuando operen.
      </div>`;
    }
    return `
      <div style="overflow-x:auto">
        <table style="width:100%; border-collapse:collapse; font-size:11.5px; min-width:520px">
          <thead>
            <tr style="color:var(--text-tertiary); font-size:10px; letter-spacing:1px; text-transform:uppercase">
              <th style="text-align:left; padding:8px 18px">Referral</th>
              <th style="text-align:left; padding:8px 8px">Joined</th>
              <th style="text-align:right; padding:8px 8px">Volumen</th>
              <th style="text-align:right; padding:8px 8px">Trades</th>
              <th style="text-align:right; padding:8px 18px">Estado</th>
            </tr>
          </thead>
          <tbody>
            ${this.referrals.slice(0, 20).map((r) => `
            <tr style="border-top:1px solid var(--border-subtle)">
              <td style="padding:9px 18px; font-family:var(--font-mono); color:#fff">trader #${r.userId}</td>
              <td style="padding:9px 8px; color:var(--text-tertiary)">${r.joinedAt ? new Date(r.joinedAt * 1000).toLocaleDateString("es-ES", { day: "numeric", month: "short" }) : "—"}</td>
              <td style="padding:9px 8px; text-align:right; font-family:var(--font-mono)">${fmtUsdMicro(r.volumeUsdc)}</td>
              <td style="padding:9px 8px; text-align:right; font-family:var(--font-mono); color:var(--text-tertiary)">${r.trades ?? 0}</td>
              <td style="padding:9px 18px; text-align:right">
                <span class="brand-badge" style="font-size:9px; ${r.status === "active" ? "color:var(--delta-green)" : "color:var(--text-tertiary)"}">${r.status === "active" ? "● ACTIVO" : "○ INACTIVO"}</span>
              </td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  },

  renderHistoryTable() {
    let rows = this.history;
    if (this.historyFilter.type) rows = rows.filter((e) => e.reward_type === this.historyFilter.type);
    if (this.historyFilter.status) rows = rows.filter((e) => e.status === this.historyFilter.status);
    if (!rows.length) {
      return `<div style="padding:22px; text-align:center; color:var(--text-tertiary); font-size:12px">Sin movimientos todavía. Opera o invita para generar rewards.</div>`;
    }
    const statusColor = (s) => (s === "CLAIMED" ? "var(--delta-green)" : s === "PENDING" ? "#fde047" : s === "CANCELLED" ? "var(--delta-red)" : "#fff");
    return `
      <div style="overflow-x:auto">
        <table style="width:100%; border-collapse:collapse; font-size:11.5px; min-width:560px">
          <thead>
            <tr style="color:var(--text-tertiary); font-size:10px; letter-spacing:1px; text-transform:uppercase">
              <th style="text-align:left; padding:8px 18px">Fecha</th>
              <th style="text-align:left; padding:8px 8px">Tipo</th>
              <th style="text-align:left; padding:8px 8px">Fuente</th>
              <th style="text-align:right; padding:8px 8px">Reward</th>
              <th style="text-align:right; padding:8px 18px">Estado</th>
            </tr>
          </thead>
          <tbody>
            ${rows.slice(0, 50).map((e) => `
            <tr style="border-top:1px solid var(--border-subtle)">
              <td style="padding:9px 18px; color:var(--text-tertiary); white-space:nowrap">${new Date(e.created_at * 1000).toLocaleDateString("es-ES", { day: "numeric", month: "short" })}</td>
              <td style="padding:9px 8px; font-weight:700; color:#fff">${e.reward_type}</td>
              <td style="padding:9px 8px; color:var(--text-tertiary); font-family:var(--font-mono); font-size:10.5px">${e.reward_type === "REFERRAL" ? `user #${e.referral_id}` : e.trade_id ? `trade #${e.trade_id}` : esc(e.source)}</td>
              <td style="padding:9px 8px; text-align:right; font-family:var(--font-mono); font-weight:800; color:var(--delta-green)">${fmtUsdMicro(e.amount_usdc)}</td>
              <td style="padding:9px 18px; text-align:right; font-weight:700; color:${statusColor(e.status)}">${e.status}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  },

  renderLeaderboard() {
    if (!this.leaders.length) {
      return `<div style="padding:22px; text-align:center; color:var(--text-tertiary); font-size:12px">Sin earners en este período todavía.</div>`;
    }
    return this.leaders
      .map((l) => {
        const medal = l.rank === 1 ? "🥇" : l.rank === 2 ? "🥈" : l.rank === 3 ? "🥉" : `#${l.rank}`;
        return `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 18px; border-top:1px solid var(--border-subtle)">
          <div style="display:flex; align-items:center; gap:10px">
            <span style="width:32px; font-weight:800; font-size:13px">${medal}</span>
            <span class="mono" style="font-size:12px; color:var(--text-secondary)">trader #${l.userId}</span>
          </div>
          <div class="mono" style="font-weight:800; font-size:13px; color:var(--delta-green)">$${l.totalUsdc}</div>
        </div>`;
      })
      .join("");
  },
};
