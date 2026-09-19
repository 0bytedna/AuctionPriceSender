/**
 * WhatsApp client wrapper.
 *
 * Manages one persistent Baileys connection. Emits events:
 *   'qr'          (qrString)              — QR code to scan
 *   'connected'                           — fully authenticated
 *   'disconnected' (reason)               — lost connection (will attempt reconnect)
 *   'logged-out'                          — auth invalid, needs re-scan
 *
 * Call methods:
 *   await wa.connect()                    — starts the connection
 *   await wa.checkOnWhatsApp(phone)       — returns boolean
 *   await wa.sendText(phone, message)     — sends (throws on error)
 *   wa.state                              — 'disconnected' | 'connecting' | 'qr' | 'connected'
 *   wa.disconnect()                       — closes
 */

const { EventEmitter } = require('events');
const pino = require('pino');
const { MessageStore } = require('./messageStore');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

class WhatsAppClient extends EventEmitter {
  constructor({ authFolder }) {
    super();
    this.authFolder = authFolder;
    this.sock = null;
    this.state = 'disconnected';
    this._reconnectTimer = null;
    this._generation = 0;
    this.messages = null;
  }

  async connect() {
    if (this.state === 'connecting' || this.state === 'connected' || this.state === 'qr') return;
    this._setState('connecting');
    const generation = ++this._generation;
    this.messages = new MessageStore(this.authFolder);

    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { version = undefined; }

    const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
    if (generation !== this._generation) return;
    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      getMessage: async (key) => this.messages.get(key),
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', ({ messages }) => {
      if (generation !== this._generation) return;
      for (const message of messages) this.messages.put(message);
    });

    sock.ev.on('connection.update', (u) => {
      if (generation !== this._generation) return;
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        this._setState('qr');
        this.emit('qr', qr);
      }

      if (connection === 'open') {
        this._setState('connected');
        this.emit('connected');
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        const reason = loggedOut
          ? 'logged out — need to re-scan QR'
          : (lastDisconnect?.error?.message || 'connection closed');

        this.sock = null;

        if (loggedOut) {
          this._setState('disconnected');
          this.emit('logged-out');
        } else {
          this._setState('disconnected');
          this.emit('disconnected', reason);
          // Auto-reconnect after 3 seconds (Baileys routinely drops and needs reconnect)
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = setTimeout(() => this.connect().catch(() => {}), 3000);
        }
      }
    });

    this.sock = sock;
  }

  async disconnect() {
    ++this._generation;
    clearTimeout(this._reconnectTimer);
    if (this.sock) {
      try { await this.sock.end(undefined); } catch {}
      this.sock = null;
    }
    this._setState('disconnected');
  }

  isConnected() {
    return this.state === 'connected' && !!this.sock;
  }

  async requestPairingCode(rawPhone) {
    let phone = String(rawPhone || '').replace(/[\s()+-]/g, '');
    if (/^[6-9]\d{9}$/.test(phone)) phone = '91' + phone;
    if (!/^[1-9]\d{10,14}$/.test(phone)) throw new Error('Enter your WhatsApp number with country code, or a 10-digit Indian mobile number.');
    if (this.isConnected() || this.sock?.authState?.creds?.registered) throw new Error('WhatsApp is already linked.');
    if (!this.sock || this.state !== 'qr') throw new Error('WhatsApp is still connecting. Wait a few seconds and try again.');
    if (this._pairingBusy || Date.now() < (this._nextPairingAt || 0)) throw new Error('Please wait 60 seconds before requesting another code.');
    this._pairingBusy = true;
    this._nextPairingAt = Date.now() + 60000;
    const sock = this.sock;
    try {
      const code = await sock.requestPairingCode(phone);
      if (this.sock !== sock) throw new Error('Connection changed. Please request a new code.');
      return code;
    } finally { this._pairingBusy = false; }
  }

  async checkOnWhatsApp(phone) {
    if (!this.isConnected()) throw new Error('WhatsApp not connected');
    const results = await this.sock.onWhatsApp(phone);
    const check = Array.isArray(results) ? results[0] : null;
    return !!(check && check.exists);
  }

  async sendText(phone, text) {
    if (!this.isConnected()) throw new Error('WhatsApp not connected');
    const jid = phone + '@s.whatsapp.net';
    const message = await this.sock.sendMessage(jid, { text });
    this.messages.put(message);
  }

  async sendImage(phone, imageBuffer, caption) {
    if (!this.isConnected()) throw new Error('WhatsApp not connected');
    const jid = phone + '@s.whatsapp.net';
    const payload = { image: imageBuffer };
    if (caption) payload.caption = caption;
    const message = await this.sock.sendMessage(jid, payload);
    this.messages.put(message);
  }

  _setState(s) {
    this.state = s;
    this.emit('state', s);
  }
}

module.exports = { WhatsAppClient };
