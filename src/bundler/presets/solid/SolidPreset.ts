import { Bundler } from '../../bundler';
import { DepMap } from '../../module-registry';
import { Module } from '../../module/Module';
import { BabelTransformer } from '../../transforms/babel';
import { CSSTransformer } from '../../transforms/css';
import { StyleTransformer } from '../../transforms/style';
import { Preset } from '../Preset';

// DEAD-CANDIDATE(2026-06): entire SolidJS preset is inherited Sandpack/CodeSandbox
// surface immediately.run never adopted (React-only). Not registered in
// presets/registry.ts (commented out), so unreachable on any live path. Drags in
// the `babel-preset-solid` + `solid-refresh` deps. Kept, not removed — see
// DEPRECATION_CANDIDATES.md.
export class SolidPreset extends Preset {
  defaultHtmlBody = '<div id="app"></div>';

  constructor() {
    super('solid');
  }

  async init(bundler: Bundler): Promise<void> {
    await super.init(bundler);

    await Promise.all([
      this.registerTransformer(new BabelTransformer()),
      this.registerTransformer(new CSSTransformer()),
      this.registerTransformer(new StyleTransformer()),
    ]);
  }

  mapTransformers(module: Module): Array<[string, any]> {
    if (/^(?!\/node_modules\/).*\.(((m|c)?jsx?)|tsx)$/.test(module.filepath)) {
      return [
        [
          'babel-transformer',
          {
            presets: ['solid'],
            plugins: ['solid-refresh/babel'],
          },
        ],
      ];
    }

    if (/\.(m|c)?(t|j)sx?$/.test(module.filepath) && !module.filepath.endsWith('.d.ts')) {
      return [['babel-transformer', {}]];
    }

    if (/\.css$/.test(module.filepath)) {
      return [
        ['css-transformer', {}],
        ['style-transformer', {}],
      ];
    }

    throw new Error(`No transformer for ${module.filepath}`);
  }

  augmentDependencies(dependencies: DepMap): DepMap {
    if (!dependencies['solid-refresh']) {
      dependencies['solid-refresh'] = '^0.4.0';
    }
    dependencies['core-js'] = '3.22.7';
    return dependencies;
  }
}
