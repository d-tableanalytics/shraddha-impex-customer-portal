import React from "react";

/**
 * Page title, optional description, and right-aligned actions.
 *
 * `subtitle` is additive: every existing caller passes only `title` and
 * `actions`, and renders exactly as before. HRMS pages need the second line
 * because the reference's pages carry one — "Multi-tenant, RLS-scoped payroll
 * with statutory compliance…" sits under the Payroll heading — and it is where
 * a screen explains what it is for.
 *
 * `eyebrow` is additive in the same way, and exists for a screen that sits
 * INSIDE something — O2D is a workflow within FMS, and a title reading
 * "FMS — Order to Dispatch" makes that one flat name rather than a hierarchy.
 * A caller passing no eyebrow renders exactly as before.
 */
export const PageHeader = ({
  title,
  subtitle,
  eyebrow,
  actions,
}) => {
  return (
    <div className="flex flex-col md:flex-row md:items-center justify-between pb-5 border-b border-slate-200 gap-4 select-none">
      <div className="flex flex-col gap-1">
        {eyebrow && (
          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-slate-400">
            {eyebrow}
          </p>
        )}
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
