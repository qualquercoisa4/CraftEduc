'use client'

import { Check, X } from 'lucide-react'
import { COLOR_VARIANTS } from '@/lib/game/constants'
import { gameStore, showToast, useGame } from '@/lib/game/store'

export function BrushColorPicker() {
  const brushColor = useGame((s) => s.brushColor)
  const returnScreen = useGame((s) => s.returnScreen)
  const close = () => gameStore.set({ screen: returnScreen === 'brush_color' ? 'playing' : returnScreen })

  return (
    <section className="absolute inset-0 z-40 flex items-center justify-center bg-black/65 p-3 backdrop-blur-[2px]">
      <div className="mc-panel w-full max-w-md space-y-4 p-4 sm:p-6" role="dialog" aria-modal="true" aria-labelledby="brush-color-title">
        <div className="flex items-center justify-between gap-3">
          <h2 id="brush-color-title" className="font-display text-base text-[#303030] sm:text-lg">COR DO PINCEL</h2>
          <button type="button" aria-label="Fechar paleta" onClick={close} className="mc-slot size-9 text-[#333]">
            <X className="size-5" />
          </button>
        </div>
        <p className="text-sm leading-5 text-[#444]">Escolha uma das 16 cores ou selecione uma cor personalizada.</p>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
          {COLOR_VARIANTS.map((variant) => (
            <button
              key={variant.id}
              type="button"
              title={variant.name}
              aria-label={variant.name}
              aria-pressed={brushColor.toLowerCase() === variant.color.toLowerCase()}
              onClick={() => gameStore.set({ brushColor: variant.color })}
              className="aspect-square rounded-sm border-2 border-black"
              style={{
                backgroundColor: variant.color,
                outline: brushColor.toLowerCase() === variant.color.toLowerCase() ? '3px solid #fff' : undefined,
                outlineOffset: '1px',
                boxShadow: 'inset 2px 2px 0 #ffffff55, inset -2px -2px 0 #00000035',
              }}
            />
          ))}
        </div>
        <label className="flex items-center justify-between gap-3 text-sm text-[#333]">
          <span>Cor personalizada</span>
          <input aria-label="Escolher cor personalizada" type="color" value={brushColor}
            onChange={(event) => gameStore.set({ brushColor: event.target.value })}
            className="h-10 w-16 cursor-pointer border-2 border-black bg-transparent p-0.5"
          />
        </label>
        <div className="flex gap-2">
          <button type="button" className="mc-btn flex-1" onClick={close}>Cancelar</button>
          <button type="button" className="mc-btn flex-1" onClick={() => {
            showToast('Pincel configurado: ' + gameStore.get().brushColor.toUpperCase())
            gameStore.set({ screen: returnScreen === 'brush_color' ? 'playing' : returnScreen })
          }}>
            <Check className="mr-2 inline size-4" />Aplicar
          </button>
        </div>
      </div>
    </section>
  )
}
