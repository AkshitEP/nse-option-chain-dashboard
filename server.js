'use strict';
const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const puppeteer = require('puppeteer-extra');
const Stealth   = require('puppeteer-extra-plugin-stealth');
puppeteer.use(Stealth());

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ── Supported symbols (all NSE Indices) ──────────────────────────
const SUPPORTED = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];
const NSE_OC_PAGE = 'https://www.nseindia.com/option-chain';
const POLL_MS     = 45_000;

const contractInfoUrl = s => `https://www.nseindia.com/api/option-chain-contract-info?symbol=${s}`;
const v3Url           = s => `https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=${s}`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Browser state ─────────────────────────────────────────────────
let browser      = null;
let warmPage     = null;
let browserReady = false;
let errorStreak  = 0;

// ── Per-symbol cache ──────────────────────────────────────────────
// cacheMap[symbol] = { data, time, count }
const cacheMap = {};

async function launchBrowser() {
  if (browser) { try { await browser.close(); } catch (_) {} }
  browser = null; warmPage = null; browserReady = false;

  console.log('[NSE] Launching Chromium (stealth)...');
  browser = await puppeteer.launch({
    headless: 'new',
    ...(process.env.PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
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

async function fetchV3Data(symbol) {
  const result = await warmPage.evaluate(async (ciUrl, apiBase) => {
    try {
      const r1   = await fetch(ciUrl, { credentials: 'include', headers: { Accept: 'application/json' } });
      const info = await r1.json();
      let expiry = info?.data?.CE?.[0]?.expiryDate
                || info?.expiryDates?.[0]
                || (Array.isArray(info?.data) ? info.data[0]?.expiryDate : null);
      if (!expiry) return { error: 'No expiry found', raw: JSON.stringify(info).substring(0, 300) };
      const r2   = await fetch(`${apiBase}&expiry=${encodeURIComponent(expiry)}`,
                     { credentials: 'include', headers: { Accept: 'application/json' } });
      const text = await r2.text();
      return { status: r2.status, text, expiry };
    } catch (e) { return { error: e.message }; }
  }, contractInfoUrl(symbol), v3Url(symbol));

  if (result.error)   throw new Error(`${symbol} fetch: ${result.error}`);
  if (result.status !== 200) throw new Error(`${symbol} HTTP ${result.status}`);
  const data = JSON.parse(result.text);
  if (!data.records?.data?.length) throw new Error(`${symbol} empty records`);
  console.log(`[NSE] ${symbol} v3 | expiry:${result.expiry} | rows:${data.records.data.length}`);
  return data;
}

async function fetchByIntercept(symbol) {
  let captured = null;
  if (warmPage && !warmPage.isClosed()) { try { await warmPage.close(); } catch (_) {} }
  warmPage = await browser.newPage();
  await warmPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await warmPage.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  const handler = async (resp) => {
    const url = resp.url();
    if ((url.includes('option-chain-v3') || url.includes('option-chain-indices')) && url.includes(symbol)) {
      try {
        const json = await resp.json();
        if (json?.records?.data?.length > 0) {
          captured = json;
          console.log(`[NSE] Intercepted ${symbol}: ${json.records.data.length} records`);
        }
      } catch (_) {}
    }
  };
  warmPage.on('response', handler);
  try {
    await warmPage.goto(NSE_OC_PAGE, { waitUntil: 'networkidle2', timeout: 35_000 });
    await sleep(5000);
  } catch (err) { console.error('[NSE] Intercept nav:', err.message); }
  finally { warmPage.off('response', handler); }
  if (captured) browserReady = true;
  return captured;
}

async function initAndFetch(symbol = 'NIFTY') {
  await launchBrowser();
  const intercepted = await fetchByIntercept(symbol);
  if (intercepted) return intercepted;
  await sleep(1000);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { return await fetchV3Data(symbol); }
    catch (err) { console.error(`[NSE] ${symbol} v3 attempt ${attempt}:`, err.message); await sleep(3000); }
  }
  return null;
}

// ── Poll loop — cycles through all symbols ─────────────────────────
let pollCount = 0;

async function pollOnce() {
  const symbol = SUPPORTED[pollCount % SUPPORTED.length];
  pollCount++;

  if (!browserReady || !warmPage || warmPage.isClosed()) {
    const data = await initAndFetch(symbol);
    if (data) {
      cacheMap[symbol] = { data, time: Date.now(), count: (cacheMap[symbol]?.count || 0) + 1 };
      errorStreak = 0;
    } else errorStreak++;
    return;
  }

  // Periodic session refresh every 30 polls
  if (pollCount > 1 && pollCount % 30 === 0) {
    try { await warmSession(); } catch (_) {}
  }

  try {
    const data = await fetchV3Data(symbol);
    cacheMap[symbol] = { data, time: Date.now(), count: (cacheMap[symbol]?.count || 0) + 1 };
    errorStreak = 0;
    console.log(`[NSE] ✅ ${symbol} #${cacheMap[symbol].count} | spot ${data.records.underlyingValue}`);
  } catch (err) {
    console.error(`[NSE] Poll fail [${symbol}] (streak ${errorStreak + 1}):`, err.message);
    errorStreak++;
    if (errorStreak >= 3) { browserReady = false; errorStreak = 0; }
  }
}

async function pollLoop() {
  while (true) {
    try { await pollOnce(); } catch (err) { console.error('[NSE] Loop crash:', err.message); }
    await sleep(POLL_MS / SUPPORTED.length); // spread polls evenly
  }
}

// ── API Routes ────────────────────────────────────────────────────
app.get('/api/option-chain', async (req, res) => {
  const symbol = SUPPORTED.includes((req.query.symbol || '').toUpperCase())
    ? req.query.symbol.toUpperCase() : 'NIFTY';

  if (req.query.sample === 'true')
    return res.json({ success: true, data: generateSampleData(symbol), sample: true, timestamp: Date.now() });

  const sc = cacheMap[symbol];

  // If we have fresh cache, return immediately
  if (sc?.data) {
    const stale = Date.now() - sc.time > 180_000;
    return res.json({ success: true, data: sc.data, cached: true, stale, timestamp: sc.time,
      symbol, ...(stale ? { error: 'Data may be stale' } : {}) });
  }

  // On-demand fetch if browser is ready
  if (browserReady && warmPage && !warmPage.isClosed()) {
    try {
      const data = await fetchV3Data(symbol);
      cacheMap[symbol] = { data, time: Date.now(), count: (cacheMap[symbol]?.count || 0) + 1 };
      return res.json({ success: true, data, symbol, timestamp: cacheMap[symbol].time });
    } catch (err) {
      console.error(`[NSE] On-demand ${symbol}:`, err.message);
    }
  }

  // Wait briefly for startup fetch (NIFTY only)
  if (symbol === 'NIFTY') {
    const deadline = Date.now() + 60_000;
    while (!cacheMap.NIFTY?.data && Date.now() < deadline) await sleep(500);
    if (cacheMap.NIFTY?.data) {
      return res.json({ success: true, data: cacheMap.NIFTY.data, symbol, cached: true, timestamp: cacheMap.NIFTY.time });
    }
  }

  return res.json({ success: true, data: generateSampleData(symbol), sample: true,
    symbol, timestamp: Date.now(), error: `${symbol} data loading — please wait.` });
});

// ── Sector Indices Cache ──────────────────────────────────────────
let sectorCache = { data: null, time: 0 };
const SECTOR_INDICES = [
  { key: 'NIFTY 50',     label: 'Nifty Top 10', emoji: '🏆' },
  { key: 'NIFTY IT',     label: 'Nifty IT',     emoji: '💻' },
  { key: 'NIFTY PHARMA', label: 'Nifty Pharma',  emoji: '💊' },
  { key: 'NIFTY AUTO',   label: 'Nifty Auto',    emoji: '🚗' },
  { key: 'NIFTY METAL',  label: 'Nifty Metal',   emoji: '⛏️' },
];
const ADANI_STOCKS = ['Adani Enterprises Ltd.', 'Adani Ports and Special Economic Zone Ltd.'];

app.get('/api/sector-indices', async (_req, res) => {
  // Return cache if fresh (< 60s)
  if (sectorCache.data && Date.now() - sectorCache.time < 60_000) {
    return res.json({ success: true, data: sectorCache.data, cached: true, timestamp: sectorCache.time });
  }

  if (!browserReady || !warmPage || warmPage.isClosed()) {
    if (sectorCache.data) {
      return res.json({ success: true, data: sectorCache.data, cached: true, stale: true, timestamp: sectorCache.time });
    }
    return res.json({ success: false, error: 'Browser not ready' });
  }

  try {
    const results = await warmPage.evaluate(async (indices, adaniNames) => {
      const out = [];
      let nifty50Data = null;
      for (const idx of indices) {
        try {
          const url = `https://www.nseindia.com/api/equity-stockIndices?index=${encodeURIComponent(idx.key)}`;
          const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
          const json = await r.json();
          // Save NIFTY 50 full data for Adani extraction
          if (idx.key === 'NIFTY 50') nifty50Data = json?.data || [];
          // First item in data array is the index itself
          const indexRow = json?.data?.[0];
          if (indexRow) {
            out.push({
              key: idx.key,
              label: idx.label,
              emoji: idx.emoji,
              last: indexRow.lastPrice || indexRow.last || 0,
              open: indexRow.open || 0,
              previousClose: indexRow.previousClose || 0,
              change: indexRow.change || 0,
              pChange: indexRow.pChange || 0,
              dayHigh: indexRow.dayHigh || 0,
              dayLow: indexRow.dayLow || 0,
            });
          }
        } catch (e) { /* skip failed index */ }
      }
      // Compute Adani group from NIFTY 50 constituents
      if (nifty50Data && nifty50Data.length > 0) {
        const adaniStocks = nifty50Data.filter(s => adaniNames.some(n => (s.symbol || '').includes('ADANI') || (s.meta?.companyName || '').includes('Adani') || n === (s.meta?.companyName || '')));
        // Fallback: match by symbol
        const adani = adaniStocks.length > 0 ? adaniStocks : nifty50Data.filter(s => ['ADANIENT', 'ADANIPORTS'].includes(s.symbol));
        if (adani.length > 0) {
          const avgChange = adani.reduce((sum, s) => sum + (s.change || 0), 0) / adani.length;
          const avgPChange = adani.reduce((sum, s) => sum + (s.pChange || 0), 0) / adani.length;
          const avgLast = adani.reduce((sum, s) => sum + (s.lastPrice || 0), 0) / adani.length;
          const avgOpen = adani.reduce((sum, s) => sum + (s.open || 0), 0) / adani.length;
          const avgPrev = adani.reduce((sum, s) => sum + (s.previousClose || 0), 0) / adani.length;
          const minLow = Math.min(...adani.map(s => s.dayLow || 0));
          const maxHigh = Math.max(...adani.map(s => s.dayHigh || 0));
          out.push({
            key: 'ADANI_GROUP', label: 'Adani Group', emoji: '🏢',
            last: avgLast, open: avgOpen, previousClose: avgPrev,
            change: avgChange, pChange: avgPChange,
            dayHigh: maxHigh, dayLow: minLow,
          });
        }
      }
      return out;
    }, SECTOR_INDICES, ADANI_STOCKS);

    if (results.length > 0) {
      sectorCache = { data: results, time: Date.now() };
      console.log(`[NSE] ✅ Sector indices fetched: ${results.map(r => `${r.label} ${r.pChange > 0 ? '+' : ''}${r.pChange.toFixed(2)}%`).join(', ')}`);
    }
    return res.json({ success: true, data: results, timestamp: Date.now() });
  } catch (err) {
    console.error('[NSE] Sector fetch error:', err.message);
    if (sectorCache.data) {
      return res.json({ success: true, data: sectorCache.data, cached: true, stale: true, timestamp: sectorCache.time });
    }
    return res.json({ success: false, error: err.message });
  }
});

app.get('/api/health', (_req, res) => res.json({
  status: 'ok', browserReady, errorStreak, pollCount,
  cache: Object.fromEntries(SUPPORTED.map(s => [s, cacheMap[s]
    ? { count: cacheMap[s].count, ageS: Math.round((Date.now() - cacheMap[s].time) / 1000) }
    : null])),
}));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Sample Data ───────────────────────────────────────────────────
function generateSampleData(symbol = 'NIFTY') {
  const bases  = { NIFTY: 23100, BANKNIFTY: 51500, FINNIFTY: 23400 };
  const steps  = { NIFTY: 50,    BANKNIFTY: 100,   FINNIFTY: 50 };
  const spot   = (bases[symbol] || 23100) + Math.random() * 100;
  const step   = steps[symbol] || 50;
  const atm    = Math.round(spot / step) * step;
  const expiry = getNextThursday();
  const strikes = Array.from({ length: 41 }, (_, i) => atm + (i - 20) * step);
  const data = strikes.map(k => {
    const d = k - spot;
    const cLtp = Math.max(0, (d < 0 ? -d : 0) + Math.random() * 80 + 5);
    const pLtp = Math.max(0, (d > 0 ?  d : 0) + Math.random() * 80 + 5);
    const cOI  = Math.round(Math.random() * 400000 + 50000);
    const pOI  = Math.round(Math.random() * 500000 + 50000);
    return {
      strikePrice: k, expiryDates: expiry,
      CE: { strikePrice: k, expiryDate: expiry, lastPrice: +cLtp.toFixed(2),
            changeinOpenInterest: Math.round((Math.random() - 0.4) * 60000),
            openInterest: cOI, totalTradedVolume: Math.round(Math.random() * 50000),
            underlyingValue: spot },
      PE: { strikePrice: k, expiryDate: expiry, lastPrice: +pLtp.toFixed(2),
            changeinOpenInterest: Math.round((Math.random() - 0.3) * 80000),
            openInterest: pOI, totalTradedVolume: Math.round(Math.random() * 50000),
            underlyingValue: spot },
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

// ── Boot ─────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀  NSE Option Chain Dashboard → http://localhost:${PORT}\n`);
  try {
    const data = await initAndFetch('NIFTY');
    if (data) {
      cacheMap.NIFTY = { data, time: Date.now(), count: 1 };
      console.log(`[NSE] ✅ NIFTY ready! ${data.records.data.length} records`);
    } else {
      console.log('[NSE] Initial fetch returned nothing — poll will retry.');
      browserReady = false;
    }
  } catch (err) { console.error('[NSE] Startup error:', err.message); browserReady = false; }
  pollLoop();
});

process.on('SIGINT',  async () => { try { await browser?.close(); } catch (_) {} process.exit(); });
process.on('SIGTERM', async () => { try { await browser?.close(); } catch (_) {} process.exit(); });
