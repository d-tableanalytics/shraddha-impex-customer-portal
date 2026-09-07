/**
 * Engage — the page shell, tab gating, and each tab's workflow.
 *
 * Only the axios instance is mocked. The HRMS client, the shared Zod schemas
 * and the shared permission matrix are all real, so these cover the request
 * URLs, the `{ success, data }` unwrapping, the permission gating and the form
 * validation as well as the rendering.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../../services/api";
import { EngagePage } from "./EngagePage";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const announcement = (over = {}) => ({
  id: "a1",
  title: "Office closed Friday",
  body: "The building is shut for maintenance.",
  state: "published",
  publishedAt: "2026-09-01T09:00:00.000Z",
  expiresAt: null,
  targetRoleKeys: [],
  targetDepartmentIds: [],
  targetDepartmentNames: [],
  orgWide: true,
  createdByEmployeeId: "e2",
  createdByName: "Hema Rao",
  createdAt: "2026-09-01T08:00:00.000Z",
  ...over,
});

const ANNOUNCEMENTS = {
  data: [announcement(), announcement({ id: "a2", title: "Draft notice", state: "draft", publishedAt: null })],
  total: 2,
  page: 1,
  pageSize: 25,
};

const poll = (over = {}) => ({
  id: "p1",
  question: "Which day suits the offsite?",
  kind: "single",
  options: [
    { key: "fri", label: "Friday" },
    { key: "sat", label: "Saturday" },
  ],
  targetRoleKeys: [],
  launchedAt: "2026-09-01T09:00:00.000Z",
  closesAt: "2026-12-01T09:00:00.000Z",
  anonymous: false,
  open: true,
  createdByEmployeeId: "e2",
  createdByName: "Hema Rao",
  createdAt: "2026-09-01T08:00:00.000Z",
  responseCount: 4,
  hasResponded: false,
  ...over,
});

const POLLS = { data: [poll()], total: 1, page: 1, pageSize: 25 };

const recognition = (over = {}) => ({
  id: "r1",
  fromEmployeeId: "e2",
  fromName: "Hema Rao",
  toEmployeeId: "e1",
  toName: "Person One",
  badgeId: "b1",
  badgeName: "Team Player",
  badgeIconKey: "🤝",
  message: "Carried the migration single-handed.",
  teamVisible: true,
  anonymous: false,
  createdAt: "2026-09-02T09:00:00.000Z",
  ...over,
});

const WALL = { data: [recognition()], total: 1, page: 1, pageSize: 25 };

const BADGES = [
  { id: "b1", name: "Team Player", iconKey: "🤝", description: null, awardedCount: 3 },
];

const survey = (over = {}) => ({
  id: "s1",
  name: "Q3 pulse",
  question: "How likely are you to recommend us as a great place to work?",
  launchedAt: "2026-09-01T09:00:00.000Z",
  closesAt: "2026-12-01T09:00:00.000Z",
  open: true,
  createdByEmployeeId: "e2",
  createdByName: "Hema Rao",
  createdAt: "2026-09-01T08:00:00.000Z",
  responseCount: 12,
  hasResponded: false,
  ...over,
});

const SURVEYS = { data: [survey()], total: 1, page: 1, pageSize: 25 };

const ENPS_RESULTS = {
  surveyId: "s1",
  surveyName: "Q3 pulse",
  open: true,
  score: 25,
  promoters: 6,
  passives: 3,
  detractors: 3,
  totalResponses: 12,
  bandBoundaries: { promoterMin: 9, passiveMin: 7 },
  comments: [{ comment: "Too many meetings.", score: 4 }],
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

    if (key === "GET /hrms/engage/announcements") return envelope(ANNOUNCEMENTS);
    if (key === "GET /hrms/engage/polls") return envelope(POLLS);
    if (key === "GET /hrms/engage/recognitions/wall") return envelope(WALL);
    if (key === "GET /hrms/engage/recognitions/received")
      return envelope({ data: [], total: 0, page: 1, pageSize: 25 });
    if (key === "GET /hrms/engage/recognitions/given")
      return envelope({ data: [], total: 0, page: 1, pageSize: 25 });
    if (key === "GET /hrms/engage/badges") return envelope(BADGES);
    if (key === "GET /hrms/engage/enps") return envelope(SURVEYS);
    if (key === "GET /hrms/engage/enps/s1/results") return envelope(ENPS_RESULTS);
    if (key === "GET /hrms/org/departments") return envelope([]);
    if (key === "GET /hrms/employees")
      return envelope({ data: [], total: 0, page: 1, pageSize: 25 });

    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee: { id: "e1" } }),
    implementedModules: [M.DASHBOARD, M.ENGAGE],
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/engage" element={<EngagePage />} />
        <Route path="/hrms/engage/:tab" element={<EngagePage />} />
      </Routes>
    </MemoryRouter>,
  );

/**
 * The overlay a Modal or Drawer portals into, found by its heading.
 *
 * `getAllBy`, not `getBy`: a poll's question and a survey's name are the
 * heading of BOTH the row in the list and the dialog opened from it, so the
 * one inside the portal is picked by walking up to the overlay.
 */
