import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useForm, FormProvider } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { Button } from "../../../components/ui/Button";
import { EmployeeFormFields } from "./EmployeeFormFields";
import {
  employeesApi,
  employeeCustomFieldsApi,
  departmentsApi,
  locationsApi,
  HrmsApiError,
} from "../../../services/hrms";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { updateEmployeeSchema } from "@shared/schemas/employee.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Edit an employee — a FULL PAGE, matching the reference, which uses a drawer
 * for creation and a page for editing.
 *
 * ---------------------------------------------------------------------------
 * canEditJobDetails
 * ---------------------------------------------------------------------------
 * An employee editing their own record may change personal details only.
 * `employees:edit:self` is in the baseline every HRMS role carries, so without
 * this an employee could change their own designation, department or reporting
 * manager — the last of which would rewrite who can approve their leave.
 *
 * The gate is a convenience: the server refuses those fields on a self-edit
 * regardless, and returns the reason.
 */
export function EmployeeEditPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, actor } = useHrmsPermissions();

  const [employee, setEmployee] = useState(null);
  const [customFields, setCustomFields] = useState([]);
  const [managerOptions, setManagerOptions] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const methods = useForm({
    resolver: zodResolver(updateEmployeeSchema),
    mode: "onBlur",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [emp, fields, managers, depts, locs] = await Promise.all([
        employeesApi.get(id),
        employeeCustomFieldsApi.list().catch(() => []),
        employeesApi.list({ status: "active", pageSize: 200 }).catch(() => ({ data: [] })),
        departmentsApi.list().catch(() => []),
        locationsApi.list().catch(() => []),
      ]);

      setEmployee(emp);
      setCustomFields(fields);
      setDepartments(depts);
      setLocations(locs);
      setManagerOptions(
        (managers.data ?? [])
          .filter((e) => e.id !== id)
          .map((e) => ({
            value: e.id,
            label: e.displayName,
            hint: `${e.employeeCode}${e.designation ? ` · ${e.designation}` : ""}`,
          })),
      );

      methods.reset({
        firstName: emp.firstName,
        lastName: emp.lastName,
        // `email` and `employeeCode` are deliberately absent: the update
        // schema omits both and is `.strict()`, so holding them in form state
        // would fail the resolver on every save. They are displayed from
        // `identity` instead.
        personalEmail: emp.personalEmail,
        phone: emp.phone,
        phone2: emp.phone2,
        dateOfBirth: emp.dateOfBirth,
        dateOfJoining: emp.dateOfJoining,
        employmentType: emp.employmentType,
        designation: emp.designation,
        status: emp.status,
        departmentId: emp.departmentId,
        locationId: emp.locationId,
        reportingManagerId: emp.reportingManagerId,
        probationMonths: emp.probationMonths,
        probationStartDate: emp.probationStartDate,
        probationEndDate: emp.probationEndDate,
        noticeStartDate: emp.noticeStartDate,
        noticeMonths: emp.noticeMonths,
        noticeEndDate: emp.noticeEndDate,
        fatherName: emp.fatherName,
        motherName: emp.motherName,
        permanentAddress: emp.permanentAddress,
        temporaryAddress: emp.temporaryAddress,
        emergencyContacts: emp.emergencyContacts ?? [],
        dependents: emp.dependents ?? [],
        customFieldValues: emp.customFieldValues ?? {},
        // Sensitive values are NOT loaded — the API returns presence only, and
        // pre-filling a form with a decrypted PAN would put it back on the wire
        // on every edit. Leaving a field blank leaves the stored value alone;
        // typing a new one replaces it.
      });
    } catch (err) {
      setError(err instanceof HrmsApiError ? err : new HrmsApiError(err.message));
    } finally {
      setLoading(false);
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  const isSelf = employee && actor?.employeeId === employee.id;
  const hasOrgEdit = can(M.EMPLOYEES, A.EDIT, S.ORG);
  const canEditJobDetails = hasOrgEdit || !isSelf;

  const submit = methods.handleSubmit(async (values) => {
    setSaving(true);
    try {
      // Only what actually changed. The immutable pair is not in form state
      // at all, so there is nothing to strip here.
      const dirty = methods.formState.dirtyFields;
      const payload = Object.fromEntries(
        Object.entries(values).filter(([k]) => dirty[k] !== undefined),
      );

      if (Object.keys(payload).length === 0) {
        toast("Nothing changed.");
        setSaving(false);
        return;
      }

      await employeesApi.update(id, payload);
      toast.success("Employee updated.");
      navigate(`/hrms/employees/${id}`);
    } catch (err) {
      toast.error(err.message ?? "Could not save.");
    } finally {
      setSaving(false);
    }
  });

  return (
    <HrmsPageLayout
      title={employee ? `Edit ${employee.displayName}` : "Edit employee"}
      subtitle={employee?.employeeCode}
      breadcrumbs={[
        { label: "HRMS", to: "/hrms/dashboard" },
        { label: "Employees", to: "/hrms/employees" },
        { label: employee?.displayName ?? "…", to: `/hrms/employees/${id}` },
        { label: "Edit" },
      ]}
      loading={loading}
      error={error}
      onRetry={load}
      actions={
        employee && (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => navigate(`/hrms/employees/${id}`)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={submit} loading={saving}>
              Save changes
            </Button>
          </div>
        )
      }
    >
      {employee && (
        <FormProvider {...methods}>
          <form onSubmit={submit} noValidate>
            {isSelf && !hasOrgEdit && (
              <div className="mb-5 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                You are editing your own record, so job details are read-only. Ask HR to change
                your designation, department or reporting manager.
              </div>
            )}

            <EmployeeFormFields
              mode="edit"
              canEditJobDetails={canEditJobDetails}
              customFields={customFields}
              managerOptions={managerOptions}
              identity={{ email: employee.email, employeeCode: employee.employeeCode }}
              departments={departments}
              locations={locations}
              current={employee}
            />

            <div className="flex justify-end gap-3 mt-8 pt-5 border-t border-slate-100">
              <Button
                type="button"
                variant="secondary"
                onClick={() => navigate(`/hrms/employees/${id}`)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="submit" loading={saving}>
                Save changes
              </Button>
            </div>
          </form>
        </FormProvider>
      )}
    </HrmsPageLayout>
  );
}

export default EmployeeEditPage;
