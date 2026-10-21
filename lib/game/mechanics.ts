import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { RigidPhysics } from './rigid-physics'
import { B, BLOCK_CONDUCTIVITY, DIRS, GROUND_LEVEL, OPPOSITE, isOpaque, parseKey, posKey } from './constants'
import { buffersToGeometry, buildGlueGeometry, emitCube, newBuffers } from './mesher'
import {
  type BatteryBoxModel,
  type MotorModel,
  type LedTerminalModel,
  type WheelModel,
  createBatteryBoxModel,
  createGlowSprite,
  createLedTerminalModel,
  createArduinoWheelModel,
  createMotorModel,
  createWireMesh,
  disposeObject,
  setBatteryCount,
  setMotorFacing,
  facingQuaternion,
  updateWireMesh,
} from './models'
import type { BlockState, World } from './world'
import type { Player } from './player'

const HALF_PI = Math.PI / 2
const MAX_CONTRAPTION = 400

type ModelEntry =
  | { type: 'motor'; model: MotorModel; spin: number; status: 'idle' | 'stalled' | 'driving' }
  | { type: 'box'; model: BatteryBoxModel }
  | { type: 'led'; model: LedTerminalModel }
  | { type: 'wheel'; model: WheelModel; spin: number }

export interface Wire {
  id: number
  a: string
  b: string
  pa: THREE.Vector3
  pb: THREE.Vector3
  ta: string
  tb: string
  mesh: THREE.Group
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

interface FallingBody {
  blocks: FallingBlock[]
  body: RAPIER.RigidBody
  group: THREE.Group
  pivot: THREE.Vector3
  wireEnds: { wire: Wire; end: 'a' | 'b'; local: THREE.Vector3; orig: THREE.Vector3 }[]
  settledTime: number
}

interface Contraption {
  motorKey: string
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
  group: THREE.Group
  angle: number
  speed: number
  wireEnds: { wire: Wire; end: 'a' | 'b'; local: THREE.Vector3; orig: THREE.Vector3 }[]
  reactionTravel: number
  velocity: THREE.Vector3
}

export class Mechanics {
  models = new Map<string, ModelEntry>()
  wires: Wire[] = []
  contraptions = new Map<string, Contraption>()
  glows = new Map<string, THREE.Sprite>()
  motorPower = new Map<string, number>()
  motorDirection = new Map<string, number>()
  private glueMesh: THREE.Mesh | null = null
  private suppress = false
  private powerDirty = true
  private mechDirty = true
  private wireId = 0
  private gravityTimer = 0
  private physicsDirty = true
  private mountedWheels = new Map<string, { model: WheelModel; spin: number }>()
  private fallingBodies: FallingBody[] = []
  private fallingKeys = new Set<string>()
  private readonly gravity = 18
  private physicsScanCooldown = 0
  private powerCooldown = 0
  private tractionVelocity = new Map<string, THREE.Vector3>()
  private rigidPhysics: RigidPhysics
  private physicsSynced = false

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
    if (this.suppress) return
    const key = posKey(x, y, z)
    if (oldId === B.MOTOR || oldId === B.BATTERY_BOX || oldId === B.LED || oldId === B.WHEEL) {
      const e = this.models.get(key)
      if (e) {
        disposeObject(e.model.group)
        this.models.delete(key)
      }
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
      const model = createMotorModel(st.facing)
      model.group.position.set(x + 0.5, y + 0.5, z + 0.5)
      this.scene.add(model.group)
      this.models.set(key, { type: 'motor', model, spin: 0, status: 'idle' })
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
    }
    // Glue geometry is expensive: rebuild only when a glued block actually changes.
    if (oldHadGlue || newHasGlue) this.rebuildGlue()
    const electrical = (id: number) => id === B.MOTOR || id === B.BATTERY_BOX || id === B.LED || id === B.IRON || id === B.ALUMINUM || id === B.ROBOTICS || id === B.COMPONENT
    if (electrical(oldId) || electrical(newId)) this.powerDirty = true
    if (oldHadGlue || newHasGlue || oldId === B.MOTOR || newId === B.MOTOR || oldId === B.WHEEL || newId === B.WHEEL) this.mechDirty = true
    this.physicsDirty = true
  }

  mountWheel(x: number, y: number, z: number) {
    const key = posKey(x, y, z)
    if (this.mountedWheels.has(key)) return false
    const entry = this.models.get(key)
    if (!entry || entry.type !== 'motor') return false
    const wheel = createArduinoWheelModel(this.world.getState(x, y, z)?.facing ?? 2)
    wheel.group.position.set(0, 0, 0.36)
    wheel.group.scale.setScalar(0.88)
    entry.model.shaft.add(wheel.group)
    this.mountedWheels.set(key, { model: wheel, spin: 0 })
    this.mechDirty = true
    return true
  }

  /* ---------------- Interactions ---------------- */

  rotateMotor(x: number, y: number, z: number) {
    const st = this.world.ensureState(x, y, z)
    st.facing = ((st.facing ?? 2) + 1) % 6
    const e = this.models.get(posKey(x, y, z))
    if (e?.type === 'motor') setMotorFacing(e.model, st.facing)
    this.mechDirty = true
    return st.facing
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
    this.mechDirty = true
    return Boolean(st.glue & (1 << face))
  }

