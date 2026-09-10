import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

import { COMPANY } from "../constants/company";
import { formatRupees, GST_LABEL } from "../constants/pricing";

/**
 * The picklist / PO document as a PDF.
 *
 * Takes the SAME document object the on-screen preview renders
 * (utils/picklistDocument.js), so the file a customer downloads and the page
 * they were looking at cannot disagree. Distinct from bookingPdf.js, which is
 * the desk's internal booking sheet and carries no money at all.
 *
 * It renders what it is given and decides nothing: if the document has no
 * rates — because the PO was never priced, or because the reader was not
 * entitled to them — the price columns are simply absent. Which code column
 * appears, and the tax on the total, are likewise decided by the adapter in
 * utils/picklistDocument.js and merely drawn here.
 */

const BRAND_BLUE = [30, 58, 138];
const SLATE = [100, 116, 139];

const fmtDate = (d) => {
  const date = d ? new Date(d) : null;
  if (!date || Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

const safeFilename = (doc) =>
  `${doc.poNumber ? "PO" : "Picklist"}_${doc.poNumber || doc.orderId}_${doc.customer.name || "Customer"}`
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/_$/, "") + ".pdf";

/**
 * jsPDF's built-in fonts are WinAnsi and have no rupee glyph, so '₹' prints as
 * a bare box. 'INR' is used instead — unambiguous, and it survives every
 * viewer. The digits and Indian grouping come from the shared formatter.
 */
const money = (value) => {
  const text = formatRupees(value);
  return text === "—" ? "—" : text.replace("₹", "INR ");
};

export const downloadPicklistPdf = async (docModel) => {
  try {
    if (!docModel) return false;
    const pdf = new jsPDF();
    const pageW = pdf.internal.pageSize.getWidth();
    const margin = 14;

    const hasMoney = docModel.totals.pricedLines > 0;

    /* ── Letterhead ───────────────────────────────────────────────────────── */
    pdf.setFont("helvetica", "bold").setFontSize(15).setTextColor(...BRAND_BLUE);
    pdf.text(COMPANY.name, margin, 16);

    const contact = [...COMPANY.addressLines, [COMPANY.phone, COMPANY.email, COMPANY.website]
      .filter(Boolean).join("  ·  ")].filter(Boolean);
    pdf.setFont("helvetica", "normal").setFontSize(8).setTextColor(...SLATE);
    contact.forEach((line, i) => pdf.text(line, margin, 21 + i * 4));

    pdf.setFont("helvetica", "normal").setFontSize(8).setTextColor(...SLATE);
    pdf.text(docModel.poNumber ? "PURCHASE ORDER" : "PICKLIST", pageW - margin, 12, { align: "right" });
    pdf.setFont("courier", "bold").setFontSize(14).setTextColor(...BRAND_BLUE);
    pdf.text(String(docModel.poNumber || docModel.orderId), pageW - margin, 18.5, { align: "right" });
    pdf.setFont("helvetica", "normal").setFontSize(8).setTextColor(...SLATE);
    pdf.text(fmtDate(docModel.poDate || docModel.date), pageW - margin, 23, { align: "right" });

    const headerBottom = 21 + contact.length * 4 + 2;
    pdf.setDrawColor(...BRAND_BLUE).setLineWidth(0.6);
    pdf.line(margin, headerBottom, pageW - margin, headerBottom);

    /* ── Parties and terms ────────────────────────────────────────────────── */
    /*
     * TWO INDEPENDENT COLUMNS, ZIPPED — not a hand-written list of 4-cell rows.
     *
     * This grid is [label, value, label, value] per row, so the two sides were
     * coupled: a row paired one fact about the CUSTOMER with one about the
     * TRANSACTION, and those have nothing to do with each other. Two bugs came
     * straight out of that coupling:
     *
     *   - "Place of supply" shared its row with "PO Date", so deleting the
     *     former would have silently deleted the latter;
     *   - the optional Company row was written `["Company", value, "", ""]`,
     *     which punched a blank gap into the RIGHT column every time a company
     *     name differed from the customer name.
     *
     * Building each column on its own and zipping them at the end makes both
     * impossible: either side can gain or lose an entry and the other is
     * untouched. The shorter column is padded with empty cells.
     *
     * "Place of supply" is GONE. It printed `customer.location` — the delivery
     * TOWN — under a heading that reads like an address, and that is now simply
     * redundant: the Shipping and Billing addresses are printed in full in their
     * own block below. `location` stays on the doc model, because it is still a
     * fallback in that address ladder (see picklistDocument.js).
     */
    const left = [
      ["Customer", docModel.customer.name || "—"],
      // The trading entity. Only when it differs from the customer name, or the
      // same string is printed twice on every document.
      ...(docModel.customer.company && docModel.customer.company !== docModel.customer.name
        ? [["Company", docModel.customer.company]]
        : []),
      ["Contact No.", docModel.customer.phone || "—"],
      ["GST No.", docModel.customer.gstNumber || "—"],
      ["Shop No.", docModel.customer.shopNumber || "—"],
      ...(docModel.customer.vendorCode ? [["Vendor Code", docModel.customer.vendorCode]] : []),
    ];

    const right = [
      ["Booking No.", docModel.orderId || "—"],
      ["PO No.", docModel.poNumber || "Not raised"],
      ["PO Date", docModel.poDate ? fmtDate(docModel.poDate) : "—"],
      ["Payment Term", docModel.paymentTerm || "—"],
      ["Supply By", docModel.promiseDate ? fmtDate(docModel.promiseDate) : "—"],
      // Internal copies name the schedule; the adapter leaves it null otherwise.
      ...(docModel.priceTypeLabel ? [["Price Type", docModel.priceTypeLabel]] : []),
    ];

    const info = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => [
      ...(left[i] ?? ["", ""]),
      ...(right[i] ?? ["", ""]),
    ]);

    autoTable(pdf, {
      startY: headerBottom + 4,
      margin: { left: margin, right: margin },
      body: info,
      theme: "plain",
      styles: { fontSize: 8.5, cellPadding: { top: 1.2, bottom: 1.2, left: 0, right: 3 } },
      columnStyles: {
        0: { textColor: SLATE, cellWidth: 28 },
        1: { fontStyle: "bold", cellWidth: 60 },
        2: { textColor: SLATE, cellWidth: 26 },
        3: { fontStyle: "bold" },
      },
    });

    /* ── Shipping and billing addresses ───────────────────────────────────
       Their own block rather than two more rows in the grid above, because an
       address is multi-line and the grid's 60mm value column would either clip
       it or wrap it into the terms beside it. Two equal columns, full width,
       so a long address has room to breathe and the two are read side by side.

       BOTH HEADINGS ALWAYS PRINT, even when the addresses are identical. A
       packer who sees only one heading cannot tell whether billing was the same
       or simply unknown; two headings answer that without being asked. */
    const addrTop = pdf.lastAutoTable.finalY + 3;
    const halfW = (pageW - margin * 2) / 2;
    autoTable(pdf, {
      startY: addrTop,
      margin: { left: margin, right: margin },
      head: [["Shipping Address", "Billing Address"]],
      body: [[
        docModel.customer.shippingAddress || "—",
        docModel.customer.billingAddress || "—",
      ]],
      theme: "plain",
      headStyles: {
        fontSize: 7.5, fontStyle: "bold", textColor: SLATE,
        cellPadding: { top: 0, bottom: 1, left: 0, right: 3 },
      },
      styles: {
        fontSize: 8.5,
        cellPadding: { top: 0, bottom: 1.5, left: 0, right: 3 },
        // `overflow: linebreak` is what makes a long address wrap inside its own
        // column instead of running under the neighbouring one.
        overflow: "linebreak",
        valign: "top",
      },
      columnStyles: {
        0: { cellWidth: halfW - 2 },
        1: { cellWidth: halfW - 2 },
      },
    });

    /* ── Lines ────────────────────────────────────────────────────────────── */
    /* THE CODE COLUMN BELONGS TO THE CUSTOMER, not to the document: an MSIL
       customer's paper carries their MSIL code, everyone else's carries no code
       column at all. The Ko-ken code stays on both — a line has no other
       identification of the goods on it, so dropping that too would leave a
       priced document that does not say what was bought.

       Every column index below is COUNTED rather than written out. autoTable
       addresses columns by position, and a literal `4:` in columnStyles starts
       styling the wrong column the moment a column ahead of it disappears —
       which, with an optional column on the left, is half the documents. */
    const showMsil = Boolean(docModel.showMsilCode);
    const head = [
      "Sr.",
      ...(showMsil ? ["MSIL Code"] : []),
      "Ko-ken Code", "Qty",
      ...(hasMoney ? ["Rate", "Amount"] : []),
      ...(docModel.showBoxNo ? ["Box"] : []),
    ];
    const body = docModel.lines.map((l) => [
      l.sr,
      ...(showMsil ? [l.msilCode || "—"] : []),
      l.skuCode,
      l.quantity,
      ...(hasMoney ? [money(l.unitPrice), money(l.amount)] : []),
      ...(docModel.showBoxNo ? [l.boxNo || "—"] : []),
    ]);

    const columnStyles = {};
    let col = 0;
    columnStyles[col++] = { cellWidth: 10, halign: "right" };                // Sr.
    if (showMsil) columnStyles[col++] = { cellWidth: 34, font: "courier" };  // MSIL Code
    columnStyles[col++] = { cellWidth: 34, font: "courier" };                // Ko-ken Code
    columnStyles[col++] = { cellWidth: 16, halign: "right" };                // Qty
    if (hasMoney) {
      columnStyles[col++] = { halign: "right" };                            // Rate
      columnStyles[col++] = { halign: "right" };                            // Amount
    }
    if (docModel.showBoxNo) columnStyles[col++] = { cellWidth: 20 };         // Box

    /* The totals block. Every row must add up to the same cell count as the
       table or autoTable drops it, so both spans and the trailing pad are
       derived from the columns that were actually built. */
    const labelSpan = 2 + (showMsil ? 1 : 0);   // Sr. through the last code column
    const moneySpan = labelSpan + 2;            // ...and on through Qty and Rate
    const boxPad = docModel.showBoxNo ? [{ content: "", styles: {} }] : [];
    const GRAND_FILL = [226, 232, 240];

    const foot = [[
      {
        content: hasMoney ? "Subtotal" : "Total",
        colSpan: labelSpan,
        styles: { halign: "right", fontStyle: "bold" },
      },
      { content: String(docModel.totals.quantity), styles: { halign: "right", fontStyle: "bold" } },
      ...(hasMoney ? [
        { content: "", styles: {} },
        { content: money(docModel.totals.amount), styles: { halign: "right", fontStyle: "bold" } },
      ] : []),
      ...boxPad,
    ]];

    // Tax on its own line rather than folded into the total: a commercial
    // document has to say what the tax WAS, not only what it came to.
    if (hasMoney) {
      foot.push([
        { content: GST_LABEL, colSpan: moneySpan, styles: { halign: "right" } },
        { content: money(docModel.totals.gstAmount), styles: { halign: "right" } },
        ...boxPad,
      ]);
      foot.push([
        {
          content: "Grand Total",
          colSpan: moneySpan,
          styles: { halign: "right", fontStyle: "bold", fillColor: GRAND_FILL },
        },
        {
          content: money(docModel.totals.grandTotal),
          styles: { halign: "right", fontStyle: "bold", fillColor: GRAND_FILL },
        },
        ...boxPad.map(() => ({ content: "", styles: { fillColor: GRAND_FILL } })),
      ]);
    }

    autoTable(pdf, {
      startY: pdf.lastAutoTable.finalY + 4,
      margin: { left: margin, right: margin, bottom: 24 },
      theme: "grid",
      head: [head],
      body,
      foot,
      styles: { fontSize: 8, cellPadding: 2, valign: "middle" },
      headStyles: { fillColor: BRAND_BLUE, fontSize: 7.5 },
      footStyles: { fillColor: [244, 246, 248], textColor: [15, 23, 42] },
      columnStyles,
      didDrawPage: () => {
        const pageH = pdf.internal.pageSize.getHeight();
        pdf.setDrawColor(226, 232, 240).setLineWidth(0.3);
        pdf.line(margin, pageH - 16, pageW - margin, pageH - 16);
        pdf.setFont("helvetica", "normal").setFontSize(7).setTextColor(...SLATE);
        pdf.text(
          hasMoney
            ? `Amounts are in Indian Rupees. ${GST_LABEL} is charged on the subtotal and included in the grand total.`
            : "No pricing has been applied to this order.",
          margin, pageH - 11,
        );
        pdf.text(
          `Page ${pdf.internal.getCurrentPageInfo().pageNumber} of {tp}`,
          pageW - margin, pageH - 11, { align: "right" },
        );
        pdf.setFontSize(6.5).setTextColor(180);
        pdf.text(
          `Generated from the Shraddha Impex customer portal on ${fmtDate(new Date())}.`,
          margin, pageH - 7,
        );
      },
    });

    if (docModel.totals.unpricedLines > 0 && hasMoney) {
      pdf.setFont("helvetica", "normal").setFontSize(7.5).setTextColor(146, 64, 14);
      pdf.text(
        `${docModel.totals.unpricedLines} line(s) have no rate on file and are not included in the total.`,
        margin, pdf.lastAutoTable.finalY + 5,
      );
    }

    if (typeof pdf.putTotalPages === "function") pdf.putTotalPages("{tp}");
    pdf.save(safeFilename(docModel));
    return true;
  } catch (err) {
    console.error("Picklist PDF generation failed:", err);
    return false;
  }
};

export default downloadPicklistPdf;