const panelTitled = (title) => {
  const panel = screen
    .getAllByRole("heading", { name: title })
    .map((h) => h.closest("div.fixed"))
    .find(Boolean);
  if (!panel) throw new Error(`No open panel titled ${title}`);
  return panel;
};

beforeEach(() => {
  useHrmsStore.getState().clear();
  installTransport();
});

// ===========================================================================
// Shell
// ===========================================================================

describe("the page shell", () => {
  it("renders the title, and tells HR they can manage content", async () => {
    signIn([R.EMPLOYEE]);
    const view = at("/hrms/engage/announcements");
    expect(await screen.findByRole("heading", { name: "Engage" })).toBeTruthy();
    expect(screen.getByText(/Company announcements, polls, and peer recognition\.$/)).toBeTruthy();
    view.unmount();

    signIn([R.HR_ADMIN]);
    at("/hrms/engage/announcements");
    expect(await screen.findByText(/Manage content from here/)).toBeTruthy();
  });

  it("🔴 shows FOUR tabs — the reference renders three and never imports its eNPS tab", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/engage/announcements");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Announcements",
      "Polls & Surveys",
      "Recognition",
      "eNPS",
    ]);
  });

  it("gives an ordinary employee every tab — Engage has no team scope", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/engage/enps");
    // Reaching the eNPS tab at all is the point; only the write controls differ.
    expect(await screen.findByText("Q3 pulse")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Launch eNPS survey/ })).toBeNull();
  });

  it("defaults the bare module path to Announcements", async () => {
    signIn([R.EMPLOYEE]);
    render(
      <MemoryRouter initialEntries={["/hrms/engage"]}>
        <Routes>
          <Route path="/hrms/engage" element={<EngagePage />} />
          <Route path="/hrms/engage/:tab" element={<EngagePage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Office closed Friday")).toBeTruthy();
  });
});

// ===========================================================================
// Announcements
// ===========================================================================

