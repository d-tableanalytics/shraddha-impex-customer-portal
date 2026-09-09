import { readHistoryReportConfig } from '../../config/historyReport.js';
import {
  claimReportRun, describeRefusal, sendReportWithRetries, alertReportFailure, listRunsOfType,
} from '../../utils/reportRun.js';
import { gatherHistoryReport, periodFor } from './historyReport.service.js';
import { buildHistoryXlsx, buildHistoryPdf, buildHistoryEmail } from './historyReport.render.js';

/**
 * The weekly Booking & Indent History report, end to end.
 *
 *   claim the period → gather → render → email → record the outcome
 *
 * THE CLAIM COMES FIRST. Every attempt at a given period derives the same
 * `runKey` from the period's dates, and claiming is an INSERT of that key
 * against a unique index — so a restart across the scheduled minute, a deploy
 * landing on it, or an operator running the script the same morning all lose on
 * the index rather than sending a second copy. The mechanics are in
 * utils/reportRun.js, shared with the inventory report.
 *
 * NOTHING HERE THROWS AT ITS CALLER. The cron has nobody to catch for it, and an
 * unhandled rejection in a detached job takes the whole process down under this
 * app's `unhandledRejection` handler — a failed spreadsheet would restart the
 * portal. Every path returns a result object instead, and every failure is on
 * the run record as well as in the log.
 */

const TAG = '[HistoryReport]';
export const REPORT_TYPE = 'weekly-booking-indent-history';

