import * as logger from '../../utils/logger';
import evaluate from './eval';
import { HotContext } from './hot';
import { IMPORT_META_GLOBAL, importMetaFor } from './importMeta';
import { Module } from './Module';

class EvaluationContext {
  exports: any;
  globals: any;
  hot: HotContext;
  id: string;
  evaluation: Evaluation;

  constructor(evaluation: Evaluation) {
    this.exports = {};
    this.globals = {};
    this.hot = evaluation.module.hot;
    this.id = evaluation.module.id;
    this.evaluation = evaluation;
  }

  async dynamicImport(moduleToImport: string, symbolToImport = 'default'): Promise<any> {
    const evaluationContext = await this.getModuleEvaluationContext(moduleToImport);
    return symbolToImport == '*' ? evaluationContext.exports : evaluationContext.exports[symbolToImport];
  }

  async getModuleEvaluationContext(moduleName: string): Promise<EvaluationContext> {
    const resolvedModuleName = await this.resolve(moduleName);
    let moduleToEvaluate = this.evaluation.module.bundler.modules.get(resolvedModuleName);
    if (moduleToEvaluate && moduleToEvaluate.compiled != null) {
      return moduleToEvaluate.evaluation!.context;
    }
    await this.evaluation.module.addDependency(resolvedModuleName);
    moduleToEvaluate = await this.evaluation.module.bundler.transformModule(resolvedModuleName);
    // @ts-ignore
    const allDependencies = [...moduleToEvaluate.dependencyMap.values()];
    // wait for all deps to be compiled before evaluating the module to ensure correct execution
    await this.evaluation.module.bundler.transformationQueue.onIdle();
    const evaluatedDeps = await Promise.all(
      allDependencies
        .map((moduleName) => this.evaluation.module.bundler.modules.get(moduleName))
        .filter((mod) => mod && mod.compiled === null)
        .map((mod) =>
          this.evaluation.module.bundler.transformationQueue.getItem(mod!.filepath)?.then((mod) => mod.evaluate())
        )
    );
    return moduleToEvaluate.evaluate().context;
  }

  async resolve(moduleName: string): Promise<string> {
    return await this.evaluation.module.bundler.resolveAsync(moduleName, this.evaluation.module.filepath);
  }
}

export class Evaluation {
  module: Module;
  context: EvaluationContext;

  constructor(module: Module) {
    this.module = module;

    const code = module.compiled + `\n//# sourceURL=${location.origin}${this.module.filepath}`;

    this.context = new EvaluationContext(this);
    // The import.meta shim's runtime value (R3-328): the module's own URL — the same
    // expression the sourceURL stamp above uses — provided under the identifier the
    // transpiler rewrites `import.meta` to (see ./importMeta.ts for the contract).
    const importMeta = importMetaFor(`${location.origin}${this.module.filepath}`);
    this.context.exports = evaluate(
      code,
      this.require.bind(this),
      this.context,
      {},
      {
        [IMPORT_META_GLOBAL]: importMeta,
      }
    );
  }

  require(specifier: string): any {
    const moduleFilePath = this.module.dependencyMap.get(specifier);
    if (!moduleFilePath) {
      logger.debug('Require', {
        dependencies: this.module.dependencyMap,
        specifier,
      });

      throw new Error(`Dependency "${specifier}" not collected from "${this.module.filepath}"`);
    }
    const module = this.module.bundler.getModule(moduleFilePath);
    if (!module) {
      // Backstop: reaching require() with a module absent from the map means its
      // source never entered the transpile pipeline — almost always a FAILED SOURCE
      // FETCH (network error, or a GitHub REST rate limit returning 403). The old
      // wording ("has not been transpiled") sent debugging down a transpile/mount
      // rabbit hole; the load path now fails fast, but keep this honest as a backstop.
      throw new Error(
        `Module "${moduleFilePath}" is unavailable — its source was not loaded ` +
          `(commonly a failed fetch: a network error or a GitHub API rate limit), so it ` +
          `was never transpiled. Required by "${this.module.filepath}".`
      );
    }
    return module.evaluate().context.exports ?? {};
  }
}
