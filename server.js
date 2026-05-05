const express = require('express');
const cors    = require('cors');
const path    = require('path');
const puppeteer = require('puppeteer-extra');
const Stealth   = require('puppeteer-extra-plugin-stealth');
puppeteer.use(Stealth());

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const NSE_OC_PAGE       = 'https://www.nseindia.com/option-chain';
const NSE_CONTRACT_INFO = 'https://www.nseindia.com/api/option-chain-contract-info?symbol=NIFTY';
const NSE_API_V3        = 'https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY';
const POLL_MS = 45_000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let browser      = null;
let warmPage     = null;
let browserReady = false;
let cachedData   = null;
let cacheTime    = 0;
let fetchCount   = 0;
let errorStreak  = 0;

async function launchBrowser() {
  if (browser) { try { await browser.close(); } catch (_) {} }
  browser = null; warmPage = null; browserReady = false;

  console.log('[NSE] Launching Chromium (stealth)...');
  browser = await puppeteer.launch({
    headless: 'new',
    ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--window-size=1366,768'],
    defaultViewport: { width: 1366, height: 768 },
  });
}

async function warmSession() {
  if (warmPage && !warmPage.isClosed()) { try { await warmPage.close(); } catch (_) {} }
  warmPage = await browser.newPage();
  await warmPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await warmPage.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  try {
    await warmPage.goto(NSE_OC_PAGE, { waitUntil: 'networkidle2', timeout: 35_000 });
    await sleep(5000);
    browserReady = true;
    return true;
  } catch (err) {
    console.error('[NSE] Warm session failed:', err.message);
    browserReady = false;
    return false;
  }
}

async function fetchV3Data() {
  const result = await warmPage.evaluate(async (contractInfoUrl, apiV3Base) => {
    try {
      const r1 = await fetch(contractInfoUrl, { credentials: 'include', headers: { 'Accept': 'application/json' } });
      const info = await r1.json();
      let expiry = null;
      if (info?.data?.CE?.[0]?.expiryDate)     expiry = info.data.CE[0].expiryDate;
      else if (info?.expiryDates?.[0])          expiry = info.expiryDates[0];
      else if (Array.isArray(info?.data) && info.data[0]?.expiryDate) expiry = info.data[0].expiryDate;
      if (!expiry) return { error: 'No expiry from contract-info', raw: JSON.stringify(info).substring(0, 300) };
      const apiUrl = `${apiV3Base}&expiry=${encodeURIComponent(expiry)}`;
      const r2 = await fetch(apiUrl, { credentials: 'include', headers: { 'Accept': 'application/json' } });
      const text = await r2.text();
      return { status: r2.status, text, expiry };
    } catch (e) { return { error: e.message }; }
  }, NSE_CONTRACT_INFO, NSE_API_V3);

  if (result.error) throw new Error(`fetch error: ${result.error}`);
  if (result.status !== 200) throw new Error(`API HTTP ${result.status}`);
  console.log(`[NSE] v3 | expiry: ${result.expiry} | len: ${result.text?.length}`);
  const data = JSON.parse(result.text);
  if (!data.records || !data.records.data || data.records.data.length === 0)
    throw new Error(`Empty records (keys: ${Object.keys(data).join(', ')})`);
  return data;
}

async function fetchByIntercept() {
  let captured = null;
  if (warmPage && !warmPage.isClosed()) { try { await warmPage.close(); } catch (_) {} }
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
          console.log(`[NSE] Intercepted ${json.records.data.length} records`);
        }
      } catch (_) {}
    }
  };
  warmPage.on('response', handler);
  try {
    await warmPage.goto(NSE_OC_PAGE, { waitUntil: 'networkidle2', timeout: 35_000 });
    await sleep(5000);
  } catch (err) { console.error('[NSE] Intercept nav error:', err.message); }
  finally { warmPage.off('response', handler); }
  if (captured) browserReady = true;
  return captured;
}

