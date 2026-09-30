/**
 * 🔐 GATE STATE — estado compartido del pase de acceso a las señales TG (24h).
 *
 * El pase lo emite POST /api/tg/redeem al canjear un código del bot (/code) y
 * llega firmado (`fp.HMAC`). Como el site llama a la API cross-origin, la
 * cookie `tgp` no siempre basta: el pase viaja también en el header x-tg-pass.
 * Este módulo vive aparte para que cualquier capa (p. ej. los overlays del
 * terminal, que piden /api/tg/signals) reutilice las MISMAS claves y headers
 * sin duplicar lógica.
 */

const GATE_LS_KEY = "trenches_tg_gate";
const GATE_PASS_KEY = "trenches_tg_pass";

export function gateStorage() {
  try { return JSON.parse(localStorage.getItem(GATE_LS_KEY) || "null"); }
  catch { return null; }
}

/** Pase firmado (fp.HMAC) devuelto por /api/tg/redeem — viaja como header x-tg-pass. */
export function gatePass() {
  try { return localStorage.getItem(GATE_PASS_KEY) || ""; }
  catch { return ""; }
}

export function gateSetState(until, pass) {
  try {
    if (until) {
      localStorage.setItem(GATE_LS_KEY, JSON.stringify({ until: Number(until) * 1000 }));
      if (pass) localStorage.setItem(GATE_PASS_KEY, String(pass));
    } else {
      localStorage.removeItem(GATE_LS_KEY);
      localStorage.removeItem(GATE_PASS_KEY);
    }
  } catch { /* private mode: el gate se re-evalúa cada visita */ }
}

/** Headers de pase para llamadas /api/tg/* (cross-origin: la cookie no basta). */
export function gateHeaders() {
  const pass = gatePass();
  return pass ? { "x-tg-pass": pass } : {};
}

export function gateCountdown(untilMs) {
  const left = Math.max(0, untilMs - Date.now());
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
