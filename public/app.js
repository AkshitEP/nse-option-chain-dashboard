'use strict';

// ── Config ─────────────────────────────────────────────────────────
const API_URL          = '/api/option-chain';
const REFRESH_INTERVAL = 45;
const SYMBOLS          = ['NIFTY', 'BANKNIFTY'];

// ── Shared state ────────────────────────────────────────────────────
let N             = 4;
let countdown     = REFRESH_INTERVAL;
let timerInterval = null;

// Per-symbol state
const symState = {
  NIFTY:     { data: null, atm: null, expiry: null, expiryDates: [] },
  BANKNIFTY: { data: null, atm: null, expiry: null, expiryDates: [] },
};

// Rolling LTP history for VWAP per strike+side
const ltpHistory = {};
const VWAP_WINDOW = 10;

// ── DOM helpers ─────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const prefix = sym => sym === 'NIFTY' ? 'nifty' : 'bnk';

// Shared controls
const els = {
  nDown:        $('n-down'),
  nUp:          $('n-up'),
  nValue:       $('n-value'),
  rowCountLabel:$('row-count-label'),
  timerCircle:  $('timer-circle'),
  timerText:    $('timer-text'),
  connStatus:   $('conn-status'),
  errorBanner:  $('error-banner'),
  errorMessage: $('error-message'),
  // Header panels
  niftySpot:   $('nifty-spot'),   niftyAtm:    $('nifty-atm'),
  niftyPcr:    $('nifty-pcr'),    niftyImb:    $('nifty-imb'),   niftyExpiry: $('nifty-expiry'),
  bnkSpot:     $('bnk-spot'),     bnkAtm:      $('bnk-atm'),
  bnkPcr:      $('bnk-pcr'),      bnkImb:      $('bnk-imb'),     bnkExpiry:   $('bnk-expiry'),
};

// ── Formatters ──────────────────────────────────────────────────────
const fmtNum  = n => (!n && n !== 0) || isNaN(n) ? '—'
  : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
  : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'K'
  : n.toFixed(0);
