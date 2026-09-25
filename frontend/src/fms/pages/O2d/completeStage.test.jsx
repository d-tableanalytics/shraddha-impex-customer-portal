import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../../services/o2d/orders", async (importOriginal) => ({
  ...(await importOriginal()),
  o2dApi: {
    completeStage: vi.fn(), uploadDocument: vi.fn(), documents: vi.fn(), advanceDecision: vi.fn(),
  },
}));

import { o2dApi } from "../../services/o2d/orders";
import { CompleteStageModal } from "./CompleteStageModal";
import { STAGES } from "@shared/constants/o2d.js";

/**
 * The stage-specific completion form.
 *
 * Two properties matter and neither is obvious from reading the component: it
 * shows ONLY the fields the stage declares, and it never offers a box for the
 * actual completion time. The second looks like an omission, so it is pinned.
 */
const ORDER = { _id: "o1", poNumber: "PO-4471" };
const stage = (n, name) => ({ stageNumber: n, stageName: name });

const open = (n, name) =>
  render(
    <CompleteStageModal
      order={ORDER}
      stage={stage(n, name)}
      onClose={vi.fn()}
      onCompleted={vi.fn()}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  o2dApi.completeStage.mockResolvedValue({});
  o2dApi.uploadDocument.mockResolvedValue({});
  o2dApi.documents.mockResolvedValue([]);
  o2dApi.advanceDecision.mockResolvedValue({});
});

describe("each stage shows only its own fields", () => {
  test("stage 3 asks for the PI number and SOR reference", () => {
    open(STAGES.SEND_SOR_PI, "Send SOR + PI");

    expect(screen.getByLabelText(/PI Number/i)).toBeTruthy();
    expect(screen.getByLabelText(/SOR Reference/i)).toBeTruthy();
    // And nothing belonging to another stage.
    expect(screen.queryByLabelText(/AWB Number/i)).toBeNull();
    expect(screen.queryByLabelText(/Invoice Number/i)).toBeNull();
  });

  test("stage 9 asks for the dispatch details, and only those", () => {
    open(STAGES.PACK_AND_DISPATCH, "Pack & Dispatch");

    for (const label of [/Transporter/i, /AWB Number/i, /Box Count/i, /Weight \(kg\)/i]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.queryByLabelText(/PI Number/i)).toBeNull();
  });

  test("a stage with no declared fields says so rather than showing an empty form", () => {
    open(STAGES.RECEIVE_ORDER, "Receive Order");
    expect(screen.getByText(/needs no extra information/i)).toBeTruthy();
  });
});

describe("what the form never asks for", () => {
  test("there is no actual-completion input on any stage", () => {
    for (const n of [2, 3, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const { unmount } = open(n, `Stage ${n}`);
      // §33 — the engine stamps it. A box here would let whoever closes the
      // stage choose their own SLA result.
      expect(screen.queryByLabelText(/actual/i)).toBeNull();
      unmount();
    }
  });

  test("and says the time is recorded automatically, so its absence reads as deliberate", () => {
    open(STAGES.SEND_SOR_PI, "Send SOR + PI");
    expect(screen.getByText(/recorded automatically/i)).toBeTruthy();
  });
});

describe("required fields are validated before completing", () => {
  test("submitting empty refuses and names the first missing field", async () => {
    open(STAGES.SEND_SOR_PI, "Send SOR + PI");

    fireEvent.click(screen.getByRole("button", { name: /complete stage/i }));

    expect(await screen.findByText("PI Number is required.")).toBeTruthy();
    expect(o2dApi.completeStage).not.toHaveBeenCalled();
  });

  test("a filled form submits the stage's values as evidence", async () => {
    open(STAGES.SEND_SOR_PI, "Send SOR + PI");

    fireEvent.change(screen.getByLabelText(/PI Number/i), { target: { value: "PI-001" } });
    fireEvent.change(screen.getByLabelText(/SOR Reference/i), { target: { value: "SOR-9" } });
    fireEvent.click(screen.getByRole("button", { name: /complete stage/i }));

    await waitFor(() => expect(o2dApi.completeStage).toHaveBeenCalled());
    const [orderId, stageNumber, body] = o2dApi.completeStage.mock.calls[0];
    expect(orderId).toBe("o1");
    expect(stageNumber).toBe(STAGES.SEND_SOR_PI);
    expect(body.evidence).toEqual({ piNumber: "PI-001", sorReference: "SOR-9" });
    // Never sent from the form.
    expect(body.actualCompletion).toBeUndefined();
  });

  test("counts what is still outstanding", () => {
    open(STAGES.PACK_AND_DISPATCH, "Pack & Dispatch");
    expect(screen.getByText("4 required fields left")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Transporter/i), { target: { value: "Blue Dart" } });
    expect(screen.getByText("3 required fields left")).toBeTruthy();
  });
});

