'use client'

import { ArrowBigUp, ChevronDown, ChevronUp, ChevronsDown, Feather, Pause } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { getEngine } from '@/lib/game/engine'
import { gameStore, useGame } from '@/lib/game/store'

type TouchKey = 'jump' | 'sneak' | 'flyUp' | 'flyDown'

function HoldButton({
  label,
  field,
  children,
  className = '',
  active = false,
}: {
  label: string
  field: TouchKey
  children: ReactNode
  className?: string
  active?: boolean
}) {
  const [down, setDown] = useState(false)
  const set = (v: boolean) => {
    const e = getEngine()
    if (e) e.touch[field] = v
    setDown(v)
  }
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={(e) => {
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        set(true)
      }}
      onPointerUp={() => set(false)}
      onPointerCancel={() => set(false)}
      onLostPointerCapture={() => set(false)}
      className={`pointer-events-auto flex touch-none items-center justify-center border-2 text-white ${
        down || active ? 'border-white bg-white/35' : 'border-black/60 bg-black/30'
      } ${className}`}
    >
      {children}
    </button>
  )
}

function TapButton({ label, onTap, children, className = '', active = false }: {
  label: string
  onTap: () => void
  children: ReactNode
  className?: string
  active?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={(e) => {
        e.stopPropagation()
        onTap()
      }}
      className={`pointer-events-auto flex touch-none items-center justify-center border-2 text-white ${
        active ? 'border-[#55ffff] bg-[#2f7dff]/50' : 'border-black/60 bg-black/30'
      } ${className}`}
    >
      {children}
    </button>
  )
}

function Joystick() {
  const base = useRef<HTMLDivElement>(null)
  const [knob, setKnob] = useState({ x: 0, y: 0 })
  const pid = useRef<number | null>(null)

  const update = (cx: number, cy: number) => {
    const el = base.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const radius = r.width / 2
    let dx = cx - (r.left + radius)
    let dy = cy - (r.top + radius)
    const len = Math.hypot(dx, dy)
    if (len > radius) {
      dx = (dx / len) * radius
      dy = (dy / len) * radius
    }
    setKnob({ x: dx, y: dy })
    const e = getEngine()
    if (e) {
      const nx = dx / radius
      const ny = dy / radius
      e.touch.moveX = Math.abs(nx) < 0.15 ? 0 : nx
      e.touch.moveY = Math.abs(ny) < 0.15 ? 0 : -ny
      e.touch.sprint = -ny > 0.92
    }
  }
  const reset = () => {
    pid.current = null
    setKnob({ x: 0, y: 0 })
    const e = getEngine()
    if (e) {
      e.touch.moveX = 0
      e.touch.moveY = 0
      e.touch.sprint = false
    }
  }

  return (
    <div
      ref={base}
      role="application"
      aria-label="Direcional para andar"
      onPointerDown={(e) => {
        e.stopPropagation()
        pid.current = e.pointerId
        e.currentTarget.setPointerCapture(e.pointerId)
        update(e.clientX, e.clientY)
      }}
      onPointerMove={(e) => {
        if (pid.current === e.pointerId) update(e.clientX, e.clientY)
      }}
      onPointerUp={reset}
      onPointerCancel={reset}
      className="pointer-events-auto relative size-32 touch-none rounded-full border-2 border-black/50 bg-black/25"
    >
      <div
        className="absolute left-1/2 top-1/2 size-14 rounded-full border-2 border-white/80 bg-white/30"
        style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }}
      />
    </div>
  )
}

function LookArea() {
  const pid = useRef<number | null>(null)
  const last = useRef({ x: 0, y: 0, total: 0 })
  return (
    <div
      aria-hidden
      className="pointer-events-auto absolute inset-0 touch-none"
      onPointerDown={(e) => {
        if (pid.current !== null) return
        pid.current = e.pointerId
        last.current = { x: e.clientX, y: e.clientY, total: 0 }
        e.currentTarget.setPointerCapture(e.pointerId)
        getEngine()?.touchPress()
      }}
      onPointerMove={(e) => {
        if (pid.current !== e.pointerId) return
        const dx = e.clientX - last.current.x
        const dy = e.clientY - last.current.y
        last.current.x = e.clientX
        last.current.y = e.clientY
        last.current.total += Math.abs(dx) + Math.abs(dy)
        const eng = getEngine()
        eng?.look(dx, dy, 0.0065)
        if (last.current.total > 14) eng?.touchMoved()
      }}
      onPointerUp={(e) => {
        if (pid.current !== e.pointerId) return
        pid.current = null
        getEngine()?.touchRelease()
      }}
      onPointerCancel={(e) => {
        if (pid.current !== e.pointerId) return
        pid.current = null
        getEngine()?.touchMoved()
        getEngine()?.touchRelease()
      }}
    />
  )
}

export function MobileControls() {
  const flying = useGame((s) => s.flying)
  const sneaking = useGame((s) => s.sneaking)
  const lift = 'calc(clamp(38px, 9.4vw, 54px) + 22px + env(safe-area-inset-bottom))'

  return (
    <div className="pointer-events-none absolute inset-0 z-[5]">
      <LookArea />

      <div
        className="absolute"
        style={{ top: 'max(12px, env(safe-area-inset-top))', right: 'max(12px, env(safe-area-inset-right))' }}
      >
        <TapButton label="Pausar" onTap={() => gameStore.set({ screen: 'paused' })} className="size-11">
          <Pause className="size-5" />
        </TapButton>
      </div>

      <div className="absolute" style={{ left: 'max(20px, env(safe-area-inset-left))', bottom: lift }}>
        <Joystick />
      </div>

      <div
        className="absolute grid grid-cols-2 gap-2"
        style={{ right: 'max(20px, env(safe-area-inset-right))', bottom: lift }}
      >
        <TapButton
          label={flying ? 'Desativar voo' : 'Ativar voo'}
          onTap={() => getEngine()?.toggleFly()}
          active={flying}
          className="col-start-2 size-14"
        >
          <Feather className="size-6" />
        </TapButton>
        {flying ? (
          <>
            <HoldButton label="Descer" field="flyDown" className="size-14">
              <ChevronDown className="size-8" />
            </HoldButton>
            <HoldButton label="Subir" field="flyUp" className="size-16">
              <ChevronUp className="size-9" />
            </HoldButton>
          </>
        ) : (
          <>
            <HoldButton label="Agachar" field="sneak" className="size-14 self-end" active={sneaking}>
              <ChevronsDown className="size-7" />
            </HoldButton>
            <HoldButton label="Pular" field="jump" className="size-16">
              <ArrowBigUp className="size-9" />
            </HoldButton>
          </>
        )}
      </div>
    </div>
  )
}
