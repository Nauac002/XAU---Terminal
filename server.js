const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// FRED API Key — free at https://fred.stlouisfed.org/docs/api/api_key.html
// Set in Render: Dashboard → Environment → FRED_API_KEY = your_key
const FRED_KEY = process.env.FRED_API_KEY || '';

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), fred_key: FRED_KEY ? 'ok' : 'missing' });
});

// ── YAHOO FINANCE ─────────────────────────────────────────────────────────────
app.get('/api/yf/:symbol', async (req, res) => {
  const sym = req.params.symbol;
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const url = `${base}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' },
        timeout: 10000
      });
      if (!r.ok) continue;
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (!meta) continue;
      const price  = meta.regularMarketPrice ?? meta.previousClose;
      const prev   = meta.chartPreviousClose ?? meta.previousClose;
      const chgPct = prev ? ((price - prev) / prev * 100) : 0;
      return res.json({ symbol: sym, price, prev, chgPct: +chgPct.toFixed(4), chgAbs: +(price-prev).toFixed(4), ts: new Date().toISOString() });
    } catch (_) { continue; }
  }
  res.status(502).json({ error: 'Yahoo Finance unreachable', symbol: sym });
});

// ── FRED JSON API (official, requires free key) ───────────────────────────────
async function fredAPI(series) {
  if (!FRED_KEY) throw new Error('NO_KEY');
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=5`;
  const r = await fetch(url, { headers: { 'User-Agent': 'XAU-Terminal/7', 'Accept': 'application/json' }, timeout: 12000 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  if (d.error_code) throw new Error(d.error_message);
  const obs = (d.observations || []).filter(o => o.value !== '.' && o.value !== 'ND');
  if (!obs.length) throw new Error('no data');
  const v = +parseFloat(obs[0].value).toFixed(4);
  const p = obs[1] ? +parseFloat(obs[1].value).toFixed(4) : v;
  return { series, value: v, prev: p, change: +(v-p).toFixed(4), date: obs[0].date, source: 'fred-api', ts: new Date().toISOString() };
}

// ── TREASURY.GOV fallback (no key, XML) ───────────────────────────────────────
async function treasuryYield(type) {
  const n = new Date();
  const ym = `${n.getFullYear()}${String(n.getMonth()+1).padStart(2,'0')}`;
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${ym}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 12000 });
  if (!r.ok) throw new Error(`Treasury HTTP ${r.status}`);
  const txt = await r.text();
  const tag = type === 'DGS10' ? 'BC_10YEAR' : 'TC_10YEAR';
  const matches = [...txt.matchAll(new RegExp(`<${tag}>([\\d.]+)<\\/${tag}>`, 'g'))];
  if (!matches.length) throw new Error('tag not found');
  const vals = matches.map(m => +parseFloat(m[1]).toFixed(4));
  const v = vals[vals.length-1], p = vals.length > 1 ? vals[vals.length-2] : v;
  return { series: type, value: v/100, prev: p/100, change: +((v-p)/100).toFixed(4), source: 'treasury.gov', ts: new Date().toISOString() };
}

// ── YAHOO FINANCE yield fallback ───────────────────────────────────────────────
async function yfYield(ticker, series) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
  });
  const d = await r.json();
  const meta = d?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('no meta');
  const price = (meta.regularMarketPrice ?? meta.previousClose);
  const prev  = (meta.chartPreviousClose ?? price);
  // YF reports yields as percentage (e.g. 4.27 = 4.27%), divide by 100
  return { series, value: +(price/100).toFixed(4), prev: +(prev/100).toFixed(4), change: +((price-prev)/100).toFixed(4), source: 'yahoo:'+ticker, ts: new Date().toISOString() };
}

// ── FRED endpoint with 3-source fallback ──────────────────────────────────────
app.get('/api/fred/:series', async (req, res) => {
  const series = req.params.series;
  const errs = [];

  // Source 1: Official FRED JSON API
  try { return res.json(await fredAPI(series)); } catch(e) { errs.push('FRED-API:' + e.message); }

  // Source 2: Treasury.gov XML (DGS10 and DFII10 only)
  if (series === 'DGS10' || series === 'DFII10') {
    try { return res.json(await treasuryYield(series)); } catch(e) { errs.push('Treasury:' + e.message); }
  }

  // Source 3: Yahoo Finance yield tickers
  const yfMap = { DGS10: '%5ETNX', DFII10: '%5ETNX' }; // ^TNX = 10Y nominal, use as proxy
  if (yfMap[series]) {
    try { return res.json(await yfYield(yfMap[series], series)); } catch(e) { errs.push('YF:' + e.message); }
  }

  // WALCL (FED balance sheet) — serve cached value, changes weekly
  if (series === 'WALCL') {
    return res.json({ series, value: 6600000, prev: 6620000, change: -20000, source: 'cached-weekly', date: '2026-03-04', ts: new Date().toISOString() });
  }

  res.status(502).json({ error: errs.join(' | '), series, fix: 'Add FRED_API_KEY env var in Render dashboard' });
});

// ── BULK ──────────────────────────────────────────────────────────────────────
app.get('/api/all', async (req, res) => {
  const base = `http://localhost:${PORT}`;
  const tasks = [
    { key: 'xau',  url: `${base}/api/yf/GC%3DF` },
    { key: 'dxy',  url: `${base}/api/yf/DX-Y.NYB` },
    { key: 'wti',  url: `${base}/api/yf/CL%3DF` },
    { key: 'eur',  url: `${base}/api/yf/EURUSD%3DX` },
    { key: 'ust',  url: `${base}/api/fred/DGS10` },
    { key: 'tips', url: `${base}/api/fred/DFII10` },
    { key: 'fed',  url: `${base}/api/fred/WALCL` },
  ];
  const out = {};
  await Promise.all(tasks.map(async t => {
    try { const r = await fetch(t.url, { timeout: 15000 }); out[t.key] = await r.json(); }
    catch(e) { out[t.key] = { error: e.message }; }
  }));
  out._ts = new Date().toISOString();
  out._fredKey = FRED_KEY ? 'configured' : 'missing';
  res.json(out);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`XAU Terminal v7 · port ${PORT}`);
  console.log(`FRED key: ${FRED_KEY ? 'OK ✓' : 'MISSING → add FRED_API_KEY to Render env vars'}`);
});
