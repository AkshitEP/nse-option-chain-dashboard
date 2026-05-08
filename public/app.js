'use strict';

// ── Config ─────────────────────────────────────────────────────────
const API_URL          = '/api/option-chain';
const REFRESH_INTERVAL = 45;   // seconds between polls

// ── State ──────────────────────────────────────────────────────────
let allData        = null;   // full option chain rows
let atmStrike      = null;
let expiryDates    = [];
let selectedExpiry = null;
let N              = 4;
let customStrike   = null;
let countdown      = REFRESH_INTERVAL;
let timerInterval  = null;

// ── DOM refs ────────────────────────────────────────────────────────
const els = {
  spotPrice:    document.getElementById('spot-price'),
  atmDisplay:   document.getElementById('atm-display'),
  pcrValue:     document.getElementById('pcr-value'),
  expiryLabel:  document.getElementById('expiry-label'),
  tableTitle:   document.getElementById('table-title'),
  lastUpdate:   document.getElementById('last-update'),
  chainBody:    document.getElementById('chain-body'),
  footCallCoi:  document.getElementById('foot-call-coi'),
  footCallOi:   document.getElementById('foot-call-oi'),
  footPutOi:    document.getElementById('foot-put-oi'),
  footPutCoi:   document.getElementById('foot-put-coi'),
  timerCircle:  document.getElementById('timer-circle'),
  timerText:    document.getElementById('timer-text'),
  connStatus:   document.getElementById('conn-status'),
  errorBanner:  document.getElementById('error-banner'),
  errorMessage: document.getElementById('error-message'),
  strikeInput:  document.getElementById('strike-input'),
  nValue:       document.getElementById('n-value'),
  nDown:        document.getElementById('n-down'),
  nUp:          document.getElementById('n-up'),
  applyBtn:     document.getElementById('apply-btn'),
  rowCountLabel:document.getElementById('row-count-label'),
  expirySel:    document.getElementById('expiry-selector'),
  expirySelect: document.getElementById('expiry-select'),
  // Stats
  stCallOi:     document.getElementById('st-call-oi'),
  stPutOi:      document.getElementById('st-put-oi'),
  stTotalOi:    document.getElementById('st-total-oi'),
  stCallCoi:    document.getElementById('st-call-coi'),
  stPutCoi:     document.getElementById('st-put-coi'),
  stPcr:        document.getElementById('st-pcr'),
  stPcrCoi:     document.getElementById('st-pcr-coi'),
  stImbalance:  document.getElementById('st-imbalance'),
  stSentiment:  document.getElementById('st-sentiment'),
  stMaxpain:    document.getElementById('st-maxpain'),
  stItmCallOi:  document.getElementById('st-itm-call-oi'),
  stItmPutOi:   document.getElementById('st-itm-put-oi'),
  stItmCallCoi: document.getElementById('st-itm-call-coi'),
  stItmPutCoi:  document.getElementById('st-itm-put-coi'),
  stItmPcr:     document.getElementById('st-itm-pcr'),
  stOtmCallOi:  document.getElementById('st-otm-call-oi'),
  stOtmPutOi:   document.getElementById('st-otm-put-oi'),
  stOtmCallCoi: document.getElementById('st-otm-call-coi'),
  stOtmPutCoi:  document.getElementById('st-otm-put-coi'),
  stOtmPcr:     document.getElementById('st-otm-pcr'),
};

// ── Formatters ──────────────────────────────────────────────────────
const fmtNum  = n => n == null || isNaN(n) ? '—' : Math.abs(n) >= 1e6
  ? (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3
  ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0);
const fmtPct  = n => n == null || isNaN(n) ? '—' : (n > 0 ? '+' : '') + n.toFixed(2) + '%';
const fmtLTP  = n => n == null || isNaN(n) || n === 0 ? '—' : n.toFixed(2);
const fmtPCR  = n => n == null || isNaN(n) ? '—' : n.toFixed(2);
const fmtSpt  = n => n == null ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function oiChgPct(coi, oi) {
  const prevOI = oi - coi;
  if (prevOI <= 0) return null;
  return (coi / prevOI) * 100;
}

