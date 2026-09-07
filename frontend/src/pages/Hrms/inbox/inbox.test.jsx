/**
 * Inbox — the page, the header bell, and the permission gate on both.
 *
 * Only the axios instance is mocked. The HRMS client, the shared constants and
 * the shared permission matrix are all real, so these cover the request URLs,
 * the `{ success, data }` unwrapping and the gating as well as the rendering.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../../services/api";
import { InboxPage } from "./InboxPage";
import { InboxBell } from "../../../components/hrms/InboxBell";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";
import { INBOX_TYPES } from "@shared/constants/inbox.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const item = (over = {}) => ({
  id: "i1",
  type: INBOX_TYPES.LEAVE_PENDING,
  typeLabel: "Leave request",
  category: "action",
  actionable: true,
  title: "Priya requested 2 day(s) of CL",
  body: "Awaiting your approval.",
  entity: "leave_request",
  entityId: "507f1f77bcf86cd799439011",
  href: "/hrms/leave/approvals",
  read: false,
  readAt: null,
  archived: false,
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...over,
});

const LIST = {
  data: [
    item(),
    item({
      id: "i2",
      type: INBOX_TYPES.ANNOUNCEMENT_PUBLISHED,
      typeLabel: "Announcement",
      category: "announcement",
      actionable: false,
      title: "Office closed Friday",
      body: null,
      entity: "announcement",
      href: "/hrms/engage/announcements",
      read: true,
      readAt: new Date().toISOString(),
      createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    }),
  ],
  total: 2,
  page: 1,
  pageSize: 25,
  unread: 1,
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

    if (key === "GET /hrms/inbox") return envelope(LIST);
    if (key === "GET /hrms/inbox/unread-count") return envelope({ count: 3 });

    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles, { modules = [M.DASHBOARD, M.INBOX] } = {}) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee: { id: "e1" } }),
    implementedModules: modules,
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path = "/hrms/inbox") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/inbox" element={<InboxPage />} />
        <Route path="/hrms/leave/approvals" element={<div>Leave approvals screen</div>} />
      </Routes>
    </MemoryRouter>,
  );

const renderBell = () =>
  render(
    <MemoryRouter>
      <InboxBell />
    </MemoryRouter>,
  );

const lastCall = (url) => [...calls].reverse().find((c) => c.url === url);

beforeEach(() => {
  vi.clearAllMocks();
  installTransport();
  signIn([R.EMPLOYEE]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================

describe("the header bell", () => {
  it("shows the unread count and links to the inbox", async () => {
    renderBell();

    const link = await screen.findByRole("link", { name: /Inbox, 3 unread/i });
    expect(link.getAttribute("href")).toBe("/hrms/inbox");
    expect(link.textContent).toContain("3");
  });

  it("caps the badge at 99+", async () => {
    installTransport({ "GET /hrms/inbox/unread-count": async () => envelope({ count: 250 }) });
    renderBell();

    const link = await screen.findByRole("link", { name: /Inbox/i });
    await waitFor(() => expect(link.textContent).toContain("99+"));
  });

  it("renders nothing at all for somebody with no inbox grant", () => {
    // A portal account with no HRMS role — the shared top bar must not sprout
    // an HRMS control for them. 🔴 The reference's nav entry requires nothing.
    useHrmsStore.setState({
      actor: null,
      implementedModules: [],
      loaded: true,
      loading: false,
      error: null,
    });

    const { container } = renderBell();
    expect(container.innerHTML).toBe("");
    expect(api.request).not.toHaveBeenCalled();
  });

  it("renders nothing when Inbox is not a built module", () => {
    signIn([R.EMPLOYEE], { modules: [M.DASHBOARD] });
    const { container } = renderBell();
    expect(container.innerHTML).toBe("");
  });

  it("shows no badge when there is nothing unread", async () => {
    installTransport({ "GET /hrms/inbox/unread-count": async () => envelope({ count: 0 }) });
    renderBell();

    const link = await screen.findByRole("link", { name: "Inbox" });
    await waitFor(() => expect(link.textContent.trim()).toBe(""));
  });

  it("survives a failed poll without breaking the top bar", async () => {
    installTransport({
      "GET /hrms/inbox/unread-count": async () => {
        throw new Error("network");
      },
    });
    renderBell();

    const link = await screen.findByRole("link", { name: "Inbox" });
    expect(link).toBeTruthy();
  });
});

// ===========================================================================

describe("the inbox page", () => {
  it("lists items with their human label, not the raw type", async () => {
    at();

    expect(await screen.findByText("Priya requested 2 day(s) of CL")).toBeTruthy();
    expect(screen.getByText("Leave request")).toBeTruthy();
    expect(screen.getByText("Announcement")).toBeTruthy();
    // 🔴 The reference renders `item.type` verbatim in a coloured pill.
    expect(screen.queryByText(INBOX_TYPES.LEAVE_PENDING)).toBeNull();
  });

  it("marks unread items apart, and shows the action hint", async () => {
    at();

    const unread = (await screen.findByText("Priya requested 2 day(s) of CL")).closest("article");
    const read = screen.getByText("Office closed Friday").closest("article");

    expect(unread.className).toContain("bg-primary-50/40");
    expect(read.className).toContain("bg-white");
    expect(within(unread).getByText(/action needed/)).toBeTruthy();
  });

  it("shows a relative timestamp that degrades to a date", async () => {
    at();
    expect(await screen.findByText(/5 minutes ago/)).toBeTruthy();
    expect(screen.getByText(/3 days ago/)).toBeTruthy();
  });

  it("marks read and follows the deep link when a row is opened", async () => {
    const user = userEvent.setup();
    const marked = vi.fn(async () => envelope(item({ read: true })));
    installTransport({ "POST /hrms/inbox/i1/read": marked });

    at();
    await user.click(await screen.findByText("Priya requested 2 day(s) of CL"));

    await waitFor(() => expect(marked).toHaveBeenCalled());
    // The target route renders — the link is server-derived and followed.
    expect(await screen.findByText("Leave approvals screen")).toBeTruthy();
  });

  it("still navigates when marking read fails", async () => {
    const user = userEvent.setup();
    installTransport({
      "POST /hrms/inbox/i1/read": async () => {
        throw new Error("network");
      },
    });

    at();
    await user.click(await screen.findByText("Priya requested 2 day(s) of CL"));

    expect(await screen.findByText("Leave approvals screen")).toBeTruthy();
  });

  it("marks all read", async () => {
    const user = userEvent.setup();
    const all = vi.fn(async () => envelope({ updated: 1 }));
    installTransport({ "POST /hrms/inbox/read-all": all });

    at();
    await user.click(await screen.findByRole("button", { name: /Mark all read/i }));

    await waitFor(() => expect(all).toHaveBeenCalled());
  });

  it("disables mark-all when nothing is unread", async () => {
    installTransport({ "GET /hrms/inbox": async () => envelope({ ...LIST, unread: 0 }) });
    at();

    const button = await screen.findByRole("button", { name: /Mark all read/i });
    await waitFor(() => expect(button.disabled).toBe(true));
  });

  it("toggles a single item back to unread — the reference has no way back", async () => {
    const user = userEvent.setup();
    const unmark = vi.fn(async () => envelope(item({ id: "i2", read: false })));
    installTransport({ "POST /hrms/inbox/i2/unread": unmark });

    at();
    await user.click(
      await screen.findByRole("button", { name: /Mark "Office closed Friday" unread/i }),
    );

    await waitFor(() => expect(unmark).toHaveBeenCalled());
  });

  it("archives an item — the reference has no delete and no archive", async () => {
    const user = userEvent.setup();
    const archive = vi.fn(async () => envelope({ updated: 1 }));
    installTransport({ "POST /hrms/inbox/archive": archive });

    at();
    await user.click(
      await screen.findByRole("button", { name: /Archive "Priya requested 2 day\(s\) of CL"/i }),
    );

    await waitFor(() => expect(archive).toHaveBeenCalled());
    expect(archive.mock.calls[0][0].data.ids).toEqual(["i1"]);
  });

  it("filters by state through the URL, so a view is linkable", async () => {
    const user = userEvent.setup();
    at();

    await screen.findByText("Priya requested 2 day(s) of CL");
    await user.click(screen.getByRole("tab", { name: /Unread/ }));

    await waitFor(() => expect(lastCall("/hrms/inbox").params.state).toBe("unread"));
  });

  it("opens straight into a filtered view from the URL", async () => {
    at("/hrms/inbox?state=unread&category=action");

    await waitFor(() => {
      const request = lastCall("/hrms/inbox");
      expect(request.params.state).toBe("unread");
      expect(request.params.category).toBe("action");
    });
  });

  it("pages, rather than stopping at a fixed ceiling", async () => {
    installTransport({
      "GET /hrms/inbox": async () => envelope({ ...LIST, total: 120, unread: 40 }),
    });
    at();

    await screen.findByText("Priya requested 2 day(s) of CL");
    // 🔴 The reference fetches the newest 100 and offers no way past them.
    // The bar must show a real range — `Pagination` takes `totalItems`, and
    // handing it the wrong prop names renders "Showing NaN to NaN of NaN".
    expect(screen.getByText("120")).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("shows the empty state when there is nothing", async () => {
    installTransport({
      "GET /hrms/inbox": async () => envelope({ data: [], total: 0, page: 1, pageSize: 25, unread: 0 }),
    });
    at();

    expect(await screen.findByText(/You are all caught up/i)).toBeTruthy();
  });

  it("surfaces a server error with a retry", async () => {
    installTransport({
      "GET /hrms/inbox": async () => {
        const error = new Error("Something broke.");
        error.response = { status: 500, data: { success: false, message: "Something broke." } };
        throw error;
      },
    });
    at();

    expect(await screen.findByText(/Something broke/)).toBeTruthy();
  });
});
