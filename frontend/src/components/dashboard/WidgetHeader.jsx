import { accentStyle } from './dashboardPalette';

/**
 * The heading every dashboard panel shares: an accent icon chip, the panel's
 * title, an optional one-line explanation, and the panel's own controls on the
 * right. One component so the four panels line up and read as one page.
 */
export const WidgetHeader = ({ icon: Icon, accent = 'primary', title, subtitle, actions, className = '' }) => (
  // Wraps the actions under the title only on phones; from sm up they stay on
  // the title's row and the subtitle gives way (it truncates) instead.
  <div className={`flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap ${className}`}>
    <div className="flex min-w-0 items-center gap-3">
      {Icon && (
        <span
          aria-hidden="true"
          style={accentStyle(accent)}
          className="dash-accent flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-(--dash-accent)/10 text-(--dash-accent) ring-1 ring-inset ring-(--dash-accent)/15"
        >
          <Icon size={18} strokeWidth={2.25} />
        </span>
      )}
      <div className="min-w-0">
        <h3 className="truncate text-[15px] font-bold leading-tight text-slate-800">{title}</h3>
        {subtitle && <p className="mt-0.5 line-clamp-2 text-xs font-medium text-slate-500 sm:line-clamp-1">{subtitle}</p>}
      </div>
    </div>
    {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

export default WidgetHeader;
