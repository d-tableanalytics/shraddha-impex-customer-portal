/**
 * Helpdesk — the screens.
 *
 * Only the axios instance is mocked. The HRMS client, the shared Zod schemas
 * and the shared permission matrix are all real, so these also cover the
 * request URLs, the payload shapes and the `{ success, data }` unwrapping.
 *
 * What the UI offers is asserted here; what it is ALLOWED to do is asserted in
 * backend/tests/helpdesk-api.test.js. Both halves read the same matrix.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../../services/api";
import { HelpdeskPage } from "./HelpdeskPage";
import { formatSla } from "../../../services/hrms";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";

const ME = "652f0000000000000000b001";
const OTHER = "652f0000000000000000b002";
const CAT_IT = "652f0000000000000000a001";
const CAT_HR = "652f0000000000000000a002";
const TICKET = "652f0000000000000000d001";

const CATEGORIES = [
  {
    id: CAT_IT,
    name: "IT",
    code: "IT",
    resolverModule: "helpdesk:it",
    slaHours: 8,
    active: true,
    ticketCount: 4,
  },
  {
    id: CAT_HR,
    name: "HR",
    code: "HR",
    resolverModule: "helpdesk:hr",
    slaHours: 24,
    active: true,
    ticketCount: 2,
  },
];

const ticket = (over = {}) => ({
  id: TICKET,
  ticketNumber: "HD-2026-000001",
  categoryId: CAT_IT,
  categoryName: "IT",
  resolverModule: "helpdesk:it",
  requesterEmployeeId: ME,
  requesterName: "Sam Person",
  subject: "Laptop will not boot",
  body: "It shows a black screen after the logo.",
  priority: "high",
  status: "open",
  assigneeEmployeeId: null,
  assigneeName: null,
  slaHours: 8,
  slaDueAt: "2026-01-06T08:00:00.000Z",
  slaBreached: false,
  slaHoursRemaining: 6,
  resolvedAt: null,
  resolutionNotes: null,
  closedAt: null,
  reopenedAt: null,
  createdAt: "2026-01-06T00:00:00.000Z",
  updatedAt: "2026-01-06T00:00:00.000Z",
  isMine: true,
  canResolve: false,
  comments: [],
  ...over,
});

const article = (over = {}) => ({
  id: "652f0000000000000000e001",
  categoryId: null,
  title: "How to reset your VPN",
  body: "Open the client and choose Reset.",
  searchTags: ["vpn", "network"],
  published: true,
  publishedAt: "2026-01-02T00:00:00.000Z",
  authorName: "Ivan Person",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
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

    if (key === "GET /hrms/helpdesk/categories") return envelope(CATEGORIES);
    if (key === "GET /hrms/helpdesk/tickets") return page([]);
    if (key === "GET /hrms/helpdesk/tickets/me") return page([]);
    if (key === "GET /hrms/helpdesk/kb") return page([]);
    if (key === "GET /hrms/employees") return page([]);
    if (key === `GET /hrms/helpdesk/tickets/${TICKET}`) return envelope(ticket());
    if (config.method === "post" || config.method === "patch") return envelope(ticket());
    if (config.method === "delete") return envelope({ deleted: true });
    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles, employee = { id: ME, managerChain: [] }) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee }),
    implementedModules: [M.DASHBOARD, M.EMPLOYEES, M.HELPDESK],
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/helpdesk" element={<HelpdeskPage />} />
        <Route path="/hrms/helpdesk/:tab" element={<HelpdeskPage />} />
      </Routes>
    </MemoryRouter>,
  );

const urlsHit = () => calls.map((c) => `${c.method.toUpperCase()} ${c.url}`);

/** The control inside a drawer, when the trigger shares its name. */
const inDrawer = (name) => {
  const matches = screen.getAllByRole("button", { name });
  return matches[matches.length - 1];
};

/**
 * The open drawer, scoped.
 *
 * The list behind it still shows the same ticket number and the same subject,
 * so an unscoped query would match twice. The drawer is titled with the
 * subject, which is what makes it findable.
 */
const openPanel = async (subject) => {
  const heading = await screen.findByRole("heading", { level: 3, name: subject });
  return within(heading.closest("div.fixed"));
};

