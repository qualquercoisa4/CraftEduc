import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { blockFriction, blockMass, RigidPhysics } from './rigid-physics'
import { getMotorSpec } from './motor-specs'
import { resistorActualResistanceOhms, resistorToleranceOffsetPercent, resistorValueOhms, solveDcCircuit, type ElectricalDiode, type ElectricalResistor, type ElectricalVoltageSource } from './electrical'
import { B, BLOCK_CONDUCTIVITY, CHUNK_SIZE, DIRS, GROUND_LEVEL, WORLD_HEIGHT, OPPOSITE, blockBounds, isOpaque, parseKey, posKey } from './constants'
import { buffersToGeometry, buildGlueGeometry, emitCube, newBuffers } from './mesher'
import {
  type BatteryBoxModel,
  type MotorModel,
  type LedTerminalModel,
  type WheelModel,
  type SwitchModel,
  type ProximitySensorModel,
  type ServoModel,
  type ArduinoUnoModel,
  type ResistorModel,
  createArduinoUnoModel,
  createResistorModel,
  createProximitySensorModel,
  createServoModel,
  setServoFacing,
  setProximitySensorActive,
  setProximitySensorFacing,
  createBatteryBoxModel,
  createSwitchModel,
  createGlowSprite,
  createLedTerminalModel,
  createArduinoWheelModel,
  createMotorModel,
  createWireMesh,
  disposeObject,
  setBatteryCount,
  setMotorFacing,
  setSwitchState,
  motorOrientationQuaternion,
  facingQuaternion,
  updateWireMesh,
} from './models'
import type { BlockState, World } from './world'
import type { Player } from './player'

const HALF_PI = Math.PI / 2
// Approximate electromechanical limits in SI units.
const MOTOR_VELOCITY_DAMPING = 2.0
const MOTOR_COAST_TORQUE_NM = 0.001
// The voxel world uses metre-sized blocks while toy gearmotors are designed
// for centimetre-scale robot chassis. Apply a game-world scale to catalogued
// motors, while keeping legacy blocks at the torque behavior they had before
// catalogued motor variants existed so already-built robots remain usable.
const MOTOR_SIMULATION_TORQUE_SCALE = 120
const LEGACY_MOTOR_TORQUE_PER_POWER_UNIT_NM = 4.0
const MOTOR_COAST_DAMPING = 0.25
// TowerPro SG90: approximately 1.8 kg·cm at 4.8 V = 0.176 N·m stall torque.
const SERVO_MAX_TORQUE_NM = 0.176

function motorDriveCommand(
  variant: string | undefined,
  power: number,
  relativeOmega: number,
): { targetOmega: number; maxTorqueNm: number } {
  if (power <= 0) return { targetOmega: 0, maxTorqueNm: 0 }

  // Pre-catalogue motor blocks saved in existing worlds have no motorType.
  // Preserve their former drive strength instead of silently downgrading them
  // to the tiny un-geared FA-130 when users continue an existing robot.
  if (!variant) {
    return {
      targetOmega: power * 1.05,
      maxTorqueNm: LEGACY_MOTOR_TORQUE_PER_POWER_UNIT_NM * power,
    }
  }

  const spec = getMotorSpec(variant)
  const voltageRatio = Math.max(0, Math.min(1, power * 1.5 / spec.nominalVoltageV))
  const targetOmega = spec.noLoadRpm * (Math.PI * 2 / 60) * voltageRatio
  const torqueRatio = targetOmega > 1e-5
    ? Math.max(0, Math.min(1, 1 - relativeOmega / targetOmega))
    : 0
  return {
    targetOmega,
    maxTorqueNm: spec.stallTorqueNm * voltageRatio * torqueRatio * MOTOR_SIMULATION_TORQUE_SCALE,
  }
}
// Avoid the exact PI boundary in revolute-joint limits.
const SERVO_MAX_ANGLE_RAD = Math.PI - 0.02
const SERVO_TARGET_SPEED_RAD = Math.PI * 0.75
const SERVO_MAX_TRACK_ERROR_RAD = Math.PI / 12
const MAX_CONTRAPTION = 400
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

/**
 * Estimate static tyre load shares from the assembly centre of mass. Negative
 * reactions indicate a lifted wheel; remove that support and solve again.
 */
function estimateWheelNormalLoadShares(points: readonly THREE.Vector3[], centerOfMass: THREE.Vector3) {
  if (points.length === 0) return []
  let active = points.map((_, index) => index)
  for (let attempt = 0; attempt < points.length; attempt++) {
    if (active.length === 0) break
    const count = active.length
    const meanX = active.reduce((sum, index) => sum + points[index].x, 0) / count
    const meanZ = active.reduce((sum, index) => sum + points[index].z, 0) / count
    let sxx = 0, sxz = 0, szz = 0
    for (const index of active) {
      const dx = points[index].x - meanX
      const dz = points[index].z - meanZ
      sxx += dx * dx
      sxz += dx * dz
      szz += dz * dz
    }
    const bx = centerOfMass.x - meanX
    const bz = centerOfMass.z - meanZ
    const determinant = sxx * szz - sxz * sxz
    let lambdaX = 0, lambdaZ = 0
    if (determinant > 1e-8) {
      lambdaX = (bx * szz - bz * sxz) / determinant
      lambdaZ = (bz * sxx - bx * sxz) / determinant
    }
    const shares = points.map(() => 0)
    let mostNegative = -1
    let minShare = 0
    for (const index of active) {
      const share = 1 / count + (points[index].x - meanX) * lambdaX + (points[index].z - meanZ) * lambdaZ
      shares[index] = share
      if (share < minShare) { minShare = share; mostNegative = index }
    }
    if (mostNegative < 0) {
      const total = shares.reduce((sum, share) => sum + share, 0)
      return total > 1e-8 ? shares.map((share) => share / total) : points.map(() => 1 / points.length)
    }
    active = active.filter((index) => index !== mostNegative)
  }
  const shares = points.map(() => 0)
  for (const index of active) shares[index] = 1 / Math.max(1, active.length)
  return shares.some((share) => share > 0) ? shares : points.map(() => 1 / points.length)
}

type ModelEntry =
  | { type: 'motor'; model: MotorModel; spin: number; status: 'idle' | 'stalled' | 'driving' }
  | { type: 'box'; model: BatteryBoxModel }
  | { type: 'led'; model: LedTerminalModel }
  | { type: 'wheel'; model: WheelModel; spin: number }
  | { type: 'switch'; model: SwitchModel }
  | { type: 'sensor'; model: ProximitySensorModel }
  | { type: 'servo'; model: ServoModel; status: 'idle' | 'stalled' | 'driving' }
  | { type: 'arduino_uno'; model: ArduinoUnoModel }
  | { type: 'resistor'; model: ResistorModel }

export interface Wire {
  id: number
  a: string
  b: string
  pa: THREE.Vector3
  pb: THREE.Vector3
  ta: string
  tb: string
  mesh: THREE.Group
  color: string
  networkId?: string
}

interface CBlock {
  rel: [number, number, number]
  id: number
  state?: BlockState
  origKey: string
}

interface FallingBlock {
  id: number
  state?: BlockState
  x: number
  y: number
  z: number
  originKey: string
  localOrigin: THREE.Vector3
  mesh: THREE.Mesh
}

export interface MovingBlockHit {
  x: number
  y: number
  z: number
  face: number
  point: THREE.Vector3
  id: number
  dist: number
  moving: { key: string; kind: 'rotor' | 'chassis' | 'falling' }
}

interface FallingBody {
  blocks: FallingBlock[]
  body: RAPIER.RigidBody
  group: THREE.Group
  pivot: THREE.Vector3
  wireEnds: { wire: Wire; end: 'a' | 'b'; local: THREE.Vector3; orig: THREE.Vector3 }[]
  settledTime: number
}

interface ExtraRotor {
  motorKey: string
  motorPos: [number, number, number]
  motorOffset: [number, number, number]
  motorState?: BlockState
  axis: THREE.Vector3
  facing: number
  blocks: CBlock[]
  byKey: Map<string, CBlock>
  wheelOnly: boolean
  group: THREE.Group
  rotorBody: RAPIER.RigidBody
  joint: RAPIER.RevoluteImpulseJoint
  unpoweredTime: number
  angle: number
  speed: number
  wireEnds: { wire: Wire; end: 'a' | 'b'; local: THREE.Vector3; orig: THREE.Vector3 }[]
}

interface Contraption {
  motorKey: string
  actuatorId: number
  motorPos: [number, number, number]
  motorState?: BlockState
  axis: THREE.Vector3
  facing: number
  blocks: CBlock[]
  chassisBlocks: CBlock[]
  chassisByKey: Map<string, CBlock>
  byKey: Map<string, CBlock>
  chassisGroup: THREE.Group
  chassisBody: RAPIER.RigidBody
  rotorBody: RAPIER.RigidBody
  joint: RAPIER.RevoluteImpulseJoint
  chassisWireEnds: { wire: Wire; end: 'a' | 'b'; local: THREE.Vector3; orig: THREE.Vector3 }[]
  unpoweredTime: number
  disassemblyRetryCooldown: number
  group: THREE.Group
  angle: number
  servoCommandAngle?: number
  speed: number
  wireEnds: { wire: Wire; end: 'a' | 'b'; local: THREE.Vector3; orig: THREE.Vector3 }[]
  extraRotors: ExtraRotor[]
}

export class Mechanics {
  models = new Map<string, ModelEntry>()
  wires: Wire[] = []
  contraptions = new Map<string, Contraption>()
  glows = new Map<string, THREE.Sprite>()
  motorPower = new Map<string, number>()
  /** Last solved DC node voltages (volts) and named branch currents (amperes). */
  electricalNodeVoltages = new Map<string, number>()
  electricalBranchCurrents = new Map<string, number>()
  private activeShortSources = new Set<string>()
  private shortCircuitEventQueue: string[] = []
  motorDirection = new Map<string, number>()
  servoPowered = new Set<string>()
  // Program output state is kept separate from battery-box power calculations.
  private arduinoPinLevels = new Map<string, boolean>()
  private programmedServoAngles = new Map<string, { boardKey: string; degrees: number }>()
  private poweredArduinoBoards = new Set<string>()
  private glueMesh: THREE.Mesh | null = null
  private resinVisuals = new Map<string, THREE.Mesh>()
  private waterDamageCooldown = 0
  private suppress = false
  private powerDirty = true
  private mechDirty = true
  private wireId = 0
  private gravityTimer = 0
  private physicsDirty = true
  private physicsDirtyKeys = new Set<string>()
  private mountedWheels = new Map<string, { model: WheelModel; spin: number }>()
  private fallingBodies: FallingBody[] = []
  private fallingKeys = new Set<string>()
  private readonly gravity = 18
  private physicsScanCooldown = 0
  private powerCooldown = 0
  private circuitRefreshTimer = 0
  private proximityScanCooldown = 0
  private rigidPhysics: RigidPhysics
  private physicsSynced = false
  private networkAuthority = true
  private desiredNetworkMachines: Set<string> | null = null
  // The authoritative hinge angle is replicated separately from the body's
  // quaternion: deriving it from a client-side Rapier body can lose turns or
  // use a slightly different joint reference frame.
  private networkMachineAngles = new Map<string, number>()
  private networkBlockPublisher: ((x: number, y: number, z: number, block: number, state?: BlockState, ownerKey?: string | null) => void) | null = null
  private networkBlockOwner: ((x: number, y: number, z: number) => string | null) | null = null
  private networkFallingVisuals = new Map<string, {
    group: THREE.Group; keys: string[]; signature: string
    targetPosition: THREE.Vector3; targetRotation: THREE.Quaternion
    linearVelocity: THREE.Vector3; angularVelocity: THREE.Vector3; receivedAt: number
  }>()
  private networkBodyTargets = new Map<string, {
    body: RAPIER.RigidBody
    position: THREE.Vector3
    rotation: THREE.Quaternion
    linearVelocity: THREE.Vector3
    angularVelocity: THREE.Vector3
    receivedAt: number
  }>()

  constructor(
    private world: World,
    private scene: THREE.Scene,
    private blockMaterial: THREE.Material,
    private glueMaterial: THREE.Material,
  ) {
    this.rigidPhysics = new RigidPhysics(world)
  }

  /* ---------------- Block change hook ---------------- */

  onBlockChange(x: number, y: number, z: number, oldId: number, newId: number, oldHadGlue = false, newHasGlue = false) {
    // Keep Rapier's static collision world in lockstep with the voxel world,
    // including edits made internally while assembling or landing rigid bodies.
    this.rigidPhysics.syncStaticBlock(x, y, z)
    const key = posKey(x, y, z)
    if (!this.suppress) this.physicsDirtyKeys.add(key)
    this.removeResinVisual(key)
    if (this.suppress) return
    if (oldId === B.ARDUINO_UNO) this.clearArduinoProgram(key)
    if (oldId === B.SERVO) this.programmedServoAngles.delete(key)
    if (oldId === B.MOTOR || oldId === B.SERVO || oldId === B.BATTERY_BOX || oldId === B.LED || oldId === B.WHEEL || oldId === B.SWITCH || oldId === B.PROXIMITY_SENSOR || oldId === B.ARDUINO_UNO || oldId === B.RESISTOR) {
      const e = this.models.get(key)
      if (e) {
        disposeObject(e.model.group)
        this.models.delete(key)
      }
      if (oldId === B.MOTOR) this.mountedWheels.delete(key)
    }
    if (oldId !== B.AIR) {
      this.removeWiresAt(key)
      const glow = this.glows.get(key)
      if (glow) {
        glow.parent?.remove(glow)
        this.glows.delete(key)
      }
    }
    if (newId === B.MOTOR) {
      const st = this.world.ensureState(x, y, z)
      st.facing ??= 2
      st.motorRoll ??= 0
      const model = createMotorModel(st.facing, st.motorType, st.motorRoll)
      model.group.position.set(x + 0.5, y + 0.5, z + 0.5)
      this.scene.add(model.group)
      this.models.set(key, { type: 'motor', model, spin: 0, status: 'idle' })
      if (st.mountedWheel) this.mountWheel(x, y, z)
    } else if (newId === B.BATTERY_BOX) {
      const st = this.world.ensureState(x, y, z)
      st.batteries ??= 0
      const model = createBatteryBoxModel(st.batteries)
      model.group.position.set(x + 0.5, y, z + 0.5)
      this.scene.add(model.group)
      this.models.set(key, { type: 'box', model })
    } else if (newId === B.LED) {
      const model = createLedTerminalModel()
      model.group.position.set(x, y, z)
      this.scene.add(model.group)
      this.models.set(key, { type: 'led', model })
    } else if (newId === B.WHEEL) {
      const state = this.world.ensureState(x, y, z)
      const model = createArduinoWheelModel(state.facing ?? 0)
      model.group.position.set(x + 0.5, y + 0.5, z + 0.5)
      this.scene.add(model.group)
      this.models.set(key, { type: 'wheel', model, spin: 0 })
    } else if (newId === B.SWITCH) {
      const state = this.world.ensureState(x, y, z)
      state.switchOn ??= false
      const model = createSwitchModel(state.switchOn)
      model.group.position.set(x, y, z)
      this.scene.add(model.group)
      this.models.set(key, { type: 'switch', model })
    } else if (newId === B.PROXIMITY_SENSOR) {
      const state = this.world.ensureState(x, y, z)
      state.facing ??= 5
      state.proximityOperator ??= 'less'
      state.proximityDistance ??= 3
      state.proximityActive ??= false
      const model = createProximitySensorModel(state.facing, state.proximityActive)
      model.group.position.set(x + 0.5, y + 0.5, z + 0.5)
      this.scene.add(model.group)
      this.models.set(key, { type: 'sensor', model })
    } else if (newId === B.SERVO) {
      const state = this.world.ensureState(x, y, z)
      state.facing ??= 2
      state.servoOffAngle ??= 0
      state.servoOnAngle ??= 90
      const model = createServoModel(state.facing)
      model.group.position.set(x + 0.5, y + 0.5, z + 0.5)
      model.shaft.rotation.z = state.servoOffAngle * Math.PI / 180
      this.scene.add(model.group)
      this.models.set(key, { type: 'servo', model, status: 'idle' })
    } else if (newId === B.ARDUINO_UNO) {
      const model = createArduinoUnoModel()
      model.group.position.set(x + 1, y + 0.14, z + 1)
      this.scene.add(model.group)
      this.models.set(key, { type: 'arduino_uno', model })
    } else if (newId === B.RESISTOR) {
      const state = this.world.ensureState(x, y, z)
      state.resistorDigit1 ??= 1
      state.resistorDigit2 ??= 0
      state.resistorMultiplier ??= 1
      state.resistorTolerance ??= 5
      state.resistorActualOffsetPct ??= resistorToleranceOffsetPercent(key, state.resistorTolerance)
      const model = createResistorModel(state.resistorDigit1, state.resistorDigit2, state.resistorMultiplier, state.resistorTolerance)
      model.group.position.set(x, y, z)
      this.scene.add(model.group)
      this.models.set(key, { type: 'resistor', model })
    }
    // Glue geometry is expensive: rebuild only when a glued block actually changes.
    if (oldHadGlue || newHasGlue) this.rebuildGlue()
    const electrical = (id: number) => id === B.MOTOR || id === B.SERVO || id === B.BATTERY_BOX || id === B.LED || id === B.RESISTOR || id === B.SWITCH || id === B.IRON || id === B.ALUMINUM || id === B.GEAR || id === B.ROBOTICS || id === B.COMPONENT
    if (electrical(oldId) || electrical(newId)) this.powerDirty = true
    if (oldHadGlue || newHasGlue || oldId === B.MOTOR || newId === B.MOTOR || oldId === B.SERVO || newId === B.SERVO || oldId === B.WHEEL || newId === B.WHEEL) this.mechDirty = true
    if (newId !== B.AIR && this.world.getState(x, y, z)?.resinCoated) this.syncResinVisual(x, y, z)
    this.physicsDirty = true
  }

  private removeResinVisual(key: string) {
    const mesh = this.resinVisuals.get(key)
    if (!mesh) return
    this.scene.remove(mesh)
    mesh.geometry.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
    else material.dispose()
    this.resinVisuals.delete(key)
  }

  private syncResinVisual(x: number, y: number, z: number) {
    const key = posKey(x, y, z)
    this.removeResinVisual(key)
    const id = this.world.getBlock(x, y, z)
    if (id === B.AIR || !this.world.getState(x, y, z)?.resinCoated) return
    const [minX, minY, minZ, maxX, maxY, maxZ] = blockBounds(id)
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(maxX - minX + 0.025, maxY - minY + 0.025, maxZ - minZ + 0.025),
      new THREE.MeshBasicMaterial({
        color: '#e5c46a',
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    mesh.position.set(x + (minX + maxX) / 2, y + (minY + maxY) / 2, z + (minZ + maxZ) / 2)
    mesh.renderOrder = 2
    this.scene.add(mesh)
    this.resinVisuals.set(key, mesh)
  }

  /** Apply or remove a one-click resin coating on a complete block. */
  applyResinCoating(x: number, y: number, z: number) {
    const id = this.world.getBlock(x, y, z)
    if (id === B.AIR) return false
    const state = this.world.ensureState(x, y, z)
    const coated = !state.resinCoated
    if (coated) state.resinCoated = true
    else delete state.resinCoated
    this.world.markBlockDirty(x, y, z)
    this.syncResinVisual(x, y, z)
    return coated
  }

  private isWaterSensitiveComponent(id: number) {
    return id === B.COMPONENT || id === B.LED || id === B.MOTOR ||
      id === B.BATTERY_BOX || id === B.SWITCH || id === B.PROXIMITY_SENSOR ||
      id === B.SERVO || id === B.ARDUINO_UNO
  }

  /** Uncoated electronic components short out when submerged in the beach sea. */
  private burnSubmergedComponents() {
    if (this.world.type !== 'beach') return
    const firstY = Math.max(0, Math.floor(this.world.waterBottomY))
    const lastY = Math.min(WORLD_HEIGHT - 1, Math.ceil(this.world.waterSurfaceY))
    for (const chunk of this.world.chunks.values()) {
      const baseX = chunk.cx * CHUNK_SIZE
      const baseZ = chunk.cz * CHUNK_SIZE
      for (let y = firstY; y <= lastY; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
          for (let x = 0; x < CHUNK_SIZE; x++) {
            const wx = baseX + x
            const wz = baseZ + z
            if (!this.world.isWaterColumnAt(wx + 0.5, wz + 0.5)) continue
            const id = this.world.getBlock(wx, y, wz)
            if (!this.isWaterSensitiveComponent(id)) continue
            if (this.world.getState(wx, y, wz)?.resinCoated) continue
            if (this.world.waterSubmersionAt(wx + 0.5, y + 0.5, wz + 0.5) <= 0.01) continue
            // Removing the voxel also disposes its model and connected wires.
            this.world.setBlock(wx, y, wz, B.AIR)
          }
        }
      }
    }
  }

  applyNetworkBlockState(x: number, y: number, z: number, previous?: BlockState, next?: BlockState) {
    const key = posKey(x, y, z)
    const id = this.world.getBlock(x, y, z)
    if (previous?.glue || next?.glue) this.rebuildGlue()
    this.removeResinVisual(key)
    if (next?.resinCoated) this.syncResinVisual(x, y, z)
    let model = this.models.get(key)
    if (id === B.MOTOR && model?.type === 'motor') {
      const nextVariant = next?.motorType
      if (nextVariant && nextVariant !== previous?.motorType) {
        const replacement = createMotorModel(next?.facing ?? previous?.facing ?? 2, nextVariant, next?.motorRoll ?? 0)
        replacement.group.position.copy(model.model.group.position)
        this.scene.add(replacement.group)
        disposeObject(model.model.group)
        model = { ...model, model: replacement }
        this.models.set(key, model)
      } else {
        setMotorFacing(model.model, next?.facing ?? previous?.facing ?? 2, next?.motorRoll ?? 0)
      }
      this.refreshMotorTerminalWires(key)
      if (!this.contraptions.has(key) && !this.findExtraRotor(key)) this.rigidPhysics.syncStaticBlock(x, y, z)
    }
    if (id === B.BATTERY_BOX && model?.type === 'box') setBatteryCount(model.model, next?.batteries ?? 0)
    if (id === B.RESISTOR && model?.type === 'resistor' && (
      next?.resistorDigit1 !== previous?.resistorDigit1 ||
      next?.resistorDigit2 !== previous?.resistorDigit2 ||
      next?.resistorMultiplier !== previous?.resistorMultiplier ||
      next?.resistorTolerance !== previous?.resistorTolerance
    )) {
      const replacement = createResistorModel(
        next?.resistorDigit1 ?? 1, next?.resistorDigit2 ?? 0,
        next?.resistorMultiplier ?? 1, next?.resistorTolerance ?? 5,
      )
      replacement.group.position.copy(model.model.group.position)
      this.scene.add(replacement.group)
      disposeObject(model.model.group)
      model = { type: 'resistor', model: replacement }
      this.models.set(key, model)
    }
    if (id === B.SWITCH && model?.type === 'switch') setSwitchState(model.model, Boolean(next?.switchOn))
    if (id === B.PROXIMITY_SENSOR && model?.type === 'sensor') {
      if (next?.facing !== undefined) setProximitySensorFacing(model.model, next.facing)
      setProximitySensorActive(model.model, Boolean(next?.proximityActive))
    }
    if (id === B.WHEEL && model?.type === 'wheel' && next?.facing !== undefined) {
      const replacement = createArduinoWheelModel(next.facing)
      replacement.group.position.copy(model.model.group.position)
      replacement.group.scale.copy(model.model.group.scale)
      this.scene.add(replacement.group)
      disposeObject(model.model.group)
      this.models.set(key, { ...model, model: replacement })
    }
    const mounted = this.mountedWheels.get(key)
    if (next?.mountedWheel && !mounted) this.mountWheel(x, y, z)
    else if (!next?.mountedWheel && mounted) {
      const motor = this.models.get(key)
      if (motor?.type === 'motor') motor.model.shaft.remove(mounted.model.group)
      disposeObject(mounted.model.group)
      this.mountedWheels.delete(key)
    }
    if (id === B.MOTOR || id === B.BATTERY_BOX || id === B.LED || id === B.RESISTOR || id === B.SWITCH || id === B.PROXIMITY_SENSOR || id === B.IRON || id === B.ALUMINUM || id === B.GEAR || id === B.ROBOTICS || id === B.COMPONENT || id === B.SERVO || id === B.ARDUINO_UNO) {
      this.powerDirty = true
      this.mechDirty = true
    }
    this.physicsDirty = true
    this.world.markBlockDirty(x, y, z)
  }

  private isElectricalBlock(id: number) {
    return id === B.MOTOR || id === B.SERVO || id === B.BATTERY_BOX || id === B.LED || id === B.RESISTOR || id === B.SWITCH || id === B.PROXIMITY_SENSOR || id === B.IRON
      || id === B.ALUMINUM || id === B.ROBOTICS || id === B.COMPONENT
  }

  mountWheel(x: number, y: number, z: number) {
    const key = posKey(x, y, z)
    if (this.mountedWheels.has(key)) return false
    const entry = this.models.get(key)
    if (!entry || entry.type !== 'motor') return false
    // This wheel is parented to the motor shaft, whose parent already has the
    // motor's facing quaternion. Keep the wheel axle on local +Z so facing is
    // applied exactly once and follows all six motor orientations.
    const wheel = createArduinoWheelModel(4)
    wheel.group.position.set(0, 0, 0.36)
    wheel.group.scale.setScalar(0.88)
    entry.model.shaft.add(wheel.group)
    this.world.ensureState(x, y, z).mountedWheel = true
    this.mountedWheels.set(key, { model: wheel, spin: 0 })
    this.mechDirty = true
    return true
  }

  /* ---------------- Interactions ---------------- */

  rotateMotor(x: number, y: number, z: number, rotateAroundX = false) {
    const key = posKey(x, y, z)
    const st = this.world.ensureState(x, y, z)
    st.facing ??= 2
    st.motorRoll ??= 0
    if (rotateAroundX) {
      // Apply a world-space quarter-turn around X. Find the equivalent
      // (six-way facing + local quarter-turn) representation so the visual,
      // terminals, collider and mechanical output axis stay in agreement.
      const xTurn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
      const target = xTurn.multiply(motorOrientationQuaternion(st.facing, st.motorRoll))
      let bestFacing = st.facing
      let bestRoll = st.motorRoll
      let bestScore = -1
      for (let candidateFacing = 0; candidateFacing < 6; candidateFacing++) {
        for (let candidateRoll = 0; candidateRoll < 4; candidateRoll++) {
          const candidate = motorOrientationQuaternion(candidateFacing, candidateRoll)
          const score = Math.abs(target.dot(candidate))
          if (score > bestScore) {
            bestScore = score
            bestFacing = candidateFacing
            bestRoll = candidateRoll
          }
        }
      }
      st.facing = bestFacing
      st.motorRoll = bestRoll
    } else {
      st.facing = (st.facing + 1) % 6
    }

    const entry = this.models.get(key)
    if (entry?.type === 'motor') {
      setMotorFacing(entry.model, st.facing, st.motorRoll)
      this.refreshMotorTerminalWires(key)
    }
    // Static motor colliders need their orientation/extended TT footprint rebuilt;
    // assembled rotors are rebuilt by the normal mechanism dirty path instead.
    if (!this.contraptions.has(key) && !this.findExtraRotor(key)) this.rigidPhysics.syncStaticBlock(x, y, z)
    this.mechDirty = true
    this.powerDirty = true
    this.powerCooldown = 0
    return rotateAroundX ? st.motorRoll : st.facing
  }

  private refreshMotorTerminalWires(key: string) {
    const entry = this.models.get(key)
    if (entry?.type !== 'motor') return
    entry.model.group.updateWorldMatrix(true, false)
    const terminals = new Map((entry.model.terminals ?? []).map((terminal) => [
      terminal.id,
      entry.model.group.localToWorld(terminal.localPosition.clone()),
    ]))
    for (const wire of this.wires) {
      if (wire.a === key) {
        const point = terminals.get(wire.ta as 'A' | 'B')
        if (point) wire.pa.copy(point)
      }
      if (wire.b === key) {
        const point = terminals.get(wire.tb as 'A' | 'B')
        if (point) wire.pb.copy(point)
      }
      if (wire.a === key || wire.b === key) updateWireMesh(wire.mesh, wire.pa, wire.pb, wire.color)
    }
  }

  rotateServo(x: number, y: number, z: number) {
    const key = posKey(x, y, z)
    if (this.world.getBlock(x, y, z) !== B.SERVO || this.contraptions.has(key)) return null
    const state = this.world.ensureState(x, y, z)
    state.facing = ((state.facing ?? 2) + 1) % 6
    const entry = this.models.get(key)
    if (entry?.type === 'servo') setServoFacing(entry.model, state.facing)
    this.mechDirty = true
    return state.facing
  }

  private getServoState(key: string): BlockState | undefined {
    const [x, y, z] = parseKey(key)
    if (this.world.getBlock(x, y, z) === B.SERVO) {
      const state = this.world.ensureState(x, y, z)
      state.servoOffAngle ??= 0
      state.servoOnAngle ??= 90
      return state
    }
    for (const machine of this.contraptions.values()) {
      if (machine.motorKey === key && machine.actuatorId === B.SERVO) {
        machine.motorState ??= { facing: machine.facing, servoOffAngle: 0, servoOnAngle: 90 }
        machine.motorState.servoOffAngle ??= 0
        machine.motorState.servoOnAngle ??= 90
        return machine.motorState
      }
    }
    const moving = this.findMovingBlock(key)
    if (moving?.id === B.SERVO) {
      moving.state ??= { servoOffAngle: 0, servoOnAngle: 90 }
      moving.state.servoOffAngle ??= 0
      moving.state.servoOnAngle ??= 90
      return moving.state
    }
    for (const body of this.fallingBodies) {
      const block = body.blocks.find((candidate) => candidate.originKey === key && candidate.id === B.SERVO)
      if (block) {
        block.state ??= { servoOffAngle: 0, servoOnAngle: 90 }
        block.state.servoOffAngle ??= 0
        block.state.servoOnAngle ??= 90
        return block.state
      }
    }
    return undefined
  }

  getServoConfig(key: string) {
    const state = this.getServoState(key)
    if (!state) return null
    return {
      offAngle: Math.max(0, Math.min(180, Math.round(state.servoOffAngle ?? 0))),
      onAngle: Math.max(0, Math.min(180, Math.round(state.servoOnAngle ?? 90))),
      powered: this.servoPowered.has(key),
    }
  }

  configureServo(key: string, offAngle: number, onAngle: number) {
    if (!Number.isFinite(offAngle) || !Number.isFinite(onAngle)) return false
    const state = this.getServoState(key)
    if (!state) return false

    state.servoOffAngle = Math.max(0, Math.min(180, Math.round(offAngle)))
    state.servoOnAngle = Math.max(0, Math.min(180, Math.round(onAngle)))

    // Commit settings to the world's canonical block state. Mutating the
    // object returned by ensureState() alone may not mark its chunk as changed.
    const [x, y, z] = parseKey(key)
    if (this.world.getBlock(x, y, z) === B.SERVO) {
      this.world.setBlock(x, y, z, B.SERVO, { ...state })
      // The state object above may have been mutated before setBlock compared it
      // with the previous reference. Force the chunk/save layer to notice it.
      this.world.ensureChunk(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)).modified = true
      this.world.markBlockDirty(x, y, z)
    } else {
      // During articulated simulation, the servo is temporarily absent from the
      // voxel grid. Store changes directly on the active assembly/block state.
      const machine = this.contraptions.get(key)
      if (machine?.actuatorId === B.SERVO) machine.motorState = { ...state }
      else {
        const moving = this.findMovingBlock(key)
        if (moving?.id === B.SERVO) moving.state = { ...state }
        else {
          for (const body of this.fallingBodies) {
            const block = body.blocks.find((candidate) => candidate.originKey === key && candidate.id === B.SERVO)
            if (block) {
              block.state = { ...state }
              break
            }
          }
        }
      }
    }

    this.powerDirty = true
    this.powerCooldown = 0
    this.mechDirty = true
    return true
  }

