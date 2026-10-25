/**
 * Small-circuit DC solver for the CRAFTEDUC electrical simulation.
 *
 * Uses modified nodal analysis (MNA): voltage sources have internal resistance,
 * wires and material paths are resistive, and LEDs use an iterative piecewise-
 * linear diode model. Each connected circuit is solved independently to keep
 * large voxel worlds inexpensive.
 */

export interface ElectricalResistor {
  id: string
  a: string
  b: string
  resistanceOhms: number
  /** Optional series drop oriented from a to b (e.g. motor back-EMF). */
  offsetVoltageVolts?: number
}

export interface ElectricalVoltageSource {
  id: string
  positive: string
  negative: string
  voltageVolts: number
  internalResistanceOhms: number
}

export interface ElectricalDiode {
  id: string
  anode: string
  cathode: string
  forwardVoltageVolts: number
  dynamicResistanceOhms: number
}

export interface DcCircuitInput {
  nodes?: string[]
  resistors: ElectricalResistor[]
  voltageSources: ElectricalVoltageSource[]
  diodes: ElectricalDiode[]
}

export interface DcCircuitSolution {
  nodeVoltages: Map<string, number>
  resistorCurrents: Map<string, number>
  diodeCurrents: Map<string, number>
  sourceCurrents: Map<string, number>
  converged: boolean
}

const MIN_RESISTANCE = 1e-6
const GMIN = 1e-9

function clampResistance(value: number) {
  return Number.isFinite(value) ? Math.max(MIN_RESISTANCE, value) : 1e12
}

function solveLinearSystem(matrix: number[][], rhs: number[]) {
  const n = rhs.length
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row
    }
    if (Math.abs(matrix[pivot][col]) < 1e-16) return null
    if (pivot !== col) {
      ;[matrix[pivot], matrix[col]] = [matrix[col], matrix[pivot]]
      ;[rhs[pivot], rhs[col]] = [rhs[col], rhs[pivot]]
    }
    const divisor = matrix[col][col]
    for (let j = col; j < n; j++) matrix[col][j] /= divisor
    rhs[col] /= divisor
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const factor = matrix[row][col]
      if (Math.abs(factor) < 1e-20) continue
      for (let j = col; j < n; j++) matrix[row][j] -= factor * matrix[col][j]
      rhs[row] -= factor * rhs[col]
    }
  }
  return rhs
}

