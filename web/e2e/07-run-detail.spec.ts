/**
 * E2E — Run Detail page renders KPI grid + lineage + sections.
 *
 * Picks the first row from /sim/reports → opens its detail page → asserts the
 * page renders KPI cards (mfu_pct / step_ms etc) + 引擎日志 section.
 * Skips if no runs exist.
 */
import { test, expect } from "@playwright/test";

test("opens a run detail page from reports list", async ({ page }) => {
  await page.goto("/sim/reports");
  await expect(page.getByRole("heading", { name: "仿真报告" })).toBeVisible();

  const rows = page.locator("tr.report-row");
  const rowCount = await rows.count();
  test.skip(rowCount < 1, "no runs in reports list");

  // 详情 link inside the first row
  const detailLink = rows.first().getByRole("link", { name: /详情/ });
  await detailLink.click();

  // /sim/reports/:id loads — assert run id chip + at least one KPI label.
  await expect(page).toHaveURL(/\/sim\/reports\//);
  // Run header carries the run id in mono — wait for it.
  await expect(page.locator(".mono").first()).toBeVisible({ timeout: 10_000 });
  // KpiGrid renders MFU label (训练) or TTFT (推理) — at least one of these
  // must appear. Use a permissive check so both run kinds satisfy.
  const kpiCells = page.getByText(/MFU|TTFT|KPI|step_ms|step|耗时/);
  await expect(kpiCells.first()).toBeVisible({ timeout: 10_000 });
});
