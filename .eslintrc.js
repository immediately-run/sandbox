module.exports = {
  env: {
    browser: true,
    es2021: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  rules: {
    // Block stray `console.log` debug cruft, but permit intentional
    // `console.warn`/`console.error` — used for always-surface diagnostics and
    // `[security]` events (e.g. SDK-integrity failures) that must reach the
    // console regardless of the configured logLevel.
    'no-console': ['error', { allow: ['warn', 'error'] }],
  },
};