export function solveDcCircuit(input: DcCircuitInput): DcCircuitSolution {
  const resistorList = input.resistors.filter((r) => r.a !== r.b && Number.isFinite(r.resistanceOhms))
  const sourceList = input.voltageSources.filter((s) =>
    s.positive !== s.negative && Number.isFinite(s.voltageVolts) && s.voltageVolts >= 0,
  ).map((s) => ({ ...s, internalResistanceOhms: clampResistance(s.internalResistanceOhms) }))
  const diodeList = input.diodes.filter((d) => d.anode !== d.cathode
    && Number.isFinite(d.forwardVoltageVolts) && Number.isFinite(d.dynamicResistanceOhms))

  const nodes = new Set(input.nodes ?? [])
  for (const r of resistorList) { nodes.add(r.a); nodes.add(r.b) }
  for (const d of diodeList) { nodes.add(d.anode); nodes.add(d.cathode) }
  const internalNode = (id: string) => `@source:${id}:positive`
  for (const s of sourceList) {
    nodes.add(s.positive); nodes.add(s.negative); nodes.add(internalNode(s.id))
  }

  const adjacency = new Map<string, Set<string>>()
  const connect = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set())
    if (!adjacency.has(b)) adjacency.set(b, new Set())
    adjacency.get(a)!.add(b)
    adjacency.get(b)!.add(a)
  }
  for (const r of resistorList) connect(r.a, r.b)
  for (const d of diodeList) connect(d.anode, d.cathode)
  for (const s of sourceList) {
    connect(s.positive, internalNode(s.id))
    connect(internalNode(s.id), s.negative)
  }

  const components: string[][] = []
  const visited = new Set<string>()
  for (const start of nodes) {
    if (visited.has(start)) continue
    const component: string[] = []
    const queue = [start]
    visited.add(start)
    while (queue.length) {
      const current = queue.pop()!
      component.push(current)
      for (const next of adjacency.get(current) ?? []) {
        if (visited.has(next)) continue
        visited.add(next)
        queue.push(next)
      }
    }
    components.push(component)
  }

  const diodeOn = new Map(diodeList.map((d) => [d.id, false]))
  let finalVoltages = new Map<string, number>()
  let converged = diodeList.length === 0

  const solveWithDiodeState = () => {
    const voltages = new Map<string, number>()
    for (const componentNodes of components) {
      const set = new Set(componentNodes)
      const componentResistors = resistorList.filter((r) => set.has(r.a) && set.has(r.b))
      const componentDiodes = diodeList.filter((d) => set.has(d.anode) && set.has(d.cathode))
      const componentSources = sourceList.filter((s) => set.has(s.positive) && set.has(s.negative))
      const reference = componentSources[0]?.negative ?? componentNodes[0]
      const unknownNodes = componentNodes.filter((n) => n !== reference)
      const index = new Map(unknownNodes.map((n, i) => [n, i]))
      const voltageBranches = componentSources.map((source) => ({
        source,
        positive: internalNode(source.id),
        negative: source.negative,
      }))
      const size = unknownNodes.length + voltageBranches.length
      if (size === 0) {
        voltages.set(reference, 0)
        continue
      }
      const matrix = Array.from({ length: size }, () => Array<number>(size).fill(0))
      const rhs = Array<number>(size).fill(0)
      const stampConductance = (a: string, b: string, conductance: number) => {
        const ia = index.get(a)
        const ib = index.get(b)
        if (ia !== undefined) matrix[ia][ia] += conductance
        if (ib !== undefined) matrix[ib][ib] += conductance
        if (ia !== undefined && ib !== undefined) {
          matrix[ia][ib] -= conductance
          matrix[ib][ia] -= conductance
        }
      }
      const stampCurrentOffset = (a: string, b: string, conductance: number, offset: number) => {
        const ia = index.get(a)
        const ib = index.get(b)
        if (ia !== undefined) rhs[ia] += conductance * offset
        if (ib !== undefined) rhs[ib] -= conductance * offset
      }

      // A tiny reference conductance removes the singular common-mode voltage
      // from floating subcircuits without meaningfully loading real circuits.
      for (const n of unknownNodes) matrix[index.get(n)!][index.get(n)!] += GMIN

      for (const r of componentResistors) {
        const resistance = clampResistance(r.resistanceOhms)
        const conductance = 1 / resistance
        const offset = Number.isFinite(r.offsetVoltageVolts) ? r.offsetVoltageVolts ?? 0 : 0
        stampConductance(r.a, r.b, conductance)
        if (offset !== 0) stampCurrentOffset(r.a, r.b, conductance, offset)
      }

      for (const d of componentDiodes) {
        if (!diodeOn.get(d.id)) continue
        const conductance = 1 / clampResistance(d.dynamicResistanceOhms)
        stampConductance(d.anode, d.cathode, conductance)
        stampCurrentOffset(d.anode, d.cathode, conductance, d.forwardVoltageVolts)
      }

      voltageBranches.forEach((branch, sourceIndex) => {
        const row = unknownNodes.length + sourceIndex
        const positiveIndex = index.get(branch.positive)
        const negativeIndex = index.get(branch.negative)
        if (positiveIndex !== undefined) {
          matrix[positiveIndex][row] += 1
          matrix[row][positiveIndex] += 1
        }
        if (negativeIndex !== undefined) {
          matrix[negativeIndex][row] -= 1
          matrix[row][negativeIndex] -= 1
        }
        rhs[row] = branch.source.voltageVolts
        // The source's internal resistance sits between its external positive
        // terminal and the ideal voltage-source positive node.
        stampConductance(
          branch.source.positive,
          branch.positive,
          1 / branch.source.internalResistanceOhms,
        )
      })

      const solved = solveLinearSystem(matrix, rhs)
      voltages.set(reference, 0)
      if (!solved) {
        for (const n of unknownNodes) voltages.set(n, 0)
        continue
      }
      unknownNodes.forEach((n, i) => voltages.set(n, solved[i]))
    }
    return voltages
  }

  for (let iteration = 0; iteration < 20; iteration++) {
    const voltages = solveWithDiodeState()
    let changed = false
    for (const diode of diodeList) {
      const difference = (voltages.get(diode.anode) ?? 0) - (voltages.get(diode.cathode) ?? 0)
      const wasOn = diodeOn.get(diode.id) ?? false
      const shouldBeOn = wasOn
        ? difference > diode.forwardVoltageVolts - 0.015
        : difference > diode.forwardVoltageVolts + 0.001
      if (shouldBeOn !== wasOn) {
        diodeOn.set(diode.id, shouldBeOn)
        changed = true
      }
    }
    finalVoltages = voltages
    if (!changed) { converged = true; break }
  }

  const voltage = (node: string) => finalVoltages.get(node) ?? 0
  const resistorCurrents = new Map<string, number>()
  for (const r of resistorList) {
    resistorCurrents.set(r.id, (voltage(r.a) - voltage(r.b) - (r.offsetVoltageVolts ?? 0)) / clampResistance(r.resistanceOhms))
  }
  const diodeCurrents = new Map<string, number>()
  for (const d of diodeList) {
    const current = diodeOn.get(d.id)
      ? (voltage(d.anode) - voltage(d.cathode) - d.forwardVoltageVolts) / clampResistance(d.dynamicResistanceOhms)
      : 0
    diodeCurrents.set(d.id, Math.max(0, current))
  }
  const sourceCurrents = new Map<string, number>()
  for (const s of sourceList) {
    const internal = voltage(internalNode(s.id))
    sourceCurrents.set(s.id, (internal - voltage(s.positive)) / s.internalResistanceOhms)
  }
  return { nodeVoltages: finalVoltages, resistorCurrents, diodeCurrents, sourceCurrents, converged }
}

