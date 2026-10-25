'use client'

import { useEffect, useState } from 'react'
import { getEngine } from '@/lib/game/engine'
import {
  RESISTOR_DIGIT_COLORS,
  RESISTOR_MULTIPLIER_COLORS,
  RESISTOR_TOLERANCE_COLORS,
  resistorValueOhms,
} from '@/lib/game/electrical'
import { gameStore, showToast, useGame } from '@/lib/game/store'

const MULTIPLIERS = [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
const TOLERANCES = [10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05]

function formatResistance(value: number) {
  if (value >= 1e9) return `${(value / 1e9).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} GΩ`
  if (value >= 1e6) return `${(value / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} MΩ`
  if (value >= 1e3) return `${(value / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} kΩ`
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} Ω`
}

export function ResistorConfig() {
  const key = useGame((state) => state.resistorConfigKey)
  const [digit1, setDigit1] = useState(1)
  const [digit2, setDigit2] = useState(0)
  const [multiplier, setMultiplier] = useState(1)
  const [tolerance, setTolerance] = useState(5)

  useEffect(() => {
    if (!key) return
    const config = getEngine()?.mech.getResistorConfig(key)
    if (!config) return
    setDigit1(config.digit1)
    setDigit2(config.digit2)
    setMultiplier(config.multiplier)
    setTolerance(config.tolerance)
  }, [key])

  if (!key) return null

  const close = () => gameStore.set({ resistorConfigKey: null, screen: 'playing' })
  const save = () => {
    const engine = getEngine()
    if (!engine?.mech.configureResistor(key, digit1, digit2, multiplier, tolerance)) {
      showToast('Não foi possível configurar este resistor')
      close()
      return
    }
    showToast(`Resistor configurado para ${formatResistance(resistorValueOhms(digit1, digit2, multiplier))} ±${tolerance}%`)
    close()
  }

  const bands = [
    { label: '1º dígito', color: RESISTOR_DIGIT_COLORS[digit1] },
    { label: '2º dígito', color: RESISTOR_DIGIT_COLORS[digit2] },
    { label: 'Multiplicador', color: RESISTOR_MULTIPLIER_COLORS[multiplier] ?? RESISTOR_DIGIT_COLORS[0] },
    { label: 'Tolerância', color: RESISTOR_TOLERANCE_COLORS[tolerance] ?? RESISTOR_TOLERANCE_COLORS[5] },
  ]
  const resistance = resistorValueOhms(digit1, digit2, multiplier)

  return (
    <section className="absolute inset-0 z-40 flex items-center justify-center bg-black/65 p-3 backdrop-blur-[2px]">
      <div className="mc-panel max-h-full w-full max-w-lg overflow-y-auto p-4 text-[#303030] sm:p-6" role="dialog" aria-modal="true" aria-labelledby="resistor-config-title">
        <h2 id="resistor-config-title" className="font-display text-center text-lg">RESISTOR DE 4 FAIXAS</h2>
        <p className="mt-2 text-center text-sm text-[#444]">
          Configure os dois dígitos significativos, o multiplicador e a tolerância. As faixas do componente e o valor elétrico são atualizados juntos.
        </p>

        <div className="mt-5 rounded border-2 border-black/20 bg-[#eee7dc] px-4 py-5">
          <div className="mx-auto flex max-w-sm items-center justify-center gap-2" aria-label="Prévia das quatro faixas do resistor">
            <span className="h-2 w-8 rounded-sm bg-[#adb1b6]" />
            <div className="relative flex h-12 flex-1 items-center justify-center rounded-full border border-[#9f8968] bg-[#d8c5a0] shadow-inner">
              {bands.map((band) => (
                <span
                  key={band.label}
                  title={`${band.label}: ${band.color}`}
                  className="mx-1 h-full w-3 border-x border-black/10"
                  style={{ backgroundColor: band.color }}
                />
              ))}
            </div>
            <span className="h-2 w-8 rounded-sm bg-[#adb1b6]" />
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1 text-center text-[10px] leading-tight text-[#4b4236]">
            {bands.map((band) => <span key={band.label}>{band.label}</span>)}
          </div>
          <p className="mt-3 text-center text-2xl font-bold tabular-nums">{formatResistance(resistance)}</p>
          <p className="text-center text-sm text-[#555]">Tolerância nominal: ±{tolerance}%</p>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-semibold">1ª faixa — primeiro dígito</span>
            <select value={digit1} onChange={(event) => setDigit1(Number(event.target.value))} className="w-full border-2 border-black bg-white px-3 py-2">
              {Array.from({ length: 10 }, (_, value) => <option key={value} value={value}>{value} — {['preto', 'marrom', 'vermelho', 'laranja', 'amarelo', 'verde', 'azul', 'violeta', 'cinza', 'branco'][value]}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-semibold">2ª faixa — segundo dígito</span>
            <select value={digit2} onChange={(event) => setDigit2(Number(event.target.value))} className="w-full border-2 border-black bg-white px-3 py-2">
              {Array.from({ length: 10 }, (_, value) => <option key={value} value={value}>{value} — {['preto', 'marrom', 'vermelho', 'laranja', 'amarelo', 'verde', 'azul', 'violeta', 'cinza', 'branco'][value]}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-semibold">3ª faixa — multiplicador</span>
            <select value={multiplier} onChange={(event) => setMultiplier(Number(event.target.value))} className="w-full border-2 border-black bg-white px-3 py-2">
              {MULTIPLIERS.map((power) => (
                <option key={power} value={power}>{power === -2 ? '×0,01' : power === -1 ? '×0,1' : `×10^${power}`}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-semibold">4ª faixa — tolerância</span>
            <select value={tolerance} onChange={(event) => setTolerance(Number(event.target.value))} className="w-full border-2 border-black bg-white px-3 py-2">
              {TOLERANCES.map((value) => <option key={value} value={value}>±{value}%</option>)}
            </select>
          </label>
        </div>

        <p className="mt-4 text-xs leading-5 text-[#555]">
          Conecte os fios aos terminais metálicos nas duas extremidades. O resistor atua em série entre A e B; a resistência afeta a corrente e a queda de tensão do circuito.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button type="button" className="mc-btn" onClick={close}>Cancelar</button>
          <button type="button" className="mc-btn" onClick={save}>Salvar</button>
        </div>
      </div>
    </section>
  )
}
