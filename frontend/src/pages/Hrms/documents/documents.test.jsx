/**
 * Documents — the screens.
 *
 * Only the axios instance is mocked. The HRMS client, the shared Zod schemas
 * and the shared permission matrix are all real, so these also cover the
 * request URLs, the payload shapes and the `{ success, data }` unwrapping.
 *
 * What the UI offers is asserted here; what it is ALLOWED to do is asserted in
 * backend/tests/documents-api.test.js. Both halves read the same matrix.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../../services/api";
import { DocumentsPage } from "./DocumentsPage";
import { formatFileSize } from "../../../services/hrms";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

const ME = "652f0000000000000000b001";
const DOC = "652f0000000000000000d001";
const FOLDER = "652f0000000000000000f001";

const day = (offset) =>
  new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

const FOLDERS = [
  {
    id: FOLDER,
    parentId: null,
    name: "Handbooks",
    visibility: "org",
    roleKeys: [],
    departmentIds: [],
    documentCount: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "652f0000000000000000f002",
    parentId: null,
    name: "Payroll only",
    visibility: "role",
    roleKeys: [R.PAYROLL_ADMIN],
    departmentIds: [],
    documentCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

const doc = (over = {}) => ({
  id: DOC,
  name: "Employee handbook",
  scope: "company",
  employeeId: null,
  employeeName: null,
  folderId: FOLDER,
  folderName: "Handbooks",
  tags: ["hr", "handbook"],
  mimeType: "application/pdf",
  fileSize: 245678,
  originalFilename: "handbook.pdf",
  uploadedByName: "Hana Person",
  uploadedAt: "2026-01-05T00:00:00.000Z",
  policy: null,
  acknowledgedByMe: false,
  acknowledgmentCount: 0,
  isMine: false,
  ...over,
});

const policyDoc = (over = {}) =>
  doc({
    id: "652f0000000000000000d002",
    name: "Code of conduct",
    policy: {
      requiresAcknowledgment: true,
      requiresSignature: false,
      effectiveFrom: day(-2),
      expiresAt: null,
      targetRoleKeys: [],
      isLive: true,
      isExpired: false,
    },
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

    if (key === "GET /hrms/documents/folders") return envelope(FOLDERS);
    if (key === "GET /hrms/documents") return page([doc()]);
    if (key === "GET /hrms/documents/me") return page([]);
    if (key === "GET /hrms/documents/policies/pending")
      return envelope({ data: [], pending: 0 });
    if (key === "GET /hrms/org/departments") return envelope([]);
    if (config.method === "post" || config.method === "patch") return envelope(doc());
    if (config.method === "delete") return envelope({ deleted: true });
    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles, employee = { id: ME, managerChain: [] }) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee }),
    implementedModules: [M.DASHBOARD, M.EMPLOYEES, M.DOCUMENTS],
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/documents" element={<DocumentsPage />} />
        <Route path="/hrms/documents/:tab" element={<DocumentsPage />} />
      </Routes>
    </MemoryRouter>,
  );

const urlsHit = () => calls.map((c) => `${c.method.toUpperCase()} ${c.url}`);

/** The control inside a drawer, when the trigger shares its name. */
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

describe("the documents page", () => {
  it("renders its title, and no breadcrumb - a top-level page needs none", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/library");

    expect(await screen.findByRole("heading", { name: "Documents" })).toBeTruthy();
    // A top-level HRMS page carries no breadcrumb: "HRMS > X" above a heading
    // that already reads "X", beside a sidebar already highlighting X, is the
    // same fact three times - and no other module in the portal has one.
    // HrmsPageLayout renders the trail only once it goes deeper than
    // "HRMS > <module>"; the nested employee pages still get theirs.
    expect(screen.queryByRole("navigation", { name: /breadcrumb/i })).toBeNull();
  });

  it("an employee gets three tabs, not Folders", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/library");

    expect(await screen.findByRole("tab", { name: "Company Library" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Policies" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "My Documents" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Folders" })).toBeNull();
  });

  it("HR gets all four", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/documents/library");

    expect(await screen.findByRole("tab", { name: "Folders" })).toBeTruthy();
  });

  it("a gated tab reached by URL is refused WITHOUT firing its request", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/folders");

    expect(await screen.findByText(/do not have access to this view/i)).toBeTruthy();
    expect(urlsHit()).not.toContain("GET /hrms/documents/folders");
  });
});

