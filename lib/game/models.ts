import * as THREE from 'three'
import { ARDUINO_UNO_TERMINAL_IDS, DIRS, type ArduinoUnoTerminalId } from './constants'
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
    tire: new THREE.MeshLambertMaterial({ color: 0x171719 }),
    yellow: new THREE.MeshLambertMaterial({ color: 0xffc400 }),
    tread: new THREE.MeshLambertMaterial({ color: 0x29292b }),
    switchBoard: new THREE.MeshLambertMaterial({ color: 0x087eaf }),
    switchHousing: new THREE.MeshLambertMaterial({ color: 0x202125 }),
    switchRock: new THREE.MeshLambertMaterial({ color: 0x383a40 }),
    switchMark: new THREE.MeshLambertMaterial({ color: 0xf0f1f3 }),
    sensorOn: new THREE.MeshLambertMaterial({ color: 0x46df63, emissive: 0x154c20 }),
    sensorOff: new THREE.MeshLambertMaterial({ color: 0xd3483d, emissive: 0x40100d }),
    servoBlue: new THREE.MeshLambertMaterial({ color: 0x126bd1 }),
    servoWhite: new THREE.MeshLambertMaterial({ color: 0xf4f4ef }),
    servoSignal: new THREE.MeshLambertMaterial({ color: 0xf4ce31 }),
    servoVoltage: new THREE.MeshLambertMaterial({ color: 0xc93635 }),
    servoGround: new THREE.MeshLambertMaterial({ color: 0x56382d }),
    arduinoBlue: new THREE.MeshLambertMaterial({ color: 0x0875b9 }),
    arduinoReset: new THREE.MeshLambertMaterial({ color: 0xd94135 }),
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

export interface ServoModel {
  group: THREE.Group
  shaft: THREE.Group
}

/** Compact SG90-style servo with ground, voltage and signal pins. */
export function createServoModel(facing = 2): ServoModel {
  const m = getMaterials()
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.48, 0.56), m.servoBlue)
  body.position.z = -0.06
  group.add(body)
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.045, 0.43), m.plastic)
  top.position.set(0, 0.265, -0.06)
  group.add(top)
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.09, 0.32), m.servoBlue)
    ear.position.set(side * 0.42, -0.05, -0.07)
    group.add(ear)
    const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.095, 12), m.batteryBlack)
    hole.rotation.z = Math.PI / 2
    hole.position.set(side * 0.42, -0.05, -0.07)
    group.add(hole)
  }
  group.add(cylZ(0.16, 0.08, m.plastic, 0.245))
  group.add(cylZ(0.07, 0.14, m.servoWhite, 0.31))
  const shaft = new THREE.Group()
  shaft.position.set(0, 0, 0.37)
  const horn = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.055, 0.085), m.servoWhite)
  horn.position.z = 0.055
  shaft.add(horn)
  const hornHub = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.06, 16), m.servoWhite)
  hornHub.rotation.x = Math.PI / 2
  hornHub.position.z = 0.015
  shaft.add(hornHub)
  group.add(shaft)
  const pins = [
    { x: -0.2, material: m.servoGround },
    { x: 0, material: m.servoVoltage },
    { x: 0.2, material: m.servoSignal },
  ]
  for (const pin of pins) {
    const connector = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.075, 0.105), m.plastic)
    connector.position.set(pin.x, -0.285, -0.19)
    group.add(connector)
    const terminal = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.15, 0.035), pin.material)
    terminal.position.set(pin.x, -0.365, -0.19)
    group.add(terminal)
  }
  group.quaternion.copy(facingQuaternion(facing))
  return { group, shaft }
}

export function setServoFacing(model: ServoModel, facing: number) {
  model.group.quaternion.copy(facingQuaternion(facing))
}


export interface WheelModel { group: THREE.Group; rim: THREE.Group }

