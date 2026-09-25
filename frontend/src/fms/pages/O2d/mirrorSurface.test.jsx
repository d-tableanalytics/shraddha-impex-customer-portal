import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { StageTimeline, mirrorSurfaceOf } from "./o2dShared";

/**
 * Where an assigned stage's task actually turns up.
 *
 * Assigning a stage to a person mirrors it onto ONE Work Queue list — Checklist
 * when finishing the stage means recording evidence, the Delegation list when
 * it means making a decision. The timeline has to name that list, because the
 * question straight after "assigned to whom" is "where do they find it", and
 * "somewhere in their Work Queue" does not answer it.
 *
 * Read from the stage's own link fields, never recomputed from the stage
 * number: the server decided this when it created the mirror, and a second
 * opinion on the client could name a list the assignee is not looking at.
 */

const stage = (extra = {}) => ({
  stageNumber: 3,
  stageName: "Send SOR + PI to Customer",
  status: "IN_PROGRESS",
  ownerRole: "Billing",
  ...extra,
});

describe("mirrorSurfaceOf", () => {
  test("names Checklist when the stage carries a checklist occurrence", () => {
    expect(mirrorSurfaceOf(stage({ checklistOccurrenceId: "abc" }))).toBe("Checklist");
  });

  test("names the Delegation list when the stage carries a delegation", () => {
    expect(mirrorSurfaceOf(stage({ delegationId: "abc" }))).toBe("Delegation list");
  });

  test("falls back to the generic name when neither link is set", () => {
    expect(mirrorSurfaceOf(stage())).toBe("Work Queue");
    expect(mirrorSurfaceOf(undefined)).toBe("Work Queue");
  });

  test("prefers the checklist link, matching the server's own precedence", () => {
    // Both set at once should never reach the screen — `assignStageToUser`
    // writes one and nulls the other on every assignment. If a stale row ever
    // did carry both, the client must break the tie the same way
    // `mirrorRefOf` does, so the two sides cannot name different lists.
    expect(mirrorSurfaceOf(stage({ checklistOccurrenceId: "a", delegationId: "b" }))).toBe(
      "Checklist",
    );
  });
});

describe("the timeline's assignment line", () => {
  test("names the list a Checklist-mirrored stage landed on", () => {
    render(
      <StageTimeline
        stages={[stage({ assignedToName: "Priya Nair", checklistOccurrenceId: "abc" })]}
        currentStage={3}
      />,
    );

    expect(screen.getByText("Priya Nair")).toBeTruthy();
    expect(screen.getByText(/in their Checklist/)).toBeTruthy();
  });

  test("names the list a Delegation-mirrored stage landed on", () => {
    render(
      <StageTimeline
        stages={[stage({ stageNumber: 4, assignedToName: "Priya Nair", delegationId: "abc" })]}
        currentStage={4}
      />,
    );

    expect(screen.getByText(/in their Delegation list/)).toBeTruthy();
  });

  test("says nothing about a list when the stage is not assigned to anyone", () => {
    render(<StageTimeline stages={[stage()]} currentStage={3} />);

    expect(screen.queryByText(/in their/)).toBeNull();
  });
});
