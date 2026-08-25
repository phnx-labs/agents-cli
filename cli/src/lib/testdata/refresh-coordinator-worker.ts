import * as fs from 'node:fs';

import { setRefreshLockRootForTest, withRefreshLease } from '../refresh-coordinator.js';

const [lockRoot, resultPath, countPath, key] = process.argv.slice(2);
setRefreshLockRootForTest(lockRoot);

await withRefreshLease<number>({
  scope: 'cross-process-test',
  key,
  readCompleted: () => {
    try { return Number(fs.readFileSync(resultPath, 'utf-8')); }
    catch { return null; }
  },
  isCompleted: (value) => value === 1,
  refresh: async () => {
    fs.appendFileSync(countPath, 'refresh\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(resultPath, '1');
    return 1;
  },
});
