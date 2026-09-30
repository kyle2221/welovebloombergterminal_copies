// Market data layer shared by server.js (local) and api/[name].js (Vercel).
// Fetches real data from Yahoo Finance, the US Treasury and public RSS feeds.
'use strict';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const Y1 = 'https://query1.finance.yahoo.com';
const Y2 = 'https://query2.finance.yahoo.com';

// ---------------------------------------------------------------- caching
const cache = new Map();
const inflight = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const v = await fn();
      cache.set(key, { t: Date.now(), v });
      return v;
    } catch (e) {
      if (hit) return hit.v; // serve stale data rather than failing
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.t > 6 * 3600e3) cache.delete(k);
}, 600e3).unref?.();

async function get(url, headers = {}, timeoutMs = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- Yahoo auth (cookie + crumb)
let auth = null;
let authP = null;
function cookiesFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(/,(?=\s*[A-Za-z0-9_]+=)/);
  return list.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}
function getAuth(force) {
  if (auth && !force) return Promise.resolve(auth);
  if (authP) return authP;
  authP = (async () => {
    let cookie = '';
    for (const u of ['https://fc.yahoo.com/', 'https://finance.yahoo.com/']) {
      try {
        const r = await fetch(u, { headers: { 'User-Agent': UA }, redirect: 'manual' });
        cookie = cookiesFrom(r);
        if (cookie) break;
      } catch { /* try next */ }
    }
    for (const base of [Y2, Y1]) {
      const r = await get(base + '/v1/test/getcrumb', { Cookie: cookie });
      const crumb = (await r.text()).trim();
      if (r.ok && crumb && !crumb.includes('<') && crumb.length < 40) {
        auth = { cookie, crumb };
        return auth;
      }
    }
    throw new Error('Could not obtain Yahoo Finance crumb');
  })().finally(() => { authP = null; });
  return authP;
}

async function yahoo(pathAndQuery, needCrumb = false) {
  let a = needCrumb ? await getAuth() : null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const url = Y1 + pathAndQuery + (a ? sep + 'crumb=' + encodeURIComponent(a.crumb) : '');
    const r = await get(url, { Accept: 'application/json', ...(a ? { Cookie: a.cookie } : {}) });
    if ((r.status === 401 || r.status === 403) && needCrumb && attempt === 0) {
      a = await getAuth(true);
      continue;
    }
    if (!r.ok) {
      let msg = '';
      try { const j = await r.json(); msg = j?.finance?.error?.description || j?.chart?.error?.description || ''; } catch { }
      const err = new Error(`Yahoo ${r.status}${msg ? ': ' + msg : ''}`);
      err.status = r.status === 404 ? 404 : 502;
      throw err;
    }
    return r.json();
  }
}

// ---------------------------------------------------------------- quotes
const num = v => (v && typeof v === 'object' && 'raw' in v ? v.raw : v);
function mapQuote(q) {
  const price = num(q.regularMarketPrice);
  const prev = num(q.regularMarketPreviousClose);
  return {
    sym: q.symbol,
    name: q.longName || q.shortName || q.symbol,
    short: q.shortName || q.longName || q.symbol,
    type: q.quoteType,
    exch: q.fullExchangeName || q.exchange,
    ccy: q.currency,
    state: q.marketState,
    price,
    chg: num(q.regularMarketChange) ?? (price != null && prev != null ? price - prev : null),
    pct: num(q.regularMarketChangePercent) ?? (price != null && prev ? (price / prev - 1) * 100 : null),
    prev,
    open: num(q.regularMarketOpen),
    high: num(q.regularMarketDayHigh),
    low: num(q.regularMarketDayLow),
    vol: num(q.regularMarketVolume),
    time: num(q.regularMarketTime),
    bid: num(q.bid) || null,
    ask: num(q.ask) || null,
    bsz: num(q.bidSize) || null,
    asz: num(q.askSize) || null,
    mcap: num(q.marketCap) ?? null,
    pe: num(q.trailingPE) ?? null,
    fpe: num(q.forwardPE) ?? null,
    eps: num(q.epsTrailingTwelveMonths) ?? null,
    dy: num(q.dividendYield) ?? (num(q.trailingAnnualDividendYield) != null ? num(q.trailingAnnualDividendYield) * 100 : null),
    h52: num(q.fiftyTwoWeekHigh) ?? null,
    l52: num(q.fiftyTwoWeekLow) ?? null,
    avgVol: num(q.averageDailyVolume3Month) ?? null,
    shares: num(q.sharesOutstanding) ?? null,
    ma50: num(q.fiftyDayAverage) ?? null,
    ma200: num(q.twoHundredDayAverage) ?? null,
    pre: num(q.preMarketPrice) ?? null,
    prePct: num(q.preMarketChangePercent) ?? null,
    post: num(q.postMarketPrice) ?? null,
    postPct: num(q.postMarketChangePercent) ?? null,
  };
}

