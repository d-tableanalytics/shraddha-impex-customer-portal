/**
 * Hiring — the page shell, tab gating, each tab's rendering, and the
 * candidate-facing careers pages.
 *
 * Only the axios instances are mocked. The HRMS client, the public careers
 * client, the shared Zod schemas and the shared permission matrix are all real,
 * so these cover the request URLs, the `{ success, data }` unwrapping, the
 * permission gating and the form validation as well as the rendering.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

// The careers pages deliberately use their own credential-free axios instance
// (see `services/careers.js`), so it is mocked separately — and the separation
// is itself asserted below.
vi.mock("axios", () => {
  const request = vi.fn();
  return { default: { create: () => ({ request }), __request: request } };
});

import axios from "axios";
import { api } from "../../../services/api";
import { HiringPage } from "./HiringPage";
import { CareersHome } from "../../Careers/CareersHome";
import { CareersRolePage } from "../../Careers/CareersRolePage";
import { OfferPage } from "../../Careers/OfferPage";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUISITIONS = {
  data: [
    {
      id: "rq1",
      title: "Senior Backend Engineer",
      departmentId: "d1",
      departmentName: "Engineering",
      locationId: "l1",
      locationName: "Indore",
      headcount: 2,
      budgetMin: 1800000,
      budgetMax: 2400000,
      businessJustification: "Backfill plus growth",
      status: "draft",
      cancellationReason: null,
      postingCount: 0,
      applicationCount: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    {
      id: "rq2",
      title: "Product Designer",
      departmentId: "d2",
      departmentName: "Design",
      locationId: null,
      locationName: null,
      headcount: 1,
      budgetMin: null,
      budgetMax: null,
      businessJustification: null,
      status: "open",
      cancellationReason: null,
      postingCount: 1,
      applicationCount: 4,
      createdAt: "2026-07-01T00:00:00.000Z",
    },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};

const CANDIDATES = {
  data: [
    {
      id: "c1",
      name: "Asha Menon",
      email: "asha@example.com",
      phone: "+91 90000 00001",
      hasResume: true,
      resumeFilename: "asha.pdf",
      source: "referral",
      currentEmployer: "Northwind",
      expectedSalary: 2100000,
      noticePeriodDays: 60,
      createdAt: "2026-08-02T00:00:00.000Z",
      applicationCount: 1,
    },
    {
      id: "c2",
      name: "Ravi Kumar",
      email: "ravi@example.com",
      phone: null,
      hasResume: false,
      resumeFilename: null,
      source: "careers",
      currentEmployer: null,
      expectedSalary: null,
      noticePeriodDays: null,
      createdAt: "2026-08-03T00:00:00.000Z",
      applicationCount: 0,
    },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};

const application = (over = {}) => ({
  id: "ap1",
  candidateId: "c1",
  candidateName: "Asha Menon",
  candidateEmail: "asha@example.com",
  requisitionId: "rq2",
  requisitionTitle: "Product Designer",
  stage: "screening",
  appliedAt: "2026-08-02T00:00:00.000Z",
  currentStageAt: "2026-08-04T00:00:00.000Z",
  rejectionReason: null,
  stageHistory: [],
  interviewCount: 1,
  hasOffer: false,
  ...over,
});

const BOARD = {
  requisitionId: "rq2",
  total: 2,
  loaded: 2,
  columns: [
    {
      stage: "applied",
      applications: [
        application({ id: "ap0", stage: "applied", interviewCount: 0, candidateName: "Ravi Kumar", candidateEmail: "ravi@example.com" }),
      ],
    },
    { stage: "screening", applications: [application()] },
    { stage: "interview", applications: [] },
    { stage: "offer", applications: [] },
    { stage: "hired", applications: [] },
    { stage: "rejected", applications: [] },
  ],
};

const MY_INTERVIEWS = {
  data: [
    {
      id: "iv1",
      applicationId: "ap1",
      candidateName: "Asha Menon",
      requisitionTitle: "Product Designer",
      round: 2,
      panel: [
        { employeeId: "e1", name: "Kiran Rao" },
        { employeeId: "e2", name: "Meera Nair" },
      ],
      scheduledAt: "2026-09-10T09:30:00.000Z",
      durationMinutes: 45,
      meetingLink: "https://meet.example.com/abc",
      status: "scheduled",
      feedbackCount: 0,
      awaitingMyFeedback: true,
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

const POSTINGS = {
  data: [
    {
      id: "po1",
      requisitionId: "rq2",
      requisitionTitle: "Product Designer",
      publicSlug: "product-designer-a1b2c3d4",
      description: "We are hiring a Product Designer to join the team.",
      requirements: "3-5 years of relevant experience",
      boardIntegrations: ["LinkedIn"],
      publishedAt: "2026-08-05T00:00:00.000Z",
      closedAt: null,
      isLive: true,
      createdAt: "2026-08-04T00:00:00.000Z",
    },
    {
      id: "po2",
      requisitionId: "rq1",
      requisitionTitle: "Senior Backend Engineer",
      publicSlug: "senior-backend-engineer-99887766",
      description: "Draft advert copy.",
      requirements: "Draft requirements.",
      boardIntegrations: [],
      publishedAt: null,
      closedAt: null,
      isLive: false,
      createdAt: "2026-08-06T00:00:00.000Z",
    },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};

const OFFERS = {
  data: [
    {
      id: "of1",
      applicationId: "ap1",
      candidateName: "Asha Menon",
      candidateEmail: "asha@example.com",
      requisitionTitle: "Product Designer",
      ctc: 2200000,
      joiningDate: "2026-10-01",
      designation: "Senior Product Designer",
      negotiationNotes: "Matched a competing offer",
      state: "draft",
      sentAt: null,
      acceptedAt: null,
      rejectedAt: null,
      rejectionReason: null,
      expiresAt: null,
      signature: null,
      createdAt: "2026-08-20T00:00:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

let calls = [];
const envelope = (payload) => ({ data: { success: true, data: payload } });

function installTransport(overrides = {}) {
  calls = [];
  api.request.mockImplementation(async (config) => {
    calls.push(config);
    const key = `${config.method.toUpperCase()} ${config.url}`;
    if (overrides[key]) return overrides[key](config);

    if (key === "GET /hrms/hiring/requisitions") return envelope(REQUISITIONS);
    if (key === "GET /hrms/hiring/candidates") return envelope(CANDIDATES);
    if (key === "GET /hrms/hiring/applications") return envelope({ ...BOARD, data: [application()], total: 1, page: 1, pageSize: 25 });
    // The picker defaults to the first requisition in the list, so both are
    // stubbed rather than relying on which one that happens to be.
    if (key === "GET /hrms/hiring/requisitions/rq1/pipeline")
      return envelope({ ...BOARD, requisitionId: "rq1" });
    if (key === "GET /hrms/hiring/requisitions/rq2/pipeline") return envelope(BOARD);
    if (key === "GET /hrms/hiring/interviews/mine") return envelope(MY_INTERVIEWS);
    if (key === "GET /hrms/hiring/interviews") return envelope(MY_INTERVIEWS);
    if (key === "GET /hrms/hiring/postings") return envelope(POSTINGS);
    if (key === "GET /hrms/hiring/offers") return envelope(OFFERS);
    if (key === "GET /hrms/employees") return envelope({ data: [], total: 0, page: 1, pageSize: 25 });
    if (key === "GET /hrms/org/departments") return envelope([]);
    if (key === "GET /hrms/org/locations") return envelope([]);

    throw new Error(`unstubbed: ${key}`);
  });
}

/** The careers instance — a different transport, deliberately. */
const careersRequest = axios.__request;
const publicOk = (payload) => ({ data: { success: true, data: payload } });

