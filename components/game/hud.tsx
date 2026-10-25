'use client'

import { Ellipsis } from 'lucide-react'
import { gameStore, useGame } from '@/lib/game/store'
import { ItemIcon } from './item-icon'

const SLOT = 'clamp(38px, 9.4vw, 54px)'

export function Hotbar({ showMenuButton }: { showMenuButton: boolean }) {
  const hotbar = useGame((s) => s.hotbar)
  const selected = useGame((s) => s.selected)
  return (
    <div className="flex items-end gap-1">
      <div
        className="flex border-2 border-black bg-black/45"
        style={{ boxShadow: 'inset 0 0 0 2px #5d5d5d' }}
        role="listbox"
        aria-label="Barra de itens"
      >
        {hotbar.map((item, i) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed 9-slot hotbar
            key={i}
            type="button"
            role="option"
            aria-selected={i === selected}
            aria-label={`Slot ${i + 1}`}
            onPointerDown={(e) => {
              e.stopPropagation()
              gameStore.set({ selected: i })
            }}
            className="relative flex items-center justify-center pointer-events-auto"
            style={{ width: SLOT, height: SLOT, boxShadow: 'inset 0 0 0 2px #8b8b8b55' }}
          >
            {item && <ItemIcon item={item} size={`calc(${SLOT} * 0.72)`} />}
            {i === selected && (
              <span
                aria-hidden
                className="pointer-events-none absolute -inset-[3px] border-[3px] border-white"
                style={{ boxShadow: '0 0 0 2px #000, inset 0 0 0 2px #000' }}
              />
            )}
          </button>
        ))}
      </div>
      {showMenuButton && (
        <button
          type="button"
          aria-label="Abrir inventário"
          onPointerDown={(e) => {
            e.stopPropagation()
            gameStore.set({ screen: 'inventory' })
          }}
          className="pointer-events-auto flex items-center justify-center border-2 border-black bg-black/45 text-white"
          style={{ width: SLOT, height: SLOT, boxShadow: 'inset 0 0 0 2px #5d5d5d' }}
        >
          <Ellipsis className="size-6" />
        </button>
      )}
    </div>
  )
}

function Crosshair() {
  const progress = useGame((s) => s.breakProgress)
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden>
      <div className="relative size-5 mix-blend-difference">
        <span className="absolute left-1/2 top-0 h-full w-[2px] -translate-x-1/2 bg-white" />
        <span className="absolute left-0 top-1/2 h-[2px] w-full -translate-y-1/2 bg-white" />
      </div>
      {progress > 0 && (
        <svg className="absolute size-14 -rotate-90" viewBox="0 0 40 40" aria-hidden>
          <circle cx="20" cy="20" r="16" fill="none" stroke="rgb(0 0 0 / 0.35)" strokeWidth="4" />
          <circle
            cx="20"
            cy="20"
            r="16"
            fill="none"
            stroke="#fff"
            strokeWidth="4"
            strokeDasharray={`${progress * 100.5} 100.5`}
          />
        </svg>
      )}
    </div>
  )
}

function Messages() {
  const itemLabel = useGame((s) => s.itemLabel)
  const toast = useGame((s) => s.toast)
  const hint = useGame((s) => s.hint)
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      {toast && (
        <p key={toast.id} className="fade-late mc-shadow text-base text-[#ffff55] md:text-lg">
          {toast.text}
        </p>
      )}
      {hint && <p className="mc-shadow max-w-[92vw] text-sm text-[#aaeeff] md:text-base">{hint}</p>}
      {itemLabel && (
        <p key={itemLabel.id} className="fade-late mc-shadow text-base text-white md:text-lg">
          {itemLabel.text}
        </p>
      )}
    </div>
  )
}

function Debug() {
  const debug = useGame((s) => s.debug)
  const info = useGame((s) => s.debugInfo)
  if (!debug) return null
  return (
    <pre className="absolute left-2 top-2 whitespace-pre font-sans text-sm leading-snug text-white">
      {info.split('\n').map((line) => (
        <span key={line} className="mb-0.5 block w-fit bg-black/40 px-1">
          {line}
        </span>
      ))}
    </pre>
  )
}

export function Hud() {
  const isTouch = useGame((s) => s.isTouch)
  const flying = useGame((s) => s.flying)
  const selectedItem = useGame((s) => s.hotbar[s.selected])
  const meterMode = useGame((s) => s.multimeterMode)
  const meterReading = useGame((s) => s.multimeterReading)
  const meterFirstProbe = useGame((s) => s.multimeterFirstProbe)
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <Crosshair />
      <Debug />
      {flying && (
        <p className="mc-shadow absolute left-1/2 top-3 -translate-x-1/2 text-sm text-[#55ffff] md:text-base" aria-live="polite">
          Voando
        </p>
      )}
      {selectedItem === 'multimeter' && (
        <div className="pointer-events-auto absolute left-1/2 top-3 z-30 w-[min(94vw,360px)] -translate-x-1/2 border-2 border-black bg-[#252a30] p-2 text-white" style={{ boxShadow: 'inset 0 0 0 2px #737b82' }}>
          <div className="flex items-center justify-between gap-2">
            <strong className="text-xs tracking-wide">MULTÍMETRO DIGITAL</strong>
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const modes = ['dc_voltage', 'dc_current', 'resistance', 'continuity', 'diode'] as const
                const next = modes[(modes.indexOf(meterMode) + 1) % modes.length]
                gameStore.set({ multimeterMode: next, multimeterFirstProbe: null, multimeterReading: 'Selecione o primeiro terminal.' })
              }}
              className="border border-white/50 bg-[#3c444b] px-2 py-1 text-xs"
            >
              {({ dc_voltage: 'V⎓ TENSÃO', dc_current: 'A⎓ CORRENTE', resistance: 'Ω RESISTÊNCIA', continuity: 'CONTINUIDADE', diode: 'TESTE DE DIODO' } as const)[meterMode]} ▾
            </button>
          </div>
          <p className="mt-1 min-h-9 border border-[#172c2a] bg-[#b9d8ca] px-2 py-1 font-mono text-xs text-[#17342e]">
            {meterFirstProbe ? 'PONTA 1 OK • selecione o segundo terminal' : meterReading}
          </p>
          <p className="mt-1 text-[10px] text-white/75">Toque em dois terminais expostos. Corrente exige ligação em série; Ω/continuidade exigem fonte desligada.</p>
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              gameStore.set({ multimeterFirstProbe: null, multimeterReading: 'Selecione o primeiro terminal.' })
            }}
            className="mt-1 border border-white/30 px-2 py-1 text-xs"
          >
            Limpar pontas
          </button>
        </div>
      )}
      {isTouch && selectedItem === 'paintbrush' && (
        <button
          type="button"
          onPointerDown={(e) => {
            e.stopPropagation()
            gameStore.set({ returnScreen: 'playing', screen: 'brush_color' })
          }}
          className="pointer-events-auto absolute bottom-24 left-1/2 -translate-x-1/2 border-2 border-black bg-black/70 px-3 py-2 text-sm text-white"
          style={{ boxShadow: 'inset 0 0 0 2px #5d5d5d' }}
        >
          Cor do pincel
        </button>
      )}
      <div
        className="absolute inset-x-0 flex flex-col items-center gap-2"
        style={{ bottom: 'max(10px, env(safe-area-inset-bottom))' }}
      >
        <Messages />
        <Hotbar showMenuButton={isTouch} />
      </div>
    </div>
  )
}
