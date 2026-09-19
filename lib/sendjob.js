/**
 * SendJob: orchestrates sending messages to a prepared outbox.
 *
 * Emits:
 *   'progress' { i, total, farmer, phone, status, message? }
 *     status: 'sent' | 'failed' | 'not_on_whatsapp' | 'paused' | 'skipped'
 *   'log'       { ts, farmer, phone, status, error? }   // same data as CSV row
 *   'done'      { ok, failed, notOnWa, skipped, stopped }
 *
 * Controls:
 *   job.pause()                  — pauses before next send
 *   job.resumePause()            — user pressed "Skip this" after not_on_whatsapp
 *   job.skipCurrent()            — skip current (only while paused)
 *   job.stop()                   — abort entirely
 */

const { EventEmitter } = require('events');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class SendJob extends EventEmitter {
  constructor({ wa, outbox, date, minDelayMs, maxDelayMs, onLog }) {
    super();
    this.wa = wa;
    this.outbox = outbox;       // [{ farmer, phone, message, lotCount }]
    this.date = date;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.onLog = onLog || (() => {});
    this._stop = false;
    this._pauseForUserGate = null; // a Promise; resolve() unblocks
    this._pauseResolve = null;
    this.running = false;
    this.current = null;
    this.stats = { ok: 0, failed: 0, notOnWa: 0, skipped: 0 };
  }

  _randomDelay() {
    return this.minDelayMs + Math.floor(Math.random() * (this.maxDelayMs - this.minDelayMs));
  }

  stop()        { this._stop = true; this._unblockPause(); }
  resumePause() { this._unblockPause(); }   // 'skip this one and continue'
  _unblockPause() {
    if (this._pauseResolve) { this._pauseResolve(); this._pauseResolve = null; this._pauseForUserGate = null; }
  }

  async _waitForUser() {
    this._pauseForUserGate = new Promise(res => { this._pauseResolve = res; });
    await this._pauseForUserGate;
  }

  async run() {
    if (this.running) return;
    this.running = true;

    for (let i = 0; i < this.outbox.length; i++) {
      if (this._stop) break;
      if (!this.wa.isConnected()) {
        // Wait up to 30s for reconnect, then give up
        const start = Date.now();
        while (!this.wa.isConnected() && Date.now() - start < 30000 && !this._stop) {
          await sleep(500);
        }
        if (!this.wa.isConnected()) {
          this._emitLog({ farmer: '(system)', phone: '', status: 'failed', error: 'WhatsApp disconnected; stopping' });
          break;
        }
      }

      const item = this.outbox[i];
      // Keep image buffers out of status responses and progress broadcasts.
      const { image, ...progressItem } = item;
      this.current = { index: i, ...progressItem };
      this.emit('progress', { i: i + 1, total: this.outbox.length, ...progressItem, status: 'sending' });

      let isNotOnWa = false;
      try {
        const onWA = await this.wa.checkOnWhatsApp(item.phone);
        if (!onWA) { isNotOnWa = true; throw new Error('number not registered on WhatsApp'); }
        if (item.image) {
          // Image sends use the message text as the caption (or no caption if message is empty)
          await this.wa.sendImage(item.phone, item.image, item.message || '');
        } else {
          await this.wa.sendText(item.phone, item.message);
        }
        this.stats.ok++;
        this._emitLog({ farmer: item.farmer, phone: item.phone, status: 'sent' });
        this.emit('progress', { i: i + 1, total: this.outbox.length, ...progressItem, status: 'sent' });
      } catch (e) {
        const reason = (e && e.message) || String(e);
        if (isNotOnWa) {
          this.stats.notOnWa++;
          this._emitLog({ farmer: item.farmer, phone: item.phone, status: 'not_on_whatsapp', error: reason });
          this.emit('progress', { i: i + 1, total: this.outbox.length, ...progressItem, status: 'not_on_whatsapp' });

          // Pause for user input (they see a modal, click Skip or Stop)
          this.emit('progress', { i: i + 1, total: this.outbox.length, ...progressItem, status: 'paused' });
          await this._waitForUser();
          if (this._stop) break;
        } else {
          this.stats.failed++;
          this._emitLog({ farmer: item.farmer, phone: item.phone, status: 'failed', error: reason });
          this.emit('progress', { i: i + 1, total: this.outbox.length, ...progressItem, status: 'failed', message: reason });
        }
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

module.exports = { SendJob };
