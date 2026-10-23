'use client'

import { useEffect, useRef, useState } from 'react'
import { getEngine } from '@/lib/game/engine'
import { gameStore, useGame } from '@/lib/game/store'

type BlockLike = {
  type: string
  getFieldValue(name: string): string
  getInputTargetBlock(name: string): BlockLike | null
  getNextBlock(): BlockLike | null
  inputList?: Array<{ name: string }>
}

type PinMode = 'OUTPUT' | 'SERVO' | 'ULTRASONIC'

let customBlocksRegistered = false

type ActiveArduinoProgram = {
  active: boolean
  stop: () => void
}

const activeArduinoPrograms = new Map<string, ActiveArduinoProgram>()

const pins: Array<[string, string]> = Array.from({ length: 14 }, (_, index) => [`D${index}`, `D${index}`])

const blockDefinitions = [
  {
    type: 'arduino_when_start',
    message0: 'quando iniciar',
    nextStatement: null,
    hat: 'cap',
    colour: 45,
    tooltip: 'Executa os blocos abaixo quando você pressionar Executar.',
  },
  {
    type: 'arduino_forever',
    message0: 'sempre',
    message1: 'fazer %1',
    args1: [{ type: 'input_statement', name: 'DO' }],
    previousStatement: null,
    colour: 120,
    tooltip: 'Repete os blocos internos até você parar o programa.',
  },
  {
    type: 'arduino_set_pin_mode',
    message0: 'definir pino %1 como %2',
    args0: [
      { type: 'field_dropdown', name: 'PIN', options: pins },
      {
        type: 'field_dropdown',
        name: 'MODE',
        options: [
          ['saída digital', 'OUTPUT'],
          ['servo', 'SERVO'],
          ['sensor ultrassônico', 'ULTRASONIC'],
        ],
      },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 205,
    tooltip: 'Define como o programa vai usar o pino digital escolhido.',
  },
  {
    type: 'arduino_digital_write',
    message0: 'definir pino %1 como %2',
    args0: [
      { type: 'field_dropdown', name: 'PIN', options: pins },
      {
        type: 'field_dropdown',
        name: 'LEVEL',
        options: [['HIGH (ligado)', 'HIGH'], ['LOW (desligado)', 'LOW']],
      },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 205,
    tooltip: 'Escreve HIGH ou LOW em uma saída digital.',
  },
  {
    type: 'arduino_delay',
    message0: 'esperar %1 %2',
    args0: [
      { type: 'field_number', name: 'TIME', value: 100, min: 0, max: 3600 },
      {
        type: 'field_dropdown',
        name: 'UNIT',
        options: [
          ['milissegundos', 'MS'],
          ['décimos de segundo', 'DECI'],
          ['segundos', 'SEC'],
        ],
      },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 120,
    tooltip: 'Pausa a execução pelo tempo definido.',
  },
  {
    type: 'arduino_servo_write',
    message0: 'girar servo no pino %1 para %2 graus',
    args0: [
      { type: 'field_dropdown', name: 'PIN', options: pins },
      { type: 'field_number', name: 'ANGLE', value: 90, min: 1, max: 180, precision: 1 },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 15,
    tooltip: 'Move o servo ligado ao pino selecionado para um ângulo de 1° a 180°.',
  },
  {
    type: 'arduino_distance',
    message0: 'distância até objeto no sensor do pino %1',
    args0: [{ type: 'field_dropdown', name: 'PIN', options: pins }],
    output: 'Number',
    colour: 195,
    tooltip: 'Retorna a distância em blocos do sensor de proximidade conectado ao pino configurado como sensor ultrassônico.',
  },
  {
    type: 'arduino_if',
    message0: 'se %1 então',
    args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }],
    message1: 'fazer %1',
    args1: [{ type: 'input_statement', name: 'DO' }],
    previousStatement: null,
    nextStatement: null,
    colour: 120,
    tooltip: 'Executa os blocos internos apenas quando a condição for verdadeira.',
  },
  {
    type: 'arduino_if_else',
    message0: 'se %1 então',
    args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }],
    message1: 'fazer %1',
    args1: [{ type: 'input_statement', name: 'DO' }],
    message2: 'senão fazer %1',
    args2: [{ type: 'input_statement', name: 'ELSE' }],
    previousStatement: null,
    nextStatement: null,
    colour: 120,
    tooltip: 'Escolhe entre os blocos do “se” e os blocos do “senão”.',
  },
  {
    type: 'arduino_stop',
    message0: 'parar programa',
    previousStatement: null,
    colour: 0,
    tooltip: 'Interrompe todas as sequências em execução.',
  },
]

