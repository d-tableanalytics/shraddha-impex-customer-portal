import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../services/inventory", () => ({
  inventoryApi: {
    getAdjustmentPreview: vi.fn(),
    adjustStock: vi.fn(),
    getSkuPricing: vi.fn(),
    updateSkuPricing: vi.fn(),
  },
}));

import { inventoryApi } from "../../services/inventory";
import { UpdateStockModal } from "./UpdateStockModal";

/**
 * DEF-P13: switching between the Stock and Pricing tabs must not throw away
 * what was typed on either side.
 */

beforeEach(() => {
  vi.clearAllMocks();
  inventoryApi.getAdjustmentPreview.mockResolvedValue({
    skuCode: "K-1", brand: "Koken", locationCode: "MAIN", balance: { onHand: 40, reserved: 0 },
  });
  inventoryApi.getSkuPricing.mockResolvedValue({
    skuCode: "K-1", brand: "Koken", currency: "INR",
    priceTypes: [{ key: "trader", label: "Trader", description: "Trade rate" }],
    prices: { trader: 100 },
  });
});

const open = () => render(
  <UpdateStockModal open skuCode="K-1" brand="Koken" canAdjust canPrice onClose={vi.fn()} />,
);

describe("UpdateStockModal tabs", () => {
  test("edits on both tabs survive switching back and forth", async () => {
    open();
    const stockInput = await screen.findByDisplayValue("40");
    fireEvent.change(stockInput, { target: { value: "55" } });

    fireEvent.click(screen.getByRole("tab", { name: "Pricing" }));
    const priceInput = await screen.findByDisplayValue("100");
    fireEvent.change(priceInput, { target: { value: "125" } });

    fireEvent.click(screen.getByRole("tab", { name: "Stock" }));
    expect(screen.getByDisplayValue("55")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Pricing" }));
    expect(screen.getByDisplayValue("125")).toBeTruthy();

    // Each side was read once, not on every switch.
    await waitFor(() => expect(inventoryApi.getAdjustmentPreview).toHaveBeenCalledTimes(1));
    expect(inventoryApi.getSkuPricing).toHaveBeenCalledTimes(1);
  });

  test("closing and reopening starts fresh", async () => {
    const { rerender } = open();
    const stockInput = await screen.findByDisplayValue("40");
    fireEvent.change(stockInput, { target: { value: "55" } });

    rerender(<UpdateStockModal open={false} skuCode="K-1" brand="Koken" canAdjust canPrice onClose={vi.fn()} />);
    rerender(<UpdateStockModal open skuCode="K-1" brand="Koken" canAdjust canPrice onClose={vi.fn()} />);
    expect(await screen.findByDisplayValue("40")).toBeTruthy();
    expect(inventoryApi.getAdjustmentPreview).toHaveBeenCalledTimes(2);
  });
});
