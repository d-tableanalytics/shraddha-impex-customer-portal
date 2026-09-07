/**
 * send-inventory-report.js
 * -----------------------------------------------------------------------------
 * Run the weekly inventory health report by hand.
 *
 * This is the RETRY MECHANISM the requirement asks for, and the way to prove the
 * configuration works without waiting until Monday.
 *
 *   node scripts/send-inventory-report.js                # this week, if not already sent
 *   node scripts/send-inventory-report.js --force        # re-send this week even if it went
 *   node scripts/send-inventory-report.js --week 2026-W35 --force
 *   node scripts/send-inventory-report.js --dry-run      # generate and save locally, send nothing
 *   node scripts/send-inventory-report.js --check        # print the configuration and stop
 *   node scripts/send-inventory-report.js --history      # the last runs and how they went
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
const { readInventoryReportConfig, describeInventoryReportConfig } = await import('../config/inventoryReport.js');
const { runWeeklyInventoryReport, listReportRuns } = await import('../modules/inventory/inventoryReport.job.js');
const { gatherInventoryHealthReport } = await import('../modules/inventory/inventoryReport.service.js');
const {
  buildInventoryHealthXlsx, buildInventoryHealthPdf,
} = await import('../modules/inventory/inventoryReport.render.js');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

const config = readInventoryReportConfig();

/* ── --check : configuration only, no database ──────────────────────────── */
if (has('--check')) {
  console.log('\nWeekly inventory health report — configuration\n');
  console.log(`  Enabled          ${config.enabled}`);
  console.log(`  Schedule         ${config.schedule}   (${config.timezone})`);
  console.log(`  Support address  ${config.to || '(not set)'}`);
  console.log(`  Cc               ${config.cc.join(', ') || '(none)'}`);
  console.log(`  Failure alerts   ${config.alertTo || '(not set — failures are logged only)'}`);
  console.log(`  Format           ${config.formats.join(' + ')}`);
  console.log(`  Brands           ${config.brands.join(', ') || 'all'}`);
  console.log(`  Thresholds       ${config.thresholdOverrides
    ? `OVERRIDDEN critical ${config.thresholdOverrides.critical ?? '—'}%, low ${config.thresholdOverrides.low ?? '—'}%`
    : 'from the inventory configuration (matches the Health screen)'}`);
  console.log(`  Send attempts    ${config.maxEmailAttempts}`);
  console.log(`  SMTP             ${config.smtpConfigured ? 'configured' : 'NOT configured — mail is printed to the console'}`);
  console.log('');
  describeInventoryReportConfig(config);
  process.exit(config.problems.length ? 1 : 0);
}

await connectDatabase();

try {
  /* ── --history ────────────────────────────────────────────────────────── */
  if (has('--history')) {
    const runs = await listReportRuns({ limit: Number(valueOf('--limit')) || 20 });
    if (!runs.length) {
      console.log('No report runs recorded yet.');
    } else {
      console.log('\nWeek       Status     Sent                 Products  Out  Crit  Low   Attempts');
      console.log('─'.repeat(88));
      for (const r of runs) {
        console.log(
          String(r.periodLabel || '—').padEnd(11)
          + String(r.status).padEnd(11)
          + String(r.emailedAt ? new Date(r.emailedAt).toISOString().slice(0, 16).replace('T', ' ') : '—').padEnd(21)
          + String(r.summary?.total ?? '—').padStart(8)
          + String(r.summary?.outOfStock ?? '—').padStart(5)
          + String(r.summary?.critical ?? '—').padStart(6)
          + String(r.summary?.low ?? '—').padStart(6)
          + String(r.emailAttempts ?? 0).padStart(11),
        );
        for (const e of (r.failures || [])) console.log(`             ! ${e}`);
      }
      console.log('');
    }
    await mongoose.disconnect();
    process.exit(0);
  }

  /* ── --dry-run : build the files, send nothing ────────────────────────── */
  if (has('--dry-run')) {
    console.log('Dry run — generating the report without sending or recording anything.\n');
    const report = await gatherInventoryHealthReport({
      brands: config.brands,
      thresholdOverrides: config.thresholdOverrides,
      timezone: config.timezone,
    });

    console.log(`  Week            ${report.occurrence.label}`);
    console.log(`  Total products  ${report.summary.total}`);
    console.log(`  Out of stock    ${report.summary.outOfStock}`);
    console.log(`  Critical        ${report.summary.critical}`);
    console.log(`  Low             ${report.summary.low}`);
    console.log(`  Healthy         ${report.summary.healthy}`);
    console.log(`  Overstock       ${report.summary.overstock}`);
    console.log(`  Not planned     ${report.summary.unknown}`);

    const outDir = valueOf('--out') || process.cwd();
    for (const format of config.formats) {
      const built = format === 'xlsx'
        ? await buildInventoryHealthXlsx(report)
        : await buildInventoryHealthPdf(report);
      const target = path.join(outDir, built.fileName);
      fs.writeFileSync(target, built.content);
      console.log(`\n  Wrote ${target} (${Math.round(built.content.length / 1024)} KB)`);
    }

    await mongoose.disconnect();
    process.exit(0);
  }

  /* ── The real thing ───────────────────────────────────────────────────── */
  // --week re-runs a PAST occurrence. The date is placed mid-week so the ISO
  // week the job derives is the one that was asked for.
  const week = valueOf('--week');
  let now = new Date();
  if (week) {
    const match = /^(\d{4})-W(\d{1,2})$/.exec(week.trim());
    if (!match) {
      console.error(`--week expects a form like 2026-W35, got "${week}".`);
      process.exit(1);
    }
    const [, year, weekNo] = match;
    // 4 January is always in ISO week 1; step forward whole weeks from there and
    // land on the Thursday, which is the day that names the week.
    const jan4 = new Date(Date.UTC(Number(year), 0, 4));
    const isoMonday = new Date(jan4);
    isoMonday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
    now = new Date(isoMonday.getTime() + (Number(weekNo) - 1) * 7 * 24 * 3600 * 1000 + 3 * 24 * 3600 * 1000);
  }

  const result = await runWeeklyInventoryReport({
    now,
    trigger: 'manual',
    force: has('--force'),
    config,
  });

  if (result.status === 'Skipped') {
    console.log(
      `\nNothing sent — ${result.reason === 'already-sent'
        ? 'this week\'s report has already gone out. Use --force to send it again.'
        : 'another run holds this week.'}\n`,
    );
  } else if (result.ok) {
    console.log(`\nSent. ${result.summary.total} product(s) reported.\n`);
  } else {
    console.error(`\nFailed: ${(result.errors || []).join(' / ')}\n`);
  }

  await mongoose.disconnect();
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error('\nThe script itself failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
}
