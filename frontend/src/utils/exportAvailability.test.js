import { describe, test, expect, vi } from "vitest";

import {
  LOOKUP_CHUNK, UNKNOWN_AVAILABILITY, availabilityFor, buildAvailabilityIndex,
  fetchExportAvailability, skusForLines,
} from "./exportAvailability";

/**
 * Booking History's "Available Quantity" export column.
 *
 * It used to come from a catalogue download capped at 2,000 products per brand.
 * Ko-ken has more than 7,700, so every booked SKU past the first 2,000
 * alphabetically exported as "—" — 90 of 501 lines on the live data when this
 * was measured. These pin the replacement: only the exported SKUs are looked up,
 * in chunks the endpoint accepts, matched on SKU AND brand.
 */

/** A /products/lookup answer for the given codes, all found as Koken. */
const lookupAll = (brand = "Koken", available = (sku) => Number(sku.split("-")[1])) =>
  vi.fn(async (codes) => ({
    data: codes.map((sku) => ({ lookupCode: sku, skuCode: sku, found: true, brand, available: available(sku) })),
  }));

const line = (skuCode, brand = "Koken") => ({ skuCode, brand });

describe("export availability", () => {
  test("an export of more than 2,000 SKUs resolves every one of them", async () => {
    const lines = Array.from({ length: 6000 }, (_, i) => line(`SKU-${i + 1}`));
    const lookup = lookupAll();
    const index = await fetchExportAvailability(lines, lookup);

    // Split to the endpoint's cap rather than truncated at it.
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls.map(([codes]) => codes.length)).toEqual([LOOKUP_CHUNK, 1000]);
    // The SKUs the old 2,000-per-brand download dropped.
    expect(availabilityFor(index, line("SKU-2001"))).toBe(2001);
    expect(availabilityFor(index, line("SKU-6000"))).toBe(6000);
    expect(lines.every((l) => availabilityFor(index, l) !== UNKNOWN_AVAILABILITY)).toBe(true);
  });

  test("each SKU is asked for once, and placeholder lines not at all", () => {
    expect(skusForLines([line("A"), line("A"), line(" B "), { skuCode: "—" }, { skuCode: "" }, {}]))
      .toEqual(["A", "B"]);
  });

  test("nothing to look up means no request", async () => {
    const lookup = vi.fn();
    await fetchExportAvailability([{ skuCode: "—" }], lookup);
    expect(lookup).not.toHaveBeenCalled();
  });

  test("the same SKU under two brands reads each brand's own stock", () => {
    const index = buildAvailabilityIndex([
      { lookupCode: "X1", skuCode: "X1", found: true, brand: "Koken", available: 7 },
      { lookupCode: "X1", skuCode: "X1", found: true, brand: "BIX", available: 2 },
    ]);
    expect(availabilityFor(index, line("X1", "Koken"))).toBe(7);
    expect(availabilityFor(index, line("X1", "BIX"))).toBe(2);
    // Brand names are compared without regard to case.
    expect(availabilityFor(index, line("X1", "KOKEN"))).toBe(7);
  });

  test("a line never borrows another brand's stock", () => {
    // The endpoint returns one product per code; here it returned BIX's.
    const index = buildAvailabilityIndex([
      { lookupCode: "X1", skuCode: "X1", found: true, brand: "BIX", available: 2 },
    ]);
    expect(availabilityFor(index, line("X1", "Koken"))).toBe(UNKNOWN_AVAILABILITY);
  });

  test("a line with no brand is matched only when the SKU is unambiguous", () => {
    const one = buildAvailabilityIndex([{ lookupCode: "Y", skuCode: "Y", found: true, brand: "Koken", available: 4 }]);
    expect(availabilityFor(one, { skuCode: "Y" })).toBe(4);
    const two = buildAvailabilityIndex([
      { lookupCode: "Y", skuCode: "Y", found: true, brand: "Koken", available: 4 },
      { lookupCode: "Y", skuCode: "Y", found: true, brand: "BIX", available: 9 },
    ]);
    expect(availabilityFor(two, { skuCode: "Y" })).toBe(UNKNOWN_AVAILABILITY);
  });

  test("a product that does not exist (or is in a brand the user cannot see) reads —", () => {
    const index = buildAvailabilityIndex([{ lookupCode: "GONE", skuCode: "GONE", found: false }]);
    expect(availabilityFor(index, line("GONE"))).toBe(UNKNOWN_AVAILABILITY);
    expect(availabilityFor(index, line("NEVER-ASKED"))).toBe(UNKNOWN_AVAILABILITY);
  });

  test("a found product with no availability figure reads —, and zero reads 0", () => {
    const index = buildAvailabilityIndex([
      { lookupCode: "N", skuCode: "N", found: true, brand: "Koken" },
      { lookupCode: "Z", skuCode: "Z", found: true, brand: "Koken", available: 0 },
    ]);
    expect(availabilityFor(index, line("N"))).toBe(UNKNOWN_AVAILABILITY);
    expect(availabilityFor(index, line("Z"))).toBe(0);
  });

  test("a code that matched another product's MSIL code does not lend it that product's stock", () => {
    const index = buildAvailabilityIndex([
      { lookupCode: "M-100", skuCode: "SKU-REAL", found: true, brand: "Koken", available: 50 },
    ]);
    expect(availabilityFor(index, line("M-100"))).toBe(UNKNOWN_AVAILABILITY);
  });

  test("a failed lookup fails the export instead of writing blanks", async () => {
    const lookup = vi.fn().mockRejectedValue(new Error("down"));
    await expect(fetchExportAvailability([line("A")], lookup)).rejects.toThrow("down");
  });
});
