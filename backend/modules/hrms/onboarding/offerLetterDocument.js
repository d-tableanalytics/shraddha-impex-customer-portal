/**
 * Rendering the offer letter.
 *
 * ---------------------------------------------------------------------------
 * HTML, not PDF — and why
 * ---------------------------------------------------------------------------
 * The reference renders a PDF with `pdf-lib`. That dependency is not in this
 * repository, and adding one for a single letter is the same call Payroll made
 * for payslips and Hiring made for its own offer letters: the document
 * LIFECYCLE is what carries the behaviour — generate server-side, store
 * privately, authorise every read, audit it, expire the link — and the byte
 * format is a rendering detail behind this one function.
 *
 * So this produces a self-contained HTML document: no external stylesheet, no
 * script, no remote font. A browser opens it from a presigned URL and prints it
 * to PDF if a PDF is what someone needs. Swapping in a real PDF renderer later
 * is a change to `render()` and the content type beside it, nothing else.
 *
 * The company name comes from CompanyProfile at the call site rather than being
 * baked in — the reference hardcodes "D-Table Analytics" into the letter body,
 * which is exactly the customer-specific value AD-1 moved into the company
 * profile.
 */

/** Everything that reaches the document is escaped. A designation is user input. */
const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * `YYYY-MM-DD` to "1 September 2026", without a locale.
 *
 * Node's ICU data differs between builds — the same `toLocaleDateString` call
 * renders "Sept" on one and "Sep" on another. A letter is a legal artefact; its
 * dates do not get to depend on which Node the server happens to run.
 */
function formatDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return String(iso ?? '');
  const [, y, mo, d] = m;
  return `${Number(d)} ${MONTHS[Number(mo) - 1]} ${y}`;
}

/** Indian digit grouping, computed rather than delegated, for the same reason. */
function formatInr(amount) {
  const [whole, fraction = '00'] = String(amount ?? '0').split('.');
  const digits = whole.replace(/^-/, '');
  const negative = whole.startsWith('-');
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${negative ? '-' : ''}${grouped}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

/**
 * Render the letter.
 *
 * @param {object} data
 * @param {string} data.candidateName
 * @param {string} data.designation
 * @param {string} data.ctc            decimal string, e.g. "1800000.00"
 * @param {string} data.joiningDate    YYYY-MM-DD
 * @param {string} [data.companyName]  from CompanyProfile
 * @returns {{ body: string, contentType: string, filename: string }}
 */
export function renderOfferLetter(data) {
  const company = data.companyName || 'our company';

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offer of employment — ${esc(data.candidateName)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f1f5f9; color: #0f172a;
         font: 15px/1.65 Georgia, 'Times New Roman', serif; }
  .sheet { max-width: 760px; margin: 32px auto; background: #fff; padding: 0 0 56px;
           box-shadow: 0 1px 3px rgba(15,23,42,.12); }
  header { background: #02407b; color: #fff; padding: 22px 56px; }
  header h1 { margin: 0; font-size: 20px; letter-spacing: .06em; text-transform: uppercase; }
  main { padding: 36px 56px 0; }
  dl { display: grid; grid-template-columns: 190px 1fr; gap: 10px 20px;
       margin: 26px 0; padding: 18px 22px; background: #f8fafc; border: 1px solid #e2e8f0; }
  dt { font-family: system-ui, sans-serif; font-size: 12px; font-weight: 700;
       text-transform: uppercase; letter-spacing: .05em; color: #64748b; }
  dd { margin: 0; font-weight: 700; }
  .amount { font-variant-numeric: tabular-nums; }
  p { margin: 0 0 14px; }
  footer { margin: 34px 56px 0; padding-top: 18px; border-top: 1px solid #e2e8f0;
           font-family: system-ui, sans-serif; font-size: 12px; color: #64748b; }
  @media print { body { background: #fff; } .sheet { margin: 0; box-shadow: none; } }
</style>
</head>
<body>
<div class="sheet">
  <header><h1>Offer of employment</h1></header>
  <main>
    <p>Dear ${esc(data.candidateName)},</p>

    <p>We are pleased to offer you the position of <strong>${esc(data.designation)}</strong>
       at ${esc(company)}.</p>

    <dl>
      <dt>Designation</dt><dd>${esc(data.designation)}</dd>
      <dt>Annual CTC</dt><dd class="amount">₹ ${esc(formatInr(data.ctc))}</dd>
      <dt>Expected joining date</dt><dd>${esc(formatDay(data.joiningDate))}</dd>
    </dl>

    <p>This offer is contingent on satisfactory background verification, receipt of the
       documents we have asked for, and your acceptance of company policies. The detailed
       terms of your employment will be shared in the appointment letter on joining.</p>

    <p>To accept this offer, please sign it electronically in the HRMS new-hire portal.
       Your acceptance is recorded with the name you type, the time you sign, and the
       address you sign from.</p>

    <p>We look forward to welcoming you to the team.</p>

    <p style="margin-top:28px">Warm regards,<br><strong>${esc(company)}</strong></p>
  </main>
  <footer>
    This letter was generated by the HRMS on ${esc(formatDay(new Date().toISOString().slice(0, 10)))}.
    It is confidential and intended solely for ${esc(data.candidateName)}.
  </footer>
</div>
</body>
</html>`;

  return {
    body,
    contentType: 'text/html; charset=utf-8',
    filename: 'offer-letter.html',
  };
}

export { formatDay, formatInr };
export default { renderOfferLetter };