export const runWeeklyHistoryReport = async ({
  now = new Date(),
  trigger = 'schedule',
  triggeredBy = null,
  force = false,
  config = readHistoryReportConfig(),
} = {}) => {
  const started = Date.now();

  if (config.problems.length) {
    // Refusing to run on a bad configuration is the point of validating it; the
    // alternative is a run that fails halfway and leaves a half-written record.
    console.error(`${TAG} Refusing to run — configuration is invalid:`);
    for (const p of config.problems) console.error(`${TAG}   • ${p}`);
    return { ok: false, status: 'Failed', reason: 'invalid-config', errors: config.problems };
  }

  // The period is worked out BEFORE the claim and the rows are read after it:
  // gathering first would have every racing process query a week of orders only
  // to discover the period had already been claimed.
  const period = periodFor(now, config.timezone, config.days);

  const runKey = `${REPORT_TYPE}:${period.label}`;

  let claim;
  try {
    claim = await claimReportRun({
      reportType: REPORT_TYPE, runKey, periodLabel: period.label, trigger, triggeredBy, force,
    });
  } catch (error) {
    console.error(`${TAG} Could not claim ${runKey}: ${error.message}`);
    return { ok: false, status: 'Failed', reason: 'claim-failed', runKey, errors: [error.message] };
  }

  if (!claim.claimed) {
    // Not an error. This is the guard doing its job, and saying so plainly is
    // what makes the log readable when a restart lands on the scheduled minute.
    console.log(`${TAG} ${period.label} not run — ${describeRefusal(claim)}.`);
    return { ok: true, status: 'Skipped', reason: claim.reason, runKey, run: claim.run };
  }

  const { run } = claim;
  console.log(`${TAG} ${period.label} starting (${trigger}${claim.retry ? ', retry' : ''}).`);

  try {
    // ── Gather ────────────────────────────────────────────────────────────
    const report = await gatherHistoryReport({
      now, timezone: config.timezone, days: config.days,
    });

    run.metrics = report.summary;
    console.log(
      `${TAG} ${period.label}: ${report.summary.bookings} booking(s) / `
      + `${report.summary.bookingLines} line(s), ${report.summary.indents} indent(s) / `
      + `${report.summary.indentLines} line(s), ${report.summary.customers} customer(s).`,
    );

    // ── Render ────────────────────────────────────────────────────────────
    // A QUIET WEEK STILL GETS A REPORT. An empty period is information — it says
    // nothing was booked — and skipping the send would leave the recipient
    // unable to tell "nothing happened" from "the job is broken", which is the
    // failure mode a weekly report exists to rule out.
    //
    // One format failing does not sink the run: a PDF that will not draw is no
    // reason to withhold the spreadsheet, and the email says what it has.
    const attachments = [];
    for (const format of config.formats) {
      try {
        const built = format === 'xlsx'
          ? await buildHistoryXlsx(report)
          : await buildHistoryPdf(report, { maxRows: config.pdfMaxRows });
        attachments.push(built);
      } catch (error) {
        const message = `Could not generate the ${format.toUpperCase()}: ${error.message}`;
        console.error(`${TAG} ${message}`);
        run.failures.push(message);
      }
    }

    if (attachments.length === 0) {
      throw new Error(`No attachment could be generated in ${config.formats.join(' or ')} format.`);
    }

    run.attachments = attachments.map((a) => ({
      fileName: a.fileName, format: a.format, bytes: a.content.length,
    }));

    // ── Send ──────────────────────────────────────────────────────────────
    const subject = `Weekly Booking & Indent History – ${report.period.title}`;

    run.recipients = [config.to];
    run.cc = config.cc;

    const delivery = await sendReportWithRetries({
      to: config.to,
      cc: config.cc,
      subject,
      html: buildHistoryEmail(report, attachments),
      attachments: attachments.map((a) => ({
        filename: a.fileName, content: a.content, contentType: a.contentType,
      })),
      maxAttempts: config.maxEmailAttempts,
      run,
      tag: TAG,
    });

    run.durationMs = Date.now() - started;
    run.finishedAt = new Date();

    if (!delivery.sent) {
      run.status = 'Failed';
      await run.save();
      console.error(`${TAG} ${period.label} FAILED after ${delivery.attempts} send attempt(s).`);
      await alertReportFailure({
        alertTo: config.alertTo,
        subject: `ACTION NEEDED: weekly booking & indent report failed — ${period.label}`,
        reportName: 'weekly Booking & Indent History report',
        periodLabel: period.label,
        retryCommand: 'node scripts/send-history-report.js --force',
        errors: run.failures,
        tag: TAG,
      });
      return {
        ok: false, status: 'Failed', reason: 'email-failed', runKey,
        summary: report.summary, errors: run.failures,
      };
    }

    run.status = 'Completed';
    run.emailedAt = new Date();
    await run.save();

    console.log(
      `${TAG} ${period.label} sent to ${config.to}`
      + `${config.cc.length ? ` (cc ${config.cc.join(', ')})` : ''} — `
      + `${attachments.map((a) => `${a.fileName} ${Math.round(a.content.length / 1024)}KB`).join(', ')}`
      + ` in ${(run.durationMs / 1000).toFixed(1)}s.`,
    );

    return {
      ok: true, status: 'Completed', runKey,
      summary: report.summary,
      attachments: run.attachments,
    };
  } catch (error) {
    // Anything the steps above did not handle themselves: a database that went
    // away, a rendering library throwing, a bug. Recorded, alerted, and NOT
    // rethrown — see the note at the top about unhandledRejection.
    const message = error?.message || String(error);
    console.error(`${TAG} ${period.label} failed: ${message}`);
    run.failures.push(message);
    run.status = 'Failed';
    run.finishedAt = new Date();
    run.durationMs = Date.now() - started;
    await run.save().catch((e) => console.error(`${TAG} Could not even record the failure: ${e.message}`));
    await alertReportFailure({
      alertTo: config.alertTo,
      subject: `ACTION NEEDED: weekly booking & indent report failed — ${period.label}`,
      reportName: 'weekly Booking & Indent History report',
      periodLabel: period.label,
      retryCommand: 'node scripts/send-history-report.js --force',
      errors: run.failures,
      tag: TAG,
    });
    return { ok: false, status: 'Failed', reason: 'error', runKey, errors: run.failures };
  }
};

/** The most recent runs, newest first — for the log and for a retry decision. */
export const listHistoryReportRuns = async ({ limit = 20 } = {}) =>
  listRunsOfType(REPORT_TYPE, { limit });

export default { runWeeklyHistoryReport, listHistoryReportRuns, REPORT_TYPE };
