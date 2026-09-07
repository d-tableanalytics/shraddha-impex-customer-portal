/**
 * Attendance — the page shell, the clock card, corrections and consent.
 *
 * Only the axios instance is mocked. The HRMS client, the shared Zod schemas
 * and the shared permission matrix are all real, so these cover the request
 * URLs, the `{ success, data }` unwrapping and the permission gating as well
 * as the rendering.
 *
 * The camera and geolocation are stubbed at the browser API, not at the
 * component, so the permission-denied paths exercise the real branching in
 * `deviceCapture`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../../services/api", () => ({ api: { request: vi.fn() } }));

import { api } from "../../../services/api";
import { AttendancePage } from "./AttendancePage";
import { useHrmsStore } from "../../../store/hrmsStore";
import { buildHrmsActor } from "@shared/permissions/has-permission.js";
import { HRMS_ROLES as R, HRMS_MODULES as M } from "@shared/permissions/constants.js";
import { CONSENT_PURPOSES as PURPOSES } from "@shared/constants/hrms.js";
import { toUtcIso } from "./CorrectionDrawer";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TODAY = "2026-09-02";

/**
 * `1 September 2026`, as the page actually renders it.
 *
 * A regex rather than a literal because `en-GB` abbreviates September as
 * "Sept" on ICU 72 and later and as "Sep" before it — so a hardcoded string
 * would pass or fail on the Node build rather than on the code.
 */
const SEP_1 = /^01 Sept? 2026$/;

const record = (over = {}) => ({
  id: "rec1",
  employeeId: "e1",
  date: TODAY,
  clockIn: null,
  clockOut: null,
  source: "web",
  status: "present",
  notes: null,
  clockInCapture: { hasSelfie: false, geo: null, locationLabel: null },
  clockOutCapture: { hasSelfie: false, geo: null, locationLabel: null },
  hoursWorked: 0,
  derived: { kind: "absent", label: "Absent", tone: "neutral", hint: null, hoursWorked: 0 },
  corrected: false,
  ...over,
});

const CLOCKED_IN = record({
  clockIn: `${TODAY}T03:30:00.000Z`,
  derived: {
    kind: "in_progress",
    label: "On the clock",
    tone: "primary",
    hint: "Working — 2h 00m so far, not clocked out yet",
    hoursWorked: 2,
  },
});