/** The table row a ticket occupies. */
const rowFor = (subject) => within(screen.getByText(subject).closest("tr"));

beforeEach(() => {
  useHrmsStore.getState().clear();
  installTransport();
});

// ===========================================================================
// Page shell and gating
// ===========================================================================

describe("the helpdesk page", () => {
  it("renders its title and breadcrumb", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/helpdesk/my-tickets");

    expect(await screen.findByRole("heading", { name: "Helpdesk" })).toBeTruthy();
    expect(screen.getByText("HRMS")).toBeTruthy();
  });

  it("an employee gets My Tickets and the Knowledge Base only", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/helpdesk/my-tickets");

    expect(await screen.findByRole("tab", { name: "My Tickets" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Knowledge Base" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Resolver Queue" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Categories" })).toBeNull();
  });

  it("a team resolver gets the queue but NOT the catalogue", async () => {
    signIn([R.IT_ADMIN]);
    at("/hrms/helpdesk/my-tickets");

    expect(await screen.findByRole("tab", { name: "Resolver Queue" })).toBeTruthy();
    // A category decides which team answers for what — not one team's call.
    expect(screen.queryByRole("tab", { name: "Categories" })).toBeNull();
  });

  it("a super admin gets all four", async () => {
    signIn([R.SUPER_ADMIN]);
    at("/hrms/helpdesk/my-tickets");

    expect(await screen.findByRole("tab", { name: "Resolver Queue" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Categories" })).toBeTruthy();
  });

  it("a gated tab reached by URL is refused WITHOUT firing its request", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/helpdesk/queue");

    expect(await screen.findByText(/do not have access to this view/i)).toBeTruthy();
    expect(urlsHit()).not.toContain("GET /hrms/helpdesk/tickets");
  });
});

// ===========================================================================
// My tickets
// ===========================================================================

describe("my tickets", () => {
  it("uses the dedicated endpoint, not the whole queue", async () => {
    // The reference has no "mine" filter, so its My Tickets tab shows a
    // resolver the entire queue.
    signIn([R.EMPLOYEE]);
    at("/hrms/helpdesk/my-tickets");

    await screen.findByText("You have no tickets");
    expect(urlsHit()).toContain("GET /hrms/helpdesk/tickets/me");
    expect(urlsHit()).not.toContain("GET /hrms/helpdesk/tickets");
  });

  it("shows the ticket number, status, priority and SLA countdown", async () => {
    installTransport({ "GET /hrms/helpdesk/tickets/me": () => page([ticket()]) });
    signIn([R.EMPLOYEE]);
    at("/hrms/helpdesk/my-tickets");

    await screen.findByText("Laptop will not boot");
    const row = rowFor("Laptop will not boot");

    expect(row.getByText("HD-2026-000001")).toBeTruthy();
    expect(row.getByText(/IT$/)).toBeTruthy();
    expect(row.getByText("Open", { selector: "span" })).toBeTruthy();
    expect(row.getByText("High")).toBeTruthy();
    // The reference shows only a breach tag, never the time remaining.
    expect(row.getByText("6h left")).toBeTruthy();
  });

  it("marks a breached ticket", async () => {
    installTransport({
      "GET /hrms/helpdesk/tickets/me": () =>
        page([ticket({ slaBreached: true, slaHoursRemaining: 0 })]),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/helpdesk/my-tickets");

    expect(await screen.findByText("SLA breached")).toBeTruthy();
  });

  it("filters by status through the SERVER", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/helpdesk/my-tickets");

    await screen.findByText("You have no tickets");
    await userEvent.selectOptions(screen.getByLabelText("Filter by status"), "resolved");

    await waitFor(() => {
      const last = calls.filter((c) => c.url === "/hrms/helpdesk/tickets/me").pop();
      expect(last.params.status).toBe("resolved");
    });
  });

  it("renders an error with a retry that refetches", async () => {
    installTransport({
      "GET /hrms/helpdesk/tickets/me": () => fail(500, { message: "Server error" }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/helpdesk/my-tickets");

    const retry = await screen.findByRole("button", { name: /try again|retry/i });
    const before = calls.length;
    await userEvent.click(retry);
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });
});

// ===========================================================================
// Raising
// ===========================================================================

describe("raising a ticket", () => {
  const openDrawer = async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/helpdesk/my-tickets");
    await userEvent.click(await screen.findByRole("button", { name: /Raise a ticket/i }));
    return screen.findByLabelText("Subject");
  };

  it("loads the categories from the SERVER", async () => {
    // The reference hardcodes 'hr-placeholder' / 'it-placeholder' /
    // 'payroll-placeholder', none of which is a uuid, so its own validator
    // rejects every submission.
    await openDrawer();

    const select = screen.getByLabelText("Category");
    expect(within(select).getByText("IT")).toBeTruthy();
    expect(within(select).getByText("HR")).toBeTruthy();
    expect(within(select).queryByText(/placeholder/i)).toBeNull();
    expect(urlsHit()).toContain("GET /hrms/helpdesk/categories");
  });

  it("shows the SLA that the chosen category carries", async () => {
    await openDrawer();
    await userEvent.selectOptions(screen.getByLabelText("Category"), CAT_IT);
    expect(await screen.findByText(/within 8 hours by the IT team/i)).toBeTruthy();
  });

  it("refuses an incomplete ticket without calling the server", async () => {
    await openDrawer();
    await userEvent.click(inDrawer("Raise ticket"));

    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "post" && c.url === "/hrms/helpdesk/tickets"),
      ).toHaveLength(0),
    );
  });

  it("posts a real category id and no requester id", async () => {
    await openDrawer();

    await userEvent.selectOptions(screen.getByLabelText("Category"), CAT_IT);
    await userEvent.type(screen.getByLabelText("Subject"), "Laptop will not boot");
    await userEvent.type(screen.getByLabelText("Details"), "Black screen after the logo.");
    await userEvent.selectOptions(screen.getByLabelText("Priority"), "urgent");
    await userEvent.click(inDrawer("Raise ticket"));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "post" && c.url === "/hrms/helpdesk/tickets",
      );
      expect(post).toBeTruthy();
      expect(post.data.categoryId).toBe(CAT_IT);
      expect(post.data.priority).toBe("urgent");
      // The server resolves whose ticket it is from the signed-in actor.
      expect(post.data.requesterEmployeeId).toBeUndefined();
    });
  });
});

