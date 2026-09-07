/**
 * The pagination bar, and a structural guard on how it is CALLED.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists
 * ---------------------------------------------------------------------------
 * `Pagination` takes `page` / `pageSize` / `totalItems`. Six HRMS call sites
 * were passing `currentPage` / `totalPages` instead — prop names it does not
 * declare. `totalItems` was therefore `undefined`, and the component rendered
 *
 *     Showing NaN to NaN of NaN results
 *
 * with dead controls, because `Math.ceil(undefined / undefined)` is NaN and
 * every comparison against NaN is false. Nothing caught it: no test asserted
 * the bar's contents, React does not type-check props, and a JSX attribute the
 * component ignores is not an error anywhere in the toolchain.
 *
 * Two guards, because either one alone would have missed it:
 *
 *   1. BEHAVIOURAL — the bar renders a real range, and never the string "NaN",
 *      including at the boundaries that produce it (zero rows, one page).
 *   2. STRUCTURAL — no file in the tree passes the wrong prop names. This is
 *      the one that actually prevents a recurrence: a new screen written by
 *      copying an old one cannot reintroduce the bug without failing here.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pagination } from "./Pagination";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// 1. Behaviour
// ---------------------------------------------------------------------------

describe("Pagination", () => {
  it("renders the real range for a middle page", () => {
    render(<Pagination page={3} pageSize={25} totalItems={120} onPageChange={() => {}} />);

    expect(screen.getByText("51")).toBeTruthy();
    expect(screen.getByText("75")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("renders a sane range when there is nothing at all", () => {
    const { container } = render(
      <Pagination page={1} pageSize={25} totalItems={0} onPageChange={() => {}} />,
    );
    expect(container.textContent).not.toContain("NaN");
    expect(container.textContent).toContain("0");
  });

  it("renders a sane range on the last, partial page", () => {
    const { container } = render(
      <Pagination page={5} pageSize={25} totalItems={101} onPageChange={() => {}} />,
    );
    expect(container.textContent).not.toContain("NaN");
    // Page 5 of 25 is the single row 101, so "101" is the range start, the
    // range end AND the total. All three are correct; none is NaN.
    expect(screen.getAllByText("101").length).toBe(3);
  });

  /**
   * The exact failure mode, reproduced deliberately. If somebody ever "fixes"
   * the component by making it accept `currentPage`, this test says what the
   * contract is — and the structural guard below says which one to use.
   */
  it("produces NaN when given the WRONG prop names — which is why the guard below exists", () => {
    const { container } = render(
      // eslint-disable-next-line react/no-unknown-property
      <Pagination currentPage={3} totalPages={5} onPageChange={() => {}} />,
    );
    expect(container.textContent).toContain("NaN");
  });
});

// ---------------------------------------------------------------------------
// 2. Structure
// ---------------------------------------------------------------------------

/** Every .jsx/.js under src/, minus node_modules and this file. */
function sourceFiles(dir = SRC, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.(jsx?|tsx?)$/.test(entry) && !full.endsWith("Pagination.test.jsx")) found.push(full);
  }
  return found;
}

describe("every Pagination call site uses the declared contract", () => {
  it("no file passes currentPage or totalPages", () => {
    const offenders = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("<Pagination")) continue;
      if (/\bcurrentPage=/.test(source) || /\btotalPages=/.test(source)) {
        offenders.push(path.relative(SRC, file).replace(/\\/g, "/"));
      }
    }

    expect(
      offenders,
      `Pagination takes page / pageSize / totalItems. These pass currentPage or totalPages, ` +
        `which renders "Showing NaN to NaN of NaN":\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every call site passes totalItems", () => {
    const offenders = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      // Each <Pagination …/> element, non-greedy up to its closing slash.
      for (const [element] of source.matchAll(/<Pagination[\s\S]*?\/>/g)) {
        if (!/\btotalItems=/.test(element)) {
          offenders.push(path.relative(SRC, file).replace(/\\/g, "/"));
        }
      }
    }

    expect(
      offenders,
      `totalItems is what the range and the page count are computed from; without it both are NaN:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
