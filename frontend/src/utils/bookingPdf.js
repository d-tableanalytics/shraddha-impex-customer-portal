import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

/**
 * The Sales Desk booking document — a formal, print-ready PDF of ONE booking.
 *
 * Distinct from exportUtils' generic table export on purpose: this is a sales
 * document with a letterhead, a structured information block, and a footer
 * that records who generated it and when. It renders only the booking it is
 * handed — the caller passes one shaped booking, so no other customer's rows
 * can appear in it.
 *
 * There are no Rate or Amount columns: the system holds no pricing (see the
 * costing note on the Product model), and a formal document with columns of
 * em dashes reads as an error. Add them back when costing lands.
 */

const BRAND_BLUE = [30, 58, 138]; // primary-900, matches the app chrome
const SLATE = [100, 116, 139];

const fmtDate = (d) => {
  const date = d ? new Date(d) : null;
  if (!date || Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

const fmtDateTime = (d) =>
  new Date(d).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

/** `Booking_BO-2026-000042_Shraddha_Traders.pdf` — safe on every filesystem. */
const safeFilename = (bookingNo, customer) =>
  `Booking_${bookingNo}_${customer || "Customer"}`
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/_$/, "") + ".pdf";

/**
 * The app logo as a PNG data URL, decoded through a canvas because jsPDF
 * cannot read AVIF. Resolves null on any failure — the document falls back to
 * a text-only letterhead rather than refusing to generate.
 */
const loadLogo = () =>
  new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext("2d").drawImage(img, 0, 0);
          resolve({
            dataUrl: canvas.toDataURL("image/png"),
            ratio: img.naturalWidth / img.naturalHeight,
          });
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = "/logo.avif";
    } catch {
      resolve(null);
    }
  });

/**
 * @param {object} booking  the shaped sales-desk booking (orderId, customer,
 *                          phoneNumber, shopNumber, poNumber, poDate, locked,
 *                          date, status, lines)
 * @param {string} generatedBy  display name of the signed-in desk user
 * @returns {Promise<boolean>} false when generation failed
 */
