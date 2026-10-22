'use client'

import { useEffect, useState, type ChangeEvent } from 'react'
import { getEngine } from '@/lib/game/engine'
import { gameStore, showToast, useGame } from '@/lib/game/store'

export function ServoConfig() {
  const key = useGame((state) => state.servoConfigKey)
  const [offAngle, setOffAngle] = useState(0)
  const [onAngle, setOnAngle] = useState(90)

  useEffect(() => {
    if (!key) return
    const config = getEngine()?.mech.getServoConfig(key)
    if (config) {
      setOffAngle(config.offAngle)
      setOnAngle(config.onAngle)
    }
  }, [key])

  if (!key) return null

  const close = () => gameStore.set({ servoConfigKey: null, screen: 'playing' })
  const save = () => {
    const engine = getEngine()
    const off = Math.max(0, Math.min(180, Math.round(Number(offAngle) || 0)))
    const on = Math.max(0, Math.min(180, Math.round(Number(onAngle) || 0)))
    if (!engine?.mech.configureServo(key, off, on)) {
      showToast('Não foi possível configurar este servo')
      close()
      return
    }
    showToast('Configuração do servo salva')
    close()
  }

  const boundedInput = (value: number, setValue: (next: number) => void) => (event: ChangeEvent<HTMLInputElement>) => {
    const parsed = Number(event.target.value)
    setValue(Number.isFinite(parsed) ? Math.max(0, Math.min(180, Math.round(parsed))) : value)
  }

  return (
    <section className="absolute inset-0 z-40 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]">
      <div className="mc-panel w-full max-w-md p-5 text-[#303030] sm:p-6" role="dialog" aria-modal="true" aria-labelledby="servo-config-title">
        <h2 id="servo-config-title" className="font-display text-center text-lg">SERVO MOTOR</h2>
        <p className="mt-2 text-center text-sm text-[#444]">
          Defina o ângulo do eixo quando o sinal estiver desligado e quando estiver ligado.
        </p>

        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-2 block font-semibold">Posição desligado (°)</span>
            <input
              aria-label="Posição desligado em graus"
              type="number"
              min={0}
              max={180}
              step={1}
              value={offAngle}
              onChange={boundedInput(offAngle, setOffAngle)}
              className="w-full border-2 border-black bg-white px-3 py-2 text-center font-bold"
            />
            <span className="mt-1 block text-xs text-[#555]">0° a 180°</span>
          </label>
          <label className="block text-sm">
            <span className="mb-2 block font-semibold">Posição ligado (°)</span>
            <input
              aria-label="Posição ligado em graus"
              type="number"
              min={0}
              max={180}
              step={1}
              value={onAngle}
              onChange={boundedInput(onAngle, setOnAngle)}
              className="w-full border-2 border-black bg-white px-3 py-2 text-center font-bold"
            />
            <span className="mt-1 block text-xs text-[#555]">0° a 180°</span>
          </label>
        </div>

        <div className="mt-5 border-t border-black/20 pt-4 text-sm leading-6 text-[#444]">
          <p><strong>Marrom:</strong> GND / negativo</p>
          <p><strong>Vermelho:</strong> VCC / positivo</p>
          <p><strong>Amarelo:</strong> sinal / comando</p>
          <p className="mt-2 text-xs">
            Para este protótipo, conecte GND ao negativo. VCC e sinal podem usar a mesma fonte positiva (os dois podem compartilhar a mesma rede). Quando ambos estiverem positivos, o servo vai à posição ligado; quando o sinal perder o positivo, retorna à posição desligado.
          </p>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3">
          <button type="button" className="mc-btn" onClick={close}>Cancelar</button>
          <button type="button" className="mc-btn" onClick={save}>Salvar</button>
        </div>
      </div>
    </section>
  )
}
