/**
 * Assets — the screens.
 *
 * Only the axios instance is mocked. The HRMS client, the shared Zod schemas
 * and the shared permission matrix are all real, so these also cover the
 * request URLs, the payload shapes and the `{ success, data }` unwrapping.
 *
 * What the UI offers is asserted here; what it is ALLOWED to do is asserted in
 * backend/tests/assets-api.test.js. Both halves read the same matrix.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../../services/api";
import { AssetsPage } from "./AssetsPage";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

const ME = "652f0000000000000000b001";
const OTHER = "652f0000000000000000b002";
const CAT_LAPTOP = "652f0000000000000000a001";
const CAT_PHONE = "652f0000000000000000a002";
const ITEM = "652f0000000000000000d001";
const REQ = "652f0000000000000000e001";

const CATEGORIES = [
  {
    id: CAT_LAPTOP,
    name: "Laptop",
    code: "LAPTOP",
    requiresSerialNumber: true,
    defaultLifespanMonths: 36,
    itemCount: 4,
  },
  {
    id: CAT_PHONE,
    name: "Phone",
    code: "PHONE",
    requiresSerialNumber: false,
    defaultLifespanMonths: 24,
    itemCount: 0,
  },
];

const item = (over = {}) => ({
  id: ITEM,
  categoryId: CAT_LAPTOP,
  categoryName: "Laptop",
  categoryCode: "LAPTOP",
  serialNumber: "C02XL0FQJG5H",
  brand: "Dell",
  model: "XPS 15",
  purchaseDate: "2025-04-01",
  warrantyEnd: "2028-04-01",
  amcEnd: null,
  purchasePrice: "125000.00",
  status: "available",
  notes: null,
  currentAssignment: null,
  assignmentCount: 0,
  createdAt: "2026-01-02T00:00:00.000Z",
  ...over,
});

const assignment = (over = {}) => ({
  id: "652f0000000000000000f001",
  assetItemId: ITEM,
  categoryId: CAT_LAPTOP,
  categoryName: "Laptop",
  serialNumber: "C02XL0FQJG5H",
  brand: "Dell",
  model: "XPS 15",
  employeeId: ME,
  employeeName: "Sam Person",
  assignedAt: "2026-01-05T00:00:00.000Z",
  assignedByName: "Ivan Person",
  conditionOnAssign: "Minor scratch on the lid.",
  returnedAt: null,
  conditionOnReturn: null,
  closedByStatus: null,
  ...over,
});

const request = (over = {}) => ({
  id: REQ,
  employeeId: ME,
  employeeName: "Sam Person",
  isOwnRequest: true,
  categoryId: CAT_LAPTOP,
  categoryName: "Laptop",
  justification: "My current machine will not run the build.",
  status: "submitted",
  decidedByName: null,
  decidedAt: null,
  rejectionReason: null,
  fulfilledAssetItemId: null,
  fulfilledSerialNumber: null,
  fulfilledAt: null,
  createdAt: "2026-01-03T00:00:00.000Z",
  ...over,
});

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

    if (key === "GET /hrms/assets/categories") return envelope(CATEGORIES);
    if (key === "GET /hrms/assets/items") return page([item()]);
    if (key === "GET /hrms/assets/requests") return page([]);
    if (key === "GET /hrms/assets/assignments/me") return envelope({ data: [], outstanding: 0 });
    if (key === "GET /hrms/employees") return page([]);
    if (config.method === "post" || config.method === "patch") return envelope(item());
    if (config.method === "delete") return envelope({ deleted: true });
    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles, employee = { id: ME, managerChain: [] }) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee }),
    implementedModules: [M.DASHBOARD, M.EMPLOYEES, M.EXITS, M.ASSETS],
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/assets" element={<AssetsPage />} />
        <Route path="/hrms/assets/:tab" element={<AssetsPage />} />
      </Routes>
    </MemoryRouter>,
  );

const urlsHit = () => calls.map((c) => `${c.method.toUpperCase()} ${c.url}`);

/**
 * The control inside the drawer, when the trigger that opened it shares a name.
 *
 * The drawer is portalled in after the table, so the last match is the one in
 * it. Picking by position beats renaming a button purely to suit a test.
 */
const inDrawer = (name) => {
  const matches = screen.getAllByRole("button", { name });
  return matches[matches.length - 1];
};

