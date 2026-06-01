'use strict';

// ── Config ─────────────────────────────────────────────────────────
const API_URL          = '/api/option-chain';
const REFRESH_INTERVAL = 30;
const SYMBOLS          = ['NIFTY', 'BANKNIFTY'];

// ── Shared state ────────────────────────────────────────────────────
let N             = 4;
let countdown     = REFRESH_INTERVAL;
let timerInterval = null;

// Per-symbol state
const symState = {
  NIFTY:     { data: null, atm: null, expiry: null, expiryDates: [], customStrike: null, N: 4 },
  BANKNIFTY: { data: null, atm: null, expiry: null, expiryDates: [], customStrike: null, N: 4 },
};

// Proper volume-weighted VWAP per strike+side
const vwapState  = {};   // key -> { hist:[{p,v}], prevVol:number }
const VWAP_WINDOW = 20;

// ── DOM helpers ─────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const prefix = sym => sym === 'NIFTY' ? 'nifty' : 'bnk';

// Shared UI els (header/timer only)
const els = {
  timerCircle:  $('timer-circle'),
  timerText:    $('timer-text'),
  connStatus:   $('conn-status'),
  errorBanner:  $('error-banner'),
  errorMessage: $('error-message'),
};

// ── Formatters ──────────────────────────────────────────────────────
// Full Indian-comma number (no K/M rounding) for stat bar & footer
const fmtFull = n => (!n && n !== 0) || isNaN(n) ? '—'
  : n.toLocaleString('en-IN');
// Compact number for table cells only
const fmtNum  = n => (!n && n !== 0) || isNaN(n) ? '—'
  : Math.abs(n) >= 1e7 ? (n / 1e7).toFixed(2) + 'Cr'
  : Math.abs(n) >= 1e5 ? (n / 1e5).toFixed(2) + 'L'
  : n.toLocaleString('en-IN');
const fmtPct  = n => n == null || isNaN(n) ? '—' : (n > 0 ? '+' : '') + n.toFixed(2) + '%';
const fmtLTP  = n => (!n || isNaN(n) || n === 0) ? '—' : n.toFixed(2);
const fmtPCR  = n => n == null || isNaN(n) ? '—' : n.toFixed(4);
const fmtSpt  = n => n == null ? '—' : n.toLocaleString('en-IN',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function updateVwap(key, ltp, totalVol) {
  if (!ltp || ltp <= 0) return null;
  if (!vwapState[key]) vwapState[key] = { hist: [], prevVol: 0 };
  const s = vwapState[key];
  // Delta volume since last poll; first poll: use totalVol itself
  const rawDelta = (totalVol || 0) - s.prevVol;
  const vol      = rawDelta > 0 ? rawDelta : (totalVol > 0 ? totalVol : 1);
  s.prevVol = totalVol || 0;
  s.hist.push({ p: ltp, v: vol });
  if (s.hist.length > VWAP_WINDOW) s.hist.shift();
  const sumPV = s.hist.reduce((a, b) => a + b.p * b.v, 0);
  const sumV  = s.hist.reduce((a, b) => a + b.v,       0);
  return sumV > 0 ? sumPV / sumV : null;
}

function heatLevel(val, max) {
  if (!max) return 0;
  const r = Math.abs(val) / max;
  return r > 0.85 ? 5 : r > 0.65 ? 4 : r > 0.45 ? 3 : r > 0.25 ? 2 : r > 0.08 ? 1 : 0;
}

const numClass = v => v > 0 ? 'num-pos' : v < 0 ? 'num-neg' : 'num-neu';

// Per-strike PCR → rgba background for strike cell
function getPcrBg(pcr) {
  if (pcr == null || isNaN(pcr)) return 'transparent';
  if (pcr > 2)    return 'rgba(21,128,61,.30)';
  if (pcr > 1.25) return 'rgba(34,197,94,.20)';
  if (pcr >= 0.75) return 'transparent';
  if (pcr >= 0.5) return 'rgba(239,68,68,.20)';
  return                 'rgba(153,27,27,.32)';
}

// ── PCR Phase ──────────────────────────────────────────────────
function getPcrPhase(pcr) {
  if (pcr == null || isNaN(pcr))
    return { label: '—',                 cls: '',                  icon: '➖', phase: 'unknown' };
  if (pcr > 2)
    return { label: 'Strongly Bullish',  cls: 'phase-strong-bull', icon: '🟢', phase: 'strong-bull' };
  if (pcr > 1.25)
    return { label: 'Bullish',           cls: 'phase-bull',        icon: '⬆️',  phase: 'bull' };
  if (pcr >= 0.75)
    return { label: 'Sideways',          cls: 'phase-sideways',    icon: '⇔',  phase: 'sideways' };
  if (pcr >= 0.5)
    return { label: 'Bearish',           cls: 'phase-bear',        icon: '⬇️',  phase: 'bear' };
  return   { label: 'Strongly Bearish',  cls: 'phase-strong-bear', icon: '🔴', phase: 'strong-bear' };
}

// ── Beep + Phase Toast ───────────────────────────────────────────
let audioCtx = null;
function beep(freq = 880, duration = 0.4) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.type = 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.start(); osc.stop(audioCtx.currentTime + duration);
  } catch (_) {}
}

