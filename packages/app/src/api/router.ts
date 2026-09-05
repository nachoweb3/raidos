/**
 * 🧭 ROUTER — minimal route table over node:http (zero dependencies)
 * Supports path params (`/api/launches/:id/buy`), JSON body parsing, a uniform
 * JSON error envelope and per-request error isolation.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export type HttpMethod = "GET" | "POST" | "DELETE";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Matched path params, e.g. { id: "3" } for /api/launches/:id/buy */
  params: Record<string, string>;
  /** Parsed query string */
  query: URLSearchParams;
  /** Parsed JSON body (POST only; {} when absent/invalid) */
  body: Record<string, unknown>;
  /** Authenticated user id (null when unauthenticated) */
  userId: number | null;
}

export type Handler = (ctx: RequestContext) => Promise<void> | void;

interface Route {
  method: HttpMethod;
  segments: string[]; // ":name" marks a param segment
  handler: Handler;
  /** When true, requests must present a valid Bearer API key. */
  requiresAuth: boolean;
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export class Router {
  private routes: Route[] = [];

  /** Register a public route (no auth required). */
  publicRoute(method: HttpMethod, path: string, handler: Handler): this {
    return this.add(method, path, handler, false);
  }

  /** Register a route that requires a valid Bearer API key. */
  route(method: HttpMethod, path: string, handler: Handler): this {
    return this.add(method, path, handler, true);
  }

  private add(method: HttpMethod, path: string, handler: Handler, requiresAuth: boolean): this {
    const segments = path.split("/").filter(Boolean);
    this.routes.push({ method, segments, handler, requiresAuth });
    return this;
  }

  /** Find a matching route. Returns null when nothing matches. */
  match(method: string, pathSegments: string[]): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== pathSegments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const pattern = route.segments[i]!;
        const actual = pathSegments[i]!;
        if (pattern.startsWith(":")) {
          params[pattern.slice(1)] = decodeURIComponent(actual);
        } else if (pattern !== actual) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  get hasAuthProtectedRoutes(): boolean {
    return this.routes.some((r) => r.requiresAuth);
  }
}

/** Send a JSON response. */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  });
  res.end(payload);
}

/** Read and parse a JSON request body (returns {} for empty bodies). */
export function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
