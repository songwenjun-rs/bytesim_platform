import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Vitest config — coverage broadened to the whole src/ tree (the original
 * config opted-in file by file and is now badly out of date: it still listed
 * Login / Tuner Pareto / scenario charts that have been deleted, and missed
 * the bulk of the new sim / report / catalog UI).
 *
 * Thresholds intentionally start permissive (60% lines / 50% branches) so the
 * CI gate doesn't immediately block PRs while we backfill Phase 2 tests.
 * Bump in two-step increments toward the long-term 85% target as gaps close.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    css: false,
    // e2e/*.spec.ts uses @playwright/test which isn't a vitest dependency.
    // Keep the default include patterns for unit tests; explicitly exclude
    // the Playwright tree so vitest doesn't try to import its specs.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/__tests__/**",
        "src/main.tsx",                    // bootstrap, not unit-testable
        "src/**/*.d.ts",
      ],
      // Threshold floor = current baseline post Tier-A dead-code purge.
      // 2026-05-01 progression:
      //   Phase 0 start  → lines 37%, fn 31%, stmt 35%, br 32%
      //   Phase 2 mid    → lines 49%, fn 43%, stmt 51%, br 48%
      //   Phase 2 final  → lines 70%, fn 58%, stmt 74%, br 66%
      //   Tier A purge   → lines 73%, fn 57%, stmt 70%, br 66%
      //                    (RadarChart moved from excluded comparator/** into
      //                     general scope; aggregate stmt% ticked down 1.5pp.)
      // Threshold tracks the latest figure minus a small slack so an
      // unrelated PR doesn't get blocked by ±1pp drift.
      thresholds: {
        lines: 68,
        statements: 68,
        functions: 56,
        branches: 64,
      },
    },
  },
});
