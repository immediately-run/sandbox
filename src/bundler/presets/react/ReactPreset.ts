import {
  augmentDependencies as augmentReactDependencies,
  PLAIN_BABEL_CONFIG,
  REACT_REFRESH_BABEL_CONFIG,
} from '@immediately-run/transpiler';
import { Bundler } from '../../bundler';
import { DepMap } from '../../module-registry';
import { Module } from '../../module/Module';
import { AssetTransformer, ASSET_EXTENSIONS } from '../../transforms/asset';
import { BabelTransformer } from '../../transforms/babel';
import { MDXTransformer } from '../../transforms/mdx';
import { CSSTransformer } from '../../transforms/css';
import { ReactRefreshTransformer } from '../../transforms/react-refresh';
import { StyleTransformer } from '../../transforms/style';
import { Preset } from '../Preset';

const ASSET_REGEX = new RegExp(`\\.(${ASSET_EXTENSIONS.join('|')})$`, 'i');


export class ReactPreset extends Preset {
  defaultHtmlBody = '<div id="root"></div>';

  constructor() {
    super('react');
  }



  async init(bundler: Bundler): Promise<void> {
    await super.init(bundler);

    await Promise.all([
      this.registerTransformer(new BabelTransformer()),
      this.registerTransformer(new ReactRefreshTransformer()),
      this.registerTransformer(new CSSTransformer()),
      this.registerTransformer(new StyleTransformer()),
      this.registerTransformer(new MDXTransformer()),
      this.registerTransformer(new AssetTransformer()),
    ]);
  }

  mapTransformers(module: Module): Array<[string, any]> {
    if (/^(?!\/node_modules\/).*\.(((m|c)?jsx?)|tsx|mdx?)$/i.test(module.filepath)) {
      const transfomers: Array<[string, any]> = [
        ['babel-transformer', REACT_REFRESH_BABEL_CONFIG],
        ['react-refresh-transformer', {}],
      ];
      if (/.*\.(mdx?)$/i.test(module.filepath)) {
        transfomers.unshift(['mdx-transformer', {}])
      }
      return transfomers;
    }

    if (/\.(m|c)?(t|j)sx?$/.test(module.filepath) && !module.filepath.endsWith('.d.ts')) {
      return [['babel-transformer', PLAIN_BABEL_CONFIG]];
    }

    if (/\.css$/.test(module.filepath)) {
      return [
        ['css-transformer', {}],
        ['style-transformer', {}],
      ];
    }

    if (ASSET_REGEX.test(module.filepath)) {
      return [['asset-transformer', {}]];
    }

    throw new Error(`No transformer for ${module.filepath}`);
  }

  augmentDependencies(dependencies: DepMap): DepMap {
    return augmentReactDependencies(dependencies);
  }
}
