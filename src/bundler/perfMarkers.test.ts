// R3-46 — the bundler-side ir.* perf-marker emitter (LOAD_PROFILING_SPEC §3.2).
import { emitPerfMarker, PerfMarkerBus } from './perfMarkers';

describe('emitPerfMarker', () => {
  const makeBus = () => {
    const sent: Array<{ type: string; data?: Record<string, any> }> = [];
    const bus: PerfMarkerBus = { sendMessage: (type, data) => sent.push({ type, data }) };
    return { sent, bus };
  };

  it('forwards an ir-marker with the name + a numeric timestamp', () => {
    const { sent, bus } = makeBus();
    emitPerfMarker(bus, 'ir.transpile', { moduleCount: 7 });
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('ir-marker');
    expect(sent[0].data?.name).toBe('ir.transpile');
    expect(typeof sent[0].data?.at).toBe('number');
    expect(sent[0].data?.attrs).toEqual({ moduleCount: 7 });
  });

  it('omits attrs entirely when none are given (a bare mark)', () => {
    const { sent, bus } = makeBus();
    emitPerfMarker(bus, 'ir.eval');
    expect(sent[0].data).not.toHaveProperty('attrs');
    expect(sent[0].data?.name).toBe('ir.eval');
  });

  it('swallows a transport error so a missing mark never breaks a compile', () => {
    const bus: PerfMarkerBus = {
      sendMessage: () => {
        throw new Error('parent not connected');
      },
    };
    expect(() => emitPerfMarker(bus, 'ir.deps', { depCount: 3 })).not.toThrow();
  });
});
