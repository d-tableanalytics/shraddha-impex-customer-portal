# Weekly Inventory Health Report

An automated report that runs on a schedule, classifies every SKU by stock
health, renders it as a colour-coded spreadsheet and PDF, and emails it to the
support team.

```
Cron  →  read stockhealth  →  band + colour  →  .xlsx / .pdf  →  email support  →  record the run
```

---

## Quick start

Add two lines to `backend/.env` and restart:

```dotenv
SUPPORT_EMAIL=support@shraddhaimpex.net
INVENTORY_REPORT_CRON=0 8 * * 1
```

Then check it:

```bash
cd backend
npm run report:check      # is the configuration valid? prints what will happen
npm run report:dry-run    # build the files locally, send nothing
npm run report:send       # send this week's report now
npm run report:history    # what has run, and how it went
```

`report:check` needs no database and no SMTP. Run it first.

---

## Configuration

Everything is an environment variable, read once at boot by
`backend/config/inventoryReport.js`. A bad value **disables the report and says
why** in the startup log — it never stops the portal from booting.

| Variable | Default | What it does |
| --- | --- | --- |
| `SUPPORT_EMAIL` | — | **Required.** Where the report goes. `INVENTORY_REPORT_TO` is accepted as an alias. |
| `INVENTORY_REPORT_CRON` | `0 8 * * 1` | When to run. Standard five-field cron. |
| `INVENTORY_REPORT_TIMEZONE` | `Asia/Kolkata` | The zone the schedule is read in. |
| `INVENTORY_REPORT_ENABLED` | `true` | `false` turns the whole thing off. |
| `INVENTORY_REPORT_FORMAT` | `both` | `xlsx`, `pdf`, or `both`. |
| `INVENTORY_REPORT_CC` | — | Comma-separated extra recipients. |
| `INVENTORY_REPORT_ALERT_TO` | — | Where **failures** go. Not the support address — see below. |
| `INVENTORY_REPORT_BRANDS` | all | Comma-separated, e.g. `Koken,BIX`, to scope the report. |
| `INVENTORY_REPORT_MAX_EMAIL_ATTEMPTS` | `3` | Send attempts before the run is marked failed. |
| `INVENTORY_REPORT_CRITICAL_THRESHOLD` | *(unset)* | Override the critical band, as a percentage. See the warning below. |
| `INVENTORY_REPORT_LOW_THRESHOLD` | *(unset)* | Override the low band, as a percentage. |

SMTP is the application's existing configuration — `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`. The report defines no transport of its
own. With `SMTP_HOST` unset the mail is printed to the console instead of sent,
which is the app's existing behaviour and is why `report:dry-run` is the better
way to test the *content*.

### Setting the schedule

```
┌ minute
│ ┌ hour
│ │ ┌ day of month
│ │ │ ┌ month
│ │ │ │ ┌ day of week  (0 = Sunday, 1 = Monday …)
0 8 * * 1
```

| You want | Set |
| --- | --- |
| Monday 08:00 *(default)* | `0 8 * * 1` |
| Friday 17:30 | `30 17 * * 5` |
| Sunday 06:00 | `0 6 * * 0` |
| Every day 08:00 *(testing)* | `0 8 * * *` |

The day and hour are read in `INVENTORY_REPORT_TIMEZONE`, **not** the server's
clock. The production box runs in UTC and the business runs in IST, so without
the timezone "Monday 08:00" would arrive at 13:30 local.

> Changing the schedule to run more than once a week does **not** send more than
> one report a week. The duplicate guard is keyed on the ISO week, so a daily
> cron sends on the first run of each week and skips the rest. That is a useful
> property while testing — and worth knowing before you conclude the job is
> broken.

### A warning about the threshold overrides

Leave `INVENTORY_REPORT_CRITICAL_THRESHOLD` and `INVENTORY_REPORT_LOW_THRESHOLD`
**unset** unless you have a specific reason not to.

The bands normally come from the inventory configuration that the **Inventory
Health** screen uses — the versioned, audited one an admin edits in the portal.
Setting these makes the report band SKUs differently from the screen, so the
same SKU can be amber in one and green in the other. The report prints a warning
on its own summary page when they are in force, but the cleaner fix is almost
always to change the thresholds in the portal so everything agrees.

---

## What the report contains

