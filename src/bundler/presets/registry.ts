import * as logger from '../../utils/logger';
import { Preset } from './Preset';
import { ReactPreset } from './react/ReactPreset';
// DEAD-CANDIDATE(2026-06): SolidPreset is inherited upstream (Sandpack) surface;
// its registration below is commented out and immediately.run is React-only, so it
// is unreachable on any live path (getPreset falls back to ReactPreset). Kept, not
// removed — see DEPRECATION_CANDIDATES.md.
import { SolidPreset } from './solid/SolidPreset';

const PRESET_MAP: Map<string, Preset> = new Map([
  ['create-react-app', new ReactPreset()],
  // DEAD-CANDIDATE(2026-06): Solid registration is commented out; immediately.run
  // ships React only. See DEPRECATION_CANDIDATES.md.
  // ['solid', new SolidPreset()],
]);

// R3-422: template names the host can legitimately send that are NOT presets of
// their own. The INIT `template` field carries the sandpack *environment*
// vocabulary (sandpack-client derives it from the app's package.json, and
// `loadSandpackClient` defaults to 'parcel' when none is set), so 'node',
// 'parcel', 'static', … arrive on perfectly healthy boots. immediately.run is
// React-only — every one of these maps onto the React preset by design — so
// mapping them must NOT warn: the old unconditional "Unknown preset node" line
// fired on every load of the local-dev flow and buried real errors. The loud
// warning is reserved for names outside the known vocabulary, which indicate an
// actual host/sandbox contract skew.
const KNOWN_REACT_ALIASES: ReadonlySet<string> = new Set([
  'angular-cli',
  'create-react-app-typescript',
  'node',
  'parcel',
  'solid',
  'static',
  'svelte',
  'vue-cli',
]);

export function getPreset(presetName: string): Preset {
  const foundPreset = PRESET_MAP.get(presetName);
  if (!foundPreset) {
    if (KNOWN_REACT_ALIASES.has(presetName)) {
      // Expected vocabulary, deliberate mapping — quiet (debug-level) log only.
      logger.debug(`Preset ${presetName} maps to React (immediately.run is React-only)`);
    } else {
      logger.warn(`Unknown preset ${presetName}, falling back to React`);
    }
    return new ReactPreset();
  }
  return foundPreset;
}
