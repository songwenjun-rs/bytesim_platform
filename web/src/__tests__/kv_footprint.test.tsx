/**
 * L1.2 — KvFootprintBar working-set vs HBM visualization.
 *
 * Locks:
 *   - 0 gpu_count → renders nothing.
 *   - 50% utilization (well within HBM) → status=ok, teal color.
 *   - 85% utilization → status=warn (80–100% squeeze band).
 *   - 120% utilization → status=fail (over HBM); display capped at 150%.
 *   - Header reads "<used> / <total> GB (<pct>%)".
 *   - Hint line shows the multiplication breakdown.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { KvFootprintBar } from "../components/sim/KvFootprintBar";

describe("<KvFootprintBar>", () => {
  it("renders nothing when gpu_count = 0 (mid-edit)", () => {
    const { container } = render(
      <KvFootprintBar gpu_model="H200" gpu_count={0}
        avg_active_seqs={256} kv_size_gb_per_seq={0.020} />,
    );
    expect(container.textContent).toBe("");
  });

  it("status=ok at ~50% util (well within HBM)", () => {
    // H200 = 141 GB/GPU * 32 = 4512 GB total
    // 256 active * 8 GB = 2048 GB → ~45% (under 80% threshold)
    render(<KvFootprintBar
      gpu_model="H200" gpu_count={32}
      avg_active_seqs={256} kv_size_gb_per_seq={8.0}
    />);
    const card = screen.getByTestId("kv-footprint-bar");
    expect(card.dataset.status).toBe("ok");
  });

  it("status=warn at ~85% util (squeeze band)", () => {
    // 32 × H200 = 4512 GB. 85% ≈ 3835 GB.
    // 256 × 15 = 3840 GB
    render(<KvFootprintBar
      gpu_model="H200" gpu_count={32}
      avg_active_seqs={256} kv_size_gb_per_seq={15.0}
    />);
    expect(screen.getByTestId("kv-footprint-bar").dataset.status).toBe("warn");
  });

  it("status=fail when working set exceeds HBM", () => {
    // 256 × 25 GB = 6400 GB > 4512 GB → 142%
    render(<KvFootprintBar
      gpu_model="H200" gpu_count={32}
      avg_active_seqs={256} kv_size_gb_per_seq={25.0}
    />);
    expect(screen.getByTestId("kv-footprint-bar").dataset.status).toBe("fail");
  });

  it("used bar pct attribute matches the actual util ratio", () => {
    // 32 × 141 = 4512 GB total. 256 × 4.41 ≈ 1129 GB → 25%
    render(<KvFootprintBar
      gpu_model="H200" gpu_count={32}
      avg_active_seqs={256} kv_size_gb_per_seq={4.41}
    />);
    const used = screen.getByTestId("kv-footprint-used");
    expect(Number(used.dataset.pct)).toBeCloseTo(25.0, 0);
  });

  it("header shows used/total GB + percentage", () => {
    render(<KvFootprintBar
      gpu_model="B200" gpu_count={16}
      avg_active_seqs={128} kv_size_gb_per_seq={2.0}
    />);
    // B200 = 192/GPU * 16 = 3072 total. used = 256.
    const card = screen.getByTestId("kv-footprint-bar");
    expect(card.textContent).toContain("256");
    expect(card.textContent).toContain("3072");
    expect(card.textContent).toContain("8%");  // 256/3072 = 8.3%
  });

  it("redline marker at 100% always rendered", () => {
    render(<KvFootprintBar
      gpu_model="H200" gpu_count={32}
      avg_active_seqs={256} kv_size_gb_per_seq={0.020}
    />);
    expect(screen.getByTestId("kv-footprint-redline")).toBeInTheDocument();
  });

  it("hint shows the multiplication breakdown", () => {
    render(<KvFootprintBar
      gpu_model="B200" gpu_count={8}
      avg_active_seqs={64} kv_size_gb_per_seq={2.0}
    />);
    const hint = screen.getByTestId("kv-footprint-hint");
    expect(hint.textContent).toContain("64 活跃 seq");
    expect(hint.textContent).toContain("128.0 GB");  // 64*2
    expect(hint.textContent).toContain("8× B200");
    expect(hint.textContent).toContain("192 GB / GPU");  // B200 hbm
  });
});
