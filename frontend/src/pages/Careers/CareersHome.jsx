import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Building2, MapPin } from "lucide-react";

import { LoadingSpinner } from "../../components/ui/LoadingSpinner";
import { careersApi } from "../../services/careers";

/**
 * The public list of open roles.
 *
 * Everything shown here comes from the advert: title, department, location and
 * the description's opening lines. Headcount, budget and the business
 * justification live on the requisition and never cross into the public DTO —
 * see `careers.service.js`.
 */
export function CareersHome() {
  const [roles, setRoles] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    careersApi
      .listRoles()
      .then((data) => setRoles(data ?? []))
      .catch((err) => setError(err?.message ?? "Openings could not be loaded."));
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-bold text-slate-900">Open roles</h1>
      <p className="mt-1.5 text-sm text-slate-600">
        Everything we are hiring for right now. Applying takes a minute and you will hear back by
        email.
      </p>

      <div className="mt-6">
        {error ? (
          <p role="alert" className="text-sm text-error-500 font-medium">
            {error}
          </p>
        ) : roles === null ? (
          <div className="flex items-center justify-center py-16">
            <LoadingSpinner size={28} />
          </div>
        ) : roles.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm font-semibold text-slate-700">No open positions right now.</p>
            <p className="mt-1 text-sm text-slate-500">Do check back — this page is live.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {roles.map((role) => (
              <li key={role.slug}>
                <Link
                  to={`/careers/${role.slug}`}
                  className="block p-4 bg-white border border-slate-200 rounded-xl shadow-sm transition-colors hover:border-primary-300 hover:bg-primary-50/30"
                >
                  <h2 className="text-base font-bold text-slate-900">{role.title}</h2>

                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
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

                  <p className="mt-2.5 text-sm text-slate-600 leading-relaxed line-clamp-3">
                    {role.description}
                  </p>

                  <span className="mt-3 inline-block text-xs font-bold text-primary-700">
                    View &amp; apply →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default CareersHome;
