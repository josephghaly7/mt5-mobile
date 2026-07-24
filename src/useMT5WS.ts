import { useEffect, useRef, useState } from 'react'

export type WSStatus = 'connecting' | 'open' | 'closed' | 'error'

interface BarIn {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
  tick_volume?: number
}

interface Options {
  url: string             // ws:// or wss://
  symbol: string
  tf: string              // backend expects 'tf' field in subscribe msg
  onBar: (bar: { time: number; open: number; high: number; low: number; close: number; volume: number }) => void
  onQuote?: (quote: { bid: number; ask: number; last: number }) => void
  onStatus: (status: WSStatus) => void
}

// Connects to FastAPI /ws. Backend message envelope:
//   { "type": "bars",  "data": [ {time, open, high, low, close, tick_volume}, ... ] }
//   { "type": "quote", "data": { bid, ask, last, ... } }
//   (also broadcasts the latest bar on each poll cycle — type 'bar' or similar)
// On disconnect, reconnect with exponential backoff (1s -> 30s).
export function useMT5WS({ url, symbol, tf, onBar, onQuote, onStatus }: Options) {
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<WSStatus>('connecting')
  const onBarRef = useRef(onBar)
  const onQuoteRef = useRef(onQuote)
  const onStatusRef = useRef(onStatus)
  const backoffRef = useRef(1000)
  const closedByUserRef = useRef(false)

  useEffect(() => { onBarRef.current = onBar }, [onBar])
  useEffect(() => { onQuoteRef.current = onQuote }, [onQuote])
  useEffect(() => { onStatusRef.current = onStatus }, [onStatus])

  useEffect(() => {
    closedByUserRef.current = false
    let cancelled = false

    const updateStatus = (s: WSStatus) => {
      setStatus(s)
      onStatusRef.current(s)
    }

    const handleBar = (b: BarIn) => {
      onBarRef.current({
        time: typeof b.time === 'number' ? b.time : Math.floor(new Date(b.time as any).getTime() / 1000),
        open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close),
        volume: Number(b.tick_volume ?? b.volume ?? 0)
      })
    }

    const handleMessage = (raw: any) => {
      let msg: any
      try { msg = JSON.parse(raw) } catch { return }

      // Envelope: { type, data }
      if (msg && typeof msg === 'object' && 'type' in msg) {
        if (msg.type === 'bars' && Array.isArray(msg.data)) {
          for (const b of msg.data) handleBar(b)
          return
        }
        if (msg.type === 'bar' && msg.data && typeof msg.data === 'object') {
          handleBar(msg.data); return
        }
        if (msg.type === 'quote' && msg.data && typeof msg.data === 'object') {
          const d = msg.data
          if (onQuoteRef.current && typeof d.last === 'number') {
            onQuoteRef.current({ bid: Number(d.bid ?? d.last), ask: Number(d.ask ?? d.last), last: Number(d.last) })
          }
          return
        }
        if (msg.type === 'pong') return
        return
      }

      // Legacy / unwrapped shape — top-level bar fields
      if (msg && typeof msg.time === 'number' && typeof msg.close === 'number') {
        handleBar(msg); return
      }
    }

    const connect = () => {
      if (cancelled) return
      updateStatus('connecting')
      let ws: WebSocket
      try { ws = new WebSocket(url) } catch { updateStatus('error'); scheduleReconnect(); return }
      wsRef.current = ws

      ws.onopen = () => {
        backoffRef.current = 1000
        updateStatus('open')
        ws.send(JSON.stringify({ action: 'subscribe', symbol, tf }))
      }
      ws.onmessage = (ev) => handleMessage(ev.data)
      ws.onerror = () => updateStatus('error')
      ws.onclose = () => {
        updateStatus('closed')
        if (!closedByUserRef.current) scheduleReconnect()
      }
    }

    const scheduleReconnect = () => {
      const delay = backoffRef.current
      backoffRef.current = Math.min(backoffRef.current * 1.5, 30000)
      setTimeout(connect, delay)
    }

    connect()

    return () => {
      cancelled = true
      closedByUserRef.current = true
      wsRef.current?.close()
    }
  }, [url, symbol, tf])

  return status
}
