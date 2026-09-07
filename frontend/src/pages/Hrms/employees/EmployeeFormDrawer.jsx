import { useEffect, useState } from "react";
import { useForm, FormProvider } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { Copy, Check } from "lucide-react";

import { Drawer } from "../../../components/ui/Drawer";
import { Modal } from "../../../components/ui/Modal";
import { Button } from "../../../components/ui/Button";
import { EmployeeFormFields } from "./EmployeeFormFields";
import { employeesApi, employeeCustomFieldsApi } from "../../../services/hrms";
import { createEmployeeSchema } from "@shared/schemas/employee.js";

/**
 * "Add employee".
 *
 * A DRAWER, not a page — verified against the reference, which has no
 * `/employees/new` route. Creation happens in a 640px drawer over the
 * directory; only editing gets a full page.
 *
 * On success it shows the one-time temporary password in a modal, exactly as
 * the reference does. It cannot be retrieved again, so it is presented to be
 * copied rather than mentioned in a toast that disappears.
 */

const emptyEmployee = {
  employeeCode: "",
  firstName: "",
  lastName: "",
  email: "",
  personalEmail: null,
  phone: null,
  phone2: null,
  dateOfBirth: null,
  dateOfJoining: new Date().toISOString().slice(0, 10),
  employmentType: "full_time",
  designation: null,
  status: "invited",
  departmentId: null,
  locationId: null,
  reportingManagerId: null,
  probationMonths: 3,
  probationStartDate: null,
  probationEndDate: null,
  noticeStartDate: null,
  noticeMonths: null,
  noticeEndDate: null,
  fatherName: null,
  motherName: null,
  permanentAddress: null,
  temporaryAddress: null,
  emergencyContacts: [],
  dependents: [],
  customFieldValues: {},
  initialRoleKeys: ["hrms_employee"],
};

/** Empty strings are not the same as "not supplied" — the schema wants null. */
const nullifyBlanks = (obj) =>
  Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, v === "" ? null : v]),
  );

export function EmployeeFormDrawer({
  open,
  onClose,
  onCreated,
  managerOptions = [],
  departments = [],
  locations = [],
}) {
  const [customFields, setCustomFields] = useState([]);
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const methods = useForm({
    resolver: zodResolver(createEmployeeSchema),
    defaultValues: emptyEmployee,
    mode: "onBlur",
  });

  useEffect(() => {
    if (!open) return;
    methods.reset(emptyEmployee);
    employeeCustomFieldsApi.list().then(setCustomFields).catch(() => setCustomFields([]));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = methods.handleSubmit(async (values) => {
    setSaving(true);
    try {
      const result = await employeesApi.create(nullifyBlanks(values));
      setCreated(result);
      toast.success(`${result.employee.displayName} added.`);
      onCreated?.(result.employee);
    } catch (err) {
      toast.error(err.message ?? "Could not add the employee.");
    } finally {
      setSaving(false);
    }
  });

  const closeAll = () => {
    setCreated(null);
    setCopied(false);
    onClose();
  };

  return (
    <>
      <Drawer
        isOpen={open && !created}
        onClose={saving ? () => {} : onClose}
        title="Add Employee"
        maxWidth="max-w-2xl"
      >
        <FormProvider {...methods}>
          <form onSubmit={submit} noValidate>
            <EmployeeFormFields
              mode="create"
              canEditJobDetails
              customFields={customFields}
              managerOptions={managerOptions}
              departments={departments}
              locations={locations}
            />

            <div className="flex justify-end gap-3 mt-8 pt-5 border-t border-slate-100">
              <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" loading={saving}>
                Add employee
              </Button>
            </div>
          </form>
        </FormProvider>
      </Drawer>

      {/*
        The temporary password is shown ONCE. It is never stored in plaintext
        and never appears in the audit trail, so if this modal is dismissed
        without copying it, the only route back is a password reset.
      */}
      <Modal isOpen={Boolean(created)} onClose={closeAll} title="Employee added" size="md">
        {created && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-slate-600">
              <strong className="text-slate-900">{created.employee.displayName}</strong> was
              created with the code{" "}
              <strong className="text-slate-900">{created.employee.employeeCode}</strong>.
            </p>

            <div className="rounded-lg border border-warning-100 bg-warning-50 p-4">
              <p className="text-xs font-semibold text-warning-600 mb-2">
                One-time password — copy it now
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-white border border-slate-200 rounded font-mono text-sm text-slate-900 select-all">
                  {created.tempPassword}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    navigator.clipboard?.writeText(created.tempPassword);
                    setCopied(true);
                  }}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </Button>
              </div>
              <p className="text-xs text-warning-600 mt-2">
                It is not stored anywhere and cannot be shown again. If it is lost, a super
                admin can issue a new one.
              </p>
            </div>

            <div className="flex justify-end">
              <Button onClick={closeAll}>Done</Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

export default EmployeeFormDrawer;
