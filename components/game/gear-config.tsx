'use client'

import { useEffect, useState } from 'react'
import { getEngine } from '@/lib/game/engine'
import { MAX_GEAR_TEETH, MIN_GEAR_TEETH } from '@/lib/game/gear-train'
import { gameStore, showToast, useGame } from '@/lib/game/store'

export function GearConfig() {
  const key=useGame(state=>state.gearConfigKey)
  const [teeth,setTeeth]=useState(24)
  useEffect(()=>{
    if(!key)return
    const config=getEngine()?.mech.getGearConfig(key)
    if(config)setTeeth(config.teeth)
  },[key])
  if(!key)return null
  const close=()=>gameStore.set({gearConfigKey:null,screen:'playing'})
  const save=()=>{
    if(!getEngine()?.mech.configureGear(key,teeth)){showToast('Não foi possível configurar esta engrenagem');close();return}
    showToast(`Engrenagem configurada com ${teeth} dentes`)
    close()
  }
  return (
    <section className="absolute inset-0 z-40 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]">
      <div className="mc-panel w-full max-w-md p-5 text-[#303030] sm:p-6" role="dialog" aria-modal="true" aria-labelledby="gear-config-title">
        <h2 id="gear-config-title" className="font-display text-center text-lg">ENGRENAGEM</h2>
        <p className="mt-2 text-center text-sm text-[#444]">Defina a quantidade de dentes. O envelope da peça permanece igual; a geometria dos dentes e a relação de transmissão são recalculadas.</p>
        <div className="mt-6 rounded border-2 border-black/20 bg-[#eee7dc] p-4">
          <div className="mx-auto flex size-32 items-center justify-center rounded-full border-[10px] border-[#87919c] bg-[#c6ccd2] shadow-inner">
            <div className="flex size-14 items-center justify-center rounded-full border-[7px] border-[#8c969f] bg-[#b7bec6]"><span className="size-4 rounded-full bg-[#5f6872]" /></div>
          </div>
          <p className="mt-3 text-center text-3xl font-bold tabular-nums">{teeth}</p>
          <p className="text-center text-sm text-[#555]">dentes</p>
        </div>
        <label className="mt-5 block text-sm">
          <span className="mb-2 flex items-center justify-between font-semibold"><span>Quantidade de dentes</span><span className="tabular-nums">{teeth}</span></span>
          <input aria-label="Quantidade de dentes da engrenagem" type="range" min={MIN_GEAR_TEETH} max={MAX_GEAR_TEETH} step={1} value={teeth} onChange={event=>setTeeth(Number(event.target.value))} className="w-full accent-[#303030]" />
          <span className="mt-1 flex justify-between text-xs text-[#555]"><span>{MIN_GEAR_TEETH}</span><span>{MAX_GEAR_TEETH}</span></span>
        </label>
        <div className="mt-4 border-t border-black/20 pt-3 text-xs leading-5 text-[#555]">O encaixe exige eixos paralelos, linha de centros no plano das engrenagens e módulo compatível. Pares incompatíveis não serão animados.</div>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button type="button" className="mc-btn" onClick={close}>Cancelar</button>
          <button type="button" className="mc-btn" onClick={save}>Salvar</button>
        </div>
      </div>
    </section>
  )
}
