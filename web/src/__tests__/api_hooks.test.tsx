/**
 * Targeted hook coverage for api/{tco,runs,specs,catalogItems}.ts —
 * the modules dropped below 70% in the previous coverage pass because
 * mutation hooks (useCancelRun / useDeleteRun / useFork / useDelete*)
 * had zero callers in tests. Each test renders the hook via
 * @testing-library/react renderHook + a fresh QueryClient, fires
 * the mutation, asserts the recorded fetch call shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";

import { useCancelRun, useDeleteRun } from "../api/runs";
import { useTcoRules, useRunTco, useCompareDesigns } from "../api/tco";
import { useFork, useSpecVersions, useSpecDiff } from "../api/specs";
import { useDeleteCatalogItem, useUpsertCatalogItem } from "../api/catalogItems";
import { setSession } from "../api/client";

const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  setSession("t", "p_default");
  vi.mocked(fetch).mockReset();
});

// ── api/runs ─────────────────────────────────────────────────────────

describe("useCancelRun", () => {
  it("POSTs /v1/runs/{id}/cancel and invalidates run-full cache", async () => {
    const calls: any[] = [];
    vi.mocked(fetch).mockImplementation(async (input: any, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return ok({ was_running: true });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCancelRun("sim-1"), { wrapper: wrap(qc) });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toMatchObject({ url: "/v1/runs/sim-1/cancel", method: "POST" });
  });

  it("throws on non-2xx response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("nope", { status: 500 }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCancelRun("sim-x"), { wrapper: wrap(qc) });
    result.current.mutate();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toContain("500");
  });
});

describe("useDeleteRun", () => {
  it("DELETE /v1/runs/{id} succeeds on 200", async () => {
    const calls: any[] = [];
    vi.mocked(fetch).mockImplementation(async (input: any, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(null, { status: 204 });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDeleteRun(), { wrapper: wrap(qc) });
    result.current.mutate("sim-x");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toMatchObject({ url: "/v1/runs/sim-x", method: "DELETE" });
  });

  it("treats 404 as success (idempotent)", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 404 }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDeleteRun(), { wrapper: wrap(qc) });
    result.current.mutate("sim-missing");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("throws on 500", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("boom", { status: 500 }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDeleteRun(), { wrapper: wrap(qc) });
    result.current.mutate("sim-x");
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ── api/tco ──────────────────────────────────────────────────────────

describe("useTcoRules", () => {
  it("appends ?resource_kind= when kind is given", async () => {
    const calls: any[] = [];
    vi.mocked(fetch).mockImplementation(async (input: any) => {
      calls.push(String(input));
      return ok([{ id: "gpu/B200/v1", resource_kind: "gpu" }]);
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTcoRules("gpu"), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toBe("/v1/tco/rules?resource_kind=gpu");
  });

  it("omits the query param when kind is undefined", async () => {
    const calls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input: any) => {
      calls.push(String(input));
      return ok([]);
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTcoRules(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toBe("/v1/tco/rules");
  });
});

describe("useRunTco", () => {
  it("hits /v1/runs/{id}/tco", async () => {
    const calls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input: any) => {
      calls.push(String(input));
      return ok({ total_usd: 100, hw_capex_amortized_usd: 50, power_opex_usd: 30,
                   cooling_opex_usd: 5, network_opex_usd: 5, storage_opex_usd: 5,
                   failure_penalty_usd: 5, per_m_token_usd: 0.001,
                   per_gpu_hour_usd: 5, per_inference_request_usd: null,
                   rule_versions: {}, sensitivities: {} });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useRunTco("sim-1"), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toBe("/v1/runs/sim-1/tco");
  });
});

describe("useCompareDesigns", () => {
  it("POSTs the body and returns the comparison result", async () => {
    let posted: any = null;
    vi.mocked(fetch).mockImplementation(async (input: any, init?: RequestInit) => {
      if (init?.method === "POST" && String(input) === "/v1/tco/compare") {
        posted = JSON.parse(init.body as string);
      }
      return ok({ a: {}, b: {}, delta_b_minus_a: { total_usd: 12 } });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCompareDesigns(), { wrapper: wrap(qc) });
    result.current.mutate({ a: { gpu: "B200" }, b: { gpu: "H200" } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(posted).toMatchObject({ a: { gpu: "B200" }, b: { gpu: "H200" } });
    expect(result.current.data?.delta_b_minus_a.total_usd).toBe(12);
  });

  it("propagates 4xx as error", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("bad", { status: 400 }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCompareDesigns(), { wrapper: wrap(qc) });
    result.current.mutate({ a: {}, b: {} });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ── api/specs ────────────────────────────────────────────────────────

describe("useSpecVersions + useSpecDiff", () => {
  it("hits /v1/specs/{kind}/{id}/versions", async () => {
    const calls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input: any) => {
      calls.push(String(input));
      return ok([{ hash: "h1", version_tag: "v1" }]);
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSpecVersions("hwspec", "x"), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toBe("/v1/specs/hwspec/x/versions");
  });

  it("useSpecDiff stays disabled when from === to", async () => {
    vi.mocked(fetch).mockImplementation(async () => ok({}));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useSpecDiff("hwspec", "x", "h1", "h1"),
      { wrapper: wrap(qc) },
    );
    // enabled=false → never fetches
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("useSpecDiff fires when from !== to", async () => {
    vi.mocked(fetch).mockImplementation(async () => ok({
      from: { hash: "a" }, to: { hash: "b" }, entries: [],
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useSpecDiff("hwspec", "x", "a", "b"),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});

describe("useFork", () => {
  it("POSTs /v1/specs/{kind}/{id}/fork with body", async () => {
    let posted: any = null;
    vi.mocked(fetch).mockImplementation(async (input: any, init?: RequestInit) => {
      if (init?.method === "POST") posted = JSON.parse(init.body as string);
      return ok({ spec: { id: "x_fork_1", kind: "hwspec", name: "fork" },
                  version: { hash: "fh", version_tag: "v1" } });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useFork("hwspec", "x"), { wrapper: wrap(qc) });
    result.current.mutate({ new_name: "fork", from_hash: "h1" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(posted).toMatchObject({ new_name: "fork", from_hash: "h1" });
  });

  it("throws on 4xx", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("bad", { status: 400 }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useFork("hwspec", "x"), { wrapper: wrap(qc) });
    result.current.mutate({ new_name: "" });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ── api/catalogItems ─────────────────────────────────────────────────

describe("useDeleteCatalogItem + useUpsertCatalogItem", () => {
  it("DELETE /v1/catalog/items/{kind}/{id}", async () => {
    const calls: any[] = [];
    vi.mocked(fetch).mockImplementation(async (input: any, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(null, { status: 204 });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDeleteCatalogItem("cpu"), { wrapper: wrap(qc) });
    result.current.mutate("cpu-1");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toMatchObject({ url: "/v1/catalog/items/cpu/cpu-1", method: "DELETE" });
  });

  it("treats 404 as success (idempotent)", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 404 }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDeleteCatalogItem("cpu"), { wrapper: wrap(qc) });
    result.current.mutate("cpu-missing");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("DELETE throws on 500", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("boom", { status: 500 }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDeleteCatalogItem("cpu"), { wrapper: wrap(qc) });
    result.current.mutate("cpu-1");
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("upsert with id PUTs to /v1/catalog/items/{kind}/{id}", async () => {
    let captured: { url: string; method: string; body: any } | null = null;
    vi.mocked(fetch).mockImplementation(async (input: any, init?: RequestInit) => {
      captured = {
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body as string) : null,
      };
      return ok({ kind: "cpu", id: "cpu-1", name: "x", body: {} });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useUpsertCatalogItem("cpu"), { wrapper: wrap(qc) });
    result.current.mutate({ id: "cpu-1", name: "x", body: { cores: 64 } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(captured).toMatchObject({
      url: "/v1/catalog/items/cpu/cpu-1",
      method: "PUT",
      body: { id: "cpu-1", name: "x" },
    });
  });

  it("upsert without id POSTs to /v1/catalog/items/{kind}", async () => {
    let captured: { url: string; method: string } | null = null;
    vi.mocked(fetch).mockImplementation(async (input: any, init?: RequestInit) => {
      captured = { url: String(input), method: init?.method ?? "GET" };
      return ok({ kind: "cpu", id: "auto-1", name: "x", body: {} });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useUpsertCatalogItem("cpu"), { wrapper: wrap(qc) });
    result.current.mutate({ name: "x", body: {} });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(captured).toMatchObject({
      url: "/v1/catalog/items/cpu",
      method: "POST",
    });
  });

  it("upsert throws on 4xx", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("bad", { status: 422 }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useUpsertCatalogItem("cpu"), { wrapper: wrap(qc) });
    result.current.mutate({ name: "x", body: {} });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