describe("announcements", () => {
  it("splits drafts from published, and only HR sees the write controls", async () => {
    signIn([R.HR_ADMIN]);
    const view = at("/hrms/engage/announcements");

    const drafts = await screen.findByRole("region", { name: "Drafts" });
    expect(within(drafts).getByText("Draft notice")).toBeTruthy();
    expect(within(drafts).getByRole("button", { name: /Publish/ })).toBeTruthy();

    const published = screen.getByRole("region", { name: "Published" });
    expect(within(published).getByText("Office closed Friday")).toBeTruthy();
    expect(within(published).queryByRole("button", { name: /Publish/ })).toBeNull();
    view.unmount();

    signIn([R.EMPLOYEE]);
    at("/hrms/engage/announcements");
    await screen.findByText("Office closed Friday");
    expect(screen.queryByRole("button", { name: /New announcement/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Publish/ })).toBeNull();
  });

  it("publishes through the API", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({
      "POST /hrms/engage/announcements/a2/publish": () => envelope(announcement({ id: "a2" })),
    });
    at("/hrms/engage/announcements");

    const drafts = await screen.findByRole("region", { name: "Drafts" });
    await userEvent.click(within(drafts).getByRole("button", { name: /Publish/ }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === "/hrms/engage/announcements/a2/publish")).toBe(true),
    );
  });

  it("confirms before deleting, and says it cannot be undone", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/engage/announcements");

    const published = await screen.findByRole("region", { name: "Published" });
    await userEvent.click(
      within(published).getByRole("button", { name: /Delete Office closed Friday/ }),
    );

    expect(await screen.findByText(/cannot be undone/i)).toBeTruthy();
    expect(calls.some((c) => c.method === "delete")).toBe(false);
  });

  it("validates against the shared schema before posting", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/engage/announcements");

    await userEvent.click(await screen.findByRole("button", { name: /New announcement/ }));
    const drawer = panelTitled("New announcement");
    await userEvent.type(within(drawer).getByLabelText("Title"), "Something");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save draft" }));

    // The body is required by the shared schema.
    expect(await within(drawer).findByText(/Write something/i)).toBeTruthy();
    expect(calls.some((c) => c.method === "post" && c.url === "/hrms/engage/announcements")).toBe(
      false,
    );
  });

  it("says plainly that empty targeting means everyone", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/engage/announcements");

    await userEvent.click(await screen.findByRole("button", { name: /New announcement/ }));
    const drawer = panelTitled("New announcement");
    expect(within(drawer).getByText(/Leave both empty and this goes to everyone/i)).toBeTruthy();
  });

  it("posts a valid announcement", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({ "POST /hrms/engage/announcements": () => envelope(announcement()) });
    at("/hrms/engage/announcements");

    await userEvent.click(await screen.findByRole("button", { name: /New announcement/ }));
    const drawer = panelTitled("New announcement");
    await userEvent.type(within(drawer).getByLabelText("Title"), "All-hands Thursday");
    await userEvent.type(within(drawer).getByLabelText("Body"), "In the main room.");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save draft" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "post" && c.url === "/hrms/engage/announcements");
      expect(post.data).toEqual({
        title: "All-hands Thursday",
        body: "In the main room.",
        publishNow: false,
        targetRoleKeys: [],
        targetDepartmentIds: [],
      });
    });
  });
});

// ===========================================================================
// Polls
// ===========================================================================

