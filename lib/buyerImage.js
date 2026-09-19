/**
 * buyerImage — renders a buyer's confirmed lots as a PNG buffer.
 *
 * Output: a clean tabular image showing firm name, date, and one row per lot.
 * Used by the Vyapari WhatsApp send to attach an image instead of plain text.
 *
 * No external services. No Chromium. Just native canvas drawing via
 * @napi-rs/canvas (pre-built binaries, ~3MB, works on any modern Windows/Linux/Mac).
 *
 * Usage:
 *   const png = renderBuyerImage({
 *     buyerShortname: 'MROUND',
 *     date: '20-04-2026',
 *     firmName: 'Pavan Cold Storage',
 *     lots: [{ ynStatus, sNo, remarks, marka, qty, location, buyerRate }, ...],
 *   });
 *   // png is a Buffer suitable for fs.writeFileSync or Baileys' { image: png } payload
 */

const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

// Register a specific family so native font fallback cannot select Impact.
const path = require('path');
const fontDir = path.join(process.env.WINDIR || 'C:/Windows', 'Fonts');
for (const file of ['arial.ttf', 'arialbd.ttf']) {
  const fontPath = path.join(fontDir, file);
  if (require('fs').existsSync(fontPath)) GlobalFonts.registerFromPath(fontPath, 'BuyerArial');
}
const FONT = 'BuyerArial, Arial, DejaVu Sans, sans-serif';

function cellValues(l, buyer) {
  return [l.ynStatus, l.sNo, l.marka, l.qty, l.location, l.buyerRate, buyer, l.remarks]
    .map(v => v == null ? '' : String(v));
}
function wrapText(ctx, value, width) {
  const lines = [];
  for (const paragraph of value.split(/\r?\n/)) {
    let line = '';
    for (const char of paragraph) {
      if (line && ctx.measureText(line + char).width > width) {
        lines.push(line); line = '';
      }
      line += char;
    }
    lines.push(line);
  }
  return lines;
}

// Layout constants — tweak these to adjust spacing/density
const PAD = 16;
const HEADER_BAND = 70;
const ROW_HEIGHT = 26;
const TABLE_HEADER_HEIGHT = 32;
const FOOTER_BAND = 30;

// Diagonal background watermark drawn behind the data rows.
// Set to '' to disable the watermark entirely.
const WATERMARK_TEXT = 'PT';

// Column widths in pixels (at 1× — actual canvas is rendered at SCALE).
// Sized to fit real-world content with a little breathing room.
const COL_WIDTHS  = [92, 56, 110, 55, 150, 85, 95, 110];
const COL_TITLES  = ['Y/N', 'S.No', 'Marka', 'Qty', 'Location', 'Rate', 'Buyer', 'Sub'];
const COL_BOLD_IDX = new Set([0, 5]);    // Y/N (idx 0) + Rate (idx 5): rendered bold

// Render at 2× scale for crisp text on high-DPI screens. Canvas dimensions
// scale up; positions and font sizes don't need to change because we apply
// a transform once.
const SCALE = 2;

// Colors — match the website's warm cream theme
const C = {
  bg:           '#f7f4ee',
  bgRowAlt:     '#fdfbf6',
  bgTableHead:  '#efeae0',
  textPrimary:  '#1d1a14',
  textMuted:    '#6a6456',
  border:       '#c9c1b1',
  borderLight:  '#e2dcd0',
};

