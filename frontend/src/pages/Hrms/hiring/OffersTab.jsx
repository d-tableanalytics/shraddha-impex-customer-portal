import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Send, Copy, Check, ShieldAlert } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Modal } from "../../../components/ui/Modal";
import { Drawer } from "../../../components/ui/Drawer";
import { Input } from "../../../components/ui/Input";
import { DateField } from "../../../components/ui/DateField";
import {
  offersApi,
  applicationsApi,
  OFFER_STATE_TONES,
  STAGE_LABELS,
  formatCtc,
} from "../../../services/hrms/hiring";
import { createOfferSchema } from "@shared/schemas/hiring.js";
import { OFFER_TOKEN_TTL_DAYS } from "@shared/constants/hiring.js";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";

const STATE_LABELS = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Declined",
  expired: "Expired",
};

const formatDay = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

/**
 * Offers.
 *
 * ---------------------------------------------------------------------------
 * The link is shown once, and this screen is the only place it exists
 * ---------------------------------------------------------------------------
 * Sending an offer mints a 256-bit token; the server stores only its SHA-256
 * and returns the plaintext exactly once, in the response to `send`. It is not
 * in the offer record, not in the audit trail, and not recoverable — so the
 * dialog below is deliberately insistent about copying it before closing.
 *
 * The reference has no token at all: its candidate-facing routes take the
 * offer's own UUID, so anyone holding one can read a stranger's salary or
 * accept on their behalf. That is why this flow looks the way it does.
 */
export function OffersTab() {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult((await offersApi.list({ page, pageSize: 25 })) ?? { data: [], total: 0 });
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
        // The ONLY moment the plaintext token exists outside the candidate's
        // inbox. It is put straight into the dialog and never stored here.
        setSent(await offersApi.send(row.id));
        await load();
      } catch (err) {
        setFailure(err?.message ?? "That offer could not be sent.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const columns = useMemo(
    () => [
      {
        header: "Candidate",
        className: CELL + " font-semibold text-slate-900",
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-col">
            <span>{row.candidateName ?? "—"}</span>
            <span className="text-[11px] font-normal text-slate-500">{row.requisitionTitle}</span>
          </div>
        ),
      },
      {
        header: "Designation",
        className: CELL + " w-[180px] text-xs text-slate-600",
        headerClassName: HEAD,
        cell: (row) => row.designation,
      },
      {
        header: "CTC",
        className: CELL + " w-[140px] text-right text-xs tabular-nums font-semibold",
        headerClassName: HEAD + " text-right",
        cell: (row) => formatCtc(row.ctc),
      },
      {
        header: "Joining",
        className: CELL + " w-[130px] text-xs text-slate-600 tabular-nums",
        headerClassName: HEAD,
        cell: (row) => formatDay(row.joiningDate),
      },
      {
        header: "State",
        className: CELL + " w-[150px]",
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-col gap-1">
            <Badge variant={OFFER_STATE_TONES[row.state] ?? "neutral"}>
              {STATE_LABELS[row.state] ?? row.state}
            </Badge>
            {row.state === "sent" && row.expiresAt && (
              <span className="text-[10.5px] text-slate-500">
                Link expires {formatDay(row.expiresAt)}
              </span>
            )}
            {row.state === "accepted" && row.signature?.name && (
              <span className="text-[10.5px] text-slate-500">
                Signed by {row.signature.name}
              </span>
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
        className: CELL + " w-[120px]",
        headerClassName: HEAD,
        cell: (row) =>
          row.state === "draft" ? (
            <Button
              size="xs"
              variant="primary"
              loading={busy === row.id}
              onClick={() => send(row)}
            >
              <Send size={11} className="mr-1" />
              Send
            </Button>
          ) : null,
      },
    ],
    [busy, send],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          <Plus size={14} className="mr-1.5" />
          Draft an offer
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
        emptyTitle="No offers yet"
        emptyDescription="Draft one for a candidate who has reached the offer stage."
      />

      <OfferDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          load();
        }}
      />

      <OfferLinkDialog offer={sent} onClose={() => setSent(null)} />
    </div>
  );
}

