import type { Engine } from './engine'
import type { BlockState } from './world'
import type { Wire } from './mechanics'
import type { SkinConfig } from './multiplayer-types'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://emitzhlqcvryfxiufqtb.supabase.co'
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_N6f5E5fhwm52fE8dTMEO5Q_bw-m4o5T'
const ENDPOINT = `${SUPABASE_URL}/functions/v1/crafteduc-multiplayer`
const PLAYER_KEY_STORAGE = 'crafteduc-multiplayer-player-v1'

export interface MultiplayerRules {
  playersCanOnlyDestroyOwnBlocks: boolean
  playersCanFly: boolean
}
export interface NetworkPlayer {
  id: string
  name: string
  data: {
    x: number; y: number; z: number; yaw: number; pitch: number
    flying?: boolean; sneaking?: boolean; onGround?: boolean
    velocityX?: number; velocityY?: number; velocityZ?: number
  }
  skin: SkinConfig
  updatedAt?: number
}
export interface BlockEdit {
  x: number; y: number; z: number; block: number
  state?: BlockState | null; ownerKey?: string | null
  playerKey?: string; updatedAt?: number
}
export interface NetworkWire {
  id: string; a: string; b: string; ta: string; tb: string
  pa: { x: number; y: number; z: number }; pb: { x: number; y: number; z: number }
  ownerKey?: string
}
export interface NetworkPayload {
  world: {
    roomId: string; seed: number; sessionStatus: string
    rules: MultiplayerRules; sharedState: Record<string, unknown>
  }
  blocks: BlockEdit[]
  wires: NetworkWire[]
  players: NetworkPlayer[]
  cursor: number
  playerSave?: { name: string; data: Record<string, unknown>; skin: SkinConfig } | null
  chat?: { id: string; playerId: string; playerName: string; message: string; createdAt: string }[]
  isHost?: boolean
}
export interface MultiplayerCallbacks {
  onRules?: (rules: MultiplayerRules) => void
  onPlayers?: (players: NetworkPlayer[]) => void
  onChat?: (chat: { id: string; playerId: string; playerName: string; message: string; createdAt: string }) => void
  onError?: (message: string) => void
  onStatus?: (connected: boolean) => void
}

export const DEFAULT_SKIN: SkinConfig = {
  skin: '#d9a079', hair: '#4a3022', shirt: '#2878cf', pants: '#334155',
  shoes: '#2b2b2b', accessory: 'none', accessoryColor: '#f4c542',
}
export const DEFAULT_RULES: MultiplayerRules = {
  playersCanOnlyDestroyOwnBlocks: true,
  playersCanFly: false,
}
export function loadSavedSkin(): SkinConfig {
  if (typeof window === 'undefined') return { ...DEFAULT_SKIN }
  try {
    const value = JSON.parse(localStorage.getItem('crafteduc-multiplayer-skin-v1') || 'null')
    return { ...DEFAULT_SKIN, ...(value && typeof value === 'object' ? value : {}) }
  } catch { return { ...DEFAULT_SKIN } }
}
export function saveSkin(skin: SkinConfig) {
  if (typeof window !== 'undefined') localStorage.setItem('crafteduc-multiplayer-skin-v1', JSON.stringify(skin))
}
export function getPlayerKey() {
  if (typeof window === 'undefined') return randomKey(24)
  let key = localStorage.getItem(PLAYER_KEY_STORAGE)
  if (!key || !/^[a-zA-Z0-9_-]{16,80}$/.test(key)) {
    key = randomKey(32)
    localStorage.setItem(PLAYER_KEY_STORAGE, key)
  }
  return key
}
function randomKey(length: number) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  const bytes = new Uint8Array(length)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256)
  for (const b of bytes) out += chars[b % chars.length]
  return out
}
export function generateRoomCode() {
  return randomKey(6).toLowerCase()
}

export class MultiplayerClient {
  readonly roomId: string
  readonly playerKey: string
  readonly playerName: string
  readonly hostKey?: string
  readonly isHost: boolean
  skin: SkinConfig
  rules: MultiplayerRules = { ...DEFAULT_RULES }
  players: NetworkPlayer[] = []
  cursor = 0
  engine: Engine | null = null
  callbacks: MultiplayerCallbacks = {}
  private timers: ReturnType<typeof setInterval>[] = []
  private stopped = false
  private polling = false
  private savingPlayer = false
  private savingSimulation = false
  private lastBlockOwners = new Map<string, string>()
  private knownWireIds = new Set<string>()
  private localWireSignature = new Map<number, string>()
  private sessionReady = false
  private connected = false
  private pendingPayload: NetworkPayload | null = null
  private seenChatIds = new Set<string>()

