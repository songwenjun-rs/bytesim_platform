/**
 * Shared accessor for the 硬件部件 (Catalog) part library.
 *
 * Catalog page persists its parts in localStorage; other pages (集群配置 →
 * 服务器编辑器、训练/推理仿真 GPU pickers …) read here so dropdowns stay in
 * sync with whatever the architect has registered. SSR-safe: returns SEED
 * fallback if window/localStorage is unavailable.
 */

export type Kind = "gpu" | "cpu" | "nic" | "ssd";

export type HwPart = { id: string } & Record<string, string | number>;

export const KIND_LABEL: Record<Kind, string> = {
  gpu: "GPU", cpu: "CPU", nic: "网卡", ssd: "SSD",
};

const STORE_KEY = "bytesim:hw-parts:v1";

/** Empty fallback so dropdowns degrade gracefully if Catalog is wiped. */
const EMPTY: Record<Kind, HwPart[]> = { gpu: [], cpu: [], nic: [], ssd: [] };

/** Latest-gen seed — kept here (not on the page) so non-Catalog consumers
 *  still get a reasonable default before the user opens 硬件部件. */
export const SEED: Record<Kind, HwPart[]> = {
  gpu: [
    { id: "gpu-nv-gb300",  model: "GB300 NVL72",    vendor: "NVIDIA", fp8_tflops: 18000, bf16_tflops: 9000, hbm_gb: 288, mem_bw_tbs: 8.0, tdp_w: 1400, year: 2025 },
    { id: "gpu-nv-b200",   model: "B200 SXM",       vendor: "NVIDIA", fp8_tflops: 9000,  bf16_tflops: 4500, hbm_gb: 192, mem_bw_tbs: 8.0, tdp_w: 1000, year: 2024 },
    { id: "gpu-hw-910c",   model: "Ascend 910C",    vendor: "Huawei", fp8_tflops: 0,     bf16_tflops: 800,  hbm_gb: 128, mem_bw_tbs: 3.2, tdp_w: 550,  year: 2024 },
    { id: "gpu-hw-910b",   model: "Ascend 910B3",   vendor: "Huawei", fp8_tflops: 0,     bf16_tflops: 376,  hbm_gb: 64,  mem_bw_tbs: 1.6, tdp_w: 400,  year: 2024 },
  ],
  cpu: [
    { id: "cpu-intel-6980p",model: "Xeon 6980P (Granite Rapids)", vendor: "Intel", cores: 128, base_ghz: 2.0, boost_ghz: 3.9, tdp_w: 500, mem_channels: 12 },
    { id: "cpu-intel-6960p",model: "Xeon 6960P (Granite Rapids)", vendor: "Intel", cores: 72,  base_ghz: 2.7, boost_ghz: 3.8, tdp_w: 500, mem_channels: 12 },
    { id: "cpu-amd-9755",   model: "EPYC 9755 (Turin)",           vendor: "AMD",   cores: 128, base_ghz: 2.7, boost_ghz: 4.1, tdp_w: 500, mem_channels: 12 },
    { id: "cpu-amd-9965",   model: "EPYC 9965 (Turin Dense)",     vendor: "AMD",   cores: 192, base_ghz: 2.25,boost_ghz: 3.7, tdp_w: 500, mem_channels: 12 },
  ],
  nic: [
    { id: "nic-nv-cx8",    model: "ConnectX-8",            vendor: "NVIDIA",   bw_gbps: 800, ports: 1, protocol: "IB XDR / 800GbE", tdp_w: 30 },
    { id: "nic-nv-bf3",    model: "BlueField-3 DPU",       vendor: "NVIDIA",   bw_gbps: 400, ports: 2, protocol: "400GbE / IB NDR", tdp_w: 75 },
    { id: "nic-bcm-thor2", model: "Thor 2 (BCM57608)",     vendor: "Broadcom", bw_gbps: 400, ports: 1, protocol: "400GbE RoCEv2",   tdp_w: 30 },
    { id: "nic-bcm-ps1750",model: "PS1750 800G PCIe Gen5", vendor: "Broadcom", bw_gbps: 800, ports: 1, protocol: "800GbE RoCEv2",   tdp_w: 38 },
  ],
  ssd: [
    { id: "ssd-sam-pm9d3a-30", model: "PM9D3a 30.72TB",   vendor: "Samsung", capacity_tb: 30.72,  interface: "NVMe Gen5 x4", read_gbs: 14.8, write_gbs: 11.0 },
    { id: "ssd-sam-pm9d3a-15", model: "PM9D3a 15.36TB",   vendor: "Samsung", capacity_tb: 15.36,  interface: "NVMe Gen5 x4", read_gbs: 14.8, write_gbs: 11.0 },
    { id: "ssd-sam-bm1743",    model: "BM1743 QLC 122TB", vendor: "Samsung", capacity_tb: 122.88, interface: "NVMe Gen5 x4", read_gbs: 7.5,  write_gbs: 3.0 },
    { id: "ssd-sam-pm1743",    model: "PM1743 15.36TB",   vendor: "Samsung", capacity_tb: 15.36,  interface: "NVMe Gen5 x4", read_gbs: 13.0, write_gbs: 6.6 },
  ],
};

/** Read entire Catalog store. Used by Catalog page + any consumer that needs
 *  multiple kinds at once. */
export function loadHwStore(): Record<Kind, HwPart[]> {
  if (typeof window === "undefined") return SEED;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<Kind, HwPart[]>;
      // Merge with EMPTY so a partial cache (e.g. from older versions) still
      // exposes every kind as an array.
      return { ...EMPTY, ...parsed };
    }
  } catch { /* ignore */ }
  return SEED;
}

/** Convenience: read parts of one kind. */
export function loadHwParts(kind: Kind): HwPart[] {
  return loadHwStore()[kind] ?? [];
}

export function saveHwStore(s: Record<Kind, HwPart[]>): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/** Build a "Vendor · Model" display label for dropdown options. */
export function partLabel(p: HwPart): string {
  const v = String(p.vendor ?? "");
  const m = String(p.model ?? p.id);
  return v ? `${v} · ${m}` : m;
}
