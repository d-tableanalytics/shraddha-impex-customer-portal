import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Send, FileText } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Input } from "../../../components/ui/Input";
import { DateField } from "../../../components/ui/DateField";
import { employeesApi } from "../../../services/hrms";
import {
  offerLettersApi,
  OFFER_LETTER_STATE_TONES,
  formatCtcAmount,
  formatDay,
  formatInstant,
} from "../../../services/hrms/onboarding";
import { createOfferLetterSchema } from "@shared/schemas/onboarding.js";
import { OFFER_LETTER_STATE_LABELS } from "@shared/constants/onboarding.js";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";

/**
 * Offer letters — HR's view of the employee-facing offer.
 *
 * The reference's Offers tab: Employee, Designation, CTC (right-aligned),
 * Joining, Sent, a status tag and the PDF / Send actions.
 *
 * 🔴 One correction is visible right here. The reference renders Send only when
 * `!sentAt && pdfKey`, and its `pdfKey` is set BY send — so a draft never has a
 * key, a sent offer always has `sentAt`, and the button can never appear. Here
 * the letter is generated when the draft is created, so a draft is reviewable
 * and Send means only "release it".
 *
 * This is NOT Hiring's offer. That one is addressed to a candidate with no
 * account and is opened through a hashed public link; this one belongs to an
 * employee record and is signed in the portal.
 */
export function OfferLettersTab() {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult((await offerLettersApi.list({ page, pageSize: 25 })) ?? { data: [], total: 0 });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const send = useCallback(
    async (row) => {
      setBusy(row.id);
      setFailure(null);
      try {
        await offerLettersApi.send(row.id);
        await load();
      } catch (err) {
        setFailure(err?.message ?? "That offer letter could not be sent.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const openDocument = useCallback(async (row) => {
    setBusy(row.id);
    setFailure(null);
    try {
      const { url } = (await offerLettersApi.documentUrl(row.id)) ?? {};
      if (!url) throw new Error("No letter has been generated for this offer.");
      // noopener, so the presigned URL is not handed a reference back to this tab.
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setFailure(err?.message ?? "That letter could not be opened.");
    } finally {
      setBusy(null);
    }
  }, []);

  const columns = useMemo(
    () => [
      {
        header: "Employee",
        className: `${CELL} font-semibold text-slate-900`,
        headerClassName: HEAD,
        cell: (row) => row.employeeName ?? "—",
      },
      {
        header: "Designation",
        className: `${CELL} text-xs text-slate-600`,
        headerClassName: HEAD,
        cell: (row) => row.designation,
      },
      {
        header: "CTC",
        className: `${CELL} w-[140px] text-right tabular-nums font-semibold`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => formatCtcAmount(row.ctc),
      },
      {
        header: "Joining",
        className: `${CELL} w-[130px] text-xs text-slate-600 tabular-nums`,
        headerClassName: HEAD,
        cell: (row) => formatDay(row.joiningDate),
      },
      {
        header: "Sent",
        className: `${CELL} w-[150px] text-xs text-slate-600 tabular-nums`,
        headerClassName: HEAD,
        cell: (row) => (row.sentAt ? formatInstant(row.sentAt) : <span className="text-slate-400">—</span>),
      },
      {
        header: "Status",
        className: `${CELL} w-[140px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-col gap-1">
            <Badge variant={OFFER_LETTER_STATE_TONES[row.state] ?? "neutral"}>
              {OFFER_LETTER_STATE_LABELS[row.state] ?? row.state}
            </Badge>
            {row.state === "accepted" && row.signature?.name && (
              <span className="text-[10.5px] text-slate-500">Signed by {row.signature.name}</span>
            )}
            {row.state === "rejected" && row.rejectionReason && (
              <span className="text-[10.5px] text-slate-500 leading-snug">
                {row.rejectionReason}
              </span>
            )}
          </div>
        ),
      },
      {
        header: "",
        className: `${CELL} w-[180px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-wrap gap-1.5">
            {row.hasDocument && (
              <Button
                size="xs"
                variant="outline"
                loading={busy === row.id}
                onClick={() => openDocument(row)}
              >
                <FileText size={11} className="mr-1" />
                Letter
              </Button>
            )}
            {row.state === "draft" && (
              <Button size="xs" variant="primary" loading={busy === row.id} onClick={() => send(row)}>
                <Send size={11} className="mr-1" />
                Send
              </Button>
            )}
          </div>
        ),
      },
    ],
    [busy, openDocument, send],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          <Plus size={14} className="mr-1.5" />
          New offer
        </Button>
      </div>

      {failure && (
        <p role="alert" className="text-xs text-error-500 font-medium">
          {failure}
        </p>
      )}

      <HrmsDataTable
        columns={columns}
        rows={result.data}
        loading={loading}
        error={error}
        onRetry={load}
        page={result.page ?? page}
        pageSize={result.pageSize ?? 25}
        total={result.total ?? 0}
        onPageChange={setPage}
        emptyTitle="No offer letters yet"
        emptyDescription="Draft one for a new hire, then send it for them to sign in the portal."
      />

      <OfferDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          load();
        }}
      />
    </div>
  );
}

