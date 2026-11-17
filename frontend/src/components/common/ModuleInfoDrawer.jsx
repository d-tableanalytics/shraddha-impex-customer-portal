import { useMemo } from "react";
import {
  BookOpen, ListChecks, Link2, GitBranch, ShieldCheck, Footprints, AlertTriangle,
  HelpCircle, Users, ArrowRight, ArrowLeftRight, Zap, Hand, Archive, Layers,
} from "lucide-react";

import { Drawer } from "../ui/Drawer";
import { Badge } from "../ui/Badge";

/**
 * The "About this module" side panel.
 *
 * Renders one documentation entry (see `moduleInfo/registry.js` for the shape)
 * as the seven sections the ERP documents every screen with: Overview, Key
 * functionalities, Connected modules, Impact of changes, Rules & business
 * logic, Step-by-step guide, Notes & warnings, plus "Requires verification"
 * for anything the audit could not confirm from the code.
 *
 * Pure presentation: it owns no content and no state beyond what the Drawer
 * needs. Badges mark the kinds the brief calls out (automatic update, manual
 * action, historical record unchanged, affects several modules, connected
 * module, important warning) so a reader can scan for them.
 */

const KIND_BADGE = {
  automatic: { label: "Automatic update", variant: "success", Icon: Zap },
  manual: { label: "Manual action required", variant: "warning", Icon: Hand },
  historical: { label: "Historical records unchanged", variant: "neutral", Icon: Archive },
  multi: { label: "Affects several modules", variant: "primary", Icon: Layers },
};

const RULE_KIND = {
  validation: "Validation",
  approval: "Approval",
  stock: "Stock rule",
  expiry: "Expiry / deadline",
  permission: "Permission",
  automation: "Automated process",
};

const KindBadge = ({ kind }) => {
  const def = KIND_BADGE[kind];
  if (!def) return null;
  const { label, variant, Icon } = def;
  return (
    <Badge variant={variant} className="gap-1 whitespace-nowrap">
      <Icon size={11} aria-hidden="true" /> {label}
    </Badge>
  );
};

const VerifyBadge = () => (
  <Badge variant="warning" className="gap-1 whitespace-nowrap" title="The audit could not confirm this from the code">
    <HelpCircle size={11} aria-hidden="true" /> Requires verification
  </Badge>
);

const SectionTitle = ({ id, Icon, children, count }) => (
  <h4 id={id} className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.08em] text-slate-500 scroll-mt-4">
    <Icon size={14} className="text-primary-600" aria-hidden="true" />
    {children}
    {typeof count === "number" && <span className="font-semibold text-slate-400">· {count}</span>}
  </h4>
);

const Section = ({ id, Icon, title, count, children }) => (
  <section aria-labelledby={id} className="flex flex-col gap-3">
    <SectionTitle id={id} Icon={Icon} count={count}>{title}</SectionTitle>
    {children}
  </section>
);

const Empty = ({ children }) => (
  <p className="text-sm text-slate-400 italic">{children}</p>
);

const ItemCard = ({ children, tone = "slate" }) => {
  const tones = {
    slate: "border-slate-200 bg-white",
    amber: "border-amber-200 bg-amber-50/60",
    red: "border-red-200 bg-red-50/60",
  };
  return <div className={`rounded-lg border px-3.5 py-3 ${tones[tone]}`}>{children}</div>;
};

/** The sections present in this entry, for the jump links at the top. */
const sectionsOf = (info) => [
  { id: "mi-overview", label: "Overview", show: true },
  { id: "mi-functions", label: "Key functionalities", show: info.functions?.length > 0 },
  { id: "mi-connections", label: "Connected modules", show: info.connections?.length > 0 },
  { id: "mi-impacts", label: "Impact of changes", show: info.impacts?.length > 0 },
  { id: "mi-rules", label: "Rules", show: info.rules?.length > 0 },
  { id: "mi-steps", label: "How to use", show: info.steps?.length > 0 },
  { id: "mi-warnings", label: "Warnings", show: info.warnings?.length > 0 },
  { id: "mi-unverified", label: "To verify", show: info.unverified?.length > 0 },
].filter((s) => s.show);

