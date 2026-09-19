# Auction Price Sender — Web App

Same script as before, but with a proper web interface. You open a browser
on your laptop, drag in the Excel file, see all messages, click "Send."
Live progress bar, modal popups when something needs your attention.

Runs entirely on your own laptop — no cloud server, no extra cost, same
WhatsApp account.

## What this gives you over the CLI version

- **No more terminal commands** — open a webpage and click buttons
- **Visual preview** — every farmer's message shown as a tappable card with
  their phone number(s), and you can search by farmer name
- **Live progress bar** — see who's been messaged in real time
- **Better "not on WhatsApp" handling** — a clean popup with the farmer
  name and number, two big buttons (Skip / Stop)
- **One-click log download** — get the CSV anytime
- **Same WhatsApp session, same risk profile** — connection stays on your
  laptop, no third-party server

## One-time setup

### 1. Install Node.js

[nodejs.org](https://nodejs.org/) — the LTS version (green button).
Accept all defaults during installation.

### 2. Install dependencies

Open a terminal in this folder and run:

```bash
npm install
```

This downloads ~330 packages in about 30–45 seconds.

### 3. Edit `config.js`

Open `config.js` in Notepad. Change `firmName` to your shop name. Save.

That's it.

## Daily use

### Start the server

In the terminal, in this folder:

```bash
npm start
```

You'll see:

```
╭─────────────────────────────────────────────╮
│  Auction Price Sender                       │
│                                             │
│  Open in your browser:                      │
│  http://localhost:3000                      │
│                                             │
│  Keep this terminal window open.            │
╰─────────────────────────────────────────────╯
```

**Leave that terminal window open.** Closing it stops the server.

### Open the web page

In any browser (Chrome, Edge, Firefox), go to:

```
http://localhost:3000
```

You'll see the app. The first time, the WhatsApp chip top-right will say
"Scan QR to link" and a QR code will appear. On your phone:
WhatsApp → Settings → Linked Devices → Link a Device → scan it.

After scanning, the chip turns green: **"WhatsApp ready."**

### Send today's prices

1. **Drag your Excel file** onto the upload box (or click to browse).
2. The page automatically loads it and shows you a preview:
   - Summary cards (farmers, lots, messages to send)
   - Warnings (missing phones, duplicate phones)
   - One row per farmer — click to expand and see the actual message
3. **Set the date** (defaults to today). Tick "Resume" to skip already-sent.
4. **Optional:** put your own number in "Test" to send all messages to
   yourself first as a sanity check.
5. Click **"▶ Send now."** Confirmation prompt → progress bar starts.
6. If a number isn't on WhatsApp, a popup appears:

   ```
   ⚠  Number NOT on WhatsApp
   
   AH UKALI
   8123320128
   
   [Stop everything]   [Skip & continue →]
   ```

   Note it down, then click Skip to keep going.

7. When done, the live log shows every send. Click "Download full log
   (CSV)" anytime.

### Stop the server

Close the terminal window, or press `Ctrl+C` in it.

## What the screen looks like

The interface has three panels stacked vertically:

1. **Upload** — drop zone for the Excel file
2. **Review** — summary stats, warnings, expandable preview cards
3. **Send** — big green button, progress bar, live log of every message

Top-right corner always shows WhatsApp connection status (green dot when
ready). If WhatsApp logs you out, the QR re-appears so you can re-link.

## Configuration

`config.js` exposes these settings:

| Field | Default | What it does |
|---|---|---|
| `firmName` | `Your Firm Name (Vijayapura)` | Shows at the bottom of every WhatsApp message |
| `port` | `3000` | Web server port. Change if 3000 is taken |
| `minDelayMs` / `maxDelayMs` | `3000` / `6000` | Random delay between sends. **Don't reduce.** |
| `logFile` | `./sent_log.csv` | Where send history is saved |
| `authFolder` | `./auth_state` | WhatsApp link is stored here. Don't delete unless you want to re-scan |

## Troubleshooting

**"WhatsApp not connected" when I try to send** — wait a few seconds for
the chip top-right to turn green. If it stays red, click "Unlink WhatsApp"
in the bottom of the Send section and re-scan the QR.

**Port 3000 is already in use** — open `config.js`, change `port: 3000` to
`port: 3001` (or any other number), save, restart with `npm start`, and
open `http://localhost:3001` instead.

**`npm install` fails with a `git` error** — same fix as before: the
Baileys version is pinned to 6.7.18 in `package.json`. Make sure that
line says exactly `"@whiskeysockets/baileys": "6.7.18"` (no caret).

**Page doesn't load** — make sure the terminal window with `npm start` is
still open and showing the box message. If you see error text instead,
copy it and ask for help.

**Server crashes mid-send** — restart with `npm start`, refresh the
browser, upload the same Excel, tick "Resume," send. It will skip
everyone who already received the message today.

## Files

```
auction-sender-web/
├── server.js              ← Express server entry point
├── config.js              ← Edit firmName here
├── package.json
├── lib/
│   ├── excel.js           ← Excel parsing + message building
│   ├── whatsapp.js        ← Baileys wrapper
│   └── sendjob.js         ← Send orchestration with pause/stop
├── public/
│   ├── index.html         ← Web UI structure
│   ├── style.css          ← Visual design
│   └── app.js             ← Browser-side logic
├── auth_state/            ← Created on first QR scan, keep forever
├── uploads/               ← Excel files you upload (auto-managed)
└── sent_log.csv           ← Append-only history
```

You can safely delete `uploads/` and `sent_log.csv` if they get too big —
they'll be recreated. Don't delete `auth_state/` unless you want to scan
the QR again.

## Same WhatsApp risk warnings as before

Personal-WhatsApp automation rules haven't changed:

- Don't reduce delays below 3 seconds
- Don't run two copies (CLI + web) at the same time
- Keep a backup SIM ready
- If WhatsApp warns you, stop for 24–48 hours

The web UI doesn't change the underlying ban risk — same protocol, same
account, same machine. It's just a nicer way to drive it.