/** Arduino robot wheel with a chunky rubber tire, five-spoke yellow rim and tread lugs. */
export function createArduinoWheelModel(facing = 0): WheelModel {
  const m = getMaterials()
  const group = new THREE.Group()
  const rim = new THREE.Group()
  group.add(rim)
  const tire = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.13, 12, 32), m.tire)
  rim.add(tire)
  const disk = new THREE.Mesh(new THREE.CylinderGeometry(0.265, 0.265, 0.09, 32), m.yellow)
  disk.rotation.x = Math.PI / 2
  rim.add(disk)
  for (let i = 0; i < 5; i++) {
    const a = i * Math.PI * 2 / 5
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.30, 0.07), m.yellow)
    spoke.position.set(Math.sin(a) * 0.15, Math.cos(a) * 0.15, 0)
    spoke.rotation.z = -a
    rim.add(spoke)
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.14, 20), m.yellow)
  hub.rotation.x = Math.PI / 2
  rim.add(hub)
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.15, 16), m.steel)
  cap.rotation.x = Math.PI / 2
  rim.add(cap)
  for (let i = 0; i < 32; i++) {
    const a = i * Math.PI * 2 / 32
    for (const side of [-1, 1]) {
      const lug = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.055, 0.045), m.tread)
      lug.position.set(Math.sin(a) * 0.465, Math.cos(a) * 0.465, side * 0.065)
      lug.rotation.z = -a
      rim.add(lug)
    }
  }
  const d = DIRS[facing] ?? DIRS[0]
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(d[0], d[1], d[2]))
  return { group, rim }
}


export interface ProximitySensorModel {
  group: THREE.Group
  indicator: THREE.Mesh
  terminalTargets: THREE.Mesh[]
}

/** HC-SR04-inspired board with two ultrasonic cans and four accessible terminals. */
export function createProximitySensorModel(facing = 5, active = false): ProximitySensorModel {
  const m = getMaterials()
  const group = new THREE.Group()
  group.add(new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.48, 0.08), m.switchBoard))

  for (const x of [-0.22, 0.22]) {
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.27, 24), m.steel)
    can.rotation.x = Math.PI / 2
    can.position.set(x, 0.035, 0.14)
    group.add(can)
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.153, 0.018, 8, 24), m.solder)
    rim.position.set(x, 0.035, 0.286)
    group.add(rim)
    const face = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.018, 24), m.batteryBlack)
    face.rotation.x = Math.PI / 2
    face.position.set(x, 0.035, 0.285)
    group.add(face)
    const center = new THREE.Mesh(new THREE.CircleGeometry(0.045, 12), m.steel)
    center.position.set(x, 0.035, 0.296)
    group.add(center)
    for (let i = -2; i <= 2; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.20, 0.005), m.solder)
      bar.position.set(x + i * 0.035, 0.035, 0.299)
      group.add(bar)
    }
  }

  const terminalPins = [
    { id: 'VCC', x: -0.24, material: m.servoVoltage },
    { id: 'TRIG', x: -0.08, material: m.yellow },
    { id: 'ECHO', x: 0.08, material: m.sensorOn },
    { id: 'GND', x: 0.24, material: m.batteryBlack },
  ]
  const terminalTargets: THREE.Mesh[] = []
  const terminalTargetMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    colorWrite: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  for (const terminal of terminalPins) {
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.025, 0.07), m.solder)
    pad.position.set(terminal.x, -0.235, -0.005)
    group.add(pad)
    const pin = new THREE.Mesh(new THREE.BoxGeometry(0.027, 0.18, 0.027), terminal.material)
    pin.position.set(terminal.x, -0.32, -0.005)
    group.add(pin)

    // Each pin gets its own invisible raycast target so the game can distinguish
    // VCC, TRIG, ECHO and GND instead of guessing from the block's hit point.
    const target = new THREE.Mesh(new THREE.BoxGeometry(0.158, 0.24, 0.24), terminalTargetMaterial)
    target.position.set(terminal.x, -0.32, -0.005)
    target.userData.terminalId = terminal.id
    target.name = `sensor-terminal-${terminal.id}`
    group.add(target)
    terminalTargets.push(target)
  }
  const labelCanvas = document.createElement('canvas')
  labelCanvas.width = 512
  labelCanvas.height = 128
  const labelContext = labelCanvas.getContext('2d')!
  labelContext.clearRect(0, 0, labelCanvas.width, labelCanvas.height)
  labelContext.fillStyle = '#ffffff'
  labelContext.font = 'bold 48px Arial'
  labelContext.textAlign = 'center'
  labelContext.textBaseline = 'middle'
  terminalPins.forEach((terminal, index) => labelContext.fillText(terminal.id, 64 + index * 128, 64))
  const labelTexture = new THREE.CanvasTexture(labelCanvas)
  labelTexture.colorSpace = THREE.SRGBColorSpace
  const labels = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.18), new THREE.MeshBasicMaterial({ map: labelTexture, transparent: true, side: THREE.DoubleSide }))
  labels.position.set(0, -0.15, 0.046)
  group.add(labels)
  const indicator = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), m.sensorOff)
  indicator.position.set(0.34, -0.17, 0.055)
  group.add(indicator)
  group.quaternion.copy(facingQuaternion(facing))
  const model = { group, indicator, terminalTargets }
  setProximitySensorActive(model, active)
  return model
}

