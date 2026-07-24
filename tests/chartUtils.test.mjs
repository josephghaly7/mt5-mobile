import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRenko } from '../src/indicators.ts'
import { initialLogicalRange, preserveLogicalRange, sourceTimeRange } from '../src/chartUtils.ts'

test('Renko bricks use the body range so no wick can be rendered', () => {
  const bricks = buildRenko([
    { time: 1, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { time: 2, open: 100, high: 106, low: 94, close: 106, volume: 1 },
    { time: 3, open: 106, high: 108, low: 98, close: 98, volume: 1 },
  ], 2)

  assert.ok(bricks.length > 1)
  for (const brick of bricks) {
    assert.equal(brick.high, Math.max(brick.open, brick.close))
    assert.equal(brick.low, Math.min(brick.open, brick.close))
  }
})

test('initialLogicalRange shows a trailing window with room for live bars', () => {
  assert.deepEqual(initialLogicalRange(300, 100, 10), { from: 200, to: 310 })
  assert.deepEqual(initialLogicalRange(40, 100, 10), { from: 0, to: 50 })
})

test('preserveLogicalRange does not move the user view when a bar is appended', () => {
  const current = { from: 120, to: 220 }
  const oldTimes = [100, 101, 102]
  const newTimes = [100, 101, 102, 103]
  assert.deepEqual(preserveLogicalRange(current, oldTimes, newTimes), current)
})

test('preserveLogicalRange shifts indices when old bars are trimmed', () => {
  const current = { from: 120, to: 220 }
  const oldTimes = [100, 101, 102, 103]
  const newTimes = [101, 102, 103, 104]
  assert.deepEqual(preserveLogicalRange(current, oldTimes, newTimes), { from: 119, to: 219 })
})

test('sourceTimeRange maps Renko brick time windows onto source-bar indices', () => {
  const mainTimes = [100, 101, 102, 103, 104]
  const displaySourceTimes = [100, 100, 102, 102, 104]
  const sourceTimes = [100, 102, 104]
  assert.deepEqual(sourceTimeRange(mainTimes, displaySourceTimes, sourceTimes, { from: 1, to: 3 }), { from: 0, to: 1 })
})