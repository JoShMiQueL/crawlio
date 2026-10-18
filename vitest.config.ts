import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The vitest suite is test/. e2e/render.test.ts is bun:test-only — it
    // runs via `bun run e2e` (scripts/e2e.ts) against the packed tarball,
    // and its `bun:test`/`crawlio` imports cannot resolve under node.
    include: ["test/**/*.test.ts"],
  },
});
