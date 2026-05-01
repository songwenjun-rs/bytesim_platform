/**
 * E2E — 推理仿真：选模板 → 提交 → 看到进度条.
 *
 * Mirrors 03 but pinned to the inference page + KV cache + SLO inputs are
 * present. Skips when no inference preset is seeded.
 */
import { test, expect } from "@playwright/test";

test("submit an inference sim and see the progress strip", async ({ page }) => {
  await page.goto("/sim/inference");
  await expect(page.getByRole("heading", { name: "推理仿真" })).toBeVisible();

  // KV cache + SLO sections should render — distinguishes the inference page
  // from the training page (which has neither).
  await expect(page.getByText("KV Cache")).toBeVisible();
  await expect(page.getByText("SLO 目标")).toBeVisible();

  const submit = page.getByRole("button", { name: /启动推理仿真/ });
  await expect(submit).toBeVisible();

  const presetSelect = page.getByTestId("preset-select");
  const optionCount = await presetSelect.locator("option").count();
  test.skip(optionCount < 2, "no inference presets seeded");
  await presetSelect.selectOption({ index: 1 });

  await expect(submit).toBeEnabled({ timeout: 10_000 });
  await submit.click();

  await expect(page.getByTestId("sim-progress-strip")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("sim-progress-link")).toBeVisible();
});