// ===========================================================================
// The queue
// ===========================================================================

describe("the resolver queue", () => {
  const openQueue = async (roles = [R.IT_ADMIN], rows = [ticket({ isMine: false, canResolve: true })]) => {
    installTransport({ "GET /hrms/helpdesk/tickets": () => page(rows) });
    signIn(roles);
    at("/hrms/helpdesk/queue");
    return screen.findByText("Laptop will not boot");
  };

  it("asks the server for the queue, paged — it does not filter locally", async () => {
    await openQueue();

    const call = calls.find((c) => c.url === "/hrms/helpdesk/tickets");
    expect(call.params.page).toBe(1);
    expect(call.params.pageSize).toBe(15);
  });

  it("shows who raised it, which team owns it and who holds it", async () => {
    await openQueue();
    const row = rowFor("Laptop will not boot");

    expect(row.getByText("Sam Person")).toBeTruthy();
    expect(row.getByText("IT")).toBeTruthy();
    expect(row.getByText("Unassigned")).toBeTruthy();
  });

  it("filters and searches through the SERVER", async () => {
    await openQueue();

    await userEvent.selectOptions(screen.getByLabelText("Filter by priority"), "urgent");
    await waitFor(() => {
      const last = calls.filter((c) => c.url === "/hrms/helpdesk/tickets").pop();
      expect(last.params.priority).toBe("urgent");
    });

    await userEvent.type(screen.getByLabelText("Search tickets"), "boot");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      const last = calls.filter((c) => c.url === "/hrms/helpdesk/tickets").pop();
      expect(last.params.search).toBe("boot");
    });
  });

  it("can narrow to breached tickets", async () => {
    await openQueue();

    await userEvent.click(screen.getByRole("button", { name: /Breached only/i }));
    await waitFor(() => {
      const last = calls.filter((c) => c.url === "/hrms/helpdesk/tickets").pop();
      expect(last.params.breachedOnly).toBe("true");
    });
  });
});

// ===========================================================================
// The detail drawer
// ===========================================================================

