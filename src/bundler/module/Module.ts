import { BundlerError } from '../../errors/BundlerError';
import { Bundler } from '../bundler';
import { CircularImportError, detectCycle } from './circularImport';
import { Evaluation } from './Evaluation';
import { HotContext } from './hot';

export interface IDependencyEvent {
  specifier: string;
}

export class Module {
  id: string;
  filepath: string;
  isEntry = false;
  source: string;
  compiled: string | null;
  bundler: Bundler;
  evaluation: Evaluation | null = null;
  hot: HotContext;

  compilationError: BundlerError | null = null;

  dependencies: Set<string>;
  // Keeping this seperate from dependencies as there might be duplicates otherwise
  dependencyMap: Map<string, string>;

  constructor(filepath: string, source: string, isCompiled: boolean = false, bundler: Bundler) {
    this.id = filepath;
    this.filepath = filepath;
    this.source = source;
    this.compiled = isCompiled ? source : null;
    this.dependencies = new Set();
    this.dependencyMap = new Map();
    this.bundler = bundler;
    this.hot = new HotContext(this);
  }

  get initiators() {
    return this.bundler.getInitiators(this.id);
  }

  isHot(): boolean {
    return Boolean(this.hot.hmrConfig?.isHot());
  }

  /** Add dependency */
  async addDependency(depSpecifier: string): Promise<void> {
    const resolved = await this.bundler.resolveAsync(depSpecifier, this.filepath);
    this.dependencies.add(resolved);
    this.dependencyMap.set(depSpecifier, resolved);
    this.bundler.addInitiator(resolved, this.id);
  }

  async compile(): Promise<void> {
    if (this.compiled != null || this.compilationError != null) {
      return;
    }
    try {
      const preset = this.bundler.preset;
      if (!preset) {
        throw new Error('Preset has not been initialized');
      }

      const transformers = preset.getTransformers(this);
      if (!transformers.length) {
        throw new Error(`No transformers found for ${this.filepath}`);
      }

      let code = this.source;
      for (const [transformer, config] of transformers) {
        const transformationResult = await transformer.transform(
          {
            module: this,
            code,
          },
          config
        );

        if (transformationResult instanceof BundlerError) {
          this.compilationError = transformationResult;
          break;
        } else {
          code = transformationResult.code;
          await Promise.all(
            Array.from(transformationResult.dependencies).map((d) => {
              return this.addDependency(d);
            })
          );
        }
      }

      this.compiled = code;
    } catch (err: any) {
      this.compilationError = err;
    }
  }

  resetCompilation(): void {
    // We always reset compilation errors as this will be non-null while compilation is null
    this.compilationError = null;

    // Skip modules that don't have any compilation
    if (this.compiled == null) return;

    this.compiled = null;
    this.evaluation = null;

    // §5.3 reset-delete: drop any `/transpiled/<path>.js` for this module so an
    // invalidated module can never resurrect stale output. The async unlink is
    // tracked by the store; a queued re-transform's consult awaits it.
    this.bundler.artifactStore.invalidate(this.filepath);

    if (this.hot.hmrConfig && this.hot.hmrConfig.isHot()) {
      this.hot.hmrConfig.setDirty(true);
    } else {
      // for (let initiator of this.initiators) {
      //   const module = this.bundler.getModule(initiator);
      //   module?.resetCompilation();
      // }

      // // If this is an entry we want all direct entries to be reset as well.
      // // Entries generally have side effects
      // if (this.isEntry) {
      //   for (let dependency of this.dependencies) {
      //     const module = this.bundler.getModule(dependency);
      //     module?.resetCompilation();
      //   }
      // }

      location.reload();
    }

    this.bundler.transformModule(this.filepath);
  }

  evaluate(): Evaluation {
    if (this.evaluation) {
      return this.evaluation;
    }

    // Detect an import cycle BEFORE re-entering evaluation. `new Evaluation`
    // runs this module's code synchronously, which require()s its deps; if one
    // of them require()s back into a module already mid-evaluation (this one),
    // `evaluation` is not yet set and we would recurse forever. Throw a cycle
    // error naming the exact loop instead of overflowing the stack.
    const cycle = detectCycle(this.bundler.evaluationStack, this.filepath);
    if (cycle) {
      // `cycle` starts at this module (the re-entered one); the formatter adds
      // the closing edge back to it.
      throw new CircularImportError(cycle);
    }

    if (this.hot.hmrConfig) {
      // this.bundler.setHmrStatus('dispose');
      // Call module.hot.dispose handler
      // https://webpack.js.org/api/hot-module-replacement/#dispose-or-adddisposehandler-
      this.hot.hmrConfig.callDisposeHandler();
      // this.bundler.setHmrStatus('apply');
    }

    // Reset hmr context while keeping the previous hot data
    this.hot = this.hot.clone();
    this.bundler.evaluationStack.push(this.filepath);
    try {
      this.evaluation = new Evaluation(this);
    } finally {
      this.bundler.evaluationStack.pop();
    }

    // this.bundler.setHmrStatus('apply');
    if (this.hot.hmrConfig && this.hot.hmrConfig.isHot()) {
      this.hot.hmrConfig.setDirty(false);
      this.hot.hmrConfig.callAcceptCallback();
    }
    // this.bundler.setHmrStatus('idle');

    return this.evaluation;
  }
}
