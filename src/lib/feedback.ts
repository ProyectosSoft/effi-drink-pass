/** Retroalimentación sensorial del scanner: sonido (WebAudio) y vibración. */
/** Contexto de audio único y perezoso (los navegadores limitan cuántos se pueden crear). */
let ctx: AudioContext | null = null

/** Obtiene (o crea) el AudioContext; devuelve null si el navegador no soporta WebAudio. */
function audio(): AudioContext | null {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx ??= new Ctor()
    // Las políticas de autoplay crean el contexto suspendido hasta que hay interacción del usuario.
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/**
 * Programa un tono breve.
 * @param freq frecuencia en Hz
 * @param start retardo en segundos respecto a "ahora" (permite encadenar tonos)
 * @param duration duración en segundos
 */
function tone(freq: number, start: number, duration: number, type: OscillatorType = 'sine') {
  const a = audio()
  if (!a) return
  const osc = a.createOscillator()
  const gain = a.createGain()
  osc.type = type
  osc.frequency.value = freq
  // Envolvente exponencial (ataque 10 ms + caída) para evitar "clics"; no admite 0, por eso 0.0001.
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

/** Canje aprobado: dos tonos ascendentes y vibración corta. */
export function feedbackSuccess() {
  tone(880, 0, 0.12)
  tone(1320, 0.12, 0.18)
  navigator.vibrate?.(80)
}

/** Advertencia (p. ej. beneficio ya consumido): doble pitido medio. */
export function feedbackWarning() {
  tone(520, 0, 0.18, 'triangle')
  tone(520, 0.24, 0.18, 'triangle')
  navigator.vibrate?.([80, 60, 80])
}

/** Rechazo o error: tono grave y vibración larga, distinguible sin mirar la pantalla. */
export function feedbackError() {
  tone(220, 0, 0.35, 'square')
  navigator.vibrate?.([200, 80, 200])
}
