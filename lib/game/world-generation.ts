import { B, GROUND_LEVEL } from './constants'

export type WorldType =
  | 'flat'
  | 'prototypes'
  | 'deep_pits'
  | 'mega_maze'
  | 'line_following'
  | 'mars_colony'
  | 'venus_colony'
  | 'mystery_planet'
  | 'robot_city'
  | 'beach'

export const WORLD_TYPE_OPTIONS: { id: WorldType; name: string; description: string }[] = [
  { id: 'flat', name: 'Mundo plano', description: 'O mundo atual, com chão de blocos de robótica.' },
  { id: 'prototypes', name: 'Mundo de protótipos', description: 'Um chão branco para montar e testar robôs.' },
  { id: 'deep_pits', name: 'Buracos profundos', description: 'Uma plataforma inicial 20×20 e valas sobre o void que aumentam de 2 em 2 blocos.' },
  { id: 'mega_maze', name: 'Mega labirinto', description: 'Um labirinto enorme com rotas alternativas, cruzamentos largos e corredores de passagem para robôs.' },
  { id: 'line_following', name: 'Pista de seguir linha', description: 'Pista escura no piso branco, com curvas, cruzamentos e ramificações para testar robôs seguidores de linha.' },
  { id: 'mars_colony', name: 'Colônia de Marte', description: 'Terreno avermelhado, crateras, módulos de pesquisa, painéis solares e área de pouso.' },
  { id: 'venus_colony', name: 'Colônia de Vênus', description: 'Planície vulcânica sob nuvens douradas, habitats pressurizados e plataformas elevadas.' },
  { id: 'mystery_planet', name: 'Planeta misterioso', description: 'Um mundo alienígena com florestas estranhas, cristais luminosos e vales procedurais.' },
  { id: 'robot_city', name: 'Cidade dos robôs', description: 'Metrópole tecnológica com avenidas, torres, painéis luminosos e robôs assistentes.' },
  { id: 'beach', name: 'Praia', description: 'Uma ilha de areia 20×20 cercada por água; objetos flutuam ou afundam e componentes desprotegidos queimam.' },
]

const MAZE_CELLS = 20
const MAZE_CELL_SIZE = 24
const MAZE_SIZE = MAZE_CELLS * MAZE_CELL_SIZE
const MAZE_WALL_HEIGHT = 6
const mazeCache = new Map<number, Set<string>>()
const LINE_WORLD_HALF_SIZE = 40
const BEACH_HALF_SIZE = 64
const BEACH_PAD_HALF_SIZE = 10

function hasPitFloor(x: number, z: number) {
  const onStartingPlatform = x >= -10 && x < 10 && z >= -10 && z < 10
  if (onStartingPlatform) return true
  if (x < -10 || x >= 10 || z < 10) return false

  // Leave the starting platform into a 2-block trench first. Each
  // subsequent trench is 2 blocks wider, with 20-block landing strips between.
  let cursor = 10
  for (let stage = 0; stage < 2000; stage++) {
    const gap = 2 * (stage + 1)
    if (z >= cursor && z < cursor + gap) return false
    cursor += gap
    if (z >= cursor && z < cursor + 20) return true
    cursor += 20
    if (z < cursor) return false
  }
  return false
}

