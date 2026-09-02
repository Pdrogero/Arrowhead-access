// src/routes/admin.routes.ts
// TEMPORARY admin-only route: lets one-off DB lookups/cleanups be triggered
// from a plain browser URL on Render plans with no Shell access. Guarded by
// the same CRON_SECRET already set on Render (never checked into source).
//
// Remove this file (and its mount in server.ts) once done — it has no
// place in the app during normal operation.

import { Router } from 'express';
import { runPreLaunchCleanup, lookupRepsByEmail, deleteRepById, lookupLocationsByName, deleteLocationById } from '../adminCleanup';

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

router.get('/location-lookup', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const q = String(req.query.q || '');
  if (!q) return res.status(400).type('text/plain').send('Missing ?q=');
  try {
    const output = await lookupLocationsByName(q);
    res.type('text/plain').send(output);
  } catch (err) {
    console.error(err);
    res.status(500).type('text/plain').send(`Lookup failed:\n${err}`);
  }
});

router.get('/delete-location', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const locationId = String(req.query.locationId || '');
  if (!locationId) return res.status(400).type('text/plain').send('Missing ?locationId=');
  const confirm = req.query.confirm === '1';
  try {
    const output = await deleteLocationById(locationId, confirm);
    res.type('text/plain').send(output);
  } catch (err) {
    console.error(err);
    res.status(500).type('text/plain').send(`Delete failed:\n${err}`);
  }
});

export default router;
