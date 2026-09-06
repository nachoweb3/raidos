/**
 * 💎 PREMIUM & REFERRALS ENGINE — Subscriptions and invite tracking.
 * Subscriptions: 4 tiers served by GET/POST /api/subscription (revenue.ts).
 * Referrals: invite code, count, and referred users from GET /api/me/referrals.
 */

import { ApiClient } from "./api.js";

const TIERS = [
  {
    id: "free",
    name: "Free",
    price: 0,
    tagline: "Para empezar a operar",
    features: [
      "Trading básico (swap)",
      "Ver leaderboard",
      "3 alertas por día",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: 29,
    tagline: "Para traders activos",
    features: [
      "Swaps ilimitados",
      "Alertas avanzadas (volumen, ballenas, social)",
      "Perfil público + calls",
      "Copy-trade (hasta 5 traders)",
      "Enrutamiento prioritario",
      "Sin anuncios",
    ],
  },
  {
    id: "alpha",
    name: "Alpha",
    price: 99,
    tagline: "Para cazadores de alpha",
    badge: "POPULAR",
    features: [
      "Todo lo de Pro",
      "Copy-trade ilimitado",
      "Acceso API (10k llamadas/mes)",
      "Dashboard de analítica avanzada",
      "Prioridad en lanzamientos",
      "Reglas de alerta personalizadas",
      "Acceso anticipado a funciones",
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: 499,
    tagline: "Para equipos e instituciones",
    features: [
      "Todo lo de Alpha",
      "API ilimitada",
      "Integración white-label",
      "Soporte dedicado",
      "Estrategias de trading personalizadas",
      "Analítica institucional",
      "Revenue share por referidos",
    ],
  },
];

export const PremiumEngine = {
  currentTier: null,
  referrals: null,

  async load() {
    try {
      if (!ApiClient.isBetaUnlocked()) return;
      const [subRes, refRes] = await Promise.all([
        ApiClient.getSubscription().catch(() => null),
        ApiClient.getReferrals().catch(() => null),
      ]);
      this.currentTier = subRes?.tier?.id ?? "free";
      this.referrals = refRes;
      this.render();
    } catch (e) {
      console.warn("[Premium] load failed:", e);
    }
  },

  async subscribe(tierId) {
    if (tierId === this.currentTier) return;
    const tier = TIERS.find((t) => t.id === tierId);
    if (!tier) return;
    if (tier.price > 0) {
      const ok = confirm(
        `Suscribirte a ${tier.name} por $${tier.price}/mes en USDC?\n\n` +
          `El cargo se registrará en tu cuenta y se descontará de tu balance de trading.`
      );
      if (!ok) return;
    }
    try {
      const res = await ApiClient.subscribe(tierId);
      this.currentTier = res?.tier?.id ?? tierId;
      alert(`✅ Suscripción ${tier.name} activada.`);
      this.render();
    } catch (e) {
      alert("No se pudo activar la suscripción: " + (e?.message || "error"));
    }
  },

  copyReferralLink() {
    const code = this.referrals?.refCode;
    if (!code) {
      alert("Conecta tu wallet primero para obtener tu código de referido.");
      return;
    }
    const link = `https://inusaur.online/?ref=${encodeURIComponent(code)}`;
    navigator.clipboard
      .writeText(link)
      .then(() => alert("Enlace de referido copiado:\n" + link))
      .catch(() => prompt("Copia tu enlace de referido:", link));
  },

  tierBadge(tierId) {
    const t = TIERS.find((x) => x.id === tierId);
    return t ? t.name : "Free";
  },

  render() {
    this.ensureContainer("premiumContainer");
    this.ensureContainer("referralsContainer");
    this.renderSubscription();
    this.renderReferrals();
  },

  ensureContainer(id) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      document.getElementById("view-profile")?.appendChild(el);
    }
    return el;
  },

  renderSubscription() {
    const el = document.getElementById("premiumContainer");
    if (!el) return;
    el.innerHTML = `
      <div class="glass-panel" style="padding:24px; margin-bottom:20px">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px">
          <h3 style="font-size:15px; font-weight:800; margin:0">💎 Planes Premium</h3>
          <span class="brand-badge" style="font-size:10px">Plan actual: ${this.tierBadge(this.currentTier)}</span>
        </div>
        <p style="font-size:12px; color:var(--text-tertiary); margin-bottom:18px">
          Se factura en USDC desde tu balance de trading. Cancela cuando quieras.
        </p>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px">
          ${TIERS.map(
            (t) => `
            <div style="padding:18px; background:rgba(255,255,255,0.02); border:1px solid ${t.id === this.currentTier ? "var(--delta-green)" : "var(--border-subtle)"}; border-radius:var(--radius-md); display:flex; flex-direction:column; gap:10px; position:relative">
              ${t.badge ? `<span class="elite-badge high" style="position:absolute; top:-9px; right:12px; font-size:9px">🔥 ${t.badge}</span>` : ""}
              <div>
                <div style="font-weight:800; font-size:16px">${t.name}</div>
                <div style="font-size:11px; color:var(--text-tertiary)">${t.tagline}</div>
              </div>
              <div class="mono" style="font-size:22px; font-weight:800">$${t.price}<span style="font-size:11px; color:var(--text-tertiary); font-weight:400">/mes</span></div>
              <ul style="list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:6px; font-size:12px; color:var(--text-secondary); flex:1">
                ${t.features.map((f) => `<li style="display:flex; gap:6px"><span style="color:var(--delta-green)">✓</span> ${f}</li>`).join("")}
              </ul>
              ${
                t.id === this.currentTier
                  ? `<button class="btn btn-ghost btn-sm" disabled style="opacity:0.6">Plan actual</button>`
                  : `<button class="btn ${t.price === 0 ? "btn-secondary" : "btn-primary"} btn-sm" onclick="window.PremiumEngine.subscribe('${t.id}')">${t.price === 0 ? "Volver a Free" : "Suscribirse"}</button>`
              }
            </div>`
          ).join("")}
        </div>
      </div>`;
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
