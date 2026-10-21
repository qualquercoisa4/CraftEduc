import * as THREE from 'three'
import { DIRS } from './constants'
import { makePixelTexture, metalCanvas } from './textures'

let mats: ReturnType<typeof createMaterials> | null = null

function createMaterials() {
  const motorTex = makePixelTexture(metalCanvas([176, 182, 190], 11))
  const plasticTex = makePixelTexture(metalCanvas([38, 38, 42], 12))
  const copperTex = makePixelTexture(metalCanvas([212, 132, 62], 13))
  return {
    motorBody: new THREE.MeshLambertMaterial({ map: motorTex }),
    plastic: new THREE.MeshLambertMaterial({ map: plasticTex }),
    brass: new THREE.MeshLambertMaterial({ color: 0xd9b24a }),
    steel: new THREE.MeshLambertMaterial({ color: 0xc8ccd2 }),
    copper: new THREE.MeshLambertMaterial({ map: copperTex }),
    batteryBlack: new THREE.MeshLambertMaterial({ color: 0x1c1c1e }),
    red: new THREE.MeshLambertMaterial({ color: 0xd33a2c }),
    wire: new THREE.MeshLambertMaterial({ color: 0xf2c230 }),
    solder: new THREE.MeshLambertMaterial({ color: 0xb8bcc2 }),
    shaftMark: new THREE.MeshLambertMaterial({ color: 0x2f7dff }),
  }
}

export function getMaterials() {
  if (!mats) mats = createMaterials()
  return mats
}

const Z_AXIS = new THREE.Vector3(0, 0, 1)

export function facingQuaternion(facing: number) {
  const d = DIRS[facing]
  return new THREE.Quaternion().setFromUnitVectors(Z_AXIS, new THREE.Vector3(d[0], d[1], d[2]))
}

function cylZ(radius: number, length: number, mat: THREE.Material, z: number, seg = 14) {
  const g = new THREE.CylinderGeometry(radius, radius, length, seg)
  g.rotateX(Math.PI / 2)
  const m = new THREE.Mesh(g, mat)
  m.position.z = z
  return m
}

export interface MotorModel {
  group: THREE.Group
  shaft: THREE.Group
}

export function createMotorModel(facing: number): MotorModel {
  const m = getMaterials()
  const group = new THREE.Group()
  const inner = new THREE.Group()
  group.add(inner)

  const body = cylZ(0.3, 0.56, m.motorBody, -0.06)
  inner.add(body)
  const backCap = cylZ(0.26, 0.1, m.plastic, -0.38)
  inner.add(backCap)
  for (const side of [-1, 1]) {
    const tab = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, 0.1), m.copper)
    tab.position.set(0.14 * side, 0.1, -0.46)
    inner.add(tab)
  }
  const boss = cylZ(0.09, 0.06, m.steel, 0.25)
  inner.add(boss)
  const ring = cylZ(0.305, 0.04, m.plastic, 0.2)
  inner.add(ring)

  const shaft = new THREE.Group()
  shaft.position.z = 0.28
  const rod = cylZ(0.04, 0.22, m.brass, 0.11, 8)
  shaft.add(rod)
  const mark = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 0.04), m.shaftMark)
  mark.position.set(0, 0.045, 0.2)
  shaft.add(mark)
  inner.add(shaft)

  group.quaternion.copy(facingQuaternion(facing))
  return { group, shaft }
}

export function setMotorFacing(model: MotorModel, facing: number) {
  model.group.quaternion.copy(facingQuaternion(facing))
}

export interface BatteryBoxModel {
  group: THREE.Group
  batteries: THREE.Group[]
}

