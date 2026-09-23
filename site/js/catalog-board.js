import { ApiClient } from "./api.js";
import { DexFeed } from "./dexfeed.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const definitions = [
  { id: "new", title: "New Pools", description: "Pools creados en las últimas 48 horas", defaults: { sort: "newest", maxAgeHours: 48 } },
  { id: "soon", title: "Liquidity", description: "Pools por liquidez observada", defaults: { sort: "liquidity" } },
  { id: "migrated", title: "Trending", description: "Actividad según volumen de 24 horas", defaults: { sort: "volume" } },
];
const fields = [["minPrice", "Precio mínimo"], ["maxPrice", "Precio máximo"], ["minMarketCap", "Market cap mínimo"],
  ["maxMarketCap", "Market cap máximo"], ["minLiquidity", "Liquidez mínima"], ["maxLiquidity", "Liquidez máxima"],
  ["minVolume", "Volumen 24h mínimo"], ["maxVolume", "Volumen 24h máximo"], ["maxAgeHours", "Edad máxima (horas)"]];
const sorts = { newest: "Más recientes", liquidity: "Mayor liquidez", volume: "Mayor volumen 24h", marketCap: "Mayor market cap", marketCapAsc: "Menor market cap", indexed: "Orden del catálogo" };
const chains = ["all", "solana", "ethereum", "base", "bsc", "arc"];
function cleanFilters(input = {}) {
  const out = {};
  if (chains.includes(input.chain)) out.chain = input.chain;
  if (Object.hasOwn(sorts, input.sort)) out.sort = input.sort;
  for (const [key] of fields) if (Number.isFinite(input[key]) && input[key] >= 0) out[key] = input[key];
  return out;
}

