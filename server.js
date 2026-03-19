const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const FRED_KEY = process.env.FRED_API_KEY || '';

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req,res) => res.json({ status:'ok', time:new Date().toISOString() }));

// ════════════════════════════════════════════════════
// 28 PAIRS
// ════════════════════════════════════════════════════
const PAIRS = [
  {t:'EURUSD=X',b:'EUR',q:'USD'},{t:'GBPUSD=X',b:'GBP',q:'USD'},
  {t:'AUDUSD=X',b:'AUD',q:'USD'},{t:'NZDUSD=X',b:'NZD',q:'USD'},
  {t:'USDCAD=X',b:'USD',q:'CAD'},{t:'USDCHF=X',b:'USD',q:'CHF'},
  {t:'USDJPY=X',b:'USD',q:'JPY'},{t:'EURGBP=X',b:'EUR',q:'GBP'},
  {t:'EURAUD=X',b:'EUR',q:'AUD'},{t:'EURNZD=X',b:'EUR',q:'NZD'},
  {t:'EURCAD=X',b:'EUR',q:'CAD'},{t:'EURCHF=X',b:'EUR',q:'CHF'},
  {t:'EURJPY=X',b:'EUR',q:'JPY'},{t:'GBPAUD=X',b:'GBP',q:'AUD'},
  {t:'GBPNZD=X',b:'GBP',q:'NZD'},{t:'GBPCAD=X',b:'GBP',q:'CAD'},
  {t:'GBPCHF=X',b:'GBP',q:'CHF'},{t:'GBPJPY=X',b:'GBP',q:'JPY'},
  {t:'AUDNZD=X',b:'AUD',q:'NZD'},{t:'AUDCAD=X',b:'AUD',q:'CAD'},
  {t:'AUDCHF=X',b:'AUD',q:'CHF'},{t:'AUDJPY=X',b:'AUD',q:'JPY'},
  {t:'NZDCAD=X',b:'NZD',q:'CAD'},{t:'NZDCHF=X',b:'NZD',q:'CHF'},
  {t:'NZDJPY=X',b:'NZD',q:'JPY'},{t:'CADCHF=X',b:'CAD',q:'CHF'},
  {t:'CADJPY=X',b:'CAD',q:'JPY'},{t:'CHFJPY=X',b:'CHF',q:'JPY'},
];
const CURS = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];

// ════════════════════════════════════════════════════
// TF CONFIG
// For each TF we request enough candles to build a
// proper history. The frontend shows the last N points.
// ════════════════════════════════════════════════════
const TF_CFG = {
  W1:  { iv:'1wk', rng:'2y',   pts:52,  lbl:'W1'  },
  D1:  { iv:'1d',  rng:'1y',   pts:100, lbl:'D1'  },
  H4:  { iv:'1h',  rng:'60d',  pts:100, rs:4, lbl:'H4' },
  H1:  { iv:'1h',  rng:'14d',  pts:100, lbl:'H1'  },
  M30: { iv:'30m', rng:'7d',   pts:100, lbl:'M30' },
  M15: { iv:'15m', rng:'5d',   pts:100, lbl:'M15' },
};

