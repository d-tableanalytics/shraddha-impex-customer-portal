import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { FilterBar } from "../../../components/hrms/FilterBar";
import { HrmsStatusBadge } from "../../../components/hrms/HrmsStatusBadge";
import { PermissionGate } from "../../../components/hrms/PermissionGate";
import { Button } from "../../../components/ui/Button";
import { EmployeeFormDrawer } from "./EmployeeFormDrawer";
import {
  employeesApi,
  departmentsApi,
  locationsApi,
  orgOptionLabel,
  HrmsApiError,
} from "../../../services/hrms";
import { EMPLOYEE_STATUSES, PAGE_SIZE_DEFAULT } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * The employee directory.
 *
 * Columns, filters and row behaviour follow the reference's `EmployeesPage`:
 * a search box plus Department / Location / Status selects, a row click into
 * the profile, and server-side pagination.
 *
 * Department and Location filters are present but disabled until Org Structure
 * ships — the reference populates them from `/departments` and `/locations`,
 * neither of which exists here yet. Showing them disabled rather than hiding
 * them keeps the filter row honest about what the record actually holds.
 */

const STATUS_OPTIONS = EMPLOYEE_STATUSES.map((v) => ({
  value: v,
  label: v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
}));

const initialsOf = (name) =>
  (name || "?")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

export function EmployeesPage() {
  const navigate = useNavigate();

  /**
   * Filters are seeded from the URL so a deep link lands pre-filtered.
   *
   * Org Structure's Departments tab links here as
   * `/hrms/employees?departmentId=<id>`, exactly as the reference does
   * (`DepartmentsTab.tsx:35`), and without this that link would open an
   * unfiltered directory - the feature would look like it had done nothing.
   */
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState(() => ({
    search: searchParams.get("search") ?? "",
    status: searchParams.get("status") ?? undefined,
    departmentId: searchParams.get("departmentId") ?? undefined,
    locationId: searchParams.get("locationId") ?? undefined,
  }));
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ sortBy: undefined, sortDir: "asc" });

  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: PAGE_SIZE_DEFAULT });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await employeesApi.list({
        page,
        pageSize: PAGE_SIZE_DEFAULT,
        search: filters.search || undefined,
        status: filters.status,
        departmentId: filters.departmentId,
        locationId: filters.locationId,
        ...sort,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof HrmsApiError ? err : new HrmsApiError(err.message));
    } finally {
      setLoading(false);
    }
  }, [page, filters.search, filters.status, filters.departmentId, filters.locationId, sort]);

  useEffect(() => {
    // Debounced, so typing in the search box does not fire a request per key.
    const t = setTimeout(load, filters.search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, filters.search]);

  /**
   * The Org Structure catalogues, for the two filters and the add drawer.
   *
   * Loaded once: they are small, unpaginated and change rarely, and every HRMS
   * role can read them (`org-structure:view:self` is in the baseline). A
   * failure leaves the filters empty rather than breaking the directory - the
   * employee list does not depend on them.
   */
  const [departments, setDepartments] = useState([]);
  const [locations, setLocations] = useState([]);

  useEffect(() => {
    departmentsApi.list().then(setDepartments).catch(() => setDepartments([]));
    locationsApi.list().then(setLocations).catch(() => setLocations([]));
  }, []);

  const departmentOptions = useMemo(
    () => departments.map((d) => ({ value: d.id, label: orgOptionLabel(d) })),
    [departments],
  );
  const locationOptions = useMemo(
    () => locations.map((l) => ({ value: l.id, label: orgOptionLabel(l) })),
    [locations],
  );

  /** Active employees, for the "reporting manager" picker in the add drawer. */
  const [managerOptions, setManagerOptions] = useState([]);
  useEffect(() => {
    employeesApi
      .list({ status: "active", pageSize: 200 })
      .then((res) =>
        setManagerOptions(
          res.data.map((e) => ({
            value: e.id,
            label: e.displayName,
            hint: `${e.employeeCode}${e.designation ? ` · ${e.designation}` : ""}`,
          })),
        ),
      )
      .catch(() => setManagerOptions([]));
  }, []);

  const columns = useMemo(
    () => [
      {
        header: "Employee",
        accessorKey: "firstName",
        sortable: true,
        cell: (row) => (
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center text-[11px] font-bold shrink-0">
              {initialsOf(row.displayName)}
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-slate-900 truncate">{row.displayName}</div>
              <div className="text-xs text-slate-400 truncate">{row.employeeCode}</div>
            </div>
          </div>
        ),
      },
      { header: "Email", accessorKey: "email", cell: (r) => r.email ?? "—" },
      { header: "Phone", accessorKey: "phone", cell: (r) => r.phone ?? "—" },
      { header: "Designation", accessorKey: "designation", cell: (r) => r.designation ?? "—" },
      {
        header: "Reporting manager",
        cell: (r) => r.reportingManagerName ?? "—",
      },
      {
        header: "Status",
        accessorKey: "status",
        sortable: true,
        cell: (r) => <HrmsStatusBadge status={r.status} />,
      },
    ],
    [],
  );

  return (
    <HrmsPageLayout
      title="Employees"
      subtitle="The people directory. Personal details, job details and reporting lines."
      breadcrumbs={[{ label: "HRMS", to: "/hrms/dashboard" }, { label: "Employees" }]}
      actions={
        <PermissionGate module={M.EMPLOYEES} action={A.CREATE} scope={S.ORG}>
          <Button onClick={() => setDrawerOpen(true)}>
            <Plus size={15} className="mr-1.5" />
            Add employee
          </Button>
        </PermissionGate>
      }
    >
      <div className="flex flex-col gap-4">
        <FilterBar
          search={filters.search}
          onSearchChange={(v) => {
            setPage(1);
            setFilters((f) => ({ ...f, search: v }));
          }}
          searchPlaceholder="Search name, code or email"
          filters={[
            {
              key: "status",
              placeholder: "Status",
              options: STATUS_OPTIONS,
              width: "w-44",
            },
            {
              key: "departmentId",
              placeholder: "Department",
              options: departmentOptions,
              width: "w-48",
            },
            {
              key: "locationId",
              placeholder: "Location",
              options: locationOptions,
              width: "w-48",
            },
          ]}
          values={filters}
          onChange={(key, value) => {
            setPage(1);
            setFilters((f) => ({ ...f, [key]: value ?? undefined }));
          }}
          onReset={() => {
            setPage(1);
            setFilters({
              search: "",
              status: undefined,
              departmentId: undefined,
              locationId: undefined,
            });
          }}
        />

        <HrmsDataTable
          columns={columns}
          rows={result.data}
          loading={loading}
          error={error}
          onRetry={load}
          page={result.page}
          pageSize={result.pageSize}
          total={result.total}
          onPageChange={setPage}
          sortBy={sort.sortBy}
          sortDir={sort.sortDir}
          onSortChange={(sortBy, sortDir) => {
            setPage(1);
            setSort({ sortBy, sortDir });
          }}
          onRowClick={(row) => navigate(`/hrms/employees/${row.id}`)}
          emptyTitle="No employees yet"
          emptyDescription={
            filters.search || filters.status || filters.departmentId || filters.locationId
              ? "No employee matches these filters."
              : "Add the first employee to get started."
          }
        />
      </div>

      <EmployeeFormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onCreated={() => {
          setDrawerOpen(false);
          load();
        }}
        managerOptions={managerOptions}
        departments={departments}
        locations={locations}
      />
    </HrmsPageLayout>
  );
}

export default EmployeesPage;