async function quoteViaChart(sym) {
  const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`);
  const r = j?.chart?.result?.[0];
  if (!r) return null;
  const m = r.meta;
  const q = r.indicators?.quote?.[0] || {};
  const prev = m.previousClose ?? m.chartPreviousClose;
  const opens = (q.open || []).filter(v => v != null);
  return {
    sym, name: m.longName || m.shortName || sym, short: m.shortName || sym, type: m.instrumentType,
    exch: m.fullExchangeName || m.exchangeName, ccy: m.currency, state: null,
    price: m.regularMarketPrice, prev,
    chg: m.regularMarketPrice - prev, pct: prev ? (m.regularMarketPrice / prev - 1) * 100 : null,
    open: opens[0] ?? null, high: m.regularMarketDayHigh, low: m.regularMarketDayLow,
    vol: m.regularMarketVolume, time: m.regularMarketTime,
    h52: m.fiftyTwoWeekHigh ?? null, l52: m.fiftyTwoWeekLow ?? null,
  };
}

const qcache = new Map();
async function quotes(symbols) {
  const out = {};
  const need = [];
  for (const s of symbols) {
    const c = qcache.get(s);
    if (c && Date.now() - c.t < 3000) out[s] = c.v; else need.push(s);
  }
  for (let i = 0; i < need.length; i += 50) {
    const chunk = need.slice(i, i + 50);
    let got = null;
    try {
      const j = await yahoo('/v7/finance/quote?symbols=' + encodeURIComponent(chunk.join(',')), true);
      got = j?.quoteResponse?.result || [];
      for (const raw of got) {
        const q = mapQuote(raw);
        // Yahoo may normalise case; key by the symbol the client asked for
        const asked = chunk.find(s => s.toUpperCase() === String(raw.symbol).toUpperCase()) || raw.symbol;
        q.sym = asked;
        qcache.set(asked, { t: Date.now(), v: q });
        out[asked] = q;
      }
    } catch (e) {
      console.warn('[quotes] v7 failed, falling back to chart API:', e.message);
    }
    const missing = chunk.filter(s => !out[s]);
    if (missing.length && !got) {
      await Promise.all(missing.map(async s => {
        try {
          const q = await quoteViaChart(s);
          if (q) { qcache.set(s, { t: Date.now(), v: q }); out[s] = q; }
        } catch { /* unknown symbol */ }
      }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- charts
const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', 'ytd', '1y', '2y', '5y', '10y', 'max']);
const INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']);
async function chart(sym, range, interval) {
  if (!RANGES.has(range)) range = '1y';
  if (!INTERVALS.has(interval)) interval = '1d';
  const ttl = /m$|h$/.test(interval) ? 30e3 : 300e3;
  return cached(`chart:${sym}:${range}:${interval}`, ttl, async () => {
    const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&events=div%2Csplit&includePrePost=false`);
    const r = j?.chart?.result?.[0];
    if (!r) { const e = new Error('No chart data'); e.status = 404; throw e; }
    const q = r.indicators?.quote?.[0] || {};
    const adj = r.indicators?.adjclose?.[0]?.adjclose;
    const t = r.timestamp || [];
    const keep = t.map((_, i) => q.close?.[i] != null);
    const pick = a => (a || []).filter((_, i) => keep[i]);
    const divs = Object.values(r.events?.dividends || {}).map(d => ({ date: d.date, amount: d.amount })).sort((a, b) => b.date - a.date);
    const splits = Object.values(r.events?.splits || {}).map(s => ({ date: s.date, ratio: s.splitRatio || `${s.numerator}:${s.denominator}` }));
    const m = r.meta || {};
    return {
      meta: {
        sym: m.symbol, ccy: m.currency, exch: m.fullExchangeName || m.exchangeName, type: m.instrumentType,
        tz: m.exchangeTimezoneName, gmtoffset: m.gmtoffset || 0, price: m.regularMarketPrice,
        prev: m.chartPreviousClose ?? m.previousClose, name: m.longName || m.shortName,
      },
      t: pick(t), o: pick(q.open), h: pick(q.high), l: pick(q.low), c: pick(q.close), v: pick(q.volume),
      adj: adj ? pick(adj) : null, divs, splits,
    };
  });
}

