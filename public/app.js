/* global io */
(() => {
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const socket = io();

  // ------------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------------
  let previewState = null; // { previews, missing, multiPhone, duplicates, date, ... }
  let sendingTotal = 0;

  // ------------------------------------------------------------------------
  // WhatsApp status chip & QR
  // ------------------------------------------------------------------------
  const waChip   = $('#waChip');
  const qrPanel  = $('#qrPanel');
  const qrImg    = $('#qrImg');
  const qrView   = $('#qrView');
  const statusView = $('#statusView');

  function setWaState(state) {
    waChip.dataset.state = state;
    const labels = {
      connecting:  'Connecting…',
      qr:          'Scan QR to link',
      connected:   'WhatsApp ready',
      disconnected:'Disconnected',
    };
    waChip.querySelector('.label').textContent = labels[state] || state;

    // Show the right view inside the popup
    const isConnected = state === 'connected';
    qrView.classList.toggle('hidden', isConnected);
    statusView.classList.toggle('hidden', !isConnected);

    // Auto-close popup once connected. Never auto-open — the user opens by clicking the chip.
    if (state === 'connected') qrPanel.classList.add('hidden');
  }

  // Click chip to toggle popup
  waChip.addEventListener('click', (e) => {
    e.stopPropagation();
    qrPanel.classList.toggle('hidden');
    smsPanel.classList.add('hidden');  // close the other popup
  });

  socket.on('wa:state', ({ state }) => setWaState(state));
  socket.on('wa:qr', ({ dataUrl }) => {
    qrImg.src = dataUrl;
    setWaState('qr');
  });
  socket.on('wa:logged-out', () => {
    alert('WhatsApp was logged out from this device. Click the chip top-right to scan again.');
  });

  // ------------------------------------------------------------------------
  // SMS status chip
  // ------------------------------------------------------------------------
  const smsChip = $('#smsChip');
  const smsPanel = $('#smsPanel');
  const smsUnconfiguredView = $('#smsUnconfiguredView');
  const smsDisconnectedView = $('#smsDisconnectedView');
  const smsConnectedView    = $('#smsConnectedView');

  function setSmsState(state, error) {
    $('#smsError').textContent = error || 'Check that SMS Gateway is online and the connection settings match the selected mode.';
    smsChip.dataset.state = state;
    const labels = {
      unconfigured: 'SMS not set up',
      checking:     'Checking gateway…',
      connected:    'Gateway ready',
      disconnected: 'Gateway unavailable',
    };
    smsChip.querySelector('.label').textContent = labels[state] || state;
    smsUnconfiguredView.classList.toggle('hidden', state !== 'unconfigured');
    smsDisconnectedView.classList.toggle('hidden', state !== 'disconnected');
    smsConnectedView.classList.toggle('hidden',    state !== 'connected');
  }

  smsChip.addEventListener('click', (e) => {
    e.stopPropagation();
    smsPanel.classList.toggle('hidden');
    qrPanel.classList.add('hidden');
  });

  socket.on('sms:state', ({ state, error }) => setSmsState(state, error));

  // "Retry connection" and "Send test SMS" buttons in the popup
  $('#smsRetryBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    setSmsState('checking');
    try {
      const r = await fetch('/api/sms/retry', { method: 'POST' }).then(r => r.json());
      setSmsState(r.sms.state, r.sms.error);
    } catch (err) { setSmsState('disconnected', err.message); }
  });

  $('#smsTestBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const num = prompt('Send a test SMS — to which 10-digit number?');
    if (!num) return;
    try {
      const r = await fetch('/api/sms/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: num }),
      }).then(r => r.json());
      alert(r.ok ? 'Test SMS accepted by the gateway. Check the receiving phone for delivery.' : `Failed: ${r.error}`);
    } catch (err) {
      alert('Failed: ' + err.message);
    }
  });

  // Click anywhere outside either popup to close both
  document.addEventListener('click', (e) => {
    const insideWa  = qrPanel.contains(e.target)  || waChip.contains(e.target);
    const insideSms = smsPanel.contains(e.target) || smsChip.contains(e.target);
    if (!insideWa)  qrPanel.classList.add('hidden');
    if (!insideSms) smsPanel.classList.add('hidden');
  });

  // ------------------------------------------------------------------------
  // Initial status load
  // ------------------------------------------------------------------------
  (async () => {
    try {
      const r = await fetch('/api/status').then(r => r.json());
      $('#firmLabel').textContent = r.firmName || '';
      setWaState(r.wa.state);
      if (r.wa.state === 'qr' && r.wa.qrDataUrl) {
        qrImg.src = r.wa.qrDataUrl;
      }
      if (r.sms) setSmsState(r.sms.state, r.sms.error);
    } catch (e) { console.error(e); }
  })();

  // ------------------------------------------------------------------------
  // Upload
  // ------------------------------------------------------------------------
  const dropZone     = $('#dropZone');
  const fileInput    = $('#fileInput');
  const uploadInfo   = $('#uploadInfo');
  const uploadSummary = $('#uploadSummary');
  const sheetSelect  = $('#sheetSelect');
  const paneExcel    = $('#paneExcel');
  const paneGsheet   = $('#paneGsheet');
  const gsheetTab    = $('#gsheetTab');
  const gsheetFetchBtn = $('#gsheetFetchBtn');
  const gsheetHint   = $('#gsheetHint');

  // Track which source the current upload came from. Drives sheetSelect behavior.
  let currentSource = null;  // 'excel' | 'gsheet' | null

  // ----- Source tab toggle -----
  document.querySelectorAll('.source-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.disabled) return;
      document.querySelectorAll('.source-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const src = tab.dataset.source;
      paneExcel.classList.toggle('hidden',  src !== 'excel');
      paneGsheet.classList.toggle('hidden', src !== 'gsheet');
    });
  });

  // ----- Excel upload (drop zone + file input) -----
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleUpload(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleUpload(fileInput.files[0]);
  });

  async function handleUpload(file, sheet) {
    const fd = new FormData();
    fd.append('file', file);
    if (sheet) fd.append('sheet', sheet);
    try {
      const r = await fetch('/api/upload', { method: 'POST', body: fd }).then(r => r.json());
      if (!r.ok) throw new Error(r.error);
      currentSource = 'excel';
      showUploaded(`${file.name} — ${r.lotCount} lots · sheet "${r.sheetName}"`, r);
      await refreshPreview();
    } catch (e) {
      alert(`Upload failed: ${e.message}`);
    }
  }

  // ----- Google Sheets fetch -----
  gsheetFetchBtn.addEventListener('click', () => fetchGSheet(null));

  async function fetchGSheet(sheetName) {
    const origText = gsheetFetchBtn.textContent;
    gsheetFetchBtn.disabled = true;
    gsheetFetchBtn.textContent = 'Fetching…';
    try {
      const r = await fetch('/api/gsheet/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet: sheetName || null }),
      }).then(r => r.json());
      if (!r.ok) throw new Error(r.error);
      currentSource = 'gsheet';
      showUploaded(`Google Sheet — ${r.lotCount} lots · tab "${r.sheetName}"`, r);
      await refreshPreview();
    } catch (e) {
      alert(`Could not fetch Google Sheet: ${e.message}`);
    } finally {
      gsheetFetchBtn.disabled = false;
      gsheetFetchBtn.textContent = origText;
    }
  }

  function showUploaded(summary, r) {
    uploadSummary.textContent = summary;
    sheetSelect.innerHTML = r.sheetNames
      .map(n => `<option value="${escapeHtml(n)}" ${n === r.sheetName ? 'selected' : ''}>${escapeHtml(n)}</option>`)
      .join('');
    uploadInfo.classList.remove('hidden');

    // Auto-fill the auction date from the sheet name if it looks like a date.
    // Sheet names follow DD-MM-YYYY (e.g. "20-04-2026") or DD-MM-YY (e.g. "20-04-26").
    // If the user already typed a date manually, don't overwrite — they may have
    // explicitly chosen something different.
    const dateFromSheet = parseSheetDate(r.sheetName);
    if (dateFromSheet) {
      // Always overwrite — the sheet selection is the authoritative date for this auction.
      // (If user wants to override, they can edit the input after.)
      dateInput.value = dateFromSheet;
    }
  }

  // Returns DD-MM-YYYY if sheet name parses as a date, else null.
  // Accepts: "20-04-2026", "20-04-26", "20/04/2026", "20.04.2026"
  function parseSheetDate(name) {
    if (!name) return null;
    const m = String(name).trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
    if (!m) return null;
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    let yyyy = m[3];
    if (yyyy.length === 2) yyyy = '20' + yyyy;  // 26 -> 2026
    return `${dd}-${mm}-${yyyy}`;
  }

  // Switching the chosen sheet re-runs the parser on whichever source we used.
  sheetSelect.addEventListener('change', async () => {
    const chosen = sheetSelect.value;
    if (currentSource === 'excel' && fileInput.files[0]) {
      await handleUpload(fileInput.files[0], chosen);
    } else if (currentSource === 'gsheet') {
      await fetchGSheet(chosen);
    }
  });

  // On boot, gray out the gsheet tab if it's not configured
  fetch('/api/status').then(r => r.json()).then(s => {
    if (!s.googleSheetConfigured) {
      gsheetTab.disabled = true;
      gsheetTab.title = 'Set googleSheetUrl in config.js to enable';
    }
  }).catch(() => {});

  // ------------------------------------------------------------------------
  // Preview
  // ------------------------------------------------------------------------
  const reviewPanel = $('#reviewPanel');
  const sendSection = $('#sendSection');
  const dateInput   = $('#dateInput');
  const resumeCheck = $('#resumeCheck');
  const testPhoneInput = $('#testPhoneInput');
  const previewTable = $('#previewTable');
  const previewSearch = $('#previewSearch');

  // Selection state — a Set of farmer names that are currently selected.
  // Fresh-loaded preview always fills this set with ALL farmers (default = all selected).
  const selectedFarmers = new Set();
  const selectionCount  = $('#selectionCount');
  const selectAllBtn    = $('#selectAllBtn');
  const deselectAllBtn  = $('#deselectAllBtn');

  // Today default (DD-MM-YYYY)
  (function setDefaultDate() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    dateInput.value = `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
  })();

  async function refreshPreview() {
    try {
      const r = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: dateInput.value.trim() || null,
          resume: resumeCheck.checked,
        }),
      }).then(r => r.json());
      if (!r.ok) throw new Error(r.error);

      previewState = r;

      // Summary cards
      $('#sumFarmers').textContent = r.farmerCount;
      $('#sumLots').textContent    = r.lotCount;

      // How many messages to actually send = sum of phones across sendable farmers,
      // minus already-sent pairs if resume
      const already = new Set((r.alreadySent || []).map(x => `${x.farmer}|${x.phone}`));
      let msgCount = 0;
      for (const p of r.previews) {
        for (const ph of p.phones) {
          if (!already.has(`${p.farmer}|${ph}`)) msgCount++;
        }
      }
      $('#sumMessages').textContent = msgCount;

      // Warning cards
      $('#sumMissing').textContent = r.missing.length;
      $('#cardMissing').classList.toggle('hidden', r.missing.length === 0);
      $('#sumMulti').textContent   = r.multiPhone.length;
      $('#cardMulti').classList.toggle('hidden', r.multiPhone.length === 0);
      $('#sumDupes').textContent   = r.duplicates.length;
      $('#cardDupes').classList.toggle('hidden', r.duplicates.length === 0);

      // Warnings detail
      const wb = $('#warningsBox');
      const parts = [];
      if (r.missing.length) {
        parts.push(`<h4>⚠ No phone for ${r.missing.length} farmer(s) — will be skipped</h4>
          <ul>${r.missing.map(m => `<li><strong>${m.farmer}</strong> (${m.lotCount} lot${m.lotCount>1?'s':''})</li>`).join('')}</ul>`);
      }
      if (r.duplicates.length) {
        parts.push(`<h4>⚠ Same phone used for multiple farmers — likely an error</h4>
          <ul>${r.duplicates.map(d => `<li><code>${d.phone.slice(2)}</code> → ${d.farmers.join(', ')}</li>`).join('')}</ul>`);
      }
      wb.innerHTML = parts.join('');
      wb.classList.toggle('hidden', parts.length === 0);

      // On new preview: mark ALL farmers-with-phones as selected by default
      selectedFarmers.clear();
      for (const p of (r.previews || [])) selectedFarmers.add(p.farmer);

      // Preview rows
      renderPreviewTable(r, already);
      updateSelectionCount();
      reviewPanel.classList.remove('hidden');
      sendSection.classList.remove('hidden');

      // Also refresh the Vyapari preview from the same upload (parallel work)
      refreshPreviewVy();
      // Reveal view tabs once we have data loaded
      $('#viewTabs').classList.remove('hidden');
    } catch (e) {
      alert(`Preview failed: ${e.message}`);
    }
  }

  function renderPreviewTable(state, alreadySet) {
    const q = previewSearch.value.trim().toUpperCase();

    const allFarmers = [
      ...(state.previews || []).map(p => ({ ...p, hasPhone: true })),
      ...(state.missing  || []).map(m => ({ ...m, phones: [], hasPhone: false })),
    ];

    const dupePhones = new Set((state.duplicates || []).map(d => d.phone));
    const filtered = q ? allFarmers.filter(p => p.farmer.includes(q)) : allFarmers;

    if (!filtered.length) {
      previewTable.innerHTML = `
        <thead>${renderHead()}</thead>
        <tbody><tr class="empty-row"><td colspan="3">No farmers match your search.</td></tr></tbody>`;
      return;
    }

    const rows = [];
    rows.push(`<thead>${renderHead()}</thead>`);
    rows.push('<tbody>');

    for (const p of filtered) {
      const tags = [];
      if (!p.hasPhone) {
        tags.push(`<span class="farmer-tag tag-missing">No phone</span>`);
      } else {
        const allSent = p.phones.every(ph => alreadySet.has(`${p.farmer}|${ph}`));
        if (allSent) tags.push(`<span class="farmer-tag tag-sent">Already sent</span>`);
        if (p.phones.length > 1) tags.push(`<span class="farmer-tag tag-multi">${p.phones.length} phones</span>`);
        if (p.phones.some(ph => dupePhones.has(ph))) {
          tags.push(`<span class="farmer-tag tag-dupe">Duplicate phone</span>`);
        }
      }

      const phonesText = p.phones.length
        ? p.phones.map(ph => {
            const sent = alreadySet.has(`${p.farmer}|${ph}`);
            return `${ph.slice(2)}${sent ? ' ✓' : ''}`;
          }).join(', ')
        : '—';

      const isSelected = p.hasPhone && selectedFarmers.has(p.farmer);
      const headClasses = [
        'farmer-head',
        p.hasPhone ? '' : 'missing-phone',
        (!isSelected && p.hasPhone) ? 'deselected' : '',
      ].filter(Boolean).join(' ');

      // Checkbox only for farmers WITH a phone (no-phone farmers can't be sent to anyway)
      const checkbox = p.hasPhone
        ? `<label class="farmer-select" title="Include this farmer in sends">
             <input type="checkbox" data-farmer="${escapeHtml(p.farmer)}" ${isSelected ? 'checked' : ''} />
           </label>`
        : `<span class="farmer-select"><span style="width:16px;display:inline-block;"></span></span>`;

      rows.push(`
        <tr class="${headClasses}">
          <td colspan="3">
            ${checkbox}
            <span class="farmer-name">${escapeHtml(p.farmer)}</span>
            <span class="farmer-phones">${escapeHtml(phonesText)}</span>
            ${tags.join(' ')}
          </td>
        </tr>
      `);

      for (const l of (p.lots || [])) {
        const rate = (l.farmerRate !== null && l.farmerRate !== undefined && l.farmerRate !== '')
          ? `₹${l.farmerRate}`
          : '—';
        const qty = (l.qty !== null && l.qty !== undefined && l.qty !== '') ? l.qty : '—';
        const lotClasses = [
          'lot-row',
          p.hasPhone ? '' : 'missing-phone',
          (!isSelected && p.hasPhone) ? 'deselected' : '',
        ].filter(Boolean).join(' ');
        rows.push(`
          <tr class="${lotClasses}">
            <td class="col-lot mono">${escapeHtml(l.marka)}</td>
            <td class="col-qty num">${escapeHtml(String(qty))}</td>
            <td class="col-rate num">${escapeHtml(rate)}</td>
          </tr>
        `);
      }
    }

    rows.push('</tbody>');
    previewTable.innerHTML = rows.join('');
  }

  // Delegated checkbox handler — survives re-renders
  previewTable.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-farmer]');
    if (!cb) return;
    const farmer = cb.getAttribute('data-farmer');
    if (cb.checked) selectedFarmers.add(farmer);
    else selectedFarmers.delete(farmer);
    updateSelectionCount();
    // Toggle the "deselected" class on the farmer-head and its following lot rows
    toggleFarmerRowsDim(farmer, !cb.checked);
  });

  function toggleFarmerRowsDim(farmerName, deselected) {
    // Find the head row by its checkbox
    const cb = previewTable.querySelector(`input[data-farmer="${cssEscape(farmerName)}"]`);
    if (!cb) return;
    let row = cb.closest('tr.farmer-head');
    if (!row) return;
    row.classList.toggle('deselected', deselected);
    let next = row.nextElementSibling;
    while (next && next.classList.contains('lot-row')) {
      next.classList.toggle('deselected', deselected);
      next = next.nextElementSibling;
    }
  }

  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~ ])/g, '\\$1');
  }

  function updateSelectionCount() {
    if (!previewState) { selectionCount.textContent = '0 of 0 farmers selected'; return; }
    const withPhone = (previewState.previews || []).length;
    selectionCount.textContent = `${selectedFarmers.size} of ${withPhone} farmers selected`;
  }

  selectAllBtn.addEventListener('click', () => {
    if (!previewState) return;
    for (const p of previewState.previews) selectedFarmers.add(p.farmer);
    // Re-render to reflect checked boxes
    const already = lastAlreadySet();
    renderPreviewTable(previewState, already);
    updateSelectionCount();
  });

  deselectAllBtn.addEventListener('click', () => {
    selectedFarmers.clear();
    const already = lastAlreadySet();
    renderPreviewTable(previewState, already);
    updateSelectionCount();
  });

  function lastAlreadySet() {
    if (!previewState) return new Set();
    return new Set((previewState.alreadySent || []).map(x => `${x.farmer}|${x.phone}`));
  }

  function renderHead() {
    return `
      <tr>
        <th class="col-lot">Lot</th>
        <th class="col-qty num">Qty (Boxes)</th>
        <th class="col-rate num">Rate</th>
      </tr>
    `;
  }

  // ========================================================================
  // VYAPARI VIEW — buyers, parallels much of the Shetkari logic above
  // ========================================================================

  const reviewPanelVy = $('#reviewPanelVy');
  const sendSectionVy = $('#sendSectionVy');
  const previewTableVy = $('#previewTableVy');
  const previewSearchVy = $('#previewSearchVy');
  const selectedBuyers = new Set();
  const selectionCountVy = $('#selectionCountVy');
  let previewStateVy = null;

  // View toggle: Shetkari | Vyapari
  document.querySelectorAll('.view-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const v = tab.dataset.view;
      $('#viewShetkari').classList.toggle('hidden', v !== 'shetkari');
      $('#viewVyapari').classList.toggle('hidden',  v !== 'vyapari');
    });
  });

  async function refreshPreviewVy() {
    try {
      const r = await fetch('/api/preview-buyers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: dateInput.value.trim() || null,
          resume: resumeCheck.checked,
        }),
      }).then(r => r.json());
      if (!r.ok) throw new Error(r.error);
      previewStateVy = r;

      // Summary cards
      $('#sumBuyers').textContent          = r.buyerCount;
      $('#sumConfirmedLots').textContent   = r.confirmedLotCount;
      $('#sumSkippedLots').textContent     = r.skippedLotCount;
      $('#sumUnknown').textContent         = r.unknown.length;
      $('#cardUnknownBuyers').classList.toggle('hidden', r.unknown.length === 0);
      $('#sumNoPhone').textContent         = r.noPhone.length;
      $('#cardNoPhoneBuyers').classList.toggle('hidden', r.noPhone.length === 0);

      // Warnings detail
      const wb = $('#warningsBoxVy');
      const parts = [];
      if (r.unknown.length) {
        parts.push(`<h4>⚠ Unknown buyer shortname(s) — not in buyer book, will be skipped</h4>
          <ul>${r.unknown.map(u => `<li><strong>${escapeHtml(u.shortname)}</strong> (${u.lotCount} lot${u.lotCount>1?'s':''}) — add to <code>data/buyer_book.json</code> to enable sending</li>`).join('')}</ul>`);
      }
      if (r.noPhone.length) {
        parts.push(`<h4>⚠ Buyer in book but no phone</h4>
          <ul>${r.noPhone.map(n => `<li><strong>${escapeHtml(n.shortname)}</strong> (${escapeHtml(n.fullName)}) — ${n.lotCount} lot${n.lotCount>1?'s':''} — add phone in <code>data/buyer_book.json</code></li>`).join('')}</ul>`);
      }
      wb.innerHTML = parts.join('');
      wb.classList.toggle('hidden', parts.length === 0);

      // Default-select all sendable buyers
      selectedBuyers.clear();
      for (const p of (r.previews || [])) selectedBuyers.add(p.shortname.toUpperCase());

      renderBuyerPreviewTable(r);
      updateBuyerSelectionCount();
      reviewPanelVy.classList.remove('hidden');
      sendSectionVy.classList.remove('hidden');
    } catch (e) {
      console.error('Vyapari preview failed:', e);
      // Don't alert on Vyapari errors during a Shetkari workflow — just log.
      // It's fine if buyer preview fails (e.g. empty book) while Shetkari preview succeeds.
    }
  }

  function renderBuyerPreviewTable(state) {
    const q = previewSearchVy.value.trim().toUpperCase();

    // Combined list: sendable buyers + unknown + noPhone — all visible so user sees full picture
    const allBuyers = [
      ...(state.previews || []).map(p => ({ ...p, kind: 'sendable' })),
      ...(state.noPhone  || []).map(p => ({ ...p, kind: 'noPhone' })),
      ...(state.unknown  || []).map(p => ({ ...p, kind: 'unknown' })),
    ];
    const filtered = q ? allBuyers.filter(p =>
      p.shortname.toUpperCase().includes(q) ||
      (p.fullName && p.fullName.toUpperCase().includes(q))
    ) : allBuyers;

    if (!filtered.length) {
      previewTableVy.innerHTML = `
        <thead>${renderBuyerHead()}</thead>
        <tbody><tr class="empty-row"><td colspan="4">No buyers match your search.</td></tr></tbody>`;
      return;
    }

    const rows = [];
    rows.push(`<thead>${renderBuyerHead()}</thead>`);
    rows.push('<tbody>');

    for (const p of filtered) {
      const isSendable = p.kind === 'sendable';
      const isSelected = isSendable && selectedBuyers.has(p.shortname.toUpperCase());

      const tags = [];
      if (p.kind === 'unknown') tags.push(`<span class="farmer-tag tag-unknown">Unknown shortname</span>`);
      if (p.kind === 'noPhone') tags.push(`<span class="farmer-tag tag-missing">No phone in book</span>`);
      if (isSendable) {
        tags.push(`<span class="farmer-tag tag-buyer">${p.lotCount} lot${p.lotCount>1?'s':''}</span>`);
        const dateParam = encodeURIComponent(dateInput.value.trim() || '');
        const sn = encodeURIComponent(p.shortname);
        tags.push(`<a class="farmer-tag tag-buyer image-preview-link" href="/api/buyer-image/${sn}?date=${dateParam}" target="_blank" rel="noopener" title="See the image that will be sent to ${escapeHtml(p.shortname)}">📷 Preview image</a>`);
      }

      const checkbox = isSendable
        ? `<label class="farmer-select" title="Include this buyer in sends">
             <input type="checkbox" data-buyer="${escapeHtml(p.shortname.toUpperCase())}" ${isSelected ? 'checked' : ''} />
           </label>`
        : `<span class="farmer-select"><span style="width:16px;display:inline-block;"></span></span>`;

      const phoneText = isSendable && p.phones && p.phones.length ? p.phones[0].slice(2) : '—';
      const headerLabel = isSendable
        ? `<span class="farmer-name">${escapeHtml(p.fullName || p.shortname)}</span> <span class="muted small">(${escapeHtml(p.shortname)})</span>`
        : p.kind === 'noPhone'
          ? `<span class="farmer-name">${escapeHtml(p.fullName || p.shortname)}</span> <span class="muted small">(${escapeHtml(p.shortname)})</span>`
          : `<span class="farmer-name">${escapeHtml(p.shortname)}</span>`;

      const headClasses = [
        'farmer-head',
        !isSendable ? 'missing-phone' : '',
        (isSendable && !isSelected) ? 'deselected' : '',
      ].filter(Boolean).join(' ');

      rows.push(`
        <tr class="${headClasses}">
          <td colspan="4">
            ${checkbox}
            ${headerLabel}
            <span class="farmer-phones">${escapeHtml(phoneText)}</span>
            ${tags.join(' ')}
          </td>
        </tr>
      `);

      for (const l of (p.lots || [])) {
        const rate = (l.buyerRate !== null && l.buyerRate !== undefined && l.buyerRate !== '') ? `₹${l.buyerRate}` : '—';
        const qty  = (l.qty !== null && l.qty !== undefined && l.qty !== '') ? l.qty : '—';
        const lotClasses = [
          'lot-row',
          !isSendable ? 'missing-phone' : '',
          (isSendable && !isSelected) ? 'deselected' : '',
        ].filter(Boolean).join(' ');
        rows.push(`
          <tr class="${lotClasses}">
            <td class="mono">${escapeHtml(l.farmer)}</td>
            <td class="col-lot mono">${escapeHtml(l.marka)}</td>
            <td class="col-qty num">${escapeHtml(String(qty))}</td>
            <td class="col-rate num">${escapeHtml(rate)}</td>
          </tr>
        `);
      }
    }

    rows.push('</tbody>');
    previewTableVy.innerHTML = rows.join('');
  }

  function renderBuyerHead() {
    return `
      <tr>
        <th>Farmer</th>
        <th class="col-lot">Lot</th>
        <th class="col-qty num">Qty (Boxes)</th>
        <th class="col-rate num">Buyer's Rate</th>
      </tr>
    `;
  }

  previewTableVy.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-buyer]');
    if (!cb) return;
    const sn = cb.getAttribute('data-buyer');
    if (cb.checked) selectedBuyers.add(sn);
    else selectedBuyers.delete(sn);
    updateBuyerSelectionCount();
    toggleBuyerRowsDim(sn, !cb.checked);
  });

  function toggleBuyerRowsDim(shortnameUpper, deselected) {
    const cb = previewTableVy.querySelector(`input[data-buyer="${cssEscape(shortnameUpper)}"]`);
    if (!cb) return;
    let row = cb.closest('tr.farmer-head');
    if (!row) return;
    row.classList.toggle('deselected', deselected);
    let next = row.nextElementSibling;
    while (next && next.classList.contains('lot-row')) {
      next.classList.toggle('deselected', deselected);
      next = next.nextElementSibling;
    }
  }

  function updateBuyerSelectionCount() {
    if (!previewStateVy) { selectionCountVy.textContent = '0 of 0 buyers selected'; return; }
    const sendable = (previewStateVy.previews || []).length;
    selectionCountVy.textContent = `${selectedBuyers.size} of ${sendable} buyers selected`;
  }

  $('#selectAllBtnVy').addEventListener('click', () => {
    if (!previewStateVy) return;
    for (const p of previewStateVy.previews) selectedBuyers.add(p.shortname.toUpperCase());
    renderBuyerPreviewTable(previewStateVy);
    updateBuyerSelectionCount();
  });
  $('#deselectAllBtnVy').addEventListener('click', () => {
    selectedBuyers.clear();
    if (previewStateVy) renderBuyerPreviewTable(previewStateVy);
    updateBuyerSelectionCount();
  });

  previewSearchVy.addEventListener('input', () => {
    if (previewStateVy) renderBuyerPreviewTable(previewStateVy);
  });
  $('#refreshPreviewBtnVy').addEventListener('click', refreshPreviewVy);

  // ----- Vyapari send wiring (WhatsApp only — SMS is not sent for Vyapari) -----
  const vyPanels = {
    wa: {
      sendBtn:       $('#sendVyWaBtn'),
      stopBtn:       $('#stopVyWaBtn'),
      progressWrap:  $('#progressWrapVyWa'),
      progressBar:   $('#progressBarVyWa'),
      progressLabel: $('#progressLabelVyWa'),
      liveLog:       $('#liveLogVyWa'),
      statusLabel:   $('#sendPanelStatusVyWa'),
      label:         'Vyapari WhatsApp',
      endpoint:      '/api/send-buyers',
      checkConnected: () => waChip.dataset.state === 'connected',
      notConnectedMsg: 'WhatsApp is not connected. Click the WA chip top-right to scan the QR first.',
    },
  };

  async function startSendVy(channel) {
    const p = vyPanels[channel];
    if (!previewStateVy) { alert('Vyapari preview not loaded yet'); return; }
    if (!previewStateVy.previews.length) { alert('No sendable buyers — check buyer book'); return; }
    if (selectedBuyers.size === 0) {
      alert('No buyers selected. Tick the checkbox next to at least one buyer.');
      return;
    }
    if (!p.checkConnected()) { alert(p.notConnectedMsg); return; }

    const selectedList = [...selectedBuyers];
    const testPhoneVal = testPhoneInput.value.trim();
    const confirmMsg = testPhoneVal
      ? `This will send ${selectedList.length} ${p.label} messages to your test number (${testPhoneVal}). Continue?`
      : `This will LIVE SEND ${p.label} to ${selectedList.length} buyer(s). Continue?`;
    if (!confirm(confirmMsg)) return;

    p.liveLog.innerHTML = '';
    p.statusLabel.classList.remove('done', 'failed');
    p.statusLabel.classList.add('busy');
    p.statusLabel.textContent = 'Starting…';

    try {
      const r = await fetch(p.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: dateInput.value.trim() || null,
          resume: resumeCheck.checked,
          testPhone: testPhoneVal || null,
          selectedBuyers: selectedList,
          sendAsImage: channel === 'wa' ? !!$('#sendAsImageCheck').checked : false,
        }),
      }).then(r => r.json());
      if (!r.ok) throw new Error(r.error);

      p.progressWrap.classList.remove('hidden');
      p.sendBtn.classList.add('hidden');
      p.stopBtn.classList.remove('hidden');
      p.statusLabel.textContent = `Sending to ${r.total}…`;
      updateVyPanelProgress(channel, 0, r.total);
    } catch (e) {
      p.statusLabel.classList.remove('busy');
      p.statusLabel.classList.add('failed');
      p.statusLabel.textContent = 'Failed to start';
      alert(`Could not start ${p.label}: ${e.message}`);
    }
  }

  vyPanels.wa.sendBtn.addEventListener('click',  () => startSendVy('wa'));

  function stopVyChannel(channel) {
    const p = vyPanels[channel];
    if (!confirm(`Stop the ${p.label} send? Messages already sent stay sent.`)) return;
    fetch('/api/job/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, view: 'vyapari' }),
    }).catch(() => {});
  }
  vyPanels.wa.stopBtn.addEventListener('click',  () => stopVyChannel('wa'));

  function updateVyPanelProgress(channel, i, total) {
    const p = vyPanels[channel];
    if (!p) return;
    const pct = total ? (i / total) * 100 : 0;
    p.progressBar.style.width = `${pct}%`;
    p.progressLabel.textContent = `${i} / ${total}`;
  }

  function addVyLog(channel, { icon, klass, name, phone, detail }) {
    const p = vyPanels[channel];
    if (!p) return;
    const t = new Date().toLocaleTimeString('en-IN', { hour12: false });
    const channelTag = `<span class="channel-tag ${channel}">${channel === 'sms' ? 'SMS' : 'WA'}</span>`;
    const row = document.createElement('div');
    row.className = `log-entry ${klass}`;
    row.innerHTML = `
      <span class="t">${t}</span>
      ${channelTag}
      <span class="icon">${icon}</span>
      <span><span class="farmer">${escapeHtml(name)}</span> <span class="phone">${escapeHtml(phone || '')}</span> ${detail ? `<span class="muted">— ${escapeHtml(detail)}</span>` : ''}</span>
      <span></span>
    `;
    p.liveLog.appendChild(row);
    p.liveLog.scrollTop = p.liveLog.scrollHeight;
  }

  // ----- Buyer book status pill -----
  async function refreshBuyerBookPill() {
    try {
      const r = await fetch('/api/buyer-book').then(r => r.json());
      if (!r.ok) return;
      const pill = $('#buyerBookPill');
      pill.textContent = String(r.count);
      pill.classList.toggle('empty', r.count === 0);
    } catch {}
  }
  refreshBuyerBookPill();

  // Show view tabs after first upload
  function showViewTabs() {
    $('#viewTabs').classList.remove('hidden');
  }

  // Hook into upload completion: when Shetkari preview refreshes, also refresh Vyapari preview
  // and reveal the view tabs. Since both refresh functions read the same latestUpload,
  // we just kick off the Vyapari one alongside.
  // (The original refreshPreview is unchanged; we extend by intercepting handleUpload &
  // fetchGSheet completion via setting a flag, but the cleanest approach is to call both
  // from within handleUpload/fetchGSheet. Done by patching showUploaded.)

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  previewSearch.addEventListener('input', () => {
    if (previewState) {
      const already = new Set((previewState.alreadySent || []).map(x => `${x.farmer}|${x.phone}`));
      renderPreviewTable(previewState, already);
    }
  });
  dateInput.addEventListener('change', () => { refreshPreview(); refreshPreviewVy(); });
  resumeCheck.addEventListener('change', () => { refreshPreview(); refreshPreviewVy(); });
  $('#refreshPreviewBtn').addEventListener('click', refreshPreview);

  // ------------------------------------------------------------------------
  // Send — TWO independent panels, WA and SMS can run simultaneously
  // ------------------------------------------------------------------------

  // Per-channel DOM references — keyed by channel name
  const panels = {
    wa: {
      sendBtn:       $('#sendWaBtn'),
      stopBtn:       $('#stopWaBtn'),
      progressWrap:  $('#progressWrapWa'),
      progressBar:   $('#progressBarWa'),
      progressLabel: $('#progressLabelWa'),
      liveLog:       $('#liveLogWa'),
      statusLabel:   $('#sendPanelStatusWa'),
      label:         'WhatsApp',
      endpoint:      '/api/send',
      checkConnected: () => waChip.dataset.state === 'connected',
      notConnectedMsg: 'WhatsApp is not connected. Click the WA chip top-right to scan the QR first.',
    },
    sms: {
      sendBtn:       $('#sendSmsBtn'),
      stopBtn:       $('#stopSmsBtn'),
      progressWrap:  $('#progressWrapSms'),
      progressBar:   $('#progressBarSms'),
      progressLabel: $('#progressLabelSms'),
      liveLog:       $('#liveLogSms'),
      statusLabel:   $('#sendPanelStatusSms'),
      label:         'SMS',
      endpoint:      '/api/send-sms',
      checkConnected: () => smsChip.dataset.state === 'connected',
      notConnectedMsg: 'SMS Gateway is not ready. Click the SMS chip top-right to check.',
    },
  };

  async function startSend(channel) {
    const p = panels[channel];
    if (!previewState) { alert('Upload a file first'); return; }
    if (!previewState.previews.length) { alert('No farmers to send to'); return; }
    if (selectedFarmers.size === 0) {
      alert('No farmers selected. Tick the checkbox next to at least one farmer.');
      return;
    }
    if (!p.checkConnected()) { alert(p.notConnectedMsg); return; }

    const selectedList = [...selectedFarmers];
    const testPhoneVal = testPhoneInput.value.trim();
    const confirmMsg = testPhoneVal
      ? `This will send ${selectedList.length} ${p.label} messages to your test number (${testPhoneVal}). Continue?`
      : `This will LIVE SEND ${p.label} to ${selectedList.length} farmers. Continue?`;
    if (!confirm(confirmMsg)) return;

    p.liveLog.innerHTML = '';
    p.statusLabel.classList.remove('done', 'failed');
    p.statusLabel.classList.add('busy');
    p.statusLabel.textContent = 'Starting…';

    try {
      const r = await fetch(p.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: dateInput.value.trim() || null,
          resume: resumeCheck.checked,
          testPhone: testPhoneVal || null,
          selectedFarmers: selectedList,
        }),
      }).then(r => r.json());
      if (!r.ok) throw new Error(r.error);

      p.progressWrap.classList.remove('hidden');
      p.sendBtn.classList.add('hidden');
      p.stopBtn.classList.remove('hidden');
      p.statusLabel.textContent = `Sending to ${r.total}…`;
      updatePanelProgress(channel, 0, r.total);
    } catch (e) {
      p.statusLabel.classList.remove('busy');
      p.statusLabel.classList.add('failed');
      p.statusLabel.textContent = 'Failed to start';
      alert(`Could not start ${p.label}: ${e.message}`);
    }
  }

  panels.wa.sendBtn.addEventListener('click',  () => startSend('wa'));
  panels.sms.sendBtn.addEventListener('click', () => startSend('sms'));

  function stopChannel(channel) {
    const p = panels[channel];
    if (!confirm(`Stop the ${p.label} send? Messages already sent stay sent.`)) return;
    fetch('/api/job/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel }),
    }).catch(() => {});
  }
  panels.wa.stopBtn.addEventListener('click',  () => stopChannel('wa'));
  panels.sms.stopBtn.addEventListener('click', () => stopChannel('sms'));

  function updatePanelProgress(channel, i, total) {
    const p = panels[channel];
    const pct = total ? (i / total) * 100 : 0;
    p.progressBar.style.width = `${pct}%`;
    p.progressLabel.textContent = `${i} / ${total}`;
  }

  function addLog(channel, { icon, klass, farmer, phone, detail }) {
    const p = panels[channel];
    if (!p) return;
    const t = new Date().toLocaleTimeString('en-IN', { hour12: false });
    const row = document.createElement('div');
    row.className = `log-entry ${klass}`;
    const channelTag = `<span class="channel-tag ${channel}">${channel === 'sms' ? 'SMS' : 'WA'}</span>`;
    row.innerHTML = `
      <span class="t">${t}</span>
      ${channelTag}
      <span class="icon">${icon}</span>
      <span><span class="farmer">${escapeHtml(farmer)}</span> <span class="phone">${escapeHtml(phone || '')}</span> ${detail ? `<span class="muted">— ${escapeHtml(detail)}</span>` : ''}</span>
      <span></span>
    `;
    p.liveLog.appendChild(row);
    p.liveLog.scrollTop = p.liveLog.scrollHeight;
  }

  // Track which view's WA job is currently paused (for the not-on-whatsapp modal).
  // Server only allows one WA job at a time, so this is unambiguous.
  let pausedView = null;

  socket.on('job:progress', (r) => {
    const channel = r.channel || 'wa';
    const view = r.view || 'shetkari';
    if (r.status === 'sent' || r.status === 'failed' || r.status === 'not_on_whatsapp') {
      if (view === 'vyapari') updateVyPanelProgress(channel, r.i, r.total);
      else                    updatePanelProgress(channel, r.i, r.total);
    }
  });

  socket.on('job:log', (r) => {
    const channel = r.channel || 'wa';
    const view = r.view || 'shetkari';
    const map = {
      sent:              { icon: '✓', klass: 'sent' },
      sms_sent:          { icon: '✓', klass: 'sms_sent' },
      failed:            { icon: '✗', klass: 'failed' },
      sms_failed:        { icon: '✗', klass: 'sms_failed' },
      not_on_whatsapp:   { icon: '⚠', klass: 'not_on_whatsapp' },
      // Vyapari-side variants — same icons, view-specific class for any future styling
      buyer_sent:        { icon: '✓', klass: 'sent' },
      buyer_sms_sent:    { icon: '✓', klass: 'sms_sent' },
      buyer_failed:      { icon: '✗', klass: 'failed' },
      buyer_sms_failed:  { icon: '✗', klass: 'sms_failed' },
    };
    const cfg = map[r.status] || { icon: '•', klass: '' };

    if (view === 'vyapari') {
      // r.farmer is reused server-side for the recipient identifier (buyer shortname here)
      addVyLog(channel, { icon: cfg.icon, klass: cfg.klass, name: r.farmer, phone: r.phone, detail: r.error });
    } else {
      addLog(channel, { icon: cfg.icon, klass: cfg.klass, farmer: r.farmer, phone: r.phone, detail: r.error });
    }

    if (r.status === 'not_on_whatsapp' && channel === 'wa') {
      pausedView = view;
      showNotOnWaModal(r.farmer, r.phone);
    }
  });

  socket.on('job:done', (s) => {
    const channel = s.channel || 'wa';
    const view = s.view || 'shetkari';
    const p = (view === 'vyapari') ? vyPanels[channel] : panels[channel];
    if (!p) return;  // e.g. stale vyapari-sms event after we removed that panel
    p.sendBtn.classList.remove('hidden');
    p.stopBtn.classList.add('hidden');
    if (channel === 'wa' && pausedView === view) {
      hideNotOnWaModal();
      pausedView = null;
    }

    const isSms = channel === 'sms';
    const channelName = isSms ? 'SMS' : 'WhatsApp';
    const viewName = view === 'vyapari' ? 'Vyapari' : 'Shetkari';
    const summary = isSms
      ? `${viewName} ${channelName} done. Sent ${s.ok}, failed ${s.failed}${s.stopped ? ' (stopped)' : ''}.`
      : `${viewName} ${channelName} done. Sent ${s.ok}, not-on-WhatsApp ${s.notOnWa || 0}, failed ${s.failed}${s.stopped ? ' (stopped)' : ''}.`;

    if (view === 'vyapari') {
      addVyLog(channel, { icon: '·', klass: '', name: '(summary)', phone: '', detail: summary });
    } else {
      addLog(channel, { icon: '·', klass: '', farmer: '(summary)', phone: '', detail: summary });
    }

    p.statusLabel.classList.remove('busy');
    if (s.error || s.failed > 0) {
      p.statusLabel.classList.add('failed');
      p.statusLabel.textContent = s.stopped ? 'Stopped' : 'Done with errors';
    } else {
      p.statusLabel.classList.add('done');
      p.statusLabel.textContent = s.stopped ? 'Stopped' : 'Done';
    }
  });

  // ------------------------------------------------------------------------
  // 'Not on WhatsApp' modal
  // ------------------------------------------------------------------------
  const modal = $('#notOnWaModal');
  function showNotOnWaModal(farmer, phone) {
    $('#notOnWaFarmer').textContent = farmer;
    $('#notOnWaPhone').textContent = (phone || '').replace(/^91/, '');
    modal.classList.remove('hidden');
  }
  function hideNotOnWaModal() { modal.classList.add('hidden'); }

  $('#notOnWaSkip').addEventListener('click', async () => {
    hideNotOnWaModal();
    await fetch('/api/job/pause-ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'skip' }),
    });
  });
  $('#notOnWaStop').addEventListener('click', async () => {
    hideNotOnWaModal();
    await fetch('/api/job/pause-ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    });
  });

  // ------------------------------------------------------------------------
  // Unlink button (in WhatsApp popup)
  // ------------------------------------------------------------------------
  $('#resetWaBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Unlink WhatsApp? You will need to scan the QR again to send messages.')) return;
    qrPanel.classList.add('hidden');
    try {
      await fetch('/api/wa/reset', { method: 'POST' });
    } catch (err) {
      alert('Could not unlink: ' + err.message);
    }
  });
})();