function renderBuyerImage({ buyerShortname, date, firmName, lots }) {
  if (!Array.isArray(lots) || lots.length === 0) {
    throw new Error('renderBuyerImage: at least one lot is required');
  }

  const tableWidth = COL_WIDTHS.reduce((a, b) => a + b, 0);
  const w = tableWidth + PAD * 2;
  const measure = createCanvas(1, 1).getContext('2d');
  const rows = lots.map(l => {
    const cells = cellValues(l, buyerShortname).map((value, i) => {
      measure.font = (COL_BOLD_IDX.has(i) ? 'bold ' : '') + '15px ' + FONT;
      return wrapText(measure, value, COL_WIDTHS[i] - 12);
    });
    return { cells, height: Math.max(ROW_HEIGHT, Math.max(...cells.map(c => c.length)) * 19 + 12) };
  });
  const tableHeight = TABLE_HEADER_HEIGHT + rows.reduce((sum, row) => sum + row.height, 0);
  const h = PAD + HEADER_BAND + tableHeight + FOOTER_BAND + PAD;

  // Render at 2× pixel density for sharper text. We scale the canvas up
  // and apply a uniform transform so all our coordinate math stays in
  // logical (1×) units.
  const canvas = createCanvas(w * SCALE, h * SCALE);
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  // Better text rendering on the upscaled bitmap
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Background
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);

  // Header band: firm name (left), date (right)
  ctx.fillStyle = C.textPrimary;
  ctx.font = '600 18px ' + FONT;
  ctx.textAlign = 'left';
  ctx.fillText(firmName || '', PAD, PAD + 24, tableWidth);

  ctx.fillStyle = C.textMuted;
  ctx.font = '15px ' + FONT;
  ctx.textAlign = 'right';
  ctx.fillText(date || '', w - PAD, PAD + 50);

  const tableY = PAD + HEADER_BAND;

  // Table header background
  ctx.fillStyle = C.bgTableHead;
  ctx.fillRect(PAD, tableY, tableWidth, TABLE_HEADER_HEIGHT);

  // Table header titles — all centered
  ctx.fillStyle = C.textMuted;
  ctx.font = '600 13px ' + FONT;
  ctx.textAlign = 'center';
  let x = PAD;
  for (let i = 0; i < COL_TITLES.length; i++) {
    const tx = x + COL_WIDTHS[i] / 2;
    ctx.fillText(COL_TITLES[i].toUpperCase(), tx, tableY + 21);
    x += COL_WIDTHS[i];
  }

  let rowY = tableY + TABLE_HEADER_HEIGHT;
  // Pass 1 — row alternating backgrounds (drawn before watermark so they don't cover it)
  for (let r = 0; r < lots.length; r++) {
    const y = rowY;
    rowY += rows[r].height;
    if (r % 2 === 0) {
      ctx.fillStyle = C.bgRowAlt;
      ctx.fillRect(PAD, y, tableWidth, rows[r].height);
    }
  }

  // Watermark — diagonal text centered behind the data, large and faint.
  // Skipped entirely if WATERMARK_TEXT is empty.
  if (WATERMARK_TEXT) {
    ctx.save();
    const cx = w / 2;
    const cyWm = tableY + tableHeight / 2;
    ctx.translate(cx, cyWm);
    ctx.rotate(-Math.PI / 6);  // -30 degrees
    ctx.font = '700 220px ' + FONT;
    ctx.fillStyle = 'rgba(29, 26, 20, 0.02)';  // 2% opacity of textPrimary
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(WATERMARK_TEXT, 0, 0);
    ctx.restore();
    // Reset text baseline since we set it above (other code uses default 'alphabetic')
    ctx.textBaseline = 'alphabetic';
  }

  rowY = tableY + TABLE_HEADER_HEIGHT;
  // Pass 2 — row borders + cell text on top of the watermark
  for (let r = 0; r < lots.length; r++) {
    const l = lots[r];
    const y = rowY;
    rowY += rows[r].height;

    // Bottom border of the row
    ctx.strokeStyle = C.borderLight;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, y + rows[r].height - 0.5);
    ctx.lineTo(PAD + tableWidth, y + rows[r].height - 0.5);
    ctx.stroke();

    ctx.fillStyle = C.textPrimary;
    const cells = rows[r].cells;

    let colX = PAD;
    for (let i = 0; i < cells.length; i++) {
      const isBold = COL_BOLD_IDX.has(i);
      ctx.font = (isBold ? 'bold ' : '') + '15px ' + FONT;
      ctx.textAlign = 'center';
      const tx = colX + COL_WIDTHS[i] / 2;
      cells[i].forEach((line, index) => ctx.fillText(line, tx, y + 21 + index * 19));
      colX += COL_WIDTHS[i];
    }
  }

  // Outer table border
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(PAD - 0.5, tableY - 0.5, tableWidth + 1, tableHeight + 1);

  // Footer: total lots and total quantity, right-aligned under the table.
  const totalQty = lots.reduce((sum, l) => {
    const n = Number(l.qty);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
  const lotWord = lots.length === 1 ? 'lot'   : 'lots';
  const boxWord = totalQty   === 1 ? 'box'   : 'boxes';
  const footerY = tableY + tableHeight + 22;
  ctx.fillStyle = C.textPrimary;
  ctx.font = '600 14px ' + FONT;
  ctx.textAlign = 'right';
  ctx.fillText(`${lots.length} ${lotWord},  ${totalQty} ${boxWord}`, w - PAD, footerY);

  return canvas.toBuffer('image/png');
}

module.exports = { renderBuyerImage };
