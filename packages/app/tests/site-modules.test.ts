import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceTextModule } from "node:vm";

/**
 * Guard: every frontend module must be parseable as an ES module.
 *
 * `node --check` misses some object-literal errors (e.g. missing commas
 * between methods), and the whole frontend dies silently when one module
 * in the import graph fails to parse — every tab/button stops working.
 * This test uses V8's real module parser (the same one Chrome uses).
 */

const SITE_JS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "site", "js");

describe("frontend module graph", () => {
  const files = readdirSync(SITE_JS_DIR).filter((f) => f.endsWith(".js"));

  it("finds the expected site modules", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files).toContain("api.js");
    expect(files).toContain("app.js");
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