const signIn = (roles) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee: { id: "e1" } }),
    implementedModules: [M.DASHBOARD, M.HIRING],
    loaded: true,
    loading: false,
    error: null,
  });

/**
 * The overlay a Modal renders into.
 *
 * `Modal` portals to document.body and carries no `role="dialog"`, so scoping a
 * query to one means finding it by its heading and walking up to the overlay.
 * Scoping matters here: several dialogs repeat the label of the button that
 * opened them.
 */
const dialogTitled = (title) =>
  screen.getByRole("heading", { name: title }).closest("div.fixed");

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/hiring" element={<HiringPage />} />
        <Route path="/hrms/hiring/:tab" element={<HiringPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  useHrmsStore.getState().clear();
  installTransport();
  careersRequest.mockReset();
});

// ===========================================================================
// Shell and tab gating
// ===========================================================================

describe("the page shell", () => {
  it("renders the title and subtitle", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/requisitions");
    expect(await screen.findByRole("heading", { name: "Hiring" })).toBeTruthy();
    expect(screen.getByText(/Requisitions, the candidate pipeline/i)).toBeTruthy();
  });

  it("gives a recruiter every tab, in the funnel's order", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/requisitions");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Requisitions",
      "Candidates",
      "Pipeline",
      "My interviews",
      "Postings",
      "Offers",
    ]);
  });

  it("gives a panellist only their own interviews", async () => {
    // The manager grant is `hiring:view:team` — the matrix calls it the
    // interviewer view. It must not open the board or the recruiter tabs.
    signIn([R.MANAGER]);
    at("/hrms/hiring/interviews");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["My interviews"]);
  });

  it("gives an auditor the board but no way to change anything", async () => {
    signIn([R.AUDITOR]);
    at("/hrms/hiring/pipeline");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Pipeline", "My interviews"]);
    await screen.findByText("Applied");
    expect(screen.queryByRole("button", { name: /Add candidate to pipeline/i })).toBeNull();
  });

  it("redirects a tab the viewer has no grant for, without firing its request", async () => {
    signIn([R.MANAGER]);
    at("/hrms/hiring/requisitions");
    // Falls back to the only tab a panellist can use.
    await screen.findByText(/No interviews assigned to you|Asha Menon/);
    expect(calls.some((c) => String(c.url).includes("/hiring/requisitions"))).toBe(false);
  });

  it("redirects the bare module path to the first usable tab", async () => {
    signIn([R.RECRUITER]);
    render(
      <MemoryRouter initialEntries={["/hrms/hiring"]}>
        <Routes>
          <Route path="/hrms/hiring" element={<HiringPage />} />
          <Route path="/hrms/hiring/:tab" element={<HiringPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Senior Backend Engineer")).toBeTruthy();
  });
});

