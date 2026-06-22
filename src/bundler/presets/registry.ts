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

export function getPreset(presetName: string): Preset {
  const foundPreset = PRESET_MAP.get(presetName);
  if (!foundPreset) {
    logger.warn(`Unknown preset ${presetName}, falling back to React`);
    return new ReactPreset();
  }
  return foundPreset;
}
