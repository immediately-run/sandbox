// Node/jest injection for `runLint` — the on-disk `eslint` `Linter` and
// `@typescript-eslint/parser`. Kept in its OWN module (not `lint.ts`) so the Worker
// bundle never statically imports the Node builds of either (both crash a browser
// Worker on load — see the `lint.ts` header). Jest imports this; the Worker imports
// `worker-lint-host.ts` instead.

// Namespace import: @typescript-eslint/parser is CJS with `__esModule` and no
// default export, so a default import resolves to `undefined` under some interops
// (jest/babel). The namespace reliably carries `parseForESLint`.
import * as tsParser from '@typescript-eslint/parser';
import { Linter } from 'eslint';

import type { LintDeps } from './lint';

export const nodeLintDeps: LintDeps = {
  createLinter: () => new Linter(),
  tsParser,
};
