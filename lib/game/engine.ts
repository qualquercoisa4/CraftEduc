import * as THREE from 'three'
import { sfx, unlockAudio } from './audio'
import {
  B,
  BLOCK_TO_ITEM,
  COLOR_VARIANTS,
  isWireItem,
  CHUNK_SIZE,
  DIRS,
  OPPOSITE,
  DIR_NAMES,
  GROUND_LEVEL,
  ITEMS,
  type ItemId,
  REACH,
  WORLD_HEIGHT,
  blockBounds,
  blockConductivity,
  isModelBlock,
  posKey,
  parseKey,
} from './constants'
import { Mechanics, type Wire } from './mechanics'
import { blockFriction, blockMass } from './rigid-physics'
import { isMotorItemId, motorItemForVariant } from './motor-specs'
import type { BlockEdit, MovingActionIntent, NetworkPlayer, NetworkWire, MultiplayerRules } from './multiplayer'
import type { SkinConfig } from './multiplayer-types'
import { buffersToGeometry, emitCube, newBuffers } from './mesher'
import { createArduinoUnoModel, createArduinoWheelModel, createBatteryBoxModel, createMotorModel, createProximitySensorModel, motorWorldBounds, wireCurve } from './models'
import { Particles } from './particles'
import { Player } from './player'
import { HORIZON_COLOR, createSky } from './sky'
import { gameStore, showItemLabel, showToast } from './store'
import {
  armCanvas,
  getAtlasCanvas,
  getItemSpriteCanvas,
  glueCanvas,
  makePixelTexture,
  tileFor,
} from './textures'
import { World } from './world'
import { getWorldSpawn } from './world-generation'
import {
  resolveWorldStartup,
  saveWorldRecord,
  getArduinoProgramsForWorld,
  restoreArduinoProgramsForWorld,
  type SavedBlock,
  type SavedWorldRecord,
  type SavedWorldData,
  type WorldConfig,
} from './world-saves'

export interface Hit {
  x: number
  y: number
  z: number
  face: number
  point: THREE.Vector3
  id: number
  dist: number
  moving?: { key: string; kind: 'rotor' | 'chassis' | 'falling' }
}

let current: Engine | null = null
export const getEngine = () => current

const METAL = new Set<number>([B.IRON, B.ALUMINUM, B.GEAR, B.MOTOR, B.SERVO, B.ROBOTICS, B.WHEEL, B.SWITCH])

interface MultiplayerBridge {
  isHost: boolean
  canFly: () => boolean
  canBreakBlock: (x: number, y: number, z: number, actorKey?: string) => boolean
  movingAction: (intent: Omit<MovingActionIntent, 'playerKey' | 'playerName'>) => void
  blockChanged: (x: number, y: number, z: number, block: number, state?: import('./world').BlockState, ownerKey?: string | null) => void
  ownerForBlock: (x: number, y: number, z: number) => string | null
  wireCreated: (wire: Wire) => void
  wiresRemovedAt: (key: string) => void
}
interface AssistantRobot {
  group: THREE.Group
  waypoints: THREE.Vector3[]
  waypoint: number
  speed: number
  phase: number
}

interface RemoteAvatar {
  group: THREE.Group
  targetPosition: THREE.Vector3
  targetYaw: number
  skinSignature: string
}

export class Engine {
  renderer: THREE.WebGLRenderer
  scene = new THREE.Scene()
  camera: THREE.PerspectiveCamera
  handScene = new THREE.Scene()
  handCamera: THREE.PerspectiveCamera
  world: World
  mech: Mechanics
  player: Player
  particles: Particles
  blockMaterial: THREE.MeshBasicMaterial
  private sky = createSky()
  private outline: THREE.LineSegments
  private wireMarker: THREE.Mesh
  private wirePreview: THREE.Line
  private handRoot = new THREE.Group()
  private handObj: THREE.Object3D | null = null
  private heldItem: ItemId | null | undefined = undefined
  private keys = new Set<string>()
  private raf = 0
  private last = 0
  private elapsed = 0
  target: Hit | null = null
  private targetRayOrigin = new THREE.Vector3()
  private targetRayDirection = new THREE.Vector3(0, 0, -1)
  wireStart: { key: string; terminal: string; point: THREE.Vector3 } | null = null

  private breakHeld = false
  private breakTimer = 0
  private useHeld = false
  private useTimer = 0
  private lastUseWasPlace = false
  private swing = 1
  private equip = 1
  private lastSpace = 0
  private lastW = 0
  private sprintLatch = false
  private locked = false
  private lockFailed = false
  private debugTimer = 0
  private physicsDebugLabel: HTMLPreElement | null = null
  private frames = 0
  private fps = 0
  private touchHolding = false
  private touchHoldTime = 0
  private touchBroke = false
  private touchMovedFar = false
  private cleanup: (() => void)[] = []
  private multiplayerBridge: MultiplayerBridge | null = null
  private applyingNetworkBlock = false
  private multiplayerCanFly = true
  private multiplayerRules: MultiplayerRules | null = null
  private remoteAvatars = new Map<string, RemoteAvatar>()
  private assistantRobots: AssistantRobot[] = []
  private worldConfig: WorldConfig
  private singlePlayerWorldPlayed = false

  touch = { moveX: 0, moveY: 0, jump: false, sneak: false, flyUp: false, flyDown: false, sprint: false }

