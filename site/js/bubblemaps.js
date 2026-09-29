// Official integration: https://docs.bubblemaps.io/iframe/quickstart
// Production embedding requires a domain-approved public partner ID.
const CHAINS = { solana: "solana", ethereum: "eth", eth: "eth", bsc: "bsc", base: "base", tron: "tron", sonic: "sonic", ton: "ton", avalanche: "avalanche", polygon: "polygon", monad: "monad", aptos: "aptos", arbitrum: "arbitrum", hyperevm: "hyperevm", robinhood: "robinhood", arc: "arc" };
export function bubbleMapLinks(chain, address, partnerId = "") {
  const mapped = CHAINS[String(chain).toLowerCase()];
  if (!mapped || typeof address !== "string" || !/^[a-zA-Z0-9_:-]{20,128}$/.test(address)) return null;
  const url = new URL("https://v2.bubblemaps.io/map");
  url.searchParams.set("chain", mapped);
  url.searchParams.set("address", address);
  const embed = new URL("https://iframe.bubblemaps.io/map");
  embed.search = url.search;
  if (partnerId) embed.searchParams.set("partnerId", partnerId);
  return { external: url.href, embed: partnerId ? embed.href : null };
}

export const BubbleMaps = {
  mount(dialog) {
    if (this.panel) return;
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("../css/bubblemaps.css?v=20260928-6", import.meta.url).href;
    document.head.appendChild(stylesheet);
    const panel = this.panel = document.createElement("section");
    panel.className = "terminal-bubblemaps";
    panel.setAttribute("aria-label", "Mapa de holders Bubblemaps");
    panel.innerHTML = '<div class="bubblemaps-heading"><strong>Bubblemaps</strong><span>Holders y conexiones</span><a data-map-link target="_blank" rel="noopener noreferrer">Abrir mapa</a><button type="button" data-map-toggle hidden aria-expanded="false">Ver en terminal</button></div><p data-map-status role="status"></p><div data-map-frame hidden></div>';
    dialog.querySelector("#poolActivity")?.before(panel);
    this.status = panel.querySelector("[data-map-status]");
    this.link = panel.querySelector("[data-map-link]");
    this.toggle = panel.querySelector("[data-map-toggle]");
    this.frame = panel.querySelector("[data-map-frame]");
    this.toggle.onclick = () => this.frame.hidden ? this.expand() : this.suspend();
    // Public partner IDs are safe in frontend metadata. Demo is localhost-only.
    const configured = document.querySelector('meta[name="bubblemaps-partner-id"]')?.content?.trim();
    this.partnerId = configured && configured !== "demo" ? configured :
      ["localhost", "0.0.0.0"].includes(location.hostname) ? "demo" : "";
  },
  setToken(chain, address) {
    if (!this.panel) return;
    this.suspend();
    this.links = bubbleMapLinks(chain, address, this.partnerId);
    this.link.hidden = !this.links;
    this.toggle.hidden = !this.links?.embed;
    if (!this.links) {
      this.link.removeAttribute("href");
      this.status.textContent = address ? "Bubblemaps no admite esta red o este contrato." : "Selecciona un contrato para consultar su mapa de holders.";
      return;
    }
    this.link.href = this.links.external;
    this.status.textContent = "Consulta concentracion y transferencias entre holders. Los tokens nuevos pueden no tener mapa todavia.";
    this.link.title = "Abrir el contrato seleccionado en Bubblemaps";
  },
  expand() {
    if (!this.links?.embed) return;
    this.frame.replaceChildren();
    const iframe = document.createElement("iframe");
    iframe.title = "Bubblemaps: distribucion y conexiones de holders";
    iframe.src = this.links.embed;
    iframe.allow = "clipboard-write";
    iframe.loading = "lazy";
    this.frame.appendChild(iframe);
    this.frame.hidden = false;
    this.toggle.textContent = "Cerrar mapa";
    this.toggle.setAttribute("aria-expanded", "true");
    this.status.textContent = "Si el mapa no esta disponible aqui, abre el contrato en Bubblemaps.";
  },
  suspend() {
    if (!this.frame) return;
    this.frame.replaceChildren();
    this.frame.hidden = true;
    this.toggle.textContent = "Ver en terminal";
    this.toggle.setAttribute("aria-expanded", "false");
  },
};
