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
| Company profile, valuation, analyst ratings & targets | Yahoo Finance quoteSummary |
| Income statement / cash flow / balance sheet | Yahoo Finance fundamentals time series |
| US yield curve | U.S. Treasury daily par yield curve |
| Top news | Yahoo Finance, CNBC, MarketWatch, Federal Reserve and SEC RSS feeds |
| Live flights (ADS-B) | adsb.lol, falling back to airplanes.live, then OpenSky Network |
| Live ships & tankers (AIS) | aisstream.io (global, free key) or Fintraffic Digitraffic (Baltic, no key) |
| Military sites | OpenStreetMap (`military=*` tags) via the Overpass API |
| Satellite imagery | Esri World Imagery (high-res), NASA GIBS MODIS daily & VIIRS night lights |
| US crude, SPR & Cushing inventories | EIA API (free key) |
| Oil futures curves | Yahoo Finance (NYMEX WTI & Brent contracts) |

### Optional API keys

Two free keys unlock extra data. Put them in a `.env` file for local use (see `.env.example`), or add them as Vercel environment variables:

- `AISSTREAM_API_KEY` from [aisstream.io](https://aisstream.io) turns on worldwide ship tracking. Without it, ships are limited to the Baltic Sea.
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
| `TOP`, `N`, `CN` | Top news, news search, company news |
| `DES` | Description: price stats, valuation, profile, officers, 1Y chart |
| `GP`, `GIP` | Price graph (1D to MAX, line/candle, 50/200 SMA, volume, crosshair) and intraday graph |
| `HP` | Historical prices (daily/weekly/monthly, CSV export) |
| `Q` | Quote, bid/ask, ranges, polled price log, trade ticket |
| `FA` | Financial statements, margins, growth |
| `ANR` | Analyst consensus, targets, rating changes |
| `DVD` | Dividend and split history |
| `COMP` | Normalized multi-security return chart |
| `BMAP` | World map with toggleable layers: flights, ships, chokepoints and lanes, energy sites, military sites; dark, satellite, NASA daily or night-lights base maps |
| `FLT`, `SHIP`, `MIL` | The map preset for live flights, live ships and tankers (with a tanker/cargo filter), or military sites. Add a region: `SHIP HORMUZ`, `FLT LONDON` |
| `SAT` | Satellite imagery watchlist: mall and factory parking lots, aircraft storage, tank farms, ports |
| `OIL` | Oil monitor: WTI/Brent futures curves, US inventories and SPR, proved reserves, chokepoints, energy stocks |
| `W` | Watchlist |
| `PORT` | Paper portfolio: P&L, positions, blotter ($1M starting cash) |
| `SECF`, `HELP`, `MENU` | Search, function directory, back |

**Keys:** `F1` help · `F2`–`F11` market-sector keys (GOVT … CRNCY) · `Esc` cancel · `Alt+←` back · `Tab` or `Alt+1…4` switch panel · `↑/↓` autocomplete and command history · `PgUp/PgDn` scroll.

The layout, each panel's screen, the watchlist, command history and the paper portfolio are saved in your browser's localStorage.

*This is a fan-made project with no connection to Bloomberg L.P. The data is provided as-is and is not investment advice.*
