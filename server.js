const express = require('express');
const cors = require('cors');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const Stealth = require('puppeteer-extra-plugin-stealth');
puppeteer.use(Stealth());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════════════
// NSE API URLs  (discovered by network-intercepting the real page)
// ══════════════════════════════════════════════════════════════════════
const NSE_OC_PAGE = 'https://www.nseindia.com/option-chain';
const NSE_CONTRACT_INFO = 'https://www.nseindia.com/api/option-chain-contract-info?symbol=NIFTY';
// Real v3 API the page calls:  …/option-chain-v3?type=Indices&symbol=NIFTY&expiry=13-Apr-2026
const NSE_API_V3 = 'https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY';
const POLL_MS = 45_000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════════════
// Browser state
// ══════════════════════════════════════════════════════════════════════
let browser = null;
let warmPage = null;   // page kept open on NSE main site
let browserReady = false;
let cachedData = null;
let cacheTime = 0;
let fetchCount = 0;
let errorStreak = 0;

// ── Launch browser ────────────────────────────────────────────────────
async function launchBrowser() {
  if (browser) { try { await browser.close(); } catch (_) { } }
  browser = null; warmPage = null; browserReady = false;

  console.log('[NSE] Launching Chromium (stealth)...');
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--window-size=1366,768'],
    defaultViewport: { width: 1366, height: 768 },
  });
}

// ── Warm up session: navigate to NSE option-chain page ───────────────
async function warmSession() {
  console.log('[NSE] Warming session on option-chain page...');
  if (warmPage && !warmPage.isClosed()) { try { await warmPage.close(); } catch (_) { } }

  warmPage = await browser.newPage();
  await warmPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await warmPage.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  try {
    await warmPage.goto(NSE_OC_PAGE, { waitUntil: 'networkidle2', timeout: 35_000 });
    await sleep(5000); // Allow Akamai JS challenge to set cookies
    console.log('[NSE] Session warm. URL:', warmPage.url());
    browserReady = true;
    return true;
  } catch (err) {
    console.error('[NSE] Warm session failed:', err.message);
    browserReady = false;
    return false;
  }
}

