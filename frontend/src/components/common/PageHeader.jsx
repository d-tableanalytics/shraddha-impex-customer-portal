import React from "react";

import { ModuleInfoButton } from "./ModuleInfoButton";

/**
 * Page title, optional description, and right-aligned actions.
 *
 * `subtitle` is additive: every existing caller passes only `title` and
 * `actions`, and renders exactly as before. HRMS pages need the second line
 * because the reference's pages carry one — "Multi-tenant, RLS-scoped payroll
 * with statutory compliance…" sits under the Payroll heading — and it is where
 * a screen explains what it is for.
 *
 * `back` is additive too: a node rendered ABOVE the title, for a page reached
 * from another screen that should offer the way back to it (for example
 * BackToInventoryMaster). Pages that pass nothing render exactly as before.
 *
 * The ⓘ "About this module" icon sits right after the title on every page
 * that uses this header. It looks its content up by the current route
 * (moduleInfo/registry.js) and renders nothing where none is documented, so
 * no caller needs to opt in; `infoKey` names the entry explicitly for a page
 * whose route alone is ambiguous, and `info={false}` hides it.
 */
export const PageHeader = ({
  title,
  subtitle,
  actions,
  back,
  info = true,
  infoKey,
}) => {
  return (
    <div className="flex flex-col md:flex-row md:items-center justify-between pb-5 border-b border-slate-200 gap-4 select-none">
      <div className="flex flex-col gap-1">
        {back && <div className="-mt-1 mb-0.5">{back}</div>}
        <div className="flex items-center gap-1.5">
          <h1 className="text-xl font-black text-slate-900">{title}</h1>
          {info && <ModuleInfoButton infoKey={infoKey} />}
        </div>
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
