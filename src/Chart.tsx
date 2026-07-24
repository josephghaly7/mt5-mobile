import { useEffect, useRef } from 'react'
import {
  createChart,
  IChartApi,
  ISeriesApi,
  LineData,
  CrosshairMode
} from 'lightweight-charts'
import type { Bar } from './indicators'
import { sma, ema, bollinger, vwap } from './indicators'

interface Props {
  bars: Bar[]
  indicators: {
    sma20: boolean
    ema9: boolean
    ema21: boolean
    bb: boolean
    vwap: boolean
  }
}

// v4.2 API: chart.addLineSeries() / addCandlestickSeries() / etc.
// Returns ISeriesApi<"Line">, ISeriesApi<"Candlestick">, etc.
// Series type tag comes from the generic param — no separate SeriesType import.
type AnySeries = ISeriesApi<'Line'> | ISeriesApi<'Area'> | ISeriesApi<'Candlestick'> | ISeriesApi<'Histogram'>

export function Chart({ bars, indicators }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const seriesRef = useRef<Record<string, ISeriesApi<'Line'> | ISeriesApi<'Area'>>>({})

  // One-time chart creation. After that we just .setData() / .update().
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#0a0e14' },
        textColor: '#d1d4dc',
        fontSize: 11
      },
      grid: {
        vertLines: { color: '#1c2030' },
        horzLines: { color: '#1c2030' }
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: {
        borderColor: '#2a2e39',
        timeVisible: true,
        secondsVisible: false,
        fixRightEdge: true
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
    })
    chartRef.current = chart

    const candle = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350'
    })
    candleRef.current = candle

    // Volume histogram at bottom of the price pane — saves vertical space on iPhone
    const vol = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      color: '#26a69a26'
    })
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
      borderVisible: false
    })
    volumeRef.current = vol

    // Resize observer — iPhone Safari has weird viewport-height behavior
    // (address bar show/hide shifts layout). Keep the chart filling its container.
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      chart.applyOptions({ width, height })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
      seriesRef.current = {}
    }
  }, [])

  // Update candle + volume on bar changes
  useEffect(() => {
    if (!candleRef.current || !volumeRef.current || bars.length === 0) return
    candleRef.current.setData(bars.map(b => ({
      time: b.time as any,
      open: b.open, high: b.high, low: b.low, close: b.close
    })))
    volumeRef.current.setData(bars.map(b => ({
      time: b.time as any,
      value: b.volume,
      color: b.close >= b.open ? '#26a69a55' : '#ef535055'
    })))

    // Initial fit: last 100 bars (matches desktop preference).
    // Only do this once per bar-history load, not on every WS tick.
    const chart = chartRef.current
    if (chart) {
      const initialRange = Math.max(0, bars.length - 100)
      chart.timeScale().setVisibleLogicalRange({ from: initialRange, to: initialRange + 110 })
    }
  }, [bars])

  // Manage indicator series — create on enable, remove on disable.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || bars.length === 0) return

    const ensure = (key: string, create: () => AnySeries): ISeriesApi<'Line'> | ISeriesApi<'Area'> => {
      if (!seriesRef.current[key]) seriesRef.current[key] = create() as any
      return seriesRef.current[key]
    }
    const remove = (key: string) => {
      if (seriesRef.current[key]) {
        try { chart.removeSeries(seriesRef.current[key] as any) } catch { /* ignore */ }
        delete seriesRef.current[key]
      }
    }

    if (indicators.sma20) {
      const s = ensure('sma20', () => chart.addLineSeries({ color: '#2196f3', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }))
      const v = sma(bars, 20)
      const data: LineData[] = []
      for (let i = 0; i < bars.length; i++) {
        if (v[i] != null) data.push({ time: bars[i].time as any, value: v[i] as number })
      }
      s.setData(data)
    } else remove('sma20')

    if (indicators.ema9) {
      const s = ensure('ema9', () => chart.addLineSeries({ color: '#ff9800', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }))
      const v = ema(bars, 9)
      const data: LineData[] = []
      for (let i = 0; i < bars.length; i++) {
        if (v[i] != null) data.push({ time: bars[i].time as any, value: v[i] as number })
      }
      s.setData(data)
    } else remove('ema9')

    if (indicators.ema21) {
      const s = ensure('ema21', () => chart.addLineSeries({ color: '#e91e63', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }))
      const v = ema(bars, 21)
      const data: LineData[] = []
      for (let i = 0; i < bars.length; i++) {
        if (v[i] != null) data.push({ time: bars[i].time as any, value: v[i] as number })
      }
      s.setData(data)
    } else remove('ema21')

    if (indicators.bb) {
      const u = ensure('bbU', () => chart.addLineSeries({ color: '#9c27b0', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false }))
      const m = ensure('bbM', () => chart.addLineSeries({ color: '#9c27b0', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }))
      const l = ensure('bbL', () => chart.addLineSeries({ color: '#9c27b0', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false }))
      const v = bollinger(bars, 20, 2)
      const du: LineData[] = [], dm: LineData[] = [], dl: LineData[] = []
      for (let i = 0; i < bars.length; i++) {
        if (v[i]) {
          du.push({ time: bars[i].time as any, value: v[i]!.upper })
          dm.push({ time: bars[i].time as any, value: v[i]!.middle })
          dl.push({ time: bars[i].time as any, value: v[i]!.lower })
        }
      }
      u.setData(du); m.setData(dm); l.setData(dl)
    } else {
      remove('bbU'); remove('bbM'); remove('bbL')
    }

    if (indicators.vwap) {
      const s = ensure('vwap', () => chart.addAreaSeries({ lineColor: '#607d8b', topColor: '#607d8b20', bottomColor: '#607d8b00', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }))
      const v = vwap(bars)
      const data: LineData[] = []
      for (let i = 0; i < bars.length; i++) {
        if (v[i] != null) data.push({ time: bars[i].time as any, value: v[i] as number })
      }
      s.setData(data)
    } else remove('vwap')

  }, [bars, indicators])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}
