import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { CheckCircle2, Info, ShieldCheck } from "lucide-react";

import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { LoadingSpinner } from "../../components/ui/LoadingSpinner";
import { careersApi } from "../../services/careers";
import { acceptOfferSchema } from "@shared/schemas/hiring.js";

const formatDay = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

const formatCtc = (value) =>
  value === null || value === undefined
    ? "—"
    : `₹ ${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/**
 * The candidate's offer page.
 *
 * ---------------------------------------------------------------------------
 * The token in the URL is the only credential
 * ---------------------------------------------------------------------------
 * There is no session here and no id anywhere in the flow. The path carries a
 * 256-bit token; the server holds only its SHA-256, compares in constant time,
 * expires it, and clears it the moment a decision is recorded.
 *
 * That is a deliberate departure from the reference, whose equivalent page is
 * addressed by the offer's own UUID with no token, no expiry and no rate limit
 * — so anyone holding or guessing one could read a stranger's salary or accept
 * on their behalf.
 *
 * Every failure mode renders the same "not available" panel, because the server
 * answers 404 identically for unknown, malformed, expired and already-used
 * links. Distinguishing them here would put back the oracle the server removed.
 */
export function OfferPage() {
  const { token = "" } = useParams();
  const [offer, setOffer] = useState(null);
  const [error, setError] = useState(null);
  const [decision, setDecision] = useState(null);
  const [outcome, setOutcome] = useState(null);

  useEffect(() => {
    careersApi
      .getOffer(token)
      .then(setOffer)
      .catch((err) => setError(err?.message ?? "This offer is not available."));
  }, [token]);

  if (outcome === "accepted") {
    return (
      <Panel
        icon={<CheckCircle2 size={40} className="mx-auto text-success-600" />}
        title="Offer accepted"
        body="Thank you. HR will be in touch with your joining formalities."
      />
    );
  }

  if (outcome === "rejected") {
    return (
      <Panel
        icon={<Info size={40} className="mx-auto text-slate-400" />}
        title="Offer declined"
        body="Thank you for letting us know. We wish you well."
      />
    );
  }

  if (error) {
    return (
      <Panel
        title="This offer is not available"
        body="The link may have expired, or a decision may already have been recorded. Please contact your recruiter."
      />
    );
  }

  if (!offer) {
    return (
      <div className="flex items-center justify-center py-24">
        <LoadingSpinner size={28} />
      </div>
    );
  }

  // A decision already recorded server-side, arriving with the first load.
  if (offer.state === "accepted") {
    return (
      <Panel
        icon={<CheckCircle2 size={40} className="mx-auto text-success-600" />}
        title="Offer already accepted"
        body="This offer was accepted. HR will be in touch with your joining formalities."
      />
    );
  }
  if (offer.state === "rejected") {
    return (
      <Panel
        icon={<Info size={40} className="mx-auto text-slate-400" />}
        title="Offer already declined"
        body="A decline was recorded against this offer. Please contact your recruiter if that was not you."
      />
    );
  }
  if (offer.state === "expired") {
    return (
      <Panel
        title="This offer link has expired"
        body="Please contact your recruiter, who can send a fresh link."
      />
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-bold text-slate-900">Your offer of employment</h1>
      <p className="mt-1.5 text-sm text-slate-600">
        {offer.candidateName}, here are the terms. Take your time — you can come back to this link
        until {formatDay(offer.expiresAt)}.
      </p>

      <dl className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 p-5 bg-white border border-slate-200 rounded-xl shadow-sm">
        <div>
          <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Role</dt>
          <dd className="mt-0.5 text-sm font-semibold text-slate-900">{offer.requisitionTitle}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
            Designation
          </dt>
          <dd className="mt-0.5 text-sm font-semibold text-slate-900">{offer.designation}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
            Annual CTC
          </dt>
          <dd className="mt-0.5 text-sm font-semibold text-slate-900 tabular-nums">
            {formatCtc(offer.ctc)}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
            Joining date
          </dt>
          <dd className="mt-0.5 text-sm font-semibold text-slate-900 tabular-nums">
            {formatDay(offer.joiningDate)}
          </dd>
        </div>
      </dl>

      <div className="mt-6">
        {decision === null && (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="lg" onClick={() => setDecision("accept")}>
              Accept and sign
            </Button>
            <Button variant="outline" size="lg" onClick={() => setDecision("reject")}>
              Decline
            </Button>
          </div>
        )}

        {decision === "accept" && (
          <AcceptForm
            token={token}
            onBack={() => setDecision(null)}
            onDone={() => setOutcome("accepted")}
          />
        )}

        {decision === "reject" && (
          <DeclineForm
            token={token}
            onBack={() => setDecision(null)}
            onDone={() => setOutcome("rejected")}
          />
        )}
      </div>
    </div>
  );
}

function Panel({ icon, title, body }) {
  return (
    <div className="max-w-xl mx-auto px-6 py-20 text-center">
      {icon}
      <h1 className={`text-xl font-bold text-slate-900 ${icon ? "mt-4" : ""}`}>{title}</h1>
      <p className="mt-2 text-sm text-slate-600 leading-relaxed">{body}</p>
    </div>
  );
}

function AcceptForm({ token, onBack, onDone }) {
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const parsed = acceptOfferSchema.safeParse({ signatureName: name });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Type your full name to sign.");
      return;
    }

    setSubmitting(true);
    try {
      await careersApi.acceptOffer(token, parsed.data);
      onDone();
    } catch (err) {
      setFailure(err?.message ?? "Your acceptance could not be recorded. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-5 bg-white border border-slate-200 rounded-xl shadow-sm">
      <div className="flex gap-2.5">
        <ShieldCheck size={16} className="shrink-0 mt-0.5 text-primary-600" />
        <p className="text-xs text-slate-600 leading-relaxed">
          Typing your full name below records your acceptance of this offer. The name, the time and
          the connection it came from are stored as the record of that acceptance.
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

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={submitting}>
          Sign and accept
        </Button>
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
    </form>
  );
}

function DeclineForm({ token, onBack, onDone }) {
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);
    setSubmitting(true);
    try {
      await careersApi.rejectOffer(token, reason.trim() ? { reason: reason.trim() } : {});
      onDone();
    } catch (err) {
      setFailure(err?.message ?? "Your decision could not be recorded. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-5 bg-white border border-slate-200 rounded-xl shadow-sm">
      <p className="text-sm text-slate-600 leading-relaxed">
        Declining is final — this link stops working once a decision is recorded, and it cannot be
        reversed here.
      </p>

      <div className="w-full flex flex-col gap-1.5">
        <label htmlFor="decline-reason" className="text-xs font-semibold text-slate-700">
          Anything you would like us to know? <span className="font-normal">(optional)</span>
        </label>
        <textarea
          id="decline-reason"
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

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" loading={submitting}>
          Confirm decline
        </Button>
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
    </form>
  );
}

export default OfferPage;
