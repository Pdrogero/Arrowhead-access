// scripts/founding-status.ts
// Read-only check: how many founding-rep spots (of 30) are still available,
// and who currently holds one. Run from the backend/ directory:
//   npx ts-node scripts/founding-status.ts
//
// On Render, run this from the Dashboard → your backend service → Shell tab
// so it has the production DATABASE_URL.

import { foundingStatusReport } from '../src/adminCleanup';

foundingStatusReport()
  .then((output) => console.log(output))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
