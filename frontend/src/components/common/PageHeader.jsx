import React from "react";

/**
 * Page title, optional description, and right-aligned actions.
 *
 * `subtitle` is additive: every existing caller passes only `title` and
 * `actions`, and renders exactly as before. HRMS pages need the second line
 * because the reference's pages carry one — "Multi-tenant, RLS-scoped payroll
 * with statutory compliance…" sits under the Payroll heading — and it is where
 * a screen explains what it is for.
 */
export const PageHeader = ({
  title,
  subtitle,
  actions,
}) => {
  return (
    <div className="flex flex-col md:flex-row md:items-center justify-between pb-5 border-b border-slate-200 gap-4 select-none">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-black text-slate-900">{title}</h1>
        {subtitle && (
          <p className="text-sm text-slate-500 font-medium max-w-2xl leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
};
export default PageHeader;
