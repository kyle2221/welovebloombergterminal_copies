// Vercel serverless function: /api/quotes, /api/chart, /api/summary, ... (see lib/market.js)
'use strict';
const { handle } = require('../lib/market');

// Short CDN caching keeps Yahoo request volume low when many people use the deployment.
const CDN_TTL = { quotes: 3, chart: 30, news: 60, screener: 60, search: 60, summary: 300, fin: 3600, ust: 3600, flights: 8, ships: 45, bases: 86400, eia: 3600, caps: 300, ping: 0,
  insiders: 900, insiderfeed: 300, openinsider: 300, ptr: 86400, macro: 3600, congress: 3600, holders: 3600, options: 60, uoa: 180, shortvol: 1800, fred: 3600,
  predict: 120, sentiment: 300, ecocal: 900, earnings: 1800, vessels: 30, vsearch: 60,
  air: 10, airhex: 8, airmil: 20, airsq: 20, airbiz: 120, airhubs: 120, airroute: 1800, airphoto: 86400 };

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const name = (req.query && req.query.name) || url.pathname.split('/').pop();
  const { status, body } = await handle(name, url.searchParams);
  const ttl = CDN_TTL[name] ?? 0;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', status === 200 && ttl ? `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}` : 'no-store');
  res.statusCode = status;
  res.end(JSON.stringify(body));
};
