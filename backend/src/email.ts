// Thin wrapper around Resend's HTTP API. No SDK dependency needed —
// Node 18+ has global fetch built in.

// A small branded header block for emails that want the Arrowhead Access
// mark up top — uses the actual hosted app-icon PNG rather than trying to
// recreate the CSS logo mark, since rotated/pseudo-element shapes don't
// render reliably across email clients (Outlook especially). The whole
// mark links back to the app, so it doubles as a "take me to the site"
// click target on every email that includes it.
export function emailLogoHeader(): string {
  const appUrl = process.env.APP_URL || 'https://arrowheadaccess.com';
  return `<div style="text-align:center;padding:8px 0 20px;">
    <a href="${appUrl}/app.html" style="text-decoration:none;">
      <img src="${appUrl}/icon-192.png" width="44" height="44" alt="Arrowhead Access" style="border-radius:10px;display:inline-block;vertical-align:middle;">
      <span style="font-size:19px;font-weight:700;color:#16241F;vertical-align:middle;margin-left:10px;">Arrowhead Access</span>
    </a>
  </div>`;
}

// A styled "Log in" button/link, for any email that should offer a direct
// path back into the app beyond just the logo header above.
export function emailLoginButton(label = 'Log in to Arrowhead Access'): string {
  const appUrl = process.env.APP_URL || 'https://arrowheadaccess.com';
  return `<p><a href="${appUrl}/app.html" style="display:inline-block;background:#2E6F5E;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;">${label}</a></p>`;
}

export async function sendEmail({ to, subject, html }: { to: string; subject: string; html: string }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY not set — skipping email send to', to);
    return;
  }

  const from = process.env.RESEND_FROM_EMAIL || 'Arrowhead Access <onboarding@resend.dev>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('Failed to send email:', res.status, body);
  }
}