  /** Resolve an exposed electrical terminal, never an arbitrary point inside a block. */
  resolveTerminal(key: string, hitPoint: THREE.Vector3, face: number) {
    const [x, y, z] = parseKey(key)
    const id = this.world.getBlock(x, y, z)
    if (id === B.BATTERY_BOX) {
      const terminals = [
        { terminal: '+', point: new THREE.Vector3(x + 0.82, y + 0.12, z + 0.97) },
        { terminal: '-', point: new THREE.Vector3(x + 0.70, y + 0.12, z + 0.97) },
      ]
      terminals.sort((a, b) => a.point.distanceToSquared(hitPoint) - b.point.distanceToSquared(hitPoint))
      return terminals[0].point.distanceTo(hitPoint) <= 0.3 ? terminals[0] : null
    }
    if (id === B.MOTOR) {
      const facing = this.world.getState(x, y, z)?.facing ?? 2
      const q = facingQuaternion(facing)
      const center = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5)
      const terminals = [-1, 1].map((side) => ({
        terminal: side < 0 ? 'A' : 'B',
        point: new THREE.Vector3(0.14 * side, 0.1, -0.46).applyQuaternion(q).add(center),
      }))
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

  addWire(a: string, pa: THREE.Vector3, ta: string, b: string, pb: THREE.Vector3, tb: string) {
    const mesh = createWireMesh(pa, pb)
    this.scene.add(mesh)
    this.wires.push({ id: ++this.wireId, a, b, pa: pa.clone(), pb: pb.clone(), ta, tb, mesh })
    this.powerDirty = true
    this.mechDirty = true
  }

  wiresAt(key: string) {
    return this.wires.filter((w) => w.a === key || w.b === key)
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
      const b = c.byKey.get(key)
      if (b) return b
    }
    const [x, y, z] = parseKey(key)
    return { id: this.world.getBlock(x, y, z), state: this.world.getState(x, y, z) }
  }

  private recomputePower() {
    // Each terminal is a separate node. Wires connect only the two terminals
    // explicitly selected by the player; conductive materials bridge their faces.
    const parent = new Map<string, string>()
    const find = (k: string): string => {
      let p = parent.get(k) ?? k
      if (p !== k) {
        p = find(p)
        parent.set(k, p)
      }
      return p
    }
    const union = (a: string, b: string) => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(ra, rb)
    }
    const node = (key: string, terminal: string) => `${key}|${terminal}`
    const allNodes = new Set<string>()
    for (const w of this.wires) {
      const a = node(w.a, w.ta)
      const b = node(w.b, w.tb)
      allNodes.add(a)
      allNodes.add(b)
      union(a, b)
    }

    // Conductive blocks connect their six face terminals internally. Wood and
    // other insulators deliberately do not provide a path through the block.
    for (const chunk of this.world.chunks.values()) {
      const minX = chunk.cx * 16
      const minZ = chunk.cz * 16
      for (let y = GROUND_LEVEL; y <= chunk.maxY; y++) for (let z = minZ; z < minZ + 16; z++) for (let x = minX; x < minX + 16; x++) {
        const id = this.world.getBlock(x, y, z)
        if ((BLOCK_CONDUCTIVITY[id] ?? 0) <= 0) continue
        const key = posKey(x, y, z)
        const faces = DIRS.map((_, i) => node(key, `face:${i}`))
        for (const n of faces) allNodes.add(n)
        for (let i = 1; i < faces.length; i++) union(faces[0], faces[i])
      }
    }

    const terminalRoot = (key: string, terminal: string) => find(node(key, terminal))
    const boxes: { key: string; positive: string; negative: string; batteries: number }[] = []
    const devices: { key: string; id: number; a: string; b: string }[] = []
    for (const chunk of this.world.chunks.values()) {
      const minX = chunk.cx * 16
      const minZ = chunk.cz * 16
      for (let y = GROUND_LEVEL; y <= chunk.maxY; y++) for (let z = minZ; z < minZ + 16; z++) for (let x = minX; x < minX + 16; x++) {
        const id = this.world.getBlock(x, y, z)
        const key = posKey(x, y, z)
        if (id === B.BATTERY_BOX) {
          const count = this.world.getState(x, y, z)?.batteries ?? 0
          if (count > 0) {
            const positive = node(key, '+')
            const negative = node(key, '-')
            allNodes.add(positive); allNodes.add(negative)
            boxes.push({ key, positive, negative, batteries: count })
          }
        } else if (id === B.LED || id === B.MOTOR) {
          const a = node(key, id === B.LED ? 'anode' : 'A')
          const b = node(key, id === B.LED ? 'cathode' : 'B')
          allNodes.add(a); allNodes.add(b)
          devices.push({ key, id, a, b })
        }
      }
    }

    // Motors inside moving contraptions are no longer present in the static
    // voxel grid, but remain electrical devices at their original circuit key.
    for (const [key, entry] of this.models) {
      if (entry.type !== 'motor' || this.world.getBlock(...parseKey(key)) === B.MOTOR) continue
      if (![...this.contraptions.values()].some((c) => c.motorKey === key)) continue
      const a = node(key, 'A')
      const b = node(key, 'B')
      allNodes.add(a); allNodes.add(b)
      devices.push({ key, id: B.MOTOR, a, b })
    }