function hash2(seed: number, x: number, z: number) {
  let h = (seed ^ Math.imul(x, 0x45d9f3b) ^ Math.imul(z, 0x27d4eb2d)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967295
}

function mazeOpenings(seed: number) {
  const normalizedSeed = seed >>> 0
  const cached = mazeCache.get(normalizedSeed)
  if (cached) return cached

  let state = normalizedSeed || 0x6d2b79f5
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const openings = new Set<string>()
  const visited = new Uint8Array(MAZE_CELLS * MAZE_CELLS)
  const stack: [number, number][] = [[0, 0]]
  visited[0] = 1
  const directions: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]

  // Randomized depth-first search builds a connected maze first.
  while (stack.length) {
    const [x, z] = stack[stack.length - 1]
    const choices = directions
      .map(([dx, dz]) => ({ x: x + dx, z: z + dz, dx, dz }))
      .filter((next) =>
        next.x >= 0 && next.x < MAZE_CELLS &&
        next.z >= 0 && next.z < MAZE_CELLS &&
        !visited[next.z * MAZE_CELLS + next.x],
      )

    if (choices.length === 0) {
      stack.pop()
      continue
    }

    const next = choices[Math.floor(random() * choices.length)]
    if (next.dx !== 0) {
      openings.add('v:' + Math.max(x, next.x) + ',' + z)
    } else {
      openings.add('h:' + x + ',' + Math.max(z, next.z))
    }
    visited[next.z * MAZE_CELLS + next.x] = 1
    stack.push([next.x, next.z])
  }

  // Break additional walls between neighbouring rooms to introduce loops,
  // alternate routes and fewer dead ends than a perfect maze.
  for (let z = 0; z < MAZE_CELLS; z++) {
    for (let x = 0; x < MAZE_CELLS; x++) {
      if (x + 1 < MAZE_CELLS) {
        const key = 'v:' + (x + 1) + ',' + z
        if (!openings.has(key) && random() < 0.19) openings.add(key)
      }
      if (z + 1 < MAZE_CELLS) {
        const key = 'h:' + x + ',' + (z + 1)
        if (!openings.has(key) && random() < 0.19) openings.add(key)
      }
    }
  }

  mazeCache.set(normalizedSeed, openings)
  return openings
}

function isMazeWall(x: number, z: number, seed: number) {
  if (x < 0 || x > MAZE_SIZE || z < 0 || z > MAZE_SIZE) return false
  const openings = mazeOpenings(seed)

  if (x % MAZE_CELL_SIZE === 0) {
    const boundary = x / MAZE_CELL_SIZE
    const segment = Math.floor(z / MAZE_CELL_SIZE)
    const offset = z % MAZE_CELL_SIZE
    const isMajorCrossing = boundary % 5 === 0 && segment % 5 === 0
    const halfWidth = isMajorCrossing ? 4 : 2
    const isOpening = boundary > 0 && boundary < MAZE_CELLS &&
      segment >= 0 && segment < MAZE_CELLS &&
      openings.has('v:' + boundary + ',' + segment) &&
      offset >= 12 - halfWidth && offset <= 12 + halfWidth
    if (!isOpening) return true
  }

  if (z % MAZE_CELL_SIZE === 0) {
    const boundary = z / MAZE_CELL_SIZE
    const segment = Math.floor(x / MAZE_CELL_SIZE)
    const offset = x % MAZE_CELL_SIZE
    const isMajorCrossing = boundary % 5 === 0 && segment % 5 === 0
    const halfWidth = isMajorCrossing ? 4 : 2
    const isOpening = boundary > 0 && boundary < MAZE_CELLS &&
      segment >= 0 && segment < MAZE_CELLS &&
      openings.has('h:' + segment + ',' + boundary) &&
      offset >= 12 - halfWidth && offset <= 12 + halfWidth
    if (!isOpening) return true
  }

  return false
}

function segmentDistance(x: number, z: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax
  const dz = bz - az
  const lengthSq = dx * dx + dz * dz
  const t = lengthSq <= 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSq))
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t))
}

function isLineTrack(x: number, z: number) {
  const points: [number, number][] = [
    [-24, -24], [24, -24], [24, 24], [-24, 24], [-24, -24],
    [-24, 0], [-12, 0], [-12, -10], [0, -10], [0, 10],
    [12, 10], [12, 0], [24, 0],
    [0, -34], [0, -24],
  ]
  for (let i = 0; i < points.length - 1; i++) {
    if (segmentDistance(x, z, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]) <= 0.72) return true
  }
  return false
}

