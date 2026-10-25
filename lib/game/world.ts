import * as THREE from 'three'
import { B, CHUNK_SIZE, GROUND_LEVEL, WORLD_HEIGHT, isOpaque, posKey } from './constants'
import { buffersToGeometry, emitCube, newBuffers } from './mesher'
import { getTerrainBlock, getTerrainColor, getTerrainGlueMask, type WorldType } from './world-generation'
import type { MotorVariantId } from './motor-specs'

export interface BlockState {
  facing?: number
  batteries?: number
  glue?: number
  mountedWheel?: boolean
  motorType?: MotorVariantId
  /** Local quarter-turn component of the motor's discrete 3D orientation, 0–3. */
  motorRoll?: number
  switchOn?: boolean
  proximityOperator?: 'greater' | 'greaterEqual' | 'equal' | 'lessEqual' | 'less'
  proximityDistance?: number
  proximityActive?: boolean
  servoOffAngle?: number
  servoOnAngle?: number
  color?: string
  resinCoated?: boolean
  resistorDigit1?: number
  resistorDigit2?: number
  /** Base-10 exponent for the resistor's multiplier band. */
  resistorMultiplier?: number
  resistorTolerance?: number
  /** Fixed simulated deviation from nominal resistance, in percent. */
  resistorActualOffsetPct?: number
  /** Set when excessive forward current permanently damages an LED. */
  ledBurnedOut?: boolean
}

const CS = CHUNK_SIZE
const idx = (x: number, y: number, z: number) => (y * CS + z) * CS + x

export class Chunk {
  data = new Uint8Array(CS * CS * WORLD_HEIGHT)
  maxY = GROUND_LEVEL - 1
  mesh: THREE.Mesh | null = null
  windowMesh: THREE.Mesh | null = null
  dirty = true
  modified = false
  constructor(
    public cx: number,
    public cz: number,
    terrainAt?: (x: number, y: number, z: number) => number,
    terrainMaxY = WORLD_HEIGHT - 1,
  ) {
    if (!terrainAt) {
      for (let y = 0; y < GROUND_LEVEL; y++)
        for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) this.data[idx(x, y, z)] = B.ROBOTICS
      return
    }

    this.maxY = 0
    const lastGeneratedY = Math.min(WORLD_HEIGHT - 1, Math.max(0, terrainMaxY))
    for (let y = 0; y <= lastGeneratedY; y++)
      for (let z = 0; z < CS; z++)
        for (let x = 0; x < CS; x++) {
          const id = terrainAt(cx * CS + x, y, cz * CS + z)
          this.data[idx(x, y, z)] = id
          if (id !== B.AIR) this.maxY = Math.max(this.maxY, y)
        }
  }
}

export const chunkKey = (cx: number, cz: number) => `${cx},${cz}`

export class World {
  chunks = new Map<string, Chunk>()
  states = new Map<string, BlockState>()
  poweredLeds = new Set<string>()
  private waterMeshes: THREE.Mesh[] = []
  private waterMaterial: THREE.MeshBasicMaterial | null = null
  private windowMaterial: THREE.MeshBasicMaterial
  readonly waterSurfaceY = GROUND_LEVEL
  readonly waterBottomY = 1
  onBlockChange: (x: number, y: number, z: number, oldId: number, newId: number, oldHadGlue: boolean, newHasGlue: boolean) => void = () => {}

  constructor(
    private scene: THREE.Scene,
    private material: THREE.Material,
    public readonly type: WorldType = 'flat',
    public readonly seed = 20261023,
  ) {
    const atlas = (material as THREE.MeshBasicMaterial).map ?? null
    this.windowMaterial = new THREE.MeshBasicMaterial({
      map: atlas, vertexColors: true, transparent: true, opacity: 0.58,
      depthWrite: false, side: THREE.DoubleSide,
    })
    if (type === 'beach') this.createBeachWater()
  }