  private constructor(args: { roomId: string; playerKey: string; playerName: string; hostKey?: string; isHost: boolean; skin: SkinConfig }) {
    this.roomId = args.roomId.toLowerCase()
    this.playerKey = args.playerKey
    this.playerName = args.playerName
    this.hostKey = args.hostKey
    this.isHost = args.isHost
    this.skin = { ...DEFAULT_SKIN, ...args.skin }
  }

  static async create(playerName: string, skin: SkinConfig) {
    const roomId = generateRoomCode()
    const playerKey = getPlayerKey()
    const hostKey = randomKey(48)
    const client = new MultiplayerClient({ roomId, playerKey, playerName, hostKey, isHost: true, skin })
    const payload = await client.request<NetworkPayload>('create_room', {
      hostKey, playerKey, playerName: client.playerName, skin: client.skin,
      seed: Math.floor(Math.random() * 0x7fffffff),
    })
    client.pendingPayload = payload
    client.pendingPayload = payload
    client.applyPayload(payload)
    return { client, payload }
  }

  static async join(roomId: string, playerName: string, skin: SkinConfig) {
    const normalized = roomId.trim().toLowerCase()
    const playerKey = getPlayerKey()
    const client = new MultiplayerClient({ roomId: normalized, playerKey, playerName, isHost: false, skin })
    const payload = await client.request<NetworkPayload>('join', { playerKey, playerName: client.playerName, skin: client.skin })
    client.applyPayload(payload)
    return { client, payload }
  }

