Pavan Cold Storage — Auction Sender Web
=========================================

QUICK START
-----------
1. Install Node.js v18+ from https://nodejs.org
2. Open Command Prompt in this folder
3. Run:  npm install
4. Run:  npm start
5. Open: http://localhost:3000
6. First time only: scan WhatsApp QR (click WA chip top-right)

DAILY WORKFLOW
--------------
Shetkari — send prices to farmers:
  1. Step 1: fetch from Google Sheets or upload Excel
  2. Step 2: review farmers, untick anyone to skip
  3. Step 3: Send WhatsApp + Send SMS (run in parallel)

Vyapari — send confirmed lots to buyers:
  1. Same Step 1
  2. Click Vyapari tab above Step 2
  3. Click "📷 Preview image" to verify each buyer's image
  4. Click "Send WhatsApp" — sends image to each buyer

BUYER BOOK
----------
Edit  data/buyer_book.json  to add/update buyers.
Restart server after editing.

CONFIG
------
Edit  config.js  to change firm name, Google Sheet URL, SMS settings.

IF SOMETHING BREAKS
-------------------
Check the Command Prompt window for error messages.
All sent messages are logged to  sent_log.csv
