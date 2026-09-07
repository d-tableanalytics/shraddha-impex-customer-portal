import { twMerge } from "tailwind-merge";

/**
 * The tab strip used by every multi-view HRMS module.
 *
 * Twelve modules in the reference share one structure: a route of the form
 * `/module/:tab`, tab items assembled at render time and filtered by
 * permission, and `navigate('/module/' + key)` on change. The tab list is
 * role-dependent, so which tabs exist differs per user.
 *
 * The URL carries the tab deliberately - it makes a tab linkable, survives a
 * refresh, and lets the back button work. Local state would lose all three.
 *
 *   <TabNav
 *     tabs={[{ key: 'overview', label: 'Overview' }, ...]}
 *     activeKey={tab}
 *     onChange={(k) => navigate(`/hrms/payroll/${k}`)}
 *   />
 */
export function TabNav({ tabs = [], activeKey, onChange, className }) {
  if (tabs.length === 0) return null;

  return (
    <div
      role="tablist"
      className={twMerge("flex items-center gap-1 border-b border-slate-200 overflow-x-auto", className)}
    >
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={tab.disabled}
            onClick={() => !tab.disabled && onChange?.(tab.key)}
            className={twMerge(
              "relative px-4 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors -mb-px border-b-2",
              active
                ? "text-primary-700 border-primary-600"
                : "text-slate-500 border-transparent hover:text-slate-800 hover:border-slate-300",
              tab.disabled && "opacity-40 cursor-not-allowed hover:text-slate-500 hover:border-transparent",
            )}
          >
            {tab.label}
            {tab.badge !== undefined && tab.badge !== null && (
              <span
                className={twMerge(
                  "ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-bold",
                  active ? "bg-primary-100 text-primary-700" : "bg-slate-100 text-slate-500",
                )}
              >
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default TabNav;
