import ReportRun from '../../models/ReportRun.js';
import { sendEmail } from '../../utils/mailer.js';
import { readInventoryReportConfig } from '../../config/inventoryReport.js';
import { gatherInventoryHealthReport, occurrenceOf } from './inventoryReport.service.js';
import {
  buildInventoryHealthXlsx, buildInventoryHealthPdf, buildInventoryHealthEmail,
} from './inventoryReport.render.js';

/**
 * The weekly inventory health report, end to end.
 *
 *   claim the week → gather → render → email → record the outcome
 *
 * THE CLAIM COMES FIRST, and it is the part worth reading twice. Every attempt
 * at a given week derives the same `runKey`, and claiming is an INSERT of that
 * key against a unique index — so a second attempt loses on the index rather
 * than on a check-then-act two processes can both pass. That is what makes
 * "the same weekly report is not accidentally sent multiple times" a property
 * of the database rather than a hope about timing.
 *
 * There are more ways to get a second attempt than there look to be: PM2
 * restarting the process across the scheduled minute, a deploy landing on it, an
 * operator running the manual script on the same day, two instances if this is
 * ever scaled out. None are exotic and all are covered by the same one line.
 *
 * NOTHING HERE THROWS AT ITS CALLER. The cron has nobody to catch for it, and an
 * unhandled rejection in a detached job takes the whole process down under this
 * app's `unhandledRejection` handler — a failed spreadsheet would restart the
 * portal. Every path returns a result object instead, and every failure is on
 * the run record.
 */

const TAG = '[InventoryReport]';
const REPORT_TYPE = 'weekly-inventory-health';

/** A claim older than this belonged to a process that died mid-run. */
const STALE_CLAIM_MS = 30 * 60 * 1000;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Take ownership of one occurrence, or report who already has it.
 *
 * `force` exists for the manual re-run of a FAILED week: the row is reused
 * rather than a second one created, so the log keeps one entry per week with
 * the whole history of attempts on it.
 */
const claimRun = async ({ runKey, occurrence, trigger, triggeredBy, force }) => {
  const existing = await ReportRun.findOne({ runKey });

  if (existing) {
    if (existing.status === 'Completed' && !force) {
      return { claimed: false, reason: 'already-sent', run: existing };
    }
    if (existing.status === 'Running') {
      const age = Date.now() - new Date(existing.startedAt).getTime();
      if (age < STALE_CLAIM_MS && !force) {
        return { claimed: false, reason: 'in-progress', run: existing };
      }
      existing.failures.push(
        `Previous attempt was abandoned after ${Math.round(age / 60000)} minute(s) and has been taken over.`,
      );
    }
    // A failed, skipped or stale run is retried in place.
    existing.status = 'Running';
    existing.startedAt = new Date();
    existing.finishedAt = null;
    existing.trigger = trigger;
    existing.triggeredBy = triggeredBy ?? null;
    await existing.save();
    return { claimed: true, run: existing, retry: true };
  }

  try {
    const run = await ReportRun.create({
      reportType: REPORT_TYPE,
      runKey,
      periodLabel: occurrence.label,
      scheduledFor: new Date(),
      status: 'Running',
      trigger,
      triggeredBy: triggeredBy ?? null,
    });
    return { claimed: true, run };
  } catch (error) {
    // The unique index refused it, so another attempt claimed this week
    // between our read and our write. That is the race this guards, and losing
    // it is a success for the guard rather than an error for the caller.
    if (error?.code === 11000) {
      const winner = await ReportRun.findOne({ runKey });
      return { claimed: false, reason: 'raced', run: winner };
    }
    throw error;
  }
};

/**
 * Send the mail, retrying a transient refusal.
 *
 * SMTP fails temporarily far more often than permanently — a dropped
 * connection, greylisting, a provider hiccup — and a WEEKLY report that gives up
 * on the first refusal waits another seven days for its next chance. The delay
 * grows between attempts so a server asking us to slow down is obeyed.
 */
const sendWithRetries = async ({ to, cc, subject, html, attachments, maxAttempts, run }) => {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    run.emailAttempts = attempt;
    try {
      await sendEmail(to, subject, html, { cc, attachments, throwOnError: true });
      return { sent: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      const message = `Email attempt ${attempt}/${maxAttempts} failed: ${error.message}`;
      console.error(`${TAG} ${message}`);
      run.failures.push(message);
      if (attempt < maxAttempts) await pause(attempt * 5000);
    }
  }

  return { sent: false, attempts: maxAttempts, error: lastError };
};

/**
 * Tell somebody a scheduled job failed.
 *
 * Best-effort and deliberately quiet about its own failure: if the mail system
 * is what broke, the alert about it will break too, and an alert that throws
 * would turn one logged failure into two. The run record is the durable trail;
 * this is the tap on the shoulder.
 */
const alertAdministrator = async ({ config, occurrence, errors }) => {
  if (!config.alertTo) return;
  try {
    await sendEmail(
      config.alertTo,
      `ACTION NEEDED: weekly inventory report failed — ${occurrence.label}`,
      `<p>The weekly inventory health report for <strong>${occurrence.label}</strong> could not be delivered.</p>
       <p>The run is recorded as <strong>Failed</strong> and can be retried without waiting for next week:</p>
       <pre style="background:#f1f5f9;padding:10px;border-radius:4px;font-size:12px;">node scripts/send-inventory-report.js --force</pre>
       <p style="font-size:12px;color:#64748b;">What went wrong:</p>
       <ul style="font-size:12px;color:#334155;">${errors.map((e) => `<li>${e}</li>`).join('')}</ul>`,
    );
  } catch (error) {
    console.error(`${TAG} Could not send the failure alert either: ${error.message}`);
  }
};

