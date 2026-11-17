import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../services/sales", () => ({
  salesApi: { updateDetails: vi.fn() },
}));
vi.mock("../../services/users", () => ({
  customersApi: { search: vi.fn(), getById: vi.fn() },
}));
vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import { salesApi } from "../../services/sales";
import { customersApi } from "../../services/users";
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
    <MemoryRouter initialEntries={["/sales-desk"]}>
      <BookingDetailsModal
        isOpen
        booking={BOOKING}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        {...over}
      />
    </MemoryRouter>,
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
    expect(screen.getByText(/1 change will be saved and recorded/i)).toBeTruthy();
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

/**
 * Select Customer in Edit Details: the Create Booking picker, showing the
 * booking's customer, filling the customer fields when a DIFFERENT one is
 * chosen and sending `customerId` only then.
 */
const OWNED = {
  ...BOOKING,
  user: "64aaaaaaaaaaaaaaaaaaaaaa",
  emailId: "buyer@abc.example",
  customerProfile: {
    customerName: "ABC Motors Pvt Ltd", contactName: "Ravi", company: "ABC Motors",
    email: "buyer@abc.example", customerCategory: "Customer",
  },
  createdBy: { id: "64bbbbbbbbbbbbbbbbbbbbbb", name: "Priya Sales", email: "priya@si.example", role: "Sales" },
};

const NEXT = {
  _id: "64cccccccccccccccccccccc",
  customerName: "Zen Auto",
  user: "Meera",
  company: "Zen Auto LLP",
  email: "orders@zen.example",
  phone: "9000000000",
  location: "Nashik",
  shopNumber: "S-7",
  gstNumber: "27AABCU9603R1ZM",
  shippingAddress: "Plot 9, MIDC",
  billingAddress: "Plot 9, MIDC",
  customerCategory: "Customer",
};

const value = (label) => screen.getByLabelText(label).value;

const chooseNext = async () => {
  fireEvent.click(screen.getByRole("button", { name: /change customer/i }));
  fireEvent.change(screen.getByPlaceholderText(/search by customer name or company/i), { target: { value: "zen" } });
  fireEvent.click(await screen.findByRole("button", { name: /Zen Auto/ }));
};

describe("BookingDetailsModal: Select Customer", () => {
  beforeEach(() => {
    customersApi.search.mockResolvedValue([NEXT]);
    customersApi.getById.mockResolvedValue(NEXT);
    salesApi.updateDetails.mockResolvedValue(OWNED);
  });

  test("shows the booking's customer and the SI Team who created it, read-only", () => {
    open({ booking: OWNED });
    expect(screen.getByTestId("selected-customer").textContent).toContain("ABC Motors Pvt Ltd");
    const siTeam = screen.getByLabelText(/si team/i);
    expect(siTeam.value).toBe("Priya Sales (Sales)");
    expect(siTeam.readOnly).toBe(true);
  });

  test("a customer's own booking shows no SI Team", () => {
    open({ booking: { ...OWNED, createdBy: null } });
    expect(screen.getByLabelText(/si team/i).value).toBe("—");
  });

  test("choosing a different customer fills their details and keeps the order's own", async () => {
    open({ booking: OWNED });
    await chooseNext();

    expect(value(/company name/i)).toBe("Zen Auto LLP");
    expect(value(/^email/i)).toBe("orders@zen.example");
    expect(value(/phone number/i)).toBe("9000000000");
    expect(value(/^location/i)).toBe("Nashik");
    expect(value(/shop number/i)).toBe("S-7");
    expect(value(/gst number/i)).toBe("27AABCU9603R1ZM");
    expect(value(/shipping address/i)).toBe("Plot 9, MIDC");
    // Not customer details: these stay as the booking has them.
    expect(value(/po number/i)).toBe("PO-2026-000001");
    expect(value(/vendor code/i)).toBe("VEN-001");
  });

  test("saving sends the customer and the details that changed", async () => {
    const onSaved = vi.fn();
    open({ booking: OWNED, onSaved });
    await chooseNext();
    save();

    await waitFor(() => expect(salesApi.updateDetails).toHaveBeenCalled());
    const [orderId, patch] = salesApi.updateDetails.mock.calls[0];
    expect(orderId).toBe("BO-2026-000042");
    expect(patch).toEqual({
      customerId: "64cccccccccccccccccccccc",
      customerName: "Zen Auto LLP",
      emailId: "orders@zen.example",
      phoneNumber: "9000000000",
      location: "Nashik",
      shopNumber: "S-7",
      gstCode: "27AABCU9603R1ZM",
      shippingAddress: "Plot 9, MIDC",
      billingAddress: "Plot 9, MIDC",
    });
    expect(onSaved).toHaveBeenCalled();
  });

  test("an ordinary edit never sends a customer", async () => {
    open({ booking: OWNED });
    fireEvent.change(screen.getByLabelText(/shop number/i), { target: { value: "105" } });
    save();

    await waitFor(() => expect(salesApi.updateDetails).toHaveBeenCalled());
    expect(salesApi.updateDetails.mock.calls[0][1]).toEqual({ shopNumber: "105" });
  });

  test("going back to the original customer restores the booking's details", async () => {
    customersApi.search.mockResolvedValue([NEXT, { _id: OWNED.user, customerName: "ABC Motors Pvt Ltd", company: "ABC Motors" }]);
    open({ booking: OWNED });
    await chooseNext();
    expect(value(/shop number/i)).toBe("S-7");

    fireEvent.click(screen.getByRole("button", { name: /change customer/i }));
    fireEvent.click(await screen.findByRole("button", { name: /ABC Motors Pvt Ltd/ }));

    expect(value(/shop number/i)).toBe("102");
    expect(value(/company name/i)).toBe("ABC Motors");
    expect(screen.getByText(/no changes yet/i)).toBeTruthy();
  });

  test("the server's refusal of the customer is shown under the picker", async () => {
    salesApi.updateDetails.mockRejectedValue({
      response: { data: { message: "Zen Auto does not have access to Koken.", field: "customerId" } },
    });
    open({ booking: OWNED });
    await chooseNext();
    save();

    const inPicker = await screen.findByText("Zen Auto does not have access to Koken.");
    expect(screen.getByTestId("booking-details-customer").contains(inPicker)).toBe(true);
  });

  test("back from + Add Customer, the new customer is selected and filled in", async () => {
    open({ booking: OWNED, initialCustomerId: NEXT._id });
    await waitFor(() => expect(value(/company name/i)).toBe("Zen Auto LLP"));
    expect(customersApi.getById).toHaveBeenCalledWith(NEXT._id);
    expect(screen.getByTestId("selected-customer").textContent).toContain("Zen Auto");
  });
});