// ===========================================================================
// Requisitions
// ===========================================================================

describe("requisitions", () => {
  it("lists roles with their budget range, status and pipeline counts", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/requisitions");

    const row = (await screen.findByText("Senior Backend Engineer")).closest("tr");
    expect(within(row).getByText("Engineering · Indore")).toBeTruthy();
    expect(within(row).getByText("2")).toBeTruthy();
    expect(within(row).getByText(/₹ 18,00,000\s*–\s*₹ 24,00,000/)).toBeTruthy();
    expect(within(row).getByText("draft")).toBeTruthy();
    expect(within(row).getByText(/0 applicants/)).toBeTruthy();
  });

  it("offers Approve only on a draft, and Cancel only while it is still live", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/requisitions");

    const draft = (await screen.findByText("Senior Backend Engineer")).closest("tr");
    expect(within(draft).getByRole("button", { name: /Approve/ })).toBeTruthy();

    const open = screen.getByText("Product Designer").closest("tr");
    expect(within(open).queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(within(open).getByRole("button", { name: /Cancel/ })).toBeTruthy();
  });

  it("surfaces the server's self-approval refusal rather than swallowing it", async () => {
    signIn([R.RECRUITER]);
    installTransport({
      "POST /hrms/hiring/requisitions/rq1/approve": () =>
        Promise.reject({
          response: {
            status: 403,
            data: { success: false, message: "You raised this requisition, so somebody else must approve it." },
          },
        }),
    });
    at("/hrms/hiring/requisitions");

    const draft = (await screen.findByText("Senior Backend Engineer")).closest("tr");
    await userEvent.click(within(draft).getByRole("button", { name: /Approve/ }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/somebody else must approve it/i);
  });

  it("refuses to cancel without a reason, before any request is sent", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/requisitions");

    const open = (await screen.findByText("Product Designer")).closest("tr");
    await userEvent.click(within(open).getByRole("button", { name: /Cancel/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel requisition" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/Say why/i);
    expect(calls.some((c) => String(c.url).includes("/status"))).toBe(false);
  });

  it("validates the new-requisition form against the shared schema", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/requisitions");

    await userEvent.click(await screen.findByRole("button", { name: /Raise requisition/ }));
    const dialog = dialogTitled("Raise a requisition");

    // Budget inverted — the rule lives in the schema, not in the service.
    await userEvent.type(within(dialog).getByLabelText("Role title"), "Data Analyst");
    await userEvent.type(within(dialog).getByLabelText("Budget from"), "900000");
    await userEvent.type(within(dialog).getByLabelText("Budget to"), "500000");
    await userEvent.click(within(dialog).getByRole("button", { name: "Raise requisition" }));

    expect(
      await within(dialog).findByText(/minimum budget cannot exceed the maximum/i),
    ).toBeTruthy();
    expect(calls.some((c) => c.method === "post" && c.url === "/hrms/hiring/requisitions")).toBe(false);
  });
});

// ===========================================================================
// Candidates
// ===========================================================================

describe("candidates", () => {
  it("lists people with their source and application count", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/candidates");

    const row = (await screen.findByText("Asha Menon")).closest("tr");
    expect(within(row).getByText("asha@example.com")).toBeTruthy();
    expect(within(row).getByText("Referral")).toBeTruthy();
    expect(within(row).getByText("1 application")).toBeTruthy();
    expect(within(row).getByText("₹ 21,00,000")).toBeTruthy();
  });

  it("never puts a résumé URL in the listing — it asks for one on click", async () => {
    signIn([R.RECRUITER]);
    const open = vi.fn();
    vi.stubGlobal("open", open);
    installTransport({
      "GET /hrms/hiring/candidates/c1/resume-url": () =>
        envelope({ url: "https://s3.example.com/signed", expiresIn: 300 }),
    });
    at("/hrms/hiring/candidates");

    await screen.findByText("Asha Menon");
    // Nothing was fetched for the résumé while merely listing.
    expect(calls.some((c) => String(c.url).includes("resume-url"))).toBe(false);

    const row = screen.getByText("Asha Menon").closest("tr");
    await userEvent.click(within(row).getByRole("button", { name: /Open/ }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === "/hrms/hiring/candidates/c1/resume-url")).toBe(true),
    );
    expect(open).toHaveBeenCalledWith(
      "https://s3.example.com/signed",
      "_blank",
      "noopener,noreferrer",
    );
    vi.unstubAllGlobals();
  });

  it("shows no résumé control for a candidate who has not attached one", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/candidates");
    const row = (await screen.findByText("Ravi Kumar")).closest("tr");
    expect(within(row).getByText("Not attached")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /Open/ })).toBeNull();
  });

  it("refuses to post a candidate without a name", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/candidates");

    await userEvent.click(await screen.findByRole("button", { name: /Add candidate/ }));
    const dialog = dialogTitled("Add a candidate");
    // A well-formed email, so the browser's own `type="email"` check passes and
    // the shared schema is what actually refuses this.
    await userEvent.type(within(dialog).getByLabelText("Email"), "someone@example.com");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save candidate" }));

    expect(await within(dialog).findByText(/A name is required/i)).toBeTruthy();
    expect(calls.some((c) => c.method === "post" && c.url === "/hrms/hiring/candidates")).toBe(false);
  });

  it("posts exactly the fields the shared schema allows, and defaults the source", async () => {
    signIn([R.RECRUITER]);
    installTransport({
      "POST /hrms/hiring/candidates": () => envelope({ id: "c9" }),
    });
    at("/hrms/hiring/candidates");

    await userEvent.click(await screen.findByRole("button", { name: /Add candidate/ }));
    const dialog = dialogTitled("Add a candidate");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Nikhil Shah");
    await userEvent.type(within(dialog).getByLabelText("Email"), "nikhil@example.com");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save candidate" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "post" && c.url === "/hrms/hiring/candidates");
      expect(post.data).toEqual({
        name: "Nikhil Shah",
        email: "nikhil@example.com",
        source: "manual",
      });
    });
  });
});

