# Market Terminal

A Bloomberg-style market terminal in a single HTML file. It has four command-line panels, live quotes, charts, news, fundamentals and paper trading, all running on **real market data**.

## Run it

Requires Node.js 18 or newer. There are no dependencies to install.

```bash
node server.js
# open http://localhost:8080
```

Browsers can't call finance APIs directly because of CORS, so `server.js` serves the page and proxies the data:

| Data | Source |
|---|---|
| Quotes, charts, dividends/splits, search, screeners | Yahoo Finance (exchange delays apply) |
| Interactive charts with indicators and drawing tools | TradingView embedded chart and technical-analysis widgets (loaded in your browser) |
| Company profile, valuation, key statistics, analyst ratings & targets | Yahoo Finance quoteSummary |
| Income statement, balance sheet, cash flow (annual, quarterly, trailing 12 months) | Yahoo Finance fundamentals time series |
| Earnings & revenue estimates, EPS trend and revisions, earnings history, SEC filings | Yahoo Finance analysis |
| Equity research: consensus ratings, price targets, analyst upgrades/downgrades, independent research reports (Argus, Morningstar), technical outlook and valuation (Trading Central), ESG risk (Sustainalytics), similar companies | Yahoo Finance quoteSummary and research insights |
| Supply chain: customers, suppliers and competitors | SEC EDGAR: the company's latest 10-K / 20-F XBRL (customer and supplier concentration it discloses) and full-text search of other companies' 10-K, 10-Q, 20-F and S-1 filings that name it ("sales to …", "purchases from …", "compete with …") |
| Revenue by segment, product, geography and major customer | SEC EDGAR: XBRL of the latest annual report |
| US yield curve | U.S. Treasury daily par yield curve |
| Top news | RSS feeds from Yahoo Finance, CNBC, MarketWatch, WSJ, Bloomberg, FT, Seeking Alpha, Investing.com, Nasdaq, Benzinga, The Economist, CoinDesk, the Federal Reserve, SEC and ECB, plus Google News (which adds Reuters, AP, Barron's and hundreds of other publishers) |
| Reddit | r/wallstreetbets and other finance subreddits: posts, daily-thread comments and search. Your browser reads Reddit directly when Reddit allows it (with upvote and comment counts); otherwise the server's copy is used. Reddit's API blocks cloud servers, so the server reads Reddit's RSS feeds and takes upvote counts and daily-thread comments from the [Arctic Shift](https://arctic-shift.photon-reddit.com) Reddit archive (or add a Reddit app key) |
| Live flights (ADS-B) | adsb.lol, falling back to airplanes.live, then OpenSky Network |
| Aircraft lookup, military & emergency traffic, business jets, cargo hubs | adsb.lol and airplanes.live; flight routes from the adsb.lol route database; photos from planespotters.net |
| Live ships & tankers (AIS) | aisstream.io (global, free key) or Fintraffic Digitraffic (Baltic, no key) |
| Military sites | OpenStreetMap (`military=*` tags) via the Overpass API |
| Satellite imagery | Esri World Imagery (high-res), NASA GIBS MODIS daily & VIIRS night lights |
| US crude, SPR & Cushing inventories | EIA API (free key) |
| Oil futures curves | Yahoo Finance (NYMEX WTI & Brent contracts) |
| Insider trades (Form 4) | Yahoo Finance (per company), OpenInsider (market-wide feed); direct SEC EDGAR when `SEC_USER_AGENT` is set |
| Congressional trades | U.S. House Clerk periodic transaction reports (PDFs parsed for tickers and amounts) |
| Options chains & unusual activity | Yahoo Finance |
| Short volume / short interest | FINRA Reg SHO daily files, Yahoo Finance |
| Fed funds futures | Yahoo Finance (CBOT 30-day fed funds, `ZQ`) |
| Macro | U.S. Bureau of Labor Statistics, Federal Reserve Bank of New York (EFFR, SOFR) |
| Prediction markets | Polymarket, Kalshi |
| Sentiment | CNN Fear & Greed, ApeWisdom (Reddit and WallStreetBets mention leaderboards), Tradestie (WallStreetBets comment sentiment) |
| Calendars | ForexFactory (economic), Nasdaq (earnings) |

### Optional API keys

Optional settings unlock extra data. Put them in a `.env` file for local use (see `.env.example`), or add them as Vercel environment variables:

- `AISSTREAM_API_KEY` from [aisstream.io](https://aisstream.io) turns on worldwide ship tracking. Without it, ships are limited to the Baltic Sea.
- `SEC_USER_AGENT`, e.g. `Your Name you@example.com`. The SEC refuses automated requests that don't include a contact email, so set this for `INSD` (Form 4 detail), `SPLC` and `SEG`.
- `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` from a "script" app at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) add upvote and comment counts to the Reddit screens, and score-ranked daily-thread comments.
- `EIA_API_KEY` from [eia.gov/opendata](https://www.eia.gov/opendata/register.php) turns on the weekly US crude, SPR, Cushing, gasoline and distillate inventories in `OIL`.

### Deploy on Vercel

The repo is ready for Vercel with no build step. `index.html` is served as a static file, and `api/[name].js` runs the same data endpoints as serverless functions, with short CDN caching. Import the repo in Vercel (framework preset: **Other**) and it will deploy on every push.

If the page is hosted somewhere else, point it at the server with `?api=https://your-server`.

## Using it

Type into a panel's amber command line and press **Enter** (`<GO>`). The syntax follows Bloomberg's:

```
AAPL US EQUITY DES      security + yellow key + function
SPX INDEX GP            index chart
EURUSD CURNCY GP        FX
CL1 COMDTY              front-month WTI (a security alone opens its default screen)
VOD LN EQUITY           non-US listings: LN, GR, FP, JP, HK, CN, AU, ...
GP                      apply a function to the panel's loaded security
COMP AAPL MSFT NVDA     comparative returns
BUY 100 AAPL            paper trade
N FED                   news search
3                       pick numbered menu item 3
```

| Function | Description |
|---|---|
| `WEI` | World equity indices |
| `MOST` | Most active / gainers / losers |
| `EQS` | Equity screens (with market-cap / P/E / %chg filters) |
| `IMAP` | Sector heat map of US large caps |
| `FXC` | FX cross-rate matrix plus major and EM pairs |
| `GLCO` | Commodities (energy, metals, ags) |
| `CRYP` | Crypto monitor |
| `GC` / `WB` | US Treasury curve: now vs 1M and 1Y ago, spreads, live benchmarks |
| `TOP`, `N`, `CN` | News from every source, filterable by publisher: top stories, search (`N FED`), and company news (`AAPL CN`) that also includes Reddit posts |
| `WSB` | What r/wallstreetbets is talking about: most-mentioned tickers with bullish/bearish tone, the 24h leaderboard, comment sentiment, trending words, the daily discussion thread and hot posts |
| `REDDIT`, `BUZZ` | Finance subreddits (`REDDIT OPTIONS`, `REDDIT STOCKS`) or a Reddit search (`REDDIT NVDA`); `BUZZ` is one security's social picture: WSB rank, sentiment, Reddit posts and news from every source |
| `DES` | Description: price stats, valuation, profile, officers, 1Y chart |
| `TV` | TradingView chart with TradingView's data, 1-minute to monthly bars, indicators, drawing tools and a technical-analysis gauge |
| `GP`, `GIP` | Price graph (1D to MAX, line/candle, 50/200 SMA, volume, crosshair) and intraday graph |
| `HP` | Historical prices (daily/weekly/monthly, CSV export) |
| `Q` | Quote, bid/ask, ranges, polled price log, trade ticket |
| `FA` | Yahoo Finance financials: full income statement, balance sheet and cash flow (annual, quarterly, TTM), ratios, key statistics, estimates and SEC filings |
| `EE`, `CF` | Earnings estimates, EPS revisions and beat/miss history; SEC filings |
| `ANR` | Analyst consensus, targets, rating changes |
| `BRC` | Equity research: a research note built from live data (Street view, analyst momentum, growth, valuation vs peers, profitability, independent research, technicals, ownership, WSB chatter, risks), a model score vs peers, a valuation football field, research reports from Argus / Morningstar, analyst actions with price-target history, estimates, technical outlook and ESG |
| `RV` | Comparable-company sheet: P/E, forward P/E, PEG, EV/Sales, EV/EBITDA, margins, ROE, growth, beta and upside to target vs peers, with peer median and premium/discount; add your own peers |
| `DCF` | Interactive 10-year discounted cash flow from trailing free cash flow, consensus growth and a CAPM discount rate (US 10-year + beta × ERP), with a WACC × terminal-growth sensitivity table |
| `SPLC` | Supply chain map: who the company sells to, buys from and competes with, from SEC filings, with live prices. `WHY` shows the sentence in the filing; click a company to follow its own chain |
| `SEG`, `PGEO` | Revenue and operating income by business segment, product, geography and major customer, three fiscal years, from the 10-K |
| `MGMT` | Executives and pay, ISS governance risk scores, insider holders |
| `DVD` | Dividend and split history |
| `COMP` | Normalized multi-security return chart |
| `BMAP` | World map with toggleable layers: flights, ships, chokepoints and lanes, energy sites, military sites; dark, satellite, NASA daily or night-lights base maps |
| `FTRK` (or `PLANE`) | Aircraft tracker: find a flight, tail number, ICAO hex or type (`FTRK UAL1`, `FTRK N628TS`, `FTRK B748`), track it with a trail and route, and browse military aircraft, emergency squawks, large business jets and cargo-hub activity |
| `FLT`, `SHIP`, `MIL` | The map preset for live flights, live ships and tankers (with a tanker/cargo filter), or military sites. Add a region: `SHIP HORMUZ`, `FLT LONDON` |
| `SAT` | Satellite imagery watchlist: mall and factory parking lots, aircraft storage, tank farms, ports |
| `OIL` | Oil monitor: WTI/Brent futures curves, US inventories and SPR, proved reserves, chokepoints, energy stocks |
| `EDGE` | One-screen dashboard: sentiment, Fed odds, today's catalysts, insider cluster buys, unusual options, Reddit momentum, prediction markets, congress filings, Baltic tankers |
| `INSD`, `INSB` | Insider trades for a company (with buy/sell markers on the chart), or the market-wide feed of insider buys, cluster buys, officer buys and big sales |
| `CONG` | Stock trades disclosed by members of the House, with tickers and amounts extracted from the filings |
| `HDS` | Institutional, fund and insider holders, with the biggest buyers and sellers among them and insiders' net open-market trades |
| `OMON`, `UOA` | Options chain with put/call ratio, max pain and implied move; scan for unusual options activity |
| `SI`, `SHRT` | Short interest and daily FINRA short volume for a stock; market-wide short-volume leaders |
| `WIRP` | Fed funds futures: implied rate path and odds for each FOMC meeting |
| `ECST` | Macro dashboard: CPI, core CPI, jobs, wages, JOLTS, EFFR/SOFR, yield curve, risk gauges |
| `PRED`, `SENT` | Prediction-market odds (macro, politics, geopolitics, crypto); Fear & Greed and Reddit trending tickers |
| `ECO`, `EARN` | This week's economic calendar; earnings calendar by date |
| `TRACK`, `TANK` | Follow specific ships (search, trails); Baltic tanker flow at Russian export ports |
| `BTST` | Strategy backtester: write a strategy in JavaScript, test it on one or more symbols (`BTST AAPL`), see equity vs buy & hold, trades and statistics, and optimize parameters with an out-of-sample check |
| `BOT` | Trading bots: run a strategy live on completed bars; it trades the paper portfolio |
| `W` | Watchlist |
| `PORT` | Paper portfolio: P&L, positions, blotter ($1M starting cash) |
| `SECF`, `HELP`, `MENU` | Search, function directory, back |

## Strategies and bots

`BTST` opens an editor with a strategy written in plain JavaScript. `onBar()` runs once per bar after it closes, and orders fill at the next bar's open, so a strategy can never see the future:

```js
const FAST = param('fast', 20, 5, 100, 5);   // name, default, min, max, step
const SLOW = param('slow', 50, 20, 250, 10);

function onBar() {
  const fast = sma(close, FAST), slow = sma(close, SLOW);
  plot(fast, 'SMA fast'); plot(slow, 'SMA slow');
  if (crossover(fast, slow)) buy({ stop: 0.08 });
  if (crossunder(fast, slow)) sell();
}
```

- **Built-in functions:**
  - Indicators: `sma`, `ema`, `wma`, `rsi`, `macd`, `bbands`, `atr`, `stoch`, `vwap`, `obv`, `highest`/`lowest`.
  - Orders: `buy`, `sell`, `short`, `cover`, `target(x)` and `exit`, with stop-loss, take-profit and trailing-stop exits.
  - Charting and logging: `plot`, `plotLower`, `log`.

  The API REFERENCE tab lists everything. There are eight templates to start from.
- **Settings:** commission, slippage, fill at the next open or the same close, and dividend-adjusted prices. The history can be daily, weekly, hourly or intraday.
- **Optimization:** sweeps the parameters declared with `param()`. It ranks the combinations on the first part of the history, then reports how each one did on the remaining bars it never saw, plus a rank correlation that flags overfitting.
- **Safety:** strategy code runs in a Web Worker (`engine.js`). An endless loop is stopped after 30 seconds without freezing the terminal.
- **Bots:** **MAKE BOT** turns the strategy into a bot (`BOT`). On every completed bar (1 min to daily), a bot replays the strategy on the latest history. When the strategy's position changes, the bot trades its allocation in the paper portfolio at the live price, and each fill is tagged with the bot's name in `PORT`.
- **Bot limits:** bots run in your browser, so they only trade while the terminal is open in a tab. They are paper trading only.

Strategies, bots and tracked aircraft are stored in your browser's localStorage. `engine.js` can also be `require()`d from Node to run backtests outside the browser; `npm test` runs its tests.

**Keys:** `F1` help · `F2`–`F11` market-sector keys (GOVT … CRNCY) · `Esc` cancel · `Alt+←` back · `Tab` or `Alt+1…4` switch panel · `↑/↓` autocomplete and command history · `PgUp/PgDn` scroll.

The layout, each panel's screen, the watchlist, command history and the paper portfolio are saved in your browser's localStorage.

*This is a fan-made project with no connection to Bloomberg L.P. The data is provided as-is and is not investment advice.*