// ---------------------------------------------------------------- fundamentals / analysts
const SUMMARY_MODULES = 'assetProfile,summaryDetail,defaultKeyStatistics,financialData,calendarEvents,recommendationTrend,upgradeDowngradeHistory,price,summaryProfile,fundProfile';
async function summary(sym) {
  return cached('summary:' + sym, 600e3, async () => {
    const j = await yahoo(`/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${SUMMARY_MODULES}`, true);
    const r = j?.quoteSummary?.result?.[0];
    if (!r) { const e = new Error('No summary data'); e.status = 404; throw e; }
    return r;
  });
}

const FIN_TYPES = ['TotalRevenue', 'GrossProfit', 'OperatingIncome', 'EBITDA', 'NetIncome', 'DilutedEPS', 'FreeCashFlow',
  'OperatingCashFlow', 'CapitalExpenditure', 'TotalDebt', 'CashAndCashEquivalents', 'StockholdersEquity', 'TotalAssets', 'DilutedAverageShares'];
async function financials(sym) {
  return cached('fin:' + sym, 3600e3, async () => {
    const types = [];
    for (const p of ['annual', 'quarterly']) for (const t of FIN_TYPES) types.push(p + t);
    const p2 = Math.floor(Date.now() / 1000);
    const j = await yahoo(`/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${types.join(',')}&period1=1262304000&period2=${p2}`);
    const out = { annual: {}, quarterly: {} };
    for (const series of j?.timeseries?.result || []) {
      const type = series?.meta?.type?.[0];
      if (!type) continue;
      const period = type.startsWith('annual') ? 'annual' : 'quarterly';
      const key = type.replace(/^(annual|quarterly)/, '');
      out[period][key] = (series[type] || []).filter(Boolean).map(x => ({ d: x.asOfDate, v: x.reportedValue?.raw ?? null }));
    }
    return out;
  });
}

async function screener(id, count) {
  const safe = String(id).replace(/[^a-z_]/gi, '');
  return cached(`scr:${safe}:${count}`, 60e3, async () => {
    const j = await yahoo(`/v1/finance/screener/predefined/saved?scrIds=${safe}&count=${count}`, true);
    const r = j?.finance?.result?.[0];
    if (!r) throw new Error('No screener data');
    return { title: r.title, desc: r.description, quotes: (r.quotes || []).map(mapQuote) };
  });
}

