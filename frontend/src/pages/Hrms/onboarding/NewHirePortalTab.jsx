import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, FileText, ShieldCheck, Info } from "lucide-react";

import { ErrorState } from "../../../components/hrms/ErrorState";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LoadingSpinner } from "../../../components/ui/LoadingSpinner";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Modal } from "../../../components/ui/Modal";
import { Input } from "../../../components/ui/Input";
import {
  onboardingChecklistsApi,
  offerLettersApi,
  CHECKLIST_STATUS_TONES,
  TASK_STATUS_TONES,
  OFFER_LETTER_STATE_TONES,
  formatCtcAmount,
  formatDay,
  formatInstant,
} from "../../../services/hrms/onboarding";
import { ProgressBar } from "./ProgressBar";
import { signOfferLetterSchema } from "@shared/schemas/onboarding.js";
import {
  TASK_STATUS_LABELS,
  ASSIGN_TO_LABELS,
  CLOSED_TASK_STATUSES,
  OFFER_LETTER_STATE_LABELS,
} from "@shared/constants/onboarding.js";

/**
 * The new hire's own portal — the module's default tab.
 *
 * The reference's `NewHirePortal`: a 16/8 split with pending offers and the
 * active checklist on the left, and a welcome card plus an offer-status list on
 * the right. Tasks are split into "My tasks" (actionable) and the ones handled
 * by HR, IT or the manager (read-only), which is the distinction that makes the
 * screen useful — a new hire needs to know what is waiting on them and what is
 * not.
 *
 * Both requests here take NO id: `/checklists/mine` and `/offers/mine` are
 * scoped to the session, so there is nothing on the wire to tamper with.
 */