// ===========================================================================
// Library
// ===========================================================================

describe("the company library", () => {
  it("asks the server for company documents, paged", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/library");

    await screen.findByText("Employee handbook");
    const call = calls.find((c) => c.url === "/hrms/documents");
    expect(call.params.scope).toBe("company");
    expect(call.params.page).toBe(1);
    expect(call.params.pageSize).toBe(15);
  });

  it("shows the file's type and size, and its folder and tags", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/library");

    expect(await screen.findByText("Employee handbook")).toBeTruthy();
    expect(screen.getByText(/PDF · 239\.9 KB/)).toBeTruthy();
    expect(screen.getByText("hr")).toBeTruthy();

    // "Handbooks" is also an option in the folder filter, so assert the cell.
    const row = screen.getByText("Employee handbook").closest("tr");
    expect(within(row).getByText("Handbooks")).toBeTruthy();
  });

  it("searches and filters through the SERVER", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/library");

    await screen.findByText("Employee handbook");
    await userEvent.type(screen.getByLabelText("Search documents"), "leave");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      const last = calls.filter((c) => c.url === "/hrms/documents").pop();
      expect(last.params.search).toBe("leave");
    });

    await userEvent.selectOptions(screen.getByLabelText("Filter by folder"), FOLDER);
    await waitFor(() => {
      const last = calls.filter((c) => c.url === "/hrms/documents").pop();
      expect(last.params.folderId).toBe(FOLDER);
    });
  });

  it("an employee gets no upload, publish or delete control", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/library");

    await screen.findByText("Employee handbook");
    expect(screen.queryByRole("button", { name: /Upload/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Publish/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete Employee handbook/i })).toBeNull();
    // Reading is what the library is for.
    expect(screen.getByRole("button", { name: /Open/i })).toBeTruthy();
  });

  it("HR gets upload, publish and delete", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/documents/library");

    await screen.findByText("Employee handbook");
    expect(screen.getByRole("button", { name: /Upload/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Publish/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Delete Employee handbook/i })).toBeTruthy();
  });

  it("deleting asks first", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/documents/library");

    await userEvent.click(
      await screen.findByRole("button", { name: /Delete Employee handbook/i }),
    );
    expect(await screen.findByText(/Delete Employee handbook\?/)).toBeTruthy();
    expect(urlsHit().some((u) => u.startsWith("DELETE"))).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(urlsHit()).toContain(`DELETE /hrms/documents/${DOC}`));
  });

  it("renders an error with a retry that refetches", async () => {
    installTransport({ "GET /hrms/documents": () => fail(500, { message: "Server error" }) });
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/library");

    const retry = await screen.findByRole("button", { name: /try again|retry/i });
    const before = calls.length;
    await userEvent.click(retry);
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it("renders an empty state", async () => {
    installTransport({ "GET /hrms/documents": () => page([]) });
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/library");

    expect(await screen.findByText("Nothing in the library yet")).toBeTruthy();
  });
});

// ===========================================================================
// Opening a file
// ===========================================================================

