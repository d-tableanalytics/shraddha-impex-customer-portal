import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Pencil, Eye, ShieldOff, KeyRound, ArrowLeft } from "lucide-react";
import toast from "react-hot-toast";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { HrmsStatusBadge } from "../../../components/hrms/HrmsStatusBadge";
import { PermissionGate } from "../../../components/hrms/PermissionGate";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { Modal } from "../../../components/ui/Modal";
import { employeesApi, HrmsApiError } from "../../../services/hrms";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";
import { SENSITIVE_EMPLOYEE_FIELD_LIST } from "@shared/security/sensitive-fields.js";

/**
 * Employee detail.
 *
 * Card sections rather than tabs, matching the reference's profile page.
 *
 * ---------------------------------------------------------------------------
 * Sensitive values are never on this page by default
 * ---------------------------------------------------------------------------
 * The API returns PRESENCE only — `true` when a PAN is on file, `null` when it
 * is not. Seeing the actual value is a separate, audited request that requires
 * compensation access, so opening a profile records nothing and reveals
 * nothing.
 */

const FIELD_LABELS = {
  panNumber: "PAN",
  bankAccountNumber: "Bank account number",
  bankIfsc: "IFSC",
  aadhaarNumber: "Aadhaar",
  uanNumber: "UAN",
  esiNumber: "ESI number",
  passportNumber: "Passport number",
};

const Row = ({ label, children }) => (
  <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4 py-2 border-b border-slate-50 last:border-0">
    <dt className="text-xs font-semibold text-slate-500 sm:w-48 shrink-0">{label}</dt>
    <dd className="text-sm text-slate-800 min-w-0 break-words">{children ?? "—"}</dd>
  </div>
);

const Section = ({ title, children, action }) => (
  <Card className="p-5">
    <div className="flex items-center justify-between mb-2">
      <h3 className="text-sm font-bold text-slate-900">{title}</h3>
      {action}
    </div>
    <dl>{children}</dl>
  </Card>
);

