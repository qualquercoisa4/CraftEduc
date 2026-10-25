'use client'

import { useSyncExternalStore } from 'react'
import { type CategoryId, DEFAULT_HOTBAR, type ItemId } from './constants'

export interface ScannerReport {
  blockCount: number
  massKg: number
  dimensions: { x: number; y: number; z: number }
  centerOfMass: { x: number; y: number; z: number }
  inertia: { x: number; y: number; z: number }
  averageFriction: number
  averageConductivity: number
  gluedConnections: number
  composition: { name: string; count: number; massKg: number }[]
}

export type Screen = 'scanner' | 'title' | 'playing' | 'paused' | 'inventory' | 'options' | 'controls' | 'sensor_config' | 'servo_config' | 'resistor_config' | 'arduino_programming' | 'brush_color'

export interface Settings {
  renderDistance: number
  sensitivity: number
  fov: number
}

export type MultimeterMode = 'dc_voltage' | 'dc_current' | 'resistance' | 'continuity' | 'diode'

export interface MeterProbe { key: string; terminal: string }

export interface GameState {
  screen: Screen
  returnScreen: Screen
  hotbar: (ItemId | null)[]
  selected: number
  isTouch: boolean
  flying: boolean
  sneaking: boolean
  hint: string | null
  toast: { text: string; id: number } | null
  itemLabel: { text: string; id: number } | null
  debug: boolean
  debugInfo: string
  settings: Settings
  inventoryTab: CategoryId
  breakProgress: number
  sensorConfigKey: string | null
  servoConfigKey: string | null
  resistorConfigKey: string | null
  arduinoProgramKey: string | null
  scannerReport: ScannerReport | null
  brushColor: string
  multimeterMode: MultimeterMode
  multimeterFirstProbe: MeterProbe | null
  multimeterReading: string
}

type Listener = () => void

function createStore(initial: GameState) {
  let state = initial
  const listeners = new Set<Listener>()
  return {
    get: () => state,
    set(partial: Partial<GameState> | ((s: GameState) => Partial<GameState>)) {
      const next = typeof partial === 'function' ? partial(state) : partial
      let changed = false
      for (const k in next) {
        if ((next as Record<string, unknown>)[k] !== (state as unknown as Record<string, unknown>)[k]) {
          changed = true
          break
        }
      }
      if (!changed) return
      state = { ...state, ...next }
      for (const l of listeners) l()
    },
    subscribe(l: Listener) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
}

export const gameStore = createStore({
  screen: 'title',
  returnScreen: 'title',
  hotbar: [...DEFAULT_HOTBAR],
  selected: 0,
  isTouch: false,
  flying: false,
  sneaking: false,
  hint: null,
  toast: null,
  itemLabel: null,
  debug: false,
  debugInfo: '',
  settings: { renderDistance: 8, sensitivity: 1, fov: 70 },
  inventoryTab: 'all',
  breakProgress: 0,
  sensorConfigKey: null,
  servoConfigKey: null,
  resistorConfigKey: null,
  arduinoProgramKey: null,
  scannerReport: null,
  brushColor: '#e53935',
  multimeterMode: 'dc_voltage',
  multimeterFirstProbe: null,
  multimeterReading: 'Selecione o primeiro terminal.',
})

let toastId = 0
export function showToast(text: string) {
  gameStore.set({ toast: { text, id: ++toastId } })
}
export function showItemLabel(text: string) {
  gameStore.set({ itemLabel: { text, id: ++toastId } })
}

export function useGame<T>(selector: (s: GameState) => T): T {
  return useSyncExternalStore(
    gameStore.subscribe,
    () => selector(gameStore.get()),
    () => selector(gameStore.get()),
  )
}