function heatLevel(val, max) {
  if (!max || max === 0) return 0;
  const ratio = Math.abs(val) / max;
  if (ratio > 0.85) return 5;
  if (ratio > 0.65) return 4;
  if (ratio > 0.45) return 3;
  if (ratio > 0.25) return 2;
  if (ratio > 0.08) return 1;
  return 0;
}

function trend(coi) {
  if (coi > 0)  return '<span class="trend-bull">Bullish</span>';
  if (coi < 0)  return '<span class="trend-bear">Bearish</span>';
  return '<span class="trend-neut">—</span>';
}

function numClass(val) {
  if (val > 0) return 'num-pos';
  if (val < 0) return 'num-neg';
  return 'num-neu';
}

// ── Controls ────────────────────────────────────────────────────────
els.nDown.addEventListener('click', () => { N = Math.max(1, N - 1); els.nValue.textContent = N; updateRowLabel(); });
els.nUp.addEventListener('click',   () => { N = Math.min(20, N + 1); els.nValue.textContent = N; updateRowLabel(); });
els.applyBtn.addEventListener('click', () => {
  const v = parseFloat(els.strikeInput.value);
  customStrike = isNaN(v) ? null : Math.round(v / 50) * 50;
  selectedExpiry = els.expirySelect.value || null;
  if (allData) renderTable(allData);
});
els.expirySelect.addEventListener('change', () => {
  selectedExpiry = els.expirySelect.value || null;
  if (allData) renderTable(allData);
});
function updateRowLabel() {
  els.rowCountLabel.textContent = `Total rows = 2×${N}+1 = ${2 * N + 1}`;
}
updateRowLabel();

// ── Fetch & Process ─────────────────────────────────────────────────
async function fetchData() {
  try {
    setConn('connecting');
    const res  = await fetch(API_URL);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Server error');

    processData(json.data);

    if (json.needsAuth && json.loginUrl) {
      setConn('sample');
      showError(`Live data requires Fyers login. <a href="${json.loginUrl}" style="color:#a855f7;font-weight:600">Login with Fyers →</a>`, true);
    } else if (json.sample) {
      setConn('sample');
      showError(json.error || 'Showing sample data — live feed unavailable.');
    } else if (json.stale) {
      setConn('connected');
      showError('Using cached data — live refresh temporarily unavailable.');
    } else {
      setConn('connected');
      hideError();
    }
  } catch (err) {
    console.error(err);
    setConn('error');
    showError(err.message || 'Failed to fetch data');
  }
  resetTimer();
}

