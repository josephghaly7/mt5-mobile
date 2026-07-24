import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chart } from './Chart'
import { useMT5WS, WSStatus } from './useMT5WS'
import type { Bar } from './indicators'

interface SymbolInfo {
  symbol: string
  display: string
}

// The mobile app resolves its API base at runtime:
// - When opened from localhost (dev / tunnel direct), use '' so /api hits FastAPI directly
// - When opened from GitHub Pages, the backend is on a different origin (cloudflared tunnel)
//   so the user pastes the tunnel URL in the settings sheet.
const STORAGE_KEY_API = 'mt5-mobile.apiBase'
const STORAGE_KEY_SYMBOL = 'mt5-mobile.symbol'
const STORAGE_KEY_INDICATORS = 'mt5-mobile.indicators'

const DEFAULT_SYMBOLS: SymbolInfo[] = [
  { symbol: '@EP', display: 'EP' },
  { symbol: '@ENQ', display: 'ENQ' },
  { symbol: '@ES', display: 'ES' },
  { symbol: 'ES=F', display: 'ES (Yahoo)' },
  { symbol: 'NQ=F', display: 'NQ (Yahoo)' }
]

export default function App() {
  const [apiBase, setApiBase] = useState(() => localStorage.getItem(STORAGE_KEY_API) || '')
  const [showSettings, setShowSettings] = useState(false)
  const [symbols] = useState(DEFAULT_SYMBOLS)
  const [active, setActive] = useState(() => localStorage.getItem(STORAGE_KEY_SYMBOL) || '@EP')
  const [indicators, setIndicators] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_INDICATORS)
      if (saved) return JSON.parse(saved)
    } catch {}
    return { sma20: false, ema9: true, ema21: true, bb: false, vwap: true }
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
  useEffect(() => localStorage.setItem(STORAGE_KEY_API, apiBase), [apiBase])

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
          <Chart bars={bars} indicators={indicators} />
        )}
      </main>

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
                onChange={e => setApiBase(e.target.value)}
              />
            </label>
            <p className="hint">
              Leave empty for local use. For GitHub Pages access, paste the
              Cloudflare Tunnel URL exposed by <code>cloudflared tunnel --url http://localhost:5558</code>
              on the VM.
            </p>
            <button onClick={() => setShowSettings(false)} className="primary">Done</button>
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
