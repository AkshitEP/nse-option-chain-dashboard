/* ══════════════════════════════════════════════════════════════════════
   NSE Option Chain Dashboard — Frontend Logic
   ══════════════════════════════════════════════════════════════════════ */

const API_URL = '/api/option-chain';
const REFRESH_INTERVAL = 60; // seconds
const STRIKE_GAP = 50; // gap between strikes

let userStrike = null; // null = use ATM
let userN = 4; // N strikes above and below
let countdown = REFRESH_INTERVAL;
let timerInterval = null;
let previousData = null;
let lastRawData = null; // store raw data for re-processing on settings change

// ── DOM Elements ─────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const els = {
    spotPrice: $('spotPrice'),
    spotChange: $('spotChange'),
    atmStrike: $('atmStrike'),
    timerText: $('timerText'),
    timerCircle: $('timerCircle'),
    lastUpdate: $('lastUpdate'),
    connectionStatus: $('connectionStatus'),
    expiryInfo: $('expiryInfo'),
    ocTableBody: $('ocTableBody'),
    footCallCoi: $('footCallCoi'),
    footPutCoi: $('footPutCoi'),
    pcrValue: $('pcrValue'),
    pcrTrend: $('pcrTrend'),
    imbalanceValue: $('imbalanceValue'),
    imbalanceSignal: $('imbalanceSignal'),
    callCoiValue: $('callCoiValue'),
    callCoiPct: $('callCoiPct'),
    putCoiValue: $('putCoiValue'),
    putCoiPct: $('putCoiPct'),
    totalCoiValue: $('totalCoiValue'),
    errorBanner: $('errorBanner'),
    errorMessage: $('errorMessage'),
    strikeInput: $('strikeInput'),
    nInput: $('nInput'),
    tableTitle: $('tableTitle'),
};