/**
 * Run the report for whichever week `now` falls in.
 *
 * @returns {{ ok: boolean, status: string, reason?: string, runKey: string, summary?: object }}
 */
export const runWeeklyInventoryReport = async ({
  now = new Date(),
  trigger = 'schedule',
  triggeredBy = null,
  force = false,
  config = readInventoryReportConfig(),
} = {}) => {
  const started = Date.now();

  if (config.problems.length) {
    // Refusing to run on a bad configuration is the point of validating it; the
    // alternative is a run that fails halfway and leaves a half-written record.
    console.error(`${TAG} Refusing to run — configuration is invalid:`);
    for (const p of config.problems) console.error(`${TAG}   • ${p}`);
    return { ok: false, status: 'Failed', reason: 'invalid-config', errors: config.problems };
  }

  const occurrence = occurrenceOf(now, config.timezone);
  const runKey = `${REPORT_TYPE}:${occurrence.label}`;

  let claim;
  try {
    claim = await claimRun({ runKey, occurrence, trigger, triggeredBy, force });
  } catch (error) {
    console.error(`${TAG} Could not claim ${runKey}: ${error.message}`);
    return { ok: false, status: 'Failed', reason: 'claim-failed', runKey, errors: [error.message] };
  }

  if (!claim.claimed) {
    // Not an error. This is the guard doing its job, and saying so plainly is
    // what makes the log readable when a restart lands on the scheduled minute.
    console.log(
      `${TAG} ${occurrence.label} not run — ${claim.reason === 'already-sent'
        ? `it was already sent at ${new Date(claim.run.emailedAt || claim.run.finishedAt).toISOString()}`
        : claim.reason === 'in-progress'
          ? 'another run is in progress'
          : 'another run claimed it first'}.`,
    );
    return { ok: true, status: 'Skipped', reason: claim.reason, runKey, run: claim.run };
  }

  const { run } = claim;
  console.log(`${TAG} ${occurrence.label} starting (${trigger}${claim.retry ? ', retry' : ''}).`);

  try {
    // ── Gather ────────────────────────────────────────────────────────────
    const report = await gatherInventoryHealthReport({
      brands: config.brands,
      thresholdOverrides: config.thresholdOverrides,
      timezone: config.timezone,
      generatedAt: now,
    });

    run.summary = {
      total: report.summary.total,
      healthy: report.summary.healthy,
      low: report.summary.low,
      critical: report.summary.critical,
      outOfStock: report.summary.outOfStock,
      overstock: report.summary.overstock,
      unknown: report.summary.unknown,
    };
    console.log(
      `${TAG} ${occurrence.label}: ${report.summary.total} product(s) — `
      + `${report.summary.outOfStock} out of stock, ${report.summary.critical} critical, `
      + `${report.summary.low} low, ${report.summary.healthy} healthy.`,
    );

    // ── Render ────────────────────────────────────────────────────────────
    // One format failing does not sink the run: a PDF that will not draw is no
    // reason to withhold the spreadsheet, and the email says what it has.
    const attachments = [];
    for (const format of config.formats) {
      try {
        const built = format === 'xlsx'
          ? await buildInventoryHealthXlsx(report)
          : await buildInventoryHealthPdf(report);
        attachments.push(built);
      } catch (error) {
        const message = `Could not generate the ${format.toUpperCase()}: ${error.message}`;
        console.error(`${TAG} ${message}`);
        run.failures.push(message);
      }
    }

    if (attachments.length === 0) {
      throw new Error(
        `No attachment could be generated in ${config.formats.join(' or ')} format.`,
      );
    }

    run.attachments = attachments.map((a) => ({
      fileName: a.fileName, format: a.format, bytes: a.content.length,
    }));

    // ── Send ──────────────────────────────────────────────────────────────
    const subject = `Weekly Inventory Health Report – ${occurrence.label} `
      + `(${report.occurrence.weekStart.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })})`;

    run.recipients = [config.to];
    run.cc = config.cc;

    const delivery = await sendWithRetries({
      to: config.to,
      cc: config.cc,
      subject,
      html: buildInventoryHealthEmail(report, attachments),
      attachments: attachments.map((a) => ({
        filename: a.fileName, content: a.content, contentType: a.contentType,
      })),
      maxAttempts: config.maxEmailAttempts,
      run,
    });

    run.durationMs = Date.now() - started;
    run.finishedAt = new Date();

    if (!delivery.sent) {
      run.status = 'Failed';
      await run.save();
      console.error(`${TAG} ${occurrence.label} FAILED after ${delivery.attempts} send attempt(s).`);
      await alertAdministrator({ config, occurrence, errors: run.failures });
      return {
        ok: false, status: 'Failed', reason: 'email-failed', runKey,
        summary: report.summary, errors: run.failures,
      };
    }

    run.status = 'Completed';
    run.emailedAt = new Date();
    await run.save();

    console.log(
      `${TAG} ${occurrence.label} sent to ${config.to}`
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
    console.error(`${TAG} ${occurrence.label} failed: ${message}`);
    run.failures.push(message);
    run.status = 'Failed';
    run.finishedAt = new Date();
    run.durationMs = Date.now() - started;
    await run.save().catch((e) => console.error(`${TAG} Could not even record the failure: ${e.message}`));
    await alertAdministrator({ config, occurrence, errors: run.failures });
    return { ok: false, status: 'Failed', reason: 'error', runKey, errors: run.failures };
  }
};

/** The most recent runs, newest first — for the log and for a retry decision. */
export const listReportRuns = async ({ limit = 20 } = {}) =>
  ReportRun.find({ reportType: REPORT_TYPE })
    .sort({ startedAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 20, 1), 100))
    .lean();

export default { runWeeklyInventoryReport, listReportRuns };