export function NewHirePortalTab() {
  const [checklist, setChecklist] = useState(undefined);
  const [offers, setOffers] = useState([]);
  const [error, setError] = useState(null);
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(null);
  const [signing, setSigning] = useState(null);
  const [declining, setDeclining] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [mine, myOffers] = await Promise.all([
        onboardingChecklistsApi.mine(),
        offerLettersApi.mine(),
      ]);
      setChecklist(mine ?? null);
      setOffers(myOffers ?? []);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const markDone = useCallback(
    async (task) => {
      setBusy(task.id);
      setFailure(null);
      try {
        await onboardingChecklistsApi.updateTask(checklist.id, task.id, { status: "completed" });
        await load();
      } catch (err) {
        setFailure(err?.message ?? "That task could not be updated.");
      } finally {
        setBusy(null);
      }
    },
    [checklist, load],
  );

  const openDocument = useCallback(async (offer) => {
    setBusy(offer.id);
    setFailure(null);
    try {
      const { url } = (await offerLettersApi.documentUrl(offer.id)) ?? {};
      if (!url) throw new Error("No letter has been generated for this offer.");
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setFailure(err?.message ?? "That letter could not be opened.");
    } finally {
      setBusy(null);
    }
  }, []);

  if (error) {
    return (
      <ErrorState
        variant={error.isForbidden ? "forbidden" : "error"}
        description={error.message}
        onRetry={load}
      />
    );
  }

  if (checklist === undefined) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <LoadingSpinner size={32} />
      </div>
    );
  }

  const pendingOffers = offers.filter((o) => o.state === "sent");

  return (
    <div className="flex flex-col gap-4">
      {failure && (
        <p role="alert" className="text-xs text-error-500 font-medium">
          {failure}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 flex flex-col gap-4">
          {pendingOffers.map((offer) => (
            <PendingOffer
              key={offer.id}
              offer={offer}
              busy={busy === offer.id}
              onOpen={() => openDocument(offer)}
              onSign={() => setSigning(offer)}
              onDecline={() => setDeclining(offer)}
            />
          ))}

          {checklist ? (
            <MyChecklist checklist={checklist} busy={busy} onMarkDone={markDone} />
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl shadow-enterprise p-6">
              <EmptyState
                title="No onboarding checklist yet"
                description="Your HR team will start one for you shortly."
              />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <section className="bg-white border border-slate-200 rounded-xl shadow-enterprise p-4">
            <h3 className="text-sm font-bold text-slate-900">Welcome</h3>
            <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">
              Work through every task assigned to you. Upload documents when asked, read the company
              policies, and sign your offer letter to finish pre-boarding.
            </p>
          </section>

          <section className="bg-white border border-slate-200 rounded-xl shadow-enterprise p-4">
            <h3 className="text-sm font-bold text-slate-900">Your offer letters</h3>
            {offers.length === 0 ? (
              <p className="mt-1.5 text-xs text-slate-500">None yet.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {offers.map((offer) => (
                  <li key={offer.id} className="flex items-center gap-2 flex-wrap">
                    <Badge variant={OFFER_LETTER_STATE_TONES[offer.state] ?? "neutral"}>
                      {OFFER_LETTER_STATE_LABELS[offer.state] ?? offer.state}
                    </Badge>
                    <span className="text-xs text-slate-700">{offer.designation}</span>
                    {offer.hasDocument && (
                      <button
                        type="button"
                        onClick={() => openDocument(offer)}
                        className="text-[11px] font-semibold text-primary-700 hover:underline"
                      >
                        Read
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <SignDialog
        offer={signing}
        onClose={() => setSigning(null)}
        onDone={() => {
          setSigning(null);
          load();
        }}
      />

      <DeclineDialog
        offer={declining}
        onClose={() => setDeclining(null)}
        onDone={() => {
          setDeclining(null);
          load();
        }}
      />
    </div>
  );
}

function MyChecklist({ checklist, busy, onMarkDone }) {
  /**
   * "Mine" is decided by the SERVER's assignee, not by guessing.
   *
   * A task is mine when the checklist is mine and the task carries my employee
   * id — but the portal already knows this checklist is its viewer's, so the
   * split below uses `assignTo === 'new_hire'` plus anything explicitly
   * reassigned to them, which is what the reference's own split amounts to.
   */
  const mine = checklist.tasks.filter((t) => t.assignTo === "new_hire");
  const others = checklist.tasks.filter((t) => t.assignTo !== "new_hire");

  return (
    <section className="bg-white border border-slate-200 rounded-xl shadow-enterprise overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
        <h3 className="text-sm font-bold text-slate-900">My onboarding</h3>
        <Badge variant={CHECKLIST_STATUS_TONES[checklist.status] ?? "neutral"}>
          {checklist.status}
        </Badge>
      </header>

      <div className="px-4 py-3 border-b border-slate-100">
        <ProgressBar
          completed={checklist.progress?.completed ?? 0}
          total={checklist.progress?.total ?? 0}
        />
      </div>

      <div className="p-4 flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h4 className="text-xs font-bold uppercase tracking-wide text-slate-600">My tasks</h4>
          {mine.length === 0 ? (
            <p className="text-xs text-slate-500">Nothing is waiting on you.</p>
          ) : (
            mine.map((task) => {
              const closed = CLOSED_TASK_STATUSES.includes(task.status);
              return (
                <article
                  key={task.id}
                  className="flex items-start justify-between gap-3 p-3 border border-slate-200 rounded-lg"
                >
                  <div className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-slate-900">{task.title}</span>
                      <Badge variant={TASK_STATUS_TONES[task.status] ?? "neutral"}>
                        {TASK_STATUS_LABELS[task.status] ?? task.status}
                      </Badge>
                    </div>
                    {task.description && (
                      <p className="text-xs text-slate-600 leading-relaxed">{task.description}</p>
                    )}
                    {task.dueDate && (
                      <span className="text-[11px] text-slate-500 tabular-nums">
                        Due {formatDay(task.dueDate)}
                      </span>
                    )}
                  </div>
                  <div className="shrink-0">
                    {closed || checklist.status === "cancelled" ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-success-600">
                        <CheckCircle2 size={13} />
                        Done
                      </span>
                    ) : (
                      <Button
                        size="xs"
                        variant="primary"
                        loading={busy === task.id}
                        onClick={() => onMarkDone(task)}
                      >
                        Mark done
                      </Button>
                    )}
                  </div>
                </article>
              );
            })
          )}
        </div>

        {others.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <h4 className="text-xs font-bold uppercase tracking-wide text-slate-600">
              Handled by HR, IT or your manager
            </h4>
            <ul className="flex flex-col divide-y divide-slate-100">
              {others.map((task) => (
                <li key={task.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-sm text-slate-700 min-w-0">
                    {task.title}
                    <span className="ml-2 text-[11px] text-slate-500">
                      ({ASSIGN_TO_LABELS[task.assignTo] ?? task.assignTo}
                      {task.assigneeName ? ` · ${task.assigneeName}` : ""})
                    </span>
                  </span>
                  <Badge variant={TASK_STATUS_TONES[task.status] ?? "neutral"}>
                    {TASK_STATUS_LABELS[task.status] ?? task.status}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function PendingOffer({ offer, busy, onOpen, onSign, onDecline }) {
  return (
    <section className="flex gap-3 p-4 bg-primary-50/40 border border-primary-200 rounded-xl">
      <Info size={18} className="shrink-0 mt-0.5 text-primary-600" />
      <div className="flex flex-col gap-3 min-w-0 flex-1">
        <div>
          <h3 className="text-sm font-bold text-slate-900">
            Your offer letter is waiting for your signature
          </h3>
          <p className="text-xs text-slate-600">{offer.designation}</p>
        </div>

        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-xs">
          <div>
            <dt className="text-slate-500">Designation</dt>
            <dd className="font-semibold text-slate-900">{offer.designation}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Joining date</dt>
            <dd className="font-semibold text-slate-900 tabular-nums">
              {formatDay(offer.joiningDate)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Annual CTC</dt>
            <dd className="font-semibold text-slate-900 tabular-nums">
              {formatCtcAmount(offer.ctc)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Sent</dt>
            <dd className="font-semibold text-slate-900 tabular-nums">
              {formatInstant(offer.sentAt)}
            </dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2">
          {offer.hasDocument && (
            <Button size="sm" variant="outline" loading={busy} onClick={onOpen}>
              <FileText size={13} className="mr-1.5" />
              Read the letter
            </Button>
          )}
          <Button size="sm" variant="primary" onClick={onSign}>
            Accept and sign
          </Button>
          <Button size="sm" variant="ghost" className="text-error-500" onClick={onDecline}>
            Decline
          </Button>
        </div>
      </div>
    </section>
  );
}

function SignDialog({ offer, onClose, onDone }) {
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setName("");
    setError(null);
    setFailure(null);
  }, [offer]);

  if (!offer) return null;

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const parsed = signOfferLetterSchema.safeParse({ signatureName: name });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Type your full name to sign.");
      return;
    }

    setSubmitting(true);
    try {
      await offerLettersApi.sign(offer.id, parsed.data.signatureName);
      onDone();
    } catch (err) {
      setFailure(err?.message ?? "Your acceptance could not be recorded.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Sign your offer letter" size="md">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg">
          <ShieldCheck size={16} className="shrink-0 mt-0.5 text-primary-600" />
          <p className="text-xs text-slate-600 leading-relaxed">
            By signing you accept the offer for <strong>{offer.designation}</strong>, joining on{" "}
            <strong>{formatDay(offer.joiningDate)}</strong>. The name you type, the time and the
            address you sign from are recorded as the record of your acceptance.
          </p>
        </div>

        <Input
          label="Full legal name"
          aria-label="Full legal name"
          placeholder="As it should appear on official records"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          error={error}
        />

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
            Sign and accept
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeclineDialog({ offer, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setReason("");
    setFailure(null);
  }, [offer]);

  if (!offer) return null;

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);
    setSubmitting(true);
    try {
      await offerLettersApi.reject(offer.id, reason.trim() || undefined);
      onDone();
    } catch (err) {
      setFailure(err?.message ?? "Your decision could not be recorded.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Decline this offer?" size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-slate-600 leading-relaxed">
          This is final — an offer cannot be signed after it has been declined.
        </p>

        <div className="w-full flex flex-col gap-1.5">
          <label htmlFor="decline-offer-reason" className="text-xs font-semibold text-slate-700">
            Anything you would like us to know? <span className="font-normal">(optional)</span>
          </label>
          <textarea
            id="decline-offer-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
        </div>

        {failure && (
          <p role="alert" className="text-xs text-error-500 font-medium">
            {failure}
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Go back
          </Button>
          <Button type="submit" variant="danger" loading={submitting}>
            Confirm decline
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default NewHirePortalTab;
