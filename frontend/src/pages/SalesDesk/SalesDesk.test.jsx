import { describe, test, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";

/**
 * The Sales Desk search box.
 *
 * The matching itself is the server's (sales.controller getBookings: customer
 * name, booking, SKU, company, PO). What the desk owes it is the term as typed,
 * through the store's debounce, and a list that says what it was fetched for.
 */

const api = vi.hoisted(() => ({ getBookings: vi.fn(), getHistory: vi.fn(), getBooking: vi.fn() }));
vi.mock("../../services/sales", () => ({ salesApi: api }));
vi.mock("../../store/userStore", () => ({
  useUserStore: () => ({ user: { role: "Sales", permissions: ["view_all_bookings"] } }),
}));
// The review drawer is not under test and pulls in half the app.
vi.mock("../../components/drawer/SalesBookingDrawer", () => ({ SalesBookingDrawer: () => null }));

import { SalesDesk } from "./SalesDesk";
import { useSalesStore } from "../../store/salesStore";
import { queryClient } from "../../lib/queryClient";

// The Booking History panel the Action button opens reads through TanStack Query.
// The desk reads `?booking=` links, so it renders inside a router.
const render = (ui, at = "/sales-desk") => rtlRender(
  <QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={[at]}>{ui}</MemoryRouter>
  </QueryClientProvider>,
);

const booking = (orderId, customerName, company, createdBy = null) => ({
  orderId,
  customer: company,
  customerProfile: { customerName, company },
  createdBy,
  date: "2026-11-01",
  locked: false,
  poNumber: null,
  lineCount: 1,
  totalQuantity: 5,
});
const ALL = [
  booking("BO-2026-000101", "Sharma Auto Parts", "Sharma Group", { id: "s1", name: "Sales Person A", role: "Sales" }),
  booking("BO-2026-000102", "Nikita Traders", "NT Pvt Ltd"),
];

/** A stand-in server: case-insensitive partial match on the customer name. */
const respond = ({ search = "" } = {}) => {
  const term = search.trim().toLowerCase();
  const data = ALL.filter((b) => !term || b.customerProfile.customerName.toLowerCase().includes(term));
  return Promise.resolve({ data, meta: { total: data.length, pendingPo: data.length, generated: 0 } });
};

const box = () => screen.getByLabelText("Search bookings");

describe("Sales Desk search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    useSalesStore.getState().reset();
    api.getBookings.mockImplementation(respond);
  });

  test("asks the server with the customer name as typed, and lists what it returns", async () => {
    render(<SalesDesk />);
    await screen.findByText("Nikita Traders");

    fireEvent.change(box(), { target: { value: "sharma" } });
    await waitFor(() => expect(api.getBookings).toHaveBeenLastCalledWith(
      { status: "all", search: "sharma" },
      expect.anything(),
    ));
    await waitFor(() => expect(screen.queryByText("Nikita Traders")).toBeNull());
    expect(screen.getByText("Sharma Auto Parts")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("1 booking match “sharma”");
  });

  test("the SI Team column names who placed the booking, as stored on it", async () => {
    render(<SalesDesk />);
    await screen.findByText("Nikita Traders");
    expect(screen.getByText("SI Team")).toBeTruthy();
    const rowOf = (text) => screen.getByText(text).closest("tr");
    expect(within(rowOf("Sharma Auto Parts")).getByText("Sales Person A")).toBeTruthy();
    // The customer's own booking: a dash, never the signed-in user.
    expect(within(rowOf("Nikita Traders")).getByTitle("Placed by the customer").textContent).toBe("—");
  });

  test("partial, any-case names reach the server unchanged", async () => {
    render(<SalesDesk />);
    await screen.findByText("Nikita Traders");
    fireEvent.change(box(), { target: { value: "NIK" } });
    await waitFor(() => expect(api.getBookings).toHaveBeenLastCalledWith(
      { status: "all", search: "NIK" },
      expect.anything(),
    ));
    await waitFor(() => expect(screen.queryByText("Sharma Auto Parts")).toBeNull());
    expect(screen.getByText("Nikita Traders")).toBeTruthy();
  });

  test("an unmatched name shows the empty state", async () => {
    render(<SalesDesk />);
    await screen.findByText("Nikita Traders");
    fireEvent.change(box(), { target: { value: "nobody by this name" } });
    expect(await screen.findByText("No bookings found matching your criteria.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("0 bookings match “nobody by this name”");
  });

  test("the clear button empties the box and reloads everything", async () => {
    render(<SalesDesk />);
    await screen.findByText("Nikita Traders");
    fireEvent.change(box(), { target: { value: "sharma" } });
    await waitFor(() => expect(screen.queryByText("Nikita Traders")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(box().value).toBe("");
    expect(await screen.findByText("Nikita Traders")).toBeTruthy();
    expect(screen.getByText("Sharma Auto Parts")).toBeTruthy();
    expect(api.getBookings).toHaveBeenLastCalledWith({ status: "all", search: "" }, expect.anything());
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("the scope tabs keep the search", async () => {
    render(<SalesDesk />);
    await screen.findByText("Nikita Traders");
    fireEvent.change(box(), { target: { value: "sharma" } });
    await waitFor(() => expect(screen.queryByText("Nikita Traders")).toBeNull());

    // The summary tile and the tab both select the scope; either will do.
    fireEvent.click(screen.getAllByRole("button", { name: /^Pending PO/ })[0]);
    await waitFor(() => expect(api.getBookings).toHaveBeenLastCalledWith(
      { status: "pending", search: "sharma" },
      expect.anything(),
    ));
  });
});

describe("Sales Desk Action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    useSalesStore.getState().reset();
    api.getBookings.mockImplementation(respond);
    api.getHistory.mockImplementation(async (orderId) => ({
      booking: {
        orderId, customerName: "Nikita Traders", company: "NT Pvt Ltd", poNumber: null, indentNumber: null,
        status: "PO Received", statusLabel: "Booking Received", createdAt: "2026-11-01T05:00:00.000Z",
        createdFrom: { key: "customer-portal", label: "Customer Portal" }, totals: {},
      },
      lines: [],
      indents: [],
      events: [{
        id: "e1", at: "2026-11-01T05:00:00.000Z", kind: "booking", title: "Booking created", details: [], items: [],
        source: { key: "customer-portal", label: "Customer Portal" }, actor: null,
      }],
    }));
  });

  test("the Action column has two icons per booking: View Details and View History", async () => {
    render(<SalesDesk />);
    await screen.findByText("Nikita Traders");
    expect(screen.getByRole("columnheader", { name: "Action" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Review" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^View details for/ })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^View history for/ })).toHaveLength(2);
  });

  test("View Details opens the booking for review, not its history", async () => {
    render(<SalesDesk />);
    await screen.findByText("Nikita Traders");
    fireEvent.click(screen.getByRole("button", { name: "View details for BO-2026-000102" }));
    expect(useSalesStore.getState().selected?.orderId).toBe("BO-2026-000102");
    expect(useSalesStore.getState().historyFor).toBeNull();
    expect(api.getHistory).not.toHaveBeenCalled();
  });

  test("View History opens that booking's history, not the review drawer", async () => {
    render(<SalesDesk />);
    await screen.findByText("Nikita Traders");
    fireEvent.click(screen.getByRole("button", { name: "View history for BO-2026-000102" }));

    await waitFor(() => expect(api.getHistory).toHaveBeenCalledWith("BO-2026-000102"));
    const summary = await screen.findByRole("region", { name: "Booking summary" });
    expect(within(summary).getByText("BO-2026-000102")).toBeTruthy();
    expect(screen.getByText("Booking created")).toBeTruthy();
    expect(useSalesStore.getState().selected).toBeNull();
  });

  test("clicking the row still opens the booking for review", async () => {
    render(<SalesDesk />);
    fireEvent.click((await screen.findByText("Nikita Traders")).closest("tr"));
    expect(useSalesStore.getState().selected?.orderId).toBe("BO-2026-000102");
    expect(useSalesStore.getState().historyFor).toBeNull();
    expect(api.getHistory).not.toHaveBeenCalled();
  });
});

/**
 * "+ Add Customer" in Edit Details leaves the desk for Customer Management and
 * comes back to `?booking=<id>&editDetails=1&customer=<new id>`.
 */
describe("Sales Desk booking links", () => {
  let search = null;
  const Where = () => { search = useLocation().search; return null; };

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    useSalesStore.getState().reset();
    api.getBookings.mockImplementation(respond);
    api.getBooking.mockImplementation(async (orderId) => ({ ...ALL[0], orderId, indent: { lines: [] } }));
  });

  test("reopens the booking and asks the drawer for Edit Details with the new customer", async () => {
    render(<><SalesDesk /><Where /></>, "/sales-desk?booking=BO-2026-000101&editDetails=1&customer=c9");

    await waitFor(() => expect(useSalesStore.getState().selected?.orderId).toBe("BO-2026-000101"));
    expect(api.getBooking).toHaveBeenCalledWith("BO-2026-000101");
    expect(useSalesStore.getState().detailsIntent).toEqual({ orderId: "BO-2026-000101", customerId: "c9" });
    // Read once: a reload does not reopen it.
    await waitFor(() => expect(search).toBe(""));
  });

  test("a plain booking link opens the booking without the form", async () => {
    render(<SalesDesk />, "/sales-desk?booking=BO-2026-000102");
    await waitFor(() => expect(useSalesStore.getState().selected?.orderId).toBe("BO-2026-000102"));
    expect(useSalesStore.getState().detailsIntent).toBeNull();
  });
});
