/**
 * SMS client — talks to the capcom6 "SMS Gateway for Android" app's local HTTP API.
 *
 * Setup on phone (one-time):
 *   1. Install "SMS Gateway for Android" from Google Play or
 *      https://github.com/capcom6/android-sms-gateway/releases
 *   2. Open the app, toggle "Local Server" ON, tap "Offline" to start it
 *   3. Note the IP address, username, password shown in the Local Server section
 *   4. Put those into config.js → sms.{ baseUrl, username, password }
 *
 * The phone must be on the same Wi-Fi as this laptop.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

class SmsClient {
  constructor({ baseUrl, username, password }) {
    this.baseUrl = String(baseUrl || '').trim();
    this.cloud = false;
    try {
      const url = new URL(this.baseUrl);
      if (url.hostname === 'www.api.sms-gate.app') url.hostname = 'api.sms-gate.app';
      this.cloud = url.hostname === 'api.sms-gate.app' || /\/3rdparty\/v1\/?$/.test(url.pathname);
      if (this.cloud && url.pathname === '/') url.pathname = '/3rdparty/v1';
      this.baseUrl = url.toString().replace(/\/$/, '');
    } catch {} // Report invalid URLs when checking the connection.
    this.lastError = null;
    this.username = username;
    this.password = password;
  }

  isConfigured() {
    return !!(this.baseUrl && this.username && this.password);
  }

  // Returns true if the phone responds to a basic ping
  async ping(timeoutMs = 3000) {
    if (!this.isConfigured()) return false;
    try {
      const result = await this._request('GET', this.cloud ? '/devices' : '/health', null, timeoutMs);
      if (this.cloud && (!Array.isArray(result) || result.length === 0)) {
        throw new Error('No SMS devices linked. Open SMS Gateway on your phone and connect Cloud Server.');
      }
      this.lastError = null;
      return true;
    } catch (err) {
      this.lastError = err.message;
      return false;
    }
  }

  // Send to a single phone (E.164 with leading +, e.g. "+919876543210")
  async sendText(phoneE164, text) {
    if (!this.isConfigured()) throw new Error('SMS gateway not configured (baseUrl/username/password)');

    const payload = {
      textMessage: { text },
      phoneNumbers: [phoneE164],
    };

    const res = await this._request('POST', this.cloud ? '/messages' : '/message', payload, 15000);
    // 201 Created with a message id is success per the SMS Gateway docs
    return res;
  }

  _request(method, path, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(this.baseUrl.replace(/\/$/, '') + '/' + path.replace(/^\//, ''));
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
      } catch {
        return reject(new Error(`Invalid SMS gateway URL: ${this.baseUrl}`));
      }

      const lib = url.protocol === 'https:' ? https : http;
      const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      const data = body ? JSON.stringify(body) : null;

      const req = lib.request({
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        timeout: timeoutMs,
        headers: {
          'Authorization': 'Basic ' + auth,
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => chunks += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(chunks ? JSON.parse(chunks) : {}); }
            catch { resolve({ raw: chunks }); }
          } else {
            const hint = res.statusCode === 401 || res.statusCode === 403
              ? 'Authentication rejected. Use the credentials for the selected Cloud Server or Local Server mode.'
              : res.statusCode === 404 ? 'API endpoint not found. Check the gateway address and server mode.'
              : (res.statusMessage || 'request failed');
            reject(new Error(`HTTP ${res.statusCode}: ${hint}`));
          }
        });
      });

      req.on('timeout', () => { req.destroy(new Error('timeout — phone not reachable, check Wi-Fi')); });
      req.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          reject(new Error('connection refused — is the SMS Gateway app running on the phone?'));
        } else if (err.code === 'EHOSTUNREACH' || err.code === 'ENOTFOUND' || err.code === 'ENETUNREACH') {
          reject(new Error(`phone not reachable at ${this.baseUrl} — check Wi-Fi and IP`));
        } else {
          reject(err);
        }
      });

      if (data) req.write(data);
      req.end();
    });
  }
}

module.exports = { SmsClient };
