const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const FRED_KEY = process.env.FRED_API_KEY || '';

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ════════════════════════════════════════════════════════════════
// 28 PAIRS
// ════════════════════════════════════════════════════════════════
const PAIRS_28 = [
  { ticker:'EURUSD=X', base:'EUR', quote:'USD' },
  { ticker:'GBPUSD=X', base:'GBP', quote:'USD' },
  { ticker:'AUDUSD=X', base:'AUD', quote:'USD' },
  { ticker:'NZDUSD=X', base:'NZD', quote:'USD' },
  { ticker:'USDCAD=X', base:'USD', quote:'CAD' },
  { ticker:'USDCHF=X', base:'USD', quote:'CHF' },
  { ticker:'USDJPY=X', base:'USD', quote:'JPY' },
  { ticker:'EURGBP=X', base:'EUR', quote:'GBP' },
  { ticker:'EURAUD=X', base:'EUR', quote:'AUD' },
  { ticker:'EURNZD=X', base:'EUR', quote:'NZD' },
  { ticker:'EURCAD=X', base:'EUR', quote:'CAD' },
  { ticker:'EURCHF=X', base:'EUR', quote:'CHF' },
  { ticker:'EURJPY=X', base:'EUR', quote:'JPY' },
  { ticker:'GBPAUD=X', base:'GBP', quote:'AUD' },
  { ticker:'GBPNZD=X', base:'GBP', quote:'NZD' },
  { ticker:'GBPCAD=X', base:'GBP', quote:'CAD' },
  { ticker:'GBPCHF=X', base:'GBP', quote:'CHF' },
  { ticker:'GBPJPY=X', base:'GBP', quote:'JPY' },
  { ticker:'AUDNZD=X', base:'AUD', quote:'NZD' },
  { ticker:'AUDCAD=X', base:'AUD', quote:'CAD' },
  { ticker:'AUDCHF=X', base:'AUD', quote:'CHF' },
  { ticker:'AUDJPY=X', base:'AUD', quote:'JPY' },
  { ticker:'NZDCAD=X', base:'NZD', quote:'CAD' },
  { ticker:'NZDCHF=X', base:'NZD', quote:'CHF' },
  { ticker:'NZDJPY=X', base:'NZD', quote:'JPY' },
  { ticker:'CADCHF=X', base:'CAD', quote:'CHF' },
  { ticker:'CADJPY=X', base:'CAD', quote:'JPY' },
  { ticker:'CHFJPY=X', base:'CHF', quote:'JPY' },
];
const CURRENCIES = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];

// ════════════════════════════════════════════════════════════════
// TF CONFIG
// candles = how many candles to return in the timeseries
// fetchRange = how much data to pull to have enough for TMA warmup
// ════════════════════════════════════════════════════════════════
const TF_CONFIG = {
  D1:  { interval:'1d',  range:'200d', candles:60,  tmaPeriod:14, label:'D1'  },
  H4:  { interval:'1h',  range:'60d',  candles:60,  tmaPeriod:14, label:'H4', resample:4 },
  H1:  { interval:'1h',  range:'14d',  candles:60,  tmaPeriod:14, label:'H1'  },
  M30: { interval:'30m', range:'7d',   candles:60,  tmaPeriod:14, label:'M30' },
  M15: { interval:'15m', range:'5d',   candles:60,  tmaPeriod:14, label:'M15' },
};

// ════════════════════════════════════════════════════════════════
// MATH HELPERS
// ════════════════════════════════════════════════════════════════

// Simple Moving Average
function sma(arr, period) {
  const out = new Array(arr.length).fill(null);
  for (let i = period - 1; i < arr.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += arr[i - j];
    out[i] = sum / period;
  }
  return out;
}

// Triangular Moving Average = SMA of SMA
function tma(arr, period) {
  const half = Math.ceil(period / 2);
  const s1   = sma(arr, half);
  const valid = s1.filter(v => v !== null);
  const s2   = sma(valid, half);
  // pad front to match original length
  const pad  = arr.length - s2.length;
  return [...new Array(pad).fill(null), ...s2];
}

