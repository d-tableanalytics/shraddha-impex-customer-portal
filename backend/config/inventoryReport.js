import cron from 'node-cron';

/**
 * Configuration for the weekly inventory health report.
 *
 * EVERYTHING THE OPERATOR NEEDS TO CHANGE IS AN ENVIRONMENT VARIABLE, and it is
 * read HERE and nowhere else. A schedule or a recipient read straight out of
 * `process.env` at the point of use is a setting nobody can find and nobody can
 * validate; gathering them means a bad value is caught once, at boot, with a
 * message naming the variable — rather than at 08:00 on a Monday, inside a
 * detached job, as a stack trace nobody is watching for.
 *
 * Nothing here throws. A misconfigured report DISABLES ITSELF and says why: the
 * portal's job is to serve the portal, and refusing to boot because a reporting
 * address is missing would take the application down over a spreadsheet.
 */

/** Parse a boolean-ish env value. Absent means "use the default". */
const asBool = (raw, fallback) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
};

/** Parse a percentage threshold. Absent or unusable means "not overridden". */
const asPercent = (raw) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0 || n > 100) return { invalid: String(raw).trim() };
  return { value: n };
};

const asList = (raw) =>
  String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** A very loose address check — enough to catch a placeholder or a typo'd list. */
const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());

const VALID_FORMATS = ['xlsx', 'pdf', 'both'];

/**
 * Read the configuration, collecting every problem rather than stopping at the
 * first. An operator fixing one variable at a time, one restart at a time, is
 * the failure mode this avoids.
 */
