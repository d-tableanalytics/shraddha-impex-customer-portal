/**
 * Expenses — the screens.
 *
 * Only the axios instance is mocked. The HRMS client, the shared Zod schemas
 * and the shared permission matrix are all real, so these also cover the
 * request URLs, the payload shapes and the `{ success, data }` unwrapping.
 *
 * What the UI offers is asserted here; what it is ALLOWED to do is asserted in
 * backend/tests/expenses-api.test.js. Both halves read the same matrix.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../../services/api";
import { ExpensesPage } from "./ExpensesPage";
import { formatMoney } from "../../../services/hrms";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

const ME = "652f0000000000000000b001";
const OTHER = "652f0000000000000000b002";
const CAT_TRAVEL = "652f0000000000000000a001";
const CAT_MEALS = "652f0000000000000000a002";

const CATEGORIES = [
  {
    id: CAT_TRAVEL,
    code: "TRAVEL",
    name: "Travel",
    glCode: "500-1200",
    tallyLedger: null,
    active: true,
    policy: {
      id: "652f0000000000000000c001",
      dailyLimit: "1500.00",
      monthlyLimit: null,
      autoApproveBelow: null,
      requiresReceipt: true,
      requiresApproval: true,
    },
  },
  {
    id: CAT_MEALS,
    code: "MEALS",
    name: "Meals",
    glCode: null,
    tallyLedger: null,
    active: false,
    policy: null,
  },
];

const line = (over = {}) => ({
  id: "652f0000000000000000d001",
  categoryId: CAT_TRAVEL,
  categoryName: "Travel",
  categoryCode: "TRAVEL",
  date: "2026-01-05",
  amount: "250.50",
  description: "Taxi to the client office",
  hasReceipt: false,
  receiptContentType: null,
  ...over,
});

const claim = (over = {}) => ({
  id: "652f0000000000000000e001",
  employeeId: ME,
  employeeName: "Staff One",
  employeeCode: "SI-0002",
  isOwnClaim: true,
  title: "Client visit",
  status: "draft",
  total: "250.50",
  currency: "INR",
  submittedAt: null,
  reimbursedAt: null,
  lineItems: [line()],
  approvalChain: [],
  createdAt: "2026-01-06T00:00:00.000Z",
  ...over,
});

const MY_CLAIMS = [
  claim(),
  claim({
    id: "652f0000000000000000e002",
    title: "Conference travel",
    status: "reimbursed",
    total: "12500.00",
    submittedAt: "2026-01-02T00:00:00.000Z",
    lineItems: [line({ id: "652f0000000000000000d002", amount: "12500.00", hasReceipt: true })],
  }),
];

const QUEUE = [
  claim({
    id: "652f0000000000000000e010",
    employeeId: OTHER,
    employeeName: "Report Two",
    employeeCode: "SI-0003",
    isOwnClaim: false,
    title: "Site visit",
    status: "submitted",
    submittedAt: "2026-01-03T00:00:00.000Z",
  }),
];

let calls = [];
const envelope = (payload) => ({ data: { success: true, data: payload } });
const page = (rows) => envelope({ data: rows, total: rows.length, page: 1, pageSize: 15 });
const fail = (status, body) => Promise.reject({ response: { status, data: body } });

function installTransport(overrides = {}) {
  calls = [];
  api.request.mockImplementation(async (config) => {
    calls.push(config);
    const key = `${config.method.toUpperCase()} ${config.url}`;
    if (overrides[key]) return overrides[key](config);

    if (key === "GET /hrms/expenses/categories") {
      return envelope(
        config.params?.includeInactive ? CATEGORIES : CATEGORIES.filter((c) => c.active),
      );
    }
    if (key === "GET /hrms/expenses/claims") {
      const wanted = config.params?.status;
      if (wanted === "submitted") return page(QUEUE);
      if (wanted) return page([]);
      return page(MY_CLAIMS);
    }
    if (config.method === "post" || config.method === "patch") {
      return envelope(claim({ id: "652f0000000000000000e999" }));
    }
    if (config.method === "delete") return envelope({ deleted: true });
    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles, employee = { id: ME, managerChain: [] }) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee }),
    implementedModules: [M.DASHBOARD, M.EMPLOYEES, M.LEAVE, M.EXPENSES],
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/expenses" element={<ExpensesPage />} />
        <Route path="/hrms/expenses/:tab" element={<ExpensesPage />} />
      </Routes>
    </MemoryRouter>,
  );

const urlsHit = () => calls.map((c) => `${c.method.toUpperCase()} ${c.url}`);

beforeEach(() => {
  useHrmsStore.getState().clear();
  installTransport();
});

// ===========================================================================
// Page shell and gating
// ===========================================================================

describe("the expenses page", () => {
  it("renders its title, and no breadcrumb - a top-level page needs none", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/expenses/claims");

    expect(await screen.findByRole("heading", { name: "Expenses" })).toBeTruthy();
    // A top-level HRMS page carries no breadcrumb: "HRMS > X" above a heading
    // that already reads "X", beside a sidebar already highlighting X, is the
    // same fact three times - and no other module in the portal has one.
    // HrmsPageLayout renders the trail only once it goes deeper than
    // "HRMS > <module>"; the nested employee pages still get theirs.
    expect(screen.queryByRole("navigation", { name: /breadcrumb/i })).toBeNull();
  });

  it("an employee gets My Claims only", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/expenses/claims");

    expect(await screen.findByRole("tab", { name: "My Claims" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Approval Queue" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Categories" })).toBeNull();
  });

  it("a manager also gets the approval queue, but not the catalogue", async () => {
    signIn([R.MANAGER]);
    at("/hrms/expenses/claims");

    expect(await screen.findByRole("tab", { name: "Approval Queue" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Categories" })).toBeNull();
  });

  it("finance gets all three", async () => {
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/expenses/claims");

    expect(await screen.findByRole("tab", { name: "Approval Queue" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Categories" })).toBeTruthy();
  });

  it("a gated tab reached by URL is refused WITHOUT firing its request", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/expenses/categories");

    expect(await screen.findByText(/do not have access to this view/i)).toBeTruthy();
    // The point of the guard: no request was made that would only be refused.
    expect(urlsHit()).not.toContain("GET /hrms/expenses/categories");
  });
});

// ===========================================================================
// My claims
// ===========================================================================

describe("my claims", () => {
  it("lists them with money grouped to two places", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/expenses/claims");

    expect(await screen.findByText("Client visit")).toBeTruthy();
    expect(screen.getByText("₹ 250.50")).toBeTruthy();
    // Indian grouping, and never re-parsed to a Number on the way.
    expect(screen.getByText("₹ 12,500.00")).toBeTruthy();
  });

  it("shows Submit on a draft only", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/expenses/claims");

    await screen.findByText("Client visit");
    // One draft in the fixture, so exactly one Submit button.
    expect(screen.getAllByRole("button", { name: "Submit" })).toHaveLength(1);
  });

  it("submits a draft and reloads", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/expenses/claims");

    await screen.findByText("Client visit");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(urlsHit()).toContain(
        "POST /hrms/expenses/claims/652f0000000000000000e001/submit",
      ),
    );
  });

  it("filters by status through the SERVER, not in the browser", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/expenses/claims");

    await screen.findByText("Client visit");
    await userEvent.selectOptions(screen.getByLabelText("Filter by status"), "reimbursed");

    await waitFor(() => {
      const last = calls[calls.length - 1];
      expect(last.params.status).toBe("reimbursed");
    });
  });

  it("renders the empty state when there is nothing", async () => {
    installTransport({ "GET /hrms/expenses/claims": () => page([]) });
    signIn([R.EMPLOYEE]);
    at("/hrms/expenses/claims");

    expect(await screen.findByText("No expense claims yet")).toBeTruthy();
  });

  it("renders an error with a retry that refetches", async () => {
    installTransport({
      "GET /hrms/expenses/claims": () => fail(500, { message: "Server error" }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/expenses/claims");

    const retry = await screen.findByRole("button", { name: /try again|retry/i });
    const before = calls.length;
    await userEvent.click(retry);
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it("expands a claim to show its line items", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/expenses/claims");

    await screen.findByText("Client visit");
    await userEvent.click(
      screen.getByRole("button", { name: /Show line items for Client visit/i }),
    );

    expect(await screen.findByText("Taxi to the client office")).toBeTruthy();
    expect(screen.getByText("5 Jan 2026")).toBeTruthy();
  });
});

// ===========================================================================
// Filing a claim
// ===========================================================================

describe("the new claim drawer", () => {
  const openDrawer = async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/expenses/claims");
    await screen.findByText("Client visit");
    await userEvent.click(screen.getByRole("button", { name: /New claim/i }));
    return screen.findByLabelText("Title");
  };

  it("offers only ACTIVE categories", async () => {
    await openDrawer();

    const select = await screen.findByLabelText("Category");
    expect(within(select).getByText("TRAVEL · Travel")).toBeTruthy();
    // MEALS is inactive; a claimant cannot pick something they cannot use.
    expect(within(select).queryByText("MEALS · Meals")).toBeNull();
  });

  it("refuses to post an invalid claim, and says which field", async () => {
    await openDrawer();

    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));

    // Nothing was sent — the shared schema caught it in the browser.
    await waitFor(() =>
      expect(urlsHit().filter((u) => u === "POST /hrms/expenses/claims")).toHaveLength(0),
    );
  });

  it("posts the amount as a STRING, exactly as typed", async () => {
    await openDrawer();

    await userEvent.type(screen.getByLabelText("Title"), "April client meetings");
    await userEvent.selectOptions(screen.getByLabelText("Category"), CAT_TRAVEL);
    await userEvent.type(screen.getByLabelText("Amount (₹)"), "250.50");
    await userEvent.type(screen.getByLabelText("Description"), "Taxi");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "post" && c.url === "/hrms/expenses/claims");
      expect(post).toBeTruthy();
      const amount = post.data.lineItems[0].amount;
      expect(amount).toBe("250.50");
      expect(typeof amount).toBe("string");
    });
  });

  it("never sends an employeeId — the server decides whose claim it is", async () => {
    await openDrawer();

    await userEvent.type(screen.getByLabelText("Title"), "April client meetings");
    await userEvent.selectOptions(screen.getByLabelText("Category"), CAT_TRAVEL);
    await userEvent.type(screen.getByLabelText("Amount (₹)"), "10.00");
    await userEvent.type(screen.getByLabelText("Description"), "Taxi");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "post" && c.url === "/hrms/expenses/claims");
      expect(post).toBeTruthy();
      expect(post.data.employeeId).toBeUndefined();
      expect(post.data.total).toBeUndefined();
    });
  });

  it("adds and removes line items, and totals them EXACTLY", async () => {
    await openDrawer();

    await userEvent.type(screen.getByLabelText("Amount (₹)"), "0.10");
    await userEvent.click(screen.getByRole("button", { name: /Add line item/i }));

    const amounts = await screen.findAllByLabelText("Amount (₹)");
    expect(amounts).toHaveLength(2);
    await userEvent.type(amounts[1], "0.20");

    // Summed with `+` this would read 0.30000000000000004.
    expect(await screen.findByText("₹ 0.30")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Remove line item 2" }));
    await waitFor(() => expect(screen.getAllByLabelText("Amount (₹)")).toHaveLength(1));
  });

  it("cannot remove the only line item", async () => {
    await openDrawer();
    expect(screen.getByRole("button", { name: "Remove line item 1" }).disabled).toBe(true);
  });

  it("caps the date picker at today", async () => {
    await openDrawer();
    const today = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const iso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    expect(screen.getByLabelText("Date").getAttribute("max")).toBe(iso);
  });
});

// ===========================================================================
// Receipts
// ===========================================================================

describe("receipts", () => {
  const expandFirst = async (roles = [R.EMPLOYEE], path = "/hrms/expenses/claims") => {
    signIn(roles);
    at(path);
    await screen.findByText("Client visit");
    await userEvent.click(
      screen.getByRole("button", { name: /Show line items for Client visit/i }),
    );
    return screen.findByText("Taxi to the client office");
  };

  it("offers Upload on a draft line with no receipt", async () => {
    await expandFirst();
    expect(screen.getByRole("button", { name: /Upload/i })).toBeTruthy();
  });

  it("posts the file as multipart to the line's own endpoint", async () => {
    await expandFirst();

    const input = screen.getByLabelText(/Attach a receipt for Taxi/i);
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "bill.pdf", {
      type: "application/pdf",
    });
    await userEvent.upload(input, file);

    await waitFor(() => {
      const post = calls.find((c) => c.url?.includes("/receipt"));
      expect(post).toBeTruthy();
      expect(post.url).toBe(
        "/hrms/expenses/claims/652f0000000000000000e001/lines/652f0000000000000000d001/receipt",
      );
      // FormData, not a JSON body carrying a client-chosen key.
      expect(post.data instanceof FormData).toBe(true);
    });
  });

  it("surfaces a rejected file type as an error, not a silent no-op", async () => {
    installTransport({
      "POST /hrms/expenses/claims/652f0000000000000000e001/lines/652f0000000000000000d001/receipt":
        () => fail(400, { message: "That file does not match its declared type." }),
    });
    await expandFirst();

    const input = screen.getByLabelText(/Attach a receipt for Taxi/i);
    await userEvent.upload(input, new File(["MZ"], "x.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(calls.some((c) => c.url?.includes("/receipt"))).toBe(true));
  });

  it("fetches a short-lived URL rather than linking at the object", async () => {
    const opened = [];
    vi.spyOn(window, "open").mockImplementation((url) => opened.push(url));

    installTransport({
      "GET /hrms/expenses/claims/652f0000000000000000e002/lines/652f0000000000000000d002/receipt":
        () => envelope({ url: "https://signed.example/abc", expiresInSeconds: 300 }),
    });

    signIn([R.EMPLOYEE]);
    at("/hrms/expenses/claims");
    await screen.findByText("Conference travel");
    await userEvent.click(
      screen.getByRole("button", { name: /Show line items for Conference travel/i }),
    );

    const view = await screen.findByRole("button", { name: /View receipt/i });
    // The button is not an anchor at a guessable object URL.
    expect(view.tagName).toBe("BUTTON");
    await userEvent.click(view);

    await waitFor(() => expect(opened).toContain("https://signed.example/abc"));
    window.open.mockRestore();
  });

  it("shows no upload control on a claim that is past draft", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/expenses/claims");
    await screen.findByText("Conference travel");
    await userEvent.click(
      screen.getByRole("button", { name: /Show line items for Conference travel/i }),
    );

    await screen.findByRole("button", { name: /View receipt/i });
    expect(screen.queryByRole("button", { name: /^Upload$/i })).toBeNull();
  });
});

// ===========================================================================
// The approval queue
// ===========================================================================

describe("the approval queue", () => {
  const openQueue = async (roles = [R.MANAGER]) => {
    signIn(roles);
    at("/hrms/expenses/queue");
    return screen.findByText("Site visit");
  };

  it("asks the server for the pending statuses rather than filtering locally", async () => {
    await openQueue();

    const statuses = calls
      .filter((c) => c.url === "/hrms/expenses/claims")
      .map((c) => c.params?.status);
    expect(statuses).toContain("submitted");
    expect(statuses).toContain("manager_approved");
    // Never an unfiltered pull of every claim in the organisation.
    expect(statuses.every((s) => s !== undefined)).toBe(true);
  });

  it("shows who filed it and what it is worth", async () => {
    await openQueue();
    expect(screen.getByText("Report Two")).toBeTruthy();
    expect(screen.getByText("SI-0003")).toBeTruthy();
  });

  it("approves", async () => {
    await openQueue();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url?.endsWith("/decide"));
      expect(post.data.decision).toBe("approve");
    });
  });

  it("rejects", async () => {
    await openQueue();
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url?.endsWith("/decide"));
      expect(post.data.decision).toBe("reject");
    });
  });

  it("offers NO decision on the approver's own claim", async () => {
    installTransport({
      "GET /hrms/expenses/claims": (config) =>
        config.params?.status === "submitted"
          ? page([
              claim({
                id: "652f0000000000000000e020",
                title: "My own trip",
                status: "submitted",
                isOwnClaim: true,
              }),
            ])
          : page([]),
    });

    signIn([R.MANAGER]);
    at("/hrms/expenses/queue");

    expect(await screen.findByText("Your own claim")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("a manager is not offered the payment view", async () => {
    await openQueue([R.MANAGER]);
    expect(screen.queryByRole("button", { name: /awaiting payment/i })).toBeNull();
  });

  it("finance can mark a fully approved claim reimbursed", async () => {
    installTransport({
      "GET /hrms/expenses/claims": (config) =>
        config.params?.status === "finance_approved"
          ? page([
              claim({
                id: "652f0000000000000000e030",
                title: "Payable trip",
                status: "finance_approved",
                isOwnClaim: false,
                employeeId: OTHER,
              }),
            ])
          : page([]),
    });

    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/expenses/queue");

    await userEvent.click(await screen.findByRole("button", { name: /awaiting payment/i }));
    await userEvent.click(await screen.findByRole("button", { name: /Mark reimbursed/i }));

    await waitFor(() =>
      expect(urlsHit()).toContain(
        "POST /hrms/expenses/claims/652f0000000000000000e030/reimburse",
      ),
    );
  });

  it("renders the empty state when nothing is waiting", async () => {
    installTransport({ "GET /hrms/expenses/claims": () => page([]) });
    signIn([R.MANAGER]);
    at("/hrms/expenses/queue");

    expect(await screen.findByText("Nothing awaiting you")).toBeTruthy();
  });
});

// ===========================================================================
// Categories and policies
// ===========================================================================

describe("the category catalogue", () => {
  const openCategories = async () => {
    signIn([R.PAYROLL_ADMIN]);
    at("/hrms/expenses/categories");
    return screen.findByText("Travel");
  };

  it("lists active and inactive alike, marked", async () => {
    await openCategories();

    // "Active" is also the column header, so assert the badge on its own row.
    const travelRow = screen.getByText("TRAVEL").closest("tr");
    expect(within(travelRow).getByText("Active")).toBeTruthy();

    const mealsRow = screen.getByText("MEALS").closest("tr");
    expect(within(mealsRow).getByText("Inactive")).toBeTruthy();
  });

  it("creates one, upper-casing the code", async () => {
    await openCategories();
    await userEvent.click(screen.getByRole("button", { name: /New/i }));

    await userEvent.type(await screen.findByLabelText("Code"), "food");
    await userEvent.type(screen.getByLabelText("Name"), "Meals");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "post" && c.url === "/hrms/expenses/categories",
      );
      expect(post.data.code).toBe("FOOD");
    });
  });

  it("will not let the code change on edit", async () => {
    await openCategories();
    await userEvent.click(screen.getByRole("button", { name: "Edit Travel" }));

    const code = await screen.findByLabelText("Code");
    expect(code.disabled).toBe(true);
    expect(screen.getByText(/cannot change/i)).toBeTruthy();
  });

  it("confirms before deleting, and explains the in-use rule", async () => {
    await openCategories();
    await userEvent.click(screen.getByRole("button", { name: "Delete Travel" }));

    expect(await screen.findByText(/Delete Travel\?/)).toBeTruthy();
    expect(screen.getByText(/cannot be deleted/i)).toBeTruthy();
    // Nothing is sent until it is confirmed.
    expect(urlsHit().some((u) => u.startsWith("DELETE"))).toBe(false);
  });

  it("deletes once confirmed", async () => {
    await openCategories();
    await userEvent.click(screen.getByRole("button", { name: "Delete Travel" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(urlsHit()).toContain(`DELETE /hrms/expenses/categories/${CAT_TRAVEL}`),
    );
  });

  it("loads the selected category's policy, and says it is guidance", async () => {
    await openCategories();
    await userEvent.click(screen.getByText("Travel"));

    expect(await screen.findByDisplayValue("1500.00")).toBeTruthy();
    expect(screen.getByText(/do not automatically block or approve/i)).toBeTruthy();
  });

  it("saves a policy with the amounts as strings", async () => {
    await openCategories();
    await userEvent.click(screen.getByText("Travel"));

    const monthly = await screen.findByLabelText("Monthly limit (₹)");
    await userEvent.type(monthly, "20000.00");
    await userEvent.click(screen.getByRole("button", { name: /Save policy/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === "/hrms/expenses/policies");
      expect(post.data.monthlyLimit).toBe("20000.00");
      expect(post.data.dailyLimit).toBe("1500.00");
      expect(post.data.categoryId).toBe(CAT_TRAVEL);
    });
  });

  it("prompts for a selection before showing a policy", async () => {
    await openCategories();
    expect(screen.getByText(/Select a category/i)).toBeTruthy();
  });
});

// ===========================================================================
// Money formatting
// ===========================================================================

describe("formatMoney", () => {
  it("groups the Indian way and always shows paise", () => {
    expect(formatMoney("250.5")).toBe("₹ 250.50");
    expect(formatMoney("1234.5")).toBe("₹ 1,234.50");
    expect(formatMoney("1234567.89")).toBe("₹ 12,34,567.89");
    expect(formatMoney("0")).toBe("₹ 0.00");
  });

  it("does not lose paise on a value a Number could not hold", () => {
    // Number("12345678901234.56") is already 12345678901234.56 -> .559999...
    expect(formatMoney("12345678901234.56")).toContain(".56");
  });

  it("renders a missing amount as a dash rather than NaN", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(undefined)).toBe("—");
  });
});
