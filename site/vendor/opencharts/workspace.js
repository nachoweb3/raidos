
import { DrawingToolsManager, macd, atr, stochastic } from "./engine.js?v=20260928-6";
const TOOLS=[["none","Sel","Seleccionar"],["trendline","/","Tendencia"],["horizontal","H","Horizontal"],["vertical","V","Vertical"],["ray","Ray","Rayo"],["extended","Ext","Extendida"],["channel","Can","Canal"],["fibonacci","Fib","Fibonacci"],["fibextension","Fx","Extension Fibonacci"],["rectangle","Box","Rectangulo"],["ellipse","O","Elipse"],["arrow","->","Flecha"],["triangle","Tri","Triangulo"],["text","T","Texto"],["measure","R","Medir"]];
export class OpenChartsWorkspace {
 constructor(owner) {
  this.owner=owner;this.rows=[];this.undo=[];this.redo=[];this.selected=[];
  this.container=document.getElementById("tvChartContainer");
  const frame=document.createElement("div");frame.className="opencharts-frame";this.container.before(frame);
  this.rail=document.createElement("div");this.rail.className="opencharts-rail";frame.append(this.rail,this.container);
  for(const [tool,icon,label] of TOOLS){const b=document.createElement("button");b.type="button";b.textContent=icon;b.title=label;b.setAttribute("aria-label",label);b.dataset.draw=tool;b.onclick=()=>this.setTool(tool);this.rail.append(b);}
  this.controls=document.createElement("div");this.controls.className="opencharts-controls";
  this.controls.innerHTML='<button type="button" data-undo>Deshacer</button><button type="button" data-redo>Rehacer</button><label>Iman <select data-magnet><option value="none">No</option><option value="weak">Suave</option><option value="strong">OHLC</option></select></label><label>Color <input type="color" data-color value="#28e7a1"></label><button type="button" data-delete>Eliminar seleccion</button><label>Panel <select data-study><option value="">Ninguno</option><option value="macd">MACD (12,26,9)</option><option value="atr">ATR (14)</option><option value="stoch">Estocastico (14,3)</option></select></label><span data-note role="status"></span>';
  frame.before(this.controls);
  this.controls.querySelector("[data-undo]").onclick=()=>this.history(false);
  this.controls.querySelector("[data-redo]").onclick=()=>this.history(true);
  this.controls.querySelector("[data-delete]").onclick=()=>this.mutate(this.rows.filter(d=>!this.selected.includes(d.id)));
  this.controls.querySelector("[data-magnet]").onchange=e=>this.manager?.setMagnetMode(e.target.value);
  this.controls.querySelector("[data-study]").onchange=()=>this.renderStudy();
  this.controls.querySelector("[data-color]").onchange=e=>{
   this.manager?.setStyleDefaults(Object.fromEntries(TOOLS.map(([k])=>[k,{color:e.target.value}])));
   if(this.selected.length)this.mutate(this.rows.map(d=>this.selected.includes(d.id)?{...d,color:e.target.value}:d));
  };
  this.tree=document.createElement("details");this.tree.className="opencharts-objects";frame.after(this.tree);
  this.oscillator=document.createElement("div");this.oscillator.hidden=true;this.oscillator.style.height="150px";this.tree.after(this.oscillator);
  this.sync();
 }
 setTool(tool){this.manager?.setTool(tool);for(const b of this.rail.querySelectorAll("button"))b.setAttribute("aria-pressed",String(b.dataset.draw===tool));}
 sync(){
  const e=window.TradingEngine,key="trenches_drawings_v1:"+e.currentChain+":"+(e.currentTokenAddress||"reference:"+e.currentSymbol);
  if(key!==this.key){this.key=key;this.undo=[];this.redo=[];this.selected=[];try{const rows=JSON.parse(localStorage.getItem(key)||"[]");this.rows=Array.isArray(rows)?rows.filter(d=>d&&typeof d.id==="string"&&Number.isFinite(d.price)).slice(0,200):[];}catch{this.rows=[];}}
  const series=this.owner.types[this.owner.prefs.type];if(this.series!==series)this.suspend();this.series=series;
  if(!document.getElementById("tokenTerminal")?.open)return this.suspend();
  if(!this.manager){this.manager=new DrawingToolsManager({chart:this.owner.chart,series,container:this.container,intervalSec:e.chartInterval,timeframe:String(e.chartInterval/60)+"m",callbacks:{
   onAdd:d=>this.mutate([...this.rows,d]),onUpdate:d=>this.mutate(this.rows.map(x=>x.id===d.id?d:x)),onRemove:id=>this.mutate(this.rows.filter(d=>d.id!==id)),
   onToolFinished:()=>this.setTool("none"),onSelectTool:t=>this.setTool(t),
   onSelectionChange:ids=>{this.selected=ids;this.renderTree();},
   onRequestSettings:id=>{this.selected=[id];this.tree.open=true;this.renderTree();this.controls.querySelector("[data-color]").focus();},
   onUndo:()=>this.history(false),onRedo:()=>this.history(true)
  }});this.manager.setMagnetMode(this.controls.querySelector("[data-magnet]").value);this.setTool("none");}
  this.manager.updateTimeframe(String(e.chartInterval/60)+"m",e.chartInterval);this.manager.setDrawings(this.rows);this.renderTree();this.renderStudy();
 }
 suspend(){this.manager?.destroy();this.manager=null;}
 mutate(rows){this.undo.push(JSON.stringify(this.rows));if(this.undo.length>100)this.undo.shift();this.redo=[];this.rows=rows.slice(0,200);this.persist();}
 history(forward){const from=forward?this.redo:this.undo,to=forward?this.undo:this.redo;if(!from.length)return;to.push(JSON.stringify(this.rows));this.rows=JSON.parse(from.pop());this.persist();}
 persist(){try{localStorage.setItem(this.key,JSON.stringify(this.rows));this.note("Guardado por contrato");}catch{this.note("No se pudo guardar");}this.manager?.setDrawings(this.rows);this.renderTree();}
 note(text){this.controls.querySelector("[data-note]").textContent=text;}
 renderTree(){
  this.tree.replaceChildren();const s=document.createElement("summary");s.textContent="Objetos ("+this.rows.length+") - OpenCharts";this.tree.append(s);
  for(const d of this.rows){const b=document.createElement("button");b.type="button";b.textContent=d.type+(d.text?" - "+d.text:"");b.setAttribute("aria-pressed",String(this.selected.includes(d.id)));b.onclick=()=>this.manager?.setSelection([d.id]);this.tree.append(b);}
  this.controls.querySelector("[data-undo]").disabled=!this.undo.length;this.controls.querySelector("[data-redo]").disabled=!this.redo.length;this.controls.querySelector("[data-delete]").disabled=!this.selected.length;
 }
 renderStudy(){
  const kind=this.controls.querySelector("[data-study]").value;this.oscillator.hidden=!kind;if(!kind)return;
  if(!this.studyChart){
   this.studyChart=this.owner.library.createChart(this.oscillator,{width:this.oscillator.clientWidth||600,height:150,layout:{background:{color:"#100f1b"},textColor:"#aaa6be"},grid:{vertLines:{color:"#242130"},horzLines:{color:"#242130"}},timeScale:{visible:false}});
   const b={priceLineVisible:false,lastValueVisible:false};this.lines=[this.studyChart.addLineSeries({...b,color:"#68baff"}),this.studyChart.addLineSeries({...b,color:"#ffa466"})];this.hist=this.studyChart.addHistogramSeries(b);
   let syncing=false;const sync=target=>range=>{if(!range||syncing)return;syncing=true;try{target.timeScale().setVisibleLogicalRange(range);}finally{syncing=false;}};
   this.owner.chart.timeScale().subscribeVisibleLogicalRangeChange(sync(this.studyChart));this.studyChart.timeScale().subscribeVisibleLogicalRangeChange(sync(this.owner.chart));
   new ResizeObserver(()=>{if(this.oscillator.clientWidth)this.studyChart.applyOptions({width:this.oscillator.clientWidth});}).observe(this.oscillator);
  }
  const data=kind==="macd"?macd(this.owner.data):kind==="stoch"?stochastic(this.owner.data):{atr:atr(this.owner.data)};
  this.lines[0].setData(data.macd||data.k||data.atr||[]);this.lines[1].setData(data.signal||data.d||[]);
  this.hist.setData((data.histogram||[]).map(p=>({...p,color:p.value>=0?"#28e7a1":"#ff965b"})));
  const range=this.owner.chart.timeScale().getVisibleLogicalRange();if(range)this.studyChart.timeScale().setVisibleLogicalRange(range);
 }
}
