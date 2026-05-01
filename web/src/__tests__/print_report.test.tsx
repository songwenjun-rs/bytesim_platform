/**
 * PDF export — print button + report header.
 *
 * Locks:
 *   - Click on 导出 PDF triggers window.print().
 *   - Button has the no-print class so @media print hides it.
 *   - PrintReportHeader carries runId + title + has print-only class.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";

import {
  PrintReportButton, PrintReportHeader,
} from "../components/run/PrintReportButton";

beforeEach(() => {
  vi.useFakeTimers();
});

describe("<PrintReportButton>", () => {
  it("clicking the button calls window.print() (after timeout settles)", async () => {
    const printSpy = vi.fn();
    vi.stubGlobal("print", printSpy);

    render(<PrintReportButton runId="run-42" />);
    const btn = screen.getByTestId("print-report-btn");
    expect(btn).toBeInTheDocument();
    await act(async () => {
      btn.click();
      vi.runAllTimers();
    });
    expect(printSpy).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("button has no-print class so @media print hides it", () => {
    render(<PrintReportButton runId="run-42" />);
    expect(screen.getByTestId("print-report-btn").className)
      .toContain("no-print");
  });
});

describe("<PrintReportHeader>", () => {
  it("renders run id + title + print-only class", () => {
    render(<PrintReportHeader runId="run-42" runTitle="Demo Title" />);
    const hdr = screen.getByTestId("print-report-header");
    expect(hdr.className).toContain("print-only");
    expect(hdr.textContent).toContain("run-42");
    expect(hdr.textContent).toContain("Demo Title");
    // Hidden in screen view (display: none in inline style)
    expect(hdr.style.display).toBe("none");
  });
});