export function setProximitySensorFacing(model: ProximitySensorModel, facing: number) {
  model.group.quaternion.copy(facingQuaternion(facing))
}

export function setProximitySensorActive(model: ProximitySensorModel, active: boolean) {
  model.indicator.material = active ? getMaterials().sensorOn : getMaterials().sensorOff
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

/** Visible polarity markers on the two exposed LED terminals. */
export interface LedTerminalModel {
  group: THREE.Group
}

export function createLedTerminalModel(): LedTerminalModel {
  const m = getMaterials()
  const group = new THREE.Group()
  const terminal = (x: number, material: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), material)
    mesh.position.set(x, 0.5, 0.5)
    group.add(mesh)
  }
  terminal(1.015, m.red) // anode (+)
  terminal(-0.015, m.batteryBlack) // cathode (−)
  return { group }
}

export interface SwitchModel {
  group: THREE.Group
  rocker: THREE.Group
}

/** Compact rocker switch with four independently wired contacts. */
export function createSwitchModel(enabled = false): SwitchModel {
  const m = getMaterials()
  const group = new THREE.Group()
  const box = (width: number, height: number, depth: number, x: number, y: number, z: number, material: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material)
    mesh.position.set(x, y, z)
    group.add(mesh)
    return mesh
  }
  box(0.94, 0.055, 0.92, 0.5, 0.105, 0.5, m.switchBoard)
  for (const x of [0.12, 0.88]) for (const z of [0.13, 0.87]) {
    const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.009, 10), m.steel)
    screw.position.set(x, 0.137, z)
    group.add(screw)
  }
  for (const z of [0.32, 0.68]) {
    box(0.13, 0.035, 0.055, 0.035, 0.115, z, m.copper)
    box(0.13, 0.035, 0.055, 0.965, 0.115, z, m.copper)
    box(0.075, 0.018, 0.045, 0.035, 0.139, z, m.solder)
    box(0.075, 0.018, 0.045, 0.965, 0.139, z, m.solder)
  }
  box(0.73, 0.15, 0.5, 0.5, 0.205, 0.5, m.switchHousing)
  const rocker = new THREE.Group()
  rocker.position.set(0.5, 0.29, 0.5)
  rocker.add(new THREE.Mesh(new THREE.BoxGeometry(0.57, 0.075, 0.34), m.switchRock))
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.042, 0.064, 12), m.switchMark)
  ring.rotation.x = -Math.PI / 2
  ring.position.set(-0.155, 0.04, 0)
  rocker.add(ring)
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.012, 0.025), m.switchMark)
  bar.position.set(0.155, 0.04, 0)
  rocker.add(bar)
  group.add(rocker)
  const model = { group, rocker }
  setSwitchState(model, enabled)
  return model
}

export function setSwitchState(model: SwitchModel, enabled: boolean) {
  model.rocker.rotation.z = enabled ? -0.16 : 0.16
}


export interface ArduinoUnoTerminal {
  id: ArduinoUnoTerminalId
  localPosition: THREE.Vector3
}

export interface ArduinoUnoModel {
  group: THREE.Group
  terminals: ArduinoUnoTerminal[]
}

let arduinoSilkscreenMaterial: THREE.MeshBasicMaterial | null = null

