import { useEffect, useRef } from 'react'
import { createChart, CrosshairMode } from 'lightweight-charts'
import type {
  IChartApi,
  ISeriesApi,
  LineData,
  HistogramData,
  UTCTimestamp,
} from 'lightweight-charts'
import type { Bar } from './indicators'
import { sma, ema, bollinger, vwap, stochRSI, ttmSqueeze, buildRenko } from './indicators'
import { initialLogicalRange, preserveLogicalRange, sourceTimeRange } from './chartUtils'

export type ChartType = 'candles' | 'renko'

interface Props {
  bars: Bar[]
  chartType: ChartType
  renkoBox: number
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

type IndicatorSeries = ISeriesApi<'Line'> | ISeriesApi<'Area'> | ISeriesApi<'Histogram'>
type Pane = { chart: IChartApi; container: HTMLDivElement }
type NumericLogicalRange = { from: number; to: number }

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
  stochK: '#2196f3',
  stochD: '#ff9800',
  ttmGreen: '#26a69a',
  ttmRed: '#ef9a9a',
  ttmGray: '#787b86',
}

const CHART_BG = '#0a0e14'
const GRID = '#1c2030'
const BORDER = '#2a2e39'
const PRICE_SCALE_WIDTH = 62
const PANE_GAP = 1
const OSCILLATOR_HEIGHT = 116
const TTM_HEIGHT = 116
const VISIBLE_BARS = 100
const RIGHT_OFFSET = 10

