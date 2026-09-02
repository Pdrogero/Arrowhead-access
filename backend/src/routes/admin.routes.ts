// src/routes/admin.routes.ts
// TEMPORARY pre-launch-only route: lets the pre-launch cleanup be triggered
// from a plain browser URL on Render plans with no Shell access. Guarded by
// the same CRON_SECRET already set on Render (never checked into source).
//
// Delete this file (and its mount in server.ts) once the cleanup has been
// run and confirmed — it has no place in the app after go-live.

import { Router } from 'express';
import { runPreLaunchCleanup, lookupRepsByEmail, deleteRepById } from '../adminCleanup';

const router = Router();

function checkSecret(req: any, res: any): boolean {
  if (!process.env.CRON_SECRET || req.query.secret !== process.env.CRON_SECRET) {
    res.status(401).send('Unauthorized');
    return false;
  }
  return true;
}

router.get('/cleanup', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const confirm = req.query.confirm === '1';
  try {
    const output = await runPreLaunchCleanup(confirm);
    res.type('text/plain').send(output);
  } catch (err) {
    console.error(err);
    res.status(500).type('text/plain').send(`Cleanup failed:\n${err}`);
  }
});

router.get('/rep-lookup', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const email = String(req.query.email || '');
  if (!email) return res.status(400).type('text/plain').send('Missing ?email=');
  try {
    const output = await lookupRepsByEmail(email);
    res.type('text/plain').send(output);
  } catch (err) {
    console.error(err);
    res.status(500).type('text/plain').send(`Lookup failed:\n${err}`);
  }
});

router.get('/delete-rep', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const repId = String(req.query.repId || '');
  if (!repId) return res.status(400).type('text/plain').send('Missing ?repId=');
  const confirm = req.query.confirm === '1';
  try {
    const output = await deleteRepById(repId, confirm);
    res.type('text/plain').send(output);
  } catch (err) {
    console.error(err);
    res.status(500).type('text/plain').send(`Delete failed:\n${err}`);
  }
});

export default router;