function marsSurfaceHeight(seed: number, x: number, z: number) {
  // Preserve a wide, walkable central base while the outskirts use layered
  // noise, erosion channels and several craters for a less tiled landscape.
  if (Math.abs(x) <= 22 && Math.abs(z) <= 22) return GROUND_LEVEL

  const broad = hash2(seed, Math.floor(x / 13), Math.floor(z / 13))
  const medium = hash2(seed ^ 0x51ed270b, Math.floor(x / 5), Math.floor(z / 5))
  const fine = hash2(seed ^ 0x2c1b3c6d, x, z)
  let height = GROUND_LEVEL - 2 + Math.floor(broad * 3) + Math.floor(medium * 2)
  if (fine > 0.84) height += 1

  const craters = [
    { x: 36, z: -28, radius: 9 },
    { x: -39, z: -27, radius: 7 },
    { x: 39, z: 34, radius: 11 },
    { x: -30, z: 39, radius: 8 },
  ]
  for (const crater of craters) {
    const distance = Math.hypot(x - crater.x, z - crater.z)
    if (distance < crater.radius * 0.68) height = Math.min(height, GROUND_LEVEL - 3)
    else if (distance < crater.radius) height = Math.max(height, GROUND_LEVEL + 1)
    else if (distance < crater.radius * 1.45) height = Math.max(height, GROUND_LEVEL)
  }

  // Long shallow gullies and a rocky ridge make the approach terrain readable.
  const gully = Math.abs(z - Math.sin(x * 0.12) * 8)
  if (gully < 2.2 && Math.abs(x) > 24) height = Math.min(height, GROUND_LEVEL - 1)
  const ridgeDistance = Math.hypot(x + 34, z - 29)
  if (ridgeDistance < 8) height = Math.max(height, GROUND_LEVEL + 2)
  return Math.max(1, Math.min(10, height))
}

function marsStructureBlock(x: number, y: number, z: number) {
  if (y < GROUND_LEVEL || y > GROUND_LEVEL + 12) return B.AIR

  // Habitat module A: metal shell, cyan windows, doorway and a flat roof.
  const a = x >= -12 && x <= -5 && z >= -16 && z <= -8
  if (a) {
    if (y === GROUND_LEVEL + 4) return B.ALUMINUM
    if (y >= GROUND_LEVEL && y <= GROUND_LEVEL + 3) {
      const wall = x === -12 || x === -5 || z === -16 || z === -8
      const doorway = z === -8 && x >= -9 && x <= -8 && y <= GROUND_LEVEL + 2
      if (doorway) return B.AIR
      if (!wall) return B.AIR
      const window = y === GROUND_LEVEL + 2 && (
        (z === -16 && (x === -10 || x === -7)) ||
        (z === -8 && (x === -11 || x === -6)) ||
        (x === -12 && z === -12) || (x === -5 && z === -12)
      )
      return window ? B.COLOR_BLOCK : B.IRON
    }
  }

  // Research module B has a longer shell and windows on multiple sides.
  const b = x >= 4 && x <= 13 && z >= -16 && z <= -7
  if (b) {
    if (y === GROUND_LEVEL + 5) return B.ALUMINUM
    if (y >= GROUND_LEVEL && y <= GROUND_LEVEL + 4) {
      const wall = x === 4 || x === 13 || z === -16 || z === -7
      const doorway = z === -7 && x >= 8 && x <= 9 && y <= GROUND_LEVEL + 2
      if (doorway) return B.AIR
      if (!wall) return B.AIR
      const window = y === GROUND_LEVEL + 3 && (
        (z === -16 && (x === 6 || x === 11)) ||
        (z === -7 && (x === 5 || x === 12)) ||
        (x === 4 && z === -12) || (x === 13 && z === -12)
      )
      return window ? B.COLOR_BLOCK : B.IRON
    }
  }

  // Flat solar-panel array to the west of the landing pad.
  if (y === GROUND_LEVEL && x >= -20 && x <= -15 && z >= 1 && z <= 8) {
    return (x + z) % 3 === 0 ? B.ALUMINUM : B.COLOR_BLOCK
  }

  // A compact research rover assembled from ordinary block geometry.
  if (y === GROUND_LEVEL && x >= 2 && x <= 5 && z >= 5 && z <= 7) return B.IRON
  if (y === GROUND_LEVEL + 1 && x >= 3 && x <= 4 && z >= 5 && z <= 6) return B.COLOR_BLOCK

  // Communications mast with a small cap.
  if (x === 17 && z === 1 && y >= GROUND_LEVEL && y <= GROUND_LEVEL + 8) {
    return y === GROUND_LEVEL + 8 ? B.ALUMINUM : B.IRON
  }

  // Expanded colony: a landing-pad perimeter, two cargo crates and a
  // low maintenance shelter give the base readable zones beyond the habitats.
  if (y === GROUND_LEVEL && x >= 22 && x <= 34 && z >= -2 && z <= 10) {
    if (x === 22 || x === 34 || z === -2 || z === 10) {
      return (x + z) % 3 === 0 ? B.ALUMINUM : B.IRON
    }
  }
  if (x >= 31 && x <= 33 && z >= -13 && z <= -11 && y >= GROUND_LEVEL && y <= GROUND_LEVEL + 1) {
    return y === GROUND_LEVEL ? B.ALUMINUM : B.IRON
  }
  if (x >= 24 && x <= 28 && z >= -18 && z <= -17) {
    if (y === GROUND_LEVEL + 3) return B.ALUMINUM
    if (y >= GROUND_LEVEL && y <= GROUND_LEVEL + 2 && (x === 24 || x === 28 || z === -18)) return B.IRON
  }

  return B.AIR
}

