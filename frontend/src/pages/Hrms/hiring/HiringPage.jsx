import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { TabNav } from "../../../components/hrms/TabNav";
import { RequisitionsTab } from "./RequisitionsTab";
import { CandidatesTab } from "./CandidatesTab";
import { PipelineTab } from "./PipelineTab";
import { InterviewsTab } from "./InterviewsTab";
import { PostingsTab } from "./PostingsTab";
import { OffersTab } from "./OffersTab";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";

/**
 * Hiring.
 *
 * ---------------------------------------------------------------------------
 * The reference's tab set, in its funnel order
 * ---------------------------------------------------------------------------
 * `HiringPage.tsx:26-42` — Requisitions → Candidates → Pipeline →
 * My interviews → Postings → Offers, left to right along the recruiting
 * funnel, with the recruiter-only tabs gated on `hiring:edit:org` and Pipeline
 * on either view grant.
 *
 * "My interviews" is deliberately visible to everyone who can reach the module.
 * A panellist reaches Hiring on `hiring:view:team` and nothing more — the
 * matrix calls that grant the "interviewer view" — and this tab is the only way
 * they file feedback.
 *
 * Pipeline, though, is gated on `view:org` rather than on either view grant.
 * The board is every applicant for a requisition, which is org-wide data by
 * construction; showing it to a team-scoped grant would hand a panellist the
 * whole funnel because they were once put on a panel.
 *
 * The reference defaults to `pipeline`; here the default is the first tab the
 * viewer can actually use, because a recruiter and a panellist do not have the
 * same first tab and dropping a panellist onto Pipeline shows them a board they
 * cannot open.
 */
const TAB_KEYS = ["requisitions", "candidates", "pipeline", "interviews", "postings", "offers"];

export function HiringPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can } = useHrmsPermissions();

  const isRecruiter = can(M.HIRING, A.EDIT, S.ORG);
  const seesPipeline = can(M.HIRING, A.VIEW, S.ORG);

  const tabs = useMemo(() => {
    const items = [];
    if (isRecruiter) {
      items.push(
        { key: "requisitions", label: "Requisitions" },
        { key: "candidates", label: "Candidates" },
      );
    }
    if (seesPipeline) items.push({ key: "pipeline", label: "Pipeline" });
    items.push({ key: "interviews", label: "My interviews" });
    if (isRecruiter) {
      items.push({ key: "postings", label: "Postings" }, { key: "offers", label: "Offers" });
    }
    return items;
  }, [isRecruiter, seesPipeline]);

  /** The first tab this viewer can use — see the header. */
  const fallback = tabs[0]?.key ?? "interviews";
  const active = TAB_KEYS.includes(tab) ? tab : fallback;

  if (!tab) return <Navigate to={`${HRMS_ROUTE_PREFIX}/hiring/${fallback}`} replace />;

  /**
   * A tab reached by URL without the grant for it.
   *
   * Redirected rather than rendered as a refusal, and — the point of guarding
   * here rather than only in the strip — without the component having mounted
   * and fired its request first.
   */
  const guard = (allowed, element) =>
    allowed ? element : <Navigate to={`${HRMS_ROUTE_PREFIX}/hiring/${fallback}`} replace />;

  return (
    <HrmsPageLayout
      title="Hiring"
      subtitle="Requisitions, the candidate pipeline, interviews with panel feedback, offers, and the public careers page."
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Hiring" },
      ]}
    >
      <TabNav
        tabs={tabs}
        activeKey={active}
        onChange={(key) => navigate(`${HRMS_ROUTE_PREFIX}/hiring/${key}`)}
        className="mb-4"
      />

      {active === "requisitions" && guard(isRecruiter, <RequisitionsTab />)}
      {active === "candidates" && guard(isRecruiter, <CandidatesTab />)}
      {active === "pipeline" && guard(seesPipeline, <PipelineTab canEdit={isRecruiter} />)}
      {active === "interviews" && <InterviewsTab canEdit={isRecruiter} />}
      {active === "postings" && guard(isRecruiter, <PostingsTab />)}
      {active === "offers" && guard(isRecruiter, <OffersTab />)}
    </HrmsPageLayout>
  );
}

export default HiringPage;
