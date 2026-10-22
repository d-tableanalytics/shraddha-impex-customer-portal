/**
 * SMOKE TEST — Upcoming Stock screen and import dialog (UI-xx, matching the
 * smoke-test report). The API is mocked; the import dialog reads REAL .xlsx
 * files built with the same xlsx library the browser uses.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import * as XLSX from "xlsx";

vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../services/socketService", () => ({ onStockUpdated: () => () => {}, onUpcomingUpdated: () => () => {} }));

const api = vi.hoisted(() => ({
  upcomingStock: vi.fn(),
  updateUpcomingShipment: vi.fn(),
  cancelUpcomingShipment: vi.fn(),
  deleteUpcomingShipment: vi.fn(),
  deleteUpcomingSku: vi.fn(),
  previewUpcomingImport: vi.fn(),
  importUpcoming: vi.fn(),
}));
vi.mock("../../services/inventory", () => ({ inventoryApi: api }));

const userState = vi.hoisted(() => ({ user: null }));
vi.mock("../../store/userStore", () => ({ useUserStore: () => userState }));

import toast from "react-hot-toast";
import { UpcomingStock } from "./UpcomingStock";
import { ImportUpcomingModal } from "../../components/inventory/ImportUpcomingModal";
import { queryClient } from "../../lib/queryClient";

const render = (ui) => rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString();

const ADMIN = { role: "Admin", permissions: ["*"] };

/** Server answer: one SKU with three indents, FIFO-allocated 13 of 24. */
const payload = () => ({
  lastImport: { fileName: "smoke.xlsx", importedAt: inDays(0) },
  items: [{
    key: "Koken::SKU-S", brand: "Koken", skuCode: "SKU-S", product: "Smoke socket", category: "Sockets", uom: "PCS",
    actual: 0, upcoming: 13, demand: 24, reserved: 13, remaining: 0, projected: 0, reservedShare: 1,
    nextEta: inDays(5), shipmentCount: 1, status: "Fully Reserved",
    shipments: [{ id: "s1", ref: "PO-9", supplier: "—", qty: 13, orderedQty: 13, receivedQty: 0, eta: inDays(5), etaRevised: false, status: "Open", source: "smoke.xlsx", importedAt: inDays(0) }],
    indents: [
      { lineId: "i1", fifoPosition: 1, indentNumber: "PI-1", customer: "Oldest Co", requiredQty: 10, reservedQty: 10, shortQty: 0, coveredBy: [{ shipmentId: "s1", ref: "PO-9", eta: inDays(5), qty: 10 }], status: "Pending", raisedAt: inDays(-30) },
      { lineId: "i2", fifoPosition: 2, indentNumber: "PI-2", customer: "Middle Co", requiredQty: 6, reservedQty: 3, shortQty: 3, coveredBy: [{ shipmentId: "s1", ref: "PO-9", eta: inDays(5), qty: 3 }], status: "Pending", raisedAt: inDays(-20) },
      { lineId: "i3", fifoPosition: 3, indentNumber: "PI-3", customer: "Newest Co", requiredQty: 8, reservedQty: 0, shortQty: 8, coveredBy: [], status: "Pending", raisedAt: inDays(-10) },
    ],
  }],
});

/** A real .xlsx file, as a user would pick it. */
const xlsxFile = (aoa, name = "upcoming.xlsx") => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Upcoming Stock");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new File([buf], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
};
const pick = (container, file) => fireEvent.change(container.ownerDocument.querySelector('input[type="file"]'), {
  target: { files: [file] },
});

