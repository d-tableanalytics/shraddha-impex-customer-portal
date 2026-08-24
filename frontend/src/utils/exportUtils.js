import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { escapeHtml } from './escapeHtml';

// Resolve a cell value for a column, honouring an optional col.format(value, item).
const cellValue = (item, col) => {
  const raw = item[col.key];
  if (col.format) return col.format(raw, item);
  return raw ?? 'N/A';
};

// Reusable function to format data for export
const formatDataForExport = (data, columns) => {
  return data.map(item => {
    const row = {};
    columns.forEach(col => {
      row[col.label] = cellValue(item, col);
    });
    return row;
  });
};

export const exportToExcel = (data, columns, filename = 'export') => {
  try {
    const formattedData = formatDataForExport(data, columns);
    const worksheet = XLSX.utils.json_to_sheet(formattedData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
    XLSX.writeFile(workbook, `${filename}_${new Date().getTime()}.xlsx`);
    return true;
  } catch (error) {
    console.error("Export to Excel failed:", error);
    return false;
  }
};

// `meta` is an optional list of reference lines ("Location: Manesar",
// "Phone: …") printed under the title — the pick list carries them so the
// person holding the sheet does not have to look anything up.
export const exportToPDF = (data, columns, title = 'Report', filename = 'export', meta = []) => {
  try {
    const doc = new jsPDF();

    // Add Title
    doc.setFontSize(18);
    doc.text(title, 14, 22);
    doc.setFontSize(11);
    doc.setTextColor(100);
    doc.text(`Generated on: ${new Date().toLocaleString()}`, 14, 30);
    meta.forEach((line, i) => doc.text(String(line), 14, 37 + i * 6));

    // Table data
    const tableColumn = columns.map(col => col.label);
    const tableRows = data.map(item => columns.map(col => String(cellValue(item, col))));

    // jspdf-autotable v5 removed the doc.autoTable() prototype API.
    autoTable(doc, {
      head: [tableColumn],
      body: tableRows,
      startY: 40 + meta.length * 6,
      theme: 'grid',
      styles: { fontSize: 8 },
      headStyles: { fillColor: [30, 58, 138] }, // primary-900 color
    });

    doc.save(`${filename}_${new Date().getTime()}.pdf`);
    return true;
  } catch (error) {
    console.error("Export to PDF failed:", error);
    return false;
  }
};

export const printData = (data, columns, title = 'Report', meta = []) => {
  try {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      console.error("Popup blocked! Please allow popups for this site.");
      return false;
    }

    // Every interpolated value is escaped. Inventory codes routinely contain
    // <, > and &, and unescaped they are parsed as markup — the printed cell
    // then shows something other than the value it came from.
    const safeTitle = escapeHtml(title);
    const metaLines = meta
      .map((line) => `<p class="meta">${escapeHtml(line)}</p>`)
      .join('');
    const tableHeaders = columns.map(col => `<th>${escapeHtml(col.label)}</th>`).join('');
    const tableRows = data.map(item => {
      const rowData = columns.map(col => `<td>${escapeHtml(cellValue(item, col))}</td>`).join('');
      return `<tr>${rowData}</tr>`;
    }).join('');

    const htmlContent = `
      <html>
        <head>
          <title>${safeTitle}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            h1 { color: #1e3a8a; font-size: 24px; margin-bottom: 5px; }
            p { color: #64748b; font-size: 12px; margin-bottom: 20px; }
            p.meta { color: #0f172a; font-weight: bold; margin-bottom: 4px; }
            table { width: 100%; border-collapse: collapse; font-size: 12px; }
            th, td { border: 1px solid #e2e8f0; padding: 8px; text-align: left; }
            th { background-color: #f8fafc; font-weight: bold; color: #0f172a; }
            tr:nth-child(even) { background-color: #f8fafc; }
            @media print {
              @page { margin: 1cm; }
            }
          </style>
        </head>
        <body>
          <h1>${safeTitle}</h1>
          ${metaLines}
          <p>Generated on: ${new Date().toLocaleString()}</p>
          <table>
            <thead><tr>${tableHeaders}</tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
          <script>
            window.onload = function() { window.print(); window.close(); }
          </script>
        </body>
      </html>
    `;

    printWindow.document.write(htmlContent);
    printWindow.document.close();
    return true;
  } catch (error) {
    console.error("Print failed:", error);
    return false;
  }
};
