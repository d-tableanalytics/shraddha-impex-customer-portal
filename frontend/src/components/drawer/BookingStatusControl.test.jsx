import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-hot-toast", () => {
  const toast = vi.fn();
  toast.error = vi.fn();
  toast.success = vi.fn();
  return { default: toast };
});
import toast from "react-hot-toast";

import { BookingStatusControl, reportStatusChange } from "./BookingStatusControl";

/** Booking status, moved on the Sales Desk. */
describe("BookingStatusControl", () => {
  test("offers the next stage and any stage", () => {
    const onChange = vi.fn();
    render(<BookingStatusControl status="PO Received" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Move to/ }));
    expect(onChange).toHaveBeenCalledWith("Ready for Dispatch");
    fireEvent.change(screen.getByLabelText("Set booking status"), { target: { value: "Delivered" } });
    expect(onChange).toHaveBeenLastCalledWith("Delivered");
  });

  test("a cancelled booking has no controls", () => {
    render(<BookingStatusControl status="Cancelled" onChange={vi.fn()} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("says when the customer was NOT emailed", () => {
    reportStatusChange({ success: true, changed: true, notified: "failed", notifyError: "bounced" }, "Dispatched");
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/NOT emailed — bounced/), expect.anything());
  });
});
