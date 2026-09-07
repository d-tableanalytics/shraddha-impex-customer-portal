import { useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Pencil } from "lucide-react";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { Button } from "../../../components/ui/Button";
import { MyAttendanceTab } from "./MyAttendanceTab";
import { TeamAttendanceTab } from "./TeamAttendanceTab";
import { CorrectionsTab } from "./CorrectionsTab";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Attendance.
 *
 * ---------------------------------------------------------------------------
 * The reference's page shell
 * ---------------------------------------------------------------------------
 * A title on the left with a "Request correction" button on the right, then the
 * tab strip, then the tab (`AttendancePage.tsx:56-70`). No description line —
 * the reference has none, and the extra sentence pushed the clock card an
 * entire row further down the page.
 *
 * The header button is the reference's, and so is the block button under the
 * clock card: it genuinely has both, one as a shortcut from anywhere on the
 * page and one beside the card it relates to.
 *
 * ---------------------------------------------------------------------------
 * The tab lives in the URL
 * ---------------------------------------------------------------------------
 * The reference keeps it in `useState`, so a refresh drops a manager back onto
 * My Attendance and a tab cannot be linked. `/attendance/:tab` fixes all three,
 * and matches how Org Structure and Leave already work here.
 *
 * Which tabs exist depends on the viewer. My Attendance is always present —
 * everyone with the module holds `attendance:view:self` through SELF_BASELINE.
 * Team appears only for someone who can see other people's days. Corrections is
 * always present but changes label, as in the reference, because "Corrections"
 * alone does not tell a manager whose requests they are looking at.
 */
const TAB_KEYS = ["me", "team", "corrections"];

export function AttendancePage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  /**
   * Bumped by the header button to open the correction drawer, which lives
   * inside the My Attendance tab because that is where the record it prefills
   * from is loaded.
   */
  const [drawerSignal, setDrawerSignal] = useState(0);

  const seesTeam = can(M.ATTENDANCE, A.VIEW, S.TEAM) || can(M.ATTENDANCE, A.VIEW, S.ORG);
  const canApprove = can(M.ATTENDANCE, A.APPROVE, S.TEAM) || can(M.ATTENDANCE, A.APPROVE, S.ORG);
  const seesAll = can(M.ATTENDANCE, A.VIEW, S.ORG);

  const tabs = useMemo(() => {
    const items = [{ key: "me", label: "My Attendance" }];
    if (seesTeam) items.push({ key: "team", label: "Team" });
    items.push({
      key: "corrections",
      label: canApprove
        ? "Corrections (approvals)"
        : seesAll
          ? "All corrections"
          : "My corrections",
    });
    return items;
  }, [seesTeam, canApprove, seesAll]);

  /**
   * The landing tab is always "me".
   *
   * Everyone can use it, which is what makes it a safe default — unlike the
   * reference's Org Structure, which defaults non-editors onto a tab whose
   * endpoint then refuses them.
   */
  const active = TAB_KEYS.includes(tab) ? tab : "me";

  if (!tab) return <Navigate to={`${HRMS_ROUTE_PREFIX}/attendance/me`} replace />;

  const requestCorrection = (
    <Button
      variant="outline"
      onClick={() => {
        // From another tab the drawer would have nothing to open onto, so the
        // shortcut lands the user on My Attendance first.
        if (active !== "me") navigate(`${HRMS_ROUTE_PREFIX}/attendance/me`);
        setDrawerSignal((n) => n + 1);
      }}
    >
      <Pencil size={14} className="mr-1.5" />
      Request correction
    </Button>
  );

  return (
    <HrmsPageLayout
      title="Attendance"
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Attendance" },
      ]}
      actions={requestCorrection}
    >
      <TabNav
        tabs={tabs}
        activeKey={active}
        onChange={(key) => navigate(`${HRMS_ROUTE_PREFIX}/attendance/${key}`)}
        className="mb-4"
      />

      {active === "me" && <MyAttendanceTab drawerSignal={drawerSignal} />}

      {/*
        Guarded rather than merely hidden from the tab strip. Reaching /team by
        URL without the grant must not mount the component and fire its request
        first — the redirect below happens before anything is asked for.
      */}
      {active === "team" &&
        (seesTeam ? (
          <TeamAttendanceTab />
        ) : (
          <Navigate to={`${HRMS_ROUTE_PREFIX}/attendance/me`} replace />
        ))}

      {active === "corrections" && <CorrectionsTab canApprove={canApprove} />}
    </HrmsPageLayout>
  );
}

export default AttendancePage;
