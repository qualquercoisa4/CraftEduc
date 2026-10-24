'use client'

import { Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CATEGORIES, ITEMS, ITEM_ORDER, type ItemId } from '@/lib/game/constants'
import { gameStore, useGame } from '@/lib/game/store'
import { ItemIcon } from './item-icon'

const SLOT = 'clamp(34px, 8.6vw, 46px)'
const ROWS = 5

export function Inventory() {
  const tab = useGame((s) => s.inventoryTab)
  const hotbar = useGame((s) => s.hotbar)
  const selected = useGame((s) => s.selected)
  const isTouch = useGame((s) => s.isTouch)
  const [cursor, setCursor] = useState<ItemId | null>(null)
  const [hover, setHover] = useState<ItemId | null>(null)
  const [mouse, setMouse] = useState({ x: 0, y: 0 })

  const items = ITEM_ORDER.filter((i) => tab === 'all' || ITEMS[i].category === tab)
  const cells: (ItemId | null)[] = [...items]
  while (cells.length < ROWS * 9) cells.push(null)
  const activeTab = CATEGORIES.find((c) => c.id === tab)!

  const setSlot = (i: number, item: ItemId | null) => {
    const next = [...gameStore.get().hotbar]
    next[i] = item
    gameStore.set({ hotbar: next })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hover || !e.code.startsWith('Digit')) return
      const n = Number(e.code.slice(5))
      if (n >= 1 && n <= 9) setSlot(n - 1, hover)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hover])

  const pickFromGrid = (item: ItemId, shift: boolean) => {
    if (isTouch) {
      setSlot(gameStore.get().selected, item)
      return
    }
    if (shift) {
      const hb = gameStore.get().hotbar
      const empty = hb.indexOf(null)
      setSlot(empty >= 0 ? empty : gameStore.get().selected, item)
      return
    }
    setCursor(item)
  }

  const clickHotbar = (i: number) => {
    if (isTouch) {
      gameStore.set({ selected: i })
      return
    }
    if (cursor) {
      const prev = hotbar[i]
      setSlot(i, cursor)
      setCursor(prev && prev !== cursor ? prev : null)
    } else if (hotbar[i]) {
      setCursor(hotbar[i])
      setSlot(i, null)
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop handles cursor drop
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-2"
      onMouseMove={(e) => setMouse({ x: e.clientX, y: e.clientY })}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) setCursor(null)
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Inventário criativo"
    >
      <div className="flex max-h-full max-w-full flex-col overflow-y-auto">
        <div className="flex max-w-full gap-0.5 overflow-x-auto" role="tablist" aria-label="Categorias">
          {CATEGORIES.map((c) => {
            const active = c.id === tab
            return (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => gameStore.set({ inventoryTab: c.id })}
                className={`mc-panel flex shrink-0 items-center gap-1.5 px-2 text-sm md:text-base ${
                  active ? 'relative z-10 -mb-[3px] pb-2 pt-1.5' : 'mt-1 bg-[#a0a0a0] py-1 brightness-90'
                }`}
                style={active ? { boxShadow: 'inset 3px 3px 0 #fff, inset -3px 0 0 #555', borderBottom: 'none' } : undefined}
              >
                <ItemIcon item={c.icon} size="22px" />
                <span className="whitespace-nowrap">{c.label}</span>
              </button>
            )
          })}
        </div>

        <div className="mc-panel p-3">
          <div className="mb-2 flex items-center justify-between gap-4">
            <h2 className="text-base font-medium text-[#3f3f3f] md:text-lg">
              {'Inventário Criativo — '}
              {activeTab.label}
            </h2>
            <button
              type="button"
              onClick={() => gameStore.set({ screen: 'playing' })}
              aria-label="Fechar inventário"
              className="mc-slot size-8 text-[#3f3f3f]"
            >
              <X className="size-5" />
            </button>
          </div>

          <div className="grid grid-cols-9 gap-0.5">
            {cells.map((item, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: grid cells are positional
                key={i}
                type="button"
                disabled={!item}
                aria-label={item ? ITEMS[item].name : 'Vazio'}
                onMouseEnter={() => setHover(item)}
                onMouseLeave={() => setHover(null)}
                onClick={(e) => item && pickFromGrid(item, e.shiftKey)}
                className="mc-slot disabled:hover:bg-[#8b8b8b]"
                style={{ width: SLOT, height: SLOT }}
              >
                {item && <ItemIcon item={item} size={`calc(${SLOT} * 0.78)`} />}
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-end gap-2">
            <div className="grid grid-cols-9 gap-0.5">
              {hotbar.map((item, i) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed hotbar
                  key={i}
                  type="button"
                  aria-label={`Slot ${i + 1}${item ? `: ${ITEMS[item].name}` : ''}`}
                  onMouseEnter={() => setHover(item)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => clickHotbar(i)}
                  className="mc-slot"
                  style={{
                    width: SLOT,
                    height: SLOT,
                    outline: i === selected ? '2px solid #fff' : undefined,
                    outlineOffset: '-2px',
                  }}
                >
                  {item && <ItemIcon item={item} size={`calc(${SLOT} * 0.78)`} />}
                </button>
              ))}
            </div>
            {!isTouch && (
              <button
                type="button"
                aria-label="Destruir item"
                onClick={() => setCursor(null)}
                className="mc-slot text-[#5a1f1f]"
                style={{ width: SLOT, height: SLOT }}
              >
                <Trash2 className="size-5" />
              </button>
            )}
          </div>
          <p className="mt-2 text-sm text-[#555]">
            {isTouch
              ? 'Toque num item para colocá-lo no slot selecionado. Toque num slot para selecioná-lo.'
              : 'Clique para pegar • Shift+clique envia à barra • Teclas 1–9 sobre um item • E fecha'}
          </p>
        </div>
      </div>

      {!isTouch && hover && !cursor && (
        <div
          className="mc-tooltip pointer-events-none fixed z-50 max-w-64 px-2 py-1"
          style={{ left: mouse.x + 14, top: mouse.y - 30 }}
        >
          <p className="text-white">{ITEMS[hover].name}</p>
          <p className="text-sm leading-snug text-[#a8a8a8]">{ITEMS[hover].description}</p>
          {ITEMS[hover].physicalInfo && <p className="mt-1 text-[10px] leading-snug text-[#74d8ff]">{ITEMS[hover].physicalInfo}</p>}
          <p className="mt-1 text-sm text-[#5555ff]">
            {CATEGORIES.find((c) => c.id === ITEMS[hover].category)?.label}
          </p>
        </div>
      )}
      {cursor && (
        <div className="pointer-events-none fixed z-50" style={{ left: mouse.x - 20, top: mouse.y - 20 }}>
          <ItemIcon item={cursor} size="40px" />
        </div>
      )}
    </div>
  )
}
