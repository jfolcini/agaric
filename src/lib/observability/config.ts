/**
 * Frontend observability enablement + sampling gate (#2110, M3b/M5).
 *
 * **Off by default**, mirroring the backend (`AGARIC_OTEL` unset ⇒ no
 * pipeline). When disabled, `initFrontendObservability` never registers a
 * tracer provider, so the global `@opentelemetry/api` tracer stays the built-in
 * **no-op** and every instrumentation call compiles to a cheap no-op with zero
 * IPC traffic and zero span allocation.
 *
 * Enablement sources (first match wins):
 *  1. An explicit `enabled` passed to `initFrontendObservability` (used by unit
 *     tests to force a known state).
 *  2. `window.__AGARIC_OTEL__ === true` — set by Playwright `addInitScript`
 *     before app scripts run, so e2e specs can exercise the real pipeline
 *     against the Tauri mock without a build flag.
 *  3. `import.meta.env.VITE_OTEL_FRONTEND === '1'` — a build-time opt-in.
 *
 * Sampling: a head-based ratio in `[0, 1]`. `1` (the M3b default when enabled)
 * samples every interaction; M5 lowers this at runtime via
 * [`setSamplingRatio`]. The decision is taken once per root interaction and
 * inherited by its children, so a trace is sampled whole or not at all.
 */

/** Window augmentation for the e2e/test enablement hook. */
declare global {
  interface Window {
    /** When `true`, forces the frontend tracer on (set by e2e init script). */
    __AGARIC_OTEL__?: boolean
  }
}

/** Resolve the build/runtime enablement signal (see module docs). */
export function resolveEnabled(): boolean {
  if (typeof window !== 'undefined' && window.__AGARIC_OTEL__ === true) {
    return true
  }
  try {
    if (import.meta.env?.['VITE_OTEL_FRONTEND'] === '1') {
      return true
    }
  } catch {
    // import.meta.env may be absent in some non-Vite contexts — treat as off.
  }
  return false
}

/**
 * Process-global head-sampling ratio in `[0, 1]`. Module-level rather than
 * bundled into the provider so the M5 runtime toggle can adjust it without
 * tearing the provider down. Defaults to `1` (sample all) — the actual *enabled*
 * gate is separate (see [`resolveEnabled`]); this only thins traces once on.
 */
let samplingRatio = 1

/** Clamp helper — keeps the ratio a sane probability. */
function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** Set the head-sampling ratio (M5 runtime toggle). Clamped to `[0, 1]`. */
export function setSamplingRatio(ratio: number): void {
  samplingRatio = clamp01(ratio)
}

/** Current head-sampling ratio. */
export function getSamplingRatio(): number {
  return samplingRatio
}

/**
 * Take a head-sampling decision for a new root interaction.
 *
 * `ratio >= 1` always samples (the common enabled default, avoiding a useless
 * RNG draw); `ratio <= 0` never samples; otherwise a uniform draw. Children
 * inherit the root decision, so this is only consulted for root spans.
 */
export function shouldSampleRoot(): boolean {
  if (samplingRatio >= 1) return true
  if (samplingRatio <= 0) return false
  return Math.random() < samplingRatio
}
