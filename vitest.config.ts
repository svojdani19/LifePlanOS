import { defineConfig } from "vitest/config";
import path from "path";

// Unit tests target the pure, deterministic business logic (matching, cost
// projection, extraction, classification, RBAC) — no DB or network required.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: true,
  },
});
