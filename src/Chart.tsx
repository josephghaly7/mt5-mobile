import { useEffect, useRef } from 'react'
import {
  createChart,
  IChartApi,
  ISeriesApi,
  LineData,
  HistogramData,
  CrosshairMode,
  UTCTimestamp
} from 'lightweight-charts'
import type { Bar } from './indicators'
import { sma, ema, bollinger, vwap, stochRSI, ttmSqueeze, buildRenko, RenkoBrick } from './indicators'

export type ChartType = 'candles' | 'renko'

interface Props {
  bars: Bar[]
  chartType: ChartType
  renkoBox: number           // ignored when chartType !== 'renko'
  indicators: {
    sma20: boolean
    ema9: boolean
    ema21: boolean
    bb: boolean
    vwap: boolean
    stochRSI: boolean
    ttmSqueeze: boolean
  }
}

type AnySeries = ISeriesApi<'Line'> | ISeriesApi<'Area'> | ISeriesApi<'Candlestick'> | ISeriesApi<'Histogram'>

// Color palette — matches desktop so muscle memory carries over.
const COLORS = {
  up: '#26a69a',
  down: '#ef5350',
  sma20: '#2196f3',
  ema9: '#ff9800',
  ema21: '#e91e63',
  bbU: '#9c27b0',
  bbM: '#9c27b0',
  bbL: '#9c27b0',
  vwap: '#607d8b',
  ttmSqzOn: '#000000',   // black dots for squeeze-on markers
  stochK: '#2196f3',
  stochD: '#ff9800',
}

