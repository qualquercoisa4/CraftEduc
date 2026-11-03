import * as THREE from 'three'
import { B, DIRS } from './constants'
import type { World } from './world'

export const PROXIMITY_SENSOR_RANGE = 32
export type ProximityComparison = 'greater' | 'greaterEqual' | 'equal' | 'lessEqual' | 'less'

/** Cast a voxel ray from the sensor's actual world-space position and orientation. */
export function measureProximityRayDistance(
  world: Pick<World, 'getBlock'>,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxRange = PROXIMITY_SENSOR_RANGE,
) {
  const rayDirection = direction.clone()
  if (rayDirection.lengthSq() < 1e-8) return maxRange + 1
  rayDirection.normalize()
  const startX = Math.floor(origin.x)
  const startY = Math.floor(origin.y)
  const startZ = Math.floor(origin.z)
  // Sample at 10 cm intervals so a rotated sensor notices voxel faces it
  // crosses between whole-block distances. Return distance in whole blocks.
  for (let travelled = 0.1; travelled <= maxRange + 0.5; travelled += 0.1) {
    const x = Math.floor(origin.x + rayDirection.x * travelled)
    const y = Math.floor(origin.y + rayDirection.y * travelled)
    const z = Math.floor(origin.z + rayDirection.z * travelled)
    if (x === startX && y === startY && z === startZ) continue
    if (world.getBlock(x, y, z) !== B.AIR) return Math.max(1, Math.ceil(travelled - 1e-8))
  }
  return maxRange + 1
}

export function measureProximityDistance(
  world: Pick<World, 'getBlock'>,
  x: number, y: number, z: number, facing: number,
  maxRange = PROXIMITY_SENSOR_RANGE,
) {
  const direction = DIRS[facing] ?? DIRS[5]
  return measureProximityRayDistance(
    world,
    new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5),
    new THREE.Vector3(direction[0], direction[1], direction[2]),
    maxRange,
  )
}

export function proximityConditionMatches(distance: number, comparison: ProximityComparison, threshold: number) {
  switch (comparison) {
    case 'less': return distance < threshold
    case 'lessEqual': return distance <= threshold
    case 'equal': return distance === threshold
    case 'greaterEqual': return distance >= threshold
    case 'greater': return distance > threshold
  }
  return false
}
