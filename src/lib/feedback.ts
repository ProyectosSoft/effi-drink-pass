/** Retroalimentación sensorial del scanner: sonido (WebAudio) y vibración. */
let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx ??= new Ctor()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

function tone(freq: number, start: number, duration: number, type: OscillatorType = 'sine') {
  const a = audio()
  if (!a) return
  const osc = a.createOscillator()
  const gain = a.createGain()
  osc.type = type
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, a.currentTime + start)
  gain.gain.exponentialRampToValueAtTime(0.25, a.currentTime + start + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + duration)
  osc.connect(gain).connect(a.destination)
  osc.start(a.currentTime + start)
  osc.stop(a.currentTime + start + duration + 0.02)
}

/** Debe llamarse desde un gesto del usuario (iOS) para habilitar el audio. */
export function unlockAudio() {
  audio()
}

export function feedbackSuccess() {
  tone(880, 0, 0.12)
  tone(1320, 0.12, 0.18)
  navigator.vibrate?.(80)
}

export function feedbackWarning() {
  tone(520, 0, 0.18, 'triangle')
  tone(520, 0.24, 0.18, 'triangle')
  navigator.vibrate?.([80, 60, 80])
}

export function feedbackError() {
  tone(220, 0, 0.35, 'square')
  navigator.vibrate?.([200, 80, 200])
}
