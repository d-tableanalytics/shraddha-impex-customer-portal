import cron from 'node-cron';

/**
 * Configuration for the weekly Booking & Indent History report.
 *
 * Same contract as config/inventoryReport.js and for the same reasons: every
 * setting is an environment variable, read HERE and nowhere else, validated once
 * at boot so a bad value is caught with a message naming the variable rather
 * than at 08:30 on a Monday inside a detached job.
 *
 * Nothing here throws. A misconfigured report DISABLES ITSELF and says why.
 *
 * THE ONE DIFFERENCE FROM THE INVENTORY REPORT is the recipient. That one is
 * defined by SUPPORT_EMAIL and refuses to run without it; this one was
 * specified to go to support@shraddhaimpex.net, so that address is the default
 * and HISTORY_REPORT_TO is the only thing that moves it. See the note at the
 * recipient itself for why SUPPORT_EMAIL is not inherited here.
 */

/** Where the requirement says this report goes. */
export const DEFAULT_HISTORY_REPORT_TO = 'support@shraddhaimpex.net';

/**
 * Monday 08:30 by default.
 *
 * Half an hour after the inventory report rather than alongside it: they are
 * separate jobs with separate claims and would not corrupt each other, but two
 * reports rendering a few thousand rows each in the same minute is avoidable
 * load, and two mails landing together is one of them going unread.
 */
export const DEFAULT_HISTORY_REPORT_CRON = '30 8 * * 1';

const asBool = (raw, fallback) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
};

const asList = (raw) =>
  String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** A very loose address check — enough to catch a placeholder or a typo'd list. */
const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());

const VALID_FORMATS = ['xlsx', 'pdf', 'both'];

