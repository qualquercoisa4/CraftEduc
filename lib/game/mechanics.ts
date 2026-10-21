import * as THREE from 'three'
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
  mesh: THREE.Mesh
}

interface FallingBody {
  blocks: FallingBlock[]
  velocity: THREE.Vector3
  settled: boolean
}

interface Contraption {
  motorKey: string
  motorPos: [number, number, number]
  axis: THREE.Vector3
  facing: number
  blocks: CBlock[]
  byKey: Map<string, CBlock>
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

  constructor(
    private world: World,
    private scene: THREE.Scene,
    private blockMaterial: THREE.Material,
    private glueMaterial: THREE.Material,
  ) {}

  /* ---------------- Block change hook ---------------- */

  onBlockChange(x: number, y: number, z: number, oldId: number, newId: number, oldHadGlue = false, newHasGlue = false) {
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
    const [mx, my, mz] = parseKey(motorKey)
    const facing = this.world.getState(mx, my, mz)?.facing ?? 2
    const d = DIRS[facing]
    // Discover the entire glue-connected component starting at the motor.
    // Do not seed only the block in front of the motor: chassis blocks are
    // often glued to its side or underside and must travel with it too.
    const visited = new Set<string>([motorKey])
    const queue: [number, number, number][] = [[mx, my, mz]]
    let hasAttachedBlock = false
    while (queue.length) {
      const [x, y, z] = queue.shift()!
      if (y < GROUND_LEVEL) return 'stalled'
      if (visited.size > MAX_CONTRAPTION) return 'stalled'
      for (let i = 0; i < 6; i++) {
        const n = DIRS[i]
        const nx = x + n[0]
        const ny = y + n[1]
        const nz = z + n[2]
        const k = posKey(nx, ny, nz)
        if (visited.has(k)) continue
        if (this.world.getBlock(nx, ny, nz) === B.AIR) continue
        if (!this.isGlued(x, y, z, i)) continue
        visited.add(k)
        queue.push([nx, ny, nz])
        if (k !== motorKey) hasAttachedBlock = true
      }
    }
    if (!hasAttachedBlock) return 'idle'

    const pivot = new THREE.Vector3(mx + 0.5, my + 0.5, mz + 0.5)
    const group = new THREE.Group()
    group.position.copy(pivot)
    const blocks: CBlock[] = []
    const byKey = new Map<string, CBlock>()
    const relMap = new Map<string, number>()

    // The motor and all recursively connected chassis/arm blocks are one body.
    for (const k of visited) {
      const [x, y, z] = parseKey(k)
      const id = this.world.getBlock(x, y, z)
      const st = this.world.getState(x, y, z)
      const cb: CBlock = {
        rel: [x - mx, y - my, z - mz],
        id,
        state: st ? { ...st } : undefined,
        origKey: k,
      }
      blocks.push(cb)
      byKey.set(k, cb)
      relMap.set(posKey(cb.rel[0], cb.rel[1], cb.rel[2]), id)
    }

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
        // Keep the motor's logical entry so power and motor status remain
        // addressable while its rendered model travels with the assembly.
        if (b.id !== B.MOTOR) this.models.delete(b.origKey)
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

    const wireEnds: Contraption['wireEnds'] = []
    for (const w of this.wires) {
      if (byKey.has(w.a)) wireEnds.push({ wire: w, end: 'a', local: w.pa.clone().sub(pivot), orig: w.pa.clone() })
      if (byKey.has(w.b)) wireEnds.push({ wire: w, end: 'b', local: w.pb.clone().sub(pivot), orig: w.pb.clone() })
    }

    this.suppress = true
    for (const b of blocks) {
      const [x, y, z] = parseKey(b.origKey)
      this.world.setBlock(x, y, z, B.AIR)
    }
    this.suppress = false
    this.rebuildGlue()
    this.scene.add(group)

    this.contraptions.set(motorKey, {
      motorKey,
      motorPos: [mx, my, mz],
      axis: new THREE.Vector3(d[0], d[1], d[2]),
      facing,
      blocks,
      byKey,
      group,
      angle: 0,
      speed: 0,
      wireEnds,
      reactionTravel: 0,
      velocity: new THREE.Vector3(),
    })
    return 'driving'
  }

