// "Edge" data: insider trading (SEC Form 4), congressional trade filings, institutional holders,
// options flow, short volume, macro series, prediction markets, sentiment, calendars, vessel tracking.
// All sources are public; only legally disclosed information is used.
'use strict';
const zlib = require('zlib');

module.exports = ({ cached, get, yahoo, mapQuote, req, digitraffic, aisGlobal, aisstream, secApi }) => {
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
  const { sec, cikFor } = secApi;
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
  // Market-wide insider trades from OpenInsider (parsed SEC Form 4 data, no key needed)
  const OI_PAGES = { buys: 'latest-insider-purchases-25k', sells: 'latest-insider-sales-100k', cluster: 'latest-cluster-buys', officers: 'latest-officer-purchases-25k', all: 'latest-insider-trading' };
  const stripHtml = h => unxml(String(h).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')).replace(/\s+/g, ' ').trim();
  async function openInsider(p) {
    const kind = OI_PAGES[p.get('kind')] ? p.get('kind') : 'buys';
    return cached('oi:' + kind, 10 * 60e3, async () => {
      const r = await get(`http://openinsider.com/${OI_PAGES[kind]}`, { Accept: 'text/html' }, 20000);
      if (!r.ok) throw fail('OpenInsider ' + r.status);
      const html = await r.text();
      const t = html.match(/<table[^>]*class="tinytable"[^>]*>([\s\S]*?)<\/table>/);
      if (!t) throw fail('OpenInsider page format changed');
      const heads = [...t[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => stripHtml(m[1]).toLowerCase());
      const col = name => heads.findIndex(h => h.replace(/[^a-z0-9]/g, '') === name);
      const C = { filed: col('filingdate'), trade: col('tradedate'), sym: col('ticker'), company: col('companyname'), insider: col('insidername'), title: col('title'), type: col('tradetype'), price: col('price'), qty: col('qty'), owned: col('owned'), down: Math.max(col('own'), col('deltaown')), value: col('value'), ins: col('ins'), ind: col('industry') };
      const body = t[1].split(/<\/thead>/i).pop();
      const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => stripHtml(c[1]))).filter(r => r.length > 5);
      const g = (r, k) => (C[k] >= 0 ? r[C[k]] : '') || '';
      return {
        kind, src: 'OpenInsider (SEC Form 4 filings)', t: Date.now(),
        rows: rows.slice(0, 200).map(r => ({
          filed: g(r, 'filed'), trade: g(r, 'trade'), sym: ((g(r, 'sym').match(/([A-Za-z][A-Za-z0-9.\-]*)\s*$/) || [])[1] || '').toUpperCase().replace(/\.$/, ''), company: g(r, 'company'), insider: g(r, 'insider'), title: g(r, 'title'),
          type: g(r, 'type'), price: num(g(r, 'price').replace('$', '')), qty: num(g(r, 'qty')), owned: num(g(r, 'owned')), down: g(r, 'down'), value: num(g(r, 'value').replace('$', '')),
          insiders: num(g(r, 'ins')), industry: g(r, 'ind'),
        })),
      };
    });
  }
  // Market-wide: the most recent Form 4 filings straight from EDGAR (needs SEC_USER_AGENT with a contact email)
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

  // Minimal PDF text extraction for House e-filed PTRs: resolves Type0/Identity-H fonts through
  // their ToUnicode CMaps and rebuilds text lines from coordinates.
  function pdfLines(buf) {
    const s = buf.toString('latin1'), objs = new Map();
    const re = /(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g;
    let m;
    while ((m = re.exec(s))) {
      const body = m[2], bodyStart = m.index + m[0].length - 6 - body.length;
      const sm = body.match(/stream\r?\n/);
      let dict = body, data = null;
      if (sm && /^\s*<</.test(body)) {
        dict = body.slice(0, sm.index);
        const start = bodyStart + sm.index + sm[0].length, end = s.indexOf('endstream', start);
        let raw = buf.subarray(start, end < 0 ? start : end);
        if (/\/FlateDecode/.test(dict)) { try { raw = zlib.inflateSync(raw); } catch { try { raw = zlib.inflateSync(raw.subarray(0, raw.length - 2)); } catch { raw = null; } } }
        data = raw;
      }
      objs.set(Number(m[1]), { dict, data });
    }
    const utf16 = h => { let o = ''; for (let k = 0; k + 3 < h.length; k += 4) { const c = parseInt(h.slice(k, k + 4), 16); if (c) o += String.fromCharCode(c); } return o; };
    const cmapOf = txt => {
      const map = new Map();
      for (const b of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const x of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(parseInt(x[1], 16), utf16(x[2]));
      for (const b of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
        for (const x of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
          const lo = parseInt(x[1], 16), hi = Math.min(parseInt(x[2], 16), lo + 5000);
          if (x[3]) { const base = parseInt(x[3], 16); for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(base + c - lo)); }
          else { const arr = [...x[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map(y => utf16(y[1])); for (let c = lo; c <= hi; c++) map.set(c, arr[c - lo] || ''); }
        }
      }
      return map;
    };
    const fontMaps = new Map(); // font object id -> cmap
    for (const [id, o] of objs) {
      const tu = o.dict.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
      if (/\/Type\s*\/Font/.test(o.dict) && tu) { const c = objs.get(Number(tu[1])); if (c?.data) fontMaps.set(id, cmapOf(c.data.toString('latin1'))); }
    }
    const fontNames = new Map(); // resource name -> font object id
    const addFonts = txt => { for (const f of txt.matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+0\s+R/g)) if (fontMaps.has(Number(f[2])) || /\/Type\s*\/Font/.test(objs.get(Number(f[2]))?.dict || '')) fontNames.set(f[1], Number(f[2])); };
    for (const [, o] of objs) {
      for (const f of o.dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) addFonts(f[1]);
      const ind = o.dict.match(/\/Font\s+(\d+)\s+0\s+R/); if (ind) addFonts(objs.get(Number(ind[1]))?.dict || '');
    }
    const unesc = str => str.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (x, c) => ({ n: '\n', r: '', t: ' ', b: '', f: '', '(': '(', ')': ')', '\\': '\\' }[c] ?? String.fromCharCode(parseInt(c, 8))));
    const runs = [];
    let page = 0;
    for (const [, o] of objs) {
      if (!o.data) continue;
      const txt = o.data.toString('latin1');
      if (!/\bBT\b/.test(txt) || !/(Tj|TJ)/.test(txt)) continue;
      page++;
      let cmap = null, x = 0, y = 0, lx = 0, ly = 0;
      const decode = (lit, hex) => {
        if (hex != null) { const h = hex.replace(/\s+/g, ''); if (cmap) { let out = ''; for (let k = 0; k + 3 < h.length; k += 4) out += cmap.get(parseInt(h.slice(k, k + 4), 16)) ?? ''; return out; } let out = ''; for (let k = 0; k + 1 < h.length; k += 2) out += String.fromCharCode(parseInt(h.slice(k, k + 2), 16)); return out; }
        const str = unesc(lit);
        if (cmap) { let out = ''; for (let k = 0; k + 1 < str.length; k += 2) out += cmap.get(str.charCodeAt(k) * 256 + str.charCodeAt(k + 1)) ?? ''; return out; }
        return str;
      };
      const tok = /\/([A-Za-z0-9_.+-]+)\s+-?[\d.]+\s+Tf|\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*(?:Tj|'|")|<([0-9A-Fa-f\s]*)>\s*Tj|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|(-?[\d.]+)\s+(-?[\d.]+)\s+T[dD]|\bT\*|\bBT\b/g;
      let t;
      while ((t = tok.exec(txt))) {
        if (t[1] != null) { const fid = fontNames.get(t[1]); cmap = fid != null ? fontMaps.get(fid) || null : null; continue; }
        if (t[9] != null) { x = lx = Number(t[9]); y = ly = Number(t[10]); continue; }
        if (t[11] != null) { lx += Number(t[11]); ly += Number(t[12]); x = lx; y = ly; continue; }
        if (t[0] === 'T*') { ly -= 12; y = ly; x = lx; continue; }
        if (t[0] === 'BT') { x = lx = 0; y = ly = 0; continue; }
        let str = '';
        if (t[2] != null) { for (const q of t[2].matchAll(/\(((?:[^)\\]|\\.)*)\)|<([0-9A-Fa-f\s]*)>|(-?[\d.]+)/g)) { if (q[1] != null) str += decode(q[1]); else if (q[2] != null) str += decode(null, q[2]); else if (Number(q[3]) < -200) str += ' '; } }
        else if (t[3] != null) str = decode(t[3]);
        else if (t[4] != null) str = decode(null, t[4]);
        if (str.trim()) runs.push({ p: page, x, y, s: str });
        x += str.length * 5;
      }
    }
    runs.sort((a, b) => a.p - b.p || b.y - a.y || a.x - b.x);
    const lines = [];
    let cur = null;
    for (const r of runs) {
      if (!cur || cur.p !== r.p || Math.abs(cur.y - r.y) > 2.5) { cur = { p: r.p, y: r.y, parts: [] }; lines.push(cur); }
      cur.parts.push(r);
    }
    return lines.map(l => l.parts.sort((a, b) => a.x - b.x).map(r => r.s).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  }
  async function ptr(p) {
    const doc = String(p.get('doc') || ''), yr = Number(p.get('yr')) || new Date().getUTCFullYear();
    if (!/^\d{6,9}$/.test(doc)) throw fail('invalid ?doc=', 400);
    return cached(`ptr:${yr}:${doc}:${p.get('debug') || ''}`, 7 * 24 * 3600e3, async () => {
      const r = await get(`https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${yr}/${doc}.pdf`, {}, 20000);
      if (!r.ok) throw fail('House Clerk ' + r.status, r.status === 404 ? 404 : 502);
      const buf = Buffer.from(await r.arrayBuffer());
      const lines = pdfLines(buf);
      if (p.get('debug') === '1') return { lines: lines.slice(0, 150), size: buf.length };
      const text = lines.join('\n');
      const flat = text.replace(/\s+/g, ' ');
      const tx = [];
      // Asset names wrap across lines, so the ticker "(XYZ) [ST]" can come before or after the name;
      // bonds and funds may have no ticker, and the amount's upper bound can sit on the line above.
      const re = /([^()\[\]]{0,120}?)\s*(?:\(([A-Z][A-Z0-9.\-]{0,7})\)\s*)?\[([A-Z]{2})\]([^()\[\]]{0,160}?)\b(P|S \(partial\)|S|E)\s+(\d{2}\/\d{2}\/\d{4})\s*(\d{2}\/\d{2}\/\d{4})\s*(\$[\d,]+\s*-\s*(?:\$[\d,]+)?|Over \$[\d,]+|\$[\d,]+\s*\+?)/g;
      const clean = t => t.replace(/^[\s\S]*N\s?ew\s+/, '').replace(/^[\s\S]*:\s+/, '').replace(/^\$[\d,]+\s*/, '').replace(/^(SP|JT|DC|Self)\s+/, '').trim();
      let m;
      while ((m = re.exec(flat))) {
        const after = clean(m[4]), before = clean(m[1]);
        let amount = m[8].replace(/\s+/g, ' ').trim();
        if (/-$/.test(amount)) { const up = m[1].match(/\$([\d,]{5,})(?![\s\S]*\$[\d,]{5,})/); amount = up ? `${amount} $${up[1]}` : amount + ' ?'; }
        tx.push({ asset: after.length > 3 ? after : before, sym: m[2] || null, kind: m[3], type: { P: 'Purchase', S: 'Sale', 'S (partial)': 'Partial sale', E: 'Exchange' }[m[5]], date: m[6], notified: m[7], amount });
      }
      return { doc, yr, tx, scanned: !text.trim(), chars: text.length };
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
          const all = [...d.calls, ...d.puts];
          const hasOI = all.some(c => c.oi > 0); // Yahoo zeroes open interest outside US market hours
          for (const [side, arr] of [['C', d.calls], ['P', d.puts]]) {
            for (const c of arr) {
              if (side === 'C') { cv += c.vol; co += c.oi; } else { pv += c.vol; po += c.oi; }
              const prem = c.vol * (c.last || 0) * 100;
              const unusual = hasOI ? c.vol >= 500 && c.vol > 2 * Math.max(c.oi, 1) && prem >= 100000 : c.vol >= 2500 && prem >= 250000;
              if (unusual) rows.push({ sym: s, side, k: c.k, exp: d.exp, vol: c.vol, oi: hasOI ? c.oi : null, last: c.last, iv: c.iv > 0.01 ? c.iv : null, prem, spot: d.spot, otm: side === 'C' ? c.k > d.spot : c.k < d.spot });
            }
          }
          stats.push({ sym: s, spot: d.spot, exp: d.exp, cv, pv, pcr: cv ? pv / cv : null, co, po, hasOI });
        } catch { /* symbol without options */ }
      });
      rows.sort((a, b) => b.prem - a.prem);
      stats.sort((a, b) => (b.cv + b.pv) - (a.cv + a.pv));
      const live = stats.some(s => s.hasOI);
      return { t: Date.now(), live, note: live ? 'Nearest expiry. Unusual = volume > 2× open interest, ≥500 contracts, ≥$100k premium.' : 'Open interest is not published outside US market hours, so these are the largest blocks by premium from the last session (≥2,500 contracts, ≥$250k).', rows: rows.slice(0, 150), stats };
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
    if (Object.values(out).every(v => v && v.error)) throw fail('FRED unavailable: ' + Object.values(out)[0].error);
    return out;
  }

  // ------------------------------------------------------------ macro: NY Fed reference rates + BLS
  const BLS_SERIES = { CUUR0000SA0: 'CPI (all items, NSA)', CUUR0000SA0L1E: 'Core CPI (NSA)', LNS14000000: 'Unemployment rate', CES0000000001: 'Nonfarm payrolls (thousands)', CES0500000003: 'Avg hourly earnings', JTS000000000000000JOL: 'JOLTS job openings (thousands)' };
  async function macro() {
    return cached('macro', 3 * 3600e3, async () => {
      const y = new Date().getUTCFullYear();
      const [effr, sofr, bls] = await Promise.allSettled([
        json('https://markets.newyorkfed.org/api/rates/unsecured/effr/last/60.json'),
        json('https://markets.newyorkfed.org/api/rates/secured/sofr/last/60.json'),
        (async () => {
          const r = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'MarketTerminal/1.0' }, body: JSON.stringify({ seriesid: Object.keys(BLS_SERIES), startyear: String(y - 3), endyear: String(y) }) });
          if (!r.ok) throw fail('BLS ' + r.status);
          const j = await r.json();
          if (j.status !== 'REQUEST_SUCCEEDED') throw fail('BLS: ' + (j.message || []).join(' '));
          return j;
        })(),
      ]);
      const rates = x => (x.value?.refRates || []).map(r => ({ d: r.effectiveDate, v: Number(r.percentRate), lo: Number(r.targetRateFrom) || null, hi: Number(r.targetRateTo) || null })).filter(r => Number.isFinite(r.v)).reverse();
      const series = {};
      for (const s of bls.value?.Results?.series || []) {
        series[s.seriesID] = { name: BLS_SERIES[s.seriesID], data: (s.data || []).filter(d => /^M\d\d$/.test(d.period) && d.period !== 'M13').map(d => ({ d: `${d.year}-${d.period.slice(1)}`, v: Number(d.value) })).filter(d => Number.isFinite(d.v)).sort((a, b) => (a.d < b.d ? -1 : 1)) };
      }
      return { effr: rates(effr), sofr: rates(sofr), bls: series, errors: [effr.reason?.message, sofr.reason?.message, bls.reason?.message].filter(Boolean) };
    });
  }

  // ------------------------------------------------------------ prediction markets
  const KALSHI_SERIES = ['KXFEDDECISION', 'KXFED', 'KXCPIYOY', 'KXCPI', 'KXPAYROLLS', 'KXU3', 'KXGDP', 'KXRECSSNBER', 'KXINXY', 'KXNASDAQ100Y', 'KXBTCMAXY', 'KXWTIMAX', 'KXTARIFF', 'KXGOVSHUT'];
  async function predict() {
    return cached('pred', 5 * 60e3, async () => {
      const [pm, ks] = await Promise.allSettled([
        json('https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume24hr&ascending=false&limit=80'),
        (async () => {
          const K = 'https://api.elections.kalshi.com/trade-api/v2/events?status=open&with_nested_markets=true';
          const lists = await Promise.allSettled([json(K + '&limit=200'), ...KALSHI_SERIES.map(s => json(`${K}&series_ticker=${s}&limit=20`))]);
          const seen = new Set(), events = [];
          for (const l of lists) for (const e of l.value?.events || []) if (!seen.has(e.event_ticker)) { seen.add(e.event_ticker); events.push(e); }
          if (!events.length) throw fail('Kalshi unavailable');
          return { events };
        })(),
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
    const hits = all.filter(s => String(s.mmsi) === q || (s.name && s.name.toUpperCase().includes(q)) || (s.dest && s.dest.toUpperCase().includes(q)));
    return { src: 'Digitraffic (Fintraffic)', coverage: 'Baltic Sea', ships: hits.slice(0, 100) };
  }

  return {
    insiders, insiderfeed: insiderFeed, openinsider: openInsider, congress, ptr, macro, holders, options, uoa, shortvol, fred,
    predict, sentiment, ecocal, earnings, vessels, vsearch,
  };
};
