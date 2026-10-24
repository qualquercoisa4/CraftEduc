import assert from 'node:assert/strict'
import * as THREE from 'three'
import { B, DEFAULT_HOTBAR } from '../lib/game/constants'
import { blockMass, RigidPhysics } from '../lib/game/rigid-physics'
import { Mechanics, motorTorqueFactorForSpeed } from '../lib/game/mechanics'
import { posKey } from '../lib/game/constants'
import type { World } from '../lib/game/world'

async function main() {
  assert.equal(DEFAULT_HOTBAR.length, 9, 'hotbar must contain exactly nine slots')
  assert.ok(blockMass(B.ALUMINUM) < blockMass(B.WOOD), 'aluminum must be lighter than wood')
  assert.ok(blockMass(B.WOOD) < blockMass(B.IRON), 'wood must be lighter than iron')
  assert.ok(blockMass(B.MOTOR) > blockMass(B.ALUMINUM), 'a motor must weigh more than aluminum')

  // The approximate DC-motor curve should keep full starting torque and reduce
  // available torque near the commanded no-load speed without removing control.
  assert.equal(motorTorqueFactorForSpeed(10, 0), 1, 'motor must have full torque at standstill')
  assert.ok(Math.abs(motorTorqueFactorForSpeed(10, 5) - 0.575) < 1e-9,
    'motor torque should fall progressively as rotor speed increases')
  assert.equal(motorTorqueFactorForSpeed(10, 10), 0.15,
    'motor must preserve a small torque floor near target speed')
  assert.equal(motorTorqueFactorForSpeed(10, -5), 1,
    'motor must retain starting torque when rotating against the requested direction')
  assert.ok(Math.abs(motorTorqueFactorForSpeed(-10, -5) - 0.575) < 1e-9,
    'reverse rotation should use the same torque-speed curve')
  assert.equal(motorTorqueFactorForSpeed(0, 1), 0,
    'zero target speed has no powered torque curve')

  // Use the production rigid-body factory and its actual per-material collider
  // densities; no mocked physics response is used in the collision experiment.
  const mockWorld = {
    chunks: new Map(),
    getBlock: () => B.AIR,
  } as unknown as World
  const physics = new RigidPhysics(mockWorld)
  await physics.waitUntilReady()
  assert.equal(physics.ready, true, 'Rapier must initialize for the test')

  // Component mass must remain stable when the collision shape is intentionally
  // smaller than a voxel, as with the motor housing used for a mounted wheel.
  const mountedMotorMass = blockMass(B.MOTOR, { mountedWheel: true })
  const mountedMotor = physics.createRigidBody(
    [{ x: 30, y: 12, z: 30, id: B.MOTOR, state: { mountedWheel: true } }],
    new THREE.Vector3(30.5, 12.5, 30.5),
    { canSleep: false, linearDamping: 0, angularDamping: 0 },
  )
  assert.ok(mountedMotor, 'mounted motor body must be created')
  assert.ok(Math.abs(mountedMotor.mass() - mountedMotorMass) < 1e-3,
    `mounted motor mass must not shrink with its collision shape (expected ${mountedMotorMass}, got ${mountedMotor.mass()})`)
  physics.removeRigidBody(mountedMotor)

  // Calibrate the free-fall baseline against gravity using the same fixed-step
  // production solver; the cube is high enough not to hit the floor.
  const fallingTestBody = physics.createRigidBody(
    [{ x: 40, y: 24, z: 40, id: B.IRON }],
    new THREE.Vector3(40.5, 24.5, 40.5),
    { canSleep: false, linearDamping: 0, angularDamping: 0 },
  )
  assert.ok(fallingTestBody, 'free-fall test body must be created')
  const initialFallY = fallingTestBody.translation().y
  for (let step = 0; step < 60; step++) physics.step(1 / 60)
  const fallDistance = initialFallY - fallingTestBody.translation().y
  assert.ok(fallDistance > 4.8 && fallDistance < 5.1,
    `free fall over one second should be close to 4.9 m (measured ${fallDistance.toFixed(3)} m)`)
  physics.removeRigidBody(fallingTestBody)

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
  const stateMap = new Map<string, { glue?: number; facing?: number; batteries?: number; mountedWheel?: boolean; switchOn?: boolean }>()
  const chunks = new Map([['0,0', { cx: 0, cz: 0, maxY: 8 }]])
  let mechanicsRef: Mechanics | null = null
  const mockGameWorld = {
    chunks,
    states: stateMap,
    poweredLeds: new Set<string>(),
    markBlockDirty() {},
    getBlock(x: number, y: number, z: number) { return blockMap.get(posKey(x, y, z)) ?? B.AIR },
    getState(x: number, y: number, z: number) { return stateMap.get(posKey(x, y, z)) },
    ensureState(x: number, y: number, z: number) {
      const key = posKey(x, y, z)
      let state = stateMap.get(key)
      if (!state) { state = {}; stateMap.set(key, state) }
      return state
    },
    setBlock(x: number, y: number, z: number, id: number, state?: { glue?: number; facing?: number; batteries?: number; switchOn?: boolean }) {
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

  // Regression: a powered, off-centre mounted wheel must propel the chassis and induce yaw.
  const tractionKey = posKey(20, 4, 20)
  blockMap.set(posKey(21, 3, 20), B.ROBOTICS)
  const tractionBody = mechanicsPhysics.createRigidBody(
    [{ x: 20, y: 4, z: 20, id: B.MOTOR }],
    new THREE.Vector3(20.5, 4.5, 20.5),
    { canSleep: false, linearDamping: 0, angularDamping: 0 },
  )
  assert.ok(tractionBody, 'traction chassis must be created')
  ;(mechanics as unknown as { mountedWheels: Map<string, unknown> }).mountedWheels.set(tractionKey, {
    model: { group: new THREE.Group(), rim: new THREE.Group() }, spin: 0,
  })
  const applyTraction = (mechanics as unknown as {
    applyMountedWheelTraction: (machine: unknown, power: number, direction: number) => void
  }).applyMountedWheelTraction.bind(mechanics)
  const tractionMachine = { motorKey: tractionKey, axis: new THREE.Vector3(1, 0, 0), chassisBody: tractionBody }
  const tractionStart = { ...tractionBody.translation() }
  for (let step = 0; step < 45; step++) {
    applyTraction(tractionMachine, 3, 1)
    mechanicsPhysics.step(1 / 60)
  }
  const tractionEnd = tractionBody.translation()
  const tractionRotation = tractionBody.rotation()
  assert.ok(tractionEnd.z > tractionStart.z + 0.05,
    `powered wheel must move chassis in the expected direction (dz=${(tractionEnd.z - tractionStart.z).toFixed(3)})`)
  assert.ok(Math.abs(tractionRotation.y) > 0.01,
    `off-centre traction must cause yaw (qy=${tractionRotation.y.toFixed(3)})`)
  mechanicsPhysics.removeRigidBody(tractionBody)
  ;(mechanics as unknown as { mountedWheels: Map<string, unknown> }).mountedWheels.delete(tractionKey)
  blockMap.delete(posKey(21, 3, 20))

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
  // The test manually frees these bodies rather than letting landBody remove
  // them; clear their registry too so a later frame never queries a freed WASM handle.
  ;(mechanics as unknown as { fallingBodies: unknown[]; fallingKeys: Set<string> }).fallingBodies.length = 0
  ;(mechanics as unknown as { fallingBodies: unknown[]; fallingKeys: Set<string> }).fallingKeys.clear()

  // Wheel-only motor regression: the mount must follow all six shaft facings,
  // and the motor must drive a grounded chassis with no glued output voxel.
  const wheelMotorKey = posKey(21, 5, 20)
  blockMap.set(posKey(20, 4, 20), B.ROBOTICS)
  blockMap.set(posKey(21, 4, 20), B.ROBOTICS)
  blockMap.set(posKey(22, 4, 20), B.ROBOTICS)
  mechanicsPhysics.syncStaticBlock(20, 4, 20)
  mechanicsPhysics.syncStaticBlock(21, 4, 20)
  mechanicsPhysics.syncStaticBlock(22, 4, 20)
  // Lightweight Three.js groups keep this test independent of browser textures.
  const chassisKey = posKey(20, 5, 20)
  blockMap.set(chassisKey, B.ALUMINUM)
  stateMap.set(chassisKey, { glue: 1 << 0 })
  blockMap.set(wheelMotorKey, B.MOTOR)
  stateMap.set(wheelMotorKey, { facing: 0, glue: 1 << 1, mountedWheel: true })
  const wheelMotorGroup = new THREE.Group()
  const wheelShaft = new THREE.Group()
  wheelMotorGroup.position.set(21.5, 5.5, 20.5)
  wheelMotorGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0))
  wheelMotorGroup.add(wheelShaft)
  scene.add(wheelMotorGroup)
  mechanics.models.set(wheelMotorKey, {
    type: 'motor', model: { group: wheelMotorGroup, shaft: wheelShaft }, spin: 0, status: 'idle',
  })
  const wheelGroup = new THREE.Group()
  const wheelRim = new THREE.Group()
  wheelGroup.add(wheelRim)
  wheelGroup.position.set(0, 0, 0.36)
  wheelShaft.add(wheelGroup)
  const mountedWheels = (mechanics as unknown as { mountedWheels: Map<string, { model: { group: THREE.Group; rim: THREE.Group }; spin: number }> }).mountedWheels
  mountedWheels.set(wheelMotorKey, { model: { group: wheelGroup, rim: wheelRim }, spin: 0 })
  const mountedWheel = mountedWheels.get(wheelMotorKey)
  assert.ok(mountedWheel, 'the wheel accessory must mount on the motor shaft')
  if (!mountedWheel) throw new Error('mounted wheel missing')
  for (let face = 0; face < 6; face++) {
    scene.updateMatrixWorld(true)
    const motorOrientation = wheelMotorGroup.getWorldQuaternion(new THREE.Quaternion())
    const wheelOrientation = mountedWheel.model.group.getWorldQuaternion(new THREE.Quaternion())
    assert.ok(wheelOrientation.angleTo(motorOrientation) < 1e-5, `mounted wheel axle must follow motor facing ${face}`)
    mechanics.rotateMotor(21, 5, 20)
  }
  mechanics.motorPower.set(wheelMotorKey, 3)
  mechanics.motorDirection.set(wheelMotorKey, 1)
  const wheelInternals = mechanics as unknown as {
    tryAssemble: (key: string) => string
    powerDirty: boolean; powerCooldown: number; mechDirty: boolean
    physicsSynced: boolean; physicsDirty: boolean; physicsScanCooldown: number
  }
  assert.equal(wheelInternals.tryAssemble(wheelMotorKey), 'driving', 'mounted wheel should assemble a rotor without a glued output voxel')
  const wheelMachine = mechanics.contraptions.get(wheelMotorKey)
  assert.ok(wheelMachine, 'wheel-only machine must register its chassis physics body')
  if (!wheelMachine) throw new Error('wheel-only machine failed to assemble')
  assert.equal(wheelMachine.blocks.length, 0, 'wheel-only rotor must not create fake voxel blocks')
  wheelInternals.powerDirty = false
  wheelInternals.powerCooldown = 30
  wheelInternals.mechDirty = false
  wheelInternals.physicsSynced = true
  wheelInternals.physicsDirty = false
  wheelInternals.physicsScanCooldown = 30
  const wheelStart = wheelMachine.chassisBody.translation()
  for (let step = 0; step < 60; step++) mechanics.update(1 / 60)
  const wheelEnd = wheelMachine.chassisBody.translation()
  assert.ok(Math.hypot(wheelEnd.x - wheelStart.x, wheelEnd.z - wheelStart.z) > 0.05, `mounted wheel should propel chassis (dx=${(wheelEnd.x - wheelStart.x).toFixed(3)}m, dz=${(wheelEnd.z - wheelStart.z).toFixed(3)}m)`)
  const chassisRotation = wheelMachine.chassisBody.rotation()
  assert.ok(Math.abs(chassisRotation.x) < 0.02 && Math.abs(chassisRotation.z) < 0.02, 'wheeled chassis must not pitch or roll')
  console.log(`PASS: mounted wheel followed all six motor facings and propelled chassis by ${Math.hypot(wheelEnd.x - wheelStart.x, wheelEnd.z - wheelStart.z).toFixed(3)}m`)
  mechanicsPhysics.removeRigidBody(wheelMachine.rotorBody)
  mechanicsPhysics.removeRigidBody(wheelMachine.chassisBody)
  mechanics.contraptions.delete(wheelMotorKey)
  mechanics.models.delete(wheelMotorKey)
  mountedWheels.delete(wheelMotorKey)
  mechanics.motorPower.delete(wheelMotorKey)
  mechanics.motorDirection.delete(wheelMotorKey)
  blockMap.delete(posKey(20, 5, 20)); blockMap.delete(wheelMotorKey)
  stateMap.delete(posKey(20, 5, 20)); stateMap.delete(wheelMotorKey)
  blockMap.delete(posKey(20, 4, 20)); blockMap.delete(posKey(21, 4, 20)); blockMap.delete(posKey(22, 4, 20))
  mechanicsPhysics.syncStaticBlock(20, 4, 20); mechanicsPhysics.syncStaticBlock(21, 4, 20); mechanicsPhysics.syncStaticBlock(22, 4, 20)

  // Recreate the reported failure with an actual motor + chassis + rotor:
  // battery compartment and aluminum chassis are glued to the motor's fixed
  // side, while three wood blocks form a rotating arm on its output face.
  const baseKey = posKey(2, 5, 2)
  const batteryKey = posKey(2, 6, 2)
  const noseKey = posKey(3, 5, 2)
  const motorKey = posKey(4, 5, 2)
  const targetKey = posKey(5, 6, 3)
  const switchKey = posKey(4, 6, 2)
  const putTestBlock = (x: number, y: number, z: number, id: number, state: { glue?: number; facing?: number; batteries?: number; mountedWheel?: boolean; switchOn?: boolean }) => {
    const key = posKey(x, y, z)
    blockMap.set(key, id)
    stateMap.set(key, { ...state })
  }
  putTestBlock(2, 5, 2, B.ALUMINUM, { glue: (1 << 0) | (1 << 2) })
  putTestBlock(2, 6, 2, B.BATTERY_BOX, { glue: 1 << 3, batteries: 3 })
  putTestBlock(3, 5, 2, B.ALUMINUM, { glue: (1 << 0) | (1 << 1) })
  putTestBlock(4, 5, 2, B.MOTOR, { facing: 0, glue: (1 << 0) | (1 << 1) | (1 << 2) })
  putTestBlock(4, 6, 2, B.SWITCH, { switchOn: true, glue: 1 << 3 })
  // A second independent load verifies both poles of the switch, not just pole 1.
  const secondMotorKey = posKey(7, 5, 2)
  putTestBlock(7, 5, 2, B.MOTOR, { facing: 2 })
  putTestBlock(5, 5, 2, B.WOOD, { glue: (1 << 1) | (1 << 2) })
  putTestBlock(5, 6, 2, B.WOOD, { glue: (1 << 3) | (1 << 2) })
  putTestBlock(5, 7, 2, B.WOOD, { glue: 1 << 3 })
  // A supported aluminum voxel is placed in the wood arm's circular sweep.
  // It should be pushed sideways by the actual motor/rotor simulation.
  putTestBlock(5, 5, 3, B.IRON, {})
  putTestBlock(5, 6, 3, B.ALUMINUM, {})
  for (const [x, y, z] of [[5, 5, 3], [5, 6, 3]] as const) {
    mechanicsPhysics.syncStaticBlock(x, y, z)
  }

  // The model visuals are irrelevant to this server-side regression; use a
  // minimal motor model so the production assembly code still builds its real
  // Rapier bodies without needing browser canvas textures.
  const motorGroup = new THREE.Group()
  motorGroup.position.set(4.5, 5.5, 2.5)
  const motorShaft = new THREE.Group()
  motorGroup.add(motorShaft)
  mechanics.models.set(motorKey, {
    type: 'motor',
    model: { group: motorGroup, shaft: motorShaft },
    spin: 0,
    status: 'idle',
  } as never)

  const makeTestWire = (id: number, a: string, ta: string, b: string, tb: string) => {
    const pa = new THREE.Vector3(2.5, 6.5, 2.5)
    const pb = new THREE.Vector3(4.5, 5.5, 2.5)
    const mesh = new THREE.Group()
    mesh.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()))
    mesh.add(new THREE.Object3D())
    mesh.add(new THREE.Object3D())
    return { id, a, ta, b, tb, pa, pb, mesh }
  }
  mechanics.wires = [
    makeTestWire(101, batteryKey, '+', baseKey, 'face:0'),
    makeTestWire(102, baseKey, 'face:1', switchKey, 'in1'),
    makeTestWire(103, batteryKey, '-', motorKey, 'B'),
    makeTestWire(104, switchKey, 'out1', motorKey, 'A'),
    makeTestWire(105, batteryKey, '+', switchKey, 'in2'),
    makeTestWire(106, switchKey, 'out2', secondMotorKey, 'A'),
    makeTestWire(107, secondMotorKey, 'B', batteryKey, '-'),
  ] as never

  // Simulate the real powered assembly transition. tryAssemble removes all
  // moving blocks from World, just as it does during gameplay.
  mechanics.motorPower.set(motorKey, 3)
  mechanics.motorDirection.set(motorKey, 1)
  const assemble = (mechanics as unknown as { tryAssemble: (key: string) => string }).tryAssemble(motorKey)
  assert.equal(assemble, 'driving', 'the glued rotor and chassis must assemble')
  const machine = mechanics.contraptions.get(motorKey)
  assert.ok(machine, 'the motor mechanism must stay registered after assembly')
  assert.equal(mockGameWorld.getBlock(2, 6, 2), B.AIR,
    'the battery compartment should be represented by the moving chassis while assembled')
  assert.ok(machine.chassisBlocks.some((block) => block.id === B.BATTERY_BOX && block.state?.batteries === 3),
    'the assembled chassis must preserve battery count and battery-box identity')

  // This is the regression for the actual bug: rebuilding the circuit graph
  // after assembly used to see the motor but not the battery/conductive chassis,
  // dropping motor power to zero and triggering repeated disassembly/reassembly.
  const recomputePower = (mechanics as unknown as { recomputePower: () => void }).recomputePower.bind(mechanics)
  for (let pass = 0; pass < 12; pass++) {
    recomputePower()
    const delivered = mechanics.motorPower.get(motorKey) ?? 0
    assert.ok(delivered > 2.7 && delivered <= 3,
      `motor power must persist after assembly (pass ${pass + 1}, delivered ${delivered.toFixed(3)})`)
  }
  assert.equal(mechanics.contraptions.has(motorKey), true,
    'a powered assembly must not leave the active-contraption state during circuit refresh')

  // Verify the switch can interrupt and restore current while inside a moving chassis.
  assert.equal(mechanics.toggleSwitchAtKey(switchKey), false, 'switch should turn off')
  recomputePower()
  assert.equal(mechanics.motorPower.get(motorKey) ?? 0, 0, 'an open switch must interrupt pole 1')
  assert.equal(mechanics.motorPower.get(secondMotorKey) ?? 0, 0, 'an open switch must interrupt pole 2')
  assert.equal(mechanics.toggleSwitchAtKey(switchKey), true, 'switch should turn on again')
  recomputePower()
  assert.ok((mechanics.motorPower.get(motorKey) ?? 0) > 2.7, 'a closed switch must restore pole 1 power')
  assert.ok((mechanics.motorPower.get(secondMotorKey) ?? 0) > 2.7, 'a closed switch must restore pole 2 power')

  // Exercise the production frame update for two seconds: the motor must keep
  // applying torque, the chassis/rotor must stay assembled, and no re-grid
  // snap may repeatedly teleport the mechanism upward.
  ;(mechanics as unknown as { fallingBodies: unknown[] }).fallingBodies.length = 0
  ;(mechanics as unknown as { fallingKeys: Set<string> }).fallingKeys.clear()
  const initialChassisY = machine.chassisBody.translation().y
  let maxTargetHorizontalTravel = 0
  const targetOrigin = new THREE.Vector3(5.5, 6.5, 3.5)
  const sampleTarget = () => {
    const active = (mechanics as unknown as { fallingBodies: { body: import('@dimforge/rapier3d-compat').RigidBody; blocks: { id: number; originKey: string }[] }[] }).fallingBodies
      .find((body) => body.blocks.some((block) => block.originKey === targetKey))
    if (active) {
      const t = active.body.translation()
      return new THREE.Vector3(t.x, t.y, t.z)
    }
    for (const [key, id] of blockMap) {
      if (id !== B.ALUMINUM || key === baseKey || key === noseKey) continue
      const [x, y, z] = key.split(',').map(Number)
      const point = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5)
      if (point.distanceTo(targetOrigin) < 4) return point
    }
    return targetOrigin.clone()
  }
  for (let step = 0; step < 120; step++) {
    mechanics.update(1 / 60)
    const currentTarget = sampleTarget()
    maxTargetHorizontalTravel = Math.max(
      maxTargetHorizontalTravel,
      Math.hypot(currentTarget.x - targetOrigin.x, currentTarget.z - targetOrigin.z),
    )
  }
  assert.equal(mechanics.contraptions.has(motorKey), true,
    'the powered motor must remain assembled across 120 physics frames')
  assert.ok((mechanics.motorPower.get(motorKey) ?? 0) > 2.7,
    'the motor must remain powered during physical simulation')
  const finalChassisY = machine.chassisBody.translation().y
  assert.ok(Number.isFinite(finalChassisY), 'chassis height must remain finite')
  assert.ok(finalChassisY < initialChassisY + 0.5 && finalChassisY > initialChassisY - 1.2,
    `chassis must not drift upward indefinitely or fall through the floor (start=${initialChassisY.toFixed(3)}, end=${finalChassisY.toFixed(3)})`)
  assert.equal(mockGameWorld.getBlock(2, 4, 2), B.IRON,
    'a dynamic assembly must not wake and remove the ground support beneath its chassis')
  assert.ok(machine.angle > 0.15,
    `the powered motor must physically rotate its rotor (angle=${machine.angle.toFixed(3)} rad)`)
  assert.ok(maxTargetHorizontalTravel > 0.1,
    `the rotating three-block wood arm must push the aluminum target sideways (max horizontal travel=${maxTargetHorizontalTravel.toFixed(3)} m)`)
  console.log(`PASS: after 120 frames, rotor angle=${machine.angle.toFixed(3)} rad; chassis ΔY=${(finalChassisY - initialChassisY).toFixed(3)} m`)
  console.log(`PASS: powered rotating arm pushed aluminum target ${maxTargetHorizontalTravel.toFixed(3)} m sideways`)

  // Turning off a live rotor must never leave update() using Rapier handles
  // that disassemble() has already removed; that exception used to halt frames.
  assert.equal(mechanics.toggleSwitchAtKey(switchKey), false, 'switch must turn off while rotor is moving')
  let shutdownFrames = 0
  for (; shutdownFrames < 240 && mechanics.contraptions.has(motorKey); shutdownFrames++) {
    assert.doesNotThrow(() => mechanics.update(1 / 60), `switch-off frame ${shutdownFrames + 1} must not touch removed bodies`)
  }
  assert.equal(mechanics.contraptions.has(motorKey), false, 'stopped unpowered rotor should safely disassemble')
  console.log(`PASS: switch-off safely disassembled mechanism after ${shutdownFrames} frames`)

  for (const wire of mechanics.wires) {
    wire.mesh.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
    })
  }
  for (const c of mechanics.contraptions.values()) {
    mechanicsPhysics.removeRigidBody(c.rotorBody)
    mechanicsPhysics.removeRigidBody(c.chassisBody)
  }
  mechanics.contraptions.clear()
  scene.clear()
  mechanicsPhysics.dispose()

  console.log('PASS: hotbar has exactly 9 slots')
  console.log(`PASS: mass order aluminum=${blockMass(B.ALUMINUM)}, wood=${blockMass(B.WOOD)}, iron=${blockMass(B.IRON)}`)
  console.log(`PASS: wooden arm collision lifted aluminum ${aluminumLift.toFixed(3)} m vs wood ${woodLift.toFixed(3)} m in 0.2 s`)
  console.log('PASS: moving wood arm wakes and pushes a previously static aluminum voxel')
  console.log('PASS: 3-cell wood arm remains powered after battery/aluminum chassis leaves the static grid')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
