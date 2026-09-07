import { useMemo } from "react";
import { useFormContext, useFieldArray, useWatch } from "react-hook-form";
import { Plus, Trash2, ArrowLeftRight } from "lucide-react";

import { Input } from "../../../components/ui/Input";
import { Button } from "../../../components/ui/Button";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { optionsWithCurrent } from "../../../services/hrms";
import { MAX_EMERGENCY_CONTACTS } from "@shared/schemas/employee.js";
import { EMPLOYMENT_TYPES, EMPLOYEE_STATUSES } from "@shared/constants/hrms.js";

/**
 * The employee field set, shared by the "Add employee" drawer and the full-page
 * edit — exactly as the reference shares one component between its drawer and
 * its edit page.
 *
 * Section order follows the reference, verified against its
 * `EmployeeFormFields.tsx` rather than assumed:
 *   Personal → Family → Job → [Probation] → [Notice]
 *   → [Additional fields] → Address → Emergency Contacts
 *
 * Two fields are immutable once created, matching the reference's disabled
 * inputs: `email` is the login identity, and `employeeCode` is the natural key
 * every other record joins on.
 */

const label = (s) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const EMPLOYMENT_TYPE_OPTIONS = EMPLOYMENT_TYPES.map((v) => ({ value: v, label: label(v) }));
const STATUS_OPTIONS = EMPLOYEE_STATUSES.map((v) => ({ value: v, label: label(v) }));

/** Add N calendar months to a YYYY-MM-DD string. */
const addMonths = (day, months) => {
  if (!day || months == null || Number.isNaN(Number(months))) return null;
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + Number(months));
  return d.toISOString().slice(0, 10);
};

/** Whole months between two YYYY-MM-DD strings, never negative. */
const monthsBetween = (from, to) => {
  if (!from || !to) return null;
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  return Math.max(0, months);
};

function Section({ title, hint, children }) {
  return (
    <section className="mt-6 first:mt-0">
      <h3 className="text-sm font-bold text-slate-900 mb-3">
        {title}
        {hint && <span className="ml-2 text-xs font-normal text-slate-400">{hint}</span>}
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{children}</div>
    </section>
  );
}

function Field({ name, label: text, required, children, className }) {
  const {
    formState: { errors },
  } = useFormContext();
  const error = name.split(".").reduce((o, k) => o?.[k], errors);

  return (
    <div className={className}>
      <label className="text-xs font-semibold text-slate-700 select-none block mb-1.5">
        {text}
        {required && <span className="text-error-500 ml-0.5">*</span>}
      </label>
      {children}
      {error?.message && (
        <span className="text-xs text-error-500 font-medium mt-1 block">{error.message}</span>
      )}
    </div>
  );
}

