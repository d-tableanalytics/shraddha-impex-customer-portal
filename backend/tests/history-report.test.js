/**
 * The weekly Booking & Indent History report.
 *
 * Three things are worth a real database rather than a mock, and they are the
 * three the requirement actually turns on:
 *
 *   1. THE WINDOW. Consecutive periods must meet exactly — no overlap, or a
 *      record is reported twice; no gap, or one is never reported at all.
 *   2. THE DUPLICATE GUARD. Two attempts at the same period must produce one
 *      send. That is enforced by a unique index, and an index is precisely the
 *      thing a mock cannot tell you the truth about.
 *   3. THE COLUMNS. Customer name, shop, location, type, booking date and PO
 *      number have to be on every row, with N/A where no PO was raised.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import Order from '../models/Order.js';
import Reservation from '../models/Reservation.js';
import User from '../models/User.js';
import ReportRun from '../models/ReportRun.js';

import {
  periodFor, gatherHistoryReport, realPoNumber, customerTypeOf,
} from '../modules/orders/historyReport.service.js';
import { buildHistoryXlsx, buildHistoryPdf } from '../modules/orders/historyReport.render.js';
import { claimReportRun } from '../utils/reportRun.js';
import { readHistoryReportConfig, DEFAULT_HISTORY_REPORT_TO } from '../config/historyReport.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const TZ = 'Asia/Kolkata';

/** Monday 08:30 IST, the default schedule's moment. */
const MONDAY_0830_IST = new Date('2026-09-14T03:00:00Z');

const makeCustomer = (over = {}) => User.create({
  email: over.email || `c${Math.random().toString(36).slice(2, 8)}@example.com`,
  password: 'x',
  user: 'Contact Person',
  company: 'Fallback Company',
  customerName: 'Shraddha Motors',
  shopNumber: 'A-12',
  location: 'Manesar',
  customerCategory: 'Customer',
  role: 'Customer',
  ...over,
});

const makeOrder = (over = {}) => Order.create({
  orderId: 'BO-2026-000100',
  brand: 'Koken',
  skuCode: 'S/B42',
  requestedQty: 5,
  bookedQty: 5,
  confirmedQty: 5,
  pendingQty: 0,
  status: 'PO Received',
  date: new Date('2026-09-09T06:00:00Z'),
  ...over,
});

