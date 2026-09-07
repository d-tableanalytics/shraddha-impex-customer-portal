import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Building2, MapPin, CheckCircle2 } from "lucide-react";

import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { LoadingSpinner } from "../../components/ui/LoadingSpinner";
import { careersApi } from "../../services/careers";
import { publicApplySchema } from "@shared/schemas/hiring.js";

/**
 * One advert, and the form to apply to it.
 *
 * The form posts `publicApplySchema` — deliberately a different schema from the
 * recruiter-facing one, so an anonymous caller cannot set `source` and claim to
 * be a referral, nor reach any field the recruiter owns.
 *
 * A duplicate application gets the same acknowledgement as a first one. The
 * server does that on purpose: telling an anonymous caller "you have already
 * applied" turns the endpoint into an oracle for who has applied where, and the
 * page must not undo it by rendering a different outcome.
 */
export function CareersRolePage() {
  const { slug = "" } = useParams();
  const [role, setRole] = useState(null);
  const [error, setError] = useState(null);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    setRole(null);
    setError(null);
    setApplied(false);
    careersApi
      .getRole(slug)
      .then(setRole)
      .catch((err) =>
        setError(
          err?.isNotFound
            ? "This role is no longer open."
            : err?.message ?? "This role could not be loaded.",
        ),
      );
  }, [slug]);

  if (error) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-20 text-center">
        <h1 className="text-xl font-bold text-slate-900">Role unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">{error}</p>
        <Link
          to="/careers"
          className="mt-5 inline-block text-sm font-semibold text-primary-700 hover:underline"
        >
          ← Browse open roles
        </Link>
      </div>
    );
  }

  if (!role) {
    return (
      <div className="flex items-center justify-center py-24">
        <LoadingSpinner size={28} />
      </div>
    );
  }

  if (applied) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-20 text-center">
        <CheckCircle2 size={40} className="mx-auto text-success-600" />
        <h1 className="mt-4 text-xl font-bold text-slate-900">Application received</h1>
        <p className="mt-2 text-sm text-slate-600">
          Thanks for applying for {role.title}. We will be in touch by email.
        </p>
        <Link
          to="/careers"
          className="mt-5 inline-block text-sm font-semibold text-primary-700 hover:underline"
        >
          Browse more roles
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <Link to="/careers" className="text-xs font-semibold text-slate-500 hover:text-slate-800">
        ← All open roles
      </Link>

      <h1 className="mt-3 text-2xl font-bold text-slate-900">{role.title}</h1>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        {role.departmentName && (
          <span className="inline-flex items-center gap-1">
            <Building2 size={12} />
            {role.departmentName}
          </span>
        )}
        {role.locationName && (
          <span className="inline-flex items-center gap-1">
            <MapPin size={12} />
            {role.locationName}
          </span>
        )}
      </div>

      <article className="mt-6 p-6 bg-white border border-slate-200 rounded-xl shadow-sm">
        <h2 className="text-base font-bold text-slate-900">About the role</h2>
        <p className="mt-2 text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
          {role.description}
        </p>

        <hr className="my-6 border-slate-200" />

        <h2 className="text-base font-bold text-slate-900">What we are looking for</h2>
        <p className="mt-2 text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
          {role.requirements}
        </p>

        <hr className="my-6 border-slate-200" />

        <h2 className="text-base font-bold text-slate-900">Apply</h2>
        <ApplyForm slug={slug} onApplied={() => setApplied(true)} />
      </article>
    </div>
  );
}

const EMPTY = {
  name: "",
  email: "",
  phone: "",
  currentEmployer: "",
  expectedSalary: "",
  noticePeriodDays: "",
};

function ApplyForm({ slug, onApplied }) {
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (key) => (event) => {
    setValues((v) => ({ ...v, [key]: event.target.value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const dto = {
      name: values.name,
      email: values.email,
      phone: values.phone || undefined,
      currentEmployer: values.currentEmployer || undefined,
      expectedSalary: values.expectedSalary || undefined,
      noticePeriodDays: values.noticePeriodDays === "" ? undefined : Number(values.noticePeriodDays),
    };

    const parsed = publicApplySchema.safeParse(dto);
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
      await careersApi.apply(slug, parsed.data);
      onApplied();
    } catch (err) {
      setFailure(
        err?.isThrottled
          ? "Too many attempts from this connection. Please try again in a little while."
          : err?.message ?? "Your application could not be submitted. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          label="Full name"
          aria-label="Full name"
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
          helperText="How we will reach you."
        />
        <Input
          label="Phone"
          aria-label="Phone"
          value={values.phone}
          onChange={set("phone")}
          error={errors.phone}
        />
        <Input
          label="Current employer"
          aria-label="Current employer"
          value={values.currentEmployer}
          onChange={set("currentEmployer")}
          error={errors.currentEmployer}
        />
        <Input
          label="Expected annual CTC"
          aria-label="Expected annual CTC"
          value={values.expectedSalary}
          onChange={set("expectedSalary")}
          error={errors.expectedSalary}
          helperText="Optional"
        />
        <Input
          type="number"
          min={0}
          max={365}
          label="Notice period (days)"
          aria-label="Notice period (days)"
          value={values.noticePeriodDays}
          onChange={set("noticePeriodDays")}
          error={errors.noticePeriodDays}
          helperText="Optional"
        />
      </div>

      {failure && (
        <p role="alert" className="text-xs text-error-500 font-medium">
          {failure}
        </p>
      )}

      <div>
        <Button type="submit" variant="primary" size="lg" loading={submitting}>
          Submit application
        </Button>
      </div>
    </form>
  );
}

export default CareersRolePage;
