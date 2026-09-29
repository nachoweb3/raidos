import { ApiClient } from "./api.js";

const number = (value, digits = 0) => typeof value === "number" && Number.isFinite(value)
  ? value.toLocaleString("es-ES", { maximumFractionDigits: digits }) : "N/D";
const date = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "sin fecha";
  return new Date(value < 1e12 ? value * 1000 : value).toLocaleString("es-ES");
};
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function addressLink(address, chain, account = false) {
  if (typeof address !== "string" || !/^[a-zA-Z0-9]{20,64}$/.test(address)) return element("span", "N/D");
  const roots = { solana: "https://solscan.io/", ethereum: "https://etherscan.io/", base: "https://basescan.org/", bsc: "https://bscscan.com/" };
  if (!roots[chain]) return element("span", address);
  const a = element("a", address.slice(0, 6) + "\u2026" + address.slice(-6));
  a.href = roots[chain] + (chain === "solana" ? account ? "account/" : "token/" : "address/") + encodeURIComponent(address);
  a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = address;
  return a;
}
function metric(grid, label, value, detail) {
  const item = element("div", undefined, "risk-detail-metric");
  item.append(element("span", label), element("strong", value));
  if (detail) item.append(element("small", detail));
  grid.append(item);
}
function authority(value) { return value === true ? "Activa" : value === false ? "Revocada" : "N/D"; }

