/**
 * Pure functions: Excel → parsed lots → farmer groups → message strings.
 * No I/O side effects beyond reading the Excel file itself.
 */

const fs = require('fs');
const XLSX = require('xlsx');

function normalizeName(name) {
  return String(name || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function normalizePhone(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  let p = String(raw).replace(/[^\d]/g, '');
  if (p.length === 12 && p.startsWith('91')) p = p.slice(2);
  if (p.length === 11 && p.startsWith('0'))  p = p.slice(1);
  if (p.length !== 10) return null;
  if (!'6789'.includes(p[0])) return null;
  return '91' + p;
}

function formatRate(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatQty(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v).trim();
}

// Returns true if a row's Y/N column means we should include this lot in the
// buyer's message. CONFIRM and PENDING both included; CANCEL and blank excluded.
function isIncludedForBuyer(rawValue) {
  if (rawValue === null || rawValue === undefined) return false;
  const s = String(rawValue).trim().toUpperCase();
  return s === 'CONFIRM' || s === 'CONFIRMED' || s === 'PENDING' || s === 'Y' || s === 'YES';
}

// Normalised label as it should appear in the buyer message (column 1).
// Returns 'CONFIRM' for confirmed/yes/y, 'PENDING' for pending, '' otherwise.
function normalizedYN(rawValue) {
  if (rawValue === null || rawValue === undefined) return '';
  const s = String(rawValue).trim().toUpperCase();
  if (s === 'CONFIRM' || s === 'CONFIRMED' || s === 'Y' || s === 'YES') return 'CONFIRM';
  if (s === 'PENDING') return 'PENDING';
  return s;  // pass-through any other value as-is, in case the user uses a custom label
}

function loadLots(excelPath, sheetName) {
  if (!fs.existsSync(excelPath)) throw new Error(`Excel file not found: ${excelPath}`);
  const wb = XLSX.readFile(excelPath);
  let target = sheetName || wb.SheetNames[0];
  if (!wb.Sheets[target]) {
    const match = wb.SheetNames.find(s => s.trim() === String(target).trim());
    if (!match) throw new Error(`Sheet "${target}" not found. Available: ${wb.SheetNames.map(s => `"${s}"`).join(', ')}`);
    target = match;
  }
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[target], { defval: null });
  const lots = rows
    .filter(r => r.Shetkari && r.Marka)
    .map(r => ({
      farmer:          normalizeName(r.Shetkari),
      marka:           String(r.Marka || '').trim(),
      qty:             formatQty(r.Qty),
      farmerRate:      formatRate(r['Farmer Rate']),
      contactRaw:      r.CONTACT,
      // Buyer-side fields
      ynStatus:        normalizedYN(r['Y/N']),                                          // 'CONFIRM' | 'PENDING' | ''
      includedForBuyer:isIncludedForBuyer(r['Y/N']),                                    // true if we should send this row
      sNo:             r['S.No'] !== null && r['S.No'] !== undefined ? String(r['S.No']).trim() : '',
      buyerShortname:  r["Buyer's Name"] ? String(r["Buyer's Name"]).trim() : null,
      remarks:         r['P'] !== null && r['P'] !== undefined && String(r['P']).trim()
                         ? String(r['P']).trim()
                         : (r['Remarks'] !== null && r['Remarks'] !== undefined && String(r['Remarks']).trim()
                              ? String(r['Remarks']).trim()
                              : ''),
      location:        r.Location ? String(r.Location).trim() : '',
      buyerRate:       formatRate(r["Buyer's Rate"]),
    }));
  return { sheetName: target, sheetNames: wb.SheetNames, lots };
}

function groupByFarmer(lots) {
  const m = new Map();
  for (const lot of lots) {
    if (!m.has(lot.farmer)) m.set(lot.farmer, { farmer: lot.farmer, phones: [], lots: [] });
    const g = m.get(lot.farmer);
    g.lots.push(lot);
    const maybe = normalizePhone(lot.contactRaw);
    if (maybe && !g.phones.includes(maybe)) g.phones.push(maybe);
  }
  return m;
}

function findDuplicatePhones(grouped) {
  const byPhone = new Map();
  for (const g of grouped.values()) {
    for (const phone of g.phones) {
      if (!byPhone.has(phone)) byPhone.set(phone, new Set());
      byPhone.get(phone).add(g.farmer);
    }
  }
  const dupes = [];
  for (const [phone, farmers] of byPhone) {
    if (farmers.size > 1) dupes.push({ phone, farmers: [...farmers] });
  }
  return dupes;
}

function buildMessage(farmerName, lots, date, firmName) {
  let msg = ``;
  for (const l of lots) {
    const rateText = l.farmerRate !== null && l.farmerRate !== undefined ? `₹${l.farmerRate}` : '—';
    const qtyText  = l.qty !== null && l.qty !== undefined ? `${l.qty}` : '—';
    msg += `${l.marka} — ${qtyText} — ${rateText}\n`;
  }
  return msg;
}

function todayDDMMYYYY() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/**
 * Given a parsed lot set and a date, produce a "preview" —
 * list of farmers with their phones and rendered message text,
 * plus lists of warnings (missing phones, duplicate phones, multi-phone farmers).
 */
function buildPreview(lots, date, firmName) {
  const grouped = groupByFarmer(lots);
  const previews = [];
  const missing = [];
  const multiPhone = [];
  for (const g of grouped.values()) {
    const message = buildMessage(g.farmer, g.lots, date, firmName);
    if (!g.phones.length) {
      missing.push({
        farmer: g.farmer,
        lotCount: g.lots.length,
        lots: g.lots.map(l => ({ marka: l.marka, qty: l.qty, farmerRate: l.farmerRate })),
      });
    } else {
      if (g.phones.length > 1) multiPhone.push({ farmer: g.farmer, phones: g.phones });
      previews.push({
        farmer: g.farmer,
        phones: g.phones,
        lotCount: g.lots.length,
        lots: g.lots.map(l => ({
          marka: l.marka,
          qty: l.qty,
          farmerRate: l.farmerRate,
        })),
        message,
      });
    }
  }
  const duplicates = findDuplicatePhones(grouped);
  return { previews, missing, multiPhone, duplicates, farmerCount: grouped.size, lotCount: lots.length };
}

function buildBuyerMessage(buyerFullName, lots, date, firmName, buyerShortname) {
  // Format: {Y/N} | {S.NO} | {BUYER (REMARKS)} | {MARKA} | {QTY} | {LOCATION} | {BUYER RATE}
  // No greeting, no footer — minimal style matching the Shetkari format.
  const buyerLabel = buyerShortname || buyerFullName || '';
  let msg = '';
  for (const l of lots) {
    const yn       = l.ynStatus || '';
    const sNo      = l.sNo || '';
    const remarks  = l.remarks ? `(${l.remarks})` : '';
    const buyerCol = remarks ? `${buyerLabel} ${remarks}` : buyerLabel;
    const qty      = (l.qty !== null && l.qty !== undefined) ? l.qty : '';
    const loc      = l.location || '';
    const rate     = (l.buyerRate !== null && l.buyerRate !== undefined) ? l.buyerRate : '';
    msg += `${yn} | ${sNo} | ${buyerCol} | ${l.marka} | ${qty} | ${loc} | ${rate}\n`;
  }
  return msg;
}

/**
 * Group included-for-buyer lots by buyer shortname.
 * Skips: rows where Y/N is CANCEL or blank; rows without buyerShortname.
 *
 * Within each buyer's lots, sorts so that all rows sharing the same sub-buyer
 * (Remarks) appear together. Order: no-remarks first, then alphabetical
 * by remarks (B, G, JR, RP, S, ...). Within each group, original sheet
 * order is preserved (stable sort).
 */
function groupByBuyer(lots) {
  const m = new Map();
  for (const lot of lots) {
    if (!lot.includedForBuyer) continue;
    if (!lot.buyerShortname) continue;
    const key = lot.buyerShortname.toUpperCase();
    if (!m.has(key)) m.set(key, { shortname: lot.buyerShortname, lots: [] });
    m.get(key).lots.push(lot);
  }
  // Stable-sort each buyer's lots by sub-buyer (remarks).
  // Empty remarks come first; non-empty sorted alphabetically (case-insensitive).
  for (const g of m.values()) {
    g.lots.sort((a, b) => {
      const ra = (a.remarks || '').toUpperCase();
      const rb = (b.remarks || '').toUpperCase();
      if (ra === rb) return 0;
      if (ra === '') return -1;   // no-remarks first
      if (rb === '') return  1;
      return ra < rb ? -1 : 1;
    });
  }
  return m;
}

/**
 * Build the preview for the Vyapari (buyer) view.
 * @param lots — parsed lots from loadLots
 * @param buyerBook — Map from loadBook() in lib/buyerBook.js
 * @param date, firmName — same as buildPreview
 *
 * Returns:
 *   previews:  buyers found in book + with phone (sendable)
 *   unknown:   buyers found in sheet but NOT in the buyer book (skipped, shown as warning)
 *   noPhone:   buyers in book but with empty phone (skipped, shown as warning)
 *   buyerCount: total distinct buyers seen (including unknown/noPhone)
 *   confirmedLotCount: number of CONFIRM rows with a buyerShortname
 */
function buildBuyerPreview(lots, buyerBook, date, firmName) {
  const grouped = groupByBuyer(lots);
  const previews = [];
  const unknown = [];
  const noPhone = [];
  let includedLotCount = 0;

  for (const [key, g] of grouped) {
    includedLotCount += g.lots.length;
    const entry = buyerBook.get(key);

    if (!entry) {
      unknown.push({
        shortname: g.shortname,
        lotCount: g.lots.length,
        lots: g.lots.map(toLotSummary),
      });
      continue;
    }
    if (!entry.phone) {
      noPhone.push({
        shortname: g.shortname,
        fullName: entry.fullName,
        lotCount: g.lots.length,
        lots: g.lots.map(toLotSummary),
      });
      continue;
    }

    // Sendable buyer: known + has phone
    const phoneE164 = entry.phone.length === 10 && '6789'.includes(entry.phone[0])
      ? '91' + entry.phone
      : entry.phone; // fallback — let the send loop fail informatively
    const message = buildBuyerMessage(entry.fullName, g.lots, date, firmName, g.shortname);
    previews.push({
      shortname: g.shortname,
      fullName: entry.fullName,
      phones: [phoneE164],
      lotCount: g.lots.length,
      lots: g.lots.map(toLotSummary),
      message,
    });
  }

  return {
    previews,
    unknown,
    noPhone,
    buyerCount: grouped.size,
    // Kept old name for frontend compatibility, but it now counts CONFIRM + PENDING combined
    confirmedLotCount: includedLotCount,
    includedLotCount,
    totalLotCount: lots.length,
    skippedLotCount: lots.length - includedLotCount,
  };
}

function toLotSummary(l) {
  return {
    farmer: l.farmer,
    marka: l.marka,
    qty: l.qty,
    buyerRate: l.buyerRate,
    farmerRate: l.farmerRate,
    ynStatus: l.ynStatus,
    sNo: l.sNo,
    remarks: l.remarks,
    location: l.location,
  };
}

module.exports = {
  loadLots,
  groupByFarmer,
  groupByBuyer,
  findDuplicatePhones,
  buildMessage,
  buildBuyerMessage,
  buildPreview,
  buildBuyerPreview,
  todayDDMMYYYY,
  normalizePhone,
  normalizeName,
  isIncludedForBuyer,
};