// ── Utility Functions ────────────────────────────────────────────────
function formatNum(n, decimals = 0) {
    if (n === undefined || n === null || isNaN(n)) return '--';
    return Number(n).toLocaleString('en-IN', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
}

function formatPct(n) {
    if (n === undefined || n === null || isNaN(n) || !isFinite(n)) return '--';
    return n.toFixed(2) + '%';
}

function getClosestStrike(spotPrice, strikePrices) {
    let closest = strikePrices[0];
    let minDiff = Math.abs(spotPrice - closest);
    for (const sp of strikePrices) {
        const diff = Math.abs(spotPrice - sp);
        if (diff < minDiff) {
            minDiff = diff;
            closest = sp;
        }
    }
    return closest;
}

// ── Fetch & Process Data ─────────────────────────────────────────────
async function fetchData() {
    try {
        setConnectionStatus('connecting');
        const res  = await fetch(API_URL);
        const json = await res.json();

        if (!json.success) {
            throw new Error(json.error || 'Failed to fetch data');
        }

        const data = json.data;
        processData(data);

        if (json.needsAuth && json.loginUrl) {
            // Not authenticated with Fyers — show login button
            setConnectionStatus('sample');
            showError(
                `Live data requires Fyers login. <a href="${json.loginUrl}" style="color:#7c6af7;font-weight:600;text-decoration:underline;">Click here to Login with Fyers →</a>`,
                true /* isHTML */
            );
        } else if (json.sample) {
            setConnectionStatus('sample');
            showError(json.error || 'Showing sample data — will auto-refresh.');
        } else if (json.stale) {
            setConnectionStatus('connected');
            showError('Using cached data — live refresh temporarily unavailable.');
        } else {
            setConnectionStatus('connected');
            hideError();
        }

    } catch (err) {
        console.error('Fetch error:', err);
        setConnectionStatus('error');
        showError(err.message || 'Failed to fetch data');
    }

    resetTimer();
}

function processData(data) {
    lastRawData = data; // store for re-processing
    const records = data.records;

    // Get spot price (underlying value)
    const spotPrice = records.underlyingValue;
    const expiryDates = records.expiryDates;
    const nearestExpiry = expiryDates[0]; // current week expiry

    // Get all strike data for the nearest expiry
    // NOTE: v3 API uses 'expiryDates' (plural) per row; old API used 'expiryDate'
    const allData = records.data.filter(d =>
        (d.expiryDate === nearestExpiry) || (d.expiryDates === nearestExpiry)
    );

    // Build a set of available strike prices
    const allStrikes = allData
        .map(d => d.strikePrice)
        .sort((a, b) => a - b);

    // Determine center strike: user-specified or ATM
    const atmStrike = getClosestStrike(spotPrice, allStrikes);
    const centerStrike = userStrike !== null ? userStrike : atmStrike;
    const n = userN;

    // Build strikes: centerStrike ± N * STRIKE_GAP
    const selectedStrikes = [];
    for (let i = -n; i <= n; i++) {
        selectedStrikes.push(centerStrike + i * STRIKE_GAP);
    }
    // Reverse so highest strike is on top (matching Excel layout)
    selectedStrikes.reverse();

    // Build strike data map
    const strikeMap = {};
    for (const d of allData) {
        strikeMap[d.strikePrice] = d;
    }

    // Calculate metrics for selected strikes
    const rows = [];
    let totalCallCoi = 0;
    let totalPutCoi = 0;

    for (let i = 0; i < selectedStrikes.length; i++) {
        const strike = selectedStrikes[i];
        const d = strikeMap[strike];

        const callLTP = d && d.CE ? d.CE.lastPrice : 0;
        const callCOI = d && d.CE ? d.CE.changeinOpenInterest : 0;
        const putLTP = d && d.PE ? d.PE.lastPrice : 0;
        const putCOI = d && d.PE ? d.PE.changeinOpenInterest : 0;

        totalCallCoi += callCOI;
        totalPutCoi += putCOI;

        rows.push({
            sno: i + 1,
            strike,
            callLTP,
            callCOI,
            putLTP,
            putCOI,
            isATM: strike === atmStrike,
            isCenter: strike === centerStrike,
        });
    }

    // Calculate imbalance for each row
    for (const row of rows) {
        // Imbalance vs Call: (callCOI - putCOI) / callCOI * 100
        row.imbVsCall = row.callCOI !== 0 ? ((row.callCOI - row.putCOI) / Math.abs(row.callCOI)) * 100 : 0;
        // Imbalance vs Put: (callCOI - putCOI) / putCOI * 100
        row.imbVsPut = row.putCOI !== 0 ? ((row.callCOI - row.putCOI) / Math.abs(row.putCOI)) * 100 : 0;
    }

    const totalCoi = Math.abs(totalCallCoi) + Math.abs(totalPutCoi);
    const pcr = totalCallCoi !== 0 ? totalPutCoi / totalCallCoi : 0;
    const imbalance = totalCoi !== 0 ? (Math.abs(totalPutCoi - totalCallCoi) / totalCoi) * 100 : 0;
    const callPct = totalCoi !== 0 ? (Math.abs(totalCallCoi) / totalCoi) * 100 : 0;
    const putPct = totalCoi !== 0 ? (Math.abs(totalPutCoi) / totalCoi) * 100 : 0;

    // ── Update UI ──────────────────────────────────────────────────────
    updateHeader(spotPrice, atmStrike, nearestExpiry);
    updateSummaryCards(pcr, imbalance, totalCallCoi, totalPutCoi, totalCoi, callPct, putPct);
    updateTable(rows, totalCallCoi, totalPutCoi);
    updateTableTitle(centerStrike, n);
    updateLastRefreshTime();

    previousData = { rows, totalCallCoi, totalPutCoi };
}

// ── Apply Settings (called when user clicks Apply) ───────────────────
function applySettings() {
    const strikeVal = els.strikeInput.value.trim();
    const nVal = parseInt(els.nInput.value);

    userStrike = strikeVal ? parseInt(strikeVal) : null;
    userN = isNaN(nVal) || nVal < 1 ? 4 : Math.min(nVal, 20);

    // Re-process last data with new settings
    if (lastRawData) {
        processData(lastRawData);
    }
}

function updateTableTitle(centerStrike, n) {
    const totalRows = 2 * n + 1;
    const label = userStrike !== null ? `Strike ${formatNum(centerStrike)}` : 'ATM';
    els.tableTitle.textContent = `Option Chain — ${totalRows} Strikes Around ${label}`;
}

// ── UI Update Functions ──────────────────────────────────────────────
function updateHeader(spotPrice, atmStrike, expiry) {
    els.spotPrice.textContent = formatNum(spotPrice, 2);

    // We don't have previous close easily, so just show the value
    els.spotChange.textContent = `ATM: ${atmStrike}`;
    els.spotChange.className = 'spot-change up';

    els.atmStrike.textContent = formatNum(atmStrike);
    els.expiryInfo.textContent = `Expiry: ${expiry}`;
}

function updateSummaryCards(pcr, imbalance, callCoi, putCoi, totalCoi, callPct, putPct) {
    // PCR
    els.pcrValue.textContent = pcr.toFixed(2);
    els.pcrTrend.textContent = pcr > 1 ? '▲ BULLISH' : pcr < 1 ? '▼ BEARISH' : '● NEUTRAL';
    els.pcrTrend.className = `card-trend ${pcr > 1 ? 'bullish' : pcr < 1 ? 'bearish' : 'neutral'}`;

    // Imbalance
    els.imbalanceValue.textContent = formatPct(imbalance);
    const bullish = putCoi > callCoi;
    els.imbalanceSignal.textContent = bullish ? '▲ BULLISH' : '▼ BEARISH';
    els.imbalanceSignal.className = `card-signal ${bullish ? 'bullish' : 'bearish'}`;

    // Call COI
    els.callCoiValue.textContent = formatNum(callCoi);
    els.callCoiValue.style.color = callCoi >= 0 ? 'var(--green-bright)' : 'var(--red-bright)';
    els.callCoiPct.textContent = formatPct(callPct) + ' of total';

    // Put COI
    els.putCoiValue.textContent = formatNum(putCoi);
    els.putCoiValue.style.color = putCoi >= 0 ? 'var(--green-bright)' : 'var(--red-bright)';
    els.putCoiPct.textContent = formatPct(putPct) + ' of total';

    // Total COI
    els.totalCoiValue.textContent = formatNum(totalCoi);
}

function updateTable(rows, totalCallCoi, totalPutCoi) {
    const tbody = els.ocTableBody;
    let html = '';

    for (const row of rows) {
        const rowClasses = [];
        if (row.isATM) rowClasses.push('atm-row');
        if (row.isCenter && userStrike !== null) rowClasses.push('center-row');
        const classStr = rowClasses.join(' ');
        const callCoiClass = row.callCOI > 0 ? 'positive' : row.callCOI < 0 ? 'negative' : '';
        const putCoiClass = row.putCOI > 0 ? 'positive' : row.putCOI < 0 ? 'negative' : '';
        const imbCallClass = row.imbVsCall > 0 ? 'positive' : row.imbVsCall < 0 ? 'negative' : '';
        const imbPutClass = row.imbVsPut > 0 ? 'positive' : row.imbVsPut < 0 ? 'negative' : '';

        html += `
      <tr class="${classStr}">
        <td class="cell-sno">${row.sno}</td>
        <td class="cell-ltp">${formatNum(row.callLTP, 2)}</td>
        <td class="cell-coi ${callCoiClass}">${formatNum(row.callCOI)}</td>
        <td class="cell-strike">${formatNum(row.strike)}</td>
        <td class="cell-ltp">${formatNum(row.putLTP, 2)}</td>
        <td class="cell-coi ${putCoiClass}">${formatNum(row.putCOI)}</td>
        <td class="cell-imb ${imbCallClass}">${formatPct(row.imbVsCall)}</td>
        <td class="cell-imb ${imbPutClass}">${formatPct(row.imbVsPut)}</td>
      </tr>
    `;
    }

    tbody.innerHTML = html;

    // Update footer totals
    els.footCallCoi.textContent = formatNum(totalCallCoi);
    els.footCallCoi.style.color = totalCallCoi >= 0 ? 'var(--green-bright)' : 'var(--red-bright)';
    els.footPutCoi.textContent = formatNum(totalPutCoi);
    els.footPutCoi.style.color = totalPutCoi >= 0 ? 'var(--green-bright)' : 'var(--red-bright)';
}

function updateLastRefreshTime() {
    const now = new Date();
    els.lastUpdate.textContent = now.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
    });
}

