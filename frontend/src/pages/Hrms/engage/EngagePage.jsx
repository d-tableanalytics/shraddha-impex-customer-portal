import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { AnnouncementsTab } from "./AnnouncementsTab";
import { PollsTab } from "./PollsTab";
import { RecognitionTab } from "./RecognitionTab";
import { ENpsTab } from "./ENpsTab";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Engage — company culture and pulse.
 *
 * ---------------------------------------------------------------------------
 * Four tabs, where the reference renders three
 * ---------------------------------------------------------------------------
 * `EngagePage.tsx:20-23` renders Announcements, "Polls & Surveys" and
 * Recognition. Its **eNPS tab is 264 lines of working UI that no file
 * imports** — four endpoints, two tables and a scoring algorithm ship with no
 * way to reach any of them.
 *
 * Building the same thing and leaving it unreachable would reproduce a bug
 * rather than a behaviour, so eNPS is a fourth tab here. Everything it renders
 * comes from the reference's own component.
 *
 * Every tab is visible to everyone — Engage's audience is the whole company and
 * it has no team scope at all. What HR alone gets is the WRITE controls inside
 * each tab, and the aggregated results, which the server enforces either way.
 */
const TAB_KEYS = ["announcements", "polls", "recognition", "enps"];

export function EngagePage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  const canManage = can(M.ENGAGE, A.EDIT, S.ORG);

  const tabs = useMemo(
    () => [
      { key: "announcements", label: "Announcements" },
      { key: "polls", label: "Polls & Surveys" },
      { key: "recognition", label: "Recognition" },
      { key: "enps", label: "eNPS" },
    ],
    [],
  );

  const active = TAB_KEYS.includes(tab) ? tab : "announcements";

  if (!tab) return <Navigate to={`${HRMS_ROUTE_PREFIX}/engage/announcements`} replace />;

  return (
    <HrmsPageLayout
      title="Engage"
      subtitle={
        canManage
          ? "Company announcements, polls, and peer recognition. Manage content from here."
          : "Company announcements, polls, and peer recognition."
      }
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Engage" },
      ]}
    >
      <TabNav
        tabs={tabs}
        activeKey={active}
        onChange={(key) => navigate(`${HRMS_ROUTE_PREFIX}/engage/${key}`)}
        className="mb-4"
      />

      {active === "announcements" && <AnnouncementsTab canManage={canManage} />}
      {active === "polls" && <PollsTab canManage={canManage} />}
      {active === "recognition" && <RecognitionTab canManage={canManage} />}
      {active === "enps" && <ENpsTab canManage={canManage} />}
    </HrmsPageLayout>
  );
}

export default EngagePage;