const fmtPct  = n => n == null || isNaN(n) ? '—' : (n > 0 ? '+' : '') + n.toFixed(2) + '%';
const fmtLTP  = n => (!n || isNaN(n) || n === 0) ? '—' : n.toFixed(2);
const fmtPCR  = n => n == null || isNaN(n) ? '—' : n.toFixed(2);
const fmtSpt  = n => n == null ? '—' : n.toLocaleString('en-IN',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function updateVwap(key, ltp) {
  if (!ltp || ltp <= 0) return null;
  if (!ltpHistory[key]) ltpHistory[key] = [];
  ltpHistory[key].push(ltp);
  if (ltpHistory[key].length > VWAP_WINDOW) ltpHistory[key].shift();
  return ltpHistory[key].reduce((a, b) => a + b, 0) / ltpHistory[key].length;
}

function heatLevel(val, max) {
  if (!max) return 0;
  const r = Math.abs(val) / max;
  return r > 0.85 ? 5 : r > 0.65 ? 4 : r > 0.45 ? 3 : r > 0.25 ? 2 : r > 0.08 ? 1 : 0;
}

const numClass = v => v > 0 ? 'num-pos' : v < 0 ? 'num-neg' : 'num-neu';

function findATM(rows, spot) {
  if (!spot || !rows.length) return rows[Math.floor(rows.length / 2)]?.strikePrice;
  return rows.reduce((best, r) =>
    Math.abs(r.strikePrice - spot) < Math.abs(best - spot) ? r.strikePrice : best
  , rows[0].strikePrice);
}

function computeMaxPain(rows) {
  let minPain = Infinity, result = null;
  rows.forEach(target => {
    let pain = 0;
    rows.forEach(r => {
      pain += Math.max(0, target.strikePrice - r.strikePrice) * (r.CE?.openInterest || 0);
      pain += Math.max(0, r.strikePrice - target.strikePrice) * (r.PE?.openInterest || 0);
    });
    if (pain < minPain) { minPain = pain; result = target.strikePrice; }
  });
  return result;
}

// ── Controls ────────────────────────────────────────────────────────
els.nDown.addEventListener('click', () => { N = Math.max(1, N - 1); els.nValue.textContent = N; updateRowLabel(); SYMBOLS.forEach(s => { if (symState[s].data) renderTable(s, symState[s].data); }); });
els.nUp.addEventListener('click',   () => { N = Math.min(20, N + 1); els.nValue.textContent = N; updateRowLabel(); SYMBOLS.forEach(s => { if (symState[s].data) renderTable(s, symState[s].data); }); });

function updateRowLabel() { els.rowCountLabel.textContent = `Rows = ${2 * N + 1}`; }
updateRowLabel();

// Per-symbol expiry selectors
SYMBOLS.forEach(sym => {
  const p = prefix(sym);
  const sel = $(`${p}-expiry-select`);
  if (sel) sel.addEventListener('change', () => {
    symState[sym].expiry = sel.value || null;
    if (symState[sym].data) renderTable(sym, symState[sym].data);
  });
});

// ── Header panel updater ─────────────────────────────────────────────
function updateSymbolPanel(symbol, data) {
  const records = data?.records || {};
  const rows    = records.data || data?.filtered?.data || [];
  if (!rows.length) return;

  const spot   = records.underlyingValue || rows.find(r => r.CE?.underlyingValue)?.CE?.underlyingValue || 0;
  const expiry = (records.expiryDates || [])[0] || '—';
  const atm    = findATM(rows, spot);

  const fRows   = rows.filter(r => {
    const d = r.expiryDates || r.CE?.expiryDate || r.PE?.expiryDate || '';
    return !expiry || d === expiry || d.includes(expiry);
  });
  const useRows = fRows.length ? fRows : rows;
  let totCOI = 0, totPOI = 0;
  useRows.forEach(r => { totCOI += r.CE?.openInterest || 0; totPOI += r.PE?.openInterest || 0; });
  const pcr    = totCOI > 0 ? totPOI / totCOI : 0;
  const imb    = (totCOI + totPOI) > 0 ? ((totPOI - totCOI) / (totPOI + totCOI) * 100) : 0;
  const imbStr = (imb >= 0 ? '+' : '') + imb.toFixed(1) + '%';

  const p = prefix(symbol);
  const setEl = (id, txt, color) => {
    const el = $(id);
    if (!el) return;
    el.textContent = txt;
    if (color) el.style.color = color;
  };

  setEl(`${p}-spot`,   fmtSpt(spot));
  setEl(`${p}-atm`,    atm ? atm.toLocaleString('en-IN') : '—');
  setEl(`${p}-pcr`,    fmtPCR(pcr), pcr > 1.2 ? 'var(--green)' : pcr < 0.8 ? 'var(--red)' : 'var(--text)');
  setEl(`${p}-imb`,    imbStr,      imb > 0 ? 'var(--green)' : 'var(--red)');
  setEl(`${p}-expiry`, expiry);
}

// ── Fetch both symbols ─────────────────────────────────────────────
async function fetchBoth() {
  const results = await Promise.allSettled(SYMBOLS.map(sym => fetchSymbol(sym)));
  const anyError = results.every(r => r.status === 'rejected');
  if (anyError) { setConn('error'); showError('Failed to fetch data for all symbols'); }
  resetTimer();
}

async function fetchSymbol(sym) {
  try {
    const res  = await fetch(`${API_URL}?symbol=${sym}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Server error');

    symState[sym].data = json.data;
    processData(sym, json.data);

    if (json.sample) {
      setConn('sample');
      showError(`Sample data for ${sym} — NSE connection initialising.`);
    } else if (json.stale) {
      setConn('connected');
      showError('Some data may be cached.');
    } else {
      setConn('connected');
      hideError();
    }
  } catch (err) {
    console.error(`[${sym}] fetch error:`, err.message);
    setConn('error');
  }
}

// ── Process ──────────────────────────────────────────────────────────
function processData(sym, data) {
  const records     = data.records || {};
  const rows        = records.data || data.filtered?.data || [];
  if (!rows.length) return;

  const spot        = records.underlyingValue || rows.find(r => r.CE?.underlyingValue)?.CE?.underlyingValue || 0;
  const expiryDates = records.expiryDates || [];
  const p           = prefix(sym);

  // Populate expiry dropdown (once per symbol)
  if (expiryDates.length > 1 && $(`${p}-expiry-select`)?.options.length === 0) {
    const sel = $(`${p}-expiry-select`);
    expiryDates.forEach(e => {
      const opt = document.createElement('option');
      opt.value = opt.textContent = e;
      sel.appendChild(opt);
    });
    $(`${p}-expiry-sel`).style.display = 'flex';
  }
  symState[sym].expiryDates = expiryDates;
  if (!symState[sym].expiry && expiryDates.length) symState[sym].expiry = expiryDates[0];

  const expiry = symState[sym].expiry || expiryDates[0];
  const fRows  = rows.filter(r => {
    const d = r.expiryDates || r.CE?.expiryDate || r.PE?.expiryDate || '';
    return !expiry || d === expiry || d.includes(expiry);
  });
  const useRows = fRows.length ? fRows : rows;
  symState[sym].atm = findATM(useRows, spot);

  $(`${p}-last-update`).textContent = new Date().toLocaleTimeString('en-IN',
    { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  updateSymbolPanel(sym, data);
  renderTable(sym, data);
}

// ── Render table ────────────────────────────────────────────────────
function renderTable(sym, data) {
  const records = data.records || {};
  let rows      = records.data || data.filtered?.data || [];
  const spot    = records.underlyingValue || 0;
  const expiry  = symState[sym].expiry || (records.expiryDates || [])[0];
  const p       = prefix(sym);

  const fRows   = rows.filter(r => {
    const d = r.expiryDates || r.CE?.expiryDate || r.PE?.expiryDate || '';
    return !expiry || d === expiry || d.includes(expiry);
  });
  const useRows = (fRows.length ? fRows : rows).sort((a, b) => a.strikePrice - b.strikePrice);
  const atm     = symState[sym].atm || findATM(useRows, spot);
  const atmIdx  = useRows.findIndex(r => r.strikePrice === atm);
  const lo      = Math.max(0, atmIdx - N);
  const hi      = Math.min(useRows.length - 1, atmIdx + N);
  const vis     = useRows.slice(lo, hi + 1);

  // Heat map maxima
  const maxCallOI  = Math.max(...vis.map(r => r.CE?.openInterest || 0));
  const maxPutOI   = Math.max(...vis.map(r => r.PE?.openInterest || 0));
  const maxCallCOI = Math.max(...vis.map(r => Math.abs(r.CE?.changeinOpenInterest || 0)));
  const maxPutCOI  = Math.max(...vis.map(r => Math.abs(r.PE?.changeinOpenInterest || 0)));

  // Totals
  let totCOI = 0, totPOI = 0, totCCOI = 0, totPCOI = 0;
  vis.forEach(r => {
    totCOI  += r.CE?.openInterest || 0;
    totPOI  += r.PE?.openInterest || 0;
    totCCOI += r.CE?.changeinOpenInterest || 0;
    totPCOI += r.PE?.changeinOpenInterest || 0;
  });
  const pcr  = totCOI > 0 ? totPOI / totCOI : 0;
  const imb  = (totCOI + totPOI) > 0 ? Math.abs(totPOI - totCOI) / (totPOI + totCOI) * 100 : 0;
  const mp   = computeMaxPain(useRows);

  // Update section title
  $(`${p}-table-title`).textContent =
    `${vis.length} strikes · ATM ${atm?.toLocaleString('en-IN')} · Spot ${fmtSpt(spot)}`;

  // Build rows
  let html = '';
  vis.forEach(r => {
    const sp    = r.strikePrice;
    const isATM = sp === atm;
    const ce = r.CE || {}, pe = r.PE || {};
    const cOI  = ce.openInterest || 0,           pOI  = pe.openInterest || 0;
    const cCOI = ce.changeinOpenInterest || 0,   pCOI = pe.changeinOpenInterest || 0;
    const cLTP = ce.lastPrice || 0,              pLTP = pe.lastPrice || 0;

    const cVWAP = updateVwap(`${sym}-${sp}-CE`, cLTP);
    const pVWAP = updateVwap(`${sym}-${sp}-PE`, pLTP);

    const pcrStrike = cOI > 0 ? pOI / cOI : null;
    const pcrClass  = pcrStrike == null ? 'num-neu'
                    : pcrStrike > 1.2   ? 'num-pos'
                    : pcrStrike < 0.8   ? 'num-neg' : 'num-neu';

    const cImb = pCOI !== 0 ? (cCOI - pCOI) / Math.abs(pCOI) * 100 : null;
    const pImb = cCOI !== 0 ? (pCOI - cCOI) / Math.abs(cCOI) * 100 : null;

    const hCOI  = heatLevel(cOI,  maxCallOI);
    const hPOI  = heatLevel(pOI,  maxPutOI);
    const hCCOI = heatLevel(cCOI, maxCallCOI);
    const hPCOI = heatLevel(pCOI, maxPutCOI);

    html += `<tr${isATM ? ' class="atm-row"' : ''}>
      <td class="call-side vwap-val">${cVWAP ? fmtLTP(cVWAP) : '—'}</td>
      <td class="call-side ltp-val">${fmtLTP(cLTP)}</td>
      <td class="call-side ${pcrClass}">${pcrStrike != null ? fmtPCR(pcrStrike) : '—'}</td>
      <td class="call-side heat-call-${hCOI}">${fmtNum(cOI)}</td>
      <td class="call-side ${cImb != null ? numClass(cImb) : 'num-neu'}">${cImb != null ? fmtPct(cImb) : '—'}</td>
      <td class="call-side heat-call-${hCCOI} ${numClass(cCOI)}">${fmtNum(cCOI)}</td>
      <td class="td-strike">${sp.toLocaleString('en-IN')}</td>
      <td class="put-side heat-put-${hPCOI} ${numClass(pCOI)}">${fmtNum(pCOI)}</td>
      <td class="put-side ${pImb != null ? numClass(pImb) : 'num-neu'}">${pImb != null ? fmtPct(pImb) : '—'}</td>
      <td class="put-side heat-put-${hPOI}">${fmtNum(pOI)}</td>
      <td class="put-side ${pcrClass}">${pcrStrike != null ? fmtPCR(pcrStrike) : '—'}</td>
      <td class="put-side ltp-val">${fmtLTP(pLTP)}</td>
      <td class="put-side vwap-val">${pVWAP ? fmtLTP(pVWAP) : '—'}</td>
    </tr>`;
  });
  $(`${p}-chain-body`).innerHTML = html;

  // Footer totals
  const setFoot = (id, val, color) => {
    const el = $(id); if (!el) return;
    el.textContent = fmtNum(val); el.style.color = color;
  };
  setFoot(`${p}-foot-call-coi`, totCCOI, totCCOI >= 0 ? 'var(--call)' : 'var(--red)');
  setFoot(`${p}-foot-call-oi`,  totCOI,  'var(--call)');
  setFoot(`${p}-foot-put-oi`,   totPOI,  'var(--put)');
  setFoot(`${p}-foot-put-coi`,  totPCOI, totPCOI >= 0 ? 'var(--put)' : 'var(--red)');

  // Stat bar
  const sentiment = pcr > 1.3 ? 'Bullish 🟢' : pcr < 0.7 ? 'Bearish 🔴'
                  : pcr > 1   ? 'Mild Bullish' : 'Mild Bearish';
  const setS = (id, val, color) => {
    const el = $(id); if (!el) return;
    el.textContent = val; if (color) el.style.color = color;
  };
  setS(`${p}-sb-coi`,  fmtNum(totCOI));
  setS(`${p}-sb-poi`,  fmtNum(totPOI));
  setS(`${p}-sb-pcr`,  fmtPCR(pcr), pcr > 1.2 ? 'var(--green)' : pcr < 0.8 ? 'var(--red)' : 'var(--text)');
  setS(`${p}-sb-ccoi`, fmtNum(totCCOI), totCCOI >= 0 ? 'var(--green)' : 'var(--red)');
  setS(`${p}-sb-pcoi`, fmtNum(totPCOI), totPCOI >= 0 ? 'var(--green)' : 'var(--red)');
  setS(`${p}-sb-imb`,  imb.toFixed(2) + '%');
  setS(`${p}-sb-sent`, sentiment, pcr > 1 ? 'var(--green)' : 'var(--red)');
  setS(`${p}-sb-mp`,   mp ? mp.toLocaleString('en-IN') : '—');
}

// ── Connection Status ────────────────────────────────────────────────
function setConn(s) {
  const labels = { connecting: 'Connecting', connected: 'Live', sample: 'Sample Data', error: 'Error' };
  els.connStatus.className = `conn-pill conn-${s}`;
  els.connStatus.querySelector('.conn-label').textContent = labels[s] || s;
}

// ── Error Banner ─────────────────────────────────────────────────────
function showError(msg, isHTML = false) {
  els.errorBanner.style.display = 'flex';
  if (isHTML) els.errorMessage.innerHTML = msg;
  else        els.errorMessage.textContent = msg;
}
function hideError() { els.errorBanner.style.display = 'none'; }

// ── Timer ────────────────────────────────────────────────────────────
function resetTimer()  { countdown = REFRESH_INTERVAL; updateTimerDisplay(); }
function updateTimerDisplay() {
  els.timerText.textContent = countdown;
  const C = 2 * Math.PI * 15;
  els.timerCircle.setAttribute('stroke-dashoffset', C - (countdown / REFRESH_INTERVAL) * C);
}
function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => { countdown--; updateTimerDisplay(); if (countdown <= 0) fetchBoth(); }, 1000);
}

// ── Theme Toggle ──────────────────────────────────────────────────────
const themeToggleBtn = $('theme-toggle');
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggleBtn.textContent = theme === 'light' ? '🌙' : '☀️';
  localStorage.setItem('nse-theme', theme);
}
applyTheme(localStorage.getItem('nse-theme') || 'light');
themeToggleBtn.addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

// ── Boot ─────────────────────────────────────────────────────────────
setConn('connecting');
fetchBoth();
startTimer();