describe('weekly booking & indent history report', () => {
  before(async () => {
    await startTestMongo();
    await syncIndexes(ReportRun);
  });
  after(async () => { await stopTestMongo(); });
  beforeEach(async () => { await clearCollections(); });

  describe('the reporting window', () => {
    test('covers the seven days before the local midnight that precedes the run', () => {
      const p = periodFor(MONDAY_0830_IST, TZ, 7);
      assert.equal(p.label, '2026-09-07_2026-09-13');
      // Midnight IST is 18:30 UTC the day before — the window must not be cut
      // at the moment the job fired, or Monday's bookings land in it.
      assert.equal(p.from.toISOString(), '2026-09-06T18:30:00.000Z');
      assert.equal(p.to.toISOString(), '2026-09-13T18:30:00.000Z');
    });

    test('consecutive weeks meet exactly — no overlap and no gap', () => {
      const thisWeek = periodFor(MONDAY_0830_IST, TZ, 7);
      const nextWeek = periodFor(new Date('2026-09-21T03:00:00Z'), TZ, 7);
      assert.equal(thisWeek.to.getTime(), nextWeek.from.getTime());
      assert.notEqual(thisWeek.label, nextWeek.label);
    });

    test('the same period claims the same key however late the job fires', () => {
      const early = periodFor(new Date('2026-09-14T02:31:00Z'), TZ, 7);
      const late = periodFor(new Date('2026-09-14T16:00:00Z'), TZ, 7);
      assert.equal(early.label, late.label);
    });
  });

  describe('the duplicate guard', () => {
    const claim = (over = {}) => claimReportRun({
      reportType: 'weekly-booking-indent-history',
      runKey: 'weekly-booking-indent-history:2026-09-07_2026-09-13',
      periodLabel: '2026-09-07_2026-09-13',
      ...over,
    });

    test('a second attempt at a sent period is refused, not sent again', async () => {
      const first = await claim();
      assert.equal(first.claimed, true);
      first.run.status = 'Completed';
      first.run.emailedAt = new Date();
      await first.run.save();

      const second = await claim();
      assert.equal(second.claimed, false);
      assert.equal(second.reason, 'already-sent');
      assert.equal(await ReportRun.countDocuments({}), 1, 'one row per period, not two');
    });

    test('a concurrent attempt loses on the index rather than duplicating', async () => {
      const [a, b] = await Promise.all([claim(), claim()]);
      const claimed = [a, b].filter((r) => r.claimed);
      assert.equal(claimed.length, 1, 'exactly one attempt may own the period');
      assert.equal(await ReportRun.countDocuments({}), 1);
    });

    test('a failed period is retried in place, keeping one row and its history', async () => {
      const first = await claim();
      first.run.status = 'Failed';
      first.run.failures.push('SMTP refused the connection');
      await first.run.save();

      const retry = await claim({ trigger: 'manual' });
      assert.equal(retry.claimed, true);
      assert.equal(retry.retry, true);
      assert.equal(retry.run.status, 'Running');
      assert.deepEqual(retry.run.failures, ['SMTP refused the connection']);
      assert.equal(await ReportRun.countDocuments({}), 1);
    });

    test('--force re-sends a completed period without creating a second row', async () => {
      const first = await claim();
      first.run.status = 'Completed';
      await first.run.save();

      const forced = await claim({ force: true });
      assert.equal(forced.claimed, true);
      assert.equal(await ReportRun.countDocuments({}), 1);
    });
  });

  describe('the rows', () => {
    test('carry the customer block, the booking date and the PO number', async () => {
      const customer = await makeCustomer({ customerCategory: 'MSIL' });
      await makeOrder({
        user: customer._id,
        poNumber: 'PO-2026-77',
        createdAt: new Date('2026-09-09T06:00:00Z'),
      });

      const report = await gatherHistoryReport({ now: MONDAY_0830_IST, timezone: TZ, days: 7 });
      assert.equal(report.bookings.length, 1);

      const row = report.bookings[0];
      assert.equal(row.customerName, 'Shraddha Motors');
      assert.equal(row.shopNumber, 'A-12');
      assert.equal(row.location, 'Manesar');
      assert.equal(row.customerType, 'MSIL');
      assert.equal(row.poNumber, 'PO-2026-77');
      assert.ok(row.bookingDate instanceof Date);
      assert.equal(report.summary.bookingsWithPo, 1);
    });

    test("a booking with no PO carries none — '-' is a placeholder, not a number", async () => {
      const customer = await makeCustomer();
      await makeOrder({ user: customer._id, poNumber: '-', createdAt: new Date('2026-09-09T06:00:00Z') });

      const report = await gatherHistoryReport({ now: MONDAY_0830_IST, timezone: TZ, days: 7 });
      assert.equal(report.bookings[0].poNumber, null);
      assert.equal(report.summary.bookingsWithPo, 0);
    });

    test('only records created inside the window are reported', async () => {
      const customer = await makeCustomer();
      await makeOrder({ orderId: 'BO-IN', user: customer._id, createdAt: new Date('2026-09-09T06:00:00Z') });
      // One day before the window opens, and one day after it closes.
      await makeOrder({ orderId: 'BO-BEFORE', user: customer._id, createdAt: new Date('2026-09-05T06:00:00Z') });
      await makeOrder({ orderId: 'BO-AFTER', user: customer._id, createdAt: new Date('2026-09-14T06:00:00Z') });

      const report = await gatherHistoryReport({ now: MONDAY_0830_IST, timezone: TZ, days: 7 });
      assert.deepEqual(report.bookings.map((r) => r.bookingId), ['BO-IN']);
    });

    test('an indent takes its booking date and PO from the booking behind it', async () => {
      const customer = await makeCustomer();
      await makeOrder({
        orderId: 'BO-2026-000200',
        user: customer._id,
        poNumber: 'PO-2026-99',
        date: new Date('2026-09-08T06:00:00Z'),
        createdAt: new Date('2026-09-08T06:00:00Z'),
      });
      await Reservation.create({
        reservationId: 'R-1',
        customerId: customer._id,
        productId: new mongoose.Types.ObjectId(),
        skuCode: 'S/B42',
        quantity: 4,
        expiryDate: new Date('2026-10-01T00:00:00Z'),
        status: 'Pending',
        reservedBy: customer._id,
        indentNumber: 'PI-2026-000200',
        createdAt: new Date('2026-09-09T06:00:00Z'),
      });

      const report = await gatherHistoryReport({ now: MONDAY_0830_IST, timezone: TZ, days: 7 });
      assert.equal(report.indents.length, 1);
      const row = report.indents[0];
      assert.equal(row.bookingId, 'BO-2026-000200');
      assert.equal(row.poNumber, 'PO-2026-99');
      assert.equal(new Date(row.bookingDate).toISOString(), '2026-09-08T06:00:00.000Z');
      assert.equal(row.customerName, 'Shraddha Motors');
      assert.equal(row.indentQty, 4);
    });

    test('a standalone indent reports no booking rather than inventing one', async () => {
      const customer = await makeCustomer();
      await Reservation.create({
        reservationId: 'R-2',
        customerId: customer._id,
        productId: new mongoose.Types.ObjectId(),
        skuCode: '183H.35-8',
        quantity: 2,
        expiryDate: new Date('2026-10-01T00:00:00Z'),
        status: 'Partially Confirmed',
        reservedBy: customer._id,
        // The booking id this WOULD derive to does not exist.
        indentNumber: 'PI-2026-000999',
        createdAt: new Date('2026-09-09T06:00:00Z'),
      });

      const report = await gatherHistoryReport({ now: MONDAY_0830_IST, timezone: TZ, days: 7 });
      assert.equal(report.indents[0].bookingId, null);
      assert.equal(report.indents[0].bookingDate, null);
    });
  });

  describe('the attachments', () => {
    test('both formats build, even for a week with nothing in it', async () => {
      const report = await gatherHistoryReport({ now: MONDAY_0830_IST, timezone: TZ, days: 7 });
      assert.equal(report.bookings.length, 0);

      const xlsx = await buildHistoryXlsx(report);
      const pdf = await buildHistoryPdf(report);

      assert.match(xlsx.fileName, /^Booking_Indent_History_2026-09-07_2026-09-13\.xlsx$/);
      assert.match(pdf.fileName, /\.pdf$/);
      // A quiet week is information, not a reason to send nothing.
      assert.ok(xlsx.content.length > 0);
      assert.equal(pdf.content.subarray(0, 4).toString(), '%PDF');
    });

    test('the workbook has a sheet for each history', async () => {
      const customer = await makeCustomer();
      await makeOrder({ user: customer._id, createdAt: new Date('2026-09-09T06:00:00Z') });

      const report = await gatherHistoryReport({ now: MONDAY_0830_IST, timezone: TZ, days: 7 });
      const { default: ExcelJS } = await import('exceljs');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await buildHistoryXlsx(report)).content);

      assert.deepEqual(
        wb.worksheets.map((w) => w.name),
        ['Summary', 'Booking History', 'Indent History'],
      );
      const headers = wb.getWorksheet('Booking History').getRow(1).values.slice(1);
      for (const required of [
        'Customer Name', 'Shop No.', 'Location', 'Customer Type', 'Booking Date', 'PO Number',
      ]) {
        assert.ok(headers.includes(required), `Booking History is missing "${required}"`);
      }
      const indentHeaders = wb.getWorksheet('Indent History').getRow(1).values.slice(1);
      for (const required of [
        'Customer Name', 'Shop No.', 'Location', 'Customer Type', 'Booking Date', 'PO Number',
      ]) {
        assert.ok(indentHeaders.includes(required), `Indent History is missing "${required}"`);
      }
    });
  });

  describe('configuration', () => {
    test('defaults to the specified support address on a weekly schedule', () => {
      const config = readHistoryReportConfig({});
      assert.equal(config.to, DEFAULT_HISTORY_REPORT_TO);
      assert.equal(config.to, 'support@shraddhaimpex.net');
      assert.equal(config.days, 7);
      assert.equal(config.usable, true);
      assert.deepEqual(config.formats, ['xlsx', 'pdf']);
    });

    test('a bad cron expression disables the job instead of taking the app down', () => {
      const config = readHistoryReportConfig({ HISTORY_REPORT_CRON: 'every monday please' });
      assert.equal(config.usable, false);
      assert.match(config.problems[0], /HISTORY_REPORT_CRON/);
    });

    test('a window other than the schedule length is called out', () => {
      const config = readHistoryReportConfig({ HISTORY_REPORT_DAYS: '30' });
      assert.equal(config.days, 30);
      assert.ok(config.notes.some((n) => /repeats records/.test(n)));
    });
  });

  describe('field helpers', () => {
    test('a PO placeholder is not a PO number', () => {
      assert.equal(realPoNumber('PO-1'), 'PO-1');
      assert.equal(realPoNumber('-'), null);
      assert.equal(realPoNumber('  '), null);
      assert.equal(realPoNumber(null), null);
    });

    test('customer type is MSIL or Customer, whatever the stored spelling', () => {
      assert.equal(customerTypeOf({ customerCategory: 'MSIL' }), 'MSIL');
      assert.equal(customerTypeOf({ customerCategory: 'msil ' }), 'MSIL');
      assert.equal(customerTypeOf({ customerCategory: 'Non-MSIL' }), 'Customer');
      assert.equal(customerTypeOf(null), 'Customer');
    });
  });
});