// ===========================================================================
// Pipeline
// ===========================================================================

describe("the pipeline board", () => {
  it("draws every stage as a column, in the funnel's order", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/pipeline");

    await screen.findByText("Asha Menon");
    const headings = screen
      .getAllByRole("region")
      .map((s) => s.getAttribute("aria-label"));
    expect(headings).toEqual([
      "Applied",
      "Screening",
      "Interview",
      "Offer",
      "Hired",
      "Rejected",
    ]);
  });

  it("offers exactly one forward move — the next stage, never a jump", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/pipeline");

    const screening = await screen.findByRole("region", { name: "Screening" });
    // From `screening` the only forward move is `interview`.
    expect(within(screening).getByRole("button", { name: /Interview/ })).toBeTruthy();
    expect(within(screening).queryByRole("button", { name: /^Offer/ })).toBeNull();
  });

  it("moves a card forward through the API, not by local state", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/pipeline");

    const screening = await screen.findByRole("region", { name: "Screening" });
    await userEvent.click(within(screening).getByRole("button", { name: /Interview/ }));

    await waitFor(() => {
      const move = calls.find((c) => c.url === "/hrms/hiring/applications/ap1/move");
      expect(move?.data).toEqual({ stage: "interview", rejectionReason: undefined });
    });
  });

  it("will not reject without a reason", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/pipeline");

    const screening = await screen.findByRole("region", { name: "Screening" });
    await userEvent.click(within(screening).getByRole("button", { name: /Reject Asha Menon/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/Give a reason/i);
    expect(calls.some((c) => String(c.url).includes("/move"))).toBe(false);
  });

  it("shows no move controls to a viewer who cannot edit", async () => {
    signIn([R.AUDITOR]);
    at("/hrms/hiring/pipeline");

    const screening = await screen.findByRole("region", { name: "Screening" });
    expect(within(screening).getByText("Asha Menon")).toBeTruthy();
    expect(within(screening).queryByRole("button", { name: /Interview/ })).toBeNull();
    expect(within(screening).queryByRole("button", { name: /Reject/ })).toBeNull();
  });
});

