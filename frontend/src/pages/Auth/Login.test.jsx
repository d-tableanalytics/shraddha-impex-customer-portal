import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

/**
 * The password reveal on the sign-in page.
 *
 * Three things are worth pinning, because each fails silently:
 *   - the field starts MASKED, so a reveal is always a deliberate act;
 *   - the toggle is `type="button"`. Inside a <form> the default is submit, so
 *     without it the eye would attempt a login instead of showing the password;
 *   - it flips back, so the password cannot be left on screen by one click.
 */

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

const navigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => navigate,
}));

import { Login } from "./Login";
import { useUserStore } from "../../store/userStore";

const login = vi.fn(async () => false);

const open = () => {
  useUserStore.setState({ login, loading: false, error: null });
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  );
};

const passwordField = () => document.querySelector('input[autocomplete="current-password"]');

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the password reveal", () => {
  test("the password starts masked", () => {
    open();
    expect(passwordField().type).toBe("password");
    expect(screen.getByRole("button", { name: /show password/i })).toBeTruthy();
  });

  test("clicking the eye reveals it, and clicking again hides it", async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole("button", { name: /show password/i }));
    expect(passwordField().type).toBe("text");

    await user.click(screen.getByRole("button", { name: /hide password/i }));
    expect(passwordField().type).toBe("password");
  });

  test("the eye does NOT submit the form", async () => {
    // It lives inside the <form>, where a button's default type is submit.
    const user = userEvent.setup();
    open();

    await user.type(passwordField(), "hunter2000");
    await user.click(screen.getByRole("button", { name: /show password/i }));

    expect(login).not.toHaveBeenCalled();
    expect(passwordField().value).toBe("hunter2000");
  });

  test("signing in still works with the password revealed", async () => {
    const user = userEvent.setup();
    open();

    await user.type(screen.getByPlaceholderText(/example.com/i), "someone@shraddhaimpex.net");
    await user.type(passwordField(), "hunter2000");
    await user.click(screen.getByRole("button", { name: /show password/i }));
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(login).toHaveBeenCalledTimes(1);
    expect(login.mock.calls[0][0]).toMatchObject({
      email: "someone@shraddhaimpex.net",
      password: "hunter2000",
    });
  });
});
