import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceTextModule } from "node:vm";

const SITE_JS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "site", "js");

/**
 * Guard: every frontend module must be parseable as an ES module.
 *
 * `node --check` misses some object-literal errors (e.g. missing commas
 * between methods), and the whole frontend dies silently when one module
 * in the import graph fails to parse — every tab/button stops working.
 * This test uses V8's real module parser (the same one Chrome uses).
 */

describe("frontend module graph", () => {
  const files = readdirSync(SITE_JS_DIR).filter((f) => f.endsWith(".js"));
  it("versions the whole module graph so deployments cannot mix cached releases", () => {
    const html = readFileSync(join(SITE_JS_DIR, "..", "app.html"), "utf8");
    const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1]).imports;
    const version = new URL(map["./js/app.js"], "https://test.local").search;
    expect(version).toMatch(/^\?v=\d{8}-\d+$/);
    for (const file of files) expect(map["./js/" + file]).toBe("./js/" + file + version);
    expect(html).toContain('src="js/app.js' + version + '"');
  });

  it("finds the expected site modules", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files).toContain("api.js");
    expect(files).toContain("app.js");
  });

  it("never pins one module at two versions (dual instance trap, bit 2026-10-01)", () => {
    // Relative module imports bypass the importmap (they resolve per URL), so
    // a module imported with two different ?v= pins — or both pinned and
    // unpinned — loads TWICE. Two TgSignalsEngine instances overwrote each
    // other in production and the old one won. This guard makes that
    // regression impossible: one module ⇒ one exact pinned URL.
    const duals = new Map<string, Set<string>>();
    const re = /from\s*"\.\/([a-z0-9-]+\.js)(\?v=[0-9-]+)?"/g;
    for (const file of files) {
      const src = readFileSync(join(SITE_JS_DIR, file), "utf8");
      for (const m of src.matchAll(re)) {
        const mod = m[1];
        const pin = m[2] ?? "(unpinned)";
        if (!duals.has(mod)) duals.set(mod, new Set());
        duals.get(mod)!.add(pin);
      }
    }
    // Un módulo SIEMPRE sin pin está bien (una instancia). El peligro es dos
    // URLs distintas: dos pins, o pin + sin pin mezclados (size > 1).
    for (const [mod, pins] of duals) {
      expect(pins.size, `module ${mod} imported at multiple versions: ${[...pins].join(", ")}`).toBe(1);
    }
  });

  it("keeps internal pins in lockstep with the importmap version", () => {
    // The importmap version is the release train: an internal pin that lags
    // behind (e.g. app.js importing ./tg-signals.js?v=OLD) keeps serving a
    // stale module forever. Whatever pin exists must equal the importmap's.
    const html = readFileSync(join(SITE_JS_DIR, "..", "app.html"), "utf8");
    const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1]).imports;
    const release = new URL(map["./js/app.js"], "https://test.local").search.replace("?v=", "");
    for (const file of files) {
      const src = readFileSync(join(SITE_JS_DIR, file), "utf8");
      for (const m of src.matchAll(/from\s*"\.\/[a-z0-9-]+\.js\?v=([0-9-]+)"/g)) {
        expect(m[1], `${file} pins an internal module at v=${m[1]}, importmap is v=${release}`).toBe(release);
      }
    }
  });

  for (const file of files) {
    it(`parses ${file} as an ES module`, () => {
      const src = readFileSync(join(SITE_JS_DIR, file), "utf8");
      let error: unknown;
      try {
        new SourceTextModule(src); // no evaluation — parse only, no side effects
      } catch (e) {
        error = e;
      }
      expect(error).toBeUndefined();
    });
  }
});
