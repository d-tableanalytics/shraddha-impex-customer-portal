import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { MyTicketsTab } from "./MyTicketsTab";
import { QueueTab } from "./QueueTab";
import { KbTab } from "./KbTab";
import { TicketCategoriesTab } from "./TicketCategoriesTab";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Helpdesk.
 *
 * The reference's `HelpdeskPage` — My Tickets, a resolver Queue, and the
 * Knowledge Base — plus the Categories tab its own model demands and its API
 * never offered, which is why its Raise Ticket form posts `'hr-placeholder'`
 * and fails validation every time.
 *
 * The tab lives in the URL, as it does for every other module here.
 *
 * These gates decide what is OFFERED. Every endpoint behind them re-checks, and
 * the queue is scoped to the categories the viewer actually answers for.
 */

const TAB_KEYS = ["my-tickets", "queue", "kb", "categories"];

export function HelpdeskPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  /**
   * Any resolver team. The reference computes the same union and then uses it
   * as the access rule; here it decides only whether the tab is offered, and
   * the server decides which tickets are in it.
   */
  const isResolver =
    can(M.HELPDESK, A.RESOLVE, S.ORG) ||
    can(M.HELPDESK_HR, A.RESOLVE, S.ORG) ||
    can(M.HELPDESK_PAYROLL, A.RESOLVE, S.ORG) ||
    can(M.HELPDESK_IT, A.RESOLVE, S.ORG);

  /** The catalogue decides which team answers for what — a super-admin call. */
  const isCatalogueAdmin = can(M.HELPDESK, A.RESOLVE, S.ORG);

  const tabs = useMemo(() => {
    const items = [{ key: "my-tickets", label: "My Tickets" }];
    if (isResolver) items.push({ key: "queue", label: "Resolver Queue" });
    items.push({ key: "kb", label: "Knowledge Base" });
    if (isCatalogueAdmin) items.push({ key: "categories", label: "Categories" });
    return items;
  }, [isResolver, isCatalogueAdmin]);

  const active = TAB_KEYS.includes(tab) ? tab : "my-tickets";

  if (!tab) return <Navigate to={`${HRMS_ROUTE_PREFIX}/helpdesk/my-tickets`} replace />;

  return (
    <HrmsPageLayout
      title="Helpdesk"
      subtitle="Raise a ticket with HR, Payroll or IT, follow it through, and search the knowledge base first."
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Helpdesk" },
      ]}
    >
      <TabNav
        tabs={tabs}
        activeKey={active}
        onChange={(key) => navigate(`${HRMS_ROUTE_PREFIX}/helpdesk/${key}`)}
        className="mb-5"
      />

      {active === "my-tickets" && <MyTicketsTab />}
      {active === "queue" && isResolver && <QueueTab />}
      {active === "kb" && <KbTab />}
      {active === "categories" && isCatalogueAdmin && <TicketCategoriesTab />}

      {/*
        A gated tab reached by URL without the grant for it. Rendered as a
        refusal, and — the point of the `&&` guards above — without the tab
        having mounted and fired a request that would only be refused anyway.
      */}
      {((active === "queue" && !isResolver) ||
        (active === "categories" && !isCatalogueAdmin)) && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          You do not have access to this view. The queue is for resolver teams, and the
          category catalogue is managed by a super administrator.
        </p>
      )}
    </HrmsPageLayout>
  );
}

export default HelpdeskPage;