  constructor(private canvas: HTMLCanvasElement) {
    const startup = resolveWorldStartup()
    this.worldConfig = startup.config
    current = this
    const isTouch = gameStore.get().isTouch
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, isTouch ? 1.5 : 2))
    this.renderer.autoClear = false
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    const { settings } = gameStore.get()
    if (isTouch && settings.renderDistance > 5) gameStore.set({ settings: { ...settings, renderDistance: 5 } })
    if (['1'].includes(new URLSearchParams(window.location.search).get('physicsDebug') ?? '') || new URLSearchParams(window.location.search).get('electricalDebug') === '1') {
      const label = document.createElement('pre')
      label.style.position = 'fixed'
      label.style.left = '8px'
      label.style.top = '8px'
      label.style.zIndex = '99999'
      label.style.margin = '0'
      label.style.padding = '8px 10px'
      label.style.maxWidth = 'calc(100vw - 16px)'
      label.style.maxHeight = '34vh'
      label.style.overflow = 'auto'
      label.style.pointerEvents = 'none'
      label.style.whiteSpace = 'pre-wrap'
      label.style.font = '12px/1.35 monospace'
      label.style.color = '#eaffea'
      label.style.background = 'rgba(0,0,0,.78)'
      label.style.border = '1px solid rgba(160,255,160,.5)'
      label.textContent = 'Inicializando física...'
      document.body.appendChild(label)
      this.physicsDebugLabel = label
    }

    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, 1000)
    this.camera.rotation.order = 'YXZ'
    this.handCamera = new THREE.PerspectiveCamera(70, 1, 0.01, 10)

    const skyThemes: Record<string, {theme:number;horizon:string}> = {
      mars_colony:{theme:1,horizon:'#bd715a'}, venus_colony:{theme:2,horizon:'#d4a35f'},
      mystery_planet:{theme:3,horizon:'#537b91'}, robot_city:{theme:4,horizon:'#273b65'},
    }
    const skyTheme=skyThemes[this.worldConfig.type]
    this.scene.background=new THREE.Color(skyTheme?.horizon ?? HORIZON_COLOR)
    this.scene.fog=new THREE.Fog(skyTheme?.horizon ?? HORIZON_COLOR,60,120)
    this.sky.material.uniforms.uTheme.value=skyTheme?.theme ?? 0
    this.scene.add(this.sky.mesh)
    this.scene.add(new THREE.HemisphereLight(0xdff2ff, 0x5a6a80, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 1.6)
    sun.position.set(0.45, 0.62, -0.65)
    this.scene.add(sun)

    this.handScene.add(new THREE.HemisphereLight(0xdff2ff, 0x5a6a80, 1.8))
    const hs = new THREE.DirectionalLight(0xffffff, 1.4)
    hs.position.set(-0.5, 1, 0.6)
    this.handScene.add(hs)
    this.handScene.add(this.handCamera)
    this.handCamera.add(this.handRoot)

    const atlas = makePixelTexture(getAtlasCanvas())
    this.blockMaterial = new THREE.MeshBasicMaterial({ map: atlas, vertexColors: true })
    const glueMat = new THREE.MeshBasicMaterial({
      map: makePixelTexture(glueCanvas()),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })

    this.world = new World(this.scene, this.blockMaterial, this.worldConfig.type, this.worldConfig.seed)
    this.mech = new Mechanics(this.world, this.scene, this.blockMaterial, glueMat)
    this.world.onBlockChange = (x, y, z, o, n, oldHadGlue, newHasGlue) => this.mech.onBlockChange(x, y, z, o, n, oldHadGlue, newHasGlue)
    this.player = new Player(this.world)
    // Diagnostic-only view: begin near and facing the demo rotor so automated
    // and manual regression checks can target moving blocks. Normal gameplay
    // retains the default spawn and camera.
    if (new URLSearchParams(window.location.search).get('physicsDebug') === '1') {
      this.player.pos.set(6.5, 5.2, 0.5)
      this.player.yaw = 0
      this.player.pitch = 0.48
      this.player.flying = true
    }

    this.particles = new Particles(this.blockMaterial, (x, y, z) => this.world.isSolid(x, y, z))
    this.scene.add(this.particles.mesh)

    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1))
    this.outline = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 }),
    )
    this.outline.visible = false
    this.scene.add(this.outline)

    this.wireMarker = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.14, 0.14),
      new THREE.MeshBasicMaterial({ color: 0xf2c230 }),
    )
    this.wireMarker.visible = false
    this.scene.add(this.wireMarker)
    this.wirePreview = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(new Array(16).fill(0).map(() => new THREE.Vector3())),
      new THREE.LineBasicMaterial({ color: 0xf2c230 }),
    )
    this.wirePreview.frustumCulled = false
    this.wirePreview.visible = false
    this.scene.add(this.wirePreview)

    if (startup.save) {
      this.restoreSavedWorld(startup.save)
    } else if (this.worldConfig.type === 'flat') {
      this.buildDemo()
    } else if (this.worldConfig.type === 'mars_colony') {
      this.buildMarsHoverRobot()
    }
    if (['mars_colony','venus_colony','mystery_planet','robot_city'].includes(this.worldConfig.type)) this.buildWorldAssistants()
    if (this.worldConfig.type === 'robot_city' && !startup.save) this.buildRobotCityControlPanel()
    // Include procedurally generated habitat glue in the visible glue overlay.
    this.mech.rebuildGlue()

    const spawn = getWorldSpawn(this.worldConfig.type)
    this.player.pos.set(spawn[0], spawn[1], spawn[2])
    this.player.yaw = 0
    this.player.pitch = -0.15

    const savedPlayer = startup.save?.data.player
    if (savedPlayer) {
      const finite = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback
      this.player.pos.set(
        finite(savedPlayer.x, spawn[0]),
        finite(savedPlayer.y, spawn[1]),
        finite(savedPlayer.z, spawn[2]),
      )
      this.player.yaw = finite(savedPlayer.yaw, 0)
      this.player.pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, finite(savedPlayer.pitch, 0)))
      this.player.flying = Boolean(savedPlayer.flying)
      this.player.sneaking = Boolean(savedPlayer.sneaking)
      gameStore.set({ flying: this.player.flying, sneaking: this.player.sneaking })
    }

    this.bindEvents()
    if (startup.autoStart) gameStore.set({ screen: 'playing' })
    this.resize()
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  /* ---------------- Setup ---------------- */


  private buildWorldAssistants() {
    const city=this.worldConfig.type==='robot_city', count=city?9:3, radius=city?11:8
    const cyan=new THREE.MeshStandardMaterial({color:0x08d9ef,emissive:0x087b91,emissiveIntensity:1.2})
    const shell=new THREE.MeshStandardMaterial({color:0xcbd3d8,metalness:0.72,roughness:0.3})
    const dark=new THREE.MeshStandardMaterial({color:0x202a34,metalness:0.3,roughness:0.45})
    const cargo=new THREE.MeshStandardMaterial({color:0xf1b52b,metalness:0.2,roughness:0.65})
    for(let i=0;i<count;i++){
      const root=new THREE.Group(); root.name='Robô assistente de manutenção'
      const part=(w:number,h:number,d:number,mat:THREE.Material,x:number,y:number,z:number)=>{
        const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat); mesh.position.set(x,y,z); root.add(mesh); return mesh
      }
      part(0.72,0.65,0.48,shell,0,0.95,0)
      part(0.76,0.48,0.52,dark,0,1.55,0)
      part(0.58,0.29,0.035,cyan,0,1.56,0.275)
      part(0.20,0.18,0.10,dark,-0.16,1.56,0.30)
      part(0.20,0.18,0.10,dark,0.16,1.56,0.30)
      part(0.18,0.48,0.18,shell,-0.48,0.94,0)
      part(0.18,0.48,0.18,shell,0.48,0.94,0)
      part(0.24,0.18,0.27,dark,-0.22,0.12,0.04)
      part(0.24,0.18,0.27,dark,0.22,0.12,0.04)
      part(0.36,0.36,0.36,cargo,0.42,1.04,-0.30)
      const baseX=(i%3-1)*radius, baseZ=(Math.floor(i/3)-1)*radius
      const points=[new THREE.Vector3(baseX,GROUND_LEVEL,baseZ),new THREE.Vector3(baseX+5,GROUND_LEVEL,baseZ),new THREE.Vector3(baseX+5,GROUND_LEVEL,baseZ+4),new THREE.Vector3(baseX-3,GROUND_LEVEL,baseZ+4),new THREE.Vector3(baseX-3,GROUND_LEVEL,baseZ)]
      root.position.copy(points[0]); this.scene.add(root)
      this.assistantRobots.push({group:root,waypoints:points,waypoint:1,speed:0.65+(i%4)*0.12,phase:i*0.7})
    }
  }

  private buildRobotCityControlPanel() {
    const y=GROUND_LEVEL
    this.world.setBlock(5,y,5,B.BATTERY_BOX,{batteries:3})
    this.world.setBlock(6,y,5,B.ARDUINO_UNO)
    this.world.setBlock(7,y,5,B.LED,{color:'#00e5ff'})
    this.world.setBlock(8,y,5,B.LED,{color:'#ff4fd8'})
    this.world.setBlock(9,y,5,B.LED,{color:'#fdd835'})
    const batteryKey=posKey(5,y,5), arduinoKey=posKey(6,y,5)
    this.mech.addWire(batteryKey,new THREE.Vector3(5.82,y+0.12,5.97),'+',arduinoKey,new THREE.Vector3(6.7,y+0.5,5.78),'VIN','#e53935')
    this.mech.addWire(batteryKey,new THREE.Vector3(5.70,y+0.12,5.97),'-',arduinoKey,new THREE.Vector3(6.82,y+0.5,5.78),'GND','#212121')
    const pinPoint=(pin:number)=>new THREE.Vector3(6.15+pin*0.045,y+0.5,5.24)
    const groundPoint=new THREE.Vector3(6.82,y+0.5,5.78)
    const ledColors=['#00e5ff','#ff4fd8','#fdd835']
    for(let i=0;i<3;i++){
      const ledKey=posKey(7+i,y,5)
      this.mech.addWire(arduinoKey,pinPoint(2+i),`D${2+i}`,ledKey,new THREE.Vector3(8+i,y+0.5,5.5),'anode',ledColors[i])
      this.mech.addWire(arduinoKey,groundPoint,'GND',ledKey,new THREE.Vector3(7+i,y+0.5,5),'cathode','#212121')
    }
    try { window.localStorage.setItem('crafteduc:robot-city-face-preset:'+arduinoKey,'1') } catch {}
  }

  private updateAssistantRobots(dt:number) {
    for(const bot of this.assistantRobots){
      const target=bot.waypoints[bot.waypoint], dx=target.x-bot.group.position.x, dz=target.z-bot.group.position.z, distance=Math.hypot(dx,dz)
      if(distance<0.18){bot.waypoint=(bot.waypoint+1)%bot.waypoints.length;continue}
      const step=Math.min(distance,bot.speed*dt)
      bot.group.position.x+=dx/distance*step; bot.group.position.z+=dz/distance*step
      bot.group.position.y=target.y+Math.sin(this.elapsed*3+bot.phase)*0.035
      bot.group.rotation.y=Math.atan2(dx,dz)
      if(bot.group.children[1]) bot.group.children[1].rotation.y=Math.sin(this.elapsed*2+bot.phase)*0.05
    }
  }

  private buildMarsHoverRobot() {
    const y = GROUND_LEVEL
    const baseX = 28
    const baseZ = 5

    // Low aluminium chassis with two independently driven, rubber-tired wheels.
    for (let x = baseX - 1; x <= baseX + 1; x++) {
      for (let z = baseZ - 1; z <= baseZ + 1; z++) {
        this.world.setBlock(x, y + 1, z, B.ALUMINUM, {
          glue: (1 << 0) | (1 << 1) | (1 << 4) | (1 << 5),
        })
      }
    }
    this.world.setBlock(baseX, y + 2, baseZ, B.ARDUINO_UNO)
    this.world.setBlock(baseX, y + 2, baseZ - 2, B.PROXIMITY_SENSOR, {
      facing: 5, proximityOperator: 'less', proximityDistance: 20,
    })

    // Shaft faces point outwards; each motor is glued to the chassis on its
    // non-output face and has a wheel mounted directly to the output shaft.
    this.world.setBlock(baseX - 2, y + 1, baseZ, B.MOTOR, {
      facing: 1, mountedWheel: true, motorType: 'tt48', glue: 1 << 0,
    })
    this.world.setBlock(baseX + 2, y + 1, baseZ, B.MOTOR, {
      facing: 0, mountedWheel: true, motorType: 'tt48', glue: 1 << 1,
    })
    // Aluminium top deck, a front bumper and a small rear battery bay.
    this.world.setBlock(baseX, y + 2, baseZ + 1, B.ALUMINUM)
    this.world.setBlock(baseX - 1, y + 2, baseZ + 1, B.ALUMINUM)
    this.world.setBlock(baseX + 1, y + 2, baseZ + 1, B.ALUMINUM)
    this.world.setBlock(baseX, y + 1, baseZ + 2, B.ALUMINUM)

    // Arduino headers use local coordinates transformed by the board model.
    const arduinoKey = posKey(baseX, y + 2, baseZ)
    try {
      window.localStorage.setItem(`crafteduc:mars-hover-preset:${arduinoKey}`, '1')
    } catch {}
    const boardTerminal = (id: string, lx: number, lz: number) =>
      new THREE.Vector3(baseX + 1 + lx, y + 2 + 0.14 + 0.134, baseZ + 1 + lz)
    const d2 = boardTerminal('D2', -0.35 + 2 * (0.70 / 13), -0.27)
    const d3 = boardTerminal('D3', -0.35 + 3 * (0.70 / 13), -0.27)
    const d5 = boardTerminal('D5', -0.35 + 5 * (0.70 / 13), -0.27)
    const d6 = boardTerminal('D6', -0.35 + 6 * (0.70 / 13), -0.27)
    const fiveV = boardTerminal('5V', -0.23, 0.28)
    const gnd = boardTerminal('GND', -0.11, 0.28)
    const sensorKey = posKey(baseX, y + 2, baseZ - 2)
    const sensorTerminal = (lx: number, lz: number) =>
      new THREE.Vector3(baseX + 0.5 + lx, y + 2 + 0.5, baseZ - 1.5 + lz)
    const trig = sensorTerminal(-0.12, -0.22)
    const echo = sensorTerminal(0, -0.22)
    const vcc = sensorTerminal(-0.24, -0.22)
    const sensorGnd = sensorTerminal(0.24, -0.22)
    // Motor terminal coordinates are placed on the visible rear end of each model.
    const leftMotorKey = posKey(baseX - 2, y + 1, baseZ)
    const rightMotorKey = posKey(baseX + 2, y + 1, baseZ)
    this.mech.addWire(arduinoKey, d2, 'D2', sensorKey, trig, 'TRIG', '#fdd835')
    this.mech.addWire(arduinoKey, d3, 'D3', sensorKey, echo, 'ECHO', '#43a047')
    this.mech.addWire(arduinoKey, fiveV, '5V', sensorKey, vcc, 'VCC', '#e53935')
    this.mech.addWire(arduinoKey, gnd, 'GND', sensorKey, sensorGnd, 'GND', '#212121')
    this.mech.addWire(arduinoKey, d5, 'D5', leftMotorKey, new THREE.Vector3(baseX - 1.7, y + 1.04, baseZ + 0.4), 'A', '#e53935')
    this.mech.addWire(arduinoKey, d6, 'D6', leftMotorKey, new THREE.Vector3(baseX - 1.3, y + 1.04, baseZ + 0.4), 'B', '#212121')
    this.mech.addWire(arduinoKey, d5.clone().add(new THREE.Vector3(0, 0.02, 0.08)), 'D5', rightMotorKey, new THREE.Vector3(baseX + 2.3, y + 1.04, baseZ + 0.4), 'A', '#e53935')
    this.mech.addWire(arduinoKey, d6.clone().add(new THREE.Vector3(0, 0.02, 0.08)), 'D6', rightMotorKey, new THREE.Vector3(baseX + 2.7, y + 1.04, baseZ + 0.4), 'B', '#212121')
    showToast('Hover de Marte construído: abra o Arduino para carregar o programa de desvio de obstáculos.')
  }

  private buildDemo() {
    const y = GROUND_LEVEL
    const z = -4
    this.world.setBlock(3, y, z, B.BATTERY_BOX, { batteries: 3 })
    this.world.setBlock(6, y, z, B.MOTOR, { facing: 2, glue: 1 << 2 })
    this.world.setBlock(6, y + 1, z, B.IRON, { glue: (1 << 0) | (1 << 1) })
    this.world.setBlock(7, y + 1, z, B.WOOD, { glue: 1 << 0 })
    this.world.setBlock(8, y + 1, z, B.ALUMINUM)
    this.world.setBlock(5, y + 1, z, B.WOOD, { glue: 1 << 1 })
    this.world.setBlock(4, y + 1, z, B.ALUMINUM)
    this.world.setBlock(0, y, z, B.LED)
    this.world.setBlock(0, y, z - 2, B.COMPONENT)
    this.world.setBlock(1, y, z - 2, B.GEAR)
    // The demo circuit uses the battery compartment's distinct +/− terminals
    // and the motor's two isolated terminals, so it is a closed polarized loop.
    this.mech.addWire(posKey(3, y, z), new THREE.Vector3(3.82, y + 0.12, z + 0.97), '+',
      posKey(6, y, z), new THREE.Vector3(6.36, y + 0.04, z + 0.4), 'A')
    this.mech.addWire(posKey(3, y, z), new THREE.Vector3(3.70, y + 0.12, z + 0.97), '-',
      posKey(6, y, z), new THREE.Vector3(6.64, y + 0.04, z + 0.4), 'B')
  }

  private bindEvents() {
    const on = <K extends keyof WindowEventMap>(t: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      window.addEventListener(t, fn, opts)
      this.cleanup.push(() => window.removeEventListener(t, fn, opts))
    }
    on('keydown', this.onKeyDown)
    on('keyup', (e) => this.keys.delete(e.code))
    // Save a final snapshot when a single-player session leaves the page.
    // The pause-menu button remains the explicit, visible save action.
    on('pagehide', () => {
      if (!this.multiplayerBridge && this.singlePlayerWorldPlayed) {
        this.saveCurrentWorld()
      }
    })
    on('blur', () => {
      this.keys.clear()
      this.breakHeld = false
      this.useHeld = false
    })
    on('mousemove', this.onMouseMove)
    on('mouseup', (e) => {
      if (e.button === 0) this.breakHeld = false
      if (e.button === 2) this.useHeld = false
    })
    on('wheel', this.onWheel, { passive: false })
    on('resize', () => this.resize())
    on('pointermove', (e) => {
      if (e.pointerType === 'mouse' && gameStore.get().isTouch && (Math.abs(e.movementX) + Math.abs(e.movementY) > 2))
        gameStore.set({ isTouch: false })
    })
    on('pointerdown', (e) => {
      unlockAudio()
      if (e.pointerType === 'touch' && !gameStore.get().isTouch) gameStore.set({ isTouch: true })
    })

    const md = (e: MouseEvent) => this.onMouseDown(e)
    const cm = (e: Event) => e.preventDefault()
    this.canvas.addEventListener('mousedown', md)
    this.canvas.addEventListener('contextmenu', cm)
    this.cleanup.push(() => {
      this.canvas.removeEventListener('mousedown', md)
      this.canvas.removeEventListener('contextmenu', cm)
    })

    const plc = () => {
      const was = this.locked
      this.locked = document.pointerLockElement === this.canvas
      if (this.locked) this.lockFailed = false
      if (was && !this.locked && gameStore.get().screen === 'playing') gameStore.set({ screen: 'paused' })
    }
    const ple = () => {
      this.lockFailed = true
    }
    document.addEventListener('pointerlockchange', plc)
    document.addEventListener('pointerlockerror', ple)
    this.cleanup.push(() => {
      document.removeEventListener('pointerlockchange', plc)
      document.removeEventListener('pointerlockerror', ple)
    })

    const ro = new ResizeObserver(() => this.resize())
    ro.observe(this.canvas)
    this.cleanup.push(() => ro.disconnect())

    let prevScreen = gameStore.get().screen
    let prevTouch = gameStore.get().isTouch
    const unsub = gameStore.subscribe(() => {
      const s = gameStore.get()
      if (s.screen !== prevScreen) {
        if (s.screen === 'playing') {
          this.requestLock()
          if (!this.multiplayerBridge) this.singlePlayerWorldPlayed = true
        }
        else this.releaseLock()
        if (s.screen !== 'playing') {
          this.breakHeld = false
          this.useHeld = false
          this.keys.clear()
        }
        prevScreen = s.screen
      }
      if (s.isTouch !== prevTouch) {
        prevTouch = s.isTouch
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, s.isTouch ? 1.5 : 2))
        this.resize()
        if (s.isTouch) this.releaseLock()
      }
    })
    this.cleanup.push(unsub)
  }

  requestLock() {
    if (gameStore.get().isTouch) return
    if (document.pointerLockElement === this.canvas) return
    try {
      const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined
      if (r && typeof r.catch === 'function') r.catch(() => (this.lockFailed = true))
    } catch {
      this.lockFailed = true
    }
  }

  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock()
  }

  exportNetworkWorld(playerKey: string): { blocks: BlockEdit[]; wires: NetworkWire[] } {
    const blocks = new Map<string, BlockEdit>()
    for (const chunk of this.world.chunks.values()) {
      if (!chunk.modified) continue
      const baseX = chunk.cx * CHUNK_SIZE
      const baseZ = chunk.cz * CHUNK_SIZE
      for (let y = GROUND_LEVEL; y < WORLD_HEIGHT; y++) {
        const row = y * CHUNK_SIZE * CHUNK_SIZE
        for (let z = 0; z < CHUNK_SIZE; z++) {
          const rowZ = row + z * CHUNK_SIZE
          for (let x = 0; x < CHUNK_SIZE; x++) {
            const block = chunk.data[rowZ + x]
            if (block === B.AIR) continue
            const wx = baseX + x
            const wz = baseZ + z
            const state = this.world.getState(wx, y, wz)
            blocks.set(posKey(wx, y, wz), {
              x: wx, y, z: wz, block, state: state ? { ...state } : undefined,
            })
          }
        }
      }
    }
    for (const block of this.mech.exportNetworkBlocks()) {
      blocks.set(posKey(block.x, block.y, block.z), { ...block })
    }
    const wires = this.mech.wires.map((wire) => {
      if (!wire.networkId) wire.networkId = `wire_${playerKey.slice(0, 12)}_${wire.id}`
      return {
        id: wire.networkId,
        a: wire.a, b: wire.b, ta: wire.ta, tb: wire.tb,
        pa: { x: wire.pa.x, y: wire.pa.y, z: wire.pa.z },
        pb: { x: wire.pb.x, y: wire.pb.y, z: wire.pb.z },
      }
    })
    return { blocks: [...blocks.values()], wires }
  }

  setLocalMultiplayerPlayer(data: Record<string, unknown> | null | undefined) {
    if (!data) return
    const finite = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback
    this.player.pos.set(finite(data.x, 0.5), finite(data.y, GROUND_LEVEL), finite(data.z, 0.5))
    this.player.yaw = finite(data.yaw, 0)
    this.player.pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, finite(data.pitch, 0)))
    this.player.vel.set(finite(data.velocityX, 0), finite(data.velocityY, 0), finite(data.velocityZ, 0))
    this.player.flying = Boolean(data.flying) && this.multiplayerCanFly
    this.player.sneaking = Boolean(data.sneaking)
    this.player.onGround = Boolean(data.onGround)
    gameStore.set({ flying: this.player.flying, sneaking: this.player.sneaking })
  }

  setMultiplayerBridge(bridge: MultiplayerBridge | null) {
    this.multiplayerBridge = bridge
    this.mech.setNetworkAuthority(!bridge || bridge.isHost)
    this.mech.setNetworkBlockPublisher(
      bridge ? (x, y, z, block, state, ownerKey) => bridge.blockChanged(x, y, z, block, state, ownerKey) : null,
      bridge ? (x, y, z) => bridge.ownerForBlock(x, y, z) : null,
    )
    if (!bridge) {
      this.multiplayerCanFly = true
      this.multiplayerRules = null
      this.setRemotePlayers([])
    }
  }

  setMultiplayerRules(rules: MultiplayerRules, isHost: boolean) {
    this.multiplayerRules = { ...rules }
    this.multiplayerCanFly = isHost || rules.playersCanFly
    if (!this.multiplayerCanFly && this.player.flying) {
      this.player.flying = false
      this.player.vel.y = Math.min(0, this.player.vel.y)
      gameStore.set({ flying: false })
      showToast('O anfitrião desativou o voo para os jogadores')
    }
  }

  applyMultiplayerBlock(edit: BlockEdit) {
    if (![edit.x, edit.y, edit.z, edit.block].every(Number.isInteger)) return
    if (edit.y < 0 || edit.y >= WORLD_HEIGHT || edit.block < B.AIR || edit.block > 255) return
    this.applyingNetworkBlock = true
    try {
      const oldId = this.world.getBlock(edit.x, edit.y, edit.z)
      const oldState = this.world.getState(edit.x, edit.y, edit.z)
      const nextState = edit.state && typeof edit.state === 'object' ? { ...edit.state } : undefined
      const sameState = JSON.stringify(oldState ?? null) === JSON.stringify(nextState ?? null)
      if (oldId === edit.block && sameState) return
      if (oldId === edit.block) {
        const key = posKey(edit.x, edit.y, edit.z)
        if (nextState && Object.keys(nextState).length) this.world.states.set(key, nextState)
        else this.world.states.delete(key)
        this.mech.applyNetworkBlockState(edit.x, edit.y, edit.z, oldState, nextState)
      } else {
        this.world.setBlock(edit.x, edit.y, edit.z, edit.block, nextState)
      }
    } finally {
      this.applyingNetworkBlock = false
    }
  }

  applyMultiplayerWire(wire: NetworkWire) {
    if (!wire?.id || typeof wire.a !== 'string' || typeof wire.b !== 'string') return
    const pa = new THREE.Vector3(wire.pa?.x, wire.pa?.y, wire.pa?.z)
    const pb = new THREE.Vector3(wire.pb?.x, wire.pb?.y, wire.pb?.z)
    if (![pa.x, pa.y, pa.z, pb.x, pb.y, pb.z].every(Number.isFinite)) return
    // A moving machine can update the endpoints of an existing network wire.
    // Replace its local mesh and mark the circuit dirty instead of ignoring every
    // subsequent wire_upsert for the same network ID.
    if (this.mech.wires.some((existing) => existing.networkId === wire.id)) {
      this.mech.removeWireByNetworkId(wire.id)
    }
    this.mech.addWire(wire.a, pa, wire.ta, wire.b, pb, wire.tb)
    const added = this.mech.wires[this.mech.wires.length - 1]
    if (added) added.networkId = wire.id
  }

  removeMultiplayerWire(networkId: string) {
    this.mech.removeWireByNetworkId(networkId)
  }

  /** Execute an interaction on a moving assembly only on the host's authoritative world. */
  applyMultiplayerMovingAction(intent: MovingActionIntent) {
    if (!this.multiplayerBridge?.isHost) return
    if (!intent || typeof intent.playerKey !== 'string' || !intent.movingKey) return
    const [sourceX, sourceY, sourceZ] = parseKey(intent.movingKey)
    if (intent.action === 'break' && !this.multiplayerBridge.canBreakBlock(sourceX, sourceY, sourceZ, intent.playerKey)) {
      showToast('A regra do servidor impede quebrar esse bloco')
      return
    }
    const cell = this.mech.releaseMovingBlock(intent.movingKey, intent.movingKind)
    if (!cell) {
      showToast('Não foi possível estabilizar a máquina para aplicar a ação')
      return
    }
    if (intent.action === 'break') {
      this.world.setBlock(cell.x, cell.y, cell.z, B.AIR)
      this.multiplayerBridge.blockChanged(cell.x, cell.y, cell.z, B.AIR)
      this.multiplayerBridge.wiresRemovedAt(posKey(cell.x, cell.y, cell.z))
      this.particles.burst(cell.x, cell.y, cell.z, tileFor(cell.id, false))
      sfx.break(METAL.has(cell.id))
      return
    }

    const item = intent.item
    if (isWireItem(item)) {
      showToast('Conecte fios após a máquina ser estabilizada')
      return
    }
    if (item === 'glue') {
      this.mech.toggleGlue(cell.x, cell.y, cell.z, intent.face)
      const state = this.world.getState(cell.x, cell.y, cell.z)
      this.multiplayerBridge.blockChanged(cell.x, cell.y, cell.z, this.world.getBlock(cell.x, cell.y, cell.z), state ? { ...state } : undefined)
      return
    }
    if (cell.id === B.BATTERY_BOX && (item === 'battery' || item === null)) {
      const result = this.mech.changeBatteries(cell.x, cell.y, cell.z, item === 'battery' ? 1 : -1)
      if (result.after !== result.before) {
        const state = this.world.getState(cell.x, cell.y, cell.z)
        this.multiplayerBridge.blockChanged(cell.x, cell.y, cell.z, cell.id, state ? { ...state } : undefined)
      }
      return
    }
    if (cell.id === B.MOTOR && item === 'wheel') {
      if (this.mech.mountWheel(cell.x, cell.y, cell.z)) {
        const state = this.world.getState(cell.x, cell.y, cell.z)
        this.multiplayerBridge.blockChanged(cell.x, cell.y, cell.z, cell.id, state ? { ...state } : undefined)
      }
      return
    }
    if (cell.id === B.SERVO && (item === null || item === 'servo') && !intent.sneaking) {
      this.mech.rotateServo(cell.x, cell.y, cell.z)
      const state = this.world.getState(cell.x, cell.y, cell.z)
      this.multiplayerBridge.blockChanged(cell.x, cell.y, cell.z, cell.id, state ? { ...state } : undefined)
      return
    }
    if (cell.id === B.MOTOR && (item == null || isMotorItemId(item))) {
      this.mech.rotateMotor(cell.x, cell.y, cell.z, intent.sneaking)
      const state = this.world.getState(cell.x, cell.y, cell.z)
      this.multiplayerBridge.blockChanged(cell.x, cell.y, cell.z, cell.id, state ? { ...state } : undefined)
      const motorKey = posKey(cell.x, cell.y, cell.z)
      const power = this.mech.motorPowerLevel(motorKey)
      if (power <= 0) showToast('Motor girado, mas sem energia: conecte +/− da bateria aos terminais A/B')
      else if (!this.mech.isMotorDriving(motorKey)) showToast('Motor alimentado, mas sem carga: cole o braço na face do eixo de saída')
      return
    }

    if (!item) return
    const block = ITEMS[item].block
    if (block === undefined) return
    const direction = DIRS[intent.face]
    if (!direction) return
    const x = cell.x + direction[0]
    const y = cell.y + direction[1]
    const z = cell.z + direction[2]
    if (y < 0 || y >= WORLD_HEIGHT || this.world.getBlock(x, y, z) !== B.AIR) return
    if (this.isMotorFootprintOccupied(x, y, z)) {
      showToast('Esse espaço já está ocupado pela carcaça de um motor')
      return
    }
    const state: import('./world').BlockState | undefined = block === B.SERVO ? { facing: intent.face, servoOffAngle: 0, servoOnAngle: 90 } : block === B.MOTOR ? { facing: OPPOSITE[intent.face], motorType: ITEMS[item].motorType ?? 'fa130', motorRoll: 0 } : block === B.WHEEL ? { facing: intent.face } : block === B.BATTERY_BOX ? { batteries: 0 } : block === B.PROXIMITY_SENSOR ? { facing: intent.face, proximityOperator: 'less', proximityDistance: 3, proximityActive: false } : block === B.RESISTOR ? { resistorDigit1: 1, resistorDigit2: 0, resistorMultiplier: 1, resistorTolerance: 5 } : undefined
    if (block === B.MOTOR && this.motorModelOverlapsBlocks(x, y, z, ITEMS[item].motorType ?? 'fa130', state?.facing ?? 2, state?.motorRoll ?? 0, posKey(cell.x, cell.y, cell.z))) {
      showToast('O motor não cabe nesse espaço: há um bloco na área da carcaça')
      return
    }
    this.world.setBlock(x, y, z, block, state)
    this.multiplayerBridge.blockChanged(x, y, z, block, state)
    sfx.place(METAL.has(block))
  }

  setRemotePlayers(players: NetworkPlayer[]) {
    const active = new Set<string>()
    for (const player of players) {
      if (!player?.id || !player.data || !player.skin) continue
      active.add(player.id)
      const skinSignature = JSON.stringify({ name: player.name, skin: player.skin })
      let avatar = this.remoteAvatars.get(player.id)
      if (!avatar || avatar.skinSignature !== skinSignature) {
        if (avatar) {
          this.scene.remove(avatar.group)
          avatar.group.traverse((object) => {
            if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
              if (object instanceof THREE.Mesh) object.geometry.dispose()
              const materials = Array.isArray(object.material) ? object.material : [object.material]
              for (const material of materials) {
                if ('map' in material && material.map) material.map.dispose()
                material.dispose()
              }
            }
          })
        }
        const group = this.createRemoteAvatar(player.name || 'Jogador', player.skin)
        this.scene.add(group)
        avatar = {
          group,
          targetPosition: new THREE.Vector3(player.data.x, player.data.y, player.data.z),
          targetYaw: player.data.yaw || 0,
          skinSignature,
        }
        group.position.copy(avatar.targetPosition)
        group.rotation.y = avatar.targetYaw
        this.remoteAvatars.set(player.id, avatar)
      }
      avatar.targetPosition.set(player.data.x, player.data.y, player.data.z)
      avatar.targetYaw = Number.isFinite(player.data.yaw) ? player.data.yaw : 0
    }
    for (const [id, avatar] of this.remoteAvatars) {
      if (active.has(id)) continue
      this.scene.remove(avatar.group)
      avatar.group.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
          if (object instanceof THREE.Mesh) object.geometry.dispose()
          const materials = Array.isArray(object.material) ? object.material : [object.material]
          for (const material of materials) {
            if ('map' in material && material.map) material.map.dispose()
            material.dispose()
          }
        }
      })
      this.remoteAvatars.delete(id)
    }
  }

  private createRemoteAvatar(name: string, skin: SkinConfig) {
    const root = new THREE.Group()
    root.name = `Remote player: ${name.slice(0, 20)}`
    const part = (w: number, h: number, d: number, color: string, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshBasicMaterial({ color }),
      )
      mesh.position.set(x, y, z)
      root.add(mesh)
      return mesh
    }
    const darken = (hex: string) => {
      const c = new THREE.Color(hex)
      c.multiplyScalar(0.72)
      return `#${c.getHexString()}`
    }
    part(0.52, 0.68, 0.30, skin.shirt, 0, 1.04, 0)
    part(0.23, 0.68, 0.24, skin.pants, -0.135, 0.36, 0)
    part(0.23, 0.68, 0.24, skin.pants, 0.135, 0.36, 0)
    part(0.24, 0.13, 0.29, skin.shoes, -0.135, 0.065, 0.025)
    part(0.24, 0.13, 0.29, skin.shoes, 0.135, 0.065, 0.025)
    part(0.18, 0.65, 0.22, skin.shirt, -0.36, 1.05, 0)
    part(0.18, 0.65, 0.22, skin.shirt, 0.36, 1.05, 0)
    part(0.48, 0.48, 0.42, skin.skin, 0, 1.66, 0)
    part(0.50, 0.15, 0.44, skin.hair, 0, 1.91, -0.01)
    part(0.51, 0.18, 0.44, skin.hair, 0, 1.77, -0.215)
    if (skin.accessory === 'cap') {
      part(0.54, 0.12, 0.52, skin.accessoryColor, 0, 1.96, 0)
      part(0.58, 0.055, 0.40, skin.accessoryColor, 0, 1.89, 0.13)
    } else if (skin.accessory === 'antenna') {
      part(0.055, 0.24, 0.055, skin.accessoryColor, 0, 2.10, 0)
      part(0.14, 0.14, 0.14, skin.accessoryColor, 0, 2.24, 0)
    } else if (skin.accessory === 'headphones') {
      part(0.075, 0.34, 0.12, skin.accessoryColor, -0.255, 1.72, 0)
      part(0.075, 0.34, 0.12, skin.accessoryColor, 0.255, 1.72, 0)
      part(0.54, 0.065, 0.065, darken(skin.accessoryColor), 0, 1.92, 0)
    } else if (skin.accessory === 'glasses' || skin.accessory === 'goggles') {
      const thickness = skin.accessory === 'goggles' ? 0.12 : 0.045
      part(0.20, thickness, 0.035, skin.accessoryColor, -0.115, 1.70, 0.218)
      part(0.20, thickness, 0.035, skin.accessoryColor, 0.115, 1.70, 0.218)
      part(0.055, 0.035, 0.035, skin.accessoryColor, 0, 1.70, 0.22)
    }
    const label = document.createElement('canvas')
    label.width = 256
    label.height = 64
    const ctx = label.getContext('2d')
    if (ctx) {
      ctx.clearRect(0, 0, label.width, label.height)
      ctx.fillStyle = 'rgba(0,0,0,0.65)'
      ctx.fillRect(8, 8, 240, 48)
      ctx.font = 'bold 26px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#ffffff'
      ctx.fillText(name.slice(0, 20), 128, 32, 224)
    }
    const texture = new THREE.CanvasTexture(label)
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }))
    tag.position.set(0, 2.38, 0)
    tag.scale.set(2.1, 0.52, 1)
    root.add(tag)
    return root
  }

  private updateRemoteAvatars(dt: number) {
    const blend = 1 - Math.exp(-Math.max(0, dt) * 14)
    for (const avatar of this.remoteAvatars.values()) {
      avatar.group.position.lerp(avatar.targetPosition, blend)
      const delta = Math.atan2(Math.sin(avatar.targetYaw - avatar.group.rotation.y), Math.cos(avatar.targetYaw - avatar.group.rotation.y))
      avatar.group.rotation.y += delta * blend
    }
  }

  private restoreSavedWorld(save: SavedWorldRecord) {
    for (const block of save.data.blocks ?? []) {
      if (!block || ![block.x, block.y, block.z, block.id].every(Number.isInteger)) continue
      if (block.y < 0 || block.y >= WORLD_HEIGHT || block.id < B.AIR || block.id > B.RESISTOR) continue
      this.world.setBlock(block.x, block.y, block.z, block.id, block.state)
    }

    for (const wire of save.data.wires ?? []) {
      if (!wire || typeof wire.a !== 'string' || typeof wire.b !== 'string') continue
      if (!Array.isArray(wire.pa) || !Array.isArray(wire.pb) || wire.pa.length !== 3 || wire.pb.length !== 3) continue
      if (![...wire.pa, ...wire.pb].every(Number.isFinite)) continue
      this.mech.addWire(
        wire.a, new THREE.Vector3(...wire.pa), wire.ta,
        wire.b, new THREE.Vector3(...wire.pb), wire.tb, wire.color,
      )
    }
    restoreArduinoProgramsForWorld(this.worldConfig.id, save.data.arduinoPrograms)
  }

  saveCurrentWorld(): SavedWorldRecord | null {
    const blocks = new Map<string, SavedBlock>()
    for (const chunk of this.world.chunks.values()) {
      if (!chunk.modified) continue
      const baseX = chunk.cx * CHUNK_SIZE
      const baseZ = chunk.cz * CHUNK_SIZE
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        const row = y * CHUNK_SIZE * CHUNK_SIZE
        for (let z = 0; z < CHUNK_SIZE; z++) {
          const rowZ = row + z * CHUNK_SIZE
          for (let x = 0; x < CHUNK_SIZE; x++) {
            const wx = baseX + x
            const wz = baseZ + z
            const id = chunk.data[rowZ + x]
            const state = this.world.getState(wx, y, wz)
            if (id === this.world.terrainBlockAt(wx, y, wz) && !state) continue
            blocks.set(posKey(wx, y, wz), {
              x: wx, y, z: wz, id,
              ...(state ? { state: { ...state } } : {}),
            })
          }
        }
      }
    }

    for (const [key, state] of this.world.states) {
      const [x, y, z] = parseKey(key)
      const id = this.world.getBlock(x, y, z)
      const existing = blocks.get(key)
      blocks.set(key, { x, y, z, id, state: { ...(existing?.state ?? {}), ...state } })
    }

    // Include blocks currently participating in articulated or falling machines,
    // which may temporarily be absent from their stationary voxel positions.
    for (const moving of this.mech.exportNetworkBlocks()) {
      const key = posKey(moving.x, moving.y, moving.z)
      blocks.set(key, {
        x: moving.x, y: moving.y, z: moving.z, id: moving.block,
        ...(moving.state ? { state: { ...moving.state } } : {}),
      })
    }

    const data: SavedWorldData = {
      version: 1,
      blocks: [...blocks.values()],
      wires: this.mech.wires.map((wire) => ({
        a: wire.a, b: wire.b, ta: wire.ta, tb: wire.tb,
        pa: [wire.pa.x, wire.pa.y, wire.pa.z],
        pb: [wire.pb.x, wire.pb.y, wire.pb.z],
        color: wire.color,
      })),
      player: {
        x: this.player.pos.x, y: this.player.pos.y, z: this.player.pos.z,
        yaw: this.player.yaw, pitch: this.player.pitch,
        flying: this.player.flying, sneaking: this.player.sneaking,
      },
      arduinoPrograms: getArduinoProgramsForWorld(this.worldConfig.id),
    }
    return saveWorldRecord(this.worldConfig, data)
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.handCamera.aspect = w / h
    this.handCamera.updateProjectionMatrix()
  }

  dispose() {
    this.physicsDebugLabel?.remove()
    this.physicsDebugLabel = null
    cancelAnimationFrame(this.raf)
    for (const c of this.cleanup) c()
    this.releaseLock()
    this.setMultiplayerBridge(null)
    for (const avatar of this.remoteAvatars.values()) this.scene.remove(avatar.group)
    this.remoteAvatars.clear()
    this.world.dispose()
    this.renderer.dispose()
    if (current === this) current = null
  }

  /* ---------------- Input ---------------- */

  private onKeyDown = (e: KeyboardEvent) => {
    const s = gameStore.get()
    if (e.code === 'F3') {
      e.preventDefault()
      gameStore.set({ debug: !s.debug })
      return
    }
    if (e.code === 'KeyE' && (s.screen === 'playing' || s.screen === 'inventory')) {
      e.preventDefault()
      gameStore.set({ screen: s.screen === 'playing' ? 'inventory' : 'playing' })
      return
    }
    if (e.code === 'Escape') {
      if (s.screen === 'brush_color') gameStore.set({ screen: s.returnScreen === 'brush_color' ? 'playing' : s.returnScreen })
      else if (s.screen === 'sensor_config') gameStore.set({ sensorConfigKey: null, screen: 'playing' })
      else if (s.screen === 'servo_config') gameStore.set({ servoConfigKey: null, screen: 'playing' })
      else if (s.screen === 'resistor_config') gameStore.set({ resistorConfigKey: null, screen: 'playing' })
      else if (s.screen === 'arduino_programming') gameStore.set({ arduinoProgramKey: null, screen: 'playing' })
      else if (s.screen === 'inventory') gameStore.set({ screen: 'playing' })
      else if (s.screen === 'playing') gameStore.set({ screen: 'paused' })
      else if (s.screen === 'paused') gameStore.set({ screen: 'playing' })
      return
    }
    if (s.screen !== 'playing') return
    if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5))
      if (n >= 1 && n <= 9) gameStore.set({ selected: n - 1 })
    }
    if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault()
    if (e.code === 'Space' && !e.repeat) {
      const now = performance.now()
      if (now - this.lastSpace < 300) {
        this.toggleFly()
        this.lastSpace = 0
      } else this.lastSpace = now
    }
    if (e.code === 'KeyW' && !e.repeat) {
      const now = performance.now()
      if (now - this.lastW < 280) this.sprintLatch = true
      this.lastW = now
    }
    if (e.code === 'ControlLeft' || e.code === 'ControlRight') e.preventDefault()
    this.keys.add(e.code)
  }

  private onMouseMove = (e: MouseEvent) => {
    const s = gameStore.get()
    if (s.screen !== 'playing' || s.isTouch) return
    if (!this.locked && !this.lockFailed) return
    this.look(e.movementX, e.movementY, 0.0022)
  }

  look(dx: number, dy: number, factor: number) {
    const sens = gameStore.get().settings.sensitivity
    this.player.yaw -= dx * factor * sens
    this.player.pitch -= dy * factor * sens
    const lim = Math.PI / 2 - 0.001
    this.player.pitch = Math.max(-lim, Math.min(lim, this.player.pitch))
  }

  private onWheel = (e: WheelEvent) => {
    const s = gameStore.get()
    if (s.screen !== 'playing') return
    e.preventDefault()
    const dir = Math.sign(e.deltaY)
    if (dir === 0) return
    gameStore.set({ selected: (s.selected + dir + 9) % 9 })
  }

  private onMouseDown(e: MouseEvent) {
    const s = gameStore.get()
    if (s.screen !== 'playing' || s.isTouch) return
    if (e.button === 2 && e.shiftKey && this.selectedItem() === 'paintbrush') {
      e.preventDefault()
      gameStore.set({ returnScreen: 'playing', screen: 'brush_color' })
      return
    }
    if (!this.locked && !this.lockFailed) {
      this.requestLock()
      return
    }
    e.preventDefault()
    if (e.button === 0) {
      this.breakHeld = true
      this.breakTimer = 0.3
      this.breakBlock()
    } else if (e.button === 2) {
      this.useHeld = true
      this.useTimer = 0.25
      this.use()
    } else if (e.button === 1) {
      this.pickBlock()
    }
  }

  toggleFly() {
    if (!this.player.flying && this.multiplayerBridge && !this.multiplayerCanFly) {
      showToast('O anfitrião desativou o voo para os jogadores')
      return
    }
    this.player.flying = !this.player.flying
    if (this.player.flying) this.player.vel.y = 0
    gameStore.set({ flying: this.player.flying })
    showToast(this.player.flying ? 'Modo de voo ativado' : 'Modo de voo desativado')
  }

  /* touch API (used by the mobile controls) */
  touchPress() {
    this.touchHolding = true
    this.touchHoldTime = 0
    this.touchBroke = false
    this.touchMovedFar = false
  }
  touchMoved() {
    if (!this.touchBroke) this.touchMovedFar = true
  }
  touchRelease() {
    if (this.touchHolding && !this.touchBroke && !this.touchMovedFar && this.touchHoldTime < 0.35) this.use()
    this.touchHolding = false
    gameStore.set({ breakProgress: 0 })
  }

  /* ---------------- Actions ---------------- */

  private selectedItem(): ItemId | null {
    const s = gameStore.get()
    return s.hotbar[s.selected]
  }

  private scanAssembly(hit: Hit) {
    const startKey = posKey(hit.x, hit.y, hit.z)
    const startId = this.world.getBlock(hit.x, hit.y, hit.z) || hit.id
    if (startId === B.AIR) {
      showToast('Nenhum bloco físico disponível para análise')
      return
    }

    type Cell = { x: number; y: number; z: number; id: number; state: NonNullable<ReturnType<World['getState']>> }
    const cells: Cell[] = []
    const seen = new Set<string>()
    const queue: [number, number, number][] = [[hit.x, hit.y, hit.z]]
    seen.add(startKey)
    while (queue.length && cells.length < 500) {
      const [x, y, z] = queue.shift()!
      const id = this.world.getBlock(x, y, z) || (posKey(x, y, z) === startKey ? startId : B.AIR)
      if (id === B.AIR) continue
      const state = this.world.getState(x, y, z) ?? {}
      cells.push({ x, y, z, id, state })
      const glueMask = state.glue ?? 0
      for (let face = 0; face < DIRS.length; face++) {
        const [dx, dy, dz] = DIRS[face]
        const nx = x + dx, ny = y + dy, nz = z + dz
        const neighborKey = posKey(nx, ny, nz)
        if (seen.has(neighborKey)) continue
        const neighborId = this.world.getBlock(nx, ny, nz)
        if (neighborId === B.AIR) continue
        const neighborGlue = this.world.getState(nx, ny, nz)?.glue ?? 0
        const glued = Boolean(glueMask & (1 << face)) || Boolean(neighborGlue & (1 << OPPOSITE[face]))
        if (!glued) continue
        seen.add(neighborKey)
        queue.push([nx, ny, nz])
      }
    }

    if (cells.length >= 500) showToast('Limite de análise: 500 blocos por leitura')
    const count = cells.length
    const min = { x: Math.min(...cells.map((b) => b.x)), y: Math.min(...cells.map((b) => b.y)), z: Math.min(...cells.map((b) => b.z)) }
    const max = { x: Math.max(...cells.map((b) => b.x)), y: Math.max(...cells.map((b) => b.y)), z: Math.max(...cells.map((b) => b.z)) }
    let massKg = 0, cx = 0, cy = 0, cz = 0, friction = 0, conductivity = 0
    const groups = new Map<string, { name: string; count: number; massKg: number }>()
    for (const cell of cells) {
      const state = { batteries: cell.state.batteries, mountedWheel: cell.state.mountedWheel, motorType: cell.state.motorType }
      const mass = blockMass(cell.id, state)
      massKg += mass
      cx += (cell.x + 0.5) * mass
      cy += (cell.y + 0.5) * mass
      cz += (cell.z + 0.5) * mass
      friction += blockFriction(cell.id)
      conductivity += blockConductivity(cell.id)
      const itemId = BLOCK_TO_ITEM[cell.id]
      const name = cell.id === B.COLOR_BLOCK
        ? 'Bloco colorido'
        : itemId ? ITEMS[itemId].name : 'Bloco estrutural'
      const entry = groups.get(name) ?? { name, count: 0, massKg: 0 }
      entry.count++
      entry.massKg += mass
      groups.set(name, entry)
    }
    const center = { x: cx / massKg, y: cy / massKg, z: cz / massKg }
    let ix = 0, iy = 0, iz = 0
    for (const cell of cells) {
      const mass = blockMass(cell.id, { batteries: cell.state.batteries, mountedWheel: cell.state.mountedWheel, motorType: cell.state.motorType })
      const dx = cell.x + 0.5 - center.x, dy = cell.y + 0.5 - center.y, dz = cell.z + 0.5 - center.z
      // Unit-cube intrinsic inertia (m/6) plus the parallel-axis contribution.
      ix += mass / 6 + mass * (dy * dy + dz * dz)
      iy += mass / 6 + mass * (dx * dx + dz * dz)
      iz += mass / 6 + mass * (dx * dx + dy * dy)
    }
    let gluedConnections = 0
    const scanned = new Set(cells.map((cell) => posKey(cell.x, cell.y, cell.z)))
    for (const cell of cells) {
      const mask = cell.state.glue ?? 0
      for (let face = 0; face < DIRS.length; face++) {
        const [dx, dy, dz] = DIRS[face]
        const nk = posKey(cell.x + dx, cell.y + dy, cell.z + dz)
        if (!scanned.has(nk)) continue
        const neighborGlue = this.world.getState(cell.x + dx, cell.y + dy, cell.z + dz)?.glue ?? 0
        if ((mask & (1 << face)) || (neighborGlue & (1 << OPPOSITE[face]))) {
          // Count each glued interface once, from the lexicographically smaller voxel key.
          if (posKey(cell.x, cell.y, cell.z) < nk) gluedConnections++
        }
      }
    }

    for (const cell of cells) this.particles.burst(cell.x, cell.y, cell.z, tileFor(cell.id, false), Math.min(5, Math.max(2, Math.floor(80 / count))))
    gameStore.set({
      scannerReport: {
        blockCount: count,
        massKg,
        dimensions: { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 },
        centerOfMass: center,
        inertia: { x: ix, y: iy, z: iz },
        averageFriction: friction / count,
        averageConductivity: conductivity / count,
        gluedConnections,
        composition: [...groups.values()].sort((a, b) => b.massKg - a.massKg),
      },
      screen: 'scanner',
    })
  }

  use() {
    unlockAudio()
    const item = this.selectedItem()
    let hit = this.target
    this.swing = 0
    this.lastUseWasPlace = false

    // Resolve the block from the voxel grid as well as the raycast payload:
    // custom 3D models can report their mesh hit separately from the block id.
    const targetBlockId = hit
      ? (this.world.getBlock(hit.x, hit.y, hit.z) || hit.id)
      : B.AIR
    if (item === 'scanner_dws') {
      if (!hit || targetBlockId === B.AIR) {
        showToast('Aponte o Scanner DWS para um bloco da montagem')
        return
      }
      this.scanAssembly(hit)
      return
    }
    // The tablet opens the appropriate editor for each programmable component.
    // Other items, especially wire, continue through their normal interaction paths.
    if (hit && targetBlockId === B.ARDUINO_UNO && item === 'programming_tablet') {
      const key = hit.moving?.key ?? posKey(hit.x, hit.y, hit.z)
      gameStore.set({ arduinoProgramKey: key, screen: 'arduino_programming' })
      return
    }
    // Articulated bodies are authoritative on the host. Guests send an intent
    // rather than disassembling their local visual replica independently.
    if (hit?.moving && this.multiplayerBridge && !this.multiplayerBridge.isHost) {
      if (isWireItem(item)) {
        showToast('Conecte fios após a máquina ser estabilizada')
        return
      }
      this.multiplayerBridge.movingAction({
        action: 'use', movingKey: hit.moving.key, movingKind: hit.moving.kind,
        face: hit.face, item, sneaking: this.player.sneaking,
      })
      return
    }

    // Toggle a switch without disassembling the moving assembly it belongs to.
    if (hit?.moving && hit.id === B.SWITCH && (item === null || item === 'switch')) {
      const enabled = this.mech.toggleSwitchAtKey(hit.moving.key)
      if (enabled !== null) {
        sfx.click()
        showToast('Interruptor ' + (enabled ? 'ligado' : 'desligado'))
      }
      return
    }

    // Dynamic bodies are interactive, but voxel placement/wiring still uses
    // the world's integer grid. Resolve the source identity before editing.
    if (hit?.moving) {
      const cell = this.mech.releaseMovingBlock(hit.moving.key, hit.moving.kind)
      if (!cell) {
        showToast('Não foi possível estabilizar esse conjunto para editar')
        return
      }
      hit = { ...hit, ...cell, moving: undefined }
      this.target = hit
    }

    if (item === 'multimeter') {
      if (!hit) return
      const key = hit.moving?.key ?? posKey(hit.x, hit.y, hit.z)
      const terminal = this.mech.resolveTerminal(
        key, hit.point, hit.face, this.targetRayOrigin, this.targetRayDirection,
      )
      if (!terminal) {
        showToast('Encoste uma ponta de prova em um terminal elétrico exposto.')
        return
      }
      const currentMeter = gameStore.get()
      const probe = { key, terminal: terminal.terminal }
      if (!currentMeter.multimeterFirstProbe) {
        gameStore.set({
          multimeterFirstProbe: probe,
          multimeterReading: `Ponta vermelha: ${terminal.terminal} em ${key}. Selecione o segundo terminal.`,
        })
        sfx.click()
        return
      }
      const first = currentMeter.multimeterFirstProbe
      const reading = this.mech.measureMultimeter(currentMeter.multimeterMode, first, probe)
      gameStore.set({ multimeterFirstProbe: null, multimeterReading: reading })
      showToast(reading)
      sfx.click()
      return
    }

    if (isWireItem(item)) {
      if (!hit) return
      const key = hit.moving?.key ?? posKey(hit.x, hit.y, hit.z)
      const terminal = this.mech.resolveTerminal(
        key, hit.point, hit.face, this.targetRayOrigin, this.targetRayDirection,
      )
      if (!terminal) {
        showToast('Mire em um terminal exposto; madeira não conduz energia')
        return
      }
      if (!this.wireStart) {
        this.wireStart = { key, terminal: terminal.terminal, point: terminal.point.clone() }
        sfx.click()
        showToast(`Terminal selecionado: ${terminal.terminal}`)
        return
      }
      if (this.wireStart.key === key && this.wireStart.terminal === terminal.terminal) {
        this.wireStart = null
        showToast('Fio cancelado')
        return
      }
      this.mech.addWire(
        this.wireStart.key, this.wireStart.point, this.wireStart.terminal,
        key, terminal.point.clone(), terminal.terminal, ITEMS[item]?.color ?? '#fdd835',
      )
      const createdWire = this.mech.wires[this.mech.wires.length - 1]
      if (createdWire) this.multiplayerBridge?.wireCreated(createdWire)
      this.wireStart = null
      sfx.zap()
      showToast('Fio conectado aos terminais')
      return
    }

    if (!hit) return

    // Open the resistor's four-band value editor with the empty hand or resistor item.
    // Wire use is resolved above so each lead remains independently connectable.
    if (hit.id === B.RESISTOR && (item === null || item === 'resistor') && !this.player.sneaking) {
      const key = hit.moving?.key ?? posKey(hit.x, hit.y, hit.z)
      gameStore.set({ resistorConfigKey: key, screen: 'resistor_config' })
      return
    }

    // Match the motor's ergonomics: the empty hand or sensor item rotates it.
    // Holding a wire reaches the wiring handler above; the tablet opens its panel earlier.
    if (hit.id === B.SERVO && (item === null || item === 'servo') && !this.player.sneaking) {
      if (hit.moving) {
        showToast('Desligue o servo antes de mudar sua orientação')
        return
      }
      const facing = this.mech.rotateServo(hit.x, hit.y, hit.z)
      if (facing !== null) {
        sfx.rotate()
        showToast(`Servo virado para: ${DIR_NAMES[facing]}`)
      }
      return
    }

    if (hit.id === B.PROXIMITY_SENSOR && (item === null || item === 'proximity_sensor') && !this.player.sneaking) {
      const key = posKey(hit.x, hit.y, hit.z)
      const facing = this.mech.rotateProximitySensor(key)
      if (facing !== null) {
        const state = this.world.getState(hit.x, hit.y, hit.z)
        this.multiplayerBridge?.blockChanged(hit.x, hit.y, hit.z, B.PROXIMITY_SENSOR, state ? { ...state } : undefined)
        sfx.rotate()
        showToast(`Sensor virado para: ${DIR_NAMES[facing]}`)
      }
      return
    }

    if (hit.id === B.SWITCH && (item === null || item === 'switch')) {
      const enabled = this.mech.toggleSwitchAtKey(posKey(hit.x, hit.y, hit.z))
      if (enabled !== null) {
        const state = this.world.getState(hit.x, hit.y, hit.z)
        this.multiplayerBridge?.blockChanged(hit.x, hit.y, hit.z, B.SWITCH, state ? { ...state } : undefined)
        sfx.click()
        showToast('Interruptor ' + (enabled ? 'ligado' : 'desligado'))
      }
      return
    }

    if (item === 'paintbrush') {
      if (!hit || hit.id === B.AIR) return
      const previous = this.world.getState(hit.x, hit.y, hit.z)
      this.world.setBlock(hit.x, hit.y, hit.z, hit.id, { ...(previous ?? {}), color: gameStore.get().brushColor })
      this.world.markBlockDirty(hit.x, hit.y, hit.z)
      sfx.click()
      showToast(`Bloco pintado: ${gameStore.get().brushColor.toUpperCase()}`)
      return
    }

    if (item === 'resin_applicator') {
      const coated = this.mech.applyResinCoating(hit.x, hit.y, hit.z)
      if (this.world.getBlock(hit.x, hit.y, hit.z) === B.AIR) return
      sfx.glue()
      showToast(coated ? 'Resina protetora aplicada' : 'Resina removida')
      return
    }

    if (item === 'glue') {
      const on = this.mech.toggleGlue(hit.x, hit.y, hit.z, hit.face)
      const state = this.world.getState(hit.x, hit.y, hit.z)
      this.multiplayerBridge?.blockChanged(hit.x, hit.y, hit.z, this.world.getBlock(hit.x, hit.y, hit.z), state ? { ...state } : undefined)
      sfx.glue()
      showToast(on ? 'Cola quente aplicada' : 'Cola removida')
      return
    }

    if (hit.id === B.BATTERY_BOX && (item === 'battery' || item === null)) {
      const r = this.mech.changeBatteries(hit.x, hit.y, hit.z, item === 'battery' ? 1 : -1)
      if (r.after !== r.before) {
        const state = this.world.getState(hit.x, hit.y, hit.z)
        this.multiplayerBridge?.blockChanged(hit.x, hit.y, hit.z, this.world.getBlock(hit.x, hit.y, hit.z), state ? { ...state } : undefined)
        sfx.battery(item === 'battery')
        showToast(`Pilhas: ${r.after}/3`)
      } else showToast(item === 'battery' ? 'Compartimento cheio (3/3)' : 'Compartimento vazio (0/3)')
      return
    }

    if (hit.id === B.MOTOR && item === 'wheel') {
      const mounted = this.mech.mountWheel(hit.x, hit.y, hit.z)
      if (mounted) {
        const state = this.world.getState(hit.x, hit.y, hit.z)
        this.multiplayerBridge?.blockChanged(hit.x, hit.y, hit.z, this.world.getBlock(hit.x, hit.y, hit.z), state ? { ...state } : undefined)
      }
      showToast(mounted ? 'Roda encaixada no eixo do motor' : 'Este motor já tem uma roda encaixada')
      return
    }

    if (hit.id === B.MOTOR && (item === null || isMotorItemId(item))) {
      const rolling = this.player.sneaking
      const orientation = this.mech.rotateMotor(hit.x, hit.y, hit.z, rolling)
      const state = this.world.getState(hit.x, hit.y, hit.z)
      this.multiplayerBridge?.blockChanged(hit.x, hit.y, hit.z, this.world.getBlock(hit.x, hit.y, hit.z), state ? { ...state } : undefined)
      sfx.rotate()
      const description = rolling
        ? `Motor girado 90° no eixo X (eixo: ${DIR_NAMES[state?.facing ?? orientation]})`
        : `Motor virado para: ${DIR_NAMES[orientation]}`
      const motorKey = posKey(hit.x, hit.y, hit.z)
      const power = this.mech.motorPowerLevel(motorKey)
      const warning = power <= 0
        ? ' • SEM ENERGIA: ligue +/− da bateria aos terminais A/B'
        : !this.mech.isMotorDriving(motorKey)
          ? ' • SEM CARGA: cole o braço na face do eixo'
          : ''
      showToast(description + warning)
      return
    }

    if (!item) return
    const block = ITEMS[item].block
    if (block === undefined) return
    const n = DIRS[hit.face]
    const px = hit.x + n[0]
    const py = hit.y + n[1]
    const pz = hit.z + n[2]
    if (py < 0 || py >= WORLD_HEIGHT) return
    if (this.world.getBlock(px, py, pz) !== B.AIR) return
    if (this.isMotorFootprintOccupied(px, py, pz)) {
      showToast('Esse espaço já está ocupado pela carcaça de um motor')
      return
    }
    if (this.player.intersectsBlock(px, py, pz, block)) return
    const variant = COLOR_VARIANTS.find((candidate) => item === `colored_block_${candidate.id}`)
    const state: import('./world').BlockState | undefined = variant ? { color: variant.color } : block === B.SERVO ? { facing: hit.face, servoOffAngle: 0, servoOnAngle: 90 } : block === B.MOTOR ? { facing: OPPOSITE[hit.face], motorType: ITEMS[item].motorType ?? 'fa130', motorRoll: 0 } : block === B.WHEEL ? { facing: hit.face } : block === B.BATTERY_BOX ? { batteries: 0 } : block === B.PROXIMITY_SENSOR ? { facing: hit.face, proximityOperator: 'less', proximityDistance: 3, proximityActive: false } : block === B.RESISTOR ? { resistorDigit1: 1, resistorDigit2: 0, resistorMultiplier: 1, resistorTolerance: 5 } : undefined
    if (block === B.MOTOR && this.motorModelOverlapsBlocks(px, py, pz, ITEMS[item].motorType ?? 'fa130', state?.facing ?? 2, state?.motorRoll ?? 0, posKey(hit.x, hit.y, hit.z))) {
      showToast('O motor não cabe nesse espaço: há um bloco na área da carcaça')
      return
    }
    this.world.setBlock(px, py, pz, block, state)
    this.multiplayerBridge?.blockChanged(px, py, pz, block, state)
    sfx.place(METAL.has(block))
    this.lastUseWasPlace = true
  }

  breakBlock() {
    unlockAudio()
    this.swing = 0
    let hit = this.target
    const item = this.selectedItem()
    if (isWireItem(item) && this.wireStart) {
      this.wireStart = null
      showToast('Fio cancelado')
      return
    }
    if (!hit) return
    if (hit.moving && this.multiplayerBridge && !this.multiplayerBridge.isHost) {
      const [x, y, z] = parseKey(hit.moving.key)
      if (!this.multiplayerBridge.canBreakBlock(x, y, z)) {
        showToast('Você só pode quebrar blocos que colocou neste servidor')
        return
      }
      this.multiplayerBridge.movingAction({
        action: 'break', movingKey: hit.moving.key, movingKind: hit.moving.kind,
        face: hit.face, item, sneaking: this.player.sneaking,
      })
      return
    }
    if (isWireItem(item)) {
      const removed = this.mech.removeWiresAt(posKey(hit.x, hit.y, hit.z))
      if (removed) {
        this.multiplayerBridge?.wiresRemovedAt(posKey(hit.x, hit.y, hit.z))
        sfx.click()
        showToast(removed === 1 ? '1 fio removido' : `${removed} fios removidos`)
        return
      }
    }
    if (hit.moving) {
      const cell = this.mech.releaseMovingBlock(hit.moving.key, hit.moving.kind)
      if (!cell) {
        showToast('Não foi possível estabilizar esse conjunto para quebrar')
        return
      }
      hit = { ...hit, ...cell, moving: undefined }
      this.target = hit
    }
    if (hit.y < GROUND_LEVEL) {
      // Keep generated land and the seabed protected, but let builders edit
      // their own blocks after they have sunk below the beach water surface.
      const editableUnderwaterBlock = this.world.type === 'beach' &&
        hit.y >= Math.ceil(this.world.waterBottomY) &&
        this.world.isWaterColumnAt(hit.x + 0.5, hit.z + 0.5) &&
        hit.id !== this.world.terrainBlockAt(hit.x, hit.y, hit.z)
      if (!editableUnderwaterBlock) return
    }
    if (this.multiplayerBridge && !this.multiplayerBridge.canBreakBlock(hit.x, hit.y, hit.z)) {
      showToast('Você só pode quebrar blocos que colocou neste servidor')
      return
    }
    this.world.setBlock(hit.x, hit.y, hit.z, B.AIR)
    this.multiplayerBridge?.blockChanged(hit.x, hit.y, hit.z, B.AIR)
    this.multiplayerBridge?.wiresRemovedAt(posKey(hit.x, hit.y, hit.z))
    this.particles.burst(hit.x, hit.y, hit.z, tileFor(hit.id, false))
    sfx.break(METAL.has(hit.id))
  }

  pickBlock() {
    const hit = this.target
    if (!hit) return
    let item: ItemId | undefined = BLOCK_TO_ITEM[hit.id]
    if (hit.id === B.MOTOR) item = motorItemForVariant(this.world.getState(hit.x, hit.y, hit.z)?.motorType)
    if (hit.id === B.COLOR_BLOCK) {
      const color = this.world.getState(hit.x, hit.y, hit.z)?.color
      const variant = COLOR_VARIANTS.find((candidate) => candidate.color.toLowerCase() === color?.toLowerCase()) ?? COLOR_VARIANTS[0]
      item = `colored_block_${variant.id}`
    }
    if (!item) return
    const s = gameStore.get()
    const existing = s.hotbar.indexOf(item)
    if (existing >= 0) gameStore.set({ selected: existing })
    else {
      const hotbar = [...s.hotbar]
      hotbar[s.selected] = item
      gameStore.set({ hotbar })
    }
  }

  /* ---------------- Raycast ---------------- */

  private motorBoundsForCell(x: number, y: number, z: number) {
    const state = this.world.getState(x, y, z)
    return motorWorldBounds(x, y, z, state?.motorType ?? 'fa130', state?.facing ?? 2, state?.motorRoll ?? 0)
  }

  private boundsOverlapCell(bounds: { min: THREE.Vector3; max: THREE.Vector3 }, x: number, y: number, z: number, margin = 0.08) {
    return Math.min(bounds.max.x, x + 1) - Math.max(bounds.min.x, x) > margin
      && Math.min(bounds.max.y, y + 1) - Math.max(bounds.min.y, y) > margin
      && Math.min(bounds.max.z, z + 1) - Math.max(bounds.min.z, z) > margin
  }

  /** True when an extended motor model physically occupies a cell with no voxel in it. */
  private isMotorFootprintOccupied(x: number, y: number, z: number) {
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
      const mx = x + dx, my = y + dy, mz = z + dz
      if (my < 0 || my >= WORLD_HEIGHT || this.world.getBlock(mx, my, mz) !== B.MOTOR) continue
      if (mx === x && my === y && mz === z) continue
      if (this.boundsOverlapCell(this.motorBoundsForCell(mx, my, mz), x, y, z)) return true
    }
    return false
  }

  /** Check a newly placed motor's extended body against occupied cells. The clicked support block may touch its mount face. */
  private motorModelOverlapsBlocks(
    x: number, y: number, z: number, variant: string, facing: number, roll: number, supportKey?: string,
  ) {
    const bounds = motorWorldBounds(x, y, z, variant, facing, roll)
    const minX = Math.floor(bounds.min.x), maxX = Math.floor(bounds.max.x)
    const minY = Math.floor(bounds.min.y), maxY = Math.floor(bounds.max.y)
    const minZ = Math.floor(bounds.min.z), maxZ = Math.floor(bounds.max.z)
    const anchorKey = posKey(x, y, z)
    for (let bx = minX; bx <= maxX; bx++) for (let by = minY; by <= maxY; by++) for (let bz = minZ; bz <= maxZ; bz++) {
      if (by < 0 || by >= WORLD_HEIGHT) continue
      const cellKey = posKey(bx, by, bz)
      if (cellKey === anchorKey || cellKey === supportKey || this.world.getBlock(bx, by, bz) === B.AIR) continue
      if (this.boundsOverlapCell(bounds, bx, by, bz, 0.08)) return true
    }
    return false
  }

  /* ---------------- Raycast ---------------- */

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): Hit | null {
    // Moving bodies and extended model bounds compete by distance with the
    // voxel DDA. This lets the second half of a long TT/N20 be targeted even
    // though its anchor voxel occupies only one grid cell.
    const moving = this.mech.raycastMoving(origin, dir, maxDist)
    const limit = moving ? moving.dist : maxDist
    let ix = Math.floor(origin.x)
    let iy = Math.floor(origin.y)
    let iz = Math.floor(origin.z)
    const sx = Math.sign(dir.x)
    const sy = Math.sign(dir.y)
    const sz = Math.sign(dir.z)
    const tdx = sx !== 0 ? Math.abs(1 / dir.x) : Number.POSITIVE_INFINITY
    const tdy = sy !== 0 ? Math.abs(1 / dir.y) : Number.POSITIVE_INFINITY
    const tdz = sz !== 0 ? Math.abs(1 / dir.z) : Number.POSITIVE_INFINITY
    let tmx = sx > 0 ? (ix + 1 - origin.x) * tdx : sx < 0 ? (origin.x - ix) * tdx : Number.POSITIVE_INFINITY
    let tmy = sy > 0 ? (iy + 1 - origin.y) * tdy : sy < 0 ? (origin.y - iy) * tdy : Number.POSITIVE_INFINITY
    let tmz = sz > 0 ? (iz + 1 - origin.z) * tdz : sz < 0 ? (origin.z - iz) * tdz : Number.POSITIVE_INFINITY
    let t = 0
    const nearestExtendedMotor: { value: Hit | null } = { value: null }
    const checkedMotors = new Set<string>()
    const inspectNearbyMotorBounds = (cx: number, cy: number, cz: number) => {
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
        const mx = cx + dx, my = cy + dy, mz = cz + dz
        if (my < 0 || my >= WORLD_HEIGHT || this.world.getBlock(mx, my, mz) !== B.MOTOR) continue
        const key = posKey(mx, my, mz)
        if (checkedMotors.has(key)) continue
        checkedMotors.add(key)
        const bounds = this.motorBoundsForCell(mx, my, mz)
        const hit = this.rayAabb(origin, dir, bounds.min, bounds.max, mx, my, mz, B.MOTOR, limit)
        if (hit && (!moving || hit.dist <= moving.dist) && (!nearestExtendedMotor.value || hit.dist < nearestExtendedMotor.value.dist)) {
          nearestExtendedMotor.value = hit
        }
      }
    }

    for (let i = 0; i < 64 && t <= limit; i++) {
      const nextBoundary = Math.min(tmx, tmy, tmz)
      if (iy >= 0 && iy < WORLD_HEIGHT) {
        inspectNearbyMotorBounds(ix, iy, iz)
        const id = this.world.getBlock(ix, iy, iz)
        if (id !== B.AIR) {
          const hit = id === B.MOTOR
            ? this.rayMotorBox(origin, dir, ix, iy, iz, limit)
            : this.rayBox(origin, dir, ix, iy, iz, id, limit)
          if (hit && (!moving || hit.dist <= moving.dist)) {
            if (nearestExtendedMotor.value && nearestExtendedMotor.value.dist < hit.dist - 1e-5) return nearestExtendedMotor.value
            return hit
          }
        }

        // The Arduino model is wider than its anchor voxel. Check nearby
        // anchor cells while traversing the ray so the exposed pins remain targetable.
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue
            const bx = ix + dx
            const bz = iz + dz
            if (this.world.getBlock(bx, iy, bz) !== B.ARDUINO_UNO) continue
            const boardHit = this.rayBox(origin, dir, bx, iy, bz, B.ARDUINO_UNO, limit)
            if (boardHit && boardHit.dist >= t - 1e-6 && boardHit.dist <= nextBoundary + 1e-6 && (!moving || boardHit.dist <= moving.dist)) {
              if (nearestExtendedMotor.value && nearestExtendedMotor.value.dist < boardHit.dist - 1e-5) return nearestExtendedMotor.value
              return boardHit
            }
          }
        }
      }
      // If the ray has reached the closest extended motor before entering the
      // next voxel, it is the first visible object at this distance.
      if (nearestExtendedMotor.value && nearestExtendedMotor.value.dist < nextBoundary - 1e-5) return nearestExtendedMotor.value
      if (tmx < tmy && tmx < tmz) {
        ix += sx
        t = tmx
        tmx += tdx
      } else if (tmy < tmz) {
        iy += sy
        t = tmy
        tmy += tdy
      } else {
        iz += sz
        t = tmz
        tmz += tdz
      }
    }
    return (nearestExtendedMotor.value ?? moving) as Hit | null
  }

  private rayMotorBox(o: THREE.Vector3, d: THREE.Vector3, x: number, y: number, z: number, maxDist: number): Hit | null {
    const bounds = this.motorBoundsForCell(x, y, z)
    return this.rayAabb(o, d, bounds.min, bounds.max, x, y, z, B.MOTOR, maxDist)
  }

  private rayBox(o: THREE.Vector3, d: THREE.Vector3, x: number, y: number, z: number, id: number, maxDist: number): Hit | null {
    const b = blockBounds(id)
    const mins = new THREE.Vector3(x + b[0], y + b[1], z + b[2])
    const maxs = new THREE.Vector3(x + b[3], y + b[4], z + b[5])
    return this.rayAabb(o, d, mins, maxs, x, y, z, id, maxDist)
  }

  private rayAabb(
    o: THREE.Vector3, d: THREE.Vector3,
    mins: THREE.Vector3, maxs: THREE.Vector3,
    x: number, y: number, z: number, id: number, maxDist: number,
  ): Hit | null {
    const oa = [o.x, o.y, o.z]
    const da = [d.x, d.y, d.z]
    const min = [mins.x, mins.y, mins.z]
    const max = [maxs.x, maxs.y, maxs.z]
    let tmin = Number.NEGATIVE_INFINITY
    let tmax = Number.POSITIVE_INFINITY
    let axis = 0
    for (let a = 0; a < 3; a++) {
      if (Math.abs(da[a]) < 1e-9) {
        if (oa[a] < min[a] || oa[a] > max[a]) return null
        continue
      }
      let t1 = (min[a] - oa[a]) / da[a]
      let t2 = (max[a] - oa[a]) / da[a]
      if (t1 > t2) [t1, t2] = [t2, t1]
      if (t1 > tmin) {
        tmin = t1
        axis = a
      }
      tmax = Math.min(tmax, t2)
    }
    if (tmin > tmax || tmin < 0 || tmin > maxDist) return null
    const face = axis * 2 + (da[axis] > 0 ? 1 : 0)
    return { x, y, z, face, id, dist: tmin, point: o.clone().addScaledVector(d, tmin) }
  }

  private updateTarget() {
    const dir = new THREE.Vector3()
    this.camera.getWorldDirection(dir)
    const origin = new THREE.Vector3(this.player.pos.x, this.player.pos.y + this.player.eye, this.player.pos.z)
    this.targetRayOrigin.copy(origin)
    this.targetRayDirection.copy(dir).normalize()
    const hit = this.raycast(origin, dir, REACH)
    this.target = hit
    if (hit) {
      this.outline.visible = true
      if (hit.id === B.MOTOR) {
        const bounds = this.motorBoundsForCell(hit.x, hit.y, hit.z)
        this.outline.position.copy(bounds.min.clone().add(bounds.max).multiplyScalar(0.5))
        this.outline.scale.copy(bounds.max.clone().sub(bounds.min).addScalar(0.004))
      } else {
        const b = blockBounds(hit.id)
        this.outline.position.set(hit.x + (b[0] + b[3]) / 2, hit.y + (b[1] + b[4]) / 2, hit.z + (b[2] + b[5]) / 2)
        this.outline.scale.set(b[3] - b[0] + 0.004, b[4] - b[1] + 0.004, b[5] - b[2] + 0.004)
      }
    } else this.outline.visible = false

    if (this.wireStart) {
      this.wireMarker.visible = true
      this.wireMarker.position.copy(this.wireStart.point)
      const end = hit ? hit.point : origin.clone().addScaledVector(dir, 3)
      const pts = wireCurve(this.wireStart.point, end).getPoints(15)
      ;(this.wirePreview.geometry as THREE.BufferGeometry).setFromPoints(pts)
      this.wirePreview.visible = true
    } else {
      this.wireMarker.visible = false
      this.wirePreview.visible = false
    }
  }

  private updateHolds(dt: number) {
    if (this.breakHeld) {
      this.breakTimer -= dt
      if (this.breakTimer <= 0) {
        this.breakTimer = 0.3
        this.breakBlock()
      }
    }
    if (this.useHeld && this.lastUseWasPlace) {
      this.useTimer -= dt
      if (this.useTimer <= 0) {
        this.useTimer = 0.2
        this.use()
      }
    }
    if (this.touchHolding && !this.touchMovedFar) {
      this.touchHoldTime += dt
      const threshold = 0.35
      if (!this.touchBroke) {
        gameStore.set({ breakProgress: Math.min(1, this.touchHoldTime / threshold) })
        if (this.touchHoldTime >= threshold) {
          this.touchBroke = true
          this.breakTimer = 0.3
          this.breakBlock()
          gameStore.set({ breakProgress: 0 })
        }
      } else {
        this.breakTimer -= dt
        if (this.breakTimer <= 0) {
          this.breakTimer = 0.3
          this.breakBlock()
        }
      }
    } else if (this.touchHolding && this.touchBroke) {
      this.breakTimer -= dt
      if (this.breakTimer <= 0) {
        this.breakTimer = 0.3
        this.breakBlock()
      }
    }
  }

  private updateHint() {
    const s = gameStore.get()
    const item = s.hotbar[s.selected]
    const hit = this.target
    const use = s.isTouch ? 'Toque' : 'Botão direito'
    let hint: string | null = null
    if (isWireItem(item)) {
      hint = this.wireStart
        ? `${use} em um terminal para terminar o fio  •  ${s.isTouch ? 'Segure' : 'Botão esquerdo'} para cancelar`
        : `${use} em um terminal para começar o fio`
    } else if (item === 'glue') {
      hint = `${use} numa face para aplicar ou remover cola quente`
    } else if (item === 'resin_applicator') {
      hint = `${use} em um bloco para aplicar ou remover a resina protetora`
    } else if (hit?.id === B.BATTERY_BOX && item === 'battery') {
      hint = `${use} para inserir pilha (${this.world.getState(hit.x, hit.y, hit.z)?.batteries ?? 0}/3)`
    } else if (hit?.id === B.BATTERY_BOX && item === null) {
      hint = `${use} para retirar pilha (${this.world.getState(hit.x, hit.y, hit.z)?.batteries ?? 0}/3)`
    } else if (hit?.id === B.ARDUINO_UNO && item === 'programming_tablet') {
      hint = `${use} para abrir a programação do Arduino UNO`
    } else if (hit?.id === B.RESISTOR && (item === null || item === 'resistor')) {
      hint = `${use} para configurar a resistência e as faixas de cores`
    } else if (hit?.id === B.MOTOR && (item === null || isMotorItemId(item))) {
      const state = this.world.getState(hit.x, hit.y, hit.z)
      const key = posKey(hit.x, hit.y, hit.z)
      const status = this.mech.motorStatus(key)
      const power = this.mech.motorPowerLevel(key)
      const extra = status === 'stalled'
        ? '  •  MONTAGEM TRAVADA'
        : power <= 0
          ? '  •  SEM ENERGIA: conecte bateria +/− aos terminais A/B'
          : !this.mech.isMotorDriving(key)
            ? '  •  SEM CARGA: cole a montagem na face do eixo'
            : ''
      hint = this.player.sneaking ? `${use} para girar o motor 90° ao redor do eixo X${extra}` : `${use} para mudar a direção do eixo do motor (${DIR_NAMES[state?.facing ?? 2]})${extra}`
    } else if (item === 'battery') {
      hint = 'Mire num compartimento de pilha AAA'
    }
    if (hint !== s.hint) gameStore.set({ hint })
  }

  private buildHandObject(item: ItemId | null): THREE.Object3D {
    if (item === null) {
      const tex = makePixelTexture(armCanvas())
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.75), new THREE.MeshLambertMaterial({ map: tex }))
      arm.position.set(0.42, -0.42, -0.5)
      arm.rotation.set(0.35, 0.25, 0.15)
      return arm
    }
    const def = ITEMS[item]
    if (def.block !== undefined && !isModelBlock(def.block)) {
      const out = newBuffers()
      emitCube(out, -0.5, -0.5, -0.5, def.block, false, () => false)
      const mesh = new THREE.Mesh(buffersToGeometry(out), this.blockMaterial)
      mesh.scale.setScalar(0.38)
      mesh.position.set(0.5, -0.45, -0.8)
      mesh.rotation.set(0, Math.PI / 4, 0)
      return mesh
    }
    if (item === 'scanner_dws') {
      const g = new THREE.Group()
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.72, 0.045), new THREE.MeshStandardMaterial({ color: 0x182b3d, metalness: 0.65, roughness: 0.32 }))
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.43, 0.58), new THREE.MeshBasicMaterial({ color: 0x073d59 }))
      screen.position.z = 0.026
      const sweep = new THREE.Mesh(new THREE.PlaneGeometry(0.39, 0.025), new THREE.MeshBasicMaterial({ color: 0x59edff }))
      sweep.position.set(0, 0.1, 0.03)
      const target = new THREE.Mesh(new THREE.RingGeometry(0.055, 0.075, 20), new THREE.MeshBasicMaterial({ color: 0xb7fbff, side: THREE.DoubleSide }))
      target.position.set(0.08, -0.06, 0.031)
      g.add(body, screen, sweep, target)
      g.scale.setScalar(0.72)
      g.position.set(0.48, -0.43, -0.78)
      g.rotation.set(0.12, 0.48, 0.06)
      return g
    }
    if (isMotorItemId(item)) {
      const m = createMotorModel(0, ITEMS[item].motorType ?? 'fa130').group
      const g = new THREE.Group()
      g.add(m)
      g.scale.setScalar(0.5)
      g.position.set(0.48, -0.42, -0.75)
      g.rotation.set(0.1, 0.5, 0)
      return g
    }
    if (item === 'arduino_uno') {
      const m = createArduinoUnoModel().group
      const g = new THREE.Group()
      g.add(m)
      g.scale.setScalar(0.48)
      g.position.set(0.48, -0.46, -0.78)
      g.rotation.set(0.16, 0.52, 0.12)
      return g
    }
    if (item === 'proximity_sensor') {
      const m = createProximitySensorModel(4, false).group
      const g = new THREE.Group()
      g.add(m)
      g.scale.setScalar(0.62)
      g.position.set(0.48, -0.45, -0.78)
      g.rotation.set(0.2, 0.5, 0)
      return g
    }
    if (item === 'wheel') {
      const m = createArduinoWheelModel(0).group
      const g = new THREE.Group()
      g.add(m)
      g.scale.setScalar(0.7)
      g.position.set(0.48, -0.45, -0.78)
      g.rotation.set(0.2, 0.5, 0)
      return g
    }
    if (item === 'battery_box') {
      const m = createBatteryBoxModel(3).group
      const g = new THREE.Group()
      g.add(m)
      g.scale.setScalar(0.5)
      g.position.set(0.48, -0.48, -0.75)
      g.rotation.set(0.35, 0.6, 0)
      return g
    }
    const mesh = new THREE.Mesh(this.extrudeSprite(item), new THREE.MeshBasicMaterial({ vertexColors: true }))
    mesh.scale.setScalar(0.55)
    mesh.position.set(0.5, -0.36, -0.7)
    mesh.rotation.set(0, -Math.PI / 2 + 0.25, 0.3)
    return mesh
  }

  private extrudeSprite(item: ItemId) {
    const c = getItemSpriteCanvas(item)
    const data = c.getContext('2d')!.getImageData(0, 0, 16, 16).data
    const op = (x: number, y: number) => x >= 0 && y >= 0 && x < 16 && y < 16 && data[(y * 16 + x) * 4 + 3] > 20
    const positions: number[] = []
    const colors: number[] = []
    const indices: number[] = []
    const s = 1 / 16
    const t = 1 / 16
    const col = new THREE.Color()
    const quad = (v: number[][], shade: number) => {
      const base = positions.length / 3
      for (const p of v) {
        positions.push(p[0], p[1], p[2])
        colors.push(col.r * shade, col.g * shade, col.b * shade)
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        if (!op(x, y)) continue
        const i = (y * 16 + x) * 4
        col.setRGB(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, THREE.SRGBColorSpace)
        const x0 = x * s - 0.5
        const x1 = x0 + s
        const y1 = 0.5 - y * s
        const y0 = y1 - s
        const z0 = -t / 2
        const z1 = t / 2
        quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], 1)
        quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], 0.7)
        if (!op(x, y - 1)) quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], 0.9)
        if (!op(x, y + 1)) quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], 0.5)
        if (!op(x - 1, y)) quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], 0.6)
        if (!op(x + 1, y)) quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], 0.6)
      }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    g.setIndex(indices)
    return g
  }

  private updateHand(dt: number) {
    const item = this.selectedItem()
    if (item !== this.heldItem) {
      const first = this.heldItem === undefined
      this.heldItem = item
      if (this.handObj) {
        this.handRoot.remove(this.handObj)
        this.handObj.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
      }
      const nextHandObject = this.buildHandObject(item)
      this.handObj = nextHandObject
      this.handRoot.add(nextHandObject)
      if (!first) {
        this.equip = 0
        showItemLabel(item ? ITEMS[item].name : 'Mão vazia')
      }
      if (item !== 'wire') this.wireStart = null
    }
    this.swing = Math.min(1, this.swing + dt / 0.25)
    this.equip = Math.min(1, this.equip + dt / 0.18)
    const sw = this.swing < 1 ? Math.sin(Math.sqrt(this.swing) * Math.PI) : 0
    const sw2 = this.swing < 1 ? Math.sin(this.swing * Math.PI) : 0
    const bob = this.player.bob
    const w = this.player.walkDist * Math.PI
    this.handRoot.position.set(
      -sw * 0.18 + Math.sin(w) * 0.025 * bob,
      sw * 0.06 - Math.abs(Math.cos(w)) * 0.03 * bob - (1 - this.equip) * 0.5,
      -sw2 * 0.12,
    )
    this.handRoot.rotation.set(-sw2 * 0.6, sw2 * 0.25, 0)
  }

  private processShortCircuitEvents() {
    for (const key of this.mech.drainShortCircuitEvents()) {
      const [x, y, z] = parseKey(key)
      // Use the existing particle system for a visible burst and the zap sound
      // for the electrical arc; one event is emitted per short-circuit episode.
      this.particles.burst(x, y, z, tileFor(B.BATTERY_BOX, false), 10)
      sfx.zap()
      showToast('CURTO-CIRCUITO: corrente excessiva na fonte. Desconecte o circuito.')
    }
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame)
    const dt = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    this.elapsed += dt
    this.frames++
    const s = gameStore.get()
    const frozen = s.screen === 'paused' || ((s.screen === 'options' || s.screen === 'controls') && s.returnScreen === 'paused')

    let centerX: number
    let centerZ: number
    if (s.screen === 'title' || ((s.screen === 'options' || s.screen === 'controls') && s.returnScreen === 'title')) {
      const a = this.elapsed * 0.08
      const cx = 4.5
      const cz = -3.5
      this.camera.position.set(cx + Math.sin(a) * 10, GROUND_LEVEL + 5, cz + Math.cos(a) * 10)
      this.camera.lookAt(cx, GROUND_LEVEL + 1, cz)
      centerX = this.camera.position.x
      centerZ = this.camera.position.z
      this.outline.visible = false
      this.handRoot.visible = false
      this.mech.update(dt)
      this.processShortCircuitEvents()
    } else {
      this.handRoot.visible = true
      if (!frozen) {
        const playing = s.screen === 'playing'
        const k = this.keys
        const t = this.touch
        const forward = playing ? (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) + t.moveY : 0
        const strafe = playing ? (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) + t.moveX : 0
        if (forward <= 0) this.sprintLatch = false
        const shift = playing && (k.has('ShiftLeft') || k.has('ShiftRight'))
        const space = playing && k.has('Space')
        this.player.update(dt, {
          forward,
          strafe,
          jump: space || (playing && t.jump),
          sneak: shift || (playing && t.sneak),
          sprint: playing && (k.has('ControlLeft') || k.has('ControlRight') || this.sprintLatch || t.sprint),
          flyUp: space || (playing && t.flyUp),
          flyDown: shift || (playing && t.flyDown),
        })
        if (s.flying !== this.player.flying || s.sneaking !== this.player.sneaking)
          gameStore.set({ flying: this.player.flying, sneaking: this.player.sneaking })
        this.mech.update(dt)
        this.processShortCircuitEvents()
        // Player-vs-machine contacts use the latest host snapshot on every client.
        // The client moves only its local player; it never advances the shared machine physics.
        if (playing) this.mech.resolvePlayerCollision(this.player, dt)
      }
      this.updateCamera(dt)
      centerX = this.player.pos.x
      centerZ = this.player.pos.z
      this.updateTarget()
      if (s.screen === 'playing') this.updateHolds(dt)
      this.updateHand(frozen ? 0 : dt)
      this.updateHint()
    }

    this.updateRemoteAvatars(frozen ? 0 : dt)
    if (!frozen) this.updateAssistantRobots(dt)
    this.sky.mesh.position.copy(this.camera.position)
    this.sky.material.uniforms.uTime.value = this.elapsed
    this.updateChunks(centerX, centerZ)
    this.particles.update(frozen ? 0 : dt, this.camera)
    if (this.physicsDebugLabel) {
      const hit = this.target
      const target = hit
        ? `\nray target: id=${hit.id} cell=(${hit.x},${hit.y},${hit.z}) dist=${hit.dist.toFixed(2)} moving=${hit.moving?.kind ?? 'static'} source=${hit.moving?.key ?? '-'}`
        : '\nray target: none'
      const diagnostic = new URLSearchParams(window.location.search).get('electricalDebug') === '1'
        ? this.mech.electricalDebugText()
        : this.mech.physicsDebugText()
      this.physicsDebugLabel.textContent = diagnostic + target
    }

    this.renderer.clear()
    this.renderer.render(this.scene, this.camera)
    if (this.handRoot.visible) {
      this.renderer.clearDepth()
      this.renderer.render(this.handScene, this.handCamera)
    }

    this.debugTimer += dt
    if (this.debugTimer > 0.5) {
      this.fps = Math.round(this.frames / this.debugTimer)
      this.frames = 0
      this.debugTimer = 0
      if (s.debug) {
        const p = this.player.pos
        const yawDeg = ((((-this.player.yaw * 180) / Math.PI) % 360) + 360) % 360
        const facing = ['Norte (-Z)', 'Leste (+X)', 'Sul (+Z)', 'Oeste (-X)'][Math.round(yawDeg / 90) % 4]
        gameStore.set({
          debugInfo: [
            `CraftEduc Robótica (${this.fps} fps)`,
            `XYZ: ${p.x.toFixed(2)} / ${p.y.toFixed(2)} / ${p.z.toFixed(2)}`,
            `Chunk: ${Math.floor(p.x / CHUNK_SIZE)}, ${Math.floor(p.z / CHUNK_SIZE)}  (${this.world.chunks.size} carregados)`,
            `Olhando para: ${facing}`,
            `Fios: ${this.mech.wires.length}  Mecanismos: ${this.mech.contraptions.size}`,
          ].join('\n'),
        })
      }
    }
  }

  private updateCamera(dt: number) {
    const p = this.player
    const s = gameStore.get()
    const cam = this.camera
    const w = p.walkDist * Math.PI
    const bob = p.bob
    cam.position.set(p.pos.x, p.pos.y + p.eye, p.pos.z)
    const right = new THREE.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw))
    cam.position.addScaledVector(right, Math.sin(w) * 0.045 * bob)
    cam.position.y -= Math.abs(Math.cos(w)) * 0.06 * bob
    cam.rotation.set(p.pitch, p.yaw, Math.sin(w) * 0.008 * bob)
    const targetFov = s.settings.fov * (p.sprinting ? (p.flying ? 1.2 : 1.12) : 1)
    cam.fov += (targetFov - cam.fov) * (1 - Math.exp(-10 * dt))
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
  }

  private updateChunks(px: number, pz: number) {
    const R = gameStore.get().settings.renderDistance
    const pcx = Math.floor(px / CHUNK_SIZE)
    const pcz = Math.floor(pz / CHUNK_SIZE)
    const far = R * CHUNK_SIZE
    const fog = this.scene.fog as THREE.Fog
    fog.near = far * 0.5
    fog.far = far * 0.95

    const pending: { cx: number; cz: number; d: number }[] = []
    for (let dx = -R; dx <= R; dx++)
      for (let dz = -R; dz <= R; dz++) {
        const d = dx * dx + dz * dz
        if (d > R * R) continue
        const c = this.world.getChunk(pcx + dx, pcz + dz)
        if (!c || c.dirty) pending.push({ cx: pcx + dx, cz: pcz + dz, d: c?.mesh ? -1 : d })
      }
    pending.sort((a, b) => a.d - b.d)
    let budget = 1
    for (const p of pending) {
      const c = this.world.ensureChunk(p.cx, p.cz)
      if (budget-- <= 0) break
      this.world.buildChunkMesh(c)
    }

    const limit = (R + 2) * (R + 2)
    for (const c of [...this.world.chunks.values()]) {
      const dx = c.cx - pcx
      const dz = c.cz - pcz
      if (dx * dx + dz * dz > limit) this.world.unloadChunk(c)
    }
  }
}
