export const MIN_GEAR_TEETH = 12
export const MAX_GEAR_TEETH = 48
export const DEFAULT_GEAR_TEETH = 24
export const DEFAULT_GEAR_EFFICIENCY = 0.96
export const GEAR_MODULE_TOLERANCE = 0.015

export interface GearPairInput {
  teethA: number
  teethB: number
  centerDistance: number
  axisAlignment: number
  axialOffset: number
  moduleA?: number
  moduleB?: number
}

export interface GearPairResult {
  teethA: number
  teethB: number
  centerDistance: number
  module: number
  ratio: number
  speedRatioAtoB: number
  torqueRatioAtoB: number
  efficiency: number
}

export function normalizeGearTeeth(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_GEAR_TEETH
  return Math.max(MIN_GEAR_TEETH, Math.min(MAX_GEAR_TEETH, Math.round(numeric)))
}

/** External spur gears: parallel shafts, coplanar centres and a common module. */
export function calculateGearPair(input: GearPairInput): GearPairResult | null {
  const teethA = normalizeGearTeeth(input.teethA)
  const teethB = normalizeGearTeeth(input.teethB)
  const values = [input.centerDistance,input.axisAlignment,input.axialOffset,input.moduleA ?? 0,input.moduleB ?? 0]
  if (!values.every(Number.isFinite) || input.centerDistance <= 0) return null
  if (Math.abs(Math.abs(input.axisAlignment) - 1) > 1e-3 || Math.abs(input.axialOffset) > 1e-3) return null
  const module = (2 * input.centerDistance) / (teethA + teethB)
  if (!Number.isFinite(module) || module <= 0) return null
  const matchesModule = (existing?: number) => existing === undefined || existing === 0
    || (Number.isFinite(existing) && Math.abs(existing-module)/Math.max(existing,module) <= GEAR_MODULE_TOLERANCE)
  if (!matchesModule(input.moduleA) || !matchesModule(input.moduleB)) return null
  const ratio = teethB / teethA
  return {
    teethA, teethB, centerDistance: input.centerDistance, module, ratio,
    speedRatioAtoB: 1/ratio,
    torqueRatioAtoB: ratio*DEFAULT_GEAR_EFFICIENCY,
    efficiency: DEFAULT_GEAR_EFFICIENCY,
  }
}

export function drivenGearAngle(inputAngleA:number,teethA:number,teethB:number):number {
  if(!Number.isFinite(inputAngleA)) return 0
  return -inputAngleA*normalizeGearTeeth(teethA)/normalizeGearTeeth(teethB)
}
export function outputGearSpeed(inputSpeedA:number,pair:GearPairResult):number {
  return Number.isFinite(inputSpeedA) ? -inputSpeedA*pair.speedRatioAtoB : 0
}
export function outputGearTorque(inputTorqueNm:number,pair:GearPairResult):number {
  return Number.isFinite(inputTorqueNm) ? inputTorqueNm*pair.torqueRatioAtoB : 0
}


export interface GearTrainEdge {
  a: string
  b: string
  teethA: number
  teethB: number
  axisAlignment?: number
}

/**
 * Propagate angular positions through a connected gear graph. Each mesh uses
 * its own tooth ratio; a train is not rejected merely because its pairs imply
 * different modules. This is the grid-based kinematic model used by the game.
 */
export function propagateGearTrainAngles(
  sources: ReadonlyMap<string, number>,
  edges: readonly GearTrainEdge[],
  tolerance = 0.05,
): { angles: Map<string, number>; conflicts: Set<string> } {
  const adjacency = new Map<string, { key: string; from: number; to: number; axisSign: number }[]>()
  for (const edge of edges) {
    if (!edge.a || !edge.b || edge.a === edge.b) continue
    const teethA = normalizeGearTeeth(edge.teethA)
    const teethB = normalizeGearTeeth(edge.teethB)
    const alignment = edge.axisAlignment ?? 1
    if (!Number.isFinite(alignment) || Math.abs(Math.abs(alignment) - 1) > 1e-3) continue
    const axisSign = Math.sign(alignment)
    const a = adjacency.get(edge.a) ?? []
    a.push({ key: edge.b, from: teethA, to: teethB, axisSign })
    adjacency.set(edge.a, a)
    const b = adjacency.get(edge.b) ?? []
    b.push({ key: edge.a, from: teethB, to: teethA, axisSign })
    adjacency.set(edge.b, b)
  }
  const angles = new Map<string, number>()
  const conflicts = new Set<string>()
  const queue: string[] = []
  for (const [key, angle] of sources) {
    if (!Number.isFinite(angle)) continue
    const previous = angles.get(key)
    if (previous === undefined) { angles.set(key, angle); queue.push(key) }
    else if (Math.abs(previous - angle) > tolerance) conflicts.add(key)
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const key = queue[cursor]
    if (conflicts.has(key)) continue
    const angle = angles.get(key)
    if (angle === undefined) continue
    for (const next of adjacency.get(key) ?? []) {
      const nextAngle = drivenGearAngle(angle, next.from, next.to) * next.axisSign
      const previous = angles.get(next.key)
      if (previous === undefined) { angles.set(next.key, nextAngle); queue.push(next.key) }
      else if (Math.abs(previous - nextAngle) > tolerance) {
        conflicts.add(key)
        conflicts.add(next.key)
      }
    }
  }
  return { angles, conflicts }
}


export function calculateReflectedGearInertia(
  sourceKey: string,
  inertias: ReadonlyMap<string, number>,
  edges: readonly GearTrainEdge[],
): { equivalentInertia: number; speedRatios: Map<string, number>; conflicts: Set<string> } {
  const adjacency = new Map<string, { key: string; from: number; to: number; axisSign: number }[]>()
  for (const edge of edges) {
    if (!edge.a || !edge.b || edge.a === edge.b) continue
    const alignment = edge.axisAlignment ?? 1
    if (!Number.isFinite(alignment) || Math.abs(Math.abs(alignment) - 1) > 1e-3) continue
    const axisSign = Math.sign(alignment)
    const teethA = normalizeGearTeeth(edge.teethA)
    const teethB = normalizeGearTeeth(edge.teethB)
    const a = adjacency.get(edge.a) ?? []
    a.push({ key: edge.b, from: teethA, to: teethB, axisSign })
    adjacency.set(edge.a, a)
    const b = adjacency.get(edge.b) ?? []
    b.push({ key: edge.a, from: teethB, to: teethA, axisSign })
    adjacency.set(edge.b, b)
  }

  const speedRatios = new Map<string, number>([[sourceKey, 1]])
  const conflicts = new Set<string>()
  const queue = [sourceKey]
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const key = queue[cursor]
    if (conflicts.has(key)) continue
    const ratio = speedRatios.get(key)
    if (ratio === undefined) continue
    for (const next of adjacency.get(key) ?? []) {
      const nextRatio = -next.axisSign * ratio * next.from / next.to
      const previous = speedRatios.get(next.key)
      if (previous === undefined) {
        speedRatios.set(next.key, nextRatio)
        queue.push(next.key)
      } else if (Math.abs(previous - nextRatio) > 1e-5) {
        conflicts.add(key)
        conflicts.add(next.key)
      }
    }
  }

  let equivalentInertia = 0
  for (const [key, ratio] of speedRatios) {
    if (key === sourceKey || conflicts.has(key)) continue
    const inertia = inertias.get(key) ?? 0
    if (Number.isFinite(inertia) && inertia > 0) equivalentInertia += inertia * ratio * ratio
  }
  return { equivalentInertia, speedRatios, conflicts }
}
