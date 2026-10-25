import assert from 'node:assert/strict'
import { formatCurrentReading, formatVoltageReading, solveDcCircuit } from '../lib/game/electrical.ts'

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

console.log('Electrical solver regression checks passed (4 circuits).')
