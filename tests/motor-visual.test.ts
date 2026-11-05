import assert from 'node:assert/strict'
import { advanceMotorVisualAngle, MAX_MOTOR_VISUAL_ANGULAR_SPEED } from '../lib/game/motor-model'

const near = (actual: number, expected: number, tolerance = 1e-9) => {
  assert.ok(Number.isFinite(actual), `expected finite angle, received ${actual}`)
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, received ${actual}`)
}

near(advanceMotorVisualAngle(0, 12000, 0.05), MAX_MOTOR_VISUAL_ANGULAR_SPEED * 0.05)
near(advanceMotorVisualAngle(2, -12000, 0.05), 2 - MAX_MOTOR_VISUAL_ANGULAR_SPEED * 0.05)
near(advanceMotorVisualAngle(1, 10, 0.05), 1.5)
near(advanceMotorVisualAngle(Number.NaN, Number.NaN, 0.05), 0)
near(advanceMotorVisualAngle(0, 20, Number.NaN), 0)
console.log('PASS: motor display speed is bounded without changing the electrical motor-speed model')

import { getMotorSpec } from '../lib/game/motor-specs'
import { motorDriveCommandForVoltageRatio, motorTorqueFromCurrent } from '../lib/game/motor-model'

// A missing motorType in an old world/save must behave exactly like the
// explicit catalog default, rather than entering a legacy speed/torque path.
const implicitDefault = getMotorSpec(undefined)
const explicitDefault = getMotorSpec('fa130')
assert.equal(implicitDefault.id, explicitDefault.id)
const implicitDrive = motorDriveCommandForVoltageRatio(implicitDefault, 1, 0.65)
const explicitDrive = motorDriveCommandForVoltageRatio(explicitDefault, 1, 0.65)
near(implicitDrive.targetOmega, explicitDrive.targetOmega)
near(implicitDrive.maxTorqueNm, explicitDrive.maxTorqueNm)
near(
  motorTorqueFromCurrent(implicitDefault, 0.65, 20),
  motorTorqueFromCurrent(explicitDefault, 0.65, 20),
)
