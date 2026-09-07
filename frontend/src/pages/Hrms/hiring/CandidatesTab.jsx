import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, FileText, Upload, Search } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Modal } from "../../../components/ui/Modal";
import { Input } from "../../../components/ui/Input";
import { candidatesApi, uploadResume, formatCtc } from "../../../services/hrms/hiring";
import { createCandidateSchema } from "@shared/schemas/hiring.js";
import {
  CANDIDATE_SOURCES,
  RESUME_MIME_TYPES,
  MAX_RESUME_BYTES,
} from "@shared/constants/hiring.js";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";

const MB = Math.round(MAX_RESUME_BYTES / (1024 * 1024));

const SOURCE_LABELS = {
  careers: "Careers page",
  referral: "Referral",
  linkedin: "LinkedIn",
  naukri: "Naukri",
  indeed: "Indeed",
  manual: "Added manually",
};

const SOURCE_OPTIONS = CANDIDATE_SOURCES.map((value) => ({
  value,
  label: SOURCE_LABELS[value] ?? value,
}));

/**
 * Candidates — the people, independent of any one role.
 *
 * A candidate exists once and is keyed on their email, so somebody who applies
 * to three adverts is one record with three applications rather than three
 * half-filled duplicates. `applicationCount` is what makes that visible.
 *
 * The résumé is the sensitive part of this screen. It is never rendered from a
 * stored URL: the row carries only `hasResume`, and a presigned URL is fetched
 * when somebody actually clicks to open one. That request is audited
 * server-side as a résumé view, which is exactly why the listing must not
 * prefetch them — it would file reads nobody performed.
 */
export function CandidatesTab() {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState(null);
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState(null);
  const [failure, setFailure] = useState(null);

  // Debounced, so typing a name does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(
        (await candidatesApi.list({
          page,
          pageSize: 25,
          ...(query ? { search: query } : {}),
          ...(source ? { source } : {}),
        })) ?? { data: [], total: 0 },
      );
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, query, source]);

  useEffect(() => {
    load();
  }, [load]);

  const openResume = useCallback(async (row) => {
    setOpening(row.id);
    setFailure(null);
    try {
      const { url } = (await candidatesApi.resumeUrl(row.id)) ?? {};
      if (!url) throw new Error("No résumé is attached to this candidate.");
      // noopener, so the presigned URL is not handed a reference back to this
      // tab.
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setFailure(err?.message ?? "That résumé could not be opened.");
    } finally {
      setOpening(null);
    }
  }, []);

  const columns = useMemo(
    () => [
      {
        header: "Candidate",
        className: CELL + " font-semibold text-slate-900",
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-col">
            <span>{row.name}</span>
            <span className="text-[11px] font-normal text-slate-500">{row.email}</span>
          </div>
        ),
      },
      {
        header: "Phone",
        className: CELL + " w-[150px] text-xs text-slate-600 tabular-nums",
        headerClassName: HEAD,
        cell: (row) => row.phone || <span className="text-slate-400">—</span>,
      },
      {
        header: "Currently at",
        className: CELL + " w-[170px] text-xs text-slate-600",
        headerClassName: HEAD,
        cell: (row) => row.currentEmployer || <span className="text-slate-400">—</span>,
      },
      {
        header: "Expected",
        className: CELL + " w-[130px] text-right text-xs tabular-nums",
        headerClassName: HEAD + " text-right",
        cell: (row) => formatCtc(row.expectedSalary),
      },
      {
        header: "Notice",
        className: CELL + " w-[90px] text-right text-xs tabular-nums",
        headerClassName: HEAD + " text-right",
        cell: (row) =>
          row.noticePeriodDays === null || row.noticePeriodDays === undefined ? (
            <span className="text-slate-400">—</span>
          ) : (
            <span>{row.noticePeriodDays}d</span>
          ),
      },
      {
        header: "Source",
        className: CELL + " w-[130px]",
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-col gap-1">
            <Badge variant="neutral">{SOURCE_LABELS[row.source] ?? row.source ?? "—"}</Badge>
            <span className="text-[10.5px] text-slate-400">
              {row.applicationCount} application{row.applicationCount === 1 ? "" : "s"}
            </span>
          </div>
        ),
      },
      {
        header: "Résumé",
        className: CELL + " w-[120px]",
        headerClassName: HEAD,
        cell: (row) =>
          row.hasResume ? (
            <Button
              size="xs"
              variant="outline"
              loading={opening === row.id}
              onClick={() => openResume(row)}
            >
              <FileText size={12} className="mr-1" />
              Open
            </Button>
          ) : (
            <span className="text-xs text-slate-400">Not attached</span>
          ),
      },
    ],
    [openResume, opening],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="relative w-64">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
            />
            <input
              type="search"
              aria-label="Search candidates"
              placeholder="Search by name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none transition-all placeholder-slate-400 text-slate-900 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            />
          </div>
          <SearchableSelect
            className="w-44"
            value={source}
            onChange={(value) => {
              setSource(value);
              // Filtering while on page 4 would land on an empty table with no
              // visible cause.
              setPage(1);
            }}
            options={SOURCE_OPTIONS}
            placeholder="Any source"
          />
        </div>
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          <Plus size={14} className="mr-1.5" />
          Add candidate
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
        emptyTitle="No candidates yet"
        emptyDescription="Add one, or let the careers page collect them."
      />

      <CandidateDialog
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

