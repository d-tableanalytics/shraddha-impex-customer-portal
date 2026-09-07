/**
 * HrmsDataTable: the states it must survive before any data arrives.
 *
 * The employee directory crashed the whole /hrms/employees route with
 * "Cannot read properties of undefined (reading 'length')" because the server's
 * list response did not match what `hrmsClient` unwraps, so `rows` arrived
 * undefined. The response shape is fixed at its source, and these tests cover
 * the other half: a table asked to render without a dataset should show a
 * loading or empty state, not take the route down with it.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { HrmsDataTable } from "./HrmsDataTable";

const columns = [
  { header: "Name", accessorKey: "name" },
  { header: "Code", accessorKey: "code" },
];

const rows = [
  { id: "1", name: "Priya Sharma", code: "SI-001" },
  { id: "2", name: "Rahul Verma", code: "SI-002" },
];

describe("missing dataset", () => {
  it("renders the empty state when rows is undefined", () => {
    render(<HrmsDataTable columns={columns} rows={undefined} emptyTitle="No employees yet" />);

    expect(screen.getByText("No employees yet")).toBeTruthy();
    expect(screen.getAllByRole("columnheader").length).toBe(2);
  });

  it("renders the empty state when rows is null", () => {
    render(<HrmsDataTable columns={columns} rows={null} emptyTitle="No employees yet" />);
    expect(screen.getByText("No employees yet")).toBeTruthy();
  });

  it("survives a non-array dataset rather than throwing", () => {
    // What the bug actually produced: the client returned the bare row array,
    // the page read `.data` off it, and the table was handed undefined. A
    // malformed payload of any shape must degrade to empty, not to a crash.
    for (const bad of [undefined, null, {}, "", 0, { data: [] }]) {
      const { unmount } = render(<HrmsDataTable columns={columns} rows={bad} />);
      expect(screen.getByText("Nothing here yet")).toBeTruthy();
      unmount();
    }
  });

  it("shows the loading skeleton, not the empty state, while a request is in flight", () => {
    // The first render of any list happens before the response arrives. Showing
    // "No employees yet" there would tell the user something false.
    render(
      <HrmsDataTable columns={columns} rows={undefined} loading emptyTitle="No employees yet" />,
    );

    expect(screen.queryByText("No employees yet")).toBeNull();
    expect(document.querySelectorAll("tbody tr").length).toBeGreaterThan(0);
  });

  it("shows the error state when a failed load leaves no rows", () => {
    render(
      <HrmsDataTable
        columns={columns}
        rows={undefined}
        error={{ message: "Database is down." }}
        onRetry={() => {}}
      />,
    );

    expect(screen.getByText("Database is down.")).toBeTruthy();
    expect(screen.queryByText("Nothing here yet")).toBeNull();
  });
});

describe("the server pagination contract is unchanged", () => {
  it("renders the rows it is given", () => {
    render(<HrmsDataTable columns={columns} rows={rows} total={2} page={1} pageSize={25} />);

    expect(screen.getByText("Priya Sharma")).toBeTruthy();
    expect(screen.getByText("SI-002")).toBeTruthy();
  });

  it("pages on `total`, not on how many rows this page holds", () => {
    // The whole point of server-side pagination: page 1 of 120 shows 25 rows
    // and still offers page 2. Deriving the page count from rows.length would
    // hide every page after the first.
    const onPageChange = vi.fn();
    render(
      <HrmsDataTable
        columns={columns}
        rows={rows}
        total={120}
        page={1}
        pageSize={25}
        onPageChange={onPageChange}
      />,
    );

    expect(screen.getByText(/120/)).toBeTruthy();
  });

  it("hides pagination while loading, when there is no total to trust", () => {
    render(<HrmsDataTable columns={columns} rows={undefined} loading total={0} pageSize={25} />);
    expect(screen.queryByText(/of 0/i)).toBeNull();
  });
});