/** Standard four-band resistor colour code. Multiplier is a power of ten. */
export const RESISTOR_DIGIT_COLORS = [
  '#171717', '#7b4428', '#d12c27', '#ee7d22', '#f2ca36',
  '#3d9b56', '#2864b8', '#864ca1', '#9299a3', '#f2f1e9',
] as const

export const RESISTOR_MULTIPLIER_COLORS: Readonly<Record<number, string>> = {
  [-2]: '#d9b44a', // gold, x0.01
  [-1]: '#b7bdc6', // silver, x0.1
  0: RESISTOR_DIGIT_COLORS[0],
  1: RESISTOR_DIGIT_COLORS[1],
  2: RESISTOR_DIGIT_COLORS[2],
  3: RESISTOR_DIGIT_COLORS[3],
  4: RESISTOR_DIGIT_COLORS[4],
  5: RESISTOR_DIGIT_COLORS[5],
  6: RESISTOR_DIGIT_COLORS[6],
  7: RESISTOR_DIGIT_COLORS[7],
  8: RESISTOR_DIGIT_COLORS[8],
  9: RESISTOR_DIGIT_COLORS[9],
}

export const RESISTOR_TOLERANCE_COLORS: Readonly<Record<number, string>> = {
  10: '#b7bdc6',
  5: '#d9b44a',
  2: '#d12c27',
  1: '#7b4428',
  0.5: '#3d9b56',
  0.25: '#2864b8',
  0.1: '#864ca1',
  0.05: '#9299a3',
}

export function resistorValueOhms(digit1 = 1, digit2 = 0, multiplier = 1) {
  const a = Math.max(0, Math.min(9, Math.floor(digit1)))
  const b = Math.max(0, Math.min(9, Math.floor(digit2)))
  const exponent = Math.max(-2, Math.min(9, Math.floor(multiplier)))
  return Math.max(0.01, (a * 10 + b) * Math.pow(10, exponent))
}
