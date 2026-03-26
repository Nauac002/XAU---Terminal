const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const FRED_KEY = process.env.FRED_API_KEY || '';

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ status:'ok', time:new Date().toISOString(), fred:FRED_KEY?'ok':'missing' }));

// ══════════════════════════════════════════════════════════
// 28 PAIRS + CONFIG
// ══════════════════════════════════════════════════════════
const PAIRS = [
  // Standard 28 forex pairs
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
  // XAU (Gold) vs major currencies — Wall Street Força Funds method
  {t:'XAUUSD=X',b:'XAU',q:'USD'},{t:'XAUEUR=X',b:'XAU',q:'EUR'},
  {t:'XAUGBP=X',b:'XAU',q:'GBP'},{t:'XAUJPY=X',b:'XAU',q:'JPY'},
  {t:'XAUCHF=X',b:'XAU',q:'CHF'},{t:'XAUCAD=X',b:'XAU',q:'CAD'},
  {t:'XAUAUD=X',b:'XAU',q:'AUD'},{t:'XAUNZD=X',b:'XAU',q:'NZD'},
];
const CURS = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];
// XAU is calculated separately using its own pairs
const CURS_WITH_XAU = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD','XAU'];

const TF_CFG = {
  D1:  { iv:'1d',  rng:'120d', pts:60 },
  H4:  { iv:'1h',  rng:'30d',  pts:60, rs:4 },
  H1:  { iv:'1h',  rng:'7d',   pts:60 },
  M30: { iv:'30m', rng:'5d',   pts:60 },
  M15: { iv:'15m', rng:'3d',   pts:60 },
};

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════
async function yfFetch(url) {
  for (const base of ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(base + url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 10000
      });
      if (r.ok) return r.json();
    } catch(_) {}
  }
  return null;
}

async function batchFetch(items, fn, size=6) {
  const out = [];
  for (let i=0; i<items.length; i+=size) {
    const batch = await Promise.all(items.slice(i,i+size).map(fn));
    out.push(...batch);
    if (i+size < items.length) await new Promise(r=>setTimeout(r,250));
  }
  return out;
}

function resampleH4(candles) {
  const out=[];
  for (let i=3; i<candles.length; i+=4) out.push(candles[i]);
  return out;
}

async function fetchCandles(ticker, interval, range) {
  const d = await yfFetch(`/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`);
  if (!d) return null;
  const res = d?.chart?.result?.[0];
  if (!res) return null;
  const closes = res.indicators?.quote?.[0]?.close || [];
  const timestamps = res.timestamp || [];
  const valid = [];
  for (let i=0; i<closes.length; i++) {
    if (closes[i]!=null && timestamps[i]!=null) valid.push({ c:closes[i], t:timestamps[i] });
  }
  return valid.length >= 8 ? valid : null;
}

// ══════════════════════════════════════════════════════════
// CSS — CURRENCY SLOPE STRENGTH
// ══════════════════════════════════════════════════════════
async function calcCSS(tfKey) {
  const cfg = TF_CFG[tfKey];
  const pairData = await batchFetch(PAIRS, async p => {
    let c = await fetchCandles(p.t, cfg.iv, cfg.rng);
    if (!c || c.length < 8) return { ...p, ok:false };
    if (cfg.rs) c = resampleH4(c);
    return { ...p, candles:c, ok:true };
  });

  const ok = pairData.filter(p => p.ok);
  // Separate forex pairs from XAU pairs
  const forexOk = ok.filter(p => p.b !== 'XAU' && p.q !== 'XAU');
  const xauOk   = ok.filter(p => p.b === 'XAU' || p.q === 'XAU');

  if (forexOk.length < 10) throw new Error(`Only ${forexOk.length}/28 forex pairs`);

  const minLen = Math.min(...ok.map(p=>p.candles.length));
  const trimTo = Math.min(minLen, cfg.pts+3);
  ok.forEach(p => { p.candles = p.candles.slice(-trimTo); });
  const N = ok[0].candles.length;

  ok.forEach(p => { const b0=p.candles[0].c||1; p.pct=p.candles.map(c=>((c.c-b0)/b0)*100); });

  // Calculate forex currency strength (8 currencies)
  const cnt={}; CURS.forEach(c=>cnt[c]=0);
  forexOk.forEach(p => { cnt[p.b]++; cnt[p.q]++; });

  const raw={}; CURS_WITH_XAU.forEach(c=>raw[c]=new Array(N).fill(0));
  for (let i=0; i<N; i++) {
    const s={}; CURS_WITH_XAU.forEach(c=>s[c]=0);
    forexOk.forEach(p => { s[p.b]+=p.pct[i]; s[p.q]-=p.pct[i]; });
    CURS.forEach(c => { raw[c][i] = cnt[c]>0 ? s[c]/cnt[c] : 0; });

    // XAU strength: average of XAU vs all currencies
    if (xauOk.length > 0) {
      let xauSum=0, xauCnt=0;
      xauOk.forEach(p => {
        if (p.b==='XAU') { xauSum+=p.pct[i]; xauCnt++; }
        else             { xauSum-=p.pct[i]; xauCnt++; }
      });
      raw['XAU'][i] = xauCnt>0 ? xauSum/xauCnt : 0;
    }
  }

  const labels = (ok[0]||forexOk[0]).candles.map(c => {
    const d = new Date(c.t*1000);
    if (tfKey==='D1') return `${d.getDate()}/${d.getMonth()+1}`;
    const hh=String(d.getHours()).padStart(2,'0'), mm=String(d.getMinutes()).padStart(2,'0');
    if (tfKey==='H4'||tfKey==='H1') return `${d.getDate()}/${d.getMonth()+1} ${hh}:${mm}`;
    return `${hh}:${mm}`;
  });

  const allCurs = xauOk.length>0 ? CURS_WITH_XAU : CURS;
  const scores={}; allCurs.forEach(c => { scores[c]=+raw[c][N-1].toFixed(5); });
  const ranked=allCurs.map(c=>({currency:c,score:scores[c]})).sort((a,b)=>b.score-a.score);

  return {
    tf:tfKey, labels,
    series: Object.fromEntries(Object.entries(raw).filter(([k])=>raw[k].some(v=>v!==0))),
    scores, ranked,
    pairsOk:ok.length, xauPairs:xauOk.length, points:N,
    pairs:ok.map(p=>({ticker:p.t,base:p.b,quote:p.q,score:+p.pct[N-1].toFixed(5),ok:true})),
    ts:new Date().toISOString()
  };
}

