// src/routes/admin.routes.ts
// Lightweight HTTP-triggerable admin checks for when Render's Shell tab
// isn't available on the current plan. Protected by ADMIN_SECRET (set it in
// Render's env vars, then hit the route with ?secret=<value>) — a missing or
// wrong secret 404s rather than 401/403 so the route doesn't even reveal it
// exists. Returns counts only, never rep PII — a URL secret can leak via
// browser history or server logs, so keep anything identifying (the
// per-rep email list) restricted to the Shell-only script instead
// (scripts/founding-status.ts).
import { Router } from 'express';
import { foundingSpotsSummary } from '../adminCleanup';

const router = Router();

router.get('/founding-status', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.query.secret !== secret) return res.status(404).end();
  try {
    const { taken, limit, remaining } = await foundingSpotsSummary();
    res.type('text/plain').send(`${taken} of ${limit} founding-rep spots taken — ${remaining} remaining.`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error generating report');
  }
});

export default router;