async function search(q, newsCount = 0, quotesCount = 12) {
  return cached(`search:${q}:${newsCount}:${quotesCount}`, 60e3, async () => {
    const j = await yahoo(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=${quotesCount}&newsCount=${newsCount}&enableFuzzyQuery=false&listsCount=0`);
    return {
      quotes: (j.quotes || []).filter(x => x.symbol).map(x => ({
        sym: x.symbol, name: x.longname || x.shortname || x.symbol, exch: x.exchDisp || x.exchange, type: x.typeDisp || x.quoteType,
        sector: x.sector || x.sectorDisp || '', industry: x.industry || x.industryDisp || '',
      })),
      news: (j.news || []).map(n => ({ title: n.title, link: n.link, src: n.publisher, t: n.providerPublishTime, tickers: n.relatedTickers || [] })),
    };
  });
}

// ---------------------------------------------------------------- US Treasury par yield curve
const UST_COLS = ['1 Mo', '2 Mo', '3 Mo', '4 Mo', '6 Mo', '1 Yr', '2 Yr', '3 Yr', '5 Yr', '7 Yr', '10 Yr', '20 Yr', '30 Yr'];
function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
async function treasuryYear(year) {
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
  const r = await get(url, { Accept: 'text/csv' }, 20000);
  if (!r.ok) throw new Error('Treasury ' + r.status);
  const lines = (await r.text()).trim().split(/\r?\n/);
  const head = parseCsvLine(lines.shift()).map(h => h.trim());
  const idx = UST_COLS.map(c => head.indexOf(c));
  return lines.map(l => {
    const f = parseCsvLine(l);
    const [m, d, y] = f[0].split('/');
    return { date: `${y}-${m}-${d}`, v: idx.map(i => (i >= 0 && f[i] !== '' ? Number(f[i]) : null)) };
  });
}
async function treasury() {
  return cached('ust', 3600e3, async () => {
    const y = new Date().getUTCFullYear();
    const [a, b] = await Promise.allSettled([treasuryYear(y), treasuryYear(y - 1)]);
    const rows = [...(a.value || []), ...(b.value || [])].filter(r => r.v.some(x => x != null));
    if (!rows.length) throw new Error('Treasury data unavailable');
    rows.sort((p, q) => (p.date < q.date ? 1 : -1));
    return { cols: UST_COLS, rows };
  });
}

// ---------------------------------------------------------------- RSS news
const FEEDS = [
  ['YAHOO', 'https://finance.yahoo.com/news/rssindex'],
  ['CNBC', 'https://www.cnbc.com/id/100003114/device/rss/rss.html'],
  ['CNBC', 'https://www.cnbc.com/id/10000664/device/rss/rss.html'],
  ['MW', 'https://feeds.content.dowjones.io/public/rss/mw_topstories'],
  ['MW', 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse'],
  ['FED', 'https://www.federalreserve.gov/feeds/press_all.xml'],
  ['SEC', 'https://www.sec.gov/news/pressreleases.rss'],
];
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ').trim();
}
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')); return m ? decode(m[1]) : ''; };
async function feed(src, url) {
  return cached('feed:' + url, 120e3, async () => {
    const r = await get(url, { Accept: 'application/rss+xml, application/xml, text/xml' });
    if (!r.ok) throw new Error(src + ' ' + r.status);
    const xml = await r.text();
    return (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).map(it => {
      const date = tag(it, 'pubDate') || tag(it, 'dc:date');
      return { src, title: tag(it, 'title'), link: tag(it, 'link') || tag(it, 'guid'), t: Math.floor((Date.parse(date) || Date.now()) / 1000), desc: tag(it, 'description').slice(0, 400) };
    }).filter(x => x.title);
  });
}
async function topNews() {
  const res = await Promise.allSettled(FEEDS.map(([s, u]) => feed(s, u)));
  const seen = new Set();
  return res.flatMap(r => r.value || [])
    .filter(n => { const k = n.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.t - a.t)
    .slice(0, 150);
}

// ---------------------------------------------------------------- http
// ---------------------------------------------------------------- geo helpers
function param(p, k, lo, hi) {
  const v = Number(p.get(k));
  if (p.get(k) == null || !Number.isFinite(v) || v < lo || v > hi) { const e = new Error(`invalid ?${k}=`); e.status = 400; throw e; }
  return v;
}
function bboxOf(p) {
  const s = param(p, 's', -90, 90), n = param(p, 'n', -90, 90), w = param(p, 'w', -540, 540), e = param(p, 'e', -540, 540);
  if (n <= s || e <= w) { const err = new Error('invalid bbox'); err.status = 400; throw err; }
  return { s, w, n, e };
}
// Round a bbox outwards to a grid so nearby map views share a cache entry
const snap = (b, g) => ({ s: Math.max(-90, Math.floor(b.s / g) * g), w: Math.floor(b.w / g) * g, n: Math.min(90, Math.ceil(b.n / g) * g), e: Math.ceil(b.e / g) * g });

// ---------------------------------------------------------------- flights (live ADS-B)
function mapAircraft(a) {
  const gnd = a.alt_baro === 'ground';
  return {
    hex: a.hex, cs: (a.flight || '').trim(), reg: a.r || '', type: a.t || '', desc: a.desc || '', op: a.ownOp || '',
    lat: a.lat, lon: a.lon, alt: gnd ? 0 : (typeof a.alt_baro === 'number' ? a.alt_baro : a.alt_geom ?? null), gnd,
    gs: a.gs ?? null, trk: a.track ?? a.true_heading ?? null, vr: a.baro_rate ?? a.geom_rate ?? null,
    sq: a.squawk || '', mil: !!(a.dbFlags & 1),
  };
}
async function flights(p) {
  const lat = Math.round(param(p, 'lat', -90, 90) * 10) / 10;
  const lon = Math.round(param(p, 'lon', -180, 180) * 10) / 10;
  const r = Math.round(Math.min(250, Math.max(10, Number(p.get('r')) || 150)) / 10) * 10;
  return cached(`fl:${lat}:${lon}:${r}`, 10e3, async () => {
    const errs = [];
    for (const [src, url] of [['adsb.lol', `https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`], ['airplanes.live', `https://api.airplanes.live/v2/point/${lat}/${lon}/${r}`]]) {
      try {
        const res = await get(url, { Accept: 'application/json' });
        if (!res.ok) throw new Error(`${src} ${res.status}`);
        const j = await res.json();
        return { src, t: j.now || Date.now(), ac: (j.ac || j.aircraft || []).filter(a => a.lat != null && a.lon != null).map(mapAircraft) };
      } catch (e) { errs.push(e.message); }
    }
    try { // OpenSky Network (anonymous, bounding box)
      const dlat = r / 60, dlon = r / (60 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
      const res = await get(`https://opensky-network.org/api/states/all?lamin=${lat - dlat}&lomin=${lon - dlon}&lamax=${lat + dlat}&lomax=${lon + dlon}`, { Accept: 'application/json' });
      if (!res.ok) throw new Error('opensky ' + res.status);
      const j = await res.json();
      return {
        src: 'opensky', t: (j.time || 0) * 1000, ac: (j.states || []).filter(s => s[5] != null && s[6] != null).map(s => ({
          hex: s[0], cs: (s[1] || '').trim(), reg: '', type: '', desc: '', op: s[2] || '', lat: s[6], lon: s[5],
          alt: s[8] ? 0 : s[7] != null ? Math.round(s[7] * 3.28084) : null, gnd: !!s[8], gs: s[9] != null ? Math.round(s[9] * 1.94384) : null,
          trk: s[10], vr: s[11] != null ? Math.round(s[11] * 196.85) : null, sq: s[14] || '', mil: false,
        })),
      };
    } catch (e) { errs.push(e.message); }
    throw new Error('Flight data unavailable: ' + errs.join('; '));
  });
}

// ---------------------------------------------------------------- ships (live AIS)
// Global coverage via aisstream.io (free key, AISSTREAM_API_KEY). Without a key, Finland's open
// Digitraffic AIS feed (no key, Baltic Sea coverage) is used.
const aisKey = () => process.env.AISSTREAM_API_KEY || '';
const aisGlobal = () => !!aisKey() && typeof WebSocket !== 'undefined';
function aisstream(b) {
  return new Promise((resolve, reject) => {
    const ships = new Map();
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    ws.binaryType = 'arraybuffer';
    let err = null;
    const finish = () => {
      clearTimeout(timer);
      try { ws.close(); } catch { }
      if (err && !ships.size) reject(new Error('aisstream: ' + err)); else resolve([...ships.values()].filter(s => s.lat != null));
    };
    const timer = setTimeout(finish, 7000);
    ws.onopen = () => ws.send(JSON.stringify({
      APIKey: aisKey(), BoundingBoxes: [[[b.s, b.w], [b.n, b.e]]],
      FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData'],
    }));
    ws.onerror = () => { err = err || 'connection error'; finish(); };
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); } catch { return; }
      if (m.error) { err = m.error; return finish(); }
      const md = m.MetaData || {}, mmsi = md.MMSI;
      if (!mmsi) return;
      const s = ships.get(mmsi) || { mmsi, name: '', type: null, lat: null, lon: null, sog: null, cog: null, hdg: null, dest: '', draught: null, nav: null, t: null };
      if (md.ShipName) s.name = md.ShipName.trim();
      const pr = m.Message?.PositionReport || m.Message?.StandardClassBPositionReport;
      if (pr) {
        s.lat = pr.Latitude ?? md.latitude; s.lon = pr.Longitude ?? md.longitude; s.sog = pr.Sog; s.cog = pr.Cog;
        s.hdg = pr.TrueHeading === 511 ? null : pr.TrueHeading; s.nav = pr.NavigationalStatus ?? null; s.t = Date.parse(md.time_utc) || Date.now();
      }
      const sd = m.Message?.ShipStaticData;
      if (sd) { s.type = sd.Type ?? s.type; s.dest = (sd.Destination || '').trim(); s.draught = sd.MaximumStaticDraught || null; if (sd.Name) s.name = sd.Name.trim(); }
      ships.set(mmsi, s);
    };
  });
}
async function digitraffic() {
  const H = { Accept: 'application/json', 'Digitraffic-User': 'market-terminal/1.0' };
  const json = async url => { const r = await get(url, H, 25000); if (!r.ok) throw new Error('Digitraffic ' + r.status); return r.json(); };
  const [loc, ves] = await Promise.all([
    cached('dt:loc', 60e3, () => json(`https://meri.digitraffic.fi/api/ais/v1/locations?from=${Date.now() - 20 * 60e3}`)),
    cached('dt:ves', 3600e3, () => json('https://meri.digitraffic.fi/api/ais/v1/vessels')),
  ]);
  const meta = new Map((ves || []).map(v => [v.mmsi, v]));
  return (loc.features || []).map(f => {
    const m = meta.get(f.mmsi) || {}, pr = f.properties || {}, c = f.geometry?.coordinates || [];
    return {
      mmsi: f.mmsi, name: (m.name || '').trim(), type: m.shipType ?? null, lat: c[1], lon: c[0], sog: pr.sog ?? null, cog: pr.cog ?? null,
      hdg: pr.heading === 511 ? null : pr.heading ?? null, dest: (m.destination || '').trim(), draught: m.draught != null ? m.draught / 10 : null,
      nav: pr.navStat ?? null, t: pr.timestampExternal || null,
    };
  }).filter(s => s.lat != null && s.lon != null);
}
async function ships(p) {
  const b = bboxOf(p);
  if ((b.n - b.s) * (b.e - b.w) > 2500) { const e = new Error('Area too large for ship tracking — zoom in'); e.status = 400; throw e; }
  if (aisGlobal()) {
    const g = snap(b, 0.5);
    return cached(`ais:${g.s}:${g.w}:${g.n}:${g.e}`, 60e3, async () => ({ src: 'aisstream.io', coverage: 'global', t: Date.now(), ships: await aisstream(g) }));
  }
  const all = await digitraffic();
  const inBox = all.filter(s => s.lat >= b.s && s.lat <= b.n && s.lon >= b.w && s.lon <= b.e);
  return { src: 'Digitraffic (Fintraffic)', coverage: 'Baltic Sea', total: all.length, t: Date.now(), ships: inBox.slice(0, 3000) };
}

