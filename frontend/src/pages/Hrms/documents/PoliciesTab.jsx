import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Users } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Drawer } from "../../../components/ui/Drawer";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { documentsApi, formatDay } from "../../../services/hrms";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
  HRMS_ROLES as R,
} from "@shared/permissions/constants.js";
import { publishPolicySchema } from "@shared/schemas/document.js";
import {
  DocumentIdentity,
  OpenDocumentButton,
  PolicyStateBadge,
  Field,
} from "./documentsShared";

/**
 * Policies.
 *
 * The reference's `PoliciesTab` — Policy / Effective from / Signature /
 * Acknowledged / Read + Acknowledge, with a publish control for HR.
 *
 * Two differences, both consequences of expiry actually being enforced:
 * expired policies are out of the default list and carry a state of their own,
 * and Acknowledge is not offered on one that has expired or has not yet taken
 * effect. The reference stores `expiresAt` and never reads it, so its
 * Acknowledge button is live forever.
 */

const PAGE_SIZE = 15;

export function PoliciesTab() {
  const { can } = useHrmsPermissions();
  const isHr = can(M.DOCUMENTS, A.EDIT, S.ORG);

  const [page, setPage] = useState(1);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [result, setResult] = useState({ data: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [ackOn, setAckOn] = useState(null);
  const [registerOn, setRegisterOn] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { policiesOnly: "true", page, pageSize: PAGE_SIZE };
      if (includeExpired) params.includeExpired = "true";
      setResult(await documentsApi.list(params));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, includeExpired]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = result.data ?? [];

  const columns = [
    {
      header: "Policy",
      accessorKey: "name",
      cell: (row) => (
        <DocumentIdentity name={row.name} mimeType={row.mimeType} fileSize={row.fileSize} />
      ),
    },
    {
      header: "Effective from",
      className: "w-36",
      cell: (row) => formatDay(row.policy?.effectiveFrom),
    },
    {
      header: "Expires",
      className: "w-32",
      cell: (row) =>
        row.policy?.expiresAt ? (
          formatDay(row.policy.expiresAt)
        ) : (
          <span className="text-slate-400">Never</span>
        ),
    },
    {
      header: "Signature",
      className: "w-32",
      cell: (row) =>
        row.policy?.requiresSignature ? (
          <span className="text-xs text-warning-600">e-sign required</span>
        ) : (
          <span className="text-xs text-slate-500">Acknowledge only</span>
        ),
    },
    {
      header: "Status",
      className: "w-36",
      cell: (row) => (
        <PolicyStateBadge policy={row.policy} acknowledgedByMe={row.acknowledgedByMe} />
      ),
    },
    {
      header: "",
      className: "w-64",
      cell: (row) => (
        <div className="flex justify-end gap-2">
          <OpenDocumentButton documentId={row.id} label="Read" />
          {row.policy?.isLive && !row.acknowledgedByMe && (
            <Button size="xs" onClick={() => setAckOn(row)}>
              Acknowledge
            </Button>
          )}
          {isHr && (
            <Button
              size="xs"
              variant="secondary"
              onClick={() => setRegisterOn(row)}
              title="Who has acknowledged this"
            >
              <Users className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {row.acknowledgmentCount}
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={includeExpired}
            onChange={(e) => {
              setIncludeExpired(e.target.checked);
              setPage(1);
            }}
            className="h-4 w-4 rounded border-slate-300"
          />
          Show expired policies
        </label>
        {isHr && (
          <p className="text-sm text-slate-500">
            Publish a library document as a policy to require acknowledgment.
          </p>
        )}
      </div>

      <HrmsDataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={load}
        page={page}
        pageSize={PAGE_SIZE}
        total={result.total ?? 0}
        onPageChange={setPage}
        emptyTitle="No policies to acknowledge"
        emptyDescription="Policies HR publishes will appear here for you to read and sign."
      />

      {ackOn && (
        <AcknowledgeDrawer
          document={ackOn}
          onClose={() => setAckOn(null)}
          onAcknowledged={() => {
            setAckOn(null);
            load();
          }}
        />
      )}

      {registerOn && (
        <AcknowledgmentRegisterDrawer
          document={registerOn}
          onClose={() => setRegisterOn(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/** Exported so the Library tab can publish a document without duplicating it. */
export function PublishPolicyDrawer({ document, onClose, onPublished }) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    requiresAcknowledgment: true,
    requiresSignature: false,
    effectiveFrom: todayIso,
    expiresAt: "",
    targetRoleKeys: [],
  });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const toggleRole = (role) =>
    setForm((c) => ({
      ...c,
      targetRoleKeys: c.targetRoleKeys.includes(role)
        ? c.targetRoleKeys.filter((r) => r !== role)
        : [...c.targetRoleKeys, role],
    }));

  const submit = async (event) => {
    event.preventDefault();
    const payload = {
      requiresAcknowledgment: form.requiresAcknowledgment,
      requiresSignature: form.requiresSignature,
      effectiveFrom: form.effectiveFrom,
      expiresAt: form.expiresAt || null,
      targetRoleKeys: form.targetRoleKeys,
    };

    const parsed = publishPolicySchema.safeParse(payload);
    if (!parsed.success) {
      const next = {};
      for (const issue of parsed.error.issues) next[issue.path.join(".")] = issue.message;
      setErrors(next);
      return;
    }

    setSaving(true);
    try {
      await documentsApi.publishPolicy(document.id, parsed.data);
      toast.success("Policy published.");
      onPublished?.();
    } catch (err) {
      toast.error(err?.message ?? "That policy could not be published.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen
      onClose={saving ? () => {} : onClose}
      title={`Publish "${document.name}" as a policy`}
      maxWidth="max-w-lg"
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="policy-effective"
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              Effective from
            </label>
            <Input
              id="policy-effective"
              type="date"
              value={form.effectiveFrom}
              onChange={(e) => set({ effectiveFrom: e.target.value })}
            />
            {errors.effectiveFrom && (
              <p className="mt-1 text-xs text-error-600">{errors.effectiveFrom}</p>
            )}
          </div>
          <div>
            <label
              htmlFor="policy-expires"
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              Expires <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <Input
              id="policy-expires"
              type="date"
              value={form.expiresAt}
              min={form.effectiveFrom}
              onChange={(e) => set({ expiresAt: e.target.value })}
            />
            <p className="mt-1 text-xs text-slate-500">
              After this date the policy drops out of the list and can no longer be
              acknowledged.
            </p>
            {errors.expiresAt && (
              <p className="mt-1 text-xs text-error-600">{errors.expiresAt}</p>
            )}
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.requiresSignature}
            onChange={(e) => set({ requiresSignature: e.target.checked })}
            className="mt-0.5 h-4 w-4 rounded border-slate-300"
          />
          <span>
            Require an e-signature
            <span className="block text-xs text-slate-500">
              People type their full name to sign, and may draw a signature.
            </span>
          </span>
        </label>

        <fieldset>
          <legend className="mb-1 text-sm font-medium text-slate-700">Who must acknowledge</legend>
          <p className="mb-2 text-xs text-slate-500">
            Choose nothing to address everyone.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {Object.values(R).map((role) => (
              <label key={role} className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={form.targetRoleKeys.includes(role)}
                  onChange={() => toggleRole(role)}
                  className="h-3.5 w-3.5 rounded border-slate-300"
                />
                {role.replace(/^hrms_/, "").replace(/_/g, " ")}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Publishing…" : "Publish policy"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Acknowledging
// ---------------------------------------------------------------------------

function AcknowledgeDrawer({ document: doc, onClose, onAcknowledged }) {
  const needsSignature = Boolean(doc.policy?.requiresSignature);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const drew = useRef(false);

  const point = (event) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const source = event.touches?.[0] ?? event;
    return {
      x: ((source.clientX - rect.left) / rect.width) * canvas.width,
      y: ((source.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const start = (event) => {
    event.preventDefault();
    drawing.current = true;
    drew.current = true;
    const ctx = canvasRef.current.getContext("2d");
    const { x, y } = point(event);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const move = (event) => {
    if (!drawing.current) return;
    event.preventDefault();
    const ctx = canvasRef.current.getContext("2d");
    const { x, y } = point(event);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#1e293b";
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const end = () => {
    drawing.current = false;
  };

  const clear = () => {
    const canvas = canvasRef.current;
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    drew.current = false;
  };

  const submit = async (event) => {
    event.preventDefault();
    setError(null);

    if (needsSignature && !name.trim()) {
      setError("Type your full name to sign this policy.");
      return;
    }

    const body = {};
    if (needsSignature) {
      body.signatureName = name.trim();
      if (drew.current && canvasRef.current) {
        body.signatureImage = canvasRef.current.toDataURL("image/png");
      }
    }

    setSaving(true);
    try {
      await documentsApi.acknowledge(doc.id, body);
      toast.success("Acknowledged.");
      onAcknowledged?.();
    } catch (err) {
      toast.error(err?.message ?? "That acknowledgment could not be recorded.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen
      onClose={saving ? () => {} : onClose}
      title={`Acknowledge "${doc.name}"`}
      maxWidth="max-w-lg"
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          Read the document before you acknowledge it. Your name, the time and your
          address are recorded against the version in force today.
        </div>

        <OpenDocumentButton documentId={doc.id} label="Read the policy" size="sm" />

        <dl className="grid grid-cols-2 gap-4">
          <Field label="Effective from">{formatDay(doc.policy?.effectiveFrom)}</Field>
          <Field label="Expires">
            {doc.policy?.expiresAt ? formatDay(doc.policy.expiresAt) : "Never"}
          </Field>
        </dl>

        {needsSignature && (
          <>
            <div>
              <label
                htmlFor="signature-name"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                Type your full name to sign
              </label>
              <Input
                id="signature-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your full name"
                maxLength={120}
              />
            </div>

            <div>
              <span className="mb-1 block text-sm font-medium text-slate-700">
                Draw your signature{" "}
                <span className="font-normal text-slate-400">(optional)</span>
              </span>
              <canvas
                ref={canvasRef}
                width={440}
                height={120}
                aria-label="Signature pad"
                className="w-full touch-none rounded-lg border border-dashed border-slate-300 bg-white"
                onMouseDown={start}
                onMouseMove={move}
                onMouseUp={end}
                onMouseLeave={end}
                onTouchStart={start}
                onTouchMove={move}
                onTouchEnd={end}
              />
              <Button type="button" size="xs" variant="ghost" onClick={clear}>
                Clear
              </Button>
            </div>
          </>
        )}

        {error && <p className="text-xs text-error-600">{error}</p>}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Recording…" : "I acknowledge"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

function AcknowledgmentRegisterDrawer({ document: doc, onClose }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    documentsApi
      .acknowledgments(doc.id)
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [doc.id]);

  return (
    <Drawer isOpen onClose={onClose} title={`Who has acknowledged "${doc.name}"`} maxWidth="max-w-lg">
      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : !status ? (
        <p className="text-sm text-slate-500">That register could not be loaded.</p>
      ) : (
        <div className="space-y-5">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
            <span className="font-semibold text-slate-900">
              {status.completed} of {status.total}
            </span>{" "}
            <span className="text-slate-600">people have acknowledged this policy.</span>
          </div>

          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Still outstanding ({status.outstanding.length})
            </h4>
            {status.outstanding.length === 0 ? (
              <p className="text-sm text-success-600">Everyone has acknowledged it.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {status.outstanding.map((person) => (
                  <li key={person.employeeId} className="py-1.5 text-sm text-slate-700">
                    {person.name}
                    {person.employeeCode && (
                      <span className="ml-2 text-xs text-slate-400">{person.employeeCode}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Acknowledged ({status.acknowledged.length})
            </h4>
            <ul className="divide-y divide-slate-100">
              {status.acknowledged.map((person) => (
                <li
                  key={person.employeeId}
                  className="flex items-center justify-between py-1.5 text-sm"
                >
                  <span className="text-slate-700">
                    {person.name}
                    {person.signatureName && (
                      <span className="ml-2 text-xs text-slate-400">
                        signed “{person.signatureName}”
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-slate-500">
                    {formatInstantSafe(person.acknowledgedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Drawer>
  );
}

const formatInstantSafe = (value) => {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : formatDay(d.toISOString().slice(0, 10));
};

export default PoliciesTab;
