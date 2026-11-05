import assert from 'node:assert/strict'
import { calculateGearPair, drivenGearAngle, normalizeGearTeeth, outputGearSpeed, outputGearTorque } from '../lib/game/gear-train'

const near=(actual:number,expected:number,tolerance=1e-9)=>{
  assert.ok(Number.isFinite(actual),`expected finite number, received ${actual}`)
  assert.ok(Math.abs(actual-expected)<=tolerance,`expected ${expected}, received ${actual}`)
}
assert.equal(normalizeGearTeeth(24.4),24)
assert.equal(normalizeGearTeeth(1000),48)
assert.equal(normalizeGearTeeth(Number.NaN),24)

const equalPair=calculateGearPair({teethA:24,teethB:24,centerDistance:1,axisAlignment:1,axialOffset:0})
assert.ok(equalPair,'equal gears with aligned shafts must mesh')
near(equalPair.ratio,1)
near(outputGearSpeed(10,equalPair),-10)
near(outputGearTorque(0.2,equalPair),0.2*0.96)

const reduction=calculateGearPair({teethA:12,teethB:36,centerDistance:1,axisAlignment:-1,axialOffset:0})
assert.ok(reduction,'a 12:36 pair must resolve')
near(reduction.ratio,3)
near(outputGearSpeed(12,reduction),-4)
near(outputGearTorque(0.1,reduction),0.288)
near(drivenGearAngle(Math.PI*2,12,36),-Math.PI*2/3)

assert.equal(calculateGearPair({teethA:24,teethB:24,centerDistance:1,axisAlignment:0.8,axialOffset:0}),null)
assert.equal(calculateGearPair({teethA:24,teethB:24,centerDistance:1,axisAlignment:1,axialOffset:0.1}),null)
assert.equal(calculateGearPair({teethA:12,teethB:36,centerDistance:1,axisAlignment:1,axialOffset:0,moduleA:2/48,moduleB:2/50}),null)
assert.equal(calculateGearPair({teethA:24,teethB:24,centerDistance:Number.POSITIVE_INFINITY,axisAlignment:1,axialOffset:0}),null)
console.log('PASS: gear tooth validation, module compatibility, speed/torque ratios, direction reversal, and invalid-mesh rejection')

import { propagateGearTrainAngles } from '../lib/game/gear-train'

// A three-gear train must propagate through each pair independently. The
// middle gear can drive a third gear even when the pair modules differ.
const threeGearTrain = propagateGearTrainAngles(
  new Map([['motor', Math.PI * 2]]),
  [
    { a: 'motor', b: 'middle', teethA: 24, teethB: 36 },
    { a: 'middle', b: 'left', teethA: 36, teethB: 12 },
  ],
)
assert.equal(threeGearTrain.conflicts.size, 0)
near(threeGearTrain.angles.get('middle')!, -Math.PI * 2 * 24 / 36)
near(threeGearTrain.angles.get('left')!, Math.PI * 2 * 2)
