/**
 * E2E — Dashboard loads.
 *
 * Verifies the bootstrap auth path works (main.tsx fetches a token before
 * rendering) and the redesigned Dashboard surfaces its 4 stat chips +
 * quick-action grid + cluster overview.
 */
import { test, expect } from "@playwright/test";

test("dashboard renders stat chips + quick actions + cluster overview", async ({ page }) => {
  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { name: "工作台" })).toBeVisible();

  // 4 stat chips — labels are stable across data states. Scope to the chip
  // container (.lab) so we don't collide with status tags that show the same
  // text ("完成"/"失败") in the recent-runs table when the e2e step 4 already
  // submitted a Run before this spec runs.
  await expect(page.locator(".stat-chip .lab", { hasText: "仿真总数" })).toBeVisible();
  await expect(page.locator(".stat-chip .lab", { hasText: /^完成$/ })).toBeVisible();
  await expect(page.locator(".stat-chip .lab", { hasText: "进行中" })).toBeVisible();
  await expect(page.locator(".stat-chip .lab", { hasText: /^失败$/ })).toBeVisible();

  // 4 quick-action cards (集群配置 first, then 训练仿真 / 推理仿真 / 仿真报告)
  await expect(page.getByRole("link", { name: /^集群配置/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /^训练仿真/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /^推理仿真/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /^仿真报告/ })).toBeVisible();

  // Cluster overview card title
  await expect(page.getByText("集群概览")).toBeVisible();
});
