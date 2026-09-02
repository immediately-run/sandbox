// Browser-Worker injection for `runLint` (CLIENT_SERVICES_SPEC §6). Mirrors
// `worker-lib-host.ts` (the typecheck lib seam): the SAME `runLint` core is fed a
// runtime-appropriate `Linter` + parser, so no Node-only build reaches the Worker.
//
//   - `Linter`  — `eslint-linter-browserify`, the webpack build of eslint's own
//     `Linter` class (identical `defineParser`/`verify` API), with no `createRequire`/
//     `url.pathToFileURL` calls, so it loads clean in a Worker.
//   - parser    — `@typescript-eslint/parser`. Its `typescript-estree` engine only
//     touches Node-only `globby`/`fs` on the PROJECT (type-aware) path, which this
//     service never takes (`parserOptions.project` is never set — CS-1 forbids
//     caller config); Parcel shims the unreached Node builtins. Verified loadable in
//     a real Worker by the plan-4.4 drill.

import * as tsParser from '@typescript-eslint/parser';
import { Linter } from 'eslint-linter-browserify';

import type { LintDeps } from './lint';

export const workerLintDeps: LintDeps = {
  createLinter: () => new Linter(),
  tsParser,
};