// ---------------------------------------------------------------- military sites (OpenStreetMap)
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
async function bases(p) {
  const b = snap(bboxOf(p), 1);
  if ((b.n - b.s) * (b.e - b.w) > 900) { const e = new Error('Zoom in to load military sites (view too large)'); e.status = 400; throw e; }
  const bb = `${b.s},${b.w},${b.n},${b.e}`;
  const q = `[out:json][timeout:25];(nwr["military"~"^(base|airfield|naval_base|barracks)$"](${bb});nwr["landuse"="military"]["name"](${bb}););out center tags 600;`;
  return cached('osm:' + bb, 24 * 3600e3, async () => {
    const errs = [];
    for (const url of OVERPASS) {
      try {
        const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 28000);
        const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal }).finally(() => clearTimeout(tm));
        if (!r.ok) throw new Error('Overpass ' + r.status);
        const j = await r.json();
        const seen = new Set();
        const sites = (j.elements || []).map(el => {
          const t = el.tags || {};
          return { id: el.type[0] + el.id, name: t['name:en'] || t.name || '', kind: t.military || 'military area', op: t.operator || '', country: t['addr:country'] || '', lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon };
        }).filter(x => x.lat != null && x.name).filter(x => { const k = x.name + '|' + x.lat.toFixed(2) + '|' + x.lon.toFixed(2); if (seen.has(k)) return false; seen.add(k); return true; });
        return { src: 'OpenStreetMap contributors (ODbL)', t: Date.now(), sites };
      } catch (e) { errs.push(e.message); }
    }
    throw new Error('Military site data unavailable: ' + errs.join('; '));
  });
}