// ===========================================================================
// Interviews
// ===========================================================================

describe("interviews", () => {
  it("asks for the caller's own panels with no id in the request", async () => {
    signIn([R.MANAGER]);
    at("/hrms/hiring/interviews");

    await screen.findByText("Asha Menon");
    const call = calls.find((c) => String(c.url).includes("/interviews/mine"));
    expect(call.url).toBe("/hrms/hiring/interviews/mine");
    expect(JSON.stringify(call.params ?? {})).not.toContain("e1");
  });

  it("flags a review the panellist still owes", async () => {
    signIn([R.MANAGER]);
    at("/hrms/hiring/interviews");
    expect(await screen.findByText("Your review is due")).toBeTruthy();
  });

  it("gives a recruiter both sub-tabs, and a panellist only their own", async () => {
    signIn([R.MANAGER]);
    const view = at("/hrms/hiring/interviews");
    await screen.findByText("Asha Menon");
    expect(screen.queryByRole("tab", { name: "All interviews" })).toBeNull();
    view.unmount();

    signIn([R.RECRUITER]);
    at("/hrms/hiring/interviews");
    expect(await screen.findByRole("tab", { name: "All interviews" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Assigned to me" })).toBeTruthy();
  });

  it("requires a decision and at least one score before submitting feedback", async () => {
    signIn([R.MANAGER]);
    at("/hrms/hiring/interviews");

    const row = (await screen.findByText("Asha Menon")).closest("tr");
    await userEvent.click(within(row).getByRole("button", { name: /Feedback/ }));

    const dialog = dialogTitled(/^Feedback — Asha Menon/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Submit feedback" }));

    expect(await within(dialog).findByText(/Rate at least one criterion/i)).toBeTruthy();
    expect(calls.some((c) => String(c.url).includes("/feedback"))).toBe(false);
  });

  it("submits ratings, a decision and comments as one payload", async () => {
    signIn([R.MANAGER]);
    installTransport({
      "POST /hrms/hiring/interviews/iv1/feedback": () => envelope({ id: "fb1" }),
    });
    at("/hrms/hiring/interviews");

    const row = (await screen.findByText("Asha Menon")).closest("tr");
    await userEvent.click(within(row).getByRole("button", { name: /Feedback/ }));

    const dialog = dialogTitled(/^Feedback — Asha Menon/);
    await userEvent.type(within(dialog).getByLabelText("Culture"), "4");
    await userEvent.type(within(dialog).getByLabelText("Technical"), "5");
    await userEvent.click(within(dialog).getByText("Choose"));
    await userEvent.click(await within(dialog).findByText("Strong hire"));
    await userEvent.type(within(dialog).getByLabelText("Comments"), "Very strong on systems.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Submit feedback" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === "/hrms/hiring/interviews/iv1/feedback");
      expect(post.data).toEqual({
        ratings: { culture: 4, technical: 5 },
        comments: "Very strong on systems.",
        decision: "strong_hire",
      });
    });
  });
});

// ===========================================================================
// Postings
// ===========================================================================

describe("postings", () => {
  it("distinguishes a live advert from a draft, and offers the matching action", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/postings");

    const live = (await screen.findByText("Product Designer")).closest("tr");
    expect(within(live).getByText("Live")).toBeTruthy();
    expect(within(live).getByRole("button", { name: /Copy link/ })).toBeTruthy();
    expect(within(live).queryByRole("button", { name: "Publish" })).toBeNull();

    const draft = screen.getByText("Senior Backend Engineer").closest("tr");
    expect(within(draft).getByText("Draft")).toBeTruthy();
    expect(within(draft).getByRole("button", { name: "Publish" })).toBeTruthy();
    expect(within(draft).queryByRole("button", { name: /Copy link/ })).toBeNull();
  });

  it("shows the public slug rather than an internal id", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/postings");
    expect(await screen.findByText("/careers/product-designer-a1b2c3d4")).toBeTruthy();
    expect(screen.queryByText("po1")).toBeNull();
  });

  it("confirms before closing, and says that closing is final", async () => {
    signIn([R.RECRUITER]);
    at("/hrms/hiring/postings");

    const live = (await screen.findByText("Product Designer")).closest("tr");
    await userEvent.click(within(live).getByRole("button", { name: "Close" }));

    expect(await screen.findByText(/cannot be undone/i)).toBeTruthy();
    expect(calls.some((c) => String(c.url).includes("/close"))).toBe(false);
  });
});

