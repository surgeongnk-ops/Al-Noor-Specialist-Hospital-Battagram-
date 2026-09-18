// ===== Centralized reactive API client & error handling =====
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'same-origin'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Same as api(), but never throws — shows a toast on failure and returns null.
async function apiSafe(path, options = {}) {
  try { return await api(path, options); }
  catch (ex) { toast(ex.message, 'error'); return null; }
}

// ===== Toast notifications (replaces blocking alert()) =====
function toast(message, type = 'info') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'no-print';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-show'));
  const life = type === 'error' ? 6000 : 3500;
  setTimeout(() => {
    el.classList.remove('toast-show');
    setTimeout(() => el.remove(), 300);
  }, life);
}

async function requireRole(roles) {
  try {
    const me = await api('/api/me');
    if (roles && !roles.includes(me.role)) {
      alert('You do not have access to this page.');
      window.location.href = '/';
      return null;
    }
    document.querySelectorAll('[data-who]').forEach(el => el.textContent = `${me.name} (${me.role})`);
    document.querySelectorAll('.topbar [data-who]').forEach(el => {
      const link = document.createElement('a');
      link.href = '/change-password.html';
      link.textContent = 'Change Password';
      link.style.color = '#fff';
      link.style.marginLeft = '10px';
      link.style.fontSize = '13px';
      link.style.textDecoration = 'underline';
      el.insertAdjacentElement('afterend', link);
    });
    return me;
  } catch {
    window.location.href = '/';
    return null;
  }
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  window.location.href = '/';
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== Hospital branding & print system =====
// Every station's printed output (registration, pharmacy, lab, IPD, certificates,
// etc.) goes through printDocument() below, which guarantees ONLY the passed-in
// document prints — never the underlying screen it was triggered from. This is
// what keeps financial receipts and diagnostic/certificate documents from ever
// bleeding into each other on paper.
const HOSPITAL = {
  name: 'AL NOOR SPECIALIST HOSPITAL',
  tagline: 'Quality Healthcare & Specialist Services',
  address: 'Karakoram Highway, Doraha, Battagram',
  phone: '0997310399',
  emergency: '0997310399'
};

// Full branding header — hospital name, tagline, and address/contact/emergency,
// used identically across every receipt, report, and certificate so the
// letterhead is the same wherever it's printed. `documentTitle` is the specific
// document name (e.g. "LABORATORY REPORT", "BIRTH CERTIFICATE").
function receiptHeaderHTML(documentTitle) {
  return `
    <div class="doc-header">
      <h1>${esc(HOSPITAL.name)}</h1>
      <p class="doc-tagline">${esc(HOSPITAL.tagline)}</p>
      <p class="doc-contact">${esc(HOSPITAL.address)} &nbsp;|&nbsp; Ph: ${esc(HOSPITAL.phone)} &nbsp;|&nbsp; Emergency: ${esc(HOSPITAL.emergency)}</p>
      ${documentTitle ? `<h2>${esc(documentTitle)}</h2>` : ''}
    </div>`;
}

// Plain footer for receipts — just the letterhead line, no signature needed for
// a cash receipt.
function docFooterHTML() {
  return `
    <div class="doc-footer">
      <p>${esc(HOSPITAL.name)} &nbsp;|&nbsp; ${esc(HOSPITAL.address)} &nbsp;|&nbsp; ${esc(HOSPITAL.phone)}</p>
    </div>`;
}

// Formal footer for official A4 documents (Lab/Radiology Reports, Birth/Death/
// Discharge Certificates): a signature block naming the authorizing role, a
// timestamp, and the same letterhead footer line. `signatoryRole` names who
// signs (e.g. "Lab In-charge / Pathologist", "Attending Physician").
function certificateFooterHTML(signatoryRole) {
  return `
    <div class="doc-signature-block">
      <div>Date & Time Issued: ${esc(new Date().toLocaleString())}</div>
      <div class="doc-signature-line">${esc(signatoryRole || 'Authorized Medical Officer')}<br>Signature: ______________________</div>
    </div>
    ${docFooterHTML()}`;
}

// Builds a standard financial receipt (Registration/Pharmacy/Lab payment/IPD, etc.)
// items: [{label, amount}], meta: [{label, value}] shown under the header (patient, date, etc.)
function buildReceiptHTML({ title, receiptNo, meta = [], items = [], total, footerNote }) {
  return `
    ${receiptHeaderHTML(title || 'RECEIPT')}
    <div class="doc-meta">
      ${receiptNo ? `<p><strong>Receipt #:</strong> ${esc(receiptNo)}</p>` : ''}
      ${meta.map(m => `<p><strong>${esc(m.label)}:</strong> ${esc(m.value)}</p>`).join('')}
    </div>
    <table class="doc-table">
      <tr><th>Description</th><th>Amount</th></tr>
      ${items.map(i => `<tr><td>${esc(i.label)}</td><td>Rs. ${Number(i.amount).toLocaleString()}</td></tr>`).join('')}
    </table>
    ${total != null ? `<p class="doc-total">Total: Rs. ${Number(total).toLocaleString()}</p>` : ''}
    ${footerNote ? `<p class="muted">${esc(footerNote)}</p>` : ''}
    ${docFooterHTML()}
  `;
}

// Builds a diagnostic laboratory report — deliberately separate from any receipt.
// Labels the order clearly as a Direct Walk-In Test when it wasn't doctor-referred.
function buildLabReportHTML({ patient, rowsHtml, orderSource }) {
  const now = new Date();
  return `
    ${receiptHeaderHTML('LABORATORY REPORT')}
    ${orderSource === 'walkin' ? '<p class="doc-walkin-label">DIRECT WALK-IN TEST</p>' : ''}
    <div class="doc-meta">
      <p><strong>Patient:</strong> ${esc(patient.name)}</p>
      <p><strong>Age / Gender:</strong> ${esc(patient.age || '—')} / ${esc(patient.gender || '—')}</p>
      <p><strong>MR Number:</strong> ${esc(patient.mr_number)}</p>
      <p><strong>Date & Time:</strong> ${now.toLocaleDateString()} ${now.toLocaleTimeString()}</p>
    </div>
    <table class="doc-table">
      <tr><th>Test / Parameter</th><th>Result</th><th>Reference Range</th><th>Flag</th></tr>
      ${rowsHtml}
    </table>
    ${certificateFooterHTML('Lab In-charge / Pathologist')}
  `;
}

// Small specimen/tube barcode label — printed the instant payment clears, so a
// phlebotomist can stick it on the tube before touching the specimen. Distinct
// from a receipt or the diagnostic report; never carries pricing information.
function buildSpecimenLabelHTML({ patient, specimenId, tests }) {
  return `
    <p class="label-hospital">${esc(HOSPITAL.name)}</p>
    <p class="label-patient">${esc(patient.name)}</p>
    <p class="label-meta">MRN: ${esc(patient.mr_number)} &nbsp; ${esc(patient.age || '—')}/${esc((patient.gender || '—').slice(0, 1))}</p>
    <div class="label-barcode">${renderCode39SVG(specimenId, { scale: 1.3, height: 32 })}</div>
    <p class="label-tests">${tests.map(esc).join(', ')}</p>
  `;
}

// ---- One-test-per-A4-page laboratory report (ISO 15189-aligned) ----
// `testGroups`: [{ testName, rows: [{ param, value, unit, range, flag }] }] —
// one entry per ordered test, each rendered on its own dedicated page so two
// different tests (e.g. CBC and Urine R/E) can never share printed paper.
// Every page repeats the full header/meta block and carries its own footer
// (technician + pathologist signature lines) and its own verification QR —
// a page photocopied or handed over alone is still a complete, verifiable
// document.
function buildLabReportPagesHTML({ patient, testGroups, orderSource, receiptNo, specimenId, orderedBy, enteredBy, verifiedBy, verifiedAt }) {
  const now = new Date();
  const verifyOrigin = (typeof window !== 'undefined' && window.location) ? window.location.origin : '';
  return testGroups.map(group => {
    const hasCritical = group.rows.some(r => r.flag === 'critical');
    // Verification QR: a compact, hospital-internal payload a staff member's
    // phone (on the same LAN) can scan to open /verify-report.html, which
    // re-confirms the whole receipt (all its tests, specimen ID, and current
    // status) against the live database — works fully offline within the
    // hospital, no internet dependency. Deliberately carries ONLY the receipt
    // number, not the specimen ID or test name — this encoder tops out around
    // 76 bytes (QR version 4), and a long test name (several of the new panel
    // tests have long display names) could otherwise overflow that budget on
    // some hospital LAN hostnames; the receipt alone is already enough for
    // /verify-report.html to look up and show everything.
    const verifyPayload = `${verifyOrigin}/verify-report.html?receipt=${encodeURIComponent(receiptNo || '')}`;
    let qrSvg = '';
    try { qrSvg = renderQRSVG(verifyPayload, { scale: 3, quiet: 2 }); }
    catch {
      // Extremely long hostname edge case — fall back to just the bare receipt
      // number so the report still carries a scannable/typeable code.
      try { qrSvg = renderQRSVG(receiptNo || '', { scale: 3, quiet: 2 }); } catch { qrSvg = ''; }
    }
    return `
    <div class="lab-report-page">
      ${receiptHeaderHTML('LABORATORY REPORT')}
      ${orderSource === 'walkin' ? '<p class="doc-walkin-label">DIRECT WALK-IN TEST</p>' : ''}
      <div class="doc-meta">
        <p><strong>Patient:</strong> ${esc(patient.name)} &nbsp; <strong>Age/Sex:</strong> ${esc(patient.age || '—')}/${esc(patient.gender || '—')}</p>
        <p><strong>MR / Lab ID:</strong> ${esc(patient.mr_number)} ${specimenId ? `&nbsp; <strong>Specimen ID:</strong> ${esc(specimenId)}` : ''}</p>
        <p><strong>Referral Doctor:</strong> ${esc(orderSource === 'walkin' ? 'Direct Walk-In (Self)' : (orderedBy || '—'))}</p>
        <p><strong>Date & Time:</strong> ${now.toLocaleDateString()} ${now.toLocaleTimeString()} ${receiptNo ? `&nbsp; <strong>Receipt #:</strong> ${esc(receiptNo)}` : ''}</p>
      </div>
      <h2 style="text-align:center; color:var(--navy-dark); margin:10px 0;">${esc(group.testName)}</h2>
      ${hasCritical ? '<div class="critical-banner">⚠ CRITICAL VALUE — REQUIRES IMMEDIATE CLINICAL ATTENTION</div>' : ''}
      <table class="doc-table">
        <tr><th>Test Name</th><th>Result</th><th>Reference Range</th><th>Units</th><th>Flag</th></tr>
        ${group.rows.map(r => `<tr>
          <td>${esc(r.param)}</td>
          <td>${esc(r.value)}</td>
          <td>${esc(r.range)}</td>
          <td>${esc(r.unit || '')}</td>
          <td>${r.flag ? `<span class="result-flag ${r.flag}">${r.flag.toUpperCase()}</span>` : ''}</td>
        </tr>`).join('')}
      </table>
      <div class="doc-report-footer">
        <div class="sig-block"><div class="sig-line">Technician Signature${enteredBy ? ` (${esc(enteredBy)})` : ''}</div></div>
        ${qrSvg ? `<div class="doc-report-qr">${qrSvg}<div class="qr-caption">Scan to verify</div></div>` : ''}
        <div class="sig-block"><div class="sig-line">Pathologist Signature${verifiedBy ? ` (${esc(verifiedBy)})` : ''}</div></div>
      </div>
      ${docFooterHTML()}
    </div>`;
  }).join('');
}

// Prints ONLY the given HTML — nothing else on the page, regardless of what's on screen.
// Prints ONLY the given HTML — nothing else on the page, regardless of what's on
// screen. `format` picks the physical paper size:
//   'thermal' (default) — 80mm receipt roll: registration, pharmacy, lab/radiology
//      payment receipts, IPD discharge charges, master receipt, quick counter sales.
//   'a4' — full-size document: Lab Test Reports, Radiology Reports, IPD Discharge
//      Summaries, Birth Certificates and other formal certificates.
// The @page size can't be scoped by a CSS class in standard CSS (page size is a
// print-context global, not an element property), so it's set by injecting a
// tiny <style> tag right before printing and removing it right after — this is
// the standard technique for per-document print page sizing.
function printDocument(html, format = 'thermal') {
  let area = document.getElementById('printArea');
  if (!area) {
    area = document.createElement('div');
    area.id = 'printArea';
    document.body.appendChild(area);
  }
  area.innerHTML = html;
  area.className = format === 'a4' ? 'doc-a4' : (format === 'label' ? 'doc-label' : 'doc-thermal');

  const pageStyle = document.createElement('style');
  pageStyle.id = 'dynamicPrintPageStyle';
  pageStyle.textContent = format === 'a4'
    ? '@page { size: 210mm 297mm; margin: 15mm; }'
    : format === 'label'
      ? '@page { size: 50mm 30mm; margin: 2mm; }'
      : '@page { size: 80mm auto; margin: 3mm; }';
  document.head.appendChild(pageStyle);

  document.body.classList.add('printing-only');
  window.print();
  setTimeout(() => {
    document.body.classList.remove('printing-only');
    area.innerHTML = '';
    pageStyle.remove();
  }, 300);
}

// Generic Google-style live autocomplete. Attaches a dropdown under `inputEl`.
// fetchFn(query) must return a Promise<Array<item>>. `labelFn(item)` renders each row's text.
// onSelect(item) fires when a row is chosen (click or Enter).
function attachAutocomplete(inputEl, fetchFn, onSelect, labelFn) {
  labelFn = labelFn || (item => item.name);
  const box = document.createElement('div');
  box.className = 'autocomplete-box';
  inputEl.parentNode.style.position = inputEl.parentNode.style.position || 'relative';
  inputEl.insertAdjacentElement('afterend', box);
  let items = [];
  let activeIndex = -1;
  let debounceTimer = null;

  function render() {
    if (!items.length) { box.style.display = 'none'; return; }
    box.innerHTML = items.map((it, i) =>
      `<div class="autocomplete-item${i === activeIndex ? ' active' : ''}" data-i="${i}">${esc(labelFn(it))}</div>`
    ).join('');
    box.style.display = 'block';
    box.querySelectorAll('.autocomplete-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(Number(el.dataset.i));
      });
    });
  }

  function choose(i) {
    const item = items[i];
    if (!item) return;
    inputEl.value = labelFn(item);
    box.style.display = 'none';
    items = [];
    onSelect(item);
  }

  inputEl.addEventListener('input', () => {
    const q = inputEl.value.trim();
    clearTimeout(debounceTimer);
    if (q.length < 1) { items = []; box.style.display = 'none'; return; }
    debounceTimer = setTimeout(async () => {
      try { items = await fetchFn(q); activeIndex = -1; render(); }
      catch { items = []; box.style.display = 'none'; }
    }, 120);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (box.style.display === 'none') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, items.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); render(); }
    else if (e.key === 'Enter' && activeIndex >= 0) { e.preventDefault(); choose(activeIndex); }
    else if (e.key === 'Escape') { box.style.display = 'none'; }
  });

  inputEl.addEventListener('blur', () => setTimeout(() => { box.style.display = 'none'; }, 150));
}

// ===== Barcode / QR encoders (zero-dependency, browser-safe) =====
// This clinic PC has no reliable internet access, so specimen labels and
// report verification codes can never depend on a CDN barcode library. Both
// encoders below are hand-written and were independently round-trip verified
// against OpenCV's QRCodeDetector and a libzbar ctypes binding during
// development — see the project notes for that verification. Only what's
// needed for this app is implemented: Code 39 (specimen labels) and QR byte
// mode at EC level L, versions 1-4 (~76 bytes max — plenty for a receipt
// number + specimen ID + verification URL).

// ---- Code 39 ----
const CODE39_PATTERNS = {
  '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000',
  '4': '000110001', '5': '100110000', '6': '001110000', '7': '000100101',
  '8': '100100100', '9': '001100100',
  'A': '100001001', 'B': '001001001', 'C': '101001000', 'D': '000011001',
  'E': '100011000', 'F': '001011000', 'G': '000001101', 'H': '100001100',
  'I': '001001100', 'J': '000011100', 'K': '100000011', 'L': '001000011',
  'M': '101000010', 'N': '000010011', 'O': '100010010', 'P': '001010010',
  'Q': '000000111', 'R': '100000110', 'S': '001000110', 'T': '000010110',
  'U': '110000001', 'V': '011000001', 'W': '111000000', 'X': '010010001',
  'Y': '110010000', 'Z': '011010000',
  '-': '010000101', '.': '110000100', ' ': '011000100',
  '$': '010101000', '/': '010100010', '+': '010001010', '%': '000101010',
  '*': '010010100',
};

function encodeCode39(text) {
  const upper = String(text).toUpperCase();
  for (const ch of upper) {
    if (!CODE39_PATTERNS[ch]) throw new Error(`Character not supported by Code 39: "${ch}"`);
  }
  const chars = ['*', ...upper.split(''), '*'];
  const elements = [];
  chars.forEach((ch, idx) => {
    const pattern = CODE39_PATTERNS[ch];
    for (let i = 0; i < 9; i++) elements.push({ black: i % 2 === 0, wide: pattern[i] === '1' });
    if (idx < chars.length - 1) elements.push({ black: false, wide: false });
  });
  return elements;
}

// Renders a Code 39 barcode as an inline SVG string (for embedding in a print
// document). `text` is shown underneath the bars for human verification.
function renderCode39SVG(text, { scale = 2, height = 45, quiet = 10 } = {}) {
  const elements = encodeCode39(text);
  const narrow = scale, wide = scale * 2.5;
  let x = quiet;
  let bars = '';
  for (const el of elements) {
    const w = el.wide ? wide : narrow;
    if (el.black) bars += `<rect x="${x}" y="0" width="${w}" height="${height}" fill="black"/>`;
    x += w;
  }
  const totalWidth = x + quiet;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height + 16}" viewBox="0 0 ${totalWidth} ${height + 16}">
    <rect width="${totalWidth}" height="${height + 16}" fill="white"/>
    ${bars}
    <text x="${totalWidth / 2}" y="${height + 12}" font-size="10" text-anchor="middle" font-family="monospace">${esc(text)}</text>
  </svg>`;
}

// ---- QR code (byte mode, EC level L, versions 1-4) ----
const QR_EXP = new Array(512);
const QR_LOG = new Array(256);
(function buildGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    QR_EXP[i] = x; QR_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) QR_EXP[i] = QR_EXP[i - 255];
})();
function qrGfMul(a, b) { return (a === 0 || b === 0) ? 0 : QR_EXP[QR_LOG[a] + QR_LOG[b]]; }
function qrRsGenPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const newPoly = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      newPoly[j] ^= poly[j];
      newPoly[j + 1] ^= qrGfMul(poly[j], QR_EXP[i]);
    }
    poly = newPoly;
  }
  return poly;
}
function qrRsEncode(dataCodewords, ecCount) {
  const gen = qrRsGenPoly(ecCount);
  const res = new Array(ecCount).fill(0);
  for (let i = 0; i < dataCodewords.length; i++) {
    const factor = dataCodewords[i] ^ res[0];
    res.shift(); res.push(0);
    if (factor !== 0) for (let j = 0; j < gen.length - 1; j++) res[j] ^= qrGfMul(gen[j + 1], factor);
  }
  return res;
}
const QR_VERSION_INFO = {
  1: { size: 21, ec: 7, data: 19, align: [] },
  2: { size: 25, ec: 10, data: 34, align: [6, 18] },
  3: { size: 29, ec: 15, data: 55, align: [6, 22] },
  4: { size: 33, ec: 20, data: 80, align: [6, 26] },
};
function qrPickVersion(byteLen) {
  for (const v of [1, 2, 3, 4]) {
    const info = QR_VERSION_INFO[v];
    const maxBytes = Math.floor((info.data * 8 - 12) / 8);
    if (byteLen <= maxBytes) return v;
  }
  throw new Error('Data too long for supported QR versions (max version 4, ~76 bytes)');
}
function qrBuildBitStream(text, version) {
  const info = QR_VERSION_INFO[version];
  const bytes = Array.from(new TextEncoder().encode(text));
  let bits = '0100';
  bits += bytes.length.toString(2).padStart(8, '0');
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  const totalDataBits = info.data * 8;
  bits += '0000';
  if (bits.length > totalDataBits) bits = bits.slice(0, totalDataBits);
  while (bits.length % 8 !== 0) bits += '0';
  const padBytes = ['11101100', '00010001'];
  let i = 0;
  while (bits.length < totalDataBits) { bits += padBytes[i % 2]; i++; }
  const dataCodewords = [];
  for (let j = 0; j < bits.length; j += 8) dataCodewords.push(parseInt(bits.slice(j, j + 8), 2));
  return dataCodewords;
}
function qrFormatInfoCoords(size) {
  const coordsA = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const coordsB = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];
  return { coordsA, coordsB };
}
function encodeQR(text) {
  const version = qrPickVersion(new TextEncoder().encode(text).length);
  const info = QR_VERSION_INFO[version];
  const dataCodewords = qrBuildBitStream(text, version);
  const ecCodewords = qrRsEncode(dataCodewords, info.ec);
  const allCodewords = dataCodewords.concat(ecCodewords);
  const size = info.size;
  const matrix = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c, val) => { matrix[r][c] = val; reserved[r][c] = true; };
  function placeFinder(r0, c0) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        let val = 0;
        if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) {
          const isBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const isCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          val = (isBorder || isCore) ? 1 : 0;
        }
        mark(r, c, val);
      }
    }
  }
  placeFinder(0, 0); placeFinder(0, size - 7); placeFinder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { mark(6, i, i % 2 === 0 ? 1 : 0); mark(i, 6, i % 2 === 0 ? 1 : 0); }
  if (info.align.length === 2) {
    for (const cr of info.align) {
      for (const cc of info.align) {
        if ((cr <= 8 && cc <= 8) || (cr <= 8 && cc >= size - 9) || (cr >= size - 9 && cc <= 8)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const isBorder = Math.max(Math.abs(dr), Math.abs(dc)) === 2;
            const isCenter = dr === 0 && dc === 0;
            mark(cr + dr, cc + dc, (isBorder || isCenter) ? 1 : 0);
          }
        }
      }
    }
  }
  const { coordsA, coordsB } = qrFormatInfoCoords(size);
  for (const [r, c] of coordsA) if (!reserved[r][c]) mark(r, c, 0);
  for (const [r, c] of coordsB) if (!reserved[r][c]) mark(r, c, 0);
  mark(4 * version + 9, 8, 1);
  const dataBits = [];
  for (const cw of allCodewords) for (let b = 7; b >= 0; b--) dataBits.push((cw >> b) & 1);
  let bitIndex = 0, dir = -1, col = size - 1;
  while (col > 0) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const row = dir === -1 ? size - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (!reserved[row][c]) { matrix[row][c] = bitIndex < dataBits.length ? dataBits[bitIndex] : 0; bitIndex++; }
      }
    }
    dir = -dir; col -= 2;
  }
  function maskFn(pattern, r, c) {
    switch (pattern) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  }
  function applyMask(pattern) {
    const m = matrix.map(row => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) { if (!reserved[r][c] && maskFn(pattern, r, c)) m[r][c] ^= 1; }
    return m;
  }
  function penalty(m) {
    let score = 0;
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) { if (m[r][c] === m[r][c - 1]) run++; else { if (run >= 5) score += 3 + (run - 5); run = 1; } }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) { if (m[r][c] === m[r - 1][c]) run++; else { if (run >= 5) score += 3 + (run - 5); run = 1; } }
      if (run >= 5) score += 3 + (run - 5);
    }
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return score;
  }
  let bestPattern = 0, bestScore = Infinity, bestMatrix = null;
  for (let p = 0; p < 8; p++) {
    const m = applyMask(p);
    const s = penalty(m);
    if (s < bestScore) { bestScore = s; bestPattern = p; bestMatrix = m; }
  }
  const ecLevelBits = 0b01;
  const data5 = (ecLevelBits << 3) | bestPattern;
  let rem = data5 << 10;
  const genPoly = 0b10100110111;
  for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= genPoly << (i - 10);
  const bch = (data5 << 10) | rem;
  const fmtBits = bch ^ 0b101010000010010;
  const fmtArr = [];
  for (let i = 14; i >= 0; i--) fmtArr.push((fmtBits >> i) & 1);
  for (let i = 0; i < 15; i++) {
    const [rA, cA] = coordsA[i]; const [rB, cB] = coordsB[i];
    bestMatrix[rA][cA] = fmtArr[i]; bestMatrix[rB][cB] = fmtArr[i];
  }
  return { size, matrix: bestMatrix };
}

// Renders a QR code as an inline SVG string for embedding in a print document.
function renderQRSVG(text, { scale = 4, quiet = 4 } = {}) {
  const { size, matrix } = encodeQR(text);
  const imgSize = (size + quiet * 2) * scale;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imgSize}" height="${imgSize}" viewBox="0 0 ${imgSize} ${imgSize}"><rect width="${imgSize}" height="${imgSize}" fill="white"/>`;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) svg += `<rect x="${(c + quiet) * scale}" y="${(r + quiet) * scale}" width="${scale}" height="${scale}" fill="black"/>`;
    }
  }
  svg += '</svg>';
  return svg;
}
