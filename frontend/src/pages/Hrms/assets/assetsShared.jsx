import { Badge } from "../../../components/ui/Badge";
import {
  ASSET_STATUS_LABELS,
  ASSET_REQUEST_STATUS_LABELS,
} from "../../../services/hrms";

/**
 * Small pieces the asset tabs share. Components only.
 */

/** The reference's antd palette, translated: green/blue/orange/default/red. */
const ASSET_STATUS = {
  available: "success",
  assigned: "primary",
  in_repair: "warning",
  retired: "neutral",
  lost: "danger",
};

const REQUEST_STATUS = {
  submitted: "primary",
  approved: "warning",
  rejected: "danger",
  fulfilled: "success",
  cancelled: "neutral",
};

/** Colour is never the only signal — the word is always there too. */
export function AssetStatusBadge({ status }) {
  return (
    <Badge variant={ASSET_STATUS[status] ?? "neutral"}>
      {ASSET_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export function RequestStatusBadge({ status }) {
  return (
    <Badge variant={REQUEST_STATUS[status] ?? "neutral"}>
      {ASSET_REQUEST_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

/**
 * What the asset IS, in one cell.
 *
 * The serial number leads because it is what identifies the physical thing;
 * brand and model sit under it. The reference's My Assets table shows none of
 * this — its assignment payload does not carry the item.
 */
export function AssetIdentity({ serialNumber, brand, model, categoryName }) {
  const makeModel = [brand, model].filter(Boolean).join(" ");
  return (
    <div className="leading-tight">
      <div className="font-mono text-xs text-slate-900">{serialNumber ?? "No serial"}</div>
      <div className="text-xs text-slate-500">
        {[categoryName, makeModel].filter(Boolean).join(" · ") || "—"}
      </div>
    </div>
  );
}

/** A labelled value in the detail grids. */
export function Field({ label, children, wide = false }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children ?? "—"}</dd>
    </div>
  );
}
