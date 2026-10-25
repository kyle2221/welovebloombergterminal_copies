// Company research: supply chain (who a company sells to, buys from and competes with), revenue by
// segment, product, geography and customer, and equity research (ratings, price targets, analyst actions,
// independent research reports, technical outlook, ESG, peer valuation multiples).
// Sources: the company's latest annual report in XBRL (SEC EDGAR), EDGAR full-text search of other
// companies' filings that name it, and Yahoo Finance.
'use strict';

// ------------------------------------------------------------ reading relationships out of another company's filing
// Each sentence that names the company is classified from the filer's side by the cue nearest the name:
// "suppliers" = the filer sells to the company, "customers" = the filer buys from it. A cue only counts when the
// name sits on the right side of it ("we rely on NVIDIA", not "NVIDIA relies on suppliers"):
// 'after' = name follows the cue, 'before' = name precedes it, 'any' = either, close by. The last number is how
// far (in characters) the name may be from the cue: lists after "competitors include" run long, a bare
// "our competitors" has to be right next to the name.
const CUES = [
  ['competitors', 'after', /\bcompetitors?,?\s+(\w+\s+){0,3}(such as|including|include|includes|are|like)\b/, 450],
  ['competitors', 'after', /\bcompet(e|es|ing)\s+(\w+\s+){0,2}(with|against)\b|\bcompetition (from|with)\b/, 200],
  ['competitors', 'after', /\b(our|primary|principal|main|key|major|significant|direct)\s+(\w+\s+){0,2}competitors?\b/, 70],
  ['suppliers', 'after', /\bcustomers?,?\s+(such as|including|include|includes|like|are)\b|\b(sales|sold|shipments?)\s+(\w+\s+){0,2}to\b|\brevenues?\s+(\w+\s+){0,3}from\b|\bsupply agreements?\s+with\b/, 220],
  ['suppliers', 'before', /\b(accounted for|represented|comprised)\b[^.]{0,50}\b(revenues?|sales)\b/, 140],
  ['suppliers', 'any', /\b(largest|significant|major|key|principal|top|biggest|ten largest)\s+(\w+\s+){0,2}customers?\b/, 140],
  ['customers', 'after', /\b(suppliers?|vendors?|manufacturers?|providers?),?\s+(\w+\s+){0,2}(such as|including|include|includes|like)\b|\bpurchas(e|es|ed|ing)\b[^.]{0,60}\bfrom\b|\bprocure[sd]?\b|\bsourced?\b[^.]{0,30}\bfrom\b|\b(manufactured|supplied|produced) (for us )?by\b|\b(technolog(y|ies)|components?|parts|chips|hardware)\s+(\w+\s+)?provided by\b|\b(we|company)\s+(\w+\s+){0,2}(rel(y|ies)|depend)\s+(\w+\s+){0,2}on\b|\b(dependent|reliant|dependence|reliance)\s+(up)?on\b|\b(GPUs?|chips?|processors?|accelerators?)\s+from\b/, 220],
  ['customers', 'before', /\bas (a|our|its|the) (\w+\s+){0,2}(supplier|vendor|manufacturer)\b/, 140],
  ['customers', 'any', /\b(key|major|sole|single|primary|main|principal|largest|limited number of|one)\s+(\w+\s+){0,2}(suppliers?|vendors?)\b|\baccounted for\b[^.]{0,80}\bpurchases\b/, 140],
  ['partners', 'after', /\b(partnerships?|collaborations?|alliances?|joint development|co-develop\w*|(strategic|collaboration|license) agreements?)\b[^.]{0,40}\bwith\b|\bpartnered with\b|\bpartners?,?\s+(such as|including|like|include)\b|\bwith global technology leaders\b/, 450],
  ['partners', 'any', /\b(strategic partnership|preferred partner|partner network|cloud partner)\b/, 140],
];
const REL_KINDS = ['customers', 'suppliers', 'competitors', 'partners'];
const reEsc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// case-sensitive (Apple, not apple), in the spellings filings use: NVIDIA / Nvidia, Apple / APPLE
const nameRegex = names => new RegExp(`\\b(${[...new Set(names.flatMap(n => [n, n.toUpperCase(), n.charAt(0).toUpperCase() + n.slice(1).toLowerCase()]))].map(reEsc).join('|')})\\b`, 'g');
function nameSentences(text, re) {
  const out = [];
  for (const m of text.matchAll(re)) {
    if (out.length >= 60) break;
    const at = m.index, a = Math.max(0, at - 350), b = Math.min(text.length, at + 400);
    const s0 = text.lastIndexOf('. ', at), e0 = text.indexOf('. ', at + m[0].length);
    const st = s0 >= a ? s0 + 2 : a, en = e0 >= 0 && e0 < b ? e0 + 1 : b;
    const t = (st === a && a > 0 ? '… ' : '') + text.slice(st, en).trim() + (en === b && b < text.length ? ' …' : '');
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
function relOf(t, re) {
  const names = [...t.matchAll(re)].map(m => [m.index, m.index + m[0].length]);
  if (!names.length) return null;
  let best = null, bd = Infinity;
  for (const [k, dir, cue, lim] of CUES) for (const m of t.matchAll(new RegExp(cue.source, 'gi'))) {
    const c0 = m.index, c1 = m.index + m[0].length;
    for (const [n0, n1] of names) {
      // distance from the cue to the name on the allowed side
      const d = dir === 'after' ? (n0 >= c0 ? Math.max(0, n0 - c1) : Infinity) : dir === 'before' ? (n1 <= c1 ? Math.max(0, c0 - n1) : Infinity) : Math.max(0, n0 > c1 ? n0 - c1 : c0 - n1);
      if (d <= lim && d - (k === 'competitors' ? 30 : 0) < bd) { bd = d - (k === 'competitors' ? 30 : 0); best = k; }
    }
  }
  return best;
}

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
      // a region, product or segment share is not a counterparty, even when tagged as customer concentration
      const side = /Geograph|ProductOrService|Segment/i.test(A) ? 'other'
        : /Supplier|Vendor/i.test(T + A) || /Cost|Purchase|Inventor|Payable/i.test(B) ? 'supplier'
        : /Customer/i.test(T + A) || (!ent && /Revenue|Sales|Receivable/i.test(B)) ? 'customer'
          : /Revenue|Sales|Receivable/i.test(B) && /Customer|Client|Distributor|Partner|Reseller/i.test(ent?.[1] || '') ? 'customer' : 'other';
      const who = ent ? label(ent[1]) : 'Largest customer (not named)';
      best.set(key, {
        who, m: ent?.[1] || null, axis: ent ? label(ent[0]) : '', side, anon: !ent || /^(customer|distributor|direct customer|indirect customer|vendor|supplier)s?\s*([a-z0-9]|one|two|three|four|five)?$|^(one|two|three|four|five|single|largest|other)\b|\b(customers|distributors|vendors|suppliers)$/i.test(who),
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
      const label = qn => (/^country:/.test(qn) ? null : L.get(String(qn).replace(':', '_'))?.text) || humanize(qn);
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
  const ymd = d => d.toISOString().slice(0, 10);
  async function efts(q, forms, from = 0) {
    const end = new Date(), start = new Date(Date.now() - 548 * 864e5);
    const j = await sec(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}&forms=${forms}&dateRange=custom&startdt=${ymd(start)}&enddt=${ymd(end)}${from ? '&from=' + from : ''}`, 'json', 15000);
    return { total: j.hits?.total?.value ?? 0, hits: j.hits?.hits || [] };
  }
  // Wording a filing uses when the company is its customer, supplier or competitor; filings with these phrases are
  // read first, ahead of filings that merely mention the name a lot (app developers mentioning "Apple App Store")
  const SEEDS = n => [`${n} accounted for`, `${n} Inc. accounted for`, `${n} Corporation accounted for`, `sales to ${n}`, `revenue from ${n}`, `customers include ${n}`, `customers such as ${n}`, `customers, including ${n}`,
    `rely on ${n}`, `purchased from ${n}`, `manufactured by ${n}`, `supplied by ${n}`, `compete with ${n}`, `competitors include ${n}`, `competitors such as ${n}`, `competitors, including ${n}`];
  const FORMS = '10-K,20-F,40-F,S-1,F-1';
  // Filers whose recent annual reports / prospectuses describe a relationship with the company, read and classified
  async function scanFilings(names, selfCik) {
    const t0 = Date.now();
    const qs = [...SEEDS(names[0]).map(x => [`"${x}"`, 0, 1]), ...names.flatMap(n => [0, 100].map(from => [`"${n}"`, from, 0]))];
    const pages = await mapLimit(qs, 4, ([q, from, seed]) => efts(q, FORMS, from).then(r => ({ ...r, seed })).catch(() => ({ total: 0, hits: [], seed })));
    // a filer named like the company (Apple Hospitality, Target Hospitality) is a different business
    const same = new RegExp(`\\b(${names.map(reEsc).join('|')})\\b`, 'i');
    const by = new Map();
    for (const r of pages) for (const h of r.hits) {
      const s = h._source || {}, cik = String(Number((s.ciks || [])[0] || 0)), file = String(h._id || '').split(':')[1] || '';
      if (by.has(cik)) { by.get(cik).seed += r.seed; continue; }
      // asset-backed trusts (SIC 6189) name tenants and borrowers, not business relationships
      if (cik === '0' || cik === String(selfCik) || !file || /^EX-/i.test(s.file_type || '') || (s.sics || []).includes('6189')) continue;
      const dn = (s.display_names || [])[0] || '', m = dn.match(/^(.*?)\s*(?:\(([^)]*)\))?\s*\(CIK\s*(\d+)\)\s*$/) || [];
      const name = cleanName(m[1] || dn);
      if (same.test(name)) continue;
      const adsh = s.adsh || String(h._id).split(':')[0];
      by.set(cik, {
        cik, name, sym: (m[2] || '').split(/,\s*/).filter(Boolean)[0] || null, form: s.form || s.file_type || '', last: s.file_date || '',
        url: `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, '')}/${file}`, rel: {}, n: 0, seed: r.seed,
      });
    }
    // seeded filers first (most phrase hits first), then by full-text relevance; sort is stable
    const cands = [...by.values()].sort((a, b) => b.seed - a.seed).slice(0, 30), re = nameRegex(names);
    await mapLimit(cands, 6, async c => {
      if (Date.now() - t0 > 17000) { c.skip = true; return; }
      try {
        const sents = nameSentences(htmlText(await sec(c.url, 'text', 8000)), re);
        c.n = sents.length;
        for (const t of sents) { const k = relOf(t, re); if (k) (c.rel[k] = c.rel[k] || []).push(t); }
      } catch (e) { c.err = e.message; }
    });
    const out = { found: by.size, scanned: cands.filter(c => !c.skip && !c.err).length };
    for (const k of REL_KINDS) {
      out[k] = cands.filter(c => c.rel[k]?.length).map(c => ({ cik: c.cik, name: c.name, sym: c.sym, form: c.form, last: c.last, url: c.url, n: c.rel[k].length, total: c.n, ex: c.rel[k].slice(0, 3).map(t => t.slice(0, 600)) }))
        .sort((x, y) => y.n - x.n || y.total - x.total);
    }
    return out;
  }
  async function namesFor(sym) {
    const c = await cikFor(sym);
    return { c, names: (ALIAS[sym] || [cleanName(c?.name || sym)]).slice(0, 2) };
  }

  // ------------------------------------------------------------ routes: SPLC, SEG
  async function splc(p) {
    const sym = symOf(p);
    return cached('splc:' + sym, 12 * 3600e3, async () => {
      const { c, names } = await namesFor(sym);
      if (!c) throw fail(`${sym} is not an SEC registrant, so its supply chain can't be traced through EDGAR filings`, 404);
      const [rep, rel] = await Promise.allSettled([annual(sym), scanFilings(names, c.cik)]);
      const r = rep.value, x = rel.value || {};
      return {
        sym, name: r?.name || c.name, cik: c.cik, names,
        filing: r ? { form: r.form, filed: r.filed, period: r.period, doc: r.doc, index: r.index } : null, filingErr: rep.reason?.message || null,
        disclosed: r?.conc || [], customerRevenue: r?.groups?.find(g => g.kind === 'customer') || null,
        customers: x.customers || [], suppliers: x.suppliers || [], competitors: x.competitors || [], partners: x.partners || [],
        found: x.found ?? 0, scanned: x.scanned ?? 0, errs: rel.reason ? [rel.reason.message] : [],
      };
    });
  }
  async function seg(p) {
    const sym = symOf(p);
    const r = await annual(sym);
    return { sym, name: r.name, form: r.form, filed: r.filed, period: r.period, doc: r.doc, index: r.index, groups: r.groups, total: r.total, note: r.note || null };
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

  return { splc, seg, research, comps };
};
module.exports.text = { relOf, nameRegex, nameSentences };
