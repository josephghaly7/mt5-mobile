# MT5 Mobile

iPhone-first PWA for the MT5 desktop charting app at `/home/ubuntu/mt5-api/`.

## What this is

A lightweight Vite+React+TS single-page app that wraps the existing FastAPI
backend on `:5558` with a mobile-tuned UI. Live charts + streaming WS updates
via the same `/api/bars` and `/ws` endpoints the desktop uses.

## Run locally

```bash
cd /home/ubuntu/mt5-mobile
npm install
npm run dev   # vite dev server on :5174, proxies /api and /ws to :5558
```

## Build

```bash
npm run build                # base '/', serves from root
GITHUB_PAGES=1 npm run build # base '/mt5-mobile/', for GitHub Pages
```

## Deploy

1. Push to GitHub Pages (settings -> Pages -> gh-pages branch or `/docs`)
2. Start a Cloudflare quick tunnel from the VM:
   ```bash
   cloudflared tunnel --url http://localhost:5558
   ```
3. Open the PWA URL on iPhone Safari
4. In Settings (⚙), paste the `https://...trycloudflare.com` URL as "API Base"

## Features

- Live candle chart (M1 timeframe) with last 100 bars visible
- Indicators: SMA(20), EMA(9), EMA(21), Bollinger Bands(20,2), VWAP
- Live WS streaming (auto-reconnect with exponential backoff)
- Symbol switcher (EP, ENQ, ES, ES Yahoo, NQ Yahoo)
- Wake-lock to keep screen on during viewing
- Service worker for offline cache + install-to-home-screen

## What was deliberately left out (v1)

- Renko / tick charts (mobile-perf tradeoff)
- Alert management UI (read-only via desktop for now)
- Backtester (desktop only)
- Indicator parameter customization
