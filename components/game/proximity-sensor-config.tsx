'use client'

import { useEffect, useState } from 'react'
import { getEngine } from '@/lib/game/engine'
import { gameStore, showToast, useGame } from '@/lib/game/store'
import type { ProximityComparison } from '@/lib/game/mechanics'

export function ProximitySensorConfig() {
  const key = useGame((state) => state.sensorConfigKey)
  const [operator, setOperator] = useState<ProximityComparison>('less')
  const [distance, setDistance] = useState(3)

  useEffect(() => {
    if (!key) return
    const config = getEngine()?.mech.getProximitySensorConfig(key)
    if (config) {
      setOperator(config.operator)
      setDistance(config.threshold)
    }
  }, [key])

  if (!key) return null

  const close = () => gameStore.set({ sensorConfigKey: null, screen: 'playing' })
  const save = () => {
    const engine = getEngine()
    const threshold = Math.max(1, Math.min(32, Math.floor(Number(distance) || 1)))
    if (!engine?.mech.configureProximitySensor(key, operator, threshold)) {
      showToast('Não foi possível configurar este sensor')
      close()
      return
    }
    showToast('Configuração do sensor salva')
    close()
  }

  return (
    <section className="absolute inset-0 z-40 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]">
      <div className="mc-panel w-full max-w-md p-5 text-[#303030] sm:p-6" role="dialog" aria-modal="true" aria-labelledby="sensor-config-title">
        <h2 id="sensor-config-title" className="font-display text-center text-lg">SENSOR DE PROXIMIDADE</h2>
        <p className="mt-2 text-center text-sm text-[#444]">Configure quando o sensor deve liberar energia.</p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-sm">
          <span>Quando a distância do objeto for</span>
          <select
            aria-label="Comparação de distância"
            value={operator}
            onChange={(event) => setOperator(event.target.value as ProximityComparison)}
            className="border-2 border-black bg-white px-2 py-2 font-semibold"
          >
            <option value="less">menor que</option>
            <option value="greater">maior que</option>
          </select>
        </div>

        <label className="mt-4 flex items-center justify-center gap-3 text-sm">
          <span>Distância (blocos)</span>
          <input
            aria-label="Distância em blocos"
            type="number"
            min={1}
            max={32}
            step={1}
            value={distance}
            onChange={(event) => setDistance(Math.max(1, Math.min(32, Number(event.target.value) || 1)))}
            className="w-24 border-2 border-black bg-white px-3 py-2 text-center font-bold"
          />
        </label>

        <p className="mt-3 text-center text-xs leading-5 text-[#555]">
          Mede até 32 blocos à frente. Sem obstáculo nessa faixa, a distância é considerada maior que 32 blocos.
          Use Shift + botão direito no sensor para mudar a direção.
        </p>

        <div className="mt-6 grid grid-cols-2 gap-3">
          <button type="button" className="mc-btn" onClick={close}>Cancelar</button>
          <button type="button" className="mc-btn" onClick={save}>Salvar</button>
        </div>
      </div>
    </section>
  )
}
