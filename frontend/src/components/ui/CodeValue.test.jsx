import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { CodeValue } from "./CodeValue";

/**
 * The bug this component exists for is a SILENT one: a truncated SKU looks like
 * a complete SKU. So the assertions below are about the whole value being in
 * the DOM and about the classes that let it wrap — a test that only checked
 * "renders the code" would pass against the `truncate` this replaced.
 */
describe("CodeValue", () => {
  const LONG = "9031A-KT-4512-XL-REV2-2026-IMPORT";

  test("renders the complete value, however long", () => {
    render(<CodeValue value={LONG} />);
    // Exact match, not substring: `truncate` would still contain the prefix.
    expect(screen.getByText(LONG)).toBeTruthy();
  });

  test("wraps rather than truncating", () => {
    const { container } = render(<CodeValue value={LONG} />);
    const el = container.querySelector("span");

    expect(el.className).toContain("break-all");
    // The precise failure being guarded: `truncate` shows an ellipsis and two
    // different parts become indistinguishable.
    expect(el.className).not.toContain("truncate");
  });

  test("carries the full value as a title for hover and copy", () => {
    render(<CodeValue value={LONG} />);
    expect(screen.getByText(LONG).getAttribute("title")).toBe(LONG);
  });

  test("uses tabular figures so stacked codes line up", () => {
    const { container } = render(<CodeValue value={LONG} />);
    expect(container.querySelector("span").className).toContain("tabular-nums");
  });

  test("shows a placeholder for an empty value instead of an empty cell", () => {
    render(<CodeValue value={null} />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  test("treats an empty string as absent, not as a code", () => {
    render(<CodeValue value="" />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  test("renders a numeric code rather than dropping it", () => {
    // `value={0}` is falsy — a `value || placeholder` implementation would
    // render a dash for a real code.
    render(<CodeValue value={0} />);
    expect(screen.getByText("0")).toBeTruthy();
  });
});