const prevPhase = {};
function checkPhaseChange(sym, newPhase, pcr) {
  const prev = prevPhase[sym];
  if (prev && prev !== newPhase && newPhase !== 'unknown') {
    const p    = getPcrPhase(pcr);
    const prev_p = getPcrPhase(0); // dummy — we show phase names anyway
    // Beep pitch varies by bullishness
    beep(newPhase.includes('bull') ? 1047 : 440, 0.5);
    setTimeout(() => beep(newPhase.includes('bull') ? 1319 : 330, 0.3), 200);
    showPhaseToast(sym, prev, newPhase, p);
  }
  prevPhase[sym] = newPhase;
}

function showPhaseToast(sym, fromPhase, toPhase, p) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <span class="toast-icon">${p.icon}</span>
    <div class="toast-body">
      <span class="toast-sym">${sym} — PCR PHASE CHANGED</span>
      <span class="toast-msg ${p.cls}">${p.label}</span>
      <span class="toast-sub">${fromPhase.replace('-', ' ')} → ${toPhase.replace('-', ' ')}</span>
    </div>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

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

// Per-symbol expiry + strike + N steppers + Apply buttons
SYMBOLS.forEach(sym => {
  const p = prefix(sym);

  // Expiry
  const sel = $(`${p}-expiry-select`);
  if (sel) sel.addEventListener('change', () => {
    symState[sym].expiry = sel.value || null;
    if (symState[sym].data) renderTable(sym, symState[sym].data);
  });

  // N stepper (per symbol)
  const nDownBtn = $(`${p}-n-down`);
  const nUpBtn   = $(`${p}-n-up`);
  const nValEl   = $(`${p}-n-value`);
  function updateN(delta) {
    symState[sym].N = Math.min(20, Math.max(1, symState[sym].N + delta));
    if (nValEl) nValEl.textContent = symState[sym].N;
    if (symState[sym].data) renderTable(sym, symState[sym].data);
  }
  if (nDownBtn) nDownBtn.addEventListener('click', () => updateN(-1));
  if (nUpBtn)   nUpBtn.addEventListener('click',   () => updateN(+1));

  // Apply button — reads strike input and re-renders
  const applyBtn    = $(`${p}-apply-btn`);
  const strikeInput = $(`${p}-strike-input`);
  function applyStrike() {
    const v    = parseFloat(strikeInput?.value);
    const step = sym === 'BANKNIFTY' ? 100 : 50;
    symState[sym].customStrike = isNaN(v) ? null : Math.round(v / step) * step;
    if (symState[sym].data) renderTable(sym, symState[sym].data);
  }
  if (applyBtn)    applyBtn.addEventListener('click', applyStrike);
  if (strikeInput) strikeInput.addEventListener('keydown', e => { if (e.key === 'Enter') applyStrike(); });
  if (strikeInput) strikeInput.addEventListener('change', applyStrike);
});