describe("opening a document", () => {
  it("fetches a short-lived URL rather than linking at the bytes", async () => {
    // The reference points an anchor at a streaming endpoint that echoes the
    // client-supplied content type with Content-Disposition: inline.
    const opened = [];
    vi.spyOn(window, "open").mockImplementation((url) => opened.push(url));

    installTransport({
      [`GET /hrms/documents/${DOC}/url`]: () =>
        envelope({ url: "https://signed.example/doc", expiresInSeconds: 300, name: "Handbook" }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/library");

    const open = await screen.findByRole("button", { name: /Open/i });
    expect(open.tagName).toBe("BUTTON");
    await userEvent.click(open);

    await waitFor(() => expect(opened).toContain("https://signed.example/doc"));
    window.open.mockRestore();
  });

  it("never puts a storage key in the page", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/documents/library");

    await screen.findByText("Employee handbook");
    // `hrms/` alone would match the route prefix in every nav link, so assert
    // the storage prefixes and the field name themselves.
    expect(document.body.innerHTML).not.toContain("hrms/employees/documents");
    expect(document.body.innerHTML).not.toContain("hrms/company");
    expect(document.body.innerHTML).not.toContain("storageKey");
  });
});

// ===========================================================================
// My documents
// ===========================================================================

describe("my documents", () => {
  it("uses the dedicated endpoint, not a filtered download of everything", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/mine");

    await screen.findByText("No personal documents yet");
    expect(urlsHit()).toContain("GET /hrms/documents/me");
    expect(urlsHit()).not.toContain("GET /hrms/documents");
  });

  it("uploads to my OWN repository, naming me explicitly", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/mine");

    await userEvent.click(await screen.findByRole("button", { name: /Upload/i }));

    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "pan.pdf", {
      type: "application/pdf",
    });
    await userEvent.upload(screen.getByLabelText(/Choose a file to upload/i), file);
    await userEvent.click(inDrawer("Upload"));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "post" && c.url === "/hrms/documents");
      expect(post).toBeTruthy();
      expect(post.data instanceof FormData).toBe(true);
      expect(post.data.get("employeeId")).toBe(ME);
      // A personal document never goes into a shared folder.
      expect(post.data.get("folderId")).toBeNull();
    });
  });

  it("defaults the name from the chosen file, and refuses an empty form", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/mine");

    await userEvent.click(await screen.findByRole("button", { name: /Upload/i }));
    await userEvent.click(inDrawer("Upload"));
    expect(await screen.findByText(/Choose a file to upload\./)).toBeTruthy();
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "post")).toHaveLength(0),
    );

    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "pan-card.pdf", {
      type: "application/pdf",
    });
    await userEvent.upload(screen.getByLabelText(/Choose a file to upload/i), file);
    expect(screen.getByLabelText("Name").value).toBe("pan-card");
  });

  it("offers no folder picker for a personal upload", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/mine");

    await userEvent.click(await screen.findByRole("button", { name: /Upload/i }));
    await screen.findByLabelText("Name");
    expect(screen.queryByLabelText(/^Folder/)).toBeNull();
  });
});

// ===========================================================================
// Policies
// ===========================================================================