// Procedural structures have real glue state, not merely touching voxels.
// Glue every neighbouring face in a generated habitat so roofs, walls and
// structural ribs stay attached when physics converts the structure to bodies.
export function getTerrainGlueMask(type: WorldType, seed: number, x: number, y: number, z: number) {
  if (!['mars_colony','venus_colony','mystery_planet','robot_city'].includes(type)) return 0
  const structure = type==='mars_colony' ? marsStructureBlock(x,y,z)
    : type==='venus_colony' ? venusStructureBlock(x,y,z)
    : type==='mystery_planet' ? mysteryStructureBlock(x,y,z,seed)
    : robotCityBlock(x,y,z,seed)
  const id = structure
  if (id === B.AIR) return 0
  let mask = 0
  for (let face = 0; face < 6; face++) {
    const [dx, dy, dz] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]][face]
    const adjacent = type==='mars_colony' ? marsStructureBlock(x+dx,y+dy,z+dz)
      : type==='venus_colony' ? venusStructureBlock(x+dx,y+dy,z+dz)
      : type==='mystery_planet' ? mysteryStructureBlock(x+dx,y+dy,z+dz,seed)
      : robotCityBlock(x+dx,y+dy,z+dz,seed)
    if (adjacent !== B.AIR) mask |= 1 << face
  }
  void seed
  return mask
}


function venusSurfaceHeight(seed: number, x: number, z: number) {
  if (Math.abs(x) <= 23 && Math.abs(z) <= 23) return GROUND_LEVEL
  const broad = hash2(seed ^ 0x6c8e9cf5, Math.floor(x / 11), Math.floor(z / 11))
  const fine = hash2(seed ^ 0x1b873593, Math.floor(x / 3), Math.floor(z / 3))
  let h = GROUND_LEVEL - 2 + Math.floor(broad * 4) + Math.floor(fine * 2)
  const vent = Math.hypot(x - 38, z + 30)
  if (vent < 7) h = Math.min(h, GROUND_LEVEL - 3)
  else if (vent < 11) h = Math.max(h, GROUND_LEVEL + 2)
  return Math.max(1, Math.min(12, h))
}

