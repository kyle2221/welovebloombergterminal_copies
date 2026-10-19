// Tests for the strategy engine (engine.js): run with `npm test`.
const E = require('../engine.js');
const assert = require('assert');
let fails = 0;
const t = (name, f) => { try { f(); console.log('ok  ', name); } catch (e) { fails++; console.log('FAIL', name, '\n   ', e.message); } };
// synthetic daily data
function mk(closes, opens) {
  const n = closes.length, t0 = 1600000000;
  return { t: closes.map((_, i) => t0 + i * 86400), o: opens || closes.map((c, i) => i ? closes[i - 1] : c), h: closes.map((c, i) => Math.max(c, opens ? opens[i] : i ? closes[i - 1] : c) * 1.001), l: closes.map((c, i) => Math.min(c, opens ? opens[i] : i ? closes[i - 1] : c) * 0.999), c: closes, v: closes.map(() => 1000) };
}
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const walk = n => { const a = [100]; for (let i = 1; i < n; i++) a.push(a[i - 1] * (1 + (rnd() - 0.5) * 0.04)); return a; };
const D = mk(walk(800));
const run = (code, data = D, opt = {}) => E.backtest(E.compile(code), data, { capital: 100000, ...opt });

t('error line numbers map to user code', () => {
  try { run('const a = 1;\nfunction onBar() {\n  if (close.length > 5) nope();\n}'); assert.fail('no throw'); }
  catch (e) { const d = E.describe(e); assert.equal(d.line, 3, JSON.stringify(d)); assert.equal(d.bar, 5); }
});
t('syntax errors are reported', () => { assert.throws(() => E.compile('function onBar( {')); });
t('no look-ahead: future bars are invisible', () => {
  const r = run('function onBar(){ if (close[close.length] !== undefined) throw new Error("peeked"); if (close.length !== barIndex()+1) throw new Error("len"); }');
  assert.equal(r.trades.length, 0);
});
t('sma/ema/rsi match reference implementations', () => {
  const r = run('function onBar(){ plot(sma(close,10),"s"); plot(ema(close,10),"e"); plot(rsi(close,14),"r"); plot(highest(high,5),"h"); }');
  const c = D.c;
  for (let i = 20; i < 800; i += 37) {
    const s = c.slice(i - 9, i + 1).reduce((a, b) => a + b) / 10;
    assert(Math.abs(r.plots.s.d[i] - s) < 1e-9, 'sma ' + i);
    assert(Math.abs(r.plots.h.d[i] - Math.max(...D.h.slice(i - 4, i + 1))) < 1e-12, 'highest');
  }
  // ema reference
  let e = c.slice(0, 10).reduce((a, b) => a + b) / 10; const k = 2 / 11;
  for (let i = 10; i < 800; i++) e = k * c[i] + (1 - k) * e;
  assert(Math.abs(r.plots.e.d[799] - e) < 1e-9, 'ema');
  // wilder rsi reference
  let g = 0, l = 0; for (let i = 1; i <= 14; i++) { const d = c[i] - c[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); } g /= 14; l /= 14;
  for (let i = 15; i < 800; i++) { const d = c[i] - c[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14; }
  assert(Math.abs(r.plots.r.d[799] - (100 - 100 / (1 + g / l))) < 1e-9, 'rsi');
  assert(r.plots.s.d[8] === null && r.plots.s.d[9] !== null);
});
const XO = `const F = param('fast', 10, 5, 30, 5), SL = param('slow', 30, 20, 60, 10);
function onBar(){ const f = sma(close,F), s = sma(close,SL); if (crossover(f,s)) buy(); if (crossunder(f,s)) sell(); }`;
t('crossover strategy: fills at next open, accounting balances', () => {
  const r = run(XO, D, { commission: 0.001, slippage: 0.0005 });
  assert(r.trades.length > 3, 'trades ' + r.trades.length);
  for (const f of r.fills) { assert.equal(f.reason, 'signal'); const ref = D.o[f.i] * (1 + (f.side === 'BUY' ? 1 : -1) * 0.0005); assert(Math.abs(f.px - ref) < 1e-9, 'fill at next open'); }
  // equity change = realized trade pnl + open trade pnl
  const pnl = r.trades.reduce((s, x) => s + x.pnl, 0) + (r.openTrade ? r.openTrade.pnl : 0);
  assert(Math.abs(100000 + pnl - r.final.equity) < 1e-6, `pnl ${pnl} vs ${r.final.equity - 100000}`);
  assert.deepEqual(Object.keys(r.declared), ['fast', 'slow']);
  assert(r.stats.sharpe !== null && r.stats.maxDD <= 0 && r.stats.trades === r.trades.length + (r.openTrade ? 1 : 0));
});
t('params override', () => {
  const a = run(XO), b = run(XO, D, { params: { fast: 5, slow: 60 } });
  assert.notEqual(a.trades.length, b.trades.length);
});
t('stop loss exits at the stop price', () => {
  // flat at 100 then drop to 80
  const c = [100, 100, 100, 100, 99, 97, 94, 90, 85, 80, 80];
  const r = run('function onBar(){ if (barIndex()===1) buy({ stop: 0.05 }); }', mk(c));
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].reason, 'stop');
  assert(Math.abs(r.trades[0].exitPx - 95) < 1e-9 || r.trades[0].exitPx < 95, 'exit ' + r.trades[0].exitPx);
});
t('gap through the stop fills at the open', () => {
  const c = [100, 100, 100, 70, 70], o = [100, 100, 100, 70, 70];
  const r = run('function onBar(){ if (barIndex()===0) buy({ stop: 0.05 }); }', mk(c, o));
  assert.equal(r.trades[0].reason, 'stop'); assert(Math.abs(r.trades[0].exitPx - 70) < 1e-9);
});
t('take profit and trailing stop', () => {
  const c = [100, 100, 104, 108, 112, 109, 104, 100];
  const tp = run('function onBar(){ if (barIndex()===0) buy({ target: 0.1 }); }', mk(c));
  assert.equal(tp.trades[0].reason, 'target');
  const tr = run('function onBar(){ if (barIndex()===0) buy({ trail: 0.05 }); }', mk(c));
  assert.equal(tr.trades[0].reason, 'trail');
  assert(tr.trades[0].exitPx > 100);
});
t('per-order stop does not leak into later trades', () => {
  const c = [100, 100, 100, 94, 94, 94, 94, 80, 80];
  const r = run('function onBar(){ const k=barIndex(); if (k===0) buy({ stop: 0.05 }); if (k===4) buy(); }', mk(c));
  assert.equal(r.trades.length, 1); assert(r.openTrade, 'second position should still be open');
});
t('short selling and reversal', () => {
  const c = [100, 100, 90, 80, 80, 90, 100, 100];
  const r = run('function onBar(){ const k=barIndex(); if(k===0) short(); if(k===3) buy(); }', mk(c));
  assert.equal(r.trades[0].side, 'SHORT'); assert(r.trades[0].pnl > 0); assert(r.openTrade.side === 'LONG');
});
t('target() rebalancing band avoids churn', () => {
  const r = run('function onBar(){ target(1); }');
  assert(r.fills.length < 30, 'fills ' + r.fills.length);
});
t('fill at close mode', () => {
  const r = run('function onBar(){ if (barIndex()===3) buy(); }', D, { fillAt: 'close' });
  assert.equal(r.fills[0].i, 3); assert(Math.abs(r.fills[0].px - D.c[3]) < 1e-9);
});
t('from: no trades before the out-of-sample start', () => {
  const r = run(XO, D, { from: 400 });
  assert(r.fills.every(f => f.i >= 400)); assert.equal(r.equity[399], 100000); assert.equal(r.stats.bars, 400);
});
t('macd/bbands/atr/stoch/vwap/obv run', () => {
  const r = run('function onBar(){ const m=macd(close); const b=bbands(close,20,2); plot(m.hist,"h"); plot(b.upper,"u"); plot(atr(14),"a"); plot(stoch(14,3).k,"k"); plot(vwap(),"v"); plot(obv(),"o"); plot(wma(close,5),"w"); plot(roc(close,5),"r"); plot(stdev(close,20), "sd"); }');
  for (const k of ['h', 'u', 'a', 'k', 'v', 'o', 'w', 'r', 'sd']) assert(Number.isFinite(r.plots[k].d[799]), k);
  // nested indicators
  const n = run('function onBar(){ plot(ema(rsi(close,14),5),"x"); }');
  assert(Number.isFinite(n.plots.x.d[799]));
});
t('helpful error for sma(20)', () => {
  try { run('function onBar(){ sma(20) }'); assert.fail(); } catch (e) { assert(/first argument must be a series/.test(e.message), e.message); }
});
t('optimize with out-of-sample split', () => {
  const r = E.optimize(E.compile(XO), D, { capital: 100000 }, { fast: [5, 10, 15], slow: [30, 40] }, 0.7);
  assert.equal(r.rows.length, 6); assert(r.rows.every(x => x.is && x.oos)); assert.equal(r.cut, 560);
});
t('signal mode flushes the pending order', () => {
  const c = walk(60); const d = mk(c);
  const r = E.backtest(E.compile('function onBar(){ if (barIndex()===59) buy(); }'), d, { capital: 10000, flushPending: true });
  assert(r.final.qty > 0 && r.queued === 1);
});
t('performance: 5000 bars x 3 indicators < 300ms', () => {
  const big = mk(walk(5000)); const t0 = Date.now();
  run('function onBar(){ const a=sma(close,200), b=ema(close,50), r=rsi(close,14); if (crossover(b,a) && last(r)<70) buy(); if (crossunder(b,a)) sell(); }', big);
  const ms = Date.now() - t0; assert(ms < 300, ms + 'ms'); console.log('      ', ms + 'ms');
});
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