  private createBeachWater() {
    this.waterMaterial = new THREE.MeshBasicMaterial({
      color: 0x2dadd1,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const seaY = this.waterSurfaceY - 0.015
    const regions = [
      { x: 0, z: -37, width: 128, depth: 54 },
      { x: 0, z: 37, width: 128, depth: 54 },
      { x: -37, z: 0, width: 54, depth: 20 },
      { x: 37, z: 0, width: 54, depth: 20 },
    ]
    for (const region of regions) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(region.width, region.depth),
        this.waterMaterial,
      )
      mesh.rotation.x = -Math.PI / 2
      mesh.position.set(region.x, seaY, region.z)
      mesh.renderOrder = 3
      mesh.frustumCulled = false
      this.scene.add(mesh)
      this.waterMeshes.push(mesh)
    }
  }

  isWaterColumnAt(x: number, z: number) {
    if (this.type !== 'beach') return false
    const inSea = x >= -64 && x < 64 && z >= -64 && z < 64
    const onIsland = x >= -10 && x < 10 && z >= -10 && z < 10
    return inSea && !onIsland
  }

  /** Fraction of a one-block cube submerged in the beach's water volume. */
  waterSubmersionAt(x: number, y: number, z: number) {
    if (!this.isWaterColumnAt(x, z)) return 0
    const submergedTop = Math.min(y + 0.5, this.waterSurfaceY)
    const submergedBottom = Math.max(y - 0.5, this.waterBottomY)
    return Math.max(0, Math.min(1, submergedTop - submergedBottom))
  }

  dispose() {
    for (const mesh of this.waterMeshes) {
      this.scene.remove(mesh)
      mesh.geometry.dispose()
    }
    this.waterMeshes = []
    this.waterMaterial?.dispose()
    this.waterMaterial = null
    this.windowMaterial.dispose()
  }

  terrainBlockAt(x: number, y: number, z: number) {
    return getTerrainBlock(this.type, this.seed, x, y, z)
  }

  terrainColorAt(y: number, x: number, z: number) {
    return getTerrainColor(this.type, this.seed, x, y, z)
  }

  getChunk(cx: number, cz: number) {
    return this.chunks.get(chunkKey(cx, cz))
  }

