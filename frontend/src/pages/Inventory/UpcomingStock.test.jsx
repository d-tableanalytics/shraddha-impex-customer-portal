import { describe, test, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../services/socketService", () => ({ onStockUpdated: () => () => {}, onUpcomingUpdated: () => () => {} }));

const api = vi.hoisted(() => ({
  upcomingStock: vi.fn(),
  keepIndentPending: vi.fn(),
  resumeIndent: vi.fn(),
  updateUpcomingShipment: vi.fn(),
  cancelUpcomingShipment: vi.fn(),
  previewUpcomingImport: vi.fn(),
  importUpcoming: vi.fn(),
}));
vi.mock("../../services/inventory", () => ({ inventoryApi: api }));

const userState = vi.hoisted(() => ({ user: null }));
vi.mock("../../store/userStore", () => ({ useUserStore: () => userState }));

import toast from "react-hot-toast";
import { UpcomingStock } from "./UpcomingStock";
import { queryClient } from "../../lib/queryClient";

const render = (ui) => rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString();

/** What GET /inventory/upcoming returns, for two SKUs. */
const payload = () => ({
  lastImport: { fileName: "october.xlsx", importedAt: inDays(-1) },
  items: [
    {
      key: "Koken::14405M-10", brand: "Koken", skuCode: "14405M-10", product: "Socket 10mm", category: "Sockets", uom: "PCS",
      actual: 42, upcoming: 400, demand: 240, reserved: 240, remaining: 160, projected: 202, reservedShare: 0.6,
      nextEta: inDays(9), shipmentCount: 1, status: "Available",
      shipments: [{ id: "s1", ref: "PO-KK-1", supplier: "Koken Japan", qty: 400, orderedQty: 500, receivedQty: 100, eta: inDays(9), etaRevised: false, status: "Partially Received", source: "october.xlsx", importedAt: inDays(-1) }],
      // As the server's FIFO allocation sends them: oldest first, each with its share.
      indents: [
        { lineId: "ind1", fifoPosition: 1, indentNumber: "PI-2026-000101", skuCode: "14405M-10", customer: "ABC Motors", requiredQty: 150, reservedQty: 150, shortQty: 0, coveredBy: [{ shipmentId: "s1", ref: "PO-KK-1", eta: inDays(9), qty: 150 }], status: "Partially Confirmed", poNumber: "PO-1", raisedAt: inDays(-8), scheduledDate: null },
        { lineId: "ind2", fifoPosition: 2, indentNumber: "PI-2026-000102", skuCode: "14405M-10", customer: "Pune Auto Spares", requiredQty: 90, reservedQty: 90, shortQty: 0, coveredBy: [{ shipmentId: "s1", ref: "PO-KK-1", eta: inDays(9), qty: 90 }], status: "Pending", poNumber: null, raisedAt: inDays(-2), scheduledDate: null },
      ],
    },
    {
      key: "Koken::4768N", brand: "Koken", skuCode: "4768N", product: "Ratchet 72T", category: "Ratchets", uom: "PCS",
      actual: 12, upcoming: 60, demand: 0, reserved: 0, remaining: 60, projected: 72, reservedShare: 0,
      nextEta: inDays(-3), shipmentCount: 1, status: "Delayed",
      shipments: [{ id: "s2", ref: "PO-KK-2", supplier: "Koken Japan", qty: 60, orderedQty: 60, receivedQty: 0, eta: inDays(-3), etaRevised: false, status: "Open", source: "october.xlsx", importedAt: inDays(-1) }],
      indents: [],
    },
  ],
});

const SALES = { role: "Sales", permissions: ["view_inventory", "assign_indent_stock"], brandAccess: { koken: true } };

describe("Upcoming Stock", () => {
  beforeEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
    userState.user = SALES;
    api.upcomingStock.mockResolvedValue(payload());
  });

  test("shows the server's figures, not mock data", async () => {
    render(<UpcomingStock />);
    expect(await screen.findByText("14405M-10")).toBeTruthy();
    expect(screen.getByText("4768N")).toBeTruthy();
    // Summary cards: actual 42 + 12, upcoming 400 + 60.
    const card = (label) => screen.getByText(label, { selector: "p" }).parentElement;
    expect(within(card("Actual Stock")).getByText("54")).toBeTruthy();
    expect(within(card("Upcoming Stock")).getByText("460")).toBeTruthy();
    expect(within(card("Reserved Upcoming")).getByText("240")).toBeTruthy();
    expect(within(card("Remaining Upcoming")).getByText("220")).toBeTruthy();
    expect(screen.getByText(/Last import:/)).toBeTruthy();
    expect(screen.getByText("october.xlsx")).toBeTruthy();
    expect(api.upcomingStock).toHaveBeenCalledTimes(1);
  });

  test("search, status filter and the delayed shortcut narrow the table", async () => {
    render(<UpcomingStock />);
    await screen.findByText("14405M-10");

    fireEvent.change(screen.getByPlaceholderText("Search by SKU or product..."), { target: { value: "ratchet" } });
    expect(screen.queryByText("14405M-10")).toBeNull();
    expect(screen.getByText("4768N")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Reset$/ }));
    expect(screen.getByText("14405M-10")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /1 SKU with a delayed shipment/ }));
    expect(screen.queryByText("14405M-10")).toBeNull();
    expect(screen.getByText("4768N")).toBeTruthy();
  });

  test("the Indents tab shows the automatic FIFO allocation, read-only", async () => {
    render(<UpcomingStock />);
    fireEvent.click(await screen.findByText("14405M-10"));
    const panel = await screen.findByRole("dialog", { name: /14405M-10/ });
    const queue = within(panel).getByRole("list", { name: "Open indents in FIFO order" });
    const rows = within(queue).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector(".font-mono").textContent)).toEqual(["PI-2026-000101", "PI-2026-000102"]);
    expect(within(rows[0]).getByText("Fully Reserved")).toBeTruthy();
    expect(within(rows[0]).getByText(/PO-KK-1/)).toBeTruthy();
    expect(within(panel).getByText(/no stock is reserved and nothing is sent to customers/)).toBeTruthy();
    // Nothing to do by hand any more.
    for (const name of [/Confirm Reservation/, /Keep Pending/, /Release/, /^Reserve$/, /Reserve for an indent/]) {
      expect(within(panel).queryByRole("button", { name })).toBeNull();
    }
    expect(within(panel).queryByRole("tab", { name: /Reservations/ })).toBeNull();
  });

  test("an indent the upcoming stock does not cover is shown as short, and flagged", async () => {
    const data = payload();
    Object.assign(data.items[0], { upcoming: 200, reserved: 200, remaining: 0, status: "Fully Reserved" });
    data.items[0].shipments[0].qty = 200;
    Object.assign(data.items[0].indents[1], {
      reservedQty: 50, shortQty: 40, coveredBy: [{ shipmentId: "s1", ref: "PO-KK-1", eta: inDays(9), qty: 50 }],
    });
    api.upcomingStock.mockResolvedValue(data);
    render(<UpcomingStock />);
    expect(await screen.findByText("1 indent not fully covered by upcoming stock")).toBeTruthy();
    expect(screen.getByText("1 left short")).toBeTruthy();
    fireEvent.click(screen.getByText("14405M-10"));
    const panel = await screen.findByRole("dialog", { name: /14405M-10/ });
    expect(within(panel).getByText("40 short")).toBeTruthy();
    expect(within(panel).getByText("Partially Reserved")).toBeTruthy();
  });

  test("a read-only user sees the figures but no import, reserve or release controls", async () => {
    userState.user = { role: "Warehouse User", permissions: ["view_inventory"] };
    render(<UpcomingStock />);
    await screen.findByText("14405M-10");
    expect(screen.queryByRole("button", { name: /Import Upcoming Stock/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reserve Stock/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reserve" })).toBeNull();

    fireEvent.click(screen.getByText("14405M-10"));
    const panel = await screen.findByRole("dialog", { name: /14405M-10/ });
    expect(within(panel).queryByRole("button", { name: /Confirm Reservation/ })).toBeNull();
    fireEvent.click(within(panel).getByRole("tab", { name: /Shipments/ }));
    expect(within(panel).queryByRole("button", { name: /Edit upcoming stock entry/ })).toBeNull();
    expect(within(panel).getByText("100 of 500 received")).toBeTruthy();
  });

  test("a manager edits an entry after import, sending only what changed", async () => {
    userState.user = { role: "Import Team", permissions: ["view_inventory", "manage_inventory_master", "assign_indent_stock"] };
    api.updateUpcomingShipment.mockResolvedValue({ id: "s2", changed: [] });
    render(<UpcomingStock />);
    fireEvent.click(await screen.findByText("4768N"));
    const panel = await screen.findByRole("dialog", { name: /4768N/ });
    fireEvent.click(within(panel).getByRole("tab", { name: /Shipments/ }));
    fireEvent.click(within(panel).getByRole("button", { name: "Edit upcoming stock entry PO-KK-2" }));
    // Prefilled with the entry's current values.
    expect(within(panel).getByLabelText(/Quantity/).value).toBe("60");
    expect(within(panel).getByLabelText(/PO \/ shipment ref/).value).toBe("PO-KK-2");
    fireEvent.change(within(panel).getByLabelText(/Expected arrival/), { target: { value: "2026-12-01" } });
    fireEvent.change(within(panel).getByLabelText(/Supplier/), { target: { value: "" } });
    fireEvent.change(within(panel).getByLabelText(/Product description/), { target: { value: "Ratchet 72T, 1/2 inch" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.updateUpcomingShipment).toHaveBeenCalledWith(
      "s2", { eta: "2026-12-01", supplier: "", product: "Ratchet 72T, 1/2 inch" },
    ));
    await waitFor(() => expect(api.upcomingStock).toHaveBeenCalledTimes(2));
  });

  test("an entry imported with only SKU and quantity shows blanks, not errors", async () => {
    const data = payload();
    data.items[1] = {
      ...data.items[1], nextEta: null, status: "Available",
      shipments: [{ ...data.items[1].shipments[0], ref: null, eta: null, supplier: "—" }],
    };
    api.upcomingStock.mockResolvedValue(data);
    render(<UpcomingStock />);
    fireEvent.click(await screen.findByText("4768N"));
    const panel = await screen.findByRole("dialog", { name: /4768N/ });
    fireEvent.click(within(panel).getByRole("tab", { name: /Shipments/ }));
    expect(within(panel).getByText("No reference")).toBeTruthy();
    expect(within(panel).getByText("Arrival date not set")).toBeTruthy();
    expect(screen.getAllByText("Date not set").length).toBeGreaterThan(0);
  });

  test("a manager can delete an entry after confirming it", async () => {
    userState.user = { role: "Import Team", permissions: ["view_inventory", "manage_inventory_master", "assign_indent_stock"] };
    api.deleteUpcomingShipment = vi.fn().mockResolvedValue({ id: "s2", deletedQty: 60 });
    render(<UpcomingStock />);
    fireEvent.click(await screen.findByText("4768N"));
    const panel = await screen.findByRole("dialog", { name: /4768N/ });
    fireEvent.click(within(panel).getByRole("tab", { name: /Shipments/ }));
    fireEvent.click(within(panel).getByRole("button", { name: "Delete upcoming stock entry PO-KK-2" }));
    expect(api.deleteUpcomingShipment).not.toHaveBeenCalled();
    expect(within(panel).getByText(/Actual stock is not changed/)).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText(/Reason for deleting PO-KK-2/), { target: { value: "Not required" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Delete entry" }));
    await waitFor(() => expect(api.deleteUpcomingShipment).toHaveBeenCalledWith("s2", "Not required"));
    await waitFor(() => expect(api.upcomingStock).toHaveBeenCalledTimes(2));
  });

  test("each table row has a Delete button that asks before deleting", async () => {
    userState.user = { role: "Import Team", permissions: ["view_inventory", "manage_inventory_master", "assign_indent_stock"] };
    api.deleteUpcomingSku = vi.fn().mockResolvedValue({ skuCode: "4768N", entries: 1, deletedQty: 60 });
    render(<UpcomingStock />);
    await screen.findByText("4768N");
    fireEvent.click(screen.getByRole("button", { name: "Delete upcoming stock for 4768N" }));
    expect(await screen.findByText(/Actual stock in the inventory is not changed/)).toBeTruthy();
    expect(api.deleteUpcomingSku).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteUpcomingSku).toHaveBeenCalledWith({ brand: "Koken", skuCode: "4768N" }));
    await waitFor(() => expect(api.upcomingStock).toHaveBeenCalledTimes(2));
  });

  test("users who cannot manage shipments get no Delete button", async () => {
    render(<UpcomingStock />); // Sales: may view, may not manage shipments
    await screen.findByText("4768N");
    expect(screen.queryByRole("button", { name: /Delete upcoming stock for/ })).toBeNull();
    fireEvent.click(await screen.findByText("4768N"));
    const panel = await screen.findByRole("dialog", { name: /4768N/ });
    fireEvent.click(within(panel).getByRole("tab", { name: /Shipments/ }));
    expect(within(panel).queryByRole("button", { name: /Delete upcoming stock entry/ })).toBeNull();
  });

  test("no manual reservation anywhere, even for an admin", async () => {
    userState.user = { role: "Admin", permissions: ["*"] };
    render(<UpcomingStock />);
    await screen.findByText("14405M-10");
    expect(screen.queryByRole("button", { name: /Reserve Stock/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reserve" })).toBeNull();
    expect(screen.getByText(/It is a simulation/)).toBeTruthy();
  });

  test("a failed load says so and offers a retry", async () => {
    // A 5xx is retried once by the shared query client, so it fails twice here.
    api.upcomingStock.mockRejectedValue({ response: { status: 503, data: { message: "Server unavailable" } } });
    render(<UpcomingStock />);
    expect(await screen.findByText("Server unavailable", {}, { timeout: 4000 })).toBeTruthy();
    api.upcomingStock.mockResolvedValue(payload());
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText("14405M-10")).toBeTruthy();
  });

  test("an empty list says how to add shipments", async () => {
    api.upcomingStock.mockResolvedValue({ items: [], lastImport: null });
    render(<UpcomingStock />);
    expect(await screen.findByText("No upcoming stock recorded")).toBeTruthy();
  });
});
