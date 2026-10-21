import * as THREE from 'three'
import { B, type ItemId } from './constants'

export const TILE = 16

export const T = {
  ROBOTICS: 0,
  IRON: 1,
  WOOD: 2,
  COMPONENT: 3,
  LED_OFF: 4,
  LED_ON: 5,
  ALUMINUM: 6,
  GEAR: 7,
  COUNT: 8,
} as const

export function tileFor(id: number, powered: boolean): number {
  switch (id) {
    case B.ROBOTICS:
      return T.ROBOTICS
    case B.IRON:
      return T.IRON
    case B.WOOD:
      return T.WOOD
    case B.COMPONENT:
      return T.COMPONENT
    case B.LED:
      return powered ? T.LED_ON : T.LED_OFF
    case B.ALUMINUM:
      return T.ALUMINUM
    case B.GEAR:
      return T.GEAR
    default:
      return T.IRON
  }
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type RGBA = [number, number, number, number?]
type Px = (x: number, y: number, c: RGBA) => void

function clamp255(v: number) {
  return Math.max(0, Math.min(255, Math.round(v)))
}

function pixelCanvas(size: number, draw: (px: Px, rnd: () => number) => void, seed = 1) {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(size, size)
  const px: Px = (x, y, col) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    img.data[i] = clamp255(col[0])
    img.data[i + 1] = clamp255(col[1])
    img.data[i + 2] = clamp255(col[2])
    img.data[i + 3] = col[3] ?? 255
  }
  draw(px, mulberry32(seed))
  ctx.putImageData(img, 0, 0)
  return c
}

const shade = (c: RGBA, f: number): RGBA => [c[0] * f, c[1] * f, c[2] * f, c[3]]
const jitter = (c: RGBA, r: () => number, amt: number): RGBA => {
  const j = (r() - 0.5) * amt
  return [c[0] + j, c[1] + j, c[2] + j, c[3]]
}

