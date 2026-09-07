import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

import { COMPANY } from "../constants/company";
import { formatRupees } from "../constants/pricing";

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
 * entitled to them — the price columns are simply absent.
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
    const info = [
      ["Customer", docModel.customer.name || "—", "Booking No.", docModel.orderId || "—"],
      ["Contact No.", docModel.customer.phone || "—", "PO No.", docModel.poNumber || "Not raised"],
      ["Place of supply", docModel.customer.location || "—", "PO Date", docModel.poDate ? fmtDate(docModel.poDate) : "—"],
      ["GST No.", docModel.customer.gstNumber || "—", "Payment Term", docModel.paymentTerm || "—"],
      ["Shop No.", docModel.customer.shopNumber || "—", "Supply By", docModel.promiseDate ? fmtDate(docModel.promiseDate) : "—"],
    ];
    // Internal copies name the schedule; the adapter leaves it null otherwise.
    if (docModel.priceTypeLabel) {
      info.push(["Vendor Code", docModel.customer.vendorCode || "—", "Price Type", docModel.priceTypeLabel]);
    } else if (docModel.customer.vendorCode) {
      info.push(["Vendor Code", docModel.customer.vendorCode, "", ""]);
    }

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

    /* ── Lines ────────────────────────────────────────────────────────────── */
    const head = [
      "Sr.", "Item Code", "Ko-ken Code", "Qty",
      ...(hasMoney ? ["Price", "Total"] : []),
      ...(docModel.showBoxNo ? ["Box"] : []),
    ];
    const body = docModel.lines.map((l) => [
      l.sr,
      l.itemCode || "—",
      l.skuCode,
      l.quantity,
      ...(hasMoney ? [money(l.unitPrice), money(l.amount)] : []),
      ...(docModel.showBoxNo ? [l.boxNo || "—"] : []),
    ]);

    const foot = [[
      { content: "Total", colSpan: 3, styles: { halign: "right", fontStyle: "bold" } },
      { content: String(docModel.totals.quantity), styles: { halign: "right", fontStyle: "bold" } },
      ...(hasMoney ? [
        { content: "", styles: {} },
        { content: money(docModel.totals.amount), styles: { halign: "right", fontStyle: "bold" } },
      ] : []),
      ...(docModel.showBoxNo ? [{ content: "", styles: {} }] : []),
    ]];

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
      columnStyles: {
        0: { cellWidth: 10, halign: "right" },
        1: { cellWidth: 34, font: "courier" },
        2: { cellWidth: 34, font: "courier" },
        3: { cellWidth: 14, halign: "right" },
        ...(hasMoney ? { 4: { halign: "right" }, 5: { halign: "right" } } : {}),
      },
      didDrawPage: () => {
        const pageH = pdf.internal.pageSize.getHeight();
        pdf.setDrawColor(226, 232, 240).setLineWidth(0.3);
        pdf.line(margin, pageH - 16, pageW - margin, pageH - 16);
        pdf.setFont("helvetica", "normal").setFontSize(7).setTextColor(...SLATE);
        pdf.text(
          hasMoney
            ? "Amounts are in Indian Rupees and exclude any applicable taxes."
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
