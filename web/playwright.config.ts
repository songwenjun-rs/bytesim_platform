import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config — drives end-to-end tests of the running platform.
 *
 * Two modes:
 *   - Local dev:  set BASE_URL to your vite dev server (default).
 *   - CI:         scripts/e2e_ci.sh brings up the full docker compose stack
 *                 and exposes the web port on http://localhost:5173.
 *
 * Tests live in `web/e2e/`. Each one targets a critical user path that
 * the unit suite can't reasonably cover (full-stack DB → svc → BFF → SPA).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // tests share platform DB state; serial keeps it sane
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["github"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : "list",
  timeout: 60_000,

  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