export function EmployeeFormFields({
  mode,
  canEditJobDetails = true,
  customFields = [],
  managerOptions = [],
  identity = null,
  departments = [],
  locations = [],
  current = null,
}) {
  const { register, control, setValue, getValues } = useFormContext();

  // The reference watches `status` to reveal the probation and notice blocks —
  // each only makes sense for its own status.
  const status = useWatch({ control, name: "status" });
  const showProbation = status === "probation";
  const showNotice = status === "notice";

  const isEdit = mode === "edit";

  /**
   * Live catalogue rows, plus whatever the record already holds.
   *
   * `optionsWithCurrent` puts back a department or location that has since been
   * retired. Without it the picker would show "nothing selected" for a value
   * the employee genuinely has, and the next save would read as a deliberate
   * clearing of a field nobody touched.
   */
  const departmentOptions = useMemo(
    () => optionsWithCurrent(departments, current?.departmentId, current?.departmentName),
    [departments, current?.departmentId, current?.departmentName],
  );
  const locationOptions = useMemo(
    () => optionsWithCurrent(locations, current?.locationId, current?.locationName),
    [locations, current?.locationId, current?.locationName],
  );

  return (
    <div>
      {/* ---- Personal ---- */}
      <Section title="Personal">
        <Field name="firstName" label="First name" required>
          <Input {...register("firstName")} placeholder="e.g. Priya" />
        </Field>
        <Field name="lastName" label="Last name" required>
          <Input {...register("lastName")} placeholder="e.g. Sharma" />
        </Field>

        <Field name="email" label="Work email" required>
          {/*
            The login identity. Immutable after creation, as in the reference.

            On edit it is shown from `identity` and NOT registered. Both form
            schemas are `.strict()` and the update schema omits this field, so
            a registered value would sit in form state, fail the resolver with
            `unrecognized_keys`, and block every save.
          */}
          {isEdit ? (
            <Input
              type="email"
              value={identity?.email ?? ""}
              readOnly
              disabled
              helperText="The work email is the login and cannot be changed here."
            />
          ) : (
            <Input {...register("email")} type="email" placeholder="name@company.com" />
          )}
        </Field>
        <Field name="personalEmail" label="Personal email">
          <Input {...register("personalEmail")} type="email" placeholder="Optional" />
        </Field>

        <Field name="phone" label="Phone 1 (Personal)">
          <Input {...register("phone")} placeholder="Primary contact number" />
        </Field>
        <Field name="phone2" label="Phone 2 (Optional)">
          <Input {...register("phone2")} placeholder="Alternate / secondary number" />
        </Field>

        <Field name="dateOfBirth" label="Date of birth">
          <Input {...register("dateOfBirth")} type="date" />
        </Field>
      </Section>

      {/* ---- Family ---- */}
      <Section title="Family">
        <Field name="fatherName" label="Father's name">
          <Input {...register("fatherName")} placeholder="e.g. Suresh Sharma" />
        </Field>
        <Field name="motherName" label="Mother's name">
          <Input {...register("motherName")} placeholder="e.g. Rekha Sharma" />
        </Field>
      </Section>

      {/* ---- Job ---- */}
      <Section
        title="Job"
        hint={!canEditJobDetails ? "— HR / Recruiter only" : undefined}
      >
        <Field name="employeeCode" label="Employee code" required>
          {/* The natural key. Immutable after creation — see the work email. */}
          {isEdit ? (
            <Input
              value={identity?.employeeCode ?? ""}
              readOnly
              disabled
              helperText="The employee code is the permanent identifier."
            />
          ) : (
            <Input {...register("employeeCode")} placeholder="e.g. SI-0006" />
          )}
        </Field>
        <Field name="designation" label="Designation">
          {/* Free text in the reference, not a lookup. */}
          <Input {...register("designation")} disabled={!canEditJobDetails} placeholder="e.g. Accounts Executive" />
        </Field>

        <Field name="employmentType" label="Employment type" required>
          <SelectField
            name="employmentType"
            options={EMPLOYMENT_TYPE_OPTIONS}
            disabled={!canEditJobDetails}
          />
        </Field>
        <Field name="status" label="Status" required>
          <SelectField name="status" options={STATUS_OPTIONS} disabled={!canEditJobDetails} />
        </Field>

        <Field name="dateOfJoining" label="Date of joining" required>
          <Input
            {...register("dateOfJoining")}
            type="date"
            disabled={!canEditJobDetails}
            onChange={(e) => {
              setValue("dateOfJoining", e.target.value, { shouldDirty: true });
              // dateOfJoining is the fallback anchor for probation. Only
              // recompute when the user has not set an explicit start date.
              if (getValues("probationStartDate")) return;
              const months = getValues("probationMonths");
              const end = addMonths(e.target.value, months);
              if (end) setValue("probationEndDate", end, { shouldDirty: true });
            }}
          />
        </Field>
        <Field name="reportingManagerId" label="Reporting manager">
          <ManagerSelect disabled={!canEditJobDetails} options={managerOptions} />
        </Field>

        {/*
          Department and Location, populated from Org Structure. Both optional
          on the record and both clearable, matching the reference's
          `allowClear` Selects.
        */}
        <Field name="departmentId" label="Department">
          <ReferenceSelect
            name="departmentId"
            options={departmentOptions}
            disabled={!canEditJobDetails}
            placeholder="No department"
            emptyText="No departments yet"
          />
        </Field>
        <Field name="locationId" label="Location">
          <ReferenceSelect
            name="locationId"
            options={locationOptions}
            disabled={!canEditJobDetails}
            placeholder="No location"
            emptyText="No locations yet"
          />
        </Field>
      </Section>

      {/* ---- Probation (conditional) ---- */}
      {showProbation && <ProbationBlock disabled={!canEditJobDetails} />}

      {/* ---- Notice (conditional) ---- */}
      {showNotice && <NoticeBlock disabled={!canEditJobDetails} />}

      {/* ---- Custom fields ---- */}
      {customFields.length > 0 && (
        <Section title="Additional fields">
          {[...customFields]
            .sort((a, b) => a.order - b.order)
            .map((f) => (
              <CustomFieldInput key={f.id} field={f} />
            ))}
        </Section>
      )}

      <AddressBlock />

      <EmergencyContactsBlock />
    </div>
  );
}