export function createBatteryBoxModel(count: number): BatteryBoxModel {
  const m = getMaterials()
  const group = new THREE.Group()
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
    mesh.position.set(x, y, z)
    group.add(mesh)
    return mesh
  }
  box(0.92, 0.08, 0.84, 0, 0.04, 0, m.plastic)
  box(0.04, 0.28, 0.84, -0.44, 0.18, 0, m.plastic)
  box(0.04, 0.28, 0.84, 0.44, 0.18, 0, m.plastic)
  box(0.92, 0.28, 0.04, 0, 0.18, -0.4, m.plastic)
  box(0.92, 0.28, 0.04, 0, 0.18, 0.4, m.plastic)
  box(0.03, 0.22, 0.76, -0.148, 0.15, 0, m.plastic)
  box(0.03, 0.22, 0.76, 0.148, 0.15, 0, m.plastic)

  const channels = [-0.295, 0, 0.295]
  for (const x of channels) {
    const spring = cylZ(0.06, 0.06, m.steel, -0.35, 8)
    spring.position.set(x, 0.18, -0.35)
    group.add(spring)
    box(0.12, 0.12, 0.02, x, 0.18, 0.37, m.steel)
  }
  const red = cylZ(0.025, 0.14, m.red, 0.47, 6)
  red.position.set(0.32, 0.12, 0.47)
  group.add(red)
  const black = cylZ(0.025, 0.14, m.batteryBlack, 0.47, 6)
  black.position.set(0.2, 0.12, 0.47)
  group.add(black)

  const batteries: THREE.Group[] = []
  for (const x of channels) {
    const b = new THREE.Group()
    b.position.set(x, 0.185, 0)
    b.add(cylZ(0.1, 0.44, m.batteryBlack, -0.11, 12))
    b.add(cylZ(0.1, 0.22, m.copper, 0.22, 12))
    b.add(cylZ(0.035, 0.04, m.steel, 0.35, 8))
    group.add(b)
    batteries.push(b)
  }
  const model = { group, batteries }
  setBatteryCount(model, count)
  return model
}

export function setBatteryCount(model: BatteryBoxModel, count: number) {
  model.batteries.forEach((b, i) => {
    b.visible = i < count
  })
}

/* ---------------- Wires ---------------- */

export function wireCurve(a: THREE.Vector3, b: THREE.Vector3) {
  const mid = a.clone().add(b).multiplyScalar(0.5)
  const len = a.distanceTo(b)
  mid.y -= Math.min(1.2, 0.12 + len * 0.18)
  return new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone())
}

export function createWireMesh(a: THREE.Vector3, b: THREE.Vector3) {
  const m = getMaterials()
  const group = new THREE.Group()
  const tube = new THREE.Mesh(new THREE.TubeGeometry(wireCurve(a, b), 20, 0.035, 5, false), m.wire)
  group.add(tube)
  for (const p of [a, b]) {
    const blob = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), m.solder)
    blob.position.copy(p)
    group.add(blob)
  }
  return group
}

export function updateWireMesh(group: THREE.Group, a: THREE.Vector3, b: THREE.Vector3) {
  const tube = group.children[0] as THREE.Mesh
  tube.geometry.dispose()
  tube.geometry = new THREE.TubeGeometry(wireCurve(a, b), 20, 0.035, 5, false)
  group.children[1].position.copy(a)
  group.children[2].position.copy(b)
}

export function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if ((o as THREE.Sprite).isSprite) return
    const mesh = o as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
  })
  obj.parent?.remove(obj)
}

/* ---------------- LED glow ---------------- */

let glowMat: THREE.SpriteMaterial | null = null
export function createGlowSprite() {
  if (!glowMat) {
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    const ctx = c.getContext('2d')!
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,170,110,0.75)')
    g.addColorStop(0.4, 'rgba(255,90,50,0.3)')
    g.addColorStop(1, 'rgba(255,60,30,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
    const tex = new THREE.CanvasTexture(c)
    glowMat = new THREE.SpriteMaterial({
      map: tex,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: true,
    })
  }
  const s = new THREE.Sprite(glowMat)
  s.scale.set(2.4, 2.4, 1)
  return s
}