describe("Upcoming Stock — UI smoke", () => {
  beforeEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
    userState.user = ADMIN;
    api.upcomingStock.mockResolvedValue(payload());
  });

  test("UI-01 a loading indicator shows while the data is fetched", async () => {
    let finish;
    api.upcomingStock.mockReturnValue(new Promise((r) => { finish = r; }));
    const { container } = render(<UpcomingStock />);
    expect(container.querySelectorAll("tbody tr").length).toBe(6); // placeholder rows
    expect(screen.queryByText("No upcoming stock recorded")).toBeNull();
    finish(payload());
    expect(await screen.findByText("SKU-S")).toBeTruthy();
  });

  test("UI-02 reserved and remaining are shown per SKU and per indent (FIFO order)", async () => {
    render(<UpcomingStock />);
    const row = (await screen.findByText("SKU-S")).closest("tr");
    // Columns: SKU, Product, Actual, Upcoming, Reserved, Remaining, …
    const cells = [...row.querySelectorAll("td")].map((td) => td.textContent.trim());
    expect([cells[2], cells[3], cells[4], cells[5]]).toEqual(["0", "13", "13", "0"]);
    expect(cells[6]).toMatch(/2 left short.*1\/3 covered \(FIFO\)/); // Indents column
    fireEvent.click(screen.getByText("SKU-S"));
    const panel = await screen.findByRole("dialog", { name: /SKU-S/ });
    const items = within(within(panel).getByRole("list", { name: "Open indents in FIFO order" })).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector(".font-mono").textContent)).toEqual(["PI-1", "PI-2", "PI-3"]);
    expect(within(items[1]).getByText("3 short")).toBeTruthy();
    expect(within(items[2]).getByText("Not Reserved")).toBeTruthy();
  });

  test("UI-03 no manual reservation controls exist, even for an admin", async () => {
    render(<UpcomingStock />);
    fireEvent.click(await screen.findByText("SKU-S"));
    const panel = await screen.findByRole("dialog", { name: /SKU-S/ });
    for (const name of [/Reserve Stock/, /^Reserve$/, /Confirm Reservation/, /Keep Pending/, /Release/, /Direct reservation/]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(within(panel).queryByRole("tab", { name: /Reservations/ })).toBeNull();
    expect(screen.getByText(/It is a simulation/)).toBeTruthy();
  });

  test("UI-04 refreshing re-reads the data without duplicating rows", async () => {
    const { container } = render(<UpcomingStock />);
    await screen.findByText("SKU-S");
    const rowsBefore = container.querySelectorAll("tbody tr").length;
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(api.upcomingStock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: /Refresh/ }).disabled).toBe(false));
    expect(container.querySelectorAll("tbody tr").length).toBe(rowsBefore);
    expect(screen.getAllByText("SKU-S")).toHaveLength(1);
  });

  test("UI-05 a failed load shows the error and a working retry", async () => {
    api.upcomingStock.mockRejectedValue({ response: { status: 503, data: { message: "Server unavailable" } } });
    render(<UpcomingStock />);
    expect(await screen.findByText("Server unavailable", {}, { timeout: 4000 })).toBeTruthy();
    api.upcomingStock.mockResolvedValue(payload());
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText("SKU-S")).toBeTruthy();
  });

  test("UI-06 nothing uploaded yet: an empty state that says what to do", async () => {
    api.upcomingStock.mockResolvedValue({ items: [], lastImport: null });
    render(<UpcomingStock />);
    expect(await screen.findByText("No upcoming stock recorded")).toBeTruthy();
    expect(screen.getByText("Import an upcoming stock file to add shipments.")).toBeTruthy();
  });
});

