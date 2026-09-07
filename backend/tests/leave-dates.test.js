/**
 * Leave day arithmetic — the sandwich rule.
 *
 * Pure, so it is tested directly. This decides how many days come off a
 * balance, which makes it the one piece that has to be provable without a
 * database, a request or a clock.
 *
 * Calendar anchors used throughout (2026):
 *   Mon 5 Jan .. Fri 9 Jan   a clean working week
 *   Sat 10, Sun 11 Jan       a weekend
 *   Mon 26 Jan               Republic Day, used as the holiday
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeLeaveDays,
  eachDay,
  inclusiveDayCount,
  isWeekend,
  dayToUtcMs,
  utcMsToDay,
  isNotFutureDay,
  isNotPastDay,
} from '../shared/leave/dates.js';

const HOLIDAYS = new Set(['2026-01-26']);
const days = (req, holidays = HOLIDAYS) => computeLeaveDays(req, holidays, 8);

// ---------------------------------------------------------------------------
// Calendar primitives
// ---------------------------------------------------------------------------

test('a date is a calendar day, not an instant', () => {
  // `new Date('2026-01-05')` is UTC midnight, but `new Date('2026-01-05 00:00')`
  // is LOCAL midnight - and mixing the two is how the 5th becomes the 4th for
  // anyone west of Greenwich. Everything here goes through Date.UTC.
  assert.equal(utcMsToDay(dayToUtcMs('2026-01-05')), '2026-01-05');
  assert.equal(utcMsToDay(dayToUtcMs('2026-12-31')), '2026-12-31');
  assert.equal(utcMsToDay(dayToUtcMs('2024-02-29')), '2024-02-29', 'a real leap day');
});

test('an impossible date is refused rather than rolled forward', () => {
  // Date.UTC turns 31 February into 3 March without complaint.
  assert.throws(() => dayToUtcMs('2026-02-31'), /not a real calendar date/);
  assert.throws(() => dayToUtcMs('2026-13-01'), /not a real calendar date/);
  assert.throws(() => dayToUtcMs('2023-02-29'), /not a real calendar date/);
  assert.throws(() => dayToUtcMs('05-01-2026'), /YYYY-MM-DD/);
  assert.throws(() => dayToUtcMs(null), /YYYY-MM-DD/);
});

test('a range is inclusive at both ends', () => {
  assert.equal(inclusiveDayCount('2026-01-05', '2026-01-05'), 1);
  assert.equal(inclusiveDayCount('2026-01-05', '2026-01-09'), 5);
  assert.equal(inclusiveDayCount('2026-01-09', '2026-01-05'), 0, 'reversed is empty');
});

test('eachDay walks the range and crosses month and year boundaries', () => {
  assert.deepEqual(eachDay('2026-01-05', '2026-01-07'), ['2026-01-05', '2026-01-06', '2026-01-07']);
  assert.deepEqual(eachDay('2026-01-31', '2026-02-01'), ['2026-01-31', '2026-02-01']);
  assert.deepEqual(eachDay('2025-12-31', '2026-01-01'), ['2025-12-31', '2026-01-01']);
});

test('the weekend is Saturday and Sunday, read in UTC', () => {
  assert.equal(isWeekend('2026-01-10'), true, 'Saturday');
  assert.equal(isWeekend('2026-01-11'), true, 'Sunday');
  assert.equal(isWeekend('2026-01-09'), false, 'Friday');
  assert.equal(isWeekend('2026-01-12'), false, 'Monday');
});

// ---------------------------------------------------------------------------
// Full days
// ---------------------------------------------------------------------------

test('a working week costs five days', () => {
  assert.equal(days({ startDate: '2026-01-05', endDate: '2026-01-09' }), 5);
});

test('one day costs one', () => {
  assert.equal(days({ startDate: '2026-01-05', endDate: '2026-01-05' }), 1);
});

test('a weekend on its own costs nothing', () => {
  assert.equal(days({ startDate: '2026-01-10', endDate: '2026-01-11' }), 0);
});

test('a holiday on its own costs nothing', () => {
  assert.equal(days({ startDate: '2026-01-26', endDate: '2026-01-26' }), 0);
});

// ---------------------------------------------------------------------------
// The sandwich rule
// ---------------------------------------------------------------------------

test('a weekend BETWEEN two full leave days is charged', () => {
  // Fri + Sat + Sun + Mon. Taking Friday and Monday off means not being there
  // all weekend either, so the reference charges for it.
  assert.equal(days({ startDate: '2026-01-09', endDate: '2026-01-12' }), 4);
});

test('a half day on either side breaks the sandwich', () => {
  // Same four dates, taken as halves: the weekend is free again, and only the
  // two working halves are charged.
  assert.equal(days({ startDate: '2026-01-09', endDate: '2026-01-12', durationUnit: 'half_day' }), 1);
});

test('a weekend at the EDGE of a range is never charged', () => {
  // Sat + Sun + Mon: nothing precedes the weekend, so it is not sandwiched.
  assert.equal(days({ startDate: '2026-01-10', endDate: '2026-01-12' }), 1);
  // Fri + Sat + Sun: nothing follows it.
  assert.equal(days({ startDate: '2026-01-09', endDate: '2026-01-11' }), 1);
});

test('a holiday between two full leave days is charged like a weekend', () => {
  // Fri 23 .. Tue 27 = Fri, [Sat, Sun, Mon-holiday], Tue -> all five charged.
  assert.equal(days({ startDate: '2026-01-23', endDate: '2026-01-27' }), 5);
});

test('the same range without the holiday configured is unchanged', () => {
  // Monday the 26th is then an ordinary working day, so it is charged as one.
  assert.equal(days({ startDate: '2026-01-23', endDate: '2026-01-27' }, new Set()), 5);
});

test('an optional holiday is not a day off (it is excluded upstream)', () => {
  // holidayDateSet omits optional holidays, so they arrive here as ordinary
  // working days and are charged.
  assert.equal(days({ startDate: '2026-01-26', endDate: '2026-01-26' }, new Set()), 1);
});

// ---------------------------------------------------------------------------
// Half days
// ---------------------------------------------------------------------------

test('a half day costs half', () => {
  assert.equal(days({ startDate: '2026-01-05', endDate: '2026-01-05', durationUnit: 'half_day' }), 0.5);
});

test('three half days cost one and a half, not two', () => {
  const total = days({ startDate: '2026-01-05', endDate: '2026-01-07', durationUnit: 'half_day' });
  assert.equal(total, 1.5);
});

// ---------------------------------------------------------------------------
// Mixed
// ---------------------------------------------------------------------------

test('mixed charges each day by its own kind', () => {
  const total = days({
    startDate: '2026-01-05',
    endDate: '2026-01-07',
    durationUnit: 'mixed',
    dayBreakdown: [
      { date: '2026-01-05', kind: 'full' },
      { date: '2026-01-06', kind: 'half_first' },
      { date: '2026-01-07', kind: 'full' },
    ],
  });
  assert.equal(total, 2.5);
});

test('a mixed half day breaks the sandwich just as a half-day request does', () => {
  // Fri full, weekend, Mon HALF -> the weekend is not between two full days.
  const total = days({
    startDate: '2026-01-09',
    endDate: '2026-01-12',
    durationUnit: 'mixed',
    dayBreakdown: [
      { date: '2026-01-09', kind: 'full' },
      { date: '2026-01-10', kind: 'full' },
      { date: '2026-01-11', kind: 'full' },
      { date: '2026-01-12', kind: 'half_first' },
    ],
  });
  assert.equal(total, 1.5, 'Friday full + Monday half, weekend free');
});

test('a mixed range of two full days still charges the weekend between them', () => {
  const total = days({
    startDate: '2026-01-09',
    endDate: '2026-01-12',
    durationUnit: 'mixed',
    dayBreakdown: [
      { date: '2026-01-09', kind: 'full' },
      { date: '2026-01-10', kind: 'full' },
      { date: '2026-01-11', kind: 'full' },
      { date: '2026-01-12', kind: 'full' },
    ],
  });
  assert.equal(total, 4);
});

// ---------------------------------------------------------------------------
// Hourly
// ---------------------------------------------------------------------------

test('hours are charged as a FRACTION OF A DAY, not as days', () => {
  // The reference writes raw hours into a days-denominated field and subtracts
  // that from a days-denominated balance, so two hours off spends two days of
  // someone's entitlement. Two hours of an eight-hour day is a quarter day.
  assert.equal(
    days({ startDate: '2026-01-05', endDate: '2026-01-05', durationUnit: 'hour', hoursPerDay: 2 }),
    0.25,
  );
  assert.equal(
    days({ startDate: '2026-01-05', endDate: '2026-01-05', durationUnit: 'hour', hoursPerDay: 4 }),
    0.5,
  );
});

test('a whole day of hours is one day, never more', () => {
  assert.equal(
    days({ startDate: '2026-01-05', endDate: '2026-01-05', durationUnit: 'hour', hoursPerDay: 8 }),
    1,
  );
  assert.equal(
    days({ startDate: '2026-01-05', endDate: '2026-01-05', durationUnit: 'hour', hoursPerDay: 12 }),
    1,
    'capped: you cannot take more than a day off in a day',
  );
});

test('the workday length is configuration, not a constant', () => {
  // Four hours of a six-hour day is two thirds of it.
  const total = computeLeaveDays(
    { startDate: '2026-01-05', endDate: '2026-01-05', durationUnit: 'hour', hoursPerDay: 4 },
    HOLIDAYS,
    6,
  );
  assert.equal(total, 0.67);
});

test('hourly leave never reaches across a weekend', () => {
  const total = days({
    startDate: '2026-01-09',
    endDate: '2026-01-12',
    durationUnit: 'hour',
    hoursPerDay: 2,
  });
  // Friday and Monday only; the weekend between them is untouched.
  assert.equal(total, 0.5);
});

// ---------------------------------------------------------------------------
// Arithmetic hygiene
// ---------------------------------------------------------------------------

test('a long run of halves does not drift', () => {
  // 0.1 + 0.2 territory: adding 0.5 twenty times must not land on 9.999...
  const total = days({ startDate: '2026-01-05', endDate: '2026-02-01', durationUnit: 'half_day' });
  assert.equal(total, Math.round(total * 100) / 100);
  assert.equal(Number.isInteger(total * 2), true, 'a whole number of halves');
});

test('a reversed range costs nothing rather than going negative', () => {
  assert.equal(days({ startDate: '2026-01-09', endDate: '2026-01-05' }), 0);
});

// ---------------------------------------------------------------------------
// Final audit: the day-boundary bug that made three forms unusable at night
// ---------------------------------------------------------------------------

/**
 * 🔴 A user's "today" is not UTC's "today".
 *
 * `isNotFutureDay` / `isNotPastDay` replaced three bounds written against
 * `utcMsToDay(Date.now())`. In IST the local date runs AHEAD of UTC from
 * 00:00 to 05:30, so a form that defaulted a field to the viewer's today —
 * which the expense claim drawer and the attendance correction picker both do
 * — produced a value its own schema then rejected as "in the future". The
 * same rule ran on the server, so the request was refused there too.
 *
 * Effect: no expense claim and no attendance correction could be filed between
 * midnight and 05:30, every night. The exits bound had the mirror of the same
 * fault, latent in IST and live west of Greenwich.
 *
 * These pin the behaviour against a FIXED clock, so they assert the rule
 * rather than reproducing the race that hid it.
 */