async function initAndFetch() {
  await launchBrowser();
  const intercepted = await fetchByIntercept();
  if (intercepted) return intercepted;
  console.log('[NSE] Intercept got nothing. Trying v3 two-step...');
  await sleep(1000);
  try { return await fetchV3Data(); } catch (err) { console.error('[NSE] v3 attempt 1:', err.message); }
  await sleep(3000);
  try { return await fetchV3Data(); } catch (err) { console.error('[NSE] v3 attempt 2:', err.message); }
  return null;
}

async function pollOnce() {
  if (!browserReady || !warmPage || warmPage.isClosed()) {
    const data = await initAndFetch();
    if (data) { cachedData = data; cacheTime = Date.now(); fetchCount++; errorStreak = 0; }
    else errorStreak++;
    return;
  }
  if (fetchCount > 0 && fetchCount % 10 === 0) {
    try { await warmSession(); } catch (_) {}
  }
  try {
    const data = await fetchV3Data();
    cachedData = data; cacheTime = Date.now(); fetchCount++; errorStreak = 0;
    console.log(`[NSE] ✅ #${fetchCount} | ${data.records.data.length} rows | spot ${data.records.underlyingValue}`);
  } catch (err) {
    console.error(`[NSE] Poll failed (streak ${errorStreak + 1}):`, err.message);
    errorStreak++;
    if (errorStreak >= 3) { browserReady = false; errorStreak = 0; }
  }
}

async function pollLoop() {
  while (true) {
    try { await pollOnce(); } catch (err) { console.error('[NSE] Poll loop crash:', err.message); }
    await sleep(POLL_MS);
  }
}

app.get('/api/option-chain', async (req, res) => {
  if (req.query.sample === 'true')
    return res.json({ success: true, data: generateSampleData(), sample: true, timestamp: Date.now() });

  const deadline = Date.now() + 60_000;
  while (!cachedData && Date.now() < deadline) await sleep(500);

  if (cachedData) {
    const stale = Date.now() - cacheTime > 180_000;
    return res.json({ success: true, data: cachedData, cached: true, stale, timestamp: cacheTime,
      ...(stale ? { error: 'Data may be stale' } : {}) });
  }
  return res.json({ success: true, data: generateSampleData(), sample: true, timestamp: Date.now(),
    error: 'NSE data not yet available — browser still initialising.' });
});

app.get('/api/health', (_req, res) => res.json({
  status: 'ok', browserReady, fetchCount, errorStreak,
  cacheAgeS: cachedData ? Math.round((Date.now() - cacheTime) / 1000) : null,
}));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function generateSampleData() {
  const spot    = 23100 + Math.random() * 100;
  const atm     = Math.round(spot / 50) * 50;
  const expiry  = getNextThursday();
  const strikes = Array.from({ length: 41 }, (_, i) => atm + (i - 20) * 50);
  const data = strikes.map(k => {
    const d = k - spot;
    const cLtp = Math.max(0, (d < 0 ? -d : 0) + Math.random() * 80 + 5);
    const pLtp = Math.max(0, (d > 0 ?  d : 0) + Math.random() * 80 + 5);
    return {
      strikePrice: k, expiryDates: expiry,
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

app.listen(PORT, async () => {
  console.log(`\n🚀  NSE Option Chain Dashboard → http://localhost:${PORT}\n`);
  try {
    const data = await initAndFetch();
    if (data) { cachedData = data; cacheTime = Date.now(); fetchCount++; console.log(`[NSE] ✅ Ready! ${data.records.data.length} records`); }
    else { console.log('[NSE] Initial fetch returned nothing — poll will retry.'); browserReady = false; }
  } catch (err) { console.error('[NSE] Startup error:', err.message); browserReady = false; }
  pollLoop();
});

process.on('SIGINT',  async () => { try { await browser?.close(); } catch (_) {} process.exit(); });
process.on('SIGTERM', async () => { try { await browser?.close(); } catch (_) {} process.exit(); });