// ── Header panel updater ─────────────────────────────────────────────
function updateSymbolPanel(symbol, data) {
  const records = data?.records || {};
  const rows    = records.data || data?.filtered?.data || [];
  if (!rows.length) return;

  const spot   = records.underlyingValue || rows.find(r => r.CE?.underlyingValue)?.CE?.underlyingValue || 0;
  // Use the user-selected expiry, falling back to the first available
  const expiry = symState[symbol].expiry || (records.expiryDates || [])[0] || '—';
  const atm    = findATM(rows, spot);

  // Filter rows to match the selected expiry (consistent with renderTable)
  const fRows   = rows.filter(r => {
    const d = r.expiryDates || r.CE?.expiryDate || r.PE?.expiryDate || '';
    return !expiry || d === expiry || d.includes(expiry);
  });
  const useRows = fRows.length ? fRows : rows;
  let totCOI = 0, totPOI = 0;
  useRows.forEach(r => { totCOI += r.CE?.openInterest || 0; totPOI += r.PE?.openInterest || 0; });
  const pcr    = totCOI > 0 ? totPOI / totCOI : 0;
  const imb    = (totCOI + totPOI) > 0 ? ((totPOI - totCOI) / (totPOI + totCOI) * 100) : 0;
  const imbStr = (imb >= 0 ? '+' : '') + imb.toFixed(2) + '%';
  const phase  = getPcrPhase(pcr);

  const pr = prefix(symbol);
  const setEl = (id, txt, color) => {
    const el = $(id); if (!el) return;
    el.textContent = txt;
    if (color !== undefined) el.style.color = color;
  };

  setEl(`${pr}-spot`,   fmtSpt(spot));
  setEl(`${pr}-atm`,    atm ? atm.toLocaleString('en-IN') : '—');
  // PCR with phase colour + label
  const pcrEl = $(`${pr}-pcr`);
  if (pcrEl) { pcrEl.textContent = `${fmtPCR(pcr)} ${phase.label}`; pcrEl.className = `ms-value ${phase.cls}`; }
  setEl(`${pr}-imb`,    imbStr, imb > 0 ? 'var(--green)' : 'var(--red)');
  setEl(`${pr}-expiry`, expiry);

  // Phase change detection
  checkPhaseChange(symbol, phase.phase, pcr);
}

