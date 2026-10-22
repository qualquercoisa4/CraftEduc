import * as THREE from 'three'
import { DIRS } from './constants'
import { tileFor, tileUV } from './textures'

type Corner = { pos: [number, number, number]; uv: [number, number] }

/** Indexed by direction: 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z */
export const FACES: Corner[][] = [
  [
    { pos: [1, 1, 1], uv: [0, 1] },
    { pos: [1, 0, 1], uv: [0, 0] },
    { pos: [1, 1, 0], uv: [1, 1] },
    { pos: [1, 0, 0], uv: [1, 0] },
  ],
  [
    { pos: [0, 1, 0], uv: [0, 1] },
    { pos: [0, 0, 0], uv: [0, 0] },
    { pos: [0, 1, 1], uv: [1, 1] },
    { pos: [0, 0, 1], uv: [1, 0] },
  ],
  [
    { pos: [0, 1, 1], uv: [1, 1] },
    { pos: [1, 1, 1], uv: [0, 1] },
    { pos: [0, 1, 0], uv: [1, 0] },
    { pos: [1, 1, 0], uv: [0, 0] },
  ],
  [
    { pos: [1, 0, 1], uv: [1, 0] },
    { pos: [0, 0, 1], uv: [0, 0] },
    { pos: [1, 0, 0], uv: [1, 1] },
    { pos: [0, 0, 0], uv: [0, 1] },
  ],
  [
    { pos: [0, 0, 1], uv: [0, 0] },
    { pos: [1, 0, 1], uv: [1, 0] },
    { pos: [0, 1, 1], uv: [0, 1] },
    { pos: [1, 1, 1], uv: [1, 1] },
  ],
  [
    { pos: [1, 0, 0], uv: [0, 0] },
    { pos: [0, 0, 0], uv: [1, 0] },
    { pos: [1, 1, 0], uv: [0, 1] },
    { pos: [0, 1, 0], uv: [1, 1] },
  ],
]

export const FACE_SHADE = [0.62, 0.62, 1, 0.5, 0.8, 0.8]
const AO_LEVELS = [0.55, 0.7, 0.85, 1]

export interface MeshBuffers {
  positions: number[]
  uvs: number[]
  colors: number[]
  indices: number[]
}

export function newBuffers(): MeshBuffers {
  return { positions: [], uvs: [], colors: [], indices: [] }
}

/**
 * Emits visible faces of one cube.
 * `solid(dx,dy,dz)` answers whether the neighbor relative to this block is opaque.
 */
export function emitCube(
  out: MeshBuffers,
  ox: number,
  oy: number,
  oz: number,
  id: number,
  powered: boolean,
  solid: (dx: number, dy: number, dz: number) => boolean,
  tintHex?: string,
) {
  const tile = tileFor(id, powered)
  const tint = tintHex ? new THREE.Color(tintHex) : null
  const [u0, v0, u1, v1] = tileUV(tile)
  for (let d = 0; d < 6; d++) {
    const n = DIRS[d]
    if (solid(n[0], n[1], n[2])) continue
    const corners = FACES[d]
    const base = out.positions.length / 3
    const ao: number[] = []
    const axisN = n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2
    const ua = (axisN + 1) % 3
    const va = (axisN + 2) % 3
    for (const c of corners) {
      out.positions.push(ox + c.pos[0], oy + c.pos[1], oz + c.pos[2])
      out.uvs.push(c.uv[0] ? u1 : u0, c.uv[1] ? v1 : v0)
      let level = 3
      if (!powered) {
        const off = [n[0], n[1], n[2]]
        const su = c.pos[ua] ? 1 : -1
        const sv = c.pos[va] ? 1 : -1
        const a = [...off]
        a[ua] += su
        const b = [...off]
        b[va] += sv
        const cc = [...off]
        cc[ua] += su
        cc[va] += sv
        const s1 = solid(a[0], a[1], a[2]) ? 1 : 0
        const s2 = solid(b[0], b[1], b[2]) ? 1 : 0
        const s3 = solid(cc[0], cc[1], cc[2]) ? 1 : 0
        level = s1 && s2 ? 0 : 3 - (s1 + s2 + s3)
      }
      ao.push(level)
      const l = powered ? 1 : (AO_LEVELS[level] * FACE_SHADE[d]) ** 2.2
      out.colors.push(l * (tint?.r ?? 1), l * (tint?.g ?? 1), l * (tint?.b ?? 1))
    }
    if (ao[0] + ao[3] > ao[1] + ao[2]) {
      out.indices.push(base, base + 1, base + 3, base, base + 3, base + 2)
    } else {
      out.indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
    }
  }
}

export function buffersToGeometry(b: MeshBuffers) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uvs, 2))
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.colors, 3))
  g.setIndex(b.indices)
  g.computeBoundingSphere()
  return g
}

/** Glue decals: each entry is a block origin plus a 6-bit face mask. */
export function buildGlueGeometry(entries: { x: number; y: number; z: number; mask: number }[]) {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const e = 0.006
  for (const { x, y, z, mask } of entries) {
    for (let d = 0; d < 6; d++) {
      if (!(mask & (1 << d))) continue
      const n = DIRS[d]
      const base = positions.length / 3
      for (const c of FACES[d]) {
        positions.push(x + c.pos[0] + n[0] * e, y + c.pos[1] + n[1] * e, z + c.pos[2] + n[2] * e)
        uvs.push(c.uv[0], c.uv[1])
      }
      indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(indices)
  g.computeBoundingSphere()
  return g
}