const EMPTY_CANDIDATE = {
  name: "",
  email: "",
  phone: "",
  currentEmployer: "",
  expectedSalary: "",
  noticePeriodDays: "",
  source: "manual",
};

function CandidateDialog({ open, onClose, onSaved }) {
  const [values, setValues] = useState(EMPTY_CANDIDATE);
  const [file, setFile] = useState(null);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [warning, setWarning] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setValues(EMPTY_CANDIDATE);
    setFile(null);
    setErrors({});
    setFailure(null);
    setWarning(null);
    if (fileRef.current) fileRef.current.value = "";
  }, [open]);

  const set = (key) => (event) => {
    setValues((v) => ({ ...v, [key]: event.target.value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const pickFile = (event) => {
    const picked = event.target.files?.[0] ?? null;
    setWarning(null);
    if (!picked) {
      setFile(null);
      return;
    }
    // Checked here for a quick answer; the server re-checks by reading the
    // file's leading bytes, because an extension and a declared MIME type both
    // come from the client and prove nothing.
    if (!RESUME_MIME_TYPES.includes(picked.type)) {
      setWarning("A résumé must be a PDF or a Word document.");
      setFile(null);
      return;
    }
    if (picked.size > MAX_RESUME_BYTES) {
      setWarning("That file is larger than " + MB + " MB.");
      setFile(null);
      return;
    }
    setFile(picked);
  };

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const dto = {
      name: values.name,
      email: values.email,
      phone: values.phone || undefined,
      source: values.source || "manual",
      currentEmployer: values.currentEmployer || undefined,
      expectedSalary: values.expectedSalary || undefined,
      noticePeriodDays: values.noticePeriodDays === "" ? undefined : Number(values.noticePeriodDays),
    };

    // The SERVER's schema, imported from @shared — the rules the form enforces
    // are literally the rules the API enforces.
    const parsed = createCandidateSchema.safeParse(dto);
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
      const created = await candidatesApi.create(parsed.data);
      if (file && created?.id) {
        // A second call by design — the résumé is keyed on the candidate id,
        // which does not exist until the record does. A failure here must not
        // read as "the candidate was not saved", because it was.
        try {
          await uploadResume(created.id, file);
        } catch {
          setFailure("The candidate was saved, but the résumé could not be attached.");
          setSubmitting(false);
          return;
        }
      }
      onSaved();
    } catch (err) {
      setFailure(err?.message ?? "The candidate could not be saved.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title="Add a candidate" size="lg">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Name"
            aria-label="Name"
            value={values.name}
            onChange={set("name")}
            error={errors.name}
          />
          <Input
            label="Email"
            aria-label="Email"
            type="email"
            value={values.email}
            onChange={set("email")}
            error={errors.email}
            helperText="Identifies the candidate — a later application reuses this record."
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Phone"
            aria-label="Phone"
            value={values.phone}
            onChange={set("phone")}
            error={errors.phone}
          />
          <SearchableSelect
            label="Source"
            value={values.source}
            onChange={(v) => setValues((prev) => ({ ...prev, source: v ?? "manual" }))}
            options={SOURCE_OPTIONS}
            allowClear={false}
            error={errors.source}
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Input
            label="Current employer"
            aria-label="Current employer"
            value={values.currentEmployer}
            onChange={set("currentEmployer")}
            error={errors.currentEmployer}
          />
          <Input
            label="Expected CTC"
            aria-label="Expected CTC"
            value={values.expectedSalary}
            onChange={set("expectedSalary")}
            error={errors.expectedSalary}
            helperText="Annual"
          />
          <Input
            type="number"
            min={0}
            max={365}
            label="Notice (days)"
            aria-label="Notice (days)"
            value={values.noticePeriodDays}
            onChange={set("noticePeriodDays")}
            error={errors.noticePeriodDays}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="candidate-resume" className="text-xs font-semibold text-slate-700">
            Résumé
          </label>
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              id="candidate-resume"
              type="file"
              accept=".pdf,.doc,.docx"
              onChange={pickFile}
              className="text-xs text-slate-600 file:mr-3 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:rounded-lg file:border file:border-slate-300 file:bg-slate-50 file:text-slate-700 hover:file:bg-slate-100"
            />
            {file && (
              <span className="inline-flex items-center gap-1 text-xs text-success-600 font-medium">
                <Upload size={12} />
                {file.name}
              </span>
            )}
          </div>
          {warning ? (
            <span className="text-xs text-error-500 font-medium">{warning}</span>
          ) : (
            <span className="text-xs text-slate-500">
              PDF or Word, up to {MB} MB. Stored privately — every time somebody opens it is
              recorded.
            </span>
          )}
        </div>

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
            Save candidate
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default CandidatesTab;
