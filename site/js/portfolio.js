/**
 * 📊 PORTFOLIO ENGINE — Real stats, positions, and trade history from the API.
 * Replaces the hardcoded Portfolio view with live user data.
 */

import { ApiClient } from "./api.js";

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

export const PortfolioEngine = {
  container: null,
  trades: [],
  positions: [],
  pnl: null,
  wallets: [],
  loading: false,

  init() {
    const btn = document.getElementById("refreshPortfolioBtn");
    if (btn) btn.addEventListener("click", () => this.load());
  },

  async load() {
    if (this.loading) return;
    this.loading = true;
    try {
      const authed = ApiClient.isBetaUnlocked();
      if (!authed) {
        this.renderSignedOut();
        return;
      }
      const [pnlRes, posRes, tradesRes, walletsRes] = await Promise.all([
        ApiClient.getPnl(),
        ApiClient.getPositions(),
        ApiClient.getTrades(50),
        ApiClient.getWallets(),
      ]);
      this.pnl = pnlRes?.pnl ?? null;
      this.positions = posRes?.positions ?? [];
      this.trades = tradesRes?.trades ?? [];
      this.wallets = walletsRes?.wallets ?? [];
      this.render();
    } catch (e) {
      console.warn("[Portfolio] load failed:", e);
      const msg = String(e?.message || "");
      if (msg.includes("401") || /unauthorized|no auth/i.test(msg)) {
        this.renderSignedOut();
      } else {
        this.renderError();
      }
    } finally {
      this.loading = false;
    }
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

  render() {
    const el = this.target();
    if (!el) return;
    const pnl = this.pnl || {};

    const winRate = pnl.totalTrades > 0 ? (pnl.winningTrades / pnl.totalTrades) * 100 : 0;
    const openCount = this.positions.filter((p) => p.status === "open").length;
    const pnlColor = Number(pnl.totalPnlUsdc || 0) >= 0 ? "var(--delta-green)" : "var(--delta-red)";

    el.innerHTML = `
      <!-- Account header -->
      <div class="glass-panel" style="padding:28px; margin-bottom:20px">
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:16px">
          <div style="display:flex; align-items:center; gap:16px">
            <div class="author-avatar" style="width:54px; height:54px; font-size:20px">ME</div>
            <div>
              <h2 style="font-size:20px; font-weight:800">Mi Cuenta de Trading</h2>
              <div style="font-size:12px; color:var(--text-tertiary); font-family:var(--font-mono)">
                Wallet no custodial cifrada con AES-GCM (PBKDF2)
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
          ${this.statCard("PNL REALIZADO", signedUsdMicro(pnl.totalPnlUsdc), pnlColor)}
          ${this.statCard("WIN RATE", winRate.toFixed(0) + "%", "#fff")}
          ${this.statCard("POSICIONES ABIERTAS", String(openCount), "#fff")}
          ${this.statCard("OPERACIONES", String(pnl.totalTrades || 0), "#fff")}
        </div>

        <!-- Secondary stats -->
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:16px; margin-top:12px">
          ${this.statCard("VOLUMEN TOTAL", fmtUsdMicro(pnl.volumeUsdc), "#fff")}
          ${this.statCard("COMISIONES", fmtUsdMicro(pnl.totalFeesUsdc), "#fff")}
          ${this.statCard("MEJOR OPERACIÓN", signedUsdMicro(pnl.bestTradePnlUsdc), Number(pnl.bestTradePnlUsdc || 0) > 0 ? "var(--delta-green)" : "#fff")}
          ${this.statCard("PEOR OPERACIÓN", signedUsdMicro(pnl.worstTradePnlUsdc), Number(pnl.worstTradePnlUsdc || 0) < 0 ? "var(--delta-red)" : "#fff")}
        </div>
      </div>`;

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
  },

  statCard(label, value, color) {
    return `
      <div style="padding:14px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:var(--radius-md)">
        <div style="font-size:11px; color:var(--text-tertiary)">${label}</div>
        <div class="mono" style="font-size:20px; font-weight:800; color:${color}; margin-top:4px">${value}</div>
      </div>`;
  },

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
        "display:flex; justify-content:space-between; align-items:center; padding:12px; background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:var(--radius-md)";
      div.innerHTML = rowHtml(row);
      list.appendChild(div);
    }
    wrap.appendChild(list);
    return wrap;
  },

  appendPositions() {
    const open = this.positions.filter((p) => p.status === "open").slice(0, 10);
    const panel = this.makePanel(
      "📈 Posiciones Abiertas",
      "Aún no tienes posiciones abiertas. Ejecuta tu primer swap en la pestaña Trade.",
      open,
      (p) => `
        <div>
          <div style="font-weight:800; font-size:14px">$${p.token_symbol || p.token}</div>
          <div style="font-size:11px; color:var(--text-tertiary); text-transform:uppercase">${p.chain} · entrada ${fmtUsdMicro(p.avg_entry_usdc)}</div>
        </div>
        <div style="text-align:right">
          <div class="mono" style="font-weight:800; font-size:14px">${fmtUsdMicro(p.net_invested_usdc)}</div>
          <div style="font-size:11px; color:var(--text-tertiary)">${Number(p.amount_remaining || 0).toLocaleString("en-US", { maximumFractionDigits: 4 })} unidades</div>
        </div>`
    );
    this.target().appendChild(panel);
  },

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
        const token = t.buy_token === "USDC" ? t.sell_token : t.buy_token;
        const color = !hasPnl ? "#fff" : pnlNum >= 0 ? "var(--delta-green)" : "var(--delta-red)";
        const date = new Date(t.ts * 1000).toLocaleString("es-ES", {
          day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
        });
        return `
        <div>
          <div style="font-weight:800; font-size:13px">${side} ${token}</div>
          <div style="font-size:11px; color:var(--text-tertiary); text-transform:uppercase">${t.from_chain} · ${date} · ${t.status}</div>
        </div>
        <div style="text-align:right">
          <div class="mono" style="font-weight:800; font-size:13px; color:${color}">${hasPnl ? signedUsdMicro(t.realized_pnl_usdc) : fmtUsdMicro(t.buy_amount)}</div>
          ${hasPnl ? `<div style="font-size:11px; color:var(--text-tertiary)">PnL realizado</div>` : ""}
        </div>`;
      }
    );
    this.target().appendChild(panel);
  },

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
    this.doDeleteWallet(w.id);
  },

  async doDeleteWallet(id) {
    try {
      await ApiClient.deleteWallet(id);
      alert("Wallet eliminada.");
      this.load();
    } catch (e) {
      alert("No se pudo eliminar la wallet: " + (e?.message || "error"));
    }
  },
};

// Global expose for inline handlers
window.PortfolioEngine = PortfolioEngine;
