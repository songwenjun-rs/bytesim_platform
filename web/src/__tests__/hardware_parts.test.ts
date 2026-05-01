/**
 * lib/hardwareParts — pure module, no React. Covers SEED fallback,
 * load/save round-trip, partLabel formatter.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadHwStore, loadHwParts, saveHwStore, partLabel, SEED, KIND_LABEL,
  type HwPart,
} from "../lib/hardwareParts";

beforeEach(() => {
  localStorage.clear();
});

describe("loadHwStore", () => {
  it("returns SEED when localStorage is empty", () => {
    const store = loadHwStore();
    expect(store.cpu.length).toBeGreaterThan(0);
    expect(store).toEqual(SEED);
  });

  it("returns parsed value from localStorage when present", () => {
    const custom = { cpu: [{ id: "x", model: "X", vendor: "Y" }] as HwPart[],
                     gpu: [], nic: [], ssd: [] };
    localStorage.setItem("bytesim:hw-parts:v1", JSON.stringify(custom));
    expect(loadHwStore()).toEqual(custom);
  });

  it("falls back to SEED on malformed JSON", () => {
    localStorage.setItem("bytesim:hw-parts:v1", "{not json");
    expect(loadHwStore()).toEqual(SEED);
  });

  it("merges with EMPTY shape so partial caches don't leave undefined kinds", () => {
    localStorage.setItem("bytesim:hw-parts:v1", JSON.stringify({ cpu: [{ id: "z" }] }));
    const out = loadHwStore();
    expect(out.cpu).toHaveLength(1);
    expect(out.gpu).toEqual([]);
    expect(out.nic).toEqual([]);
    expect(out.ssd).toEqual([]);
  });
});

describe("loadHwParts", () => {
  it("returns the kind-specific slice", () => {
    expect(loadHwParts("cpu")).toEqual(SEED.cpu);
    expect(loadHwParts("gpu").length).toBeGreaterThan(0);
  });
});

describe("saveHwStore", () => {
  it("round-trips a store", () => {
    const x = { cpu: [{ id: "a", model: "A", vendor: "V" } as HwPart],
                gpu: [], nic: [], ssd: [] };
    saveHwStore(x);
    expect(loadHwStore()).toEqual(x);
  });
});

describe("partLabel", () => {
  it("formats vendor + model", () => {
    expect(partLabel({ id: "x", vendor: "AMD", model: "EPYC" })).toBe("AMD · EPYC");
  });
  it("falls back to model only when vendor missing", () => {
    expect(partLabel({ id: "x", model: "Naked" })).toBe("Naked");
  });
  it("falls back to id when model missing", () => {
    expect(partLabel({ id: "raw-id" })).toBe("raw-id");
  });
});

describe("KIND_LABEL", () => {
  it("has Chinese labels for every kind", () => {
    expect(KIND_LABEL.cpu).toBe("CPU");
    expect(KIND_LABEL.gpu).toBe("GPU");
    expect(KIND_LABEL.nic).toBe("网卡");
    expect(KIND_LABEL.ssd).toBe("SSD");
  });
});
