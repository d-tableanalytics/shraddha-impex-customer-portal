import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, renderHook, act } from "@testing-library/react";

vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));
import toast from "react-hot-toast";

import { ProgressBar } from "./ProgressBar";
import { StageProgress } from "./StageProgress";
import { useBusyAction } from "../../hooks/useBusyAction";

describe("ProgressBar", () => {
  test("shows the real percentage when progress is known", () => {
    render(<ProgressBar value={42.4} label="Uploading file…" />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("Uploading file…")).toBeTruthy();
  });

  test("never invents a percentage when progress is unknown", () => {
    render(<ProgressBar label="Validating rows…" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
    expect(screen.queryByText(/%$/)).toBeNull();
  });

  test("clamps out-of-range values", () => {
    render(<ProgressBar value={140} />);
    expect(screen.getByText("100%")).toBeTruthy();
  });
});

describe("StageProgress", () => {
  const stages = [
    { key: "reading", label: "Reading file" },
    { key: "validating", label: "Validating rows" },
    { key: "ready", label: "Ready to book" },
  ];

  test("marks the running stage as current", () => {
    render(<StageProgress stages={stages} current="validating" />);
    const current = screen.getByText("Validating rows").closest("li");
    expect(current.getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("Reading file").closest("li").getAttribute("aria-current")).toBeNull();
  });
});

describe("useBusyAction", () => {
  beforeEach(() => vi.clearAllMocks());

  test("is busy while running and ignores a second click", async () => {
    let finish;
    const action = vi.fn(() => new Promise((r) => { finish = r; }));
    const { result } = renderHook(() => useBusyAction());

    let first;
    await act(async () => { first = result.current.run("pdf", action); await new Promise((r) => setTimeout(r, 5)); });
    expect(result.current.isBusy("pdf")).toBe(true);
    expect(result.current.isBusy("excel")).toBe(false);

    await act(async () => { await result.current.run("pdf", action); });
    expect(action).toHaveBeenCalledTimes(1);

    await act(async () => { finish(true); await first; });
    expect(result.current.isBusy("pdf")).toBe(false);
  });

  test("reports a failure: a thrown error or a false result", async () => {
    const { result } = renderHook(() => useBusyAction());
    await act(async () => { await result.current.run("a", async () => false, { error: "PDF export failed" }); });
    expect(toast.error).toHaveBeenCalledWith("PDF export failed");

    await act(async () => { await result.current.run("b", async () => { throw new Error("boom"); }, { error: "Excel export failed" }); });
    expect(toast.error).toHaveBeenLastCalledWith("Excel export failed");
    expect(result.current.anyBusy).toBe(false);
  });
});