describe("the stages that need a file", () => {
  test("stage 2 will not submit until a file has actually uploaded", async () => {
    open(STAGES.SUBMIT_PO_TO_BILLING, "Submit PO to Billing");

    fireEvent.click(screen.getByRole("button", { name: /complete stage/i }));

    // Choosing a file is not enough — it has to have reached the server, which
    // is what the completion check on the other side actually looks for.
    expect(await screen.findByText("PO Copy / PO Scan is required.")).toBeTruthy();
    expect(o2dApi.completeStage).not.toHaveBeenCalled();
  });

  test("uploading happens on choosing the file, not on submit", async () => {
    open(STAGES.SUBMIT_PO_TO_BILLING, "Submit PO to Billing");

    const file = new File(["x"], "po.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText(/PO Copy/i), { target: { files: [file] } });

    // Uploading on submit would leave a half-done action if the upload
    // succeeded and the completion then failed validation.
    await waitFor(() => expect(o2dApi.uploadDocument).toHaveBeenCalled());
    expect(await screen.findByText("po.pdf")).toBeTruthy();
  });
});

describe("the same form, reached from a task list or during rework", () => {
  test("a PO copy already on the order satisfies stage 2 — it is not asked for twice", async () => {
    o2dApi.documents.mockResolvedValue([{ _id: "d1", docType: "PO", originalName: "po-4471.pdf" }]);
    open(STAGES.SUBMIT_PO_TO_BILLING, "Submit PO to Billing");

    expect(await screen.findByText("po-4471.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /complete stage/i }));
    await waitFor(() => expect(o2dApi.completeStage).toHaveBeenCalled());
  });

  test("a stage sent back for rework opens with what it stored last time", async () => {
    render(
      <CompleteStageModal
        order={ORDER}
        stage={{
          stageNumber: STAGES.SEND_SOR_PI, stageName: "Send SOR + PI",
          evidence: { piNumber: "PI-OLD", sorReference: "SOR-OLD" }, remarks: "first pass",
        }}
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/PI Number/i).value).toBe("PI-OLD");
    fireEvent.change(screen.getByLabelText(/PI Number/i), { target: { value: "PI-NEW" } });
    fireEvent.click(screen.getByRole("button", { name: /complete stage/i }));

    await waitFor(() => expect(o2dApi.completeStage).toHaveBeenCalled());
    const [, , body] = o2dApi.completeStage.mock.calls[0];
    expect(body.evidence).toEqual({ piNumber: "PI-NEW", sorReference: "SOR-OLD" });
    expect(body.remarks).toBe("first pass");
  });

  test("stage 4 asks for the advance decision and records it through the decision endpoint", async () => {
    const onCompleted = vi.fn();
    render(
      <CompleteStageModal
        order={ORDER}
        stage={{ stageNumber: STAGES.ADVANCE_DECISION, stageName: "Advance Order Decision" }}
        onClose={vi.fn()}
        onCompleted={onCompleted}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /complete stage/i }));
    expect(await screen.findByText(/Advance payment decision is required/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/No — skip stage 5/));
    fireEvent.click(screen.getByRole("button", { name: /complete stage/i }));

    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
    expect(o2dApi.advanceDecision).toHaveBeenCalledWith("o1", { advanceRequired: false, remarks: null });
    expect(o2dApi.completeStage).not.toHaveBeenCalled();
  });
});

describe("Zoho-filled stages say so", () => {
  test("stage 8 explains the values can arrive from the invoice", () => {
    open(STAGES.SCAN_AND_INVOICE, "Scan Material + Create Invoice");
    expect(screen.getByText(/arrive from the invoice/i)).toBeTruthy();
  });

  test("stage 10 explains it completes itself once the webhook is live", () => {
    open(STAGES.MARK_SENT_IN_ZOHO, "Mark Sent in Zoho");
    expect(screen.getByText(/completes itself/i)).toBeTruthy();
  });
});