const cssCache={}, cssTTL={D1:45*60e3,H4:20*60e3,H1:10*60e3,M30:6*60e3,M15:4*60e3};
const cssInFlight={};

async function getCSS(tf) {
  const now=Date.now();
  if (cssCache[tf] && (now-cssCache[tf].ts)<cssTTL[tf]) return {...cssCache[tf].data, cached:true};
  if (cssInFlight[tf]) return cssInFlight[tf].then(()=>cssCache[tf]?{...cssCache[tf].data,cached:true}:{error:'failed'});
  cssInFlight[tf] = calcCSS(tf)
    .then(d=>{ cssCache[tf]={data:d,ts:Date.now()}; delete cssInFlight[tf]; return d; })
    .catch(e=>{ delete cssInFlight[tf]; throw e; });
  return {...(await cssInFlight[tf]), cached:false};
}

app.get('/api/css/warmup', (req,res) => {
  res.json({ok:true});
  (async()=>{ for(const tf of ['M15','M30','H1','H4','D1']){ try{if(!cssCache[tf])await getCSS(tf);}catch(e){} await new Promise(r=>setTimeout(r,500)); } })();
});

app.get('/api/css/:tf', async (req,res) => {
  const tf=req.params.tf.toUpperCase();
  if (!TF_CFG[tf]) return res.status(400).json({error:'Unknown TF'});
  try { res.json(await getCSS(tf)); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// ══════════════════════════════════════════════════════════
// MFC — FORÇA DE MOEDAS (28 pares, metodologia Mataf)
// ══════════════════════════════════════════════════════════
async function yfQuote(ticker) {
  const d = await yfFetch(`/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`);
  if (!d) return null;
  const meta = d?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const price=meta.regularMarketPrice??meta.previousClose;
  const prev=meta.chartPreviousClose??price;
  return {ticker, price:+price.toFixed(6), prev:+prev.toFixed(6), chgPct:+((price-prev)/(prev||1)*100).toFixed(4)};
}

let mfcCache=null, mfcCacheTs=0;

app.get('/api/mfc', async (req,res) => {
  const now=Date.now();
  if (mfcCache && (now-mfcCacheTs)<4*60e3) return res.json({...mfcCache,cached:true});
  try {
    const results = await batchFetch(PAIRS, async p => {
      const q = await yfQuote(p.t);
      return q ? {...p,...q,ok:true} : {...p,ok:false};
    });
    const good=results.filter(r=>r.ok);
    if (good.length<14) return res.status(502).json({error:`Only ${good.length}/28`});
    const raw={}; CURS.forEach(c=>raw[c]=[]);
    good.forEach(p=>{ raw[p.b].push(+p.chgPct); raw[p.q].push(-p.chgPct); });
    const avgs={}; CURS.forEach(c=>{ avgs[c]=raw[c].length?raw[c].reduce((a,b)=>a+b,0)/raw[c].length:0; });
    const vals=Object.values(avgs), mn=Math.min(...vals), mx=Math.max(...vals), rng=mx-mn||0.0001;
    const norm={}; CURS.forEach(c=>{ norm[c]=+(((avgs[c]-mn)/rng)*100).toFixed(2); });
    const ranked=CURS.map(c=>({currency:c,strength:norm[c],raw:+avgs[c].toFixed(4)})).sort((a,b)=>b.strength-a.strength);
    const usdE=ranked.find(r=>r.currency==='USD');
    mfcCache={ranked, usdStrength:usdE?.strength??50, usdRank:ranked.findIndex(r=>r.currency==='USD')+1,
              pairs:good.map(r=>({ticker:r.t,base:r.b,quote:r.q,chgPct:r.chgPct,price:r.price})),
              pairsLoaded:good.length, ts:new Date().toISOString()};
    mfcCacheTs=now;
    res.json({...mfcCache,cached:false});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ══════════════════════════════════════════════════════════
// YAHOO FINANCE — quotes
// ══════════════════════════════════════════════════════════
app.get('/api/yf/:symbol', async (req,res) => {
  const q=await yfQuote(req.params.symbol);
  if (!q) return res.status(502).json({error:'Yahoo unavailable'});
  res.json({symbol:req.params.symbol,...q,ts:new Date().toISOString()});
});

// ══════════════════════════════════════════════════════════
// FRED — yields & FED balance
// ══════════════════════════════════════════════════════════
async function fredAPI(series) {
  if (!FRED_KEY) throw new Error('NO_KEY');
  const r=await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=5`,
    {headers:{'User-Agent':'XAU-Terminal','Accept':'application/json'},timeout:12000});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d=await r.json();
  if (d.error_code) throw new Error(d.error_message);
  const obs=(d.observations||[]).filter(o=>o.value!=='.'&&o.value!=='ND');
  if (!obs.length) throw new Error('no data');
  const v=+parseFloat(obs[0].value).toFixed(4), p=obs[1]?+parseFloat(obs[1].value).toFixed(4):v;
  return {series,value:v,prev:p,change:+(v-p).toFixed(4),date:obs[0].date,source:'fred',ts:new Date().toISOString()};
}

async function treasuryYield(type) {
  const n=new Date(), ym=`${n.getFullYear()}${String(n.getMonth()+1).padStart(2,'0')}`;
  const r=await fetch(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${ym}`,
    {headers:{'User-Agent':'Mozilla/5.0'},timeout:12000});
  if (!r.ok) throw new Error(`Treasury ${r.status}`);
  const txt=await r.text();
  const tag=type==='DGS10'?'BC_10YEAR':'TC_10YEAR';
  const matches=[...txt.matchAll(new RegExp(`<${tag}>([\\d.]+)<\\/${tag}>`, 'g'))];
  if (!matches.length) throw new Error('tag not found');
  const vals=matches.map(m=>+parseFloat(m[1]).toFixed(4));
  const v=vals[vals.length-1], p=vals.length>1?vals[vals.length-2]:v;
  return {series:type,value:v/100,prev:p/100,change:+((v-p)/100).toFixed(4),source:'treasury',ts:new Date().toISOString()};
}

app.get('/api/fred/:series', async (req,res) => {
  const s=req.params.series;
  try { return res.json(await fredAPI(s)); } catch(e) {}
  if (s==='DGS10'||s==='DFII10') {
    try { return res.json(await treasuryYield(s)); } catch(e) {}
  }
  if (s==='WALCL') return res.json({series:s,value:6600000,prev:6620000,change:-20000,source:'cached',ts:new Date().toISOString()});
  res.status(502).json({error:'All sources failed',series:s});
});

// ══════════════════════════════════════════════════════════
// BULK /api/all
// ══════════════════════════════════════════════════════════
app.get('/api/all', async (req,res) => {
  const base=`http://localhost:${PORT}`;
  const tasks=[
    {key:'xau',url:`${base}/api/yf/GC%3DF`},
    {key:'dxy',url:`${base}/api/yf/DX-Y.NYB`},
    {key:'wti',url:`${base}/api/yf/CL%3DF`},
    {key:'eur',url:`${base}/api/yf/EURUSD%3DX`},
    {key:'ust',url:`${base}/api/fred/DGS10`},
    {key:'tips',url:`${base}/api/fred/DFII10`},
    {key:'fed',url:`${base}/api/fred/WALCL`},
    {key:'mfc',url:`${base}/api/mfc`},
  ];
  const out={};
  await Promise.all(tasks.map(async t=>{
    try{const r=await fetch(t.url,{timeout:18000});out[t.key]=await r.json();}
    catch(e){out[t.key]={error:e.message};}
  }));
  out._ts=new Date().toISOString();
  res.json(out);
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => {
  console.log(`XAU Terminal v8+CSS · port ${PORT}`);
  console.log(`FRED: ${FRED_KEY?'OK':'missing (usando fallback Treasury)'}`);
  console.log(`Endpoints: /health /api/all /api/mfc /api/css/M15 /api/css/warmup`);
});
