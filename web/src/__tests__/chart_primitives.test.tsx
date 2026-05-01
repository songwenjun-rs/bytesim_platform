/** P-Viz-1.1: chart primitives unit tests. */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  linearScale, linearScaleFromZero, niceTicks, timeTicks, rangeOf,
  utilizationColor, mapeColor, sequentialColor, categoricalColor,
  ChartCanvas, innerBox, XAxis, YAxis, Tooltip, Legend,
  downloadCSV,
} from "../components/charts/_primitives";

describe("scale", () => {
  it("linearScale maps domain → pixel range", () => {
    const s = linearScale({ min: 0, max: 100 }, [0, 200]);
    expect(s(0)).toBe(0);
    expect(s(50)).toBe(100);
    expect(s(100)).toBe(200);
  });

  it("linearScale handles inverted ranges (e.g., y-axis flipped)", () => {
    const s = linearScale({ min: 0, max: 100 }, [200, 0]);
    expect(s(50)).toBe(100);
    expect(s(100)).toBe(0);
  });

  it("linearScale tolerates degenerate domain (min==max)", () => {
    const s = linearScale({ min: 5, max: 5 }, [0, 100]);
    // Should not throw or NaN
    expect(Number.isFinite(s(5))).toBe(true);
  });

  it("linearScaleFromZero pins origin", () => {
    const s = linearScaleFromZero(80, [0, 200]);
    expect(s(0)).toBe(0);
    expect(s(80)).toBe(200);
  });

  it("rangeOf computes min/max", () => {
    expect(rangeOf([1, 5, 3])).toEqual({ min: 1, max: 5 });
  });

  it("rangeOf empty array is safe", () => {
    expect(rangeOf([])).toEqual({ min: 0, max: 1 });
  });

  it("rangeOf with padding expands span", () => {
    const r = rangeOf([0, 10], 0.1);
    expect(r.min).toBeLessThan(0);
    expect(r.max).toBeGreaterThan(10);
  });

  it("rangeOf flat values still produces a non-zero span", () => {
    const r = rangeOf([5, 5, 5]);
    expect(r.max - r.min).toBeGreaterThan(0);
  });
});

describe("niceTicks", () => {
  it("returns ascending ticks within range", () => {
    const t = niceTicks(0, 100, 5);
    expect(t.length).toBeGreaterThan(0);
    expect(t[0]).toBeGreaterThanOrEqual(0);
    expect(t[t.length - 1]).toBeLessThanOrEqual(100 + 25);  // forgiving upper bound
  });

  it("handles min==max", () => {
    expect(niceTicks(5, 5)).toEqual([5]);
  });

  it("snaps to clean numbers (no float garbage)", () => {
    const t = niceTicks(0, 1, 5);
    for (const v of t) {
      // should stringify cleanly
      expect(v.toString()).not.toMatch(/00000\d/);
    }
  });
});

describe("timeTicks", () => {
  it("returns ms timestamps over the requested window", () => {
    const start = Date.UTC(2026, 0, 1);
    const end = start + 24 * 3600_000;  // +24h
    const t = timeTicks(start, end, 5);
    expect(t.length).toBeGreaterThan(0);
    expect(t[0]).toBeGreaterThanOrEqual(start);
  });

  it("handles min==max", () => {
    expect(timeTicks(1000, 1000)).toEqual([1000]);
  });
});

describe("colors", () => {
  it("utilizationColor maps thresholds", () => {
    expect(utilizationColor(85)).toBe("var(--red)");
    expect(utilizationColor(70)).toBe("var(--orange)");
    expect(utilizationColor(50)).toBe("var(--teal)");
    expect(utilizationColor(20)).toBe("var(--green)");
  });

  it("mapeColor: green ≤ 5, orange ≤ 10, red >", () => {
    expect(mapeColor(3)).toBe("var(--green)");
    expect(mapeColor(7)).toBe("var(--orange)");
    expect(mapeColor(15)).toBe("var(--red)");
  });

  it("sequentialColor clamps and produces valid rgba", () => {
    expect(sequentialColor(-1)).toMatch(/rgba/);
    expect(sequentialColor(0.5)).toMatch(/rgba/);
    expect(sequentialColor(2)).toMatch(/rgba/);
  });

  it("categoricalColor cycles past 8", () => {
    expect(categoricalColor(0)).toBe(categoricalColor(8));
    expect(categoricalColor(3)).toBe(categoricalColor(11));
  });
});

