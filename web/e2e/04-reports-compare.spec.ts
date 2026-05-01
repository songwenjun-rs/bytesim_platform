/**
 * E2E — 仿真报告：勾选 ≥ 2 份 → 对比.
 *
 * Prereq: at least two completed runs exist. If the suite is run on a fresh
 * DB the test self-skips; CI script seeds two runs before invoking Playwright.
 */
import { test, expect } from "@playwright/test";

test("multi-select two reports and navigate to compare view", async ({ page }) => {
  await page.goto("/sim/reports");
  await expect(page.getByRole("heading", { name: "仿真报告" })).toBeVisible();

  const rows = page.locator("tr.report-row");
  const rowCount = await rows.count();
  test.skip(rowCount < 2, "need ≥ 2 runs to compare");

  // Tick the first two report rows.
  await rows.nth(0).click();
  await rows.nth(1).click();

  // Floating compare bar appears with both ids listed.
  await expect(page.getByText(/已选\s*2/)).toBeVisible();

  await page.getByRole("button", { name: "对比" }).click();
  await expect(page).toHaveURL(/\/sim\/reports\/compare\?ids=/);
  await expect(page.getByRole("heading", { name: /仿真报告对比/ })).toBeVisible();
});
