import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import { NewOrderPage } from "./NewOrderPage";
import { useUserStore } from "../../store/userStore";
import { api } from "../../services/api";

/**
 * Order intake, and the Customer Portal booking behind it (§3).
 *
 * What these assert is the REQUIREMENT — that Sales can find the booking,
 * review what is on it, and have the link travel with the submitted order —
 * rather than the markup that happens to express it today.
 *
 * The "no booking" path gets equal weight on purpose. A PO that arrives by
 * email has no portal booking, and an intake form that only works when one is
 * picked would make those orders unenterable; a test that only covers the happy
 * path would not notice.
 */

vi.mock("../../services/api", () => ({ api: { request: vi.fn() } }));
vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

const envelope = (payload) => ({ data: { success: true, data: payload } });

/**
 * The bookings endpoint's envelope.
 *
 * `rows`, not the `data` key the other O2D list endpoints use — this one groups
 * booking LINES into bookings before paginating, so it returns its own shape
 * (see `booking.service.js`). Spelled out here rather than reusing the generic
 * helper, because a fixture that quietly disagreed with the server would make
 * these tests pass against a page that renders nothing in production.
 */
const bookingPage = (rows) => envelope({ rows, total: rows.length, page: 1, pageSize: 25 });

const BOOKING = {
  bookingId: "BO-2026-000412",
  customerName: "ABC Industries",
  status: "PO Received",
  poNumber: "-",
  promiseDate: null,
  bookedAt: "2026-09-10T05:30:00.000Z",
  lineCount: 2,
  totalBookedQty: 14,
  totalConfirmedQty: 13,
  lines: [
    { skuCode: "KKN-100", bookedQty: 10, confirmedQty: 10 },
    { skuCode: "KKN-220", bookedQty: 4, confirmedQty: 3 },
  ],
  o2dOrder: null,
};

/** Every request the page makes, captured so the submitted body can be read. */
let sent;

function installTransport(overrides = {}) {
  sent = [];
  const routes = {
    "GET /o2d/bookings": bookingPage([BOOKING]),
    "POST /o2d/orders": envelope({ order: { _id: "o9", poNumber: "PO-4471" } }),
    ...overrides,
  };

  api.request.mockImplementation(async (config) => {
    sent.push(config);
    const key = `${config.method.toUpperCase()} ${config.url}`;
    if (routes[key]) return routes[key];
    throw Object.assign(new Error(`Unrouted ${key}`), {
      response: { status: 404, data: { message: "Not found" } },
    });
  });
}

const at = () =>
  render(
    <MemoryRouter initialEntries={["/fms/o2d/orders/new"]}>
      <Routes>
        <Route path="/fms/o2d/orders/new" element={<NewOrderPage />} />
        <Route path="/fms/o2d/orders" element={<div>Order tracker</div>} />
      </Routes>
    </MemoryRouter>,
  );

/** Fill the fields the server requires, leaving the booking choice alone. */
const fillRequired = async (user, { poNumber = "PO-4471" } = {}) => {
  await user.clear(screen.getByLabelText("PO number"));
  await user.type(screen.getByLabelText("PO number"), poNumber);
  await user.type(screen.getByLabelText("PO date"), "2026-09-14");
  await user.type(screen.getByLabelText("Promise date"), "2026-09-25");
};

const submitted = () => sent.find((c) => c.method.toUpperCase() === "POST");

beforeEach(() => {
  installTransport();
  useUserStore.setState({
    user: { _id: "u1", user: "Tester", role: "Sales", permissions: ["create_o2d_order"] },
    loading: false,
  });
});

// ---------------------------------------------------------------------------

describe("the booking picker", () => {
  test("lists the bookings still waiting for an order", async () => {
    at();
    expect(await screen.findByText("BO-2026-000412")).toBeTruthy();
    expect(screen.getByText(/ABC Industries · 2 lines/)).toBeTruthy();
  });

  test("picking one prefills the customer and shows the lines for review", async () => {
    const user = userEvent.setup();
    at();

    await user.click(await screen.findByText("BO-2026-000412"));

    // §3: Sales reviews the booking before creating the order.
    expect(screen.getByText("KKN-100")).toBeTruthy();
    expect(screen.getByText("KKN-220")).toBeTruthy();

    // The customer is copied because the server refuses a mismatch — leaving
    // the user to retype it exactly would be a trap.
    expect(screen.getByLabelText("Customer").value).toBe("ABC Industries");
  });

  test("the line quantities come from what was CONFIRMED, not what was booked", async () => {
    const user = userEvent.setup();
    at();
    await user.click(await screen.findByText("BO-2026-000412"));

    // KKN-220 was booked 4 and confirmed 3. Ordering 4 would dispatch stock the
    // customer was never promised.
    const quantities = screen
      .getAllByLabelText(/^Quantity/i)
      .map((el) => el.value);
    expect(quantities).toContain("3");
    expect(quantities).not.toContain("4");
  });

  test("the booking id travels with the submitted order", async () => {
    const user = userEvent.setup();
    at();

    await user.click(await screen.findByText("BO-2026-000412"));
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /create order/i }));

    await waitFor(() => expect(submitted()).toBeTruthy());
    expect(submitted().data.sourceBookingId).toBe("BO-2026-000412");
  });

  test("unlinking clears the link without clearing the form", async () => {
    const user = userEvent.setup();
    at();

    await user.click(await screen.findByText("BO-2026-000412"));
    await user.click(screen.getByRole("button", { name: /unlink/i }));

    // The picker is back...
    expect(await screen.findByLabelText(/search customer bookings/i)).toBeTruthy();
    // ...but the customer that was prefilled is still there. Unlinking is not
    // undoing the user's typing.
    expect(screen.getByLabelText("Customer").value).toBe("ABC Industries");
  });
});

describe("intake without a booking", () => {
  test("an emailed PO submits with no booking link", async () => {
    const user = userEvent.setup();
    at();
    await screen.findByLabelText(/search customer bookings/i);

    await user.type(screen.getByLabelText("Customer"), "Walk-in Traders");
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /create order/i }));

    await waitFor(() => expect(submitted()).toBeTruthy());
    expect(submitted().data.sourceBookingId).toBe(null);
  });

  test("a failed booking lookup does not block intake", async () => {
    installTransport();
    // A THROWER, not a rejected promise value: a rejected promise sitting in
    // the route table is already unhandled by the time the test body runs, and
    // vitest reports it as an unhandled rejection whatever the page does.
    const ok = api.request.getMockImplementation();
    api.request.mockImplementation(async (config) => {
      if (config.url === "/o2d/bookings") throw new Error("down");
      return ok(config);
    });

    const user = userEvent.setup();
    at();

    // The form is still usable — the message says so rather than spinning.
    expect(
      await screen.findByText(/No bookings are waiting for an order/i),
    ).toBeTruthy();

    await user.type(screen.getByLabelText("Customer"), "Walk-in Traders");
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /create order/i }));

    await waitFor(() => expect(submitted()).toBeTruthy());
  });
});
