// Ticker mentions, bullish/bearish tone and talking points in Reddit posts and comments.
// Shared by the server (lib/social.js) and the browser (index.html), which can read Reddit directly.
(function (root) {
  'use strict';
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
  const known = new Set(POPULAR);
  const addKnown = list => (list || []).forEach(t => t && known.add(String(t).toUpperCase()));
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

  const Talk = { tickersIn, tone, mentions, words, addKnown, known: () => [...known] };
  if (typeof module !== 'undefined' && module.exports) module.exports = Talk; else root.Talk = Talk;
})(typeof self !== 'undefined' ? self : this);
