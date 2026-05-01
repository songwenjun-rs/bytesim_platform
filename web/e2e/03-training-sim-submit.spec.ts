/**
 * E2E — 训练仿真：选模板 → 提交 → 看到进度条.
 *
 * Skips if 集群配置 has no cluster yet (DB just wiped). Otherwise selects the
 * first preset, hits 启动训练仿真, and waits for ProgressStrip to appear.
 */
import { test, expect } from "@playwright/test";

test("submit a training sim and see the progress strip", async ({ page }) => {
  await page.goto("/sim/training");
  await expect(page.getByRole("heading", { name: "训练仿真" })).toBeVisible();

  // The submit button starts disabled until specs + cluster load.
  const submit = page.getByRole("button", { name: /启动训练仿真/ });
  await expect(submit).toBeVisible();

  // Pick the first preset if any exist (presets live in bs_catalog now).
  const presetSelect = page.getByTestId("preset-select");
  const optionCount = await presetSelect.locator("option").count();
  // option[0] is the "— 不使用模板 —" placeholder; need ≥ 2 to have a real one.
  test.skip(optionCount < 2, "no presets seeded");
  await presetSelect.selectOption({ index: 1 });

  // Wait until submit becomes enabled (specs + cluster summary resolved).
  await expect(submit).toBeEnabled({ timeout: 10_000 });
  await submit.click();

  // ProgressStrip should appear with the run id + a link to /runs/<id>.
  await expect(page.getByTestId("sim-progress-strip")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("sim-progress-link")).toBeVisible();
});