export class CatalogBoard {
  constructor(engine) {
    this.engine = engine;
    this.columns = definitions.map((d) => ({ ...d, filters: { ...d.defaults }, rows: [], total: 0, cursor: null, loading: false, sequence: 0, error: "" }));
    this.restore();
    window.addEventListener("popstate", () => {
      const before = JSON.stringify([this.engine.search, this.engine.activeChain, this.columns.map((c) => c.filters)]);
      this.restore();
      if (before !== JSON.stringify([this.engine.search, this.engine.activeChain, this.columns.map((c) => c.filters)])) this.refresh();
    });
  }
  restore() {
    try {
      const raw = new URL(location.href).searchParams.get("trenches");
      const state = raw && raw.length < 6000 ? JSON.parse(raw) : {};
      for (const c of this.columns) c.filters = state?.[c.id] ? { sort: c.defaults.sort, ...cleanFilters(state[c.id]) } : { ...c.defaults };
      const params = new URL(location.href).searchParams;
      this.engine.search = (params.get("marketSearch") || "").slice(0, 120);
      this.engine.activeChain = chains.includes(params.get("marketChain")) ? params.get("marketChain") : "all";
      const input = document.getElementById("trenchesSearch"); if (input) input.value = this.engine.search;
    } catch { for (const c of this.columns) c.filters = { ...c.defaults }; }
  }
  persist() {
    const url = new URL(location.href);
    url.searchParams.set("trenches", JSON.stringify(Object.fromEntries(this.columns.map((c) => [c.id, c.filters]))));
    if (this.engine.search) url.searchParams.set("marketSearch", this.engine.search); else url.searchParams.delete("marketSearch");
    url.searchParams.set("marketChain", this.engine.activeChain);
    history.replaceState(history.state, "", url);
  }
  async refresh() { await Promise.all(this.columns.map((c) => this.load(c))); }
  async load(c, more = false) {
    if (more && (c.loading || !c.cursor)) return;
    const query = new URLSearchParams({ chain: this.engine.activeChain, ...c.filters, q: this.engine.search, limit: "40" });
    const queryKey = query.toString();
    const changed = c.queryKey !== queryKey;
    const pages = more || changed ? 1 : Math.max(1, c.pages || 1);
    if (changed) {
      c.rows = []; c.cursor = null; c.total = 0; c.pages = 0; c.queryKey = queryKey;
      const scroller = this.engine.target()?.querySelector(`[data-catalog-column="${c.id}"] [data-rows]`);
      if (scroller) scroller.scrollTop = 0;
    }
    const sequence = ++c.sequence;
    c.controller?.abort(); c.controller = new AbortController();
    c.loading = true; c.error = ""; this.render();
    try {
      if (more) query.set("cursor", c.cursor);
      const merged = new Map((more ? c.rows : []).map((r) => [r.id, r]));
      let response, loaded = 0;
      do {
        response = await ApiClient.request("/api/market/catalog?" + query, { signal: c.controller.signal });
        if (sequence !== c.sequence) return;
        for (const row of DexFeed._rows(response.pairs).map((r) => this.engine.normalizeMarket(r))) merged.set(row.id, row);
        loaded++;
        if (response.nextCursor) query.set("cursor", response.nextCursor);
      } while (loaded < pages && response.nextCursor);
      c.rows = [...merged.values()]; c.total = response.total; c.cursor = response.nextCursor;
      c.pages = more ? (c.pages || 0) + loaded : loaded;
      c.asOf = c.rows.length ? Math.min(...c.rows.map((r) => r.dex._updatedAt)) : null;
      this.engine.market = [...new Map(this.columns.flatMap((col) => col.rows).map((r) => [r.id, r])).values()];
    } catch (err) {
      if (sequence === c.sequence && err.name !== "AbortError") c.error = "No se pudo cargar esta columna. " + err.message;
    } finally { if (sequence === c.sequence) { c.loading = false; this.render(); } }
  }
  async discover() {
    const chain = this.engine.activeChain;
    const responses = await Promise.allSettled(["new", "trending"].map((kind) => ApiClient.request(`/api/market/pools?chain=${encodeURIComponent(chain)}&kind=${kind}&page=1`)));
    await this.refresh();
    if (responses.every((r) => r.status === "rejected")) {
      for (const c of this.columns) c.error = "Descubrimiento no disponible. Se conserva el catálogo guardado.";
      this.render();
    }
  }
  render() {
    const target = this.engine.target(); if (!target) return;
    if (!target.querySelector("[data-catalog-column]")) {
      target.innerHTML = this.columns.map((c) => `<section class="trenches-col catalog-column" data-catalog-column="${c.id}" aria-label="${c.title}">
        <header><h3>${c.title}</h3><span data-count></span><p>${c.description}</p>
        <div class="catalog-actions"><button data-filters>Filtros</button><button data-reset>Restablecer</button><button data-refresh aria-label="Refrescar ${c.title}">Actualizar</button></div>
        <small data-status aria-live="polite"></small></header>
        <div class="trenches-col-scroll" data-rows tabindex="0" aria-label="Resultados ${c.title}"></div>
        <footer><button data-more>Cargar más</button></footer></section>`).join("") +
        `<div class="catalog-note">Catálogo persistente de pools observados. La existencia de un pool no confirma una ruta de trading.<button data-discover>Descubrir pools recientes</button></div>`;
      for (const c of this.columns) {
        const el = target.querySelector(`[data-catalog-column="${c.id}"]`);
        el.querySelector("[data-filters]").onclick = () => this.openFilters(c);
        el.querySelector("[data-reset]").onclick = () => { c.filters = { ...c.defaults }; this.persist(); this.load(c); };
        el.querySelector("[data-refresh]").onclick = () => this.load(c);
        el.querySelector("[data-more]").onclick = () => this.load(c, true);
        el.querySelector("[data-rows]").addEventListener("scroll", () => this.renderRows(c));
      }
      target.querySelector("[data-discover]").onclick = () => this.discover();
    }
    for (const c of this.columns) {
      const el = target.querySelector(`[data-catalog-column="${c.id}"]`);
      el.querySelector("[data-count]").textContent = `${c.total} resultados`;
      const active = JSON.stringify(c.filters) !== JSON.stringify(c.defaults);
      el.querySelector("[data-filters]").textContent = active ? "Filtros activos" : "Filtros";
      el.querySelector("[data-filters]").setAttribute("aria-pressed", String(active));
      el.querySelector("[data-status]").textContent = c.error || (c.loading ? "Cargando…" : `${sorts[c.filters.sort]} · ${c.asOf ? "Datos: " + new Date(c.asOf).toLocaleTimeString() : "Sin datos"}`);
      const more = el.querySelector("[data-more]"); more.disabled = c.loading || !c.cursor; more.textContent = c.loading ? "Cargando…" : c.cursor ? "Cargar más" : "Fin de resultados";
      this.renderRows(c);
    }
    const count = document.getElementById("trenchesCount"); if (count) count.textContent = `${this.engine.market.length} cargados`;
    const badge = document.getElementById("trenchesLiveBadge"); if (badge) badge.textContent = "Catálogo";
  }
  renderRows(c) {
    const el = this.engine.target()?.querySelector(`[data-catalog-column="${c.id}"] [data-rows]`); if (!el) return;
    const top = el.scrollTop;
    const height = 112, start = Math.max(0, Math.floor(top / height) - 3);
    const end = Math.min(c.rows.length, start + Math.ceil((el.clientHeight || 420) / height) + 7);
    const range = `${start}:${end}:${c.sequence}:${c.rows.length}:${c.loading}:${c.error}:${this.engine.selected?.id}`;
    if (el.dataset.range === range) return;
    el.dataset.range = range;
    const focusedAction = el.contains(document.activeElement) ? document.activeElement.getAttribute("onclick") : null;
    el.innerHTML = c.rows.length ? `<div style="height:${start * height}px" aria-hidden="true"></div>` +
      c.rows.slice(start, end).map((row) => `<div class="catalog-row" style="height:${height}px">${this.engine.renderRow(row)}<small>${esc(row.dex.source)} · ${esc(row.dex.status)} · ${new Date(row.dex._updatedAt).toLocaleTimeString()}</small></div>`).join("") +
      `<div style="height:${Math.max(0, c.rows.length - end) * height}px" aria-hidden="true"></div>` :
      `<p class="catalog-empty">${c.loading ? "Consultando catálogo…" : c.error ? "Error de consulta. Pulsa Actualizar." : "Sin resultados. Ajusta los filtros o descubre pools recientes."}</p>`;
    el.scrollTop = top;
    if (focusedAction) [...el.querySelectorAll("button")].find((button) => button.getAttribute("onclick") === focusedAction)?.focus({ preventScroll: true });
  }
  openFilters(c) {
    document.getElementById("catalogFilters")?.remove();
    const dialog = document.createElement("dialog"); dialog.id = "catalogFilters"; dialog.className = "catalog-filters";
    dialog.setAttribute("aria-labelledby", "catalogFiltersTitle");
    dialog.innerHTML = `<form><header><h2 id="catalogFiltersTitle">Filtros · ${c.title}</h2><button type="button" data-close aria-label="Cerrar filtros">Cerrar</button></header>
      <p>Importes en USD. Los valores desconocidos quedan fuera de los filtros numéricos.</p>
      <div class="catalog-filter-grid"><label>Red<select name="chain">${chains.map((chain) => `<option value="${chain}">${chain === "all" ? "Todas" : chain}</option>`).join("")}</select></label>
      <label>Orden<select name="sort">${Object.entries(sorts).map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select></label>
      ${fields.map(([key, label]) => `<label>${label}<input name="${key}" type="number" min="0" step="any" inputmode="decimal"></label>`).join("")}</div>
      <p>Holders, impuestos, concentración y sentimiento: filtros no disponibles hasta tener datos fiables.</p>
      <fieldset><legend>Presets en este dispositivo</legend><input name="presetName" aria-label="Nombre del preset" maxlength="60"><select name="preset" aria-label="Preset guardado"></select>
        <div class="catalog-actions"><button type="button" data-save>Guardar</button><button type="button" data-load>Cargar</button><button type="button" data-rename>Renombrar</button><button type="button" data-delete>Eliminar</button></div></fieldset>
      <p data-estimate aria-live="polite">${c.total} resultados con los filtros aplicados</p>
      <footer><button type="button" data-clear>Limpiar</button><button type="submit">Aplicar filtros</button></footer></form>`;
    document.body.appendChild(dialog);
    const form = dialog.querySelector("form"), presetKey = "trenches_column_presets_v1";
    const fill = (filters) => { for (const key of ["chain", "sort", ...fields.map(([k]) => k)]) form.elements[key].value = filters[key] ?? (key === "chain" ? this.engine.activeChain : ""); };
    const read = () => {
      const value = { chain: form.elements.chain.value, sort: form.elements.sort.value };
      for (const [key] of fields) if (form.elements[key].value !== "") value[key] = Number(form.elements[key].value);
      return cleanFilters(value);
    };
    let presets = {};
    try { presets = JSON.parse(localStorage.getItem(presetKey) || "{}"); if (!presets || typeof presets !== "object" || Array.isArray(presets)) presets = {}; } catch { presets = {}; }
    const listPresets = () => { form.elements.preset.innerHTML = Object.keys(presets).map((name) => `<option>${esc(name)}</option>`).join(""); };
    const savePresets = () => { try { localStorage.setItem(presetKey, JSON.stringify(presets)); listPresets(); } catch { dialog.querySelector("[data-estimate]").textContent = "No se pudo guardar en este dispositivo."; } };
    fill(c.filters); listPresets();
    const previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    dialog.addEventListener("close", () => { document.body.style.overflow = previousOverflow; dialog.remove(); }, { once: true });
    dialog.querySelector("[data-close]").onclick = () => dialog.close();
    dialog.querySelector("[data-clear]").onclick = () => { fill({ sort: c.defaults.sort }); estimate(); };
    dialog.querySelector("[data-save]").onclick = () => { const name = form.elements.presetName.value.trim(); if (name && Object.keys(presets).length < 30) { Object.defineProperty(presets, name, { value: read(), enumerable: true, configurable: true, writable: true }); savePresets(); } };
    dialog.querySelector("[data-load]").onclick = () => { const value = presets[form.elements.preset.value]; if (value) { fill(cleanFilters(value)); estimate(); } };
    dialog.querySelector("[data-delete]").onclick = () => { delete presets[form.elements.preset.value]; savePresets(); };
    dialog.querySelector("[data-rename]").onclick = () => { const old = form.elements.preset.value, name = form.elements.presetName.value.trim(); if (name && old && name !== old && !Object.hasOwn(presets, name)) { Object.defineProperty(presets, name, { value: presets[old], enumerable: true, configurable: true, writable: true }); delete presets[old]; savePresets(); } };
    let timer, estimateSeq = 0;
    const estimate = () => {
      clearTimeout(timer); const seq = ++estimateSeq;
      timer = setTimeout(async () => {
        try {
          const result = await ApiClient.request("/api/market/catalog?" + new URLSearchParams({ ...read(), q: this.engine.search, limit: "1" }));
          if (seq === estimateSeq && dialog.isConnected) dialog.querySelector("[data-estimate]").textContent = `${result.total} resultados`;
        } catch { if (seq === estimateSeq && dialog.isConnected) dialog.querySelector("[data-estimate]").textContent = "Filtros inválidos o consulta no disponible."; }
      }, 300);
    };
    form.addEventListener("input", estimate);
    form.addEventListener("submit", (event) => { event.preventDefault(); c.filters = read(); this.persist(); dialog.close(); this.load(c); });
    dialog.showModal();
  }
}
