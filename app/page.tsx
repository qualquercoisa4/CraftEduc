'use client'

import { useEffect, useRef, useState } from 'react'
import { Engine } from '@/lib/game/engine'
import { gameStore, useGame } from '@/lib/game/store'
import { Hud } from '@/components/game/hud'
import { Inventory } from '@/components/game/inventory'
import { MobileControls } from '@/components/game/mobile-controls'

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const screen = useGame((s) => s.screen)
  const isTouch = useGame((s) => s.isTouch)
  const returnScreen = useGame((s) => s.returnScreen)
  const settings = useGame((s) => s.settings)
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const touch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
    gameStore.set({ isTouch: touch })
    let engine: Engine
    try {
      engine = new Engine(canvas)
    } catch (error) {
      setBootError(error instanceof Error ? error.message : 'Não foi possível iniciar o renderizador 3D.')
      return
    }
    return () => engine.dispose()
  }, [])

  const openSubscreen = (next: 'options' | 'controls') => {
    gameStore.set({ returnScreen: screen === 'paused' ? 'paused' : 'title', screen: next })
  }
  const returnFromSubscreen = () => {
    gameStore.set({ screen: returnScreen === 'paused' ? 'paused' : 'title' })
  }
  const startGame = () => gameStore.set({ screen: 'playing' })
  const pauseGame = () => gameStore.set({ screen: 'paused' })

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-[#0b1a3a] text-white">
      <canvas
        ref={canvasRef}
        aria-label="Mundo 3D de CraftEduc"
        className="absolute inset-0 block h-full w-full touch-none"
      />

      {bootError && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black p-6 text-center">
          <div className="max-w-lg">
            <h1 className="font-display text-xl">CRAFTEDUC</h1>
            <p className="mt-4 text-sm text-red-200">Não foi possível iniciar o jogo 3D neste dispositivo.</p>
            <p className="mt-2 break-words text-xs text-white/70">{bootError}</p>
          </div>
        </div>
      )}

      {!bootError && screen === 'title' && (
        <section className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/35 px-4 py-6 text-center">
          <div className="max-w-3xl">
            <p className="mb-3 text-xs tracking-[0.28em] text-cyan-200 sm:text-sm">UM MUNDO DE ROBÓTICA</p>
            <h1 className="font-display mc-shadow text-3xl leading-relaxed text-white sm:text-5xl">CRAFTEDUC</h1>
            <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-white/85 sm:text-base">
              Construa, conecte fios e experimente com motores, LEDs e pilhas em um mundo de blocos.
            </p>
          </div>
          <div className="mt-2 flex w-full max-w-xs flex-col gap-3">
            <button className="mc-btn" onClick={startGame}>Jogar</button>
            <button className="mc-btn" onClick={() => openSubscreen('controls')}>Controles</button>
            <button className="mc-btn" onClick={() => openSubscreen('options')}>Opções</button>
          </div>
          <p className="mt-2 text-xs text-white/60">Protótipo educacional • Modo criativo</p>
        </section>
      )}

      {!bootError && screen === 'playing' && (
        <>
          <Hud />
          {isTouch && <MobileControls />}
          {!isTouch && (
            <button
              type="button"
              aria-label="Pausar jogo"
              onClick={pauseGame}
              className="pointer-events-auto absolute right-3 top-3 z-20 border-2 border-black bg-black/40 px-3 py-2 text-sm text-white hover:bg-black/60"
            >
              Pausar
            </button>
          )}
        </>
      )}

      {!bootError && screen === 'inventory' && <Inventory />}

      {!bootError && screen === 'paused' && (
        <section className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/55 px-4 text-center backdrop-blur-[2px]">
          <h1 className="font-display mc-shadow text-2xl sm:text-3xl">JOGO PAUSADO</h1>
          <div className="mt-3 flex w-full max-w-xs flex-col gap-3">
            <button className="mc-btn" onClick={startGame}>Continuar</button>
            <button className="mc-btn" onClick={() => openSubscreen('controls')}>Controles</button>
            <button className="mc-btn" onClick={() => openSubscreen('options')}>Opções</button>
            <button className="mc-btn" onClick={() => gameStore.set({ screen: 'title' })}>Voltar ao menu</button>
          </div>
        </section>
      )}

      {!bootError && screen === 'controls' && (
        <section className="absolute inset-0 z-20 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]">
          <div className="mc-panel w-full max-w-lg p-4 sm:p-6">
            <h2 className="font-display text-center text-base text-[#303030]">CONTROLES</h2>
            <div className="mt-5 space-y-3 text-sm leading-6 text-[#333]">
              <p><strong>Movimento:</strong> W A S D ou setas. Espaço pula; Shift agacha; Ctrl corre.</p>
              <p><strong>Câmera:</strong> mova o mouse. No celular, arraste o lado direito da tela.</p>
              <p><strong>Blocos:</strong> botão esquerdo quebra; botão direito coloca ou usa. Teclas 1–9 selecionam a barra.</p>
              <p><strong>Inventário:</strong> E abre e fecha. Pressione Espaço duas vezes para alternar o voo.</p>
              <p><strong>Robótica:</strong> use fios para conectar componentes, coloque pilhas na caixa de bateria e aplique cola quente para fixar peças.</p>
              <p><strong>Celular:</strong> use o direcional esquerdo para andar e os botões à direita para pular, agachar ou voar.</p>
            </div>
            <button className="mc-btn mt-5" onClick={returnFromSubscreen}>Voltar</button>
          </div>
        </section>
      )}

      {!bootError && screen === 'options' && (
        <section className="absolute inset-0 z-20 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]">
          <div className="mc-panel w-full max-w-lg space-y-5 p-4 sm:p-6">
            <h2 className="font-display text-center text-base text-[#303030]">OPÇÕES</h2>
            <label className="block text-sm text-[#333]">
              <span className="mb-2 flex justify-between gap-3"><span>Distância de renderização</span><strong>{settings.renderDistance} chunks</strong></span>
              <input
                type="range"
                min={3}
                max={isTouch ? 5 : 12}
                value={settings.renderDistance}
                onChange={(e) => gameStore.set({ settings: { ...gameStore.get().settings, renderDistance: Number(e.target.value) } })}
                className="mc-range h-10 border-2 border-black bg-[#8b8b8b]"
              />
            </label>
            <label className="block text-sm text-[#333]">
              <span className="mb-2 flex justify-between gap-3"><span>Campo de visão (FOV)</span><strong>{settings.fov}°</strong></span>
              <input
                type="range"
                min={55}
                max={100}
                value={settings.fov}
                onChange={(e) => gameStore.set({ settings: { ...gameStore.get().settings, fov: Number(e.target.value) } })}
                className="mc-range h-10 border-2 border-black bg-[#8b8b8b]"
              />
            </label>
            <label className="block text-sm text-[#333]">
              <span className="mb-2 flex justify-between gap-3"><span>Sensibilidade</span><strong>{settings.sensitivity.toFixed(1)}×</strong></span>
              <input
                type="range"
                min={0.3}
                max={2.5}
                step={0.1}
                value={settings.sensitivity}
                onChange={(e) => gameStore.set({ settings: { ...gameStore.get().settings, sensitivity: Number(e.target.value) } })}
                className="mc-range h-10 border-2 border-black bg-[#8b8b8b]"
              />
            </label>
            <button className="mc-btn" onClick={returnFromSubscreen}>Voltar</button>
          </div>
        </section>
      )}
    </main>
  )
}
