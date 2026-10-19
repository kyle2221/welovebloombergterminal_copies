// "Edge" data: insider trading (SEC Form 4), congressional trade filings, institutional holders,
// options flow, short volume, macro series, prediction markets, sentiment, calendars, vessel tracking.
// All sources are public; only legally disclosed information is used.
'use strict';
const zlib = require('zlib');

module.exports = ({ cached, get, yahoo, mapQuote, req, digitraffic, aisGlobal, aisstream }) => {
  const fail = (msg, status = 502) => { const e = new Error(msg); e.status = status; return e; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const num = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return Number.isFinite(v) ? v : null; };
  async function mapLimit(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
    return out;
  }
  const json = async (url, headers = {}, ms = 15000) => {
    const r = await get(url, { Accept: 'application/json', ...headers }, ms);
    if (!r.ok) throw fail(`${new URL(url).hostname} ${r.status}`);
    return r.json();
  };

  // ------------------------------------------------------------ XML helpers
  const unxml = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").trim();
  const tagText = (x, t) => { const m = String(x || '').match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return m ? m[1] : ''; };
  const tagVal = (x, t) => { const inner = tagText(x, t); if (!inner) return ''; const v = inner.match(/<value>([\s\S]*?)<\/value>/); return unxml(v ? v[1] : inner.replace(/<[^>]+>/g, '')); };

  // ------------------------------------------------------------ SEC EDGAR (insider Form 4 filings)
  // SEC asks automated clients to identify themselves and stay under 10 requests/second.
  const SEC_UA = process.env.SEC_USER_AGENT || 'MarketTerminal/1.0 open-source research terminal (github.com/kyle2221/welovebloombergterminal_copies)';
  let secNext = 0;
  async function sec(url, type = 'json') {
    const now = Date.now(), wait = Math.max(0, secNext - now);
    secNext = Math.max(now, secNext) + 130;
    if (wait) await sleep(wait);
    const r = await get(url, { 'User-Agent': SEC_UA, Accept: type === 'json' ? 'application/json' : '*/*' }, 15000);
    if (!r.ok) throw fail(`SEC EDGAR ${r.status}`, r.status === 404 ? 404 : 502);
    return type === 'json' ? r.json() : r.text();
  }
  const tickerMap = () => cached('sec:tickers', 24 * 3600e3, async () => {
    const j = await sec('https://www.sec.gov/files/company_tickers.json');
    const m = {};
    for (const v of Object.values(j)) m[String(v.ticker).toUpperCase()] = { cik: v.cik_str, name: v.title };
    return m;
  });
  async function cikFor(sym) {
    const m = await tickerMap(), t = String(sym).toUpperCase();
    return m[t] || m[t.replace('-', '.')] || m[t.replace('.', '-')] || m[t.replace(/[.-]/, '')] || null;
  }
  const CODES = { P: 'Buy', S: 'Sell', A: 'Award', M: 'Option exercise', F: 'Tax withholding', G: 'Gift', D: 'Disposition to issuer', C: 'Conversion', X: 'Option exercise', J: 'Other', I: 'Discretionary', W: 'Will/inheritance', V: 'Voluntary report', K: 'Equity swap', E: 'Expiration', H: 'Expiration', L: 'Small acquisition', O: 'OTM exercise', Z: 'Voting trust', U: 'Tender' };
  function parseForm4(xml) {
    const issuer = tagText(xml, 'issuer');
    const owners = (xml.match(/<reportingOwner>[\s\S]*?<\/reportingOwner>/g) || []).map(o => {
      const rel = tagText(o, 'reportingOwnerRelationship');
      const flag = t => /^(1|true)$/i.test(unxml(tagText(rel, t)));
      const roles = [];
      if (flag('isOfficer')) roles.push(unxml(tagText(rel, 'officerTitle')) || 'Officer');
      if (flag('isDirector')) roles.push('Director');
      if (flag('isTenPercentOwner')) roles.push('10% Owner');
      if (flag('isOther')) roles.push(unxml(tagText(rel, 'otherText')) || 'Other');
      return { name: unxml(tagText(o, 'rptOwnerName')), cik: unxml(tagText(o, 'rptOwnerCik')), roles };
    });
    const tx = [];
    for (const [kind, re] of [['stock', /<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g], ['derivative', /<derivativeTransaction>[\s\S]*?<\/derivativeTransaction>/g]]) {
      for (const b of xml.match(re) || []) {
        const code = unxml(tagText(tagText(b, 'transactionCoding'), 'transactionCode'));
        tx.push({
          kind, security: tagVal(b, 'securityTitle'), date: tagVal(b, 'transactionDate'), code, label: CODES[code] || code,
          shares: num(tagVal(b, 'transactionShares')), price: num(tagVal(b, 'transactionPricePerShare')),
          ad: tagVal(b, 'transactionAcquiredDisposedCode'), after: num(tagVal(b, 'sharesOwnedFollowingTransaction')),
          di: tagVal(b, 'directOrIndirectOwnership'),
        });
      }
    }
    return {
      issuer: { cik: unxml(tagText(issuer, 'issuerCik')), name: unxml(tagText(issuer, 'issuerName')), sym: unxml(tagText(issuer, 'issuerTradingSymbol')).toUpperCase() },
      owners, plan: /<aff10b5One>\s*(1|true)\s*<\/aff10b5One>/i.test(xml), tx,
    };
  }
  async function insiders(p) {
    const sym = req(p, 'symbol').toUpperCase();
    return cached('ins:' + sym, 30 * 60e3, async () => {
      const c = await cikFor(sym);
      if (!c) throw fail(`${sym}: no SEC registrant found. Form 4 insider filings exist for US-listed companies only.`, 404);
      const cik = String(c.cik);
      const sub = await sec(`https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`);
      const r = sub.filings?.recent || { form: [] };
      const idx = [];
      for (let i = 0; i < r.form.length && idx.length < 30; i++) if (r.form[i] === '4' || r.form[i] === '4/A') idx.push(i);
      const filings = await mapLimit(idx, 4, async i => {
        const acc = r.accessionNumber[i], accND = acc.replace(/-/g, ''), doc = String(r.primaryDocument[i]).replace(/^xsl[^/]+\//, '');
        try {
          const f = parseForm4(await sec(`https://www.sec.gov/Archives/edgar/data/${cik}/${accND}/${doc}`, 'text'));
          return { ...f, acc, filed: r.filingDate[i], url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accND}/${acc}-index.htm` };
        } catch { return null; }
      });
      return { sym, cik, name: c.name, src: 'SEC EDGAR Form 4', filings: filings.filter(Boolean) };
    });
  }
  // Market-wide: the most recent Form 4 filings from EDGAR's live feed
  async function insiderFeed() {
    return cached('insfeed', 10 * 60e3, async () => {
      const atom = await sec('https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&start=0&count=100&output=atom', 'text');
      const seen = new Map();
      for (const e of atom.match(/<entry>[\s\S]*?<\/entry>/g) || []) {
        const title = unxml(tagText(e, 'title'));
        const href = (e.match(/<link[^>]*href="([^"]+)"/) || [])[1];
        const acc = (unxml(tagText(e, 'id')).match(/accession-number=([\d-]+)/) || [])[1];
        if (!href || !acc || !/^4(\/A)?\s/.test(title)) continue;
        if (!seen.has(acc)) seen.set(acc, { href, acc, updated: unxml(tagText(e, 'updated')) });
      }
      const list = [...seen.values()].slice(0, 36);
      const filings = await mapLimit(list, 4, async f => {
        try {
          const base = f.href.replace(/[^/]+$/, '');
          const ix = await sec(base + 'index.json');
          const xmlName = (ix.directory?.item || []).map(i => i.name).find(n => /\.xml$/i.test(n) && !/^xsl/i.test(n) && !/FilingSummary/i.test(n));
          if (!xmlName) return null;
          return { ...parseForm4(await sec(base + xmlName, 'text')), acc: f.acc, filed: f.updated.slice(0, 10), time: f.updated, url: f.href };
        } catch { return null; }
      });
      return { t: Date.now(), src: 'SEC EDGAR live Form 4 feed', filings: filings.filter(Boolean) };
    });
  }

  // ------------------------------------------------------------ Congress (House periodic transaction reports)
  function unzip(buf) {
    let eocd = buf.length - 22;
    while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) throw fail('Invalid ZIP archive');
    const n = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const out = {};
    for (let i = 0; i < n; i++) {
      const method = buf.readUInt16LE(off + 10), size = buf.readUInt32LE(off + 20);
      const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
      const name = buf.toString('utf8', off + 46, off + 46 + nlen);
      const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const data = buf.subarray(start, start + size);
      out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
      off += 46 + nlen + elen + clen;
    }
    return out;
  }
  async function congress() {
    return cached('house', 6 * 3600e3, async () => {
      const y = new Date().getUTCFullYear(), rows = [];
      for (const yr of [y, y - 1]) {
        try {
          const r = await get(`https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${yr}FD.zip`, {}, 25000);
          if (!r.ok) throw fail('House Clerk ' + r.status);
          const files = unzip(Buffer.from(await r.arrayBuffer()));
          const xml = files[Object.keys(files).find(k => /\.xml$/i.test(k))]?.toString('utf8') || '';
          for (const m of xml.match(/<Member>[\s\S]*?<\/Member>/g) || []) {
            if (unxml(tagText(m, 'FilingType')) !== 'P') continue;
            const [mo, d, yy] = unxml(tagText(m, 'FilingDate')).split('/');
            const doc = unxml(tagText(m, 'DocID'));
            rows.push({
              name: [unxml(tagText(m, 'Prefix')), unxml(tagText(m, 'First')), unxml(tagText(m, 'Last')), unxml(tagText(m, 'Suffix'))].filter(Boolean).join(' '),
              district: unxml(tagText(m, 'StateDst')), date: `${yy}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, doc,
              url: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${yr}/${doc}.pdf`,
            });
          }
        } catch (e) { if (yr === y) throw e; }
        if (rows.length >= 200) break;
      }
      rows.sort((a, b) => (a.date < b.date ? 1 : -1));
      return { src: 'U.S. House Clerk — Periodic Transaction Reports (STOCK Act)', rows: rows.slice(0, 600) };
    });
  }

  // ------------------------------------------------------------ holders (Yahoo)
  const holders = p => {
    const sym = req(p, 'symbol');
    return cached('hold:' + sym, 3600e3, async () => {
      const j = await yahoo(`/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=majorHoldersBreakdown,institutionOwnership,fundOwnership,insiderHolders,insiderTransactions,netSharePurchaseActivity,defaultKeyStatistics`, true);
      const r = j?.quoteSummary?.result?.[0];
      if (!r) throw fail('No holder data for ' + sym, 404);
      return r;
    });
  };

  // ------------------------------------------------------------ options (Yahoo)
  async function options(p) {
    const sym = req(p, 'symbol'), date = Number(p.get('date')) || null;
    return cached(`opt:${sym}:${date || ''}`, 120e3, async () => {
      const j = await yahoo(`/v7/finance/options/${encodeURIComponent(sym)}${date ? '?date=' + date : ''}`, true);
      const r = j?.optionChain?.result?.[0];
      if (!r || !r.options?.length) throw fail('No listed options for ' + sym, 404);
      const o = r.options[0];
      const m = c => ({ c: c.contractSymbol, k: c.strike, last: c.lastPrice ?? null, chg: c.change ?? null, bid: c.bid ?? null, ask: c.ask ?? null, vol: c.volume || 0, oi: c.openInterest || 0, iv: c.impliedVolatility ?? null, itm: !!c.inTheMoney });
      return { sym: r.underlyingSymbol, exps: r.expirationDates || [], exp: o.expirationDate, spot: r.quote?.regularMarketPrice ?? null, quote: r.quote ? mapQuote(r.quote) : null, calls: (o.calls || []).map(m), puts: (o.puts || []).map(m) };
    });
  }
  const UOA_DEFAULT = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'AVGO', 'PLTR', 'NFLX', 'JPM', 'BAC', 'XOM', 'COIN', 'MSTR', 'SMCI', 'INTC', 'UBER', 'BA', 'DIS', 'HOOD', 'SOFI', 'MU', 'ORCL'];
  async function uoa(p) {
    const list = (p.get('symbols') || UOA_DEFAULT.join(',')).split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9.^=-]{1,12}$/.test(s)).slice(0, 30);
    return cached('uoa:' + list.join(','), 5 * 60e3, async () => {
      const rows = [], stats = [];
      await mapLimit(list, 5, async s => {
        try {
          const d = await options(new URLSearchParams({ symbol: s }));
          let cv = 0, pv = 0, co = 0, po = 0;
          for (const [side, arr] of [['C', d.calls], ['P', d.puts]]) {
            for (const c of arr) {
              if (side === 'C') { cv += c.vol; co += c.oi; } else { pv += c.vol; po += c.oi; }
              const prem = c.vol * (c.last || 0) * 100;
              if (c.vol >= 500 && c.vol > 2 * Math.max(c.oi, 1) && prem >= 100000) rows.push({ sym: s, side, k: c.k, exp: d.exp, vol: c.vol, oi: c.oi, last: c.last, iv: c.iv, prem, spot: d.spot, otm: side === 'C' ? c.k > d.spot : c.k < d.spot });
            }
          }
          stats.push({ sym: s, spot: d.spot, exp: d.exp, cv, pv, pcr: cv ? pv / cv : null, co, po });
        } catch { /* symbol without options */ }
      });
      rows.sort((a, b) => b.prem - a.prem);
      stats.sort((a, b) => (b.cv + b.pv) - (a.cv + a.pv));
      return { t: Date.now(), note: 'Nearest expiry. Unusual = volume > 2× open interest, ≥500 contracts, ≥$100k premium.', rows: rows.slice(0, 150), stats };
    });
  }

  // ------------------------------------------------------------ FINRA daily short sale volume
  const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  function finraDay(ds) {
    const today = ymd(new Date());
    return cached('finra:' + ds, ds === today ? 3600e3 : 24 * 3600e3, async () => {
      const r = await get(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${ds}.txt`, {}, 20000);
      if (r.status === 404 || r.status === 403) return null;
      if (!r.ok) throw fail('FINRA ' + r.status);
      const m = new Map();
      for (const line of (await r.text()).split('\n')) {
        const f = line.split('|');
        if (f.length < 5 || f[0] === 'Date') continue;
        m.set(f[1], [Number(f[2]), Number(f[4])]);
      }
      return m.size ? m : null;
    });
  }
  async function recentFinra(n) {
    const days = [];
    for (let i = 0; days.length < n + 4 && i < 30; i++) { const d = new Date(Date.now() - i * 864e5); if (d.getUTCDay() % 6) days.push(ymd(d)); }
    const got = await Promise.all(days.map(d => finraDay(d).catch(() => null)));
    return days.map((d, i) => [d, got[i]]).filter(x => x[1]).slice(0, n);
  }
  async function shortvol(p) {
    const sym = (p.get('symbol') || '').toUpperCase().replace('-', '.');
    if (sym) {
      return cached('sv:' + sym, 3600e3, async () => {
        const days = await recentFinra(15);
        return { sym, src: 'FINRA Reg SHO daily short sale volume (consolidated)', days: days.map(([d, m]) => { const v = m.get(sym); return { d, short: v?.[0] ?? null, total: v?.[1] ?? null }; }).reverse() };
      });
    }
    return cached('sv:top', 3600e3, async () => {
      const days = await recentFinra(1);
      if (!days.length) throw fail('FINRA short volume unavailable');
      const [d, m] = days[0];
      const rows = [...m].filter(([, v]) => v[1] >= 3e6).map(([s, v]) => ({ sym: s, short: v[0], total: v[1], pct: v[0] / v[1] * 100 })).sort((a, b) => b.pct - a.pct).slice(0, 80);
      return { d, src: 'FINRA Reg SHO daily short sale volume', rows };
    });
  }

  // ------------------------------------------------------------ FRED macro series (keyless CSV)
  async function fred(p) {
    const ids = (p.get('ids') || '').toUpperCase().split(',').filter(x => /^[A-Z0-9_]{2,30}$/.test(x)).slice(0, 16);
    if (!ids.length) throw fail('missing ?ids=', 400);
    const start = new Date(Date.now() - 12 * 365 * 864e5).toISOString().slice(0, 10);
    const out = {};
    await Promise.all(ids.map(async id => {
      try {
        out[id] = await cached('fred:' + id, 6 * 3600e3, async () => {
          const r = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`, { Accept: 'text/csv' }, 20000);
          if (!r.ok) throw fail('FRED ' + r.status);
          const lines = (await r.text()).trim().split(/\r?\n/);
          lines.shift();
          return lines.map(l => { const [d, v] = l.split(','); return [d, v === '.' || v === '' ? null : Number(v)]; }).filter(x => x[1] != null && Number.isFinite(x[1]));
        });
      } catch (e) { out[id] = { error: e.message }; }
    }));
    return out;
  }

  // ------------------------------------------------------------ prediction markets
  async function predict() {
    return cached('pred', 5 * 60e3, async () => {
      const [pm, ks] = await Promise.allSettled([
        json('https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume24hr&ascending=false&limit=80'),
        json('https://api.elections.kalshi.com/trade-api/v2/events?status=open&with_nested_markets=true&limit=200'),
      ]);
      const parse = s => { try { return typeof s === 'string' ? JSON.parse(s) : s || []; } catch { return []; } };
      const out = [];
      for (const ev of Array.isArray(pm.value) ? pm.value : []) {
        const ms = (ev.markets || []).filter(m => m.active !== false && !m.closed);
        let outcomes;
        if (ms.length > 1) outcomes = ms.map(m => ({ name: m.groupItemTitle || m.question, p: Number(parse(m.outcomePrices)[0]) }));
        else if (ms[0]) { const names = parse(ms[0].outcomes), ps = parse(ms[0].outcomePrices); outcomes = names.map((n, i) => ({ name: n, p: Number(ps[i]) })); }
        outcomes = (outcomes || []).filter(o => Number.isFinite(o.p)).sort((a, b) => b.p - a.p).slice(0, 6);
        if (!outcomes.length) continue;
        out.push({ src: 'Polymarket', title: ev.title, vol24: Number(ev.volume24hr) || 0, vol: Number(ev.volume) || 0, end: ev.endDate || null, url: `https://polymarket.com/event/${ev.slug}`, outcomes, tags: (ev.tags || []).map(t => t.label || t.slug).filter(Boolean) });
      }
      for (const ev of ks.value?.events || []) {
        const ms = (ev.markets || []).filter(m => !m.status || ['active', 'open'].includes(m.status));
        const price = m => { const v = m.last_price_dollars ?? m.yes_bid_dollars ?? (m.last_price != null ? m.last_price / 100 : m.yes_bid != null ? m.yes_bid / 100 : null); return v != null ? Number(v) : null; };
        const outcomes = ms.map(m => ({ name: m.yes_sub_title || m.subtitle || m.title, p: price(m) })).filter(o => o.p != null && Number.isFinite(o.p)).sort((a, b) => b.p - a.p).slice(0, 6);
        if (!outcomes.length) continue;
        const vol24 = ms.reduce((a, m) => a + (Number(m.volume_24h ?? m.volume_24h_fp) || 0), 0);
        out.push({ src: 'Kalshi', title: ev.title, vol24, vol: ms.reduce((a, m) => a + (Number(m.volume ?? m.volume_fp) || 0), 0), end: ms[0]?.close_time || null, url: `https://kalshi.com/markets/${String(ev.series_ticker || ev.event_ticker || '').toLowerCase()}`, outcomes, tags: [ev.category].filter(Boolean) });
      }
      if (!out.length) throw fail('Prediction markets unavailable: ' + [pm.reason?.message, ks.reason?.message].filter(Boolean).join('; '));
      return { t: Date.now(), events: out, errors: [pm.reason?.message, ks.reason?.message].filter(Boolean) };
    });
  }

  // ------------------------------------------------------------ sentiment
  async function sentiment() {
    return cached('sent', 10 * 60e3, async () => {
      const [ape, fng] = await Promise.allSettled([
        json('https://apewisdom.io/api/v1.0/filter/all-stocks/page/1'),
        json('https://production.dataviz.cnn.io/index/fearandgreed/graphdata/', { Referer: 'https://www.cnn.com/', Origin: 'https://www.cnn.com' }),
      ]);
      const fg = fng.value?.fear_and_greed;
      return {
        reddit: (ape.value?.results || []).slice(0, 60).map(x => ({ rank: Number(x.rank), sym: x.ticker, name: x.name, mentions: Number(x.mentions), upvotes: Number(x.upvotes), rank24: Number(x.rank_24h_ago) || null, mentions24: Number(x.mentions_24h_ago) || null })),
        redditErr: ape.reason?.message || null,
        fng: fg ? { score: fg.score, rating: fg.rating, prev: fg.previous_close, w1: fg.previous_1_week, m1: fg.previous_1_month, y1: fg.previous_1_year, t: fg.timestamp } : null,
        fngHist: (fng.value?.fear_and_greed_historical?.data || []).map(d => [d.x, d.y]).slice(-400),
        fngErr: fng.reason?.message || null,
      };
    });
  }

  // ------------------------------------------------------------ calendars
  const ecocal = () => cached('eco', 30 * 60e3, async () => ({ src: 'ForexFactory weekly calendar', events: await json('https://nfs.faireconomy.media/ff_calendar_thisweek.json') }));
  async function earnings(p) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(p.get('date') || '') ? p.get('date') : new Date().toISOString().slice(0, 10);
    return cached('earn:' + d, 3600e3, async () => {
      const j = await json(`https://api.nasdaq.com/api/calendar/earnings?date=${d}`, { Accept: 'application/json, text/plain, */*', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' });
      return { date: d, src: 'Nasdaq earnings calendar', rows: (j?.data?.rows || []).map(x => ({ sym: x.symbol, name: x.name, time: x.time, eps: x.epsForecast, n: x.noOfEsts, last: x.lastYearEPS, mcap: x.marketCap, fq: x.fiscalQuarterEnding })) };
    });
  }

  // ------------------------------------------------------------ vessel tracking
  async function vessels(p) {
    const ids = (p.get('mmsi') || '').split(',').map(s => s.trim()).filter(s => /^\d{9}$/.test(s)).slice(0, 50);
    if (!ids.length) throw fail('missing ?mmsi=', 400);
    if (aisGlobal()) return cached('vs:' + ids.join(','), 60e3, async () => ({ src: 'aisstream.io', coverage: 'global', ships: await aisstream({ s: -90, w: -180, n: 90, e: 180 }, ids, 12000) }));
    const set = new Set(ids.map(Number));
    return { src: 'Digitraffic (Fintraffic)', coverage: 'Baltic Sea', ships: (await digitraffic()).filter(s => set.has(s.mmsi)) };
  }
  async function vsearch(p) {
    const q = req(p, 'q').toUpperCase().trim();
    const all = await digitraffic();
    const hits = all.filter(s => String(s.mmsi) === q || (s.name && s.name.toUpperCase().includes(q)) || (s.dest && s.dest.toUpperCase() === q));
    return { src: 'Digitraffic (Fintraffic)', coverage: 'Baltic Sea', ships: hits.slice(0, 100) };
  }

  return {
    insiders, insiderfeed: insiderFeed, congress, holders, options, uoa, shortvol, fred,
    predict, sentiment, ecocal, earnings, vessels, vsearch,
  };
};