// ── Connection Status ────────────────────────────────────────────────
function setConnectionStatus(status) {
    const el = els.connectionStatus;
    el.className = 'connection-status';
    switch (status) {
        case 'connected':
            el.classList.add('connected');
            el.querySelector('span:last-child').textContent = 'Live';
            break;
        case 'sample':
            el.classList.add('sample');
            el.querySelector('span:last-child').textContent = 'Sample Data';
            break;
        case 'error':
            el.classList.add('error');
            el.querySelector('span:last-child').textContent = 'Error';
            break;
        default:
            el.querySelector('span:last-child').textContent = 'Connecting...';
    }
}

// ── Error Handling ───────────────────────────────────────────────────
function showError(message, isHTML = false) {
    els.errorBanner.style.display = 'flex';
    if (isHTML) {
        els.errorMessage.innerHTML = message;
    } else {
        els.errorMessage.textContent = message;
    }
}

function hideError() {
    els.errorBanner.style.display = 'none';
}

// ── Timer ────────────────────────────────────────────────────────────
function resetTimer() {
    countdown = REFRESH_INTERVAL;
    updateTimerDisplay();
}

function updateTimerDisplay() {
    els.timerText.textContent = countdown;

    // Update circular progress
    const circumference = 2 * Math.PI * 15; // r=15
    const progress = (countdown / REFRESH_INTERVAL) * circumference;
    els.timerCircle.setAttribute('stroke-dashoffset', circumference - progress);
}

function startTimer() {
    if (timerInterval) clearInterval(timerInterval);

    timerInterval = setInterval(() => {
        countdown--;
        updateTimerDisplay();

        if (countdown <= 0) {
            fetchData();
        }
    }, 1000);
}

// ── Initialize ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    fetchData();
    startTimer();
});
