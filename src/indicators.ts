// Indicator calculations — pure functions, run client-side on bars.
// Keeping these here means no extra API calls per indicator add; the backend
// only streams bars, we draw on top.

export interface Bar {
  time: number  // unix seconds (LWC convention)
  open: number
  high: number
  low: number
  close: number
  volume: number
}

// ─── Overlays ───────────────────────────────────────────────────────────────

// Simple Moving Average. Pads warmup with nulls so the line starts at index
// `period - 1` instead of producing fake data at the left edge.
export function sma(bars: Bar[], period: number): Array<number | null> {
  const out: Array<number | null> = []
  let sum = 0
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close
    if (i >= period) sum -= bars[i - period].close
    out.push(i >= period - 1 ? sum / period : null)
  }
  return out
}

// Exponential Moving Average. Standard seeded approach: first EMA value = SMA(period).
// Subsequent values: ema = close * k + ema_prev * (1 - k), where k = 2 / (period + 1).
export function ema(bars: Bar[], period: number): Array<number | null> {
  const out: Array<number | null> = []
  const k = 2 / (period + 1)
  let prev: number | null = null
  let sum = 0
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) {
      sum += bars[i].close
      out.push(null)
      continue
    }
    if (i === period - 1) {
      sum += bars[i].close
      prev = sum / period
      out.push(prev)
      continue
    }
    prev = bars[i].close * k + (prev as number) * (1 - k)
    out.push(prev)
  }
  return out
}

// Bollinger Bands: middle = SMA(20), upper/lower = middle ± 2*stddev.
export function bollinger(bars: Bar[], period = 20, mult = 2): Array<{ upper: number; middle: number; lower: number } | null> {
  const out: Array<{ upper: number; middle: number; lower: number } | null> = []
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) { out.push(null); continue }
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += bars[j].close
    const mean = sum / period
    let sq = 0
    for (let j = i - period + 1; j <= i; j++) sq += (bars[j].close - mean) ** 2
    const sd = Math.sqrt(sq / period)
    out.push({ upper: mean + mult * sd, middle: mean, lower: mean - mult * sd })
  }
  return out
}

// Volume-Weighted Average Price. Reset at session start (per-day for futures).
// For simplicity here we do a cumulative VWAP — fine for intraday ES on a 1m chart.
export function vwap(bars: Bar[]): Array<number | null> {
  const out: Array<number | null> = []
  let cumPV = 0
  let cumV = 0
  for (let i = 0; i < bars.length; i++) {
    const typical = (bars[i].high + bars[i].low + bars[i].close) / 3
    cumPV += typical * bars[i].volume
    cumV += bars[i].volume
    out.push(cumV > 0 ? cumPV / cumV : null)
  }
  return out
}

// ─── Oscillators (pane) ─────────────────────────────────────────────────────

// Stochastic RSI (TradingView default: rsi 14, stoch 14, smooth K=3, smooth D=3).
// Returns { k, d } arrays. Null while warming up. K is fast, D is smoothed.
export function stochRSI(
  bars: Bar[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kSmooth = 3,
  dSmooth = 3,
): { k: Array<number | null>; d: Array<number | null> } {
  const n = bars.length
  // 1. RSI via Wilder's smoothing
  const rsi: Array<number | null> = new Array(n).fill(null)
  if (n < rsiPeriod + 1) return { k: rsi, d: rsi }
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= rsiPeriod; i++) {
    const ch = bars[i].close - bars[i - 1].close
    if (ch >= 0) avgGain += ch; else avgLoss -= ch
  }
  avgGain /= rsiPeriod; avgLoss /= rsiPeriod
  rsi[rsiPeriod] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = rsiPeriod + 1; i < n; i++) {
    const ch = bars[i].close - bars[i - 1].close
    const gain = ch > 0 ? ch : 0
    const loss = ch < 0 ? -ch : 0
    avgGain = (avgGain * (rsiPeriod - 1) + gain) / rsiPeriod
    avgLoss = (avgLoss * (rsiPeriod - 1) + loss) / rsiPeriod
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }

  // 2. Stochastic over the RSI series — find min/max RSI in last `stochPeriod` bars
  const rawK: Array<number | null> = new Array(n).fill(null)
  for (let i = stochPeriod - 1; i < n; i++) {
    if (rsi[i] == null) continue
    let minR = Infinity, maxR = -Infinity
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      const r = rsi[j]; if (r == null) continue
      if (r < minR) minR = r
      if (r > maxR) maxR = r
    }
    if (!isFinite(minR) || !isFinite(maxR) || maxR === minR) { rawK[i] = 0; continue }
    rawK[i] = ((rsi[i] as number) - minR) / (maxR - minR) * 100
  }

  // 3. Smooth K (SMA)
  const k: Array<number | null> = new Array(n).fill(null)
  let kSum = 0
  for (let i = 0; i < n; i++) {
    if (rawK[i] == null) continue
    kSum += rawK[i] as number
    if (i >= kSmooth) kSum -= rawK[i - kSmooth] as number
    if (i >= kSmooth - 1) k[i] = kSum / kSmooth
  }

  // 4. Smooth D (SMA of K)
  const d: Array<number | null> = new Array(n).fill(null)
  let dSum = 0
  for (let i = 0; i < n; i++) {
    if (k[i] == null) continue
    dSum += k[i] as number
    if (i >= dSmooth) dSum -= k[i - dSmooth] as number
    if (i >= dSmooth - 1) d[i] = dSum / dSmooth
  }
  return { k, d }
}

