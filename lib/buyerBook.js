/** Buyer Book: [{ Names: ['Abid', 'YKB'], Numbers: ['9876543210'] }].
 * The first name is the display/resume identity; all names match auction rows.
 * Legacy keyed books remain readable.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_BOOK = [];

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

  const map = new Map();
  const legacyNames = new Set();
  const fullNameCounts = new Map();
  if (!Array.isArray(parsed)) for (const [name, data] of Object.entries(parsed)) {
    for (const n of [name, ...list(data.aliases)]) legacyNames.add(n.toUpperCase());
    const full = String(data.fullName || '').trim().toUpperCase();
    fullNameCounts.set(full, (fullNameCounts.get(full) || 0) + 1);
  }
  const rows = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([name, data]) => ({
    Names: [...new Set([name, ...list(data.aliases), (fullNameCounts.get(String(data.fullName || '').trim().toUpperCase()) === 1 && !legacyNames.has(String(data.fullName || '').trim().toUpperCase()) ? data.fullName : '')].filter(Boolean))],
    Numbers: data.phones ?? data.phone,
  }));
  const used = new Set();
  for (const row of rows) {
    const names = [...new Map(list(row.Names).map(n => [n.toUpperCase(), n])).values()];
    if (!names.length) throw new Error('Each buyer needs at least one name.');
    for (const name of names) {
      if (used.has(name.toUpperCase())) throw new Error('Duplicate buyer name: ' + name);
      used.add(name.toUpperCase());
    }
    const phones = [...new Set(list(row.Numbers).map(p => {
      const digits = p.replace(/\D/g, '');
      return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
    }).filter(Boolean))];
    map.set(names[0].toUpperCase(), {
      shortname: names[0], fullName: names[0], aliases: names.slice(1),
      phones, phone: phones[0] || '', Names: names, Numbers: phones,
    });
  }
  return map;
}

function lookup(book, shortname) {
  if (!shortname) return null;
  const key = String(shortname).toUpperCase().trim();
  return book.get(key) || [...book.values()].find(b => b.aliases.some(a => a.toUpperCase() === key)) || null;
}

function list(value) {
  return (Array.isArray(value) ? value : String(value || '').split(/[,;\n]/)).map(v => String(v).trim()).filter(Boolean);
}

function revision(dataDir) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(bookPath(dataDir))).digest('hex');
}

function saveBook(dataDir, buyers, expectedRevision) {
  if (!Array.isArray(buyers)) throw new Error('Buyer list is required.');
  if (expectedRevision !== revision(dataDir)) throw new Error('Buyer book changed since you opened it. Reload the editor before saving.');
  const book = [];
  const names = new Set();
  for (const buyer of buyers) {
    const buyerNames = [...new Map(list(buyer?.Names).map(n => [n.toUpperCase(), n])).values()];
    const shortname = buyerNames[0] || '';
    const aliases = buyerNames.slice(1);
    const rawPhones = list(buyer?.Numbers);
    const phones = [];
    for (const name of [shortname, ...aliases]) {
      if (names.has(name.toUpperCase())) throw new Error(`Duplicate buyer name or alias: ${name}`);
      if (name.length > 60) throw new Error('Buyer names must be at most 60 characters.');
      names.add(name.toUpperCase());
    }
    if (!shortname || shortname.length > 60) throw new Error('Each buyer needs a shortname (up to 60 characters).');
    for (let phone of rawPhones) {
    if (phone && !/^[+\d\s()-]+$/.test(phone)) throw new Error(`Invalid phone number for ${shortname}.`);
    phone = phone.replace(/\D/g, '');
    if (phone.length === 12 && phone.startsWith('91')) phone = phone.slice(2);
    if (phone && !/^[6-9]\d{9}$/.test(phone)) throw new Error(`Use a 10-digit Indian mobile number for ${shortname}, or leave it blank.`);
    if (phone && !phones.includes(phone)) phones.push(phone);
    }
    book.push({ Names: buyerNames, Numbers: phones });
  }
  const file = bookPath(dataDir);
  fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file + '.tmp', JSON.stringify(book, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
  return revision(dataDir);
}

module.exports = { loadBook, lookup, ensureBookExists, bookPath, revision, saveBook };
