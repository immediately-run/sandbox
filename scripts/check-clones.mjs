import { checkClones } from '@immediately-run/verify-checks/clones';

await checkClones({
  patterns: ['src/**/*.{ts,tsx}', 'scripts/**/*.mjs'],
  ignore: ['**/*.test.*', '**/*.spec.*'],
  baselinePath: 'verify-baselines/clones.json',
});