  ensureChunk(cx: number, cz: number) {
    const k = chunkKey(cx, cz)
    let c = this.chunks.get(k)
    if (!c) {
      c = new Chunk(
        cx,
        cz,
        this.type === 'flat' ? undefined : (x, y, z) => this.terrainBlockAt(x, y, z),
        this.type === 'test_lab' ? GROUND_LEVEL + 10 : WORLD_HEIGHT - 1,
      )
      this.chunks.set(k, c)
      // Generated Mars structures need face-glue metadata so roofs and walls
      // stay attached as one rigid assembly when physics evaluates the colony.
      if (this.type === 'mars_colony' || this.type === 'venus_colony' || this.type === 'mystery_planet' || this.type === 'robot_city') {
        const bx = cx * CS
        const bz = cz * CS
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          for (let z = 0; z < CS; z++) {
            for (let x = 0; x < CS; x++) {
              const id = c.data[idx(x, y, z)]
              if (id === B.AIR || id === B.ROBOTICS || (id === B.COLOR_BLOCK && y < GROUND_LEVEL)) continue
              const wx = bx + x
              const wz = bz + z
              const glue = getTerrainGlueMask(this.type, this.seed, wx, y, wz)
              if (glue) this.states.set(posKey(wx, y, wz), { glue })
            }
          }
        }
      }
    }
    return c
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return this.terrainBlockAt(x, 0, z) === B.AIR ? B.AIR : B.ROBOTICS
    if (y >= WORLD_HEIGHT) return B.AIR
    const cx = Math.floor(x / CS)
    const cz = Math.floor(z / CS)
    const c = this.chunks.get(chunkKey(cx, cz))
    if (!c) return this.terrainBlockAt(x, y, z)
    return c.data[idx(x - cx * CS, y, z - cz * CS)]
  }

  setBlock(x: number, y: number, z: number, id: number, state?: BlockState) {
    if (y < 0 || y >= WORLD_HEIGHT) return false
    const cx = Math.floor(x / CS)
    const cz = Math.floor(z / CS)
    const c = this.ensureChunk(cx, cz)
    const lx = x - cx * CS
    const lz = z - cz * CS
    const old = c.data[idx(lx, y, lz)]
    const key = posKey(x, y, z)
    const oldHadGlue = Boolean(this.states.get(key)?.glue)
    const newHasGlue = Boolean(state?.glue)
    if (old === id) {
      if (state) {
        const previous = this.states.get(key)
        this.states.set(key, state)
        if (JSON.stringify(previous ?? null) !== JSON.stringify(state)) {
          c.modified = true
          this.markDirtyAround(x, y, z)
        }
      }
      return false
    }
    c.data[idx(lx, y, lz)] = id
    c.modified = true
    if (id !== B.AIR && y > c.maxY) c.maxY = y
    if (state) this.states.set(key, state)
    else this.states.delete(key)
    this.markDirtyAround(x, y, z)
    this.onBlockChange(x, y, z, old, id, oldHadGlue, newHasGlue)
    return true
  }

  getState(x: number, y: number, z: number) {
    return this.states.get(posKey(x, y, z))
  }

  ensureState(x: number, y: number, z: number) {
    const k = posKey(x, y, z)
    let s = this.states.get(k)
    if (!s) {
      s = {}
      this.states.set(k, s)
    }
    return s
  }

  markDirtyAround(x: number, y: number, z: number) {
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const c = this.getChunk(Math.floor((x + dx) / CS), Math.floor((z + dz) / CS))
        if (c) c.dirty = true
      }
    void y
  }

  markBlockDirty(x: number, y: number, z: number) {
    this.markDirtyAround(x, y, z)
  }

  isSolid(x: number, y: number, z: number) {
    const id = this.getBlock(x, y, z)
    // The switch uses a model instead of an opaque cube, but remains solid for player collision.
    return id === B.SWITCH || id === B.PROXIMITY_SENSOR || id === B.SERVO || id === B.ARDUINO_UNO || id === B.RESISTOR || isOpaque(id)
  }

  buildChunkMesh(c: Chunk) {
    const out = newBuffers()
    const windowOut = newBuffers()
    const bx = c.cx * CS
    const bz = c.cz * CS
    const maxY = Math.min(WORLD_HEIGHT - 1, c.maxY)
    for (let y = 0; y <= maxY; y++)
      for (let z = 0; z < CS; z++)
        for (let x = 0; x < CS; x++) {
          const id = c.data[idx(x, y, z)]
          if (!isOpaque(id)) continue
          const wx = bx + x
          const wz = bz + z
          const powered = id === B.LED && this.poweredLeds.has(posKey(wx, y, wz))
          const state = this.getState(wx, y, wz)
          const tint = state?.resinCoated ? '#e5c46a' : state?.ledBurnedOut ? '#212121' : state?.color ?? this.terrainColorAt(y, wx, wz)
          emitCube(id === B.WINDOW ? windowOut : out, wx, y, wz, id, powered, (dx, dy, dz) => {
            const nx = x + dx
            const nz = z + dz
            const ny = y + dy
            if (ny < 0) return true
            if (ny >= WORLD_HEIGHT) return false
            if (nx >= 0 && nx < CS && nz >= 0 && nz < CS) return isOpaque(c.data[idx(nx, ny, nz)])
            return isOpaque(this.getBlock(wx + dx, ny, wz + dz))
          }, tint)
        }
    if (c.mesh) {
      c.mesh.geometry.dispose()
      this.scene.remove(c.mesh)
      c.mesh = null
    }
    if (c.windowMesh) {
      c.windowMesh.geometry.dispose()
      this.scene.remove(c.windowMesh)
      c.windowMesh = null
    }
    if (out.indices.length > 0) {
      const m = new THREE.Mesh(buffersToGeometry(out), this.material)
      m.matrixAutoUpdate = false
      m.updateMatrix()
      this.scene.add(m)
      c.mesh = m
    }
    if (windowOut.indices.length > 0) {
      const m = new THREE.Mesh(buffersToGeometry(windowOut), this.windowMaterial)
      m.matrixAutoUpdate = false
      m.updateMatrix()
      m.renderOrder = 2
      this.scene.add(m)
      c.windowMesh = m
    }
    c.dirty = false
  }

  unloadChunk(c: Chunk) {
    if (c.mesh) {
      c.mesh.geometry.dispose()
      this.scene.remove(c.mesh)
      c.mesh = null
    }
    if (c.windowMesh) {
      c.windowMesh.geometry.dispose()
      this.scene.remove(c.windowMesh)
      c.windowMesh = null
    }
    c.dirty = true
    if (!c.modified) this.chunks.delete(chunkKey(c.cx, c.cz))
  }
}