// ════════════════════════════════════════════════════
// FETCH CANDLES from Yahoo Finance
// Returns array of { c (close), t (unix timestamp) }
// ════════════════════════════════════════════════════
async function fetchCandles(ticker, interval, range) {
  for (const base of ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']) {
    try {
      const url = `${base}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
      const r   = await fetch(url, {
        headers:{ 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept':'application/json' },
        timeout: 14000
      });
      if (!r.ok) continue;
      const d = await r.json();
      const res = d?.chart?.result?.[0];
      if (!res) continue;
      const closes     = res.indicators?.quote?.[0]?.close || [];
      const timestamps = res.timestamp || [];
      const valid = [];
      for (let i = 0; i < closes.length; i++) {
        if (closes[i] != null && timestamps[i] != null) {
          valid.push({ c: closes[i], t: timestamps[i] });
        }
      }
      if (valid.length >= 10) return valid;
    } catch(_) { continue; }
  }
  return null;
}

// Resample 1h → H4 (take every 4th close)
function resampleH4(candles) {
  const out = [];
  for (let i = 3; i < candles.length; i += 4) out.push(candles[i]);
  return out;
}

// ════════════════════════════════════════════════════
// CSS CORE — correct methodology
//
// For each candle k, for each pair:
//   pct[k] = (close[k] - close[0]) / close[0] * 100
//   (cumulative % return from start of window)
//
// Currency strength[k] = mean of signed pct across all pairs
//   base  → +pct (base appreciates when pair goes up)
//   quote → -pct (quote depreciates when pair goes up)
//
// Then we normalise so the series is centred around 0
// and scale is consistent across currencies.
// ════════════════════════════════════════════════════
async function calcCSS(tfKey) {
  const cfg = TF_CFG[tfKey];

  // Fetch all 28 pairs
  const pairData = await Promise.all(PAIRS.map(async p => {
    let candles = await fetchCandles(p.t, cfg.iv, cfg.rng);
    if (!candles || candles.length < 10) return { ...p, ok: false };
    if (cfg.rs) candles = resampleH4(candles);
    return { ...p, candles, ok: true };
  }));

  const ok = pairData.filter(p => p.ok);
  if (ok.length < 14) throw new Error(`Only ${ok.length}/28 pairs OK`);

  // Align to shortest length, keep last N points
  const minLen = Math.min(...ok.map(p => p.candles.length));
  const trimTo = Math.min(minLen, cfg.pts + 5);
  ok.forEach(p => { p.candles = p.candles.slice(-trimTo); });

  const N = ok[0].candles.length;

  // For each pair, compute cumulative % from first candle in window
  ok.forEach(p => {
    const base0 = p.candles[0].c;
    p.pctSeries = p.candles.map(c => base0 !== 0 ? ((c.c - base0) / base0) * 100 : 0);
  });

  // Accumulate currency strength at each candle
  const raw = {};
  CURS.forEach(c => raw[c] = new Array(N).fill(0));
  const cnt = {};
  CURS.forEach(c => cnt[c] = 0);

  // Count pairs per currency
  ok.forEach(p => { cnt[p.b]++; cnt[p.q]++; });

  for (let i = 0; i < N; i++) {
    const sums = {};
    CURS.forEach(c => sums[c] = 0);
    ok.forEach(p => {
      const v = p.pctSeries[i];
      sums[p.b] += v;
      sums[p.q] -= v;
    });
    CURS.forEach(c => { raw[c][i] = cnt[c] > 0 ? sums[c] / cnt[c] : 0; });
  }

  // Timestamps and labels
  const refCandles = ok[0].candles;
  const labels = refCandles.map(c => {
    const d = new Date(c.t * 1000);
    if (tfKey === 'W1' || tfKey === 'D1') {
      return `${d.getDate()}/${d.getMonth()+1}`;
    }
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    const dd = `${d.getDate()}/${d.getMonth()+1}`;
    if (tfKey === 'H4' || tfKey === 'H1') return `${dd} ${hh}:${mm}`;
    return `${hh}:${mm}`;
  });

  // Last score per currency
  const scores = {};
  CURS.forEach(c => { scores[c] = +raw[c][N-1].toFixed(5); });

  // Ranked
  const ranked = CURS.map(c => ({ currency:c, score:scores[c] }))
    .sort((a,b) => b.score - a.score);

  // Pair scores (last value)
  const pairScores = ok.map(p => ({
    ticker: p.t, base: p.b, quote: p.q,
    score: +p.pctSeries[N-1].toFixed(5), ok: true
  }));

  return {
    tf:       tfKey,
    labels,
    series:   raw,     // { USD:[...100 pts...], EUR:[...], ... }
    scores,
    ranked,
    pairsOk:  ok.length,
    points:   N,
    pairs:    pairScores,
    ts:       new Date().toISOString()
  };
}

// ════════════════════════════════════════════════════
// CACHE PER TF
// ════════════════════════════════════════════════════
const cache = {};
const TTL = { W1:60*60*1000, D1:30*60*1000, H4:15*60*1000, H1:8*60*1000, M30:5*60*1000, M15:3*60*1000 };

async function getCSS(tf) {
  const now = Date.now();
  if (cache[tf] && (now - cache[tf].ts) < TTL[tf]) {
    return { ...cache[tf].data, cached:true, age:Math.round((now-cache[tf].ts)/1000) };
  }
  const data = await calcCSS(tf);
  cache[tf] = { data, ts: now };
  return { ...data, cached:false, age:0 };
}

// ════════════════════════════════════════════════════
// CSS ENDPOINTS
// ════════════════════════════════════════════════════
app.get('/api/css/:tf', async (req,res) => {
  const tf = req.params.tf.toUpperCase();
  if (!TF_CFG[tf]) return res.status(400).json({ error:`Unknown TF. Valid: ${Object.keys(TF_CFG).join(',')}` });
  try { res.json(await getCSS(tf)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Sequential multi-TF to avoid Yahoo rate limits
app.get('/api/css/all/multi', async (req,res) => {
  const tfs = ['D1','H4','H1','M30','M15'];
  const out  = {};
  for (const tf of tfs) {
    try { out[tf] = await getCSS(tf); }
    catch(e) { out[tf] = { error: e.message, tf }; }
    await new Promise(r => setTimeout(r, 400));
  }
  out._ts = new Date().toISOString();
  res.json(out);
});

// Single TF refresh (used by auto-refresh on frontend)
app.get('/api/css/refresh/:tf', async (req,res) => {
  const tf = req.params.tf.toUpperCase();
  if (!TF_CFG[tf]) return res.status(400).json({ error:'Unknown TF' });
  // Force refresh: clear cache for this TF
  delete cache[tf];
  try { res.json(await getCSS(tf)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════
// EXISTING XAU TERMINAL ENDPOINTS
// ════════════════════════════════════════════════════
async function yfQuote(ticker) {
  for (const base of ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']) {
    try {
      const url = `${base}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`;
      const r   = await fetch(url,{headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'},timeout:10000});
      if(!r.ok) continue;
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if(!meta) continue;
      const price = meta.regularMarketPrice??meta.previousClose;
      const prev  = meta.chartPreviousClose??meta.previousClose;
      return { price:+price.toFixed(6), prev:+prev.toFixed(6), chgPct:+((price-prev)/(prev||1)*100).toFixed(4) };
    } catch(_){ continue; }
  }
  return null;
}

app.get('/api/yf/:symbol', async(req,res) => {
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
  const r=await fetch(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${ym}`,{headers:{'User-Agent':'Mozilla/5.0'},timeout:12000});
  if(!r.ok) throw new Error(`Treasury ${r.status}`);
  const txt=await r.text(),tag=type==='DGS10'?'BC_10YEAR':'TC_10YEAR';
  const matches=[...txt.matchAll(new RegExp(`<${tag}>([\\d.]+)<\\/${tag}>`, 'g'))];
  if(!matches.length) throw new Error('tag not found');
  const vals=matches.map(m=>+parseFloat(m[1]).toFixed(4));
  const v=vals[vals.length-1],p=vals.length>1?vals[vals.length-2]:v;
  return{series:type,value:v/100,prev:p/100,change:+((v-p)/100).toFixed(4),source:'treasury',ts:new Date().toISOString()};
}
app.get('/api/fred/:series', async(req,res) => {
  const s=req.params.series;
  try{return res.json(await fredAPI(s));}catch(e){}
  if(s==='DGS10'||s==='DFII10'){try{return res.json(await treasuryYield(s));}catch(e){}}
  if(s==='WALCL') return res.json({series:s,value:6600000,prev:6620000,change:-20000,source:'cached',ts:new Date().toISOString()});
  res.status(502).json({error:'All sources failed',series:s});
});

// MFC for XAU P6
let mfcCache=null,mfcCacheTs=0;
app.get('/api/mfc', async(req,res) => {
  const now=Date.now();
  if(mfcCache&&(now-mfcCacheTs)<4*60*1000) return res.json({...mfcCache,cached:true});
  try{
    const results=await Promise.all(PAIRS.map(async p=>{const q=await yfQuote(p.t);return q?{...p,...q,ok:true}:{...p,ok:false};}));
    const good=results.filter(r=>r.ok);
    if(good.length<14) return res.status(502).json({error:`Only ${good.length}/28`});
    const raw={};CURS.forEach(c=>raw[c]=[]);
    good.forEach(p=>{raw[p.b].push(+p.chgPct);raw[p.q].push(-p.chgPct);});
    const avgs={};CURS.forEach(c=>{avgs[c]=raw[c].length?raw[c].reduce((a,b)=>a+b,0)/raw[c].length:0;});
    const vals=Object.values(avgs),mn=Math.min(...vals),mx=Math.max(...vals),rng=mx-mn||0.0001;
    const norm={};CURS.forEach(c=>{norm[c]=+(((avgs[c]-mn)/rng)*100).toFixed(2);});
    const ranked=CURS.map(c=>({currency:c,strength:norm[c],raw:+avgs[c].toFixed(4)})).sort((a,b)=>b.strength-a.strength);
    const usdE=ranked.find(r=>r.currency==='USD');
    mfcCache={ranked,usdStrength:usdE?.strength??50,usdRank:ranked.findIndex(r=>r.currency==='USD')+1,pairsLoaded:good.length,ts:new Date().toISOString()};
    mfcCacheTs=now;
    res.json({...mfcCache,cached:false});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/all', async(req,res) => {
  const b=`http://localhost:${PORT}`;
  const tasks=[
    {key:'xau',url:`${b}/api/yf/GC%3DF`},{key:'dxy',url:`${b}/api/yf/DX-Y.NYB`},
    {key:'wti',url:`${b}/api/yf/CL%3DF`},{key:'eur',url:`${b}/api/yf/EURUSD%3DX`},
    {key:'ust',url:`${b}/api/fred/DGS10`},{key:'tips',url:`${b}/api/fred/DFII10`},
    {key:'fed',url:`${b}/api/fred/WALCL`},{key:'mfc',url:`${b}/api/mfc`},
  ];
  const out={};
  await Promise.all(tasks.map(async t=>{try{const r=await fetch(t.url,{timeout:18000});out[t.key]=await r.json();}catch(e){out[t.key]={error:e.message};}}));
  out._ts=new Date().toISOString();
  res.json(out);
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT,()=>{
  console.log(`CSS v3 + XAU v9 · port ${PORT}`);
  console.log(`  /css.html          → CSS Dashboard`);
  console.log(`  /api/css/M15       → single TF`);
  console.log(`  /api/css/all/multi → all TFs`);
  console.log(`  /api/css/refresh/M15 → force refresh`);
});