export function EmployeeProfilePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, roleKeys } = useHrmsPermissions();

  const [employee, setEmployee] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [revealed, setRevealed] = useState({});
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tempPassword, setTempPassword] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEmployee(await employeesApi.get(id));
    } catch (err) {
      setError(err instanceof HrmsApiError ? err : new HrmsApiError(err.message));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const canSeeSensitive = can(M.EMPLOYEES_COMPENSATION, A.VIEW, S.ORG);

  const reveal = async (field) => {
    try {
      const res = await employeesApi.reveal(id, field);
      setRevealed((r) => ({ ...r, [field]: res.value }));
    } catch (err) {
      toast.error(err.message ?? "Could not reveal the value.");
    }
  };

  const deactivate = async () => {
    setBusy(true);
    try {
      await employeesApi.deactivate(id);
      toast.success("Employee deactivated. Their login has been suspended.");
      navigate("/hrms/employees");
    } catch (err) {
      toast.error(err.message ?? "Could not deactivate.");
      setBusy(false);
      setConfirmDeactivate(false);
    }
  };

  const resetPassword = async () => {
    try {
      const res = await employeesApi.resetPassword(id);
      setTempPassword(res.tempPassword);
    } catch (err) {
      toast.error(err.message ?? "Could not reset the password.");
    }
  };

  const onFile = SENSITIVE_EMPLOYEE_FIELD_LIST.filter((f) => employee?.[f]);

  return (
    <HrmsPageLayout
      title={employee?.displayName ?? "Employee"}
      subtitle={
        employee
          ? `${employee.employeeCode}${employee.designation ? ` · ${employee.designation}` : ""}`
          : undefined
      }
      breadcrumbs={[
        { label: "HRMS", to: "/hrms/dashboard" },
        { label: "Employees", to: "/hrms/employees" },
        { label: employee?.displayName ?? "…" },
      ]}
      loading={loading}
      error={error}
      onRetry={load}
      actions={
        employee && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => navigate("/hrms/employees")}>
              <ArrowLeft size={14} className="mr-1.5" />
              Directory
            </Button>

            <PermissionGate
              anyOf={[
                { module: M.EMPLOYEES, action: A.EDIT, scope: S.ORG },
                { module: M.EMPLOYEES, action: A.EDIT, scope: S.SELF },
              ]}
            >
              <Button onClick={() => navigate(`/hrms/employees/${id}/edit`)}>
                <Pencil size={14} className="mr-1.5" />
                Edit
              </Button>
            </PermissionGate>

            {roleKeys.includes("hrms_super_admin") && (
              <Button variant="secondary" onClick={resetPassword}>
                <KeyRound size={14} className="mr-1.5" />
                Reset password
              </Button>
            )}

            <PermissionGate module={M.EMPLOYEES} action={A.DELETE} scope={S.ORG}>
              <Button variant="danger" onClick={() => setConfirmDeactivate(true)}>
                <ShieldOff size={14} className="mr-1.5" />
                Deactivate
              </Button>
            </PermissionGate>
          </div>
        )
      }
    >
      {employee && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Section title="Job">
            <Row label="Employee code">{employee.employeeCode}</Row>
            <Row label="Status">
              <HrmsStatusBadge status={employee.status} />
            </Row>
            <Row label="Designation">{employee.designation}</Row>
            <Row label="Employment type">
              {employee.employmentType?.replace(/_/g, " ")}
            </Row>
            <Row label="Date of joining">{employee.dateOfJoining}</Row>
            <Row label="Reporting manager">{employee.reportingManagerName}</Row>
          </Section>

          <Section title="Contact">
            <Row label="Work email">{employee.email}</Row>
            <Row label="Personal email">{employee.personalEmail}</Row>
            <Row label="Phone 1">{employee.phone}</Row>
            <Row label="Phone 2">{employee.phone2}</Row>
            <Row label="Date of birth">{employee.dateOfBirth}</Row>
          </Section>

          {employee.status === "probation" && (
            <Section title="Probation">
              <Row label="Starts">{employee.probationStartDate}</Row>
              <Row label="Length">
                {employee.probationMonths ? `${employee.probationMonths} months` : null}
              </Row>
              <Row label="Ends">{employee.probationEndDate}</Row>
              <Row label="Confirmed">
                {employee.confirmedAt ? new Date(employee.confirmedAt).toLocaleDateString() : "Not yet"}
              </Row>
            </Section>
          )}

          {employee.status === "notice" && (
            <Section title="Notice period">
              <Row label="Notice given">{employee.noticeStartDate}</Row>
              <Row label="Period">
                {employee.noticeMonths ? `${employee.noticeMonths} months` : null}
              </Row>
              <Row label="Last working day">{employee.noticeEndDate}</Row>
            </Section>
          )}

          <Section title="Family">
            <Row label="Father's name">{employee.fatherName}</Row>
            <Row label="Mother's name">{employee.motherName}</Row>
          </Section>

          <Section title="Address">
            <Row label="Permanent">
              <span className="whitespace-pre-wrap">{employee.permanentAddress}</span>
            </Row>
            <Row label="Temporary">
              <span className="whitespace-pre-wrap">{employee.temporaryAddress}</span>
            </Row>
          </Section>

          <Section title="Emergency contacts">
            {employee.emergencyContacts.length === 0 ? (
              <p className="text-sm text-slate-400 py-2">None recorded.</p>
            ) : (
              employee.emergencyContacts.map((c, i) => (
                <Row key={i} label={c.relationship}>
                  {c.name} · {c.phone}
                </Row>
              ))
            )}
          </Section>

          {/*
            Identifiers. Presence is shown to anyone who can read the profile;
            the VALUE requires compensation access and is fetched one field at a
            time, each fetch audited.
          */}
          <Section title="Identifiers & bank details">
            {onFile.length === 0 ? (
              <p className="text-sm text-slate-400 py-2">Nothing on file.</p>
            ) : (
              onFile.map((field) => (
                <Row key={field} label={FIELD_LABELS[field] ?? field}>
                  {revealed[field] ? (
                    <span className="font-mono select-all">{revealed[field]}</span>
                  ) : (
                    <span className="flex items-center gap-3">
                      <span className="font-mono text-slate-400">•••• on file</span>
                      {canSeeSensitive && (
                        <button
                          type="button"
                          onClick={() => reveal(field)}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-primary-600 hover:text-primary-800"
                        >
                          <Eye size={12} />
                          Reveal
                        </button>
                      )}
                    </span>
                  )}
                </Row>
              ))
            )}
            {onFile.length > 0 && !canSeeSensitive && (
              <p className="text-xs text-slate-400 pt-2">
                Viewing a full value requires compensation access.
              </p>
            )}
          </Section>

          {Object.keys(employee.customFieldValues ?? {}).length > 0 && (
            <Section title="Additional fields">
              {Object.entries(employee.customFieldValues).map(([k, v]) => (
                <Row key={k} label={k}>
                  {typeof v === "boolean" ? (v ? "Yes" : "No") : String(v ?? "")}
                </Row>
              ))}
            </Section>
          )}
        </div>
      )}

      <ConfirmationDialog
        isOpen={confirmDeactivate}
        onClose={() => setConfirmDeactivate(false)}
        onConfirm={deactivate}
        loading={busy}
        variant="danger"
        title="Deactivate this employee?"
        description="The record is kept and marked as exited, and their login is suspended immediately. Attendance, leave and payroll history stay intact. This cannot be undone from here."
        confirmText="Deactivate"
      />

      <Modal
        isOpen={Boolean(tempPassword)}
        onClose={() => setTempPassword(null)}
        title="New temporary password"
        size="sm"
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-slate-600">
            Share this with the employee. It is shown once and is not stored.
          </p>
          <code className="px-3 py-2 bg-slate-50 border border-slate-200 rounded font-mono text-sm select-all">
            {tempPassword}
          </code>
          <div className="flex justify-end">
            <Button onClick={() => setTempPassword(null)}>Done</Button>
          </div>
        </div>
      </Modal>
    </HrmsPageLayout>
  );
}

export default EmployeeProfilePage;
