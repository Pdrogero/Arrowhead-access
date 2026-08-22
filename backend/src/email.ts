// Thin wrapper around Resend's HTTP API. No SDK dependency needed —
// Node 18+ has global fetch built in.

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
