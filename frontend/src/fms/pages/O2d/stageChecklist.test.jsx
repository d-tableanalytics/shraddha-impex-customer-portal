import { describe, test, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";

import { StageTimeline, StageProgress, OrderStatusBadge } from "./o2dShared";
import { STAGE_STATUS } from "@shared/constants/o2d.js";

/**
 * The order's stages as a sequential checklist: completed, one active, the rest
 * locked — and only the active stage offers a Complete button.
 */
const STAGES = [
  { stageNumber: 1, stageName: "Receive Order", ownerRole: "Sales", status: STAGE_STATUS.DONE_ON_TIME },
  { stageNumber: 2, stageName: "Submit PO to Billing", ownerRole: "Sales", status: STAGE_STATUS.DONE_LATE, delayMinutes: 30 },
  { stageNumber: 3, stageName: "Send SOR + PI", ownerRole: "Billing", status: STAGE_STATUS.PENDING },
  { stageNumber: 4, stageName: "Advance Order Decision", ownerRole: "Billing", status: STAGE_STATUS.LOCKED },
  { stageNumber: 5, stageName: "Receive Advance", ownerRole: "Accounts", status: STAGE_STATUS.LOCKED },
];

const rows = () => screen.getAllByRole("listitem");
const stateOf = (n) => rows()[n - 1].getAttribute("data-stage-state");

describe("StageTimeline as a checklist", () => {
  test("completed, active and locked stages are labelled as such", () => {
    render(<StageTimeline stages={STAGES} currentStage={3} />);

    expect([1, 2, 3, 4, 5].map(stateOf)).toEqual(["completed", "completed", "active", "locked", "locked"]);
    expect(within(rows()[0]).getByText("Completed")).toBeTruthy();
    expect(within(rows()[2]).getByText("Active")).toBeTruthy();
    expect(within(rows()[3]).getByText("Locked")).toBeTruthy();
    expect(rows()[2].getAttribute("aria-current")).toBe("step");
    expect(screen.getAllByText("Current task")).toHaveLength(1);
  });

  test("only the first locked stage says what it is waiting on", () => {
    render(<StageTimeline stages={STAGES} currentStage={3} />);

    expect(within(rows()[3]).getByText(/Unlocks when Send SOR \+ PI is completed/)).toBeTruthy();
    expect(within(rows()[4]).queryByText(/Unlocks when/)).toBeNull();
  });

  test("the Complete button is offered on the active stage only — never on a locked one", () => {
    render(
      <StageTimeline stages={STAGES} currentStage={3} actionableStages={[3, 4]} onAct={vi.fn()} />,
    );

    const buttons = screen.getAllByRole("button", { name: /complete this stage/i });
    expect(buttons).toHaveLength(1);
    expect(within(rows()[2]).getByRole("button", { name: /complete this stage/i })).toBeTruthy();
  });

  test("a completed stage offers View details; an active or locked one does not", () => {
    render(<StageTimeline stages={STAGES} currentStage={3} />);

    expect(within(rows()[0]).getByRole("button", { name: "View details" })).toBeTruthy();
    expect(within(rows()[2]).queryByRole("button", { name: "View details" })).toBeNull();
    expect(within(rows()[3]).queryByRole("button", { name: "View details" })).toBeNull();

    fireEvent.click(within(rows()[1]).getByRole("button", { name: "View details" }));
    expect(screen.getByLabelText(/Submit PO to Billing details/)).toBeTruthy();
  });

  test("after a rework, the locked stage names the reopened stage it waits on", () => {
    const reworked = [
      STAGES[0],
      { ...STAGES[1], status: STAGE_STATUS.PENDING },
      { ...STAGES[2], status: STAGE_STATUS.DONE_ON_TIME },
      STAGES[3],
    ];
    render(<StageTimeline stages={reworked} currentStage={2} />);

    expect(within(rows()[3]).getByText(/Unlocks when Submit PO to Billing is completed/)).toBeTruthy();
  });
});

describe("StageProgress", () => {
  test("counts completed stages", () => {
    render(<StageProgress stages={STAGES} />);
    expect(screen.getByText(/of 5 stages completed/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("2");
  });
});

describe("a finished order", () => {
  test("reads Completed", () => {
    render(<OrderStatusBadge status="CLOSED" />);
    expect(screen.getByText("Completed")).toBeTruthy();
  });
});
