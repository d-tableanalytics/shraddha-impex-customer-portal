import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The browser follows access changes without a re-login: it polls a short
 * fingerprint and re-reads the session only when it moved, and checks again
 * right after a 403.
 */

const api = vi.hoisted(() => {
  const handlers = [];
  return {
    get: vi.fn(),
    interceptors: { response: { use: vi.fn((ok, bad) => { handlers.push(bad); return handlers.length; }), eject: vi.fn() } },
    _fail: (error) => handlers.forEach((h) => h(error).catch(() => {})),
  };
});
vi.mock("./socketService", () => ({ refreshSocketAuth: vi.fn() }));
vi.mock("./api", () => ({ api, describeRequestFailure: (_e, f) => f, refreshAccessToken: vi.fn() }));

import { checkAccess, startAccessSync } from "./accessSync";
import { useUserStore } from "../store/userStore";

const refreshSession = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem("token", "t");
  useUserStore.setState({ user: { _id: "u1", role: "Sales", accessVersion: "aaa" }, refreshSession });
});
afterEach(() => { vi.useRealTimers(); });

describe("access sync", () => {
  test("re-reads the session when the fingerprint changed", async () => {
    api.get.mockResolvedValue({ data: { data: { accessVersion: "bbb" } } });
    expect(await checkAccess()).toBe(true);
    expect(api.get).toHaveBeenCalledWith("/auth/access-version");
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  test("does nothing when it did not", async () => {
    api.get.mockResolvedValue({ data: { data: { accessVersion: "aaa" } } });
    expect(await checkAccess()).toBe(false);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  test("does not ask when nobody is signed in", async () => {
    useUserStore.setState({ user: null });
    expect(await checkAccess()).toBe(false);
    expect(api.get).not.toHaveBeenCalled();
  });

  test("a 403 anywhere triggers a check shortly after", async () => {
    vi.useFakeTimers();
    api.get.mockResolvedValue({ data: { data: { accessVersion: "ccc" } } });
    const stop = startAccessSync();
    api._fail({ response: { status: 403 } });
    await vi.advanceTimersByTimeAsync(400);
    expect(api.get).toHaveBeenCalledWith("/auth/access-version");
    expect(refreshSession).toHaveBeenCalled();
    stop();
  });
});
