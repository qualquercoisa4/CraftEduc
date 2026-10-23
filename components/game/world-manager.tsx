'use client'

import { useEffect, useState } from 'react'
import {
  deleteSavedWorld,
  getSavedWorlds,
  requestLoadWorld,
  requestNewWorld,
  type SavedWorldRecord,
} from '@/lib/game/world-saves'
import { WORLD_TYPE_OPTIONS, type WorldType } from '@/lib/game/world-generation'

interface WorldManagerProps {
  mode: 'create' | 'load'
  onClose: () => void
}

function formatDate(timestamp: number) {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(timestamp))
  } catch {
    return 'Data desconhecida'
  }
}

export function WorldManager({ mode, onClose }: WorldManagerProps) {
  const [worldName, setWorldName] = useState('Meu mundo')
  const [worldType, setWorldType] = useState<WorldType>('flat')
  const [saves, setSaves] = useState<SavedWorldRecord[]>([])

  useEffect(() => {
    setSaves(getSavedWorlds())
  }, [mode])

  const refreshSaves = () => setSaves(getSavedWorlds())

  return (
    <section className="absolute inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/75 p-3 backdrop-blur-sm sm:p-6">
      <div className="mc-panel my-auto max-h-[94dvh] w-full max-w-2xl overflow-y-auto p-4 text-[#303030] sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-lg sm:text-xl">
              {mode === 'create' ? 'CRIAR MUNDO' : 'MUNDOS SALVOS'}
            </h2>
            <p className="mt-2 text-sm text-[#565656]">
              {mode === 'create'
                ? 'Escolha um cenário para construir e testar seus robôs.'
                : 'Abra uma construção anterior ou exclua um mundo que não usa mais.'}
            </p>
          </div>
          <button className="mc-btn !min-w-0 px-3" type="button" onClick={onClose} aria-label="Fechar">
            ×
          </button>
        </div>

        {mode === 'create' ? (
          <div className="mt-5 space-y-4">
            <label className="block text-sm font-semibold">
              Nome do mundo
              <input
                value={worldName}
                onChange={(event) => setWorldName(event.target.value.slice(0, 48))}
                maxLength={48}
                className="mt-2 w-full border-2 border-black bg-white px-3 py-3 font-sans text-base font-normal text-[#222] outline-none focus:border-[#1769aa]"
                placeholder="Ex.: Robô seguidor de linha"
              />
            </label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {WORLD_TYPE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={worldType === option.id}
                  onClick={() => setWorldType(option.id)}
                  className={`border-2 p-3 text-left transition-colors ${worldType === option.id
                    ? 'border-[#1769aa] bg-[#e4f2ff]'
                    : 'border-[#777] bg-white hover:bg-[#eeeeee]'}`}
                >
                  <span className="block font-bold">{option.name}</span>
                  <span className="mt-1 block text-xs leading-5 text-[#555]">{option.description}</span>
                </button>
              ))}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" className="mc-btn" onClick={onClose}>Cancelar</button>
              <button
                type="button"
                className="mc-btn"
                onClick={() => requestNewWorld(worldType, worldName)}
              >
                Criar e jogar
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {saves.length === 0 ? (
              <div className="border-2 border-dashed border-[#888] bg-white/60 p-6 text-center text-sm text-[#555]">
                Nenhum mundo salvo ainda. Crie um mundo e use “Salvar mundo” no menu de pausa.
              </div>
            ) : (
              saves.map((save) => {
                const worldType = WORLD_TYPE_OPTIONS.find((option) => option.id === save.type)
                return (
                  <article key={save.id} className="border-2 border-[#777] bg-white p-3 sm:p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <h3 className="break-words font-bold">{save.name}</h3>
                        <p className="mt-1 text-xs text-[#666]">
                          {worldType?.name ?? 'Mundo'} · Salvo em {formatDate(save.updatedAt)}
                        </p>
                        <p className="mt-1 text-xs text-[#666]">
                          {save.data.blocks.length.toLocaleString('pt-BR')} alterações de bloco · {save.data.wires.length} fios
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button type="button" className="mc-btn !min-w-0 px-4" onClick={() => requestLoadWorld(save.id)}>
                          Abrir
                        </button>
                        <button
                          type="button"
                          className="mc-btn !min-w-0 px-3"
                          onClick={() => {
                            if (window.confirm(`Excluir o mundo “${save.name}”? Esta ação não pode ser desfeita.`)) {
                              deleteSavedWorld(save.id)
                              refreshSaves()
                            }
                          }}
                        >
                          Excluir
                        </button>
                      </div>
                    </div>
                  </article>
                )
              })
            )}
            <button type="button" className="mc-btn mt-2" onClick={onClose}>Voltar</button>
          </div>
        )}
        <p className="mt-4 text-center text-[11px] leading-4 text-[#777]">
          Os mundos são guardados neste navegador e neste dispositivo.
        </p>
      </div>
    </section>
  )
}