// ---------------------------------------------------------------- US petroleum inventories (EIA, free key)
const EIA_SERIES = [['WCSSTUS1', 'Strategic Petroleum Reserve'], ['WCESTUS1', 'Commercial crude (ex-SPR)'], ['W_EPC0_SAX_YCUOK_MBBL', 'Cushing, OK crude'], ['WGTSTUS1', 'Total motor gasoline'], ['WDISTUS1', 'Distillate fuel oil']];
async function eia() {
  const key = process.env.EIA_API_KEY;
  if (!key) { const e = new Error('EIA_API_KEY not configured'); e.status = 501; throw e; }
  return cached('eia', 3 * 3600e3, async () => {
    const series = await Promise.all(EIA_SERIES.map(async ([id, name]) => {
      const r = await get(`https://api.eia.gov/v2/seriesid/PET.${id}.W?api_key=${encodeURIComponent(key)}&length=260`, { Accept: 'application/json' }, 20000);
      if (!r.ok) throw new Error('EIA ' + r.status);
      const j = await r.json();
      const data = (j.response?.data || []).map(d => ({ d: d.period, v: Number(d.value) })).filter(d => Number.isFinite(d.v)).sort((a, b) => (a.d < b.d ? -1 : 1));
      return { id, name, unit: 'thousand barrels', data };
    }));
    return { src: 'U.S. Energy Information Administration', series };
  });
}