test('a day that is "today" in any timezone is neither future nor past', () => {
  const realNow = Date.now;
  try {
    // 2026-09-03T18:36:00Z — which is already 2026-09-04 in IST.
    const utcInstant = Date.UTC(2026, 8, 3, 18, 36);
    Date.now = () => utcInstant;

    // The viewer's calendar says the 4th; UTC says the 3rd. Both are "today".
    assert.equal(isNotFutureDay('2026-09-04'), true, 'IST today must not read as future');
    assert.equal(isNotFutureDay('2026-09-03'), true, 'UTC today must not read as future');
    assert.equal(isNotPastDay('2026-09-03'), true, 'UTC today must not read as past');
    assert.equal(isNotPastDay('2026-09-04'), true, 'IST today must not read as past');

    // The tolerance is exactly ONE day — the width of the timezone envelope,
    // not open-ended slack. A date beyond that is still refused.
    //
    // At this instant UTC reads 2026-09-03, so the future bound sits on the
    // 4th: the 5th is future no matter where the caller is standing.
    assert.equal(isNotFutureDay('2026-09-05'), false, 'beyond the envelope is still future');
    assert.equal(isNotFutureDay('2026-10-01'), false);
    // The past bound sits on the 2nd for the same reason, so the 1st is past
    // everywhere. The 2nd itself is deliberately still accepted: that is the
    // envelope doing its job for a viewer far west of UTC.
    assert.equal(isNotPastDay('2026-09-01'), false, 'beyond the envelope is still past');
    assert.equal(isNotPastDay('2026-01-01'), false);
  } finally {
    Date.now = realNow;
  }
});

test('the bound holds at the far side of the day too', () => {
  const realNow = Date.now;
  try {
    // 2026-09-04T00:30:00Z — still 2026-09-03 in a UTC-5 zone.
    Date.now = () => Date.UTC(2026, 8, 4, 0, 30);

    assert.equal(isNotPastDay('2026-09-03'), true, 'a UTC-5 viewer\u2019s today is not past');
    assert.equal(isNotFutureDay('2026-09-04'), true);
    assert.equal(isNotPastDay('2026-09-02'), false, 'beyond the envelope is still past');
    assert.equal(isNotFutureDay('2026-09-06'), false);
  } finally {
    Date.now = realNow;
  }
});