describe("policies", () => {
  const withPolicies = (rows) => ({
    "GET /hrms/documents": (config) =>
      config.params?.policiesOnly === "true" ? page(rows) : page([doc()]),
  });

  it("asks only for policies, and excludes expired ones by default", async () => {
    installTransport(withPolicies([policyDoc()]));
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/policies");

    await screen.findByText("Code of conduct");
    const call = calls.filter((c) => c.url === "/hrms/documents").pop();
    expect(call.params.policiesOnly).toBe("true");
    expect(call.params.includeExpired).toBeUndefined();
  });

  it("shows the expiry column the reference does not have", async () => {
    installTransport(withPolicies([policyDoc({ policy: {
      requiresAcknowledgment: true,
      requiresSignature: false,
      effectiveFrom: day(-5),
      expiresAt: day(30),
      targetRoleKeys: [],
      isLive: true,
      isExpired: false,
    } })]));
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/policies");

    expect(await screen.findByRole("columnheader", { name: "Expires" })).toBeTruthy();
    expect(screen.getByText("Action needed")).toBeTruthy();
  });

  it("offers Acknowledge on a live policy and NOT on an expired one", async () => {
    // The reference never reads expiry, so its Acknowledge button is live
    // forever.
    installTransport(
      withPolicies([
        policyDoc(),
        policyDoc({
          id: "652f0000000000000000d003",
          name: "Old policy",
          policy: {
            requiresAcknowledgment: true,
            requiresSignature: false,
            effectiveFrom: day(-40),
            expiresAt: day(-1),
            targetRoleKeys: [],
            isLive: false,
            isExpired: true,
          },
        }),
      ]),
    );
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/policies");

    await screen.findByText("Old policy");
    expect(screen.getAllByRole("button", { name: "Acknowledge" })).toHaveLength(1);
    expect(screen.getByText("Expired")).toBeTruthy();
  });

  it("offers no Acknowledge on one already acknowledged", async () => {
    installTransport(withPolicies([policyDoc({ acknowledgedByMe: true })]));
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/policies");

    await screen.findByText("Code of conduct");
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
    expect(screen.getByText("Acknowledged")).toBeTruthy();
  });

  it("acknowledges a plain policy with no signature", async () => {
    installTransport(withPolicies([policyDoc()]));
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/policies");

    await userEvent.click(await screen.findByRole("button", { name: "Acknowledge" }));
    await userEvent.click(await screen.findByRole("button", { name: /I acknowledge/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.url?.includes("/acknowledge"));
      expect(post).toBeTruthy();
      expect(post.data.signatureName).toBeUndefined();
    });
  });

  it("a policy needing a signature demands a typed name", async () => {
    installTransport(
      withPolicies([
        policyDoc({
          policy: {
            requiresAcknowledgment: true,
            requiresSignature: true,
            effectiveFrom: day(-1),
            expiresAt: null,
            targetRoleKeys: [],
            isLive: true,
            isExpired: false,
          },
        }),
      ]),
    );
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/policies");

    await userEvent.click(await screen.findByRole("button", { name: "Acknowledge" }));
    await userEvent.click(await screen.findByRole("button", { name: /I acknowledge/i }));

    // The label says the same thing, so assert on the error paragraph.
    await waitFor(() =>
      expect(
        screen.getAllByText(/Type your full name to sign/i).length,
      ).toBeGreaterThan(1),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.url?.includes("/acknowledge"))).toHaveLength(0),
    );

    await userEvent.type(screen.getByLabelText(/Type your full name/i), "Sam Person");
    await userEvent.click(screen.getByRole("button", { name: /I acknowledge/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.url?.includes("/acknowledge"));
      expect(post.data.signatureName).toBe("Sam Person");
    });
  });

  it("HR publishes a policy with an effective date and an expiry", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/documents/library");

    await userEvent.click(await screen.findByRole("button", { name: /Publish/i }));
    const expires = await screen.findByLabelText(/Expires/);
    await userEvent.clear(expires);
    await userEvent.type(expires, day(60));
    await userEvent.click(screen.getByRole("button", { name: /Publish policy/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === `/hrms/documents/${DOC}/policy`);
      expect(post).toBeTruthy();
      expect(post.data.requiresAcknowledgment).toBe(true);
      expect(post.data.expiresAt).toBe(day(60));
      expect(post.data.targetRoleKeys).toEqual([]);
    });
  });

  it("refuses to publish an expiry that precedes the effective date", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/documents/library");

    await userEvent.click(await screen.findByRole("button", { name: /Publish/i }));
    const expires = await screen.findByLabelText(/Expires/);
    await userEvent.clear(expires);
    await userEvent.type(expires, day(-10));
    await userEvent.click(screen.getByRole("button", { name: /Publish policy/i }));

    await waitFor(() =>
      expect(calls.filter((c) => c.url?.includes("/policy"))).toHaveLength(0),
    );
  });

  it("HR opens the acknowledgment register; an employee gets no such control", async () => {
    installTransport({
      ...withPolicies([policyDoc({ acknowledgmentCount: 3 })]),
      [`GET /hrms/documents/652f0000000000000000d002/acknowledgments`]: () =>
        envelope({
          documentId: "652f0000000000000000d002",
          total: 5,
          completed: 3,
          outstanding: [{ employeeId: "x", name: "Otto Person", employeeCode: "DC-3" }],
          acknowledged: [
            {
              employeeId: ME,
              name: "Sam Person",
              acknowledgedAt: "2026-01-06T00:00:00.000Z",
              signatureName: "Sam Person",
            },
          ],
        }),
    });

    signIn([R.HR_ADMIN]);
    at("/hrms/documents/policies");

    await userEvent.click(await screen.findByRole("button", { name: "3" }));
    expect(await screen.findByText(/3 of 5/)).toBeTruthy();
    expect(screen.getByText("Otto Person")).toBeTruthy();
    expect(screen.getByText(/signed “Sam Person”/)).toBeTruthy();
  });

  it("an employee has no register control", async () => {
    installTransport(withPolicies([policyDoc({ acknowledgmentCount: 3 })]));
    signIn([R.EMPLOYEE]);
    at("/hrms/documents/policies");

    await screen.findByText("Code of conduct");
    expect(screen.queryByRole("button", { name: "3" })).toBeNull();
  });
});