function alienSurfaceHeight(seed: number, x: number, z: number) {
  if (Math.abs(x) <= 21 && Math.abs(z) <= 21) return GROUND_LEVEL
  const broad = hash2(seed ^ 0x3c6ef372, Math.floor(x / 9), Math.floor(z / 9))
  const medium = hash2(seed ^ 0xa54ff53a, Math.floor(x / 3), Math.floor(z / 3))
  let h = GROUND_LEVEL - 2 + Math.floor(broad * 5) + Math.floor(medium * 2)
  if (Math.abs(z - Math.sin(x * 0.095) * 13) < 3.2) h = Math.min(h, GROUND_LEVEL - 2)
  if (hash2(seed ^ 0x510e527f, Math.floor(x / 7), Math.floor(z / 7)) > 0.94 && Math.abs(x)>23 && Math.abs(z)>23) h += 2
  return Math.max(1, Math.min(14, h))
}

function venusStructureBlock(x: number, y: number, z: number) {
  if (y < GROUND_LEVEL || y > GROUND_LEVEL + 14) return B.AIR
  for (const dome of [{x:-12,z:-11,r:5,h:5},{x:12,z:-10,r:6,h:6},{x:0,z:15,r:4,h:4}]) {
    const dx=x-dome.x, dz=z-dome.z, dist=Math.hypot(dx,dz), level=y-GROUND_LEVEL
    if (dist <= dome.r && level >= 0 && level <= dome.h && (dist >= dome.r-1 || level===dome.h)) {
      if (level===2 && (Math.abs(dx)===dome.r || Math.abs(dz)===dome.r)) return B.COLOR_BLOCK
      return B.ALUMINUM
    }
  }
  if (y===GROUND_LEVEL && x>=-23 && x<=-16 && z>=3 && z<=12) return (x+z)%2 ? B.COLOR_BLOCK : B.ALUMINUM
  if (x===21 && z===5 && y>=GROUND_LEVEL && y<=GROUND_LEVEL+10) return y===GROUND_LEVEL+10 ? B.COLOR_BLOCK : B.IRON
  if (x>=17 && x<=22 && z>=13 && z<=18 && y>=GROUND_LEVEL && y<=GROUND_LEVEL+2) return y===GROUND_LEVEL+2 ? B.ALUMINUM : B.IRON
  return B.AIR
}

function mysteryStructureBlock(x: number, y: number, z: number, seed: number) {
  if (y < GROUND_LEVEL || y > GROUND_LEVEL + 15) return B.AIR
  const sites=[{x:29,z:18,h:10},{x:-31,z:27,h:8},{x:35,z:-30,h:12},{x:-28,z:-34,h:9},{x:10,z:39,h:7},{x:-43,z:5,h:8}]
  for (let i=0;i<sites.length;i++) {
    const p=sites[i], dx=x-p.x, dz=z-p.z
    const radius=1+Math.floor(hash2(seed+i,p.x,p.z)*2)
    const height=p.h+Math.floor(hash2(seed^i,p.x,p.z)*3)
    if (Math.abs(dx)<=radius && Math.abs(dz)<=radius && y<GROUND_LEVEL+height-Math.max(Math.abs(dx),Math.abs(dz))*2) return (Math.abs(dx)+Math.abs(dz))%2===0 ? B.COLOR_BLOCK : B.ALUMINUM
  }
  if (Math.abs(Math.hypot(x+18,z-19)-9)<1.1 && y>=GROUND_LEVEL && y<=GROUND_LEVEL+2) return B.IRON
  if (y===GROUND_LEVEL && Math.abs(x)<=8 && Math.abs(z)<=8 && (Math.abs(x)===8 || Math.abs(z)===8)) return B.COLOR_BLOCK
  return B.AIR
}