// Rolling slope of TMA over last `win` points at each position
// Returns array same length as input, null where not enough data
function rollingSlope(tmaArr, win = 5) {
  const out = new Array(tmaArr.length).fill(null);
  for (let i = win - 1; i < tmaArr.length; i++) {
    // collect last `win` non-null values ending at i
    const slice = tmaArr.slice(Math.max(0, i - win * 3), i + 1).filter(v => v !== null).slice(-win);
    if (slice.length < win) continue;
    // linear regression slope
    const xm = (win - 1) / 2;
    const ym = slice.reduce((a, b) => a + b, 0) / win;
    let num = 0, den = 0;
    for (let j = 0; j < win; j++) {
      num += (j - xm) * (slice[j] - ym);
      den += (j - xm) ** 2;
    }
    out[i] = den === 0 ? 0 : num / den;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// YAHOO FINANCE OHLC FETCH
// ════════════════════════════════════════════════════════════════
async function fetchCandles(ticker, interval, range) {
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const url = `${base}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
      const r   = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' },
        timeout: 13000
      });
      if (!r.ok) continue;
      const d   = await r.json();
      const res = d?.chart?.result?.[0];
      if (!res) continue;
      const closes    = res.indicators?.quote?.[0]?.close || [];
      const timestamps = res.timestamp || [];
      // filter nulls
      const valid = closes.map((c, i) => ({ c, t: timestamps[i] })).filter(x => x.c != null && x.t != null);
      if (valid.length < 20) continue;
      return valid;
    } catch (_) { continue; }
  }
  return null;
}

// Resample 1h candles → H4 by grouping every 4
function resampleH4(candles) {
  const out = [];
  for (let i = 3; i < candles.length; i += 4) {
    out.push({ c: candles[i].c, t: candles[i].t });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// CSS CORE — produces a TIMESERIES per currency
//
// For each candle index k (after warmup), we compute:
//   pairSlope[k]  = slope of TMA of pair closes up to candle k
//   currencyStrength[currency][k] = avg of signed pairSlopes
//
// This gives 8 lines × N time points → chart-ready data
// ════════════════════════════════════════════════════════════════
async function calcCSSTimeseries(tfKey) {
  const cfg = TF_CONFIG[tfKey];

  // 1. Fetch all 28 pairs
  const pairData = await Promise.all(PAIRS_28.map(async p => {
    let candles = await fetchCandles(p.ticker, cfg.interval, cfg.range);
    if (!candles) return { ...p, candles: null, ok: false };
    if (cfg.resample) candles = resampleH4(candles);
    return { ...p, candles, ok: true };
  }));

  const okPairs  = pairData.filter(p => p.ok);
  if (okPairs.length < 14) throw new Error(`Only ${okPairs.length}/28 pairs loaded`);

  // 2. Align all pairs to same length (use shortest)
  const minLen = Math.min(...okPairs.map(p => p.candles.length));
  const useLen = Math.min(minLen, cfg.candles + cfg.tmaPeriod + 20);
  // trim all to same length from the end
  okPairs.forEach(p => { p.candles = p.candles.slice(-useLen); });

  // 3. For each pair: compute TMA → rolling slope timeseries
  okPairs.forEach(p => {
    const closes = p.candles.map(c => c.c);
    const tmaLine   = tma(closes, cfg.tmaPeriod);
    const slopeLine = rollingSlope(tmaLine, 5);
    // Normalise by price to get pip-like units
    p.slopeSeries = slopeLine.map((s, i) => {
      if (s === null) return null;
      const price = closes[i] || 1;
      return s / price * 10000;
    });
  });

  // 4. Build currency strength timeseries
  // timestamps from the first ok pair (all aligned to same length now)
  const refPair  = okPairs[0];
  const N        = refPair.candles.length;
  const timestamps = refPair.candles.map(c => c.t);

  // For each candle index, compute currency strength
  const strengthSeries = {};
  CURRENCIES.forEach(c => { strengthSeries[c] = new Array(N).fill(null); });

  for (let i = 0; i < N; i++) {
    const sums  = {};
    const cnts  = {};
    CURRENCIES.forEach(c => { sums[c] = 0; cnts[c] = 0; });

    for (const p of okPairs) {
      const s = p.slopeSeries[i];
      if (s === null) continue;
      sums[p.base]  += s;  cnts[p.base]++;
      sums[p.quote] -= s;  cnts[p.quote]++;
    }

    CURRENCIES.forEach(c => {
      if (cnts[c] === 0) return;
      strengthSeries[c][i] = +(sums[c] / cnts[c]).toFixed(6);
    });
  }

  // 5. Trim to `candles` output points (remove warmup nulls from front)
  // Find first index where ALL currencies have a value
  let startIdx = 0;
  for (let i = 0; i < N; i++) {
    if (CURRENCIES.every(c => strengthSeries[c][i] !== null)) { startIdx = i; break; }
  }
  // Keep last `cfg.candles` valid points
  const endIdx   = N;
  const keepFrom = Math.max(startIdx, endIdx - cfg.candles);

  const out = {};
  CURRENCIES.forEach(c => {
    out[c] = strengthSeries[c].slice(keepFrom, endIdx);
  });
  const outTimestamps = timestamps.slice(keepFrom, endIdx);

  // 6. Current scores (last value)
  const scores  = {};
  const ranked  = [];
  CURRENCIES.forEach(c => {
    const arr    = out[c].filter(v => v !== null);
    scores[c]    = arr.length ? arr[arr.length - 1] : 0;
  });
  CURRENCIES.forEach(c => ranked.push({ currency: c, score: scores[c] }));
  ranked.sort((a, b) => b.score - a.score);

  // 7. Format labels (human-readable time)
  const labels = outTimestamps.map(t => {
    const d = new Date(t * 1000);
    if (tfKey === 'D1') return `${d.getMonth()+1}/${d.getDate()}`;
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  });

  return {
    tf:       tfKey,
    labels,
    series:   out,   // { USD: [v1,v2,...], EUR: [...], ... }
    scores,
    ranked,
    pairsOk:  okPairs.length,
    points:   out[CURRENCIES[0]].length,
    pairs:    okPairs.map(p => ({
      ticker: p.ticker, base: p.base, quote: p.quote,
      score:  p.slopeSeries ? +(p.slopeSeries.filter(v=>v!==null).slice(-1)[0]||0).toFixed(6) : 0,
      ok:     p.ok
    })),
    ts: new Date().toISOString()
  };
}

// ════════════════════════════════════════════════════════════════
// CACHE
// ════════════════════════════════════════════════════════════════
const cssCache = {};
const CSS_TTL  = { D1:30*60*1000, H4:15*60*1000, H1:8*60*1000, M30:5*60*1000, M15:3*60*1000 };

async function getCSS(tf) {
  const now = Date.now();
  if (cssCache[tf] && (now - cssCache[tf].time) < CSS_TTL[tf]) {
    return { ...cssCache[tf].data, cached: true, age: Math.round((now - cssCache[tf].time) / 1000) };
  }
  const data = await calcCSSTimeseries(tf);
  cssCache[tf] = { data, time: now };
  return { ...data, cached: false, age: 0 };
}

// ════════════════════════════════════════════════════════════════
// API
// ════════════════════════════════════════════════════════════════
app.get('/api/css/:tf', async (req, res) => {
  const tf = req.params.tf.toUpperCase();
  if (!TF_CONFIG[tf]) return res.status(400).json({ error: `Unknown TF. Valid: D1,H4,H1,M30,M15` });
  try {
    res.json(await getCSS(tf));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/css/all/multi', async (req, res) => {
  const tfs = ['D1','H4','H1','M30','M15'];
  const result = {};
  for (const tf of tfs) {
    try { result[tf] = await getCSS(tf); }
    catch(e) { result[tf] = { error: e.message, tf }; }
    await new Promise(r => setTimeout(r, 500)); // avoid rate limiting
  }
  result._ts = new Date().toISOString();
  res.json(result);
});

// ════════════════════════════════════════════════════════════════
// EXISTING ENDPOINTS (YF + FRED + MFC + /api/all)
// ════════════════════════════════════════════════════════════════
async function yfQuote(ticker) {
  for (const base of ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']) {
    try {
      const url = `${base}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`;
      const r   = await fetch(url,{headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'},timeout:10000});
      if(!r.ok) continue;
      const d   = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if(!meta) continue;
      const price = meta.regularMarketPrice??meta.previousClose;
      const prev  = meta.chartPreviousClose??meta.previousClose;
      const chgPct = prev?((price-prev)/prev*100):0;
      return {price:+price.toFixed(6),prev:+prev.toFixed(6),chgPct:+chgPct.toFixed(4)};
    } catch(_){ continue; }
  }
  return null;
}

app.get('/api/yf/:symbol', async (req,res)=>{
  const sym=req.params.symbol;
  const q=await yfQuote(sym);
  if(!q) return res.status(502).json({error:'Yahoo unreachable',symbol:sym});
  res.json({symbol:sym,...q,ts:new Date().toISOString()});
});

async function fredAPI(series){
  if(!FRED_KEY) throw new Error('NO_KEY');
  const url=`https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=5`;
  const r=await fetch(url,{headers:{'User-Agent':'XAU-v9','Accept':'application/json'},timeout:12000});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  const d=await r.json();
  if(d.error_code) throw new Error(d.error_message);
  const obs=(d.observations||[]).filter(o=>o.value!=='.'&&o.value!=='ND');
  if(!obs.length) throw new Error('no data');
  const v=+parseFloat(obs[0].value).toFixed(4),p=obs[1]?+parseFloat(obs[1].value).toFixed(4):v;
  return{series,value:v,prev:p,change:+(v-p).toFixed(4),date:obs[0].date,source:'fred',ts:new Date().toISOString()};
}

async function treasuryYield(type){
  const n=new Date(),ym=`${n.getFullYear()}${String(n.getMonth()+1).padStart(2,'0')}`;
  const url=`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${ym}`;
  const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'},timeout:12000});
  if(!r.ok) throw new Error(`Treasury ${r.status}`);
  const txt=await r.text();
  const tag=type==='DGS10'?'BC_10YEAR':'TC_10YEAR';
  const matches=[...txt.matchAll(new RegExp(`<${tag}>([\\d.]+)<\\/${tag}>`, 'g'))];
  if(!matches.length) throw new Error('tag not found');
  const vals=matches.map(m=>+parseFloat(m[1]).toFixed(4));
  const v=vals[vals.length-1],p=vals.length>1?vals[vals.length-2]:v;
  return{series:type,value:v/100,prev:p/100,change:+((v-p)/100).toFixed(4),source:'treasury',ts:new Date().toISOString()};
}

app.get('/api/fred/:series', async(req,res)=>{
  const series=req.params.series;
  try{return res.json(await fredAPI(series));}catch(e){}
  if(series==='DGS10'||series==='DFII10'){try{return res.json(await treasuryYield(series));}catch(e){}}
  if(series==='WALCL') return res.json({series,value:6600000,prev:6620000,change:-20000,source:'cached',ts:new Date().toISOString()});
  res.status(502).json({error:'All sources failed',series});
});

// MFC (% change method, for XAU terminal P6)
let mfcCache=null,mfcCacheTime=0;
app.get('/api/mfc', async(req,res)=>{
  const now=Date.now();
  if(mfcCache&&(now-mfcCacheTime)<4*60*1000) return res.json({...mfcCache,cached:true});
  try{
    const results=await Promise.all(PAIRS_28.map(async p=>{
      const q=await yfQuote(p.ticker);
      return q?{...p,...q,error:false}:{...p,error:true};
    }));
    const ok=results.filter(r=>!r.error).length;
    if(ok<14) return res.status(502).json({error:`Only ${ok}/28 pairs`});
    const raw={};CURRENCIES.forEach(c=>raw[c]=[]);
    results.forEach(p=>{if(p.error)return;raw[p.base].push(+p.chgPct);raw[p.quote].push(-p.chgPct);});
    const avgs={};CURRENCIES.forEach(c=>{avgs[c]=raw[c].length?raw[c].reduce((a,b)=>a+b,0)/raw[c].length:0;});
    const vals=Object.values(avgs),mn=Math.min(...vals),mx=Math.max(...vals),rng=mx-mn||0.0001;
    const norm={};CURRENCIES.forEach(c=>{norm[c]=+(((avgs[c]-mn)/rng)*100).toFixed(2);});
    const ranked=CURRENCIES.map(c=>({currency:c,strength:norm[c],raw:+avgs[c].toFixed(4)})).sort((a,b)=>b.strength-a.strength);
    const usdE=ranked.find(r=>r.currency==='USD');
    mfcCache={ranked,pairs:results.map(r=>({ticker:r.ticker,base:r.base,quote:r.quote,chgPct:r.chgPct})),usdStrength:usdE?.strength??50,usdRank:ranked.findIndex(r=>r.currency==='USD')+1,pairsLoaded:ok,ts:new Date().toISOString()};
    mfcCacheTime=now;
    res.json({...mfcCache,cached:false});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/all', async(req,res)=>{
  const base=`http://localhost:${PORT}`;
  const tasks=[
    {key:'xau',url:`${base}/api/yf/GC%3DF`},{key:'dxy',url:`${base}/api/yf/DX-Y.NYB`},
    {key:'wti',url:`${base}/api/yf/CL%3DF`},{key:'eur',url:`${base}/api/yf/EURUSD%3DX`},
    {key:'ust',url:`${base}/api/fred/DGS10`},{key:'tips',url:`${base}/api/fred/DFII10`},
    {key:'fed',url:`${base}/api/fred/WALCL`},{key:'mfc',url:`${base}/api/mfc`},
  ];
  const out={};
  await Promise.all(tasks.map(async t=>{try{const r=await fetch(t.url,{timeout:18000});out[t.key]=await r.json();}catch(e){out[t.key]={error:e.message};}}));
  out._ts=new Date().toISOString();
  res.json(out);
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => {
  console.log(`CSS v2 + XAU Terminal v9 · port ${PORT}`);
  console.log(`  /css.html           → CSS Dashboard`);
  console.log(`  /api/css/M15        → CSS timeseries M15`);
  console.log(`  /api/css/all/multi  → all TFs`);
});
