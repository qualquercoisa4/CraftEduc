import { B, GROUND_LEVEL } from './constants'

export type WorldType = 'flat' | 'prototypes' | 'deep_pits' | 'mega_maze'

export const WORLD_TYPE_OPTIONS: { id: WorldType; name: string; description: string }[] = [
  { id: 'flat', name: 'Mundo plano', description: 'O mundo atual, com chão de blocos de robótica.' },
  { id: 'prototypes', name: 'Mundo de protótipos', description: 'Um chão branco para montar e testar robôs.' },
  { id: 'deep_pits', name: 'Buracos profundos', description: 'Uma plataforma inicial 20×20 e valas sobre o void que aumentam de 2 em 2 blocos.' },
  { id: 'mega_maze', name: 'Mega labirinto', description: 'Um labirinto aleatório, com corredores largos para construir robôs.' },
]

const MAZE_CELLS = 20
const MAZE_CELL_SIZE = 24
const MAZE_SIZE = MAZE_CELLS * MAZE_CELL_SIZE
const MAZE_WALL_HEIGHT = 6
const mazeCache = new Map<number, Set<string>>()

function hasPitFloor(x: number, z: number) {
  const onStartingPlatform = x >= -10 && x < 10 && z >= -10 && z < 10
  if (onStartingPlatform) return true
  if (x < -10 || x >= 10 || z < 10) return false

  let cursor = 10
  for (let stage = 0; stage < 2000; stage++) {
    if (z >= cursor && z < cursor + 20) return true
    cursor += 20
    const gap = 2 * (stage + 1)
    if (z >= cursor && z < cursor + gap) return false
    cursor += gap
    if (z < cursor) return false
  }
  return false
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
      openings.add(`v:${Math.max(x, next.x)},${z}`)
    } else {
      openings.add(`h:${x},${Math.max(z, next.z)}`)
    }
    visited[next.z * MAZE_CELLS + next.x] = 1
    stack.push([next.x, next.z])
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
    const isOpening = boundary > 0 && boundary < MAZE_CELLS &&
      segment >= 0 && segment < MAZE_CELLS &&
      openings.has(`v:${boundary},${segment}`) && offset >= 11 && offset <= 13
    if (!isOpening) return true
  }

  if (z % MAZE_CELL_SIZE === 0) {
    const boundary = z / MAZE_CELL_SIZE
    const segment = Math.floor(x / MAZE_CELL_SIZE)
    const offset = x % MAZE_CELL_SIZE
    const isOpening = boundary > 0 && boundary < MAZE_CELLS &&
      segment >= 0 && segment < MAZE_CELLS &&
      openings.has(`h:${segment},${boundary}`) && offset >= 11 && offset <= 13
    if (!isOpening) return true
  }

  return false
}

/** Returns the deterministic, unedited block belonging to a world's template. */
export function getTerrainBlock(type: WorldType, seed: number, x: number, y: number, z: number): number {
  if (y < 0) return B.AIR

  if (type === 'flat') return y < GROUND_LEVEL ? B.ROBOTICS : B.AIR

  if (type === 'prototypes') {
    return y < GROUND_LEVEL ? B.COLOR_BLOCK : B.AIR
  }

  if (type === 'deep_pits') {
    return y < GROUND_LEVEL && hasPitFloor(x, z) ? B.ROBOTICS : B.AIR
  }

  if (
    y >= GROUND_LEVEL && y < GROUND_LEVEL + MAZE_WALL_HEIGHT &&
    isMazeWall(x, z, seed)
  ) return B.ROBOTICS

  if (x >= 0 && x < MAZE_SIZE && z >= 0 && z < MAZE_SIZE && y < GROUND_LEVEL) return B.ROBOTICS
  return B.AIR
}

export function getTerrainColor(type: WorldType, y: number) {
  return type === 'prototypes' && y < GROUND_LEVEL ? '#f5f5f5' : undefined
}

export function getWorldSpawn(type: WorldType): [number, number, number] {
  switch (type) {
    case 'mega_maze': return [12.5, GROUND_LEVEL, 12.5]
    case 'deep_pits': return [0.5, GROUND_LEVEL, 0.5]
    case 'prototypes': return [0.5, GROUND_LEVEL, 0.5]
    case 'flat':
    default: return [4.5, GROUND_LEVEL, 5.5]
  }
}