/** A plain select bound to react-hook-form. */
function SelectField({ name, options, disabled }) {
  const { register } = useFormContext();
  return (
    <select
      {...register(name)}
      disabled={disabled}
      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none transition-all text-slate-900 focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * A picker bound to one form field, for an optional Org Structure reference.
 *
 * Clearing it writes null rather than undefined: the update schema is
 * `.partial()`, so undefined would mean "not submitted" and the value would
 * survive a deliberate clearing.
 */
function ReferenceSelect({ name, options, disabled, placeholder, emptyText }) {
  const { control, setValue } = useFormContext();
  const value = useWatch({ control, name });

  return (
    <SearchableSelect
      value={value ?? null}
      onChange={(v) => setValue(name, v ?? null, { shouldDirty: true })}
      options={options}
      disabled={disabled}
      placeholder={placeholder}
      searchPlaceholder="Search by code or name…"
      emptyText={emptyText}
    />
  );
}

/**
 * Reporting-manager picker.
 *
 * Loads active employees only, mirroring the reference's
 * `useEmployees({ status: 'active' })`. The employee being edited is excluded —
 * the server rejects a self-reference anyway, but offering it as a choice
 * invites the error.
 *
 * The options are a PROP, not form state. Holding them in the form would put
 * a key on the submitted values that neither schema declares, and both are
 * `.strict()` — so the resolver would reject every save with
 * `unrecognized_keys` and the form could never be submitted at all.
 */
function ManagerSelect({ disabled, options = [] }) {
  const { control, setValue } = useFormContext();
  const value = useWatch({ control, name: "reportingManagerId" });

  return (
    <SearchableSelect
      value={value ?? null}
      onChange={(v) => setValue("reportingManagerId", v, { shouldDirty: true })}
      options={options}
      disabled={disabled}
      placeholder="— none (top of the organisation)"
      searchPlaceholder="Search by name or code…"
      emptyText="No active employees to choose from"
    />
  );
}

/**
 * Permanent and temporary address, with the reference's copy actions so HR does
 * not retype an identical address.
 */
function AddressBlock() {
  const { register, control, setValue } = useFormContext();
  const permanent = useWatch({ control, name: "permanentAddress" });
  const temporary = useWatch({ control, name: "temporaryAddress" });

  const textarea =
    "w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none transition-all placeholder-slate-400 text-slate-900 focus:border-primary-500 focus:ring-1 focus:ring-primary-500 resize-y";

  return (
    <Section title="Address">
      <Field name="permanentAddress" label="Permanent address">
        <textarea
          {...register("permanentAddress")}
          rows={4}
          className={textarea}
          placeholder="House / street / area / city / state / PIN"
        />
        <Button
          type="button"
          variant="ghost"
          className="mt-1.5 text-xs"
          disabled={!temporary?.trim()}
          onClick={() => setValue("permanentAddress", temporary ?? "", { shouldDirty: true })}
        >
          <ArrowLeftRight size={12} className="mr-1" />
          Copy from temporary
        </Button>
      </Field>

      <Field name="temporaryAddress" label="Temporary / current address">
        <textarea
          {...register("temporaryAddress")}
          rows={4}
          className={textarea}
          placeholder="Leave blank if same as permanent"
        />
        <Button
          type="button"
          variant="ghost"
          className="mt-1.5 text-xs"
          disabled={!permanent?.trim()}
          onClick={() => setValue("temporaryAddress", permanent ?? "", { shouldDirty: true })}
        >
          <ArrowLeftRight size={12} className="mr-1" />
          Copy from permanent
        </Button>
      </Field>
    </Section>
  );
}

/** Up to two contacts, each with a strictly 10-digit phone. */
function EmergencyContactsBlock() {
  const { control, register, setValue } = useFormContext();
  const { fields, append, remove } = useFieldArray({ control, name: "emergencyContacts" });

  return (
    <section className="mt-6">
      <h3 className="text-sm font-bold text-slate-900 mb-3">
        Emergency Contacts
        <span className="ml-2 text-xs font-normal text-slate-400">
          — up to {MAX_EMERGENCY_CONTACTS}
        </span>
      </h3>

      {fields.length === 0 && (
        <p className="text-xs text-slate-400 mb-3">No emergency contact recorded.</p>
      )}

      <div className="flex flex-col gap-3">
        {fields.map((field, i) => (
          <div key={field.id} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-3 items-start">
            <Field name={`emergencyContacts.${i}.name`} label="Name">
              <Input {...register(`emergencyContacts.${i}.name`)} placeholder="Contact name" />
            </Field>
            <Field name={`emergencyContacts.${i}.relationship`} label="Relationship">
              <Input
                {...register(`emergencyContacts.${i}.relationship`)}
                placeholder="Father / Spouse / Sibling…"
              />
            </Field>
            <Field name={`emergencyContacts.${i}.phone`} label="Phone">
              <Input
                {...register(`emergencyContacts.${i}.phone`)}
                inputMode="numeric"
                maxLength={10}
                placeholder="10-digit number"
                onChange={(e) => {
                  // Strip non-digits as the user types, so a pasted
                  // "+91 98765 43210" becomes a valid value instead of an error.
                  const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
                  setValue(`emergencyContacts.${i}.phone`, digits, { shouldDirty: true });
                }}
              />
            </Field>
            <div className="pt-6">
              <Button type="button" variant="ghost" onClick={() => remove(i)} aria-label="Remove contact">
                <Trash2 size={15} className="text-slate-400" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {fields.length < MAX_EMERGENCY_CONTACTS && (
        <Button
          type="button"
          variant="secondary"
          className="mt-3"
          onClick={() => append({ name: "", relationship: "", phone: "", email: null })}
        >
          <Plus size={14} className="mr-1" />
          Add contact
        </Button>
      )}
    </section>
  );
}

/**
 * Probation window, with the reference's bidirectional sync.
 *
 *   months changes → end = anchor + months
 *   end changes    → months = end − anchor
 *   start changes  → end = start + months
 *
 * The anchor is the explicit start date, falling back to the date of joining.
 * Each handler writes only the OTHER field, so there is no feedback loop to
 * guard against.
 */
function ProbationBlock({ disabled }) {
  const { register, control, setValue, getValues } = useFormContext();
  const joining = useWatch({ control, name: "dateOfJoining" });

  const anchor = () => getValues("probationStartDate") || joining;

  return (
    <section className="mt-6">
      <h3 className="text-sm font-bold text-slate-900 mb-3">
        Probation
        <span className="ml-2 text-xs font-normal text-slate-400">
          — anchored to the start date, or the date of joining
        </span>
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field name="probationStartDate" label="Start date">
          <Input
            {...register("probationStartDate")}
            type="date"
            disabled={disabled}
            onChange={(e) => {
              setValue("probationStartDate", e.target.value, { shouldDirty: true });
              const months = getValues("probationMonths");
              const end = addMonths(e.target.value, months);
              if (end) setValue("probationEndDate", end, { shouldDirty: true });
            }}
          />
        </Field>

        <Field name="probationMonths" label="Period (months)">
          <Input
            {...register("probationMonths", { valueAsNumber: true })}
            type="number"
            min={1}
            max={24}
            disabled={disabled}
            placeholder="e.g. 3"
            onChange={(e) => {
              const months = e.target.value === "" ? null : Number(e.target.value);
              setValue("probationMonths", months, { shouldDirty: true });
              const end = addMonths(anchor(), months);
              if (end) setValue("probationEndDate", end, { shouldDirty: true });
            }}
          />
        </Field>

        <Field name="probationEndDate" label="End date">
          <Input
            {...register("probationEndDate")}
            type="date"
            disabled={disabled}
            onChange={(e) => {
              setValue("probationEndDate", e.target.value, { shouldDirty: true });
              const months = monthsBetween(anchor(), e.target.value);
              if (months !== null) setValue("probationMonths", months, { shouldDirty: true });
            }}
          />
        </Field>
      </div>
    </section>
  );
}

/**
 * Notice period. Same sync pattern, but the anchor is always the notice start
 * date — a notice period is not tied to when someone joined.
 */
function NoticeBlock({ disabled }) {
  const { register, setValue, getValues } = useFormContext();

  return (
    <section className="mt-6">
      <h3 className="text-sm font-bold text-slate-900 mb-3">Notice period</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field name="noticeStartDate" label="Notice start date" required>
          <Input
            {...register("noticeStartDate")}
            type="date"
            disabled={disabled}
            onChange={(e) => {
              setValue("noticeStartDate", e.target.value, { shouldDirty: true });
              const months = getValues("noticeMonths");
              const end = addMonths(e.target.value, months);
              if (end) setValue("noticeEndDate", end, { shouldDirty: true });
            }}
          />
        </Field>

        <Field name="noticeMonths" label="Period (months)">
          <Input
            {...register("noticeMonths", { valueAsNumber: true })}
            type="number"
            min={1}
            max={12}
            disabled={disabled}
            placeholder="e.g. 2"
            onChange={(e) => {
              const months = e.target.value === "" ? null : Number(e.target.value);
              setValue("noticeMonths", months, { shouldDirty: true });
              const end = addMonths(getValues("noticeStartDate"), months);
              if (end) setValue("noticeEndDate", end, { shouldDirty: true });
            }}
          />
        </Field>

        <Field name="noticeEndDate" label="Last working day">
          <Input
            {...register("noticeEndDate")}
            type="date"
            disabled={disabled}
            onChange={(e) => {
              setValue("noticeEndDate", e.target.value, { shouldDirty: true });
              const months = monthsBetween(getValues("noticeStartDate"), e.target.value);
              if (months !== null) setValue("noticeMonths", months, { shouldDirty: true });
            }}
          />
        </Field>
      </div>
    </section>
  );
}

/** One admin-defined field, rendered by its declared type. */
function CustomFieldInput({ field }) {
  const { register, control, setValue } = useFormContext();
  const name = `customFieldValues.${field.name}`;
  const value = useWatch({ control, name });

  if (field.type === "boolean") {
    return (
      <Field name={name} label={field.label} required={field.required}>
        <label className="flex items-center gap-2 text-sm text-slate-700 pt-1.5">
          <input type="checkbox" {...register(name)} className="rounded border-slate-300" />
          Yes
        </label>
      </Field>
    );
  }

  if (field.type === "select" || field.type === "multiselect") {
    // Multiselect is not offered as a distinct control here; the reference uses
    // one for a handful of fields, and a single-select keeps the value shape
    // predictable until a real multiselect is needed.
    return (
      <Field name={name} label={field.label} required={field.required}>
        <SearchableSelect
          value={value ?? null}
          onChange={(v) => setValue(name, v, { shouldDirty: true })}
          options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
          placeholder="Select…"
        />
      </Field>
    );
  }

  if (field.type === "textarea") {
    return (
      <Field name={name} label={field.label} required={field.required}>
        <textarea
          {...register(name)}
          rows={3}
          className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 resize-y"
        />
      </Field>
    );
  }

  return (
    <Field name={name} label={field.label} required={field.required}>
      <Input
        {...register(name, field.type === "number" ? { valueAsNumber: true } : {})}
        type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
      />
    </Field>
  );
}

export default EmployeeFormFields;
