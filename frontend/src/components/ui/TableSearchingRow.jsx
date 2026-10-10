import { Loader2 } from "lucide-react";

/**
 * A single full-width row with a spinner, shown while a table's search is
 * still being applied, so the previous query's rows never sit under a new one.
 *
 * RENDERS A <tr>. Like TableSkeleton, it must go inside a <tbody>.
 *
 * @param {number} columns Columns in the real table, so the row spans them all.
 * @param {string} label   Text beside the spinner.
 */
export const TableSearchingRow = ({ columns, label = "Searching..." }) => (
  <tr>
    <td colSpan={columns} className="px-5 py-16">
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col items-center justify-center gap-3 text-slate-500"
      >
        <Loader2 size={28} className="animate-spin text-primary-600" />
        <span className="text-sm font-medium">{label}</span>
      </div>
    </td>
  </tr>
);
