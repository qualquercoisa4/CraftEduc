import assert from 'node:assert/strict'
import { B, DIRS } from '../lib/game/constants'
import { measureProximityDistance, proximityConditionMatches } from '../lib/game/mechanics'
import type { World } from '../lib/game/world'

const makeWorld = (blocks: Set<string>) => ({
  getBlock: (x: number, y: number, z: number) => blocks.has(`${x},${y},${z}`) ? B.IRON : B.AIR,
}) as unknown as World

for (let facing = 0; facing < DIRS.length; facing++) {
  const [dx, dy, dz] = DIRS[facing]
  const blocks = new Set([`${4 + dx * 4},${8 + dy * 4},${-2 + dz * 4}`])
  const distance = measureProximityDistance(makeWorld(blocks), 4, 8, -2, facing)
  assert.equal(distance, 4, `sensor facing ${facing} should find the block four voxels ahead`)
}

assert.equal(measureProximityDistance(makeWorld(new Set()), 0, 8, 0, 5), 33,
  'an empty line of sight should report beyond the 32-block maximum range')
assert.equal(proximityConditionMatches(2, 'less', 3), true, 'less-than condition must pass below threshold')
assert.equal(proximityConditionMatches(3, 'less', 3), false, 'less-than condition is strict')
assert.equal(proximityConditionMatches(4, 'greater', 3), true, 'greater-than condition must pass above threshold')
assert.equal(proximityConditionMatches(3, 'greater', 3), false, 'greater-than condition is strict')
assert.equal(proximityConditionMatches(2, 'lessEqual', 2), true, 'less-than-or-equal condition includes the threshold')
assert.equal(proximityConditionMatches(3, 'lessEqual', 2), false, 'less-than-or-equal rejects values above the threshold')
assert.equal(proximityConditionMatches(3, 'greaterEqual', 3), true, 'greater-than-or-equal condition includes the threshold')
assert.equal(proximityConditionMatches(2, 'greaterEqual', 3), false, 'greater-than-or-equal rejects values below the threshold')
assert.equal(proximityConditionMatches(3, 'equal', 3), true, 'equality matches the threshold')
assert.equal(proximityConditionMatches(2, 'equal', 3), false, 'equality rejects different values')
assert.equal(proximityConditionMatches(33, 'greater', 32), true, 'an unobstructed range should pass a greater-than-32 condition')
console.log('Proximity sensor condition tests passed')
