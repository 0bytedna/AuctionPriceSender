(() => {
  const $ = id => document.getElementById(id);
  const editor = $('buyerEditor');
  const rows = $('buyerEditorRows');
  let revision, dirty = false, busy = false;
  function status(text) { $('buyerEditorStatus').textContent = text; }
  function controls() {
    $('saveBuyerBookBtn').disabled = busy || !revision;
    $('addBuyerBtn').disabled = busy || !revision;
    $('reloadBuyerBookBtn').disabled = busy;
    rows.querySelectorAll('input,button').forEach(el => { el.disabled = busy; });
  }
  function addRow(buyer = {}) {
    const row = document.createElement('div');
    row.className = 'buyer-editor-row';
    for (const [key, title] of [['shortname', 'Shortname'], ['fullName', 'Full name'], ['phone', 'Phone number']]) {
      const label = document.createElement('label');
      label.textContent = title;
      const input = document.createElement('input');
      input.type = key === 'phone' ? 'tel' : 'text';
      input.dataset.field = key;
      input.value = buyer[key] || '';
      input.maxLength = key === 'fullName' ? 160 : key === 'shortname' ? 60 : 24;
      input.addEventListener('input', () => { dirty = true; status('Unsaved changes'); });
      label.append(input); row.append(label);
    }
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'btn danger'; remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      if (!confirm('Remove this buyer? The change takes effect when you save.')) return;
      row.remove(); dirty = true; status('Unsaved changes');
    });
    row.append(remove); rows.append(row);
    return row;
  }
  async function load() {
    if (busy || (dirty && !confirm('Discard unsaved buyer changes and reload?'))) return;
    busy = true; controls(); status('Loading buyers…');
    try {
      const r = await fetch('/api/buyer-book').then(r => r.json());
      if (!r.ok) throw new Error(r.error);
      rows.replaceChildren(); r.buyers.forEach(addRow);
      revision = r.revision; dirty = false; status(`${r.count} buyers loaded.`);
    } catch (e) { status(e.message); }
    finally { busy = false; controls(); }
  }
  editor.addEventListener('toggle', () => { if (editor.open && !revision) load(); });
  $('reloadBuyerBookBtn').addEventListener('click', load);
  $('addBuyerBtn').addEventListener('click', () => {
    addRow().querySelector('input').focus(); dirty = true; status('Unsaved changes');
  });
  $('saveBuyerBookBtn').addEventListener('click', async () => {
    if (busy) return;
    const buyers = [...rows.children].map(row => Object.fromEntries([...row.querySelectorAll('input')].map(input => [input.dataset.field, input.value])));
    if (!buyers.length && !confirm('Save an empty Buyer Book? This removes all saved buyers.')) return;
    busy = true; controls(); status('Saving…');
    try {
      const r = await fetch('/api/buyer-book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buyers, revision }) }).then(r => r.json());
      if (!r.ok) throw new Error(r.error);
      revision = r.revision; dirty = false;
      status('Buyer Book saved. Changes apply immediately.');
      $('buyerBookPill').textContent = buyers.length;
      $('buyerBookPill').classList.toggle('empty', !buyers.length);
      document.dispatchEvent(new Event('buyer-book:saved'));
    } catch (e) { status(e.message); }
    finally { busy = false; controls(); }
  });
  window.addEventListener('beforeunload', event => {
    if (dirty) { event.preventDefault(); event.returnValue = ''; }
  });
})();