const HISTORY = {
  data: [
    record({
      id: "rec-a",
      date: "2026-09-01",
      clockIn: "2026-09-01T03:30:00.000Z",
      clockOut: "2026-09-01T12:30:00.000Z",
      hoursWorked: 9,
      derived: { kind: "full_day", label: "Full day", tone: "success", hint: null, hoursWorked: 9 },
      clockInCapture: { hasSelfie: true, geo: { lat: 22.7, lng: 75.8 }, locationLabel: "MG Road, Indore" },
    }),
    record({
      id: "rec-b",
      date: "2026-08-31",
      clockIn: null,
      clockOut: null,
    }),
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};

const consentState = ({ selfie = false, location = false } = {}) => ({
  [PURPOSES.ATTENDANCE_SELFIE]: {
    purpose: PURPOSES.ATTENDANCE_SELFIE,
    granted: selfie,
    decided: selfie,
    supersededByNewVersion: false,
    notice: {
      version: 1,
      title: "Photograph at clock-in and clock-out",
      body: "A photograph is taken from your device camera each time you clock in or out.",
      optional: "You may decline, and you may withdraw at any time.",
    },
  },
  [PURPOSES.ATTENDANCE_LOCATION]: {
    purpose: PURPOSES.ATTENDANCE_LOCATION,
    granted: location,
    decided: location,
    supersededByNewVersion: false,
    notice: {
      version: 1,
      title: "Location at clock-in and clock-out",
      body: "Your device location is read at the moment you clock in or out.",
      optional: "You may decline, and you may withdraw at any time.",
    },
  },
});

const CORRECTIONS = {
  data: [
    {
      id: "c1",
      employeeId: "e2",
      employeeName: "Asha Rao",
      employeeCode: "EMP002",
      date: "2026-09-01",
      requestedClockIn: "2026-09-01T03:30:00.000Z",
      requestedClockOut: null,
      reason: "I forgot to clock in when I arrived.",
      status: "pending",
      comment: null,
      decidedAt: null,
      createdAt: "2026-09-01T13:00:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

const TEAM = [
  {
    employeeId: "e2",
    employeeCode: "EMP002",
    displayName: "Asha Rao",
    employmentStatus: "active",
    recordId: "rec-t",
    clockIn: `${TODAY}T03:30:00.000Z`,
    clockOut: null,
    status: "present",
    source: "web",
    clockInCapture: { hasSelfie: true, geo: null, locationLabel: null },
    clockOutCapture: { hasSelfie: false, geo: null, locationLabel: null },
    derived: { kind: "in_progress", label: "On the clock", tone: "primary", hint: null, hoursWorked: 2 },
    hoursWorked: 2,
  },
  {
    employeeId: "e3",
    employeeCode: "EMP003",
    displayName: "Bala Nair",
    employmentStatus: "active",
    recordId: null,
    clockIn: null,
    clockOut: null,
    status: "absent",
    source: null,
    clockInCapture: { hasSelfie: false, geo: null, locationLabel: null },
    clockOutCapture: { hasSelfie: false, geo: null, locationLabel: null },
    derived: { kind: "absent", label: "Absent", tone: "neutral", hint: null, hoursWorked: 0 },
    hoursWorked: 0,
  },
];

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

let calls = [];
const envelope = (payload) => ({ data: { success: true, data: payload } });
const fail = (status, body) => Promise.reject({ response: { status, data: body } });

function installTransport(overrides = {}) {
  calls = [];
  api.request.mockImplementation(async (config) => {
    calls.push(config);
    const key = `${config.method.toUpperCase()} ${config.url}`;
    if (overrides[key]) return overrides[key](config);

    if (key === "GET /hrms/attendance/today") return envelope(null);
    if (key === "GET /hrms/attendance") return envelope(HISTORY);
    if (key === "GET /hrms/attendance/team-grid") return envelope(TEAM);
    if (key === "GET /hrms/attendance/consent") return envelope(consentState());
    if (key === "GET /hrms/attendance/corrections") return envelope(CORRECTIONS);
    if (key === "POST /hrms/attendance/consent") {
      return envelope({ purpose: config.data.purpose, granted: config.data.granted, state: consentState() });
    }
    if (key === "POST /hrms/attendance/clock-in") return envelope(CLOCKED_IN);
    if (key === "POST /hrms/attendance/clock-out") return envelope(record({ clockOut: `${TODAY}T12:30:00.000Z` }));
    if (key === "POST /hrms/attendance/corrections") return envelope({ id: "new" });
    if (key.startsWith("POST /hrms/attendance/corrections/")) return envelope({ id: "c1" });
    if (key.startsWith("GET /hrms/attendance/records/")) {
      return envelope({ url: "https://example.invalid/signed.jpg", expiresInSeconds: 60 });
    }
    throw new Error(`unstubbed: ${key}`);
  });
}

const signIn = (roles) =>
  useHrmsStore.setState({
    actor: buildHrmsActor({ userId: "u1", roles, employee: { id: "e1" } }),
    implementedModules: [M.DASHBOARD, M.EMPLOYEES, M.ORG_STRUCTURE, M.ATTENDANCE],
    loaded: true,
    loading: false,
    error: null,
  });

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hrms/attendance" element={<AttendancePage />} />
        <Route path="/hrms/attendance/:tab" element={<AttendancePage />} />
      </Routes>
    </MemoryRouter>,
  );

/**
 * The block "Request correction" button beside the clock card.
 *
 * The page renders two, as the reference does — a shortcut in the header and
 * this one next to the card it relates to — so a bare `getByRole` would be
 * ambiguous. The last match is the block button.
 */
const openCorrectionDrawer = async () => {
  const buttons = await screen.findAllByRole("button", { name: /request correction/i });
  return buttons[buttons.length - 1];
};

beforeEach(() => {
  useHrmsStore.getState().clear();
  installTransport();
});

afterEach(() => {
  // Restore anything a test attached to navigator.
  vi.unstubAllGlobals();
});

// ===========================================================================
// Page shell and tabs
// ===========================================================================

describe("the page shell", () => {
  it("renders the title and a header 'Request correction' action, and no description line", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    expect(await screen.findByRole("heading", { name: "Attendance" })).toBeTruthy();

    // The reference puts the action in the page header beside the title, and
    // carries no description line under it.
    const actions = screen.getAllByRole("button", { name: /request correction/i });
    expect(actions.length).toBe(2); // header shortcut + the block button by the card
    expect(screen.queryByText(/Clock in and out, review your history/i)).toBeNull();
  });

  it("shows an employee only My Attendance and My corrections", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["My Attendance", "My corrections"]);
  });

  it("adds the Team tab for a manager, and labels corrections as approvals", async () => {
    signIn([R.MANAGER]);
    at("/hrms/attendance/me");

    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "My Attendance",
      "Team",
      "Corrections (approvals)",
    ]);
  });

  it("does not render the Team tab's request when the actor cannot see a team", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/team");

    // Guarded rather than merely hidden: reaching /team by URL must not fire
    // the request at all.
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.some((c) => c.url === "/hrms/attendance/team-grid")).toBe(false);
  });
});