// ── Two-step fetch using the real v3 API ─────────────────────────────
// Runs inside the warmed page context so cookies are already valid.
async function fetchV3Data() {
  const result = await warmPage.evaluate(async (contractInfoUrl, apiV3Base) => {
    try {
      // Step 1: get current expiry dates
      const r1 = await fetch(contractInfoUrl, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
      const info = await r1.json();

      // Extract the nearest expiry date from contract-info response
      let expiry = null;
      if (info?.data?.CE?.[0]?.expiryDate) expiry = info.data.CE[0].expiryDate;
      else if (info?.expiryDates?.[0]) expiry = info.expiryDates[0];
      else if (Array.isArray(info?.data) && info.data[0]?.expiryDate) expiry = info.data[0].expiryDate;

      if (!expiry) return { error: 'No expiry from contract-info', raw: JSON.stringify(info).substring(0, 300) };

      // Step 2: fetch the option chain with expiry
      const apiUrl = `${apiV3Base}&expiry=${encodeURIComponent(expiry)}`;
      const r2 = await fetch(apiUrl, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
      const text = await r2.text();
      return { status: r2.status, text, expiry };
    } catch (e) {
      return { error: e.message };
    }
  }, NSE_CONTRACT_INFO, NSE_API_V3);

  if (result.error) {
    if (result.raw) console.log('[NSE] contract-info raw:', result.raw);
    throw new Error(`two-step fetch error: ${result.error}`);
  }

  console.log(`[NSE] v3 fetch | expiry: ${result.expiry} | status: ${result.status} | len: ${result.text?.length}`);

  if (result.status !== 200) throw new Error(`API HTTP ${result.status}`);

  const data = JSON.parse(result.text);
  if (!data.records || !data.records.data || data.records.data.length === 0) {
    throw new Error(`Empty records (keys: ${Object.keys(data).join(', ')})`);
  }
  return data;
}

// ── Intercept during page load (bonus — catches data the page fetches) ─
async function fetchByIntercept() {
  let captured = null;

  if (warmPage && !warmPage.isClosed()) { try { await warmPage.close(); } catch (_) { } }
  warmPage = await browser.newPage();
  await warmPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await warmPage.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  const handler = async (resp) => {
    const url = resp.url();
    if (url.includes('option-chain-v3') || url.includes('option-chain-indices')) {
      try {
        const json = await resp.json();
        if (json?.records?.data?.length > 0) {
          captured = json;
          console.log(`[NSE] Intercepted ${json.records.data.length} records from ${url.split('?')[0].split('/').pop()}`);
        }
      } catch (_) { }
    }
  };

  warmPage.on('response', handler);
  try {
    await warmPage.goto(NSE_OC_PAGE, { waitUntil: 'networkidle2', timeout: 35_000 });
    await sleep(5000);
  } catch (err) {
    console.error('[NSE] Intercept nav error:', err.message);
  } finally {
    warmPage.off('response', handler);
  }

  if (captured) browserReady = true;
  return captured;
}

// ══════════════════════════════════════════════════════════════════════
// Main init cycle
// ══════════════════════════════════════════════════════════════════════
async function initAndFetch() {
  await launchBrowser();

  // Strategy A: intercept what the page naturally fetches
  const intercepted = await fetchByIntercept();
  if (intercepted) return intercepted;

  console.log('[NSE] Intercept got nothing. Trying v3 two-step fetch...');

  // Strategy B: explicitly call v3 API from within page context
  await sleep(1000);
  try {
    const data = await fetchV3Data();
    return data;
  } catch (err) {
    console.error('[NSE] v3 fetch attempt 1 failed:', err.message);
  }

  // Strategy C: wait a bit more and try again
  await sleep(3000);
  try {
    const data = await fetchV3Data();
    return data;
  } catch (err) {
    console.error('[NSE] v3 fetch attempt 2 failed:', err.message);
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════
// Background polling
// ══════════════════════════════════════════════════════════════════════
async function pollOnce() {
  if (!browserReady || !warmPage || warmPage.isClosed()) {
    const data = await initAndFetch();
    if (data) { cachedData = data; cacheTime = Date.now(); fetchCount++; errorStreak = 0; }
    else { errorStreak++; }
    return;
  }

  // Periodic full re-warm every 10 fetches
  if (fetchCount > 0 && fetchCount % 10 === 0) {
    console.log('[NSE] Periodic re-warm...');
    try { await warmSession(); } catch (_) { }
  }

  try {
    const data = await fetchV3Data();
    cachedData = data; cacheTime = Date.now(); fetchCount++; errorStreak = 0;
    console.log(`[NSE] ✅ #${fetchCount} | ${data.records.data.length} rows | spot ${data.records.underlyingValue}`);
  } catch (err) {
    console.error(`[NSE] Poll failed (streak ${errorStreak + 1}):`, err.message);
    errorStreak++;
    if (errorStreak >= 3) {
      console.log('[NSE] Reinitialising browser...');
      browserReady = false; errorStreak = 0;
    }
  }
}

async function pollLoop() {
  while (true) {
    try { await pollOnce(); } catch (err) { console.error('[NSE] Poll loop crash:', err.message); }
    await sleep(POLL_MS);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Express routes
// ══════════════════════════════════════════════════════════════════════
app.get('/api/option-chain', async (req, res) => {
  if (req.query.sample === 'true') {
    return res.json({ success: true, data: generateSampleData(), sample: true, timestamp: Date.now() });
  }

  // Wait up to 60s for first real data
  const deadline = Date.now() + 60_000;
  while (!cachedData && Date.now() < deadline) await sleep(500);

  if (cachedData) {
    const stale = Date.now() - cacheTime > 180_000;
    return res.json({
      success: true, data: cachedData, cached: true, stale, timestamp: cacheTime,
      ...(stale ? { error: 'Data may be stale' } : {})
    });
  }

  return res.json({
    success: true, data: generateSampleData(), sample: true, timestamp: Date.now(),
    error: 'NSE data not yet available — browser still initialising.'
  });
});

app.get('/api/health', (_req, res) => res.json({
  status: 'ok', browserReady, fetchCount, errorStreak,
  cacheAgeS: cachedData ? Math.round((Date.now() - cacheTime) / 1000) : null,
}));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ══════════════════════════════════════════════════════════════════════
// Sample data (fallback)
// ══════════════════════════════════════════════════════════════════════
function generateSampleData() {
  const spot = 23100 + Math.random() * 100;
  const atm = Math.round(spot / 50) * 50;
  const expiry = getNextThursday();
  const strikes = Array.from({ length: 31 }, (_, i) => atm + (i - 15) * 50);
  const data = strikes.map(k => {
    const d = k - spot;
    const cCoi = Math.round((Math.random() - 0.4) * 80000);
    const pCoi = Math.round((Math.random() - 0.3) * 100000);
    const cLtp = (d < 0 ? Math.abs(d) : 0) + Math.random() * 150 + 10;
    const pLtp = (d > 0 ? Math.abs(d) : 0) + Math.random() * 150 + 10;
    return {
      strikePrice: k, expiryDate: expiry,
      CE: {
        strikePrice: k, expiryDate: expiry, underlying: 'NIFTY',
        openInterest: Math.round(Math.random() * 500000 + 50000),
        changeinOpenInterest: cCoi, lastPrice: +cLtp.toFixed(2), change: 0, underlyingValue: spot
      },
      PE: {
        strikePrice: k, expiryDate: expiry, underlying: 'NIFTY',
        openInterest: Math.round(Math.random() * 500000 + 50000),
        changeinOpenInterest: pCoi, lastPrice: +pLtp.toFixed(2), change: 0, underlyingValue: spot
      },
    };
  });
  return {
    records: {
      expiryDates: [expiry], data, timestamp: new Date().toISOString(),
      underlyingValue: +spot.toFixed(2), strikePrices: strikes
    },
    filtered: { data, CE: { totOI: 0, totVol: 0 }, PE: { totOI: 0, totVol: 0 } },
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
app.listen(PORT, async () => {
  console.log(`\n🚀  NSE Option Chain Dashboard → http://localhost:${PORT}\n`);
  try {
    const data = await initAndFetch();
    if (data) {
      cachedData = data; cacheTime = Date.now(); fetchCount++;
      console.log(`[NSE] ✅ Ready! ${data.records.data.length} records, spot ${data.records.underlyingValue}`);
    } else {
      console.log('[NSE] Initial fetch returned nothing — poll will retry every 45s.');
      browserReady = false;
    }
  } catch (err) {
    console.error('[NSE] Startup error:', err.message);
    browserReady = false;
  }
  pollLoop();
});

process.on('SIGINT', async () => { try { await browser?.close(); } catch (_) { } process.exit(); });
process.on('SIGTERM', async () => { try { await browser?.close(); } catch (_) { } process.exit(); });
