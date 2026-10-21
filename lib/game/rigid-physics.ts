import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { B, GROUND_LEVEL, WORLD_HEIGHT, isOpaque, parseKey, posKey } from './constants'
import type { World } from './world'

export interface PhysicsVoxel {
  x: number
  y: number
  z: number
  id: number
  key?: string
}

export interface PhysicsBodyOptions {
  lockRotation?: boolean
  canSleep?: boolean
  linearDamping?: number
  angularDamping?: number
}

/**
 * Shared rigid-body world for every moving voxel assembly in CRAFTEDUC.
 * Static voxel colliders mirror World; bodies can contain one block or a
 * glue-connected set, with one collider per constituent voxel.
 */
export class RigidPhysics {
  private rapierWorld: RAPIER.World | null = null
  private fixedBody: RAPIER.RigidBody | null = null
  private staticColliders = new Map<string, RAPIER.Collider>()
  private initialized = false
  private initializing: Promise<void>
  private disposed = false

  constructor(private readonly voxelWorld: World) {
    this.initializing = RAPIER.init().then(() => {
      if (this.disposed) return
      const physics = new RAPIER.World({ x: 0, y: -18, z: 0 })
      physics.timestep = 1 / 60
      this.rapierWorld = physics
      this.fixedBody = physics.createRigidBody(RAPIER.RigidBodyDesc.fixed())
      // The voxel ground extends below GROUND_LEVEL. A single wide collider
      // gives every dynamic body a continuous floor instead of per-feature tests.
      physics.createCollider(
        RAPIER.ColliderDesc.cuboid(2048, 0.5, 2048)
          .setTranslation(0, GROUND_LEVEL - 0.5, 0)
          .setFriction(0.9)
          .setRestitution(0.02),
        this.fixedBody,
      )
      this.initialized = true
      this.rebuildStaticColliders()
    })
  }

  get ready() {
    return this.initialized && this.rapierWorld !== null
  }

  get world() {
    return this.rapierWorld
  }

  async waitUntilReady() {
    await this.initializing
  }

  /** Called after a voxel has already changed in World.data. */
  syncStaticBlock(x: number, y: number, z: number) {
    if (!this.ready || !this.rapierWorld || !this.fixedBody) return
    const key = posKey(x, y, z)
    const previous = this.staticColliders.get(key)
    if (previous) {
      this.rapierWorld.removeCollider(previous, true)
      this.staticColliders.delete(key)
    }
    if (y < GROUND_LEVEL || y >= WORLD_HEIGHT) return
    const id = this.voxelWorld.getBlock(x, y, z)
    if (id === B.AIR) return
    const collider = this.rapierWorld.createCollider(
      RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5)
        .setTranslation(x + 0.5, y + 0.5, z + 0.5)
        .setFriction(0.82)
        .setRestitution(0.01),
      this.fixedBody,
    )
    this.staticColliders.set(key, collider)
  }

  removeStaticBlock(key: string) {
    const collider = this.staticColliders.get(key)
    if (!collider || !this.rapierWorld) return
    this.rapierWorld.removeCollider(collider, true)
    this.staticColliders.delete(key)
  }

  private rebuildStaticColliders() {
    if (!this.rapierWorld || !this.fixedBody) return
    for (const collider of this.staticColliders.values()) this.rapierWorld.removeCollider(collider, true)
    this.staticColliders.clear()
    for (const chunk of this.voxelWorld.chunks.values()) {
      const minX = chunk.cx * 16
      const minZ = chunk.cz * 16
      const maxY = Math.min(WORLD_HEIGHT - 1, chunk.maxY)
      for (let y = GROUND_LEVEL; y <= maxY; y++) {
        for (let z = minZ; z < minZ + 16; z++) {
          for (let x = minX; x < minX + 16; x++) {
            // Model blocks also receive full-sized colliders even when their
            // voxel face mesh is hidden; every non-air block is solid physics.
            if (this.voxelWorld.getBlock(x, y, z) === B.AIR) continue
            this.syncStaticBlock(x, y, z)
          }
        }
      }
    }
  }

  createRigidBody(voxels: PhysicsVoxel[], pivot: THREE.Vector3, options: PhysicsBodyOptions = {}) {
    if (!this.ready || !this.rapierWorld || voxels.length === 0) return null
    let desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pivot.x, pivot.y, pivot.z)
      .setCanSleep(options.canSleep ?? true)
      .setCcdEnabled(true)
      .setLinearDamping(options.linearDamping ?? 0.08)
      .setAngularDamping(options.angularDamping ?? 0.12)
    if (options.lockRotation) desc = desc.lockRotations()
    const body = this.rapierWorld.createRigidBody(desc)
    for (const voxel of voxels) {
      this.rapierWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5)
          .setTranslation(voxel.x + 0.5 - pivot.x, voxel.y + 0.5 - pivot.y, voxel.z + 0.5 - pivot.z)
          .setFriction(0.82)
          .setRestitution(0.01),
        body,
      )
    }
    return body
  }

  createRevoluteJoint(parent: RAPIER.RigidBody, child: RAPIER.RigidBody, axis: THREE.Vector3) {
    if (!this.rapierWorld) return null
    const joint = RAPIER.JointData.revolute(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: axis.x, y: axis.y, z: axis.z },
    )
    return this.rapierWorld.createImpulseJoint(joint, parent, child, true) as RAPIER.RevoluteImpulseJoint
  }

  removeRigidBody(body: RAPIER.RigidBody | null | undefined) {
    if (!body || !this.rapierWorld) return
    this.rapierWorld.removeRigidBody(body)
  }

  step(dt: number) {
    if (!this.ready || !this.rapierWorld) return
    this.rapierWorld.timestep = Math.max(1 / 120, Math.min(dt, 1 / 30))
    this.rapierWorld.step()
  }

  dispose() {
    this.disposed = true
    this.staticColliders.clear()
    this.rapierWorld?.free()
    this.rapierWorld = null
    this.fixedBody = null
    this.initialized = false
  }
}
