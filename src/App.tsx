import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chart } from './Chart'
import { useMT5WS, WSStatus } from './useMT5WS'
import type { Bar } from './indicators'

interface SymbolInfo {
  symbol: string
  display: string
}

// API base resolution priority:
//   1. localStorage override (user typed one in Settings — sticks)
//   2. Tunnel auto-discovery: fetch tunnel.json from same path (GitHub Pages
//      deploys this on each cloudflared restart — VM publish-tunnel.sh keeps
//      it fresh). Only used when on github.io.
//   3. Page origin (FastAPI via tunnel, dev server, LAN)
const STORAGE_KEY_API = 'mt5-mobile.apiBase'
const STORAGE_KEY_API_DISCOVERED = 'mt5-mobile.apiBaseDiscovered'
const STORAGE_KEY_SYMBOL = 'mt5-mobile.symbol'
const STORAGE_KEY_INDICATORS = 'mt5-mobile.indicators'
const STORAGE_KEY_CHART_TYPE = 'mt5-mobile.chartType'
const STORAGE_KEY_RENKO_BOX = 'mt5-mobile.renkoBox'

function defaultApiBase(): string {
  if (typeof window === 'undefined') return ''
  const override = localStorage.getItem(STORAGE_KEY_API)
  if (override) return override
  // Cached discovered tunnel from a previous visit — survives page reloads
  const cached = localStorage.getItem(STORAGE_KEY_API_DISCOVERED)
  if (cached) return cached
  if (window.location.host.endsWith('.github.io')) return ''
  return window.location.origin
}

const DEFAULT_SYMBOLS: SymbolInfo[] = [
  { symbol: '@EP', display: 'EP' },
  { symbol: '@ENQ', display: 'ENQ' },
  { symbol: '@MES', display: 'MES' }
]