describe("polls", () => {
  it("shows the kind, state and a Respond button", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/engage/polls");

    expect(await screen.findByText("Which day suits the offsite?")).toBeTruthy();
    expect(screen.getByText("Single choice")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Respond" })).toBeTruthy();
    // Response counts are HR's.
    expect(screen.queryByText(/4 responses/)).toBeNull();
  });

  it("a single-choice poll renders radios and posts the chosen key", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({ "POST /hrms/engage/polls/p1/respond": () => envelope(poll()) });
    at("/hrms/engage/polls");

    await userEvent.click(await screen.findByRole("button", { name: "Respond" }));
    const modal = panelTitled("Which day suits the offsite?");
    await userEvent.click(within(modal).getByRole("radio", { name: "Friday" }));
    await userEvent.click(within(modal).getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === "/hrms/engage/polls/p1/respond");
      expect(post.data).toEqual({ keys: ["fri"] });
    });
  });

  it("🔴 a scale poll submits a NUMBER — the reference's form sends option keys", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({
      "GET /hrms/engage/polls": () =>
        envelope({ ...POLLS, data: [poll({ kind: "scale", options: [] })] }),
      "POST /hrms/engage/polls/p1/respond": () => envelope(poll()),
    });
    at("/hrms/engage/polls");

    await userEvent.click(await screen.findByRole("button", { name: "Respond" }));
    const modal = panelTitled("Which day suits the offsite?");
    await userEvent.click(within(modal).getByRole("button", { name: "7" }));
    await userEvent.click(within(modal).getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === "/hrms/engage/polls/p1/respond");
      expect(post.data).toEqual({ scale: 7 });
      expect(post.data.keys).toBeUndefined();
    });
  });

  it("an open-ended poll asks for text", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({
      "GET /hrms/engage/polls": () =>
        envelope({ ...POLLS, data: [poll({ kind: "open_ended", options: [] })] }),
      "POST /hrms/engage/polls/p1/respond": () => envelope(poll()),
    });
    at("/hrms/engage/polls");

    await userEvent.click(await screen.findByRole("button", { name: "Respond" }));
    const modal = panelTitled("Which day suits the offsite?");
    await userEvent.type(within(modal).getByLabelText("Your response"), "More natural light.");
    await userEvent.click(within(modal).getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === "/hrms/engage/polls/p1/respond");
      expect(post.data).toEqual({ text: "More natural light." });
    });
  });

  it("an anonymous poll says what anonymity does and does not hide", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({
      "GET /hrms/engage/polls": () => envelope({ ...POLLS, data: [poll({ anonymous: true })] }),
    });
    at("/hrms/engage/polls");

    await userEvent.click(await screen.findByRole("button", { name: "Respond" }));
    const modal = panelTitled("Which day suits the offsite?");
    expect(within(modal).getByText(/without your name/i)).toBeTruthy();
    expect(within(modal).getByText(/cannot vote twice/i)).toBeTruthy();
  });

  it("🔴 a draft poll offers Launch — the reference has no endpoint and its drafts are dead", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({
      "GET /hrms/engage/polls": () =>
        envelope({ ...POLLS, data: [poll({ launchedAt: null, open: false })] }),
      "POST /hrms/engage/polls/p1/launch": () => envelope(poll()),
    });
    at("/hrms/engage/polls");

    expect(await screen.findByText("Draft")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Launch/ }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === "/hrms/engage/polls/p1/launch")).toBe(true),
    );
  });

  it("an already-answered poll shows so, and offers no Respond", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({
      "GET /hrms/engage/polls": () => envelope({ ...POLLS, data: [poll({ hasResponded: true })] }),
    });
    at("/hrms/engage/polls");

    expect(await screen.findByText("Answered")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Respond" })).toBeNull();
  });

  it("results are an HR control, and render a bar per option", async () => {
    signIn([R.HR_ADMIN]);
    installTransport({
      "GET /hrms/engage/polls/p1/results": () =>
        envelope({
          pollId: "p1",
          question: "Which day suits the offsite?",
          kind: "single",
          anonymous: false,
          options: [
            { key: "fri", label: "Friday" },
            { key: "sat", label: "Saturday" },
          ],
          totalResponses: 4,
          optionCounts: { fri: 3, sat: 1 },
          scaleAverage: null,
          openTexts: [],
        }),
    });
    at("/hrms/engage/polls");

    await userEvent.click(await screen.findByRole("button", { name: /Results/ }));
    const modal = panelTitled(/^Results — Which day suits the offsite\?/);
    expect(await within(modal).findByText("Friday")).toBeTruthy();
    expect(within(modal).getByText("3 · 75%")).toBeTruthy();
    // A zero-vote option is still shown — the reference omits it entirely.
    expect(within(modal).getByText("1 · 25%")).toBeTruthy();
  });
});

// ===========================================================================
// Recognition
// ===========================================================================