async function fetchBoth() {
  let successCount = 0;
  let lastError = '';
  const results = await Promise.allSettled(SYMBOLS.map(sym => fetchSymbol(sym)));
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value === true) successCount++;
    else if (r.status === 'rejected') lastError = r.reason?.message || 'Unknown error';
    else if (r.value === false) lastError = 'fetch failed';
  });
  if (successCount === 0) {
    setConn('error');
    showError('Failed to fetch data for all symbols');
  } else if (successCount < SYMBOLS.length) {
    setConn('connected');
    showError(`Partial data — some symbols failed: ${lastError}`);
  }
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
      return false;
    } else if (json.stale) {
      setConn('connected');
    } else {
      setConn('connected');
      hideError();
    }
    return true;
  } catch (err) {
    console.error(`[${sym}] fetch error:`, err.message);
    return false;
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

  // Populate expiry dropdown (update every fetch to reflect latest data)
  if (expiryDates.length > 1) {
    const sel = $(`${p}-expiry-select`);
    const currentVal = sel.value;
    // Rebuild options only if the expiry list changed
    const existingOpts = Array.from(sel.options).map(o => o.value).join(',');
    const newOpts = expiryDates.join(',');
    if (existingOpts !== newOpts) {
      sel.innerHTML = '';
      expiryDates.forEach(e => {
        const opt = document.createElement('option');
        opt.value = opt.textContent = e;
        sel.appendChild(opt);
      });
      // Restore selection if it still exists
      if (currentVal && expiryDates.includes(currentVal)) {
        sel.value = currentVal;
      }
    }
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
  const useRows = (fRows.length ? fRows : rows).sort((a, b) => b.strikePrice - a.strikePrice);
  const atm     = symState[sym].customStrike || symState[sym].atm || findATM(useRows, spot);
  const atmIdx  = useRows.findIndex(r => r.strikePrice === atm);
  const symN    = symState[sym].N ?? 4;
  const lo      = Math.max(0, atmIdx - symN);
  const hi      = Math.min(useRows.length - 1, atmIdx + symN);
  const vis     = useRows.slice(lo, hi + 1);


  // Heat map maxima
  const maxCallOI  = Math.max(...vis.map(r => r.CE?.openInterest || 0));
  const maxPutOI   = Math.max(...vis.map(r => r.PE?.openInterest || 0));
  const maxCallCOI = Math.max(...vis.map(r => Math.abs(r.CE?.changeinOpenInterest || 0)));
  const maxPutCOI  = Math.max(...vis.map(r => Math.abs(r.PE?.changeinOpenInterest || 0)));

  // Totals — from visible rows (matching what user sees in the table)
  let totCOI = 0, totPOI = 0, totCCOI = 0, totPCOI = 0;
  vis.forEach(r => {
    totCOI  += r.CE?.openInterest || 0;
    totPOI  += r.PE?.openInterest || 0;
    totCCOI += r.CE?.changeinOpenInterest || 0;
    totPCOI += r.PE?.changeinOpenInterest || 0;
  });
  const pcr  = totCOI > 0 ? totPOI / totCOI : 0;
  const imb  = (totCOI + totPOI) > 0 ? ((totPOI - totCOI) / (totPOI + totCOI) * 100) : 0;
  const mp   = computeMaxPain(useRows);

  // Update section title
  $(`${p}-table-title`).textContent =
    `${vis.length} strikes · ATM ${atm?.toLocaleString('en-IN')} · Spot ${fmtSpt(spot)}`;

  // ── Support / Resistance (highest OI per side in visible rows) ──
  let maxCOI_sr = 0, maxPOI_sr = 0, resistStrike = null, supportStrike = null;
  vis.forEach(r => {
    const cOI = r.CE?.openInterest || 0, pOI = r.PE?.openInterest || 0;
    if (cOI > maxCOI_sr) { maxCOI_sr = cOI; resistStrike  = r.strikePrice; }
    if (pOI > maxPOI_sr) { maxPOI_sr = pOI; supportStrike = r.strikePrice; }
  });

  // Build rows
  let html = '';
  vis.forEach(r => {
    const sp    = r.strikePrice;
    const isATM = sp === atm;
    const ce = r.CE || {}, pe = r.PE || {};
    const cOI  = ce.openInterest || 0,           pOI  = pe.openInterest || 0;
    const cCOI = ce.changeinOpenInterest || 0,   pCOI = pe.changeinOpenInterest || 0;
    const cLTP = ce.lastPrice || 0,              pLTP = pe.lastPrice || 0;

    const cVol  = ce.totalTradedVolume || 0;
    const pVol  = pe.totalTradedVolume || 0;
    const cVWAP = updateVwap(`${sym}-${sp}-CE`, cLTP, cVol);
    const pVWAP = updateVwap(`${sym}-${sp}-PE`, pLTP, pVol);

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

    const srTag = sp === supportStrike
      ? ' <span class="sr-tag sup">SUP</span>'
      : sp === resistStrike
      ? ' <span class="sr-tag res">RES</span>'
      : '';

    html += `<tr${isATM ? ' class="atm-row"' : ''}>
      <td class="call-side vwap-val">${cVWAP ? fmtLTP(cVWAP) : '—'}</td>
      <td class="call-side ltp-val">${fmtLTP(cLTP)}</td>
      <td class="call-side pcr-cell ${pcrClass}">${pcrStrike != null ? fmtPCR(pcrStrike) : '—'}</td>
      <td class="call-side heat-call-${hCOI}">${fmtNum(cOI)}</td>
      <td class="call-side ${cImb != null ? numClass(cImb) : 'num-neu'}">${cImb != null ? fmtPct(cImb) : '—'}</td>
      <td class="call-side coi-cell heat-call-${hCCOI} ${numClass(cCOI)}">${fmtNum(cCOI)}</td>
      <td class="td-strike" style="background:${getPcrBg(pcrStrike)}">${sp.toLocaleString('en-IN')}${srTag}</td>
      <td class="put-side coi-cell heat-put-${hPCOI} ${numClass(pCOI)}">${fmtNum(pCOI)}</td>
      <td class="put-side ${pImb != null ? numClass(pImb) : 'num-neu'}">${pImb != null ? fmtPct(pImb) : '—'}</td>
      <td class="put-side heat-put-${hPOI}">${fmtNum(pOI)}</td>
      <td class="put-side pcr-cell ${pcrClass}">${pcrStrike != null ? fmtPCR(pcrStrike) : '—'}</td>
      <td class="put-side ltp-val">${fmtLTP(pLTP)}</td>
      <td class="put-side vwap-val">${pVWAP ? fmtLTP(pVWAP) : '—'}</td>
    </tr>`;
  });
  $(`${p}-chain-body`).innerHTML = html;

  // Footer totals
  const setFoot = (id, val, color) => {
    const el = $(id); if (!el) return;
    el.textContent = fmtFull(val); el.style.color = color;
  };
  setFoot(`${p}-foot-call-coi`, totCCOI, totCCOI >= 0 ? 'var(--call)' : 'var(--red)');
  setFoot(`${p}-foot-call-oi`,  totCOI,  'var(--call)');
  setFoot(`${p}-foot-put-oi`,   totPOI,  'var(--put)');
  setFoot(`${p}-foot-put-coi`,  totPCOI, totPCOI >= 0 ? 'var(--put)' : 'var(--red)');

  // Stat bar
  const setS = (id, val, color) => {
    const el = $(id); if (!el) return;
    el.textContent = val; if (color) el.style.color = color;
  };
  setS(`${p}-sb-coi`,  fmtFull(totCOI));
  setS(`${p}-sb-poi`,  fmtFull(totPOI));
  const pcrSbEl = $(`${p}-sb-pcr`);
  const sbPhase = getPcrPhase(pcr);
  if (pcrSbEl) { pcrSbEl.textContent = fmtPCR(pcr); pcrSbEl.className = `sb-val ${sbPhase.cls}`; }
  setS(`${p}-sb-ccoi`, fmtFull(totCCOI), totCCOI >= 0 ? 'var(--green)' : 'var(--red)');
  setS(`${p}-sb-pcoi`, fmtFull(totPCOI), totPCOI >= 0 ? 'var(--green)' : 'var(--red)');
  const imbSign = imb >= 0 ? '+' : '';
  setS(`${p}-sb-imb`,  imbSign + imb.toFixed(2) + '%', imb > 0 ? 'var(--green)' : imb < 0 ? 'var(--red)' : '');
  const sentEl = $(`${p}-sb-sent`);
  if (sentEl) { sentEl.textContent = `${sbPhase.icon} ${sbPhase.label}`; sentEl.className = `sb-val ${sbPhase.cls}`; }
  setS(`${p}-sb-mp`,   mp ? mp.toLocaleString('en-IN') : '—');

  // drawOIChart commented out
  // drawOIChart(sym, vis, pcr, atm, supportStrike, resistStrike);
}

// ── Phase → hex for canvas ───────────────────────────────────────────
const PHASE_HEX = {
  'strong-bull': '#15803d', 'bull': '#22c55e', 'sideways': '#94a3b8',
  'bear': '#f87171', 'strong-bear': '#dc2626', 'unknown': '#64748b',
};

// Horizontal bar with rounded cap on the open end
function roundedBarH(ctx, x, y, w, h, r, dir) {
  ctx.beginPath();
  if (dir === 'right') {
    ctx.moveTo(x, y); ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x, y + h);
  } else {
    ctx.moveTo(x + w, y); ctx.lineTo(x + r, y);
    ctx.quadraticCurveTo(x, y, x, y + r);
    ctx.lineTo(x, y + h - r);
    ctx.quadraticCurveTo(x, y + h, x + r, y + h);
    ctx.lineTo(x + w, y + h);
  }
  ctx.closePath();
}

