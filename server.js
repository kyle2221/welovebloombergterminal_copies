#!/usr/bin/env node
// Local server for the terminal (Node 18+, zero dependencies).
// Serves index.html and the /api/* market-data endpoints from lib/market.js.
//
//   node server.js            -> http://localhost:8080
//   PORT=3000 node server.js
//
// On Vercel, api/[name].js serves the same endpoints instead.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ROUTES, handle } = require('./lib/market');

const PORT = Number(process.env.PORT) || 8080;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const ROOT = __dirname;

const server = http.createServer(async (rq, rs) => {
  const url = new URL(rq.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const { status, body } = await handle(url.pathname.slice(5), url.searchParams);
    rs.writeHead(status, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return rs.end(JSON.stringify(body));
  }
  let file = path.normalize(path.join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT) || path.basename(file).startsWith('.') || !['.html', '.css', '.js', '.svg', '.png', '.ico', '.json'].includes(path.extname(file)) || file.endsWith('server.js') || file.includes(path.sep + 'lib' + path.sep) || file.includes(path.sep + 'api' + path.sep)) { rs.writeHead(403); return rs.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { rs.writeHead(404); return rs.end('Not found'); }
    rs.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    rs.end(buf);
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Terminal running at http://localhost:${PORT}`));
}
module.exports = { server, ROUTES };
