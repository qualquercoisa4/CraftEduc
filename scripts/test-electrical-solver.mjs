import assert from 'node:assert/strict'
import { formatCurrentReading, formatVoltageReading, solveDcCircuit } from '../lib/game/electrical.ts'
import { classifyMotorPowerFlow, estimateMotorBackEmfVolts, MAX_MOTOR_MODEL_RATIO, motorDriveCommandForVoltageRatio } from '../lib/game/motor-model.ts'
import { getMotorSpec } from '../lib/game/motor-specs.ts'

const near = (actual, expected, tolerance, label) => {
  assert.ok(Number.isFinite(actual), `${label}: expected finite value, got ${actual}`)
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, got ${actual}`,
  )
}

// 3 alkaline cells in series: 4.5 V source, 0.45 Ω estimated pack resistance,
// and a 100 Ω load. Checks voltage units, load sag, and Ohm's law.
{
  const solution = solveDcCircuit({
    nodes: ['battery+', 'battery-'],
    resistors: [{ id: 'load', a: 'battery+', b: 'battery-', resistanceOhms: 100 }],
    voltageSources: [{
      id: 'three-cells', positive: 'battery+', negative: 'battery-',
      voltageVolts: 4.5, internalResistanceOhms: 0.45,
    }],
    diodes: [],
  })
  assert.equal(solution.converged, true, 'three-cell circuit should converge')
  const current = solution.resistorCurrents.get('load')
  const terminalVoltage = (solution.nodeVoltages.get('battery+') ?? NaN)
    - (solution.nodeVoltages.get('battery-') ?? NaN)
  near(current, 4.5 / (100 + 0.45), 1e-7, 'three-cell load current (A)')
  near(terminalVoltage, 4.5 * 100 / (100 + 0.45), 1e-6, 'three-cell loaded voltage (V)')
  assert.ok(terminalVoltage < 4.5, 'internal resistance must produce battery sag under load')
}

// At 5 V with 100 Ω load plus 0.5 Ω source resistance, current must obey
// I=V/(Rload+Rsource). This catches unit and sign regressions.
{
  const solution = solveDcCircuit({
    resistors: [{ id: 'load', a: 'out+', b: 'gnd', resistanceOhms: 100 }],
    voltageSources: [{
      id: 'source', positive: 'out+', negative: 'gnd',
      voltageVolts: 5, internalResistanceOhms: 0.5,
    }],
    diodes: [],
  })
  near(solution.resistorCurrents.get('load'), 5 / 100.5, 1e-7, '5 V load current (A)')
}

// A 3-cell alkaline pack driving the 3 V FA-130 starts above its rated
// stall current. Source resistance limits the current and makes terminal
// voltage sag; the motor model must not silently clamp the voltage to 3 V.
{
  const motor = getMotorSpec('fa130')
  const windingResistance = motor.nominalVoltageV / motor.stallCurrentA
  const solution = solveDcCircuit({
    resistors: [{ id: 'fa130-winding', a: 'pack+', b: 'pack-', resistanceOhms: windingResistance }],
    voltageSources: [{
      id: 'three-aaa-cells', positive: 'pack+', negative: 'pack-',
      voltageVolts: 4.5, internalResistanceOhms: 0.45,
    }],
    diodes: [],
  })
  const current = solution.resistorCurrents.get('fa130-winding') ?? NaN
  const motorVoltage = current * windingResistance
  near(current, 4.5 / (windingResistance + 0.45), 1e-7, 'FA-130 startup current from three cells')
  assert.ok(current > motor.stallCurrentA, '4.5 V may overcurrent a 3 V motor at startup')
  assert.ok(motorVoltage < 4.5, 'battery internal resistance must sag under motor load')
}

// An Arduino digital output is not a motor driver. The conservative output
// impedance keeps a small motor below its usable starting voltage.
{
  const motor = getMotorSpec('fa130')
  const windingResistance = motor.nominalVoltageV / motor.stallCurrentA
  const solution = solveDcCircuit({
    resistors: [
      { id: 'output-impedance', a: 'rail+', b: 'pin', resistanceOhms: 250 },
      { id: 'motor-winding', a: 'pin', b: 'gnd', resistanceOhms: windingResistance },
    ],
    voltageSources: [{
      id: 'arduino-rail', positive: 'rail+', negative: 'gnd',
      voltageVolts: 5, internalResistanceOhms: 0.1,
    }],
    diodes: [],
  })
  const current = solution.resistorCurrents.get('motor-winding') ?? NaN
  const motorVoltage = current * windingResistance
  assert.ok(current < 0.025, 'direct digital output current should remain near/below 20 mA')
  assert.ok(motorVoltage < 0.1, 'motor connected to a digital output should not receive a usable rail')
}

// The electrical motor model scales no-load speed with terminal voltage,
// supports back-EMF above nominal voltage, and derives useful torque from current.
{
  const motor = getMotorSpec('fa130')
  const nominalOmega = motor.noLoadRpm * Math.PI * 2 / 60
  const halfVoltage = motorDriveCommandForVoltageRatio(motor, 0.5, motor.noLoadCurrentA ?? 0)
  const overVoltage = motorDriveCommandForVoltageRatio(motor, 1.5, motor.stallCurrentA ?? 0)
  near(halfVoltage.targetOmega, nominalOmega * 0.5, 1e-8, 'half-voltage no-load speed')
  near(halfVoltage.maxTorqueNm, 0, 1e-8, 'no-load current should not create useful torque')
  near(overVoltage.targetOmega, nominalOmega * 1.5, 1e-8, 'over-voltage no-load speed')
  near(overVoltage.maxTorqueNm, motor.stallTorqueNm, 1e-8, 'stall current should produce rated stall torque')
  const windingResistance = motor.nominalVoltageV / (motor.stallCurrentA ?? 1.5)
  const backEmfAtNoLoadSpeed = motor.nominalVoltageV - (motor.noLoadCurrentA ?? 0) * windingResistance
  near(estimateMotorBackEmfVolts(motor, nominalOmega), backEmfAtNoLoadSpeed, 1e-8, 'nominal-speed back-EMF includes no-load current')
  near(estimateMotorBackEmfVolts(motor, -nominalOmega), -backEmfAtNoLoadSpeed, 1e-8, 'reverse back-EMF')
  near(estimateMotorBackEmfVolts(motor, nominalOmega * 1.5), backEmfAtNoLoadSpeed * 1.5, 1e-8, 'over-speed back-EMF')
  near(estimateMotorBackEmfVolts(motor, nominalOmega * 10), backEmfAtNoLoadSpeed * MAX_MOTOR_MODEL_RATIO, 1e-8, 'numerical back-EMF safety bound')
  assert.ok(overVoltage.maxTorqueNm <= motor.stallTorqueNm * MAX_MOTOR_MODEL_RATIO, 'overcurrent torque must remain bounded')
  assert.equal(classifyMotorPowerFlow(3, 0.18), 'motoring', 'positive terminal power drives the motor')
  assert.equal(classifyMotorPowerFlow(3, -0.18), 'generating', 'reverse current under positive voltage means generation')
  assert.equal(classifyMotorPowerFlow(-3, -0.18), 'motoring', 'reversed voltage and current still consume power')
  assert.equal(classifyMotorPowerFlow(3, 0), 'idle', 'open-circuit back-EMF must not become a drive command')
}

// A back-driven DC motor with a load must deliver current to the load and
// experience generating torque, rather than being commanded to accelerate itself.
{
  const motor = getMotorSpec('fa130')
  const windingResistance = motor.nominalVoltageV / (motor.stallCurrentA ?? 1.5)
  const nominalOmega = motor.noLoadRpm * Math.PI * 2 / 60
  const backEmf = estimateMotorBackEmfVolts(motor, nominalOmega)
  const solution = solveDcCircuit({
    nodes: ['motor+', 'motor-'],
    resistors: [
      { id: 'generator-winding', a: 'motor+', b: 'motor-', resistanceOhms: windingResistance, offsetVoltageVolts: backEmf },
      { id: 'generator-load', a: 'motor+', b: 'motor-', resistanceOhms: 10 },
    ],
    voltageSources: [],
    diodes: [],
  })
  const voltage = (solution.nodeVoltages.get('motor+') ?? 0) - (solution.nodeVoltages.get('motor-') ?? 0)
  const motorCurrent = solution.resistorCurrents.get('generator-winding') ?? NaN
  const loadCurrent = solution.resistorCurrents.get('generator-load') ?? NaN
  assert.ok(voltage > 0, 'back-EMF should create voltage across the load')
  assert.ok(motorCurrent < 0, 'generated current must flow opposite to motor-driving current')
  assert.ok(loadCurrent > 0, 'generated current must flow through the external load')
  assert.equal(classifyMotorPowerFlow(voltage, motorCurrent), 'generating', 'motor should be classified as generating')
}

// A spinning motor with an open circuit has back-EMF but essentially no current;
// terminal voltage alone must not be interpreted as electrical drive power.
{
  const motor = getMotorSpec('fa130')
  const windingResistance = motor.nominalVoltageV / (motor.stallCurrentA ?? 1.5)
  const nominalOmega = motor.noLoadRpm * Math.PI * 2 / 60
  const backEmf = estimateMotorBackEmfVolts(motor, nominalOmega)
  const solution = solveDcCircuit({
    nodes: ['open+', 'open-'],
    resistors: [{ id: 'open-motor-winding', a: 'open+', b: 'open-', resistanceOhms: windingResistance, offsetVoltageVolts: backEmf }],
    voltageSources: [],
    diodes: [],
  })
  const voltage = (solution.nodeVoltages.get('open+') ?? 0) - (solution.nodeVoltages.get('open-') ?? 0)
  const current = solution.resistorCurrents.get('open-motor-winding') ?? NaN
  assert.ok(Math.abs(voltage) > 1, 'spinning open-circuit motor should show back-EMF')
  assert.ok(Math.abs(current) < 1e-6, 'open-circuit motor current should be essentially zero')
  assert.equal(classifyMotorPowerFlow(voltage, current), 'idle', 'back-EMF with no current is not drive power')
}

// Unit formatting is shared by the simulation and multimeter; a 4.5 V source
// must display as volts, not as 4500 volts or as 4500 millivolts without a unit.
{
  assert.equal(formatVoltageReading(4.5), '4.500 V', '4.5 volts display in volts')
  assert.equal(formatVoltageReading(0.45), '450.0 mV', 'sub-volt readings display in millivolts')
  assert.equal(formatCurrentReading(0.45), '450.0 mA', 'sub-amp readings display in milliamperes')
  assert.equal(formatCurrentReading(4.5), '4.500 A', 'amp readings display in amperes')
}

// An unconnected circuit gets its own arbitrary voltage reference. A meter must
// not treat it as being on the same reference as an unrelated floating circuit.
{
  const solution = solveDcCircuit({
    resistors: [
      { id: 'left', a: 'left-a', b: 'left-b', resistanceOhms: 100 },
      { id: 'right', a: 'right-a', b: 'right-b', resistanceOhms: 100 },
    ],
    voltageSources: [],
    diodes: [],
  })
  assert.notEqual(
    solution.nodeComponentIds.get('left-a'),
    solution.nodeComponentIds.get('right-a'),
    'independent floating circuits must have different reference identities',
  )
}

// Forward-oriented LED/diode with a series resistor should conduct and converge.
{
  const solution = solveDcCircuit({
    resistors: [{ id: 'limiter', a: 'supply+', b: 'led-a', resistanceOhms: 100 }],
    voltageSources: [{
      id: 'source', positive: 'supply+', negative: 'gnd',
      voltageVolts: 3, internalResistanceOhms: 0.1,
    }],
    diodes: [{
      id: 'led', anode: 'led-a', cathode: 'gnd',
      forwardVoltageVolts: 2, dynamicResistanceOhms: 8,
    }],
  })
  assert.equal(solution.converged, true, 'forward LED circuit should converge')
  assert.ok((solution.diodeCurrents.get('led') ?? 0) > 0.005, 'forward LED current should be positive')
}

// A large unpowered conductive structure must not allocate a dense matrix.
// This models the metallic walls/roof that previously froze the test laboratory.
{
  const count = 1600
  const nodes = Array.from({ length: count }, (_, i) => `passive-${i}`)
  const resistors = Array.from({ length: count - 1 }, (_, i) => ({
    id: `passive-link-${i}`, a: nodes[i], b: nodes[i + 1], resistanceOhms: 0.05,
  }))
  const started = performance.now()
  const solution = solveDcCircuit({ nodes, resistors, voltageSources: [], diodes: [] })
  assert.equal(solution.converged, true, 'large passive structure should return a valid zero-volt solution')
  assert.equal(solution.nodeVoltages.get(nodes[0]), 0, 'large passive structure should resolve without a matrix')
  assert.ok(performance.now() - started < 1500, 'large passive structure must not stall the solver')
}

// A source-driven component beyond the dense-solver safety limit must fail
// closed quickly instead of attempting an unbounded cubic-time matrix solve.
{
  const count = 300
  const nodes = Array.from({ length: count }, (_, i) => `driven-${i}`)
  const resistors = Array.from({ length: count - 1 }, (_, i) => ({
    id: `driven-link-${i}`, a: nodes[i], b: nodes[i + 1], resistanceOhms: 10,
  }))
  const solution = solveDcCircuit({
    nodes,
    resistors,
    voltageSources: [{
      id: 'large-network-source', positive: nodes[0], negative: nodes[count - 1],
      voltageVolts: 5, internalResistanceOhms: 0.5,
    }],
    diodes: [],
  })
  assert.equal(solution.converged, false, 'oversized source-driven component should fail safe')
  assert.equal(solution.nodeVoltages.get(nodes[0]), 0, 'oversized component should not return invented voltages')
}

console.log('Electrical and motor-model regression checks passed (10 circuits plus motor checks).')