// ===========================================================================
// Offers
// ===========================================================================

describe("offers", () => {
  it("shows the candidate link exactly once, with a warning that it cannot be shown again", async () => {
    signIn([R.RECRUITER]);
    installTransport({
      "POST /hrms/hiring/offers/of1/send": () =>
        envelope({
          ...OFFERS.data[0],
          state: "sent",
          sentAt: "2026-09-01T00:00:00.000Z",
          expiresAt: "2026-10-01T00:00:00.000Z",
          accessToken: "a".repeat(64),
          candidatePath: `/careers/offer/${"a".repeat(64)}`,
        }),
    });
    at("/hrms/hiring/offers");

    const row = (await screen.findByText("Asha Menon")).closest("tr");
    await userEvent.click(within(row).getByRole("button", { name: /Send/ }));

    const dialog = dialogTitled("Offer sent — copy the link now");
    expect(within(dialog).getByText(/shown/)).toBeTruthy();
    expect(within(dialog).getByText(/cannot be retrieved again/i)).toBeTruthy();
    expect(within(dialog).getByLabelText("Candidate link").value).toContain(
      `/careers/offer/${"a".repeat(64)}`,
    );
  });

  it("offers Send only on a draft", async () => {
    signIn([R.RECRUITER]);
    installTransport({
      "GET /hrms/hiring/offers": () =>
        envelope({
          ...OFFERS,
          data: [{ ...OFFERS.data[0], state: "accepted", signature: { name: "Asha Menon", signedAt: "2026-09-02T00:00:00.000Z" } }],
        }),
    });
    at("/hrms/hiring/offers");

    const row = (await screen.findByText("Asha Menon")).closest("tr");
    expect(within(row).getByText("Accepted")).toBeTruthy();
    expect(within(row).getByText(/Signed by Asha Menon/)).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /Send/ })).toBeNull();
  });
});

// ===========================================================================
// The candidate-facing careers pages
// ===========================================================================

