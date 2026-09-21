import { sma, ema, bollinger, rsi } from "./chart-indicators.js";

const key = "trenches_chart_preferences_v1";
const defaults = { type: "candles", scale: "linear", sma: false, ema: false, bands: false, rsi: false, volume: true, period: 20, rsiPeriod: 14 };
export function chartPreferences(input = {}) {
  const out = { ...defaults };
  if (!input || typeof input !== "object") return out;
  if (["candles", "line", "area", "bars"].includes(input.type)) out.type = input.type;
  if (["linear", "log"].includes(input.scale)) out.scale = input.scale;
  for (const flag of ["sma", "ema", "bands", "rsi", "volume"]) if (typeof input[flag] === "boolean") out[flag] = input[flag];
  for (const field of ["period", "rsiPeriod"]) if (Number.isInteger(input[field]) && input[field] >= 2 && input[field] <= 500) out[field] = input[field];
  return out;
}

export class ChartTools {
  constructor(chart, candles, library) {
    this.chart = chart; this.candles = candles; this.data = []; this.library = library;
    let stored; try { stored = JSON.parse(localStorage.getItem(key)); } catch { stored = null; }
    this.prefs = chartPreferences(stored);
    const base = { priceLineVisible: false, lastValueVisible: false, visible: false };
    this.types = { candles, line: chart.addLineSeries({ ...base, color: "#a3d9a5" }),
      area: chart.addAreaSeries({ ...base, lineColor: "#a3d9a5", topColor: "#264c3c88", bottomColor: "#10201911" }),
      bars: chart.addBarSeries({ ...base, upColor: "#a3d9a5", downColor: "#fb8e87" }) };
    this.overlays = {
      sma: chart.addLineSeries({ ...base, color: "#e5c16c", lineWidth: 2, title: "SMA" }),
      ema: chart.addLineSeries({ ...base, color: "#69c5e9", lineWidth: 2, title: "EMA" }),
      middle: chart.addLineSeries({ ...base, color: "#bba3e9", lineWidth: 1 }),
      upper: chart.addLineSeries({ ...base, color: "#bba3e9", lineWidth: 1 }),
      lower: chart.addLineSeries({ ...base, color: "#bba3e9", lineWidth: 1 }),
    };
    this.volume = chart.addHistogramSeries({ ...base, priceScaleId: "volume", priceFormat: { type: "volume" } });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: .83, bottom: 0 } });
    this.controls = document.getElementById("chartTools");
    if (this.controls) {
      this.controls.innerHTML = `<div class="chart-toolbar">
        <label>Vista<select name="type"><option value="candles">Velas</option><option value="line">Línea</option><option value="area">Área</option><option value="bars">OHLC</option></select></label>
        <label>Escala<select name="scale"><option value="linear">Lineal</option><option value="log">Logarítmica</option></select></label>
        <button type="button" data-fit>Ajustar gráfico</button>
        <button type="button" data-expand>Ampliar gráfico</button></div>
        <details><summary>Indicadores</summary><div class="chart-indicators">
        <label><input name="sma" type="checkbox"> SMA</label><label><input name="ema" type="checkbox"> EMA</label>
        <label><input name="bands" type="checkbox"> Bollinger (2σ)</label><label><input name="rsi" type="checkbox"> RSI</label>
        <label><input name="volume" type="checkbox"> Volumen USD</label>
        <label>Período medias<input name="period" type="number" min="2" max="500" step="1"></label>
        <label>Período RSI<input name="rsiPeriod" type="number" min="2" max="500" step="1"></label>
        <button type="button" data-reset>Restablecer</button></div>
        <p>EMA: semilla SMA. RSI: Wilder. Bollinger: desviación poblacional. Se calculan sobre las velas cargadas; el inicio sin muestras suficientes queda vacío.</p></details>
        <p data-indicator-status role="status"></p>`;
      this.fill();
      this.controls.addEventListener("change", () => {
        const input = {};
        for (const element of this.controls.querySelectorAll("[name]")) {
          if (!element.checkValidity()) { element.reportValidity(); return; }
          input[element.name] = element.type === "checkbox" ? element.checked : element.type === "number" ? Number(element.value) : element.value;
        }
        this.prefs = chartPreferences(input); this.save(); this.render();
      });
      this.controls.querySelector("[data-fit]").onclick = () => this.chart.timeScale().fitContent();
      this.controls.querySelector("[data-reset]").onclick = () => { this.prefs = chartPreferences(); this.fill(); this.save(); this.render(); };
      this.controls.querySelector("[data-expand]").onclick = (event) => {
        const panel = document.getElementById("terminalChartPanel");
        const expanded = panel.classList.toggle("chart-expanded");
        event.currentTarget.textContent = expanded ? "Reducir gráfico" : "Ampliar gráfico";
        window.dispatchEvent(new Event("resize"));
      };
    }
    this.render();
  }
  fill() {
    for (const element of this.controls.querySelectorAll("[name]")) {
      if (element.type === "checkbox") element.checked = this.prefs[element.name];
      else element.value = this.prefs[element.name];
    }
  }
  save() { try { localStorage.setItem(key, JSON.stringify(this.prefs)); } catch { /* Preference persistence is optional. */ } }
  setData(rows) { this.data = rows; this.render(); }
  setMarkers(markers) { this.markers = markers; this.renderMarkers(); }
  renderMarkers() {
    for (const [name, series] of Object.entries(this.types)) series.setMarkers(name === this.prefs.type ? (this.markers || []) : []);
  }
  points(values) { return this.data.map((row, i) => values[i] === null ? { time: row.time } : { time: row.time, value: values[i] }); }
  ensureRsi() {
    if (this.rsiChart) return;
    const container = document.getElementById("rsiChart");
    this.rsiChart = this.library.createChart(container, { width: container.clientWidth || 600, height: 150,
      layout: { background: { color: "transparent" }, textColor: "#aab5ac" },
      timeScale: { visible: false }, rightPriceScale: { minimumWidth: 70 },
      grid: { vertLines: { color: "#18221c" }, horzLines: { color: "#18221c" } } });
    this.rsiSeries = this.rsiChart.addLineSeries({ color: "#c5a6ec", lineWidth: 2, priceLineVisible: false,
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
    for (const price of [30, 70]) this.rsiSeries.createPriceLine({ price, color: "#7b897f", lineWidth: 1, lineStyle: 2, axisLabelVisible: true });
    let syncing = false;
    const sync = (target) => (range) => { if (syncing || !range) return; syncing = true; try { target.timeScale().setVisibleLogicalRange(range); } finally { syncing = false; } };
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(sync(this.rsiChart));
    this.rsiChart.timeScale().subscribeVisibleLogicalRangeChange(sync(this.chart));
    this.resizeObserver = new ResizeObserver(() => {
      if (container.clientWidth) this.rsiChart.applyOptions({ width: container.clientWidth });
    });
    this.resizeObserver.observe(container);
  }
  render() {
    const p = this.prefs, closes = this.data.map((row) => row.close);
    const positive = closes.filter(value => value > 0);
    const precision = positive.length ? Math.min(12, Math.max(2, 2 - Math.floor(Math.log10(Math.min(...positive))))) : 2;
    const priceFormat = { type: "price", precision, minMove: 10 ** -precision };
    for (const [name, series] of Object.entries(this.types)) {
      series.applyOptions({ visible: p.type === name, priceFormat });
      series.setData(name === "candles" || name === "bars" ? this.data.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })) : this.points(closes));
    }
    this.renderMarkers();
    this.chart.priceScale("right").applyOptions({ mode: p.scale === "log" ? 1 : 0, scaleMargins: { top: .08, bottom: p.volume ? .22 : .08 }, minimumWidth: 70 });
    const calculated = { sma: sma(closes, p.period), ema: ema(closes, p.period), ...bollinger(closes, p.period) };
    for (const [name, series] of Object.entries(this.overlays)) {
      series.applyOptions({ visible: ["sma", "ema"].includes(name) ? p[name] : p.bands, priceFormat });
      series.setData(this.points(calculated[name]));
    }
    const hasVolume = this.data.length > 0 && this.data.every((row) => typeof row.volume === "number" && Number.isFinite(row.volume) && row.volume >= 0);
    this.volume.applyOptions({ visible: p.volume && hasVolume });
    this.volume.setData(hasVolume ? this.data.map((row) => ({ time: row.time, value: row.volume, color: row.close >= row.open ? "#68af8590" : "#ee969080" })) : []);
    const rsiContainer = document.getElementById("rsiChart");
    if (rsiContainer) {
      rsiContainer.hidden = !p.rsi;
      if (p.rsi) this.ensureRsi();
      if (this.rsiSeries) this.rsiSeries.setData(this.points(rsi(closes, p.rsiPeriod)));
      const range = this.chart.timeScale().getVisibleLogicalRange();
      if (p.rsi && range) this.rsiChart.timeScale().setVisibleLogicalRange(range);
    }
    const warnings = [];
    if ((p.sma || p.ema || p.bands) && this.data.length < p.period) warnings.push(`Medias: faltan ${p.period - this.data.length} velas`);
    if (p.rsi && this.data.length <= p.rsiPeriod) warnings.push(`RSI: faltan ${p.rsiPeriod + 1 - this.data.length} velas`);
    if (p.volume && !hasVolume) warnings.push("Volumen no disponible");
    const status = this.controls?.querySelector("[data-indicator-status]");
    if (status) status.textContent = `${this.data.length} velas · ${warnings.join(" · ") || "Preferencias guardadas en este dispositivo"}`;
  }
}
