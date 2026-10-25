import type { MotorSpec } from './motor-specs'

/**
 * The game renders metre-scale blocks, so the rigid-body layer applies its own
 * gameplay scale to torque. Electrical values returned here remain in SI units.
 *
 * A brushed DC motor's back-EMF is approximately proportional to shaft speed,
 * and its useful torque is approximately proportional to armature current.
 */
export const MAX_MOTOR_MODEL_RATIO = 2.25

export type MotorPowerFlow = 'motoring' | 'generating' | 'idle'

/** Classify power direction using the passive sign convention at the motor terminals. */
export function classifyMotorPowerFlow(terminalVoltageV: number, windingCurrentA: number): MotorPowerFlow {
  if (!Number.isFinite(terminalVoltageV) || !Number.isFinite(windingCurrentA)) return 'idle'
  const electricalPowerW = terminalVoltageV * windingCurrentA
  if (electricalPowerW > 0.001) return 'motoring'
  if (electricalPowerW < -0.001) return 'generating'
  return 'idle'
}

export interface MotorDriveCommand {
  targetOmega: number
  /** Shaft torque in N·m before the game's world-scale conversion. */
  maxTorqueNm: number
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min))

export function motorNoLoadAngularSpeed(spec: MotorSpec) {
  return Math.max(0, spec.noLoadRpm) * Math.PI * 2 / 60
}

/** Estimate signed armature back-EMF from measured shaft speed, not target speed. */
export function estimateMotorBackEmfVolts(spec: MotorSpec, angularSpeedRadPerSec: number) {
  const nominalOmega = motorNoLoadAngularSpeed(spec)
  if (nominalOmega <= 1e-6 || !Number.isFinite(angularSpeedRadPerSec)) return 0
  const speedRatio = clamp(angularSpeedRadPerSec / nominalOmega, -MAX_MOTOR_MODEL_RATIO, MAX_MOTOR_MODEL_RATIO)
  // Calibrate back-EMF so the motor still draws its catalogued no-load current
  // at the catalogued no-load RPM. Using the full nominal voltage as back-EMF
  // would imply zero current at that speed and contradict the torque model.
  const windingResistance = spec.nominalVoltageV / Math.max(0.01, spec.stallCurrentA ?? 1.5)
  const noLoadCurrentA = clamp(spec.noLoadCurrentA ?? 0, 0, (spec.stallCurrentA ?? 1.5) * 0.9)
  const backEmfAtNoLoadSpeed = Math.max(0, spec.nominalVoltageV - noLoadCurrentA * windingResistance)
  return speedRatio * backEmfAtNoLoadSpeed
}

/**
 * Signed shaft torque in N·m from measured armature current.
 *
 * Current and torque retain their physical signs: reverse current creates
 * reverse torque, which naturally brakes a motor that is being back-driven.
 * No-load current is treated as internal mechanical/brush loss opposing motion,
 * rather than being mistaken for useful output torque.
 */
export function motorTorqueFromCurrent(
  spec: MotorSpec,
  windingCurrentA: number,
  shaftAngularSpeedRadPerSec: number,
) {
  const stallCurrentA = Math.max(0.01, spec.stallCurrentA ?? 1.5)
  const torqueConstantNmPerAmp = Math.max(0, spec.stallTorqueNm) / stallCurrentA
  const current = Number.isFinite(windingCurrentA) ? windingCurrentA : 0
  const noLoadCurrentA = clamp(spec.noLoadCurrentA ?? 0, 0, stallCurrentA * 0.9)
  const internalLossTorque = Math.abs(shaftAngularSpeedRadPerSec) > 0.05
    ? Math.sign(shaftAngularSpeedRadPerSec) * torqueConstantNmPerAmp * noLoadCurrentA
    : 0
  return clamp(
    torqueConstantNmPerAmp * current - internalLossTorque,
    -spec.stallTorqueNm * MAX_MOTOR_MODEL_RATIO,
    spec.stallTorqueNm * MAX_MOTOR_MODEL_RATIO,
  )
}

/** Electromagnetic braking torque while the motor is generating current. */
export function motorGeneratingTorqueNm(spec: MotorSpec, windingCurrentA: number) {
  const stallCurrentA = Math.max(0.01, spec.stallCurrentA ?? 1.5)
  const currentRatio = clamp(
    Math.abs(Number.isFinite(windingCurrentA) ? windingCurrentA : 0) / stallCurrentA,
    0,
    MAX_MOTOR_MODEL_RATIO,
  )
  return Math.max(0, spec.stallTorqueNm) * currentRatio
}

/**
 * Converts measured terminal voltage and winding current into a motor command.
 * Voltage above the rating can raise no-load speed above the nominal value;
 * current above the nominal stall current can briefly produce more torque but
 * is deliberately bounded to keep unstable or shorted circuits numerically safe.
 */
export function motorDriveCommandForVoltageRatio(
  spec: MotorSpec,
  terminalVoltageRatio: number,
  windingCurrentA: number,
): MotorDriveCommand {
  const voltageRatio = clamp(Math.abs(terminalVoltageRatio), 0, MAX_MOTOR_MODEL_RATIO)
  if (voltageRatio <= 0 || spec.nominalVoltageV <= 0) {
    return { targetOmega: 0, maxTorqueNm: 0 }
  }

  const stallCurrentA = Math.max(0.01, spec.stallCurrentA ?? 1.5)
  const noLoadCurrentA = clamp(spec.noLoadCurrentA ?? stallCurrentA * 0.08, 0, stallCurrentA * 0.9)
  const usefulCurrent = Math.max(0, Math.abs(Number.isFinite(windingCurrentA) ? windingCurrentA : 0) - noLoadCurrentA)
  const currentForUsefulStallTorque = Math.max(0.01, stallCurrentA - noLoadCurrentA)
  const torqueRatio = clamp(usefulCurrent / currentForUsefulStallTorque, 0, MAX_MOTOR_MODEL_RATIO)

  return {
    targetOmega: motorNoLoadAngularSpeed(spec) * voltageRatio,
    maxTorqueNm: Math.max(0, spec.stallTorqueNm) * torqueRatio,
  }
}