// ===========================================================================
// Loading, empty, error
// ===========================================================================

describe("states", () => {
  it("shows a loading skeleton before the history arrives", async () => {
    // One deferred, created up front, so the resolver cannot be reassigned by
    // a second request mid-test and left pointing at the wrong promise.
    let release;
    const pending = new Promise((resolve) => {
      release = () => resolve(envelope(HISTORY));
    });
    installTransport({ "GET /hrms/attendance": () => pending });

    signIn([R.EMPLOYEE]);
    const { container } = at("/hrms/attendance/me");

    // The skeleton is rendered inside the table, and no real row is present.
    await waitFor(() => expect(container.querySelectorAll("table").length).toBe(1));
    expect(screen.queryByText(SEP_1)).toBeNull();

    release();
    expect(await screen.findByText(SEP_1, {}, { timeout: 3000 })).toBeTruthy();
  });

  it("renders an empty state when there is no history", async () => {
    installTransport({
      "GET /hrms/attendance": () => envelope({ data: [], total: 0, page: 1, pageSize: 25 }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    expect(await screen.findByText("No attendance yet")).toBeTruthy();
  });

  it("renders an error state, not an empty one, when the request fails", async () => {
    installTransport({
      "GET /hrms/attendance": () => fail(500, { message: "Database unavailable." }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("Database unavailable.")).toBeTruthy();
    expect(screen.queryByText("No attendance yet")).toBeNull();
  });

  it("renders a refusal, not a retry, for a 403", async () => {
    installTransport({
      "GET /hrms/attendance": () => fail(403, { message: "Forbidden." }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    expect(await screen.findByText("You do not have access")).toBeTruthy();
    // Retrying a 403 fails identically, so the action is not offered.
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });
});

// ===========================================================================
// The clock card
// ===========================================================================

describe("the clock card", () => {
  it("offers Clock in when the day has not started", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    expect(await screen.findByRole("button", { name: /clock in/i })).toBeTruthy();
    expect(screen.getByText(/Ready to clock in/i)).toBeTruthy();
  });

  it("offers Clock out once clocked in", async () => {
    installTransport({ "GET /hrms/attendance/today": () => envelope(CLOCKED_IN) });
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    expect(await screen.findByRole("button", { name: /clock out/i })).toBeTruthy();
    expect(screen.getByText(/On the clock/i)).toBeTruthy();
  });

  it("clocks in with NO capture when neither consent is granted", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    await userEvent.click(await screen.findByRole("button", { name: /clock in/i }));

    await waitFor(() => {
      const punch = calls.find((c) => c.url === "/hrms/attendance/clock-in");
      expect(punch).toBeTruthy();
      // The whole point of AD-15: no consent means nothing is asked for and
      // nothing is sent, and the punch still happens.
      expect(punch.data.selfieKey).toBeUndefined();
      expect(punch.data.geo).toBeUndefined();
    });
  });

  it("sends coordinates when location consent is granted", async () => {
    vi.stubGlobal("isSecureContext", true);
    const getCurrentPosition = vi.fn((ok) =>
      ok({ coords: { latitude: 22.7196, longitude: 75.8577, accuracy: 11.4 } }),
    );
    vi.stubGlobal("navigator", { ...navigator, geolocation: { getCurrentPosition } });

    installTransport({
      "GET /hrms/attendance/consent": () => envelope(consentState({ location: true })),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    await userEvent.click(await screen.findByRole("button", { name: /clock in/i }));

    await waitFor(() => {
      const punch = calls.find((c) => c.url === "/hrms/attendance/clock-in");
      expect(punch?.data.geo).toEqual({ lat: 22.7196, lng: 75.8577, accuracy: 11 });
    });
  });

  it("still records the punch when location permission is DENIED, and says so", async () => {
    vi.stubGlobal("isSecureContext", true);
    // code 1 is PERMISSION_DENIED.
    const getCurrentPosition = vi.fn((_ok, fail_) => fail_({ code: 1 }));
    vi.stubGlobal("navigator", { ...navigator, geolocation: { getCurrentPosition } });

    installTransport({
      "GET /hrms/attendance/consent": () => envelope(consentState({ location: true })),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    await userEvent.click(await screen.findByRole("button", { name: /clock in/i }));

    await waitFor(() => {
      const punch = calls.find((c) => c.url === "/hrms/attendance/clock-in");
      expect(punch).toBeTruthy();
      expect(punch.data.geo).toBeUndefined();
    });

    // Truthful, and specific about what the person can do — the reference
    // shows one "please retry" for every failure, including the ones retrying
    // cannot fix.
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toMatch(/Location was not recorded/i);
    expect(notice.textContent).toMatch(/padlock/i);
  });

  it("still records the punch when the camera is unavailable", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn(() => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" }))),
      },
    });

    installTransport({
      "GET /hrms/attendance/consent": () => envelope(consentState({ selfie: true })),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    await userEvent.click(await screen.findByRole("button", { name: /clock in/i }));

    // The modal opens and reports the failure honestly, and offers a way
    // through — the reference offers only Retry and Cancel, so a broken camera
    // means no attendance at all.
    expect(await screen.findByText(/Camera unavailable/i)).toBeTruthy();
    expect(screen.getByText(/padlock/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /continue without a photo/i }));

    await waitFor(() => {
      const punch = calls.find((c) => c.url === "/hrms/attendance/clock-in");
      expect(punch).toBeTruthy();
      expect(punch.data.selfieKey).toBeUndefined();
    });
  });

  it("lets the employee skip the photo, and stops the camera when it does", async () => {
    vi.stubGlobal("isSecureContext", true);
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] };
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(() => Promise.resolve(stream)) },
    });

    installTransport({
      "GET /hrms/attendance/consent": () => envelope(consentState({ selfie: true })),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    await userEvent.click(await screen.findByRole("button", { name: /clock in/i }));
    await userEvent.click(await screen.findByRole("button", { name: /skip the photo/i }));

    await waitFor(() => {
      expect(calls.some((c) => c.url === "/hrms/attendance/clock-in")).toBe(true);
    });
    // A track left running keeps the device's camera indicator lit.
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });

  it("surfaces a 409 rather than pretending the punch worked", async () => {
    installTransport({
      "POST /hrms/attendance/clock-in": () =>
        fail(409, { message: "You have already clocked in today.", code: "ATTENDANCE_ALREADY_CLOCKED_IN" }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    await userEvent.click(await screen.findByRole("button", { name: /clock in/i }));

    expect(await screen.findByText("You have already clocked in today.")).toBeTruthy();
  });
});

// ===========================================================================
// Consent
// ===========================================================================

describe("consent", () => {
  it("shows an un-answered state compactly, with the SERVER's notice one click away", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    // Compact by default — the reference has no consent UI at all, so this
    // must not outweigh the clock card. One row per purpose, state on the right.
    expect(await screen.findByText("Photo at punch")).toBeTruthy();
    expect(screen.getByText("Location at punch")).toBeTruthy();
    expect(screen.getAllByText("Not set").length).toBe(2);

    // Folded away, never removed: the wording still comes from the server, so
    // the page can never show one notice while the ledger records another.
    expect(screen.queryByText(/A photograph is taken from your device camera/i)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /photo at punch/i }));
    expect(
      await screen.findByText(/A photograph is taken from your device camera/i),
    ).toBeTruthy();
    expect(screen.getByText(/You may decline, and you may withdraw at any time/i)).toBeTruthy();
  });

  it("grants consent, and withdrawing takes exactly one click too", async () => {
    installTransport({
      "GET /hrms/attendance/consent": () => envelope(consentState({ selfie: true })),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    // Already granted -> the control is a single Withdraw button, with no
    // confirmation in front of it. DPDP requires withdrawal to be as easy as
    // granting, and an extra step is how that requirement gets quietly lost.
    const withdraw = await screen.findByRole("button", { name: /withdraw/i });
    await userEvent.click(withdraw);

    await waitFor(() => {
      const posted = calls.find((c) => c.url === "/hrms/attendance/consent" && c.method === "post");
      expect(posted.data).toEqual({
        purpose: PURPOSES.ATTENDANCE_SELFIE,
        granted: false,
      });
    });
  });

  it("reloads after a withdrawal, because it erases captured data", async () => {
    installTransport({
      "GET /hrms/attendance/consent": () => envelope(consentState({ selfie: true })),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    await userEvent.click(await screen.findByRole("button", { name: /withdraw/i }));

    await waitFor(() => {
      const historyCalls = calls.filter((c) => c.url === "/hrms/attendance" && c.method === "get");
      expect(historyCalls.length).toBeGreaterThan(1);
    });
  });
});

// ===========================================================================
// History table
// ===========================================================================

describe("the history table", () => {
  it("renders the server's derived status rather than recomputing it", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    expect(await screen.findByText("Full day")).toBeTruthy();
    // The reference's Hours column is `.toFixed(2)` decimal hours, not "9h 00m".
    expect(screen.getByText("9.00")).toBeTruthy();
    expect(screen.getByText("MG Road, Indore")).toBeTruthy();
    // Source sits before Status, as in the reference's column order.
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent.trim());
    expect(headers).toEqual([
      "Date",
      "Clock in",
      "Clock out",
      "Hours",
      "Source",
      "Status",
      "Selfie / Location",
    ]);
  });

  it("offers a correction link on a day with no punch", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    const links = await screen.findAllByRole("button", { name: /add correction/i });
    expect(links.length).toBe(2); // one for clock-in, one for clock-out on 31 Aug
  });

  it("fetches a presigned URL only when a photo is actually opened", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    const thumb = await screen.findByRole("button", { name: /view the in photo/i });
    // Nothing has been requested yet — issuing a URL is an audited photograph
    // view, so a table must not mint one per row.
    expect(calls.some((c) => c.url.includes("/selfie/"))).toBe(false);

    await userEvent.click(thumb);

    await waitFor(() => {
      expect(calls.some((c) => c.url === "/hrms/attendance/records/rec-a/selfie/in")).toBe(true);
    });
    expect(await screen.findByAltText(/in punch photo/i)).toBeTruthy();
  });
});

// ===========================================================================
// Corrections
// ===========================================================================

describe("corrections", () => {
  it("validates with the shared schema before sending anything", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    await userEvent.click(await openCorrectionDrawer());
    await userEvent.click(await screen.findByRole("button", { name: /submit request/i }));

    // Nothing is posted: no times, and no reason.
    expect(calls.some((c) => c.url === "/hrms/attendance/corrections" && c.method === "post")).toBe(false);
    expect(await screen.findByText(/at least 10 characters/i)).toBeTruthy();
  });

  it("opens the drawer from the header shortcut too", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    // The header button sits above the tabs, so it signals the tab rather than
    // reaching into it. Both routes must land on the same drawer.
    const [headerButton] = await screen.findAllByRole("button", {
      name: /request correction/i,
    });
    await userEvent.click(headerButton);

    expect(
      await screen.findByRole("heading", { name: /request attendance correction/i }),
    ).toBeTruthy();
  });

  it("submits a correction with times resolved to absolute instants", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    await userEvent.click(await openCorrectionDrawer());

    const dialog = await screen.findByRole("heading", { name: /request attendance correction/i });
    expect(dialog).toBeTruthy();

    const date = screen.getByLabelText("Date");
    await userEvent.clear(date);
    await userEvent.type(date, "2026-09-01");

    await userEvent.type(screen.getByLabelText("Requested clock-in time"), "09:00");
    await userEvent.type(
      screen.getByLabelText("Reason"),
      "I arrived on site at nine and forgot to clock in.",
    );

    await userEvent.click(screen.getByRole("button", { name: /submit request/i }));

    await waitFor(() => {
      const posted = calls.find((c) => c.url === "/hrms/attendance/corrections" && c.method === "post");
      expect(posted).toBeTruthy();
      expect(posted.data.date).toBe("2026-09-01");
      // 09:00 in Asia/Kolkata is 03:30 UTC. A naive `new Date(date + 'T' + time)`
      // would have used the BROWSER's zone and filed the wrong instant.
      expect(posted.data.requestedClockIn).toBe("2026-09-01T03:30:00.000Z");
      expect(posted.data.requestedClockOut).toBeNull();
    });
  });

  it("surfaces a duplicate-request conflict", async () => {
    installTransport({
      "POST /hrms/attendance/corrections": () =>
        fail(409, {
          message: "You already have a correction awaiting a decision for 2026-09-01.",
          code: "CORRECTION_ALREADY_PENDING",
        }),
    });
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/me");

    await userEvent.click(await openCorrectionDrawer());
    await userEvent.type(screen.getByLabelText("Requested clock-in time"), "09:00");
    await userEvent.type(
      screen.getByLabelText("Reason"),
      "A second attempt at the very same day.",
    );
    await userEvent.click(screen.getByRole("button", { name: /submit request/i }));

    expect(await screen.findByText(/already have a correction awaiting/i)).toBeTruthy();
  });

  it("hides the decision buttons from someone who cannot approve", async () => {
    signIn([R.EMPLOYEE]);
    at("/hrms/attendance/corrections");

    expect(await screen.findByText("Asha Rao")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject/i })).toBeNull();
  });

  it("lets an approver approve, and refreshes afterwards", async () => {
    signIn([R.MANAGER]);
    at("/hrms/attendance/corrections");

    await userEvent.click(await screen.findByRole("button", { name: /approve/i }));

    await waitFor(() => {
      const decided = calls.find((c) => c.url === "/hrms/attendance/corrections/c1/decide");
      expect(decided.data).toEqual({ decision: "approve", comment: undefined });
    });
    await waitFor(() => {
      expect(
        calls.filter((c) => c.url === "/hrms/attendance/corrections" && c.method === "get").length,
      ).toBeGreaterThan(1);
    });
  });

  it("reports a decision that lost a race instead of failing silently", async () => {
    installTransport({
      "POST /hrms/attendance/corrections/c1/decide": () =>
        fail(409, { message: "This correction was already approved.", code: "CORRECTION_ALREADY_DECIDED" }),
    });
    signIn([R.MANAGER]);
    at("/hrms/attendance/corrections");

    await userEvent.click(await screen.findByRole("button", { name: /approve/i }));

    expect(await screen.findByText("This correction was already approved.")).toBeTruthy();
  });

  it("filters by status and resets to page 1", async () => {
    signIn([R.MANAGER]);
    at("/hrms/attendance/corrections");

    await screen.findByText("Asha Rao");
    const before = calls.filter((c) => c.url === "/hrms/attendance/corrections").length;

    await userEvent.click(screen.getByRole("button", { name: /status/i }));
    await userEvent.click(await screen.findByText("Approved"));

    await waitFor(() => {
      const latest = calls
        .filter((c) => c.url === "/hrms/attendance/corrections" && c.method === "get")
        .at(-1);
      expect(latest.params.status).toBe("approved");
      expect(latest.params.page).toBe(1);
    });
    expect(
      calls.filter((c) => c.url === "/hrms/attendance/corrections").length,
    ).toBeGreaterThan(before);
  });
});