export default function App() {
  const [apiBase, setApiBase] = useState(() => defaultApiBase())
  const [showSettings, setShowSettings] = useState(false)
  const [symbols] = useState(DEFAULT_SYMBOLS)
  const [active, setActive] = useState(() => localStorage.getItem(STORAGE_KEY_SYMBOL) || '@EP')
  const [indicators, setIndicators] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_INDICATORS)
      if (saved) return JSON.parse(saved)
    } catch {}
    return { sma20: false, ema9: true, ema21: true, bb: false, vwap: true, stochRSI: false, ttmSqueeze: false }
  })
  const [chartType, setChartType] = useState<'candles' | 'renko'>(() => {
    return (localStorage.getItem(STORAGE_KEY_CHART_TYPE) as 'candles' | 'renko') || 'candles'
  })
  const [renkoBox, setRenkoBox] = useState<number>(() => {
    const v = parseFloat(localStorage.getItem(STORAGE_KEY_RENKO_BOX) || '')
    return isFinite(v) && v > 0 ? v : 1  // 1-pt default — works for ES/MES/MNQ
  })
  const [bars, setBars] = useState<Bar[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [price, setPrice] = useState<{ last: number; change: number; changePct: number } | null>(null)
  const [showUpdate, setShowUpdate] = useState(false)
  const [wsStatus, setWsStatus] = useState<WSStatus>('connecting')
  const wakeLockRef = useRef<any>(null)

  // Persist user choices
  useEffect(() => localStorage.setItem(STORAGE_KEY_SYMBOL, active), [active])
  useEffect(() => localStorage.setItem(STORAGE_KEY_INDICATORS, JSON.stringify(indicators)), [indicators])
  useEffect(() => localStorage.setItem(STORAGE_KEY_CHART_TYPE, chartType), [chartType])
  useEffect(() => localStorage.setItem(STORAGE_KEY_RENKO_BOX, String(renkoBox)), [renkoBox])
  // Don't auto-persist apiBase here. The override (typed in Settings) IS
  // persisted on every keystroke. Tunnel-discovered URLs are cached under
  // STORAGE_KEY_API_DISCOVERED and refreshed by the discover effect below.

  // Service worker update toast
  useEffect(() => {
    const handler = () => setShowUpdate(true)
    window.addEventListener('sw-update-available', handler)
    return () => window.removeEventListener('sw-update-available', handler)
  }, [])

  // Wake lock while the app is visible — keeps the iPhone screen on during
  // chart watching. Released automatically on visibility change.
  useEffect(() => {
    const requestLock = async () => {
      try {
        // @ts-ignore — Wake Lock API
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen')
        }
      } catch {}
    }
    const releaseLock = () => {
      try { wakeLockRef.current?.release() } catch {}
      wakeLockRef.current = null
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') requestLock(); else releaseLock() }
    requestLock()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { releaseLock(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [])

  // Tunnel auto-discovery: on GitHub Pages, fetch tunnel.json from the same
  // path. The publish-tunnel.sh script on the VM keeps that file in sync
  // with the current trycloudflare URL. We poll every 5 min so URL rotations
  // propagate without a page reload. User override (if any) wins.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (localStorage.getItem(STORAGE_KEY_API)) return  // user override present
    if (!window.location.host.endsWith('.github.io')) return  // served from FastAPI, no need
    let cancelled = false

    const discover = async () => {
      try {
        // Relative URL so it resolves against whatever base path the PWA was
        // served from (GH Pages: /mt5-mobile/tunnel.json, FastAPI: /tunnel.json).
        const r = await fetch(`tunnel.json?t=${Date.now()}`, { cache: 'no-store' })
        if (!r.ok) return
        const data = await r.json()
        if (cancelled || !data?.url) return
        const discovered = data.url as string
        localStorage.setItem(STORAGE_KEY_API_DISCOVERED, discovered)
        setApiBase(prev => prev === discovered ? prev : discovered)
      } catch {
        // Network blip or GH Pages rate limit; keep the cached value
      }
    }

    discover()
    const id = setInterval(discover, 5 * 60 * 1000)  // 5 min
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Initial history fetch — last N bars from FastAPI /api/bars
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    const url = `${apiBase}/api/bars?symbol=${encodeURIComponent(active)}&tf=M1&n=300`
    fetch(url)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => {
        if (cancelled) return
        const arr: Bar[] = (data.bars || []).map((b: any) => ({
          time: typeof b.time === 'number' ? b.time : Math.floor(new Date(b.time).getTime() / 1000),
          open: Number(b.open), high: Number(b.high), low: Number(b.low),
          close: Number(b.close),
          // Backend returns tick_volume; some paths return volume. Try both.
          volume: Number(b.tick_volume ?? b.volume ?? 0)
        }))
        setBars(arr)
        if (arr.length > 0) {
          const last = arr[arr.length - 1].close
          const first = arr[0].open
          const change = last - first
          setPrice({ last, change, changePct: (change / first) * 100 })
        }
        setLoading(false)
      })
      .catch(e => { if (!cancelled) { setError(String(e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [apiBase, active])

  // WebSocket — re-subscribes whenever apiBase or symbol changes
  const wsUrl = useMemo(() => {
    const base = apiBase || ''
    return base.startsWith('https')
      ? base.replace('https', 'wss') + '/ws'
      : base.startsWith('http')
        ? base.replace('http', 'ws') + '/ws'
        : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  }, [apiBase])

  useMT5WS({
    url: wsUrl,
    symbol: active,
    tf: 'M1',
    onStatus: setWsStatus,
    onBar: useCallback((bar: Bar) => {
      setBars(prev => {
        if (prev.length === 0) return [bar]
        const last = prev[prev.length - 1]
        if (bar.time === last.time) {
          // Update the forming bar
          const next = prev.slice(0, -1)
          next.push(bar)
          return next
        }
        if (bar.time > last.time) {
          // New bar closed
          const next = [...prev, bar]
          // Trim to 600 bars to keep memory bounded on iPhone
          return next.length > 600 ? next.slice(next.length - 600) : next
        }
        return prev
      })
      setPrice(prev => prev ? { ...prev, last: bar.close, change: bar.close - prev.last + prev.change } : { last: bar.close, change: 0, changePct: 0 })
    }, []),
    onQuote: useCallback((q: { last: number }) => {
      setPrice(prev => prev ? { ...prev, last: q.last } : { last: q.last, change: 0, changePct: 0 })
    }, [])
  })

  const statusBadge = wsStatus === 'open' ? 'LIVE'
    : wsStatus === 'connecting' ? '…'
    : wsStatus === 'closed' ? 'OFF'
    : 'ERR'

  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-left">
          <select
            value={active}
            onChange={e => setActive(e.target.value)}
            className="symbol-select"
            aria-label="Symbol"
          >
            {symbols.map(s => <option key={s.symbol} value={s.symbol}>{s.display}</option>)}
          </select>
          <span className={`status status-${wsStatus}`} title={wsStatus}>{statusBadge}</span>
        </div>
        {price && (
          <div className="hdr-right">
            <div className="price">{price.last.toFixed(2)}</div>
            <div className={`change ${price.change >= 0 ? 'pos' : 'neg'}`}>
              {price.change >= 0 ? '+' : ''}{price.change.toFixed(2)} ({price.changePct.toFixed(2)}%)
            </div>
          </div>
        )}
        <div className="hdr-actions">
          <button onClick={() => setShowSettings(s => !s)} className="icon-btn" aria-label="Settings">⚙</button>
        </div>
      </header>

      {error && (
        <div className="error-banner">
          {error} — check API base in settings ⚙
        </div>
      )}

      <main className="chart-wrap">
        {loading ? (
          <div className="loading">Loading bars…</div>
        ) : (
          <Chart bars={bars} chartType={chartType} renkoBox={renkoBox} indicators={indicators} />
        )}
      </main>

      <div className="chartbar">
        <button onClick={() => setChartType(c => c === 'candles' ? 'renko' : 'candles')}
                className={`chip ${chartType === 'renko' ? 'on' : ''}`}>
          {chartType === 'renko' ? '🧱 Renko' : '🕯 Candles'}
        </button>
        {chartType === 'renko' && (
          <label className="box-input">
            box
            <input
              type="number"
              step="0.25"
              min="0.25"
              value={renkoBox}
              onChange={e => {
                const v = parseFloat(e.target.value)
                if (isFinite(v) && v > 0) setRenkoBox(v)
              }}
            />
          </label>
        )}
      </div>

      <footer className="ftr">
        <button onClick={() => setIndicators((i: typeof indicators) => ({ ...i, ema9: !i.ema9 }))}
                className={`chip ${indicators.ema9 ? 'on' : ''}`}>EMA 9</button>
        <button onClick={() => setIndicators((i: typeof indicators) => ({ ...i, ema21: !i.ema21 }))}
                className={`chip ${indicators.ema21 ? 'on' : ''}`}>EMA 21</button>
        <button onClick={() => setIndicators((i: typeof indicators) => ({ ...i, sma20: !i.sma20 }))}
                className={`chip ${indicators.sma20 ? 'on' : ''}`}>SMA 20</button>
        <button onClick={() => setIndicators((i: typeof indicators) => ({ ...i, bb: !i.bb }))}
                className={`chip ${indicators.bb ? 'on' : ''}`}>BB</button>
        <button onClick={() => setIndicators((i: typeof indicators) => ({ ...i, vwap: !i.vwap }))}
                className={`chip ${indicators.vwap ? 'on' : ''}`}>VWAP</button>
        <button onClick={() => setIndicators((i: typeof indicators) => ({ ...i, stochRSI: !i.stochRSI }))}
                className={`chip ${indicators.stochRSI ? 'on' : ''}`}>StochRSI</button>
        <button onClick={() => setIndicators((i: typeof indicators) => ({ ...i, ttmSqueeze: !i.ttmSqueeze }))}
                className={`chip ${indicators.ttmSqueeze ? 'on' : ''}`}>TTM</button>
      </footer>

      {showSettings && (
        <div className="modal-bg" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Settings</h3>
            <label>
              API Base URL
              <input
                type="text"
                placeholder="https://your-tunnel.trycloudflare.com"
                value={apiBase}
                onChange={e => {
                  const v = e.target.value
                  setApiBase(v)
                  if (v.trim()) {
                    localStorage.setItem(STORAGE_KEY_API, v.trim())
                    localStorage.removeItem(STORAGE_KEY_API_DISCOVERED)
                  } else {
                    localStorage.removeItem(STORAGE_KEY_API)
                  }
                }}
              />
            </label>
            <p className="hint">
              On GitHub Pages the tunnel URL is auto-discovered and refreshed
              every 5 min (the VM publishes to <code>tunnel.json</code> on every
              cloudflared restart). Tap below to override or reset to auto.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => {
                  localStorage.removeItem(STORAGE_KEY_API)
                  localStorage.removeItem(STORAGE_KEY_API_DISCOVERED)
                  setApiBase('')
                  location.reload()
                }}
                className="primary"
                style={{ background: '#2a2e39' }}
              >
                Use auto-discovery
              </button>
              <button onClick={() => setShowSettings(false)} className="primary">Done</button>
            </div>
          </div>
        </div>
      )}

      {showUpdate && (
        <div className="update-toast" onClick={() => location.reload()}>
          New version available — tap to reload
        </div>
      )}
    </div>
  )
}
