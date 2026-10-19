// Social & news aggregation: Reddit (r/wallstreetbets and other finance subreddits), ticker mentions and
// talking points, ApeWisdom and Tradestie WSB sentiment, Google News (which indexes most publishers).
// Reddit often blocks cloud servers, so several access paths are tried in turn: Reddit's API with an app
// token (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET), Reddit's public JSON, Reddit RSS, then the PullPush archive.
'use strict';

module.exports = ({ cached, get, decode }) => {
  const fail = (msg, status = 502) => { const e = new Error(msg); e.status = status; return e; };
  const UA = 'web:market-terminal:1.0 (open-source market terminal)';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Reddit's RSS rate-limits bursts, so requests from this instance are spaced out; a 429 is waited out once,
  // and listings can also come from old.reddit.com (which has no comment feeds)
  let rssNext = 0;
  const rssPace = async () => { const now = Date.now(), at = Math.max(now, rssNext); rssNext = at + 2500; if (at > now) await sleep(at - now); };
  async function redditRss(path) {
    const errs = [];
    const hosts = path.includes('/comments/') ? ['https://www.reddit.com'] : ['https://www.reddit.com', 'https://old.reddit.com'];
    for (const host of hosts) {
      for (let k = 0; k < 2; k++) {
        await rssPace();
        const r = await get(host + path, { 'User-Agent': UA, Accept: 'application/atom+xml, application/xml' }, 12000).catch(e => ({ ok: false, status: e.message }));
        if (r.ok) return r.text();
        errs.push(`${new URL(host).hostname} rss ${r.status}`);
        if (r.status !== 429 || k) break;
        await sleep(3000);
      }
    }
    throw new Error(errs.join(', '));
  }
  const json = async (url, headers = {}, ms = 12000) => {
    const r = await get(url, { Accept: 'application/json', ...headers }, ms);
    if (!r.ok) throw fail(`${new URL(url).hostname} ${r.status}`);
    return r.json();
  };

  // ------------------------------------------------------------ Reddit access
  let token = null;
  async function oauthToken() {
    const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
    if (!id || !secret) return null;
    if (token && token.exp > Date.now() + 60e3) return token.v;
    const r = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST', body: 'grant_type=client_credentials', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    });
    if (!r.ok) throw fail('reddit oauth ' + r.status);
    const j = await r.json();
    token = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return token.v;
  }
  // GET a Reddit API path (e.g. /r/wallstreetbets/hot?limit=100) as JSON
  async function redditJson(path) {
    const errs = [];
    try {
      const tk = await oauthToken();
      if (tk) {
        const r = await get('https://oauth.reddit.com' + path, { Authorization: 'Bearer ' + tk, 'User-Agent': UA, Accept: 'application/json' }, 12000);
        if (r.ok) return { src: 'Reddit API', j: await r.json() };
        errs.push('oauth.reddit.com ' + r.status);
      }
    } catch (e) { errs.push(e.message); }
    const [p, q = ''] = path.split('?');
    for (const host of ['https://www.reddit.com', 'https://old.reddit.com']) {
      try {
        const r = await get(`${host}${p}.json?${q}`, { 'User-Agent': UA, Accept: 'application/json' }, 12000);
        const ct = r.headers.get('content-type') || '';
        if (!r.ok || !ct.includes('json')) throw new Error(`${new URL(host).hostname} ${r.status}`);
        return { src: 'Reddit', j: await r.json() };
      } catch (e) { errs.push(e.message); }
    }
    throw fail(errs.join('; '));
  }
  const mapPost = d => ({
    id: d.id, sub: d.subreddit, title: decode(d.title || ''), flair: d.link_flair_text || '', score: d.score ?? null, comments: d.num_comments ?? null,
    ratio: d.upvote_ratio ?? null, t: d.created_utc || 0, author: d.author || '', link: d.permalink ? 'https://www.reddit.com' + d.permalink : d.url,
    text: decode(d.selftext || '').slice(0, 700), sticky: !!d.stickied, awards: d.total_awards_received || 0,
  });
  // Atom feed fallback (no scores)
  async function rss(sub, sort, path) {
    const xml = await redditRss(path || `/r/${sub}/${sort}/.rss?limit=100`);
    const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')); return m ? m[1] : ''; };
    return (xml.match(/<entry>[\s\S]*?<\/entry>/gi) || []).map(e => {
      const link = (e.match(/<link href="([^"]+)"/) || [])[1] || '';
      return { id: (link.match(/comments\/(\w+)/) || [])[1] || link, sub: sub || (link.match(/\/r\/(\w+)/) || [])[1] || '', title: decode(tag(e, 'title')), flair: '', score: null, comments: null, ratio: null,
        t: Math.floor(Date.parse(tag(e, 'updated')) / 1000) || 0, author: decode(tag(tag(e, 'author'), 'name')).replace(/^\/u\//, ''), link, text: decode(decode(tag(e, 'content'))).replace(/submitted by .*$/, '').slice(0, 700), sticky: false, awards: 0 };
    });
  }
  async function pullpush(params) {
    const j = await json('https://api.pullpush.io/reddit/search/submission/?' + params, {}, 15000);
    return (j.data || []).map(mapPost);
  }
  async function listing(sub, sort = 'hot', t = 'day') {
    return cached(`rd:${sub}:${sort}:${t}`, 240e3, async () => {
      const errs = [];
      try {
        const { src, j } = await redditJson(`/r/${sub}/${sort}?limit=100&raw_json=1${sort === 'top' ? '&t=' + t : ''}`);
        return { src, posts: (j.data?.children || []).map(c => mapPost(c.data)) };
      } catch (e) { errs.push(e.message); }
      try { return { src: 'Reddit RSS (no scores)', posts: await rss(sub, sort), note: errs.join('; ') }; } catch (e) { errs.push(e.message); }
      try { return { src: 'PullPush Reddit archive (scores as first indexed)', posts: await pullpush(`subreddit=${sub}&size=100&sort=desc&sort_type=created_utc`), note: errs.join('; ') }; } catch (e) { errs.push(e.message); }
      throw fail('Reddit unavailable: ' + errs.join('; '));
    });
  }
  async function comments(sub, id) {
    return cached(`rc:${id}`, 180e3, async () => {
      const errs = [];
      try {
        const { j } = await redditJson(id ? `/r/${sub}/comments/${id}?sort=top&limit=300&depth=1&raw_json=1` : `/r/${sub}/comments?limit=100&raw_json=1`);
        if (!id) return (j.data?.children || []).filter(c => c.kind === 't1').map(c => ({ body: decode(c.data.body || '').slice(0, 500), score: c.data.score, author: c.data.author, t: c.data.created_utc }));
        return (j[1]?.data?.children || []).filter(c => c.kind === 't1').map(c => ({ body: decode(c.data.body || '').slice(0, 500), score: c.data.score, author: c.data.author, t: c.data.created_utc }));
      } catch (e) { errs.push(e.message); }
      try {
        // comment feed (newest first, no scores)
        const xml = await redditRss(id ? `/r/${sub}/comments/${id}/.rss?limit=100` : `/r/${sub}/comments/.rss?limit=100`);
        const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')); return m ? m[1] : ''; };
        // the feed starts with the post itself (id t3_…); comments have ids t1_…
        const out = (xml.match(/<entry>[\s\S]*?<\/entry>/gi) || []).filter(e => !/<id>t3_/.test(e)).map(e => ({ body: decode(decode(tag(e, 'content'))).slice(0, 500), score: null, author: decode(tag(tag(e, 'author'), 'name')).replace(/^\/u\//, ''), t: Math.floor(Date.parse(tag(e, 'updated')) / 1000) || 0 }))
          .filter(c => c.body && !/^\[deleted\]|^\[removed\]/.test(c.body));
        if (out.length) return out;
        throw new Error('reddit comment rss empty');
      } catch (e) { errs.push(e.message); }
      if (id) try {
        const j = await json(`https://api.pullpush.io/reddit/search/comment/?link_id=${id}&size=100&sort=desc&sort_type=score`, {}, 15000);
        return (j.data || []).map(c => ({ body: decode(c.body || '').slice(0, 500), score: c.score, author: c.author, t: c.created_utc }));
      } catch (e) { errs.push(e.message); }
      throw fail('comments unavailable: ' + errs.join('; '));
    });
  }

  // ------------------------------------------------------------ tickers & talking points
  // Common words and finance jargon that look like tickers
  const STOP = new Set(('A I AM AN AND ARE AS AT BE BY DD DO FOR GO HAS HE IF IN IS IT ME MY NO OF ON OR SO TO UP US WE ALL ANY ATH ATL CEO CFO CTO COO EPS ETF ETFS FDA FED FOMC GDP CPI PPI PCE IPO IMO IMHO LOL OMG USA USD EOD EOW EOY YOLO FOMO FUD HODL WSB OP PM ER EV IV OTM ITM ATM YTD QOQ YOY TLDR EDIT NEW NOW BIG OUT RIP NFA DM PT TA AI OK SEC IRS ONE TWO GOOD BEST CASH HOLD LONG SHORT CALL PUTS CALLS PUT BUY SELL BULL BEAR MOON APES APE GAIN GAINS LOSS ROPE TV UK EU LMAO WTF JPOW THE THIS THAT WHAT WHEN WHY HOW YES NOT BUT JUST LIKE GET GOT ALL ITS OTC NYSE CEOS DTE IRA ROTH ROI PE PEG FCF EBIT USSR GPU CPU API LLC INC CORP Q1 Q2 Q3 Q4 FY TTM VS AH PDT SPAC REIT ESG MOASS DRS NFT LFG IDK TBH IRL GG FYI BTW ASAP RN HYSA HSA APR APY CD ATM'.split(' ')));
  // Tickers that are also everyday words only count as $CASHTAGS
  const AMBIG = new Set('ON U F C V T O D K J H E X Y Z OPEN RUN NOW SAVE NET LOW COST HOOD BIG CAT DOG FUN LOVE PLAY GOOD REAL SAFE TRUE ALLY EARN FAST GAIN HUGE LIFE MAIN NICE PEAK RARE ROCK WELL WISH CARS DASH MAN JOB BEST CASH EDIT LUV'.split(' '));
  const POPULAR = ('SPY QQQ IWM DIA VOO VTI TQQQ SQQQ UVXY VXX SVXY SPXL SPXS UPRO SOXL SOXS TLT TMF GLD SLV USO UNG XLE XLF XLK ARKK SMH NVDL TSLL '
    + 'AAPL MSFT NVDA AMD TSLA AMZN GOOGL GOOG META NFLX INTC MU AVGO QCOM SMCI ARM TSM ASML PLTR SNOW CRWD PANW SHOP SQ XYZ PYPL COIN MSTR RIOT MARA CLSK '
    + 'GME AMC BB NOK SOFI RIVN LCID NIO XPEV LI GM BA DIS WMT TGT COST HD NKE SBUX MCD KO PEP JPM BAC WFC GS MS SCHW MA AXP BRK UNH LLY NVO PFE MRNA JNJ ABBV '
    + 'XOM CVX OXY COP SLB HAL BP SHEL UBER LYFT ABNB DKNG PENN CHWY ETSY ROKU ZM DOCU TWLO SNAP PINS SPOT BABA JD PDD BIDU ORCL CRM ADBE IBM CSCO DELL HPQ HPE '
    + 'WDC STX TXN MRVL LRCX AMAT KLAC CVNA UPST AFRM RKT CCL RCL NCLH AAL DAL UAL JBLU TLRY CGC SNDL BYND OKLO SMR NNE IONQ RGTI QBTS QUBT ACHR JOBY RKLB ASTS '
    + 'LUNR SOUN BBAI APP HIMS CELH ENPH FSLR PLUG CHPT QS VST CEG NRG TEM RDDT DJT CRWV NBIS CRCL ORCL MP UNH OPEN NET DASH HOOD').split(' ');
  let known = new Set(POPULAR), knownAt = 0;
  async function refreshKnown() {
    if (Date.now() - knownAt < 3600e3) return;
    knownAt = Date.now();
    try {
      const pages = await Promise.all([1, 2].map(n => json(`https://apewisdom.io/api/v1.0/filter/all-stocks/page/${n}`).catch(() => ({ results: [] }))));
      const s = new Set(POPULAR);
      pages.forEach(p => (p.results || []).forEach(x => x.ticker && s.add(String(x.ticker).toUpperCase())));
      known = s;
    } catch { /* keep the built-in list */ }
  }
  function tickersIn(text) {
    const out = new Set();
    for (const m of String(text).matchAll(/\$([A-Za-z]{1,5})\b/g)) { const t = m[1].toUpperCase(); if (!STOP.has(t) || known.has(t) || AMBIG.has(t)) out.add(t); }
    for (const m of String(text).matchAll(/\b([A-Z]{2,5})\b/g)) { const t = m[1]; if (known.has(t) && !STOP.has(t) && !AMBIG.has(t)) out.add(t); }
    return [...out];
  }
  const BULL = /\b(calls?|moon(ing)?|rocket|bull(ish)?|long|buy(ing)?|squeeze|rip(ping)?|tendies|breakout|undervalued|yolo'?d?|lfg|printing|ath|green)\b|🚀|📈|💎|🐂/gi;
  const BEAR = /\b(puts?|short(ing)?|bear(ish)?|crash(ing)?|dump(ing)?|drill(ing)?|sell(ing)?|overvalued|bubble|rug(ged)?|bag ?holder|red|tank(ing)?|recession)\b|🌈🐻|📉|🐻/gi;
  const tone = text => ({ bull: (String(text).match(BULL) || []).length, bear: (String(text).match(BEAR) || []).length });
  function mentions(items) {
    const m = new Map();
    for (const it of items) {
      const text = it.title ? `${it.title} ${it.text || ''}` : it.body || '';
      const tk = tickersIn(text);
      if (!tk.length) continue;
      const { bull, bear } = tone(text);
      for (const t of tk) {
        const x = m.get(t) || { sym: t, n: 0, score: 0, comments: 0, bull: 0, bear: 0 };
        x.n++; x.score += Math.max(0, it.score || 0); x.comments += it.comments || 0;
        if (bull > bear) x.bull++; else if (bear > bull) x.bear++;
        m.set(t, x);
      }
    }
    return [...m.values()].sort((a, b) => b.n - a.n || b.score - a.score);
  }
  const WORD_STOP = new Set(('the a an and or but if then than so to of in on at by for with from up down out over under about into as is are was were be been being am do does did done have has had having i me my we our you your he she they them their it its this that these those what which who whom whose when where why how all any both each few more most other some such no nor not only own same too very can will just should now get got going go gonna wanna like one two also really still even much many im ive dont cant wont didnt doesnt isnt thats theres heres whats youre theyre u ur lol lmao yeah yes ok okay oh guys guy people today tomorrow week day time year month back right make made know think see look let need want way new first last next would could might may must shall our ours here there off again further once because while after before during until through above below between same per via vs amp gt lt https http www com reddit post posts comment comments thread daily discussion moves weekend edit deleted removed '
    + 'stock stocks market markets share shares price trade trading buy sell calls puts call put money dollar dollars bought sold anyone thoughts question help any every why what ive us usa dont im gonna '
    + 'january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday '
    + 'another never well real everything something nothing anything thank thanks feel feeling feels going good bad better worse big little lot lots always ever row thing things sure probably maybe actually literally said says say tell told '
    + 'got gets getting take took taking give gave keep kept come came went goes put puts made makes hard high low last first long short since around without already enough every much rest way days weeks hours ago ').split(' '));
  function words(items, n = 40) {
    const c = new Map();
    for (const it of items) {
      const text = (it.title || it.body || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ');
      for (const w of new Set(text.match(/[a-z][a-z'’-]{2,}/g) || [])) {
        const k = w.replace(/['’]s$/, '').replace(/['’]/g, '');
        if (k.length < 3 || WORD_STOP.has(k)) continue;
        c.set(k, (c.get(k) || 0) + 1 + Math.min(3, Math.log10(1 + Math.max(0, it.score || 0))));
      }
    }
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w, s]) => ({ w, s: Math.round(s * 10) / 10 }));
  }

  // ------------------------------------------------------------ routes
  const SUBS = ['wallstreetbets', 'stocks', 'investing', 'options', 'StockMarket', 'pennystocks', 'Superstonk', 'thetagang', 'ValueInvesting', 'SecurityAnalysis', 'Daytrading', 'CryptoCurrency', 'Bitcoin', 'economy'];
  async function reddit(p) {
    const sub = SUBS.find(s => s.toLowerCase() === String(p.get('sub') || 'wallstreetbets').toLowerCase());
    if (!sub) throw fail('unsupported subreddit', 400);
    const sort = ['hot', 'new', 'top', 'rising'].includes(p.get('sort')) ? p.get('sort') : 'hot';
    const t = ['day', 'week', 'month'].includes(p.get('t')) ? p.get('t') : 'day';
    await refreshKnown();
    const l = await listing(sub, sort, t);
    const posts = l.posts.map(x => ({ ...x, tickers: tickersIn(`${x.title} ${x.text}`) }));
    return { sub, sort, src: l.src, note: l.note || null, posts, tickers: mentions(posts).slice(0, 40), words: words(posts) };
  }
  async function wsb() {
    return cached('wsb', 180e3, async () => {
      await refreshKnown();
      const [hot, ape, trs] = await Promise.allSettled([
        listing('wallstreetbets', 'hot'),
        json('https://apewisdom.io/api/v1.0/filter/wallstreetbets/page/1'),
        json('https://tradestie.com/api/v1/apps/reddit'),
      ]);
      const posts = (hot.value?.posts || []).map(x => ({ ...x, tickers: tickersIn(`${x.title} ${x.text}`) }));
      // the pinned daily / weekend / "moves tomorrow" thread is where most of the chatter happens
      const dt = posts.find(x => /daily discussion|moves tomorrow|weekend discussion/i.test(x.title));
      let daily = null;
      if (dt) {
        try { const cm = await comments('wallstreetbets', dt.id); daily = { id: dt.id, title: dt.title, link: dt.link, comments: cm.slice(0, 120), tickers: mentions(cm).slice(0, 30), words: words(cm, 30), n: dt.comments }; }
        catch (e) {
          // fall back to the subreddit's latest-comments feed (mostly daily-thread chatter)
          try { const cm = await comments('wallstreetbets', ''); daily = { id: dt.id, title: dt.title, link: dt.link, stream: true, comments: cm.slice(0, 120), tickers: mentions(cm).slice(0, 30), words: words(cm, 30), n: dt.comments }; }
          catch (e2) { daily = { id: dt.id, title: dt.title, link: dt.link, err: e.message }; }
        }
      }
      const all = [...posts, ...(daily?.comments || [])];
      return {
        src: hot.value?.src || null, note: hot.value?.note || null, err: hot.reason?.message || null,
        posts, daily, tickers: mentions(all).slice(0, 40), words: words(all, 50),
        ape: (ape.value?.results || []).slice(0, 50).map(x => ({ rank: Number(x.rank), sym: x.ticker, name: x.name, mentions: Number(x.mentions), upvotes: Number(x.upvotes), rank24: Number(x.rank_24h_ago) || null, mentions24: Number(x.mentions_24h_ago) || null })),
        apeErr: ape.reason?.message || null,
        tradestie: Array.isArray(trs.value) ? trs.value.slice(0, 50).map(x => ({ sym: x.ticker, comments: x.no_of_comments, sentiment: x.sentiment, score: x.sentiment_score })) : [],
        tradestieErr: trs.reason?.message || null,
      };
    });
  }
  // Recent posts mentioning a ticker or phrase across the finance subreddits
  async function rsearch(p) {
    const q = String(p.get('q') || '').replace(/[^\w$.\- ]/g, '').trim().slice(0, 40);
    if (!q) throw fail('missing ?q=', 400);
    return cached('rs:' + q, 300e3, async () => {
      const errs = [];
      const multi = 'wallstreetbets+stocks+investing+options+StockMarket+pennystocks';
      try {
        const { src, j } = await redditJson(`/r/${multi}/search?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new&t=month&limit=50&raw_json=1`);
        return { q, src, posts: (j.data?.children || []).map(c => mapPost(c.data)) };
      } catch (e) { errs.push(e.message); }
      try {
        const posts = await rss(null, null, `/r/${multi}/search.rss?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new&t=month&limit=50`);
        if (posts.length) return { q, src: 'Reddit RSS (no scores)', posts };
        errs.push('reddit search rss empty');
      } catch (e) { errs.push(e.message); }
      try { return { q, src: 'PullPush Reddit archive', posts: (await pullpush(`q=${encodeURIComponent(q)}&size=50&sort=desc&sort_type=created_utc`)).filter(x => /wallstreetbets|stocks|investing|options|stockmarket|pennystocks/i.test(x.sub)) }; } catch (e) { errs.push(e.message); }
      throw fail('Reddit search unavailable: ' + errs.join('; '));
    });
  }

  // ------------------------------------------------------------ Google News (aggregates most publishers)
  function parseGoogle(xml) {
    const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')); return m ? decode(m[1]) : ''; };
    return (xml.match(/<item>[\s\S]*?<\/item>/gi) || []).map(it => {
      const pub = tag(it, 'source');
      let title = tag(it, 'title');
      if (pub && title.endsWith(' - ' + pub)) title = title.slice(0, -(pub.length + 3));
      return { src: pub || 'Google News', title, link: tag(it, 'link'), t: Math.floor((Date.parse(tag(it, 'pubDate')) || Date.now()) / 1000), desc: '', via: 'Google News' };
    }).filter(x => x.title);
  }
  async function gnews(q) {
    return cached('gn:' + q, 180e3, async () => {
      const url = q ? `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`
        : 'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en';
      const r = await get(url, { Accept: 'application/rss+xml, application/xml' }, 12000);
      if (!r.ok) throw fail('Google News ' + r.status);
      return parseGoogle(await r.text());
    });
  }

  return { routes: { reddit, wsb, rsearch }, gnews, listing, tickersIn };
};