describe("recognition", () => {
  it("shows the wall with the badge, message and sender", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/engage/recognition");

    expect(await screen.findByText("Person One")).toBeTruthy();
    expect(screen.getByText("Carried the migration single-handed.")).toBeTruthy();
    expect(screen.getByText("Team Player")).toBeTruthy();
    expect(screen.getByText(/From Hema Rao/)).toBeTruthy();
  });

  it("🔴 an anonymous kudos shows Anonymous, with no sender id to resolve", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({
      "GET /hrms/engage/recognitions/wall": () =>
        envelope({
          ...WALL,
          data: [recognition({ fromEmployeeId: null, fromName: "Anonymous", anonymous: true })],
        }),
    });
    at("/hrms/engage/recognition");

    expect(await screen.findByText(/From Anonymous/)).toBeTruthy();
  });

  it("giving kudos is open to everyone; the badge catalogue is HR's", async () => {
    signIn([R.EMPLOYEE]);
    const view = at("/hrms/engage/recognition");
    await screen.findByText("Person One");
    expect(screen.getByRole("button", { name: /Give recognition/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Badges/ })).toBeNull();
    view.unmount();

    signIn([R.HR_ADMIN]);
    at("/hrms/engage/recognition");
    expect(await screen.findByRole("button", { name: /Badges/ })).toBeTruthy();
  });

  it("warns what anonymous kudos does and does not hide", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/engage/recognition");

    await userEvent.click(await screen.findByRole("button", { name: /Give recognition/ }));
    const drawer = panelTitled("Give recognition");
    expect(within(drawer).queryByText(/not.*anonymous to the company/i)).toBeNull();

    await userEvent.click(within(drawer).getByLabelText("Send anonymously"));
    expect(await within(drawer).findByText(/anonymous to the company/i)).toBeTruthy();
  });

  it("switches between the wall, received and given", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/engage/recognition");

    await screen.findByText("Person One");
    await userEvent.click(screen.getByRole("tab", { name: "You received" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/hrms/engage/recognitions/received")).toBe(true),
    );

    await userEvent.click(screen.getByRole("tab", { name: "You gave" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/hrms/engage/recognitions/given")).toBe(true),
    );
    expect(await screen.findByText(/You have not given any kudos yet/i)).toBeTruthy();
  });
});

// ===========================================================================
// eNPS
// ===========================================================================

describe("eNPS", () => {
  it("shows the survey with its question and an anonymity marker", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/engage/enps");

    expect(await screen.findByText("Q3 pulse")).toBeTruthy();
    expect(screen.getByText(/recommend us as a great place to work/i)).toBeTruthy();
    expect(screen.getByText("Anonymous")).toBeTruthy();
  });

  it("submits a 0–10 score with an optional comment", async () => {
    signIn([R.EMPLOYEE]);
    installTransport({ "POST /hrms/engage/enps/s1/respond": () => envelope(survey()) });
    at("/hrms/engage/enps");

    await userEvent.click(await screen.findByRole("button", { name: "Respond" }));
    const modal = panelTitled("Q3 pulse");
    await userEvent.click(within(modal).getByRole("button", { name: "9 out of 10" }));
    await userEvent.type(
      within(modal).getByLabelText(/Anything you would like to add/),
      "Good team.",
    );
    await userEvent.click(within(modal).getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === "/hrms/engage/enps/s1/respond");
      expect(post.data).toEqual({ score: 9, comment: "Good team." });
    });
  });

  it("refuses to submit without a score", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/engage/enps");

    await userEvent.click(await screen.findByRole("button", { name: "Respond" }));
    const modal = panelTitled("Q3 pulse");
    await userEvent.click(within(modal).getByRole("button", { name: "Submit" }));

    expect(await within(modal).findByRole("alert")).toBeTruthy();
    expect(calls.some((c) => c.method === "post")).toBe(false);
  });

  it("tells the respondent the trail carries neither their name nor their score", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/engage/enps");

    await userEvent.click(await screen.findByRole("button", { name: "Respond" }));
    const modal = panelTitled("Q3 pulse");
    expect(
      within(modal).getByText(/without your name and without your score/i),
    ).toBeTruthy();
  });

  it("renders the score with its sign and the three bands, for HR", async () => {
    signIn([R.HR_ADMIN]);
    at("/hrms/engage/enps");

    await userEvent.click(await screen.findByRole("button", { name: /Results/ }));
    const modal = panelTitled("eNPS — Q3 pulse");
    // An eNPS runs -100..+100, so the sign matters.
    expect(await within(modal).findByText("+25")).toBeTruthy();
    expect(within(modal).getByText("Promoters")).toBeTruthy();
    expect(within(modal).getByText("Detractors")).toBeTruthy();
    // 🔴 The comments the reference collects and shows to nobody.
    expect(within(modal).getByText("Too many meetings.")).toBeTruthy();
  });

  it("only HR can launch a survey or read results", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/engage/enps");
    await screen.findByText("Q3 pulse");
    expect(screen.queryByRole("button", { name: /Launch eNPS survey/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Results/ })).toBeNull();
  });
});
