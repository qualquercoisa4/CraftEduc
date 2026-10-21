let ctx: AudioContext | null = null
let noise: AudioBuffer | null = null

function getCtx() {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate)
    const d = noise.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

export function unlockAudio() {
  getCtx()
}

function noiseBurst(freq: number, dur: number, gain: number, type: BiquadFilterType = 'lowpass') {
  const c = getCtx()
  if (!c || !noise) return
  const src = c.createBufferSource()
  src.buffer = noise
  src.playbackRate.value = 0.8 + Math.random() * 0.4
  const f = c.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  const g = c.createGain()
  const t = c.currentTime
  g.gain.setValueAtTime(gain, t)
  g.gain.exponentialRampToValueAtTime(0.001, t + dur)
  src.connect(f).connect(g).connect(c.destination)
  src.start(t)
  src.stop(t + dur)
}

function tone(freq: number, dur: number, gain: number, type: OscillatorType = 'square', slideTo?: number) {
  const c = getCtx()
  if (!c) return
  const o = c.createOscillator()
  o.type = type
  const t = c.currentTime
  o.frequency.setValueAtTime(freq, t)
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur)
  const g = c.createGain()
  g.gain.setValueAtTime(gain, t)
  g.gain.exponentialRampToValueAtTime(0.001, t + dur)
  o.connect(g).connect(c.destination)
  o.start(t)
  o.stop(t + dur)
}

export const sfx = {
  break: (metal: boolean) => {
    noiseBurst(metal ? 2600 : 900, 0.18, 0.35)
    if (metal) tone(880 + Math.random() * 200, 0.12, 0.04, 'triangle', 500)
  },
  place: (metal: boolean) => {
    noiseBurst(metal ? 1800 : 700, 0.09, 0.3)
    if (metal) tone(640, 0.06, 0.03, 'triangle')
  },
  click: () => tone(1200, 0.04, 0.06, 'square', 900),
  zap: () => tone(1400, 0.12, 0.05, 'sawtooth', 300),
  glue: () => noiseBurst(500, 0.25, 0.2, 'bandpass'),
  battery: (insert: boolean) => tone(insert ? 520 : 380, 0.08, 0.07, 'square', insert ? 780 : 260),
  rotate: () => tone(300, 0.07, 0.06, 'square', 420),
}
