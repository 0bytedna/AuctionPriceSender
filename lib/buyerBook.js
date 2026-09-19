/**
 * Buyer book — maps buyer shortnames (e.g. "PT", "KHBY") to full name + phone.
 *
 * The book is stored as JSON at ./data/buyer_book.json. Edit it manually in
 * Notepad. Format:
 *
 *   {
 *     "PT":     { "fullName": "Pavanagouda Talikoti", "phone": "9876543210" },
 *     "KHBY":   { "fullName": "Khanderao Bayalkar",   "phone": "9123456789" },
 *     "RUNWAL": { "fullName": "Runwal Traders",       "phone": "8456712345" }
 *   }
 *
 * Lookups are case-insensitive on the shortname (so "pt", "PT", "Pt" all match).
 * Phone numbers are stored as 10-digit Indian numbers without country code;
 * the send pipeline adds "91" automatically.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_BOOK = {
  // A few examples so the user has something to start from. Replace these.
  "EXAMPLE_BUYER_1": { "fullName": "Example Buyer 1", "phone": "9876543210" },
  "EXAMPLE_BUYER_2": { "fullName": "Example Buyer 2", "phone": "9123456789" }
};

function bookPath(dataDir) {
  return path.join(dataDir, 'buyer_book.json');
}

function ensureBookExists(dataDir) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const p = bookPath(dataDir);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, JSON.stringify(DEFAULT_BOOK, null, 2), 'utf8');
  }
}

function loadBook(dataDir) {
  ensureBookExists(dataDir);
  const raw = fs.readFileSync(bookPath(dataDir), 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`buyer_book.json has invalid JSON: ${e.message}`);
  }

  // Build a case-insensitive lookup map. Keep original-case shortname for display.
  const map = new Map();
  for (const [shortname, data] of Object.entries(parsed)) {
    if (!data || typeof data !== 'object') continue;
    const phoneDigits = String(data.phone || '').replace(/\D/g, '');
    map.set(shortname.toUpperCase().trim(), {
      shortname: shortname.trim(),
      fullName: String(data.fullName || '').trim() || shortname,
      phone: phoneDigits, // may be empty if user hasn't filled it in
    });
  }
  return map;
}

function lookup(book, shortname) {
  if (!shortname) return null;
  return book.get(String(shortname).toUpperCase().trim()) || null;
}

module.exports = { loadBook, lookup, ensureBookExists, bookPath };