const tileDrawers: Record<number, (px: Px, r: () => number) => void> = {
  [T.ROBOTICS]: (px, r) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        let c: RGBA = jitter([132, 137, 146], r, 14)
        const inner = x >= 5 && x <= 10 && y >= 5 && y <= 10
        if (inner) c = shade(c, 0.93)
        if (x === 1 || y === 1) c = shade(c, 1.12)
        if (x === 14 || y === 14) c = shade(c, 0.78)
        if (x === 0 || y === 0 || x === 15 || y === 15) c = jitter([47, 125, 255], r, 18)
        px(x, y, c)
      }
    for (const [bx, by] of [
      [3, 3],
      [12, 3],
      [3, 12],
      [12, 12],
    ]) {
      px(bx, by, [196, 200, 208])
      px(bx - 1, by, [170, 175, 182])
      px(bx, by - 1, [170, 175, 182])
      px(bx + 1, by + 1, [80, 84, 92])
    }
    px(7, 7, [80, 150, 255])
    px(8, 8, [80, 150, 255])
    px(7, 8, [60, 110, 210])
    px(8, 7, [60, 110, 210])
  },
  [T.IRON]: (px, r) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        let c: RGBA = jitter([214, 214, 214], r, 10)
        if (y === 5 || y === 10) c = [178, 178, 178]
        if (y === 6 || y === 11) c = [232, 232, 232]
        if (x === 1 || y === 1) c = [238, 238, 238]
        if (x === 14 || y === 14) c = [160, 160, 160]
        if (x === 0 || y === 0 || x === 15 || y === 15) c = [124, 124, 124]
        px(x, y, c)
      }
    for (const [bx, by] of [
      [3, 3],
      [12, 3],
      [3, 12],
      [12, 12],
    ])
      px(bx, by, [150, 150, 150])
  },
  [T.WOOD]: (px, r) => {
    const joints = [4, 11, 7, 2]
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const row = Math.floor(y / 4)
        let c: RGBA = jitter([168, 132, 80], r, 16)
        if (r() < 0.12) c = shade(c, 0.88)
        if (y % 4 === 3) c = [104, 78, 44]
        if (x === joints[row] && y % 4 !== 3) c = [118, 88, 50]
        if (y % 4 === 0) c = shade(c, 1.06)
        px(x, y, c)
      }
  },
  [T.COMPONENT]: (px, r) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        let c: RGBA = jitter([34, 120, 62], r, 12)
        if (x === 0 || y === 0 || x === 15 || y === 15) c = [18, 76, 38]
        px(x, y, c)
      }
    const trace: RGBA = [214, 176, 58]
    for (let x = 1; x < 15; x++) px(x, 3, trace)
    for (let y = 3; y < 13; y++) px(2, y, trace)
    for (let x = 2; x < 6; x++) px(x, 12, trace)
    for (let y = 8; y < 15; y++) px(13, y, trace)
    for (let x = 10; x < 14; x++) px(x, 13, trace)
    for (let y = 5; y < 11; y++)
      for (let x = 5; x < 11; x++) px(x, y, x === 5 || y === 5 ? [58, 58, 64] : [28, 28, 32])
    for (let i = 5; i < 11; i += 2) {
      px(i, 4, [200, 200, 205])
      px(i, 11, [200, 200, 205])
      px(4, i, [200, 200, 205])
      px(11, i, [200, 200, 205])
    }
    px(6, 6, [90, 90, 98])
    px(12, 5, [200, 60, 50])
    px(12, 6, [230, 210, 160])
    px(3, 9, [80, 140, 255])
  },
  [T.LED_OFF]: (px, r) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const frame = x === 0 || y === 0 || x === 15 || y === 15 || x === 7 || x === 8 || y === 7 || y === 8
        let c: RGBA = frame ? jitter([62, 44, 34], r, 12) : jitter([96, 34, 28], r, 18)
        if (!frame && r() < 0.15) c = [70, 26, 22]
        px(x, y, c)
      }
  },
  [T.LED_ON]: (px, r) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const frame = x === 0 || y === 0 || x === 15 || y === 15 || x === 7 || x === 8 || y === 7 || y === 8
        let c: RGBA
        if (frame) c = jitter([150, 96, 52], r, 14)
        else {
          const cx = x < 8 ? 3.5 : 11.5
          const cy = y < 8 ? 3.5 : 11.5
          const d = Math.hypot(x - cx, y - cy)
          c = d < 1.6 ? [255, 236, 190] : d < 2.8 ? [255, 160, 90] : jitter([238, 86, 52], r, 18)
        }
        px(x, y, c)
      }
  },
  [T.ALUMINUM]: (px, r) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        let c: RGBA = jitter([198, 203, 210], r, 8)
        if (x === 0 || y === 0 || x === 15 || y === 15) c = [140, 146, 154]
        else if (x === 1 || y === 1) c = [226, 230, 235]
        const inSlotX = x >= 6 && x <= 9 && (y <= 3 || y >= 12)
        const inSlotY = y >= 6 && y <= 9 && (x <= 3 || x >= 12)
        if (inSlotX || inSlotY) c = [72, 76, 84]
        const d = Math.hypot(x - 7.5, y - 7.5)
        if (d < 2.2) c = [60, 64, 70]
        else if (d < 3.2) c = [168, 174, 182]
        px(x, y, c)
      }
  },
  [T.GEAR]: (px, r) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        let c: RGBA = jitter([66, 72, 82], r, 10)
        if (x === 0 || y === 0 || x === 15 || y === 15) c = [44, 48, 56]
        const dx = x - 7.5
        const dy = y - 7.5
        const d = Math.hypot(dx, dy)
        const a = Math.atan2(dy, dx)
        const tooth = Math.cos(a * 8) > 0.2
        if (d < 4.6 || (d < 6.6 && tooth)) {
          c = jitter([214, 170, 64], r, 16)
          if (dx + dy < -2) c = shade(c, 1.12)
          if (dx + dy > 3) c = shade(c, 0.82)
        }
        if (d < 1.6) c = [40, 40, 44]
        px(x, y, c)
      }
  },
}

let atlasCanvas: HTMLCanvasElement | null = null
const tileCanvases: HTMLCanvasElement[] = []

