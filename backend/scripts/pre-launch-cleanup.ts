// scripts/pre-launch-cleanup.ts
// One-off pre-launch cleanup: removes the demo office (Meridian Family
// Practice) and everything hanging off it, and resets isFoundingRep back to
// false on every existing rep account so testing/dev signups don't eat into
// the real 30-spot founding-rep pool.
//
// SAFE BY DEFAULT: running this with no flags only PRINTS what it would do.
// Nothing is deleted or changed until you re-run it with --confirm.
//
// Run from the backend/ directory:
//   npx ts-node scripts/pre-launch-cleanup.ts            (dry run — read only)
//   npx ts-node scripts/pre-launch-cleanup.ts --confirm  (actually applies it)
//
// Already run once for the original launch cleanup (see git history for
// src/routes/admin.routes.ts, the temporary HTTP-triggerable version used
// on a Render plan with no Shell access) — kept here in case more
// demo/test data needs clearing out later.

import { runPreLaunchCleanup } from '../src/adminCleanup';

const CONFIRM = process.argv.includes('--confirm');

runPreLaunchCleanup(CONFIRM)
  .then((output) => console.log(output))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
