// Emit an `ir.*` load-profiling marker from the bundler to the host (R3-46,
// LOAD_PROFILING_SPEC §3/§3.2). The bundler owns the compile-phase marks —
// `ir.deps` (node-module resolution), `ir.transpile` (the babel transform pass),
// `ir.eval` (module evaluation) — forwarded over the same parent message bus the
// bundler already uses for `state`.
//
// The host re-validates EVERY forwarded marker against its mirrored LP-5 allowlist
// (site-main `perf/irMarkers`) and drops anything off-vocabulary, so this side only
// has to send the right name + in-schema attrs at the right instant; it deliberately
// does not duplicate the vocabulary table. The timestamp is the sandbox-relative
// `performance.now()` at emission (§3.2). A clock/transport that isn't available is
// swallowed — a missing perf mark must never break a compile.

export interface PerfMarkerBus {
  sendMessage(type: string, data?: Record<string, any>): void;
}

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

export function emitPerfMarker(
  bus: PerfMarkerBus,
  name: string,
  attrs?: Record<string, unknown>
): void {
  try {
    bus.sendMessage('ir-marker', { name, at: now(), ...(attrs !== undefined ? { attrs } : {}) });
  } catch {
    /* transport/clock unavailable — skip the mark, never break the compile */
  }
}