  private disassemble(c: Contraption, quarterTurns: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(c.axis, quarterTurns * HALF_PI)
    const pivot = c.group.position.clone()
    const rotDir = (dir: number) => {
      const v = new THREE.Vector3(...DIRS[dir]).applyQuaternion(q)
      const r = [Math.round(v.x), Math.round(v.y), Math.round(v.z)]
      return DIRS.findIndex((d) => d[0] === r[0] && d[1] === r[1] && d[2] === r[2])
    }
    const keyMap = new Map<string, string | null>()

    disposeObject(c.group)
    this.contraptions.delete(c.motorKey)

    const placements: { x: number; y: number; z: number; id: number; state?: BlockState; orig: string }[] = []
    for (const b of c.blocks) {
      const v = new THREE.Vector3(...b.rel).applyQuaternion(q)
      const x = Math.round(pivot.x - 0.5 + v.x)
      const y = Math.round(pivot.y - 0.5 + v.y)
      const z = Math.round(pivot.z - 0.5 + v.z)
      let state = b.state ? { ...b.state } : undefined
      if (state) {
        if (state.facing !== undefined) state.facing = rotDir(state.facing)
        if (state.glue) {
          let m = 0
          for (let i = 0; i < 6; i++) if (state.glue & (1 << i)) m |= 1 << rotDir(i)
          state.glue = m
        }
        if (Object.keys(state).length === 0) state = undefined
      }
      placements.push({ x, y, z, id: b.id, state, orig: b.origKey })
    }
    for (const p of placements) {
      if (this.world.getBlock(p.x, p.y, p.z) === B.AIR && p.y >= GROUND_LEVEL) {
        this.world.setBlock(p.x, p.y, p.z, p.id, p.state)
        if (p.id === B.MOTOR || p.id === B.BATTERY_BOX) {
          const e = this.models.get(posKey(p.x, p.y, p.z))
          if (e?.type === 'motor' && p.state?.facing !== undefined) setMotorFacing(e.model, p.state.facing)
          if (e?.type === 'box') setBatteryCount(e.model, p.state?.batteries ?? 0)
        }
        keyMap.set(p.orig, posKey(p.x, p.y, p.z))
      } else {
        keyMap.set(p.orig, null)
      }
    }

    const doomed = new Set<Wire>()
    for (const we of c.wireEnds) {
      const newKey = keyMap.get(we.end === 'a' ? we.wire.a : we.wire.b)
      if (!newKey) {
        doomed.add(we.wire)
        continue
      }
      const np = we.orig.clone().sub(pivot).applyQuaternion(q).add(pivot)
      if (we.end === 'a') {
        we.wire.a = newKey
        we.wire.pa.copy(np)
      } else {
        we.wire.b = newKey
        we.wire.pb.copy(np)
      }
    }
    for (const we of c.wireEnds) {
      if (doomed.has(we.wire)) continue
      updateWireMesh(we.wire.mesh, we.wire.pa, we.wire.pb)
    }
    if (doomed.size) {
      for (const w of doomed) disposeObject(w.mesh)
      this.wires = this.wires.filter((w) => !doomed.has(w))
    }
    this.rebuildGlue()
    this.powerDirty = true
    this.mechDirty = true
  }

