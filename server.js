const express = require('express');
const cors    = require('cors');
const path    = require('path');
const axios   = require('axios');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════════════
// Fyers API Config
// ══════════════════════════════════════════════════════════════════════
const FYERS_APP_ID     = process.env.FYERS_APP_ID     || '4U7HO4T9UI-100';
const FYERS_APP_SECRET = process.env.FYERS_APP_SECRET || '6EZC6R9K6V';
const REDIRECT_URI     = process.env.REDIRECT_URI     || 'https://nse-option-chain-dashboard-936v.onrender.com/';

const FYERS_AUTH_BASE  = 'https://api-t2.fyers.in/api/v3/generate-authcode';
const FYERS_TOKEN_URL  = 'https://api-t2.fyers.in/api/v3/validate-authcode';
const FYERS_OC_URL     = 'https://api-t2.fyers.in/data/v3/options-chain';

const POLL_MS = 45_000;

// ══════════════════════════════════════════════════════════════════════
// State
// ══════════════════════════════════════════════════════════════════════
let accessToken = null;
let tokenExpiry = 0;
let cachedData  = null;
let cacheTime   = 0;
let fetchCount  = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════════════
// Auth helpers
// ══════════════════════════════════════════════════════════════════════
function getAppIdHash() {
  return crypto.createHash('sha256')
    .update(`${FYERS_APP_ID}:${FYERS_APP_SECRET}`)
    .digest('hex');
}

function getLoginUrl() {
  const params = new URLSearchParams({
    client_id:     FYERS_APP_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    state:         'nse_dashboard',
  });
  return `${FYERS_AUTH_BASE}?${params}`;
}

