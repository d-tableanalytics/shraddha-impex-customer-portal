import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../../services/sales", () => ({
  salesApi: { updateDetails: vi.fn() },
}));
vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import { salesApi } from "../../services/sales";
import { BookingDetailsModal } from "./BookingDetailsModal";

/**
 * The behaviour worth testing here is the DIFF.
 *
 * Posting the whole form would compile and look right, and would then quietly
 * do two damaging things on every save: blank each field the server had as null
 * (the form renders those as '', which the endpoint reads as "clear it"), and
 * fill the audit trail with eleven unchanged fields so the one that actually
 * moved is buried.
 */
const BOOKING = {
  orderId: "BO-2026-000042",
  customer: "ABC Motors",
  poNumber: "PO-2026-000001",
  shopNumber: "102",
  vendorCode: "VEN-001",
  gstCode: "27AAPFU0939F1ZV",
  phoneNumber: "9876543210",
  location: "Pune",
  // Deliberately absent: emailId, paymentTerm, addresses, remarks, dates.
};

const open = (over = {}) =>
  render(
    <BookingDetailsModal
      isOpen
      booking={BOOKING}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      {...over}
    />,
  );

const save = () => fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

beforeEach(() => {
  vi.clearAllMocks();
  salesApi.updateDetails.mockResolvedValue({ ...BOOKING, shopNumber: "105" });
});

describe("BookingDetailsModal", () => {
  test("sends ONLY the field that changed", async () => {
    open();

    fireEvent.change(screen.getByLabelText(/shop number/i), { target: { value: "105" } });
    save();

    await waitFor(() => expect(salesApi.updateDetails).toHaveBeenCalled());
    const [orderId, patch] = salesApi.updateDetails.mock.calls[0];

    expect(orderId).toBe("BO-2026-000042");
    // Exactly one key. Untouched fields must not appear at all.
    expect(patch).toEqual({ shopNumber: "105" });
  });

  test("does not blank the fields the booking never had", async () => {
    open();

    fireEvent.change(screen.getByLabelText(/shop number/i), { target: { value: "105" } });
    save();

    await waitFor(() => expect(salesApi.updateDetails).toHaveBeenCalled());
    const [, patch] = salesApi.updateDetails.mock.calls[0];

    // These render as '' in the form. Sending them would clear them server-side.
    for (const absent of ["emailId", "paymentTerm", "remarks", "shippingAddress", "poDate"]) {
      expect(patch).not.toHaveProperty(absent);
    }
  });

  test("sends several fields when several changed", async () => {
    open();

    fireEvent.change(screen.getByLabelText(/shop number/i), { target: { value: "105" } });
    fireEvent.change(screen.getByLabelText(/vendor code/i), { target: { value: "VEN-002" } });
    save();

    await waitFor(() => expect(salesApi.updateDetails).toHaveBeenCalled());
    expect(salesApi.updateDetails.mock.calls[0][1]).toEqual({
      shopNumber: "105",
      vendorCode: "VEN-002",
    });
  });

  test("Save is disabled until something changes", () => {
    open();
    expect(screen.getByRole("button", { name: /save changes/i }).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/shop number/i), { target: { value: "105" } });
    expect(screen.getByRole("button", { name: /save changes/i }).disabled).toBe(false);
  });

  test("typing a value back to its original disarms the save", () => {
    open();
    const shop = screen.getByLabelText(/shop number/i);

    fireEvent.change(shop, { target: { value: "105" } });
    fireEvent.change(shop, { target: { value: "102" } });

    // Otherwise a no-op save writes an audit row saying nothing happened.
    expect(screen.getByRole("button", { name: /save changes/i }).disabled).toBe(true);
  });

  test("marks which fields will be written", () => {
    open();
    fireEvent.change(screen.getByLabelText(/shop number/i), { target: { value: "105" } });

    expect(screen.getByText("• changed")).toBeTruthy();
    expect(screen.getByText(/1 field will be updated and recorded/i)).toBeTruthy();
  });

  test("puts a server field error on the input it belongs to", async () => {
    salesApi.updateDetails.mockRejectedValue({
      response: { data: { message: "GST Number must be a valid 15-character GSTIN.", field: "gstCode" } },
    });

    open();
    fireEvent.change(screen.getByLabelText(/gst number/i), { target: { value: "NOPE" } });
    save();

    // The message lands where the fix is, not only in a toast that vanishes.
    expect(await screen.findByText(/valid 15-character GSTIN/i)).toBeTruthy();
  });

  test("says plainly that quantities and status are edited elsewhere", () => {
    open();
    expect(
      screen.getByText(/Quantities, SKUs, pricing and booking status are changed on their own screens/i),
    ).toBeTruthy();
  });

  test("clearing an optional field sends an empty string, which means clear", async () => {
    open();
    fireEvent.change(screen.getByLabelText(/^location$/i), { target: { value: "" } });
    save();

    await waitFor(() => expect(salesApi.updateDetails).toHaveBeenCalled());
    expect(salesApi.updateDetails.mock.calls[0][1]).toEqual({ location: "" });
  });
});