  /**
   * Rigid-body-like voxel gravity. Unsupported glued components are removed
   * from the static world and rendered as real moving meshes until they land.
   * Motion is integrated every frame, not teleported between grid cells.
   */
  private updateGravity(dt: number) {
    this.gravityTimer += dt
    this.physicsScanCooldown -= dt
    if (this.physicsDirty && this.physicsScanCooldown <= 0) {
      this.physicsScanCooldown = 0.35
      this.gravityTimer = 0
      this.physicsDirty = false
      this.detectUnsupportedBodies()
    }
    if (!this.fallingBodies.length) return
    const step = Math.min(dt, 0.05)
    for (let i = this.fallingBodies.length - 1; i >= 0; i--) {
      const body = this.fallingBodies[i]
      body.velocity.y = Math.max(-14, body.velocity.y - this.gravity * step)
      const dy = body.velocity.y * step
      let allowed = dy
      if (dy < 0) {
        let floorDistance = Infinity
        for (const b of body.blocks) {
          const currentCellY = Math.floor(b.y - 0.5 - 1e-4)
          const nextBottom = b.y - 0.5 + dy
          const nextCellY = Math.floor(nextBottom - 1e-4)
          if (nextCellY < currentCellY) {
            for (let y = currentCellY - 1; y >= nextCellY; y--) {
              const key = posKey(Math.round(b.x), y, Math.round(b.z))
              if (this.world.getBlock(Math.round(b.x), y, Math.round(b.z)) !== B.AIR && !this.fallingKeys.has(key)) {
                floorDistance = Math.min(floorDistance, b.y - 0.5 - (y + 1))
                break
              }
            }
          }
          if (b.y + dy - 0.5 <= GROUND_LEVEL) floorDistance = Math.min(floorDistance, b.y - 0.5 - GROUND_LEVEL)
        }
        if (floorDistance !== Infinity && -dy >= floorDistance) {
          allowed = -Math.max(0, floorDistance)
          body.velocity.y = 0
          body.settled = true
        }
      }
      for (const b of body.blocks) {
        b.y += allowed
        b.mesh.position.set(b.x + 0.5, b.y, b.z + 0.5)
      }
      if (body.settled) {
        this.landBody(body)
        this.fallingBodies.splice(i, 1)
      }
    }
  }