function getTileCanvas(i: number) {
  if (!tileCanvases[i]) tileCanvases[i] = pixelCanvas(TILE, tileDrawers[i], 1000 + i * 7)
  return tileCanvases[i]
}

export function getAtlasCanvas() {
  if (atlasCanvas) return atlasCanvas
  const c = document.createElement('canvas')
  c.width = TILE * T.COUNT
  c.height = TILE
  const ctx = c.getContext('2d')!
  for (let i = 0; i < T.COUNT; i++) ctx.drawImage(getTileCanvas(i), i * TILE, 0)
  atlasCanvas = c
  return c
}

export function makePixelTexture(canvas: HTMLCanvasElement) {
  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function tileUV(tile: number): [number, number, number, number] {
  const eps = 0.001
  const w = 1 / T.COUNT
  return [tile * w + eps, 0 + eps, (tile + 1) * w - eps, 1 - eps]
}

export function glueCanvas() {
  return pixelCanvas(
    16,
    (px, r) => {
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          const d = Math.hypot(x - 7.5, y - 7) + (r() - 0.5) * 1.2
          const drip = (x === 5 || x === 10) && y > 8 && y < 13 + (x === 5 ? 2 : 0)
          if (d < 4.4 || drip) {
            const hi = x < 7 && y < 6
            px(x, y, hi ? [255, 255, 255, 235] : [226, 234, 242, 200])
          }
        }
    },
    77,
  )
}

export function metalCanvas(base: RGBA, seed: number) {
  return pixelCanvas(
    16,
    (px, r) => {
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          let c = jitter(base, r, 14)
          if (y === 0 || y === 15) c = shade(c, 0.8)
          px(x, y, c)
        }
    },
    seed,
  )
}

export function armCanvas() {
  return pixelCanvas(
    16,
    (px, r) => {
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          let c: RGBA = jitter([150, 156, 166], r, 14)
          if (x >= 6 && x <= 9) c = jitter([47, 125, 255], r, 20)
          if (y % 5 === 0) c = shade(c, 0.75)
          px(x, y, c)
        }
    },
    55,
  )
}

/* ---------------- Item icons ---------------- */

