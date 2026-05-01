import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

beforeEach(() => {
  // Reset localStorage between tests so token state is isolated.
  window.localStorage.clear();
  // Default fetch — every test that needs a response can override.
  vi.spyOn(window, "fetch");
  // Stop jsdom from actually navigating. We can't reassign location.assign
  // (it's read-only on jsdom), but vi.stubGlobal lets us swap the whole
  // location with a mock object that records calls.
  const calls: { assign: string[]; reload: number } = { assign: [], reload: 0 };
  Object.defineProperty(window, "__navCalls", { value: calls, configurable: true, writable: true });
  vi.stubGlobal("location", {
    href: "http://localhost/",
    pathname: "/",
    protocol: "http:",
    host: "localhost",
    assign: (url: string) => { calls.assign.push(url); },
    reload: () => { calls.reload += 1; },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
