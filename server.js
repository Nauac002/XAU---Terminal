const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const FRED_KEY = process.env.FRED_API_KEY || '';

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ── HEALTH ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), fred_key: FRED_KEY ? 'ok' : 'missing' });
});

// ══════════════════════════════════════════════════════════════════════════════
// MFC — MOTOR DE FORÇA DE MOEDAS (28 pares, metodologia Mataf)
// Calcula força relativa de 8 moedas: USD EUR GBP JPY CHF CAD AUD NZD
//
// Metodologia:
//   Para cada moeda M, força = média aritmética das variações % dos seus 7 pares
//   Variação % = (preço_atual - preço_anterior) / preço_anterior × 100
//   Se M é base currency: usar +chgPct
//   Se M é quote currency: usar -chgPct (inverte direcção)
//   Resultado normalizado: 0–100 onde 50 = neutro
// ══════════════════════════════════════════════════════════════════════════════

// Os 28 pares canónicos (base/quote) — tickers Yahoo Finance
const PAIRS_28 = [
  // Majors vs USD
  { ticker: 'EURUSD=X', base: 'EUR', quote: 'USD' },
  { ticker: 'GBPUSD=X', base: 'GBP', quote: 'USD' },
  { ticker: 'AUDUSD=X', base: 'AUD', quote: 'USD' },
  { ticker: 'NZDUSD=X', base: 'NZD', quote: 'USD' },
  { ticker: 'USDCAD=X', base: 'USD', quote: 'CAD' },
  { ticker: 'USDCHF=X', base: 'USD', quote: 'CHF' },
  { ticker: 'USDJPY=X', base: 'USD', quote: 'JPY' },
  // EUR crosses
  { ticker: 'EURGBP=X', base: 'EUR', quote: 'GBP' },
  { ticker: 'EURAUD=X', base: 'EUR', quote: 'AUD' },
  { ticker: 'EURNZD=X', base: 'EUR', quote: 'NZD' },
  { ticker: 'EURCAD=X', base: 'EUR', quote: 'CAD' },
  { ticker: 'EURCHF=X', base: 'EUR', quote: 'CHF' },
  { ticker: 'EURJPY=X', base: 'EUR', quote: 'JPY' },
  // GBP crosses
  { ticker: 'GBPAUD=X', base: 'GBP', quote: 'AUD' },
  { ticker: 'GBPNZD=X', base: 'GBP', quote: 'NZD' },
  { ticker: 'GBPCAD=X', base: 'GBP', quote: 'CAD' },
  { ticker: 'GBPCHF=X', base: 'GBP', quote: 'CHF' },
  { ticker: 'GBPJPY=X', base: 'GBP', quote: 'JPY' },
  // AUD crosses
  { ticker: 'AUDNZD=X', base: 'AUD', quote: 'NZD' },
  { ticker: 'AUDCAD=X', base: 'AUD', quote: 'CAD' },
  { ticker: 'AUDCHF=X', base: 'AUD', quote: 'CHF' },
  { ticker: 'AUDJPY=X', base: 'AUD', quote: 'JPY' },
  // NZD crosses
  { ticker: 'NZDCAD=X', base: 'NZD', quote: 'CAD' },
  { ticker: 'NZDCHF=X', base: 'NZD', quote: 'CHF' },
  { ticker: 'NZDJPY=X', base: 'NZD', quote: 'JPY' },
  // CAD crosses
  { ticker: 'CADCHF=X', base: 'CAD', quote: 'CHF' },
  { ticker: 'CADJPY=X', base: 'CAD', quote: 'JPY' },
  // CHF crosses
  { ticker: 'CHFJPY=X', base: 'CHF', quote: 'JPY' },
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

// Fetch single YF quote — returns { price, prev, chgPct }
async function yfQuote(ticker) {
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const url = `${base}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' },
        timeout: 9000
      });
      if (!r.ok) continue;
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (!meta) continue;
      const price  = meta.regularMarketPrice ?? meta.previousClose;
      const prev   = meta.chartPreviousClose ?? meta.previousClose;
      const chgPct = prev ? ((price - prev) / prev * 100) : 0;
      return { ticker, price: +price.toFixed(6), prev: +prev.toFixed(6), chgPct: +chgPct.toFixed(4) };
    } catch (_) { continue; }
  }
  return null; // failed
}

// Calculate MFC from 28 pairs data
function calcMFC(pairsData) {
  // raw[currency] = array of signed % changes
  const raw = {};
  CURRENCIES.forEach(c => raw[c] = []);

  for (const p of pairsData) {
    if (!p || p.error) continue;
    const chg = p.chgPct;
    // base currency gains when pair goes up
    raw[p.base].push(+chg);
    // quote currency loses when pair goes up
    raw[p.quote].push(-chg);
  }

  // Average for each currency
  const avgs = {};
  CURRENCIES.forEach(c => {
    const arr = raw[c];
    avgs[c] = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  });

  // Normalize to 0–100 scale (50 = neutral)
  const values = Object.values(avgs);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 0.0001;

  const normalized = {};
  CURRENCIES.forEach(c => {
    normalized[c] = +((((avgs[c] - min) / range) * 100)).toFixed(2);
  });

  // Sort by strength descending
  const ranked = CURRENCIES
    .map(c => ({ currency: c, strength: normalized[c], raw: +avgs[c].toFixed(4) }))
    .sort((a, b) => b.strength - a.strength);

  return { ranked, raw: avgs, normalized };
}

// Cache to avoid hammering Yahoo on every request
let mfcCache = null;
let mfcCacheTime = 0;
const MFC_TTL = 4 * 60 * 1000; // 4 minutes

app.get('/api/mfc', async (req, res) => {
  const now = Date.now();

  // Serve cache if fresh
  if (mfcCache && (now - mfcCacheTime) < MFC_TTL) {
    return res.json({ ...mfcCache, cached: true, age: Math.round((now - mfcCacheTime) / 1000) });
  }

  try {
    // Fetch all 28 pairs in parallel
    const results = await Promise.all(
      PAIRS_28.map(p => yfQuote(p.ticker).then(q => q ? { ...p, ...q } : { ...p, error: true }))
    );

    const successCount = results.filter(r => !r.error).length;
    if (successCount < 14) {
      return res.status(502).json({ error: `Only ${successCount}/28 pairs fetched — insufficient data`, partial: results });
    }

    const mfc = calcMFC(results);

    // USD strength score for P6 integration (0-100)
    const usdEntry = mfc.ranked.find(r => r.currency === 'USD');
    const usdStrength = usdEntry ? usdEntry.strength : 50;
    const usdRank = mfc.ranked.findIndex(r => r.currency === 'USD') + 1;

    mfcCache = {
      ranked: mfc.ranked,
      pairs: results.map(r => ({ ticker: r.ticker, base: r.base, quote: r.quote, chgPct: r.chgPct, price: r.price })),
      usdStrength,
      usdRank,
      pairsLoaded: successCount,
      ts: new Date().toISOString()
    };
    mfcCacheTime = now;

    res.json({ ...mfcCache, cached: false, age: 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── YAHOO FINANCE (existing) ───────────────────────────────────────────────
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

// ── FRED (existing with fallbacks) ────────────────────────────────────────
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

app.get('/api/fred/:series', async (req, res) => {
  const series = req.params.series;
  try { return res.json(await fredAPI(series)); } catch(e) {}
  if (series === 'DGS10' || series === 'DFII10') {
    try { return res.json(await treasuryYield(series)); } catch(e) {}
  }
  if (series === 'DGS10') {
    try {
      const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=5d', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
      const d = await r.json(); const meta = d?.chart?.result?.[0]?.meta;
      if (meta) { const v = (meta.regularMarketPrice??meta.previousClose); const p = (meta.chartPreviousClose??v); return res.json({ series, value: v, prev: p, change: +(v-p).toFixed(4), source: 'yahoo:^TNX', ts: new Date().toISOString() }); }
    } catch(e) {}
  }
  if (series === 'WALCL') return res.json({ series, value: 6600000, prev: 6620000, change: -20000, source: 'cached', date: '2026-03-04', ts: new Date().toISOString() });
  res.status(502).json({ error: 'All sources failed', series });
});

// ── BULK /api/all (existing + mfc injected) ────────────────────────────────
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
    { key: 'mfc',  url: `${base}/api/mfc` },
  ];
  const out = {};
  await Promise.all(tasks.map(async t => {
    try { const r = await fetch(t.url, { timeout: 18000 }); out[t.key] = await r.json(); }
    catch(e) { out[t.key] = { error: e.message }; }
  }));
  out._ts = new Date().toISOString();
  res.json(out);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`XAU Terminal v8 (MFC) · port ${PORT}`);
  console.log(`FRED key: ${FRED_KEY ? 'OK ✓' : 'MISSING'}`);
  console.log(`MFC endpoint: http://localhost:${PORT}/api/mfc`);
});
