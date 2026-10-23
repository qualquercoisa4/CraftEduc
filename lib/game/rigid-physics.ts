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
  state?: { batteries?: number; mountedWheel?: boolean }
}

/**
 * Relative block mass in kilograms per voxel. Density is applied to each
 * Rapier collider, so multi-block assemblies get their mass and inertia from
 * the actual material mix instead of treating every block as equally heavy.
 */
export const BLOCK_MASS: Readonly<Record<number, number>> = {
  [B.AIR]: 0,
  [B.ALUMINUM]: 0.18,
  [B.COMPONENT]: 0.28,
  [B.LED]: 0.12,
  [B.WHEEL]: 0.32,
  [B.SWITCH]: 0.22,
  [B.GEAR]: 0.42,
  [B.BATTERY_BOX]: 0.65,
  [B.ROBOTICS]: 0.9,
  [B.WOOD]: 1.2,
  [B.MOTOR]: 1.4,
  [B.SERVO]: 0.45,
  [B.IRON]: 2.6,
  [B.PROXIMITY_SENSOR]: 0.18,
  [B.ARDUINO_UNO]: 0.08,
}

export function blockMass(id: number, state?: PhysicsVoxel['state']) {
  const base = BLOCK_MASS[id] ?? 0.8
  // Battery cells and the mounted wheel affect the centre of mass and inertia.
  if (id === B.BATTERY_BOX) return base + Math.max(0, Math.min(3, Math.floor(state?.batteries ?? 0))) * 0.12
  if (id === B.MOTOR && state?.mountedWheel) return base + 0.08
  return base
}

const BLOCK_FRICTION: Readonly<Record<number, number>> = {
  [B.AIR]: 0,
  [B.ALUMINUM]: 0.45,
  [B.COMPONENT]: 0.62,
  [B.LED]: 0.55,
  [B.WHEEL]: 1.05,
  [B.SWITCH]: 0.62,
  [B.GEAR]: 0.58,
  [B.BATTERY_BOX]: 0.72,
  [B.ROBOTICS]: 0.78,
  [B.WOOD]: 0.68,
  [B.MOTOR]: 0.70,
  [B.SERVO]: 0.62,
  [B.IRON]: 0.58,
  [B.PROXIMITY_SENSOR]: 0.58,
  [B.ARDUINO_UNO]: 0.55,
}

export function blockFriction(id: number) {
  return BLOCK_FRICTION[id] ?? 0.72
}


export interface PhysicsBodyOptions {
  lockRotation?: boolean
  yawOnly?: boolean
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
  private accumulator = 0
  private readonly fixedStep = 1 / 60
  private readonly maxSubsteps = 5
  private initializing: Promise<void>
  private disposed = false

