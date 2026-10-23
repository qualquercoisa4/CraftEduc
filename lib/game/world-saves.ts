import type { BlockState } from './world'
import type { WorldType } from './world-generation'

export interface WorldConfig {
  id: string
  name: string
  type: WorldType
  seed: number
}

export interface SavedBlock {
  x: number
  y: number
  z: number
  id: number
  state?: BlockState
}

export interface SavedWire {
  a: string
  b: string
  ta: string
  tb: string
  pa: [number, number, number]
  pb: [number, number, number]
  color?: string
}

export interface SavedPlayer {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  flying: boolean
  sneaking: boolean
}

export interface SavedWorldData {
  version: 1
  blocks: SavedBlock[]
  wires: SavedWire[]
  player: SavedPlayer
  arduinoPrograms?: Record<string, string>
}

export interface SavedWorldRecord extends WorldConfig {
  createdAt: number
  updatedAt: number
  data: SavedWorldData
}

type PendingWorldAction =
  | { mode: 'new'; config: WorldConfig }
  | { mode: 'load'; saveId: string }

export interface WorldStartup {
  config: WorldConfig
  save: SavedWorldRecord | null
  autoStart: boolean
}

const SAVES_KEY = 'crafteduc:saved-worlds:v1'
const ACTIVE_KEY = 'crafteduc:active-world:v1'
const PENDING_KEY = 'crafteduc:pending-world:v1'

const DEFAULT_CONFIG: WorldConfig = {
  id: 'default-flat-world',
  name: 'Mundo plano',
  type: 'flat',
  seed: 20261023,
}

function validWorldType(value: unknown): value is WorldType {
  return value === 'flat' || value === 'prototypes' || value === 'deep_pits' || value === 'mega_maze'
}

function validConfig(value: unknown): value is WorldConfig {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<WorldConfig>
  return typeof item.id === 'string' && item.id.length > 0 &&
    typeof item.name === 'string' && validWorldType(item.type) &&
    Number.isFinite(item.seed)
}

export function getSavedWorlds(): SavedWorldRecord[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SAVES_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is SavedWorldRecord =>
      Boolean(item && typeof item === 'object' && validConfig(item) &&
        Number.isFinite((item as SavedWorldRecord).updatedAt) &&
        (item as SavedWorldRecord).data?.version === 1 &&
        Array.isArray((item as SavedWorldRecord).data.blocks) &&
        Array.isArray((item as SavedWorldRecord).data.wires)),
    ).sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

export function getActiveWorldConfig(): WorldConfig {
  if (typeof window === 'undefined') return DEFAULT_CONFIG
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(ACTIVE_KEY) ?? 'null')
    if (validConfig(parsed)) return parsed
  } catch {}
  return DEFAULT_CONFIG
}

function arduinoProgramPrefix(worldId: string) {
  return `crafteduc:arduino-program:${worldId}:`
}

export function getArduinoProgramStorageKey(componentKey: string | null | undefined) {
  return `${arduinoProgramPrefix(getActiveWorldConfig().id)}${componentKey ?? 'unknown'}`
}

export function getArduinoProgramsForWorld(worldId: string): Record<string, string> {
  const programs: Record<string, string> = {}
  if (typeof window === 'undefined') return programs
  const prefix = arduinoProgramPrefix(worldId)
  try {
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index)
      if (!key?.startsWith(prefix)) continue
      const value = window.localStorage.getItem(key)
      if (value !== null) programs[key.slice(prefix.length)] = value
    }
  } catch {}
  return programs
}

export function restoreArduinoProgramsForWorld(worldId: string, programs?: Record<string, string>) {
  if (typeof window === 'undefined' || !programs) return
  const prefix = arduinoProgramPrefix(worldId)
  try {
    const keys: string[] = []
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index)
      if (key?.startsWith(prefix)) keys.push(key)
    }
    for (const key of keys) window.localStorage.removeItem(key)
    for (const [componentKey, value] of Object.entries(programs)) {
      if (typeof value === 'string' && componentKey.length > 0 && !componentKey.includes(':')) {
        window.localStorage.setItem(`${prefix}${componentKey}`, value)
      }
    }
  } catch {}
}

export function saveWorldRecord(config: WorldConfig, data: SavedWorldData): SavedWorldRecord | null {
  if (typeof window === 'undefined') return null
  try {
    const saves = getSavedWorlds()
    const previous = saves.find((item) => item.id === config.id)
    const record: SavedWorldRecord = {
      ...config,
      createdAt: previous?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      data,
    }
    const next = [record, ...saves.filter((item) => item.id !== config.id)]
    window.localStorage.setItem(SAVES_KEY, JSON.stringify(next))
    window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(config))
    return record
  } catch {
    return null
  }
}

export function deleteSavedWorld(id: string) {
  if (typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(SAVES_KEY, JSON.stringify(getSavedWorlds().filter((item) => item.id !== id)))
    return true
  } catch {
    return false
  }
}

export function requestNewWorld(type: WorldType, name: string) {
  if (typeof window === 'undefined') return
  const normalizedName = name.trim().slice(0, 48) || 'Meu mundo'
  const config: WorldConfig = {
    id: `world-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: normalizedName,
    type,
    seed: (Math.floor(Math.random() * 0x7fffffff) ^ Date.now()) >>> 0,
  }
  const pending: PendingWorldAction = { mode: 'new', config }
  window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending))
  window.location.reload()
}

export function requestLoadWorld(saveId: string) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PENDING_KEY, JSON.stringify({ mode: 'load', saveId } satisfies PendingWorldAction))
  window.location.reload()
}

export function resolveWorldStartup(): WorldStartup {
  if (typeof window === 'undefined') return { config: DEFAULT_CONFIG, save: null, autoStart: false }

  let pending: PendingWorldAction | null = null
  try {
    const raw = window.localStorage.getItem(PENDING_KEY)
    if (raw) pending = JSON.parse(raw) as PendingWorldAction
    window.localStorage.removeItem(PENDING_KEY)
  } catch {
    pending = null
  }

  if (pending?.mode === 'new' && validConfig(pending.config)) {
    try { window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(pending.config)) } catch {}
    return { config: pending.config, save: null, autoStart: true }
  }

  const saves = getSavedWorlds()
  if (pending?.mode === 'load') {
    const requestedSaveId = pending.saveId
    const save = saves.find((item) => item.id === requestedSaveId) ?? null
    if (save) {
      const config: WorldConfig = { id: save.id, name: save.name, type: save.type, seed: save.seed }
      try { window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(config)) } catch {}
      return { config, save, autoStart: true }
    }
  }

  let active = DEFAULT_CONFIG
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(ACTIVE_KEY) ?? 'null')
    if (validConfig(parsed)) active = parsed
  } catch {}

  const save = saves.find((item) => item.id === active.id) ?? null
  return { config: active, save, autoStart: false }
}
