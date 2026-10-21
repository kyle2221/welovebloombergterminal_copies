// SEC EDGAR access shared by the insider module (edge.js) and the company-research module (research.js).
// The SEC asks automated clients to identify themselves with a contact address in the User-Agent
// ("Company Name contact@example.com") and to stay under 10 requests per second; requests without a
// contact are refused with 403. Set SEC_USER_AGENT to your own name and email.
'use strict';

module.exports = ({ cached, get }) => {
  const UA = process.env.SEC_USER_AGENT || 'MarketTerminal/1.0 open-source research terminal (github.com/kyle2221/welovebloombergterminal_copies)';
  const fail = (msg, status = 502) => { const e = new Error(msg); e.status = status; return e; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let next = 0;
  async function sec(url, type = 'json', ms = 15000) {
    const now = Date.now(), wait = Math.max(0, next - now);
    next = Math.max(now, next) + 130;
    if (wait) await sleep(wait);
    const r = await get(url, { 'User-Agent': UA, Accept: type === 'json' ? 'application/json' : '*/*' }, ms);
    if (r.status === 403) throw fail(process.env.SEC_USER_AGENT ? 'SEC EDGAR 403' : 'SEC EDGAR 403: the SEC requires a contact email; set SEC_USER_AGENT="Your Name you@example.com"');
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
  const submissions = cik => cached('sec:sub:' + cik, 3600e3, () => sec(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`));
  return { sec, tickerMap, cikFor, submissions };
};
