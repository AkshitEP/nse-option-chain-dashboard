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
const fmtNum  = n => (!n && n !== 0) || isNaN(n) ? '—'
  : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
  : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'K'
  : n.toFixed(0);
const fmtPct  = n => n == null || isNaN(n) ? '—' : (n > 0 ? '+' : '') + n.toFixed(2) + '%';
const fmtLTP  = n => (!n || isNaN(n) || n === 0) ? '—' : n.toFixed(2);
const fmtPCR  = n => n == null || isNaN(n) ? '—' : n.toFixed(2);
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
    el.textContent = fmtNum(val); el.style.color = color;
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
  setS(`${p}-sb-coi`,  fmtNum(totCOI));
  setS(`${p}-sb-poi`,  fmtNum(totPOI));
  const pcrSbEl = $(`${p}-sb-pcr`);
  const sbPhase = getPcrPhase(pcr);
  if (pcrSbEl) { pcrSbEl.textContent = fmtPCR(pcr); pcrSbEl.className = `sb-val ${sbPhase.cls}`; }
  setS(`${p}-sb-ccoi`, fmtNum(totCCOI), totCCOI >= 0 ? 'var(--green)' : 'var(--red)');
  setS(`${p}-sb-pcoi`, fmtNum(totPCOI), totPCOI >= 0 ? 'var(--green)' : 'var(--red)');
  setS(`${p}-sb-imb`,  imb.toFixed(2) + '%');
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
// ── MARKET OVERVIEW (Nifty 50 + Sectoral + Advance/Decline) ─────────
// ══════════════════════════════════════════════════════════════════════
(function initMarketOverview() {
  const N50 = [
    {n:"Reliance Industries",cmp:1336.40,pe:22.39,mcap:1808487.98,dy:0.41,np:20589,qpv:-12.55,sq:294059,qsv:12.50,roce:10.48},
    {n:"HDFC Bank",cmp:767.50,pe:15.54,mcap:1181607.38,dy:1.69,np:21074.22,qpv:8.05,sq:87182.50,qsv:0.46,roce:7.04},
    {n:"Bharti Airtel",cmp:1905.40,pe:40.43,mcap:1161012.62,dy:0.84,np:9247.40,qpv:-16.49,sq:55383.20,qsv:15.68,roce:18.50},
    {n:"ICICI Bank",cmp:1244.50,pe:16.46,mcap:892242,dy:0.88,np:15680.64,qpv:9.28,sq:49593.75,qsv:2.49,roce:7.20},
    {n:"State Bank of India",cmp:963.20,pe:10.96,mcap:889093.09,dy:1.80,np:20507.98,qpv:0.22,sq:131080.12,qsv:3.34,roce:6.09},
    {n:"TCS",cmp:2264,pe:15.65,mcap:819135.01,dy:2.83,np:13784,qpv:12.22,sq:70698,qsv:9.65,roce:63.03},
    {n:"Bajaj Finance",cmp:910.45,pe:29.51,mcap:566842.01,dy:0.59,np:5553.30,qpv:21.99,sq:21605.79,qsv:18.10,roce:10.82},
    {n:"Larsen & Toubro",cmp:3909,pe:31.33,mcap:537748.69,dy:0.97,np:6133.06,qpv:2.11,sq:82762.16,qsv:11.25,roce:14.96},
    {n:"Hind. Unilever",cmp:2272.20,pe:48.86,mcap:533874.13,dy:1.80,np:2994,qpv:8.62,sq:16351,qsv:7.64,roce:28.42},
    {n:"Infosys",cmp:1119,pe:15.09,mcap:453824.26,dy:4.29,np:8509,qpv:20.87,sq:46402,qsv:13.38,roce:39.95},
    {n:"Sun Pharma",cmp:1878.20,pe:37.13,mcap:450643.09,dy:0.85,np:3381.17,qpv:18.73,sq:15520.54,qsv:13.49,roce:20.21},
    {n:"Maruti Suzuki",cmp:13221,pe:28.32,mcap:415671.64,dy:1.02,np:3659,qpv:-6.45,sq:52462.50,qsv:28.21,roce:19.02},
    {n:"Adani Ports",cmp:1795.10,pe:31.86,mcap:413583.70,dy:0.42,np:3308.30,qpv:11.43,sq:10737.56,qsv:26.50,roce:14.14},
    {n:"M & M",cmp:3123.10,pe:21.96,mcap:388366.49,dy:0.81,np:5259.91,qpv:48.85,sq:54981.91,qsv:29.07,roce:15.45},
    {n:"ITC",cmp:309.45,pe:18.79,mcap:387724.39,dy:4.64,np:5018.45,qpv:9.62,sq:20047.30,qsv:6.69,roce:36.79},
    {n:"Axis Bank",cmp:1244.80,pe:14.67,mcap:387003.91,dy:0.08,np:7642.08,qpv:1.71,sq:34170.99,qsv:5.30,roce:6.24},
    {n:"Kotak Mah. Bank",cmp:387.05,pe:20.24,mcap:384977.93,dy:0.13,np:5423.15,qpv:4.53,sq:17827.36,qsv:6.29,roce:6.93},
    {n:"NTPC",cmp:395.25,pe:15.85,mcap:383260.73,dy:2.11,np:5597.05,qpv:8.42,sq:45845.68,qsv:1.72,roce:10.83},
    {n:"ONGC",cmp:299.35,pe:9.91,mcap:376590.66,dy:4.09,np:11946.42,qpv:16.36,sq:167422.93,qsv:0.13,roce:12.04},
    {n:"Titan Company",cmp:4169.10,pe:71.89,mcap:370126.93,dy:0.26,np:1179,qpv:31.00,sq:26920,qsv:80.48,roce:25.80},
    {n:"Adani Enterprises",cmp:2716,pe:111.31,mcap:353325.60,dy:0.05,np:-166.79,qpv:-121.16,sq:32439.31,qsv:20.30,roce:6.00},
    {n:"UltraTech Cement",cmp:11487,pe:40.93,mcap:338497.96,dy:0.67,np:3000.02,qpv:20.14,sq:25799.47,qsv:11.86,roce:12.78},
    {n:"JSW Steel",cmp:1278.80,pe:34.36,mcap:312724.65,dy:0.22,np:19243,qpv:115.02,sq:51180,qsv:14.19,roce:10.90},
    {n:"Bharat Electronics",cmp:423.65,pe:51.93,mcap:309678.78,dy:0.57,np:1579.70,qpv:20.45,sq:7153.85,qsv:23.97,roce:38.88},
    {n:"HCL Technologies",cmp:1132.60,pe:17.70,mcap:307349.71,dy:4.77,np:4490,qpv:4.20,sq:33981,qsv:12.35,roce:30.60},
    {n:"Bajaj Auto",cmp:10377.50,pe:26.92,mcap:290048.88,dy:1.45,np:3492.21,qpv:101.63,sq:17832.46,qsv:41.01,roce:28.21},
    {n:"Coal India",cmp:462.20,pe:9.16,mcap:284841.30,dy:5.73,np:10907.79,qpv:12.86,sq:46490.03,qsv:22.91,roce:35.34},
    {n:"Power Grid Corp",cmp:305.85,pe:17.86,mcap:284458.97,dy:2.94,np:4546.33,qpv:9.74,sq:11665.61,qsv:-4.97,roce:9.74},
    {n:"Bajaj Finserv",cmp:1728.10,pe:27.84,mcap:276591.04,dy:0.09,np:5226.26,qpv:5.05,sq:38493.79,qsv:5.19,roce:10.52},
    {n:"Nestle India",cmp:1430.50,pe:79.92,mcap:275845.36,dy:0.84,np:1114.11,qpv:28.84,sq:6747.79,qsv:22.60,roce:84.21},
    {n:"Tata Steel",cmp:216.84,pe:23.58,mcap:270692.80,dy:1.66,np:2965,qpv:116.55,sq:63270.13,qsv:12.54,roce:12.64},
    {n:"Asian Paints",cmp:2605.60,pe:61.25,mcap:249928.58,dy:0.95,np:1073.92,qpv:5.54,sq:8867.02,qsv:3.71,roce:25.72},
    {n:"Hindalco Industries",cmp:1067.50,pe:13.85,mcap:239891.43,dy:0.47,np:2049,qpv:-15.80,sq:66521,qsv:13.93,roce:14.80},
    {n:"Eternal",cmp:241.18,pe:635.92,mcap:232747.16,dy:0.00,np:174,qpv:346.15,sq:17292,qsv:196.45,roce:2.97},
    {n:"Shriram Finance",cmp:937.90,pe:22.01,mcap:220671.98,dy:1.15,np:3020.95,qpv:40.94,sq:12513.43,qsv:9.25,roce:11.47},
    {n:"Grasim Industries",cmp:2933.80,pe:43.29,mcap:199651.76,dy:0.34,np:2232.95,qpv:34.68,sq:44311.97,qsv:25.25,roce:7.50},
    {n:"Wipro",cmp:190,pe:15.11,mcap:199443.26,dy:5.79,np:3521.60,qpv:-1.90,sq:24236.30,qsv:7.70,roce:17.88},
    {n:"Eicher Motors",cmp:7014.50,pe:35.62,mcap:192417.70,dy:1.00,np:1420.61,qpv:25.12,sq:6114.04,qsv:22.94,roce:29.81},
    {n:"SBI Life Insurance",cmp:1864.50,pe:75.70,mcap:187012.48,dy:0.14,np:804.64,qpv:-1.09,sq:4071.03,qsv:-82.35,roce:14.95},
    {n:"InterGlobe Aviation",cmp:4314.90,pe:36.81,mcap:166838.20,dy:0.23,np:612.60,qpv:-21.69,sq:23471.90,qsv:6.16,roce:17.34},
    {n:"Jio Financial",cmp:233.06,pe:100.09,mcap:153892.82,dy:0.21,np:272.22,qpv:-13.88,sq:1018.51,qsv:106.49,roce:1.86},
    {n:"Trent",cmp:4101.30,pe:83.84,mcap:145796.07,dy:0.15,np:413.10,qpv:25.83,sq:5027.99,qsv:19.23,roce:27.80},
    {n:"Tech Mahindra",cmp:1370.50,pe:26.86,mcap:134302.72,dy:3.72,np:1356.40,qpv:16.04,sq:15076.10,qsv:12.64,roce:23.14},
    {n:"HDFC Life Insurance",cmp:608.70,pe:68.68,mcap:131346.48,dy:0.34,np:497.49,qpv:4.66,sq:19890.03,qsv:-17.78,roce:10.30},
    {n:"Tata Motors",cmp:356.55,pe:20.62,mcap:131297.24,dy:1.68,np:5878,qpv:-24.63,sq:105447,qsv:7.19,roce:2.73},
    {n:"Tata Consumer",cmp:1234,pe:78.41,mcap:122111.92,dy:0.81,np:424.02,qpv:34.33,sq:5433.62,qsv:17.91,roce:9.36},
    {n:"Apollo Hospitals",cmp:8082.50,pe:63.99,mcap:116213.95,dy:0.24,np:516.30,qpv:38.72,sq:6477.40,qsv:17.20,roce:16.64},
    {n:"Cipla",cmp:1432.10,pe:28.36,mcap:115685.12,dy:0.91,np:542.51,qpv:-54.61,sq:6541.20,qsv:-2.80,roce:16.61},
    {n:"Dr Reddy's Labs",cmp:1336.70,pe:26.59,mcap:111568.60,dy:0.60,np:221.30,qpv:-86.14,sq:7546.40,qsv:-11.51,roce:13.64},
    {n:"Max Healthcare",cmp:1050.10,pe:70.05,mcap:102200.33,dy:0.14,np:300.92,qpv:17.20,sq:2067.52,qsv:10.66,roce:14.88}
  ];

  const SECTORS = [
    {title:'🏆 Nifty Top 10 (by Market Cap)',names:N50.slice(0,10).map(s=>s.n)},
    {title:'💻 IT Index',names:["TCS","Infosys","HCL Technologies","Wipro","Tech Mahindra"]},
    {title:'💊 Pharma',names:["Sun Pharma","Cipla","Dr Reddy's Labs","Apollo Hospitals","Max Healthcare"]},
    {title:'🚗 Nifty Auto',names:["Maruti Suzuki","M & M","Bajaj Auto","Tata Motors","Eicher Motors"]},
    {title:'⛏️ Nifty Metal',names:["JSW Steel","Tata Steel","Hindalco Industries"]},
    {title:'🏢 Adani (Enterprise & Ports)',names:["Adani Enterprises","Adani Ports"]}
  ];

  const mf = v => v>=1000? v.toLocaleString('en-IN',{maximumFractionDigits:2}): v.toFixed(2);
  const mc = v => v>0?'mkt-pos':v<0?'mkt-neg':'';

  function sectorHTML(sec){
    const stocks = sec.names.map(n=>N50.find(s=>s.n===n)).filter(Boolean);
    return `<div class="mkt-sector-block"><h3 class="mkt-sub-title">${sec.title}</h3>
    <div class="mkt-table-scroll"><table class="mkt-table"><thead><tr>
    <th>#</th><th>Name</th><th>CMP (₹)</th><th>P/E</th><th>MCap (₹Cr)</th><th>Div Yld%</th><th>ROCE%</th><th>Qtr Profit Var%</th>
    </tr></thead><tbody>${stocks.map((s,i)=>`<tr>
    <td>${i+1}</td><td class="mkt-name-cell">${s.n}</td><td>${mf(s.cmp)}</td><td>${s.pe.toFixed(2)}</td>
    <td>${mf(s.mcap)}</td><td>${s.dy.toFixed(2)}</td><td>${s.roce.toFixed(2)}</td>
    <td class="${mc(s.qpv)}">${s.qpv>0?'+':''}${s.qpv.toFixed(2)}%</td></tr>`).join('')}</tbody></table></div></div>`;
  }

  // Render sectors
  const container = document.getElementById('mkt-sectors');
  if(container) container.innerHTML = SECTORS.map(sectorHTML).join('');

  // Render full table
  const ftb = document.querySelector('#nifty50-full-table tbody');
  if(ftb) ftb.innerHTML = N50.map((s,i)=>`<tr>
    <td>${i+1}</td><td class="mkt-name-cell">${s.n}</td><td>${mf(s.cmp)}</td><td>${s.pe.toFixed(2)}</td>
    <td>${mf(s.mcap)}</td><td>${s.dy.toFixed(2)}</td><td>${mf(s.np)}</td>
    <td class="${mc(s.qpv)}">${s.qpv>0?'+':''}${s.qpv.toFixed(2)}%</td>
    <td>${mf(s.sq)}</td><td class="${mc(s.qsv)}">${s.qsv>0?'+':''}${s.qsv.toFixed(2)}%</td>
    <td>${s.roce.toFixed(2)}</td></tr>`).join('');
})();