    // Create roots for terminals that have not yet been connected by a wire.
    for (const n of allNodes) find(n)
    const positiveRoots = new Set(boxes.map((b) => find(b.positive)))
    const negativeRoots = new Set(boxes.map((b) => find(b.negative)))
    const activeBoxes = boxes.filter((b) => find(b.positive) !== find(b.negative))

    // Conductivity acts as efficiency along a circuit: every conductive block
    // contributes its material factor (e.g. iron 0.90, aluminum 0.95).
    const efficiencyByRoot = new Map<string, number>()
    for (const chunk of this.world.chunks.values()) {
      const minX = chunk.cx * 16
      const minZ = chunk.cz * 16
      for (let y = GROUND_LEVEL; y <= chunk.maxY; y++) for (let z = minZ; z < minZ + 16; z++) for (let x = minX; x < minX + 16; x++) {
        const conductivity = BLOCK_CONDUCTIVITY[this.world.getBlock(x, y, z)] ?? 0
        if (conductivity <= 0) continue
        const root = find(node(posKey(x, y, z), 'face:0'))
        efficiencyByRoot.set(root, (efficiencyByRoot.get(root) ?? 1) * conductivity)
      }
    }
    const efficiency = (terminal: string) => efficiencyByRoot.get(find(terminal)) ?? 1
    const leds = new Set<string>()
    this.motorPower.clear()
    this.motorDirection.clear()
    for (const d of devices) {
      const plusA = positiveRoots.has(find(d.a)) && negativeRoots.has(find(d.b))
      const plusB = positiveRoots.has(find(d.b)) && negativeRoots.has(find(d.a))
      const source = activeBoxes.reduce((max, b) => Math.max(max, b.batteries), 0)
      const transmission = efficiency(d.a) * efficiency(d.b)
      const deliveredPower = source * transmission
      if (source <= 0 || deliveredPower < 0.15 || (!plusA && !(d.id === B.MOTOR && plusB))) continue
      if (d.id === B.LED && plusA) leds.add(d.key)
      if (d.id === B.MOTOR) {
        this.motorPower.set(d.key, deliveredPower)
        this.motorDirection.set(d.key, plusA ? 1 : -1)
      }
    }

