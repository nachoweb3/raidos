import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // vm.SourceTextModule (used by tests/site-modules.test.ts) requires this flag.
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--experimental-vm-modules"] } },
  },
});