export function Chart({ bars, chartType, renkoBox, indicators }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const seriesRef = useRef<Record<string, ISeriesApi<'Line'> | ISeriesApi<'Area'> | ISeriesApi<'Histogram'>>>({})

  // One-time chart creation
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
      upColor: COLORS.up, downColor: COLORS.down, borderVisible: false,
      wickUpColor: COLORS.up, wickDownColor: COLORS.down
    })
    candleRef.current = candle

    const vol = chart.addHistogramSeries({
      priceFormat: { type: 'volume' }, priceScaleId: 'vol', color: '#26a69a26'
    })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 }, borderVisible: false })
    volumeRef.current = vol

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

  // Toggle candle vs renko data
  useEffect(() => {
    if (!candleRef.current || !volumeRef.current || bars.length === 0) return
    const chart = chartRef.current
    if (!chart) return

    if (chartType === 'renko') {
      const bricks = buildRenko(bars, renkoBox)
      // Lightweight-charts requires unique timestamps per series. Renko can
      // emit multiple bricks per minute, so we use a synthetic sequential
      // time index (1, 2, 3...) instead of bar.time. This loses the wall-clock
      // time scale (use candles for that) but keeps the bricks aligned.
      candleRef.current.setData(bricks.map((b, i) => ({
        time: i as any,  // numeric index, no duplicates possible
        open: b.open, high: b.high, low: b.low, close: b.close
      })))
      volumeRef.current.setData([])
      const last = Math.max(0, bricks.length - 100)
      chart.timeScale().setVisibleLogicalRange({ from: last, to: last + 110 })
    } else {
      candleRef.current.setData(bars.map(b => ({
        time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close
      })))
      volumeRef.current.setData(bars.map(b => ({
        time: b.time as UTCTimestamp, value: b.volume,
        color: b.close >= b.open ? '#26a69a55' : '#ef535055'
      })))
      const last = Math.max(0, bars.length - 100)
      chart.timeScale().setVisibleLogicalRange({ from: last, to: last + 110 })
    }
  }, [bars, chartType, renkoBox])

  // Manage indicator series
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || bars.length === 0) return

    const ensure = (key: string, create: () => AnySeries): ISeriesApi<'Line'> | ISeriesApi<'Area'> | ISeriesApi<'Histogram'> => {
      if (!seriesRef.current[key]) seriesRef.current[key] = create() as any
      return seriesRef.current[key]
    }
    const remove = (key: string) => {
      if (seriesRef.current[key]) {
        try { chart.removeSeries(seriesRef.current[key] as any) } catch { /* ignore */ }
        delete seriesRef.current[key]
      }
    }

    // Overlays only on the price pane. When chartType === 'renko', skip overlays
    // because Renko bricks don't have a meaningful "price at time T" axis.
    const isPricePane = chartType === 'candles'

    if (isPricePane && indicators.sma20) {
      const s = ensure('sma20', () => chart.addLineSeries({ color: COLORS.sma20, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }))
      const v = sma(bars, 20)
      const data: LineData[] = []
      for (let i = 0; i < bars.length; i++) if (v[i] != null) data.push({ time: bars[i].time as UTCTimestamp, value: v[i] as number })
      s.setData(data)
    } else remove('sma20')

    if (isPricePane && indicators.ema9) {
      const s = ensure('ema9', () => chart.addLineSeries({ color: COLORS.ema9, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }))
      const v = ema(bars, 9)
      const data: LineData[] = []
      for (let i = 0; i < bars.length; i++) if (v[i] != null) data.push({ time: bars[i].time as UTCTimestamp, value: v[i] as number })
      s.setData(data)
    } else remove('ema9')

    if (isPricePane && indicators.ema21) {
      const s = ensure('ema21', () => chart.addLineSeries({ color: COLORS.ema21, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }))
      const v = ema(bars, 21)
      const data: LineData[] = []
      for (let i = 0; i < bars.length; i++) if (v[i] != null) data.push({ time: bars[i].time as UTCTimestamp, value: v[i] as number })
      s.setData(data)
    } else remove('ema21')

    if (isPricePane && indicators.bb) {
      const u = ensure('bbU', () => chart.addLineSeries({ color: COLORS.bbU, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false }))
      const m = ensure('bbM', () => chart.addLineSeries({ color: COLORS.bbM, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }))
      const l = ensure('bbL', () => chart.addLineSeries({ color: COLORS.bbL, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false }))
      const v = bollinger(bars, 20, 2)
      const du: LineData[] = [], dm: LineData[] = [], dl: LineData[] = []
      for (let i = 0; i < bars.length; i++) {
        if (v[i]) {
          du.push({ time: bars[i].time as UTCTimestamp, value: v[i]!.upper })
          dm.push({ time: bars[i].time as UTCTimestamp, value: v[i]!.middle })
          dl.push({ time: bars[i].time as UTCTimestamp, value: v[i]!.lower })
        }
      }
      u.setData(du); m.setData(dm); l.setData(dl)
    } else {
      remove('bbU'); remove('bbM'); remove('bbL')
    }

    if (isPricePane && indicators.vwap) {
      const s = ensure('vwap', () => chart.addAreaSeries({ lineColor: COLORS.vwap, topColor: '#607d8b20', bottomColor: '#607d8b00', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }))
      const v = vwap(bars)
      const data: LineData[] = []
      for (let i = 0; i < bars.length; i++) if (v[i] != null) data.push({ time: bars[i].time as UTCTimestamp, value: v[i] as number })
      s.setData(data)
    } else remove('vwap')

    // StochRSI and TTM Squeeze require real OHLC bars (not Renko bricks).
    // When chartType === 'renko', skip them — they don't make sense on a
    // brick chart. The chip toggles stay active in state so flipping back
    // to candles restores the panes immediately.
    const supportsOscillators = chartType === 'candles'

    if (supportsOscillators && indicators.stochRSI) {
      const kSeries = ensure('stochK', () => {
        const s = chart.addLineSeries({
          color: COLORS.stochK, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
          priceScaleId: 'stoch'
        })
        chart.priceScale('stoch').applyOptions({
          scaleMargins: { top: 0.70, bottom: 0 },
          borderVisible: false,
          // StochRSI ranges 0-100, fix that
          autoScale: false,
        })
        return s
      }) as ISeriesApi<'Line'>

      const dSeries = ensure('stochD', () => chart.addLineSeries({
        color: COLORS.stochD, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
        priceScaleId: 'stoch'
      })) as ISeriesApi<'Line'>

      const { k, d } = stochRSI(bars, 14, 14, 3, 3)
      const kd: LineData[] = [], dd: LineData[] = []
      for (let i = 0; i < bars.length; i++) {
        if (k[i] != null) kd.push({ time: bars[i].time as UTCTimestamp, value: k[i] as number })
        if (d[i] != null) dd.push({ time: bars[i].time as UTCTimestamp, value: d[i] as number })
      }
      kSeries.setData(kd); dSeries.setData(dd)
    } else {
      remove('stochK'); remove('stochD')
    }

    if (supportsOscillators && indicators.ttmSqueeze) {
      const ttm = ttmSqueeze(bars, 20, 2, 20, 1.5, 20)
      // Three separate histogram series so each can have its own color
      const green = ensure('ttmGreen', () => chart.addHistogramSeries({
        color: COLORS.up, priceScaleId: 'ttm', priceLineVisible: false, lastValueVisible: false
      })) as ISeriesApi<'Histogram'>
      const red = ensure('ttmRed', () => chart.addHistogramSeries({
        color: '#ef9a9a', priceScaleId: 'ttm', priceLineVisible: false, lastValueVisible: false
      })) as ISeriesApi<'Histogram'>
      const gray = ensure('ttmGray', () => chart.addHistogramSeries({
        color: '#787b86', priceScaleId: 'ttm', priceLineVisible: false, lastValueVisible: false
      })) as ISeriesApi<'Histogram'>

      chart.priceScale('ttm').applyOptions({
        scaleMargins: { top: 0.40, bottom: 0.30 },
        borderVisible: false,
      })

      const gd: HistogramData[] = [], rd: HistogramData[] = [], grd: HistogramData[] = []
      for (let i = 0; i < bars.length; i++) {
        if (ttm.histogram[i] == null) continue
        const point = { time: bars[i].time as UTCTimestamp, value: ttm.histogram[i] as number }
        if (ttm.histogramColor[i] === 'green') gd.push(point)
        else if (ttm.histogramColor[i] === 'red') rd.push(point)
        else grd.push(point)
      }
      green.setData(gd); red.setData(rd); gray.setData(grd)
    } else {
      remove('ttmGreen'); remove('ttmRed'); remove('ttmGray')
    }
  }, [bars, indicators, chartType])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}
