// Strategy engine for BTST (backtesting) and BOT (paper-trading bots).
// A strategy is plain JavaScript that runs once per bar. Price series grow by one value per bar, so a
// strategy can only see the past: orders placed on a bar's close fill at the next bar's open.
// Runs as a Web Worker in the browser (index.html) and can be require()d from Node for tests.
(function () {
  'use strict';

  const API = ['open', 'high', 'low', 'close', 'volume', 'time', 'param',
    'sma', 'ema', 'wma', 'rma', 'stdev', 'rsi', 'macd', 'bbands', 'atr', 'highest', 'lowest', 'roc', 'change', 'stoch', 'obv', 'vwap',
    'crossover', 'crossunder', 'last', 'nz',
    'buy', 'sell', 'short', 'cover', 'exit', 'target', 'order', 'stopLoss', 'takeProfit', 'trailingStop',
    'position', 'isLong', 'isShort', 'isFlat', 'entryPrice', 'barsInTrade', 'openProfit', 'equity', 'cash', 'date', 'barIndex',
    'plot', 'plotLower', 'log'];
  // Lines the Function constructor adds before the user's code: "(function anonymous(...\n) {\n" + our "use strict" line
  const LINE_OFFSET = 3;

  function compile(code) {
    return new Function(...API, '"use strict";\n' + code +
      '\n;return { onBar: typeof onBar === "function" ? onBar : null, onStart: typeof onStart === "function" ? onStart : null, onEnd: typeof onEnd === "function" ? onEnd : null };');
  }

  // Turns an exception into { msg, line, col } with the line number in the user's code
  function describe(err) {
    const out = { msg: (err && err.name && err.name !== 'Error' ? err.name + ': ' : '') + (err && err.message || String(err)) };
    const m = String(err && err.stack || '').match(/<anonymous>:(\d+):(\d+)/);
    if (m && +m[1] > LINE_OFFSET) { out.line = +m[1] - LINE_OFFSET; out.col = +m[2]; }
    if (err && err.bar != null) { out.bar = err.bar; out.time = err.time; }
    return out;
  }

  const fin = Number.isFinite;
  const valAt = (x, k) => typeof x === 'number' ? x : x && x.length > k ? x[x.length - 1 - k] : NaN;

  // ------------------------------------------------------------------ one backtest run
  // data: { t, o, h, l, c, v } arrays (unix seconds, prices)
  // opt: capital, commission (fraction of notional), slippage (fraction of price), fillAt ('open'|'close'),
  //      from (first bar index that may trade), params (overrides for param()), fractional, flushPending
  function backtest(factory, data, opt = {}) {
    const N = data.c.length;
    const capital = opt.capital > 0 ? +opt.capital : 100000;
    const fee = Math.max(0, +opt.commission || 0), slip = Math.max(0, +opt.slippage || 0);
    const onClose = opt.fillAt === 'close';
    const from = Math.max(0, Math.min(N, opt.from | 0));
    const frac = !!opt.fractional;
    const overrides = opt.params || {};
    const declared = {};

    const open = [], high = [], low = [], close = [], volume = [], time = [];
    const O = i => fin(data.o[i]) ? data.o[i] : data.c[i];
    const H = i => fin(data.h[i]) ? data.h[i] : data.c[i];
    const Lo = i => fin(data.l[i]) ? data.l[i] : data.c[i];

    let i = -1;
    let cash = capital, qty = 0, avg = 0, entryBar = -1, entryT = null, openFees = 0;
    let risk = { stop: null, target: null, trail: null };   // defaults applied to new positions
    let entryRisk = null;                                    // one-off settings from buy({ stop }) / short({ stop })
    let stopPx = null, tpPx = null, trailPct = null, water = null;
    let pending = [];
    const trades = [], fills = [], equityCurve = new Array(N), logs = [], plots = {};
    let bars = 0, inMarket = 0;

    // ---------------- indicators (incremental, cached per source array)
    const memo = new WeakMap();
    const entry = (src, key, make) => {
      if (!src || typeof src !== 'object') throw new TypeError(`${key.replace(/[\d.,]+$/, '')}(): the first argument must be a series such as close, e.g. sma(close, 20)`);
      let m = memo.get(src);
      if (!m) memo.set(src, m = new Map());
      let e = m.get(key);
      if (!e) m.set(key, e = make());
      return e;
    };
    const len = n => Math.max(1, Math.floor(+n) || 1);
    function sma(src, n) {
      n = len(n);
      const e = entry(src, 'sma' + n, () => ({ out: [], sum: 0, bad: 0 }));
      for (let j = e.out.length; j < src.length; j++) {
        const x = src[j];
        if (fin(x)) e.sum += x; else e.bad++;
        if (j >= n) { const y = src[j - n]; if (fin(y)) e.sum -= y; else e.bad--; }
        e.out.push(j >= n - 1 && !e.bad ? e.sum / n : NaN);
      }
      return e.out;
    }
    function smooth(src, n, a, key) {
      const e = entry(src, key, () => ({ out: [], prev: NaN, seed: [] }));
      for (let j = e.out.length; j < src.length; j++) {
        const x = src[j];
        if (!fin(x)) { e.out.push(NaN); continue; }
        if (!fin(e.prev)) {
          e.seed.push(x);
          if (e.seed.length === n) { e.prev = e.seed.reduce((s, v) => s + v, 0) / n; e.out.push(e.prev); } else e.out.push(NaN);
          continue;
        }
        e.prev = a * x + (1 - a) * e.prev;
        e.out.push(e.prev);
      }
      return e.out;
    }
    const ema = (src, n) => { n = len(n); return smooth(src, n, 2 / (n + 1), 'ema' + n); };
    const rma = (src, n) => { n = len(n); return smooth(src, n, 1 / n, 'rma' + n); };
    function wma(src, n) {
      n = len(n);
      const e = entry(src, 'wma' + n, () => ({ out: [] })), d = n * (n + 1) / 2;
      for (let j = e.out.length; j < src.length; j++) {
        let s = 0, okv = j >= n - 1;
        for (let k = 0; okv && k < n; k++) { const x = src[j - k]; if (!fin(x)) okv = false; else s += x * (n - k); }
        e.out.push(okv ? s / d : NaN);
      }
      return e.out;
    }
    function stdev(src, n) {
      n = len(n);
      const e = entry(src, 'stdev' + n, () => ({ out: [] }));
      const m = sma(src, n);
      for (let j = e.out.length; j < src.length; j++) {
        if (!fin(m[j])) { e.out.push(NaN); continue; }
        let s = 0;
        for (let k = 0; k < n; k++) { const d = src[j - k] - m[j]; s += d * d; }
        e.out.push(Math.sqrt(s / n));
      }
      return e.out;
    }
    function rolling(src, n, key, pick) {
      n = len(n);
      const e = entry(src, key + n, () => ({ out: [] }));
      for (let j = e.out.length; j < src.length; j++) {
        if (j < n - 1) { e.out.push(NaN); continue; }
        let v = src[j];
        for (let k = 1; k < n; k++) { const x = src[j - k]; if (!fin(x)) { v = NaN; break; } v = pick(v, x); }
        e.out.push(fin(v) ? v : NaN);
      }
      return e.out;
    }
    const highest = (src, n) => rolling(src, n, 'highest', Math.max);
    const lowest = (src, n) => rolling(src, n, 'lowest', Math.min);
    function diff(src, n, key, f) {
      n = len(n);
      const e = entry(src, key + n, () => ({ out: [] }));
      for (let j = e.out.length; j < src.length; j++) e.out.push(j >= n && fin(src[j]) && fin(src[j - n]) ? f(src[j], src[j - n]) : NaN);
      return e.out;
    }
    const change = (src, n = 1) => diff(src, n, 'change', (a, b) => a - b);
    const roc = (src, n = 1) => diff(src, n, 'roc', (a, b) => b ? (a / b - 1) * 100 : NaN);
    function rsi(src, n = 14) {
      n = len(n);
      const e = entry(src, 'rsi' + n, () => ({ out: [], g: NaN, l: NaN, sg: 0, sl: 0, k: 0 }));
      for (let j = e.out.length; j < src.length; j++) {
        if (j === 0 || !fin(src[j]) || !fin(src[j - 1])) { e.out.push(NaN); continue; }
        const d = src[j] - src[j - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
        if (!fin(e.g)) {
          e.sg += up; e.sl += dn; e.k++;
          if (e.k < n) { e.out.push(NaN); continue; }
          e.g = e.sg / n; e.l = e.sl / n;
        } else { e.g = (e.g * (n - 1) + up) / n; e.l = (e.l * (n - 1) + dn) / n; }
        e.out.push(e.l === 0 ? (e.g === 0 ? 50 : 100) : 100 - 100 / (1 + e.g / e.l));
      }
      return e.out;
    }
    function macd(src, fast = 12, slow = 26, signal = 9) {
      const e = entry(src, `macd${fast},${slow},${signal}`, () => ({ macd: [], signal: null, hist: [] }));
      const f = ema(src, fast), s = ema(src, slow);
      for (let j = e.macd.length; j < src.length; j++) e.macd.push(f[j] - s[j]);
      e.signal = ema(e.macd, signal);
      for (let j = e.hist.length; j < src.length; j++) e.hist.push(e.macd[j] - e.signal[j]);
      return e;
    }
    function bbands(src, n = 20, k = 2) {
      const e = entry(src, `bbands${n},${k}`, () => ({ upper: [], middle: null, lower: [] }));
      const m = sma(src, n), sd = stdev(src, n);
      e.middle = m;
      for (let j = e.upper.length; j < src.length; j++) { e.upper.push(m[j] + k * sd[j]); e.lower.push(m[j] - k * sd[j]); }
      return e;
    }
    function trueRange() {
      const e = entry(high, 'tr', () => ({ out: [] }));
      for (let j = e.out.length; j < close.length; j++) {
        const pc = j ? close[j - 1] : NaN, h = high[j], l = low[j];
        e.out.push(fin(pc) ? Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)) : h - l);
      }
      return e.out;
    }
    const atr = (n = 14) => rma(trueRange(), n);
    function stoch(n = 14, d = 3, smoothK = 1) {
      const e = entry(close, `stoch${n},${d},${smoothK}`, () => ({ raw: [], k: null, d: null }));
      const hh = highest(high, n), ll = lowest(low, n);
      for (let j = e.raw.length; j < close.length; j++) e.raw.push(hh[j] > ll[j] ? (close[j] - ll[j]) / (hh[j] - ll[j]) * 100 : fin(hh[j]) ? 50 : NaN);
      e.k = smoothK > 1 ? sma(e.raw, smoothK) : e.raw;
      e.d = sma(e.k, d);
      return e;
    }
    function obv() {
      const e = entry(close, 'obv', () => ({ out: [] }));
      for (let j = e.out.length; j < close.length; j++) {
        const prev = j ? e.out[j - 1] : 0, d = j ? close[j] - close[j - 1] : 0;
        e.out.push(prev + (d > 0 ? volume[j] || 0 : d < 0 ? -(volume[j] || 0) : 0));
      }
      return e.out;
    }
    // Volume-weighted average price, reset each calendar day (UTC, shifted by the exchange's offset)
    function vwap() {
      const off = opt.gmtoffset || 0;
      const e = entry(close, 'vwap', () => ({ out: [], day: null, pv: 0, v: 0 }));
      for (let j = e.out.length; j < close.length; j++) {
        const day = Math.floor((time[j] + off) / 86400);
        if (day !== e.day) { e.day = day; e.pv = 0; e.v = 0; }
        const px = (high[j] + low[j] + close[j]) / 3, v = volume[j] || 0;
        e.pv += px * v; e.v += v;
        e.out.push(e.v ? e.pv / e.v : close[j]);
      }
      return e.out;
    }
    const crossover = (a, b) => { const a0 = valAt(a, 0), a1 = valAt(a, 1), b0 = valAt(b, 0), b1 = valAt(b, 1); return a1 <= b1 && a0 > b0; };
    const crossunder = (a, b) => { const a0 = valAt(a, 0), a1 = valAt(a, 1), b0 = valAt(b, 0), b1 = valAt(b, 1); return a1 >= b1 && a0 < b0; };
    const last = (src, ago = 0) => valAt(src, ago | 0);
    const nz = (v, d = 0) => fin(v) ? v : d;

    // ---------------- orders & position
    const round = q => frac ? Math.floor(q * 1e6) / 1e6 : Math.floor(q);
    const norm = o => typeof o === 'number' ? { size: o } : o && typeof o === 'object' ? o : {};
    const queue = o => { if (pending.length < 100) pending.push(o); };
    const priceNow = () => close.length ? close[close.length - 1] : data.c[0];
    const equityAt = px => cash + qty * px;

    function setRisk(px) {
      const s = Math.sign(qty), r = entryRisk ? { ...risk, ...entryRisk } : risk;
      stopPx = r.stop > 0 ? px * (1 - s * r.stop) : null;
      tpPx = r.target > 0 ? px * (1 + s * r.target) : null;
      trailPct = r.trail > 0 ? r.trail : null;
      water = px;
    }
    // Moves the position to newQty at reference price px (slippage and fees applied)
    function fillTo(newQty, px, reason, bi) {
      newQty = qty + round(Math.abs(newQty - qty)) * Math.sign(newQty - qty);
      if (newQty === qty || !fin(px) || px <= 0) return;
      const d = newQty - qty, fp = px * (1 + Math.sign(d) * slip), cost = Math.abs(d) * fp * fee;
      const t = data.t[bi];
      if (qty !== 0 && Math.sign(d) !== Math.sign(qty)) {
        const closing = Math.min(Math.abs(d), Math.abs(qty));
        const fees = openFees * closing / Math.abs(qty) + cost * closing / Math.abs(d);
        const gross = (fp - avg) * closing * Math.sign(qty);
        trades.push({ side: qty > 0 ? 'LONG' : 'SHORT', qty: closing, entryT, entryPx: avg, exitT: t, exitPx: fp, pnl: gross - fees, ret: (gross - fees) / (avg * closing), bars: bi - entryBar, reason });
        openFees -= openFees * closing / Math.abs(qty);
      }
      cash -= d * fp + cost;
      const prevQty = qty;
      qty = newQty;
      if (qty === 0) { avg = 0; entryBar = -1; entryT = null; openFees = 0; stopPx = tpPx = trailPct = water = null; }
      else if (prevQty === 0 || Math.sign(prevQty) !== Math.sign(qty)) {
        avg = fp; entryBar = bi; entryT = t;
        openFees = cost * Math.abs(qty) / Math.abs(d);
        setRisk(fp);
      } else if (Math.abs(qty) > Math.abs(prevQty)) {
        avg = (avg * Math.abs(prevQty) + fp * Math.abs(d)) / Math.abs(qty);
        openFees += cost;
      }
      fills.push({ i: bi, t, side: d > 0 ? 'BUY' : 'SELL', qty: Math.abs(d), px: fp, reason, pos: qty });
    }
    function sizeFor(o, px) {
      if (o.qty != null) return round(Math.abs(+o.qty) || 0);
      const f = Math.min(4, Math.max(0, o.size != null ? +o.size : 1));
      return round(Math.max(0, equityAt(px)) * f / (px * (1 + slip) * (1 + fee)));
    }
    function exec(list, px, bi) {
      for (const o of list) {
        switch (o.k) {
          case 'long': if (qty > 0 && !o.add) break; entryRisk = o.risk; fillTo((o.add && qty > 0 ? qty : 0) + sizeFor(o, px), px, 'signal', bi); entryRisk = null; break;
          case 'short': if (qty < 0 && !o.add) break; entryRisk = o.risk; fillTo((o.add && qty < 0 ? qty : 0) - sizeFor(o, px), px, 'signal', bi); entryRisk = null; break;
          case 'closeLong': if (qty > 0) fillTo(o.part ? qty - round(qty * o.part) : 0, px, 'signal', bi); break;
          case 'closeShort': if (qty < 0) fillTo(o.part ? qty - Math.sign(qty) * round(Math.abs(qty) * o.part) : 0, px, 'signal', bi); break;
          case 'flat': fillTo(0, px, 'signal', bi); break;
          case 'pct': {
            const E = equityAt(px), want = Math.sign(o.pct) * round(Math.abs(E * o.pct) / (px * (1 + slip) * (1 + fee)));
            // 1% rebalancing band so calling target() every bar doesn't churn
            if (Math.sign(want) === Math.sign(qty) && want !== 0 && Math.abs(want - qty) * px < 0.01 * Math.abs(E)) break;
            fillTo(want, px, 'signal', bi);
            break;
          }
          case 'qty': fillTo(qty + o.qty, px, 'signal', bi); break;
        }
      }
    }
    // Protective exits inside bar bi, using its high/low (stop assumed to hit first if both could)
    function checkStops(bi) {
      if (qty === 0) return;
      const o = O(bi), h = H(bi), l = Lo(bi), long = qty > 0;
      let stop = stopPx, why = 'stop';
      if (trailPct) {
        const tr = long ? water * (1 - trailPct) : water * (1 + trailPct);
        if (stop == null || (long ? tr > stop : tr < stop)) { stop = tr; why = 'trail'; }
      }
      if (stop != null && (long ? l <= stop : h >= stop)) return fillTo(0, long ? Math.min(o, stop) : Math.max(o, stop), why, bi);
      if (tpPx != null && (long ? h >= tpPx : l <= tpPx)) return fillTo(0, long ? Math.max(o, tpPx) : Math.min(o, tpPx), 'target', bi);
      water = long ? Math.max(water, h) : Math.min(water, l);
    }

    const riskOpt = o => {
      const r = {};
      for (const k of ['stop', 'target', 'trail']) if (o[k] !== undefined) r[k] = o[k] == null ? null : +o[k];
      return Object.keys(r).length ? r : null;
    };
    const fracArg = o => typeof o === 'number' ? Math.min(1, Math.max(0, o)) : o && o.size != null ? Math.min(1, Math.max(0, +o.size)) : 0;
    function setLive(k, v) {
      risk = { ...risk, [k]: v > 0 ? +v : null };
      if (qty !== 0) {
        const s = Math.sign(qty);
        if (k === 'stop') stopPx = v > 0 ? avg * (1 - s * v) : null;
        if (k === 'target') tpPx = v > 0 ? avg * (1 + s * v) : null;
        if (k === 'trail') { trailPct = v > 0 ? +v : null; water = water ?? priceNow(); }
      }
    }
    const plotTo = (lower) => (v, name, color) => {
      name = String(name || 'plot' + (Object.keys(plots).length + 1)).slice(0, 40);
      const p = plots[name] || (Object.keys(plots).length < 12 ? (plots[name] = { lower, c: color || null, d: new Array(N).fill(null) }) : null);
      if (!p || i < 0) return;
      const x = typeof v === 'number' ? v : valAt(v, 0);
      p.d[i] = fin(x) ? x : null;
    };

    const fns = {
      open, high, low, close, volume, time,
      param(name, def, min, max, step) {
        name = String(name);
        if (!declared[name]) declared[name] = { def, min: min ?? null, max: max ?? null, step: step ?? null };
        const v = overrides[name];
        if (typeof def !== 'number') return v ?? def;
        return v != null && v !== '' && fin(+v) ? +v : def;
      },
      sma, ema, wma, rma, stdev, rsi, macd, bbands, atr, highest, lowest, roc, change, stoch, obv, vwap,
      crossover, crossunder, last, nz,
      buy: o => { o = norm(o); queue({ k: 'long', qty: o.qty, size: o.size, add: !!o.add, risk: riskOpt(o) }); },
      short: o => { o = norm(o); queue({ k: 'short', qty: o.qty, size: o.size, add: !!o.add, risk: riskOpt(o) }); },
      sell: o => queue({ k: 'closeLong', part: fracArg(o) }),
      cover: o => queue({ k: 'closeShort', part: fracArg(o) }),
      exit: () => queue({ k: 'flat' }),
      target: pct => { if (fin(+pct)) queue({ k: 'pct', pct: Math.max(-4, Math.min(4, +pct)) }); },
      order: q => { if (fin(+q) && +q) queue({ k: 'qty', qty: +q }); },
      stopLoss: f => setLive('stop', f), takeProfit: f => setLive('target', f), trailingStop: f => setLive('trail', f),
      position: () => qty, isLong: () => qty > 0, isShort: () => qty < 0, isFlat: () => qty === 0,
      entryPrice: () => qty ? avg : NaN, barsInTrade: () => qty ? i - entryBar : 0,
      openProfit: () => qty ? (priceNow() / avg - 1) * Math.sign(qty) : 0,
      equity: () => equityAt(priceNow()), cash: () => cash,
      date: () => new Date(((time[time.length - 1] || 0) + (opt.gmtoffset || 0)) * 1000), barIndex: () => i,
      plot: plotTo(false), plotLower: plotTo(true),
      log: (...a) => { if (logs.length < 2000) logs.push({ i, t: data.t[i], msg: a.map(x => typeof x === 'string' ? x : fin(x) ? +x.toFixed(6) + '' : JSON.stringify(x)).join(' ').slice(0, 400) }); },
    };

    const run = (f, args) => { try { return f && f(...(args || [])); } catch (e) { e.bar = i; e.time = data.t[i]; throw e; } };
    const S = factory(...API.map(k => fns[k]));
    run(S.onStart);
    for (i = 0; i < N; i++) {
      if (pending.length) { if (i >= from) exec(pending, O(i), i); pending = []; }
      if (i >= from) checkStops(i);
      open.push(O(i)); high.push(H(i)); low.push(Lo(i)); close.push(data.c[i]); volume.push(data.v ? data.v[i] || 0 : 0); time.push(data.t[i]);
      run(S.onBar);
      if (onClose && pending.length) { if (i >= from) exec(pending, data.c[i], i); pending = []; }
      if (i < from) pending = [];
      equityCurve[i] = i < from ? capital : equityAt(data.c[i]);
      if (i >= from) { bars++; if (qty !== 0) inMarket++; }
    }
    i = N - 1;
    run(S.onEnd);
    const queued = pending.length;
    if (opt.flushPending && pending.length) exec(pending, data.c[N - 1], N - 1);
    const openTrade = qty ? { side: qty > 0 ? 'LONG' : 'SHORT', qty: Math.abs(qty), entryT, entryPx: avg, exitT: null, exitPx: data.c[N - 1], pnl: (data.c[N - 1] - avg) * qty - openFees, ret: ((data.c[N - 1] - avg) * qty - openFees) / Math.abs(avg * qty), bars: N - 1 - entryBar, reason: 'open' } : null;
    const lastPx = data.c[N - 1];
    return {
      equity: equityCurve, trades, fills, logs, plots, declared, openTrade, queued,
      final: { qty, cash, avg, equity: equityAt(lastPx), exposure: lastPx && equityAt(lastPx) ? qty * lastPx / equityAt(lastPx) : 0, t: data.t[N - 1] },
      stats: stats(equityCurve, data, trades, openTrade, from, capital, bars ? inMarket / bars : 0),
    };
  }

  // ------------------------------------------------------------------ performance statistics
  function stats(eq, data, trades, openTrade, from, capital, exposure) {
    const N = eq.length, t = data.t, c = data.c;
    if (N - from < 2) return { bars: Math.max(0, N - from) };
    const years = Math.max((t[N - 1] - t[from]) / (365.25 * 86400), 1e-9);
    const rets = [];
    for (let i = from + 1; i < N; i++) if (eq[i - 1] > 0) rets.push(eq[i] / eq[i - 1] - 1);
    const n = rets.length, mean = rets.reduce((s, r) => s + r, 0) / (n || 1);
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, n - 1));
    const dsd = Math.sqrt(rets.reduce((s, r) => s + Math.min(0, r) ** 2, 0) / Math.max(1, n - 1));
    const bpy = n / years;
    let peak = -Infinity, mdd = 0, ddStart = from, ddLen = 0, cur = from;
    for (let i = from; i < N; i++) {
      if (eq[i] >= peak) { peak = eq[i]; cur = i; }
      const dd = peak > 0 ? eq[i] / peak - 1 : 0;
      if (dd < mdd) mdd = dd;
      if (i - cur > ddLen) { ddLen = i - cur; ddStart = cur; }
    }
    const end = eq[N - 1], total = end / capital - 1;
    const cagr = years >= 0.08 && end > 0 ? Math.pow(end / capital, 1 / years) - 1 : null;
    const bh = c[from] ? c[N - 1] / c[from] - 1 : null;
    const all = openTrade ? trades.concat([openTrade]) : trades;
    const wins = all.filter(x => x.pnl > 0), losses = all.filter(x => x.pnl <= 0);
    const gp = wins.reduce((s, x) => s + x.pnl, 0), gl = -losses.reduce((s, x) => s + x.pnl, 0);
    return {
      bars: N - from, years, start: capital, end, totalReturn: total, cagr,
      vol: sd * Math.sqrt(bpy), sharpe: sd > 0 ? mean / sd * Math.sqrt(bpy) : null, sortino: dsd > 0 ? mean / dsd * Math.sqrt(bpy) : null,
      maxDD: mdd, maxDDBars: ddLen, ddStart, calmar: cagr != null && mdd < 0 ? cagr / -mdd : null,
      buyHold: bh, excess: bh != null ? total - bh : null, exposure,
      trades: all.length, winRate: all.length ? wins.length / all.length : null,
      avgWin: wins.length ? wins.reduce((s, x) => s + x.ret, 0) / wins.length : null,
      avgLoss: losses.length ? losses.reduce((s, x) => s + x.ret, 0) / losses.length : null,
      profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : null,
      expectancy: all.length ? all.reduce((s, x) => s + x.ret, 0) / all.length : null,
      best: all.length ? Math.max(...all.map(x => x.ret)) : null, worst: all.length ? Math.min(...all.map(x => x.ret)) : null,
      avgBars: all.length ? all.reduce((s, x) => s + x.bars, 0) / all.length : null,
    };
  }

  const slice = (d, a, b) => ({ t: d.t.slice(a, b), o: d.o.slice(a, b), h: d.h.slice(a, b), l: d.l.slice(a, b), c: d.c.slice(a, b), v: d.v ? d.v.slice(a, b) : null });
  const pick = s => ({ totalReturn: s.totalReturn, cagr: s.cagr, sharpe: s.sharpe, sortino: s.sortino, maxDD: s.maxDD, trades: s.trades, winRate: s.winRate, profitFactor: s.profitFactor, exposure: s.exposure, buyHold: s.buyHold });

  // ------------------------------------------------------------------ parameter sweep with out-of-sample check
  // grid: { name: [values] }. split: fraction of bars used in-sample (the rest is the out-of-sample test).
  function optimize(factory, data, opt, grid, split, onProgress) {
    const names = Object.keys(grid);
    let combos = [{}];
    for (const k of names) { const next = []; for (const c of combos) for (const v of grid[k]) next.push({ ...c, [k]: v }); combos = next; }
    if (combos.length > 600) throw new Error(`${combos.length} combinations — narrow the ranges (max 600)`);
    const N = data.c.length, cut = Math.max(2, Math.min(N - 2, Math.round(N * split)));
    const isData = split < 1 ? slice(data, 0, cut) : data;
    const rows = [];
    combos.forEach((params, k) => {
      const base = { ...opt, params: { ...(opt.params || {}), ...params } };
      const row = { params };
      try { row.is = pick(backtest(factory, isData, base).stats); } catch (e) { row.err = describe(e).msg; }
      if (!row.err && split < 1) try { row.oos = pick(backtest(factory, data, { ...base, from: cut }).stats); } catch (e) { row.err = describe(e).msg; }
      rows.push(row);
      if (onProgress && (k % 5 === 4 || k === combos.length - 1)) onProgress((k + 1) / combos.length);
    });
    return { rows, cut, cutT: data.t[cut], n: combos.length };
  }

  const api = { API, compile, backtest, optimize, describe, stats };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // ------------------------------------------------------------------ Web Worker protocol
  // in:  { id, type: 'backtest' | 'optimize' | 'signal' | 'check', code, data, opt, grid, split }
  // out: { id, ok, res } | { id, ok: false, error } | { id, progress }
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined' && typeof module === 'undefined') {
    self.onmessage = e => {
      const { id, type, code, data, opt, grid, split } = e.data || {};
      try {
        const factory = compile(code);
        let res;
        if (type === 'check') res = { ok: true };
        else if (type === 'optimize') res = optimize(factory, data, opt || {}, grid || {}, split ?? 1, p => self.postMessage({ id, progress: p }));
        else if (type === 'signal') {
          const r = backtest(factory, data, { ...opt, flushPending: true });
          res = { final: r.final, logs: r.logs.slice(-50), queued: r.queued, stats: r.stats, lastFill: r.fills[r.fills.length - 1] || null };
        } else res = backtest(factory, data, opt || {});
        self.postMessage({ id, ok: true, res });
      } catch (err) {
        self.postMessage({ id, ok: false, error: describe(err) });
      }
    };
  }
})();
