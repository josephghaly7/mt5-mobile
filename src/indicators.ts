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