function robotCityBlock(x: number, y: number, z: number, seed: number) {
  if (y < 0 || y > GROUND_LEVEL+30 || Math.abs(x)>80 || Math.abs(z)>80) return B.AIR
  if (y < GROUND_LEVEL) return B.ROBOTICS
  const roadX=((x%16)+16)%16<4, roadZ=((z%16)+16)%16<4
  if (y===GROUND_LEVEL && (roadX || roadZ)) return B.ROBOTICS
  if (Math.abs(x)<=10 && Math.abs(z)<=10) return y===GROUND_LEVEL ? B.ROBOTICS : B.AIR
  const lotX=Math.floor(x/16), lotZ=Math.floor(z/16), roll=hash2(seed,lotX,lotZ)
  if (roadX || roadZ || roll<0.2) return B.AIR
  const centerX=lotX*16+9, centerZ=lotZ*16+9, dx=Math.abs(x-centerX), dz=Math.abs(z-centerZ)
  const footprint=roll>0.83?5:roll>0.55?4:3
  const height=5+Math.floor(hash2(seed^0x45d9f3b,lotX,lotZ)*20)
  if (dx>footprint || dz>footprint || y>GROUND_LEVEL+height) return B.AIR
  const edge=dx===footprint || dz===footprint, floor=(y-GROUND_LEVEL)%4===0
  if (y===GROUND_LEVEL+height || edge && floor) return B.ALUMINUM
  if (edge && (y-GROUND_LEVEL)%3===1) return B.COLOR_BLOCK
  return edge ? B.IRON : B.AIR
}

export function getTerrainBlock(type: WorldType, seed: number, x: number, y: number, z: number): number {
  if (y < 0) return B.AIR

  if (type === 'flat') return y < GROUND_LEVEL ? B.ROBOTICS : B.AIR
  if (type === 'prototypes') return y < GROUND_LEVEL ? B.COLOR_BLOCK : B.AIR

  if (type === 'deep_pits') {
    return y < GROUND_LEVEL && hasPitFloor(x, z) ? B.ROBOTICS : B.AIR
  }

  if (type === 'line_following') {
    const inside = x >= -LINE_WORLD_HALF_SIZE && x < LINE_WORLD_HALF_SIZE &&
      z >= -LINE_WORLD_HALF_SIZE && z < LINE_WORLD_HALF_SIZE
    return inside && y < GROUND_LEVEL ? B.COLOR_BLOCK : B.AIR
  }

  if (type === 'beach') {
    const insideOceanBounds = x >= -BEACH_HALF_SIZE && x < BEACH_HALF_SIZE &&
      z >= -BEACH_HALF_SIZE && z < BEACH_HALF_SIZE
    if (!insideOceanBounds) return B.AIR
    const onBeach = x >= -BEACH_PAD_HALF_SIZE && x < BEACH_PAD_HALF_SIZE &&
      z >= -BEACH_PAD_HALF_SIZE && z < BEACH_PAD_HALF_SIZE
    // The island is a 20x20 sand platform. The surrounding sea has a sandy
    // seabed at y=0; the water volume is handled by World and rigid physics.
    if (onBeach) return y < GROUND_LEVEL ? B.COLOR_BLOCK : B.AIR
    return y === 0 ? B.COLOR_BLOCK : B.AIR
  }

  if (type === 'venus_colony') {
    if (x < -72 || x >= 72 || z < -72 || z >= 72) return B.AIR
    const structure=venusStructureBlock(x,y,z)
    if (structure!==B.AIR) return structure
    return y<venusSurfaceHeight(seed,x,z) ? B.COLOR_BLOCK : B.AIR
  }
  if (type === 'mystery_planet') {
    if (x < -72 || x >= 72 || z < -72 || z >= 72) return B.AIR
    const structure=mysteryStructureBlock(x,y,z,seed)
    if (structure!==B.AIR) return structure
    return y<alienSurfaceHeight(seed,x,z) ? (hash2(seed,Math.floor(x/4),Math.floor(z/4))>0.82 ? B.ROBOTICS : B.COLOR_BLOCK) : B.AIR
  }
  if (type === 'robot_city') return robotCityBlock(x,y,z,seed)

  if (type === 'mars_colony') {
    if (x < -64 || x >= 64 || z < -64 || z >= 64) return B.AIR
    const structure = marsStructureBlock(x, y, z)
    if (structure !== B.AIR) return structure
    return y < marsSurfaceHeight(seed, x, z) ? B.COLOR_BLOCK : B.AIR
  }

  if (
    y >= GROUND_LEVEL && y < GROUND_LEVEL + MAZE_WALL_HEIGHT &&
    isMazeWall(x, z, seed)
  ) return B.ROBOTICS

  if (x >= 0 && x < MAZE_SIZE && z >= 0 && z < MAZE_SIZE && y < GROUND_LEVEL) return B.ROBOTICS
  return B.AIR
}

