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
import { foundingSpotsSummary, backfillAutoDeclinedNoResponse } from '../adminCleanup';
import { sendEmail, emailLogoHeader, emailLoginButton } from '../email';
import { SLOTS_SCREENSHOT_B64, CONFIRMED_SCREENSHOT_B64 } from '../previewAssets/pickAPlanScreenshots';

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

function pickAPlanPreviewShotFrame(b64: string, alt: string): string {
  return `<div style="border:1px solid #E2E1D8;border-radius:12px;overflow:hidden;margin:16px 0 6px;">
    <div style="padding:9px 12px;background:#F5F5F0;border-bottom:1px solid #E2E1D8;font-size:0;">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#D8D7CC;margin-right:6px;"></span>
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#D8D7CC;margin-right:6px;"></span>
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#D8D7CC;"></span>
    </div>
    <img src="data:image/png;base64,${b64}" alt="${alt}" width="560" style="display:block;width:100%;height:auto;">
  </div>`;
}

// One-off: sends a test copy of a screenshot-upgraded version of the
// no-plan reminder email (billing.routes.ts still sends the plain-text
// original to real reps) — lets us see how it actually renders in a real
// inbox before deciding whether to replace that one. Both screenshots are
// real captures of the live app, not staged artwork; see
// previewAssets/pickAPlanScreenshots.ts. Defaults to the admin's own inbox
// so a bare hit of the URL can't be used to spam an arbitrary address.
router.get('/send-pick-a-plan-preview', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.query.secret !== secret) return res.status(404).end();
  try {
    const to = typeof req.query.to === 'string' && req.query.to.trim() ? req.query.to.trim() : 'pdrogero@gmail.com';
    if (!SIMPLE_EMAIL_RE.test(to)) return res.status(400).type('text/html').send(adminResultPage('Invalid "to" address'));

    const html = `${emailLogoHeader()}
<p>Hi there,</p>
<p>You signed up for Arrowhead Access, but haven't started your 14-day free trial yet. Here's what's open at offices near you right now:</p>
${pickAPlanPreviewShotFrame(SLOTS_SCREENSHOT_B64, 'Open visit slots waiting to be claimed')}
<p style="text-align:center;font-size:11.5px;color:#5B6760;margin:6px 0 20px;">A live look at your Available Slots screen — these are real open times right now.</p>
<p>Claiming one (or messaging an office) needs a plan picked first. It only takes a minute, and you won't be charged until the trial ends.</p>
<p>And once an office accepts your request, here's what you get:</p>
${pickAPlanPreviewShotFrame(CONFIRMED_SCREENSHOT_B64, 'A confirmed lunch booking, with calendar sync, messaging, attendance tracking, and expense logging')}
<p style="text-align:center;font-size:11.5px;color:#5B6760;margin:6px 0 20px;">Calendar sync, direct messaging, attendance tracking, expense logging, and ratings — all in one place once you're confirmed.</p>
${emailLoginButton('Choose your plan')}
<p style="font-size:12.5px;color:#5B6760;margin-top:18px;border-top:1px solid #E2E1D8;padding-top:16px;">TEST SEND — this is a preview of a possible upgrade to the no-plan reminder, not a live reminder about your own account.</p>`;

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
