const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const FRED_KEY = process.env.FRED_API_KEY || '';

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════════════════
// HEALTH
// ════════════════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), fred_key: FRED_KEY ? 'ok' : 'missing' });
});

// ════════════════════════════════════════════════════════════════════
// SHARED — 28 PAIRS
// ════════════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════════════
// YAHOO FINANCE — single quote
// ════════════════════════════════════════════════════════════════════
async function yfFetch(ticker, interval, range) {
  for (const base of ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']) {
    try {
      const url = `${base}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
      const r = await fetch(url, {
        headers: { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept':'application/json' },
        timeout: 11000
      });
      if (!r.ok) continue;
      const d = await r.json();
      const res = d?.chart?.result?.[0];
      if (!res) continue;
      return res;
    } catch (_) { continue; }
  }
  return null;
}

app.get('/api/yf/:symbol', async (req, res) => {
  const sym = req.params.symbol;
  const result = await yfFetch(sym, '1m', '1d');
  if (!result) return res.status(502).json({ error:'Yahoo Finance unreachable', symbol:sym });
  const meta = result.meta;
  const price  = meta.regularMarketPrice ?? meta.previousClose;
  const prev   = meta.chartPreviousClose ?? meta.previousClose;
  const chgPct = prev ? ((price-prev)/prev*100) : 0;
  res.json({ symbol:sym, price, prev, chgPct:+chgPct.toFixed(4), chgAbs:+(price-prev).toFixed(4), ts:new Date().toISOString() });
});

// ════════════════════════════════════════════════════════════════════
// FRED
// ════════════════════════════════════════════════════════════════════
async function fredAPI(series) {
  if (!FRED_KEY) throw new Error('NO_KEY');
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=5`;
  const r = await fetch(url, { headers:{'User-Agent':'XAU-Terminal/9','Accept':'application/json'}, timeout:12000 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  if (d.error_code) throw new Error(d.error_message);
  const obs = (d.observations||[]).filter(o=>o.value!=='.'&&o.value!=='ND');
  if (!obs.length) throw new Error('no data');
  const v=+parseFloat(obs[0].value).toFixed(4), p=obs[1]?+parseFloat(obs[1].value).toFixed(4):v;
  return { series, value:v, prev:p, change:+(v-p).toFixed(4), date:obs[0].date, source:'fred-api', ts:new Date().toISOString() };
}

async function treasuryYield(type) {
  const n=new Date(), ym=`${n.getFullYear()}${String(n.getMonth()+1).padStart(2,'0')}`;
  const url=`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${ym}`;
  const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'},timeout:12000});
  if (!r.ok) throw new Error(`Treasury HTTP ${r.status}`);
  const txt=await r.text();
  const tag=type==='DGS10'?'BC_10YEAR':'TC_10YEAR';
  const matches=[...txt.matchAll(new RegExp(`<${tag}>([\\d.]+)<\\/${tag}>`, 'g'))];
  if (!matches.length) throw new Error('tag not found');
  const vals=matches.map(m=>+parseFloat(m[1]).toFixed(4));
  const v=vals[vals.length-1], p=vals.length>1?vals[vals.length-2]:v;
  return { series:type, value:v/100, prev:p/100, change:+((v-p)/100).toFixed(4), source:'treasury.gov', ts:new Date().toISOString() };
}

app.get('/api/fred/:series', async (req,res) => {
  const series=req.params.series;
  try { return res.json(await fredAPI(series)); } catch(e) {}
  if (series==='DGS10'||series==='DFII10') { try { return res.json(await treasuryYield(series)); } catch(e) {} }
  if (series==='DGS10') {
    try {
      const result=await yfFetch('%5ETNX','1d','5d');
      if (result) { const m=result.meta; const v=m.regularMarketPrice??m.previousClose, p=m.chartPreviousClose??v; return res.json({series,value:v,prev:p,change:+(v-p).toFixed(4),source:'yahoo:^TNX',ts:new Date().toISOString()}); }
    } catch(e) {}
  }
  if (series==='WALCL') return res.json({series,value:6600000,prev:6620000,change:-20000,source:'cached',ts:new Date().toISOString()});
  res.status(502).json({error:'All sources failed',series});
});

// ════════════════════════════════════════════════════════════════════
// MFC — Currency Strength (% change method, for XAU terminal P6)
// ════════════════════════════════════════════════════════════════════
let mfcCache=null, mfcCacheTime=0;
const MFC_TTL=4*60*1000;

async function yfQuote(ticker) {
  const result=await yfFetch(ticker,'1m','1d');
  if (!result) return null;
  const meta=result.meta;
  const price=meta.regularMarketPrice??meta.previousClose;
  const prev=meta.chartPreviousClose??meta.previousClose;
  const chgPct=prev?((price-prev)/prev*100):0;
  return { ticker, price:+price.toFixed(6), prev:+prev.toFixed(6), chgPct:+chgPct.toFixed(4) };
}

app.get('/api/mfc', async (req,res) => {
  const now=Date.now();
  if (mfcCache&&(now-mfcCacheTime)<MFC_TTL) return res.json({...mfcCache,cached:true,age:Math.round((now-mfcCacheTime)/1000)});
  try {
    const results=await Promise.all(PAIRS_28.map(p=>yfQuote(p.ticker).then(q=>q?{...p,...q}:{...p,error:true})));
    const ok=results.filter(r=>!r.error).length;
    if (ok<14) return res.status(502).json({error:`Only ${ok}/28 pairs`,partial:results});
    const raw={};
    CURRENCIES.forEach(c=>raw[c]=[]);
    results.forEach(p=>{ if(p.error)return; raw[p.base].push(+p.chgPct); raw[p.quote].push(-p.chgPct); });
    const avgs={};
    CURRENCIES.forEach(c=>{ avgs[c]=raw[c].length?raw[c].reduce((a,b)=>a+b,0)/raw[c].length:0; });
    const vals=Object.values(avgs), mn=Math.min(...vals), mx=Math.max(...vals), rng=mx-mn||0.0001;
    const norm={};
    CURRENCIES.forEach(c=>{ norm[c]=+(((avgs[c]-mn)/rng)*100).toFixed(2); });
    const ranked=CURRENCIES.map(c=>({currency:c,strength:norm[c],raw:+avgs[c].toFixed(4)})).sort((a,b)=>b.strength-a.strength);
    const usdEntry=ranked.find(r=>r.currency==='USD');
    mfcCache={ ranked, pairs:results.map(r=>({ticker:r.ticker,base:r.base,quote:r.quote,chgPct:r.chgPct,price:r.price})), usdStrength:usdEntry?.strength??50, usdRank:ranked.findIndex(r=>r.currency==='USD')+1, pairsLoaded:ok, ts:new Date().toISOString() };
    mfcCacheTime=now;
    res.json({...mfcCache,cached:false,age:0});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ════════════════════════════════════════════════════════════════════
// CSS — Currency Slope Strength (TMA slope method, multi-TF)
// ════════════════════════════════════════════════════════════════════
const TF_CONFIG = {
  D1:  { interval:'1d',  range:'90d',  candles:20 },
  H4:  { interval:'1h',  range:'30d',  candles:96, resample:4 },
  H1:  { interval:'1h',  range:'7d',   candles:20 },
  M30: { interval:'30m', range:'5d',   candles:20 },
  M15: { interval:'15m', range:'2d',   candles:20 },
};

function tma(data, period) {
  const half=Math.ceil(period/2);
  function sma(arr,p){ return arr.map((_,i)=>i<p-1?null:arr.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p); }
  const s1=sma(data,half).filter(v=>v!==null);
  const s2=sma(s1,half);
  return [...Array(data.length-s2.length).fill(null),...s2];
}

function slopeLinReg(arr, n=5) {
  const valid=arr.filter(v=>v!==null);
  if (valid.length<n) return 0;
  const pts=valid.slice(-n);
  const xm=(n-1)/2, ym=pts.reduce((a,b)=>a+b,0)/n;
  let num=0,den=0;
  for(let i=0;i<n;i++){num+=(i-xm)*(pts[i]-ym);den+=(i-xm)**2;}
  return den===0?0:num/den;
}

function resample(closes, factor) {
  const out=[];
  for(let i=factor-1;i<closes.length;i+=factor) out.push(closes[i]);
  return out;
}

async function calcCSS_TF(tfKey) {
  const cfg=TF_CONFIG[tfKey];
  const TMA_P=14, SLOPE_N=5;
  const fetched=await Promise.all(PAIRS_28.map(async p=>{
    const result=await yfFetch(p.ticker,cfg.interval,cfg.range);
    if (!result) return {...p,slope:0,ok:false};
    let closes=(result.indicators?.quote?.[0]?.close||[]).filter(v=>v!=null);
    if (cfg.resample) closes=resample(closes,cfg.resample);
    closes=closes.slice(-(cfg.candles+TMA_P+10));
    if (closes.length<TMA_P) return {...p,slope:0,ok:false};
    const t=tma(closes,TMA_P);
    const s=slopeLinReg(t,SLOPE_N);
    const lastPrice=closes[closes.length-1]||1;
    return {...p,slope:+(s/lastPrice*10000).toFixed(6),ok:true};
  }));
  const str={},cnt={};
  CURRENCIES.forEach(c=>{str[c]=0;cnt[c]=0;});
  fetched.forEach(p=>{
    if(!p.ok)return;
    str[p.base]+=p.slope; cnt[p.base]++;
    str[p.quote]-=p.slope; cnt[p.quote]++;
  });
  const scores={};
  CURRENCIES.forEach(c=>{ scores[c]=cnt[c]>0?+(str[c]/cnt[c]).toFixed(6):0; });
  const ranked=CURRENCIES.map(c=>({currency:c,score:scores[c]})).sort((a,b)=>b.score-a.score);
  return { tf:tfKey, scores, ranked, pairsOk:fetched.filter(p=>p.ok).length, pairs:fetched.map(p=>({ticker:p.ticker,base:p.base,quote:p.quote,slope:p.slope,ok:p.ok})), ts:new Date().toISOString() };
}

const cssCache={};
const CSS_TTL={ D1:30*60*1000, H4:15*60*1000, H1:8*60*1000, M30:4*60*1000, M15:3*60*1000 };

async function getCSSCached(tf) {
  const now=Date.now();
  if (cssCache[tf]&&(now-cssCache[tf].time)<CSS_TTL[tf]) return {...cssCache[tf].data,cached:true,age:Math.round((now-cssCache[tf].time)/1000)};
  const data=await calcCSS_TF(tf);
  cssCache[tf]={data,time:now};
  return {...data,cached:false,age:0};
}

app.get('/api/css/:tf', async (req,res) => {
  const tf=req.params.tf.toUpperCase();
  if (!TF_CONFIG[tf]) return res.status(400).json({error:`Unknown TF. Valid: D1,H4,H1,M30,M15`});
  try { res.json(await getCSSCached(tf)); } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/css/all/multi', async (req,res) => {
  const tfs=['D1','H4','H1','M30','M15'];
  const result={};
  for (const tf of tfs) {
    try { result[tf]=await getCSSCached(tf); } catch(e) { result[tf]={error:e.message,tf}; }
    await new Promise(r=>setTimeout(r,300));
  }
  result._ts=new Date().toISOString();
  res.json(result);
});

// ════════════════════════════════════════════════════════════════════
// BULK /api/all  (XAU Terminal)
// ════════════════════════════════════════════════════════════════════
app.get('/api/all', async (req,res) => {
  const base=`http://localhost:${PORT}`;
  const tasks=[
    {key:'xau', url:`${base}/api/yf/GC%3DF`},
    {key:'dxy', url:`${base}/api/yf/DX-Y.NYB`},
    {key:'wti', url:`${base}/api/yf/CL%3DF`},
    {key:'eur', url:`${base}/api/yf/EURUSD%3DX`},
    {key:'ust', url:`${base}/api/fred/DGS10`},
    {key:'tips',url:`${base}/api/fred/DFII10`},
    {key:'fed', url:`${base}/api/fred/WALCL`},
    {key:'mfc', url:`${base}/api/mfc`},
  ];
  const out={};
  await Promise.all(tasks.map(async t=>{
    try{const r=await fetch(t.url,{timeout:18000});out[t.key]=await r.json();}
    catch(e){out[t.key]={error:e.message};}
  }));
  out._ts=new Date().toISOString();
  res.json(out);
});

// ════════════════════════════════════════════════════════════════════
// STATIC — serve index.html for all unknown routes
// ════════════════════════════════════════════════════════════════════
app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => {
  console.log(`XAU Terminal v9 (MFC + CSS) · port ${PORT}`);
  console.log(`  /              → XAU Terminal`);
  console.log(`  /css.html      → CSS Dashboard`);
  console.log(`  /api/css/M15   → CSS M15 data`);
  console.log(`  /api/css/all/multi → todos TFs`);
  console.log(`  /api/mfc       → MFC P6 data`);
  console.log(`  FRED key: ${FRED_KEY?'OK ✓':'MISSING'}`);
});
