'use client'

import { ScanLine, X, Boxes, Weight, Move3D, Activity, CircuitBoard } from 'lucide-react'
import { gameStore, useGame } from '@/lib/game/store'

const fmt = (n: number, digits = 2) => n.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })

export function ScannerResults() {
  const report = useGame((s) => s.scannerReport)
  if (!report) return null

  return (
    <section className="absolute inset-0 z-40 flex items-center justify-center overflow-y-auto bg-[#020817]/80 p-3 backdrop-blur-sm sm:p-6">
      <div className="relative my-auto w-full max-w-2xl overflow-hidden border border-cyan-300/50 bg-[#071426]/95 text-cyan-50 shadow-[0_0_55px_#06b6d433]">
        <div className="pointer-events-none absolute inset-0 opacity-[0.09]" style={{ backgroundImage: 'linear-gradient(#55dfff 1px, transparent 1px), linear-gradient(90deg, #55dfff 1px, transparent 1px)', backgroundSize: '18px 18px' }} />
        <div className="relative border-b border-cyan-300/25 bg-cyan-300/10 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="relative flex size-12 shrink-0 items-center justify-center border border-cyan-200/60 bg-cyan-300/10">
                <ScanLine className="size-7 animate-pulse text-cyan-200" />
                <span className="absolute -right-1 -top-1 size-2 rounded-full bg-emerald-300 shadow-[0_0_10px_#6ee7b7]" />
              </div>
              <div>
                <p className="text-[10px] tracking-[0.28em] text-cyan-200/70">DWS • DEEP WEIGHT SCANNER</p>
                <h2 className="mt-1 text-lg font-semibold tracking-wide sm:text-2xl">Relatório físico do conjunto</h2>
                <p className="mt-1 text-xs text-cyan-100/60">Análise concluída • ${report.blockCount} blocos conectados</p>
              </div>
            </div>
            <button type="button" aria-label="Fechar scanner" onClick={() => gameStore.set({ screen: 'playing' })} className="border border-cyan-100/30 p-2 text-cyan-100/70 hover:bg-cyan-100/10 hover:text-white"><X className="size-5" /></button>
          </div>
          <div className="mt-4 h-1 overflow-hidden bg-cyan-950"><div className="h-full w-full origin-left animate-pulse bg-gradient-to-r from-cyan-500 via-white to-cyan-400" /></div>
        </div>
        <div className="relative grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
          <div className="border border-white/10 bg-white/[0.03] p-3">
            <p className="flex items-center gap-2 text-xs uppercase tracking-widest text-cyan-100/65"><Weight className="size-4" /> Massa total</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">{fmt(report.massKg)} <span className="text-sm font-normal text-cyan-100/60">kg</span></p>
            <p className="mt-1 text-[11px] text-cyan-100/45">Massa calculada pelos materiais e estados atuais</p>
          </div>
          <div className="border border-white/10 bg-white/[0.03] p-3">
            <p className="flex items-center gap-2 text-xs uppercase tracking-widest text-cyan-100/65"><Boxes className="size-4" /> Envelope externo</p>
            <p className="mt-2 text-xl font-semibold tabular-nums">{report.dimensions.x} × {report.dimensions.y} × {report.dimensions.z} <span className="text-xs font-normal text-cyan-100/60">blocos</span></p>
            <p className="mt-1 text-[11px] text-cyan-100/45">Volume envolvente: {report.dimensions.x * report.dimensions.y * report.dimensions.z} unidades³</p>
          </div>
          <div className="border border-white/10 bg-white/[0.03] p-3">
            <p className="flex items-center gap-2 text-xs uppercase tracking-widest text-cyan-100/65"><Move3D className="size-4" /> Centro de massa</p>
            <p className="mt-2 text-sm font-medium tabular-nums">X {fmt(report.centerOfMass.x)} · Y {fmt(report.centerOfMass.y)} · Z {fmt(report.centerOfMass.z)}</p>
            <p className="mt-1 text-[11px] text-cyan-100/45">Coordenadas no mundo</p>
          </div>
          <div className="border border-white/10 bg-white/[0.03] p-3">
            <p className="flex items-center gap-2 text-xs uppercase tracking-widest text-cyan-100/65"><Activity className="size-4" /> Inércia estimada</p>
            <p className="mt-2 text-sm font-medium tabular-nums">Ix {fmt(report.inertia.x)} · Iy {fmt(report.inertia.y)} · Iz {fmt(report.inertia.z)}</p>
            <p className="mt-1 text-[11px] text-cyan-100/45">kg·m² • aproximação por voxels cúbicos</p>
          </div>
          <div className="border border-white/10 bg-white/[0.03] p-3">
            <p className="flex items-center gap-2 text-xs uppercase tracking-widest text-cyan-100/65"><CircuitBoard className="size-4" /> Propriedades agregadas</p>
            <div className="mt-3 space-y-2 text-xs">
              <div className="flex justify-between gap-3"><span className="text-cyan-100/60">Atrito médio</span><strong>{fmt(report.averageFriction, 3)}</strong></div>
              <div className="flex justify-between gap-3"><span className="text-cyan-100/60">Condutividade média</span><strong>{fmt(report.averageConductivity * 100, 1)}%</strong></div>
              <div className="flex justify-between gap-3"><span className="text-cyan-100/60">Conexões por cola</span><strong>{report.gluedConnections}</strong></div>
            </div>
          </div>
          <div className="border border-white/10 bg-white/[0.03] p-3">
            <p className="text-xs uppercase tracking-widest text-cyan-100/65">Composição material</p>
            <div className="mt-3 max-h-40 space-y-2 overflow-y-auto">
              {report.composition.map((part) => (
                <div key={part.name}>
                  <div className="flex justify-between gap-3 text-xs"><span>{part.name} <span className="text-cyan-100/45">×{part.count}</span></span><span className="tabular-nums">{fmt(part.massKg)} kg</span></div>
                  <div className="mt-1 h-1 bg-white/10"><div className="h-full bg-cyan-300" style={{ width: `${Math.max(3, part.massKg / report.massKg * 100)}%` }} /></div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="relative flex flex-wrap items-center justify-between gap-3 border-t border-cyan-300/20 px-4 py-3 text-[10px] text-cyan-100/50 sm:px-5">
          <span>RESULTADO DWS • VALORES SIMULADOS, NÃO MEDIÇÃO LABORATORIAL</span>
          <button type="button" onClick={() => gameStore.set({ screen: 'playing' })} className="border border-cyan-200/50 bg-cyan-300/10 px-4 py-2 text-xs font-semibold text-cyan-50 hover:bg-cyan-300/20">Concluir análise</button>
        </div>
      </div>
    </section>
  )
}