function makeChart(container: HTMLDivElement, height: number, showTimeScale: boolean): IChartApi {
  return createChart(container, {
    width: Math.max(1, container.clientWidth),
    height: Math.max(1, height),
    layout: {
      background: { color: CHART_BG },
      textColor: '#d1d4dc',
      fontSize: 11,
      attributionLogo: showTimeScale,
    },
    grid: {
      vertLines: { color: GRID },
      horzLines: { color: GRID },
    },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: {
      borderColor: BORDER,
      minimumWidth: PRICE_SCALE_WIDTH,
    },
    timeScale: {
      borderColor: BORDER,
      timeVisible: showTimeScale,
      secondsVisible: false,
      visible: showTimeScale,
      fixRightEdge: false,
      lockVisibleTimeRangeOnResize: true,
      rightBarStaysOnScroll: true,
      shiftVisibleRangeOnNewBar: false,
      allowShiftVisibleRangeOnWhitespaceReplacement: false,
      rightOffset: RIGHT_OFFSET,
    },
    handleScroll: showTimeScale
      ? { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false }
      : false,
    handleScale: showTimeScale
      ? { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
      : false,
  })
}

function makePaneContainer(className: string, height: number, parent: HTMLDivElement): HTMLDivElement {
  const container = document.createElement('div')
  container.className = className
  container.style.width = '100%'
  container.style.height = `${height}px`
  container.style.flex = `0 0 ${height}px`
  container.style.minHeight = `${height}px`
  container.style.position = 'relative'
  container.style.background = CHART_BG
  parent.appendChild(container)
  return container
}

function addPaneLabel(container: HTMLDivElement, text: string): void {
  const label = document.createElement('div')
  label.className = 'chart-pane-label'
  label.textContent = text
  container.appendChild(label)
}

export function Chart({ bars, chartType, renkoBox, indicators }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const mainPaneRef = useRef<Pane | null>(null)
  const oscPaneRef = useRef<Pane | null>(null)
  const ttmPaneRef = useRef<Pane | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const indicatorSeriesRef = useRef<Record<string, IndicatorSeries>>({})
  const indicatorOwnerRef = useRef<Record<string, IChartApi>>({})
  const displayTimesRef = useRef<number[]>([])
  const displaySourceTimesRef = useRef<number[]>([])
  const sourceTimesRef = useRef<number[]>([])
  const logicalRangeRef = useRef<NumericLogicalRange | null>(null)
  const initializedRef = useRef(false)
  const suppressRangeCaptureRef = useRef(false)
  const lastChartModeRef = useRef<string | null>(null)
  const paneVisibilityRef = useRef({ stochRSI: false, ttmSqueeze: false })

  const removeSeries = (key: string) => {
    const series = indicatorSeriesRef.current[key]
    const owner = indicatorOwnerRef.current[key]
    if (!series || !owner) return
    try { owner.removeSeries(series as any) } catch { /* chart may already be disposed */ }
    delete indicatorSeriesRef.current[key]
    delete indicatorOwnerRef.current[key]
  }

  const clearSeries = (keys: string[]) => {
    for (const key of keys) removeSeries(key)
  }

  const syncLowerPanes = (mainRange: NumericLogicalRange | null) => {
    if (!mainRange) return
    const mainTimes = displayTimesRef.current
    const mainSourceTimes = displaySourceTimesRef.current
    const sourceTimes = sourceTimesRef.current
    const paneRange = sourceTimeRange(mainTimes, mainSourceTimes, sourceTimes, mainRange)
    if (!paneRange) return
    for (const pane of [oscPaneRef.current, ttmPaneRef.current]) {
      if (!pane) continue
      try { pane.chart.timeScale().setVisibleLogicalRange(paneRange as any) } catch { /* empty panes can reject a range */ }
    }
  }

  const captureAndSyncRange = (range: NumericLogicalRange | null) => {
    if (!range || suppressRangeCaptureRef.current) return
    logicalRangeRef.current = { from: range.from as number, to: range.to as number }
    syncLowerPanes(logicalRangeRef.current)
  }

  const setLogicalRange = (chart: IChartApi, range: NumericLogicalRange) => {
    chart.timeScale().setVisibleLogicalRange(range as any)
  }

  const setInitialRange = (range: NumericLogicalRange) => {
    const main = mainPaneRef.current
    if (!main) return
    suppressRangeCaptureRef.current = true
    setLogicalRange(main.chart, range)
    logicalRangeRef.current = range
    syncLowerPanes(range)
    requestAnimationFrame(() => { suppressRangeCaptureRef.current = false })
  }

  const preserveMainRange = (range: NumericLogicalRange) => {
    const main = mainPaneRef.current
    if (!main) return
    suppressRangeCaptureRef.current = true
    setLogicalRange(main.chart, range)
    logicalRangeRef.current = range
    syncLowerPanes(range)
    requestAnimationFrame(() => { suppressRangeCaptureRef.current = false })
  }

  const updatePaneLayout = (showOscillator: boolean, showTtm: boolean) => {
    const root = rootRef.current
    const main = mainPaneRef.current
    const osc = oscPaneRef.current
    const ttm = ttmPaneRef.current
    if (!root || !main || !osc || !ttm) return
    paneVisibilityRef.current = { stochRSI: showOscillator, ttmSqueeze: showTtm }

    const setVisibility = (pane: Pane, visible: boolean, height: number) => {
      pane.container.style.display = visible ? 'block' : 'none'
      pane.container.style.flex = visible ? `0 0 ${height}px` : '0 0 0px'
      pane.container.style.height = `${visible ? height : 0}px`
      pane.container.style.minHeight = `${visible ? height : 0}px`
      pane.chart.resize(Math.max(1, root.clientWidth), visible ? height : 1)
    }

    setVisibility(osc, showOscillator, OSCILLATOR_HEIGHT)
    setVisibility(ttm, showTtm, TTM_HEIGHT)
    const reserved = (showOscillator ? OSCILLATOR_HEIGHT : 0)
      + (showTtm ? TTM_HEIGHT : 0)
      + (showOscillator || showTtm ? PANE_GAP * 2 : 0)
    const mainHeight = Math.max(1, root.clientHeight - reserved)
    main.container.style.display = 'block'
    main.container.style.flex = '1 1 auto'
    main.container.style.height = `${mainHeight}px`
    main.container.style.minHeight = '120px'
    main.chart.resize(Math.max(1, root.clientWidth), mainHeight)
  }

  // Lightweight Charts v4 has no real panes. Create three synchronized chart
  // instances so oscillators have their own lower panes and price scales.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    root.replaceChildren()
    root.style.display = 'flex'
    root.style.flexDirection = 'column'
    root.style.width = '100%'
    root.style.height = '100%'
    root.style.minHeight = '0'
    root.style.background = CHART_BG
    root.style.gap = `${PANE_GAP}px`

    const mainContainer = makePaneContainer('chart-pane chart-pane-main', 1, root)
    mainContainer.style.flex = '1 1 auto'
    mainContainer.style.height = 'auto'
    mainContainer.style.minHeight = '120px'
    const oscContainer = makePaneContainer('chart-pane chart-pane-oscillator', OSCILLATOR_HEIGHT, root)
    const ttmContainer = makePaneContainer('chart-pane chart-pane-ttm', TTM_HEIGHT, root)
    addPaneLabel(oscContainer, 'StochRSI')
    addPaneLabel(ttmContainer, 'TTM Squeeze')

    const mainChart = makeChart(mainContainer, 1, true)
    const oscChart = makeChart(oscContainer, OSCILLATOR_HEIGHT, false)
    const ttmChart = makeChart(ttmContainer, TTM_HEIGHT, false)
    mainPaneRef.current = { chart: mainChart, container: mainContainer }
    oscPaneRef.current = { chart: oscChart, container: oscContainer }
    ttmPaneRef.current = { chart: ttmChart, container: ttmContainer }

    const candle = mainChart.addCandlestickSeries({
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderVisible: false,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
    })
    candleRef.current = candle

    const volume = mainChart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      color: '#26a69a26',
    })
    mainChart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
      borderVisible: false,
    })
    volumeRef.current = volume

    const rangeHandler = (range: any) => captureAndSyncRange(range)
    mainChart.timeScale().subscribeVisibleLogicalRangeChange(rangeHandler)

    const resizeObserver = new ResizeObserver(() => {
      // Read the latest visibility state rather than the mount-time effect
      // closure; otherwise a resize caused by showing a pane immediately
      // hides it again with the initial `false, false` values.
      updatePaneLayout(paneVisibilityRef.current.stochRSI, paneVisibilityRef.current.ttmSqueeze)
    })
    resizeObserver.observe(root)
    updatePaneLayout(indicators.stochRSI, indicators.ttmSqueeze)

    return () => {
      mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(rangeHandler)
      resizeObserver.disconnect()
      mainChart.remove()
      oscChart.remove()
      ttmChart.remove()
      mainPaneRef.current = null
      oscPaneRef.current = null
      ttmPaneRef.current = null
      candleRef.current = null
      volumeRef.current = null
      indicatorSeriesRef.current = {}
      indicatorOwnerRef.current = {}
      displayTimesRef.current = []
      displaySourceTimesRef.current = []
      sourceTimesRef.current = []
      logicalRangeRef.current = null
      initializedRef.current = false
      suppressRangeCaptureRef.current = false
      lastChartModeRef.current = null
    }
  }, [])

  useEffect(() => {
    updatePaneLayout(indicators.stochRSI, indicators.ttmSqueeze)
  }, [indicators.stochRSI, indicators.ttmSqueeze])

  // Set main data while preserving the current logical range. The old
  // implementation recalculated a trailing range on every WS message, which
  // made the chart jump whenever a forming/new candle arrived.
  useEffect(() => {
    const mainPane = mainPaneRef.current
    const candle = candleRef.current
    const volume = volumeRef.current
    if (!mainPane || !candle || !volume || bars.length === 0) return

    const chart = mainPane.chart
    const previousTimes = displayTimesRef.current
    const currentLwcRange = chart.timeScale().getVisibleLogicalRange()
    const previousRange = logicalRangeRef.current ?? (currentLwcRange
      ? { from: currentLwcRange.from as number, to: currentLwcRange.to as number }
      : null)
    const modeKey = `${chartType}:${renkoBox}`
    const modeChanged = lastChartModeRef.current !== null && lastChartModeRef.current !== modeKey
    let displayTimes: number[]
    let displaySourceTimes: number[]
    // setData can cause lightweight-charts to emit an intermediate range
    // change. Ignore that internal adjustment until the preserved range below
    // has been restored.
    suppressRangeCaptureRef.current = true

    if (chartType === 'renko') {
      const bricks = buildRenko(bars, renkoBox)
      displayTimes = bricks.map(brick => brick.time)
      displaySourceTimes = bricks.map(brick => brick.sourceTime)
      candle.applyOptions({
        wickVisible: false,
        borderVisible: false,
        wickUpColor: 'transparent',
        wickDownColor: 'transparent',
      })
      candle.setData(bricks.map(brick => ({
        time: brick.time as UTCTimestamp,
        open: brick.open,
        high: Math.max(brick.open, brick.close),
        low: Math.min(brick.open, brick.close),
        close: brick.close,
      })))
      volume.setData([])
    } else {
      displayTimes = bars.map(bar => bar.time)
      displaySourceTimes = displayTimes
      candle.applyOptions({
        wickVisible: true,
        borderVisible: false,
        wickUpColor: COLORS.up,
        wickDownColor: COLORS.down,
      })
      candle.setData(bars.map(bar => ({
        time: bar.time as UTCTimestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })))
      volume.setData(bars.map(bar => ({
        time: bar.time as UTCTimestamp,
        value: bar.volume,
        color: bar.close >= bar.open ? '#26a69a55' : '#ef535055',
      })))
    }

    if (!initializedRef.current || modeChanged || previousTimes.length === 0) {
      setInitialRange(initialLogicalRange(displayTimes.length, VISIBLE_BARS, RIGHT_OFFSET))
      initializedRef.current = true
    } else if (previousRange) {
      preserveMainRange(preserveLogicalRange(previousRange, previousTimes, displayTimes))
    }

    displayTimesRef.current = displayTimes
    displaySourceTimesRef.current = displaySourceTimes
    sourceTimesRef.current = bars.map(bar => bar.time)
    lastChartModeRef.current = modeKey
    requestAnimationFrame(() => { suppressRangeCaptureRef.current = false })
  }, [bars, chartType, renkoBox])

  // Overlay indicators stay with price. Oscillators are rendered in actual
  // lower chart instances, including while Renko is selected.
  useEffect(() => {
    const mainPane = mainPaneRef.current
    const oscPane = oscPaneRef.current
    const ttmPane = ttmPaneRef.current
    if (!mainPane || !oscPane || !ttmPane || bars.length === 0) return

    const mainChart = mainPane.chart
    const oscChart = oscPane.chart
    const ttmChart = ttmPane.chart
    const isPricePane = chartType === 'candles'

    const ensureLine = (key: string, owner: IChartApi, options: any): ISeriesApi<'Line'> => {
      const existing = indicatorSeriesRef.current[key]
      if (existing) return existing as ISeriesApi<'Line'>
      const series = owner.addLineSeries(options)
      indicatorSeriesRef.current[key] = series
      indicatorOwnerRef.current[key] = owner
      return series
    }
    const ensureArea = (key: string, owner: IChartApi, options: any): ISeriesApi<'Area'> => {
      const existing = indicatorSeriesRef.current[key]
      if (existing) return existing as ISeriesApi<'Area'>
      const series = owner.addAreaSeries(options)
      indicatorSeriesRef.current[key] = series
      indicatorOwnerRef.current[key] = owner
      return series
    }
    const ensureHistogram = (key: string, owner: IChartApi, options: any): ISeriesApi<'Histogram'> => {
      const existing = indicatorSeriesRef.current[key]
      if (existing) return existing as ISeriesApi<'Histogram'>
      const series = owner.addHistogramSeries(options)
      indicatorSeriesRef.current[key] = series
      indicatorOwnerRef.current[key] = owner
      return series
    }
    const lineData = (values: Array<number | null>): LineData[] => {
      const data: LineData[] = []
      for (let i = 0; i < values.length && i < bars.length; i++) {
        if (values[i] != null) data.push({ time: bars[i].time as UTCTimestamp, value: values[i] as number })
      }
      return data
    }

    if (isPricePane && indicators.sma20) ensureLine('sma20', mainChart, { color: COLORS.sma20, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(lineData(sma(bars, 20)))
    else removeSeries('sma20')
    if (isPricePane && indicators.ema9) ensureLine('ema9', mainChart, { color: COLORS.ema9, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(lineData(ema(bars, 9)))
    else removeSeries('ema9')
    if (isPricePane && indicators.ema21) ensureLine('ema21', mainChart, { color: COLORS.ema21, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(lineData(ema(bars, 21)))
    else removeSeries('ema21')

    if (isPricePane && indicators.bb) {
      const values = bollinger(bars, 20, 2)
      const upper = ensureLine('bbU', mainChart, { color: COLORS.bbU, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false })
      const middle = ensureLine('bbM', mainChart, { color: COLORS.bbM, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
      const lower = ensureLine('bbL', mainChart, { color: COLORS.bbL, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false })
      const du: LineData[] = [], dm: LineData[] = [], dl: LineData[] = []
      for (let i = 0; i < bars.length; i++) {
        const value = values[i]
        if (!value) continue
        du.push({ time: bars[i].time as UTCTimestamp, value: value.upper })
        dm.push({ time: bars[i].time as UTCTimestamp, value: value.middle })
        dl.push({ time: bars[i].time as UTCTimestamp, value: value.lower })
      }
      upper.setData(du); middle.setData(dm); lower.setData(dl)
    } else {
      clearSeries(['bbU', 'bbM', 'bbL'])
    }

    if (isPricePane && indicators.vwap) ensureArea('vwap', mainChart, { lineColor: COLORS.vwap, topColor: '#607d8b20', bottomColor: '#607d8b00', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(lineData(vwap(bars)))
    else removeSeries('vwap')

    oscChart.priceScale('right').applyOptions({
      autoScale: true,
      scaleMargins: { top: 0.10, bottom: 0.10 },
      borderVisible: false,
      minimumWidth: PRICE_SCALE_WIDTH,
    })
    ttmChart.priceScale('right').applyOptions({
      autoScale: true,
      scaleMargins: { top: 0.10, bottom: 0.10 },
      borderVisible: false,
      minimumWidth: PRICE_SCALE_WIDTH,
    })

    if (indicators.stochRSI) {
      const { k, d } = stochRSI(bars, 14, 14, 3, 3)
      const kSeries = ensureLine('stochK', oscChart, { color: COLORS.stochK, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
      const dSeries = ensureLine('stochD', oscChart, { color: COLORS.stochD, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
      kSeries.setData(lineData(k)); dSeries.setData(lineData(d))
      const upper = ensureLine('stochUpper', oscChart, { color: '#ffffff30', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false })
      const lower = ensureLine('stochLower', oscChart, { color: '#ffffff30', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false })
      const scaleLow = ensureLine('stochScaleLow', oscChart, { color: 'transparent', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
      const scaleHigh = ensureLine('stochScaleHigh', oscChart, { color: 'transparent', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
      upper.setData(bars.map(bar => ({ time: bar.time as UTCTimestamp, value: 80 })))
      lower.setData(bars.map(bar => ({ time: bar.time as UTCTimestamp, value: 20 })))
      scaleLow.setData(bars.map(bar => ({ time: bar.time as UTCTimestamp, value: 0 })))
      scaleHigh.setData(bars.map(bar => ({ time: bar.time as UTCTimestamp, value: 100 })))
    } else {
      clearSeries(['stochK', 'stochD', 'stochUpper', 'stochLower', 'stochScaleLow', 'stochScaleHigh'])
    }

    if (indicators.ttmSqueeze) {
      const ttm = ttmSqueeze(bars, 20, 2, 20, 1.5, 20)
      const green = ensureHistogram('ttmGreen', ttmChart, { color: COLORS.ttmGreen, priceLineVisible: false, lastValueVisible: false })
      const red = ensureHistogram('ttmRed', ttmChart, { color: COLORS.ttmRed, priceLineVisible: false, lastValueVisible: false })
      const gray = ensureHistogram('ttmGray', ttmChart, { color: COLORS.ttmGray, priceLineVisible: false, lastValueVisible: false })
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
      clearSeries(['ttmGreen', 'ttmRed', 'ttmGray'])
    }

    syncLowerPanes(logicalRangeRef.current)
  }, [bars, chartType, indicators])

  return <div ref={rootRef} className="chart-root" />
}