beforeEach(() => {
  useHrmsStore.getState().clear();
  installTransport();
});

// ===========================================================================
// Page shell and gating
// ===========================================================================

describe("the assets page", () => {
  it("renders its title and breadcrumb", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/assets/mine");

    expect(await screen.findByRole("heading", { name: "Assets" })).toBeTruthy();
    expect(screen.getByText("HRMS")).toBeTruthy();
  });

  it("an employee gets My Assets and Requests only", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/assets/mine");

    expect(await screen.findByRole("tab", { name: "My Assets" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Requests" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Inventory" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Categories" })).toBeNull();
  });

  it("an IT admin gets all four", async () => {
    signIn([R.IT_ADMIN]);
    at("/hrms/assets/mine");

    expect(await screen.findByRole("tab", { name: "Inventory" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Categories" })).toBeTruthy();
  });

  it("a gated tab reached by URL is refused WITHOUT firing its request", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/assets/inventory");

    expect(await screen.findByText(/do not have access to this view/i)).toBeTruthy();
    expect(urlsHit()).not.toContain("GET /hrms/assets/items");
  });
});

// ===========================================================================
// My assets
// ===========================================================================

describe("my assets", () => {
  it("says WHICH asset is held, not just when", async () => {
    // The reference's assignment payload carries none of this.
    installTransport({
      "GET /hrms/assets/assignments/me": () =>
        envelope({ data: [assignment()], outstanding: 1 }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/assets/mine");

    expect(await screen.findByText("C02XL0FQJG5H")).toBeTruthy();
    expect(screen.getByText(/Laptop · Dell XPS 15/)).toBeTruthy();
    expect(screen.getByText("Minor scratch on the lid.")).toBeTruthy();
    expect(screen.getByText("In use")).toBeTruthy();
  });

  it("splits current from previously held, and shows the return condition", async () => {
    installTransport({
      "GET /hrms/assets/assignments/me": () =>
        envelope({
          data: [
            assignment(),
            assignment({
              id: "past",
              returnedAt: "2026-02-01T00:00:00.000Z",
              conditionOnReturn: "Charger missing.",
            }),
          ],
          outstanding: 1,
        }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/assets/mine");

    expect(await screen.findByText(/Currently assigned to you/)).toBeTruthy();
    expect(screen.getByText("Previously held")).toBeTruthy();
    // The reference renders this column and can never fill it.
    expect(screen.getByText("Charger missing.")).toBeTruthy();
  });

  it("renders an empty state when nothing is held", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/assets/mine");

    expect(await screen.findByText("No assets assigned to you")).toBeTruthy();
  });

  it("renders an error with a retry that refetches", async () => {
    installTransport({
      "GET /hrms/assets/assignments/me": () => fail(500, { message: "Server error" }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/assets/mine");

    const retry = await screen.findByRole("button", { name: /try again|retry/i });
    const before = calls.length;
    await userEvent.click(retry);
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });
});

// ===========================================================================
// Requests
// ===========================================================================

describe("asset requests", () => {
  it("an employee raises one, and no employeeId is sent", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/assets/requests");

    await userEvent.click(await screen.findByRole("button", { name: /Request an asset/i }));
    await userEvent.selectOptions(
      await screen.findByLabelText("What do you need?"),
      CAT_LAPTOP,
    );
    await userEvent.type(
      screen.getByLabelText("Why do you need it?"),
      "My machine cannot run the build.",
    );
    await userEvent.click(screen.getByRole("button", { name: /Submit request/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "post" && c.url === "/hrms/assets/requests");
      expect(post).toBeTruthy();
      // The server resolves whose request it is from the signed-in actor.
      expect(post.data.employeeId).toBeUndefined();
      expect(post.data.categoryId).toBe(CAT_LAPTOP);
    });
  });

  it("refuses to post an incomplete request", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/assets/requests");

    await userEvent.click(await screen.findByRole("button", { name: /Request an asset/i }));
    await userEvent.click(await screen.findByRole("button", { name: /Submit request/i }));

    await waitFor(() =>
      expect(urlsHit().filter((u) => u === "POST /hrms/assets/requests")).toHaveLength(0),
    );
  });

  it("an employee sees no Employee column and no Decide button", async () => {
    installTransport({ "GET /hrms/assets/requests": () => page([request()]) });
    signIn([R.EMPLOYEE]);
    at("/hrms/assets/requests");

    await screen.findByText("Laptop");
    expect(screen.queryByRole("columnheader", { name: "Employee" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decide" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("an administrator sees the Employee column and the queue actions", async () => {
    installTransport({
      "GET /hrms/assets/requests": () => page([request({ isOwnRequest: false })]),
    });
    signIn([R.IT_ADMIN]);
    at("/hrms/assets/requests");

    expect(await screen.findByRole("columnheader", { name: "Employee" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decide" })).toBeTruthy();
  });

  it("offers NO Decide on the administrator's OWN request", async () => {
    installTransport({
      "GET /hrms/assets/requests": () => page([request({ isOwnRequest: true })]),
    });
    signIn([R.IT_ADMIN]);
    at("/hrms/assets/requests");

    await screen.findByText("Laptop");
    expect(screen.queryByRole("button", { name: "Decide" })).toBeNull();
  });

  it("rejecting requires a reason, and sends it", async () => {
    installTransport({
      "GET /hrms/assets/requests": () => page([request({ isOwnRequest: false })]),
    });
    signIn([R.IT_ADMIN]);
    at("/hrms/assets/requests");

    await userEvent.click(await screen.findByRole("button", { name: "Decide" }));
    await screen.findByLabelText(/Reason/);

    // Rejecting with no reason sends nothing.
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(urlsHit().some((u) => u.includes("/decide"))).toBe(false),
    );

    await userEvent.type(screen.getByLabelText(/Reason/), "Your machine is six months old.");
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url?.includes("/decide"));
      expect(post.data.decision).toBe("reject");
      expect(post.data.reason).toBe("Your machine is six months old.");
    });
  });

  it("approving needs no reason", async () => {
    installTransport({
      "GET /hrms/assets/requests": () => page([request({ isOwnRequest: false })]),
    });
    signIn([R.IT_ADMIN]);
    at("/hrms/assets/requests");

    await userEvent.click(await screen.findByRole("button", { name: "Decide" }));
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url?.includes("/decide"));
      expect(post.data.decision).toBe("approve");
    });
  });

  it("fulfilment offers only AVAILABLE stock from the requested category", async () => {
    installTransport({
      "GET /hrms/assets/requests": () =>
        page([request({ isOwnRequest: false, status: "approved" })]),
      "GET /hrms/assets/items": (config) => {
        // The screen must ask the server to narrow it, not filter locally.
        expect(config.params.categoryId).toBe(CAT_LAPTOP);
        expect(config.params.status).toBe("available");
        return page([item()]);
      },
    });
    signIn([R.IT_ADMIN]);
    at("/hrms/assets/requests");

    await userEvent.click(await screen.findByRole("button", { name: "Fulfil" }));
    await userEvent.selectOptions(await screen.findByLabelText("Asset to issue"), ITEM);
    await userEvent.click(screen.getByRole("button", { name: /Issue asset/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.url?.includes("/fulfill"));
      expect(post.data.assetItemId).toBe(ITEM);
    });
  });

  it("says so when there is nothing in stock to fulfil with", async () => {
    installTransport({
      "GET /hrms/assets/requests": () =>
        page([request({ isOwnRequest: false, status: "approved" })]),
      "GET /hrms/assets/items": () => page([]),
    });
    signIn([R.IT_ADMIN]);
    at("/hrms/assets/requests");

    await userEvent.click(await screen.findByRole("button", { name: "Fulfil" }));
    expect(await screen.findByText(/Nothing available in this category/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Issue asset/i }).disabled).toBe(true);
  });

  it("cancelling asks first", async () => {
    installTransport({ "GET /hrms/assets/requests": () => page([request()]) });
    signIn([R.EMPLOYEE]);
    at("/hrms/assets/requests");

    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByText(/Cancel this asset request\?/i)).toBeTruthy();
    expect(urlsHit().some((u) => u.includes("/cancel"))).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    await waitFor(() =>
      expect(urlsHit()).toContain(`POST /hrms/assets/requests/${REQ}/cancel`),
    );
  });

  it("filters by status through the SERVER", async () => {
    signIn([R.IT_ADMIN]);
    at("/hrms/assets/requests");

    await screen.findByText(/No asset requests/i);
    await userEvent.selectOptions(screen.getByLabelText("Filter by status"), "approved");

    await waitFor(() => {
      const last = calls.filter((c) => c.url === "/hrms/assets/requests").pop();
      expect(last.params.status).toBe("approved");
    });
  });
});

// ===========================================================================
// Inventory
// ===========================================================================

describe("the inventory", () => {
  const openInventory = async (rows = [item()]) => {
    installTransport({ "GET /hrms/assets/items": () => page(rows) });
    signIn([R.IT_ADMIN]);
    at("/hrms/assets/inventory");
    return screen.findByText("C02XL0FQJG5H");
  };

  it("asks the server to search, filter and page", async () => {
    await openInventory();

    const first = calls.find((c) => c.url === "/hrms/assets/items");
    expect(first.params.page).toBe(1);
    expect(first.params.pageSize).toBe(15);

    await userEvent.type(screen.getByLabelText("Search assets"), "XPS");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      const last = calls.filter((c) => c.url === "/hrms/assets/items").pop();
      expect(last.params.search).toBe("XPS");
    });

    await userEvent.selectOptions(screen.getByLabelText("Filter by status"), "lost");
    await waitFor(() => {
      const last = calls.filter((c) => c.url === "/hrms/assets/items").pop();
      expect(last.params.status).toBe("lost");
    });
  });

  it("offers Assign on an available asset and Return on an assigned one", async () => {
    await openInventory([item()]);
    expect(screen.getByRole("button", { name: "Assign" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Return" })).toBeNull();
  });

  it("the status picker never offers `assigned`", async () => {
    // The reference offers it, producing an asset that reads as issued to
    // nobody.
    await openInventory();

    const picker = screen.getByLabelText(/Set status for C02XL0FQJG5H/);
    expect(within(picker).queryByText("Assigned")).toBeNull();
    expect(within(picker).getByText("Lost")).toBeTruthy();
    expect(within(picker).getByText("In repair")).toBeTruthy();
  });

  it("a destructive status change is confirmed, and warns who is holding it", async () => {
    await openInventory([
      item({
        status: "assigned",
        currentAssignment: {
          id: "a1",
          employeeId: OTHER,
          employeeName: "Otto Person",
          assignedAt: "2026-01-05T00:00:00.000Z",
          conditionOnAssign: null,
        },
      }),
    ]);

    await userEvent.selectOptions(
      screen.getByLabelText(/Set status for C02XL0FQJG5H/),
      "retired",
    );
    expect(await screen.findByText(/Mark this asset retired\?/i)).toBeTruthy();
    expect(screen.getByText(/Otto Person is holding this asset/)).toBeTruthy();
    expect(urlsHit().some((u) => u.includes("/status"))).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      const post = calls.find((c) => c.url?.includes("/status"));
      expect(post.data.status).toBe("retired");
    });
  });

  it("a retired asset cannot have its status changed again", async () => {
    await openInventory([item({ status: "retired" })]);
    expect(screen.getByLabelText(/Set status for C02XL0FQJG5H/).disabled).toBe(true);
  });

  it("assigning posts the employee and the condition", async () => {
    installTransport({
      "GET /hrms/assets/items": () => page([item()]),
      "GET /hrms/employees": () =>
        page([{ id: OTHER, firstName: "Otto", lastName: "Person", employeeCode: "AS-2" }]),
    });
    signIn([R.IT_ADMIN]);
    at("/hrms/assets/inventory");

    await userEvent.click(await screen.findByRole("button", { name: "Assign" }));
    await userEvent.click(await screen.findByRole("button", { name: /Select an employee/i }));
    await userEvent.click(await screen.findByText("Otto Person"));
    await userEvent.type(
      screen.getByLabelText(/Condition on issue/),
      "Scratch on the lid.",
    );
    await userEvent.click(inDrawer("Assign"));

    await waitFor(() => {
      const post = calls.find((c) => c.url === "/hrms/assets/items/assign");
      expect(post).toBeTruthy();
      expect(post.data.assetItemId).toBe(ITEM);
      expect(post.data.employeeId).toBe(OTHER);
      expect(post.data.conditionOnAssign).toBe("Scratch on the lid.");
    });
  });

  it("a return ASKS for the condition and sends it", async () => {
    // The reference's Return button posts an empty body.
    await openInventory([
      item({
        status: "assigned",
        currentAssignment: {
          id: "a1",
          employeeId: OTHER,
          employeeName: "Otto Person",
          assignedAt: "2026-01-05T00:00:00.000Z",
          conditionOnAssign: null,
        },
      }),
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Return" }));
    await userEvent.type(
      await screen.findByLabelText(/Condition on return/),
      "Charger missing.",
    );
    await userEvent.click(screen.getByRole("button", { name: /Record return/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.url?.includes("/return"));
      expect(post.data.conditionOnReturn).toBe("Charger missing.");
    });
  });

  it("adding an asset posts the price as a STRING, exactly as typed", async () => {
    await openInventory();

    await userEvent.click(screen.getByRole("button", { name: /Add asset/i }));
    await userEvent.selectOptions(await screen.findByLabelText("Category"), CAT_PHONE);
    await userEvent.type(screen.getByLabelText("Serial number"), "SN-9");
    await userEvent.type(screen.getByLabelText("Purchase price (₹)"), "0");
    await userEvent.click(inDrawer("Add asset"));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "post" && c.url === "/hrms/assets/items");
      expect(post).toBeTruthy();
      // Zero is a price, and it is a string — the reference sends a number and
      // treats 0 as absent.
      expect(post.data.purchasePrice).toBe("0");
      expect(typeof post.data.purchasePrice).toBe("string");
    });
  });

  it("requires a serial number when the category demands one", async () => {
    await openInventory();

    await userEvent.click(screen.getByRole("button", { name: /Add asset/i }));
    await userEvent.selectOptions(await screen.findByLabelText("Category"), CAT_LAPTOP);
    expect(screen.getByText(/Required for Laptop/)).toBeTruthy();

    await userEvent.click(inDrawer("Add asset"));
    expect(
      await screen.findByText(/A serial number is required for Laptop/),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "post" && c.url === "/hrms/assets/items"),
      ).toHaveLength(0),
    );
  });
});

// ===========================================================================
// Categories
// ===========================================================================

describe("the category catalogue", () => {
  const openCategories = async () => {
    signIn([R.IT_ADMIN]);
    at("/hrms/assets/categories");
    return screen.findByText("Laptop");
  };

  it("lists code, serial requirement, lifespan and item count", async () => {
    await openCategories();

    expect(screen.getByText("LAPTOP")).toBeTruthy();
    expect(screen.getByText("Required")).toBeTruthy();
    expect(screen.getByText("Optional")).toBeTruthy();
    expect(screen.getByText("36 months")).toBeTruthy();
  });

  it("creates one, upper-casing the code", async () => {
    await openCategories();

    await userEvent.click(screen.getByRole("button", { name: /New category/i }));
    await userEvent.type(await screen.findByLabelText("Code"), "monitor");
    await userEvent.type(screen.getByLabelText("Name"), "Monitor");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "post" && c.url === "/hrms/assets/categories",
      );
      expect(post.data.code).toBe("MONITOR");
      expect(post.data.requiresSerialNumber).toBe(true);
    });
  });

  it("will not let the code change on edit", async () => {
    await openCategories();
    await userEvent.click(screen.getByRole("button", { name: "Edit Laptop" }));

    const code = await screen.findByLabelText("Code");
    expect(code.disabled).toBe(true);
    expect(screen.getByText(/cannot change/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "patch");
      expect(patch.data.code).toBeUndefined();
    });
  });

  it("confirms before deleting and explains the in-use rule", async () => {
    await openCategories();
    await userEvent.click(screen.getByRole("button", { name: "Delete Laptop" }));

    expect(await screen.findByText(/Delete Laptop\?/)).toBeTruthy();
    expect(screen.getByText(/cannot be deleted/i)).toBeTruthy();
    expect(urlsHit().some((u) => u.startsWith("DELETE"))).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(urlsHit()).toContain(`DELETE /hrms/assets/categories/${CAT_LAPTOP}`),
    );
  });

  it("says the lifespan is guidance, not enforcement", async () => {
    await openCategories();
    await userEvent.click(screen.getByRole("button", { name: /New category/i }));

    expect(
      await screen.findByText(/Nothing is retired automatically/i),
    ).toBeTruthy();
  });
});