export const downloadBookingPdf = async (booking, { generatedBy = "—" } = {}) => {
  try {
    const doc = new jsPDF(); // A4 portrait, mm
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 14;

    const poRaised = Boolean(booking.locked)
      && String(booking.poNumber ?? "").trim() !== ""
      && booking.poNumber !== "-";

    // ── Letterhead ─────────────────────────────────────────────────────────
    const logo = await loadLogo();
    let y = 16;
    if (logo) {
      const h = 12;
      doc.addImage(logo.dataUrl, "PNG", margin, y - 8, h * logo.ratio, h);
      y += 8;
    } else {
      doc.setFont("helvetica", "bold").setFontSize(16).setTextColor(...BRAND_BLUE);
      doc.text("SHRADDHA IMPEX", margin, y);
      y += 4;
    }
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...SLATE);
    doc.text("Sales Desk — Booking Document", margin, y);

    // Document identity, right-aligned: the booking number is the headline.
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...SLATE);
    doc.text("BOOKING NO.", pageW - margin, 12, { align: "right" });
    doc.setFont("courier", "bold").setFontSize(15).setTextColor(...BRAND_BLUE);
    doc.text(String(booking.orderId || "—"), pageW - margin, 19, { align: "right" });
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...SLATE);
    doc.text(`Status: ${booking.status || "—"}`, pageW - margin, 24.5, { align: "right" });

    doc.setDrawColor(...BRAND_BLUE).setLineWidth(0.6);
    doc.line(margin, 28, pageW - margin, 28);

    // ── Information block ──────────────────────────────────────────────────
    // Two label/value columns. PO fields always occupy their slot — "Not
    // Raised" / "—" — so the reader never wonders whether a field was cut off.
    const info = [
      ["Customer Name", booking.customer || "—", "PO Number", poRaised ? booking.poNumber : "Not Raised"],
      ["Phone Number", booking.phoneNumber || "—", "PO Date", poRaised ? fmtDate(booking.poDate) : "—"],
      ["Location", booking.location || "—", "Booking Date", fmtDate(booking.date)],
      ["Shop No.", booking.shopNumber || "—", "", ""],
    ];
    autoTable(doc, {
      startY: 32,
      margin: { left: margin, right: margin },
      body: info,
      theme: "plain",
      styles: { fontSize: 9.5, cellPadding: { top: 1.6, bottom: 1.6, left: 0, right: 4 } },
      columnStyles: {
        0: { textColor: SLATE, cellWidth: 32 },
        1: { fontStyle: "bold", cellWidth: 62 },
        2: { textColor: SLATE, cellWidth: 30 },
        3: { fontStyle: "bold" },
      },
    });

    // ── Booking lines ──────────────────────────────────────────────────────
    const lines = Array.isArray(booking.lines) ? booking.lines : [];
    const bookingDate = fmtDate(booking.date);
    const rows = lines.map((l, i) => {
      const qty = l.confirmedQty ?? l.quantity ?? 0;
      const description = [l.brand, l.category, l.boxNo ? `Box ${l.boxNo}` : null]
        .filter(Boolean).join(" — ") || "—";
      const status = (l.pendingQty || 0) > 0
        ? `${booking.status || "—"} · ${l.pendingQty} on indent`
        : booking.status || "—";
      return [
        i + 1,
        String(booking.orderId || "—"),
        l.msilCode ? `${l.skuCode}\nMSIL: ${l.msilCode}` : l.skuCode,
        description,
        qty,
        bookingDate,
        status,
      ];
    });
    const totalQty = lines.reduce((n, l) => n + (l.confirmedQty ?? l.quantity ?? 0), 0);
    const totalIndent = lines.reduce((n, l) => n + (l.pendingQty || 0), 0);

    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 4,
      margin: { left: margin, right: margin, bottom: 24 },
      theme: "grid",
      head: [[
        "Sr. No.", "Booking / Unit No.", "Product / Item", "Description",
        "Qty", "Booking Date", "Status",
      ]],
      body: rows,
      foot: [[
        { content: "Total", colSpan: 4, styles: { halign: "right", fontStyle: "bold" } },
        { content: String(totalQty), styles: { halign: "right", fontStyle: "bold" } },
        { content: totalIndent > 0 ? `${totalIndent} pcs on indent` : "", colSpan: 2, styles: { fontSize: 7.5 } },
      ]],
      styles: { fontSize: 8, cellPadding: 2, valign: "middle" },
      headStyles: { fillColor: BRAND_BLUE, fontSize: 7.5, halign: "left" },
      footStyles: { fillColor: [244, 246, 248], textColor: [15, 23, 42] },
      columnStyles: {
        0: { cellWidth: 12, halign: "right" },
        1: { cellWidth: 34, font: "courier" },
        2: { cellWidth: 32 },
        4: { cellWidth: 14, halign: "right" },
        5: { cellWidth: 24 },
      },
      // Footer on EVERY page, drawn inside the reserved bottom margin so a
      // long booking that spills over pages keeps its provenance on each one.
      didDrawPage: () => {
        const pageH = doc.internal.pageSize.getHeight();
        doc.setDrawColor(226, 232, 240).setLineWidth(0.3);
        doc.line(margin, pageH - 16, pageW - margin, pageH - 16);
        doc.setFont("helvetica", "normal").setFontSize(7.5).setTextColor(...SLATE);
        doc.text(
          `Generated on ${fmtDateTime(new Date())}  ·  Generated by ${generatedBy}`,
          margin, pageH - 11,
        );
        doc.text(
          `Page ${doc.internal.getCurrentPageInfo().pageNumber} of {tp}`,
          pageW - margin, pageH - 11, { align: "right" },
        );
        doc.setFontSize(7).setTextColor(180);
        doc.text(
          "This document reflects the booking as recorded on the Sales Desk at the time of generation.",
          margin, pageH - 7,
        );
      },
    });

    // Resolve the {tp} placeholder now that the page count is known.
    if (typeof doc.putTotalPages === "function") doc.putTotalPages("{tp}");

    doc.save(safeFilename(booking.orderId, booking.customer));
    return true;
  } catch (err) {
    console.error("Booking PDF generation failed:", err);
    return false;
  }
};

export default downloadBookingPdf;
