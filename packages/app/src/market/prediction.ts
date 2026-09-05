/**
 * 🎯 PREDICTION MARKETS — "Trade what's happening"
 *
 * Reads live event markets from Polymarket's Gamma API (public, no API key).
 * Events are sports, elections, macro outcomes, BTC milestones, etc.
 *
 * This module is read-only market data. Execution (buying a Yes/No share)
 * happens on Polygon via the CLOB API with a funded wallet — wired in a
 * later phase; the data layer is public and keyless.
 */

export interface PredictionOutcome {
  name: string;
  /** Price 0..1 (fraction of $1 share). */
  price: number;
  lastTradePrice: number | null;
}

export interface PredictionMarket {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  outcomes: string[];
  /** Parallel array to outcomes, "0.42" style strings. */
  outcomePrices: number[];
  bestAsk: number | null;
  bestBid: number | null;
  lastTradePrice: number | null;
  volumeUsd: number;
  liquidityUsd: number;
  spread: number | null;
  endDate: string | null;
  image: string;
  orderBookEnabled: boolean;
  acceptingOrders: boolean;
}

export interface PredictionEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  image: string;
  category: string;
  tags: string[];
  volumeUsd: number;
  liquidityUsd: number;
  openInterest: number;
  startDate: string | null;
  endDate: string | null;
  active: boolean;
  closed: boolean;
  featured: boolean;
  markets: PredictionMarket[];
}

const GAMMA = "https://gamma-api.polymarket.com";

function toNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Map a Gamma market object into our normalized shape. */
function mapMarket(m: any): PredictionMarket {
  const rawPrices: unknown[] = Array.isArray(m.outcomePrices) ? m.outcomePrices : [];
  const outcomes: string[] = Array.isArray(m.outcomes) ? m.outcomes : [];
  const prices = outcomes.map((_, i) => toNumber(rawPrices[i]));
  return {
    id: String(m.id ?? ""),
    question: String(m.question ?? ""),
    slug: String(m.slug ?? ""),
    conditionId: String(m.conditionId ?? ""),
    outcomes,
    outcomePrices: prices,
    bestAsk: m.bestAsk != null ? toNumber(m.bestAsk) : null,
    bestBid: m.bestBid != null ? toNumber(m.bestBid) : null,
    lastTradePrice: m.lastTradePrice != null ? toNumber(m.lastTradePrice) : null,
    volumeUsd: toNumber(m.volumeNum ?? m.volume),
    liquidityUsd: toNumber(m.liquidity),
    spread: m.spread != null ? toNumber(m.spread) : null,
    endDate: typeof m.endDate === "string" ? m.endDate : null,
    image: String(m.image ?? ""),
    orderBookEnabled: Boolean(m.enableOrderBook),
    acceptingOrders: Boolean(m.acceptingOrders),
  };
}

/** Map a Gamma event object (with nested markets) into our shape. */
function mapEvent(e: any): PredictionEvent {
  const markets: PredictionMarket[] = Array.isArray(e.markets) ? e.markets.map(mapMarket) : [];
  return {
    id: String(e.id ?? ""),
    title: String(e.title ?? ""),
    slug: String(e.slug ?? ""),
    description: String(e.description ?? ""),
    image: String(e.image ?? ""),
    category: String(e.category ?? "Other"),
    tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
    volumeUsd: toNumber(e.volume),
    liquidityUsd: toNumber(e.liquidity),
    openInterest: toNumber(e.openInterest),
    startDate: typeof e.startDate === "string" ? e.startDate : null,
    endDate: typeof e.endDate === "string" ? e.endDate : null,
    active: Boolean(e.active),
    closed: Boolean(e.closed),
    featured: Boolean(e.featured),
    markets,
  };
}

export interface PredictionQuery {
  /** 'crypto' | 'politics' | 'sports' | 'pop-culture' | ... defaults to trending. */
  category?: string;
  limit?: number;
  offset?: number;
  /** Sort by 24h volume when true (trending), else by volume. */
  trending?: boolean;
}

/** List live events, optionally filtered by category. Public + keyless. */
export async function fetchPredictionEvents(q: PredictionQuery = {}): Promise<PredictionEvent[]> {
  const limit = Math.min(q.limit ?? 30, 100);
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(q.offset ?? 0),
    closed: "false",
    active: "true",
    order: q.trending ? "volume24hr" : "volume",
    ascending: "false",
  });
  if (q.category) params.set("tag", q.category);
  const res = await fetch(`${GAMMA}/events?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Polymarket events failed (${res.status})`);
  const data = (await res.json()) as any[];
  if (!Array.isArray(data)) return [];
  return data.map(mapEvent);
}

/** Fetch a single event by slug (market detail). Public + keyless. */
export async function fetchPredictionEvent(slug: string): Promise<PredictionEvent | null> {
  const res = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Polymarket event failed (${res.status})`);
  const data = (await res.json()) as any[];
  if (!Array.isArray(data) || data.length === 0) return null;
  return mapEvent(data[0]!);
}

/** Lightweight cache: repeated detail calls hit Gamma once per slug per minute. */
const detailCache = new Map<string, { at: number; event: PredictionEvent }>();

export async function fetchPredictionEventCached(slug: string): Promise<PredictionEvent | null> {
  const hit = detailCache.get(slug);
  if (hit && Date.now() - hit.at < 60_000) return hit.event;
  const event = await fetchPredictionEvent(slug);
  if (event) detailCache.set(slug, { at: Date.now(), event });
  return event;
}

/** Categories exposed to the UI (also usable as `tag` filter on Gamma). */
export const PREDICTION_CATEGORIES = [
  "crypto",
  "politics",
  "sports",
  "pop-culture",
  "science",
  "markets",
  "geopolitics",
  "ai",
  "world",
] as const;