function drawItemPixels(item: ItemId, px: Px) {
  const rect = (x: number, y: number, w: number, h: number, c: RGBA) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(x + i, y + j, c)
  }
  switch (item) {
    case 'motor': {
      rect(2, 4, 9, 8, [185, 190, 196])
      rect(3, 3, 7, 1, [150, 155, 162])
      rect(3, 12, 7, 1, [90, 95, 102])
      rect(2, 4, 9, 1, [225, 228, 232])
      rect(2, 5, 9, 1, [210, 214, 218])
      rect(2, 9, 9, 1, [150, 155, 162])
      rect(2, 10, 9, 2, [118, 123, 130])
      rect(0, 5, 2, 6, [44, 44, 48])
      px(1, 4, [200, 122, 58])
      px(0, 4, [200, 122, 58])
      px(1, 11, [200, 122, 58])
      px(0, 11, [200, 122, 58])
      rect(11, 6, 1, 4, [130, 135, 142])
      rect(12, 7, 4, 2, [214, 178, 74])
      rect(12, 7, 4, 1, [240, 214, 138])
      px(5, 7, [210, 60, 50])
      break
    }
    case 'wire': {
      rect(2, 2, 2, 12, [74, 74, 80])
      rect(12, 2, 2, 12, [74, 74, 80])
      for (let y = 4; y < 12; y++) rect(4, y, 8, 1, y % 2 ? [242, 194, 48] : [201, 154, 26])
      px(12, 1, [242, 194, 48])
      px(13, 0, [242, 194, 48])
      px(14, 0, [242, 194, 48])
      px(15, 0, [217, 138, 74])
      px(11, 2, [242, 194, 48])
      px(11, 3, [242, 194, 48])
      break
    }
    case 'glue': {
      rect(0, 5, 3, 2, [232, 238, 245])
      rect(0, 6, 3, 1, [200, 210, 220])
      rect(3, 4, 10, 4, [59, 125, 221])
      rect(3, 4, 10, 1, [106, 166, 255])
      rect(3, 7, 10, 1, [42, 91, 176])
      rect(13, 5, 2, 2, [201, 165, 74])
      px(15, 6, [232, 211, 154])
      rect(6, 8, 3, 2, [42, 91, 176])
      rect(5, 10, 3, 2, [42, 91, 176])
      rect(5, 12, 3, 2, [36, 78, 150])
      rect(4, 14, 3, 2, [36, 78, 150])
      rect(9, 8, 1, 2, [34, 34, 34])
      px(10, 9, [34, 34, 34])
      break
    }
    case 'battery': {
      rect(7, 1, 2, 1, [204, 204, 204])
      rect(6, 2, 4, 4, [216, 135, 58])
      rect(6, 2, 1, 4, [240, 168, 90])
      rect(9, 2, 1, 4, [168, 96, 42])
      rect(6, 6, 4, 8, [30, 30, 30])
      rect(6, 6, 1, 8, [74, 74, 74])
      rect(9, 6, 1, 8, [16, 16, 16])
      rect(6, 9, 4, 1, [216, 135, 58])
      rect(6, 14, 4, 1, [170, 170, 170])
      break
    }
    case 'battery_box': {
      rect(1, 2, 14, 12, [34, 34, 36])
      rect(1, 2, 14, 1, [60, 60, 64])
      for (const cx of [2, 6, 10]) {
        rect(cx, 3, 3, 10, [52, 52, 56])
        px(cx + 1, 3, [190, 190, 190])
        px(cx, 4, [190, 190, 190])
        px(cx + 2, 4, [190, 190, 190])
        rect(cx, 12, 3, 1, [220, 220, 220])
      }
      px(14, 4, [220, 40, 40])
      px(15, 4, [220, 40, 40])
      px(14, 6, [70, 70, 70])
      px(15, 6, [70, 70, 70])
      break
    }
  }
}

const iconCache = new Map<ItemId, string>()

function isoBlockIcon(top: HTMLCanvasElement, side: HTMLCanvasElement) {
  const S = 64
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  const k = S / 48
  const s = 16
  const faces: [HTMLCanvasElement, number[], number][] = [
    [top, [20 / s, -10 / s, 20 / s, 10 / s, 4, 14], 0],
    [side, [20 / s, 10 / s, 0, 22 / s, 4, 14], 0.22],
    [side, [20 / s, -10 / s, 0, 22 / s, 24, 24], 0.42],
  ]
  for (const [img, m, dark] of faces) {
    ctx.setTransform(m[0] * k, m[1] * k, m[2] * k, m[3] * k, m[4] * k, m[5] * k)
    ctx.drawImage(img, -0.15, -0.15, 16.3, 16.3)
    if (dark > 0) {
      ctx.fillStyle = `rgba(0,0,0,${dark})`
      ctx.fillRect(0, 0, 16, 16)
    }
  }
  return c.toDataURL()
}

export function getItemIcon(item: ItemId): string {
  if (typeof document === 'undefined') return ''
  const cached = iconCache.get(item)
  if (cached) return cached
  const tileMap: Partial<Record<ItemId, number>> = {
    robotics: T.ROBOTICS,
    iron: T.IRON,
    wood: T.WOOD,
    component: T.COMPONENT,
    led: T.LED_OFF,
    aluminum: T.ALUMINUM,
    gear: T.GEAR,
  }
  let url: string
  const tile = tileMap[item]
  if (tile !== undefined) {
    const t = getTileCanvas(tile)
    url = isoBlockIcon(t, t)
  } else {
    const small = pixelCanvas(16, (px) => drawItemPixels(item, px))
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(small, 0, 0, 64, 64)
    url = c.toDataURL()
  }
  iconCache.set(item, url)
  return url
}

export function getItemSpriteCanvas(item: ItemId) {
  return pixelCanvas(16, (px) => drawItemPixels(item, px))
}

export function getTileCanvasPublic(tile: number) {
  return getTileCanvas(tile)
}