export const TokenRiskPanel = {
  mount(dialog) {
    if (this.panel) return;
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = new URL("../css/token-risk-panel.css?v=20260928-7", import.meta.url).href;
    document.head.append(css);
    this.panel = element("section", undefined, "terminal-risk-detail");
    this.panel.setAttribute("aria-label", "Riesgos y actividad del contrato");
    const heading = element("div", undefined, "risk-detail-heading");
    this.retry = element("button", "Actualizar");
    this.retry.type = "button";
    this.retry.onclick = () => this.setToken(this.chain, this.address);
    heading.append(element("strong", "Riesgos del contrato"), this.retry);
    this.securityArea = element("div", undefined, "risk-detail-section");
    this.onchainArea = element("div", undefined, "risk-detail-section");
    this.panel.append(heading, this.securityArea, this.onchainArea);
    const anchor = dialog.querySelector(".terminal-bubblemaps") || dialog.querySelector("#poolActivity");
    if (anchor) anchor.before(this.panel);
    else dialog.append(this.panel);
    this.clear();
  },
  clear() {
    this.sequence = (this.sequence || 0) + 1;
    this.controller?.abort();
    this.chain = null; this.address = null;
    if (!this.panel) return;
    this.retry.disabled = true;
    this.securityArea.replaceChildren(element("p", "Selecciona un contrato para consultar sus riesgos."));
    this.onchainArea.replaceChildren();
  },
  async setToken(chain, address) {
    if (!this.panel) return;
    this.clear();
    if (typeof address !== "string" || !/^[a-zA-Z0-9]{20,64}$/.test(address)) return;
    this.chain = String(chain || "").toLowerCase(); this.address = address;
    const sequence = this.sequence;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.securityArea.replaceChildren(element("p", "Consultando seguridad\u2026"));
    this.onchainArea.replaceChildren(element("p", this.chain === "solana"
      ? "Analizando muestra on-chain\u2026 Puede tardar hasta un minuto."
      : "El historial on-chain de Helius esta disponible para Solana."));
    const request = async (path, area, render) => {
      try {
        const data = await ApiClient.request(path, { signal });
        if (sequence !== this.sequence) return;
        render.call(this, data);
      } catch {
        if (sequence !== this.sequence || signal.aborted) return;
        area.replaceChildren(element("p", "No se pudo consultar esta fuente. Pulsa Actualizar para reintentar.", "risk-detail-error"));
      }
    };
    const jobs = [request("/api/market/security?chain=" + encodeURIComponent(this.chain) + "&token=" + encodeURIComponent(address), this.securityArea, this.renderSecurity)];
    if (this.chain === "solana") jobs.push(request("/api/market/onchain-risk?chain=solana&address=" + encodeURIComponent(address), this.onchainArea, this.renderOnchain));
    await Promise.all(jobs);
    if (sequence === this.sequence) this.retry.disabled = false;
  },
  renderSecurity(data) {
    const area = this.securityArea;
    area.replaceChildren(element("h4", "Concentracion y autoridades"));
    if (!data?.report) {
      area.append(element("p", "La fuente no ofrece un informe para este contrato. N/D no significa riesgo cero."));
      return;
    }
    const report = data.report, m = report.metrics || {};
    const grid = element("div", undefined, "risk-detail-grid");
    metric(grid, "Top 10", m.top10Pct == null ? "N/D" : number(m.top10Pct, 2) + "%", "Concentracion por cuentas; pueden incluir pools.");
    metric(grid, "Holders", number(m.holders));
    metric(grid, "Mint", authority(m.mintActive));
    metric(grid, "Freeze", authority(m.freezeActive));
    metric(grid, "Rugs observados", m.creatorRugs == null || m.creatorTokensObserved == null ? "N/D"
      : number(m.creatorRugs) + " / " + number(m.creatorTokensObserved), "Historial parcial de la fuente; no es un historial completo.");
    metric(grid, "Detecciones insider", number(m.insiderDetections), "Detecciones de la fuente; no porcentaje de supply.");
    area.append(grid);
    if (m.creatorAddress) {
      const creator = element("p", "Creador identificado por la fuente: ");
      creator.append(addressLink(m.creatorAddress, this.chain, true)); area.append(creator);
    }
    if (Array.isArray(m.topHolders) && m.topHolders.length) {
      const details = element("details");
      details.append(element("summary", "Ver cuentas principales"));
      const list = element("ul", undefined, "risk-detail-launches");
      for (const holder of m.topHolders.slice(0, 20)) {
        const li = element("li");
        li.append(addressLink(holder.address, this.chain, true), element("span", number(holder.pct, 2) + "%"));
        list.append(li);
      }
      details.append(list); area.append(details);
    }
    if (Array.isArray(m.creatorHistory) && m.creatorHistory.length) {
      const details = element("details");
      details.append(element("summary", "Historial del creador reportado por la fuente"));
      const list = element("ul", undefined, "risk-detail-launches");
      for (const token of m.creatorHistory.slice(0, 20)) {
        const li = element("li");
        li.append(addressLink(token.mint, this.chain), element("span", token.rugged === true
          ? "Marcado rug por la fuente" : token.rugged === false ? "Sin marca rug en la fuente" : "Rug sin determinar"));
        list.append(li);
      }
      details.append(list); area.append(details);
    }
    area.append(element("p", "Fuente: " + String(report.provider || data.source || "N/D") + " \u00b7 " +
      (data.status === "LIVE" ? "Consulta disponible" : "Datos parciales o en cache") + " \u00b7 " + date(data.asOf), "risk-detail-source"));
  },
  renderOnchain(data) {
    const area = this.onchainArea;
    if (data?.address !== this.address || data?.chain !== this.chain) {
      area.replaceChildren(element("p", "La respuesta no corresponde al contrato seleccionado.", "risk-detail-error")); return;
    }
    const bundle = data.bundle || {}, creator = data.creator || {};
    area.replaceChildren(element("h4", "Actividad on-chain observada"));
    const grid = element("div", undefined, "risk-detail-grid");
    metric(grid, "Bundles confirmados", "N/D", "Un tip Jito no demuestra pertenencia a un bundle.");
    metric(grid, "Transacciones con tip Jito", number(bundle.tippedTransactions), "Sobre " + number(bundle.sampleSize) + " transacciones analizadas.");
    metric(grid, "Cobertura de la muestra", number(bundle.sampleSize) + " / " + number(bundle.requestedSampleSize),
      bundle.complete === true ? "Muestra solicitada completa; no todo el historial." : "Muestra parcial.");
    metric(grid, "Lanzamientos observados", number(creator.tokensLaunched), "En " + number(creator.sampleSize) + " transacciones del pagador analizadas.");
    area.append(grid);
    const payer = element("p", "Pagador del despliegue: ");
    payer.append(addressLink(creator.creator, this.chain, true));
    area.append(payer, element("p", "El pagador de comisiones no acredita la identidad del creador."));
    if (creator.createdAt) area.append(element("p", "Despliegue observado: " + date(creator.createdAt)));
    area.append(element("p", creator.historyComplete === true
      ? "Se alcanzo el final del historial disponible del pagador; las transacciones clasificadas no garantizan todos sus lanzamientos."
      : "Historial parcial del pagador: no se ha verificado todo su historial.", "risk-detail-source"));
    if (creator.historySource) area.append(element("p", "Historial: " +
      (creator.historySource === "helius-archive" ? "Archivo Helius" : "Muestra RPC") + " \u00b7 " +
      number(creator.sampleSize) + " / " + number(creator.requestedSampleSize) + " transacciones", "risk-detail-source"));
    area.append(element("p", "Ventana de la muestra: " + date(bundle.windowFrom) + " \u2014 " + date(bundle.windowTo), "risk-detail-source"));
    if (Array.isArray(creator.launches) && creator.launches.length) {
      const details = element("details"), summary = element("summary", "Ver lanzamientos observados (" + creator.launches.length + ")");
      const list = element("ul", undefined, "risk-detail-launches");
      for (const launch of creator.launches.slice(0, 30)) {
        const li = element("li");
        li.append(addressLink(launch.mint, this.chain));
        li.append(element("span", launch.poolFound === true ? "Pool observado" : launch.poolFound === false ? "Sin pool observado" : "Pool sin verificar"));
        if (typeof launch.liquidityUsd === "number" && Number.isFinite(launch.liquidityUsd))
          li.append(element("span", "Liquidez $" + number(launch.liquidityUsd, 2)));
        list.append(li);
      }
      details.append(summary, list, element("p", "No encontrar un pool no demuestra un rug."));
      area.append(details);
    }
    area.append(element("p", "Fuente: " + String(data.source || "Helius") + " \u00b7 " +
      (data.status === "LIVE" ? "Consulta disponible" : "Cobertura parcial") + " \u00b7 " + date(data.asOf), "risk-detail-source"));
  },
};
