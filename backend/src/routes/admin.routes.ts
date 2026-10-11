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

// Hosted (not base64) on purpose — Gmail silently refuses to render inline
// data: URI images (confirmed in testing: the image just never appears, no
// "display images" prompt or anything), so the screenshots have to be real
// files at real URLs, same as icon-192.png already is for every other
// email this app sends. Most inboxes still block remote images until the
// recipient taps "display images below", but at least there's then
// something for them to reveal — a data URI in Gmail never shows at all.
function pickAPlanPreviewShotFrame(path: string, alt: string): string {
  const appUrl = process.env.APP_URL || 'https://arrowheadaccess.com';
  return `<div style="border:1px solid #DED6C0;border-radius:12px;overflow:hidden;margin:16px auto 6px;max-width:360px;background:#fff;">
    <div style="padding:9px 12px;background:#EFE6CF;border-bottom:1px solid #DED6C0;font-size:0;">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#DED6C0;margin-right:6px;"></span>
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#DED6C0;margin-right:6px;"></span>
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#DED6C0;"></span>
    </div>
    <img src="${appUrl}/${path}" alt="${alt}" width="360" style="display:block;width:100%;height:auto;">
  </div>`;
}

// Reproduces app.html's body.medical-bg exactly (the tiled teal "+"
// cross pattern plus two soft gold/navy gradient blooms over a mint-to-
// peach gradient, used on the role-selection/login screens) as an inline
// background on the email wrapper, since email HTML can't reference an
// external stylesheet class. background-attachment is dropped (meaningless
// without scroll, and a risk in stricter clients) but otherwise identical.
// Layered background-image support varies by email client — this may not
// render everywhere app.html does, but Gmail (confirmed working for the
// hosted screenshots above) should display it.
function pickAPlanPreviewWrap(innerHtml: string): string {
  const medicalBg = [
    `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Cg fill='none' stroke='%232D6F5E' stroke-width='3' stroke-linecap='round' opacity='0.22'%3E%3Cpath d='M32 18v28M18 32h28'/%3E%3C/g%3E%3C/svg%3E")`,
    `radial-gradient(circle at 12% 8%, rgba(201,162,39,0.16) 0%, transparent 45%)`,
    `radial-gradient(circle at 90% 85%, rgba(27,42,78,0.16) 0%, transparent 50%)`,
    `linear-gradient(180deg, #EAF7F1 0%, #FDF4F0 100%)`,
  ].join(', ');
  return `<div style="background-image:${medicalBg};background-repeat:repeat, no-repeat, no-repeat, no-repeat;background-size:64px 64px, cover, cover, cover;padding:28px 16px;">
    <div style="max-width:420px;margin:0 auto;color:#14213D;">
      ${innerHtml}
    </div>
  </div>`;
}

// One-off: sends a test copy of a screenshot-upgraded version of the
// no-plan reminder email (billing.routes.ts still sends the plain-text
// original to real reps) — lets us see how it actually renders in a real
// inbox before deciding whether to replace that one. Both screenshots are
// real captures of the live app, not staged artwork; see
// /email-assets/pick-a-plan-*.png in the frontend static site. Defaults to
// the admin's own inbox so a bare hit of the URL can't be used to spam an
// arbitrary address.
router.get('/send-pick-a-plan-preview', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.query.secret !== secret) return res.status(404).end();
  try {
    const to = typeof req.query.to === 'string' && req.query.to.trim() ? req.query.to.trim() : 'pdrogero@gmail.com';
    if (!SIMPLE_EMAIL_RE.test(to)) return res.status(400).type('text/html').send(adminResultPage('Invalid "to" address'));

    const html = pickAPlanPreviewWrap(`${emailLogoHeader()}
<p>Hi there,</p>
<p>You signed up for Arrowhead Access, but haven't started your 14-day free trial yet. Here's what's open at offices near you right now:</p>
${pickAPlanPreviewShotFrame('email-assets/pick-a-plan-slots.png', 'Open visit slots waiting to be claimed')}
<p style="text-align:center;font-size:11.5px;color:#5B6472;margin:6px 0 20px;">A live look at your Available Slots screen — these are real open times right now.</p>
<p>Claiming one (or messaging an office) needs a plan picked first. It only takes a minute, and you won't be charged until the trial ends.</p>
<p>And once an office accepts your request, here's what you get:</p>
${pickAPlanPreviewShotFrame('email-assets/pick-a-plan-confirmed.png', 'A confirmed lunch booking, with calendar sync, messaging, attendance tracking, and expense logging')}
<p style="text-align:center;font-size:11.5px;color:#5B6472;margin:6px 0 20px;">Calendar sync, direct messaging, attendance tracking, expense logging, and ratings — all in one place once you're confirmed.</p>
<div style="text-align:center;">${emailLoginButton('Choose your plan')}</div>
<p style="font-size:12.5px;color:#5B6472;margin-top:18px;border-top:1px solid #DED6C0;padding-top:16px;">TEST SEND — this is a preview of a possible upgrade to the no-plan reminder, not a live reminder about your own account.</p>`);

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
