import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import { reportsApi } from "../../../services/hrms";
import { ReportCatalogue } from "./ReportCatalogue";
import { ReportViewer } from "./ReportViewer";

/**
 * Reports.
 *
 * The reference's single screen: a catalogue of cards grouped by category, and
 * a detail view for whichever report is selected.
 *
 * One structural change. The reference holds the selection in
 * `useState<ReportDef|null>`, so an open report is not addressable, not
 * linkable, and lost on refresh. Here the key lives in the URL — every other
 * HRMS module in this codebase puts its tab or its record there, and a report
 * someone wants to share is exactly the thing worth a link.
 *
 * The catalogue is loaded once and is the source of the card grid only. What a
 * viewer may actually run is decided by the server on every request, so
 * reaching a report by typing its key is not a way around anything: the
 * per-report permission check runs again on `run` and again on `export`.
 */

export function ReportsPage() {
  const { key } = useParams();
  const navigate = useNavigate();

  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await reportsApi.catalog();
      setCatalog(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setError(err);
      setCatalog([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const open = (reportKey) => navigate(`${HRMS_ROUTE_PREFIX}/reports/${reportKey}`);
  const back = () => navigate(`${HRMS_ROUTE_PREFIX}/reports`);

  return (
    <HrmsPageLayout
      title="Reports"
      subtitle="Built-in reports across employees, attendance and leave. Export any to CSV."
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Reports" },
      ]}
    >
      {key ? (
        <ReportViewer
          reportKey={key}
          catalogEntry={catalog.find((r) => r.key === key) ?? null}
          onBack={back}
        />
      ) : (
        <ReportCatalogue
          reports={catalog}
          loading={loading}
          error={error}
          onRetry={load}
          onSelect={open}
        />
      )}
    </HrmsPageLayout>
  );
}

export default ReportsPage;