function drawOIChart(sym, vis, pcr, atm, supportStrike, resistStrike) {
  const p      = prefix(sym);
  const canvas = document.getElementById(`${p}-oi-chart`);
  if (!canvas) return;

  const phase    = getPcrPhase(pcr);
  const barColor = PHASE_HEX[phase.phase] || '#94a3b8';
  const isDark   = document.documentElement.getAttribute('data-theme') !== 'light';

  // Bar data: lesser |COI| side per strike (top-to-bottom = ascending strikes)
  const bars = vis.map(r => {
    const cCOI = r.CE?.changeinOpenInterest || 0;
    const pCOI = r.PE?.changeinOpenInterest || 0;
    const useCall = Math.abs(cCOI) <= Math.abs(pCOI);
    return {
      strike: r.strikePrice,
      val:    useCall ? cCOI : pCOI,
      side:   useCall ? 'C' : 'P',
      isATM:  r.strikePrice === atm,
      isSup:  r.strikePrice === supportStrike,
      isRes:  r.strikePrice === resistStrike,
    };
  });

  // S/R labels
  const supEl = $(`${p}-chart-support`);
  const resEl = $(`${p}-chart-resist`);
  if (supEl) supEl.textContent = `▲ SUP ${supportStrike?.toLocaleString('en-IN') || '—'}`;
  if (resEl) resEl.textContent = `▼ RES ${resistStrike?.toLocaleString('en-IN') || '—'}`;

  // HiDPI canvas
  const dpr    = window.devicePixelRatio || 1;
  const ROW_H  = 22;   // px per strike row
  const W      = canvas.offsetWidth || 300;
  const H      = bars.length * ROW_H + 12;
  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const textColor = isDark ? '#9aa0b8' : '#475569';
  const gridColor = isDark ? '#2a2f40' : '#e2e8f0';

  const PAD    = { top: 6, bottom: 6, left: 46, right: 4 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top  - PAD.bottom;
  const rowH   = chartH / bars.length;
  const midX   = PAD.left + chartW / 2;
  const maxVal = Math.max(...bars.map(b => Math.abs(b.val)), 1);

  // Center vertical line
  ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(midX, PAD.top); ctx.lineTo(midX, H - PAD.bottom); ctx.stroke();

  bars.forEach((b, i) => {
    const y    = PAD.top + i * rowH;
    const cy   = y + rowH / 2;
    const bW   = (Math.abs(b.val) / maxVal) * (chartW / 2);
    const isPos = b.val >= 0;
    const barH  = Math.max(4, rowH * 0.55);
    const barY  = cy - barH / 2;
    const r     = Math.min(3, barH / 3);

    // Row background
    if (b.isATM)      { ctx.fillStyle = 'rgba(245,158,11,.08)'; ctx.fillRect(0, y, W, rowH); }
    else if (b.isSup) { ctx.fillStyle = 'rgba(34,197,94,.06)';  ctx.fillRect(0, y, W, rowH); }
    else if (b.isRes) { ctx.fillStyle = 'rgba(239,68,68,.06)';  ctx.fillRect(0, y, W, rowH); }

    // Bar
    if (bW > 0) {
      ctx.fillStyle = barColor;
      if (isPos) roundedBarH(ctx, midX,      barY, bW, barH, r, 'right');
      else        roundedBarH(ctx, midX - bW, barY, bW, barH, r, 'left');
      ctx.fill();

      // Side label inside bar
      if (bW > 14) {
        ctx.fillStyle = 'rgba(255,255,255,.85)';
        ctx.font = 'bold 7px Inter,sans-serif';
        ctx.textAlign   = isPos ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.side, isPos ? midX + 3 : midX - 3, cy);
      }
    } else {
      // zero tick
      ctx.fillStyle = gridColor; ctx.fillRect(midX - 1, barY, 2, barH);
    }

    // Strike label (left column)
    ctx.fillStyle    = b.isATM ? 'rgba(245,158,11,.9)' : b.isSup ? '#22c55e' : b.isRes ? '#ef4444' : textColor;
    ctx.font         = `${b.isATM || b.isSup || b.isRes ? 'bold ' : ''}8px Inter,sans-serif`;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(b.strike).slice(-5), PAD.left - 3, cy);
  });
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

