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
import { foundingSpotsSummary, backfillAutoDeclinedNoResponse, noPlanReminderSummary, platformFeedbackReport } from '../adminCleanup';
import { sendEmail } from '../email';
import { firstNameOf, pickAPlanReminderHtml } from '../emailTemplates/pickAPlanReminder';

const router = Router();

const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Plain text responses render fine in a desktop browser, but some mobile
// browsers (seen with DuckDuckGo's iOS app) treat a text/plain response
// with no file extension as a download instead of displaying it, and that
// download view doesn't reliably render the content either — so this
// result line is useless for debugging from a phone. Wrapping it as a tiny
// HTML page instead makes every browser just display it.
function adminResultPage(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:-apple-system,sans-serif;padding:24px;font-size:16px;">${message.replace(/</g, '&lt;')}</body></html>`;
}

// One-off: sends a test copy of pickAPlanReminderHtml (the same shared
// template check-no-plan-reminders now sends to real reps) so the actual
// live version can be previewed anytime without waiting for the cron or
// creating a throwaway rep account. Defaults to the admin's own inbox so a
// bare hit of the URL can't be used to spam an arbitrary address.
router.get('/send-pick-a-plan-preview', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.query.secret !== secret) return res.status(404).end();
  try {
    const to = typeof req.query.to === 'string' && req.query.to.trim() ? req.query.to.trim() : 'pdrogero@gmail.com';
    if (!SIMPLE_EMAIL_RE.test(to)) return res.status(400).type('text/html').send(adminResultPage('Invalid "to" address'));
    const name = typeof req.query.name === 'string' && req.query.name.trim() ? req.query.name.trim() : 'Hailey Morgan';
    const firstName = firstNameOf(name);

    const html = pickAPlanReminderHtml(
      firstName,
      `<p style="font-size:12.5px;color:#5B6472;margin-top:18px;border-top:1px solid #DED6C0;padding-top:16px;">TEST SEND — this is a preview of the live no-plan reminder, not a real reminder about your own account.</p>`
    );

    const sent = await sendEmail({ to, subject: '[TEST] Your free trial is waiting on Arrowhead Access', html });
    if (!sent) return res.status(502).type('text/html').send(adminResultPage('sendEmail() returned false — check RESEND_API_KEY and server logs.'));
    res.type('text/html').send(adminResultPage(`Sent to ${to}.`));
  } catch (err) {
    console.error(err);
    res.status(500).type('text/html').send(adminResultPage(`Error sending preview email: ${err instanceof Error ? err.message : String(err)}`));
  }
});

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

router.get('/no-plan-reminder-status', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.query.secret !== secret) return res.status(404).end();
  try {
    const { everSent, pendingNextRun } = await noPlanReminderSummary();
    res.type('text/html').send(adminResultPage(`${everSent} rep(s) have ever been sent the no-plan reminder. ${pendingNextRun} rep(s) currently qualify and haven't been sent yet — they'll get it on the next scheduled run (every 3 hours).`));
  } catch (err) {
    console.error(err);
    res.status(500).type('text/html').send(adminResultPage('Error generating report'));
  }
});

router.get('/feedback', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.query.secret !== secret) return res.status(404).end();
  try {
    const report = await platformFeedbackReport();
    const escaped = report.replace(/</g, '&lt;');
    res.type('text/html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:-apple-system,sans-serif;padding:24px;font-size:16px;"><pre style="white-space:pre-wrap;font-family:inherit;margin:0;">${escaped}</pre></body></html>`);
  } catch (err) {
    console.error(err);
    res.status(500).type('text/html').send(adminResultPage('Error generating report'));
  }
});

// One-time backfill for bookings auto-declined (3-day no-response timeout)
// before the autoDeclinedNoResponse flag existed — see adminCleanup.ts for
// how it tells those apart from an explicit office decline. Safe to run
// more than once; already-flagged rows are excluded on each pass.
router.get('/backfill-auto-declined', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.query.secret !== secret) return res.status(404).end();
  try {
    res.type('text/plain').send(await backfillAutoDeclinedNoResponse());
  } catch (err) {
    console.error(err);
    res.status(500).send('Error running backfill');
  }
});

export default router;
