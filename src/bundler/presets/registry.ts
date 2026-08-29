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

// R3-422: template names that are NOT presets of their own but are still
// legitimate, so mapping them onto React must stay quiet — the old unconditional
// "Unknown preset <name>" line fired on every load and buried real errors.
//
// What actually arrives (verified 2026-08-29, not assumed): site-main renders
// `<SandpackProvider>` with **no** `template` prop and never sets
// `sandboxSetup.template`, and `sandpack-client` resolves
// `sandboxSetup.template ?? "parcel"`. So on a healthy boot the value is always
// exactly `parcel`. An earlier revision of this comment claimed the client
// "derives it from the app's package.json" — it does not; the shipped client
// contains no `package.json` reference and no dependency-to-template mapping.
//
// The other three below are the sandpack *environment* vocabulary a caller that
// did set a template could legitimately send; they assert an execution
// environment, not a framework, so they stay quiet. **Framework names
// (`vue-cli`, `svelte`, `solid`, `angular-cli`) are deliberately NOT here:** on a
// React-only platform, one of those is a host/sandbox contract skew — a claim
// that a non-React template was sent — which is exactly what the loud warning is
// reserved for. Silencing them bought nothing (they were never part of the
// recurring noise, since only `parcel` ever arrives) and cost the only signal
// that the wrong template was sent.
const KNOWN_REACT_ALIASES: ReadonlySet<string> = new Set(['create-react-app-typescript', 'node', 'parcel', 'static']);

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
