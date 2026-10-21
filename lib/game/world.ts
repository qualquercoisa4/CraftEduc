import * as THREE from 'three'
import { B, CHUNK_SIZE, GROUND_LEVEL, WORLD_HEIGHT, isOpaque, posKey } from './constants'
import { buffersToGeometry, emitCube, newBuffers } from './mesher'

export interface BlockState {
  facing?: number
  batteries?: number
  glue?: number
  mountedWheel?: boolean
  switchOn?: boolean
}

const CS = CHUNK_SIZE
const idx = (x: number, y: number, z: number) => (y * CS + z) * CS + x

export class Chunk {
  data = new Uint8Array(CS * CS * WORLD_HEIGHT)
  maxY = GROUND_LEVEL - 1
  mesh: THREE.Mesh | null = null
  dirty = true
  modified = false
  constructor(
    public cx: number,
    public cz: number,
  ) {
    for (let y = 0; y < GROUND_LEVEL; y++)
      for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) this.data[idx(x, y, z)] = B.ROBOTICS
  }
}

export const chunkKey = (cx: number, cz: number) => `${cx},${cz}`

export class World {
  chunks = new Map<string, Chunk>()
  states = new Map<string, BlockState>()
  poweredLeds = new Set<string>()
  onBlockChange: (x: number, y: number, z: number, oldId: number, newId: number, oldHadGlue: boolean, newHasGlue: boolean) => void = () => {}

  constructor(
    private scene: THREE.Scene,
    private material: THREE.Material,
  ) {}

  getChunk(cx: number, cz: number) {
    return this.chunks.get(chunkKey(cx, cz))
  }

  ensureChunk(cx: number, cz: number) {
    const k = chunkKey(cx, cz)
    let c = this.chunks.get(k)
    if (!c) {
      c = new Chunk(cx, cz)
      this.chunks.set(k, c)
    }
    return c
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return B.ROBOTICS
    if (y >= WORLD_HEIGHT) return B.AIR
    const cx = Math.floor(x / CS)
    const cz = Math.floor(z / CS)
    const c = this.chunks.get(chunkKey(cx, cz))
    if (!c) return y < GROUND_LEVEL ? B.ROBOTICS : B.AIR
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
      if (state) this.states.set(posKey(x, y, z), state)
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
    return id === B.SWITCH || isOpaque(id)
  }

  buildChunkMesh(c: Chunk) {
    const out = newBuffers()
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
          emitCube(out, wx, y, wz, id, powered, (dx, dy, dz) => {
            const nx = x + dx
            const nz = z + dz
            const ny = y + dy
            if (ny < 0) return true
            if (ny >= WORLD_HEIGHT) return false
            if (nx >= 0 && nx < CS && nz >= 0 && nz < CS) return isOpaque(c.data[idx(nx, ny, nz)])
            return isOpaque(this.getBlock(wx + dx, ny, wz + dz))
          })
        }
    if (c.mesh) {
      c.mesh.geometry.dispose()
      this.scene.remove(c.mesh)
      c.mesh = null
    }
    if (out.indices.length > 0) {
      const m = new THREE.Mesh(buffersToGeometry(out), this.material)
      m.matrixAutoUpdate = false
      m.updateMatrix()
      this.scene.add(m)
      c.mesh = m
    }
    c.dirty = false
  }

  unloadChunk(c: Chunk) {
    if (c.mesh) {
      c.mesh.geometry.dispose()
      this.scene.remove(c.mesh)
      c.mesh = null
    }
    c.dirty = true
    if (!c.modified) this.chunks.delete(chunkKey(c.cx, c.cz))
  }
}
