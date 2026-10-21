import * as THREE from 'three'
import { T, TILE } from './textures'

interface Particle {
  p: THREE.Vector3
  v: THREE.Vector3
  life: number
  size: number
  uv: [number, number, number, number]
  shade: number
}

const MAX = 600

export class Particles {
  mesh: THREE.Mesh
  private list: Particle[] = []
  private pos = new Float32Array(MAX * 4 * 3)
  private uv = new Float32Array(MAX * 4 * 2)
  private col = new Float32Array(MAX * 4 * 3)
  private geo = new THREE.BufferGeometry()

  constructor(
    material: THREE.MeshBasicMaterial,
    private isSolid: (x: number, y: number, z: number) => boolean,
  ) {
    const idx: number[] = []
    for (let i = 0; i < MAX; i++) {
      const b = i * 4
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
    }
    this.geo.setIndex(idx)
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2))
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3))
    this.geo.setDrawRange(0, 0)
    this.mesh = new THREE.Mesh(this.geo, material)
    this.mesh.frustumCulled = false
  }

  burst(x: number, y: number, z: number, tile: number, count = 28) {
    const w = 1 / T.COUNT
    for (let i = 0; i < count; i++) {
      if (this.list.length >= MAX) this.list.shift()
      const px = Math.floor(Math.random() * 12)
      const py = Math.floor(Math.random() * 12)
      const u0 = tile * w + (px / TILE) * w
      const u1 = u0 + (4 / TILE) * w
      const v0 = py / TILE
      const v1 = v0 + 4 / TILE
      this.list.push({
        p: new THREE.Vector3(x + 0.15 + Math.random() * 0.7, y + 0.15 + Math.random() * 0.7, z + 0.15 + Math.random() * 0.7),
        v: new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 3.5 + 0.5, (Math.random() - 0.5) * 3),
        life: 0.45 + Math.random() * 0.7,
        size: 0.07 + Math.random() * 0.07,
        uv: [u0, v0, u1, v1],
        shade: 0.75 + Math.random() * 0.25,
      })
    }
  }

  update(dt: number, camera: THREE.Camera) {
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
    let n = 0
    this.list = this.list.filter((pt) => {
      pt.life -= dt
      if (pt.life <= 0) return false
      pt.v.y -= 16 * dt
      const nx = pt.p.x + pt.v.x * dt
      const ny = pt.p.y + pt.v.y * dt
      const nz = pt.p.z + pt.v.z * dt
      if (this.isSolid(Math.floor(nx), Math.floor(ny), Math.floor(nz))) {
        pt.v.set(0, 0, 0)
      } else {
        pt.p.set(nx, ny, nz)
      }
      return true
    })
    for (const pt of this.list) {
      const s = pt.size
      const b = n * 4
      const corners = [
        [-s, -s],
        [s, -s],
        [s, s],
        [-s, s],
      ]
      const uvs = [
        [pt.uv[0], pt.uv[1]],
        [pt.uv[2], pt.uv[1]],
        [pt.uv[2], pt.uv[3]],
        [pt.uv[0], pt.uv[3]],
      ]
      for (let i = 0; i < 4; i++) {
        const [cx, cy] = corners[i]
        this.pos[(b + i) * 3] = pt.p.x + right.x * cx + up.x * cy
        this.pos[(b + i) * 3 + 1] = pt.p.y + right.y * cx + up.y * cy
        this.pos[(b + i) * 3 + 2] = pt.p.z + right.z * cx + up.z * cy
        this.uv[(b + i) * 2] = uvs[i][0]
        this.uv[(b + i) * 2 + 1] = uvs[i][1]
        this.col[(b + i) * 3] = pt.shade
        this.col[(b + i) * 3 + 1] = pt.shade
        this.col[(b + i) * 3 + 2] = pt.shade
      }
      n++
    }
    this.geo.setDrawRange(0, n * 6)
    this.geo.attributes.position.needsUpdate = true
    this.geo.attributes.uv.needsUpdate = true
    this.geo.attributes.color.needsUpdate = true
  }
}