  private async request<T = any>(action: string, extra: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
      body: JSON.stringify({ action, roomId: this.roomId, playerKey: this.playerKey, playerName: this.playerName, hostKey: this.hostKey, ...extra }),
      cache: 'no-store',
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : `Falha no servidor multiplayer (${response.status}).`)
    return data as T
  }

  private applyPayload(payload: NetworkPayload) {
    this.rules = { ...DEFAULT_RULES, ...(payload.world?.rules ?? {}) }
    if (Number.isFinite(payload.cursor)) this.cursor = payload.cursor
    const engine = this.engine
    if (engine) {
      for (const block of payload.blocks ?? []) {
        const key = `${block.x},${block.y},${block.z}`
        if (block.ownerKey) this.lastBlockOwners.set(key, block.ownerKey)
        else this.lastBlockOwners.delete(key)
        engine.applyMultiplayerBlock(block)
      }
      for (const wire of payload.wires ?? []) {
        this.knownWireIds.add(wire.id)
        engine.applyMultiplayerWire(wire)
      }
      engine.mech.applyNetworkSnapshot(payload.world?.sharedState ?? {})
    }
    this.players = payload.players ?? []
    for (const message of payload.chat ?? []) {
      if (!this.seenChatIds.has(message.id) && this.callbacks.onChat) {
        this.seenChatIds.add(message.id)
        this.callbacks.onChat(message)
      }
    }
    this.callbacks.onRules?.(this.rules)
    this.callbacks.onPlayers?.(this.players.filter((p) => p.id !== this.playerKey))
    engine?.setRemotePlayers(this.players.filter((p) => p.id !== this.playerKey))
    engine?.setMultiplayerRules(this.rules, this.isHost)
    this.connected = true
    this.callbacks.onStatus?.(true)
  }

  canBreakBlock(x: number, y: number, z: number) {
    if (this.isHost || !this.rules.playersCanOnlyDestroyOwnBlocks) return true
    return this.lastBlockOwners.get(`${x},${y},${z}`) === this.playerKey
  }

  start(engine: Engine, callbacks: MultiplayerCallbacks = {}) {
    this.engine = engine
    this.callbacks = callbacks
    this.stopped = false
    this.sessionReady = true
    engine.mech.setNetworkAuthority(this.isHost)
    engine.setMultiplayerBridge({
      isHost: this.isHost,
      canFly: () => this.isHost || this.rules.playersCanFly,
      canBreakBlock: (x, y, z) => this.canBreakBlock(x, y, z),
      blockChanged: (x, y, z, block, state) => { void this.publishBlock(x, y, z, block, state) },
      wireCreated: (wire) => { void this.publishWire(wire) },
      wiresRemovedAt: (key) => { void this.removeWiresAt(key) },
    })
    engine.setMultiplayerRules(this.rules, this.isHost)
    const initial = this.pendingPayload
    this.pendingPayload = null
    if (initial) this.applyPayload(initial)
    else engine.setRemotePlayers(this.players.filter((p) => p.id !== this.playerKey))
    this.timers.push(setInterval(() => { void this.poll() }, 350))
    this.timers.push(setInterval(() => { void this.saveCurrentPlayer() }, 400))
    if (this.isHost) {
      this.timers.push(setInterval(() => { void this.hostHeartbeat() }, 5000))
      this.timers.push(setInterval(() => { void this.saveSimulation() }, 350))
    }
  }

  private async poll() {
    if (this.stopped || this.polling) return
    this.polling = true
    try {
      const data = await this.request<{
        world: NetworkPayload['world']; events: { id: number; type: string; payload: any }[]
        players: NetworkPlayer[]; cursor: number
        chat?: { id: string; playerId: string; playerName: string; message: string; createdAt: string }[]
      }>('poll', { cursor: this.cursor })
      for (const event of data.events ?? []) {
        const p = event.payload
        if (event.type === 'block' && p && Number.isInteger(p.x) && Number.isInteger(p.y) && Number.isInteger(p.z)) {
          const edit = p as BlockEdit
          const key = `${edit.x},${edit.y},${edit.z}`
          if (edit.ownerKey) this.lastBlockOwners.set(key, edit.ownerKey)
          else this.lastBlockOwners.delete(key)
          if (p.playerKey !== this.playerKey) this.engine?.applyMultiplayerBlock(edit)
        } else if (event.type === 'wire_upsert' && p?.id) {
          this.knownWireIds.add(String(p.id))
          if (p.ownerKey !== this.playerKey) this.engine?.applyMultiplayerWire(p as NetworkWire)
        } else if (event.type === 'wire_remove' && p?.id) {
          this.knownWireIds.delete(String(p.id))
          this.engine?.removeMultiplayerWire(String(p.id))
        } else if (event.type === 'rules') {
          this.rules = { ...DEFAULT_RULES, ...p }
          this.callbacks.onRules?.(this.rules)
          this.engine?.setMultiplayerRules(this.rules, this.isHost)
        }
      }
      for (const message of data.chat ?? []) {
        if (this.seenChatIds.has(message.id)) continue
        this.seenChatIds.add(message.id)
        if (this.seenChatIds.size > 200) {
          const oldest = this.seenChatIds.values().next().value
          if (oldest) this.seenChatIds.delete(oldest)
        }
        this.callbacks.onChat?.(message)
      }
      this.cursor = Number.isFinite(data.cursor) ? data.cursor : this.cursor
      this.players = data.players ?? []
      this.callbacks.onPlayers?.(this.players.filter(p => p.id !== this.playerKey))
      this.engine?.setRemotePlayers(this.players.filter(p => p.id !== this.playerKey))
      if (!this.isHost && data.world?.sharedState) this.engine?.mech.applyNetworkSnapshot(data.world.sharedState)
      this.rules = { ...DEFAULT_RULES, ...(data.world?.rules ?? this.rules) }
      this.engine?.setMultiplayerRules(this.rules, this.isHost)
      this.connected = true
      this.callbacks.onStatus?.(true)
    } catch (error) {
      this.callbacks.onStatus?.(false)
      this.callbacks.onError?.(error instanceof Error ? error.message : 'Conexão com o servidor interrompida.')
    } finally {
      this.polling = false
    }
  }

  private async publishBlock(x: number, y: number, z: number, block: number, state?: BlockState) {
    const key = `${x},${y},${z}`
    if (block === 0) this.lastBlockOwners.delete(key)
    else this.lastBlockOwners.set(key, this.playerKey)
    try {
      const data = await this.request<{ block: BlockEdit }>('save_block', { x, y, z, block, state })
      if (data.block?.ownerKey) this.lastBlockOwners.set(key, data.block.ownerKey)
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error.message : 'Não foi possível sincronizar o bloco.')
      // Reconcile a rejected edit with the server's last accepted version on the next snapshot.
      void this.poll()
    }
  }

  private wireSignature(wire: Wire) {
    return JSON.stringify({ a: wire.a, b: wire.b, ta: wire.ta, tb: wire.tb,
      pa: [wire.pa.x, wire.pa.y, wire.pa.z], pb: [wire.pb.x, wire.pb.y, wire.pb.z] })
  }
  private async publishWire(wire: Wire) {
    const wireId = typeof (wire as Wire & { networkId?: string }).networkId === 'string'
      ? (wire as Wire & { networkId: string }).networkId : `wire_${this.playerKey.slice(0, 12)}_${wire.id}`
    ;(wire as Wire & { networkId?: string }).networkId = wireId
    this.knownWireIds.add(wireId)
    this.localWireSignature.set(wire.id, this.wireSignature(wire))
    try {
      await this.request('save_wire', { wireId, wire: {
        a: wire.a, b: wire.b, ta: wire.ta, tb: wire.tb,
        pa: { x: wire.pa.x, y: wire.pa.y, z: wire.pa.z },
        pb: { x: wire.pb.x, y: wire.pb.y, z: wire.pb.z },
      } })
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error.message : 'Não foi possível sincronizar o fio.')
    }
  }

  private async removeWiresAt(key: string) {
    try {
      await this.request('remove_wires_at', { key })
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error.message : 'Não foi possível remover o fio no servidor.')
    }
  }

  async updateRules(rules: MultiplayerRules) {
    if (!this.isHost) throw new Error('Somente o anfitrião pode alterar as regras do servidor.')
    const result = await this.request<{ rules: MultiplayerRules }>('update_rules', { rules })
    this.rules = { ...DEFAULT_RULES, ...result.rules }
    this.engine?.setMultiplayerRules(this.rules, true)
    this.callbacks.onRules?.(this.rules)
  }

  async postChat(message: string) {
    const result = await this.request<{ chat: { id: string; playerId: string; playerName: string; message: string; createdAt: string } }>('post_chat', { message })
    this.seenChatIds.add(result.chat.id)
    this.callbacks.onChat?.(result.chat)
  }

  private async saveCurrentPlayer() {
    if (this.stopped || !this.engine || this.savingPlayer) return
    this.savingPlayer = true
    try {
      const p = this.engine.player
      const data = await this.request<{ player?: NetworkPlayer }>('save_player', {
        skin: this.skin,
        playerData: {
          x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw, pitch: p.pitch,
          flying: p.flying, sneaking: p.sneaking, onGround: p.onGround,
          velocityX: p.vel.x, velocityY: p.vel.y, velocityZ: p.vel.z,
        },
      })
      void data
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error.message : 'Não foi possível sincronizar o jogador.')
    } finally { this.savingPlayer = false }
  }

  private async hostHeartbeat() {
    if (this.stopped || !this.isHost) return
    try { await this.request('host_heartbeat') }
    catch (error) {
      this.callbacks.onStatus?.(false)
      this.callbacks.onError?.(error instanceof Error ? error.message : 'O servidor perdeu a conexão.')
    }
  }
  private async saveSimulation() {
    if (this.stopped || !this.isHost || !this.engine || this.savingSimulation) return
    this.savingSimulation = true
    try {
      const sharedState = this.engine.mech.exportNetworkSnapshot()
      sharedState.worldTime = Date.now()
      await this.request('save_simulation', { sharedState })
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error.message : 'Não foi possível sincronizar as máquinas.')
    } finally { this.savingSimulation = false }
  }

  async leave() {
    if (this.stopped) return
    this.stopped = true
    this.timers.forEach(clearInterval)
    this.timers = []
    this.engine?.setMultiplayerBridge(null)
    try { await this.request('leave') } catch { /* preserve the local game even if the host already disconnected */ }
    this.connected = false
    this.callbacks.onStatus?.(false)
    this.engine = null
  }
  stopLocal() {
    this.stopped = true
    this.timers.forEach(clearInterval)
    this.timers = []
    this.engine?.setMultiplayerBridge(null)
    this.engine = null
    this.connected = false
  }
}
