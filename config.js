/**
 * Edit firmName and the sms.* values to match your setup.
 * Leave other values unless you know what you're doing.
 */
module.exports = {
  // Shown at the bottom of every WhatsApp message
  firmName: 'Pavan Cold Storage',

  // Server port. Access via http://localhost:3000
  port: 3000,

  // Where uploaded Excel files are stored temporarily
  uploadDir: './uploads',

  // Append-only CSV log of every send attempt
  logFile: './sent_log.csv',

  // WhatsApp auth state (created on first run after QR scan; keep forever)
  authFolder: './auth_state',

  // Randomized delay between WhatsApp messages (milliseconds).
  // 3000-6000 = 3-6 seconds. Do NOT reduce — keeps you under WhatsApp's radar.
  minDelayMs: 3000,
  maxDelayMs: 6000,

  // ---------------------------------------------------------------------------
  // Google Sheets — published xlsx URL
  // ---------------------------------------------------------------------------
  // Once you "Publish to web" your Google Sheet (File → Share → Publish to web →
  // pick "Entire document" + "Microsoft Excel (.xlsx)"), Google gives you a URL
  // ending in `pub?output=xlsx`. Paste that URL here. The app will download all
  // tabs as a single Excel file when you click "Fetch from Google Sheet".
  //
  // Leave empty if you only use Excel upload.
  googleSheetUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTDmN8ztSybCm_cl_VLxuTR8eFcfSqcHGI91Cxb_GALH04D7iNOEJEspuqrPGbt6mLcW3_ywS9TUQ-I/pub?output=xlsx',

  // ---------------------------------------------------------------------------
  // SMS settings — pick ONE of the two modes
  // ---------------------------------------------------------------------------
  // Read SMS_SETUP.md for first-time phone setup instructions.
  //
  // MODE 1 — CLOUD (recommended, works through any Wi-Fi/router)
  //   Phone runs SMS Gateway app in "Cloud Server" mode; laptop talks to sms-gate.app.
  //   Phone needs internet. Message content passes through sms-gate.app servers.
  //
  //   baseUrl:  'https://api.sms-gate.app'
  //   username: shown on phone under "Cloud Server" section (auto-generated)
  //   password: shown on phone under "Cloud Server" section (auto-generated)
  //
  // MODE 2 — LOCAL (phone + laptop on same Wi-Fi)
  //   Router must NOT have AP/Client isolation enabled.
  //
  //   baseUrl:  'http://<phone-ip>:8080'  (IP shown in the app's Local Server section)
  //   username: shown under Local Server
  //   password: shown under Local Server
  //
  // Leave as empty strings if you don't want SMS support.
  sms: {
    baseUrl:  'https://api.sms-gate.app',                           // e.g. 'https://api.sms-gate.app' (cloud) or 'http://192.168.1.42:8080' (local)
    username: 'VET1TJ',
    password: 'qwertyuiopasdfghjkl',

    // Delay between SMS sends (milliseconds).
    // Carriers tolerate ~1 SMS/sec. 4–7 seconds is conservative and safe.
    minDelayMs: 2000,
    maxDelayMs: 2500,
  },
};