async function exchangeCodeForToken(authCode) {
  const res = await axios.post(FYERS_TOKEN_URL, {
    grant_type: 'authorization_code',
    appIdHash:  getAppIdHash(),
    code:       authCode,
  }, { timeout: 10_000 });

  if (res.data.s !== 'ok' || !res.data.access_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(res.data)}`);
  }
  return res.data.access_token;
}

// ══════════════════════════════════════════════════════════════════════
// Fyers Option Chain fetch + transform
// ══════════════════════════════════════════════════════════════════════
async function fetchOptionChain() {
  if (!accessToken) throw new Error('Not authenticated');

  const res = await axios.get(FYERS_OC_URL, {
    params:  { symbol: 'NSE:NIFTY50-INDEX', strikecount: 20 },
    headers: { Authorization: `${FYERS_APP_ID}:${accessToken}` },
    timeout: 12_000,
  });

  if (res.data.s !== 'ok') {
    // Token expired?
    if (res.data.code === 429 || res.data.code === 401 || String(res.data.message).toLowerCase().includes('token')) {
      accessToken = null;
      throw new Error('TOKEN_EXPIRED');
    }
    throw new Error(`Fyers API error: ${JSON.stringify(res.data)}`);
  }

  return transformFyersData(res.data);
}

/**
 * Fyers v3 option chain response can look like either:
 *   { s:'ok', data: { expiryData: [ { expiry, optionsChain:[...] } ] } }
 * OR a flat list:
 *   { s:'ok', data: { options: [ { strikePrice, optionType:'CE'|'PE', ltp, oi, changeInOI } ] } }
 *
 * We handle both and convert to the same NSE-like format the frontend already understands.
 */
function transformFyersData(raw) {
  const d = raw.data || raw;
  let underlyingValue = d.underlyingValue || d.ltp || d.spotPrice || 0;
  let expiryDates     = [];
  let rowsData        = [];

  // ── Format A: expiryData array (most common in v3) ───────────────
  if (d.expiryData && Array.isArray(d.expiryData) && d.expiryData.length) {
    expiryDates = d.expiryData.map(e => e.expiry || e.date || e.expiryDate || String(e));
    const nearest   = d.expiryData[0];
    const chainArr  = nearest.optionsChain || nearest.strikeData || nearest.data || [];

    rowsData = chainArr.map(item => {
      const sp = item.strikePrice || item.strike_price || item.strike || 0;
      const ce = item.CE || item.ce || item.call || {};
      const pe = item.PE || item.pe || item.put || {};
      return buildRow(sp, ce, pe, underlyingValue, expiryDates[0]);
    });
  }
  // ── Format B: flat options array with optionType field ─────────────
  else if (d.options && Array.isArray(d.options)) {
    const strikeMap = {};
    for (const opt of d.options) {
      const sp = opt.strikePrice || opt.strike_price || 0;
      if (!strikeMap[sp]) strikeMap[sp] = { CE: {}, PE: {} };
      const type = (opt.optionType || opt.option_type || '').toUpperCase();
      strikeMap[sp][type] = opt;
      if (opt.expiryDate && !expiryDates.includes(opt.expiryDate)) expiryDates.push(opt.expiryDate);
      if (opt.underlyingValue || opt.underlying_value) underlyingValue = opt.underlyingValue || opt.underlying_value;
    }
    rowsData = Object.entries(strikeMap)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([sp, { CE, PE }]) => buildRow(Number(sp), CE, PE, underlyingValue, expiryDates[0] || ''));
  } else {
    throw new Error(`Unknown Fyers response shape: keys=${Object.keys(d).join(',')}`);
  }

  if (!rowsData.length) throw new Error('No option chain rows parsed');

  const sortedRows = rowsData.sort((a, b) => a.strikePrice - b.strikePrice);

  return {
    records: {
      timestamp:      new Date().toISOString(),
      underlyingValue,
      expiryDates,
      data:           sortedRows,
      strikePrices:   sortedRows.map(r => r.strikePrice),
    },
    filtered: { data: sortedRows },
  };
}

function buildRow(strikePrice, ce, pe, underlyingValue, expiry) {
  return {
    strikePrice,
    expiryDates: expiry,   // matches v3 field name our frontend expects
    CE: {
      strikePrice,
      expiryDate:           expiry,
      lastPrice:            ce.ltp          ?? ce.lastPrice     ?? 0,
      changeinOpenInterest: ce.changeInOI   ?? ce.oiChange      ?? ce.oi_change ?? ce.changeinOpenInterest ?? 0,
      openInterest:         ce.oi           ?? ce.openInterest  ?? ce.open_interest ?? 0,
      underlyingValue,
    },
    PE: {
      strikePrice,
      expiryDate:           expiry,
      lastPrice:            pe.ltp          ?? pe.lastPrice     ?? 0,
      changeinOpenInterest: pe.changeInOI   ?? pe.oiChange      ?? pe.oi_change ?? pe.changeinOpenInterest ?? 0,
      openInterest:         pe.oi           ?? pe.openInterest  ?? pe.open_interest ?? 0,
      underlyingValue,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// Background poll loop
// ══════════════════════════════════════════════════════════════════════
async function pollLoop() {
  while (true) {
    await sleep(POLL_MS);
    if (!accessToken) continue;
    try {
      const data = await fetchOptionChain();
      cachedData = data; cacheTime = Date.now(); fetchCount++;
      console.log(`[Fyers] ✅ #${fetchCount} | ${data.records.data.length} strikes | spot ${data.records.underlyingValue}`);
    } catch (err) {
      if (err.message === 'TOKEN_EXPIRED') {
        console.log('[Fyers] ⚠️  Token expired — user needs to re-login.');
        accessToken = null;
      } else {
        console.error('[Fyers] Poll error:', err.message);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// Routes
// ══════════════════════════════════════════════════════════════════════

// Root route — also handles Fyers OAuth callback (Fyers redirects here with ?auth_code=)
app.get('/', async (req, res) => {
  const authCode = req.query.auth_code || req.query.code;
  const state    = req.query.s || req.query.state;

  // If Fyers redirected here with an auth code, process it first
  if (authCode && (state === 'ok' || state === 'nse_dashboard')) {
    try {
      accessToken = await exchangeCodeForToken(authCode);
      tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23h
      console.log('[Fyers] ✅ Token received and stored.');
      // Kick off an immediate fetch in background
      fetchOptionChain()
        .then(data => { cachedData = data; cacheTime = Date.now(); fetchCount++; })
        .catch(e   => console.error('[Fyers] Initial fetch error:', e.message));
    } catch (err) {
      console.error('[Fyers] Token exchange error:', err.message);
    }
    // Redirect to clean URL so query params disappear from browser bar
    return res.redirect('/');
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Redirect user to Fyers login page
app.get('/auth/login', (_req, res) => res.redirect(getLoginUrl()));

// Auth status — frontend polls this to know if login is needed
app.get('/api/auth-status', (_req, res) => {
  res.json({
    authenticated:    !!accessToken,
    loginUrl:         getLoginUrl(),
    tokenExpiresInM:  accessToken ? Math.round((tokenExpiry - Date.now()) / 60000) : null,
  });
});

// Main data endpoint
app.get('/api/option-chain', async (req, res) => {
  if (req.query.sample === 'true') {
    return res.json({ success: true, data: generateSampleData(), sample: true, timestamp: Date.now() });
  }

  if (!accessToken) {
    return res.json({
      success:   true,
      data:      generateSampleData(),
      sample:    true,
      needsAuth: true,
      loginUrl:  getLoginUrl(),
      timestamp: Date.now(),
      error:     'Not authenticated with Fyers — click "Login with Fyers" to enable live data.',
    });
  }

  if (cachedData) {
    const stale = Date.now() - cacheTime > 120_000; // stale after 2 min
    return res.json({ success: true, data: cachedData, cached: true, stale, timestamp: cacheTime });
  }

  // No cache yet — try live fetch
  try {
    const data = await fetchOptionChain();
    cachedData = data; cacheTime = Date.now(); fetchCount++;
    return res.json({ success: true, data, timestamp: cacheTime });
  } catch (err) {
    const needsAuth = err.message === 'TOKEN_EXPIRED';
    if (needsAuth) accessToken = null;
    return res.json({
      success:   true,
      data:      generateSampleData(),
      sample:    true,
      needsAuth,
      loginUrl:  getLoginUrl(),
      timestamp: Date.now(),
      error:     needsAuth ? 'Fyers token expired — please re-login.' : err.message,
    });
  }
});

app.get('/api/health', (_req, res) => res.json({
  status: 'ok',
  authenticated: !!accessToken,
  fetchCount,
  cacheAgeS: cachedData ? Math.round((Date.now() - cacheTime) / 1000) : null,
  tokenExpiresInM: accessToken ? Math.round((tokenExpiry - Date.now()) / 60000) : null,
}));

// ══════════════════════════════════════════════════════════════════════
// Sample / fallback data
// ══════════════════════════════════════════════════════════════════════
function generateSampleData() {
  const spot    = 23162 + Math.random() * 50;
  const atm     = Math.round(spot / 50) * 50;
  const expiry  = getNextThursday();
  const strikes = Array.from({ length: 41 }, (_, i) => atm + (i - 20) * 50);

  const data = strikes.map(k => {
    const d    = k - spot;
    const cLtp = Math.max(0, (d < 0 ? -d : 0) + Math.random() * 80 + 5);
    const pLtp = Math.max(0, (d > 0 ?  d : 0) + Math.random() * 80 + 5);
    return {
      strikePrice: k,
      expiryDates: expiry,
      CE: { strikePrice: k, expiryDate: expiry, lastPrice: +cLtp.toFixed(2),
            changeinOpenInterest: Math.round((Math.random() - 0.4) * 60000),
            openInterest: Math.round(Math.random() * 400000 + 50000), underlyingValue: spot },
      PE: { strikePrice: k, expiryDate: expiry, lastPrice: +pLtp.toFixed(2),
            changeinOpenInterest: Math.round((Math.random() - 0.3) * 80000),
            openInterest: Math.round(Math.random() * 500000 + 50000), underlyingValue: spot },
    };
  });

  return {
    records: { expiryDates: [expiry], data, timestamp: new Date().toISOString(),
               underlyingValue: +spot.toFixed(2), strikePrices: strikes },
    filtered: { data },
  };
}

function getNextThursday() {
  const d = new Date();
  d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7 || 7));
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');
}

// ══════════════════════════════════════════════════════════════════════
// Start
// ══════════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🚀  NSE Option Chain Dashboard → http://localhost:${PORT}`);
  console.log(`🔑  Login URL → ${getLoginUrl()}\n`);
  pollLoop();
});
