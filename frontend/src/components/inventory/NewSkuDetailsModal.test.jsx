import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import { NewSkuDetailsModal, isNewSkuAnswered } from "./NewSkuDetailsModal";

/**
 * The new-SKU pop-up of an inventory import: only Brand and Available Stock are
 * mandatory; MOQ, Lead Time, Safety Factor and Box Number may be left blank.
 */
describe("isNewSkuAnswered", () => {
  test("Brand and Available Stock are enough", () => {
    expect(isNewSkuAnswered({ brand: "Koken", availableStock: "0" })).toBe(true);
  });
  test("either one missing is not", () => {
    expect(isNewSkuAnswered({ brand: "Koken", availableStock: "" })).toBe(false);
    expect(isNewSkuAnswered({ brand: "", availableStock: "5", moq: "10", leadTime: "4", safetyFactor: "1", boxNo: "B" })).toBe(false);
  });
  test("an optional field that is filled in must be valid", () => {
    expect(isNewSkuAnswered({ brand: "Koken", availableStock: "5", moq: "0" })).toBe(false);
    expect(isNewSkuAnswered({ brand: "Koken", availableStock: "5", leadTime: "45" })).toBe(true);
  });
});

describe("NewSkuDetailsModal", () => {
  const sku = { skuCode: "NEW-1", brand: "Koken", availableStock: null };

  test("marks only Brand and Available Stock as required", () => {
    render(<NewSkuDetailsModal isOpen jobId="J1" skus={[sku]} brands={["Koken", "BIX"]} onSave={vi.fn()} onClose={vi.fn()} />);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toContain("Brand *");
    expect(headers).toContain("Available Stock *");
    for (const optional of ["Multiple", "Lead Time", "Safety Factor", "Box Number"]) {
      expect(headers).toContain(`${optional}Optional`);
    }
  });

  test("saves with only the stock typed in, sending the optional fields blank", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true, applied: [{ skuCode: "NEW-1" }], ready: true });
    render(<NewSkuDetailsModal isOpen jobId="J1" skus={[sku]} brands={["Koken"]} onSave={onSave} onClose={vi.fn()} />);

    const save = screen.getByRole("button", { name: /Save/ });
    expect(save.disabled).toBe(true); // stock not given yet
    fireEvent.change(screen.getByLabelText("Available Stock for NEW-1"), { target: { value: "12" } });
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([{
      skuCode: "NEW-1", brand: "Koken", availableStock: "12", moq: "", leadTime: "", safetyFactor: "", boxNo: "",
    }]));
  });
});
