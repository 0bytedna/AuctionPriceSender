const fs = require('fs');
const path = require('path');
const { proto } = require('@whiskeysockets/baileys');

// Keep recent outgoing payloads for WhatsApp's encryption-retry requests.
// Image payloads contain media metadata, not the original image buffer.
class MessageStore {
  constructor(folder) {
    this.file = path.join(folder, 'outgoing-retry-cache.json');
    this.entries = new Map();
    if (fs.existsSync(this.file)) {
      try {
        for (const entry of JSON.parse(fs.readFileSync(this.file, 'utf8'))) {
          if (entry.id && entry.data && Number.isFinite(entry.time)) this.entries.set(entry.id, entry);
        }
      } catch { console.warn('WhatsApp retry cache could not be loaded. Starting an empty cache.'); }
    }
    this.prune();
  }

  prune() {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [id, entry] of this.entries) if (entry.time < cutoff) this.entries.delete(id);
    while (this.entries.size > 2000) this.entries.delete(this.entries.keys().next().value);
  }

  put(message) {
    if (!message?.key?.fromMe || !message.key.id || !message.message) return;
    this.entries.set(message.key.id, {
      id: message.key.id,
      time: Date.now(),
      data: Buffer.from(proto.Message.encode(message.message).finish()).toString('base64'),
    });
    this.prune();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify([...this.entries.values()]));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch { console.warn('WhatsApp retry cache could not be saved; retries remain available until restart.'); }
  }

  get(key) {
    this.prune();
    const entry = this.entries.get(key.id);
    if (!entry) return undefined;
    try { return proto.Message.decode(Buffer.from(entry.data, 'base64')); }
    catch { return undefined; }
  }
}

module.exports = { MessageStore };
