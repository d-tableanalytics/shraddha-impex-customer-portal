import { useState } from "react";
import { useInRouterContext, useLocation } from "react-router-dom";
import { Info, Loader2 } from "lucide-react";
import { twMerge } from "tailwind-merge";

import { resolveModuleInfo, loadModuleInfo } from "../../moduleInfo/registry";
import { ModuleInfoDrawer } from "./ModuleInfoDrawer";

/**
 * The ⓘ beside a page heading: "About this module".
 *
 * Finds the documentation for the screen the user is on (by route, or by an
 * explicit `infoKey`) and opens it in a side panel without leaving the page.
 * Renders NOTHING when no documentation exists for the route, so a screen can
 * never show an icon that opens an empty panel.
 *
 * Whether a screen is documented comes from the small route index; the text
 * itself is fetched on the first click (see moduleInfo/registry.js), so the
 * icon adds nothing measurable to a page that nobody asks about.
 *
 * Mounted by PageHeader for every page that uses it, and placed by hand on the
 * few pages that draw their own heading. Access is not re-checked here: the
 * icon appears only on a page the user has already been allowed to open, and
 * the text describes permissions rather than granting any.
 */

/**
 * Outside a router (a component rendered on its own, as many tests do) there is
 * no current screen to document, so the icon is simply absent rather than an
 * error that takes the whole heading down with it.
 */
export const ModuleInfoButton = (props) => (useInRouterContext() ? <RoutedInfoButton {...props} /> : null);

const RoutedInfoButton = ({ infoKey = null, className = "" }) => {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const row = resolveModuleInfo({ infoKey, pathname });
  if (!row) return null;

  const current = info?.key === row.key ? info : null;

  const show = async () => {
    setOpen(true);
    if (current) return;
    setLoading(true);
    try {
      setInfo(await loadModuleInfo(row.key));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={show}
        title="About this module"
        aria-label={`About this module: ${row.title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="module-info-button"
        className={twMerge(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors "
          + "hover:bg-primary-50 hover:text-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40",
          className,
        )}
      >
        {loading
          ? <Loader2 size={15} className="animate-spin" aria-hidden="true" />
          : <Info size={16} aria-hidden="true" />}
      </button>
      <ModuleInfoDrawer isOpen={open && Boolean(current)} onClose={() => setOpen(false)} info={current} />
    </>
  );
};

export default ModuleInfoButton;
