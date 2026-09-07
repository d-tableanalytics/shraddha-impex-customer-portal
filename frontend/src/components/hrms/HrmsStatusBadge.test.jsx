/**
 * HrmsStatusBadge: every status it maps must reach a variant Badge implements.
 *
 * `rejected` and `suspended` were both mapped to `variant: "error"`. Badge has
 * no `error` variant — its red one is called `danger`, and only its Tailwind
 * PALETTE is named `error` (`bg-error-50`), which is how the wrong key got
 * written. `variants["error"]` is `undefined`, so `clsx` dropped it and the
 * pill rendered with the base styles alone: no background, no text colour, no
 * border colour. A rejected leave request looked the same as a neutral one.
 *
 * The generic test below is the one that matters. Asserting only that
 * `rejected` is red would still pass the next time somebody adds a status with
 * a variant name Badge does not have — which is exactly how this happened.
 */

import { describe, it, expect } from "vitest";
import { render, cleanup } from "@testing-library/react";

import { HrmsStatusBadge } from "./HrmsStatusBadge";

/** The variants Badge actually implements, and the background each applies. */
const BADGE_BACKGROUNDS = {
  primary: "bg-primary-50",
  success: "bg-success-50",
  warning: "bg-warning-50",
  danger: "bg-error-50",
  neutral: "bg-slate-50",
};

/** Every status HrmsStatusBadge claims to know. */
const MAPPED_STATUSES = [
  "invited",
  "active",
  "probation",
  "notice",
  "exited",
  "suspended",
  "inactive",
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "draft",
  "submitted",
  "completed",
  "in_progress",
];

/** Render one badge in isolation and hand back its element. */
function renderBadge(status) {
  cleanup();
  const { container } = render(<HrmsStatusBadge status={status} />);
  return container.querySelector("span");
}

describe("every mapped status gets a real Badge variant", () => {
  it.each(MAPPED_STATUSES)("%s renders with a background colour", (status) => {
    const el = renderBadge(status);
    const backgrounds = Object.values(BADGE_BACKGROUNDS);

    // A variant Badge does not implement yields `undefined`, which clsx drops —
    // leaving the base styles and no colour at all.
    expect(
      backgrounds.some((bg) => el.className.includes(bg)),
      `"${status}" rendered with no Badge background: ${el.className}`,
    ).toBe(true);
  });
});

describe("the statuses that were broken", () => {
  it("rejected renders in the danger palette", () => {
    const el = renderBadge("rejected");
    expect(el.className).toContain(BADGE_BACKGROUNDS.danger);
    expect(el.className).toContain("text-error-600");
    expect(el.textContent).toBe("Rejected");
  });

  it("suspended renders in the danger palette", () => {
    const el = renderBadge("suspended");
    expect(el.className).toContain(BADGE_BACKGROUNDS.danger);
    expect(el.textContent).toBe("Suspended");
  });
});

describe("the mappings that were already correct stay correct", () => {
  it.each([
    ["approved", "bg-success-50", "Approved"],
    ["active", "bg-success-50", "Active"],
    ["pending", "bg-warning-50", "Pending"],
    ["submitted", "bg-primary-50", "Submitted"],
    ["draft", "bg-slate-50", "Draft"],
    ["cancelled", "bg-slate-50", "Cancelled"],
  ])("%s keeps its variant", (status, background, label) => {
    const el = renderBadge(status);
    expect(el.className).toContain(background);
    expect(el.textContent).toBe(label);
  });
});

describe("unknown statuses", () => {
  it("fall back to neutral rather than to no colour at all", () => {
    const el = renderBadge("some_new_status");
    expect(el.className).toContain(BADGE_BACKGROUNDS.neutral);
    expect(el.textContent).toBe("Some New Status");
  });

  it("survive a null status", () => {
    const el = renderBadge(null);
    expect(el.className).toContain(BADGE_BACKGROUNDS.neutral);
    expect(el.textContent).toBe("Unknown");
  });

  it("are matched case-insensitively", () => {
    const el = renderBadge("REJECTED");
    expect(el.className).toContain(BADGE_BACKGROUNDS.danger);
    expect(el.textContent).toBe("Rejected");
  });
});