function getArduinoSilkscreenMaterial() {
  if (arduinoSilkscreenMaterial) return arduinoSilkscreenMaterial
  const canvas = document.createElement('canvas')
  canvas.width = 512
  // Match the texture aspect ratio to the board surface so lettering stays undistorted.
  canvas.height = 378
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#f5f6f7'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  const boardWidth = 0.84
  const boardDepth = 0.62
  const pxX = (x: number) => ((x + boardWidth / 2) / boardWidth) * canvas.width
  const pxY = (z: number) => ((boardDepth / 2 - z) / boardDepth) * canvas.height

  const fillPinLabel = (text: string, x: number, z: number) => {
    ctx.fillText(text, pxX(x), pxY(z))
  }

  ctx.font = 'bold 17px Arial, sans-serif'
  const digitalStart = -0.35
  const digitalStep = 0.70 / 13
  for (let i = 0; i <= 13; i++) fillPinLabel(String(i), digitalStart + digitalStep * i, 0.205)
  ctx.font = 'bold 16px Arial, sans-serif'
  fillPinLabel('DIGITAL (PWM~)', 0.08, 0.145)
  ctx.font = 'bold 18px Arial, sans-serif'
  fillPinLabel('5V', -0.23, -0.205)
  ctx.font = 'bold 15px Arial, sans-serif'
  fillPinLabel('GND', -0.11, -0.205)
  fillPinLabel('GND', 0.01, -0.205)
  ctx.font = 'bold 16px Arial, sans-serif'
  fillPinLabel('POWER', -0.12, -0.14)
  ctx.font = 'bold 13px Arial, sans-serif'
  fillPinLabel('VIN', -0.34, -0.12)
  ctx.font = 'bold 20px Arial, sans-serif'
  ctx.fillText('ARDUINO', pxX(0.30), pxY(0.13))
  ctx.font = 'bold 24px Arial, sans-serif'
  ctx.fillText('UNO', pxX(0.30), pxY(0.19))

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  arduinoSilkscreenMaterial = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  })
  return arduinoSilkscreenMaterial
}

