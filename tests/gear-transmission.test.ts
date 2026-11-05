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

const branched = propagateGearTrainAngles(
  new Map([['center', 0.75]]),
  [
    { a: 'center', b: 'left', teethA: 24, teethB: 12 },
    { a: 'center', b: 'right', teethA: 24, teethB: 48 },
  ],
)
assert.equal(branched.conflicts.size, 0, 'a gear may drive two opposite-side gears simultaneously')
near(branched.angles.get('left')!, -1.5)
near(branched.angles.get('right')!, -0.375)

// Four external meshes form a compatible even loop; an odd three-mesh loop
// cannot satisfy all external-gear direction constraints simultaneously.
const evenLoop = propagateGearTrainAngles(new Map([['a', 1]]), [
  { a: 'a', b: 'b', teethA: 24, teethB: 24 },
  { a: 'b', b: 'c', teethA: 24, teethB: 24 },
  { a: 'c', b: 'd', teethA: 24, teethB: 24 },
  { a: 'd', b: 'a', teethA: 24, teethB: 24 },
]))
assert.equal(evenLoop.conflicts.size, 0, 'four-gear closed loop should remain kinematically compatible')
const oddLoop = propagateGearTrainAngles(new Map([['a', 1]]), [
  { a: 'a', b: 'b', teethA: 24, teethB: 24 },
  { a: 'b', b: 'c', teethA: 24, teethB: 24 },
  { a: 'c', b: 'a', teethA: 24, teethB: 24 },
]))
assert.ok(oddLoop.conflicts.size >= 2, 'three external gears in a closed loop must be reported as locked/conflicting')

// Two motors on one train are valid only when their commanded phases agree.
const sameMotors = propagateGearTrainAngles(new Map([['a', 1], ['c', 1]]), [
  { a: 'a', b: 'b', teethA: 24, teethB: 24 },
  { a: 'b', b: 'c', teethA: 24, teethB: 24 },
])
assert.equal(sameMotors.conflicts.size, 0)
const opposedMotors = propagateGearTrainAngles(new Map([['a', 1], ['c', -1]]), [
  { a: 'a', b: 'b', teethA: 24, teethB: 24 },
  { a: 'b', b: 'c', teethA: 24, teethB: 24 },
])
assert.ok(opposedMotors.conflicts.size > 0, 'motors fighting through a gear train must be detected')
console.log('PASS: branched gears, compatible/incompatible closed loops, and multiple motor source checks')

import { estimateGearAssemblyInertia, solveGearMeshImpulse } from '../lib/game/gear-physics'

const coupled = solveGearMeshImpulse({
  speedA: 10, speedB: 0, inertiaA: 1, inertiaB: 2,
  teethA: 24, teethB: 48, axisAlignment: 1,
})
assert.ok(coupled, 'valid gear bodies must resolve a finite mesh impulse')
near(coupled.nextSpeedB, -coupled.nextSpeedA * 24 / 48)
const energyBefore = 0.5 * 1 * 10 ** 2
const energyAfter = 0.5 * 1 * coupled.nextSpeedA ** 2 + 0.5 * 2 * coupled.nextSpeedB ** 2
assert.ok(energyAfter <= energyBefore + 1e-8, 'gear mesh impulse must not create kinetic energy')
assert.ok(Math.abs(coupled.constraintErrorAfter) < 1e-8, 'mesh impulse must satisfy the speed ratio')
assert.equal(solveGearMeshImpulse({
  speedA: 1, speedB: 1, inertiaA: 0, inertiaB: 1,
  teethA: 24, teethB: 24, axisAlignment: 1,
}), null, 'zero-inertia rotors must be rejected')
const bareGearInertia = estimateGearAssemblyInertia(0.42, [])
const loadedGearInertia = estimateGearAssemblyInertia(0.42, [1.2, 2.6])
assert.ok(loadedGearInertia > bareGearInertia, 'axially mounted blocks must increase rotor inertia')
console.log('PASS: gear mesh impulse conserves/bounds energy, obeys ratio, rejects invalid inertia, and accounts for attached mass')
