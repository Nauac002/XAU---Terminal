const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── KEEP-ALIVE endpoint (UptimeRobot pings this) ───────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), service: 'XAU Terminal' });
});

// ─── YAHOO FINANCE proxy ─────────────────────────────────────────
// Server-side fetch: no CORS, no geo-blocks, direct access
app.get('/api/yf/:symbol', async (req, res) => {
  const sym = req.params.symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      },
      timeout: 10000
    });
    if (!r.ok) throw new Error(`YF HTTP ${r.status}`);
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error('No meta in YF response');

    const price   = meta.regularMarketPrice ?? meta.previousClose;
    const prev    = meta.chartPreviousClose ?? meta.previousClose;
    const chgPct  = prev ? ((price - prev) / prev * 100) : 0;
    const chgAbs  = price - prev;

    res.json({
      symbol:   sym,
      price:    price,
      prev:     prev,
      chgPct:   parseFloat(chgPct.toFixed(4)),
      chgAbs:   parseFloat(chgAbs.toFixed(4)),
      currency: meta.currency || 'USD',
      name:     meta.longName || meta.shortName || sym,
      ts:       new Date().toISOString()
    });
  } catch (e) {
    // fallback: try v7 endpoint
    try {
      const url2 = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
      const r2 = await fetch(url2, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
      const d2 = await r2.json();
      const meta2 = d2?.chart?.result?.[0]?.meta;
      if (!meta2) throw new Error('No meta v2');
      const price2  = meta2.regularMarketPrice ?? meta2.previousClose;
      const prev2   = meta2.chartPreviousClose ?? meta2.previousClose;
      const chgPct2 = prev2 ? ((price2 - prev2) / prev2 * 100) : 0;
      res.json({ symbol: sym, price: price2, prev: prev2, chgPct: parseFloat(chgPct2.toFixed(4)), chgAbs: parseFloat((price2-prev2).toFixed(4)), ts: new Date().toISOString() });
    } catch (e2) {
      res.status(502).json({ error: e.message, fallbackError: e2.message, symbol: sym });
    }
  }
});

// ─── FRED proxy ──────────────────────────────────────────────────
app.get('/api/fred/:series', async (req, res) => {
  const series = req.params.series;
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/csv' },
      timeout: 12000
    });
    if (!r.ok) throw new Error(`FRED HTTP ${r.status}`);
    const txt = await r.text();
    const lines = txt.trim().split('\n').filter(l => l && !l.startsWith('DATE') && !l.startsWith('"'));
    if (!lines.length) throw new Error('Empty CSV');
    const last    = lines[lines.length - 1];
    const parts   = last.split(',');
    const dateStr = parts[0];
    const val     = parseFloat(parts[1]);
    if (isNaN(val)) throw new Error('NaN value');

    // Also get penultimate for change
    const prev = lines.length >= 2 ? parseFloat(lines[lines.length - 2].split(',')[1]) : val;
    const chg  = parseFloat((val - prev).toFixed(4));

    res.json({ series, value: val, prev, change: chg, date: dateStr, ts: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: e.message, series });
  }
});

// ─── BULK endpoint — fetch all market data in one request ────────
app.get('/api/all', async (req, res) => {
  const symbols = [
    { key: 'xau',  type: 'yf',   sym: 'GC=F'      },
    { key: 'dxy',  type: 'yf',   sym: 'DX-Y.NYB'  },
    { key: 'wti',  type: 'yf',   sym: 'CL=F'      },
    { key: 'eur',  type: 'yf',   sym: 'EURUSD=X'  },
    { key: 'ust',  type: 'fred', sym: 'DGS10'     },
    { key: 'tips', type: 'fred', sym: 'DFII10'    },
    { key: 'fed',  type: 'fred', sym: 'WALCL'     },
  ];

  const results = {};
  await Promise.all(symbols.map(async item => {
    try {
      let url;
      if (item.type === 'yf') {
        url = `http://localhost:${PORT}/api/yf/${encodeURIComponent(item.sym)}`;
      } else {
        url = `http://localhost:${PORT}/api/fred/${item.sym}`;
      }
      const r = await fetch(url, { timeout: 12000 });
      results[item.key] = await r.json();
    } catch (e) {
      results[item.key] = { error: e.message };
    }
  }));

  results._ts = new Date().toISOString();
  results._source = 'XAU Terminal Server (direct fetch, no proxy)';
  res.json(results);
});

// ─── Serve frontend for all other routes ────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`XAU Terminal running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Market data:  http://localhost:${PORT}/api/all`);
});
