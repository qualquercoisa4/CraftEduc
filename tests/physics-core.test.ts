import assert from 'node:assert/strict'
import * as THREE from 'three'
import { B } from '../lib/game/constants'
import { blockMass, RigidPhysics } from '../lib/game/rigid-physics'
import { getMotorSpec } from '../lib/game/motor-specs'
import { calculateWheelNormalForce } from '../lib/game/wheel-traction'
import type { World } from '../lib/game/world'

const near = (actual: number, expected: number, tolerance: number, label: string) => {
  assert.ok(Number.isFinite(actual), `${label}: expected finite value, got ${actual}`)
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, got ${actual}`)
}

async function main() {
  near(calculateWheelNormalForce(5, 0.01, 0), 4.75, 1e-8,
    'a small positive wheel gap must retain suspension-supported normal load')
  near(calculateWheelNormalForce(5, 0.2, 0), 0, 1e-8,
    'a wheel beyond suspension reach must lose normal load')
  near(calculateWheelNormalForce(5, -0.01, 0), 7.5, 1e-8,
    'wheel compression must be capped to prevent launch impulses')

  const tt = getMotorSpec('tt48')
  near(blockMass(B.MOTOR, { motorType: 'tt48' }), tt.massKg, 1e-9, 'TT motor catalog mass')
  near(blockMass(B.MOTOR, { motorType: 'tt48', mountedWheel: true }), tt.massKg + 0.08, 1e-9,
    'mounted wheel accessory mass must be included')
  near(blockMass(B.BATTERY_BOX, { batteries: 3 }), 1.01, 1e-9,
    'three battery cells must contribute to the battery-box mass')

  const world = {
    type: 'flat',
    chunks: new Map(),
    getBlock: () => B.AIR,
  } as unknown as World
  const physics = new RigidPhysics(world)
  await physics.waitUntilReady()
  assert.equal(physics.ready, true, 'Rapier must initialize')

  const ordinaryBody = physics.createRigidBody([
    { x: 0, y: 8, z: 0, id: B.ALUMINUM },
    { x: 1, y: 8, z: 0, id: B.WOOD },
  ], new THREE.Vector3(1, 8.5, 0.5), { canSleep: false })
  assert.ok(ordinaryBody, 'ordinary multi-voxel body must be created')
  near(ordinaryBody.mass(), blockMass(B.ALUMINUM) + blockMass(B.WOOD), 1e-5,
    'multi-voxel body mass must equal the sum of voxel masses')

  const motorBody = physics.createRigidBody([
    { x: 4, y: 8, z: 0, id: B.MOTOR, state: { motorType: 'tt48', mountedWheel: true } },
  ], new THREE.Vector3(4.5, 8.5, 0.5), { canSleep: false })
  assert.ok(motorBody, 'mounted motor body must be created')
  near(motorBody.mass(), tt.massKg + 0.08, 1e-5,
    'reduced mounted-motor collider must preserve its configured mass')

  const beforeInvalidSteps = ordinaryBody.translation().y
  physics.step(Number.NaN)
  physics.step(Number.POSITIVE_INFINITY)
  near(ordinaryBody.translation().y, beforeInvalidSteps, 1e-8,
    'invalid frame deltas must not advance or poison the accumulator')
  physics.step(1 / 60)
  assert.ok(ordinaryBody.translation().y < beforeInvalidSteps,
    'a valid step after invalid deltas must still apply gravity')

  const invalidJoint = physics.createRevoluteJoint(
    ordinaryBody, motorBody, new THREE.Vector3(0, 0, 0),
  )
  assert.equal(invalidJoint, null, 'zero-length joint axes must be rejected safely')

  const bareGear = physics.createAnchoredRevoluteBody(
    [{ x: 10, y: 8, z: 0, id: B.GEAR }],
    new THREE.Vector3(10.5, 8.5, 0.5),
    new THREE.Vector3(0, 1, 0),
  )
  const loadedGear = physics.createAnchoredRevoluteBody(
    [
      { x: 14, y: 8, z: 0, id: B.GEAR },
      { x: 14, y: 9, z: 0, id: B.IRON },
      { x: 14, y: 10, z: 0, id: B.IRON },
    ],
    new THREE.Vector3(14.5, 8.5, 0.5),
    new THREE.Vector3(0, 1, 0),
  )
  assert.ok(bareGear && loadedGear, 'gear assemblies must create revolute rigid bodies')
  near(loadedGear.body.mass(), blockMass(B.GEAR) + 2 * blockMass(B.IRON), 1e-5,
    'axially mounted blocks must contribute their real voxel mass')
  bareGear.body.applyTorqueImpulse({ x: 0, y: 0.5, z: 0 }, true)
  loadedGear.body.applyTorqueImpulse({ x: 0, y: 0.5, z: 0 }, true)
  physics.step(1 / 60)
  const bareSpeed = Math.abs(bareGear.body.angvel().y)
  const loadedSpeed = Math.abs(loadedGear.body.angvel().y)
  assert.ok(bareSpeed > 0.01, 'a powered gear rotor must rotate around its shaft axis')
  assert.ok(loadedSpeed > 0.001, 'a loaded gear rotor must still rotate under the same drive impulse')
  assert.ok(loadedSpeed < bareSpeed,
    'the same motor impulse must accelerate a heavier gear assembly less')
  near(bareGear.body.translation().x, 10.5, 1e-3,
    'revolute gear support must prevent lateral translation')
  near(loadedGear.body.translation().x, 14.5, 1e-3,
    'loaded revolute gear support must prevent lateral translation')
  physics.removeRigidBody(bareGear.body)
  physics.removeRigidBody(loadedGear.body)

  physics.removeRigidBody(motorBody)
  physics.removeRigidBody(ordinaryBody)
  physics.dispose()
  console.log('PASS: voxel mass accounting, mounted wheel mass, fixed-step input guards, joint-axis validation, and tyre normal-force response')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
