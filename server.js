/**
 * Auction Price Sender — Local Web Server
 *
 * Open http://localhost:3000 in your browser after running `npm start`.
 *
 * Endpoints:
 *   GET  /                    — web UI
 *   GET  /api/status          — WhatsApp + job status
 *   POST /api/upload          — upload Excel, returns parse result
 *   POST /api/preview         — build message previews (after upload)
 *   POST /api/send            — start a send job
 *   POST /api/job/pause-ack   — user's answer to 'not_on_whatsapp' pause: {action:'skip'|'stop'}
 *   POST /api/job/stop        — abort job
 *   POST /api/wa/reset        — clear auth_state (forces new QR)
 *
 * WebSocket events (via socket.io):
 *   'wa:state'     ({ state })
 *   'wa:qr'        ({ dataUrl })
 *   'wa:logged-out'
 *   'job:progress' (row)
 *   'job:log'      (row)
 *   'job:done'     (stats)
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server: IOServer } = require('socket.io');

const config = require('./config');
const excel = require('./lib/excel');
const { renderBuyerImage } = require('./lib/buyerImage');
const { WhatsAppClient } = require('./lib/whatsapp');
const { SendJob } = require('./lib/sendjob');
const { SmsClient } = require('./lib/sms');
const { SmsJob } = require('./lib/smsjob');
const buyerBookLib = require('./lib/buyerBook');

// Ensure dirs exist
const DATA_DIR = './data';
for (const d of [config.uploadDir, config.authFolder, DATA_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
buyerBookLib.ensureBookExists(DATA_DIR);

// ------------------ App / IO -----------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

app.use(express.json({ limit: '2mb' }));
// Disable browser caching for public files so CSS/JS edits show up immediately
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, file, cb) => cb(null, 'latest' + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xlsm|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx/.xlsm/.xls allowed'), ok);
  },
});

// ------------------ WhatsApp client (singleton) ----------------------------
const wa = new WhatsAppClient({ authFolder: config.authFolder });

let lastQrDataUrl = null;
wa.on('state', (s) => io.emit('wa:state', { state: s }));
wa.on('qr', async (qr) => {
  try {
    lastQrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    io.emit('wa:qr', { dataUrl: lastQrDataUrl });
  } catch (e) {
    console.error('QR render failed:', e.message);
  }
});
wa.on('connected', () => { lastQrDataUrl = null; });
wa.on('logged-out', () => { lastQrDataUrl = null; io.emit('wa:logged-out'); });
wa.on('disconnected', (reason) => console.log('WA disconnected:', reason));

// Start WhatsApp on boot (non-blocking)
wa.connect().catch(err => console.error('WA connect failed:', err.message));

// ------------------ SMS client (singleton) ---------------------------------
const sms = new SmsClient(config.sms || {});
let smsState = sms.isConfigured() ? 'checking' : 'unconfigured';

async function pingSms() {
  if (!sms.isConfigured()) {
    smsState = 'unconfigured';
    io.emit('sms:state', { state: smsState, error: sms.lastError });
    return;
  }
  const ok = await sms.ping();
  const newState = ok ? 'connected' : 'disconnected';
  if (newState !== smsState || sms.lastError) {
    smsState = newState;
    io.emit('sms:state', { state: smsState, error: sms.lastError });
  }
}
// Initial ping on boot, then every 15s
pingSms();
setInterval(pingSms, 15000);

// ------------------ CSV log ------------------------------------------------
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function appendLog(row) {
  const header = 'timestamp,date,farmer,phone,status,error\n';
  if (!fs.existsSync(config.logFile)) fs.writeFileSync(config.logFile, header);
  const line = [row.ts, row.date, row.farmer, row.phone || '', row.status, row.error || '']
    .map(csvEscape).join(',') + '\n';
  fs.appendFileSync(config.logFile, line);
}
function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}
function loadAlreadySent(dateStr, statusFilter = 'sent') {
  const sent = new Set();
  if (!fs.existsSync(config.logFile)) return sent;
  const text = fs.readFileSync(config.logFile, 'utf8');
  const lines = text.split(/\r?\n/).slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const [, date, farmer, phone, status] = parseCsvLine(line);
    if (date === dateStr && status === statusFilter && farmer && phone) sent.add(`${farmer}|${phone}`);
  }
  return sent;
}

// ------------------ Job state — separate slots for parallel WA + SMS --------
let currentWaJob = null;       // Shetkari WhatsApp
let currentSmsJob = null;      // Shetkari SMS
let currentVyWaJob = null;     // Vyapari WhatsApp
let currentVySmsJob = null;    // Vyapari SMS
let latestUpload = null;  // { path, sheetNames, chosenSheet, lots }

function jobSummary(j) {
  return j ? { running: j.running, current: j.current, stats: j.stats } : null;
}

function shetkariRunning() {
  return (currentWaJob && currentWaJob.running) || (currentSmsJob && currentSmsJob.running);
}

// ------------------ API ----------------------------------------------------
app.get('/api/status', (_req, res) => {
  res.json({
    wa:  { state: wa.state, qrDataUrl: lastQrDataUrl },
    sms: { state: smsState, configured: sms.isConfigured(), error: sms.lastError },
    upload: latestUpload ? {
      sheetNames: latestUpload.sheetNames,
      chosenSheet: latestUpload.chosenSheet,
      lotCount: latestUpload.lots.length,
    } : null,
    waJob:    jobSummary(currentWaJob),     // Shetkari WA (kept for backwards compat)
    smsJob:   jobSummary(currentSmsJob),    // Shetkari SMS
    vyWaJob:  jobSummary(currentVyWaJob),   // Vyapari WA
    vySmsJob: jobSummary(currentVySmsJob),  // Vyapari SMS
    firmName: config.firmName,
    googleSheetConfigured: !!(config.googleSheetUrl && config.googleSheetUrl.trim()),
  });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) throw new Error('No file uploaded');
    const sheet = req.body.sheet || null;
    const { sheetName, sheetNames, lots } = excel.loadLots(req.file.path, sheet);
    latestUpload = { path: req.file.path, sheetNames, chosenSheet: sheetName, lots };
    res.json({ ok: true, sheetName, sheetNames, lotCount: lots.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Fetch the published Google Sheet as xlsx, save it locally, and feed it to the
// same parser as a regular upload would.
app.post('/api/gsheet/fetch', async (req, res) => {
  try {
    const url = (config.googleSheetUrl || '').trim();
    if (!url) throw new Error('googleSheetUrl is empty in config.js');

    const sheet = (req.body && req.body.sheet) || null;
    const dest = path.join(config.uploadDir, 'gsheet-latest.xlsx');
    await downloadToFile(url, dest);

    const { sheetName, sheetNames, lots } = excel.loadLots(dest, sheet);
    latestUpload = { path: dest, sheetNames, chosenSheet: sheetName, lots };
    res.json({ ok: true, sheetName, sheetNames, lotCount: lots.length, source: 'gsheet' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Helper: download a URL to a file. Follows redirects (Google's pub URL returns 302).
function downloadToFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? require('https') : require('http');
    lib.get(url, { timeout: 30000 }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        const next = response.headers.location;
        response.resume();
        return resolve(downloadToFile(next, destPath, redirectsLeft - 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode} fetching Google Sheet — check that the sheet is published to the web`));
      }
      const out = fs.createWriteStream(destPath);
      response.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', (e) => {
      if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') reject(new Error('cannot reach Google — check internet connection'));
      else reject(e);
    }).on('timeout', function () { this.destroy(new Error('timeout fetching Google Sheet — slow internet or sheet too large')); });
  });
}

app.post('/api/preview', (req, res) => {
  try {
    if (!latestUpload) throw new Error('Upload a file first');
    const { date, resume } = req.body;
    const dateStr = (date && String(date).trim()) || excel.todayDDMMYYYY();
    const preview = excel.buildPreview(latestUpload.lots, dateStr, config.firmName);
    const already = resume ? loadAlreadySent(dateStr) : new Set();
    const alreadyList = [...already].map(k => {
      const [farmer, phone] = k.split('|');
      return { farmer, phone };
    });
    res.json({ ok: true, date: dateStr, ...preview, alreadySent: alreadyList });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ===== Vyapari (buyer) endpoints ===========================================

// Read the current buyer book (used by the UI to show "N buyers in book").
app.get('/api/buyer-book', (_req, res) => {
  try {
    const book = buyerBookLib.loadBook(DATA_DIR);
    const list = [...book.values()].map(b => ({
      shortname: b.shortname,
      fullName: b.fullName,
      hasPhone: !!b.phone,
    }));
    res.json({ ok: true, count: list.length, path: buyerBookLib.bookPath(DATA_DIR), buyers: list });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/preview-buyers', (req, res) => {
  try {
    if (!latestUpload) throw new Error('Upload a file first');
    const { date, resume } = req.body;
    const dateStr = (date && String(date).trim()) || excel.todayDDMMYYYY();
    const book = buyerBookLib.loadBook(DATA_DIR);
    const preview = excel.buildBuyerPreview(latestUpload.lots, book, dateStr, config.firmName);
    const already = resume ? loadAlreadySent(dateStr, 'buyer_sent') : new Set();
    const alreadyList = [...already].map(k => {
      const [shortname, phone] = k.split('|');
      return { shortname, phone };
    });
    res.json({ ok: true, date: dateStr, ...preview, alreadySent: alreadyList });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Render a single buyer's confirmed lots as a PNG image, served inline.
// Used by the UI's "Preview image" button so the user can verify before sending.
app.get('/api/buyer-image/:shortname', (req, res) => {
  try {
    if (!latestUpload) throw new Error('Upload a file first');
    const dateStr = (req.query.date && String(req.query.date).trim()) || excel.todayDDMMYYYY();
    const book = buyerBookLib.loadBook(DATA_DIR);
    const preview = excel.buildBuyerPreview(latestUpload.lots, book, dateStr, config.firmName);
    const target = req.params.shortname.toUpperCase();
    const buyer = preview.previews.find(p => p.shortname.toUpperCase() === target);
    if (!buyer) throw new Error(`No sendable buyer with shortname "${req.params.shortname}"`);

    const png = renderBuyerImage({
      buyerShortname: buyer.shortname,
      date: dateStr,
      firmName: config.firmName,
      lots: buyer.lots,
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(png);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Helper: build outbox of confirmed buyer messages, applying selection + resume filters
function buildVyapariOutbox(req) {
  const { date, resume, testPhone, selectedBuyers } = req.body;
  const dateStr = (date && String(date).trim()) || excel.todayDDMMYYYY();
  const book = buyerBookLib.loadBook(DATA_DIR);
  const preview = excel.buildBuyerPreview(latestUpload.lots, book, dateStr, config.firmName);

  const testPhoneNorm = testPhone ? excel.normalizePhone(testPhone) : null;
  if (testPhone && !testPhoneNorm) throw new Error('Invalid test phone number');

  const selectionSet = Array.isArray(selectedBuyers) && selectedBuyers.length
    ? new Set(selectedBuyers.map(s => String(s).toUpperCase().trim()))
    : null;

  return { dateStr, preview, testPhoneNorm, selectionSet };
}

app.post('/api/send-buyers', async (req, res) => {
  try {
    if (!latestUpload) throw new Error('Upload a file first');
    if (shetkariRunning()) throw new Error('A Shetkari send is running — wait for it to finish before sending to buyers');
    if (currentVyWaJob && currentVyWaJob.running) throw new Error('A Vyapari WhatsApp send job is already running');
    if (wa.state !== 'connected') throw new Error(`WhatsApp not connected (state: ${wa.state})`);

    const { dateStr, preview, testPhoneNorm, selectionSet } = buildVyapariOutbox(req);
    const already = req.body.resume ? loadAlreadySent(dateStr, 'buyer_sent') : new Set();
    const sendAsImage = req.body.sendAsImage !== false;  // default true; explicit false to disable

    const outbox = [];
    for (const p of preview.previews) {
      if (selectionSet && !selectionSet.has(p.shortname.toUpperCase())) continue;
      const phone = testPhoneNorm || p.phones[0];
      const key = `${p.shortname}|${phone}`;
      if (already.has(key)) continue;

      const item = {
        farmer: p.shortname,
        fullName: p.fullName,
        phone,
        message: p.message,
        lotCount: p.lotCount,
      };

      if (sendAsImage) {
        try {
          item.image = renderBuyerImage({
            buyerShortname: p.shortname,
            date: dateStr,
            firmName: config.firmName,
            lots: p.lots,
          });
          // When image is sent, blank the caption so we don't duplicate the table as text.
          // (User chose "no caption" in the design discussion.)
          item.message = '';
        } catch (e) {
          // Image generation failed for this buyer — fall back to text for them.
          // Logged so the user can investigate without the whole send aborting.
          console.warn(`[buyerImage] failed for ${p.shortname}: ${e.message} — falling back to text`);
        }
      }

      outbox.push(item);
    }

    if (!outbox.length) throw new Error('Nothing to send — no buyers selected, or all selected buyers already received WhatsApp today');

    const job = new SendJob({
      wa,
      outbox,
      date: dateStr,
      minDelayMs: config.minDelayMs,
      maxDelayMs: config.maxDelayMs,
      onLog: (entry) => {
        // Rewrite status to buyer-side variants so resume filters correctly
        const rewritten = { ...entry };
        if (rewritten.status === 'sent') rewritten.status = 'buyer_sent';
        else if (rewritten.status === 'failed') rewritten.status = 'buyer_failed';
        appendLog(rewritten);
      },
    });
    currentVyWaJob = job;

    job.on('progress', (r) => io.emit('job:progress', { channel: 'wa',  view: 'vyapari', ...r }));
    job.on('log', (r)      => io.emit('job:log',      { channel: 'wa',  view: 'vyapari', ...r, status: rewriteStatus(r.status, 'wa') }));
    job.on('done', (s)     => io.emit('job:done',     { channel: 'wa',  view: 'vyapari', ...s }));

    job.run().catch(err => {
      io.emit('job:done', { channel: 'wa', view: 'vyapari', ...job.stats, stopped: true, error: err.message });
    });

    res.json({ ok: true, total: outbox.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/send-buyers-sms', async (req, res) => {
  try {
    if (!latestUpload) throw new Error('Upload a file first');
    if (shetkariRunning()) throw new Error('A Shetkari send is running — wait for it to finish before sending to buyers');
    if (currentVySmsJob && currentVySmsJob.running) throw new Error('A Vyapari SMS send job is already running');
    if (!sms.isConfigured()) throw new Error('SMS gateway not configured — set sms.* in config.js');
    if (smsState !== 'connected') {
      await pingSms();
      if (smsState !== 'connected') throw new Error(sms.lastError || 'SMS Gateway not reachable');
    }

    const { dateStr, preview, testPhoneNorm, selectionSet } = buildVyapariOutbox(req);
    const already = req.body.resume ? loadAlreadySent(dateStr, 'buyer_sms_sent') : new Set();

    const outbox = [];
    for (const p of preview.previews) {
      if (selectionSet && !selectionSet.has(p.shortname.toUpperCase())) continue;
      const phone = testPhoneNorm || p.phones[0];
      const key = `${p.shortname}|${phone}`;
      if (already.has(key)) continue;
      outbox.push({
        farmer: p.shortname,
        fullName: p.fullName,
        phone,
        message: p.message,
      });
    }

    if (!outbox.length) throw new Error('Nothing to send — no buyers selected, or all selected buyers already received SMS today');

    const job = new SmsJob({
      sms,
      outbox,
      date: dateStr,
      minDelayMs: (config.sms && config.sms.minDelayMs) || 4000,
      maxDelayMs: (config.sms && config.sms.maxDelayMs) || 7000,
      onLog: (entry) => {
        const rewritten = { ...entry };
        if (rewritten.status === 'sms_sent') rewritten.status = 'buyer_sms_sent';
        else if (rewritten.status === 'sms_failed') rewritten.status = 'buyer_sms_failed';
        appendLog(rewritten);
      },
    });
    currentVySmsJob = job;

    job.on('progress', (r) => io.emit('job:progress', { channel: 'sms', view: 'vyapari', ...r }));
    job.on('log', (r)      => io.emit('job:log',      { channel: 'sms', view: 'vyapari', ...r, status: rewriteStatus(r.status, 'sms') }));
    job.on('done', (s)     => io.emit('job:done',     { channel: 'sms', view: 'vyapari', ...s }));

    job.run().catch(err => {
      io.emit('job:done', { channel: 'sms', view: 'vyapari', ...job.stats, stopped: true, error: err.message });
    });

    res.json({ ok: true, total: outbox.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Translate raw job statuses into view-aware statuses for the live log.
// (Server-side log file already has the rewritten statuses via onLog;
// this is for the realtime socket events the frontend sees.)
function rewriteStatus(status, channel) {
  if (channel === 'wa' && status === 'sent') return 'buyer_sent';
  if (channel === 'wa' && status === 'failed') return 'buyer_failed';
  if (channel === 'sms' && status === 'sms_sent') return 'buyer_sms_sent';
  if (channel === 'sms' && status === 'sms_failed') return 'buyer_sms_failed';
  return status;  // not_on_whatsapp etc. unchanged
}

// ===== End Vyapari endpoints ===============================================


app.post('/api/send', async (req, res) => {
  try {
    if (!latestUpload) throw new Error('Upload a file first');
    if (currentWaJob && currentWaJob.running) throw new Error('A WhatsApp send job is already running');
    if (currentVyWaJob && currentVyWaJob.running) throw new Error('A Vyapari send is running — wait for it to finish');
    if (currentVySmsJob && currentVySmsJob.running) throw new Error('A Vyapari send is running — wait for it to finish');
    if (wa.state !== 'connected') throw new Error(`WhatsApp not connected (state: ${wa.state})`);

    const { date, resume, testPhone, selectedFarmers } = req.body;
    const dateStr = (date && String(date).trim()) || excel.todayDDMMYYYY();
    const preview = excel.buildPreview(latestUpload.lots, dateStr, config.firmName);
    const already = resume ? loadAlreadySent(dateStr) : new Set();

    // Optional selection filter. If provided, only send to farmers in the list.
    // If not provided or empty, send to everyone.
    const selectionSet = Array.isArray(selectedFarmers) && selectedFarmers.length
      ? new Set(selectedFarmers)
      : null;

    const outbox = [];
    const testPhoneNorm = testPhone ? excel.normalizePhone(testPhone) : null;
    if (testPhone && !testPhoneNorm) throw new Error('Invalid test phone number');

    for (const p of preview.previews) {
      if (selectionSet && !selectionSet.has(p.farmer)) continue;
      const phones = testPhoneNorm ? [testPhoneNorm] : p.phones;
      for (const phone of phones) {
        const key = `${p.farmer}|${phone}`;
        if (already.has(key)) continue;
        outbox.push({ farmer: p.farmer, phone, message: p.message, lotCount: p.lotCount });
      }
    }

    if (!outbox.length) throw new Error('Nothing to send — no farmers selected, or all selected farmers already received WhatsApp today');

    const job = new SendJob({
      wa,
      outbox,
      date: dateStr,
      minDelayMs: config.minDelayMs,
      maxDelayMs: config.maxDelayMs,
      onLog: appendLog,
    });
    currentWaJob = job;

    job.on('progress', (r) => io.emit('job:progress', { channel: 'wa', view: 'shetkari', ...r }));
    job.on('log', (r)      => io.emit('job:log',      { channel: 'wa', view: 'shetkari', ...r }));
    job.on('done', (s)     => io.emit('job:done',     { channel: 'wa', view: 'shetkari', ...s }));

    job.run().catch(err => {
      io.emit('job:done', { channel: 'wa', view: 'shetkari', ...job.stats, stopped: true, error: err.message });
    });

    res.json({ ok: true, total: outbox.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// SMS send — independent of WA send; both can run in parallel
app.post('/api/send-sms', async (req, res) => {
  try {
    if (!latestUpload) throw new Error('Upload a file first');
    if (currentSmsJob && currentSmsJob.running) throw new Error('An SMS send job is already running');
    if (currentVyWaJob && currentVyWaJob.running) throw new Error('A Vyapari send is running — wait for it to finish');
    if (currentVySmsJob && currentVySmsJob.running) throw new Error('A Vyapari send is running — wait for it to finish');
    if (!sms.isConfigured()) throw new Error('SMS gateway not configured — set sms.* in config.js');
    if (smsState !== 'connected') {
      // Try one fresh ping in case state is stale
      await pingSms();
      if (smsState !== 'connected') throw new Error(sms.lastError || 'SMS Gateway not reachable');
    }

    const { date, resume, testPhone, selectedFarmers } = req.body;
    const dateStr = (date && String(date).trim()) || excel.todayDDMMYYYY();
    const preview = excel.buildPreview(latestUpload.lots, dateStr, config.firmName);
    const already = resume ? loadAlreadySent(dateStr, 'sms_sent') : new Set();

    const selectionSet = Array.isArray(selectedFarmers) && selectedFarmers.length
      ? new Set(selectedFarmers)
      : null;

    const outbox = [];
    const testPhoneNorm = testPhone ? excel.normalizePhone(testPhone) : null;
    if (testPhone && !testPhoneNorm) throw new Error('Invalid test phone number');

    for (const p of preview.previews) {
      if (selectionSet && !selectionSet.has(p.farmer)) continue;
      const phones = testPhoneNorm ? [testPhoneNorm] : p.phones;
      for (const phone of phones) {
        const key = `${p.farmer}|${phone}`;
        if (already.has(key)) continue;
        outbox.push({ farmer: p.farmer, phone, message: p.message });
      }
    }

    if (!outbox.length) throw new Error('Nothing to send — no farmers selected, or all selected farmers already received SMS today');

    const job = new SmsJob({
      sms,
      outbox,
      date: dateStr,
      minDelayMs: (config.sms && config.sms.minDelayMs) || 4000,
      maxDelayMs: (config.sms && config.sms.maxDelayMs) || 7000,
      onLog: appendLog,
    });
    currentSmsJob = job;

    job.on('progress', (r) => io.emit('job:progress', { channel: 'sms', view: 'shetkari', ...r }));
    job.on('log', (r)      => io.emit('job:log',      { channel: 'sms', view: 'shetkari', ...r }));
    job.on('done', (s)     => io.emit('job:done',     { channel: 'sms', view: 'shetkari', ...s }));

    job.run().catch(err => {
      io.emit('job:done', { channel: 'sms', view: 'shetkari', ...job.stats, stopped: true, error: err.message });
    });

    res.json({ ok: true, total: outbox.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Stop targets a specific (view, channel) pair
app.post('/api/job/stop', (req, res) => {
  const channel = req.body && req.body.channel;     // 'wa' | 'sms'
  const view    = (req.body && req.body.view) || 'shetkari'; // 'shetkari' | 'vyapari'

  let target = null;
  if (view === 'shetkari' && channel === 'wa')  target = currentWaJob;
  if (view === 'shetkari' && channel === 'sms') target = currentSmsJob;
  if (view === 'vyapari'  && channel === 'wa')  target = currentVyWaJob;
  if (view === 'vyapari'  && channel === 'sms') target = currentVySmsJob;

  if (target) target.stop();
  else if (!channel) {
    // No channel given — stop everything running
    [currentWaJob, currentSmsJob, currentVyWaJob, currentVySmsJob].forEach(j => {
      if (j && j.running) j.stop();
    });
  }
  res.json({ ok: true });
});

app.post('/api/job/pause-ack', (req, res) => {
  // Pause/skip applies to whichever WhatsApp job is currently in pause state.
  // Both Shetkari and Vyapari WA jobs use the same not_on_whatsapp pause logic.
  const target = (currentWaJob && currentWaJob.running) ? currentWaJob
              : (currentVyWaJob && currentVyWaJob.running) ? currentVyWaJob
              : null;
  if (!target) return res.status(400).json({ ok: false, error: 'No WhatsApp job running' });
  const action = req.body.action;
  if (action === 'stop') target.stop();
  else target.resumePause();
  res.json({ ok: true });
});

app.post('/api/sms/retry', async (_req, res) => {
  await pingSms();
  res.json({ sms: { state: smsState, error: sms.lastError } });
});

app.post('/api/sms/test', async (req, res) => {
  try {
    if (!sms.isConfigured()) throw new Error('SMS gateway not configured — set sms.* in config.js');
    const rawPhone = req.body && req.body.phone;
    const phone = excel.normalizePhone(rawPhone);
    if (!phone) throw new Error('Invalid phone number. Use a 10-digit Indian mobile.');
    const testMessage = `Test from Auction Price Sender (${config.firmName}). If you received this, SMS delivery is working.`;
    await sms.sendText('+' + phone, testMessage);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/wa/pair', async (req, res) => {
  try {
    const code = await wa.requestPairingCode(req.body?.phone);
    res.json({ ok: true, code });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/wa/reset', async (_req, res) => {
  try {
    await wa.disconnect();
    // Delete auth_state contents
    if (fs.existsSync(config.authFolder)) {
      for (const f of fs.readdirSync(config.authFolder)) {
        fs.rmSync(path.join(config.authFolder, f), { recursive: true, force: true });
      }
    }
    lastQrDataUrl = null;
    io.emit('wa:state', { state: 'disconnected' });
    setTimeout(() => wa.connect().catch(() => {}), 500);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/log', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sent_log.csv"');
  if (fs.existsSync(config.logFile)) fs.createReadStream(config.logFile).pipe(res);
  else res.end('timestamp,date,farmer,phone,status,error\n');
});

// ------------------ Start --------------------------------------------------
server.listen(config.port, () => {
  const url = `http://localhost:${config.port}`;
  console.log(`\n╭─────────────────────────────────────────────╮`);
  console.log(`│  Auction Price Sender                       │`);
  console.log(`│                                             │`);
  console.log(`│  Open in your browser:                      │`);
  console.log(`│  ${url}                     │`);
  console.log(`│                                             │`);
  console.log(`│  Keep this window open while sending.       │`);
  console.log(`│  Close the window when you're done.         │`);
  console.log(`╰─────────────────────────────────────────────╯\n`);
});

// Don't crash on uncaught errors — log them and keep serving
process.on('uncaughtException', (err) => {
  console.error('\n[uncaughtException]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('\n[unhandledRejection]', err && err.message ? err.message : err);
});
