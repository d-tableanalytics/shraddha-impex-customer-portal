import { describe, test, expect } from "vitest";

import { isMultipleOf, moqError } from "./moq";

/**
 * The browser's copy of the Multiple rule (formerly MOQ) — quantities in
 * multiples of the product's Multiple. Must agree with backend/utils/moq.js.
 */
describe("Multiple", () => {
  test("isMultipleOf", () => {
    expect(isMultipleOf(20, 10)).toBe(true);
    expect(isMultipleOf(15, 10)).toBe(false);
    expect(isMultipleOf(0, 10)).toBe(false);
    expect(isMultipleOf(7, 1)).toBe(true);
    expect(isMultipleOf(7, 0)).toBe(true);
  });

  test("the message names the Multiple and gives examples", () => {
    const customer = { role: "Customer", email: "buyer@acme.com" };
    expect(moqError(customer, { moq: 6 }, 12)).toBeNull();
    expect(moqError(customer, { moq: 6 }, 10)).toBe("Quantity must be a multiple of 6 (e.g. 6, 12, 18).");
  });
});
