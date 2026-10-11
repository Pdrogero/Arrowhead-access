// src/emailTemplates/pickAPlanReminder.ts
// Shared HTML for the "haven't picked a plan yet" reminder — used by both
// the real cron (billing.routes.ts's check-no-plan-reminders) and the
// admin test-send route (admin.routes.ts's send-pick-a-plan-preview), so
// the two never drift apart. Background/layout choices below were only
// arrived at by testing actual sends against Gmail — see the comments on
// each piece for what was tried and ruled out before landing here.
import { emailLogoHeader, emailLoginButton } from '../email';

// A rep's name (rep.name) is stored full ("Jane Doe"), but greeting
// someone by their whole name reads more like a form letter than an
// actual message.
export function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName;
}

// Hosted (not base64) on purpose — Gmail silently refuses to render inline
// data: URI images (confirmed in testing: the image just never appears, no
// "display images" prompt or anything), so the screenshots have to be real
// files at real URLs, same as icon-192.png already is for every other
// email this app sends. Most inboxes still block remote images until the
// recipient taps "display images below", but at least there's then
// something for them to reveal — a data URI in Gmail never shows at all.
function shotFrame(path: string, alt: string): string {
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

// Nods to app.html's body.medical-bg (the tiled teal "+" cross pattern
// behind the role-selection/login screens) without trying to reproduce a
// true behind-text background — confirmed in testing that Gmail honors
// neither CSS background-image on a div nor the HTML background attribute
// on a table; both silently vanish. The one thing proven to actually
// render in this inbox is a plain <img>, so the cross pattern appears as a
// flat decorative banner strip (medical-bg-banner.png) above and below the
// content instead of literally behind it, over a solid pale mint fill
// (plain background-color always renders, no image involved).
function wrapWithMedicalBg(innerHtml: string): string {
  const appUrl = process.env.APP_URL || 'https://arrowheadaccess.com';
  const banner = `<img src="${appUrl}/email-assets/medical-bg-banner.png" alt="" width="420" style="display:block;width:100%;max-width:420px;height:auto;margin:0 auto;">`;
  return `<div style="background-color:#EEF4EE;padding:0 0 28px;">
    ${banner}
    <div style="max-width:420px;margin:0 auto;color:#14213D;padding:12px 16px 0;">
      ${innerHtml}
    </div>
    ${banner}
  </div>`;
}

// The reminder's actual message. extraFooterHtml lets a caller (the admin
// preview route) tack on something — e.g. a "this is a test" disclaimer —
// while keeping it inside the cream wrapper, above the bottom banner,
// rather than appended after the whole thing renders back to plain white.
export function pickAPlanReminderHtml(firstName: string, extraFooterHtml = ''): string {
  return wrapWithMedicalBg(`${emailLogoHeader()}
<p>Hi ${firstName},</p>
<p>You signed up for Arrowhead Access, but haven't started your 14-day free trial yet. Here's what's open at offices near you right now:</p>
${shotFrame('email-assets/pick-a-plan-slots.png', 'Open visit slots waiting to be claimed')}
<p style="text-align:center;font-size:11.5px;color:#5B6472;margin:6px 0 20px;">A live look at your Available Slots screen — these are real open times right now.</p>
<p>Pick a plan: Monthly or Annual. It only takes a minute, and you won't be charged until the trial ends.</p>
<p>Once an office accepts your request, here's what you get:</p>
${shotFrame('email-assets/pick-a-plan-confirmed.png', 'A confirmed lunch booking, with calendar sync, messaging, attendance tracking, and expense logging')}
<p style="text-align:center;font-size:11.5px;color:#5B6472;margin:6px 0 20px;">Calendar sync, direct messaging, attendance tracking, expense logging, and ratings — all in one place once you're confirmed.</p>
<div style="text-align:center;">${emailLoginButton('Choose your plan')}</div>${extraFooterHtml}`);
}