function OfferDrawer({ open, onClose, onSaved }) {
  const [applications, setApplications] = useState([]);
  const [values, setValues] = useState({
    applicationId: null,
    ctc: "",
    joiningDate: "",
    designation: "",
    negotiationNotes: "",
  });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({
      applicationId: null,
      ctc: "",
      joiningDate: "",
      designation: "",
      negotiationNotes: "",
    });
    setErrors({});
    setFailure(null);
    applicationsApi
      .list({ page: 1, pageSize: 200, stage: "offer" })
      .then((res) => setApplications(res?.data ?? []))
      .catch(() => setFailure("The application list could not be loaded."));
  }, [open]);

  const set = (key) => (event) => {
    setValues((v) => ({ ...v, [key]: event.target.value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const dto = {
      applicationId: values.applicationId,
      ctc: values.ctc,
      joiningDate: values.joiningDate,
      designation: values.designation,
      negotiationNotes: values.negotiationNotes || undefined,
    };

    const parsed = createOfferSchema.safeParse(dto);
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
      await offersApi.create(parsed.data);
      onSaved();
    } catch (err) {
      setFailure(err?.message ?? "That offer could not be saved.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <Drawer isOpen onClose={onClose} title="Draft an offer" maxWidth="max-w-xl">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <SearchableSelect
          label="Application"
          value={values.applicationId}
          onChange={(v) => {
            setValues((prev) => ({ ...prev, applicationId: v }));
            setErrors((e) => ({ ...e, applicationId: undefined }));
          }}
          options={applications.map((a) => ({
            value: a.id,
            label: `${a.candidateName} — ${a.requisitionTitle}`,
            hint: STAGE_LABELS[a.stage] ?? a.stage,
          }))}
          placeholder="A candidate at the offer stage"
          error={errors.applicationId}
        />

        <Input
          label="Designation"
          aria-label="Designation"
          value={values.designation}
          onChange={set("designation")}
          error={errors.designation}
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Annual CTC"
            aria-label="Annual CTC"
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

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="offer-notes" className="text-xs font-semibold text-slate-700">
            Negotiation notes
          </label>
          <textarea
            id="offer-notes"
            rows={3}
            value={values.negotiationNotes}
            onChange={set("negotiationNotes")}
            placeholder="Counter-offers, approvals, anything internal."
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none placeholder-slate-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          <span className="text-xs text-slate-500">
            Internal only — deliberately withheld from the page the candidate sees.
          </span>
        </div>

        <p className="text-[11px] text-slate-500">
          Saved as a draft. Sending is a separate step, and is what mints the candidate&apos;s link.
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
            Save draft
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/**
 * The one and only time the candidate's link is visible.
 *
 * No auto-dismiss, and the close button says what closing costs — because the
 * token cannot be shown again and the recruiter has no other way to deliver it.
 */
function OfferLinkDialog({ offer, onClose }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [offer]);

  if (!offer) return null;

  const url =
    typeof window === "undefined"
      ? offer.candidatePath
      : `${window.location.origin}${offer.candidatePath}`;

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the link is on screen and selectable.
      setCopied(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Offer sent — copy the link now" size="md">
      <div className="flex flex-col gap-4">
        <div className="flex gap-2.5 p-3 bg-warning-50 border border-warning-200 rounded-lg">
          <ShieldAlert size={16} className="shrink-0 mt-0.5 text-warning-600" />
          <p className="text-xs text-warning-600 leading-relaxed">
            This link is shown <strong>once</strong>. It is stored only as a hash, so it cannot be
            retrieved again — if it is lost, the offer has to be drafted and sent afresh. Send it to{" "}
            <strong>{offer.candidateEmail}</strong> and nobody else.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="offer-link" className="text-xs font-semibold text-slate-700">
            Candidate link
          </label>
          <div className="flex gap-2">
            <input
              id="offer-link"
              readOnly
              value={url}
              onFocus={(e) => e.target.select()}
              className="flex-1 px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg text-slate-800 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            />
            <Button type="button" variant="outline" onClick={copy}>
              {copied ? (
                <>
                  <Check size={13} className="mr-1" />
                  Copied
                </>
              ) : (
                <>
                  <Copy size={13} className="mr-1" />
                  Copy
                </>
              )}
            </Button>
          </div>
          <span className="text-xs text-slate-500">
            Valid for {OFFER_TOKEN_TTL_DAYS} days, and spent the moment the candidate accepts or
            declines.
          </span>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs">
          <dt className="text-slate-500">Candidate</dt>
          <dd className="font-semibold text-slate-900">{offer.candidateName}</dd>
          <dt className="text-slate-500">Designation</dt>
          <dd className="font-semibold text-slate-900">{offer.designation}</dd>
          <dt className="text-slate-500">CTC</dt>
          <dd className="font-semibold text-slate-900 tabular-nums">{formatCtc(offer.ctc)}</dd>
          <dt className="text-slate-500">Joining</dt>
          <dd className="font-semibold text-slate-900 tabular-nums">
            {formatDay(offer.joiningDate)}
          </dd>
        </dl>

        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            I have copied the link
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default OffersTab;