export const readInventoryReportConfig = (env = process.env) => {
  const problems = [];
  const notes = [];

  const enabled = asBool(env.INVENTORY_REPORT_ENABLED, true);

  // ── Schedule ────────────────────────────────────────────────────────────
  // Monday 08:00 by default: the report describes the week that just ended, and
  // it wants to be in the support team's inbox before they start their week.
  const schedule = String(env.INVENTORY_REPORT_CRON ?? '0 8 * * 1').trim();
  if (!cron.validate(schedule)) {
    problems.push(
      `INVENTORY_REPORT_CRON is not a valid cron expression: "${schedule}". `
      + 'Five fields — minute hour day-of-month month day-of-week. "0 8 * * 1" is Monday at 08:00.',
    );
  }

  /**
   * The timezone the schedule is read in.
   *
   * Without it node-cron uses the server's clock, and this box runs in UTC
   * while the business runs in IST — "Monday 08:00" would arrive at 13:30 local
   * on Monday, which is neither the day nor the hour anyone asked for.
   */
  const timezone = String(env.INVENTORY_REPORT_TIMEZONE ?? 'Asia/Kolkata').trim();
  try {
    new Intl.DateTimeFormat('en-IN', { timeZone: timezone });
  } catch {
    problems.push(`INVENTORY_REPORT_TIMEZONE is not a timezone this system knows: "${timezone}".`);
  }

  // ── Recipients ──────────────────────────────────────────────────────────
  // SUPPORT_EMAIL is accepted as well, because that is what the requirement
  // calls it and it is the name an operator will reach for first.
  const to = String(env.INVENTORY_REPORT_TO ?? env.SUPPORT_EMAIL ?? '').trim();
  if (!to) {
    problems.push(
      'No support address is set. Set SUPPORT_EMAIL (or INVENTORY_REPORT_TO) to the '
      + 'address the weekly report should go to.',
    );
  } else if (!looksLikeEmail(to)) {
    problems.push(`SUPPORT_EMAIL does not look like an email address: "${to}".`);
  }

  const cc = asList(env.INVENTORY_REPORT_CC);
  const badCc = cc.filter((a) => !looksLikeEmail(a));
  if (badCc.length) problems.push(`INVENTORY_REPORT_CC contains invalid address(es): ${badCc.join(', ')}.`);

  /**
   * Where a FAILURE goes, which is deliberately not the support address.
   *
   * The support team is the audience for the report; they are not the people
   * who fix a broken SMTP password. Left unset, failures are logged and the run
   * is left retryable — they are never silently dropped.
   */
  const alertTo = String(env.INVENTORY_REPORT_ALERT_TO ?? '').trim();
  if (alertTo && !looksLikeEmail(alertTo)) {
    problems.push(`INVENTORY_REPORT_ALERT_TO is not an email address: "${alertTo}".`);
  }

  // ── Output ──────────────────────────────────────────────────────────────
  const format = String(env.INVENTORY_REPORT_FORMAT ?? 'both').trim().toLowerCase();
  if (!VALID_FORMATS.includes(format)) {
    problems.push(`INVENTORY_REPORT_FORMAT must be one of ${VALID_FORMATS.join(', ')} — got "${format}".`);
  }

  /**
   * Threshold overrides.
   *
   * NORMALLY LEFT UNSET, and that is the recommended state. The bands already
   * come from the inventory configuration the Health screen uses (M1/M4), which
   * is versioned and audited precisely because changing a threshold silently
   * reclassifies thousands of SKUs. Setting these makes the REPORT disagree with
   * the screen, so the report says so on its own summary page when they are in
   * force rather than leaving the reader to wonder why the numbers differ.
   */
  const critical = asPercent(env.INVENTORY_REPORT_CRITICAL_THRESHOLD);
  const low = asPercent(env.INVENTORY_REPORT_LOW_THRESHOLD);
  if (critical?.invalid) problems.push(`INVENTORY_REPORT_CRITICAL_THRESHOLD must be a percentage between 0 and 100 — got "${critical.invalid}".`);
  if (low?.invalid) problems.push(`INVENTORY_REPORT_LOW_THRESHOLD must be a percentage between 0 and 100 — got "${low.invalid}".`);
  if (critical?.value && low?.value && critical.value >= low.value) {
    problems.push(
      `INVENTORY_REPORT_CRITICAL_THRESHOLD (${critical.value}%) must be BELOW `
      + `INVENTORY_REPORT_LOW_THRESHOLD (${low.value}%) — critical is the tighter band.`,
    );
  }
  const thresholdOverrides = (critical?.value || low?.value)
    ? { critical: critical?.value ?? null, low: low?.value ?? null }
    : null;
  if (thresholdOverrides) {
    notes.push(
      'Report-specific thresholds are set, so the report will NOT match the Inventory '
      + 'Health screen. Unset INVENTORY_REPORT_CRITICAL_THRESHOLD / '
      + 'INVENTORY_REPORT_LOW_THRESHOLD to use the configured inventory thresholds.',
    );
  }

  // Optional brand filter, for a report scoped to one brand's stock.
  const brands = asList(env.INVENTORY_REPORT_BRANDS);

  /**
   * How hard to try before giving up on the send.
   *
   * SMTP fails transiently far more often than permanently — a dropped
   * connection, a greylisting, a provider hiccup — and a weekly report that
   * gives up on the first refusal waits another seven days.
   */
  // `|| 3` would be wrong here: it turns a deliberate 0 into 3, which is the
  // opposite of what someone typing 0 meant. Absent or unreadable falls back to
  // 3; a real number is clamped, so 0 becomes 1 — one attempt, not none, since
  // never sending is what disabling the report is for.
  const rawAttempts = Number(env.INVENTORY_REPORT_MAX_EMAIL_ATTEMPTS);
  const maxEmailAttempts = Number.isFinite(rawAttempts)
    ? Math.min(Math.max(Math.trunc(rawAttempts), 1), 10)
    : 3;

  // SMTP is the app's existing configuration; the report does not define its own
  // transport. Reported here only so a misconfigured mailer is visible from the
  // same place as everything else the report needs.
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
    thresholdOverrides,
    brands,
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
export const describeInventoryReportConfig = (config) => {
  const tag = '[InventoryReport]';
  if (!config.enabled) {
    console.log(`${tag} Disabled (INVENTORY_REPORT_ENABLED=false). No weekly report will be sent.`);
    return;
  }
  if (config.problems.length) {
    console.error(`${tag} NOT SCHEDULED — configuration problems:`);
    for (const p of config.problems) console.error(`${tag}   • ${p}`);
    return;
  }
  console.log(
    `${tag} Scheduled "${config.schedule}" (${config.timezone}) → ${config.to}`
    + `${config.cc.length ? ` cc ${config.cc.join(', ')}` : ''} as ${config.formats.join(' + ')}.`,
  );
  for (const n of config.notes) console.warn(`${tag}   ! ${n}`);
};

export default { readInventoryReportConfig, describeInventoryReportConfig };
