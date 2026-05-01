import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setSession } from "../api/client";
import * as engines from "../api/engines";

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: any) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const ok = (json: any) => new Response(JSON.stringify(json), { status: 200 });

describe("engines hooks", () => {
  it("useEngines no filters", async () => {
    setSession("t", "p_default");
    vi.mocked(fetch).mockResolvedValueOnce(ok([
      { name: "surrogate-analytical", version: "v0.1.0", domain: "compute" },
    ]));
    const { result } = renderHook(() => engines.useEngines(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0].name).toBe("surrogate-analytical");
    expect(vi.mocked(fetch).mock.calls[0][0] as string).toBe("/v1/engines");
  });

  it("useEngines with status filter (RFC-001 v2 — domain filter dropped)", async () => {
    setSession("t", "p_default");
    vi.mocked(fetch).mockResolvedValueOnce(ok([]));
    renderHook(() => engines.useEngines({ status: "active" }), { wrapper: wrapper() });
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(vi.mocked(fetch).mock.calls[0][0] as string).toContain("status=active");
  });

  it("useEngine fetches single", async () => {
    setSession("t", "p_default");
    vi.mocked(fetch).mockResolvedValueOnce(ok({ name: "x", version: "v1" }));
    const { result } = renderHook(() => engines.useEngine("x"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("useEngine skipped when name is empty", () => {
    setSession("t", "p_default");
    const { result } = renderHook(() => engines.useEngine(""), { wrapper: wrapper() });
    expect(result.current.isFetching).toBe(false);
  });
});