// ══════════════════════════════════════════════════════════════════════
// ── SECTOR INDEX CARDS (Live daily % from NSE) ──────────────────────
// ══════════════════════════════════════════════════════════════════════
(function initSectorCards() {
  const container = document.getElementById('sector-cards');
  if (!container) return;

  const T10_COLORS = ['#6366f1','#8b5cf6','#a78bfa','#c084fc','#e879f9','#f472b6','#fb7185','#f87171','#fbbf24','#34d399'];

  function buildDonut(stocks) {
    const abs = stocks.map(s => Math.abs(s.pChange));
    const total = abs.reduce((a,b) => a+b, 0) || 1;
    const r = 54, cx = 64, cy = 64, circumference = 2 * Math.PI * r;
    let offset = 0;
    const segs = stocks.map((s, i) => {
      const pct = abs[i] / total;
      const dash = pct * circumference;
      const gap = circumference - dash;
      const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${T10_COLORS[i]}" stroke-width="12"
        stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"
        transform="rotate(-90 ${cx} ${cy})" opacity="0.85"/>`;
      offset += dash;
      return seg;
    }).join('');
    return `<svg viewBox="0 0 128 128" class="sc-donut">${segs}
      <text x="${cx}" y="${cy-4}" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="800" font-family="var(--font-mono)">TOP 10</text>
      <text x="${cx}" y="${cy+10}" text-anchor="middle" fill="var(--text3)" font-size="8" font-weight="600">Daily %</text>
    </svg>`;
  }

  function renderCards(sectors) {
    container.innerHTML = sectors.map(s => {
      const up = s.pChange >= 0;
      const cls = up ? 'sector-up' : 'sector-down';
      const arrow = up ? '▲' : '▼';
      const sign = up ? '+' : '';
      const fmt = v => typeof v === 'number' ? v.toLocaleString('en-IN', {maximumFractionDigits:2}) : '—';
      const isTop10 = s.top10 && s.top10.length > 0;
      const extraCls = isTop10 ? ' sector-card-top10' : '';
      let top10Html = '';
      if (isTop10) {
        const donut = buildDonut(s.top10);
        const rows = s.top10.map((st, i) => {
          const stUp = st.pChange >= 0;
          const stCls = stUp ? 'sc-t10-up' : 'sc-t10-down';
          const stSign = stUp ? '+' : '';
          return `<tr class="${stCls}">
            <td class="sc-t10-dot" style="color:${T10_COLORS[i]}">●</td>
            <td class="sc-t10-sym">${st.symbol}</td>
            <td class="sc-t10-chg">${stSign}${st.pChange.toFixed(2)}%</td>
          </tr>`;
        }).join('');
        top10Html = `<div class="sc-top10">
          <div class="sc-top10-layout">
            <div class="sc-donut-wrap">${donut}</div>
            <div class="sc-top10-list">
              <table class="sc-top10-table"><tbody>${rows}</tbody></table>
            </div>
          </div>
        </div>`;
      }
      return `<div class="sector-card ${cls}${extraCls}">
        <div class="sc-header">
          <span class="sc-emoji">${s.emoji}</span>
          <span class="sc-name">${s.label}</span>
        </div>
        <div class="sc-price">${fmt(s.last)}</div>
        <div class="sc-change">
          <span class="sc-arrow">${arrow}</span>
          <span class="sc-pct">${sign}${s.pChange.toFixed(2)}%</span>
          <span class="sc-abs">(${sign}${fmt(s.change)})</span>
        </div>
        <div class="sc-meta">
          <span>Open: ${fmt(s.open)}</span>
          <span>Prev: ${fmt(s.previousClose)}</span>
        </div>
        <div class="sc-range">
          <span class="sc-low">${fmt(s.dayLow)}</span>
          <div class="sc-range-bar">
            <div class="sc-range-fill" style="left:${rangePos(s.dayLow, s.dayHigh, s.last)}%"></div>
          </div>
          <span class="sc-high">${fmt(s.dayHigh)}</span>
        </div>
        ${top10Html}
      </div>`;
    }).join('');
  }

  function rangePos(low, high, val) {
    if (high === low) return 50;
    return Math.max(0, Math.min(100, ((val - low) / (high - low)) * 100));
  }

  async function fetchSectors() {
    try {
      const r = await fetch('/api/sector-indices');
      const json = await r.json();
      if (json.success && json.data && json.data.length > 0) {
        renderCards(json.data);
      } else {
        container.innerHTML = '<div class="sector-card sector-loading">⏳ Sector data unavailable — waiting for NSE session</div>';
      }
    } catch (e) {
      container.innerHTML = '<div class="sector-card sector-loading">⚠ Failed to fetch sector data</div>';
    }
  }

  // Fetch immediately, then every 60s
  fetchSectors();
  setInterval(fetchSectors, 60_000);
})();

// ══════════════════════════════════════════════════════════════════════
// ── LIVE ADVANCE / DECLINE (Market Breadth) ─────────────────────────
// ══════════════════════════════════════════════════════════════════════
(function initAdvDecline() {
  async function fetchAdvDec() {
    try {
      const r = await fetch('/api/advance-decline');
      const json = await r.json();
      if (!json.success || !json.data) return;
      const d = json.data;
      const total = d.advances + d.declines + d.unchanged;
      if (total === 0) return;

      const advPct  = ((d.advances / total) * 100).toFixed(1);
      const decPct  = ((d.declines / total) * 100).toFixed(1);
      const unchPct = ((d.unchanged / total) * 100).toFixed(1);

      // Update cards
      const advNum = document.querySelector('.ad-advance .ad-num');
      const decNum = document.querySelector('.ad-decline .ad-num');
      const unchNum = document.querySelector('.ad-unchanged .ad-num');
      if (advNum) advNum.textContent = d.advances.toLocaleString('en-IN');
      if (decNum) decNum.textContent = d.declines.toLocaleString('en-IN');
      if (unchNum) unchNum.textContent = d.unchanged.toLocaleString('en-IN');

      // Update breadth bar
      const advBar = document.querySelector('.bb-adv');
      const decBar = document.querySelector('.bb-dec');
      const unchBar = document.querySelector('.bb-unch');
      if (advBar) { advBar.style.width = advPct + '%'; advBar.querySelector('span').textContent = advPct + '%'; }
      if (decBar) { decBar.style.width = decPct + '%'; decBar.querySelector('span').textContent = decPct + '%'; }
      if (unchBar) { unchBar.style.width = unchPct + '%'; }

      // Update verdict
      const verdict = document.querySelector('.breadth-verdict');
      if (verdict) {
        if (d.advances > d.declines) {
          verdict.textContent = '✅ Bullish Breadth — Advances dominate';
          verdict.className = 'breadth-verdict bullish';
        } else if (d.declines > d.advances) {
          verdict.textContent = '⚠ Bearish Breadth — Declines dominate';
          verdict.className = 'breadth-verdict bearish';
        } else {
          verdict.textContent = '➖ Neutral Breadth — Evenly split';
          verdict.className = 'breadth-verdict neutral';
        }
      }

      // Update timestamp
      const tsEl = document.querySelector('.mkt-timestamp');
      if (tsEl) {
        tsEl.textContent = 'As on ' + new Date().toLocaleString('en-IN', {
          day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        }) + ' IST';
      }
    } catch (e) {
      console.error('[AdvDec] fetch error:', e.message);
    }
  }

  fetchAdvDec();
  setInterval(fetchAdvDec, 60_000);
})();
