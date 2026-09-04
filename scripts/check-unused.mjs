import { checkUnused } from '@immediately-run/verify-checks/unused';

await checkUnused({
  baselinePath: 'verify-baselines/unused.json',
});