    const prev = this.world.poweredLeds
    for (const k of prev) {
      if (!leds.has(k)) {
        const [x, y, z] = parseKey(k)
        this.world.markBlockDirty(x, y, z)
        const g = this.glows.get(k)
        if (g) {
          g.parent?.remove(g)
          this.glows.delete(k)
        }
      }
    }
    for (const k of leds) {
      const [x, y, z] = parseKey(k)
      if (!prev.has(k)) this.world.markBlockDirty(x, y, z)
      if (!this.glows.has(k) && this.world.getBlock(x, y, z) === B.LED) {
        const glow = createGlowSprite()
        glow.position.set(x + 0.5, y + 0.5, z + 0.5)
        this.scene.add(glow)
        this.glows.set(k, glow)
      }
    }
    this.world.poweredLeds = leds
  }

  /* ---------------- Contraptions ---------------- */

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
    const motorState = this.world.getState(mx, my, mz)
    const facing = motorState?.facing ?? 2
    const d = DIRS[facing]
    const sx = mx + d[0], sy = my + d[1], sz = mz + d[2]
    if (this.world.getBlock(sx, sy, sz) === B.AIR || !this.isGlued(mx, my, mz, facing)) return 'idle'

    // The output-face glue component becomes the rotor rigid body.
    const seedKey = posKey(sx, sy, sz)
    const visited = new Set<string>([seedKey])
    const queue: [number, number, number][] = [[sx, sy, sz]]
    while (queue.length) {
      const [x, y, z] = queue.shift()!
      if (y < GROUND_LEVEL || visited.size > MAX_CONTRAPTION) return 'stalled'
      for (let face = 0; face < 6; face++) {
        const n = DIRS[face]
        const nx = x + n[0], ny = y + n[1], nz = z + n[2]
        const key = posKey(nx, ny, nz)
        if (visited.has(key) || key === motorKey) continue
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
      for (let face = 0; face < 6; face++) {
        const n = DIRS[face]
        const nx = x + n[0], ny = y + n[1], nz = z + n[2]
        const key = posKey(nx, ny, nz)
        if (key === motorKey || visited.has(key) || chassisVisited.has(key)) continue
        if (this.world.getBlock(nx, ny, nz) === B.AIR || !this.isGlued(x, y, z, face)) continue
        chassisVisited.add(key)
        chassisQueue.push([nx, ny, nz])
      }
    }

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
    const motorModel = this.models.get(motorKey)
    if (motorModel?.type === 'motor') {
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
      { x: mx, y: my, z: mz, id: B.MOTOR },
      ...chassisBlocks.map((b) => ({ x: mx + b.rel[0], y: my + b.rel[1], z: mz + b.rel[2], id: b.id })),
    ]
    const rotorVoxels = blocks.map((b) => ({ x: mx + b.rel[0], y: my + b.rel[1], z: mz + b.rel[2], id: b.id }))
    const chassisBody = this.rigidPhysics.createRigidBody(chassisVoxels, pivot, {
      lockRotation: true, canSleep: false, linearDamping: 0.12, angularDamping: 1,
    })
    const rotorBody = this.rigidPhysics.createRigidBody(rotorVoxels, pivot, {
      canSleep: false, linearDamping: 0.02, angularDamping: 0.03,
    })
    if (!chassisBody || !rotorBody) {
      if (chassisBody) this.rigidPhysics.removeRigidBody(chassisBody)
      if (rotorBody) this.rigidPhysics.removeRigidBody(rotorBody)
      this.mechDirty = true
      return 'idle'
    }
    const joint = this.rigidPhysics.createRevoluteJoint(
      chassisBody, rotorBody, new THREE.Vector3(d[0], d[1], d[2]),
    )
    if (!joint) {
      this.rigidPhysics.removeRigidBody(chassisBody)
      this.rigidPhysics.removeRigidBody(rotorBody)
      this.mechDirty = true
      return 'idle'
    }

    // Remove both moving components from the voxel/static-collider world.
    this.suppress = true
    for (const b of blocks) {
      const [x, y, z] = parseKey(b.origKey)
      this.world.setBlock(x, y, z, B.AIR)
    }
    for (const b of chassisBlocks) {
      const [x, y, z] = parseKey(b.origKey)
      this.world.setBlock(x, y, z, B.AIR)
    }
    this.world.setBlock(mx, my, mz, B.AIR)
    this.suppress = false
    this.rebuildGlue()
    this.scene.add(chassisGroup)
    this.scene.add(group)

    this.contraptions.set(motorKey, {
      motorKey,
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
      group,
      angle: 0,
      speed: 0,
      wireEnds,
      reactionTravel: 0,
      velocity: new THREE.Vector3(),
    })
    this.physicsDirty = true
    this.powerDirty = true
    return 'driving'
  }

  private disassemble(c: Contraption, quarterTurns: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(c.axis, quarterTurns * HALF_PI)
    const rotorTranslation = c.rotorBody.translation()
    const chassisTranslation = c.chassisBody.translation()
    const rotorPivot = new THREE.Vector3(rotorTranslation.x, rotorTranslation.y, rotorTranslation.z)
    const chassisPivot = new THREE.Vector3(chassisTranslation.x, chassisTranslation.y, chassisTranslation.z)
    const chassisQ = new THREE.Quaternion()
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
    const pushPlacement = (rel: [number, number, number], pivot: THREE.Vector3, rotation: THREE.Quaternion, id: number, state: BlockState | undefined, orig: string) => {
      const center = new THREE.Vector3(...rel).applyQuaternion(rotation).add(pivot)
      placements.push({
        x: Math.round(center.x - 0.5), y: Math.round(center.y - 0.5), z: Math.round(center.z - 0.5),
        id, state: rotatedState(state, rotation), orig,
      })
    }
    for (const b of c.blocks) pushPlacement(b.rel, rotorPivot, q, b.id, b.state, b.origKey)
    for (const b of c.chassisBlocks) pushPlacement(b.rel, chassisPivot, chassisQ, b.id, b.state, b.origKey)
    pushPlacement([0, 0, 0], chassisPivot, chassisQ, B.MOTOR, rotatedState(c.motorState, chassisQ), c.motorKey)

    // Preserve the entire rigid assembly if snapping it back to voxel cells
    // would intersect something. Lift the whole assembly as one unit.
    const destinationKeys = new Set<string>()
    for (const p of placements) destinationKeys.add(posKey(p.x, p.y, p.z))
    if (destinationKeys.size !== placements.length) return
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
      return
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
    disposeObject(c.group)
    disposeObject(c.chassisGroup)
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

    // Re-key models and mounted accessories to their snapped positions.
    for (const [oldKey, newKey] of keyMap) {
      const entry = this.models.get(oldKey)
      if (entry) {
        this.models.delete(oldKey)
        this.models.set(newKey, entry)
        const [x, y, z] = parseKey(newKey)
        if (entry.type === 'motor' && this.world.getState(x, y, z)?.facing !== undefined) setMotorFacing(entry.model, this.world.getState(x, y, z)!.facing!)
        if (entry.type === 'box') setBatteryCount(entry.model, this.world.getState(x, y, z)?.batteries ?? 0)
      }
      const mounted = this.mountedWheels.get(oldKey)
      if (mounted) { this.mountedWheels.delete(oldKey); this.mountedWheels.set(newKey, mounted) }
      const glow = this.glows.get(oldKey)
      if (glow) { this.glows.delete(oldKey); this.glows.set(newKey, glow) }
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
    for (const wire of this.wires) updateWireMesh(wire.mesh, wire.pa, wire.pb)
    this.rebuildGlue()
    this.powerDirty = true
    this.mechDirty = true
    this.physicsDirty = true
  }

  /**
   * Rigid-body-like voxel gravity. Unsupported glued components are removed
   * from the static world and rendered as real moving meshes until they land.
   * Motion is integrated every frame, not teleported between grid cells.
   */
  private updateGravity(dt: number) {
    if (!this.rigidPhysics.ready) return
    this.physicsScanCooldown -= dt
    if (this.physicsDirty && this.physicsScanCooldown <= 0) {
      this.physicsScanCooldown = 0.25
      this.physicsDirty = false
      this.detectUnsupportedBodies()
    }

    // Rapier resolves motion and contacts. A body is written back to the voxel
    // grid only after the solver has allowed it to sleep on a stable surface.
    for (let i = this.fallingBodies.length - 1; i >= 0; i--) {
      const body = this.fallingBodies[i]
      if (body.body.isSleeping()) body.settledTime += dt
      else body.settledTime = 0
      if (body.settledTime >= 0.35) {
        if (this.landBody(body)) this.fallingBodies.splice(i, 1)
        else body.settledTime = 0
      }
    }
  }

  private detectUnsupportedBodies() {
    if (!this.rigidPhysics.ready) { this.physicsDirty = true; return }
    const blocks: { key: string; x: number; y: number; z: number; id: number; state?: BlockState }[] = []
    const occupied = new Set<string>()
    for (const chunk of this.world.chunks.values()) {
      const minX = chunk.cx * 16, minZ = chunk.cz * 16
      for (let y = GROUND_LEVEL; y <= Math.min(63, chunk.maxY); y++) {
        for (let z = minZ; z < minZ + 16; z++) for (let x = minX; x < minX + 16; x++) {
          const id = this.world.getBlock(x, y, z)
          if (id === B.AIR) continue
          const key = posKey(x, y, z)
          occupied.add(key)
          blocks.push({ key, x, y, z, id, state: this.world.getState(x, y, z) })
        }
      }
    }
    const byKey = new Map(blocks.map((b) => [b.key, b]))
    const visited = new Set<string>()
    const fallingGroups: typeof blocks[] = []
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
      const keys = new Set(group.map((item) => item.key))
      const supported = group.some((item) => item.y <= GROUND_LEVEL || (() => {
        const below = posKey(item.x, item.y - 1, item.z)
        return occupied.has(below) && !keys.has(below)
      })())
      // A connected glue component is one rigid body. Unconnected blocks are
      // independent bodies and still collide with each other in Rapier.
      if (!supported) fallingGroups.push(group)
    }

    for (const blocksInGroup of fallingGroups) {
      const pivot = new THREE.Vector3()
      for (const b of blocksInGroup) pivot.add(new THREE.Vector3(b.x + 0.5, b.y + 0.5, b.z + 0.5))
      pivot.multiplyScalar(1 / blocksInGroup.length)
      const physicsBody = this.rigidPhysics.createRigidBody(
        blocksInGroup.map((b) => ({ x: b.x, y: b.y, z: b.z, id: b.id })),
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
        emitCube(buffers, -0.5, -0.5, -0.5, b.id, false, () => false)
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

  private landBody(body: FallingBody) {
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
    if (keys.size !== placements.length) return false
    let shiftY = Math.max(0, GROUND_LEVEL - Math.min(...placements.map((p) => p.y)))
    const fits = (offset: number) => placements.every((p) =>
      p.y + offset < WORLD_HEIGHT && this.world.getBlock(p.x, p.y + offset, p.z) === B.AIR)
    let attempts = 0
    while (!fits(shiftY) && attempts < 24) { shiftY++; attempts++ }
    if (!fits(shiftY)) return false
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
        const [x, y, z] = parseKey(newKey)
        const state = this.world.getState(x, y, z)
        if (entry.type === 'motor' && state?.facing !== undefined) setMotorFacing(entry.model, state.facing)
        if (entry.type === 'box') setBatteryCount(entry.model, state?.batteries ?? 0)
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
    for (const wire of this.wires) updateWireMesh(wire.mesh, wire.pa, wire.pb)
    disposeObject(body.group)
    this.rebuildGlue()
    this.powerDirty = true
    this.mechDirty = true
    this.physicsDirty = true
    return true
  }

  private contraptionsHasBlock(key: string) {
    for (const c of this.contraptions.values()) if (c.byKey.has(key)) return true
    return false
  }

  private landBody(body: FallingBody) {
    const occupied = new Set<string>()
    for (const b of body.blocks) {
      const x = Math.round(b.x), z = Math.round(b.z)
      let y = Math.max(GROUND_LEVEL, Math.floor(b.y))
      while (y > GROUND_LEVEL && this.world.getBlock(x, y - 1, z) === B.AIR) y--
      while (this.world.getBlock(x, y, z) !== B.AIR && y < 63) y++
      const key = posKey(x, y, z)
      if (occupied.has(key)) continue
      occupied.add(key)
      this.suppress = true
      this.world.setBlock(x, y, z, b.id, b.state)
      this.suppress = false
      this.fallingKeys.delete(b.originKey)
      b.mesh.geometry.dispose()
      this.scene.remove(b.mesh)
    }
    this.rebuildGlue()
    this.powerDirty = true
    this.mechDirty = true
  }

  private canRotateContraption(c: Contraption, angle: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(c.axis, angle)
    const ex = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    const ey = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    const ez = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
    const extent = new THREE.Vector3(
      0.5 * (Math.abs(ex.x) + Math.abs(ey.x) + Math.abs(ez.x)),
      0.5 * (Math.abs(ex.y) + Math.abs(ey.y) + Math.abs(ez.y)),
      0.5 * (Math.abs(ex.z) + Math.abs(ey.z) + Math.abs(ez.z)),
    )
    for (const b of c.blocks) {
      const center = new THREE.Vector3(...b.rel).applyQuaternion(q)
        .add(c.group.position)
      const minX = Math.floor(center.x - extent.x + 1e-5)
      const maxX = Math.floor(center.x + extent.x - 1e-5)
      const minY = Math.floor(center.y - extent.y + 1e-5)
      const maxY = Math.floor(center.y + extent.y - 1e-5)
      const minZ = Math.floor(center.z - extent.z + 1e-5)
      const maxZ = Math.floor(center.z + extent.z - 1e-5)
      if (minY < 0 || maxY >= 64) return false
      // The ground is a support surface, not a wall that blocks the rotor.
      // Ignore the fixed floor layers so an arm can press against them.
      for (let y = Math.max(GROUND_LEVEL, minY); y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
        const key = posKey(x, y, z)
        if (key !== c.motorKey && this.world.getBlock(x, y, z) !== B.AIR) return false
      }
    }
    return true
  }

  /**
   * Move the motor pivot and its rotating assembly as one voxel body. Used for
   * ground-reaction locomotion; the assembly stays assembled and keeps its
   * relative block layout instead of being torn down and rebuilt every step.
   */
  /**
   * Translate the motor and its non-rotating glued chassis together by one
   * voxel while leaving the output-side rotor independently articulated.
   * The rotor pivot remains grid-aligned during chassis movement.
   */
  private translateContraption(c: Contraption, dx: number, dy: number, dz: number, angle = c.angle) {
    const [mx, my, mz] = c.motorPos
    const delta = new THREE.Vector3(dx, dy, dz)
    const nx = mx + dx, ny = my + dy, nz = mz + dz
    if (ny < GROUND_LEVEL || ny >= 63) return false

    const oldKey = c.motorKey
    const targetKey = posKey(nx, ny, nz)
    const motorState = this.world.getState(mx, my, mz)
    const moving: { oldKey: string; newKey: string; x: number; y: number; z: number; id: number; state?: BlockState }[] = []
    moving.push({ oldKey, newKey: targetKey, x: nx, y: ny, z: nz, id: B.MOTOR, state: motorState ? { ...motorState } : undefined })
    for (const b of c.chassisBlocks) {
      const x = mx + b.rel[0], y = my + b.rel[1], z = mz + b.rel[2]
      const newX = x + dx, newY = y + dy, newZ = z + dz
      if (newY < GROUND_LEVEL || newY >= 64) return false
      const oldBlockKey = posKey(x, y, z)
      const state = this.world.getState(x, y, z)
      moving.push({
        oldKey: oldBlockKey, newKey: posKey(newX, newY, newZ), x: newX, y: newY, z: newZ,
        id: this.world.getBlock(x, y, z), state: state ? { ...state } : (b.state ? { ...b.state } : undefined),
      })
    }
    const sourceKeys = new Set(moving.map((b) => b.oldKey))
    const destinationKeys = new Set<string>()
    for (const b of moving) {
      if (destinationKeys.has(b.newKey)) return false
      destinationKeys.add(b.newKey)
      if (b.id === B.AIR) return false
      if (!sourceKeys.has(b.newKey) && this.world.getBlock(b.x, b.y, b.z) !== B.AIR) return false
    }

    // Check the rotating output assembly at its new pivot before moving the
    // motor/chassis. Chassis source cells are treated as part of this body.
    const q = new THREE.Quaternion().setFromAxisAngle(c.axis, angle)
    const pivot = new THREE.Vector3(mx + 0.5, my + 0.5, mz + 0.5)
    const axes = [
      new THREE.Vector3(1, 0, 0).applyQuaternion(q),
      new THREE.Vector3(0, 1, 0).applyQuaternion(q),
      new THREE.Vector3(0, 0, 1).applyQuaternion(q),
    ]
    const ext = new THREE.Vector3(
      0.5 * axes.reduce((n, a) => n + Math.abs(a.x), 0),
      0.5 * axes.reduce((n, a) => n + Math.abs(a.y), 0),
      0.5 * axes.reduce((n, a) => n + Math.abs(a.z), 0),
    )
    for (const b of c.blocks) {
      const center = new THREE.Vector3(...b.rel).applyQuaternion(q).add(pivot).add(delta)
      const minX = Math.floor(center.x - ext.x + 1e-4), maxX = Math.floor(center.x + ext.x - 1e-4)
      const minY = Math.floor(center.y - ext.y + 1e-4), maxY = Math.floor(center.y + ext.y - 1e-4)
      const minZ = Math.floor(center.z - ext.z + 1e-4), maxZ = Math.floor(center.z + ext.z - 1e-4)
      if (minY < GROUND_LEVEL || maxY >= 64) return false
      for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
        const key = posKey(x, y, z)
        if (sourceKeys.has(key) || key === oldKey) continue
        if (this.world.getBlock(x, y, z) !== B.AIR) return false
      }
    }

    // Remove all moving voxels first so the assembly can move into its own
    // former cells without overwriting a neighbouring chassis block.
    this.suppress = true
    for (const b of moving) {
      const [x, y, z] = parseKey(b.oldKey)
      this.world.setBlock(x, y, z, B.AIR)
    }
    for (const b of moving) this.world.setBlock(b.x, b.y, b.z, b.id, b.state)
    this.suppress = false

    const keyMap = new Map(moving.map((b) => [b.oldKey, b.newKey]))
    for (const b of moving) {
      const entry = this.models.get(b.oldKey)
      if (entry) {
        this.models.delete(b.oldKey)
        this.models.set(b.newKey, entry)
        // Motor and chassis-mounted component models translate but do not
        // inherit the rotor's quaternion.
        entry.model.group.position.add(delta)
      }
      const mounted = this.mountedWheels.get(b.oldKey)
      if (mounted) {
        this.mountedWheels.delete(b.oldKey)
        this.mountedWheels.set(b.newKey, mounted)
      }
      const glow = this.glows.get(b.oldKey)
      if (glow) {
        this.glows.delete(b.oldKey)
        glow.position.add(delta)
        this.glows.set(b.newKey, glow)
      }
    }

    for (const wire of this.wires) {
      let changed = false
      if (keyMap.has(wire.a)) { wire.a = keyMap.get(wire.a)!; wire.pa.add(delta); changed = true }
      if (keyMap.has(wire.b)) { wire.b = keyMap.get(wire.b)!; wire.pb.add(delta); changed = true }
      if (changed) updateWireMesh(wire.mesh, wire.pa, wire.pb)
    }

    // Keep the moving chassis records relative to the motor. Refresh their
    // keys/states so later steps use the current world state.
    for (const b of c.chassisBlocks) {
      b.origKey = posKey(nx + b.rel[0], ny + b.rel[1], nz + b.rel[2])
      const state = this.world.getState(nx + b.rel[0], ny + b.rel[1], nz + b.rel[2])
      b.state = state ? { ...state } : undefined
    }

    const power = this.motorPower.get(oldKey)
    const direction = this.motorDirection.get(oldKey)
    this.motorPower.delete(oldKey)
    this.motorDirection.delete(oldKey)
    if (power !== undefined) this.motorPower.set(targetKey, power)
    if (direction !== undefined) this.motorDirection.set(targetKey, direction)
    this.tractionVelocity.delete(oldKey)

    c.group.position.copy(new THREE.Vector3(nx + 0.5, ny + 0.5, nz + 0.5))
    c.motorPos = [nx, ny, nz]
    c.motorKey = targetKey
    this.contraptions.delete(oldKey)
    this.contraptions.set(targetKey, c)
    this.rebuildGlue()
    this.physicsDirty = true
    this.powerDirty = true
    return true
  }

  /* ---------------- Frame update ---------------- */

  update(dt: number) {
    if (this.rigidPhysics.ready && !this.physicsSynced) {
      this.physicsSynced = true
      this.physicsDirty = true
      this.mechDirty = true
    }
    this.updateGravity(dt)
    this.powerCooldown -= dt
    if (this.powerDirty && this.powerCooldown <= 0) {
      this.powerCooldown = 0.08
      this.powerDirty = false
      this.recomputePower()
      this.mechDirty = true
    }

    if (this.mechDirty) {
      this.mechDirty = false
      for (const [key, e] of this.models) {
        if (e.type !== 'motor') continue
        if ((this.motorPower.get(key) ?? 0) > 0 && !this.contraptions.has(key)) {
          e.status = this.tryAssemble(key)
        } else if (!this.contraptions.has(key)) {
          e.status = 'idle'
        }
      }
    }

    for (const [key, e] of this.models) {
      if (e.type === 'wheel') {
        const [x, y, z] = parseKey(key)
        let drive = 0
        for (const d of DIRS) {
          const neighbor = posKey(x + d[0], y + d[1], z + d[2])
          if (this.world.getBlock(x + d[0], y + d[1], z + d[2]) === B.MOTOR && (this.motorPower.get(neighbor) ?? 0) > 0) drive = (this.motorDirection.get(neighbor) ?? 1) * (this.motorPower.get(neighbor) ?? 0)
        }
        e.spin += drive * dt * 5
        e.model.rim.rotation.z = e.spin
        continue
      }
      if (e.type !== 'motor') continue
      const power = this.motorPower.get(key) ?? 0
      const c = this.contraptions.get(key)
      if (c) {
        e.model.shaft.rotation.z = c.angle
      } else if (power > 0 && e.status !== 'stalled') {
        e.spin += power * 2.4 * dt * (this.motorDirection.get(key) ?? 1)
        e.model.shaft.rotation.z = e.spin
      }
      const mounted = this.mountedWheels.get(key)
      if (mounted) {
        mounted.spin += power * dt * 5 * (this.motorDirection.get(key) ?? 1)
        mounted.model.rim.rotation.z = mounted.spin
        // The wheel is visual here. Do not translate/disassemble the voxel
        // assembly from this legacy traction path: the continuous rigid-body
        // solver below must own both translation and rotation.
      }
    }

    for (const c of [...this.contraptions.values()]) {
      const motorAlive = this.models.get(c.motorKey)?.type === 'motor'
      if (!motorAlive) {
        this.disassemble(c, Math.round(c.angle / HALF_PI) % 4)
        continue
      }
      const power = this.motorPower.get(c.motorKey) ?? 0
      const motor = this.models.get(c.motorKey)
      if (power > 0) {
        const direction = this.motorDirection.get(c.motorKey) ?? 1
        c.speed = power * 1.05 * direction
        c.unpoweredTime = 0
        // Torque is applied through the shaft joint. Rapier computes the
        // resulting rotation, chassis reaction, and every contact impulse.
        c.joint.configureMotorVelocity(c.speed, Math.max(3, power * 16))
        if (motor?.type === 'motor') motor.status = 'driving'
      } else {
        c.unpoweredTime += dt
        c.joint.configureMotorVelocity(0, 6)
        if (motor?.type === 'motor') motor.status = 'idle'
        const angular = c.rotorBody.angvel()
        const spin = Math.hypot(angular.x, angular.y, angular.z)
        if (c.unpoweredTime >= 0.55 && spin < 0.65) {
          this.disassemble(c, ((Math.round(c.angle / HALF_PI) % 4) + 4) % 4)
        }
      }
    }

    // All dynamic voxel groups and motor rotors use this one solver. No
    // rotation-specific floor correction or per-motor translation branch.
    if (this.rigidPhysics.ready) {
      this.rigidPhysics.step(dt)
      this.syncRigidTransforms()
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
      const rotation = c.rotorBody.rotation()
      const projected = rotation.x * c.axis.x + rotation.y * c.axis.y + rotation.z * c.axis.z
      c.angle = 2 * Math.atan2(projected, rotation.w)
      if (c.angle < 0) c.angle += Math.PI * 2
      const motor = this.models.get(c.motorKey)
      if (motor?.type === 'motor') motor.model.shaft.rotation.z = c.angle
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
    const h = player.height
    for (const c of this.contraptions.values()) {
      const q = new THREE.Quaternion().setFromAxisAngle(c.axis, c.angle)
      const pivot = c.group.position.clone()
      const ex=new THREE.Vector3(1,0,0).applyQuaternion(q)
      const ey=new THREE.Vector3(0,1,0).applyQuaternion(q)
      const ez=new THREE.Vector3(0,0,1).applyQuaternion(q)
      const hx=0.5*(Math.abs(ex.x)+Math.abs(ey.x)+Math.abs(ez.x))
      const hy=0.5*(Math.abs(ex.y)+Math.abs(ey.y)+Math.abs(ez.y))
      const hz=0.5*(Math.abs(ex.z)+Math.abs(ey.z)+Math.abs(ez.z))
      for (const b of c.blocks) {
        const center=new THREE.Vector3(...b.rel).applyQuaternion(q).add(pivot)
        const minX=center.x-hx,maxX=center.x+hx,minY=center.y-hy,maxY=center.y+hy,minZ=center.z-hz,maxZ=center.z+hz
        const px0=p.x-halfW,px1=p.x+halfW,py0=p.y,py1=p.y+h,pz0=p.z-halfW,pz1=p.z+halfW
        if (!(px0<maxX && px1>minX && py0<maxY && py1>minY && pz0<maxZ && pz1>minZ)) continue
        const penL=px1-minX, penR=maxX-px0, penD=py1-minY, penU=maxY-py0, penB=pz1-minZ, penF=maxZ-pz0
        const minPen=Math.min(penL,penR,penD,penU,penB,penF)
        if (minPen===penU) {
          p.y += penU + 0.002
          player.vel.y=Math.max(player.vel.y, Math.max(0,c.speed * 0.15))
          player.onGround=true
        } else if (minPen===penD) {
          p.y -= penD + 0.002
          player.vel.y=Math.min(player.vel.y,0)
        } else if (minPen===penL) { p.x += penL+0.002; player.vel.x=Math.max(player.vel.x, c.speed*0.2) }
        else if (minPen===penR) { p.x -= penR+0.002; player.vel.x=Math.min(player.vel.x, -c.speed*0.2) }
        else if (minPen===penB) { p.z += penB+0.002; player.vel.z=Math.max(player.vel.z, c.speed*0.2) }
        else { p.z -= penF+0.002; player.vel.z=Math.min(player.vel.z, -c.speed*0.2) }
        // Add a small tangential impulse so a side-sweeping arm pushes rather
        // than merely teleporting the player to the nearest non-overlap point.
        const rel=center.clone().sub(pivot)
        const tangential=new THREE.Vector3().crossVectors(c.axis,rel).multiplyScalar(c.speed)
        player.vel.x += tangential.x * Math.min(1,dt*3)
        player.vel.y += tangential.y * Math.min(1,dt*3)
        player.vel.z += tangential.z * Math.min(1,dt*3)
      }
    }
  }

  isMotorDriving(key: string) {
    return this.contraptions.has(key)
  }

  motorStatus(key: string) {
    const e = this.models.get(key)
    return e?.type === 'motor' ? e.status : 'idle'
  }
}