export const readHistoryReportConfig = (env = process.env) => {
  const problems = [];
  const notes = [];

  const enabled = asBool(env.HISTORY_REPORT_ENABLED, true);

  // ── Schedule ────────────────────────────────────────────────────────────
  const schedule = String(env.HISTORY_REPORT_CRON ?? DEFAULT_HISTORY_REPORT_CRON).trim();
  if (!cron.validate(schedule)) {
    problems.push(
      `HISTORY_REPORT_CRON is not a valid cron expression: "${schedule}". `
      + 'Five fields — minute hour day-of-month month day-of-week. "30 8 * * 1" is Monday at 08:30.',
    );
  }

  /**
   * The timezone the schedule AND the reporting window are read in.
   *
   * It decides two things, not one: when the job fires, and where the seven-day
   * period starts and ends. A server running in UTC would otherwise cut the
   * week at 05:30 IST and put Monday morning's bookings in the previous
   * report — which is exactly the kind of off-by-a-few-hours that makes a
   * business report quietly wrong rather than obviously broken.
   */
  const timezone = String(env.HISTORY_REPORT_TIMEZONE ?? 'Asia/Kolkata').trim();
  try {
    new Intl.DateTimeFormat('en-IN', { timeZone: timezone });
  } catch {
    problems.push(`HISTORY_REPORT_TIMEZONE is not a timezone this system knows: "${timezone}".`);
  }

  /* ── Recipients ──────────────────────────────────────────────────────────
     The specified address is the DEFAULT, and HISTORY_REPORT_TO is the only
     override.

     SUPPORT_EMAIL is deliberately NOT consulted, unlike the inventory report
     which is defined by it. That variable is whatever a given deployment has
     pointed "support" at — on this one it is a developer's test inbox — and
     inheriting it would mean the report quietly went somewhere other than the
     address it was specified for, with nothing in the configuration saying so.
     A destination this report was given by name should have to be changed by
     name. Set HISTORY_REPORT_TO to send it elsewhere; that shows up in
     --check and in the boot log. */
  const to = String(env.HISTORY_REPORT_TO ?? DEFAULT_HISTORY_REPORT_TO).trim();
  if (!looksLikeEmail(to)) {
    problems.push(
      `The history report recipient does not look like an email address: "${to}". `
      + `Set HISTORY_REPORT_TO, or leave it unset to use ${DEFAULT_HISTORY_REPORT_TO}.`,
    );
  }

  const cc = asList(env.HISTORY_REPORT_CC);
  const badCc = cc.filter((a) => !looksLikeEmail(a));
  if (badCc.length) problems.push(`HISTORY_REPORT_CC contains invalid address(es): ${badCc.join(', ')}.`);

  /**
   * Where a FAILURE goes, deliberately not the support address: support is the
   * audience for the report, not the people who fix an SMTP password. Left
   * unset, failures are logged and the run is left retryable.
   */
  const alertTo = String(env.HISTORY_REPORT_ALERT_TO ?? '').trim();
  if (alertTo && !looksLikeEmail(alertTo)) {
    problems.push(`HISTORY_REPORT_ALERT_TO is not an email address: "${alertTo}".`);
  }

  // ── Output ──────────────────────────────────────────────────────────────
  const format = String(env.HISTORY_REPORT_FORMAT ?? 'both').trim().toLowerCase();
  if (!VALID_FORMATS.includes(format)) {
    problems.push(`HISTORY_REPORT_FORMAT must be one of ${VALID_FORMATS.join(', ')} — got "${format}".`);
  }

  /**
   * The length of the reporting window, in days.
   *
   * Configurable but almost never worth changing: it is what makes consecutive
   * reports meet exactly rather than overlap. A window LONGER than the interval
   * between runs re-reports records that were already sent, which is the
   * duplication the requirement is about — so a value other than 7 on a weekly
   * schedule is called out rather than silently obeyed.
   */
  const rawDays = Number(env.HISTORY_REPORT_DAYS);
  const days = Number.isFinite(rawDays) && rawDays > 0
    ? Math.min(Math.trunc(rawDays), 90)
    : 7;
  if (env.HISTORY_REPORT_DAYS !== undefined && String(env.HISTORY_REPORT_DAYS).trim() !== '' && !Number.isFinite(rawDays)) {
    problems.push(`HISTORY_REPORT_DAYS must be a whole number of days — got "${env.HISTORY_REPORT_DAYS}".`);
  }
  if (days !== 7) {
    notes.push(
      `The reporting window is ${days} days, not 7. On a weekly schedule a longer `
      + 'window repeats records in consecutive reports and a shorter one leaves gaps.',
    );
  }

  /**
   * How many rows the PDF carries before it defers to the spreadsheet. The PDF
   * is the readable summary; the .xlsx is the complete record.
   */
  const rawPdfRows = Number(env.HISTORY_REPORT_PDF_MAX_ROWS);
  const pdfMaxRows = Number.isFinite(rawPdfRows) && rawPdfRows > 0
    ? Math.min(Math.trunc(rawPdfRows), 5000)
    : 400;

  // `|| 3` would be wrong here: it turns a deliberate 0 into 3. Absent or
  // unreadable falls back to 3; a real number is clamped, so 0 becomes 1 — one
  // attempt, not none, since never sending is what disabling the report is for.
  const rawAttempts = Number(env.HISTORY_REPORT_MAX_EMAIL_ATTEMPTS);
  const maxEmailAttempts = Number.isFinite(rawAttempts)
    ? Math.min(Math.max(Math.trunc(rawAttempts), 1), 10)
    : 3;

  const smtpConfigured = Boolean(env.SMTP_HOST) && env.SMTP_HOST !== 'smtp.example.com';
  if (enabled && !smtpConfigured) {
    notes.push(
      'SMTP_HOST is not set, so the report will be generated and logged but the mail '
      + 'will only be printed to the console (the app\'s existing dev-mail behaviour).',
    );
  }

  return {
    enabled,
    schedule,
    timezone,
    to,
    cc,
    alertTo,
    format,
    formats: format === 'both' ? ['xlsx', 'pdf'] : [format],
    days,
    pdfMaxRows,
    maxEmailAttempts,
    smtpConfigured,
    problems,
    notes,
    /** Whether the scheduler should actually register this job. */
    get usable() { return this.enabled && this.problems.length === 0; },
  };
};

/**
 * Log what the report is configured to do, once, at boot.
 *
 * A scheduled job that says nothing on startup is one nobody can confirm is
 * running until the week it does not.
 */
export const describeHistoryReportConfig = (config) => {
  const tag = '[HistoryReport]';
  if (!config.enabled) {
    console.log(`${tag} Disabled (HISTORY_REPORT_ENABLED=false). No weekly report will be sent.`);
    return;
  }
  if (config.problems.length) {
    console.error(`${tag} NOT SCHEDULED — configuration problems:`);
    for (const p of config.problems) console.error(`${tag}   • ${p}`);
    return;
  }
  console.log(
    `${tag} Scheduled "${config.schedule}" (${config.timezone}) → ${config.to}`
    + `${config.cc.length ? ` cc ${config.cc.join(', ')}` : ''}`
    + ` as ${config.formats.join(' + ')}, covering the previous ${config.days} days.`,
  );
  for (const n of config.notes) console.warn(`${tag}   ! ${n}`);
};

export default {
  readHistoryReportConfig,
  describeHistoryReportConfig,
  DEFAULT_HISTORY_REPORT_TO,
  DEFAULT_HISTORY_REPORT_CRON,
};
