import assert from 'node:assert/strict'
import * as THREE from 'three'
import {
  ARDUINO_UNO_TERMINAL_IDS,
  B,
  blockBounds,
  isModelBlock,
  isOpaque,
} from '../lib/game/constants'
import { Mechanics, type Wire } from '../lib/game/mechanics'

assert.equal(ARDUINO_UNO_TERMINAL_IDS.length, 18, '14 digital terminals plus 5V, two GNDs and VIN')
assert.equal(new Set(ARDUINO_UNO_TERMINAL_IDS).size, ARDUINO_UNO_TERMINAL_IDS.length, 'terminal IDs must be unique')
for (let pin = 0; pin <= 13; pin++) {
  assert.ok(ARDUINO_UNO_TERMINAL_IDS.includes(('D' + pin) as (typeof ARDUINO_UNO_TERMINAL_IDS)[number]))
}
assert.ok(ARDUINO_UNO_TERMINAL_IDS.includes('5V'))
assert.ok(ARDUINO_UNO_TERMINAL_IDS.includes('GND'))
assert.ok(ARDUINO_UNO_TERMINAL_IDS.includes('GND_2'))
assert.ok(ARDUINO_UNO_TERMINAL_IDS.includes('VIN'))
assert.equal(isModelBlock(B.ARDUINO_UNO), true, 'the board should use its custom model')
assert.equal(isOpaque(B.ARDUINO_UNO), false, 'the model should not be hidden by a generic voxel')
assert.ok(blockBounds(B.ARDUINO_UNO)[4] < 0.5, 'the board should have a thin selection bounds')

const boardKey = '3,4,2'
const servoKey = '4,4,2'
const batteryKey = '5,4,2'
const fakeWire = (id: number, a: string, b: string, ta: string, tb: string): Wire => ({
  id,
  a,
  b,
  ta,
  tb,
  pa: new THREE.Vector3(),
  pb: new THREE.Vector3(),
  mesh: new THREE.Group(),
  color: '#fdd835',
})
const mechanics = Object.create(Mechanics.prototype) as Mechanics
mechanics.wires = [
  fakeWire(1, boardKey, servoKey, 'D7', 'signal'),
  fakeWire(2, batteryKey, boardKey, '+', '5V'),
]
const d7 = mechanics.getTerminalConnections(boardKey, 'D7')
assert.equal(d7.length, 1, 'D7 should report only its own wire')
assert.deepEqual(
  { key: d7[0].componentKey, terminal: d7[0].componentTerminal },
  { key: servoKey, terminal: 'signal' },
)
const fiveVolt = mechanics.getTerminalConnections(boardKey, '5V')
assert.equal(fiveVolt.length, 1, '5V should be independent from data pins')
assert.deepEqual(
  { key: fiveVolt[0].componentKey, terminal: fiveVolt[0].componentTerminal },
  { key: batteryKey, terminal: '+' },
)
assert.equal(mechanics.getTerminalConnections(boardKey, 'D8').length, 0, 'D8 must not inherit the D7 wire')

console.log('Arduino UNO terminal tests passed')