function OfferDrawer({ open, onClose, onSaved }) {
  const [employees, setEmployees] = useState([]);
  const [values, setValues] = useState({
    employeeId: null,
    designation: "",
    ctc: "",
    joiningDate: "",
  });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({ employeeId: null, designation: "", ctc: "", joiningDate: "" });
    setErrors({});
    setFailure(null);
    employeesApi
      .list({ page: 1, pageSize: 200 })
      .then((res) => setEmployees(res?.data ?? []))
      .catch(() => setFailure("The employee list could not be loaded."));
  }, [open]);

  const set = (key) => (event) => {
    setValues((v) => ({ ...v, [key]: event.target.value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const parsed = createOfferLetterSchema.safeParse({
      employeeId: values.employeeId,
      designation: values.designation,
      ctc: values.ctc,
      joiningDate: values.joiningDate,
    });
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path?.[0];
        if (field && !next[field]) next[field] = issue.message;
      }
      setErrors(next);
      return;
    }

    setSubmitting(true);
    try {
      await offerLettersApi.create(parsed.data);
      onSaved();
    } catch (err) {
      // "Already has an offer awaiting a decision" arrives here.
      setFailure(err?.message ?? "That offer letter could not be saved.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <Drawer isOpen onClose={onClose} title="New offer letter" maxWidth="max-w-lg">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <SearchableSelect
          label="Employee"
          value={values.employeeId}
          onChange={(v) => {
            setValues((prev) => ({ ...prev, employeeId: v }));
            setErrors((e) => ({ ...e, employeeId: undefined }));
          }}
          options={employees.map((e) => ({
            value: e.id,
            label: `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim(),
            hint: e.employeeCode,
          }))}
          placeholder="Search employees…"
          error={errors.employeeId}
        />

        <Input
          label="Designation"
          aria-label="Designation"
          placeholder="e.g. Senior Software Engineer"
          value={values.designation}
          onChange={set("designation")}
          error={errors.designation}
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="CTC (₹ per annum)"
            aria-label="CTC (₹ per annum)"
            value={values.ctc}
            onChange={set("ctc")}
            error={errors.ctc}
            helperText="Exactly as offered — stored to the paisa."
          />
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-700">Joining date</label>
            <DateField
              value={values.joiningDate}
              onChange={(joiningDate) => {
                setValues((v) => ({ ...v, joiningDate }));
                setErrors((e) => ({ ...e, joiningDate: undefined }));
              }}
            />
            {errors.joiningDate && (
              <span className="text-xs text-error-500 font-medium">{errors.joiningDate}</span>
            )}
          </div>
        </div>

        <p className="text-[11px] text-slate-500 leading-relaxed">
          The letter is generated as soon as the draft is saved, so you can read it before it goes
          out. Sending is a separate step, and is what lets the new hire sign it in their portal.
        </p>

        {failure && (
          <p role="alert" className="text-xs text-error-500 font-medium">
            {failure}
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            Create draft
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default OfferLettersTab;