const ROUTES = {
  async quotes(p) {
    const syms = [...new Set((p.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean))].slice(0, 200);
    return syms.length ? quotes(syms) : {};
  },
  chart: p => chart(req(p, 'symbol'), p.get('range') || '1y', p.get('interval') || '1d'),
  summary: p => summary(req(p, 'symbol')),
  fin: p => financials(req(p, 'symbol')),
  screener: p => screener(req(p, 'id'), Math.min(100, Number(p.get('count')) || 25)),
  search: p => search(req(p, 'q'), Number(p.get('news')) || 0, Number(p.get('quotes') ?? 12)),
  async news(p) {
    if (p.get('q')) return (await search(p.get('q'), 30, 0)).news;
    return topNews();
  },
  ust: () => treasury(),
  flights,
  ships,
  bases,
  eia: () => eia(),
  caps: () => ({ ais: aisGlobal() ? 'global' : 'baltic', eia: !!process.env.EIA_API_KEY }),
  ping: () => ({ ok: true, t: Date.now() }),
};
function req(p, k) {
  const v = p.get(k);
  if (!v) { const e = new Error(`missing ?${k}=`); e.status = 400; throw e; }
  return v.slice(0, 64);
}


// Runs a route and returns { status, body } — used by both the local server and Vercel.
async function handle(name, params) {
  const fn = Object.prototype.hasOwnProperty.call(ROUTES, name) && ROUTES[name];
  if (!fn) return { status: 404, body: { error: 'unknown endpoint' } };
  try {
    return { status: 200, body: await fn(params) };
  } catch (e) {
    return { status: e.status || 502, body: { error: e.message || String(e) } };
  }
}

module.exports = { ROUTES, handle };
