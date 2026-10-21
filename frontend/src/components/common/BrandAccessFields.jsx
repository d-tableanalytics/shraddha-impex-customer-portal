import { listBrands, hasBrandFlag } from '../../utils/brandAccess';

/**
 * Brand access on an account — the checkboxes on the Add/Edit user forms and
 * the badges in the users table.
 *
 * Built from the configured brand list (utils/brandAccess.js), never from
 * written-out brand names, so a brand created in Inventory Configuration gets
 * a checkbox here with no change to this screen. Identical in both portals.
 *
 * `value` is the account's brandAccess object, keyed by brand key. A brand
 * missing from it is unticked — no access.
 */

/** { koken: true, bix: true, ... } for every brand — the default for a new account. */
export const allBrandsTicked = () =>
  Object.fromEntries(listBrands().map((b) => [b.key, true]));

export const BrandAccessCheckboxes = ({ value, onChange }) => (
  <div className="flex flex-wrap gap-x-4 gap-y-2">
    {listBrands().map((b) => (
      <label key={b.key} className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
        <input
          type="checkbox"
          checked={hasBrandFlag(value, b.key)}
          onChange={(e) => onChange({ ...(value || {}), [b.key]: e.target.checked })}
          className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
        />
        {b.name}
      </label>
    ))}
  </div>
);

export const BrandAccessBadges = ({ value }) => {
  const held = listBrands().filter((b) => hasBrandFlag(value, b.key));
  if (held.length === 0) {
    return (
      <span className="px-1.5 py-0.5 text-[10px] font-bold bg-red-50 text-red-700 border border-red-200 rounded">None</span>
    );
  }
  return held.map((b) => (
    <span
      key={b.key}
      className="px-1.5 py-0.5 text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200 rounded text-nowrap"
    >
      {b.name}
    </span>
  ));
};

export default { BrandAccessCheckboxes, BrandAccessBadges, allBrandsTicked };
