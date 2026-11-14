import { describe, test, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

/**
 * The Booking History panel the Sales Desk's "Action" button opens.
 *
 * The history itself is the server's (bookingHistory.service.js, pinned by
 * backend/tests/booking-history.test.js). What this screen owes it: the summary
 * a user asked for (booking, customer, company, PO, indent, status), the
 * booking → indent → allocation relationship, and the activity in the order
 * given, each entry saying where it was raised from.
 */

const api = vi.hoisted(() => ({ getHistory: vi.fn() }));
vi.mock("../../services/sales", () => ({ salesApi: api }));

import { BookingHistoryDrawer } from "./BookingHistoryDrawer";
import { useSalesStore } from "../../store/salesStore";
import { queryClient } from "../../lib/queryClient";

const render = (ui) => rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

const SALES = { name: "Priya Sales", role: "Sales" };
const src = (key, label) => ({ key, label });

const HISTORY = {
  booking: {
    orderId: "BO-2026-000001",
    indentNumber: "PI-2026-000001",
    customerName: "Sharma Auto Parts",
    company: "SAP Group",
    poNumber: "PO-H-1",
    poRaisedAt: "2026-11-14T05:30:00.000Z",
    poRaisedBy: SALES,
    locked: true,
    status: "Ready for Dispatch",
    statusLabel: "Ready for Dispatch",
    createdAt: "2026-11-10T05:30:00.000Z",
    createdFrom: src("customer-portal", "Customer Portal"),
    createdBy: { name: "Rakesh", role: "Customer" },
    totals: { atBooking: { requested: 10, confirmed: 2, pending: 8 }, allocated: 3, waitingOnIndent: 5, confirmedNow: 5, lines: 1 },
  },
  lines: [{
    id: "l1", skuCode: "SKU-1", status: "Ready for Dispatch", statusLabel: "Ready for Dispatch",
    bookedQty: 10, confirmedQty: 5, atBooking: { requested: 10, confirmed: 2, pending: 8 },
    allocations: [{
      seq: 1, quantity: 3, indentNumber: "PI-2026-000001", at: "2026-11-12T05:30:00.000Z",
      status: "PO Received", statusLabel: "Booking Received",
      source: src("indent-assignment", "Indent Stock Assignment"), actor: SALES,
    }],
  }],
  indents: [{
    reservationId: "RES-1", indentNumber: "PI-2026-000001", skuCode: "SKU-1", relation: "raised-with-booking",
    status: "Partially Confirmed", open: true, waiting: 5, raisedQty: 8,
  }],
  events: [
    {
      id: "e1", at: "2026-11-10T05:30:00.000Z", kind: "booking", title: "Booking created",
      details: ["10 units requested across 1 SKU: 2 confirmed from stock, 8 sent to indent PI-2026-000001."],
      items: [{ skuCode: "SKU-1", quantity: 10, note: "2 confirmed · 8 to indent" }],
      source: src("customer-portal", "Customer Portal"), actor: { name: "Rakesh", role: "Customer" },
    },
    {
      id: "e2", at: "2026-11-10T05:30:00.000Z", kind: "indent", title: "Indent PI-2026-000001 raised",
      details: [], items: [{ skuCode: "SKU-1", quantity: 8, note: "waiting for stock" }],
      source: src("customer-portal", "Customer Portal"), actor: { name: "Rakesh", role: "Customer" },
    },
    {
      id: "e3", at: "2026-11-12T05:30:00.000Z", kind: "allocation", title: "Stock allocated from indent",
      details: ["Assigned by hand."], items: [{ skuCode: "SKU-1", quantity: 3, note: "allocation #1 · from indent PI-2026-000001" }],
      source: src("indent-assignment", "Indent Stock Assignment"), actor: SALES,
    },
    {
      id: "e4", at: "2026-11-14T05:30:00.000Z", kind: "po", title: "Booking confirmed — PO raised",
      details: ["PO number PO-H-1."], items: [], source: src("sales-desk", "Sales Desk"), actor: SALES,
    },
    {
      id: "e5", at: "2026-11-14T06:00:00.000Z", kind: "status", title: "Status: Ready for Dispatch",
      details: ["Moved from Booking Received."], items: [],
      source: src("bookings", "Sales Desk / Booking History"), actor: SALES,
      notification: { state: "failed", error: "mailbox full" },
    },
  ],
};

const open = (orderId = "BO-2026-000001") => useSalesStore.setState({ historyFor: { orderId }, selected: null });

describe("Booking History", () => {
  beforeEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
    useSalesStore.getState().reset();
    api.getHistory.mockResolvedValue(HISTORY);
  });

  test("is closed until a booking's Action opens it", () => {
    render(<BookingHistoryDrawer />);
    expect(screen.queryByText("Booking History")).toBeNull();
    expect(api.getHistory).not.toHaveBeenCalled();
  });

  test("names the booking, the customer, the company, the PO, the indent and the status", async () => {
    open();
    render(<BookingHistoryDrawer />);
    const summary = await screen.findByRole("region", { name: "Booking summary" });
    expect(api.getHistory).toHaveBeenCalledWith("BO-2026-000001");
    const fact = (label) => within(summary).getByText(label).nextElementSibling.textContent;
    expect(fact("Booking Number")).toBe("BO-2026-000001");
    expect(fact("Customer Name")).toBe("Sharma Auto Parts");
    expect(fact("Company Name")).toBe("SAP Group");
    expect(fact("PO Number")).toBe("PO-H-1");
    expect(fact("Indent")).toBe("PI-2026-000001");
    expect(fact("Current Status")).toBe("Ready for Dispatch");
    expect(fact("Raised from")).toBe("Customer Portal");
    expect(within(summary).getByText(/the booking is locked/)).toBeTruthy();
    // The quantities, from what was recorded at booking to now.
    const tile = (label) => within(summary).getByText(label).nextElementSibling.textContent;
    expect([tile("Requested"), tile("Confirmed at booking"), tile("Allocated from indent"), tile("Still on indent"), tile("Confirmed now")])
      .toEqual(["10", "2", "3", "5", "5"]);
  });

  test("shows each SKU's indent and the allocations made against it, with where each came from", async () => {
    open();
    render(<BookingHistoryDrawer />);
    const sku = await screen.findByTestId("sku-SKU-1");
    expect(within(sku).getByText(/10 requested/).textContent).toMatch(/2 confirmed, 8 to indent/);
    const indent = within(sku).getByText(/raised for 8/).closest("p");
    expect(indent.textContent).toMatch(/Indent PI-2026-000001.*raised for 8.*5 waiting.*Waiting for stock/);
    const allocation = within(sku).getByText("#1").closest("li");
    expect(allocation.textContent).toMatch(/3 pcs/);
    expect(within(allocation).getByText("Indent Stock Assignment")).toBeTruthy();
    expect(within(allocation).getByText("Priya Sales")).toBeTruthy();
  });

  test("lists the activity in the order given, each with where it was raised from and by whom", async () => {
    open();
    render(<BookingHistoryDrawer />);
    await screen.findByRole("region", { name: "Booking activity" });
    const entries = screen.getAllByTestId("history-entry");
    expect(entries.map((e) => e.querySelector("p").textContent)).toEqual([
      "Booking created", "Indent PI-2026-000001 raised", "Stock allocated from indent",
      "Booking confirmed — PO raised", "Status: Ready for Dispatch",
    ]);
    expect(within(entries[2]).getByText("Indent Stock Assignment")).toBeTruthy();
    expect(within(entries[2]).getByText("Priya Sales")).toBeTruthy();
    expect(within(entries[3]).getByText("Sales Desk")).toBeTruthy();
    expect(within(entries[0]).getByText(/2 confirmed · 8 to indent/)).toBeTruthy();
    // A status change says whether the customer was told.
    expect(within(entries[4]).getByText(/Email failed — mailbox full/)).toBeTruthy();
  });

  test("the filters narrow the activity by kind", async () => {
    open();
    render(<BookingHistoryDrawer />);
    const filters = await screen.findByRole("group", { name: "Filter activity" });
    fireEvent.click(within(filters).getByRole("button", { name: /Allocations/ }));
    expect(screen.getAllByTestId("history-entry").map((e) => e.querySelector("p").textContent))
      .toEqual(["Stock allocated from indent"]);
    fireEvent.click(within(filters).getByRole("button", { name: /Booking & PO/ }));
    expect(screen.getAllByTestId("history-entry")).toHaveLength(2);
    fireEvent.click(within(filters).getByRole("button", { name: /^All \d/ }));
    expect(screen.getAllByTestId("history-entry")).toHaveLength(5);
    // No filter is offered for a kind with nothing in it.
    expect(within(filters).queryByRole("button", { name: /Updates/ })).toBeNull();
  });

  test("a booking without a PO or an at-booking record says so rather than guessing", async () => {
    api.getHistory.mockResolvedValue({
      ...HISTORY,
      booking: {
        ...HISTORY.booking, poNumber: null, poRaisedAt: null, poRaisedBy: null, locked: false, indentNumber: null,
        createdFrom: src("record", "Booking record"),
        totals: { ...HISTORY.booking.totals, atBooking: null },
      },
      events: [{ ...HISTORY.events[0], source: src("record", "Booking record"), actor: null }],
    });
    open();
    render(<BookingHistoryDrawer />);
    const summary = await screen.findByRole("region", { name: "Booking summary" });
    expect(within(summary).getByText("Not confirmed yet — waiting for the PO.")).toBeTruthy();
    expect(within(summary).getByText("Requested").nextElementSibling.textContent).toBe("—");
    expect(within(summary).getByText("PO Number").nextElementSibling.textContent).toBe("—");
  });

  test("Open booking hands over to the review drawer", async () => {
    const row = { orderId: "BO-2026-000001", lineCount: 1 };
    useSalesStore.setState({ historyFor: row });
    render(<BookingHistoryDrawer />);
    await screen.findByRole("region", { name: "Booking summary" });
    fireEvent.click(screen.getByRole("button", { name: "Open booking" }));
    expect(useSalesStore.getState().historyFor).toBeNull();
    expect(useSalesStore.getState().selected).toBe(row);
  });

  test("a failed load says why and can be retried", async () => {
    // A refusal the server meant is not retried (lib/queryClient.js).
    api.getHistory.mockRejectedValueOnce({ response: { status: 404, data: { message: "Booking not found." } } });
    open();
    render(<BookingHistoryDrawer />);
    expect(await screen.findByText("Booking not found.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Booking summary" })).toBeTruthy());
  });
});