describe("ChartCanvas + innerBox", () => {
  it("renders an SVG with viewBox", () => {
    const { container } = render(
      <ChartCanvas width={400} height={200}>
        <rect x={0} y={0} width={1} height={1} />
      </ChartCanvas>,
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 400 200");
  });

  it("innerBox computes inset rect", () => {
    const b = innerBox(400, 200, { l: 50, r: 16, t: 16, b: 36 });
    expect(b.x0).toBe(50);
    expect(b.x1).toBe(384);
    expect(b.width).toBe(334);
    expect(b.height).toBe(148);
  });
});

describe("XAxis / YAxis", () => {
  it("renders tick labels via format function", () => {
    const s = linearScale({ min: 0, max: 100 }, [50, 350]);
    render(
      <ChartCanvas width={400} height={200}>
        <XAxis scale={s} ticks={[0, 50, 100]} y={170} pixelStart={50} pixelEnd={350}
               format={(v) => `${v}%`} />
      </ChartCanvas>,
    );
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("YAxis renders grid lines when gridWidth set", () => {
    const s = linearScale({ min: 0, max: 100 }, [180, 20]);
    const { container } = render(
      <ChartCanvas width={400} height={200}>
        <YAxis scale={s} ticks={[0, 50, 100]} x={50} pixelStart={20} pixelEnd={180}
               gridWidth={300} />
      </ChartCanvas>,
    );
    // Each tick should produce a line; total ≥ ticks count
    expect(container.querySelectorAll("line").length).toBeGreaterThanOrEqual(3);
  });

  it("XAxis renders an x-axis label when supplied", () => {
    const s = linearScale({ min: 0, max: 1 }, [0, 100]);
    render(
      <ChartCanvas width={200} height={120}>
        <XAxis scale={s} ticks={[0, 1]} y={84} pixelStart={0} pixelEnd={100}
               label="时间 (h)" />
      </ChartCanvas>,
    );
    expect(screen.getByText("时间 (h)")).toBeInTheDocument();
  });
});

describe("Tooltip", () => {
  it("renders content via foreignObject", () => {
    render(
      <ChartCanvas width={400} height={200}>
        <Tooltip x={100} y={50} canvasWidth={400} canvasHeight={200}>
          <div>hello</div>
        </Tooltip>
      </ChartCanvas>,
    );
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("flips horizontally near right edge", () => {
    const { container } = render(
      <ChartCanvas width={400} height={200}>
        <Tooltip x={380} y={50} canvasWidth={400} canvasHeight={200}>
          <div>edge</div>
        </Tooltip>
      </ChartCanvas>,
    );
    const fo = container.querySelector("foreignObject");
    const xAttr = Number(fo?.getAttribute("x") ?? 0);
    expect(xAttr).toBeLessThan(380);   // flipped left
  });
});

describe("Legend", () => {
  it("renders items with colored swatches", () => {
    render(<Legend items={[{ key: "a", label: "A", color: "red" }]} hidden={new Set()} />);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("toggles visibility when clicked", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <Legend
        items={[{ key: "a", label: "A", color: "red" }]}
        hidden={new Set()}
        onToggle={onToggle}
      />,
    );
    await user.click(screen.getByText("A"));
    expect(onToggle).toHaveBeenCalledWith("a");
  });

  it("dims hidden items", () => {
    const { container } = render(
      <Legend
        items={[{ key: "a", label: "A", color: "red" }]}
        hidden={new Set(["a"])}
      />,
    );
    const span = container.querySelector("span");
    expect(span?.getAttribute("style") ?? "").toContain("opacity: 0.4");
  });

  it("shows meta when supplied", () => {
    render(<Legend items={[{ key: "a", label: "A", color: "red", meta: "5 点" }]} hidden={new Set()} />);
    expect(screen.getByText("(5 点)")).toBeInTheDocument();
  });
});

describe("downloadCSV", () => {
  it("creates a download link with rows", () => {
    // Stub URL.createObjectURL + revokeObjectURL since happy-dom may not have them
    const createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadCSV("test.csv", [
      { a: 1, b: "two" },
      { a: 3, b: "four,with,comma" },
    ]);

    expect(createSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeSpy).toHaveBeenCalled();
  });

  it("no-op for empty rows", () => {
    const createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    downloadCSV("empty.csv", []);
    expect(createSpy).not.toHaveBeenCalled();
  });
});