// TTM Squeeze (LazyBear canonical implementation).
// "Squeeze on" = Bollinger Bands are inside Keltner Channels (low volatility).
// "Squeeze off" = BB outside KC (volatility expansion — potential breakout).
// Returns:
//   momentum:    linear regression of close over the last `momPeriod` bars
//   sqzOn:      true while squeeze is on (no histogram coloring needed)
//   histogramColor: 'green' / 'red' / 'gray' per LazyBear convention
//     green = mom up, mom > 0 (rising into positive territory)
//     red   = mom up, mom < 0 (falling but less negative than prior bar)
//     gray  = mom down (momentum falling bar-over-bar)
//   histogram:    momentum value (drawn as histogram bars, color-coded above)
export interface TTMResult {
  momentum: Array<number | null>
  histogram: Array<number | null>
  histogramColor: Array<'green' | 'red' | 'gray' | null>
  sqzOn: Array<boolean | null>
}

export function ttmSqueeze(
  bars: Bar[],
  bbPeriod = 20,
  bbMult = 2,
  kcPeriod = 20,
  kcMult = 1.5,
  momPeriod = 20,
): TTMResult {
  const n = bars.length
  const out: TTMResult = {
    momentum: new Array(n).fill(null),
    histogram: new Array(n).fill(null),
    histogramColor: new Array(n).fill(null),
    sqzOn: new Array(n).fill(null),
  }
  if (n < Math.max(bbPeriod, kcPeriod, momPeriod) + 1) return out

  // EMA helper (Wilder's smoothing for KC matches TradingView)
  const emaSeries = (period: number): Array<number | null> => {
    const k = 1 / period
    const arr: Array<number | null> = new Array(n).fill(null)
    let prev: number | null = null
    let sum = 0
    for (let i = 0; i < n; i++) {
      const close = bars[i].close
      if (i < period) {
        sum += close
        if (i === period - 1) {
          prev = sum / period
          arr[i] = prev
        }
        continue
      }
      prev = close * k + (prev as number) * (1 - k)
      arr[i] = prev
    }
    return arr
  }

  // BB
  const bbUpper: Array<number | null> = new Array(n).fill(null)
  const bbLower: Array<number | null> = new Array(n).fill(null)
  for (let i = bbPeriod - 1; i < n; i++) {
    let sum = 0
    for (let j = i - bbPeriod + 1; j <= i; j++) sum += bars[j].close
    const mean = sum / bbPeriod
    let sq = 0
    for (let j = i - bbPeriod + 1; j <= i; j++) sq += (bars[j].close - mean) ** 2
    const sd = Math.sqrt(sq / bbPeriod)
    bbUpper[i] = mean + bbMult * sd
    bbLower[i] = mean - bbMult * sd
  }

  // KC (EMA + ATR * mult)
  const kcMid = emaSeries(kcPeriod)
  const tr: Array<number> = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    if (i === 0) { tr[i] = bars[i].high - bars[i].low; continue }
    tr[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    )
  }
  // ATR via Wilder
  const atr: Array<number | null> = new Array(n).fill(null)
  if (n >= kcPeriod) {
    let atrSum = 0
    for (let i = 0; i < kcPeriod; i++) atrSum += tr[i]
    atr[kcPeriod - 1] = atrSum / kcPeriod
    for (let i = kcPeriod; i < n; i++) {
      atr[i] = (atr[i - 1] as number * (kcPeriod - 1) + tr[i]) / kcPeriod
    }
  }
  const kcUpper: Array<number | null> = new Array(n).fill(null)
  const kcLower: Array<number | null> = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    if (kcMid[i] == null || atr[i] == null) continue
    kcUpper[i] = (kcMid[i] as number) + kcMult * (atr[i] as number)
    kcLower[i] = (kcMid[i] as number) - kcMult * (atr[i] as number)
  }

  // Momentum = linear regression slope of close over last `momPeriod` bars,
  // scaled by 100 (LazyBear's exact formula to match TradingView).
  // linreg = sum((y - yMean) * (x - xMean)) / sum((x - xMean)^2)
  // For x = 0..momPeriod-1, sum(x-xMean)^2 = momPeriod*(momPeriod^2-1)/12
  for (let i = momPeriod - 1; i < n; i++) {
    const xs = momPeriod
    const xMean = (xs - 1) / 2
    const denom = xs * (xs * xs - 1) / 12
    let ySum = 0
    for (let j = i - momPeriod + 1; j <= i; j++) ySum += bars[j].close
    const yMean = ySum / xs
    let num = 0
    for (let j = 0; j < xs; j++) {
      const y = bars[i - momPeriod + 1 + j].close
      num += (y - yMean) * (j - xMean)
    }
    out.momentum[i] = num / denom
    out.histogram[i] = out.momentum[i]
    // Squeeze on = BB inside KC
    out.sqzOn[i] =
      bbUpper[i] != null && bbLower[i] != null && kcUpper[i] != null && kcLower[i] != null &&
      (bbUpper[i] as number) < (kcUpper[i] as number) &&
      (bbLower[i] as number) > (kcLower[i] as number)

    // LazyBear color: compare to previous bar's momentum
    if (i > 0 && out.momentum[i - 1] != null) {
      const prev = out.momentum[i - 1] as number
      const cur = out.momentum[i] as number
      if (cur > prev) out.histogramColor[i] = cur >= 0 ? 'green' : 'red'
      else out.histogramColor[i] = 'gray'
    } else if (out.momentum[i] != null) {
      out.histogramColor[i] = out.momentum[i] as number >= 0 ? 'green' : 'red'
    }
  }
  return out
}

