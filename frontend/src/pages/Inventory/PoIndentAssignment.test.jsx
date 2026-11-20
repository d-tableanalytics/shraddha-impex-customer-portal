import { describe, test, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const api = vi.hoisted(() => ({
  indentAssignmentQueue: vi.fn(),
  autoAssignIndents: vi.fn(),
  assignToIndent: vi.fn(),
  reassignAllocation: vi.fn(),
  assignPoIndents: vi.fn(),
  setIndentAssignmentMode: vi.fn(),
}));
vi.mock("../../services/inventory", () => ({ inventoryApi: api }));

const userState = vi.hoisted(() => ({ user: { role: "Sales", permissions: ["assign_indent_stock"] } }));
vi.mock("../../store/userStore", () => ({ useUserStore: () => userState }));

import { IndentAssignment } from "./IndentAssignment";
import { groupIndentsByPo } from "./PoIndentAssignment";
import { queryClient } from "../../lib/queryClient";

const render = (ui) => rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

/**
 * One queue, as the server sends it: two indents share PO-NT-4471 on a SKU
 * with 5 free (so the older one takes all five and the newer gets nothing),
 * one indent has no PO at all, and PO-ZZ-0099's SKU has nothing free.
 */
const queue = {
  mode: "manual",
  skus: [{
    skuCode: "183H.35-8",
    brand: "Koken",
    available: 5,
    indents: [
      { id: "i1", reservationId: "RES-1", indentNumber: "PI-2026-000009", bookingId: "BO-2026-000009", poNumber: "PO-NT-4471", customer: "Nikita Traders", customerName: "Nikita Traders", company: "NT Pvt Ltd", requested: 50, pending: 48, date: "2026-08-21", wholeOnly: false },
      { id: "i2", reservationId: "RES-2", indentNumber: "PI-2026-000040", bookingId: "BO-2026-000040", poNumber: "PO-NT-4471", customer: "Nikita Traders", customerName: "Nikita Traders", company: "NT Pvt Ltd", requested: 10, pending: 3, date: "2026-09-02", wholeOnly: false },
      { id: "i3", reservationId: "RES-3", indentNumber: "PI-2026-000072", bookingId: "BO-2026-000072", poNumber: null, customer: "PT Enterprises", customerName: "PT Enterprises", company: "Tiwari Group", requested: 8, pending: 6, date: "2026-09-08", wholeOnly: false },
    ],
    reassignable: [],
  }, {
    skuCode: "999Z.10",
    brand: "Koken",
    available: 0,
    indents: [
      { id: "i4", reservationId: "RES-4", indentNumber: "PI-2026-000101", bookingId: "BO-2026-000101", poNumber: "PO-ZZ-0099", customer: "Zenith Autos", customerName: "Zenith Autos", company: "Zenith Motors", requested: 4, pending: 4, date: "2026-10-01", wholeOnly: false },
    ],
    reassignable: [],
  }],
};

const openPoTab = async () => {
  render(<IndentAssignment />);
  await screen.findByText("PI-2026-000009");
  fireEvent.click(screen.getByRole("tab", { name: /PO-wise/ }));
  return screen.findByText("PO-NT-4471");
};

describe("PO-wise Indent Stock Assignment", () => {
  beforeEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
    api.indentAssignmentQueue.mockResolvedValue(queue);
  });

  describe("the individual view is untouched", () => {
    test("it is what the screen opens on, with its own toolbar and rows", async () => {
      render(<IndentAssignment />);
      expect(await screen.findByText("PI-2026-000009")).toBeTruthy();
      expect(screen.getByRole("tab", { name: /Individual/ }).getAttribute("aria-selected")).toBe("true");
      expect(screen.getByLabelText("Search indents")).toBeTruthy();
      expect(screen.getByText("5 free")).toBeTruthy();
      expect(screen.getByText("next in FIFO")).toBeTruthy();
    });

    test("switching to PO-wise and back leaves it as it was", async () => {
      await openPoTab();
      expect(screen.queryByLabelText("Search indents")).toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: /Individual/ }));
      expect(await screen.findByText("next in FIFO")).toBeTruthy();
      expect(screen.getByLabelText("Search indents")).toBeTruthy();
    });

    test("the queue is read once for both views", async () => {
      await openPoTab();
      expect(api.indentAssignmentQueue).toHaveBeenCalledTimes(1);
    });
  });

  describe("the PO-wise view", () => {
    test("lists the POs with their customer, counts and what is assignable now", async () => {
      await openPoTab();
      const card = screen.getByText("PO-NT-4471").closest("button");
      expect(within(card).getByText("Nikita Traders")).toBeTruthy();
      expect(within(card).getByText("NT Pvt Ltd")).toBeTruthy();
      expect(within(card).getByText(/2 indents · 1 SKU · waiting for 51/)).toBeTruthy();
      expect(within(card).getByText("5 assignable now")).toBeTruthy();
    });

    test("a PO with nothing free is hidden until the filter is cleared", async () => {
      await openPoTab();
      expect(screen.queryByText("PO-ZZ-0099")).toBeNull();
      fireEvent.click(screen.getByLabelText(/Only POs with stock to assign/));
      expect(await screen.findByText("PO-ZZ-0099")).toBeTruthy();
      const card = screen.getByText("PO-ZZ-0099").closest("button");
      expect(within(card).getByText("nothing free")).toBeTruthy();
    });

    test("an indent with no PO yet is counted, not invented into a group", async () => {
      await openPoTab();
      expect(screen.queryByText("PI-2026-000072")).toBeNull();
      expect(screen.getByText(/1 waiting indent has no PO yet/)).toBeTruthy();
    });

    test("clicking a PO shows every indent under it", async () => {
      await openPoTab();
      expect(screen.queryByText("PI-2026-000009")).toBeNull();
      fireEvent.click(screen.getByText("PO-NT-4471"));
      expect(await screen.findByText("PI-2026-000009")).toBeTruthy();
      expect(screen.getByText("PI-2026-000040")).toBeTruthy();
      expect(screen.getByText("BO-2026-000009")).toBeTruthy();
    });

    test("assigns every indent on the PO in one click, after confirming", async () => {
      api.assignPoIndents.mockResolvedValue({
        poNumber: "PO-NT-4471", indents: 2, units: 5,
        assigned: [{ indent: "PI-2026-000009", indentId: "i1", skuCode: "183H.35-8", quantity: 5, orderId: "BO-2026-000009" }],
        skipped: [{ indent: "PI-2026-000040", indentId: "i2", skuCode: "183H.35-8", reason: "No 183H.35-8 stock is free." }],
      });
      await openPoTab();

      fireEvent.click(screen.getByRole("button", { name: /Assign all \(1\)/ }));
      expect(await screen.findByText(/Assign all indents under PO-NT-4471\?/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Assign all" }));

      await waitFor(() => expect(api.assignPoIndents).toHaveBeenCalledWith("PO-NT-4471"));
    });

    test("what could not be assigned is spelled out with its reason", async () => {
      api.assignPoIndents.mockResolvedValue({
        poNumber: "PO-NT-4471", indents: 2, units: 5,
        assigned: [{ indent: "PI-2026-000009", indentId: "i1", skuCode: "183H.35-8", quantity: 5, orderId: "BO-2026-000009" }],
        skipped: [{ indent: "PI-2026-000040", indentId: "i2", skuCode: "183H.35-8", reason: "No 183H.35-8 stock is free." }],
      });
      await openPoTab();
      fireEvent.click(screen.getByRole("button", { name: /Assign all \(1\)/ }));
      fireEvent.click(await screen.findByRole("button", { name: "Assign all" }));

      expect(await screen.findByText(/1 indent\(s\) assigned; 1 left waiting/)).toBeTruthy();
      expect(screen.getByText(/No 183H.35-8 stock is free\./)).toBeTruthy();
    });

    test("the PO just run stays on screen with its report, even with nothing left free", async () => {
      // The run takes the last free unit, so the PO has nothing assignable
      // afterwards — the filter must not hide the reason it left one waiting.
      api.assignPoIndents.mockResolvedValue({
        poNumber: "PO-NT-4471", indents: 2, units: 5,
        assigned: [{ indent: "PI-2026-000009", indentId: "i1", skuCode: "183H.35-8", quantity: 5, orderId: "BO-2026-000009" }],
        skipped: [{ indent: "PI-2026-000040", indentId: "i2", skuCode: "183H.35-8", reason: "No 183H.35-8 stock is free." }],
      });
      api.indentAssignmentQueue.mockResolvedValueOnce(queue).mockResolvedValue({
        ...queue,
        skus: [{ ...queue.skus[0], available: 0, indents: [queue.skus[0].indents[1], queue.skus[0].indents[2]] }, queue.skus[1]],
      });
      await openPoTab();
      fireEvent.click(screen.getByRole("button", { name: /Assign all \(1\)/ }));
      fireEvent.click(await screen.findByRole("button", { name: "Assign all" }));

      await waitFor(() => expect(api.assignPoIndents).toHaveBeenCalled());
      expect(screen.getByText("PO-NT-4471")).toBeTruthy();
      expect(screen.getByText(/No 183H.35-8 stock is free\./)).toBeTruthy();
    });

    test("a PO can be found by number, customer, company or SKU", async () => {
      await openPoTab();
      const box = screen.getByLabelText("Search POs");
      fireEvent.change(box, { target: { value: "4471" } });
      expect(screen.getByText("PO-NT-4471")).toBeTruthy();

      fireEvent.change(box, { target: { value: "zenith" } });
      expect(screen.queryByText("PO-NT-4471")).toBeNull();
      expect(screen.getByText(/1 more PO with no stock to assign also match/)).toBeTruthy();
    });

    test("an unmatched search says so and can be cleared", async () => {
      await openPoTab();
      fireEvent.change(screen.getByLabelText("Search POs"), { target: { value: "nothing here" } });
      expect(screen.getByText(/No PO matches/)).toBeTruthy();
      // The box has a clear button of its own; this is the one in the empty state.
      const clear = screen.getAllByRole("button", { name: "Clear search" });
      fireEvent.click(clear[clear.length - 1]);
      expect(await screen.findByText("PO-NT-4471")).toBeTruthy();
    });
  });

  describe("grouping", () => {
    test("one SKU's free stock is shared out oldest first, never twice", () => {
      const { groups, withoutPo } = groupIndentsByPo(queue.skus);
      expect(withoutPo).toBe(1);

      const nt = groups.find((g) => g.poNumber === "PO-NT-4471");
      expect(nt.rows.map((r) => [r.indentNumber, r.willAssign])).toEqual([
        ["PI-2026-000009", 5],
        ["PI-2026-000040", 0],
      ]);
      expect(nt.units).toBe(5);
      expect(nt.ready).toBe(1);
      expect(nt.pending).toBe(51);
    });

    test("a PO whose SKU has nothing free offers nothing", () => {
      const { groups } = groupIndentsByPo(queue.skus);
      const zz = groups.find((g) => g.poNumber === "PO-ZZ-0099");
      expect(zz.units).toBe(0);
      expect(zz.ready).toBe(0);
      expect(zz.indentCount).toBe(1);
    });

    test("an indent that can only be taken whole takes all or nothing", () => {
      const { groups } = groupIndentsByPo([{
        skuCode: "X", brand: "Koken", available: 2, reassignable: [],
        indents: [{ id: "w1", indentNumber: "PI-W", poNumber: "PO-W", pending: 5, requested: 5, date: "2026-01-01", wholeOnly: true }],
      }]);
      expect(groups[0].units).toBe(0);
      expect(groups[0].rows[0].willAssign).toBe(0);
    });

    test("POs with stock to hand out are listed first", () => {
      const { groups } = groupIndentsByPo(queue.skus);
      expect(groups.map((g) => g.poNumber)).toEqual(["PO-NT-4471", "PO-ZZ-0099"]);
    });
  });
});