describe("the ticket detail", () => {
  const openTicket = async (roles, detail) => {
    installTransport({
      "GET /hrms/helpdesk/tickets": () => page([{ ...detail, comments: undefined }]),
      "GET /hrms/helpdesk/tickets/me": () => page([{ ...detail, comments: undefined }]),
      [`GET /hrms/helpdesk/tickets/${TICKET}`]: () => envelope(detail),
    });
    signIn(roles);
    at(roles.includes(R.EMPLOYEE) ? "/hrms/helpdesk/my-tickets" : "/hrms/helpdesk/queue");
    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    return openPanel(detail.subject);
  };

  it("a requester sees no resolver actions", async () => {
    const panel = await openTicket([R.EMPLOYEE], ticket({ isMine: true, canResolve: false }));

    expect(panel.getByText("HD-2026-000001")).toBeTruthy();
    expect(panel.queryByText("Resolver actions")).toBeNull();
    expect(panel.queryByText("Assign to")).toBeNull();
    expect(panel.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("the owning team gets assignment, priority and the next moves", async () => {
    // The reference's drawer offers a status select and nothing else —
    // assignment, priority and resolution notes are all unreachable there.
    const panel = await openTicket([R.IT_ADMIN], ticket({ isMine: false, canResolve: true }));

    expect(panel.getByText("Resolver actions")).toBeTruthy();
    expect(panel.getByText("Assign to")).toBeTruthy();
    expect(panel.getByLabelText("Priority")).toBeTruthy();
    expect(panel.getByRole("button", { name: "Start work" })).toBeTruthy();
    expect(panel.getByRole("button", { name: "Resolve" })).toBeTruthy();
  });

  it("resolving demands a note before it will send", async () => {
    const panel = await openTicket([R.IT_ADMIN], ticket({ isMine: false, canResolve: true }));

    await userEvent.click(panel.getByRole("button", { name: "Resolve" }));
    const confirm = await panel.findByLabelText(/How was it resolved/i);
    // The submit is disabled until there is something to say.
    const confirmBtn = () => panel.getAllByRole("button", { name: "Resolve" }).at(-1);
    expect(confirmBtn().disabled).toBe(true);

    await userEvent.type(confirm, "Replaced the power supply.");
    await userEvent.click(confirmBtn());

    await waitFor(() => {
      const post = calls.find((c) => c.url?.includes("/status"));
      expect(post.data.status).toBe("resolved");
      expect(post.data.resolutionNotes).toBe("Replaced the power supply.");
    });
  });

  it("offers only the moves the machine allows", async () => {
    // `in_progress` can go to `resolved` and nowhere else.
    const panel = await openTicket(
      [R.IT_ADMIN],
      ticket({ isMine: false, canResolve: true, status: "in_progress" }),
    );

    expect(panel.getByRole("button", { name: "Resolve" })).toBeTruthy();
    expect(panel.queryByRole("button", { name: "Start work" })).toBeNull();
    expect(panel.queryByRole("button", { name: "Closed" })).toBeNull();
  });

  it("a requester may close or reopen their OWN resolved ticket", async () => {
    // The reference gives the requester nothing at all.
    const panel = await openTicket(
      [R.EMPLOYEE],
      ticket({
        isMine: true,
        canResolve: false,
        status: "resolved",
        resolutionNotes: "Replaced the power supply.",
      }),
    );

    expect(panel.getByText(/has been resolved/i)).toBeTruthy();
    await userEvent.click(panel.getByRole("button", { name: "Close it" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url?.includes("/status"));
      expect(post.data.status).toBe("closed");
    });
  });

  it("a closed ticket takes no more comments", async () => {
    const panel = await openTicket(
      [R.EMPLOYEE],
      ticket({ isMine: true, canResolve: false, status: "closed" }),
    );

    expect(panel.getByText(/This ticket is closed/i)).toBeTruthy();
    expect(panel.queryByLabelText("Add a comment")).toBeNull();
  });
});

// ===========================================================================
// Comments and internal notes
// ===========================================================================

describe("the conversation", () => {
  const withComments = (roles, over) =>
    ticket({
      ...over,
      comments: [
        {
          id: "c1",
          authorEmployeeId: OTHER,
          authorName: "Ivan Person",
          body: "We are looking at it.",
          internal: false,
          createdAt: "2026-01-06T01:00:00.000Z",
        },
      ],
    });

  const open = async (roles, detail) => {
    installTransport({
      "GET /hrms/helpdesk/tickets": () => page([detail]),
      "GET /hrms/helpdesk/tickets/me": () => page([detail]),
      [`GET /hrms/helpdesk/tickets/${TICKET}`]: () => envelope(detail),
    });
    signIn(roles);
    at(roles.includes(R.EMPLOYEE) ? "/hrms/helpdesk/my-tickets" : "/hrms/helpdesk/queue");
    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    return openPanel(detail.subject);
  };

  it("renders the thread with author and time", async () => {
    const panel = await open([R.EMPLOYEE], withComments([R.EMPLOYEE], { isMine: true, canResolve: false }));

    expect(panel.getByText("We are looking at it.")).toBeTruthy();
    expect(panel.getByText("Ivan Person")).toBeTruthy();
  });

  it("a requester gets NO internal-note checkbox", async () => {
    // The reference shows the checkbox to any resolver and accepts `internal`
    // from anybody at all.
    const panel = await open([R.EMPLOYEE], withComments([R.EMPLOYEE], { isMine: true, canResolve: false }));

    expect(panel.queryByLabelText(/Internal note/i)).toBeNull();
  });

  it("the owning team gets it, and posts the flag", async () => {
    const panel = await open([R.IT_ADMIN], withComments([R.IT_ADMIN], { isMine: false, canResolve: true }));

    await userEvent.click(panel.getByLabelText(/Internal note/i));
    await userEvent.type(panel.getByLabelText("Add a comment"), "Escalating to the vendor.");
    await userEvent.click(panel.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      const post = calls.find((c) => c.url?.includes("/comments"));
      expect(post.data.internal).toBe(true);
      expect(post.data.body).toBe("Escalating to the vendor.");
    });
  });

  it("an internal note is marked so it cannot be mistaken for a reply", async () => {
    const panel = await open(
      [R.IT_ADMIN],
      ticket({
        isMine: false,
        canResolve: true,
        comments: [
          {
            id: "c2",
            authorEmployeeId: OTHER,
            authorName: "Ivan Person",
            body: "Requester has done this before.",
            internal: true,
            createdAt: "2026-01-06T02:00:00.000Z",
          },
        ],
      }),
    );

    expect(panel.getByText("Internal")).toBeTruthy();
  });
});

// ===========================================================================
// Knowledge base
// ===========================================================================

describe("the knowledge base", () => {
  it("an employee reads but cannot write", async () => {
    installTransport({ "GET /hrms/helpdesk/kb": () => page([article()]) });
    signIn([R.EMPLOYEE]);
    at("/hrms/helpdesk/kb");

    expect(await screen.findByText("How to reset your VPN")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New article/i })).toBeNull();
    expect(screen.queryByLabelText(/Show drafts/i)).toBeNull();
  });

  it("a resolver writes and publishes", async () => {
    installTransport({ "GET /hrms/helpdesk/kb": () => page([article()]) });
    signIn([R.IT_ADMIN]);
    at("/hrms/helpdesk/kb");

    await userEvent.click(await screen.findByRole("button", { name: /New article/i }));
    await userEvent.type(await screen.findByLabelText("Title"), "Printer setup");
    await userEvent.type(screen.getByLabelText("Article"), "Add the queue by name.");
    await userEvent.type(screen.getByLabelText(/Tags/), "printer, office");
    await userEvent.click(screen.getByLabelText(/Published/i));
    await userEvent.click(inDrawer("Save"));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "post" && c.url === "/hrms/helpdesk/kb");
      expect(post.data.title).toBe("Printer setup");
      expect(post.data.published).toBe(true);
      expect(post.data.searchTags).toEqual(["printer", "office"]);
    });
  });

  it("searches through the SERVER", async () => {
    // The reference truncates before it filters, so a match outside the newest
    // twenty can never be found.
    installTransport({ "GET /hrms/helpdesk/kb": () => page([article()]) });
    signIn([R.EMPLOYEE]);
    at("/hrms/helpdesk/kb");

    await screen.findByText("How to reset your VPN");
    await userEvent.type(screen.getByLabelText("Search articles"), "vpn");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      const last = calls.filter((c) => c.url === "/hrms/helpdesk/kb").pop();
      expect(last.params.search).toBe("vpn");
    });
  });

  it("opens an article for reading and comes back", async () => {
    installTransport({ "GET /hrms/helpdesk/kb": () => page([article()]) });
    signIn([R.EMPLOYEE]);
    at("/hrms/helpdesk/kb");

    await userEvent.click(await screen.findByRole("button", { name: "Read" }));
    expect(await screen.findByText("Open the client and choose Reset.")).toBeTruthy();
    expect(screen.getByText("#vpn")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Back to articles/i }));
    expect(await screen.findByRole("button", { name: "Read" })).toBeTruthy();
  });

  it("marks a draft as one", async () => {
    installTransport({
      "GET /hrms/helpdesk/kb": () => page([article({ published: false, publishedAt: null })]),
    });
    signIn([R.IT_ADMIN]);
    at("/hrms/helpdesk/kb");

    expect(await screen.findByText("Draft")).toBeTruthy();
  });
});

