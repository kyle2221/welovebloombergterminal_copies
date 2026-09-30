// Vercel serverless function: /api/quotes, /api/chart, /api/summary, ... (see lib/market.js)
'use strict';
const { handle } = require('../lib/market');

// Short CDN caching keeps Yahoo request volume low when many people use the deployment.
const CDN_TTL = { quotes: 3, chart: 30, news: 60, screener: 60, search: 60, summary: 300, fin: 3600, ust: 3600, ping: 0 };

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
