// Company research: supply chain (who a company sells to, buys from and competes with), revenue by
// segment, product, geography and customer, and equity research (ratings, price targets, analyst actions,
// independent research reports, technical outlook, ESG, peer valuation multiples).
// Sources: the company's latest annual report in XBRL (SEC EDGAR), EDGAR full-text search of other
// companies' filings that name it, and Yahoo Finance.
'use strict';

module.exports = ({ cached, yahoo, req, secApi, decode }) => {
  const { sec, cikFor, submissions } = secApi;
  const fail = (msg, status = 502) => { const e = new Error(msg); e.status = status; return e; };
  const symOf = p => req(p, 'symbol').toUpperCase();
  const rv = x => (x && typeof x === 'object' ? ('raw' in x ? x.raw : null) : typeof x === 'number' ? x : null);
  async function mapLimit(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
    return out;
  }
  const htmlText = h => decode(String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));

  // ------------------------------------------------------------ XBRL (annual report)
  let REGION = null;
  try { REGION = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { }
  // "nvda:ComputeAndNetworkingMember" -> "Compute and Networking" (used when the filing has no label for it)
  function humanize(qn) {
    const [pfx, local = pfx] = String(qn).split(':');
    if (pfx === 'country' && /^[A-Z]{2}$/.test(local) && REGION) { try { return REGION.of(local); } catch { } }
    if (pfx === 'stpr') return local + ' (state)';
    const s = local.replace(/(Member|Axis|Domain)$/, '').replace(/_/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/\bI (Phone|Pad|Mac|Cloud|Pod)/g, 'i$1').replace(/\b(And|Of|The|Or|In|To|For|Excluding|Including)\b/g, w => w.toLowerCase()).trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  // Label linkbase: element -> human label ("aapl_IPhoneMember" -> "iPhone"), preferring terse labels
  function labels(xml) {
    const out = new Map();
    if (!xml) return out;
    const loc = new Map(), lab = new Map();
    for (const m of xml.matchAll(/<(?:\w+:)?loc\b[^>]*>/g)) {
      const href = (m[0].match(/xlink:href="[^"#]*#([^"]+)"/) || [])[1], id = (m[0].match(/xlink:label="([^"]+)"/) || [])[1];
      if (href && id) loc.set(id, href);
    }
    for (const m of xml.matchAll(/<(?:\w+:)?label\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?label>/g)) {
      const id = (m[1].match(/xlink:label="([^"]+)"/) || [])[1], role = (m[1].match(/xlink:role="([^"]+)"/) || [])[1] || '';
      if (!id) continue;
      const l = lab.get(id) || [];
      l.push({ role, text: decode(m[2]) });
      lab.set(id, l);
    }
    for (const m of xml.matchAll(/<(?:\w+:)?labelArc\b[^>]*>/g)) {
      const from = (m[0].match(/xlink:from="([^"]+)"/) || [])[1], to = (m[0].match(/xlink:to="([^"]+)"/) || [])[1];
      const el = loc.get(from), ls = lab.get(to);
      if (!el || !ls) continue;
      const pick = ls.find(x => /terseLabel$/.test(x.role)) || ls.find(x => /\/label$/.test(x.role)) || ls[0];
      const prev = out.get(el);
      if (!prev || /terseLabel$/.test(pick.role)) out.set(el, { text: pick.text.replace(/\s*\[(Member|Axis|Domain)\]\s*$/i, ''), role: pick.role });
    }
    return out;
  }
  const REV = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet', 'SalesRevenueGoodsNet', 'Revenue', 'RevenueFromContractsWithCustomers', 'RevenueNet'];
  const OPINC = ['OperatingIncomeLoss', 'ProfitLossFromOperatingActivities'];
  const CONC = ['ConcentrationRiskPercentage1'];
  function parseInstance(xml) {
    const ctx = new Map();
    for (const m of xml.matchAll(/<(?:\w+:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?context>/g)) {
      const b = m[2];
      if (/typedMember/.test(b)) continue;
      const dims = [...b.matchAll(/<(?:\w+:)?explicitMember[^>]*dimension="([^"]+)"[^>]*>([^<]+)</g)].map(x => [x[1], x[2].trim()]);
      const g = t => (b.match(new RegExp(`<(?:\\w+:)?${t}>([^<]+)<`)) || [])[1]?.trim() || null;
      ctx.set(m[1], { dims, start: g('startDate'), end: g('endDate') || g('instant'), instant: !!g('instant') });
    }
    const facts = [];
    const names = [...REV, ...OPINC, ...CONC].join('|');
    for (const m of xml.matchAll(new RegExp(`<((us-gaap|ifrs-full):(${names}))\\b([^>]*?)>([^<]*)</\\1>`, 'g'))) {
      const cref = (m[4].match(/contextRef="([^"]+)"/) || [])[1], c = ctx.get(cref), v = parseFloat(m[5]);
      if (!c || !Number.isFinite(v)) continue;
      facts.push({ name: m[3], c, v });
    }
    return facts;
  }
  const AXIS_KIND = {
    StatementBusinessSegmentsAxis: 'segment', SegmentsAxis: 'segment',
    ProductOrServiceAxis: 'product', ProductsAndServicesAxis: 'product',
    StatementGeographicalAxis: 'geo', GeographicalAreasAxis: 'geo',
    MajorCustomersAxis: 'customer',
  };
  const AXIS_LABEL = { segment: 'Business segment', product: 'Product / service', geo: 'Geography', customer: 'Major customers' };
  const BENCH = [[/Revenue|Sales/i, 'revenue'], [/Receivable/i, 'receivables'], [/Inventor/i, 'inventory'], [/Cost/i, 'cost of sales'], [/Purchase/i, 'purchases'], [/Payable/i, 'payables'], [/Asset/i, 'assets']];
  const local = qn => String(qn).split(':').pop();
  const isAnnual = c => c.start && c.end && !c.instant && Math.abs((Date.parse(c.end) - Date.parse(c.start)) / 864e5 - 365) < 25;
  // drop the "operating segments" consolidation member that often accompanies a segment member
  const coreDims = dims => dims.filter(([a, m]) => !(/ConsolidationItemsAxis$/.test(a) && /OperatingSegmentsMember$/.test(m)));
  function breakdowns(facts, label) {
    const total = {}, groups = new Map();
    const rank = n => { const i = REV.indexOf(n); return i < 0 ? 99 : i; };
    for (const f of facts) {
      const isRev = REV.includes(f.name), isOp = OPINC.includes(f.name);
      if ((!isRev && !isOp) || !isAnnual(f.c)) continue;
      const dims = coreDims(f.c.dims);
      if (!dims.length) { if (isRev && (!total[f.c.end] || rank(f.name) < total[f.c.end].r)) total[f.c.end] = { v: f.v, r: rank(f.name) }; continue; }
      if (dims.length !== 1 || /ConsolidationItemsAxis$/.test(dims[0][0])) continue;
      const [axis, mem] = dims[0];
      const kind = AXIS_KIND[local(axis)] || (/^(us-gaap|srt|ifrs-full|dei):/.test(axis) ? null : 'other');
      if (!kind) continue;
      if (!groups.has(axis)) groups.set(axis, { kind, axis, label: AXIS_LABEL[kind] || label(axis), rows: new Map() });
      const g = groups.get(axis);
      if (!g.rows.has(mem)) g.rows.set(mem, { m: mem, name: label(mem), rev: {}, op: {} });
      const row = g.rows.get(mem), slot = isRev ? row.rev : row.op;
      if (!slot[f.c.end] || rank(f.name) < slot[f.c.end].r) slot[f.c.end] = { v: f.v, r: rank(f.name) };
    }
    const order = { segment: 0, product: 1, geo: 2, customer: 3, other: 4 };
    const out = [...groups.values()].map(g => {
      const ends = [...new Set([...g.rows.values()].flatMap(r => Object.keys(r.rev)))].sort().reverse().slice(0, 3);
      const rows = [...g.rows.values()].map(r => ({ m: r.m, name: r.name, rev: ends.map(e => r.rev[e]?.v ?? null), op: ends.map(e => r.op[e]?.v ?? null) }))
        .filter(r => r.rev.some(v => v != null)).sort((a, b) => (b.rev[0] ?? -Infinity) - (a.rev[0] ?? -Infinity));
      return { kind: g.kind, axis: g.axis, label: g.label, ends, rows, total: ends.map(e => total[e]?.v ?? null) };
    }).filter(g => g.rows.length >= 2 || g.kind === 'customer').sort((a, b) => order[a.kind] - order[b.kind] || b.rows.length - a.rows.length);
    return { groups: out, total: Object.fromEntries(Object.entries(total).map(([k, v]) => [k, v.v])) };
  }
  // ConcentrationRiskPercentage1 facts: "Customer A accounted for 12% of revenue", "one supplier provides 40% of purchases"
  function concentration(facts, label) {
    const best = new Map();
    for (const f of facts) {
      if (!CONC.includes(f.name)) continue;
      const dims = coreDims(f.c.dims);
      const bench = dims.find(([a]) => /ConcentrationRiskByBenchmarkAxis$/.test(a))?.[1] || '';
      const type = dims.find(([a]) => /ConcentrationRiskByTypeAxis$/.test(a))?.[1] || '';
      const ent = dims.find(([a]) => !/ConcentrationRiskBy(Benchmark|Type)Axis$/.test(a));
      const key = `${ent?.[1] || '-'}|${bench}|${type}`;
      const prev = best.get(key);
      if (prev && prev.end >= f.c.end) continue;
      const B = local(bench), T = local(type), A = ent ? local(ent[0]) : '';
      const side = /Supplier|Vendor/i.test(T + A) || /Cost|Purchase|Inventor|Payable/i.test(B) ? 'supplier'
        : /Customer/i.test(T + A) || (!ent && /Revenue|Sales|Receivable/i.test(B)) ? 'customer'
          : /Revenue|Sales|Receivable/i.test(B) && /Customer|Client|Distributor|Partner|Reseller/i.test(ent?.[1] || '') ? 'customer' : 'other';
      const who = ent ? label(ent[1]) : 'Largest customer (not named)';
      best.set(key, {
        who, m: ent?.[1] || null, axis: ent ? label(ent[0]) : '', side, anon: !ent || /^(customer|distributor|direct customer|indirect customer|vendor|supplier)s?\s*([a-z0-9]|one|two|three)?$|^(one|two|three|four|five|single|largest|other)\b/i.test(who),
        benchmark: bench ? (BENCH.find(([re]) => re.test(local(bench)))?.[1] || label(bench).replace(/ Benchmark$/i, '')) : '', type: type ? label(type).replace(/ Concentration Risk$/i, '') : '', pct: f.v > 1 ? f.v / 100 : f.v, end: f.c.end,
      });
    }
    return [...best.values()].sort((a, b) => (a.side > b.side ? 1 : a.side < b.side ? -1 : 0) || b.end.localeCompare(a.end) || b.pct - a.pct);
  }
  // The latest annual report (10-K, 20-F, 40-F) with its XBRL data, parsed
  const ANNUAL = ['10-K', '20-F', '40-F', '10-KT'];
  function annual(sym) {
    return cached('xbrl:' + sym, 12 * 3600e3, async () => {
      const c = await cikFor(sym);
      if (!c) throw fail(`${sym} is not an SEC registrant (non-US listings file with their home regulator)`, 404);
      const sub = await submissions(c.cik), r = sub.filings?.recent || {};
      const i = (r.form || []).findIndex(f => ANNUAL.includes(f));
      if (i < 0) throw fail(`No annual report (10-K / 20-F) on EDGAR for ${sym}`, 404);
      const acc = r.accessionNumber[i], base = `https://www.sec.gov/Archives/edgar/data/${c.cik}/${acc.replace(/-/g, '')}/`;
      const items = ((await sec(base + 'index.json')).directory?.item || []).map(x => x.name);
      const inst = items.find(n => /_htm\.xml$/i.test(n)) || items.find(n => /\.xml$/i.test(n) && !/(FilingSummary|MetaLinks|_cal|_def|_lab|_pre)\.xml$|^R\d+\.xml$/i.test(n));
      const lab = items.find(n => /_lab\.xml$/i.test(n));
      const meta = { cik: c.cik, name: sub.name || c.name, sic: sub.sicDescription || '', form: r.form[i], filed: r.filingDate[i], period: r.reportDate[i], doc: base + r.primaryDocument[i], index: `${base}${acc}-index.htm` };
      if (!inst) return { ...meta, groups: [], total: {}, conc: [], note: 'This filing has no XBRL financial data' };
      const [xml, labXml] = await Promise.all([sec(base + inst, 'text', 25000), lab ? sec(base + lab, 'text', 20000).catch(() => '') : '']);
      const L = labels(labXml);
      const label = qn => L.get(String(qn).replace(':', '_'))?.text || humanize(qn);
      const facts = parseInstance(xml);
      return { ...meta, ...breakdowns(facts, label), conc: concentration(facts, label) };
    });
  }

  // ------------------------------------------------------------ EDGAR full-text search: other filers that name the company
  const ALIAS = {
    GOOGL: ['Google', 'Alphabet'], GOOG: ['Google', 'Alphabet'], META: ['Meta Platforms', 'Facebook'], TSM: ['TSMC', 'Taiwan Semiconductor'], AMZN: ['Amazon'],
    MSFT: ['Microsoft'], AAPL: ['Apple'], NVDA: ['NVIDIA'], WMT: ['Walmart', 'Wal-Mart'], 'BRK-B': ['Berkshire Hathaway'], 'BRK-A': ['Berkshire Hathaway'],
    JPM: ['JPMorgan'], HD: ['Home Depot'], KO: ['Coca-Cola'], PEP: ['PepsiCo'], TSLA: ['Tesla'], INTC: ['Intel'], AMD: ['AMD', 'Advanced Micro Devices'],
    AVGO: ['Broadcom'], QCOM: ['Qualcomm'], ORCL: ['Oracle'], CSCO: ['Cisco'], DELL: ['Dell'], HPQ: ['HP Inc'], HPE: ['Hewlett Packard Enterprise'],
    COST: ['Costco'], TGT: ['Target Corporation'], LOW: ["Lowe's"], BA: ['Boeing'], GM: ['General Motors'], F: ['Ford Motor'], CVS: ['CVS'], UNH: ['UnitedHealth'],
    MCK: ['McKesson'], COR: ['Cencora', 'AmerisourceBergen'], CAH: ['Cardinal Health'], LMT: ['Lockheed Martin'], RTX: ['Raytheon', 'RTX'], GE: ['General Electric', 'GE Aerospace'],
    SMCI: ['Super Micro'], MU: ['Micron'], ASML: ['ASML'], IBM: ['IBM'], CRM: ['Salesforce'], ADBE: ['Adobe'], NFLX: ['Netflix'], DIS: ['Disney'], UPS: ['UPS', 'United Parcel Service'],
    FDX: ['FedEx'], CAT: ['Caterpillar'], DE: ['Deere'], XOM: ['ExxonMobil', 'Exxon Mobil'], CVX: ['Chevron'], PFE: ['Pfizer'], JNJ: ['Johnson & Johnson'], MRK: ['Merck'],
    LLY: ['Eli Lilly'], ABBV: ['AbbVie'], V: ['Visa'], MA: ['Mastercard'], ARM: ['Arm Holdings', 'Arm Limited'], MRVL: ['Marvell'], TXN: ['Texas Instruments'], ADI: ['Analog Devices'],
    AMAT: ['Applied Materials'], LRCX: ['Lam Research'], KLAC: ['KLA Corporation'], CRWV: ['CoreWeave'], PLTR: ['Palantir'], UBER: ['Uber'], SNOW: ['Snowflake'],
  };
  const cleanName = n => {
    let s = String(n || '').replace(/\/[A-Z]{2}\/?$/, '').trim();
    for (let k = 0; k < 3; k++) s = s.replace(/[,.]?\s+(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|n\.?v|s\.?a|ag|se|llc|l\.?p|class [a-c])\.?$/i, '').trim();
    s = s.replace(/^the\s+/i, '');
    // EDGAR names are upper case; title-case words longer than 4 letters (keeps NVIDIA, IBM, AMD)
    return s === s.toUpperCase() ? s.replace(/\b([A-Z])([A-Z]{4,})\b/g, (m, a, b) => a + b.toLowerCase()) : s;
  };
  // Phrases another company's filing would use about this company, by relationship.
  // "suppliers" = filers that sell to the company; "customers" = filers that buy from it.
  const PHRASES = {
    suppliers: n => [`sales to ${n}`, `${n} accounted for`, `revenue from ${n}`, `revenues from ${n}`, `customers such as ${n}`, `customers include ${n}`],
    customers: n => [`purchases from ${n}`, `purchased from ${n}`, `supplied by ${n}`, `manufactured by ${n}`, `rely on ${n}`, `depend on ${n}`, `sourced from ${n}`],
    competitors: n => [`compete with ${n}`, `competitors such as ${n}`, `competitors include ${n}`, `competition from ${n}`, `competitors, including ${n}`],
  };
  const ymd = d => d.toISOString().slice(0, 10);
  async function efts(q, forms) {
    const end = new Date(), start = new Date(Date.now() - 730 * 864e5);
    const j = await sec(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}&forms=${forms}&dateRange=custom&startdt=${ymd(start)}&enddt=${ymd(end)}`, 'json', 20000);
    return { total: j.hits?.total?.value ?? 0, hits: j.hits?.hits || [] };
  }
  const FORMS = '10-K,10-Q,20-F,40-F,S-1,F-1';
  async function related(names, kind, selfCik) {
    const phrases = names.flatMap(n => PHRASES[kind](n));
    // one OR query per relationship; if the full-text engine rejects it, search the phrases one by one
    let res;
    try { res = [await efts(phrases.map(x => `"${x}"`).join(' OR '), FORMS)]; if (!res[0].total) throw new Error('no hits'); }
    catch { res = await mapLimit(phrases, 3, x => efts(`"${x}"`, FORMS).catch(() => ({ total: 0, hits: [] }))); }
    const by = new Map();
    for (const r of res) for (const h of r.hits) {
      const s = h._source || {}, cik = String(Number((s.ciks || [])[0] || 0));
      if (!cik || cik === String(selfCik)) continue;
      const dn = (s.display_names || [])[0] || '';
      const m = dn.match(/^(.*?)\s*(?:\(([^)]*)\))?\s*\(CIK\s*(\d+)\)\s*$/) || [];
      const file = String(h._id || '').split(':')[1] || '';
      const adsh = s.adsh || String(h._id || '').split(':')[0];
      const e = by.get(cik) || { cik, name: cleanName(m[1] || dn), tickers: (m[2] || '').split(/,\s*/).filter(Boolean), filings: new Set(), forms: new Set(), last: '', url: '' };
      e.filings.add(adsh); e.forms.add(s.form || s.root_forms?.[0] || '');
      if ((s.file_date || '') > e.last) { e.last = s.file_date || ''; e.url = file ? `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, '')}/${file}` : ''; e.form = s.form; }
      by.set(cik, e);
    }
    return [...by.values()].map(e => ({ ...e, sym: e.tickers[0] || null, filings: e.filings.size, forms: [...e.forms].filter(Boolean) }))
      .sort((a, b) => b.filings - a.filings || b.last.localeCompare(a.last)).slice(0, 40);
  }
  async function namesFor(sym) {
    const c = await cikFor(sym);
    return { c, names: (ALIAS[sym] || [cleanName(c?.name || sym)]).slice(0, 2) };
  }

  // ------------------------------------------------------------ routes: SPLC, SEG, filing excerpts
  async function splc(p) {
    const sym = symOf(p);
    return cached('splc:' + sym, 12 * 3600e3, async () => {
      const { c, names } = await namesFor(sym);
      if (!c) throw fail(`${sym} is not an SEC registrant, so its supply chain can't be traced through EDGAR filings`, 404);
      const [rep, sup, cus, comp] = await Promise.allSettled([annual(sym), related(names, 'suppliers', c.cik), related(names, 'customers', c.cik), related(names, 'competitors', c.cik)]);
      const r = rep.value;
      const custRev = r?.groups?.find(g => g.kind === 'customer');
      return {
        sym, name: r?.name || c.name, cik: c.cik, names,
        filing: r ? { form: r.form, filed: r.filed, period: r.period, doc: r.doc, index: r.index } : null, filingErr: rep.reason?.message || null,
        disclosed: r?.conc || [], customerRevenue: custRev || null,
        suppliers: sup.value || [], customers: cus.value || [], competitors: comp.value || [],
        errs: [sup, cus, comp].map(x => x.reason?.message).filter(Boolean),
      };
    });
  }
  async function seg(p) {
    const sym = symOf(p);
    const r = await annual(sym);
    return { sym, name: r.name, form: r.form, filed: r.filed, period: r.period, doc: r.doc, index: r.index, groups: r.groups, total: r.total, note: r.note || null };
  }
  // Sentences in a filing that name the company in a customer / supplier / competitor context
  async function splcwhy(p) {
    const url = String(p.get('url') || ''), sym = symOf(p), kind = p.get('kind');
    if (!/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+\/[\w.-]+$/.test(url)) throw fail('bad filing url', 400);
    if (!PHRASES[kind]) throw fail('bad kind', 400);
    return cached(`why:${url}:${sym}:${kind}`, 24 * 3600e3, async () => {
      const { names } = await namesFor(sym);
      const text = htmlText(await sec(url, 'text', 25000)), low = text.toLowerCase();
      const phrases = names.flatMap(n => PHRASES[kind](n)).map(x => x.toLowerCase());
      const hits = [];
      for (const ph of phrases) {
        let at = 0;
        while (hits.length < 6 && (at = low.indexOf(ph, at)) >= 0) {
          const a = Math.max(0, at - 320), b = Math.min(text.length, at + ph.length + 380);
          const s0 = text.lastIndexOf('. ', at), e0 = text.indexOf('. ', at + ph.length);
          const s = s0 >= a ? s0 + 2 : a, e = e0 >= 0 && e0 < b ? e0 + 1 : b;
          const ex = text.slice(s, e).trim();
          if (!hits.some(h => h.text === ex)) hits.push({ phrase: ph, text: (s > a || s === 0 ? '' : '… ') + ex + (e === b ? ' …' : '') });
          at += ph.length;
        }
      }
      return { url, hits };
    });
  }

  // ------------------------------------------------------------ equity research (Yahoo Finance)
  function compRow(sym, r) {
    const pr = r.price || {}, sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {}, fd = r.financialData || {}, ap = r.assetProfile || {};
    return {
      sym, name: pr.shortName || pr.longName || sym, ccy: pr.currency || '', price: rv(pr.regularMarketPrice), pct: rv(pr.regularMarketChangePercent),
      mcap: rv(pr.marketCap), ev: rv(ks.enterpriseValue), pe: rv(sd.trailingPE), fpe: rv(sd.forwardPE) ?? rv(ks.forwardPE), peg: rv(ks.pegRatio) ?? rv(ks.trailingPegRatio),
      ps: rv(sd.priceToSalesTrailing12Months), pb: rv(ks.priceToBook), evRev: rv(ks.enterpriseToRevenue), evEbitda: rv(ks.enterpriseToEbitda),
      gm: rv(fd.grossMargins), om: rv(fd.operatingMargins), nm: rv(fd.profitMargins), roe: rv(fd.returnOnEquity), roa: rv(fd.returnOnAssets),
      revG: rv(fd.revenueGrowth), epsG: rv(fd.earningsGrowth), dy: rv(sd.dividendYield), beta: rv(sd.beta), w52: rv(ks['52WeekChange']), de: rv(fd.debtToEquity),
      rev: rv(fd.totalRevenue), ebitda: rv(fd.ebitda), fcf: rv(fd.freeCashflow), cash: rv(fd.totalCash), debt: rv(fd.totalDebt), shares: rv(ks.sharesOutstanding),
      rec: rv(fd.recommendationMean), recKey: fd.recommendationKey || '', tgt: rv(fd.targetMeanPrice), n: rv(fd.numberOfAnalystOpinions),
      sector: ap.sector || '', industry: ap.industry || '',
    };
  }
  const compOne = sym => cached('cmp:' + sym, 3600e3, async () => {
    const j = await yahoo(`/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=price,summaryDetail,defaultKeyStatistics,financialData,assetProfile`, true);
    const r = j?.quoteSummary?.result?.[0];
    if (!r) throw fail('no data for ' + sym, 404);
    return compRow(sym, r);
  });
  async function comps(p) {
    const syms = [...new Set(String(p.get('symbols') || '').toUpperCase().split(',').map(s => s.trim()).filter(s => /^[A-Z0-9.^=-]{1,12}$/.test(s)))].slice(0, 15);
    if (!syms.length) throw fail('missing ?symbols=', 400);
    const rows = await mapLimit(syms, 4, s => compOne(s).catch(e => ({ sym: s, err: e.message })));
    return { rows };
  }
  async function peersOf(sym) {
    return cached('peers:' + sym, 24 * 3600e3, async () => {
      const j = await yahoo(`/v6/finance/recommendationsbysymbol/${encodeURIComponent(sym)}`);
      return (j?.finance?.result?.[0]?.recommendedSymbols || []).map(x => x.symbol).filter(Boolean).slice(0, 10);
    });
  }
  function mapInsights(res) {
    const ii = res?.instrumentInfo || {}, te = ii.technicalEvents || {}, kt = ii.keyTechnicals || {}, va = ii.valuation || {};
    const out = o => o ? { dir: o.direction || '', score: o.score ?? null, desc: o.scoreDescription || o.stateDescription || '', sector: o.sectorDirection || '', index: o.indexDirection || '' } : null;
    const cs = res?.companySnapshot || {};
    return {
      tech: { provider: te.provider || '', short: out(te.shortTermOutlook || te.shortTerm), mid: out(te.intermediateTermOutlook || te.midTerm), long: out(te.longTermOutlook || te.longTerm), support: kt.support ?? null, resistance: kt.resistance ?? null, stop: kt.stopLoss ?? null },
      valuation: va.description ? { desc: va.description, discount: va.discount || '', rel: va.relativeValue || '', provider: va.provider || '' } : null,
      snapshot: cs.company ? { sector: cs.sectorInfo || '', company: cs.company, sectorAvg: cs.sector || {} } : null,
      rec: res?.recommendation ? { provider: res.recommendation.provider || '', rating: res.recommendation.rating || '', target: res.recommendation.targetPrice ?? null } : null,
      reports: (res?.reports || []).slice(0, 25).map(r => ({
        id: r.id, title: r.reportTitle || r.title || '', provider: r.provider || '', date: r.reportDate || '', type: r.reportType || '',
        rating: r.investmentRating || '', target: r.targetPrice ?? null, targetStatus: r.targetPriceStatus || '', summary: htmlText(r.headHtml || r.summary || '').slice(0, 700),
      })),
      sigDevs: (res?.sigDevs || []).slice(0, 20).map(s => ({ headline: s.headline || '', date: s.date || '' })),
      filings: (res?.secReports || []).slice(0, 12).map(s => ({ title: s.title || '', type: s.formType || s.type || '', date: s.filingDate ?? null, desc: htmlText(s.description || '').slice(0, 300), url: s.snapshotUrl || '' })),
    };
  }
  async function research(p) {
    const sym = symOf(p);
    return cached('rsch:' + sym, 1800e3, async () => {
      const e = encodeURIComponent(sym);
      const [ins, qs, peers] = await Promise.allSettled([
        yahoo(`/ws/insights/v2/finance/insights?symbol=${e}`, true),
        yahoo(`/v10/finance/quoteSummary/${e}?modules=upgradeDowngradeHistory,recommendationTrend,financialData,defaultKeyStatistics,summaryDetail,price,assetProfile,earningsTrend,esgScores,calendarEvents`, true),
        peersOf(sym),
      ]);
      const r = qs.value?.quoteSummary?.result?.[0];
      if (!r) throw qs.reason || fail('No research data for ' + sym, 404);
      const fd = r.financialData || {}, ap = r.assetProfile || {}, es = r.esgScores || {};
      return {
        sym, ...compRow(sym, r),
        profile: { sector: ap.sector || '', industry: ap.industry || '', employees: ap.fullTimeEmployees ?? null, country: ap.country || '', website: ap.website || '', summary: ap.longBusinessSummary || '' },
        rating: { key: fd.recommendationKey || '', score: rv(fd.recommendationMean), n: rv(fd.numberOfAnalystOpinions), target: { mean: rv(fd.targetMeanPrice), median: rv(fd.targetMedianPrice), high: rv(fd.targetHighPrice), low: rv(fd.targetLowPrice) } },
        trend: r.recommendationTrend?.trend || [],
        actions: (r.upgradeDowngradeHistory?.history || []).slice(0, 80).map(h => ({ t: h.epochGradeDate, firm: h.firm, to: h.toGrade || '', from: h.fromGrade || '', action: h.action || '', pt: h.currentPriceTarget ?? null, prior: h.priorPriceTarget ?? null, ptAction: h.priceTargetAction || '' })),
        estimates: (r.earningsTrend?.trend || []).map(t => ({ period: t.period, end: t.endDate || '', growth: rv(t.growth), eps: rv(t.earningsEstimate?.avg), epsLow: rv(t.earningsEstimate?.low), epsHigh: rv(t.earningsEstimate?.high), rev: rv(t.revenueEstimate?.avg), revG: rv(t.revenueEstimate?.growth), n: rv(t.earningsEstimate?.numberOfAnalysts), up30: rv(t.epsRevisions?.upLast30days), down30: rv(t.epsRevisions?.downLast30days) })),
        esg: es.totalEsg ? { total: rv(es.totalEsg), env: rv(es.environmentScore), soc: rv(es.socialScore), gov: rv(es.governanceScore), pct: rv(es.percentile), peer: es.peerGroup || '', year: es.ratingYear ?? null, controversy: es.highestControversy ?? null } : null,
        earningsDate: (r.calendarEvents?.earnings?.earningsDate || []).map(rv).filter(Boolean),
        insights: ins.value?.finance?.result ? mapInsights(ins.value.finance.result) : null, insightsErr: ins.reason?.message || null,
        peers: peers.value || [],
      };
    });
  }

  return { splc, seg, splcwhy, research, comps };
};
