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

// Approximates app.html's body.medical-bg (the tiled teal "+" cross
// pattern, plus two soft gold/navy gradient blooms over a mint-to-peach
// gradient, used on the role-selection/login screens). CSS background-image
// on a div is silently stripped by Gmail (confirmed in testing — the
// pattern just never appeared), so this uses the old bulletproof email
// technique instead: a real hosted tile image via the HTML `background`
// attribute on a <table>, which Gmail and most other clients do honor and
// tile automatically. The two radial gradient blooms are dropped — they
// don't tile, and baking them into the repeating image would just smear
// color bands across the table — so this is the cross pattern over a flat
// pale mint fill rather than the full gradient app.html has.
function pickAPlanPreviewWrap(innerHtml: string): string {
  const appUrl = process.env.APP_URL || 'https://arrowheadaccess.com';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EEF4EE" background="${appUrl}/email-assets/medical-bg-tile.png" style="background-repeat:repeat;">
    <tr><td style="padding:28px 16px;">
      <div style="max-width:420px;margin:0 auto;color:#14213D;">
        ${innerHtml}
      </div>
    </td></tr>
  </table>`;
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