export const ModuleInfoDrawer = ({ isOpen, onClose, info }) => {
  const sections = useMemo(() => (info ? sectionsOf(info) : []), [info]);
  if (!info) return null;

  const { overview = {}, functions = [], connections = [], impacts = [], rules = [], steps = [], warnings = [], unverified = [] } = info;

  return (
    <Drawer isOpen={isOpen} onClose={onClose} title={`About: ${info.title}`} maxWidth="max-w-2xl">
      <div className="flex flex-col gap-7" data-testid="module-info-panel">
        {/* Who it is for, and where to jump. */}
        <div className="flex flex-col gap-3">
          {overview.users?.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 mr-1">
                <Users size={12} aria-hidden="true" /> Used by
              </span>
              {overview.users.map((u) => <Badge key={u} variant="neutral">{u}</Badge>)}
            </div>
          )}
          <nav aria-label="Sections" className="flex flex-wrap gap-1.5">
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
                className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600 hover:bg-primary-50 hover:text-primary-700 hover:border-primary-200 transition-colors"
              >
                {s.label}
              </a>
            ))}
          </nav>
        </div>

        {/* A. Overview */}
        <Section id="mi-overview" Icon={BookOpen} title="Overview">
          <p className="text-sm text-slate-800 leading-relaxed">{overview.what}</p>
          {overview.why && (
            <p className="text-sm text-slate-600 leading-relaxed">
              <span className="font-bold text-slate-700">Why it exists: </span>{overview.why}
            </p>
          )}
        </Section>

        {/* B. Key functionalities */}
        {functions.length > 0 && (
          <Section id="mi-functions" Icon={ListChecks} title="Key functionalities" count={functions.length}>
            <ul className="flex flex-col gap-2">
              {functions.map((f) => (
                <li key={f.title} className="text-sm leading-relaxed">
                  <span className="font-bold text-slate-800">{f.title}.</span>{" "}
                  <span className="text-slate-600">{f.detail}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* C. Connected modules & dependencies */}
        {connections.length > 0 && (
          <Section id="mi-connections" Icon={Link2} title="Connected modules & dependencies" count={connections.length}>
            <div className="flex flex-col gap-2">
              {connections.map((c, i) => (
                <ItemCard key={`${c.module}-${i}`}>
                  <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                    <Badge variant="primary" className="gap-1"><Link2 size={11} aria-hidden="true" /> Connected module</Badge>
                    <span className="text-sm font-bold text-slate-800">{c.module}</span>
                    <Badge variant="neutral" className="gap-1">
                      {c.direction === "two-way"
                        ? <><ArrowLeftRight size={11} aria-hidden="true" /> Two-way</>
                        : <><ArrowRight size={11} aria-hidden="true" /> One-way</>}
                    </Badge>
                    {c.verified === false && <VerifyBadge />}
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="font-semibold text-slate-500">Why</dt><dd className="text-slate-700">{c.why}</dd>
                    {c.data && <><dt className="font-semibold text-slate-500">Exchanged</dt><dd className="text-slate-700">{c.data}</dd></>}
                    {c.trigger && <><dt className="font-semibold text-slate-500">Trigger</dt><dd className="text-slate-700">{c.trigger}</dd></>}
                  </dl>
                </ItemCard>
              ))}
            </div>
          </Section>
        )}

        {/* D. Impact of changes */}
        {impacts.length > 0 && (
          <Section id="mi-impacts" Icon={GitBranch} title="Impact of changes" count={impacts.length}>
            <div className="flex flex-col gap-2">
              {impacts.map((im, i) => (
                <ItemCard key={`${im.action}-${i}`}>
                  <div className="flex flex-wrap items-center gap-1.5 mb-1">
                    <span className="text-sm font-bold text-slate-800">{im.action}</span>
                    <KindBadge kind={im.kind} />
                    {im.verified === false && <VerifyBadge />}
                  </div>
                  <p className="text-sm text-slate-700 leading-relaxed">{im.effect}</p>
                </ItemCard>
              ))}
            </div>
          </Section>
        )}

        {/* E. Important rules & business logic */}
        {rules.length > 0 && (
          <Section id="mi-rules" Icon={ShieldCheck} title="Important rules & business logic" count={rules.length}>
            <ul className="flex flex-col gap-2">
              {rules.map((r, i) => (
                <li key={`${r.title}-${i}`} className="flex flex-col gap-0.5 text-sm leading-relaxed">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-bold text-slate-800">{r.title}</span>
                    {RULE_KIND[r.kind] && <Badge variant="neutral">{RULE_KIND[r.kind]}</Badge>}
                    {r.verified === false && <VerifyBadge />}
                  </div>
                  <span className="text-slate-600">{r.detail}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* F. Step-by-step usage guide */}
        {steps.length > 0 && (
          <Section id="mi-steps" Icon={Footprints} title="Step-by-step guide">
            <ol className="flex flex-col gap-2">
              {steps.map((s, i) => (
                <li key={i} className="flex items-start gap-3 text-sm text-slate-700 leading-relaxed">
                  <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-50 text-[11px] font-black text-primary-700 border border-primary-200">
                    {i + 1}
                  </span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          </Section>
        )}

        {/* G. Important notes & warnings */}
        {warnings.length > 0 && (
          <Section id="mi-warnings" Icon={AlertTriangle} title="Important notes & warnings" count={warnings.length}>
            <div className="flex flex-col gap-2">
              {warnings.map((w, i) => (
                <ItemCard key={`${w.title}-${i}`} tone={w.severity === "irreversible" ? "red" : "amber"}>
                  <div className="flex flex-wrap items-center gap-1.5 mb-1">
                    <Badge variant={w.severity === "irreversible" ? "danger" : "warning"} className="gap-1">
                      <AlertTriangle size={11} aria-hidden="true" />
                      {w.severity === "irreversible" ? "Cannot be undone" : "Important warning"}
                    </Badge>
                    <span className="text-sm font-bold text-slate-800">{w.title}</span>
                  </div>
                  <p className="text-sm text-slate-700 leading-relaxed">{w.detail}</p>
                </ItemCard>
              ))}
            </div>
          </Section>
        )}

        {/* Anything the audit could not confirm from the code. */}
        {unverified.length > 0 && (
          <Section id="mi-unverified" Icon={HelpCircle} title="Requires verification" count={unverified.length}>
            <p className="text-xs text-slate-500">
              These points could not be confirmed from the application code and should be checked with the team before relying on them.
            </p>
            <ul className="list-disc pl-5 flex flex-col gap-1">
              {unverified.map((u, i) => <li key={i} className="text-sm text-slate-600">{u}</li>)}
            </ul>
          </Section>
        )}
      </div>
    </Drawer>
  );
};

export default ModuleInfoDrawer;
