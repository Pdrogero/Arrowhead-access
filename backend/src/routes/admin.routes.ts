// src/routes/admin.routes.ts
// TEMPORARY pre-launch-only route: lets the pre-launch cleanup be triggered
// from a plain browser URL on Render plans with no Shell access. Guarded by
// the same CRON_SECRET already set on Render (never checked into source).
//
// Delete this file (and its mount in server.ts) once the cleanup has been
// run and confirmed — it has no place in the app after go-live.

import { Router } from 'express';
import { runPreLaunchCleanup } from '../adminCleanup';

const router = Router();

router.get('/cleanup', async (req, res) => {
  if (!process.env.CRON_SECRET || req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  const confirm = req.query.confirm === '1';
  try {
    const output = await runPreLaunchCleanup(confirm);
    res.type('text/plain').send(output);
  } catch (err) {
    console.error(err);
    res.status(500).type('text/plain').send(`Cleanup failed:\n${err}`);
  }
});

export default router;
