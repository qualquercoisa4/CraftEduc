import assert from 'node:assert/strict'
import * as THREE from 'three'
import { B, posKey } from '../lib/game/constants'
import { Mechanics } from '../lib/game/mechanics'
import type { MotorModel } from '../lib/game/models'
import { RigidPhysics } from '../lib/game/rigid-physics'
import { World } from '../lib/game/world'

async function main() {
  const scene = new THREE.Scene()
  const material = new THREE.MeshBasicMaterial()
  const world = new World(scene, material)

  const place = (x: number, y: number, z: number, id: number, state: {
    glue?: number; facing?: number; batteries?: number; mountedWheel?: boolean; switchOn?: boolean
  } = {}) => {
    world.setBlock(x, y, z, id, Object.keys(state).length ? state : undefined)
  }

  // A supported chassis carries two motors whose shaft axes are perpendicular.
  // Motor A spins around +X; motor B is attached on the chassis and spins around +Z.
  place(10, 4, 10, B.ALUMINUM, { glue: 1 << 2 })
  place(10, 5, 10, B.MOTOR, { facing: 0, glue: (1 << 0) | (1 << 2) | (1 << 3) })
  place(10, 6, 10, B.MOTOR, { facing: 4, glue: (1 << 3) | (1 << 4) })
  place(11, 5, 10, B.WOOD, { glue: (1 << 1) | (1 << 2) })
  place(11, 6, 10, B.WOOD, { glue: (1 << 3) | (1 << 2) })
  place(11, 7, 10, B.WOOD, { glue: 1 << 3 })
  place(10, 6, 11, B.WOOD, { glue: (1 << 5) | (1 << 2) })
  place(10, 7, 11, B.WOOD, { glue: 1 << 3 })

  // The auxiliary arm sweeps left through a supported target as it rotates around +Z.
  place(9, 5, 11, B.IRON)
  place(9, 6, 11, B.ALUMINUM)

  const mechanics = new Mechanics(world, scene, material, new THREE.MeshBasicMaterial())
  const internals = mechanics as unknown as {
    rigidPhysics: RigidPhysics
    tryAssemble: (key: string) => string
    powerDirty: boolean
    powerCooldown: number
    mechDirty: boolean
    physicsSynced: boolean
    physicsDirty: boolean
    physicsScanCooldown: number
    fallingBodies: { body: { translation: () => { x: number; y: number; z: number } }; blocks: { originKey: string; id: number }[] }[]
  }
  await internals.rigidPhysics.waitUntilReady()

  world.onBlockChange = (x, y, z, oldId, newId, oldHadGlue, newHasGlue) => {
    mechanics.onBlockChange(x, y, z, oldId, newId, oldHadGlue, newHasGlue)
  }

  const installMotor = (x: number, y: number, z: number) => {
    const group = new THREE.Group()
    const shaft = new THREE.Group()
    group.add(shaft)
    group.position.set(x + 0.5, y + 0.5, z + 0.5)
    scene.add(group)
    const model: MotorModel = { group, shaft }
    mechanics.models.set(posKey(x, y, z), { type: 'motor', model, spin: 0, status: 'idle' })
  }
  installMotor(10, 5, 10)
  installMotor(10, 6, 10)

  const mainKey = posKey(10, 5, 10)
  const secondaryKey = posKey(10, 6, 10)
  const result = internals.tryAssemble(mainKey)
  assert.equal(result, 'driving', 'the chassis and primary arm should assemble')
  const machine = mechanics.contraptions.get(mainKey)
  assert.ok(machine, 'the primary motor should own an assembled chassis')
  assert.equal(machine.extraRotors.length, 1, 'the second motor must create a separate articulated rotor')
  assert.equal(machine.extraRotors[0].motorKey, secondaryKey, 'the extra rotor must belong to the second motor')
  assert.equal(world.getBlock(10, 6, 11), B.AIR, 'the extra rotor seed must leave the static voxel grid')
  assert.equal(world.getBlock(12, 6, 11), B.AIR, 'all glued blocks in the extra arm must leave the static grid')

  mechanics.motorPower.set(mainKey, 3)
  mechanics.motorDirection.set(mainKey, 1)
  mechanics.motorPower.set(secondaryKey, 3)
  mechanics.motorDirection.set(secondaryKey, 1)
  internals.powerDirty = false
  internals.powerCooldown = 30
  internals.mechDirty = false
  internals.physicsSynced = true
  internals.physicsDirty = false
  internals.physicsScanCooldown = 30

  const extra = machine.extraRotors[0]
  const targetKey = posKey(9, 6, 11)
  let sawTargetAwake = false
  let maxTargetDisplacement = 0
  for (let i = 0; i < 120; i++) {
    mechanics.update(1 / 60)
    const dynamicTarget = internals.fallingBodies.find((body) => body.blocks.some((block) => block.originKey === targetKey))
    if (dynamicTarget) {
      sawTargetAwake = true
      const p = dynamicTarget.body.translation()
      maxTargetDisplacement = Math.max(maxTargetDisplacement, Math.hypot(p.x - 9.5, p.y - 6.5, p.z - 11.5))
    }
  }

  assert.ok(machine.angle > 0.1, `primary motor should rotate its arm (angle=${machine.angle.toFixed(3)})`)
  assert.ok(extra.angle > 0.1, `secondary motor should rotate its arm independently (angle=${extra.angle.toFixed(3)})`)
  assert.ok(sawTargetAwake && maxTargetDisplacement > 0.04,
    `secondary arm should physically contact and move the supported target (awake=${sawTargetAwake}, displacement=${maxTargetDisplacement.toFixed(3)}m)`)

  const angleBefore = extra.angle
  mechanics.motorPower.set(mainKey, 0)
  for (let i = 0; i < 30; i++) mechanics.update(1 / 60)
  const continuedTurn = ((extra.angle - angleBefore) + Math.PI * 2) % (Math.PI * 2)
  assert.ok(continuedTurn > 0.08,
    `secondary motor must continue after primary power is removed (delta=${continuedTurn.toFixed(3)}rad)`)

  for (const active of mechanics.contraptions.values()) {
    internals.rigidPhysics.removeRigidBody(active.rotorBody)
    internals.rigidPhysics.removeRigidBody(active.chassisBody)
    for (const rotor of active.extraRotors) internals.rigidPhysics.removeRigidBody(rotor.rotorBody)
  }
  for (const body of internals.fallingBodies) internals.rigidPhysics.removeRigidBody(body as never)
  internals.rigidPhysics.dispose()
  scene.clear()
  console.log(`PASS: two independent rotors turned (primary=${machine.angle.toFixed(3)}, secondary=${extra.angle.toFixed(3)})`)
  console.log(`PASS: auxiliary arm woke and displaced target by ${maxTargetDisplacement.toFixed(3)}m`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
