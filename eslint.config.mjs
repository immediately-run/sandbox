// eslint.config.mjs — R3-1081: sandbox on ESLint 9 flat config, replacing
// .eslintrc.js (ESLint 8 / typescript-eslint v5). The carried-over rule set is
// exactly the old one — no-console (warn/error allowed: always-surface
// diagnostics and [security] events must reach the console regardless of
// logLevel) — plus the shared type-aware block from verify-checks (R17's
// mechanical half; no rule name spelled here).
//
// `npm run lint` is `eslint --max-warnings 0`; the scope lives here (every
// .ts/.tsx, matching the old `'**/*.ts?(x)'`), with the type-aware block
// scoped to the tsconfig include (src/).

import ts from 'typescript-eslint';
import { typeAwareRules } from '@immediately-run/verify-checks/eslint-type-aware';

export default [
  {
    name: 'global-ignores',
    // GENERATED files are the generator's output, not authored code (the
    // R3-1083 paramValidators principle); their eslint-disable directives
    // serve other consumers' configs, so linting them here only misfires
    // ESLint 9's unused-directive report.
    ignores: ['dist/', 'dist-dev/', 'fixture/', 'node_modules/', '.parcel-cache/', '.parcel-cache-dev/', 'public/', '**/*.generated.ts'],
  },
  {
    name: 'sandbox/base (carry-over of .eslintrc.js)',
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: ts.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': ts.plugin },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    name: 'type-aware (R3-1081)',
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: { ...typeAwareRules },
  },
];
