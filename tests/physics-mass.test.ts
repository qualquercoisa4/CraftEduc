import assert from 'node:assert/strict'
import * as THREE from 'three'
import { B, DEFAULT_HOTBAR } from '../lib/game/constants'
import { blockMass, RigidPhysics } from '../lib/game/rigid-physics'
import { Mechanics } from '../lib/game/mechanics'
import { posKey } from '../lib/game/constants'
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
      new THREE.Vector3(1, 8.5, 0.5),
      { canSleep: false, linearDamping: 0, angularDamping: 0 },
    )
    const target = physics.createRigidBody(
      [{ x: 1, y: 9, z: 0, id: targetMaterial }],
      new THREE.Vector3(1.5, 9.5, 0.5),
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

  // Integration regression: a voxel sitting on a static support is normally
  // an immovable world collider. A moving wooden arm must wake it into Rapier
  // when the arm is travelling into it, then push the now-dynamic aluminum.
  const blockMap = new Map<string, number>()
  const stateMap = new Map<string, { glue?: number; facing?: number }>()
  const chunks = new Map([['0,0', { cx: 0, cz: 0, maxY: 8 }]])
  let mechanicsRef: Mechanics | null = null
  const mockGameWorld = {
    chunks,
    states: stateMap,
    getBlock(x: number, y: number, z: number) { return blockMap.get(posKey(x, y, z)) ?? B.AIR },
    getState(x: number, y: number, z: number) { return stateMap.get(posKey(x, y, z)) },
    ensureState(x: number, y: number, z: number) {
      const key = posKey(x, y, z)
      let state = stateMap.get(key)
      if (!state) { state = {}; stateMap.set(key, state) }
      return state
    },
    setBlock(x: number, y: number, z: number, id: number, state?: { glue?: number; facing?: number }) {
      const key = posKey(x, y, z)
      const oldId = blockMap.get(key) ?? B.AIR
      const oldState = stateMap.get(key)
      if (id === B.AIR) blockMap.delete(key)
      else blockMap.set(key, id)
      if (state) stateMap.set(key, { ...state })
      else if (id === B.AIR) stateMap.delete(key)
      mechanicsRef?.onBlockChange(x, y, z, oldId, id, Boolean(oldState?.glue), Boolean(state?.glue))
    },
  } as unknown as World
  const scene = new THREE.Scene()
  const mechanics = new Mechanics(
    mockGameWorld,
    scene,
    new THREE.MeshBasicMaterial(),
    new THREE.MeshBasicMaterial(),
  )
  mechanicsRef = mechanics
  const mechanicsPhysics = (mechanics as unknown as { rigidPhysics: RigidPhysics }).rigidPhysics
  await mechanicsPhysics.waitUntilReady()

  // The support occupies y=4, the static aluminum target sits at y=5,
  // and the wooden pusher touches its left side at x=1.
  mockGameWorld.setBlock(2, 4, 2, B.IRON)
  mockGameWorld.setBlock(2, 5, 2, B.ALUMINUM)
  const movingArm = mechanicsPhysics.createRigidBody(
    [{ x: 1, y: 5, z: 2, id: B.WOOD }],
    new THREE.Vector3(1.5, 5.5, 2.5),
    { canSleep: false, linearDamping: 0, angularDamping: 0 },
  )
  assert.ok(movingArm, 'test pusher body must be created')
  movingArm.setLinvel({ x: 4, y: 0, z: 0 }, true)
  mechanics.contraptions.set('test-pusher', {
    motorKey: '50,5,50',
    rotorBody: movingArm,
    chassisBody: movingArm,
    blocks: [{ rel: [0, 0, 0], id: B.WOOD, origKey: '1,5,2' }],
    chassisBlocks: [],
  } as never)

  const targetStart = 2.5
  ;(mechanics as unknown as { wakeBlocksBeingPushed: () => void }).wakeBlocksBeingPushed()
  assert.equal(mockGameWorld.getBlock(2, 5, 2), B.AIR,
    'a contacted fixed voxel must be removed from the static world when woken')
  const dynamicBodies = (mechanics as unknown as { fallingBodies: { body: import('@dimforge/rapier3d-compat').RigidBody; blocks: { id: number }[] }[] }).fallingBodies
  const dynamicAluminum = dynamicBodies.find((body) => body.blocks.some((block) => block.id === B.ALUMINUM))
  assert.ok(dynamicAluminum, 'the hit aluminum block must become a dynamic rigid body')
  for (let step = 0; step < 12; step++) mechanicsPhysics.step(1 / 60)
  assert.ok(dynamicAluminum.body.translation().x > targetStart + 0.05,
    'the woken aluminum block must be physically pushed by the moving wooden arm')

  mechanicsPhysics.removeRigidBody(movingArm)
  for (const body of dynamicBodies) mechanicsPhysics.removeRigidBody(body.body)
  mechanics.contraptions.clear()
  scene.clear()
  mechanicsPhysics.dispose()

  console.log('PASS: hotbar has exactly 9 slots')
  console.log(`PASS: mass order aluminum=${blockMass(B.ALUMINUM)}, wood=${blockMass(B.WOOD)}, iron=${blockMass(B.IRON)}`)
  console.log(`PASS: wooden arm collision lifted aluminum ${aluminumLift.toFixed(3)} m vs wood ${woodLift.toFixed(3)} m in 0.2 s`)
  console.log('PASS: moving wood arm wakes and pushes a previously static aluminum voxel')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