// ===========================================================================
// Folders
// ===========================================================================

describe("the folder tree", () => {
  const openFolders = async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/documents/folders");
    return screen.findByText("Handbooks");
  };

  it("shows who can see each folder", async () => {
    await openFolders();

    expect(screen.getByText("Everyone")).toBeTruthy();
    expect(screen.getByText("Specific roles")).toBeTruthy();
    expect(screen.getByText(/payroll admin/)).toBeTruthy();
  });

  it("does NOT offer the reference's dead `employee` visibility", async () => {
    // Its own access check returns false for that value unconditionally, so
    // such a folder is invisible to everyone but HR, permanently.
    await openFolders();
    await userEvent.click(screen.getByRole("button", { name: /New folder/i }));

    const select = await screen.findByLabelText("Who can see it");
    expect(within(select).getByText("Everyone")).toBeTruthy();
    expect(within(select).getByText("Specific roles")).toBeTruthy();
    expect(within(select).getByText("Specific departments")).toBeTruthy();
    expect(within(select).queryByText(/Employee only/i)).toBeNull();
  });

  it("a role-scoped folder must name a role before it can be saved", async () => {
    await openFolders();
    await userEvent.click(screen.getByRole("button", { name: /New folder/i }));

    await userEvent.type(await screen.findByLabelText("Name"), "Finance only");
    await userEvent.selectOptions(screen.getByLabelText("Who can see it"), "role");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/Choose at least one role/i)).toBeTruthy();
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "post")).toHaveLength(0),
    );

    await userEvent.click(screen.getByLabelText(/payroll admin/));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "post" && c.url === "/hrms/documents/folders",
      );
      expect(post).toBeTruthy();
      expect(post.data.visibility).toBe("role");
      expect(post.data.roleKeys).toContain(R.PAYROLL_ADMIN);
    });
  });

  it("deleting a folder asks first and explains the in-use rule", async () => {
    await openFolders();
    await userEvent.click(screen.getByRole("button", { name: "Delete Handbooks" }));

    expect(await screen.findByText(/Delete Handbooks\?/)).toBeTruthy();
    expect(screen.getByText(/cannot be deleted/i)).toBeTruthy();
    expect(urlsHit().some((u) => u.startsWith("DELETE"))).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(urlsHit()).toContain(`DELETE /hrms/documents/folders/${FOLDER}`),
    );
  });
});

// ===========================================================================
// Formatting
// ===========================================================================

describe("formatFileSize", () => {
  it("matches the reference's thresholds", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.00 MB");
  });

  it("renders a missing size as a dash rather than NaN", () => {
    expect(formatFileSize(undefined)).toBe("—");
    expect(formatFileSize(null)).toBe("0 B");
  });
});