export function getTerrainColor(type: WorldType, seed: number, x: number, y: number, z: number) {
  if (type === 'prototypes' && y < GROUND_LEVEL) return '#f5f5f5'

  if (type === 'line_following' && y < GROUND_LEVEL) {
    return isLineTrack(x, z) ? '#20242a' : '#f4f3ed'
  }

  if (type === 'beach' && y < GROUND_LEVEL) return '#ead39d'

  if (type === 'mars_colony') {
    const structure = marsStructureBlock(x, y, z)
    if (y >= GROUND_LEVEL && structure !== B.AIR) {
      if (structure === B.COLOR_BLOCK) return '#72bfd0'
      if (structure === B.ALUMINUM) return '#c0cbd2'
      return '#8d969e'
    }
    if (y < marsSurfaceHeight(seed, x, z) && x >= -64 && x < 64 && z >= -64 && z < 64) {
      const palette = ['#bd6549', '#b65a3f', '#a94c36', '#c87352']
      return palette[Math.floor(hash2(seed, Math.floor(x / 4), Math.floor(z / 4)) * palette.length)]
    }
  }
  if (type === 'venus_colony') {
    const id=venusStructureBlock(x,y,z)
    if (y>=GROUND_LEVEL && id!==B.AIR) return id===B.COLOR_BLOCK ? '#ffd36a' : id===B.ALUMINUM ? '#d9c7a2' : '#756b5f'
    if (y<venusSurfaceHeight(seed,x,z) && Math.abs(x)<72 && Math.abs(z)<72) return ['#b87a42','#d39b55','#8f5737','#c9a66a'][Math.floor(hash2(seed,Math.floor(x/4),Math.floor(z/4))*4)]
  }
  if (type === 'mystery_planet') {
    const id=mysteryStructureBlock(x,y,z,seed)
    if (y>=GROUND_LEVEL && id!==B.AIR) return id===B.COLOR_BLOCK ? '#70f5e8' : '#9474c9'
    if (y<alienSurfaceHeight(seed,x,z) && Math.abs(x)<72 && Math.abs(z)<72) return ['#526b61','#6b7b72','#465c71','#8270a3'][Math.floor(hash2(seed,Math.floor(x/4),Math.floor(z/4))*4)]
  }
  if (type === 'robot_city') {
    const id=robotCityBlock(x,y,z,seed)
    if (y>=GROUND_LEVEL && id!==B.AIR) return id===B.COLOR_BLOCK ? (Math.floor(hash2(seed,x,z)*2) ? '#00e5ff' : '#ff4fd8') : id===B.ALUMINUM ? '#697987' : '#283746'
    if (y===GROUND_LEVEL && id===B.ROBOTICS) return '#303e4c'
  }
  return undefined
}

export function getWorldSpawn(type: WorldType): [number, number, number] {
  switch (type) {
    case 'mega_maze': return [12.5, GROUND_LEVEL, 12.5]
    case 'deep_pits': return [0.5, GROUND_LEVEL, 0.5]
    case 'prototypes': return [0.5, GROUND_LEVEL, 0.5]
    case 'line_following': return [0.5, GROUND_LEVEL, -33.5]
    case 'mars_colony': return [0.5, GROUND_LEVEL, 0.5]
    case 'venus_colony': return [0.5, GROUND_LEVEL, 0.5]
    case 'mystery_planet': return [0.5, GROUND_LEVEL, 0.5]
    case 'robot_city': return [0.5, GROUND_LEVEL, 0.5]
    case 'beach': return [0.5, GROUND_LEVEL, 0.5]
    case 'flat':
    default: return [4.5, GROUND_LEVEL, 5.5]
  }
}
