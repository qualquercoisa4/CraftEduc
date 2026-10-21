'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, Copy, Crown, LoaderCircle, LogOut, MessageCircle, Palette, PlugZap, Users, X } from 'lucide-react'
import { getEngine } from '@/lib/game/engine'
import { gameStore } from '@/lib/game/store'
import {
  DEFAULT_SKIN, MultiplayerClient, type MultiplayerCallbacks, type MultiplayerRules,
  type NetworkPlayer, loadSavedSkin, saveSkin,
} from '@/lib/game/multiplayer'
import type { SkinConfig } from '@/lib/game/multiplayer-types'

type PanelMode = 'home' | 'join' | 'skin' | 'lobby'
interface MultiplayerPanelProps {
  open: boolean
  session: MultiplayerClient | null
  onSessionChange: (session: MultiplayerClient | null) => void
  onClose: () => void
}

const ACCESSORIES: { id: SkinConfig['accessory']; label: string }[] = [
  { id: 'none', label: 'Nenhum' },
  { id: 'glasses', label: 'Óculos' },
  { id: 'goggles', label: 'Óculos de proteção' },
  { id: 'antenna', label: 'Antena' },
  { id: 'cap', label: 'Boné' },
  { id: 'headphones', label: 'Fones' },
]

export function MultiplayerPanel({ open, session, onSessionChange, onClose }: MultiplayerPanelProps) {
  const [mode, setMode] = useState<PanelMode>(session ? 'lobby' : 'home')
  const [playerName, setPlayerName] = useState('Aluno')
  const [roomCode, setRoomCode] = useState('')
  const [skin, setSkin] = useState<SkinConfig>(() => loadSavedSkin())
  const [rules, setRules] = useState<MultiplayerRules>(session?.rules ?? {
    playersCanOnlyDestroyOwnBlocks: true, playersCanFly: false,
  })
  const [players, setPlayers] = useState<NetworkPlayer[]>([])
  const [chat, setChat] = useState<{ id: string; playerId: string; playerName: string; message: string; createdAt: string }[]>([])
  const [chatText, setChatText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('Desconectado')
  const chatEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      const storedName = localStorage.getItem('crafteduc-multiplayer-name-v1')
      if (storedName) setPlayerName(storedName)
    } catch { /* local storage may be unavailable */ }
  }, [])

  useEffect(() => {
    if (session) {
      setMode('lobby')
      setRules({ ...session.rules })
      setStatus('Conectado')
      setPlayers(session.players.filter((p) => p.id !== session.playerKey))
      setSkin({ ...session.skin })
    } else {
      setMode('home')
      setPlayers([])
      setChat([])
      setStatus('Desconectado')
    }
  }, [session])

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chat])

  useEffect(() => () => {
    if (session) void session.leave()
  }, [session])

  const patchSkin = (patch: Partial<SkinConfig>) => {
    setSkin((current) => {
      const next = { ...current, ...patch }
      saveSkin(next)
      if (session) session.skin = next
      return next
    })
  }

  const callbacks = (): MultiplayerCallbacks => ({
    onRules: (next) => setRules({ ...next }),
    onPlayers: (next) => setPlayers(next),
    onChat: (message) => setChat((current) => current.some((entry) => entry.id === message.id)
      ? current : [...current.slice(-59), message]),
    onError: (message) => setError(message),
    onStatus: (connected) => setStatus(connected ? 'Conectado' : 'Reconectando…'),
  })

  const validateName = () => {
    const name = playerName.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 20)
    if (!name) throw new Error('Digite seu nome antes de continuar.')
    setPlayerName(name)
    try { localStorage.setItem('crafteduc-multiplayer-name-v1', name) } catch { /* ignore */ }
    saveSkin(skin)
    return name
  }

  const connect = async (kind: 'create' | 'join') => {
    setBusy(true)
    setError('')
    try {
      const name = validateName()
      const engine = getEngine()
      if (!engine) throw new Error('O jogo ainda está inicializando. Tente novamente em alguns segundos.')
      const result = kind === 'create'
        ? await MultiplayerClient.create(name, skin)
        : await MultiplayerClient.join(roomCode, name, skin)
      result.client.start(engine, callbacks())
      onSessionChange(result.client)
      setRules({ ...result.client.rules })
      setPlayers(result.client.players.filter((p) => p.id !== result.client.playerKey))
      setMode('lobby')
      gameStore.set({ screen: 'playing' })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível conectar ao servidor.')
    } finally {
      setBusy(false)
    }
  }

  const changeRule = async (patch: Partial<MultiplayerRules>) => {
    if (!session?.isHost) return
    const next = { ...rules, ...patch }
    setRules(next)
    setError('')
    try {
      await session.updateRules(next)
    } catch (caught) {
      setRules({ ...session.rules })
      setError(caught instanceof Error ? caught.message : 'Não foi possível alterar a regra.')
    }
  }

  const sendChat = async () => {
    const message = chatText.trim()
    if (!session || !message) return
    setChatText('')
    try { await session.postChat(message) }
    catch (caught) {
      setChatText(message)
      setError(caught instanceof Error ? caught.message : 'Não foi possível enviar a mensagem.')
    }
  }

  const leave = async () => {
    if (!session || busy) return
    setBusy(true)
    setError('')
    try { await session.leave() } catch { /* cleanup remains local */ }
    onSessionChange(null)
    setMode('home')
    setPlayers([])
    setChat([])
    setBusy(false)
  }

  if (!open) return null

  return (
    <section className="absolute inset-0 z-40 flex items-center justify-center overflow-y-auto bg-black/75 p-3 backdrop-blur-sm sm:p-6">
      <div className="mc-panel relative my-auto max-h-[94dvh] w-full max-w-2xl overflow-y-auto p-4 text-[#252525] sm:p-6">
        <button type="button" aria-label="Fechar multiplayer" onClick={onClose}
          className="absolute right-3 top-3 flex size-9 items-center justify-center border-2 border-black bg-[#d6d6d6] hover:bg-white">
          <X size={18} />
        </button>

        {mode === 'home' && !session && (
          <>
            <div className="pr-10">
              <p className="text-xs tracking-[0.22em] text-[#23799b]">CRAFTEDUC • REDE</p>
              <h2 className="mt-2 font-display text-lg sm:text-xl">MULTIPLAYER</h2>
              <p className="mt-2 text-sm leading-6 text-[#555]">Entre no mesmo mundo para construir, ligar circuitos e testar máquinas com sua turma.</p>
            </div>
            <label className="mt-5 block text-sm font-bold">
              Nome do jogador
              <input maxLength={20} value={playerName} onChange={(e) => setPlayerName(e.target.value)}
                className="mt-2 h-11 w-full border-2 border-black bg-white px-3 font-sans font-normal outline-none focus:border-[#168ab5]" placeholder="Como você quer aparecer?" />
            </label>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button className="mc-btn flex items-center justify-center gap-2" disabled={busy} onClick={() => void connect('create')}>
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Crown className="size-4" />} Criar servidor
              </button>
              <button className="mc-btn flex items-center justify-center gap-2" onClick={() => { setError(''); setMode('join') }}>
                <Users className="size-4" /> Entrar em servidor
              </button>
            </div>
            <button className="mt-3 flex h-11 w-full items-center justify-center gap-2 border-2 border-black bg-[#c7dded] px-3 text-sm font-bold hover:bg-[#d9eafa]"
              onClick={() => { setError(''); setMode('skin') }}>
              <Palette className="size-4" /> Personalizar skin
            </button>
            <p className="mt-4 text-xs leading-5 text-[#666]">Ao criar um servidor, seu dispositivo será o anfitrião e executará a simulação compartilhada. A sala fecha quando o anfitrião sai ou perde a conexão.</p>
          </>
        )}

        {mode === 'join' && !session && (
          <>
            <button onClick={() => { setMode('home'); setError('') }} className="mb-3 flex items-center gap-1 text-sm font-bold text-[#176986]"><ChevronLeft size={16} /> Voltar</button>
            <h2 className="font-display text-lg">ENTRAR EM SERVIDOR</h2>
            <p className="mt-2 text-sm text-[#555]">Peça o código de seis caracteres ao anfitrião.</p>
            <label className="mt-5 block text-sm font-bold">
              Nome do jogador
              <input maxLength={20} value={playerName} onChange={(e) => setPlayerName(e.target.value)}
                className="mt-2 h-11 w-full border-2 border-black bg-white px-3 font-sans font-normal" />
            </label>
            <label className="mt-4 block text-sm font-bold">
              Código do servidor
              <input value={roomCode} onChange={(e) => setRoomCode(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20))}
                autoCapitalize="none" autoCorrect="off" maxLength={20}
                className="mt-2 h-12 w-full border-2 border-black bg-white px-3 font-mono text-xl uppercase tracking-[0.24em] outline-none focus:border-[#168ab5]" placeholder="ex.: a2b7k9" />
            </label>
            <button className="mc-btn mt-5 w-full" disabled={busy || roomCode.trim().length < 4} onClick={() => void connect('join')}>
              {busy ? 'Conectando…' : 'Entrar'}
            </button>
          </>
        )}

        {mode === 'skin' && (
          <>
            <button onClick={() => { setMode(session ? 'lobby' : 'home'); setError('') }} className="mb-3 flex items-center gap-1 text-sm font-bold text-[#176986]"><ChevronLeft size={16} /> Voltar</button>
            <h2 className="font-display text-lg">PERSONALIZAR SKIN</h2>
            <p className="mt-2 text-sm text-[#555]">Escolha as cores e o acessório do seu personagem. A skin será sincronizada ao entrar no servidor.</p>
            <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-[180px_1fr]">
              <div className="flex min-h-52 items-center justify-center border-2 border-black bg-[linear-gradient(#d6edff,#f5f5f5)] p-4">
                <div className="relative h-44 w-28">
                  <div className="absolute left-7 top-0 h-4 w-14" style={{ background: skin.hair }} />
                  <div className="absolute left-8 top-3 h-12 w-12" style={{ background: skin.skin }} />
                  <div className="absolute left-7 top-2 h-3 w-14" style={{ background: skin.hair }} />
                  {skin.accessory === 'cap' && <div className="absolute left-6 top-[-5px] h-3 w-16" style={{ background: skin.accessoryColor }} />}
                  {skin.accessory === 'antenna' && <div className="absolute left-[53px] top-[-20px] h-5 w-2" style={{ background: skin.accessoryColor }} />}
                  {['glasses', 'goggles'].includes(skin.accessory) && <div className="absolute left-8 top-7 h-2 w-12" style={{ background: skin.accessoryColor }} />}
                  <div className="absolute left-5 top-[62px] h-16 w-16" style={{ background: skin.shirt }} />
                  <div className="absolute left-0 top-[64px] h-16 w-5" style={{ background: skin.shirt }} />
                  <div className="absolute right-0 top-[64px] h-16 w-5" style={{ background: skin.shirt }} />
                  <div className="absolute left-5 top-[126px] h-12 w-7" style={{ background: skin.pants }} />
                  <div className="absolute right-5 top-[126px] h-12 w-7" style={{ background: skin.pants }} />
                  <div className="absolute left-4 top-[164px] h-3 w-8" style={{ background: skin.shoes }} />
                  <div className="absolute right-4 top-[164px] h-3 w-8" style={{ background: skin.shoes }} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {([
                  ['skin', 'Pele'], ['hair', 'Cabelo'], ['shirt', 'Camisa'],
                  ['pants', 'Calça'], ['shoes', 'Calçado'], ['accessoryColor', 'Acessório'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="block text-xs font-bold">
                    {label}
                    <input type="color" value={skin[key]} onChange={(e) => patchSkin({ [key]: e.target.value })}
                      className="mt-1 h-10 w-full cursor-pointer border-2 border-black bg-white p-1" />
                  </label>
                ))}
                <label className="col-span-2 block text-xs font-bold">
                  Acessório
                  <select value={skin.accessory} onChange={(e) => patchSkin({ accessory: e.target.value as SkinConfig['accessory'] })}
                    className="mt-1 h-10 w-full border-2 border-black bg-white px-2 text-sm">
                    {ACCESSORIES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                </label>
              </div>
            </div>
            <button className="mc-btn mt-5 w-full" onClick={() => { saveSkin(skin); setMode(session ? 'lobby' : 'home') }}>
              <Check className="mr-2 inline size-4" /> Salvar skin
            </button>
          </>
        )}

        {mode === 'lobby' && session && (
          <>
            <div className="pr-10">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-lg">SALA MULTIPLAYER</h2>
                <span className={`inline-flex items-center gap-1 text-xs font-bold ${status === 'Conectado' ? 'text-green-700' : 'text-amber-700'}`}>
                  <span className={`size-2 rounded-full ${status === 'Conectado' ? 'bg-green-600' : 'bg-amber-500'}`} />{status}
                </span>
              </div>
              <p className="mt-2 text-sm text-[#555]">{session.isHost ? 'Você é o anfitrião e controla a simulação.' : 'Você está conectado ao mundo do anfitrião.'}</p>
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 border-2 border-black bg-[#dbeafe] p-3">
              <div>
                <p className="text-[10px] font-bold tracking-[0.16em] text-[#435a70]">CÓDIGO DO SERVIDOR</p>
                <p className="mt-1 font-mono text-2xl font-bold uppercase tracking-[0.2em]">{session.roomId}</p>
              </div>
              <button className="flex size-10 items-center justify-center border-2 border-black bg-white hover:bg-[#efefef]" title="Copiar código"
                onClick={() => { void navigator.clipboard?.writeText(session.roomId).then(() => setStatus('Código copiado')).catch(() => setError('Não foi possível copiar o código.')) }}>
                <Copy size={17} />
              </button>
            </div>

            {session.isHost && (
              <div className="mt-4 border-2 border-black bg-[#e9e9e9] p-3">
                <h3 className="flex items-center gap-2 font-display text-xs"><Crown size={15} /> REGRAS DO ANFITRIÃO</h3>
                <label className="mt-3 flex cursor-pointer items-center justify-between gap-3 text-sm">
                  <span><strong>Quebrar apenas blocos próprios</strong><span className="mt-1 block text-xs text-[#666]">Não se aplica ao anfitrião.</span></span>
                  <input type="checkbox" checked={rules.playersCanOnlyDestroyOwnBlocks}
                    onChange={(e) => void changeRule({ playersCanOnlyDestroyOwnBlocks: e.target.checked })} className="size-5 accent-[#167da2]" />
                </label>
                <label className="mt-3 flex cursor-pointer items-center justify-between gap-3 text-sm">
                  <span><strong>Permitir voo</strong><span className="mt-1 block text-xs text-[#666]">Não se aplica ao anfitrião.</span></span>
                  <input type="checkbox" checked={rules.playersCanFly}
                    onChange={(e) => void changeRule({ playersCanFly: e.target.checked })} className="size-5 accent-[#167da2]" />
                </label>
              </div>
            )}
            {!session.isHost && (
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <span className="border border-black bg-white px-2 py-1">{rules.playersCanOnlyDestroyOwnBlocks ? 'Só blocos próprios' : 'Quebra livre'}</span>
                <span className="border border-black bg-white px-2 py-1">{rules.playersCanFly ? 'Voo permitido' : 'Voo desativado'}</span>
              </div>
            )}

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="border-2 border-black p-3">
                <h3 className="flex items-center gap-2 font-display text-xs"><Users size={15} /> JOGADORES ({players.length + 1})</h3>
                <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">
                  <div className="flex items-center gap-2 text-sm"><span className="size-2 bg-green-600" />{session.playerName} <span className="text-xs text-[#666]">{session.isHost ? '(anfitrião)' : '(você)'}</span></div>
                  {players.filter((p) => p.id !== session.playerKey).map((player) => (
                    <div key={player.id} className="flex items-center gap-2 text-sm"><span className="size-2 bg-blue-500" />{player.name}{player.id && player.name ? '' : ''}</div>
                  ))}
                </div>
                <button onClick={() => setMode('skin')} className="mt-3 flex h-9 w-full items-center justify-center gap-2 border-2 border-black bg-[#c7dded] text-xs font-bold hover:bg-white">
                  <Palette size={14} /> Editar skin
                </button>
              </div>
              <div className="flex min-h-48 flex-col border-2 border-black p-3">
                <h3 className="flex items-center gap-2 font-display text-xs"><MessageCircle size={15} /> CHAT DA SALA</h3>
                <div className="mt-2 min-h-16 flex-1 space-y-2 overflow-y-auto text-xs">
                  {chat.length === 0 && <p className="text-[#777]">Nenhuma mensagem ainda.</p>}
                  {chat.map((message) => (
                    <p key={message.id} className="break-words"><strong>{message.playerName}:</strong> {message.message}</p>
                  ))}
                  <div ref={chatEnd} />
                </div>
                <form className="mt-2 flex gap-1" onSubmit={(e) => { e.preventDefault(); void sendChat() }}>
                  <input maxLength={256} value={chatText} onChange={(e) => setChatText(e.target.value)}
                    className="h-9 min-w-0 flex-1 border-2 border-black bg-white px-2 text-xs" placeholder="Mensagem…" />
                  <button className="flex h-9 items-center justify-center border-2 border-black bg-[#c7dded] px-2" type="submit"><MessageCircle size={15} /></button>
                </form>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button onClick={onClose} className="mc-btn">Voltar ao jogo</button>
              <button onClick={() => void leave()} disabled={busy} className="flex h-11 items-center justify-center gap-2 border-2 border-black bg-[#f2d5d5] font-bold hover:bg-[#ffe7e7] disabled:opacity-50">
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : <LogOut size={15} />} {session.isHost ? 'Fechar servidor e sair' : 'Sair do servidor'}
              </button>
            </div>
          </>
        )}

        {error && (
          <div role="alert" className="mt-4 border-2 border-[#a33] bg-[#fbe1e1] p-3 text-sm text-[#8b1d1d]">{error}</div>
        )}
      </div>
    </section>
  )
}
