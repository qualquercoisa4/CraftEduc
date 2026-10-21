import assert from 'node:assert/strict'
import { B, DEFAULT_HOTBAR } from '../lib/game/constants'
import { blockMass, RigidPhysics } from '../lib/game/rigid-physics'
import type { World } from '../lib/game/world'

async function main() {
  assert.equal(DEFAULT_HOTBAR.length, 9, 'hotbar must contain exactly nine slots')
  assert.ok(blockMass(B.ALUMINUM) < blockMass(B.WOOD), 'aluminum must be lighter than wood')
  assert.ok(blockMass(B.WOOD) < blockMass(B.IRON), 'wood must be lighter than iron')
  assert.ok(blockMass(B.MOTOR) > blockMass(B.ALUMINUM), 'a motor must weigh more than aluminum')

  // Use the production rigid-body factory and its actual per-material collider
  // densities; no mocked physics response is used in the collision experiment.
  const mockWorld = {
    chunks: new Map(),
    getBlock: () => B.AIR,
  } as unknown as World
  const physics = new RigidPhysics(mockWorld)
  await physics.waitUntilReady()
  assert.equal(physics.ready, true, 'Rapier must initialize for the test')

  const runLift = (targetMaterial: number) => {
    const arm = physics.createRigidBody(
      [
        { x: 0, y: 8, z: 0, id: B.WOOD },
        { x: 1, y: 8, z: 0, id: B.WOOD },
      ],
      // Center of mass of the two-block wooden arm.
      new (require('three').Vector3)(1, 8.5, 0.5),
      { canSleep: false, linearDamping: 0, angularDamping: 0 },
    )
    const target = physics.createRigidBody(
      [{ x: 2, y: 9, z: 0, id: targetMaterial }],
      new (require('three').Vector3)(2.5, 9.5, 0.5),
      { canSleep: false, linearDamping: 0, angularDamping: 0 },
    )
    assert.ok(arm && target, 'factory must create both rigid bodies')
    const initialY = target.translation().y
    // Drive the wooden arm upwards into a touching target. Gravity remains
    // enabled, so the result includes collision response under normal load.
    arm.setLinvel({ x: 0, y: 4.5, z: 0 }, true)
    for (let step = 0; step < 12; step++) physics.step(1 / 60)
    const lifted = target.translation().y - initialY
    physics.removeRigidBody(target)
    physics.removeRigidBody(arm)
    return lifted
  }

  const aluminumLift = runLift(B.ALUMINUM)
  const woodLift = runLift(B.WOOD)
  assert.ok(aluminumLift > 0.05, `wood arm must lift aluminum; displacement was ${aluminumLift.toFixed(3)} m`)
  assert.ok(aluminumLift > woodLift + 0.02,
    `lighter aluminum should be lifted farther than wood (Al=${aluminumLift.toFixed(3)} m, wood=${woodLift.toFixed(3)} m)`)

  physics.dispose()
  console.log('PASS: hotbar has exactly 9 slots')
  console.log(`PASS: mass order aluminum=${blockMass(B.ALUMINUM)}, wood=${blockMass(B.WOOD)}, iron=${blockMass(B.IRON)}`)
  console.log(`PASS: wooden arm collision lifted aluminum ${aluminumLift.toFixed(3)} m vs wood ${woodLift.toFixed(3)} m in 0.2 s`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
