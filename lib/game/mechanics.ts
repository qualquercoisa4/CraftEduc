import * as THREE from 'three'
import { B, DIRS, GROUND_LEVEL, OPPOSITE, isOpaque, parseKey, posKey } from './constants'
import { buffersToGeometry, buildGlueGeometry, emitCube, newBuffers } from './mesher'
import {
  type BatteryBoxModel,
  type MotorModel,
  createBatteryBoxModel,
  createGlowSprite,
  createMotorModel,
  createWireMesh,
  disposeObject,
  setBatteryCount,
  setMotorFacing,
  updateWireMesh,
} from './models'
import type { BlockState, World } from './world'

const HALF_PI = Math.PI / 2
const MAX_CONTRAPTION = 400

type ModelEntry =
  | { type: 'motor'; model: MotorModel; spin: number; status: 'idle' | 'stalled' | 'driving' }
  | { type: 'box'; model: BatteryBoxModel }

export interface Wire {
  id: number
  a: string
  b: string
  pa: THREE.Vector3
  pb: THREE.Vector3
  mesh: THREE.Group
}

interface CBlock {
  rel: [number, number, number]
  id: number
  state?: BlockState
  origKey: string
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
}

export class Mechanics {
  models = new Map<string, ModelEntry>()
  wires: Wire[] = []
  contraptions = new Map<string, Contraption>()
  glows = new Map<string, THREE.Sprite>()
  motorPower = new Map<string, number>()
  private glueMesh: THREE.Mesh | null = null
  private suppress = false
  private powerDirty = true
  private mechDirty = true
  private wireId = 0

  constructor(
    private world: World,
    private scene: THREE.Scene,
    private blockMaterial: THREE.Material,
    private glueMaterial: THREE.Material,
  ) {}

  /* ---------------- Block change hook ---------------- */

  onBlockChange(x: number, y: number, z: number, oldId: number, newId: number) {
    if (this.suppress) return
    const key = posKey(x, y, z)
    if (oldId === B.MOTOR || oldId === B.BATTERY_BOX) {
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
    }
    this.rebuildGlue()
    this.powerDirty = true
    this.mechDirty = true
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

  addWire(a: string, pa: THREE.Vector3, b: string, pb: THREE.Vector3) {
    const mesh = createWireMesh(pa, pb)
    this.scene.add(mesh)
    this.wires.push({ id: ++this.wireId, a, b, pa: pa.clone(), pb: pb.clone(), mesh })
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
    const nodes = new Set<string>()
    for (const w of this.wires) {
      nodes.add(w.a)
      nodes.add(w.b)
      union(w.a, w.b)
    }
    const charge = new Map<string, number>()
    const info = new Map<string, { id: number; state?: BlockState }>()
    for (const n of nodes) {
      const b = this.lookup(n)
      info.set(n, b)
      if (b.id === B.BATTERY_BOX) {
        const root = find(n)
        charge.set(root, Math.max(charge.get(root) ?? 0, b.state?.batteries ?? 0))
      }
    }
    const leds = new Set<string>()
    this.motorPower.clear()
    for (const n of nodes) {
      const level = charge.get(find(n)) ?? 0
      if (level <= 0) continue
      const b = info.get(n)!
      if (b.id === B.LED) leds.add(n)
      if (b.id === B.MOTOR) this.motorPower.set(n, level)
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
        const s = createGlowSprite()
        s.position.set(x + 0.5, y + 0.5, z + 0.5)
        this.scene.add(s)
        this.glows.set(k, s)
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
    const sx = mx + d[0]
    const sy = my + d[1]
    const sz = mz + d[2]
    if (this.world.getBlock(sx, sy, sz) === B.AIR) return 'idle'
    if (!this.isGlued(mx, my, mz, facing)) return 'idle'

    const visited = new Set<string>([posKey(sx, sy, sz)])
    const queue: [number, number, number][] = [[sx, sy, sz]]
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
        if (visited.has(k) || k === motorKey) continue
        if (this.world.getBlock(nx, ny, nz) === B.AIR) continue
        if (!this.isGlued(x, y, z, i)) continue
        visited.add(k)
        queue.push([nx, ny, nz])
      }
    }

    const pivot = new THREE.Vector3(mx + 0.5, my + 0.5, mz + 0.5)
    const group = new THREE.Group()
    group.position.copy(pivot)
    const blocks: CBlock[] = []
    const byKey = new Map<string, CBlock>()
    const relMap = new Map<string, number>()

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
        this.models.delete(b.origKey)
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
    })
    return 'driving'
  }

  private disassemble(c: Contraption, quarterTurns: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(c.axis, quarterTurns * HALF_PI)
    const pivot = new THREE.Vector3(c.motorPos[0] + 0.5, c.motorPos[1] + 0.5, c.motorPos[2] + 0.5)
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
      const x = c.motorPos[0] + Math.round(v.x)
      const y = c.motorPos[1] + Math.round(v.y)
      const z = c.motorPos[2] + Math.round(v.z)
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

  /* ---------------- Frame update ---------------- */

  update(dt: number) {
    if (this.powerDirty) {
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
      if (e.type !== 'motor') continue
      const power = this.motorPower.get(key) ?? 0
      const c = this.contraptions.get(key)
      if (c) {
        e.model.shaft.rotation.z = c.angle
      } else if (power > 0 && e.status !== 'stalled') {
        e.spin += power * 2.4 * dt
        e.model.shaft.rotation.z = e.spin
      }
    }

    for (const c of [...this.contraptions.values()]) {
      const [mx, my, mz] = c.motorPos
      const motorAlive = this.world.getBlock(mx, my, mz) === B.MOTOR
      const power = motorAlive ? (this.motorPower.get(c.motorKey) ?? 0) : 0
      if (!motorAlive) {
        this.disassemble(c, Math.round(c.angle / HALF_PI) % 4)
        continue
      }
      if (power > 0) {
        c.speed = power * 1.05
        c.angle += c.speed * dt
        if (c.angle > Math.PI * 2) c.angle -= Math.PI * 2
      } else {
        const target = Math.ceil(c.angle / HALF_PI - 1e-4) * HALF_PI
        c.angle = Math.min(target, c.angle + Math.max(c.speed, 1.2) * dt)
        if (c.angle >= target - 1e-5) {
          this.disassemble(c, Math.round(target / HALF_PI) % 4)
          continue
        }
      }
      c.group.quaternion.setFromAxisAngle(c.axis, c.angle)
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

  isMotorDriving(key: string) {
    return this.contraptions.has(key)
  }

  motorStatus(key: string) {
    const e = this.models.get(key)
    return e?.type === 'motor' ? e.status : 'idle'
  }
}
