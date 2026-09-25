import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../../services/o2d/orders", async (importOriginal) => ({
  ...(await importOriginal()),
  o2dApi: { reopenStage: vi.fn() },
}));

import { o2dApi } from "../../services/o2d/orders";
import { ReopenStageModal } from "./ReopenStageModal";
import { StageTimeline } from "./o2dShared";
import { STAGE_STATUS } from "@shared/constants/o2d.js";

const ORDER = { _id: "o1", poNumber: "PO-4471" };

beforeEach(() => {
  vi.clearAllMocks();
  o2dApi.reopenStage.mockResolvedValue({});
});

describe("ReopenStageModal", () => {
  const open = (props = {}) =>
    render(
      <ReopenStageModal
        order={ORDER}
        stage={{ stageNumber: 3, stageName: "Send SOR + PI", ownerRole: "Billing" }}
        onClose={vi.fn()}
        onReopened={vi.fn()}
        {...props}
      />,
    );

  test("refuses to submit without a reason", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /send back for rework/i }));
    expect(await screen.findByText(/reason is required/i)).toBeTruthy();
    expect(o2dApi.reopenStage).not.toHaveBeenCalled();
  });

  test("sends the reason and the downstream choice", async () => {
    const onReopened = vi.fn();
    open({ onReopened });
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Wrong PI amount" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /send back for rework/i }));

    await waitFor(() => expect(onReopened).toHaveBeenCalled());
    expect(o2dApi.reopenStage).toHaveBeenCalledWith("o1", 3, {
      reason: "Wrong PI amount",
      resetDownstream: true,
    });
  });
});

describe("StageTimeline rework controls", () => {
  const stages = [
    { stageNumber: 1, stageName: "Receive Order", ownerRole: "Sales", status: STAGE_STATUS.DONE_ON_TIME },
    { stageNumber: 2, stageName: "Submit PO", ownerRole: "Sales", status: STAGE_STATUS.DONE_ON_TIME, reopenCount: 1, lastReopenReason: "Wrong PO" },
    { stageNumber: 3, stageName: "Send SOR + PI", ownerRole: "Billing", status: STAGE_STATUS.PENDING },
    { stageNumber: 4, stageName: "Advance", ownerRole: "Billing", status: STAGE_STATUS.LOCKED },
  ];

  test("offers rework only on completed stages after stage 1, and marks the current task", () => {
    const onReopen = vi.fn();
    render(<StageTimeline stages={stages} currentStage={3} onReopen={onReopen} />);

    const buttons = screen.getAllByRole("button", { name: /send back for rework/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onReopen).toHaveBeenCalledWith(expect.objectContaining({ stageNumber: 2 }));

    expect(screen.getAllByText("Current task")).toHaveLength(1);
    expect(screen.getByText(/once · Wrong PO/)).toBeTruthy();
  });

  test("offers no rework without the handler (no override permission)", () => {
    render(<StageTimeline stages={stages} currentStage={3} />);
    expect(screen.queryByRole("button", { name: /send back for rework/i })).toBeNull();
  });
});
