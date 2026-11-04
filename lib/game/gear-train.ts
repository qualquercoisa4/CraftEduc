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