function asBlock(block: unknown): BlockLike | null {
  return block as BlockLike | null
}

function finiteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function ArduinoProgramming() {
  const key = useGame((state) => state.arduinoProgramKey)
  const workspaceHost = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<{ dispose(): void; getTopBlocks(ordered?: boolean): unknown[]; addChangeListener(listener: (event: { isUiEvent?: boolean }) => void): void; removeChangeListener(listener: (event: { isUiEvent?: boolean }) => void): void; } | null>(null)
  const resizeWorkspaceRef = useRef<(() => void) | null>(null)
  const runIdRef = useRef(0)
  const pinModesRef = useRef(new Map<string, PinMode>())
  const [ready, setReady] = useState(false)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('Arraste os blocos para montar seu programa.')

  useEffect(() => {
    let disposed = false
    let localWorkspace: typeof workspaceRef.current = null
    let changeListener: ((event: { isUiEvent?: boolean }) => void) | null = null

    const initialize = async () => {
      if (!workspaceHost.current) return
      try {
        const Blockly = await import('blockly/core')
        await import('blockly/blocks')
        const ptBr = await import('blockly/msg/pt-br')
        if (disposed || !workspaceHost.current) return

        Blockly.setLocale(ptBr)
        if (!customBlocksRegistered) {
          Blockly.common.defineBlocksWithJsonArray(blockDefinitions as Parameters<typeof Blockly.common.defineBlocksWithJsonArray>[0])
          customBlocksRegistered = true
        }

        const toolbox = {
          kind: 'categoryToolbox',
          contents: [
            {
              kind: 'category', name: 'Eventos', colour: '#f0b429',
              contents: [{ kind: 'block', type: 'arduino_when_start' }],
            },
            {
              kind: 'category', name: 'Controle', colour: '#55a630',
              contents: [
                { kind: 'block', type: 'arduino_forever' },
                { kind: 'block', type: 'arduino_if' },
                { kind: 'block', type: 'arduino_if_else' },
                { kind: 'block', type: 'controls_repeat_ext' },
                { kind: 'block', type: 'controls_whileUntil' },
                { kind: 'block', type: 'arduino_delay' },
                { kind: 'block', type: 'arduino_stop' },
              ],
            },
            {
              kind: 'category', name: 'Pinos digitais', colour: '#3282d8',
              contents: [
                { kind: 'block', type: 'arduino_set_pin_mode' },
                { kind: 'block', type: 'arduino_digital_write' },
              ],
            },
            {
              kind: 'category', name: 'Servo motor', colour: '#e58b29',
              contents: [{ kind: 'block', type: 'arduino_servo_write' }],
            },
            {
              kind: 'category', name: 'Sensores', colour: '#269ca8',
              contents: [{ kind: 'block', type: 'arduino_distance' }],
            },
            {
              kind: 'category', name: 'Lógica', colour: '#5b80a5',
              contents: [
                { kind: 'block', type: 'logic_compare' },
                { kind: 'block', type: 'logic_operation' },
                { kind: 'block', type: 'logic_negate' },
                { kind: 'block', type: 'logic_boolean' },
              ],
            },
            {
              kind: 'category', name: 'Matemática', colour: '#5c68a6',
              contents: [
                { kind: 'block', type: 'math_number' },
                { kind: 'block', type: 'math_arithmetic' },
              ],
            },
          ],
        }

        const workspace = Blockly.inject(workspaceHost.current, {
          toolbox: toolbox as never,
          renderer: 'geras',
          trashcan: true,
          sounds: false,
          zoom: {
            controls: true,
            wheel: true,
            startScale: 0.78,
            maxScale: 1.45,
            minScale: 0.45,
            scaleSpeed: 1.1,
          },
          move: {
            scrollbars: true,
            drag: true,
            wheel: true,
          },
          grid: {
            spacing: 24,
            length: 3,
            colour: '#dedede',
            snap: true,
          },
        })
        localWorkspace = workspace as unknown as typeof workspaceRef.current
        workspaceRef.current = localWorkspace
        resizeWorkspaceRef.current = () => Blockly.svgResize(workspace)

        const storageKey = `crafteduc:arduino-program:${key ?? 'unknown'}`
        let loaded = false
        try {
          const saved = window.localStorage.getItem(storageKey)
          if (saved) {
            Blockly.serialization.workspaces.load(JSON.parse(saved), workspace)
            loaded = true
          }
        } catch {
          window.localStorage.removeItem(storageKey)
        }
        if (!loaded) {
          const start = workspace.newBlock('arduino_when_start')
          start.initSvg()
          start.render()
          start.moveBy(24, 24)
          try {
            window.localStorage.setItem(storageKey, JSON.stringify(Blockly.serialization.workspaces.save(workspace)))
          } catch {
            // The workspace still works if browser storage is unavailable.
          }
        }

        changeListener = (event) => {
          if (event.isUiEvent) return
          try {
            window.localStorage.setItem(storageKey, JSON.stringify(Blockly.serialization.workspaces.save(workspace)))
          } catch {
            setStatus('O navegador não permitiu salvar este programa localmente.')
          }
        }
        workspace.addChangeListener(changeListener)
        Blockly.svgResize(workspace)
        setReady(true)
        setStatus(loaded ? 'Programa carregado deste navegador.' : 'Monte os blocos e pressione Executar.')
      } catch (error) {
        console.error('Falha ao iniciar Blockly:', error)
        setStatus('Não foi possível carregar o editor de blocos. Recarregue a página e tente novamente.')
      }
    }

    void initialize()
    const onResize = () => resizeWorkspaceRef.current?.()
    window.addEventListener('resize', onResize)

    return () => {
      disposed = true
      window.removeEventListener('resize', onResize)
      // Closing the tablet must not stop the sketch: Arduino programs keep
      // running in the simulated world until the user presses Stop.
      if (changeListener && localWorkspace) localWorkspace.removeChangeListener(changeListener)
      localWorkspace?.dispose()
      workspaceRef.current = null
      resizeWorkspaceRef.current = null
      setReady(false)
      setRunning(false)
    }
  }, [key])

  const stopProgram = (announce = true) => {
    runIdRef.current += 1
    if (key) {
      const activeProgram = activeArduinoPrograms.get(key)
      if (activeProgram) {
        activeProgram.active = false
        activeArduinoPrograms.delete(key)
      }
      getEngine()?.mech.clearArduinoProgram(key)
    }
    pinModesRef.current.clear()
    setRunning(false)
    if (announce) setStatus('Programa parado. As saídas controladas pelo programa foram desligadas.')
  }

  const readDistance = (pin: string) => {
    if (!key || pinModesRef.current.get(pin) !== 'ULTRASONIC') return null
    return getEngine()?.mech.readArduinoDistance(key, pin) ?? null
  }

  const readExpression = (block: BlockLike | null): number | boolean => {
    if (!block) return 0
    const value = (name: string) => readExpression(asBlock(block.getInputTargetBlock(name)))
    switch (block.type) {
      case 'math_number':
        return finiteNumber(block.getFieldValue('NUM'))
      case 'logic_boolean':
        return block.getFieldValue('BOOL') === 'TRUE'
      case 'logic_compare': {
        const a = Number(value('A'))
        const b = Number(value('B'))
        switch (block.getFieldValue('OP')) {
          case 'EQ': return a === b
          case 'NEQ': return a !== b
          case 'LT': return a < b
          case 'LTE': return a <= b
          case 'GT': return a > b
          case 'GTE': return a >= b
          default: return false
        }
      }
      case 'logic_operation': {
        const a = Boolean(value('A'))
        const b = Boolean(value('B'))
        return block.getFieldValue('OP') === 'AND' ? a && b : a || b
      }
      case 'logic_negate':
        return !Boolean(value('BOOL'))
      case 'math_arithmetic': {
        const a = Number(value('A'))
        const b = Number(value('B'))
        switch (block.getFieldValue('OP')) {
          case 'ADD': return a + b
          case 'MINUS': return a - b
          case 'MULTIPLY': return a * b
          case 'DIVIDE': return b === 0 ? 0 : a / b
          case 'POWER': return Math.pow(a, b)
          default: return 0
        }
      }
      case 'arduino_distance': {
        const pin = block.getFieldValue('PIN')
        const distance = readDistance(pin)
        if (distance === null) {
          setStatus(`Configure o pino ${pin} como sensor ultrassônico e conecte o terminal de sinal do sensor.`)
          return 0
        }
        return distance
      }
      default:
        return 0
    }
  }

  const executeProgram = async () => {
    const workspace = workspaceRef.current as unknown as {
      getTopBlocks(ordered?: boolean): unknown[]
    } | null
    if (!workspace || !key) return
    const starts = workspace.getTopBlocks(true).map(asBlock).filter((block): block is BlockLike => Boolean(block && block.type === 'arduino_when_start'))
    if (starts.length === 0) {
      setStatus('Adicione o bloco “quando iniciar” antes de executar.')
      return
    }

    stopProgram(false)
    const runId = runIdRef.current
    pinModesRef.current.clear()
    setRunning(true)
    setStatus('Programa em execução…')

    const run: ActiveArduinoProgram = {
      active: true,
      stop: () => {
        run.active = false
        if (activeArduinoPrograms.get(key) === run) activeArduinoPrograms.delete(key)
        getEngine()?.mech.clearArduinoProgram(key)
      },
    }
    activeArduinoPrograms.set(key, run)
    const active = () => run.active && activeArduinoPrograms.get(key) === run && runIdRef.current === runId
    const wait = async (ms: number) => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, Math.max(0, Math.min(60000, ms))))
    }
    let statement: (block: BlockLike) => Promise<void>
    const sequence = async (first: BlockLike | null): Promise<void> => {
      let block = first
      let steps = 0
      while (block && active()) {
        await statement(block)
        block = asBlock(block.getNextBlock())
        steps += 1
        if (steps % 6 === 0) await wait(0)
      }
    }
    statement = async (block: BlockLike): Promise<void> => {
      if (!active()) return
      const input = (name: string) => asBlock(block.getInputTargetBlock(name))
      switch (block.type) {
        case 'arduino_set_pin_mode': {
          const pin = block.getFieldValue('PIN')
          const mode = block.getFieldValue('MODE') as PinMode
          pinModesRef.current.set(pin, mode)
          if (mode === 'SERVO') {
            const count = getEngine()?.mech.countArduinoServoConnections(key, pin) ?? 0
            if (!count) setStatus(`Aviso: nenhum servo está conectado ao pino ${pin}.`)
          } else if (mode === 'ULTRASONIC') {
            const distance = getEngine()?.mech.readArduinoDistance(key, pin)
            if (distance === null || distance === undefined)
              setStatus(`Aviso: nenhum sensor de proximidade está conectado ao pino ${pin}.`)
          }
          break
        }
        case 'arduino_digital_write': {
          const pin = block.getFieldValue('PIN')
          if (pinModesRef.current.get(pin) !== 'OUTPUT') {
            setStatus(`Configure o pino ${pin} como saída digital antes de usar HIGH/LOW.`)
            break
          }
          const high = block.getFieldValue('LEVEL') === 'HIGH'
          if (!getEngine()?.mech.setArduinoPinLevel(key, pin, high))
            setStatus(`Não foi possível escrever no pino ${pin}.`)
          break
        }
        case 'arduino_servo_write': {
          const pin = block.getFieldValue('PIN')
          if (pinModesRef.current.get(pin) !== 'SERVO') {
            setStatus(`Configure o pino ${pin} como servo antes de comandar o ângulo.`)
            break
          }
          const angle = Math.max(1, Math.min(180, Math.round(finiteNumber(block.getFieldValue('ANGLE'), 90))))
          const count = getEngine()?.mech.setArduinoServoAngle(key, pin, angle) ?? 0
          if (!count) setStatus(`Nenhum servo conectado ao pino ${pin} (o fio deve chegar ao terminal de sinal).`)
          else setStatus(`Servo no pino ${pin}: ${angle}°.`)
          break
        }
        case 'arduino_delay': {
          const amount = Math.max(0, finiteNumber(block.getFieldValue('TIME'), 100))
          const multiplier = block.getFieldValue('UNIT') === 'SEC' ? 1000 : block.getFieldValue('UNIT') === 'DECI' ? 100 : 1
          await wait(amount * multiplier)
          break
        }
        case 'arduino_forever':
          while (active()) {
            await sequence(input('DO'))
            await wait(20)
          }
          break
        case 'arduino_if':
          if (Boolean(readExpression(input('CONDITION')))) await sequence(input('DO'))
          break
        case 'arduino_if_else':
          await sequence(Boolean(readExpression(input('CONDITION'))) ? input('DO') : input('ELSE'))
          break
        case 'controls_if': {
          const names = (block.inputList ?? []).map((item) => item.name).filter((name) => /^IF\d+$/.test(name))
          let matched = false
          for (const name of names.sort()) {
            const suffix = name.slice(2)
            if (Boolean(readExpression(input(name)))) {
              await sequence(input(`DO${suffix}`))
              matched = true
              break
            }
          }
          if (!matched) await sequence(input('ELSE'))
          break
        }
        case 'controls_repeat_ext': {
          const times = Math.max(0, Math.min(10000, Math.floor(Number(readExpression(input('TIMES'))))))
          for (let i = 0; i < times && active(); i++) {
            await sequence(input('DO'))
            if (i % 10 === 0) await wait(0)
          }
          break
        }
        case 'controls_whileUntil': {
          const until = block.getFieldValue('MODE') === 'UNTIL'
          let iterations = 0
          while (active() && Boolean(readExpression(input('BOOL'))) !== until && iterations < 10000) {
            await sequence(input('DO'))
            iterations += 1
            if (iterations % 10 === 0) await wait(0)
          }
          break
        }
        case 'arduino_stop':
          stopProgram()
          break
        default:
          setStatus(`Bloco ainda não executável: ${block.type}`)
          break
      }
    }

    try {
      await Promise.all(starts.map((block) => sequence(asBlock(block.getNextBlock()))))
      if (active()) {
        activeArduinoPrograms.delete(key)
        run.active = false
        setRunning(false)
        setStatus('Programa concluído. As saídas permanecem no último estado até Parar ou executar novamente.')
      }
    } catch (error) {
      console.error('Erro na execução do programa Arduino:', error)
      if (active()) {
        stopProgram(false)
        setStatus('O programa foi interrompido por um erro.')
      }
    }
  }

  const close = () => {
    // Like a physical Arduino, the program keeps running after closing the IDE.
    gameStore.set({ arduinoProgramKey: null, screen: 'playing' })
  }

  return (
    <section className="absolute inset-0 z-40 flex min-h-0 flex-col bg-[#f5f6f8] text-[#202a36]" aria-label="Programação do Arduino UNO">
      <header className="flex min-h-14 items-center justify-between gap-2 border-b-2 border-black/15 bg-[#1464ad] px-3 py-2 text-white sm:px-5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-bold sm:text-base">Programação · Arduino UNO</h2>
          <p className="text-[11px] text-white/80 sm:text-xs">{status}</p>
        </div>
        <button type="button" onClick={close} className="shrink-0 border-2 border-black/30 bg-white/15 px-3 py-2 text-xs font-bold hover:bg-white/25 sm:text-sm">Fechar</button>
      </header>
      <div className="relative min-h-0 flex-1">
        {!ready && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/90 p-5 text-center text-sm text-[#333]">
            Carregando editor de blocos…
          </div>
        )}
        <div ref={workspaceHost} className="h-full w-full touch-none" />
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-black/15 bg-[#e7eaf0] px-3 py-2 sm:px-5">
        <p className="hidden text-xs text-[#4a5360] sm:block">Os programas são salvos neste navegador para este Arduino.</p>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            disabled={!ready}
            onClick={() => {
              const workspace = workspaceRef.current as unknown as { clear(): void } | null
              if (!workspace) return
              stopProgram(false)
              workspace.clear()
              setStatus('Área limpa. Arraste “quando iniciar” para começar.')
            }}
            className="border-2 border-black/20 bg-white px-3 py-2 text-xs font-semibold text-[#333] disabled:opacity-50 sm:text-sm"
          >
            Limpar
          </button>
          <button
            type="button"
            onClick={() => { void executeProgram() }}
            disabled={!ready || running}
            className="border-2 border-black bg-[#42a85a] px-4 py-2 text-xs font-bold text-white shadow-[2px_2px_0_#000] disabled:opacity-50 sm:text-sm"
          >
            Executar
          </button>
          <button
            type="button"
            onClick={() => stopProgram()}
            disabled={!running}
            className="border-2 border-black bg-[#d94b4b] px-3 py-2 text-xs font-bold text-white shadow-[2px_2px_0_#000] disabled:opacity-50 sm:text-sm"
          >
            Parar
          </button>
        </div>
      </footer>
    </section>
  )
}
