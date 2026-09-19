/**
 * SmsJob: orchestrates SMS sending to a prepared outbox.
 *
 * Same event shape as SendJob (so the frontend can use the same UI patterns):
 *   'progress' { i, total, farmer, phone, status }
 *     status: 'sending' | 'sent' | 'failed'
 *   'log'       { ts, date, farmer, phone, status, error? }
 *   'done'      { ok, failed, stopped }
 *
 * Controls:
 *   job.stop()  — abort entirely (in-flight call still completes)
 */

const { EventEmitter } = require('events');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class SmsJob extends EventEmitter {
  constructor({ sms, outbox, date, minDelayMs, maxDelayMs, onLog }) {
    super();
    this.sms = sms;
    this.outbox = outbox;          // [{ farmer, phone, message }]
    this.date = date;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.onLog = onLog || (() => {});
    this._stop = false;
    this.running = false;
    this.current = null;
    this.stats = { ok: 0, failed: 0 };
  }

  _randomDelay() {
    return this.minDelayMs + Math.floor(Math.random() * (this.maxDelayMs - this.minDelayMs));
  }

  stop() { this._stop = true; }

  async run() {
    if (this.running) return;
    this.running = true;

    for (let i = 0; i < this.outbox.length; i++) {
      if (this._stop) break;

      const item = this.outbox[i];
      this.current = { index: i, ...item };
      this.emit('progress', { i: i + 1, total: this.outbox.length, ...item, status: 'sending' });

      try {
        // Phone in our outbox is "91XXXXXXXXXX". SMS Gateway wants "+91XXXXXXXXXX".
        const e164 = item.phone.startsWith('+') ? item.phone : '+' + item.phone;
        await this.sms.sendText(e164, item.message);
        this.stats.ok++;
        this._emitLog({ farmer: item.farmer, phone: item.phone, status: 'sms_sent' });
        this.emit('progress', { i: i + 1, total: this.outbox.length, ...item, status: 'sent' });
      } catch (e) {
        this.stats.failed++;
        const reason = (e && e.message) || String(e);
        this._emitLog({ farmer: item.farmer, phone: item.phone, status: 'sms_failed', error: reason });
        this.emit('progress', { i: i + 1, total: this.outbox.length, ...item, status: 'failed', message: reason });
      }

      if (i < this.outbox.length - 1 && !this._stop) await sleep(this._randomDelay());
    }

    this.running = false;
    this.current = null;
    this.emit('done', { ...this.stats, stopped: this._stop });
  }

  _emitLog(entry) {
    const full = { ts: new Date().toISOString(), date: this.date, ...entry };
    this.onLog(full);
    this.emit('log', full);
  }
}

module.exports = { SmsJob };
