import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const api = vi.hoisted(() => ({ previewUpcomingImport: vi.fn(), importUpcoming: vi.fn() }));
vi.mock("../../services/inventory", () => ({ inventoryApi: api }));

const sheet = vi.hoisted(() => ({ rows: [] }));
vi.mock("../../utils/upcomingStock", async (importOriginal) => ({
  ...(await importOriginal()),
  readImportFile: async () => ({ error: null, rows: sheet.rows }),
}));

import toast from "react-hot-toast";
import { ImportUpcomingModal } from "./ImportUpcomingModal";

const ROWS = [
  { row: 2, skuCode: "14405M-10", brand: "Koken", product: "", qty: 100, eta: "2026-11-20", ref: "PO-1", supplier: "" },
  { row: 3, skuCode: "14405M-10", brand: "Koken", product: "", qty: 50, eta: "2026-11-10", ref: "po-1", supplier: "" },
  { row: 4, skuCode: "4768N", brand: "Koken", product: "", qty: 20, eta: "", ref: "", supplier: "" },
];

describe("Import Upcoming Stock — duplicate rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sheet.rows = ROWS;
    api.previewUpcomingImport.mockResolvedValue({
      lines: [
        {
          row: 2, mergedRows: [2, 3], skuCode: "14405M-10", brand: "Koken", product: "Socket", qty: 150,
          eta: "2026-11-09T18:30:00.000Z", ref: "PO-1", supplier: null, outcome: "existing", problems: [],
          notes: ["Merged rows 2, 3 (100 + 50 = 150)", "dates differed — kept the earliest"],
        },
        { row: 4, skuCode: "4768N", brand: "Koken", product: "Ratchet", qty: 20, eta: null, ref: null, supplier: null, outcome: "existing", problems: [] },
      ],
    });
  });

  const upload = async () => {
    const { container } = render(<ImportUpcomingModal open onClose={() => {}} onImported={() => {}} />);
    fireEvent.change(container.ownerDocument.querySelector('input[type="file"]'), {
      target: { files: [new File(["x"], "october.xlsx")] },
    });
    await screen.findByText("Merged rows 2, 3 (100 + 50 = 150)");
  };

  test("the preview shows the merged line, its note, and counts rows from the file", async () => {
    await upload();
    expect(screen.getByText("dates differed — kept the earliest")).toBeTruthy();
    expect(screen.getByText("2, 3")).toBeTruthy();
    expect(screen.getByText(/1 duplicate row was merged/)).toBeTruthy();
    expect(screen.getByText("Rows in file").nextSibling.textContent).toBe("3");
    expect(screen.getByText("Ready to import").nextSibling.textContent).toBe("2");
  });

  test("the import sends the file's rows; the server merges them again", async () => {
    api.importUpcoming.mockResolvedValue({ lines: 2, qty: 170, created: 0, merged: 1 });
    await upload();
    fireEvent.click(screen.getByRole("button", { name: /Import 2 lines/ }));
    await waitFor(() => expect(api.importUpcoming).toHaveBeenCalledTimes(1));
    expect(api.importUpcoming.mock.calls[0][0].rows).toEqual(ROWS);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/1 duplicate row merged/)));
  });
});
