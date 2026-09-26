/**
 * 💎 REFERRALS ENGINE — invite tracking.
 * Referrals: invite code, count, and referred users from GET /api/me/referrals.
 * (Premium plans were removed: no product surface enforces tier limits, so the
 * pricing grid promised features that do not exist. The backend routes remain
 * but nothing in the app links to them anymore.)
 */

import { ApiClient } from "./api.js";

export const PremiumEngine = {
  currentTier: null,
  referrals: null,

  async load() {
    try {
      if (!ApiClient.isBetaUnlocked()) return;
      // Tier kept as a read-only badge if the account already has one.
      ApiClient.getSubscription?.().catch(() => null).then?.((subRes) => {
        this.currentTier = subRes?.tier?.id ?? "free";
      });
      const refRes = await ApiClient.getReferrals().catch(() => null);
      this.referrals = refRes;
      this.render();
    } catch (e) {
      console.warn("[Premium] load failed:", e);
    }
  },

  copyReferralLink() {
    const code = this.referrals?.refCode;
    if (!code) {
      alert("Conecta tu wallet primero para obtener tu código de referido.");
      return;
    }
    const link = `https://inusaur.online/app.html?ref=${encodeURIComponent(code)}`;
    navigator.clipboard
      .writeText(link)
      .then(() => alert("Enlace de referido copiado:\n" + link))
      .catch(() => prompt("Copia tu enlace de referido:", link));
  },

  render() {
    this.ensureContainer("referralsContainer");
    this.renderReferrals();
  },

  ensureContainer(id) {
    let el = document.getElementById(id);
    if (el) return el;
    // FOMO layout: referrals live in the right column. Before the portfolio
    // renders, pfRight does not exist yet — creating the container inside
    // #view-profile would land it outside the 3-column shell, so we skip and
    // wait: PortfolioEngine.render() re-calls PremiumEngine.render() after the
    // columns are built.
    const pfRight = document.getElementById("pfRight");
    const section = document.getElementById("view-profile");
    if (pfRight) {
      el = document.createElement("div");
      el.id = id;
      pfRight.appendChild(el);
    } else if (!document.getElementById("portfolioMain") && section) {
      el = document.createElement("div");
      el.id = id;
      section.appendChild(el);
    }
    return el ?? null;
  },

  renderReferrals() {
    const el = document.getElementById("referralsContainer");
    if (!el) return;
    const r = this.referrals;
    if (!r) {
      el.innerHTML = `
        <div class="glass-panel" style="padding:24px; margin-bottom:20px; text-align:center; font-size:13px; color:var(--text-tertiary)">
          Conecta tu wallet para obtener tu código de referido e invitar traders.
        </div>`;
      return;
    }
    const refList = (r.referrals || [])
      .map(
        (x) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:var(--radius-md)">
          <div>
            <div style="font-weight:700; font-size:13px">Trader #${x.user_id}</div>
            <div class="mono" style="font-size:11px; color:var(--text-tertiary)">${x.ref_code || "—"} · ${new Date(x.created_at * 1000).toLocaleDateString("es-ES")}</div>
          </div>
          <span class="brand-badge" style="font-size:10px">invitado</span>
        </div>`
      )
      .join("");

    el.innerHTML = `
      <div class="glass-panel" style="padding:24px; margin-bottom:20px">
        <h3 style="font-size:15px; font-weight:800; margin-bottom:6px">🎁 Tus Referidos</h3>
        <p style="font-size:12px; color:var(--text-tertiary); margin-bottom:14px">
          Comparte tu enlace: cada trader que se registre con él queda ligado a tu cuenta.
        </p>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:16px">
          <div class="mono" style="padding:10px 14px; background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:var(--radius-md); font-size:14px; font-weight:800; letter-spacing:1px">
            ${r.refCode || "—"}
          </div>
          <div style="font-size:13px; color:var(--text-secondary)">
            <strong style="color:#fff">${r.count ?? 0}</strong> invitado${(r.count ?? 0) === 1 ? "" : "s"} registrados
          </div>
          <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="window.PremiumEngine.copyReferralLink()">📋 Copiar enlace</button>
        </div>
        ${
          (r.referrals || []).length === 0
            ? `<div style="font-size:13px; color:var(--text-tertiary)">Todavía no has invitado a nadie. ¡Sé el primero en compartir tu enlace!</div>`
            : `<div style="display:flex; flex-direction:column; gap:8px">${refList}</div>`
        }
      </div>`;
  },
};

window.PremiumEngine = PremiumEngine;
