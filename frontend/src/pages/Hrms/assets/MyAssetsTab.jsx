import { useCallback, useEffect, useState } from "react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { assetsApi, formatInstant } from "../../../services/hrms";
import { AssetIdentity } from "./assetsShared";
import { Badge } from "../../../components/ui/Badge";

/**
 * What the signed-in employee is holding, and what they have handed back.
 *
 * The reference's `MyAssetsTab` renders two tables whose columns are Assigned /
 * Returned / Assigned by / Condition on assign / Condition on return — and
 * never says WHICH asset, because its assignment payload does not carry the
 * item. The split into current and past is kept; the asset itself is added,
 * as the leading column, because it is the only thing that makes the row mean
 * anything.
 */

export function MyAssetsTab() {
  const [result, setResult] = useState({ data: [], outstanding: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await assetsApi.myAssignments());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = result.data ?? [];
  const current = rows.filter((row) => !row.returnedAt);
  const past = rows.filter((row) => row.returnedAt);

  const assetColumn = {
    header: "Asset",
    className: "w-64",
    cell: (row) => (
      <AssetIdentity
        serialNumber={row.serialNumber}
        brand={row.brand}
        model={row.model}
        categoryName={row.categoryName}
      />
    ),
  };

  const currentColumns = [
    assetColumn,
    { header: "Assigned", className: "w-32", cell: (row) => formatInstant(row.assignedAt) },
    {
      header: "Assigned by",
      className: "w-40",
      cell: (row) => row.assignedByName ?? "—",
    },
    {
      header: "Condition on issue",
      cell: (row) => row.conditionOnAssign ?? <span className="text-slate-400">—</span>,
    },
    {
      header: "",
      className: "w-24",
      cell: () => <Badge variant="primary">In use</Badge>,
    },
  ];

  const pastColumns = [
    assetColumn,
    { header: "Assigned", className: "w-32", cell: (row) => formatInstant(row.assignedAt) },
    { header: "Returned", className: "w-32", cell: (row) => formatInstant(row.returnedAt) },
    {
      header: "Condition on return",
      cell: (row) => row.conditionOnReturn ?? <span className="text-slate-400">—</span>,
    },
    {
      header: "",
      className: "w-28",
      cell: (row) =>
        row.closedByStatus ? (
          <Badge variant="warning">{row.closedByStatus.replace("_", " ")}</Badge>
        ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 text-sm font-semibold text-slate-900">
          Currently assigned to you
          {result.outstanding > 0 && (
            <span className="ml-2 font-normal text-slate-500">
              ({result.outstanding})
            </span>
          )}
        </h3>
        <HrmsDataTable
          columns={currentColumns}
          rows={current}
          loading={loading}
          error={error}
          onRetry={load}
          emptyTitle="No assets assigned to you"
          emptyDescription="Anything IT issues to you will appear here."
        />
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-slate-900">Previously held</h3>
        <HrmsDataTable
          columns={pastColumns}
          rows={past}
          loading={loading}
          emptyTitle="Nothing returned yet"
          emptyDescription="Assets you hand back will be listed here with their condition."
        />
      </section>
    </div>
  );
}

export default MyAssetsTab;
