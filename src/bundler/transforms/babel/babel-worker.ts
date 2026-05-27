import type { PluginItem } from '@babel/core';
import * as babel from '@babel/standalone';

import * as logger from '../../../utils/logger';
import { WorkerMessageBus } from '../../../utils/WorkerMessageBus';
import { ITranspilationResult } from '../Transformer';
import { loadPlugin, loadPreset } from './babel-plugin-registry';
import { collectDependencies } from './dep-collector';

export interface ITransformData {
  code: string;
  filepath: string;
  config: any;
}

function getNameFromConfigEntry(entry: any): string | null {
  if (typeof entry === 'string') {
    return entry;
  } else if (Array.isArray(entry) && typeof entry[0] === 'string') {
    return entry[0];
  } else {
    return null;
  }
}

// TODO: Normalize preset names
async function getPresets(presets: any): Promise<PluginItem[]> {
  const result: PluginItem[] = [
    [
      'env',
      {
        targets: '> 2.5%, not ie 11, not dead, not op_mini all',
        useBuiltIns: 'usage',
        corejs: '3.22',
        exclude: ['@babel/plugin-transform-regenerator'],
      },
    ],
    'typescript',
  ];
  if (!Array.isArray(presets)) {
    return result;
  }
  for (const preset of presets) {
    const presetName = getNameFromConfigEntry(preset);
    if (presetName !== null) {
      if (!babel.availablePresets[presetName]) {
        babel.availablePresets[presetName] = await loadPreset(presetName);
      }

      const foundIndex = result.findIndex((v) => getNameFromConfigEntry(v) === presetName);
      if (foundIndex > -1) {
        result[foundIndex] = preset;
        continue;
      }
    }
    result.push(preset);
  }
  return result;
}

// TODO: Normalize plugin names
async function getPlugins(plugins: any): Promise<PluginItem[]> {
  const result: PluginItem[] = [];
  if (!Array.isArray(plugins)) {
    return result;
  }
  for (const plugin of plugins) {
    const pluginName = getNameFromConfigEntry(plugin);
    if (pluginName !== null) {
      if (!babel.availablePlugins[pluginName]) {
        babel.availablePlugins[pluginName] = await loadPlugin(pluginName);
      }

      const foundIndex = result.findIndex((v) => getNameFromConfigEntry(v) === pluginName);
      if (foundIndex > -1) {
        result[foundIndex] = plugin;
        continue;
      }
    }
    result.push(plugin);
  }
  return result;
}

async function transform({ code, filepath, config }: ITransformData): Promise<ITranspilationResult> {
  const requires: Set<string> = new Set();
  const presets = await getPresets(config?.presets ?? []);
  const plugins = await getPlugins(config?.plugins ?? []);
  plugins.push(collectDependencies(requires));
  const transformed = babel.transform(code, {
    filename: filepath,
    presets,
    plugins,
    // no ast needed for now
    ast: false,
    sourceMaps: 'inline',
    compact: /node_modules/.test(filepath),
  });

  // no-op module
  if (!transformed.code) {
    transformed.code = 'module.exports = {};';
  }

  return {
    code: transformed.code,
    dependencies: requires,
  };
}

function bindMessageBus(endpoint: MessagePort | Worker | typeof self) {
  // eslint-disable-next-line no-new
  new WorkerMessageBus({
    channel: 'sandpack-babel',
    endpoint,
    handleNotification: () => Promise.resolve(),
    handleRequest: (method, data) => {
      switch (method) {
        case 'transform':
          return transform(data);
        default:
          return Promise.reject(new Error('Unknown method'));
      }
    },
    handleError: (err) => {
      logger.error(err);
      return Promise.resolve();
    },
    timeoutMs: 30000,
  });
}

// This worker is created by the *parent* page (not the sandboxed iframe) so the
// iframe can drop `allow-same-origin`. The parent hands us a `MessagePort` that
// is entangled with one transferred into the iframe, so transform requests flow
// directly between the iframe and this worker without the parent relaying them.
// Wait for that one-time `{ type: 'connect' }` handshake, then talk over the
// port instead of `self`.
self.addEventListener('message', function onConnect(evt: MessageEvent) {
  if (evt.data && evt.data.type === 'connect') {
    const port = evt.ports && evt.ports[0];
    if (port) {
      self.removeEventListener('message', onConnect);
      port.start();
      bindMessageBus(port);
    }
  }
});