  getResistorConfig(key: string) {
    const block = this.lookup(key)
    if (block.id !== B.RESISTOR) return null
    const state = block.state ?? {}
    const digit1 = Math.max(0, Math.min(9, Math.floor(state.resistorDigit1 ?? 1)))
    const digit2 = Math.max(0, Math.min(9, Math.floor(state.resistorDigit2 ?? 0)))
    const multiplier = Math.max(-2, Math.min(9, Math.floor(state.resistorMultiplier ?? 1)))
    const tolerance = state.resistorTolerance ?? 5
    return {
      digit1, digit2, multiplier, tolerance,
      resistanceOhms: resistorActualResistanceOhms(digit1, digit2, multiplier, state.resistorActualOffsetPct ?? 0),
    }
  }

  configureResistor(key: string, digit1: number, digit2: number, multiplier: number, tolerance: number) {
    if (![digit1, digit2, multiplier, tolerance].every(Number.isFinite)) return false
    if (this.lookup(key).id !== B.RESISTOR) return false
    const [x, y, z] = parseKey(key)
    const state = {
      ...(this.world.getState(x, y, z) ?? this.lookup(key).state ?? {}),
      resistorDigit1: Math.max(0, Math.min(9, Math.floor(digit1))),
      resistorDigit2: Math.max(0, Math.min(9, Math.floor(digit2))),
      resistorMultiplier: Math.max(-2, Math.min(9, Math.floor(multiplier))),
      resistorTolerance: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10].reduce((best, value) =>
        Math.abs(value - tolerance) < Math.abs(best - tolerance) ? value : best, 5),
      resistorActualOffsetPct: resistorToleranceOffsetPercent(key, [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10].reduce((best, value) =>
        Math.abs(value - tolerance) < Math.abs(best - tolerance) ? value : best, 5)),
    }
    this.world.states.set(key, state)
    this.world.ensureChunk(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)).modified = true
    this.world.markBlockDirty(x, y, z)

    const entry = this.models.get(key)
    if (entry?.type === 'resistor') {
      const replacement = createResistorModel(state.resistorDigit1, state.resistorDigit2, state.resistorMultiplier, state.resistorTolerance)
      replacement.group.position.copy(entry.model.group.position)
      this.scene.add(replacement.group)
      disposeObject(entry.model.group)
      this.models.set(key, { type: 'resistor', model: replacement })
    }
    this.powerDirty = true
    this.powerCooldown = 0
    if (this.networkAuthority && this.world.getBlock(x, y, z) === B.RESISTOR) {
      this.networkBlockPublisher?.(x, y, z, B.RESISTOR, { ...state }, this.networkBlockOwner?.(x, y, z))
    }
    return true
  }

  changeBatteries(x: number, y: number, z: number, delta: number) {
    const st = this.world.ensureState(x, y, z)
    const before = st.batteries ?? 0
    st.batteries = Math.max(0, Math.min(3, before + delta))
    const e = this.models.get(posKey(x, y, z))
    if (e?.type === 'box') setBatteryCount(e.model, st.batteries)
    this.powerDirty = true
    this.mechDirty = true
    return { before, after: st.batteries }
  }

  toggleGlue(x: number, y: number, z: number, face: number) {
    const st = this.world.ensureState(x, y, z)
    st.glue = (st.glue ?? 0) ^ (1 << face)
    this.rebuildGlue()
    this.physicsDirtyKeys.add(posKey(x, y, z))
    this.physicsDirty = true
    this.mechDirty = true
    return Boolean(st.glue & (1 << face))
  }

  /** Toggle the rocker on a fixed or moving block without disassembling the machine. */
  toggleSwitchAtKey(key: string): boolean | null {
    const [x, y, z] = parseKey(key)
    if (this.world.getBlock(x, y, z) === B.SWITCH) {
      const state = this.world.ensureState(x, y, z)
      state.switchOn = !Boolean(state.switchOn)
      const model = this.models.get(key)
      if (model?.type === 'switch') setSwitchState(model.model, state.switchOn)
      this.powerDirty = true
      this.mechDirty = true
      this.powerCooldown = 0
      return state.switchOn
    }
    for (const c of this.contraptions.values()) {
      const extraBlock = (c.extraRotors ?? []).map((rotor) => rotor.byKey.get(key)).find(Boolean)
      const block = c.byKey.get(key) ?? c.chassisByKey.get(key) ?? extraBlock
      if (block?.id !== B.SWITCH) continue
      block.state = { ...(block.state ?? {}), switchOn: !Boolean(block.state?.switchOn) }
      const model = this.models.get(key)
      if (model?.type === 'switch') setSwitchState(model.model, Boolean(block.state.switchOn))
      this.powerDirty = true
      this.mechDirty = true
      this.powerCooldown = 0
      return Boolean(block.state.switchOn)
    }
    return null
  }


  private findMovingBlock(key: string): CBlock | undefined {
    for (const machine of this.contraptions.values()) {
      const block = machine.byKey.get(key) ?? machine.chassisByKey.get(key)
        ?? (machine.extraRotors ?? []).map((rotor) => rotor.byKey.get(key)).find(Boolean)
      if (block) return block
    }
    return undefined
  }

  private getProximitySensorState(key: string): BlockState | undefined {
    const [x, y, z] = parseKey(key)
    if (this.world.getBlock(x, y, z) === B.PROXIMITY_SENSOR)
      return this.world.ensureState(x, y, z)
    const moving = this.findMovingBlock(key)
    if (moving?.id === B.PROXIMITY_SENSOR) {
      moving.state ??= {}
      return moving.state
    }
    for (const body of this.fallingBodies) {
      const block = body.blocks.find((candidate) => candidate.originKey === key && candidate.id === B.PROXIMITY_SENSOR)
      if (block) {
        block.state ??= {}
        return block.state
      }
    }
    return undefined
  }

  private measureSensorWorldDistance(model: ProximitySensorModel) {
    model.group.updateWorldMatrix(true, false)
    // The transducers sit near the front of the board, not at its voxel center.
    const origin = model.group.localToWorld(new THREE.Vector3(0, 0, 0.32))
    const orientation = model.group.getWorldQuaternion(new THREE.Quaternion())
    const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(orientation)
    return measureProximityRayDistance(this.world, origin, direction)
  }

  /** Re-anchor a detached component after its rigid body returns to the voxel grid. */
  private snapModelToGrid(entry: ModelEntry, key: string, stopMotorShaft: boolean) {
    const [x, y, z] = parseKey(key)
    const state = this.world.getState(x, y, z)
    entry.model.group.rotation.set(0, 0, 0)
    switch (entry.type) {
      case 'motor':
        entry.model.group.position.set(x + 0.5, y + 0.5, z + 0.5)
        setMotorFacing(entry.model, state?.facing ?? 2, state?.motorRoll ?? 0)
        if (stopMotorShaft) entry.model.shaft.rotation.set(0, 0, 0)
        break
      case 'box':
        entry.model.group.position.set(x + 0.5, y, z + 0.5)
        entry.model.group.quaternion.identity()
        setBatteryCount(entry.model, state?.batteries ?? 0)
        break
      case 'led':
        entry.model.group.position.set(x, y, z)
        entry.model.group.quaternion.identity()
        break
      case 'wheel':
        entry.model.group.position.set(x + 0.5, y + 0.5, z + 0.5)
        entry.model.group.quaternion.copy(facingQuaternion(state?.facing ?? 0))
        entry.model.rim.rotation.z = entry.spin
        break
      case 'switch':
        entry.model.group.position.set(x, y, z)
        entry.model.group.quaternion.identity()
        setSwitchState(entry.model, Boolean(state?.switchOn))
        break
      case 'sensor':
        entry.model.group.position.set(x + 0.5, y + 0.5, z + 0.5)
        setProximitySensorFacing(entry.model, state?.facing ?? 5)
        setProximitySensorActive(entry.model, Boolean(state?.proximityActive))
        break
      case 'servo':
        entry.model.group.position.set(x + 0.5, y + 0.5, z + 0.5)
        setServoFacing(entry.model, state?.facing ?? 2)
        break
      case 'arduino_uno':
        entry.model.group.position.set(x + 1, y + 0.14, z + 1)
        entry.model.group.quaternion.identity()
        break
      case 'resistor':
        entry.model.group.position.set(x, y, z)
        entry.model.group.quaternion.identity()
        break
    }
  }

  getProximitySensorConfig(key: string) {
    const block = this.lookup(key)
    if (block.id !== B.PROXIMITY_SENSOR) return null
    const state = block.state ?? {}
    const [x, y, z] = parseKey(key)
    const model = this.models.get(key)
    return {
      operator: (state.proximityOperator ?? 'less') as ProximityComparison,
      threshold: Math.max(1, Math.min(PROXIMITY_SENSOR_RANGE, Math.floor(state.proximityDistance ?? 3))),
      distance: model?.type === 'sensor'
        ? this.measureSensorWorldDistance(model.model)
        : measureProximityDistance(this.world, x, y, z, state.facing ?? 5),
      active: Boolean(state.proximityActive),
      facing: state.facing ?? 5,
    }
  }

  configureProximitySensor(key: string, operator: ProximityComparison, threshold: number) {
    if (!['greater', 'greaterEqual', 'equal', 'lessEqual', 'less'].includes(operator)) return false
    if (!Number.isFinite(threshold)) return false
    const [x, y, z] = parseKey(key)
    let state: BlockState | undefined
    if (this.world.getBlock(x, y, z) === B.PROXIMITY_SENSOR) state = this.world.ensureState(x, y, z)
    else {
      const moving = this.findMovingBlock(key)
      if (moving?.id !== B.PROXIMITY_SENSOR) return false
      moving.state ??= {}
      state = moving.state
    }
    state.proximityOperator = operator
    state.proximityDistance = Math.max(1, Math.min(PROXIMITY_SENSOR_RANGE, Math.floor(threshold)))
    this.powerDirty = true
    this.powerCooldown = 0
    if (this.world.getBlock(x, y, z) === B.PROXIMITY_SENSOR && this.networkAuthority)
      this.networkBlockPublisher?.(x, y, z, B.PROXIMITY_SENSOR, { ...state }, this.networkBlockOwner?.(x, y, z))
    return true
  }

  rotateProximitySensor(key: string) {
    const [x, y, z] = parseKey(key)
    let state: BlockState | undefined
    if (this.world.getBlock(x, y, z) === B.PROXIMITY_SENSOR) state = this.world.ensureState(x, y, z)
    else {
      const moving = this.findMovingBlock(key)
      if (moving?.id !== B.PROXIMITY_SENSOR) return null
      moving.state ??= {}
      state = moving.state
    }
    state.facing = (((state.facing ?? 5) + 1) % 6)
    const model = this.models.get(key)
    if (model?.type === 'sensor') setProximitySensorFacing(model.model, state.facing)
    this.powerDirty = true
    this.powerCooldown = 0
    if (this.world.getBlock(x, y, z) === B.PROXIMITY_SENSOR && this.networkAuthority)
      this.networkBlockPublisher?.(x, y, z, B.PROXIMITY_SENSOR, { ...state }, this.networkBlockOwner?.(x, y, z))
    return state.facing
  }

  private refreshProximitySensors() {
    for (const [key, entry] of this.models) {
      if (entry.type !== 'sensor') continue
      const state = this.getProximitySensorState(key)
      if (!state) continue
      const threshold = Math.max(1, Math.min(PROXIMITY_SENSOR_RANGE, Math.floor(state.proximityDistance ?? 3)))
      const comparison = state.proximityOperator ?? 'less'
      // World transforms include translation, chassis yaw and rotor spin.
      const distance = this.measureSensorWorldDistance(entry.model)
      const active = proximityConditionMatches(distance, comparison, threshold)
      if (Boolean(state.proximityActive) === active) {
        setProximitySensorActive(entry.model, active)
        continue
      }
      state.proximityActive = active
      setProximitySensorActive(entry.model, active)
      this.powerDirty = true
      this.powerCooldown = 0
      const [x, y, z] = parseKey(key)
      if (this.networkAuthority && this.world.getBlock(x, y, z) === B.PROXIMITY_SENSOR)
        this.networkBlockPublisher?.(x, y, z, B.PROXIMITY_SENSOR, { ...state }, this.networkBlockOwner?.(x, y, z))
    }
  }

  /** Resolve an exposed electrical terminal, never an arbitrary point inside a block. */
  resolveTerminal(
    key: string,
    hitPoint: THREE.Vector3,
    face: number,
    rayOrigin?: THREE.Vector3,
    rayDirection?: THREE.Vector3,
  ) {
    const [x, y, z] = parseKey(key)
    const id = this.world.getBlock(x, y, z)
    if (id === B.ARDUINO_UNO) {
      const entry = this.models.get(key)
      if (entry?.type !== 'arduino_uno') return null
      entry.model.group.updateWorldMatrix(true, false)
      const terminals = (entry.model.terminals ?? []).map((terminal) => ({
        terminal: terminal.id,
        point: entry.model.group.localToWorld(terminal.localPosition.clone()),
      }))
      terminals.sort((a, b) => a.point.distanceToSquared(hitPoint) - b.point.distanceToSquared(hitPoint))
      return terminals[0].point.distanceTo(hitPoint) <= 0.15 ? terminals[0] : null
    }
    if (id === B.BATTERY_BOX) {
      const terminals = [
        { terminal: '+', point: new THREE.Vector3(x + 0.82, y + 0.12, z + 0.97) },
        { terminal: '-', point: new THREE.Vector3(x + 0.70, y + 0.12, z + 0.97) },
      ]
      terminals.sort((a, b) => a.point.distanceToSquared(hitPoint) - b.point.distanceToSquared(hitPoint))
      return terminals[0].point.distanceTo(hitPoint) <= 0.3 ? terminals[0] : null
    }
    if (id === B.MOTOR) {
      const entry = this.models.get(key)
      if (entry?.type !== 'motor') return null
      entry.model.group.updateWorldMatrix(true, false)
      const terminals = (entry.model.terminals ?? []).map((terminal) => ({
        terminal: terminal.id,
        point: entry.model.group.localToWorld(terminal.localPosition.clone()),
      }))
      if (terminals.length === 0) return null
      if (rayOrigin && rayDirection) {
        const ray = new THREE.Ray(rayOrigin, rayDirection.clone().normalize())
        const candidates = terminals.map((terminal) => {
          const closest = ray.closestPointToPoint(terminal.point, new THREE.Vector3())
          return { ...terminal, distanceToRay: closest.distanceTo(terminal.point), alongRay: closest.clone().sub(rayOrigin).dot(ray.direction) }
        }).filter((terminal) => terminal.alongRay >= 0 && terminal.alongRay <= 8)
          .sort((a, b) => a.distanceToRay - b.distanceToRay)
        const best = candidates[0]
        return best && best.distanceToRay <= 0.17 ? { terminal: best.terminal, point: best.point } : null
      }
      terminals.sort((a, b) => a.point.distanceToSquared(hitPoint) - b.point.distanceToSquared(hitPoint))
      return terminals[0].point.distanceTo(hitPoint) <= 0.28 ? terminals[0] : null
    }
    const servoEntry = this.models.get(key)
    if (servoEntry?.type === 'servo') {
      servoEntry.model.group.updateWorldMatrix(true, false)
      const terminals = [
        { terminal: 'gnd', local: new THREE.Vector3(-0.2, -0.365, -0.19) },
        { terminal: 'vcc', local: new THREE.Vector3(0, -0.365, -0.19) },
        { terminal: 'signal', local: new THREE.Vector3(0.2, -0.365, -0.19) },
      ].map((terminal) => ({
        terminal: terminal.terminal,
        point: servoEntry.model.group.localToWorld(terminal.local),
      }))
      terminals.sort((a, b) => a.point.distanceToSquared(hitPoint) - b.point.distanceToSquared(hitPoint))
      return terminals[0].point.distanceTo(hitPoint) <= 0.45 ? terminals[0] : null
    }
    if (id === B.PROXIMITY_SENSOR) {
      const entry = this.models.get(key)
      if (entry?.type !== 'sensor') return null
      entry.model.group.updateWorldMatrix(true, true)

      if (rayOrigin && rayDirection) {
        const ray = new THREE.Ray(rayOrigin, rayDirection.clone().normalize())
        const raycaster = new THREE.Raycaster(ray.origin, ray.direction, 0, 8)
        const intersections = raycaster.intersectObjects(entry.model.terminalTargets, false)
        let target = intersections[0]?.object as THREE.Mesh | undefined

        // Forgiving fallback for a touch just beside a target: choose the pin
        // nearest the actual view ray, not the generic voxel-box entry point.
        if (!target) {
          const candidates = entry.model.terminalTargets.map((candidate) => {
            const point = entry.model.group.localToWorld(candidate.position.clone())
            const closestPoint = ray.closestPointToPoint(point, new THREE.Vector3())
            return { candidate, distance: point.distanceTo(closestPoint) }
          }).sort((a, b) => a.distance - b.distance)
          if (candidates[0] && candidates[0].distance <= 0.18) target = candidates[0].candidate
        }

        if (!target) return null
        const terminal = String(target.userData.terminalId ?? '')
        if (!['VCC', 'TRIG', 'ECHO', 'GND'].includes(terminal)) return null
        return {
          terminal,
          point: entry.model.group.localToWorld(target.position.clone()),
        }
      }

      // Compatibility fallback for calls that do not provide a view ray.
      const facing = this.world.getState(x, y, z)?.facing ?? 5
      const q = facingQuaternion(facing)
      const center = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5)
      const terminals = [
        { terminal: 'VCC', local: new THREE.Vector3(-0.24, -0.405, -0.005) },
        { terminal: 'TRIG', local: new THREE.Vector3(-0.08, -0.405, -0.005) },
        { terminal: 'ECHO', local: new THREE.Vector3(0.08, -0.405, -0.005) },
        { terminal: 'GND', local: new THREE.Vector3(0.24, -0.405, -0.005) },
      ].map((terminal) => ({ terminal: terminal.terminal, point: terminal.local.applyQuaternion(q).add(center) }))
      terminals.sort((a, b) => a.point.distanceToSquared(hitPoint) - b.point.distanceToSquared(hitPoint))
      return terminals[0].point.distanceTo(hitPoint) <= 0.35 ? terminals[0] : null
    }
    if (id === B.RESISTOR) {
      const entry = this.models.get(key)
      if (entry?.type !== 'resistor') return null
      entry.model.group.updateWorldMatrix(true, false)
      const terminals = entry.model.terminals.map((terminal) => ({
        terminal: terminal.id,
        point: entry.model.group.localToWorld(terminal.localPosition.clone()),
      }))
      if (rayOrigin && rayDirection) {
        const ray = new THREE.Ray(rayOrigin, rayDirection.clone().normalize())
        const candidates = terminals.map((terminal) => {
          const closest = ray.closestPointToPoint(terminal.point, new THREE.Vector3())
          return { ...terminal, distanceToRay: closest.distanceTo(terminal.point), alongRay: closest.clone().sub(rayOrigin).dot(ray.direction) }
        }).filter((terminal) => terminal.alongRay >= 0 && terminal.alongRay <= 8)
          .sort((a, b) => a.distanceToRay - b.distanceToRay)
        const best = candidates[0]
        return best && best.distanceToRay <= 0.3 ? { terminal: best.terminal, point: best.point } : null
      }
      terminals.sort((a, b) => a.point.distanceToSquared(hitPoint) - b.point.distanceToSquared(hitPoint))
      return terminals[0].point.distanceTo(hitPoint) <= 0.28 ? terminals[0] : null
    }
    if (id === B.SWITCH) {
      const terminals = [
        { terminal: 'in1', point: new THREE.Vector3(x + 0.02, y + 0.115, z + 0.32) },
        { terminal: 'in2', point: new THREE.Vector3(x + 0.02, y + 0.115, z + 0.68) },
        { terminal: 'out1', point: new THREE.Vector3(x + 0.98, y + 0.115, z + 0.32) },
        { terminal: 'out2', point: new THREE.Vector3(x + 0.98, y + 0.115, z + 0.68) },
      ]
      terminals.sort((a, b) => a.point.distanceToSquared(hitPoint) - b.point.distanceToSquared(hitPoint))
      return terminals[0].point.distanceTo(hitPoint) <= 0.38 ? terminals[0] : null
    }
    if (id === B.LED) {
      const terminals = [
        { terminal: 'anode', point: new THREE.Vector3(x + 1, y + 0.5, z + 0.5) },
        { terminal: 'cathode', point: new THREE.Vector3(x, y + 0.5, z + 0.5) },
      ]
      const expected = face === 0 ? terminals[0] : face === 1 ? terminals[1] : null
      return expected && expected.point.distanceTo(hitPoint) <= 0.6 ? expected : null
    }
    const conductivity = BLOCK_CONDUCTIVITY[id] ?? 0
    if (conductivity <= 0) return null
    const normal = DIRS[face]
    if (!normal) return null
    const point = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5)
      .add(new THREE.Vector3(normal[0], normal[1], normal[2]).multiplyScalar(0.5))
    return { terminal: `face:${face}`, point }
  }

  addWire(a: string, pa: THREE.Vector3, ta: string, b: string, pb: THREE.Vector3, tb: string, color = '#fdd835') {
    const mesh = createWireMesh(pa, pb, color)
    this.scene.add(mesh)
    this.wires.push({ id: ++this.wireId, a, b, pa: pa.clone(), pb: pb.clone(), ta, tb, mesh, color })
    this.powerDirty = true
    this.mechDirty = true
  }

  wiresAt(key: string) {
    return this.wires.filter((w) => w.a === key || w.b === key)
  }

  /** Resolve which component and terminal are connected to a specific Arduino pin. */
  getTerminalConnections(key: string, terminal: string) {
    return this.wires
      .filter((wire) => (wire.a === key && wire.ta === terminal) || (wire.b === key && wire.tb === terminal))
      .map((wire) => {
        const isA = wire.a === key && wire.ta === terminal
        return {
          wireId: wire.id,
          terminal,
          componentKey: isA ? wire.b : wire.a,
          componentTerminal: isA ? wire.tb : wire.ta,
          color: wire.color,
        }
      })
  }

  private isArduinoServoConnection(connection: { componentKey: string; componentTerminal: string }) {
    // Prefer the dedicated signal terminal. The fallback accepts a wire that
    // touches the servo model when its tiny terminals are difficult to target
    // on touch screens; the selected Arduino pin still has to match exactly.
    const model = this.models.get(connection.componentKey)
    const isServo = model?.type === 'servo' || this.lookup(connection.componentKey).id === B.SERVO
    return isServo && (connection.componentTerminal === 'signal' || connection.componentTerminal === 'vcc' || connection.componentTerminal === 'gnd')
  }

  countArduinoServoConnections(boardKey: string, pin: string) {
    if (this.lookup(boardKey).id !== B.ARDUINO_UNO || !/^D(?:[0-9]|1[0-3])$/.test(pin)) return 0
    return this.getTerminalConnections(boardKey, pin).filter((connection) =>
      this.isArduinoServoConnection(connection),
    ).length
  }

  setArduinoServoAngle(boardKey: string, pin: string, degrees: number) {
    if (!Number.isFinite(degrees) || this.lookup(boardKey).id !== B.ARDUINO_UNO || !/^D(?:[0-9]|1[0-3])$/.test(pin)) return 0
    const angle = Math.max(1, Math.min(180, Math.round(degrees)))
    const servos = this.getTerminalConnections(boardKey, pin).filter((connection) =>
      this.isArduinoServoConnection(connection),
    )
    for (const connection of servos) {
      this.programmedServoAngles.set(connection.componentKey, { boardKey, degrees: angle })
    }
    return servos.length
  }

  isArduinoPowered(boardKey: string) {
    return this.poweredArduinoBoards.has(boardKey)
  }

  setArduinoPinLevel(boardKey: string, pin: string, high: boolean) {
    if (this.lookup(boardKey).id !== B.ARDUINO_UNO || !/^D(?:[0-9]|1[0-3])$/.test(pin)) return false
    this.arduinoPinLevels.set(`${boardKey}|${pin}`, Boolean(high))
    this.powerDirty = true
    this.powerCooldown = 0
    return true
  }

  readArduinoDistance(boardKey: string, trigPin: string, echoPin: string) {
    if (this.lookup(boardKey).id !== B.ARDUINO_UNO
      || !/^D(?:[0-9]|1[0-3])$/.test(trigPin)
      || !/^D(?:[0-9]|1[0-3])$/.test(echoPin)
      || trigPin === echoPin) return null
    const trigConnection = this.getTerminalConnections(boardKey, trigPin).find((connection) =>
      connection.componentTerminal === 'TRIG' && this.lookup(connection.componentKey).id === B.PROXIMITY_SENSOR)
    if (!trigConnection) return null
    const sensorKey = trigConnection.componentKey
    const echoConnection = this.getTerminalConnections(boardKey, echoPin).find((connection) =>
      connection.componentKey === sensorKey && connection.componentTerminal === 'ECHO')
    if (!echoConnection) return null
    const vcc = this.wires.some((wire) =>
      (wire.a === sensorKey && wire.ta === 'VCC' && wire.b === boardKey && wire.tb === '5V')
      || (wire.b === sensorKey && wire.tb === 'VCC' && wire.a === boardKey && wire.ta === '5V'))
    const gnd = this.wires.some((wire) =>
      (wire.a === sensorKey && wire.ta === 'GND' && wire.b === boardKey && ['GND', 'GND_2'].includes(wire.tb))
      || (wire.b === sensorKey && wire.tb === 'GND' && wire.a === boardKey && ['GND', 'GND_2'].includes(wire.ta)))
    if (!vcc || !gnd) return null
    return this.getProximitySensorConfig(sensorKey)?.distance ?? null
  }

  clearArduinoProgram(boardKey: string) {
    const prefix = `${boardKey}|`
    for (const pin of this.arduinoPinLevels.keys()) {
      if (pin.startsWith(prefix)) this.arduinoPinLevels.delete(pin)
    }
    for (const [servoKey, command] of this.programmedServoAngles) {
      if (command.boardKey === boardKey) this.programmedServoAngles.delete(servoKey)
    }
    this.powerDirty = true
    this.powerCooldown = 0
  }

  private getArduinoDrivenLevel(componentKey: string, terminal: string): boolean | undefined {
    for (const [boardKey, entry] of this.models) {
      if (entry.type !== 'arduino_uno') continue
      for (let index = 0; index < 14; index++) {
        const pin = `D${index}`
        const level = this.arduinoPinLevels.get(`${boardKey}|${pin}`)
        if (level === undefined) continue
        if (this.getTerminalConnections(boardKey, pin).some((connection) =>
          connection.componentKey === componentKey && connection.componentTerminal === terminal,
        )) return level
      }
      for (const ground of ['GND', 'GND_2']) {
        if (this.getTerminalConnections(boardKey, ground).some((connection) =>
          connection.componentKey === componentKey && connection.componentTerminal === terminal,
        )) return false
      }
      if (this.getTerminalConnections(boardKey, '5V').some((connection) =>
        connection.componentKey === componentKey && connection.componentTerminal === terminal,
      )) return true
    }
    return undefined
  }

  removeWiresAt(key: string) {
    const removed = this.wires.filter((w) => w.a === key || w.b === key)
    if (removed.length === 0) return 0
    for (const w of removed) disposeObject(w.mesh)
    this.wires = this.wires.filter((w) => w.a !== key && w.b !== key)
    this.powerDirty = true
    this.mechDirty = true
    return removed.length
  }

  removeWireByNetworkId(networkId: string) {
    const wire = this.wires.find((w) => w.networkId === networkId)
    if (!wire) return false
    disposeObject(wire.mesh)
    this.wires = this.wires.filter((w) => w !== wire)
    this.powerDirty = true
    this.mechDirty = true
    return true
  }

  setNetworkBlockPublisher(
    publisher: ((x: number, y: number, z: number, block: number, state?: BlockState, ownerKey?: string | null) => void) | null,
    ownerLookup: ((x: number, y: number, z: number) => string | null) | null = null,
  ) {
    this.networkBlockPublisher = publisher
    this.networkBlockOwner = ownerLookup
  }

  /* ---------------- Glue rendering ---------------- */

  rebuildGlue() {
    const entries: { x: number; y: number; z: number; mask: number }[] = []
    for (const [k, s] of this.world.states) {
      if (!s.glue) continue
      const [x, y, z] = parseKey(k)
      entries.push({ x, y, z, mask: s.glue })
    }
    if (this.glueMesh) {
      this.glueMesh.geometry.dispose()
      this.scene.remove(this.glueMesh)
      this.glueMesh = null
    }
    if (entries.length) {
      this.glueMesh = new THREE.Mesh(buildGlueGeometry(entries), this.glueMaterial)
      this.glueMesh.renderOrder = 2
      this.scene.add(this.glueMesh)
    }
  }

  /* ---------------- Power ---------------- */

  private lookup(key: string): { id: number; state?: BlockState } {
    for (const c of this.contraptions.values()) {
      const b = c.byKey.get(key) ?? c.chassisByKey.get(key) ?? (c.extraRotors ?? []).map((rotor) => rotor.byKey.get(key)).find(Boolean)
      if (b) return b
    }
    const [x, y, z] = parseKey(key)
    return { id: this.world.getBlock(x, y, z), state: this.world.getState(x, y, z) }
  }

  /** Drain one-shot short-circuit events for the renderer/audio layer. */
  drainShortCircuitEvents() {
    const events = this.shortCircuitEventQueue
    this.shortCircuitEventQueue = []
    return events
  }

  private recomputePower() {
    // Build a circuit from the actual terminals, then solve node voltages and
    // branch currents with MNA instead of treating every connected net as a
    // full-strength battery rail.
    const node = (key: string, terminal: string) => `${key}|${terminal}`
    const nodes = new Set<string>()
    const resistors: ElectricalResistor[] = []
    const diodes: ElectricalDiode[] = []
    const sources: ElectricalVoltageSource[] = []
    const electricalBlocks = new Map<string, { id: number; state?: BlockState }>()

    for (const chunk of this.world.chunks.values()) {
      const minX = chunk.cx * CHUNK_SIZE
      const minZ = chunk.cz * CHUNK_SIZE
      for (let y = GROUND_LEVEL; y <= Math.min(chunk.maxY, WORLD_HEIGHT - 1); y++) {
        for (let z = minZ; z < minZ + CHUNK_SIZE; z++) {
          for (let x = minX; x < minX + CHUNK_SIZE; x++) {
            const id = this.world.getBlock(x, y, z)
            if (id === B.AIR) continue
            electricalBlocks.set(posKey(x, y, z), { id, state: this.world.getState(x, y, z) })
          }
        }
      }
    }
    // Assemblies are temporarily removed from World while Rapier simulates
    // them. Keep their original keys in the electrical model.
    for (const c of this.contraptions.values()) {
      for (const block of c.blocks) electricalBlocks.set(block.origKey, { id: block.id, state: block.state })
      for (const block of c.chassisBlocks) electricalBlocks.set(block.origKey, { id: block.id, state: block.state })
      for (const extra of c.extraRotors ?? []) {
        for (const block of extra.blocks) electricalBlocks.set(block.origKey, { id: block.id, state: block.state })
      }
      electricalBlocks.set(c.motorKey, { id: c.actuatorId, state: c.motorState })
    }

    // A wire has a small, length-dependent copper resistance (~84 mΩ per
    // metre as a practical thin-wire approximation). Material blocks bridge
    // their faces through a finite resistance rather than perfect continuity.
    for (const wire of this.wires) {
      const a = node(wire.a, wire.ta)
      const b = node(wire.b, wire.tb)
      nodes.add(a); nodes.add(b)
      resistors.push({
        id: `wire:${wire.id}`, a, b,
        resistanceOhms: Math.max(0.001, wire.pa.distanceTo(wire.pb) * 0.084),
      })
    }

    const materialResistance = new Map<number, number>([
      [B.ROBOTICS, 0.08],
      [B.IRON, 0.035],
      [B.COMPONENT, 0.12],
      [B.ALUMINUM, 0.025],
      [B.GEAR, 0.04],
    ])
    const ledKeys: string[] = []
    const ledForwardSpecs = new Map<string, { forwardVoltageVolts: number; dynamicResistanceOhms: number }>()
    const motorKeys: string[] = []
    const servoKeys: string[] = []
    const arduinoKeys: string[] = []

    const addResistor = (id: string, a: string, b: string, resistanceOhms: number) => {
      nodes.add(a); nodes.add(b)
      resistors.push({ id, a, b, resistanceOhms: Math.max(0.001, resistanceOhms) })
    }
    const addTerminals = (key: string, terminals: string[]) => {
      terminals.forEach((terminal) => nodes.add(node(key, terminal)))
    }

    for (const [key, block] of electricalBlocks) {
      const state = block.state ?? {}
      if (block.id === B.BATTERY_BOX) {
        const count = Math.max(0, Math.min(3, Math.floor(state.batteries ?? 0)))
        if (count > 0) {
          addTerminals(key, ['+', '-'])
          sources.push({
            id: `battery-pack:${key}`,
            positive: node(key, '+'), negative: node(key, '-'),
            voltageVolts: 1.5 * count,
            internalResistanceOhms: 0.15 * count,
          })
        }
      } else if (block.id === B.RESISTOR) {
        addTerminals(key, ['A', 'B'])
        addResistor(
          `resistor:${key}`, node(key, 'A'), node(key, 'B'),
          resistorActualResistanceOhms(state.resistorDigit1 ?? 1, state.resistorDigit2 ?? 0, state.resistorMultiplier ?? 1, state.resistorActualOffsetPct ?? resistorToleranceOffsetPercent(key, state.resistorTolerance ?? 5)),
        )
      } else if (block.id === B.LED) {
        addTerminals(key, ['anode', 'cathode'])
        ledKeys.push(key)
        if (!state.ledBurnedOut) {
          const color = (state.color ?? '#e53935').toLowerCase()
          const forwardVoltageVolts = color.includes('00e5ff') || color.includes('29b6f6') || color.includes('ffffff')
            ? 3.0
            : color.includes('ff4fd8') || color.includes('d81b60') ? 2.8
            : color.includes('7cb342') || color.includes('43a047') ? 2.2
            : color.includes('fdd835') || color.includes('f2ca36') || color.includes('fb8c00') ? 2.05
            : 1.85
          const dynamicResistanceOhms = 8
          ledForwardSpecs.set(key, { forwardVoltageVolts, dynamicResistanceOhms })
          diodes.push({
            id: `led:${key}`,
            anode: node(key, 'anode'), cathode: node(key, 'cathode'),
            forwardVoltageVolts, dynamicResistanceOhms,
          })
        }
      } else if (block.id === B.MOTOR) {
        addTerminals(key, ['A', 'B'])
        motorKeys.push(key)
        const spec = getMotorSpec(state.motorType)
        const motorResistance = spec.nominalVoltageV / (spec.stallCurrentA ?? 1.5)
        const mechanism = this.contraptions.get(key)
        const extra = this.findExtraRotor(key)
        const angularSpeed = mechanism?.speed ?? extra?.rotor.speed ?? 0
        const noLoadAngularSpeed = spec.noLoadRpm * Math.PI * 2 / 60
        const speedRatio = Math.min(0.95, Math.abs(angularSpeed) / Math.max(0.01, noLoadAngularSpeed))
        const lastDirection = this.motorDirection.get(key) ?? 1
        addResistor(
          `motor:${key}`, node(key, 'A'), node(key, 'B'), motorResistance,
        )
        const branch = resistors[resistors.length - 1]
        branch.offsetVoltageVolts = speedRatio * spec.nominalVoltageV * lastDirection
      } else if (block.id === B.SERVO) {
        addTerminals(key, ['gnd', 'vcc', 'signal'])
        servoKeys.push(key)
        // Representative load while the servo is powered, not a zero-current
        // control pin. Its stall transient is simplified in this first model.
        addResistor(`servo-load:${key}`, node(key, 'vcc'), node(key, 'gnd'), 24)
      } else if (block.id === B.SWITCH) {
        addTerminals(key, ['in1', 'out1', 'in2', 'out2'])
        if (state.switchOn) {
          addResistor(`switch-pole1:${key}`, node(key, 'in1'), node(key, 'out1'), 0.01)
          addResistor(`switch-pole2:${key}`, node(key, 'in2'), node(key, 'out2'), 0.01)
        }
      } else if (block.id === B.ARDUINO_UNO) {
        const terminals = [...Array.from({ length: 14 }, (_, index) => `D${index}`), '5V', 'GND', 'GND_2', 'VIN']
        addTerminals(key, terminals)
        arduinoKeys.push(key)
        addResistor(`arduino-gnd-bond:${key}`, node(key, 'GND'), node(key, 'GND_2'), 0.005)
        addResistor(`arduino-base-load:${key}`, node(key, '5V'), node(key, 'GND'), 1000)
      } else if (block.id === B.PROXIMITY_SENSOR) {
        addTerminals(key, ['VCC', 'TRIG', 'ECHO', 'GND'])
        addResistor(`sensor-load:${key}`, node(key, 'VCC'), node(key, 'GND'), 1000)
      }

      const conductivity = BLOCK_CONDUCTIVITY[block.id] ?? 0
      const faceResistance = materialResistance.get(block.id)
      if (conductivity > 0 && faceResistance !== undefined) {
        const faces = DIRS.map((_, i) => node(key, `face:${i}`))
        faces.forEach((face) => nodes.add(face))
        // All six surfaces share the material's bulk resistance. Using a
        // star equivalent keeps the voxel internally conductive without
        // adding a complete 6×6 mesh of redundant branches.
        for (let i = 1; i < faces.length; i++) {
          addResistor(`material:${key}:${i}`, faces[0], faces[i], faceResistance)
        }
      }
    }

    // Touching conductive voxels conduct through their shared interface.
    // Add each interface once; this preserves separate electrical terminals
    // on components while allowing conductive chassis blocks to carry current.
    for (const [key, block] of electricalBlocks) {
      if ((BLOCK_CONDUCTIVITY[block.id] ?? 0) <= 0 || !materialResistance.has(block.id)) continue
      const [x, y, z] = parseKey(key)
      for (const face of [0, 2, 4]) {
        const [dx, dy, dz] = DIRS[face]
        const neighborKey = posKey(x + dx, y + dy, z + dz)
        const neighbor = electricalBlocks.get(neighborKey)
        if (!neighbor || (BLOCK_CONDUCTIVITY[neighbor.id] ?? 0) <= 0 || !materialResistance.has(neighbor.id)) continue
        const a = node(key, `face:${face}`)
        const b = node(neighborKey, `face:${OPPOSITE[face]}`)
        addResistor(
          `contact:${key}:${face}:${neighborKey}`,
          a, b,
          (materialResistance.get(block.id)! + materialResistance.get(neighbor.id)!) / 2,
        )
      }
    }

    // First solve estimates the unloaded rails. An Arduino regulator only
    // starts when VIN is in its practical 6.5–12 V input range; powering the
    // 5V pin directly bypasses the regulator and needs a 4.4–5.5 V rail.
    const baseInput = { nodes: [...nodes], resistors, voltageSources: sources, diodes }
    const baseSolution = solveDcCircuit(baseInput)
    const boardCanRun = new Map<string, boolean>()
    for (const key of arduinoKeys) {
      const ground = node(key, 'GND')
      const vin = (baseSolution.nodeVoltages.get(node(key, 'VIN')) ?? 0) - (baseSolution.nodeVoltages.get(ground) ?? 0)
      const five = (baseSolution.nodeVoltages.get(node(key, '5V')) ?? 0) - (baseSolution.nodeVoltages.get(ground) ?? 0)
      if (vin >= 6.5 && vin <= 12) {
        sources.push({
          id: `arduino-regulator:${key}`,
          positive: node(key, '5V'), negative: ground,
          voltageVolts: 5, internalResistanceOhms: 1.2,
        })
      }
      boardCanRun.set(key, (vin >= 6.5 && vin <= 12) || (five >= 4.4 && five <= 5.5))
    }

    // Digital outputs have finite drive strength. A direct pin-to-motor load
    // therefore cannot behave like an ideal motor driver; use an H-bridge or
    // transistor stage in a future extension when such parts are added.
    for (const key of arduinoKeys) {
      if (!boardCanRun.get(key)) continue
      const ground = node(key, 'GND')
      for (let index = 0; index < 14; index++) {
        const pin = `D${index}`
        const level = this.arduinoPinLevels.get(`${key}|${pin}`)
        if (level === undefined) continue
        if (level) {
          const driveNode = `@arduino-output:${key}:${pin}`
          nodes.add(driveNode)
          addResistor(`arduino-pin-high:${key}:${pin}`, node(key, '5V'), node(key, pin), 150)
        } else {
          addResistor(`arduino-low:${key}:${pin}`, node(key, pin), ground, 20)
        }
      }
    }

    let solution = solveDcCircuit({ nodes: [...nodes], resistors, voltageSources: sources, diodes })

    // Determine whether each LED has a complete external return path without
    // using the LED itself. This prevents a floating, disconnected LED from
    // being marked burned just because its unconnected cathode floats near 0 V.
    const passiveAdjacency = new Map<string, Set<string>>()
    const connectPassive = (a: string, b: string) => {
      if (!passiveAdjacency.has(a)) passiveAdjacency.set(a, new Set())
      if (!passiveAdjacency.has(b)) passiveAdjacency.set(b, new Set())
      passiveAdjacency.get(a)!.add(b)
      passiveAdjacency.get(b)!.add(a)
    }
    for (const branch of resistors) connectPassive(branch.a, branch.b)
    for (const source of sources) {
      const sourceInternal = `@source:${source.id}:positive`
      connectPassive(source.positive, sourceInternal)
      connectPassive(sourceInternal, source.negative)
    }
    const hasPassivePath = (start: string, end: string) => {
      if (start === end) return false
      const visited = new Set<string>([start])
      const queue = [start]
      while (queue.length) {
        const current = queue.shift()!
        if (current === end) return true
        for (const next of passiveAdjacency.get(current) ?? []) {
          if (visited.has(next)) continue
          visited.add(next)
          queue.push(next)
        }
      }
      return false
    }

    const burnedNow: string[] = []
    for (const ledKey of ledKeys) {
      const block = electricalBlocks.get(ledKey)
      if (!block || block.state?.ledBurnedOut) continue
      const diodeId = `led:${ledKey}`
      const spec = ledForwardSpecs.get(ledKey)
      const anodeVoltage = solution.nodeVoltages.get(node(ledKey, 'anode')) ?? 0
      const cathodeVoltage = solution.nodeVoltages.get(node(ledKey, 'cathode')) ?? 0
      const solvedCurrent = solution.diodeCurrents.get(diodeId) ?? 0
      // The piecewise-linear diode solver can occasionally finish an iteration
      // with the diode state stale in a large circuit. Estimate forward current
      // from the measured terminal voltage as a fail-safe; an open/unpowered LED
      // still has no forward voltage and therefore cannot trip this check.
      const voltageEstimatedCurrent = spec && hasPassivePath(node(ledKey, 'anode'), node(ledKey, 'cathode'))
        ? Math.max(0, (anodeVoltage - cathodeVoltage - spec.forwardVoltageVolts) / spec.dynamicResistanceOhms)
        : 0
      const current = Math.max(solvedCurrent, voltageEstimatedCurrent)
      if (current <= 0.03) continue

      // Excess forward current permanently opens the LED. Persist damage both
      // for ordinary world blocks and LEDs currently held in a moving assembly.
      const [x, y, z] = parseKey(ledKey)
      const state = { ...block.state, ...(this.world.getState(x, y, z) ?? {}), ledBurnedOut: true }
      const worldHasLed = this.world.getBlock(x, y, z) === B.LED
      if (worldHasLed) {
        this.world.states.set(ledKey, state)
        this.world.ensureChunk(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)).modified = true
        this.world.markBlockDirty(x, y, z)
        if (this.networkAuthority) {
          this.networkBlockPublisher?.(x, y, z, B.LED, state, this.networkBlockOwner?.(x, y, z))
        }
      } else {
        const movingBlock = this.findMovingBlock(ledKey)
        if (movingBlock?.id === B.LED) movingBlock.state = state
        else {
          const fallingBlock = this.fallingBodies.flatMap((body) => body.blocks)
            .find((candidate) => candidate.originKey === ledKey && candidate.id === B.LED)
          if (!fallingBlock) continue
          fallingBlock.state = state
        }
      }
      block.state = state
      burnedNow.push(ledKey)
    }
    if (burnedNow.length) {
      const burned = new Set(burnedNow.map((key) => `led:${key}`))
      solution = solveDcCircuit({
        nodes: [...nodes], resistors, voltageSources: sources,
        diodes: diodes.filter((diode) => !burned.has(diode.id)),
      })
    }

    this.electricalNodeVoltages = solution.nodeVoltages
    this.electricalBranchCurrents = new Map<string, number>([
      ...solution.resistorCurrents.entries(),
      ...solution.diodeCurrents.entries(),
      ...solution.sourceCurrents.entries(),
    ])

    // A sustained short only creates one event. The event rearms after the
    // current falls back below the trip threshold, avoiding frame-by-frame
    // explosions while the player leaves the fault connected.
    const shortThresholdAmps = 4.5
    const currentShortSources = new Set<string>()
    for (const source of sources) {
      if (!source.id.startsWith('battery-pack:')) continue
      const current = Math.abs(solution.sourceCurrents.get(source.id) ?? 0)
      if (current >= shortThresholdAmps) {
        currentShortSources.add(source.id)
        if (!this.activeShortSources.has(source.id)) {
          this.shortCircuitEventQueue.push(source.id.slice('battery-pack:'.length))
        }
      }
    }
    this.activeShortSources = currentShortSources

    this.motorPower.clear()
    this.motorDirection.clear()
    for (const key of motorKeys) {
      const voltage = (solution.nodeVoltages.get(node(key, 'A')) ?? 0)
        - (solution.nodeVoltages.get(node(key, 'B')) ?? 0)
      if (Math.abs(voltage) >= 0.4) {
        this.motorPower.set(key, Math.abs(voltage) / 1.5)
        this.motorDirection.set(key, voltage >= 0 ? 1 : -1)
      }
    }

    this.servoPowered.clear()
    for (const key of servoKeys) {
      const ground = solution.nodeVoltages.get(node(key, 'gnd')) ?? 0
      const vcc = (solution.nodeVoltages.get(node(key, 'vcc')) ?? 0) - ground
      const signal = (solution.nodeVoltages.get(node(key, 'signal')) ?? 0) - ground
      if (vcc >= 4 && signal >= 2.4) this.servoPowered.add(key)
    }

    const nextPoweredArduinoBoards = new Set<string>()
    for (const key of arduinoKeys) {
      const ground = solution.nodeVoltages.get(node(key, 'GND')) ?? 0
      const vin = (solution.nodeVoltages.get(node(key, 'VIN')) ?? 0) - ground
      const five = (solution.nodeVoltages.get(node(key, '5V')) ?? 0) - ground
      if ((vin >= 6.5 && vin <= 12) || (five >= 4.4 && five <= 5.5)) nextPoweredArduinoBoards.add(key)
    }
    this.poweredArduinoBoards = nextPoweredArduinoBoards

    const leds = new Set<string>()
    for (const key of ledKeys) {
      if (electricalBlocks.get(key)?.state?.ledBurnedOut) continue
      const spec = ledForwardSpecs.get(key)
      const anode = solution.nodeVoltages.get(node(key, 'anode')) ?? 0
      const cathode = solution.nodeVoltages.get(node(key, 'cathode')) ?? 0
      const solvedCurrent = solution.diodeCurrents.get(`led:${key}`) ?? 0
      const estimatedCurrent = spec && hasPassivePath(node(key, 'anode'), node(key, 'cathode'))
        ? Math.max(0, (anode - cathode - spec.forwardVoltageVolts) / spec.dynamicResistanceOhms)
        : 0
      const current = Math.max(solvedCurrent, estimatedCurrent)
      if (current > 0.001 && anode - cathode >= 1.5) leds.add(key)
    }

    const previousLeds = this.world.poweredLeds
    for (const key of previousLeds) {
      if (leds.has(key)) continue
      const [x, y, z] = parseKey(key)
      this.world.markBlockDirty(x, y, z)
      const glow = this.glows.get(key)
      if (glow) {
        glow.parent?.remove(glow)
        this.glows.delete(key)
      }
    }
    for (const key of leds) {
      const [x, y, z] = parseKey(key)
      if (!previousLeds.has(key)) this.world.markBlockDirty(x, y, z)
      if (!this.glows.has(key) && this.world.getBlock(x, y, z) === B.LED) {
        const glow = createGlowSprite()
        glow.position.set(x + 0.5, y + 0.5, z + 0.5)
        this.scene.add(glow)
        this.glows.set(key, glow)
      }
    }
    this.world.poweredLeds = leds
  }

  /* ---------------- Contraptions ---------------- */

  private findExtraRotor(motorKey: string): { machine: Contraption; rotor: ExtraRotor } | null {
    for (const machine of this.contraptions.values()) {
      const rotor = (machine.extraRotors ?? []).find((entry) => entry.motorKey === motorKey)
      if (rotor) return { machine, rotor }
    }
    return null
  }

  private isGlued(x: number, y: number, z: number, d: number) {
    const n = DIRS[d]
    const a = this.world.getState(x, y, z)?.glue ?? 0
    const b = this.world.getState(x + n[0], y + n[1], z + n[2])?.glue ?? 0
    return Boolean(a & (1 << d)) || Boolean(b & (1 << OPPOSITE[d]))
  }

  private tryAssemble(motorKey: string): 'idle' | 'stalled' | 'driving' {
    if (!this.rigidPhysics.ready) {
      // Rapier initializes asynchronously; retry the assembly on a later frame.
      this.mechDirty = true
      return 'idle'
    }

    const [mx, my, mz] = parseKey(motorKey)
    const actuatorId = this.world.getBlock(mx, my, mz)
    if (actuatorId !== B.MOTOR && actuatorId !== B.SERVO) return 'idle'
    const isServo = actuatorId === B.SERVO
    const motorState = this.world.getState(mx, my, mz)
    const facing = motorState?.facing ?? 2
    const d = DIRS[facing]
    const sx = mx + d[0], sy = my + d[1], sz = mz + d[2]
    const outputId = this.world.getBlock(sx, sy, sz)
    // A mounted wheel is a valid shaft load even if there is no voxel glued to
    // the output face. Model it with a small sensor rotor so its motor can still
    // assemble a chassis and use the same powered-wheel traction path.
    const wheelOnlyRotor = outputId === B.AIR && Boolean(motorState?.mountedWheel)
    if (!wheelOnlyRotor && (outputId === B.AIR || outputId === B.MOTOR || outputId === B.SERVO || !this.isGlued(mx, my, mz, facing))) return 'idle'

    // The output-face glue component becomes the rotor rigid body.
    const seedKey = posKey(sx, sy, sz)
    const visited = new Set<string>(wheelOnlyRotor ? [] : [seedKey])
    const queue: [number, number, number][] = wheelOnlyRotor ? [] : [[sx, sy, sz]]
    while (queue.length) {
      const [x, y, z] = queue.shift()!
      if (y < GROUND_LEVEL || visited.size > MAX_CONTRAPTION) return 'stalled'
      for (let face = 0; face < 6; face++) {
        const n = DIRS[face]
        const nx = x + n[0], ny = y + n[1], nz = z + n[2]
        const key = posKey(nx, ny, nz)
        if (visited.has(key) || key === motorKey || this.world.getBlock(nx, ny, nz) === B.MOTOR || this.world.getBlock(nx, ny, nz) === B.SERVO) continue
        if (this.world.getBlock(nx, ny, nz) === B.AIR || !this.isGlued(x, y, z, face)) continue
        visited.add(key)
        queue.push([nx, ny, nz])
      }
    }

    // Other faces form the non-rotating chassis. It remains rigid, but is a
    // separate body linked to the rotor by a revolute joint at the shaft.
    const chassisVisited = new Set<string>()
    const chassisQueue: [number, number, number][] = []
    for (let face = 0; face < 6; face++) {
      if (face === facing || !this.isGlued(mx, my, mz, face)) continue
      const n = DIRS[face]
      const x = mx + n[0], y = my + n[1], z = mz + n[2]
      const key = posKey(x, y, z)
      if (this.world.getBlock(x, y, z) !== B.AIR && !visited.has(key)) {
        chassisVisited.add(key)
        chassisQueue.push([x, y, z])
      }
    }
    while (chassisQueue.length && chassisVisited.size <= MAX_CONTRAPTION) {
      const [x, y, z] = chassisQueue.shift()!
      const currentId = this.world.getBlock(x, y, z)
      const currentState = this.world.getState(x, y, z)
      const outputFace = currentId === B.MOTOR || currentId === B.SERVO ? (((currentState?.facing ?? 2) % 6) + 6) % 6 : -1
      for (let face = 0; face < 6; face++) {
        // A second motor is part of the chassis, but its output face must seed
        // an independent rotor instead of gluing that arm rigidly to the frame.
        if (face === outputFace) continue
        const n = DIRS[face]
        const nx = x + n[0], ny = y + n[1], nz = z + n[2]
        const key = posKey(nx, ny, nz)
        if (key === motorKey || visited.has(key) || chassisVisited.has(key)) continue
        if (this.world.getBlock(nx, ny, nz) === B.AIR || !this.isGlued(x, y, z, face)) continue
        chassisVisited.add(key)
        chassisQueue.push([nx, ny, nz])
      }
    }

    // Find other motors on this chassis and split each glued output assembly
    // into its own Rapier rotor. The chassis remains a single shared rigid body.
    const extraRotorSpecs: {
      motorKey: string
      motorPos: [number, number, number]
      motorOffset: [number, number, number]
      motorState?: BlockState
      axis: THREE.Vector3
      facing: number
      blocks: CBlock[]
      byKey: Map<string, CBlock>
      wheelOnly: boolean
    }[] = []
    const extraRotorKeys = new Set<string>()
    for (const candidateKey of [...chassisVisited]) {
      const [rx, ry, rz] = parseKey(candidateKey)
      if (this.world.getBlock(rx, ry, rz) !== B.MOTOR) continue
      const motorState = this.world.getState(rx, ry, rz)
      const extraFacing = (((motorState?.facing ?? 2) % 6) + 6) % 6
      const extraDir = DIRS[extraFacing]
      const ex = rx + extraDir[0], ey = ry + extraDir[1], ez = rz + extraDir[2]
      const seed = posKey(ex, ey, ez)
      const wheelOnly = this.world.getBlock(ex, ey, ez) === B.AIR && Boolean(motorState?.mountedWheel)
      if ((this.world.getBlock(ex, ey, ez) === B.AIR && !wheelOnly)
        || this.world.getBlock(ex, ey, ez) === B.MOTOR || this.world.getBlock(ex, ey, ez) === B.SERVO
        || (!wheelOnly && !this.isGlued(rx, ry, rz, extraFacing)) || visited.has(seed)
        || chassisVisited.has(seed) || extraRotorKeys.has(seed)) continue

      // A motor-mounted wheel must keep its own angular body even without
      // a glued voxel attached to the shaft.
      const extraVisited = new Set<string>(wheelOnly ? [] : [seed])
      const extraQueue: [number, number, number][] = wheelOnly ? [] : [[ex, ey, ez]]
      let invalid = false
      while (extraQueue.length) {
        const [x, y, z] = extraQueue.shift()!
        if (y < GROUND_LEVEL || extraVisited.size > MAX_CONTRAPTION) { invalid = true; break }
        for (let face = 0; face < 6; face++) {
          const n = DIRS[face]
          const nx = x + n[0], ny = y + n[1], nz = z + n[2]
          const key = posKey(nx, ny, nz)
          const id = this.world.getBlock(nx, ny, nz)
          if (id === B.AIR || id === B.MOTOR || id === B.SERVO || key === motorKey || visited.has(key)
            || chassisVisited.has(key) || extraVisited.has(key) || extraRotorKeys.has(key)) continue
          if (!this.isGlued(x, y, z, face)) continue
          extraVisited.add(key)
          extraQueue.push([nx, ny, nz])
        }
      }
      if (invalid || (!wheelOnly && extraVisited.size === 0)) continue
      const extraBlocks: CBlock[] = []
      const extraByKey = new Map<string, CBlock>()
      for (const key of extraVisited) {
        const [x, y, z] = parseKey(key)
        const state = this.world.getState(x, y, z)
        const block: CBlock = {
          rel: [x - rx, y - ry, z - rz],
          id: this.world.getBlock(x, y, z),
          state: state ? { ...state } : undefined,
          origKey: key,
        }
        extraBlocks.push(block)
        extraByKey.set(key, block)
        extraRotorKeys.add(key)
      }
      extraRotorSpecs.push({
        motorKey: candidateKey,
        motorPos: [rx, ry, rz],
        motorOffset: [rx - mx, ry - my, rz - mz],
        motorState: motorState ? { ...motorState } : undefined,
        axis: new THREE.Vector3(...extraDir),
        facing: extraFacing,
        blocks: extraBlocks,
        byKey: extraByKey,
        wheelOnly,
      })
    }
    for (const key of extraRotorKeys) chassisVisited.delete(key)

    const pivot = new THREE.Vector3(mx + 0.5, my + 0.5, mz + 0.5)
    const blocks: CBlock[] = []
    const byKey = new Map<string, CBlock>()
    const relMap = new Map<string, number>()
    for (const key of visited) {
      const [x, y, z] = parseKey(key)
      const state = this.world.getState(x, y, z)
      const cb: CBlock = {
        rel: [x - mx, y - my, z - mz],
        id: this.world.getBlock(x, y, z),
        state: state ? { ...state } : undefined,
        origKey: key,
      }
      blocks.push(cb)
      byKey.set(key, cb)
      relMap.set(posKey(...cb.rel), cb.id)
    }
    const chassisBlocks: CBlock[] = [...chassisVisited].map((key) => {
      const [x, y, z] = parseKey(key)
      const state = this.world.getState(x, y, z)
      const rel: [number, number, number] = [x - mx, y - my, z - mz]
      return { rel, id: this.world.getBlock(x, y, z), state: state ? { ...state } : undefined, origKey: key }
    })
    const chassisByKey = new Map(chassisBlocks.map((b) => [b.origKey, b]))

    const group = new THREE.Group()
    group.position.copy(pivot)
    const out = newBuffers()
    const glueEntries: { x: number; y: number; z: number; mask: number }[] = []
    for (const b of blocks) {
      const [rx, ry, rz] = b.rel
      if (isOpaque(b.id)) {
        const powered = b.id === B.LED && this.world.poweredLeds.has(b.origKey)
        emitCube(out, rx - 0.5, ry - 0.5, rz - 0.5, b.id, powered, (dx, dy, dz) =>
          isOpaque(relMap.get(posKey(rx + dx, ry + dy, rz + dz)) ?? 0),
          b.state?.color,
        )
      }
      if (b.state?.glue) glueEntries.push({ x: rx - 0.5, y: ry - 0.5, z: rz - 0.5, mask: b.state.glue })
      const model = this.models.get(b.origKey)
      if (model) {
        model.model.group.position.sub(pivot)
        group.add(model.model.group)
      }
      const glow = this.glows.get(b.origKey)
      if (glow) {
        glow.position.sub(pivot)
        group.add(glow)
        this.glows.delete(b.origKey)
      }
    }
    if (out.indices.length) group.add(new THREE.Mesh(buffersToGeometry(out), this.blockMaterial))
    if (glueEntries.length) {
      const gm = new THREE.Mesh(buildGlueGeometry(glueEntries), this.glueMaterial)
      gm.renderOrder = 2
      group.add(gm)
    }

    const chassisGroup = new THREE.Group()
    chassisGroup.position.copy(pivot)
    const chassisOut = newBuffers()
    const chassisGlue: { x: number; y: number; z: number; mask: number }[] = []
    const chassisRelMap = new Map<string, number>()
    for (const b of chassisBlocks) chassisRelMap.set(posKey(...b.rel), b.id)
    for (const b of chassisBlocks) {
      const [rx, ry, rz] = b.rel
      if (isOpaque(b.id)) emitCube(chassisOut, rx - 0.5, ry - 0.5, rz - 0.5, b.id, false, (dx, dy, dz) =>
        isOpaque(chassisRelMap.get(posKey(rx + dx, ry + dy, rz + dz)) ?? 0),
        b.state?.color,
      )
      if (b.state?.glue) chassisGlue.push({ x: rx - 0.5, y: ry - 0.5, z: rz - 0.5, mask: b.state.glue })
      const model = this.models.get(b.origKey)
      if (model) {
        model.model.group.position.sub(pivot)
        chassisGroup.add(model.model.group)
      }
      const glow = this.glows.get(b.origKey)
      if (glow) {
        glow.position.sub(pivot)
        chassisGroup.add(glow)
        this.glows.delete(b.origKey)
      }
    }
    const extraVisuals = extraRotorSpecs.map((spec) => {
      const extraPivot = new THREE.Vector3(
        spec.motorPos[0] + 0.5, spec.motorPos[1] + 0.5, spec.motorPos[2] + 0.5,
      )
      const extraGroup = new THREE.Group()
      extraGroup.position.copy(extraPivot)
      const extraOut = newBuffers()
      const extraGlue: { x: number; y: number; z: number; mask: number }[] = []
      const extraRelMap = new Map<string, number>()
      for (const block of spec.blocks) extraRelMap.set(posKey(...block.rel), block.id)
      for (const block of spec.blocks) {
        const [rx, ry, rz] = block.rel
        if (isOpaque(block.id)) {
          const powered = block.id === B.LED && this.world.poweredLeds.has(block.origKey)
          emitCube(extraOut, rx - 0.5, ry - 0.5, rz - 0.5, block.id, powered, (dx, dy, dz) =>
            isOpaque(extraRelMap.get(posKey(rx + dx, ry + dy, rz + dz)) ?? 0),
            block.state?.color,
          )
        }
        if (block.state?.glue) extraGlue.push({ x: rx - 0.5, y: ry - 0.5, z: rz - 0.5, mask: block.state.glue })
        const model = this.models.get(block.origKey)
        if (model) {
          model.model.group.position.sub(extraPivot)
          extraGroup.add(model.model.group)
        }
        const glow = this.glows.get(block.origKey)
        if (glow) {
          glow.position.sub(extraPivot)
          extraGroup.add(glow)
          this.glows.delete(block.origKey)
        }
      }
      if (extraOut.indices.length) extraGroup.add(new THREE.Mesh(buffersToGeometry(extraOut), this.blockMaterial))
      if (extraGlue.length) {
        const glue = new THREE.Mesh(buildGlueGeometry(extraGlue), this.glueMaterial)
        glue.renderOrder = 2
        extraGroup.add(glue)
      }
      const wireEnds: ExtraRotor['wireEnds'] = []
      for (const wire of this.wires) {
        if (spec.byKey.has(wire.a)) wireEnds.push({ wire, end: 'a', local: wire.pa.clone().sub(extraPivot), orig: wire.pa.clone() })
        if (spec.byKey.has(wire.b)) wireEnds.push({ wire, end: 'b', local: wire.pb.clone().sub(extraPivot), orig: wire.pb.clone() })
      }
      return { ...spec, pivot: extraPivot, group: extraGroup, wireEnds }
    })

    const motorModel = this.models.get(motorKey)
    if (motorModel?.type === 'motor' || motorModel?.type === 'servo') {
      motorModel.model.group.position.sub(pivot)
      chassisGroup.add(motorModel.model.group)
    }
    if (chassisOut.indices.length) chassisGroup.add(new THREE.Mesh(buffersToGeometry(chassisOut), this.blockMaterial))
    if (chassisGlue.length) {
      const gm = new THREE.Mesh(buildGlueGeometry(chassisGlue), this.glueMaterial)
      gm.renderOrder = 2
      chassisGroup.add(gm)
    }

    const wireEnds: Contraption['wireEnds'] = []
    const chassisWireEnds: Contraption['chassisWireEnds'] = []
    const chassisKeys = new Set<string>([motorKey, ...chassisByKey.keys()])
    for (const wire of this.wires) {
      if (byKey.has(wire.a)) wireEnds.push({ wire, end: 'a', local: wire.pa.clone().sub(pivot), orig: wire.pa.clone() })
      if (byKey.has(wire.b)) wireEnds.push({ wire, end: 'b', local: wire.pb.clone().sub(pivot), orig: wire.pb.clone() })
      if (chassisKeys.has(wire.a)) chassisWireEnds.push({ wire, end: 'a', local: wire.pa.clone().sub(pivot), orig: wire.pa.clone() })
      if (chassisKeys.has(wire.b)) chassisWireEnds.push({ wire, end: 'b', local: wire.pb.clone().sub(pivot), orig: wire.pb.clone() })
    }

    const chassisVoxels = [
      { x: mx, y: my, z: mz, id: actuatorId, state: motorState },
      ...chassisBlocks.map((b) => ({ x: mx + b.rel[0], y: my + b.rel[1], z: mz + b.rel[2], id: b.id, state: b.state })),
    ]
    const rotorVoxels = blocks.map((b) => ({ x: mx + b.rel[0], y: my + b.rel[1], z: mz + b.rel[2], id: b.id, state: b.state }))
    const chassisBody = this.rigidPhysics.createRigidBody(chassisVoxels, pivot, {
      // Leave all rotation axes free: the physical mass distribution, contact
      // friction and motor reaction torque decide whether the robot yaws or tips.
      canSleep: false, linearDamping: 0.035, angularDamping: 0.015,
    })
    const rotorAxis = new THREE.Vector3(d[0], d[1], d[2])
    const rotorBody = wheelOnlyRotor
      ? this.rigidPhysics.createWheelRotorBody(pivot, rotorAxis)
      : this.rigidPhysics.createRigidBody(rotorVoxels, pivot, {
        canSleep: false, linearDamping: 0.025, angularDamping: 0.015,
      })
    if (!chassisBody || !rotorBody) {
      if (chassisBody) this.rigidPhysics.removeRigidBody(chassisBody)
      if (rotorBody) this.rigidPhysics.removeRigidBody(rotorBody)
      this.mechDirty = true
      return 'idle'
    }
    const parentAnchor = rotorAxis.clone().multiplyScalar(0.36)
    const childAnchor = wheelOnlyRotor ? new THREE.Vector3() : rotorAxis.clone().multiplyScalar(0.36)
    const joint = this.rigidPhysics.createRevoluteJoint(
      chassisBody, rotorBody, rotorAxis, parentAnchor, childAnchor,
    )
    if (joint) {
      joint.configureMotorModel(RAPIER.MotorModel.ForceBased)
      joint.setMotorMaxForce(isServo ? SERVO_MAX_TORQUE_NM : MOTOR_COAST_TORQUE_NM)
      if (isServo) joint.setLimits(0, SERVO_MAX_ANGLE_RAD)
    }
    if (!joint) {
      this.rigidPhysics.removeRigidBody(chassisBody)
      this.rigidPhysics.removeRigidBody(rotorBody)
      this.mechDirty = true
      return 'idle'
    }

    const extraRotors: ExtraRotor[] = []
    for (const visual of extraVisuals) {
      const extraVoxels = visual.blocks.map((block) => ({
        x: visual.motorPos[0] + block.rel[0],
        y: visual.motorPos[1] + block.rel[1],
        z: visual.motorPos[2] + block.rel[2],
        id: block.id,
        state: block.state,
      }))
      const extraBody = visual.wheelOnly
        ? this.rigidPhysics.createWheelRotorBody(visual.pivot, visual.axis)
        : this.rigidPhysics.createRigidBody(extraVoxels, visual.pivot, {
          canSleep: false, linearDamping: 0.025, angularDamping: 0.015,
        })
      if (!extraBody) {
        for (const extra of extraRotors) {
          this.rigidPhysics.removeRigidBody(extra.rotorBody)
          disposeObject(extra.group)
        }
        this.rigidPhysics.removeRigidBody(chassisBody)
        this.rigidPhysics.removeRigidBody(rotorBody)
        this.mechDirty = true
        return 'idle'
      }
      const extraParentAnchor = new THREE.Vector3(...visual.motorOffset)
        .addScaledVector(visual.axis, 0.36)
      const extraChildAnchor = visual.wheelOnly
        ? new THREE.Vector3()
        : visual.axis.clone().multiplyScalar(0.36)
      const extraJoint = this.rigidPhysics.createRevoluteJoint(
        chassisBody,
        extraBody,
        visual.axis,
        extraParentAnchor,
        extraChildAnchor,
      )
      if (extraJoint) {
        extraJoint.configureMotorModel(RAPIER.MotorModel.ForceBased)
        extraJoint.setMotorMaxForce(MOTOR_COAST_TORQUE_NM)
      }
      if (!extraJoint) {
        this.rigidPhysics.removeRigidBody(extraBody)
        for (const extra of extraRotors) {
          this.rigidPhysics.removeRigidBody(extra.rotorBody)
          disposeObject(extra.group)
        }
        this.rigidPhysics.removeRigidBody(chassisBody)
        this.rigidPhysics.removeRigidBody(rotorBody)
        this.mechDirty = true
        return 'idle'
      }
      extraRotors.push({
        motorKey: visual.motorKey,
        motorPos: visual.motorPos,
        motorOffset: visual.motorOffset,
        motorState: visual.motorState,
        axis: visual.axis,
        facing: visual.facing,
        blocks: visual.blocks,
        byKey: visual.byKey,
        wheelOnly: visual.wheelOnly,
        group: visual.group,
        rotorBody: extraBody,
        joint: extraJoint,
        unpoweredTime: 0,
        angle: 0,
        speed: 0,
        wireEnds: visual.wireEnds,
      })
    }

    // Remove every dynamic rotor and the shared chassis from the voxel grid.

    this.suppress = true
    for (const b of blocks) {
      const [x, y, z] = parseKey(b.origKey)
      this.world.setBlock(x, y, z, B.AIR)
    }
    for (const b of chassisBlocks) {
      const [x, y, z] = parseKey(b.origKey)
      this.world.setBlock(x, y, z, B.AIR)
    }
    for (const extra of extraRotors) for (const b of extra.blocks) {
      const [x, y, z] = parseKey(b.origKey)
      this.world.setBlock(x, y, z, B.AIR)
    }
    this.world.setBlock(mx, my, mz, B.AIR)
    this.suppress = false
    this.rebuildGlue()
    this.scene.add(chassisGroup)
    this.scene.add(group)
    for (const extra of extraRotors) this.scene.add(extra.group)

    this.contraptions.set(motorKey, {
      motorKey,
      actuatorId,
      motorPos: [mx, my, mz],
      motorState: motorState ? { ...motorState } : undefined,
      axis: new THREE.Vector3(d[0], d[1], d[2]),
      facing,
      blocks,
      chassisBlocks,
      chassisByKey,
      byKey,
      chassisGroup,
      chassisBody,
      rotorBody,
      joint,
      chassisWireEnds,
      unpoweredTime: 0,
      disassemblyRetryCooldown: 0,
      group,
      angle: 0,
      speed: 0,
      wireEnds,
      extraRotors,
    })
    this.physicsDirty = true
    this.powerDirty = true
    return 'driving'
  }

  private disassemble(c: Contraption, quarterTurns: number): Map<string, string> | null {
    const rotorTranslation = c.rotorBody.translation()
    const chassisTranslation = c.chassisBody.translation()
    const rotorPivot = new THREE.Vector3(rotorTranslation.x, rotorTranslation.y, rotorTranslation.z)
    const chassisPivot = new THREE.Vector3(chassisTranslation.x, chassisTranslation.y, chassisTranslation.z)
    const chassisRotation = c.chassisBody.rotation()
    const chassisActualQ = new THREE.Quaternion(chassisRotation.x, chassisRotation.y, chassisRotation.z, chassisRotation.w)
    const chassisEuler = new THREE.Euler().setFromQuaternion(chassisActualQ, 'YXZ')
    const chassisTurns = ((Math.round(chassisEuler.y / HALF_PI) % 4) + 4) % 4
    const chassisQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), chassisTurns * HALF_PI)
    // Compose chassis yaw with the rotor's local quarter-turn before snapping grid positions.
    const q = chassisQ.clone().multiply(new THREE.Quaternion().setFromAxisAngle(c.axis, quarterTurns * HALF_PI))
    const rotateDirection = (dir: number, rotation: THREE.Quaternion) => {
      const v = new THREE.Vector3(...DIRS[dir]).applyQuaternion(rotation)
      const r = [Math.round(v.x), Math.round(v.y), Math.round(v.z)]
      return DIRS.findIndex((d) => d[0] === r[0] && d[1] === r[1] && d[2] === r[2])
    }
    const rotatedState = (source?: BlockState, rotation = q) => {
      if (!source) return undefined
      const state: BlockState = { ...source }
      if (state.facing !== undefined) state.facing = rotateDirection(state.facing, rotation)
      if (state.glue) {
        let mask = 0
        for (let face = 0; face < 6; face++) {
          if (state.glue & (1 << face)) {
            const rotated = rotateDirection(face, rotation)
            if (rotated >= 0) mask |= 1 << rotated
          }
        }
        state.glue = mask
      }
      return Object.keys(state).length ? state : undefined
    }

    const placements: { x: number; y: number; z: number; id: number; state?: BlockState; orig: string }[] = []
    const extraPoses = (c.extraRotors ?? []).map((extra) => {
      const t = extra.rotorBody.translation()
      const pivot = new THREE.Vector3(t.x, t.y, t.z)
      const turns = ((Math.round(extra.angle / HALF_PI) % 4) + 4) % 4
      const rotation = chassisQ.clone().multiply(
        new THREE.Quaternion().setFromAxisAngle(extra.axis, turns * HALF_PI),
      )
      return { extra, pivot, rotation }
    })
    const pushPlacement = (rel: [number, number, number], pivot: THREE.Vector3, rotation: THREE.Quaternion, id: number, state: BlockState | undefined, orig: string) => {
      const center = new THREE.Vector3(...rel).applyQuaternion(rotation).add(pivot)
      placements.push({
        x: Math.round(center.x - 0.5), y: Math.round(center.y - 0.5), z: Math.round(center.z - 0.5),
        id, state: rotatedState(state, rotation), orig,
      })
    }
    for (const b of c.blocks) pushPlacement(b.rel, rotorPivot, q, b.id, b.state, b.origKey)
    for (const b of c.chassisBlocks) pushPlacement(b.rel, chassisPivot, chassisQ, b.id, b.state, b.origKey)
    pushPlacement([0, 0, 0], chassisPivot, chassisQ, c.actuatorId, c.motorState, c.motorKey)
    for (const pose of extraPoses) for (const block of pose.extra.blocks) {
      pushPlacement(block.rel, pose.pivot, pose.rotation, block.id, block.state, block.origKey)
    }

    // Preserve the entire rigid assembly if snapping it back to voxel cells
    // would intersect something. Lift the whole assembly as one unit.
    const destinationKeys = new Set<string>()
    for (const p of placements) destinationKeys.add(posKey(p.x, p.y, p.z))
    if (destinationKeys.size !== placements.length) return null
    let shiftY = Math.max(0, GROUND_LEVEL - Math.min(...placements.map((p) => p.y)))
    const fits = (offset: number) => {
      if (placements.some((p) => p.y + offset >= WORLD_HEIGHT)) return false
      return placements.every((p) => this.world.getBlock(p.x, p.y + offset, p.z) === B.AIR)
    }
    let attempts = 0
    while (!fits(shiftY) && attempts < 24) { shiftY++; attempts++ }
    if (!fits(shiftY)) {
      // Leave it as a live physics object rather than deleting blocks.
      c.chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
      c.rotorBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
      c.joint.configureMotorVelocity(0, 1)
      for (const extra of c.extraRotors ?? []) {
        extra.rotorBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
        extra.rotorBody.setAngvel({ x: 0, y: 0, z: 0 }, true)
        extra.joint.configureMotorVelocity(0, 1)
      }
      return null
    }
    for (const p of placements) p.y += shiftY

    // Detach model meshes from the groups before disposing voxel render
    // geometry, so component models remain usable after landing.
    const preserveChildren = (group: THREE.Group, keys: string[]) => {
      group.updateMatrixWorld(true)
      for (const key of keys) {
        const entry = this.models.get(key)
        if (entry && entry.model.group.parent === group) {
          const pos = entry.model.group.getWorldPosition(new THREE.Vector3())
          const rot = entry.model.group.getWorldQuaternion(new THREE.Quaternion())
          group.remove(entry.model.group)
          this.scene.add(entry.model.group)
          entry.model.group.position.copy(pos)
          entry.model.group.quaternion.copy(rot)
        }
        const glow = this.glows.get(key)
        if (glow && glow.parent === group) {
          const pos = glow.getWorldPosition(new THREE.Vector3())
          group.remove(glow)
          this.scene.add(glow)
          glow.position.copy(pos)
        }
      }
    }
    preserveChildren(c.group, c.blocks.map((b) => b.origKey))
    preserveChildren(c.chassisGroup, [c.motorKey, ...c.chassisBlocks.map((b) => b.origKey)])
    for (const extra of c.extraRotors ?? []) preserveChildren(extra.group, extra.blocks.map((b) => b.origKey))
    disposeObject(c.group)
    disposeObject(c.chassisGroup)
    for (const extra of c.extraRotors ?? []) {
      disposeObject(extra.group)
      this.rigidPhysics.removeRigidBody(extra.rotorBody)
    }
    this.rigidPhysics.removeRigidBody(c.rotorBody)
    this.rigidPhysics.removeRigidBody(c.chassisBody)
    this.contraptions.delete(c.motorKey)

    const keyMap = new Map<string, string>()
    this.suppress = true
    for (const p of placements) {
      const newKey = posKey(p.x, p.y, p.z)
      this.world.setBlock(p.x, p.y, p.z, p.id, p.state)
      keyMap.set(p.orig, newKey)
    }
    this.suppress = false

    // Re-key and snap every model to its final voxel anchor. A body's world
    // pose is not the same as the final restored block's grid pose.
    for (const [oldKey, newKey] of keyMap) {
      const entry = this.models.get(oldKey)
      if (entry) {
        this.models.delete(oldKey)
        this.models.set(newKey, entry)
        this.snapModelToGrid(entry, newKey, true)
      }
      const mounted = this.mountedWheels.get(oldKey)
      if (mounted) { this.mountedWheels.delete(oldKey); this.mountedWheels.set(newKey, mounted) }
      const [x, y, z] = parseKey(newKey)
      const glow = this.glows.get(oldKey)
      if (glow) {
        this.glows.delete(oldKey)
        glow.position.set(x + 0.5, y + 0.5, z + 0.5)
        this.glows.set(newKey, glow)
      }
    }

    for (const we of c.wireEnds) {
      const key = we.end === 'a' ? we.wire.a : we.wire.b
      const newKey = keyMap.get(key)
      if (newKey) {
        const point = we.local.clone().applyQuaternion(q).add(rotorPivot).add(new THREE.Vector3(0, shiftY, 0))
        if (we.end === 'a') { we.wire.a = newKey; we.wire.pa.copy(point) }
        else { we.wire.b = newKey; we.wire.pb.copy(point) }
      }
    }
    for (const we of c.chassisWireEnds) {
      const key = we.end === 'a' ? we.wire.a : we.wire.b
      const newKey = keyMap.get(key)
      if (newKey) {
        const point = we.local.clone().applyQuaternion(chassisQ).add(chassisPivot).add(new THREE.Vector3(0, shiftY, 0))
        if (we.end === 'a') { we.wire.a = newKey; we.wire.pa.copy(point) }
        else { we.wire.b = newKey; we.wire.pb.copy(point) }
      }
    }
    for (const pose of extraPoses) for (const we of pose.extra.wireEnds) {
      const key = we.end === 'a' ? we.wire.a : we.wire.b
      const newKey = keyMap.get(key)
      if (newKey) {
        const point = we.local.clone().applyQuaternion(pose.rotation).add(pose.pivot).add(new THREE.Vector3(0, shiftY, 0))
        if (we.end === 'a') { we.wire.a = newKey; we.wire.pa.copy(point) }
        else { we.wire.b = newKey; we.wire.pb.copy(point) }
      }
    }
    for (const wire of this.wires) updateWireMesh(wire.mesh, wire.pa, wire.pb, wire.color)
    this.rebuildGlue()
    this.powerDirty = true
    this.mechDirty = true
    this.physicsDirty = true
    if (this.networkAuthority && this.networkBlockPublisher) {
      const destinationKeys = new Set(placements.map((p) => posKey(p.x, p.y, p.z)))
      const originalKeys = new Set([c.motorKey, ...c.blocks.map((b) => b.origKey), ...c.chassisBlocks.map((b) => b.origKey), ...(c.extraRotors ?? []).flatMap((extra) => extra.blocks.map((b) => b.origKey))])
      const owners = new Map<string, string | null>()
      for (const key of originalKeys) {
        const [x, y, z] = parseKey(key)
        owners.set(key, this.networkBlockOwner?.(x, y, z) ?? null)
      }
      for (const key of originalKeys) {
        if (destinationKeys.has(key)) continue
        const [x, y, z] = parseKey(key)
        this.networkBlockPublisher(x, y, z, B.AIR)
      }
      for (const p of placements) this.networkBlockPublisher(
        p.x, p.y, p.z, p.id, p.state ? { ...p.state } : undefined, owners.get(p.orig) ?? null,
      )
    }
    return keyMap
  }

  /**
   * Rigid-body-like voxel gravity. Unsupported glued components are removed
   * from the static world and rendered as real moving meshes until they land.
   * Motion is integrated every frame, not teleported between grid cells.
   */
  /**
   * Turn a contacted static voxel (and its hot-glue-connected component) into
   * a dynamic rigid body when a moving assembly is actually driving into it.
   * Without this handoff, fixed voxel colliders are infinitely heavy and no
   * material density can make them move.
   */
  private wakeBlocksBeingPushed() {
    if (!this.rigidPhysics.ready) return
    const targetKeys = new Set<string>()
    const worldAxes = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
    ]
    const isNearObb = (
      center: THREE.Vector3,
      axes: THREE.Vector3[],
      x: number,
      y: number,
      z: number,
      margin = 0.035,
    ) => {
      const otherCenter = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5)
      const delta = otherCenter.sub(center)
      const tests = [...axes, ...worldAxes]
      for (const a of axes) {
        for (const b of worldAxes) {
          const cross = a.clone().cross(b)
          if (cross.lengthSq() > 1e-8) tests.push(cross.normalize())
        }
      }
      for (const rawAxis of tests) {
        if (rawAxis.lengthSq() < 1e-8) continue
        const axis = rawAxis.clone().normalize()
        const separation = Math.abs(delta.dot(axis))
        const movingRadius = 0.5 * axes.reduce((sum, basis) => sum + Math.abs(basis.dot(axis)), 0)
        const staticRadius = 0.5 * (Math.abs(axis.x) + Math.abs(axis.y) + Math.abs(axis.z))
        if (separation > movingRadius + staticRadius + margin) return false
      }
      return true
    }

    const inspectBody = (
      pivot: THREE.Vector3,
      rotation: THREE.Quaternion,
      linear: THREE.Vector3,
      angular: THREE.Vector3,
      blocks: { centerOffset: THREE.Vector3; key: string }[],
    ) => {
      const axes = [
        new THREE.Vector3(1, 0, 0).applyQuaternion(rotation),
        new THREE.Vector3(0, 1, 0).applyQuaternion(rotation),
        new THREE.Vector3(0, 0, 1).applyQuaternion(rotation),
      ]
      for (const block of blocks) {
        const center = block.centerOffset.clone().applyQuaternion(rotation).add(pivot)
        const surfaceVelocity = angular.clone().cross(center.clone().sub(pivot)).add(linear)
        if (surfaceVelocity.lengthSq() < 0.0025) continue
        const hx = 0.5 * (Math.abs(axes[0].x) + Math.abs(axes[1].x) + Math.abs(axes[2].x))
        const hy = 0.5 * (Math.abs(axes[0].y) + Math.abs(axes[1].y) + Math.abs(axes[2].y))
        const hz = 0.5 * (Math.abs(axes[0].z) + Math.abs(axes[1].z) + Math.abs(axes[2].z))
        const minX = Math.floor(center.x - hx - 0.55)
        const maxX = Math.floor(center.x + hx + 0.55)
        const minY = Math.floor(center.y - hy - 0.55)
        const maxY = Math.floor(center.y + hy + 0.55)
        const minZ = Math.floor(center.z - hz - 0.55)
        const maxZ = Math.floor(center.z + hz + 0.55)
        for (let y = minY; y <= maxY; y++) {
          if (y < GROUND_LEVEL || y >= WORLD_HEIGHT) continue
          for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
            const id = this.world.getBlock(x, y, z)
            if (id === B.AIR) continue
            const key = posKey(x, y, z)
            if (targetKeys.has(key) || this.fallingKeys.has(key)) continue
            const delta = new THREE.Vector3(x + 0.5 - center.x, y + 0.5 - center.y, z + 0.5 - center.z)
            // Ground-level blocks are the static foundation of the scene and
            // must never be converted into falling bodies by a rotating arm.
            // Otherwise a chassis that barely touches its support can wake the
            // support voxel, lose contact, and begin drifting through the floor.
            if (y <= GROUND_LEVEL) continue

            // Only release blocks in the direction the rotating/translating
            // voxel is moving. This avoids waking neighboring blocks the arm
            // is merely passing by.
            if (delta.lengthSq() < 1e-8 || surfaceVelocity.dot(delta) <= 0.015) continue
            // Contact candidates at diagonal corners are not reliable pushes.
            // Require the target direction to be reasonably aligned with the
            // moving voxel's surface velocity, preventing a spinning arm from
            // waking diagonal supports and causing the whole chassis to drift.
            const approachAlignment = surfaceVelocity.dot(delta) /
              Math.max(1e-8, surfaceVelocity.length() * delta.length())
            if (approachAlignment < 0.68) continue

            // A body moving down onto a block is landing on it, not pushing it
            // out of the way. Keep that support static so gravity settles the
            // machine instead of successively removing the blocks beneath it.
            const predominantlyBelow = delta.y < -Math.max(Math.abs(delta.x), Math.abs(delta.z))
            if (predominantlyBelow && surfaceVelocity.y < -0.015) continue

            if (isNearObb(center, axes, x, y, z)) targetKeys.add(key)
          }
        }
      }
    }

    for (const c of this.contraptions.values()) {
      const rotorT = c.rotorBody.translation(), rotorR = c.rotorBody.rotation()
      const rotorV = c.rotorBody.linvel(), rotorW = c.rotorBody.angvel()
      inspectBody(
        new THREE.Vector3(rotorT.x, rotorT.y, rotorT.z),
        new THREE.Quaternion(rotorR.x, rotorR.y, rotorR.z, rotorR.w),
        new THREE.Vector3(rotorV.x, rotorV.y, rotorV.z),
        new THREE.Vector3(rotorW.x, rotorW.y, rotorW.z),
        c.blocks.map((b) => ({ centerOffset: new THREE.Vector3(...b.rel), key: b.origKey })),
      )
      for (const extra of c.extraRotors ?? []) {
        const t = extra.rotorBody.translation(), r = extra.rotorBody.rotation()
        const v = extra.rotorBody.linvel(), w = extra.rotorBody.angvel()
        inspectBody(
          new THREE.Vector3(t.x, t.y, t.z),
          new THREE.Quaternion(r.x, r.y, r.z, r.w),
          new THREE.Vector3(v.x, v.y, v.z),
          new THREE.Vector3(w.x, w.y, w.z),
          extra.blocks.map((b) => ({ centerOffset: new THREE.Vector3(...b.rel), key: b.origKey })),
        )
      }
      const chassisT = c.chassisBody.translation(), chassisR = c.chassisBody.rotation()
      const chassisV = c.chassisBody.linvel(), chassisW = c.chassisBody.angvel()
      inspectBody(
        new THREE.Vector3(chassisT.x, chassisT.y, chassisT.z),
        new THREE.Quaternion(chassisR.x, chassisR.y, chassisR.z, chassisR.w),
        new THREE.Vector3(chassisV.x, chassisV.y, chassisV.z),
        new THREE.Vector3(chassisW.x, chassisW.y, chassisW.z),
        [
          { centerOffset: new THREE.Vector3(0, 0, 0), key: c.motorKey },
          ...c.chassisBlocks.map((b) => ({ centerOffset: new THREE.Vector3(...b.rel), key: b.origKey })),
        ],
      )
    }

    for (const body of this.fallingBodies) {
      const t = body.body.translation(), r = body.body.rotation()
      const v = body.body.linvel(), w = body.body.angvel()
      inspectBody(
        new THREE.Vector3(t.x, t.y, t.z),
        new THREE.Quaternion(r.x, r.y, r.z, r.w),
        new THREE.Vector3(v.x, v.y, v.z),
        new THREE.Vector3(w.x, w.y, w.z),
        body.blocks.map((b) => ({ centerOffset: b.localOrigin.clone(), key: b.originKey })),
      )
    }

    if (targetKeys.size > 0) {
      this.detectUnsupportedBodies(targetKeys)
    }
  }

  private bodyWaterSubmergedVolume(body: RAPIER.RigidBody, localCenters: readonly THREE.Vector3[]) {
    if (this.world.type !== 'beach' || localCenters.length === 0) return 0
    const translation = body.translation()
    const rotation = body.rotation()
    const quaternion = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w)
    const position = new THREE.Vector3(translation.x, translation.y, translation.z)
    let submergedVolume = 0
    for (const localCenter of localCenters) {
      const center = localCenter.clone().applyQuaternion(quaternion).add(position)
      submergedVolume += this.world.waterSubmersionAt(center.x, center.y, center.z)
    }
    return submergedVolume
  }

  private fallingBodyWaterSubmersion(body: FallingBody) {
    return this.bodyWaterSubmergedVolume(body.body, body.blocks.map((block) => block.localOrigin))
  }

  /**
   * Approximate Archimedes' principle per voxel: each submerged block displaces
   * its submerged volume of water, while the mass of the block decides whether
   * it floats, stays near neutral buoyancy, or sinks. Impulses are applied at
   * each submerged voxel centre so partially immersed assemblies can also tip.
   */
  private applyWaterForcesToBody(
    body: RAPIER.RigidBody,
    localCenters: readonly THREE.Vector3[],
    dt: number,
  ) {
    if (this.world.type !== 'beach' || localCenters.length === 0 || body.isSleeping()) return

    const translation = body.translation()
    const rotation = body.rotation()
    const quaternion = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w)
    const position = new THREE.Vector3(translation.x, translation.y, translation.z)
    const waterDensity = 1.35
    let submergedVolume = 0

    for (const localCenter of localCenters) {
      const center = localCenter.clone().applyQuaternion(quaternion).add(position)
      const fraction = this.world.waterSubmersionAt(center.x, center.y, center.z)
      if (fraction <= 0.001) continue
      submergedVolume += fraction
      const buoyancyImpulse = waterDensity * 9.81 * fraction * dt
      body.applyImpulseAtPoint(
        { x: 0, y: buoyancyImpulse, z: 0 },
        { x: center.x, y: center.y, z: center.z },
        true,
      )
    }

    if (submergedVolume <= 0) return
    const immersion = THREE.MathUtils.clamp(submergedVolume / localCenters.length, 0, 1)
    const mass = Math.max(body.mass(), 0.001)
    const velocity = body.linvel()
    // Stronger drag with deeper immersion damps sideways drift and vertical
    // bobbing without imposing a fake collision at the water surface.
    const drag = Math.min(0.95, dt * 4.5 * immersion)
    body.applyImpulse({
      x: -velocity.x * mass * drag,
      y: -velocity.y * mass * drag,
      z: -velocity.z * mass * drag,
    }, true)

    const angular = body.angvel()
    const angularDamping = Math.exp(-2.8 * immersion * dt)
    body.setAngvel({
      x: angular.x * angularDamping,
      y: angular.y * angularDamping,
      z: angular.z * angularDamping,
    }, true)
  }

  /**
   * A standalone electronic part that falls into unprotected seawater burns
   * away. For multi-block rigid assemblies, the whole body is kept intact so
   * the remaining colliders are never left inconsistent with the visuals.
   */
  private burnSubmergedStandaloneComponents() {
    if (this.world.type !== 'beach') return
    for (let i = this.fallingBodies.length - 1; i >= 0; i--) {
      const falling = this.fallingBodies[i]
      if (falling.blocks.length !== 1) continue
      const block = falling.blocks[0]
      if (!this.isWaterSensitiveComponent(block.id) || block.state?.resinCoated) continue
      const translation = falling.body.translation()
      const rotation = falling.body.rotation()
      const center = block.localOrigin.clone()
        .applyQuaternion(new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w))
        .add(new THREE.Vector3(translation.x, translation.y, translation.z))
      if (this.world.waterSubmersionAt(center.x, center.y, center.z) <= 0.01) continue

      this.rigidPhysics.removeRigidBody(falling.body)
      for (const child of [...falling.group.children]) {
        if (child instanceof THREE.Mesh) child.geometry.dispose()
      }
      this.scene.remove(falling.group)
      const key = block.originKey
      const model = this.models.get(key)
      if (model) {
        disposeObject(model.model.group)
        this.models.delete(key)
      }
      this.removeWiresAt(key)
      const glow = this.glows.get(key)
      if (glow) {
        glow.parent?.remove(glow)
        this.glows.delete(key)
      }
      this.fallingKeys.delete(key)
      this.fallingBodies.splice(i, 1)
      this.powerDirty = true
      this.mechDirty = true
      this.physicsDirty = true
    }
  }

  /** Apply liquid forces to falling voxels and the moving parts of machines. */
  private applyBeachWaterPhysics(dt: number) {
    if (this.world.type !== 'beach') return
    this.burnSubmergedStandaloneComponents()

    for (const falling of this.fallingBodies) {
      this.applyWaterForcesToBody(
        falling.body,
        falling.blocks.map((block) => block.localOrigin),
        dt,
      )
    }

    // Motors, servos, and their attached builds are also rigid bodies. Treat
    // each voxel as displaced volume so a robot can float unevenly or tip.
    for (const machine of this.contraptions.values()) {
      const rotorCenters = machine.blocks.map((block) => new THREE.Vector3(...block.rel))
      this.applyWaterForcesToBody(
        machine.rotorBody,
        rotorCenters.length ? rotorCenters : [new THREE.Vector3()],
        dt,
      )
      const chassisCenters = [
        new THREE.Vector3(),
        ...machine.chassisBlocks.map((block) => new THREE.Vector3(...block.rel)),
      ]
      this.applyWaterForcesToBody(machine.chassisBody, chassisCenters, dt)

      for (const extra of machine.extraRotors ?? []) {
        const extraCenters = extra.blocks.map((block) => new THREE.Vector3(...block.rel))
        this.applyWaterForcesToBody(
          extra.rotorBody,
          extraCenters.length ? extraCenters : [new THREE.Vector3()],
          dt,
        )
      }
    }
  }

  private updateGravity(dt: number) {
    if (!this.rigidPhysics.ready) return
    this.physicsScanCooldown -= dt
    if (this.physicsDirty && this.physicsScanCooldown <= 0) {
      this.physicsScanCooldown = 0.25
      this.physicsDirty = false
      const changedKeys = new Set(this.physicsDirtyKeys)
      this.physicsDirtyKeys.clear()
      // A block edit only affects its vertical support column and any
      // glue-connected assembly touching that column. Avoid re-scanning every
      // loaded terrain voxel after each ordinary placement.
      this.detectUnsupportedBodies(undefined, changedKeys.size ? changedKeys : undefined)
    }

    // Rapier resolves motion and contacts. A body is written back to the voxel
    // grid only after the solver has allowed it to sleep on a stable surface.
    for (let i = this.fallingBodies.length - 1; i >= 0; i--) {
      const body = this.fallingBodies[i]
      // Bodies that are in the beach water must remain Rapier bodies while
      // floating instead of being snapped back into the voxel grid.
      if (this.fallingBodyWaterSubmersion(body) > 0.01) {
        // Keep submerged/floating bodies in Rapier instead of voxel-snapping
        // them onto the old ground plane. Sleeping bodies stay editable via
        // raycastMoving and are re-gridded only when an interaction needs it.
        body.settledTime = 0
        continue
      }
      if (body.body.isSleeping()) body.settledTime += dt
      else body.settledTime = 0
      if (body.settledTime >= 0.35) {
        if (this.landBody(body)) this.fallingBodies.splice(i, 1)
        else body.settledTime = 0
      }
    }
  }

  private detectUnsupportedBodies(forceKeys?: ReadonlySet<string>, changedKeys?: ReadonlySet<string>) {
    if (!this.rigidPhysics.ready) { this.physicsDirty = true; return }
    const blocks: { key: string; x: number; y: number; z: number; id: number; state?: BlockState }[] = []
    const occupied = new Set<string>()
    const staticTerrain = new Set<string>()
    const firstY = this.world.type === 'beach'
      ? Math.floor(this.world.waterBottomY)
      : GROUND_LEVEL

    // Expand edits to the affected column, immediate neighbours, and their
    // complete glue-connected assemblies. This keeps the scan local while
    // still finding roofs, towers, and loads that lose their support.
    let scanKeys: Set<string> | null = null
    if (changedKeys?.size) {
      scanKeys = new Set<string>()
      const queue: string[] = []
      const enqueue = (x: number, y: number, z: number) => {
        if (y < firstY || y >= WORLD_HEIGHT) return
        const key = posKey(x, y, z)
        if (scanKeys!.has(key) || this.world.getBlock(x, y, z) === B.AIR) return
        scanKeys!.add(key)
        queue.push(key)
      }
      for (const key of changedKeys) {
        const [x, y, z] = parseKey(key)
        enqueue(x, y, z)
        const chunk = this.world.getChunk(Math.floor(x / 16), Math.floor(z / 16))
        const topY = Math.min(WORLD_HEIGHT - 1, chunk?.maxY ?? WORLD_HEIGHT - 1)
        for (let scanY = Math.max(firstY, y); scanY <= topY; scanY++) enqueue(x, scanY, z)
        for (const [dx, dy, dz] of DIRS) enqueue(x + dx, y + dy, z + dz)
      }
      for (let index = 0; index < queue.length; index++) {
        const key = queue[index]
        const [x, y, z] = parseKey(key)
        for (let face = 0; face < 6; face++) {
          if (!this.isGlued(x, y, z, face)) continue
          const [dx, dy, dz] = DIRS[face]
          enqueue(x + dx, y + dy, z + dz)
        }
      }
    }

    const collect = (x: number, y: number, z: number) => {
      // The beach's lower sand layers are fixed seabed, not falling voxels.
      if (y < GROUND_LEVEL && this.world.type === 'beach' &&
        !this.world.isWaterColumnAt(x + 0.5, z + 0.5)) return
      const id = this.world.getBlock(x, y, z)
      if (id === B.AIR) return
      const key = posKey(x, y, z)
      occupied.add(key)
      const state = this.world.getState(x, y, z)
      const generatedId = this.world.terrainBlockAt(x, y, z)
      // Procedural ground, roads and seabed are static supports. They do not
      // need independent Rapier bodies and must not become thousands of
      // single-block groups in the gravity solver.
      if (id === generatedId && y <= GROUND_LEVEL && !state?.glue) {
        staticTerrain.add(key)
        return
      }
      blocks.push({ key, x, y, z, id, state })
    }

    if (scanKeys) {
      for (const key of scanKeys) {
        const [x, y, z] = parseKey(key)
        collect(x, y, z)
      }
      // Include the immediate support layer beneath every candidate. This is
      // for support tests only; unchanged support blocks aren't rescanned as
      // falling candidates unless they are in the affected column or assembly.
      for (const block of blocks) {
        const belowKey = posKey(block.x, block.y - 1, block.z)
        if (this.world.getBlock(block.x, block.y - 1, block.z) !== B.AIR) occupied.add(belowKey)
      }
    } else {
      for (const chunk of this.world.chunks.values()) {
        const minX = chunk.cx * 16, minZ = chunk.cz * 16
        for (let y = firstY; y <= Math.min(WORLD_HEIGHT - 1, chunk.maxY); y++) {
          for (let z = minZ; z < minZ + 16; z++) for (let x = minX; x < minX + 16; x++) {
            collect(x, y, z)
          }
        }
      }
    }
    const byKey = new Map(blocks.map((b) => [b.key, b]))
    const visited = new Set<string>()
    const candidateGroups: typeof blocks[] = []
    const groupByKey = new Map<string, number>()
    for (const block of blocks) {
      if (visited.has(block.key) || this.fallingKeys.has(block.key)) continue
      const group: typeof blocks = []
      const queue = [block]
      visited.add(block.key)
      while (queue.length) {
        const current = queue.pop()!
        group.push(current)
        for (let face = 0; face < 6; face++) {
          if (!this.isGlued(current.x, current.y, current.z, face)) continue
          const dir = DIRS[face]
          const key = posKey(current.x + dir[0], current.y + dir[1], current.z + dir[2])
          const next = byKey.get(key)
          if (next && !visited.has(key)) { visited.add(key); queue.push(next) }
        }
      }
      const groupIndex = candidateGroups.length
      candidateGroups.push(group)
      for (const item of group) groupByKey.set(item.key, groupIndex)
    }

    // Propagate support from the actual floor upward. Merely touching another
    // voxel is not enough: that voxel must itself have a stable support path.
    // This prevents towers from falling one block at a time across scan ticks.
    const stableGroups = new Set<number>()
    let supportChanged = true
    while (supportChanged) {
      supportChanged = false
      for (let index = 0; index < candidateGroups.length; index++) {
        if (stableGroups.has(index)) continue
        const group = candidateGroups[index]
        const keys = new Set(group.map((item) => item.key))
        const supportPoints: { x: number; z: number }[] = []
        for (const item of group) {
          const floorY = this.world.type === 'beach' &&
            this.world.isWaterColumnAt(item.x + 0.5, item.z + 0.5)
            ? Math.ceil(this.world.waterBottomY)
            : GROUND_LEVEL
          if (item.y <= floorY) {
            supportPoints.push({ x: item.x + 0.5, z: item.z + 0.5 })
            continue
          }
          const belowKey = posKey(item.x, item.y - 1, item.z)
          if (keys.has(belowKey)) continue
          const belowId = this.world.getBlock(item.x, item.y - 1, item.z)
          if (belowId === B.AIR) continue
          const belowGroup = groupByKey.get(belowKey)
          // Blocks outside a targeted scan (and static procedural terrain)
          // are unchanged supports. A scanned neighbouring assembly must first
          // be proven stable before it can support this group.
          if (belowGroup === undefined || stableGroups.has(belowGroup)) {
            supportPoints.push({ x: item.x + 0.5, z: item.z + 0.5 })
          }
        }

        // A cantilever can touch a pillar and still tip over. Approximate the
        // support polygon by its footprint bounds and require the assembly's
        // mass-weighted centre of mass to remain above that footprint.
        if (supportPoints.length) {
          let totalMass = 0, centerX = 0, centerZ = 0
          for (const item of group) {
            const mass = blockMass(item.id, item.state)
            totalMass += mass
            centerX += (item.x + 0.5) * mass
            centerZ += (item.z + 0.5) * mass
          }
          centerX /= Math.max(totalMass, 1e-8)
          centerZ /= Math.max(totalMass, 1e-8)
          const minX = Math.min(...supportPoints.map((point) => point.x)) - 0.5
          const maxX = Math.max(...supportPoints.map((point) => point.x)) + 0.5
          const minZ = Math.min(...supportPoints.map((point) => point.z)) - 0.5
          const maxZ = Math.max(...supportPoints.map((point) => point.z)) + 0.5
          if (centerX >= minX - 0.03 && centerX <= maxX + 0.03 &&
              centerZ >= minZ - 0.03 && centerZ <= maxZ + 0.03) {
            stableGroups.add(index)
            supportChanged = true
          }
        }
      }
    }

    const fallingGroups: typeof blocks[] = []
    for (let index = 0; index < candidateGroups.length; index++) {
      const group = candidateGroups[index]
      // A connected glue component is one rigid body. Unsupported stacks are
      // released in the same scan, instead of waiting for each lower voxel to
      // land or for the next 250 ms physics scan.
      if (!stableGroups.has(index) || group.some((item) => forceKeys?.has(item.key))) {
        fallingGroups.push(group)
      }
    }

    for (const blocksInGroup of fallingGroups) {
      const pivot = new THREE.Vector3()
      for (const b of blocksInGroup) pivot.add(new THREE.Vector3(b.x + 0.5, b.y + 0.5, b.z + 0.5))
      pivot.multiplyScalar(1 / blocksInGroup.length)
      const physicsBody = this.rigidPhysics.createRigidBody(
        blocksInGroup.map((b) => ({ x: b.x, y: b.y, z: b.z, id: b.id, state: b.state })),
        pivot,
        { canSleep: true, linearDamping: 0.04, angularDamping: 0.08 },
      )
      if (!physicsBody) { this.physicsDirty = true; continue }

      const group = new THREE.Group()
      group.position.copy(pivot)
      const falling: FallingBlock[] = []
      const keys = new Set(blocksInGroup.map((b) => b.key))
      for (const b of blocksInGroup) {
        const buffers = newBuffers()
        emitCube(buffers, -0.5, -0.5, -0.5, b.id, false, () => false, b.state?.resinCoated ? '#e5c46a' : b.state?.color)
        const mesh = new THREE.Mesh(buffersToGeometry(buffers), this.blockMaterial)
        mesh.position.set(b.x + 0.5 - pivot.x, b.y + 0.5 - pivot.y, b.z + 0.5 - pivot.z)
        mesh.castShadow = true
        mesh.receiveShadow = true
        group.add(mesh)
        falling.push({
          id: b.id, state: b.state ? { ...b.state } : undefined,
          x: b.x, y: b.y, z: b.z, originKey: b.key,
          localOrigin: new THREE.Vector3(b.x + 0.5 - pivot.x, b.y + 0.5 - pivot.y, b.z + 0.5 - pivot.z),
          mesh,
        })
        const model = this.models.get(b.key)
        if (model) {
          model.model.group.position.sub(pivot)
          group.add(model.model.group)
        }
        const glow = this.glows.get(b.key)
        if (glow) {
          glow.position.sub(pivot)
          group.add(glow)
        }
        this.fallingKeys.add(b.key)
      }
      const wireEnds: FallingBody['wireEnds'] = []
      for (const wire of this.wires) {
        if (keys.has(wire.a)) wireEnds.push({ wire, end: 'a', local: wire.pa.clone().sub(pivot), orig: wire.pa.clone() })
        if (keys.has(wire.b)) wireEnds.push({ wire, end: 'b', local: wire.pb.clone().sub(pivot), orig: wire.pb.clone() })
      }
      this.suppress = true
      for (const b of blocksInGroup) this.world.setBlock(b.x, b.y, b.z, B.AIR)
      this.suppress = false
      this.scene.add(group)
      this.fallingBodies.push({ blocks: falling, body: physicsBody, group, pivot, wireEnds, settledTime: 0 })
    }
    if (fallingGroups.length) {
      this.rebuildGlue()
      this.powerDirty = true
      this.mechDirty = true
    }
  }

  private landBody(body: FallingBody): Map<string, string> | null {
    const translation = body.body.translation()
    const rotation = body.body.rotation()
    const pivot = new THREE.Vector3(translation.x, translation.y, translation.z)
    const q = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w)
    const rotateDirection = (dir: number) => {
      const v = new THREE.Vector3(...DIRS[dir]).applyQuaternion(q)
      const r = [Math.round(v.x), Math.round(v.y), Math.round(v.z)]
      return DIRS.findIndex((d) => d[0] === r[0] && d[1] === r[1] && d[2] === r[2])
    }
    const placements = body.blocks.map((b) => {
      const center = b.localOrigin.clone().applyQuaternion(q).add(pivot)
      const state: BlockState | undefined = b.state ? { ...b.state } : undefined
      if (state?.facing !== undefined) state.facing = rotateDirection(state.facing)
      if (state?.glue) {
        let mask = 0
        for (let face = 0; face < 6; face++) if (state.glue & (1 << face)) {
          const rotated = rotateDirection(face)
          if (rotated >= 0) mask |= 1 << rotated
        }
        state.glue = mask
      }
      return {
        x: Math.round(center.x - 0.5),
        y: Math.round(center.y - 0.5),
        z: Math.round(center.z - 0.5),
        id: b.id,
        state: state && Object.keys(state).length ? state : undefined,
        orig: b.originKey,
      }
    })

    const keys = new Set(placements.map((p) => posKey(p.x, p.y, p.z)))
    if (keys.size !== placements.length) return null
    const minimumYAt = (x: number, z: number) => {
      if (this.world.type !== 'beach') return GROUND_LEVEL
      const centerX = x + 0.5
      const centerZ = z + 0.5
      if (this.world.isWaterColumnAt(centerX, centerZ)) return Math.ceil(this.world.waterBottomY)
      const insideOceanBounds = centerX >= -64 && centerX < 64 && centerZ >= -64 && centerZ < 64
      return insideOceanBounds ? GROUND_LEVEL : 0
    }
    let shiftY = Math.max(0, ...placements.map((p) => minimumYAt(p.x, p.z) - p.y))
    const fits = (offset: number) => placements.every((p) =>
      p.y + offset >= 0 && p.y + offset < WORLD_HEIGHT &&
      this.world.getBlock(p.x, p.y + offset, p.z) === B.AIR)
    let attempts = 0
    while (!fits(shiftY) && attempts < 24) { shiftY++; attempts++ }
    if (!fits(shiftY)) return null
    for (const p of placements) p.y += shiftY

    body.group.updateMatrixWorld(true)
    for (const b of body.blocks) {
      const model = this.models.get(b.originKey)
      if (model && model.model.group.parent === body.group) {
        const pos = model.model.group.getWorldPosition(new THREE.Vector3())
        const rot = model.model.group.getWorldQuaternion(new THREE.Quaternion())
        body.group.remove(model.model.group)
        this.scene.add(model.model.group)
        model.model.group.position.copy(pos)
        model.model.group.quaternion.copy(rot)
      }
      const glow = this.glows.get(b.originKey)
      if (glow && glow.parent === body.group) {
        const pos = glow.getWorldPosition(new THREE.Vector3())
        body.group.remove(glow)
        this.scene.add(glow)
        glow.position.copy(pos)
      }
      this.fallingKeys.delete(b.originKey)
      b.mesh.geometry.dispose()
      body.group.remove(b.mesh)
    }
    body.group.removeFromParent()
    this.rigidPhysics.removeRigidBody(body.body)
    this.suppress = true
    const keyMap = new Map<string, string>()
    for (const p of placements) {
      const key = posKey(p.x, p.y, p.z)
      this.world.setBlock(p.x, p.y, p.z, p.id, p.state)
      keyMap.set(p.orig, key)
    }
    this.suppress = false

    for (const [oldKey, newKey] of keyMap) {
      const entry = this.models.get(oldKey)
      if (entry) {
        this.models.delete(oldKey)
        this.models.set(newKey, entry)
        this.snapModelToGrid(entry, newKey, false)
      }
      const mounted = this.mountedWheels.get(oldKey)
      if (mounted) { this.mountedWheels.delete(oldKey); this.mountedWheels.set(newKey, mounted) }
      const glow = this.glows.get(oldKey)
      if (glow) { this.glows.delete(oldKey); this.glows.set(newKey, glow) }
    }
    for (const we of body.wireEnds) {
      const currentKey = we.end === 'a' ? we.wire.a : we.wire.b
      const newKey = keyMap.get(currentKey)
      if (!newKey) continue
      const point = we.local.clone().applyQuaternion(q).add(pivot).add(new THREE.Vector3(0, shiftY, 0))
      if (we.end === 'a') { we.wire.a = newKey; we.wire.pa.copy(point) }
      else { we.wire.b = newKey; we.wire.pb.copy(point) }
    }
    for (const wire of this.wires) updateWireMesh(wire.mesh, wire.pa, wire.pb, wire.color)
    disposeObject(body.group)
    this.rebuildGlue()
    this.powerDirty = true
    this.mechDirty = true
    this.physicsDirty = true
    if (this.networkAuthority && this.networkBlockPublisher) {
      const placedKeys = new Set(placements.map((p) => posKey(p.x, p.y, p.z)))
      const owners = new Map<string, string | null>()
      for (const block of body.blocks) {
        const [x, y, z] = parseKey(block.originKey)
        owners.set(block.originKey, this.networkBlockOwner?.(x, y, z) ?? null)
      }
      for (const block of body.blocks) {
        if (placedKeys.has(block.originKey)) continue
        const [x, y, z] = parseKey(block.originKey)
        this.networkBlockPublisher(x, y, z, B.AIR)
      }
      for (const p of placements) this.networkBlockPublisher(
        p.x, p.y, p.z, p.id, p.state ? { ...p.state } : undefined, owners.get(p.orig) ?? null,
      )
    }
    return keyMap
  }

  /** Apply tyre forces at the contact patch, including rolling slip and lateral grip. */
  /** Apply tyre impulses at each fixed solver step, with grip and load transfer. */
  private applyMountedWheelTraction(c: Contraption, fixedDt: number) {
    type WheelContact = {
      axis: THREE.Vector3
      drive: THREE.Vector3
      lateral: THREE.Vector3
      rotorBody: RAPIER.RigidBody
      point: THREE.Vector3
      gap: number
      surfaceSpeed: number
      friction: number
    }
    const hasPrimaryWheel = Boolean(c.motorState?.mountedWheel) || this.mountedWheels.has(c.motorKey)
    const wheels: { axisLocal: THREE.Vector3; offsetLocal: THREE.Vector3; rotorBody: RAPIER.RigidBody }[] = []
    if (hasPrimaryWheel) {
      wheels.push({ axisLocal: c.axis.clone(), offsetLocal: c.axis.clone().multiplyScalar(0.36), rotorBody: c.rotorBody })
    }
    for (const block of c.chassisBlocks ?? []) {
      if (block.id !== B.MOTOR || !block.state?.mountedWheel) continue
      const rotor = c.extraRotors.find((candidate) => candidate.motorKey === block.origKey)
      if (!rotor) continue
      const axis = new THREE.Vector3(...DIRS[rotor.facing])
      wheels.push({ axisLocal: axis, offsetLocal: new THREE.Vector3(...block.rel).addScaledVector(axis, 0.36), rotorBody: rotor.rotorBody })
    }
    if (wheels.length === 0) return

    const translation = c.chassisBody.translation()
    const rotationRaw = c.chassisBody.rotation()
    const chassisPosition = new THREE.Vector3(translation.x, translation.y, translation.z)
    const rotation = new THREE.Quaternion(rotationRaw.x, rotationRaw.y, rotationRaw.z, rotationRaw.w)
    const up = new THREE.Vector3(0, 1, 0)
    const radius = 0.49
    const contacts: WheelContact[] = []

    for (const wheel of wheels) {
      const axle = wheel.axisLocal.clone().applyQuaternion(rotation).normalize()
      if (Math.hypot(axle.x, axle.z) < 0.65) continue
      const drive = axle.clone().cross(up)
      drive.y = 0
      if (drive.lengthSq() < 1e-8) continue
      drive.normalize()
      const lateral = axle.clone()
      lateral.y = 0
      if (lateral.lengthSq() < 1e-8) continue
      lateral.normalize()

      const center = chassisPosition.clone().add(wheel.offsetLocal.clone().applyQuaternion(rotation))
      const down = new THREE.Vector3(0, -1, 0).addScaledVector(axle, axle.y)
      const verticalReach = down.length()
      if (verticalReach < 0.1) continue
      down.normalize()
      const contactPoint = center.clone().addScaledVector(down, radius)
      const bottomY = center.y - radius * verticalReach
      const cellX = Math.floor(contactPoint.x)
      const cellZ = Math.floor(contactPoint.z)
      let supportY = GROUND_LEVEL
      let supportBlockId: number = B.WOOD
      for (let y = Math.min(WORLD_HEIGHT - 1, Math.floor(bottomY + 0.24)); y >= GROUND_LEVEL - 1; y--) {
        const candidateId = this.world.getBlock(cellX, y, cellZ)
        if (candidateId !== B.AIR) { supportY = y + 1; supportBlockId = candidateId; break }
      }
      const gap = bottomY - supportY
      if (gap > 0.2 || gap < -0.35) continue

      const rotorAngular = wheel.rotorBody.angvel()
      const chassisAngular = c.chassisBody.angvel()
      const relativeSpin = new THREE.Vector3(
        rotorAngular.x - chassisAngular.x,
        rotorAngular.y - chassisAngular.y,
        rotorAngular.z - chassisAngular.z,
      )
      const friction = THREE.MathUtils.clamp(Math.sqrt(blockFriction(B.WHEEL) * blockFriction(supportBlockId)), 0.15, 1.15)
      contacts.push({
        axis: axle, drive, lateral, rotorBody: wheel.rotorBody, point: contactPoint, gap,
        // At the bottom of a wheel, v = omega x r points opposite axle x up.
        surfaceSpeed: -relativeSpin.dot(axle) * radius, friction,
      })
    }
    if (contacts.length === 0) return

    // Use the assembled mass/COM to distribute the load; a lifted wheel can unload.
    const bodies = [c.chassisBody, c.rotorBody, ...(c.extraRotors ?? []).map((rotor) => rotor.rotorBody)]
    let totalMass = 0
    const assemblyCom = new THREE.Vector3()
    for (const body of bodies) {
      const mass = body.mass()
      if (mass <= 0) continue
      const point = body.worldCom()
      assemblyCom.addScaledVector(new THREE.Vector3(point.x, point.y, point.z), mass)
      totalMass += mass
    }
    totalMass = Math.max(0.1, totalMass)
    assemblyCom.divideScalar(totalMass)
    const normalLoadShares = estimateWheelNormalLoadShares(contacts.map((contact) => contact.point), assemblyCom)
    const chassisVelocityRaw = c.chassisBody.linvel()
    const chassisAngularRaw = c.chassisBody.angvel()
    const chassisVelocity = new THREE.Vector3(chassisVelocityRaw.x, chassisVelocityRaw.y, chassisVelocityRaw.z)
    const chassisAngular = new THREE.Vector3(chassisAngularRaw.x, chassisAngularRaw.y, chassisAngularRaw.z)
    contacts.forEach((contact, index) => {
      const staticNormalLoad = totalMass * 9.81 * normalLoadShares[index]
      const contactVelocity = chassisVelocity.clone().add(chassisAngular.clone().cross(contact.point.clone().sub(chassisPosition)))
      const normalForce = THREE.MathUtils.clamp(staticNormalLoad - contact.gap * 520 - contactVelocity.y * 34, 0, staticNormalLoad * 3)
      const maxTyreForce = normalForce * contact.friction
      const forwardSpeed = contactVelocity.dot(contact.drive)
      const lateralSpeed = contactVelocity.dot(contact.lateral)
      const longitudinalForce = THREE.MathUtils.clamp((contact.surfaceSpeed - forwardSpeed) * 24, -maxTyreForce, maxTyreForce)
      const lateralLimit = Math.sqrt(Math.max(0, maxTyreForce * maxTyreForce - longitudinalForce * longitudinalForce))
      const lateralForce = THREE.MathUtils.clamp(-lateralSpeed * 28, -lateralLimit, lateralLimit)
      const force = contact.drive.clone().multiplyScalar(longitudinalForce)
        .addScaledVector(contact.lateral, lateralForce).addScaledVector(up, normalForce)
      contact.rotorBody.applyImpulseAtPoint(
        { x: force.x * fixedDt, y: force.y * fixedDt, z: force.z * fixedDt },
        { x: contact.point.x, y: contact.point.y, z: contact.point.z }, true,
      )
    })
  }

  /* ---------------- Frame update ---------------- */

  update(dt: number) {
    if (this.rigidPhysics.ready && !this.physicsSynced) {
      this.physicsSynced = true
      this.physicsDirty = true
      this.mechDirty = true
    }
    this.waterDamageCooldown -= dt
    if (this.waterDamageCooldown <= 0) {
      this.waterDamageCooldown = 0.2
      this.burnSubmergedComponents()
    }
    this.proximityScanCooldown -= dt
    const shouldRefreshProximitySensors = this.proximityScanCooldown <= 0
    if (shouldRefreshProximitySensors) this.proximityScanCooldown = 0.1
    // Back-EMF changes as the rotor accelerates. Re-solve moving circuits a
    // few times per second so motor current and battery sag follow the motion,
    // without scanning the whole world on every render frame.
    this.circuitRefreshTimer -= dt
    const electricalMotion = [...this.contraptions.values()].some((machine) =>
      Math.abs(machine.speed) > 0.5 || (machine.extraRotors ?? []).some((rotor) => Math.abs(rotor.speed) > 0.5),
    )
    if (electricalMotion && this.circuitRefreshTimer <= 0) {
      this.circuitRefreshTimer = 0.35
      this.powerDirty = true
    }
    this.powerCooldown -= dt
    if (this.powerDirty && this.powerCooldown <= 0) {
      this.powerCooldown = 0.08
      this.powerDirty = false
      if (this.networkAuthority) {
        this.recomputePower()
        this.mechDirty = true
      }
    }

    if (this.mechDirty) {
      this.mechDirty = false
      for (const [key, e] of this.models) {
        if (e.type !== 'motor' && e.type !== 'servo') continue
        const extra = this.findExtraRotor(key)
        if (extra) {
          e.status = (this.motorPower.get(key) ?? 0) > 0 ? 'driving' : 'idle'
          continue
        }
        const hasGluedServoLoad = e.type === 'servo' && (() => {
          const [x, y, z] = parseKey(key)
          const facing = this.world.getState(x, y, z)?.facing ?? 2
          const [dx, dy, dz] = DIRS[facing]
          const outputId = this.world.getBlock(x + dx, y + dy, z + dz)
          return outputId !== B.AIR && outputId !== B.MOTOR && outputId !== B.SERVO
            && this.isGlued(x, y, z, facing)
        })()
        const shouldAssemble = e.type === 'servo'
          ? this.servoPowered.has(key) || hasGluedServoLoad
          : this.networkAuthority
            ? (this.motorPower.get(key) ?? 0) > 0
            : this.desiredNetworkMachines !== null
              ? this.desiredNetworkMachines.has(key)
              : (this.motorPower.get(key) ?? 0) > 0
        if (shouldAssemble && !this.contraptions.has(key)) {
          e.status = this.tryAssemble(key)
        } else if (!this.contraptions.has(key)) {
          e.status = 'idle'
        }
      }
    }

    // Assemble powered machines before scanning unsupported voxels so the
    // rotor/chassis become their articulated physics bodies first.
    if (this.networkAuthority) this.updateGravity(dt)

    for (const [key, e] of this.models) {
      if (e.type === 'wheel') {
        const [x, y, z] = parseKey(key)
        let drive = 0
        let motorFacing: number | null = null
        for (let face = 0; face < DIRS.length; face++) {
          const d = DIRS[face]
          const nx = x + d[0], ny = y + d[1], nz = z + d[2]
          const neighbor = posKey(nx, ny, nz)
          if (this.world.getBlock(nx, ny, nz) !== B.MOTOR) continue
          const facing = this.world.getState(nx, ny, nz)?.facing ?? 2
          // A standalone wheel responds only to a motor pointing at it.
          if (facing !== OPPOSITE[face]) continue
          motorFacing = facing
          const power = this.motorPower.get(neighbor) ?? 0
          if (power > 0) drive = (this.motorDirection.get(neighbor) ?? 1) * power
          break
        }
        if (motorFacing !== null) e.model.group.quaternion.copy(facingQuaternion(motorFacing))
        if (this.networkAuthority || this.desiredNetworkMachines !== null) e.spin += drive * dt * 5
        e.model.rim.rotation.z = e.spin
        continue
      }
      if (e.type === 'servo') {
        if (!this.contraptions.has(key)) {
          const state = this.getServoState(key)
          const programmed = this.programmedServoAngles.get(key)?.degrees
          const degrees = programmed ?? (this.servoPowered.has(key) ? state?.servoOnAngle ?? 90 : state?.servoOffAngle ?? 0)
          const target = Math.min(SERVO_MAX_ANGLE_RAD, Math.max(0, Math.min(180, degrees)) * Math.PI / 180)
          const current = e.model.shaft.rotation.z
          const step = Math.max(-4 * dt, Math.min(4 * dt, target - current))
          e.model.shaft.rotation.z = current + step
          e.status = Math.abs(target - e.model.shaft.rotation.z) > 0.025 ? 'driving' : 'idle'
        }
        continue
      }
      if (e.type !== 'motor') continue
      const power = this.motorPower.get(key) ?? 0
      const c = this.contraptions.get(key)
      const extra = this.findExtraRotor(key)?.rotor
      if (extra) {
        e.model.shaft.rotation.z = extra.angle
      } else if (c) {
        e.model.shaft.rotation.z = c.angle
      } else if (power > 0 && e.status !== 'stalled') {
        if (this.networkAuthority || this.desiredNetworkMachines !== null) e.spin += power * 2.4 * dt * (this.motorDirection.get(key) ?? 1)
        e.model.shaft.rotation.z = e.spin
      }
      const mounted = this.mountedWheels.get(key)
      if (mounted) {
        // This wheel is a child of the shaft; the shaft angle already rotates
        // the whole wheel around its axle. Spinning its rim separately doubled
        // the visible rotation and could make the wheel appear disconnected.
        mounted.model.rim.rotation.z = 0
      }
    }

    if (this.networkAuthority) {
    for (const c of [...this.contraptions.values()]) {
      c.disassemblyRetryCooldown = Math.max(0, c.disassemblyRetryCooldown - dt)
      const actuator = this.models.get(c.motorKey)
      const motorAlive = actuator?.type === 'motor' || actuator?.type === 'servo'
      if (!motorAlive) {
        this.disassemble(c, Math.round(c.angle / HALF_PI) % 4)
        continue
      }
      const power = this.motorPower.get(c.motorKey) ?? 0
      const motor = this.models.get(c.motorKey)
      const direction = this.motorDirection.get(c.motorKey) ?? 1
      if (c.actuatorId === B.SERVO) {
        const programmed = this.programmedServoAngles.get(c.motorKey)?.degrees
        const targetDegrees = programmed ?? (this.servoPowered.has(c.motorKey)
          ? c.motorState?.servoOnAngle ?? 90
          : c.motorState?.servoOffAngle ?? 0)
        const requestedTarget = Math.max(0, Math.min(180, targetDegrees)) * Math.PI / 180
        const target = Math.min(requestedTarget, SERVO_MAX_ANGLE_RAD)
        // Do not command exactly PI: Rapier 0.12 has an unstable revolute-motor
        // boundary there. Also slew-limit the setpoint and keep it near the
        // measured angle, so a loaded or obstructed assembly cannot accumulate
        // an enormous position error and receive an abrupt corrective impulse.
        const currentAngle = THREE.MathUtils.clamp(c.angle, 0, SERVO_MAX_ANGLE_RAD)
        const previousCommand = THREE.MathUtils.clamp(
          c.servoCommandAngle ?? currentAngle,
          0,
          SERVO_MAX_ANGLE_RAD,
        )
        const maxStep = SERVO_TARGET_SPEED_RAD * Math.max(0, Math.min(dt, 1 / 30))
        const steppedTarget = previousCommand + THREE.MathUtils.clamp(
          target - previousCommand,
          -maxStep,
          maxStep,
        )
        const commandedTarget = THREE.MathUtils.clamp(
          steppedTarget,
          Math.max(0, currentAngle - SERVO_MAX_TRACK_ERROR_RAD),
          Math.min(SERVO_MAX_ANGLE_RAD, currentAngle + SERVO_MAX_TRACK_ERROR_RAD),
        )
        c.servoCommandAngle = commandedTarget
        const error = target - currentAngle
        c.speed = Math.max(-3.2, Math.min(3.2, error * 4.2))
        c.unpoweredTime = 0
        c.joint.setMotorMaxForce(SERVO_MAX_TORQUE_NM)
        c.joint.configureMotorPosition(commandedTarget, 18, 3)
        if (actuator?.type === 'servo') actuator.status = Math.abs(error) > 0.025 ? 'driving' : 'idle'
      } else if (power > 0) {
        const rotorOmega = c.rotorBody.angvel()
        const chassisOmega = c.chassisBody.angvel()
        const relativeOmega = Math.hypot(
          rotorOmega.x - chassisOmega.x,
          rotorOmega.y - chassisOmega.y,
          rotorOmega.z - chassisOmega.z,
        )
        const drive = motorDriveCommand(c.motorState?.motorType, power, relativeOmega)
        c.speed = drive.targetOmega * direction
        c.unpoweredTime = 0
        c.disassemblyRetryCooldown = 0
        c.joint.setMotorMaxForce(Math.max(0.00001, drive.maxTorqueNm))
        c.joint.configureMotorVelocity(c.speed, MOTOR_VELOCITY_DAMPING)
        if (motor?.type === 'motor') motor.status = 'driving'
      } else {
        c.unpoweredTime += dt
        c.joint.setMotorMaxForce(MOTOR_COAST_TORQUE_NM)
        c.joint.configureMotorVelocity(0, MOTOR_COAST_DAMPING)
        const angular = c.rotorBody.angvel()
        if (motor?.type === 'motor') motor.status = 'idle'
        const spin = Math.hypot(angular.x, angular.y, angular.z)
        const otherMotorPowered = (c.extraRotors ?? []).some((extra) => (this.motorPower.get(extra.motorKey) ?? 0) > 0)
        if (c.unpoweredTime >= 0.55 && spin < 0.65 && !otherMotorPowered && c.disassemblyRetryCooldown <= 0) {
          // disassemble() removes the rigid bodies from Rapier. Immediately skip
          // the rest of this contraption's update on success; touching its body
          // handles below causes a Rapier exception and stops the render loop.
          const restored = this.disassemble(c, ((Math.round(c.angle / HALF_PI) % 4) + 4) % 4)
          if (restored) continue
          // If its snapped voxel layout is blocked, avoid repeating the full
          // placement scan each frame while keeping the dynamic machine alive.
          c.disassemblyRetryCooldown = 2
        }
      }

      // Every secondary motor drives its own rotor against the same chassis.
      const chassisRotation = c.chassisBody.rotation()
      const chassisQ = new THREE.Quaternion(chassisRotation.x, chassisRotation.y, chassisRotation.z, chassisRotation.w)
      const chassisAngularVelocity = c.chassisBody.angvel()
      for (const extra of c.extraRotors ?? []) {
        const extraPower = this.motorPower.get(extra.motorKey) ?? 0
        const extraMotor = this.models.get(extra.motorKey)
        if (extraPower > 0) {
          const extraDirection = this.motorDirection.get(extra.motorKey) ?? 1
          const rotorOmega = extra.rotorBody.angvel()
          const relativeOmega = Math.hypot(
            rotorOmega.x - chassisAngularVelocity.x,
            rotorOmega.y - chassisAngularVelocity.y,
            rotorOmega.z - chassisAngularVelocity.z,
          )
          const drive = motorDriveCommand(extra.motorState?.motorType, extraPower, relativeOmega)
          extra.speed = drive.targetOmega * extraDirection
          extra.unpoweredTime = 0
          extra.joint.setMotorMaxForce(Math.max(0.00001, drive.maxTorqueNm))
          extra.joint.configureMotorVelocity(extra.speed, MOTOR_VELOCITY_DAMPING)
          if (extraMotor?.type === 'motor') extraMotor.status = 'driving'
        } else {
          extra.unpoweredTime += dt
          extra.joint.setMotorMaxForce(MOTOR_COAST_TORQUE_NM)
          extra.joint.configureMotorVelocity(0, MOTOR_COAST_DAMPING)
          if (extraMotor?.type === 'motor') extraMotor.status = 'idle'
        }
      }
    }

    }

    // All dynamic voxel groups and motor rotors use this one solver. No
    // rotation-specific floor correction or per-motor translation branch.
    if (this.rigidPhysics.ready) {
      if (this.networkAuthority) {
        this.wakeBlocksBeingPushed()
        this.rigidPhysics.step(dt, (fixedDt) => {
          this.applyBeachWaterPhysics(fixedDt)
          for (const contraption of this.contraptions.values()) this.applyMountedWheelTraction(contraption, fixedDt)
        })
      } else this.updateNetworkPoseInterpolation(dt)
      this.syncRigidTransforms()
    }
    // Sample after physics synchronization so moving sensors see the latest pose.
    if (shouldRefreshProximitySensors) this.refreshProximitySensors()
  }

  /** Called by the multiplayer layer when a remote block or wire changes. */
  markNetworkCircuitDirty() {
    this.powerDirty = true
    this.mechDirty = true
    this.powerCooldown = 0
  }

  /** A multiplayer client builds the same articulated visuals, but only the host advances Rapier. */
  setNetworkAuthority(isAuthority: boolean) {
    this.networkAuthority = isAuthority
    this.mechDirty = true
    this.physicsDirty = true
  }

  exportNetworkBlocks() {
    const blocks = new Map<string, { x: number; y: number; z: number; block: number; state?: BlockState }>()
    const add = (x: number, y: number, z: number, block: number, state?: BlockState) => {
      if (y < GROUND_LEVEL || y >= WORLD_HEIGHT || block === B.AIR) return
      blocks.set(posKey(x, y, z), { x, y, z, block, state: state ? { ...state } : undefined })
    }
    for (const c of this.contraptions.values()) {
      for (const b of c.blocks) {
        const [x, y, z] = parseKey(b.origKey)
        add(x, y, z, b.id, b.state)
      }
      for (const b of c.chassisBlocks) {
        const [x, y, z] = parseKey(b.origKey)
        add(x, y, z, b.id, b.state)
      }
      for (const extra of c.extraRotors ?? []) for (const b of extra.blocks) {
        const [x, y, z] = parseKey(b.origKey)
        add(x, y, z, b.id, b.state)
      }
      add(c.motorPos[0], c.motorPos[1], c.motorPos[2], B.MOTOR, c.motorState)
    }
    for (const body of this.fallingBodies) {
      for (const b of body.blocks) add(b.x, b.y, b.z, b.id, b.state)
    }
    return [...blocks.values()]
  }

  private vectorSnapshot(v: { x: number; y: number; z: number }) {
    return { x: v.x, y: v.y, z: v.z }
  }

  private rotationSnapshot(q: { x: number; y: number; z: number; w: number }) {
    return { x: q.x, y: q.y, z: q.z, w: q.w }
  }

  exportNetworkSnapshot(): Record<string, unknown> {
    const machines = [...this.contraptions.values()].slice(0, 128).map((c) => ({
      motorKey: c.motorKey,
      angle: c.angle,
      speed: c.speed,
      rotor: {
        position: this.vectorSnapshot(c.rotorBody.translation()),
        rotation: this.rotationSnapshot(c.rotorBody.rotation()),
        linearVelocity: this.vectorSnapshot(c.rotorBody.linvel()),
        angularVelocity: this.vectorSnapshot(c.rotorBody.angvel()),
      },
      chassis: {
        position: this.vectorSnapshot(c.chassisBody.translation()),
        rotation: this.rotationSnapshot(c.chassisBody.rotation()),
        linearVelocity: this.vectorSnapshot(c.chassisBody.linvel()),
        angularVelocity: this.vectorSnapshot(c.chassisBody.angvel()),
      },
      extraRotors: (c.extraRotors ?? []).map((extra) => ({
        motorKey: extra.motorKey,
        angle: extra.angle,
        speed: extra.speed,
        rotor: {
          position: this.vectorSnapshot(extra.rotorBody.translation()),
          rotation: this.rotationSnapshot(extra.rotorBody.rotation()),
          linearVelocity: this.vectorSnapshot(extra.rotorBody.linvel()),
          angularVelocity: this.vectorSnapshot(extra.rotorBody.angvel()),
        },
      })),
    }))
    const falling = this.fallingBodies.slice(0, 128).map((body) => ({
      keys: body.blocks.slice(0, 400).map((block) => ({
        originKey: block.originKey, id: block.id,
        localOrigin: this.vectorSnapshot(block.localOrigin),
      })),
      position: this.vectorSnapshot(body.body.translation()),
      rotation: this.rotationSnapshot(body.body.rotation()),
      linearVelocity: this.vectorSnapshot(body.body.linvel()),
      angularVelocity: this.vectorSnapshot(body.body.angvel()),
    }))
    const wires = this.wires.slice(0, 3000).filter((wire) => wire.networkId).map((wire) => ({
      id: wire.networkId!,
      a: wire.a, b: wire.b, ta: wire.ta, tb: wire.tb,
      pa: this.vectorSnapshot(wire.pa), pb: this.vectorSnapshot(wire.pb),
    }))
    const motorVisuals = [...this.models.entries()].flatMap(([key, entry]) => {
      if (entry.type !== 'motor') return []
      // For an assembled rotor, the visible shaft angle belongs to the
      // authoritative rigid body; entry.spin is used only before assembly.
      const machine = this.contraptions.get(key)
      const extra = this.findExtraRotor(key)?.rotor
      return [{ key, spin: machine?.angle ?? extra?.angle ?? entry.spin, status: entry.status }]
    })
    const wheelVisuals = [...this.models.entries()].flatMap(([key, entry]) => entry.type === 'wheel'
      ? [{ key, spin: entry.spin }] : [])
    const mountedWheelVisuals = [...this.mountedWheels.entries()].map(([key, entry]) => ({ key, spin: entry.spin }))
    return {
      version: 1, machines, falling, wires, motorVisuals, wheelVisuals, mountedWheelVisuals,
      motorPower: [...this.motorPower.entries()], motorDirection: [...this.motorDirection.entries()],
      poweredLeds: [...this.world.poweredLeds],
    }
  }

  applyNetworkSnapshot(value: Record<string, unknown>) {
    if (this.networkAuthority || !value || typeof value !== 'object' || Number((value as Record<string, unknown>).version) !== 1) return
    const validVector = (v: unknown): v is { x: number; y: number; z: number } =>
      !!v && typeof v === 'object' && ['x', 'y', 'z'].every(k => Number.isFinite(Number((v as Record<string, unknown>)[k])))
    const validRotation = (v: unknown): v is { x: number; y: number; z: number; w: number } =>
      !!v && typeof v === 'object' && ['x', 'y', 'z', 'w'].every(k => Number.isFinite(Number((v as Record<string, unknown>)[k])))
    const validPose = (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return null
      const v = raw as Record<string, unknown>
      if (!validVector(v.position) || !validRotation(v.rotation)) return null
      const velocity = (candidate: unknown) => validVector(candidate) ? candidate : { x: 0, y: 0, z: 0 }
      return {
        position: new THREE.Vector3(v.position.x, v.position.y, v.position.z),
        rotation: new THREE.Quaternion(v.rotation.x, v.rotation.y, v.rotation.z, v.rotation.w).normalize(),
        linearVelocity: new THREE.Vector3(velocity(v.linearVelocity).x, velocity(v.linearVelocity).y, velocity(v.linearVelocity).z),
        angularVelocity: new THREE.Vector3(velocity(v.angularVelocity).x, velocity(v.angularVelocity).y, velocity(v.angularVelocity).z),
      }
    }
    const queuePose = (key: string, body: RAPIER.RigidBody, raw: unknown) => {
      const pose = validPose(raw)
      if (!pose) return
      let target = this.networkBodyTargets.get(key)
      if (!target || target.body !== body) {
        // First state for a newly assembled body needs an exact snap to avoid
        // rendering it at the pre-assembly origin for one frame.
        body.setTranslation(pose.position, true)
        body.setRotation(pose.rotation, true)
        body.setLinvel(pose.linearVelocity, true)
        body.setAngvel(pose.angularVelocity, true)
        target = { body, ...pose, receivedAt: performance.now() }
        this.networkBodyTargets.set(key, target)
      } else {
        target.position.copy(pose.position)
        target.rotation.copy(pose.rotation)
        target.linearVelocity.copy(pose.linearVelocity)
        target.angularVelocity.copy(pose.angularVelocity)
        target.receivedAt = performance.now()
        body.setLinvel(pose.linearVelocity, true)
        body.setAngvel(pose.angularVelocity, true)
      }
    }
    const record = value as Record<string, unknown>
    const previousPowered = new Set(this.world.poweredLeds)
    if (Array.isArray(record.poweredLeds)) {
      this.world.poweredLeds.clear()
      for (const key of record.poweredLeds.slice(0, 10000)) if (typeof key === 'string' && /^-?\\d+,-?\\d+,-?\\d+$/.test(key)) this.world.poweredLeds.add(key)
      if (previousPowered.size !== this.world.poweredLeds.size || [...previousPowered].some((key) => !this.world.poweredLeds.has(key))) {
        for (const chunk of this.world.chunks.values()) chunk.dirty = true
      }
    }
    const setNumericMap = (field: string, target: Map<string, number>, min: number, max: number) => {
      const next = new Map<string, number>()
      const values = record[field]
      if (Array.isArray(values)) for (const entry of values.slice(0, 4096)) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !Number.isFinite(Number(entry[1]))) continue
        next.set(entry[0], Math.max(min, Math.min(max, Number(entry[1]))))
      }
      target.clear()
      for (const [key, number] of next) target.set(key, number)
    }
    setNumericMap('motorPower', this.motorPower, 0, 100)
    setNumericMap('motorDirection', this.motorDirection, -1, 1)
    this.powerDirty = false
    if (Array.isArray(record.motorVisuals)) for (const raw of record.motorVisuals.slice(0, 2048)) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      if (typeof item.key !== 'string') continue
      const entry = this.models.get(item.key)
      if (entry?.type !== 'motor') continue
      // A motor that belongs to an articulated machine gets its angle from the
      // machine's authoritative rigid-body snapshot below. Only standalone motor
      // shafts consume this visual angle, preventing two competing rotations.
      if (!this.contraptions.has(item.key) && !this.findExtraRotor(item.key)) {
        if (Number.isFinite(Number(item.spin))) entry.spin = Number(item.spin)
        entry.model.shaft.rotation.z = entry.spin
      }
      if (item.status === 'idle' || item.status === 'stalled' || item.status === 'driving') entry.status = item.status
    }
    if (Array.isArray(record.wheelVisuals)) for (const raw of record.wheelVisuals.slice(0, 2048)) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      if (typeof item.key !== 'string' || !Number.isFinite(Number(item.spin))) continue
      const entry = this.models.get(item.key)
      if (entry?.type === 'wheel') {
        entry.spin = Number(item.spin)
        entry.model.rim.rotation.z = entry.spin
      }
    }
    if (Array.isArray(record.mountedWheelVisuals)) for (const raw of record.mountedWheelVisuals.slice(0, 2048)) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      if (typeof item.key !== 'string' || !Number.isFinite(Number(item.spin))) continue
      const entry = this.mountedWheels.get(item.key)
      if (entry) {
        // Parent shaft rotation is authoritative for a mounted wheel.
        entry.spin = 0
        entry.model.rim.rotation.z = 0
      }
    }
    const incomingMachines = Array.isArray(record.machines) ? record.machines.slice(0, 128) : []
    const activeMachineKeys = new Set(incomingMachines.flatMap((raw) =>
      raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).motorKey === 'string'
        ? [String((raw as Record<string, unknown>).motorKey)] : []
    ))
    this.desiredNetworkMachines = activeMachineKeys
    const activeNetworkBodyKeys = new Set<string>()
    for (const key of activeMachineKeys) {
      activeNetworkBodyKeys.add(`machine:${key}:rotor`)
      activeNetworkBodyKeys.add(`machine:${key}:chassis`)
    }
    for (const raw of incomingMachines) {
      if (!raw || typeof raw !== 'object') continue
      const machine = raw as Record<string, unknown>
      if (typeof machine.motorKey !== 'string' || !Array.isArray(machine.extraRotors)) continue
      for (const rawExtra of machine.extraRotors.slice(0, 32)) {
        if (rawExtra && typeof rawExtra === 'object' && typeof (rawExtra as Record<string, unknown>).motorKey === 'string') {
          activeNetworkBodyKeys.add(`machine:${machine.motorKey}:extra:${String((rawExtra as Record<string, unknown>).motorKey)}`)
        }
      }
    }
    const activeNetworkFallingKeys = new Set<string>()
    // The host is authoritative for starting/stopping articulated machines too.
    for (const c of [...this.contraptions.values()]) {
      if (!activeMachineKeys.has(c.motorKey)) this.disassemble(c, ((Math.round(c.angle / HALF_PI) % 4) + 4) % 4)
    }
    for (const raw of incomingMachines) {
      if (!raw || typeof raw !== 'object') continue
      const machine = raw as Record<string, unknown>
      if (typeof machine.motorKey !== 'string') continue
      const c = this.contraptions.get(machine.motorKey)
      if (!c) continue
      queuePose(`machine:${c.motorKey}:rotor`, c.rotorBody, machine.rotor)
      queuePose(`machine:${c.motorKey}:chassis`, c.chassisBody, machine.chassis)
      if (Number.isFinite(Number(machine.angle))) {
        const angle = Number(machine.angle)
        if (!this.networkMachineAngles.has(c.motorKey)) c.angle = angle
        this.networkMachineAngles.set(c.motorKey, angle)
      }
      if (Number.isFinite(Number(machine.speed))) c.speed = Number(machine.speed)
      if (Array.isArray(machine.extraRotors)) for (const rawExtra of machine.extraRotors.slice(0, 32)) {
        if (!rawExtra || typeof rawExtra !== 'object') continue
        const extraRecord = rawExtra as Record<string, unknown>
        if (typeof extraRecord.motorKey !== 'string') continue
        const extra = (c.extraRotors ?? []).find((entry) => entry.motorKey === extraRecord.motorKey)
        if (!extra) continue
        queuePose('machine:' + c.motorKey + ':extra:' + extra.motorKey, extra.rotorBody, extraRecord.rotor)
        if (Number.isFinite(Number(extraRecord.angle))) extra.angle = Number(extraRecord.angle)
        if (Number.isFinite(Number(extraRecord.speed))) extra.speed = Number(extraRecord.speed)
      }
    }
    const incomingFalling = Array.isArray(record.falling) ? record.falling.slice(0, 128) : []
    const liveVisualIds = new Set<string>()
    for (const raw of incomingFalling) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      if (!Array.isArray(item.keys)) continue
      const blocks = item.keys.filter((entry) => !!entry && typeof entry === 'object'
        && typeof (entry as Record<string, unknown>).originKey === 'string'
        && Number.isInteger((entry as Record<string, unknown>).id)
        && validVector((entry as Record<string, unknown>).localOrigin)) as Record<string, unknown>[]
      if (!blocks.length || !validVector(item.position) || !validRotation(item.rotation)) continue
      const keys = blocks.map((b) => String(b.originKey))
      const signature = JSON.stringify(blocks.map((b) => [b.originKey, b.id, b.localOrigin]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
      const id = keys.slice().sort().join('|').slice(0, 800)
      liveVisualIds.add(id)
      let visual = this.networkFallingVisuals.get(id)
      if (!visual || visual.signature !== signature) {
        if (visual) { disposeObject(visual.group); this.networkFallingVisuals.delete(id) }
        const group = new THREE.Group()
        group.name = 'CraftEducNetworkFallingBody'
        for (const entry of blocks) {
          const originKey = String(entry.originKey)
          const [x, y, z] = parseKey(originKey)
          const existing = this.world.getBlock(x, y, z)
          if (existing !== B.AIR) {
            this.suppress = true
            this.world.setBlock(x, y, z, B.AIR)
            this.suppress = false
          }
          const local = entry.localOrigin as { x: number; y: number; z: number }
          const blockId = Number(entry.id)
          if (blockId >= 0 && blockId <= 255 && blockId !== B.AIR) {
            const buffers = newBuffers()
            emitCube(buffers, -0.5, -0.5, -0.5, blockId, false, () => false)
            const mesh = new THREE.Mesh(buffersToGeometry(buffers), this.blockMaterial)
            mesh.position.set(local.x, local.y, local.z)
            group.add(mesh)
          }
          const model = this.models.get(originKey)
          if (model && model.model.group.parent !== group) {
            model.model.group.position.set(x + 0.5 - Number((item.position as Record<string, unknown>).x), y + 0.5 - Number((item.position as Record<string, unknown>).y), z + 0.5 - Number((item.position as Record<string, unknown>).z))
            group.add(model.model.group)
          }
        }
        this.scene.add(group)
        visual = {
          group, keys, signature,
          targetPosition: new THREE.Vector3(),
          targetRotation: new THREE.Quaternion(),
          linearVelocity: new THREE.Vector3(),
          angularVelocity: new THREE.Vector3(),
          receivedAt: performance.now(),
        }
        this.networkFallingVisuals.set(id, visual)
      }
      visual.targetPosition.set(item.position.x, item.position.y, item.position.z)
      visual.targetRotation.set(item.rotation.x, item.rotation.y, item.rotation.z, item.rotation.w).normalize()
      if (validVector(item.linearVelocity)) visual.linearVelocity.set(item.linearVelocity.x, item.linearVelocity.y, item.linearVelocity.z)
      else visual.linearVelocity.set(0, 0, 0)
      if (validVector(item.angularVelocity)) visual.angularVelocity.set(item.angularVelocity.x, item.angularVelocity.y, item.angularVelocity.z)
      else visual.angularVelocity.set(0, 0, 0)
      visual.receivedAt = performance.now()
    }
    for (const [id, visual] of this.networkFallingVisuals) {
      if (liveVisualIds.has(id)) continue
      // A landing snapshot may move a motor/box/wheel to a different voxel.
      // Remove registry entries for the old source keys before disposing the
      // replica group, otherwise mechanics would keep updating dead models.
      for (const key of visual.keys) {
        const [x, y, z] = parseKey(key)
        const idAtOrigin = this.world.getBlock(x, y, z)
        if (idAtOrigin === B.MOTOR || idAtOrigin === B.BATTERY_BOX || idAtOrigin === B.WHEEL || idAtOrigin === B.LED) continue
        const entry = this.models.get(key)
        if (entry && entry.model.group.parent === visual.group) this.models.delete(key)
        this.mountedWheels.delete(key)
        const glow = this.glows.get(key)
        if (glow && glow.parent === visual.group) this.glows.delete(key)
      }
      disposeObject(visual.group)
      this.networkFallingVisuals.delete(id)
    }
    if (Array.isArray(record.wires)) for (const raw of record.wires.slice(0, 3000)) {
      if (!raw || typeof raw !== 'object') continue
      const value = raw as Record<string, unknown>
      if (typeof value.id !== 'string' || !validVector(value.pa) || !validVector(value.pb)) continue
      const wire = this.wires.find((entry) => entry.networkId === value.id)
      if (!wire) continue
      wire.a = typeof value.a === 'string' ? value.a : wire.a
      wire.b = typeof value.b === 'string' ? value.b : wire.b
      wire.pa.set(value.pa.x, value.pa.y, value.pa.z)
      wire.pb.set(value.pb.x, value.pb.y, value.pb.z)
      updateWireMesh(wire.mesh, wire.pa, wire.pb)
    }
    if (Array.isArray(record.falling)) {
      const byKey = new Map<string, FallingBody>()
      for (const body of this.fallingBodies) for (const block of body.blocks) byKey.set(block.originKey, body)
      for (const raw of record.falling.slice(0, 128)) {
        if (!raw || typeof raw !== 'object') continue
        const item = raw as Record<string, unknown>
        if (!Array.isArray(item.keys)) continue
        const key = item.keys.find((entry) => !!entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).originKey === 'string') as Record<string, unknown> | undefined
        if (!key) continue
        const body = byKey.get(String(key.originKey))
        if (body) {
          const targetKey = `falling:${String(key.originKey)}`
          activeNetworkFallingKeys.add(targetKey)
          queuePose(targetKey, body.body, item)
        }
      }
    }
    for (const key of this.networkMachineAngles.keys()) {
      if (!activeMachineKeys.has(key)) this.networkMachineAngles.delete(key)
    }
    for (const key of this.networkBodyTargets.keys()) {
      if (key.startsWith('machine:') && !activeNetworkBodyKeys.has(key)) this.networkBodyTargets.delete(key)
      if (key.startsWith('falling:') && !activeNetworkFallingKeys.has(key)) this.networkBodyTargets.delete(key)
    }
    this.mechDirty = true
    if (this.rigidPhysics.ready) this.syncRigidTransforms()
  }

  private updateNetworkPoseInterpolation(dt: number) {
    const blend = 1 - Math.exp(-Math.max(0, Math.min(dt, 0.05)) * 22)
    const now = performance.now()
    // Snapshots are sent over HTTP polling, so a moving body would otherwise
    // stop between snapshots. Extrapolate the authoritative linear/angular
    // velocity briefly, then blend toward that predicted pose. The cap prevents
    // a disconnected or delayed client from letting machines drift indefinitely.
    const extrapolatedPose = (
      position: THREE.Vector3,
      rotation: THREE.Quaternion,
      linearVelocity: THREE.Vector3,
      angularVelocity: THREE.Vector3,
      receivedAt: number,
    ) => {
      const age = Math.min(0.45, Math.max(0, (now - receivedAt) / 1000))
      const predictedPosition = position.clone().addScaledVector(linearVelocity, age)
      const predictedRotation = rotation.clone()
      const angularSpeed = angularVelocity.length()
      if (angularSpeed > 1e-5 && age > 0) {
        const delta = new THREE.Quaternion().setFromAxisAngle(
          angularVelocity.clone().multiplyScalar(1 / angularSpeed),
          angularSpeed * age,
        )
        // Rapier reports world-space angular velocity, so its delta premultiplies.
        predictedRotation.premultiply(delta).normalize()
      }
      return { position: predictedPosition, rotation: predictedRotation }
    }
    // Shaft angles are derived from the interpolated rotor pose in syncRigidTransforms.
    for (const target of this.networkBodyTargets.values()) {
      const body = target.body
      const predicted = extrapolatedPose(target.position, target.rotation, target.linearVelocity, target.angularVelocity, target.receivedAt)
      const currentPosition = body.translation()
      const position = new THREE.Vector3(currentPosition.x, currentPosition.y, currentPosition.z).lerp(predicted.position, blend)
      const currentRotation = body.rotation()
      const rotation = new THREE.Quaternion(currentRotation.x, currentRotation.y, currentRotation.z, currentRotation.w).slerp(predicted.rotation, blend)
      body.setTranslation({ x: position.x, y: position.y, z: position.z }, true)
      body.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w }, true)
    }
    for (const visual of this.networkFallingVisuals.values()) {
      const predicted = extrapolatedPose(visual.targetPosition, visual.targetRotation, visual.linearVelocity, visual.angularVelocity, visual.receivedAt)
      visual.group.position.lerp(predicted.position, blend)
      visual.group.quaternion.slerp(predicted.rotation, blend)
      visual.group.updateMatrixWorld(true)
    }
  }

  private syncRigidTransforms() {
    const syncGroup = (group: THREE.Group, body: RAPIER.RigidBody) => {
      const position = body.translation()
      const rotation = body.rotation()
      group.position.set(position.x, position.y, position.z)
      group.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
      group.updateMatrixWorld(true)
    }
    const touchedWires = new Set<Wire>()
    for (const c of this.contraptions.values()) {
      syncGroup(c.chassisGroup, c.chassisBody)
      syncGroup(c.group, c.rotorBody)
      // Shaft angle is relative to the chassis; a world-space quaternion drifts
      // when a wheeled vehicle steers around Y.
      const rotation = c.rotorBody.rotation()
      const chassisR = c.chassisBody.rotation()
      const chassisQ = new THREE.Quaternion(chassisR.x, chassisR.y, chassisR.z, chassisR.w)
      const rotorQ = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w)
      const relativeRotorQ = chassisQ.clone().invert().multiply(rotorQ)
      // The chassis and rotor are created with identity rotations, so c.axis is
      // also the hinge axis in the chassis-local frame. Derive the signed hinge
      // angle from the relative quaternion; Rapier's impulse joint exposes no
      // public angle() accessor in the version used by this project.
      const projected = relativeRotorQ.x * c.axis.x + relativeRotorQ.y * c.axis.y + relativeRotorQ.z * c.axis.z
      const signedAngle = 2 * Math.atan2(projected, relativeRotorQ.w)
      if (c.actuatorId === B.SERVO) {
        // Do not wrap a tiny negative servo angle to almost 360 degrees. Near
        // the zero stop, floating-point noise should stay at 0°, not command
        // a full sweep to the opposite limit.
        c.angle = THREE.MathUtils.clamp(signedAngle, 0, SERVO_MAX_ANGLE_RAD)
      } else {
        c.angle = signedAngle
        if (c.angle < 0) c.angle += Math.PI * 2
      }
      const motor = this.models.get(c.motorKey)
      if (motor?.type === 'motor' || motor?.type === 'servo') motor.model.shaft.rotation.z = c.angle
      for (const extra of c.extraRotors ?? []) {
        syncGroup(extra.group, extra.rotorBody)
        const rr = extra.rotorBody.rotation()
        const relative = chassisQ.clone().invert().multiply(new THREE.Quaternion(rr.x, rr.y, rr.z, rr.w))
        const projectedExtra = relative.x * extra.axis.x + relative.y * extra.axis.y + relative.z * extra.axis.z
        extra.angle = 2 * Math.atan2(projectedExtra, relative.w)
        if (extra.angle < 0) extra.angle += Math.PI * 2
        const extraMotor = this.models.get(extra.motorKey)
        if (extraMotor?.type === 'motor') extraMotor.model.shaft.rotation.z = extra.angle
        for (const end of extra.wireEnds) {
          const point = extra.group.localToWorld(end.local.clone())
          if (end.end === 'a') end.wire.pa.copy(point)
          else end.wire.pb.copy(point)
          touchedWires.add(end.wire)
        }
      }
      for (const end of c.wireEnds) {
        const point = c.group.localToWorld(end.local.clone())
        if (end.end === 'a') end.wire.pa.copy(point)
        else end.wire.pb.copy(point)
        touchedWires.add(end.wire)
      }
      for (const end of c.chassisWireEnds) {
        const point = c.chassisGroup.localToWorld(end.local.clone())
        if (end.end === 'a') end.wire.pa.copy(point)
        else end.wire.pb.copy(point)
        touchedWires.add(end.wire)
      }
    }
    for (const body of this.fallingBodies) {
      syncGroup(body.group, body.body)
      for (const end of body.wireEnds) {
        const point = body.group.localToWorld(end.local.clone())
        if (end.end === 'a') end.wire.pa.copy(point)
        else end.wire.pb.copy(point)
        touchedWires.add(end.wire)
      }
    }
    for (const wire of touchedWires) updateWireMesh(wire.mesh, wire.pa, wire.pb)
  }

  /**
   * Resolve dynamic rotor-vs-player contacts using each rotating voxel's
   * transformed AABB. Pushes the player out and transfers tangential motion,
   * including upward motion when the player stands on a moving arm.
   */
  resolvePlayerCollision(player: Player, dt: number) {
    const p = player.pos
    const halfW = 0.3
    const height = player.height
    const worldAxes = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
    ]
    // The player is upright and axis-aligned; each moving voxel remains an
    // oriented box. SAT avoids the oversized fake corners from a world AABB.
    const supportSkin = 0.025
    const support = { normalY: -1, velocity: new THREE.Vector3() }

    const collideBlock = (
      center: THREE.Vector3,
      rotation: THREE.Quaternion,
      pivot: THREE.Vector3,
      linear: THREE.Vector3,
      angular: THREE.Vector3,
    ) => {
      const blockAxes = [
        new THREE.Vector3(1, 0, 0).applyQuaternion(rotation).normalize(),
        new THREE.Vector3(0, 1, 0).applyQuaternion(rotation).normalize(),
        new THREE.Vector3(0, 0, 1).applyQuaternion(rotation).normalize(),
      ]
      const playerCenter = new THREE.Vector3(p.x, p.y + height * 0.5, p.z)
      const delta = playerCenter.clone().sub(center)
      // The extra vertical skin catches a platform just beneath the player's
      // feet without expanding the actual collision response.
      const playerHalf = new THREE.Vector3(halfW, height * 0.5 + supportSkin, halfW)
      const axes: THREE.Vector3[] = [...worldAxes, ...blockAxes]
      for (const worldAxis of worldAxes) {
        for (const blockAxis of blockAxes) {
          axes.push(new THREE.Vector3().crossVectors(worldAxis, blockAxis))
        }
      }

      let minimumOverlap = Number.POSITIVE_INFINITY
      let collisionNormal: THREE.Vector3 | null = null
      for (const candidate of axes) {
        const lengthSq = candidate.lengthSq()
        if (lengthSq < 1e-8) continue
        const axis = candidate.clone().multiplyScalar(1 / Math.sqrt(lengthSq))
        const playerRadius =
          playerHalf.x * Math.abs(axis.x) +
          playerHalf.y * Math.abs(axis.y) +
          playerHalf.z * Math.abs(axis.z)
        const blockRadius = 0.5 * (
          Math.abs(axis.dot(blockAxes[0])) +
          Math.abs(axis.dot(blockAxes[1])) +
          Math.abs(axis.dot(blockAxes[2]))
        )
        const signedDistance = delta.dot(axis)
        const overlap = playerRadius + blockRadius - Math.abs(signedDistance)
        if (overlap <= 0) return
        if (overlap < minimumOverlap) {
          minimumOverlap = overlap
          collisionNormal = axis.multiplyScalar(signedDistance >= 0 ? 1 : -1)
        }
      }
      if (!collisionNormal || !Number.isFinite(minimumOverlap)) return

      // Do not push the avatar merely for entering the support skin. Resolve
      // only real penetration; this prevents a small repeated upward impulse
      // when standing across seams between adjacent moving voxels.
      const normal = collisionNormal
      const actualPlayerRadius =
        halfW * Math.abs(normal.x) +
        (height * 0.5) * Math.abs(normal.y) +
        halfW * Math.abs(normal.z)
      const blockRadius = 0.5 * (
        Math.abs(normal.dot(blockAxes[0])) +
        Math.abs(normal.dot(blockAxes[1])) +
        Math.abs(normal.dot(blockAxes[2]))
      )
      const actualOverlap = actualPlayerRadius + blockRadius - Math.abs(delta.dot(normal))
      if (actualOverlap > 0) p.addScaledVector(normal, actualOverlap + 0.002)

      // Velocity at the actual contact point matters on a rotating arm. Using
      // the voxel center makes the player inherit the wrong tangential speed.
      const contactRadius = halfW * Math.abs(normal.x) +
        (height * 0.5) * Math.abs(normal.y) +
        halfW * Math.abs(normal.z)
      const contactPoint = playerCenter.clone().addScaledVector(normal, -contactRadius)
      const surfaceVelocity = angular.clone().cross(contactPoint.sub(pivot)).add(linear)
      const relativeVelocity = player.vel.clone().sub(surfaceVelocity)
      const inwardSpeed = relativeVelocity.dot(normal)
      if (inwardSpeed < 0) player.vel.addScaledVector(normal, -inwardSpeed)

      // Remember one best support contact and carry the player by positional
      // displacement once per frame. Do not repeatedly add platform velocity
      // to player.vel, which otherwise stacks with the walking controller.
      if (normal.y > 0.55) {
        player.onGround = true
        if (player.vel.y < surfaceVelocity.y) player.vel.y = surfaceVelocity.y
        if (normal.y > support.normalY) {
          support.normalY = normal.y
          support.velocity.copy(surfaceVelocity)
        }
      }
    }

    for (const c of this.contraptions.values()) {
      const rotorT = c.rotorBody.translation(), rotorR = c.rotorBody.rotation()
      const rotorPivot = new THREE.Vector3(rotorT.x, rotorT.y, rotorT.z)
      const rotorQ = new THREE.Quaternion(rotorR.x, rotorR.y, rotorR.z, rotorR.w)
      const rotorV = c.rotorBody.linvel(), rotorW = c.rotorBody.angvel()
      const rotorLinear = new THREE.Vector3(rotorV.x, rotorV.y, rotorV.z)
      const rotorAngular = new THREE.Vector3(rotorW.x, rotorW.y, rotorW.z)
      for (const block of c.blocks) {
        const center = new THREE.Vector3(...block.rel).applyQuaternion(rotorQ).add(rotorPivot)
        collideBlock(center, rotorQ, rotorPivot, rotorLinear, rotorAngular)
      }
      for (const extra of c.extraRotors ?? []) {
        const t = extra.rotorBody.translation(), r = extra.rotorBody.rotation()
        const pivot = new THREE.Vector3(t.x, t.y, t.z)
        const rotation = new THREE.Quaternion(r.x, r.y, r.z, r.w)
        const v = extra.rotorBody.linvel(), w = extra.rotorBody.angvel()
        const linear = new THREE.Vector3(v.x, v.y, v.z)
        const angular = new THREE.Vector3(w.x, w.y, w.z)
        for (const block of extra.blocks) {
          const center = new THREE.Vector3(...block.rel).applyQuaternion(rotation).add(pivot)
          collideBlock(center, rotation, pivot, linear, angular)
        }
      }

      const chassisT = c.chassisBody.translation(), chassisR = c.chassisBody.rotation()
      const chassisPivot = new THREE.Vector3(chassisT.x, chassisT.y, chassisT.z)
      const chassisQ = new THREE.Quaternion(chassisR.x, chassisR.y, chassisR.z, chassisR.w)
      const chassisV = c.chassisBody.linvel(), chassisW = c.chassisBody.angvel()
      const chassisLinear = new THREE.Vector3(chassisV.x, chassisV.y, chassisV.z)
      const chassisAngular = new THREE.Vector3(chassisW.x, chassisW.y, chassisW.z)
      collideBlock(chassisPivot.clone(), chassisQ, chassisPivot, chassisLinear, chassisAngular)
      for (const block of c.chassisBlocks) {
        const center = new THREE.Vector3(...block.rel).applyQuaternion(chassisQ).add(chassisPivot)
        collideBlock(center, chassisQ, chassisPivot, chassisLinear, chassisAngular)
      }
    }

    for (const body of this.fallingBodies) {
      const t = body.body.translation(), r = body.body.rotation()
      const pivot = new THREE.Vector3(t.x, t.y, t.z)
      const rotation = new THREE.Quaternion(r.x, r.y, r.z, r.w)
      const v = body.body.linvel(), w = body.body.angvel()
      const linear = new THREE.Vector3(v.x, v.y, v.z)
      const angular = new THREE.Vector3(w.x, w.y, w.z)
      for (const block of body.blocks) {
        const center = block.localOrigin.clone().applyQuaternion(rotation).add(pivot)
        collideBlock(center, rotation, pivot, linear, angular)
      }
    }

    if (support.normalY >= 0 && dt > 0) {
      p.x += support.velocity.x * dt
      p.z += support.velocity.z * dt
    }
  }

  /**
   * Raycast against currently simulated blocks, including articulated motor
   * rotors, rigid chassis blocks, and falling glue assemblies. The hit keeps
   * the source voxel key so edits can safely re-grid the assembly first.
   */
  raycastMoving(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): MovingBlockHit | null {
    let best: MovingBlockHit | null = null
    const rayDirection = direction.clone().normalize()

    const testBody = (
      pivot: THREE.Vector3,
      rotation: THREE.Quaternion,
      blocks: { rel: [number, number, number]; id: number; key: string; kind: MovingBlockHit['moving']['kind'] }[],
    ) => {
      const inverse = rotation.clone().invert()
      const localOrigin = origin.clone().sub(pivot).applyQuaternion(inverse)
      const localDirection = rayDirection.clone().applyQuaternion(inverse).normalize()
      for (const block of blocks) {
        const center = new THREE.Vector3(...block.rel)
        const min = [center.x - 0.5, center.y - 0.5, center.z - 0.5]
        const max = [center.x + 0.5, center.y + 0.5, center.z + 0.5]
        const o = [localOrigin.x, localOrigin.y, localOrigin.z]
        const d = [localDirection.x, localDirection.y, localDirection.z]
        let tMin = Number.NEGATIVE_INFINITY
        let tMax = Number.POSITIVE_INFINITY
        let axis = -1
        for (let a = 0; a < 3; a++) {
          if (Math.abs(d[a]) < 1e-9) {
            if (o[a] < min[a] || o[a] > max[a]) { tMax = Number.NEGATIVE_INFINITY; break }
            continue
          }
          let t1 = (min[a] - o[a]) / d[a]
          let t2 = (max[a] - o[a]) / d[a]
          if (t1 > t2) [t1, t2] = [t2, t1]
          if (t1 > tMin) { tMin = t1; axis = a }
          tMax = Math.min(tMax, t2)
        }
        if (tMin > tMax || tMin < 0 || tMin > maxDistance || axis < 0) continue
        if (best && tMin >= best.dist) continue
        const localNormal = new THREE.Vector3()
        const normalSign = d[axis] > 0 ? -1 : 1
        if (axis === 0) localNormal.x = normalSign
        else if (axis === 1) localNormal.y = normalSign
        else localNormal.z = normalSign
        const worldNormal = localNormal.applyQuaternion(rotation)
        let face = 0
        let faceDot = Number.NEGATIVE_INFINITY
        for (let i = 0; i < DIRS.length; i++) {
          const dir = DIRS[i]
          const dot = worldNormal.x * dir[0] + worldNormal.y * dir[1] + worldNormal.z * dir[2]
          if (dot > faceDot) { faceDot = dot; face = i }
        }
        const worldCenter = center.applyQuaternion(rotation).add(pivot)
        best = {
          x: Math.round(worldCenter.x - 0.5),
          y: Math.round(worldCenter.y - 0.5),
          z: Math.round(worldCenter.z - 0.5),
          face,
          id: block.id,
          dist: tMin,
          point: origin.clone().addScaledVector(rayDirection, tMin),
          moving: { key: block.key, kind: block.kind },
        }
      }
    }

    for (const c of this.contraptions.values()) {
      const rotorPose = c.rotorBody
      const rotorT = rotorPose.translation(), rotorR = rotorPose.rotation()
      testBody(
        new THREE.Vector3(rotorT.x, rotorT.y, rotorT.z),
        new THREE.Quaternion(rotorR.x, rotorR.y, rotorR.z, rotorR.w),
        c.blocks.map((b) => ({ rel: b.rel, id: b.id, key: b.origKey, kind: 'rotor' as const })),
      )
      for (const extra of c.extraRotors ?? []) {
        const t = extra.rotorBody.translation(), r = extra.rotorBody.rotation()
        testBody(
          new THREE.Vector3(t.x, t.y, t.z),
          new THREE.Quaternion(r.x, r.y, r.z, r.w),
          extra.blocks.map((b) => ({ rel: b.rel, id: b.id, key: b.origKey, kind: 'rotor' as const })),
        )
      }
      const chassisT = c.chassisBody.translation(), chassisR = c.chassisBody.rotation()
      testBody(
        new THREE.Vector3(chassisT.x, chassisT.y, chassisT.z),
        new THREE.Quaternion(chassisR.x, chassisR.y, chassisR.z, chassisR.w),
        [
          { rel: [0, 0, 0] as [number, number, number], id: c.actuatorId, key: c.motorKey, kind: 'chassis' as const },
          ...c.chassisBlocks.map((b) => ({ rel: b.rel, id: b.id, key: b.origKey, kind: 'chassis' as const })),
        ],
      )
    }

    for (const body of this.fallingBodies) {
      const t = body.body.translation(), r = body.body.rotation()
      testBody(
        new THREE.Vector3(t.x, t.y, t.z),
        new THREE.Quaternion(r.x, r.y, r.z, r.w),
        body.blocks.map((b) => ({
          rel: [b.localOrigin.x, b.localOrigin.y, b.localOrigin.z] as [number, number, number],
          id: b.id, key: b.originKey, kind: 'falling' as const,
        })),
      )
    }
    return best
  }

  /**
   * Turn a moving assembly back into editable voxel cells. The edit is mapped
   * from the original cell identity, not from its approximate rendered world
   * position, so breaking/placing on a spinning block targets the intended cell.
   */
  releaseMovingBlock(key: string, kind: MovingBlockHit['moving']['kind']): { x: number; y: number; z: number; id: number } | null {
    if (kind === 'falling') {
      const index = this.fallingBodies.findIndex((body) => body.blocks.some((block) => block.originKey === key))
      if (index < 0) return null
      const body = this.fallingBodies[index]
      const originalRotation = body.body.rotation()
      const originalLinear = body.body.linvel()
      const originalAngular = body.body.angvel()
      const originalQ = new THREE.Quaternion(originalRotation.x, originalRotation.y, originalRotation.z, originalRotation.w)
      const euler = new THREE.Euler().setFromQuaternion(originalQ, 'XYZ')
      const base = [
        Math.round(euler.x / HALF_PI),
        Math.round(euler.y / HALF_PI),
        Math.round(euler.z / HALF_PI),
      ]
      const candidates: { q: THREE.Quaternion; score: number }[] = []
      for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) {
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
          ((base[0] + x) % 4) * HALF_PI,
          ((base[1] + y) % 4) * HALF_PI,
          ((base[2] + z) % 4) * HALF_PI,
          'XYZ',
        ))
        candidates.push({ q, score: 1 - Math.abs(q.dot(originalQ)) })
      }
      candidates.sort((a, b) => a.score - b.score)
      body.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
      body.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
      for (const candidate of candidates) {
        body.body.setRotation(candidate.q, true)
        const keyMap = this.landBody(body)
        if (!keyMap) continue
        this.fallingBodies.splice(index, 1)
        const target = keyMap.get(key)
        if (!target) return null
        const [x, y, z] = parseKey(target)
        return { x, y, z, id: this.world.getBlock(x, y, z) }
      }
      body.body.setRotation(originalQ, true)
      body.body.setLinvel(originalLinear, true)
      body.body.setAngvel(originalAngular, true)
      return null
    }

    for (const c of [...this.contraptions.values()]) {
      const contains = kind === 'rotor'
        ? c.blocks.some((block) => block.origKey === key)
          || (c.extraRotors ?? []).some((rotor) => rotor.blocks.some((block) => block.origKey === key))
        : c.motorKey === key || c.chassisBlocks.some((block) => block.origKey === key)
          || (c.extraRotors ?? []).some((rotor) => rotor.motorKey === key)
      if (!contains) continue
      // Try every quarter-turn, starting with the nearest, until the assembly
      // can be safely restored to distinct voxel cells without intersecting
      // another object. This keeps editing reliable even mid-rotation.
      const preferred = ((Math.round(c.angle / HALF_PI) % 4) + 4) % 4
      for (let offset = 0; offset < 4; offset++) {
        const turns = (preferred + offset) % 4
        const keyMap = this.disassemble(c, turns)
        if (!keyMap) continue
        const target = keyMap.get(key)
        // A non-null map means the machine has already been dismantled; do not
        // retry using stale physics bodies if the target identity is missing.
        if (!target) return null
        const [x, y, z] = parseKey(target)
        return { x, y, z, id: this.world.getBlock(x, y, z) }
      }
      return null
    }
    return null
  }

  physicsDebugText() {
    const lines = [
      `Rapier ready: ${this.rigidPhysics.ready}`,
      `powerDirty=${this.powerDirty} mechDirty=${this.mechDirty} wires=${this.wires.length}`,
      `contraptions=${this.contraptions.size} fallingBodies=${this.fallingBodies.length}`,
    ]
    for (const [key, entry] of this.models) {
      if (entry.type !== 'motor') continue
      const c = this.contraptions.get(key)
      const p = this.motorPower.get(key) ?? 0
      const direction = this.motorDirection.get(key) ?? 0
      lines.push(`motor ${key} status=${entry.status} power=${p.toFixed(2)} dir=${direction} world=${this.world.getBlock(...parseKey(key))}`)
      if (c) {
        const w = c.rotorBody.angvel()
        const v = c.rotorBody.linvel()
        lines.push(`  rotor vel=(${w.x.toFixed(2)},${w.y.toFixed(2)},${w.z.toFixed(2)}) lin=(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}) sleep=${c.rotorBody.isSleeping()}`)
        lines.push(`  motor axis=${c.facing} targetSpeed=${c.speed.toFixed(2)} blocks=${c.blocks.length} chassis=${c.chassisBlocks.length}`)
      }
    }
    return lines.join('\n')
  }

  electricalDebugText() {
    const lines = [
      `ELÉTRICA: fios=${this.wires.length} nós=${this.electricalNodeVoltages.size}`,
    ]
    let shown = 0
    for (const [key, entry] of this.models) {
      if (shown >= 18) {
        lines.push('… diagnóstico limitado aos primeiros 18 componentes')
        break
      }
      if (entry.type === 'box') {
        const sourceId = `battery-pack:${key}`
        const state = this.lookup(key).state
        const current = this.electricalBranchCurrents.get(sourceId)
        const connected = this.getTerminalConnections(key, '+').length + this.getTerminalConnections(key, '-').length
        lines.push(`bateria ${key} células=${state?.batteries ?? 0}V=${((state?.batteries ?? 0) * 1.5).toFixed(1)}V I=${current === undefined ? '—' : current.toFixed(3) + 'A'} terminaisLigados=${connected}`)
        shown++
      } else if (entry.type === 'resistor') {
        const va = this.electricalNodeVoltages.get(`${key}|A`)
        const vb = this.electricalNodeVoltages.get(`${key}|B`)
        const current = this.electricalBranchCurrents.get(`resistor:${key}`)
        const connected = this.getTerminalConnections(key, 'A').length + this.getTerminalConnections(key, 'B').length
        lines.push(`resistor ${key} V=${va === undefined || vb === undefined ? '—' : Math.abs(va - vb).toFixed(3) + 'V'} I=${current === undefined ? '—' : current.toFixed(4) + 'A'} terminaisLigados=${connected}`)
        shown++
      } else if (entry.type === 'led') {
        const va = this.electricalNodeVoltages.get(`${key}|anode`)
        const vc = this.electricalNodeVoltages.get(`${key}|cathode`)
        const current = this.electricalBranchCurrents.get(`led:${key}`)
        const state = this.lookup(key).state
        const connected = this.getTerminalConnections(key, 'anode').length + this.getTerminalConnections(key, 'cathode').length
        lines.push(`LED ${key} V=${va === undefined || vc === undefined ? '—' : (va - vc).toFixed(3) + 'V'} I=${current === undefined ? '—' : current.toFixed(4) + 'A'} queimado=${Boolean(state?.ledBurnedOut)} terminaisLigados=${connected}`)
        shown++
      }
    }
    return lines.join('\n')
  }

  isMotorDriving(key: string) {
    return this.contraptions.has(key)
  }

  motorPowerLevel(key: string) {
    return this.motorPower.get(key) ?? 0
  }

  motorStatus(key: string) {
    const e = this.models.get(key)
    return e?.type === 'motor' ? e.status : 'idle'
  }
}
