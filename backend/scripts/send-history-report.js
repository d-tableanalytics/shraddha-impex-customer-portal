/**
 * send-history-report.js
 * -----------------------------------------------------------------------------
 * Run the weekly Booking & Indent History report by hand.
 *
 * This is the RETRY MECHANISM, and the way to prove the configuration works
 * without waiting until Monday.
 *
 *   node scripts/send-history-report.js                 # this period, if not already sent
 *   node scripts/send-history-report.js --force         # re-send it even if it went
 *   node scripts/send-history-report.js --dry-run       # generate and save locally, send nothing
 *   node scripts/send-history-report.js --dry-run --as 2026-09-15
 *   node scripts/send-history-report.js --check         # print the configuration and stop
 *   node scripts/send-history-report.js --history       # the last runs and how they went
 *
 * WITHOUT --force it obeys the same duplicate guard the cron does, so running it
 * on a day the schedule already fired does nothing and says so. That is
 * deliberate: the safe command should be the short one.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { connectDatabase } = await import('../config/database.js');
const { readHistoryReportConfig, describeHistoryReportConfig } = await import('../config/historyReport.js');
const { runWeeklyHistoryReport, listHistoryReportRuns } = await import('../modules/orders/historyReport.job.js');
const { gatherHistoryReport } = await import('../modules/orders/historyReport.service.js');
const { buildHistoryXlsx, buildHistoryPdf } = await import('../modules/orders/historyReport.render.js');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

const config = readHistoryReportConfig();

/* ── --check : configuration only, no database ──────────────────────────── */
if (has('--check')) {
  console.log('\nWeekly Booking & Indent History report — configuration\n');
  console.log(`  Enabled          ${config.enabled}`);
  console.log(`  Schedule         ${config.schedule}   (${config.timezone})`);
  console.log(`  Recipient        ${config.to}`);
  console.log(`  Cc               ${config.cc.join(', ') || '(none)'}`);
  console.log(`  Failure alerts   ${config.alertTo || '(not set — failures are logged only)'}`);
  console.log(`  Format           ${config.formats.join(' + ')}`);
  console.log(`  Window           previous ${config.days} day(s), cut at midnight ${config.timezone}`);
  console.log(`  PDF row cap      ${config.pdfMaxRows} per table (the .xlsx is complete)`);
  console.log(`  Send attempts    ${config.maxEmailAttempts}`);
  console.log(`  SMTP             ${config.smtpConfigured ? 'configured' : 'NOT configured — mail is printed to the console'}`);
  console.log('');
  describeHistoryReportConfig(config);
  process.exit(config.problems.length ? 1 : 0);
}

await connectDatabase();

try {
  /* ── --history ────────────────────────────────────────────────────────── */
  if (has('--history')) {
    const runs = await listHistoryReportRuns({ limit: Number(valueOf('--limit')) || 20 });
    if (!runs.length) {
      console.log('No report runs recorded yet.');
    } else {
      console.log('\nPeriod                   Status     Sent               Bookings  Indents  Cust.  Attempts');
      console.log('─'.repeat(94));
      for (const r of runs) {
        // `metrics` is a Map on the document and a plain object once lean().
        const m = r.metrics instanceof Map ? Object.fromEntries(r.metrics) : (r.metrics || {});
        console.log(
          String(r.periodLabel || '—').padEnd(25)
          + String(r.status).padEnd(11)
          + String(r.emailedAt ? new Date(r.emailedAt).toISOString().slice(0, 16).replace('T', ' ') : '—').padEnd(19)
          + String(m.bookings ?? '—').padStart(8)
          + String(m.indents ?? '—').padStart(9)
          + String(m.customers ?? '—').padStart(7)
          + String(r.emailAttempts ?? 0).padStart(10),
        );
        for (const e of (r.failures || [])) console.log(`  ! ${e}`);
      }
    }
    await mongoose.disconnect();
    process.exit(0);
  }

  /* ── --dry-run : build the files, send nothing ────────────────────────── */
  if (has('--dry-run')) {
    // `--as` reports a different week without touching the clock — the way to
    // check last month's numbers, or to see the report a quiet week produces.
    const asOf = valueOf('--as') ? new Date(`${valueOf('--as')}T12:00:00Z`) : new Date();
    if (Number.isNaN(asOf.getTime())) {
      console.error(`--as expects a date like 2026-09-15 — got "${valueOf('--as')}".`);
      process.exit(1);
    }

    const report = await gatherHistoryReport({
      now: asOf, timezone: config.timezone, days: config.days,
    });
    console.log(`\nPeriod ${report.period.title}  (${report.period.fromLabel} → ${report.period.toLabel})`);
    console.log(`  Bookings      ${report.summary.bookings} (${report.summary.bookingLines} line(s), ${report.summary.bookingQty} unit(s))`);
    console.log(`  With a PO     ${report.summary.bookingsWithPo}`);
    console.log(`  Indents       ${report.summary.indents} (${report.summary.indentLines} line(s), ${report.summary.indentQty} unit(s))`);
    console.log(`  Customers     ${report.summary.customers}`);

    const outDir = valueOf('--out') || path.join(__dirname, '..', 'tmp');
    fs.mkdirSync(outDir, { recursive: true });
    for (const format of config.formats) {
      const built = format === 'xlsx'
        ? await buildHistoryXlsx(report)
        : await buildHistoryPdf(report, { maxRows: config.pdfMaxRows });
      const file = path.join(outDir, built.fileName);
      fs.writeFileSync(file, built.content);
      console.log(`  Wrote ${file} (${Math.round(built.content.length / 1024)}KB)`);
    }
    console.log('\nDry run — no email was sent and no run was recorded.\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  /* ── The real thing ───────────────────────────────────────────────────── */
  const result = await runWeeklyHistoryReport({
    trigger: 'manual',
    force: has('--force'),
  });

  console.log(`\n${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  if (result.errors?.length) for (const e of result.errors) console.error(`  ! ${e}`);
  await mongoose.disconnect();
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error('\nThe report could not be run:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
}
