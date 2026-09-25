import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { StageDetails } from "./o2dShared";
import { STAGE_STATUS } from "@shared/constants/o2d.js";

describe("StageDetails — a completed stage's stored record", () => {
  test("shows the form values, the file it relied on, remarks and who completed it", () => {
    const onOpenDocument = vi.fn();
    render(
      <StageDetails
        stage={{
          stageNumber: 2, stageName: "Submit PO to Billing", status: STAGE_STATUS.DONE_LATE,
          completedByName: "Sumedh", completedByRole: "Billing", actualCompletion: "2026-09-23T09:00:00Z",
          evidence: { poCopy: { documentId: "d1", originalName: "po.pdf" } },
          remarks: "Received by email",
        }}
        documents={[{ _id: "d9", docType: "OTHER", stageNumber: 2, originalName: "note.pdf" }]}
        onOpenDocument={onOpenDocument}
      />,
    );

    const panel = screen.getByLabelText(/Submit PO to Billing details/);
    expect(within(panel).getByText(/Sumedh \(Billing\)/)).toBeTruthy();
    expect(within(panel).getByText(/po\.pdf/)).toBeTruthy();
    expect(within(panel).getByText(/note\.pdf/)).toBeTruthy();
    expect(within(panel).getByText("Received by email")).toBeTruthy();

    fireEvent.click(within(panel).getAllByRole("button", { name: "Open" })[0]);
    expect(onOpenDocument).toHaveBeenCalledWith(expect.objectContaining({ _id: "d1" }));
  });

  test("formats typed fields", () => {
    render(
      <StageDetails
        stage={{
          stageNumber: 11, stageName: "Send Dispatch Details",
          evidence: { mailReference: "MAIL-1", whatsappSent: false },
        }}
      />,
    );
    expect(screen.getByText("MAIL-1")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
  });
});
