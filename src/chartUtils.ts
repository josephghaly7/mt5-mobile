export interface LogicalRange {
  from: number
  to: number
}

export function initialLogicalRange(
  dataLength: number,
  visibleBars = 100,
  rightOffset = 10,
): LogicalRange {
  const from = Math.max(0, dataLength - visibleBars)
  return { from, to: dataLength + rightOffset }
}

/**
 * Translate a logical range across a setData() replacement. Logical indexes
 * move when points are trimmed from the left; appended points only move the
 * view when the user is following the latest bar.
 */
export function preserveLogicalRange(
  current: LogicalRange,
  previousTimes: number[],
  nextTimes: number[],
  followLatest = false,
): LogicalRange {
  if (previousTimes.length === 0 || nextTimes.length === 0) return current

  const nextIndexByTime = new Map<number, number>()
  for (let i = 0; i < nextTimes.length; i++) nextIndexByTime.set(nextTimes[i], i)

  let retainedOldIndex = -1
  let retainedNewIndex = -1
  for (let i = 0; i < previousTimes.length; i++) {
    const nextIndex = nextIndexByTime.get(previousTimes[i])
    if (nextIndex !== undefined) {
      retainedOldIndex = i
      retainedNewIndex = nextIndex
      break
    }
  }
  if (retainedOldIndex < 0 || retainedNewIndex < 0) return current

  const offset = retainedNewIndex - retainedOldIndex
  let from = current.from + offset
  let to = current.to + offset

  if (followLatest) {
    const oldLastTime = previousTimes[previousTimes.length - 1]
    const oldLastNewIndex = nextIndexByTime.get(oldLastTime) ?? -1
    const appended = oldLastNewIndex >= 0
      ? Math.max(0, nextTimes.length - oldLastNewIndex - 1)
      : Math.max(0, nextTimes.length - previousTimes.length + retainedOldIndex)
    from += appended
    to += appended
  }

  return { from, to }
}

/** Map a main-chart time range to the source-bar range used by oscillator panes. */
export function sourceTimeRange(
  displayTimes: number[],
  displaySourceTimes: number[],
  sourceTimes: number[],
  mainRange: { from: number; to: number },
): { from: number; to: number } | null {
  if (displayTimes.length === 0 || displaySourceTimes.length === 0 || sourceTimes.length === 0) return null
  const fromIndex = Math.max(0, Math.floor(mainRange.from))
  const toIndex = Math.min(displayTimes.length - 1, Math.ceil(mainRange.to))
  if (fromIndex > toIndex) return null

  const fromTime = displaySourceTimes[Math.min(fromIndex, displaySourceTimes.length - 1)]
  const toTime = displaySourceTimes[Math.min(toIndex, displaySourceTimes.length - 1)]
  let sourceFrom = 0
  while (sourceFrom < sourceTimes.length - 1 && sourceTimes[sourceFrom] < fromTime) sourceFrom++
  let sourceTo = sourceTimes.length - 1
  while (sourceTo > 0 && sourceTimes[sourceTo] > toTime) sourceTo--
  return { from: sourceFrom, to: Math.max(sourceFrom, sourceTo) }
}