describe("Import dialog — real files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  const open = () => render(<ImportUpcomingModal open onClose={() => {}} onImported={() => {}} templateBrand="Koken" />);

  test("UI-10 a valid .xlsx is read, checked, and imported with a success message", async () => {
    api.previewUpcomingImport.mockImplementation(async (rows) => ({
      lines: rows.map((r) => ({ ...r, qty: Number(r.qty), outcome: "existing", problems: [], product: r.skuCode, eta: null })),
    }));
    api.importUpcoming.mockResolvedValue({ lines: 2, qty: 150, created: 0, merged: 0 });
    const { container } = open();
    pick(container, xlsxFile([
      ["SKU Code", "Brand", "Upcoming Qty", "Expected Arrival", "PO / Shipment Ref"],
      ["SKU-S", "Koken", 100, "05/11/2026", "PO-1"],
      ["SKU-T", "Koken", 50, "", ""],
    ]));
    await waitFor(() => expect(api.previewUpcomingImport).toHaveBeenCalledTimes(1));
    const sent = api.previewUpcomingImport.mock.calls[0][0];
    expect(sent.map((r) => [r.skuCode, r.qty, r.eta, r.ref])).toEqual([["SKU-S", 100, "2026-11-05", "PO-1"], ["SKU-T", 50, "", ""]]);
    fireEvent.click(await screen.findByRole("button", { name: /Import 2 lines/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Imported 2 lines · 150 units/)));
  });

  test("UI-11 a file without SKU / quantity columns is refused with a clear message", async () => {
    const { container } = open();
    pick(container, xlsxFile([["Item", "Date"], ["SKU-S", "05/11/2026"]]));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The file needs at least a "SKU Code" and an "Upcoming Qty" column.'));
    expect(api.previewUpcomingImport).not.toHaveBeenCalled();
  });

  test("UI-12 a file with headers but no rows is refused", async () => {
    const { container } = open();
    pick(container, xlsxFile([["SKU Code", "Upcoming Qty"]]));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The file has no data rows."));
    expect(api.previewUpcomingImport).not.toHaveBeenCalled();
  });

  test("UI-13 a file that is not a spreadsheet is refused with a message", async () => {
    const { container } = open();
    pick(container, new File(["this is not a spreadsheet"], "notes.txt", { type: "text/plain" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // The xlsx reader accepts plain text as a one-column sheet, so the message
    // users see is the missing-columns one rather than "could not be read".
    expect(toast.error.mock.calls[0][0]).toBe('The file needs at least a "SKU Code" and an "Upcoming Qty" column.');
    expect(api.previewUpcomingImport).not.toHaveBeenCalled();
  });

  test("UI-14 row errors from the server are listed and those rows are not counted", async () => {
    api.previewUpcomingImport.mockResolvedValue({
      lines: [
        { row: 2, skuCode: "SKU-S", brand: "Koken", product: "SKU-S", qty: 5, eta: null, ref: null, supplier: null, outcome: "existing", problems: [] },
        { row: 3, skuCode: "SKU-S", brand: "Koken", product: "SKU-S", qty: 0, eta: null, ref: null, supplier: null, outcome: "error", problems: ['Quantity "0" is not a whole number above 0'] },
      ],
    });
    const { container } = open();
    pick(container, xlsxFile([["SKU Code", "Upcoming Qty"], ["SKU-S", 5], ["SKU-S", 0]]));
    expect(await screen.findByText('Quantity "0" is not a whole number above 0')).toBeTruthy();
    expect(screen.getByText(/1 row will be skipped/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Import 1 line/ })).toBeTruthy();
  });

  test("UI-15 a failed import shows the server's message and keeps the dialog open", async () => {
    api.previewUpcomingImport.mockResolvedValue({
      lines: [{ row: 2, skuCode: "SKU-S", brand: "Koken", product: "SKU-S", qty: 5, eta: null, ref: null, supplier: null, outcome: "existing", problems: [] }],
    });
    api.importUpcoming.mockRejectedValue({ response: { data: { message: "A line in this file was recorded on upcoming stock a moment ago. Refresh, then import again." } } });
    const { container } = open();
    pick(container, xlsxFile([["SKU Code", "Upcoming Qty"], ["SKU-S", 5]]));
    fireEvent.click(await screen.findByRole("button", { name: /Import 1 line/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/recorded on upcoming stock a moment ago/)));
    expect(screen.getByRole("button", { name: /Import 1 line/ })).toBeTruthy();
  });
});