// ===========================================================================
// Categories
// ===========================================================================

describe("the category catalogue", () => {
  it("shows which team answers and the SLA", async () => {
    signIn([R.SUPER_ADMIN]);
    at("/hrms/helpdesk/categories");

    await screen.findByText("8 hours");
    expect(screen.getByText("24 hours")).toBeTruthy();
    // Asked for inactive ones too, so the admin sees the whole catalogue.
    const call = calls.filter((c) => c.url === "/hrms/helpdesk/categories").pop();
    expect(call.params.includeInactive).toBe("true");
  });

  it("creates one, upper-casing the code", async () => {
    signIn([R.SUPER_ADMIN]);
    at("/hrms/helpdesk/categories");

    await userEvent.click(await screen.findByRole("button", { name: /New category/i }));
    await userEvent.type(await screen.findByLabelText("Code"), "payroll_q");
    await userEvent.type(screen.getByLabelText("Name"), "Payroll queries");
    await userEvent.selectOptions(screen.getByLabelText("Answered by"), "helpdesk:payroll");
    await userEvent.click(inDrawer("Save"));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "post" && c.url === "/hrms/helpdesk/categories",
      );
      expect(post.data.code).toBe("PAYROLL_Q");
      expect(post.data.resolverModule).toBe("helpdesk:payroll");
    });
  });

  it("will not let the code change on edit", async () => {
    signIn([R.SUPER_ADMIN]);
    at("/hrms/helpdesk/categories");

    await userEvent.click(await screen.findByRole("button", { name: "Edit IT" }));
    const code = await screen.findByLabelText("Code");
    expect(code.disabled).toBe(true);

    await userEvent.click(inDrawer("Save"));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "patch");
      expect(patch.data.code).toBeUndefined();
    });
  });

  it("confirms before deleting and explains the in-use rule", async () => {
    signIn([R.SUPER_ADMIN]);
    at("/hrms/helpdesk/categories");

    await userEvent.click(await screen.findByRole("button", { name: "Delete IT" }));
    expect(await screen.findByText(/Delete IT\?/)).toBeTruthy();
    expect(screen.getByText(/cannot be deleted/i)).toBeTruthy();
    expect(urlsHit().some((u) => u.startsWith("DELETE"))).toBe(false);
  });
});

// ===========================================================================
// Formatting
// ===========================================================================

describe("formatSla", () => {
  it("counts down in the unit that reads best", () => {
    expect(formatSla({ slaBreached: false, slaHoursRemaining: 0.5 })).toBe("30m left");
    expect(formatSla({ slaBreached: false, slaHoursRemaining: 6 })).toBe("6h left");
    expect(formatSla({ slaBreached: false, slaHoursRemaining: 50 })).toBe("2d left");
  });

  it("says so when the SLA has gone", () => {
    expect(formatSla({ slaBreached: true, slaHoursRemaining: 0 })).toBe("SLA breached");
  });

  it("renders a settled ticket as a dash rather than NaN", () => {
    expect(formatSla({ slaBreached: false, slaHoursRemaining: null })).toBe("—");
  });
});