// ===========================================================================
// Team tab
// ===========================================================================

describe("the team tab", () => {
  it("lists everyone, including the people who have not arrived", async () => {
    signIn([R.MANAGER]);
    at("/hrms/attendance/team");

    expect(await screen.findByText("Asha Rao")).toBeTruthy();
    expect(screen.getByText("Bala Nair")).toBeTruthy();
    expect(screen.getByText("Absent")).toBeTruthy();
  });

  it("carries the reference's columns and no invented Hours column", async () => {
    signIn([R.MANAGER]);
    at("/hrms/attendance/team");

    await screen.findByText("Asha Rao");
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent.trim());
    // `AttendancePage.tsx:266-350` — Employee, Clock in, Clock out, Status,
    // Selfie / Location. The reference has no Hours column here.
    expect(headers).toEqual([
      "Employee",
      "Clock in",
      "Clock out",
      "Status",
      "Selfie / Location",
    ]);
  });

  it("summarises how many of the team have clocked in", async () => {
    signIn([R.MANAGER]);
    at("/hrms/attendance/team");

    expect(await screen.findByText(/of\s+2\s+clocked in/i)).toBeTruthy();
  });

  it("offers no photo control for someone with no record today", async () => {
    signIn([R.MANAGER]);
    at("/hrms/attendance/team");

    await screen.findByText("Bala Nair");
    // Asha has one; Bala has no record, so there is nothing to fetch against.
    expect(screen.getAllByRole("button", { name: /view the in photo/i }).length).toBe(1);
  });
});

// ===========================================================================
// Time-zone helper
// ===========================================================================

describe("toUtcIso", () => {
  it("resolves a wall time in the BUSINESS zone, not the browser's", () => {
    // 09:00 IST is 03:30 UTC, year-round — India has no DST.
    expect(toUtcIso("2026-09-01", "09:00")).toBe("2026-09-01T03:30:00.000Z");
    expect(toUtcIso("2026-01-15", "18:45")).toBe("2026-01-15T13:15:00.000Z");
  });

  it("returns null when either half is missing", () => {
    expect(toUtcIso("2026-09-01", "")).toBeNull();
    expect(toUtcIso("", "09:00")).toBeNull();
  });
});