describe("the public careers pages", () => {
  it("never touches the portal's authenticated transport", async () => {
    careersRequest.mockResolvedValue(publicOk([]));
    render(
      <MemoryRouter initialEntries={["/careers"]}>
        <Routes>
          <Route path="/careers" element={<CareersHome />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText(/No open positions right now/i);
    expect(api.request).not.toHaveBeenCalled();
    expect(careersRequest).toHaveBeenCalled();
  });

  it("lists live roles with their department and location", async () => {
    careersRequest.mockResolvedValue(
      publicOk([
        {
          slug: "product-designer-a1b2c3d4",
          title: "Product Designer",
          departmentName: "Design",
          locationName: "Indore",
          description: "Shape how the product feels.",
          requirements: "3-5 years",
          publishedAt: "2026-08-05T00:00:00.000Z",
        },
      ]),
    );
    render(
      <MemoryRouter initialEntries={["/careers"]}>
        <Routes>
          <Route path="/careers" element={<CareersHome />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Product Designer")).toBeTruthy();
    expect(screen.getByText("Design")).toBeTruthy();
    expect(screen.getByText("Indore")).toBeTruthy();
  });

  it("validates an application against the PUBLIC schema, which has no source field", async () => {
    careersRequest.mockImplementation(async (config) => {
      if (config.method === "get") {
        return publicOk({
          slug: "product-designer-a1b2c3d4",
          title: "Product Designer",
          departmentName: "Design",
          locationName: null,
          description: "Shape how the product feels.",
          requirements: "3-5 years",
          publishedAt: "2026-08-05T00:00:00.000Z",
        });
      }
      return publicOk({ received: true, role: "Product Designer" });
    });

    render(
      <MemoryRouter initialEntries={["/careers/product-designer-a1b2c3d4"]}>
        <Routes>
          <Route path="/careers/:slug" element={<CareersRolePage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Product Designer" });
    await userEvent.type(screen.getByLabelText("Full name"), "Nikhil Shah");
    await userEvent.type(screen.getByLabelText("Email"), "nikhil@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Submit application" }));

    await screen.findByText("Application received");
    const post = careersRequest.mock.calls.map((c) => c[0]).find((c) => c.method === "post");
    expect(post.data).toEqual({ name: "Nikhil Shah", email: "nikhil@example.com" });
    expect(post.data).not.toHaveProperty("source");
  });

  it("renders an offer from its token and withholds the recruiter's notes", async () => {
    careersRequest.mockResolvedValue(
      publicOk({
        candidateName: "Asha Menon",
        designation: "Senior Product Designer",
        ctc: 2200000,
        joiningDate: "2026-10-01",
        requisitionTitle: "Product Designer",
        state: "sent",
        sentAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-10-01T00:00:00.000Z",
        acceptedAt: null,
        rejectedAt: null,
      }),
    );

    render(
      <MemoryRouter initialEntries={[`/careers/offer/${"a".repeat(64)}`]}>
        <Routes>
          <Route path="/careers/offer/:token" element={<OfferPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: /Your offer of employment/ })).toBeTruthy();
    expect(screen.getByText("₹ 22,00,000")).toBeTruthy();
    expect(screen.queryByText(/Matched a competing offer/)).toBeNull();
  });

  it("renders one indistinguishable refusal for an unknown, expired or spent link", async () => {
    careersRequest.mockRejectedValue({
      response: { status: 404, data: { success: false, message: "Offer not found." } },
    });

    render(
      <MemoryRouter initialEntries={[`/careers/offer/${"b".repeat(64)}`]}>
        <Routes>
          <Route path="/careers/offer/:token" element={<OfferPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("This offer is not available")).toBeTruthy();
    expect(screen.getByText(/may have expired, or a decision may already have been recorded/i)).toBeTruthy();
  });

  it("requires a typed name before recording an acceptance", async () => {
    careersRequest.mockImplementation(async (config) => {
      if (config.method === "get") {
        return publicOk({
          candidateName: "Asha Menon",
          designation: "Senior Product Designer",
          ctc: 2200000,
          joiningDate: "2026-10-01",
          requisitionTitle: "Product Designer",
          state: "sent",
          sentAt: "2026-09-01T00:00:00.000Z",
          expiresAt: "2026-10-01T00:00:00.000Z",
          acceptedAt: null,
          rejectedAt: null,
        });
      }
      return publicOk({ state: "accepted" });
    });

    render(
      <MemoryRouter initialEntries={[`/careers/offer/${"a".repeat(64)}`]}>
        <Routes>
          <Route path="/careers/offer/:token" element={<OfferPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: /Your offer of employment/ });
    await userEvent.click(screen.getByRole("button", { name: "Accept and sign" }));
    await userEvent.click(await screen.findByRole("button", { name: "Sign and accept" }));

    expect(await screen.findByText(/Type your full name to sign/i)).toBeTruthy();
    expect(careersRequest.mock.calls.some((c) => c[0].method === "post")).toBe(false);

    await userEvent.type(screen.getByLabelText("Full legal name"), "Asha Menon");
    await userEvent.click(screen.getByRole("button", { name: "Sign and accept" }));

    expect(await screen.findByText("Offer accepted")).toBeTruthy();
    const post = careersRequest.mock.calls.map((c) => c[0]).find((c) => c.method === "post");
    expect(post.url).toBe(`/offer/${"a".repeat(64)}/accept`);
    expect(post.data).toEqual({ signatureName: "Asha Menon" });
  });
});