// ─── Renko ───────────────────────────────────────────────────────────────────

export interface RenkoBrick {
  time: number
  open: number
  high: number
  low: number
  close: number
  // 'up' = close > open (green), 'down' = close < open (red)
  direction: 'up' | 'down'
}

// Build Renko bricks from M1 bars. `boxSize` is the brick height in price.
// New brick is emitted when price moves more than `boxSize` from the last
// brick's close. Wicks are ignored — pure brick open/close.
// Reversal: if price moves >= 2*boxSize in the opposite direction, emit
// two bricks (reversal convention matches the desktop).
// Time assignment matches the desktop mt5-api Renko builder: each brick
// keeps the source bar's wall-clock time. When multiple bricks are emitted
// from the same bar, brick `b` gets `bar.time + b` seconds so the time
// axis remains monotonic without duplicates (LWC requires unique times).
export function buildRenko(bars: Bar[], boxSize: number): RenkoBrick[] {
  const out: RenkoBrick[] = []
  if (bars.length === 0 || boxSize <= 0) return out
  let lastClose = Math.round(bars[0].close / boxSize) * boxSize
  let nextTime = bars[0].time
  out.push({
    time: nextTime,
    open: lastClose,
    high: lastClose + boxSize,
    low: lastClose - boxSize,
    close: lastClose,
    direction: 'up',
  })

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i]
    const price = bar.close
    let delta = price - lastClose
    let b = 0  // brick count from this bar
    while (Math.abs(delta) >= boxSize) {
      const stepDir = delta > 0 ? 'up' : 'down'
      const newClose = lastClose + (delta > 0 ? boxSize : -boxSize)
      // Strictly monotonic: time >= previous brick's time AND time > bar.time
      // so bricks from the same bar are sequential within that minute.
      nextTime = Math.max(bar.time + b, nextTime + 1)
      out.push({
        time: nextTime,
        open: lastClose,
        close: newClose,
        high: Math.max(lastClose, newClose) + boxSize,
        low: Math.min(lastClose, newClose) - boxSize,
        direction: stepDir,
      })
      lastClose = newClose
      delta = price - lastClose
      b++
    }
  }
  return out
}