**Summary** — total products, and a count per status with the colour key.

**Detail** — one row per SKU, ordered most urgent first:

| Column | Source |
| --- | --- |
| SKU / Item ID | `stockhealth.skuCode` |
| Product Name | `products.description`, falling back to the SKU code |
| Brand | `stockhealth.brand` |
| Available Qty | `stockhealth.available` |
| On Hand | `stockhealth.onHand` — what the band is computed against |
| Reserved | `stockhealth.reserved` |
| Reorder Level | `stockhealth.reorderLevel` |
| Status | `stockhealth.band` — the coloured cell |
| Cover % | `stockhealth.replenishmentPercent` |
| Last Updated | `stockhealth.computedAt` |

### Statuses and colours

| | Status | Meaning |
| --- | --- | --- |
| 🔴 | **Out of Stock** | Nothing on hand |
| 🟠 | **Critical** | At or below the reorder level |
| 🟡 | **Low** | Below the low-stock threshold |
| 🟢 | **Healthy** | Sufficient against the target level |
| 🔵 | Overstock | Above the target level |
| ⚪ | Not planned | No consumption, lead time or safety factor — no band can be derived |

The last two are not in the requirement's list of four, and they are reported
anyway rather than folded into "healthy": a SKU nobody has planned is not a
healthy SKU, and counting it as one would overstate how much of the catalogue is
fine. Roughly 90% of the catalogue currently lands in **Not planned** — that
number is the planning worklist, not a fault in the report.

### Why the PDF may be shorter than the spreadsheet

A full catalogue is several thousand rows, which is a two-hundred-page PDF. The
PDF carries the summary and the first 500 rows — and because rows are ordered
worst-first, that is always everything needing attention. It states how many it
omitted. The `.xlsx` always has every row, which is why `both` is the default.

---

## Reliability

**Every execution is recorded** in the `reportruns` collection: when it ran, what
it found, what it produced, how many send attempts it took, and every error
along the way. `npm run report:history` prints it.

**The same week is never sent twice.** Each run claims its week by inserting a
unique `runKey` (`weekly-inventory-health:2026-W36`). A second attempt at the
same week loses on the unique index — not on a check that two processes could
both pass. This matters because there are ordinary ways to get two attempts:
PM2 restarting across the scheduled minute, a deploy landing on it, or someone
running the manual script on the same day.

**Failed sends are retried** — `INVENTORY_REPORT_MAX_EMAIL_ATTEMPTS` times with a
growing delay, because SMTP fails transiently far more often than permanently and
a weekly report that gives up on the first refusal waits another seven days.

**If it still fails**, the run is marked `Failed`, every error is on the record,
and — if `INVENTORY_REPORT_ALERT_TO` is set — an email goes to the administrator
with the command to retry. The support team is not told; they are the audience
for the report, not the people who fix SMTP.

**One bad format does not sink the run.** If the PDF fails to render, the
spreadsheet is still sent and the email says what it has.

**The job never throws at the scheduler.** This app exits the process on an
unhandled rejection, so a job that threw would restart the portal over a
spreadsheet.

### Recovering a failed week

```bash
cd backend
npm run report:history                                  # find the failed week
node scripts/send-inventory-report.js --force           # re-send this week
node scripts/send-inventory-report.js --week 2026-W35 --force
```

`--force` is needed to re-send a week that already went out. Without it the
duplicate guard refuses and says so, which is the right default for a command
someone may run twice.

---

## Files

| File | Role |
| --- | --- |
| `backend/config/inventoryReport.js` | Reads and validates every setting |
| `backend/models/ReportRun.js` | The execution log, and the duplicate-send lock |
| `backend/modules/inventory/inventoryReport.service.js` | Gathers rows and the summary from the health projection |
| `backend/modules/inventory/inventoryReport.render.js` | Builds the .xlsx, the .pdf and the email body |
| `backend/modules/inventory/inventoryReport.job.js` | Claim → gather → render → send → record |
| `backend/scripts/send-inventory-report.js` | Manual run, dry run, retry, history |
| `backend/server.js` | Registers the cron at boot |

The report **reads** the `stockhealth` projection and computes no bands of its
own. That projection is what the Inventory Health screen reads too, so the two
cannot disagree — which is the whole reason the report does not do its own
arithmetic.