// ── Process NSE / Fyers data ────────────────────────────────────────
function processData(data) {
  const records = data.records || {};
  let rows = records.data || data.filtered?.data || [];
  if (!rows.length) return;

  const spot = records.underlyingValue || rows.find(r => r.CE?.underlyingValue)?.CE?.underlyingValue || 0;
  expiryDates = records.expiryDates || [];

  // Populate expiry dropdown
  if (expiryDates.length > 1 && els.expirySelect.options.length === 0) {
    expiryDates.forEach(e => {
      const opt = document.createElement('option');
      opt.value = opt.textContent = e;
      els.expirySelect.appendChild(opt);
    });
    els.expirySel.style.display = 'flex';
  }
  if (!selectedExpiry && expiryDates.length) selectedExpiry = expiryDates[0];

  // Filter by expiry
  const expiry = selectedExpiry || expiryDates[0];
  const filtered = rows.filter(r => {
    const d = r.expiryDates || r.CE?.expiryDate || r.PE?.expiryDate || '';
    return !expiry || d === expiry || d.includes(expiry);
  });
  const useRows = filtered.length ? filtered : rows;

  // ATM strike
  const atm = customStrike || findATM(useRows, spot);
  atmStrike = atm;

  // Update header
  els.spotPrice.textContent = fmtSpt(spot);
  els.atmDisplay.textContent = atm ? atm.toLocaleString('en-IN') : '—';
  els.expiryLabel.textContent = expiry || '—';
  els.lastUpdate.textContent = new Date().toLocaleTimeString('en-IN', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  allData = data;
  renderTable(data);
}

function findATM(rows, spot) {
  if (!spot) return rows[Math.floor(rows.length / 2)]?.strikePrice;
  return rows.reduce((best, r) => {
    const sp = r.strikePrice;
    return Math.abs(sp - spot) < Math.abs(best - spot) ? sp : best;
  }, rows[0]?.strikePrice);
}

// ── Render Table ────────────────────────────────────────────────────
function renderTable(data) {
  const records = data.records || {};
  let rows = records.data || data.filtered?.data || [];
  const spot = records.underlyingValue || 0;
  const expiry = selectedExpiry || expiryDates[0];

  const filtered = rows.filter(r => {
    const d = r.expiryDates || r.CE?.expiryDate || r.PE?.expiryDate || '';
    return !expiry || d === expiry || d.includes(expiry);
  });
  const useRows = filtered.length ? filtered : rows;
  useRows.sort((a, b) => a.strikePrice - b.strikePrice);

  const atm = customStrike || atmStrike || findATM(useRows, spot);
  const atmIdx = useRows.findIndex(r => r.strikePrice === atm);
  const lo  = Math.max(0, atmIdx - N);
  const hi  = Math.min(useRows.length - 1, atmIdx + N);
  const vis = useRows.slice(lo, hi + 1);

  // ── Heat map maximums ──────────────────────────────────────────
  const maxCallOI  = Math.max(...vis.map(r => Math.abs(r.CE?.openInterest || 0)));
  const maxPutOI   = Math.max(...vis.map(r => Math.abs(r.PE?.openInterest || 0)));
  const maxCallCOI = Math.max(...vis.map(r => Math.abs(r.CE?.changeinOpenInterest || 0)));
  const maxPutCOI  = Math.max(...vis.map(r => Math.abs(r.PE?.changeinOpenInterest || 0)));

  // ── Max Pain (strike with min total pain) ──────────────────────
  const maxPain = computeMaxPain(useRows);

  // ── Stats accumulators ─────────────────────────────────────────
  let totCallOI = 0, totPutOI = 0, totCallCOI = 0, totPutCOI = 0;
  let itmCOI = 0, itmPOI = 0, itmCCOI = 0, itmPCOI = 0;
  let otmCOI = 0, otmPOI = 0, otmCCOI = 0, otmPCOI = 0;

  vis.forEach(r => {
    const sp = r.strikePrice;
    const cOI  = r.CE?.openInterest || 0;
    const pOI  = r.PE?.openInterest || 0;
    const cCOI = r.CE?.changeinOpenInterest || 0;
    const pCOI = r.PE?.changeinOpenInterest || 0;
    totCallOI += cOI; totPutOI += pOI;
    totCallCOI += cCOI; totPutCOI += pCOI;
    if (sp < atm) { // ITM calls, OTM puts
      itmCOI += cOI; itmCCOI += cCOI; otmPOI += pOI; otmPCOI += pCOI;
    } else if (sp > atm) { // OTM calls, ITM puts
      otmCOI += cOI; otmCCOI += cCOI; itmPOI += pOI; itmPCOI += pCOI;
    }
  });

  const pcr    = totCallOI  > 0 ? totPutOI  / totCallOI  : 0;
  const pcrCOI = totCallCOI > 0 ? totPutCOI / totCallCOI : 0;
  const imb    = (totCallOI + totPutOI) > 0 ? Math.abs(totPutOI - totCallOI) / (totPutOI + totCallOI) * 100 : 0;

  // Update header PCR
  const pcrEl = els.pcrValue;
  pcrEl.textContent = fmtPCR(pcr);
  pcrEl.style.color = pcr > 1.2 ? 'var(--green)' : pcr < 0.8 ? 'var(--red)' : 'var(--text)';

  // ── Table title ────────────────────────────────────────────────
  const actualN = Math.min(atmIdx - lo, hi - atmIdx);
  els.tableTitle.textContent = `Option Chain — ${vis.length} Strikes Around ATM (${atm?.toLocaleString('en-IN')})`;

  // ── Build rows ─────────────────────────────────────────────────
  let html = '';
  vis.forEach(r => {
    const sp    = r.strikePrice;
    const isATM = sp === atm;
    const ce    = r.CE || {};
    const pe    = r.PE || {};

    const cOI   = ce.openInterest || 0;
    const pOI   = pe.openInterest || 0;
    const cCOI  = ce.changeinOpenInterest || 0;
    const pCOI  = pe.changeinOpenInterest || 0;
    const cLTP  = ce.lastPrice || 0;
    const pLTP  = pe.lastPrice || 0;

    // OI Chg%
    const cOIP  = oiChgPct(cCOI, cOI);
    const pOIP  = oiChgPct(pCOI, pOI);

    // Imbalance
    const cImb  = pCOI !== 0 ? (cCOI - pCOI) / Math.abs(pCOI) * 100 : null;
    const pImb  = cCOI !== 0 ? (pCOI - cCOI) / Math.abs(cCOI) * 100 : null;

    // Heat levels
    const hCOI  = heatLevel(cOI,  maxCallOI);
    const hPOI  = heatLevel(pOI,  maxPutOI);
    const hCCOI = heatLevel(cCOI, maxCallCOI);
    const hPCOI = heatLevel(pCOI, maxPutCOI);

    const rowClass = isATM ? ' class="atm-row"' : '';

    html += `<tr${rowClass}>
      <td class="call-side">${trend(cCOI)}</td>
      <td class="call-side ${numClass(cOIP)}">${cOIP != null ? fmtPct(cOIP) : '—'}</td>
      <td class="call-side heat-call-${hCCOI} ${numClass(cCOI)}">${fmtNum(cCOI)}</td>
      <td class="call-side heat-call-${hCOI}">${fmtNum(cOI)}</td>
      <td class="call-side ltp-val">${fmtLTP(cLTP)}</td>
      <td class="call-side ${cImb != null ? (cImb > 0 ? 'imb-pos' : 'imb-neg') : 'num-neu'}">${cImb != null ? fmtPct(cImb) : '—'}</td>
      <td class="td-strike">${sp.toLocaleString('en-IN')}</td>
      <td class="put-side ${pImb != null ? (pImb > 0 ? 'imb-pos' : 'imb-neg') : 'num-neu'}">${pImb != null ? fmtPct(pImb) : '—'}</td>
      <td class="put-side ltp-val">${fmtLTP(pLTP)}</td>
      <td class="put-side heat-put-${hPOI}">${fmtNum(pOI)}</td>
      <td class="put-side heat-put-${hPCOI} ${numClass(pCOI)}">${fmtNum(pCOI)}</td>
      <td class="put-side ${numClass(pOIP)}">${pOIP != null ? fmtPct(pOIP) : '—'}</td>
      <td class="put-side">${trend(pCOI)}</td>
    </tr>`;
  });
  els.chainBody.innerHTML = html;

  // ── Footer totals ──────────────────────────────────────────────
  const setFoot = (el, val, cls) => { el.textContent = fmtNum(val); el.className = `foot-val ${cls}`; el.style.color = val >= 0 ? 'var(--call)' : 'var(--red)'; };
  setFoot(els.footCallCoi, totCallCOI, 'call-side');
  setFoot(els.footCallOi,  totCallOI,  'call-side');
  setFoot(els.footPutOi,   totPutOI,   'put-side');
  setFoot(els.footPutCoi,  totPutCOI,  'put-side');

  // ── Stats panels ───────────────────────────────────────────────
  const setS = (el, val, cls) => { el.textContent = val; if (cls) el.className = `sp-val ${cls}`; };
  setS(els.stCallOi,  fmtNum(totCallOI));
  setS(els.stPutOi,   fmtNum(totPutOI));
  setS(els.stTotalOi, fmtNum(totCallOI + totPutOI));
  setS(els.stCallCoi, fmtNum(totCallCOI), totCallCOI >= 0 ? 'green' : 'red');
  setS(els.stPutCoi,  fmtNum(totPutCOI),  totPutCOI  >= 0 ? 'green' : 'red');
  setS(els.stPcr,      fmtPCR(pcr),    pcr > 1.2 ? 'green' : pcr < 0.8 ? 'red' : '');
  setS(els.stPcrCoi,   fmtPCR(Math.abs(pcrCOI)));
  setS(els.stImbalance, imb.toFixed(2) + '%');
  const sentiment = pcr > 1.3 ? 'Bullish 🟢' : pcr < 0.7 ? 'Bearish 🔴' : pcr > 1 ? 'Mildly Bullish' : 'Mildly Bearish';
  setS(els.stSentiment, sentiment, pcr > 1 ? 'green' : 'red');
  setS(els.stMaxpain, maxPain ? maxPain.toLocaleString('en-IN') : '—');

  // ITM / OTM
  setS(els.stItmCallOi,  fmtNum(itmCOI));
  setS(els.stItmPutOi,   fmtNum(itmPOI));
  setS(els.stItmCallCoi, fmtNum(itmCCOI), itmCCOI >= 0 ? 'green' : 'red');
  setS(els.stItmPutCoi,  fmtNum(itmPCOI), itmPCOI >= 0 ? 'green' : 'red');
  setS(els.stItmPcr,     itmCOI > 0 ? fmtPCR(itmPOI / itmCOI) : '—');

  setS(els.stOtmCallOi,  fmtNum(otmCOI));
  setS(els.stOtmPutOi,   fmtNum(otmPOI));
  setS(els.stOtmCallCoi, fmtNum(otmCCOI), otmCCOI >= 0 ? 'green' : 'red');
  setS(els.stOtmPutCoi,  fmtNum(otmPCOI), otmPCOI >= 0 ? 'green' : 'red');
  setS(els.stOtmPcr,     otmCOI > 0 ? fmtPCR(otmPOI / otmCOI) : '—');
}

// ── Max Pain ────────────────────────────────────────────────────────
function computeMaxPain(rows) {
  let minPain = Infinity, maxPainStrike = null;
  rows.forEach(target => {
    const sp = target.strikePrice;
    let pain = 0;
    rows.forEach(r => {
      // Calls: pain to sellers = max(0, sp - strike) * OI
      pain += Math.max(0, sp - r.strikePrice) * (r.CE?.openInterest || 0);
      // Puts: pain to sellers = max(0, strike - sp) * OI
      pain += Math.max(0, r.strikePrice - sp) * (r.PE?.openInterest || 0);
    });
    if (pain < minPain) { minPain = pain; maxPainStrike = sp; }
  });
  return maxPainStrike;
}

// ── Connection Status ────────────────────────────────────────────────
function setConn(status) {
  const labels = { connecting: 'Connecting', connected: 'Live', sample: 'Sample Data', error: 'Error' };
  els.connStatus.className = `conn-pill conn-${status}`;
  els.connStatus.querySelector('.conn-label').textContent = labels[status] || status;
}

// ── Error Banner ─────────────────────────────────────────────────────
function showError(msg, isHTML = false) {
  els.errorBanner.style.display = 'flex';
  if (isHTML) els.errorMessage.innerHTML = msg;
  else        els.errorMessage.textContent = msg;
}
function hideError() { els.errorBanner.style.display = 'none'; }

// ── Countdown Timer ──────────────────────────────────────────────────
function resetTimer() {
  countdown = REFRESH_INTERVAL;
  updateTimerDisplay();
}
function updateTimerDisplay() {
  els.timerText.textContent = countdown;
  const C = 2 * Math.PI * 15;  // circumference for r=15
  els.timerCircle.setAttribute('stroke-dashoffset', C - (countdown / REFRESH_INTERVAL) * C);
}
function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    countdown--;
    updateTimerDisplay();
    if (countdown <= 0) fetchData();
  }, 1000);
}

// ── Boot ─────────────────────────────────────────────────────────────
fetchData();
startTimer();