  private detectUnsupportedBodies() {
    const blocks: { key: string; x: number; y: number; z: number; id: number; state?: BlockState }[] = []
    const occupied = new Set<string>()
    for (const chunk of this.world.chunks.values()) {
      const minX = chunk.cx * 16, minZ = chunk.cz * 16
      for (let y = GROUND_LEVEL; y <= chunk.maxY; y++) {
        for (let z = minZ; z < minZ + 16; z++) for (let x = minX; x < minX + 16; x++) {
          const id = this.world.getBlock(x, y, z)
          if (id === B.AIR) continue
          const key = posKey(x, y, z)
          occupied.add(key)
          blocks.push({ key, x, y, z, id, state: this.world.getState(x, y, z) })
        }
      }
    }
    const byKey = new Map(blocks.map(b => [b.key, b]))
    const visited = new Set<string>()
    const fallingGroups: typeof blocks[] = []
    for (const b of blocks) {
      if (visited.has(b.key) || this.fallingKeys.has(b.key)) continue
      const group: typeof blocks = []
      const queue = [b]
      visited.add(b.key)
      while (queue.length) {
        const cur = queue.pop()!
        group.push(cur)
        for (let d = 0; d < 6; d++) {
          if (!this.isGlued(cur.x, cur.y, cur.z, d)) continue
          const n = DIRS[d], key = posKey(cur.x + n[0], cur.y + n[1], cur.z + n[2])
          const next = byKey.get(key)
          if (next && !visited.has(key)) { visited.add(key); queue.push(next) }
        }
      }
      if (group.some(v => v.id === B.MOTOR || v.id === B.BATTERY_BOX || v.id === B.LED || this.wiresAt(v.key).length || this.contraptionsHasBlock(v.key))) continue
      const keys = new Set(group.map(v => v.key))
      const supported = group.some(v => v.y <= GROUND_LEVEL || (() => {
        const below = posKey(v.x, v.y - 1, v.z)
        return occupied.has(below) && !keys.has(below)
      })())
      if (!supported) fallingGroups.push(group)
    }
    for (const group of fallingGroups) {
      const falling: FallingBlock[] = []
      for (const b of group) {
        const cubeBuffers = newBuffers()
        emitCube(cubeBuffers, 0, 0, 0, b.id, false, () => false)
        const geometry = buffersToGeometry(cubeBuffers)
        const mesh = new THREE.Mesh(geometry, this.blockMaterial)
        mesh.position.set(b.x + 0.5, b.y + 0.5, b.z + 0.5)
        mesh.castShadow = true
        mesh.receiveShadow = true
        this.scene.add(mesh)
        falling.push({ id: b.id, state: b.state ? { ...b.state } : undefined, x: b.x, y: b.y + 0.5, z: b.z, originKey: b.key, mesh })
        this.fallingKeys.add(b.key)
      }
      this.suppress = true
      for (const b of group) this.world.setBlock(b.x, b.y, b.z, B.AIR)
      this.suppress = false
      this.fallingBodies.push({ blocks: falling, velocity: new THREE.Vector3(0, 0, 0), settled: false })
    }
    if (fallingGroups.length) {
      this.rebuildGlue()
      this.powerDirty = true
      this.mechDirty = true
    }
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
  private translateContraption(c: Contraption, dx: number, dy: number, dz: number, angle = c.angle) {
    const [mx, my, mz] = c.motorPos
    const nx = mx + dx, ny = my + dy, nz = mz + dz
    if (ny < GROUND_LEVEL || ny >= 63) return false
    const targetKey = posKey(nx, ny, nz)
    if (this.world.getBlock(nx, ny, nz) !== B.AIR && targetKey !== c.motorKey) return false
    // Validate every rotated block at the destination before moving anything.
    const q = new THREE.Quaternion().setFromAxisAngle(c.axis, angle)
    const pivot = new THREE.Vector3(mx + 0.5, my + 0.5, mz + 0.5)
    const axes = [new THREE.Vector3(1,0,0).applyQuaternion(q), new THREE.Vector3(0,1,0).applyQuaternion(q), new THREE.Vector3(0,0,1).applyQuaternion(q)]
    const ext = new THREE.Vector3(
      0.5 * axes.reduce((n,a)=>n+Math.abs(a.x),0),
      0.5 * axes.reduce((n,a)=>n+Math.abs(a.y),0),
      0.5 * axes.reduce((n,a)=>n+Math.abs(a.z),0),
    )
    for (const b of c.blocks) {
      const center = new THREE.Vector3(...b.rel).applyQuaternion(q).add(pivot).add(new THREE.Vector3(dx,dy,dz))
      const minX=Math.floor(center.x-ext.x+1e-4), maxX=Math.floor(center.x+ext.x-1e-4)
      const minY=Math.floor(center.y-ext.y+1e-4), maxY=Math.floor(center.y+ext.y-1e-4)
      const minZ=Math.floor(center.z-ext.z+1e-4), maxZ=Math.floor(center.z+ext.z-1e-4)
      if (minY < GROUND_LEVEL || maxY >= 64) return false
      for(let y=minY;y<=maxY;y++) for(let z=minZ;z<=maxZ;z++) for(let x=minX;x<=maxX;x++) {
        // The pivot motor belongs to this same moving assembly.
        if (posKey(x,y,z) === c.motorKey) continue
        if (this.world.getBlock(x,y,z)!==B.AIR) return false
      }
    }
    const state = this.world.getState(mx, my, mz)
    this.suppress = true
    this.world.setBlock(mx, my, mz, B.AIR)
    this.world.setBlock(nx, ny, nz, B.MOTOR, state)
    this.suppress = false
    const oldKey = c.motorKey
    const entry = this.models.get(oldKey)
    if (entry?.type === 'motor') {
      // The motor model is a child of the rotating assembly; translating the
      // assembly already moves it in world space. Keep its local pivot intact.
      this.models.delete(oldKey)
      this.models.set(targetKey, entry)
    }
    const mounted = this.mountedWheels.get(oldKey)
    if (mounted) { this.mountedWheels.delete(oldKey); this.mountedWheels.set(targetKey, mounted) }
    const power = this.motorPower.get(oldKey)
    const direction = this.motorDirection.get(oldKey)
    this.motorPower.delete(oldKey); this.motorDirection.delete(oldKey)
    if (power !== undefined) this.motorPower.set(targetKey, power)
    if (direction !== undefined) this.motorDirection.set(targetKey, direction)
    this.tractionVelocity.delete(oldKey)
    c.group.position.add(new THREE.Vector3(dx, dy, dz))
    c.motorPos = [nx, ny, nz]
    c.motorKey = targetKey
    this.contraptions.delete(oldKey)
    this.contraptions.set(targetKey, c)
    this.physicsDirty = true
    this.powerDirty = true
    return true
  }

  /* ---------------- Frame update ---------------- */

  update(dt: number) {
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
      const [mx, my, mz] = c.motorPos
      const motorAlive = this.contraptions.has(c.motorKey) && this.models.get(c.motorKey)?.type === 'motor'
      const power = motorAlive ? (this.motorPower.get(c.motorKey) ?? 0) : 0
      if (!motorAlive) {
        this.disassemble(c, Math.round(c.angle / HALF_PI) % 4)
        continue
      }
      if (power > 0) {
        const model = this.models.get(c.motorKey)
        const direction = this.motorDirection.get(c.motorKey) ?? 1
        const nextSpeed = power * 1.05 * direction
        let nextAngle = (c.angle + nextSpeed * dt) % (Math.PI * 2)
        if (nextAngle < 0) nextAngle += Math.PI * 2
        if (model?.type === 'motor' && !this.canRotateContraption(c, nextAngle)) {
          // If the arm is trying to penetrate the floor, the ground reaction
          // lifts the complete machine. Never allow rotor blocks to be clipped
          // away by the floor's static voxel layer.
          const qNext = new THREE.Quaternion().setFromAxisAngle(c.axis, nextAngle)
          const pivot = c.group.position.clone()
          let floorContact = false
          for (const b of c.blocks) {
            const center = new THREE.Vector3(...b.rel).applyQuaternion(qNext).add(pivot)
            const ex = new THREE.Vector3(1,0,0).applyQuaternion(qNext)
            const ey = new THREE.Vector3(0,1,0).applyQuaternion(qNext)
            const ez = new THREE.Vector3(0,0,1).applyQuaternion(qNext)
            const halfY=0.5*(Math.abs(ex.y)+Math.abs(ey.y)+Math.abs(ez.y))
            if (center.y-halfY < GROUND_LEVEL-1e-4) { floorContact=true; break }
          }
          if (floorContact) {
            // Resolve the impact at the attempted angle BEFORE lifting. The
            // old code lifted vertically first, which removed ground contact
            // before the horizontal reaction had a chance to move the chassis.
            let pushX = 0, pushZ = 0, pushWeight = 0
            for (const b of c.blocks) {
              const rel = new THREE.Vector3(...b.rel).applyQuaternion(qNext)
              const center = rel.clone().add(pivot)
              const ex = new THREE.Vector3(1,0,0).applyQuaternion(qNext)
              const ey = new THREE.Vector3(0,1,0).applyQuaternion(qNext)
              const ez = new THREE.Vector3(0,0,1).applyQuaternion(qNext)
              const halfY = 0.5 * (Math.abs(ex.y) + Math.abs(ey.y) + Math.abs(ez.y))
              const bottom = center.y - halfY
              const tangent = new THREE.Vector3().crossVectors(c.axis, rel).multiplyScalar(nextSpeed)
              if (bottom <= GROUND_LEVEL + 0.12 && tangent.y < -0.01) {
                pushX -= tangent.x
                pushZ -= tangent.z
                pushWeight += 1
              }
            }
            if (pushWeight) { pushX /= pushWeight; pushZ /= pushWeight }
            let moved = false
            if (pushWeight && Math.hypot(pushX,pushZ) > 0.01) {
              const dx = Math.abs(pushX) >= Math.abs(pushZ) ? Math.sign(pushX) : 0
              const dz = dx ? 0 : Math.sign(pushZ)
              // Move opposite the arm sweep while raising the entire machine;
              // this creates a real step instead of erasing/clipping the arm.
              if (dx || dz) moved = this.translateContraption(c,dx,1,dz,nextAngle)
            }
            if (!moved) moved = this.translateContraption(c,0,1,0,nextAngle)
            if (moved) {
              c.speed = nextSpeed
              c.angle = nextAngle
              const movedModel=this.models.get(c.motorKey)
              if (movedModel?.type==='motor') movedModel.status='driving'
            } else {
              model.status = 'stalled'
              c.speed = 0
            }
          } else {
            c.speed = nextSpeed
            c.angle = nextAngle
            if (model?.type === 'motor') model.status = 'driving'
          }
        } else {
          c.speed = nextSpeed
          c.angle = nextAngle
          if (model?.type === 'motor') model.status = 'driving'
        }
      } else {
        const direction = Math.sign(c.speed || 1)
        const target = direction > 0
          ? Math.ceil(c.angle / HALF_PI - 1e-4) * HALF_PI
          : Math.floor(c.angle / HALF_PI + 1e-4) * HALF_PI
        const step = direction * Math.max(Math.abs(c.speed), 1.2) * dt
        c.angle = direction > 0 ? Math.min(target, c.angle + step) : Math.max(target, c.angle + step)
        const reached = direction > 0 ? c.angle >= target - 1e-5 : c.angle <= target + 1e-5
        if (reached) {
          this.disassemble(c, ((Math.round(target / HALF_PI) % 4) + 4) % 4)
          continue
        }
      }
      c.group.quaternion.setFromAxisAngle(c.axis, c.angle)
      // Continuous rigid-body motion: the entire glued assembly leaves the
      // voxel grid while the motor is powered. Floor contact applies equal and
      // opposite force; gravity and inertia keep motion smooth between contacts.
      if (Math.abs(c.axis.y) < 0.5 && c.blocks.length) {
        const pivot = c.group.position.clone()
        const q = new THREE.Quaternion().setFromAxisAngle(c.axis, c.angle)
        const ex = new THREE.Vector3(1,0,0).applyQuaternion(q)
        const ey = new THREE.Vector3(0,1,0).applyQuaternion(q)
        const ez = new THREE.Vector3(0,0,1).applyQuaternion(q)
        const halfY = 0.5 * (Math.abs(ex.y)+Math.abs(ey.y)+Math.abs(ez.y))
        let contacts = 0
        const reaction = new THREE.Vector3()
        let upward = 0
        for (const b of c.blocks) {
          const rel = new THREE.Vector3(...b.rel).applyQuaternion(q)
          const center = rel.clone().add(pivot)
          const bottom = center.y - halfY
          const tangent = new THREE.Vector3().crossVectors(c.axis, rel).multiplyScalar(c.speed)
          if (bottom <= GROUND_LEVEL + 0.1 && bottom >= GROUND_LEVEL - 0.12 && tangent.y < -0.01) {
            // Ground force opposes the arm's tangential movement. Keep its
            // horizontal and vertical components; do not teleport any blocks.
            reaction.x -= tangent.x
            reaction.z -= tangent.z
            upward += -tangent.y
            contacts++
          }
        }
        if (contacts > 0 && power > 0) {
          reaction.multiplyScalar(1 / contacts)
          const mass = Math.max(1, c.blocks.length * 0.35 + 1)
          c.velocity.x += reaction.x * dt * 2.2 / mass
          c.velocity.z += reaction.z * dt * 2.2 / mass
          c.velocity.y += Math.min(5, upward / contacts * 0.9) * dt
        }
        // Gravity and drag apply continuously, even when the arms are not in
        // contact. This is what makes the assembly fall back down naturally.
        c.velocity.y -= 9.81 * dt
        c.velocity.x *= Math.exp(-0.65 * dt)
        c.velocity.z *= Math.exp(-0.65 * dt)
        c.group.position.addScaledVector(c.velocity, dt)
        // Static floor collision: clamp the whole body, never delete individual
        // blocks that overlap the floor. Arms can push the pivot up next frame.
        let minBottom = Infinity
        for (const b of c.blocks) {
          const rel = new THREE.Vector3(...b.rel).applyQuaternion(q)
          const center = rel.clone().add(c.group.position)
          minBottom = Math.min(minBottom, center.y - halfY)
        }
        if (minBottom < GROUND_LEVEL) {
          c.group.position.y += GROUND_LEVEL - minBottom
          if (c.velocity.y < 0) c.velocity.y = 0
        }
      }
      if (c.wireEnds.length) {
        c.group.updateMatrixWorld(true)
        for (const we of c.wireEnds) {
          const p = c.group.localToWorld(we.local.clone())
          if (we.end === 'a') we.wire.pa.copy(p)
          else we.wire.pb.copy(p)
        }
        const touched = new Set(c.wireEnds.map((w) => w.wire))
        for (const w of touched) updateWireMesh(w.mesh, w.pa, w.pb)
      }
    }
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