  constructor(private readonly voxelWorld: World) {
    this.initializing = RAPIER.init().then(() => {
      if (this.disposed) return
      // One world unit is treated as roughly one metre. Keep gravity physical
      // and integrate at a fixed rate so contacts don't depend on device FPS.
      const physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
      physics.timestep = this.fixedStep
      this.rapierWorld = physics
      this.fixedBody = physics.createRigidBody(RAPIER.RigidBodyDesc.fixed())
      if (this.voxelWorld.type === 'beach') {
        // The island remains at y=4 but objects can descend to the sea floor at y=1.
        physics.createCollider(
          RAPIER.ColliderDesc.cuboid(10, 0.5, 10)
            .setTranslation(0, GROUND_LEVEL - 0.5, 0)
            .setFriction(0.88)
            .setRestitution(0.005),
          this.fixedBody,
        )
        physics.createCollider(
          RAPIER.ColliderDesc.cuboid(64, 0.5, 64)
            .setTranslation(0, 0.5, 0)
            .setFriction(0.82)
            .setRestitution(0.005),
          this.fixedBody,
        )
      } else {
        // Standard worlds retain their continuous floor.
        physics.createCollider(
          RAPIER.ColliderDesc.cuboid(2048, 0.5, 2048)
            .setTranslation(0, GROUND_LEVEL - 0.5, 0)
            .setFriction(0.88)
            .setRestitution(0.005),
          this.fixedBody,
        )
      }
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
        .setFriction(blockFriction(id))
        .setRestitution(0.005),
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
    if (options.yawOnly) desc = desc.enabledRotations(false, true, false)
    else if (options.lockRotation) desc = desc.lockRotations()
    const body = this.rapierWorld.createRigidBody(desc)
    for (const voxel of voxels) {
      // Reduce mounted motor housing size so the tyre reaches the ground first.
      const motorHousingHalfExtent = voxel.id === B.MOTOR && voxel.state?.mountedWheel ? 0.28 : 0.5
      this.rapierWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(motorHousingHalfExtent, motorHousingHalfExtent, motorHousingHalfExtent)
          .setTranslation(voxel.x + 0.5 - pivot.x, voxel.y + 0.5 - pivot.y, voxel.z + 0.5 - pivot.z)
          // Rapier derives total mass, centre of mass and inertia from every
          // collider's density and position; offset/heavy parts can tip the build.
          .setDensity(blockMass(voxel.id, voxel.state))
          .setFriction(blockFriction(voxel.id))
          .setRestitution(0.005),
        body,
      )
    }
    return body
  }

  /** Create the hidden rotating load used by a mounted wheel with no output voxel. */
  createWheelRotorBody(pivot: THREE.Vector3, axis: THREE.Vector3) {
    if (!this.ready || !this.rapierWorld) return null
    const axle = axis.clone().normalize()
    // This rotor's origin matches the visible wheel at the end of the motor shaft.
    const center = pivot.clone().addScaledVector(axle, 0.36)
    const body = this.rapierWorld.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(center.x, center.y, center.z)
        .setCanSleep(false)
        .setCcdEnabled(true)
        .setLinearDamping(0.025)
        .setAngularDamping(0.015),
    )
    const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axle)
    this.rapierWorld.createCollider(
      RAPIER.ColliderDesc.cylinder(0.075, 0.49)
        .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w })
        .setMass(0.32)
        .setFriction(1.05)
        .setSensor(true),
      body,
    )
    return body
  }

  createRevoluteJoint(
    parent: RAPIER.RigidBody,
    child: RAPIER.RigidBody,
    axis: THREE.Vector3,
    parentAnchor = new THREE.Vector3(),
    childAnchor = new THREE.Vector3(),
  ) {
    if (!this.rapierWorld) return null
    const joint = RAPIER.JointData.revolute(
      { x: parentAnchor.x, y: parentAnchor.y, z: parentAnchor.z },
      { x: childAnchor.x, y: childAnchor.y, z: childAnchor.z },
      { x: axis.x, y: axis.y, z: axis.z },
    )
    const connectedJoint = this.rapierWorld.createImpulseJoint(joint, parent, child, true) as RAPIER.RevoluteImpulseJoint
    // Avoid self-contact jamming at the hinge; the joint governs rotor/chassis coupling.
    connectedJoint.setContactsEnabled(false)
    return connectedJoint
  }

  getBodyCollider(body: RAPIER.RigidBody, index: number) {
    if (index < 0 || index >= body.numColliders()) return null
    return body.collider(index)
  }

  removeBodyCollider(collider: RAPIER.Collider | null | undefined) {
    if (!collider || !this.rapierWorld) return
    this.rapierWorld.removeCollider(collider, true)
  }

  removeRigidBody(body: RAPIER.RigidBody | null | undefined) {
    if (!body || !this.rapierWorld) return
    this.rapierWorld.removeRigidBody(body)
  }

  step(dt: number, beforeFixedStep?: (fixedDt: number) => void) {
    if (!this.ready || !this.rapierWorld) return

    // Fixed 60 Hz integration with bounded catch-up prevents the same build
    // behaving differently at 25 FPS and 60 FPS.
    this.accumulator += Math.max(0, Math.min(dt, 0.1))
    let steps = 0
    while (this.accumulator >= this.fixedStep && steps < this.maxSubsteps) {
      this.rapierWorld.timestep = this.fixedStep
      beforeFixedStep?.(this.fixedStep)
      this.rapierWorld.step()
      this.accumulator -= this.fixedStep
      steps++
    }
    if (steps === this.maxSubsteps && this.accumulator > this.fixedStep * this.maxSubsteps) {
      this.accumulator = this.fixedStep * this.maxSubsteps
    }
  }

  dispose() {
    this.disposed = true
    this.staticColliders.clear()
    this.rapierWorld?.free()
    this.rapierWorld = null
    this.fixedBody = null
    this.accumulator = 0
    this.initialized = false
  }
}
