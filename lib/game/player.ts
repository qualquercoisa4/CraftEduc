import * as THREE from 'three'
import { B, blockBounds } from './constants'
import type { World } from './world'

export interface MoveInput {
  forward: number
  strafe: number
  jump: boolean
  sneak: boolean
  sprint: boolean
  flyUp: boolean
  flyDown: boolean
}

const HALF_W = 0.3
const EPS = 1e-7

export class Player {
  pos = new THREE.Vector3(0.5, 4, 0.5)
  vel = new THREE.Vector3()
  yaw = 0
  pitch = 0
  onGround = false
  flying = false
  sneaking = false
  sprinting = false
  eye = 1.62
  walkDist = 0
  bob = 0
  horizontalCollision = false

  constructor(private world: World) {}

  get height() {
    return this.sneaking && !this.flying ? 1.5 : 1.8
  }

  private boxesIn(minx: number, miny: number, minz: number, maxx: number, maxy: number, maxz: number) {
    const out: number[][] = []
    for (let x = Math.floor(minx); x <= Math.floor(maxx - EPS); x++)
      for (let y = Math.floor(miny); y <= Math.floor(maxy - EPS); y++)
        for (let z = Math.floor(minz); z <= Math.floor(maxz - EPS); z++) {
          const id = this.world.getBlock(x, y, z)
          // Motors and wheels are mechanisms, not solid player barriers. In
          // particular, a powered rotor must never pin or carry the player.
          if (id === B.AIR || id === B.MOTOR || id === B.WHEEL) continue
          const b = blockBounds(id)
          out.push([x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5]])
        }
    return out
  }

  aabb(pos = this.pos, h = this.height) {
    return [pos.x - HALF_W, pos.y, pos.z - HALF_W, pos.x + HALF_W, pos.y + h, pos.z + HALF_W]
  }

  collidesAt(pos: THREE.Vector3, h = this.height) {
    const a = this.aabb(pos, h)
    const boxes = this.boxesIn(a[0], a[1], a[2], a[3], a[4], a[5])
    return boxes.some(
      (b) => a[0] < b[3] && a[3] > b[0] && a[1] < b[4] && a[4] > b[1] && a[2] < b[5] && a[5] > b[2],
    )
  }

  intersectsBlock(x: number, y: number, z: number, id: number) {
    const a = this.aabb()
    const b = blockBounds(id)
    return (
      a[0] < x + b[3] && a[3] > x + b[0] && a[1] < y + b[4] && a[4] > y + b[1] && a[2] < z + b[5] && a[5] > z + b[2]
    )
  }

  private moveAxis(axis: 0 | 1 | 2, d: number) {
    if (d === 0) return 0
    const a = this.aabb()
    const min = [...a]
    const max = [...a]
    if (d > 0) max[3 + axis] += d
    else min[axis] += d
    const boxes = this.boxesIn(min[0], min[1], min[2], max[3], max[4], max[5])
    const o1 = (axis + 1) % 3
    const o2 = (axis + 2) % 3
    for (const b of boxes) {
      if (!(a[o1] < b[3 + o1] && a[3 + o1] > b[o1] && a[o2] < b[3 + o2] && a[3 + o2] > b[o2])) continue
      if (d > 0 && b[axis] >= a[3 + axis] - 1e-4) d = Math.min(d, b[axis] - a[3 + axis])
      else if (d < 0 && b[3 + axis] <= a[axis] + 1e-4) d = Math.max(d, b[3 + axis] - a[axis])
    }
    if (axis === 0) this.pos.x += d
    else if (axis === 1) this.pos.y += d
    else this.pos.z += d
    return d
  }

  private hasGroundUnder(dx: number, dz: number) {
    const p = this.pos.clone()
    p.x += dx
    p.z += dz
    p.y -= 0.6
    return this.collidesAt(p, this.height)
  }

  update(dt: number, input: MoveInput) {
    this.sneaking = input.sneak && !this.flying
    this.sprinting = input.sprint && input.forward > 0 && !this.sneaking

    const inWater = !this.flying &&
      this.world.isWaterColumnAt(this.pos.x, this.pos.z) &&
      this.pos.y < this.world.waterSurfaceY &&
      this.pos.y + this.height > this.world.waterBottomY
    const immersion = inWater
      ? THREE.MathUtils.clamp((this.world.waterSurfaceY - this.pos.y) / this.height, 0, 1)
      : 0

    const speed = this.flying
      ? this.sprinting
        ? 21.6
        : 10.9
      : this.sneaking
        ? 1.31
        : this.sprinting
          ? 5.61
          : 4.317

    let f = input.forward
    let s = input.strafe
    const len = Math.hypot(f, s)
    if (len > 1) {
      f /= len
      s /= len
    }
    const sin = Math.sin(this.yaw)
    const cos = Math.cos(this.yaw)
    const tx = (-sin * f + cos * s) * speed
    const tz = (-cos * f - sin * s) * speed

    const k = this.flying ? 7 : this.onGround ? 16 : 3.2
    const blend = 1 - Math.exp(-k * dt)
    this.vel.x += (tx - this.vel.x) * blend
    this.vel.z += (tz - this.vel.z) * blend

    if (this.flying) {
      const ty = ((input.flyUp ? 1 : 0) - (input.flyDown ? 1 : 0)) * (this.sprinting ? 12 : 7.5)
      this.vel.y += (ty - this.vel.y) * (1 - Math.exp(-12 * dt))
    } else {
      this.vel.y -= 32 * dt
      if (inWater) {
        // Approximate buoyancy keeps the avatar near the surface; water drag
        // limits sudden movement, while jump can be used to swim upward.
        this.vel.y += 42 * immersion * dt
        this.vel.y *= Math.exp(-2.2 * dt)
        if (input.jump) this.vel.y = Math.max(this.vel.y, 4.2)
      } else {
        if (this.vel.y < -78) this.vel.y = -78
        if (input.jump && this.onGround) this.vel.y = 9
      }
    }

    let dx = this.vel.x * dt
    const dy = this.vel.y * dt
    let dz = this.vel.z * dt

    if (this.sneaking && this.onGround) {
      const step = 0.02
      while (dx !== 0 && !this.hasGroundUnder(dx, 0)) dx = Math.abs(dx) < step ? 0 : dx - Math.sign(dx) * step
      while (dz !== 0 && !this.hasGroundUnder(0, dz)) dz = Math.abs(dz) < step ? 0 : dz - Math.sign(dz) * step
      while (dx !== 0 && dz !== 0 && !this.hasGroundUnder(dx, dz)) {
        dx = Math.abs(dx) < step ? 0 : dx - Math.sign(dx) * step
        dz = Math.abs(dz) < step ? 0 : dz - Math.sign(dz) * step
      }
    }

    const start = this.pos.clone()
    const ady = this.moveAxis(1, dy)
    const adx = this.moveAxis(0, dx)
    const adz = this.moveAxis(2, dz)
    const wasGrounded = this.onGround || (dy < 0 && ady > dy + 1e-6)

    if ((adx !== dx || adz !== dz) && wasGrounded && !this.flying) {
      const normalEnd = this.pos.clone()
      this.pos.copy(start)
      const up = this.moveAxis(1, 0.6)
      const sx = this.moveAxis(0, dx)
      const sz = this.moveAxis(2, dz)
      this.moveAxis(1, -up + Math.min(0, dy))
      if (Math.hypot(sx, sz) <= Math.hypot(adx, adz) + 1e-6) this.pos.copy(normalEnd)
    }

    const realDx = this.pos.x - start.x
    const realDz = this.pos.z - start.z
    this.horizontalCollision = Math.abs(realDx - dx) > 1e-5 || Math.abs(realDz - dz) > 1e-5
    if (Math.abs(realDx - dx) > 1e-5) this.vel.x = 0
    if (Math.abs(realDz - dz) > 1e-5) this.vel.z = 0

    const realDy = this.pos.y - start.y
    this.onGround = dy < 0 && realDy > dy + 1e-6
    if (Math.abs(realDy - dy) > 1e-6 && !(realDy > 0 && dy <= 0)) this.vel.y = 0
    if (this.onGround) this.vel.y = 0
    if (this.flying && this.onGround) this.flying = false
    if (this.pos.y < -20) {
      this.pos.y = 10
      this.vel.set(0, 0, 0)
    }

    const targetEye = this.sneaking ? 1.27 : 1.62
    this.eye += (targetEye - this.eye) * (1 - Math.exp(-18 * dt))

    const hSpeed = Math.hypot(realDx, realDz) / Math.max(dt, 1e-4)
    if (this.onGround && !this.flying) {
      this.walkDist += hSpeed * dt * 0.6
      this.bob += (Math.min(1, hSpeed / 4.3) - this.bob) * (1 - Math.exp(-10 * dt))
    } else {
      this.bob += (0 - this.bob) * (1 - Math.exp(-6 * dt))
    }
  }
}
