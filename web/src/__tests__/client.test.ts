import { describe, it, expect, vi } from "vitest";
import {
  authFetch,
  clearSession,
  getJSON,
  getProject,
  getToken,
  postJSON,
  setProject,
  setSession,
  wsURL,
} from "../api/client";

describe("session storage", () => {
  it("setSession persists token + project to localStorage", () => {
    setSession("tok-1", "p_default");
    expect(getToken()).toBe("tok-1");
    expect(getProject()).toBe("p_default");
  });

  it("setProject updates only the project", () => {
    setSession("tok-1", "p_default");
    setProject("p_lab");
    expect(getProject()).toBe("p_lab");
    expect(getToken()).toBe("tok-1");
  });

  it("clearSession wipes both keys", () => {
    setSession("tok-1", "p_default");
    clearSession();
    expect(getToken()).toBeNull();
    expect(getProject()).toBeNull();
  });
});

describe("getJSON", () => {
  it("attaches Authorization and X-Project-ID headers", async () => {
    setSession("tok-A", "p_lab");
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    await getJSON("/v1/auth/me");
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: "Bearer tok-A",
      "X-Project-ID": "p_lab",
    });
  });

  it("on 401 clears session but does not redirect (login screen removed)", async () => {
    setSession("tok-A", "p_lab");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("", { status: 401, statusText: "Unauthorized" })
    );
    await expect(getJSON("/v1/auth/me")).rejects.toThrow(/401/);
    expect(getToken()).toBeNull();
    // No /login route anymore — main.tsx's bootstrapAuth refetches a token
    // on next page load instead.
    expect((window as any).__navCalls.assign ?? []).not.toContain("/login");
  });

  it("on non-401 errors throws but does NOT clear session", async () => {
    setSession("tok-A", "p_lab");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("", { status: 502, statusText: "Bad Gateway" })
    );
    await expect(getJSON("/v1/dashboard")).rejects.toThrow(/502/);
    expect(getToken()).toBe("tok-A");
  });
});

describe("postJSON", () => {
  it("sends JSON body and Authorization header", async () => {
    setSession("tok-B", "p_default");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "x" }), { status: 200 })
    );
    const out = await postJSON<{ id: string }>("/v1/runs", { hwspec_hash: "h" });
    expect(out.id).toBe("x");
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-B");
    expect(init.body).toBe(JSON.stringify({ hwspec_hash: "h" }));
  });
});

describe("authFetch", () => {
  it("merges custom headers and auth headers", async () => {
    setSession("tok-C", "p_lab");
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await authFetch("/v1/foo", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Custom": "1" },
      body: "{}",
    });
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Custom"]).toBe("1");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe("Bearer tok-C");
    expect(headers["X-Project-ID"]).toBe("p_lab");
  });

  it("passes through 401 to handle401", async () => {
    setSession("tok-D", "p_lab");
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 401 }));
    await authFetch("/v1/foo");
    expect(getToken()).toBeNull();
  });
});

describe("wsURL", () => {
  it("appends ?token= when a token is stored", () => {
    setSession("tok-W", "p_default");
    const url = wsURL("/v1/streams/runs/sim-7f2a");
    expect(url.startsWith("ws://localhost/v1/streams/runs/sim-7f2a")).toBe(true);
    expect(url).toContain("token=tok-W");
  });

  it("uses & when path already has a query", () => {
    setSession("tok-W", "p_default");
    const url = wsURL("/v1/streams/runs/sim?foo=bar");
    expect(url).toContain("?foo=bar");
    expect(url).toContain("&token=tok-W");
  });

  it("returns bare URL when no token", () => {
    const url = wsURL("/v1/streams/x");
    expect(url).toBe("ws://localhost/v1/streams/x");
  });
});
