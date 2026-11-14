import { describe, test, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const api = vi.hoisted(() => ({
  indentAssignmentQueue: vi.fn(),
  autoAssignIndents: vi.fn(),
  assignToIndent: vi.fn(),
  reassignAllocation: vi.fn(),
  setIndentAssignmentMode: vi.fn(),
}));
vi.mock("../../services/inventory", () => ({ inventoryApi: api }));

const userState = vi.hoisted(() => ({ user: { role: "Sales", permissions: ["assign_indent_stock"] } }));
vi.mock("../../store/userStore", () => ({ useUserStore: () => userState }));

import { IndentAssignment } from "./IndentAssignment";
import { queryClient } from "../../lib/queryClient";

// The queue is a TanStack Query; each test starts from an empty cache.
const render = (ui) => rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

const queue = {
  mode: "manual",
  skus: [{
    skuCode: "183H.35-8",
    brand: "Koken",
    available: 5,
    indents: [
      { id: "i1", reservationId: "RES-1", indentNumber: "PI-2026-000009", bookingId: "BO-2026-000009", poNumber: "PO-NT-4471", customer: "Nikita Traders", customerName: "Nikita Traders", company: "NT Pvt Ltd", requested: 50, pending: 48, date: "2026-08-21", wholeOnly: false },
      { id: "i2", reservationId: "RES-2", indentNumber: "PI-2026-000072", bookingId: "BO-2026-000072", poNumber: null, customer: "PT Enterprises", customerName: "PT Enterprises", company: "Tiwari Group", requested: 8, pending: 6, date: "2026-09-08", wholeOnly: false },
    ],
    reassignable: [],
  }, {
    // Nothing free and nothing to move: hidden while "Only SKUs with stock" is on.
    skuCode: "999Z.10",
    brand: "Koken",
    available: 0,
    indents: [
      { id: "i3", reservationId: "RES-3", indentNumber: "PI-2026-000101", bookingId: "BO-2026-000101", poNumber: "PO-ZZ-0099", customer: "Zenith Autos", customerName: "Zenith Autos", company: "Zenith Motors", requested: 4, pending: 4, date: "2026-10-01", wholeOnly: false },
    ],
    reassignable: [],
  }],
};

const searchBox = () => screen.getByLabelText("Search indents");
const type = (value) => fireEvent.change(searchBox(), { target: { value } });

describe("Indent Stock Assignment", () => {
  beforeEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
    api.indentAssignmentQueue.mockResolvedValue(queue);
  });

  test("lists the waiting indents, oldest first, with the free stock", async () => {
    render(<IndentAssignment />);
    expect(await screen.findByText("Nikita Traders")).toBeTruthy();
    expect(screen.getByText("5 free")).toBeTruthy();
    expect(screen.getByText("next in FIFO")).toBeTruthy();
    expect(screen.getByText("Arriving stock is held for assignment")).toBeTruthy();
  });

  test("assigns the typed quantity to a chosen indent", async () => {
    api.assignToIndent.mockResolvedValue({ orderId: "BO-2026-000072", quantity: 3 });
    render(<IndentAssignment />);
    await screen.findByText("PT Enterprises");

    const input = screen.getByLabelText("Quantity for PT Enterprises");
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.click(screen.getAllByRole("button", { name: /Assign$/ })[1]);

    await waitFor(() => expect(api.assignToIndent).toHaveBeenCalledWith("i2", 3));
    await waitFor(() => expect(api.indentAssignmentQueue).toHaveBeenCalledTimes(2), "refreshes after");
  });

  test("will not offer more than is free", async () => {
    render(<IndentAssignment />);
    await screen.findByText("Nikita Traders");
    const input = screen.getByLabelText("Quantity for Nikita Traders");
    expect(input.value).toBe("5"); // capped at what is free, not the 48 it waits for
    fireEvent.change(input, { target: { value: "6" } });
    expect(screen.getAllByRole("button", { name: /Assign$/ })[0].disabled).toBe(true);
  });

  test("Auto-assign runs FIFO for the SKU", async () => {
    api.autoAssignIndents.mockResolvedValue({ booked: 1, bookings: 1 });
    render(<IndentAssignment />);
    await screen.findByText("Nikita Traders");
    fireEvent.click(screen.getByRole("button", { name: /Auto-assign \(FIFO\)/ }));
    await waitFor(() => expect(api.autoAssignIndents).toHaveBeenCalledWith(["183H.35-8"]));
  });

  test("only users who configure inventory see the mode switch", async () => {
    render(<IndentAssignment />);
    await screen.findByText("Nikita Traders");
    expect(screen.queryByText(/Switch to automatic/)).toBeNull();
  });

  test("shows each indent's PO number, and a dash until one is raised", async () => {
    render(<IndentAssignment />);
    await screen.findByText("Nikita Traders");
    expect(screen.getByRole("columnheader", { name: "PO Number" })).toBeTruthy();
    const nikita = screen.getByText("Nikita Traders").closest("tr");
    expect(within(nikita).getByText("PO-NT-4471")).toBeTruthy();
    const pt = screen.getByText("PT Enterprises").closest("tr");
    expect(within(pt).getByTitle("No PO raised yet").textContent).toBe("—");
  });

  test("shows each indent's customer name and company in their own columns", async () => {
    render(<IndentAssignment />);
    await screen.findByText("Nikita Traders");
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers.slice(0, 4)).toEqual(["Customer Name", "Company Name", "Indent", "PO Number"]);

    const [name, company, , po] = within(screen.getByText("Nikita Traders").closest("tr")).getAllByRole("cell");
    expect(name.textContent).toBe("Nikita Tradersnext in FIFO");
    expect(company.textContent).toBe("NT Pvt Ltd");
    expect(po.textContent).toBe("PO-NT-4471");
    const pt = within(screen.getByText("PT Enterprises").closest("tr")).getAllByRole("cell");
    expect(pt[1].textContent).toBe("Tiwari Group");
  });

  test("a customer with no name shows a dash, never the company in its place", async () => {
    api.indentAssignmentQueue.mockResolvedValue({
      ...queue,
      skus: [{
        ...queue.skus[0],
        indents: [
          { ...queue.skus[0].indents[0], customer: "Om Motors", customerName: null, company: "Om Motors" },
          { ...queue.skus[0].indents[1], customer: "PT Enterprises", company: null },
        ],
      }],
    });
    render(<IndentAssignment />);
    await screen.findByText("Om Motors");
    const [omName, omCompany] = within(screen.getByText("Om Motors").closest("tr")).getAllByRole("cell");
    expect(within(omName).getByTitle("No customer name on this account").textContent).toBe("—");
    expect(omCompany.textContent).toBe("Om Motors");
    const pt = within(screen.getByText("PT Enterprises").closest("tr")).getAllByRole("cell");
    expect(within(pt[1]).getByTitle("No company on this account").textContent).toBe("—");
  });

  describe("search", () => {
    test("one box searches all four: customer name, company name, PO number and booking number", async () => {
      render(<IndentAssignment />);
      await screen.findByText("Nikita Traders");
      const finds = (q, shown, hidden) => {
        type(q);
        expect(screen.getByText(shown)).toBeTruthy();
        expect(screen.queryByText(hidden)).toBeNull();
      };
      finds("niKITA tr", "Nikita Traders", "PT Enterprises"); // customer name
      finds("TIWARI", "PT Enterprises", "Nikita Traders"); // company name
      finds("nt-4471", "Nikita Traders", "PT Enterprises"); // PO number
      finds("bo-2026-000072", "PT Enterprises", "Nikita Traders"); // booking number

      // Results follow the typing; pressing Enter changes nothing.
      fireEvent.keyDown(searchBox(), { key: "Enter" });
      expect(searchBox().value).toBe("bo-2026-000072");
      expect(screen.getByText("PT Enterprises")).toBeTruthy();
    });

    test("an indent missing some fields is still found by the others, and never by a blank", async () => {
      api.indentAssignmentQueue.mockResolvedValue({
        ...queue,
        skus: [{
          ...queue.skus[0],
          indents: [
            queue.skus[0].indents[0],
            // Standalone: no booking, no PO, and no name or company on the account.
            { ...queue.skus[0].indents[1], indentNumber: null, reservationId: "RES-77", bookingId: null, poNumber: null, customer: "rao@example.com", customerName: null, company: null },
          ],
        }],
      });
      render(<IndentAssignment />);
      await screen.findByText("RES-77");

      type("res-77");
      expect(screen.getByText("RES-77")).toBeTruthy();
      expect(screen.queryByText("Nikita Traders")).toBeNull();

      type("nikita");
      expect(screen.getByText("Nikita Traders")).toBeTruthy();
      expect(screen.queryByText("RES-77")).toBeNull();

      // A missing field is skipped, not read as the text "null".
      for (const q of ["null", "undefined", "tiwari"]) {
        type(q);
        expect(screen.getByText(`No waiting indent matches “${q}”.`)).toBeTruthy();
      }
    });

    test("extra spaces in a stored name, or in the search, still match", async () => {
      api.indentAssignmentQueue.mockResolvedValue({
        ...queue,
        skus: [{
          ...queue.skus[0],
          indents: [
            { ...queue.skus[0].indents[0], customerName: "Sharma  Auto Parts", company: "SAP Group" },
            queue.skus[0].indents[1],
          ],
        }],
      });
      render(<IndentAssignment />);
      await screen.findByText("PT Enterprises");

      type("  sharma   auto parts ");
      expect(screen.getByText("Sharma Auto Parts")).toBeTruthy();
      expect(screen.queryByText("PT Enterprises")).toBeNull();

      type("sap group");
      expect(screen.getByText("SAP Group")).toBeTruthy();
      expect(screen.queryByText("PT Enterprises")).toBeNull();
    });

    test("by company name: full, partial and in any case", async () => {
      render(<IndentAssignment />);
      await screen.findByText("Nikita Traders");

      type("Tiwari Group");
      expect(screen.getByText("PT Enterprises")).toBeTruthy();
      expect(screen.queryByText("Nikita Traders")).toBeNull();
      expect(screen.getByRole("status").textContent).toMatch(/1 indent in 1 SKU match “Tiwari Group”/);

      type("nt pvt");
      expect(screen.getByText("Nikita Traders")).toBeTruthy();
      expect(screen.getByText("NT Pvt Ltd")).toBeTruthy();
      // ...with the PO number column alongside.
      expect(screen.getByText("PO-NT-4471")).toBeTruthy();
      expect(screen.queryByText("PT Enterprises")).toBeNull();
    });

    test("by customer name: partial and in any case", async () => {
      render(<IndentAssignment />);
      await screen.findByText("Nikita Traders");
      type("pt enter");
      expect(screen.getByText("PT Enterprises")).toBeTruthy();
      expect(screen.queryByText("Nikita Traders")).toBeNull();
    });

    test("an unmatched customer or company finds nothing", async () => {
      render(<IndentAssignment />);
      await screen.findByText("Nikita Traders");
      type("Acme Holdings");
      expect(screen.getByText("No waiting indent matches “Acme Holdings”.")).toBeTruthy();
      expect(screen.queryByText("Nikita Traders")).toBeNull();
      expect(screen.queryByText("PT Enterprises")).toBeNull();
    });

    test("a company whose SKU has no free stock is offered too", async () => {
      render(<IndentAssignment />);
      await screen.findByText("Nikita Traders");
      type("zenith motors");
      fireEvent.click(screen.getByRole("button", { name: "Include SKUs with no stock (1)" }));
      expect(screen.getByText("Zenith Motors")).toBeTruthy();
      expect(screen.getByText("PO-ZZ-0099")).toBeTruthy();
    });

    test("by full PO number: only the matching indent is listed", async () => {
      render(<IndentAssignment />);
      await screen.findByText("Nikita Traders");
      type("PO-NT-4471");
      expect(screen.getByText("Nikita Traders")).toBeTruthy();
      expect(screen.queryByText("PT Enterprises")).toBeNull();
      expect(screen.getByText("1 of 2 waiting indents match")).toBeTruthy();
      expect(screen.getByRole("status").textContent).toMatch(/1 indent in 1 SKU match “PO-NT-4471”/);
    });

    test("by partial PO number, in any case", async () => {
      render(<IndentAssignment />);
      await screen.findByText("Nikita Traders");
      type("nt-44");
      expect(screen.getByText("Nikita Traders")).toBeTruthy();
      expect(screen.queryByText("PT Enterprises")).toBeNull();
    });

    test("'Show all' brings back the rest of the queue; FIFO stays the whole queue's", async () => {
      render(<IndentAssignment />);
      await screen.findByText("Nikita Traders");
      type("PT Ent");
      expect(screen.queryByText("Nikita Traders")).toBeNull();
      // PT Enterprises is second in line, so it is not labelled next in FIFO.
      expect(screen.queryByText("next in FIFO")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Show all 2" }));
      expect(screen.getByText("Nikita Traders")).toBeTruthy();
      expect(screen.getByText("next in FIFO")).toBeTruthy();
      expect(screen.getByText("PT Enterprises").closest("tr").className).toMatch(/bg-primary-50/);

      fireEvent.click(screen.getByRole("button", { name: "Show matches only" }));
      expect(screen.queryByText("Nikita Traders")).toBeNull();
    });

    test("a PO whose SKU has no free stock is offered rather than reported missing", async () => {
      render(<IndentAssignment />);
      await screen.findByText("Nikita Traders");
      type("po-zz");
      expect(screen.getByText("No waiting indent matches “po-zz”.")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Include SKUs with no stock (1)" }));
      expect(screen.getByText("Zenith Autos")).toBeTruthy();
      expect(screen.getByText("PO-ZZ-0099")).toBeTruthy();
      expect(screen.getByLabelText("Only SKUs with stock to assign or move").checked).toBe(false);
    });

    test("an unmatched term says so, and clearing it restores the list", async () => {
      render(<IndentAssignment />);
      await screen.findByText("Nikita Traders");
      type("PO-DOES-NOT-EXIST");
      expect(screen.getByText("No waiting indent matches “PO-DOES-NOT-EXIST”.")).toBeTruthy();
      expect(screen.queryByText("Nikita Traders")).toBeNull();

      // The box's × and the empty state's button do the same; use the latter.
      const clears = screen.getAllByRole("button", { name: "Clear search" });
      expect(clears).toHaveLength(2);
      fireEvent.click(clears[1]);
      expect(searchBox().value).toBe("");
      expect(screen.getByText("Nikita Traders")).toBeTruthy();
      expect(screen.getByText("PT Enterprises")).toBeTruthy();
    });

    test("the box's clear button empties it", async () => {
      render(<IndentAssignment />);
      await screen.findByText("Nikita Traders");
      type("nikita");
      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
      expect(searchBox().value).toBe("");
      expect(screen.getByText("PT Enterprises")).toBeTruthy();
    });

    test("the existing searches still work: SKU code, customer, indent and booking id", async () => {
      render(<IndentAssignment />);
      await screen.findByText("Nikita Traders");

      // A SKU match shows the SKU's whole queue.
      type("183h");
      expect(screen.getByText("Nikita Traders")).toBeTruthy();
      expect(screen.getByText("PT Enterprises")).toBeTruthy();
      expect(screen.queryByText(/waiting indents match/)).toBeNull();

      type("nikita");
      expect(screen.getByText("Nikita Traders")).toBeTruthy();
      expect(screen.queryByText("PT Enterprises")).toBeNull();

      type("PI-2026-000072");
      expect(screen.getByText("PT Enterprises")).toBeTruthy();
      expect(screen.queryByText("Nikita Traders")).toBeNull();

      type("bo-2026-000009");
      expect(screen.getByText("Nikita Traders")).toBeTruthy();
      expect(screen.queryByText("PT Enterprises")).toBeNull();
    });

    test("Escape clears the box", async () => {
      render(<IndentAssignment />);
      await screen.findByText("Nikita Traders");
      type("nikita");
      fireEvent.keyDown(searchBox(), { key: "Escape" });
      expect(searchBox().value).toBe("");
      expect(screen.getByText("PT Enterprises")).toBeTruthy();
    });
  });

  test("a revisit shows the last queue at once and still re-reads it from the server", async () => {
    const first = render(<IndentAssignment />);
    expect(await screen.findByText("Nikita Traders")).toBeTruthy();
    first.unmount();

    let release;
    api.indentAssignmentQueue.mockImplementation(() => new Promise((r) => { release = () => r(queue); }));
    render(<IndentAssignment />);
    // No blank page while the queue is re-validated...
    expect(screen.getByText("Nikita Traders")).toBeTruthy();
    expect(screen.getByText("Refreshing…")).toBeTruthy();
    // ...but it IS re-validated: stock decisions are never made on the cached copy alone.
    await waitFor(() => expect(api.indentAssignmentQueue).toHaveBeenCalledTimes(2));
    release();
  });
});