/** Arduino UNO-inspired board whose wire terminals keep stable, independent IDs. */
export function createArduinoUnoModel(): ArduinoUnoModel {
  const m = getMaterials()
  const group = new THREE.Group()
  // The placed board occupies a 2x2-block footprint; terminals scale with the PCB.
  group.scale.set(2, 1, 2)
  const box = (
    width: number, height: number, depth: number,
    x: number, y: number, z: number, material: THREE.Material,
  ) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material)
    mesh.position.set(x, y, z)
    group.add(mesh)
    return mesh
  }

  // Main blue PCB and mounting holes.
  box(0.92, 0.06, 0.68, 0, 0, 0, m.arduinoBlue)
  const silkscreen = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.62), getArduinoSilkscreenMaterial())
  silkscreen.rotation.x = -Math.PI / 2
  silkscreen.position.set(0, 0.0315, 0)
  group.add(silkscreen)
  for (const x of [-0.4, 0.4]) {
    for (const z of [-0.29, 0.29]) {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.014, 16), m.solder)
      ring.position.set(x, 0.036, z)
      group.add(ring)
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.016, 16), m.batteryBlack)
      hole.position.set(x, 0.044, z)
      group.add(hole)
    }
  }

  // USB-B connector and barrel power input are separate from the pin headers.
  box(0.15, 0.105, 0.22, -0.37, 0.028, -0.055, m.steel)
  box(0.035, 0.062, 0.14, -0.448, 0.035, -0.055, m.batteryBlack)
  box(0.015, 0.04, 0.09, -0.468, 0.035, -0.055, m.steel)
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.067, 0.067, 0.15, 16), m.plastic)
  barrel.rotation.z = Math.PI / 2
  barrel.position.set(-0.37, 0.028, 0.245)
  group.add(barrel)
  const barrelRim = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.018, 16), m.steel)
  barrelRim.rotation.z = Math.PI / 2
  barrelRim.position.set(-0.45, 0.028, 0.245)
  group.add(barrelRim)
  const barrelOpening = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.02, 16), m.batteryBlack)
  barrelOpening.rotation.z = Math.PI / 2
  barrelOpening.position.set(-0.461, 0.028, 0.245)
  group.add(barrelOpening)

  // Reset button, USB interface chip, microcontroller, clock crystal and LEDs.
  box(0.105, 0.055, 0.095, -0.285, 0.05, -0.02, m.plastic)
  const reset = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.031, 0.045, 16), m.arduinoReset)
  reset.position.set(-0.285, 0.083, -0.02)
  group.add(reset)
  box(0.115, 0.035, 0.09, -0.13, 0.05, 0.075, m.batteryBlack)
  box(0.22, 0.035, 0.16, 0.14, 0.052, 0.055, m.batteryBlack)
  for (const side of [-1, 1]) {
    for (let i = 0; i < 7; i++) box(0.018, 0.012, 0.012, 0.14 + side * 0.12, 0.043, -0.015 + i * 0.023, m.solder)
  }
  box(0.105, 0.027, 0.045, -0.13, 0.052, -0.12, m.steel)
  for (const x of [-0.23, -0.18]) {
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), x < -0.2 ? m.sensorOn : m.arduinoReset)
    led.position.set(x, 0.075, -0.12)
    group.add(led)
  }

  const terminals: ArduinoUnoTerminal[] = []
  const addHeader = (
    pins: { id: ArduinoUnoTerminalId; x: number; z: number; color?: THREE.Material }[],
    width: number,
  ) => {
    if (!pins.length) return
    const z = pins[0].z
    const centerX = (pins[0].x + pins[pins.length - 1].x) / 2
    box(width, 0.04, 0.075, centerX, 0.048, z, m.plastic)
    for (const pin of pins) {
      box(0.032, 0.036, 0.05, pin.x, 0.066, pin.z, m.batteryBlack)
      box(0.018, 0.084, 0.018, pin.x, 0.092, pin.z, pin.color ?? m.brass)
      terminals.push({ id: pin.id, localPosition: new THREE.Vector3(pin.x, 0.134, pin.z) })
    }
  }

  const digitalPins = Array.from({ length: 14 }, (_, index) => ({
    id: ARDUINO_UNO_TERMINAL_IDS[index],
    x: -0.35 + index * (0.70 / 13),
    z: -0.27,
  }))
  addHeader(digitalPins, 0.77)
  addHeader([
    { id: '5V', x: -0.23, z: 0.28, color: m.red },
    { id: 'GND', x: -0.11, z: 0.28, color: m.batteryBlack },
    { id: 'GND_2', x: 0.01, z: 0.28, color: m.batteryBlack },
  ], 0.36)

  // VIN is a selectable positive input contact on the barrel jack, not a data pin.
  terminals.push({ id: 'VIN', localPosition: new THREE.Vector3(-0.47, 0.028, 0.245) })
  return { group, terminals }
}

/* ---------------- Wires ---------------- */

export function wireCurve(a: THREE.Vector3, b: THREE.Vector3) {
  const mid = a.clone().add(b).multiplyScalar(0.5)
  const len = a.distanceTo(b)
  mid.y -= Math.min(1.2, 0.12 + len * 0.18)
  return new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone())
}

const coloredWireMaterials = new Map<string, THREE.MeshLambertMaterial>()

function wireMaterial(color: string) {
  const normalized = color.toLowerCase()
  let material = coloredWireMaterials.get(normalized)
  if (!material) {
    material = new THREE.MeshLambertMaterial({ color: normalized })
    coloredWireMaterials.set(normalized, material)
  }
  return material
}

export function createWireMesh(a: THREE.Vector3, b: THREE.Vector3, color = '#fdd835') {
  const m = getMaterials()
  const group = new THREE.Group()
  const tube = new THREE.Mesh(new THREE.TubeGeometry(wireCurve(a, b), 20, 0.035, 5, false), wireMaterial(color))
  group.add(tube)
  for (const p of [a, b]) {
    const blob = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), m.solder)
    blob.position.copy(p)
    group.add(blob)
  }
  return group
}

export function updateWireMesh(group: THREE.Group, a: THREE.Vector3, b: THREE.Vector3, color?: string) {
  const tube = group.children[0] as THREE.Mesh
  tube.geometry.dispose()
  tube.geometry = new THREE.TubeGeometry(wireCurve(a, b), 20, 0.035, 5, false)
  if (color) tube.material = wireMaterial(color)
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
