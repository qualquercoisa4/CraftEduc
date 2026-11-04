/**
 * Pure tyre/suspension calculations shared by the rigid-body simulation and tests.
 *
 * The mounted-wheel model uses a short virtual suspension reach because the
 * visible wheel is a sensor collider rather than a physical tyre collider.
 * A small positive gap therefore represents suspension extension, not a full
 * loss of normal load.
 */

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min))

/**
 * Estimate the normal reaction at a mounted wheel's contact patch.
 *
 * Positive gap means the wheel is above the support surface and the suspension
 * is extended. Negative gap means tyre penetration/compression. Vertical
 * velocity damps the reaction to avoid a constant upward impulse.
 */
export function calculateWheelNormalForce(
  staticNormalLoadN: number,
  gapMeters: number,
  verticalVelocityMps: number,
  suspensionReachMeters = 0.2,
) {
  if (!Number.isFinite(staticNormalLoadN) || staticNormalLoadN <= 0) return 0
  if (!Number.isFinite(gapMeters) || !Number.isFinite(verticalVelocityMps)) return 0
  const reach = Number.isFinite(suspensionReachMeters)
    ? Math.max(0.01, suspensionReachMeters)
    : 0.2
  const extensionRatio = clamp(1 - Math.max(0, gapMeters) / reach, 0, 1)
  const compressionMeters = Math.max(0, -gapMeters)
  const reaction = staticNormalLoadN * extensionRatio
    + compressionMeters * 520
    - verticalVelocityMps * 34
  return clamp(reaction, 0, staticNormalLoadN * 1.5)
}
