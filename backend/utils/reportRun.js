import ReportRun from '../models/ReportRun.js';
import { sendEmail } from './mailer.js';

/**
 * The machinery every scheduled report shares: claiming an occurrence, sending
 * with retries, and telling somebody when it failed.
 *
 * ONE IMPLEMENTATION OF THE DUPLICATE GUARD, deliberately. It was written for
 * the weekly inventory report and is now also what stops the weekly booking and
 * indent report going out twice. Two copies of a concurrency guard is two
 * chances to fix a bug in one of them — and this one is not obvious enough to
 * survive being reimplemented from memory.
 *
 * What is NOT here is anything about a particular report: no gathering, no
 * rendering, no subject lines. A job passes its own report type and its own
 * text; everything below is about runs, not about contents.
 */

/** A claim older than this belonged to a process that died mid-run. */
export const STALE_CLAIM_MS = 30 * 60 * 1000;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Take ownership of one occurrence, or report who already has it.
 *
 * THE CLAIM IS AN INSERT, not a check-then-act. Every attempt at a given period
 * derives the same `runKey`, and claiming inserts that key against a unique
 * index — so a second attempt loses on the index rather than on a read two
 * processes can both pass. That is what makes "the same weekly report is not
 * accidentally sent twice" a property of the database rather than a hope about
 * timing.
 *
 * There are more ways to get a second attempt than there look to be: PM2
 * restarting the process across the scheduled minute, a deploy landing on it, an
 * operator running the manual script on the same day, two instances if this is
 * ever scaled out. None are exotic and all are covered by the same one line.
 *
 * `force` exists for the manual re-run of a FAILED period: the row is reused
 * rather than a second one created, so the log keeps one entry per period with
 * the whole history of attempts on it.
 */
export const claimReportRun = async ({
  reportType, runKey, periodLabel, trigger = 'schedule', triggeredBy = null, force = false,
}) => {
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
      reportType,
      runKey,
      periodLabel,
      scheduledFor: new Date(),
      status: 'Running',
      trigger,
      triggeredBy: triggeredBy ?? null,
    });
    return { claimed: true, run };
  } catch (error) {
    // The unique index refused it, so another attempt claimed this period
    // between our read and our write. That is the race this guards, and losing
    // it is a success for the guard rather than an error for the caller.
    if (error?.code === 11000) {
      const winner = await ReportRun.findOne({ runKey });
      return { claimed: false, reason: 'raced', run: winner };
    }
    throw error;
  }
};

/** Why a claim was refused, in words a log reader can act on. */
export const describeRefusal = (claim) => {
  if (claim.reason === 'already-sent') {
    const when = claim.run?.emailedAt || claim.run?.finishedAt;
    return `it was already sent${when ? ` at ${new Date(when).toISOString()}` : ''}`;
  }
  if (claim.reason === 'in-progress') return 'another run is in progress';
  return 'another run claimed it first';
};

/**
 * Send the mail, retrying a transient refusal.
 *
 * SMTP fails temporarily far more often than permanently — a dropped
 * connection, greylisting, a provider hiccup — and a WEEKLY report that gives up
 * on the first refusal waits another seven days for its next chance. The delay
 * grows between attempts so a server asking us to slow down is obeyed.
 */
export const sendReportWithRetries = async ({
  to, cc, subject, html, attachments, maxAttempts, run, tag,
}) => {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    run.emailAttempts = attempt;
    try {
      await sendEmail(to, subject, html, { cc, attachments, throwOnError: true });
      return { sent: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      const message = `Email attempt ${attempt}/${maxAttempts} failed: ${error.message}`;
      console.error(`${tag} ${message}`);
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
export const alertReportFailure = async ({
  alertTo, subject, reportName, periodLabel, retryCommand, errors, tag,
}) => {
  if (!alertTo) return;
  try {
    await sendEmail(
      alertTo,
      subject,
      `<p>The ${reportName} for <strong>${periodLabel}</strong> could not be delivered.</p>
       <p>The run is recorded as <strong>Failed</strong> and can be retried without waiting for next week:</p>
       <pre style="background:#f1f5f9;padding:10px;border-radius:4px;font-size:12px;">${retryCommand}</pre>
       <p style="font-size:12px;color:#64748b;">What went wrong:</p>
       <ul style="font-size:12px;color:#334155;">${errors.map((e) => `<li>${e}</li>`).join('')}</ul>`,
    );
  } catch (error) {
    console.error(`${tag} Could not send the failure alert either: ${error.message}`);
  }
};

/** The most recent runs of one report type, newest first. */
export const listRunsOfType = async (reportType, { limit = 20 } = {}) =>
  ReportRun.find({ reportType })
    .sort({ startedAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 20, 1), 100))
    .lean();

export default {
  STALE_CLAIM_MS,
  claimReportRun,
  describeRefusal,
  sendReportWithRetries,
  alertReportFailure,
  listRunsOfType,
};
