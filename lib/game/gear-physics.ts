export interface GearMeshImpulseInput {
  speedA: number
  speedB: number
  inertiaA: number
  inertiaB: number
  teethA: number
  teethB: number
  axisAlignment: number
}

export interface GearMeshImpulseResult {
  impulseA: number
  impulseB: number
  nextSpeedA: number
  nextSpeedB: number
  constraintErrorBefore: number
  constraintErrorAfter: number
}

/**
 * Apply the ideal angular impulse needed to satisfy one external gear mesh.
 * Speeds are measured along each shaft's own positive axis. If the shaft
 * vectors point in opposite directions, axisAlignment accounts for that sign.
 * The impulse conserves kinetic energy and does not create motor energy.
 */
export function solveGearMeshImpulse(input: GearMeshImpulseInput): GearMeshImpulseResult | null {
  const values = [
    input.speedA, input.speedB, input.inertiaA, input.inertiaB,
    input.teethA, input.teethB, input.axisAlignment,
  ]
  if (!values.every(Number.isFinite)) return null
  if (input.inertiaA <= 0 || input.inertiaB <= 0 || input.teethA <= 0 || input.teethB <= 0) return null
  if (Math.abs(Math.abs(input.axisAlignment) - 1) > 1e-3) return null

  const ratio = input.teethA / input.teethB
  const coupling = -Math.sign(input.axisAlignment) * ratio
  // Constraint: omegaB - coupling * omegaA = 0.
  const errorBefore = input.speedB - coupling * input.speedA
  const denominator = 1 / input.inertiaB + coupling * coupling / input.inertiaA
  if (!Number.isFinite(denominator) || denominator <= 0) return null
  const lambda = -errorBefore / denominator
  const impulseA = -coupling * lambda
  const impulseB = lambda
  const nextSpeedA = input.speedA + impulseA / input.inertiaA
  const nextSpeedB = input.speedB + impulseB / input.inertiaB
  const errorAfter = nextSpeedB - coupling * nextSpeedA
  if (![impulseA, impulseB, nextSpeedA, nextSpeedB, errorAfter].every(Number.isFinite)) return null

  return {
    impulseA,
    impulseB,
    nextSpeedA,
    nextSpeedB,
    constraintErrorBefore: errorBefore,
    constraintErrorAfter: errorAfter,
  }
}

/** Approximate voxel assembly moment of inertia around its shaft axis (kg·m²). */
export function estimateGearAssemblyInertia(
  gearMassKg: number,
  attachedBlockMassesKg: readonly number[],
  gearRadiusM = 0.455,
): number {
  if (![gearMassKg, gearRadiusM, ...attachedBlockMassesKg].every(Number.isFinite)
    || gearMassKg < 0 || gearRadiusM <= 0
    || attachedBlockMassesKg.some((mass) => mass < 0)) return 0
  // A gear is approximated as a solid disk. Axially stacked 1 m³ blocks each
  // contribute the inertia of a cube about its central axis: m*(1²+1²)/12.
  const gearInertia = 0.5 * gearMassKg * gearRadiusM * gearRadiusM
  const blocksInertia = attachedBlockMassesKg.reduce((sum, mass) => sum + mass / 6, 0)
  return gearInertia + blocksInertia
}
